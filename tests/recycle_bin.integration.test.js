// tests/recycle_bin.integration.test.js
//
// Recycle bin (safe delete with a 30-day undo window) — Staff.
// HTTP integration tests against the real controllers and a local MySQL 8
// database (see tests/helpers.js). Run: node --test tests/recycle_bin.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDatabase, startServer, stopServer, client, q } = require('./helpers');

const admin = () => client(1, 'Admin');
const supDay = () => client(11, 'Supervisor');

const AUG = { start_date: '2026-08-01', end_date: '2026-08-31', acknowledge_pending: true };
const JUN = { start_date: '2026-06-01', end_date: '2026-06-30', acknowledge_pending: true };
const OWNED = ['attendance_corrections_log', 'staff_overtime_compensations', 'staff_monthly_overtime_ledger', 'staff_payroll',
  'staff_attendance', 'staff_site_assignments', 'staff_supervisor_assignments', 'staff_compensation_history',
  'staff_status_history', 'staff_members'];
const WHERE = (t) => (t === 'attendance_corrections_log' ? "record_table = 'staff_attendance' AND person_id = ?" : 'staff_id = ?');

async function snapshot(staffId) {
  const out = {};
  for (const t of OWNED) {
    const rows = await q(`SELECT * FROM ${t} WHERE ${WHERE(t)} ORDER BY 1`, [staffId]);
    out[t] = JSON.parse(JSON.stringify(rows));
  }
  return out;
}
async function activeStaffBatch(start) {
  const [b] = await q("SELECT * FROM staff_payroll_batches WHERE start_date = ? AND status IN ('Generated','Paid') ORDER BY 1 DESC LIMIT 1", [start]);
  return b;
}
// Only the people created by this suite (seed staff 1 has no salary data for these periods).
async function staffIdsInBatch(batchId) {
  return (await q('SELECT staff_id FROM staff_payroll WHERE staff_payroll_batch_id = ? AND staff_id > 1 ORDER BY staff_id', [batchId])).map((r) => r.staff_id);
}

let before2;

test.before(async () => {
  resetDatabase({ migrate: true });
  global.__BASE__ = await startServer();
  await q("INSERT INTO system_settings (setting_key, setting_value) VALUES ('attendance_daily_gate_enabled', 'false') ON DUPLICATE KEY UPDATE setting_value = 'false'");
  await require('../services/settingsCache').refresh();

  // Staff 2: the one we delete. Staff 3: hired in June, paid in June.
  await q(`INSERT INTO staff_members (staff_id, staff_unique_id, full_name, position, site_id, hire_date, first_hire_date, monthly_salary, standard_daily_hours, status)
           VALUES (2, 'STF-10002', 'Test Wrong Entry', 'Clerk', 10, '2026-08-01', '2026-08-01', 900, 8, 'Active'),
                  (3, 'STF-10003', 'Paid Person', 'Clerk', 10, '2026-06-01', '2026-06-01', 800, 8, 'Active'),
                  (6, 'STF-10006', 'Colleague', 'Clerk', 10, '2026-08-01', '2026-08-01', 700, 8, 'Active')`);
  await q(`INSERT INTO staff_status_history (staff_id, old_status, new_status, effective_date, reason)
           VALUES (2, NULL, 'Active', '2026-08-01', 'hire'), (3, NULL, 'Active', '2026-06-01', 'hire'), (6, NULL, 'Active', '2026-08-01', 'hire')`);
  await q(`INSERT INTO staff_compensation_history (staff_id, monthly_salary, standard_daily_hours, effective_from, reason, changed_by_user_id)
           VALUES (2, 900, 8, '2026-08-01', 'initial', 1), (3, 800, 8, '2026-06-01', 'initial', 1), (6, 700, 8, '2026-08-01', 'initial', 1)`);
  await q("INSERT INTO staff_site_assignments (staff_id, site_id, assigned_date) VALUES (2, 10, '2026-08-01')");
  await q("INSERT INTO staff_supervisor_assignments (staff_id, supervisor_user_id, assigned_date) VALUES (2, 14, '2026-08-01')");
  for (const d of ['2026-08-03', '2026-08-04', '2026-08-05']) {
    await q(`INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, check_out_time, regular_hours, status, recorded_by_user_id)
             VALUES (2, ?, 'Present', ?, ?, 8, 'Approved', 14)`, [d, `${d} 08:00:00`, `${d} 16:00:00`]);
  }
  // Colleague (6) in August and the paid person (3) in June also worked, so their payroll is not empty.
  for (const [sid, d] of [[6, '2026-08-03'], [6, '2026-08-04'], [3, '2026-06-02'], [3, '2026-06-03']]) {
    await q(`INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, check_out_time, regular_hours, status, recorded_by_user_id)
             VALUES (?, ?, 'Present', ?, ?, 8, 'Approved', 14)`, [sid, d, `${d} 08:00:00`, `${d} 16:00:00`]);
  }
  const [att] = await q('SELECT staff_attendance_id FROM staff_attendance WHERE staff_id = 2 ORDER BY 1 LIMIT 1');
  await q(`INSERT INTO attendance_corrections_log (record_table, record_id, person_id, record_date, original_values, corrected_values, reason, corrected_by_user_id, corrected_at)
           VALUES ('staff_attendance', ?, 2, '2026-08-03', JSON_OBJECT('a', 1), JSON_OBJECT('a', 2), 'test correction', 1, NOW())`, [att.staff_attendance_id]);
});
test.after(async () => { await stopServer(); });

