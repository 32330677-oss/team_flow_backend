// tests/dpr.integration.test.js
//
// DAILY PROGRESS REPORT — HTTP integration tests (accounts of type 'User' with a role).
// Team Flow figures come from real attendance rows seeded here; the equipment API is a
// small local HTTP server answering like equipment_asik_backend /api/integration/*.
// Proves: every figure is the expected one, manual values never touch system data,
// contracts are independent, copy works only where allowed, issued reports are frozen,
// permissions are enforced, and NO existing table is written by the DPR.
// Run:  npm test   (requires a local MySQL; see tests/helpers.js)
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
const D0 = d(-6); // commencement
const D1 = d(-2);
const D2 = d(-1);
const EQ_TOKEN = 'eq-integration-token-eq-integration-token-02';
let base;
let eqServer;
let eqDown = false;

// ---------------------------------------------------------------- fake equipment system
const PLANT = () => [
  { date: D1, type_name: 'Excavator', vendor_name: 'Al Waha', machines: 2 },
  { date: D2, type_name: 'Excavator', vendor_name: 'Al Waha', machines: 1 },
  { date: D2, type_name: 'Excavator', vendor_name: 'Other Rent', machines: 1 },
  { date: D2, type_name: 'Dump Truck', vendor_name: 'Al Waha', machines: 3 },
  { date: D2, type_name: 'Dump Truck', vendor_name: 'Other Rent', machines: 2 },
  { date: D2, type_name: 'Transit Mixer', vendor_name: 'Readymix', machines: 1 },
  { date: D2, type_name: 'Crane', vendor_name: 'Lift Co', machines: 1 },
];
function startFakeEquipment() {
  eqServer = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (eqDown) return send(500, { status: 'error', message: 'boom' });
    if (req.headers.authorization !== `Bearer ${EQ_TOKEN}`) return send(401, { status: 'error', message: 'Invalid integration token.' });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/integration/sites') return send(200, { status: 'success', data: [{ site_id: 8, site_code: 'S08', site_name: 'T2', status: 'Active' }] });
    if (u.pathname === '/api/integration/equipment-types') return send(200, { status: 'success', data: [{ type_id: 1, type_name: 'Excavator', is_active: true }] });
    if (u.pathname === '/api/integration/vendors') return send(200, { status: 'success', data: [{ vendor_id: 1, vendor_name: 'Al Waha', status: 'Active' }] });
    if (u.pathname === '/api/integration/plant-days') {
      const from = u.searchParams.get('from');
      const to = u.searchParams.get('to');
      return send(200, { status: 'success', data: { from, to, rows: PLANT().filter((r) => r.date >= from && r.date <= to) } });
    }
    if (u.pathname === '/api/integration/daily-plant') {
      return send(200, { status: 'success', data: { date: u.searchParams.get('date'), types: [], totals: { machines: 0, pending: 1 } } });
    }
    return send(404, { status: 'error', message: 'not found' });
  });
  return new Promise((r) => eqServer.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${eqServer.address().port}/api`)));
}

// ---------------------------------------------------------------- Team Flow data (read only for the DPR)
async function seedTeamFlow() {
  await q("INSERT INTO projects (project_id, project_name) VALUES (70, 'T2 Project')");
  await q("INSERT INTO contracts (contract_id, contract_name, project_id, start_date) VALUES (70, 'T2', 70, ?)", [D0]);
  await q("INSERT INTO sites (site_id, site_name, site_status, contract_id, supports_shifts) VALUES (70, 'T2 Main', 'Active', 70, 1), (71, 'Bridges', 'Active', 70, 0)");
  const workers = [[701, 'Steel Fixer'], [702, 'Steel Fixer'], [703, 'Labourer'], [704, 'Labourer'], [705, 'Foreman'], [706, 'Driver'], [707, 'Steel Fixer'], [708, 'Labourer']];
  for (const [id, pos] of workers) {
    await q("INSERT INTO workers (worker_id, worker_unique_id, full_name, job_position, status) VALUES (?, ?, ?, ?, 'Active')", [id, `W-${id}`, `Worker ${id}`, pos]);
    const site = id === 708 ? 71 : 70;
    await q("INSERT INTO workersiteassignments (worker_id, site_id, contract_id, assigned_date, shift_type) VALUES (?, ?, 70, ?, 'Day')", [id, site, D0]);
  }
  // 702 also works the night shift
  await q("INSERT INTO workersiteassignments (worker_id, site_id, contract_id, assigned_date, shift_type) VALUES (702, 70, 70, ?, 'Night')", [D0]);
  const att = async (w, date, { status = 'Present', checkIn = true, wf = 'Draft', shift = 'Day', site = 70 } = {}) => q(
    `INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, attendance_status, status, shift_type, recorded_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, [w, site, date, checkIn ? `${date} 07:00:00` : null, status, wf, shift]);
  // D1: 701, 702, 703, 705 on site
  for (const w of [701, 702, 703, 705]) await att(w, D1, { wf: 'Approved' });
  // D2: 701, 702 (day + night = once), 703, 704, 705, 706; 707 absent; 703... ; 704 rejected? no: 707 Rejected
  for (const w of [701, 702, 703, 704, 705, 706]) await att(w, D2);
  await att(702, D2, { shift: 'Night' });
  await att(707, D2, { wf: 'Rejected' });
  await att(708, D2, { site: 71 }); // Bridges: not a site of contract 71
  await q(`INSERT INTO staff_members (staff_id, staff_unique_id, full_name, position, hire_date, first_hire_date, monthly_salary, standard_daily_hours, status) VALUES
    (771, 'S-771', 'Eng A', 'Site Engineer', ?, ?, 1000, 8, 'Active'), (772, 'S-772', 'Eng B', 'Site Engineer', ?, ?, 1000, 8, 'Active')`, [D0, D0, D0, D0]);
  await q('INSERT INTO staff_site_assignments (staff_id, site_id, assigned_date) VALUES (771, 70, ?), (772, 70, ?)', [D0, D0]);
  await q("INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, status) VALUES (771, ?, 'Present', ?, 'Draft'), (772, ?, 'Present', NULL, 'Draft')",
    [D2, `${D2} 07:30:00`, D2]);
}

