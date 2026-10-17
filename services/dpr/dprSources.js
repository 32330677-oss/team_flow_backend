// services/dpr/dprSources.js
//
// What the two systems say, READ ONLY. Nothing here writes anywhere.
//
// Team Flow (this database, SELECT only)
//   A person is ON SITE on a day when, for that day:
//     * workers: an attendance record dated that day on one of the contract's
//       sites, status 'Present' WITH a check-in time, not Rejected, and the
//       worker was assigned to that site + shift on that day;
//     * staff:   a staff_attendance record dated that day, 'Present' with a
//       check-in time, not Rejected, and a staff site assignment to one of the
//       contract's sites covering that day.
//   A person counts ONCE a day (even with two shifts / two sites), under his
//   position (workers.job_position, staff_members.position).
//
// Equipment system (its read-only API, never its database)
//   A machine is ON SITE on a day when its best state that day is Working,
//   Standby or Breakdown (Pending / Absent / Holiday are not on site).
//   Counted once a day, per equipment type and vendor.
'use strict';

const pool = require('../../config/db');
const equipment = require('../equipmentIntegrationClient');

const CACHE_MS = 60 * 1000;
const cache = new Map();

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = fn().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { until: Date.now() + CACHE_MS, value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

/** Forget cached figures (tests, or after "refresh"). */
function clearCache() {
  cache.clear();
}

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const posLabel = (s) => {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  return t || 'Unspecified';
};

/**
 * People on site per day and position.
 * @returns {Promise<{date: string, name: string, origin: 'worker'|'staff', count: number}[]>}
 */
function manpowerDays(siteIds, from, to) {
  if (!siteIds.length || from > to) return Promise.resolve([]);
  const key = `mp|${[...siteIds].sort((a, b) => a - b).join(',')}|${from}|${to}`;
  return cached(key, async () => {
    const [workers] = await pool.query(
      `SELECT DATE_FORMAT(a.record_date, '%Y-%m-%d') AS d, w.job_position AS pos, COUNT(DISTINCT a.worker_id) AS n
         FROM attendance a
         JOIN workers w ON w.worker_id = a.worker_id
        WHERE a.site_id IN (?) AND a.record_date BETWEEN ? AND ?
          AND a.attendance_status = 'Present' AND a.check_in_time IS NOT NULL AND a.status <> 'Rejected'
          AND EXISTS (SELECT 1 FROM workersiteassignments wsa
                       WHERE wsa.worker_id = a.worker_id AND wsa.site_id = a.site_id AND wsa.shift_type = a.shift_type
                         AND wsa.assigned_date <= a.record_date
                         AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= a.record_date))
        GROUP BY d, w.job_position`, [siteIds, from, to]);
    const [staff] = await pool.query(
      `SELECT DATE_FORMAT(sa.record_date, '%Y-%m-%d') AS d, sm.position AS pos, COUNT(DISTINCT sa.staff_id) AS n
         FROM staff_attendance sa
         JOIN staff_members sm ON sm.staff_id = sa.staff_id
        WHERE sa.record_date BETWEEN ? AND ?
          AND sa.attendance_status = 'Present' AND sa.check_in_time IS NOT NULL AND sa.status <> 'Rejected'
          AND EXISTS (SELECT 1 FROM staff_site_assignments ssa
                       WHERE ssa.staff_id = sa.staff_id AND ssa.site_id IN (?)
                         AND ssa.assigned_date <= sa.record_date
                         AND (ssa.unassigned_date IS NULL OR ssa.unassigned_date >= sa.record_date))
        GROUP BY d, sm.position`, [from, to, siteIds]);
    // two empty / spaced spellings of a position become one name
    const out = new Map();
    const add = (r, origin) => {
      const name = posLabel(r.pos);
      const k = `${r.d}|${origin}|${norm(name)}`;
      const o = out.get(k) || { date: r.d, name, origin, count: 0 };
      o.count += Number(r.n);
      out.set(k, o);
    };
    workers.forEach((r) => add(r, 'worker'));
    staff.forEach((r) => add(r, 'staff'));
    return [...out.values()];
  });
}

/**
 * Machines on site per day, type and vendor.
 * @returns {Promise<{ok: boolean, error?: string, rows: {date, type_name, vendor_name, machines}[]}>}
 */
function plantDays(siteIds, from, to) {
  if (!siteIds.length || from > to) return Promise.resolve({ ok: true, rows: [] });
  const key = `pl|${[...siteIds].sort((a, b) => a - b).join(',')}|${from}|${to}`;
  return cached(key, async () => {
    const r = await equipment.plantDays(from, to, siteIds);
    if (!r.ok) {
      cache.delete(key); // do not keep an error
      return { ok: false, error: r.error, rows: [] };
    }
    return { ok: true, rows: (r.data && r.data.rows) || [] };
  });
}

/** Machines deployed today with nothing recorded yet (warning only). */
async function plantPending(siteIds, date) {
  if (!siteIds.length) return { ok: true, pending: 0 };
  const r = await equipment.dailyPlant(date, siteIds);
  if (!r.ok) return { ok: false, error: r.error, pending: 0 };
  return { ok: true, pending: Number((r.data && r.data.totals && r.data.totals.pending) || 0) };
}

/**
 * A line's source map, cleaned:
 *   { tf: ['Steel Fixer', ...], eq: [{ type: 'Excavator', vendor: 'Al Waha' | null }, ...] }
 */
function cleanMap(raw) {
  let m = raw;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch (_) { m = null; }
  }
  const tf = [];
  const eq = [];
  if (m && typeof m === 'object') {
    for (const x of Array.isArray(m.tf) ? m.tf : []) {
      const s = String(x || '').trim().replace(/\s+/g, ' ').slice(0, 100);
      if (s && !tf.some((y) => norm(y) === norm(s))) tf.push(s);
    }
    for (const x of Array.isArray(m.eq) ? m.eq : []) {
      const type = String((x && x.type) || '').trim().slice(0, 100);
      const vendor = String((x && x.vendor) || '').trim().slice(0, 200) || null;
      if (type && !eq.some((y) => norm(y.type) === norm(type) && norm(y.vendor) === norm(vendor))) eq.push({ type, vendor });
    }
  }
  return { tf, eq };
}

