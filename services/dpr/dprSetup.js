// services/dpr/dprSetup.js
//
// One-time setup of each contract (the workbook's Setup sheet): contract
// information, VO / EOT log, trades, plant, subcontractor lines, BOQ, and
// which Team Flow / Equipment sites and names feed each line.
// Each contract is independent: nothing is shared between contracts.
'use strict';

const pool = require('../../config/db');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const C = require('./dprCommon');
const S = require('./dprSources');
const UL = require('./dprUccLayout');

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
    // v2 (client's form)
    template: r.template === 'dpr' ? 'dpr' : 'ucc',
    form: UL.form(r.form),
    system_start_date: r.system_start_date || null,
    count_mode: S.COUNT_MODES.includes(r.count_mode) ? r.count_mode : 'recorded',
    auto_rows: r.auto_rows === undefined || r.auto_rows === null ? true : Number(r.auto_rows) === 1,
    section_links: cleanLinks(r.section_links, Number(r.contract_id)),
    layout: UL.clean(r.layout),
    lists: UL.lists(r.lists),
    updated_at: r.updated_at,
  };
}

/** { section: contract_id } for the sections that follow another contract. */
function cleanLinks(raw, selfId) {
  const r = C.json(raw) || {};
  const out = {};
  for (const k of UL.LINKABLE) {
    const v = Number(r[k]);
    if (Number.isInteger(v) && v > 0 && v !== selfId) out[k] = v;
  }
  return out;
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
  // v2
  if (b.template !== undefined) out.template = C.oneOf(b.template, ['ucc', 'dpr'], { label: 'Report form', required: true });
  if (b.form !== undefined) out.form = JSON.stringify(UL.form(b.form));
  if (b.system_start_date !== undefined) out.system_start_date = C.date(b.system_start_date, { label: 'System start date' });
  if (b.count_mode !== undefined) out.count_mode = C.oneOf(b.count_mode, S.COUNT_MODES, { label: 'Counting of attendance', required: true });
  if (b.auto_rows !== undefined) out.auto_rows = C.bool(b.auto_rows) ? 1 : 0;
  if (b.section_links !== undefined) out.section_links = JSON.stringify(b.section_links && typeof b.section_links === 'object' ? b.section_links : {});
  if (b.layout !== undefined) out.layout = b.layout === null ? null : JSON.stringify(UL.clean(b.layout));
  if (b.lists !== undefined) out.lists = JSON.stringify(UL.lists(b.lists));
  return out;
}

/** A section can follow ONE other existing contract, which itself does not follow anyone for it. */
async function checkLinks(conn, contractId, linksJson) {
  const links = cleanLinks(linksJson, contractId);
  for (const [sec, other] of Object.entries(links)) {
    const [[o]] = await conn.query('SELECT contract_id, code, section_links FROM dpr_contracts WHERE contract_id = ?', [other]);
    if (!o) throw new DprError('The contract to follow does not exist.');
    const theirs = cleanLinks(o.section_links, other);
    if (theirs[sec]) throw new DprError(`Contract ${o.code} itself follows another contract for "${sec}": link to that contract instead.`, 409);
  }
  const [followers] = await conn.query('SELECT code, section_links FROM dpr_contracts WHERE contract_id <> ?', [contractId]);
  for (const f of followers) {
    const theirs = cleanLinks(f.section_links, 0);
    for (const sec of Object.keys(links)) {
      if (theirs[sec] === contractId) throw new DprError(`Contract ${f.code} follows this contract for "${sec}": this one cannot follow another for it.`, 409);
    }
  }
  return JSON.stringify(links);
}

function checkDates(row) {
  if (row.commencement_date && row.original_completion && row.original_completion < row.commencement_date) {
    throw new DprError('The original completion date cannot be before the commencement date.');
  }
}

