const express = require('express');
const router = express.Router();
const controller = require('../controllers/mainDashboardController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);
router.use(restrictTo('Admin'));

router.get('/overview', controller.getOverview);

module.exports = router;