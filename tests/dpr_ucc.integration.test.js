// tests/dpr_ucc.integration.test.js
//
// DPR v2 — the client's form (UCC-IMS-CM-3003A) with full control of the QC.
// Proves: Total / Present / Absent from Team Flow per position (any record, counted once a
// day), staff per position from the staff list (counts only, NO names anywhere), plant as
// Operative / Breakdown / Idle, automatic rows, manual values "this day" / "from this day
// on" never replaced by system data arriving later, revert everywhere / from a date, the
// BOQ cumulative (opening, chain, target), sections that follow another contract (71 <-> 26),
// apply-to, the layout (sections / tables / columns), PDF + Excel, issue fingerprint,
// impact preview, and that NO Team Flow table is written.
// Run: node --test tests/dpr_ucc.integration.test.js  (local MySQL, see tests/helpers.js)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const ExcelJS = require('exceljs');
const { resetDatabase, startServer, stopServer, client, q } = require('./helpers');
const { businessToday, addDays } = require('../services/businessDate');
const Sources = require('../services/dpr/dprSources');

const T = businessToday();
const d = (k) => addDays(T, k);
const D0 = d(-10); // commencement
const D1 = d(-3);
const D2 = d(-2);
const D3 = d(-1);
const EQ_TOKEN = 'eq-integration-token-eq-integration-token-03';
let base;
let eqServer;

// ---------------------------------------------------------------- fake equipment system (v2 rows)
const PLANT = () => [
  { date: D2, type_name: 'Excavator', vendor_name: 'Al Waha', working: 2, standby: 1, breakdown: 0, machines: 3 },
  { date: D2, type_name: 'Bobcat', vendor_name: 'Rent Co', working: 1, standby: 0, breakdown: 1, machines: 2 },
];
function startFakeEquipment() {
  eqServer = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${EQ_TOKEN}`) return send(401, { status: 'error' });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/integration/sites') return send(200, { status: 'success', data: [{ site_id: 8, site_code: 'S08', site_name: 'S-T2', status: 'Active' }] });
    if (u.pathname === '/api/integration/equipment-types') return send(200, { status: 'success', data: [{ type_id: 1, type_name: 'Excavator', is_active: true }, { type_id: 2, type_name: 'Bobcat', is_active: true }] });
    if (u.pathname === '/api/integration/vendors') return send(200, { status: 'success', data: [] });
    if (u.pathname === '/api/integration/plant-days') {
      const from = u.searchParams.get('from');
      const to = u.searchParams.get('to');
      return send(200, { status: 'success', data: { from, to, rows: PLANT().filter((r) => r.date >= from && r.date <= to) } });
    }
    return send(404, { status: 'error' });
  });
  return new Promise((r) => eqServer.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${eqServer.address().port}/api`)));
}

