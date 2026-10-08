const pool = require('../config/db');
const settingsCache = require('../services/settingsCache');
const { activeOn } = require('../services/assignmentDates');
const { businessToday } = require('../services/businessDate');

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}
function isSpecificSite(value) {
  return value !== undefined && value !== null && !['', 'null', '0', 'All'].includes(String(value));
}
function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
function addDaysIso(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DEFAULT_STANDARD_MINUTES = 600; // fallback: 10 hours, matches system default

// ============================================================
// UNIFIED OVERTIME POLICY
// Overtime is paid at a single company-wide rate for EVERY worker,
// regardless of pay type (Daily or Hourly) and regardless of that worker's
// own overtime_hourly_rate in workercompensationhistory. That per-worker
// rate is still kept for historical/reporting reasons only.
//
// D-14: the rate is DB-backed and effective-dated (system_settings /
// system_settings_history key overtime_flat_rate_syp, edited by an Admin in
// Attendance Settings). There is NO hard-coded fallback any more: generating
// payroll with overtime for a date that has no configured rate is refused.
// The rate used is snapshotted in payrollitems.overtime_hourly_rate_snapshot,
// so finalized/paid payroll never changes when the setting changes.
//
// Attendance already computes overtime_hours correctly for both pay types
// (see services/attendanceService.js -> calculateWorkingHours): if a Lunch
// leave record was NOT created for a shift (worker worked through lunch),
// that hour is never subtracted from total_working_hours, so it naturally
// pushes the worker past standard_minutes_snapshot and becomes overtime.
// That logic is unchanged and correct — the gap was purely in how payroll
// generation used to IGNORE overtime_hours entirely for Daily workers.
// ============================================================
const PAYROLL_LOCKING_STATUSES = "('Generated','Paid')"; // statuses that count as an active batch

// ============================================================
// generatePayrollBatch
//
// Versioning behavior:
// - "Period identity" = (start_date, end_date, scope_site_id) where
//   scope_site_id is the site_id passed by the admin, or NULL for "all sites".
// - If an active (non-Superseded) batch already exists for that exact
//   period identity:
//     - if it is_finalized  -> reject (period is locked, needs no override
//       here; a finalized period can only be corrected by an explicit
//       management action outside normal generation).
//     - otherwise           -> it gets marked 'Superseded' and the new
//       batch is inserted as version_number + 1, linked via
//       supersedes_batch_id.
// - A brand-new period gets version_number = 1.
//
// Off-cycle payroll (urgent payroll of ONE worker, batch_type = 'OffCycle'):
// - Period identity = (start_date, end_date, batch_type, scope_worker_id), so
//   a Regular batch never supersedes an off-cycle batch and vice versa.
// - The off-cycle batch pays only that worker's Approved attendance in the
//   period (all of it must be Approved: no "generate without them").
// - A Regular batch skips every record of a worker whose own off-cycle batch
//   covers that date, and refuses to run while such an off-cycle batch is
//   not finalized yet (otherwise voiding it later would leave days unpaid).
// - The amount is computed by exactly the same code below; only the set of
//   attendance rows differs.
// ============================================================
const PAYROLL_GENERATE_LOCK = 'team_flow_worker_payroll_generate';

async function generatePayrollBatch(req, res) {
  const { start_date, end_date, site_id } = req.body || {};
  const userId = req.user?.user_id;
  // D-03: set only by supersedeFinalizedBatch (atomic replacement of a
  // Finalized, unpaid batch). Never accepted from the request body.
  const supersede = req._supersede || null;
  // Off-cycle: set only by generateOffCycleBatch / supersedeFinalizedBatch,
  // never accepted from the body of POST /generate.
  const offcycle = req._offcycle || null;
  const batchType = offcycle ? 'OffCycle' : 'Regular';
  const scopeWorkerId = offcycle ? Number(offcycle.workerId) : null;
  const dryRun = Boolean(offcycle && offcycle.dryRun);
  // An off-cycle batch must include every record of the worker in its period.
  const acknowledgePending = !offcycle && req.body?.acknowledge_pending === true;

  if (!userId) return res.status(401).json({ success: false, message: 'Admin identification not found.' });
  if (!isValidDate(start_date) || !isValidDate(end_date)) {
    return res.status(400).json({ success: false, message: 'Dates must use YYYY-MM-DD.' });
  }
  if (end_date < start_date) {
    return res.status(400).json({ success: false, message: 'End date must be after or equal to start date.' });
  }
  if (offcycle && end_date > businessToday()) {
    return res.status(400).json({
      success: false,
      code: 'OFFCYCLE_FUTURE_DATE',
      message: `An off-cycle payroll cannot end in the future (today is ${businessToday()}). Days after today could not be recorded for this worker any more.`,
    });
  }

  const connection = await pool.getConnection();
  let haveGenerateLock = false;
  try {
    // One worker-payroll generation at a time (Regular, off-cycle, supersede):
    // the overlap / coverage checks below and the INSERT must not interleave.
    const [[lockRow]] = await connection.query('SELECT GET_LOCK(?, 15) AS ok', [PAYROLL_GENERATE_LOCK]);
    haveGenerateLock = Number(lockRow && lockRow.ok) === 1;
    if (!haveGenerateLock) {
      return res.status(409).json({ success: false, code: 'PAYROLL_GENERATION_BUSY', message: 'Another payroll is being generated right now. Try again in a few seconds.' });
    }
    await connection.beginTransaction();
    const scopedSite = !offcycle && isSpecificSite(site_id);
    const scopeSiteId = scopedSite ? Number(site_id) : null;

    if (!offcycle) {
      const [overlapping] = await connection.execute(
        `SELECT payroll_batch_id, start_date, end_date, scope_site_id
         FROM payrollbatches
         WHERE batch_type = 'Regular'
           AND status IN ${PAYROLL_LOCKING_STATUSES}
           AND start_date <= ? AND end_date >= ?
           AND NOT (start_date = ? AND end_date = ? AND scope_site_id <=> ?)
           AND (scope_site_id <=> ? OR scope_site_id IS NULL OR ? IS NULL)
         LIMIT 1
         FOR UPDATE`,
        [end_date, start_date, start_date, end_date, scopeSiteId, scopeSiteId, scopeSiteId]
      );
      if (overlapping.length) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message: `This period overlaps existing payroll batch #${overlapping[0].payroll_batch_id}. Adjust the dates or supersede/finalize the existing batch first.`
        });
      }

      // Off-cycle batches inside this period must be finalized first: the
      // Regular batch skips their records, so they must not be voided later.
      const [openOffCycle] = await connection.execute(
        `SELECT ob.payroll_batch_id, ob.scope_worker_id AS worker_id, w.full_name AS worker_name,
                DATE_FORMAT(ob.start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(ob.end_date, '%Y-%m-%d') AS end_date
         FROM payrollbatches ob
         JOIN workers w ON w.worker_id = ob.scope_worker_id
         WHERE ob.batch_type = 'OffCycle' AND ob.status = 'Generated' AND ob.is_finalized = 0
           AND ob.start_date <= ? AND ob.end_date >= ?
           AND (? IS NULL OR EXISTS (
                 SELECT 1 FROM attendance ax
                 WHERE ax.worker_id = ob.scope_worker_id AND ax.site_id = ?
                   AND ax.record_date BETWEEN GREATEST(ob.start_date, ?) AND LEAST(ob.end_date, ?)))
         ORDER BY ob.payroll_batch_id
         FOR UPDATE`,
        [end_date, start_date, scopeSiteId, scopeSiteId, start_date, end_date]
      );
      if (openOffCycle.length) {
        await connection.rollback();
        const list = openOffCycle.map((b) => `#${b.payroll_batch_id} (${b.worker_name}, ${b.start_date} to ${b.end_date})`).join(', ');
        return res.status(409).json({
          success: false,
          code: 'OFFCYCLE_NOT_FINALIZED',
          message: `Off-cycle payroll ${list} inside this period is not finalized yet. Finalize it (or void it) first, then generate this period.`,
          offcycle_batches: openOffCycle,
        });
      }
    } else {
      // Another active off-cycle batch of this worker overlapping the period
      // (the exact same period is regenerated / superseded below instead).
      const [otherOff] = await connection.execute(
        `SELECT payroll_batch_id, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
         FROM payrollbatches
         WHERE batch_type = 'OffCycle' AND scope_worker_id = ?
           AND status IN ${PAYROLL_LOCKING_STATUSES}
           AND start_date <= ? AND end_date >= ?
           AND NOT (start_date = ? AND end_date = ?)
         LIMIT 1
         FOR UPDATE`,
        [scopeWorkerId, end_date, start_date, start_date, end_date]
      );
      if (otherOff.length) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          code: 'OFFCYCLE_OVERLAP',
          message: `This worker already has off-cycle payroll batch #${otherOff[0].payroll_batch_id} (${otherOff[0].start_date} to ${otherOff[0].end_date}) overlapping this period. Choose dates outside it.`,
        });
      }
      // A Regular batch that already covers this worker in the period.
      const [regular] = await connection.execute(
        `SELECT rb.payroll_batch_id, rb.status, rb.is_finalized,
                DATE_FORMAT(rb.start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(rb.end_date, '%Y-%m-%d') AS end_date
         FROM payrollbatches rb
         WHERE rb.batch_type = 'Regular'
           AND rb.status IN ${PAYROLL_LOCKING_STATUSES}
           AND rb.start_date <= ? AND rb.end_date >= ?
           AND (rb.scope_site_id IS NULL OR EXISTS (
                 SELECT 1 FROM attendance ax
                 WHERE ax.worker_id = ? AND ax.site_id = rb.scope_site_id
                   AND ax.record_date BETWEEN GREATEST(rb.start_date, ?) AND LEAST(rb.end_date, ?)))
         ORDER BY rb.end_date DESC
         LIMIT 1
         FOR UPDATE`,
        [end_date, start_date, scopeWorkerId, start_date, end_date]
      );
      if (regular.length) {
        await connection.rollback();
        const r = regular[0];
        return res.status(409).json({
          success: false,
          code: 'OFFCYCLE_COVERED_BY_REGULAR',
          message: `Payroll batch #${r.payroll_batch_id} (${r.start_date} to ${r.end_date}) already covers this worker in this period. ` +
            (supersede
              ? 'This off-cycle batch can no longer be superseded; record any difference through the attendance correction / adjustment workflow.'
              : `Start the off-cycle period after ${r.end_date}, or ${r.is_finalized ? 'pay the worker from that batch' : 'void that batch first'}.`),
        });
      }
    }

    // --- find any active batch(es) for this exact period + scope ---
    const [existingBatches] = await connection.execute(
      `SELECT payroll_batch_id, version_number, is_finalized, status
       FROM payrollbatches
       WHERE start_date = ? AND end_date = ?
         AND status IN ${PAYROLL_LOCKING_STATUSES}
         AND scope_site_id <=> ?
         AND batch_type = ? AND scope_worker_id <=> ?
       ORDER BY version_number DESC
       FOR UPDATE`,
      [start_date, end_date, scopeSiteId, batchType, scopeWorkerId]
    );
    // Version numbers continue across Voided/Superseded batches of the period.
    const [[maxVersionRow]] = await connection.execute(
      `SELECT MAX(version_number) AS max_version FROM payrollbatches
       WHERE start_date = ? AND end_date = ? AND scope_site_id <=> ?
         AND batch_type = ? AND scope_worker_id <=> ?`,
      [start_date, end_date, scopeSiteId, batchType, scopeWorkerId]
    );

    if (existingBatches.length) {
      const paid = existingBatches.find((b) => b.status === 'Paid');
      if (paid) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message: `This period is already Paid (Batch #${paid.payroll_batch_id}). A paid batch cannot be regenerated or superseded; record differences through the correction/adjustment workflow.`
        });
      }
      const finalizedBlocking = existingBatches.find((b) => b.is_finalized && (!supersede || b.payroll_batch_id !== supersede.batchId));
      if (finalizedBlocking) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          code: 'BATCH_FINALIZED',
          message: `This period is finalized (Batch #${finalizedBlocking.payroll_batch_id}). Use "Supersede (correct) finalized batch" with a reason to replace it.`
        });
      }
    }
    if (supersede && !existingBatches.some((b) => b.payroll_batch_id === supersede.batchId)) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'The batch to supersede is no longer the active batch of this period.' });
    }

    // Records of a worker on a date already paid by his own off-cycle batch
    // belong to that batch, never to a Regular batch.
    const NOT_PAID_OFFCYCLE = `NOT EXISTS (
        SELECT 1 FROM payrollbatches ob
        WHERE ob.batch_type = 'OffCycle' AND ob.status IN ${PAYROLL_LOCKING_STATUSES}
          AND ob.scope_worker_id = a.worker_id
          AND a.record_date BETWEEN ob.start_date AND ob.end_date)`;

    // C-03: unresolved attendance (Draft / Submitted / Rejected) in the period
    // is reported before generating, exactly like staff payroll.
    {
      const pendParams = [start_date, end_date];
      let pendSql = `SELECT a.attendance_id, a.worker_id, w.full_name, a.site_id, s.site_name, a.shift_type,
                            DATE_FORMAT(a.record_date, '%Y-%m-%d') AS record_date, a.status
                     FROM attendance a JOIN workers w ON w.worker_id = a.worker_id JOIN sites s ON s.site_id = a.site_id
                     WHERE a.record_date BETWEEN ? AND ? AND a.status IN ('Draft','Submitted','Rejected')`;
      if (scopedSite) { pendSql += ' AND a.site_id = ?'; pendParams.push(site_id); }
      if (offcycle) { pendSql += ' AND a.worker_id = ?'; pendParams.push(scopeWorkerId); }
      else pendSql += ` AND ${NOT_PAID_OFFCYCLE}`;
      pendSql += ' ORDER BY a.record_date, w.full_name LIMIT 500';
      const [pendingRows] = await connection.execute(pendSql, pendParams);
      if (pendingRows.length > 0 && offcycle) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          code: 'OFFCYCLE_PENDING_ATTENDANCE',
          message: `${pendingRows.length} attendance record(s) of this worker in this period are not approved yet (Draft/Submitted/Rejected). ` +
            'An off-cycle payroll must include all of them: approve them first, or end the period before the first of these dates.',
          pending_attendance: pendingRows,
        });
      }
      if (pendingRows.length > 0 && !acknowledgePending) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          code: 'PENDING_ATTENDANCE',
          message: `${pendingRows.length} attendance record(s) in this period are not approved (Draft/Submitted/Rejected). ` +
            'They will NOT be paid in this batch. Approve them first, or confirm to generate without them.',
          pending_attendance: pendingRows,
        });
      }
    }

    const attParams = [start_date, end_date];
