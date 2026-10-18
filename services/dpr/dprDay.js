// services/dpr/dprDay.js
//
// The daily work of the report: the day's fields (autosave with a version),
// typed counts, activities + allocations, QA / QC, photos, manual values over
// system values (with revert and history), copy from another contract, and the
// NCR / concerns registers. Writes ONLY to dpr_* tables; every change is logged
// in dpr_change_log (old value, new value, who, when).
'use strict';

const pool = require('../../config/db');
const C = require('./dprCommon');
const M = require('./dprModel');
const S = require('./dprSources');
const Setup = require('./dprSetup');
const MV = require('./dprManual');
const U = require('./dprUcc');
const UL = require('./dprUccLayout');

const { DprError } = C;

// ------------------------------------------------------------------ day fields
function cleanDayFields(b) {
  const f = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (has('weather_am')) f.weather_am = C.line(b.weather_am, 40, { label: 'Weather (morning)' });
  if (has('weather_pm')) f.weather_pm = C.line(b.weather_pm, 40, { label: 'Weather (afternoon)' });
  const decs = { temp_max: ['Max °C', -60, 70, 1], temp_min: ['Min °C', -60, 70, 1], humidity: ['Humidity %', 0, 100, 1], wind: ['Wind km/h', 0, 500, 1], hours_lost: ['Hours lost', 0, 24, 2] };
  for (const [k, [label, min, max, places]] of Object.entries(decs)) {
    if (has(k)) f[k] = C.decimal(b[k], { label, min, max, places });
  }
  if (has('weather_remarks')) f.weather_remarks = C.line(b.weather_remarks, 500, { label: 'Weather remarks' });
  if (has('tbt_topic')) f.tbt_topic = C.line(b.tbt_topic, 300, { label: 'Toolbox talk topic' });
  const ints = { tbt_attendees: 'Toolbox talk attendees', hse_inspections: 'HSE inspections', incidents: 'Incidents', near_misses: 'Near misses', first_aid: 'First aid cases', lti: 'LTI', ptws: 'PTWs issued' };
  for (const [k, label] of Object.entries(ints)) if (has(k)) f[k] = C.integer(b[k], { label, min: 0, max: 100000 });
  if (has('hse_observations')) f.hse_observations = C.text(b.hse_observations, 4000, { label: 'HSE observations' });
  if (has('next_day_plan')) f.next_day_plan = C.text(b.next_day_plan, 4000, { label: 'Planned activities' });
  if (has('remarks')) f.remarks = C.text(b.remarks, 4000, { label: 'General remarks' });
  if (has('sections')) f.sections = b.sections === null ? null : JSON.stringify(C.sectionFlags(b.sections));
  // v2 (client's form)
  if (has('weather_condition')) f.weather_condition = C.line(b.weather_condition, 40, { label: 'Weather' });
  if (has('humidity_level')) f.humidity_level = C.line(b.humidity_level, 20, { label: 'Humidity' });
  if (has('layout')) f.layout = b.layout === null ? null : JSON.stringify(UL.clean(b.layout));
  return f;
}

async function ensureDay(conn, contractId, date, userId) {
  await conn.query(
    `INSERT IGNORE INTO dpr_days (contract_id, report_date, updated_by_user_id) VALUES (?, ?, ?)`, [contractId, date, userId]);
  const [[row]] = await conn.query('SELECT * FROM dpr_days WHERE contract_id = ? AND report_date = ? FOR UPDATE', [contractId, date]);
  return row;
}

/**
 * Autosave. `version` = the version the screen started from; a different version on the
 * server means someone else saved in between -> 409 with the server copy (nothing lost).
 */
async function patchDay(contractId, date, body, userId) {
  const b = body || {};
  const f = cleanDayFields(b.fields || {});
  const c = await M.contractForDays(contractId);
  M.checkDate(c, date);
  return C.inTransaction(async (conn) => {
    const [[existed]] = await conn.query('SELECT version FROM dpr_days WHERE contract_id = ? AND report_date = ? FOR UPDATE', [contractId, date]);
    const before = await ensureDay(conn, contractId, date, userId);
    const expected = b.version === undefined || b.version === null ? null : Number(b.version);
    // version 0 = the screen opened a day that did not exist yet
    const serverVersion = existed ? Number(existed.version) : 0;
    if (expected !== null && serverVersion !== expected) {
      throw new DprError('This day was changed by someone else. The latest version is loaded; check your last change.', 409,
        { version: serverVersion, day: M.dayOut(before) });
    }
    const cols = Object.keys(f);
    if (!cols.length) return { version: Number(before.version), saved: 0 };
    await conn.query(
      `UPDATE dpr_days SET ${cols.map((k) => `${k} = ?`).join(', ')}, version = version + 1, updated_by_user_id = ?
        WHERE contract_id = ? AND report_date = ?`, [...cols.map((k) => f[k]), userId, contractId, date]);
    const [[after]] = await conn.query('SELECT * FROM dpr_days WHERE contract_id = ? AND report_date = ?', [contractId, date]);
    const norm = (r) => ({ ...r, sections: r.sections === null ? null : JSON.stringify(C.json(r.sections)),
      layout: r.layout === null || r.layout === undefined ? null : JSON.stringify(C.json(r.layout)),
      ...Object.fromEntries(['temp_max', 'temp_min', 'humidity', 'wind', 'hours_lost'].map((k) => [k, r[k] === null ? null : String(Number(r[k]))])) });
    await C.logRowChanges(conn, { contractId, date, entity: 'day', entityId: date, userId }, norm(before), norm(after), cols);
    // the same fields in other contracts of the same day (the QC ticked them)
    const applied = [];
    for (const other of C.ids(b.apply_to).filter((x) => x !== contractId)) {
      const dataCols = cols.filter((k) => k !== 'layout' && k !== 'sections');
      if (!dataCols.length) break;
      const [[oc]] = await conn.query('SELECT contract_id, code, commencement_date FROM dpr_contracts WHERE contract_id = ?', [other]);
      if (!oc) throw new DprError('A contract to apply to does not exist.');
      const ob = await ensureDay(conn, other, date, userId);
      await conn.query(
        `UPDATE dpr_days SET ${dataCols.map((k) => `${k} = ?`).join(', ')}, version = version + 1, updated_by_user_id = ?
          WHERE contract_id = ? AND report_date = ?`, [...dataCols.map((k) => f[k]), userId, other, date]);
      const [[oa]] = await conn.query('SELECT * FROM dpr_days WHERE contract_id = ? AND report_date = ?', [other, date]);
      await C.logRowChanges(conn, { contractId: other, date, entity: 'day', entityId: date, userId }, norm(ob), norm(oa), dataCols);
      applied.push(oc.code);
    }
    return { version: Number(after.version), saved: cols.length, applied_to: applied };
  });
}

// ------------------------------------------------------------------ typed counts (lines without a source)
async function setCount(contractId, date, lineId, value, userId) {
  const v = C.integer(value, { label: 'Count', min: 0, max: 100000, required: true });
  const c = await M.contractForDays(contractId);
  M.checkDate(c, date);
  return C.inTransaction(async (conn) => {
    const [[l]] = await conn.query('SELECT * FROM dpr_lines WHERE line_id = ? AND contract_id = ? AND is_active = 1', [lineId, contractId]);
    if (!l) throw new DprError('Line not found.', 404);
    if (S.hasSource(S.cleanMap(l.source_map))) {
      throw new DprError('This figure comes from the system. Use "Change value" (with a reason) to replace it for this day.', 409);
    }
    const [[before]] = await conn.query('SELECT count_value FROM dpr_day_counts WHERE contract_id = ? AND report_date = ? AND line_id = ?', [contractId, date, lineId]);
    await conn.query(
      `INSERT INTO dpr_day_counts (contract_id, report_date, line_id, count_value, updated_by_user_id) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE count_value = VALUES(count_value), updated_by_user_id = VALUES(updated_by_user_id)`,
      [contractId, date, lineId, v, userId]);
    await C.logChange(conn, { contractId, date, entity: 'count', entityId: lineId, field: 'count_value',
      oldValue: before ? String(before.count_value) : '0', newValue: String(v), userId });
    return { line_id: lineId, value: v };
  });
}

