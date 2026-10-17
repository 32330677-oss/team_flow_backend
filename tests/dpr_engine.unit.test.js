// tests/dpr_engine.unit.test.js
//
// GOLDEN TEST: the DPR engine against the client's workbook DPR_System_Sample.xlsx.
// tests/fixtures/dpr_sample.json holds the workbook's data (Setup, Res_Log, Act_Log,
// Site_Log, QA_Log, NCR_Reg, Concern_Reg) and the values Excel calculated for the
// report of 03-Oct-2026 (sheets DPR, Alloc, Dashboard). Every figure must match.
// Run: node --test tests/dpr_engine.unit.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures/dpr_sample.json');
const { compute } = require('../services/dpr/dprCalc');
const dec = require('../services/dpr/dec');

const DATE = fx.expected_date; // 2026-10-03
const X = fx.expected.DPR;
const AL = fx.expected.Alloc;
const DB = fx.expected.Dashboard;

// ---------------------------------------------------------------- workbook -> engine input
function inputFromWorkbook(date) {
  const boq = fx.boq.map((b, i) => ({ boq_id: i + 1, ...b, opening_qty: '0' }));
  const boqId = new Map(boq.map((b) => [b.item_no, b.boq_id]));
  const lines = fx.lines.map((l) => ({ ...l, line_id: l.id, opening_days: '0' }));
  const counts = {};
  for (const [d, row] of Object.entries(fx.counts)) {
    counts[d] = Object.fromEntries(Object.entries(row).map(([k, v]) => [Number(k), v]));
  }
  return {
    date,
    contract: fx.contract,
    eot_vo: fx.eot_vo,
    lines,
    boq,
    counts,
    activities: fx.activities.map((a, i) => ({ ...a, activity_id: i + 1, boq_id: boqId.get(a.item_no) })),
    site: fx.site,
    qa: fx.qa,
    ncr: fx.ncr,
    concerns: fx.concerns,
  };
}

const m = compute(inputFromWorkbook(DATE));

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
function eq(actual, expected, label) {
  if (expected === null || expected === undefined || expected === '') {
    assert.ok(actual === null || actual === undefined || actual === '' || actual === 0 || actual === '0', `${label}: expected empty, got ${actual}`);
    return;
  }
  if (typeof expected === 'number') {
    const a = num(actual);
    assert.ok(a !== null && Math.abs(a - expected) <= 1e-9 * Math.max(1, Math.abs(expected)),
      `${label}: expected ${expected}, got ${actual}`);
    return;
  }
  assert.equal(String(actual), String(expected), label);
}
const col = (c, r) => `${c}${r}`;

// ---------------------------------------------------------------- header
test('header: report no, day, dates, durations, % time, % physical progress', () => {
  eq(m.header.report_no, X.M1, 'Report No.');
  eq(m.header.day_name, X.M3, 'Day');
  eq(m.header.project_name, X.C5, 'Project');
  eq(m.header.agreement_no, X.K5, 'Agreement');
  eq(m.header.contract_value, X.K7, 'Contract value');
  eq(m.header.commencement_date, X.C8, 'Commencement');
  eq(m.header.original_completion, X.K8, 'Original completion');
  eq(`${m.header.eot_days} days EOT  |  VO: AED ${Number(m.header.vo_value).toLocaleString('en-US')}`, X.C9, 'EOT / VO');
  eq(m.header.revised_completion, X.K9, 'Revised completion');
  eq(`${m.header.days_elapsed} of ${m.header.revised_duration} days`, X.C10, 'Days elapsed');
  eq(m.header.days_remaining, X.K10, 'Days remaining');
  eq(m.header.time_elapsed, X.C11, '% time');
  eq(m.header.physical_progress, X.K11, '% physical');
  const S = m.setup_totals;
  eq(S.original_duration, 365, 'original duration');
  eq(S.approved_eot_days, 30, 'approved EOT');
  eq(S.revised_duration, 395, 'revised duration');
  eq(S.approved_vo, 185000, 'approved VO');
  eq(S.revised_contract_value, 22291000, 'revised value');
  eq(S.boq_total_amount, 19737300, 'BOQ total');
});