let attSql = `
  SELECT a.attendance_id, a.worker_id, w.full_name AS worker_name, w.payment_type,
         a.record_date, a.site_id, a.shift_type, a.total_working_hours, a.overtime_hours,
         a.attendance_status, a.standard_minutes_snapshot,
         w.standard_daily_minutes AS worker_custom_minutes,
         (
           SELECT wsa2.contract_id
           FROM workersiteassignments wsa2
           WHERE wsa2.worker_id = a.worker_id
             AND wsa2.site_id = a.site_id
             AND wsa2.shift_type = a.shift_type
             AND ${activeOn('wsa2', 'a.record_date')}
           ORDER BY wsa2.assigned_date DESC, wsa2.assignment_id DESC
           LIMIT 1
         ) AS contract_id
  FROM attendance a
  JOIN workers w ON w.worker_id = a.worker_id
  WHERE a.record_date BETWEEN ? AND ?
    AND a.status = 'Approved'`;

    if (scopedSite) { attSql += ' AND a.site_id = ?'; attParams.push(site_id); }
    if (offcycle) { attSql += ' AND a.worker_id = ?'; attParams.push(scopeWorkerId); }
    else attSql += ` AND ${NOT_PAID_OFFCYCLE}`;
    attSql += ' ORDER BY w.full_name, a.record_date';

    const [attendanceRows] = await connection.execute(attSql, attParams);

    if (!attendanceRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: offcycle
          ? 'This worker has no Approved attendance in this period.'
          : 'No Approved attendance found for this period.',
      });
    }

    const missingAssignment = attendanceRows.filter((r) => r.contract_id === null || r.contract_id === undefined);
    if (missingAssignment.length) {
      await connection.rollback();
      const sample = missingAssignment.slice(0, 5).map(
        (r) => `worker_id=${r.worker_id} site_id=${r.site_id} date=${r.record_date}`
      ).join('; ');
      return res.status(422).json({
        success: false,
        message: `Found ${missingAssignment.length} approved attendance record(s) with no matching site assignment. ` +
          `Payroll cannot be generated until this is fixed (e.g. missing/backdated workersiteassignments row). Examples: ${sample}`
      });
    }

    const workerIds = [...new Set(attendanceRows.map(r => r.worker_id))];
    const [compRows] = await connection.query(
      `SELECT worker_id, payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate,
              effective_from, effective_to
       FROM workercompensationhistory
       WHERE worker_id IN (?)
       ORDER BY worker_id, effective_from`,
      [workerIds]
    );
    const compByWorker = new Map();
    for (const row of compRows) {
      if (!compByWorker.has(row.worker_id)) compByWorker.set(row.worker_id, []);
      compByWorker.get(row.worker_id).push(row);
    }

    function findRateForDate(workerId, dateStr) {
      const periods = compByWorker.get(workerId) || [];
      return periods.find(p =>
        p.effective_from <= dateStr && (p.effective_to === null || p.effective_to >= dateStr)
      ) || null;
    }

    // D3 / #13: the fallback standard minutes and the overtime flat rate are the
    // values that applied on each record's own date (system_settings_history),
    // falling back to the current value / constant when no dated value exists.
    const fallbackStandardMinutesFor = async (dateStr) =>
      Number(await settingsCache.getSettingForDate('standard_work_minutes', dateStr, String(DEFAULT_STANDARD_MINUTES))) ||
      DEFAULT_STANDARD_MINUTES;
    // D-14: no hard-coded fallback. null = not configured for that date.
    const overtimeRateFor = async (dateStr) => {
      const raw = await settingsCache.getSettingForDate('overtime_flat_rate_syp', dateStr, null);
      const v = Number(raw);
      return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(v) && v > 0 ? v : null;
    };
    const missingOtRate = [];

    const groups = new Map();
    const byWorker = new Map();

    for (const rec of attendanceRows) {
      const comp = findRateForDate(rec.worker_id, String(rec.record_date));
      if (!comp) {
        await connection.rollback();
        return res.status(422).json({
          success: false,
          message: `No compensation record found for worker_id=${rec.worker_id} on ${rec.record_date}. Cannot generate payroll.`
        });
      }

      // Grouping key intentionally excludes overtime_hourly_rate: overtime is
      // always paid at the flat company rate regardless of that field. The flat
      // rate itself is dated (D3), so it is part of the key.
      const recordDateStr = String(rec.record_date).slice(0, 10);
      const otRate = await overtimeRateFor(recordDateStr);
      const groupKey = comp.payment_type === 'Daily'
        ? `${rec.worker_id}|${rec.site_id}|Daily|${comp.daily_rate}|OT${otRate}`
        : `${rec.worker_id}|${rec.site_id}|Hourly|${comp.regular_hourly_rate}|OT${otRate}`;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          worker_id: rec.worker_id,
          site_id: rec.site_id,
          contract_id: rec.contract_id,
          pay_type: comp.payment_type,
          daily_rate: comp.daily_rate,
          regular_hourly_rate: comp.regular_hourly_rate,
          overtime_rate: otRate,
          days_worked: 0,     // PAID day-equivalents (fractional, e.g. 0.5)
          regular_hours: 0,
          overtime_hours: 0,  // now tracked for BOTH pay types
          attendance: [],     // C-07: rows snapshotted with the batch
        });
      }
      const g = groups.get(groupKey);
      if (Number(rec.overtime_hours || 0) > 0 && otRate === null) {
        missingOtRate.push(recordDateStr);
      }
      let snapshotFraction = null;

      if (comp.payment_type === 'Daily') {
        let dayFraction;
        const workedHours = Number(rec.total_working_hours || 0);
        const nonWorkingStatus = ['Absent', 'Sick', 'Vacation', 'Holiday'].includes(rec.attendance_status);
        const hasManagementHours = workedHours > 0 && nonWorkingStatus;
        if (nonWorkingStatus && !hasManagementHours) {
          dayFraction = 0;
        } else {
          // D3 (final decision): explicit settings history -> the record's
          // snapshot -> legacy/current value. The global setting history only
          // applies to workers without their own standard_daily_minutes; for
          // those, the snapshot is the only historical record of their value.
          const hasCustomMinutes = Number(rec.worker_custom_minutes) > 0;
          const explicitMinutes = hasCustomMinutes ? null
            : Number(await settingsCache.getExplicitSettingForDate('standard_work_minutes', recordDateStr));
          const standardMinutes = explicitMinutes > 0
            ? explicitMinutes
            : Number(rec.standard_minutes_snapshot) > 0
              ? Number(rec.standard_minutes_snapshot)
              : await fallbackStandardMinutesFor(recordDateStr);

          const standardHours = standardMinutes / 60;

          dayFraction = standardHours > 0
            ? Math.min(1, workedHours / standardHours)
            : 0;
        }

        g.days_worked += dayFraction;
        snapshotFraction = dayFraction;
        // Daily workers ARE eligible for overtime now: attendance already
        // computes overtime_hours whenever worked hours exceed the standard
        // (e.g. worked through lunch -> 11h shift with a 10h standard -> 1h OT).
        g.overtime_hours += Number(rec.overtime_hours || 0);
      } else {
        g.regular_hours += Number(rec.total_working_hours || 0);
        g.overtime_hours += Number(rec.overtime_hours || 0);
      }
      g.attendance.push({
        attendance_id: rec.attendance_id, worker_id: rec.worker_id, site_id: rec.site_id, shift_type: rec.shift_type,
        record_date: recordDateStr, attendance_status: rec.attendance_status,
        regular_hours: Number(rec.total_working_hours || 0), overtime_hours: Number(rec.overtime_hours || 0),
        day_fraction: snapshotFraction,
      });

      if (!byWorker.has(rec.worker_id)) {
        byWorker.set(rec.worker_id, { worker_id: rec.worker_id, breakdown: [], gross: 0 });
      }
    }

    if (missingOtRate.length) {
      await connection.rollback();
      const dates = [...new Set(missingOtRate)].sort();
      return res.status(422).json({
        success: false,
        code: 'OVERTIME_RATE_NOT_CONFIGURED',
        message: `No overtime rate is configured for ${dates.slice(0, 5).join(', ')}${dates.length > 5 ? ' ...' : ''}. ` +
          'Set the worker overtime rate (Attendance Settings) with an effective date covering these dates, then generate again.',
        dates,
      });
    }

    for (const g of groups.values()) {
      let baseSalary = 0;

      if (g.pay_type === 'Daily') {
        if (!Number.isFinite(Number(g.daily_rate)) || Number(g.daily_rate) <= 0) {
          throw new Error(`Invalid daily_rate for worker ${g.worker_id}`);
        }
        baseSalary = money(g.days_worked * Number(g.daily_rate));
      } else {
        const regularRate = Number(g.regular_hourly_rate);
        if (!Number.isFinite(regularRate) || regularRate <= 0) {
          throw new Error(`Invalid regular hourly rate for worker ${g.worker_id}`);
        }
        baseSalary = money(g.regular_hours * regularRate);
      }

      // Unified flat-rate overtime for everyone, Daily or Hourly.
      const overtimePay = g.overtime_hours > 0 ? money(g.overtime_hours * g.overtime_rate) : 0;

      if (baseSalary === 0 && overtimePay === 0) continue;

      const worker = byWorker.get(g.worker_id);
      worker.breakdown.push({
        siteId: g.site_id,
        contractId: g.contract_id,
        payType: g.pay_type,
        dailyRate: g.daily_rate,
        hourlyRate: g.regular_hourly_rate,
        daysWorked: Number(g.days_worked.toFixed(2)),
        regularHours: g.regular_hours,
        overtimeHours: g.overtime_hours,
        overtimeRate: g.overtime_rate,
        baseSalary,
        overtimePay,
        attendance: g.attendance,
      });
      worker.gross = money(worker.gross + baseSalary + overtimePay);
    }

    for (const [workerId, worker] of [...byWorker.entries()]) {
      if (worker.breakdown.length === 0) byWorker.delete(workerId);
    }
    if (!byWorker.size) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: offcycle
          ? 'This worker has nothing payable in this period (all approved days are unpaid leave / absence).'
          : 'No payable attendance found for this period.',
      });
    }

    // Off-cycle preview: everything above ran exactly as for a real batch;
    // nothing is written. The Admin sees the amount before confirming.
    if (dryRun) {
      const worker = byWorker.get(scopeWorkerId);
      const siteIds = [...new Set(worker.breakdown.map((b) => b.siteId))];
      const [siteRows] = await connection.query('SELECT site_id, site_name FROM sites WHERE site_id IN (?)', [siteIds]);
      const siteName = new Map(siteRows.map((r) => [r.site_id, r.site_name]));
      const [[wRow]] = await connection.execute(
        'SELECT worker_id, full_name, worker_unique_id, status FROM workers WHERE worker_id = ?', [scopeWorkerId]);
      const [allDays] = await connection.execute(
        `SELECT DISTINCT DATE_FORMAT(record_date, '%Y-%m-%d') AS d FROM attendance
         WHERE worker_id = ? AND record_date BETWEEN ? AND ?`, [scopeWorkerId, start_date, end_date]);
      const anyRecord = new Set(allDays.map((r) => r.d));
      const daysWithoutRecord = [];
      for (let d = start_date; d <= end_date; d = addDaysIso(d, 1)) if (!anyRecord.has(d)) daysWithoutRecord.push(d);
      await connection.rollback();
      return res.status(200).json({
        success: true,
        dry_run: true,
        currency: String(await settingsCache.getSetting('worker_payroll_currency', 'SYP') || 'SYP').toUpperCase(),
        worker: wRow,
        start_date,
        end_date,
        approved_records: attendanceRows.length,
        net_salary: worker.gross,
        lines: worker.breakdown.map((b) => ({
          site_id: b.siteId,
          site_name: siteName.get(b.siteId) || `Site #${b.siteId}`,
          pay_type: b.payType,
          daily_rate: b.dailyRate,
          hourly_rate: b.hourlyRate,
          days_worked: b.daysWorked,
          regular_hours: money(b.regularHours),
          overtime_hours: money(b.overtimeHours),
          overtime_rate: b.overtimeHours > 0 ? b.overtimeRate : null,
          base_salary: b.baseSalary,
          overtime_pay: b.overtimePay,
          from: b.attendance.reduce((m, a) => (a.record_date < m ? a.record_date : m), b.attendance[0].record_date),
          to: b.attendance.reduce((m, a) => (a.record_date > m ? a.record_date : m), b.attendance[0].record_date),
        })),
        days_without_record: daysWithoutRecord,
      });
    }

    // --- everything validated and computed: now supersede the old batch(es)
    //     for this exact period+scope and insert the new version ---
    // D-03 / D-10: Validate (done above) -> Generate replacement -> verify ->
    // supersede the old batch -> commit. Everything is ONE transaction: if any
    // step fails, the old batch stays exactly as it was.
    let supersedesId = null;
    const nextVersion = Number(maxVersionRow?.max_version || 0) + 1;
    if (existingBatches.length) supersedesId = existingBatches[0].payroll_batch_id; // ORDER BY version_number DESC
    const currency = String(await settingsCache.getSetting('worker_payroll_currency', 'SYP') || 'SYP').toUpperCase();

    const [batchResult] = await connection.execute(
      `INSERT INTO payrollbatches
         (start_date, end_date, generated_by_user_id, status, scope_site_id, version_number, supersedes_batch_id,
          currency, supersede_reason, batch_type, scope_worker_id, offcycle_reason)
       VALUES (?, ?, ?, 'Generated', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [start_date, end_date, userId, scopeSiteId, nextVersion, supersedesId, currency, supersede ? supersede.reason : null,
        batchType, scopeWorkerId, offcycle ? String(offcycle.reason || '').slice(0, 500) : null]
    );
    const batchId = batchResult.insertId;
    let totalWorkers = 0;
    let totalAmount = 0;

    for (const worker of byWorker.values()) {
      const [payrollResult] = await connection.execute(
        `INSERT INTO payroll
          (payroll_batch_id, worker_id, start_date, end_date,
           bonus_amount, penalty_amount, deductions_amount,
           gross_salary, net_salary, status, generated_by_user_id)
         VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, 'Generated', ?)`,
        [batchId, worker.worker_id, start_date, end_date, worker.gross, worker.gross, userId]
      );
      const payrollId = payrollResult.insertId;

      for (const item of worker.breakdown) {
        const isDaily = item.payType === 'Daily';
        const [itemResult] = await connection.execute(
          `INSERT INTO payrollitems
            (payroll_id, contract_id, site_id, pay_type, hourly_rate_snapshot,
             overtime_hourly_rate_snapshot, daily_rate_snapshot, days_worked,
             regular_hours_worked, overtime_hours_worked, base_salary, overtime_pay)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payrollId,
            item.contractId,
            item.siteId,
            item.payType,
            !isDaily ? item.hourlyRate : null,
            item.overtimeHours > 0 ? item.overtimeRate : null,
            isDaily ? item.dailyRate : null,
            isDaily ? item.daysWorked : null,
            !isDaily ? item.regularHours : null,
            item.overtimeHours, // now stored for Daily rows too
            item.baseSalary,
            item.overtimePay
          ]
        );
        // C-07: exact attendance rows / hours used by this item.
        for (const att of item.attendance) {
          await connection.execute(
            `INSERT INTO payroll_attendance_snapshot
               (payroll_batch_id, payroll_item_id, attendance_id, worker_id, site_id, shift_type, record_date,
                attendance_status, regular_hours, overtime_hours, day_fraction)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [batchId, itemResult.insertId, att.attendance_id, att.worker_id, att.site_id, att.shift_type, att.record_date,
              att.attendance_status, att.regular_hours.toFixed(2), att.overtime_hours.toFixed(2),
              att.day_fraction === null ? null : Number(att.day_fraction).toFixed(4)]
          );
        }
      }
      totalWorkers += 1;
      totalAmount = money(totalAmount + worker.gross);
    }

    await connection.execute(
      `UPDATE payrollbatches SET total_workers = ?, total_amount = ? WHERE payroll_batch_id = ?`,
      [totalWorkers, totalAmount, batchId]
    );

    // Verify the replacement before superseding anything.
    const [[verify]] = await connection.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(net_salary), 0) AS total FROM payroll WHERE payroll_batch_id = ?`, [batchId]);
    if (Number(verify.cnt) !== totalWorkers || Math.abs(Number(verify.total) - totalAmount) > 0.01) {
      throw new Error('Replacement batch verification failed; nothing was changed.');
    }
    for (const old of existingBatches) {
      await connection.execute(
        `UPDATE payrollbatches SET status = 'Superseded' WHERE payroll_batch_id = ? AND status IN ${PAYROLL_LOCKING_STATUSES}`,
        [old.payroll_batch_id]
      );
      await connection.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('payrollbatches', ?, 'SUPERSEDED', ?, ?, ?)`,
        [old.payroll_batch_id, userId, JSON.stringify({ status: old.status, is_finalized: old.is_finalized }),
          JSON.stringify({ status: 'Superseded', replaced_by_batch_id: batchId, reason: supersede ? supersede.reason : 'Regenerated (not finalized)' })]
      );
    }
    await connection.commit();

    return res.status(201).json({
      success: true,
      message: supersedesId
        ? `Payroll generated successfully (version ${nextVersion}). Previous version (Batch #${supersedesId}) has been superseded.`
        : (offcycle ? 'Off-cycle payroll generated successfully.' : 'Payroll generated successfully.'),
      currency,
      batch_id: batchId,
      batch_type: batchType,
      scope_worker_id: scopeWorkerId,
      total_amount: totalAmount,
      version_number: nextVersion,
      supersedes_batch_id: supersedesId
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* nothing to roll back */ }
    console.error('generatePayrollBatch:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate payroll. No batch was changed.' });
  } finally {
    if (haveGenerateLock) {
      try { await connection.query('SELECT RELEASE_LOCK(?)', [PAYROLL_GENERATE_LOCK]); } catch (_) { /* released with the session */ }
    }
    connection.release();
  }
}

