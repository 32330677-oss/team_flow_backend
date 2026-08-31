const express = require('express');
const router = express.Router();
const controller = require('../controllers/StaffPayrollController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);
router.use(restrictTo('Admin'));

router.post('/generate', controller.generateStaffPayrollBatch);
router.get('/report', controller.getStaffPayrollReport);
router.get('/batch/:batchId', controller.getStaffPayrollBatchDetails);
router.patch('/batch/:batchId/mark-paid', controller.markStaffBatchAsPaid);

module.exports = router;