const db = require('../config/db'); // تأكد من مسار اتصال قاعدة البيانات لديك

// 1. جلب عمال الموقع المحدد مع التحقق من صلاحية المشرف (Authorization)
exports.getSiteWorkers = async (req, res) => {
    // 1. الحصول على ID المشرف من الـ Middleware
    const supervisorId = req.user.user_id;
    const { siteId } = req.params;

    try {
        console.log("🔍 Debugging: Started getSiteWorkers for Site:", siteId);

        // 2. التحقق من أن هذا الموقع يتبع فعلاً لهذا المشرف
        const [siteCheck] = await db.execute(
            'SELECT supervisor_id FROM sites WHERE site_id = ?',
            [siteId]
        );

        if (siteCheck.length === 0) {
            return res.status(404).json({ status: 'fail', message: 'الموقع غير موجود.' });
        }

        // مقارنة القيم كأرقام (لضمان الدقة)
        if (Number(siteCheck[0].supervisor_id) !== Number(supervisorId)) {
            return res.status(403).json({ status: 'fail', message: 'غير مصرح لك بالوصول لعمال هذا الموقع.' });
        }

        // 3. الاستعلام لجلب العمال (تم التأكد من الربط)
        const query = `
            SELECT w.worker_id, w.full_name, w.job_position, w.status
            FROM workers w
            INNER JOIN workersiteassignments wa ON w.worker_id = wa.worker_id
            WHERE wa.site_id = ? 
              AND wa.unassigned_date IS NULL 
              AND w.status = 'Active'
        `;
        
        const [workers] = await db.execute(query, [siteId]);

        // 🚨 طباعة النتيجة لنتأكد ماذا يرى السيرفر
        console.log("✅ Query Result (Workers Found):", workers);

        return res.status(200).json({ 
            status: 'success', 
            results: workers.length,
            data: workers 
        });

    } catch (error) {
        console.error('🚨 Error in getSiteWorkers:', error);
        return res.status(500).json({ 
            status: 'error', 
            message: 'حدث خطأ في السيرفر أثناء جلب العمال.' 
        });
    }
};

// 2. تسجيل الحضور والغياب للموقع (MVP)
exports.submitAttendance = async (req, res) => {
    const supervisorId = req.user.user_id;
    const { siteId, attendance } = req.body; // الـ siteId يتم إرساله بالـ Body للتحقق والـ Audit

    if (!siteId || !attendance || !Array.isArray(attendance)) {
        return res.status(400).json({ message: 'بيانات الحضور غير مكتملة أو غير صالحة.' });
    }

    try {
        // أ) التحقق من صلاحية المشرف للموقع
        const [siteCheck] = await db.execute(
            'SELECT supervisor_id FROM sites WHERE site_id = ?',
            [siteId]
        );

        if (siteCheck.length === 0 || siteCheck[0].supervisor_id !== supervisorId) {
            return res.status(403).json({ message: 'غير مصرح لك بتسجيل حضور لهذا الموقع.' });
        }

        const today = new Date().toISOString().slice(0, 10); // تاريخ اليوم بتنسيق YYYY-MM-DD

        // ب) التحقق من العمال وحفظ الحضور
        const insertPromises = attendance.map(async (record) => {
            const { worker_id, status } = record; // status هنا هو 'Present' أو 'Absent'

            // جلب التحقق: هل العامل نشط ومعين في هذا الموقع حالياً؟
            const [assignmentCheck] = await db.execute(
                `SELECT assignment_id FROM workersiteassignments 
                 WHERE worker_id = ? AND site_id = ? AND unassigned_date IS NULL`,
                [worker_id, siteId]
            );

            if (assignmentCheck.length > 0) {
                // حفظ السجل في جدول attendance (نسخة MVP)
                await db.execute(
                    `INSERT INTO attendance 
                     (worker_id, site_id, record_date, attendance_status, recorded_by_user_id, status) 
                     VALUES (?, ?, ?, ?, ?, 'Pending')
                     ON DUPLICATE KEY UPDATE attendance_status = ?, recorded_by_user_id = ?, updated_at = CURRENT_TIMESTAMP`,
                    [worker_id, siteId, today, status, supervisorId, status, supervisorId]
                );
            } else {
                console.warn(`Worker ID ${worker_id} is not assigned to site ${siteId}. Skipping.`);
            }
        });

        await Promise.all(insertPromises);

        return res.status(201).json({ status: 'success', message: 'تم حفظ سجل الحضور بنجاح!' });

    } catch (error) {
        console.error('Error in submitAttendance:', error);
        return res.status(500).json({ message: 'حدث خطأ في السيرفر أثناء حفظ الحضور.' });
    }
};