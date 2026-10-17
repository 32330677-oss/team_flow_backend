// services/dpr/dprSetup.js
//
// One-time setup of each contract (the workbook's Setup sheet): contract
// information, VO / EOT log, trades, plant, subcontractor lines, BOQ, and
// which Team Flow / Equipment sites and names feed each line.
// Each contract is independent: nothing is shared between contracts.
'use strict';

const pool = require('../../config/db');
const ExcelJS = require('exceljs');
const C = require('./dprCommon');
const S = require('./dprSources');

const { DprError } = C;

// ------------------------------------------------------------------ contracts
const CONTRACT_TEXT = {
  company_name: 200, project_name: 500, project_code: 100, agreement_no: 200, client: 300, consultant: 300,
  main_contractor: 300, location: 300, prepared_by: 200, reviewed_by: 200, consultant_rep: 200,
};

function contractOut(r) {
  return {
    contract_id: Number(r.contract_id),
    code: r.code,
    title: r.title,
    is_active: Number(r.is_active) === 1,
    sort_order: Number(r.sort_order),
    company_name: r.company_name || '',
    project_name: r.project_name || '',
    project_code: r.project_code || '',
    agreement_no: r.agreement_no || '',
    client: r.client || '',
    consultant: r.consultant || '',
    main_contractor: r.main_contractor || '',
    location: r.location || '',
    currency: r.currency || 'AED',
    contract_value: r.contract_value,
    commencement_date: r.commencement_date || null,
    original_completion: r.original_completion || null,
    hrs_mp: r.hrs_mp,
    hrs_pl: r.hrs_pl,
    prepared_by: r.prepared_by || '',
    reviewed_by: r.reviewed_by || '',
    consultant_rep: r.consultant_rep || '',
    report_prefix: r.report_prefix ?? 'DPR-',
    tf_site_ids: C.ids(C.json(r.tf_site_ids)),
    eq_site_ids: C.ids(C.json(r.eq_site_ids)),
    copy_from_ids: C.ids(C.json(r.copy_from_ids)),
    sections: C.sectionFlags(null, r.sections),
    updated_at: r.updated_at,
  };
}

async function listContracts() {
  const [rows] = await pool.query('SELECT * FROM dpr_contracts ORDER BY is_active DESC, sort_order, code');
  return rows.map(contractOut);
}

function contractFields(b, { creating }) {
  const out = {};
  if (creating || b.code !== undefined) {
    out.code = C.line(b.code, 30, { required: true, label: 'Contract code' });
  }
  if (creating || b.title !== undefined) {
    out.title = C.line(b.title, 200, { required: true, label: 'Contract title' });
  }
  if (b.is_active !== undefined) out.is_active = C.bool(b.is_active) ? 1 : 0;
  if (b.sort_order !== undefined) out.sort_order = C.integer(b.sort_order, { label: 'Order', min: -1000, max: 1000 }) || 0;
  for (const [k, max] of Object.entries(CONTRACT_TEXT)) {
    if (b[k] !== undefined) out[k] = C.line(b[k], max, { label: k.replace(/_/g, ' ') });
  }
  if (b.currency !== undefined) out.currency = C.line(b.currency, 10, { required: true, label: 'Currency' }).toUpperCase();
  if (b.contract_value !== undefined) out.contract_value = C.decimal(b.contract_value, { label: 'Contract value', min: 0, places: 2 });
  if (b.commencement_date !== undefined) out.commencement_date = C.date(b.commencement_date, { label: 'Commencement date' });
  if (b.original_completion !== undefined) out.original_completion = C.date(b.original_completion, { label: 'Original completion date' });
  if (b.hrs_mp !== undefined) out.hrs_mp = C.decimal(b.hrs_mp, { label: 'Working hours / day (manpower)', min: 0, max: 24, places: 2, required: true });
  if (b.hrs_pl !== undefined) out.hrs_pl = C.decimal(b.hrs_pl, { label: 'Working hours / day (plant)', min: 0, max: 24, places: 2, required: true });
  if (b.report_prefix !== undefined) out.report_prefix = C.line(b.report_prefix, 20, { label: 'Report number prefix' }) || '';
  if (b.tf_site_ids !== undefined) out.tf_site_ids = JSON.stringify(C.ids(b.tf_site_ids));
  if (b.eq_site_ids !== undefined) out.eq_site_ids = JSON.stringify(C.ids(b.eq_site_ids));
  if (b.copy_from_ids !== undefined) out.copy_from_ids = JSON.stringify(C.ids(b.copy_from_ids));
  if (b.sections !== undefined) out.sections = JSON.stringify(C.sectionFlags(b.sections));
  return out;
}

