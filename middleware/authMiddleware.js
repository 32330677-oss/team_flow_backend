// backend/middleware/authMiddleware.js
const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ 
            status: 'error', 
            message: 'وصول مرفوض! لم يتم توفير رمز التحقق (Token).' 
        });
    }

    // Force absolute crash on launch if secure environment configuration is missing
    const secretKey = process.env.JWT_SECRET;
    if (!secretKey) {
        console.error("FATAL ERROR: JWT_SECRET variable is completely missing from process.env.");
        process.exit(1);
    }

    try {
        const decoded = jwt.verify(token, secretKey);
        req.user = decoded; 
        console.log("👤 User from JWT:", req.user);
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