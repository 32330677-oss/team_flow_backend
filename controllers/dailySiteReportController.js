// controllers/dailySiteReportController.js
//
// Daily Site Manpower Report (Admin only) — the PDF sent to the
// sub-contractor / client.
//
//   GET    /api/reports/daily-site/options          sites, signatories, defaults
//   POST   /api/reports/daily-site/preview          counts only (JSON), nothing saved
//   POST   /api/reports/daily-site/generate         PDF; saved with a report number
//   GET    /api/reports/daily-site/history          last generated reports
//   GET    /api/reports/daily-site/:id/pdf          re-print a saved report (same data)
//   GET    /api/reports/daily-site/signatories      "Issued by" list (all)
//   POST   /api/reports/daily-site/signatories      { full_name, title }
//   PUT    /api/reports/daily-site/signatories/:id  { full_name, title, is_active }
//
// Body of preview / generate:
//   { date: 'YYYY-MM-DD' (default today), site_ids: [1,2] | 'all',
//     shift: 'All'|'Day'|'Night', recipient_name,
//     signatory_id | issued_by_name (+ issued_by_title),
//     include_staff: true, show_absent_names: true }

const pool = require('../config/db');
const { businessToday, isValidDateOnly } = require('../services/businessDate');
const { businessNow } = require('../services/biometricPunchProcessor');
const { listReportableSites, buildReportData } = require('../services/dailySiteReportService');
const { renderDailySiteReportPdf } = require('../services/dailySiteReportPdfLayout');

class ReportError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// One PDF at a time: a queued request waits a moment instead of several
// renders running together on a small server.
let renderChain = Promise.resolve();
function queuedRender(report) {
  const run = renderChain.then(() => renderDailySiteReportPdf(report));
  renderChain = run.catch(() => {});
  return run;
}

function fail(res, error, where) {
  if (error && error.code === 'ER_NO_SUCH_TABLE') {
    return res.status(503).json({
      status: 'error',
      message: 'The daily report tables are missing. Run migrations/2026_10_daily_site_report/01_ddl.sql first.',
    });
  }
  if (error && error.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({ status: 'error', message: error.message });
  }
  console.error(`${where}:`, error);
  return res.status(500).json({ status: 'error', message: 'Failed to build the daily site report.' });
}

function text(v, max) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : '';
}

function bool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function json(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v;
}

/** Validates the request and resolves sites, signatory and defaults. */
async function resolveRequest(body) {
  const b = body || {};
  const today = businessToday();
  const date = b.date ? String(b.date) : today;
  if (!isValidDateOnly(date)) throw new ReportError('date must use YYYY-MM-DD.');
  if (date > today) throw new ReportError('The report date cannot be in the future.');

  const shift = b.shift ? String(b.shift) : 'All';
  if (!['All', 'Day', 'Night'].includes(shift)) throw new ReportError("shift must be 'All', 'Day' or 'Night'.");

  const activeSites = await listReportableSites();
  let siteIds;
  if (b.site_ids === 'all' || b.site_ids === undefined || b.site_ids === null) {
    siteIds = activeSites.map((s) => s.site_id);
  } else {
    if (!Array.isArray(b.site_ids) || !b.site_ids.length) throw new ReportError('Choose at least one site.');
    siteIds = [...new Set(b.site_ids.map(Number))];
    if (siteIds.some((id) => !Number.isInteger(id) || id <= 0)) throw new ReportError('site_ids must be site ids.');
    const activeIds = new Set(activeSites.map((s) => s.site_id));
    const bad = siteIds.filter((id) => !activeIds.has(id));
    if (bad.length) throw new ReportError(`These sites are not Active or do not exist: ${bad.join(', ')}.`);
  }
  if (!siteIds.length) throw new ReportError('There is no Active site to report on.');
  const chosen = activeSites.filter((s) => siteIds.includes(s.site_id));

  // Recipient: typed, or the client of the chosen sites when they share one.
  const clients = [...new Set(chosen.map((s) => s.client_name).filter(Boolean))];
  const recipientName = text(b.recipient_name, 200) || (clients.length === 1 ? clients[0] : '');

  // Issued by: a saved signatory, or a typed name (+ title).
  let signatoryId = null;
  let issuedByName = '';
  let issuedByTitle = '';
  if (b.signatory_id !== undefined && b.signatory_id !== null && b.signatory_id !== '') {
    signatoryId = Number(b.signatory_id);
    const [[sig]] = await pool.query(
      'SELECT signatory_id, full_name, title, is_active FROM report_signatories WHERE signatory_id = ?', [signatoryId]);
    if (!sig) throw new ReportError('The selected "Issued by" person was not found.', 404);
    if (Number(sig.is_active) !== 1) throw new ReportError('The selected "Issued by" person is no longer active.');
    issuedByName = sig.full_name;
    issuedByTitle = sig.title;
  } else {
    issuedByName = text(b.issued_by_name, 150);
    issuedByTitle = text(b.issued_by_title, 150);
  }

  return {
    date,
    shift,
    siteIds,
    recipientName,
    signatoryId,
    issuedByName,
    issuedByTitle,
    includeStaff: bool(b.include_staff, true),
    showAbsentNames: bool(b.show_absent_names, true),
  };
}