// ============================================================
// PATCH /api/admin/payroll/batch/:batchId/finalize
// Must be called from a UI button with a double-confirmation, exactly like
// the existing _confirmMarkPaid pattern on the frontend. Once finalized, the
// period is locked: generatePayrollBatch will refuse to touch it again.
// ============================================================
async function finalizePayrollBatch(req, res) {
  const batchId = Number(req.params.batchId);
  const userId = req.user?.user_id;
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM payrollbatches WHERE payroll_batch_id = ? FOR UPDATE',
      [batchId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Payroll batch not found.' });
    }
    const batch = rows[0];
    if (batch.status === 'Superseded' || batch.status === 'Voided') {
      await connection.rollback();
      return res.status(409).json({ success: false, message: `A ${batch.status.toLowerCase()} batch cannot be finalized.` });
    }
    if (batch.is_finalized) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This batch is already finalized.' });
    }

    await connection.execute(
      `UPDATE payrollbatches
       SET is_finalized = 1, finalized_by_user_id = ?, finalized_at = NOW()
       WHERE payroll_batch_id = ?`,
      [userId, batchId]
    );

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('payrollbatches', ?, 'FINALIZED', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ is_finalized: false }), JSON.stringify({ is_finalized: true })]
    );

    await connection.commit();
    return res.json({
      success: true,
      message: 'Payroll batch finalized. Attendance in this period is now locked for normal editing. ' +
        'The batch can be marked as paid, or replaced only through "Supersede" with a reason.'
    });
  } catch (error) {
    await connection.rollback();
    console.error('finalizePayrollBatch:', error);
    return res.status(500).json({ success: false, message: 'Failed to finalize payroll batch.' });
  } finally {
    connection.release();
  }
}

// ============================================================
// GET /api/admin/payroll/batch/:batchId/versions
// Returns every version generated for the same (start_date, end_date, scope)
// so the UI can show "Version 1 (superseded) -> Version 2 (current)".
// ============================================================
async function getPayrollVersionChain(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  }
  try {
    const [anchorRows] = await pool.execute(
      'SELECT * FROM payrollbatches WHERE payroll_batch_id = ?',
      [batchId]
    );
    if (!anchorRows.length) {
      return res.status(404).json({ success: false, message: 'Payroll batch not found.' });
    }
    const anchor = anchorRows[0];

    const [all] = await pool.execute(
      `SELECT pb.*, u.full_name AS generated_by, fu.full_name AS finalized_by
       FROM payrollbatches pb
       JOIN users u ON u.user_id = pb.generated_by_user_id
       LEFT JOIN users fu ON fu.user_id = pb.finalized_by_user_id
       WHERE pb.start_date = ? AND pb.end_date = ? AND pb.scope_site_id <=> ?
         AND pb.batch_type = ? AND pb.scope_worker_id <=> ?
       ORDER BY pb.version_number ASC`,
      [anchor.start_date, anchor.end_date, anchor.scope_site_id, anchor.batch_type, anchor.scope_worker_id]
    );

    return res.json({ success: true, data: all });
  } catch (error) {
    console.error('getPayrollVersionChain:', error);
    return res.status(500).json({ success: false, message: 'Failed to load version history.' });
  }
}

async function getPayrollReport(req, res) {
  try {
    const { site_id } = req.query;
    const scoped = isSpecificSite(site_id);
    const params = [];
    let sql;
    // C-08: ?include_history=1 also lists Superseded and Voided versions.
    const statusFilter = req.query.include_history === '1' ? '1 = 1' : "pb.status IN ('Generated','Paid')";

    // Superseded versions are hidden from the main list — use
    // GET /batch/:batchId/versions to inspect the full history of a period.
    if (scoped) {
      sql = `
        SELECT pb.payroll_batch_id, pb.start_date, pb.end_date, pb.status, pb.generated_at,
               pb.version_number, pb.is_finalized, pb.finalized_at, pb.currency, pb.scope_site_id,
               pb.supersedes_batch_id, pb.void_reason, pb.supersede_reason,
               pb.batch_type, pb.scope_worker_id, pb.offcycle_reason,
               sw.full_name AS scope_worker_name, sw.worker_unique_id AS scope_worker_unique_id,
               u.full_name AS generated_by,
               COUNT(DISTINCT p.worker_id) AS total_workers,
               COALESCE(SUM(pi.base_salary + pi.overtime_pay), 0) AS total_amount
        FROM payrollbatches pb
        JOIN users u ON u.user_id = pb.generated_by_user_id
        LEFT JOIN workers sw ON sw.worker_id = pb.scope_worker_id
        JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
        JOIN payrollitems pi ON pi.payroll_id = p.payroll_id AND pi.site_id = ?
        WHERE ${statusFilter}
        GROUP BY pb.payroll_batch_id, pb.start_date, pb.end_date, pb.status, pb.generated_at,
                 pb.version_number, pb.is_finalized, pb.finalized_at, pb.currency, pb.scope_site_id,
                 pb.supersedes_batch_id, pb.void_reason, pb.supersede_reason,
                 pb.batch_type, pb.scope_worker_id, pb.offcycle_reason, sw.full_name, sw.worker_unique_id,
                 u.full_name
        ORDER BY pb.generated_at DESC`;
      params.push(site_id);
    } else {
      sql = `
        SELECT pb.payroll_batch_id, pb.start_date, pb.end_date,
               pb.total_workers, pb.total_amount, pb.status, pb.generated_at,
               pb.version_number, pb.is_finalized, pb.finalized_at, pb.currency, pb.scope_site_id,
               pb.supersedes_batch_id, pb.void_reason, pb.supersede_reason,
               pb.batch_type, pb.scope_worker_id, pb.offcycle_reason,
               sw.full_name AS scope_worker_name, sw.worker_unique_id AS scope_worker_unique_id,
               u.full_name AS generated_by
        FROM payrollbatches pb
        JOIN users u ON u.user_id = pb.generated_by_user_id
        LEFT JOIN workers sw ON sw.worker_id = pb.scope_worker_id
        WHERE ${statusFilter}
        ORDER BY pb.generated_at DESC`;
    }

    const [rows] = await pool.execute(sql, params);
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('getPayrollReport:', error);
    return res.status(500).json({ success: false, message: 'Failed to load payroll reports.' });
  }
}

// ============================================================
// Off-cycle payroll paid inside a Regular batch's period.
// For a Regular batch: every active (Generated/Paid) off-cycle batch whose
// period overlaps it (for a site-scoped batch: only off-cycle pay at that
// site). Amounts come from the stored off-cycle payroll, never recomputed.
// Returns [] for an off-cycle batch.
// ============================================================
async function loadOffCyclePaidInPeriod(executor, batch) {
  if (!batch || batch.batch_type === 'OffCycle') return [];
  const scopeSite = batch.scope_site_id == null ? null : Number(batch.scope_site_id);
  const [rows] = await executor.execute(
    `SELECT ob.payroll_batch_id, DATE_FORMAT(ob.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(ob.end_date, '%Y-%m-%d') AS end_date, ob.status, ob.is_finalized,
            ob.version_number, ob.offcycle_reason, ob.currency,
            DATE_FORMAT(ob.paid_at, '%Y-%m-%d') AS paid_at,
            w.worker_id, w.full_name AS worker_name, w.worker_unique_id,
            COALESCE(SUM(pi.base_salary + pi.overtime_pay), 0) AS amount,
            GROUP_CONCAT(DISTINCT s.site_name ORDER BY s.site_name SEPARATOR ', ') AS sites
     FROM payrollbatches ob
     JOIN workers w ON w.worker_id = ob.scope_worker_id
     JOIN payroll p ON p.payroll_batch_id = ob.payroll_batch_id
     JOIN payrollitems pi ON pi.payroll_id = p.payroll_id AND (? IS NULL OR pi.site_id = ?)
     LEFT JOIN sites s ON s.site_id = pi.site_id
     WHERE ob.batch_type = 'OffCycle' AND ob.status IN ${PAYROLL_LOCKING_STATUSES}
       AND ob.start_date <= ? AND ob.end_date >= ?
     GROUP BY ob.payroll_batch_id, ob.start_date, ob.end_date, ob.status, ob.is_finalized, ob.version_number,
              ob.offcycle_reason, ob.currency, ob.paid_at, w.worker_id, w.full_name, w.worker_unique_id
     ORDER BY w.full_name, ob.start_date`,
    [scopeSite, scopeSite, batch.end_date, batch.start_date]
  );
  return rows.map((r) => ({
    payroll_batch_id: r.payroll_batch_id,
    worker_id: r.worker_id,
    worker_name: r.worker_name,
    worker_unique_id: r.worker_unique_id,
    start_date: r.start_date,
    end_date: r.end_date,
    status: r.status,
    is_finalized: Number(r.is_finalized) === 1,
    paid_at: r.paid_at,
    version_number: r.version_number,
    reason: r.offcycle_reason,
    sites: r.sites || '',
    amount: money(r.amount),
    currency: r.currency,
  }));
}

