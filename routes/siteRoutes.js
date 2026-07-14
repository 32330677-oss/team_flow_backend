const express = require('express');
const router = express.Router();
const siteController = require('../controllers/siteController');

router.get('/contract/:contractId', siteController.getSitesByContract);
router.post('/', siteController.createSite);
// أضف هذا السطر مع الروتس الأخرى في الأسفل
router.get('/supervisor/:supervisorId', siteController.getSitesBySupervisor);
module.exports = router;