const express = require('express');
const router = express.Router();
const siteController = require('../controllers/siteController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware'); // استدعاء الحارس

// حماية شاملة لجميع روابط المواقع
router.use(authMiddleware);

// 1. جلب مواقع عقد معين: مسموح للأدمن والمشرف
router.get('/contract/:contractId', restrictTo('Admin', 'Supervisor'), siteController.getSitesByContract);

// 2. إنشاء موقع جديد: للأدمن فقط
router.post('/', restrictTo('Admin'), siteController.createSite);

// 3. مواقعي (للسوبرفايزر): مسموح للمشرف (ويمكن للأدمن أيضاً إذا أردت)
router.get('/my-sites', restrictTo('Admin', 'Supervisor'), siteController.getMySites);

// 4. جلب كل المواقع: للأدمن فقط (حتى لا يتمكن المشرف من رؤية مواقع ليست تحت إدارته)
router.get('/all-sites', restrictTo('Admin'), siteController.getAllSites);

module.exports = router;