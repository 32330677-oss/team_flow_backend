const db = require('../config/db');

class AppError extends Error {
    constructor(message) {
        super(message);
        this.isOperational = true;
    }
}

function isValidDateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatToMySqlDateTime(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(String(value));
    if (!match) return null;
    const [, y, mo, d, h, mi, s = '00'] = match;
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${mo}-${d} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}

const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Sick', 'Vacation', 'Holiday'];

async function getStaffByUserId(userId, executor = db) {
    const [rows] = await executor.query(
        `SELECT staff_id, full_name, status, standard_daily_hours, paid_leave_types
         FROM staff_members WHERE user_id = ? LIMIT 1`,
        [userId]
    );
    return rows.length > 0 ? rows[0] : null;
}

// ==================== Self-service (Staff role) ====================

// الموظف يسجّل حضوره/حالته اليومية بنفسه فقط (لا صلاحية له بتسجيل حضور غيره)
exports.selfMarkAttendance = async (req, res) => {
    try {
        const staff = await getStaffByUserId(req.user.user_id);
        if (!staff) return res.status(404).json({ status: 'error', message: 'لا يوجد سجل موظف إداري مرتبط بهذا الحساب' });
        if (staff.status !== 'Active') return res.status(403).json({ status: 'error', message: 'حسابك الوظيفي غير نشط حالياً' });

        const { record_date, attendance_status, check_in_time, check_out_time, remarks } = req.body;

        if (!isValidDateOnly(record_date)) {
            return res.status(400).json({ status: 'error', message: 'يرجى تحديد تاريخ صالح (YYYY-MM-DD)' });
        }
        if (!ATTENDANCE_STATUSES.includes(attendance_status)) {
            return res.status(400).json({ status: 'error', message: 'حالة الحضور غير صالحة' });
        }

        const today = new Date().toISOString().slice(0, 10);
        if (record_date > today) {
            return res.status(400).json({ status: 'error', message: 'لا يمكن تسجيل حضور لتاريخ مستقبلي' });
        }

        const formattedIn = check_in_time ? formatToMySqlDateTime(check_in_time) : null;
        const formattedOut = check_out_time ? formatToMySqlDateTime(check_out_time) : null;
        if (check_in_time && !formattedIn) return res.status(400).json({ status: 'error', message: 'صيغة وقت الحضور غير صالحة' });
        if (check_out_time && !formattedOut) return res.status(400).json({ status: 'error', message: 'صيغة وقت الانصراف غير صالحة' });

        // الساعات تُحسب لأغراض التوثيق/التقارير فقط، ولا تدخل إطلاقاً في احتساب الراتب
        let regularHours = null;
        let overtimeHours = null;
        if (formattedIn && formattedOut) {
            const start = new Date(formattedIn.replace(' ', 'T'));
            const end = new Date(formattedOut.replace(' ', 'T'));
            if (end <= start) return res.status(400).json({ status: 'error', message: 'وقت الانصراف يجب أن يكون بعد وقت الحضور' });
            const totalHours = (end.getTime() - start.getTime()) / 3600000;
            const standardHours = Number(staff.standard_daily_hours || 8);
            regularHours = Math.min(totalHours, standardHours).toFixed(2);
            overtimeHours = Math.max(0, totalHours - standardHours).toFixed(2);
        }

        const [existing] = await db.execute(
            'SELECT staff_attendance_id, status FROM staff_attendance WHERE staff_id = ? AND record_date = ? LIMIT 1',
            [staff.staff_id, record_date]
        );

        if (existing.length > 0) {
            const record = existing[0];
            if (record.status === 'Approved') {
                return res.status(409).json({ status: 'error', message: 'لا يمكن تعديل سجل تم اعتماده مسبقاً' });
            }
            if (record.status === 'Submitted') {
                return res.status(409).json({ status: 'error', message: 'السجل بانتظار مراجعة الأدمن بالفعل' });
            }
            // Draft أو Rejected -> إعادة التسجيل وإرساله من جديد للمراجعة
            await db.execute(
                `UPDATE staff_attendance
                 SET attendance_status = ?, check_in_time = ?, check_out_time = ?,
                     regular_hours = ?, overtime_hours = ?, remarks = ?,
                     recorded_by_user_id = ?, status = 'Submitted',
                     admin_rejection_notes = NULL, approved_by_user_id = NULL, approval_date = NULL
                 WHERE staff_attendance_id = ?`,
                [attendance_status, formattedIn, formattedOut, regularHours, overtimeHours,
                    remarks || null, req.user.user_id, record.staff_attendance_id]
            );
            return res.status(200).json({ status: 'success', message: 'تم تحديث وإرسال سجل الحضور للمراجعة' });
        }

        const [result] = await db.execute(
            `INSERT INTO staff_attendance
                (staff_id, record_date, check_in_time, check_out_time, attendance_status,
                 regular_hours, overtime_hours, remarks, recorded_by_user_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted')`,
            [staff.staff_id, record_date, formattedIn, formattedOut, attendance_status,
                regularHours, overtimeHours, remarks || null, req.user.user_id]
        );

        return res.status(201).json({
            status: 'success',
            message: 'تم إرسال سجل الحضور للمراجعة',
            data: { staff_attendance_id: result.insertId }
        });
    } catch (error) {
        console.error('SELF MARK ATTENDANCE ERROR:', error);
        if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
            return res.status(409).json({ status: 'error', message: 'يوجد سجل حضور مسبق لهذا التاريخ' });
        }
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء تسجيل الحضور' });
    }
};

