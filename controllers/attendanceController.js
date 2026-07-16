const db = require('../config/db');
const attendanceService = require('../services/attendanceService');

// دالة مساعدة لجلب معرف الحضور النشط لليوم الحالي
async function getAttendanceId(worker_id, site_id) {
    const [rows] = await db.execute(
        'SELECT attendance_id FROM attendance WHERE worker_id = ? AND site_id = ? AND record_date = CURDATE()',
        [worker_id, site_id]
    );
    return rows.length > 0 ? rows[0].attendance_id : null;
}

exports.getSiteWorkers = async (req, res) => {
    try {
        const { siteId } = req.params;
        const query = `
            SELECT w.*, a.attendance_id, a.status as attendance_status,
            (SELECT leave_id FROM attendanceleaveperiods alp 
             WHERE alp.attendance_id = a.attendance_id AND alp.leave_end_time IS NULL 
             LIMIT 1) as current_leave_id
            FROM workers w
            JOIN workersiteassignments wsa ON w.worker_id = wsa.worker_id
            LEFT JOIN attendance a ON w.worker_id = a.worker_id AND a.record_date = CURDATE()
            WHERE wsa.site_id = ? AND wsa.unassigned_date IS NULL AND w.status = 'Active'
        `;
        const [workers] = await db.execute(query, [siteId]);
        res.status(200).json({ status: 'success', data: workers });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};

// 2. تسجيل الحضور (بداية اليوم) - الحالة تصبح Active
exports.checkIn = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;
        const recorded_by_user_id = req.user.user_id; 

       await db.execute(
    `INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, status, recorded_by_user_id) 
     VALUES (?, ?, CURDATE(), NOW(), 'Draft', ?)`, // قمنا بتغيير 'Active' إلى 'Draft'
    [worker_id, site_id, recorded_by_user_id]
);
        res.status(201).json({ status: 'success', message: 'تم تسجيل الحضور (نشط)' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};

// 3. الإرسال النهائي لليوم (Submit Day) - الحساب والخصم التلقائي
exports.submitDay = async (req, res) => {
    try {
        const { siteId } = req.body;
        
        // تعديل الحالة هنا من "Active" إلى "Draft"
        const [records] = await db.execute(
            'SELECT attendance_id FROM attendance WHERE site_id = ? AND record_date = CURDATE() AND status = "Draft"',
            [siteId]
        );

        for (let record of records) {
            await attendanceService.calculateWorkingHours(record.attendance_id);
            // الآن نقوم بتحويلها إلى Submitted
            await db.execute('UPDATE attendance SET status = "Submitted" WHERE attendance_id = ?', [record.attendance_id]);
        }

        res.status(200).json({ status: 'success', message: 'تم إرسال اليوم للمراجعة بنجاح' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};

// 4. تسجيل الخروج النهائي (يُستخدم قبل الـ Submit)
exports.checkOut = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;
        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) return res.status(404).json({ message: 'سجل الحضور غير موجود!' });

        await db.execute('UPDATE attendance SET check_out_time = NOW() WHERE attendance_id = ?', [att_id]);
        res.status(200).json({ message: 'تم تسجيل الخروج.' });
    } catch (error) {
        res.status(500).json({ message: 'خطأ في عملية الخروج' });
    }
};
// جلب السجلات التي رفضها الأدمن لهذا المشرف
exports.getRejectedRecords = async (req, res) => {
    try {
        const supervisor_id = req.user.user_id;
        const [rows] = await db.execute(
            `SELECT a.*, w.full_name, s.site_name 
             FROM attendance a
             JOIN workers w ON a.worker_id = w.worker_id
             JOIN sites s ON a.site_id = s.site_id
             WHERE a.status = 'Rejected' AND a.recorded_by_user_id = ?`,
            [supervisor_id]
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};
// 5. إدارة الاستراحات (بدون تغيير، تعمل كما هي)
exports.startLeave = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;
        
        // 1. جلب الـ attendance_id النشط للعامل لهذا اليوم
        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) {
            return res.status(404).json({ message: 'لا يوجد سجل حضور نشط لهذا العامل!' });
        }

        // 2. إضافة فترة استراحة جديدة في جدول attendanceleaveperiods
        await db.execute(
            'INSERT INTO attendanceleaveperiods (attendance_id, leave_start_time) VALUES (?, NOW())',
            [att_id]
        );

        res.status(200).json({ status: 'success', message: 'تم بدء الاستراحة بنجاح' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};
exports.endLeave = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;
        
        // 1. جلب الـ attendance_id النشط للعامل
        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) {
            return res.status(404).json({ message: 'سجل الحضور غير موجود!' });
        }

        // 2. تحديث آخر فترة استراحة لم تُغلق بعد (leave_end_time هو NULL)
        const [result] = await db.execute(
            `UPDATE attendanceleaveperiods 
             SET leave_end_time = NOW() 
             WHERE attendance_id = ? AND leave_end_time IS NULL 
             ORDER BY leave_id DESC LIMIT 1`,
            [att_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'لا توجد استراحة نشطة لإنهائها!' });
        }

        res.status(200).json({ status: 'success', message: 'تم إنهاء الاستراحة بنجاح' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};