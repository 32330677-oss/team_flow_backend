// services/dpr/dprManual.js
//
// Manual values of the QC over any figure of the report (v2).
//
// A manual value is stored with a SCOPE:
//   day      this report only: the value of that day (other days unchanged)
//   forward  from this day on: the same value every following day, until another
//            manual value or its end date (a cumulative "from this day on" is a
//            target: the cumulative of that day, later days add their own quantities)
//   chain    a day quantity that ALSO counts in the cumulative of later days
//
// The system value is never changed (the systems are only read). A value typed
// by the QC is never replaced by a system figure arriving later. Removing a
// manual value: everywhere (as if never typed) or from a date (earlier days keep it).
// Writes ONLY to dpr_manual_values and dpr_change_log.
'use strict';

const crypto = require('crypto');
const pool = require('../../config/db');
const C = require('./dprCommon');

const { DprError } = C;

const SCOPES = ['day', 'forward', 'chain'];
const KEY_RE = /^(line:\d+:(total|present|absent|operative|breakdown|idle)|boq:\d+:(qty|budget|curr|cum|balance)|tot:[a-z_]+:[a-z_]+)$/;

function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function entryOut(r) {
  return {
    mv_id: Number(r.mv_id), contract_id: Number(r.contract_id), field_key: r.field_key, field_label: r.field_label || '',
    value: r.value, scope: r.scope, from_date: r.from_date, to_date: r.to_date || null,
    system_value: r.system_value, reason: r.reason || '', group_key: r.group_key || null,
    created_by: r.created_by || '', created_at: r.created_at,
    reverted_at: r.reverted_at || null, reverted_by: r.reverted_by || '', revert_note: r.revert_note || '',
    active: !r.reverted_at,
  };
}

const SELECT = `SELECT m.mv_id, m.contract_id, m.field_key, m.field_label, m.value, m.scope,
       DATE_FORMAT(m.from_date, '%Y-%m-%d') AS from_date, DATE_FORMAT(m.to_date, '%Y-%m-%d') AS to_date,
       m.system_value, m.reason, m.group_key, DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i') AS created_at, u.full_name AS created_by,
       DATE_FORMAT(m.reverted_at, '%Y-%m-%d %H:%i') AS reverted_at, r.full_name AS reverted_by, m.revert_note
  FROM dpr_manual_values m
  LEFT JOIN users u ON u.user_id = m.created_by_user_id
  LEFT JOIN users r ON r.user_id = m.reverted_by_user_id`;

/** Active manual values of a contract that can apply on or before `to`. */
async function loadActive(contractId, to) {
  const [rows] = await pool.query(
    `${SELECT} WHERE m.contract_id = ? AND m.reverted_at IS NULL AND m.from_date <= ? ORDER BY m.from_date, m.mv_id`,
    [contractId, to]);
  return rows.map(entryOut);
}

/**
 * Pure resolver over a list of active entries.
 *   at(key, date)      -> the entry giving the value of `key` on `date` (day beats forward), or null
 *   chain(key, date)   -> the 'chain' entry of that day, or null
 *   targets(key)       -> the 'forward' entries of a cumulative key (sorted by date)
 */
function resolver(entries) {
  const byKey = new Map();
  for (const e of entries) {
    if (!e.active) continue;
    const list = byKey.get(e.field_key) || [];
    list.push(e);
    byKey.set(e.field_key, list);
  }
  const pick = (list) => list.reduce((best, e) => (!best || e.from_date > best.from_date
    || (e.from_date === best.from_date && e.mv_id > best.mv_id) ? e : best), null);
  return {
    keys: () => [...byKey.keys()],
    at(key, date) {
      const list = byKey.get(key);
      if (!list) return null;
      const day = pick(list.filter((e) => e.scope === 'day' && e.from_date === date));
      if (day) return day;
      return pick(list.filter((e) => e.scope === 'forward' && e.from_date <= date && (!e.to_date || e.to_date >= date)));
    },
    chain(key, date) {
      const list = byKey.get(key);
      if (!list) return null;
      return pick(list.filter((e) => e.scope === 'chain' && e.from_date === date));
    },
    forwardList(key) {
      return (byKey.get(key) || []).filter((e) => e.scope === 'forward').sort((a, b) => (a.from_date < b.from_date ? -1 : 1));
    },
    chainDates(key) {
      return (byKey.get(key) || []).filter((e) => e.scope === 'chain').map((e) => e.from_date);
    },
  };
}

