const express = require('express');
const router = express.Router();
const contractController = require('../controllers/contractController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware'); // استدعاء الحارس

// 1. حماية المسارات بالتوكن (طبقناها سابقاً)
router.use(authMiddleware);

// 2. جلب العقود: مسموح للأدمن والمشرف (لأن المشرف قد يحتاج لمعرفة تفاصيل العقد)
router.get('/project/:projectId', restrictTo('Admin', 'Supervisor'), contractController.getContractsByProject);

// 3. إنشاء عقد جديد: عملية إدارية حساسة (للأدمن فقط)
router.post('/', restrictTo('Admin'), contractController.createContract);

// 4. تعديل عقد: عملية إدارية حساسة (للأدمن فقط)
router.put('/:contractId', restrictTo('Admin'), contractController.updateContract);

module.exports = router;