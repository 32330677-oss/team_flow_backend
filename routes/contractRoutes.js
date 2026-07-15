const express = require('express');
const router = express.Router();
const contractController = require('../controllers/contractController');
const authMiddleware = require('../middleware/authMiddleware'); // 1. استيراد الميدل وير

// حماية جميع المسارات الموجودة في هذا الملف بالـ JWT
router.use(authMiddleware);

// المسارات الخاصة بالعقود (أصبحت محمية تلقائياً الآن)
router.get('/project/:projectId', contractController.getContractsByProject);
router.post('/', contractController.createContract);
router.put('/:contractId', contractController.updateContract);

module.exports = router;