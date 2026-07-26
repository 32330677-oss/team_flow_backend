const express = require('express');
const router = express.Router();
const adminPayrollController = require('../controllers/adminPayrollController');
const authMiddleware = require('../middleware/authMiddleware');

router.post('/generate', authMiddleware, adminPayrollController.generatePayrollBatch);
router.get('/report', authMiddleware, adminPayrollController.getPayrollReport);
router.get('/batch/:batchId', authMiddleware, adminPayrollController.getPayrollBatchDetails);
module.exports = router;