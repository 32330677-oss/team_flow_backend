const db = require('../config/db');
const { getAssignedStaffIdsForSupervisor } = require('./staffSupervisorAssignmentController');
const {
  isValidDateOnly,
  isFriday,
  calculateStaffShiftHours,
} = require('../services/staffAttendanceService');

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
              sa.regular_hours, sa.overtime_hours, sa.lunch_deducted_hours,
              sa.is_friday_worked, sa.status, sa.admin_rejection_notes
       FROM staff_members sm
       LEFT JOIN staff_attendance sa ON sa.staff_id = sm.staff_id AND sa.record_date = ?
       WHERE sm.status = 'Active' AND sm.staff_id IN (${placeholders})
       ORDER BY sm.full_name`,
      [date, ...assignedIds]
    );
    res.status(200).json({
      status: 'success',
      data: rows,
      is_friday: isFriday(date), // lets the frontend show the confirmation banner
    });
  } catch (error) {
    console.error('GET SUPERVISOR DAY VIEW ERROR:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load staff attendance for this date.' });
  }
};

// POST /api/staff-attendance/supervisor/bulk-set
// body: { record_date, entries: [{ staff_id, attendance_status, check_in_time, check_out_time, friday_confirmed }] }
//
// friday_confirmed must be explicitly true for any entry with
// attendance_status = 'Present' when record_date falls on a Friday.
// This never enables Friday for everyone — it is evaluated per entry, so
// several staff members can independently be confirmed for the same Friday.
exports.bulkSetAttendance = async (req, res) => {
  const { record_date, entries } = req.body || {};
  const supervisorId = req.user.user_id;

  if (!isValidDateOnly(record_date)) {
    return res.status(400).json({
      status: 'error',
      message: 'A valid record_date (YYYY-MM-DD) is required.'
    });
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'At least one attendance entry is required.'
    });
  }

  const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Sick', 'Vacation', 'Holiday'];
  const dayIsFriday = isFriday(record_date);
  const assignedIds = await getAssignedStaffIdsForSupervisor(supervisorId);
  const assignedSet = new Set(assignedIds);

  const connection = await db.getConnection();
  const results = { updated: [], skipped: [] };

  try {
    await connection.beginTransaction();

    for (const entry of entries) {
      const staffId = Number(entry.staff_id);
      const status = entry.attendance_status;

      if (
        !Number.isInteger(staffId) ||
        staffId <= 0 ||
        !ATTENDANCE_STATUSES.includes(status)
      ) {
        results.skipped.push({
          staff_id: entry.staff_id,
          reason: 'Invalid entry'
        });
        continue;
      }

      if (!assignedSet.has(staffId)) {
        results.skipped.push({
          staff_id: staffId,
          reason: 'Staff member is not assigned to you.'
        });
        continue;
      }

      // Friday is a non-working day by default.
      // Recording Present on Friday requires explicit confirmation.
      const fridayConfirmed = entry.friday_confirmed === true;

      if (dayIsFriday && status === 'Present' && !fridayConfirmed) {
        results.skipped.push({
          staff_id: staffId,
          reason:
            'Friday is normally a non-working day. Confirmation is required to record attendance for this staff member.',
          requires_friday_confirmation: true,
        });
        continue;
      }

      const [staffRows] = await connection.execute(
        'SELECT standard_daily_hours, status FROM staff_members WHERE staff_id = ? FOR UPDATE',
        [staffId]
      );

      if (!staffRows.length || staffRows[0].status !== 'Active') {
        results.skipped.push({
          staff_id: staffId,
          reason: 'Staff member not found or inactive.'
        });
        continue;
      }

      const standardHours = Number(
        staffRows[0].standard_daily_hours || 8
      );

      let regularHours = 0;
      let overtimeHours = 0;
      let lunchHours = 0;
      let checkIn = null;
      let checkOut = null;

      if (status === 'Present') {
        const rawCheckIn = formatToMySqlDateTime(entry.check_in_time);
        const rawCheckOut = formatToMySqlDateTime(entry.check_out_time);

        if (!rawCheckIn || !rawCheckOut) {
          results.skipped.push({
            staff_id: staffId,
            reason:
              'Check-in and check-out times are required for Present status.'
          });
          continue;
        }

        try {
          const shift = calculateStaffShiftHours({
            checkInRaw: rawCheckIn,
            checkOutRaw: rawCheckOut,
            recordDate: record_date,
            standardDailyHours: standardHours,
          });

          regularHours = shift.regularHours;
          overtimeHours = shift.overtimeHours;
          lunchHours = shift.lunchHours;
          checkIn = rawCheckIn;
          checkOut = rawCheckOut;
        } catch (shiftError) {
          results.skipped.push({
            staff_id: staffId,
            reason: shiftError.message
          });
          continue;
        }
      }

      /*
       * Get the existing attendance row and lock it.
       * We keep the old values because they are needed for:
       * 1. detecting whether anything actually changed
       * 2. creating an accurate audit record
       */
      const [existing] = await connection.execute(
        `SELECT
           staff_attendance_id,
           attendance_status,
           check_in_time,
           check_out_time,
           regular_hours,
           overtime_hours,
           lunch_deducted_hours,
           is_friday_worked,
           friday_confirmed_by_user_id,
           recorded_by_user_id,
           status
         FROM staff_attendance
         WHERE staff_id = ? AND record_date = ?
         LIMIT 1
         FOR UPDATE`,
        [staffId, record_date]
      );

      const isFridayWorked =
        dayIsFriday && status === 'Present' && fridayConfirmed ? 1 : 0;

      const fridayConfirmedBy =
        isFridayWorked ? supervisorId : null;

      /*
       * ============================================================
       * EXISTING ATTENDANCE
       * ============================================================
       */
      if (existing.length > 0) {
        const existingRecord = existing[0];

        if (existingRecord.status === 'Approved') {
          results.skipped.push({
            staff_id: staffId,
            reason: 'Already approved by Admin; cannot modify.'
          });
          continue;
        }

        /*
         * Keep the values that matter for attendance history.
         * We intentionally do NOT audit internal approval fields here.
         */
        const oldValues = {
          record_date,
          attendance_status: existingRecord.attendance_status,
          check_in_time: existingRecord.check_in_time,
          check_out_time: existingRecord.check_out_time,
          regular_hours: Number(existingRecord.regular_hours || 0),
          overtime_hours: Number(existingRecord.overtime_hours || 0),
          lunch_deducted_hours: Number(
            existingRecord.lunch_deducted_hours || 0
          ),
          is_friday_worked: Number(
            existingRecord.is_friday_worked || 0
          ),
          friday_confirmed_by_user_id:
            existingRecord.friday_confirmed_by_user_id,
        };

        const newValues = {
          record_date,
          attendance_status: status,
          check_in_time: checkIn,
          check_out_time: checkOut,
          regular_hours: Number(regularHours.toFixed(2)),
          overtime_hours: Number(overtimeHours.toFixed(2)),
          lunch_deducted_hours: Number(lunchHours.toFixed(2)),
          is_friday_worked: isFridayWorked,
          friday_confirmed_by_user_id: fridayConfirmedBy,
        };

        /*
         * Compare only the attendance values.
         * If absolutely nothing changed, we still keep the existing
         * behavior of resubmitting the record, but we DO NOT create
         * a useless audit record.
         */
        const attendanceChanged =
          oldValues.attendance_status !== newValues.attendance_status ||
          String(oldValues.check_in_time || '') !==
            String(newValues.check_in_time || '') ||
          String(oldValues.check_out_time || '') !==
            String(newValues.check_out_time || '') ||
          Number(oldValues.regular_hours) !==
            Number(newValues.regular_hours) ||
          Number(oldValues.overtime_hours) !==
            Number(newValues.overtime_hours) ||
          Number(oldValues.lunch_deducted_hours) !==
            Number(newValues.lunch_deducted_hours) ||
          Number(oldValues.is_friday_worked) !==
            Number(newValues.is_friday_worked) ||
          Number(oldValues.friday_confirmed_by_user_id || 0) !==
            Number(newValues.friday_confirmed_by_user_id || 0);

        await connection.execute(
          `UPDATE staff_attendance
           SET attendance_status = ?, check_in_time = ?, check_out_time = ?,
               regular_hours = ?, overtime_hours = ?, lunch_deducted_hours = ?,
               is_friday_worked = ?, friday_confirmed_by_user_id = ?,
               status = 'Submitted', recorded_by_user_id = ?,
               admin_rejection_notes = NULL, approved_by_user_id = NULL, approval_date = NULL
           WHERE staff_attendance_id = ?`,
          [
            status,
            checkIn,
            checkOut,
            regularHours.toFixed(2),
            overtimeHours.toFixed(2),
            lunchHours.toFixed(2),
            isFridayWorked,
            fridayConfirmedBy,
            supervisorId,
            existingRecord.staff_attendance_id,
          ]
        );

        /*
         * Create an audit record ONLY when attendance data actually changed.
         */
        if (attendanceChanged) {
          await connection.execute(
            `INSERT INTO auditlogs
               (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES
               ('staff_attendance', ?, 'SUPERVISOR_ATTENDANCE_UPDATED', ?, ?, ?)`,
            [
              existingRecord.staff_attendance_id,
              supervisorId,
              JSON.stringify(oldValues),
              JSON.stringify(newValues),
            ]
          );
        }

        results.updated.push(staffId);
      }

      /*
       * ============================================================
       * NEW ATTENDANCE
       * ============================================================
       */
      else {
        const [insertResult] = await connection.execute(
          `INSERT INTO staff_attendance
             (staff_id, record_date, attendance_status, check_in_time, check_out_time,
              regular_hours, overtime_hours, lunch_deducted_hours,
              is_friday_worked, friday_confirmed_by_user_id,
              recorded_by_user_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted')`,
          [
            staffId,
            record_date,
            status,
            checkIn,
            checkOut,
            regularHours.toFixed(2),
            overtimeHours.toFixed(2),
            lunchHours.toFixed(2),
            isFridayWorked,
            fridayConfirmedBy,
            supervisorId,
          ]
        );

        const staffAttendanceId = insertResult.insertId;

        /*
         * New attendance gets its own audit record.
         * old_values = NULL because there was no previous record.
         */
        await connection.execute(
          `INSERT INTO auditlogs
             (table_name, record_id, action_type, user_id, old_values, new_values)
           VALUES
             ('staff_attendance', ?, 'SUPERVISOR_ATTENDANCE_CREATED', ?, NULL, ?)`,
          [
            staffAttendanceId,
            supervisorId,
            JSON.stringify({
              staff_id: staffId,
              record_date,
              attendance_status: status,
              check_in_time: checkIn,
              check_out_time: checkOut,
              regular_hours: Number(regularHours.toFixed(2)),
              overtime_hours: Number(overtimeHours.toFixed(2)),
              lunch_deducted_hours: Number(lunchHours.toFixed(2)),
              is_friday_worked: isFridayWorked,
              friday_confirmed_by_user_id: fridayConfirmedBy,
            }),
          ]
        );

        results.updated.push(staffId);
      }
    }

    await connection.commit();

    res.status(200).json({
      status: 'success',
      message: `${results.updated.length} record(s) submitted for review.`,
      data: results
    });
  } catch (error) {
    await connection.rollback();

    console.error(
      'SUPERVISOR BULK SET STAFF ATTENDANCE ERROR:',
      error
    );

    res.status(500).json({
      status: 'error',
      message: 'Failed to submit staff attendance.'
    });
  } finally {
    connection.release();
  }
};