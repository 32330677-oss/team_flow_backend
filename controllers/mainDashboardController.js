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
      // نافذة افتراضية 14 يوم لرسم الساعات اليومية
      const d = new Date(end_date);
      d.setDate(d.getDate() - 13);
      start_date = d.toISOString().slice(0, 10);
    }

    // 1) عدد العمال الحقيقي: فقط الي معينين فعلياً على موقع Active
    const [[assignedTotals]] = await pool.query(
      `SELECT COUNT(DISTINCT wsa.worker_id) AS total_assigned
       FROM workersiteassignments wsa
       JOIN workers w ON w.worker_id = wsa.worker_id
       WHERE wsa.unassigned_date IS NULL AND w.status = 'Active'`
    );
    const totalAssignedWorkers = Number(assignedTotals.total_assigned || 0);

    // 2) لقطة اليوم: كم حاضر / بإجازة / غايب / شغال هلق
    const [todayRows] = await pool.execute(
      `SELECT attendance_status, check_in_time, check_out_time FROM attendance WHERE record_date = ?`,
      [today]
    );
    let presentToday = 0, onLeaveToday = 0, absentToday = 0, currentlyWorkingNow = 0;
    for (const r of todayRows) {
      if (r.attendance_status === 'Present') {
        presentToday += 1;
        if (r.check_in_time && !r.check_out_time) currentlyWorkingNow += 1;
      } else if (r.attendance_status === 'Absent') {
        absentToday += 1;
      } else {
        onLeaveToday += 1;
      }
    }
    const attendanceRate = totalAssignedWorkers > 0
      ? Math.round((presentToday / totalAssignedWorkers) * 10000) / 100
      : 0;

    // 2.b) كم عامل "برا السايت هلق" (بريك/إجازة مفتوحة الآن) — يغذي كل من
    // الـ KPI الجديد وسكشن "On Leave / Break Right Now" بنفس البيانات.
    const [onLeaveNowRows] = await pool.execute(
      `SELECT w.full_name, s.site_name, alp.leave_type, alp.leave_start_time
       FROM attendanceleaveperiods alp
       JOIN attendance a ON a.attendance_id = alp.attendance_id
       JOIN workers w ON w.worker_id = a.worker_id
       JOIN sites s ON s.site_id = a.site_id
       WHERE alp.leave_end_time IS NULL AND a.record_date = ?
       ORDER BY alp.leave_start_time DESC`,
      [today]
    );
    const onLeaveNow = onLeaveNowRows.map(r => ({
      full_name: r.full_name,
      site_name: r.site_name,
      leave_type: r.leave_type,
      leave_start_time: r.leave_start_time,
    }));

    // 3) حالة كل موقع اليوم: شغال هلق / على بريك هلق / إجازة / غياب، وهل انعمل Submit
    const [siteRows] = await pool.query(
      `SELECT s.site_id, s.site_name,
              COUNT(DISTINCT wsa.worker_id) AS assigned_workers,
              COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL AND a.check_out_time IS NULL THEN a.worker_id END) AS currently_working,
              COUNT(DISTINCT CASE WHEN a.check_in_time IS NOT NULL THEN a.worker_id END) AS checked_in_today,
              COUNT(DISTINCT CASE WHEN alp.leave_id IS NOT NULL THEN a.worker_id END) AS on_break_now,
              COUNT(DISTINCT CASE WHEN a.attendance_status IN ('Sick','Vacation','Holiday') THEN a.worker_id END) AS on_leave_today,
              COUNT(DISTINCT CASE WHEN a.attendance_status = 'Absent' THEN a.worker_id END) AS absent_today,
              MAX(CASE WHEN a.status <> 'Draft' THEN 1 ELSE 0 END) AS is_submitted
       FROM sites s
       LEFT JOIN workersiteassignments wsa ON wsa.site_id = s.site_id AND wsa.unassigned_date IS NULL
       LEFT JOIN attendance a ON a.site_id = s.site_id AND a.record_date = ?
       LEFT JOIN attendanceleaveperiods alp ON alp.attendance_id = a.attendance_id AND alp.leave_end_time IS NULL
       WHERE s.site_status = 'Active'
       GROUP BY s.site_id, s.site_name
       HAVING assigned_workers > 0
       ORDER BY currently_working DESC, s.site_name`,
      [today]
    );

    // 4) اتجاه الحضور اليومي (Present / On Leave / Absent) ضمن المدى
    const [attendanceSeriesRows] = await pool.query(
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
    const attendanceOverview = attendanceSeriesRows.map(r => ({
      date: String(r.record_date).slice(0, 10),
      present: Number(r.present_count || 0),
      on_leave: Number(r.leave_count || 0),
      absent: Number(r.absent_count || 0),
    }));

    // 5) الساعات العادية مقابل الإضافية يوم عن يوم
    const [dailyHoursRows] = await pool.query(
      `WITH RECURSIVE date_series AS (
         SELECT DATE(?) AS dt
         UNION ALL
         SELECT DATE_ADD(dt, INTERVAL 1 DAY) FROM date_series WHERE dt < DATE(?)
       )
       SELECT ds.dt AS record_date,
              COALESCE(SUM(CASE WHEN a.attendance_status='Present' THEN a.total_working_hours ELSE 0 END), 0) AS regular_hours,
              COALESCE(SUM(CASE WHEN a.attendance_status='Present' THEN a.overtime_hours ELSE 0 END), 0) AS overtime_hours
       FROM date_series ds
       LEFT JOIN attendance a ON a.record_date = ds.dt
       GROUP BY ds.dt ORDER BY ds.dt`,
      [start_date, end_date]
    );
    const dailyHoursSeries = dailyHoursRows.map(r => ({
      date: String(r.record_date).slice(0, 10),
      regular_hours: Number(r.regular_hours || 0),
      overtime_hours: Number(r.overtime_hours || 0),
    }));

    // 6) آخر دفعة رواتب انعملها فعلياً Paid
    const [lastPaidRows] = await pool.query(
      `SELECT pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_amount, pb.total_workers,
              MAX(p.paid_date) AS paid_date
       FROM payrollbatches pb
       JOIN payroll p ON p.payroll_batch_id = pb.payroll_batch_id
       WHERE pb.status = 'Paid'
       GROUP BY pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_amount, pb.total_workers
       ORDER BY paid_date DESC
       LIMIT 1`
    );
    const lastPaidPayroll = lastPaidRows.length ? {
      batch_id: lastPaidRows[0].payroll_batch_id,
      period: `${String(lastPaidRows[0].start_date).slice(0, 10)} - ${String(lastPaidRows[0].end_date).slice(0, 10)}`,
      total_amount: Number(lastPaidRows[0].total_amount || 0),
      total_workers: Number(lastPaidRows[0].total_workers || 0),
      paid_date: lastPaidRows[0].paid_date ? String(lastPaidRows[0].paid_date).slice(0, 10) : null,
    } : null;

    // 7) آخر باتش انعمل (أي حالة، غير Superseded)
    const [latestBatchRows] = await pool.query(
      `SELECT payroll_batch_id, start_date, end_date, total_workers, status, generated_at, total_amount
       FROM payrollbatches WHERE status <> 'Superseded'
       ORDER BY generated_at DESC LIMIT 1`
    );
    const latestPayrollBatch = latestBatchRows.length ? {
      batch_id: latestBatchRows[0].payroll_batch_id,
      period: `${String(latestBatchRows[0].start_date).slice(0, 10)} - ${String(latestBatchRows[0].end_date).slice(0, 10)}`,
      total_amount: Number(latestBatchRows[0].total_amount || 0),
      total_workers: Number(latestBatchRows[0].total_workers || 0),
      status: latestBatchRows[0].status,
    } : null;

    // 8) توزيع العمال حسب الوظيفة
    const [positionRows] = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(job_position),''),'Others') AS position, COUNT(*) AS cnt
       FROM workers WHERE status='Active' GROUP BY position ORDER BY cnt DESC`
    );

    // 9) أكثر المواقع استيعاباً للعمال
    const [topSiteRows] = await pool.query(
      `SELECT s.site_name, COUNT(*) AS worker_count
       FROM workersiteassignments wsa
       JOIN sites s ON s.site_id = wsa.site_id
       WHERE wsa.unassigned_date IS NULL
       GROUP BY s.site_id, s.site_name
       ORDER BY worker_count DESC
       LIMIT 6`
    );

    // 10) سجلات الحضور المحتاجة مراجعة الأدمن
    const [[pendingRow]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM attendance WHERE status = 'Submitted'`
    );
    const [[rejectedRow]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM attendance WHERE status = 'Rejected'`
    );

    return res.json({
      status: 'success',
      data: {
        range: { start_date, end_date },
        kpis: {
          total_workers: totalAssignedWorkers,
          currently_working_now: currentlyWorkingNow,
          present_today: presentToday,
          on_leave_today: onLeaveToday,
          absent_today: absentToday,
          attendance_rate: attendanceRate,
          pending_reviews: Number(pendingRow.cnt || 0),
          rejected_records: Number(rejectedRow.cnt || 0),
          on_break_now: onLeaveNow.length,
        },
        live_sites: siteRows.map(r => ({
          site_id: r.site_id,
          site_name: r.site_name,
          assigned_workers: Number(r.assigned_workers || 0),
          currently_working: Number(r.currently_working || 0),
          checked_in_today: Number(r.checked_in_today || 0),
          on_break_now: Number(r.on_break_now || 0),
          on_leave_today: Number(r.on_leave_today || 0),
          absent_today: Number(r.absent_today || 0),
          is_submitted: Number(r.is_submitted || 0) === 1,
        })),
        on_leave_now: onLeaveNow,
        attendance_overview: attendanceOverview,
        daily_hours_series: dailyHoursSeries,
        last_paid_payroll: lastPaidPayroll,
        latest_payroll_batch: latestPayrollBatch,
        workers_by_position: positionRows.map(r => ({ position: r.position, count: Number(r.cnt) })),
        top_sites: topSiteRows.map(r => ({ site_name: r.site_name, worker_count: Number(r.worker_count) })),
      },
    });
  } catch (error) {
    console.error('getOverview:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load dashboard overview.' });
  }
}

module.exports = { getOverview };