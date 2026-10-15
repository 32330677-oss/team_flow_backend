const express = require('express');
const router = express.Router();
const controller = require('../controllers/projectDailyReportController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

// PROJECT DAILY REPORT (Team Flow + Equipment Flow, Word file). Admin only.
router.use(authMiddleware, restrictTo('Admin'));

router.get('/options', controller.getOptions);
router.post('/profiles', controller.createProfile);
router.put('/profiles/:id', controller.updateProfile);
router.post('/preview', controller.preview);
router.post('/generate', controller.generate);
router.get('/history', controller.history);
router.get('/:id/docx', controller.download);

module.exports = router;
