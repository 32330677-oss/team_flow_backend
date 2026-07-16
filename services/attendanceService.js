const db = require('../config/db');

exports.calculateWorkingHours = async (attendance_id) => {
    try {
        const [rows] = await db.execute(
            'SELECT check_in_time, check_out_time, record_date FROM attendance WHERE attendance_id = ?', 
            [attendance_id]
        );
        if (rows.length === 0) return;

        const { check_in_time, check_out_time, record_date } = rows[0];
        let start = new Date(check_in_time);
        let end = new Date(check_out_time);
        
        let totalMinutes = (end - start) / (1000 * 60);

        // 1. خصم الاستراحات اليدوية (من جدول attendanceleaveperiods)
        const [leaves] = await db.execute(
            'SELECT leave_start_time, leave_end_time FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NOT NULL', 
            [attendance_id]
        );
        leaves.forEach(l => {
            totalMinutes -= (new Date(l.leave_end_time) - new Date(l.leave_start_time)) / (1000 * 60);
        });

        // 2. خصم ساعة الغداء التلقائي (12:00 - 13:00)
        // إنشاء تواريخ لبداية ونهاية فترة الغداء بناءً على تاريخ السجل
        const dateStr = new Date(record_date).toISOString().split('T')[0];
        const lunchStart = new Date(`${dateStr}T12:00:00`);
        const lunchEnd = new Date(`${dateStr}T13:00:00`);

        // المنطق: إذا كان العامل بدأ قبل الغداء وانتهى بعده، نخصم ساعة (60 دقيقة)
        if (start < lunchEnd && end > lunchStart) {
            // حساب التقاطع بين فترة العمل وفترة الغداء
            const overlapStart = start > lunchStart ? start : lunchStart;
            const overlapEnd = end < lunchEnd ? end : lunchEnd;
            const overlapMinutes = (overlapEnd - overlapStart) / (1000 * 60);
            
            if (overlapMinutes > 0) {
                totalMinutes -= overlapMinutes;
            }
        }

        // 3. فصل ساعات العمل العادية عن الأوفر تايم
        const standardMinutes = 480; // 8 ساعات
        let regularMinutes = Math.min(totalMinutes, standardMinutes);
        let overtimeMinutes = Math.max(0, totalMinutes - standardMinutes);

        const regularHours = regularMinutes / 60;
        const overtimeHours = overtimeMinutes / 60;

        // 4. التحديث في قاعدة البيانات
        await db.execute(
            'UPDATE attendance SET total_working_hours = ?, overtime_hours = ? WHERE attendance_id = ?', 
            [regularHours.toFixed(2), overtimeHours.toFixed(2), attendance_id]
        );
        
        console.log(`✅ Calculation: Total=${regularHours.toFixed(2)}, OT=${overtimeHours.toFixed(2)}`);
    } catch (error) {
        console.error("❌ Error in calculation:", error);
        throw error;
    }
};