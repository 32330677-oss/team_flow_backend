const db = require('../config/db');
const settingsCache = require('./settingsCache');

function parseWallClockDateTime(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value));
    if (!match) return null;
    const [, year, month, day, hour, minute, second = '00'] = match;
    const date = new Date(Date.UTC(
        Number(year), Number(month) - 1, Number(day),
        Number(hour), Number(minute), Number(second),
    ));
    return Number.isNaN(date.getTime()) ? null : date;
}

exports.calculateWorkingHours = async (attendance_id) => {
    try {
        const [rows] = await db.execute(
            `SELECT check_in_time, check_out_time, record_date, management_leave_hours
             FROM attendance WHERE attendance_id = ?`,
            [attendance_id]
        );
        if (rows.length === 0) return;

        const { check_in_time, check_out_time, record_date, management_leave_hours } = rows[0];
        const start = parseWallClockDateTime(check_in_time);
        const end = parseWallClockDateTime(check_out_time);
        if (!start || !end) {
            throw new Error('Cannot calculate hours without valid check-in and check-out times');
        }
        if (end <= start) {
            throw new Error('Check-out must be after check-in');
        }

        let totalMinutes = (end.getTime() - start.getTime()) / 60000;
        const isLunchPaid = String(await settingsCache.getSetting('is_lunch_paid', 'false')).toLowerCase() === 'true';

        const [leaves] = await db.execute(
            `SELECT leave_start_time, leave_end_time, leave_type
             FROM attendanceleaveperiods
             WHERE attendance_id = ? AND leave_end_time IS NOT NULL`,
            [attendance_id]
        );

        for (const leave of leaves) {
            const leaveStart = parseWallClockDateTime(leave.leave_start_time);
            const leaveEnd = parseWallClockDateTime(leave.leave_end_time);
            if (!leaveStart || !leaveEnd || leaveEnd <= leaveStart) {
                throw new Error(`Invalid leave period for attendance ${attendance_id}`);
            }
            const duration = (leaveEnd.getTime() - leaveStart.getTime()) / 60000;
            if (leave.leave_type === 'Rest' || (leave.leave_type === 'Lunch' && !isLunchPaid)) {
                totalMinutes -= duration;
            }
        }

        totalMinutes = Math.max(0, totalMinutes + Math.max(0, Number(management_leave_hours || 0)) * 60);
        const configuredStandardMinutes = Number(await settingsCache.getSetting('standard_work_minutes', '600'));
        const standardMinutes = Number.isFinite(configuredStandardMinutes) && configuredStandardMinutes > 0
            ? configuredStandardMinutes
            : 600;
        const regularMinutes = Math.min(totalMinutes, standardMinutes);
        const overtimeMinutes = Math.max(0, totalMinutes - standardMinutes);

        const regularHours = Math.min(999.99, regularMinutes / 60);
        const overtimeHours = Math.min(99.99, overtimeMinutes / 60);

        await db.execute(
            `UPDATE attendance
             SET total_working_hours = ?, overtime_hours = ?
             WHERE attendance_id = ?`,
            [regularHours.toFixed(2), overtimeHours.toFixed(2), attendance_id]
        );

        console.log(
            `Calculation: ID=${attendance_id}, record_date=${String(record_date).slice(0, 10)}, ` +
            `regular=${regularHours.toFixed(2)}, overtime=${overtimeHours.toFixed(2)}`
        );
    } catch (error) {
        console.error('Error in working-hours calculation:', error);
        throw error;
    }
};

exports.parseWallClockDateTime = parseWallClockDateTime;
