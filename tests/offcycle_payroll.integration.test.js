// tests/offcycle_payroll.integration.test.js
//
// Off-cycle (urgent, individual) worker payroll — HTTP integration tests
// against the real controllers and a local MySQL 8 database (tests/helpers.js).
//
// Scenario of the request: the supervisor submitted the site/shift, the
// records wait for Admin approval; one worker must be paid now. The Admin
// approves only that worker, pays him off-cycle, and keeps approving the
// others afterwards. The next Regular payroll must not pay him twice and must
// show that he was already paid.
//
// Run:  npm test   (requires a local MySQL; see tests/helpers.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { resetDatabase, startServer, stopServer, client, q, token } = require('./helpers');
const { businessToday, addDays } = require('../services/businessDate');

const TODAY = businessToday();
const admin = () => client(1, 'Admin');
const supDay = () => client(11, 'Supervisor');      // site 8 (T2) Day: workers 1 and 4
const supBridges = () => client(12, 'Supervisor');  // site 10 (Bridges): worker 3

// Fixed past window after the seeded paid batch (2026-09-01..02) and after
// worker 4 moved to site 8 (2026-09-10). Every date is in the past.
const BASE = addDays(TODAY, -25);
const d = (n) => addDays(BASE, n);
// Period A (site 8, workers 1 and 4): d0..d4
// Period B (site 10, worker 3):      d5..d7
// Period C (site 10, worker 3):      d8..d9   (void scenario)
// Period E (site 10, worker 3):      d10..d11 (supersede scenario)
// Period F (site 8, worker 1/4):     d14..d15 (missing-day scenario)

let base;
const ids = {};

async function addRecord(workerId, siteId, date, status, { ot = 0, attendanceStatus = 'Present' } = {}) {
  const present = attendanceStatus === 'Present';
  const [r] = await require('../config/db').query(
    `INSERT INTO attendance (worker_id, site_id, shift_type, record_date, check_in_time, check_out_time, attendance_status,
                             total_working_hours, overtime_hours, recorded_by_user_id, status, standard_minutes_snapshot)
     VALUES (?, ?, 'Day', ?, ?, ?, ?, ?, ?, 11, ?, 600)`,
    [workerId, siteId, date,
      present ? `${date} 07:00:00` : null, present ? `${date} ${ot ? '18' : '17'}:00:00` : null,
      attendanceStatus, present ? 10 : null, ot, status]
  );
  return r.insertId;
}

