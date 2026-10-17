// services/dpr/dprXlsx.js
//
// The Daily Progress Report as an Excel file, laid out like the workbook's DPR
// and Alloc sheets (values, not formulas: it is the record of the day).
// Numbers are written as numbers (quantities exactly as stored); the number
// formats are the workbook's (#,##0 / 0.0% / 0.00), so nothing is rounded in
// the cells themselves.
'use strict';

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { fmtDate } = require('./dprPdf');

const LOGO = path.join(__dirname, '..', '..', 'assets', 'logo_project_daily_report.png');
const NAVY = 'FF1F3864';
const HEAD = 'FFD9E1F2';
const TOTAL = 'FFDDEBF7';
const LABEL = 'FFF2F2F2';
const YELLOW = 'FFFFF2CC';
const RED = 'FFC00000';
const thin = { style: 'thin', color: { argb: 'FF7F7F7F' } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

class Sheet {
  constructor(ws, cols) {
    this.ws = ws;
    this.r = 1;
    ws.columns = cols.map((w) => ({ width: w }));
    this.nCols = cols.length;
  }
  /** cells: [{ v, span, bold, fill, align, fmt, size, color, wrap }] laid from column 1 */
  row(cells, { height = null, border = true } = {}) {
    let c = 1;
    const r = this.r;
    for (const x of cells) {
      const span = x.span || 1;
      if (span > 1) this.ws.mergeCells(r, c, r, c + span - 1);
      const cell = this.ws.getCell(r, c);
      cell.value = x.v === undefined ? null : x.v;
      cell.font = { name: 'Arial', size: x.size || 8, bold: Boolean(x.bold), color: x.color ? { argb: x.color } : undefined };
      cell.alignment = { vertical: 'middle', horizontal: x.align || 'left', wrapText: x.wrap !== false };
      if (x.fmt) cell.numFmt = x.fmt;
      if (x.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: x.fill } };
      if (border) {
        for (let k = 0; k < span; k += 1) this.ws.getCell(r, c + k).border = BORDER;
      }
      c += span;
    }
    if (height) this.ws.getRow(r).height = height;
    this.r += 1;
    return r;
  }
  section(title) {
    const r = this.row([{ v: title, span: this.nCols, bold: true, fill: NAVY, color: 'FFFFFFFF', size: 9 }], { height: 16 });
    return r;
  }
  gap(h = 6) {
    this.ws.getRow(this.r).height = h;
    this.r += 1;
  }
  head(cells) {
    return this.row(cells.map((x) => ({ ...x, bold: true, fill: HEAD, align: 'center', size: 7.5 })), { height: 24 });
  }
}

const INT = '#,##0;-#,##0;"-"';
const DEC = '#,##0.0###;-#,##0.0###;"-"';
const DEC0 = '#,##0.####;-#,##0.####;"-"';
const PCT = '0.0%';
const R2 = '0.00';

