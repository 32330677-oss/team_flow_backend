// tests/payroll_adjustments.integration.test.js
//
// Payroll adjustments (retro pay) for workers and staff — HTTP integration
// tests against the real controllers and a local MySQL 8 database.
// Run: node --test tests/payroll_adjustments.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { resetDatabase, startServer, stopServer, client, q, token } = require('./helpers');
const { businessToday, addDays } = require('../services/businessDate');

const TODAY = businessToday();
const admin = () => client(1, 'Admin');
const supDay = () => client(11, 'Supervisor');
const BASE = addDays(TODAY, -26); // after the seeded paid batch (2026-09-01..02)
const d = (n) => addDays(BASE, n);
let base;
const S = {};

async function addRecord(workerId, date, { hours = 10, out = '17:00', status = 'Approved', attendanceStatus = 'Present' } = {}) {
  const present = attendanceStatus === 'Present';
  const [r] = await require('../config/db').query(
    `INSERT INTO attendance (worker_id, site_id, shift_type, record_date, check_in_time, check_out_time, attendance_status,
                             total_working_hours, overtime_hours, recorded_by_user_id, status, standard_minutes_snapshot)
     VALUES (?, 8, 'Day', ?, ?, ?, ?, ?, 0, 11, ?, 600)`,
    [workerId, date, present ? `${date} 07:00:00` : null, present ? `${date} ${out}:00` : null,
      attendanceStatus, present ? hours : null, status]);
  return r.insertId;
}
async function workerPayroll(batchId, workerId = 1) {
  const [p] = await q('SELECT * FROM payroll WHERE payroll_batch_id = ? AND worker_id = ?', [batchId, workerId]);
  return p;
}
async function adj(id) {
  const [a] = await q('SELECT * FROM payroll_adjustments WHERE adjustment_id = ?', [id]);
  return a;
}
async function generate(start, end) {
  const g = await admin().post('/api/admin/payroll/generate', { start_date: start, end_date: end, acknowledge_pending: true });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  return g.body;
}
async function finalizeAndPay(batchId) {
  assert.equal((await admin().patch(`/api/admin/payroll/batch/${batchId}/finalize`)).status, 200);
  const p = await admin().patch(`/api/admin/payroll/batch/${batchId}/mark-paid`);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body;
}
async function getBytes(path) {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token(1, 'Admin')}` } });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

test.before(async () => {
  resetDatabase({ migrate: true });
  base = await startServer();
  await q("INSERT INTO system_settings (setting_key, setting_value) VALUES ('attendance_daily_gate_enabled', 'false') ON DUPLICATE KEY UPDATE setting_value = 'false'");
  await require('../services/settingsCache').refresh();
});
test.after(async () => { await stopServer(); });

// =========================== WORKERS ===========================
test('PA1 paid batch: a correction creates an automatic adjustment with the paid rates; the paid batch is unchanged', async () => {
  S.a0 = await addRecord(1, d(0), { hours: 6, out: '13:00' });
  await addRecord(1, d(1));
  await addRecord(1, d(2));
  const g = await generate(d(0), d(2));
  S.p1 = g.batch_id;
  assert.equal(Number((await workerPayroll(S.p1)).net_salary), 260000, '0.6 + 1 + 1 days x 100,000');
  await finalizeAndPay(S.p1);
  const paidTotal = (await q('SELECT total_amount FROM payrollbatches WHERE payroll_batch_id = ?', [S.p1]))[0].total_amount;

  const c = await admin().post(`/api/attendance/${S.a0}/admin-correction`,
    { reason: 'Management pays the missing hours', check_out_time: `${d(0)} 17:00:00` });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const pa = c.body.data.payroll_adjustment;
  assert.ok(pa && pa.adjustment_id, JSON.stringify(c.body));
  assert.equal(pa.before, 60000);
  assert.equal(pa.after, 100000);
  assert.equal(pa.amount, 40000);
  assert.equal(pa.status, 'Pending');
  assert.equal(pa.currency, 'SYP');
  assert.match(c.body.message, /\+40000\.00 SYP/);
  S.adj1 = pa.adjustment_id;
  const [log] = await q('SELECT adjustment_status, resolution_note FROM attendance_corrections_log WHERE correction_id = ?', [c.body.data.correction_id]);
  assert.equal(log.adjustment_status, 'Resolved');
  assert.match(log.resolution_note, new RegExp(`#${S.adj1}`));
  assert.equal((await q('SELECT total_amount FROM payrollbatches WHERE payroll_batch_id = ?', [S.p1]))[0].total_amount, paidTotal, 'paid batch unchanged');
  assert.equal(Number((await workerPayroll(S.p1)).net_salary), 260000);
});

