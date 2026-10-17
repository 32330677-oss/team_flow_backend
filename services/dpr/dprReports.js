// services/dpr/dprReports.js
//
// Issue, revise, archive and print.
//   * Draft  = the live report (PDF / Excel built from the current data, "DRAFT").
//   * Issue  = the report is frozen: everything printed is saved in dpr_reports.snapshot.
//              The PDF / Excel of an issued report are always rebuilt from that snapshot,
//              so they never change, whatever happens to the data afterwards.
//   * Revise = a new revision (Rev.1, Rev.2...) from the current data; the previous
//              one is kept as "Superseded".
'use strict';

const pool = require('../../config/db');
const fileStorage = require('../fileStorage');
const C = require('./dprCommon');
const M = require('./dprModel');
const { renderDprPdf } = require('./dprPdf');
const { renderDprXlsx } = require('./dprXlsx');

const { DprError } = C;

async function photoBuffers(photos) {
  const out = new Map();
  for (const p of photos || []) {
    try {
      const b = await fileStorage.read(p.file_name);
      if (b) out.set(p.photo_id, b);
    } catch (_) { /* a missing photo is printed as an empty frame */ }
  }
  return out;
}

async function draftFiles(contractId, date, format) {
  const { model } = await M.buildDay(contractId, date);
  const meta = { revision: 0, issued: false };
  const photos = model.sections.photos !== false ? await photoBuffers(model.photos) : new Map();
  const buf = format === 'xlsx' ? await renderDprXlsx(model, meta, photos) : await renderDprPdf(model, meta, photos);
  return { buf, name: fileName(model, meta, format) };
}

function fileName(model, meta, format) {
  const code = String((model.contract && model.contract.code) || 'DPR').replace(/[^A-Za-z0-9_-]+/g, '_');
  const no = String(model.header.report_no || 'DPR').replace(/[^A-Za-z0-9_-]+/g, '_');
  return `${code}_${no}_${model.header.report_date}${meta.revision ? `_Rev${meta.revision}` : ''}${meta.issued ? '' : '_DRAFT'}.${format}`;
}

function reportOut(r) {
  return {
    report_id: Number(r.report_id), contract_id: Number(r.contract_id), report_date: r.report_date, report_no: r.report_no,
    revision: Number(r.revision), status: r.status, notes: r.notes || '', issued_at: r.issued_at, issued_by: r.issued_by || '',
  };
}

/**
 * Issue (revision 0) or revise (next revision). Missing fields / warnings never block,
 * but the caller must confirm them (`accept_warnings: true`) after seeing them.
 */
async function issue(contractId, date, body, userId, { revise = false } = {}) {
  const b = body || {};
  const notes = C.line(b.notes, 500, { label: 'Notes' });
  if (revise && (!notes || notes.length < 3)) throw new DprError('Write the reason of the revision.');
  const { model } = await M.buildDay(contractId, date);
  if (!model.sources_ok.equipment && !C.bool(b.accept_missing_sources)) {
    throw new DprError('The equipment system did not answer: plant figures are missing. Try again later, or confirm to issue without them.', 409,
      { code: 'SOURCES_MISSING', warnings: model.warnings });
  }
  if ((model.missing.length || model.warnings.length) && !C.bool(b.accept_warnings)) {
    throw new DprError('Check the missing fields and warnings before issuing.', 409,
      { code: 'CONFIRM_WARNINGS', missing: model.missing, warnings: model.warnings });
  }
  return C.inTransaction(async (conn) => {
    const [rows] = await conn.query(
      'SELECT report_id, revision, status FROM dpr_reports WHERE contract_id = ? AND report_date = ? ORDER BY revision DESC FOR UPDATE',
      [contractId, date]);
    const current = rows.find((r) => r.status === 'Issued');
    if (!revise && current) throw new DprError('This day is already issued. Use "Revise" to issue a new revision.', 409, { code: 'ALREADY_ISSUED' });
    if (revise && !current) throw new DprError('This day is not issued yet: issue it first.', 409);
    const revision = rows.length ? Number(rows[0].revision) + 1 : 0;
    if (current) await conn.query("UPDATE dpr_reports SET status = 'Superseded' WHERE report_id = ?", [current.report_id]);
    const snapshot = { model, frozen_at: new Date().toISOString(), engine: 'dpr-1' };
    const [ins] = await conn.query(
      `INSERT INTO dpr_reports (contract_id, report_date, report_no, revision, status, snapshot, notes, issued_by_user_id)
       VALUES (?, ?, ?, ?, 'Issued', ?, ?, ?)`,
      [contractId, date, model.header.report_no, revision, JSON.stringify(snapshot), notes, userId]);
    await C.logChange(conn, { contractId, date, entity: 'report', entityId: ins.insertId, field: revise ? 'revised' : 'issued',
      oldValue: current ? `Rev.${current.revision}` : null, newValue: `${model.header.report_no} Rev.${revision}`, userId });
    const [[r]] = await conn.query(
      `SELECT r.report_id, r.contract_id, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.report_no, r.revision, r.status, r.notes,
              DATE_FORMAT(r.issued_at, '%Y-%m-%d %H:%i') AS issued_at, u.full_name AS issued_by
         FROM dpr_reports r LEFT JOIN users u ON u.user_id = r.issued_by_user_id WHERE r.report_id = ?`, [ins.insertId]);
    return reportOut(r);
  });
}

