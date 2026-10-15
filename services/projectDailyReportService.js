// services/projectDailyReportService.js
//
// Data of the combined PROJECT DAILY REPORT (form UCC-IMS-CM-3003A):
//
//   Team Flow (this database)          -> STAFF and TRADESMEN: TOTAL / PRESENT / ABSENT
//   Equipment Flow (its own API)       -> PLANT and TOOL: OPERATIVE / BREAKDOWN / IDLE
//   Report profile (saved by the Admin)-> header texts, project info, row lists,
//                                         name mappings, BOQ lines
//   Typed when issuing (optional)      -> weather, temperatures, humidity, activities
//   Nobody (left empty for Word)       -> BOQ progress (CURR / BALANCE), photos
//
// Same counting rules as the rest of the system:
//   * Manpower = services/dailySiteReportService.buildReportData (assigned on
//     the date, on site = Present with a check-in, all shifts, staff included).
//     TOTAL = assigned, PRESENT = on site, ABSENT = TOTAL - PRESENT.
//   * Plant = Equipment Flow /integration/daily-plant: a machine counts once a
//     day with its best state. OPERATIVE = Working, BREAKDOWN = Breakdown,
//     IDLE = Standby. Deployed machines with nothing recorded yet ("pending")
//     are reported as a warning, or counted as OPERATIVE when asked.

const pool = require('../config/db');
const { buildReportData, listReportableSites } = require('./dailySiteReportService');
const equipment = require('./equipmentIntegrationClient');
const D = require('./projectDailyReportDefaults');

const SECTION_KEYS = ['info', 'weather', 'manpower', 'plant', 'boq', 'activities', 'photos'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

class PdrError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// ------------------------------------------------------------------ small helpers
function text(v, max) {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
  return s.slice(0, max);
}
function line(v, max) {
  return text(v, max).replace(/\s*\n\s*/g, ' ');
}
function bool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function ids(v, max = 200) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(Number))].filter((n) => Number.isInteger(n) && n > 0).slice(0, max);
}
function isDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
  const [y, m, d] = String(v).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** 2026-10-12 -> 12-Oct-2026 (as on the form). */