// ------------------------------------------------------------------ manual value over a system value
async function setOverride(contractId, date, lineId, body, userId) {
  const b = body || {};
  const v = C.integer(b.value, { label: 'Value', min: 0, max: 100000, required: true });
  const reason = C.line(b.reason, 500, { required: true, label: 'Reason' });
  if (reason.length < 3) throw new DprError('Write the reason of the change (at least 3 characters).');
  const { model, L } = await M.buildDay(contractId, date);
  const src = L.eff.sources[lineId];
  if (!src) throw new DprError('Line not found.', 404);
  if (src.mode === 'manual') throw new DprError('This line has no system figure: type its count directly.', 409);
  const lineRow = [...model.manpower.trades, ...model.manpower.plant, ...model.subcontractors.lines].find((r) => r.line_id === lineId);
  const label = lineRow ? (lineRow.subcontractor ? `${lineRow.subcontractor} – ${lineRow.name}` : lineRow.name) : `line ${lineId}`;
  return C.inTransaction(async (conn) => {
    const key = `line:${lineId}`;
    await conn.query(
      `UPDATE dpr_overrides SET reverted_at = CURRENT_TIMESTAMP, reverted_by_user_id = ?
        WHERE contract_id = ? AND report_date = ? AND field_key = ? AND reverted_at IS NULL`, [userId, contractId, date, key]);
    const [ins] = await conn.query(
      `INSERT INTO dpr_overrides (contract_id, report_date, field_key, field_label, system_value, manual_value, reason, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [contractId, date, key, `Today – ${label}`, src.system_value === null ? null : String(src.system_value), String(v), reason, userId]);
    await C.logChange(conn, { contractId, date, entity: 'override', entityId: key, field: 'value',
      oldValue: src.override ? String(src.override.value) : (src.system_value === null ? null : String(src.system_value)), newValue: String(v), userId });
    return { override_id: ins.insertId, line_id: lineId, value: v, system_value: src.system_value };
  });
}

async function revertOverride(contractId, date, lineId, userId) {
  const key = `line:${lineId}`;
  return C.inTransaction(async (conn) => {
    const [[cur]] = await conn.query(
      `SELECT * FROM dpr_overrides WHERE contract_id = ? AND report_date = ? AND field_key = ? AND reverted_at IS NULL
        ORDER BY override_id DESC LIMIT 1`, [contractId, date, key]);
    if (!cur) throw new DprError('There is no manual value to remove: the system value is already used.', 404);
    await conn.query(
      `UPDATE dpr_overrides SET reverted_at = CURRENT_TIMESTAMP, reverted_by_user_id = ?
        WHERE contract_id = ? AND report_date = ? AND field_key = ? AND reverted_at IS NULL`, [userId, contractId, date, key]);
    await C.logChange(conn, { contractId, date, entity: 'override', entityId: key, field: 'value', oldValue: cur.manual_value, newValue: 'system', userId });
    return { line_id: lineId, reverted: true };
  });
}

async function overrideHistory(contractId, date, lineId) {
  const [rows] = await pool.query(
    `SELECT o.override_id, o.system_value, o.manual_value, o.reason,
            DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i') AS created_at, u.full_name AS created_by,
            DATE_FORMAT(o.reverted_at, '%Y-%m-%d %H:%i') AS reverted_at, r.full_name AS reverted_by
       FROM dpr_overrides o
       LEFT JOIN users u ON u.user_id = o.created_by_user_id
       LEFT JOIN users r ON r.user_id = o.reverted_by_user_id
      WHERE o.contract_id = ? AND o.report_date = ? AND o.field_key = ?
      ORDER BY o.override_id DESC`, [contractId, date, `line:${lineId}`]);
  return rows.map((r) => ({
    override_id: Number(r.override_id), system_value: r.system_value === null ? null : Number(r.system_value),
    value: Number(r.manual_value), reason: r.reason, created_at: r.created_at, created_by: r.created_by || '',
    reverted_at: r.reverted_at, reverted_by: r.reverted_by || '', active: !r.reverted_at,
  }));
}

// ------------------------------------------------------------------ change history (any field)
async function history(contractId, { date = null, entity = null, entityId = null, field = null, limit = 200 } = {}) {
  const where = ['l.contract_id = ?'];
  const args = [contractId];
  if (date) { where.push('l.report_date = ?'); args.push(date); }
  if (entity) { where.push('l.entity = ?'); args.push(entity); }
  if (entityId !== null && entityId !== undefined && entityId !== '') { where.push('l.entity_id = ?'); args.push(String(entityId)); }
  if (field) { where.push('l.field = ?'); args.push(field); }
  const [rows] = await pool.query(
    `SELECT l.change_id, DATE_FORMAT(l.report_date, '%Y-%m-%d') AS report_date, l.entity, l.entity_id, l.field,
            l.old_value, l.new_value, DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at, u.full_name AS user_name
       FROM dpr_change_log l LEFT JOIN users u ON u.user_id = l.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.change_id DESC LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`, args);
  return rows.map((r) => ({ ...r, change_id: Number(r.change_id), user_name: r.user_name || '' }));
}

// ------------------------------------------------------------------ activities
// v2: an activity has a BOQ item OR a free description; it may belong to an area
// (bridge...) with a chainage, and have crews (plant / trades, No., working hours).
async function activityFields(conn, contractId, b) {
  const hasBoq = !(b.boq_id === null || b.boq_id === undefined || b.boq_id === '');
  let boqId = null;
  if (hasBoq) {
    boqId = C.id(b.boq_id, 'BOQ item');
    const [[boq]] = await conn.query("SELECT boq_id, row_type FROM dpr_boq WHERE boq_id = ? AND contract_id = ?", [boqId, contractId]);
    if (!boq) throw new DprError('Choose a BOQ item of this contract.');
    if (boq.row_type && boq.row_type !== 'item') throw new DprError('Choose a BOQ item (not a heading or a text row).');
  }
  const description = C.line(b.description, 500, { label: 'Description' });
  if (!hasBoq && !description) throw new DprError('Choose the BOQ item or write the activity.');
  let areaId = null;
  if (!(b.area_id === null || b.area_id === undefined || b.area_id === '')) {
    areaId = C.id(b.area_id, 'area');
    const [[ar]] = await conn.query('SELECT area_id FROM dpr_areas WHERE area_id = ? AND contract_id = ?', [areaId, contractId]);
    if (!ar) throw new DprError('Choose an area of this contract.');
  }
  const qty = C.decimal(b.qty, { label: 'Qty today', min: 0, max: 99999999999999, places: 4, required: hasBoq && b.require_qty !== false });
  return {
    boq_id: boqId,
    description,
    location: C.line(b.location, 300, { label: 'Location' }),
    qty: qty === null ? '0' : qty,
    unit: C.line(b.unit, 30, { label: 'Unit' }),
    area_id: areaId,
    chainage: C.line(b.chainage, 100, { label: 'Chainage' }),
    remarks: C.line(b.remarks, 500, { label: 'Remarks' }),
  };
}
const ACT_FIELDS = ['boq_id', 'description', 'location', 'qty', 'unit', 'area_id', 'chainage', 'remarks'];

async function writeAlloc(conn, contractId, activityId, alloc) {
  if (alloc === undefined) return null;
  const clean = {};
  if (alloc && typeof alloc === 'object') {
    const [lines] = await conn.query('SELECT line_id FROM dpr_lines WHERE contract_id = ? AND is_active = 1', [contractId]);
    const known = new Set(lines.map((l) => Number(l.line_id)));
    for (const [k, v] of Object.entries(alloc)) {
      const lid = Number(k);
      if (!known.has(lid)) throw new DprError('Unknown resource line in the allocation.');
      const n = C.integer(v, { label: 'Allocated', min: 0, max: 100000 }) || 0;
      if (n) clean[lid] = n;
    }
  }
  await conn.query('DELETE FROM dpr_activity_alloc WHERE activity_id = ?', [activityId]);
  for (const [lid, n] of Object.entries(clean)) {
    await conn.query('INSERT INTO dpr_activity_alloc (activity_id, line_id, count_value) VALUES (?, ?, ?)', [activityId, Number(lid), n]);
  }
  return clean;
}

/** Crews of an activity: [{ kind: plant|trade, name, nos, hours }] (hours empty = No. x hours / day). */
function cleanCrews(list) {
  if (!Array.isArray(list)) return null;
  if (list.length > 60) throw new DprError('Too many crew rows (max 60).');
  return list.map((x, i) => ({
    kind: C.oneOf(x && x.kind, ['plant', 'trade'], { label: 'Crew type', required: true }),
    name: C.line(x && x.name, 150, { label: 'Crew name', required: true }),
    nos: C.decimal(x && x.nos, { label: 'No.', min: 0, max: 100000, places: 2 }),
    hours: C.decimal(x && x.hours, { label: 'W-HRS', min: 0, max: 10000000, places: 2 }),
    sort_order: i + 1,
  }));
}
async function writeCrews(conn, activityId, crews) {
  if (!crews) return;
  await conn.query('DELETE FROM dpr_activity_crews WHERE activity_id = ?', [activityId]);
  for (const cr of crews) {
    await conn.query('INSERT INTO dpr_activity_crews (activity_id, kind, sort_order, name, nos, hours) VALUES (?, ?, ?, ?, ?, ?)',
      [activityId, cr.kind, cr.sort_order, cr.name, cr.nos, cr.hours]);
  }
}
async function loadCrews(conn, activityId) {
  const [rows] = await conn.query('SELECT kind, name, nos, hours FROM dpr_activity_crews WHERE activity_id = ? ORDER BY sort_order, crew_id', [activityId]);
  return rows;
}

async function loadAlloc(conn, activityId) {
  const [rows] = await conn.query('SELECT line_id, count_value FROM dpr_activity_alloc WHERE activity_id = ? ORDER BY line_id', [activityId]);
  return Object.fromEntries(rows.map((r) => [String(r.line_id), Number(r.count_value)]));
}

async function saveActivity(contractId, date, activityId, body, userId) {
  const b = body || {};
  const c = await M.contractForDays(contractId);
  M.checkDate(c, date);
  const crews = cleanCrews(b.crews);
  return C.inTransaction(async (conn) => {
    const f = await activityFields(conn, contractId, { ...b, require_qty: c.template === 'dpr' });
    if (c.template === 'dpr' && !f.boq_id) throw new DprError('Choose the BOQ item.');
    let before = null;
    let rowId = activityId;
    if (rowId) {
      [[before]] = await conn.query('SELECT * FROM dpr_activities WHERE activity_id = ? AND contract_id = ? AND report_date = ? AND is_deleted = 0', [rowId, contractId, date]);
      if (!before) throw new DprError('Activity not found.', 404);
      await conn.query(`UPDATE dpr_activities SET ${ACT_FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE activity_id = ?`, [...ACT_FIELDS.map((k) => f[k]), rowId]);
    } else {
      const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dpr_activities WHERE contract_id = ? AND report_date = ?', [contractId, date]);
      const [ins] = await conn.query(
        `INSERT INTO dpr_activities (contract_id, report_date, sort_order, ${ACT_FIELDS.join(', ')}, created_by_user_id)
         VALUES (?, ?, ?, ${ACT_FIELDS.map(() => '?').join(', ')}, ?)`, [contractId, date, Number(mx.n), ...ACT_FIELDS.map((k) => f[k]), userId]);
      rowId = ins.insertId;
    }
    const allocBefore = before ? await loadAlloc(conn, rowId) : {};
    const crewsBefore = before ? await loadCrews(conn, rowId) : [];
    await writeAlloc(conn, contractId, rowId, b.alloc);
    await writeCrews(conn, rowId, crews);
    const [[after]] = await conn.query('SELECT * FROM dpr_activities WHERE activity_id = ?', [rowId]);
    const allocAfter = await loadAlloc(conn, rowId);
    await C.logRowChanges(conn, { contractId, date, entity: 'activity', entityId: rowId, userId }, before, after, ACT_FIELDS);
    await C.logChange(conn, { contractId, date, entity: 'activity', entityId: rowId, field: 'alloc', oldValue: before ? allocBefore : null, newValue: allocAfter, userId });
    if (crews) await C.logChange(conn, { contractId, date, entity: 'activity', entityId: rowId, field: 'crews', oldValue: before ? crewsBefore : null, newValue: await loadCrews(conn, rowId), userId });
    return { activity_id: rowId };
  });
}

async function deleteActivity(contractId, date, activityId, userId) {
  return C.inTransaction(async (conn) => {
    const [r] = await conn.query('UPDATE dpr_activities SET is_deleted = 1 WHERE activity_id = ? AND contract_id = ? AND report_date = ? AND is_deleted = 0', [activityId, contractId, date]);
    if (!r.affectedRows) throw new DprError('Activity not found.', 404);
    await C.logChange(conn, { contractId, date, entity: 'activity', entityId: activityId, field: 'deleted', oldValue: '0', newValue: '1', userId });
  });
}

/** Moves the activities of the day to a new order. */
async function reorderActivities(contractId, date, orderedIds, userId) {
  const list = C.ids(orderedIds, 500);
  return C.inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT activity_id FROM dpr_activities WHERE contract_id = ? AND report_date = ? AND is_deleted = 0', [contractId, date]);
    const known = new Set(rows.map((r) => Number(r.activity_id)));
    if (list.some((x) => !known.has(x))) throw new DprError('Unknown activity in the new order.');
    let i = 1;
    for (const id of list) {
      await conn.query('UPDATE dpr_activities SET sort_order = ? WHERE activity_id = ?', [i, id]);
      i += 1;
    }
    await C.logChange(conn, { contractId, date, entity: 'activity', field: 'order', oldValue: null, newValue: list.join(','), userId });
    return { ok: true };
  });
}

async function listActivities(contractId, date) {
  const [rows] = await pool.query(
    `SELECT a.activity_id, a.sort_order, a.boq_id, b.item_no, b.description AS boq_description, b.unit AS boq_unit,
            a.description, a.location, a.qty, a.unit, a.remarks, a.area_id, a.chainage
       FROM dpr_activities a LEFT JOIN dpr_boq b ON b.boq_id = a.boq_id
      WHERE a.contract_id = ? AND a.report_date = ? AND a.is_deleted = 0 ORDER BY a.sort_order, a.activity_id`, [contractId, date]);
  const ids = rows.map((r) => Number(r.activity_id));
  const alloc = new Map();
  const crews = new Map();
  if (ids.length) {
    const [al] = await pool.query('SELECT activity_id, line_id, count_value FROM dpr_activity_alloc WHERE activity_id IN (?)', [ids]);
    for (const x of al) {
      const m = alloc.get(Number(x.activity_id)) || {};
      m[String(x.line_id)] = Number(x.count_value);
      alloc.set(Number(x.activity_id), m);
    }
    const [cr] = await pool.query('SELECT * FROM dpr_activity_crews WHERE activity_id IN (?) ORDER BY sort_order, crew_id', [ids]);
    for (const x of cr) {
      const list = crews.get(Number(x.activity_id)) || [];
      list.push({ kind: x.kind, name: x.name, nos: x.nos, hours: x.hours });
      crews.set(Number(x.activity_id), list);
    }
  }
  return rows.map((r) => ({
    activity_id: Number(r.activity_id), sort_order: Number(r.sort_order), boq_id: r.boq_id === null ? null : Number(r.boq_id), item_no: r.item_no || '',
    description: r.boq_id === null ? (r.description || '') : r.boq_description, own_description: r.description || '',
    unit: r.boq_unit || r.unit || '', own_unit: r.unit || '', location: r.location || '', qty: r.qty, remarks: r.remarks || '',
    area_id: r.area_id === null ? null : Number(r.area_id), chainage: r.chainage || '',
    alloc: alloc.get(Number(r.activity_id)) || {}, crews: crews.get(Number(r.activity_id)) || [],
  }));
}

// ------------------------------------------------------------------ QA / QC (the WIR register of the client's form)
const QA_FIELDS = ['type', 'ref_no', 'description', 'location', 'result', 'remarks', 'area_id', 'chainage', 'ms_ref'];
async function qaFields(conn, contractId, b) {
  let areaId = null;
  if (!(b.area_id === null || b.area_id === undefined || b.area_id === '')) {
    areaId = C.id(b.area_id, 'area');
    const [[ar]] = await conn.query('SELECT area_id FROM dpr_areas WHERE area_id = ? AND contract_id = ?', [areaId, contractId]);
    if (!ar) throw new DprError('Choose an area of this contract.');
  }
  return {
    type: C.line(b.type, 40, { label: 'Type' }) || 'WIR',
    ref_no: C.line(b.ref_no, 100, { label: 'Ref No.' }),
    description: C.line(b.description, 500, { label: 'Description' }),
    location: C.line(b.location, 300, { label: 'Location' }),
    result: C.line(b.result, 40, { label: 'Status' }),
    remarks: C.line(b.remarks, 500, { label: 'Comments' }),
    area_id: areaId,
    chainage: C.line(b.chainage, 100, { label: 'Chainage' }),
    ms_ref: C.line(b.ms_ref, 100, { label: 'MS Ref.' }),
  };
}
async function saveQa(contractId, date, qaId, body, userId) {
  const c = await M.contractForDays(contractId);
  M.checkDate(c, date);
  if (c.template === 'dpr' && !C.line((body || {}).type, 40)) throw new DprError('Type is required.');
  return C.inTransaction(async (conn) => {
    const f = await qaFields(conn, contractId, body || {});
    let before = null;
    let rowId = qaId;
    if (rowId) {
      [[before]] = await conn.query('SELECT * FROM dpr_qa WHERE qa_id = ? AND contract_id = ? AND report_date = ? AND is_deleted = 0', [rowId, contractId, date]);
      if (!before) throw new DprError('QA / QC entry not found.', 404);
      await conn.query(`UPDATE dpr_qa SET ${QA_FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE qa_id = ?`, [...QA_FIELDS.map((k) => f[k]), rowId]);
    } else {
      const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dpr_qa WHERE contract_id = ? AND report_date = ?', [contractId, date]);
      const [ins] = await conn.query(
        `INSERT INTO dpr_qa (contract_id, report_date, sort_order, ${QA_FIELDS.join(', ')}) VALUES (?, ?, ?, ${QA_FIELDS.map(() => '?').join(', ')})`,
        [contractId, date, Number(mx.n), ...QA_FIELDS.map((k) => f[k])]);
      rowId = ins.insertId;
    }
    const [[after]] = await conn.query('SELECT * FROM dpr_qa WHERE qa_id = ?', [rowId]);
    await C.logRowChanges(conn, { contractId, date, entity: 'qa', entityId: rowId, userId }, before, after, QA_FIELDS);
    return { qa_id: rowId };
  });
}
async function deleteQa(contractId, date, qaId, userId) {
  return C.inTransaction(async (conn) => {
    const [r] = await conn.query('UPDATE dpr_qa SET is_deleted = 1 WHERE qa_id = ? AND contract_id = ? AND report_date = ? AND is_deleted = 0', [qaId, contractId, date]);
    if (!r.affectedRows) throw new DprError('QA / QC entry not found.', 404);
    await C.logChange(conn, { contractId, date, entity: 'qa', entityId: qaId, field: 'deleted', oldValue: '0', newValue: '1', userId });
  });
}
async function listQa(contractId, date) {
  const [rows] = await pool.query(
    `SELECT qa_id, sort_order, ${QA_FIELDS.join(', ')} FROM dpr_qa WHERE contract_id = ? AND report_date = ? AND is_deleted = 0 ORDER BY sort_order, qa_id`, [contractId, date]);
  return rows.map((r) => ({ ...r, qa_id: Number(r.qa_id), sort_order: Number(r.sort_order), area_id: r.area_id === null ? null : Number(r.area_id) }));
}

// ------------------------------------------------------------------ delivered materials
const MAT_FIELDS = ['description', 'unit', 'qty', 'supplier', 'delivery_note', 'mar_ref', 'area_id', 'element', 'boq_ref', 'intended_use'];
async function materialFields(conn, contractId, b) {
  let areaId = null;
  if (!(b.area_id === null || b.area_id === undefined || b.area_id === '')) {
    areaId = C.id(b.area_id, 'area');
    const [[ar]] = await conn.query('SELECT area_id FROM dpr_areas WHERE area_id = ? AND contract_id = ?', [areaId, contractId]);
    if (!ar) throw new DprError('Choose an area of this contract.');
  }
  return {
    description: C.line(b.description, 500, { label: 'Material', required: true }),
    unit: C.line(b.unit, 30, { label: 'Unit' }),
    qty: C.decimal(b.qty, { label: 'Qty delivered', min: 0, max: 99999999999999, places: 4 }),
    supplier: C.line(b.supplier, 200, { label: 'Supplier' }),
    delivery_note: C.line(b.delivery_note, 100, { label: 'Delivery note' }),
    mar_ref: C.line(b.mar_ref, 100, { label: 'MAR Ref.' }),
    area_id: areaId,
    element: C.line(b.element, 200, { label: 'Element' }),
    boq_ref: C.line(b.boq_ref, 100, { label: 'BOQ Ref.' }),
    intended_use: C.line(b.intended_use, 300, { label: 'Intended use' }),
  };
}
async function saveMaterial(contractId, date, id, body, userId) {
  const c = await M.contractForDays(contractId);
  M.checkDate(c, date);
  return C.inTransaction(async (conn) => {
    const f = await materialFields(conn, contractId, body || {});
    let before = null;
    let rowId = id;
    if (rowId) {
      [[before]] = await conn.query('SELECT * FROM dpr_materials WHERE material_id = ? AND contract_id = ? AND report_date = ? AND is_deleted = 0', [rowId, contractId, date]);
      if (!before) throw new DprError('Material not found.', 404);
      await conn.query(`UPDATE dpr_materials SET ${MAT_FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE material_id = ?`, [...MAT_FIELDS.map((k) => f[k]), rowId]);
    } else {
      const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dpr_materials WHERE contract_id = ? AND report_date = ?', [contractId, date]);
      const [ins] = await conn.query(
        `INSERT INTO dpr_materials (contract_id, report_date, sort_order, ${MAT_FIELDS.join(', ')}) VALUES (?, ?, ?, ${MAT_FIELDS.map(() => '?').join(', ')})`,
        [contractId, date, Number(mx.n), ...MAT_FIELDS.map((k) => f[k])]);
      rowId = ins.insertId;
    }
    const [[after]] = await conn.query('SELECT * FROM dpr_materials WHERE material_id = ?', [rowId]);
    await C.logRowChanges(conn, { contractId, date, entity: 'material', entityId: rowId, userId }, before, after, MAT_FIELDS);
    return { material_id: rowId };
  });
}
async function deleteMaterial(contractId, date, id, userId) {
  return C.inTransaction(async (conn) => {
    const [r] = await conn.query('UPDATE dpr_materials SET is_deleted = 1 WHERE material_id = ? AND contract_id = ? AND report_date = ? AND is_deleted = 0', [id, contractId, date]);
    if (!r.affectedRows) throw new DprError('Material not found.', 404);
    await C.logChange(conn, { contractId, date, entity: 'material', entityId: id, field: 'deleted', oldValue: '0', newValue: '1', userId });
  });
}

// ------------------------------------------------------------------ photos
const PHOTO_FIELDS = ['slot', 'boq_activity', 'location', 'caption', 'area_id'];
function photoFields(b) {
  const area = b.area_id === null || b.area_id === undefined || b.area_id === '' ? null : C.id(b.area_id, 'area');
  return {
    slot: C.integer(b.slot, { label: 'Photo number', min: 1, max: 200 }) || 1,
    boq_activity: C.line(b.boq_activity, 300, { label: 'BOQ / Activity' }),
    location: C.line(b.location, 300, { label: 'Location' }),
    caption: C.line(b.caption, 500, { label: 'Caption' }),
    area_id: area,
  };
}
async function checkArea(conn, contractId, areaId) {
  if (areaId === null) return;
  const [[ar]] = await conn.query('SELECT area_id FROM dpr_areas WHERE area_id = ? AND contract_id = ?', [areaId, contractId]);
  if (!ar) throw new DprError('Choose an area of this contract.');
}
async function addPhoto(contractId, date, fileName, contentType, body, userId) {
  const f = photoFields(body || {});
  const c = await M.contractForDays(contractId);
  M.checkDate(c, date);
  return C.inTransaction(async (conn) => {
    if (!body || body.slot === undefined || body.slot === '') {
      const [[mx]] = await conn.query('SELECT COALESCE(MAX(slot), 0) + 1 AS n FROM dpr_photos WHERE contract_id = ? AND report_date = ? AND is_deleted = 0', [contractId, date]);
      f.slot = Number(mx.n);
    }
    await checkArea(conn, contractId, f.area_id);
    const [ins] = await conn.query(
      `INSERT INTO dpr_photos (contract_id, report_date, slot, file_name, content_type, boq_activity, location, caption, area_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [contractId, date, f.slot, fileName, contentType, f.boq_activity, f.location, f.caption, f.area_id, userId]);
    await C.logChange(conn, { contractId, date, entity: 'photo', entityId: ins.insertId, field: 'added', oldValue: null, newValue: fileName, userId });
    return { photo_id: ins.insertId, slot: f.slot };
  });
}
async function updatePhoto(contractId, date, photoId, body, userId) {
  const f = photoFields(body || {});
  return C.inTransaction(async (conn) => {
    const [[before]] = await conn.query('SELECT * FROM dpr_photos WHERE photo_id = ? AND contract_id = ? AND report_date = ? AND is_deleted = 0', [photoId, contractId, date]);
    if (!before) throw new DprError('Photo not found.', 404);
    await checkArea(conn, contractId, f.area_id);
    await conn.query(`UPDATE dpr_photos SET ${PHOTO_FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE photo_id = ?`, [...PHOTO_FIELDS.map((k) => f[k]), photoId]);
    const [[after]] = await conn.query('SELECT * FROM dpr_photos WHERE photo_id = ?', [photoId]);
    await C.logRowChanges(conn, { contractId, date, entity: 'photo', entityId: photoId, userId }, before, after, PHOTO_FIELDS);
    return { photo_id: photoId };
  });
}
async function deletePhoto(contractId, date, photoId, userId) {
  return C.inTransaction(async (conn) => {
    const [r] = await conn.query('UPDATE dpr_photos SET is_deleted = 1 WHERE photo_id = ? AND contract_id = ? AND report_date = ? AND is_deleted = 0', [photoId, contractId, date]);
    if (!r.affectedRows) throw new DprError('Photo not found.', 404);
    await C.logChange(conn, { contractId, date, entity: 'photo', entityId: photoId, field: 'deleted', oldValue: '0', newValue: '1', userId });
  });
}
/** The stored file of a photo (also of a deleted photo: issued reports may show it). */
async function photoFile(contractId, photoId) {
  const [[p]] = await pool.query('SELECT file_name, content_type FROM dpr_photos WHERE photo_id = ? AND contract_id = ?', [photoId, contractId]);
  if (!p) throw new DprError('Photo not found.', 404);
  return p;
}

// ------------------------------------------------------------------ the day bundle (screen)
async function getDayBundle(contractId, date) {
  const c0 = await M.contractForDays(contractId);
  if (c0.template !== 'dpr') return getUccBundle(contractId, date);
  const { model, L } = await M.buildDay(contractId, date);
  const [activities, qa, reports, linesAll, boq] = await Promise.all([
    listActivities(contractId, date),
    listQa(contractId, date),
    pool.query(
      `SELECT r.report_id, r.report_no, r.revision, r.status, DATE_FORMAT(r.issued_at, '%Y-%m-%d %H:%i') AS issued_at,
              DATE_FORMAT(r.issued_at, '%Y-%m-%d %H:%i:%s') AS issued_raw, u.full_name AS issued_by
         FROM dpr_reports r LEFT JOIN users u ON u.user_id = r.issued_by_user_id
        WHERE r.contract_id = ? AND r.report_date = ? ORDER BY r.revision DESC`, [contractId, date]).then(([r]) => r),
    Setup.listLines(contractId, { activeOnly: true }),
    Setup.listBoq(contractId),
  ]);
  const day = M.dayOut(L.dayRow);
  const changedSinceIssue = reports.length ? await changedAfter(contractId, date, reports[0].issued_raw) : false;
  return {
    contract: L.contract,
    date,
    day,
    version: L.dayRow ? Number(L.dayRow.version) : 0,
    last_saved: L.dayRow ? L.dayRow.updated_at : null,
    sections: model.sections,
    section_list: C.SECTIONS,
    lines: linesAll.map((l) => ({
      line_id: l.line_id, kind: l.kind, name: l.name, category: l.category, ownership: l.ownership,
      subcontractor: l.subcontractor, res_type: l.res_type, has_source: S.hasSource(l.source_map),
      source: model.manpower.trades.concat(model.manpower.plant, model.subcontractors.lines).find((r) => r.line_id === l.line_id)?.source || null,
    })),
    boq: boq.filter((b) => b.is_active).map((b) => ({ boq_id: b.boq_id, item_no: b.item_no, description: b.description, unit: b.unit, contract_qty: b.contract_qty })),
    activities,
    qa,
    photos: L.photos,
    reports: reports.map(({ issued_raw: _raw, ...r }) => ({ ...r, report_id: Number(r.report_id), revision: Number(r.revision), issued_by: r.issued_by || '' })),
    changed_since_issue: Boolean(changedSinceIssue),
    copy_from: await copySources(L.contract),
    lists: C.LISTS,
    model,
  };
}

// ------------------------------------------------------------------ v2: the client's form
async function issuedOf(contractId, date) {
  const [rows] = await pool.query(
    `SELECT r.report_id, r.report_no, r.revision, r.status, r.fingerprint, DATE_FORMAT(r.issued_at, '%Y-%m-%d %H:%i') AS issued_at,
            DATE_FORMAT(r.issued_at, '%Y-%m-%d %H:%i:%s') AS issued_raw, u.full_name AS issued_by
       FROM dpr_reports r LEFT JOIN users u ON u.user_id = r.issued_by_user_id
      WHERE r.contract_id = ? AND r.report_date = ? ORDER BY r.revision DESC`, [contractId, date]);
  return rows;
}

async function getUccBundle(contractId, date) {
  const { model, contract, day } = await U.buildUcc(contractId, date);
  const [reports, wir, boq, areas, others] = await Promise.all([
    issuedOf(contractId, date),
    listQa(contractId, date),
    Setup.listBoq(contractId),
    Setup.listAreas(contractId),
    pool.query('SELECT contract_id, code, title FROM dpr_contracts WHERE contract_id <> ? AND is_active = 1 ORDER BY sort_order, code', [contractId]).then(([r]) => r),
  ]);
  const current = reports.find((r) => r.status === 'Issued');
  let changed = false;
  if (current) {
    changed = current.fingerprint ? current.fingerprint !== model.fingerprint : await changedAfter(contractId, date, current.issued_raw);
  }
  const num = (v) => (v === null || v === undefined ? null : String(Number(v)));
  return {
    template: 'ucc',
    contract,
    date,
    day: {
      weather_condition: day ? day.weather_condition : null, humidity_level: day ? day.humidity_level : null,
      temp_max: day ? num(day.temp_max) : null, temp_min: day ? num(day.temp_min) : null,
      weather_remarks: day ? day.weather_remarks : null, remarks: day ? day.remarks : null,
    },
    version: day ? Number(day.version) : 0,
    last_saved: day ? day.updated_txt : null,
    layout_day: day && day.layout ? UL.clean(day.layout) : null,
    layout_contract: contract.layout,
    ucc_sections: UL.SECTIONS,
    links: model.links,
    lists: contract.lists,
    boq: boq.filter((b) => b.is_active && b.row_type === 'item').map((b) => ({ boq_id: b.boq_id, item_no: b.item_no, description: b.description, unit: b.unit, contract_qty: b.contract_qty })),
    areas,
    activities: await listActivities(contractId, date),
    wir,
    materials: model.materials,
    photos: model.photos,
    reports: reports.map(({ issued_raw: _raw, fingerprint: _fp, ...r }) => ({ ...r, report_id: Number(r.report_id), revision: Number(r.revision), issued_by: r.issued_by || '' })),
    changed_since_issue: changed,
    other_contracts: others.map((o) => ({ contract_id: Number(o.contract_id), code: o.code, title: o.title })),
    model,
  };
}

/** Finds a figure of the model by its key (line:12:present, boq:5:cum, tot:staff:total...). */
function findCell(model, key) {
  if (!/^(line|auto|boq|tot):/.test(key)) return null;
  const parts = key.split(':');
  const field = parts[parts.length - 1];
  const rowKey = parts.slice(0, -1).join(':');
  const tables = [
    ['manpower', model.manpower.staff], ['manpower', model.manpower.trades], ['plant', model.plant.plant], ['plant', model.plant.tools],
  ];
  if (key.startsWith('line:') || key.startsWith('auto:')) {
    for (const [section, t] of tables) {
      const r = t.rows.find((x) => x.key === rowKey);
      if (r && r.cells[field]) return { section, cell: r.cells[field], label: `${r.name} – ${field}`, row: r };
    }
    return null;
  }
  if (key.startsWith('boq:')) {
    for (const g of model.boq.groups) {
      const r = g.rows.find((x) => x.row_type === 'item' && `boq:${x.boq_id}` === rowKey);
      if (r && r.cells[field]) return { section: 'boq', cell: r.cells[field], label: `BOQ ${r.item_no} – ${field}`, row: r };
    }
    return null;
  }
  if (key.startsWith('tot:')) {
    const [, table] = parts;
    const t = { staff: model.manpower.staff.total, trades: model.manpower.trades.total, manpower: model.manpower.grand,
      plant: model.plant.plant.total, tools: model.plant.tools.total }[table];
    if (t && t[field]) return { section: ['plant', 'tools'].includes(table) ? 'plant' : 'manpower', cell: t[field], label: `Total ${table} – ${field}` };
  }
  return null;
}

/** An automatic row becomes a real row of the contract (counted from the same system name). */
async function materializeAuto(contractId, key, userId) {
  const m = /^auto:(trade|staff|plant):(.+):([a-z]+)$/.exec(key);
  if (!m) return key;
  const [, kind, name, field] = m;
  const line = await C.inTransaction(async (conn) => {
    const crow = await C.getContractRow(conn, contractId);
    const map = kind === 'trade' ? { tf: [name], eq: [] } : kind === 'staff' ? { tf: [], sp: [name], eq: [] } : { tf: [], eq: [{ type: name, vendor: null }] };
    const f = Setup.lineFields({ name, source_map: map, category: kind === 'staff' ? 'Staff' : null }, kind, crow.template === 'dpr' ? 'dpr' : 'ucc');
    await Setup.checkMapUnique(conn, contractId, null, f.source_map);
    const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dpr_lines WHERE contract_id = ? AND kind = ?', [contractId, kind]);
    f.sort_order = Number(mx.n);
    const [ins] = await conn.query(
      `INSERT INTO dpr_lines (contract_id, kind, ${Setup.LINE_FIELDS.join(', ')}) VALUES (?, ?, ${Setup.LINE_FIELDS.map(() => '?').join(', ')})`,
      [contractId, kind, ...Setup.LINE_FIELDS.map((k) => f[k])]);
    await C.logChange(conn, { contractId, entity: 'line', entityId: ins.insertId, field: 'create', oldValue: null, newValue: { kind, name, from: 'automatic row' }, userId });
    return ins.insertId;
  });
  return `line:${line}:${field}`;
}

/** The same figure in another contract (rows matched by kind + name, BOQ by item number). */
async function keyIn(otherId, key, fromId) {
  if (key.startsWith('tot:')) return key;
  const parts = key.split(':');
  const field = parts[parts.length - 1];
  if (key.startsWith('line:')) {
    const [[l]] = await pool.query('SELECT kind, name, subcontractor FROM dpr_lines WHERE line_id = ? AND contract_id = ?', [Number(parts[1]), fromId]);
    if (!l) return null;
    const [rows] = await pool.query('SELECT line_id, name, subcontractor FROM dpr_lines WHERE contract_id = ? AND kind = ? AND is_active = 1', [otherId, l.kind]);
    const hit = rows.find((r) => S.norm(r.name) === S.norm(l.name) && S.norm(r.subcontractor) === S.norm(l.subcontractor));
    return hit ? `line:${hit.line_id}:${field}` : null;
  }
  if (key.startsWith('boq:')) {
    const [[b]] = await pool.query('SELECT item_no FROM dpr_boq WHERE boq_id = ? AND contract_id = ?', [Number(parts[1]), fromId]);
    if (!b) return null;
    const [[o]] = await pool.query("SELECT boq_id FROM dpr_boq WHERE contract_id = ? AND item_no = ? AND row_type = 'item'", [otherId, b.item_no]);
    return o ? `boq:${o.boq_id}:${field}` : null;
  }
  return null;
}

function checkLinkedSection(model, section) {
  const l = model.links && model.links[section];
  if (l) throw new DprError(`This section is the same as contract ${l.code} (Setup → Same as). Change it in ${l.code}, or stop following it.`, 409);
}

async function manualTargets(contractId, date, body, userId) {
  const b = body || {};
  let key = String(b.key || '');
  const { model } = await U.buildUcc(contractId, date);
  const found = findCell(model, key);
  if (!found) throw new DprError('Figure not found in this report.', 404);
  checkLinkedSection(model, found.section);
  if (key.startsWith('auto:')) key = await materializeAuto(contractId, key, userId);
  const targets = [{ contractId, key, label: found.label, systemValue: found.cell.s }];
  const missing = [];
  for (const other of C.ids(b.apply_to).filter((x) => x !== contractId)) {
    const k = await keyIn(other, key, contractId);
    const [[oc]] = await pool.query('SELECT code FROM dpr_contracts WHERE contract_id = ?', [other]);
    if (!oc) throw new DprError('A contract to apply to does not exist.');
    if (!k) { missing.push(oc.code); continue; }
    targets.push({ contractId: other, key: k, label: found.label, systemValue: null });
  }
  if (missing.length) throw new DprError(`Contract(s) ${missing.join(', ')} have no row / BOQ item with this name: nothing saved.`, 409);
  return { targets, found };
}

/** A figure read from a system (or computed from them) needs dpr.override; a typed row only dpr.edit. */
function needsOverride(found) {
  if (String(found.label).startsWith('Total')) return true;
  if (found.row && found.row.sourced === false) return false;
  return true;
}

async function setManual(contractId, date, body, userId, perms = []) {
  const b = body || {};
  const pre = await U.buildUcc(contractId, date);
  const f0 = findCell(pre.model, String(b.key || ''));
  if (f0 && needsOverride(f0) && !perms.includes('dpr.override')) {
    throw new DprError('Your role cannot change figures that come from the systems (permission "Change system figures").', 403);
  }
  const { targets, found } = await manualTargets(contractId, date, b, userId);
  const sourcedSystem = found.cell.s !== null && found.cell.s !== undefined && found.cell.m !== 'typed';
  const reason = C.line(b.reason, 500, { label: 'Reason' });
  if (sourcedSystem && (!reason || reason.length < 3) && !String(targets[0].key).startsWith('tot:')) {
    throw new DprError('Write the reason of the change (this figure comes from the system).');
  }
  const saved = await MV.setValue({ targets, value: b.value, scope: b.scope || 'day', date, toDate: b.to_date, reason, userId });
  return { saved, key: targets[0].key };
}

async function previewManual(contractId, date, body, today) {
  const b = body || {};
  const key = String(b.key || '');
  const scope = C.oneOf(b.scope || 'day', MV.SCOPES, { label: 'Scope' });
  const ids = [contractId, ...C.ids(b.apply_to).filter((x) => x !== contractId)];
  const out = await MV.impact(ids, { key, scope, date, toDate: C.date(b.to_date, { label: 'Last day' }), today });
  // later "from this day on" values of the same figure keep their own value after their date
  if (scope === 'forward') {
    const [later] = await pool.query(
      `SELECT DATE_FORMAT(from_date, '%Y-%m-%d') AS d, value FROM dpr_manual_values
        WHERE contract_id = ? AND field_key = ? AND scope = 'forward' AND reverted_at IS NULL AND from_date > ? ORDER BY from_date`, [contractId, key, date]);
    out.later_values = later.map((x) => ({ from_date: x.d, value: x.value }));
  }
  return out;
}

async function revertManual(contractId, date, body, userId, perms = []) {
  const b = body || {};
  const key = String(b.key || '');
  const { model } = await U.buildUcc(contractId, date);
  const found = findCell(model, key);
  if (found) checkLinkedSection(model, found.section);
  if (found && needsOverride(found) && !perms.includes('dpr.override')) {
    throw new DprError('Your role cannot change figures that come from the systems (permission "Change system figures").', 403);
  }
  const out = [await MV.revert({ contractId, key, date, mode: b.mode || 'all', fromDate: b.from_date, userId })];
  for (const other of C.ids(b.apply_to).filter((x) => x !== contractId)) {
    const k = await keyIn(other, key, contractId);
    if (!k) continue;
    try {
      out.push(await MV.revert({ contractId: other, key: k, date, mode: b.mode || 'all', fromDate: b.from_date, userId }));
    } catch (e) {
      if (e.statusCode !== 404) throw e;
    }
  }
  return out;
}

async function changedAfter(contractId, date, issuedAt) {
  const [[x]] = await pool.query(
    `SELECT COUNT(*) AS n FROM dpr_change_log WHERE contract_id = ? AND report_date = ? AND created_at >= ? AND entity <> 'report'`,
    [contractId, date, issuedAt]);
  return Number(x.n) > 0;
}

async function copySources(contract) {
  if (!contract.copy_from_ids.length) return [];
  const [rows] = await pool.query('SELECT contract_id, code, title FROM dpr_contracts WHERE contract_id IN (?) AND is_active = 1 ORDER BY sort_order, code', [contract.copy_from_ids]);
  return rows.map((r) => ({ contract_id: Number(r.contract_id), code: r.code, title: r.title }));
}

// ------------------------------------------------------------------ copy from another contract (same day)
const COPY_PARTS = {
  weather: ['weather_am', 'weather_pm', 'temp_max', 'temp_min', 'humidity', 'wind', 'hours_lost', 'weather_remarks', 'weather_condition', 'humidity_level'],
  hse: ['tbt_topic', 'tbt_attendees', 'hse_inspections', 'incidents', 'near_misses', 'first_aid', 'lti', 'ptws', 'hse_observations'],
  plan: ['next_day_plan'],
  remarks: ['remarks'],
};
const ALL_PARTS = ['weather', 'hse', 'plan', 'remarks', 'counts', 'overrides', 'qa', 'activities', 'materials'];

/**
 * Copies the day data of another contract (allowed in Setup: "copy from") into this
 * contract for the same date. Lines are matched by kind + name (+ subcontractor), BOQ
 * items by Item No. Fields of this contract are replaced; everything is logged.
 */
async function copyDay(contractId, date, fromId, parts, userId) {
  const want = (Array.isArray(parts) && parts.length ? parts : ALL_PARTS).map(String).filter((p) => ALL_PARTS.includes(p));
  if (!want.length) throw new DprError('Choose what to copy.');
  const target = await M.contractForDays(contractId);
  M.checkDate(target, date);
  if (!target.copy_from_ids.includes(fromId)) throw new DprError('Copying from this contract is not allowed (Setup → Copy from).', 403);
  const [[src]] = await pool.query('SELECT contract_id, code FROM dpr_contracts WHERE contract_id = ?', [fromId]);
  if (!src) throw new DprError('Contract to copy from not found.', 404);
  return C.inTransaction(async (conn) => {
    const result = { from: src.code, copied: {}, skipped: [] };
    const [[srcDay]] = await conn.query('SELECT * FROM dpr_days WHERE contract_id = ? AND report_date = ?', [fromId, date]);
    const dayCols = want.flatMap((p) => COPY_PARTS[p] || []);
    if (dayCols.length) {
      if (!srcDay) {
        result.skipped.push('day fields (nothing typed in the other contract for this date)');
      } else {
        const before = await ensureDay(conn, contractId, date, userId);
        await conn.query(
          `UPDATE dpr_days SET ${dayCols.map((k) => `${k} = ?`).join(', ')}, version = version + 1, updated_by_user_id = ?
            WHERE contract_id = ? AND report_date = ?`, [...dayCols.map((k) => srcDay[k]), userId, contractId, date]);
        const [[after]] = await conn.query('SELECT * FROM dpr_days WHERE contract_id = ? AND report_date = ?', [contractId, date]);
        await C.logRowChanges(conn, { contractId, date, entity: 'day', entityId: date, userId }, before, after, dayCols);
        result.copied.day_fields = dayCols.length;
      }
    }
    // line matching
    const [srcLines] = await conn.query('SELECT * FROM dpr_lines WHERE contract_id = ? AND is_active = 1', [fromId]);
    const [dstLines] = await conn.query('SELECT * FROM dpr_lines WHERE contract_id = ? AND is_active = 1', [contractId]);
    const lkey = (l) => `${l.kind}|${S.norm(l.subcontractor)}|${S.norm(l.name)}`;
    const dstBy = new Map(dstLines.map((l) => [lkey(l), l]));
    const lineMap = new Map();
    for (const l of srcLines) {
      const d = dstBy.get(lkey(l));
      if (d) lineMap.set(Number(l.line_id), d);
    }
    if (want.includes('counts')) {
      const [rows] = await conn.query('SELECT line_id, count_value FROM dpr_day_counts WHERE contract_id = ? AND report_date = ?', [fromId, date]);
      let n = 0;
      for (const r of rows) {
        const d = lineMap.get(Number(r.line_id));
        if (!d || S.hasSource(S.cleanMap(d.source_map))) continue;
        const [[old]] = await conn.query('SELECT count_value FROM dpr_day_counts WHERE contract_id = ? AND report_date = ? AND line_id = ?', [contractId, date, d.line_id]);
        await conn.query(
          `INSERT INTO dpr_day_counts (contract_id, report_date, line_id, count_value, updated_by_user_id) VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE count_value = VALUES(count_value), updated_by_user_id = VALUES(updated_by_user_id)`,
          [contractId, date, d.line_id, r.count_value, userId]);
        await C.logChange(conn, { contractId, date, entity: 'count', entityId: d.line_id, field: 'count_value', oldValue: old ? String(old.count_value) : '0', newValue: String(r.count_value), userId });
        n += 1;
      }
      result.copied.counts = n;
    }
    if (want.includes('overrides')) {
      const [rows] = await conn.query(
        `SELECT * FROM dpr_overrides WHERE contract_id = ? AND report_date = ? AND reverted_at IS NULL ORDER BY override_id`, [fromId, date]);
      let n = 0;
      for (const r of rows) {
        const m = /^line:(\d+)$/.exec(r.field_key);
        const d = m && lineMap.get(Number(m[1]));
        if (!d || !S.hasSource(S.cleanMap(d.source_map))) continue;
        const key = `line:${d.line_id}`;
        await conn.query(`UPDATE dpr_overrides SET reverted_at = CURRENT_TIMESTAMP, reverted_by_user_id = ?
                           WHERE contract_id = ? AND report_date = ? AND field_key = ? AND reverted_at IS NULL`, [userId, contractId, date, key]);
        await conn.query(
          `INSERT INTO dpr_overrides (contract_id, report_date, field_key, field_label, system_value, manual_value, reason, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [contractId, date, key, r.field_label, r.system_value, r.manual_value, `${r.reason} (copied from ${src.code})`.slice(0, 500), userId]);
        await C.logChange(conn, { contractId, date, entity: 'override', entityId: key, field: 'value', oldValue: null, newValue: r.manual_value, userId });
        n += 1;
      }
      result.copied.overrides = n;
    }
    if (want.includes('materials')) {
      const MATS = ['description', 'unit', 'qty', 'supplier', 'delivery_note', 'mar_ref', 'element', 'boq_ref', 'intended_use'];
      const [rows] = await conn.query('SELECT * FROM dpr_materials WHERE contract_id = ? AND report_date = ? AND is_deleted = 0 ORDER BY sort_order, material_id', [fromId, date]);
      const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM dpr_materials WHERE contract_id = ? AND report_date = ?', [contractId, date]);
      let order = Number(mx.n);
      for (const r of rows) {
        order += 1;
        await conn.query(`INSERT INTO dpr_materials (contract_id, report_date, sort_order, ${MATS.join(', ')}) VALUES (?, ?, ?, ${MATS.map(() => '?').join(', ')})`,
          [contractId, date, order, ...MATS.map((k) => r[k])]);
      }
      result.copied.materials = rows.length;
    }
    if (want.includes('qa')) {
      const [rows] = await conn.query('SELECT * FROM dpr_qa WHERE contract_id = ? AND report_date = ? AND is_deleted = 0 ORDER BY sort_order, qa_id', [fromId, date]);
      const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM dpr_qa WHERE contract_id = ? AND report_date = ?', [contractId, date]);
      let order = Number(mx.n);
      for (const r of rows) {
        order += 1;
        const [ins] = await conn.query(
          `INSERT INTO dpr_qa (contract_id, report_date, sort_order, ${QA_FIELDS.join(', ')}) VALUES (?, ?, ?, ${QA_FIELDS.map(() => '?').join(', ')})`,
          [contractId, date, order, ...QA_FIELDS.map((k) => r[k])]);
        await C.logChange(conn, { contractId, date, entity: 'qa', entityId: ins.insertId, field: 'copied', oldValue: null, newValue: r.ref_no || r.type, userId });
      }
      result.copied.qa = rows.length;
    }
    if (want.includes('activities')) {
      const [rows] = await conn.query(
        `SELECT a.*, b.item_no FROM dpr_activities a LEFT JOIN dpr_boq b ON b.boq_id = a.boq_id
          WHERE a.contract_id = ? AND a.report_date = ? AND a.is_deleted = 0 ORDER BY a.sort_order, a.activity_id`, [fromId, date]);
      const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM dpr_activities WHERE contract_id = ? AND report_date = ?', [contractId, date]);
      let order = Number(mx.n);
      let n = 0;
      const missingItems = [];
      for (const r of rows) {
        let boqId = null;
        if (r.boq_id !== null) {
          const [[b]] = await conn.query("SELECT boq_id FROM dpr_boq WHERE contract_id = ? AND item_no = ? AND row_type = 'item'", [contractId, r.item_no]);
          if (!b) { missingItems.push(r.item_no); continue; }
          boqId = b.boq_id;
        }
        let areaId = null;
        if (r.area_id !== null) {
          const [[ar]] = await conn.query('SELECT a2.area_id FROM dpr_areas a1 JOIN dpr_areas a2 ON a2.name = a1.name AND a2.contract_id = ? WHERE a1.area_id = ?', [contractId, r.area_id]);
          areaId = ar ? ar.area_id : null;
        }
        order += 1;
        const [ins] = await conn.query(
          `INSERT INTO dpr_activities (contract_id, report_date, sort_order, boq_id, description, location, qty, unit, area_id, chainage, remarks, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [contractId, date, order, boqId, r.description, r.location, r.qty, r.unit, areaId, r.chainage, r.remarks, userId]);
        await conn.query(
          `INSERT INTO dpr_activity_crews (activity_id, kind, sort_order, name, nos, hours)
           SELECT ?, kind, sort_order, name, nos, hours FROM dpr_activity_crews WHERE activity_id = ?`, [ins.insertId, r.activity_id]);
        const [al] = await conn.query('SELECT line_id, count_value FROM dpr_activity_alloc WHERE activity_id = ?', [r.activity_id]);
        for (const x of al) {
          const d = lineMap.get(Number(x.line_id));
          if (d) await conn.query('INSERT INTO dpr_activity_alloc (activity_id, line_id, count_value) VALUES (?, ?, ?)', [ins.insertId, d.line_id, x.count_value]);
        }
        await C.logChange(conn, { contractId, date, entity: 'activity', entityId: ins.insertId, field: 'copied', oldValue: null, newValue: `${r.item_no || r.description || ''} ${r.qty}`, userId });
        n += 1;
      }
      result.copied.activities = n;
      if (missingItems.length) result.skipped.push(`activities of BOQ items not in this contract: ${[...new Set(missingItems)].join(', ')}`);
    }
    await C.logChange(conn, { contractId, date, entity: 'day', entityId: date, field: 'copy_from', oldValue: null, newValue: { from: src.code, parts: want }, userId });
    return result;
  });
}

// ------------------------------------------------------------------ registers
const NCR_FIELDS = ['ncr_no', 'date_raised', 'raised_by', 'description', 'root_cause', 'corrective_action', 'responsible', 'target_date', 'status', 'date_closed'];
const CONCERN_FIELDS = ['date_raised', 'issue', 'impact', 'severity', 'action_required', 'by_whom', 'target_date', 'status', 'date_closed'];

function closedRule(f) {
  if (f.status === 'Closed' && !f.date_closed) throw new DprError('Enter the date it was closed.');
  if (f.status !== 'Closed') f.date_closed = null;
  if (f.date_closed && f.date_closed < f.date_raised) throw new DprError('The closing date cannot be before the date raised.');
  return f;
}
function ncrFields(b) {
  return closedRule({
    ncr_no: C.line(b.ncr_no, 60, { required: true, label: 'NCR No.' }),
    date_raised: C.date(b.date_raised, { required: true, label: 'Date raised' }),
    raised_by: C.line(b.raised_by, 200, { label: 'Raised by' }),
    description: C.line(b.description, 1000, { required: true, label: 'Description' }),
    root_cause: C.line(b.root_cause, 1000, { label: 'Root cause' }),
    corrective_action: C.line(b.corrective_action, 1000, { label: 'Corrective action' }),
    responsible: C.line(b.responsible, 200, { label: 'Responsible' }),
    target_date: C.date(b.target_date, { label: 'Target date' }),
    status: C.oneOf(b.status, C.LISTS.status, { label: 'Status' }) || 'Open',
    date_closed: C.date(b.date_closed, { label: 'Date closed' }),
  });
}
function concernFields(b) {
  return closedRule({
    date_raised: C.date(b.date_raised, { required: true, label: 'Date raised' }),
    issue: C.line(b.issue, 1000, { required: true, label: 'Issue' }),
    impact: C.line(b.impact, 40, { label: 'Impact' }),
    severity: C.oneOf(b.severity, C.LISTS.severity, { label: 'Severity' }),
    action_required: C.line(b.action_required, 1000, { label: 'Action required' }),
    by_whom: C.line(b.by_whom, 200, { label: 'By whom' }),
    target_date: C.date(b.target_date, { label: 'Target date' }),
    status: C.oneOf(b.status, C.LISTS.status, { label: 'Status' }) || 'Open',
    date_closed: C.date(b.date_closed, { label: 'Date closed' }),
  });
}
const REG = {
  ncr: { table: 'dpr_ncr', key: 'ncr_id', fields: NCR_FIELDS, clean: ncrFields, label: 'NCR' },
  concern: { table: 'dpr_concerns', key: 'concern_id', fields: CONCERN_FIELDS, clean: concernFields, label: 'Concern' },
};
function regOut(kind, r) {
  const o = { ...r };
  o[REG[kind].key] = Number(r[REG[kind].key]);
  delete o.contract_id;
  delete o.is_deleted;
  return o;
}
async function listRegister(kind, contractId, { status = null } = {}) {
  const R = REG[kind];
  const [rows] = await pool.query(
    `SELECT * FROM ${R.table} WHERE contract_id = ? AND is_deleted = 0 ${status ? 'AND status = ?' : ''}
      ORDER BY status = 'Open' DESC, date_raised DESC, ${R.key} DESC`, status ? [contractId, status] : [contractId]);
  return rows.map((r) => regOut(kind, r));
}
async function saveRegister(kind, contractId, rowId, body, userId) {
  const R = REG[kind];
  const f = R.clean(body || {});
  return C.inTransaction(async (conn) => {
    await C.getContractRow(conn, contractId);
    let before = null;
    let rid = rowId;
    if (rid) {
      [[before]] = await conn.query(`SELECT * FROM ${R.table} WHERE ${R.key} = ? AND contract_id = ? AND is_deleted = 0`, [rid, contractId]);
      if (!before) throw new DprError(`${R.label} not found.`, 404);
      await conn.query(`UPDATE ${R.table} SET ${R.fields.map((k) => `${k} = ?`).join(', ')} WHERE ${R.key} = ?`, [...R.fields.map((k) => f[k]), rid]);
    } else {
      if (kind === 'ncr') {
        const [[dup]] = await conn.query('SELECT ncr_id FROM dpr_ncr WHERE contract_id = ? AND ncr_no = ? AND is_deleted = 0', [contractId, f.ncr_no]);
        if (dup) throw new DprError(`NCR No. ${f.ncr_no} already exists in this contract.`, 409);
      }
      const [ins] = await conn.query(
        `INSERT INTO ${R.table} (contract_id, ${R.fields.join(', ')}) VALUES (?, ${R.fields.map(() => '?').join(', ')})`,
        [contractId, ...R.fields.map((k) => f[k])]);
      rid = ins.insertId;
    }
    const [[after]] = await conn.query(`SELECT * FROM ${R.table} WHERE ${R.key} = ?`, [rid]);
    await C.logRowChanges(conn, { contractId, entity: kind, entityId: rid, userId }, before, after, R.fields);
    return regOut(kind, after);
  });
}
async function deleteRegister(kind, contractId, rowId, userId) {
  const R = REG[kind];
  return C.inTransaction(async (conn) => {
    const [r] = await conn.query(`UPDATE ${R.table} SET is_deleted = 1 WHERE ${R.key} = ? AND contract_id = ? AND is_deleted = 0`, [rowId, contractId]);
    if (!r.affectedRows) throw new DprError(`${R.label} not found.`, 404);
    await C.logChange(conn, { contractId, entity: kind, entityId: rowId, field: 'deleted', oldValue: '0', newValue: '1', userId });
  });
}

// ------------------------------------------------------------------ differences (manual values vs system values)
async function differences({ contractId = null, from = null, to = null, includeReverted = false, limit = 500 } = {}) {
  const where = ['1 = 1'];
  const args = [];
  if (contractId) { where.push('o.contract_id = ?'); args.push(contractId); }
  if (from) { where.push('o.report_date >= ?'); args.push(from); }
  if (to) { where.push('o.report_date <= ?'); args.push(to); }
  if (!includeReverted) where.push('o.reverted_at IS NULL');
  const [rows] = await pool.query(
    `SELECT o.override_id, o.contract_id, c.code AS contract_code, DATE_FORMAT(o.report_date, '%Y-%m-%d') AS report_date,
            o.field_key, o.field_label, o.system_value, o.manual_value, o.reason,
            DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i') AS created_at, u.full_name AS created_by,
            DATE_FORMAT(o.reverted_at, '%Y-%m-%d %H:%i') AS reverted_at, r.full_name AS reverted_by,
            EXISTS (SELECT 1 FROM dpr_reports rp WHERE rp.contract_id = o.contract_id AND rp.report_date = o.report_date AND rp.status = 'Issued') AS issued
       FROM dpr_overrides o
       JOIN dpr_contracts c ON c.contract_id = o.contract_id
       LEFT JOIN users u ON u.user_id = o.created_by_user_id
       LEFT JOIN users r ON r.user_id = o.reverted_by_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY o.report_date DESC, o.override_id DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 500, 1), 2000)}`, args);
  const old = rows.map((x) => ({
    override_id: Number(x.override_id), contract_id: Number(x.contract_id), contract_code: x.contract_code, report_date: x.report_date,
    field: x.field_label || x.field_key,
    system_value: x.system_value === null ? null : Number(x.system_value),
    manual_value: Number(x.manual_value),
    difference: x.system_value === null ? null : Number(x.manual_value) - Number(x.system_value),
    reason: x.reason, created_at: x.created_at, created_by: x.created_by || '',
    reverted_at: x.reverted_at, reverted_by: x.reverted_by || '', active: !x.reverted_at, issued: Number(x.issued) === 1,
    scope: 'day', to_date: null,
  }));
  // v2 manual values (with their scope)
  const mv = (await MV.differences({ contractId, includeReverted, limit }))
    .filter((x) => (!from || x.from_date >= from) && (!to || x.from_date <= to))
    .map((x) => {
      const sys = x.system_value === null || x.system_value === undefined || x.system_value === '' ? null : Number(x.system_value);
      const man = Number(x.value);
      return {
        override_id: null, mv_id: x.mv_id, contract_id: x.contract_id, contract_code: x.contract_code, report_date: x.from_date,
        field: x.field_label || x.field_key, system_value: sys, manual_value: man,
        difference: sys === null || Number.isNaN(man) ? null : man - sys,
        reason: x.reason, created_at: x.created_at, created_by: x.created_by, reverted_at: x.reverted_at, reverted_by: x.reverted_by,
        active: x.active, issued: x.issued, scope: x.scope, to_date: x.to_date,
      };
    });
  return [...old, ...mv].sort((a, b) => (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : 0));
}

module.exports = {
  patchDay, setCount, setOverride, revertOverride, overrideHistory, history,
  saveActivity, deleteActivity, reorderActivities, listActivities, saveQa, deleteQa, listQa, saveMaterial, deleteMaterial,
  getUccBundle, findCell, setManual, previewManual, revertManual,
  addPhoto, updatePhoto, deletePhoto, photoFile,
  getDayBundle, copyDay, ALL_PARTS,
  listRegister, saveRegister, deleteRegister, differences,
};
