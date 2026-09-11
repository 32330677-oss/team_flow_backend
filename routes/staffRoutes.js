const express = require('express');
const router = express.Router();

const staffController = require('../controllers/staffController');
const staffLifecycleController = require('../controllers/staffLifecycleController');
const staffAssignmentController = require('../controllers/staffAssignmentController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

router.get('/', restrictTo('Admin'), staffController.getAllStaff);
router.post('/', restrictTo('Admin'), staffController.createStaff);
router.put('/:id', restrictTo('Admin'), staffController.updateStaff);

// NEW — lifecycle tracking
router.patch('/:id/lifecycle', restrictTo('Admin'), staffLifecycleController.changeStatus);
router.get('/:id/lifecycle-history', restrictTo('Admin'), staffLifecycleController.getStatusHistory);

// NEW — site assignment history
router.get('/:id/assignments', restrictTo('Admin'), staffAssignmentController.getHistory);
router.post('/:id/assignments', restrictTo('Admin'), staffAssignmentController.assignToSite);
router.delete('/:id/assignments/current', restrictTo('Admin'), staffAssignmentController.unassignCurrent);
const staffSupervisorAssignmentController = require('../controllers/staffSupervisorAssignmentController');

// NEW — staff supervisor assignment (Admin only: assigning supervisors is an admin action)
router.get('/:id/supervisor-assignments', restrictTo('Admin'), staffSupervisorAssignmentController.getHistory);
router.post('/:id/supervisor-assignments', restrictTo('Admin'), staffSupervisorAssignmentController.assignSupervisor);
router.delete('/:id/supervisor-assignments/current', restrictTo('Admin'), staffSupervisorAssignmentController.unassignCurrent);
module.exports = router;