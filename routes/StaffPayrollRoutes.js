const express = require('express');
const router = express.Router();
const controller = require('../controllers/StaffPayrollController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);

// السماح فقط للأدمن والسوبرفايرز بالوصول إلى كشوفات الرواتب
router.use(restrictTo('Admin'));

router.post('/generate', controller.generateStaffPayrollBatch);
router.get('/report', controller.getStaffPayrollReport);
router.get('/batch/:batchId', controller.getStaffPayrollBatchDetails);
router.patch('/batch/:batchId/mark-paid', controller.markStaffBatchAsPaid);
const versioning = require('../controllers/staffPayrollVersioningController');
router.patch('/batch/:batchId/finalize', versioning.finalizeBatch);
router.post('/batch/:batchId/new-version', versioning.createNewVersion);
router.get('/batch/:batchId/versions', versioning.getVersionChain);
module.exports = router;