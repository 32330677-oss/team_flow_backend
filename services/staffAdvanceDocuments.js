// services/staffAdvanceDocuments.js
//
// Frozen documents for staff advances.
//
// The payment voucher (ADV-...) and every cash repayment receipt (RCP-...) are
// frozen the moment they are issued: their content is stored as JSON together
// with a SHA-256 fingerprint. Every later print and every QR download renders
// that frozen content, so a copy always matches the signed paper. The current
// state of an advance (what was deducted, the balance) is a separate document:
// the Advance Statement.
//
// Each frozen document also gets a random, unguessable public token. Its QR
// code points to GET /api/public/documents/<token>.pdf, which anyone holding the
// paper can scan to download the same document (no login).

const crypto = require('crypto');
const db = require('../config/db');

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const COMPANY_NAME = 'ASIK ENGINEERING CONSTRUCTION';

class DocError extends Error {
  constructor(message, statusCode = 400, code = undefined) {
    super(message);
    this.isOperational = true;
    this.statusCode = statusCode;
    this.code = code;
  }
}

const money2 = (v) => (Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100).toFixed(2);

function monthLabel(month) {
  if (!month) return null;
  const [y, m] = String(month).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Key order independent JSON (MySQL's JSON type does not keep key order).
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
const fingerprint = (snapshot) => crypto.createHash('sha256').update(canonical(snapshot)).digest('hex');
const newPublicToken = () => crypto.randomBytes(24).toString('base64url'); // 32 characters
const parseJson = (v) => (v === null || v === undefined ? null : (typeof v === 'string' ? JSON.parse(v) : v));

async function staffBlock(executor, staffId) {
  const [[s]] = await executor.execute(
    `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position, sm.monthly_salary, s.site_name,
            DATE_FORMAT(COALESCE(sm.first_hire_date, sm.hire_date), '%Y-%m-%d') AS hire_date
     FROM staff_members sm LEFT JOIN sites s ON s.site_id = sm.site_id WHERE sm.staff_id = ?`, [staffId]);
  return {
    staff_id: s.staff_id, staff_unique_id: s.staff_unique_id, full_name: s.full_name, position: s.position || null,
    site_name: s.site_name || null, hire_date: s.hire_date || null, monthly_salary: money2(s.monthly_salary),
  };
}

// ---------------------------------------------------------------------------
// Payment voucher
// ---------------------------------------------------------------------------
async function buildVoucherSnapshot(executor, advanceId, { late = false } = {}) {
  const [[a]] = await executor.execute(
    `SELECT a.*, DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at_str,
            DATE_FORMAT(a.cancel_deadline, '%Y-%m-%d %H:%i') AS cancel_deadline_str, u.full_name AS created_by
     FROM staff_advances a JOIN users u ON u.user_id = a.created_by_user_id WHERE a.advance_id = ?`, [advanceId]);
  if (!a) throw new DocError('Advance not found.', 404, 'NOT_FOUND');
  let schedule = null;
  if (late) {
    // Frozen after issue (advance created before documents were frozen): use the
    // schedule recorded in the creation audit entry, i.e. what was signed.
    const [[log]] = await executor.execute(
      `SELECT new_values FROM auditlogs WHERE table_name = 'staff_advances' AND record_id = ? AND action_type = 'ADVANCE_CREATED'
       ORDER BY log_id LIMIT 1`, [advanceId]);
    const created = log ? parseJson(log.new_values) : null;
    if (created && Array.isArray(created.schedule) && created.schedule.length) {
      schedule = created.schedule.map((r, i) => ({ seq: i + 1, month: r.month, month_label: monthLabel(r.month), amount: money2(r.amount) }));
    }
  }
  if (!schedule) {
    const [inst] = await executor.execute(
      `SELECT deduction_month, amount FROM staff_advance_installments
       WHERE advance_id = ? AND status <> 'Replaced' AND split_from_installment_id IS NULL ORDER BY seq`, [advanceId]);
    schedule = inst.map((r, i) => ({ seq: i + 1, month: r.deduction_month, month_label: monthLabel(r.deduction_month), amount: money2(r.amount) }));
  }
  return {
    doc_type: 'ADVANCE_VOUCHER',
    version: 1,
    company: COMPANY_NAME,
    voucher_no: a.voucher_no,
    issued_at: a.created_at_str,
    staff: await staffBlock(executor, a.staff_id),
    currency: a.currency,
    amount: money2(a.amount),
    payment_method: a.payment_method,
    payment_reference: a.payment_reference || null,
    deduction_mode: a.deduction_mode,
    reason: a.reason,
    schedule,
    cancel_deadline: a.cancel_deadline_str,
    created_by: a.created_by,
    financial_report_id: a.financial_report_id,
    frozen_late: Boolean(late),
  };
}

// Freezes the voucher once (no-op when already frozen). Runs in the caller's transaction.
async function freezeVoucher(executor, advanceId, { late = false } = {}) {
  const snapshot = await buildVoucherSnapshot(executor, advanceId, { late });
  await executor.execute(
    `UPDATE staff_advances SET voucher_snapshot = ?, voucher_hash = ?, public_token = COALESCE(public_token, ?)
     WHERE advance_id = ? AND voucher_snapshot IS NULL`,
    [JSON.stringify(snapshot), fingerprint(snapshot), newPublicToken(), advanceId]);
}

// ---------------------------------------------------------------------------
// Cash repayment receipt
// ---------------------------------------------------------------------------
async function buildReceiptSnapshot(executor, entryId) {
  const [[e]] = await executor.execute(
    `SELECT l.*, DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i') AS created_at_str, u.full_name AS received_by,
            a.voucher_no, a.staff_id, a.currency, a.amount AS advance_amount
     FROM staff_advance_ledger l
     JOIN staff_advances a ON a.advance_id = l.advance_id
     JOIN users u ON u.user_id = l.created_by_user_id
     WHERE l.entry_id = ?`, [entryId]);
  if (!e || e.entry_type !== 'CashRepayment') throw new DocError('Repayment not found.', 404, 'NOT_FOUND');
  const [[bal]] = await executor.execute(
    'SELECT COALESCE(SUM(amount), 0) AS b FROM staff_advance_ledger WHERE advance_id = ? AND entry_id <= ?', [e.advance_id, entryId]);
  return {
    doc_type: 'REPAYMENT_RECEIPT',
    version: 1,
    company: COMPANY_NAME,
    receipt_no: e.receipt_no,
    issued_at: e.created_at_str,
    voucher_no: e.voucher_no,
    staff: await staffBlock(executor, e.staff_id),
    currency: e.currency,
    advance_amount: money2(e.advance_amount),
    amount: money2(-Number(e.amount)),
    payment_method: e.payment_method || 'Cash',
    note: e.note || null,
    balance_after: money2(bal.b),
    received_by: e.received_by,
  };
}

async function freezeReceipt(executor, entryId) {
  const snapshot = await buildReceiptSnapshot(executor, entryId);
  await executor.execute(
    `UPDATE staff_advance_ledger SET document_snapshot = ?, document_hash = ?, public_token = COALESCE(public_token, ?)
     WHERE entry_id = ? AND document_snapshot IS NULL`,
    [JSON.stringify(snapshot), fingerprint(snapshot), newPublicToken(), entryId]);
}

// ---------------------------------------------------------------------------
// Loading (with integrity check)
// ---------------------------------------------------------------------------
function verified(snapshotRaw, hash, label) {
  const snapshot = parseJson(snapshotRaw);
  if (!snapshot || !hash || fingerprint(snapshot) !== hash) {
    throw new DocError(`${label}: the stored document does not match its fingerprint. It was changed after it was issued; ` +
      'it is not printed. Check the audit log.', 409, 'DOCUMENT_INTEGRITY');
  }
  return snapshot;
}

async function loadVoucher(rawAdvanceId) {
  const advanceId = Number(rawAdvanceId);
  if (!Number.isInteger(advanceId) || advanceId <= 0) throw new DocError('Invalid advance id.');
  let [[a]] = await db.execute(
    `SELECT advance_id, voucher_no, status, voucher_snapshot, voucher_hash, public_token, cancel_reason,
            DATE_FORMAT(cancelled_at, '%Y-%m-%d %H:%i') AS cancelled_at
     FROM staff_advances WHERE advance_id = ?`, [advanceId]);
  if (!a) throw new DocError('Advance not found.', 404, 'NOT_FOUND');
  if (!a.voucher_snapshot) {
    await freezeVoucher(db, advanceId, { late: true });
    [[a]] = await db.execute(
      `SELECT advance_id, voucher_no, status, voucher_snapshot, voucher_hash, public_token, cancel_reason,
              DATE_FORMAT(cancelled_at, '%Y-%m-%d %H:%i') AS cancelled_at
       FROM staff_advances WHERE advance_id = ?`, [advanceId]);
  }
  return {
    kind: 'voucher', advance_id: a.advance_id, number: a.voucher_no, token: a.public_token, hash: a.voucher_hash,
    status: a.status, cancelled_at: a.cancelled_at, cancel_reason: a.cancel_reason,
    doc: verified(a.voucher_snapshot, a.voucher_hash, a.voucher_no),
  };
}

async function loadReceipt(rawAdvanceId, rawEntryId) {
  const advanceId = Number(rawAdvanceId);
  const entryId = Number(rawEntryId);
  if (!Number.isInteger(advanceId) || !Number.isInteger(entryId)) throw new DocError('Invalid id.');
  const sel = `SELECT l.entry_id, l.advance_id, l.entry_type, l.receipt_no, l.document_snapshot, l.document_hash, l.public_token,
                      a.status FROM staff_advance_ledger l JOIN staff_advances a ON a.advance_id = l.advance_id
               WHERE l.entry_id = ? AND l.advance_id = ?`;
  let [[e]] = await db.execute(sel, [entryId, advanceId]);
  if (!e || e.entry_type !== 'CashRepayment') throw new DocError('Repayment not found.', 404, 'NOT_FOUND');
  if (!e.document_snapshot) {
    await freezeReceipt(db, entryId);
    [[e]] = await db.execute(sel, [entryId, advanceId]);
  }
  return {
    kind: 'receipt', advance_id: e.advance_id, entry_id: e.entry_id, number: e.receipt_no, token: e.public_token,
    hash: e.document_hash, status: e.status, doc: verified(e.document_snapshot, e.document_hash, e.receipt_no),
  };
}

// Public QR download: token -> frozen document. Unknown tokens -> 404 (no detail).
async function findByPublicToken(rawToken) {
  const token = String(rawToken || '');
  if (!TOKEN_RE.test(token)) return null;
  const [[a]] = await db.execute('SELECT advance_id FROM staff_advances WHERE public_token = ?', [token]);
  if (a) return loadVoucher(a.advance_id);
  const [[e]] = await db.execute(
    `SELECT entry_id, advance_id FROM staff_advance_ledger WHERE public_token = ? AND entry_type = 'CashRepayment'`, [token]);
  if (e) return loadReceipt(e.advance_id, e.entry_id);
  return null;
}

// Absolute URL encoded in the QR code. PUBLIC_BASE_URL (e.g. https://api.example.com)
// wins; otherwise the URL the request came in on (Render: https behind the proxy).
function publicDocumentUrl(req, token) {
  const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/api/public/documents/${token}.pdf`;
}

async function qrPng(url) {
  const QRCode = require('qrcode');
  return QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 360 });
}

module.exports = {
  DocError, canonical, fingerprint, newPublicToken, TOKEN_RE,
  buildVoucherSnapshot, freezeVoucher, buildReceiptSnapshot, freezeReceipt,
  loadVoucher, loadReceipt, findByPublicToken, publicDocumentUrl, qrPng,
};
