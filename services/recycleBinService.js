// services/recycleBinService.js
//
// Safe delete with a 30-day undo window ("recycle bin").
//
// How it works
//   * DELETE: in ONE transaction every row that belongs to the person (all the
//     tables listed in the entity definition) is copied as JSON into
//     recycle_bin.payload, then removed from the live tables, children first.
//     To the rest of the system the person no longer exists: no query anywhere
//     needs a "deleted" filter, so nothing can show or pay a deleted person.
//   * RESTORE: the rows are inserted back with their ORIGINAL ids, parents
//     first, in one transaction. Any failure rolls everything back.
//   * PURGE: after `purge_after` the bin entry is removed for good. Only a
//     minimal audit entry (ids, no name) stays in auditlogs.
//
// Payroll rules (decided 2026-10-09)
//   * Person in a PAID batch            -> never deleted (money was paid).
//   * Person in a Generated batch,
//     not finalized                     -> VOID the batch first.
//   * Person in a Finalized (unpaid)
//     batch                             -> put the person ON HOLD (excluded
//                                          from new payroll), SUPERSEDE the
//                                          batch, then delete.
//   * Voided / Superseded batches       -> the person's lines go to the bin
//                                          with everything else; the batch
//                                          header (stored totals) is history
//                                          and is not changed.
//
// Safety nets
//   * Any OTHER table with a foreign key to one of the person's tables that
//     still has rows for this person blocks the delete (UNHANDLED_DEPENDENCY),
//     so a table added later can never be orphaned or silently skipped.
//   * Biometric data (device mapping / processed punches) blocks the delete
//     for now (BIOMETRIC_DATA): biometric is not in use yet; its handling is
//     added when it goes live.
//   * Restore refuses when a payroll batch generated AFTER the person was
//     excluded covers his employment (RESTORE_PERIOD_LOCKED / VOID_REQUIRED),
//     so a restored person can never sit in a period that was paid without him.

const db = require('../config/db');

