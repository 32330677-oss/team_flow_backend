const express = require('express');
const router = express.Router();
const workerController = require('../controllers/workerController');

// توجيه المسارات
router.get('/', workerController.getAllWorkers);
router.post('/', workerController.createWorker);

module.exports = router;