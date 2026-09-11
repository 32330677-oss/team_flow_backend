// controllers/staffOvertimeCompensationController.js
//
// Month-scoped overtime compensation ledger for staff. Never edits
// staff_attendance.regular_hours/overtime_hours (rule 22) — only records
// which Present-day shortfalls have been explicitly compensated by Admin
// from that SAME payroll month's earned overtime (rules 17-21).

const db = require('../config/db');

function isValidMonth(value) {
  return /^\d{4}-\d{2}$/.test(String(value || ''));
}

function monthBounds(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const start = `${monthStr}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${monthStr}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

function isFriday(dateValue) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  return date.getUTCDay() === 5;
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

// Computes { grossOtHours, usedOtHours, remainingOtHours } for staff+month.
// Read-only helper, reusable by both getBalance and grantCompensation.
async function computeMonthBalance(executor, staffId, monthStr, forUpdateUsed = false) {
  const { start, end } = monthBounds(monthStr);

  const [attRows] = await executor.execute(
    `SELECT record_date, overtime_hours FROM staff_attendance
     WHERE staff_id = ? AND status = 'Approved' AND attendance_status = 'Present'
       AND record_date BETWEEN ? AND ?`,
    [staffId, start, end]
  );
  let grossOtHours = 0;
  for (const row of attRows) {
    if (isFriday(row.record_date)) continue; // Friday excluded, mirrors StaffPayrollController
    grossOtHours += Number(row.overtime_hours || 0);
  }

  const lock = forUpdateUsed ? ' FOR UPDATE' : '';
  const [usedRows] = await executor.execute(
    `SELECT COALESCE(SUM(hours_used), 0) AS used
     FROM staff_overtime_compensations
     WHERE staff_id = ? AND payroll_month = ? AND reversed_at IS NULL${lock}`,
    [staffId, monthStr]
  );
  const usedOtHours = Number(usedRows[0].used || 0);

  return {
    grossOtHours: money(grossOtHours),
    usedOtHours: money(usedOtHours),
    remainingOtHours: money(grossOtHours - usedOtHours),
  };
}

// GET /api/staff-overtime/balance?staff_id=&month=YYYY-MM
exports.getBalance = async (req, res) => {
  const staffId = Number(req.query.staff_id);
  const month = req.query.month;

  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'A valid staff_id is required.' });
  }
  if (!isValidMonth(month)) {
    return res.status(400).json({ status: 'error', message: 'A valid month (YYYY-MM) is required.' });
  }

  try {
    const balance = await computeMonthBalance(db, staffId, month);
    return res.status(200).json({ status: 'success', data: { staff_id: staffId, payroll_month: month, ...balance } });
  } catch (error) {
    console.error('GET STAFF OT BALANCE ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load overtime balance.' });
  }
};

// GET /api/staff-overtime/history?staff_id=&month=YYYY-MM
exports.getHistory = async (req, res) => {
  const staffId = Number(req.query.staff_id);
  const month = req.query.month;

  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'A valid staff_id is required.' });
  }
  if (!isValidMonth(month)) {
    return res.status(400).json({ status: 'error', message: 'A valid month (YYYY-MM) is required.' });
  }

  try {
    const [rows] = await db.execute(
      `SELECT soc.*, sa.record_date AS target_record_date,
              cb.full_name AS created_by_name, rb.full_name AS reversed_by_name
       FROM staff_overtime_compensations soc
       JOIN staff_attendance sa ON sa.staff_attendance_id = soc.target_attendance_id
       JOIN users cb ON cb.user_id = soc.created_by_user_id
       LEFT JOIN users rb ON rb.user_id = soc.reversed_by_user_id
       WHERE soc.staff_id = ? AND soc.payroll_month = ?
       ORDER BY soc.created_at DESC`,
      [staffId, month]
    );
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET STAFF OT HISTORY ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load overtime compensation history.' });
  }
};

// POST /api/staff-overtime/grant
// body: { staff_attendance_id, hours_to_use, reason }
// Admin-only (enforced in routes). Compensates a Present-day shortfall
// using OT earned in that SAME payroll month, never exceeding either the
// day's remaining shortfall or the month's remaining OT balance.
exports.grantCompensation = async (req, res) => {
  const targetAttendanceId = Number(req.body?.staff_attendance_id);
  const hoursToUse = Number(req.body?.hours_to_use);
  const reason = String(req.body?.reason || '').trim();
  const adminId = req.user.user_id;

  if (!Number.isInteger(targetAttendanceId) || targetAttendanceId <= 0) {
    return res.status(400).json({ status: 'error', message: 'A valid staff_attendance_id is required.' });
  }
  if (!Number.isFinite(hoursToUse) || hoursToUse <= 0) {
    return res.status(400).json({ status: 'error', message: 'hours_to_use must be a positive number.' });
  }
  if (!reason) {
    return res.status(400).json({ status: 'error', message: 'A reason is required to grant overtime compensation.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [targetRows] = await connection.execute(
      `SELECT sa.staff_attendance_id, sa.staff_id, sa.record_date, sa.attendance_status,
              sa.status, sa.regular_hours, sm.standard_daily_hours
       FROM staff_attendance sa
       JOIN staff_members sm ON sm.staff_id = sa.staff_id
       WHERE sa.staff_attendance_id = ? FOR UPDATE`,
      [targetAttendanceId]
    );
    if (targetRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Target attendance record not found.' });
    }
    const target = targetRows[0];

    if (target.status !== 'Approved' || target.attendance_status !== 'Present') {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'Overtime can only compensate an approved Present-day shortfall.' });
    }

    const recordDateStr = String(target.record_date).slice(0, 10);
    const payrollMonth = recordDateStr.slice(0, 7);
    const standardHours = Number(target.standard_daily_hours) > 0 ? Number(target.standard_daily_hours) : 8;
    const dayShortfall = Math.max(0, standardHours - Number(target.regular_hours || 0));

    if (dayShortfall <= 0) {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'This day has no shortfall to compensate.' });
    }

    // How much of this specific day's shortfall is already compensated (active grants only).
    const [existingForDay] = await connection.execute(
      `SELECT COALESCE(SUM(hours_used), 0) AS used
       FROM staff_overtime_compensations
       WHERE target_attendance_id = ? AND reversed_at IS NULL FOR UPDATE`,
      [targetAttendanceId]
    );
    const alreadyUsedForDay = Number(existingForDay[0].used || 0);
    const remainingShortfallForDay = money(dayShortfall - alreadyUsedForDay);

    if (hoursToUse > remainingShortfallForDay + 1e-9) {
      await connection.rollback();
      return res.status(400).json({
        status: 'error',
        message: `hours_to_use (${hoursToUse}) exceeds the remaining shortfall for this day (${remainingShortfallForDay}h).`
      });
    }

    // Month-scoped OT balance (rule: no cross-month carryover).
    const balance = await computeMonthBalance(connection, target.staff_id, payrollMonth, true);
    if (hoursToUse > balance.remainingOtHours + 1e-9) {
      await connection.rollback();
      return res.status(400).json({
        status: 'error',
        message: `hours_to_use (${hoursToUse}) exceeds the remaining earned overtime for ${payrollMonth} (${balance.remainingOtHours}h).`
      });
    }

    const [inserted] = await connection.execute(
      `INSERT INTO staff_overtime_compensations
         (staff_id, target_attendance_id, payroll_month, shortfall_hours_snapshot,
          hours_used, reason, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [target.staff_id, targetAttendanceId, payrollMonth, dayShortfall, hoursToUse, reason, adminId]
    );

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_overtime_compensations', ?, 'OT_GRANTED', ?, NULL, ?)`,
      [inserted.insertId, adminId, JSON.stringify({
        staff_id: target.staff_id, target_attendance_id: targetAttendanceId,
        payroll_month: payrollMonth, hours_used: hoursToUse, reason
      })]
    );

    await connection.commit();
    return res.status(201).json({
      status: 'success',
      message: 'Overtime compensation granted successfully.',
      data: { compensation_id: inserted.insertId }
    });
  } catch (error) {
    await connection.rollback();
    console.error('GRANT STAFF OT COMPENSATION ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to grant overtime compensation.' });
  } finally {
    connection.release();
  }
};

