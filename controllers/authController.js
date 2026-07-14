const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.login = async (req, res) => {
    // 1. استلام المعرف (سواء كان إيميل أو اسم مستخدم) مع كلمة المرور
    const loginIdentifier = req.body.email || req.body.username;
    const { password } = req.body;

    if (!loginIdentifier || !password) {
        return res.status(400).json({ 
            status: "error", 
            message: "الرجاء إدخال اسم المستخدم/البريد الإلكتروني وكلمة المرور" 
        });
    }

    try {
        // 2. البحث الذكي: يطابق إما الـ username أو الـ email
        const query = `
            SELECT user_id, username, password_hash, email, full_name, role, status 
            FROM Users 
            WHERE username = ? OR email = ?
        `;
        const [users] = await db.query(query, [loginIdentifier, loginIdentifier]);
        
        if (users.length === 0) {
            return res.status(401).json({ 
                status: "error", 
                message: "اسم المستخدم/البريد الإلكتروني أو كلمة المرور غير صحيحة" 
            });
        }

        const user = users[0];

        // 3. التحقق الحقيقي من حالة الحساب (Status)
        if (user.status === 'Inactive') {
            return res.status(403).json({ 
                status: "error", 
                message: "هذا الحساب معطل حالياً من قبل الإدارة" 
            });
        }

        // 4. فحص كلمة المرور بمرونة (يدعم المشفر القديم والجديد لتجنب قفل حساب الأدمن)
        let isMatch = false;
        if (user.password_hash.startsWith('$2a$') || user.password_hash.startsWith('$2b$')) {
            isMatch = await bcrypt.compare(password, user.password_hash);
        } else {
            isMatch = (password === user.password_hash);
        }

        if (!isMatch) {
            return res.status(401).json({ 
                status: "error", 
                message: "اسم المستخدم/البريد الإلكتروني أو كلمة المرور غير صحيحة" 
            });
        }

        // 5. توليد الـ JWT مع قيمة احتياطية للـ Secret تجنباً لكراش السيرفر
        const jwtSecret = process.env.JWT_SECRET || 'teamflow_super_secure_fallback_key';
        const token = jwt.sign(
            { id: user.user_id, role: user.role },
            jwtSecret,
            { expiresIn: '24h' }
        );

        // 6. تحديث وقت آخر تسجيل دخول في الداتابيز
        await db.query('UPDATE Users SET last_login = NOW() WHERE user_id = ?', [user.user_id]);

        // 7. إرجاع النتيجة بنجاح
        res.json({
            status: "success",
            message: "تم تسجيل الدخول بنجاح",
            token,
            user: {
                id: user.user_id,
                username: user.username,
                full_name: user.full_name,
                email: user.email,
                role: user.role,
                status: user.status
            }
        });

    } catch (error) {
        console.error("🚨 Login Server Error:", error);
        res.status(500).json({ 
            status: "error", 
            message: "حدث خطأ في السيرفر أثناء معالجة تسجيل الدخول", 
            details: error.message 
        });
    }
};