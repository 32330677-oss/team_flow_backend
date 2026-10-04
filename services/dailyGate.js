// services/dailyGate.js
//
// Daily submission gate (Supervisor manual attendance).
//
// Rule: a Supervisor cannot START recording a day (check-in, status, bulk
// check-in / status) or SUBMIT a day for a site + shift while an EARLIER day of
// the same site + shift is still open. A day is "open" (pending) when:
//
//   * it has Draft attendance records (recorded but never submitted), or
//   * it has NO attendance record at all although at least one worker was
//     assigned to that site/shift and Active on that date (the day was skipped).
//
// Not pending (never blocks):
//   * the weekly rest day (Friday by default = the day before
//     attendance_week_start_day) when nothing was entered on it. If records
//     WERE entered on the rest day, they must be submitted like any other day;
//     workers missing on a rest day never block;
//   * a day with no assigned + Active worker (nothing to record);
//   * a day that was submitted but one worker was added later by a back-dated
//     assignment: the Supervisor can still record and submit that worker alone,
//     the other records are not touched (see attendanceController.submitDay);
//   * Rejected records (they follow the Rejected Records / resubmit flow);
//   * days inside a finalized payroll period (they cannot be edited anyway);
//   * days before attendance_daily_gate_start_date (Admin setting) or older
//     than LOOKBACK_DAYS.
//
// Admin is never gated. Biometric (device) attendance is never gated.
// Finishing records that already exist (check-out, breaks, edit times) is
// never gated, so workers on site are never stranded.

const settingsCache = require('./settingsCache');
const { addDays, isValidDateOnly } = require('./businessDate');
const { getActiveWorkerIdsOnDate } = require('./workerStatusService');

const LOOKBACK_DAYS = 60;
const MAX_LISTED = 7;

