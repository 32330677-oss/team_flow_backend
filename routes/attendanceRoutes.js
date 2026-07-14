const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const authMiddleware = require('../middleware/authMiddleware'); // الـ middleware الذي يفحص الـ JWT

// جميع مسارات الحضور محمية بالـ Token
router.use(authMiddleware);

// مسار جلب عمال موقع معين (بعد التحقق من المشرف)
router.get('/sites/:siteId/workers', attendanceController.getSiteWorkers);

// مسار حفظ حضور عمال موقع معين
router.post('/', attendanceController.submitAttendance);

module.exports = router;