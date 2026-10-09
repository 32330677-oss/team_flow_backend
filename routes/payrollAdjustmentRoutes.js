const express = require('express');
const router = express.Router();
const controller = require('../controllers/payrollAdjustmentController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware, restrictTo('Admin'));
router.get('/', controller.list);
router.post('/', controller.createManual);
router.get('/open-corrections', controller.openCorrections);
router.post('/open-corrections/:id/compute', controller.computeCorrection);
router.patch('/:id/confirm', controller.confirm);
router.patch('/:id/cancel', controller.cancel);

module.exports = router;
