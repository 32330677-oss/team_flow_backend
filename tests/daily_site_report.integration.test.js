// tests/daily_site_report.integration.test.js
//
// Daily Site Manpower Report (sub-contractor PDF) — HTTP integration tests.
// Run:  npm test   (requires a local MySQL; see tests/helpers.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDatabase, startServer, stopServer, client, q, token } = require('./helpers');
const { businessToday, addDays } = require('../services/businessDate');

const D = businessToday();
const Y = addDays(D, -1);
const admin = () => client(1, 'Admin');
const SITE = 50;
const SITE_B = 51;

async function seed() {
  await q("INSERT INTO projects (project_id, project_name, client_name) VALUES (50, 'Report Project', 'Al-Noor Contracting')");
  await q("INSERT INTO contracts (contract_id, contract_name, project_id) VALUES (50, 'Civil C-50', 50)");
  await q(`INSERT INTO sites (site_id, site_name, location, site_status, contract_id, supervisor_id, supports_shifts) VALUES
    (${SITE}, 'Report Site', 'Damascus', 'Active', 50, NULL, 1),
    (${SITE_B}, 'Second Site', NULL, 'Active', 50, 12, 0),
    (52, 'Suspended Site', NULL, 'Suspended', 50, NULL, 0)`);
  await q(`INSERT INTO site_shifts (site_id, shift_type, supervisor_id) VALUES (${SITE}, 'Day', 11), (${SITE}, 'Night', 13)`);
  const workers = [
    [501, 'W-501', 'Worker Present', 'Steel Fixer', 'Active'],
    [502, 'W-502', 'Worker Absent', 'Labourer', 'Active'],
    [503, 'W-503', 'Worker NoRecord', 'Labourer', 'Active'],
    [504, 'W-504', 'Worker Night', 'Driver', 'Active'],
    [505, 'W-505', 'عامل جديد', 'Labourer', 'Active'],
    [506, 'W-506', 'Worker Inactive', 'Labourer', 'Inactive'],
    [507, 'W-507', 'Worker Ended', 'Labourer', 'Active'],
    [508, 'W-508', 'Worker Yesterday', 'Mason', 'Active'],
    [509, 'W-509', 'Worker SiteB', null, 'Active'],
  ];
  for (const [id, code, name, pos, st] of workers) {
    await q('INSERT INTO workers (worker_id, worker_unique_id, full_name, job_position, status) VALUES (?, ?, ?, ?, ?)', [id, code, name, pos, st]);
  }
  const wsa = [
    [501, SITE, '2026-01-01', null, 'Day'], [502, SITE, '2026-01-01', null, 'Day'], [503, SITE, '2026-01-01', null, 'Day'],
    [504, SITE, '2026-01-01', null, 'Night'], [505, SITE, D, null, 'Day'], [506, SITE, '2026-01-01', null, 'Day'],
    [507, SITE, '2026-01-01', Y, 'Day'], [508, SITE, '2026-01-01', D, 'Day'], [509, SITE_B, '2026-01-01', null, 'Day'],
  ];
  for (const [w, s, from, to, sh] of wsa) {
    await q('INSERT INTO workersiteassignments (worker_id, site_id, contract_id, assigned_date, unassigned_date, shift_type) VALUES (?, ?, 50, ?, ?, ?)', [w, s, from, to, sh]);
  }
  const att = [
    [501, SITE, D, `${D} 07:00:00`, 'Present', 'Draft', 'Day'],
    [502, SITE, D, null, 'Absent', 'Draft', 'Day'],
    [504, SITE, D, `${D} 19:00:00`, 'Present', 'Submitted', 'Night'],
    [505, SITE, D, `${D} 06:45:00`, 'Present', 'Draft', 'Day'],
    [507, SITE, D, `${D} 07:10:00`, 'Present', 'Draft', 'Day'],   // no assignment on D: not counted
    [508, SITE, Y, `${Y} 07:00:00`, 'Present', 'Draft', 'Day'],   // yesterday only: no record on D
    [509, SITE_B, D, `${D} 08:00:00`, 'Present', 'Approved', 'Day'],
  ];
  for (const [w, s, d, ci, st, wf, sh] of att) {
    await q(`INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, attendance_status, status, shift_type, recorded_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, [w, s, d, ci, st, wf, sh]);
  }
  await q(`INSERT INTO staff_members (staff_id, staff_unique_id, full_name, position, hire_date, first_hire_date, monthly_salary, standard_daily_hours, status)
           VALUES (51, 'S-51', 'Site Engineer A', 'Site Engineer', '2026-01-01', '2026-01-01', 1000, 8, 'Active')`);
  await q(`INSERT INTO staff_site_assignments (staff_id, site_id, assigned_date) VALUES (51, ${SITE}, '2026-01-01')`);
  await q(`INSERT INTO staff_attendance (staff_id, record_date, attendance_status, check_in_time, status) VALUES (51, ?, 'Present', ?, 'Draft')`, [D, `${D} 07:30:00`]);
}

async function pdf(url, body) {
  const res = await fetch(`${globalThis.__base}${url}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(1, 'Admin')}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, reportNo: res.headers.get('x-report-no'), type: res.headers.get('content-type') };
}

