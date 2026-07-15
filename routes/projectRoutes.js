const express = require('express');
const router = express.Router();
const projectController = require('../controllers/projectController');
const authMiddleware = require('../middleware/authMiddleware'); // استيراد الميدل وير

// حماية جميع مسارات المشاريع بالتوكن
router.use(authMiddleware);

// مسارات التحكم بالمشاريع
router.get('/', projectController.getAllProjects);
router.post('/', projectController.createProject);

module.exports = router;