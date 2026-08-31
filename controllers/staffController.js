const db = require('../config/db');
const bcrypt = require('bcryptjs');

const DEFAULT_DAILY_HOURS = 8.00;

function parsePaidLeaveTypes(value) {
    if (value === undefined || value === null || value === '') return null;
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? JSON.stringify(parsed) : null;
        } catch (_) {
            return null;
        }
    }
    return null;
}

// 1. جلب جميع الموظفين الإداريين
exports.getAllStaff = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.phone_number, sm.position,
                    sm.site_id, s.site_name, sm.hire_date, sm.monthly_salary, sm.standard_daily_hours,
                    sm.paid_leave_types, sm.status, sm.created_at,
                    u.user_id, u.username, u.status AS account_status
             FROM staff_members sm
             JOIN users u ON u.user_id = sm.user_id
             LEFT JOIN sites s ON s.site_id = sm.site_id
             ORDER BY sm.created_at DESC`
        );
        return res.status(200).json({ status: 'success', results: rows.length, data: rows });
    } catch (error) {
        console.error('GET ALL STAFF ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب بيانات الموظفين الإداريين' });
    }
};

// 2. إنشاء موظف إداري جديد (ينشئ حساب دخول بدور Staff + سجل staff_members في معاملة واحدة)
exports.createStaff = async (req, res) => {
    const {
        username, password, full_name, phone_number, position,
        site_id, hire_date, monthly_salary, standard_daily_hours, paid_leave_types
    } = req.body;

    if (!username || !password || !full_name || monthly_salary === undefined || monthly_salary === null) {
        return res.status(400).json({ status: 'error', message: 'يرجى تعبئة اسم المستخدم وكلمة المرور والاسم الكامل والراتب الشهري' });
    }

    const numericSalary = Number(monthly_salary);
    if (!Number.isFinite(numericSalary) || numericSalary < 0) {
        return res.status(400).json({ status: 'error', message: 'الراتب الشهري غير صالح' });
    }

    const numericDailyHours = (standard_daily_hours !== undefined && standard_daily_hours !== null && standard_daily_hours !== '')
        ? Number(standard_daily_hours)
        : DEFAULT_DAILY_HOURS;
    if (!Number.isFinite(numericDailyHours) || numericDailyHours <= 0 || numericDailyHours > 24) {
        return res.status(400).json({ status: 'error', message: 'عدد الساعات اليومية غير صالح' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [existingUsername] = await connection.query('SELECT user_id FROM users WHERE username = ?', [username]);
        if (existingUsername.length > 0) {
            throw Object.assign(new Error('اسم المستخدم هذا مستخدم بالفعل'), { isOperational: true });
        }

        if (site_id) {
            const [siteRows] = await connection.query('SELECT site_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
            if (siteRows.length === 0) {
                throw Object.assign(new Error('الموقع المحدد غير موجود'), { isOperational: true });
            }
        }

        const passwordHash = await bcrypt.hash(password, 10);

        // ملاحظة: role = 'Staff' يتطلب توسيع ENUM حقل users.role (موجود ضمن ملف الـ SQL المرفق)
        const [userResult] = await connection.query(
            `INSERT INTO users (username, password_hash, full_name, role, status)
             VALUES (?, ?, ?, 'Staff', 'Active')`,
            [username, passwordHash, full_name]
        );
        const newUserId = userResult.insertId;

        const [staffResult] = await connection.query(
            `INSERT INTO staff_members
                (user_id, staff_unique_id, full_name, phone_number, position, site_id,
                 hire_date, monthly_salary, standard_daily_hours, paid_leave_types, status)
             VALUES (?, 'TEMP', ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
            [
                newUserId, full_name, phone_number || null, position || null, site_id || null,
                hire_date || null, numericSalary, numericDailyHours, parsePaidLeaveTypes(paid_leave_types)
            ]
        );
        const newStaffId = staffResult.insertId;
        const staffUniqueId = `STF-${newStaffId}`;
        await connection.query('UPDATE staff_members SET staff_unique_id = ? WHERE staff_id = ?', [staffUniqueId, newStaffId]);

        await connection.commit();

        return res.status(201).json({
            status: 'success',
            message: 'تم إنشاء الموظف الإداري بنجاح',
            data: { staff_id: newStaffId, staff_unique_id: staffUniqueId, user_id: newUserId }
        });
    } catch (error) {
        await connection.rollback();
        console.error('CREATE STAFF ERROR:', error);
        const status = error.isOperational ? 400 : 500;
        return res.status(status).json({
            status: 'error',
            message: error.isOperational ? error.message : 'حدث خطأ في السيرفر أثناء إضافة الموظف الإداري'
        });
    } finally {
        connection.release();
    }
};

