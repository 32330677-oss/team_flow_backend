const express = require('express');
const router = express.Router();
const controller = require('../controllers/staffAdvanceController');
const { publicDocumentLimiter } = require('../middleware/rateLimiter');

// NO authentication: the QR code printed on a voucher / receipt points here.
// The token is random and unguessable (32 characters); unknown tokens get 404.
router.get('/:token.pdf', publicDocumentLimiter, controller.publicDocumentPdf);

module.exports = router;
