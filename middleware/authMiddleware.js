const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
    // 1. جلب التوكين من الهيدر (Authorization Header)
    const authHeader = req.headers['authorization'];
    
    // التوكين عادة يأتي بصيغة: "Bearer TOKEN_HERE"
    const token = authHeader && authHeader.split(' ')[1];

    // 2. التحقق من وجود التوكين
    if (!token) {
        return res.status(401).json({ 
            status: 'error', 
            message: 'وصول مرفوض! لم يتم توفير رمز التحقق (Token).' 
        });
    }

    try {
        // 3. فك تشفير التوكين والتحقق من صلاحيته
        // تأكد من استبدال 'YOUR_JWT_SECRET_KEY' بالمفتاح السري الخاص بـ Login في مشروعك
        const secretKey = process.env.JWT_SECRET || 'YOUR_JWT_SECRET_KEY'; 
        
        const decoded = jwt.verify(token, secretKey);
        
        // 4. وضع بيانات المستخدم المفكوكة في req.user لكي تقرأها الـ Controllers الأخرى
        // الـ decoded يحتوي عادة على: { user_id: 3, role: 'Supervisor', ... }
        req.user = decoded; 
        // داخل الـ middleware قبل الـ next()
console.log("👤 User from JWT:", req.user);
        // الانتقال للخطوة التالية (الـ Controller) بسلام
        next(); 
    } catch (error) {
        console.error('JWT Verification Error:', error);
        return res.status(403).json({ 
            status: 'error', 
            message: 'رمز التحقق غير صالح أو انتهت صلاحيته.' 
        });
    }
};

module.exports = authMiddleware;