function checkDates(row) {
  if (row.commencement_date && row.original_completion && row.original_completion < row.commencement_date) {
    throw new DprError('The original completion date cannot be before the commencement date.');
  }
}

async function createContract(body, userId) {
  const f = contractFields(body || {}, { creating: true });
  checkDates(f);
  return C.inTransaction(async (conn) => {
    const cols = Object.keys(f);
    const [ins] = await conn.query(
      `INSERT INTO dpr_contracts (${cols.join(', ')}, created_by_user_id, updated_by_user_id)
       VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`, [...cols.map((k) => f[k]), userId, userId]);
    await C.logChange(conn, { contractId: ins.insertId, entity: 'contract', entityId: ins.insertId, field: 'create', oldValue: null, newValue: f, userId });
    return contractOut(await C.getContractRow(conn, ins.insertId));
  });
}

async function updateContract(contractId, body, userId) {
  const f = contractFields(body || {}, { creating: false });
  if (f.copy_from_ids) f.copy_from_ids = JSON.stringify(C.ids(JSON.parse(f.copy_from_ids)).filter((x) => x !== contractId));
  return C.inTransaction(async (conn) => {
    const before = await C.getContractRow(conn, contractId);
    checkDates({ ...before, ...f });
    const cols = Object.keys(f);
    if (cols.length) {
      await conn.query(
        `UPDATE dpr_contracts SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_by_user_id = ? WHERE contract_id = ?`,
        [...cols.map((k) => f[k]), userId, contractId]);
      const after = await C.getContractRow(conn, contractId);
      const norm = (r) => ({ ...r, tf_site_ids: JSON.stringify(C.json(r.tf_site_ids)), eq_site_ids: JSON.stringify(C.json(r.eq_site_ids)),
        copy_from_ids: JSON.stringify(C.json(r.copy_from_ids)), sections: JSON.stringify(C.json(r.sections)) });
      await C.logRowChanges(conn, { contractId, entity: 'contract', entityId: contractId, userId }, norm(before), norm(after), cols);
    }
    return contractOut(await C.getContractRow(conn, contractId));
  });
}

// ------------------------------------------------------------------ VO / EOT
function eotOut(r) {
  return {
    eot_vo_id: Number(r.eot_vo_id), sort_order: Number(r.sort_order), description: r.description, ref_no: r.ref_no || '',
    type: r.type, days_granted: Number(r.days_granted), value: r.value, approval_date: r.approval_date || null, status: r.status,
  };
}
function eotFields(b) {
  return {
    description: C.line(b.description, 500, { required: true, label: 'Description' }),
    ref_no: C.line(b.ref_no, 100, { label: 'Ref No.' }),
    type: C.oneOf(b.type, C.LISTS.eot_vo_types, { required: true, label: 'Type' }),
    days_granted: C.integer(b.days_granted, { label: 'Days granted', min: 0, max: 10000 }) || 0,
    value: C.decimal(b.value, { label: 'Value', places: 2, min: -1e15, max: 1e15 }) || '0',
    approval_date: C.date(b.approval_date, { label: 'Approval date' }),
    status: C.oneOf(b.status, C.LISTS.approval, { label: 'Status' }) || 'Pending',
    sort_order: C.integer(b.sort_order, { label: 'Order', min: 0, max: 100000 }) || 0,
  };
}
const EOT_FIELDS = ['description', 'ref_no', 'type', 'days_granted', 'value', 'approval_date', 'status', 'sort_order'];

