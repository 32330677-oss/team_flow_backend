// tests/daily_gate.integration.test.js
//
// Daily submission gate (services/dailyGate.js) — HTTP integration tests.
// Run:  npm test   (requires a local MySQL; see tests/helpers.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDatabase, startServer, stopServer, client, q } = require('./helpers');
const { businessToday, addDays } = require('../services/businessDate');

const TODAY = businessToday();
const admin = () => client(1, 'Admin');
const supBridges = () => client(12, 'Supervisor'); // site 10 (no shifts -> Day), worker 3
const supDay = () => client(11, 'Supervisor');     // site 8 Day, workers 1 and 4

// F = the latest Friday strictly before TODAY; W = Wed, T = Thu, S = Sat (S <= TODAY).
function dow(d) { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); }
let F = addDays(TODAY, -1);
while (dow(F) !== 5) F = addDays(F, -1);
const W = addDays(F, -2);
const T = addDays(F, -1);
const S = addDays(F, 1);

async function setGate(values) {
  for (const [k, v] of Object.entries(values)) {
    await q('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [k, v]);
  }
  await require('../services/settingsCache').refresh();
}

async function submit(c, siteId, date, shift = 'Day') {
  let r = await c.post('/api/attendance/submit', { siteId, shift_type: shift, record_date: date });
  if (r.body.requires_confirmation) {
    r = await c.post('/api/attendance/submit', { siteId, shift_type: shift, record_date: date,
      confirmed_lunch_skips: r.body.missing_workers.map((w) => ({ attendance_id: w.attendance_id, reason: 'test' })) });
  }
  return r;
}

test.before(async () => {
  resetDatabase({ migrate: true });
  await startServer();
  await setGate({ attendance_daily_gate_enabled: 'true', attendance_daily_gate_start_date: W });
});
test.after(async () => { await stopServer(); });

test('G1 a skipped day blocks recording a later day; an empty Friday is not listed', async () => {
  const r = await supBridges().post('/api/attendance/status', { worker_id: 3, site_id: 10, record_date: S, attendance_status: 'Absent' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'PREVIOUS_DAY_UNSUBMITTED');
  assert.equal(r.body.pending_days[0].record_date, W);
  assert.equal(r.body.pending_days[0].reason, 'not_recorded');
  const view = await supBridges().get(`/api/attendance/sites/10/workers?record_date=${S}`);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.day.pending_days.map((d) => d.record_date), [W, T], 'Friday (empty) is skipped');
  assert.equal(view.body.day.daily_gate_applies, true);
  const bulkIn = await supBridges().post('/api/attendance/bulk/checkin', { worker_ids: [3], site_id: 10, record_date: S, check_in_time: `${S} 07:00:00` });
  assert.equal(bulkIn.status, 409);
});

test('G2 admin is never gated', async () => {
  const sup = await supDay().post('/api/attendance/status', { worker_id: 1, site_id: 8, shift_type: 'Day', record_date: S, attendance_status: 'Holiday' });
  assert.equal(sup.status, 409);
  const adm = await admin().post('/api/attendance/status', { worker_id: 1, site_id: 8, shift_type: 'Day', record_date: S, attendance_status: 'Holiday' });
  assert.equal(adm.status, 201, JSON.stringify(adm.body));
});

test('G3 days in order: Draft blocks the next day until submitted; empty Friday is skipped', async () => {
  assert.equal((await supBridges().post('/api/attendance/status', { worker_id: 3, site_id: 10, record_date: W, attendance_status: 'Absent' })).status, 201);
  const blocked = await supBridges().post('/api/attendance/status', { worker_id: 3, site_id: 10, record_date: T, attendance_status: 'Absent' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.pending_days[0].reason, 'draft');
  assert.equal((await submit(supBridges(), 10, W)).status, 200);
  assert.equal((await supBridges().post('/api/attendance/status', { worker_id: 3, site_id: 10, record_date: T, attendance_status: 'Holiday' })).status, 201);
  assert.equal((await submit(supBridges(), 10, T)).status, 200);
  // Friday left empty -> Saturday is open.
  const sat = await supBridges().post('/api/attendance/status', { worker_id: 3, site_id: 10, record_date: S, attendance_status: 'Absent' });
  assert.equal(sat.status, 201, JSON.stringify(sat.body));
});

test('G4 a Friday WITH Draft records must be submitted before the next day', async () => {
  assert.equal((await supBridges().post('/api/attendance/status', { worker_id: 3, site_id: 10, record_date: F, attendance_status: 'Absent' })).status, 201);
  const blocked = await submit(supBridges(), 10, S);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'PREVIOUS_DAY_UNSUBMITTED');
  assert.equal(blocked.body.pending_days[0].record_date, F);
  assert.equal((await submit(supBridges(), 10, F)).status, 200);
  assert.equal((await submit(supBridges(), 10, S)).status, 200);
});

test('G5 forgotten worker (back-dated assignment) on a submitted day: record and submit him alone', async () => {
  // Admin rejects worker 3 on T, then back-dates an assignment of worker 4 to site 10 for W..T.
  const [w3T] = await q('SELECT attendance_id FROM attendance WHERE worker_id = 3 AND site_id = 10 AND record_date = ?', [T]);
  const rej = await admin().post('/api/admin/attendance/review', { attendance_id: w3T.attendance_id, status: 'Rejected', admin_note: 'check' });
  assert.equal(rej.status, 200, JSON.stringify(rej.body));
  await q("INSERT INTO workersiteassignments (worker_id, site_id, contract_id, assigned_date, unassigned_date, shift_type) VALUES (4, 10, 7, ?, ?, 'Day')", [W, T]);

  // Submitted days with one missing worker never block later days.
  const today = await supBridges().get(`/api/attendance/sites/10/workers?record_date=${S}`);
  assert.deepEqual(today.body.day.pending_days, []);

  const [w3W] = await q('SELECT attendance_id, status FROM attendance WHERE worker_id = 3 AND site_id = 10 AND record_date = ?', [W]);
  for (const day of [W, T]) {
    const view = await supBridges().get(`/api/attendance/sites/10/workers?record_date=${day}`);
    const w4 = view.body.data.find((w) => w.worker_id === 4);
    assert.ok(w4 && w4.attendance_id === null, 'worker 4 shows as not recorded');
    assert.equal((await supBridges().post('/api/attendance/status', { worker_id: 4, site_id: 10, record_date: day, attendance_status: 'Absent' })).status, 201);
    const sub = await submit(supBridges(), 10, day);
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    assert.equal(sub.body.submitted_records, 1, 'only the forgotten worker is submitted');
  }
  const [afterW] = await q('SELECT attendance_id, status FROM attendance WHERE worker_id = 3 AND site_id = 10 AND record_date = ?', [W]);
  assert.deepEqual(afterW, w3W, 'the already submitted record is untouched');
  const [afterT] = await q('SELECT status FROM attendance WHERE worker_id = 3 AND site_id = 10 AND record_date = ?', [T]);
  assert.equal(afterT.status, 'Rejected', 'the rejected record keeps its own flow');
});

test('G6 the gate can be switched off by the Admin setting', async () => {
  await setGate({ attendance_daily_gate_enabled: 'false' });
  const view = await supDay().get(`/api/attendance/sites/8/workers?record_date=${S}&shift_type=Day`);
  assert.deepEqual(view.body.day.pending_days, []);
  const r = await supDay().post('/api/attendance/status', { worker_id: 4, site_id: 8, shift_type: 'Day', record_date: S, attendance_status: 'Holiday' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await setGate({ attendance_daily_gate_enabled: 'true' });
});
