const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staffController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

// حماية جميع مسارات الموظفين الإداريين بالتوكن
router.use(authMiddleware);

// 1. جلب جميع الموظفين الإداريين: للأدمن فقط
router.get('/', restrictTo('Admin'), staffController.getAllStaff);

// 2. إنشاء موظف إداري جديد (ينشئ حساب دخول تلقائياً): للأدمن فقط
router.post('/', restrictTo('Admin'), staffController.createStaff);

// 3. تعديل بيانات موظف إداري: للأدمن فقط
router.put('/:id', restrictTo('Admin'), staffController.updateStaff);

// 4. تفعيل/تعطيل حساب موظف إداري: للأدمن فقط
router.patch('/:id/status', restrictTo('Admin'), staffController.toggleStaffStatus);

module.exports = router;