// جلب سجلات الحضور الخاصة بالموظف نفسه (مع إمكانية فلترة حسب فترة)
exports.getMyAttendance = async (req, res) => {
    try {
        const staff = await getStaffByUserId(req.user.user_id);
        if (!staff) return res.status(404).json({ status: 'error', message: 'لا يوجد سجل موظف إداري مرتبط بهذا الحساب' });

        const { start_date, end_date } = req.query;
        let query = 'SELECT * FROM staff_attendance WHERE staff_id = ?';
        const params = [staff.staff_id];
        if (isValidDateOnly(start_date) && isValidDateOnly(end_date)) {
            query += ' AND record_date BETWEEN ? AND ?';
            params.push(start_date, end_date);
        }
        query += ' ORDER BY record_date DESC';

        const [rows] = await db.execute(query, params);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('GET MY ATTENDANCE ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب سجلات الحضور' });
    }
};

// ==================== Admin review ====================

// جلب السجلات بانتظار المراجعة أو المرفوضة
exports.getPendingStaffAttendance = async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT sa.*, sm.full_name, sm.staff_unique_id, s.site_name
             FROM staff_attendance sa
             JOIN staff_members sm ON sm.staff_id = sa.staff_id
             LEFT JOIN sites s ON s.site_id = sm.site_id
             WHERE sa.status IN ('Submitted', 'Rejected')
             ORDER BY sa.record_date DESC`
        );
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('GET PENDING STAFF ATTENDANCE ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب السجلات بانتظار المراجعة' });
    }
};

// موافقة/رفض سجل حضور موظف إداري، مع إمكانية تحديد is_paid يدوياً من الأدمن عند الحاجة
exports.reviewStaffAttendance = async (req, res) => {
    const { staff_attendance_id, status, admin_note, is_paid } = req.body;
    const adminId = req.user.user_id;

    if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'الحالة يجب أن تكون Approved أو Rejected' });
    }
    if (status === 'Rejected' && (!admin_note || !String(admin_note).trim())) {
        return res.status(400).json({ status: 'error', message: 'سبب الرفض مطلوب' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            'SELECT * FROM staff_attendance WHERE staff_attendance_id = ? FOR UPDATE',
            [staff_attendance_id]
        );
        if (rows.length === 0) throw new AppError('السجل غير موجود');
        const record = rows[0];
        if (record.status !== 'Submitted') throw new AppError('لا يمكن مراجعة سجل ليس بحالة الانتظار');

        const resolvedIsPaid = (is_paid === 0 || is_paid === 1) ? is_paid : record.is_paid;

        await connection.execute(
            `UPDATE staff_attendance
             SET status = ?, admin_rejection_notes = ?, approved_by_user_id = ?, approval_date = NOW(), is_paid = ?
             WHERE staff_attendance_id = ?`,
            [status, status === 'Rejected' ? admin_note : null, adminId, resolvedIsPaid, staff_attendance_id]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('staff_attendance', ?, ?, ?, ?, ?)`,
            [staff_attendance_id, status.toUpperCase(), adminId, JSON.stringify(record), JSON.stringify({ status, admin_note, is_paid: resolvedIsPaid })]
        );

        await connection.commit();
        return res.status(200).json({ status: 'success', message: 'تمت معالجة الطلب بنجاح' });
    } catch (error) {
        await connection.rollback();
        console.error('REVIEW STAFF ATTENDANCE ERROR:', error);
        const httpStatus = error.isOperational ? 400 : 500;
        return res.status(httpStatus).json({
            status: 'error',
            message: error.isOperational ? error.message : 'حدث خطأ أثناء مراجعة السجل'
        });
    } finally {
        connection.release();
    }
};

// جلب سجلات كل الموظفين الإداريين حسب تاريخ محدد (Admin)
exports.getStaffAttendanceByDate = async (req, res) => {
    const { date } = req.query;
    if (!isValidDateOnly(date)) return res.status(400).json({ status: 'error', message: 'يرجى تحديد تاريخ صالح' });
    try {
        const [rows] = await db.execute(
            `SELECT sa.*, sm.full_name, sm.staff_unique_id, s.site_name
             FROM staff_attendance sa
             JOIN staff_members sm ON sm.staff_id = sa.staff_id
             LEFT JOIN sites s ON s.site_id = sm.site_id
             WHERE sa.record_date = ?
             ORDER BY sm.full_name`,
            [date]
        );
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('GET STAFF ATTENDANCE BY DATE ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب السجلات' });
    }
};

exports.getStaffByUserId = getStaffByUserId;