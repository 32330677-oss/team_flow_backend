const db = require('../config/db'); 
const bcrypt = require('bcryptjs');

// 1. جلب جميع المشرفين بحالتهم الحقيقية من قاعدة البيانات
exports.getAllSupervisors = async (req, res) => {
    try {
        const query = `
            SELECT user_id, full_name, username, role, status, created_at, last_login 
            FROM users 
            WHERE role = 'Supervisor'
            ORDER BY created_at DESC
        `;
        const [supervisors] = await db.query(query);

        res.status(200).json({
            status: 'success',
            results: supervisors.length,
            data: supervisors
        });
    } catch (err) {
        console.error("🚨 Error fetching supervisors:", err.message);
        res.status(500).json({
            status: 'error',
            message: 'حدث خطأ في الخادم أثناء جلب قائمة المشرفين'
        });
    }
};

// 2. إضافة مشرف جديد مع حفظ حالته كـ Active تلقائياً
exports.createSupervisor = async (req, res) => {
    const { full_name, username, password } = req.body;

    if (!full_name || !username || !password) {
        return res.status(400).json({
            status: 'fail',
            message: 'يرجى تقديم جميع البيانات المطلوبة'
        });
    }

    try {
        // التأكد من عدم تكرار اسم المستخدم
        const [existingUser] = await db.query('SELECT user_id FROM users WHERE username = ?', [username]);
        if (existingUser.length > 0) {
            return res.status(400).json({
                status: 'fail',
                message: 'اسم المستخدم هذا مستخدم بالفعل'
            });
        }

        // تشفير كلمة المرور
        const hashedPassword = await bcrypt.hash(password, 10);

        const insertQuery = `
            INSERT INTO users (full_name, username, password_hash, role, status) 
            VALUES (?, ?, ?, 'Supervisor', 'Active')
        `;

        const [result] = await db.query(insertQuery, [
            full_name, 
            username, 
            hashedPassword
        ]);

        res.status(201).json({
            status: 'success',
            message: 'تم تسجيل المشرف بنجاح في النظام',
            data: {
                user_id: result.insertId,
                full_name,
                username,
                role: 'Supervisor',
                status: 'Active'
            }
        });
    } catch (err) {
        console.error("🚨 Error creating supervisor:", err); 
        res.status(500).json({
            status: 'error',
            message: `فشل إدخال المشرف: ${err.message}`
        });
    }
};

// 3. تعديل اسم وبيانات المشرف
exports.updateSupervisor = async (req, res) => {
    const { id } = req.params;
    const { full_name, username } = req.body;

    if (!full_name || !username) {
        return res.status(400).json({
            status: 'fail',
            message: 'يرجى تزويد الاسم الكامل واسم المستخدم لإتمام التعديل'
        });
    }

    try {
        const [duplicateCheck] = await db.query(
            'SELECT user_id FROM users WHERE username = ? AND user_id != ?', 
            [username, id]
        );
        if (duplicateCheck.length > 0) {
            return res.status(400).json({
                status: 'fail',
                message: 'اسم المستخدم الجديد مأخوذ بالفعل من قبل حساب آخر'
            });
        }

        const updateQuery = `
            UPDATE users 
            SET full_name = ?, username = ?
            WHERE user_id = ? AND role = 'Supervisor'
        `;
        const [result] = await db.query(updateQuery, [full_name, username, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                status: 'fail',
                message: 'المشرف غير موجود أو تم تعديل صلاحيته مسبقاً'
            });
        }

        res.status(200).json({
            status: 'success',
            message: 'تم تحديث بيانات المشرف بنجاح'
        });
    } catch (err) {
        console.error("🚨 Error updating supervisor:", err.message);
        res.status(500).json({
            status: 'error',
            message: 'حدث خطأ أثناء محاولة تعديل بيانات المشرف'
        });
    }
};

// 4. تغيير حالة حساب المشرف بشكل حقيقي في قاعدة البيانات
exports.toggleSupervisorStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // يتوقع استقبال 'Active' أو 'Inactive'

    if (!status || !['Active', 'Inactive'].includes(status)) {
        return res.status(400).json({
            status: 'fail',
            message: 'الحالة المرسلة غير صالحة، يجب أن تكون Active أو Inactive'
        });
    }

    try {
        const query = `
            UPDATE users 
            SET status = ?
            WHERE user_id = ? AND role = 'Supervisor'
        `;
        const [result] = await db.query(query, [status, id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                status: 'fail',
                message: 'المشرف المستهدف غير موجود'
            });
        }

        res.status(200).json({
            status: 'success',
            message: `تم تغيير حالة حساب المشرف بنجاح إلى ${status}`
        });
    } catch (err) {
        console.error("🚨 Error toggling status:", err.message);
        res.status(500).json({
            status: 'error',
            message: 'فشل تعديل حالة حساب المشرف في قاعدة البيانات'
        });
    }
};