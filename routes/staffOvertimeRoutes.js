const express = require('express');
const router = express.Router();
const controller = require('../controllers/staffOvertimeCompensationController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);
router.use(restrictTo('Admin')); // rule: only Admin can apply OT compensation / financial adjustments

router.get('/balance', controller.getBalance);
router.get('/history', controller.getHistory);
router.post('/grant', controller.grantCompensation);
router.post('/:compensationId/reverse', controller.reverseCompensation);
router.get('/shortfall-days', controller.getShortfallDays);
module.exports = router;