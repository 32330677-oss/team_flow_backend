const express = require('express');
const router = express.Router();
const controller = require('../controllers/staffOvertimeCompensationController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);
router.use(restrictTo('Admin'));

// النظام الشهري التلقائي الجديد (المصدر الوحيد المعتمد بالفرونت الآن)
router.get('/monthly-ledger', controller.getMonthlyLedger);

// Legacy — نظام التعويض اليدوي القديم (same-day). موجود للتوافق الخلفي فقط.
router.get('/balance', controller.getBalance);
router.get('/history', controller.getHistory);
router.post('/grant', controller.grantCompensation);
router.post('/:compensationId/reverse', controller.reverseCompensation);
router.get('/shortfall-days', controller.getShortfallDays);

module.exports = router;