test('1. weather', () => {
  eq(m.weather.weather_am, X.A15, 'AM');
  eq(m.weather.weather_pm, X.C15, 'PM');
  for (const [k, c] of [['temp_max', 'E15'], ['temp_min', 'F15'], ['humidity', 'G15'], ['wind', 'H15'], ['hours_lost', 'I15']]) eq(m.weather[k], X[c], k);
  eq(m.weather.remarks, X.J15, 'remarks');
});

test('2. own manpower by trade (today / allocated / idle / cum. man-days) and totals', () => {
  m.manpower.trades.forEach((t, i) => {
    const r = 19 + i;
    eq(t.name, X[col('A', r)], `trade ${r}`);
    eq(t.category, X[col('C', r)], `category ${r}`);
    eq(t.today, X[col('D', r)], `today ${r}`);
    eq(t.allocated, X[col('E', r)], `allocated ${r}`);
    eq(t.idle, X[col('F', r)], `idle ${r}`);
    eq(t.cum, X[col('G', r)], `cum ${r}`);
  });
  const T = m.manpower.own_manpower;
  eq(T.today, X.D39, 'D39'); eq(T.allocated, X.E39, 'E39'); eq(T.idle, X.F39, 'F39'); eq(T.cum, X.G39, 'G39');
});

test('2. own plant (today / allocated / idle / cum. equip-days) and total', () => {
  m.manpower.plant.forEach((p, i) => {
    const r = 19 + i;
    eq(p.name, X[col('H', r)], `plant ${r}`);
    eq(p.today, X[col('K', r)], `today ${r}`);
    eq(p.allocated, X[col('L', r)], `alloc ${r}`);
    eq(p.idle, X[col('M', r)], `idle ${r}`);
    eq(p.cum, X[col('N', r)], `cum ${r}`);
  });
  const T = m.manpower.own_plant;
  eq(T.today, X.K31, 'K31'); eq(T.allocated, X.L31, 'L31'); eq(T.idle, X.M31, 'M31'); eq(T.cum, X.N31, 'N31');
});

test('2. own manpower summary by category + check', () => {
  m.manpower.by_category.slice(0, 6).forEach((c, i) => {
    const r = 34 + i;
    eq(c.category, X[col('H', r)], `cat ${r}`);
    eq(c.today, X[col('L', r)], `today ${r}`);
    eq(c.cum, X[col('N', r)], `cum ${r}`);
  });
  eq(m.manpower.category_check.today, X.L40, 'L40');
  eq(m.manpower.category_check.cum, X.N40, 'N40');
});

test('3. subcontractor resources and totals', () => {
  m.subcontractors.lines.forEach((s, i) => {
    const r = 44 + i;
    eq(s.subcontractor, X[col('A', r)], `sub ${r}`);
    eq(s.name, X[col('D', r)], `res ${r}`);
    eq(s.res_type, X[col('G', r)], `type ${r}`);
    eq(s.today, X[col('H', r)], `today ${r}`);
    eq(s.allocated, X[col('I', r)], `alloc ${r}`);
    eq(s.idle, X[col('J', r)], `idle ${r}`);
    eq(s.cum, X[col('K', r)], `cum ${r}`);
    eq(s.cum_hours, X[col('M', r)], `hours ${r}`);
  });
  const MP = m.subcontractors.manpower;
  const PL = m.subcontractors.plant;
  eq(MP.today, X.H60, 'H60'); eq(MP.allocated, X.I60, 'I60'); eq(MP.idle, X.J60, 'J60'); eq(MP.cum, X.K60, 'K60'); eq(MP.cum_hours, X.M60, 'M60');
  eq(PL.today, X.H61, 'H61'); eq(PL.allocated, X.I61, 'I61'); eq(PL.idle, X.J61, 'J61'); eq(PL.cum, X.K61, 'K61'); eq(PL.cum_hours, X.M61, 'M61');
});

