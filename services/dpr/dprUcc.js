// services/dpr/dprUcc.js
//
// The report of one contract for one day in the CLIENT'S FORM (UCC-IMS-CM-3003A).
//
//   system values  (READ ONLY)  Team Flow attendance (workers per position, per site
//                               of the record), the staff list (positions, counts only),
//                               the equipment system (Operative / Breakdown / Idle)
//   + the QC's manual values    services/dpr/dprManual.js (this day / from this day on)
//   + the QC's daily entries    weather, activities, crews, materials, WIR, photos
//   = the model printed by services/dpr/dprUccPdf.js / dprUccXlsx.js and shown on screen.
//
// Only COUNTS of people ever reach the model: no name, no salary, nothing personal.
// A section can follow another contract (71 <-> 26): its day data is then read
// from that contract (Setup -> "Same as").
'use strict';

const crypto = require('crypto');
const pool = require('../../config/db');
const C = require('./dprCommon');
const D = require('./dec');
const S = require('./dprSources');
const MV = require('./dprManual');
const UL = require('./dprUccLayout');
const Setup = require('./dprSetup');

const { DprError } = C;
const DAY_MS = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayNo = (s) => (s ? Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`) / DAY_MS : null);
const dateOf = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const blank = (v) => v === null || v === undefined || v === '';
const MP_FIELDS = ['total', 'present', 'absent'];
/** '12.0000' -> '12' (exact, trailing zeros only; never rounded). */
const exact = (v) => (blank(v) ? null : D.str(D.of(v)));
const PL_FIELDS = ['operative', 'breakdown', 'idle'];

// ------------------------------------------------------------------ contract & context
async function contractRow(contractId) {
  const [[row]] = await pool.query('SELECT * FROM dpr_contracts WHERE contract_id = ?', [contractId]);
  if (!row) throw new DprError('Contract not found.', 404);
  const c = Setup.contractOut(row);
  if (!c.commencement_date) throw new DprError('Set the commencement date of this contract in Setup first.', 409);
  return c;
}

const isMpLine = (l) => l.kind === 'staff' || l.kind === 'trade' || (l.kind === 'subcon' && l.res_type !== 'Plant');
const isPlLine = (l) => l.kind === 'plant' || l.kind === 'tool' || (l.kind === 'subcon' && l.res_type === 'Plant');

/**
 * Everything read from the systems and the DPR tables for [from, to], once
 * (a day, or a range for the dashboard). Pure computations follow.
 */
async function loadContext(c, from, to) {
  const sysStart = c.system_start_date || c.commencement_date;
  const sysFrom = from > sysStart ? from : sysStart;
  const lines = (await Setup.listLines(c.contract_id, { activeOnly: true })).map((l) => ({ ...l, map: l.source_map }));
  const wantsEq = c.eq_site_ids.length && (lines.some((l) => l.map.eq.length) || c.auto_rows);
  const [workers, staff, plant, manual] = await Promise.all([
    sysFrom <= to && c.tf_site_ids.length ? S.workersV2(c.tf_site_ids, sysFrom, to, c.count_mode) : Promise.resolve([]),
    sysFrom <= to ? S.staffV2(sysFrom, to, c.count_mode) : Promise.resolve([]),
    sysFrom <= to && wantsEq ? S.plantV2(c.eq_site_ids, sysFrom, to) : Promise.resolve({ ok: true, rows: [] }),
    MV.loadActive(c.contract_id, to),
  ]);
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const list = m.get(r.date) || [];
      list.push(r);
      m.set(r.date, list);
    }
    return m;
  };
  return {
    c, sysStart, lines, manual, R: MV.resolver(manual),
    workers: group(workers), staff: group(staff), plant: group(plant.rows || []),
    plantOk: plant.ok !== false, plantError: plant.error || null, eqWanted: Boolean(wantsEq),
  };
}

// ------------------------------------------------------------------ cells
function cellOf(R, key, system, typedLine) {
  const e = R.at(key, R.__date);
  if (e) {
    return { v: e.value, s: system, m: 'manual', e: { mv_id: e.mv_id, scope: e.scope, from_date: e.from_date, to_date: e.to_date, reason: e.reason, by: e.created_by, at: e.created_at } };
  }
  if (system !== null && system !== undefined) return { v: String(system), s: system, m: 'system' };
  return { v: null, s: null, m: typedLine ? 'typed' : 'none' };
}
const dec = (v) => (blank(v) ? null : D.of(v));
const sumCells = (cells) => {
  const vals = cells.map((x) => dec(x.v)).filter((x) => x !== null);
  return vals.length ? D.str(D.add(...vals)) : null;
};

function displayName(l) {
  return l.kind === 'subcon' ? `${l.subcontractor} – ${l.name}` : l.name;
}

// ------------------------------------------------------------------ manpower (staff | tradesmen)
function manpowerOn(ctx, date) {
  const { c, lines, R } = ctx;
  R.__date = date;
  const before = date < ctx.sysStart;
  const wk = before ? [] : (ctx.workers.get(date) || []);
  const st = before ? [] : (ctx.staff.get(date) || []);
  const wkBy = new Map(wk.map((r) => [S.norm(r.name), r]));
  const stBy = new Map(st.map((r) => [S.norm(r.name), r]));
  const usedW = new Set();
  const usedS = new Set();
  const tables = { staff: [], trades: [] };

  for (const l of lines.filter(isMpLine)) {
    const tf = l.map.tf || [];
    const sp = l.map.sp || [];
    const sourced = tf.length + sp.length > 0;
    const sys = { total: null, present: null, absent: null };
    if (sourced && !before) {
      const add = (k, v) => {
        if (v === null || v === undefined) return;
        sys[k] = (sys[k] || 0) + Number(v);
      };
      let anyStaffAtt = false;
      for (const n of tf) {
        const r = wkBy.get(S.norm(n));
        usedW.add(S.norm(n));
        add('present', r ? r.present : 0);
        add('absent', r ? r.absent : 0);
        add('total', r ? r.total : 0);
      }
      for (const n of sp) {
        const r = stBy.get(S.norm(n));
        usedS.add(S.norm(n));
        add('total', r ? r.total : 0);
        if (r && r.present !== null) { anyStaffAtt = true; add('present', r.present); add('absent', r.absent); }
      }
      if (sp.length && !tf.length && !anyStaffAtt) { sys.present = null; sys.absent = null; }
    }
    const key = (f) => `line:${l.line_id}:${f}`;
    const cells = {};
    for (const f of ['present', 'absent']) cells[f] = cellOf(R, key(f), sys[f], !sourced);
    // total: manual > system (when present / absent are not typed) > present + absent
    const tManual = R.at(key('total'), date);
    if (tManual) {
      cells.total = cellOf(R, key('total'), sys.total, !sourced);
    } else if (sys.total !== null && cells.present.m !== 'manual' && cells.absent.m !== 'manual') {
      cells.total = { v: String(sys.total), s: sys.total, m: 'system' };
    } else {
      const v = sumCells([cells.present, cells.absent]);
      cells.total = { v, s: sys.total, m: v === null ? (sourced ? 'none' : 'typed') : 'computed' };
    }
    const row = { key: `line:${l.line_id}`, line_id: l.line_id, kind: l.kind, name: displayName(l), sourced, auto: false, cells };
    (l.kind === 'staff' ? tables.staff : tables.trades).push(row);
  }
  // automatic rows: positions on site that no row counts
  if (c.auto_rows && !before) {
    for (const r of wk) {
      if (usedW.has(S.norm(r.name))) continue;
      tables.trades.push(autoRow('trade', r.name, { total: r.total, present: r.present, absent: r.absent }));
    }
    for (const r of st) {
      if (usedS.has(S.norm(r.name))) continue;
      tables.staff.push(autoRow('staff', r.name, { total: r.total, present: r.present, absent: r.absent }));
    }
  }
  const total = (name, rows) => {
    const out = {};
    for (const f of MP_FIELDS) {
      const computed = sumCells(rows.map((x) => x.cells[f]));
      const e = R.at(`tot:${name}:${f}`, date);
      out[f] = e ? { v: e.value, s: computed, m: 'manual', e: { mv_id: e.mv_id, scope: e.scope, from_date: e.from_date, to_date: e.to_date, reason: e.reason, by: e.created_by, at: e.created_at } }
        : { v: computed, s: computed, m: 'computed' };
    }
    return out;
  };
  const staffTot = total('staff', tables.staff);
  const tradesTot = total('trades', tables.trades);
  const grand = {};
  for (const f of MP_FIELDS) {
    const computed = sumCells([staffTot[f], tradesTot[f]]);
    const e = R.at(`tot:manpower:${f}`, date);
    grand[f] = e ? { v: e.value, s: computed, m: 'manual', e: { mv_id: e.mv_id, scope: e.scope, from_date: e.from_date, reason: e.reason, by: e.created_by, at: e.created_at } }
      : { v: computed, s: computed, m: 'computed' };
  }
  return { staff: { rows: tables.staff, total: staffTot }, trades: { rows: tables.trades, total: tradesTot }, grand };
}

function autoRow(kind, name, sys) {
  const cells = {};
  for (const [f, v] of Object.entries(sys)) cells[f] = v === null || v === undefined ? { v: null, s: null, m: 'none' } : { v: String(v), s: v, m: 'system' };
  return { key: `auto:${kind}:${name}`, line_id: null, kind, name, sourced: true, auto: true, cells };
}

// ------------------------------------------------------------------ plant | tools
function plantOn(ctx, date) {
  const { c, lines, R } = ctx;
  R.__date = date;
  const before = date < ctx.sysStart;
  const rows = before ? [] : (ctx.plant.get(date) || []);
  const exact = new Map();
  const byType = new Map();
  for (const l of lines.filter(isPlLine)) {
    for (const e of l.map.eq) {
      if (e.vendor) exact.set(`${S.norm(e.type)}|${S.norm(e.vendor)}`, l.line_id);
      else byType.set(S.norm(e.type), l.line_id);
    }
  }
  const sysBy = new Map();
  const unmapped = new Map();
  for (const r of rows) {
    const lid = exact.get(`${S.norm(r.type_name)}|${S.norm(r.vendor_name)}`) || byType.get(S.norm(r.type_name));
    if (lid) {
      const o = sysBy.get(lid) || { operative: 0, breakdown: 0, idle: 0 };
      for (const f of PL_FIELDS) o[f] += r[f];
      sysBy.set(lid, o);
    } else {
      const k = S.norm(r.type_name);
      const o = unmapped.get(k) || { name: r.type_name, operative: 0, breakdown: 0, idle: 0 };
      for (const f of PL_FIELDS) o[f] += r[f];
      unmapped.set(k, o);
    }
  }
  const plantDown = ctx.eqWanted && !ctx.plantOk;
  const tables = { plant: [], tools: [] };
  for (const l of lines.filter(isPlLine)) {
    const sourced = l.map.eq.length > 0;
    const sys = sourced && !before && !plantDown ? (sysBy.get(l.line_id) || { operative: 0, breakdown: 0, idle: 0 }) : {};
    const cells = {};
    for (const f of PL_FIELDS) cells[f] = cellOf(R, `line:${l.line_id}:${f}`, sys[f] === undefined ? null : sys[f], !sourced);
    const row = { key: `line:${l.line_id}`, line_id: l.line_id, kind: l.kind, name: displayName(l), sourced, auto: false, cells, unavailable: sourced && plantDown };
    (l.kind === 'tool' ? tables.tools : tables.plant).push(row);
  }
  if (c.auto_rows && !before) {
    for (const o of unmapped.values()) tables.plant.push(autoRow('plant', o.name, { operative: o.operative, breakdown: o.breakdown, idle: o.idle }));
  }
  const total = (name, list) => {
    const out = {};
    for (const f of PL_FIELDS) {
      const computed = sumCells(list.map((x) => x.cells[f]));
      const e = R.at(`tot:${name}:${f}`, date);
      out[f] = e ? { v: e.value, s: computed, m: 'manual', e: { mv_id: e.mv_id, scope: e.scope, from_date: e.from_date, reason: e.reason, by: e.created_by, at: e.created_at } }
        : { v: computed, s: computed, m: 'computed' };
    }
    return out;
  };
  return { plant: { rows: tables.plant, total: total('plant', tables.plant) }, tools: { rows: tables.tools, total: total('tools', tables.tools) }, unavailable: plantDown };
}

// ------------------------------------------------------------------ BOQ (budget, today, cumulative, balance)
async function boqOn(c, R, date) {
  const boq = await Setup.listBoq(c.contract_id);
  const [sums] = await pool.query(
    `SELECT boq_id, DATE_FORMAT(report_date, '%Y-%m-%d') AS d, SUM(qty) AS q FROM dpr_activities
      WHERE contract_id = ? AND report_date <= ? AND is_deleted = 0 AND boq_id IS NOT NULL
      GROUP BY boq_id, report_date`, [c.contract_id, date]);
  const byItem = new Map();
  for (const r of sums) {
    const m = byItem.get(Number(r.boq_id)) || new Map();
    m.set(r.d, D.of(r.q));
    byItem.set(Number(r.boq_id), m);
  }
  R.__date = date;
  const warnings = [];
  const groups = [];
  const groupOf = (name) => {
    let g = groups.find((x) => x.name === name);
    if (!g) { g = { name, rows: [] }; groups.push(g); }
    return g;
  };
  const mvOut = (e) => ({ mv_id: e.mv_id, scope: e.scope, from_date: e.from_date, to_date: e.to_date, reason: e.reason, by: e.created_by, at: e.created_at });
  for (const b of boq) {
    const g = groupOf(b.group_name || '');
    if (b.row_type !== 'item') {
      g.rows.push({ boq_id: b.boq_id, row_type: b.row_type, description: b.description, unit: b.unit, cost_code: b.cost_code, task_code: b.task_code,
        qty: exact(b.contract_qty) });
      continue;
    }
    const dayQ = byItem.get(b.boq_id) || new Map();
    const curKey = `boq:${b.boq_id}:curr`;
    // the day quantity used by the cumulative: a 'chain' manual value replaces the activities of that day
    const qOn = (d) => {
      const ch = R.chain(curKey, d);
      if (ch) return D.of(ch.value);
      return dayQ.get(d) || 0n;
    };
    const chainDates = new Set(R.chainDates(curKey));
    const allDates = [...new Set([...dayQ.keys(), ...chainDates])].filter((d) => d <= date).sort();
    // cumulative: the latest "from this day on" target, then the later days' quantities
    const targets = R.forwardList(`boq:${b.boq_id}:cum`).filter((e) => e.from_date <= date && (!e.to_date || e.to_date >= date));
    const t = targets.length ? targets.reduce((a, x) => (x.from_date > a.from_date || (x.from_date === a.from_date && x.mv_id > a.mv_id) ? x : a)) : null;
    let cum = t ? D.of(t.value) : D.of(b.opening_qty || 0);
    for (const d of allDates) if (!t || d > t.from_date) cum = D.add(cum, qOn(d));
    const curr = qOn(date);
    const cell = (k, computed) => {
      const key = `boq:${b.boq_id}:${k}`;
      const e = k === 'cum' ? null : R.at(key, date);
      const dayCum = k === 'cum' ? (R.at(key, date) && R.at(key, date).scope === 'day' ? R.at(key, date) : null) : null;
      const m = e || dayCum;
      if (m && !(k === 'curr' && m.scope === 'chain')) return { v: m.value, s: computed, m: 'manual', e: mvOut(m) };
      if (k === 'cum' && t) return { v: computed, s: computed, m: 'adjusted', e: mvOut(t) };
      if (k === 'curr' && R.chain(curKey, date)) {
        const ch = R.chain(curKey, date);
        return { v: computed, s: dayQ.get(date) ? D.str(dayQ.get(date)) : '0', m: 'manual', e: mvOut(ch) };
      }
      return { v: computed, s: computed, m: 'computed' };
    };
    const qtyCell = cell('qty', blank(b.contract_qty) ? null : D.str(D.of(b.contract_qty)));
    const budgetCell = cell('budget', blank(b.budget) ? null : D.str(D.of(b.budget)));
    const currCell = cell('curr', D.str(curr));
    const cumCell = cell('cum', D.str(cum));
    const baseQ = !blank(qtyCell.v) ? D.of(qtyCell.v) : (!blank(budgetCell.v) ? D.of(budgetCell.v) : null);
    const balCell = cell('balance', baseQ === null ? null : D.str(D.sub(baseQ, D.of(cumCell.v))));
    const over = baseQ !== null && D.of(cumCell.v) > baseQ;
    if (over) warnings.push(`BOQ ${b.item_no}: cumulative ${cumCell.v} is more than the quantity ${D.str(baseQ)}.`);
    g.rows.push({
      boq_id: b.boq_id, row_type: 'item', item_no: b.item_no, task_code: b.task_code, cost_code: b.cost_code, description: b.description,
      unit: b.unit, is_active: b.is_active, cells: { qty: qtyCell, budget: budgetCell, curr: currCell, cum: cumCell, balance: balCell }, over,
    });
  }
  return { groups, warnings };
}

// ------------------------------------------------------------------ the day's lists
async function dayLists(cid, date) {
  const [acts] = await pool.query(
    `SELECT a.activity_id, a.sort_order, a.boq_id, b.item_no, b.description AS boq_description, b.unit AS boq_unit,
            a.description, a.location, a.qty, a.unit, a.remarks, a.area_id, ar.name AS area_name, a.chainage
       FROM dpr_activities a LEFT JOIN dpr_boq b ON b.boq_id = a.boq_id LEFT JOIN dpr_areas ar ON ar.area_id = a.area_id
      WHERE a.contract_id = ? AND a.report_date = ? AND a.is_deleted = 0 ORDER BY a.sort_order, a.activity_id`, [cid, date]);
  const ids = acts.map((a) => Number(a.activity_id));
  const crews = new Map();
  if (ids.length) {
    const [rows] = await pool.query('SELECT * FROM dpr_activity_crews WHERE activity_id IN (?) ORDER BY sort_order, crew_id', [ids]);
    for (const r of rows) {
      const list = crews.get(Number(r.activity_id)) || [];
      list.push({ crew_id: Number(r.crew_id), kind: r.kind, name: r.name, nos: exact(r.nos), hours: exact(r.hours) });
      crews.set(Number(r.activity_id), list);
    }
  }
  return acts.map((a) => ({
    activity_id: Number(a.activity_id), sort_order: Number(a.sort_order), boq_id: a.boq_id === null ? null : Number(a.boq_id),
    item_no: a.item_no || '', description: a.description || a.boq_description || '', boq_description: a.boq_description || '',
    location: a.location || '', qty: exact(a.qty), unit: a.boq_unit || a.unit || '', own_unit: a.unit || '',
    remarks: a.remarks || '', area_id: a.area_id === null ? null : Number(a.area_id), area: a.area_name || '', chainage: a.chainage || '',
    crews: crews.get(Number(a.activity_id)) || [],
  }));
}

async function materialsOn(cid, date) {
  const [rows] = await pool.query(
    `SELECT m.*, a.name AS area_name FROM dpr_materials m LEFT JOIN dpr_areas a ON a.area_id = m.area_id
      WHERE m.contract_id = ? AND m.report_date = ? AND m.is_deleted = 0 ORDER BY m.sort_order, m.material_id`, [cid, date]);
  return rows.map((r) => ({
    material_id: Number(r.material_id), sort_order: Number(r.sort_order), description: r.description, unit: r.unit || '', qty: exact(r.qty),
    supplier: r.supplier || '', delivery_note: r.delivery_note || '', mar_ref: r.mar_ref || '', area_id: r.area_id === null ? null : Number(r.area_id),
    area: r.area_name || '', element: r.element || '', boq_ref: r.boq_ref || '', intended_use: r.intended_use || '',
  }));
}

async function wirOn(cid, date) {
  const [rows] = await pool.query(
    `SELECT q.*, a.name AS area_name FROM dpr_qa q LEFT JOIN dpr_areas a ON a.area_id = q.area_id
      WHERE q.contract_id = ? AND q.report_date = ? AND q.is_deleted = 0 ORDER BY q.sort_order, q.qa_id`, [cid, date]);
  return rows.map((r) => ({
    qa_id: Number(r.qa_id), sort_order: Number(r.sort_order), type: r.type, ref_no: r.ref_no || '', description: r.description || '',
    location: r.location || '', chainage: r.chainage || '', ms_ref: r.ms_ref || '', result: r.result || '', remarks: r.remarks || '',
    area_id: r.area_id === null ? null : Number(r.area_id), area: r.area_name || '',
  }));
}

async function dayRow(cid, date) {
  const [[r]] = await pool.query(
    `SELECT *, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i') AS updated_txt FROM dpr_days WHERE contract_id = ? AND report_date = ?`, [cid, date]);
  return r || null;
}

