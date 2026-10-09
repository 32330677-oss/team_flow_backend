// controllers/payrollAdjustmentController.js — Admin API for payroll adjustments (retro pay).
const svc = require('../services/payrollAdjustmentService');

const parseRow = (r) => ({ ...r, calc_detail: typeof r.calc_detail === 'string' ? JSON.parse(r.calc_detail) : r.calc_detail });

// GET /api/payroll-adjustments?status=&person_type=
exports.list = async (req, res) => {
  try {
    const rows = await svc.list({ status: req.query.status, personType: req.query.person_type });
    return res.status(200).json({ status: 'success', data: rows.map(parseRow) });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to load payroll adjustments.');
  }
};

// POST /api/payroll-adjustments   { person_type, person_id, amount, reason }
exports.createManual = async (req, res) => {
  try {
    const data = await svc.createManual({
      personType: req.body?.person_type, personId: req.body?.person_id, amount: req.body?.amount,
      reason: req.body?.reason, userId: req.user.user_id,
    });
    return res.status(201).json({
      status: 'success',
      message: data.status === 'AwaitingConfirmation'
        ? 'Deduction recorded. Confirm it to include it in the next payroll batch.'
        : 'Adjustment recorded. It will be included in the next payroll batch.',
      data,
    });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to create the adjustment.');
  }
};

// PATCH /api/payroll-adjustments/:id/confirm
exports.confirm = async (req, res) => {
  try {
    await svc.changeStatus(req.params.id, 'confirm', { userId: req.user.user_id });
    return res.status(200).json({ status: 'success', message: 'Confirmed: it will be included in the next payroll batch.' });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to confirm the adjustment.');
  }
};

// PATCH /api/payroll-adjustments/:id/cancel   { reason }
exports.cancel = async (req, res) => {
  try {
    await svc.changeStatus(req.params.id, 'cancel', { reason: req.body?.reason, userId: req.user.user_id });
    return res.status(200).json({ status: 'success', message: 'Adjustment cancelled.' });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to cancel the adjustment.');
  }
};

// GET /api/payroll-adjustments/open-corrections
exports.openCorrections = async (req, res) => {
  try {
    return res.status(200).json({ status: 'success', data: await svc.listOpenCorrections() });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to load open corrections.');
  }
};

// POST /api/payroll-adjustments/open-corrections/:id/compute
exports.computeCorrection = async (req, res) => {
  try {
    const data = await svc.retryCorrection(req.params.id, req.user.user_id);
    return res.status(200).json({
      status: 'success',
      message: data.adjustment_id
        ? `Payroll adjustment #${data.adjustment_id}: ${data.amount > 0 ? '+' : ''}${Number(data.amount).toFixed(2)} ${data.currency}.`
        : 'No pay difference: the correction was closed.',
      data,
    });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to compute the adjustment.');
  }
};
