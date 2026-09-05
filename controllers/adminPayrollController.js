const pool = require('../config/db');
const settingsCache = require('../services/settingsCache');

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}
function isSpecificSite(value) {
  return value !== undefined && value !== null && !['', 'null', '0', 'All'].includes(String(value));
}
function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

const DEFAULT_STANDARD_MINUTES = 600; // fallback: 10 hours, matches system default

// ============================================================
// UNIFIED OVERTIME POLICY
// Overtime is paid at a single fixed company-wide rate for EVERY worker,
// regardless of pay type (Daily or Hourly) and regardless of that worker's
// own overtime_hourly_rate in workercompensationhistory. That per-worker
// rate is still kept/snapshotted for historical/reporting reasons, but it
// no longer drives the actual overtime payment — only this constant does.
//
// Attendance already computes overtime_hours correctly for both pay types
// (see services/attendanceService.js -> calculateWorkingHours): if a Lunch
// leave record was NOT created for a shift (worker worked through lunch),
// that hour is never subtracted from total_working_hours, so it naturally
// pushes the worker past standard_minutes_snapshot and becomes overtime.
// That logic is unchanged and correct — the gap was purely in how payroll
// generation used to IGNORE overtime_hours entirely for Daily workers.
// ============================================================
const OVERTIME_FLAT_RATE_SYP = 150;

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
// ============================================================
async function generatePayrollBatch(req, res) {
  const { start_date, end_date, site_id } = req.body || {};
  const userId = req.user?.user_id;

  if (!userId) return res.status(401).json({ success: false, message: 'Admin identification not found.' });
  if (!isValidDate(start_date) || !isValidDate(end_date)) {
    return res.status(400).json({ success: false, message: 'Dates must use YYYY-MM-DD.' });
  }
  if (end_date < start_date) {
    return res.status(400).json({ success: false, message: 'End date must be after or equal to start date.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const scopedSite = isSpecificSite(site_id);
    const scopeSiteId = scopedSite ? Number(site_id) : null;

    // --- find any active batch(es) for this exact period + scope ---
    const [existingBatches] = await connection.execute(
      `SELECT payroll_batch_id, version_number, is_finalized, status
       FROM payrollbatches
       WHERE start_date = ? AND end_date = ?
         AND status <> 'Superseded'
         AND scope_site_id <=> ?
       ORDER BY version_number DESC
       FOR UPDATE`,
      [start_date, end_date, scopeSiteId]
    );

    if (existingBatches.length) {
      const finalizedBlocking = existingBatches.find((b) => b.is_finalized);
      if (finalizedBlocking) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message: `This period is already finalized by management (Batch #${finalizedBlocking.payroll_batch_id}) and can no longer be regenerated.`
        });
      }
    }

    const attParams = [start_date, end_date];
    let attSql = `
      SELECT a.attendance_id, a.worker_id, w.full_name AS worker_name, w.payment_type,
             a.record_date, a.site_id, a.total_working_hours, a.overtime_hours,
             a.attendance_status, a.standard_minutes_snapshot,
             (
               SELECT wsa2.contract_id
               FROM workersiteassignments wsa2
               WHERE wsa2.worker_id = a.worker_id
                 AND wsa2.site_id = a.site_id
                 AND wsa2.assigned_date <= a.record_date
                 AND (wsa2.unassigned_date IS NULL OR wsa2.unassigned_date > a.record_date)
               ORDER BY wsa2.assigned_date DESC, wsa2.assignment_id DESC
               LIMIT 1
             ) AS contract_id
      FROM attendance a
      JOIN workers w ON w.worker_id = a.worker_id
      WHERE a.record_date BETWEEN ? AND ?
        AND a.status = 'Approved'`;
    if (scopedSite) { attSql += ' AND a.site_id = ?'; attParams.push(site_id); }
    attSql += ' ORDER BY w.full_name, a.record_date';

    const [attendanceRows] = await connection.execute(attSql, attParams);

    if (!attendanceRows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'No Approved attendance found for this period.' });
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

    const fallbackStandardMinutes =
      Number(await settingsCache.getSetting('standard_work_minutes', String(DEFAULT_STANDARD_MINUTES))) ||
      DEFAULT_STANDARD_MINUTES;

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
      // always paid at OVERTIME_FLAT_RATE_SYP regardless of that field.
      const groupKey = comp.payment_type === 'Daily'
        ? `${rec.worker_id}|${rec.site_id}|Daily|${comp.daily_rate}`
        : `${rec.worker_id}|${rec.site_id}|Hourly|${comp.regular_hourly_rate}`;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          worker_id: rec.worker_id,
          site_id: rec.site_id,
          contract_id: rec.contract_id,
          pay_type: comp.payment_type,
          daily_rate: comp.daily_rate,
          regular_hourly_rate: comp.regular_hourly_rate,
          days_worked: 0,     // PAID day-equivalents (fractional, e.g. 0.5)
          regular_hours: 0,
          overtime_hours: 0,  // now tracked for BOTH pay types
        });
      }
      const g = groups.get(groupKey);

      if (comp.payment_type === 'Daily') {
        let dayFraction;
        if (rec.attendance_status === 'Absent') {
          dayFraction = 0;
        } else if (['Sick', 'Vacation', 'Holiday'].includes(rec.attendance_status)) {
          dayFraction = 0;
        } else {
          const standardMinutes = Number(rec.standard_minutes_snapshot) > 0
            ? Number(rec.standard_minutes_snapshot)
            : fallbackStandardMinutes;

          const standardHours = standardMinutes / 60;
          const workedHours = Number(rec.total_working_hours || 0);

          dayFraction = standardHours > 0
            ? Math.min(1, workedHours / standardHours)
            : 0;
        }

        g.days_worked += dayFraction;
        // Daily workers ARE eligible for overtime now: attendance already
        // computes overtime_hours whenever worked hours exceed the standard
        // (e.g. worked through lunch -> 11h shift with a 10h standard -> 1h OT).
        g.overtime_hours += Number(rec.overtime_hours || 0);
      } else {
        g.regular_hours += Number(rec.total_working_hours || 0);
        g.overtime_hours += Number(rec.overtime_hours || 0);
      }

      if (!byWorker.has(rec.worker_id)) {
        byWorker.set(rec.worker_id, { worker_id: rec.worker_id, breakdown: [], gross: 0 });
      }
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
      const overtimePay = money(g.overtime_hours * OVERTIME_FLAT_RATE_SYP);

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
        baseSalary,
        overtimePay,
      });
      worker.gross = money(worker.gross + baseSalary + overtimePay);
    }

    for (const [workerId, worker] of [...byWorker.entries()]) {
      if (worker.breakdown.length === 0) byWorker.delete(workerId);
    }
    if (!byWorker.size) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'No payable attendance found for this period.' });
    }

    // --- everything validated and computed: now supersede the old batch(es)
    //     for this exact period+scope and insert the new version ---
    let supersedesId = null;
    let nextVersion = 1;
    if (existingBatches.length) {
      const latest = existingBatches[0]; // ORDER BY version_number DESC
      supersedesId = latest.payroll_batch_id;
      nextVersion = latest.version_number + 1;
      for (const old of existingBatches) {
        await connection.execute(
          `UPDATE payrollbatches SET status = 'Superseded' WHERE payroll_batch_id = ?`,
          [old.payroll_batch_id]
        );
        await connection.execute(
          `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
           VALUES ('payrollbatches', ?, 'SUPERSEDED', ?, ?, ?)`,
          [old.payroll_batch_id, userId, JSON.stringify({ status: old.status }), JSON.stringify({ status: 'Superseded' })]
        );
      }
    }

    const [batchResult] = await connection.execute(
      `INSERT INTO payrollbatches
         (start_date, end_date, generated_by_user_id, status, scope_site_id, version_number, supersedes_batch_id)
       VALUES (?, ?, ?, 'Generated', ?, ?, ?)`,
      [start_date, end_date, userId, scopeSiteId, nextVersion, supersedesId]
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
        await connection.execute(
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
            item.overtimeHours > 0 ? OVERTIME_FLAT_RATE_SYP : null,
            isDaily ? item.dailyRate : null,
            isDaily ? item.daysWorked : null,
            !isDaily ? item.regularHours : null,
            item.overtimeHours, // now stored for Daily rows too
            item.baseSalary,
            item.overtimePay
          ]
        );
      }
      totalWorkers += 1;
      totalAmount = money(totalAmount + worker.gross);
    }

    await connection.execute(
      `UPDATE payrollbatches SET total_workers = ?, total_amount = ? WHERE payroll_batch_id = ?`,
      [totalWorkers, totalAmount, batchId]
    );
    await connection.commit();

    return res.status(201).json({
      success: true,
      message: supersedesId
        ? `Payroll generated successfully (version ${nextVersion}). Previous version (Batch #${supersedesId}) has been superseded.`
        : 'Payroll generated successfully.',
      batch_id: batchId,
      version_number: nextVersion,
      supersedes_batch_id: supersedesId
    });
  } catch (error) {
    await connection.rollback();
    console.error('generatePayrollBatch:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate payroll.' });
  } finally {
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
    if (batch.status === 'Superseded') {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'A superseded batch cannot be finalized.' });
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
      message: 'Payroll batch finalized. This period is now locked and can no longer be regenerated. It can now be marked as paid.'
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
       ORDER BY pb.version_number ASC`,
      [anchor.start_date, anchor.end_date, anchor.scope_site_id]
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

    // Superseded versions are hidden from the main list — use
    // GET /batch/:batchId/versions to inspect the full history of a period.
    if (scoped) {
      sql = `
        SELECT pb.payroll_batch_id, pb.start_date, pb.end_date, pb.status, pb.generated_at,
               pb.version_number, pb.is_finalized, pb.finalized_at,
               u.full_name AS generated_by,
               COUNT(DISTINCT p.worker_id) AS total_workers,
               COALESCE(SUM(pi.base_salary + pi.overtime_pay), 0) AS total_amount
        FROM payrollbatches pb
        JOIN users u ON u.user_id = pb.generated_by_user_id
        JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
        JOIN payrollitems pi ON pi.payroll_id = p.payroll_id AND pi.site_id = ?
        WHERE pb.status <> 'Superseded'
        GROUP BY pb.payroll_batch_id, pb.start_date, pb.end_date, pb.status, pb.generated_at,
                 pb.version_number, pb.is_finalized, pb.finalized_at, u.full_name
        ORDER BY pb.generated_at DESC`;
      params.push(site_id);
    } else {
      sql = `
        SELECT pb.payroll_batch_id, pb.start_date, pb.end_date,
               pb.total_workers, pb.total_amount, pb.status, pb.generated_at,
               pb.version_number, pb.is_finalized, pb.finalized_at,
               u.full_name AS generated_by
        FROM payrollbatches pb
        JOIN users u ON u.user_id = pb.generated_by_user_id
        WHERE pb.status <> 'Superseded'
        ORDER BY pb.generated_at DESC`;
    }

    const [rows] = await pool.execute(sql, params);
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('getPayrollReport:', error);
    return res.status(500).json({ success: false, message: 'Failed to load payroll reports.' });
  }
}

async function getPayrollBatchDetails(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  try {
    const [batches] = await pool.execute('SELECT * FROM payrollbatches WHERE payroll_batch_id = ?', [batchId]);
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
      `SELECT pi.payroll_id, pi.site_id, s.site_name, pi.pay_type,
              pi.regular_hours_worked, pi.overtime_hours_worked,
              pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot,
              pi.daily_rate_snapshot, pi.days_worked,
              pi.base_salary, pi.overtime_pay
       FROM payroll p
       JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
       LEFT JOIN sites s ON s.site_id = pi.site_id
       WHERE p.payroll_batch_id = ?
       ORDER BY s.site_name`,
      [batchId]
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
        days_worked: sites.reduce((sum, s) => sum + (s.days_worked || 0), 0),
        regular_hours_worked: sites.reduce((sum, s) => sum + Number(s.regular_hours_worked || 0), 0),
        overtime_hours_worked: sites.reduce((sum, s) => sum + Number(s.overtime_hours_worked || 0), 0),
        daily_rate: sites[0]?.daily_rate_snapshot ?? null,
        regular_rate: sites[0]?.hourly_rate_snapshot ?? null,
        overtime_rate: OVERTIME_FLAT_RATE_SYP,
        sites,
      };
    });

    return res.json({ success: true, batch: batches[0], workers });
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
    if (batches[0].status === 'Superseded') { await connection.rollback(); return res.status(409).json({ success: false, message: 'A superseded batch cannot be marked as paid.' }); }
    if (batches[0].status === 'Paid') { await connection.rollback(); return res.status(409).json({ success: false, message: 'Batch is already paid.' }); }
    if (!batches[0].is_finalized) { await connection.rollback(); return res.status(409).json({ success: false, message: 'Finalize this payroll batch (management approval) before marking it as paid.' }); }

    await connection.execute(`UPDATE payrollbatches SET status = 'Paid' WHERE payroll_batch_id = ?`, [batchId]);
    await connection.execute(`UPDATE payroll SET status = 'Paid', paid_date = CURDATE() WHERE payroll_batch_id = ?`, [batchId]);
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

async function getLastBatchEndDate(req, res) {
  try {
    const { site_id } = req.query || {};
    const params = [];
    let sql = `SELECT MAX(pb.end_date) AS last_end_date FROM payrollbatches pb WHERE pb.status <> 'Superseded'`;
    if (isSpecificSite(site_id)) {
      sql = `SELECT MAX(pb.end_date) AS last_end_date
             FROM payrollbatches pb
             JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
             JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
             WHERE pb.status <> 'Superseded' AND pi.site_id = ?`;
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
    const [batches] = await pool.execute(
      `SELECT payroll_batch_id, start_date, end_date, total_workers, total_amount, status,
              version_number, is_finalized
       FROM payrollbatches WHERE payroll_batch_id = ?`,
      [batchId]
    );
    if (!batches.length) return res.status(404).json({ success: false, message: 'Batch not found.' });

    const [rows] = await pool.execute(
      `SELECT w.full_name AS worker_name, s.site_name, pi.pay_type,
              pi.regular_hours_worked, pi.overtime_hours_worked,
              pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot,
              pi.daily_rate_snapshot, pi.days_worked,
              pi.base_salary, pi.overtime_pay, p.net_salary
       FROM payroll p
       JOIN workers w ON w.worker_id = p.worker_id
       JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
       LEFT JOIN sites s ON s.site_id = pi.site_id
       WHERE p.payroll_batch_id = ?
       ORDER BY w.full_name, s.site_name`,
      [batchId]
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Payroll');
    const batch = batches[0];
    const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

    sheet.columns = [
      { header: 'No.', key: 'number', width: 6 },
      { header: 'Worker Name', key: 'worker_name', width: 28 },
      { header: 'Site', key: 'site_name', width: 20 },
      { header: 'Payment Type', key: 'pay_type', width: 14 },
      { header: 'Days Worked', key: 'days_worked', width: 12 },
      { header: 'Daily Rate', key: 'daily_rate', width: 14 },
      { header: 'Regular Hours', key: 'regular_hours', width: 14 },
      { header: 'Overtime Hours', key: 'overtime_hours', width: 14 },
      { header: 'Regular Rate', key: 'regular_rate', width: 14 },
      { header: 'Overtime Rate', key: 'overtime_rate', width: 14 },
      { header: 'Base Salary', key: 'base_salary', width: 16 },
      { header: 'Overtime Pay', key: 'overtime_pay', width: 16 },
      { header: 'Net Salary', key: 'net_salary', width: 16 },
    ];

    sheet.mergeCells('A1:M1');
    sheet.getCell('A1').value = `Payroll Batch #${batchId} (v${batch.version_number}${batch.is_finalized ? ' - Finalized' : ''})`;
    sheet.mergeCells('A2:M2');
    sheet.getCell('A2').value = `Period: ${dateOnly(batch.start_date)} - ${dateOnly(batch.end_date)}`;
    sheet.mergeCells('A3:M3');
    sheet.getCell('A3').value = `Currency: Syrian Pound (ل.س) — Overtime rate: ${OVERTIME_FLAT_RATE_SYP} ل.س/hour (flat, all workers)`;
    sheet.getRow(5).values = sheet.columns.map((c) => c.header);

    let totalBase = 0, totalOT = 0, totalNet = 0;

    rows.forEach((item, index) => {
      const isDaily = item.pay_type === 'Daily';
      const rowData = {
        number: index + 1,
        worker_name: item.worker_name,
        site_name: item.site_name || '',
        pay_type: item.pay_type,
        overtime_hours: Number(item.overtime_hours_worked || 0),
        overtime_rate: Number(item.overtime_hourly_rate_snapshot || 0),
        base_salary: Number(item.base_salary || 0),
        overtime_pay: Number(item.overtime_pay || 0),
        net_salary: Number(item.net_salary || 0),
      };
      if (isDaily) {
        rowData.days_worked = item.days_worked;
        rowData.daily_rate = Number(item.daily_rate_snapshot || 0);
        // regular hours / regular rate intentionally left blank for Daily rows
      } else {
        rowData.regular_hours = Number(item.regular_hours_worked || 0);
        rowData.regular_rate = Number(item.hourly_rate_snapshot || 0);
        // days_worked / daily_rate intentionally left blank for Hourly rows
      }
      sheet.addRow(rowData);

      totalBase += rowData.base_salary;
      totalOT += rowData.overtime_pay;
      totalNet += rowData.net_salary;
    });

    const totalRow = sheet.addRow({
      worker_name: 'TOTAL',
      base_salary: Math.round(totalBase * 100) / 100,
      overtime_pay: Math.round(totalOT * 100) / 100,
      net_salary: Math.round(totalNet * 100) / 100,
    });

    sheet.getRow(1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    sheet.getRow(5).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    totalRow.font = { bold: true };
    for (let row = 6; row <= sheet.rowCount; row += 1) {
      for (const col of [6, 9, 10, 11, 12, 13]) {
        sheet.getCell(row, col).numFmt = '#,##0 "ل.س"';
      }
    }

    const fileName = `payroll_batch_${batchId}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('exportPayrollExcel:', error);
    if (!res.headersSent) return res.status(500).json({ success: false, message: 'Failed to export Excel payroll report.' });
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
      `SELECT a.record_date, w.worker_unique_id, w.full_name AS worker_name,
              s.site_name, a.attendance_status, a.status AS workflow_status,
              a.check_in_time, a.check_out_time, a.total_working_hours,
              a.overtime_hours, a.management_leave_hours, a.remarks,
              a.admin_rejection_notes
       FROM attendance a
       JOIN workers w ON w.worker_id = a.worker_id
       JOIN sites s ON s.site_id = a.site_id
       WHERE a.record_date = ?${siteFilter}
       ORDER BY s.site_name, w.full_name`,
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

module.exports = {
  generatePayrollBatch,
  finalizePayrollBatch,
  getPayrollVersionChain,
  getPayrollReport,
  getPayrollBatchDetails,
  markBatchAsPaid,
  getLastBatchEndDate,
  exportPayrollExcel,
  exportDailyAttendanceExcel,
};