test.before(async () => {
  resetDatabase({ migrate: true });
  globalThis.__base = await startServer();
  await seed();
});
test.after(async () => { await stopServer(); });

test('R1 counts per site and shift follow the rules (dated D only, active assignments only)', async () => {
  const r = await admin().post('/api/reports/daily-site/preview', { site_ids: [SITE], shift: 'All' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const site = r.body.data.sites[0];
  const day = site.shifts.find((s) => s.shift_type === 'Day');
  const night = site.shifts.find((s) => s.shift_type === 'Night');
  // Day: 501, 502, 503, 505 (joined today), 508 (last day today). Not 506 (inactive), not 507 (ended yesterday).
  assert.deepEqual(
    { a: day.counts.assigned, on: day.counts.on_site, ab: day.counts.absent, nr: day.counts.no_record },
    { a: 5, on: 2, ab: 1, nr: 2 });
  assert.equal(day.supervisor, 'Day Supervisor');
  assert.equal(night.counts.assigned, 1);
  assert.equal(night.counts.on_site, 1);
  assert.equal(night.supervisor, 'Night Supervisor');
  assert.deepEqual({ a: site.staff.assigned, on: site.staff.on_site }, { a: 1, on: 1 });
  assert.equal(r.body.data.totals.on_site_total, 4);
  assert.equal(r.body.data.recipient_name, 'Al-Noor Contracting', 'defaults to the project client');
});

test('R2 shift filter and include_staff=false', async () => {
  const r = await admin().post('/api/reports/daily-site/preview', { site_ids: [SITE], shift: 'Night', include_staff: false });
  assert.equal(r.status, 200);
  const site = r.body.data.sites[0];
  assert.deepEqual(site.shifts.map((s) => s.shift_type), ['Night']);
  assert.equal(site.staff, null);
  assert.equal(r.body.data.totals.on_site_total, 1);
});

test('R3 validation: future date, inactive site, missing issuer, supervisor forbidden', async () => {
  let r = await admin().post('/api/reports/daily-site/preview', { date: addDays(D, 1) });
  assert.equal(r.status, 400);
  r = await admin().post('/api/reports/daily-site/preview', { site_ids: [52] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /52/);
  r = await admin().post('/api/reports/daily-site/generate', { site_ids: [SITE] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /issued by/i);
  r = await client(11, 'Supervisor').get('/api/reports/daily-site/options');
  assert.equal(r.status, 403);
});

test('R4 signatory + generate PDF + history + reprint', async () => {
  const s = await admin().post('/api/reports/daily-site/signatories', { full_name: 'Eng. Hamza', title: 'Operations Manager' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const sigId = s.body.data.signatory_id;

  const opt = await admin().get('/api/reports/daily-site/options');
  assert.equal(opt.status, 200);
  assert.ok(opt.body.data.sites.some((x) => x.site_id === SITE));
  assert.ok(!opt.body.data.sites.some((x) => x.site_id === 52), 'suspended sites are not offered');
  assert.equal(opt.body.data.signatories[0].full_name, 'Eng. Hamza');

  const g = await pdf('/api/reports/daily-site/generate', { site_ids: [SITE, SITE_B], signatory_id: sigId });
  assert.equal(g.status, 200, g.buf.toString().slice(0, 300));
  assert.equal(g.type, 'application/pdf');
  assert.equal(g.buf.subarray(0, 4).toString(), '%PDF');
  assert.match(g.reportNo, new RegExp(`^DSR-${D.replace(/-/g, '')}-\\d{4}$`));

  const h = await admin().get('/api/reports/daily-site/history');
  assert.equal(h.status, 200);
  const row = h.body.data[0];
  assert.equal(row.report_no, g.reportNo);
  assert.equal(row.issued_by_name, 'Eng. Hamza');
  assert.equal(row.totals.on_site_total, 5);

  // Attendance changes later: the re-print still shows what was issued.
  await q("UPDATE attendance SET attendance_status = 'Absent', check_in_time = NULL WHERE worker_id = 501 AND record_date = ?", [D]);
  const re = await pdf(`/api/reports/daily-site/${row.report_id}/pdf`);
  assert.equal(re.status, 200);
  assert.equal(re.reportNo, g.reportNo);
  const [saved] = await q('SELECT JSON_EXTRACT(payload, "$.totals.on_site_total") AS t FROM daily_site_reports WHERE report_id = ?', [row.report_id]);
  assert.equal(Number(saved.t), 5);

  // Deactivated signatory cannot be used any more.
  const u = await admin().put(`/api/reports/daily-site/signatories/${sigId}`, { is_active: false });
  assert.equal(u.status, 200);
  const g2 = await admin().post('/api/reports/daily-site/generate', { site_ids: [SITE], signatory_id: sigId });
  assert.equal(g2.status, 400);
});

test('R5 typed issuer, all sites, legacy show_absent_names ignored', async () => {
  const g = await pdf('/api/reports/daily-site/generate', {
    site_ids: 'all', issued_by_name: 'Site Office', issued_by_title: 'Admin', recipient_name: 'Typed Recipient', show_absent_names: false,
  });
  assert.equal(g.status, 200);
  const [row] = await q('SELECT recipient_name, options FROM daily_site_reports WHERE report_no = ?', [g.reportNo]);
  assert.equal(row.recipient_name, 'Typed Recipient');
  const opts = typeof row.options === 'string' ? JSON.parse(row.options) : row.options;
  assert.deepEqual(opts, { include_staff: true });
});

test('R6 v2 payload: counts and trades only, no names / IDs / check-in times', async () => {
  const g = await pdf('/api/reports/daily-site/generate', { site_ids: [SITE], issued_by_name: 'Site Office' });
  assert.equal(g.status, 200);
  const [row] = await q('SELECT payload FROM daily_site_reports WHERE report_no = ?', [g.reportNo]);
  const raw = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
  const p = JSON.parse(raw);
  assert.equal(p.layout, 2);
  for (const bad of ['Worker Present', 'W-501', 'عامل جديد', 'S-51', 'check_in', '07:00', 'present', 'away']) {
    assert.ok(!raw.includes(bad), `payload must not contain ${bad}`);
  }
  const day = p.sites[0].shifts.find((x) => x.shift_type === 'Day');
  // 501 (Steel Fixer) was turned Absent in R4.
  const steel = day.trades.find((t) => t.trade === 'Steel Fixer');
  assert.deepEqual({ ...steel }, { trade: 'Steel Fixer', assigned: 1, on_site: 0 });
  const lab = day.trades.find((t) => t.trade === 'Labourer');
  assert.deepEqual({ a: lab.assigned, on: lab.on_site }, { a: 3, on: 1 });
  assert.deepEqual(p.sites[0].staff.trades, [{ trade: 'Site Engineer', assigned: 1, on_site: 1 }]);
});

test('R7 site notes: validated, stored in the snapshot, offered as last notes', async () => {
  const notes = {
    [SITE]: {
      weather: 'hot', weather_impact: 'slowed', hse_status: 'near_miss',
      work_done: '  Slab rebar zone A done.\r\n\r\n\r\n\r\nColumns 12/20  ',
      work_planned: 'صب أعمدة الطابق الأرضي (المحور A)',
      toolbox_talk: 'Working at height', issues: 'x'.repeat(5000), hse_details: 'Plank fell, no injury.',
    },
    [SITE_B]: { weather: 'tornado', hse_status: 'bad', work_done: '   ' }, // nothing valid: dropped
    999: { work_done: 'not in the report' },
  };
  const g = await pdf('/api/reports/daily-site/generate', { site_ids: [SITE, SITE_B], issued_by_name: 'Site Office', site_notes: notes });
  assert.equal(g.status, 200, g.buf.toString().slice(0, 300));
  const [row] = await q('SELECT payload FROM daily_site_reports WHERE report_no = ?', [g.reportNo]);
  const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const a = p.sites.find((s) => s.site_id === SITE).notes;
  const b = p.sites.find((s) => s.site_id === SITE_B).notes;
  assert.equal(a.weather, 'hot');
  assert.equal(a.weather_impact, 'slowed');
  assert.equal(a.hse_status, 'near_miss');
  assert.equal(a.work_done, 'Slab rebar zone A done.\n\nColumns 12/20');
  assert.equal(a.work_planned, 'صب أعمدة الطابق الأرضي (المحور A)');
  assert.equal(a.issues.length, 1200);
  assert.deepEqual(b, {});
  assert.ok(!JSON.stringify(p).includes('not in the report'));

  const opt = await admin().get('/api/reports/daily-site/options');
  assert.equal(opt.status, 200);
  const last = opt.body.data.last_notes[String(SITE)];
  assert.equal(last.report_no, g.reportNo);
  assert.equal(last.notes.toolbox_talk, 'Working at height');
  assert.equal(last.notes.weather, undefined, 'weather is day-specific, not offered');
  assert.equal(opt.body.data.last_notes[String(SITE_B)], undefined);
});

test('R8 a report saved before v2 re-prints with the new layout', async () => {
  const legacy = {
    sites: [{
      site_id: SITE, site_name: 'Report Site', shifts: [{ shift_type: 'Day', supervisor: 'X', counts: { assigned: 1, on_site: 1, absent: 0, sick: 0, leave: 0, holiday: 0, no_record: 0 },
        trades: [{ trade: 'Mason', assigned: 1, on_site: 1 }], present: [{ code: 'W-1', name: 'Old Name', trade: 'Mason', check_in: '07:00' }], away: [], joined: [], leaving: [] }],
      staff: null, workers_counts: { assigned: 1, on_site: 1, absent: 0, sick: 0, leave: 0, holiday: 0, no_record: 0 },
      staff_counts: { assigned: 0, on_site: 0, absent: 0, sick: 0, leave: 0, holiday: 0, no_record: 0 },
    }],
    totals: { sites: 1, workers: { assigned: 1, on_site: 1, absent: 0, sick: 0, leave: 0, holiday: 0, no_record: 0 },
      staff: { assigned: 0, on_site: 0, absent: 0, sick: 0, leave: 0, holiday: 0, no_record: 0 }, on_site_total: 1, assigned_total: 1 },
  };
  const ins = await q(`INSERT INTO daily_site_reports (report_no, report_date, shift_filter, site_ids, issued_by_name, options, totals, payload, generated_by_user_id, generated_at)
    VALUES ('DSR-LEGACY-0001', ?, 'All', '[50]', 'Old', '{"include_staff":true,"show_absent_names":true}', ?, ?, 1, NOW())`,
  [D, JSON.stringify(legacy.totals), JSON.stringify(legacy)]);
  const re = await pdf(`/api/reports/daily-site/${ins.insertId}/pdf`);
  assert.equal(re.status, 200);
  assert.equal(re.buf.subarray(0, 4).toString(), '%PDF');
});