// POST /api/staff-overtime/:compensationId/reverse
exports.reverseCompensation = async (req, res) => {
  const compensationId = Number(req.params.compensationId);
  const adminId = req.user.user_id;

  if (!Number.isInteger(compensationId) || compensationId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid compensation id.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM staff_overtime_compensations WHERE compensation_id = ? FOR UPDATE',
      [compensationId]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Compensation record not found.' });
    }
    if (rows[0].reversed_at) {
      await connection.rollback();
      return res.status(409).json({ status: 'error', message: 'This compensation has already been reversed.' });
    }

    await connection.execute(
      `UPDATE staff_overtime_compensations
       SET reversed_at = NOW(), reversed_by_user_id = ?
       WHERE compensation_id = ?`,
      [adminId, compensationId]
    );

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_overtime_compensations', ?, 'OT_REVERSED', ?, ?, NULL)`,
      [compensationId, adminId, JSON.stringify({ hours_used: rows[0].hours_used, payroll_month: rows[0].payroll_month })]
    );

    await connection.commit();
    return res.status(200).json({ status: 'success', message: 'Overtime compensation reversed successfully.' });
  } catch (error) {
    await connection.rollback();
    console.error('REVERSE STAFF OT COMPENSATION ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to reverse overtime compensation.' });
  } finally {
    connection.release();
  }
};

