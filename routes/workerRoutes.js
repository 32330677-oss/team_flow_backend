const express = require('express');
const router = express.Router();
const workerController = require('../controllers/workerController');
const authMiddleware = require('../middleware/authMiddleware');

// حماية جميع مسارات العمال بالتوكن
router.use(authMiddleware);

// المسارات محمية الآن، لا يمكن جلب العمال أو إضافتهم إلا بتوكن صالح
router.get('/', workerController.getAllWorkers);
router.post('/', workerController.createWorker);

module.exports = router;