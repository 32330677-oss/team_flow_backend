const express = require('express');
const router = express.Router();
const controller = require('../controllers/recycleBinController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

router.use(authMiddleware, restrictTo('Admin'));
router.get('/', controller.list);
router.post('/:id/restore', controller.restore);
router.delete('/:id', controller.purge);

module.exports = router;
