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
 *   { tf: ['Steel Fixer', ...], sp: ['SITE ENGINEER', ...] (staff positions, v2),
 *     eq: [{ type: 'Excavator', vendor: 'Al Waha' | null }, ...] }
 */
function cleanMap(raw) {
  let m = raw;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch (_) { m = null; }
  }
  const tf = [];
  const sp = [];
  const eq = [];
  if (m && typeof m === 'object') {
    for (const x of Array.isArray(m.tf) ? m.tf : []) {
      const s = String(x || '').trim().replace(/\s+/g, ' ').slice(0, 100);
      if (s && !tf.some((y) => norm(y) === norm(s))) tf.push(s);
    }
    for (const x of Array.isArray(m.sp) ? m.sp : []) {
      const s = String(x || '').trim().replace(/\s+/g, ' ').slice(0, 100);
      if (s && !sp.some((y) => norm(y) === norm(s))) sp.push(s);
    }
    for (const x of Array.isArray(m.eq) ? m.eq : []) {
      const type = String((x && x.type) || '').trim().slice(0, 100);
      const vendor = String((x && x.vendor) || '').trim().slice(0, 200) || null;
      if (type && !eq.some((y) => norm(y.type) === norm(type) && norm(y.vendor) === norm(vendor))) eq.push({ type, vendor });
    }
  }
  return sp.length ? { tf, sp, eq } : { tf, eq };
}

const hasSource = (m) => m.tf.length > 0 || m.eq.length > 0 || (m.sp || []).length > 0;

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

// =====================================================================
// v2 (the client's form): Total / Present / Absent per position, staff from
// the staff list, plant as Operative / Breakdown / Idle, people per site.
// COUNTS ONLY: no name, no salary, nothing personal leaves these functions.
// =====================================================================
const COUNT_MODES = ['recorded', 'checked_in', 'approved'];
const ABSENT_STATES = ['Absent', 'Sick', 'Vacation', 'Holiday'];

/**
 * SQL pieces of the counting mode:
 *   recorded   = any attendance record of the day (Draft, Submitted, Approved; not Rejected)
 *   checked_in = as recorded, but "Present" needs a check-in time
 *   approved   = only approved records
 */
function modeSql(mode, a) {
  const m = COUNT_MODES.includes(mode) ? mode : 'recorded';
  const present = m === 'checked_in'
    ? `(${a}.attendance_status = 'Present' AND ${a}.check_in_time IS NOT NULL)`
    : `${a}.attendance_status = 'Present'`;
  const status = m === 'approved' ? `${a}.status = 'Approved'` : `${a}.status <> 'Rejected'`;
  return { present, absent: `${a}.attendance_status IN ('Absent','Sick','Vacation','Holiday')`, status };
}

/**
 * Workers per day and position on the given sites: a worker is PRESENT if one of his
 * records of the day is present, otherwise ABSENT if one is absent / sick / vacation /
 * holiday. Counted once a day (two shifts = one person). Total = present + absent.
 * @returns {Promise<{date, name, present, absent, total}[]>}
 */
function workersV2(siteIds, from, to, mode) {
  if (!siteIds.length || from > to) return Promise.resolve([]);
  const key = `w2|${mode}|${[...siteIds].sort((a, b) => a - b).join(',')}|${from}|${to}`;
  return cached(key, async () => {
    const q = modeSql(mode, 'a');
    const [rows] = await pool.query(
      `SELECT x.d, x.pos, SUM(x.p) AS present, SUM(CASE WHEN x.p = 0 AND x.ab = 1 THEN 1 ELSE 0 END) AS absent
         FROM (SELECT DATE_FORMAT(a.record_date, '%Y-%m-%d') AS d, a.worker_id, w.job_position AS pos,
                      MAX(CASE WHEN ${q.present} THEN 1 ELSE 0 END) AS p,
                      MAX(CASE WHEN ${q.absent} THEN 1 ELSE 0 END) AS ab
                 FROM attendance a JOIN workers w ON w.worker_id = a.worker_id
                WHERE a.site_id IN (?) AND a.record_date BETWEEN ? AND ? AND ${q.status}
                GROUP BY d, a.worker_id, w.job_position) x
        GROUP BY x.d, x.pos`, [siteIds, from, to]);
    const out = new Map();
    for (const r of rows) {
      const name = posLabel(r.pos);
      const k = `${r.d}|${norm(name)}`;
      const o = out.get(k) || { date: r.d, name, present: 0, absent: 0, total: 0 };
      o.present += Number(r.present);
      o.absent += Number(r.absent);
      o.total = o.present + o.absent;
      out.set(k, o);
    }
    return [...out.values()];
  });
}