async function getPayrollBatchDetails(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  try {
    const [batches] = await pool.execute(
      `SELECT pb.*, sw.full_name AS scope_worker_name, sw.worker_unique_id AS scope_worker_unique_id
       FROM payrollbatches pb LEFT JOIN workers sw ON sw.worker_id = pb.scope_worker_id
       WHERE pb.payroll_batch_id = ?`, [batchId]);
    if (!batches.length) return res.status(404).json({ success: false, message: 'Batch not found.' });

    const [payrolls] = await pool.execute(
      `SELECT p.payroll_id, p.gross_salary, p.net_salary,
              p.bonus_amount, p.penalty_amount, p.deductions_amount,
              w.worker_id, w.full_name AS worker_name
       FROM payroll p
       JOIN workers w ON w.worker_id = p.worker_id
       WHERE p.payroll_batch_id = ?
       ORDER BY w.full_name`,
      [batchId]
    );

    const [items] = await pool.execute(
      `SELECT pi.payroll_item_id, pi.payroll_id, pi.site_id, s.site_name, pi.pay_type,
              pi.regular_hours_worked, pi.overtime_hours_worked,
              pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot,
              pi.daily_rate_snapshot, pi.days_worked,
              pi.base_salary, pi.overtime_pay,
              DATE_FORMAT(span.rate_from, '%Y-%m-%d') AS rate_from,
              DATE_FORMAT(span.rate_to, '%Y-%m-%d') AS rate_to
       FROM payroll p
       JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
       LEFT JOIN sites s ON s.site_id = pi.site_id
       LEFT JOIN (SELECT payroll_item_id, MIN(record_date) AS rate_from, MAX(record_date) AS rate_to
                  FROM payroll_attendance_snapshot WHERE payroll_batch_id = ?
                  GROUP BY payroll_item_id) span ON span.payroll_item_id = pi.payroll_item_id
       WHERE p.payroll_batch_id = ?
       ORDER BY s.site_name, span.rate_from`,
      [batchId, batchId]
    );

    const itemsByPayroll = new Map();
    for (const item of items) {
      if (!itemsByPayroll.has(item.payroll_id)) itemsByPayroll.set(item.payroll_id, []);
      itemsByPayroll.get(item.payroll_id).push(item);
    }

    const workers = payrolls.map((p) => {
      const sites = itemsByPayroll.get(p.payroll_id) || [];
      return {
        ...p,
        pay_type: sites[0]?.pay_type || 'Hourly',
        days_worked: sites.reduce((sum, s) => sum + Number(s.days_worked || 0), 0),
        regular_hours_worked: sites.reduce((sum, s) => sum + Number(s.regular_hours_worked || 0), 0),
        overtime_hours_worked: sites.reduce((sum, s) => sum + Number(s.overtime_hours_worked || 0), 0),
        daily_rate: sites[0]?.daily_rate_snapshot ?? null,
        regular_rate: sites[0]?.hourly_rate_snapshot ?? null,
        // The rate actually used is stored per item (dated, D3). No overtime -> no rate.
        // A raise inside the period gives one item per rate (rate_from / rate_to on each item).
        rate_changed: new Set(sites.map((x) => `${x.pay_type}|${x.daily_rate_snapshot}|${x.hourly_rate_snapshot}`)).size > 1,
        overtime_rate: sites.find((x) => x.overtime_hourly_rate_snapshot != null)
          ? Number(sites.find((x) => x.overtime_hourly_rate_snapshot != null).overtime_hourly_rate_snapshot)
          : null,
        sites,
      };
    });

    // Off-cycle payroll already paid inside this (Regular) period: shown next
    // to the worker and in its own section; never added to this batch total.
    const offcyclePaid = await loadOffCyclePaidInPeriod(pool, batches[0]);
    const offByWorker = new Map();
    for (const o of offcyclePaid) {
      if (!offByWorker.has(o.worker_id)) offByWorker.set(o.worker_id, []);
      offByWorker.get(o.worker_id).push(o);
    }
    const inBatch = new Set(workers.map((w) => Number(w.worker_id)));
    for (const w of workers) w.offcycle_batches = offByWorker.get(Number(w.worker_id)) || [];
    for (const o of offcyclePaid) o.in_this_batch = inBatch.has(Number(o.worker_id));
    const batchTotal = money(workers.reduce((sum, w) => sum + Number(w.net_salary || 0), 0));
    const offcycleTotal = money(offcyclePaid.reduce((sum, o) => sum + o.amount, 0));

    return res.json({
      success: true,
      batch: batches[0],
      workers,
      offcycle_paid: offcyclePaid,
      offcycle_summary: {
        count: offcyclePaid.length,
        total: offcycleTotal,
        batch_total: batchTotal,
        period_total: money(batchTotal + offcycleTotal),
      },
    });
  } catch (error) {
    console.error('getPayrollBatchDetails:', error);
    return res.status(500).json({ success: false, message: 'Failed to load batch details.' });
  }
}

async function markBatchAsPaid(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [batches] = await connection.execute(
      'SELECT status, is_finalized FROM payrollbatches WHERE payroll_batch_id = ? FOR UPDATE',
      [batchId]
    );
    if (!batches.length) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Batch not found.' }); }
    if (batches[0].status === 'Superseded' || batches[0].status === 'Voided') { await connection.rollback(); return res.status(409).json({ success: false, message: `A ${batches[0].status.toLowerCase()} batch cannot be marked as paid.` }); }
    if (batches[0].status === 'Paid') { await connection.rollback(); return res.status(409).json({ success: false, message: 'Batch is already paid.' }); }
    if (!batches[0].is_finalized) { await connection.rollback(); return res.status(409).json({ success: false, message: 'Finalize this payroll batch (management approval) before marking it as paid.' }); }

    // C-09: who marked it paid and when is recorded on the batch and audited.
    const userId = req.user?.user_id;
    await connection.execute(`UPDATE payrollbatches SET status = 'Paid', paid_by_user_id = ?, paid_at = NOW() WHERE payroll_batch_id = ?`, [userId, batchId]);
    await connection.execute(`UPDATE payroll SET status = 'Paid', paid_date = ? WHERE payroll_batch_id = ?`, [businessToday(), batchId]);
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('payrollbatches', ?, 'MARKED_PAID', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ status: batches[0].status }), JSON.stringify({ status: 'Paid', paid_date: businessToday() })]
    );
    await connection.commit();
    return res.json({ success: true, message: 'Batch marked as paid.' });
  } catch (error) {
    await connection.rollback();
    console.error('markBatchAsPaid:', error);
    return res.status(500).json({ success: false, message: 'Failed to mark batch as paid.' });
  } finally {
    connection.release();
  }
}

// ============================================================
// D-03: PATCH /api/admin/payroll/batch/:batchId/void   { reason }
// A batch generated by mistake (NOT finalized, NOT paid) is marked Voided.
// Nothing is deleted: payroll rows, items, snapshots and history stay.
// Its period becomes free for a new batch.
// ============================================================
async function voidPayrollBatch(req, res) {
  const batchId = Number(req.params.batchId);
  const reason = String(req.body?.reason || '').trim();
  const userId = req.user?.user_id;
  if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  if (reason.length < 5) return res.status(400).json({ success: false, message: 'A reason (at least 5 characters) is required to void a batch.' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[batch]] = await connection.execute('SELECT * FROM payrollbatches WHERE payroll_batch_id = ? FOR UPDATE', [batchId]);
    if (!batch) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Batch not found.' }); }
    if (batch.status !== 'Generated') {
      await connection.rollback();
      return res.status(409).json({ success: false, message: `Only a Generated batch can be voided (this one is ${batch.status}).` });
    }
    if (batch.is_finalized) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A finalized batch cannot be voided. Use Supersede (with a reason) to correct it.' });
    }
    await connection.execute(
      `UPDATE payrollbatches SET status = 'Voided', voided_by_user_id = ?, voided_at = NOW(), void_reason = ?
       WHERE payroll_batch_id = ? AND status = 'Generated' AND is_finalized = 0`,
      [userId, reason.slice(0, 500), batchId]
    );
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('payrollbatches', ?, 'VOIDED', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ status: batch.status }), JSON.stringify({ status: 'Voided', reason })]
    );
    await connection.commit();
    return res.json({ success: true, message: `Batch #${batchId} voided. It stays in the history; its period can be generated again.` });
  } catch (error) {
    await connection.rollback();
    console.error('voidPayrollBatch:', error);
    return res.status(500).json({ success: false, message: 'Failed to void the batch.' });
  } finally {
    connection.release();
  }
}

// ============================================================
// D-03: POST /api/admin/payroll/batch/:batchId/supersede   { reason, acknowledge_pending? }
// Correct a FINALIZED (unpaid) batch: generate the replacement for the same
// period/scope inside one transaction, verify it, then mark the old batch
// Superseded. If generation fails the old batch is unchanged. A Paid batch
// can never be superseded (use the correction / adjustment workflow).
// ============================================================
async function supersedeFinalizedBatch(req, res) {
  const batchId = Number(req.params.batchId);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  if (reason.length < 5) return res.status(400).json({ success: false, message: 'A reason (at least 5 characters) is required to supersede a batch.' });
  try {
    const [[batch]] = await pool.execute('SELECT * FROM payrollbatches WHERE payroll_batch_id = ?', [batchId]);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found.' });
    if (batch.status === 'Paid') return res.status(409).json({ success: false, message: 'A Paid batch cannot be superseded. Record the difference through the correction/adjustment workflow.' });
    if (batch.status !== 'Generated') return res.status(409).json({ success: false, message: `Only the active batch of a period can be superseded (this one is ${batch.status}).` });
    if (!batch.is_finalized) return res.status(409).json({ success: false, message: 'This batch is not finalized: generate the same period again (or void it) instead.' });
    req.body = {
      start_date: String(batch.start_date).slice(0, 10),
      end_date: String(batch.end_date).slice(0, 10),
      site_id: batch.scope_site_id,
      acknowledge_pending: req.body?.acknowledge_pending === true,
    };
    req._supersede = { batchId, reason: reason.slice(0, 500) };
    if (batch.batch_type === 'OffCycle') {
      // Same worker and period; the original off-cycle reason is kept.
      req._offcycle = { workerId: batch.scope_worker_id, reason: batch.offcycle_reason || '', dryRun: false };
    }
    return generatePayrollBatch(req, res);
  } catch (error) {
    console.error('supersedeFinalizedBatch:', error);
    return res.status(500).json({ success: false, message: 'Failed to supersede the batch.' });
  }
}