const CORE_TABLES = ['users', 'projects', 'contracts', 'sites', 'workers', 'workersiteassignments', 'attendance',
  'staff_members', 'staff_site_assignments', 'staff_attendance', 'payroll', 'payrollbatches', 'daily_site_reports'];
async function checksums() {
  const out = {};
  for (const t of CORE_TABLES) {
    const [r] = await q(`CHECKSUM TABLE ${t}`);
    out[t] = String(r.Checksum);
  }
  return out;
}

// ---------------------------------------------------------------- accounts
async function login(username, password) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.token;
}
function api(token) {
  const call = async (method, url, body, raw = false) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return { status: res.status, type: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
    return { status: res.status, body: await res.json().catch(() => ({})) };
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

let qc;
let viewer;
const admin = () => client(1, 'Admin');
const C = {};
const L = {};
let before;

test.before(async () => {
  resetDatabase({ migrate: true });
  process.env.EQUIPMENT_API_URL = await startFakeEquipment();
  process.env.EQUIPMENT_INTEGRATION_TOKEN = EQ_TOKEN;
  base = await startServer();
  await seedTeamFlow();
  const all = ['dpr.view', 'dpr.edit', 'dpr.override', 'dpr.registers', 'dpr.issue', 'dpr.revise', 'dpr.setup'];
  let r = await admin().post('/api/access/roles', { name: 'QC Manager', permissions: all });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const qcRole = r.body.data.role_id;
  r = await admin().post('/api/access/roles', { name: 'DPR Reader', permissions: ['dpr.view'] });
  const viewRole = r.body.data.role_id;
  await admin().post('/api/access/users', { full_name: 'Qc Manager', username: 'qc.manager', password: 'Passw0rd!', role_id: qcRole });
  await admin().post('/api/access/users', { full_name: 'Dpr Reader', username: 'dpr.reader', password: 'Passw0rd!', role_id: viewRole });
  qc = api(await login('qc.manager', 'Passw0rd!'));
  viewer = api(await login('dpr.reader', 'Passw0rd!'));
  before = await checksums();
});
test.after(async () => {
  await stopServer();
  await new Promise((r) => eqServer.close(r));
});

// ---------------------------------------------------------------- tests
test('D1 contracts are data: created by the role holder, each one independent; Admin reads only', async () => {
  let r = await admin().post('/api/dpr/contracts', { code: '99', title: 'x' });
  assert.equal(r.status, 403, 'Admin cannot set up (dpr.view only)');
  r = await qc.post('/api/dpr/contracts', { code: '71', title: 'T2 above ground', commencement_date: D0, original_completion: d(300),
    contract_value: '1000000', hrs_mp: '10', hrs_pl: '8', tf_site_ids: [70], eq_site_ids: [8], company_name: 'ASIK', project_name: 'T2' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  C.c71 = r.body.data.contract_id;
  r = await qc.post('/api/dpr/contracts', { code: '26', title: 'T2 underground', commencement_date: D0, hrs_mp: '10', hrs_pl: '10', tf_site_ids: [70], eq_site_ids: [8] });
  C.c26 = r.body.data.contract_id;
  r = await qc.post('/api/dpr/contracts', { code: '59', title: 'Bridges', commencement_date: D0, tf_site_ids: [71] });
  C.c59 = r.body.data.contract_id;
  r = await qc.post('/api/dpr/contracts', { code: '71', title: 'dup' });
  assert.equal(r.status, 409);
  await qc.put(`/api/dpr/contracts/${C.c71}`, { copy_from_ids: [C.c26, C.c71] });
  r = await qc.put(`/api/dpr/contracts/${C.c26}`, { copy_from_ids: [C.c71] });
  assert.deepEqual(r.body.data.copy_from_ids, [C.c71]);
  r = await admin().get('/api/dpr/contracts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((c) => c.code).sort(), ['26', '59', '71']);
  assert.equal((await client(11, 'Supervisor').get('/api/dpr/contracts')).status, 403);
  r = await qc.put(`/api/dpr/contracts/${C.c71}`, { original_completion: d(-30) });
  assert.equal(r.status, 400, 'completion before commencement');
});

test('D2 setup: lines mapped to system names (a name counts on one line only), BOQ from Excel', async () => {
  const add = async (body) => {
    const r = await qc.post(`/api/dpr/contracts/${C.c71}/lines`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.line_id;
  };
  L.steel = await add({ kind: 'trade', name: 'Steel Fixer', category: 'Skilled', source_map: { tf: ['Steel Fixer'] } });
  L.lab = await add({ kind: 'trade', name: 'Labourer', category: 'Unskilled', source_map: { tf: ['labourer '] } });
  L.fore = await add({ kind: 'trade', name: 'Foreman', category: 'Supervision', source_map: { tf: ['Foreman'] } });
  L.eng = await add({ kind: 'trade', name: 'Site Engineer', category: 'Staff', source_map: { tf: ['Site Engineer'] } });
  L.helper = await add({ kind: 'trade', name: 'Helper', category: 'Semi-skilled' });
  L.exc = await add({ kind: 'plant', name: 'Excavator', ownership: 'Own', source_map: { eq: [{ type: 'Excavator' }] } });
  L.dt = await add({ kind: 'plant', name: 'Dump Truck', ownership: 'Hired', source_map: { eq: [{ type: 'Dump Truck', vendor: 'Al Waha' }] } });
  L.app = await add({ kind: 'subcon', subcontractor: 'Gulf Shield', name: 'Applicator', res_type: 'Manpower' });
  L.mix = await add({ kind: 'subcon', subcontractor: 'Readymix', name: 'Transit Mixer', res_type: 'Plant', source_map: { eq: [{ type: 'Transit Mixer' }] } });
  let r = await qc.post(`/api/dpr/contracts/${C.c71}/lines`, { kind: 'trade', name: 'Rebar', category: 'Skilled', source_map: { tf: ['STEEL FIXER'] } });
  assert.equal(r.status, 409, 'Steel Fixer already counted on another line');
  r = await qc.post(`/api/dpr/contracts/${C.c71}/lines`, { kind: 'plant', name: 'X', ownership: 'Mine' });
  assert.equal(r.status, 400);
  // BOQ from an Excel file
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('BOQ');
  ws.addRow(['BILL OF QUANTITIES']);
  ws.addRow(['Item No.', 'Description', 'Unit', 'Contract Qty', 'Rate (AED)', 'Amount']);
  ws.addRow(['A.01', 'Excavation', 'm3', 100, 10, 1000]);
  ws.addRow(['B.01', 'Concrete C40', 'm3', 50.5, 20.25, 1022.625]);
  ws.addRow(['TOTAL', '', '', '', '', 2022.625]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  r = await qc.upload(`/api/dpr/contracts/${C.c71}/boq-import`, 'file', buf, 'boq.xlsx');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { added: 2, updated: 0, total: 2 });
  r = await qc.get(`/api/dpr/contracts/${C.c71}`);
  assert.equal(r.body.data.boq.length, 2);
  assert.equal(r.body.data.boq[1].contract_qty, '50.5000');
  C.boqA = r.body.data.boq[0].boq_id;
  C.boqB = r.body.data.boq[1].boq_id;
  // contract 26: same lists, copied (never shared)
  r = await qc.post(`/api/dpr/contracts/${C.c26}/copy-setup`, { from_contract_id: C.c71, parts: ['lines', 'boq'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.lines, 9);
  r = await qc.post(`/api/dpr/contracts/${C.c26}/copy-setup`, { from_contract_id: C.c71, parts: ['boq'] });
  assert.equal(r.status, 409, 'never overwrites');
});

test('D3 figures of the day: Team Flow + equipment, counted once, unmapped names reported', async () => {
  const r = await qc.get(`/api/dpr/contracts/${C.c71}/days/${D2}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = r.body.data.model;
  const t = Object.fromEntries(m.manpower.trades.map((x) => [x.name, x]));
  assert.equal(t['Steel Fixer'].today, 2, '701 + 702 (two shifts = once); 707 Rejected not counted');
  assert.equal(t.Labourer.today, 2, '703 + 704; 708 is on another site');
  assert.equal(t.Foreman.today, 1);
  assert.equal(t['Site Engineer'].today, 1, 'staff 772 has no check-in');
  assert.equal(t.Helper.today, 0);
  assert.equal(t['Steel Fixer'].source.mode, 'system');
  assert.equal(t.Helper.source.mode, 'manual');
  const p = Object.fromEntries(m.manpower.plant.map((x) => [x.name, x]));
  assert.equal(p.Excavator.today, 2, 'type only: every vendor');
  assert.equal(p['Dump Truck'].today, 3, 'type + vendor Al Waha only');
  assert.equal(m.subcontractors.lines.find((x) => x.name === 'Transit Mixer').today, 1);
  assert.ok(m.warnings.some((w) => w.includes('Driver (1)')), 'Driver is on site but on no line');
  assert.ok(m.warnings.some((w) => w.includes('Crane')), 'Crane not mapped');
  // cumulative: D1 + D2
  assert.equal(t['Steel Fixer'].cum, '4', 'D1: 701, 702 + D2: 701, 702');
  assert.equal(t.Labourer.cum, '3', 'D1: 703 + D2: 703, 704');
  assert.equal(p.Excavator.cum, '4');
  assert.equal(m.header.report_no, `DPR-${String(6).padStart(4, '0')}`);
  assert.equal(m.summary.total_manpower, 6);
  assert.equal(m.summary.man_hours_today, '60');
});

test('D4 autosave with version; a stale version gets the latest copy (nothing overwritten)', async () => {
  const url = `/api/dpr/contracts/${C.c71}/days/${D2}`;
  let r = await qc.patch(url, { version: 0, fields: { weather_am: 'Sunny', temp_max: '41.5', incidents: 0, lti: 0, near_misses: 1, next_day_plan: 'Pour B.01' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body.data.version;
  r = await qc.patch(url, { version: v, fields: { weather_pm: 'Hazy' } });
  assert.equal(r.body.data.version, v + 1);
  r = await qc.patch(url, { version: v, fields: { weather_pm: 'Rain' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.day.weather_pm, 'Hazy');
  r = await qc.patch(url, { version: v + 1, fields: { humidity: '150' } });
  assert.equal(r.status, 400, 'humidity 0 - 100');
  r = await qc.patch(url, { version: v + 1, fields: { temp_max: '41.55' } });
  assert.equal(r.status, 400, 'no silent rounding');
  r = await qc.get(`${url}/history?entity=day&field=weather_pm`);
  assert.equal(r.body.data[0].new_value, 'Hazy');
});

test('D5 typed counts only for lines without a source; manual value over a system value: reason, revert, history', async () => {
  const day = `/api/dpr/contracts/${C.c71}/days/${D2}`;
  let r = await qc.put(`${day}/counts/${L.helper}`, { value: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.put(`${day}/counts/${L.steel}`, { value: 9 });
  assert.equal(r.status, 409, 'system figure: use a manual value with a reason');
  r = await qc.put(`${day}/overrides/${L.steel}`, { value: 5 });
  assert.equal(r.status, 400, 'reason required');
  r = await qc.put(`${day}/overrides/${L.steel}`, { value: 5, reason: 'Two fixers came late, not in attendance' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await qc.get(day);
  let st = r.body.data.model.manpower.trades.find((x) => x.name === 'Steel Fixer');
  assert.equal(st.today, 5);
  assert.equal(st.source.mode, 'override');
  assert.equal(st.source.system_value, 2);
  assert.equal(st.cum, '7', 'cumulative uses the manual value (D1: 2 + D2: 5)');
  r = await qc.del(`${day}/overrides/${L.steel}`);
  assert.equal(r.status, 200);
  r = await qc.get(day);
  st = r.body.data.model.manpower.trades.find((x) => x.name === 'Steel Fixer');
  assert.equal(st.today, 2, 'back to the system value');
  await qc.put(`${day}/overrides/${L.steel}`, { value: 4, reason: 'Checked on site' });
  r = await qc.get(`${day}/overrides/${L.steel}`);
  assert.equal(r.body.data.length, 2);
  assert.equal(r.body.data[0].active, true);
  assert.equal(r.body.data[1].reverted_by, 'Qc Manager');
  // the attendance itself is never changed
  const [x] = await q("SELECT COUNT(*) AS n FROM attendance WHERE record_date = ? AND worker_id IN (701, 702)", [D2]);
  assert.equal(Number(x.n), 3);
  // Admin sees the differences
  r = await admin().get(`/api/dpr/differences?contract_id=${C.c71}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 1);
  assert.deepEqual([r.body.data[0].system_value, r.body.data[0].manual_value, r.body.data[0].difference], [2, 4, 2]);
  r = await admin().put(`${day}/overrides/${L.steel}`, { value: 1, reason: 'admin' });
  assert.equal(r.status, 403, 'Admin reads only');
});

test('D6 activities: quantities exact, previous / cumulative, man-hours from the crew, allocation', async () => {
  const day1 = `/api/dpr/contracts/${C.c71}/days/${D1}`;
  const day2 = `/api/dpr/contracts/${C.c71}/days/${D2}`;
  let r = await qc.post(`${day1}/activities`, { boq_id: C.boqA, location: 'Zone A', qty: '10.25' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await qc.post(`${day2}/activities`, { boq_id: C.boqA, location: 'Zone A', qty: '12.5', alloc: { [L.steel]: 2, [L.lab]: 1, [L.exc]: 1 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  C.act = r.body.data.activity_id;
  r = await qc.post(`${day2}/activities`, { boq_id: C.boqA, qty: '1.12345' });
  assert.equal(r.status, 400, 'at most 4 decimals, never rounded');
  r = await qc.get(day2);
  const a = r.body.data.model.work.activities[0];
  assert.deepEqual([a.today, a.prev_cum, a.cum, a.balance, a.man_hours, a.crew], ['12.5', '10.25', '22.75', '77.25', '30', 3]);
  assert.equal(a.pct, 0.2275);
  assert.equal(a.equip_hours, '8');
  assert.equal(r.body.data.model.manpower.trades.find((x) => x.name === 'Steel Fixer').allocated, 2);
  // over-allocation is a warning (red), not an error
  await qc.put(`${day2}/activities/${C.act}`, { boq_id: C.boqA, location: 'Zone A', qty: '12.5', alloc: { [L.fore]: 3 } });
  r = await qc.get(day2);
  assert.ok(r.body.data.model.warnings.some((w) => w.startsWith('Over-allocated')));
  await qc.put(`${day2}/activities/${C.act}`, { boq_id: C.boqA, location: 'Zone A', qty: '12.5', alloc: { [L.steel]: 2, [L.lab]: 1, [L.exc]: 1 } });
});

test('D7 QA, NCR and concern registers; status "as of" the report date', async () => {
  const day2 = `/api/dpr/contracts/${C.c71}/days/${D2}`;
  let r = await qc.post(`${day2}/qa`, { type: 'IR', ref_no: 'IR-001', description: 'Rebar', result: 'Approved' });
  assert.equal(r.status, 201);
  r = await qc.post(`/api/dpr/contracts/${C.c71}/registers/ncr`, { ncr_no: 'NCR-001', date_raised: D1, description: 'Honeycombing', status: 'Closed' });
  assert.equal(r.status, 400, 'closing date required');
  r = await qc.post(`/api/dpr/contracts/${C.c71}/registers/ncr`, { ncr_no: 'NCR-001', date_raised: D1, description: 'Honeycombing', status: 'Closed', date_closed: D2 });
  assert.equal(r.status, 201);
  r = await qc.post(`/api/dpr/contracts/${C.c71}/registers/ncr`, { ncr_no: 'NCR-001', date_raised: D1, description: 'dup' });
  assert.equal(r.status, 409);
  await qc.post(`/api/dpr/contracts/${C.c71}/registers/concerns`, { date_raised: D1, issue: 'Late drawings', severity: 'High', impact: 'Time' });
  r = await qc.get(day2);
  const m = r.body.data.model;
  assert.equal(m.ncr.entries[0].status, 'Closed', 'closed on the report date: listed as closed today');
  assert.equal(m.ncr.entries[0].days_open, 1);
  r = await qc.get(`/api/dpr/contracts/${C.c71}/days/${D1}`);
  assert.equal(r.body.data.model.ncr.entries[0].status, 'Open', 'the day before, it was still open');
  assert.equal(r.body.data.model.concerns.count, 1);
});

test('D8 copy from another contract (same day): only where allowed, matched by name / item', async () => {
  let r = await qc.post(`/api/dpr/contracts/${C.c59}/days/${D2}/copy`, { from_contract_id: C.c71 });
  assert.equal(r.status, 403, '59 may not copy from 71');
  r = await qc.post(`/api/dpr/contracts/${C.c26}/days/${D2}/copy`, { from_contract_id: C.c71, parts: ['weather', 'hse', 'plan', 'counts', 'overrides', 'qa', 'activities'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.copied.overrides, 1);
  assert.equal(r.body.data.copied.activities, 1);
  r = await qc.get(`/api/dpr/contracts/${C.c26}/days/${D2}`);
  const m = r.body.data.model;
  assert.equal(r.body.data.day.weather_am, 'Sunny');
  assert.equal(m.manpower.trades.find((x) => x.name === 'Steel Fixer').today, 4);
  assert.equal(m.manpower.trades.find((x) => x.name === 'Helper').today, 3);
  assert.equal(m.work.activities[0].crew, 3);
  assert.equal(m.header.report_no, 'DPR-0006', 'own numbering');
  // 71 untouched by the copy; 26 has its own copy (independent)
  await qc.patch(`/api/dpr/contracts/${C.c26}/days/${D2}`, { fields: { weather_am: 'Rain' } });
  r = await qc.get(`/api/dpr/contracts/${C.c71}/days/${D2}`);
  assert.equal(r.body.data.day.weather_am, 'Sunny');
});

test('D9 PDF and Excel (draft), then issue: confirm warnings, frozen snapshot, revisions', async () => {
  const day2 = `/api/dpr/contracts/${C.c71}/days/${D2}`;
  let f = await qc.raw(`${day2}/pdf`);
  assert.equal(f.status, 200);
  assert.equal(f.type, 'application/pdf');
  assert.equal(f.buf.slice(0, 4).toString(), '%PDF');
  f = await viewer.raw(`${day2}/xlsx`);
  assert.equal(f.status, 200);
  assert.equal(f.buf.slice(0, 2).toString(), 'PK');
  let r = await viewer.post(`${day2}/issue`, {});
  assert.equal(r.status, 403, 'reader cannot issue');
  r = await qc.post(`${day2}/issue`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CONFIRM_WARNINGS');
  assert.ok(r.body.missing.some((x) => x.key === 'temp_min'));
  r = await qc.post(`${day2}/issue`, { accept_warnings: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rep0 = r.body.data;
  assert.deepEqual([rep0.report_no, rep0.revision, rep0.status], ['DPR-0006', 0, 'Issued']);
  r = await qc.post(`${day2}/issue`, { accept_warnings: true });
  assert.equal(r.body.code, 'ALREADY_ISSUED');
  // data changes after issue: the issued report does not change
  await qc.put(`${day2}/counts/${L.helper}`, { value: 7 });
  const [snap] = await q('SELECT snapshot FROM dpr_reports WHERE report_id = ?', [rep0.report_id]);
  const s = typeof snap.snapshot === 'string' ? JSON.parse(snap.snapshot) : snap.snapshot;
  assert.equal(s.model.manpower.trades.find((x) => x.name === 'Helper').today, 3);
  r = await qc.get(day2);
  assert.equal(r.body.data.changed_since_issue, true);
  r = await qc.post(`${day2}/revise`, { accept_warnings: true });
  assert.equal(r.status, 400, 'reason of the revision required');
  r = await qc.post(`${day2}/revise`, { accept_warnings: true, notes: 'Helpers corrected' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.revision, 1);
  r = await admin().get(`/api/dpr/contracts/${C.c71}/reports`);
  assert.deepEqual(r.body.data.map((x) => [x.revision, x.status]), [[1, 'Issued'], [0, 'Superseded']]);
  f = await viewer.raw(`/api/dpr/contracts/${C.c71}/reports/${rep0.report_id}/pdf`);
  assert.equal(f.status, 200);
  assert.equal(f.buf.slice(0, 4).toString(), '%PDF');
  f = await viewer.raw(`/api/dpr/contracts/${C.c26}/reports/${rep0.report_id}/pdf`);
  assert.equal(f.status, 404, 'a report of 71 is not a report of 26');
});

test('D10 equipment system down: warning, plant unknown, issue needs an explicit confirmation', async () => {
  eqDown = true;
  Sources.clearCache();
  try {
    const day1 = `/api/dpr/contracts/${C.c71}/days/${D1}`;
    let r = await qc.get(day1);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.model.sources_ok.equipment, false);
    assert.ok(r.body.data.model.warnings.some((w) => w.includes('Plant figures')));
    r = await qc.post(`${day1}/issue`, { accept_warnings: true });
    assert.equal(r.body.code, 'SOURCES_MISSING');
  } finally {
    eqDown = false;
    Sources.clearCache();
  }
});

test('D11 photos, dashboard, permissions, dates', async () => {
  const day2 = `/api/dpr/contracts/${C.c71}/days/${D2}`;
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000100' + '05fe02fe' + 'a7359b6e0000000049454e44ae426082', 'hex');
  let r = await qc.upload(`${day2}/photos`, 'file', png, 'site.png', { caption: 'Rebar', location: 'Zone A' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await qc.upload(`${day2}/photos`, 'file', Buffer.from('not an image'), 'x.exe');
  assert.equal(r.status, 400);
  r = await qc.get(day2);
  assert.equal(r.body.data.photos.length, 1);
  const f = await viewer.raw(`/api/dpr/contracts/${C.c71}/photos/${r.body.data.photos[0].photo_id}/file`);
  assert.equal(f.status, 200);
  r = await viewer.get(`/api/dpr/contracts/${C.c71}/dashboard?date=${D2}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.days.find((x) => x.date === D2).status, 'Issued');
  assert.equal(r.body.data.days.find((x) => x.date === D1).status, 'Draft');
  r = await viewer.patch(day2, { fields: { remarks: 'x' } });
  assert.equal(r.status, 403);
  r = await qc.get(`/api/dpr/contracts/${C.c71}/days/${d(1)}`);
  assert.equal(r.status, 400, 'no future date');
  r = await qc.get(`/api/dpr/contracts/${C.c71}/days/${d(-30)}`);
  assert.equal(r.status, 400, 'no date before commencement');
  assert.equal((await client(14, 'StaffSupervisor').get(day2)).status, 403);
});

test('D12 data safety: no existing table was written by the DPR', async () => {
  const after = await checksums();
  assert.deepEqual(after, before);
});
