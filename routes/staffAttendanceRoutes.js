const express = require('express');
const router = express.Router();
const staffAttendanceController = require('../controllers/staffAttendanceController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

// ==================== Workers Bulk Attendance (Admin / Supervisor) ====================
// UNCHANGED — this is worker attendance (Worker Supervisor), not staff. Do not touch.
router.post('/workers/bulk-checkin', restrictTo('Admin', 'Supervisor'), staffAttendanceController.bulkCheckIn);
router.post('/workers/bulk-checkout', restrictTo('Admin', 'Supervisor'), staffAttendanceController.bulkCheckOut);

// ==================== Staff Self-Service ====================
router.post('/self', restrictTo('Staff'), staffAttendanceController.selfMarkAttendance);
router.get('/self', restrictTo('Staff'), staffAttendanceController.getMyAttendance);

// ==================== Admin / Staff Supervisor Review (Staff Attendance) ====================
// CHANGED: 'Supervisor' -> 'StaffSupervisor'. Worker Supervisors never had
// staff attendance data in scope; this closes that gap. Scope filtering to
// only assigned staff is applied inside the controller for StaffSupervisor.
router.get('/pending', restrictTo('Admin', 'StaffSupervisor'), staffAttendanceController.getPendingStaffAttendance);
router.post('/review', restrictTo('Admin', 'StaffSupervisor'), staffAttendanceController.reviewStaffAttendance);
router.get('/by-date', restrictTo('Admin', 'StaffSupervisor'), staffAttendanceController.getStaffAttendanceByDate);

const staffAttendanceAdminController = require('../controllers/staffAttendanceAdminController');
router.get('/admin/day', restrictTo('Admin'), staffAttendanceAdminController.getDayView);
router.post('/admin/bulk-set', restrictTo('Admin'), staffAttendanceAdminController.bulkSetAttendance);
const staffAttendanceSupervisorController = require('../controllers/staffAttendanceSupervisorController');
router.get('/supervisor/day', restrictTo('StaffSupervisor'), staffAttendanceSupervisorController.getDayView);
router.post('/supervisor/bulk-set', restrictTo('StaffSupervisor'), staffAttendanceSupervisorController.bulkSetAttendance);
// ==================== Pre-payroll: Management-Paid Absences ====================
const staffAbsenceController = require('../controllers/staffAbsenceController');
router.get('/admin/absences', restrictTo('Admin'), staffAbsenceController.getAbsenceSummary);
router.post('/admin/absences/mark-paid', restrictTo('Admin'), staffAbsenceController.markAbsencesPaid);
router.post('/admin/absences/unmark-paid', restrictTo('Admin'), staffAbsenceController.unmarkAbsencePaid);

module.exports = router;