// services/staffAdvanceService.js
//
// Staff salary advances (Staff only; worker payroll is not touched).
//
// Flow (Admin only, no approval step)
//   1. Financial report   POST /financial-report  -> a snapshot the Admin must open first
//   2. Create             the voucher number (ADV-YYYY-NNNNNN) is taken in the same
//                         transaction; the Admin chooses the deduction month(s):
//                         Full = one month, Partial = several months (sum = amount).
//                         A month that already has a PAID staff batch is refused.
//   3. Payroll            the staff batch whose end_date falls in the chosen month
//                         carries the installment:
//                           net = calculated + adjustments - advance_deduction_amount
//                         Net never goes below 0; what cannot be deducted becomes
//                         Unscheduled (the Admin picks a new month).
//                         Void / supersede of that batch puts everything back.
//                         Mark Paid -> Deducted + ledger entry.
//   4. Cancel             within advance_cancel_window_hours (72h) of creation. It
//                         restores everything as it was: an installment already in a
//                         Generated (not finalized) batch is reversed in that batch
//                         (net and batch total back to their exact previous values).
//                         The advance row, its voucher number and its history stay.
//   5. After the window   close by cash repayment (RCP-YYYY-NNNNNN) or write-off.
//
// Constraints: voucher numbers are unique and never reused; a staff member with an
// open balance cannot be set Inactive / Terminated or deleted; Paid batches never
// change; the ledger is append-only; every action is audited.

const db = require('../config/db');
const settingsCache = require('./settingsCache');
const { businessToday } = require('./businessDate');

const PAYMENT_METHODS = ['Cash', 'BankTransfer', 'Cheque'];
const MAX_SCHEDULE_ROWS = 24;
const MAX_MONTHS_AHEAD = 24;

class AdvError extends Error {
  constructor(message, statusCode = 400, code = undefined, extra = {}) {
    super(message);
    this.isOperational = true;
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
const cents = (v) => Math.round(Number(v || 0) * 100);

function positiveId(value, label = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new AdvError(`Invalid ${label}.`);
  return n;
}

function requireReason(value, min = 5) {
  const text = String(value ?? '').trim();
  if (text.length < min) throw new AdvError(`A reason (at least ${min} characters) is required.`, 400, 'REASON_REQUIRED');
  return text;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

async function settingNumber(key, fallback) {
  const v = Number(await settingsCache.getSetting(key, String(fallback)));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
async function settingBool(key, fallback) {
  const v = String(await settingsCache.getSetting(key, String(fallback))).toLowerCase();
  return v === 'true' || v === '1';
}
async function staffCurrency() {
  return String(await settingsCache.getSetting('staff_payroll_currency', 'USD') || 'USD').toUpperCase();
}

async function audit(executor, tableName, recordId, action, userId, oldValues, newValues) {
  await executor.execute(
    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tableName, recordId, action, userId || null,
      oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null]);
}

// ---------------------------------------------------------------------------
// Unique document numbers: ADV-2026-000001, RCP-2026-000001.
// The sequence row is locked by the UPDATE until the caller's transaction ends,
// so two transactions can never get the same number. A number taken by a
// transaction that rolls back is simply skipped (never handed out twice).
// ---------------------------------------------------------------------------
function sequenceKey(prefix) {
  return `${prefix}-${businessToday().slice(0, 4)}`;
}

// Creates the series row (autocommit). Call BEFORE opening the transaction that
// takes a number, so that the transaction only needs a plain row lock.
async function ensureDocumentSequence(prefix) {
  await db.execute('INSERT IGNORE INTO document_sequences (seq_key, last_number) VALUES (?, 0)', [sequenceKey(prefix)]);
}

// Takes the next number inside the caller's transaction. The UPDATE holds an
// exclusive lock on the series row until commit / rollback, so two transactions
// can never get the same number. (INSERT ... ON DUPLICATE KEY UPDATE is not used:
// its gap locks deadlock when two vouchers are created at the same moment.)
async function nextDocumentNumber(executor, prefix) {
  const key = sequenceKey(prefix);
  const [upd] = await executor.execute('UPDATE document_sequences SET last_number = last_number + 1 WHERE seq_key = ?', [key]);
  if (!upd.affectedRows) throw new Error(`Document sequence ${key} is missing (ensureDocumentSequence was not called).`);
  const [[row]] = await executor.execute('SELECT last_number FROM document_sequences WHERE seq_key = ?', [key]);
  return `${key}-${String(row.last_number).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Months: a month is "closed" when a PAID staff batch ends in it. An installment
// is carried by the batch whose end_date falls in its month.
// ---------------------------------------------------------------------------
async function monthStates(executor, months) {
  const list = [...new Set(months)].filter((m) => MONTH_RE.test(m));
  const out = new Map(list.map((m) => [m, { month: m, label: monthLabel(m), paid: false, selectable: true, batches: [], warning: null }]));
  if (!list.length) return out;
  const [rows] = await executor.query(
    `SELECT staff_payroll_batch_id AS batch_id, DATE_FORMAT(end_date, '%Y-%m') AS month, status, is_finalized,
            DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
     FROM staff_payroll_batches
     WHERE status IN ('Generated','Paid') AND DATE_FORMAT(end_date, '%Y-%m') IN (?)
     ORDER BY staff_payroll_batch_id`, [list]);
  for (const r of rows) {
    const s = out.get(r.month);
    s.batches.push({ batch_id: r.batch_id, status: r.status, is_finalized: Boolean(Number(r.is_finalized)),
      start_date: r.start_date, end_date: r.end_date });
  }
  for (const s of out.values()) {
    const paid = s.batches.find((b) => b.status === 'Paid');
    const open = s.batches.find((b) => b.status === 'Generated');
    if (paid) {
      s.paid = true;
      s.selectable = false;
      s.warning = `Staff batch #${paid.batch_id} for ${s.label} is already Paid. Choose another month.`;
    } else if (open && open.is_finalized) {
      s.warning = `Staff batch #${open.batch_id} for ${s.label} is finalized. Use "Correct (supersede)" on it to include this deduction.`;
      s.action = { type: 'supersede', batch_id: open.batch_id };
    } else if (open) {
      s.warning = `Staff batch #${open.batch_id} for ${s.label} is generated but not finalized. Void it and generate it again to include this deduction.`;
      s.action = { type: 'void_and_regenerate', batch_id: open.batch_id };
    }
  }
  return out;
}

async function availableMonths(executor = db, count = 12) {
  const first = businessToday().slice(0, 7);
  const months = Array.from({ length: count }, (_, i) => addMonths(first, i));
  const states = await monthStates(executor, months);
  return months.map((m) => states.get(m));
}

// schedule: [{ month: 'YYYY-MM', amount }]. Returns the sorted rows + warnings.
async function validateSchedule(executor, schedule, total) {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw new AdvError('Choose at least one deduction month.', 400, 'SCHEDULE_REQUIRED');
  }
  if (schedule.length > MAX_SCHEDULE_ROWS) throw new AdvError(`At most ${MAX_SCHEDULE_ROWS} deduction months.`, 400, 'SCHEDULE_TOO_LONG');
  const minMonth = businessToday().slice(0, 7);
  const maxMonth = addMonths(minMonth, MAX_MONTHS_AHEAD);
  const seen = new Set();
  const rows = schedule.map((r) => {
    const month = String(r?.month || '').trim();
    const amount = money(r?.amount);
    if (!MONTH_RE.test(month)) throw new AdvError(`Invalid month "${month}". Use YYYY-MM.`, 400, 'INVALID_MONTH');
    if (month < minMonth) throw new AdvError(`${monthLabel(month)} is before the current month. Choose ${monthLabel(minMonth)} or later.`, 400, 'MONTH_IN_PAST');
    if (month > maxMonth) throw new AdvError(`${monthLabel(month)} is too far ahead (at most ${MAX_MONTHS_AHEAD} months).`, 400, 'MONTH_TOO_FAR');
    if (seen.has(month)) throw new AdvError(`${monthLabel(month)} is chosen twice. Each month can be used once.`, 400, 'DUPLICATE_MONTH');
    seen.add(month);
    if (!(amount > 0)) throw new AdvError(`The amount for ${monthLabel(month)} must be greater than 0.`, 400, 'INVALID_AMOUNT');
    return { month, amount };
  }).sort((a, b) => a.month.localeCompare(b.month));
  const sum = rows.reduce((s, r) => s + cents(r.amount), 0);
  if (sum !== cents(total)) {
    throw new AdvError(`The deduction amounts add up to ${money(sum / 100).toFixed(2)}, but they must equal ${money(total).toFixed(2)}.`,
      400, 'SCHEDULE_TOTAL_MISMATCH');
  }
  const states = await monthStates(executor, rows.map((r) => r.month));
  const paid = rows.filter((r) => states.get(r.month).paid);
  if (paid.length) {
    throw new AdvError(states.get(paid[0].month).warning, 409, 'MONTH_PAID', { months: paid.map((r) => r.month) });
  }
  const warnings = rows.map((r) => states.get(r.month)).filter((s) => s.warning)
    .map((s) => ({ month: s.month, message: s.warning, action: s.action || null }));
  return { rows, warnings };
}

