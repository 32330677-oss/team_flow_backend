const express = require('express');
const router = express.Router();
const adminPayrollController = require('../controllers/adminPayrollController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/generate', authMiddleware, adminPayrollController.generatePayrollBatch);
router.get('/report', authMiddleware, adminPayrollController.getPayrollReport);
router.get('/batch/:batchId', authMiddleware, adminPayrollController.getPayrollBatchDetails);
router.patch('/batch/:batchId/mark-paid', authMiddleware, adminPayrollController.markBatchAsPaid);
router.get('/last-date', authMiddleware, adminPayrollController.getLastBatchEndDate); // ✅ مسار نسبي صحيح

module.exports = router;