// services/dpr/dprModel.js
//
// Builds the report of one contract for one date:
//   1. reads the contract's own DPR data (dpr_* tables),
//   2. reads the system figures (services/dpr/dprSources.js, read only),
//   3. applies the manual values (overrides) on top of the system figures,
//   4. runs the engine (services/dpr/dprCalc.js).
// Each line's figure of the day says where it comes from:
//   system   = Team Flow / Equipment (the line has a source)
//   override = a manual value typed over the system value (reason kept)
//   manual   = typed every day (the line has no source)
'use strict';

const pool = require('../../config/db');
const calc = require('./dprCalc');
const C = require('./dprCommon');
const S = require('./dprSources');
const Setup = require('./dprSetup');

const { DprError } = C;

const DAY_FIELDS = ['weather_am', 'weather_pm', 'temp_max', 'temp_min', 'humidity', 'wind', 'hours_lost', 'weather_remarks',
  'tbt_topic', 'tbt_attendees', 'hse_inspections', 'incidents', 'near_misses', 'first_aid', 'lti', 'ptws',
  'hse_observations', 'next_day_plan', 'remarks'];

/** Fields the report expects every day (missing ones are listed as a warning, never blocking). */
const EXPECTED = [
  { key: 'weather_am', label: 'Weather – morning', section: 'weather' },
  { key: 'weather_pm', label: 'Weather – afternoon', section: 'weather' },
  { key: 'temp_max', label: 'Max °C', section: 'weather' },
  { key: 'temp_min', label: 'Min °C', section: 'weather' },
  { key: 'humidity', label: 'Humidity %', section: 'weather' },
  { key: 'wind', label: 'Wind km/h', section: 'weather' },
  { key: 'hours_lost', label: 'Hours lost', section: 'weather' },
  { key: 'tbt_topic', label: 'Toolbox talk topic', section: 'hse' },
  { key: 'tbt_attendees', label: 'Toolbox talk attendees', section: 'hse' },
  { key: 'incidents', label: 'Incidents today', section: 'hse' },
  { key: 'near_misses', label: 'Near misses today', section: 'hse' },
  { key: 'first_aid', label: 'First aid cases today', section: 'hse' },
  { key: 'lti', label: 'LTI today', section: 'hse' },
  { key: 'ptws', label: 'PTWs issued today', section: 'hse' },
  { key: 'hse_inspections', label: 'HSE inspections today', section: 'hse' },
  { key: 'next_day_plan', label: 'Planned activities – next working day', section: 'plan' },
];

function dayOut(r) {
  const out = {};
  for (const k of DAY_FIELDS) out[k] = r && r[k] !== undefined && r[k] !== null ? r[k] : null;
  for (const k of ['temp_max', 'temp_min', 'humidity', 'wind', 'hours_lost']) {
    if (out[k] !== null) out[k] = String(Number(out[k]));
  }
  return out;
}

/** The contract row, checked usable for daily reports. */
async function contractForDays(contractId) {
  const [[row]] = await pool.query('SELECT * FROM dpr_contracts WHERE contract_id = ?', [contractId]);
  if (!row) throw new DprError('Contract not found.', 404);
  const c = Setup.contractOut(row);
  if (!c.commencement_date) throw new DprError('Set the commencement date of this contract in Setup first.', 409);
  return c;
}

function checkDate(c, date) {
  if (date < c.commencement_date) throw new DprError(`The report date cannot be before the commencement date (${c.commencement_date}).`);
}

/**
 * Effective counts of every day from commencement to `date`, plus where each value of
 * `date` comes from.
 */