exports.getOptions = async (req, res) => {
  try {
    const [sites, [signatories]] = await Promise.all([
      listReportableSites(),
      pool.query(
        `SELECT signatory_id, full_name, title FROM report_signatories
         WHERE is_active = 1 ORDER BY full_name`),
    ]);
    return res.json({
      status: 'success',
      data: { business_today: businessToday(), sites, signatories },
    });
  } catch (error) {
    return fail(res, error, 'dailySiteReport.getOptions');
  }
};

exports.preview = async (req, res) => {
  try {
    const q = await resolveRequest(req.body);
    const data = await buildReportData(q);
    return res.json({
      status: 'success',
      data: {
        date: q.date,
        shift: q.shift,
        recipient_name: q.recipientName,
        totals: data.totals,
        sites: data.sites.map((s) => ({
          site_id: s.site_id,
          site_name: s.site_name,
          shifts: s.shifts.map((sh) => ({ shift_type: sh.shift_type, supervisor: sh.supervisor, counts: sh.counts })),
          staff: s.staff ? s.staff.counts : null,
        })),
      },
    });
  } catch (error) {
    return fail(res, error, 'dailySiteReport.preview');
  }
};

function sendPdf(res, buffer, reportNo) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${reportNo}.pdf"`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('X-Report-No', reportNo);
  res.setHeader('Access-Control-Expose-Headers', 'X-Report-No, Content-Disposition');
  return res.end(buffer);
}

