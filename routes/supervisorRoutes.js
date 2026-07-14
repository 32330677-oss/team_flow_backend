const express = require('express');
const router = express.Router();
const supervisorController = require('../controllers/supervisorController');

// مسار جلب كل المشرفين + مسار إنشاء مشرف جديد
router.route('/')
    .get(supervisorController.getAllSupervisors)
    .post(supervisorController.createSupervisor);

// تعديل بيانات مشرف معين بالـ ID
router.route('/:id')
    .put(supervisorController.updateSupervisor);

// تفعيل أو تعطيل حساب المشرف
router.route('/:id/status')
    .patch(supervisorController.toggleSupervisorStatus);

module.exports = router;