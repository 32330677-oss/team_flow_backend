// controllers/staffAdvanceController.js — Admin API for staff salary advances.
// See services/staffAdvanceService.js for the rules.
const path = require('path');
const multer = require('multer');
const db = require('../config/db');
const svc = require('../services/staffAdvanceService');
const pdf = require('../services/staffAdvancePdf');
const fileStorage = require('../services/fileStorage');

const RECEIPT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };

// POST /api/staff-advances/financial-report   { staff_id }
exports.openFinancialReport = async (req, res) => {
  try {
    const data = await svc.buildFinancialReport(req.body?.staff_id, req.user.user_id);
    return res.status(201).json({ status: 'success', data });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to build the financial report.');
  }
};

// GET /api/staff-advances/financial-report/:reportId(.pdf)
exports.getFinancialReport = async (req, res) => {
  try {
    return res.status(200).json({ status: 'success', data: await svc.getFinancialReport(req.params.reportId) });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to load the financial report.');
  }
};
exports.financialReportPdf = async (req, res) => {
  try {
    const report = await svc.getFinancialReport(req.params.reportId);
    return pdf.renderFinancialReportPdf(res, report);
  } catch (error) {
    if (res.headersSent) return undefined;
    return svc.sendError(res, error, 'Failed to export the financial report.');
  }
};

// GET /api/staff-advances/months  -> next 12 months with Paid / open-batch state
exports.months = async (req, res) => {
  try {
    return res.status(200).json({ status: 'success', data: await svc.availableMonths() });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to load the months.');
  }
};

// GET /api/staff-advances?status=&staff_id=&month=&q=
exports.list = async (req, res) => {
  try {
    const rows = await svc.listAdvances({ status: req.query.status, staffId: req.query.staff_id, month: req.query.month, q: req.query.q });
    const totals = {};
    for (const r of rows) {
      if (r.status !== 'Active') continue;
      totals[r.currency] = svc.money((totals[r.currency] || 0) + r.outstanding_balance);
    }
    return res.status(200).json({ status: 'success', data: rows, open_balance_by_currency: totals });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to load advances.');
  }
};

// GET /api/staff-advances/:id
exports.get = async (req, res) => {
  try {
    return res.status(200).json({ status: 'success', data: await svc.getAdvance(req.params.id) });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to load the advance.');
  }
};

// POST /api/staff-advances
//   { staff_id, amount, schedule: [{ month: 'YYYY-MM', amount }], reason,
//     payment_method?, payment_reference?, financial_report_id, idempotency_key? }
exports.create = async (req, res) => {
  try {
    const b = req.body || {};
    const result = await svc.createAdvance({
      staffId: b.staff_id, amount: b.amount, schedule: b.schedule, reason: b.reason,
      paymentMethod: b.payment_method, paymentReference: b.payment_reference,
      reportId: b.financial_report_id, idempotencyKey: b.idempotency_key || req.get('Idempotency-Key'),
      userId: req.user.user_id,
    });
    if (result.duplicate) {
      return res.status(200).json({ status: 'success', duplicate: true,
        message: `Already created: ${result.advance.voucher_no}. No second advance was made.`, data: result.advance });
    }
    return res.status(201).json({
      status: 'success',
      message: `Advance ${result.advance.voucher_no} created. Print the voucher and have it signed.`,
      data: result.advance,
      ...(result.warnings && result.warnings.length ? { warnings: result.warnings } : {}),
    });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to create the advance.');
  }
};