// ---------------------------------------------------------------------------
// Financial report (must be opened before creating an advance)
// ---------------------------------------------------------------------------
async function buildFinancialReport(rawStaffId, userId) {
  const staffId = positiveId(rawStaffId, 'staff id');
  const { calculateStaff } = require('./staffPayrollPreviewService');
  const { countNonFridayDays } = require('./staffAttendanceService');

  const [[staff]] = await db.execute(
    `SELECT sm.*, s.site_name,
            DATE_FORMAT(sm.hire_date, '%Y-%m-%d') AS hire_date_str,
            DATE_FORMAT(sm.first_hire_date, '%Y-%m-%d') AS first_hire_date_str
     FROM staff_members sm LEFT JOIN sites s ON s.site_id = sm.site_id
     WHERE sm.staff_id = ?`, [staffId]);
  if (!staff) throw new AdvError('Staff member not found.', 404, 'NOT_FOUND');

  const currency = await staffCurrency();
  const today = businessToday();
  const month = today.slice(0, 7);
  const { start: monthStart, end: monthEnd } = monthBounds(month);

  // Expected salary for the current month to date (same formula as payroll,
  // Submitted + Approved days counted, days after today not counted).
  let currentMonth = { month, label: monthLabel(month), from: monthStart, to: today, available: false, note: null };
  try {
    const r = await calculateStaff(staff, monthStart, today < monthEnd ? today : monthEnd,
      countNonFridayDays(monthStart, monthEnd), db, { statuses: ['Submitted', 'Approved'] });
    if (r && r.calc && !r.unresolved) {
      currentMonth = { ...currentMonth, available: true, ...r.calc };
    } else if (r && r.unresolved) {
      currentMonth.note = 'The historical salary for some dates of this month cannot be reconstructed; expected salary not shown.';
    } else {
      currentMonth.note = r && r.skipped === 'not_employed'
        ? 'Not employed during this month.'
        : 'No counted attendance yet this month.';
    }
  } catch (error) {
    currentMonth.note = 'Expected salary could not be calculated.';
  }

  const [[pending]] = await db.execute(
    `SELECT SUM(status = 'Draft') AS draft, SUM(status = 'Submitted') AS submitted, SUM(status = 'Rejected') AS rejected
     FROM staff_attendance WHERE staff_id = ? AND record_date BETWEEN ? AND ?`, [staffId, monthStart, monthEnd]);

  const [payrollHistory] = await db.execute(
    `SELECT b.staff_payroll_batch_id AS batch_id, DATE_FORMAT(b.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(b.end_date, '%Y-%m-%d') AS end_date, b.status, b.is_finalized,
            sp.prorated_base_salary, sp.salary_deduction_amount, sp.adjustments_amount,
            sp.advance_deduction_amount, sp.net_salary
     FROM staff_payroll sp
     JOIN staff_payroll_batches b ON b.staff_payroll_batch_id = sp.staff_payroll_batch_id
     WHERE sp.staff_id = ? AND b.status IN ('Generated','Paid')
     ORDER BY b.end_date DESC, b.staff_payroll_batch_id DESC
     LIMIT 6`, [staffId]);

  const [adjustments] = await db.execute(
    `SELECT adjustment_id, amount, currency, reason, status, included_batch_id
     FROM payroll_adjustments
     WHERE person_type = 'Staff' AND person_id = ? AND status IN ('AwaitingConfirmation','Pending','Included')
     ORDER BY adjustment_id`, [staffId]);

  const advances = await listAdvances({ staffId });
  const open = advances.filter((a) => a.status === 'Active');
  const openBalance = money(open.reduce((s, a) => s + Number(a.outstanding_balance), 0));

  const snapshot = {
    generated_for_date: today,
    currency,
    staff: {
      staff_id: staff.staff_id, staff_unique_id: staff.staff_unique_id, full_name: staff.full_name,
      position: staff.position, site_name: staff.site_name, status: staff.status,
      hire_date: staff.hire_date_str, first_hire_date: staff.first_hire_date_str,
      monthly_salary: Number(staff.monthly_salary || 0), standard_daily_hours: Number(staff.standard_daily_hours || 0),
    },
    current_month: currentMonth,
    attendance_pending: {
      draft: Number(pending?.draft || 0), submitted: Number(pending?.submitted || 0), rejected: Number(pending?.rejected || 0),
    },
    payroll_history: payrollHistory.map((p) => ({
      ...p, is_finalized: Boolean(Number(p.is_finalized)),
      prorated_base_salary: Number(p.prorated_base_salary || 0), salary_deduction_amount: Number(p.salary_deduction_amount || 0),
      adjustments_amount: Number(p.adjustments_amount || 0), advance_deduction_amount: Number(p.advance_deduction_amount || 0),
      net_salary: Number(p.net_salary || 0),
    })),
    pending_adjustments: {
      total: money(adjustments.reduce((s, a) => s + Number(a.amount), 0)),
      items: adjustments.map((a) => ({ ...a, amount: Number(a.amount) })),
    },
    open_advances: { count: open.length, balance: openBalance, items: open },
    advance_history: advances,
    months: await availableMonths(db, 12),
    can_create: staff.status === 'Active' && (open.length === 0 || await settingBool('advance_allow_multiple_open', false)),
    blockers: [
      ...(staff.status !== 'Active' ? [`The staff member is ${staff.status}. Advances are only for Active staff.`] : []),
      ...(open.length && !(await settingBool('advance_allow_multiple_open', false))
        ? [`The staff member already has an open advance (${open.map((a) => a.voucher_no).join(', ')}). Close it first.`] : []),
    ],
  };

  const [ins] = await db.execute(
    `INSERT INTO staff_financial_reports (staff_id, generated_by_user_id, generated_at, snapshot)
     VALUES (?, ?, NOW(), ?)`, [staffId, userId, JSON.stringify(snapshot)]);
  const validMinutes = await settingNumber('advance_report_valid_minutes', 30);
  const [[meta]] = await db.execute(
    `SELECT DATE_FORMAT(generated_at, '%Y-%m-%d %H:%i:%s') AS generated_at,
            DATE_FORMAT(DATE_ADD(generated_at, INTERVAL ? MINUTE), '%Y-%m-%d %H:%i:%s') AS valid_until
     FROM staff_financial_reports WHERE report_id = ?`, [validMinutes, ins.insertId]);
  await audit(db, 'staff_financial_reports', ins.insertId, 'FINANCIAL_REPORT_OPENED', userId, null, { staff_id: staffId });
  return { report_id: ins.insertId, generated_at: meta.generated_at, valid_until: meta.valid_until, ...snapshot };
}

