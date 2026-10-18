// services/dpr/dprUccXlsx.js
//
// The daily report in the client's form as an Excel file (same content and layout
// choices as the PDF): sheet "Daily Report" (header, weather, manpower, plant,
// activities, materials, WIR, remarks), sheet "Overall Progress" (BOQ) and one sheet
// per area page. Numbers are written as exact values (never rounded).
'use strict';

const ExcelJS = require('exceljs');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(d) {
  if (!d) return '';
  const [y, m, dd] = String(d).slice(0, 10).split('-');
  return `${dd}-${MONTHS[Number(m) - 1]}-${y}`;
}
const L = (m) => m.layout || { sections: {}, tables: {}, columns: {}, titles: {}, hide_empty: {} };
const secOn = (m, k) => L(m).sections[k] !== false;
const tabOn = (m, k) => L(m).tables[k] !== false;
const colOn = (m, t, c) => L(m).columns[`${t}.${c}`] !== false;
const title = (m, k, d) => (L(m).titles[k] === undefined ? d : L(m).titles[k]);
const sub = (m, s, area = '') => String(s || '').replace(/\{code\}/g, m.contract.code).replace(/\{area\}/g, area);
/** exact number when the value is a plain decimal, else the text */
const val = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return /^-?\d+(\.\d+)?$/.test(s) && s.replace(/^-/, '').replace('.', '').length <= 15 ? Number(s) : s;
};
const cv = (c) => (c ? val(c.v) : null);