function cleanValue(key, v) {
  if (/:(total|present|absent|operative|breakdown|idle)$/.test(key) || key.startsWith('tot:')) {
    return C.decimal(v, { label: 'Value', min: 0, max: 100000000, places: 4, required: true });
  }
  return C.decimal(v, { label: 'Value', min: -99999999999999, max: 99999999999999, places: 4, required: true });
}

/**
 * Days and issued reports a manual value would change (shown to the QC before saving).
 * forward: from `date` to `toDate` (or today); day: that day only. For a cumulative key
 * or a 'chain' quantity, every later day's cumulative changes too.
 */
async function impact(contractIds, { key, scope, date, toDate = null, today }) {
  const cumLike = /:cum$/.test(key) || scope === 'chain';
  const last = scope === 'day' && !cumLike ? date : (toDate && scope === 'forward' && !cumLike ? toDate : today);
  const ids = contractIds.filter(Boolean);
  if (!ids.length) return { from: date, to: last, days: 0, issued: [] };
  const [rows] = await pool.query(
    `SELECT r.contract_id, c.code, DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.report_no, r.revision
       FROM dpr_reports r JOIN dpr_contracts c ON c.contract_id = r.contract_id
      WHERE r.contract_id IN (?) AND r.status = 'Issued' AND r.report_date BETWEEN ? AND ?
      ORDER BY r.report_date, c.code`, [ids, date, last]);
  const days = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000) + 1;
  return {
    from: date,
    to: last,
    days: Math.max(days, 1),
    issued: rows.map((r) => ({ contract_id: Number(r.contract_id), code: r.code, report_date: r.report_date, report_no: r.report_no, revision: Number(r.revision) })),
  };
}

/**
 * Saves a manual value in one contract (or the same value in several contracts in one
 * action: `targets` = [{ contractId, key, label, systemValue }]). Replaces an active
 * value of the same key with the same scope and start day.
 */