exports.generate = async (req, res) => {
  try {
    const q = await resolveRequest(req.body);
    if (!q.issuedByName) throw new ReportError('Choose who the report is issued by.');
    const data = await buildReportData(q);
    const generatedAt = businessNow();
    const options = { include_staff: q.includeStaff, show_absent_names: q.showAbsentNames };

    const [ins] = await pool.query(
      `INSERT INTO daily_site_reports
         (report_date, shift_filter, site_ids, recipient_name, signatory_id, issued_by_name, issued_by_title,
          options, totals, payload, generated_by_user_id, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [q.date, q.shift, JSON.stringify(q.siteIds), q.recipientName || null, q.signatoryId, q.issuedByName,
        q.issuedByTitle || null, JSON.stringify(options), JSON.stringify(data.totals), JSON.stringify(data),
        req.user.user_id, generatedAt]
    );
    const reportNo = `DSR-${q.date.replace(/-/g, '')}-${String(ins.insertId).padStart(4, '0')}`;
    await pool.query('UPDATE daily_site_reports SET report_no = ? WHERE report_id = ?', [reportNo, ins.insertId]);

    const pdf = await queuedRender({
      report_no: reportNo,
      report_date: q.date,
      shift_filter: q.shift,
      recipient_name: q.recipientName,
      issued_by_name: q.issuedByName,
      issued_by_title: q.issuedByTitle,
      generated_at: generatedAt.slice(0, 16),
      options,
      data,
    });
    return sendPdf(res, pdf, reportNo);
  } catch (error) {
    return fail(res, error, 'dailySiteReport.generate');
  }
};

exports.history = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
    const [rows] = await pool.query(
      `SELECT r.report_id, r.report_no, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.shift_filter,
              r.site_ids, r.recipient_name, r.issued_by_name, r.issued_by_title, r.totals,
              DATE_FORMAT(r.generated_at, '%Y-%m-%d %H:%i') AS generated_at, u.full_name AS generated_by
       FROM daily_site_reports r
       LEFT JOIN users u ON u.user_id = r.generated_by_user_id
       ORDER BY r.report_id DESC
       LIMIT ${limit}`
    );
    return res.json({
      status: 'success',
      data: rows.map((r) => ({ ...r, site_ids: json(r.site_ids) || [], totals: json(r.totals) || {} })),
    });
  } catch (error) {
    return fail(res, error, 'dailySiteReport.history');
  }
};

exports.reprint = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ReportError('Invalid report id.');
    const [[row]] = await pool.query(
      `SELECT report_no, DATE_FORMAT(report_date, '%Y-%m-%d') AS report_date, shift_filter, recipient_name,
              issued_by_name, issued_by_title, options, payload,
              DATE_FORMAT(generated_at, '%Y-%m-%d %H:%i') AS generated_at
       FROM daily_site_reports WHERE report_id = ?`, [id]);
    if (!row) throw new ReportError('Report not found.', 404);
    const pdf = await queuedRender({
      report_no: row.report_no,
      report_date: row.report_date,
      shift_filter: row.shift_filter,
      recipient_name: row.recipient_name,
      issued_by_name: row.issued_by_name,
      issued_by_title: row.issued_by_title,
      generated_at: row.generated_at,
      options: json(row.options) || {},
      data: json(row.payload) || { sites: [], totals: {} },
    });
    return sendPdf(res, pdf, row.report_no);
  } catch (error) {
    return fail(res, error, 'dailySiteReport.reprint');
  }
};

// ------------------------------------------------------------ signatories
exports.listSignatories = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT signatory_id, full_name, title, is_active FROM report_signatories
       ORDER BY is_active DESC, full_name`);
    return res.json({ status: 'success', data: rows.map((r) => ({ ...r, is_active: Number(r.is_active) === 1 })) });
  } catch (error) {
    return fail(res, error, 'dailySiteReport.listSignatories');
  }
};

exports.createSignatory = async (req, res) => {
  try {
    const fullName = text(req.body && req.body.full_name, 150);
    const title = text(req.body && req.body.title, 150);
    if (fullName.length < 3) throw new ReportError('Enter the full name (at least 3 characters).');
    if (title.length < 2) throw new ReportError('Enter the job title.');
    const [ins] = await pool.query(
      'INSERT INTO report_signatories (full_name, title, created_by_user_id) VALUES (?, ?, ?)',
      [fullName, title, req.user.user_id]);
    return res.status(201).json({
      status: 'success',
      data: { signatory_id: ins.insertId, full_name: fullName, title, is_active: true },
    });
  } catch (error) {
    return fail(res, error, 'dailySiteReport.createSignatory');
  }
};

exports.updateSignatory = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[sig]] = await pool.query('SELECT * FROM report_signatories WHERE signatory_id = ?', [id]);
    if (!sig) throw new ReportError('Not found.', 404);
    const b = req.body || {};
    const fullName = b.full_name !== undefined ? text(b.full_name, 150) : sig.full_name;
    const title = b.title !== undefined ? text(b.title, 150) : sig.title;
    const isActive = b.is_active !== undefined ? (bool(b.is_active, true) ? 1 : 0) : Number(sig.is_active);
    if (fullName.length < 3) throw new ReportError('Enter the full name (at least 3 characters).');
    if (title.length < 2) throw new ReportError('Enter the job title.');
    await pool.query(
      'UPDATE report_signatories SET full_name = ?, title = ?, is_active = ? WHERE signatory_id = ?',
      [fullName, title, isActive, id]);
    return res.json({ status: 'success', data: { signatory_id: id, full_name: fullName, title, is_active: isActive === 1 } });
  } catch (error) {
    return fail(res, error, 'dailySiteReport.updateSignatory');
  }
};