function dprSheet(wb, m, meta) {
  const ws = wb.addWorksheet('DPR', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.5, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: `&8Daily Progress Report ${m.header.report_no}${meta.revision ? ` Rev.${meta.revision}` : ''}&C&8Page &P of &N&R&8${meta.issued ? 'Issued' : 'DRAFT'}` },
  });
  // 14 columns like the workbook (A..N)
  const S = new Sheet(ws, [12, 14, 13, 9, 11, 11, 11, 12, 11, 11, 11, 11, 11, 11]);
  const H = m.header;
  const on = m.sections || {};
  const show = (k) => on[k] !== false;

  // header
  S.row([{ v: '' }, { v: '' }, { v: '' }, { v: H.company_name || '[Company Name]', span: 7, bold: true, align: 'center', size: 11, color: NAVY },
    { v: 'Report No.', span: 2, bold: true, fill: LABEL }, { v: H.report_no + (meta.revision ? ` Rev.${meta.revision}` : ''), span: 2, bold: true, align: 'center', size: 11 }], { height: 20 });
  S.row([{ v: '' }, { v: '' }, { v: '' }, { v: 'DAILY PROGRESS REPORT', span: 7, bold: true, align: 'center', size: 15, color: NAVY },
    { v: 'Report Date', span: 2, bold: true, fill: LABEL }, { v: fmtDate(H.report_date), span: 2, bold: true, align: 'center', fill: YELLOW, color: RED, size: 10 }], { height: 22 });
  S.row([{ v: '' }, { v: '' }, { v: '' }, { v: H.project_name, span: 7, bold: true, align: 'center', size: 8 },
    { v: 'Day', span: 2, bold: true, fill: LABEL }, { v: H.day_name, span: 2, bold: true, align: 'center', size: 10 }], { height: 26 });
  ws.mergeCells(1, 1, 3, 3);
  if (fs.existsSync(LOGO)) {
    const img = wb.addImage({ filename: LOGO, extension: 'png' });
    ws.addImage(img, { tl: { col: 0.15, row: 0.1 }, ext: { width: 120, height: 66 } });
  }
  S.gap(4);
  const cur = H.currency || 'AED';
  const info = [
    ['Project Name', H.project_name, 'Agreement No.', H.agreement_no],
    ['Client', H.client, 'Consultant', H.consultant],
    ['Main Contractor', H.main_contractor, `Contract Value (${cur})`, { v: n(H.contract_value), fmt: '#,##0.##' }],
    ['Commencement', fmtDate(H.commencement_date), 'Original Completion', fmtDate(H.original_completion)],
    ['EOT / VO Granted', `${H.eot_days} days EOT  |  VO: ${cur} ${Number(H.vo_value).toLocaleString('en-US')}`, 'Revised Completion', fmtDate(H.revised_completion)],
    ['Days Elapsed', H.days_elapsed === null ? '' : `${H.days_elapsed} of ${H.revised_duration ?? '-'} days`, 'Days Remaining', { v: H.days_remaining }],
    ['% Time Elapsed', { v: H.time_elapsed, fmt: PCT }, '% Physical Progress (BOQ-wtd)', { v: H.physical_progress, fmt: PCT }],
  ];
  for (const [a, b, c, d] of info) {
    const val = (x) => (x && typeof x === 'object' ? x : { v: x });
    S.row([{ v: a, span: 2, bold: true, fill: LABEL }, { ...val(b), span: 5, align: 'left' }, { v: c, span: 3, bold: true, fill: LABEL }, { ...val(d), span: 4, align: 'left' }], { height: 13 });
  }
  S.gap();

  if (show('weather')) {
    S.section('1.  WEATHER & SITE CONDITIONS');
    S.head([{ v: 'Morning', span: 2 }, { v: 'Afternoon', span: 2 }, { v: 'Max °C' }, { v: 'Min °C' }, { v: 'Humidity %' }, { v: 'Wind km/h' }, { v: 'Hours lost' }, { v: 'Remarks / midday-break compliance', span: 5 }]);
    const W = m.weather;
    S.row([{ v: W.weather_am, span: 2, align: 'center' }, { v: W.weather_pm, span: 2, align: 'center' }, { v: n(W.temp_max), align: 'center' }, { v: n(W.temp_min), align: 'center' },
      { v: n(W.humidity), align: 'center' }, { v: n(W.wind), align: 'center' }, { v: n(W.hours_lost), align: 'center' }, { v: W.remarks, span: 5 }]);
    S.gap();
  }

  if (show('manpower')) {
    const P = m.manpower;
    S.section('2.  OWN MANPOWER BY TRADE  &  OWN PLANT / EQUIPMENT');
    S.head([{ v: 'Trade', span: 2 }, { v: 'Category' }, { v: 'Today' }, { v: 'Allocated' }, { v: 'Idle / Indirect' }, { v: 'Cum. Man-days' },
      { v: 'Equipment', span: 3 }, { v: 'Today' }, { v: 'Allocated' }, { v: 'Idle' }, { v: 'Cum. Equip-days' }]);
    const right = [];
    for (const p of P.plant) right.push([{ v: p.ownership === 'Hired' ? `${p.name} (Hired)` : p.name, span: 3 }, { v: p.today, fmt: INT, align: 'center', bold: true }, { v: p.allocated, fmt: INT, align: 'center' }, { v: p.idle, fmt: INT, align: 'center', color: p.idle < 0 ? RED : undefined }, { v: n(p.cum), fmt: DEC0, align: 'center' }]);
    right.push([{ v: 'TOTAL OWN PLANT', span: 3, bold: true, fill: TOTAL }, { v: P.own_plant.today, fmt: INT, bold: true, fill: TOTAL, align: 'center' }, { v: P.own_plant.allocated, fmt: INT, bold: true, fill: TOTAL, align: 'center' }, { v: P.own_plant.idle, fmt: INT, bold: true, fill: TOTAL, align: 'center' }, { v: n(P.own_plant.cum), fmt: DEC0, bold: true, fill: TOTAL, align: 'center' }]);
    right.push([{ v: 'OWN MANPOWER SUMMARY BY CATEGORY', span: 4, bold: true, fill: HEAD, align: 'center' }, { v: 'Today', bold: true, fill: HEAD, align: 'center' }, { v: 'Cum. Man-days', span: 2, bold: true, fill: HEAD, align: 'center' }]);
    for (const c of P.by_category.filter((c, i) => i < 6 || c.today || Number(c.cum))) {
      right.push([{ v: c.category, span: 4 }, { v: c.today, fmt: INT, align: 'center' }, { v: n(c.cum), fmt: DEC0, span: 2, align: 'center' }]);
    }
    right.push([{ v: 'TOTAL (check = own manpower)', span: 4, bold: true, fill: TOTAL }, { v: P.category_check.today, fmt: INT, bold: true, fill: TOTAL, align: 'center' }, { v: n(P.category_check.cum), fmt: DEC0, span: 2, bold: true, fill: TOTAL, align: 'center' }]);
    const left = P.trades.map((t) => [{ v: t.name, span: 2 }, { v: t.category, size: 7 }, { v: t.today, fmt: INT, align: 'center', bold: true }, { v: t.allocated, fmt: INT, align: 'center' },
      { v: t.idle, fmt: INT, align: 'center', color: t.idle < 0 ? RED : undefined }, { v: n(t.cum), fmt: DEC0, align: 'center' }]);
    left.push([{ v: 'TOTAL OWN MANPOWER', span: 3, bold: true, fill: TOTAL }, { v: P.own_manpower.today, fmt: INT, bold: true, fill: TOTAL, align: 'center' }, { v: P.own_manpower.allocated, fmt: INT, bold: true, fill: TOTAL, align: 'center' },
      { v: P.own_manpower.idle, fmt: INT, bold: true, fill: TOTAL, align: 'center' }, { v: n(P.own_manpower.cum), fmt: DEC0, bold: true, fill: TOTAL, align: 'center' }]);
    const rows = Math.max(left.length, right.length);
    const blankLeft = [{ v: '', span: 7 }];
    const blankRight = [{ v: '', span: 7 }];
    for (let i = 0; i < rows; i += 1) S.row([...(left[i] || blankLeft), ...(right[i] || blankRight)], { height: 12 });
    S.gap();
  }

  if (show('subcon')) {
    const Sb = m.subcontractors;
    S.section('3.  SUBCONTRACTOR RESOURCES (MANPOWER & PLANT)');
    S.head([{ v: 'Subcontractor', span: 3 }, { v: 'Resource', span: 3 }, { v: 'Type' }, { v: 'Today' }, { v: 'Allocated' }, { v: 'Idle' }, { v: 'Cum. Man-/Equip-days', span: 2 }, { v: 'Cum. Hours', span: 2 }]);
    for (const s of Sb.lines) {
      S.row([{ v: s.subcontractor, span: 3 }, { v: s.name, span: 3 }, { v: s.res_type, align: 'center' }, { v: s.today, fmt: INT, align: 'center', bold: true }, { v: s.allocated, fmt: INT, align: 'center' },
        { v: s.idle, fmt: INT, align: 'center', color: s.idle < 0 ? RED : undefined }, { v: n(s.cum), fmt: DEC0, span: 2, align: 'center' }, { v: n(s.cum_hours), fmt: DEC0, span: 2, align: 'center' }], { height: 12 });
    }
    for (const [label, t] of [['SUBCONTRACTOR MANPOWER TOTAL', Sb.manpower], ['SUBCONTRACTOR PLANT TOTAL', Sb.plant]]) {
      S.row([{ v: label, span: 7, bold: true, fill: TOTAL, align: 'right' }, { v: t.today, fmt: INT, bold: true, fill: TOTAL, align: 'center' }, { v: t.allocated, fmt: INT, bold: true, fill: TOTAL, align: 'center' },
        { v: t.idle, fmt: INT, bold: true, fill: TOTAL, align: 'center' }, { v: n(t.cum), fmt: DEC0, span: 2, bold: true, fill: TOTAL, align: 'center' }, { v: n(t.cum_hours), fmt: DEC0, span: 2, bold: true, fill: TOTAL, align: 'center' }]);
    }
    S.gap();
  }

  if (show('summary')) {
    const Su = m.summary;
    S.section('RESOURCE SUMMARY');
    S.head([{ v: 'Total Manpower on Site', span: 3 }, { v: 'Total Plant on Site', span: 3 }, { v: 'Man-hours Today', span: 3 }, { v: 'Cum. Man-days', span: 2 }, { v: 'Cum. Man-hours', span: 3 }]);
    S.row([{ v: Su.total_manpower, span: 3, fmt: '#,##0', bold: true, align: 'center', size: 13, color: NAVY }, { v: Su.total_plant, span: 3, fmt: '#,##0', bold: true, align: 'center', size: 13, color: NAVY },
      { v: n(Su.man_hours_today), span: 3, fmt: '#,##0.##', bold: true, align: 'center', size: 13, color: NAVY }, { v: n(Su.cum_man_days), span: 2, fmt: '#,##0.##', bold: true, align: 'center', size: 13, color: NAVY },
      { v: n(Su.cum_man_hours), span: 3, fmt: '#,##0.##', bold: true, align: 'center', size: 13, color: NAVY }], { height: 24 });
    S.gap();
  }

  if (show('work')) {
    const Wk = m.work;
    ws.getRow(S.r - 1).addPageBreak();
    S.section('4.  WORK PROGRESS – ACTIVITIES EXECUTED & BOQ QUANTITIES');
    S.head([{ v: 'BOQ Item' }, { v: 'Description', span: 2 }, { v: 'Location' }, { v: 'Unit' }, { v: 'Contract Qty' }, { v: 'Today' }, { v: 'Previous Cum.' }, { v: 'Cum. to Date' }, { v: '% Complete' }, { v: 'Balance' }, { v: 'Man-hours' }, { v: 'Output / MH', span: 2 }]);
    for (const a of Wk.activities) {
      S.row([{ v: a.item_no, bold: true, align: 'center' }, { v: a.description, span: 2, size: 7 }, { v: a.location, size: 7 }, { v: a.unit, align: 'center' }, { v: n(a.contract_qty), fmt: DEC, align: 'right' },
        { v: n(a.today), fmt: DEC, align: 'right', bold: true }, { v: n(a.prev_cum), fmt: DEC, align: 'right' }, { v: n(a.cum), fmt: DEC, align: 'right', bold: true }, { v: a.pct, fmt: PCT, align: 'right' },
        { v: n(a.balance), fmt: DEC, align: 'right' }, { v: n(a.man_hours), fmt: DEC0, align: 'right' }, { v: a.output_per_mh, fmt: R2, align: 'right', span: 2 }], { height: 24 });
    }
    S.row([{ v: `Activities logged today: ${Wk.count}`, span: 6, bold: true, color: RED }, { v: 'Man-hours allocated to activities', span: 5, bold: true, fill: LABEL, align: 'right' }, { v: n(Wk.man_hours_allocated), fmt: DEC0, bold: true, span: 3, align: 'right' }], { border: false });
    S.row([{ v: '', span: 6 }, { v: 'Unallocated / indirect man-hours', span: 5, bold: true, fill: LABEL, align: 'right' }, { v: n(Wk.unallocated_man_hours), fmt: DEC0, bold: true, span: 3, align: 'right' }], { border: false });
    S.gap();
  }

  if (show('qa')) {
    S.section('5.  QUALITY ASSURANCE / QUALITY CONTROL');
    S.head([{ v: 'Type' }, { v: 'Ref No.' }, { v: 'Description / Activity', span: 5 }, { v: 'Location', span: 2 }, { v: 'Result', span: 2 }, { v: 'Remarks', span: 3 }]);
    for (const q of m.qa.entries) {
      S.row([{ v: q.type }, { v: q.ref_no }, { v: q.description, span: 5 }, { v: q.location, span: 2 }, { v: q.result, span: 2 }, { v: q.remarks, span: 3 }], { height: 13 });
    }
    S.row([{ v: `QA/QC entries today: ${m.qa.count}`, span: 14, size: 7 }], { border: false });
    S.gap();
  }

  if (show('hse')) {
    const Hs = m.hse;
    S.section('6.  HEALTH, SAFETY & ENVIRONMENT');
    const lv = (l, v, fmt = INT) => [{ v: l, span: 3, bold: true, fill: LABEL, size: 7 }, { v, fmt, bold: true, align: 'center' }];
    const rr = [
      [lv('Manpower on site today', Hs.manpower_today, '#,##0'), lv('Man-hours today', n(Hs.man_hours_today), '#,##0.##'), lv('Cumulative man-hours to date', n(Hs.cum_man_hours), '#,##0.##')],
      [lv('Safe man-hours since last LTI', n(Hs.safe_man_hours), '#,##0.##'), lv('LTI-free days', Hs.lti_free_days, '0'), lv('LTIs to date', Hs.ltis_to_date, '0')],
      [lv('Incidents today', Hs.incidents_today, '0'), lv('Near misses today', Hs.near_misses_today, '0'), lv('First aid cases today', Hs.first_aid_today, '0')],
      [lv('LTI today', Hs.lti_today, '0'), lv('PTWs issued today', Hs.ptws_today, '0'), lv('HSE inspections / audits today', Hs.hse_inspections_today, '0')],
      [lv('Toolbox talk attendees', Hs.tbt_attendees, '0'), lv('Near misses to date', Hs.near_misses_to_date, '0'),
        [{ v: 'LTIFR / TRIR (per 200k MH)', span: 3, bold: true, fill: LABEL, size: 7 }, { v: Hs.ltifr === null ? '' : `${Hs.ltifr.toFixed(2)} / ${Hs.trir.toFixed(2)}`, bold: true, align: 'center', size: 7 }]],
    ];
    for (const r of rr) S.row([...r[0], ...r[1], ...r[2], { v: '', span: 2 }], { height: 13 });
    S.row([{ v: 'Toolbox talk topic', span: 3, bold: true, fill: LABEL, size: 7 }, { v: Hs.tbt_topic, span: 11 }], { height: 14 });
    S.row([{ v: 'HSE observations & corrective actions', span: 3, bold: true, fill: LABEL, size: 7 }, { v: Hs.observations, span: 11 }], { height: 26 });
    S.gap();
  }

  if (show('ncr')) {
    ws.getRow(S.r - 1).addPageBreak();
    S.section(`7.  NON-CONFORMANCE REPORTS – OPEN AS OF REPORT DATE  (Open / closed today: ${m.ncr.count})`);
    S.head([{ v: 'NCR No.' }, { v: 'Date Raised' }, { v: 'Description', span: 4 }, { v: 'Corrective Action', span: 3 }, { v: 'Responsible' }, { v: 'Target Date' }, { v: 'Status' }, { v: 'Days Open', span: 2 }]);
    for (const x of m.ncr.entries) {
      S.row([{ v: x.ncr_no, bold: true, align: 'center' }, { v: fmtDate(x.date_raised), align: 'center' }, { v: x.description, span: 4, size: 7 }, { v: x.corrective_action, span: 3, size: 7 },
        { v: x.responsible, size: 7, align: 'center' }, { v: fmtDate(x.target_date), align: 'center' }, { v: x.status, bold: true, align: 'center', color: x.status === 'Open' ? RED : undefined }, { v: x.days_open, span: 2, align: 'center' }], { height: 24 });
    }
    S.gap();
  }
  if (show('concerns')) {
    S.section('8.  AREAS OF CONCERN / DELAYS / CONSTRAINTS – OPEN AS OF REPORT DATE');
    S.head([{ v: 'Date Raised' }, { v: 'Issue', span: 4 }, { v: 'Impact' }, { v: 'Severity' }, { v: 'Action Required', span: 4 }, { v: 'By Whom' }, { v: 'Target Date', span: 2 }]);
    for (const x of m.concerns.entries) {
      S.row([{ v: fmtDate(x.date_raised), align: 'center' }, { v: x.issue, span: 4, size: 7 }, { v: x.impact, align: 'center' }, { v: x.severity, bold: true, align: 'center', fill: ['High', 'Medium'].includes(x.severity) ? YELLOW : undefined },
        { v: x.action_required, span: 4, size: 7 }, { v: x.by_whom, size: 7, align: 'center' }, { v: fmtDate(x.target_date), span: 2, align: 'center' }], { height: 24 });
    }
    S.gap();
  }
  if (show('plan')) {
    S.section('9.  PLANNED ACTIVITIES – NEXT WORKING DAY');
    S.row([{ v: m.next_day_plan, span: 14, wrap: true }], { height: 36 });
    S.gap();
  }
  if (show('remarks')) {
    S.section('10.  GENERAL REMARKS / INSTRUCTIONS / RFIs / VISITORS');
    S.row([{ v: m.remarks, span: 14 }], { height: 36 });
    S.gap();
  }
  if (show('signatures')) {
    S.head([{ v: 'PREPARED BY (CONTRACTOR)', span: 5 }, { v: 'REVIEWED BY (CONTRACTOR)', span: 5 }, { v: "CONSULTANT'S REPRESENTATIVE", span: 4 }]);
    S.row([{ v: 'Signature:', span: 5, size: 7 }, { v: 'Signature:', span: 5, size: 7 }, { v: 'Signature:', span: 4, size: 7 }], { height: 36 });
    S.row([{ v: m.signatures.prepared_by, span: 5, bold: true }, { v: m.signatures.reviewed_by, span: 5, bold: true }, { v: m.signatures.consultant_rep, span: 4, bold: true }]);
    S.row([{ v: 'Date:', span: 5, size: 7 }, { v: 'Date:', span: 5, size: 7 }, { v: 'Date:', span: 4, size: 7 }]);
  }
  return ws;
}