async function getLastBatchEndDate(req, res) {
  try {
    const { site_id } = req.query || {};
    const params = [];
    // Off-cycle batches (one worker) never move the start of the next period.
    let sql = `SELECT MAX(pb.end_date) AS last_end_date FROM payrollbatches pb WHERE pb.status IN ('Generated','Paid') AND pb.batch_type = 'Regular'`;
    if (isSpecificSite(site_id)) {
      sql = `SELECT MAX(pb.end_date) AS last_end_date
             FROM payrollbatches pb
             JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
             JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
             WHERE pb.status IN ('Generated','Paid') AND pb.batch_type = 'Regular' AND pi.site_id = ?`;
      params.push(site_id);
    }
    const [rows] = await pool.execute(sql, params);
    return res.json({ success: true, last_end_date: rows[0]?.last_end_date || null });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load the last batch date.' });
  }
}
async function exportPayrollExcel(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  }

  try {
    const ExcelJS = require('exceljs');
    const path = require('path');
    const fs = require('fs');

    const [batches] = await pool.execute(
      `SELECT pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_workers, pb.total_amount, pb.status,
              pb.version_number, pb.is_finalized, pb.scope_site_id, pb.currency,
              pb.batch_type, pb.scope_worker_id, pb.offcycle_reason, sw.full_name AS scope_worker_name
       FROM payrollbatches pb LEFT JOIN workers sw ON sw.worker_id = pb.scope_worker_id
       WHERE pb.payroll_batch_id = ?`,
      [batchId]
    );
    if (!batches.length) return res.status(404).json({ success: false, message: 'Batch not found.' });
    const batch = batches[0];

    const [rows] = await pool.execute(
      `SELECT w.full_name AS worker_name, w.worker_unique_id, p.worker_id, pi.payroll_item_id,
              s.site_id, s.site_name, pi.pay_type,
              pi.regular_hours_worked, pi.overtime_hours_worked,
              pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot,
              pi.daily_rate_snapshot, pi.days_worked,
              pi.base_salary, pi.overtime_pay, p.net_salary
       FROM payroll p
       JOIN workers w ON w.worker_id = p.worker_id
       JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
       LEFT JOIN sites s ON s.site_id = pi.site_id
       WHERE p.payroll_batch_id = ?
       ORDER BY s.site_name, w.full_name`,
      [batchId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'No payroll items found for this batch.' });
    }

    // ---- (جديد) مجموع الساعات العادية والأوفر تايم لكل عامل من الحضور المعتمد ----
    // للعرض فقط: لا علاقة له بحسابات الرواتب.
    // (payrollitems بيخزّن الساعات للعمال بالساعة فقط، فبنجيبها من attendance لتشمل الكل)
    // C-07: hours come from the batch's own attendance snapshot. Batches
    // generated before the snapshot existed fall back to the attendance as it
    // is recorded today, and the sheet says so explicitly.
    const [snapRows] = await pool.execute(
      `SELECT worker_id, COALESCE(SUM(regular_hours), 0) AS regular_hours, COALESCE(SUM(overtime_hours), 0) AS overtime_hours
       FROM payroll_attendance_snapshot WHERE payroll_batch_id = ? GROUP BY worker_id`, [batchId]);
    const hoursFromSnapshot = snapRows.length > 0;
    // Rate period of each payroll item (a raise inside the period = 2 items).
    const [spanRows] = await pool.execute(
      `SELECT payroll_item_id, DATE_FORMAT(MIN(record_date), '%Y-%m-%d') AS f, DATE_FORMAT(MAX(record_date), '%Y-%m-%d') AS t
       FROM payroll_attendance_snapshot WHERE payroll_batch_id = ? GROUP BY payroll_item_id`, [batchId]);
    const itemSpan = new Map(spanRows.map((r) => [r.payroll_item_id, { from: r.f, to: r.t }]));
    let hoursRows = snapRows;
    if (!hoursFromSnapshot) {
      const hoursParams = [batch.start_date, batch.end_date];
      let hoursSql = `
        SELECT worker_id,
               COALESCE(SUM(total_working_hours), 0) AS regular_hours,
               COALESCE(SUM(overtime_hours), 0) AS overtime_hours
        FROM attendance
        WHERE record_date BETWEEN ? AND ?
          AND status = 'Approved'`;
      if (batch.scope_site_id) {
        hoursSql += ' AND site_id = ?';
        hoursParams.push(batch.scope_site_id);
      }
      hoursSql += ' GROUP BY worker_id';
      [hoursRows] = await pool.execute(hoursSql, hoursParams);
    }
    const currencyCode = String(batch.currency || 'SYP').toUpperCase();
    const currencyLabel = currencyCode === 'SYP' ? 'Syrian Pound (ل.س)' : currencyCode;
    const moneyFmt = currencyCode === 'SYP' ? '#,##0 "ل.س"' : `#,##0.00 "${currencyCode}"`;
    const hoursByWorker = new Map();
    for (const h of hoursRows) {
      hoursByWorker.set(h.worker_id, {
        regular: Number(h.regular_hours || 0),
        overtime: Number(h.overtime_hours || 0),
      });
    }

    const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
    const logoPath = path.join(__dirname, '../assets/logo.png');

    const workbook = new ExcelJS.Workbook();

    // اللوغو بيتضاف مرة وحدة للـ workbook وبنعيد استخدام الـ id لكل الشيتات
    let logoId = null;
    try {
      if (fs.existsSync(logoPath)) {
        logoId = workbook.addImage({ filename: logoPath, extension: 'png' });
      }
    } catch (e) {
      console.warn('Logo not added:', e.message);
    }
    function addLogo(sheet) {
      if (logoId === null) return;
      sheet.addImage(logoId, {
        tl: { col: 0.15, row: 0.15 },
        ext: { width: 150, height: 55 },
        editAs: 'oneCell',
      });
    }

    // Group rows by site
    const bySite = new Map();
    for (const row of rows) {
      const key = row.site_id ?? 'unassigned';
      if (!bySite.has(key)) bySite.set(key, { siteName: row.site_name || 'Unassigned', rows: [] });
      bySite.get(key).rows.push(row);
    }

    // Group by worker for the true (deduped) net salary in the Summary sheet
    const byWorker = new Map();
    for (const row of rows) {
      if (!byWorker.has(row.worker_id)) {
        const hrs = hoursByWorker.get(row.worker_id) || { regular: 0, overtime: 0 };
        byWorker.set(row.worker_id, {
          worker_name: row.worker_name,
          worker_unique_id: row.worker_unique_id,
          net_salary: Number(row.net_salary || 0),
          total_regular_hours: hrs.regular,
          total_overtime_hours: hrs.overtime,
          sites: new Set(),
        });
      }
      byWorker.get(row.worker_id).sites.add(row.site_name || 'Unassigned');
    }

    const totalWorkerCount = byWorker.size;

    const workerCountBySite = new Map();
    for (const row of rows) {
      const key = row.site_id ?? 'unassigned';
      if (!workerCountBySite.has(key)) workerCountBySite.set(key, new Set());
      workerCountBySite.get(key).add(row.worker_id);
    }

    // ---------------- Summary sheet ----------------
    const summarySheet = workbook.addWorksheet('Summary');
    addLogo(summarySheet);

    // ترتيب الأعمدة: A,B فراغ للوغو | C No | D ID | E Name | F Sites | G Net |
    //                H Regular Hrs | I OT Hrs | J Signature
    summarySheet.columns = [
      { header: '', key: 'logo_gap', width: 4 },
      { header: '', key: 'logo_gap2', width: 10 },
      { header: 'No.', key: 'number', width: 6 },
      { header: 'Worker ID', key: 'worker_id', width: 16 },
      { header: 'Worker Name', key: 'worker_name', width: 28 },
      { header: 'Sites', key: 'sites', width: 32 },
      { header: 'Net Salary', key: 'net_salary', width: 18 },
      { header: 'Total Hours (Regular + OT)', key: 'total_hours', width: 18 },
      { header: 'Signature', key: 'signature', width: 22 },   // ← عرض التوقيع (كان 80)
    ];

    summarySheet.mergeCells('C1:I1');
    const isOffCycle = batch.batch_type === 'OffCycle';
    summarySheet.getCell('C1').value = isOffCycle
      ? `Off-cycle (individual) Payroll Batch #${batchId} (v${batch.version_number}${batch.is_finalized ? ' - Finalized' : ''}) - ${batch.scope_worker_name || ''}`
      : `Payroll Batch #${batchId} (v${batch.version_number}${batch.is_finalized ? ' - Finalized' : ''})`;
    summarySheet.mergeCells('C2:I2');
    summarySheet.getCell('C2').value = `Period: ${dateOnly(batch.start_date)} - ${dateOnly(batch.end_date)}`;
    summarySheet.mergeCells('C3:I3');
    summarySheet.getCell('C3').value = `Currency: ${currencyLabel}${hoursFromSnapshot ? '' : ' — hours as currently recorded (batch generated before hour snapshots)'}`;
    summarySheet.mergeCells('C4:I4');
    summarySheet.getCell('C4').value = isOffCycle
      ? `Total Workers Paid: ${totalWorkerCount}    Reason: ${batch.offcycle_reason || '-'}`
      : `Total Workers Paid: ${totalWorkerCount}`;
    summarySheet.getCell('C4').font = { bold: true };

    summarySheet.getRow(1).height = 28;
    summarySheet.getRow(2).height = 28;
    summarySheet.getRow(3).height = 28;
    summarySheet.getRow(4).height = 28;
    summarySheet.getRow(5).values = ['', '', ...summarySheet.columns.slice(2).map((c) => c.header)];

    const SIGNATURE_ROW_HEIGHT = 85; // ← طول صف التوقيع (كان 65)

    let grandTotalNet = 0;
    let grandHours = 0;
    let idx = 0;
    for (const worker of byWorker.values()) {
      idx += 1;
      const workerTotalHours = worker.total_regular_hours + worker.total_overtime_hours;
      const row = summarySheet.addRow({
        number: idx,
        worker_id: worker.worker_unique_id,
        worker_name: worker.worker_name,
        sites: [...worker.sites].join(', '),
        net_salary: worker.net_salary,
        total_hours: Math.round(workerTotalHours * 100) / 100,
        signature: '',
      });
      row.height = SIGNATURE_ROW_HEIGHT;
      grandTotalNet += worker.net_salary;
      grandHours += workerTotalHours;
    }

    const summaryTotalRow = summarySheet.addRow({
      worker_name: 'GRAND TOTAL',
      net_salary: Math.round(grandTotalNet * 100) / 100,
      total_hours: Math.round(grandHours * 100) / 100,
    });
    summaryTotalRow.font = { bold: true };

    const headerRow = summarySheet.getRow(5);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.height = 32;

    const thinBorder = {
      top: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      left: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      right: { style: 'thin', color: { argb: 'FFDDDDDD' } },
    };

      for (let r = 6; r <= summarySheet.rowCount; r += 1) {
      summarySheet.getCell(r, 7).numFmt = moneyFmt;   // Net Salary (G)
      summarySheet.getCell(r, 8).numFmt = '0.00';          // Total Hours (H)
      for (const col of [8, 9]) {
        summarySheet.getCell(r, col).alignment = { vertical: 'middle', horizontal: 'center' };
      }
      summarySheet.getCell(r, 9).border = thinBorder;      // Signature (I)
    }
    summarySheet.views = [{ state: 'frozen', ySplit: 5 }];

    // ---- Off-cycle payroll already paid inside this period (Regular batch) ----
    // Listed for information only: NOT part of the GRAND TOTAL above and no
    // signature column (the worker signed the off-cycle batch's own sheet).
    const offcyclePaid = await loadOffCyclePaidInPeriod(pool, batch);
    if (offcyclePaid.length) {
      summarySheet.addRow([]);
      const titleRow = summarySheet.addRow({ number: 'Paid off-cycle in this period (not included in the GRAND TOTAL above)' });
      summarySheet.mergeCells(titleRow.number, 3, titleRow.number, 9);
      titleRow.font = { bold: true, color: { argb: 'FF8A4B00' } };
      titleRow.height = 24;
      const head = summarySheet.addRow({
        number: 'No.', worker_id: 'Worker ID', worker_name: 'Worker Name', sites: 'Off-cycle batch / period',
        net_salary: 'Amount paid', total_hours: 'Status', signature: 'Also in this batch',
      });
      head.font = { bold: true };
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4E0' } };
      head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      let offTotal = 0;
      offcyclePaid.forEach((o, i) => {
        const inThis = byWorker.has(o.worker_id);
        const r = summarySheet.addRow({
          number: i + 1,
          worker_id: o.worker_unique_id,
          worker_name: o.worker_name,
          sites: `#${o.payroll_batch_id}: ${o.start_date} - ${o.end_date}`,
          net_salary: o.amount,
          total_hours: o.status === 'Paid' ? 'Paid' : (o.is_finalized ? 'Finalized, not paid' : 'Not finalized'),
          signature: inThis ? 'Yes (remaining days)' : 'No (whole period)',
        });
        r.getCell(7).numFmt = moneyFmt;
        offTotal += o.amount;
      });
      const offTotalRow = summarySheet.addRow({ worker_name: 'OFF-CYCLE TOTAL', net_salary: Math.round(offTotal * 100) / 100 });
      offTotalRow.font = { bold: true };
      offTotalRow.getCell(7).numFmt = moneyFmt;
      const periodRow = summarySheet.addRow({ worker_name: 'PERIOD TOTAL (this batch + off-cycle)', net_salary: Math.round((grandTotalNet + offTotal) * 100) / 100 });
      periodRow.font = { bold: true, color: { argb: 'FF1A2A6C' } };
      periodRow.getCell(7).numFmt = moneyFmt;
    }

    // ---------------- One worksheet per site (بدون أي تغيير) ----------------
    const usedNames = new Set(['Summary']);
    for (const [siteKey, { siteName, rows: siteRows }] of bySite.entries()) {
      let safeName = siteName.replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 28) || 'Site';
      let finalName = safeName;
      let counter = 1;
      while (usedNames.has(finalName)) {
        finalName = `${safeName} (${counter++})`;
      }
      usedNames.add(finalName);

      const sheet = workbook.addWorksheet(finalName);
      addLogo(sheet);

      sheet.columns = [
        { header: 'No.', key: 'number', width: 6 },
        { header: 'Worker ID', key: 'worker_id', width: 16 },
        { header: 'Worker Name', key: 'worker_name', width: 28 },
        { header: 'Payment Type', key: 'pay_type', width: 14 },
        { header: 'Rate Period', key: 'rate_period', width: 24 },
        { header: 'Days Worked', key: 'days_worked', width: 12 },
        { header: 'Daily Rate', key: 'daily_rate', width: 14 },
        { header: 'Regular Hours', key: 'regular_hours', width: 14 },
        { header: 'Overtime Hours', key: 'overtime_hours', width: 14 },
        { header: 'Regular Rate', key: 'regular_rate', width: 14 },
        { header: 'Overtime Rate', key: 'overtime_rate', width: 14 },
        { header: 'Base Salary', key: 'base_salary', width: 16 },
        { header: 'Overtime Pay', key: 'overtime_pay', width: 16 },
        { header: 'Line Total', key: 'site_total', width: 16 },
        { header: 'Worker Total', key: 'worker_total', width: 18 },
        { header: 'Signature', key: 'signature', width: 30 },
      ];

      const siteWorkerCount = workerCountBySite.get(siteKey)?.size || 0;

      sheet.mergeCells('A1:P1');
      sheet.getCell('A1').value = `Payroll Batch #${batchId} - Site: ${siteName}`;
      sheet.mergeCells('A2:P2');
      sheet.getCell('A2').value = `Period: ${dateOnly(batch.start_date)} - ${dateOnly(batch.end_date)}`;
      sheet.mergeCells('A3:P3');
      sheet.getCell('A3').value = `Currency: ${currencyLabel} — Overtime: flat company rate per hour (see the Overtime Rate column)`;

      sheet.mergeCells('A4:P4');
      sheet.getCell('A4').value = `Workers at this site: ${siteWorkerCount}`;
      sheet.getCell('A4').font = { bold: true };

      sheet.getRow(1).height = 25;
      sheet.getRow(2).height = 25;
      sheet.getRow(3).height = 25;
      sheet.getRow(4).height = 22;
      sheet.getRow(5).values = sheet.columns.map((c) => c.header);

      let siteTotalBase = 0, siteTotalOT = 0, siteTotalAll = 0;

      // One block per worker: a raise inside the period gives one line per
      // rate (with its period); No. / ID / Name / Worker Total / Signature are
      // merged over the worker's lines.
      const workerGroups = [];
      const groupIdx = new Map();
      for (const item of siteRows) {
        if (!groupIdx.has(item.worker_id)) { groupIdx.set(item.worker_id, workerGroups.length); workerGroups.push([]); }
        workerGroups[groupIdx.get(item.worker_id)].push(item);
      }
      workerGroups.forEach((items, gIndex) => {
        items.sort((x, z) => String(itemSpan.get(x.payroll_item_id)?.from || '').localeCompare(String(itemSpan.get(z.payroll_item_id)?.from || '')));
        const workerTotal = items.reduce((sum, it) => sum + Number(it.base_salary || 0) + Number(it.overtime_pay || 0), 0);
        const firstRowNumber = sheet.rowCount + 1;
        items.forEach((item, i) => {
          const isDaily = item.pay_type === 'Daily';
          const rowTotal = Number(item.base_salary || 0) + Number(item.overtime_pay || 0);
          const span = itemSpan.get(item.payroll_item_id);
          const rowData = {
            number: i === 0 ? gIndex + 1 : null,
            worker_id: i === 0 ? item.worker_unique_id : null,
            worker_name: i === 0 ? item.worker_name : null,
            pay_type: item.pay_type,
            rate_period: span ? `${span.from} → ${span.to}` : '',
            overtime_hours: Number(item.overtime_hours_worked || 0),
            overtime_rate: Number(item.overtime_hourly_rate_snapshot || 0),
            base_salary: Number(item.base_salary || 0),
            overtime_pay: Number(item.overtime_pay || 0),
            site_total: rowTotal,
            worker_total: i === 0 ? Math.round(workerTotal * 100) / 100 : null,
            signature: '',
          };
          if (isDaily) {
            rowData.days_worked = item.days_worked;
            rowData.daily_rate = Number(item.daily_rate_snapshot || 0);
          } else {
            rowData.regular_hours = Number(item.regular_hours_worked || 0);
            rowData.regular_rate = Number(item.hourly_rate_snapshot || 0);
          }
          sheet.addRow(rowData);
          siteTotalBase += rowData.base_salary;
          siteTotalOT += rowData.overtime_pay;
          siteTotalAll += rowTotal;
        });
        if (items.length > 1) {
          const last = sheet.rowCount;
          for (const key of ['number', 'worker_id', 'worker_name', 'worker_total', 'signature']) {
            const col = sheet.getColumn(key).number;
            sheet.mergeCells(firstRowNumber, col, last, col);
            sheet.getCell(firstRowNumber, col).alignment = { vertical: 'middle', horizontal: key === 'worker_name' ? 'left' : 'center' };
          }
        }
      });

      const totalRow = sheet.addRow({
        worker_name: 'SITE TOTAL',
        base_salary: Math.round(siteTotalBase * 100) / 100,
        overtime_pay: Math.round(siteTotalOT * 100) / 100,
        site_total: Math.round(siteTotalAll * 100) / 100,
        worker_total: Math.round(siteTotalAll * 100) / 100,
      });
      totalRow.font = { bold: true };

      sheet.getRow(5).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
      for (let r = 6; r <= sheet.rowCount; r += 1) {
        for (const key of ['daily_rate', 'regular_rate', 'overtime_rate', 'base_salary', 'overtime_pay', 'site_total', 'worker_total']) {
          sheet.getCell(r, sheet.getColumn(key).number).numFmt = moneyFmt;
        }
      }
      sheet.views = [{ state: 'frozen', ySplit: 5 }];
    }

    // نبني الملف كامل بالذاكرة أولاً: إذا صار خطأ بيرجع JSON 500 نظيف بدل ملف مقطوع
    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `payroll_batch_${batchId}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.end(Buffer.from(buffer));
  } catch (error) {
    console.error('exportPayrollExcel:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Failed to export Excel payroll report.' });
    }
  }
}

// ============================================================
// GET /api/admin/payroll/batch/:batchId/export.pdf
// Formal PDF report for WORKERS payroll (distinct from staff PDF):
// - Grouped by SITE (workers of the same site listed together, sites never mixed)
// - Per-day breakdown: Regular hours / Overtime hours columns for every day
//   in the batch period
// - Different color scheme than the staff report (teal/amber instead of navy/red)
// ============================================================
// ============================================================
// REPLACEMENT for: controllers/adminPayrollController.js
// Function: exportPayrollPdf
//
// Paste this whole function in place of the existing
// `async function exportPayrollPdf(req, res) { ... }` block.
// Everything else in adminPayrollController.js stays as-is
// (module.exports already exports exportPayrollPdf).
//
// REQUIRED SETUP before this works correctly:
//   1) npm install arabic-reshaper
//   2) Download a Unicode Arabic font (e.g. "Noto Naskh Arabic"
//      from Google Fonts, or Cairo/Amiri) and place it at:
//        backend/assets/fonts/NotoNaskhArabic-Regular.ttf
//      (If the file isn't found, the code still runs — Arabic
//      text will fall back to plain Latin currency "SYP" and
//      Arabic names, but names will still render incorrectly
//      until the font file exists.)
// ============================================================

async function exportPayrollPdf(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  }

  try {
    const PDFDocument = require('pdfkit');
    const path = require('path');
    const fs = require('fs');
    let ArabicReshaper = null;
    try { ArabicReshaper = require('arabic-reshaper'); } catch (_) { ArabicReshaper = null; }

    const ARABIC_FONT_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Regular.ttf');
    const hasArabicFont = fs.existsSync(ARABIC_FONT_PATH);

    function isArabicText(str) {
      return /[\u0600-\u06FF]/.test(String(str || ''));
    }

    // Reshapes+reverses ONLY the Arabic-containing runs of a string,
    // e.g. in "1,500 ل.س" only "ل.س" gets touched — "1,500" stays as-is.
function shapeArabicAware(str) {
  const text = String(str ?? '');

  if (!isArabicText(text) || !hasArabicFont) return text;

  const tokens =
    text.match(/[\u0600-\u06FF\s.,،]+|[^\u0600-\u06FF]+/g) || [text];

  return tokens
    .map((tok) => {
      if (!isArabicText(tok)) return tok;
      if (!ArabicReshaper) return tok;

      try {
        const reordered = tok
          .trim()
          .split(/\s+/)
          .reverse()
          .join(' ');

        return ArabicReshaper.convertArabic(reordered);
      } catch (_) {
        return tok;
      }
    })
    .join('');
}

    function fontNameFor(str, bold) {
      if (hasArabicFont && isArabicText(str)) return 'Arabic';
      return bold ? 'Helvetica-Bold' : 'Helvetica';
    }

    const [batches] = await pool.execute(
      `SELECT pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_workers, pb.total_amount, pb.status,
              pb.version_number, pb.is_finalized, pb.currency,
              pb.batch_type, pb.scope_site_id, pb.scope_worker_id, pb.offcycle_reason, sw.full_name AS scope_worker_name,
              u.full_name AS generated_by, fu.full_name AS finalized_by
       FROM payrollbatches pb
       LEFT JOIN workers sw ON sw.worker_id = pb.scope_worker_id
       JOIN users u ON u.user_id = pb.generated_by_user_id
       LEFT JOIN users fu ON fu.user_id = pb.finalized_by_user_id
       WHERE pb.payroll_batch_id = ?`,
      [batchId]
    );
    if (!batches.length) return res.status(404).json({ success: false, message: 'Batch not found.' });
    const batch = batches[0];
    const CURRENCY_CODE = String(batch.currency || 'SYP').toUpperCase();
    const CURRENCY_LABEL = CURRENCY_CODE === 'SYP' ? 'ل.س' : CURRENCY_CODE;

    const [rows] = await pool.execute(
      `SELECT w.full_name AS worker_name, w.worker_unique_id, p.worker_id, pi.payroll_item_id,
              s.site_id, s.site_name, pi.pay_type,
              pi.regular_hours_worked, pi.overtime_hours_worked,
              pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot,
              pi.daily_rate_snapshot, pi.days_worked,
              pi.base_salary, pi.overtime_pay, p.net_salary
       FROM payroll p
       JOIN workers w ON w.worker_id = p.worker_id
       JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
       LEFT JOIN sites s ON s.site_id = pi.site_id
       WHERE p.payroll_batch_id = ?
       ORDER BY s.site_name, w.full_name`,
      [batchId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'No payroll items found for this batch.' });
    const isOffCycle = batch.batch_type === 'OffCycle';
    const offcyclePaid = await loadOffCyclePaidInPeriod(pool, batch);

    const num = (v) => Number(v || 0);
    const fmt2 = (v) => num(v).toFixed(2);
    // Compact day cell: "10" instead of "10.0", "7.5" stays.
    const hoursCell = (v) => (Number.isInteger(Math.round(v * 10) / 10) ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1));
    // Matches the app's formatSyp(): comma-grouped number + " ل.س"
    const money = (v) => `${Math.round(num(v)).toLocaleString('en-US')} ${CURRENCY_LABEL}`;

    // ---- Build the list of dates in the batch period ----
    const startDate = new Date(`${String(batch.start_date).slice(0, 10)}T00:00:00Z`);
    const endDate = new Date(`${String(batch.end_date).slice(0, 10)}T00:00:00Z`);
    const dateList = [];
    {
      const cursor = new Date(startDate.getTime());
      while (cursor <= endDate) {
        dateList.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
    // Long periods are no longer cut off: the whole table is scaled down to fit
    // the page width (and a larger sheet is used for very long periods).
    const MAX_DAYS = 93;
    const truncated = dateList.length > MAX_DAYS;
    const usedDates = truncated ? dateList.slice(0, MAX_DAYS) : dateList;

    // ---- Daily hours: the batch's own snapshot (C-07); older batches fall
    //      back to the attendance as recorded today (stated in the header). ----
    let [attRows] = await pool.execute(
      `SELECT payroll_item_id, worker_id, site_id, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date,
              regular_hours AS total_working_hours, overtime_hours
       FROM payroll_attendance_snapshot WHERE payroll_batch_id = ?`,
      [batchId]
    );
    const hoursFromSnapshot = attRows.length > 0;
    if (!hoursFromSnapshot) {
      [attRows] = await pool.execute(
        `SELECT worker_id, site_id, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date,
                total_working_hours, overtime_hours
         FROM attendance
         WHERE record_date BETWEEN ? AND ?
           AND status = 'Approved'`,
        [batch.start_date, batch.end_date]
      );
    }
const dailyMap = new Map();

// With the snapshot, days are keyed by payroll item: a worker whose rate
// changed inside the period has one item (row) per rate, and each row shows
// only the days paid at that rate.
const dayKey = (itemId, workerId, siteId, date) =>
  (hoursFromSnapshot ? `i${itemId}|${date}` : `${workerId}|${siteId}|${date}`);
for (const a of attRows) {
  const key = dayKey(a.payroll_item_id, a.worker_id, a.site_id, a.record_date);
  const prior = dailyMap.get(key) || { reg: 0, ot: 0 };

  dailyMap.set(key, {
    reg: prior.reg + Number(a.total_working_hours || 0),
    ot: prior.ot + Number(a.overtime_hours || 0),
  });
}

    // Date span of each payroll item (rate period), from the snapshot.
    const itemSpan = new Map();
    if (hoursFromSnapshot) {
      for (const a of attRows) {
        const span = itemSpan.get(a.payroll_item_id) || { from: a.record_date, to: a.record_date };
        if (a.record_date < span.from) span.from = a.record_date;
        if (a.record_date > span.to) span.to = a.record_date;
        itemSpan.set(a.payroll_item_id, span);
      }
    }
    const ddmm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

    function getDaily(itemId, workerId, siteId, date) {
      return dailyMap.get(dayKey(itemId, workerId, siteId, date)) || { reg: 0, ot: 0 };
    }


    const sortedRows = [...rows].sort((a, b) => {
      const bySite = (a.site_name || 'Unassigned').localeCompare(b.site_name || 'Unassigned');
      if (bySite !== 0) return bySite;
      return (a.worker_name || '').localeCompare(b.worker_name || '');
    });

    const distinctWorkerIds = new Set(rows.map((r) => r.worker_id));
    const distinctSites = new Set(rows.map((r) => r.site_name || 'Unassigned'));
    let grandTotalNet = 0;
    const netByWorker = new Map();
    for (const r of rows) if (!netByWorker.has(r.worker_id)) netByWorker.set(r.worker_id, num(r.net_salary));
    for (const v of netByWorker.values()) grandTotalNet += v;

    const COLOR_HEADER_BG = '#0b5b52';
    const COLOR_HEADER_TEXT = '#ffffff';
    const COLOR_ACCENT = '#0b5b52';
    const COLOR_ZEBRA = '#f7faf9';
    const COLOR_OT_TEXT = '#b26a00';
    const COLOR_GRID = '#dfe3e8';
    const COLOR_SUMMARY_BG = '#fff4e0';

    // ---- Fit-to-width layout ----
    // Natural table width = fixed columns + one column per day + totals. When
    // it is wider than the page, everything (fonts, columns, rows) is drawn at
    // scale K instead of running off the right edge. Very long periods move to
    // A3 / A2 so the text stays readable on screen (printing with "fit to page"
    // still gives one sheet width).
    const MARGIN = 30;
    const NATURAL_FIXED_W = 20 + 40 + 120 + 82;
    const NATURAL_DAY_W = 26;
    const NATURAL_TOTALS_W = 40 + 40 + 66 + 78;
    const naturalTableWidth = NATURAL_FIXED_W + usedDates.length * NATURAL_DAY_W + NATURAL_TOTALS_W;
    const SHEETS = [['A4', 841.89, 595.28], ['A3', 1190.55, 841.89], ['A2', 1683.78, 1190.55]];
    let sheet = SHEETS[0];
    for (const candidate of SHEETS) {
      sheet = candidate;
      if ((candidate[1] - 2 * MARGIN) / naturalTableWidth >= 0.5) break;   // A4 up to ~1 month
    }
    const K = Math.min(1, (sheet[1] - 2 * MARGIN) / naturalTableWidth);

    const doc = new PDFDocument({ size: sheet[0], layout: 'landscape', margin: MARGIN });
    if (hasArabicFont) doc.registerFont('Arabic', ARABIC_FONT_PATH);
    // Every page is drawn in "virtual" coordinates scaled by K from the origin.
    // PDFKit's automatic page break compares y with the UNscaled page height;
    // the table paginates itself, so that check is disabled on every page.
    const applyScale = () => {
      doc.page.maxY = () => 1e9;
      if (K < 1) doc.scale(K);
    };
    applyScale();
    doc.on('pageAdded', applyScale);
    const VL = MARGIN / K;                                   // virtual left margin
    const VT = MARGIN / K;                                   // virtual top margin
    const VBOTTOM = (doc.page.height - MARGIN) / K;          // virtual bottom edge

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_batch_${batchId}.pdf"`);
    doc.pipe(res);

    const pageWidth = (doc.page.width - 2 * MARGIN) / K;   // virtual usable width
    const logoPath = path.join(__dirname, '../assets/logo.png');
    const hasLogo = fs.existsSync(logoPath);

    const statusText = batch.status === 'Superseded' ? 'SUPERSEDED' : batch.status === 'Voided' ? 'VOIDED' : batch.status === 'Paid' ? 'PAID' : 'GENERATED';
    const isFinalized = batch.is_finalized === 1 || batch.is_finalized === true;

    function drawHeader() {
      let y = VT;
      if (hasLogo) doc.image(logoPath, VL, y, { width: 85, height: 38 });

      doc.font('Helvetica-Bold').fontSize(16).fillColor('black')
        .text(isOffCycle ? 'WORKERS PAYROLL REPORT - OFF-CYCLE (INDIVIDUAL)' : 'WORKERS PAYROLL REPORT', VL, y + 2, { width: pageWidth, align: 'center' });
      doc.font('Helvetica').fontSize(9)
        .text('ASIK ENGINEERING CONSTRUCTION', VL, y + 22, { width: pageWidth, align: 'center' });

      y += 48;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('black');
      doc.text(`Batch #${batchId}  (Version ${batch.version_number || 1})`, VL, y);
      doc.text(`Period: ${String(batch.start_date).slice(0, 10)}   to   ${String(batch.end_date).slice(0, 10)}`,
        VL, y, { width: pageWidth, align: 'right' });
      y += 15;

      const payColor = statusText === 'PAID' ? '#1a7a3c' : statusText === 'SUPERSEDED' ? '#888888' : COLOR_OT_TEXT;
      doc.fillColor(isFinalized ? '#1a7a3c' : '#b21f1f').text(`Status: ${isFinalized ? 'FINALIZED' : 'NOT FINALIZED'}`, VL, y);
      doc.fillColor(payColor).text(`Payment: ${statusText}`, VL + 170, y);
      doc.fillColor('black');
      y += 18;

      if (isOffCycle) {
        const reasonText = `Off-cycle reason: ${batch.offcycle_reason || '-'}`;
        doc.font(fontNameFor(reasonText, false)).fontSize(9).fillColor('#8a4b00')
          .text(shapeArabicAware(reasonText), VL, y, { width: pageWidth });
        doc.fillColor('black');
        y += 14;
      }

      if (truncated) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#b21f1f')
          .text(`Showing first ${MAX_DAYS} of ${dateList.length} days in this period (generate shorter periods for full detail).`, VL, y);
        doc.fillColor('black');
        y += 12;
      }
      if (!hoursFromSnapshot) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#b21f1f')
          .text('Daily hours shown as currently recorded (this batch was generated before hour snapshots). Amounts are the stored batch amounts.', VL, y);
        doc.fillColor('black');
        y += 12;
      }

      doc.rect(VL, y, pageWidth, 20).fill(COLOR_SUMMARY_BG);
     doc.fillColor(COLOR_ACCENT).font('Helvetica-Bold').fontSize(9);

