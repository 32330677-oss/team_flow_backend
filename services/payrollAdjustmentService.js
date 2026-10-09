// services/payrollAdjustmentService.js
//
// Payroll adjustments ("retro pay"): money differences on a PAID period are
// paid (or deducted) in the next payroll batch. A paid batch is never changed.
//
// Where an adjustment comes from
//   * Correction  — an Admin correction of an Approved attendance record whose
//                   date lies in a PAID batch. The difference is computed
//                   automatically:  amount = pay(corrected) - pay(original)
//                   with exactly the payroll formula and the rates of the paid
//                   period (never today's rates).
//                     Worker: one day  (day fraction / hours x rate + OT x OT rate)
//                     Staff : the whole month recomputed (proration, shortage,
//                             OT coverage), once with the original record and
//                             once with the corrected one; the difference of the
//                             two nets isolates this correction only.
//                   A correction made while the batch was only FINALIZED is
//                   converted the moment that batch is marked Paid (it was not
//                   in the paid amount). A finalized batch that is superseded
//                   already includes the correction: nothing to pay.
//   * Manual      — an amount typed by the Admin with a reason.
//
// Life cycle
//   AwaitingConfirmation  (negative amounts: a deduction needs an explicit OK)
//   Pending               waits for the next batch that contains the person
//   Included              carried by a Generated batch (included_batch_id)
//                         -> back to Pending if that batch is voided/superseded
//   Applied               that batch was marked Paid
//   Cancelled             by the Admin, with a reason (Pending / Awaiting only)
//
// Worker adjustments are carried by REGULAR worker batches only (never by an
// off-cycle batch). Currency = the paid batch's currency (manual: the payroll
// currency setting). Every change is audited.

const db = require('../config/db');
const settingsCache = require('./settingsCache');
const { countNonFridayDays } = require('./staffAttendanceService');

const DEFAULT_STANDARD_MINUTES = 600;

class AdjError extends Error {
  constructor(message, statusCode = 400, code = undefined) {
    super(message);
    this.isOperational = true;
    this.statusCode = statusCode;
    this.code = code;
  }
}

const TYPES = {
  Worker: {
    batchTable: 'payrollbatches', batchPk: 'payroll_batch_id', lineTable: 'payroll', personCol: 'worker_id',
    personTable: 'workers', codeCol: 'worker_unique_id', currencySetting: 'worker_payroll_currency', defaultCurrency: 'SYP',
    recordTable: 'attendance',
  },
  Staff: {
    batchTable: 'staff_payroll_batches', batchPk: 'staff_payroll_batch_id', lineTable: 'staff_payroll', personCol: 'staff_id',
    personTable: 'staff_members', codeCol: 'staff_unique_id', currencySetting: 'staff_payroll_currency', defaultCurrency: 'USD',
    recordTable: 'staff_attendance',
  },
};

