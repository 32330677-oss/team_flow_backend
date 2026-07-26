const db = require('../config/db');
const settingsCache = require('./settingsCache');

// Extracts YYYY-MM-DD from a date using LOCAL date components instead of
// toISOString() (which converts to UTC and can shift the day backward/forward
// depending on the server's timezone offset relative to midnight).
function formatLocalDate(dateInput) {
    const d = new Date(dateInput);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

exports.calculateWorkingHours = async (attendance_id) => {
    try {
        const [rows] = await db.execute(
            'SELECT check_in_time, check_out_time, record_date, management_leave_hours FROM attendance WHERE attendance_id = ?',
            [attendance_id]
        );
        if (rows.length === 0) return;

        const { check_in_time, check_out_time, record_date, management_leave_hours } = rows[0];

        if (!check_out_time) {
            throw new Error('Cannot calculate hours without a check-out time');
        }

        const start = new Date(check_in_time);
        const end = new Date(check_out_time);
        let totalMinutes = Math.max(0, (end - start) / (1000 * 60));

        // 1) Deduct manual break periods (Rest only) — other leave types
        //    (Sick, Annual, Management) are NOT deducted from worked time,
        //    since they represent excused/compensated time, not unpaid breaks.
        const [leaves] = await db.execute(
            `SELECT leave_start_time, leave_end_time, leave_type FROM attendanceleaveperiods
             WHERE attendance_id = ? AND leave_end_time IS NOT NULL`,
            [attendance_id]
        );
        leaves.forEach(l => {
            if (l.leave_type === 'Rest') {
                const dur = (new Date(l.leave_end_time) - new Date(l.leave_start_time)) / (1000 * 60);
                totalMinutes -= Math.max(0, dur);
            }
        });

        // 2) Deduct the configurable lunch break window (Dynamic from Cache)
        const dateStr = formatLocalDate(record_date);
        const lunchStartStr = await settingsCache.getSetting('lunch_start_time', '12:00:00');
        const lunchEndStr = await settingsCache.getSetting('lunch_end_time', '13:00:00');

        // No trailing 'Z', so JS interprets this as local time, not UTC.
        const lunchStart = new Date(`${dateStr}T${lunchStartStr}`);
        const lunchEnd = new Date(`${dateStr}T${lunchEndStr}`);

        if (start < lunchEnd && end > lunchStart) {
            const overlapStart = start > lunchStart ? start : lunchStart;
            const overlapEnd = end < lunchEnd ? end : lunchEnd;
            const overlapMinutes = Math.max(0, (overlapEnd - overlapStart) / (1000 * 60));
            totalMinutes -= overlapMinutes;
        }

        // Basic safety net: no negative values after any deduction.
        totalMinutes = Math.max(0, totalMinutes);

        // 3) Add Admin-granted management leave hours as actual extra worked hours.
        const mgmtMinutes = Math.max(0, Number(management_leave_hours || 0) * 60);
        totalMinutes += mgmtMinutes;

        // 4) Split regular hours from overtime hours (Dynamic from Cache)
        const standardMinutes = Number(await settingsCache.getSetting('standard_work_minutes', '480'));
        const regularMinutes = Math.min(totalMinutes, standardMinutes);
        const overtimeMinutes = Math.max(0, totalMinutes - standardMinutes);

        const regularHours = Math.min(999.99, regularMinutes / 60);
        const overtimeHours = Math.min(999.99, overtimeMinutes / 60);

        await db.execute(
            'UPDATE attendance SET total_working_hours = ?, overtime_hours = ? WHERE attendance_id = ?',
            [regularHours.toFixed(2), overtimeHours.toFixed(2), attendance_id]
        );

        console.log(`✅ Calculation: ID=${attendance_id}, Date=${dateStr}, Total=${regularHours.toFixed(2)}, OT=${overtimeHours.toFixed(2)}`);
    } catch (error) {
        console.error("❌ Error in calculation:", error);
        throw error;
    }
};