const express = require('express');
const router = express.Router();
const adminAttendanceController = require('../controllers/adminAttendanceController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware'); // استدعاء حارس البوابة

// 1. جلب السجلات التي تنتظر المراجعة: 
// يمكن للأدمن والمشرف رؤيتها (سنتحكم في البيانات لاحقاً داخل الـ Controller)
router.get('/pending', authMiddleware, restrictTo('Admin', 'Supervisor'), adminAttendanceController.getPendingRecords);

// 2. مراجعة السجل (قبول أو رفض):
// عملية حساسة جداً، مسموح للأدمن فقط
router.post('/review', authMiddleware, restrictTo('Admin'), adminAttendanceController.reviewRecord);

// 3. جلب السجلات ليوم محدد:
// أيضاً للأدمن والمشرف
router.get('/records', authMiddleware, restrictTo('Admin', 'Supervisor'), adminAttendanceController.getRecordsByDate);
router.get('/settings/breaks', authMiddleware, restrictTo('Admin'), adminAttendanceController.getBreakSettings);
router.put('/settings/breaks', authMiddleware, restrictTo('Admin'), adminAttendanceController.updateBreakSettings);
module.exports = router;