test('resource summary', () => {
  eq(m.summary.total_manpower, X.A65, 'A65');
  eq(m.summary.total_plant, X.D65, 'D65');
  eq(m.summary.man_hours_today, X.G65, 'G65');
  eq(m.summary.cum_man_days, X.J65, 'J65');
  eq(m.summary.cum_man_hours, X.L65, 'L65');
});

test('4. work progress: every activity column, man-hours allocated / unallocated', () => {
  assert.equal(m.work.count, 5);
  eq(`Activities logged today: ${m.work.count}`, X.A81, 'A81');
  m.work.activities.forEach((a, i) => {
    const r = 69 + i;
    eq(a.item_no, X[col('A', r)], `item ${r}`);
    eq(a.description, X[col('B', r)], `desc ${r}`);
    eq(a.location, X[col('E', r)], `loc ${r}`);
    eq(a.unit, X[col('F', r)], `unit ${r}`);
    eq(a.contract_qty, X[col('G', r)], `qty ${r}`);
    eq(a.today, X[col('H', r)], `today ${r}`);
    eq(a.prev_cum, X[col('I', r)], `prev ${r}`);
    eq(a.cum, X[col('J', r)], `cum ${r}`);
    eq(a.pct, X[col('K', r)], `pct ${r}`);
    eq(a.balance, X[col('L', r)], `bal ${r}`);
    eq(a.man_hours, X[col('M', r)], `mh ${r}`);
    eq(a.output_per_mh, X[col('N', r)], `out ${r}`);
  });
  eq(m.work.man_hours_allocated, X.M81, 'M81');
  eq(m.work.unallocated_man_hours, X.M82, 'M82');
});

test('5. QA / QC entries of the day', () => {
  eq(`QA/QC entries today: ${m.qa.count}`, X.A92, 'A92');
  m.qa.entries.forEach((q, i) => {
    const r = 86 + i;
    eq(q.type, X[col('A', r)], `type ${r}`);
    eq(q.ref_no, X[col('C', r)], `ref ${r}`);
    eq(q.description.trim(), X[col('E', r)], `desc ${r}`);
    eq(q.location, X[col('I', r)], `loc ${r}`);
    eq(q.result, X[col('K', r)], `result ${r}`);
    eq(q.remarks, X[col('M', r)], `remarks ${r}`);
  });
});

test('6. HSE: man-hours, safe man-hours, LTI-free days, counts, LTIFR / TRIR', () => {
  const H = m.hse;
  eq(H.manpower_today, X.D95, 'D95');
  eq(H.man_hours_today, X.H95, 'H95');
  eq(H.cum_man_hours, X.M95, 'M95');
  eq(H.safe_man_hours, X.D96, 'D96');
  eq(H.lti_free_days, X.H96, 'H96');
  eq(H.ltis_to_date, X.M96, 'M96');
  eq(H.incidents_today, X.D97, 'D97');
  eq(H.near_misses_today, X.H97, 'H97');
  eq(H.first_aid_today, X.M97, 'M97');
  eq(H.lti_today, X.D98, 'D98');
  eq(H.ptws_today, X.H98, 'H98');
  eq(H.hse_inspections_today, X.M98, 'M98');
  eq(H.tbt_attendees, X.D99, 'D99');
  eq(H.near_misses_to_date, X.H99, 'H99');
  eq(`${H.ltifr.toFixed(2)} / ${H.trir.toFixed(2)}`, X.M99, 'M99');
  eq(H.tbt_topic, X.D100, 'D100');
  eq(H.observations, X.D101, 'D101');
});