const hasSource = (m) => m.tf.length > 0 || m.eq.length > 0;

/**
 * System counts per day and line.
 * @param {{line_id:number, source_map:object}[]} lines  active lines (maps cleaned)
 * @returns {Promise<{byDate: Object<string, Object<number, number>>, unmapped: {name, origin, count}[],
 *                    plantOk: boolean, plantError?: string}>}  unmapped = for the LAST date only
 */
async function systemCounts({ lines, tfSiteIds, eqSiteIds, from, to }) {
  const tfLines = new Map();
  const eqExact = new Map();
  const eqType = new Map();
  let wantsTf = false;
  let wantsEq = false;
  for (const l of lines) {
    for (const n of l.map.tf) {
      tfLines.set(norm(n), l.line_id);
      wantsTf = true;
    }
    for (const e of l.map.eq) {
      if (e.vendor) eqExact.set(`${norm(e.type)}|${norm(e.vendor)}`, l.line_id);
      else eqType.set(norm(e.type), l.line_id);
      wantsEq = true;
    }
  }
  const byDate = {};
  const bump = (d, lineId, n) => {
    byDate[d] = byDate[d] || {};
    byDate[d][lineId] = (byDate[d][lineId] || 0) + n;
  };
  const unmapped = [];

  const [mp, pl] = await Promise.all([
    tfSiteIds.length ? manpowerDays(tfSiteIds, from, to) : Promise.resolve([]),
    wantsEq && eqSiteIds.length ? plantDays(eqSiteIds, from, to) : Promise.resolve({ ok: true, rows: [] }),
  ]);
  for (const r of mp) {
    const lineId = tfLines.get(norm(r.name));
    if (lineId) bump(r.date, lineId, r.count);
    else if (r.date === to) unmapped.push({ system: 'Team Flow', name: r.name, origin: r.origin, count: r.count });
  }
  for (const r of pl.rows) {
    const lineId = eqExact.get(`${norm(r.type_name)}|${norm(r.vendor_name)}`) || eqType.get(norm(r.type_name));
    const n = Number(r.machines) || 0;
    if (lineId) bump(r.date, lineId, n);
    else if (r.date === to) unmapped.push({ system: 'Equipment', name: `${r.type_name} (${r.vendor_name})`, origin: 'machine', count: n });
  }
  return {
    byDate,
    unmapped,
    tfUsed: wantsTf,
    plantOk: pl.ok,
    plantError: pl.ok ? null : pl.error,
    eqWanted: wantsEq,
  };
}