// POST /api/staff-advances/:id/cancel   { reason }
exports.cancel = async (req, res) => {
  try {
    const r = await svc.cancelAdvance(req.params.id, { reason: req.body?.reason, userId: req.user.user_id });
    return res.status(200).json({
      status: 'success',
      message: `Advance ${r.voucher_no} cancelled. Everything is back as it was` +
        (r.reversed.length ? ` (deduction removed from staff batch ${r.reversed.map((x) => `#${x.batch_id}`).join(', ')}).` : '.'),
      data: r.advance, reversed: r.reversed,
    });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to cancel the advance.');
  }
};

// PUT /api/staff-advances/:id/schedule   { schedule: [{ month, amount }], reason }
exports.reschedule = async (req, res) => {
  try {
    const r = await svc.rescheduleAdvance(req.params.id, { schedule: req.body?.schedule, reason: req.body?.reason, userId: req.user.user_id });
    return res.status(200).json({ status: 'success', message: 'Deduction schedule updated.', data: r.advance,
      ...(r.warnings && r.warnings.length ? { warnings: r.warnings } : {}) });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to update the schedule.');
  }
};

// POST /api/staff-advances/:id/repay   { amount, reason, payment_method? }
exports.repay = async (req, res) => {
  try {
    const r = await svc.repayAdvance(req.params.id, {
      amount: req.body?.amount, reason: req.body?.reason, paymentMethod: req.body?.payment_method, userId: req.user.user_id,
    });
    return res.status(201).json({ status: 'success',
      message: `Repayment recorded: receipt ${r.receipt_no}. Balance ${r.balance.toFixed(2)}.`,
      receipt_no: r.receipt_no, entry_id: r.entry_id, data: r.advance });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to record the repayment.');
  }
};

// POST /api/staff-advances/:id/write-off   { reason }
exports.writeOff = async (req, res) => {
  try {
    const r = await svc.writeOffAdvance(req.params.id, { reason: req.body?.reason, userId: req.user.user_id });
    return res.status(200).json({ status: 'success', message: `Advance ${r.advance.voucher_no} written off.`, data: r.advance });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to write off the advance.');
  }
};

async function loadStaff(staffId) {
  const [[staff]] = await db.execute(
    `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position, sm.monthly_salary, s.site_name,
            DATE_FORMAT(COALESCE(sm.first_hire_date, sm.hire_date), '%Y-%m-%d') AS hire_date
     FROM staff_members sm LEFT JOIN sites s ON s.site_id = sm.site_id WHERE sm.staff_id = ?`, [staffId]);
  return staff;
}

// GET /api/staff-advances/:id/voucher.pdf   (every print is counted; reprints say COPY)
exports.voucherPdf = async (req, res) => {
  try {
    const advance = await svc.getAdvance(req.params.id);
    const staff = await loadStaff(advance.staff_id);
    const printNumber = await svc.recordVoucherPrint(advance.advance_id, req.user.user_id);
    const [[u]] = await db.execute('SELECT full_name FROM users WHERE user_id = ?', [req.user.user_id]);
    return pdf.renderVoucherPdf(res, { advance, staff, printNumber, printedBy: u ? u.full_name : null });
  } catch (error) {
    if (res.headersSent) return undefined;
    return svc.sendError(res, error, 'Failed to export the voucher.');
  }
};

// GET /api/staff-advances/:id/repayments/:entryId/receipt.pdf
exports.repaymentReceiptPdf = async (req, res) => {
  try {
    const advance = await svc.getAdvance(req.params.id);
    const entryId = Number(req.params.entryId);
    let running = 0;
    let entry = null;
    for (const l of advance.ledger) {
      running = svc.money(running + l.amount);
      if (l.entry_id === entryId) { entry = { ...l, balance_after: running }; break; }
    }
    if (!entry || entry.entry_type !== 'CashRepayment') {
      return res.status(404).json({ status: 'error', message: 'Repayment not found.' });
    }
    const staff = await loadStaff(advance.staff_id);
    return pdf.renderRepaymentReceiptPdf(res, { advance, staff, entry });
  } catch (error) {
    if (res.headersSent) return undefined;
    return svc.sendError(res, error, 'Failed to export the receipt.');
  }
};

// POST /api/staff-advances/:id/signed-receipt   multipart field "file" (JPG, PNG, WEBP or PDF, max 8 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (RECEIPT_TYPES[ext] && RECEIPT_TYPES[ext] === file.mimetype) return cb(null, true);
    const e = new Error('Only JPG, PNG, WEBP or PDF files are allowed.');
    e.code = 'INVALID_FILE_TYPE';
    return cb(e);
  },
}).single('file');
exports.uploadMiddleware = (req, res, next) => upload(req, res, (err) => {
  if (!err) return next();
  return res.status(400).json({ status: 'error',
    message: err.code === 'LIMIT_FILE_SIZE' ? 'The file must be 8 MB or smaller.' : (err.code === 'INVALID_FILE_TYPE' ? err.message : 'Invalid upload.') });
});
exports.uploadSignedReceipt = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ status: 'error', message: 'Choose the signed voucher file.' });
    }
    const name = await fileStorage.save(fileStorage.newName('advance_receipt', req.file.originalname), req.file.buffer, req.file.mimetype);
    await svc.saveSignedReceipt(req.params.id, { fileName: name, userId: req.user.user_id });
    return res.status(200).json({ status: 'success', message: 'Signed voucher uploaded.', data: await svc.getAdvance(req.params.id) });
  } catch (error) {
    return svc.sendError(res, error, 'Failed to upload the signed voucher.');
  }
};
exports.downloadSignedReceipt = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[a]] = await db.execute('SELECT receipt_file FROM staff_advances WHERE advance_id = ?', [Number.isInteger(id) ? id : 0]);
    if (!a || !a.receipt_file) return res.status(404).json({ status: 'error', message: 'No signed voucher uploaded.' });
    const ok = await fileStorage.send(res, a.receipt_file);
    if (!ok && !res.headersSent) return res.status(404).json({ status: 'error', message: 'File not found.' });
    return undefined;
  } catch (error) {
    if (res.headersSent) return undefined;
    return svc.sendError(res, error, 'Failed to download the signed voucher.');
  }
};