// 3. تعديل بيانات موظف إداري (وتعديل اسم المستخدم/الاسم الكامل المرتبط بحساب الدخول عند الحاجة)
exports.updateStaff = async (req, res) => {
    const { id } = req.params; // staff_id
    const {
        full_name, phone_number, position, site_id, hire_date,
        monthly_salary, standard_daily_hours, paid_leave_types, username
    } = req.body;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [existing] = await connection.query('SELECT * FROM staff_members WHERE staff_id = ? LIMIT 1', [id]);
        if (existing.length === 0) {
            throw Object.assign(new Error('الموظف الإداري غير موجود'), { isOperational: true });
        }
        const current = existing[0];

        if (site_id !== undefined && site_id !== null && site_id !== '') {
            const [siteRows] = await connection.query('SELECT site_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
            if (siteRows.length === 0) {
                throw Object.assign(new Error('الموقع المحدد غير موجود'), { isOperational: true });
            }
        }

        let numericSalary = current.monthly_salary;
        if (monthly_salary !== undefined && monthly_salary !== null && monthly_salary !== '') {
            numericSalary = Number(monthly_salary);
            if (!Number.isFinite(numericSalary) || numericSalary < 0) {
                throw Object.assign(new Error('الراتب الشهري غير صالح'), { isOperational: true });
            }
        }

        let numericDailyHours = current.standard_daily_hours;
        if (standard_daily_hours !== undefined && standard_daily_hours !== null && standard_daily_hours !== '') {
            numericDailyHours = Number(standard_daily_hours);
            if (!Number.isFinite(numericDailyHours) || numericDailyHours <= 0 || numericDailyHours > 24) {
                throw Object.assign(new Error('عدد الساعات اليومية غير صالح'), { isOperational: true });
            }
        }

        await connection.query(
            `UPDATE staff_members
             SET full_name = ?, phone_number = ?, position = ?, site_id = ?,
                 hire_date = ?, monthly_salary = ?, standard_daily_hours = ?, paid_leave_types = ?
             WHERE staff_id = ?`,
            [
                full_name || current.full_name,
                phone_number !== undefined ? phone_number : current.phone_number,
                position !== undefined ? position : current.position,
                site_id !== undefined ? (site_id || null) : current.site_id,
                hire_date !== undefined ? (hire_date || null) : current.hire_date,
                numericSalary,
                numericDailyHours,
                paid_leave_types !== undefined ? parsePaidLeaveTypes(paid_leave_types) : current.paid_leave_types,
                id
            ]
        );

        if (username && username.trim() !== '') {
            const [dupe] = await connection.query(
                'SELECT user_id FROM users WHERE username = ? AND user_id != ?',
                [username.trim(), current.user_id]
            );
            if (dupe.length > 0) {
                throw Object.assign(new Error('اسم المستخدم الجديد مستخدم من قبل حساب آخر'), { isOperational: true });
            }
            await connection.query(
                'UPDATE users SET username = ?, full_name = ? WHERE user_id = ?',
                [username.trim(), full_name || current.full_name, current.user_id]
            );
        } else if (full_name) {
            await connection.query('UPDATE users SET full_name = ? WHERE user_id = ?', [full_name, current.user_id]);
        }

        await connection.commit();
        return res.status(200).json({ status: 'success', message: 'تم تحديث بيانات الموظف الإداري بنجاح' });
    } catch (error) {
        await connection.rollback();
        console.error('UPDATE STAFF ERROR:', error);
        const status = error.isOperational ? 400 : 500;
        return res.status(status).json({
            status: 'error',
            message: error.isOperational ? error.message : 'حدث خطأ أثناء تعديل بيانات الموظف الإداري'
        });
    } finally {
        connection.release();
    }
};

// 4. تفعيل/تعطيل الموظف الإداري (يعطّل حساب الدخول أيضاً بنفس الوقت)
exports.toggleStaffStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['Active', 'Inactive'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'الحالة يجب أن تكون Active أو Inactive' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [existing] = await connection.query('SELECT user_id FROM staff_members WHERE staff_id = ? LIMIT 1', [id]);
        if (existing.length === 0) {
            throw Object.assign(new Error('الموظف الإداري غير موجود'), { isOperational: true });
        }

        await connection.query('UPDATE staff_members SET status = ? WHERE staff_id = ?', [status, id]);
        await connection.query('UPDATE users SET status = ? WHERE user_id = ?', [status, existing[0].user_id]);

        await connection.commit();
        return res.status(200).json({ status: 'success', message: `تم تغيير حالة الموظف الإداري إلى ${status}` });
    } catch (error) {
        await connection.rollback();
        console.error('TOGGLE STAFF STATUS ERROR:', error);
        const httpStatus = error.isOperational ? 400 : 500;
        return res.status(httpStatus).json({
            status: 'error',
            message: error.isOperational ? error.message : 'حدث خطأ أثناء تعديل حالة الموظف الإداري'
        });
    } finally {
        connection.release();
    }
};