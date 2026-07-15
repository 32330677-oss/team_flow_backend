const express = require('express');
const router = express.Router();
const supervisorController = require('../controllers/supervisorController');
const authMiddleware = require('../middleware/authMiddleware');

// حماية جميع مسارات المشرفين بالتوكن
router.use(authMiddleware);

// المسارات محمية الآن ولا يمكن الوصول إليها إلا بتوكن صالح
router.route('/')
    .get(supervisorController.getAllSupervisors)
    .post(supervisorController.createSupervisor);

router.route('/:id')
    .put(supervisorController.updateSupervisor);

router.route('/:id/status')
    .patch(supervisorController.toggleSupervisorStatus);

module.exports = router;