async function listEotVo(contractId) {
  const [rows] = await pool.query(
    'SELECT * FROM dpr_eot_vo WHERE contract_id = ? AND is_deleted = 0 ORDER BY sort_order, eot_vo_id', [contractId]);
  return rows.map(eotOut);
}
async function saveEotVo(contractId, eotId, body, userId) {
  const f = eotFields(body || {});
  return C.inTransaction(async (conn) => {
    await C.getContractRow(conn, contractId);
    let rowId = eotId;
    let before = null;
    if (rowId) {
      [[before]] = await conn.query('SELECT * FROM dpr_eot_vo WHERE eot_vo_id = ? AND contract_id = ? AND is_deleted = 0', [rowId, contractId]);
      if (!before) throw new DprError('VO / EOT entry not found.', 404);
      await conn.query(`UPDATE dpr_eot_vo SET ${EOT_FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE eot_vo_id = ?`, [...EOT_FIELDS.map((k) => f[k]), rowId]);
    } else {
      const [ins] = await conn.query(
        `INSERT INTO dpr_eot_vo (contract_id, ${EOT_FIELDS.join(', ')}) VALUES (?, ${EOT_FIELDS.map(() => '?').join(', ')})`,
        [contractId, ...EOT_FIELDS.map((k) => f[k])]);
      rowId = ins.insertId;
    }
    const [[after]] = await conn.query('SELECT * FROM dpr_eot_vo WHERE eot_vo_id = ?', [rowId]);
    await C.logRowChanges(conn, { contractId, entity: 'eot_vo', entityId: rowId, userId }, before, after, EOT_FIELDS);
    return eotOut(after);
  });
}
async function deleteEotVo(contractId, eotId, userId) {
  return C.inTransaction(async (conn) => {
    const [r] = await conn.query('UPDATE dpr_eot_vo SET is_deleted = 1 WHERE eot_vo_id = ? AND contract_id = ? AND is_deleted = 0', [eotId, contractId]);
    if (!r.affectedRows) throw new DprError('VO / EOT entry not found.', 404);
    await C.logChange(conn, { contractId, entity: 'eot_vo', entityId: eotId, field: 'deleted', oldValue: '0', newValue: '1', userId });
  });
}

// ------------------------------------------------------------------ resource lines
function lineOut(r) {
  return {
    line_id: Number(r.line_id), kind: r.kind, sort_order: Number(r.sort_order), name: r.name,
    category: r.category || '', ownership: r.ownership || '', subcontractor: r.subcontractor || '',
    res_type: r.res_type || null, scope: r.scope || '', source_map: S.cleanMap(r.source_map),
    opening_days: r.opening_days, is_active: Number(r.is_active) === 1,
  };
}
function lineFields(b, kind) {
  const f = {
    name: C.line(b.name, 200, { required: true, label: kind === 'trade' ? 'Trade' : kind === 'plant' ? 'Equipment' : 'Resource' }),
    sort_order: C.integer(b.sort_order, { label: 'Order', min: 0, max: 100000 }) || 0,
    category: null, ownership: null, subcontractor: null, res_type: null, scope: null,
    source_map: JSON.stringify(S.cleanMap(b.source_map)),
    opening_days: C.decimal(b.opening_days, { label: 'Opening days', min: 0, max: 9999999999, places: 2 }) || '0',
    is_active: b.is_active === undefined ? 1 : (C.bool(b.is_active) ? 1 : 0),
  };
  if (kind === 'trade') f.category = C.line(b.category, 60, { required: true, label: 'Category' });
  if (kind === 'plant') f.ownership = C.oneOf(b.ownership, C.LISTS.ownership, { required: true, label: 'Ownership' });
  if (kind === 'subcon') {
    f.subcontractor = C.line(b.subcontractor, 200, { required: true, label: 'Subcontractor' });
    f.res_type = C.oneOf(b.res_type, C.LISTS.res_types, { required: true, label: 'Type' });
    f.scope = C.line(b.scope, 200, { label: 'Scope / package' });
  }
  return f;
}
const LINE_FIELDS = ['name', 'sort_order', 'category', 'ownership', 'subcontractor', 'res_type', 'scope', 'source_map', 'opening_days', 'is_active'];