// ---------------------------------------------------------------------------
test('RB1 Generated (not finalized) batch -> VOID_REQUIRED; delete refused and nothing changes', async () => {
  const g = await admin().post('/api/staff-payroll/generate', AUG);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.deepEqual(await staffIdsInBatch(g.body.batch_id), [2, 6]);
  before2 = await snapshot(2);
  assert.ok(before2.staff_payroll.length === 1 && before2.staff_attendance.length === 3);

  const chk = await admin().get('/api/staff/2/deletion-check');
  assert.equal(chk.status, 200, JSON.stringify(chk.body));
  assert.equal(chk.body.data.can_delete, false);
  assert.deepEqual(chk.body.data.blockers.map((b) => [b.code, b.batch_id, b.action]), [['VOID_REQUIRED', g.body.batch_id, 'void']]);

  const del = await admin().del('/api/staff/2', { reason: 'Added by mistake', confirm_name: 'Test Wrong Entry' });
  assert.equal(del.status, 409); assert.equal(del.body.code, 'DELETE_BLOCKED');
  assert.deepEqual(await snapshot(2), before2, 'nothing changed');
});

test('RB2 validation: Admin only, reason required, exact name required', async () => {
  assert.equal((await supDay().get('/api/staff/2/deletion-check')).status, 403);
  assert.equal((await supDay().del('/api/staff/2', { reason: 'xxxxxx', confirm_name: 'Test Wrong Entry' })).status, 403);
  assert.equal((await supDay().get('/api/recycle-bin')).status, 403);
  const b = await activeStaffBatch('2026-08-01');
  await admin().patch(`/api/staff-payroll/batch/${b.staff_payroll_batch_id}/void`, { reason: 'remove wrong staff entry' });
  const noReason = await admin().del('/api/staff/2', { confirm_name: 'Test Wrong Entry' });
  assert.equal(noReason.status, 400); assert.equal(noReason.body.code, 'REASON_REQUIRED');
  const wrongName = await admin().del('/api/staff/2', { reason: 'Added by mistake', confirm_name: 'test wrong' });
  assert.equal(wrongName.status, 400); assert.equal(wrongName.body.code, 'CONFIRM_NAME_MISMATCH');
  assert.deepEqual(await snapshot(2), before2, 'nothing changed');
});