/**
 * Staff per day and position (staff have no site: the whole staff list is read).
 * Total = staff employed that day (hired, not terminated, not inactive).
 * Present / absent = from the staff attendance of the day; null when no staff
 * attendance at all is recorded for that day (then the QC fills them).
 * @returns {Promise<{date, name, present, absent, total}[]>}
 */
function staffV2(from, to, mode) {
  if (from > to) return Promise.resolve([]);
  const key = `s2|${mode}|${from}|${to}`;
  return cached(key, async () => {
    const [staff] = await pool.query(
      `SELECT staff_id, position, DATE_FORMAT(hire_date, '%Y-%m-%d') AS hire, DATE_FORMAT(termination_date, '%Y-%m-%d') AS term, status
         FROM staff_members WHERE status <> 'Inactive'`);
    const q = modeSql(mode, 'sa');
    const [att] = await pool.query(
      `SELECT DATE_FORMAT(sa.record_date, '%Y-%m-%d') AS d, sa.staff_id,
              MAX(CASE WHEN ${q.present} THEN 1 ELSE 0 END) AS p,
              MAX(CASE WHEN ${q.absent} THEN 1 ELSE 0 END) AS ab
         FROM staff_attendance sa
        WHERE sa.record_date BETWEEN ? AND ? AND ${q.status}
        GROUP BY d, sa.staff_id`, [from, to]);
    const attBy = new Map();
    for (const r of att) {
      const m = attBy.get(r.d) || new Map();
      m.set(Number(r.staff_id), { p: Number(r.p), ab: Number(r.ab) });
      attBy.set(r.d, m);
    }
    const out = [];
    for (let d = from; d <= to; d = nextDay(d)) {
      const dayAtt = attBy.get(d) || null;
      const byPos = new Map();
      for (const s of staff) {
        const employed = (!s.hire || s.hire <= d) && (s.term ? s.term >= d : s.status === 'Active');
        if (!employed) continue;
        const name = posLabel(s.position);
        const k = norm(name);
        const o = byPos.get(k) || { date: d, name, total: 0, present: dayAtt ? 0 : null, absent: dayAtt ? 0 : null };
        o.total += 1;
        if (dayAtt) {
          const a = dayAtt.get(Number(s.staff_id));
          if (a && a.p) o.present += 1;
          else if (a && a.ab) o.absent += 1;
        }
        byPos.set(k, o);
      }
      out.push(...byPos.values());
    }
    return out;
  });
}

function nextDay(d) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/**
 * Machines per day, type and vendor: Operative (Working), Breakdown, Idle (Standby).
 * @returns {Promise<{ok, error?, rows: {date, type_name, vendor_name, operative, breakdown, idle}[]}>}
 */
async function plantV2(siteIds, from, to) {
  const r = await plantDays(siteIds, from, to);
  return {
    ok: r.ok,
    error: r.error,
    rows: (r.rows || []).map((x) => ({
      date: x.date, type_name: x.type_name, vendor_name: x.vendor_name,
      operative: Number(x.working) || 0, breakdown: Number(x.breakdown) || 0, idle: Number(x.standby) || 0,
    })),
  };
}

/**
 * Workers of the day on EVERY Team Flow site (counts only), for the QC's check:
 * assigned, present, absent, not recorded yet - per site and shift.
 */
