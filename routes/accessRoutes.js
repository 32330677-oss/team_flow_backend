const express = require('express');
const router = express.Router();
const controller = require('../controllers/accessController');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware');

// Roles & accounts of type 'User'. Every route needs a signed-in account.
router.use(authMiddleware);

// Any signed-in account: its own role and permissions (the app builds its menu from them).
router.get('/me', controller.me);

// Everything else: Admin only.
router.use(restrictTo('Admin'));
router.get('/permissions', controller.listPermissions);
router.get('/roles', controller.listRoles);
router.post('/roles', controller.createRole);
router.put('/roles/:id', controller.updateRole);
router.delete('/roles/:id', controller.deleteRole);
router.get('/users', controller.listUsers);
router.post('/users', controller.createUser);
router.put('/users/:id', controller.updateUser);
router.patch('/users/:id/status', controller.setUserStatus);
router.put('/users/:id/password', controller.resetUserPassword);
router.get('/audit', controller.listAudit);

module.exports = router;
