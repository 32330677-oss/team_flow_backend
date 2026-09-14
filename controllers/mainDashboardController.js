const pool = require('../config/db');

function isValidDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00`));
}

async function getOverview(req, res) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let { start_date, end_date } = req.query;
    if (!isValidDate(end_date)) end_date = today;
    if (!isValidDate(start_date)) {
      const d = new Date(end_date);
      d.setDate(d.getDate() - 29);
      start_date = d.toISOString().slice(0, 10);
    }

    // 1) عدد العمال الكلي + حالتهم اليوم
    const [[totals]] = await pool.query(
      `SELECT COUNT(*) AS total_workers,
              SUM(CASE WHEN status='Active' THEN 1 ELSE 0 END) AS active_workers
       FROM workers`
    );

    const [todayRows] = await pool.execute(
      `SELECT attendance_status FROM attendance WHERE record_date = ?`,
      [today]
    );
    let presentToday = 0, onLeaveToday = 0, absentToday = 0;
    for (const r of todayRows) {
      if (r.attendance_status === 'Present') presentToday += 1;
      else if (r.attendance_status === 'Absent') absentToday += 1;
      else onLeaveToday += 1;
    }
    const totalWorkers = Number(totals.total_workers || 0);
    const attendanceRate = totalWorkers > 0 ? Math.round((presentToday / totalWorkers) * 10000) / 100 : 0;

    // 2) سلسلة الحضور اليومية ضمن المدى المحدد
    const [seriesRows] = await pool.query(
      `WITH RECURSIVE date_series AS (
         SELECT DATE(?) AS dt
         UNION ALL
         SELECT DATE_ADD(dt, INTERVAL 1 DAY) FROM date_series WHERE dt < DATE(?)
       )
       SELECT ds.dt AS record_date,
              SUM(CASE WHEN a.attendance_status='Present' THEN 1 ELSE 0 END) AS present_count,
              SUM(CASE WHEN a.attendance_status IN ('Sick','Vacation','Holiday') THEN 1 ELSE 0 END) AS leave_count,
              SUM(CASE WHEN a.attendance_status='Absent' THEN 1 ELSE 0 END) AS absent_count
       FROM date_series ds
       LEFT JOIN attendance a ON a.record_date = ds.dt
       GROUP BY ds.dt ORDER BY ds.dt`,
      [start_date, end_date]
    );
    const attendanceOverview = seriesRows.map(r => ({
      date: String(r.record_date).slice(0, 10),
      present: Number(r.present_count || 0),
      on_leave: Number(r.leave_count || 0),
      absent: Number(r.absent_count || 0),
    }));

    // 3) ساعات العمل ضمن المدى (بيانات حقيقية من attendance)
    const [[hoursRow]] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN attendance_status='Present' THEN total_working_hours ELSE 0 END),0) AS regular_hours,
         COALESCE(SUM(CASE WHEN attendance_status='Present' THEN overtime_hours ELSE 0 END),0) AS overtime_hours,
         COALESCE(SUM(CASE WHEN attendance_status IN ('Sick','Vacation','Holiday') THEN 1 ELSE 0 END),0) AS paid_leave_days,
         COALESCE(SUM(CASE WHEN attendance_status='Absent' THEN 1 ELSE 0 END),0) AS absent_days
       FROM attendance WHERE record_date BETWEEN ? AND ?`,
      [start_date, end_date]
    );

    // 4) توزيع العمال حسب الوظيفة (بيانات حقيقية من جدول workers)
    const [positionRows] = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(job_position),''),'Others') AS position, COUNT(*) AS cnt
       FROM workers WHERE status='Active' GROUP BY position ORDER BY cnt DESC`
    );

    // 5) أكثر المواقع استيعابًا للعمال (تعيينات فعالة فقط)
    const [siteRows] = await pool.query(
      `SELECT s.site_name, COUNT(*) AS worker_count
       FROM workersiteassignments wsa
       JOIN sites s ON s.site_id = wsa.site_id
       WHERE wsa.unassigned_date IS NULL
       GROUP BY s.site_id, s.site_name
       ORDER BY worker_count DESC
       LIMIT 6`
    );

    // 6) آخر سجلات الحضور
    const [recentRows] = await pool.query(
      `SELECT a.record_date, w.full_name, w.job_position, a.check_in_time, a.check_out_time,
              a.total_working_hours, a.attendance_status
       FROM attendance a
       JOIN workers w ON w.worker_id = a.worker_id
       ORDER BY a.record_date DESC, a.attendance_id DESC
       LIMIT 8`
    );

    // 7) آخر الأنشطة من سجل التدقيق (Audit Log)
    const [activityRows] = await pool.query(
      `SELECT al.action_type, al.table_name, al.timestamp, u.full_name AS user_name
       FROM auditlogs al
       LEFT JOIN users u ON u.user_id = al.user_id
       ORDER BY al.timestamp DESC
       LIMIT 6`
    );

    // 8) ملخص آخر دفعة رواتب فعلية
    const [payrollBatchRows] = await pool.query(
      `SELECT payroll_batch_id, start_date, end_date, total_workers, status, generated_at
       FROM payrollbatches WHERE status <> 'Superseded'
       ORDER BY generated_at DESC LIMIT 1`
    );
    let payrollSummary = null;
    if (payrollBatchRows.length) {
      const batch = payrollBatchRows[0];
      const [[payrollAgg]] = await pool.execute(
        `SELECT COALESCE(SUM(net_salary),0) AS total_net,
                COALESCE(SUM(deductions_amount),0) AS total_deductions
         FROM payroll WHERE payroll_batch_id = ?`,
        [batch.payroll_batch_id]
      );
      const [[otAgg]] = await pool.execute(
        `SELECT COALESCE(SUM(pi.overtime_pay),0) AS total_ot
         FROM payrollitems pi JOIN payroll p ON p.payroll_id = pi.payroll_id
         WHERE p.payroll_batch_id = ?`,
        [batch.payroll_batch_id]
      );
      payrollSummary = {
        batch_id: batch.payroll_batch_id,
        period: `${String(batch.start_date).slice(0, 10)} - ${String(batch.end_date).slice(0, 10)}`,
        total_net_salary: Number(payrollAgg.total_net || 0),
        total_deductions: Number(payrollAgg.total_deductions || 0),
        total_overtime_paid: Number(otAgg.total_ot || 0),
        total_employees: Number(batch.total_workers || 0),
        status: batch.status,
      };
    }

    return res.json({
      status: 'success',
      data: {
        range: { start_date, end_date },
        kpis: {
          total_workers: totalWorkers,
          present_today: presentToday,
          on_leave_today: onLeaveToday,
          absent_today: absentToday,
          attendance_rate: attendanceRate,
        },
        attendance_overview: attendanceOverview,
        hours_overview: {
          regular_hours: Number(hoursRow.regular_hours || 0),
          overtime_hours: Number(hoursRow.overtime_hours || 0),
          paid_leave_days: Number(hoursRow.paid_leave_days || 0),
          absent_days: Number(hoursRow.absent_days || 0),
        },
        workers_by_position: positionRows.map(r => ({ position: r.position, count: Number(r.cnt) })),
        top_sites: siteRows.map(r => ({ site_name: r.site_name, worker_count: Number(r.worker_count) })),
        recent_attendance: recentRows.map(r => ({
          date: String(r.record_date).slice(0, 10),
          full_name: r.full_name,
          position: r.job_position,
          check_in: r.check_in_time,
          check_out: r.check_out_time,
          total_hours: r.total_working_hours,
          status: r.attendance_status,
        })),
        recent_activity: activityRows.map(r => ({
          action_type: r.action_type,
          table_name: r.table_name,
          timestamp: r.timestamp,
          user_name: r.user_name,
        })),
        payroll_summary: payrollSummary,
      },
    });
  } catch (error) {
    console.error('getOverview:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load dashboard overview.' });
  }
}

module.exports = { getOverview };