// ---------------------------------------------------------------- Team Flow data (read only)
const NAMES = ['Ahmad Secret', 'Bilal Secret', 'Hidden Engineer'];
async function seedTeamFlow() {
  await q("INSERT INTO projects (project_id, project_name) VALUES (80, 'Airport')");
  await q("INSERT INTO contracts (contract_id, contract_name, project_id, start_date) VALUES (80, 'T2+ Bridges', 80, ?)", [D0]);
  await q("INSERT INTO sites (site_id, site_name, site_status, contract_id, supports_shifts) VALUES (80, 'T2', 'Active', 80, 1), (81, 'Bridges', 'Active', 80, 0)");
  const workers = [[801, 'Labor'], [802, 'Labor'], [803, 'Labor'], [804, null], [805, 'نجار'], [806, 'Labor'], [807, 'Labor']];
  for (const [id, pos] of workers) {
    await q("INSERT INTO workers (worker_id, worker_unique_id, full_name, job_position, status) VALUES (?, ?, ?, ?, 'Active')",
      [id, `W-${id}`, id === 801 ? NAMES[0] : (id === 802 ? NAMES[1] : `Worker ${id}`), pos]);
    await q("INSERT INTO workersiteassignments (worker_id, site_id, contract_id, assigned_date, shift_type) VALUES (?, ?, 80, ?, 'Day')", [id, id === 807 ? 81 : 80, D0]);
  }
  const att = (w, date, { status = 'Present', checkIn = true, wf = 'Draft', shift = 'Day', site = 80 } = {}) => q(
    `INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, attendance_status, status, shift_type, recorded_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, [w, site, date, checkIn ? `${date} 07:00:00` : null, status, wf, shift]);
  // D2 on T2: 801 present (approved), 802 present without check-in (draft), 803 absent, 804 present (no position),
  //           805 present + night shift too (once), 806 rejected; 807 on Bridges
  await att(801, D2, { wf: 'Approved' });
  await att(802, D2, { checkIn: false, wf: 'Submitted' });
  await att(803, D2, { status: 'Absent' });
  await att(804, D2);
  await att(805, D2);
  await att(805, D2, { shift: 'Night' });
  await att(806, D2, { wf: 'Rejected' });
  await att(807, D2, { site: 81 });
  // staff (no site): 2 site engineers, 1 HSE officer, 1 terminated before D2, 1 inactive
  await q(`INSERT INTO staff_members (staff_id, staff_unique_id, full_name, position, hire_date, first_hire_date, monthly_salary, standard_daily_hours, status, termination_date) VALUES
    (881, 'S-881', ?, 'SITE ENGINEER', ?, ?, 99999, 8, 'Active', NULL),
    (882, 'S-882', 'Eng B', 'Site Engineer ', ?, ?, 99999, 8, 'Active', NULL),
    (883, 'S-883', 'Hse A', 'HSE OFFICER', ?, ?, 99999, 8, 'Active', NULL),
    (884, 'S-884', 'Old', 'SITE ENGINEER', ?, ?, 99999, 8, 'Terminated', ?),
    (885, 'S-885', 'Off', 'SITE ENGINEER', ?, ?, 99999, 8, 'Inactive', NULL)`,
  [NAMES[2], D0, D0, D0, D0, D0, D0, D0, D0, D1, D0, D0]);
  // staff attendance on D3 only: 881 present, 882 absent
  await q("INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, status) VALUES (881, ?, 'Present', ?, 'Draft'), (882, ?, 'Absent', NULL, 'Draft')",
    [D3, `${D3} 07:30:00`, D3]);
}

const CORE_TABLES = ['users', 'projects', 'contracts', 'sites', 'workers', 'workersiteassignments', 'attendance',
  'staff_members', 'staff_site_assignments', 'staff_attendance', 'payroll', 'payrollbatches'];
async function checksums() {
  const out = {};
  for (const t of CORE_TABLES) {
    const [r] = await q(`CHECKSUM TABLE ${t}`);
    out[t] = String(r.Checksum);
  }
  return out;
}

async function login(username, password) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.token;
}
function api(token) {
  const call = async (method, url, body, raw = false) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return { status: res.status, type: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
    return { status: res.status, body: json, text };
  };
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b ?? {}),
    patch: (u, b) => call('PATCH', u, b ?? {}), del: (u) => call('DELETE', u), raw: (u) => call('GET', u, undefined, true),
    upload: async (u, field, buf, name, fields = {}) => {
      const fd = new FormData();
      fd.append(field, new Blob([buf]), name);
      for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
      const res = await fetch(base + u, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
  };
}

const settingsCache = require('../services/settingsCache');
/** Team Flow's weekly rest day = the weekday of `date` (setting attendance_week_start_day = the day after). */
async function setRestDay(date) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  await q("INSERT INTO system_settings (setting_key, setting_value) VALUES ('attendance_week_start_day', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [String((dow + 1) % 7)]);
  await settingsCache.refresh();
}

let qc;
let editor; // dpr.edit without dpr.override
const admin = () => client(1, 'Admin');
const C = {};
let before;

const day = (cid, date) => `/api/dpr/contracts/${cid}/days/${date}`;
const rowOf = (m, table, name) => {
  const t = { staff: m.manpower.staff, trades: m.manpower.trades, plant: m.plant.plant, tools: m.plant.tools }[table];
  return t.rows.find((r) => r.name === name);
};
const vals = (r, fields) => fields.map((f) => r.cells[f].v);

test.before(async () => {
  resetDatabase({ migrate: true });
  process.env.EQUIPMENT_API_URL = await startFakeEquipment();
  process.env.EQUIPMENT_INTEGRATION_TOKEN = EQ_TOKEN;
  base = await startServer();
  await seedTeamFlow();
  // the weekly rest day of Team Flow on a day no test uses (the dates move with today)
  await setRestDay(d(-6));
  Sources.clearCache();
  const all = ['dpr.view', 'dpr.edit', 'dpr.override', 'dpr.registers', 'dpr.issue', 'dpr.revise', 'dpr.setup'];
  let r = await admin().post('/api/access/roles', { name: 'QC Manager', permissions: all });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const qcRole = r.body.data.role_id;
  r = await admin().post('/api/access/roles', { name: 'Typist', permissions: ['dpr.view', 'dpr.edit'] });
  const edRole = r.body.data.role_id;
  await admin().post('/api/access/users', { full_name: 'Qc Manager', username: 'qc.ucc', password: 'Passw0rd!', role_id: qcRole });
  await admin().post('/api/access/users', { full_name: 'Typist', username: 'typist.ucc', password: 'Passw0rd!', role_id: edRole });
  qc = api(await login('qc.ucc', 'Passw0rd!'));
  editor = api(await login('typist.ucc', 'Passw0rd!'));
  before = await checksums();
});
test.after(async () => {
  await stopServer();
  await new Promise((r) => eqServer.close(r));
});

test('U1 setup: contracts 71 / 26 / 59 in the client form, default lists, rows mapped', async () => {
  let r = await qc.post('/api/dpr/contracts', { code: '71', title: 'T2 Underground', commencement_date: D0, tf_site_ids: [80], eq_site_ids: [8] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.template, 'ucc');
  assert.equal(r.body.data.count_mode, 'recorded');
  assert.equal(r.body.data.form.doc_ref, 'UCC-IMS-CM-3003A');
  C.c71 = r.body.data.contract_id;
  r = await qc.post('/api/dpr/contracts', { code: '26', title: 'T2 Surface', commencement_date: D0, tf_site_ids: [80], eq_site_ids: [8] });
  C.c26 = r.body.data.contract_id;
  r = await qc.post('/api/dpr/contracts', { code: '59', title: 'Road', commencement_date: D0, tf_site_ids: [81] });
  C.c59 = r.body.data.contract_id;
  r = await qc.put(`/api/dpr/contracts/${C.c71}`, {
    form: { project_ref: 'UCC-REF-1', contract_ref: 'AGR-71', project_manager: 'PM', rev_date: '2026-03-18' },
    project_name: 'DAMASCUS AIRPORT ROAD', client: 'MINISTRY OF TRANSPORT', consultant: 'DAR', location: 'DAMASCUS INTERNATIONAL AIRPORT',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.form.report_title, 'Daily Report – Agreement {code}');
  // the client's lists in one click (names equal to a system name are counted from it)
  r = await qc.post(`/api/dpr/contracts/${C.c71}/default-lines`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { staff: 14, trade: 13, plant: 24, tool: 17 });
  r = await qc.get(`/api/dpr/contracts/${C.c71}`);
  const lines = r.body.data.lines;
  const ex = lines.find((l) => l.kind === 'plant' && l.name === 'EXCAVATOR');
  assert.deepEqual(ex.source_map.eq, [{ type: 'Excavator', vendor: null }]);
  const se = lines.find((l) => l.kind === 'staff' && l.name === 'SITE ENGINEER');
  assert.deepEqual(se.source_map.sp, ['SITE ENGINEER']);
  // UN-SKILLED LABOR counts the Team Flow position "Labor"
  const un = lines.find((l) => l.kind === 'trade' && l.name === 'UN-SKILLED LABOR');
  r = await qc.put(`/api/dpr/contracts/${C.c71}/lines/${un.line_id}`, { name: 'UN-SKILLED LABOR', source_map: { tf: ['Labor'], eq: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  C.un = un.line_id;
  C.se = se.line_id;
  C.pd = lines.find((l) => l.kind === 'staff' && l.name === 'PROJECT DIRECTOR').line_id;
  C.carp = lines.find((l) => l.kind === 'trade' && l.name === 'CARPENTER').line_id;
  C.exc = ex.line_id;
  C.grinder = lines.find((l) => l.kind === 'tool' && l.name === 'GRINDER').line_id;
  // staff positions offered to Setup: counts only
  r = await qc.get('/api/dpr/source-options');
  const sp = r.body.data.sp_positions;
  assert.deepEqual(sp.find((x) => x.name === 'SITE ENGINEER'), { name: 'SITE ENGINEER', staff: 2 });
  assert.deepEqual(sp.find((x) => x.name === 'HSE OFFICER'), { name: 'HSE OFFICER', staff: 1 });
  assert.ok(sp.every((x) => Object.keys(x).join() === 'name,staff'), 'positions and counts only');
  for (const n of NAMES) assert.ok(!r.text.includes(n), 'no name in source options');
});

test('U2 Team Flow figures: total / present / absent per position, any record, once a day; staff from the list', async () => {
  let r = await qc.get(day(C.c71, D2));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = r.body.data.model;
  assert.equal(r.body.data.template, 'ucc');
  // Labor on T2: 801 present, 802 present (no check-in, recorded mode), 803 absent; 806 rejected; 807 is on Bridges
  assert.deepEqual(vals(rowOf(m, 'trades', 'UN-SKILLED LABOR'), ['total', 'present', 'absent']), ['3', '2', '1']);
  // automatic rows for positions without a row: 'Unspecified' (804) and 'نجار' (805 counted once with two shifts)
  assert.deepEqual(vals(rowOf(m, 'trades', 'Unspecified'), ['total', 'present', 'absent']), ['1', '1', '0']);
  assert.deepEqual(vals(rowOf(m, 'trades', 'نجار'), ['total', 'present', 'absent']), ['1', '1', '0']);
  assert.equal(rowOf(m, 'trades', 'Unspecified').auto, true);
  // staff from the list (no site): 2 site engineers (terminated before D2 and inactive not counted), no attendance on D2 -> present unknown
  assert.deepEqual(vals(rowOf(m, 'staff', 'SITE ENGINEER'), ['total', 'present', 'absent']), ['2', null, null]);
  assert.deepEqual(vals(rowOf(m, 'staff', 'HSE OFFICER'), ['total', 'present', 'absent']), ['1', null, null]);
  // a typed row with nothing typed is empty
  assert.deepEqual(vals(rowOf(m, 'staff', 'PROJECT DIRECTOR'), ['total', 'present', 'absent']), [null, null, null]);
  assert.equal(m.manpower.trades.total.total.v, '5');
  // other staff of the company (seed) appear as automatic rows: the total is the sum of the rows
  const staffSum = m.manpower.staff.rows.reduce((a, x) => a + Number(x.cells.total.v || 0), 0);
  assert.equal(m.manpower.staff.total.total.v, String(staffSum));
  assert.equal(m.manpower.grand.total.v, String(staffSum + 5));
  // plant: Operative / Breakdown / Idle
  assert.deepEqual(vals(rowOf(m, 'plant', 'EXCAVATOR'), ['operative', 'breakdown', 'idle']), ['2', '0', '1']);
  assert.deepEqual(vals(rowOf(m, 'plant', 'BOBCAT'), ['operative', 'breakdown', 'idle']), ['1', '1', '0']);
  // D3: staff attendance exists -> present / absent come from it
  r = await qc.get(day(C.c71, D3));
  assert.deepEqual(vals(rowOf(r.body.data.model, 'staff', 'SITE ENGINEER'), ['total', 'present', 'absent']), ['2', '1', '1']);
  assert.ok(r.body.data.model.warnings.some((w) => w.startsWith('Nothing came from Team Flow')), 'no worker attendance on D3');
  // counting modes
  await qc.put(`/api/dpr/contracts/${C.c71}`, { count_mode: 'approved' });
  Sources.clearCache();
  r = await qc.get(day(C.c71, D2));
  assert.deepEqual(vals(rowOf(r.body.data.model, 'trades', 'UN-SKILLED LABOR'), ['total', 'present', 'absent']), ['1', '1', '0']);
  await qc.put(`/api/dpr/contracts/${C.c71}`, { count_mode: 'checked_in' });
  Sources.clearCache();
  r = await qc.get(day(C.c71, D2));
  assert.deepEqual(vals(rowOf(r.body.data.model, 'trades', 'UN-SKILLED LABOR'), ['total', 'present', 'absent']), ['2', '1', '1']);
  await qc.put(`/api/dpr/contracts/${C.c71}`, { count_mode: 'recorded' });
  Sources.clearCache();
  // no worker / staff name, no salary anywhere in the day
  r = await qc.get(day(C.c71, D2));
  for (const n of [...NAMES, '99999']) assert.ok(!r.text.includes(n), `"${n}" must not be sent to the QC`);
  // workers per site of the day (counts only)
  r = await qc.get(`/api/dpr/team-flow-today?date=${D2}`);
  const t2 = r.body.data.sites.find((s) => s.site_id === 80);
  assert.deepEqual([t2.assigned, t2.present, t2.absent, t2.recorded, t2.not_recorded], [6, 4, 1, 5, 1], 'each person once');
  assert.deepEqual(t2.shifts.map((x) => [x.shift, x.present, x.recorded]), [['Day', 4, 5], ['Night', 1, 1]]);
  const br = r.body.data.sites.find((s) => s.site_id === 81);
  assert.deepEqual([br.present, br.recorded], [1, 1]);
  for (const n of NAMES) assert.ok(!r.text.includes(n));
});

test('U3 manual values: this day / from this day on, never replaced by the system, revert everywhere or from a date', async () => {
  // a typed row (no source): the QC adds positions that are in no system, from this day on
  let r = await qc.put(`${day(C.c71, D1)}/manual`, { key: `line:${C.pd}:total`, value: '1', scope: 'forward' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.get(day(C.c71, D3));
  assert.equal(rowOf(r.body.data.model, 'staff', 'PROJECT DIRECTOR').cells.total.v, '1');
  assert.equal(rowOf(r.body.data.model, 'staff', 'PROJECT DIRECTOR').cells.total.m, 'manual');
  // a system figure: the reason is required, and the permission "change system figures"
  r = await qc.put(`${day(C.c71, D2)}/manual`, { key: `line:${C.un}:present`, value: '68', scope: 'day' });
  assert.equal(r.status, 400);
  r = await editor.put(`${day(C.c71, D2)}/manual`, { key: `line:${C.un}:present`, value: '68', scope: 'day', reason: 'Count on site' });
  assert.equal(r.status, 403);
  r = await editor.put(`${day(C.c71, D2)}/manual`, { key: `line:${C.carp}:present`, value: '10', scope: 'day' });
  assert.equal(r.status, 200, 'a typed row needs only dpr.edit');
  r = await qc.put(`${day(C.c71, D2)}/manual`, { key: `line:${C.un}:present`, value: '68', scope: 'day', reason: 'Count on site' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.get(day(C.c71, D2));
  let un = rowOf(r.body.data.model, 'trades', 'UN-SKILLED LABOR');
  assert.deepEqual([un.cells.present.v, un.cells.present.s, un.cells.present.m], ['68', 2, 'manual']);
  // total follows present + absent once present is typed
  assert.equal(un.cells.total.v, '69');
  // the next day is not changed by a "this day" value
  r = await qc.get(day(C.c71, D3));
  assert.equal(rowOf(r.body.data.model, 'trades', 'UN-SKILLED LABOR').cells.present.v, '0');
  // a manual value on a day without system data is kept when the system data arrives later
  r = await qc.put(`${day(C.c71, D3)}/manual`, { key: `line:${C.un}:present`, value: '50', scope: 'day', reason: 'Before the attendance was typed' });
  assert.equal(r.status, 200);
  await q("INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, attendance_status, status, shift_type, recorded_by_user_id) VALUES (801, 80, ?, ?, 'Present', 'Draft', 'Day', 1)", [D3, `${D3} 07:00:00`]);
  Sources.clearCache();
  r = await qc.get(day(C.c71, D3));
  un = rowOf(r.body.data.model, 'trades', 'UN-SKILLED LABOR');
  assert.deepEqual([un.cells.present.v, un.cells.present.s], ['50', 1], 'the typed value stays, the system value is shown beside it');
  await q('DELETE FROM attendance WHERE worker_id = 801 AND record_date = ?', [D3]);
  before = await checksums();
  Sources.clearCache();
  // forward value then "stop from a date": earlier days keep it
  r = await qc.put(`${day(C.c71, D1)}/manual`, { key: `line:${C.grinder}:operative`, value: '2', scope: 'forward' });
  assert.equal(r.status, 200);
  r = await qc.post(`${day(C.c71, D3)}/manual/revert`, { key: `line:${C.grinder}:operative`, mode: 'from', from_date: D3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.get(day(C.c71, D2));
  assert.equal(rowOf(r.body.data.model, 'tools', 'GRINDER').cells.operative.v, '2');
  r = await qc.get(day(C.c71, D3));
  assert.equal(rowOf(r.body.data.model, 'tools', 'GRINDER').cells.operative.v, null);
  // revert everywhere
  r = await qc.post(`${day(C.c71, D2)}/manual/revert`, { key: `line:${C.grinder}:operative`, mode: 'all' });
  assert.equal(r.status, 200);
  r = await qc.get(day(C.c71, D2));
  assert.equal(rowOf(r.body.data.model, 'tools', 'GRINDER').cells.operative.v, null);
  // history keeps everything
  r = await qc.get(`${day(C.c71, D2)}/manual/history?key=line:${C.grinder}:operative`);
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].active, false);
  // an automatic row becomes a real row when it is changed
  r = await qc.put(`${day(C.c71, D2)}/manual`, { key: 'auto:trade:Unspecified:present', value: '3', scope: 'day', reason: 'Two more on site' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.data.key, /^line:\d+:present$/);
  r = await qc.get(day(C.c71, D2));
  const unsp = rowOf(r.body.data.model, 'trades', 'Unspecified');
  assert.deepEqual([unsp.auto, unsp.cells.present.v], [false, '3']);
  // totals can be typed too
  r = await qc.put(`${day(C.c71, D2)}/manual`, { key: 'tot:manpower:total', value: '138', scope: 'day', reason: 'As agreed with the consultant' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.get(day(C.c71, D2));
  assert.equal(r.body.data.model.manpower.grand.total.v, '138');
  // the differences page lists them with their scope
  r = await qc.get(`/api/dpr/differences?contract_id=${C.c71}`);
  assert.ok(r.body.data.some((x) => x.scope === 'forward' && x.manual_value === 1));
  assert.deepEqual(await checksums(), before, 'Team Flow tables never written');
});

test('U4 BOQ: sections, groups, opening, today, cumulative (chain, target), balance, over-quantity', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('BOQ');
  ws.addRow(['Row type', 'Group', 'Item No.', 'Cost Code', 'Description', 'Unit', 'Quantity', 'Budget', 'Done before']);
  ws.addRow(['section', '', '', '', 'Section 334000 "STORM WATER UTILITIES"', 'ITEM', '1', '', '']);
  ws.addRow(['text', '', '', '', 'Civil works only for underground pipelines.', '', '', '', '']);
  ws.addRow(['item', '', '1', 'C-1', 'Storm water pipes 630 mm dia.', 'M', '43', '', '40']);
  ws.addRow(['item', '', '2', '', 'Storm water pipes 500 mm dia.', 'M', '43', '', '']);
  ws.addRow(['item', 'ADDITIONAL WORKS', '3', '', 'Curbstones Painting', 'lm', '', '31780', '580']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  let r = await qc.upload(`/api/dpr/contracts/${C.c71}/boq-import`, 'file', buf, 'boq.xlsx');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { added: 3, updated: 0, headings: 2, total: 5 });
  r = await qc.get(`/api/dpr/contracts/${C.c71}`);
  const boq = r.body.data.boq;
  C.b1 = boq.find((b) => b.item_no === '1').boq_id;
  C.b3 = boq.find((b) => b.item_no === '3').boq_id;
  assert.equal(boq.filter((b) => b.row_type !== 'item').length, 2);
  // activities: one with an item, one free text
  r = await qc.post(`${day(C.c71, D1)}/activities`, { boq_id: C.b1, qty: '2.5', location: 'Site area' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await qc.post(`${day(C.c71, D2)}/activities`, { boq_id: C.b1, qty: '1.25' });
  r = await qc.post(`${day(C.c71, D2)}/activities`, { description: 'Site cleaning', location: 'Site area' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await qc.get(day(C.c71, D2));
  let m = r.body.data.model;
  assert.deepEqual(m.boq.groups.map((g) => g.name), ['', 'ADDITIONAL WORKS']);
  let it = m.boq.groups[0].rows.find((x) => x.item_no === '1');
  assert.deepEqual(['qty', 'curr', 'cum', 'balance'].map((k) => it.cells[k].v), ['43', '1.25', '43.75', '-0.75']);
  assert.equal(it.over, true);
  assert.ok(m.warnings.some((w) => w.startsWith('BOQ 1:')));
  const add = m.boq.groups[1].rows[0];
  assert.deepEqual(['budget', 'cum', 'balance'].map((k) => add.cells[k].v), ['31780', '580', '31200']);
  assert.deepEqual(m.activities.map((a) => a.description), ['Storm water pipes 630 mm dia.', 'Site cleaning']);
  // "counts in the cumulative": the day quantity of D1 is corrected
  r = await qc.put(`${day(C.c71, D1)}/manual`, { key: `boq:${C.b1}:curr`, value: '2', scope: 'chain', reason: 'Re-measured' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.get(day(C.c71, D2));
  it = r.body.data.model.boq.groups[0].rows.find((x) => x.item_no === '1');
  assert.equal(it.cells.cum.v, '43.25');
  // "this report only" on the cumulative: printed that day, later days unchanged
  r = await qc.put(`${day(C.c71, D2)}/manual`, { key: `boq:${C.b1}:cum`, value: '40', scope: 'day', reason: 'Consultant figure' });
  r = await qc.get(day(C.c71, D2));
  it = r.body.data.model.boq.groups[0].rows.find((x) => x.item_no === '1');
  assert.deepEqual([it.cells.cum.v, it.cells.balance.v], ['40', '3']);
  r = await qc.get(day(C.c71, D3));
  assert.equal(r.body.data.model.boq.groups[0].rows.find((x) => x.item_no === '1').cells.cum.v, '43.25');
  // "from this day on" on the cumulative = a target, later quantities are added to it
  r = await qc.put(`${day(C.c71, D2)}/manual`, { key: `boq:${C.b1}:cum`, value: '30', scope: 'forward', reason: 'Re-measurement agreed' });
  assert.equal(r.status, 200);
  await qc.post(`${day(C.c71, D3)}/activities`, { boq_id: C.b1, qty: '0.5' });
  r = await qc.get(day(C.c71, D3));
  it = r.body.data.model.boq.groups[0].rows.find((x) => x.item_no === '1');
  assert.deepEqual([it.cells.cum.v, it.cells.cum.m], ['30.5', 'adjusted']);
});

test('U5 areas, crews, materials, WIR, photos per area', async () => {
  let r = await qc.post(`/api/dpr/contracts/${C.c59}/areas`, { name: 'BRIDGE - 08' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  C.a8 = r.body.data.area_id;
  r = await qc.post(`${day(C.c59, D2)}/activities`, {
    description: 'Removal of existing kerbs', area_id: C.a8, chainage: '27+300', unit: 'LM', qty: '12',
    crews: [{ kind: 'plant', name: 'BOBCAT', nos: '1' }, { kind: 'trade', name: 'Aggregate layering', nos: '10' }, { kind: 'trade', name: 'FLAGMAN', nos: '1', hours: '8' }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await qc.post(`${day(C.c59, D2)}/materials`, { description: 'Cement', unit: 'ton', qty: '3', area_id: C.a8 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await qc.post(`${day(C.c59, D2)}/qa`, { ref_no: 'WIR-001', description: 'Kerb alignment', area_id: C.a8, chainage: '27+300', ms_ref: 'MS-04', result: 'Submitted' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await qc.get(day(C.c59, D2));
  const m = r.body.data.model;
  assert.equal(m.areas.length, 1);
  const act = m.areas[0].activities[0];
  assert.deepEqual(act.plant, [{ name: 'BOBCAT', nos: '1', hours: '10' }]);
  assert.deepEqual(act.trades.map((t) => [t.name, t.hours]), [['Aggregate layering', '100'], ['FLAGMAN', '8']]);
  assert.equal(m.materials[0].area, 'BRIDGE - 08');
  assert.deepEqual([m.wir[0].ref_no, m.wir[0].ms_ref, m.wir[0].area], ['WIR-001', 'MS-04', 'BRIDGE - 08']);
});

test('U6 26 follows 71 (weather, manpower), edits stay per contract unless applied, apply-to', async () => {
  let r = await qc.post(`/api/dpr/contracts/${C.c26}/default-lines`, { kinds: ['trade'] });
  assert.equal(r.status, 200);
  r = await qc.get(`/api/dpr/contracts/${C.c26}`);
  const un26 = r.body.data.lines.find((l) => l.name === 'UN-SKILLED LABOR');
  await qc.put(`/api/dpr/contracts/${C.c26}/lines/${un26.line_id}`, { name: 'UN-SKILLED LABOR', source_map: { tf: ['Labor'], eq: [] } });
  // without a link: 26 has its own figures; a value typed in 71 does not change 26
  r = await qc.get(day(C.c26, D2));
  assert.equal(rowOf(r.body.data.model, 'trades', 'UN-SKILLED LABOR').cells.present.v, '2');
  // apply-to: the same value in 26 in one action
  r = await qc.put(`${day(C.c71, D2)}/manual`, { key: `line:${C.un}:absent`, value: '4', scope: 'day', reason: 'Sick', apply_to: [C.c26] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.saved.length, 2);
  r = await qc.get(day(C.c26, D2));
  assert.equal(rowOf(r.body.data.model, 'trades', 'UN-SKILLED LABOR').cells.absent.v, '4');
  // weather with apply-to
  r = await qc.patch(day(C.c71, D2), { version: 0, fields: { weather_condition: 'SUNNY', temp_max: '30', temp_min: '18', humidity_level: 'LOW' }, apply_to: [C.c26] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.applied_to, ['26']);
  r = await qc.get(day(C.c26, D2));
  assert.equal(r.body.data.model.weather.condition, 'SUNNY');
  // 26 follows 71 for manpower: 26 shows 71's figures, and cannot change them itself
  r = await qc.put(`/api/dpr/contracts/${C.c26}`, { section_links: { manpower: C.c71, weather: C.c71 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.put(`/api/dpr/contracts/${C.c71}`, { section_links: { manpower: C.c26 } });
  assert.equal(r.status, 409, 'no circular link');
  r = await qc.get(day(C.c26, D2));
  assert.equal(r.body.data.model.links.manpower.code, '71');
  assert.equal(rowOf(r.body.data.model, 'trades', 'UN-SKILLED LABOR').cells.present.v, '68');
  assert.equal(r.body.data.model.manpower.grand.total.v, '138');
  r = await qc.put(`${day(C.c26, D2)}/manual`, { key: `line:${un26.line_id}:present`, value: '1', scope: 'day', reason: 'x' });
  assert.equal(r.status, 404, 'the row of 26 is not in the report while it follows 71');
  r = await qc.put(`${day(C.c26, D2)}/manual`, { key: `line:${C.un}:present`, value: '1', scope: 'day', reason: 'x' });
  assert.equal(r.status, 409);
  await qc.put(`/api/dpr/contracts/${C.c26}`, { section_links: {} });
});

test('U7 layout: sections, tables, columns, titles (contract default + day), PDF and Excel', async () => {
  let r = await qc.put(`/api/dpr/contracts/${C.c71}`, { layout: { columns: { 'boq.budget': false }, titles: { 'col.boq.cum': 'CUMULATIVE' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.get(day(C.c71, D2));
  let v = r.body.data.version;
  r = await qc.patch(day(C.c71, D2), { version: v, fields: { layout: { sections: { plant: false }, tables: { staff: false }, hide_empty: { trades: true } } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.get(day(C.c71, D2));
  const lay = r.body.data.model.layout;
  assert.deepEqual([lay.columns['boq.budget'], lay.titles['col.boq.cum'], lay.sections.plant, lay.tables.staff, lay.hide_empty.trades],
    [false, 'CUMULATIVE', false, false, true]);
  v = r.body.data.version;
  const pdf = await qc.raw(`${day(C.c71, D2)}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buf.slice(0, 4).toString(), '%PDF');
  const xl = await qc.raw(`${day(C.c71, D2)}/xlsx`);
  assert.equal(xl.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xl.buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Daily Report', 'Overall Progress']);
  const heads = wb.getWorksheet('Overall Progress').getRow(5).values.filter(Boolean);
  assert.ok(heads.includes('CUMULATIVE') && !heads.includes('BUDGET'), JSON.stringify(heads));
  // back to the contract default
  r = await qc.patch(day(C.c71, D2), { version: v, fields: { layout: null } });
  assert.equal(r.status, 200);
  r = await qc.get(day(C.c71, D2));
  assert.equal(r.body.data.model.layout.sections.plant, true);
  // the 59 report with its area page
  const p59 = await qc.raw(`${day(C.c59, D2)}/pdf`);
  assert.equal(p59.status, 200);
  assert.equal(p59.buf.slice(0, 4).toString(), '%PDF');
});

