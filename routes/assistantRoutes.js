const express = require('express');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');
const assistantController = require('../controllers/assistantController');

const router = express.Router();

router.use(authMiddleware);
router.use(restrictTo('Admin', 'Supervisor', 'StaffSupervisor'));

// Per user (not per IP: supervisors on the same site share one IP).
// Keeps the API bill predictable.
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.ASSISTANT_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `assistant-user-${req.user.user_id}`,
  message: {
    success: false,
    code: 'ASSISTANT_RATE_LIMIT',
    message: 'Too many questions. Please wait a few minutes and try again.',
  },
});

router.get('/status', assistantController.getStatus);
router.get('/guide', assistantController.getGuide);
router.post('/chat', chatLimiter, assistantController.chat);

module.exports = router;
