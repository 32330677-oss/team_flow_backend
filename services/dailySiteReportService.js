// services/dailySiteReportService.js
//
// Data for the Daily Site Manpower Report (sent to the sub-contractor /
// client). Read-only. No hours, no rates, no money, no personal data.
//
// Rules (same definitions as the rest of the system):
//   * Assigned on D  = Active worker with a workersiteassignments row that
//     covers D (services/assignmentDates.activeOn, inclusive last day), on an
//     Active site, per site + shift.
//   * The report for D uses the attendance records DATED D only (a Night shift
//     that starts on D is dated D). Records from D-1 are never counted on D.
//   * On site = attendance_status 'Present' with a check-in time.
//     Workflow status (Draft / Submitted / Approved) is NOT a filter: the
//     report is issued during the day, before the Admin approves. The PDF says
//     so in its footer note.
//   * Absent / Sick / Leave (Vacation) / Holiday = that attendance_status.
//   * No record = assigned but nothing recorded for D yet.
//   * Staff: staff_site_assignments covering D + staff_attendance dated D.
//     Staff have no shift; they are reported once per site, whatever shift
//     filter is chosen (optional: includeStaff).

const pool = require('../config/db');
const { activeOn } = require('./assignmentDates');

const SHIFTS = ['Day', 'Night'];

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function hhmm(dt) {
  if (!dt) return null;
  const s = String(dt);
  const m = s.match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

function stateOf(row) {
  if (!row.attendance_id) return 'no_record';
  switch (row.attendance_status) {
    case 'Absent': return 'absent';
    case 'Sick': return 'sick';
    case 'Vacation': return 'leave';
    case 'Holiday': return 'holiday';
    default: break;
  }
  return row.check_in_time ? 'on_site' : 'no_record';
}

function emptyCounts() {
  return { assigned: 0, on_site: 0, absent: 0, sick: 0, leave: 0, holiday: 0, no_record: 0 };
}

function addCounts(target, src) {
  for (const k of Object.keys(target)) target[k] += n(src[k]);
  return target;
}

function tradeLabel(v) {
  const s = String(v || '').trim();
  return s || 'Unspecified';
}

/** Active sites the report can cover, with shifts, supervisors and client. */
async function listReportableSites() {
  const [sites] = await pool.query(
    `SELECT s.site_id, s.site_name, s.location, s.supports_shifts,
            c.contract_name, p.project_name, p.client_name
     FROM sites s
     LEFT JOIN contracts c ON c.contract_id = s.contract_id
     LEFT JOIN projects p ON p.project_id = c.project_id
     WHERE s.site_status = 'Active'
     ORDER BY s.site_name`
  );
  return sites.map((s) => ({
    site_id: n(s.site_id),
    site_name: s.site_name,
    location: s.location || null,
    supports_shifts: Number(s.supports_shifts) === 1,
    shifts: Number(s.supports_shifts) === 1 ? ['Day', 'Night'] : ['Day'],
    contract_name: s.contract_name || null,
    project_name: s.project_name || null,
    client_name: s.client_name || null,
  }));
}

/**
 * Build the report data.
 * @param {object} p
 * @param {string} p.date         YYYY-MM-DD
 * @param {number[]} p.siteIds    Active site ids (already validated)
 * @param {'All'|'Day'|'Night'} p.shift
 * @param {boolean} p.includeStaff
 * @param {boolean} p.showAbsentNames
 */
async function buildReportData({ date, siteIds, shift, includeStaff, showAbsentNames }) {
  if (!siteIds.length) return { sites: [], totals: totalsOf([]) };
  const shiftList = shift === 'All' ? SHIFTS : [shift];
  const sitePh = siteIds.map(() => '?').join(',');
  const shiftPh = shiftList.map(() => '?').join(',');

  const sitesSql = `
    SELECT s.site_id, s.site_name, s.location, s.supports_shifts,
           c.contract_name, p.project_name, p.client_name,
           u.full_name AS site_supervisor
    FROM sites s
    LEFT JOIN contracts c ON c.contract_id = s.contract_id
    LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN users u ON u.user_id = s.supervisor_id AND u.status = 'Active'
    WHERE s.site_status = 'Active' AND s.site_id IN (${sitePh})
    ORDER BY s.site_name`;

  const shiftSupSql = `
    SELECT ss.site_id, ss.shift_type, u.full_name AS supervisor
    FROM site_shifts ss
    JOIN users u ON u.user_id = ss.supervisor_id AND u.status = 'Active'
    WHERE ss.site_id IN (${sitePh})`;

  // One row per worker assigned on D (+ his record dated D, if any).
  const workersSql = `
    SELECT wsa.site_id, wsa.shift_type, w.worker_id, w.worker_unique_id, w.full_name, w.job_position,
           DATE_FORMAT(wsa.assigned_date, '%Y-%m-%d') AS assigned_date,
           DATE_FORMAT(wsa.unassigned_date, '%Y-%m-%d') AS last_day,
           a.attendance_id, a.attendance_status, a.check_in_time, a.source
    FROM workersiteassignments wsa
    JOIN workers w ON w.worker_id = wsa.worker_id AND w.status = 'Active'
    LEFT JOIN attendance a
      ON a.worker_id = wsa.worker_id AND a.site_id = wsa.site_id
     AND a.shift_type = wsa.shift_type AND a.record_date = ?
    WHERE ${activeOn('wsa')}
      AND wsa.site_id IN (${sitePh})
      AND wsa.shift_type IN (${shiftPh})
    ORDER BY w.full_name, w.worker_id`;

  const staffSql = `
    SELECT ssa.site_id, sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position,
           DATE_FORMAT(ssa.assigned_date, '%Y-%m-%d') AS assigned_date,
           DATE_FORMAT(ssa.unassigned_date, '%Y-%m-%d') AS last_day,
           sa.staff_attendance_id AS attendance_id, sa.attendance_status, sa.check_in_time, sa.source
    FROM staff_site_assignments ssa
    JOIN staff_members sm ON sm.staff_id = ssa.staff_id
     AND (sm.status = 'Active' OR (sm.termination_date IS NOT NULL AND sm.termination_date >= ?))
    LEFT JOIN staff_attendance sa ON sa.staff_id = ssa.staff_id AND sa.record_date = ?
    WHERE ${activeOn('ssa')}
      AND ssa.site_id IN (${sitePh})
    ORDER BY sm.full_name, sm.staff_id`;

  const [[sites], [shiftSups], [workers], [staff]] = await Promise.all([
    pool.query(sitesSql, siteIds),
    pool.query(shiftSupSql, siteIds),
    pool.query(workersSql, [date, date, date, ...siteIds, ...shiftList]),
    includeStaff ? pool.query(staffSql, [date, date, date, date, ...siteIds]) : Promise.resolve([[]]),
  ]);

  const supMap = new Map(shiftSups.map((r) => [`${r.site_id}|${r.shift_type}`, r.supervisor]));

  const result = sites.map((s) => {
    const siteId = n(s.site_id);
    const supportsShifts = Number(s.supports_shifts) === 1;
    const siteShifts = shiftList.filter((sh) => supportsShifts || sh === 'Day');
    // A non-shift site that still has Night assignments: show it, do not hide data.
    if (!supportsShifts && shiftList.includes('Night')
        && workers.some((w) => n(w.site_id) === siteId && w.shift_type === 'Night')) {
      siteShifts.push('Night');
    }

    const shifts = siteShifts.map((sh) => {
      const rows = workers.filter((w) => n(w.site_id) === siteId && w.shift_type === sh);
      return {
        shift_type: sh,
        supervisor: supportsShifts ? (supMap.get(`${siteId}|${sh}`) || null) : (sh === 'Day' ? s.site_supervisor || null : null),
        ...summarisePeople(rows, date, showAbsentNames, (r) => r.worker_unique_id, (r) => r.job_position),
      };
    });
    // Hide an empty shift (no one assigned) unless it is the only one shown.
    const shownShifts = shifts.filter((x) => x.counts.assigned > 0);
    if (!shownShifts.length && shifts.length) shownShifts.push(shifts[0]);

    const staffRows = staff.filter((r) => n(r.site_id) === siteId);
    const staffBlock = includeStaff
      ? summarisePeople(staffRows, date, showAbsentNames, (r) => r.staff_unique_id, (r) => r.position)
      : null;

    const counts = emptyCounts();
    for (const sh of shownShifts) addCounts(counts, sh.counts);
    const staffCounts = staffBlock ? staffBlock.counts : emptyCounts();

    return {
      site_id: siteId,
      site_name: s.site_name,
      location: s.location || null,
      project_name: s.project_name || null,
      contract_name: s.contract_name || null,
      client_name: s.client_name || null,
      supports_shifts: supportsShifts,
      shifts: shownShifts,
      staff: staffBlock,
      workers_counts: counts,
      staff_counts: staffCounts,
    };
  });

  return { sites: result, totals: totalsOf(result) };
}

function summarisePeople(rows, date, showAbsentNames, codeOf, tradeOf) {
  const counts = emptyCounts();
  const present = [];
  const away = [];
  const trades = new Map();
  const joined = [];
  const leaving = [];

  for (const r of rows) {
    const st = stateOf(r);
    counts.assigned += 1;
    counts[st] += 1;
    const trade = tradeLabel(tradeOf(r));
    const t = trades.get(trade) || { trade, assigned: 0, on_site: 0 };
    t.assigned += 1;
    if (st === 'on_site') t.on_site += 1;
    trades.set(trade, t);

    const person = { code: codeOf(r) || '', name: r.full_name, trade };
    if (st === 'on_site') {
      present.push({ ...person, check_in: hhmm(r.check_in_time), source: r.source === 'Biometric' ? 'Biometric' : 'Manual' });
    } else if (showAbsentNames) {
      away.push({ ...person, status: st });
    }
    if (r.assigned_date === date) joined.push(person);
    if (r.last_day === date) leaving.push(person);
  }

  present.sort((a, b) => String(a.check_in || '99').localeCompare(String(b.check_in || '99')) || a.name.localeCompare(b.name));
  const awayOrder = { absent: 0, sick: 1, leave: 2, holiday: 3, no_record: 4 };
  away.sort((a, b) => awayOrder[a.status] - awayOrder[b.status] || a.name.localeCompare(b.name));

  return {
    counts,
    trades: [...trades.values()].sort((a, b) => b.assigned - a.assigned || a.trade.localeCompare(b.trade)),
    present,
    away,
    joined,
    leaving,
  };
}

function totalsOf(sites) {
  const workers = emptyCounts();
  const staff = emptyCounts();
  for (const s of sites) {
    addCounts(workers, s.workers_counts);
    addCounts(staff, s.staff_counts);
  }
  return {
    sites: sites.length,
    workers,
    staff,
    on_site_total: workers.on_site + staff.on_site,
    assigned_total: workers.assigned + staff.assigned,
  };
}

module.exports = { listReportableSites, buildReportData, _internal: { stateOf, summarisePeople, hhmm } };
