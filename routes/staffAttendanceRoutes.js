const express = require('express');
const router = express.Router();
const staffAttendanceController = require('../controllers/staffAttendanceController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

// ==================== Workers Bulk Attendance (Admin / Supervisor) ====================
router.post('/workers/bulk-checkin', restrictTo('Admin', 'Supervisor'), staffAttendanceController.bulkCheckIn);
router.post('/workers/bulk-checkout', restrictTo('Admin', 'Supervisor'), staffAttendanceController.bulkCheckOut);

// ==================== Staff Self-Service ====================
router.post('/self', restrictTo('Staff'), staffAttendanceController.selfMarkAttendance);
router.get('/self', restrictTo('Staff'), staffAttendanceController.getMyAttendance);

// ==================== Admin / Supervisor Review (Staff Attendance) ====================
router.get('/pending', restrictTo('Admin', 'Supervisor'), staffAttendanceController.getPendingStaffAttendance);
router.post('/review', restrictTo('Admin', 'Supervisor'), staffAttendanceController.reviewStaffAttendance);
router.get('/by-date', restrictTo('Admin', 'Supervisor'), staffAttendanceController.getStaffAttendanceByDate);

module.exports = router;