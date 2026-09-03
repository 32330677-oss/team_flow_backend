const pool = require('../config/db');

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}
function isSpecificSite(value) {
  return value !== undefined && value !== null && !['', 'null', '0', 'All'].includes(String(value));
}
function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

// ============================================================
// Replace generatePayrollBatch entirely
// ============================================================

const settingsCache = require('../services/settingsCache'); // NEW: needed for the standard-hours fallback

const DEFAULT_STANDARD_MINUTES = 600; // fallback: 10 hours, matches system default

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}
function isSpecificSite(value) {
  return value !== undefined && value !== null && !['', 'null', '0', 'All'].includes(String(value));
}
function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

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

    // --- overlap check (unchanged) ---
    const overlapParams = [end_date, start_date];
    let overlapSql = `
      SELECT DISTINCT pb.payroll_batch_id
      FROM payrollbatches pb
      JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
      JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
      WHERE pb.start_date <= ? AND pb.end_date >= ?`;
    if (scopedSite) { overlapSql += ' AND pi.site_id = ?'; overlapParams.push(site_id); }
    overlapSql += ' LIMIT 1 FOR UPDATE';
    const [overlap] = await connection.execute(overlapSql, overlapParams);
    if (overlap.length) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'An overlapping payroll batch already exists for this scope.' });
    }

    // NOTE: added a.attendance_status + a.standard_minutes_snapshot.
    // We need these two to correctly prorate Daily-rate workers by actual
    // hours worked instead of paying a full day for any approved record.
    const attParams = [start_date, end_date];
    let attSql = `
      SELECT a.attendance_id, a.worker_id, w.full_name AS worker_name, w.payment_type,
             a.record_date, a.site_id, a.total_working_hours, a.overtime_hours,
             a.attendance_status, a.standard_minutes_snapshot,
             wsa.contract_id
      FROM attendance a
      JOIN workers w ON w.worker_id = a.worker_id AND w.status = 'Active'
      JOIN workersiteassignments wsa
        ON wsa.worker_id = a.worker_id
       AND wsa.site_id = a.site_id
       AND wsa.assigned_date <= a.record_date
       AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= a.record_date)
      WHERE a.record_date BETWEEN ? AND ?
        AND a.status = 'Approved'`;
    if (scopedSite) { attSql += ' AND a.site_id = ?'; attParams.push(site_id); }
    attSql += ' ORDER BY w.full_name, a.record_date';

    const [attendanceRows] = await connection.execute(attSql, attParams);

    if (!attendanceRows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'No Approved attendance found for this period.' });
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

    // Fallback standard minutes used only when a record has no snapshot
    // (very old records created before this tracking existed).
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

      const groupKey = comp.payment_type === 'Daily'
        ? `${rec.worker_id}|${rec.site_id}|Daily|${comp.daily_rate}`
        : `${rec.worker_id}|${rec.site_id}|Hourly|${comp.regular_hourly_rate}|${comp.overtime_hourly_rate}`;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          worker_id: rec.worker_id,
          site_id: rec.site_id,
          contract_id: rec.contract_id,
          pay_type: comp.payment_type,
          daily_rate: comp.daily_rate,
          regular_hourly_rate: comp.regular_hourly_rate,
          overtime_hourly_rate: comp.overtime_hourly_rate,
          days_worked: 0,     // now stores PAID day-equivalents (can be fractional, e.g. 0.5)
          regular_hours: 0,
          overtime_hours: 0,
        });
      }
      const g = groups.get(groupKey);

      if (comp.payment_type === 'Daily') {
        // ============ THE ACTUAL FIX ============
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
        // =========================================
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
      let overtimePay = 0;

      if (g.pay_type === 'Daily') {
        if (!Number.isFinite(Number(g.daily_rate)) || Number(g.daily_rate) <= 0) {
          throw new Error(`Invalid daily_rate for worker ${g.worker_id}`);
        }
        baseSalary = money(g.days_worked * Number(g.daily_rate));
        overtimePay = 0; // Daily workers never get overtime pay
      } else {
        const regularRate = Number(g.regular_hourly_rate);
        const overtimeRate = Number(g.overtime_hourly_rate);
        if (!Number.isFinite(regularRate) || regularRate <= 0 || !Number.isFinite(overtimeRate) || overtimeRate <= 0) {
          throw new Error(`Invalid hourly rates for worker ${g.worker_id}`);
        }
        baseSalary = money(g.regular_hours * regularRate);
        overtimePay = money(g.overtime_hours * overtimeRate);
      }

      if (baseSalary === 0 && overtimePay === 0) continue;

      const worker = byWorker.get(g.worker_id);
      worker.breakdown.push({
        siteId: g.site_id,
        contractId: g.contract_id,
        payType: g.pay_type,
        dailyRate: g.daily_rate,
        hourlyRate: g.regular_hourly_rate,
        overtimeRate: g.overtime_hourly_rate,
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

    const [batchResult] = await connection.execute(
      `INSERT INTO payrollbatches (start_date, end_date, generated_by_user_id, status)
       VALUES (?, ?, ?, 'Generated')`,
      [start_date, end_date, userId]
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
            !isDaily ? item.overtimeRate : null,
            isDaily ? item.dailyRate : null,
            isDaily ? item.daysWorked : null, // الآن رقم عشري ممكن (0.5 مثلاً)
            !isDaily ? item.regularHours : null,
            !isDaily ? item.overtimeHours : null,
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
    return res.status(201).json({ success: true, message: 'Payroll generated successfully.', batch_id: batchId });
  } catch (error) {
    await connection.rollback();
    console.error('generatePayrollBatch:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to generate payroll.' });
  } finally {
    connection.release();
  }
}

async function getPayrollReport(req, res) {
  try {
    const { site_id } = req.query;
    const scoped = isSpecificSite(site_id);
    const params = [];
    let sql;

    if (scoped) {
      sql = `
        SELECT pb.payroll_batch_id, pb.start_date, pb.end_date, pb.status, pb.generated_at,
               u.full_name AS generated_by,
               COUNT(DISTINCT p.worker_id) AS total_workers,
               COALESCE(SUM(pi.base_salary + pi.overtime_pay), 0) AS total_amount
        FROM payrollbatches pb
        JOIN users u ON u.user_id = pb.generated_by_user_id
        JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
        JOIN payrollitems pi ON pi.payroll_id = p.payroll_id AND pi.site_id = ?
        GROUP BY pb.payroll_batch_id, pb.start_date, pb.end_date, pb.status, pb.generated_at, u.full_name
        ORDER BY pb.generated_at DESC`;
      params.push(site_id);
    } else {
      sql = `
        SELECT pb.payroll_batch_id, pb.start_date, pb.end_date,
               pb.total_workers, pb.total_amount, pb.status, pb.generated_at,
               u.full_name AS generated_by
        FROM payrollbatches pb
        JOIN users u ON u.user_id = pb.generated_by_user_id
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
// getPayrollBatchDetails — now returns pay_type per site row (section 8)
// ============================================================
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

    // Overall pay_type for the worker for this batch (use first item's type;
    // in the rare case of a mid-period rate/type change, sites[] shows detail)
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
        overtime_rate: sites[0]?.overtime_hourly_rate_snapshot ?? null,
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
    const [batches] = await connection.execute('SELECT status FROM payrollbatches WHERE payroll_batch_id = ? FOR UPDATE', [batchId]);
    if (!batches.length) { await connection.rollback(); return res.status(404).json({ success: false, message: 'Batch not found.' }); }
    if (batches[0].status === 'Paid') { await connection.rollback(); return res.status(409).json({ success: false, message: 'Batch is already paid.' }); }
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
    let sql = `SELECT MAX(pb.end_date) AS last_end_date FROM payrollbatches pb`;
    if (isSpecificSite(site_id)) {
      sql += `
        JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
        JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
        WHERE pi.site_id = ?`;
      params.push(site_id);
    }
    const [rows] = await pool.execute(sql, params);
    return res.json({ success: true, last_end_date: rows[0]?.last_end_date || null });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load the last batch date.' });
  }
}

// ============================================================
// exportPayrollExcel — branch columns by pay_type (section 9)
// ============================================================
async function exportPayrollExcel(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid batch id.' });
  }

  try {
    const ExcelJS = require('exceljs');
    const [batches] = await pool.execute(
      `SELECT payroll_batch_id, start_date, end_date, total_workers, total_amount, status
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

    // Unified column set that covers both types; irrelevant cells stay blank per row (section 9: never show misleading values)
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
    sheet.getCell('A1').value = `Payroll Batch #${batchId}`;
    sheet.mergeCells('A2:M2');
    sheet.getCell('A2').value = `Period: ${dateOnly(batch.start_date)} - ${dateOnly(batch.end_date)}`;
    sheet.mergeCells('A3:M3');
    sheet.getCell('A3').value = 'Currency: Syrian Pound (ل.س)';
    sheet.getRow(5).values = sheet.columns.map((c) => c.header);

    let totalBase = 0, totalOT = 0, totalNet = 0;

    rows.forEach((item, index) => {
      const isDaily = item.pay_type === 'Daily';
      const rowData = {
        number: index + 1,
        worker_name: item.worker_name,
        site_name: item.site_name || '',
        pay_type: item.pay_type,
        base_salary: Number(item.base_salary || 0),
        overtime_pay: Number(item.overtime_pay || 0),
        net_salary: Number(item.net_salary || 0),
      };
      if (isDaily) {
        rowData.days_worked = item.days_worked;
        rowData.daily_rate = Number(item.daily_rate_snapshot || 0);
        // regular/overtime hour columns intentionally left blank for Daily rows
      } else {
        rowData.regular_hours = Number(item.regular_hours_worked || 0);
        rowData.overtime_hours = Number(item.overtime_hours_worked || 0);
        rowData.regular_rate = Number(item.hourly_rate_snapshot || 0);
        rowData.overtime_rate = Number(item.overtime_hourly_rate_snapshot || 0);
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

    // =========================================================
    // LOGO
    // =========================================================

    // ضع ملف اللوغو هنا:
    // backend/assets/logo.png
    const logoPath = path.join(__dirname, '../assets//logo.png');

    const logoId = workbook.addImage({
      filename: logoPath,
      extension: 'png',
    });

    // اللوغو أعلى التقرير
    sheet.addImage(logoId, {
      tl: { col: 0.2, row: 0.15 },
      ext: { width: 150, height: 60 },
    });

    // =========================================================
    // COLUMNS
    // =========================================================

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
      {
        header: 'Management Leave Hours',
        key: 'management_leave_hours',
        width: 24,
      },
      { header: 'Remarks', key: 'remarks', width: 36 },
    ];

    // =========================================================
    // REPORT HEADER
    // =========================================================

    sheet.mergeCells('A1:L1');
    sheet.getCell('A1').value = `Daily Attendance Report - ${date}`;

    sheet.mergeCells('A2:L2');
    sheet.getCell('A2').value =
        'Attendance and hours only — no salary or rate calculation';

    // مساحة للوغو في الأعلى
    sheet.getRow(1).height = 48;
    sheet.getRow(2).height = 24;

    // =========================================================
    // TABLE HEADER
    // =========================================================

    sheet.getRow(4).values = sheet.columns.map(
      (column) => column.header
    );

    // =========================================================
    // DATA
    // =========================================================

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
        management_leave_hours: Number(
          row.management_leave_hours || 0
        ),
        remarks: row.remarks || '',
      });
    });

    // =========================================================
    // STYLING
    // =========================================================

    sheet.getRow(1).font = {
      bold: true,
      size: 16,
      color: { argb: 'FFFFFFFF' },
    };

    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1A2A6C' },
    };

    sheet.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center',
    };

    sheet.getRow(2).font = {
      italic: true,
      color: { argb: 'FF555555' },
    };

    sheet.getRow(2).alignment = {
      vertical: 'middle',
      horizontal: 'center',
    };

    sheet.getRow(4).font = {
      bold: true,
      color: { argb: 'FFFFFFFF' },
    };

    sheet.getRow(4).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1A2A6C' },
    };

    sheet.getRow(4).alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true,
    };

    // =========================================================
    // FORMAT HOURS
    // =========================================================

    for (let rowIndex = 5; rowIndex <= sheet.rowCount; rowIndex++) {
      sheet.getCell(`I${rowIndex}`).numFmt = '0.00';
      sheet.getCell(`J${rowIndex}`).numFmt = '0.00';
      sheet.getCell(`K${rowIndex}`).numFmt = '0.00';
    }

    // =========================================================
    // FREEZE + FILTER
    // =========================================================

    sheet.views = [
      {
        state: 'frozen',
        ySplit: 4,
      },
    ];

    sheet.autoFilter = {
      from: 'A4',
      to: 'L4',
    };

    // =========================================================
    // EXPORT
    // =========================================================

    const fileName = `daily_attendance_${date}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('exportDailyAttendanceExcel:', error);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: 'Failed to export daily attendance report.',
      });
    }
  }
}

module.exports = {
  generatePayrollBatch,
  getPayrollReport,
  getPayrollBatchDetails,
  markBatchAsPaid,
  getLastBatchEndDate,
  exportPayrollExcel,
  exportDailyAttendanceExcel,
};