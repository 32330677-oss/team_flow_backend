// services/dpr/dprCalc.js
//
// The Daily Progress Report calculation engine. PURE: no database, no HTTP.
// Same formulas as the DPR_System workbook (sheets DPR, Alloc, Dashboard);
// tests/dpr_engine.unit.test.js checks every figure of the sample workbook.
//
// Numbers:
//   * counts (people, machines)        -> integers
//   * quantities, hours, money, days   -> exact decimal strings (services/dpr/dec.js)
//   * ratios (%, output / MH, LTIFR)   -> full-precision JS numbers (shown with 2
//                                          decimals, like the workbook)
// Nothing is rounded when it is calculated.
'use strict';

const D = require('./dec');

const DAY_MS = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_CATEGORIES = ['Staff', 'Supervision', 'Skilled', 'Semi-skilled', 'Unskilled', 'Operators & Drivers'];

// ------------------------------------------------------------------ dates
function dayNo(s) {
  if (!s) return null;
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}
function dateOf(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
const addDays = (s, k) => dateOf(dayNo(s) + k);

// ------------------------------------------------------------------ helpers
const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const blank = (v) => v === null || v === undefined || v === '';
const isManpower = (l) => l.kind === 'trade' || (l.kind === 'subcon' && l.res_type !== 'Plant');
const isPlant = (l) => l.kind === 'plant' || (l.kind === 'subcon' && l.res_type === 'Plant');

/**
 * @param {object} input see services/dpr/dprModel.js (loadInput)
 * @returns {object} the report model
 */
function compute(input) {
  const date = input.date;
  const dn = dayNo(date);
  const c = input.contract || {};
  const hrsMP = D.of(c.hrs_mp ?? 0);
  const hrsPL = D.of(c.hrs_pl ?? 0);
  const lines = input.lines || [];
  const boq = input.boq || [];
  const countsByDate = input.counts || {};
  const site = input.site || {};
  const today = site[date] || {};
  const warnings = [];

  // ---------------------------------------------------------------- header
  const start = c.commencement_date || null;
  const startN = dayNo(start);
  const approved = (input.eot_vo || []).filter((x) => x.status === 'Approved');
  const eotDays = approved.filter((x) => x.type === 'EOT').reduce((a, x) => a + int(x.days_granted), 0);
  const voValue = approved.filter((x) => x.type === 'VO').reduce((a, x) => D.add(a, D.of(x.value)), 0n);
  const origN = dayNo(c.original_completion);
  const revFinishN = origN === null ? null : origN + eotDays;
  const revDur = startN === null || revFinishN === null ? null : revFinishN - startN + 1;
  const origDur = startN === null || origN === null ? null : origN - startN + 1;
  const n = startN === null ? null : dn - startN + 1;
  if (startN !== null && n < 1) warnings.push('The report date is before the commencement date.');
  const prefix = c.report_prefix ?? 'DPR-';
  const header = {
    company_name: c.company_name || '',
    report_no: n === null ? '' : `${prefix}${String(n).padStart(4, '0')}`,
    day_no: n,
    report_date: date,
    day_name: WEEKDAYS[new Date(dn * DAY_MS).getUTCDay()],
    project_name: c.project_name || '',
    project_code: c.project_code || '',
    agreement_no: c.agreement_no || '',
    client: c.client || '',
    consultant: c.consultant || '',
    main_contractor: c.main_contractor || '',
    location: c.location || '',
    currency: c.currency || 'AED',
    contract_value: blank(c.contract_value) ? null : D.str(D.of(c.contract_value)),
    commencement_date: start,
    original_completion: c.original_completion || null,
    original_duration: origDur,
    eot_days: eotDays,
    vo_value: D.str(voValue),
    revised_completion: revFinishN === null ? null : dateOf(revFinishN),
    revised_duration: revDur,
    revised_contract_value: blank(c.contract_value) ? null : D.str(D.add(D.of(c.contract_value), voValue)),
    days_elapsed: n,
    days_remaining: revFinishN === null ? null : revFinishN - dn,
    time_elapsed: n === null || !revDur ? null : n / revDur,
    physical_progress: null, // set below (BOQ)
    prepared_by: c.prepared_by || '',
    reviewed_by: c.reviewed_by || '',
    consultant_rep: c.consultant_rep || '',
  };

  // ---------------------------------------------------------------- counts
  const countOn = (d, lineId) => int((countsByDate[d] || {})[lineId]);
  const dates = Object.keys(countsByDate).filter((d) => d <= date && (start === null || d >= start));
  const cumOf = (line) => {
    let t = D.of(line.opening_days || 0);
    for (const d of dates) t = D.add(t, D.of(countOn(d, line.line_id)));
    return t;
  };

  // activities of the day (in order) and allocations
  const actsAll = (input.activities || []).filter((a) => a.date <= date);
  const actsToday = actsAll.filter((a) => a.date === date);
  const allocToday = new Map();
  for (const a of actsToday) {
    for (const [lid, v] of Object.entries(a.alloc || {})) {
      allocToday.set(Number(lid), (allocToday.get(Number(lid)) || 0) + int(v));
    }
  }

  const lineRow = (l) => {
    const todayCount = countOn(date, l.line_id);
    const alloc = allocToday.get(l.line_id) || 0;
    const cum = cumOf(l);
    const hrs = isPlant(l) ? hrsPL : hrsMP;
    return {
      line_id: l.line_id,
      kind: l.kind,
      name: l.name,
      category: l.category || '',
      ownership: l.ownership || '',
      subcontractor: l.subcontractor || '',
      res_type: l.kind === 'subcon' ? (l.res_type === 'Plant' ? 'Plant' : 'Manpower') : null,
      scope: l.scope || '',
      today: todayCount,
      allocated: alloc,
      idle: todayCount - alloc,
      cum: D.str(cum),
      cum_hours: l.kind === 'subcon' ? D.str(D.mul(cum, hrs)) : null,
      source: (input.sources || {})[l.line_id] || null,
    };
  };

  const trades = lines.filter((l) => l.kind === 'trade').map(lineRow);
  const plant = lines.filter((l) => l.kind === 'plant').map(lineRow);
  const subcon = lines.filter((l) => l.kind === 'subcon').map(lineRow);

  const total = (rows) => ({
    today: rows.reduce((a, r) => a + r.today, 0),
    allocated: rows.reduce((a, r) => a + r.allocated, 0),
    idle: rows.reduce((a, r) => a + r.idle, 0),
    cum: D.str(rows.reduce((a, r) => D.add(a, D.of(r.cum)), 0n)),
    cum_hours: D.str(rows.reduce((a, r) => D.add(a, D.of(r.cum_hours || 0)), 0n)),
  });
  const ownMP = total(trades);
  const ownPL = total(plant);
  const subMP = total(subcon.filter((r) => r.res_type === 'Manpower'));
  const subPL = total(subcon.filter((r) => r.res_type === 'Plant'));

  const cats = [...DEFAULT_CATEGORIES];
  for (const t of trades) if (t.category && !cats.includes(t.category)) cats.push(t.category);
  const byCategory = cats.map((cat) => {
    const rows = trades.filter((t) => t.category === cat);
    return { category: cat, today: rows.reduce((a, r) => a + r.today, 0), cum: D.str(rows.reduce((a, r) => D.add(a, D.of(r.cum)), 0n)) };
  });
  const catCheck = {
    today: byCategory.reduce((a, r) => a + r.today, 0),
    cum: D.str(byCategory.reduce((a, r) => D.add(a, D.of(r.cum)), 0n)),
  };
  if (catCheck.today !== ownMP.today) warnings.push('Some trades have no category: the category check differs from the own manpower total.');

  const totalMP = ownMP.today + subMP.today;
  const totalPL = ownPL.today + subPL.today;
  const manHoursToday = D.mulInt(hrsMP, totalMP);
  const cumManDays = D.add(D.of(ownMP.cum), D.of(subMP.cum));
  const cumManHours = D.add(D.mul(D.of(ownMP.cum), hrsMP), D.of(subMP.cum_hours));
  const summary = {
    total_manpower: totalMP,
    total_plant: totalPL,
    man_hours_today: D.str(manHoursToday),
    cum_man_days: D.str(cumManDays),
    cum_man_hours: D.str(cumManHours),
  };

  // ---------------------------------------------------------------- BOQ / activities
  const lineById = new Map(lines.map((l) => [l.line_id, l]));
  const qtyByBoq = (boqId, cmp) => actsAll
    .filter((a) => a.boq_id === boqId && cmp(a.date))
    .reduce((t, a) => D.add(t, D.of(a.qty)), 0n);
  const boqById = new Map(boq.map((b) => [b.boq_id, b]));
  const activities = actsToday.map((a) => {
    const b = boqById.get(a.boq_id) || {};
    const crew = Object.entries(a.alloc || {}).reduce((t, [lid, v]) => {
      const l = lineById.get(Number(lid));
      return l && isManpower(l) ? t + int(v) : t;
    }, 0);
    const plantNos = Object.entries(a.alloc || {}).reduce((t, [lid, v]) => {
      const l = lineById.get(Number(lid));
      return l && isPlant(l) ? t + int(v) : t;
    }, 0);
    const opening = D.of(b.opening_qty || 0);
    const prev = D.add(opening, qtyByBoq(a.boq_id, (d) => d < date));
    const cum = D.add(opening, qtyByBoq(a.boq_id, (d) => d <= date));
    const contractQty = blank(b.contract_qty) ? null : D.of(b.contract_qty);
    const mh = D.mulInt(hrsMP, crew);
    const qty = D.of(a.qty);
    return {
      activity_id: a.activity_id ?? null,
      boq_id: a.boq_id,
      item_no: b.item_no || '',
      description: b.description || '',
      location: a.location || '',
      unit: b.unit || '',
      remarks: a.remarks || '',
      contract_qty: contractQty === null ? null : D.str(contractQty),
      today: D.str(qty),
      prev_cum: D.str(prev),
      cum: D.str(cum),
      pct: contractQty === null || contractQty === 0n ? null : D.ratio(cum, contractQty),
      balance: contractQty === null ? null : D.str(D.sub(contractQty, cum)),
      crew,
      plant: plantNos,
      man_hours: D.str(mh),
      equip_hours: D.str(D.mulInt(hrsPL, plantNos)),
      output_per_mh: D.ratio(qty, mh),
      output_per_md: crew ? D.ratio(qty, D.of(crew)) : null,
      alloc: Object.fromEntries(Object.entries(a.alloc || {}).map(([k, v]) => [k, int(v)])),
    };
  });
  const mhAllocated = activities.reduce((t, a) => D.add(t, D.of(a.man_hours)), 0n);
  const work = {
    activities,
    count: activities.length,
    man_hours_allocated: D.str(mhAllocated),
    unallocated_man_hours: D.str(D.sub(manHoursToday, mhAllocated)),
  };

  // BOQ progress (Dashboard)
  let amountTotal = 0n;
  let earnedTotal = 0n;
  const boqProgress = boq.map((b) => {
    const opening = D.of(b.opening_qty || 0);
    const cum = D.add(opening, qtyByBoq(b.boq_id, (d) => d <= date));
    const q = blank(b.contract_qty) ? null : D.of(b.contract_qty);
    const r = blank(b.rate) ? null : D.of(b.rate);
    const amount = q === null || r === null ? null : D.mul(q, r);
    const earned = r === null || q === null ? null : D.mul(D.min(cum, q), r);
    if (amount !== null) amountTotal = D.add(amountTotal, amount);
    if (earned !== null) earnedTotal = D.add(earnedTotal, earned);
    return {
      boq_id: b.boq_id,
      item_no: b.item_no,
      description: b.description,
      unit: b.unit || '',
      contract_qty: q === null ? null : D.str(q),
      cum: D.str(cum),
      pct: q === null || q === 0n ? null : D.ratio(cum, q),
      rate: r === null ? null : D.str(r),
      amount: amount === null ? null : D.str(amount),
      earned: earned === null ? null : D.str(earned),
      balance: q === null ? null : D.str(D.sub(q, cum)),
    };
  });
  const physical = amountTotal === 0n ? 0 : D.ratio(earnedTotal, amountTotal);
  header.physical_progress = physical;

  // ---------------------------------------------------------------- QA
  const qa = (input.qa || []).filter((x) => x.date === date).map((x) => ({
    qa_id: x.qa_id ?? null,
    type: x.type || '', ref_no: x.ref_no || '', description: x.description || '',
    location: x.location || '', result: x.result || '', remarks: x.remarks || '',
  }));

  // ---------------------------------------------------------------- HSE
  const siteDates = Object.keys(site).filter((d) => d <= date);
  const sumSite = (k, from) => siteDates.filter((d) => from === undefined || d > from)
    .reduce((t, d) => t + int(site[d][k]), 0);
  const ltiDates = siteDates.filter((d) => int(site[d].lti) > 0).sort();
  const lastLti = ltiDates.length ? ltiDates[ltiDates.length - 1] : (start ? addDays(start, -1) : null);
  const mpLines = lines.filter(isManpower);
  const dailyMH = (d) => D.mulInt(hrsMP, mpLines.reduce((t, l) => t + countOn(d, l.line_id), 0));
  const safeMH = dates.filter((d) => lastLti === null || d > lastLti).reduce((t, d) => D.add(t, dailyMH(d)), 0n);
  const ltis = sumSite('lti');
  const incidentsToDate = sumSite('incidents');
  const hse = {
    manpower_today: totalMP,
    man_hours_today: D.str(manHoursToday),
    cum_man_hours: D.str(cumManHours),
    safe_man_hours: D.str(safeMH),
    last_lti_date: lastLti,
    lti_free_days: lastLti === null ? null : dn - dayNo(lastLti),
    ltis_to_date: ltis,
    incidents_today: int(today.incidents),
    near_misses_today: int(today.near_misses),
    first_aid_today: int(today.first_aid),
    lti_today: int(today.lti),
    ptws_today: int(today.ptws),
    hse_inspections_today: int(today.hse_inspections),
    tbt_attendees: int(today.tbt_attendees),
    near_misses_to_date: sumSite('near_misses'),
    incidents_to_date: incidentsToDate,
    ltifr: cumManHours === 0n ? null : (ltis * 200000) / D.num(cumManHours),
    trir: cumManHours === 0n ? null : ((ltis + incidentsToDate) * 200000) / D.num(cumManHours),
    tbt_topic: today.tbt_topic || '',
    observations: today.hse_observations || '',
  };

  // ---------------------------------------------------------------- registers
  const openAt = (raised, status, closed) => !blank(raised) && raised <= date
    && (status !== 'Closed' || (!blank(closed) && closed >= date));
  const ncrAll = input.ncr || [];
  const ncr = ncrAll.filter((x) => openAt(x.date_raised, x.status, x.date_closed)).map((x) => {
    const closedShown = x.status === 'Closed' && !blank(x.date_closed) && x.date_closed <= date;
    return {
      ncr_id: x.ncr_id ?? null,
      ncr_no: x.ncr_no || '', date_raised: x.date_raised, raised_by: x.raised_by || '',
      description: x.description || '', root_cause: x.root_cause || '', corrective_action: x.corrective_action || '',
      responsible: x.responsible || '', target_date: x.target_date || null,
      status: closedShown ? 'Closed' : 'Open',
      days_open: (closedShown ? dayNo(x.date_closed) : dn) - dayNo(x.date_raised),
    };
  });
  const concerns = (input.concerns || []).filter((x) => openAt(x.date_raised, x.status, x.date_closed)).map((x) => ({
    concern_id: x.concern_id ?? null,
    date_raised: x.date_raised, issue: x.issue || '', impact: x.impact || '', severity: x.severity || '',
    action_required: x.action_required || '', by_whom: x.by_whom || '', target_date: x.target_date || null,
    status: x.status === 'Closed' && !blank(x.date_closed) && x.date_closed <= date ? 'Closed' : 'Open',
  }));
  const openNcrs = ncrAll.filter((x) => !blank(x.date_raised) && x.date_raised <= date
    && (x.status !== 'Closed' || (!blank(x.date_closed) && x.date_closed > date))).length;

  // ---------------------------------------------------------------- allocation matrix (Alloc sheet)
  const group = (l) => (l.kind === 'trade' ? 'Own Manpower' : l.kind === 'plant' ? 'Own Plant'
    : (l.res_type === 'Plant' ? 'Subcon Plant' : 'Subcon Manpower'));
  const allocRows = [...trades, ...plant, ...subcon].map((r) => {
    const l = lineById.get(r.line_id);
    const deployed = r.today;
    const alloc = r.allocated;
    const idle = deployed - alloc;
    return {
      line_id: r.line_id,
      resource: l.kind === 'subcon' ? `${l.subcontractor || ''} – ${l.name}` : l.name,
      group: group(l),
      deployed,
      per_activity: activities.map((a) => a.alloc[String(r.line_id)] || 0),
      allocated: alloc,
      idle,
      utilisation: deployed === 0 ? null : alloc / deployed,
      status: deployed === 0 && alloc === 0 ? '' : (idle < 0 ? 'Over-allocated' : (idle === 0 ? 'Balanced' : 'Idle / Indirect')),
    };
  });
  const sumRows = (rows) => {
    const deployed = rows.reduce((t, r) => t + r.deployed, 0);
    const alloc = rows.reduce((t, r) => t + r.allocated, 0);
    return {
      deployed,
      per_activity: activities.map((_, i) => rows.reduce((t, r) => t + r.per_activity[i], 0)),
      allocated: alloc,
      idle: rows.reduce((t, r) => t + r.idle, 0),
      utilisation: deployed === 0 ? null : alloc / deployed,
    };
  };
  const mpRows = allocRows.filter((r) => r.group.endsWith('Manpower'));
  const plRows = allocRows.filter((r) => r.group.endsWith('Plant'));
  const mpTot = sumRows(mpRows);
  const plTot = sumRows(plRows);
  const overAllocated = allocRows.filter((r) => r.idle < 0).map((r) => r.resource);
  if (overAllocated.length) warnings.push(`Over-allocated (more allocated than on site): ${overAllocated.join(', ')}.`);
  const allocation = {
    activities: activities.map((a) => ({ item_no: a.item_no, location: a.location, qty: a.today, unit: a.unit })),
    rows: allocRows,
    manpower: mpTot,
    plant: plTot,
    man_hours: {
      deployed: D.str(D.mulInt(hrsMP, mpTot.deployed)),
      per_activity: activities.map((a) => a.man_hours),
      allocated: D.str(D.mulInt(hrsMP, mpTot.allocated)),
      idle: D.str(D.mulInt(hrsMP, mpTot.idle)),
    },
    equip_hours: {
      deployed: D.str(D.mulInt(hrsPL, plTot.deployed)),
      per_activity: activities.map((a) => a.equip_hours),
      allocated: D.str(D.mulInt(hrsPL, plTot.allocated)),
      idle: D.str(D.mulInt(hrsPL, plTot.idle)),
    },
    output_per_mh: activities.map((a) => a.output_per_mh),
    output_per_md: activities.map((a) => a.output_per_md),
    over_allocated: overAllocated,
  };

  // ---------------------------------------------------------------- dashboard
  const last30 = [];
  for (let k = 29; k >= 0; k -= 1) {
    const d = addDays(date, -k);
    const sumKind = (pred) => lines.filter(pred).reduce((t, l) => t + countOn(d, l.line_id), 0);
    const own = sumKind((l) => l.kind === 'trade');
    const sub = sumKind((l) => l.kind === 'subcon' && l.res_type !== 'Plant');
    const pl = sumKind((l) => l.kind === 'plant') + sumKind((l) => l.kind === 'subcon' && l.res_type === 'Plant');
    last30.push({ date: d, day: WEEKDAYS[new Date(dayNo(d) * DAY_MS).getUTCDay()].slice(0, 3), own_manpower: own, subcon_manpower: sub, total_manpower: own + sub, total_plant: pl });
  }
  const openConcerns = concerns.length;
  const dashboard = {
    time_elapsed: header.time_elapsed ?? 0,
    physical_progress: physical,
    manpower_today: totalMP,
    cum_man_days: summary.cum_man_days,
    open_ncrs: openNcrs,
    lti_free_days: hse.lti_free_days,
    open_concerns: openConcerns,
    safe_man_hours: hse.safe_man_hours,
    near_misses_to_date: hse.near_misses_to_date,
    schedule_variance: (physical || 0) - (header.time_elapsed ?? 0),
    cum_by_trade: trades.map((t) => ({ name: t.name, cum: t.cum })),
    last_30_days: last30,
    boq: boqProgress,
    boq_total_amount: D.str(amountTotal),
    boq_total_earned: D.str(earnedTotal),
  };

  // ---------------------------------------------------------------- weather / texts
  const weather = {
    weather_am: today.weather_am || '', weather_pm: today.weather_pm || '',
    temp_max: blank(today.temp_max) ? null : String(today.temp_max),
    temp_min: blank(today.temp_min) ? null : String(today.temp_min),
    humidity: blank(today.humidity) ? null : String(today.humidity),
    wind: blank(today.wind) ? null : String(today.wind),
    hours_lost: blank(today.hours_lost) ? null : String(today.hours_lost),
    remarks: today.weather_remarks || '',
  };

  return {
    header,
    weather,
    manpower: {
      trades, plant, own_manpower: ownMP, own_plant: ownPL,
      by_category: byCategory, category_check: catCheck,
    },
    subcontractors: { lines: subcon, manpower: subMP, plant: subPL },
    summary,
    work,
    qa: { entries: qa, count: qa.length },
    hse,
    ncr: { entries: ncr, count: ncr.length },
    concerns: { entries: concerns, count: concerns.length },
    next_day_plan: today.next_day_plan || '',
    remarks: today.remarks || '',
    signatures: { prepared_by: header.prepared_by, reviewed_by: header.reviewed_by, consultant_rep: header.consultant_rep },
    allocation,
    dashboard,
    setup_totals: {
      original_duration: origDur, approved_eot_days: eotDays, revised_completion: header.revised_completion,
      revised_duration: revDur, approved_vo: D.str(voValue), revised_contract_value: header.revised_contract_value,
      boq_total_amount: D.str(amountTotal),
    },
    warnings,
  };
}

module.exports = { compute, dayNo, dateOf, addDays, DEFAULT_CATEGORIES, WEEKDAYS, isManpower, isPlant };
