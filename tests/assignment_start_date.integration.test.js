// tests/assignment_start_date.integration.test.js
//
// Change the start date of a worker assignment (Admin):
//   POST /api/assignments/:id/start-date { new_start_date, reason }
// Run:  npm test   (requires a local MySQL; see tests/helpers.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDatabase, startServer, stopServer, client, q } = require('./helpers');
const { businessToday, addDays } = require('../services/businessDate');

const admin = () => client(1, 'Admin');
const REASON = 'Attendance found before the start';
const ids = {};

async function worker(id, hire = '2026-04-01') {
  await q('INSERT INTO workers (worker_id, worker_unique_id, full_name, status, hire_date) VALUES (?, ?, ?, ?, ?)',
    [id, `W-${id}`, `Worker ${id}`, 'Active', hire]);
}
async function assign(key, workerId, siteId, from, to = null, shift = 'Day') {
  const r = await q(`INSERT INTO workersiteassignments (worker_id, site_id, contract_id, assigned_date, unassigned_date, shift_type)
                     VALUES (?, ?, 70, ?, ?, ?)`, [workerId, siteId, from, to, shift]);
  ids[key] = r.insertId;
}
async function att(workerId, siteId, date, shift = 'Day') {
  await q(`INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, check_out_time, attendance_status, status, shift_type, recorded_by_user_id)
           VALUES (?, ?, ?, ?, ?, 'Present', 'Approved', ?, 1)`, [workerId, siteId, date, `${date} 07:00:00`, `${date} 15:00:00`, shift]);
}
const change = (key, date, reason = REASON) => admin().post(`/api/assignments/${ids[key]}/start-date`, { new_start_date: date, reason });
const startOf = async (key) => (await q("SELECT DATE_FORMAT(assigned_date, '%Y-%m-%d') AS d FROM workersiteassignments WHERE assignment_id = ?", [ids[key]]))[0].d;

test.before(async () => {
  resetDatabase({ migrate: true });
  await startServer();
  await q("INSERT INTO projects (project_id, project_name) VALUES (70, 'P70')");
  await q("INSERT INTO contracts (contract_id, contract_name, project_id) VALUES (70, 'C70', 70)");
  await q(`INSERT INTO sites (site_id, site_name, site_status, contract_id, supports_shifts) VALUES
           (70, 'Site 70', 'Active', 70, 1), (71, 'Site 71', 'Active', 70, 0)`);

  await worker(701); await assign('A1', 701, 70, '2026-05-10');
  await att(701, 70, '2026-05-05'); await att(701, 70, '2026-05-07');

  await worker(702); await assign('B1', 702, 71, '2026-05-01', '2026-05-14'); await assign('B2', 702, 70, '2026-05-15');

  await worker(703); await assign('C1', 703, 70, '2026-05-01'); await att(703, 70, '2026-05-03');

  await worker(704); await assign('D1', 704, 70, '2026-05-01', '2026-05-10');

  // Finalized batch for site 70 (locks 2026-06-01..06-07); Generated (open) batch 06-20..06-27.
  await q(`INSERT INTO payrollbatches (start_date, end_date, generated_by_user_id, status, is_finalized, scope_site_id, batch_type)
           VALUES ('2026-06-01', '2026-06-07', 1, 'Generated', 1, 70, 'Regular')`);
  const open = await q(`INSERT INTO payrollbatches (start_date, end_date, generated_by_user_id, status, is_finalized, scope_site_id, batch_type)
           VALUES ('2026-06-20', '2026-06-27', 1, 'Generated', 0, 70, 'Regular')`);
  ids.openBatch = open.insertId;
  await worker(705); await assign('E1', 705, 70, '2026-06-05');
  await worker(706); await assign('F1', 706, 70, '2026-06-25');

  // Worker 707: Inactive from 2026-04-20, Active again from 2026-05-08.
  await worker(707);
  await q(`INSERT INTO worker_status_history (worker_id, old_status, new_status, effective_date) VALUES
           (707, 'Active', 'Inactive', '2026-04-20'), (707, 'Inactive', 'Active', '2026-05-08')`);
  await assign('G1', 707, 70, '2026-05-10');

  await worker(708); await assign('H1', 708, 70, '2026-05-10', '2026-05-09'); // cancelled (empty range)
  // Worker 709: Active, then Inactive inside the added days.
  await worker(709);
  await q(`INSERT INTO worker_status_history (worker_id, old_status, new_status, effective_date) VALUES
           (709, 'Active', 'Inactive', '2026-05-03'), (709, 'Inactive', 'Active', '2026-05-06')`);
  await assign('I1', 709, 70, '2026-05-10');
});
test.after(async () => { await stopServer(); });

