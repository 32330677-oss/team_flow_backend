const db = require('../config/db');

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

// GET /api/staff-attendance/admin/day?date=YYYY-MM-DD
exports.getDayView = async (req, res) => {
  const { date } = req.query;
  if (!isValidDateOnly(date)) {
    return res.status(400).json({ status: 'error', message: 'A valid date (YYYY-MM-DD) is required.' });
  }
  try {
    const [rows] = await db.execute(
      `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position, sm.standard_daily_hours,
              sa.staff_attendance_id, sa.attendance_status, sa.check_in_time, sa.check_out_time,
              sa.regular_hours, sa.overtime_hours, sa.status
       FROM staff_members sm
       LEFT JOIN staff_attendance sa ON sa.staff_id = sm.staff_id AND sa.record_date = ?
       WHERE sm.status = 'Active'
       ORDER BY sm.full_name`,
      [date]
    );
    res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET STAFF DAY VIEW ERROR:', error);
    res.status(500).json({ status: 'error', message: 'Failed to load staff attendance for this date.' });
  }
};

// POST /api/staff-attendance/admin/bulk-set
// body: { record_date, entries: [{ staff_id, attendance_status, check_in_time, check_out_time }] }
exports.bulkSetAttendance = async (req, res) => {
  const { record_date, entries } = req.body || {};
  const adminId = req.user.user_id;

  if (!isValidDateOnly(record_date)) {
    return res.status(400).json({ status: 'error', message: 'A valid record_date (YYYY-MM-DD) is required.' });
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ status: 'error', message: 'At least one attendance entry is required.' });
  }

  const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Sick', 'Vacation', 'Holiday'];
  const today = new Date().toISOString().slice(0, 10);

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

      const [staffRows] = await connection.execute(
        'SELECT standard_daily_hours, status FROM staff_members WHERE staff_id = ? FOR UPDATE',
        [staffId]
      );
      if (!staffRows.length || staffRows[0].status !== 'Active') {
        results.skipped.push({ staff_id: staffId, reason: 'Staff member not found or inactive.' });
        continue;
      }
      const standardHours = Number(staffRows[0].standard_daily_hours || 8);

      let regularHours = 0;
      let overtimeHours = 0;
      let checkIn = null;
      let checkOut = null;

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
        'SELECT staff_attendance_id FROM staff_attendance WHERE staff_id = ? AND record_date = ? LIMIT 1 FOR UPDATE',
        [staffId, record_date]
      );

      if (existing.length > 0) {
        await connection.execute(
          `UPDATE staff_attendance
           SET attendance_status = ?, check_in_time = ?, check_out_time = ?,
               regular_hours = ?, overtime_hours = ?,
               status = 'Approved', approved_by_user_id = ?, approval_date = NOW(),
               admin_rejection_notes = NULL, recorded_by_user_id = ?
           WHERE staff_attendance_id = ?`,
          [status, checkIn, checkOut, regularHours.toFixed(2), overtimeHours.toFixed(2), adminId, adminId, existing[0].staff_attendance_id]
        );
      } else {
        await connection.execute(
          `INSERT INTO staff_attendance
             (staff_id, record_date, attendance_status, check_in_time, check_out_time,
              regular_hours, overtime_hours, recorded_by_user_id, status, approved_by_user_id, approval_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Approved', ?, NOW())`,
          [staffId, record_date, status, checkIn, checkOut, regularHours.toFixed(2), overtimeHours.toFixed(2), adminId, adminId]
        );
      }

      await connection.execute(
        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
         VALUES ('staff_attendance', ?, 'ADMIN_BULK_SET', ?, NULL, ?)`,
        [staffId, adminId, JSON.stringify({ record_date, status, checkIn, checkOut, regularHours, overtimeHours, backdated: record_date !== today })]
      );

      results.updated.push(staffId);
    }

    await connection.commit();
    res.status(200).json({ status: 'success', message: `${results.updated.length} record(s) saved.`, data: results });
  } catch (error) {
    await connection.rollback();
    console.error('BULK SET STAFF ATTENDANCE ERROR:', error);
    res.status(500).json({ status: 'error', message: 'Failed to save staff attendance.' });
  } finally {
    connection.release();
  }
};