// ------------------------------------------------------------------ header
async function headerOf(c, date) {
  const [eot] = await pool.query("SELECT type, days_granted FROM dpr_eot_vo WHERE contract_id = ? AND is_deleted = 0 AND status = 'Approved'", [c.contract_id]);
  const eotDays = eot.filter((x) => x.type === 'EOT').reduce((a, x) => a + Number(x.days_granted), 0);
  const n = dayNo(date) - dayNo(c.commencement_date) + 1;
  const completion = c.original_completion ? dateOf(dayNo(c.original_completion) + eotDays) : null;
  const sub = (s) => String(s || '').replace(/\{code\}/g, c.code).replace(/\{title\}/g, c.title);
  const f = c.form;
  return {
    doc_ref: f.doc_ref, system_title: f.system_title, department: f.department, form_title: f.form_title,
    rev_no: f.rev_no, rev_date: f.rev_date, footer_note: f.footer_note,
    project_ref: f.project_ref, contract_ref: f.contract_ref, project_manager: f.project_manager,
    report_title: sub(f.report_title),
    company_name: c.company_name, project_name: c.project_name, client: c.client, consultant: c.consultant, project_location: c.location,
    commencement_date: c.commencement_date, completion_date: completion, original_completion: c.original_completion, eot_days: eotDays,
    report_date: date, day_name: WEEKDAYS[new Date(dayNo(date) * DAY_MS).getUTCDay()], day_no: n,
    report_no: `${c.report_prefix ?? ''}${String(n).padStart(4, '0')}`,
  };
}

