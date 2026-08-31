const express = require('express');
const router = express.Router();
const staffAttendanceController = require('../controllers/staffAttendanceController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

// ==================== Workers Bulk Attendance (Admin / Manager) ====================
router.post('/workers/bulk-checkin', restrictTo('Admin', 'SuperAdmin'), staffAttendanceController.bulkCheckIn);
router.post('/workers/bulk-checkout', restrictTo('Admin', 'SuperAdmin'), staffAttendanceController.bulkCheckOut);

// ==================== Staff Self-Service ====================
router.post('/self', restrictTo('Staff'), staffAttendanceController.selfMarkAttendance);
router.get('/self', restrictTo('Staff'), staffAttendanceController.getMyAttendance);

// ==================== Admin Review (Staff Attendance) ====================
router.get('/pending', restrictTo('Admin', 'SuperAdmin'), staffAttendanceController.getPendingStaffAttendance);
router.post('/review', restrictTo('Admin', 'SuperAdmin'), staffAttendanceController.reviewStaffAttendance);
router.get('/by-date', restrictTo('Admin', 'SuperAdmin'), staffAttendanceController.getStaffAttendanceByDate);

module.exports = router;