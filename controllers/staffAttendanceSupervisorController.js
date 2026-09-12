const db = require('../config/db');
const { getAssignedStaffIdsForSupervisor } = require('./staffSupervisorAssignmentController');

function isValidDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}
function formatToMySqlDateTime(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(String(value));
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '00'] = match;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${mo}-${d} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}

// GET /api/staff-attendance/supervisor/day?date=YYYY-MM-DD
exports.getDayView = async (req, res) => {
  const { date } = req.query;
  if (!isValidDateOnly(date)) {
    return res.status(400).json({ status: 'error', message: 'A valid date (YYYY-MM-DD) is required.' });
  }
  const supervisorId = req.user.user_id;
  try {
    const assignedIds = await getAssignedStaffIdsForSupervisor(supervisorId);
    if (assignedIds.length === 0) {
      return res.status(200).json({ status: 'success', data: [] });
    }
    const placeholders = assignedIds.map(() => '?').join(',');
    const [rows] = await db.execute(
      `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position, sm.standard_daily_hours,
              sa.staff_attendance_id, sa.attendance_status, sa.check_in_time, sa.check_out_time,
              sa.regular_hours, sa.overtime_hours, sa.status, sa.admin_rejection_notes
       FROM staff_members sm
       LEFT JOIN staff_attendance sa ON sa.staff_id = sm.staff_id AND sa.record_date = ?
       WHERE sm.status = 'Active' AND sm.staff_id IN (${placeholders})
       ORDER BY sm.full_name`,
      [date, ...assignedIds]
    );
    res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET SUPERVISOR DAY VIEW ERROR:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load staff attendance for this date.' });
  }
};

// POST /api/staff-attendance/supervisor/bulk-set
exports.bulkSetAttendance = async (req, res) => {
  const { record_date, entries } = req.body || {};
  const supervisorId = req.user.user_id;

  if (!isValidDateOnly(record_date)) {
    return res.status(400).json({ status: 'error', message: 'A valid record_date (YYYY-MM-DD) is required.' });
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ status: 'error', message: 'At least one attendance entry is required.' });
  }

  const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Sick', 'Vacation', 'Holiday'];
  const assignedIds = await getAssignedStaffIdsForSupervisor(supervisorId);
  const assignedSet = new Set(assignedIds);

  const connection = await db.getConnection();
  const results = { updated: [], skipped: [] };
  try {
    await connection.beginTransaction();

    for (const entry of entries) {
      const staffId = Number(entry.staff_id);
      const status = entry.attendance_status;

      if (!Number.isInteger(staffId) || staffId <= 0 || !ATTENDANCE_STATUSES.includes(status)) {
        results.skipped.push({ staff_id: entry.staff_id, reason: 'Invalid entry' });
        continue;
      }
      if (!assignedSet.has(staffId)) {
        results.skipped.push({ staff_id: staffId, reason: 'Staff member is not assigned to you.' });
        continue;
      }

      const [staffRows] = await connection.execute(
        'SELECT standard_daily_hours, status FROM staff_members WHERE staff_id = ? FOR UPDATE',
        [staffId]
      );
      if (!staffRows.length || staffRows[0].status !== 'Active') {
        results.skipped.push({ staff_id: staffId, reason: 'Staff member not found or inactive.' });
        continue;
      }
      const standardHours = Number(staffRows[0].standard_daily_hours || 8);

      let regularHours = 0, overtimeHours = 0, checkIn = null, checkOut = null;

      if (status === 'Present') {
        checkIn = formatToMySqlDateTime(entry.check_in_time);
        checkOut = formatToMySqlDateTime(entry.check_out_time);
        if (!checkIn || !checkOut) {
          results.skipped.push({ staff_id: staffId, reason: 'Check-in and check-out times are required for Present status.' });
          continue;
        }
        const start = new Date(checkIn.replace(' ', 'T'));
        const end = new Date(checkOut.replace(' ', 'T'));
        if (end <= start) {
          results.skipped.push({ staff_id: staffId, reason: 'Check-out time must be after check-in time.' });
          continue;
        }
        const workedHours = (end.getTime() - start.getTime()) / 3600000;
        regularHours = Math.min(workedHours, standardHours);
        overtimeHours = Math.max(0, workedHours - standardHours);
      }

      const [existing] = await connection.execute(
        'SELECT staff_attendance_id, status FROM staff_attendance WHERE staff_id = ? AND record_date = ? LIMIT 1 FOR UPDATE',
        [staffId, record_date]
      );

      if (existing.length > 0) {
        if (existing[0].status === 'Approved') {
          results.skipped.push({ staff_id: staffId, reason: 'Already approved by Admin; cannot modify.' });
          continue;
        }
        await connection.execute(
          `UPDATE staff_attendance
           SET attendance_status = ?, check_in_time = ?, check_out_time = ?,
               regular_hours = ?, overtime_hours = ?,
               status = 'Submitted', recorded_by_user_id = ?,
               admin_rejection_notes = NULL, approved_by_user_id = NULL, approval_date = NULL
           WHERE staff_attendance_id = ?`,
          [status, checkIn, checkOut, regularHours.toFixed(2), overtimeHours.toFixed(2), supervisorId, existing[0].staff_attendance_id]
        );
      } else {
        await connection.execute(
          `INSERT INTO staff_attendance
             (staff_id, record_date, attendance_status, check_in_time, check_out_time,
              regular_hours, overtime_hours, recorded_by_user_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Submitted')`,
          [staffId, record_date, status, checkIn, checkOut, regularHours.toFixed(2), overtimeHours.toFixed(2), supervisorId]
        );
      }

      await connection.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('staff_attendance', ?, 'SUPERVISOR_BULK_SET', ?, NULL, ?)`,
        [staffId, supervisorId, JSON.stringify({ record_date, status, checkIn, checkOut, regularHours, overtimeHours })]
      );

      results.updated.push(staffId);
    }

    await connection.commit();
    res.status(200).json({ status: 'success', message: `${results.updated.length} record(s) submitted for review.`, data: results });
  } catch (error) {
    await connection.rollback();
    console.error('SUPERVISOR BULK SET STAFF ATTENDANCE ERROR:', error);
    res.status(500).json({ status: 'error', message: 'Failed to submit staff attendance.' });
  } finally {
    connection.release();
  }
};