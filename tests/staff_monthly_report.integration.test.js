// tests/staff_monthly_report.integration.test.js
//
// Monthly staff hours & payroll report: pay columns must come only from the
// active batch of the period (Generated or Paid). Voided and Superseded
// batches are history and must never be added again.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDatabase, startServer, stopServer, client, q } = require('./helpers');
const { businessToday, addDays } = require('../services/businessDate');

const TODAY = businessToday();
const [ty, tm] = TODAY.slice(0, 7).split('-').map(Number);
const prev = new Date(Date.UTC(ty, tm - 2, 1));
const PY = prev.getUTCFullYear();
const PM = prev.getUTCMonth() + 1;
const PREV = `${PY}-${String(PM).padStart(2, '0')}`;
const LAST = `${PREV}-${String(new Date(Date.UTC(PY, PM, 0)).getUTCDate()).padStart(2, '0')}`;
const PERIOD = { start_date: `${PREV}-01`, end_date: LAST, acknowledge_pending: true };
const admin = () => client(1, 'Admin');

const kpi = (spec, label) => spec.kpis.find((k) => k.label === label).value;
async function report() {
  const { loadSpec } = require('../services/staffMonthlyReportService');
  return loadSpec(String(PM), String(PY));
}

test.before(async () => {
  resetDatabase({ migrate: true });
  await startServer();
  await q("INSERT INTO system_settings (setting_key, setting_value) VALUES ('attendance_daily_gate_enabled', 'false') ON DUPLICATE KEY UPDATE setting_value = 'false'");
  await require('../services/settingsCache').refresh();
  for (let ds = `${PREV}-01`; ds <= LAST; ds = addDays(ds, 1)) {
    if (new Date(`${ds}T00:00:00Z`).getUTCDay() === 5) continue;
    await q(`INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, check_out_time,
                                           regular_hours, overtime_hours, status, recorded_by_user_id, standard_minutes_snapshot)
             VALUES (1, ?, 'Present', ?, ?, 8, 0, 'Approved', 14, 480)`, [ds, `${ds} 08:00:00`, `${ds} 16:00:00`]);
  }
});
test.after(async () => { await stopServer(); });

test('MR1 voided and superseded batches are not added to the pay columns', async () => {
  const g1 = await admin().post('/api/staff-payroll/generate', PERIOD);
  assert.equal(g1.status, 201, JSON.stringify(g1.body));
  const net = Number((await q('SELECT net_salary FROM staff_payroll WHERE staff_payroll_batch_id = ?', [g1.body.batch_id]))[0].net_salary);
  assert.equal(kpi(await report(), 'Total Payroll'), net);

  // Void + generate again (twice), then finalize + supersede: still ONE salary.
  for (let i = 0; i < 2; i += 1) {
    const [{ id }] = await q("SELECT staff_payroll_batch_id AS id FROM staff_payroll_batches WHERE status = 'Generated'");
    assert.equal((await admin().patch(`/api/staff-payroll/batch/${id}/void`, { reason: 'regenerate check' })).status, 200);
    assert.equal((await admin().post('/api/staff-payroll/generate', PERIOD)).status, 201);
  }
  const [{ id }] = await q("SELECT staff_payroll_batch_id AS id FROM staff_payroll_batches WHERE status = 'Generated'");
  await admin().patch(`/api/staff-payroll/batch/${id}/finalize`);
  const s = await admin().post(`/api/staff-payroll/batch/${id}/new-version`, { reason: 'supersede check', acknowledge_pending: true });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(Number((await q('SELECT COUNT(*) c FROM staff_payroll_batches'))[0].c), 4, '2 voided + 1 superseded + 1 active');

  const spec = await report();
  assert.equal(kpi(spec, 'Total Payroll'), net, 'one salary, not one per batch version');
  assert.equal(kpi(spec, 'Basic Pay'), net);
  assert.ok(spec.notes.some((n) => n.includes(`#${s.body.batch_id}`)));
  assert.ok(!spec.notes.some((n) => /Voided/.test(n)), 'voided batches are not listed as payroll batches');
});