// ------------------------------------------------------------------ HSE (the QC's counts, no man-hours)
const HSE_FIELDS = ['tbt_topic', 'tbt_attendees', 'hse_inspections', 'incidents', 'near_misses', 'first_aid', 'lti', 'ptws', 'hse_observations'];
async function hseOf(c, date, day, manpower) {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(report_date, '%Y-%m-%d') AS d, lti, incidents, near_misses FROM dpr_days
      WHERE contract_id = ? AND report_date BETWEEN ? AND ?`, [c.contract_id, c.commencement_date, date]);
  const int = (v) => (blank(v) ? 0 : Math.trunc(Number(v)) || 0);
  const t = day || {};
  const ltiDates = rows.filter((r) => int(r.lti) > 0).map((r) => r.d).sort();
  const lastLti = ltiDates.length ? ltiDates[ltiDates.length - 1] : dateOf(dayNo(c.commencement_date) - 1);
  return {
    // printed only when something was typed for the day (0 counts as typed)
    filled: HSE_FIELDS.some((k) => !blank(t[k])),
    manpower_today: Number(manpower.grand.present.v || 0),
    tbt_topic: t.tbt_topic || '',
    tbt_attendees: int(t.tbt_attendees),
    hse_inspections_today: int(t.hse_inspections),
    incidents_today: int(t.incidents),
    near_misses_today: int(t.near_misses),
    first_aid_today: int(t.first_aid),
    lti_today: int(t.lti),
    ptws_today: int(t.ptws),
    observations: t.hse_observations || '',
    last_lti_date: lastLti,
    lti_free_days: dayNo(date) - dayNo(lastLti),
    ltis_to_date: rows.reduce((a, r) => a + int(r.lti), 0),
    incidents_to_date: rows.reduce((a, r) => a + int(r.incidents), 0),
    near_misses_to_date: rows.reduce((a, r) => a + int(r.near_misses), 0),
  };
}

// ------------------------------------------------------------------ NCR / concerns open on the report date
async function registersOn(cid, date) {
  const [[ncrRows], [concernRows]] = await Promise.all([
    pool.query('SELECT * FROM dpr_ncr WHERE contract_id = ? AND is_deleted = 0 ORDER BY date_raised, ncr_id', [cid]),
    pool.query('SELECT * FROM dpr_concerns WHERE contract_id = ? AND is_deleted = 0 ORDER BY date_raised, concern_id', [cid]),
  ]);
  const openAt = (raised, status, closed) => !blank(raised) && raised <= date && (status !== 'Closed' || (!blank(closed) && closed >= date));
  const dn = dayNo(date);
  const ncr = ncrRows.filter((x) => openAt(x.date_raised, x.status, x.date_closed)).map((x) => {
    const closedShown = x.status === 'Closed' && !blank(x.date_closed) && x.date_closed <= date;
    return {
      ncr_no: x.ncr_no || '', date_raised: x.date_raised, description: x.description || '', corrective_action: x.corrective_action || '',
      responsible: x.responsible || '', target_date: x.target_date || null, status: closedShown ? 'Closed' : 'Open',
      days_open: (closedShown ? dayNo(x.date_closed) : dn) - dayNo(x.date_raised),
    };
  });
  const concerns = concernRows.filter((x) => openAt(x.date_raised, x.status, x.date_closed)).map((x) => ({
    date_raised: x.date_raised, issue: x.issue || '', impact: x.impact || '', severity: x.severity || '',
    action_required: x.action_required || '', by_whom: x.by_whom || '', target_date: x.target_date || null,
    status: x.status === 'Closed' && !blank(x.date_closed) && x.date_closed <= date ? 'Closed' : 'Open',
  }));
  return { ncr: { entries: ncr, count: ncr.length }, concerns: { entries: concerns, count: concerns.length } };
}

// ------------------------------------------------------------------ the whole day
/**
 * @returns {Promise<{model, contract, day}>} model = what is printed + where each figure comes from.
 */
async function buildUcc(contractId, date) {
  const c = await contractRow(contractId);
  if (date < c.commencement_date) throw new DprError(`The report date cannot be before the commencement date (${c.commencement_date}).`);
  const links = {};
  const linkedContracts = new Map();
  for (const [sec, other] of Object.entries(c.section_links || {})) {
    try {
      const oc = linkedContracts.get(other) || await contractRow(other);
      linkedContracts.set(other, oc);
      links[sec] = { contract_id: oc.contract_id, code: oc.code, title: oc.title };
    } catch (_) { /* the other contract cannot give data (no commencement date): ignore the link */ }
  }
  const ctxOf = new Map();
  const ctxFor = async (cc) => {
    if (!ctxOf.has(cc.contract_id)) ctxOf.set(cc.contract_id, await loadContext(cc, date, date));
    return ctxOf.get(cc.contract_id);
  };
  const srcContract = (sec) => (links[sec] ? linkedContracts.get(links[sec].contract_id) : c);

  const own = await ctxFor(c);
  const mpCtx = await ctxFor(srcContract('manpower'));
  const plCtx = await ctxFor(srcContract('plant'));
  const day = await dayRow(c.contract_id, date);
  const weatherDay = links.weather ? await dayRow(links.weather.contract_id, date) : day;
  const notesDay = links.notes ? await dayRow(links.notes.contract_id, date) : day;
  const layout = UL.effective(c.layout, day ? day.layout : null);
  const header = await headerOf(c, date);
  const manpower = manpowerOn(mpCtx, date);
  const plant = plantOn(plCtx, date);
  const boq = await boqOn(c, own.R, date);
  const activities = await dayLists(c.contract_id, date);
  const materials = await materialsOn(links.materials ? links.materials.contract_id : c.contract_id, date);
  const wir = await wirOn(links.wir ? links.wir.contract_id : c.contract_id, date);
  const areasAll = await Setup.listAreas(c.contract_id);
  const [photos] = await pool.query(
    `SELECT photo_id, slot, file_name, content_type, boq_activity, location, caption, area_id
       FROM dpr_photos WHERE contract_id = ? AND report_date = ? AND is_deleted = 0 ORDER BY slot, photo_id`, [c.contract_id, date]);
  const photoList = photos.map((p) => ({
    photo_id: Number(p.photo_id), slot: Number(p.slot), file_name: p.file_name, content_type: p.content_type,
    boq_activity: p.boq_activity || '', location: p.location || '', caption: p.caption || '', area_id: p.area_id === null ? null : Number(p.area_id),
  }));
  const fixedPages = await Setup.listFixedPages(c.contract_id, { activeOnly: true });
  const hse = await hseOf(c, date, day, manpower);
  const registers = await registersOn(c.contract_id, date);

  // area pages: areas with an activity or a photo that day
  const areas = areasAll.filter((a) => a.is_active || activities.some((x) => x.area_id === a.area_id)).map((a) => {
    const acts = activities.filter((x) => x.area_id === a.area_id);
    return {
      area_id: a.area_id, name: a.name,
      activities: acts.map((x) => {
        const hrsOf = (cr, perDay) => (blank(cr.hours) ? (blank(cr.nos) ? null : D.str(D.mul(D.of(cr.nos), D.of(perDay)))) : D.str(D.of(cr.hours)));
        return {
          activity_id: x.activity_id, item_no: x.item_no, description: x.description, chainage: x.chainage, unit: x.unit, output: x.qty,
          plant: x.crews.filter((cr) => cr.kind === 'plant').map((cr) => ({ name: cr.name, nos: cr.nos, hours: hrsOf(cr, c.hrs_pl) })),
          trades: x.crews.filter((cr) => cr.kind === 'trade').map((cr) => ({ name: cr.name, nos: cr.nos, hours: hrsOf(cr, c.hrs_mp) })),
        };
      }),
      photos: photoList.filter((p) => p.area_id === a.area_id).map((p) => p.photo_id),
    };
  }).filter((a) => a.activities.length || a.photos.length);

  // ---------------------------------------------------------------- warnings & missing
  const warnings = [...boq.warnings];
  const missing = [];
  const sec = layout.sections;
  const wxSrc = weatherDay || {};
  if (sec.weather) {
    if (blank(wxSrc.weather_condition)) missing.push({ key: 'weather_condition', label: 'Weather', section: 'weather' });
    if (blank(wxSrc.temp_max)) missing.push({ key: 'temp_max', label: 'Max temperature', section: 'weather' });
    if (blank(wxSrc.temp_min)) missing.push({ key: 'temp_min', label: 'Min temperature', section: 'weather' });
    if (blank(wxSrc.humidity_level)) missing.push({ key: 'humidity_level', label: 'Humidity', section: 'weather' });
  }
  if (sec.activities && !activities.length) missing.push({ key: 'activities', label: 'No activity entered for the day', section: 'activities' });
  if (date >= mpCtx.sysStart && mpCtx.c.tf_site_ids.length && !(mpCtx.workers.get(date) || []).length) {
    warnings.push('Nothing came from Team Flow for this day yet (no attendance recorded on the contract sites). The figures typed by you are kept.');
  }
  if (!mpCtx.c.tf_site_ids.length) warnings.push('No Team Flow site is linked to this contract (Setup -> Sources): tradesmen are typed only.');
  if (plant.unavailable) warnings.push(`${plCtx.plantError || 'The equipment system is not reachable.'} Plant figures from the equipment system are missing.`);
  for (const t of [manpower.staff, manpower.trades]) {
    for (const r of t.rows) {
      const tot = dec(r.cells.total.v);
      const pa = D.add(dec(r.cells.present.v) || 0n, dec(r.cells.absent.v) || 0n);
      if (tot !== null && pa > tot) warnings.push(`${r.name}: present + absent (${D.str(pa)}) is more than the total (${D.str(tot)}).`);
    }
  }
  const autoCount = [...manpower.staff.rows, ...manpower.trades.rows, ...plant.plant.rows].filter((r) => r.auto).length;
  if (autoCount) warnings.push(`${autoCount} position(s) / type(s) on site have no row of their own in Setup: they are shown as automatic rows. Name them in Setup if you want.`);
  if (!c.auto_rows) {
    const mapped = new Set(mpCtx.lines.flatMap((l) => (l.map.tf || []).map(S.norm)));
    const lost = (mpCtx.workers.get(date) || []).filter((r) => !mapped.has(S.norm(r.name)));
    if (lost.length) warnings.push(`On site today but not on any row: ${lost.map((r) => `${r.name} (${r.total})`).join(', ')}.`);
  }

  const model = {
    template: 'ucc',
    engine: 'ucc-1',
    contract: { contract_id: c.contract_id, code: c.code, title: c.title },
    date,
    header,
    layout,
    links,
    weather: {
      condition: wxSrc.weather_condition || null, temp_max: blank(wxSrc.temp_max) ? null : String(Number(wxSrc.temp_max)),
      temp_min: blank(wxSrc.temp_min) ? null : String(Number(wxSrc.temp_min)), humidity_level: wxSrc.humidity_level || null,
      remarks: wxSrc.weather_remarks || '',
    },
    manpower,
    plant: { plant: plant.plant, tools: plant.tools },
    boq: { groups: boq.groups },
    activities,
    areas,
    materials,
    wir,
    notes: (notesDay && notesDay.remarks) || '',
    hse,
    next_day_plan: (day && day.next_day_plan) || '',
    ncr: registers.ncr,
    concerns: registers.concerns,
    signatures: { prepared_by: c.prepared_by || '', reviewed_by: c.reviewed_by || '', consultant_rep: c.consultant_rep || '' },
    photos: photoList,
    fixed_pages: fixedPages.map((p) => ({ page_id: p.page_id, title: p.title, file_name: p.file_name, content_type: p.content_type })),
    lists: c.lists,
    warnings,
    missing,
    sources_ok: { team_flow: true, equipment: !plant.unavailable },
  };
  model.fingerprint = fingerprint(model);
  return { model, contract: c, day };
}

/** Hash of what is printed (not of the system values behind a manual value). */
function fingerprint(model) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) {
        if (['s', 'e', 'm', 'warnings', 'missing', 'sources_ok', 'fingerprint', 'lists'].includes(k)) continue;
        o[k] = strip(v[k]);
      }
      return o;
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(strip(model))).digest('hex');
}

/**
 * Totals of each day in [from, to] (dashboard): manpower, plant. One read of the
 * systems for the whole range.
 */
async function series(contractId, from, to) {
  const c = await contractRow(contractId);
  const start = from < c.commencement_date ? c.commencement_date : from;
  if (start > to) return [];
  const mpC = c.section_links.manpower ? await contractRow(c.section_links.manpower) : c;
  const plC = c.section_links.plant ? await contractRow(c.section_links.plant) : c;
  const mpCtx = await loadContext(mpC, start, to);
  const plCtx = plC.contract_id === mpC.contract_id ? mpCtx : await loadContext(plC, start, to);
  const out = [];
  for (let d = start; d <= to; d = S.nextDay(d)) {
    const mp = manpowerOn(mpCtx, d);
    const pl = plantOn(plCtx, d);
    out.push({
      date: d, day: WEEKDAYS[new Date(dayNo(d) * DAY_MS).getUTCDay()].slice(0, 3),
      staff: Number(mp.staff.total.total.v || 0), trades: Number(mp.trades.total.total.v || 0), manpower: Number(mp.grand.total.v || 0),
      present: Number(mp.grand.present.v || 0), plant: Number(pl.plant.total.operative.v || 0) + Number(pl.plant.total.idle.v || 0) + Number(pl.plant.total.breakdown.v || 0),
    });
  }
  return out;
}

module.exports = { buildUcc, series, fingerprint, contractRow, loadContext, manpowerOn, plantOn, MP_FIELDS, PL_FIELDS, isMpLine, isPlLine };
