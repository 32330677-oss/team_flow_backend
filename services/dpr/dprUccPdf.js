// services/dpr/dprUccPdf.js
//
// The daily report as PDF in the CLIENT'S FORM (UCC-IMS-CM-3003A), from the model
// of services/dpr/dprUcc.js (or the frozen snapshot of an issued report).
// Every page has the form header (logo, Integrated Management System, document
// reference, Rev. No. / Rev. Date, page number, report date). What is printed
// follows the layout chosen by the QC (sections, tables, columns, titles, empty rows).
// Numbers are printed exactly as stored (thousands separated, never rounded).
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

const COL = {
  ink: '#000000',
  line: '#595959',
  grey: '#D9D9D9',
  head: '#E7E6E6',
  label: '#8C8C46',
  section: '#E2EFDA',
  muted: '#595959',
  red: '#C00000',
  bar: '#BFBFBF',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

// ------------------------------------------------------------------ formatting
function fmtDate(d) {
  if (!d) return '';
  const [y, m, dd] = String(d).slice(0, 10).split('-');
  if (!y || !m || !dd) return String(d);
  return `${dd}-${MONTHS[Number(m) - 1]}-${y}`;
}
function fmtNum(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${g}${f ? `.${f}` : ''}`;
}
function fmtStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ------------------------------------------------------------------ drawing kit
class Kit {
  constructor(doc, m, meta) {
    this.doc = doc;
    this.m = m;
    this.meta = meta;
    this.margin = 26;
    this.headerH = 74;
  }
  get W() { return this.doc.page.width - this.margin * 2; }
  get x0() { return this.margin; }
  get bottom() { return this.doc.page.height - 34; }
  get top() { return this.margin + this.headerH + 8; }

  prep(text, bold, size) {
    const t = text === null || text === undefined ? '' : String(text);
    if (ARABIC.test(t)) {
      this.doc.font('AR').fontSize(size);
      let s = t;
      if (reshaper && reshaper.convertArabic) s = reshaper.convertArabic(t);
      return { t: s.split('').reverse().join(''), rtl: true };
    }
    this.doc.font(bold ? 'B' : 'R').fontSize(size);
    return { t, rtl: false };
  }
  textH(text, w, { bold = false, size = 7.5, pad = 2 } = {}) {
    const { t } = this.prep(text, bold, size);
    if (!t) return size + pad * 2;
    return this.doc.heightOfString(t, { width: Math.max(w - pad * 2, 4), lineGap: 0 }) + pad * 2;
  }
  cell(x, y, w, h, text, o = {}) {
    const { bold = false, size = 7.5, align = 'left', fill = null, color = COL.ink, border = true, pad = 2, valign = 'middle', underline = false } = o;
    const doc = this.doc;
    if (fill) doc.rect(x, y, w, h).fill(fill);
    if (border) doc.lineWidth(0.5).strokeColor(COL.line).rect(x, y, w, h).stroke();
    const { t, rtl } = this.prep(text, bold, size);
    if (!t) return;
    const tw = Math.max(w - pad * 2, 4);
    const th = doc.heightOfString(t, { width: tw, lineGap: 0 });
    let ty = y + pad;
    if (valign === 'middle') ty = y + Math.max((h - th) / 2, pad);
    doc.fillColor(color).text(t, x + pad, ty, {
      width: tw, height: Math.max(h - pad, size), align: rtl && align === 'left' ? 'right' : align, lineGap: 0, ellipsis: true, underline,
    });
  }
  newPage() {
    this.doc.addPage();
    this.drawPageHeader();
    return this.top;
  }
  ensure(y, h) {
    if (y + h <= this.bottom) return y;
    return this.newPage();
  }
  /** The form header on every page (page number filled at the end). */
  drawPageHeader() {
    const H = this.m.header;
    const doc = this.doc;
    const x = this.x0;
    const y = this.margin;
    const logoW = 150;
    const rightW = 150;
    const midW = this.W - logoW - rightW;
    const h = this.headerH;
    try {
      if (fs.existsSync(LOGO)) doc.image(LOGO, x + 6, y + 4, { fit: [logoW - 12, h - 8], align: 'center', valign: 'center' });
    } catch (_) { /* no logo */ }
    const rowH = h / 3;
    this.cell(x + logoW, y, midW, rowH, H.system_title, { bold: true, size: 9, align: 'center', fill: COL.grey });
    this.cell(x + logoW, y + rowH, midW, rowH, H.department, { bold: true, size: 9, align: 'center', fill: COL.grey });
    this.cell(x + logoW, y + rowH * 2, midW, rowH, H.form_title, { bold: true, size: 10, align: 'center' });
    const rx = x + logoW + midW;
    const half = rightW / 2;
    const r6 = h / 6;
    this.cell(rx, y, rightW, r6, 'Document Reference', { bold: true, size: 6.5, align: 'center', fill: COL.head });
    this.cell(rx, y + r6, rightW, r6, H.doc_ref, { size: 7, align: 'center' });
    this.cell(rx, y + r6 * 2, half, r6, 'Rev. No.', { bold: true, size: 6.5, align: 'center', fill: COL.head });
    this.cell(rx + half, y + r6 * 2, half, r6, 'Rev. Date', { bold: true, size: 6.5, align: 'center', fill: COL.head });
    this.cell(rx, y + r6 * 3, half, r6, H.rev_no, { size: 7, align: 'center' });
    this.cell(rx + half, y + r6 * 3, half, r6, H.rev_date ? fmtDate(H.rev_date) : '', { size: 7, align: 'center' });
    this.cell(rx, y + r6 * 4, half, r6, 'Page Number', { bold: true, size: 6.5, align: 'center', fill: COL.head });
    this.cell(rx + half, y + r6 * 4, half, r6, 'Rep. Date', { bold: true, size: 6.5, align: 'center', fill: COL.head });
    this.cell(rx, y + r6 * 5, half, r6, '', { size: 7, align: 'center' });
    this.cell(rx + half, y + r6 * 5, half, r6, fmtDate(H.report_date), { size: 7, align: 'center' });
    this.pageNoBox = { x: rx, y: y + r6 * 5, w: half, h: r6 };
  }
  bar(y, title, need = 30) {
    if (!title) return y;
    y = this.ensure(y, 16 + need);
    this.cell(this.x0, y, this.W, 15, title, { bold: true, size: 8.5, align: 'center', fill: COL.grey });
    return y + 17;
  }
  /**
   * cols: [{ w, align, head }]; rows: [{ cells: [text], bold, fill, span }]
   * A row that does not fit goes to the next page with the column heads again.
   */
  table(y, cols, rows, o = {}) {
    const { size = 7.2, headSize = 7, minH = 12, x = this.x0, headFill = COL.head, pad = 2, head = true } = o;
    const drawHead = (yy) => {
      if (!head) return yy;
      const h = Math.max(...cols.map((c) => this.textH(c.head, c.w, { bold: true, size: headSize })), 15);
      let cx = x;
      for (const c of cols) {
        this.cell(cx, yy, c.w, h, c.head, { bold: true, size: headSize, align: 'center', fill: headFill });
        cx += c.w;
      }
      return yy + h;
    };
    y = this.ensure(y, 30);
    y = drawHead(y);
    for (const r of rows) {
      const span = Math.max(1, r.span || 1);
      const widthOf = (i) => (i === 0 ? cols.slice(0, span).reduce((a, c) => a + c.w, 0) : cols[i].w);
      const shown = r.cells.map((t, i) => ({ t, i })).filter(({ i }) => i === 0 || i >= span);
      const h = Math.max(minH, ...shown.map(({ t, i }) => this.textH(t, widthOf(i), { bold: r.bold, size: r.size || size, pad })));
      if (y + h > this.bottom) y = drawHead(this.newPage());
      let cx = x;
      for (const { t, i } of shown) {
        const w = widthOf(i);
        this.cell(cx, y, w, h, t, {
          bold: r.bold, size: r.size || size, pad, fill: r.fill || null,
          align: (r.align && r.align[i]) || (i === 0 && span > 1 ? (r.spanAlign || 'left') : cols[i].align) || 'left',
          color: (r.colors && r.colors[i]) || COL.ink,
        });
        cx += w;
      }
      y += h;
    }
    return y;
  }
}

// ------------------------------------------------------------------ layout helpers
const L = (m) => m.layout || { sections: {}, tables: {}, columns: {}, titles: {}, hide_empty: {} };
const secOn = (m, k) => L(m).sections[k] !== false;
const tabOn = (m, k) => L(m).tables[k] !== false;
const colOn = (m, t, c) => L(m).columns[`${t}.${c}`] !== false;
const title = (m, k, dflt) => {
  const t = L(m).titles[k];
  return t === undefined || t === null ? dflt : t;
};
const sub = (m, s, extra = {}) => String(s || '').replace(/\{code\}/g, m.contract.code).replace(/\{area\}/g, extra.area || '');

/** Visible columns of a table, widths scaled to `width` (weights given). */
function columns(m, table, defs, width) {
  const vis = defs.filter((d) => d.always || colOn(m, table, d.key));
  const total = vis.reduce((a, d) => a + d.w, 0) || 1;
  return vis.map((d) => ({ ...d, w: (d.w / total) * width, head: title(m, `col.${table}.${d.key}`, d.head) }));
}
const cellV = (c) => (c && c.v !== null && c.v !== undefined ? fmtNum(c.v) : '');

// ------------------------------------------------------------------ page 1: project information
function sProject(k, y) {
  const m = k.m;
  const H = m.header;
  if (secOn(m, 'project')) {
    const t = title(m, 'project', 'PROJECT DAILY REPORT');
    if (t) {
      k.prep(t, true, 8);
      k.doc.fillColor(COL.ink).text(t, k.x0, y, { underline: true });
      y += 14;
    }
    const lw = 92;
    const vw = k.W / 2 - lw;
    const rows = [
      ['Project Ref.', H.project_ref, 'Contract', H.contract_ref],
      ['Project Name', H.project_name, 'Project Location', H.project_location],
      ['Client', H.client, 'Commencement Date', fmtDate(H.commencement_date)],
      ['Consultant', H.consultant, 'Completion Date', fmtDate(H.completion_date)],
      ['Project Manager', H.project_manager, 'Report Date', fmtDate(H.report_date)],
    ];
    for (const r of rows) {
      const h = Math.max(14, k.textH(r[1], vw, { size: 7.5 }), k.textH(r[3], vw, { size: 7.5 }));
      k.cell(k.x0, y, lw, h, r[0], { bold: true, size: 7.5, fill: COL.label, color: '#FFFFFF' });
      k.cell(k.x0 + lw, y, vw, h, r[1], { size: 7.5, align: 'center' });
      k.cell(k.x0 + lw + vw, y, lw, h, r[2], { bold: true, size: 7.5, fill: COL.label, color: '#FFFFFF' });
      k.cell(k.x0 + lw * 2 + vw, y, vw, h, r[3], { size: 7.5, align: 'center' });
      y += h;
    }
    y += 6;
  }
  if (H.report_title) {
    k.cell(k.x0, y, k.W, 16, H.report_title, { bold: true, size: 10, align: 'center', border: false });
    y += 18;
  }
  return y;
}

/** Cover / maps: the first one under the project block, the others one per page. */
function sCover(k, y, pages, buffers) {
  const imgs = pages.filter((p) => buffers.has(p.page_id));
  if (!imgs.length) return { y, used: false };
  let first = true;
  for (const p of imgs) {
    if (!first) y = k.newPage();
    const h = k.bottom - y;
    if (p.title) {
      k.cell(k.x0, y, k.W, 14, p.title, { bold: true, size: 8, align: 'center', border: false });
      y += 15;
    }
    try {
      k.doc.image(buffers.get(p.page_id), k.x0, y, { fit: [k.W, h - (p.title ? 15 : 0) - 4], align: 'center', valign: 'center' });
    } catch (_) { /* not an image: skipped */ }
    first = false;
  }
  return { y: k.newPage(), used: true };
}

// ------------------------------------------------------------------ weather
function box(k, x, y, checked) {
  const doc = k.doc;
  doc.lineWidth(0.6).strokeColor(COL.line).rect(x, y, 14, 9).stroke();
  if (checked) {
    doc.lineWidth(1.2).strokeColor('#2E7D32').moveTo(x + 3, y + 4.5).lineTo(x + 6, y + 7.5).lineTo(x + 11.5, y + 1.5).stroke();
  }
}
function sWeather(k, y) {
  const m = k.m;
  const w = m.weather || {};
  const lists = m.lists || {};
  const conds = lists.weather_conditions || ['SUNNY', 'CLOUDY', 'RAINY', 'DUSTY'];
  const hums = lists.humidity_levels || ['HIGH', 'MEDIUM', 'LOW'];
  y = k.ensure(y, 50);
  const t = title(m, 'weather', 'WEATHER');
  const x = k.x0;
  const half = k.W / 2;
  if (t) { k.prep(t, true, 7.5); k.doc.fillColor(COL.ink).text(t, x, y); }
  k.prep('TEMP', true, 7.5);
  k.doc.text('TEMP', x + half, y);
  y += 11;
  // conditions: two per row
  const per = 2;
  const colW = half / per;
  let row = 0;
  conds.forEach((c, i) => {
    const cx = x + 8 + (i % per) * colW;
    const cy = y + Math.floor(i / per) * 16;
    k.prep(c, false, 7.5);
    k.doc.fillColor(COL.ink).text(c, cx, cy + 1, { width: colW - 30 });
    box(k, cx + colW - 34, cy, String(w.condition || '').toUpperCase() === String(c).toUpperCase());
    row = Math.floor(i / per);
  });
  // temperature + humidity
  const tx = x + half + 8;
  k.prep('MAX', false, 7.5);
  k.doc.text('MAX', tx, y + 1);
  k.cell(tx + 30, y - 1, 34, 11, fmtNum(w.temp_max), { size: 7.5, align: 'center' });
  k.prep('MIN', false, 7.5);
  k.doc.text('MIN', tx + 90, y + 1);
  k.cell(tx + 118, y - 1, 34, 11, fmtNum(w.temp_min), { size: 7.5, align: 'center' });
  k.prep('HUMIDITY', true, 7.5);
  k.doc.text('HUMIDITY', x + half, y + 16);
  const hw = (half - 8) / hums.length;
  hums.forEach((h, i) => {
    const hx = tx + i * hw;
    k.prep(h, false, 7.5);
    k.doc.fillColor(COL.ink).text(h, hx, y + 29, { width: hw - 22 });
    box(k, hx + hw - 24, y + 28, String(w.humidity_level || '').toUpperCase() === String(h).toUpperCase());
  });
  y += Math.max((row + 1) * 16, 40) + 4;
  if (w.remarks) {
    k.prep(w.remarks, false, 7);
    k.doc.fillColor(COL.muted).text(w.remarks, x, y, { width: k.W });
    y = k.doc.y + 4;
  }
  return y + 4;
}

// ------------------------------------------------------------------ two tables side by side (staff | tradesmen, plant | tools)
function sideBySide(k, y, left, right) {
  const m = k.m;
  const parts = [left, right].filter((p) => p && tabOn(m, p.key));
  if (!parts.length) return y;
  const gap = 0;
  const width = (k.W - gap * (parts.length - 1)) / parts.length;
  const prepared = parts.map((p) => {
    const defs = [{ key: 'name', head: title(m, `table.${p.key}`, p.head), w: 2.6, always: true },
      ...p.fields.map(([f, h]) => ({ key: f, head: h, w: 1.1, align: 'center' }))];
    const cols = columns(m, p.key, defs, width);
    const hideEmpty = L(m).hide_empty[p.key] === true;
    const rows = p.data.rows.filter((r) => !hideEmpty || cols.slice(1).some((c) => cellV(r.cells[c.key]) !== ''));
    return { p, cols, rows };
  });
  const n = Math.max(...prepared.map((x) => x.rows.length), 1);
  const headH = 14;
  // rows get smaller (down to 9 pt) to keep the table on one page; a table that cannot fit starts a new page
  const free = k.bottom - y - headH;
  let rowH = Math.min(11.5, Math.max(9, free / (n + 1)));
  if (rowH * (n + 1) > free) {
    y = k.newPage();
    rowH = Math.min(11.5, Math.max(9, (k.bottom - y - headH) / (n + 1)));
  }
  // heads
  let x = k.x0;
  for (const pr of prepared) {
    let cx = x;
    for (const c of pr.cols) {
      k.cell(cx, y, c.w, headH, c.head, { bold: true, size: 6.4, align: 'center', fill: COL.head, pad: 1 });
      cx += c.w;
    }
    x += width + gap;
  }
  y += headH;
  for (let i = 0; i <= n; i += 1) {
    if (y + rowH > k.bottom) {
      y = k.newPage();
    }
    x = k.x0;
    const isTotal = i === n;
    for (const pr of prepared) {
      let cx = x;
      const r = isTotal ? null : pr.rows[i];
      for (const c of pr.cols) {
        let v = '';
        if (isTotal) v = c.key === 'name' ? 'TOTAL' : cellV(pr.p.data.total[c.key]);
        else if (r) v = c.key === 'name' ? r.name : cellV(r.cells[c.key]);
        k.cell(cx, y, c.w, rowH, v, { size: rowH < 10 ? 6.2 : 6.8, pad: 1.5, bold: isTotal, align: c.key === 'name' ? 'left' : 'center', fill: isTotal ? COL.head : null });
        cx += c.w;
      }
      x += width + gap;
    }
    y += rowH;
  }
  return y;
}

function sManpower(k, y) {
  const m = k.m;
  const mp = m.manpower;
  y = k.bar(y, sub(m, title(m, 'manpower', '')), 60);
  y = sideBySide(k, y,
    { key: 'staff', head: 'STAFF', fields: [['total', 'TOTAL'], ['present', 'PRESENT'], ['absent', 'ABSENT']], data: mp.staff },
    { key: 'trades', head: 'TRADESMEN', fields: [['total', 'TOTAL'], ['present', 'PRESENT'], ['absent', 'ABSENT']], data: mp.trades });
  if (tabOn(m, 'staff') || tabOn(m, 'trades')) {
    y = k.ensure(y, 14);
    const g = mp.grand;
    const parts = ['total', 'present', 'absent'].filter((f) => colOn(m, 'trades', f) || colOn(m, 'staff', f));
    const txt = parts.map((f) => (f === 'total' ? cellV(g.total) : `${f.toUpperCase()} ${cellV(g[f])}`)).filter(Boolean).join('     ');
    k.cell(k.x0, y, k.W / 2, 13, 'GRAND TOTAL', { bold: true, size: 7.5, align: 'center', fill: COL.head });
    k.cell(k.x0 + k.W / 2, y, k.W / 2, 13, txt, { bold: true, size: 7.5, align: 'center', fill: COL.head });
    y += 17;
  }
  return y;
}

function sPlant(k, y) {
  const m = k.m;
  y = k.bar(y, sub(m, title(m, 'plant', '')), 60);
  return sideBySide(k, y,
    { key: 'plant', head: 'PLANT', fields: [['operative', 'OPERATIVE'], ['breakdown', 'BREAKDOWN'], ['idle', 'IDLE']], data: m.plant.plant },
    { key: 'tools', head: 'TOOL', fields: [['operative', 'OPERATIVE'], ['breakdown', 'BREAKDOWN'], ['idle', 'IDLE']], data: m.plant.tools }) + 6;
}

// ------------------------------------------------------------------ BOQ
function sBoq(k, y) {
  const m = k.m;
  if (!tabOn(m, 'boq')) return y;
  const groups = (m.boq && m.boq.groups) || [];
  if (!groups.some((g) => g.rows.length)) return y;
  y = k.newPage();
  y = k.bar(y, sub(m, title(m, 'boq', 'PROJECT - OVERALL PROGRESS')), 60);
  const defs = [
    { key: 'task_code', head: 'Task Code', w: 0.7, align: 'center' }, { key: 'cost_code', head: 'Cost Code', w: 0.8, align: 'center' },
    { key: 'description', head: 'Description', w: 5, always: true }, { key: 'unit', head: 'Unit', w: 0.6, align: 'center' },
    { key: 'qty', head: 'Quantity', w: 0.95, align: 'right' }, { key: 'budget', head: 'BUDGET', w: 0.9, align: 'right' },
    { key: 'curr', head: 'CURR', w: 0.85, align: 'right' }, { key: 'cum', head: 'CUMUL', w: 0.95, align: 'right' },
    { key: 'balance', head: 'BALANCE', w: 0.95, align: 'right' },
  ];
  const cols = columns(m, 'boq', defs, k.W);
  const hideEmpty = L(m).hide_empty.boq === true;
  groups.forEach((g, gi) => {
    if (!g.rows.length) return;
    if (g.name) {
      y = k.ensure(y + (gi ? 8 : 0), 40);
      k.cell(k.x0, y, k.W, 14, g.name, { bold: true, size: 8, align: 'center', border: false });
      y += 15;
    }
    const rows = [];
    for (const r of g.rows) {
      if (r.row_type !== 'item') {
        const cells = cols.map((c) => {
          if (c.key === 'description') return r.description;
          if (c.key === 'unit') return r.unit || '';
          if (c.key === 'qty') return fmtNum(r.qty);
          if (c.key === 'cost_code') return r.cost_code || '';
          return '';
        });
        rows.push({ cells, bold: r.row_type === 'section', fill: r.row_type === 'section' ? COL.section : null,
          align: cols.map((c) => (c.key === 'description' ? 'center' : c.align)), size: r.row_type === 'text' ? 6.6 : 7.2 });
        continue;
      }
      const vals = {
        task_code: r.item_no, cost_code: r.cost_code || '', description: r.description, unit: r.unit,
        qty: cellV(r.cells.qty), budget: cellV(r.cells.budget), curr: cellV(r.cells.curr) === '0' ? '' : cellV(r.cells.curr),
        cum: cellV(r.cells.cum) === '0' ? '' : cellV(r.cells.cum), balance: cellV(r.cells.balance),
      };
      if (hideEmpty && !vals.curr && !vals.cum) continue;
      rows.push({
        cells: cols.map((c) => vals[c.key]),
        align: cols.map((c) => (c.key === 'description' ? 'center' : c.align)),
        colors: cols.map((c) => (r.over && (c.key === 'cum' || c.key === 'balance') ? COL.red : COL.ink)),
      });
    }
    y = k.table(y, cols, rows, { size: 7.2, minH: 13 });
  });
  return y + 8;
}

// ------------------------------------------------------------------ activities of the day
function sActivities(k, y) {
  const m = k.m;
  if (!tabOn(m, 'activities') || !(m.activities || []).length) return y;
  y = k.ensure(y, 60);
  y = k.bar(y, sub(m, title(m, 'activities', 'ACTIVITIES')), 40);
  const defs = [
    { key: 'no', head: '', w: 0.5, align: 'center' }, { key: 'description', head: 'Description', w: 6, always: true, align: 'center' },
    { key: 'location', head: 'Location', w: 2.2, align: 'center' }, { key: 'boq', head: 'BOQ', w: 0.9, align: 'center' },
    { key: 'qty', head: 'Qty', w: 1, align: 'right' }, { key: 'unit', head: 'Unit', w: 0.7, align: 'center' },
    { key: 'area', head: 'Area', w: 1.4, align: 'center' }, { key: 'chainage', head: 'Chainage', w: 1.2, align: 'center' },
  ];
  // the client's form shows No. / Description / Location: the other columns are printed when switched on in the layout
  const cols = columns(m, 'activities', defs, k.W);
  const rows = m.activities.map((a, i) => {
    const v = { no: String(i + 1), description: a.description, location: a.location, boq: a.item_no, qty: Number(a.qty) ? fmtNum(a.qty) : '',
      unit: Number(a.qty) ? a.unit : '', area: a.area, chainage: a.chainage };
    return { cells: cols.map((c) => v[c.key] || '') };
  });
  return k.table(y, cols, rows, { minH: 14 }) + 8;
}

// ------------------------------------------------------------------ area / bridge pages
function sAreas(k, y, buffers) {
  const m = k.m;
  const areas = m.areas || [];
  const defs = [
    { key: 'item', head: 'Bill Item', w: 0.8, align: 'center' }, { key: 'activity', head: 'ACTIVITY', w: 3, align: 'center' },
    { key: 'chainage', head: 'CHAINAGE', w: 1.1, align: 'center' }, { key: 'plant', head: 'PLANT', w: 1.8, align: 'center' },
    { key: 'plant_no', head: 'No.', w: 0.5, align: 'center' }, { key: 'plant_hrs', head: 'W-HRS', w: 0.7, align: 'center' },
    { key: 'trade', head: 'TRADESMEN', w: 2, align: 'center' }, { key: 'trade_no', head: 'No.', w: 0.5, align: 'center' },
    { key: 'trade_hrs', head: 'W-HRS', w: 0.7, align: 'center' }, { key: 'unit', head: 'UNIT', w: 0.6, align: 'center' },
    { key: 'output', head: 'OUTPUT', w: 0.8, align: 'center' },
  ];
  for (const a of areas) {
    y = k.newPage();
    const t = sub(m, title(m, 'areas', '{area} - DAILY PROGRESS'), { area: a.name });
    k.prep(t, true, 8);
    k.doc.fillColor(COL.ink).text(t, k.x0, y);
    y += 13;
    if (tabOn(m, 'area') && a.activities.length) {
      const cols = columns(m, 'area', defs, k.W);
      const headH = 16;
      let cx = k.x0;
      for (const c of cols) { k.cell(cx, y, c.w, headH, c.head, { bold: true, size: 6.8, align: 'center', fill: COL.head }); cx += c.w; }
      y += headH;
      const rowH = 12;
      for (const act of a.activities) {
        const n = Math.max(act.plant.length, act.trades.length, 1);
        const spanH = Math.max(n * rowH, k.textH(act.description, cols.find((c) => c.key === 'activity')?.w || 100, { size: 7 }));
        const per = spanH / n;
        if (y + spanH > k.bottom) y = k.newPage();
        cx = k.x0;
        for (const c of cols) {
          const spanVal = { item: act.item_no, activity: act.description, chainage: act.chainage, unit: act.unit, output: Number(act.output) ? fmtNum(act.output) : '' }[c.key];
          if (spanVal !== undefined) {
            k.cell(cx, y, c.w, spanH, spanVal, { size: 7, align: 'center', bold: c.key === 'activity' });
          } else {
            for (let i = 0; i < n; i += 1) {
              const pl = act.plant[i];
              const tr = act.trades[i];
              const v = { plant: pl ? pl.name : '', plant_no: pl ? fmtNum(pl.nos) : '', plant_hrs: pl ? fmtNum(pl.hours) : '',
                trade: tr ? tr.name : '', trade_no: tr ? fmtNum(tr.nos) : '', trade_hrs: tr ? fmtNum(tr.hours) : '' }[c.key];
              k.cell(cx, y + i * per, c.w, per, v, { size: 6.6, align: 'center' });
            }
          }
          cx += c.w;
        }
        y += spanH;
      }
      y += 8;
    }
    if (a.activities.length) {
      y = k.ensure(y, 30);
      k.prep('ACTIVITIES:', true, 8);
      k.doc.fillColor(COL.ink).text('ACTIVITIES:', k.x0, y, { width: k.W, align: 'center' });
      y += 11;
      a.activities.forEach((act, i) => {
        y = k.ensure(y, 11);
        const line = `${i + 1}- ${act.description}`;
        const { t } = k.prep(line, true, 7.5);
        k.doc.fillColor(COL.ink).text(t, k.x0, y, { width: k.W, align: 'center' });
        y = k.doc.y + 1;
      });
      y += 6;
    }
    const photos = (m.photos || []).filter((p) => a.photos.includes(p.photo_id));
    if (photos.length && secOn(m, 'photos')) y = photoPages(k, y, photos, buffers, `${a.name} - Photos:`);
  }
  return y;
}

// ------------------------------------------------------------------ registers
/** A register is printed when it has entries, or as an empty grid when "empty rows" is on. */
function registerShown(m, key, rows) {
  return tabOn(m, key) && (rows.length > 0 || L(m).hide_empty[key] !== true);
}
function register(k, y, key, defs, rows) {
  const m = k.m;
  if (!registerShown(m, key, rows)) return y;
  const cols = columns(m, key, defs, k.W);
  const hideEmpty = L(m).hide_empty[key] === true;
  const pad = hideEmpty ? 0 : Math.max(0, 8 - rows.length);
  const all = [...rows.map((r) => ({ cells: cols.map((c) => r[c.key] || '') })), ...Array.from({ length: pad }, () => ({ cells: cols.map(() => '') }))];
  if (!all.length) return y;
  return k.table(y, cols, all, { minH: 13, size: 6.8, headSize: 6.4 }) + 10;
}
function sMaterials(k, y) {
  const m = k.m;
  if (!registerShown(m, 'materials', m.materials || [])) return y;
  y = k.ensure(y, 70);
  y = k.bar(y, sub(m, title(m, 'materials', 'DELIVERED MATERIALS AT SITE')), 40);
  const defs = [
    { key: 'no', head: 'Sr. No.', w: 0.5, align: 'center' }, { key: 'description', head: 'Material Description / Specification / Grade', w: 2.4, always: true, align: 'center' },
    { key: 'unit', head: 'Unit', w: 0.5, align: 'center' }, { key: 'qty', head: 'Qty Delivered', w: 0.7, align: 'center' },
    { key: 'supplier', head: 'Supplier', w: 1.1, align: 'center' }, { key: 'delivery_note', head: 'Delivery Note No.', w: 0.9, align: 'center' },
    { key: 'mar_ref', head: 'MAR Ref.', w: 0.8, align: 'center' }, { key: 'area', head: 'Bridge No.', w: 0.8, align: 'center' },
    { key: 'element', head: 'Element', w: 0.9, align: 'center' }, { key: 'boq_ref', head: 'BOQ Ref.', w: 0.7, align: 'center' },
    { key: 'intended_use', head: 'Intended Use', w: 1.1, align: 'center' },
  ];
  const rows = (m.materials || []).map((x, i) => ({ ...x, no: String(i + 1), qty: fmtNum(x.qty) }));
  return register(k, y, 'materials', defs, rows);
}
function sWir(k, y) {
  const m = k.m;
  if (!registerShown(m, 'wir', m.wir || [])) return y;
  y = k.ensure(y, 70);
  y = k.bar(y, sub(m, title(m, 'wir', 'WORK INSPECTION REQUEST (WIR) REGISTER')), 40);
  const defs = [
    { key: 'no', head: 'Sr. No.', w: 0.5, align: 'center' }, { key: 'ref', head: 'WIR Ref.', w: 1, align: 'center' },
    { key: 'activity', head: 'Activity / Work Description', w: 2.6, always: true, align: 'center' }, { key: 'area', head: 'Bridge No.', w: 0.8, align: 'center' },
    { key: 'location', head: 'Location / Chainage', w: 1.3, align: 'center' }, { key: 'ms_ref', head: 'MS Ref.', w: 0.8, align: 'center' },
    { key: 'status', head: 'Status', w: 0.9, align: 'center' }, { key: 'comments', head: 'Comments', w: 1.6, align: 'center' },
  ];
  const rows = (m.wir || []).map((x, i) => ({
    no: String(i + 1), ref: x.ref_no, activity: x.description, area: x.area,
    location: [x.location, x.chainage].filter(Boolean).join(' / '), ms_ref: x.ms_ref, status: x.result, comments: x.remarks,
  }));
  return register(k, y, 'wir', defs, rows);
}
function sNotes(k, y) {
  const m = k.m;
  if (!m.notes) return y;
  y = k.bar(y, sub(m, title(m, 'notes', 'REMARKS')), 30);
  const h = Math.max(28, k.textH(m.notes, k.W, { size: 7.5, pad: 4 }));
  y = k.ensure(y, h);
  k.cell(k.x0, y, k.W, h, m.notes, { size: 7.5, pad: 4, valign: 'top' });
  return y + h + 8;
}

// ------------------------------------------------------------------ HSE, next working day
function sHse(k, y) {
  const m = k.m;
  const H = m.hse;
  if (!H || !H.filled) return y;
  y = k.ensure(y, 110);
  y = k.bar(y, sub(m, title(m, 'hse', 'HEALTH, SAFETY & ENVIRONMENT')), 80);
  const lw = 140;
  const vw = (k.W - lw * 3) / 3;
  const n0 = (v) => (v === null || v === undefined ? '' : String(v));
  const rows = [
    [['Manpower on site today', H.manpower_today], ['Toolbox talk attendees', H.tbt_attendees], ['HSE inspections / audits today', H.hse_inspections_today]],
    [['Incidents today', H.incidents_today], ['Near misses today', H.near_misses_today], ['First aid cases today', H.first_aid_today]],
    [['LTI today', H.lti_today], ['PTWs issued today', H.ptws_today], ['LTI-free days', H.lti_free_days]],
    [['Incidents to date', H.incidents_to_date], ['Near misses to date', H.near_misses_to_date], ['LTIs to date', H.ltis_to_date]],
  ];
  for (const r of rows) {
    let cx = k.x0;
    for (const [l, v] of r) {
      k.cell(cx, y, lw, 13, l, { bold: true, size: 6.8, fill: COL.head });
      k.cell(cx + lw, y, vw, 13, n0(v), { bold: true, size: 7.5, align: 'center' });
      cx += lw + vw;
    }
    y += 13;
  }
  for (const [l, v] of [['Toolbox talk topic', H.tbt_topic], ['HSE observations & corrective actions', H.observations]]) {
    const h = Math.max(14, k.textH(v, k.W - lw, { size: 7 }));
    y = k.ensure(y, h);
    k.cell(k.x0, y, lw, h, l, { bold: true, size: 6.8, fill: COL.head });
    k.cell(k.x0 + lw, y, k.W - lw, h, v, { size: 7 });
    y += h;
  }
  return y + 8;
}
function sPlan(k, y) {
  const m = k.m;
  if (!m.next_day_plan) return y;
  y = k.bar(y, sub(m, title(m, 'plan', 'PLANNED ACTIVITIES – NEXT WORKING DAY')), 30);
  const h = Math.max(28, k.textH(m.next_day_plan, k.W, { size: 7.5, pad: 4 }));
  y = k.ensure(y, h);
  k.cell(k.x0, y, k.W, h, m.next_day_plan, { size: 7.5, pad: 4, valign: 'top' });
  return y + h + 8;
}

// ------------------------------------------------------------------ registers open on the day, signatures
function sNcr(k, y) {
  const m = k.m;
  const list = (m.ncr && m.ncr.entries) || [];
  if (!list.length) return y;
  y = k.bar(y, sub(m, title(m, 'ncr', 'NON-CONFORMANCE REPORTS – OPEN AS OF REPORT DATE')), 40);
  const W = k.W;
  const cols = [{ head: 'NCR No.', w: W * 0.09, align: 'center' }, { head: 'Date Raised', w: W * 0.1, align: 'center' }, { head: 'Description', w: W * 0.25 },
    { head: 'Corrective Action', w: W * 0.22 }, { head: 'Responsible', w: W * 0.1, align: 'center' }, { head: 'Target Date', w: W * 0.1, align: 'center' },
    { head: 'Status', w: W * 0.07, align: 'center' }, { head: 'Days Open', w: W * 0.07, align: 'center' }];
  const rows = list.map((x) => ({ cells: [x.ncr_no, fmtDate(x.date_raised), x.description, x.corrective_action, x.responsible, fmtDate(x.target_date), x.status, String(x.days_open)],
    colors: [null, null, null, null, null, null, x.status === 'Open' ? COL.red : null] }));
  return k.table(y, cols, rows, { minH: 13, size: 6.8, headSize: 6.4 }) + 10;
}
function sConcerns(k, y) {
  const m = k.m;
  const list = (m.concerns && m.concerns.entries) || [];
  if (!list.length) return y;
  y = k.bar(y, sub(m, title(m, 'concerns', 'AREAS OF CONCERN / DELAYS / CONSTRAINTS – OPEN AS OF REPORT DATE')), 40);
  const W = k.W;
  const cols = [{ head: 'Date Raised', w: W * 0.1, align: 'center' }, { head: 'Issue', w: W * 0.26 }, { head: 'Impact', w: W * 0.09, align: 'center' },
    { head: 'Severity', w: W * 0.09, align: 'center' }, { head: 'Action Required', w: W * 0.24 }, { head: 'By Whom', w: W * 0.11, align: 'center' },
    { head: 'Target Date', w: W * 0.11, align: 'center' }];
  const rows = list.map((x) => ({ cells: [fmtDate(x.date_raised), x.issue, x.impact, x.severity, x.action_required, x.by_whom, fmtDate(x.target_date)] }));
  return k.table(y, cols, rows, { minH: 13, size: 6.8, headSize: 6.4 }) + 10;
}
function sSignatures(k, y) {
  const m = k.m;
  const S = m.signatures || {};
  y = k.ensure(y + 4, 95);
  y = k.bar(y, sub(m, title(m, 'signatures', 'SIGNATURES')), 80);
  const w = k.W / 3;
  const heads = ['PREPARED BY (CONTRACTOR)', 'REVIEWED BY (CONTRACTOR)', "CONSULTANT'S REPRESENTATIVE"];
  const names = [S.prepared_by, S.reviewed_by, S.consultant_rep];
  heads.forEach((t, i) => {
    const x = k.x0 + i * w;
    k.cell(x, y, w, 14, t, { bold: true, size: 7, align: 'center', fill: COL.head });
    k.cell(x, y + 14, w, 36, 'Signature:', { size: 6.5, valign: 'top', color: COL.muted });
    k.cell(x, y + 50, w, 13, names[i] || '', { bold: true, size: 7 });
    k.cell(x, y + 63, w, 12, 'Date:', { size: 6.5, color: COL.muted });
  });
  return y + 80;
}

// ------------------------------------------------------------------ photos
function photoPages(k, y, photos, buffers, heading) {
  const m = k.m;
  const per = L(m).photos_per_page || 1;
  const captions = L(m).photo_captions !== false;
  const grid = { 1: [1, 1], 2: [1, 2], 4: [2, 2], 6: [2, 3] }[per] || [1, 1];
  let i = 0;
  let first = true;
  while (i < photos.length) {
    // the first photos may use the rest of the page when at least half of it is free
    if (!first || y > k.top + (k.bottom - k.top) * 0.5) y = k.newPage();
    if (first && heading) {
      k.prep(heading, true, 8);
      k.doc.fillColor(COL.red).text(heading, k.x0, y, { underline: true });
      y += 13;
    }
    const areaH = k.bottom - y;
    const cw = k.W / grid[0];
    const ch = areaH / grid[1];
    for (let r = 0; r < grid[1] && i < photos.length; r += 1) {
      for (let c = 0; c < grid[0] && i < photos.length; c += 1) {
        const p = photos[i];
        const px = k.x0 + c * cw + 3;
        const py = y + r * ch + 3;
        const cap = [p.caption, p.location, p.boq_activity].filter(Boolean).join(' – ');
        const capH = captions && cap ? 12 : 0;
        const buf = buffers.get(p.photo_id);
        if (buf) {
          try { k.doc.image(buf, px, py, { fit: [cw - 6, ch - 6 - capH], align: 'center', valign: 'center' }); } catch (_) { /* skipped */ }
        } else {
          k.doc.lineWidth(0.4).strokeColor(COL.line).rect(px, py, cw - 6, ch - 6 - capH).stroke();
        }
        if (capH) k.cell(px, py + ch - 6 - capH, cw - 6, capH, cap, { size: 6.8, align: 'center', border: false });
        i += 1;
      }
    }
    first = false;
    y = k.bottom;
  }
  return y;
}
function sPhotos(k, y, buffers) {
  const m = k.m;
  const inAreas = new Set((m.areas || []).flatMap((a) => a.photos));
  const general = (m.photos || []).filter((p) => !inAreas.has(p.photo_id));
  if (!general.length) return y;
  return photoPages(k, y, general, buffers, sub(m, title(m, 'photos', '{code} ACTIVITIES PHOTO:')));
}

// ------------------------------------------------------------------ the document
/**
 * @param {object} m      model of dprUcc.buildUcc (or an issued snapshot)
 * @param {object} meta   { revision, issued, issued_at, issued_by, printed_at }
 * @param {{photos: Map, pages: Map}} images  file buffers by photo_id / page_id
 */
function renderUccPdf(m, meta = {}, images = { photos: new Map(), pages: new Map() }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, autoFirstPage: true,
        info: { Title: `${m.header.form_title} ${m.contract.code} ${m.header.report_date}`, Author: m.header.company_name || 'Team Flow' } });
      doc.registerFont('R', FONTS.regular);
      doc.registerFont('B', FONTS.bold);
      if (fs.existsSync(FONTS.arabic)) doc.registerFont('AR', FONTS.arabic);
      else doc.registerFont('AR', FONTS.regular);
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      const k = new Kit(doc, m, meta);
      k.drawPageHeader();
      let y = k.top;
      y = sProject(k, y);
      if (secOn(m, 'cover')) y = sCover(k, y, m.fixed_pages || [], images.pages || new Map()).y;
      if (secOn(m, 'weather')) y = sWeather(k, y);
      if (secOn(m, 'manpower')) y = sManpower(k, y);
      if (secOn(m, 'plant')) y = sPlant(k, y);
      if (secOn(m, 'boq')) y = sBoq(k, y);
      if (secOn(m, 'activities')) y = sActivities(k, y);
      if (secOn(m, 'hse')) y = sHse(k, y);
      if (secOn(m, 'plan')) y = sPlan(k, y);
      if (secOn(m, 'ncr')) y = sNcr(k, y);
      if (secOn(m, 'concerns')) y = sConcerns(k, y);
      if (secOn(m, 'notes')) y = sNotes(k, y);
      if (secOn(m, 'photos')) y = sPhotos(k, y, images.photos || new Map());
      if (secOn(m, 'areas')) y = sAreas(k, y, images.photos || new Map());
      if (secOn(m, 'materials') || secOn(m, 'wir')) {
        if ((secOn(m, 'materials') && registerShown(m, 'materials', m.materials || [])) || (secOn(m, 'wir') && registerShown(m, 'wir', m.wir || []))) y = k.newPage();
        if (secOn(m, 'materials')) y = sMaterials(k, y);
        if (secOn(m, 'wir')) y = sWir(k, y);
      }
      if (secOn(m, 'signatures')) y = sSignatures(k, y);

      // page numbers, footer, DRAFT mark
      const range = doc.bufferedPageRange();
      const stamp = fmtStamp(meta.printed_at ? new Date(meta.printed_at) : new Date());
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        const pw = doc.page.width;
        const ph = doc.page.height;
        const box = k.pageNoBox;
        if (box) {
          doc.font('R').fontSize(7).fillColor(COL.ink).text(`${i + 1} of ${range.count}`, box.x, box.y + 2.5, { width: box.w, align: 'center', lineBreak: false });
        }
        doc.font('R').fontSize(6).fillColor(COL.muted);
        if (m.header.footer_note) doc.text(m.header.footer_note, k.x0, ph - 30, { width: pw - k.x0 * 2, height: 14, ellipsis: true });
        const right = meta.issued
          ? `${m.contract.code} · Issued ${meta.issued_at || ''}${meta.revision ? ` · Rev.${meta.revision}` : ''}${meta.issued_by ? ` · ${meta.issued_by}` : ''}`
          : `${m.contract.code} · DRAFT – printed ${stamp}`;
        doc.text(right, pw - 300, ph - 16, { width: 274, align: 'right', lineBreak: false });
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

module.exports = { renderUccPdf, fmtNum, fmtDate };