test('PA2 next regular batch carries it: separate column, net = salary + adjustment, details / Excel / PDF show it', async () => {
  await addRecord(1, d(5));
  const g = await generate(d(5), d(5));
  S.p2 = g.batch_id;
  assert.equal(g.adjustments_included, 1);
  const p = await workerPayroll(S.p2);
  assert.equal(Number(p.gross_salary), 100000);
  assert.equal(Number(p.adjustments_amount), 40000);
  assert.equal(Number(p.net_salary), 140000);
  assert.equal(Number((await q('SELECT total_amount FROM payrollbatches WHERE payroll_batch_id = ?', [S.p2]))[0].total_amount), 140000);
  const a = await adj(S.adj1);
  assert.deepEqual([a.status, a.included_batch_id], ['Included', S.p2]);

  const det = await admin().get(`/api/admin/payroll/batch/${S.p2}`);
  assert.equal(det.status, 200);
  assert.equal(det.body.adjustments.length, 1);
  assert.equal(det.body.adjustments_total, 40000);
  assert.equal(det.body.workers[0].adjustments.length, 1);
  assert.equal(Number(det.body.workers[0].adjustments_amount), 40000);

  const x = await getBytes(`/api/admin/payroll/batch/${S.p2}/export.xlsx`);
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.bytes);
  const sheet = wb.getWorksheet('Adjustments');
  assert.ok(sheet, 'Adjustments sheet');
  assert.equal(Number(sheet.getRow(2).getCell(8).value), 40000);
  const pdf = await getBytes(`/api/admin/payroll/batch/${S.p2}/export.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.bytes.slice(0, 4).toString(), '%PDF');
});

test('PA3 void -> back to Pending; regenerate -> carried again; mark paid -> Applied (paid once only)', async () => {
  const v = await admin().patch(`/api/admin/payroll/batch/${S.p2}/void`, { reason: 'regenerate check' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.match(v.body.message, /Pending again/);
  assert.deepEqual([(await adj(S.adj1)).status, (await adj(S.adj1)).included_batch_id], ['Pending', null]);
  const g = await generate(d(5), d(5));
  S.p2b = g.batch_id;
  assert.equal((await adj(S.adj1)).included_batch_id, S.p2b);
  // regenerating the same (not finalized) period supersedes and moves it again
  const g2 = await generate(d(5), d(5));
  assert.equal((await adj(S.adj1)).included_batch_id, g2.batch_id);
  assert.equal((await q("SELECT status FROM payrollbatches WHERE payroll_batch_id = ?", [S.p2b]))[0].status, 'Superseded');
  S.p2b = g2.batch_id;
  const paid = await finalizeAndPay(S.p2b);
  assert.equal(paid.adjustments_applied, 1);
  const a = await adj(S.adj1);
  assert.equal(a.status, 'Applied');
  assert.ok(a.applied_at);
  // a later batch does not pay it again
  await addRecord(1, d(6));
  const g3 = await generate(d(6), d(6));
  assert.equal(Number((await workerPayroll(g3.batch_id)).adjustments_amount), 0);
  S.p3open = g3.batch_id;
});

test('PA4 not finalized batch: correction gives a "regenerate" hint and no adjustment', async () => {
  const [row] = await q('SELECT attendance_id FROM attendance WHERE worker_id = 1 AND record_date = ?', [d(6)]);
  const c = await admin().post(`/api/attendance/${row.attendance_id}/admin-correction`,
    { reason: 'Fix the checkout time', check_out_time: `${d(6)} 15:00:00` });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.data.payroll_adjustment, null);
  assert.deepEqual([c.body.data.payroll_hint.action, c.body.data.payroll_hint.batch_id], ['regenerate', S.p3open]);
  assert.equal((await q('SELECT COUNT(*) c FROM payroll_adjustments'))[0].c, 1);
  await admin().patch(`/api/admin/payroll/batch/${S.p3open}/void`, { reason: 'clean up test' });
});

test('PA5 finalized (unpaid): hint "supersede"; if it is marked Paid instead, the correction becomes an adjustment (negative -> awaits confirmation)', async () => {
  S.a8 = await addRecord(1, d(8));
  const g = await generate(d(8), d(8));
  S.p5 = g.batch_id;
  assert.equal((await admin().patch(`/api/admin/payroll/batch/${S.p5}/finalize`)).status, 200);
  const c = await admin().post(`/api/attendance/${S.a8}/admin-correction`,
    { reason: 'Left early, 5 hours only', check_out_time: `${d(8)} 12:00:00` });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.data.payroll_hint.action, 'supersede');
  assert.equal(c.body.data.payroll_adjustment, null);
  assert.match(c.body.message, /supersede/);

  const paid = await admin().patch(`/api/admin/payroll/batch/${S.p5}/mark-paid`);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.adjustments_created.length, 1);
  const a = await adj(paid.body.adjustments_created[0].adjustment_id);
  assert.equal(Number(a.amount), -50000);
  assert.equal(a.status, 'AwaitingConfirmation');
  S.neg = a.adjustment_id;
  // not carried until confirmed
  await addRecord(1, d(9));
  let g2 = await generate(d(9), d(9));
  assert.equal(Number((await workerPayroll(g2.batch_id)).adjustments_amount), 0);
  await admin().patch(`/api/admin/payroll/batch/${g2.batch_id}/void`, { reason: 'confirm first' });
  const conf = await admin().patch(`/api/payroll-adjustments/${S.neg}/confirm`);
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  g2 = await generate(d(9), d(9));
  const p = await workerPayroll(g2.batch_id);
  assert.deepEqual([Number(p.adjustments_amount), Number(p.net_salary)], [-50000, 50000]);
  await admin().patch(`/api/admin/payroll/batch/${g2.batch_id}/void`, { reason: 'release for the next test' });
});

test('PA6 finalized then superseded: the replacement includes the correction, the open item is resolved, no adjustment', async () => {
  const a = await addRecord(1, d(11), { hours: 6, out: '13:00' });
  const g = await generate(d(11), d(11));
  await admin().patch(`/api/admin/payroll/batch/${g.batch_id}/finalize`);
  const c = await admin().post(`/api/attendance/${a}/admin-correction`, { reason: 'Real checkout 17:00', check_out_time: `${d(11)} 17:00:00` });
  assert.equal(c.status, 200);
  const before = Number((await q('SELECT COUNT(*) c FROM payroll_adjustments'))[0].c);
  const s = await admin().post(`/api/admin/payroll/batch/${g.batch_id}/supersede`, { reason: 'include correction', acknowledge_pending: true });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const [log] = await q('SELECT adjustment_status, resolution_note FROM attendance_corrections_log WHERE correction_id = ?', [c.body.data.correction_id]);
  assert.equal(log.adjustment_status, 'Resolved');
  assert.match(log.resolution_note, /replacement batch/);
  assert.equal(Number((await q('SELECT COUNT(*) c FROM payroll_adjustments'))[0].c), before);
  // the pending -50,000 deduction is carried by this regular batch: 100,000 - 50,000
  const p = await workerPayroll(s.body.batch_id);
  assert.deepEqual([Number(p.gross_salary), Number(p.adjustments_amount)], [100000, -50000]);
  await admin().patch(`/api/admin/payroll/batch/${s.body.batch_id}/finalize`);
  await admin().patch(`/api/admin/payroll/batch/${s.body.batch_id}/mark-paid`);
  assert.equal((await adj(S.neg)).status, 'Applied');
});

test('PA7 manual adjustments: validation, Admin only, cancel, deductions larger than the pay stay Pending', async () => {
  assert.equal((await supDay().get('/api/payroll-adjustments')).status, 403);
  assert.equal((await admin().post('/api/payroll-adjustments', { person_type: 'Worker', person_id: 1, amount: 5000 })).status, 400, 'reason required');
  assert.equal((await admin().post('/api/payroll-adjustments', { person_type: 'Worker', person_id: 1, amount: 0, reason: 'zero amount' })).status, 400);
  assert.equal((await admin().post('/api/payroll-adjustments', { person_type: 'Worker', person_id: 999, amount: 10, reason: 'nobody here' })).status, 404);
  const m = await admin().post('/api/payroll-adjustments', { person_type: 'Worker', person_id: 1, amount: 5000, reason: 'Transport allowance' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal(m.body.data.status, 'Pending');
  assert.equal((await admin().patch(`/api/payroll-adjustments/${m.body.data.adjustment_id}/cancel`, { reason: 'x' })).status, 400);
  assert.equal((await admin().patch(`/api/payroll-adjustments/${m.body.data.adjustment_id}/cancel`, { reason: 'Entered by mistake' })).status, 200);
  assert.equal((await adj(m.body.data.adjustment_id)).status, 'Cancelled');

  const big = await admin().post('/api/payroll-adjustments', { person_type: 'Worker', person_id: 1, amount: -900000, reason: 'Advance to recover' });
  assert.equal(big.body.data.status, 'AwaitingConfirmation');
  await admin().patch(`/api/payroll-adjustments/${big.body.data.adjustment_id}/confirm`);
  await addRecord(1, d(12));
  const g = await generate(d(12), d(12));
  assert.equal(Number((await workerPayroll(g.batch_id)).adjustments_amount), 0);
  assert.equal(g.adjustment_warnings.length, 1);
  assert.equal((await adj(big.body.data.adjustment_id)).status, 'Pending');
  await admin().patch(`/api/payroll-adjustments/${big.body.data.adjustment_id}/cancel`, { reason: 'test clean up' });
  await admin().patch(`/api/admin/payroll/batch/${g.batch_id}/void`, { reason: 'test clean up' });

  const list = await admin().get('/api/payroll-adjustments?person_type=Worker');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 4);
  assert.ok(list.body.data.every((r) => r.full_name === 'Day Worker'));
});

test('PA8 an off-cycle batch never carries adjustments', async () => {
  const m = await admin().post('/api/payroll-adjustments', { person_type: 'Worker', person_id: 1, amount: 7000, reason: 'Bonus for off-cycle test' });
  await addRecord(1, d(13));
  const off = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: d(13), end_date: d(13), reason: 'Urgent payment' });
  assert.equal(off.status, 201, JSON.stringify(off.body));
  assert.equal(Number((await workerPayroll(off.body.batch_id)).adjustments_amount), 0);
  assert.equal((await adj(m.body.data.adjustment_id)).status, 'Pending');
  await admin().patch(`/api/payroll-adjustments/${m.body.data.adjustment_id}/cancel`, { reason: 'test clean up' });
});

// =========================== STAFF ===========================
const AUG = { start_date: '2026-08-01', end_date: '2026-08-31', acknowledge_pending: true };
const SEP = { start_date: '2026-09-01', end_date: '2026-09-30', acknowledge_pending: true };

test('PA9 staff: the recomputation mirrors official payroll exactly (paid net reproduced)', async () => {
  await q(`INSERT INTO staff_members (staff_id, staff_unique_id, full_name, position, site_id, hire_date, first_hire_date, monthly_salary, standard_daily_hours, status)
           VALUES (2, 'STF-10002', 'Staff Two', 'Clerk', 10, '2026-08-01', '2026-08-01', 900, 8, 'Active')`);
  await q("INSERT INTO staff_status_history (staff_id, old_status, new_status, effective_date, reason) VALUES (2, NULL, 'Active', '2026-08-01', 'hire')");
  await q("INSERT INTO staff_compensation_history (staff_id, monthly_salary, standard_daily_hours, effective_from, reason, changed_by_user_id) VALUES (2, 900, 8, '2026-08-01', 'initial', 1)");
  // August: Present 8h every working day, except Aug 3 = 6h and Aug 4 = Absent.
  for (let day = 1; day <= 31; day += 1) {
    const ds = `2026-08-${String(day).padStart(2, '0')}`;
    if (new Date(`${ds}T00:00:00Z`).getUTCDay() === 5) continue; // Friday
    const absent = ds === '2026-08-04';
    const out = ds === '2026-08-03' ? '14:00' : '16:00';
    const hrs = ds === '2026-08-03' ? 6 : 8;
    await q(`INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, check_out_time, regular_hours, overtime_hours, status, recorded_by_user_id, standard_minutes_snapshot)
             VALUES (2, ?, ?, ?, ?, ?, 0, 'Approved', 14, 480)`,
    [ds, absent ? 'Absent' : 'Present', absent ? null : `${ds} 08:00:00`, absent ? null : `${ds} ${out}:00`, absent ? 0 : hrs]);
  }
  for (let day = 1; day <= 30; day += 1) {
    const ds = `2026-09-${String(day).padStart(2, '0')}`;
    if (new Date(`${ds}T00:00:00Z`).getUTCDay() === 5) continue;
    await q(`INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, check_out_time, regular_hours, overtime_hours, status, recorded_by_user_id, standard_minutes_snapshot)
             VALUES (2, ?, 'Present', ?, ?, 8, 0, 'Approved', 14, 480)`, [ds, `${ds} 08:00:00`, `${ds} 16:00:00`]);
  }
  const g = await admin().post('/api/staff-payroll/generate', AUG);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  S.saug = g.body.batch_id;
  const [row] = await q('SELECT net_salary, salary_deduction_amount FROM staff_payroll WHERE staff_payroll_batch_id = ? AND staff_id = 2', [S.saug]);
  S.staffPaidNet = Number(row.net_salary);
  const { calculateStaff } = require('../services/staffPayrollPreviewService');
  const { countNonFridayDays } = require('../services/staffAttendanceService');
  const [[staff]] = await require('../config/db').query('SELECT * FROM staff_members WHERE staff_id = 2');
  const r = await calculateStaff(staff, '2026-08-01', '2026-08-31', countNonFridayDays('2026-08-01', '2026-08-31'), require('../config/db'), { statuses: ['Approved'] });
  assert.equal(r.calc.net_salary, S.staffPaidNet, 'mirror of the payroll formula');
  assert.equal((await admin().patch(`/api/staff-payroll/batch/${S.saug}/finalize`)).status, 200);
  assert.equal((await admin().patch(`/api/staff-payroll/batch/${S.saug}/mark-paid`)).status, 200);
});

test('PA10 staff: "complete the day" on a paid month pays exactly the deducted hours; management-paid absence pays the day', async () => {
  const [a3] = await q("SELECT staff_attendance_id, regular_hours FROM staff_attendance WHERE staff_id = 2 AND record_date = '2026-08-03'");
  const c = await admin().post(`/api/staff-attendance/admin/${a3.staff_attendance_id}/correction`, { reason: 'Management pays the 2 missing hours', complete_day: true });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const pa = c.body.data.payroll_adjustment;
  assert.ok(pa && pa.adjustment_id, JSON.stringify(c.body));
  assert.equal(pa.currency, 'USD');
  assert.ok(pa.amount > 0);
  assert.equal(pa.before, S.staffPaidNet, 'before = the net that was paid');
  const [rec] = await q('SELECT regular_hours, check_out_time, remarks FROM staff_attendance WHERE staff_attendance_id = ?', [a3.staff_attendance_id]);
  assert.equal(Number(rec.regular_hours), 8);
  assert.match(String(rec.check_out_time), /14:00/, 'real times kept');
  assert.match(rec.remarks, /Day completed by management decision/);
  S.sadj1 = pa;

  const [a4] = await q("SELECT staff_attendance_id FROM staff_attendance WHERE staff_id = 2 AND record_date = '2026-08-04'");
  const m = await admin().post(`/api/staff-attendance/admin/${a4.staff_attendance_id}/correction`, { reason: 'Management decided to pay this absence', is_management_paid_absence: 1 });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const pa2 = m.body.data.payroll_adjustment;
  assert.ok(pa2.amount > 0);
  assert.equal(pa2.before, S.sadj1.after, 'each correction is measured on top of the previous one');
  const [rec4] = await q('SELECT is_management_paid_absence, management_paid_by_user_id FROM staff_attendance WHERE staff_attendance_id = ?', [a4.staff_attendance_id]);
  assert.deepEqual([rec4.is_management_paid_absence, rec4.management_paid_by_user_id], [1, 1]);
  S.sadj2 = pa2;
  // After both: recompute of August = paid net + both adjustments (nothing paid twice)
  const { calculateStaff } = require('../services/staffPayrollPreviewService');
  const { countNonFridayDays } = require('../services/staffAttendanceService');
  const [[staff]] = await require('../config/db').query('SELECT * FROM staff_members WHERE staff_id = 2');
  const r = await calculateStaff(staff, '2026-08-01', '2026-08-31', countNonFridayDays('2026-08-01', '2026-08-31'), require('../config/db'), { statuses: ['Approved'] });
  assert.equal(Math.round(r.calc.net_salary * 100), Math.round((S.staffPaidNet + pa.amount + pa2.amount) * 100));
});

test('PA11 staff: the next batch carries both adjustments; details and exports show them; mark paid applies them', async () => {
  const g = await admin().post('/api/staff-payroll/generate', SEP);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.body.adjustments_included, 2);
  const [row] = await q('SELECT net_salary, adjustments_amount, prorated_base_salary, salary_deduction_amount FROM staff_payroll WHERE staff_payroll_batch_id = ? AND staff_id = 2', [g.body.batch_id]);
  const expectedAdj = Math.round((S.sadj1.amount + S.sadj2.amount) * 100) / 100;
  assert.equal(Number(row.adjustments_amount), expectedAdj);
  assert.equal(Math.round(Number(row.net_salary) * 100), Math.round((Number(row.prorated_base_salary) - Number(row.salary_deduction_amount) + expectedAdj) * 100));
  const det = await admin().get(`/api/staff-payroll/batch/${g.body.batch_id}`);
  assert.equal(det.body.adjustments.length, 2);
  const x = await getBytes(`/api/staff-payroll/batch/${g.body.batch_id}/export.xlsx`);
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.bytes);
  assert.ok(wb.getWorksheet('Adjustments'));
  const pdf = await getBytes(`/api/staff-payroll/batch/${g.body.batch_id}/export.pdf`);
  assert.equal(pdf.status, 200);
  // void -> pending; supersede path keeps them
  await admin().patch(`/api/staff-payroll/batch/${g.body.batch_id}/void`, { reason: 'check release' });
  assert.equal((await adj(S.sadj1.adjustment_id)).status, 'Pending');
  const g2 = await admin().post('/api/staff-payroll/generate', SEP);
  await admin().patch(`/api/staff-payroll/batch/${g2.body.batch_id}/finalize`);
  const sup = await admin().post(`/api/staff-payroll/batch/${g2.body.batch_id}/new-version`, { reason: 'supersede keeps adjustments', acknowledge_pending: true });
  assert.equal(sup.status, 201, JSON.stringify(sup.body));
  assert.equal((await adj(S.sadj1.adjustment_id)).included_batch_id, sup.body.batch_id);
  await admin().patch(`/api/staff-payroll/batch/${sup.body.batch_id}/finalize`);
  const paid = await admin().patch(`/api/staff-payroll/batch/${sup.body.batch_id}/mark-paid`);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.adjustments_applied, 2);
  assert.equal((await adj(S.sadj2.adjustment_id)).status, 'Applied');
});

test('PA12 recycle bin: a staff member with open adjustments cannot be deleted', async () => {
  await q(`INSERT INTO staff_members (staff_id, staff_unique_id, full_name, hire_date, first_hire_date, monthly_salary, status)
           VALUES (7, 'STF-10007', 'Owed Person', '2026-10-01', '2026-10-01', 500, 'Active')`);
  const m = await admin().post('/api/payroll-adjustments', { person_type: 'Staff', person_id: 7, amount: 20, reason: 'Allowance owed' });
  assert.equal(m.status, 201);
  let chk = await admin().get('/api/staff/7/deletion-check');
  assert.deepEqual(chk.body.data.blockers.map((b) => b.code), ['PAYROLL_ADJUSTMENTS']);
  await admin().patch(`/api/payroll-adjustments/${m.body.data.adjustment_id}/cancel`, { reason: 'Not owed after all' });
  chk = await admin().get('/api/staff/7/deletion-check');
  assert.equal(chk.body.data.can_delete, true);
  const del = await admin().del('/api/staff/7', { reason: 'Test person', confirm_name: 'Owed Person' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal((await q('SELECT COUNT(*) c FROM payroll_adjustments WHERE person_type = "Staff" AND person_id = 7'))[0].c, 0);
  const r = await admin().post(`/api/recycle-bin/${del.body.data.recycle_id}/restore`, { reason: 'Bring back for test' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await adj(m.body.data.adjustment_id)).status, 'Cancelled', 'restored with its history');
});

test('PA13 app support: approved staff records list with payroll state; worker / staff lists carry the ids the app uses', async () => {
  const r = await admin().get('/api/staff-attendance/admin/records?start_date=2026-08-01&end_date=2026-08-31&staff_id=2');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.length >= 20);
  const aug3 = r.body.data.find((x) => x.record_date === '2026-08-03');
  assert.deepEqual([aug3.payroll.state, aug3.payroll.batch_id], ['Paid', S.saug]);
  assert.equal((await admin().get('/api/staff-attendance/admin/records?start_date=2026-08-01&end_date=2026-12-31')).status, 400, 'range limit');
  assert.equal((await supDay().get('/api/staff-attendance/admin/records?start_date=2026-08-01&end_date=2026-08-31')).status, 403);
  const w = await admin().get('/api/workers');
  assert.ok(w.body.data.some((x) => x.worker_id === 1 && x.full_name && x.worker_unique_id));
  const s = await admin().get('/api/staff');
  assert.ok(s.body.data.some((x) => x.staff_id === 2 && x.full_name && x.staff_unique_id));
});
