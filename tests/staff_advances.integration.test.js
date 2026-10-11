// tests/staff_advances.integration.test.js
//
// Staff salary advances — HTTP integration tests against the real controllers
// and a local MySQL 8 database. Run: node --test tests/staff_advances.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const ExcelJS = require('exceljs');
const { resetDatabase, startServer, stopServer, client, q, token } = require('./helpers');
const { businessToday, addDays } = require('../services/businessDate');

const TODAY = businessToday();
const M = TODAY.slice(0, 7);                       // current month (deductions can start here)
const addMonths = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
};
const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const M1 = addMonths(M, 1);
const PREV = addMonths(M, -1);
const PERIOD = { start_date: `${M}-01`, end_date: TODAY, acknowledge_pending: true };       // current month to date
const PREV_PERIOD = { start_date: `${PREV}-01`, end_date: lastDay(PREV), acknowledge_pending: true };
const admin = () => client(1, 'Admin');
const sup = () => client(11, 'Supervisor');
let base;
const S = {};

async function addStaff(id, { status = 'Active', salary = 1000 } = {}) {
  await q(`INSERT INTO staff_members (staff_id, staff_unique_id, full_name, position, site_id, hire_date, first_hire_date,
                                      monthly_salary, standard_daily_hours, status)
           VALUES (?, ?, ?, 'Engineer', 9, '2026-08-01', '2026-08-01', ?, 8, ?)`, [id, `S-${id}`, `Staff ${id}`, salary, status]);
  await q(`INSERT INTO staff_status_history (staff_id, old_status, new_status, effective_date, reason)
           VALUES (?, NULL, 'Active', '2026-08-01', 'hire')`, [id]);
  if (status !== 'Active') {
    await q(`INSERT INTO staff_status_history (staff_id, old_status, new_status, effective_date, reason)
             VALUES (?, 'Active', ?, '2026-09-01', 'test')`, [id, status]);
  }
}
async function addAttendance(staffId, from, to) {
  for (let ds = from; ds <= to; ds = addDays(ds, 1)) {
    if (new Date(`${ds}T00:00:00Z`).getUTCDay() === 5) continue; // Friday
    await q(`INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, check_out_time,
                                           regular_hours, overtime_hours, status, recorded_by_user_id, standard_minutes_snapshot)
             VALUES (?, ?, 'Present', ?, ?, 8, 0, 'Approved', 14, 480)`, [staffId, ds, `${ds} 08:00:00`, `${ds} 16:00:00`]);
  }
}
async function openReport(staffId) {
  const r = await admin().post('/api/staff-advances/financial-report', { staff_id: staffId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.report_id;
}
async function createAdvance(staffId, amount, schedule, extra = {}) {
  const reportId = extra.financial_report_id ?? await openReport(staffId);
  return admin().post('/api/staff-advances', {
    staff_id: staffId, amount, schedule, reason: 'Family emergency', financial_report_id: reportId, ...extra,
  });
}
const line = async (batchId, staffId) => (await q(
  'SELECT * FROM staff_payroll WHERE staff_payroll_batch_id = ? AND staff_id = ?', [batchId, staffId]))[0];
const batch = async (batchId) => (await q('SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ?', [batchId]))[0];
const advance = async (id) => (await q('SELECT * FROM staff_advances WHERE advance_id = ?', [id]))[0];
const installments = async (id) => q('SELECT * FROM staff_advance_installments WHERE advance_id = ? ORDER BY seq', [id]);
async function getBytes(path) {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token(1, 'Admin')}` } });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}
// Text drawn by pdfkit with the standard fonts: inflate every stream and decode the TJ hex strings.
function pdfText(bytes) {
  const s = bytes.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    let body;
    try { body = zlib.inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1'); } catch (_) { continue; }
    for (const tj of body.matchAll(/\[(.*?)\]\s*TJ/g)) {
      for (const h of tj[1].matchAll(/<([0-9a-fA-F]*)>/g)) out += Buffer.from(h[1], 'hex').toString('latin1');
      out += '\n';
    }
  }
  return out;
}

test.before(async () => {
  resetDatabase({ migrate: true });
  base = await startServer();
  await q("INSERT INTO system_settings (setting_key, setting_value) VALUES ('attendance_daily_gate_enabled', 'false') ON DUPLICATE KEY UPDATE setting_value = 'false'");
  await require('../services/settingsCache').refresh();
  for (const id of [2, 3, 4, 5, 6, 7]) await addStaff(id);
  await addStaff(8, { status: 'Inactive' });
  for (const id of [1, 2, 3, 5]) await addAttendance(id, `${M}-01`, TODAY);
  await addAttendance(1, `${PREV}-01`, lastDay(PREV));
});
test.after(async () => { await stopServer(); });

test('SA1 financial report: Admin only, saved as a snapshot, months and PDF', async () => {
  assert.equal((await sup().post('/api/staff-advances/financial-report', { staff_id: 2 })).status, 403);
  assert.equal((await sup().get('/api/staff-advances')).status, 403);
  const r = await admin().post('/api/staff-advances/financial-report', { staff_id: 2 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = r.body.data;
  assert.ok(d.report_id > 0);
  assert.equal(d.staff.staff_unique_id, 'S-2');
  assert.equal(d.currency, 'USD');
  assert.equal(d.months.length, 12);
  assert.equal(d.months[0].month, M);
  assert.equal(d.can_create, true);
  assert.equal(d.current_month.available, true, JSON.stringify(d.current_month));
  assert.ok(d.current_month.net_salary > 0);
  const [row] = await q('SELECT staff_id FROM staff_financial_reports WHERE report_id = ?', [d.report_id]);
  assert.equal(row.staff_id, 2);
  const pdf = await getBytes(`/api/staff-advances/financial-report/${d.report_id}.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.bytes.slice(0, 4).toString(), '%PDF');
  assert.match(pdfText(pdf.bytes), /STAFF FINANCIAL REPORT/);
  const inactive = await admin().post('/api/staff-advances/financial-report', { staff_id: 8 });
  assert.equal(inactive.body.data.can_create, false);
});

