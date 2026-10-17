// services/dpr/dprPdf.js
//
// The Daily Progress Report as PDF, laid out like the client's workbook
// (sheet DPR pages 1-4 + sheet Alloc). Input: the model of dprCalc / dprModel
// (or the frozen snapshot of an issued report). Sections switched off are not
// printed. Numbers are printed as stored: quantities with all their decimals,
// percentages with 1 decimal and output / MH with 2 decimals (as the workbook).
'use strict';

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

let reshaper = null;
try { reshaper = require('arabic-reshaper'); } catch (_) { reshaper = null; }

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONTS = {
  regular: path.join(FONT_DIR, 'LiberationSans-Regular.ttf'),
  bold: path.join(FONT_DIR, 'LiberationSans-Bold.ttf'),
  arabic: path.join(FONT_DIR, 'NotoNaskhArabic-Regular.ttf'),
};
const LOGO = path.join(__dirname, '..', '..', 'assets', 'logo_project_daily_report.png');

const COLORS = {
  navy: '#1F3864',
  head: '#D9E1F2',
  total: '#DDEBF7',
  label: '#F2F2F2',
  yellow: '#FFF2CC',
  line: '#7F7F7F',
  ink: '#000000',
  muted: '#595959',
  red: '#C00000',
  amber: '#FCE4D6',
  green: '#E2EFDA',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ------------------------------------------------------------------ formatting
function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return String(d);
  return `${String(day).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
}
function group3(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** Integer / count: 1,234 and 0 as "-" (as the workbook). */
function fmtInt(v, { dash = true } = {}) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n === 0 && dash) return '-';
  const neg = n < 0;
  return `${neg ? '-' : ''}${group3(String(Math.abs(Math.trunc(n))))}${Number.isInteger(n) ? '' : String(Math.abs(n)).replace(/^\d+/, '')}`;
}
/** Exact decimal string with thousands separators and at least `min` decimals (never rounded). */
function fmtDec(v, { min = 0, dash = false } = {}) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (dash && Number(s) === 0) return '-';
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const frac = f.padEnd(min, '0');
  return `${neg ? '-' : ''}${group3(i)}${frac ? `.${frac}` : ''}`;
}
function fmtPct(v, places = 1) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '';
  return `${(Number(v) * 100).toFixed(places)}%`;
}
function fmtRatio(v, places = 2) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '';
  return Number(v).toFixed(places);
}
function fmtStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

// ------------------------------------------------------------------ drawing kit
class Kit {
  constructor(doc, { landscape = false } = {}) {
    this.doc = doc;
    this.margin = 22;
    this.top = 22;
    this.landscape = landscape;
  }
  get W() { return this.doc.page.width - this.margin * 2; }
  get bottom() { return this.doc.page.height - 30; }
  get x0() { return this.margin; }

  font(bold, size) {
    this.doc.font(bold ? 'B' : 'R').fontSize(size);
  }
  prep(text, bold, size) {
    const t = text === null || text === undefined ? '' : String(text);
    if (ARABIC.test(t)) {
      this.doc.font('AR').fontSize(size);
      let s = t;
      if (reshaper && reshaper.convertArabic) s = reshaper.convertArabic(t);
      return { t: s.split('').reverse().join(''), rtl: true };
    }
    this.font(bold, size);
    return { t, rtl: false };
  }
  textH(text, w, { bold = false, size = 7.5, pad = 2 } = {}) {
    const { t } = this.prep(text, bold, size);
    if (!t) return size + pad * 2;
    return this.doc.heightOfString(t, { width: Math.max(w - pad * 2, 4), lineGap: 0 }) + pad * 2;
  }
  cell(x, y, w, h, text, o = {}) {
    const { bold = false, size = 7.5, align = 'left', fill = null, color = COLORS.ink, border = true, pad = 2, valign = 'middle' } = o;
    const doc = this.doc;
    if (fill) doc.rect(x, y, w, h).fill(fill);
    if (border) doc.lineWidth(0.4).strokeColor(COLORS.line).rect(x, y, w, h).stroke();
    const { t, rtl } = this.prep(text, bold, size);
    if (!t) return;
    const tw = Math.max(w - pad * 2, 4);
    const th = doc.heightOfString(t, { width: tw, lineGap: 0 });
    let ty = y + pad;
    if (valign === 'middle') ty = y + Math.max((h - th) / 2, pad);
    doc.fillColor(color).text(t, x + pad, ty, {
      width: tw, height: Math.max(h - pad, size), align: rtl && align === 'left' ? 'right' : align, lineGap: 0, ellipsis: true,
    });
  }
  ensure(y, h) {
    if (y + h <= this.bottom) return y;
    this.doc.addPage();
    return this.top;
  }
  section(y, title, need = 30) {
    y = this.ensure(y, 16 + need);
    this.doc.rect(this.x0, y, this.W, 14).fill(COLORS.navy);
    const { t } = this.prep(title, true, 8.5);
    this.doc.fillColor('#FFFFFF').text(t, this.x0 + 4, y + 3, { width: this.W - 8, lineBreak: false, ellipsis: true });
    return y + 16;
  }
  /**
   * cols: [{ w, align }], header: [text], rows: [{ cells: [text], bold, fill, colors: [] }]
   * Rows grow with their text; a row that does not fit goes to the next page with the header again.
   */
  table(y, cols, header, rows, o = {}) {
    const { size = 7.2, headSize = 7, minH = 12, x = this.x0, headFill = COLORS.head, pad = 2 } = o;
    const drawHead = (yy) => {
      if (!header) return yy;
      const h = Math.max(...header.map((t, i) => this.textH(t, cols[i].w, { bold: true, size: headSize })), 16);
      let cx = x;
      header.forEach((t, i) => {
        this.cell(cx, yy, cols[i].w, h, t, { bold: true, size: headSize, align: 'center', fill: headFill });
        cx += cols[i].w;
      });
      return yy + h;
    };
    y = this.ensure(y, 30);
    y = drawHead(y);
    for (const r of rows) {
      // r.span: the first `span` columns are one cell (labels of total rows)
      const span = Math.max(1, r.span || 1);
      const widthOf = (i) => (i === 0 ? cols.slice(0, span).reduce((a, c) => a + c.w, 0) : cols[i].w);
      const shown = r.cells.map((t, i) => ({ t, i })).filter(({ i }) => i === 0 || i >= span);
      const h = r.fixedH || Math.max(minH, ...shown.map(({ t, i }) => this.textH(t, widthOf(i), { bold: r.bold, size: r.size || size, pad })));
      if (y + h > this.bottom) {
        this.doc.addPage();
        y = drawHead(this.top);
      }
      let cx = x;
      for (const { t, i } of shown) {
        const w = widthOf(i);
        this.cell(cx, y, w, h, t, {
          bold: r.bold || (r.boldCols && r.boldCols.includes(i)), size: r.size || size, pad,
          align: (r.align && r.align[i]) || (i === 0 && span > 1 ? 'left' : cols[i].align) || 'left',
          fill: (r.fills && r.fills[i]) || r.fill || null, color: (r.colors && r.colors[i]) || COLORS.ink,
        });
        cx += w;
      }
      y += h;
    }
    return y;
  }
  textBox(y, text, { minH = 28, size = 7.5 } = {}) {
    const h = Math.max(minH, this.textH(text, this.W, { size, pad: 4 }));
    y = this.ensure(y, h);
    this.cell(this.x0, y, this.W, h, text, { size, pad: 4, valign: 'top' });
    return y + h;
  }
}

// ------------------------------------------------------------------ page 1 header
function drawHeader(k, m, meta) {
  const doc = k.doc;
  const H = m.header;
  const x = k.x0;
  let y = k.top;
  const logoW = 95;
  const rightW = 150;
  const midW = k.W - logoW - rightW;
  const topH = 64;
  doc.lineWidth(0.4).strokeColor(COLORS.line).rect(x, y, logoW, topH).stroke();
  if (fs.existsSync(LOGO)) {
    try { doc.image(LOGO, x + 4, y + 4, { fit: [logoW - 8, topH - 8], align: 'center', valign: 'center' }); } catch (_) { /* no logo */ }
  }
  k.cell(x + logoW, y, midW, 14, H.company_name || '[Company Name]', { bold: true, size: 10, align: 'center', border: false, color: COLORS.navy });
  k.cell(x + logoW, y + 14, midW, 22, 'DAILY PROGRESS REPORT', { bold: true, size: 15, align: 'center', border: false, color: COLORS.navy });
  k.cell(x + logoW, y + 36, midW, 28, H.project_name, { bold: true, size: 7.5, align: 'center', border: false });
  const rx = x + logoW + midW;
  const rowH = topH / 3;
  const pairs = [
    ['Report No.', H.report_no + (meta.revision ? `  Rev.${meta.revision}` : ''), null],
    ['Report Date', fmtDate(H.report_date), COLORS.yellow],
    ['Day', H.day_name, null],
  ];
  pairs.forEach(([l, v, fill], i) => {
    k.cell(rx, y + i * rowH, 58, rowH, l, { bold: true, size: 7, fill: COLORS.label });
    k.cell(rx + 58, y + i * rowH, rightW - 58, rowH, v, { bold: true, size: i === 0 ? 10 : 9, align: 'center', fill, color: i === 1 ? COLORS.red : COLORS.ink });
  });
  y += topH + 4;
  const cur = H.currency || 'AED';
  const info = [
    ['Project Name', H.project_name, 'Agreement No.', H.agreement_no],
    ['Client', H.client, 'Consultant', H.consultant],
    ['Main Contractor', H.main_contractor, `Contract Value (${cur})`, fmtDec(H.contract_value)],
    ['Commencement', fmtDate(H.commencement_date), 'Original Completion', fmtDate(H.original_completion)],
    ['EOT / VO Granted', `${H.eot_days} days EOT  |  VO: ${cur} ${fmtDec(H.vo_value)}`, 'Revised Completion', fmtDate(H.revised_completion)],
    ['Days Elapsed', H.days_elapsed === null ? '' : `${H.days_elapsed} of ${H.revised_duration ?? '-'} days`, 'Days Remaining', H.days_remaining === null ? '' : String(H.days_remaining)],
    ['% Time Elapsed', fmtPct(H.time_elapsed), '% Physical Progress (BOQ-wtd)', fmtPct(H.physical_progress)],
  ];
  const cw = [85, 190, 110, k.W - 385];
  for (const r of info) {
    const h = Math.max(11, k.textH(r[1], cw[1], { size: 6.8 }), k.textH(r[3], cw[3], { size: 6.8 }));
    let cx = x;
    r.forEach((t, i) => {
      k.cell(cx, y, cw[i], h, t, { bold: i % 2 === 0, size: 6.8, fill: i % 2 === 0 ? COLORS.label : null });
      cx += cw[i];
    });
    y += h;
  }
  return y + 5;
}

// ------------------------------------------------------------------ sections
function sWeather(k, y, m) {
  y = k.section(y, '1.  WEATHER & SITE CONDITIONS');
  const W = m.weather;
  const cols = [{ w: 70 }, { w: 70 }, { w: 45, align: 'center' }, { w: 45, align: 'center' }, { w: 50, align: 'center' }, { w: 50, align: 'center' }, { w: 45, align: 'center' }, { w: k.W - 375 }];
  return k.table(y, cols, ['Morning', 'Afternoon', 'Max °C', 'Min °C', 'Humidity %', 'Wind km/h', 'Hours lost', 'Remarks / midday-break compliance'],
    [{ cells: [W.weather_am, W.weather_pm, fmtDec(W.temp_max), fmtDec(W.temp_min), fmtDec(W.humidity), fmtDec(W.wind), fmtDec(W.hours_lost), W.remarks], align: ['center', 'center'] }]) + 5;
}

function sManpower(k, y, m) {
  const P = m.manpower;
  // left (trades) and right (plant + categories) side by side: start on a page where both fit
  const rightRows = P.plant.length + 1 + 3 + Math.max(6, P.by_category.length);
  const estH = 34 + Math.max(P.trades.length + 1, rightRows) * 12;
  if (y + estH > k.bottom && y > k.top + 40) {
    k.doc.addPage();
    y = k.top;
  }
  y = k.section(y, '2.  OWN MANPOWER BY TRADE  &  OWN PLANT / EQUIPMENT');
  const leftCols = [{ w: 82 }, { w: 68 }, { w: 30, align: 'center' }, { w: 38, align: 'center' }, { w: 36, align: 'center' }, { w: 42, align: 'center' }];
  const leftW = leftCols.reduce((a, c) => a + c.w, 0);
  const rightX = k.x0 + leftW + 4;
  const rW = k.W - leftW - 4;
  const startY = y;
  const tradeRows = P.trades.map((t) => ({
    cells: [t.name, t.category, fmtInt(t.today), fmtInt(t.allocated), fmtInt(t.idle), fmtDec(t.cum, { dash: true })],
    boldCols: [2], colors: [null, null, null, null, t.idle < 0 ? COLORS.red : null], size: 6.8,
  }));
  tradeRows.push({ span: 2, cells: ['TOTAL OWN MANPOWER', '', fmtInt(P.own_manpower.today), fmtInt(P.own_manpower.allocated), fmtInt(P.own_manpower.idle), fmtDec(P.own_manpower.cum)], bold: true, fill: COLORS.total });
  const pageBefore = k.doc.bufferedPageRange().count;
  const yLeft = k.table(y, leftCols, ['Trade', 'Category', 'Today', 'Allocated', 'Idle / Indirect', 'Cum. Man-days'], tradeRows, { minH: 10.6 });
  const spilled = k.doc.bufferedPageRange().count !== pageBefore;
  // right column: next to the trades, or under them if the trades ran onto another page
  const rx = spilled ? k.x0 : rightX;
  const rWidth = spilled ? k.W : rW;
  let yr = spilled ? yLeft + 5 : startY;
  const rc = [{ w: rWidth - 32 - 38 - 30 - 42 }, { w: 32, align: 'center' }, { w: 38, align: 'center' }, { w: 30, align: 'center' }, { w: 42, align: 'center' }];
  const plantRows = P.plant.map((p) => ({
    cells: [p.ownership === 'Hired' ? `${p.name} (Hired)` : p.name, fmtInt(p.today), fmtInt(p.allocated), fmtInt(p.idle), fmtDec(p.cum, { dash: true })],
    boldCols: [1], colors: [null, null, null, p.idle < 0 ? COLORS.red : null], size: 6.8,
  }));
  plantRows.push({ cells: ['TOTAL OWN PLANT', fmtInt(P.own_plant.today), fmtInt(P.own_plant.allocated), fmtInt(P.own_plant.idle), fmtDec(P.own_plant.cum)], bold: true, fill: COLORS.total });
  yr = k.table(yr, rc, ['Equipment', 'Today', 'Allocated', 'Idle', 'Cum. Equip-days'], plantRows, { x: rx, minH: 10.6 });
  const cc = [{ w: rWidth - 50 - 60 }, { w: 50, align: 'center' }, { w: 60, align: 'center' }];
  const catRows = P.by_category.filter((c, i) => i < 6 || c.today || Number(c.cum)).map((c) => ({ cells: [c.category, fmtInt(c.today), fmtDec(c.cum, { dash: true })], size: 6.8 }));
  catRows.push({ cells: ['TOTAL (check = own manpower)', fmtInt(P.category_check.today), fmtDec(P.category_check.cum)], bold: true, fill: COLORS.total });
  yr = k.table(yr + 3, cc, ['OWN MANPOWER SUMMARY BY CATEGORY', 'Today', 'Cum. Man-days'], catRows, { x: rx, minH: 10.6 });
  return (spilled ? yr : Math.max(yLeft, yr)) + 5;
}

function sSubcon(k, y, m) {
  y = k.section(y, '3.  SUBCONTRACTOR RESOURCES (MANPOWER & PLANT)');
  const S = m.subcontractors;
  const cols = [{ w: 135 }, { w: 110 }, { w: 55, align: 'center' }, { w: 40, align: 'center' }, { w: 45, align: 'center' }, { w: 40, align: 'center' }, { w: 66, align: 'center' }, { w: k.W - 491, align: 'center' }];
  const rows = S.lines.map((s) => ({
    cells: [s.subcontractor, s.name, s.res_type, fmtInt(s.today), fmtInt(s.allocated), fmtInt(s.idle), fmtDec(s.cum, { dash: true }), fmtDec(s.cum_hours, { dash: true })],
    boldCols: [3], colors: [null, null, null, null, null, s.idle < 0 ? COLORS.red : null], size: 6.8,
  }));
  const tot = (label, t) => ({ span: 3, cells: [label, '', '', fmtInt(t.today), fmtInt(t.allocated), fmtInt(t.idle), fmtDec(t.cum), fmtDec(t.cum_hours)], bold: true, fill: COLORS.total, align: ['right'] });
  rows.push(tot('SUBCONTRACTOR MANPOWER TOTAL', S.manpower));
  rows.push(tot('SUBCONTRACTOR PLANT TOTAL', S.plant));
  return k.table(y, cols, ['Subcontractor', 'Resource', 'Type', 'Today', 'Allocated', 'Idle', 'Cum. Man-/Equip-days', 'Cum. Hours'], rows, { minH: 10.6 }) + 5;
}

function sSummary(k, y, m) {
  y = k.section(y, 'RESOURCE SUMMARY', 38);
  const S = m.summary;
  const items = [
    ['Total Manpower on Site', fmtInt(S.total_manpower, { dash: false })],
    ['Total Plant on Site', fmtInt(S.total_plant, { dash: false })],
    ['Man-hours Today', fmtDec(S.man_hours_today)],
    ['Cum. Man-days', fmtDec(S.cum_man_days)],
    ['Cum. Man-hours', fmtDec(S.cum_man_hours)],
  ];
  const w = k.W / items.length;
  items.forEach(([l, v], i) => {
    k.cell(k.x0 + i * w, y, w, 14, l, { bold: true, size: 7, align: 'center', fill: COLORS.head });
    k.cell(k.x0 + i * w, y + 14, w, 22, v, { bold: true, size: 12, align: 'center', color: COLORS.navy });
  });
  return y + 41;
}

function sWork(k, y, m) {
  y = k.section(y, '4.  WORK PROGRESS – ACTIVITIES EXECUTED & BOQ QUANTITIES');
  const Wk = m.work;
  const cols = [{ w: 34, align: 'center' }, { w: 104 }, { w: 58 }, { w: 26, align: 'center' }, { w: 42, align: 'right' }, { w: 38, align: 'right' },
    { w: 42, align: 'right' }, { w: 42, align: 'right' }, { w: 36, align: 'right' }, { w: 42, align: 'right' }, { w: 40, align: 'right' }, { w: k.W - 504, align: 'right' }];
  const rows = Wk.activities.map((a) => ({
    cells: [a.item_no, a.description, a.location, a.unit, fmtDec(a.contract_qty, { min: 1 }), fmtDec(a.today, { min: 1 }), fmtDec(a.prev_cum, { min: 1 }),
      fmtDec(a.cum, { min: 1 }), fmtPct(a.pct), fmtDec(a.balance, { min: 1 }), fmtDec(a.man_hours), fmtRatio(a.output_per_mh)],
    boldCols: [0, 5, 7], size: 6.6,
  }));
  if (!rows.length) rows.push({ cells: ['', 'No activity entered for the day.', '', '', '', '', '', '', '', '', '', ''] });
  y = k.table(y, cols, ['BOQ Item', 'Description', 'Location', 'Unit', 'Contract Qty', 'Today', 'Previous Cum.', 'Cum. to Date', '% Complete', 'Balance', 'Man-hours', 'Output / MH'], rows);
  y = k.ensure(y, 26);
  const lw = k.W - 140;
  k.cell(k.x0, y, lw - 160, 12, `Activities logged today: ${Wk.count}`, { bold: true, size: 7, color: COLORS.red, border: false });
  k.cell(k.x0 + lw - 160, y, 160 + 100, 12, 'Man-hours allocated to activities', { bold: true, size: 7, align: 'right', fill: COLORS.label });
  k.cell(k.x0 + lw + 100, y, 40, 12, fmtDec(Wk.man_hours_allocated), { bold: true, size: 7.5, align: 'right' });
  k.cell(k.x0 + lw - 160, y + 12, 260, 12, 'Unallocated / indirect man-hours', { bold: true, size: 7, align: 'right', fill: COLORS.label });
  k.cell(k.x0 + lw + 100, y + 12, 40, 12, fmtDec(Wk.unallocated_man_hours), { bold: true, size: 7.5, align: 'right' });
  return y + 29;
}

function sQa(k, y, m) {
  y = k.section(y, '5.  QUALITY ASSURANCE / QUALITY CONTROL');
  const cols = [{ w: 52 }, { w: 60 }, { w: 170 }, { w: 100 }, { w: 80 }, { w: k.W - 462 }];
  const rows = m.qa.entries.map((q) => ({ cells: [q.type, q.ref_no, q.description, q.location, q.result, q.remarks], size: 6.8,
    fills: [null, null, null, null, q.result === 'Rejected' ? COLORS.amber : null] }));
  if (!rows.length) rows.push({ cells: ['', '', 'No QA / QC entry for the day.', '', '', ''] });
  y = k.table(y, cols, ['Type', 'Ref No.', 'Description / Activity', 'Location', 'Result', 'Remarks'], rows);
  k.cell(k.x0, y + 1, k.W, 11, `QA/QC entries today: ${m.qa.count}`, { size: 6.8, border: false, color: COLORS.muted });
  return y + 15;
}

function sHse(k, y, m) {
  y = k.section(y, '6.  HEALTH, SAFETY & ENVIRONMENT');
  const H = m.hse;
  const lw = 125;
  const vw = (k.W - lw * 3) / 3;
  const ltir = H.ltifr === null ? '' : `${H.ltifr.toFixed(2)} / ${H.trir.toFixed(2)}`;
  const rows = [
    [['Manpower on site today', fmtInt(H.manpower_today, { dash: false })], ['Man-hours today', fmtDec(H.man_hours_today)], ['Cumulative man-hours to date', fmtDec(H.cum_man_hours)]],
    [['Safe man-hours since last LTI', fmtDec(H.safe_man_hours)], ['LTI-free days', fmtInt(H.lti_free_days, { dash: false })], ['LTIs to date', fmtInt(H.ltis_to_date, { dash: false })]],
    [['Incidents today', fmtInt(H.incidents_today, { dash: false })], ['Near misses today', fmtInt(H.near_misses_today, { dash: false })], ['First aid cases today', fmtInt(H.first_aid_today, { dash: false })]],
    [['LTI today', fmtInt(H.lti_today, { dash: false })], ['PTWs issued today', fmtInt(H.ptws_today, { dash: false })], ['HSE inspections / audits today', fmtInt(H.hse_inspections_today, { dash: false })]],
    [['Toolbox talk attendees', fmtInt(H.tbt_attendees, { dash: false })], ['Near misses to date', fmtInt(H.near_misses_to_date, { dash: false })], ['LTIFR / TRIR (per 200k MH)', ltir]],
  ];
  y = k.ensure(y, rows.length * 12 + 30);
  for (const r of rows) {
    let cx = k.x0;
    for (const [l, v] of r) {
      const alert = (l === 'Near misses today' || l === 'Incidents today' || l === 'LTI today' || l === 'First aid cases today') && Number(v) > 0;
      k.cell(cx, y, lw, 12, l, { bold: true, size: 6.8, fill: COLORS.label });
      k.cell(cx + lw, y, vw, 12, v, { bold: true, size: 7.5, align: 'center', fill: alert ? COLORS.amber : null });
      cx += lw + vw;
    }
    y += 12;
  }
  for (const [l, v] of [['Toolbox talk topic', H.tbt_topic], ['HSE observations & corrective actions', H.observations]]) {
    const h = Math.max(14, k.textH(v, k.W - lw, { size: 7 }));
    y = k.ensure(y, h);
    k.cell(k.x0, y, lw, h, l, { bold: true, size: 6.8, fill: COLORS.label });
    k.cell(k.x0 + lw, y, k.W - lw, h, v, { size: 7 });
    y += h;
  }
  return y + 5;
}

function sNcr(k, y, m) {
  y = k.section(y, `7.  NON-CONFORMANCE REPORTS – OPEN AS OF REPORT DATE  (Open / closed today: ${m.ncr.count})`);
  const cols = [{ w: 48, align: 'center' }, { w: 48, align: 'center' }, { w: 150 }, { w: 135 }, { w: 55, align: 'center' }, { w: 48, align: 'center' }, { w: 34, align: 'center' }, { w: k.W - 518, align: 'center' }];
  const rows = m.ncr.entries.map((x) => ({
    cells: [x.ncr_no, fmtDate(x.date_raised), x.description, x.corrective_action, x.responsible, fmtDate(x.target_date), x.status, String(x.days_open)],
    boldCols: [0, 6], colors: [null, null, null, null, null, null, x.status === 'Open' ? COLORS.red : null], size: 6.6,
  }));
  if (!rows.length) rows.push({ cells: ['', '', 'No open NCR.', '', '', '', '', ''] });
  return k.table(y, cols, ['NCR No.', 'Date Raised', 'Description', 'Corrective Action', 'Responsible', 'Target Date', 'Status', 'Days Open'], rows) + 5;
}

function sConcerns(k, y, m) {
  y = k.section(y, '8.  AREAS OF CONCERN / DELAYS / CONSTRAINTS – OPEN AS OF REPORT DATE');
  const cols = [{ w: 50, align: 'center' }, { w: 150 }, { w: 45, align: 'center' }, { w: 45, align: 'center' }, { w: 150 }, { w: 60, align: 'center' }, { w: k.W - 500, align: 'center' }];
  const sev = { High: COLORS.yellow, Medium: COLORS.yellow };
  const rows = m.concerns.entries.map((x) => ({
    cells: [fmtDate(x.date_raised), x.issue, x.impact, x.severity, x.action_required, x.by_whom, fmtDate(x.target_date)],
    boldCols: [3], fills: [null, null, null, sev[x.severity] || null], size: 6.6,
  }));
  if (!rows.length) rows.push({ cells: ['', 'No open concern.', '', '', '', '', ''] });
  return k.table(y, cols, ['Date Raised', 'Issue', 'Impact', 'Severity', 'Action Required', 'By Whom', 'Target Date'], rows) + 5;
}

function sPlan(k, y, m) {
  y = k.section(y, '9.  PLANNED ACTIVITIES – NEXT WORKING DAY');
  return k.textBox(y, m.next_day_plan) + 5;
}
function sRemarks(k, y, m) {
  y = k.section(y, '10.  GENERAL REMARKS / INSTRUCTIONS / RFIs / VISITORS');
  return k.textBox(y, m.remarks) + 5;
}
function sSignatures(k, y, m) {
  y = k.ensure(y + 4, 80);
  const w = k.W / 3;
  const titles = ['PREPARED BY (CONTRACTOR)', 'REVIEWED BY (CONTRACTOR)', "CONSULTANT'S REPRESENTATIVE"];
  const names = [m.signatures.prepared_by, m.signatures.reviewed_by, m.signatures.consultant_rep];
  titles.forEach((t, i) => {
    const x = k.x0 + i * w;
    k.cell(x, y, w, 14, t, { bold: true, size: 7, align: 'center', fill: COLORS.head });
    k.cell(x, y + 14, w, 36, 'Signature:', { size: 6.5, valign: 'top', color: COLORS.muted });
    k.cell(x, y + 50, w, 13, names[i], { bold: true, size: 7 });
    k.cell(x, y + 63, w, 12, 'Date:', { size: 6.5, color: COLORS.muted });
  });
  return y + 80;
}

function sPhotos(k, m, photoBuffers) {
  const doc = k.doc;
  const photos = (m.photos || []).slice().sort((a, b) => a.slot - b.slot);
  const perPage = 6;
  const pages = Math.max(1, Math.ceil(photos.length / perPage));
  for (let p = 0; p < pages; p += 1) {
    doc.addPage();
    let y = k.section(k.top, p === 0 ? '11.  SITE PHOTOGRAPHS' : '11.  SITE PHOTOGRAPHS (continued)');
    const fw = (k.W - 6) / 2;
    const fh = 205;
    for (let i = 0; i < perPage; i += 1) {
      const ph = photos[p * perPage + i];
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = k.x0 + col * (fw + 6);
      const yy = y + row * (fh + 40);
      doc.lineWidth(0.6).strokeColor('#8EA9DB').rect(x, yy, fw, fh).stroke();
      const n = p * perPage + i + 1;
      const buf = ph ? photoBuffers.get(ph.photo_id) : null;
      if (buf) {
        try {
          doc.image(buf, x + 3, yy + 3, { fit: [fw - 6, fh - 6], align: 'center', valign: 'center' });
        } catch (_) {
          k.cell(x, yy, fw, fh, 'Photo could not be read', { size: 9, align: 'center', border: false, color: COLORS.muted });
        }
      } else {
        k.cell(x, yy, fw, fh, `PHOTO ${n}`, { bold: true, size: 14, align: 'center', border: false, color: '#D9D9D9' });
      }
      k.cell(x, yy + fh, 36, 13, `No. ${ph ? ph.slot : n}`, { bold: true, size: 6.8, fill: COLORS.yellow });
      k.cell(x + 36, yy + fh, fw * 0.55 - 36, 13, `BOQ / Activity: ${ph ? ph.boq_activity : ''}`, { size: 6.5, fill: COLORS.yellow });
      k.cell(x + fw * 0.55, yy + fh, fw * 0.45, 13, `Location: ${ph ? ph.location : ''}`, { size: 6.5, fill: COLORS.yellow });
      k.cell(x, yy + fh + 13, fw, 13, `Caption: ${ph ? ph.caption : ''}`, { size: 6.5, fill: COLORS.yellow });
    }
  }
}

function sAlloc(k, m, meta) {
  const doc = k.doc;
  const A = m.allocation;
  const nAct = A.activities.length;
  const perPage = 12;
  const chunks = Math.max(1, Math.ceil(nAct / perPage));
  for (let ch = 0; ch < chunks; ch += 1) {
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
    const kk = new Kit(doc, { landscape: true });
    const acts = A.activities.slice(ch * perPage, ch * perPage + perPage);
    const idx = acts.map((_, i) => ch * perPage + i);
    let y = kk.top;
    kk.cell(kk.x0, y, kk.W, 16, 'RESOURCE ALLOCATION MATRIX – Distribution of Deployed Resources over BOQ Activities', { bold: true, size: 11, color: COLORS.navy, border: false });
    y += 17;
    kk.cell(kk.x0, y, 50, 12, 'Project', { bold: true, size: 7, fill: COLORS.label });
    kk.cell(kk.x0 + 50, y, kk.W - 330, 12, m.header.project_name, { size: 7 });
    kk.cell(kk.x0 + kk.W - 280, y, 55, 12, 'Report No.', { bold: true, size: 7, fill: COLORS.label });
    kk.cell(kk.x0 + kk.W - 225, y, 80, 12, m.header.report_no + (meta.revision ? ` Rev.${meta.revision}` : ''), { bold: true, size: 7.5, align: 'center' });
    kk.cell(kk.x0 + kk.W - 145, y, 60, 12, 'Report Date', { bold: true, size: 7, fill: COLORS.label });
    kk.cell(kk.x0 + kk.W - 85, y, 85, 12, fmtDate(m.header.report_date), { bold: true, size: 7.5, align: 'center', fill: COLORS.yellow });
    y += 14;
    kk.cell(kk.x0, y, kk.W, 11, 'Allocations are entered per activity. Deployed = resources on site. Unallocated = idle or indirect (e.g. staff, bus drivers). Red = more allocated than deployed – correct the entries.',
      { size: 6.3, border: false, color: COLORS.muted });
    y += 13;
    const fixed = [16, 140, 62, 40];
    const tail = [44, 48, 42, 62];
    const actW = (kk.W - fixed.reduce((a, b) => a + b, 0) - tail.reduce((a, b) => a + b, 0)) / perPage;
    const cols = [...fixed.map((w, i) => ({ w, align: i === 1 || i === 2 ? 'left' : 'center' })), ...Array.from({ length: perPage }, () => ({ w: actW, align: 'center' })), ...tail.map((w) => ({ w, align: 'center' }))];
    const blank = Array.from({ length: perPage }, () => '');
    const actCells = (fn) => Array.from({ length: perPage }, (_, i) => (i < acts.length ? fn(acts[i], idx[i]) : ''));
    const head = [
      { cells: ['', 'BOQ Item →', '', '', ...actCells((a) => a.item_no), '', '', '', ''], bold: true, fill: COLORS.head, size: 6.5 },
      { cells: ['', 'Location →', '', '', ...actCells((a) => a.location), '', '', '', ''], fill: COLORS.head, size: 5.6, fixedH: 15 },
      { cells: ['', 'Qty today →', '', '', ...actCells((a) => `${fmtDec(a.qty, { min: 1 })} ${a.unit}`), '', '', '', ''], fill: COLORS.head, size: 5.6, fixedH: 10 },
    ];
    y = kk.table(y, cols, null, head, { minH: 11 });
    const hdr = ['#', 'Resource', 'Group', 'Deployed', ...Array.from({ length: perPage }, (_, i) => `Act ${ch * perPage + i + 1}`), 'Total Allocated', 'Unallocated / Idle', 'Utilisation', 'Status'];
    const rows = A.rows.map((r, i) => ({
      cells: [String(i + 1), r.resource, r.group, fmtInt(r.deployed), ...actCells((_, j) => fmtInt(r.per_activity[j])), fmtInt(r.allocated), fmtInt(r.idle), fmtPct(r.utilisation, 0), r.status],
      size: 6.2,
      colors: [...Array(4 + perPage + 1).fill(null), r.idle < 0 ? COLORS.red : null, null, r.status === 'Over-allocated' ? COLORS.red : null],
      fills: [...Array(4 + perPage + 3).fill(null), r.status === 'Over-allocated' ? COLORS.amber : (r.status === 'Balanced' ? COLORS.green : null)],
    }));
    const tot = (label, t, per) => ({ span: 3, cells: [label, '', '', fmtInt(t.deployed, { dash: false }), ...actCells((_, j) => fmtInt(per[j])), fmtInt(t.allocated, { dash: false }), fmtInt(t.idle, { dash: false }), fmtPct(t.utilisation, 0), ''], bold: true, fill: COLORS.total, size: 6.5 });
    rows.push(tot('TOTAL MANPOWER (nos)', A.manpower, A.manpower.per_activity));
    rows.push(tot('TOTAL PLANT (nos)', A.plant, A.plant.per_activity));
    rows.push({ span: 3, cells: ['MAN-HOURS', '', '', fmtDec(A.man_hours.deployed), ...actCells((_, j) => fmtDec(A.man_hours.per_activity[j])), fmtDec(A.man_hours.allocated), fmtDec(A.man_hours.idle), '', ''], bold: true, size: 6.5 });
    rows.push({ span: 3, cells: ['EQUIPMENT-HOURS', '', '', fmtDec(A.equip_hours.deployed), ...actCells((_, j) => fmtDec(A.equip_hours.per_activity[j])), fmtDec(A.equip_hours.allocated), fmtDec(A.equip_hours.idle), '', ''], bold: true, size: 6.5 });
    rows.push({ span: 3, cells: ['OUTPUT PER MAN-HOUR (unit/MH)', '', '', '', ...actCells((_, j) => fmtRatio(A.output_per_mh[j], 3)), '', '', '', ''], size: 6.3 });
    rows.push({ span: 3, cells: ['OUTPUT PER MAN-DAY (unit/MD)', '', '', '', ...actCells((_, j) => fmtRatio(A.output_per_md[j], 2)), '', '', '', ''], size: 6.3 });
    // labels of total rows span the first 3 columns: draw them as one cell after the table
    const dense = rows.length > 40;
    if (dense) rows.forEach((r) => { r.size = Math.min(r.size || 6.2, 5.8); });
    y = kk.table(y, cols, hdr, rows, { minH: dense ? 8.4 : 9.6, headSize: 6.3, pad: dense ? 1 : 2 });
    kk.cell(kk.x0, y + 2, kk.W, 11, `Activities logged today: ${nAct}${nAct > perPage ? `  –  page ${ch + 1} of ${chunks} of activity columns; totals include all activities.` : ''}`,
      { bold: true, size: 7, border: false, color: COLORS.red });
    void blank;
  }
}

// ------------------------------------------------------------------ main
/**
 * @param {object} m          report model
 * @param {object} meta       { revision, issued, issued_at, issued_by, contract_code, contract_title }
 * @param {Map<number, Buffer>} photoBuffers
 * @returns {Promise<Buffer>}
 */
function renderDprPdf(m, meta = {}, photoBuffers = new Map()) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, autoFirstPage: true,
        info: { Title: `Daily Progress Report ${m.header.report_no}`, Author: m.header.company_name || 'Team Flow', Subject: m.contract ? `${m.contract.code} – ${m.contract.title}` : '' } });
      doc.registerFont('R', FONTS.regular);
      doc.registerFont('B', FONTS.bold);
      doc.registerFont('AR', FONTS.arabic);
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      const k = new Kit(doc);
      const on = m.sections || {};
      const show = (key) => on[key] !== false;

      // page 1
      let y = drawHeader(k, m, meta);
      if (show('weather')) y = sWeather(k, y, m);
      if (show('manpower')) y = sManpower(k, y, m);
      if (show('subcon')) y = sSubcon(k, y, m);
      if (show('summary')) y = sSummary(k, y, m);
      // page 2
      const p2 = ['work', 'qa', 'hse'].some(show);
      if (p2) { doc.addPage(); y = k.top; }
      if (show('work')) y = sWork(k, y, m);
      if (show('qa')) y = sQa(k, y, m);
      if (show('hse')) y = sHse(k, y, m);
      // page 3
      const p3 = ['ncr', 'concerns', 'plan', 'remarks', 'signatures'].some(show);
      if (p3) { doc.addPage(); y = k.top; }
      if (show('ncr')) y = sNcr(k, y, m);
      if (show('concerns')) y = sConcerns(k, y, m);
      if (show('plan')) y = sPlan(k, y, m);
      if (show('remarks')) y = sRemarks(k, y, m);
      if (show('signatures')) y = sSignatures(k, y, m);
      // page 4+
      if (show('photos')) sPhotos(k, m, photoBuffers);
      if (show('alloc')) sAlloc(k, m, meta);

      // footer + DRAFT mark on every page
      const range = doc.bufferedPageRange();
      const stamp = fmtStamp(meta.printed_at ? new Date(meta.printed_at) : new Date());
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        const pw = doc.page.width;
        const ph = doc.page.height;
        const left = `Daily Progress Report${m.contract ? ` – ${m.contract.code}` : ''}  ${m.header.report_no}${meta.revision ? ` Rev.${meta.revision}` : ''}`;
        doc.font('R').fontSize(6.5).fillColor(COLORS.muted);
        doc.text(left, 22, ph - 20, { width: 260, lineBreak: false });
        doc.text(`Page ${i + 1} of ${range.count}`, pw / 2 - 50, ph - 20, { width: 100, align: 'center', lineBreak: false });
        doc.text(meta.issued ? `Issued ${meta.issued_at || ''}${meta.issued_by ? ` by ${meta.issued_by}` : ''}` : `DRAFT – printed ${stamp}`,
          pw - 282, ph - 20, { width: 260, align: 'right', lineBreak: false });
        if (!meta.issued) {
          doc.save();
          doc.rotate(-30, { origin: [pw / 2, ph / 2] });
          doc.font('B').fontSize(90).fillColor('#C00000').opacity(0.07).text('DRAFT', 0, ph / 2 - 50, { width: pw, align: 'center', lineBreak: false });
          doc.restore();
          doc.opacity(1);
        }
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { renderDprPdf, fmtDate, fmtDec, fmtInt, fmtPct, fmtRatio };
