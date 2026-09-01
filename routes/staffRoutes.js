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
router.patch('/:id/status', restrictTo('Admin'), staffController.toggleStaffStatus); // kept for backward compatibility

// NEW — lifecycle tracking
router.patch('/:id/lifecycle', restrictTo('Admin'), staffLifecycleController.changeStatus);
router.get('/:id/lifecycle-history', restrictTo('Admin'), staffLifecycleController.getStatusHistory);

// NEW — site assignment history
router.get('/:id/assignments', restrictTo('Admin'), staffAssignmentController.getHistory);
router.post('/:id/assignments', restrictTo('Admin'), staffAssignmentController.assignToSite);
router.delete('/:id/assignments/current', restrictTo('Admin'), staffAssignmentController.unassignCurrent);

module.exports = router;