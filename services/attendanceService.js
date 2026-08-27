const db = require('../config/db');
const settingsCache = require('./settingsCache');

function parseWallClockDateTime(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value));
    if (!match) return null;

    const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (Number.isNaN(date.getTime())) return null;
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day || date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
    return date;
}

exports.calculateWorkingHours = async (attendance_id, executor = db) => {
    const [rows] = await executor.execute(
        `SELECT check_in_time, check_out_time, record_date, management_leave_hours
         FROM attendance WHERE attendance_id = ?`,
        [attendance_id]
    );
    if (rows.length === 0) throw new Error('Attendance record not found.');

    const { check_in_time, check_out_time, record_date, management_leave_hours } = rows[0];
    const start = parseWallClockDateTime(check_in_time);
    const end = parseWallClockDateTime(check_out_time);
    if (!start || !end) throw new Error('Cannot calculate hours without valid check-in and check-out times.');
    if (end <= start) throw new Error('Check-out must be after check-in.');

    let totalMinutes = (end.getTime() - start.getTime()) / 60000;
    const isLunchPaid = String(await settingsCache.getSetting('is_lunch_paid', 'false')).toLowerCase() === 'true';
    const [leaves] = await executor.execute(
        `SELECT leave_start_time, leave_end_time, leave_type
         FROM attendanceleaveperiods
         WHERE attendance_id = ? AND leave_end_time IS NOT NULL`,
        [attendance_id]
    );

    for (const leave of leaves) {
        const leaveStart = parseWallClockDateTime(leave.leave_start_time);
        const leaveEnd = parseWallClockDateTime(leave.leave_end_time);
        if (!leaveStart || !leaveEnd || leaveEnd <= leaveStart) throw new Error(`Invalid leave period for attendance ${attendance_id}.`);
        if (leaveStart < start || leaveEnd > end) throw new Error(`Leave period is outside attendance shift ${attendance_id}.`);
        const duration = (leaveEnd.getTime() - leaveStart.getTime()) / 60000;
        if (leave.leave_type === 'Rest' || (leave.leave_type === 'Lunch' && !isLunchPaid)) totalMinutes -= duration;
    }

    const managementHours = Number(management_leave_hours || 0);
    if (!Number.isFinite(managementHours) || managementHours < 0) throw new Error('Invalid management leave hours.');
    totalMinutes = Math.max(0, totalMinutes + managementHours * 60);

    const configuredStandardMinutes = Number(await settingsCache.getSetting('standard_work_minutes', '600'));
    const standardMinutes = Number.isFinite(configuredStandardMinutes) && configuredStandardMinutes > 0 ? configuredStandardMinutes : 600;
    const regularHours = Math.min(999.99, Math.min(totalMinutes, standardMinutes) / 60);
    const overtimeHours = Math.min(99.99, Math.max(0, totalMinutes - standardMinutes) / 60);

    await executor.execute(
        `UPDATE attendance SET total_working_hours = ?, overtime_hours = ? WHERE attendance_id = ?`,
        [regularHours.toFixed(2), overtimeHours.toFixed(2), attendance_id]
    );

    console.log(`Calculation: ID=${attendance_id}, record_date=${String(record_date).slice(0, 10)}, regular=${regularHours.toFixed(2)}, overtime=${overtimeHours.toFixed(2)}`);
};

exports.parseWallClockDateTime = parseWallClockDateTime;
