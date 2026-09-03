const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

router.get('/sites/:siteId/workers', attendanceController.getSiteWorkers);
router.post('/checkin', attendanceController.checkIn);
router.post('/status', attendanceController.setAttendanceStatus);
router.post('/checkout', attendanceController.checkOut);
router.post('/submit', attendanceController.submitDay);
router.post('/leave/start', attendanceController.startLeave);
router.post('/leave/end', attendanceController.endLeave);
router.post('/lunch/bulk', attendanceController.saveLunchBulk);
router.get('/rejected', restrictTo('Admin', 'Supervisor'), attendanceController.getRejectedRecords);
router.patch('/:attendance_id/management-leave', restrictTo('Admin'), attendanceController.setManagementLeaveHours);
router.patch('/:attendance_id/resubmit', restrictTo('Supervisor'), attendanceController.resubmitAttendance);
// attendanceRoutes.js
router.post('/bulk/checkin', restrictTo('Admin', 'Supervisor'), attendanceController.bulkCheckIn);
router.post('/bulk/checkout', restrictTo('Admin', 'Supervisor'), attendanceController.bulkCheckOut);
router.patch('/:attendance_id/edit-times', attendanceController.editAttendanceTimes);

module.exports = router;