function photoSheet(wb, m, photoBuffers) {
  const photos = (m.photos || []).slice().sort((a, b) => a.slot - b.slot);
  const ws = wb.addWorksheet('Photos', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const S = new Sheet(ws, [8, 26, 22, 30]);
  S.section('11.  SITE PHOTOGRAPHS');
  if (!photos.length) {
    S.row([{ v: 'No photo for this day.', span: 4 }]);
    return;
  }
  for (const p of photos) {
    S.row([{ v: `No. ${p.slot}`, bold: true, fill: YELLOW }, { v: `BOQ / Activity: ${p.boq_activity}`, fill: YELLOW }, { v: `Location: ${p.location}`, fill: YELLOW }, { v: `Caption: ${p.caption}`, fill: YELLOW }]);
    const top = S.r;
    for (let i = 0; i < 14; i += 1) S.row([{ v: '', span: 4 }], { height: 15, border: false });
    const buf = photoBuffers.get(p.photo_id);
    const ext = /png/i.test(p.content_type || p.file_name) ? 'png' : (/gif/i.test(p.content_type || '') ? 'gif' : 'jpeg');
    if (buf) {
      try {
        const id = wb.addImage({ buffer: buf, extension: ext });
        ws.addImage(id, { tl: { col: 0.1, row: top - 1 + 0.1 }, ext: { width: 520, height: 270 } });
      } catch (_) { /* image not readable */ }
    }
    S.gap(8);
  }
}

function allocSheet(wb, m, meta) {
  const A = m.allocation;
  const nAct = A.activities.length;
  const ws = wb.addWorksheet('Alloc', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
  });
  const nCols = Math.max(nAct, 1);
  const S = new Sheet(ws, [5, 32, 15, 9, ...Array(nCols).fill(9), 10, 11, 10, 15]);
  const total = 4 + nCols + 4;
  S.row([{ v: 'RESOURCE ALLOCATION MATRIX – Distribution of Deployed Resources over BOQ Activities', span: total, bold: true, size: 12, color: NAVY }], { border: false, height: 20 });
  S.row([{ v: 'Project', bold: true, fill: LABEL }, { v: m.header.project_name, span: total - 5 }, { v: `${m.header.report_no}${meta.revision ? ` Rev.${meta.revision}` : ''}`, span: 2, bold: true, align: 'center' },
    { v: fmtDate(m.header.report_date), span: 2, bold: true, align: 'center', fill: YELLOW }]);
  const acts = (fn) => (nAct ? A.activities.map(fn) : [{ v: '' }]);
  S.row([{ v: '' }, { v: 'BOQ Item →', bold: true, fill: HEAD }, { v: '', span: 2, fill: HEAD }, ...acts((a) => ({ v: a.item_no, bold: true, fill: HEAD, align: 'center' })), { v: '', span: 4 }]);
  S.row([{ v: '' }, { v: 'Location →', fill: HEAD }, { v: '', span: 2, fill: HEAD }, ...acts((a) => ({ v: a.location, fill: HEAD, align: 'center', size: 6.5 })), { v: '', span: 4 }], { height: 24 });
  S.row([{ v: '' }, { v: 'Qty today →', fill: HEAD }, { v: '', span: 2, fill: HEAD }, ...acts((a) => ({ v: `${Number(a.qty).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 4 })} ${a.unit}`, fill: HEAD, align: 'center', size: 6.5 })), { v: '', span: 4 }]);
  S.head([{ v: '#' }, { v: 'Resource' }, { v: 'Group' }, { v: 'Deployed' }, ...(nAct ? A.activities.map((_, i) => ({ v: `Act ${i + 1}` })) : [{ v: '' }]), { v: 'Total Allocated' }, { v: 'Unallocated / Idle' }, { v: 'Utilisation' }, { v: 'Status' }]);
  A.rows.forEach((r, i) => {
    S.row([{ v: i + 1, align: 'center' }, { v: r.resource, size: 7 }, { v: r.group, size: 7 }, { v: r.deployed, fmt: INT, align: 'center' },
      ...(nAct ? r.per_activity.map((v) => ({ v, fmt: INT, align: 'center' })) : [{ v: '' }]),
      { v: r.allocated, fmt: INT, align: 'center' }, { v: r.idle, fmt: INT, align: 'center', color: r.idle < 0 ? RED : undefined }, { v: r.utilisation, fmt: '0%', align: 'center' },
      { v: r.status, align: 'center', size: 7, color: r.status === 'Over-allocated' ? RED : undefined, fill: r.status === 'Balanced' ? 'FFE2EFDA' : (r.status === 'Over-allocated' ? 'FFFCE4D6' : undefined) }], { height: 12 });
  });
  const tot = (label, t, per, fmt) => S.row([{ v: label, span: 3, bold: true, fill: TOTAL }, { v: n(t.deployed), fmt, bold: true, fill: TOTAL, align: 'center' },
    ...(nAct ? per.map((v) => ({ v: n(v), fmt, bold: true, fill: TOTAL, align: 'center' })) : [{ v: '', fill: TOTAL }]),
    { v: n(t.allocated), fmt, bold: true, fill: TOTAL, align: 'center' }, { v: n(t.idle), fmt, bold: true, fill: TOTAL, align: 'center' },
    { v: t.utilisation === undefined ? null : t.utilisation, fmt: '0%', bold: true, fill: TOTAL, align: 'center' }, { v: '', fill: TOTAL }]);
  tot('TOTAL MANPOWER (nos)', A.manpower, A.manpower.per_activity, INT);
  tot('TOTAL PLANT (nos)', A.plant, A.plant.per_activity, INT);
  tot('MAN-HOURS', A.man_hours, A.man_hours.per_activity, DEC0);
  tot('EQUIPMENT-HOURS', A.equip_hours, A.equip_hours.per_activity, DEC0);
  S.row([{ v: 'OUTPUT PER MAN-HOUR (unit/MH)', span: 4 }, ...(nAct ? A.output_per_mh.map((v) => ({ v, fmt: '0.000', align: 'center' })) : [{ v: '' }]), { v: '', span: 4 }]);
  S.row([{ v: 'OUTPUT PER MAN-DAY (unit/MD)', span: 4 }, ...(nAct ? A.output_per_md.map((v) => ({ v, fmt: R2, align: 'center' })) : [{ v: '' }]), { v: '', span: 4 }]);
  S.row([{ v: `Activities logged today: ${nAct}`, span: total, bold: true, color: RED }], { border: false });
}

/** @returns {Promise<Buffer>} */
async function renderDprXlsx(m, meta = {}, photoBuffers = new Map()) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Team Flow';
  wb.created = new Date();
  const on = m.sections || {};
  dprSheet(wb, m, meta);
  if (on.photos !== false) photoSheet(wb, m, photoBuffers);
  if (on.alloc !== false) allocSheet(wb, m, meta);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { renderDprXlsx };