test('7. NCRs open as of the report date (status and days open as of that date)', () => {
  eq(X.A103.match(/today: (\d+)/)[1], String(m.ncr.count), 'count');
  m.ncr.entries.forEach((x, i) => {
    const r = 105 + i;
    eq(x.ncr_no, X[col('A', r)], `no ${r}`);
    eq(x.date_raised, X[col('B', r)], `raised ${r}`);
    eq(x.description, X[col('C', r)], `desc ${r}`);
    eq(x.corrective_action, X[col('H', r)], `action ${r}`);
    eq(x.responsible, X[col('K', r)], `resp ${r}`);
    eq(x.target_date, X[col('L', r)], `target ${r}`);
    eq(x.status, X[col('M', r)], `status ${r}`);
    eq(x.days_open, X[col('N', r)], `days ${r}`);
  });
});

test('8. concerns open as of the report date', () => {
  assert.equal(m.concerns.count, 3);
  m.concerns.entries.forEach((x, i) => {
    const r = 114 + i;
    eq(x.date_raised, X[col('A', r)], `raised ${r}`);
    eq(x.issue, X[col('B', r)], `issue ${r}`);
    eq(x.impact, X[col('G', r)], `impact ${r}`);
    eq(x.severity, X[col('H', r)], `sev ${r}`);
    eq(x.action_required, X[col('I', r)], `action ${r}`);
    eq(x.by_whom, X[col('M', r)], `by ${r}`);
    eq(x.target_date, X[col('N', r)], `target ${r}`);
  });
});

test('9 - 10 and signatures', () => {
  eq(m.next_day_plan, X.A122, 'A122');
  eq(m.signatures.prepared_by, X.A131, 'A131');
  eq(m.signatures.reviewed_by, X.F131, 'F131');
  eq(m.signatures.consultant_rep, X.K131, 'K131');
});

test('Alloc sheet: deployed / per activity / allocated / idle / utilisation / status, totals, hours, output', () => {
  // the workbook has 48 fixed rows; our rows are the configured lines in the same order
  const slotOf = new Map(fx.lines.map((l) => [l.id, l.id])); // slot n -> Alloc row 9 + n
  for (const r of m.allocation.rows) {
    const row = 9 + slotOf.get(r.line_id);
    eq(r.resource, AL[col('B', row)], `name ${row}`);
    eq(r.group, AL[col('C', row)], `group ${row}`);
    eq(r.deployed, AL[col('D', row)], `deployed ${row}`);
    r.per_activity.forEach((v, i) => eq(v, AL[col('EFGHIJKLMNOP'[i], row)], `act ${i + 1} row ${row}`));
    eq(r.allocated, AL[col('Q', row)], `alloc ${row}`);
    eq(r.idle, AL[col('R', row)], `idle ${row}`);
    eq(r.utilisation, AL[col('S', row)], `util ${row}`);
    eq(r.status, AL[col('T', row)], `status ${row}`);
  }
  const A = m.allocation;
  eq(A.manpower.deployed, AL.D58, 'D58'); eq(A.manpower.allocated, AL.Q58, 'Q58'); eq(A.manpower.idle, AL.R58, 'R58'); eq(A.manpower.utilisation, AL.S58, 'S58');
  eq(A.plant.deployed, AL.D59, 'D59'); eq(A.plant.allocated, AL.Q59, 'Q59'); eq(A.plant.idle, AL.R59, 'R59'); eq(A.plant.utilisation, AL.S59, 'S59');
  eq(A.man_hours.deployed, AL.D60, 'D60'); eq(A.man_hours.allocated, AL.Q60, 'Q60'); eq(A.man_hours.idle, AL.R60, 'R60');
  eq(A.equip_hours.deployed, AL.D61, 'D61'); eq(A.equip_hours.allocated, AL.Q61, 'Q61'); eq(A.equip_hours.idle, AL.R61, 'R61');
  A.activities.forEach((a, i) => {
    const c = 'EFGHIJKLMNOP'[i];
    eq(a.item_no, AL[col(c, 6)], `item ${c}`);
    eq(a.location, AL[col(c, 7)], `loc ${c}`);
    eq(`${Number(a.qty).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${a.unit}`, AL[col(c, 8)], `qty ${c}`);
    eq(A.manpower.per_activity[i], AL[col(c, 58)], `crew ${c}`);
    eq(A.plant.per_activity[i], AL[col(c, 59)], `plant ${c}`);
    eq(A.man_hours.per_activity[i], AL[col(c, 60)], `mh ${c}`);
    eq(A.equip_hours.per_activity[i], AL[col(c, 61)], `eh ${c}`);
    eq(A.output_per_mh[i], AL[col(c, 62)], `out/mh ${c}`);
    eq(A.output_per_md[i], AL[col(c, 63)], `out/md ${c}`);
  });
});

