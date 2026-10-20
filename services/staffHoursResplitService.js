// services/staffHoursResplitService.js
//
// When a staff member's standard daily hours change with an effective date in
// the past (e.g. 8 -> 10 from 2026-09-21), the attendance records already saved
// on those days still carry the old rule: regular hours capped at 8 and the
// rest stored as overtime. Payroll pays the same amount either way (the day's
// required hours come from the compensation history), but every screen and
// report showed wrong regular / overtime / shortage hours.
//
// This re-splits those records with the new standard:
//   net hours stay exactly the same (regular + overtime),
//   regular  = min(net, new standard)
//   overtime = max(0, net - new standard)
//   standard_minutes_snapshot = new standard
// Only Present records are touched (leave / absence rows carry no hours).
// Days inside a Finalized or Paid staff payroll are LEFT AS THEY ARE (their
// payroll is locked) and reported back. Every changed record is audited
// (STANDARD_HOURS_RESPLIT).

const { round2 } = require('./staffAttendanceService');
const { findLockedStaffBatch } = require('./payrollLock');

const dateOnly = (v) => (v ? String(v).slice(0, 10) : null);

async function resplitStaffAttendance(executor, {
  staffId, fromDate, toDate = null, standardHours, userId = null, reason = null,
}) {
  const hours = Number(standardHours);
  if (!(hours > 0 && hours <= 24)) throw new Error('Invalid standard hours for re-split.');
  const newMinutes = Math.round(hours * 60);

  const [rows] = await executor.execute(
    `SELECT staff_attendance_id, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date,
            regular_hours, overtime_hours, standard_minutes_snapshot, status
     FROM staff_attendance
     WHERE staff_id = ? AND attendance_status = 'Present'
       AND record_date >= ? ${toDate ? 'AND record_date <= ?' : ''}
     ORDER BY record_date
     FOR UPDATE`,
    toDate ? [staffId, fromDate, toDate] : [staffId, fromDate]
  );

  const result = { updated: [], locked: [], unchanged: 0 };
  const lockByDate = new Map();
  for (const r of rows) {
    const day = dateOnly(r.record_date);
    const oldReg = Number(r.regular_hours || 0);
    const oldOt = Number(r.overtime_hours || 0);
    const net = round2(oldReg + oldOt);
    const newReg = round2(Math.min(net, hours));
    const newOt = round2(Math.max(0, net - hours));
    if (Number(r.standard_minutes_snapshot) === newMinutes
        && Math.abs(newReg - oldReg) < 0.005 && Math.abs(newOt - oldOt) < 0.005) {
      result.unchanged += 1;
      continue;
    }
    if (!lockByDate.has(day)) lockByDate.set(day, await findLockedStaffBatch(executor, { date: day }));
    const lock = lockByDate.get(day);
    if (lock) {
      result.locked.push({ record_date: day, staff_payroll_batch_id: lock.staff_payroll_batch_id });
      continue;
    }
    await executor.execute(
      `UPDATE staff_attendance
       SET regular_hours = ?, overtime_hours = ?, standard_minutes_snapshot = ?
       WHERE staff_attendance_id = ?`,
      [newReg, newOt, newMinutes, r.staff_attendance_id]
    );
    await executor.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_attendance', ?, 'STANDARD_HOURS_RESPLIT', ?, ?, ?)`,
      [r.staff_attendance_id, userId,
        JSON.stringify({ regular_hours: oldReg, overtime_hours: oldOt, standard_minutes_snapshot: r.standard_minutes_snapshot }),
        JSON.stringify({ regular_hours: newReg, overtime_hours: newOt, standard_minutes_snapshot: newMinutes, reason })]
    );
    result.updated.push({ record_date: day, regular_hours: newReg, overtime_hours: newOt });
  }
  return result;
}

module.exports = { resplitStaffAttendance };