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
    const { attendance_id, status, admin_note } = req.body;
    const adminId = req.user?.id || req.user?.user_id;
    
    if (!adminId) return res.status(401).json({ status: 'error', message: 'لم يتم العثور على هوية الأدمن' });

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. جلب السجل مع التحقق من حالته
        const [oldRows] = await connection.execute(
            'SELECT * FROM attendance WHERE attendance_id = ?', 
            [attendance_id]
        );
        
        if (oldRows.length === 0) throw new Error('السجل غير موجود');
        const oldRecord = oldRows[0];

        // --- إضافة منطق الحماية هنا ---
        // إذا كان السجل مرفوضاً، لا نسمح بـ Approve إلا إذا كان السجل قد مر بـ Resubmit
        // (يمكنك تعديل هذا الشرط بناءً على منطق عملك)
        if (status === 'Approved' && oldRecord.status === 'Rejected') {
            throw new Error('لا يمكن قبول السجل لأنه مرفوض، يجب على المشرف إعادة تقديمه أولاً.');
        }
        
        // منع الموافقة على سجلات ليست 'Submitted' أو 'Rejected'
        if (oldRecord.status !== 'Submitted' && oldRecord.status !== 'Rejected') {
             throw new Error('لا يمكن مراجعة هذا السجل لأنه ليس في حالة انتظار (Submitted/Rejected).');
        }
        // ------------------------------

        // 2. التحديث
        await connection.execute(
            `UPDATE attendance 
             SET status = ?, admin_rejection_notes = ?, approved_by_user_id = ?, approval_date = NOW() 
             WHERE attendance_id = ?`,
            [status, (status === 'Rejected' ? admin_note : null), adminId, attendance_id]
        );

        // 3. التوثيق في AuditLogs
        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                'attendance', 
                attendance_id, 
                status.toUpperCase(), 
                adminId, 
                JSON.stringify(oldRecord), 
                JSON.stringify({ status, admin_note })
            ]
        );

        await connection.commit();
        res.status(200).json({ status: 'success', message: 'تمت العملية بنجاح' });
    } catch (error) {
        await connection.rollback();
        console.error("Review Error:", error);
        res.status(400).json({ status: 'error', message: error.message });
    } finally {
        connection.release();
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

exports.getBreakSettings = async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT setting_key, setting_value FROM system_settings
             WHERE setting_key IN ('lunch_start_time','lunch_end_time','standard_work_minutes')`
        );
        const data = {};
        rows.forEach(r => data[r.setting_key] = r.setting_value);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};

exports.updateBreakSettings = async (req, res) => {
    const { lunch_start_time, lunch_end_time, standard_work_minutes } = req.body;
    const adminId = req.user.user_id;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const updates = { lunch_start_time, lunch_end_time, standard_work_minutes };

        for (const [key, value] of Object.entries(updates)) {
            if (value === undefined) continue;
            await connection.execute(
                `INSERT INTO system_settings (setting_key, setting_value, updated_by_user_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by_user_id = VALUES(updated_by_user_id)`,
                [key, String(value), adminId]
            );
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, new_values)
                 VALUES ('system_settings', 0, 'UPDATE_SETTING', ?, ?)`,
                [adminId, JSON.stringify({ [key]: value })]
            );
        }

        await connection.commit();
        res.status(200).json({ status: 'success', message: 'تم تحديث إعدادات أوقات الراحة' });
    } catch (error) {
        await connection.rollback();
        res.status(400).json({ status: 'error', message: error.message });
    } finally {
        connection.release();
    }
};