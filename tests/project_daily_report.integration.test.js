// tests/project_daily_report.integration.test.js
//
// PROJECT DAILY REPORT (Word, Team Flow + Equipment Flow) — HTTP integration tests.
// The equipment API is replaced by a small local HTTP server that answers like
// equipment_asik_backend /api/integration/* (same JSON shape, token checked).
// Run:  npm test   (requires a local MySQL; see tests/helpers.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { resetDatabase, startServer, stopServer, client, q, token } = require('./helpers');
const { businessToday } = require('../services/businessDate');

const D = businessToday();
const admin = () => client(1, 'Admin');
const EQ_TOKEN = 'eq-integration-token-eq-integration-token-01';
let eqServer;
let eqCalls = [];
let eqDown = false;

function startFakeEquipment() {
  eqServer = http.createServer((req, res) => {
    eqCalls.push(req.url);
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (eqDown) return send(500, { status: 'error', message: 'boom' });
    if (req.headers.authorization !== `Bearer ${EQ_TOKEN}`) return send(401, { status: 'error', message: 'Invalid integration token.' });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/integration/sites') {
      return send(200, { status: 'success', data: [{ site_id: 8, site_code: 'S08', site_name: 'T2 Underground', status: 'Active' }] });
    }
    if (u.pathname === '/api/integration/daily-plant') {
      return send(200, {
        status: 'success',
        data: {
          date: u.searchParams.get('date'),
          sites: [{ site_id: 8, site_code: 'S08', site_name: 'T2 Underground' }],
          types: [
            { type_id: 2, type_name: 'Wheel Loader', machines: 2, working: 1, breakdown: 1, standby: 0, pending: 0, absent: 0, holiday: 0 },
            { type_id: 6, type_name: 'Dump Truck', machines: 4, working: 3, breakdown: 0, standby: 0, pending: 1, absent: 0, holiday: 0 },
            { type_id: 7, type_name: 'Roller', machines: 2, working: 1, breakdown: 0, standby: 1, pending: 0, absent: 0, holiday: 0 },
            { type_id: 99, type_name: 'Jack Hammer', machines: 1, working: 1, breakdown: 0, standby: 0, pending: 0, absent: 0, holiday: 0 },
            { type_id: 98, type_name: 'Laser Level', machines: 1, working: 1, breakdown: 0, standby: 0, pending: 0, absent: 0, holiday: 0 },
          ],
          totals: { machines: 10 },
          work_descriptions: [{ site_id: 8, site_name: 'T2 Underground', type_name: 'Wheel Loader', text: 'Backfill by aggregate for water supply trench' }],
        },
      });
    }
    return send(404, { status: 'error', message: 'not found' });
  });
  return new Promise((r) => eqServer.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${eqServer.address().port}/api`)));
}

async function seed() {
  await q("INSERT INTO projects (project_id, project_name, client_name, location) VALUES (60, 'Airport Road', 'Ministry of Transport', 'Damascus International Airport')");
  await q("INSERT INTO contracts (contract_id, contract_name, project_id, start_date) VALUES (60, 'Agreement 71', 60, '2025-03-18')");
  await q(`INSERT INTO sites (site_id, site_name, site_status, contract_id, supports_shifts) VALUES
    (60, 'T2 Underground', 'Active', 60, 1), (61, 'Old Yard', 'Suspended', 60, 0)`);
  const workers = [[601, 'Foreman'], [602, 'Labourer'], [603, 'Labourer'], [604, 'Carpenter'], [605, 'Tea Boy']];
  for (const [id, pos] of workers) {
    await q("INSERT INTO workers (worker_id, worker_unique_id, full_name, job_position, status) VALUES (?, ?, ?, ?, 'Active')", [id, `W-${id}`, `Worker ${id}`, pos]);
    await q("INSERT INTO workersiteassignments (worker_id, site_id, contract_id, assigned_date, shift_type) VALUES (?, 60, 60, '2026-01-01', ?)", [id, id === 603 ? 'Night' : 'Day']);
  }
  const present = [[601, 'Day'], [602, 'Day'], [603, 'Night'], [605, 'Day']];
  for (const [w, sh] of present) {
    await q(`INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, attendance_status, status, shift_type, recorded_by_user_id)
             VALUES (?, 60, ?, ?, 'Present', 'Draft', ?, 1)`, [w, D, `${D} 07:00:00`, sh]);
  }
  await q(`INSERT INTO attendance (worker_id, site_id, record_date, attendance_status, status, shift_type, recorded_by_user_id)
           VALUES (604, 60, ?, 'Absent', 'Draft', 'Day', 1)`, [D]);
  await q(`INSERT INTO staff_members (staff_id, staff_unique_id, full_name, position, hire_date, first_hire_date, monthly_salary, standard_daily_hours, status) VALUES
    (61, 'S-61', 'Eng A', 'Site Engineer', '2026-01-01', '2026-01-01', 1000, 8, 'Active'),
    (62, 'S-62', 'Eng B', 'Site Engineer', '2026-01-01', '2026-01-01', 1000, 8, 'Active'),
    (63, 'S-63', 'Keeper', 'Timekeeper', '2026-01-01', '2026-01-01', 800, 8, 'Active')`);
  await q("INSERT INTO staff_site_assignments (staff_id, site_id, assigned_date) VALUES (61, 60, '2026-01-01'), (62, 60, '2026-01-01'), (63, 60, '2026-01-01')");
  await q("INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, status) VALUES (61, ?, 'Present', ?, 'Draft'), (63, ?, 'Present', ?, 'Draft')",
    [D, `${D} 07:30:00`, D, `${D} 07:10:00`]);
  // a Daily Site Report of the same day with weather and work notes
  await q(`INSERT INTO daily_site_reports (report_no, report_date, shift_filter, site_ids, issued_by_name, options, totals, payload, generated_by_user_id, generated_at)
           VALUES ('DSR-X', ?, 'All', '[60]', 'X', '{}', '{}', ?, 1, NOW())`,
  [D, JSON.stringify({ layout: 2, sites: [{ site_id: 60, site_name: 'T2 Underground', notes: { weather: 'sunny', work_done: '- Cleaning manholes' } }] })]);
}

async function docx(url, body) {
  const res = await fetch(`${globalThis.__base}${url}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(1, 'Admin')}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, reportNo: res.headers.get('x-report-no'), warnings: res.headers.get('x-report-warnings'), type: res.headers.get('content-type') };
}

