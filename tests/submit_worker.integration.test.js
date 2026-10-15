// tests/submit_worker.integration.test.js
//
// Submit ONE worker before the rest of the day:
//   POST /api/attendance/submit-worker { attendance_id, lunch_decision? }
// Allowed once the worker is checked out (lunch recorded or not); "Submit day"
// keeps working exactly as before for the remaining records.
// Run:  npm test   (requires a local MySQL; see tests/helpers.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDatabase, startServer, stopServer, client, q } = require('./helpers');
const { businessToday, addDays } = require('../services/businessDate');

const TODAY = businessToday();
const D = addDays(TODAY, -2);
const admin = () => client(1, 'Admin');
const supDay = () => client(11, 'Supervisor');     // site 8 Day: workers 1 and 4
const supBridges = () => client(12, 'Supervisor'); // site 10 only

const att = async (workerId) =>
  (await q('SELECT * FROM attendance WHERE worker_id = ? AND site_id = 8 AND record_date = ?', [workerId, D]))[0];
const submitWorker = (c, body) => c.post('/api/attendance/submit-worker', body);

test.before(async () => {
  resetDatabase({ migrate: true });
  await startServer();
  await q("INSERT INTO system_settings (setting_key, setting_value) VALUES ('attendance_daily_gate_enabled', 'false') ON DUPLICATE KEY UPDATE setting_value = 'false'");
  await require('../services/settingsCache').refresh();
  for (const w of [1, 4]) {
    const r = await supDay().post('/api/attendance/checkin', { worker_id: w, site_id: 8, shift_type: 'Day', record_date: D, check_in_time: `${D} 07:00:00` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
});
test.after(async () => { await stopServer(); });

test('SW1 refused while the worker is still checked in', async () => {
  const r = await submitWorker(supDay(), { attendance_id: (await att(1)).attendance_id });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.message, /checked out/);
  assert.equal((await att(1)).status, 'Draft');
});

test('SW2 checked out, NO lunch: lunch question, then submitted alone (others untouched)', async () => {
  const out = await supDay().post('/api/attendance/checkout', { worker_id: 1, site_id: 8, shift_type: 'Day', record_date: D, check_out_time: `${D} 12:00:00` });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const id = (await att(1)).attendance_id;

  const other = await submitWorker(supBridges(), { attendance_id: id });
  assert.equal(other.status, 403, 'another site supervisor cannot submit him');

  const ask = await submitWorker(supDay(), { attendance_id: id });
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  assert.equal(ask.body.requires_confirmation, true);
  assert.equal(ask.body.missing_workers[0].attendance_id, id);
  assert.equal((await att(1)).status, 'Draft', 'nothing saved before the answer');

  const noReason = await submitWorker(supDay(), { attendance_id: id, lunch_decision: { worked_through_lunch: true } });
  assert.equal(noReason.status, 400);

  const ok = await submitWorker(supDay(), { attendance_id: id, lunch_decision: { worked_through_lunch: true, reason: 'Left early, no lunch' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.submitted_records, 1);
  const row = await att(1);
  assert.equal(row.status, 'Submitted');
  assert.match(row.remarks, /Worked through lunch: Left early, no lunch/);
  assert.equal(Number(row.total_working_hours) + Number(row.overtime_hours), 5, 'hours recalculated (07-12)');
  assert.equal((await att(4)).status, 'Draft', 'worker 4 untouched');

  const again = await submitWorker(supDay(), { attendance_id: id });
  assert.equal(again.status, 409);
});

test('SW3 "Submit day" still refuses while another worker is checked in', async () => {
  const r = await supDay().post('/api/attendance/submit', { siteId: 8, shift_type: 'Day', record_date: D });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.open_workers.map((w) => w.full_name).length, 1);
});

test('SW4 worker WITH lunch recorded submits directly; Submit day then submits nothing left', async () => {
  // Lunch can only be set after check-out: check out first, then record lunch.
  const out = await supDay().post('/api/attendance/checkout', { worker_id: 4, site_id: 8, shift_type: 'Day', record_date: D, check_out_time: `${D} 15:00:00` });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const l2 = await supDay().post('/api/attendance/lunch/bulk', {
    siteId: 8, shift_type: 'Day', date: D,
    default_start_time: '12:00', default_end_time: '12:30', overrides: {}, excluded_worker_ids: [],
  });
  assert.equal(l2.status, 200, JSON.stringify(l2.body));
  const id4 = (await att(4)).attendance_id;
  const leaves = await q("SELECT COUNT(*) c FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_type = 'Lunch'", [id4]);
  assert.equal(Number(leaves[0].c), 1);

  const ok = await submitWorker(supDay(), { attendance_id: id4 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.notEqual(ok.body.requires_confirmation, true);
  assert.equal((await att(4)).status, 'Submitted');
  assert.equal(Number((await att(4)).total_working_hours) + Number((await att(4)).overtime_hours), 7.5);

  const day = await supDay().post('/api/attendance/submit', { siteId: 8, shift_type: 'Day', record_date: D });
  assert.equal(day.status, 200, JSON.stringify(day.body));
  assert.equal(day.body.submitted_records, 0, 'the whole-day button still works; nothing was left');
});

test('SW5 approved alone -> payable off-cycle before the others', async () => {
  const id = (await att(1)).attendance_id;
  const ap = await admin().post('/api/admin/attendance/review', { attendance_id: id, status: 'Approved' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const prev = await admin().post('/api/admin/payroll/generate-offcycle', { worker_id: 1, start_date: D, end_date: D, dry_run: true });
  assert.ok([200, 201].includes(prev.status), JSON.stringify(prev.body));
});

async function dayWithSiteLunch(date) {
  for (const w of [1, 4]) {
    assert.equal((await supDay().post('/api/attendance/checkin', { worker_id: w, site_id: 8, shift_type: 'Day', record_date: date, check_in_time: `${date} 07:00:00` })).status, 201);
    assert.equal((await supDay().post('/api/attendance/checkout', { worker_id: w, site_id: 8, shift_type: 'Day', record_date: date, check_out_time: `${date} 15:00:00` })).status, 200);
  }
  // Site lunch recorded for worker 4 only.
  const l = await supDay().post('/api/attendance/lunch/bulk', { siteId: 8, shift_type: 'Day', date,
    default_start_time: '12:00', default_end_time: '12:30', overrides: {}, excluded_worker_ids: [1] });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const rows = await q('SELECT worker_id, attendance_id FROM attendance WHERE site_id = 8 AND record_date = ? ORDER BY worker_id', [date]);
  return Object.fromEntries(rows.map((r) => [r.worker_id, r.attendance_id]));
}
const lunchOf = async (id) => q("SELECT TIME(leave_start_time) s, TIME(leave_end_time) e FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_type = 'Lunch'", [id]);
const hoursOf = async (id) => { const [r] = await q('SELECT total_working_hours t, overtime_hours o, status FROM attendance WHERE attendance_id = ?', [id]); return [Number(r.t) + Number(r.o), r.status]; };

test('SW7 single submit, "did not work lunch": the site lunch is deducted (same rule as Submit day)', async () => {
  const d2 = addDays(TODAY, -1);
  const ids = await dayWithSiteLunch(d2);
  const ask = await submitWorker(supDay(), { attendance_id: ids[1] });
  assert.equal(ask.body.requires_confirmation, true, JSON.stringify(ask.body));
  const ok = await submitWorker(supDay(), { attendance_id: ids[1], lunch_decision: { worked_through_lunch: false } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(await lunchOf(ids[1]), [{ s: '12:00:00', e: '12:30:00' }]);
  assert.deepEqual(await hoursOf(ids[1]), [7.5, 'Submitted']);
  assert.deepEqual(await hoursOf(ids[4]), [7.5, 'Draft']);
});

test('SW8 Submit day (unchanged): "did not work lunch" decision still deducts the site lunch', async () => {
  const d3 = addDays(TODAY, -3);
  const ids = await dayWithSiteLunch(d3);
  const ask = await supDay().post('/api/attendance/submit', { siteId: 8, shift_type: 'Day', record_date: d3 });
  assert.equal(ask.body.requires_confirmation, true, JSON.stringify(ask.body));
  assert.deepEqual(ask.body.missing_workers.map((w) => w.attendance_id), [ids[1]]);
  const ok = await supDay().post('/api/attendance/submit', { siteId: 8, shift_type: 'Day', record_date: d3,
    lunch_decisions: [{ attendance_id: ids[1], worked_through_lunch: false }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.submitted_records, 2);
  assert.deepEqual(await lunchOf(ids[1]), [{ s: '12:00:00', e: '12:30:00' }]);
  assert.deepEqual(await hoursOf(ids[1]), [7.5, 'Submitted']);
});

test('SW6 non-Present / missing record refused', async () => {
  const bad = await submitWorker(supDay(), { attendance_id: 0 });
  assert.equal(bad.status, 400);
  const none = await submitWorker(supDay(), { attendance_id: 99999999 });
  assert.equal(none.status, 404);
});
