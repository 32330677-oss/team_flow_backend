const pool = require('../config/db');

// توليد دفعة الرواتب
const generatePayrollBatch = async (req, res) => {
  const { start_date, end_date } = req.body;
  const adminId = req.user.user_id;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. إنشاء دفعة الرواتب الرئيسية
    const [batchResult] = await connection.query(
      `INSERT INTO payrollbatches (start_date, end_date, generated_by_user_id, status) VALUES (?, ?, ?, 'Generated')`,
      [start_date, end_date, adminId]
    );
    const payrollBatchId = batchResult.insertId;

    // 2. جلب العمال النشطين مع عقودهم ومواقعهم
    const [workers] = await connection.query(`
      SELECT 
        w.worker_id, c.contract_id, c.hourly_rate, c.overtime_hourly_rate, s.site_id
      FROM workers w
      JOIN workersiteassignments wsa ON w.worker_id = wsa.worker_id
      JOIN sites s ON wsa.site_id = s.site_id
      JOIN contracts c ON s.contract_id = c.contract_id
      WHERE w.status = 'Active' AND wsa.unassigned_date IS NULL
    `, []);

    let totalWorkers = 0;
    let totalAmount = 0;

    for (const worker of workers) {
      // 3. جمع ساعات العمل المعتمدة لكل عامل ضمن الفترة
      const [attendanceSummary] = await connection.query(`
        SELECT 
          SUM(total_working_hours) as total_hours,
          SUM(overtime_hours) as total_overtime
        FROM attendance
        WHERE worker_id = ? 
          AND record_date BETWEEN ? AND ?
          AND status = 'Approved'
      `, [worker.worker_id, start_date, end_date]);

      const regularHours = attendanceSummary[0]?.total_hours || 0;
      const overtimeHours = attendanceSummary[0]?.total_overtime || 0;

      if (regularHours === 0 && overtimeHours === 0) continue;

      const baseSalary = regularHours * worker.hourly_rate;
      const overtimePay = overtimeHours * worker.overtime_hourly_rate;
      const grossSalary = baseSalary + overtimePay;
      const netSalary = grossSalary;

      // 4. استخدام INSERT IGNORE لمنع انهيار النظام إذا تكررت الفترة لنفس العامل
      const [payrollResult] = await connection.query(`
        INSERT IGNORE INTO payroll (payroll_batch_id, worker_id, start_date, end_date, gross_salary, net_salary, generated_by_user_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Generated')
      `, [payrollBatchId, worker.worker_id, start_date, end_date, grossSalary, netSalary, adminId]);

      if (payrollResult.affectedRows === 0) continue;

      const payrollId = payrollResult.insertId;

      // 5. إدخال عناصر الراتب (Payroll Items)
      await connection.query(`
        INSERT INTO payrollitems (payroll_id, contract_id, site_id, hourly_rate_snapshot, overtime_hourly_rate_snapshot, regular_hours_worked, overtime_hours_worked, base_salary, overtime_pay)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [payrollId, worker.contract_id, worker.site_id, worker.hourly_rate, worker.overtime_hourly_rate, regularHours, overtimeHours, baseSalary, overtimePay]);

      totalWorkers++;
      totalAmount += netSalary;
    }

    // 6. تحديث إجماليات الدفعة
    await connection.query(
      `UPDATE payrollbatches SET total_workers = ?, total_amount = ? WHERE payroll_batch_id = ?`,
      [totalWorkers, totalAmount, payrollBatchId]
    );

    await connection.commit();
    res.status(201).json({ success: true, message: 'Payroll batch generated successfully', payrollBatchId });

  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error while generating payroll' });
  } finally {
    connection.release();
  }
};

// جلب تقارير الرواتب العامة
const getPayrollReport = async (req, res) => {
  try {
    const [batches] = await pool.query(`
      SELECT 
        pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_workers, pb.total_amount, pb.status, pb.generated_at,
        u.full_name as generated_by
      FROM payrollbatches pb
      JOIN users u ON pb.generated_by_user_id = u.user_id
      ORDER BY pb.generated_at DESC
    `, []);

    res.status(200).json({ success: true, data: batches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching payroll reports' });
  }
};

// جلب تفاصيل دفعة رواتب معينة (ساعات العمال، أسعار الساعات، والمجاميع)
const getPayrollBatchDetails = async (req, res) => {
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
};

module.exports = {
  generatePayrollBatch,
  getPayrollReport,
  getPayrollBatchDetails
};