function fmtRepDate(d) {
  if (!isDate(d)) return '';
  const [y, m, day] = d.split('-').map(Number);
  return `${String(day).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
}
/** 2025-03-18 -> 3/18/2025 (as on the form). Free text is kept. */
function fmtUsDate(d) {
  const s = String(d || '').slice(0, 10);
  if (!isDate(s)) return String(d || '');
  const [y, m, day] = s.split('-').map(Number);
  return `${m}/${day}/${y}`;
}
function json(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v;
}

// ------------------------------------------------------------------ profile config
function labelList(v, fallback) {
  if (!Array.isArray(v)) return [...fallback];
  const out = [];
  for (const x of v) {
    const s = line(x, 60);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 60) break;
  }
  return out;
}

function nameMap(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, target] of Object.entries(v).slice(0, 500)) {
    const key = D.normKey(k).slice(0, 100);
    const t = line(target, 60);
    if (key && t) out[key] = t;
  }
  return out;
}

const BOQ_FIELDS = { task_code: 20, cost_code: 30, unit: 20, quantity: 30, budget: 30, curr_1: 30, curr_2: 30, balance: 30 };
function boqRows(v, fallback) {
  if (!Array.isArray(v)) return fallback.map((r) => ({ ...r }));
  const out = [];
  for (const r of v.slice(0, 300)) {
    if (!r || typeof r !== 'object') continue;
    if (r.type === 'gap') { out.push({ type: 'gap' }); continue; }
    const row = { type: 'line', description: text(r.description, 2000) };
    for (const [k, max] of Object.entries(BOQ_FIELDS)) {
      const s = line(r[k], max);
      if (s) row[k] = s;
    }
    if (bool(r.bold, false)) row.bold = true;
    if (['green', 'gray'].includes(r.fill)) row.fill = r.fill;
    out.push(row);
  }
  return out;
}

function sectionFlags(v, fallback) {
  const base = fallback || Object.fromEntries(SECTION_KEYS.map((k) => [k, true]));
  const out = {};
  for (const k of SECTION_KEYS) out[k] = bool(v && v[k], base[k] !== false);
  return out;
}

/** A clean config from what the app sent (unknown keys dropped, limits applied). */
function sanitizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const h = r.header || {};
  const i = r.info || {};
  const defaults = r.defaults || {};
  const commencement = line(i.commencement_date, 20);
  const completion = line(i.completion_date, 20);
  return {
    header: {
      doc_ref: line(h.doc_ref ?? D.DEFAULT_HEADER.doc_ref, 40),
      rev_no: line(h.rev_no ?? D.DEFAULT_HEADER.rev_no, 10),
      rev_date: line(h.rev_date ?? D.DEFAULT_HEADER.rev_date, 20),
      page_numbers: bool(h.page_numbers, true),
    },
    info: {
      project_ref: text(i.project_ref ?? D.DEFAULT_INFO.project_ref, 120),
      contract_ref: text(i.contract_ref ?? D.DEFAULT_INFO.contract_ref, 120),
      project_name: text(i.project_name, 200),
      project_location: text(i.project_location, 200),
      client: text(i.client, 200),
      consultant: text(i.consultant, 120),
      commencement_date: commencement,
      completion_date: completion,
      agreement_title: line(i.agreement_title, 120),
    },
    tf_site_ids: ids(r.tf_site_ids),
    eq_site_ids: ids(r.eq_site_ids),
    staff_rows: labelList(r.staff_rows, D.STAFF_ROWS),
    trade_rows: labelList(r.trade_rows, D.TRADE_ROWS),
    plant_rows: labelList(r.plant_rows, D.PLANT_ROWS),
    tool_rows: labelList(r.tool_rows, []),
    staff_map: nameMap(r.staff_map),
    trade_map: nameMap(r.trade_map),
    equipment_map: nameMap(r.equipment_map),
    boq: boqRows(r.boq, D.AGREEMENT_71_BOQ),
    defaults: {
      sections: sectionFlags(defaults.sections),
      fill_present_absent: bool(defaults.fill_present_absent, true),
      pending_as_operative: bool(defaults.pending_as_operative, false),
    },
  };
}

function defaultConfig() {
  return sanitizeConfig({});
}

async function getProfile(id, { activeOnly = false } = {}) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) throw new PdrError('Choose a report profile.');
  const [[row]] = await pool.query(
    'SELECT profile_id, name, is_active, config FROM project_daily_report_profiles WHERE profile_id = ?', [pid]);
  if (!row) throw new PdrError('Report profile not found.', 404);
  if (activeOnly && Number(row.is_active) !== 1) throw new PdrError('This report profile is no longer active.');
  return { profile_id: Number(row.profile_id), name: row.name, is_active: Number(row.is_active) === 1, config: sanitizeConfig(json(row.config)) };
}

async function listProfiles() {
  const [rows] = await pool.query(
    `SELECT profile_id, name, is_active, config, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i') AS updated_at
     FROM project_daily_report_profiles ORDER BY is_active DESC, name`);
  return rows.map((r) => ({
    profile_id: Number(r.profile_id), name: r.name, is_active: Number(r.is_active) === 1,
    updated_at: r.updated_at, config: sanitizeConfig(json(r.config)),
  }));
}

// ------------------------------------------------------------------ name -> form row
/**
 * Puts each source count on a row of the form.
 * Order: the profile mapping, the built-in aliases, the same name as a row.
 * A name that matches nothing gets its own extra row (and is reported as unmapped).
 * @param {{name: string, total?: number, present?: number}[]} items
 */
function placeOnRows(items, labels, map, extraLabels = []) {
  const all = [...labels, ...extraLabels];
  const byNorm = new Map(all.map((l) => [D.normKey(l), l]));
  const rows = new Map(labels.map((l) => [l, { label: l, total: 0, present: 0, sources: [] }]));
  const extraRows = new Map(extraLabels.map((l) => [l, { label: l, total: 0, present: 0, sources: [] }]));
  const unmapped = [];
  const target = (name) => {
    const k = D.normKey(name);
    const mapped = map[k] || D.DEFAULT_ALIASES[k];
    if (mapped && byNorm.has(D.normKey(mapped))) return byNorm.get(D.normKey(mapped));
    if (byNorm.has(k)) return byNorm.get(k);
    return null;
  };
  for (const it of items) {
    const t = target(it.name);
    let row;
    if (t) row = rows.get(t) || extraRows.get(t);
    if (!row) {
      const label = String(it.name || 'Unspecified').toUpperCase().slice(0, 60);
      row = rows.get(label) || { label, total: 0, present: 0, sources: [], extra: true };
      rows.set(label, row);
      unmapped.push(it.name);
    }
    row.total += Number(it.total) || 0;
    row.present += Number(it.present) || 0;
    if (!row.sources.includes(it.name)) row.sources.push(it.name);
    for (const k of ['working', 'breakdown', 'standby', 'pending']) {
      if (it[k] !== undefined) row[k] = (row[k] || 0) + (Number(it[k]) || 0);
    }
  }
  return { rows: [...rows.values()], extraRows: [...extraRows.values()], unmapped: [...new Set(unmapped)] };
}

function sumBy(list, keys) {
  const t = {};
  for (const k of keys) t[k] = list.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return t;
}

// ------------------------------------------------------------------ data from the two systems
async function manpowerData(date, tfSiteIds) {
  const active = new Set((await listReportableSites()).map((s) => s.site_id));
  const siteIds = tfSiteIds.filter((id) => active.has(id));
  const skipped = tfSiteIds.filter((id) => !active.has(id));
  if (!siteIds.length) return { staff: [], trades: [], sites: [], skipped };
  const data = await buildReportData({ date, siteIds, shift: 'All', includeStaff: true });
  const add = (map, trade, assigned, onSite) => {
    const r = map.get(trade) || { name: trade, total: 0, present: 0 };
    r.total += assigned;
    r.present += onSite;
    map.set(trade, r);
  };
  const staff = new Map();
  const trades = new Map();
  for (const s of data.sites) {
    for (const sh of s.shifts) for (const t of sh.trades) add(trades, t.trade, t.assigned, t.on_site);
    if (s.staff) for (const t of s.staff.trades) add(staff, t.trade, t.assigned, t.on_site);
  }
  return {
    staff: [...staff.values()],
    trades: [...trades.values()],
    sites: data.sites.map((s) => ({ site_id: s.site_id, site_name: s.site_name })),
    skipped,
  };
}

async function plantData(date, eqSiteIds) {
  if (!eqSiteIds.length) return { ok: true, types: [], sites: [], work: [], totals: null };
  const r = await equipment.dailyPlant(date, eqSiteIds);
  if (!r.ok) return { ok: false, error: r.error, types: [], sites: [], work: [], totals: null };
  const d = r.data || {};
  return { ok: true, types: d.types || [], sites: d.sites || [], work: d.work_descriptions || [], totals: d.totals || null };
}

/** Project info missing from the profile is taken from Team Flow (project / contract of the sites). */
async function derivedInfo(tfSiteIds) {
  if (!tfSiteIds.length) return {};
  const [rows] = await pool.query(
    `SELECT DISTINCT p.project_name, p.client_name, p.location,
            DATE_FORMAT(c.start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(c.end_date, '%Y-%m-%d') AS end_date
     FROM sites s JOIN contracts c ON c.contract_id = s.contract_id JOIN projects p ON p.project_id = c.project_id
     WHERE s.site_id IN (?)`, [tfSiteIds]);
  const one = (k) => {
    const v = [...new Set(rows.map((r) => r[k]).filter(Boolean))];
    return v.length === 1 ? v[0] : '';
  };
  return {
    project_name: one('project_name'), client: one('client_name'), project_location: one('location'),
    commencement_date: one('start_date'), completion_date: one('end_date'),
  };
}

const WEATHER_FROM_DSR = { sunny: 'sunny', hot: 'sunny', cloudy: 'cloudy', rain: 'rainy', storm: 'rainy', dust: 'dusty', wind: 'dusty' };

/** Weather and work typed in the Daily Site Reports of the same date (same sites) + machine work. */
async function suggestions(date, tfSiteIds, plant) {
  const out = { weather: {}, activities: [] };
  const [rows] = await pool.query(
    `SELECT payload FROM daily_site_reports WHERE report_date = ? ORDER BY report_id DESC LIMIT 20`, [date]);
  const wanted = new Set(tfSiteIds);
  const seenSite = new Set();
  const seenText = new Set();
  for (const r of rows) {
    const p = json(r.payload);
    for (const s of (p && p.sites) || []) {
      if (!wanted.has(Number(s.site_id)) || seenSite.has(s.site_id) || !s.notes) continue;
      seenSite.add(s.site_id);
      const w = WEATHER_FROM_DSR[s.notes.weather];
      if (w) out.weather[w] = true;
      for (const l of String(s.notes.work_done || '').split('\n')) {
        const t = l.replace(/^[\s\-•*\d.)]+/, '').trim();
        const k = `${t.toLowerCase()}|${s.site_name}`;
        if (t && !seenText.has(k)) {
          seenText.add(k);
          out.activities.push({ description: t.slice(0, 300), location: String(s.site_name || '').slice(0, 120), source: 'site_report' });
        }
      }
    }
  }
  for (const w of plant.work || []) {
    const k = `${String(w.text).toLowerCase()}|${w.site_name}`;
    if (!seenText.has(k)) {
      seenText.add(k);
      out.activities.push({ description: String(w.text).slice(0, 300), location: String(w.site_name || '').slice(0, 120), source: 'equipment' });
    }
  }
  out.activities = out.activities.slice(0, 30);
  return out;
}

// ------------------------------------------------------------------ request -> model
function parseWeather(v) {
  const w = v && typeof v === 'object' ? v : {};
  const t = (x) => line(x, 6);
  const hum = String(w.humidity || '').toLowerCase();
  return {
    sunny: bool(w.sunny, false), rainy: bool(w.rainy, false), cloudy: bool(w.cloudy, false), dusty: bool(w.dusty, false),
    temp_max: t(w.temp_max), temp_min: t(w.temp_min),
    humidity: ['high', 'medium', 'low'].includes(hum) ? hum : '',
  };
}

function parseActivities(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 30)
    .map((a) => ({ description: text(a && a.description, 300), location: line(a && a.location, 120) }))
    .filter((a) => a.description || a.location);
}

/**
 * Everything printed, for one profile and date.
 * @returns {{ model: object, extra: { warnings: string[], unmapped: object, sources: object, suggestions: object } }}
 */
async function buildModel(profile, body, today) {
  const b = body || {};
  const date = b.date ? String(b.date) : today;
  if (!isDate(date)) throw new PdrError('date must use YYYY-MM-DD.');
  if (date > today) throw new PdrError('The report date cannot be in the future.');
  const cfg = profile.config;
  const sections = sectionFlags(b.sections, cfg.defaults.sections);
  const fillPresentAbsent = bool(b.fill_present_absent, cfg.defaults.fill_present_absent);
  const pendingAsOperative = bool(b.pending_as_operative, cfg.defaults.pending_as_operative);
  const warnings = [];

  const [mp, plant, derived] = await Promise.all([
    sections.manpower ? manpowerData(date, cfg.tf_site_ids) : Promise.resolve({ staff: [], trades: [], sites: [], skipped: [] }),
    (sections.plant || sections.activities) ? plantData(date, cfg.eq_site_ids) : Promise.resolve({ ok: true, types: [], sites: [], work: [] }),
    derivedInfo(cfg.tf_site_ids),
  ]);
  if (sections.manpower && !cfg.tf_site_ids.length) warnings.push('No Team Flow site is linked to this profile: manpower is empty.');
  if (mp.skipped && mp.skipped.length) warnings.push(`Team Flow sites not Active were skipped: ${mp.skipped.join(', ')}.`);
  if (sections.plant && !cfg.eq_site_ids.length) warnings.push('No equipment site is linked to this profile: plant is empty.');
  if (!plant.ok) warnings.push(`${plant.error} The plant section is printed empty.`);

  // manpower
  const staffPlaced = placeOnRows(mp.staff, cfg.staff_rows, cfg.staff_map);
  const tradePlaced = placeOnRows(mp.trades, cfg.trade_rows, cfg.trade_map);
  const fin = (r) => ({ label: r.label, total: r.total, present: r.present, absent: Math.max(r.total - r.present, 0) });
  const staffRows = staffPlaced.rows.map(fin);
  const tradeRows = tradePlaced.rows.map(fin);
  const lines = Math.max(D.MANPOWER_MIN_LINES, staffRows.length, tradeRows.length);
  while (staffRows.length < lines) staffRows.push({ label: '' });
  while (tradeRows.length < lines) tradeRows.push({ label: '' });
  const staffTotal = sumBy(staffRows, ['total', 'present', 'absent']);
  const tradeTotal = sumBy(tradeRows, ['total', 'present', 'absent']);

  // plant / tools
  const items = (plant.types || []).map((t) => ({
    name: t.type_name, working: t.working, breakdown: t.breakdown, standby: t.standby, pending: t.pending,
  }));
  const placed = placeOnRows(items, cfg.plant_rows, cfg.equipment_map, cfg.tool_rows);
  const toPlant = (r) => ({
    label: r.label,
    operative: (r.working || 0) + (pendingAsOperative ? (r.pending || 0) : 0),
    breakdown: r.breakdown || 0,
    idle: r.standby || 0,
  });
  const plantRows = placed.rows.map(toPlant);
  const toolRows = placed.extraRows.map(toPlant);
  while (toolRows.length < plantRows.length) toolRows.push({ label: '' });
  const pending = (plant.types || []).reduce((a, t) => a + (Number(t.pending) || 0), 0);
  if (sections.plant && pending) {
    warnings.push(pendingAsOperative
      ? `${pending} machine(s) deployed with nothing recorded yet are counted as OPERATIVE.`
      : `${pending} machine(s) are deployed but have nothing recorded yet for this date: not counted.`);
  }

  const info = cfg.info;
  const pick = (k) => info[k] || derived[k] || '';
  const model = {
    layout: 1,
    report_date: date,
    header: { ...cfg.header, rep_date: fmtRepDate(date) },
    info: {
      project_ref: info.project_ref,
      contract_ref: info.contract_ref,
      project_name: pick('project_name'),
      project_location: pick('project_location'),
      client: pick('client'),
      consultant: info.consultant,
      commencement: fmtUsDate(pick('commencement_date')),
      completion: fmtUsDate(pick('completion_date')),
      report_date: fmtRepDate(date),
      agreement_title: info.agreement_title || profile.name,
    },
    sections,
    fill_present_absent: fillPresentAbsent,
    weather: parseWeather(b.weather),
    staff_rows: staffRows,
    trade_rows: tradeRows,
    staff_total: staffTotal,
    trade_total: tradeTotal,
    grand_total: staffTotal.total + tradeTotal.total,
    plant_rows: plantRows,
    tool_rows: toolRows,
    plant_total: sumBy(plantRows, ['operative', 'breakdown', 'idle']),
    tool_total: sumBy(toolRows, ['operative', 'breakdown', 'idle']),
    boq: cfg.boq,
    activities: parseActivities(b.activities),
  };

  return {
    model,
    extra: {
      warnings,
      unmapped: { staff: staffPlaced.unmapped, trades: tradePlaced.unmapped, equipment: placed.unmapped },
      sources: {
        team_flow_sites: mp.sites,
        equipment_sites: plant.sites || [],
        equipment_ok: plant.ok,
        pending_machines: pending,
      },
      suggestions: await suggestions(date, cfg.tf_site_ids, plant),
    },
  };
}

module.exports = {
  PdrError, SECTION_KEYS, sanitizeConfig, defaultConfig, getProfile, listProfiles, buildModel,
  _internal: { placeOnRows, fmtRepDate, fmtUsDate, parseWeather, parseActivities },
};