async function setValue({ targets, value, scope, date, toDate = null, reason, userId }) {
  const sc = C.oneOf(scope, SCOPES, { label: 'Scope', required: true });
  if (sc === 'chain' && !targets.every((t) => /^boq:\d+:curr$/.test(t.key))) {
    throw new DprError('"Counts in the cumulative" is only for the quantity of the day.');
  }
  if (sc === 'forward' && /:curr$/.test(targets[0].key)) {
    throw new DprError('The quantity of the day cannot repeat on the following days: choose "this report only" or "counts in the cumulative".');
  }
  const to = sc === 'forward' ? C.date(toDate, { label: 'Last day' }) : null;
  if (to && to < date) throw new DprError('The last day cannot be before the first day.');
  const why = C.line(reason, 500, { label: 'Reason' });
  const group = targets.length > 1 ? crypto.randomUUID() : null;
  return C.inTransaction(async (conn) => {
    const out = [];
    for (const t of targets) {
      if (!KEY_RE.test(t.key)) throw new DprError('This figure cannot be changed.');
      const v = cleanValue(t.key, value);
      const [old] = await conn.query(
        `SELECT mv_id, value FROM dpr_manual_values
          WHERE contract_id = ? AND field_key = ? AND scope = ? AND from_date = ? AND reverted_at IS NULL FOR UPDATE`,
        [t.contractId, t.key, sc, date]);
      if (old.length) {
        await conn.query(
          `UPDATE dpr_manual_values SET reverted_at = CURRENT_TIMESTAMP, reverted_by_user_id = ?, revert_note = 'replaced'
            WHERE mv_id IN (?)`, [userId, old.map((o) => o.mv_id)]);
      }
      const [ins] = await conn.query(
        `INSERT INTO dpr_manual_values (contract_id, field_key, field_label, value, scope, from_date, to_date, system_value, reason, group_key, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.contractId, t.key, (t.label || '').slice(0, 300) || null, v, sc, date, to,
          t.systemValue === null || t.systemValue === undefined ? null : String(t.systemValue).slice(0, 64), why, group, userId]);
      await C.logChange(conn, { contractId: t.contractId, date, entity: 'manual', entityId: t.key, field: sc,
        oldValue: old.length ? old[old.length - 1].value : null, newValue: { value: v, scope: sc, to, reason: why }, userId });
      out.push({ mv_id: ins.insertId, contract_id: t.contractId, key: t.key, value: v, scope: sc });
    }
    return out;
  });
}

/**
 * Removes the manual value that gives `key` its value on `date`.
 *   mode 'all'  -> removed everywhere (as if never typed)
 *   mode 'from' -> a 'forward' value stops the day before `fromDate` (earlier days keep it)
 */
async function revert({ contractId, key, date, mode = 'all', fromDate = null, userId }) {
  const m = C.oneOf(mode, ['all', 'from'], { label: 'Mode', required: true });
  return C.inTransaction(async (conn) => {
    const [rows] = await conn.query(
      `${SELECT} WHERE m.contract_id = ? AND m.field_key = ? AND m.reverted_at IS NULL AND m.from_date <= ? FOR UPDATE`,
      [contractId, key, date]);
    const R = resolver(rows.map(entryOut));
    const e = R.at(key, date) || R.chain(key, date);
    if (!e) throw new DprError('There is no manual value on this figure for this day.', 404);
    const from = m === 'from' ? C.date(fromDate || date, { label: 'From', required: true }) : null;
    if (m === 'from' && e.scope === 'forward' && from > e.from_date) {
      await conn.query('UPDATE dpr_manual_values SET to_date = ? WHERE mv_id = ?', [addDays(from, -1), e.mv_id]);
      await C.logChange(conn, { contractId, date: from, entity: 'manual', entityId: key, field: 'stopped',
        oldValue: { value: e.value, to: e.to_date }, newValue: { to: addDays(from, -1) }, userId });
      return { mv_id: e.mv_id, stopped_after: addDays(from, -1) };
    }
    await conn.query(
      `UPDATE dpr_manual_values SET reverted_at = CURRENT_TIMESTAMP, reverted_by_user_id = ?, revert_note = 'removed'
        WHERE mv_id = ?`, [userId, e.mv_id]);
    await C.logChange(conn, { contractId, date: e.from_date, entity: 'manual', entityId: key, field: 'removed',
      oldValue: { value: e.value, scope: e.scope }, newValue: 'system', userId });
    return { mv_id: e.mv_id, removed: true };
  });
}

/** Every manual value ever typed on a figure (newest first). */
async function historyOf(contractId, key) {
  const [rows] = await pool.query(`${SELECT} WHERE m.contract_id = ? AND m.field_key = ? ORDER BY m.mv_id DESC LIMIT 200`, [contractId, key]);
  return rows.map(entryOut);
}

/** Admin / QC list: manual values vs system values (all contracts or one). */
async function differences({ contractId = null, includeReverted = false, limit = 500 } = {}) {
  const where = ['1 = 1'];
  const args = [];
  if (contractId) { where.push('m.contract_id = ?'); args.push(contractId); }
  if (!includeReverted) where.push('m.reverted_at IS NULL');
  const [rows] = await pool.query(
    `SELECT x.*, c.code AS contract_code,
            EXISTS (SELECT 1 FROM dpr_reports rp WHERE rp.contract_id = x.contract_id AND rp.report_date = x.from_date AND rp.status = 'Issued') AS issued
       FROM (${SELECT} WHERE ${where.join(' AND ')}) x JOIN dpr_contracts c ON c.contract_id = x.contract_id
      ORDER BY x.from_date DESC, x.mv_id DESC LIMIT ${Math.min(Math.max(Number(limit) || 500, 1), 2000)}`, args);
  return rows.map((r) => ({ ...entryOut(r), contract_code: r.contract_code, issued: Number(r.issued) === 1 }));
}

module.exports = { SCOPES, KEY_RE, addDays, loadActive, resolver, impact, setValue, revert, historyOf, differences, entryOut };