const summaryX = VL + 8;
const summaryY = y + 5;

const summaryLabel =
  `Total Workers: ${distinctWorkerIds.size}    |    Total Sites: ${distinctSites.size}    |    TOTAL NET: `;

doc.font('Helvetica-Bold')
  .fontSize(9)
  .fillColor(COLOR_ACCENT)
  .text(summaryLabel, summaryX, summaryY, {
    lineBreak: false,
  });

let currentX = summaryX + doc.widthOfString(summaryLabel);

const amountOnly = Math.round(num(grandTotalNet)).toLocaleString('en-US');

doc.font('Helvetica-Bold')
  .fontSize(9)
  .fillColor(COLOR_ACCENT)
  .text(amountOnly, currentX, summaryY, {
    lineBreak: false,
  });

currentX += doc.widthOfString(amountOnly) + 3;

if (hasArabicFont && CURRENCY_CODE === 'SYP') {
  doc.font('Arabic')
    .fontSize(9)
    .fillColor(COLOR_ACCENT)
   .text(shapeArabicAware(CURRENCY_LABEL), currentX, summaryY - 4, {
  lineBreak: false,
});
} else {
  doc.font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(COLOR_ACCENT)
    .text(CURRENCY_CODE, currentX, summaryY, {
      lineBreak: false,
    });
}
      doc.fillColor('black');
      y += 30;
      return y;
    }

    // ---- Column layout ----
    const fixedCols = [
      { key: 'no', label: 'No.', width: 20 },
      { key: 'worker_id', label: 'ID', width: 40 },
      { key: 'full_name', label: 'Worker Name', width: 120 },
      { key: 'site_name', label: 'Site', width: 82 },
    ];
    const dayColWidth = NATURAL_DAY_W;
    const totalsCols = [
      { key: 'total_reg', label: 'Tot.Reg', width: 40 },
      { key: 'total_ot', label: 'Tot.OT', width: 40 },
      { key: 'daily_wage', label: 'Rate', width: 66 },
      { key: 'net', label: 'Net Pay', width: 78 },
    ];

    const tableTotalWidth = fixedCols.reduce((s, c) => s + c.width, 0)
      + usedDates.length * dayColWidth
      + totalsCols.reduce((s, c) => s + c.width, 0);

    function drawTableHeader(y) {
      const rowH1 = 14, rowH2 = 16;
      let x = VL;

      doc.rect(x, y, fixedCols.reduce((s, c) => s + c.width, 0), rowH1 + rowH2).fill(COLOR_HEADER_BG);
      doc.fillColor(COLOR_HEADER_TEXT).font('Helvetica-Bold').fontSize(7);
      let fx = x;
      for (const c of fixedCols) {
        doc.text(c.label, fx + 2, y + rowH1 / 2 + 3, { width: c.width - 4, align: 'center' });
        fx += c.width;
      }
      x = fx;

      doc.font('Helvetica-Bold').fontSize(6.3);
      let dx = x;
      for (const d of usedDates) {
        doc.rect(dx, y, dayColWidth, rowH1).fill(COLOR_HEADER_BG);
        doc.fillColor(COLOR_HEADER_TEXT).text(d.slice(5), dx, y + 3, { width: dayColWidth, align: 'center' });
        doc.rect(dx, y + rowH1, dayColWidth / 2, rowH2).fill('#0e7568');
        doc.rect(dx + dayColWidth / 2, y + rowH1, dayColWidth / 2, rowH2).fill('#b8792a');
        doc.fillColor(COLOR_HEADER_TEXT).fontSize(6)
          .text('R', dx, y + rowH1 + 4, { width: dayColWidth / 2, align: 'center' })
          .text('OT', dx + dayColWidth / 2, y + rowH1 + 4, { width: dayColWidth / 2, align: 'center' });
        dx += dayColWidth;
      }
      x = dx;

      doc.font('Helvetica-Bold').fontSize(7);
      for (const c of totalsCols) {
        doc.rect(x, y, c.width, rowH1 + rowH2).fill(COLOR_HEADER_BG);
        doc.fillColor(COLOR_HEADER_TEXT).text(c.label, x + 2, y + rowH1 / 2 + 3, { width: c.width - 4, align: 'center' });
        x += c.width;
      }

      doc.fillColor('black');
      return y + rowH1 + rowH2;
    }

    // Measures how tall a row needs to be so the text-heavy cells
    // (Name / Site / Rate / Net) NEVER get clipped — they wrap instead.
    function measureRowHeight(item) {
      doc.fontSize(6.6);

      doc.font(fontNameFor(item.full_name));
      const nameH = doc.heightOfString(shapeArabicAware(item.full_name), { width: fixedCols[2].width - 6 });

      doc.font(fontNameFor(item.site_name));
      const siteH = doc.heightOfString(shapeArabicAware(item.site_name), { width: fixedCols[3].width - 6 });

      doc.font(fontNameFor(item.daily_wage));
      const rateH = doc.heightOfString(item.daily_wage, { width: totalsCols[2].width - 6 });

      doc.font(fontNameFor(item.net));
      const netH = doc.heightOfString(item.net, { width: totalsCols[3].width - 6 });

      const periodH = item.period ? 8 : 0;   // rate period line (Latin only)
      return Math.max(13, Math.ceil(Math.max(nameH, siteH, rateH + periodH, netH)) + 5);
    }

    function drawDataRow(y, item, opts = {}) {
      const rowH = opts.rowHeight || 13;
      let x = VL;

      if (opts.zebra) {
        doc.rect(x, y, tableTotalWidth, rowH).fill(COLOR_ZEBRA);
        doc.fillColor('black');
      }
      if (opts.mergedFixed) {
        // No. / ID / Name / Site are drawn once for the whole worker group.
        x += fixedCols.reduce((sum, c) => sum + c.width, 0);
      } else {

      // No. / ID — short, fixed, never wraps
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.6);
      for (const c of [fixedCols[0], fixedCols[1]]) {
        doc.rect(x, y, c.width, rowH).stroke(COLOR_GRID);
        doc.fillColor('black').text(String(item[c.key] ?? ''), x + 2, y + rowH / 2 - 4, {
          width: c.width - 4, align: 'center', lineBreak: false,
        });
        x += c.width;
      }

      // Worker Name — Arabic-aware, wraps instead of being cut off
      {
        const c = fixedCols[2];
        doc.rect(x, y, c.width, rowH).stroke(COLOR_GRID);
        const raw = item.full_name || '';
        doc.font(fontNameFor(raw, opts.bold));
        doc.fillColor('black').text(shapeArabicAware(raw), x + 3, y + 3, {
          width: c.width - 6,
          align: isArabicText(raw) ? 'right' : 'left',
          lineBreak: true,
        });
        x += c.width;
      }

      // Site — new column, same wrapping treatment
      {
        const c = fixedCols[3];
        doc.rect(x, y, c.width, rowH).stroke(COLOR_GRID);
        const raw = item.site_name || '';
        doc.font(fontNameFor(raw, opts.bold));
        doc.fillColor('black').text(shapeArabicAware(raw), x + 3, y + 3, {
          width: c.width - 6,
          align: isArabicText(raw) ? 'right' : 'left',
          lineBreak: true,
        });
        x += c.width;
      }
      }

      // Day columns
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5);
      for (const d of usedDates) {
        const half = dayColWidth / 2;
        if (opts.blankDays) {
          doc.rect(x, y, dayColWidth, rowH).stroke(COLOR_GRID);
          x += dayColWidth;
          continue;
        }
        const daily = item.dailyByDate[d] || { reg: 0, ot: 0 };
        doc.rect(x, y, half, rowH).stroke(COLOR_GRID);
        doc.fillColor('black').text(daily.reg > 0 ? hoursCell(daily.reg) : '-', x, y + rowH / 2 - 4, { width: half, align: 'center', lineBreak: false });
        x += half;
        doc.rect(x, y, half, rowH).stroke(COLOR_GRID);
        doc.fillColor(daily.ot > 0 ? COLOR_OT_TEXT : 'black')
          .text(daily.ot > 0 ? hoursCell(daily.ot) : '-', x, y + rowH / 2 - 4, { width: half, align: 'center', lineBreak: false });
        x += half;
      }

      // Totals — Tot.Reg / Tot.OT never wrap; Rate / Net Pay can
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.6);
      for (const c of [totalsCols[0], totalsCols[1]]) {
        doc.rect(x, y, c.width, rowH).stroke(COLOR_GRID);
        doc.fillColor(c.key === 'total_ot' ? COLOR_OT_TEXT : 'black')
          .text(String(item[c.key] ?? ''), x + 2, y + rowH / 2 - 4, { width: c.width - 4, align: 'center', lineBreak: false });
        x += c.width;
      }
      for (const c of [totalsCols[2], totalsCols[3]]) {
        doc.rect(x, y, c.width, rowH).stroke(COLOR_GRID);
        const raw = String(item[c.key] ?? '');
        doc.font(fontNameFor(raw, opts.bold));
        doc.fillColor(c.key === 'net' ? COLOR_ACCENT : 'black')
          .text(shapeArabicAware(raw), x + 3, y + 3, { width: c.width - 6, align: 'center', lineBreak: true });
        if (c.key === 'daily_wage' && item.period) {
          const rh = doc.heightOfString(shapeArabicAware(raw), { width: c.width - 6 });
          doc.font('Helvetica').fontSize(5.8).fillColor('#5b6770')
            .text(item.period, x + 3, y + 3 + rh, { width: c.width - 6, align: 'center', lineBreak: false });
          doc.fontSize(6.6);
        }
        x += c.width;
      }
      doc.fillColor('black');

      return y + rowH;
    }

    let y = drawHeader();
    y = drawTableHeader(y);
    const bottomLimit = VBOTTOM - 20;

    // One group per worker + site. A rate change inside the period gives
    // several payroll items: they are drawn as sub-rows of the SAME worker row
    // (No. / ID / Name / Site merged), each with its rate period, followed by
    // the worker's total.
    const groups = [];
    const groupByKey = new Map();
    for (const r of sortedRows) {
      const key = `${r.worker_id}|${r.site_id}`;
      if (!groupByKey.has(key)) { groupByKey.set(key, { rows: [] }); groups.push(groupByKey.get(key)); }
      groupByKey.get(key).rows.push(r);
    }
    for (const g of groups) {
      g.rows.sort((x, z) => String(itemSpan.get(x.payroll_item_id)?.from || '').localeCompare(String(itemSpan.get(z.payroll_item_id)?.from || '')));
    }

    function drawMergedFixed(y, h, item, zebra) {
      let x = VL;
      if (zebra) { doc.rect(x, y, fixedCols.reduce((sum, c) => sum + c.width, 0), h).fill(COLOR_ZEBRA); }
      doc.font('Helvetica').fontSize(6.6);
      for (const c of fixedCols) {
        doc.rect(x, y, c.width, h).stroke(COLOR_GRID);
        const raw = String(item[c.key] ?? '');
        if (c.key === 'full_name' || c.key === 'site_name') {
          doc.font(fontNameFor(raw));
          const th = doc.heightOfString(shapeArabicAware(raw), { width: c.width - 6 });
          doc.fillColor('black').text(shapeArabicAware(raw), x + 3, y + Math.max(3, (h - th) / 2), {
            width: c.width - 6, align: isArabicText(raw) ? 'right' : 'left', lineBreak: true,
          });
          doc.font('Helvetica');
        } else {
          doc.fillColor('black').text(raw, x + 2, y + h / 2 - 4, { width: c.width - 4, align: 'center', lineBreak: false });
        }
        x += c.width;
      }
      doc.fillColor('black');
    }

    groups.forEach((g, gi) => {
      const zebra = gi % 2 === 1;
      const subItems = g.rows.map((r) => {
        const dailyByDate = {};
        let totalReg = 0, totalOt = 0;
        for (const d of usedDates) {
          const v = getDaily(r.payroll_item_id, r.worker_id, r.site_id, d);
          dailyByDate[d] = v;
          totalReg += v.reg;
          totalOt += v.ot;
        }
        const isDaily = r.pay_type === 'Daily';
        const rateLabel = isDaily ? money(r.daily_rate_snapshot) : `${money(r.hourly_rate_snapshot)}/h`;
        const span = itemSpan.get(r.payroll_item_id);
        const itemNet = num(r.base_salary) + num(r.overtime_pay);
        return {
          no: gi + 1,
          worker_id: r.worker_unique_id,
          full_name: r.worker_name,
          site_name: r.site_name || 'Unassigned',
          total_reg: fmt2(totalReg), total_ot: fmt2(totalOt),
          totalRegNum: totalReg, totalOtNum: totalOt, netNum: itemNet,
          // the period is shown only when the worker has more than one rate
          daily_wage: rateLabel,
          period: g.rows.length > 1 && span ? `${ddmm(span.from)} - ${ddmm(span.to)}` : '',
          net: money(itemNet),
          dailyByDate,
        };
      });
      const multi = subItems.length > 1;
      const totalItem = multi ? {
        ...subItems[0],
        total_reg: fmt2(subItems.reduce((sum, i) => sum + i.totalRegNum, 0)),
        total_ot: fmt2(subItems.reduce((sum, i) => sum + i.totalOtNum, 0)),
        daily_wage: 'Worker total',
        period: '',
        net: money(subItems.reduce((sum, i) => sum + i.netNum, 0)),
        dailyByDate: {},
      } : null;

      const heights = subItems.map((it) => measureRowHeight(it));
      const totalH = totalItem ? 13 : 0;
      const groupH = heights.reduce((sum, h) => sum + h, 0) + totalH;
      if (y + groupH > bottomLimit) {
        doc.addPage();
        y = VT;
        y = drawTableHeader(y);
      }
      if (!multi) {
        y = drawDataRow(y, subItems[0], { zebra, rowHeight: heights[0] });
        return;
      }
      const top = y;
      subItems.forEach((it, i) => { y = drawDataRow(y, it, { zebra, rowHeight: heights[i], mergedFixed: true }); });
      y = drawDataRow(y, totalItem, { zebra, rowHeight: totalH, mergedFixed: true, blankDays: true, bold: true });
      drawMergedFixed(top, groupH, subItems[0], zebra);
    });

    if (y + 20 > bottomLimit) {
      doc.addPage();
      y = VT;
      y = drawTableHeader(y);
    }