// GET /api/staff-overtime/shortfall-days?staff_id=&month=YYYY-MM
// Lists Present days in that month still carrying an uncompensated shortfall.
exports.getShortfallDays = async (req, res) => {
  const staffId = Number(req.query.staff_id);
  const month = req.query.month;
  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'A valid staff_id is required.' });
  }
  if (!isValidMonth(month)) {
    return res.status(400).json({ status: 'error', message: 'A valid month (YYYY-MM) is required.' });
  }
  try {
    const { start, end } = monthBounds(month);
    const [rows] = await db.execute(
      `SELECT sa.staff_attendance_id, sa.record_date, sa.regular_hours, sm.standard_daily_hours
       FROM staff_attendance sa
       JOIN staff_members sm ON sm.staff_id = sa.staff_id
       WHERE sa.staff_id = ? AND sa.status = 'Approved' AND sa.attendance_status = 'Present'
         AND sa.record_date BETWEEN ? AND ?`,
      [staffId, start, end]
    );
    const [usedRows] = await db.execute(
      `SELECT target_attendance_id, SUM(hours_used) AS used
       FROM staff_overtime_compensations
       WHERE staff_id = ? AND payroll_month = ? AND reversed_at IS NULL
       GROUP BY target_attendance_id`,
      [staffId, month]
    );
    const usedMap = new Map(usedRows.map((r) => [r.target_attendance_id, Number(r.used)]));

    const data = rows
      .filter((r) => !isFriday(r.record_date))
      .map((r) => {
        const standard = Number(r.standard_daily_hours) > 0 ? Number(r.standard_daily_hours) : 8;
        const shortfall = Math.max(0, standard - Number(r.regular_hours || 0));
        const used = usedMap.get(r.staff_attendance_id) || 0;
        return {
          staff_attendance_id: r.staff_attendance_id,
          record_date: r.record_date,
          shortfall_hours: money(shortfall),
          used_hours: money(used),
          remaining_shortfall_hours: money(shortfall - used),
        };
      })
      .filter((d) => d.remaining_shortfall_hours > 0);

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('GET SHORTFALL DAYS ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load shortfall days.' });
  }
};