const express = require('express');
const router = express.Router();
const supervisorController = require('../controllers/supervisorController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware'); // استيراد الحارس

// حماية جميع مسارات المشرفين بالتوكن
router.use(authMiddleware);

// 1. جلب قائمة المشرفين: 
// مسموح للأدمن فقط (أو يمكنك إضافة Supervisor إذا أردت أن يرى المشرفون زملاءهم)
router.get('/', restrictTo('Admin'), supervisorController.getAllSupervisors);

// 2. إنشاء مشرف جديد: للأدمن فقط
router.post('/', restrictTo('Admin'), supervisorController.createSupervisor);

// 3. تعديل بيانات مشرف: للأدمن فقط
router.put('/:id', restrictTo('Admin'), supervisorController.updateSupervisor);

// 4. تغيير حالة المشرف (تفعيل/تعطيل): للأدمن فقط
router.patch('/:id/status', restrictTo('Admin'), supervisorController.toggleSupervisorStatus);

module.exports = router;