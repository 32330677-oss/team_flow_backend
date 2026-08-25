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

        // جلب إعداد ما إذا كان وقت الغداء مدفوعاً أم لا
        const isLunchPaid = (await settingsCache.getSetting('is_lunch_paid', 'false')) === 'true';

        // 1) Deduct manual break periods (Rest & Lunch based on settings)
        const [leaves] = await db.execute(
            `SELECT leave_start_time, leave_end_time, leave_type FROM attendanceleaveperiods
             WHERE attendance_id = ? AND leave_end_time IS NOT NULL`,
            [attendance_id]
        );
        
        leaves.forEach(l => {
            const duration = Math.max(0, (new Date(l.leave_end_time) - new Date(l.leave_start_time)) / (1000 * 60));
            if (l.leave_type === 'Rest') {
                // Rest دايماً غير مدفوعة
                totalMinutes -= duration;
            } else if (l.leave_type === 'Lunch' && !isLunchPaid) {
                // الغدا بتنخصم بس إذا القرار العام "غير مدفوعة"
                totalMinutes -= duration;
            }
            // لو isLunchPaid = true، ما ينخصم شي وبتضل ضمن ساعات العمل
        });

        // Basic safety net: no negative values after any deduction.
        totalMinutes = Math.max(0, totalMinutes);

        // 2) Add Admin-granted management leave hours as actual extra worked hours.
        const mgmtMinutes = Math.max(0, Number(management_leave_hours || 0) * 60);
        totalMinutes += mgmtMinutes;

        // 3) Split regular hours from overtime hours (Dynamic from Cache)
        const standardMinutes = Number(await settingsCache.getSetting('standard_work_minutes', '480'));
        const regularMinutes = Math.min(totalMinutes, standardMinutes);
        const overtimeMinutes = Math.max(0, totalMinutes - standardMinutes);

        const regularHours = Math.min(999.99, regularMinutes / 60);
        const overtimeHours = Math.min(999.99, overtimeMinutes / 60);

        await db.execute(
            'UPDATE attendance SET total_working_hours = ?, overtime_hours = ? WHERE attendance_id = ?',
            [regularHours.toFixed(2), overtimeHours.toFixed(2), attendance_id]
        );

        const dateStr = formatLocalDate(record_date);
        console.log(`✅ Calculation: ID=${attendance_id}, Date=${dateStr}, Total=${regularHours.toFixed(2)}, OT=${overtimeHours.toFixed(2)}`);
    } catch (error) {
        console.error("❌ Error in calculation:", error);
        throw error;
    }
};