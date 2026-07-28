const pool = require('../config/db');

async function generatePayrollBatch(req, res) {
    try {
        const { start_date, end_date, site_id } = req.body;
        const userId = req.user?.user_id || 1;

        if (!start_date || !end_date) {
            return res.status(400).json({ success: false, message: 'Start date and end date are required' });
        }

        let workersQuery = `
            SELECT DISTINCT w.*, wsa.contract_id, wsa.site_id as assigned_site_id
            FROM workers w 
            LEFT JOIN workersiteassignments wsa ON w.worker_id = wsa.worker_id 
            LEFT JOIN contracts c ON wsa.contract_id = c.contract_id AND c.status = 'Active'
            WHERE w.status = 'Active'
        `;
        let queryParams = [];

        if (site_id) {
            workersQuery += ` AND wsa.site_id = ? AND (wsa.unassigned_date IS NULL OR wsa.unassigned_date >= ?)`;
            queryParams.push(site_id, start_date);
        }

        const [workers] = await pool.query(workersQuery, queryParams);

        if (!workers || workers.length === 0) {
            return res.status(404).json({ success: false, message: 'No active workers found for the specified site or criteria' });
        }

        let totalWorkers = 0;
        let totalAmount = 0;
        let batchWorkersData = [];

        for (let worker of workers) {
            if (!worker.contract_id) continue;

            let attQuery = `
                SELECT 
                    site_id,
                    SUM(total_working_hours) as reg_hours, 
                    SUM(overtime_hours) as ot_hours 
                FROM attendance 
                WHERE worker_id = ? AND record_date BETWEEN ? AND ?
            `;
            let attParams = [worker.worker_id, start_date, end_date];

            if (site_id) {
                attQuery += ` AND site_id = ?`;
                attParams.push(site_id);
            }

            attQuery += ` GROUP BY site_id`;

            const [logs] = await pool.query(attQuery, attParams);

            if (!logs || logs.length === 0) continue;

            // معالجة كل موقع عمل سجِل له حضور العامل خلال الفترة
            for (let log of logs) {
                const regHours = Number(log.reg_hours || 0);
                const otHours = Number(log.ot_hours || 0);
                const logSiteId = log.site_id || worker.assigned_site_id;

                if (regHours === 0 && otHours === 0) continue;
                if (!logSiteId) continue; // تجنب خطأ إذا لم يوجد موقع مرتبط

                const hourlyRate = Number(worker.hourly_rate || 0);
                const overtimeRate = Number(worker.overtime_hourly_rate || (hourlyRate * 1.5));

                const baseSalary = regHours * hourlyRate;
                const overtimePay = otHours * overtimeRate;
                const grossSalary = baseSalary + overtimePay;
                const netSalary = grossSalary; 

                totalWorkers++;
                totalAmount += netSalary;

                batchWorkersData.push({
                    worker_id: worker.worker_id,
                    contract_id: worker.contract_id,
                    site_id: logSiteId, // <-- تحديد موقع العمل بدقة لكل بند
                    regHours,
                    otHours,
                    hourlyRate,
                    overtimeRate,
                    baseSalary,
                    overtimePay,
                    grossSalary,
                    netSalary
                });
            }
        }

        if (totalWorkers === 0) {
            return res.status(400).json({ success: false, message: 'No attendance records or active contracts found for workers in this period' });
        }

        const [batchResult] = await pool.query(
            `INSERT INTO payrollbatches (start_date, end_date, total_workers, total_amount, status, generated_by_user_id, generated_at) 
             VALUES (?, ?, ?, ?, 'Generated', ?, NOW())`,
            [start_date, end_date, totalWorkers, totalAmount, userId]
        );
        const batchId = batchResult.insertId;

        for (let data of batchWorkersData) {
            const [payrollResult] = await pool.query(
                `INSERT INTO payroll (payroll_batch_id, worker_id, start_date, end_date, gross_salary, net_salary, status, generated_by_user_id) 
                 VALUES (?, ?, ?, ?, ?, ?, 'Generated', ?)`,
                [batchId, data.worker_id, start_date, end_date, data.grossSalary, data.netSalary, userId]
            );
            const payrollId = payrollResult.insertId;

            // إدراج البيانات مع تمرير site_id و contract_id معاً لتجنب أي أخطاء قاعدة بيانات إضافية
            await pool.query(
                `INSERT INTO payrollitems (payroll_id, contract_id, site_id, regular_hours_worked, overtime_hours_worked, hourly_rate_snapshot, overtime_hourly_rate_snapshot, base_salary, overtime_pay) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    payrollId, 
                    data.contract_id, 
                    data.site_id, // <-- تمرير موقع العمل الإلزامي
                    data.regHours, 
                    data.otHours, 
                    data.hourlyRate, 
                    data.overtimeRate, 
                    data.baseSalary, 
                    data.overtimePay
                ]
            );
        }

        return res.status(200).json({ 
            success: true, 
            message: 'Payroll generated successfully', 
            batch_id: batchId 
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, error: error.message });
    }
}

async function getPayrollReport(req, res) {
  try {
    const { site_id } = req.query;
    
    let query = `
      SELECT 
        pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_workers, pb.total_amount, pb.status, pb.generated_at,
        u.full_name as generated_by
      FROM payrollbatches pb
      JOIN users u ON pb.generated_by_user_id = u.user_id
    `;
    
    let queryParams = [];
    
   if (site_id) {
      query = `
        SELECT DISTINCT
          pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_workers, pb.total_amount, pb.status, pb.generated_at,
          u.full_name as generated_by
        FROM payrollbatches pb
        JOIN users u ON pb.generated_by_user_id = u.user_id
        JOIN payroll p ON pb.payroll_batch_id = p.payroll_batch_id
        JOIN attendance a ON p.worker_id = a.worker_id AND a.site_id = ?
      `;
      queryParams.push(site_id);
    }

    query += ` ORDER BY pb.generated_at DESC`;

    const [batches] = await pool.query(query, queryParams);

    res.status(200).json({ success: true, data: batches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching payroll reports' });
  }
}

async function getPayrollBatchDetails(req, res) {
  const { batchId } = req.params;
  try {
    const [batches] = await pool.query(
      `SELECT * FROM payrollbatches WHERE payroll_batch_id = ?`, 
      [batchId]
    );
    if (batches.length === 0) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    const [items] = await pool.query(`
      SELECT 
        p.payroll_id, p.gross_salary, p.net_salary,
        w.worker_id, 
        w.full_name as worker_name,
        pi.regular_hours_worked, pi.overtime_hours_worked,
        pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot,
        pi.base_salary, pi.overtime_pay
      FROM payroll p
      JOIN workers w ON p.worker_id = w.worker_id
      JOIN payrollitems pi ON p.payroll_id = pi.payroll_id
      WHERE p.payroll_batch_id = ?
    `, [batchId]);

    res.status(200).json({ 
      success: true, 
      batch: batches[0],
      workers: items 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching payroll details' });
  }
}

async function markBatchAsPaid(req, res) {
  const { batchId } = req.params;
  try {
    await pool.query(
      `UPDATE payrollbatches SET status = 'Paid' WHERE payroll_batch_id = ?`, [batchId]
    );
    await pool.query(
      `UPDATE payroll SET status = 'Paid', paid_date = CURDATE() WHERE payroll_batch_id = ?`, [batchId]
    );
    res.status(200).json({ success: true, message: 'Batch marked as paid' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error updating payment status' });
  }
}

module.exports = { 
  generatePayrollBatch, 
  getPayrollReport, 
  getPayrollBatchDetails, 
  markBatchAsPaid 
};