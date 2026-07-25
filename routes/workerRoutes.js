const express = require('express');
const router = express.Router();
const workerController = require('../controllers/workerController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware'); // استيراد الحارس

// حماية جميع مسارات العمال بالتوكن
router.use(authMiddleware);

// 1. جلب قائمة العمال:
// مسموح للأدمن والمشرف (لأن المشرف يحتاج لرؤية العمال المتاحين للإسناد)
router.get('/', restrictTo('Admin', 'Supervisor'), workerController.getAllWorkers);

// 2. إنشاء عامل جديد:
// عملية إدارية حساسة، للأدمن فقط
router.post('/', restrictTo('Admin'), workerController.createWorker);
router.put('/:id', restrictTo('Admin'), workerController.updateWorker);
module.exports = router;