test('SA2 create validation: report required, schedule rules, active staff only', async () => {
  const noReport = await admin().post('/api/staff-advances', { staff_id: 2, amount: 100, schedule: [{ month: M, amount: 100 }], reason: 'Family emergency' });
  assert.equal(noReport.status, 400);
  assert.equal(noReport.body.code, 'FINANCIAL_REPORT_REQUIRED');
  const r2 = await openReport(2);
  const wrongStaff = await createAdvance(3, 100, [{ month: M, amount: 100 }], { financial_report_id: r2 });
  assert.equal(wrongStaff.body.code, 'FINANCIAL_REPORT_MISMATCH');
  assert.equal((await createAdvance(2, 100, [{ month: M, amount: 90 }], { financial_report_id: r2 })).body.code, 'SCHEDULE_TOTAL_MISMATCH');
  assert.equal((await createAdvance(2, 100, [{ month: PREV, amount: 100 }], { financial_report_id: r2 })).body.code, 'MONTH_IN_PAST');
  assert.equal((await createAdvance(2, 100, [{ month: M, amount: 50 }, { month: M, amount: 50 }], { financial_report_id: r2 })).body.code, 'DUPLICATE_MONTH');
  assert.equal((await createAdvance(2, 100, [], { financial_report_id: r2 })).body.code, 'SCHEDULE_REQUIRED');
  assert.equal((await createAdvance(2, 100, [{ month: M, amount: 100 }], { financial_report_id: r2, reason: 'x' })).body.code, 'REASON_REQUIRED');
  assert.equal((await createAdvance(8, 100, [{ month: M, amount: 100 }])).body.code, 'STAFF_NOT_ACTIVE');
  await q('UPDATE staff_financial_reports SET generated_at = DATE_SUB(NOW(), INTERVAL 31 MINUTE) WHERE report_id = ?', [r2]);
  assert.equal((await createAdvance(2, 100, [{ month: M, amount: 100 }], { financial_report_id: r2 })).body.code, 'FINANCIAL_REPORT_EXPIRED');
  assert.equal(Number((await q('SELECT COUNT(*) c FROM staff_advances'))[0].c), 0, 'nothing created');
});

