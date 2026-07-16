const express = require('express');
const router = express.Router();
const adminAttendanceController = require('../controllers/adminAttendanceController');
const authMiddleware = require('../middleware/authMiddleware');

router.get('/pending', authMiddleware, adminAttendanceController.getPendingRecords);
router.post('/review', authMiddleware, adminAttendanceController.reviewRecord);
// المسار سيصبح: /api/admin/attendance/records?date=2026-07-20
router.get('/records', authMiddleware, adminAttendanceController.getRecordsByDate);
module.exports = router;