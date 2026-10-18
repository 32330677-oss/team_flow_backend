// services/dpr/dprCommon.js — small shared helpers of the DPR module.
'use strict';

const pool = require('../../config/db');
const D = require('./dec');

class DprError extends Error {
  constructor(message, statusCode = 400, extra) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra || null;
  }
}

// ------------------------------------------------------------------ input cleaning
function text(v, max, { required = false, label = 'This field' } = {}) {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
  if (required && !s) throw new DprError(`${label} is required.`);
  if (s.length > max) throw new DprError(`${label} is too long (max ${max} characters).`);
  return s || null;
}
const line = (v, max, opts) => {
  const s = text(v, max, opts);
  return s === null ? null : s.replace(/\s*\n\s*/g, ' ');
};

function isDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
  const [y, m, d] = String(v).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function date(v, { required = false, label = 'Date' } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) throw new DprError(`${label} is required.`);
    return null;
  }
  const s = String(v).slice(0, 10);
  if (!isDate(s)) throw new DprError(`${label} must be a valid date (YYYY-MM-DD).`);
  return s;
}

/** Exact decimal as a string (validated, not rounded). */
function decimal(v, { label = 'Value', min = null, max = null, places = 4, required = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) throw new DprError(`${label} is required.`);
    return null;
  }
  const s = String(v).trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new DprError(`${label} must be a number.`);
  const frac = (s.split('.')[1] || '');
  if (frac.replace(/0+$/, '').length > places) throw new DprError(`${label}: at most ${places} decimal places.`);
  const x = D.of(s);
  if (min !== null && x < D.of(min)) throw new DprError(`${label} cannot be less than ${min}.`);
  if (max !== null && x > D.of(max)) throw new DprError(`${label} cannot be more than ${max}.`);
  return D.str(x);
}
function integer(v, { label = 'Value', min = 0, max = 1000000, required = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) throw new DprError(`${label} is required.`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new DprError(`${label} must be a whole number.`);
  if (n < min || n > max) throw new DprError(`${label} must be between ${min} and ${max}.`);
  return n;
}
function id(v, label = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new DprError(`Invalid ${label}.`);
  return n;
}
function oneOf(v, list, { label = 'Value', required = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) throw new DprError(`${label} is required.`);
    return null;
  }
  const s = String(v);
  const hit = list.find((x) => x.toLowerCase() === s.toLowerCase());
  if (!hit) throw new DprError(`${label} must be one of: ${list.join(', ')}.`);
  return hit;
}
function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function ids(v, max = 200) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(Number))].filter((n) => Number.isInteger(n) && n > 0).slice(0, max);
}
function json(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v;
}

// ------------------------------------------------------------------ lists (as in the workbook's Lists sheet)
const LISTS = {
  categories: ['Staff', 'Supervision', 'Skilled', 'Semi-skilled', 'Unskilled', 'Operators & Drivers'],
  weather: ['Clear', 'Sunny', 'Cloudy', 'Hazy', 'Humid', 'Windy', 'Sandstorm', 'Rain', 'Fog', 'Extreme Heat'],
  qa_types: ['IR', 'MIR', 'Test', 'Material Delivery', 'Method Statement'],
  qa_results: ['Approved', 'Approved with Comments', 'Rejected', 'Pending'],
  severity: ['High', 'Medium', 'Low'],
  impact: ['Time', 'Cost', 'Quality', 'Safety', 'Time / Cost'],
  status: ['Open', 'Closed'],
  ownership: ['Own', 'Hired'],
  res_types: ['Manpower', 'Plant'],
  eot_vo_types: ['VO', 'EOT'],
  approval: ['Approved', 'Pending', 'Rejected'],
};

/** Sections of the printed report (all printed unless switched off). */
const SECTIONS = [
  { key: 'weather', label: '1. Weather & site conditions' },
  { key: 'manpower', label: '2. Own manpower & own plant' },
  { key: 'subcon', label: '3. Subcontractor resources' },
  { key: 'summary', label: 'Resource summary' },
  { key: 'work', label: '4. Work progress (BOQ)' },
  { key: 'boq', label: 'Overall progress – whole BOQ' },
  { key: 'qa', label: '5. QA / QC' },
  { key: 'hse', label: '6. Health, safety & environment' },
  { key: 'ncr', label: '7. Non-conformance reports' },
  { key: 'concerns', label: '8. Areas of concern' },
  { key: 'plan', label: '9. Planned activities' },
  { key: 'remarks', label: '10. General remarks' },
  { key: 'signatures', label: 'Signatures' },
  { key: 'materials', label: 'Delivered materials' },
  { key: 'areas', label: 'Area / bridge pages' },
  { key: 'photos', label: '11. Site photographs' },
  { key: 'alloc', label: 'Resource allocation matrix (Alloc)' },
];
const SECTION_KEYS = SECTIONS.map((s) => s.key);
/** Sections of "our design" (client's-form data): no allocation, subcontractors are in the tables. */
const OURS_SECTIONS = SECTIONS.filter((s) => !['alloc', 'subcon'].includes(s.key))
  .map((s) => (s.key === 'qa' ? { ...s, label: '5. WIR register' } : s));

function sectionFlags(raw, base) {
  const r = json(raw) || {};
  const b = json(base) || {};
  const out = {};
  for (const k of SECTION_KEYS) out[k] = bool(r[k], b[k] === undefined ? true : bool(b[k], true));
  return out;
}

// ------------------------------------------------------------------ db helpers
async function inTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

const stringify = (v) => {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
};

async function logChange(conn, { contractId, date: d = null, entity, entityId = null, field = null, oldValue, newValue, userId }) {
  const o = stringify(oldValue);
  const n = stringify(newValue);
  if (o === n) return;
  await conn.query(
    `INSERT INTO dpr_change_log (contract_id, report_date, entity, entity_id, field, old_value, new_value, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [contractId, d, entity, entityId === null ? null : String(entityId), field, o, n, userId || null]);
}

/** Compares two rows field by field and logs each change. */
async function logRowChanges(conn, base, before, after, fields) {
  for (const f of fields) {
    const a = before ? before[f] : null;
    const b = after ? after[f] : null;
    const norm = (v) => (v === undefined || v === '' ? null : (v === null ? null : String(v)));
    if (norm(a) !== norm(b)) await logChange(conn, { ...base, field: f, oldValue: norm(a), newValue: norm(b) });
  }
}

async function getContractRow(conn, contractId) {
  const [[c]] = await conn.query('SELECT * FROM dpr_contracts WHERE contract_id = ?', [contractId]);
  if (!c) throw new DprError('Contract not found.', 404);
  return c;
}

module.exports = {
  DprError, text, line, isDate, date, decimal, integer, id, oneOf, bool, ids, json,
  LISTS, SECTIONS, SECTION_KEYS, OURS_SECTIONS, sectionFlags, inTransaction, logChange, logRowChanges, getContractRow,
};
