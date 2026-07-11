const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.login = async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ status: "error", message: "الرجاء إدخال البريد الإلكتروني وكلمة المرور" });
    }

    try {
        // البحث باستخدام حقول جدولك الحقيقية
        const [users] = await db.query('SELECT * FROM Users WHERE email = ?', [email]);
        
        if (users.length === 0) {
            return res.status(401).json({ status: "error", message: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
        }

        const user = users[0];

        // مقارنة كلمة المرور
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ status: "error", message: "البريد الإلكتروني أو كلمة المرور غير صحيحة" });
        }

        // توليد الـ JWT باستخدام user_id و role المطابقين لجدولك
        const token = jwt.sign(
            { id: user.user_id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            status: "success",
            message: "تم تسجيل الدخول بنجاح",
            token,
            user: {
                id: user.user_id,
                username: user.username,
                full_name: user.full_name,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        res.status(500).json({ status: "error", message: "حدث خطأ في السيرفر", details: error.message });
    }
};