const grandTotalX = VL;
const grandTotalY = y + 6;

const grandTotalLabel = 'GRAND TOTAL NET: ';

doc.font('Helvetica-Bold')
  .fontSize(8)
  .fillColor(COLOR_ACCENT)
  .text(grandTotalLabel, grandTotalX, grandTotalY, {
    lineBreak: false,
  });

let grandX = grandTotalX + doc.widthOfString(grandTotalLabel);

const grandAmount = Math.round(num(grandTotalNet)).toLocaleString('en-US');

doc.font('Helvetica-Bold')
  .fontSize(8)
  .fillColor(COLOR_ACCENT)
  .text(grandAmount, grandX, grandTotalY, {
    lineBreak: false,
  });

grandX += doc.widthOfString(grandAmount) + 3;

if (hasArabicFont && CURRENCY_CODE === 'SYP') {
  doc.font('Arabic')
    .fontSize(8)
    .fillColor(COLOR_ACCENT)
  .text(shapeArabicAware(CURRENCY_LABEL), grandX, grandTotalY - 4, {
  lineBreak: false,
});
} else {
  doc.font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(COLOR_ACCENT)
    .text(CURRENCY_CODE, grandX, grandTotalY, {
      lineBreak: false,
    });
}

doc.fillColor('black');
    y += 26;

    // ---- Off-cycle payroll already paid inside this period (Regular batch) ----
    // Information only: not part of GRAND TOTAL NET above.
    if (offcyclePaid.length) {
      const cols = [
        { label: '#', w: 24 }, { label: 'ID', w: 60 }, { label: 'Worker', w: 170 },
        { label: 'Off-cycle batch / period', w: 190 }, { label: 'Amount paid', w: 110 },
        { label: 'Status', w: 110 }, { label: 'Also in this batch', w: 120 },
      ];
      const rowH = 15;
      const needed = 18 + rowH * (offcyclePaid.length + 1) + 34;
      if (y + Math.min(needed, 120) > VBOTTOM - 70) { doc.addPage(); y = VT; }
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#8a4b00')
        .text('PAID OFF-CYCLE IN THIS PERIOD (not included in GRAND TOTAL NET above)', VL, y);
      y += 14;
      const drawRow = (cells, opts = {}) => {
        let x = VL;
        if (opts.fill) doc.rect(VL, y, cols.reduce((sum, c) => sum + c.w, 0), rowH).fill(opts.fill);
        cols.forEach((c, i) => {
          const text = String(cells[i] ?? '');
          doc.font(fontNameFor(text, Boolean(opts.bold))).fontSize(8).fillColor('black')
            .text(shapeArabicAware(text), x + 3, y + 4, { width: c.w - 6, lineBreak: false, ellipsis: true });
          x += c.w;
        });
        y += rowH;
      };
      drawRow(cols.map((c) => c.label), { bold: true, fill: COLOR_SUMMARY_BG });
      let offTotal = 0;
      offcyclePaid.forEach((o, i) => {
        if (y + rowH > VBOTTOM - 40) { doc.addPage(); y = VT; }
        drawRow([
          i + 1, o.worker_unique_id, o.worker_name, `#${o.payroll_batch_id}: ${o.start_date} to ${o.end_date}`,
          Math.round(o.amount).toLocaleString('en-US'),
          o.status === 'Paid' ? 'Paid' : (o.is_finalized ? 'Finalized, not paid' : 'Not finalized'),
          netByWorker.has(o.worker_id) ? 'Yes (remaining days)' : 'No (whole period)',
        ]);
        offTotal += o.amount;
      });
      y += 4;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR_ACCENT)
        .text(`OFF-CYCLE TOTAL: ${Math.round(offTotal).toLocaleString('en-US')} ${CURRENCY_CODE}     ` +
          `PERIOD TOTAL (this batch + off-cycle): ${Math.round(num(grandTotalNet) + offTotal).toLocaleString('en-US')} ${CURRENCY_CODE}`,
        VL, y, { lineBreak: false });
      doc.fillColor('black');
      y += 18;
    }

    // ---- Signature footer ----
    function drawSignaturesFooter(currentY) {
      const footerY = currentY + 15; // مسافة بسيطة بعد الجدول

      // تحقق إذا كانت التواقيع ستنزل خارج الصفحة، إذاً انقلها لصفحة جديدة
      if (footerY + 50 > VBOTTOM) {
        doc.addPage();
        return VT + 20;
      }

      doc.font('Helvetica').fontSize(8);
      const sectionWidth = pageWidth / 3;
      const signaturesData = [
        { title: 'Prepared by', name: batch.generated_by || '-' },
        { title: 'Verified by', name: '-' },
        { title: 'Approved by', name: batch.finalized_by || '-' },
      ];

      signaturesData.forEach((sig, index) => {
        const startXPos = VL + index * sectionWidth;
        doc.font('Helvetica-Bold').text(`${sig.title}:`, startXPos, footerY, { width: sectionWidth - 20 });
        doc.font('Helvetica').text(`Name: ${sig.name}`, startXPos, footerY + 12, { width: sectionWidth - 20 });
        doc.text('Signature: ___________________', startXPos, footerY + 24, { width: sectionWidth - 20 });
        doc.text(`Date: ____ / ____ / ________`, startXPos, footerY + 36, { width: sectionWidth - 20 });
      });

      return footerY + 50;
    }

    drawSignaturesFooter(y);

    doc.end();
  } catch (error) {
    console.error('exportPayrollPdf:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Failed to export workers payroll PDF report.' });
    }
  }
}