test('Dashboard: KPIs, cumulative by trade, last 30 days, BOQ progress and earned value', () => {
  const B = m.dashboard;
  eq(B.time_elapsed, DB.B5, 'B5');
  eq(B.physical_progress, DB.D5, 'D5');
  eq(B.manpower_today, DB.F5, 'F5');
  eq(B.cum_man_days, DB.H5, 'H5');
  eq(B.open_ncrs, DB.J5, 'J5');
  eq(B.lti_free_days, DB.L5, 'L5');
  const v = B.schedule_variance * 100;
  eq(`Open concerns: ${B.open_concerns}     |     Safe man-hours since last LTI: ${Number(B.safe_man_hours).toLocaleString('en-US')}     |     Near misses to date: ${B.near_misses_to_date}     |     Schedule variance (progress − time): ${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(1)}%`, DB.B6, 'B6');
  B.cum_by_trade.forEach((t, i) => {
    eq(t.name, DB[col('C', 10 + i)], `trade ${i}`);
    eq(t.cum, DB[col('D', 10 + i)], `cum ${i}`);
  });
  B.last_30_days.forEach((d, i) => {
    const r = 34 + i;
    eq(d.date, DB[col('B', r)], `date ${r}`);
    eq(d.day, DB[col('C', r)], `day ${r}`);
    eq(d.own_manpower, DB[col('D', r)], `own ${r}`);
    eq(d.subcon_manpower, DB[col('E', r)], `sub ${r}`);
    eq(d.total_manpower, DB[col('F', r)], `tot ${r}`);
    eq(d.total_plant, DB[col('G', r)], `plant ${r}`);
  });
  B.boq.forEach((b, i) => {
    const r = 68 + i;
    eq(b.item_no, DB[col('B', r)], `item ${r}`);
    eq(b.contract_qty, DB[col('E', r)], `qty ${r}`);
    eq(b.cum, DB[col('F', r)], `cum ${r}`);
    eq(b.pct, DB[col('G', r)], `pct ${r}`);
    eq(b.rate, DB[col('H', r)], `rate ${r}`);
    eq(b.amount, DB[col('I', r)], `amount ${r}`);
    eq(b.earned, DB[col('J', r)], `earned ${r}`);
    eq(b.balance, DB[col('K', r)], `balance ${r}`);
  });
  eq(B.boq_total_amount, DB.I118, 'I118');
  eq(B.boq_total_earned, DB.J118, 'J118');
});

test('every report date of the sample period: no error, report no follows the day number', () => {
  for (const d of Object.keys(fx.counts)) {
    const r = compute(inputFromWorkbook(d));
    assert.match(r.header.report_no, /^DPR-\d{4}$/);
    assert.equal(Number(r.header.report_no.slice(4)), r.header.days_elapsed);
  }
});

test('decimals are exact (no float drift, no rounding)', () => {
  const s = ['0.1', '0.2', '0.3'].reduce((a, x) => dec.add(a, dec.of(x)), 0n);
  assert.equal(dec.str(s), '0.6');
  assert.equal(dec.str(dec.mul(dec.of('1450.1234'), dec.of('3.0001'))), '4350.51521234');
  assert.equal(dec.str(dec.sub(dec.of('1450'), dec.of('643'))), '807');
  assert.throws(() => dec.of('1.123456789'));
});
