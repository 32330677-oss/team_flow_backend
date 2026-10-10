const express = require('express');
const router = express.Router();
const controller = require('../controllers/dailySiteReportController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

// Daily Site Manpower Report (sent to the sub-contractor). Admin only.
router.use(authMiddleware, restrictTo('Admin'));

router.get('/options', controller.getOptions);
router.post('/preview', controller.preview);
router.post('/generate', controller.generate);
router.get('/history', controller.history);
router.get('/signatories', controller.listSignatories);
router.post('/signatories', controller.createSignatory);
router.put('/signatories/:id', controller.updateSignatory);
router.get('/:id/pdf', controller.reprint);

module.exports = router;