function typeDef(personType) {
  const def = TYPES[personType];
  if (!def) throw new AdjError('person_type must be Worker or Staff.');
  return def;
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function parseJson(v) {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

async function audit(executor, recordId, action, userId, oldValues, newValues) {
  await executor.execute(
    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
     VALUES ('payroll_adjustments', ?, ?, ?, ?, ?)`,
    [recordId, action, userId || null, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null]
  );
}

// ---------------------------------------------------------------------------
// Worker: pay of ONE attendance day — mirror of adminPayrollController
// generatePayrollBatch (Daily day fraction / Hourly hours, flat dated OT rate).
// ---------------------------------------------------------------------------
async function workerDayPay(row, ctx) {
  const dateStr = String(row.record_date).slice(0, 10);
  const worked = Number(row.total_working_hours || 0);
  const otHours = Number(row.overtime_hours || 0);
  let base = 0;
  let fraction = null;
  if (ctx.payType === 'Daily') {
    const nonWorkingStatus = ['Absent', 'Sick', 'Vacation', 'Holiday'].includes(row.attendance_status);
    const hasManagementHours = worked > 0 && nonWorkingStatus;
    if (nonWorkingStatus && !hasManagementHours) {
      fraction = 0;
    } else {
      const hasCustomMinutes = Number(ctx.customMinutes) > 0;
      const explicitMinutes = hasCustomMinutes ? null
        : Number(await settingsCache.getExplicitSettingForDate('standard_work_minutes', dateStr));
      const standardMinutes = explicitMinutes > 0
        ? explicitMinutes
        : Number(row.standard_minutes_snapshot) > 0
          ? Number(row.standard_minutes_snapshot)
          : (Number(await settingsCache.getSettingForDate('standard_work_minutes', dateStr, String(DEFAULT_STANDARD_MINUTES))) || DEFAULT_STANDARD_MINUTES);
      const standardHours = standardMinutes / 60;
      fraction = standardHours > 0 ? Math.min(1, worked / standardHours) : 0;
    }
    base = fraction * Number(ctx.dailyRate);
  } else {
    base = worked * Number(ctx.hourlyRate);
  }
  let ot = 0;
  if (otHours > 0) {
    if (!(Number(ctx.otRate) > 0)) {
      throw new AdjError(`No overtime rate is configured for ${dateStr}; the difference cannot be computed.`, 422, 'OVERTIME_RATE_NOT_CONFIGURED');
    }
    ot = otHours * Number(ctx.otRate);
  }
  return {
    total: money(base + ot), base: money(base), overtime: money(ot),
    day_fraction: fraction === null ? null : Number(fraction.toFixed(4)), hours: worked, overtime_hours: otHours,
  };
}

async function overtimeRateFor(dateStr) {
  const raw = await settingsCache.getSettingForDate('overtime_flat_rate_syp', dateStr, null);
  const v = Number(raw);
  return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(v) && v > 0 ? v : null;
}

// The rates the PAID batch used for this attendance row (snapshot), else the
// rates that applied on that date (compensation history + dated OT setting).
async function workerRatesFor(executor, batchId, attendanceId, workerId, dateStr) {
  const [[snap]] = await executor.execute(
    `SELECT pi.pay_type, pi.daily_rate_snapshot, pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot
     FROM payroll_attendance_snapshot pas
     JOIN payrollitems pi ON pi.payroll_item_id = pas.payroll_item_id
     WHERE pas.payroll_batch_id = ? AND pas.attendance_id = ? LIMIT 1`, [batchId, attendanceId]);
  const [[w]] = await executor.execute('SELECT standard_daily_minutes FROM workers WHERE worker_id = ?', [workerId]);
  const customMinutes = w ? w.standard_daily_minutes : null;
  if (snap) {
    return {
      source: 'paid_batch_snapshot', payType: snap.pay_type, dailyRate: snap.daily_rate_snapshot, hourlyRate: snap.hourly_rate_snapshot,
      otRate: snap.overtime_hourly_rate_snapshot !== null ? snap.overtime_hourly_rate_snapshot : await overtimeRateFor(dateStr),
      customMinutes,
    };
  }
  const [[comp]] = await executor.execute(
    `SELECT payment_type, daily_rate, regular_hourly_rate FROM workercompensationhistory
     WHERE worker_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY effective_from DESC LIMIT 1`, [workerId, dateStr, dateStr]);
  if (!comp) throw new AdjError(`No pay rate found for this worker on ${dateStr}; the difference cannot be computed.`, 422, 'NO_RATE');
  return {
    source: 'compensation_history', payType: comp.payment_type, dailyRate: comp.daily_rate, hourlyRate: comp.regular_hourly_rate,
    otRate: await overtimeRateFor(dateStr), customMinutes,
  };
}

async function computeWorkerDelta(executor, log, batchId) {
  const original = parseJson(log.original_values);
  const corrected = parseJson(log.corrected_values);
  const dateStr = String(log.record_date).slice(0, 10);
  const rates = await workerRatesFor(executor, batchId, log.record_id, log.person_id, dateStr);
  const before = await workerDayPay({ ...original, record_date: dateStr }, rates);
  const after = await workerDayPay({ ...corrected, record_date: dateStr }, rates);
  return {
    amount: money(after.total - before.total), before: before.total, after: after.total,
    detail: { kind: 'worker_day', date: dateStr, rates_source: rates.source, pay_type: rates.payType,
      daily_rate: rates.dailyRate, hourly_rate: rates.hourlyRate, overtime_rate: rates.otRate, before, after },
  };
}

// ---------------------------------------------------------------------------
// Staff: the whole paid month recomputed twice (original vs corrected record).
// ---------------------------------------------------------------------------
const STAFF_FIELDS = ['attendance_status', 'is_paid', 'is_management_paid_absence', 'regular_hours',
  'overtime_hours', 'is_friday_worked', 'standard_minutes_snapshot'];

async function computeStaffDelta(executor, log, batch) {
  const { calculateStaff } = require('./staffPayrollPreviewService');
  const [[staff]] = await executor.execute(
    `SELECT staff_id, staff_unique_id, full_name, monthly_salary, paid_leave_types, standard_daily_hours
     FROM staff_members WHERE staff_id = ?`, [log.person_id]);
  if (!staff) throw new AdjError('Staff member not found.', 404);
  const start = String(batch.start_date).slice(0, 10);
  const end = String(batch.end_date).slice(0, 10);
  const nonFriday = countNonFridayDays(start, end);
  const pick = (v) => {
    const o = parseJson(v) || {};
    const out = {};
    for (const k of STAFF_FIELDS) if (o[k] !== undefined) out[k] = o[k];
    return out;
  };
  const run = async (values) => {
    const result = await calculateStaff(staff, start, end, nonFriday, executor,
      { statuses: ['Approved'], overrides: new Map([[Number(log.record_id), values]]) });
    if (result.unresolved) {
      throw new AdjError('The historical salary of this month cannot be reconstructed; add a manual adjustment instead.', 422, 'COMPENSATION_UNRESOLVED');
    }
    return result.calc ? result.calc : null;
  };
  const before = await run(pick(log.original_values));
  const after = await run(pick(log.corrected_values));
  const beforeNet = before ? before.net_salary : 0;
  const afterNet = after ? after.net_salary : 0;
  return {
    amount: money(afterNet - beforeNet), before: beforeNet, after: afterNet,
    detail: { kind: 'staff_month', date: String(log.record_date).slice(0, 10), period: `${start}..${end}`,
      before: before && { net: before.net_salary, deduction: before.salary_deduction, uncovered_shortage_hours: before.uncovered_shortage_hours, hourly_rate: before.hourly_rate },
      after: after && { net: after.net_salary, deduction: after.salary_deduction, uncovered_shortage_hours: after.uncovered_shortage_hours, hourly_rate: after.hourly_rate } },
  };
}

// ---------------------------------------------------------------------------
// Create from a correction (same transaction as the caller).
// Returns { adjustment_id?, amount, status, currency } or { error }.
// The correction itself is never blocked by a failure here: the log stays
// Open and the Admin can add a manual adjustment.
// ---------------------------------------------------------------------------
async function createFromCorrection(executor, correctionId, userId) {
  const [[log]] = await executor.execute('SELECT * FROM attendance_corrections_log WHERE correction_id = ? FOR UPDATE', [correctionId]);
  if (!log) return { error: 'Correction not found.' };
  if (log.adjustment_status !== 'Open' || !log.locked_batch_id) return { skipped: true };
  const personType = log.record_table === 'attendance' ? 'Worker' : 'Staff';
  const def = TYPES[personType];
  const [[existing]] = await executor.execute('SELECT adjustment_id FROM payroll_adjustments WHERE correction_id = ?', [correctionId]);
  if (existing) return { skipped: true, adjustment_id: existing.adjustment_id };
  const [[batch]] = await executor.execute(`SELECT * FROM ${def.batchTable} WHERE ${def.batchPk} = ?`, [log.locked_batch_id]);
  if (!batch || batch.status !== 'Paid') return { skipped: true };

  let delta;
  try {
    delta = personType === 'Worker'
      ? await computeWorkerDelta(executor, log, batch[def.batchPk])
      : await computeStaffDelta(executor, log, batch);
  } catch (error) {
    if (error && error.isOperational) return { error: error.message, code: error.code };
    throw error;
  }

  const currency = String(batch.currency || def.defaultCurrency).toUpperCase();
  if (Math.abs(delta.amount) < 0.005) {
    await executor.execute(
      `UPDATE attendance_corrections_log SET adjustment_status = 'Resolved', resolved_by_user_id = ?, resolved_at = NOW(),
              resolution_note = ? WHERE correction_id = ?`,
      [userId, `No pay difference (recomputed: ${delta.before} -> ${delta.after} ${currency}).`, correctionId]);
    return { amount: 0, currency, before: delta.before, after: delta.after };
  }
  const status = delta.amount < 0 ? 'AwaitingConfirmation' : 'Pending';
  const [ins] = await executor.execute(
    `INSERT INTO payroll_adjustments
       (person_type, person_id, source, correction_id, origin_batch_id, origin_date, currency, amount,
        before_amount, after_amount, calc_detail, reason, status, created_by_user_id, created_at)
     VALUES (?, ?, 'Correction', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [personType, log.person_id, correctionId, log.locked_batch_id, String(log.record_date).slice(0, 10), currency,
      delta.amount.toFixed(2), delta.before.toFixed(2), delta.after.toFixed(2), JSON.stringify(delta.detail),
      String(log.reason || '').slice(0, 1000), status, userId]);
  await executor.execute(
    `UPDATE attendance_corrections_log SET adjustment_status = 'Resolved', resolved_by_user_id = ?, resolved_at = NOW(),
            resolution_note = ? WHERE correction_id = ?`,
    [userId, `Payroll adjustment #${ins.insertId}: ${delta.amount > 0 ? '+' : ''}${delta.amount.toFixed(2)} ${currency} (${status}).`, correctionId]);
  await audit(executor, ins.insertId, 'ADJUSTMENT_CREATED', userId, null,
    { source: 'Correction', correction_id: correctionId, person_type: personType, person_id: log.person_id, amount: delta.amount, currency, status });
  return { adjustment_id: ins.insertId, amount: delta.amount, currency, status, before: delta.before, after: delta.after };
}

// Batch marked Paid: corrections made while it was only finalized were not in
// the paid amount -> turn them into adjustments now.
async function convertOpenCorrectionsForPaidBatch(executor, personType, batchId, userId) {
  const def = typeDef(personType);
  const [logs] = await executor.execute(
    `SELECT correction_id FROM attendance_corrections_log
     WHERE locked_batch_table = ? AND locked_batch_id = ? AND adjustment_status = 'Open' AND payroll_effect = 'AdjustmentRequired'
     ORDER BY correction_id`, [def.batchTable, batchId]);
  const results = [];
  for (const l of logs) results.push({ correction_id: l.correction_id, ...(await createFromCorrection(executor, l.correction_id, userId)) });
  return results;
}

// A finalized batch was superseded: the replacement is generated from the
// corrected attendance, so its Open corrections are settled by it.
async function resolveCorrectionsSuperseded(executor, personType, oldBatchIds, newBatchId, userId) {
  const def = typeDef(personType);
  const ids = (oldBatchIds || []).map(Number).filter((n) => n > 0);
  if (!ids.length) return 0;
  const [r] = await executor.query(
    `UPDATE attendance_corrections_log SET adjustment_status = 'Resolved', resolved_by_user_id = ?, resolved_at = NOW(),
            resolution_note = ?
     WHERE locked_batch_table = ? AND locked_batch_id IN (?) AND adjustment_status = 'Open'`,
    [userId, `Included in replacement batch #${newBatchId} (supersede).`, def.batchTable, ids]);
  return r.affectedRows;
}

// ---------------------------------------------------------------------------
// Batch hooks
// ---------------------------------------------------------------------------
// Pending adjustments of the given people, locked, grouped by person.
async function loadPendingForPeople(executor, personType, personIds, currency) {
  const ids = [...new Set((personIds || []).map(Number).filter((n) => n > 0))];
  const byPerson = new Map();
  if (!ids.length) return byPerson;
  const [rows] = await executor.query(
    `SELECT adjustment_id, person_id, amount FROM payroll_adjustments
     WHERE person_type = ? AND status = 'Pending' AND currency = ? AND person_id IN (?)
     ORDER BY adjustment_id FOR UPDATE`, [personType, currency, ids]);
  for (const r of rows) {
    if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, { total: 0, ids: [] });
    const e = byPerson.get(r.person_id);
    e.total = money(e.total + Number(r.amount));
    e.ids.push(r.adjustment_id);
  }
  return byPerson;
}

async function markIncluded(executor, adjustmentIds, batchId) {
  if (!adjustmentIds.length) return;
  await executor.query(
    `UPDATE payroll_adjustments SET status = 'Included', included_batch_id = ? WHERE adjustment_id IN (?) AND status = 'Pending'`,
    [batchId, adjustmentIds]);
}

// Voided / superseded batch: what it carried goes back to Pending.
async function releaseBatches(executor, personType, batchIds) {
  const ids = (batchIds || []).map(Number).filter((n) => n > 0);
  if (!ids.length) return 0;
  const [r] = await executor.query(
    `UPDATE payroll_adjustments SET status = 'Pending', included_batch_id = NULL
     WHERE person_type = ? AND status = 'Included' AND included_batch_id IN (?)`, [personType, ids]);
  return r.affectedRows;
}

async function applyBatch(executor, personType, batchId) {
  const [r] = await executor.execute(
    `UPDATE payroll_adjustments SET status = 'Applied', applied_at = NOW()
     WHERE person_type = ? AND status = 'Included' AND included_batch_id = ?`, [personType, batchId]);
  return r.affectedRows;
}

async function listForBatch(executor, personType, batchId) {
  const def = typeDef(personType);
  const [rows] = await executor.execute(
    `SELECT pa.adjustment_id, pa.person_id, p.${def.codeCol} AS person_code, p.full_name, pa.source, pa.correction_id,
            pa.origin_batch_id, DATE_FORMAT(pa.origin_date, '%Y-%m-%d') AS origin_date, pa.currency, pa.amount,
            pa.before_amount, pa.after_amount, pa.reason, pa.status, u.full_name AS created_by,
            DATE_FORMAT(pa.created_at, '%Y-%m-%d %H:%i') AS created_at
     FROM payroll_adjustments pa
     JOIN ${def.personTable} p ON p.${def.personCol} = pa.person_id
     JOIN users u ON u.user_id = pa.created_by_user_id
     WHERE pa.person_type = ? AND pa.included_batch_id = ? AND pa.status IN ('Included','Applied')
     ORDER BY p.full_name, pa.adjustment_id`, [personType, batchId]);
  return rows;
}

// Is there a not-finalized active batch covering this date (hint only)?
async function openBatchHint(executor, personType, { date, siteId = null, personId = null }) {
  if (personType === 'Worker') {
    const [[b]] = await executor.execute(
      `SELECT payroll_batch_id AS batch_id FROM payrollbatches
       WHERE status = 'Generated' AND is_finalized = 0 AND start_date <= ? AND end_date >= ?
         AND ((batch_type = 'Regular' AND (scope_site_id IS NULL OR scope_site_id = ?))
              OR (batch_type = 'OffCycle' AND scope_worker_id = ?))
       ORDER BY payroll_batch_id DESC LIMIT 1`, [date, date, siteId, personId]);
    return b ? { action: 'regenerate', batch_id: b.batch_id,
      message: `Payroll batch #${b.batch_id} (not finalized) covers this date: void it and generate the period again so it uses the corrected attendance.` } : null;
  }
  const [[b]] = await executor.execute(
    `SELECT staff_payroll_batch_id AS batch_id FROM staff_payroll_batches
     WHERE status = 'Generated' AND is_finalized = 0 AND start_date <= ? AND end_date >= ?
     ORDER BY staff_payroll_batch_id DESC LIMIT 1`, [date, date]);
  return b ? { action: 'regenerate', batch_id: b.batch_id,
    message: `Staff payroll batch #${b.batch_id} (not finalized) covers this date: void it and generate the period again so it uses the corrected attendance.` } : null;
}

// Hint for a correction saved on a FINALIZED (unpaid) batch.
function finalizedHint(batchId) {
  return { action: 'supersede', batch_id: batchId,
    message: `Payroll batch #${batchId} is finalized (not paid): use "Correct (supersede)" on it to include this correction. ` +
      'If it is marked Paid instead, the difference becomes a payroll adjustment automatically.' };
}

// ---------------------------------------------------------------------------
// Admin API helpers
// ---------------------------------------------------------------------------
async function createManual({ personType, personId, amount, reason, userId }) {
  const def = typeDef(personType);
  const id = Number(personId);
  const value = Number(amount);
  const why = String(reason || '').trim();
  if (!Number.isInteger(id) || id <= 0) throw new AdjError('Choose a person.');
  if (!Number.isFinite(value) || Math.abs(value) < 0.01) throw new AdjError('Enter a non-zero amount.');
  if (Math.abs(value) > 1e10) throw new AdjError('Amount is too large.');
  if (why.length < 5) throw new AdjError('A reason (at least 5 characters) is required.');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [[p]] = await connection.execute(`SELECT ${def.personCol} AS id FROM ${def.personTable} WHERE ${def.personCol} = ?`, [id]);
    if (!p) throw new AdjError(`${personType} not found.`, 404);
    const currency = String(await settingsCache.getSetting(def.currencySetting, def.defaultCurrency) || def.defaultCurrency).toUpperCase();
    const amt = money(value);
    const status = amt < 0 ? 'AwaitingConfirmation' : 'Pending';
    const [ins] = await connection.execute(
      `INSERT INTO payroll_adjustments
         (person_type, person_id, source, currency, amount, reason, status, created_by_user_id, created_at)
       VALUES (?, ?, 'Manual', ?, ?, ?, ?, ?, NOW())`,
      [personType, id, currency, amt.toFixed(2), why.slice(0, 1000), status, userId]);
    await audit(connection, ins.insertId, 'ADJUSTMENT_CREATED', userId, null,
      { source: 'Manual', person_type: personType, person_id: id, amount: amt, currency, status, reason: why });
    await connection.commit();
    return { adjustment_id: ins.insertId, status, currency, amount: amt };
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function changeStatus(rawId, action, { reason, userId }) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new AdjError('Invalid id.');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [[a]] = await connection.execute('SELECT * FROM payroll_adjustments WHERE adjustment_id = ? FOR UPDATE', [id]);
    if (!a) throw new AdjError('Adjustment not found.', 404);
    if (action === 'confirm') {
      if (a.status !== 'AwaitingConfirmation') throw new AdjError(`Only an adjustment awaiting confirmation can be confirmed (this one is ${a.status}).`, 409);
      await connection.execute(
        `UPDATE payroll_adjustments SET status = 'Pending', confirmed_by_user_id = ?, confirmed_at = NOW() WHERE adjustment_id = ?`, [userId, id]);
      await audit(connection, id, 'ADJUSTMENT_CONFIRMED', userId, { status: a.status }, { status: 'Pending' });
    } else if (action === 'cancel') {
      const why = String(reason || '').trim();
      if (why.length < 5) throw new AdjError('A reason (at least 5 characters) is required.');
      if (!['Pending', 'AwaitingConfirmation'].includes(a.status)) {
        throw new AdjError(a.status === 'Included'
          ? `It is already in batch #${a.included_batch_id}: void that batch first, or keep it.`
          : `A ${a.status} adjustment cannot be cancelled.`, 409);
      }
      await connection.execute(
        `UPDATE payroll_adjustments SET status = 'Cancelled', cancelled_by_user_id = ?, cancelled_at = NOW(), cancel_reason = ?
         WHERE adjustment_id = ?`, [userId, why.slice(0, 500), id]);
      await audit(connection, id, 'ADJUSTMENT_CANCELLED', userId, { status: a.status }, { status: 'Cancelled', reason: why });
    } else {
      throw new AdjError('Unknown action.');
    }
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function list({ status, personType } = {}) {
  const where = [];
  const params = [];
  if (['AwaitingConfirmation', 'Pending', 'Included', 'Applied', 'Cancelled'].includes(status)) { where.push('pa.status = ?'); params.push(status); }
  if (['Worker', 'Staff'].includes(personType)) { where.push('pa.person_type = ?'); params.push(personType); }
  const [rows] = await db.execute(
    `SELECT pa.adjustment_id, pa.person_type, pa.person_id,
            COALESCE(w.full_name, sm.full_name) AS full_name, COALESCE(w.worker_unique_id, sm.staff_unique_id) AS person_code,
            pa.source, pa.correction_id, pa.origin_batch_id, DATE_FORMAT(pa.origin_date, '%Y-%m-%d') AS origin_date,
            pa.currency, pa.amount, pa.before_amount, pa.after_amount, pa.calc_detail, pa.reason, pa.status,
            pa.included_batch_id, u.full_name AS created_by, DATE_FORMAT(pa.created_at, '%Y-%m-%d %H:%i') AS created_at,
            cu.full_name AS cancelled_by, pa.cancel_reason, DATE_FORMAT(pa.applied_at, '%Y-%m-%d %H:%i') AS applied_at
     FROM payroll_adjustments pa
     LEFT JOIN workers w ON pa.person_type = 'Worker' AND w.worker_id = pa.person_id
     LEFT JOIN staff_members sm ON pa.person_type = 'Staff' AND sm.staff_id = pa.person_id
     JOIN users u ON u.user_id = pa.created_by_user_id
     LEFT JOIN users cu ON cu.user_id = pa.cancelled_by_user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY FIELD(pa.status, 'AwaitingConfirmation', 'Pending', 'Included', 'Applied', 'Cancelled'), pa.adjustment_id DESC
     LIMIT 1000`, params);
  return rows;
}

// Open corrections that never got an amount (computed before this feature, or
// the computation failed): recompute now (Admin action, one at a time).
async function retryCorrection(correctionId, userId) {
  const id = Number(correctionId);
  if (!Number.isInteger(id) || id <= 0) throw new AdjError('Invalid id.');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await createFromCorrection(connection, id, userId);
    if (result.error) throw new AdjError(result.error, 422, result.code);
    if (result.skipped) throw new AdjError('This correction does not need an adjustment (not open, or its batch is not Paid).', 409);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function listOpenCorrections() {
  const [rows] = await db.execute(
    `SELECT c.correction_id, c.record_table, c.person_id, COALESCE(w.full_name, sm.full_name) AS full_name,
            DATE_FORMAT(c.record_date, '%Y-%m-%d') AS record_date, c.reason, c.locked_batch_table, c.locked_batch_id,
            COALESCE(pb.status, spb.status) AS batch_status
     FROM attendance_corrections_log c
     LEFT JOIN workers w ON c.record_table = 'attendance' AND w.worker_id = c.person_id
     LEFT JOIN staff_members sm ON c.record_table = 'staff_attendance' AND sm.staff_id = c.person_id
     LEFT JOIN payrollbatches pb ON c.locked_batch_table = 'payrollbatches' AND pb.payroll_batch_id = c.locked_batch_id
     LEFT JOIN staff_payroll_batches spb ON c.locked_batch_table = 'staff_payroll_batches' AND spb.staff_payroll_batch_id = c.locked_batch_id
     WHERE c.adjustment_status = 'Open'
     ORDER BY c.correction_id DESC LIMIT 500`);
  return rows;
}

// Excel: one "Adjustments" sheet listing what the batch carries (already
// inside each person's net). Nothing is added when the batch carries none.
function addAdjustmentsSheet(workbook, adjustments, moneyFmt, sheetName = 'Adjustments') {
  if (!adjustments || !adjustments.length) return null;
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = [
    { header: 'No.', key: 'n', width: 6 },
    { header: 'ID', key: 'code', width: 14 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Original date', key: 'date', width: 14 },
    { header: 'Paid batch', key: 'origin', width: 11 },
    { header: 'Before', key: 'before', width: 14 },
    { header: 'After', key: 'after', width: 14 },
    { header: 'Adjustment', key: 'amount', width: 16 },
    { header: 'Source', key: 'source', width: 11 },
    { header: 'Reason', key: 'reason', width: 44 },
    { header: 'Created by', key: 'by', width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  let total = 0;
  adjustments.forEach((a, i) => {
    const row = sheet.addRow({
      n: i + 1, code: a.person_code, name: a.full_name, date: a.origin_date || '', origin: a.origin_batch_id ? `#${a.origin_batch_id}` : '',
      before: a.before_amount === null ? null : Number(a.before_amount), after: a.after_amount === null ? null : Number(a.after_amount),
      amount: Number(a.amount), source: a.source, reason: a.reason, by: a.created_by,
    });
    ['before', 'after', 'amount'].forEach((k) => { row.getCell(k).numFmt = moneyFmt; });
    row.getCell('reason').alignment = { wrapText: true, vertical: 'top' };
    total = money(total + Number(a.amount));
  });
  const t = sheet.addRow({ name: 'TOTAL ADJUSTMENTS (included in the net pay)', amount: total });
  t.font = { bold: true };
  t.getCell('amount').numFmt = moneyFmt;
  return sheet;
}

function sendError(res, error, fallback) {
  if (error && error.isOperational) {
    return res.status(error.statusCode || 400).json({ status: 'error', ...(error.code ? { code: error.code } : {}), message: error.message });
  }
  console.error(fallback, error);
  return res.status(500).json({ status: 'error', message: fallback });
}

module.exports = {
  AdjError, TYPES, money,
  workerDayPay, computeWorkerDelta, computeStaffDelta,
  createFromCorrection, convertOpenCorrectionsForPaidBatch, resolveCorrectionsSuperseded,
  loadPendingForPeople, markIncluded, releaseBatches, applyBatch, listForBatch,
  openBatchHint, finalizedHint,
  createManual, changeStatus, list, retryCorrection, listOpenCorrections, sendError, addAdjustmentsSheet,
};