async function effectiveCounts(c, lines, date) {
  const from = c.commencement_date;
  const srcLines = lines.filter((l) => S.hasSource(l.map));
  const sys = await S.systemCounts({ lines: srcLines, tfSiteIds: c.tf_site_ids, eqSiteIds: c.eq_site_ids, from, to: date });
  const [typed] = await pool.query(
    `SELECT DATE_FORMAT(report_date, '%Y-%m-%d') AS d, line_id, count_value
       FROM dpr_day_counts WHERE contract_id = ? AND report_date BETWEEN ? AND ?`, [c.contract_id, from, date]);
  const [ovs] = await pool.query(
    `SELECT o.override_id, DATE_FORMAT(o.report_date, '%Y-%m-%d') AS d, o.field_key, o.system_value, o.manual_value, o.reason,
            DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i') AS created_at, u.full_name AS created_by
       FROM dpr_overrides o LEFT JOIN users u ON u.user_id = o.created_by_user_id
      WHERE o.contract_id = ? AND o.report_date BETWEEN ? AND ? AND o.reverted_at IS NULL
      ORDER BY o.override_id`, [c.contract_id, from, date]);

  const counts = {};
  const put = (d, lid, v) => {
    counts[d] = counts[d] || {};
    counts[d][lid] = v;
  };
  const sourced = new Set(srcLines.map((l) => l.line_id));
  const plantDown = !sys.plantOk;
  // 1. system figures (lines with a source)
  for (const [d, row] of Object.entries(sys.byDate)) {
    for (const [lid, v] of Object.entries(row)) if (sourced.has(Number(lid))) put(d, Number(lid), v);
  }
  // 2. typed figures (lines without a source)
  for (const t of typed) {
    if (!sourced.has(Number(t.line_id))) put(t.d, Number(t.line_id), Number(t.count_value));
  }
  // 3. manual values over the system figures (the latest one of each day + line)
  const activeOv = new Map();
  for (const o of ovs) {
    const m = /^line:(\d+)$/.exec(o.field_key);
    if (!m) continue;
    const lid = Number(m[1]);
    if (!sourced.has(lid)) continue;
    activeOv.set(`${o.d}|${lid}`, o);
  }
  for (const [k, o] of activeOv) {
    const [d, lid] = k.split('|');
    put(d, Number(lid), Number(o.manual_value));
  }

  // where the figures of `date` come from
  const sources = {};
  for (const l of lines) {
    const sysVal = (sys.byDate[date] || {})[l.line_id] || 0;
    const ov = activeOv.get(`${date}|${l.line_id}`);
    const usesEq = l.map.eq.length > 0;
    if (!S.hasSource(l.map)) {
      sources[l.line_id] = { mode: 'manual', system_value: null, override: null };
    } else {
      sources[l.line_id] = {
        mode: ov ? 'override' : 'system',
        system: [l.map.tf.length ? 'Team Flow' : null, usesEq ? 'Equipment' : null].filter(Boolean).join(' + '),
        system_value: usesEq && plantDown && !l.map.tf.length ? null : sysVal,
        override: ov ? {
          override_id: Number(ov.override_id), value: Number(ov.manual_value), system_value_then: ov.system_value === null ? null : Number(ov.system_value),
          reason: ov.reason, by: ov.created_by || '', at: ov.created_at,
        } : null,
        unavailable: usesEq && plantDown,
      };
    }
  }
  return { counts, sources, unmapped: sys.unmapped, plantOk: sys.plantOk, plantError: sys.plantError, eqWanted: sys.eqWanted };
}

/**
 * Everything the engine needs for (contract, date). `photos` and the day row are added for the
 * screens / printing.
 */
