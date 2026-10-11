const express = require('express');
const router = express.Router();
const controller = require('../controllers/staffAdvanceController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

// Staff salary advances: Admin only.
router.use(authMiddleware, restrictTo('Admin'));

router.post('/financial-report', controller.openFinancialReport);
router.get('/financial-report/:reportId.pdf', controller.financialReportPdf);
router.get('/financial-report/:reportId', controller.getFinancialReport);
router.get('/months', controller.months);

router.get('/', controller.list);
router.post('/', controller.create);
router.get('/:id/voucher.pdf', controller.voucherPdf);
router.get('/:id/repayments/:entryId/receipt.pdf', controller.repaymentReceiptPdf);
router.post('/:id/signed-receipt', controller.uploadMiddleware, controller.uploadSignedReceipt);
router.get('/:id/signed-receipt', controller.downloadSignedReceipt);
router.get('/:id', controller.get);
router.post('/:id/cancel', controller.cancel);
router.put('/:id/schedule', controller.reschedule);
router.post('/:id/repay', controller.repay);
router.post('/:id/write-off', controller.writeOff);

module.exports = router;