async function listLines(contractId, { activeOnly = false } = {}) {
  const [rows] = await pool.query(
    `SELECT * FROM dpr_lines WHERE contract_id = ? ${activeOnly ? 'AND is_active = 1' : ''}
      ORDER BY FIELD(kind, 'trade', 'plant', 'subcon'), sort_order, line_id`, [contractId]);
  return rows.map(lineOut);
}

/** A system name may feed ONE line of a contract only (otherwise it would be counted twice). */
async function checkMapUnique(conn, contractId, lineId, mapJson) {
  const map = S.cleanMap(mapJson);
  if (!S.hasSource(map)) return;
  const [rows] = await conn.query(
    'SELECT line_id, name, source_map FROM dpr_lines WHERE contract_id = ? AND is_active = 1 AND line_id <> ?', [contractId, lineId || 0]);
  for (const r of rows) {
    const other = S.cleanMap(r.source_map);
    for (const n of map.tf) {
      if (other.tf.some((x) => S.norm(x) === S.norm(n))) throw new DprError(`"${n}" is already counted on the line "${r.name}".`, 409);
    }
    for (const e of map.eq) {
      if (other.eq.some((x) => S.norm(x.type) === S.norm(e.type) && S.norm(x.vendor) === S.norm(e.vendor))) {
        throw new DprError(`"${e.type}${e.vendor ? ` (${e.vendor})` : ''}" is already counted on the line "${r.name}".`, 409);
      }
    }
  }
}

async function saveLine(contractId, lineId, body, userId) {
  const b = body || {};
  return C.inTransaction(async (conn) => {
    await C.getContractRow(conn, contractId);
    let before = null;
    let kind = b.kind;
    if (lineId) {
      [[before]] = await conn.query('SELECT * FROM dpr_lines WHERE line_id = ? AND contract_id = ?', [lineId, contractId]);
      if (!before) throw new DprError('Line not found.', 404);
      kind = before.kind;
    } else {
      kind = C.oneOf(kind, ['trade', 'plant', 'subcon'], { required: true, label: 'Line kind' });
    }
    const f = lineFields(b, kind);
    if (f.is_active) await checkMapUnique(conn, contractId, lineId, f.source_map);
    let rowId = lineId;
    if (rowId) {
      await conn.query(`UPDATE dpr_lines SET ${LINE_FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE line_id = ?`, [...LINE_FIELDS.map((k) => f[k]), rowId]);
    } else {
      if (!b.sort_order) {
        const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dpr_lines WHERE contract_id = ? AND kind = ?', [contractId, kind]);
        f.sort_order = Number(mx.n);
      }
      const [ins] = await conn.query(
        `INSERT INTO dpr_lines (contract_id, kind, ${LINE_FIELDS.join(', ')}) VALUES (?, ?, ${LINE_FIELDS.map(() => '?').join(', ')})`,
        [contractId, kind, ...LINE_FIELDS.map((k) => f[k])]);
      rowId = ins.insertId;
    }
    const [[after]] = await conn.query('SELECT * FROM dpr_lines WHERE line_id = ?', [rowId]);
    const norm = (r) => (r ? { ...r, source_map: JSON.stringify(S.cleanMap(r.source_map)) } : r);
    await C.logRowChanges(conn, { contractId, entity: 'line', entityId: rowId, userId }, norm(before), norm(after), LINE_FIELDS);
    return lineOut(after);
  });
}

/** Lines are never deleted (days and activities point to them): they are switched off. */
async function setLineActive(contractId, lineId, active, userId) {
  return saveLineFlag(contractId, lineId, active, userId);
}
async function saveLineFlag(contractId, lineId, active, userId) {
  return C.inTransaction(async (conn) => {
    const [[before]] = await conn.query('SELECT * FROM dpr_lines WHERE line_id = ? AND contract_id = ?', [lineId, contractId]);
    if (!before) throw new DprError('Line not found.', 404);
    if (active) await checkMapUnique(conn, contractId, lineId, before.source_map);
    await conn.query('UPDATE dpr_lines SET is_active = ? WHERE line_id = ?', [active ? 1 : 0, lineId]);
    await C.logChange(conn, { contractId, entity: 'line', entityId: lineId, field: 'is_active', oldValue: String(before.is_active), newValue: active ? '1' : '0', userId });
    const [[after]] = await conn.query('SELECT * FROM dpr_lines WHERE line_id = ?', [lineId]);
    return lineOut(after);
  });
}