function dayOfWeek(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

async function gateSettings(recordDate) {
  const enabled = String(await settingsCache.getSettingForDate('attendance_daily_gate_enabled', recordDate, 'true')) !== 'false';
  const start = String(await settingsCache.getSettingForDate('attendance_daily_gate_start_date', recordDate, '') || '');
  const weekStart = Number(await settingsCache.getSettingForDate('attendance_week_start_day', recordDate, '6'));
  const restDay = ((Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6 ? weekStart : 6) + 6) % 7;
  return { enabled, startDate: isValidDateOnly(start) ? start : null, restDay };
}

function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Earliest open days BEFORE recordDate for a site/shift (ascending, max MAX_LISTED).
 * Returns { enabled, from, to, days: [{ record_date, reason: 'draft'|'not_recorded', drafts, missing_workers }] }.
 */
async function pendingWorkerDays(executor, { siteId, shiftType, recordDate }) {
  const date = String(recordDate).slice(0, 10);
  const cfg = await gateSettings(date);
  let from = addDays(date, -LOOKBACK_DAYS);
  if (cfg.startDate && cfg.startDate > from) from = cfg.startDate;
  const to = addDays(date, -1);
  const result = { enabled: cfg.enabled, from, to, days: [] };
  if (!cfg.enabled || from > to) return result;

  const [draftRows] = await executor.execute(
    `SELECT DATE_FORMAT(record_date, '%Y-%m-%d') AS d, COUNT(*) AS n
     FROM attendance
     WHERE site_id = ? AND shift_type = ? AND status = 'Draft' AND record_date BETWEEN ? AND ?
     GROUP BY record_date`,
    [siteId, shiftType, from, to]
  );
  const drafts = new Map(draftRows.map((r) => [r.d, Number(r.n)]));

  const [recordedRows] = await executor.execute(
    `SELECT DISTINCT DATE_FORMAT(record_date, '%Y-%m-%d') AS d
     FROM attendance
     WHERE site_id = ? AND shift_type = ? AND record_date BETWEEN ? AND ?`,
    [siteId, shiftType, from, to]
  );
  const recorded = new Set(recordedRows.map((r) => r.d));

  // Night shift carried over: a record of X-1 whose OUT is on X covers X for
  // that worker (same predicate as submitDay's "missing attendance" check).
  const [carryRows] = await executor.execute(
    `SELECT worker_id, DATE_FORMAT(DATE_ADD(record_date, INTERVAL 1 DAY), '%Y-%m-%d') AS d
     FROM attendance
     WHERE site_id = ? AND shift_type = ? AND record_date BETWEEN DATE_SUB(?, INTERVAL 1 DAY) AND ?
       AND check_out_time IS NOT NULL AND DATE(check_out_time) > record_date`,
    [siteId, shiftType, from, to]
  );
  const carried = new Map();
  for (const r of carryRows) {
    if (!carried.has(r.d)) carried.set(r.d, new Set());
    carried.get(r.d).add(Number(r.worker_id));
  }

  const [assignments] = await executor.execute(
    `SELECT worker_id, DATE_FORMAT(assigned_date, '%Y-%m-%d') AS a, DATE_FORMAT(unassigned_date, '%Y-%m-%d') AS u
     FROM workersiteassignments
     WHERE site_id = ? AND shift_type = ?
       AND assigned_date <= ? AND (unassigned_date IS NULL OR unassigned_date >= ?)
       AND (unassigned_date IS NULL OR unassigned_date >= assigned_date)`,
    [siteId, shiftType, to, from]
  );

  const [locks] = await executor.execute(
    `SELECT DATE_FORMAT(start_date, '%Y-%m-%d') AS s, DATE_FORMAT(end_date, '%Y-%m-%d') AS e
     FROM payrollbatches
     WHERE status IN ('Generated', 'Paid') AND is_finalized = 1
       AND start_date <= ? AND end_date >= ?
       AND (scope_site_id IS NULL OR scope_site_id = ?)`,
    [to, from, siteId]
  );
  const isLocked = (d) => locks.some((l) => l.s <= d && l.e >= d);

  for (const d of eachDay(from, to)) {
    if (result.days.length >= MAX_LISTED) break;
    if (isLocked(d)) continue;
    const draftCount = drafts.get(d) || 0;
    if (draftCount > 0) {
      result.days.push({ record_date: d, reason: 'draft', drafts: draftCount, missing_workers: 0 });
      continue;
    }
    if (recorded.has(d)) continue;                 // submitted (or rejected / approved) day
    if (dayOfWeek(d) === cfg.restDay) continue;    // empty rest day: never blocks
    const covered = carried.get(d) || new Set();
    const candidates = [...new Set(assignments
      .filter((x) => x.a <= d && (x.u === null || x.u >= d))
      .map((x) => Number(x.worker_id))
      .filter((id) => !covered.has(id)))];
    if (candidates.length === 0) continue;
    const active = await getActiveWorkerIdsOnDate(candidates, d, executor);
    if (active.size === 0) continue;
    result.days.push({ record_date: d, reason: 'not_recorded', drafts: 0, missing_workers: active.size });
  }
  return result;
}

function gateError(gate) {
  const first = gate.days[0];
  const list = gate.days.map((d) => d.record_date).join(', ');
  const error = new Error(
    `An earlier day is not finished for this site/shift: ${list}. ` +
    `Open ${first.record_date}, record every worker (or mark Holiday) and submit it first. ` +
    'Days must be submitted in order (an empty Friday is skipped).'
  );
  error.isOperational = true;
  error.statusCode = 409;
  error.code = 'PREVIOUS_DAY_UNSUBMITTED';
  error.extra = { pending_days: gate.days };
  return error;
}

/** Throws PREVIOUS_DAY_UNSUBMITTED for a Supervisor when an earlier day is open. */
async function assertPreviousDaysDone(executor, req, { siteId, shiftType, recordDate }) {
  if (!req.user || req.user.role !== 'Supervisor') return;
  const gate = await pendingWorkerDays(executor, { siteId, shiftType, recordDate });
  if (gate.days.length > 0) throw gateError(gate);
}

module.exports = { pendingWorkerDays, assertPreviousDaysDone, gateError, LOOKBACK_DAYS };