async function getFinancialReport(rawReportId) {
  const id = positiveId(rawReportId, 'report id');
  const [[r]] = await db.execute(
    `SELECT r.report_id, r.staff_id, r.snapshot, DATE_FORMAT(r.generated_at, '%Y-%m-%d %H:%i:%s') AS generated_at,
            u.full_name AS generated_by
     FROM staff_financial_reports r JOIN users u ON u.user_id = r.generated_by_user_id
     WHERE r.report_id = ?`, [id]);
  if (!r) throw new AdvError('Financial report not found.', 404, 'NOT_FOUND');
  const snapshot = typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot;
  return { report_id: r.report_id, generated_at: r.generated_at, generated_by: r.generated_by, ...snapshot };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
const ADVANCE_SELECT = `
  SELECT a.advance_id, a.voucher_no, a.staff_id, sm.staff_unique_id, sm.full_name, sm.position, sm.status AS staff_status,
         a.currency, a.amount, a.deduction_mode, a.reason, a.payment_method, a.payment_reference,
         a.financial_report_id, a.status, a.outstanding_balance,
         DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at,
         DATE_FORMAT(a.cancel_deadline, '%Y-%m-%d %H:%i') AS cancel_deadline,
         (a.status = 'Active' AND NOW() <= a.cancel_deadline) AS can_cancel_window,
         GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), a.cancel_deadline)) AS cancel_seconds_left,
         cu.full_name AS created_by,
         DATE_FORMAT(a.cancelled_at, '%Y-%m-%d %H:%i') AS cancelled_at, xu.full_name AS cancelled_by, a.cancel_reason,
         DATE_FORMAT(a.written_off_at, '%Y-%m-%d %H:%i') AS written_off_at, a.write_off_reason,
         DATE_FORMAT(a.settled_at, '%Y-%m-%d %H:%i') AS settled_at,
         a.voucher_print_count, (a.receipt_file IS NOT NULL) AS has_signed_receipt,
         DATE_FORMAT(a.receipt_uploaded_at, '%Y-%m-%d %H:%i') AS receipt_uploaded_at
  FROM staff_advances a
  JOIN staff_members sm ON sm.staff_id = a.staff_id
  JOIN users cu ON cu.user_id = a.created_by_user_id
  LEFT JOIN users xu ON xu.user_id = a.cancelled_by_user_id`;

function normalizeAdvance(a) {
  return {
    ...a,
    amount: Number(a.amount),
    outstanding_balance: Number(a.outstanding_balance),
    can_cancel_window: Boolean(Number(a.can_cancel_window)),
    cancel_seconds_left: Number(a.cancel_seconds_left || 0),
    has_signed_receipt: Boolean(Number(a.has_signed_receipt)),
  };
}

async function listAdvances({ status, staffId, month, q } = {}) {
  const where = [];
  const params = [];
  if (['Active', 'Settled', 'Cancelled', 'WrittenOff'].includes(status)) { where.push('a.status = ?'); params.push(status); }
  if (staffId) { where.push('a.staff_id = ?'); params.push(Number(staffId)); }
  if (month && MONTH_RE.test(month)) {
    where.push(`EXISTS (SELECT 1 FROM staff_advance_installments i WHERE i.advance_id = a.advance_id
                AND i.deduction_month = ? AND i.status IN ('Scheduled','Included','Deducted'))`);
    params.push(month);
  }
  if (q && String(q).trim()) {
    where.push('(sm.full_name LIKE ? OR sm.staff_unique_id LIKE ? OR a.voucher_no LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  const [rows] = await db.execute(
    `${ADVANCE_SELECT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY FIELD(a.status, 'Active', 'Settled', 'WrittenOff', 'Cancelled'), a.advance_id DESC
     LIMIT 1000`, params);
  if (!rows.length) return [];
  const [inst] = await db.query(
    `SELECT installment_id, advance_id, seq, deduction_month, amount, status, included_batch_id
     FROM staff_advance_installments WHERE advance_id IN (?) AND status NOT IN ('Replaced')
     ORDER BY advance_id, COALESCE(deduction_month, '9999-99'), seq`, [rows.map((r) => r.advance_id)]);
  const byAdv = new Map();
  for (const i of inst) {
    if (!byAdv.has(i.advance_id)) byAdv.set(i.advance_id, []);
    byAdv.get(i.advance_id).push({ ...i, amount: Number(i.amount), month_label: i.deduction_month ? monthLabel(i.deduction_month) : null });
  }
  return rows.map((r) => ({ ...normalizeAdvance(r), installments: byAdv.get(r.advance_id) || [] }));
}

async function getAdvance(rawId, executor = db) {
  const id = positiveId(rawId, 'advance id');
  const [[a]] = await executor.execute(`${ADVANCE_SELECT} WHERE a.advance_id = ?`, [id]);
  if (!a) throw new AdvError('Advance not found.', 404, 'NOT_FOUND');
  const [installments] = await executor.execute(
    `SELECT i.installment_id, i.seq, i.deduction_month, i.amount, i.status, i.included_batch_id, i.displaced_by_batch_id,
            i.split_from_installment_id, DATE_FORMAT(i.deducted_at, '%Y-%m-%d %H:%i') AS deducted_at,
            b.status AS batch_status, b.is_finalized AS batch_finalized
     FROM staff_advance_installments i
     LEFT JOIN staff_payroll_batches b ON b.staff_payroll_batch_id = i.included_batch_id
     WHERE i.advance_id = ?
     ORDER BY i.seq`, [id]);
  const [ledger] = await executor.execute(
    `SELECT l.entry_id, l.entry_type, l.amount, l.installment_id, l.staff_payroll_batch_id, l.receipt_no, l.payment_method,
            l.note, u.full_name AS created_by, DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i') AS created_at
     FROM staff_advance_ledger l JOIN users u ON u.user_id = l.created_by_user_id
     WHERE l.advance_id = ? ORDER BY l.entry_id`, [id]);
  return {
    ...normalizeAdvance(a),
    installments: installments.map((i) => ({
      ...i, amount: Number(i.amount), month_label: i.deduction_month ? monthLabel(i.deduction_month) : null,
      batch_finalized: i.batch_finalized === null ? null : Boolean(Number(i.batch_finalized)),
    })),
    ledger: ledger.map((l) => ({ ...l, amount: Number(l.amount) })),
    ledger_balance: money(ledger.reduce((s, l) => s + Number(l.amount), 0)),
  };
}

async function recomputeBalance(executor, advanceId) {
  const [[r]] = await executor.execute(
    'SELECT COALESCE(SUM(amount), 0) AS bal FROM staff_advance_ledger WHERE advance_id = ?', [advanceId]);
  const bal = money(r.bal);
  await executor.execute('UPDATE staff_advances SET outstanding_balance = ? WHERE advance_id = ?', [bal.toFixed(2), advanceId]);
  return bal;
}

async function nextSeq(executor, advanceId) {
  const [[r]] = await executor.execute('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM staff_advance_installments WHERE advance_id = ?', [advanceId]);
  return Number(r.n);
}

async function withTransaction(fn) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function lockActiveAdvance(executor, rawId) {
  const id = positiveId(rawId, 'advance id');
  const [[a]] = await executor.execute('SELECT * FROM staff_advances WHERE advance_id = ? FOR UPDATE', [id]);
  if (!a) throw new AdvError('Advance not found.', 404, 'NOT_FOUND');
  if (a.status !== 'Active') {
    throw new AdvError(`Advance ${a.voucher_no} is ${a.status}. Only an active advance can be changed.`, 409, 'NOT_ACTIVE');
  }
  return a;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
async function createAdvance({ staffId: rawStaffId, amount: rawAmount, schedule, reason: rawReason, paymentMethod, paymentReference,
  reportId: rawReportId, idempotencyKey, userId }) {
  const staffId = positiveId(rawStaffId, 'staff id');
  const amount = money(rawAmount);
  if (!(amount > 0)) throw new AdvError('Enter an amount greater than 0.', 400, 'INVALID_AMOUNT');
  if (amount > 1e9) throw new AdvError('Amount is too large.', 400, 'INVALID_AMOUNT');
  const reason = requireReason(rawReason);
  const method = paymentMethod ? String(paymentMethod) : 'Cash';
  if (!PAYMENT_METHODS.includes(method)) throw new AdvError(`payment_method must be one of: ${PAYMENT_METHODS.join(', ')}.`);
  if (rawReportId === undefined || rawReportId === null || rawReportId === '') {
    throw new AdvError('Open the staff member\'s financial report first.', 400, 'FINANCIAL_REPORT_REQUIRED');
  }
  const reportId = positiveId(rawReportId, 'financial report id');
  const key = idempotencyKey ? String(idempotencyKey).trim().slice(0, 64) : null;

  if (key) {
    const [[existing]] = await db.execute('SELECT advance_id FROM staff_advances WHERE idempotency_key = ?', [key]);
    if (existing) return { duplicate: true, advance: await getAdvance(existing.advance_id) };
  }

  await ensureDocumentSequence('ADV');
  let created;
  try {
    created = await withTransaction(async (connection) => {
      const [[staff]] = await connection.execute(
        'SELECT staff_id, full_name, status FROM staff_members WHERE staff_id = ? FOR UPDATE', [staffId]);
      if (!staff) throw new AdvError('Staff member not found.', 404, 'NOT_FOUND');
      if (staff.status !== 'Active') {
        throw new AdvError(`${staff.full_name} is ${staff.status}. Advances are only for Active staff.`, 409, 'STAFF_NOT_ACTIVE');
      }
      const [[hold]] = await connection.execute(
        `SELECT hold_id FROM entity_deletion_holds WHERE entity_type = 'Staff' AND entity_id = ? AND released_at IS NULL`, [staffId]);
      if (hold) throw new AdvError('This staff member is on deletion hold. Release the hold first.', 409, 'STAFF_ON_HOLD');

      const validMinutes = await settingNumber('advance_report_valid_minutes', 30);
      const [[report]] = await connection.execute(
        `SELECT report_id, staff_id, (generated_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)) AS fresh
         FROM staff_financial_reports WHERE report_id = ? FOR UPDATE`, [validMinutes, reportId]);
      if (!report || Number(report.staff_id) !== staffId) {
        throw new AdvError('This financial report does not belong to this staff member. Open the report again.', 409, 'FINANCIAL_REPORT_MISMATCH');
      }
      if (!Number(report.fresh)) {
        throw new AdvError(`The financial report is older than ${validMinutes} minutes. Open it again before creating the advance.`,
          409, 'FINANCIAL_REPORT_EXPIRED');
      }
      const [[used]] = await connection.execute('SELECT voucher_no FROM staff_advances WHERE financial_report_id = ?', [reportId]);
      if (used) throw new AdvError(`This financial report was already used for ${used.voucher_no}. Open a new report.`, 409, 'FINANCIAL_REPORT_USED');

      if (!(await settingBool('advance_allow_multiple_open', false))) {
        // No FOR UPDATE here: the staff row lock above already serializes advances
        // of the same person, and a locking read of an empty range takes a gap
        // lock that deadlocks two concurrent creates for different people.
        const [open] = await connection.execute(
          `SELECT voucher_no, outstanding_balance FROM staff_advances WHERE staff_id = ? AND status = 'Active'`, [staffId]);
        if (open.length) {
          throw new AdvError(`${staff.full_name} already has an open advance (${open.map((o) => o.voucher_no).join(', ')}). Close it first.`,
            409, 'OPEN_ADVANCE_EXISTS');
        }
      }

      const { rows, warnings } = await validateSchedule(connection, schedule, amount);
      const currency = await staffCurrency();
      const windowHours = await settingNumber('advance_cancel_window_hours', 72);
      const voucherNo = await nextDocumentNumber(connection, 'ADV');

      const [ins] = await connection.execute(
        `INSERT INTO staff_advances
           (voucher_no, staff_id, currency, amount, deduction_mode, reason, payment_method, payment_reference,
            financial_report_id, status, outstanding_balance, cancel_deadline, idempotency_key, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, DATE_ADD(NOW(), INTERVAL ? HOUR), ?, ?, NOW())`,
        [voucherNo, staffId, currency, amount.toFixed(2), rows.length === 1 ? 'Full' : 'Partial', reason.slice(0, 1000), method,
          paymentReference ? String(paymentReference).trim().slice(0, 100) : null, reportId, amount.toFixed(2),
          windowHours, key, userId]);
      const advanceId = ins.insertId;
      let seq = 1;
      for (const r of rows) {
        await connection.execute(
          `INSERT INTO staff_advance_installments (advance_id, seq, deduction_month, amount, status, created_at)
           VALUES (?, ?, ?, ?, 'Scheduled', NOW())`, [advanceId, seq, r.month, r.amount.toFixed(2)]);
        seq += 1;
      }
      await connection.execute(
        `INSERT INTO staff_advance_ledger (advance_id, entry_type, amount, payment_method, note, created_by_user_id, created_at)
         VALUES (?, 'Disbursement', ?, ?, ?, ?, NOW())`,
        [advanceId, amount.toFixed(2), method, `Advance paid out: ${voucherNo}`, userId]);
      await audit(connection, 'staff_advances', advanceId, 'ADVANCE_CREATED', userId, null,
        { voucher_no: voucherNo, staff_id: staffId, amount, currency, schedule: rows, reason, payment_method: method, financial_report_id: reportId });
      return { advanceId, warnings };
    });
  } catch (error) {
    if (key && error && error.code === 'ER_DUP_ENTRY' && /idempotency/.test(error.message)) {
      const [[existing]] = await db.execute('SELECT advance_id FROM staff_advances WHERE idempotency_key = ?', [key]);
      if (existing) return { duplicate: true, advance: await getAdvance(existing.advance_id) };
    }
    throw error;
  }
  return { duplicate: false, advance: await getAdvance(created.advanceId), warnings: created.warnings };
}

// ---------------------------------------------------------------------------
// Cancel (within the window): everything goes back to how it was.
// ---------------------------------------------------------------------------
async function cancelAdvance(rawId, { reason: rawReason, userId }) {
  const reason = requireReason(rawReason);
  const result = await withTransaction(async (connection) => {
    const a = await lockActiveAdvance(connection, rawId);
    const [[win]] = await connection.execute(
      `SELECT NOW() <= cancel_deadline AS open_window, DATE_FORMAT(cancel_deadline, '%Y-%m-%d %H:%i') AS deadline
       FROM staff_advances WHERE advance_id = ?`, [a.advance_id]);
    if (!Number(win.open_window)) {
      throw new AdvError(`The cancel window of ${a.voucher_no} closed on ${win.deadline}. ` +
        'It can now only be closed by a cash repayment or a write-off.', 409, 'CANCEL_WINDOW_CLOSED');
    }
    const [moves] = await connection.execute(
      `SELECT entry_type FROM staff_advance_ledger WHERE advance_id = ? AND entry_type <> 'Disbursement' LIMIT 1`, [a.advance_id]);
    if (moves.length) {
      throw new AdvError(`${a.voucher_no} already has a ${moves[0].entry_type}. It cannot be cancelled.`, 409, 'ADVANCE_HAS_MOVEMENTS');
    }
    const [inst] = await connection.execute(
      'SELECT * FROM staff_advance_installments WHERE advance_id = ? FOR UPDATE', [a.advance_id]);
    if (inst.some((i) => i.status === 'Deducted')) {
      throw new AdvError(`Part of ${a.voucher_no} was already deducted in a Paid batch. It cannot be cancelled.`, 409, 'ALREADY_DEDUCTED');
    }
    // Installments carried by a batch: only a Generated, NOT finalized batch can be
    // changed back. A finalized batch must be superseded first (nothing is changed).
    const included = inst.filter((i) => i.status === 'Included');
    const byBatch = new Map();
    for (const i of included) {
      if (!byBatch.has(i.included_batch_id)) byBatch.set(i.included_batch_id, 0);
      byBatch.set(i.included_batch_id, byBatch.get(i.included_batch_id) + cents(i.amount));
    }
    for (const batchId of byBatch.keys()) {
      const [[b]] = await connection.execute(
        'SELECT staff_payroll_batch_id, status, is_finalized FROM staff_payroll_batches WHERE staff_payroll_batch_id = ? FOR UPDATE', [batchId]);
      if (!b || b.status !== 'Generated') {
        throw new AdvError(`Staff batch #${batchId} is ${b ? b.status : 'missing'}; the deduction cannot be reversed.`, 409, 'BATCH_LOCKED');
      }
      if (Number(b.is_finalized)) {
        throw new AdvError(`The deduction of ${a.voucher_no} is in staff batch #${batchId}, which is finalized. ` +
          'Use "Correct (supersede)" on that batch first, then cancel. Nothing was changed.', 409, 'SUPERSEDE_REQUIRED', { batch_id: batchId });
      }
    }
    const reversed = [];
    for (const [batchId, c] of byBatch) {
      const amt = money(c / 100);
      const [[line]] = await connection.execute(
        `SELECT staff_payroll_id, net_salary, advance_deduction_amount FROM staff_payroll
         WHERE staff_payroll_batch_id = ? AND staff_id = ? FOR UPDATE`, [batchId, a.staff_id]);
      if (!line || cents(line.advance_deduction_amount) < c) {
        throw new AdvError(`Staff batch #${batchId} does not hold this deduction as expected. Nothing was changed.`, 409, 'BATCH_LINE_MISMATCH');
      }
      await connection.execute(
        `UPDATE staff_payroll SET advance_deduction_amount = advance_deduction_amount - ?, net_salary = net_salary + ?
         WHERE staff_payroll_id = ?`, [amt.toFixed(2), amt.toFixed(2), line.staff_payroll_id]);
      await connection.execute(
        'UPDATE staff_payroll_batches SET total_amount = total_amount + ? WHERE staff_payroll_batch_id = ?', [amt.toFixed(2), batchId]);
      await audit(connection, 'staff_payroll', line.staff_payroll_id, 'ADVANCE_DEDUCTION_REVERSED', userId,
        { net_salary: Number(line.net_salary), advance_deduction_amount: Number(line.advance_deduction_amount) },
        { net_salary: money(Number(line.net_salary) + amt), advance_deduction_amount: money(Number(line.advance_deduction_amount) - amt),
          voucher_no: a.voucher_no, batch_id: batchId, reason });
      reversed.push({ batch_id: batchId, amount: amt });
    }
    await connection.execute(
      `UPDATE staff_advance_installments SET status = 'Cancelled'
       WHERE advance_id = ? AND status IN ('Scheduled','Included','Unscheduled')`, [a.advance_id]);
    const balance = money(a.outstanding_balance);
    await connection.execute(
      `INSERT INTO staff_advance_ledger (advance_id, entry_type, amount, note, created_by_user_id, created_at)
       VALUES (?, 'Cancellation', ?, ?, ?, NOW())`, [a.advance_id, (-balance).toFixed(2), reason.slice(0, 500), userId]);
    await recomputeBalance(connection, a.advance_id);
    await connection.execute(
      `UPDATE staff_advances SET status = 'Cancelled', cancelled_by_user_id = ?, cancelled_at = NOW(), cancel_reason = ?
       WHERE advance_id = ?`, [userId, reason.slice(0, 500), a.advance_id]);
    await audit(connection, 'staff_advances', a.advance_id, 'ADVANCE_CANCELLED', userId,
      { status: 'Active', outstanding_balance: balance }, { status: 'Cancelled', reason, reversed_in_batches: reversed });
    return { voucher_no: a.voucher_no, reversed };
  });
  return { ...result, advance: await getAdvance(rawId) };
}

// ---------------------------------------------------------------------------
// Reschedule what is not in a batch yet (Scheduled + Unscheduled).
// ---------------------------------------------------------------------------
async function rescheduleAdvance(rawId, { schedule, reason: rawReason, userId }) {
  const reason = requireReason(rawReason);
  const warnings = await withTransaction(async (connection) => {
    const a = await lockActiveAdvance(connection, rawId);
    const [editable] = await connection.execute(
      `SELECT installment_id, deduction_month, amount, status FROM staff_advance_installments
       WHERE advance_id = ? AND status IN ('Scheduled','Unscheduled') FOR UPDATE`, [a.advance_id]);
    if (!editable.length) throw new AdvError('Nothing left to reschedule: every installment is already in a batch or deducted.', 409, 'NOTHING_TO_RESCHEDULE');
    const total = money(editable.reduce((s, i) => s + Number(i.amount), 0));
    const { rows, warnings: w } = await validateSchedule(connection, schedule, total);
    await connection.query(
      `UPDATE staff_advance_installments SET status = 'Replaced' WHERE installment_id IN (?)`, [editable.map((i) => i.installment_id)]);
    let seq = await nextSeq(connection, a.advance_id);
    for (const r of rows) {
      await connection.execute(
        `INSERT INTO staff_advance_installments (advance_id, seq, deduction_month, amount, status, created_at)
         VALUES (?, ?, ?, ?, 'Scheduled', NOW())`, [a.advance_id, seq, r.month, r.amount.toFixed(2)]);
      seq += 1;
    }
    await audit(connection, 'staff_advances', a.advance_id, 'ADVANCE_RESCHEDULED', userId,
      { schedule: editable.map((i) => ({ month: i.deduction_month, amount: Number(i.amount), status: i.status })) },
      { schedule: rows, reason });
    return w;
  });
  return { advance: await getAdvance(rawId), warnings };
}

// ---------------------------------------------------------------------------
// Cash repayment (receipt RCP-YYYY-NNNNNN). Reduces the latest installments first.
// ---------------------------------------------------------------------------
async function repayAdvance(rawId, { amount: rawAmount, reason: rawReason, paymentMethod, userId }) {
  const reason = requireReason(rawReason);
  const amount = money(rawAmount);
  if (!(amount > 0)) throw new AdvError('Enter an amount greater than 0.', 400, 'INVALID_AMOUNT');
  const method = paymentMethod ? String(paymentMethod) : 'Cash';
  if (!PAYMENT_METHODS.includes(method)) throw new AdvError(`payment_method must be one of: ${PAYMENT_METHODS.join(', ')}.`);
  await ensureDocumentSequence('RCP');
  const result = await withTransaction(async (connection) => {
    const a = await lockActiveAdvance(connection, rawId);
    const [editable] = await connection.execute(
      `SELECT * FROM staff_advance_installments WHERE advance_id = ? AND status IN ('Scheduled','Unscheduled')
       ORDER BY (deduction_month IS NULL) DESC, deduction_month DESC, seq DESC FOR UPDATE`, [a.advance_id]);
    const free = editable.reduce((s, i) => s + cents(i.amount), 0);
    if (cents(amount) > free) {
      const [inc] = await connection.execute(
        `SELECT DISTINCT included_batch_id FROM staff_advance_installments WHERE advance_id = ? AND status = 'Included'`, [a.advance_id]);
      throw new AdvError(`At most ${money(free / 100).toFixed(2)} ${a.currency} can be repaid now` +
        (inc.length ? ` (the rest is already in staff batch ${inc.map((r) => `#${r.included_batch_id}`).join(', ')})` : '') + '.',
      409, 'REPAY_TOO_MUCH');
    }
    let left = cents(amount);
    let seq = await nextSeq(connection, a.advance_id);
    for (const i of editable) {
      if (left <= 0) break;
      const c = cents(i.amount);
      if (left >= c) {
        await connection.execute(`UPDATE staff_advance_installments SET status = 'Repaid' WHERE installment_id = ?`, [i.installment_id]);
        left -= c;
      } else {
        await connection.execute('UPDATE staff_advance_installments SET amount = ? WHERE installment_id = ?',
          [money((c - left) / 100).toFixed(2), i.installment_id]);
        await connection.execute(
          `INSERT INTO staff_advance_installments (advance_id, seq, deduction_month, amount, status, split_from_installment_id, created_at)
           VALUES (?, ?, ?, ?, 'Repaid', ?, NOW())`,
          [a.advance_id, seq, i.deduction_month, money(left / 100).toFixed(2), i.installment_id]);
        seq += 1;
        left = 0;
      }
    }
    const receiptNo = await nextDocumentNumber(connection, 'RCP');
    const [led] = await connection.execute(
      `INSERT INTO staff_advance_ledger (advance_id, entry_type, amount, receipt_no, payment_method, note, created_by_user_id, created_at)
       VALUES (?, 'CashRepayment', ?, ?, ?, ?, ?, NOW())`,
      [a.advance_id, (-amount).toFixed(2), receiptNo, method, reason.slice(0, 500), userId]);
    const balance = await recomputeBalance(connection, a.advance_id);
    if (balance <= 0) {
      await connection.execute(`UPDATE staff_advances SET status = 'Settled', settled_at = NOW() WHERE advance_id = ?`, [a.advance_id]);
    }
    await audit(connection, 'staff_advances', a.advance_id, 'ADVANCE_REPAID', userId,
      { outstanding_balance: Number(a.outstanding_balance) }, { amount, receipt_no: receiptNo, outstanding_balance: balance, reason });
    return { receipt_no: receiptNo, entry_id: led.insertId, balance };
  });
  return { ...result, advance: await getAdvance(rawId) };
}

// ---------------------------------------------------------------------------
// Write-off (nothing may be in a batch).
// ---------------------------------------------------------------------------
async function writeOffAdvance(rawId, { reason: rawReason, userId }) {
  const reason = requireReason(rawReason);
  await withTransaction(async (connection) => {
    const a = await lockActiveAdvance(connection, rawId);
    const [inc] = await connection.execute(
      `SELECT DISTINCT included_batch_id FROM staff_advance_installments WHERE advance_id = ? AND status = 'Included'`, [a.advance_id]);
    if (inc.length) {
      throw new AdvError(`Part of ${a.voucher_no} is in staff batch ${inc.map((r) => `#${r.included_batch_id}`).join(', ')}. ` +
        'Void / supersede that batch or mark it Paid first.', 409, 'IN_BATCH');
    }
    await connection.execute(
      `UPDATE staff_advance_installments SET status = 'WrittenOff' WHERE advance_id = ? AND status IN ('Scheduled','Unscheduled')`,
      [a.advance_id]);
    const balance = money(a.outstanding_balance);
    await connection.execute(
      `INSERT INTO staff_advance_ledger (advance_id, entry_type, amount, note, created_by_user_id, created_at)
       VALUES (?, 'WriteOff', ?, ?, ?, NOW())`, [a.advance_id, (-balance).toFixed(2), reason.slice(0, 500), userId]);
    await recomputeBalance(connection, a.advance_id);
    await connection.execute(
      `UPDATE staff_advances SET status = 'WrittenOff', written_off_by_user_id = ?, written_off_at = NOW(), write_off_reason = ?
       WHERE advance_id = ?`, [userId, reason.slice(0, 500), a.advance_id]);
    await audit(connection, 'staff_advances', a.advance_id, 'ADVANCE_WRITTEN_OFF', userId,
      { outstanding_balance: balance }, { status: 'WrittenOff', reason });
  });
  return { advance: await getAdvance(rawId) };
}

async function recordVoucherPrint(advanceId, userId) {
  await db.execute('UPDATE staff_advances SET voucher_print_count = voucher_print_count + 1 WHERE advance_id = ?', [advanceId]);
  const [[r]] = await db.execute('SELECT voucher_print_count FROM staff_advances WHERE advance_id = ?', [advanceId]);
  await audit(db, 'staff_advances', advanceId, 'VOUCHER_PRINTED', userId, null, { print_number: Number(r.voucher_print_count) });
  return Number(r.voucher_print_count);
}

async function saveSignedReceipt(rawId, { fileName, userId }) {
  const id = positiveId(rawId, 'advance id');
  const [[a]] = await db.execute('SELECT advance_id, receipt_file FROM staff_advances WHERE advance_id = ?', [id]);
  if (!a) throw new AdvError('Advance not found.', 404, 'NOT_FOUND');
  await db.execute(
    'UPDATE staff_advances SET receipt_file = ?, receipt_uploaded_by = ?, receipt_uploaded_at = NOW() WHERE advance_id = ?',
    [fileName, userId, id]);
  await audit(db, 'staff_advances', id, 'SIGNED_RECEIPT_UPLOADED', userId, { receipt_file: a.receipt_file }, { receipt_file: fileName });
}

// ---------------------------------------------------------------------------
// Payroll hooks (called inside the staff payroll transaction)
// ---------------------------------------------------------------------------

// Scheduled installments of the batch's month, by staff_id.
async function loadDueForBatch(executor, batchEndDate, currency) {
  const month = String(batchEndDate).slice(0, 7);
  const [rows] = await executor.execute(
    `SELECT i.installment_id, i.advance_id, i.seq, i.amount, i.deduction_month, a.staff_id, a.voucher_no
     FROM staff_advance_installments i
     JOIN staff_advances a ON a.advance_id = i.advance_id
     WHERE i.status = 'Scheduled' AND i.deduction_month = ? AND a.status = 'Active' AND a.currency = ?
     ORDER BY a.advance_id, i.seq
     FOR UPDATE`, [month, currency]);
  const byStaff = new Map();
  for (const r of rows) {
    if (!byStaff.has(r.staff_id)) byStaff.set(r.staff_id, []);
    byStaff.get(r.staff_id).push(r);
  }
  return byStaff;
}

// Deducts up to `available` from this staff member's due installments.
// Returns { amount, vouchers, warnings }.
async function deductForLine(executor, due, available, batchId, staff) {
  let left = Math.max(0, cents(available));
  let taken = 0;
  const vouchers = [];
  const warnings = [];
  for (const i of due) {
    const c = cents(i.amount);
    const take = Math.min(c, left);
    if (take === c) {
      await executor.execute(
        `UPDATE staff_advance_installments SET status = 'Included', included_batch_id = ? WHERE installment_id = ?`,
        [batchId, i.installment_id]);
    } else if (take > 0) {
      await executor.execute(
        `UPDATE staff_advance_installments SET status = 'Included', included_batch_id = ?, amount = ? WHERE installment_id = ?`,
        [batchId, money(take / 100).toFixed(2), i.installment_id]);
      await executor.execute(
        `INSERT INTO staff_advance_installments
           (advance_id, seq, deduction_month, amount, status, displaced_by_batch_id, split_from_installment_id, created_at)
         VALUES (?, ?, NULL, ?, 'Unscheduled', ?, ?, NOW())`,
        [i.advance_id, await nextSeq(executor, i.advance_id), money((c - take) / 100).toFixed(2), batchId, i.installment_id]);
      warnings.push({ staff_id: staff.staff_id, full_name: staff.full_name, voucher_no: i.voucher_no,
        message: `Only ${money(take / 100).toFixed(2)} of ${money(c / 100).toFixed(2)} (${i.voucher_no}) could be deducted: ` +
          `the rest (${money((c - take) / 100).toFixed(2)}) is Unscheduled. Choose a new month for it.` });
    } else {
      await executor.execute(
        `UPDATE staff_advance_installments SET status = 'Unscheduled', displaced_by_batch_id = ? WHERE installment_id = ?`,
        [batchId, i.installment_id]);
      warnings.push({ staff_id: staff.staff_id, full_name: staff.full_name, voucher_no: i.voucher_no,
        message: `${money(c / 100).toFixed(2)} (${i.voucher_no}) could not be deducted: the pay is too low. It is Unscheduled. Choose a new month for it.` });
    }
    left -= take;
    taken += take;
    if (take > 0) vouchers.push(i.voucher_no);
  }
  return { amount: money(taken / 100), vouchers, warnings };
}

// Installments of the month for staff who are not in this batch.
async function displaceRemaining(executor, dueByStaff, batchId) {
  const warnings = [];
  for (const list of dueByStaff.values()) {
    for (const i of list) {
      await executor.execute(
        `UPDATE staff_advance_installments SET status = 'Unscheduled', displaced_by_batch_id = ? WHERE installment_id = ?`,
        [batchId, i.installment_id]);
      warnings.push({ staff_id: i.staff_id, voucher_no: i.voucher_no,
        message: `${Number(i.amount).toFixed(2)} (${i.voucher_no}) was not deducted: the staff member is not in this batch. ` +
          'It is Unscheduled. Choose a new month for it.' });
    }
  }
  return warnings;
}

// Void / supersede: put back exactly what the batch changed.
async function releaseBatches(executor, batchIds) {
  const ids = (batchIds || []).map(Number).filter((n) => n > 0);
  if (!ids.length) return 0;
  // 1. Remainders split off by these batches go back into their installment.
  const [remainders] = await executor.query(
    `SELECT installment_id, split_from_installment_id, amount FROM staff_advance_installments
     WHERE displaced_by_batch_id IN (?) AND split_from_installment_id IS NOT NULL AND status = 'Unscheduled' FOR UPDATE`, [ids]);
  for (const r of remainders) {
    await executor.execute('UPDATE staff_advance_installments SET amount = amount + ? WHERE installment_id = ?',
      [Number(r.amount).toFixed(2), r.split_from_installment_id]);
    await executor.execute('DELETE FROM staff_advance_installments WHERE installment_id = ?', [r.installment_id]);
  }
  // 2. Carried installments wait for their month again.
  const [inc] = await executor.query(
    `UPDATE staff_advance_installments SET status = 'Scheduled', included_batch_id = NULL
     WHERE status = 'Included' AND included_batch_id IN (?)`, [ids]);
  // 3. Installments these batches could not deduct wait for their month again.
  await executor.query(
    `UPDATE staff_advance_installments SET status = 'Scheduled', displaced_by_batch_id = NULL
     WHERE status = 'Unscheduled' AND displaced_by_batch_id IN (?) AND split_from_installment_id IS NULL
       AND deduction_month IS NOT NULL`, [ids]);
  return inc.affectedRows;
}

// Mark Paid: the carried installments are deducted for good.
async function applyPaidBatch(executor, batchId, userId) {
  const [rows] = await executor.execute(
    `SELECT i.installment_id, i.advance_id, i.amount, a.voucher_no FROM staff_advance_installments i
     JOIN staff_advances a ON a.advance_id = i.advance_id
     WHERE i.status = 'Included' AND i.included_batch_id = ? FOR UPDATE`, [batchId]);
  const touched = new Set();
  for (const r of rows) {
    await executor.execute(
      `UPDATE staff_advance_installments SET status = 'Deducted', deducted_at = NOW() WHERE installment_id = ?`, [r.installment_id]);
    await executor.execute(
      `INSERT INTO staff_advance_ledger (advance_id, entry_type, amount, installment_id, staff_payroll_batch_id, note, created_by_user_id, created_at)
       VALUES (?, 'PayrollDeduction', ?, ?, ?, ?, ?, NOW())`,
      [r.advance_id, (-Number(r.amount)).toFixed(2), r.installment_id, batchId, `Deducted in staff batch #${batchId}`, userId]);
    touched.add(r.advance_id);
  }
  for (const advanceId of touched) {
    const bal = await recomputeBalance(executor, advanceId);
    if (bal <= 0) {
      await executor.execute(`UPDATE staff_advances SET status = 'Settled', settled_at = NOW() WHERE advance_id = ? AND status = 'Active'`, [advanceId]);
      await audit(executor, 'staff_advances', advanceId, 'ADVANCE_SETTLED', userId, null, { by_batch_id: batchId });
    }
  }
  return rows.length;
}

// Deductions carried by a batch (for details / Excel / PDF).
async function listForBatch(executor, batchId) {
  const [rows] = await executor.execute(
    `SELECT i.installment_id, i.advance_id, a.voucher_no, a.staff_id, sm.staff_unique_id, sm.full_name,
            i.deduction_month, i.amount, i.status, a.amount AS advance_amount, a.outstanding_balance, a.status AS advance_status,
            DATE_FORMAT(a.created_at, '%Y-%m-%d') AS advance_date
     FROM staff_advance_installments i
     JOIN staff_advances a ON a.advance_id = i.advance_id
     JOIN staff_members sm ON sm.staff_id = a.staff_id
     WHERE i.included_batch_id = ? AND i.status IN ('Included','Deducted')
     ORDER BY sm.full_name, a.voucher_no, i.seq`, [batchId]);
  // Balance right after this batch: Included -> current balance minus the deduction;
  // Deducted -> running ledger balance at that deduction (later moves not counted).
  const afterDeduction = new Map();
  const deducted = rows.filter((r) => r.status === 'Deducted');
  if (deducted.length) {
    const [ledger] = await executor.query(
      `SELECT advance_id, installment_id, amount FROM staff_advance_ledger WHERE advance_id IN (?) ORDER BY advance_id, entry_id`,
      [[...new Set(deducted.map((r) => r.advance_id))]]);
    const running = new Map();
    for (const l of ledger) {
      const bal = money((running.get(l.advance_id) || 0) + Number(l.amount));
      running.set(l.advance_id, bal);
      if (l.installment_id) afterDeduction.set(l.installment_id, bal);
    }
  }
  return rows.map((r) => {
    const amount = Number(r.amount);
    const balance = Number(r.outstanding_balance);
    return {
      ...r, amount, advance_amount: Number(r.advance_amount), outstanding_balance: balance,
      remaining_after: r.status === 'Included'
        ? money(balance - amount)
        : (afterDeduction.has(r.installment_id) ? afterDeduction.get(r.installment_id) : balance),
    };
  });
}

// Excel sheet with the voucher numbers (deductions already inside Net Salary).
function addAdvancesSheet(workbook, rows, moneyFmt) {
  if (!rows || !rows.length) return null;
  const sheet = workbook.addWorksheet('Advances');
  sheet.columns = [
    { header: 'No.', key: 'n', width: 6 },
    { header: 'Voucher No.', key: 'voucher', width: 18 },
    { header: 'Staff ID', key: 'code', width: 12 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Advance date', key: 'date', width: 13 },
    { header: 'Advance amount', key: 'adv', width: 15 },
    { header: 'Deducted in this batch', key: 'amount', width: 18 },
    { header: 'Balance after this batch', key: 'after', width: 18 },
    { header: 'Status', key: 'status', width: 11 },
  ];
  sheet.getRow(1).font = { bold: true };
  let total = 0;
  rows.forEach((r, i) => {
    const row = sheet.addRow({ n: i + 1, voucher: r.voucher_no, code: r.staff_unique_id, name: r.full_name, date: r.advance_date,
      adv: r.advance_amount, amount: r.amount, after: r.remaining_after, status: r.status });
    ['adv', 'amount', 'after'].forEach((k) => { row.getCell(k).numFmt = moneyFmt; });
    total = money(total + r.amount);
  });
  const t = sheet.addRow({ name: 'TOTAL ADVANCE DEDUCTIONS (already subtracted from Net Salary)', amount: total });
  t.font = { bold: true };
  t.getCell('amount').numFmt = moneyFmt;
  return sheet;
}

// ---------------------------------------------------------------------------
// Blocks used by other modules
// ---------------------------------------------------------------------------
async function openAdvancesFor(executor, staffId) {
  const [rows] = await executor.execute(
    `SELECT advance_id, voucher_no, outstanding_balance, currency FROM staff_advances
     WHERE staff_id = ? AND status = 'Active' ORDER BY advance_id`, [staffId]);
  return rows.map((r) => ({ ...r, outstanding_balance: Number(r.outstanding_balance) }));
}

async function countAdvancesFor(executor, staffId) {
  const [[r]] = await executor.execute('SELECT COUNT(*) AS c FROM staff_advances WHERE staff_id = ?', [staffId]);
  return Number(r.c);
}

async function assertStaffAdvanceSchema(executor = db) {
  const [[t]] = await executor.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME IN ('document_sequences','staff_financial_reports','staff_advances','staff_advance_installments','staff_advance_ledger')`);
  const [[c]] = await executor.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'staff_payroll' AND COLUMN_NAME = 'advance_deduction_amount'`);
  if (Number(t.n) !== 5 || Number(c.n) !== 1) {
    throw new Error('Staff advance tables are missing. Run migrations/2026_10_staff_advances/01_ddl.sql before starting this version.');
  }
}

function sendError(res, error, fallback) {
  if (error && error.isOperational) {
    return res.status(error.statusCode || 400).json({
      status: 'error', ...(error.code ? { code: error.code } : {}), message: error.message, ...(error.extra || {}),
    });
  }
  console.error(fallback, error);
  return res.status(500).json({ status: 'error', message: fallback });
}

module.exports = {
  AdvError, money, monthLabel, PAYMENT_METHODS,
  nextDocumentNumber, ensureDocumentSequence, monthStates, availableMonths, validateSchedule,
  buildFinancialReport, getFinancialReport,
  listAdvances, getAdvance, createAdvance, cancelAdvance, rescheduleAdvance, repayAdvance, writeOffAdvance,
  recordVoucherPrint, saveSignedReceipt,
  loadDueForBatch, deductForLine, displaceRemaining, releaseBatches, applyPaidBatch, listForBatch, addAdvancesSheet,
  openAdvancesFor, countAdvancesFor, assertStaffAdvanceSchema, sendError,
};