async function reorderLines(contractId, kind, orderedIds, userId) {
  const k = C.oneOf(kind, ['trade', 'plant', 'subcon'], { required: true, label: 'Line kind' });
  const list = C.ids(orderedIds, 500);
  return C.inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT line_id FROM dpr_lines WHERE contract_id = ? AND kind = ?', [contractId, k]);
    const known = new Set(rows.map((r) => Number(r.line_id)));
    if (list.some((x) => !known.has(x))) throw new DprError('Unknown line in the new order.');
    let i = 1;
    for (const lid of list) {
      await conn.query('UPDATE dpr_lines SET sort_order = ? WHERE line_id = ?', [i, lid]);
      i += 1;
    }
    await C.logChange(conn, { contractId, entity: 'line', field: `order:${k}`, oldValue: null, newValue: list.join(','), userId });
    return listLines(contractId);
  });
}

// ------------------------------------------------------------------ BOQ
function boqOut(r) {
  return {
    boq_id: Number(r.boq_id), sort_order: Number(r.sort_order), item_no: r.item_no, description: r.description,
    unit: r.unit || '', contract_qty: r.contract_qty, rate: r.rate, opening_qty: r.opening_qty, remarks: r.remarks || '',
    is_active: Number(r.is_active) === 1,
  };
}
function boqFields(b) {
  return {
    item_no: C.line(b.item_no, 50, { required: true, label: 'Item No.' }),
    description: C.line(b.description, 1000, { required: true, label: 'Description' }),
    unit: C.line(b.unit, 30, { label: 'Unit' }),
    contract_qty: C.decimal(b.contract_qty, { label: 'Contract Qty', min: 0, max: 99999999999999, places: 4 }),
    rate: C.decimal(b.rate, { label: 'Rate', min: 0, max: 99999999999999, places: 4 }),
    opening_qty: C.decimal(b.opening_qty, { label: 'Opening qty', min: 0, max: 99999999999999, places: 4 }) || '0',
    remarks: C.line(b.remarks, 500, { label: 'Remarks' }),
    sort_order: C.integer(b.sort_order, { label: 'Order', min: 0, max: 100000 }) || 0,
    is_active: b.is_active === undefined ? 1 : (C.bool(b.is_active) ? 1 : 0),
  };
}
const BOQ_FIELDS = ['item_no', 'description', 'unit', 'contract_qty', 'rate', 'opening_qty', 'remarks', 'sort_order', 'is_active'];

async function listBoq(contractId, { activeOnly = false } = {}) {
  const [rows] = await pool.query(
    `SELECT * FROM dpr_boq WHERE contract_id = ? ${activeOnly ? 'AND is_active = 1' : ''} ORDER BY sort_order, boq_id`, [contractId]);
  return rows.map(boqOut);
}

async function saveBoqItem(conn, contractId, boqId, f, userId) {
  let before = null;
  let rowId = boqId;
  if (rowId) {
    [[before]] = await conn.query('SELECT * FROM dpr_boq WHERE boq_id = ? AND contract_id = ?', [rowId, contractId]);
    if (!before) throw new DprError('BOQ item not found.', 404);
    await conn.query(`UPDATE dpr_boq SET ${BOQ_FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE boq_id = ?`, [...BOQ_FIELDS.map((k) => f[k]), rowId]);
  } else {
    if (!f.sort_order) {
      const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dpr_boq WHERE contract_id = ?', [contractId]);
      f.sort_order = Number(mx.n);
    }
    const [ins] = await conn.query(
      `INSERT INTO dpr_boq (contract_id, ${BOQ_FIELDS.join(', ')}) VALUES (?, ${BOQ_FIELDS.map(() => '?').join(', ')})`,
      [contractId, ...BOQ_FIELDS.map((k) => f[k])]);
    rowId = ins.insertId;
  }
  const [[after]] = await conn.query('SELECT * FROM dpr_boq WHERE boq_id = ?', [rowId]);
  await C.logRowChanges(conn, { contractId, entity: 'boq', entityId: rowId, userId }, before, after, BOQ_FIELDS);
  return boqOut(after);
}

