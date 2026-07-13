const express = require('express');
const router = express.Router();
const siteController = require('../controllers/siteController');

router.get('/contract/:contractId', siteController.getSitesByContract);
router.post('/', siteController.createSite);

module.exports = router;