const express = require('express');
const router = express.Router();
const staffAttendanceController = require('../controllers/staffAttendanceController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

// الموظف الإداري يسجّل ويجلب حضوره الشخصي فقط
router.post('/self', restrictTo('Staff'), staffAttendanceController.selfMarkAttendance);
router.get('/self', restrictTo('Staff'), staffAttendanceController.getMyAttendance);

// مراجعة الأدمن لسجلات كل الموظفين الإداريين
router.get('/pending', restrictTo('Admin'), staffAttendanceController.getPendingStaffAttendance);
router.post('/review', restrictTo('Admin'), staffAttendanceController.reviewStaffAttendance);
router.get('/by-date', restrictTo('Admin'), staffAttendanceController.getStaffAttendanceByDate);

module.exports = router;