async function saveBoq(contractId, boqId, body, userId) {
  const f = boqFields(body || {});
  return C.inTransaction(async (conn) => {
    await C.getContractRow(conn, contractId);
    return saveBoqItem(conn, contractId, boqId, f, userId);
  });
}

/**
 * BOQ from an Excel file: first sheet, a header row with "Item", "Description", "Unit",
 * "Qty" / "Contract Qty", "Rate" (any order, any case). Existing items (same Item No.)
 * are updated, new ones added. All or nothing.
 */
async function importBoq(contractId, buffer, userId) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (_) {
    throw new DprError('This file is not a valid Excel (.xlsx) file.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new DprError('The Excel file has no sheet.');
  const cellText = (c) => {
    const v = c && c.value;
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      if (v.result !== undefined) return String(v.result);
      if (v.richText) return v.richText.map((t) => t.text).join('');
      if (v.text) return String(v.text);
    }
    return String(v);
  };
  let header = null;
  let cols = null;
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (header) return;
    const names = {};
    row.eachCell((c, cn) => { names[cn] = cellText(c).trim().toLowerCase(); });
    const find = (...keys) => Number(Object.keys(names).find((k) => keys.some((x) => names[k] === x || names[k].startsWith(x))) || 0);
    const item = find('item no', 'item', 'boq item');
    const desc = find('description');
    if (item && desc) {
      header = rn;
      cols = { item, desc, unit: find('unit'), qty: find('contract qty', 'qty', 'quantity'), rate: find('rate'), remarks: find('remarks') };
    }
  });
  if (!header) throw new DprError('Header row not found: the sheet needs the columns "Item No." and "Description" (and Unit, Contract Qty, Rate).');
  const items = [];
  const errors = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= header) return;
    const get = (c) => (c ? cellText(row.getCell(c)).trim() : '');
    if (!get(cols.item) && !get(cols.desc)) return;
    if (/^total/i.test(get(cols.item)) || /^total/i.test(get(cols.desc))) return;
    try {
      items.push(boqFields({
        item_no: get(cols.item), description: get(cols.desc), unit: get(cols.unit),
        contract_qty: get(cols.qty), rate: get(cols.rate), remarks: get(cols.remarks), sort_order: items.length + 1,
      }));
    } catch (e) {
      errors.push(`Row ${rn}: ${e.message}`);
    }
  });
  if (errors.length) throw new DprError(`Nothing imported. ${errors.slice(0, 10).join(' ')}`);
  if (!items.length) throw new DprError('No BOQ item found under the header row.');
  const seen = new Set();
  for (const it of items) {
    const k = it.item_no.toLowerCase();
    if (seen.has(k)) throw new DprError(`Nothing imported. Item No. "${it.item_no}" appears twice in the file.`);
    seen.add(k);
  }
  return C.inTransaction(async (conn) => {
    await C.getContractRow(conn, contractId);
    let added = 0;
    let updated = 0;
    for (const it of items) {
      const [[ex]] = await conn.query('SELECT boq_id, opening_qty FROM dpr_boq WHERE contract_id = ? AND item_no = ?', [contractId, it.item_no]);
      if (ex) {
        it.opening_qty = ex.opening_qty;
        updated += 1;
      } else {
        added += 1;
      }
      await saveBoqItem(conn, contractId, ex ? Number(ex.boq_id) : null, it, userId);
    }
    return { added, updated, total: items.length };
  });
}

// ------------------------------------------------------------------ full setup + copy
async function getSetup(contractId) {
  const [[row]] = await pool.query('SELECT * FROM dpr_contracts WHERE contract_id = ?', [contractId]);
  if (!row) throw new DprError('Contract not found.', 404);
  const [eot, lines, boq] = await Promise.all([listEotVo(contractId), listLines(contractId), listBoq(contractId)]);
  const contract = contractOut(row);
  const approved = eot.filter((x) => x.status === 'Approved');
  return {
    contract,
    eot_vo: eot,
    lines,
    boq,
    lists: C.LISTS,
    sections: C.SECTIONS,
    totals: {
      approved_eot_days: approved.filter((x) => x.type === 'EOT').reduce((a, x) => a + x.days_granted, 0),
      approved_vo: approved.filter((x) => x.type === 'VO').reduce((a, x) => a + Number(x.value), 0),
    },
  };
}

