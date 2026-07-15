const express = require('express');
const router = express.Router();
const siteController = require('../controllers/siteController');
const authMiddleware = require('../middleware/authMiddleware');

// حماية شاملة لجميع روابط المواقع
router.use(authMiddleware);

// الروابط محمية الآن تلقائياً
router.get('/contract/:contractId', siteController.getSitesByContract);
router.post('/', siteController.createSite);

// تم حذف السطر الذي كان يسبب الخطأ هنا (getSitesBySupervisor)

router.get('/my-sites', siteController.getMySites);
// هذا المسار خاص بالأدمن لجلب كل شيء
router.get('/all-sites', siteController.getAllSites);
module.exports = router;