async function createContract(body, userId) {
  const f = contractFields(body || {}, { creating: true });
  delete f.section_links; // links are set once both contracts exist
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
    if (f.section_links !== undefined) f.section_links = await checkLinks(conn, contractId, f.section_links);
    const cols = Object.keys(f);
    if (cols.length) {
      await conn.query(
        `UPDATE dpr_contracts SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_by_user_id = ? WHERE contract_id = ?`,
        [...cols.map((k) => f[k]), userId, contractId]);
      const after = await C.getContractRow(conn, contractId);
      const norm = (r) => ({ ...r, tf_site_ids: JSON.stringify(C.json(r.tf_site_ids)), eq_site_ids: JSON.stringify(C.json(r.eq_site_ids)),
        copy_from_ids: JSON.stringify(C.json(r.copy_from_ids)), sections: JSON.stringify(C.json(r.sections)),
        form: JSON.stringify(C.json(r.form)), section_links: JSON.stringify(C.json(r.section_links)),
        layout: JSON.stringify(C.json(r.layout)), lists: JSON.stringify(C.json(r.lists)) });
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
const LINE_KINDS = ['trade', 'plant', 'subcon', 'staff', 'tool'];
const KIND_LABEL = { trade: 'Trade', plant: 'Equipment', subcon: 'Resource', staff: 'Position', tool: 'Tool' };

function lineFields(b, kind, template = 'dpr') {
  const f = {
    name: C.line(b.name, 200, { required: true, label: KIND_LABEL[kind] || 'Name' }),
    sort_order: C.integer(b.sort_order, { label: 'Order', min: 0, max: 100000 }) || 0,
    category: null, ownership: null, subcontractor: null, res_type: null, scope: null,
    source_map: JSON.stringify(S.cleanMap(b.source_map)),
    opening_days: C.decimal(b.opening_days, { label: 'Opening days', min: 0, max: 9999999999, places: 2 }) || '0',
    is_active: b.is_active === undefined ? 1 : (C.bool(b.is_active) ? 1 : 0),
  };
  // the DPR workbook needs a category / ownership; the client's form does not
  if (kind === 'trade') f.category = C.line(b.category, 60, { required: template === 'dpr', label: 'Category' });
  if (kind === 'staff') f.category = C.line(b.category, 60, { label: 'Category' }) || 'Staff';
  if (kind === 'plant' || kind === 'tool') f.ownership = C.oneOf(b.ownership, C.LISTS.ownership, { required: template === 'dpr' && kind === 'plant', label: 'Ownership' });
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
      ORDER BY FIELD(kind, 'staff', 'trade', 'plant', 'tool', 'subcon'), sort_order, line_id`, [contractId]);
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
    for (const n of map.sp || []) {
      if ((other.sp || []).some((x) => S.norm(x) === S.norm(n))) throw new DprError(`Staff position "${n}" is already counted on the line "${r.name}".`, 409);
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
    const crow = await C.getContractRow(conn, contractId);
    let before = null;
    let kind = b.kind;
    if (lineId) {
      [[before]] = await conn.query('SELECT * FROM dpr_lines WHERE line_id = ? AND contract_id = ?', [lineId, contractId]);
      if (!before) throw new DprError('Line not found.', 404);
      kind = before.kind;
    } else {
      kind = C.oneOf(kind, LINE_KINDS, { required: true, label: 'Line kind' });
    }
    const f = lineFields(b, kind, crow.template === 'dpr' ? 'dpr' : 'ucc');
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
  const k = C.oneOf(kind, LINE_KINDS, { required: true, label: 'Line kind' });
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
// v2: a BOQ row is an ITEM (quantities), a SECTION heading or a TEXT row (scope text),
// in the main BOQ (group '') or in another group (e.g. ADDITIONAL WORKS).
const ROW_TYPES = ['item', 'section', 'text'];
function boqOut(r) {
  return {
    boq_id: Number(r.boq_id), sort_order: Number(r.sort_order), item_no: r.item_no, description: r.description,
    unit: r.unit || '', contract_qty: r.contract_qty, rate: r.rate, opening_qty: r.opening_qty, remarks: r.remarks || '',
    is_active: Number(r.is_active) === 1,
    row_type: ROW_TYPES.includes(r.row_type) ? r.row_type : 'item',
    group_name: r.group_name || '',
    task_code: r.task_code || '',
    cost_code: r.cost_code || '',
    budget: r.budget === undefined ? null : r.budget,
  };
}
function boqFields(b) {
  const rowType = C.oneOf(b.row_type, ROW_TYPES, { label: 'Row type' }) || 'item';
  const isItem = rowType === 'item';
  const num = (v, label) => (isItem ? C.decimal(v, { label, min: 0, max: 99999999999999, places: 4 }) : null);
  const headingQty = isItem ? null : C.decimal(b.contract_qty, { label: 'Quantity', min: 0, max: 99999999999999, places: 4 });
  return {
    row_type: rowType,
    group_name: C.line(b.group_name, 100, { label: 'Group' }) || '',
    item_no: isItem ? C.line(b.item_no, 50, { required: true, label: 'Item No.' }) : (C.line(b.item_no, 50, { label: 'Item No.' }) || null),
    task_code: C.line(b.task_code, 50, { label: 'Task code' }),
    cost_code: C.line(b.cost_code, 50, { label: 'Cost code' }),
    description: C.text(b.description, 1000, { required: true, label: 'Description' }),
    unit: C.line(b.unit, 30, { label: 'Unit' }),
    contract_qty: isItem ? num(b.contract_qty, 'Contract Qty') : headingQty,
    budget: num(b.budget, 'Budget'),
    rate: num(b.rate, 'Rate'),
    opening_qty: (isItem ? C.decimal(b.opening_qty, { label: 'Done before the system', min: -99999999999999, max: 99999999999999, places: 4 }) : null) || '0',
    remarks: C.line(b.remarks, 500, { label: 'Remarks' }),
    sort_order: C.integer(b.sort_order, { label: 'Order', min: 0, max: 100000 }) || 0,
    is_active: b.is_active === undefined ? 1 : (C.bool(b.is_active) ? 1 : 0),
  };
}
const BOQ_FIELDS = ['item_no', 'description', 'unit', 'contract_qty', 'rate', 'opening_qty', 'remarks', 'sort_order', 'is_active',
  'row_type', 'group_name', 'task_code', 'cost_code', 'budget'];

async function listBoq(contractId, { activeOnly = false } = {}) {
  const [rows] = await pool.query(
    `SELECT * FROM dpr_boq WHERE contract_id = ? ${activeOnly ? 'AND is_active = 1' : ''} ORDER BY sort_order, boq_id`, [contractId]);
  return rows.map(boqOut);
}

/** Headings / text rows get an internal number (the Item No. is unique per contract). */
async function internalNo(conn, contractId) {
  for (;;) {
    const n = `#${crypto.randomBytes(4).toString('hex')}`;
    const [[x]] = await conn.query('SELECT boq_id FROM dpr_boq WHERE contract_id = ? AND item_no = ?', [contractId, n]);
    if (!x) return n;
  }
}

async function saveBoqItem(conn, contractId, boqId, f, userId) {
  let before = null;
  let rowId = boqId;
  if (rowId) {
    [[before]] = await conn.query('SELECT * FROM dpr_boq WHERE boq_id = ? AND contract_id = ?', [rowId, contractId]);
    if (!before) throw new DprError('BOQ item not found.', 404);
    if (before.row_type !== f.row_type && f.row_type !== 'item') {
      const [[used]] = await conn.query('SELECT COUNT(*) AS n FROM dpr_activities WHERE boq_id = ? AND is_deleted = 0', [rowId]);
      if (Number(used.n)) throw new DprError('This BOQ item has activities: it cannot become a heading or a text row.', 409);
    }
    if (!f.item_no) f.item_no = before.row_type === 'item' ? await internalNo(conn, contractId) : before.item_no;
    await conn.query(`UPDATE dpr_boq SET ${BOQ_FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE boq_id = ?`, [...BOQ_FIELDS.map((k) => f[k]), rowId]);
  } else {
    if (!f.sort_order) {
      const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dpr_boq WHERE contract_id = ?', [contractId]);
      f.sort_order = Number(mx.n);
    }
    if (!f.item_no) f.item_no = await internalNo(conn, contractId);
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

/** Moves a BOQ row (headings and text rows included) to a new position. */
async function reorderBoq(contractId, orderedIds, userId) {
  const list = C.ids(orderedIds, 5000);
  return C.inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT boq_id FROM dpr_boq WHERE contract_id = ?', [contractId]);
    const known = new Set(rows.map((r) => Number(r.boq_id)));
    if (list.some((x) => !known.has(x))) throw new DprError('Unknown BOQ row in the new order.');
    let i = 1;
    for (const id of list) {
      await conn.query('UPDATE dpr_boq SET sort_order = ? WHERE boq_id = ?', [i, id]);
      i += 1;
    }
    await C.logChange(conn, { contractId, entity: 'boq', field: 'order', oldValue: null, newValue: list.join(','), userId });
    return listBoq(contractId);
  });
}

/** Removes a heading / text row, or an item that was never used in an activity. */
async function deleteBoqRow(contractId, boqId, userId) {
  return C.inTransaction(async (conn) => {
    const [[r]] = await conn.query('SELECT * FROM dpr_boq WHERE boq_id = ? AND contract_id = ?', [boqId, contractId]);
    if (!r) throw new DprError('BOQ row not found.', 404);
    const [[used]] = await conn.query('SELECT COUNT(*) AS n FROM dpr_activities WHERE boq_id = ?', [boqId]);
    if (Number(used.n)) throw new DprError('This BOQ item is used in activities: switch it off (Active) instead of deleting it.', 409);
    await conn.query('DELETE FROM dpr_boq WHERE boq_id = ?', [boqId]);
    await C.logChange(conn, { contractId, entity: 'boq', entityId: boqId, field: 'deleted', oldValue: { item_no: r.item_no, description: r.description }, newValue: null, userId });
    return { deleted: true };
  });
}

/**
 * BOQ from an Excel file (first sheet). Header row with at least "Description" and one of
 * "Item No." / "Task Code" / "Bill Item" / "Sr. No."; optional: "Row type" (item / section /
 * text), "Group", "Cost Code", "Unit", "Qty" / "Contract Qty" / "Quantity", "Budget", "Rate",
 * "Done before" / "Opening" / "Cumul before", "Remarks". A row without number is a heading
 * (bold) or a text row. Items with the same number are updated, new ones added; headings and
 * text rows are replaced by the file's ones. The order of the file is kept. All or nothing.
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
    row.eachCell((c, cn) => { names[cn] = cellText(c).trim().toLowerCase().replace(/\s+/g, ' '); });
    const find = (...keys) => Number(Object.keys(names).find((k) => keys.some((x) => names[k] === x || names[k].startsWith(x))) || 0);
    const item = find('item no', 'task code', 'bill item', 'item', 'boq item', 'sr. no', 'sr no');
    const desc = find('description');
    if (item && desc) {
      header = rn;
      cols = {
        item, desc, type: find('row type', 'type'), group: find('group'), cost: find('cost code'), unit: find('unit'),
        qty: find('contract qty', 'qty', 'quantity'), budget: find('budget'), rate: find('rate'),
        opening: find('done before', 'opening', 'cumul before', 'cumulative before'), remarks: find('remarks'),
      };
    }
  });
  if (!header) throw new DprError('Header row not found: the sheet needs the columns "Item No." (or "Task Code") and "Description".');
  const rows = [];
  const errors = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= header) return;
    const get = (c) => (c ? cellText(row.getCell(c)).trim() : '');
    const itemNo = get(cols.item);
    const desc = get(cols.desc);
    if (!itemNo && !desc) return;
    if (/^total/i.test(itemNo) || /^total/i.test(desc)) return;
    let type = get(cols.type).toLowerCase();
    if (!['item', 'section', 'text'].includes(type)) {
      if (itemNo) type = 'item';
      else type = row.getCell(cols.desc).font && row.getCell(cols.desc).font.bold ? 'section' : 'text';
    }
    try {
      rows.push(boqFields({
        row_type: type, group_name: get(cols.group), item_no: type === 'item' ? itemNo : null,
        cost_code: get(cols.cost), description: desc || itemNo, unit: get(cols.unit), contract_qty: get(cols.qty),
        budget: get(cols.budget), rate: get(cols.rate), opening_qty: get(cols.opening), remarks: get(cols.remarks), sort_order: rows.length + 1,
      }));
      rows[rows.length - 1].has_opening = Boolean(cols.opening && get(cols.opening) !== '');
    } catch (e) {
      errors.push(`Row ${rn}: ${e.message}`);
    }
  });
  if (errors.length) throw new DprError(`Nothing imported. ${errors.slice(0, 10).join(' ')}`);
  if (!rows.length) throw new DprError('No BOQ row found under the header row.');
  const seen = new Set();
  for (const it of rows.filter((x) => x.row_type === 'item')) {
    const k = it.item_no.toLowerCase();
    if (seen.has(k)) throw new DprError(`Nothing imported. Item No. "${it.item_no}" appears twice in the file.`);
    seen.add(k);
  }
  return C.inTransaction(async (conn) => {
    await C.getContractRow(conn, contractId);
    let added = 0;
    let updated = 0;
    let headings = 0;
    const [oldRows] = await conn.query("SELECT boq_id FROM dpr_boq WHERE contract_id = ? AND row_type <> 'item'", [contractId]);
    if (oldRows.length) await conn.query("DELETE FROM dpr_boq WHERE contract_id = ? AND row_type <> 'item'", [contractId]);
    const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM dpr_boq WHERE contract_id = ?', [contractId]);
    let order = 0;
    const base = Number(mx.n) + 1000; // the file's rows first, then the items not in the file keep their order after them
    for (const it of rows) {
      order += 1;
      it.sort_order = order;
      const hasOpening = it.has_opening;
      delete it.has_opening;
      if (it.row_type !== 'item') {
        await saveBoqItem(conn, contractId, null, it, userId);
        headings += 1;
        continue;
      }
      const [[ex]] = await conn.query('SELECT boq_id, opening_qty FROM dpr_boq WHERE contract_id = ? AND item_no = ?', [contractId, it.item_no]);
      if (ex) {
        if (!hasOpening) it.opening_qty = ex.opening_qty;
        updated += 1;
      } else {
        added += 1;
      }
      await saveBoqItem(conn, contractId, ex ? Number(ex.boq_id) : null, it, userId);
    }
    // items of the contract that are not in the file: after the file's rows, same relative order
    const fileItems = rows.filter((x) => x.row_type === 'item').map((x) => x.item_no.toLowerCase());
    const [rest] = await conn.query("SELECT boq_id, item_no FROM dpr_boq WHERE contract_id = ? AND row_type = 'item' ORDER BY sort_order, boq_id", [contractId]);
    let tail = 0;
    for (const r of rest) {
      if (fileItems.includes(String(r.item_no).toLowerCase())) continue;
      tail += 1;
      await conn.query('UPDATE dpr_boq SET sort_order = ? WHERE boq_id = ?', [base + tail, r.boq_id]);
    }
    await C.logChange(conn, { contractId, entity: 'boq', field: 'import', oldValue: null, newValue: { added, updated, headings }, userId });
    return { added, updated, headings, total: rows.length };
  });
}

// ------------------------------------------------------------------ areas (bridges...) with their own pages
function areaOut(r) {
  return { area_id: Number(r.area_id), name: r.name, sort_order: Number(r.sort_order), is_active: Number(r.is_active) === 1 };
}
async function listAreas(contractId) {
  const [rows] = await pool.query('SELECT * FROM dpr_areas WHERE contract_id = ? ORDER BY sort_order, area_id', [contractId]);
  return rows.map(areaOut);
}
async function saveArea(contractId, areaId, body, userId) {
  const b = body || {};
  const f = {
    name: C.line(b.name, 150, { required: true, label: 'Area name' }),
    sort_order: C.integer(b.sort_order, { label: 'Order', min: 0, max: 100000 }) || 0,
    is_active: b.is_active === undefined ? 1 : (C.bool(b.is_active) ? 1 : 0),
  };
  return C.inTransaction(async (conn) => {
    await C.getContractRow(conn, contractId);
    let before = null;
    let id = areaId;
    if (id) {
      [[before]] = await conn.query('SELECT * FROM dpr_areas WHERE area_id = ? AND contract_id = ?', [id, contractId]);
      if (!before) throw new DprError('Area not found.', 404);
      await conn.query('UPDATE dpr_areas SET name = ?, sort_order = ?, is_active = ? WHERE area_id = ?', [f.name, f.sort_order || before.sort_order, f.is_active, id]);
    } else {
      if (!f.sort_order) {
        const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dpr_areas WHERE contract_id = ?', [contractId]);
        f.sort_order = Number(mx.n);
      }
      const [ins] = await conn.query('INSERT INTO dpr_areas (contract_id, name, sort_order, is_active) VALUES (?, ?, ?, ?)', [contractId, f.name, f.sort_order, f.is_active]);
      id = ins.insertId;
    }
    const [[after]] = await conn.query('SELECT * FROM dpr_areas WHERE area_id = ?', [id]);
    await C.logRowChanges(conn, { contractId, entity: 'area', entityId: id, userId }, before, after, ['name', 'sort_order', 'is_active']);
    return areaOut(after);
  });
}

// ------------------------------------------------------------------ fixed pages (cover, maps...)
function pageOut(r) {
  return { page_id: Number(r.page_id), sort_order: Number(r.sort_order), title: r.title || '', file_name: r.file_name, content_type: r.content_type, is_active: Number(r.is_active) === 1 };
}
async function listFixedPages(contractId, { activeOnly = false } = {}) {
  const [rows] = await pool.query(
    `SELECT * FROM dpr_fixed_pages WHERE contract_id = ? ${activeOnly ? 'AND is_active = 1' : ''} ORDER BY sort_order, page_id`, [contractId]);
  return rows.map(pageOut);
}
async function addFixedPage(contractId, fileName, contentType, body, userId) {
  const title = C.line((body || {}).title, 200, { label: 'Title' });
  return C.inTransaction(async (conn) => {
    await C.getContractRow(conn, contractId);
    const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dpr_fixed_pages WHERE contract_id = ?', [contractId]);
    const [ins] = await conn.query(
      'INSERT INTO dpr_fixed_pages (contract_id, sort_order, title, file_name, content_type, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
      [contractId, Number(mx.n), title, fileName, contentType, userId]);
    await C.logChange(conn, { contractId, entity: 'fixed_page', entityId: ins.insertId, field: 'added', oldValue: null, newValue: title || fileName, userId });
    const [[r]] = await conn.query('SELECT * FROM dpr_fixed_pages WHERE page_id = ?', [ins.insertId]);
    return pageOut(r);
  });
}
async function updateFixedPage(contractId, pageId, body, userId) {
  const b = body || {};
  return C.inTransaction(async (conn) => {
    const [[before]] = await conn.query('SELECT * FROM dpr_fixed_pages WHERE page_id = ? AND contract_id = ?', [pageId, contractId]);
    if (!before) throw new DprError('Page not found.', 404);
    const f = {
      title: b.title === undefined ? before.title : C.line(b.title, 200, { label: 'Title' }),
      sort_order: b.sort_order === undefined ? before.sort_order : (C.integer(b.sort_order, { label: 'Order', min: 0, max: 100000 }) || 0),
      is_active: b.is_active === undefined ? before.is_active : (C.bool(b.is_active) ? 1 : 0),
    };
    await conn.query('UPDATE dpr_fixed_pages SET title = ?, sort_order = ?, is_active = ? WHERE page_id = ?', [f.title, f.sort_order, f.is_active, pageId]);
    const [[after]] = await conn.query('SELECT * FROM dpr_fixed_pages WHERE page_id = ?', [pageId]);
    await C.logRowChanges(conn, { contractId, entity: 'fixed_page', entityId: pageId, userId }, before, after, ['title', 'sort_order', 'is_active']);
    return pageOut(after);
  });
}
async function fixedPageFile(contractId, pageId) {
  const [[p]] = await pool.query('SELECT file_name, content_type FROM dpr_fixed_pages WHERE page_id = ? AND contract_id = ?', [pageId, contractId]);
  if (!p) throw new DprError('Page not found.', 404);
  return p;
}

// ------------------------------------------------------------------ the client's lists in one click
/**
 * Adds the rows of the client's form (staff positions, tradesmen, plant, tools) that the
 * contract does not have yet. A row whose name is a Team Flow position / staff position /
 * equipment type is counted from that system automatically; the others are typed.
 */
async function loadDefaultLines(contractId, kinds, userId) {
  const want = (Array.isArray(kinds) && kinds.length ? kinds : Object.keys(UL.UCC_DEFAULT_LINES)).filter((k) => UL.UCC_DEFAULT_LINES[k]);
  const opts = await S.sourceOptions({});
  const staffPos = await S.staffPositions();
  const tfNames = new Map(opts.tf_positions.filter((p) => p.workers > 0).map((p) => [S.norm(p.name), p.name]));
  const spNames = new Map(staffPos.map((p) => [S.norm(p.name), p.name]));
  const eqNames = new Map((opts.eq_types || []).map((t) => [S.norm(t.type_name), t.type_name]));
  return C.inTransaction(async (conn) => {
    const crow = await C.getContractRow(conn, contractId);
    const template = crow.template === 'dpr' ? 'dpr' : 'ucc';
    const added = {};
    for (const kind of want) {
      const [have] = await conn.query('SELECT line_id, name, source_map, is_active FROM dpr_lines WHERE contract_id = ? AND kind = ?', [contractId, kind]);
      const haveNames = new Set(have.map((h) => S.norm(h.name)));
      const [[mx]] = await conn.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM dpr_lines WHERE contract_id = ? AND kind = ?', [contractId, kind]);
      let order = Number(mx.n);
      let n = 0;
      for (const name of UL.UCC_DEFAULT_LINES[kind]) {
        if (haveNames.has(S.norm(name))) continue;
        const map = { tf: [], eq: [] };
        if (kind === 'trade' && tfNames.has(S.norm(name))) map.tf.push(tfNames.get(S.norm(name)));
        if (kind === 'staff' && spNames.has(S.norm(name))) map.sp = [spNames.get(S.norm(name))];
        if ((kind === 'plant' || kind === 'tool') && eqNames.has(S.norm(name))) map.eq.push({ type: eqNames.get(S.norm(name)), vendor: null });
        const f = lineFields({ name, source_map: map, category: kind === 'staff' ? 'Staff' : null, ownership: null }, kind, template);
        try {
          await checkMapUnique(conn, contractId, null, f.source_map);
        } catch (_) {
          f.source_map = JSON.stringify({ tf: [], eq: [] }); // already counted on another row: keep the row, typed
        }
        order += 1;
        f.sort_order = order;
        const [ins] = await conn.query(
          `INSERT INTO dpr_lines (contract_id, kind, ${LINE_FIELDS.join(', ')}) VALUES (?, ?, ${LINE_FIELDS.map(() => '?').join(', ')})`,
          [contractId, kind, ...LINE_FIELDS.map((k) => f[k])]);
        await C.logChange(conn, { contractId, entity: 'line', entityId: ins.insertId, field: 'create', oldValue: null, newValue: { kind, name }, userId });
        n += 1;
      }
      added[kind] = n;
    }
    return added;
  });
}

// ------------------------------------------------------------------ full setup + copy
async function getSetup(contractId) {
  const [[row]] = await pool.query('SELECT * FROM dpr_contracts WHERE contract_id = ?', [contractId]);
  if (!row) throw new DprError('Contract not found.', 404);
  const [eot, lines, boq, areas, pages] = await Promise.all([listEotVo(contractId), listLines(contractId), listBoq(contractId),
    listAreas(contractId), listFixedPages(contractId)]);
  const contract = contractOut(row);
  const approved = eot.filter((x) => x.status === 'Approved');
  return {
    contract,
    eot_vo: eot,
    lines,
    boq,
    areas,
    fixed_pages: pages,
    lists: C.LISTS,
    sections: C.SECTIONS,
    ours_sections: C.OURS_SECTIONS,
    ucc: { sections: UL.SECTIONS, layout: UL.effective(contract.layout, null), linkable: UL.LINKABLE, count_modes: S.COUNT_MODES,
      form_defaults: UL.FORM_DEFAULTS, list_defaults: UL.LIST_DEFAULTS },
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
        'prepared_by', 'reviewed_by', 'consultant_rep', 'report_prefix', 'tf_site_ids', 'eq_site_ids', 'sections',
        'template', 'form', 'system_start_date', 'count_mode', 'auto_rows', 'layout', 'lists'];
      const JSONS = ['tf_site_ids', 'eq_site_ids', 'sections', 'form', 'layout', 'lists'];
      const vals = keys.map((k) => (JSONS.includes(k) ? (src[k] === null || src[k] === undefined ? null : JSON.stringify(C.json(src[k]))) : src[k]));
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
        `INSERT INTO dpr_boq (contract_id, sort_order, item_no, description, unit, contract_qty, rate, opening_qty, remarks, is_active,
                              row_type, group_name, task_code, cost_code, budget)
         SELECT ?, sort_order, item_no, description, unit, contract_qty, rate, 0, remarks, is_active, row_type, group_name, task_code, cost_code, budget
           FROM dpr_boq WHERE contract_id = ?`, [contractId, fromId]);
      done.boq = r.affectedRows;
    }
    if (want.has('areas')) {
      const [[x]] = await conn.query('SELECT COUNT(*) AS n FROM dpr_areas WHERE contract_id = ?', [contractId]);
      if (Number(x.n)) throw new DprError('This contract already has areas: nothing copied.', 409);
      const [r] = await conn.query(
        'INSERT INTO dpr_areas (contract_id, name, sort_order, is_active) SELECT ?, name, sort_order, is_active FROM dpr_areas WHERE contract_id = ?',
        [contractId, fromId]);
      done.areas = r.affectedRows;
    }
    await C.logChange(conn, { contractId, entity: 'setup', field: 'copy_from', oldValue: null, newValue: { from: src.code, ...done }, userId });
    return done;
  });
}

module.exports = {
  contractOut, cleanLinks, listContracts, createContract, updateContract,
  listEotVo, saveEotVo, deleteEotVo,
  LINE_KINDS, lineOut, lineFields, LINE_FIELDS, checkMapUnique, listLines, saveLine, setLineActive, reorderLines, loadDefaultLines,
  boqOut, listBoq, saveBoq, importBoq, reorderBoq, deleteBoqRow,
  listAreas, saveArea, listFixedPages, addFixedPage, updateFixedPage, fixedPageFile,
  getSetup, copySetup,
};