/**
 * Copies the setup lists (VO/EOT, lines with their mapping, BOQ) of another contract
 * into this one. Only into a contract that has none of them yet (never overwrites).
 */
async function copySetup(contractId, fromId, parts, userId) {
  const want = new Set((Array.isArray(parts) && parts.length ? parts : ['info', 'eot_vo', 'lines', 'boq']).map(String));
  if (contractId === fromId) throw new DprError('Choose another contract to copy from.');
  return C.inTransaction(async (conn) => {
    await C.getContractRow(conn, contractId);
    const src = await C.getContractRow(conn, fromId);
    const done = {};
    if (want.has('info')) {
      const keys = ['company_name', 'project_name', 'project_code', 'agreement_no', 'client', 'consultant', 'main_contractor',
        'location', 'currency', 'contract_value', 'commencement_date', 'original_completion', 'hrs_mp', 'hrs_pl',
        'prepared_by', 'reviewed_by', 'consultant_rep', 'report_prefix', 'tf_site_ids', 'eq_site_ids', 'sections'];
      const vals = keys.map((k) => (['tf_site_ids', 'eq_site_ids', 'sections'].includes(k) ? (src[k] === null ? null : JSON.stringify(C.json(src[k]))) : src[k]));
      await conn.query(`UPDATE dpr_contracts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by_user_id = ? WHERE contract_id = ?`,
        [...vals, userId, contractId]);
      done.info = true;
    }
    const empty = async (table, extra = '') => {
      const [[x]] = await conn.query(`SELECT COUNT(*) AS n FROM ${table} WHERE contract_id = ? ${extra}`, [contractId]);
      return Number(x.n) === 0;
    };
    if (want.has('eot_vo')) {
      if (!(await empty('dpr_eot_vo', 'AND is_deleted = 0'))) throw new DprError('This contract already has VO / EOT entries: nothing copied.', 409);
      const [r] = await conn.query(
        `INSERT INTO dpr_eot_vo (contract_id, sort_order, description, ref_no, type, days_granted, value, approval_date, status)
         SELECT ?, sort_order, description, ref_no, type, days_granted, value, approval_date, status
           FROM dpr_eot_vo WHERE contract_id = ? AND is_deleted = 0`, [contractId, fromId]);
      done.eot_vo = r.affectedRows;
    }
    if (want.has('lines')) {
      if (!(await empty('dpr_lines'))) throw new DprError('This contract already has resource lines: nothing copied.', 409);
      const [r] = await conn.query(
        `INSERT INTO dpr_lines (contract_id, kind, sort_order, name, category, ownership, subcontractor, res_type, scope, source_map, opening_days, is_active)
         SELECT ?, kind, sort_order, name, category, ownership, subcontractor, res_type, scope, source_map, 0, is_active
           FROM dpr_lines WHERE contract_id = ?`, [contractId, fromId]);
      done.lines = r.affectedRows;
    }
    if (want.has('boq')) {
      if (!(await empty('dpr_boq'))) throw new DprError('This contract already has a BOQ: nothing copied.', 409);
      const [r] = await conn.query(
        `INSERT INTO dpr_boq (contract_id, sort_order, item_no, description, unit, contract_qty, rate, opening_qty, remarks, is_active)
         SELECT ?, sort_order, item_no, description, unit, contract_qty, rate, 0, remarks, is_active
           FROM dpr_boq WHERE contract_id = ?`, [contractId, fromId]);
      done.boq = r.affectedRows;
    }
    await C.logChange(conn, { contractId, entity: 'setup', field: 'copy_from', oldValue: null, newValue: { from: src.code, ...done }, userId });
    return done;
  });
}

module.exports = {
  contractOut, listContracts, createContract, updateContract,
  listEotVo, saveEotVo, deleteEotVo,
  lineOut, listLines, saveLine, setLineActive, reorderLines,
  boqOut, listBoq, saveBoq, importBoq,
  getSetup, copySetup,
};