async function approve(attendanceId) {
  const r = await admin().post('/api/admin/attendance/review', { attendance_id: attendanceId, status: 'Approved' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function batchRow(id) {
  const [row] = await q('SELECT * FROM payrollbatches WHERE payroll_batch_id = ?', [id]);
  return row;
}

async function getBytes(path) {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token(1, 'Admin')}` } });
  return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
}

test.before(async () => {
  resetDatabase({ migrate: true });
  base = await startServer();
  await q("INSERT INTO system_settings (setting_key, setting_value) VALUES ('attendance_daily_gate_enabled', 'false') ON DUPLICATE KEY UPDATE setting_value = 'false'");
  await require('../services/settingsCache').refresh();

  // Period A: the supervisor already submitted site 8 Day for workers 1 and 4.
  ids.w1 = [];
  ids.w4 = [];
  for (let i = 0; i <= 4; i += 1) {
    ids.w1.push(await addRecord(1, 8, d(i), 'Submitted', { ot: i === 0 ? 1 : 0 }));
    ids.w4.push(await addRecord(4, 8, d(i), 'Submitted'));
  }
});
test.after(async () => { await stopServer(); });

// ---------------------------------------------------------------------------
test('OC0 migration: existing batches are Regular, nothing else changed', async () => {
  const rows = await q('SELECT payroll_batch_id, batch_type, scope_worker_id, total_amount, status, is_finalized FROM payrollbatches');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].batch_type, 'Regular');
  assert.equal(rows[0].scope_worker_id, null);
  assert.equal(Number(rows[0].total_amount), 300150);
  assert.equal(rows[0].status, 'Paid');
  const { assertOffCycleSchema } = require('../services/payrollLock');
  assert.equal(await assertOffCycleSchema(require('../config/db')), true);
});

test('OC1 approve only worker 1, preview (dry run) writes nothing and shows the amount', async () => {
  for (const id of ids.w1) await approve(id);

  const cand = await admin().get(`/api/admin/payroll/offcycle/candidates?start_date=${d(0)}&end_date=${d(4)}`);
  assert.equal(cand.status, 200, JSON.stringify(cand.body));
  const c1 = cand.body.data.find((r) => r.worker_id === 1);
  const c4 = cand.body.data.find((r) => r.worker_id === 4);
  assert.deepEqual([c1.approved, c1.pending], [5, 0]);
  assert.deepEqual([c4.approved, c4.pending], [0, 5]);

  const before = await q('SELECT COUNT(*) c FROM payrollbatches');
  const prev = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: d(0), end_date: d(4), dry_run: true });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.dry_run, true);
  assert.equal(prev.body.net_salary, 5 * 100000 + 150);
  assert.equal(prev.body.approved_records, 5);
  assert.equal(prev.body.lines.length, 1);
  assert.equal(prev.body.lines[0].site_name, 'T2');
  assert.deepEqual(prev.body.days_without_record, []);
  const after = await q('SELECT COUNT(*) c FROM payrollbatches');
  assert.equal(Number(after[0].c), Number(before[0].c), 'dry run must not write');
});

test('OC2 off-cycle refuses unapproved attendance (no "generate without them")', async () => {
  const r = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 4, start_date: d(0), end_date: d(4), dry_run: true, acknowledge_pending: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OFFCYCLE_PENDING_ATTENDANCE');
  assert.equal(r.body.pending_attendance.length, 5);
  assert.ok(r.body.pending_attendance.every((p) => p.worker_id === 4), 'only this worker is checked');
});

test('OC3 validation: reason required, no future end date, unknown worker', async () => {
  const noReason = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: d(0), end_date: d(4) });
  assert.equal(noReason.status, 400);
  const future = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: d(0), end_date: addDays(TODAY, 1), dry_run: true });
  assert.equal(future.status, 400);
  assert.equal(future.body.code, 'OFFCYCLE_FUTURE_DATE');
  const unknown = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 999, start_date: d(0), end_date: d(4), dry_run: true });
  assert.equal(unknown.status, 404);
  const sup = await supDay().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: d(0), end_date: d(4), dry_run: true });
  assert.equal(sup.status, 403);
  // /generate never accepts off-cycle fields from the body.
  assert.equal((await q("SELECT COUNT(*) c FROM payrollbatches WHERE batch_type = 'OffCycle'"))[0].c, 0);
});

test('OC4 generate the off-cycle batch; a Regular batch is refused until it is finalized', async () => {
  const r = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: d(0), end_date: d(4), reason: 'Urgent: worker travelling' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.batch_type, 'OffCycle');
  assert.equal(r.body.total_amount, 500150);
  ids.off1 = r.body.batch_id;
  const b = await batchRow(ids.off1);
  assert.deepEqual([b.batch_type, b.scope_worker_id, b.scope_site_id, b.offcycle_reason, b.total_workers],
    ['OffCycle', 1, null, 'Urgent: worker travelling', 1]);
  const snap = await q('SELECT COUNT(*) c FROM payroll_attendance_snapshot WHERE payroll_batch_id = ?', [ids.off1]);
  assert.equal(Number(snap[0].c), 5);

  // Not finalized -> attendance of OTHER workers and of worker 1 is still open.
  const reg = await admin().post('/api/admin/payroll/generate', { start_date: d(0), end_date: d(4), acknowledge_pending: true });
  assert.equal(reg.status, 409);
  assert.equal(reg.body.code, 'OFFCYCLE_NOT_FINALIZED');
  assert.equal(reg.body.offcycle_batches[0].payroll_batch_id, ids.off1);
});

test('OC5 finalizing the off-cycle batch locks ONLY that worker; the others can still be approved', async () => {
  const fin = await admin().patch(`/api/admin/payroll/batch/${ids.off1}/finalize`);
  assert.equal(fin.status, 200, JSON.stringify(fin.body));

  // The key requirement: approving the other workers of the same site/day works.
  for (const id of ids.w4) await approve(id);

  // Worker 1 is locked for his period (any attendance path).
  const edit = await supDay().post('/api/attendance/status', { worker_id: 1, site_id: 8, shift_type: 'Day', record_date: d(2), attendance_status: 'Absent' });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, 'PAYROLL_PERIOD_FINALIZED');
  assert.equal(edit.body.batch_type, 'OffCycle');
  assert.match(edit.body.message, /Day Worker/);

  const { findLockedWorkerBatch } = require('../services/payrollLock');
  const db = require('../config/db');
  assert.equal(await findLockedWorkerBatch(db, { siteId: 8, date: d(2) }), null, 'the site/day itself is not locked');
  assert.equal((await findLockedWorkerBatch(db, { siteId: 8, date: d(2), workerId: 4 })), null, 'worker 4 is not locked');
  assert.equal((await findLockedWorkerBatch(db, { siteId: 8, date: d(2), workerId: 1 })).payroll_batch_id, ids.off1);
  assert.equal(await findLockedWorkerBatch(db, { siteId: 8, date: d(5), workerId: 1 }), null, 'outside the period');
});

test('OC6 Regular payroll skips the worker already paid and shows him as paid off-cycle', async () => {
  const reg = await admin().post('/api/admin/payroll/generate', { start_date: d(0), end_date: d(4) });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  ids.regA = reg.body.batch_id;
  const rows = await q('SELECT worker_id, net_salary FROM payroll WHERE payroll_batch_id = ? ORDER BY worker_id', [ids.regA]);
  assert.deepEqual(rows.map((r) => [r.worker_id, Number(r.net_salary)]), [[4, 5 * 90000]], 'worker 1 is NOT paid twice');
  const snap = await q('SELECT COUNT(*) c FROM payroll_attendance_snapshot WHERE payroll_batch_id = ? AND worker_id = 1', [ids.regA]);
  assert.equal(Number(snap[0].c), 0);
  assert.equal(Number((await batchRow(ids.regA)).total_amount), 450000);

  const det = await admin().get(`/api/admin/payroll/batch/${ids.regA}`);
  assert.equal(det.status, 200);
  assert.equal(det.body.offcycle_paid.length, 1);
  const o = det.body.offcycle_paid[0];
  assert.deepEqual([o.payroll_batch_id, o.worker_id, o.amount, o.in_this_batch], [ids.off1, 1, 500150, false]);
  assert.deepEqual(det.body.offcycle_summary, { count: 1, total: 500150, batch_total: 450000, period_total: 950150 });

  // Off-cycle batch details: its own type, worker and reason; no "paid off-cycle" section.
  const offDet = await admin().get(`/api/admin/payroll/batch/${ids.off1}`);
  assert.equal(offDet.body.batch.batch_type, 'OffCycle');
  assert.equal(offDet.body.batch.scope_worker_name, 'Day Worker');
  assert.deepEqual(offDet.body.offcycle_paid, []);
});

test('OC7 conflicts: worker already in a Regular batch, overlapping off-cycle', async () => {
  const covered = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 4, start_date: d(2), end_date: d(4), dry_run: true });
  assert.equal(covered.status, 409);
  assert.equal(covered.body.code, 'OFFCYCLE_COVERED_BY_REGULAR');
  const overlap = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: d(4), end_date: d(6), dry_run: true });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.code, 'OFFCYCLE_OVERLAP');
});

test('OC8 partial off-cycle: the Regular batch pays only the remaining days', async () => {
  const w3 = [];
  for (let i = 5; i <= 7; i += 1) w3.push(await addRecord(3, 10, d(i), 'Submitted'));
  for (const id of w3) await approve(id);
  const off = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 3, start_date: d(5), end_date: d(6), reason: 'Advance before leave' });
  assert.equal(off.status, 201, JSON.stringify(off.body));
  ids.off3 = off.body.batch_id;
  assert.equal(off.body.total_amount, 2 * 90000);
  await admin().patch(`/api/admin/payroll/batch/${ids.off3}/finalize`);

  const reg = await admin().post('/api/admin/payroll/generate', { start_date: d(5), end_date: d(7) });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  ids.regB = reg.body.batch_id;
  const rows = await q('SELECT worker_id, net_salary FROM payroll WHERE payroll_batch_id = ?', [ids.regB]);
  assert.deepEqual(rows.map((r) => [r.worker_id, Number(r.net_salary)]), [[3, 90000]], 'only the last day');
  const det = await admin().get(`/api/admin/payroll/batch/${ids.regB}`);
  const w = det.body.workers.find((x) => x.worker_id === 3);
  assert.equal(w.offcycle_batches.length, 1);
  assert.equal(w.offcycle_batches[0].payroll_batch_id, ids.off3);
  assert.equal(det.body.offcycle_paid[0].in_this_batch, true);
  assert.equal(det.body.offcycle_summary.period_total, 270000);
});

test('OC9 next-period start date and dashboard ignore off-cycle batches', async () => {
  // An off-cycle batch whose end is LATER than every Regular batch.
  const late = await addRecord(3, 10, d(12), 'Submitted');
  await approve(late);
  const off = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 3, start_date: d(12), end_date: d(12), reason: 'Later urgent payment' });
  assert.equal(off.status, 201, JSON.stringify(off.body));
  ids.offLate = off.body.batch_id;

  const last = await admin().get('/api/admin/payroll/last-date');
  assert.equal(String(last.body.last_end_date).slice(0, 10), d(7), 'Regular batches only');
  const lastSite = await admin().get('/api/admin/payroll/last-date?site_id=10');
  assert.equal(String(lastSite.body.last_end_date).slice(0, 10), d(7));

  const list = await admin().get('/api/admin/payroll/report');
  const offRow = list.body.data.find((b) => b.payroll_batch_id === ids.offLate);
  assert.deepEqual([offRow.batch_type, offRow.scope_worker_name], ['OffCycle', 'Bridges Worker']);

  // Leave it unfinalized and void it at the end of OC10.
});

test('OC10 voiding an unfinalized off-cycle batch gives the days back to the Regular payroll', async () => {
  const v = await admin().patch(`/api/admin/payroll/batch/${ids.offLate}/void`, { reason: 'Created by mistake' });
  assert.equal(v.status, 200, JSON.stringify(v.body));

  const c1 = await addRecord(3, 10, d(8), 'Submitted');
  const c2 = await addRecord(3, 10, d(9), 'Submitted');
  await approve(c1); await approve(c2);
  const off = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 3, start_date: d(8), end_date: d(9), reason: 'Wrong period test' });
  assert.equal(off.status, 201);
  const vv = await admin().patch(`/api/admin/payroll/batch/${off.body.batch_id}/void`, { reason: 'Wrong worker' });
  assert.equal(vv.status, 200);

  const reg = await admin().post('/api/admin/payroll/generate', { start_date: d(8), end_date: d(12), site_id: 10 });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const rows = await q('SELECT worker_id, net_salary FROM payroll WHERE payroll_batch_id = ?', [reg.body.batch_id]);
  assert.deepEqual(rows.map((r) => [r.worker_id, Number(r.net_salary)]), [[3, 3 * 90000]], 'd8, d9 and d12 are paid once');
  // Clean up: void this site batch so later scenarios are independent.
  await admin().patch(`/api/admin/payroll/batch/${reg.body.batch_id}/void`, { reason: 'Test cleanup' });
});

test('OC11 supersede a finalized off-cycle batch: same worker and period, new version', async () => {
  const e1 = await addRecord(3, 10, d(10), 'Submitted');
  const e2 = await addRecord(3, 10, d(11), 'Submitted');
  await approve(e1); await approve(e2);
  const off = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 3, start_date: d(10), end_date: d(11), reason: 'Urgent family need' });
  assert.equal(off.status, 201);
  await admin().patch(`/api/admin/payroll/batch/${off.body.batch_id}/finalize`);
  const sup = await admin().post(`/api/admin/payroll/batch/${off.body.batch_id}/supersede`, { reason: 'Correct rate' });
  assert.equal(sup.status, 201, JSON.stringify(sup.body));
  const nb = await batchRow(sup.body.batch_id);
  assert.deepEqual([nb.batch_type, nb.scope_worker_id, nb.version_number, nb.supersedes_batch_id, nb.offcycle_reason],
    ['OffCycle', 3, 2, off.body.batch_id, 'Urgent family need']);
  assert.equal((await batchRow(off.body.batch_id)).status, 'Superseded');
  const chain = await admin().get(`/api/admin/payroll/batch/${sup.body.batch_id}/versions`);
  assert.deepEqual(chain.body.data.map((b) => b.payroll_batch_id), [off.body.batch_id, sup.body.batch_id]);
  ids.offE = sup.body.batch_id;
});

test('OC12 an off-cycle batch can no longer be superseded once a Regular batch covers it', async () => {
  // Off-cycle d10..d11 (finalized) -> Regular d10..d11 at site 10 -> supersede refused.
  await admin().patch(`/api/admin/payroll/batch/${ids.offE}/finalize`);
  const reg = await admin().post('/api/admin/payroll/generate', { start_date: d(10), end_date: d(11), site_id: 10 });
  assert.equal(reg.status, 404, 'nothing left to pay: the only worker was paid off-cycle');
  // Create the Regular batch for a larger window that also covers d10..d11 for worker 3.
  const extra = await addRecord(3, 10, d(13), 'Submitted');
  await approve(extra);
  const reg2 = await admin().post('/api/admin/payroll/generate', { start_date: d(10), end_date: d(13), site_id: 10 });
  assert.equal(reg2.status, 201, JSON.stringify(reg2.body));
  const sup = await admin().post(`/api/admin/payroll/batch/${ids.offE}/supersede`, { reason: 'Try again' });
  assert.equal(sup.status, 409);
  assert.equal(sup.body.code, 'OFFCYCLE_COVERED_BY_REGULAR');
  assert.equal((await batchRow(ids.offE)).status, 'Generated', 'unchanged');
});

test('OC13 mark paid + admin correction on a paid off-cycle record raises an adjustment', async () => {
  const paid = await admin().patch(`/api/admin/payroll/batch/${ids.off1}/mark-paid`);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const corr = await admin().post(`/api/attendance/${ids.w1[1]}/admin-correction`, { attendance_status: 'Absent', reason: 'Was absent that day' });
  assert.equal(corr.status, 200, JSON.stringify(corr.body));
  const [log] = await q('SELECT locked_batch_id, payroll_effect FROM attendance_corrections_log WHERE record_id = ? ORDER BY 1 DESC LIMIT 1', [ids.w1[1]]);
  assert.deepEqual([log.locked_batch_id, log.payroll_effect], [ids.off1, 'AdjustmentRequired']);
  // The paid off-cycle payroll itself never changes.
  assert.equal(Number((await batchRow(ids.off1)).total_amount), 500150);
});

test('OC14 a worker paid off-cycle is not "missing" when the supervisor submits a day', async () => {
  // d14: worker 1 has an approved record, d15 has none. Off-cycle d14..d15, finalized.
  const a = await addRecord(1, 8, d(14), 'Submitted');
  await approve(a);
  const prev = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: d(14), end_date: d(15), dry_run: true });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.deepEqual(prev.body.days_without_record, [d(15)], 'the preview lists the day without attendance');
  const off = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: d(14), end_date: d(15), reason: 'Second urgent payment' });
  assert.equal(off.status, 201);
  await admin().patch(`/api/admin/payroll/batch/${off.body.batch_id}/finalize`);

  // d15: worker 4 is recorded (Holiday), worker 1 cannot be recorded any more.
  const blocked = await supDay().post('/api/attendance/status', { worker_id: 1, site_id: 8, shift_type: 'Day', record_date: d(15), attendance_status: 'Holiday' });
  assert.equal(blocked.status, 409);
  const w4 = await supDay().post('/api/attendance/status', { worker_id: 4, site_id: 8, shift_type: 'Day', record_date: d(15), attendance_status: 'Holiday' });
  assert.ok([200, 201].includes(w4.status), JSON.stringify(w4.body));
  const bulk = await supDay().post('/api/attendance/bulk/status', { worker_ids: [1, 4], site_id: 8, shift_type: 'Day', record_date: d(15), attendance_status: 'Holiday' });
  assert.equal(bulk.status, 409, 'bulk with the paid worker is refused');
  assert.equal(bulk.body.failed_worker.worker_id, 1);

  const sub = await supDay().post('/api/attendance/submit', { siteId: 8, shift_type: 'Day', record_date: d(15) });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const [rec] = await q("SELECT status FROM attendance WHERE worker_id = 4 AND record_date = ?", [d(15)]);
  assert.equal(rec.status, 'Submitted');
});

test('OC15 daily gate: an empty day is not pending only because of a worker paid off-cycle', async () => {
  const gate = require('../services/dailyGate');
  const db = require('../config/db');
  // Site 8 Day: worker 1 is paid off-cycle d16..d17 (no record on d17); worker 4 is assigned too.
  const off16 = await addRecord(1, 8, d(16), 'Submitted');
  await approve(off16);
  const off = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: d(16), end_date: d(17), reason: 'Third urgent payment' });
  assert.equal(off.status, 201, JSON.stringify(off.body));
  await admin().patch(`/api/admin/payroll/batch/${off.body.batch_id}/finalize`);
  await q("UPDATE system_settings SET setting_value = 'true' WHERE setting_key = 'attendance_daily_gate_enabled'");
  await q("INSERT INTO system_settings (setting_key, setting_value) VALUES ('attendance_daily_gate_start_date', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [d(16)]);
  await require('../services/settingsCache').refresh();
  try {
    // d16 has worker 1's record, so it is "recorded"; check d17 (empty) through d18.
    // Worker 4 alone still makes an empty, non-rest day pending.
    const g = await gate.pendingWorkerDays(db, { siteId: 8, shiftType: 'Day', recordDate: d(18) });
    const restDay = (6 + 6) % 7;
    const dow = (x) => { const [y, m, dd] = x.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };
    if (dow(d(17)) !== restDay) {
      const day17 = g.days.find((x) => x.record_date === d(17));
      assert.ok(day17, 'worker 4 still makes d17 pending');
      assert.equal(day17.missing_workers, 1, 'worker 1 is not counted on his off-cycle dates');
    }
    // On d16 itself (only worker 1 recorded): recorded day, never pending.
    assert.equal(g.days.some((x) => x.record_date === d(16)), false);
  } finally {
    await q("UPDATE system_settings SET setting_value = 'false' WHERE setting_key = 'attendance_daily_gate_enabled'");
    await require('../services/settingsCache').refresh();
  }
});

test('OC16 exports: Regular batch lists the off-cycle payment; off-cycle batch exports work', async () => {
  const x = await getBytes(`/api/admin/payroll/batch/${ids.regA}/export.xlsx`);
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.bytes);
  const sheet = wb.getWorksheet('Summary');
  const texts = [];
  sheet.eachRow((row) => row.eachCell((c) => texts.push(String(c.value ?? ''))));
  assert.ok(texts.some((t) => t.startsWith('Paid off-cycle in this period')), 'off-cycle section present');
  assert.ok(texts.includes('Day Worker'));
  assert.ok(texts.includes('PERIOD TOTAL (this batch + off-cycle)'));

  const xo = await getBytes(`/api/admin/payroll/batch/${ids.off1}/export.xlsx`);
  assert.equal(xo.status, 200);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(xo.bytes);
  assert.match(String(wb2.getWorksheet('Summary').getCell('C1').value), /^Off-cycle \(individual\) Payroll Batch/);

  for (const id of [ids.regA, ids.off1, ids.regB]) {
    const p = await getBytes(`/api/admin/payroll/batch/${id}/export.pdf`);
    assert.equal(p.status, 200);
    assert.match(p.type, /application\/pdf/);
    assert.equal(p.bytes.subarray(0, 4).toString(), '%PDF');
  }
});

test('OC17 monthly report: no false "covered by more than one batch" flag', async () => {
  const { _internal } = require('../services/workerMonthlyReportService');
  const from = d(0);
  const to = d(7);
  const data = await _internal.loadData(from, to);
  const rows = _internal.aggregate(data, from, to);
  for (const r of rows) {
    assert.equal(r.flags.some((f) => /more than one payroll batch/.test(f)), false, `${r.name}: ${r.flags.join(' | ')}`);
  }
  const w1 = rows.find((r) => r.worker_id === 1);
  assert.equal(Math.round(w1.total), 500150, 'worker 1 paid once (off-cycle)');
  const w3 = rows.find((r) => r.worker_id === 3);
  assert.equal(Math.round(w3.total), 270000, 'worker 3: off-cycle + Regular');
});

test('OC18 dashboard: latest batch / covered end come from period payroll, not off-cycle', async () => {
  const r = await admin().get(`/api/main-dashboard/live?date=${TODAY}`);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const pay = r.body.data.payroll;
  assert.notEqual(pay.latest_batch, null);
  assert.equal(pay.latest_batch.batch_type, 'Regular');
  // Regular coverage of site 8 ends at d7 (all-sites batch d5..d7), not at the
  // later off-cycle batches of worker 1 (d14..d17).
  const ends = [];
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      if (o.payroll && Object.prototype.hasOwnProperty.call(o.payroll, 'last_covered_end') && Number(o.site_id) === 8) ends.push(o.payroll.last_covered_end);
      Object.values(o).forEach(walk);
    }
  };
  for (const site of r.body.data.sites) {
    if (Number(site.site_id) !== 8) continue;
    walk(Object.assign({}, site));
    for (const v of Object.values(site)) if (Array.isArray(v)) v.forEach((u) => { if (u && u.payroll) ends.push(u.payroll.last_covered_end); });
  }
  assert.ok(ends.length > 0, 'site 8 payroll coverage present');
  for (const e of ends) assert.equal(e, d(7));
  const offOpen = pay.open_batches.filter((b) => b.batch_type === 'OffCycle');
  assert.ok(offOpen.every((b) => b.scope_worker_name), 'off-cycle entries carry the worker name');
});
