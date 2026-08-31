const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware);
router.use(restrictTo('Admin'));

router.get('/daily', dashboardController.getDailyDashboard);
router.get('/weekly', dashboardController.getWeeklyDashboard);
router.get('/monthly', dashboardController.getMonthlyDashboard);

module.exports = router;