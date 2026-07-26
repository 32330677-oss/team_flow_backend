const express = require('express');
const router = express.Router();
const adminAttendanceController = require('../controllers/adminAttendanceController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

// Get pending records (Admin & Supervisor)
router.get('/pending', authMiddleware, restrictTo('Admin', 'Supervisor'), adminAttendanceController.getPendingRecords);

// Review record (Admin only)
router.post('/review', authMiddleware, restrictTo('Admin'), adminAttendanceController.reviewRecord);

// Get records by date (Admin & Supervisor)
router.get('/records', authMiddleware, restrictTo('Admin', 'Supervisor'), adminAttendanceController.getRecordsByDate);

// Get break settings (Admin only)
router.get('/settings/breaks', authMiddleware, restrictTo('Admin'), adminAttendanceController.getBreakSettings);

// Update break settings (Admin only)
router.put('/settings/breaks', authMiddleware, restrictTo('Admin'), adminAttendanceController.updateBreakSettings);

module.exports = router;