async function listReports(contractId, { from = null, to = null, limit = 400 } = {}) {
  const where = ['r.contract_id = ?'];
  const args = [contractId];
  if (from) { where.push('r.report_date >= ?'); args.push(from); }
  if (to) { where.push('r.report_date <= ?'); args.push(to); }
  const [rows] = await pool.query(
    `SELECT r.report_id, r.contract_id, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.report_no, r.revision, r.status, r.notes,
            DATE_FORMAT(r.issued_at, '%Y-%m-%d %H:%i') AS issued_at, u.full_name AS issued_by
       FROM dpr_reports r LEFT JOIN users u ON u.user_id = r.issued_by_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.report_date DESC, r.revision DESC LIMIT ${Math.min(Math.max(Number(limit) || 400, 1), 2000)}`, args);
  return rows.map(reportOut);
}

async function getReport(reportId) {
  const [[r]] = await pool.query(
    `SELECT r.*, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, DATE_FORMAT(r.issued_at, '%Y-%m-%d %H:%i') AS issued_at,
            u.full_name AS issued_by
       FROM dpr_reports r LEFT JOIN users u ON u.user_id = r.issued_by_user_id WHERE r.report_id = ?`, [reportId]);
  if (!r) throw new DprError('Report not found.', 404);
  const snap = C.json(r.snapshot) || {};
  return { report: reportOut(r), model: snap.model };
}

async function reportFile(reportId, format) {
  const { report, model } = await getReport(reportId);
  if (!model) throw new DprError('This report has no saved data.', 500);
  const meta = { revision: report.revision, issued: true, issued_at: report.issued_at, issued_by: report.issued_by,
    printed_at: report.issued_at ? `${report.issued_at.replace(' ', 'T')}:00` : undefined };
  const photos = model.sections && model.sections.photos === false ? new Map() : await photoBuffers(model.photos);
  const buf = format === 'xlsx' ? await renderDprXlsx(model, meta, photos) : await renderDprPdf(model, meta, photos);
  return { buf, name: fileName(model, meta, format), report };
}

/** Dashboard of the contract on a date + which of the last 30 days are issued. */
async function dashboard(contractId, date) {
  const { model } = await M.buildDay(contractId, date);
  const from = model.dashboard.last_30_days[0].date;
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(report_date, '%Y-%m-%d') AS d, MAX(revision) AS rev FROM dpr_reports
      WHERE contract_id = ? AND report_date BETWEEN ? AND ? AND status = 'Issued' GROUP BY report_date`, [contractId, from, date]);
  const issued = new Map(rows.map((r) => [r.d, Number(r.rev)]));
  // a day with anything typed (fields, counts, activities, QA, photos, manual values) is a draft
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(x.report_date, '%Y-%m-%d') AS d FROM (
       SELECT report_date FROM dpr_days WHERE contract_id = ? AND report_date BETWEEN ? AND ?
       UNION SELECT report_date FROM dpr_day_counts WHERE contract_id = ? AND report_date BETWEEN ? AND ?
       UNION SELECT report_date FROM dpr_activities WHERE contract_id = ? AND report_date BETWEEN ? AND ? AND is_deleted = 0
       UNION SELECT report_date FROM dpr_qa WHERE contract_id = ? AND report_date BETWEEN ? AND ? AND is_deleted = 0
       UNION SELECT report_date FROM dpr_photos WHERE contract_id = ? AND report_date BETWEEN ? AND ? AND is_deleted = 0
       UNION SELECT report_date FROM dpr_overrides WHERE contract_id = ? AND report_date BETWEEN ? AND ? AND reverted_at IS NULL
     ) x`, Array(6).fill([contractId, from, date]).flat());
  const typed = new Set(days.map((r) => r.d));
  return {
    contract: model.contract,
    date,
    header: model.header,
    summary: model.summary,
    hse: model.hse,
    kpis: model.dashboard,
    days: model.dashboard.last_30_days.map((d) => ({
      ...d,
      status: issued.has(d.date) ? 'Issued' : (typed.has(d.date) ? 'Draft' : 'None'),
      revision: issued.has(d.date) ? issued.get(d.date) : null,
    })),
    warnings: model.warnings,
  };
}

module.exports = { draftFiles, issue, listReports, getReport, reportFile, dashboard };