async function sitesToday(date, mode) {
  const q = modeSql(mode, 'a');
  const [sites] = await pool.query(
    `SELECT site_id, site_name, site_status FROM sites ORDER BY site_status = 'Active' DESC, site_name`);
  const assignedSql = (by) => `SELECT site_id${by ? ', shift_type' : ''}, COUNT(DISTINCT worker_id) AS n FROM workersiteassignments
      WHERE assigned_date <= ? AND (unassigned_date IS NULL OR unassigned_date >= ?)
      GROUP BY site_id${by ? ', shift_type' : ''}`;
  const attSql = (by) => `SELECT x.site_id${by ? ', x.shift_type' : ''}, SUM(x.p) AS present,
            SUM(CASE WHEN x.p = 0 AND x.ab = 1 THEN 1 ELSE 0 END) AS absent, COUNT(*) AS recorded
       FROM (SELECT a.site_id${by ? ', a.shift_type' : ''}, a.worker_id,
                    MAX(CASE WHEN ${q.present} THEN 1 ELSE 0 END) AS p,
                    MAX(CASE WHEN ${q.absent} THEN 1 ELSE 0 END) AS ab
               FROM attendance a WHERE a.record_date = ? AND ${q.status}
              GROUP BY a.site_id${by ? ', a.shift_type' : ''}, a.worker_id) x
      GROUP BY x.site_id${by ? ', x.shift_type' : ''}`;
  const [[asgShift], [asgSite], [attShift], [attSite]] = await Promise.all([
    pool.query(assignedSql(true), [date, date]), pool.query(assignedSql(false), [date, date]),
    pool.query(attSql(true), [date]), pool.query(attSql(false), [date]),
  ]);
  const key = (s, sh) => `${s}|${sh}`;
  const asg = new Map(asgShift.map((r) => [key(r.site_id, r.shift_type), Number(r.n)]));
  const at = new Map(attShift.map((r) => [key(r.site_id, r.shift_type), r]));
  const asgS = new Map(asgSite.map((r) => [Number(r.site_id), Number(r.n)]));
  const atS = new Map(attSite.map((r) => [Number(r.site_id), r]));
  const nums = (a, n) => {
    const present = a ? Number(a.present) : 0;
    const absent = a ? Number(a.absent) : 0;
    const recorded = a ? Number(a.recorded) : 0;
    return { assigned: n, present, absent, recorded, not_recorded: Math.max(n - recorded, 0) };
  };
  const out = [];
  for (const s of sites) {
    const shifts = [];
    for (const sh of ['Day', 'Night']) {
      const a = at.get(key(s.site_id, sh));
      const n = asg.get(key(s.site_id, sh)) || 0;
      if (!a && !n) continue;
      shifts.push({ shift: sh, ...nums(a, n) });
    }
    if (!shifts.length && s.site_status !== 'Active') continue;
    // the site's own figures count each person once (two shifts = one person)
    out.push({ site_id: Number(s.site_id), site_name: s.site_name, status: s.site_status, shifts,
      ...nums(atS.get(Number(s.site_id)), asgS.get(Number(s.site_id)) || 0) });
  }
  return out;
}

/** Staff positions with the number of staff employed now (counts only). */
async function staffPositions() {
  const [rows] = await pool.query(
    `SELECT position AS pos, COUNT(*) AS n FROM staff_members
      WHERE status = 'Active' AND (termination_date IS NULL OR termination_date >= CURDATE())
      GROUP BY position`);
  const m = new Map();
  for (const r of rows) {
    const name = posLabel(r.pos);
    const o = m.get(norm(name)) || { name, staff: 0 };
    o.staff += Number(r.n);
    m.set(norm(name), o);
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  manpowerDays, plantDays, plantPending, systemCounts, sourceOptions, cleanMap, hasSource, norm, clearCache,
  COUNT_MODES, workersV2, staffV2, plantV2, sitesToday, staffPositions, posLabel, nextDay,
};
