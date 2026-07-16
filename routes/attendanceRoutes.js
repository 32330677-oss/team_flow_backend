const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const authMiddleware = require('../middleware/authMiddleware');

// تفعيل المصادقة لجميع المسارات التالية
router.use(authMiddleware);

// 1. جلب العمال (يستخدم الـ params)
router.get('/sites/:siteId/workers', attendanceController.getSiteWorkers);

// 2. تسجيل الحضور (بداية اليوم)
router.post('/checkin', attendanceController.checkIn);

// 3. تسجيل الخروج (قبل الـ Submit)
router.post('/checkout', attendanceController.checkOut);

// 4. الإرسال النهائي (الجديد - هذا هو البديل للـ submitAttendance القديمة)
router.post('/submit', attendanceController.submitDay);

// 5. إدارة الاستراحات
router.post('/leave/start', attendanceController.startLeave);
router.post('/leave/end', attendanceController.endLeave);
// أضف هذا المسار في ملف routes/attendanceRoutes.js (أو أي اسم لملف الراوتر الخاص بك)

router.get('/rejected', attendanceController.getRejectedRecords);
module.exports = router;