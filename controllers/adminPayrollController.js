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

    const [overlap] = await connection.execute(
      `SELECT payroll_batch_id FROM payrollbatches
       WHERE start_date <= ? AND end_date >= ?
       LIMIT 1 FOR UPDATE`,
      [end_date, start_date]
    );
    if (overlap.length) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'An overlapping payroll batch already exists.' });
    }

    const siteFilter = scopedSite ? ' AND wsa.site_id = ?' : '';
    const workerParams = scopedSite ? [end_date, start_date, site_id] : [end_date, start_date];
    const [workers] = await connection.execute(
      `SELECT DISTINCT w.worker_id, w.full_name
       FROM workers w
       JOIN workersiteassignments wsa ON wsa.worker_id = w.worker_id
         AND wsa.assigned_date <= ?
         AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)
       WHERE w.status = 'Active'${siteFilter}
       ORDER BY w.full_name`,
      workerParams
    );
    if (!workers.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'No active assigned workers found.' });
    }

    const [batchResult] = await connection.execute(
      `INSERT INTO payrollbatches (start_date, end_date, generated_by_user_id, status)
       VALUES (?, ?, ?, 'Generated')`,
      [start_date, end_date, userId]
    );
    const batchId = batchResult.insertId;
    let totalWorkers = 0;
    let totalAmount = 0;

    for (const worker of workers) {
      const assignmentParams = [worker.worker_id, end_date, start_date];
      let assignmentSql = `
        SELECT wsa.site_id, wsa.contract_id, c.hourly_rate, c.overtime_hourly_rate
        FROM workersiteassignments wsa
        JOIN contracts c ON c.contract_id = wsa.contract_id
        WHERE wsa.worker_id = ?
          AND wsa.assigned_date <= ?
          AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)`;
      if (scopedSite) {
        assignmentSql += ' AND wsa.site_id = ?';
        assignmentParams.push(site_id);
      }
      const [assignments] = await connection.execute(assignmentSql, assignmentParams);
      if (!assignments.length) continue;

      const ratesBySite = new Map(assignments.map((row) => [Number(row.site_id), row]));
      const attendanceParams = [worker.worker_id, start_date, end_date];
      let attendanceSql = `
        SELECT site_id,
               COALESCE(SUM(total_working_hours), 0) AS regular_hours,
               COALESCE(SUM(overtime_hours), 0) AS overtime_hours
        FROM attendance
        WHERE worker_id = ? AND record_date BETWEEN ? AND ? AND status = 'Approved'`;
      if (scopedSite) {
        attendanceSql += ' AND site_id = ?';
        attendanceParams.push(site_id);
      }
      attendanceSql += ' GROUP BY site_id';
      const [logs] = await connection.execute(attendanceSql, attendanceParams);
      if (!logs.length) continue;

      const breakdown = [];
      let workerGross = 0;
      for (const log of logs) {
        const siteId = Number(log.site_id);
        const rates = ratesBySite.get(siteId);
        if (!rates) continue;
        const regularHours = Math.max(0, Number(log.regular_hours || 0));
        const overtimeHours = Math.max(0, Number(log.overtime_hours || 0));
        const hourlyRate = Number(rates.hourly_rate);
        const overtimeRate = Number(rates.overtime_hourly_rate);
        if (!Number.isFinite(hourlyRate) || hourlyRate < 0 || !Number.isFinite(overtimeRate) || overtimeRate < 0) {
          throw new Error(`Invalid rates for contract ${rates.contract_id}`);
        }
        const baseSalary = money(regularHours * hourlyRate);
        const overtimePay = money(overtimeHours * overtimeRate);
        if (regularHours === 0 && overtimeHours === 0) continue;
        breakdown.push({ siteId, contractId: rates.contract_id, regularHours, overtimeHours, hourlyRate, overtimeRate, baseSalary, overtimePay });
        workerGross = money(workerGross + baseSalary + overtimePay);
      }
      if (!breakdown.length) continue;

      const [payrollResult] = await connection.execute(
        `INSERT INTO payroll
          (payroll_batch_id, worker_id, start_date, end_date,
           bonus_amount, penalty_amount, deductions_amount,
           gross_salary, net_salary, status, generated_by_user_id)
         VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, 'Generated', ?)`,
        [batchId, worker.worker_id, start_date, end_date, workerGross, workerGross, userId]
      );
      const payrollId = payrollResult.insertId;

      for (const item of breakdown) {
        await connection.execute(
          `INSERT INTO payrollitems
            (payroll_id, contract_id, site_id, hourly_rate_snapshot,
             overtime_hourly_rate_snapshot, regular_hours_worked,
             overtime_hours_worked, base_salary, overtime_pay)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [payrollId, item.contractId, item.siteId, item.hourlyRate, item.overtimeRate,
            item.regularHours, item.overtimeHours, item.baseSalary, item.overtimePay]
        );
      }
      totalWorkers += 1;
      totalAmount = money(totalAmount + workerGross);
    }

    if (!totalWorkers) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'No Approved attendance found for this period.' });
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
    return res.status(500).json({ success: false, message: 'Failed to generate payroll.' });
  } finally {
    connection.release();
  }
}

async function getPayrollReport(req, res) {
  try {
    const { site_id } = req.query;
    const params = [];
    let sql = `SELECT DISTINCT pb.payroll_batch_id, pb.start_date, pb.end_date,
      pb.total_workers, pb.total_amount, pb.status, pb.generated_at,
      u.full_name AS generated_by
      FROM payrollbatches pb JOIN users u ON u.user_id = pb.generated_by_user_id`;
    if (isSpecificSite(site_id)) {
      sql += ` JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
               JOIN payrollitems pi ON pi.payroll_id = p.payroll_id AND pi.site_id = ?`;
      params.push(site_id);
    }
    sql += ' ORDER BY pb.generated_at DESC';
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
    const [items] = await pool.execute(
      `SELECT p.payroll_id, p.gross_salary, p.net_salary,
              p.bonus_amount, p.penalty_amount, p.deductions_amount,
              w.worker_id, w.full_name AS worker_name,
              pi.site_id, s.site_name, pi.regular_hours_worked,
              pi.overtime_hours_worked, pi.hourly_rate_snapshot,
              pi.overtime_hourly_rate_snapshot, pi.base_salary, pi.overtime_pay
       FROM payroll p JOIN workers w ON w.worker_id = p.worker_id
       JOIN payrollitems pi ON pi.payroll_id = p.payroll_id
       LEFT JOIN sites s ON s.site_id = pi.site_id
       WHERE p.payroll_batch_id = ? ORDER BY w.full_name, pi.site_id`,
      [batchId]
    );
    return res.json({ success: true, batch: batches[0], workers: items });
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
    if (!batches.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Batch not found.' });
    }
    if (batches[0].status === 'Paid') {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'Batch is already paid.' });
    }
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
    const [rows] = await pool.execute('SELECT end_date FROM payrollbatches ORDER BY end_date DESC LIMIT 1');
    return res.json({ success: true, last_end_date: rows[0]?.end_date || null });
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
      `SELECT payroll_batch_id, start_date, end_date,
              total_workers, total_amount, status
       FROM payrollbatches
       WHERE payroll_batch_id = ?`,
      [batchId]
    );
    if (!batches.length) {
      return res.status(404).json({ success: false, message: 'Batch not found.' });
    }

    const [rows] = await pool.execute(
      `SELECT w.full_name AS worker_name,
              s.site_name,
              pi.regular_hours_worked,
              pi.overtime_hours_worked,
              pi.hourly_rate_snapshot,
              pi.overtime_hourly_rate_snapshot,
              pi.base_salary,
              pi.overtime_pay,
              p.net_salary
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
    const dateOnly = (value) => {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value || '').slice(0, 10);
    };

    sheet.columns = [
      { header: 'No.', key: 'number', width: 8 },
      { header: 'Worker Name', key: 'worker_name', width: 28 },
      { header: 'Site', key: 'site_name', width: 22 },
      { header: 'Regular Hours', key: 'regular_hours', width: 16 },
      { header: 'Overtime Hours', key: 'overtime_hours', width: 16 },
      { header: 'Regular Rate', key: 'regular_rate', width: 16 },
      { header: 'Overtime Rate', key: 'overtime_rate', width: 16 },
      { header: 'Regular Pay', key: 'regular_pay', width: 16 },
      { header: 'Overtime Pay', key: 'overtime_pay', width: 16 },
      { header: 'Net Salary', key: 'net_salary', width: 16 },
    ];

    sheet.mergeCells('A1:J1');
    sheet.getCell('A1').value = `Payroll Batch #${batchId}`;
    sheet.mergeCells('A2:J2');
    sheet.getCell('A2').value = `Period: ${dateOnly(batch.start_date)} - ${dateOnly(batch.end_date)}`;
    sheet.mergeCells('A3:J3');
    sheet.getCell('A3').value = 'Currency: Syrian Pound (ل.س)';
    sheet.getRow(5).values = sheet.columns.map((column) => column.header);

    let totalRegularPay = 0;
    let totalOvertimePay = 0;
    let totalNetSalary = 0;

    rows.forEach((item, index) => {
      const regularHours = Number(item.regular_hours_worked || 0);
      const overtimeHours = Number(item.overtime_hours_worked || 0);
      const regularRate = Number(item.hourly_rate_snapshot);
      const overtimeRate = Number(item.overtime_hourly_rate_snapshot);
      const regularPay = Math.round(regularHours * regularRate * 100) / 100;
      const overtimePay = Math.round(overtimeHours * overtimeRate * 100) / 100;
      const netSalary = Number(item.net_salary || regularPay + overtimePay);

      totalRegularPay += regularPay;
      totalOvertimePay += overtimePay;
      totalNetSalary += netSalary;

      sheet.addRow({
        number: index + 1,
        worker_name: item.worker_name,
        site_name: item.site_name || '',
        regular_hours: regularHours,
        overtime_hours: overtimeHours,
        regular_rate: regularRate,
        overtime_rate: overtimeRate,
        regular_pay: regularPay,
        overtime_pay: overtimePay,
        net_salary: netSalary,
      });
    });

    const totalRow = sheet.addRow({
      worker_name: 'TOTAL',
      regular_pay: Math.round(totalRegularPay * 100) / 100,
      overtime_pay: Math.round(totalOvertimePay * 100) / 100,
      net_salary: Math.round(totalNetSalary * 100) / 100,
    });

    sheet.getRow(1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    sheet.getRow(5).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    totalRow.font = { bold: true };
    for (let row = 6; row <= sheet.rowCount; row += 1) {
      for (const col of [6, 7, 8, 9, 10]) {
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
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Failed to export Excel payroll report.' });
    }
  }
}

async function exportDailyAttendanceExcel(req, res) {
  const { date, site_id } = req.query || {};
  if (!isValidDate(date)) {
    return res.status(400).json({ success: false, message: 'A valid date in YYYY-MM-DD format is required.' });
  }

  try {
    const ExcelJS = require('exceljs');
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
      { header: 'Admin Rejection Notes', key: 'admin_rejection_notes', width: 36 },
    ];

    sheet.mergeCells('A1:M1');
    sheet.getCell('A1').value = `Daily Attendance Report - ${date}`;
    sheet.mergeCells('A2:M2');
    sheet.getCell('A2').value = 'Attendance and hours only — no salary or rate calculation';
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
        admin_rejection_notes: row.admin_rejection_notes || '',
      });
    });

    sheet.getRow(1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    sheet.getRow(2).font = { italic: true, color: { argb: 'FF555555' } };
    sheet.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
    sheet.views = [{ state: 'frozen', ySplit: 4 }];
    sheet.autoFilter = { from: 'A4', to: 'M4' };

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
  getPayrollReport,
  getPayrollBatchDetails,
  markBatchAsPaid,
  getLastBatchEndDate,
  exportPayrollExcel,
  exportDailyAttendanceExcel,
};