async function exportDailyAttendanceExcel(req, res) {
  const { date, site_id } = req.query || {};

  if (!isValidDate(date)) {
    return res.status(400).json({
      success: false,
      message: 'A valid date in YYYY-MM-DD format is required.',
    });
  }

  try {
    const ExcelJS = require('exceljs');
    const path = require('path');

    const params = [date];
    let siteFilter = '';

    if (isSpecificSite(site_id)) {
      siteFilter = ' AND a.site_id = ?';
      params.push(site_id);
    }

 const [rows] = await pool.execute(
    `SELECT a.record_date, a.shift_type, w.worker_unique_id, w.full_name AS worker_name,
            s.site_name, a.attendance_status, a.status AS workflow_status,
            a.check_in_time, a.check_out_time, a.total_working_hours,
            a.overtime_hours, a.management_leave_hours, a.remarks,
            a.admin_rejection_notes
     FROM attendance a
     JOIN workers w ON w.worker_id = a.worker_id
     JOIN sites s ON s.site_id = a.site_id
     WHERE a.record_date = ?${siteFilter}
     ORDER BY s.site_name, a.shift_type, w.full_name`,
    params
);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Daily Attendance');

    const logoPath = path.join(__dirname, '../assets//logo.png');
    const logoId = workbook.addImage({ filename: logoPath, extension: 'png' });
    sheet.addImage(logoId, { tl: { col: 0.2, row: 0.15 }, ext: { width: 150, height: 60 } });

sheet.columns = [
    { header: 'No.', key: 'number', width: 8 },
    { header: 'Worker ID', key: 'worker_id', width: 16 },
    { header: 'Worker Name', key: 'worker_name', width: 28 },
    { header: 'Site', key: 'site_name', width: 22 },
    { header: 'Shift', key: 'shift_type', width: 10 },   // ← جديد
    { header: 'Attendance Status', key: 'attendance_status', width: 20 },
    { header: 'Workflow Status', key: 'workflow_status', width: 18 },
    { header: 'Check In', key: 'check_in', width: 22 },
    { header: 'Check Out', key: 'check_out', width: 22 },
    { header: 'Regular Hours', key: 'regular_hours', width: 16 },
    { header: 'Overtime Hours', key: 'overtime_hours', width: 16 },
    { header: 'Management Leave Hours', key: 'management_leave_hours', width: 24 },
    { header: 'Remarks', key: 'remarks', width: 36 },
];

    sheet.mergeCells('A1:L1');
    sheet.getCell('A1').value = `Daily Attendance Report - ${date}`;
    sheet.mergeCells('A2:L2');
    sheet.getCell('A2').value = 'Attendance and hours only — no salary or rate calculation';
    sheet.getRow(1).height = 48;
    sheet.getRow(2).height = 24;
    sheet.getRow(4).values = sheet.columns.map((column) => column.header);

rows.forEach((row, index) => {
    sheet.addRow({
        number: index + 1,
        worker_id: row.worker_unique_id,
        worker_name: row.worker_name,
        site_name: row.site_name,
        shift_type: row.shift_type,   // ← جديد
        attendance_status: row.attendance_status || 'Present',
        workflow_status: row.workflow_status,
        check_in: row.check_in_time || '',
        check_out: row.check_out_time || '',
        regular_hours: Number(row.total_working_hours || 0),
        overtime_hours: Number(row.overtime_hours || 0),
        management_leave_hours: Number(row.management_leave_hours || 0),
        remarks: row.remarks || '',
    });
});

    sheet.getRow(1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(2).font = { italic: true, color: { argb: 'FF555555' } };
    sheet.getRow(2).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    sheet.getRow(4).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

    for (let rowIndex = 5; rowIndex <= sheet.rowCount; rowIndex++) {
      sheet.getCell(`I${rowIndex}`).numFmt = '0.00';
      sheet.getCell(`J${rowIndex}`).numFmt = '0.00';
      sheet.getCell(`K${rowIndex}`).numFmt = '0.00';
    }

    sheet.views = [{ state: 'frozen', ySplit: 4 }];
    sheet.autoFilter = { from: 'A4', to: 'L4' };

    const fileName = `daily_attendance_${date}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('exportDailyAttendanceExcel:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Failed to export daily attendance report.' });
    }
  }
}

// ============================================================
// Off-cycle (urgent) payroll of ONE worker
//
// POST /api/admin/payroll/generate-offcycle
//   { worker_id, start_date, end_date, reason, dry_run? }
// dry_run = true runs every check and the full calculation, writes nothing,
// and returns the amount (preview). Otherwise a Generated off-cycle batch is
// created; it is finalized / marked paid / voided / superseded exactly like a
// normal batch.
// ============================================================
async function generateOffCycleBatch(req, res) {
  const body = req.body || {};
  const workerId = Number(body.worker_id);
  const dryRun = body.dry_run === true;
  const reason = String(body.reason || '').trim();
  if (!Number.isInteger(workerId) || workerId <= 0) {
    return res.status(400).json({ success: false, message: 'Select the worker to pay.' });
  }
  if (!dryRun && reason.length < 5) {
    return res.status(400).json({ success: false, message: 'A reason (at least 5 characters) is required for an off-cycle payroll.' });
  }
  try {
    const [[worker]] = await pool.execute('SELECT worker_id FROM workers WHERE worker_id = ?', [workerId]);
    if (!worker) return res.status(404).json({ success: false, message: 'Worker not found.' });
  } catch (error) {
    console.error('generateOffCycleBatch:', error);
    return res.status(500).json({ success: false, message: 'Failed to load the worker.' });
  }
  req.body = { start_date: body.start_date, end_date: body.end_date };
  req._offcycle = { workerId, reason: reason.slice(0, 500), dryRun };
  return generatePayrollBatch(req, res);
}

// ============================================================
// GET /api/admin/payroll/offcycle/candidates?start_date&end_date&q
// Workers with attendance in the period, with how many records are approved
// / still pending and whether they are already covered by a payroll batch.
// Read-only; used by the off-cycle dialog.
// ============================================================
async function getOffCycleCandidates(req, res) {
  const { start_date, end_date } = req.query || {};
  if (!isValidDate(start_date) || !isValidDate(end_date) || end_date < start_date) {
    return res.status(400).json({ success: false, message: 'Choose a valid period first.' });
  }
  try {
    const params = [start_date, end_date];
    let where = '';
    const q = String(req.query.q || '').trim();
    if (q) { where = ' AND (w.full_name LIKE ? OR w.worker_unique_id LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    const [rows] = await pool.execute(
      `SELECT w.worker_id, w.full_name, w.worker_unique_id, w.status AS worker_status,
              SUM(a.status = 'Approved') AS approved,
              SUM(a.status IN ('Draft','Submitted','Rejected')) AS pending,
              DATE_FORMAT(MIN(a.record_date), '%Y-%m-%d') AS first_date,
              DATE_FORMAT(MAX(a.record_date), '%Y-%m-%d') AS last_date,
              GROUP_CONCAT(DISTINCT s.site_name ORDER BY s.site_name SEPARATOR ', ') AS sites
       FROM attendance a
       JOIN workers w ON w.worker_id = a.worker_id
       LEFT JOIN sites s ON s.site_id = a.site_id
       WHERE a.record_date BETWEEN ? AND ?${where}
       GROUP BY w.worker_id, w.full_name, w.worker_unique_id, w.status
       ORDER BY w.full_name
       LIMIT 100`,
      params
    );
    const ids = rows.map((r) => r.worker_id);
    const covered = new Map();
    if (ids.length) {
      const [off] = await pool.query(
        `SELECT payroll_batch_id, scope_worker_id FROM payrollbatches
         WHERE batch_type = 'OffCycle' AND status IN ${PAYROLL_LOCKING_STATUSES}
           AND start_date <= ? AND end_date >= ? AND scope_worker_id IN (?)`,
        [end_date, start_date, ids]
      );
      for (const o of off) covered.set(Number(o.scope_worker_id), o.payroll_batch_id);
    }
    const [regular] = await pool.execute(
      `SELECT payroll_batch_id, scope_site_id FROM payrollbatches
       WHERE batch_type = 'Regular' AND status IN ${PAYROLL_LOCKING_STATUSES}
         AND start_date <= ? AND end_date >= ?`,
      [end_date, start_date]
    );
    const regularAll = regular.find((r) => r.scope_site_id == null) || null;
    return res.json({
      success: true,
      data: rows.map((r) => ({
        worker_id: r.worker_id,
        full_name: r.full_name,
        worker_unique_id: r.worker_unique_id,
        worker_status: r.worker_status,
        approved: Number(r.approved || 0),
        pending: Number(r.pending || 0),
        first_date: r.first_date,
        last_date: r.last_date,
        sites: r.sites || '',
        offcycle_batch_id: covered.get(Number(r.worker_id)) || null,
      })),
      regular_batch_in_period: regularAll ? regularAll.payroll_batch_id : null,
    });
  } catch (error) {
    console.error('getOffCycleCandidates:', error);
    return res.status(500).json({ success: false, message: 'Failed to load workers for this period.' });
  }
}

module.exports = {
  generatePayrollBatch,
  finalizePayrollBatch,
  voidPayrollBatch,
  supersedeFinalizedBatch,
  getPayrollVersionChain,
  getPayrollReport,
  getPayrollBatchDetails,
  markBatchAsPaid,
  getLastBatchEndDate,
  exportPayrollExcel,
  exportPayrollPdf,           // ← جديد
  exportDailyAttendanceExcel,
  generateOffCycleBatch,
  getOffCycleCandidates,
};