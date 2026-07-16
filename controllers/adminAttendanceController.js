const db = require('../config/db');

// جلب السجلات التي تنتظر المراجعة فقط
exports.getPendingRecords = async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT a.*, DATE_FORMAT(a.record_date, '%Y-%m-%d') as record_date, w.full_name, s.site_name 
             FROM attendance a
             JOIN workers w ON a.worker_id = w.worker_id
             JOIN sites s ON a.site_id = s.site_id
             WHERE a.status = 'Submitted' OR a.status = 'Rejected'`
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};

// مراجعة السجل (قبول أو رفض)
exports.reviewRecord = async (req, res) => {
    try {
        const { attendance_id, status, admin_note } = req.body;
        
        // 1. تحديد معرف الأدمن بمرونة (حل مشكلة id أو user_id)
        const adminId = req.user?.id || req.user?.user_id;

        // 2. معالجة القيم لضمان عدم إرسال undefined أبداً للـ SQL
        const finalNote = status === 'Rejected' ? (admin_note || null) : null;
        const finalAdminId = status === 'Approved' ? adminId : null;

        // 3. التحقق من وجود المعرف قبل التنفيذ
        if (status === 'Approved' && !adminId) {
            return res.status(401).json({ status: 'error', message: 'لم يتم العثور على هوية الأدمن' });
        }

        // 4. تنفيذ التحديث بأمان
        await db.execute(
            'UPDATE attendance SET status = ?, admin_rejection_notes = ?, approved_by_user_id = ?, approval_date = NOW() WHERE attendance_id = ?',
            [status, finalNote, finalAdminId, attendance_id]
        );
        
        res.status(200).json({ status: 'success', message: 'تمت العملية بنجاح' });
    } catch (error) {
        console.error("Review Error:", error); // تسجيل الخطأ في ترمينال السيرفر
        res.status(500).json({ status: 'error', message: error.message });
    }
};

// جلب السجلات ليوم محدد
exports.getRecordsByDate = async (req, res) => {
    const { date } = req.query;
    try {
        const [rows] = await db.execute(
           `SELECT a.*, DATE_FORMAT(a.record_date, '%Y-%m-%d') as record_date, w.full_name, s.site_name 
            FROM attendance a
            JOIN workers w ON a.worker_id = w.worker_id
            JOIN sites s ON a.site_id = s.site_id
            WHERE DATE(a.record_date) = ? AND (a.status IN ('Submitted', 'Rejected'))`,
            [date]
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};