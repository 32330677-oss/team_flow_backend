// controllers/recycleBinController.js
//
// HTTP layer of the recycle bin (services/recycleBinService.js). Admin only
// (enforced in the routes). Staff is supported now; Worker uses the same
// service once its entity definition is added.
const svc = require('../services/recycleBinService');

const staff = {
  // GET /api/staff/:id/deletion-check
  check: async (req, res) => {
    try {
      const data = await svc.deletionCheck(require('../config/db'), 'Staff', req.params.id);
      return res.status(200).json({ status: 'success', data });
    } catch (error) {
      return svc.sendServiceError(res, error, 'Failed to check the delete.');
    }
  },
  // DELETE /api/staff/:id   { reason, confirm_name }
  remove: async (req, res) => {
    try {
      const data = await svc.deleteToBin('Staff', req.params.id, {
        reason: req.body?.reason, confirmName: req.body?.confirm_name, userId: req.user.user_id,
      });
      return res.status(200).json({
        status: 'success',
        message: `Moved to the recycle bin. It can be restored until ${data.purge_after}.`,
        data,
      });
    } catch (error) {
      return svc.sendServiceError(res, error, 'Failed to delete the staff member.');
    }
  },
  // POST /api/staff/:id/deletion-hold   { reason }
  hold: async (req, res) => {
    try {
      const data = await svc.createHold('Staff', req.params.id, { reason: req.body?.reason, userId: req.user.user_id });
      return res.status(201).json({
        status: 'success',
        message: 'On hold: this staff member is excluded from new payroll. Supersede the finalized batch, then delete.',
        data,
      });
    } catch (error) {
      return svc.sendServiceError(res, error, 'Failed to put the staff member on hold.');
    }
  },
  // DELETE /api/staff/:id/deletion-hold   { reason }
  releaseHold: async (req, res) => {
    try {
      const data = await svc.releaseHold('Staff', req.params.id, { reason: req.body?.reason, userId: req.user.user_id });
      return res.status(200).json({ status: 'success', message: 'Hold released: the staff member is included in payroll again.', data });
    } catch (error) {
      return svc.sendServiceError(res, error, 'Failed to release the hold.');
    }
  },
};

// GET /api/recycle-bin?status=Deleted|Restored
async function list(req, res) {
  try {
    const data = await svc.listBin({ status: req.query.status });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return svc.sendServiceError(res, error, 'Failed to load the recycle bin.');
  }
}

// POST /api/recycle-bin/:id/restore   { reason }
async function restore(req, res) {
  try {
    const data = await svc.restoreFromBin(req.params.id, { reason: req.body?.reason, userId: req.user.user_id });
    return res.status(200).json({
      status: 'success',
      message: data.warnings.length
        ? 'Restored. Some finalized payroll was generated without this person: supersede it (see warnings).'
        : 'Restored with all records.',
      data,
    });
  } catch (error) {
    return svc.sendServiceError(res, error, 'Failed to restore.');
  }
}

// DELETE /api/recycle-bin/:id   { reason }   (delete permanently now)
async function purge(req, res) {
  try {
    const data = await svc.purgeNow(req.params.id, { reason: req.body?.reason, userId: req.user.user_id });
    return res.status(200).json({ status: 'success', message: 'Deleted permanently.', data });
  } catch (error) {
    return svc.sendServiceError(res, error, 'Failed to delete permanently.');
  }
}

module.exports = { staff, list, restore, purge };