test('SA3 full advance: unique voucher, ledger, idempotency, one open advance, report used once', async () => {
  const reportId = await openReport(2);
  const r = await createAdvance(2, 300, [{ month: M, amount: 300 }], { financial_report_id: reportId, idempotency_key: 'key-sa3' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = r.body.data;
  S.a2 = a.advance_id;
  assert.match(a.voucher_no, new RegExp(`^ADV-${TODAY.slice(0, 4)}-\\d{6}$`));
  assert.equal(a.deduction_mode, 'Full');
  assert.equal(a.status, 'Active');
  assert.equal(a.outstanding_balance, 300);
  assert.equal(a.can_cancel_window, true);
  assert.ok(a.cancel_seconds_left > 71 * 3600);
  assert.deepEqual(a.installments.map((i) => [i.deduction_month, i.amount, i.status]), [[M, 300, 'Scheduled']]);
  assert.deepEqual(a.ledger.map((l) => [l.entry_type, l.amount]), [['Disbursement', 300]]);
  // Double click: same idempotency key -> the same advance, nothing new.
  const again = await createAdvance(2, 300, [{ month: M, amount: 300 }], { financial_report_id: reportId, idempotency_key: 'key-sa3' });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.data.voucher_no, a.voucher_no);
  assert.equal(Number((await q('SELECT COUNT(*) c FROM staff_advances'))[0].c), 1);
  // One open advance per staff member; a report is used once.
  assert.equal((await createAdvance(2, 50, [{ month: M1, amount: 50 }])).body.code, 'OPEN_ADVANCE_EXISTS');
  assert.equal((await createAdvance(2, 50, [{ month: M1, amount: 50 }], { financial_report_id: reportId })).body.code, 'FINANCIAL_REPORT_USED');
  const audit = await q("SELECT * FROM auditlogs WHERE table_name = 'staff_advances' AND record_id = ? AND action_type = 'ADVANCE_CREATED'", [S.a2]);
  assert.equal(audit.length, 1);
});

test('SA4 voucher numbers are unique under concurrency and never reused', async () => {
  const svc = require('../services/staffAdvanceService');
  const db = require('../config/db');
  await svc.ensureDocumentSequence('TST');
  const numbers = await Promise.all(Array.from({ length: 12 }, async () => {
    const c = await db.getConnection();
    try {
      await c.beginTransaction();
      const n = await svc.nextDocumentNumber(c, 'TST');
      await c.commit();
      return n;
    } finally { c.release(); }
  }));
  assert.equal(new Set(numbers).size, 12);
  // Parallel API creates for different staff: every voucher different.
  const [r6, r7] = await Promise.all([openReport(6), openReport(7)]);
  const made = await Promise.all([
    createAdvance(6, 40, [{ month: M1, amount: 40 }], { financial_report_id: r6 }),
    createAdvance(7, 40, [{ month: M1, amount: 40 }], { financial_report_id: r7 }),
  ]);
  made.forEach((m) => assert.equal(m.status, 201, JSON.stringify(m.body)));
  S.a6 = made[0].body.data.advance_id;
  S.a7 = made[1].body.data.advance_id;
  const vouchers = (await q('SELECT voucher_no FROM staff_advances')).map((r) => r.voucher_no);
  assert.equal(new Set(vouchers).size, vouchers.length);
  // The database itself refuses a duplicate voucher number.
  await assert.rejects(q(`INSERT INTO staff_advances (voucher_no, staff_id, currency, amount, deduction_mode, reason, financial_report_id,
                                                      status, outstanding_balance, cancel_deadline, created_by_user_id, created_at)
                          SELECT voucher_no, 5, 'USD', 1, 'Full', 'dup', ?, 'Active', 1, NOW(), 1, NOW() FROM staff_advances WHERE advance_id = ?`,
  [await openReport(5), S.a2]), /Duplicate entry/);
});

test('SA5 partial advance over two months', async () => {
  const r = await createAdvance(3, 500, [{ month: M1, amount: 300 }, { month: M, amount: 200 }]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  S.a3 = r.body.data.advance_id;
  assert.equal(r.body.data.deduction_mode, 'Partial');
  assert.deepEqual(r.body.data.installments.map((i) => [i.deduction_month, i.amount]), [[M, 200], [M1, 300]]);
});

test('SA6 the chosen month carries the deduction: net, total, details, Excel and PDF show the voucher', async () => {
  const g = await admin().post('/api/staff-payroll/generate', PERIOD);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  S.b1 = g.body.batch_id;
  assert.equal(g.body.advances_deducted, 2);
  const l2 = await line(S.b1, 2);
  const l3 = await line(S.b1, 3);
  const l1 = await line(S.b1, 1);
  assert.equal(Number(l2.advance_deduction_amount), 300);
  assert.equal(Number(l3.advance_deduction_amount), 200);
  assert.equal(Number(l1.advance_deduction_amount), 0);
  assert.equal(Number(l2.net_salary), Number(l1.net_salary) - 300, 'same pay, minus the advance');
  const nets = (await q('SELECT SUM(net_salary) s FROM staff_payroll WHERE staff_payroll_batch_id = ?', [S.b1]))[0].s;
  assert.equal(Number((await batch(S.b1)).total_amount), Number(nets));
  assert.deepEqual((await installments(S.a3)).map((i) => [i.deduction_month, i.status]), [[M, 'Included'], [M1, 'Scheduled']]);
  // The other months' advances (staff 6, 7 in M+1) are untouched.
  assert.equal((await installments(S.a6))[0].status, 'Scheduled');

  const det = await admin().get(`/api/staff-payroll/batch/${S.b1}`);
  assert.equal(det.status, 200);
  assert.equal(det.body.advances.length, 2);
  assert.equal(det.body.advances_total, 500);
  const v2 = (await advance(S.a2)).voucher_no;
  assert.equal(det.body.staff.find((s) => s.staff_id === 2).advances[0].voucher_no, v2);

  const x = await getBytes(`/api/staff-payroll/batch/${S.b1}/export.xlsx`);
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.bytes);
  const sheet = wb.getWorksheet('Advances');
  assert.ok(sheet, 'Advances sheet');
  const vouchers = [];
  sheet.eachRow((row, n) => { if (n > 1) vouchers.push(row.getCell(2).value); });
  assert.ok(vouchers.includes(v2));
  const main = wb.getWorksheet('Staff Payroll');
  let found = false;
  main.eachRow((row) => { row.eachCell((c) => { if (String(c.value) === v2) found = true; }); });
  assert.ok(found, 'voucher number on the staff row');

  const pdf = await getBytes(`/api/staff-payroll/batch/${S.b1}/export.pdf`);
  assert.equal(pdf.status, 200);
  const text = pdfText(pdf.bytes);
  assert.ok(text.includes(v2), 'voucher number printed in the batch PDF');
  assert.match(text, /ADVANCES DEDUCTED IN THIS BATCH/);
});

test('SA7 cancel within 72h restores everything exactly (net, batch total, schedule) and keeps the record', async () => {
  const before = await line(S.b1, 2);
  const totalBefore = Number((await batch(S.b1)).total_amount);
  const voucher = (await advance(S.a2)).voucher_no;
  assert.equal((await admin().post(`/api/staff-advances/${S.a2}/cancel`, { reason: 'x' })).status, 400, 'reason required');
  const c = await admin().post(`/api/staff-advances/${S.a2}/cancel`, { reason: 'Entered for the wrong person' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(c.body.reversed, [{ batch_id: S.b1, amount: 300 }]);
  const after = await line(S.b1, 2);
  assert.equal(Number(after.advance_deduction_amount), 0);
  assert.equal(Number(after.net_salary), Number(before.net_salary) + 300);
  assert.equal(Number((await batch(S.b1)).total_amount), totalBefore + 300);
  const a = await advance(S.a2);
  assert.deepEqual([a.status, Number(a.outstanding_balance), a.voucher_no], ['Cancelled', 0, voucher], 'record and number kept');
  assert.deepEqual((await installments(S.a2)).map((i) => i.status), ['Cancelled']);
  const ledger = await q('SELECT entry_type, amount FROM staff_advance_ledger WHERE advance_id = ? ORDER BY entry_id', [S.a2]);
  assert.deepEqual(ledger.map((l) => [l.entry_type, Number(l.amount)]), [['Disbursement', 300], ['Cancellation', -300]]);
  // Proof that it is exactly as if the advance never existed: regenerate the period.
  const v = await admin().patch(`/api/staff-payroll/batch/${S.b1}/void`, { reason: 'check the restore' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual((await installments(S.a3)).map((i) => [i.deduction_month, i.status, i.included_batch_id]),
    [[M, 'Scheduled', null], [M1, 'Scheduled', null]], 'void puts the other advance back');
  const g = await admin().post('/api/staff-payroll/generate', PERIOD);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  S.b2 = g.body.batch_id;
  const fresh = await line(S.b2, 2);
  assert.equal(Number(fresh.net_salary), Number(after.net_salary));
  assert.equal(Number(fresh.advance_deduction_amount), 0);
  assert.equal(g.body.advances_deducted, 1, 'only staff 3 now');
  // Cancelled again? No.
  assert.equal((await admin().post(`/api/staff-advances/${S.a2}/cancel`, { reason: 'second time' })).body.code, 'NOT_ACTIVE');
  // The voucher still prints, marked cancelled.
  const pdf = await getBytes(`/api/staff-advances/${S.a2}/voucher.pdf`);
  assert.equal(pdf.status, 200);
  assert.ok(pdfText(pdf.bytes).includes(voucher));
});

test('SA8 cancel is refused (nothing changed) when the batch is finalized; Paid deducts for good', async () => {
  assert.equal((await admin().patch(`/api/staff-payroll/batch/${S.b2}/finalize`)).status, 200);
  const before = await line(S.b2, 3);
  const c = await admin().post(`/api/staff-advances/${S.a3}/cancel`, { reason: 'Changed my mind' });
  assert.equal(c.status, 409);
  assert.equal(c.body.code, 'SUPERSEDE_REQUIRED');
  assert.equal(c.body.batch_id, S.b2);
  assert.equal(Number((await line(S.b2, 3)).net_salary), Number(before.net_salary), 'nothing changed');
  assert.equal((await advance(S.a3)).status, 'Active');

  const paid = await admin().patch(`/api/staff-payroll/batch/${S.b2}/mark-paid`);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.advance_deductions_applied, 1);
  assert.deepEqual((await installments(S.a3)).map((i) => [i.deduction_month, i.status]), [[M, 'Deducted'], [M1, 'Scheduled']]);
  const a = await advance(S.a3);
  assert.deepEqual([a.status, Number(a.outstanding_balance)], ['Active', 300]);
  // Deducted -> cannot be cancelled any more.
  assert.equal((await admin().post(`/api/staff-advances/${S.a3}/cancel`, { reason: 'Too late now' })).body.code, 'ADVANCE_HAS_MOVEMENTS');
  // Paid month cannot be chosen any more.
  const months = await admin().get('/api/staff-advances/months');
  const m = months.body.data.find((x) => x.month === M);
  assert.deepEqual([m.paid, m.selectable], [true, false]);
  assert.equal((await createAdvance(5, 100, [{ month: M, amount: 100 }])).body.code, 'MONTH_PAID');
});

test('SA9 cancel window closes after 72 hours', async () => {
  await q('UPDATE staff_advances SET cancel_deadline = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE advance_id = ?', [S.a6]);
  const c = await admin().post(`/api/staff-advances/${S.a6}/cancel`, { reason: 'Too late to cancel' });
  assert.equal(c.status, 409);
  assert.equal(c.body.code, 'CANCEL_WINDOW_CLOSED');
  assert.equal((await advance(S.a6)).status, 'Active');
});

test('SA10 open balance blocks Inactive / Terminated and delete; repayment settles it', async () => {
  for (const newStatus of ['Inactive', 'Terminated']) {
    const r = await admin().patch('/api/staff/3/lifecycle', { new_status: newStatus, effective_date: TODAY, reason: 'Resigned' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'ADVANCE_OUTSTANDING');
    assert.match(r.body.message, new RegExp((await advance(S.a3)).voucher_no));
  }
  assert.equal((await q('SELECT status FROM staff_members WHERE staff_id = 3'))[0].status, 'Active');
  const check = await admin().get('/api/staff/3/deletion-check');
  assert.ok(check.body.data.blockers.some((b) => b.code === 'STAFF_ADVANCES'), JSON.stringify(check.body));

  assert.equal((await admin().post(`/api/staff-advances/${S.a3}/repay`, { amount: 400, reason: 'Cash payment' })).body.code, 'REPAY_TOO_MUCH');
  const p1 = await admin().post(`/api/staff-advances/${S.a3}/repay`, { amount: 100, reason: 'Cash payment one' });
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  assert.match(p1.body.receipt_no, new RegExp(`^RCP-${TODAY.slice(0, 4)}-\\d{6}$`));
  const p2 = await admin().post(`/api/staff-advances/${S.a3}/repay`, { amount: 200, reason: 'Cash payment two' });
  assert.equal(p2.status, 201);
  assert.notEqual(p1.body.receipt_no, p2.body.receipt_no);
  const a = await advance(S.a3);
  assert.deepEqual([a.status, Number(a.outstanding_balance)], ['Settled', 0]);
  // The paid batch still shows the balance right after ITS deduction (500 - 200), not today's.
  const det = await admin().get(`/api/staff-payroll/batch/${S.b2}`);
  assert.equal(det.body.advances[0].remaining_after, 300);
  const rc = await getBytes(`/api/staff-advances/${S.a3}/repayments/${p1.body.entry_id}/receipt.pdf`);
  assert.equal(rc.status, 200);
  assert.ok(pdfText(rc.bytes).includes(p1.body.receipt_no));
  const ok = await admin().patch('/api/staff/3/lifecycle', { new_status: 'Inactive', effective_date: TODAY, reason: 'Resigned' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // Settled advances still keep the person from being deleted (financial record).
  const check2 = await admin().get('/api/staff/3/deletion-check');
  assert.ok(check2.body.data.blockers.some((b) => b.code === 'STAFF_ADVANCES'));
});

test('SA11 pay too low: partial deduction + Unscheduled rest; not in batch: Unscheduled; void restores exactly', async () => {
  // Staff 1 (salary 1000) owes 1500 for the previous month; staff 4 (no attendance) owes 70.
  const r1 = await createAdvance(1, 1500, [{ month: M1, amount: 1500 }]);
  const r4 = await createAdvance(4, 70, [{ month: M1, amount: 70 }]);
  S.a1 = r1.body.data.advance_id;
  S.a4 = r4.body.data.advance_id;
  // Test hook: point both to the previous month (already ended, so its batch can be generated).
  await q('UPDATE staff_advance_installments SET deduction_month = ? WHERE advance_id IN (?, ?)', [PREV, S.a1, S.a4]);
  const g = await admin().post('/api/staff-payroll/generate', PREV_PERIOD);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  S.bPrev = g.body.batch_id;
  const l1 = await line(S.bPrev, 1);
  const calc = Number(l1.net_salary) + Number(l1.advance_deduction_amount);
  assert.ok(calc > 0 && calc < 1500);
  assert.equal(Number(l1.net_salary), 0, 'net never below 0');
  assert.equal(Number(l1.advance_deduction_amount), calc);
  const i1 = await installments(S.a1);
  assert.deepEqual(i1.map((i) => [i.status, Number(i.amount)]), [['Included', calc], ['Unscheduled', 1500 - calc]]);
  assert.equal((await installments(S.a4))[0].status, 'Unscheduled');
  assert.equal(g.body.advance_warnings.length, 2);
  // Void: everything back as before the batch.
  const v = await admin().patch(`/api/staff-payroll/batch/${S.bPrev}/void`, { reason: 'restore check' });
  assert.equal(v.status, 200);
  assert.deepEqual((await installments(S.a1)).map((i) => [i.deduction_month, i.status, Number(i.amount)]), [[PREV, 'Scheduled', 1500]]);
  assert.deepEqual((await installments(S.a4)).map((i) => [i.deduction_month, i.status, i.displaced_by_batch_id]), [[PREV, 'Scheduled', null]]);
  // Supersede also releases and re-carries.
  const g2 = await admin().post('/api/staff-payroll/generate', PREV_PERIOD);
  assert.equal(g2.status, 201);
  await admin().patch(`/api/staff-payroll/batch/${g2.body.batch_id}/finalize`);
  const s = await admin().post(`/api/staff-payroll/batch/${g2.body.batch_id}/new-version`, { reason: 'supersede check', acknowledge_pending: true });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const i2 = await installments(S.a1);
  assert.equal(i2.filter((i) => i.status === 'Included').length, 1);
  assert.equal(i2.find((i) => i.status === 'Included').included_batch_id, s.body.batch_id);
  assert.equal(i2.filter((i) => i.status === 'Unscheduled').length, 1, 'one remainder only (no duplicates)');
  assert.equal((await batch(g2.body.batch_id)).status, 'Superseded');
  // Clean up for the next test: void the replacement (not finalized).
  assert.equal((await admin().patch(`/api/staff-payroll/batch/${s.body.batch_id}/void`, { reason: 'clean up after test' })).status, 200);
  assert.deepEqual((await installments(S.a1)).map((i) => [i.status, Number(i.amount)]), [['Scheduled', 1500]]);
});

test('SA12 reschedule what is not in a batch, then write off', async () => {
  const bad = await admin().put(`/api/staff-advances/${S.a1}/schedule`, { schedule: [{ month: M1, amount: 1000 }], reason: 'New plan' });
  assert.equal(bad.body.code, 'SCHEDULE_TOTAL_MISMATCH');
  const r = await admin().put(`/api/staff-advances/${S.a1}/schedule`,
    { schedule: [{ month: M1, amount: 1000 }, { month: addMonths(M, 2), amount: 500 }], reason: 'Spread over two months' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = await installments(S.a1);
  assert.deepEqual(rows.map((i) => [i.deduction_month, i.status, Number(i.amount)]),
    [[PREV, 'Replaced', 1500], [M1, 'Scheduled', 1000], [addMonths(M, 2), 'Scheduled', 500]]);
  const w = await admin().post(`/api/staff-advances/${S.a1}/write-off`, { reason: 'Approved by management' });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const a = await advance(S.a1);
  assert.deepEqual([a.status, Number(a.outstanding_balance)], ['WrittenOff', 0]);
});

test('SA13 voucher prints: original then COPY, counted; list filters', async () => {
  const p1 = await getBytes(`/api/staff-advances/${S.a7}/voucher.pdf`);
  const p2 = await getBytes(`/api/staff-advances/${S.a7}/voucher.pdf`);
  assert.equal(p1.status, 200);
  assert.match(pdfText(p1.bytes), /ORIGINAL/);
  assert.match(pdfText(p2.bytes), /COPY 1/);
  assert.equal((await advance(S.a7)).voucher_print_count, 2);
  const list = await admin().get(`/api/staff-advances?status=Active&month=${M1}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.data.every((a) => a.status === 'Active'));
  assert.ok(list.body.data.some((a) => a.advance_id === S.a7));
  assert.ok(list.body.open_balance_by_currency.USD > 0);
  const byStaff = await admin().get('/api/staff-advances?staff_id=3');
  assert.deepEqual(byStaff.body.data.map((a) => a.advance_id), [S.a3]);
});