const THIN = { style: 'thin', color: { argb: 'FF7F7F7F' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEAD = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7E6E6' } };
const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
const LABEL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8C8C46' } };
const SECTION = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };

function writeRow(ws, r, values, { bold = false, fill = null, border = true, align = null, wrap = true } = {}) {
  const row = ws.getRow(r);
  values.forEach((v, i) => {
    const c = row.getCell(i + 1);
    c.value = v === undefined ? null : v;
    c.font = { name: 'Arial', size: 9, bold };
    if (fill) c.fill = fill;
    if (border) c.border = BORDER;
    c.alignment = { vertical: 'middle', wrapText: wrap, horizontal: align || (typeof v === 'number' ? 'right' : 'left') };
  });
  return r + 1;
}
function bar(ws, r, text, width) {
  if (!text) return r;
  ws.mergeCells(r, 1, r, width);
  const c = ws.getCell(r, 1);
  c.value = text;
  c.font = { name: 'Arial', size: 10, bold: true };
  c.fill = GREY;
  c.alignment = { horizontal: 'center' };
  c.border = BORDER;
  return r + 1;
}

function header(ws, m, meta, width) {
  const H = m.header;
  ws.mergeCells(1, 1, 1, width);
  const t = ws.getCell(1, 1);
  t.value = `${H.system_title} · ${H.department} · ${H.form_title}`;
  t.font = { name: 'Arial', size: 12, bold: true };
  ws.mergeCells(2, 1, 2, width);
  ws.getCell(2, 1).value = `Document Reference ${H.doc_ref}   Rev. No. ${H.rev_no}   Rev. Date ${H.rev_date ? fmtDate(H.rev_date) : ''}   Rep. Date ${fmtDate(H.report_date)}`
    + `${meta.issued ? `   Issued ${meta.issued_at || ''}${meta.revision ? ` Rev.${meta.revision}` : ''}` : '   DRAFT'}`;
  ws.getCell(2, 1).font = { name: 'Arial', size: 9, color: { argb: meta.issued ? 'FF000000' : 'FFC00000' } };
  return 4;
}

function addMainSheet(wb, m, meta) {
  const ws = wb.addWorksheet('Daily Report', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 30 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 30 }, { width: 11 }, { width: 11 }, { width: 11 }];
  const H = m.header;
  let r = header(ws, m, meta, 8);
  if (secOn(m, 'project')) {
    const rows = [
      ['Project Ref.', H.project_ref, 'Contract', H.contract_ref], ['Project Name', H.project_name, 'Project Location', H.project_location],
      ['Client', H.client, 'Commencement Date', fmtDate(H.commencement_date)], ['Consultant', H.consultant, 'Completion Date', fmtDate(H.completion_date)],
      ['Project Manager', H.project_manager, 'Report Date', fmtDate(H.report_date)],
    ];
    for (const x of rows) {
      ws.mergeCells(r, 2, r, 4);
      ws.mergeCells(r, 6, r, 8);
      writeRow(ws, r, [x[0], x[1] || '', null, null, x[2], x[3] || '', null, null]);
      for (const c of [1, 5]) { ws.getCell(r, c).fill = LABEL; ws.getCell(r, c).font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } }; }
      r += 1;
    }
    r += 1;
  }
  if (H.report_title) {
    ws.mergeCells(r, 1, r, 8);
    ws.getCell(r, 1).value = H.report_title;
    ws.getCell(r, 1).font = { name: 'Arial', size: 11, bold: true };
    ws.getCell(r, 1).alignment = { horizontal: 'center' };
    r += 2;
  }
  if (secOn(m, 'weather')) {
    const w = m.weather || {};
    r = bar(ws, r, title(m, 'weather', 'WEATHER'), 8);
    r = writeRow(ws, r, ['Weather', w.condition || '', 'Max', val(w.temp_max), 'Humidity', w.humidity_level || '', 'Min', val(w.temp_min)]);
    if (w.remarks) r = writeRow(ws, r, [w.remarks]);
    r += 1;
  }
  const pair = (leftKey, rightKey, leftHead, rightHead, fields, left, right) => {
    const lf = fields.filter((f) => colOn(m, leftKey, f[0]));
    const rf = fields.filter((f) => colOn(m, rightKey, f[0]));
    const lOn = tabOn(m, leftKey);
    const rOn = tabOn(m, rightKey);
    const headRow = [lOn ? title(m, `table.${leftKey}`, leftHead) : '', ...fields.map((f) => (lOn && lf.includes(f) ? title(m, `col.${leftKey}.${f[0]}`, f[1]) : '')),
      rOn ? title(m, `table.${rightKey}`, rightHead) : '', ...fields.map((f) => (rOn && rf.includes(f) ? title(m, `col.${rightKey}.${f[0]}`, f[1]) : ''))];
    r = writeRow(ws, r, headRow, { bold: true, fill: HEAD, align: 'center' });
    const hideL = L(m).hide_empty[leftKey] === true;
    const hideR = L(m).hide_empty[rightKey] === true;
    const keep = (rows, fs, hide) => rows.filter((x) => !hide || fs.some((f) => cv(x.cells[f[0]]) !== null));
    const lr = lOn ? keep(left.rows, lf, hideL) : [];
    const rr = rOn ? keep(right.rows, rf, hideR) : [];
    const n = Math.max(lr.length, rr.length);
    for (let i = 0; i < n; i += 1) {
      const a = lr[i];
      const b = rr[i];
      r = writeRow(ws, r, [a ? a.name : '', ...fields.map((f) => (a && lf.includes(f) ? cv(a.cells[f[0]]) : null)),
        b ? b.name : '', ...fields.map((f) => (b && rf.includes(f) ? cv(b.cells[f[0]]) : null))]);
    }
    r = writeRow(ws, r, [lOn ? 'TOTAL' : '', ...fields.map((f) => (lOn && lf.includes(f) ? cv(left.total[f[0]]) : null)),
      rOn ? 'TOTAL' : '', ...fields.map((f) => (rOn && rf.includes(f) ? cv(right.total[f[0]]) : null))], { bold: true, fill: HEAD });
  };
  const MPF = [['total', 'TOTAL'], ['present', 'PRESENT'], ['absent', 'ABSENT']];
  const PLF = [['operative', 'OPERATIVE'], ['breakdown', 'BREAKDOWN'], ['idle', 'IDLE']];
  if (secOn(m, 'manpower')) {
    r = bar(ws, r, title(m, 'manpower', ''), 8);
    pair('staff', 'trades', 'STAFF', 'TRADESMEN', MPF, m.manpower.staff, m.manpower.trades);
    const g = m.manpower.grand;
    r = writeRow(ws, r, ['GRAND TOTAL', cv(g.total), cv(g.present), cv(g.absent), '', '', '', ''], { bold: true, fill: HEAD });
    r += 1;
  }
  if (secOn(m, 'plant')) {
    r = bar(ws, r, title(m, 'plant', ''), 8);
    pair('plant', 'tools', 'PLANT', 'TOOL', PLF, m.plant.plant, m.plant.tools);
    r += 1;
  }
  if (secOn(m, 'activities') && tabOn(m, 'activities') && (m.activities || []).length) {
    r = bar(ws, r, title(m, 'activities', 'ACTIVITIES'), 8);
    r = writeRow(ws, r, ['No.', 'Description', 'Location', 'BOQ', 'Qty', 'Unit', 'Area', 'Chainage'], { bold: true, fill: HEAD, align: 'center' });
    m.activities.forEach((a, i) => {
      r = writeRow(ws, r, [i + 1, a.description, a.location, a.item_no, Number(a.qty) ? val(a.qty) : null, Number(a.qty) ? a.unit : '', a.area, a.chainage]);
    });
    r += 1;
  }
  if (secOn(m, 'materials') && tabOn(m, 'materials')) {
    r = bar(ws, r, title(m, 'materials', 'DELIVERED MATERIALS AT SITE'), 8);
    r = writeRow(ws, r, ['Material', 'Unit', 'Qty', 'Supplier', 'Delivery note / MAR', 'Bridge / Element', 'BOQ Ref.', 'Intended use'], { bold: true, fill: HEAD, align: 'center' });
    for (const x of m.materials || []) {
      r = writeRow(ws, r, [x.description, x.unit, val(x.qty), x.supplier, [x.delivery_note, x.mar_ref].filter(Boolean).join(' / '),
        [x.area, x.element].filter(Boolean).join(' / '), x.boq_ref, x.intended_use]);
    }
    r += 1;
  }
  if (secOn(m, 'wir') && tabOn(m, 'wir')) {
    r = bar(ws, r, title(m, 'wir', 'WORK INSPECTION REQUEST (WIR) REGISTER'), 8);
    r = writeRow(ws, r, ['WIR Ref.', 'Activity / Work Description', 'Bridge No.', 'Location / Chainage', 'MS Ref.', 'Status', 'Comments', ''], { bold: true, fill: HEAD, align: 'center' });
    for (const x of m.wir || []) {
      r = writeRow(ws, r, [x.ref_no, x.description, x.area, [x.location, x.chainage].filter(Boolean).join(' / '), x.ms_ref, x.result, x.remarks, '']);
    }
    r += 1;
  }
  const Hs = m.hse;
  if (secOn(m, 'hse') && Hs && Hs.filled) {
    r = bar(ws, r, title(m, 'hse', 'HEALTH, SAFETY & ENVIRONMENT'), 8);
    const grid = [
      ['Manpower on site today', Hs.manpower_today, 'Toolbox talk attendees', Hs.tbt_attendees, 'HSE inspections / audits today', Hs.hse_inspections_today],
      ['Incidents today', Hs.incidents_today, 'Near misses today', Hs.near_misses_today, 'First aid cases today', Hs.first_aid_today],
      ['LTI today', Hs.lti_today, 'PTWs issued today', Hs.ptws_today, 'LTI-free days', Hs.lti_free_days],
      ['Incidents to date', Hs.incidents_to_date, 'Near misses to date', Hs.near_misses_to_date, 'LTIs to date', Hs.ltis_to_date],
    ];
    for (const g of grid) r = writeRow(ws, r, [...g, '', '']);
    for (const [l, v] of [['Toolbox talk topic', Hs.tbt_topic], ['HSE observations & corrective actions', Hs.observations]]) {
      ws.mergeCells(r, 2, r, 8);
      r = writeRow(ws, r, [l, v]);
    }
    r += 1;
  }
  if (secOn(m, 'plan') && m.next_day_plan) {
    r = bar(ws, r, title(m, 'plan', 'PLANNED ACTIVITIES – NEXT WORKING DAY'), 8);
    ws.mergeCells(r, 1, r, 8);
    r = writeRow(ws, r, [m.next_day_plan]);
    r += 1;
  }
  const ncr = (m.ncr && m.ncr.entries) || [];
  if (secOn(m, 'ncr') && ncr.length) {
    r = bar(ws, r, title(m, 'ncr', 'NON-CONFORMANCE REPORTS – OPEN AS OF REPORT DATE'), 8);
    r = writeRow(ws, r, ['NCR No.', 'Date Raised', 'Description', 'Corrective Action', 'Responsible', 'Target Date', 'Status', 'Days Open'], { bold: true, fill: HEAD, align: 'center' });
    for (const x of ncr) r = writeRow(ws, r, [x.ncr_no, fmtDate(x.date_raised), x.description, x.corrective_action, x.responsible, fmtDate(x.target_date), x.status, x.days_open]);
    r += 1;
  }
  const conc = (m.concerns && m.concerns.entries) || [];
  if (secOn(m, 'concerns') && conc.length) {
    r = bar(ws, r, title(m, 'concerns', 'AREAS OF CONCERN / DELAYS / CONSTRAINTS – OPEN AS OF REPORT DATE'), 8);
    r = writeRow(ws, r, ['Date Raised', 'Issue', 'Impact', 'Severity', 'Action Required', 'By Whom', 'Target Date', ''], { bold: true, fill: HEAD, align: 'center' });
    for (const x of conc) r = writeRow(ws, r, [fmtDate(x.date_raised), x.issue, x.impact, x.severity, x.action_required, x.by_whom, fmtDate(x.target_date), '']);
    r += 1;
  }
  if (secOn(m, 'notes') && m.notes) {
    r = bar(ws, r, title(m, 'notes', 'REMARKS'), 8);
    ws.mergeCells(r, 1, r, 8);
    r = writeRow(ws, r, [m.notes]);
    r += 1;
  }
  if (secOn(m, 'signatures')) {
    const Sg = m.signatures || {};
    r = bar(ws, r, title(m, 'signatures', 'SIGNATURES'), 8);
    r = writeRow(ws, r, ['PREPARED BY (CONTRACTOR)', '', '', 'REVIEWED BY (CONTRACTOR)', '', '', "CONSULTANT'S REPRESENTATIVE", ''], { bold: true, fill: HEAD, align: 'center' });
    r = writeRow(ws, r, [Sg.prepared_by || '', '', '', Sg.reviewed_by || '', '', '', Sg.consultant_rep || '', '']);
    ws.getRow(r).height = 36;
    r = writeRow(ws, r, ['Signature:', '', '', 'Signature:', '', '', 'Signature:', '']);
    writeRow(ws, r, ['Date:', '', '', 'Date:', '', '', 'Date:', '']);
  }
}