let profileId;

test.before(async () => {
  resetDatabase({ migrate: true });
  process.env.EQUIPMENT_API_URL = await startFakeEquipment();
  process.env.EQUIPMENT_INTEGRATION_TOKEN = EQ_TOKEN;
  globalThis.__base = await startServer();
  await seed();
});
test.after(async () => {
  await stopServer();
  await new Promise((r) => eqServer.close(r));
});

test('P1 Admin only', async () => {
  const sup = client(11, 'Supervisor');
  assert.equal((await sup.get('/api/reports/project-daily/options')).status, 403);
  assert.equal((await client(null).get('/api/reports/project-daily/options')).status, 401);
});

test('P2 options: profiles, Team Flow sites, equipment sites through the integration', async () => {
  const r = await admin().get('/api/reports/project-daily/options');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.equipment.ok, true);
  assert.deepEqual(r.body.data.equipment.sites.map((s) => s.site_code), ['S08']);
  assert.ok(r.body.data.team_flow_sites.some((s) => s.site_id === 60));
  assert.equal(r.body.data.defaults.config.plant_rows.length, 24);
  assert.ok(eqCalls.some((u) => u.startsWith('/api/integration/sites')));
});

test('P3 profile: create, validation, partial update', async () => {
  let r = await admin().post('/api/reports/project-daily/profiles', { name: 'x', config: {} });
  assert.equal(r.status, 400);
  r = await admin().post('/api/reports/project-daily/profiles', { name: 'Agreement 71', config: { tf_site_ids: [9999] } });
  assert.equal(r.status, 400, 'unknown Team Flow site');
  r = await admin().post('/api/reports/project-daily/profiles', {
    name: 'Agreement 71',
    config: {
      info: { consultant: 'DAR', agreement_title: 'Daily Report – Agreement 71', project_ref: '<b>[REF]</b>' },
      tf_site_ids: [60, 61, 60], eq_site_ids: [8], tool_rows: ['JACK HAMMER'],
      equipment_map: { 'Jack Hammer': 'JACK HAMMER' }, hacker: 'dropped',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  profileId = r.body.data.profile_id;
  const c = r.body.data.config;
  assert.deepEqual(c.tf_site_ids, [60, 61]);
  assert.equal(c.hacker, undefined);
  assert.equal(c.boq.length > 20, true, 'starts with the Agreement 71 BOQ');
  assert.equal(c.staff_rows[0], 'PROJECT DIRECTOR');
  r = await admin().post('/api/reports/project-daily/profiles', { name: 'Agreement 71', config: {} });
  assert.equal(r.status, 409);
  // partial update keeps the rest
  r = await admin().put(`/api/reports/project-daily/profiles/${profileId}`, { config: { staff_map: { 'Timekeeper ': 'TIME KEEPER' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.config.info.consultant, 'DAR');
  assert.equal(r.body.data.config.staff_map.timekeeper, 'TIME KEEPER');
});

test('P4 preview: manpower from Team Flow, plant from Equipment, mapping, warnings, suggestions', async () => {
  const r = await admin().post('/api/reports/project-daily/preview', { profile_id: profileId, date: D });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  const row = (list, label) => list.find((x) => x.label === label);
  // staff: 2 site engineers (1 present), 1 time keeper (present, via the saved mapping)
  assert.deepEqual(row(d.manpower.staff, 'SITE ENGINEER'), { label: 'SITE ENGINEER', total: 2, present: 1, absent: 1 });
  assert.deepEqual(row(d.manpower.staff, 'TIME KEEPER'), { label: 'TIME KEEPER', total: 1, present: 1, absent: 0 });
  // trades: Labourer -> UN-SKILLED LABOR (day + night), Foreman, Carpenter absent, Tea Boy -> own row (unmapped)
  assert.deepEqual(row(d.manpower.trades, 'UN-SKILLED LABOR'), { label: 'UN-SKILLED LABOR', total: 2, present: 2, absent: 0 });
  assert.deepEqual(row(d.manpower.trades, 'CARPENTER'), { label: 'CARPENTER', total: 1, present: 0, absent: 1 });
  assert.deepEqual(row(d.manpower.trades, 'TEA BOY'), { label: 'TEA BOY', total: 1, present: 1, absent: 0 });
  assert.deepEqual(d.unmapped.trades, ['Tea Boy']);
  assert.equal(d.manpower.grand_total, 3 + 5);
  // plant: Dump Truck -> TRUCK, Roller -> ROAD ROLLER (idle 1), Jack Hammer -> tool row, Laser Level -> extra plant row
  assert.deepEqual(row(d.plant.plant, 'WHEEL LOADER'), { label: 'WHEEL LOADER', operative: 1, breakdown: 1, idle: 0 });
  assert.deepEqual(row(d.plant.plant, 'TRUCK'), { label: 'TRUCK', operative: 3, breakdown: 0, idle: 0 });
  assert.deepEqual(row(d.plant.plant, 'ROAD ROLLER'), { label: 'ROAD ROLLER', operative: 1, breakdown: 0, idle: 1 });
  assert.deepEqual(row(d.plant.tools, 'JACK HAMMER'), { label: 'JACK HAMMER', operative: 1, breakdown: 0, idle: 0 });
  assert.deepEqual(d.unmapped.equipment, ['Laser Level']);
  assert.equal(d.plant.plant_total.operative, 1 + 3 + 1 + 1);
  assert.ok(d.warnings.some((w) => /1 machine\(s\) are deployed/.test(w)), JSON.stringify(d.warnings));
  assert.ok(d.warnings.some((w) => /not Active were skipped: 61/.test(w)));
  // info from Team Flow when the profile leaves it empty
  assert.equal(d.info.client, 'Ministry of Transport');
  assert.equal(d.info.commencement, '3/18/2025');
  // suggestions: DSR weather + work, equipment work
  assert.equal(d.suggestions.weather.sunny, true);
  assert.deepEqual(d.suggestions.activities.map((a) => a.description), ['Cleaning manholes', 'Backfill by aggregate for water supply trench']);
  // pending counted as operative when asked
  const p = await admin().post('/api/reports/project-daily/preview', { profile_id: profileId, date: D, pending_as_operative: true });
  assert.equal(p.body.data.plant.plant.find((x) => x.label === 'TRUCK').operative, 4);
});

test('P5 generate: a real .docx, numbered, saved, downloadable again identical', async () => {
  const body = {
    profile_id: profileId, date: D,
    weather: { sunny: true, temp_max: 28, temp_min: '18', humidity: 'medium' },
    activities: [{ description: 'Backfill by aggregate', location: 'Water supply' }, { description: '', location: '' }],
  };
  const r = await docx('/api/reports/project-daily/generate', body);
  assert.equal(r.status, 200, r.buf.toString().slice(0, 300));
  assert.match(r.type, /wordprocessingml/);
  assert.equal(r.buf.slice(0, 2).toString(), 'PK', 'a zip (docx)');
  assert.match(r.reportNo, new RegExp(`^PDR-${D.replace(/-/g, '')}-\\d{4}$`));
  assert.ok(Number(r.warnings) >= 1);
  const [row] = await q('SELECT report_id, payload FROM project_daily_reports WHERE report_no = ?', [r.reportNo]);
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  assert.equal(payload.activities.length, 1, 'empty activity dropped');
  assert.equal(payload.weather.humidity, 'medium');
  const again = await docx(`/api/reports/project-daily/${row.report_id}/docx`);
  assert.equal(again.status, 200);
  assert.equal(again.reportNo, r.reportNo);
  const h = await admin().get('/api/reports/project-daily/history');
  assert.equal(h.body.data[0].report_no, r.reportNo);
});

test('P6 sections switched off are not printed; equipment down never blocks the report', async () => {
  eqDown = true;
  try {
    const p = await admin().post('/api/reports/project-daily/preview', { profile_id: profileId, date: D });
    assert.equal(p.status, 200);
    assert.ok(p.body.data.warnings.some((w) => /Equipment system/.test(w)));
    assert.equal(p.body.data.plant.plant_total.operative, 0);
    const r = await docx('/api/reports/project-daily/generate', {
      profile_id: profileId, date: D, sections: { boq: false, photos: false, activities: false },
    });
    assert.equal(r.status, 200);
  } finally {
    eqDown = false;
  }
});

test('P7 validation: future date, inactive profile', async () => {
  let r = await admin().post('/api/reports/project-daily/preview', { profile_id: profileId, date: '2999-01-01' });
  assert.equal(r.status, 400);
  r = await admin().post('/api/reports/project-daily/preview', { profile_id: 999999 });
  assert.equal(r.status, 404);
  await admin().put(`/api/reports/project-daily/profiles/${profileId}`, { is_active: false });
  r = await admin().post('/api/reports/project-daily/preview', { profile_id: profileId });
  assert.equal(r.status, 400);
  await admin().put(`/api/reports/project-daily/profiles/${profileId}`, { is_active: true });
});