class OpError extends Error {
  constructor(message, statusCode = 400, code = undefined, extra = {}) {
    super(message);
    this.isOperational = true;
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// Entity definitions. `tables` is in DELETE order (children first); restore
// uses the reverse order. `where` takes the person's id as its only parameter.
// ---------------------------------------------------------------------------
const ENTITIES = {
  Staff: {
    type: 'Staff',
    root: 'staff_members',
    pk: 'staff_id',
    codeColumn: 'staff_unique_id',
    nameColumn: 'full_name',
    tables: [
      // Cancelled payroll adjustments only (open ones block the delete, see deletionCheck).
      { table: 'payroll_adjustments', pk: 'adjustment_id', where: "person_type = 'Staff' AND person_id = ?" },
      { table: 'attendance_corrections_log', pk: 'correction_id', where: "record_table = 'staff_attendance' AND person_id = ?" },
      { table: 'staff_overtime_compensations', pk: 'compensation_id', where: 'staff_id = ?' },
      { table: 'staff_monthly_overtime_ledger', pk: 'ledger_id', where: 'staff_id = ?' },
      { table: 'staff_payroll', pk: 'staff_payroll_id', where: 'staff_id = ?' },
      { table: 'staff_attendance', pk: 'staff_attendance_id', where: 'staff_id = ?' },
      { table: 'staff_site_assignments', pk: 'staff_assignment_id', where: 'staff_id = ?' },
      { table: 'staff_supervisor_assignments', pk: 'staff_assignment_id', where: 'staff_id = ?' },
      { table: 'staff_compensation_history', pk: 'staff_compensation_id', where: 'staff_id = ?' },
      { table: 'staff_status_history', pk: 'status_history_id', where: 'staff_id = ?' },
      { table: 'staff_members', pk: 'staff_id', where: 'staff_id = ?' },
    ],
    payroll: {
      batchTable: 'staff_payroll_batches',
      batchPk: 'staff_payroll_batch_id',
      lineTable: 'staff_payroll',
    },
  },
};

function entityDef(type) {
  const def = ENTITIES[type];
  if (!def) throw new OpError(`Unsupported entity type: ${type}`, 400);
  return def;
}

function requireText(value, name, min = 5) {
  const text = String(value ?? '').trim();
  if (text.length < min) throw new OpError(`${name} is required (at least ${min} characters).`, 400, 'REASON_REQUIRED');
  return text.slice(0, 500);
}

function positiveId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new OpError('Invalid id.', 400);
  return n;
}

async function retentionDays(executor) {
  const [[row]] = await executor.execute(
    "SELECT setting_value FROM system_settings WHERE setting_key = 'recycle_bin_retention_days'");
  const n = Number(row?.setting_value);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30;
}

async function existingTables(executor, names) {
  const [rows] = await executor.query(
    'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)', [names]);
  return new Set(rows.map((r) => r.t));
}

async function auditLog(executor, tableName, recordId, action, userId, oldValues, newValues) {
  await executor.execute(
    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [tableName, recordId, action, userId || null,
      oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null]
  );
}

async function openHold(executor, type, id, { lock = false } = {}) {
  const [[hold]] = await executor.execute(
    `SELECT hold_id, reason, created_by_user_id, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
     FROM entity_deletion_holds WHERE entity_type = ? AND entity_id = ? AND released_at IS NULL
     ${lock ? 'FOR UPDATE' : ''}`, [type, id]);
  return hold || null;
}

// ---------------------------------------------------------------------------
// Pre-flight check: what blocks the delete and what would be removed.
// Read-only unless `lock` is true (used inside the delete transaction).
// ---------------------------------------------------------------------------
async function deletionCheck(executor, type, rawId, { lock = false } = {}) {
  const def = entityDef(type);
  const id = positiveId(rawId);
  const forUpdate = lock ? 'FOR UPDATE' : '';

  const [[person]] = await executor.execute(
    `SELECT ${def.pk} AS id, ${def.codeColumn} AS code, ${def.nameColumn} AS name, status
     FROM ${def.root} WHERE ${def.pk} = ? ${forUpdate}`, [id]);
  if (!person) throw new OpError(`${type} not found.`, 404, 'NOT_FOUND');

  const blockers = [];
  const hold = await openHold(executor, type, id, { lock });

  // 1. Payroll batches that contain this person.
  const p = def.payroll;
  const [batches] = await executor.execute(
    `SELECT b.${p.batchPk} AS batch_id, b.status, b.is_finalized,
            DATE_FORMAT(b.start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(b.end_date, '%Y-%m-%d') AS end_date
     FROM ${p.batchTable} b
     WHERE b.${p.batchPk} IN (SELECT l.${p.batchPk} FROM ${p.lineTable} l WHERE l.${def.pk} = ?)
     ORDER BY b.${p.batchPk}
     ${forUpdate}`, [id]);
  for (const b of batches) {
    const period = `${b.start_date} → ${b.end_date}`;
    if (b.status === 'Paid') {
      blockers.push({
        code: 'PAID_PAYROLL', batch_id: b.batch_id, action: null,
        message: `Batch #${b.batch_id} (${period}) is PAID and includes this person. ` +
          'Paid payroll is a financial record: this person cannot be deleted. Deactivate / terminate instead.',
      });
    } else if (b.status === 'Generated' && !Number(b.is_finalized)) {
      blockers.push({
        code: 'VOID_REQUIRED', batch_id: b.batch_id, action: 'void',
        message: `Batch #${b.batch_id} (${period}) is not finalized. Void it first (with a reason), then delete, then generate the period again.`,
      });
    } else if (b.status === 'Generated') {
      blockers.push({
        code: 'SUPERSEDE_REQUIRED', batch_id: b.batch_id, action: hold ? 'supersede' : 'hold',
        message: hold
          ? `Batch #${b.batch_id} (${period}) is finalized. The person is on hold: supersede (correct) the batch now; the new version is generated without this person. Then delete.`
          : `Batch #${b.batch_id} (${period}) is finalized. Step 1: put this person on hold (excluded from new payroll). Step 2: supersede (correct) the batch. Step 3: delete.`,
      });
    }
    // Voided / Superseded: history only, the lines go to the bin.
  }

  // 1b. Payroll adjustments still to be paid / deducted (money owed).
  {
    const adjTables = await existingTables(executor, ['payroll_adjustments']);
    if (adjTables.has('payroll_adjustments')) {
      const [[pa]] = await executor.execute(
        `SELECT COUNT(*) AS c FROM payroll_adjustments
         WHERE person_type = ? AND person_id = ? AND status IN ('AwaitingConfirmation','Pending','Included','Applied')`, [type, id]);
      if (Number(pa.c) > 0) {
        blockers.push({ code: 'PAYROLL_ADJUSTMENTS', action: null,
          message: `This person has ${pa.c} payroll adjustment(s) not cancelled (money owed or paid). Cancel the pending ones in Payroll adjustments first; paid ones keep the person.` });
      }
    }
  }

  // 2. Biometric data (not in use yet; handled when biometric goes live).
  const tables = await existingTables(executor, [...def.tables.map((t) => t.table), 'attendance_device_users', 'attendance_punch_processing']);
  if (type === 'Staff') {
    if (tables.has('attendance_device_users')) {
      const [[m]] = await executor.execute('SELECT COUNT(*) AS c FROM attendance_device_users WHERE staff_id = ?', [id]);
      if (Number(m.c) > 0) {
        blockers.push({ code: 'BIOMETRIC_DATA', action: null,
          message: `This person has ${m.c} biometric device mapping(s). Deleting people with biometric data is not supported yet.` });
      }
    }
    if (tables.has('attendance_punch_processing')) {
      const [[pp]] = await executor.execute(
        `SELECT COUNT(*) AS c FROM attendance_punch_processing
         WHERE target_table = 'staff_attendance'
           AND target_record_id IN (SELECT staff_attendance_id FROM staff_attendance WHERE staff_id = ?)`, [id]);
      if (Number(pp.c) > 0) {
        blockers.push({ code: 'BIOMETRIC_DATA', action: null,
          message: `This person has ${pp.c} processed biometric punch(es). Deleting people with biometric data is not supported yet.` });
      }
    }
  }

  // 3. Safety net: any other table with a foreign key to one of this person's
  //    tables that still holds rows for this person.
  const owned = new Set(def.tables.map((t) => t.table));
  const [fks] = await executor.query(
    `SELECT TABLE_NAME AS child, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS parent, REFERENCED_COLUMN_NAME AS parent_col
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?)`, [[...owned]]);
  for (const fk of fks) {
    if (owned.has(fk.child)) continue;
    if (fk.child === 'attendance_device_users') continue; // reported above as BIOMETRIC_DATA
    const parentDef = def.tables.find((t) => t.table === fk.parent);
    const [[c]] = await executor.query(
      `SELECT COUNT(*) AS c FROM \`${fk.child}\`
       WHERE \`${fk.col}\` IN (SELECT \`${fk.parent_col}\` FROM \`${fk.parent}\` WHERE ${parentDef.where})`, [id]);
    if (Number(c.c) > 0) {
      blockers.push({ code: 'UNHANDLED_DEPENDENCY', action: null,
        message: `Table ${fk.child} still references this person (${c.c} row(s)). Delete is refused until that table is handled.` });
    }
  }

  // 4. What would go to the bin.
  const counts = {};
  for (const t of def.tables) {
    if (!tables.has(t.table)) continue;
    const [[c]] = await executor.execute(`SELECT COUNT(*) AS c FROM ${t.table} WHERE ${t.where}`, [id]);
    counts[t.table] = Number(c.c);
  }

  return {
    entity_type: type,
    entity_id: id,
    code: person.code,
    name: person.name,
    status: person.status,
    can_delete: blockers.length === 0,
    blockers,
    hold,
    batches,
    row_counts: counts,
    retention_days: await retentionDays(executor),
  };
}

// ---------------------------------------------------------------------------
// Delete -> recycle bin
// ---------------------------------------------------------------------------
async function deleteToBin(type, rawId, { reason, confirmName, userId }) {
  const def = entityDef(type);
  const id = positiveId(rawId);
  const why = requireText(reason, 'A reason');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const check = await deletionCheck(connection, type, id, { lock: true });
    if (String(confirmName ?? '').trim() !== String(check.name).trim()) {
      throw new OpError('Type the exact full name to confirm the delete.', 400, 'CONFIRM_NAME_MISMATCH');
    }
    if (!check.can_delete) {
      throw new OpError('This person cannot be deleted yet. Resolve the listed items first.', 409, 'DELETE_BLOCKED',
        { blockers: check.blockers });
    }

    const tables = await existingTables(connection, def.tables.map((t) => t.table));
    const payload = {};
    for (const t of def.tables) {
      if (!tables.has(t.table)) continue;
      const [rows] = await connection.execute(`SELECT * FROM ${t.table} WHERE ${t.where} ORDER BY ${t.pk} FOR UPDATE`, [id]);
      payload[t.table] = rows;
    }

    const days = check.retention_days;
    const hold = check.hold;
    const [ins] = await connection.execute(
      `INSERT INTO recycle_bin
         (entity_type, entity_id, entity_code, entity_name, payload, row_counts, reason,
          deleted_by_user_id, deleted_at, purge_after, excluded_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW() + INTERVAL ? DAY, COALESCE(?, NOW()))`,
      [type, id, check.code, check.name, JSON.stringify(payload), JSON.stringify(check.row_counts), why,
        userId, days, hold ? hold.created_at : null]
    );
    const recycleId = ins.insertId;

    for (const t of def.tables) {
      if (!tables.has(t.table)) continue;
      const [del] = await connection.execute(`DELETE FROM ${t.table} WHERE ${t.where}`, [id]);
      if (del.affectedRows !== payload[t.table].length) {
        throw new OpError(`Unexpected row count while deleting from ${t.table}. Nothing was deleted.`, 409, 'CONCURRENT_CHANGE');
      }
    }

    if (hold) {
      await connection.execute(
        `UPDATE entity_deletion_holds SET released_at = NOW(), released_by_user_id = ?, release_reason = ?
         WHERE hold_id = ?`, [userId, `Deleted to recycle bin #${recycleId}`, hold.hold_id]);
    }

    await auditLog(connection, def.root, id, 'DELETED_TO_RECYCLE_BIN', userId,
      { code: check.code, row_counts: check.row_counts },
      { recycle_id: recycleId, retention_days: days, reason: why });

    const [[rb]] = await connection.execute(
      "SELECT DATE_FORMAT(purge_after, '%Y-%m-%d %H:%i:%s') AS purge_after FROM recycle_bin WHERE recycle_id = ?", [recycleId]);
    await connection.commit();
    return { recycle_id: recycleId, purge_after: rb.purge_after, row_counts: check.row_counts };
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    connection.release();
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------
async function restorableColumns(executor, table) {
  const [cols] = await executor.execute(
    `SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, EXTRA AS extra, DATA_TYPE AS type
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`, [table]);
  // Skip computed columns only (VIRTUAL / STORED GENERATED). 'DEFAULT_GENERATED'
  // (e.g. created_at DEFAULT CURRENT_TIMESTAMP) is a normal column and must be
  // restored with its original value.
  return cols.filter((c) => !/\b(VIRTUAL|STORED) GENERATED\b/i.test(c.extra || ''));
}

async function restoreFromBin(rawRecycleId, { reason, userId }) {
  const recycleId = positiveId(rawRecycleId);
  const why = requireText(reason, 'A reason');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [[rb]] = await connection.execute(
      `SELECT recycle_id, entity_type, entity_id, entity_code, entity_name, payload, status,
              DATE_FORMAT(excluded_since, '%Y-%m-%d %H:%i:%s') AS excluded_since
       FROM recycle_bin WHERE recycle_id = ? FOR UPDATE`, [recycleId]);
    if (!rb) throw new OpError('Recycle bin entry not found (it may have been purged).', 404, 'NOT_FOUND');
    if (rb.status !== 'Deleted') throw new OpError(`This entry is already ${rb.status}.`, 409, 'ALREADY_RESTORED');
    const def = entityDef(rb.entity_type);
    const payload = typeof rb.payload === 'string' ? JSON.parse(rb.payload) : rb.payload;
    const rootRows = payload[def.root] || [];
    if (rootRows.length !== 1) throw new OpError('The archived data is incomplete; it cannot be restored.', 409, 'PAYLOAD_INVALID');
    const person = rootRows[0];

    // Identity must still be free.
    const [[taken]] = await connection.execute(
      `SELECT ${def.pk} AS id FROM ${def.root} WHERE ${def.pk} = ? OR ${def.codeColumn} = ? LIMIT 1`,
      [rb.entity_id, rb.entity_code]);
    if (taken) throw new OpError(`The id or code ${rb.entity_code} is used again by another record.`, 409, 'IDENTITY_TAKEN');

    // Payroll generated after the person was excluded must not cover his
    // employment, otherwise he would come back into a period paid without him.
    const p = def.payroll;
    const empFrom = String(person.first_hire_date || person.hire_date || '1900-01-01').slice(0, 10);
    const empTo = person.termination_date ? String(person.termination_date).slice(0, 10) : '9999-12-31';
    const [later] = await connection.execute(
      `SELECT ${p.batchPk} AS batch_id, status, is_finalized,
              DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
       FROM ${p.batchTable}
       WHERE status IN ('Generated','Paid') AND generated_at >= ?
         AND start_date <= ? AND end_date >= ?
       ORDER BY ${p.batchPk} FOR UPDATE`, [rb.excluded_since, empTo, empFrom]);
    const blockers = later.map((b) => {
      const period = `${b.start_date} → ${b.end_date}`;
      if (b.status === 'Paid' || Number(b.is_finalized)) {
        return { code: 'RESTORE_PERIOD_LOCKED', batch_id: b.batch_id, action: b.status === 'Paid' ? null : 'supersede',
          message: `Batch #${b.batch_id} (${period}) was generated without this person and is ${b.status === 'Paid' ? 'PAID' : 'finalized'}.` +
            (b.status === 'Paid' ? ' Restoring would put him in a paid period without pay.' : ' Supersede it after restoring, or restore later.') };
      }
      return { code: 'VOID_REQUIRED', batch_id: b.batch_id, action: 'void',
        message: `Batch #${b.batch_id} (${period}) was generated without this person. Void it, restore, then generate the period again.` };
    });
    // A finalized (unpaid) batch can be corrected AFTER the restore with Supersede,
    // so it does not block; only Paid and non-finalized Generated batches block.
    const hard = blockers.filter((b) => b.code === 'VOID_REQUIRED' || (b.code === 'RESTORE_PERIOD_LOCKED' && b.action === null));
    if (hard.length) {
      throw new OpError('This person cannot be restored yet. Resolve the listed items first.', 409, 'RESTORE_BLOCKED', { blockers: hard });
    }

    // Re-insert, parents first, with the original ids.
    const order = [...def.tables].reverse();
    const counts = {};
    for (const t of order) {
      const rows = payload[t.table];
      if (!rows || rows.length === 0) continue;
      const cols = await restorableColumns(connection, t.table);
      if (cols.length === 0) throw new OpError(`Table ${t.table} no longer exists; restore is not possible.`, 409, 'SCHEMA_CHANGED');
      const present = new Set(Object.keys(rows[0]));
      const missingRequired = cols.filter((c) => !present.has(c.name) && c.nullable === 'NO' && c.def === null && !/auto_increment/i.test(c.extra));
      if (missingRequired.length) {
        throw new OpError(`Table ${t.table} has new required column(s) (${missingRequired.map((c) => c.name).join(', ')}); restore is not possible automatically.`, 409, 'SCHEMA_CHANGED');
      }
      const use = cols.filter((c) => present.has(c.name));
      const sql = `INSERT INTO ${t.table} (${use.map((c) => `\`${c.name}\``).join(', ')}) VALUES (${use.map(() => '?').join(', ')})`;
      for (const row of rows) {
        const values = use.map((c) => {
          const v = row[c.name];
          if (v === undefined) return null;
          if (c.type === 'json' && v !== null) return JSON.stringify(v);
          return v;
        });
        await connection.execute(sql, values);
      }
      counts[t.table] = rows.length;
    }

    await connection.execute(
      `UPDATE recycle_bin SET status = 'Restored', restored_by_user_id = ?, restored_at = NOW(), restore_reason = ?,
              payload = JSON_OBJECT()
       WHERE recycle_id = ?`, [userId, why, recycleId]);
    await auditLog(connection, def.root, rb.entity_id, 'RESTORED_FROM_RECYCLE_BIN', userId,
      { recycle_id: recycleId }, { code: rb.entity_code, row_counts: counts, reason: why });
    await connection.commit();
    return {
      entity_type: rb.entity_type, entity_id: rb.entity_id, row_counts: counts,
      // Finalized batches generated without him: correct them with Supersede.
      warnings: blockers.filter((b) => !hard.includes(b)),
    };
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    connection.release();
  }
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------
async function purgeEntry(executor, entry, userId, why) {
  await executor.execute('DELETE FROM recycle_bin WHERE recycle_id = ?', [entry.recycle_id]);
  // Minimal trace: ids only, no name and no data.
  await auditLog(executor, ENTITIES[entry.entity_type]?.root || 'recycle_bin', entry.entity_id, 'PURGED_FROM_RECYCLE_BIN', userId,
    { recycle_id: entry.recycle_id }, { reason: why });
}

async function purgeNow(rawRecycleId, { reason, userId }) {
  const recycleId = positiveId(rawRecycleId);
  const why = requireText(reason, 'A reason');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [[rb]] = await connection.execute(
      'SELECT recycle_id, entity_type, entity_id, status FROM recycle_bin WHERE recycle_id = ? FOR UPDATE', [recycleId]);
    if (!rb) throw new OpError('Recycle bin entry not found.', 404, 'NOT_FOUND');
    if (rb.status !== 'Deleted') throw new OpError(`This entry is ${rb.status}; only deleted entries can be purged.`, 409, 'NOT_DELETED');
    await purgeEntry(connection, rb, userId, why);
    await connection.commit();
    return { recycle_id: recycleId };
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    connection.release();
  }
}

// Removes every entry whose undo window has ended. Safe to run often and from
// several processes (named lock; each entry in its own short transaction).
async function purgeExpired() {
  const connection = await db.getConnection();
  let purged = 0;
  try {
    const [[lock]] = await connection.query("SELECT GET_LOCK('tf_recycle_bin_purge', 0) AS got");
    if (!Number(lock.got)) return 0;
    try {
      const [due] = await connection.execute(
        "SELECT recycle_id FROM recycle_bin WHERE status = 'Deleted' AND purge_after <= NOW() ORDER BY recycle_id LIMIT 500");
      for (const { recycle_id: rid } of due) {
        await connection.beginTransaction();
        try {
          const [[rb]] = await connection.execute(
            "SELECT recycle_id, entity_type, entity_id, status FROM recycle_bin WHERE recycle_id = ? AND status = 'Deleted' AND purge_after <= NOW() FOR UPDATE", [rid]);
          if (rb) { await purgeEntry(connection, rb, null, 'Retention period ended'); purged += 1; }
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          console.error('recycle bin purge failed for entry', rid, error.message);
        }
      }
    } finally {
      await connection.query("SELECT RELEASE_LOCK('tf_recycle_bin_purge')");
    }
    return purged;
  } finally {
    connection.release();
  }
}

// ---------------------------------------------------------------------------
// Hold (pending deletion)
// ---------------------------------------------------------------------------
async function createHold(type, rawId, { reason, userId }) {
  const def = entityDef(type);
  const id = positiveId(rawId);
  const why = requireText(reason, 'A reason');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [[person]] = await connection.execute(`SELECT ${def.pk} AS id FROM ${def.root} WHERE ${def.pk} = ? FOR UPDATE`, [id]);
    if (!person) throw new OpError(`${type} not found.`, 404, 'NOT_FOUND');
    if (await openHold(connection, type, id, { lock: true })) throw new OpError('This person is already on hold.', 409, 'ALREADY_ON_HOLD');
    const [ins] = await connection.execute(
      `INSERT INTO entity_deletion_holds (entity_type, entity_id, reason, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, NOW())`, [type, id, why, userId]);
    await auditLog(connection, def.root, id, 'DELETION_HOLD_CREATED', userId, null, { hold_id: ins.insertId, reason: why });
    await connection.commit();
    return { hold_id: ins.insertId };
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function releaseHold(type, rawId, { reason, userId }) {
  const def = entityDef(type);
  const id = positiveId(rawId);
  const why = requireText(reason, 'A reason');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const hold = await openHold(connection, type, id, { lock: true });
    if (!hold) throw new OpError('This person is not on hold.', 404, 'NO_HOLD');
    await connection.execute(
      `UPDATE entity_deletion_holds SET released_at = NOW(), released_by_user_id = ?, release_reason = ? WHERE hold_id = ?`,
      [userId, why, hold.hold_id]);
    await auditLog(connection, def.root, id, 'DELETION_HOLD_RELEASED', userId, { hold_id: hold.hold_id }, { reason: why });
    await connection.commit();
    return { hold_id: hold.hold_id };
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    connection.release();
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------
async function listBin({ status = 'Deleted' } = {}) {
  const st = ['Deleted', 'Restored'].includes(status) ? status : 'Deleted';
  const [rows] = await db.execute(
    `SELECT rb.recycle_id, rb.entity_type, rb.entity_id, rb.entity_code, rb.entity_name, rb.row_counts, rb.reason, rb.status,
            DATE_FORMAT(rb.deleted_at, '%Y-%m-%d %H:%i:%s') AS deleted_at,
            DATE_FORMAT(rb.purge_after, '%Y-%m-%d %H:%i:%s') AS purge_after,
            GREATEST(0, TIMESTAMPDIFF(DAY, NOW(), rb.purge_after)) AS days_left,
            du.full_name AS deleted_by,
            DATE_FORMAT(rb.restored_at, '%Y-%m-%d %H:%i:%s') AS restored_at, ru.full_name AS restored_by, rb.restore_reason
     FROM recycle_bin rb
     JOIN users du ON du.user_id = rb.deleted_by_user_id
     LEFT JOIN users ru ON ru.user_id = rb.restored_by_user_id
     WHERE rb.status = ?
     ORDER BY rb.recycle_id DESC
     LIMIT 500`, [st]);
  return rows;
}

async function assertRecycleBinSchema(executor = db) {
  const tables = await existingTables(executor, ['recycle_bin', 'entity_deletion_holds']);
  if (!tables.has('recycle_bin') || !tables.has('entity_deletion_holds')) {
    throw new Error('Recycle bin tables are missing. Run migrations/2026_10_recycle_bin/01_ddl.sql before starting this version.');
  }
}

function sendServiceError(res, error, fallback) {
  if (error && error.isOperational) {
    return res.status(error.statusCode || 400).json({
      status: 'error', ...(error.code ? { code: error.code } : {}), message: error.message, ...(error.extra || {}),
    });
  }
  console.error(fallback, error);
  return res.status(500).json({ status: 'error', message: fallback });
}

module.exports = {
  ENTITIES, OpError,
  deletionCheck, deleteToBin, restoreFromBin, purgeNow, purgeExpired,
  createHold, releaseHold, listBin, assertRecycleBinSchema, sendServiceError,
};