function addBoqSheet(wb, m, meta) {
  if (!secOn(m, 'boq') || !tabOn(m, 'boq')) return;
  const ws = wb.addWorksheet('Overall Progress', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const defs = [['task_code', 'Task Code', 10], ['cost_code', 'Cost Code', 11], ['description', 'Description', 60], ['unit', 'Unit', 8],
    ['qty', 'Quantity', 12], ['budget', 'BUDGET', 12], ['curr', 'CURR', 12], ['cum', 'CUMUL', 12], ['balance', 'BALANCE', 12]]
    .filter(([k]) => k === 'description' || colOn(m, 'boq', k));
  ws.columns = defs.map(([, , w]) => ({ width: w }));
  let r = header(ws, m, meta, defs.length);
  r = bar(ws, r, sub(m, title(m, 'boq', 'PROJECT - OVERALL PROGRESS')), defs.length);
  for (const g of (m.boq && m.boq.groups) || []) {
    if (!g.rows.length) continue;
    if (g.name) r = bar(ws, r, g.name, defs.length);
    r = writeRow(ws, r, defs.map(([k, h]) => title(m, `col.boq.${k}`, h)), { bold: true, fill: HEAD, align: 'center' });
    for (const x of g.rows) {
      if (x.row_type !== 'item') {
        r = writeRow(ws, r, defs.map(([k]) => (k === 'description' ? x.description : (k === 'qty' ? val(x.qty) : (k === 'unit' ? x.unit : null)))),
          { bold: x.row_type === 'section', fill: x.row_type === 'section' ? SECTION : null });
        continue;
      }
      const v = { task_code: x.item_no, cost_code: x.cost_code, description: x.description, unit: x.unit, qty: cv(x.cells.qty), budget: cv(x.cells.budget),
        curr: cv(x.cells.curr) || null, cum: cv(x.cells.cum) || null, balance: cv(x.cells.balance) };
      r = writeRow(ws, r, defs.map(([k]) => v[k]));
    }
    r += 1;
  }
}

function addAreaSheets(wb, m) {
  if (!secOn(m, 'areas')) return;
  for (const a of m.areas || []) {
    const name = a.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Area';
    const ws = wb.addWorksheet(wb.getWorksheet(name) ? `${name.slice(0, 27)} ${a.area_id}` : name);
    ws.columns = [{ width: 10 }, { width: 40 }, { width: 14 }, { width: 22 }, { width: 7 }, { width: 9 }, { width: 24 }, { width: 7 }, { width: 9 }, { width: 8 }, { width: 10 }];
    let r = bar(ws, 1, sub(m, title(m, 'areas', '{area} - DAILY PROGRESS'), a.name), 11);
    r = writeRow(ws, r, ['Bill Item', 'ACTIVITY', 'CHAINAGE', 'PLANT', 'No.', 'W-HRS', 'TRADESMEN', 'No.', 'W-HRS', 'UNIT', 'OUTPUT'], { bold: true, fill: HEAD, align: 'center' });
    for (const act of a.activities) {
      const n = Math.max(act.plant.length, act.trades.length, 1);
      for (let i = 0; i < n; i += 1) {
        const p = act.plant[i];
        const t = act.trades[i];
        r = writeRow(ws, r, [i ? '' : act.item_no, i ? '' : act.description, i ? '' : act.chainage, p ? p.name : '', p ? val(p.nos) : null, p ? val(p.hours) : null,
          t ? t.name : '', t ? val(t.nos) : null, t ? val(t.hours) : null, i ? '' : act.unit, i ? null : (Number(act.output) ? val(act.output) : null)]);
      }
    }
  }
}

async function renderUccXlsx(m, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Team Flow';
  wb.created = new Date();
  addMainSheet(wb, m, meta);
  addBoqSheet(wb, m, meta);
  addAreaSheets(wb, m);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { renderUccXlsx };
