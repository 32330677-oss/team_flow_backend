// services/dpr/dprOurs.js
//
// "Our design" of the daily report (the company's DPR layout), built from the SAME
// data as the client's form (services/dpr/dprUcc.js): the same system figures
// (Team Flow / equipment, read only), the same manual values and the same day
// entries. Only the presentation differs; nothing here writes anything.
//
//   manpower   staff | tradesmen exactly like the client's form (Total / Present /
//              Absent, subcontractor rows included); no allocation to activities
//   plant      plant | tools: Operative / Breakdown / Idle (subcontractor plant included)
//   summary    the client's totals (manpower total / present / absent, plant)
//   boq        the whole BOQ (optional section)
//   work       the day's activities with the BOQ figures of the client's form
//              (contract qty, today, previous, cumulative, %, balance) and the
//              man-hours of their crews
//   + weather details, HSE (counts, no man-hours), NCR / concerns, next-day plan, remarks, signatures,
//     materials, area pages (with their photos), photos.
'use strict';

const pool = require('../../config/db');
const C = require('./dprCommon');
const D = require('./dec');
const U = require('./dprUcc');
const Setup = require('./dprSetup');

const DAY_MS = 86400000;
const blank = (v) => v === null || v === undefined || v === '';
const dayNo = (s) => (s ? Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`) / DAY_MS : null);
const dateOf = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const int = (v) => (blank(v) ? 0 : Math.trunc(Number(v)) || 0);
const dOf = (v) => (blank(v) ? 0n : D.of(v));
const sOf = (v) => (blank(v) ? null : D.str(D.of(v)));
/** The value printed in a cell of the client's model. */
const cv = (cell) => (cell ? sOf(cell.v) : null);

/** Sections of our design (the contract default, then the day). */
function sectionsOf(contract, day) {
  return C.sectionFlags(day ? day.sections : null, contract.sections);
}

function headerOf(c, u, eot, boqRates) {
  const date = u.date;
  const dn = dayNo(date);
  const startN = dayNo(c.commencement_date);
  const approved = eot.filter((x) => x.status === 'Approved');
  const eotDays = approved.filter((x) => x.type === 'EOT').reduce((a, x) => a + int(x.days_granted), 0);
  const voValue = approved.filter((x) => x.type === 'VO').reduce((a, x) => D.add(a, dOf(x.value)), 0n);
  const origN = dayNo(c.original_completion);
  const revFinishN = origN === null ? null : origN + eotDays;
  const revDur = startN === null || revFinishN === null ? null : revFinishN - startN + 1;
  const n = startN === null ? null : dn - startN + 1;
  // physical progress weighted by the BOQ amounts (items with a rate and a quantity)
  let amountTotal = 0n;
  let earnedTotal = 0n;
  for (const g of u.boq.groups) {
    for (const r of g.rows) {
      if (r.row_type !== 'item') continue;
      const rate = boqRates.get(r.boq_id);
      const q = blank(r.cells.qty.v) ? null : D.of(r.cells.qty.v);
      if (rate === null || rate === undefined || q === null) continue;
      amountTotal = D.add(amountTotal, D.mul(q, rate));
      earnedTotal = D.add(earnedTotal, D.mul(D.min(dOf(r.cells.cum.v), q), rate));
    }
  }
  return {
    company_name: c.company_name || '',
    report_no: u.header.report_no,
    day_no: n,
    report_date: date,
    day_name: u.header.day_name,
    project_name: c.project_name || '',
    project_code: c.project_code || '',
    agreement_no: c.agreement_no || '',
    client: c.client || '',
    consultant: c.consultant || '',
    main_contractor: c.main_contractor || '',
    location: c.location || '',
    currency: c.currency || 'AED',
    contract_value: sOf(c.contract_value),
    commencement_date: c.commencement_date,
    original_completion: c.original_completion || null,
    eot_days: eotDays,
    vo_value: D.str(voValue),
    revised_completion: revFinishN === null ? null : dateOf(revFinishN),
    revised_duration: revDur,
    days_elapsed: n,
    days_remaining: revFinishN === null ? null : revFinishN - dn,
    time_elapsed: n === null || !revDur ? null : n / revDur,
    physical_progress: amountTotal === 0n ? null : D.ratio(earnedTotal, amountTotal),
    prepared_by: c.prepared_by || '',
    reviewed_by: c.reviewed_by || '',
    consultant_rep: c.consultant_rep || '',
  };
}

/**
 * @param {number} contractId
 * @param {string} date
 * @param {{model, contract, day}} [built] the client's model already built (issue: one read only)
 */
async function buildOurs(contractId, date, built = null) {
  const { model: u, contract: c, day } = built || await U.buildUcc(contractId, date);
  const hrsMP = dOf(c.hrs_mp);
  const [[eot], boqAll] = await Promise.all([
    pool.query('SELECT type, days_granted, value, status FROM dpr_eot_vo WHERE contract_id = ? AND is_deleted = 0', [c.contract_id]),
    Setup.listBoq(c.contract_id),
  ]);
  const boqRates = new Map(boqAll.map((b) => [b.boq_id, blank(b.rate) ? null : D.of(b.rate)]));
  const header = headerOf(c, u, eot, boqRates);

  // the day row of the weather (it may follow another contract) and of this contract
  const weatherDay = u.links.weather
    ? (await pool.query('SELECT * FROM dpr_days WHERE contract_id = ? AND report_date = ?', [u.links.weather.contract_id, date]))[0][0] || null
    : day;
  const wd = weatherDay || {};
  const numS = (v) => (blank(v) ? null : String(Number(v)));

  // ---------------------------------------------------------------- manpower | plant (exactly the client's tables and totals)
  const mpRow = (r) => ({ name: r.name, total: cv(r.cells.total), present: cv(r.cells.present), absent: cv(r.cells.absent), auto: r.auto });
  const plRow = (r) => ({ name: r.name, operative: cv(r.cells.operative), breakdown: cv(r.cells.breakdown), idle: cv(r.cells.idle), auto: r.auto });
  const MP = ['total', 'present', 'absent'];
  const PL = ['operative', 'breakdown', 'idle'];
  const sumOf = (rows, f) => {
    const vals = rows.map((r) => r[f]).filter((v) => !blank(v));
    return vals.length ? D.str(vals.reduce((a, v) => D.add(a, D.of(v)), 0n)) : null;
  };
  const tot = (t, fields) => Object.fromEntries(fields.map((f) => [f, cv(t[f])]));
  // rows with no figure today are not printed (our design is compact)
  const used = (fields) => (r) => fields.some((f) => !blank(r[f]) && D.of(r[f]) !== 0n);

  // ---------------------------------------------------------------- summary (counts, like the client's totals) & HSE
  const pt = u.plant.plant.total;
  const summary = {
    total_manpower: cv(u.manpower.grand.total),
    present: cv(u.manpower.grand.present),
    absent: cv(u.manpower.grand.absent),
    plant_operative: cv(pt.operative),
    plant_on_site: D.str([pt.operative, pt.breakdown, pt.idle].reduce((a, x) => D.add(a, dOf(cv(x))), 0n)),
  };

  // HSE: the same counts as the client's form (no man-hours)
  const hse = u.hse;

  // ---------------------------------------------------------------- work (activities + BOQ of the client's model)
  const items = new Map();
  for (const g of u.boq.groups) for (const r of g.rows) if (r.row_type === 'item') items.set(r.boq_id, r);
  const hoursOf = (cr, perDay) => (blank(cr.hours) ? (blank(cr.nos) ? 0n : D.mul(D.of(cr.nos), perDay)) : D.of(cr.hours));
  const work = u.activities.map((a) => {
    const it = a.boq_id ? items.get(a.boq_id) : null;
    const mh = a.crews.filter((cr) => cr.kind === 'trade').reduce((t, cr) => D.add(t, hoursOf(cr, hrsMP)), 0n);
    const q = it ? cv(it.cells.qty) : null;
    const cum = it ? cv(it.cells.cum) : null;
    const curr = it ? cv(it.cells.curr) : null;
    const where = [a.location, a.area, a.chainage].filter(Boolean).join(' · ');
    return {
      item_no: a.item_no || '',
      description: a.description || '',
      location: where,
      unit: a.unit || '',
      contract_qty: q,
      today: a.qty,
      prev_cum: cum === null ? null : D.str(D.sub(D.of(cum), dOf(curr))),
      cum,
      pct: q === null || D.of(q) === 0n || cum === null ? null : D.ratio(D.of(cum), D.of(q)),
      balance: it ? cv(it.cells.balance) : null,
      man_hours: mh === 0n ? null : D.str(mh),
      output_per_mh: mh === 0n || blank(a.qty) ? null : D.num(D.of(a.qty)) / D.num(mh),
    };
  });

  // ---------------------------------------------------------------- the whole BOQ (optional section)
  const boqOut = u.boq.groups.map((g) => ({
    name: g.name,
    rows: g.rows.map((r) => {
      if (r.row_type !== 'item') return { row_type: r.row_type, description: r.description, unit: r.unit || '', qty: r.qty };
      const q = cv(r.cells.qty);
      const cum = cv(r.cells.cum);
      return {
        row_type: 'item', item_no: r.item_no, description: r.description, unit: r.unit || '', qty: q, curr: cv(r.cells.curr), cum,
        pct: q === null || D.of(q) === 0n || cum === null ? null : D.ratio(D.of(cum), D.of(q)), balance: cv(r.cells.balance),
      };
    }),
  }));

  return {
    template: 'ours',
    design: 'ours',
    engine: 'ours-1',
    contract: { contract_id: c.contract_id, code: c.code, title: c.title, currency: c.currency },
    date,
    header,
    sections: sectionsOf(c, day),
    weather: {
      weather_am: wd.weather_am || u.weather.condition || '',
      weather_pm: wd.weather_pm || '',
      temp_max: u.weather.temp_max,
      temp_min: u.weather.temp_min,
      humidity: numS(wd.humidity) || u.weather.humidity_level || null,
      humidity_level: u.weather.humidity_level || '',
      wind: numS(wd.wind),
      hours_lost: numS(wd.hours_lost),
      remarks: u.weather.remarks || '',
    },
    people: {
      staff: { rows: u.manpower.staff.rows.map(mpRow).filter(used(MP)), total: tot(u.manpower.staff.total, MP) },
      trades: { rows: u.manpower.trades.rows.map(mpRow).filter(used(MP)), total: tot(u.manpower.trades.total, MP) },
      plant: { rows: u.plant.plant.rows.map(plRow).filter(used(PL)), total: tot(u.plant.plant.total, PL) },
      tools: { rows: u.plant.tools.rows.map(plRow).filter(used(PL)), total: tot(u.plant.tools.total, PL) },
    },
    boq: { groups: boqOut },
    summary,
    work: { rows: work, count: work.length, man_hours: sumOf(work, 'man_hours') },
    qa: {
      entries: u.wir.map((q) => ({
        type: q.type || '', ref_no: q.ref_no, description: q.description, location: [q.area, q.location, q.chainage].filter(Boolean).join(' · '), result: q.result, remarks: q.remarks,
        area: q.area || '', place: [q.location, q.chainage].filter(Boolean).join(' · '), ms_ref: q.ms_ref || '',
      })),
      count: u.wir.length,
    },
    hse,
    ncr: u.ncr,
    concerns: u.concerns,
    next_day_plan: u.next_day_plan || '',
    remarks: u.notes || '',
    signatures: u.signatures,
    materials: u.materials,
    areas: u.areas,
    photos: u.photos,
    warnings: u.warnings,
    missing: u.missing,
    sources_ok: u.sources_ok,
  };
}

module.exports = { buildOurs, sectionsOf };
