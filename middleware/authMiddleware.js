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

    return res.status(500).json({
        status: 'error',
        message: 'Server authentication configuration error'
    });
}

  try {
    const decoded = jwt.verify(token, secretKey);
    req.user = decoded; 
    next(); 
} catch (error) {
    console.error('JWT Verification Error:', error);

    if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
            status: 'error',
            code: 'TOKEN_EXPIRED',
            message: 'Your session has expired. Please log in again.'
        });
    }

    return res.status(401).json({
        status: 'error',
        code: 'TOKEN_INVALID',
        message: 'Invalid authentication token.'
    });
}
};

module.exports = authMiddleware;