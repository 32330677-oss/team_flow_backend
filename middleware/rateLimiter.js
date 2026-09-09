const rateLimit = require('express-rate-limit');

// Limits by IP; combined with the per-email guard below to also curb
// distributed spam against a single victim's inbox.
const forgotPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 'error',
        message: 'Too many password reset requests. Please try again later.',
    },
});

module.exports = { forgotPasswordLimiter };