test('RB3 delete after void: every row leaves the live tables, voided batch header unchanged, payroll regenerates without him', async () => {
  const [voided] = await q("SELECT * FROM staff_payroll_batches WHERE status = 'Voided' ORDER BY 1 DESC LIMIT 1");
  const chk = await admin().get('/api/staff/2/deletion-check');
  assert.equal(chk.body.data.can_delete, true, JSON.stringify(chk.body.data.blockers));
  assert.equal(chk.body.data.row_counts.staff_attendance, 3);

  const del = await admin().del('/api/staff/2', { reason: 'Added by mistake', confirm_name: 'Test Wrong Entry' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const after = await snapshot(2);
  for (const t of OWNED) assert.equal(after[t].length, 0, `${t} emptied`);

  const [rb] = await q('SELECT * FROM recycle_bin WHERE recycle_id = ?', [del.body.data.recycle_id]);
  assert.equal(rb.status, 'Deleted'); assert.equal(rb.entity_code, 'STF-10002');
  const [{ d }] = await q('SELECT DATEDIFF(purge_after, deleted_at) d FROM recycle_bin WHERE recycle_id = ?', [rb.recycle_id]);
  assert.equal(Number(d), 30);
  const [vAfter] = await q('SELECT total_amount, total_staff FROM staff_payroll_batches WHERE staff_payroll_batch_id = ?', [voided.staff_payroll_batch_id]);
  assert.deepEqual([vAfter.total_amount, vAfter.total_staff], [voided.total_amount, voided.total_staff], 'history header kept');
  const [audit] = await q("SELECT new_values FROM auditlogs WHERE action_type = 'DELETED_TO_RECYCLE_BIN' AND record_id = 2");
  assert.ok(audit, 'audited');

  const list = await admin().get('/api/staff');
  assert.ok(!JSON.stringify(list.body).includes('Test Wrong Entry'), 'not in staff list');
  const bin = await admin().get('/api/recycle-bin');
  assert.equal(bin.body.data.length, 1); assert.equal(bin.body.data[0].entity_name, 'Test Wrong Entry');
  assert.equal(bin.body.data[0].payload, undefined, 'payload never sent to the app');

  const g = await admin().post('/api/staff-payroll/generate', AUG);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.deepEqual(await staffIdsInBatch(g.body.batch_id), [6], 'new payroll without the deleted staff');
});

test('RB4 restore is refused while a batch generated without him covers his employment; after void it restores every row identically', async () => {
  const [rb] = await q("SELECT recycle_id FROM recycle_bin WHERE status = 'Deleted' AND entity_id = 2");
  const blocked = await admin().post(`/api/recycle-bin/${rb.recycle_id}/restore`, { reason: 'Deleted the wrong person' });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'RESTORE_BLOCKED');
  assert.equal(blocked.body.blockers[0].code, 'VOID_REQUIRED');
  assert.equal((await snapshot(2)).staff_members.length, 0, 'nothing restored');

  const b = await activeStaffBatch('2026-08-01');
  await admin().patch(`/api/staff-payroll/batch/${b.staff_payroll_batch_id}/void`, { reason: 'regenerate with restored staff' });
  const ok = await admin().post(`/api/recycle-bin/${rb.recycle_id}/restore`, { reason: 'Deleted the wrong person' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(await snapshot(2), before2, 'identical rows with the original ids');
  const [st] = await q('SELECT status, JSON_LENGTH(payload) n FROM recycle_bin WHERE recycle_id = ?', [rb.recycle_id]);
  assert.deepEqual([st.status, Number(st.n)], ['Restored', 0], 'archived copy cleared after restore');
  const again = await admin().post(`/api/recycle-bin/${rb.recycle_id}/restore`, { reason: 'twice' });
  assert.equal(again.status, 409);

  const g = await admin().post('/api/staff-payroll/generate', AUG);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.deepEqual(await staffIdsInBatch(g.body.batch_id), [2, 6], 'included again after restore');
});

test('RB5 finalized batch: hold -> excluded from new payroll -> supersede -> delete; hold released', async () => {
  const b = await activeStaffBatch('2026-08-01');
  assert.equal((await admin().patch(`/api/staff-payroll/batch/${b.staff_payroll_batch_id}/finalize`)).status, 200);

  let chk = await admin().get('/api/staff/2/deletion-check');
  assert.deepEqual(chk.body.data.blockers.map((x) => [x.code, x.action]), [['SUPERSEDE_REQUIRED', 'hold']]);
  const hold = await admin().post('/api/staff/2/deletion-hold', { reason: 'Wrong entry, removing' });
  assert.equal(hold.status, 201, JSON.stringify(hold.body));
  assert.equal((await admin().post('/api/staff/2/deletion-hold', { reason: 'Wrong entry, removing' })).status, 409, 'one open hold');
  chk = await admin().get('/api/staff/2/deletion-check');
  assert.deepEqual(chk.body.data.blockers.map((x) => [x.code, x.action]), [['SUPERSEDE_REQUIRED', 'supersede']]);

  const sup = await admin().post(`/api/staff-payroll/batch/${b.staff_payroll_batch_id}/new-version`, { reason: 'remove wrong staff entry', acknowledge_pending: true });
  assert.equal(sup.status, 201, JSON.stringify(sup.body));
  assert.deepEqual(await staffIdsInBatch(sup.body.batch_id), [6], 'held staff excluded from the new version');

  const del = await admin().del('/api/staff/2', { reason: 'Added by mistake', confirm_name: 'Test Wrong Entry' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const holds = await q("SELECT released_at FROM entity_deletion_holds WHERE entity_type = 'Staff' AND entity_id = 2");
  assert.ok(holds.every((h) => h.released_at), 'hold released by the delete');
});

test('RB6 restore after a finalized batch generated during the hold: refused only by the non-finalized one', async () => {
  const [rb] = await q("SELECT recycle_id, DATE_FORMAT(excluded_since, '%Y-%m-%d %H:%i:%s') es FROM recycle_bin WHERE status = 'Deleted' AND entity_id = 2");
  const [h] = await q("SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') c FROM entity_deletion_holds WHERE entity_id = 2 ORDER BY 1 DESC LIMIT 1");
  assert.equal(rb.es, h.c, 'excluded since the hold started, not since the delete');
  const r = await admin().post(`/api/recycle-bin/${rb.recycle_id}/restore`, { reason: 'check blockers' });
  assert.equal(r.status, 409); assert.equal(r.body.blockers[0].code, 'VOID_REQUIRED', 'the replacement made during the hold is detected');
});

test('RB7 paid payroll: never deleted', async () => {
  const g = await admin().post('/api/staff-payroll/generate', JUN);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.deepEqual(await staffIdsInBatch(g.body.batch_id), [3]);
  await admin().patch(`/api/staff-payroll/batch/${g.body.batch_id}/finalize`);
  assert.equal((await admin().patch(`/api/staff-payroll/batch/${g.body.batch_id}/mark-paid`)).status, 200);
  const chk = await admin().get('/api/staff/3/deletion-check');
  assert.deepEqual(chk.body.data.blockers.map((x) => x.code), ['PAID_PAYROLL']);
  const del = await admin().del('/api/staff/3', { reason: 'try paid', confirm_name: 'Paid Person' });
  assert.equal(del.status, 409);
  assert.equal((await q('SELECT COUNT(*) c FROM staff_payroll WHERE staff_id = 3'))[0].c, 1);
});

test('RB8 safety nets: biometric mapping and unknown dependent tables block the delete', async () => {
  await q(`INSERT INTO staff_members (staff_id, staff_unique_id, full_name, hire_date, first_hire_date, monthly_salary, status)
           VALUES (4, 'STF-10004', 'Bio Person', '2026-10-01', '2026-10-01', 500, 'Active')`);
  await q("INSERT INTO attendance_device_users (device_employee_id, entity_type, staff_id, effective_from) VALUES ('777', 'Staff', 4, '2026-10-01')");
  let chk = await admin().get('/api/staff/4/deletion-check');
  assert.deepEqual(chk.body.data.blockers.map((x) => x.code), ['BIOMETRIC_DATA']);
  await q("DELETE FROM attendance_device_users WHERE staff_id = 4");

  await q('CREATE TABLE zz_future_table (id INT PRIMARY KEY AUTO_INCREMENT, staff_id INT NOT NULL, CONSTRAINT fk_zz FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id))');
  await q('INSERT INTO zz_future_table (staff_id) VALUES (4)');
  chk = await admin().get('/api/staff/4/deletion-check');
  assert.deepEqual(chk.body.data.blockers.map((x) => x.code), ['UNHANDLED_DEPENDENCY']);
  const del = await admin().del('/api/staff/4', { reason: 'test future table', confirm_name: 'Bio Person' });
  assert.equal(del.status, 409);
  await q('DROP TABLE zz_future_table');
  chk = await admin().get('/api/staff/4/deletion-check');
  assert.equal(chk.body.data.can_delete, true);
});

test('RB9 purge: expired entries are removed for good; only ids stay in the audit; purge-now works; purged entries cannot be restored', async () => {
  const [rb] = await q("SELECT recycle_id FROM recycle_bin WHERE status = 'Deleted' AND entity_id = 2");
  await q('UPDATE recycle_bin SET purge_after = NOW() - INTERVAL 1 MINUTE WHERE recycle_id = ?', [rb.recycle_id]);
  const n = await require('../services/recycleBinService').purgeExpired();
  assert.equal(n, 1);
  assert.equal((await q('SELECT COUNT(*) c FROM recycle_bin WHERE recycle_id = ?', [rb.recycle_id]))[0].c, 0);
  const [a] = await q("SELECT old_values, new_values FROM auditlogs WHERE action_type = 'PURGED_FROM_RECYCLE_BIN' AND record_id = 2");
  assert.ok(a && !JSON.stringify(a).includes('Test Wrong Entry'), 'no name in the purge audit');
  assert.equal((await admin().post(`/api/recycle-bin/${rb.recycle_id}/restore`, { reason: 'too late' })).status, 404);

  const del = await admin().del('/api/staff/4', { reason: 'test purge now', confirm_name: 'Bio Person' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const p = await admin().del(`/api/recycle-bin/${del.body.data.recycle_id}`, { reason: 'empty the bin' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await admin().get('/api/recycle-bin')).body.data.length, 0);
});

test('RB10 hold can be released and the staff member is included again', async () => {
  await q(`INSERT INTO staff_members (staff_id, staff_unique_id, full_name, hire_date, first_hire_date, monthly_salary, status)
           VALUES (5, 'STF-10005', 'Hold Person', '2026-09-01', '2026-09-01', 500, 'Active')`);
  await q("INSERT INTO staff_status_history (staff_id, old_status, new_status, effective_date, reason) VALUES (5, NULL, 'Active', '2026-09-01', 'hire')");
  await q("INSERT INTO staff_compensation_history (staff_id, monthly_salary, standard_daily_hours, effective_from, reason, changed_by_user_id) VALUES (5, 500, 8, '2026-09-01', 'initial', 1)");
  for (const sid of [5, 6]) {
    await q(`INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, check_out_time, regular_hours, status, recorded_by_user_id)
             VALUES (?, '2026-09-02', 'Present', '2026-09-02 08:00:00', '2026-09-02 16:00:00', 8, 'Approved', 14)`, [sid]);
  }
  assert.equal((await admin().post('/api/staff/5/deletion-hold', { reason: 'maybe delete' })).status, 201);
  const SEP = { start_date: '2026-09-01', end_date: '2026-09-30', acknowledge_pending: true };
  let g = await admin().post('/api/staff-payroll/generate', SEP);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.ok(!(await staffIdsInBatch(g.body.batch_id)).includes(5));
  await admin().patch(`/api/staff-payroll/batch/${g.body.batch_id}/void`, { reason: 'regenerate after release' });
  assert.equal((await admin().del('/api/staff/5/deletion-hold', { reason: 'keep him after all' })).status, 200);
  g = await admin().post('/api/staff-payroll/generate', SEP);
  assert.ok((await staffIdsInBatch(g.body.batch_id)).includes(5));
});
