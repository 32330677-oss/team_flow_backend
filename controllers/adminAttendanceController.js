const db = require('../config/db');
const settingsCache = require('../services/settingsCache');

// 1. Fetch pending/rejected records for review
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

// 2. Review record (Approve or Reject) with strict validation & audit logging
exports.reviewRecord = async (req, res) => {
    const { attendance_id, status, admin_note } = req.body;
    const adminId = req.user?.id || req.user?.user_id;
    
    if (!adminId) return res.status(401).json({ status: 'error', message: 'Admin identification not found' });

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [oldRows] = await connection.execute(
            'SELECT * FROM attendance WHERE attendance_id = ?', 
            [attendance_id]
        );
        
        if (oldRows.length === 0) throw new Error('Record does not exist');
        const oldRecord = oldRows[0];

        if (status === 'Approved' && oldRecord.status === 'Rejected') {
            throw new Error('Cannot approve a rejected record. It must be resubmitted first.');
        }
        
        if (oldRecord.status !== 'Submitted' && oldRecord.status !== 'Rejected') {
             throw new Error('Record cannot be reviewed as it is not in pending status.');
        }

        await connection.execute(
            `UPDATE attendance 
             SET status = ?, admin_rejection_notes = ?, approved_by_user_id = ?, approval_date = NOW() 
             WHERE attendance_id = ?`,
            [status, (status === 'Rejected' ? admin_note : null), adminId, attendance_id]
        );

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
        res.status(200).json({ status: 'success', message: 'Operation completed successfully' });
    } catch (error) {
        await connection.rollback();
        console.error("Review Error:", error);
        res.status(400).json({ status: 'error', message: error.message });
    } finally {
        connection.release();
    }
};

// 3. Get records by specific date
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

// 4. Get break & work hours settings
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

// 5. Update break & work hours settings with Cache refresh, Audit Log, and Pending Records validation
exports.updateBreakSettings = async (req, res) => {
    const { lunch_start_time, lunch_end_time, standard_work_minutes } = req.body;
    const adminId = req.user.user_id;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // فحص ما إذا كان هناك أي سجلات معلقة قبل السماح بتعديل الإعدادات
        const [pending] = await connection.execute(
            `SELECT COUNT(*) as count FROM attendance WHERE status IN ('Submitted', 'Draft')`
        );

        if (pending[0].count > 0) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'Please approve or process all pending attendance records before updating break settings.' 
            });
        }

        const updates = { lunch_start_time, lunch_end_time, standard_work_minutes };

        for (const [key, value] of Object.entries(updates)) {
            if (value === undefined) continue;
            await connection.execute(
                `INSERT INTO system_settings (setting_key, setting_value)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
                [key, String(value)]
            );
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, new_values)
                 VALUES ('system_settings', 0, 'UPDATE_SETTING', ?, ?)`,
                [adminId, JSON.stringify({ [key]: value })]
            );
        }

        await connection.commit();
        
        // Refresh the memory cache immediately so calculations update instantly
        await settingsCache.refresh();

        res.status(200).json({ status: 'success', message: 'Settings updated successfully' });
    } catch (error) {
        await connection.rollback();
        res.status(400).json({ status: 'error', message: error.message });
    } finally {
        connection.release();
    }
};