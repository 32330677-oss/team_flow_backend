// middleware/requirePermission.js
//
// Guard for the new pages: the caller needs EVERY key listed.
// Use after authMiddleware:
//   router.get('/x', authMiddleware, requirePermission('dpr.view'), handler)
// The old routes keep restrictTo('Admin' | 'Supervisor' | ...).

const { accessFor } = require('../services/accessControl');

module.exports = (...keys) => async (req, res, next) => {
  try {
    const access = await accessFor(req.user);
    req.access = access;
    if (keys.every((k) => access.permissions.includes(k))) return next();
    return res.status(403).json({
      status: 'error',
      code: 'PERMISSION_DENIED',
      message: 'You do not have permission to do this.',
    });
  } catch (error) {
    if (error && error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({
        status: 'error',
        message: 'Roles are not set up yet. Run migrations/2026_10_user_dpr/01_ddl.sql first.',
      });
    }
    return next(error);
  }
};