test('SD1 earlier start covers the attendance before it, and is audited', async () => {
  const r = await change('A1', '2026-05-05');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.old_start_date, '2026-05-10');
  assert.equal(r.body.data.attendance_now_covered, 2);
  assert.deepEqual(r.body.data.payroll_batches_to_regenerate, []);
  assert.equal(await startOf('A1'), '2026-05-05');
  const [log] = await q("SELECT user_id, old_values, new_values FROM auditlogs WHERE table_name = 'workersiteassignments' AND record_id = ? AND action_type = 'ASSIGNMENT_START_CHANGED'", [ids.A1]);
  assert.ok(log, 'audit row written');
  const nv = typeof log.new_values === 'string' ? JSON.parse(log.new_values) : log.new_values;
  assert.equal(nv.reason, REASON);
  assert.equal(nv.assigned_date, '2026-05-05');
  // No orphan attendance left for this worker.
  const [orphan] = await q(`SELECT COUNT(*) AS c FROM attendance a WHERE a.worker_id = 701 AND NOT EXISTS (
      SELECT 1 FROM workersiteassignments w WHERE w.worker_id = a.worker_id AND w.site_id = a.site_id AND w.shift_type = a.shift_type
        AND w.assigned_date <= a.record_date AND (w.unassigned_date IS NULL OR w.unassigned_date >= a.record_date))`);
  assert.equal(Number(orphan.c), 0);
});

test('SD2 not before the hire date', async () => {
  const r = await change('A1', '2026-03-30');
  assert.equal(r.status, 409);
  assert.match(r.body.message, /hire date/);
  assert.equal(await startOf('A1'), '2026-05-05');
});

test('SD3 earlier start may not overlap another assignment', async () => {
  const r = await change('B2', '2026-05-10');
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Site 71/);
  assert.equal(await startOf('B2'), '2026-05-15');
});

test('SD4 later start refused when it would orphan attendance; allowed otherwise', async () => {
  let r = await change('C1', '2026-05-05');
  assert.equal(r.status, 409);
  assert.match(r.body.message, /2026-05-03/);
  r = await change('C1', '2026-05-02');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await startOf('C1'), '2026-05-02');
});

test('SD5 later start cannot pass the last day; cancelled assignment refused', async () => {
  let r = await change('D1', '2026-05-11');
  assert.equal(r.status, 409);
  r = await change('D1', '2026-05-10');
  assert.equal(r.status, 200, 'the last day itself is allowed (one-day assignment)');
  r = await change('H1', '2026-05-05');
  assert.equal(r.status, 409);
  assert.match(r.body.message, /cancelled/);
});

test('SD6 finalized payroll blocks; open (Generated) batch is returned for regeneration', async () => {
  let r = await change('E1', '2026-06-03');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'PAYROLL_PERIOD_FINALIZED');
  assert.equal(await startOf('E1'), '2026-06-05');
  r = await change('F1', '2026-06-21');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.payroll_batches_to_regenerate.map((b) => b.payroll_batch_id), [ids.openBatch]);
  assert.match(r.body.message, /Regenerate payroll batch/);
});

test('SD7 worker status history: must be Active on every added day', async () => {
  let r = await change('G1', '2026-05-06');
  assert.equal(r.status, 409);
  assert.match(r.body.message, /not Active/);
  r = await change('I1', '2026-05-01');
  assert.equal(r.status, 409);
  assert.match(r.body.message, /became Inactive on 2026-05-03/);
  r = await change('G1', '2026-05-08');
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('SD8 validation and access', async () => {
  let r = await change('A1', addDays(businessToday(), 1));
  assert.equal(r.status, 400);
  r = await change('A1', '2026-05-04', '');
  assert.equal(r.status, 400);
  r = await change('A1', '2026-05-05');
  assert.equal(r.status, 400, 'same date');
  r = await admin().post('/api/assignments/999999/start-date', { new_start_date: '2026-05-01', reason: REASON });
  assert.equal(r.status, 404);
  r = await client(11, 'Supervisor').post(`/api/assignments/${ids.A1}/start-date`, { new_start_date: '2026-05-04', reason: REASON });
  assert.equal(r.status, 403);
});
