const db = require('../config/db');

exports.calculateWorkingHours = async (attendance_id) => {
    try {
        const [rows] = await db.execute(
            'SELECT check_in_time, check_out_time, record_date FROM attendance WHERE attendance_id = ?', 
            [attendance_id]
        );
        if (rows.length === 0) return;

        const { check_in_time, check_out_time, record_date } = rows[0];
        
        // التحقق من وجود وقت الخروج
        if (!check_out_time) {
            throw new Error('لا يمكن حساب الساعات بدون وقت خروج');
        }

        let start = new Date(check_in_time);
        let end = new Date(check_out_time);
        
        // حساب إجمالي الدقائق والتأكد أنها ليست سالبة
        let totalMinutes = Math.max(0, (end - start) / (1000 * 60));

        // 1. خصم الاستراحات اليدوية
        const [leaves] = await db.execute(
            'SELECT leave_start_time, leave_end_time FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NOT NULL', 
            [attendance_id]
        );
        leaves.forEach(l => {
            let leaveDuration = (new Date(l.leave_end_time) - new Date(l.leave_start_time)) / (1000 * 60);
            totalMinutes -= Math.max(0, leaveDuration);
        });

        // 2. خصم ساعة الغداء التلقائي
        const dateStr = new Date(record_date).toISOString().split('T')[0];
        const lunchStart = new Date(`${dateStr}T12:00:00`);
        const lunchEnd = new Date(`${dateStr}T13:00:00`);

        if (start < lunchEnd && end > lunchStart) {
            const overlapStart = start > lunchStart ? start : lunchStart;
            const overlapEnd = end < lunchEnd ? end : lunchEnd;
            const overlapMinutes = Math.max(0, (overlapEnd - overlapStart) / (1000 * 60));
            totalMinutes -= overlapMinutes;
        }

        // 3. فصل ساعات العمل (مع حماية القيم من السالب)
        totalMinutes = Math.max(0, totalMinutes);
        const standardMinutes = 480; 
        let regularMinutes = Math.min(totalMinutes, standardMinutes);
        let overtimeMinutes = Math.max(0, totalMinutes - standardMinutes);

        const regularHours = Math.min(999.99, (regularMinutes / 60)); // تحديد حد أقصى للحماية
        const overtimeHours = Math.min(999.99, (overtimeMinutes / 60));

        // 4. التحديث في قاعدة البيانات مع استخدام القيم الآمنة
        await db.execute(
            'UPDATE attendance SET total_working_hours = ?, overtime_hours = ? WHERE attendance_id = ?', 
            [regularHours.toFixed(2), overtimeHours.toFixed(2), attendance_id]
        );
        
        console.log(`✅ Calculation: ID=${attendance_id}, Total=${regularHours.toFixed(2)}, OT=${overtimeHours.toFixed(2)}`);
    } catch (error) {
        console.error("❌ Error in calculation:", error);
        throw error;
    }
};