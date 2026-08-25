const express = require('express');
const router = express.Router();
const workerController = require('../controllers/workerController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware'); // استيراد الحارس

// حماية جميع مسارات العمال بالتوكن
router.use(authMiddleware);

// 1. جلب قائمة العمال (مسموح للأدمن والمشرف)
router.get('/', restrictTo('Admin', 'Supervisor'), workerController.getAllWorkers);

// 2. إنشاء عامل جديد (للأدمن فقط، مع دعم رفع الصور عبر uploadWorkerFiles)
router.post('/', restrictTo('Admin'), workerController.uploadWorkerFiles, workerController.createWorker);

// 3. تعديل بيانات عامل (للأدمن فقط)
router.put('/:id', restrictTo('Admin'), workerController.updateWorker);

module.exports = router;