async function loadInput(contractId, date) {
  const c = await contractForDays(contractId);
  checkDate(c, date);
  const cid = c.contract_id;
  const [eot, linesAll, boqAll] = await Promise.all([Setup.listEotVo(cid), Setup.listLines(cid, { activeOnly: true }), Setup.listBoq(cid)]);
  const lines = linesAll.map((l) => ({ ...l, map: l.source_map }));
  const eff = await effectiveCounts(c, lines, date);

  const [acts] = await pool.query(
    `SELECT a.activity_id, DATE_FORMAT(a.report_date, '%Y-%m-%d') AS d, a.sort_order, a.boq_id, a.location, a.qty, a.remarks
       FROM dpr_activities a WHERE a.contract_id = ? AND a.report_date <= ? AND a.is_deleted = 0
      ORDER BY a.report_date, a.sort_order, a.activity_id`, [cid, date]);
  const [alloc] = await pool.query(
    `SELECT al.activity_id, al.line_id, al.count_value FROM dpr_activity_alloc al
       JOIN dpr_activities a ON a.activity_id = al.activity_id
      WHERE a.contract_id = ? AND a.report_date = ? AND a.is_deleted = 0 AND al.count_value <> 0`, [cid, date]);
  const allocBy = new Map();
  for (const x of alloc) {
    const m = allocBy.get(Number(x.activity_id)) || {};
    m[Number(x.line_id)] = Number(x.count_value);
    allocBy.set(Number(x.activity_id), m);
  }
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(report_date, '%Y-%m-%d') AS d, ${DAY_FIELDS.join(', ')}, sections, version,
            DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i') AS updated_at
       FROM dpr_days WHERE contract_id = ? AND report_date BETWEEN ? AND ?`, [cid, c.commencement_date, date]);
  const site = {};
  let dayRow = null;
  for (const d of days) {
    site[d.d] = dayOut(d);
    if (d.d === date) dayRow = d;
  }
  const [qa] = await pool.query(
    `SELECT qa_id, DATE_FORMAT(report_date, '%Y-%m-%d') AS d, type, ref_no, description, location, result, remarks
       FROM dpr_qa WHERE contract_id = ? AND report_date = ? AND is_deleted = 0 ORDER BY sort_order, qa_id`, [cid, date]);
  const [ncr] = await pool.query(
    'SELECT * FROM dpr_ncr WHERE contract_id = ? AND is_deleted = 0 ORDER BY date_raised, ncr_id', [cid]);
  const [concerns] = await pool.query(
    'SELECT * FROM dpr_concerns WHERE contract_id = ? AND is_deleted = 0 ORDER BY date_raised, concern_id', [cid]);
  const [photos] = await pool.query(
    `SELECT photo_id, slot, file_name, content_type, boq_activity, location, caption
       FROM dpr_photos WHERE contract_id = ? AND report_date = ? AND is_deleted = 0 ORDER BY slot, photo_id`, [cid, date]);

  // only active BOQ items are listed / chosen, but activities of an item switched off still count
  const boq = boqAll.map((b) => ({ ...b }));
  const input = {
    date,
    contract: c,
    eot_vo: eot,
    lines: lines.map((l) => ({ ...l })),
    boq,
    counts: eff.counts,
    sources: eff.sources,
    activities: acts.map((a) => ({
      activity_id: Number(a.activity_id), date: a.d, boq_id: Number(a.boq_id), location: a.location,
      qty: a.qty, remarks: a.remarks, alloc: a.d === date ? (allocBy.get(Number(a.activity_id)) || {}) : {},
    })),
    site,
    qa: qa.map((q) => ({ ...q, date: q.d })),
    ncr: ncr.map((x) => ({ ...x, ncr_id: Number(x.ncr_id) })),
    concerns: concerns.map((x) => ({ ...x, concern_id: Number(x.concern_id) })),
  };
  return {
    input,
    contract: c,
    dayRow,
    photos: photos.map((p) => ({
      photo_id: Number(p.photo_id), slot: Number(p.slot), file_name: p.file_name, content_type: p.content_type,
      boq_activity: p.boq_activity || '', location: p.location || '', caption: p.caption || '',
    })),
    eff,
  };
}

/** The report model + what the screens need around it. */
async function buildDay(contractId, date) {
  const L = await loadInput(contractId, date);
  const model = calc.compute(L.input);
  const sections = C.sectionFlags(L.dayRow ? L.dayRow.sections : null, L.contract.sections);
  const today = L.input.site[date] || {};
  const missing = EXPECTED.filter((e) => sections[e.section] !== false && (today[e.key] === null || today[e.key] === undefined || today[e.key] === ''))
    .map((e) => ({ key: e.key, label: e.label, section: e.section }));
  if (sections.work !== false && model.work.count === 0) missing.push({ key: 'activities', label: 'No activity entered for the day', section: 'work' });

  const warnings = [...model.warnings];
  if (!L.contract.tf_site_ids.length && L.input.lines.some((l) => l.map.tf.length)) {
    warnings.push('No Team Flow site is linked to this contract: manpower from Team Flow is 0.');
  }
  if (L.eff.eqWanted && !L.eff.plantOk) {
    warnings.push(`${L.eff.plantError || 'The equipment system is not reachable.'} Plant figures from the equipment system are missing.`);
  }
  if (L.eff.unmapped.length) {
    warnings.push(`On site today but not on any line: ${L.eff.unmapped.map((u) => `${u.name} (${u.count})`).join(', ')}. Add them to a line in Setup.`);
  }
  model.sections = sections;
  model.photos = L.photos.map((p) => ({ ...p }));
  model.warnings = warnings;
  model.missing = missing;
  model.contract = { contract_id: L.contract.contract_id, code: L.contract.code, title: L.contract.title, currency: L.contract.currency };
  model.sources_ok = { team_flow: true, equipment: !(L.eff.eqWanted && !L.eff.plantOk) };
  model.unmapped = L.eff.unmapped;
  return { model, L };
}

module.exports = { DAY_FIELDS, EXPECTED, dayOut, contractForDays, checkDate, loadInput, buildDay, effectiveCounts };
