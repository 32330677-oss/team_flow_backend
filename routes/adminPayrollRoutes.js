const express = require('express');
const router = express.Router();
const adminPayrollController = require('../controllers/adminPayrollController');
const authMiddleware = require('../middleware/authMiddleware'); // ✅ إضافة الميدل وير

// حماية المسارات بـ authMiddleware
router.get('/report', authMiddleware, adminPayrollController.getPayrollReport);

module.exports = router;