/** Names the setup screen offers for mapping. */
async function sourceOptions({ tfSiteIds = [] } = {}) {
  const [tfSites] = await pool.query(
    `SELECT s.site_id, s.site_name, s.site_status, c.contract_name, p.project_name
       FROM sites s LEFT JOIN contracts c ON c.contract_id = s.contract_id
       LEFT JOIN projects p ON p.project_id = c.project_id
      ORDER BY s.site_status = 'Active' DESC, s.site_name`);
  const siteFilter = tfSiteIds.length ? 'AND wsa.site_id IN (?)' : '';
  const [wp] = await pool.query(
    `SELECT w.job_position AS pos, COUNT(DISTINCT w.worker_id) AS n
       FROM workers w JOIN workersiteassignments wsa ON wsa.worker_id = w.worker_id
      WHERE 1 = 1 ${siteFilter}
      GROUP BY w.job_position ORDER BY n DESC`, tfSiteIds.length ? [tfSiteIds] : []);
  const staffFilter = tfSiteIds.length ? 'AND ssa.site_id IN (?)' : '';
  const [sp] = await pool.query(
    `SELECT sm.position AS pos, COUNT(DISTINCT sm.staff_id) AS n
       FROM staff_members sm JOIN staff_site_assignments ssa ON ssa.staff_id = sm.staff_id
      WHERE 1 = 1 ${staffFilter}
      GROUP BY sm.position ORDER BY n DESC`, tfSiteIds.length ? [tfSiteIds] : []);
  const positions = new Map();
  for (const [rows, origin] of [[wp, 'worker'], [sp, 'staff']]) {
    for (const r of rows) {
      const name = posLabel(r.pos);
      const k = norm(name);
      const o = positions.get(k) || { name, workers: 0, staff: 0 };
      o[origin === 'worker' ? 'workers' : 'staff'] += Number(r.n);
      positions.set(k, o);
    }
  }
  const [eqSites, eqTypes, eqVendors] = await Promise.all([equipment.listSites(), equipment.listTypes(), equipment.listVendors()]);
  return {
    tf_sites: tfSites.map((s) => ({
      site_id: Number(s.site_id), site_name: s.site_name, status: s.site_status,
      contract_name: s.contract_name || null, project_name: s.project_name || null,
    })),
    tf_positions: [...positions.values()].sort((a, b) => a.name.localeCompare(b.name)),
    equipment_connected: eqSites.ok,
    equipment_error: eqSites.ok ? null : eqSites.error,
    eq_sites: eqSites.ok ? eqSites.data || [] : [],
    eq_types: eqTypes.ok ? (eqTypes.data || []).map((t) => ({ type_id: t.type_id, type_name: t.type_name, is_active: t.is_active })) : [],
    eq_vendors: eqVendors.ok ? (eqVendors.data || []).map((v) => ({ vendor_id: v.vendor_id, vendor_name: v.vendor_name, status: v.status })) : [],
  };
}

module.exports = { manpowerDays, plantDays, plantPending, systemCounts, sourceOptions, cleanMap, hasSource, norm, clearCache };
