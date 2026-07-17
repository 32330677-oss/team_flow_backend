const db = require('../config/db');
const attendanceService = require('../services/attendanceService');

// خطأ "آمن" مقصود (رسالة يمكن إظهارها للمستخدم مباشرة)، للتمييز عن أي خطأ داخلي غير متوقع (SQL مثلاً)
// حتى لا نُسرّب تفاصيل بنية قاعدة البيانات في حال حصل خطأ غير متوقع
class AppError extends Error {
    constructor(message) {
        super(message);
        this.isOperational = true;
    }
}

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
            LEFT JOIN attendance a ON w.worker_id = a.worker_id 
                AND a.record_date = CURDATE()
            WHERE wsa.site_id = ? 
            AND wsa.unassigned_date IS NULL 
            AND w.status = 'Active'
            -- هذا الجزء هو الأهم: جلب فقط من ليس لديهم سجل أو سجلهم مسودة
            AND (a.attendance_id IS NULL OR a.status = 'Draft')
        `;
        
        const [workers] = await db.execute(query, [siteId]);
        res.status(200).json({ status: 'success', data: workers });
    } catch (error) {
        console.error("SQL ERROR:", error);
        res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب بيانات العمال، حاول مرة أخرى.' });
    }
};

exports.checkIn = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;
        const recorded_by_user_id = req.user.user_id; 

        // TODO (أمان): تحقق أن site_id فعلاً تابع لهذا المشرف قبل الإدراج،
        // بانتظار اسم جدول ربط المشرف بالموقع عندك لإضافة الشرط هنا بشكل صحيح.

        await db.execute(
            `INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, status, recorded_by_user_id) 
             VALUES (?, ?, CURDATE(), NOW(), 'Draft', ?)`,
            [worker_id, site_id, recorded_by_user_id]
        );
        res.status(201).json({ status: 'success', message: 'تم تسجيل الحضور' });
    } catch (error) {
        console.error("CHECK-IN ERROR:", error);
        res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء تسجيل الحضور، حاول مرة أخرى.' });
    }
};

exports.submitDay = async (req, res) => {
    try {
        const { siteId } = req.body;
        const [records] = await db.execute(
            'SELECT attendance_id FROM attendance WHERE site_id = ? AND record_date = CURDATE() AND status = "Draft"',
            [siteId]
        );

        for (let record of records) {
            await attendanceService.calculateWorkingHours(record.attendance_id);
            await db.execute('UPDATE attendance SET status = "Submitted" WHERE attendance_id = ?', [record.attendance_id]);
        }
        res.status(200).json({ status: 'success', message: 'تم إرسال اليوم للمراجعة بنجاح' });
    } catch (error) {
        console.error("SUBMIT DAY ERROR:", error);
        res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء إرسال اليوم، حاول مرة أخرى.' });
    }
};

exports.checkOut = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;

        // TODO (أمان): تحقق أن site_id فعلاً تابع لهذا المشرف قبل تنفيذ الخروج،
        // بانتظار اسم جدول ربط المشرف بالموقع عندك لإضافة الشرط هنا بشكل صحيح.

        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) return res.status(404).json({ message: 'سجل الحضور غير موجود!' });

        await db.execute('UPDATE attendance SET check_out_time = NOW() WHERE attendance_id = ?', [att_id]);
        res.status(200).json({ message: 'تم تسجيل الخروج.' });
    } catch (error) {
        console.error("CHECK-OUT ERROR:", error);
        res.status(500).json({ message: 'خطأ في عملية الخروج، حاول مرة أخرى.' });
    }
};

// تم تعديل هذا الاستعلام فقط: إضافة الترتيب حسب الموقع ثم التاريخ (الأحدث أولاً) ثم الاسم،
// وإضافة عمود admin_rejection_notes حتى تظهر سبب الرفض الحقيقي بالواجهة
exports.getRejectedRecords = async (req, res) => {
    try {
        const supervisor_id = req.user.user_id;
        const [rows] = await db.execute(
            `SELECT a.*, w.full_name, s.site_name 
             FROM attendance a
             JOIN workers w ON a.worker_id = w.worker_id
             JOIN sites s ON a.site_id = s.site_id
             WHERE a.status = 'Rejected' AND a.recorded_by_user_id = ?
             ORDER BY s.site_name, a.record_date DESC, w.full_name`,
            [supervisor_id]
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("GET REJECTED ERROR:", error);
        res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب السجلات المرفوضة، حاول مرة أخرى.' });
    }
};

exports.startLeave = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;
        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) return res.status(404).json({ message: 'لا يوجد سجل حضور نشط!' });

        await db.execute('INSERT INTO attendanceleaveperiods (attendance_id, leave_start_time) VALUES (?, NOW())', [att_id]);
        res.status(200).json({ status: 'success', message: 'تم بدء الاستراحة' });
    } catch (error) {
        console.error("START LEAVE ERROR:", error);
        res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء بدء الاستراحة، حاول مرة أخرى.' });
    }
};

exports.endLeave = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;
        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) return res.status(404).json({ message: 'سجل الحضور غير موجود!' });

        const [result] = await db.execute(
            `UPDATE attendanceleaveperiods SET leave_end_time = NOW() 
             WHERE attendance_id = ? AND leave_end_time IS NULL ORDER BY leave_id DESC LIMIT 1`,
            [att_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'لا توجد استراحة نشطة!' });

        res.status(200).json({ status: 'success', message: 'تم إنهاء الاستراحة' });
    } catch (error) {
        console.error("END LEAVE ERROR:", error);
        res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء إنهاء الاستراحة، حاول مرة أخرى.' });
    }
};

// الدالة المحدثة مع شروط الأمان وتوافق الـ AuditLog
// التعديل الوحيد هنا: تنسيق check_in_time و check_out_time إلى صيغة MySQL DATETIME
// قبل عملية الـ UPDATE، لأن Flutter يرسلهما بصيغة ISO (مثل 2026-07-16T09:11:29.000Z)
// وهذه الصيغة تسبب خطأ Incorrect datetime value في MySQL
exports.resubmitAttendance = async (req, res) => {
    const { attendance_id } = req.params;
    const { check_in_time, check_out_time, remarks } = req.body;
    const supervisor_id = req.user.user_id;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [records] = await connection.execute(
            'SELECT * FROM attendance WHERE attendance_id = ? AND status = "Rejected" AND recorded_by_user_id = ?',
            [attendance_id, supervisor_id]
        );

        if (records.length === 0) throw new AppError('السجل غير موجود أو غير مسموح بتعديله');
        
        const oldRecord = records[0];

        // تحويل صيغة ISO القادمة من Flutter إلى صيغة MySQL DATETIME (YYYY-MM-DD HH:mm:ss)
        const formattedCheckIn = check_in_time
            ? new Date(check_in_time).toISOString().slice(0, 19).replace('T', ' ')
            : null;

        const formattedCheckOut = check_out_time
            ? new Date(check_out_time).toISOString().slice(0, 19).replace('T', ' ')
            : null;

        // التحقق المنطقي: وقت الخروج يجب أن يكون بعد وقت الدخول
        if (formattedCheckIn && formattedCheckOut && new Date(check_out_time) <= new Date(check_in_time)) {
            throw new AppError('وقت الخروج يجب أن يكون بعد وقت الدخول');
        }

        await connection.execute(
            `UPDATE attendance SET check_in_time = ?, check_out_time = ?, remarks = ?, status = 'Submitted', updated_at = NOW() WHERE attendance_id = ?`,
            [formattedCheckIn, formattedCheckOut, remarks, attendance_id]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values) VALUES (?, ?, ?, ?, ?, ?)`,
            ['attendance', attendance_id, 'RESUBMIT', supervisor_id, JSON.stringify(oldRecord), JSON.stringify({ check_in_time: formattedCheckIn, check_out_time: formattedCheckOut, remarks, status: 'Submitted' })]
        );

        await connection.commit();
        res.status(200).json({ status: 'success', message: 'تم إعادة الإرسال بنجاح' });
    } catch (error) {
        await connection.rollback();
        console.error("RESUBMIT ERROR:", error);
        // إذا كان خطأ "متوقع" (AppError) نُظهر رسالته لأنها مقصودة وآمنة (مثل: السجل غير موجود، أو ترتيب الأوقات خاطئ)
        // أما أي خطأ آخر (SQL مثلاً) فنُظهر رسالة عامة فقط لتجنب تسريب تفاصيل قاعدة البيانات
        const message = error.isOperational
            ? error.message
            : 'حدث خطأ أثناء إعادة الإرسال، حاول مرة أخرى.';
        res.status(400).json({ status: 'error', message });
    } finally {
        connection.release();
    }
};