test('U8 issue (frozen, fingerprint), change after issue, impact preview, revise, dashboard', async () => {
  let r = await qc.post(`${day(C.c71, D1)}/issue`, { accept_warnings: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rid = r.body.data.report_id;
  r = await qc.get(day(C.c71, D1));
  assert.equal(r.body.data.changed_since_issue, false);
  // preview: a value "from D0 on" changes D1, which is issued
  r = await qc.post(`${day(C.c71, D0)}/manual/preview`, { key: `line:${C.pd}:total`, scope: 'forward' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.issued.map((x) => x.report_date), [D1]);
  assert.ok(r.body.data.later_values.some((x) => x.from_date === D1 && x.value === '1'));
  // a change on an earlier day that reaches the issued day -> changed since issue
  r = await qc.put(`${day(C.c71, D0)}/manual`, { key: `boq:${C.b1}:curr`, value: '1', scope: 'chain', reason: 'Late entry' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.get(day(C.c71, D1));
  assert.equal(r.body.data.changed_since_issue, true);
  // the issued PDF is rebuilt from the frozen data
  const pdf = await qc.raw(`/api/dpr/contracts/${C.c71}/reports/${rid}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buf.slice(0, 4).toString(), '%PDF');
  r = await qc.post(`${day(C.c71, D1)}/revise`, { notes: 'Late BOQ entry', accept_warnings: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.revision, 1);
  r = await qc.get(day(C.c71, D1));
  assert.equal(r.body.data.changed_since_issue, false);
  r = await qc.get(`/api/dpr/contracts/${C.c71}/dashboard?date=${D2}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.template, 'ucc');
  assert.equal(r.body.data.days.length, 9, 'from the commencement date');
  assert.equal(r.body.data.days.find((x) => x.date === D1).status, 'Issued');
  assert.equal(r.body.data.today.manpower, '138');
  for (const n of NAMES) assert.ok(!r.text.includes(n));
  assert.deepEqual(await checksums(), before, 'Team Flow tables never written');
});

test('U9 our design from the same data: weather details, HSE, plan; PDF / Excel on demand; both frozen at issue', async () => {
  let r = await qc.get(day(C.c71, D2));
  const v = r.body.data.version;
  r = await qc.patch(day(C.c71, D2), { version: v, fields: { weather_am: 'Sunny', wind: '12', hours_lost: '0.5', incidents: 1, near_misses: 2, tbt_topic: 'Working at height', next_day_plan: 'Continue excavation' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.get(day(C.c71, D2));
  const dd = r.body.data.day;
  assert.deepEqual([dd.weather_am, dd.wind, dd.hours_lost, dd.incidents, dd.near_misses, dd.tbt_topic, dd.next_day_plan],
    ['Sunny', '12', '0.5', 1, 2, 'Working at height', 'Continue excavation']);
  const m = r.body.data.model;
  // the client's form is unchanged by our design
  const ucc = await qc.raw(`${day(C.c71, D2)}/pdf`);
  assert.equal(ucc.buf.slice(0, 4).toString(), '%PDF');
  const pdf = await qc.raw(`${day(C.c71, D2)}/pdf?design=ours`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buf.slice(0, 4).toString(), '%PDF');
  const xl = await qc.raw(`${day(C.c71, D2)}/xlsx?design=ours`);
  assert.equal(xl.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xl.buf);
  const ws = wb.getWorksheet('DPR');
  assert.ok(ws, wb.worksheets.map((w) => w.name).join());
  assert.ok(!wb.getWorksheet('Alloc'), 'no allocation in our design');
  const texts = [];
  let tradesPresent = null;
  let incidents = null;
  ws.eachRow((row) => {
    row.eachCell((cell) => { if (typeof cell.value === 'string') texts.push(cell.value); });
    if (row.getCell(8).value === 'TOTAL TRADESMEN') tradesPresent = row.getCell(13).value;
    for (let c = 1; c <= 14; c += 1) if (incidents === null && row.getCell(c).value === 'Incidents today') incidents = row.getCell(c + 3).value;
  });
  assert.equal(tradesPresent, Number(m.manpower.trades.total.present.v), 'same figures as the client\'s form');
  assert.equal(incidents, 1);
  for (const t of ['Working at height', 'Continue excavation', 'Sunny', 'TOTAL STAFF', 'TOTAL TOOLS']) assert.ok(texts.includes(t), t);
  assert.ok(texts.includes('OVERALL PROGRESS – BOQ'), 'the whole BOQ (optional section)');
  assert.ok(texts.includes('5.  WORK INSPECTION REQUEST (WIR) REGISTER'), 'WIR register like the client');
  assert.ok(!texts.some((t) => /LTIFR|Safe man-hours|Cumulative man-hours|Man-hours today/i.test(t)), 'HSE without man-hours');
  assert.ok(!texts.some((t) => /Cum\. Man-days|Cum\. Equip-days|SUBCONTRACTOR RESOURCES/.test(t)), 'no cumulative days, subcontractors in the tables');
  // the sections of our design can change for this day only
  r = await qc.get(day(C.c71, D2));
  assert.ok(r.body.data.ours_sections.some((x) => x.key === 'boq'));
  assert.equal(r.body.data.ours_sections_day, null);
  let rr = await qc.patch(day(C.c71, D2), { version: r.body.data.version, fields: { sections: { boq: false } } });
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  const xl2 = await qc.raw(`${day(C.c71, D2)}/xlsx?design=ours`);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(xl2.buf);
  const t2 = [];
  wb2.getWorksheet('DPR').eachRow((row) => row.eachCell((c) => t2.push(String(c.value))));
  assert.ok(!t2.includes('OVERALL PROGRESS – BOQ'), 'switched off for this day');
  r = await qc.get(day(C.c71, D2));
  rr = await qc.patch(day(C.c71, D2), { version: r.body.data.version, fields: { sections: null } });
  assert.equal(rr.status, 200);
  for (const n of NAMES) assert.ok(!texts.some((t) => t.includes(n)), 'no names');
  // HSE, the next working day, the open NCRs and the signatures are in the client's form too
  r = await qc.post(`/api/dpr/contracts/${C.c71}/registers/ncr`, { ncr_no: 'NCR-U9', date_raised: D1, description: 'Cover to rebar' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ux = await qc.raw(`${day(C.c71, D2)}/xlsx`);
  const uwb = new ExcelJS.Workbook();
  await uwb.xlsx.load(ux.buf);
  const ut = [];
  uwb.getWorksheet('Daily Report').eachRow((row) => row.eachCell((c) => ut.push(String(c.value))));
  for (const t of ['HEALTH, SAFETY & ENVIRONMENT', 'PLANNED ACTIVITIES – NEXT WORKING DAY', 'Continue excavation', 'Working at height',
    'NON-CONFORMANCE REPORTS – OPEN AS OF REPORT DATE', 'NCR-U9', 'SIGNATURES']) assert.ok(ut.includes(t), t);
  // 59: area page + materials appear in our design too
  const p59 = await qc.raw(`${day(C.c59, D2)}/pdf?design=ours`);
  assert.equal(p59.buf.slice(0, 4).toString(), '%PDF');
  // issue: both designs are frozen
  r = await qc.post(`${day(C.c71, D2)}/issue`, { accept_warnings: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rid = r.body.data.report_id;
  r = await qc.get(`/api/dpr/contracts/${C.c71}/reports`);
  assert.equal(r.body.data.find((x) => x.report_id === rid).template, 'ucc');
  for (const u of [`reports/${rid}/pdf`, `reports/${rid}/pdf?design=ours`, `reports/${rid}/xlsx?design=ours`]) {
    const f = await qc.raw(`/api/dpr/contracts/${C.c71}/${u}`);
    assert.equal(f.status, 200, u);
  }
  // a later change does not touch the frozen copy of our design
  const before9 = await qc.raw(`/api/dpr/contracts/${C.c71}/reports/${rid}/xlsx?design=ours`);
  r = await qc.get(day(C.c71, D2));
  await qc.patch(day(C.c71, D2), { version: r.body.data.version, fields: { tbt_topic: 'Changed later' } });
  const after9 = await qc.raw(`/api/dpr/contracts/${C.c71}/reports/${rid}/xlsx?design=ours`);
  const read = async (buf) => { const w = new ExcelJS.Workbook(); await w.xlsx.load(buf); const out = []; w.getWorksheet('DPR').eachRow((row) => row.eachCell((c) => out.push(String(c.value)))); return out; };
  assert.ok((await read(before9.buf)).includes('Working at height'));
  assert.ok(!(await read(after9.buf)).includes('Changed later'));
  assert.deepEqual(await checksums(), before, 'Team Flow tables never written');
});

test('U10 the weekly rest day: staff counted only when recorded present that day', async () => {
  await setRestDay(D3);
  Sources.clearCache();
  let r = await qc.get(day(C.c71, D3));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // D3: 881 present, 882 absent -> on a rest day only 881 counts
  let se = rowOf(r.body.data.model, 'staff', 'SITE ENGINEER');
  assert.deepEqual(vals(se, ['total', 'present']), ['1', '1']);
  assert.equal(rowOf(r.body.data.model, 'staff', 'HSE OFFICER').cells.total.v, '0', 'not recorded on the rest day: not counted');
  await setRestDay(d(-6));
  Sources.clearCache();
  r = await qc.get(day(C.c71, D3));
  se = rowOf(r.body.data.model, 'staff', 'SITE ENGINEER');
  assert.equal(se.cells.total.v, '2', 'a normal day: every employed staff member');
});
