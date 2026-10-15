// services/projectDailyReportDocx.js
//
// The combined PROJECT DAILY REPORT (form UCC-IMS-CM-3003A) as a Word file.
// Built to match the client's form one-to-one: same A4 page, the same column
// grid (measured from the original in points), the same fonts, colours,
// labels (spelling kept as on the client's form) and row heights.
//
//   Page 1  header block, project info, weather, manpower (staff / tradesmen),
//           grand total, plant / tools.
//   Page 2  BOQ / contract items (from the report profile).
//   Page 3  activities (description / location) + "ACTIVITIES PHOTO:".
//
// Everything the two systems do not know (weather, temperatures, BOQ progress,
// photos...) is printed as an EMPTY cell so the site team fills it in Word.
// A section switched off in the request is not printed at all.
//
// Input: see buildModel() in services/projectDailyReportService.js.

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, Header, Footer,
  AlignmentType, BorderStyle, ShadingType, VerticalAlign, WidthType, HeightRule, TableLayoutType,
  VerticalMergeType, PageNumber, UnderlineType, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
  TextWrappingType,
} = require('docx');

// ------------------------------------------------------------------ units & style
const tw = (pt) => Math.round(pt * 20); // points -> twips
const px = (pt) => Math.round((pt * 96) / 72); // points -> pixels (docx image size)

const FONT = 'Calibri';
const SERIF = 'Arabic Typesetting'; // header block font on the original form
const C = {
  grid: 'A6A6A6',
  head: '7F7F7F',
  gray: 'D8D8D8',
  lightGray: 'ECECEC',
  green: 'E2EFD9',
  olive: '666633',
  white: 'FFFFFF',
  black: '000000',
  title: '171717',
  blue: '1F4E79',
  tick: '00B050',
};
// The original is an Excel sheet printed at 60 %: 12 pt -> 7.2 pt. Word needs half points.
const SZ = { s54: 11, s60: 12, s66: 13, s72: 14, s84: 17, s96: 19, s108: 22, s132: 26 };

const LOGO_FILE = path.join(__dirname, '..', 'assets', 'logo_project_daily_report.png');
let logoCache = null;
function logo() {
  if (logoCache === null) {
    try { logoCache = fs.readFileSync(LOGO_FILE); } catch (_) { logoCache = false; }
  }
  return logoCache || null;
}

const line = (color = C.grid, size = 4) => ({ style: BorderStyle.SINGLE, size, color });
const NONE = { style: BorderStyle.NONE, size: 0, color: 'auto' };
const ALL = (color = C.grid) => ({ top: line(color), bottom: line(color), left: line(color), right: line(color) });
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE };

function run(text, o = {}) {
  return new TextRun({
    text: text === null || text === undefined ? '' : String(text),
    font: o.font || FONT,
    size: o.size || SZ.s72,
    bold: Boolean(o.bold),
    color: o.color || C.black,
    underline: o.underline ? { type: UnderlineType.SINGLE } : undefined,
  });
}

/** Paragraphs for a (possibly multi-line) text. */
function paras(text, o = {}) {
  const lines = text === null || text === undefined || text === '' ? [''] : String(text).split('\n');
  return lines.map((t) => new Paragraph({
    alignment: o.align || AlignmentType.LEFT,
    indent: o.indent ? { left: tw(o.indent) } : (o.indentRight ? { right: tw(o.indentRight) } : undefined),
    // exact line height (1.22 x the font size, Calibri's own) keeps rows identical in Word and LibreOffice
    spacing: { before: 0, after: 0, line: o.line || Math.round(((o.size || SZ.s72) / 2) * 1.22 * 20), lineRule: 'exact' },
    children: [run(t, o)],
  }));
}

/**
 * One table cell. o: { w (pt), span, text, align, bold, size, color, fill, borders, valign, indent, vMerge, font, children }
 */
function cell(o = {}) {
  return new TableCell({
    width: o.w ? { size: tw(o.w), type: WidthType.DXA } : undefined,
    columnSpan: o.span && o.span > 1 ? o.span : undefined,
    verticalMerge: o.vMerge === 'restart' ? VerticalMergeType.RESTART : (o.vMerge === 'continue' ? VerticalMergeType.CONTINUE : undefined),
    shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
    borders: o.borders || ALL(),
    verticalAlign: o.valign || VerticalAlign.CENTER,
    margins: { top: 0, bottom: 0, left: tw(o.padL ?? 1.5), right: tw(o.padR ?? 1.5) },
    children: o.children || paras(o.text, o),
  });
}

function row(cells, height, rule = HeightRule.EXACT) {
  return new TableRow({ height: { value: tw(height), rule }, cantSplit: true, children: cells });
}

function table(widths, rows, o = {}) {
  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: tw(widths.reduce((a, b) => a + b, 0)), type: WidthType.DXA },
    columnWidths: widths.map(tw),
    indent: o.indent ? { size: tw(o.indent), type: WidthType.DXA } : undefined,
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
    rows,
  });
}

const spacer = (pt) => new Paragraph({ spacing: { before: 0, after: 0, line: tw(pt), lineRule: 'exact' }, children: [] });

/** Blank when null/undefined, or when 0 and blankZero. */
function num(v, blankZero = true) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n === 0 && blankZero) return '';
  return String(n);
}

// ------------------------------------------------------------------ header (every page)
// Grid: logo 17.5-216.9 | title 216.9-440.5 | 440.5-491.4 | 491.4-549 ; rows 10.1 .. 94.7
function headerBlock(m) {
  const W = [199.4, 223.6, 50.9, 57.6];
  const H = [14.4, 14.4, 14.0, 13.9, 14.0, 13.9];
  const hb = ALL(C.head);
  const serif = (text, size, extra = {}) => ({ text, font: SERIF, size, align: AlignmentType.CENTER, borders: hb, ...extra });
  const img = logo();
  // The logo floats (anchored to the page, 40 x 20 pt, 157 x 58 pt as on the form) so it never stretches a row.
  const logoRun = img ? [new ImageRun({
    type: 'png',
    data: img,
    transformation: { width: px(157), height: px(58) },
    floating: {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: Math.round(40 * 12700) },
      verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: Math.round(20 * 12700) },
      wrap: { type: TextWrappingType.NONE },
      allowOverlap: true,
      behindDocument: false,
    },
  })] : [];
  const logoCell = () => cell({
    w: W[0], borders: NO_BORDERS, padL: 0, padR: 0,
    children: [new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: 'exact' }, children: [] })],
  });
  const rows = [
    row([logoCell(true), cell({ ...serif('Integrated Management System', SZ.s132), w: W[1], fill: C.gray, vMerge: 'restart' }),
      cell({ ...serif('Document Reference', SZ.s96), w: W[2] + W[3], span: 2, fill: C.gray })], H[0]),
    row([logoCell(false), cell({ w: W[1], fill: C.gray, vMerge: 'continue', borders: hb }),
      cell({ ...serif(m.header.doc_ref, SZ.s96), w: W[2] + W[3], span: 2 })], H[1]),
    row([logoCell(false), cell({ ...serif('Construction Management', SZ.s132), w: W[1], fill: C.gray, vMerge: 'restart' }),
      cell({ ...serif('Rev. No.', SZ.s96), w: W[2], fill: C.gray }), cell({ ...serif('Rev. Date', SZ.s96), w: W[3], fill: C.gray })], H[2]),
    row([logoCell(false), cell({ w: W[1], fill: C.gray, vMerge: 'continue', borders: hb }),
      cell({ ...serif(m.header.rev_no, SZ.s96), w: W[2] }), cell({ ...serif(m.header.rev_date, SZ.s96), w: W[3] })], H[3]),
    row([logoCell(false), cell({ ...serif('PROJECT DAILY REPORT', SZ.s132), w: W[1], vMerge: 'restart' }),
      cell({ ...serif('Page Number', SZ.s96), w: W[2], fill: C.gray }), cell({ ...serif('Rep. Date', SZ.s96), w: W[3], fill: C.gray })], H[4]),
    row([logoCell(false), cell({ w: W[1], vMerge: 'continue', borders: hb }),
      cell({
        w: W[2], borders: hb,
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: m.header.page_numbers
            ? [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SZ.s72 })]
            : [],
        })],
      }),
      cell({ text: m.header.rep_date, w: W[3], align: AlignmentType.CENTER, borders: hb, size: SZ.s72 })], H[5]),
  ];
  // the logo is anchored to the paragraph under the table (not inside a cell, where it would be positioned
  // relative to the cell instead of the page)
  return new Header({ children: [table(W, rows), new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: 'exact' }, children: logoRun })] });
}

function footerLine() {
  return new Footer({
    children: [new Paragraph({
      indent: { right: tw(29) },
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: C.black, space: 1 } },
      children: [],
    })],
  });
}

// ------------------------------------------------------------------ page 1
// Info: 17.5 | 99.9 | 327.6 | 393.3 | 549
function infoTable(m) {
  const W = [82.4, 227.7, 65.7, 155.7];
  const i = m.info;
  const lab = (text, w, indent = 4.5) => cell({ text, w, fill: C.olive, color: C.white, size: SZ.s84, indent, padL: 0 });
  const val = (text, w, o = {}) => cell({ text, w, size: SZ.s72, indent: 4.5, padL: 0, valign: o.valign || VerticalAlign.CENTER, align: o.align, ...o });
  const rows = [
    row([lab('Project Ref.', W[0]), val(i.project_ref, W[1]), lab('Contract', W[2]), val(i.contract_ref, W[3])], 11.2),
    row([lab('Project Name', W[0]), val(i.project_name, W[1]), lab('Project Location', W[2]),
      val(i.project_location, W[3], { valign: VerticalAlign.TOP })], 19.8),
    row([lab('Client', W[0]), val(i.client, W[1]), lab('Commencement', W[2]),
      val(i.commencement, W[3], { align: AlignmentType.CENTER, indent: 0 })], 19.8),
    row([lab('Consultant', W[0]), val(i.consultant, W[1]), lab('Completion Date', W[2], 0.5),
      val(i.completion, W[3], { align: AlignmentType.CENTER, indent: 0 })], 11.3),
    row([lab('', W[0]), val('', W[1]), lab('Report Date', W[2]),
      val(i.report_date, W[3], { align: AlignmentType.CENTER, indent: 0 })], 11.2),
    row([
      cell({ w: W[0], borders: NO_BORDERS }),
      cell({
        text: i.agreement_title, w: W[1] + W[2], span: 2, bold: true, size: SZ.s96, color: C.title, align: AlignmentType.CENTER,
        borders: { ...NO_BORDERS, left: line() },
      }),
      cell({ w: W[3], borders: NO_BORDERS }),
    ], 18.0),
  ];
  return table(W, rows);
}

// Weather / temperature / humidity box (228.8 - 281.0)
// 17.5 72 99.9 248.8 286.6 311.4 356.4 393.3 422.1 440.5 491.4 520.2 549
function weatherTable(m) {
  const W = [54.5, 27.9, 148.9, 37.8, 24.8, 45.0, 36.9, 28.8, 18.4, 50.9, 28.8, 28.8];
  const w = m.weather || {};
  const outer = line();
  // borders of a plain (non-box) cell at column c, row r (0..4)
  const plain = (c, r) => ({
    top: r === 0 ? outer : NONE,
    bottom: r === 4 ? outer : NONE,
    left: c === 0 || c === 5 ? outer : NONE,
    right: c === 11 ? outer : NONE,
  });
  const lab = (c, r, text, o = {}) => cell({ w: W[c], text, size: SZ.s66, borders: plain(c, r), padL: 0, padR: 0, ...o });
  const tick = (on) => (on
    ? [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 0, line: 170, lineRule: 'exact' },
      children: [new TextRun({ text: '✓', font: 'Segoe UI Symbol', size: 20, bold: true, color: C.tick })],
    })]
    : [new Paragraph({ children: [] })]);
  const box = (c, children) => cell({ w: W[c], borders: ALL(), children, padL: 0, padR: 0 });
  const valBox = (c, v) => box(c, paras(v === null || v === undefined ? '' : String(v), { size: SZ.s66, align: AlignmentType.CENTER }));
  const blank = (c, r) => lab(c, r, '');
  const hum = String(w.humidity || '').toLowerCase();

  const r0 = row([
    lab(0, 0, 'WEATHER', { bold: true, span: 5, w: W[0] + W[1] + W[2] + W[3] + W[4], indent: 1.5, borders: { top: outer, left: outer, bottom: NONE, right: NONE } }),
    lab(5, 0, 'TEMP', { bold: true, span: 7, w: W.slice(5).reduce((a, b) => a + b, 0), indent: 1.5, borders: { top: outer, left: outer, right: outer, bottom: NONE } }),
  ], 8.6);
  const r1 = row([
    lab(0, 1, 'SUNNY', { indent: 22.5 }), box(1, tick(w.sunny)),
    lab(2, 1, 'RAINY', { indent: 126 }), box(3, tick(w.rainy)), blank(4, 1),
    lab(5, 1, 'MAX', { indent: 17.5 }), valBox(6, w.temp_max),
    lab(7, 1, 'MIN', { indent: 1 }), valBox(8, w.temp_min),
    blank(9, 1), blank(10, 1), blank(11, 1),
  ], 8.5);
  const r2 = row([
    lab(0, 2, '', { span: 5, w: W[0] + W[1] + W[2] + W[3] + W[4] }),
    lab(5, 2, 'HUMIDITY', {
      bold: true, span: 7, w: W.slice(5).reduce((a, b) => a + b, 0), indent: 1.5, valign: VerticalAlign.BOTTOM,
      borders: { top: NONE, bottom: NONE, left: outer, right: outer },
    }),
  ], 17.1);
  const r3 = row([
    lab(0, 3, 'CLOUDY', { indent: 22.5 }), box(1, tick(w.cloudy)),
    lab(2, 3, 'DUSTY', { indent: 126 }), box(3, tick(w.dusty)), blank(4, 3),
    lab(5, 3, 'HIGH', { indent: 17.5 }), box(6, tick(hum === 'high')),
    lab(7, 3, 'MEDUIM', { indent: 1 }), box(8, tick(hum === 'medium')),
    lab(9, 3, 'LOW', { indent: 25.5 }), box(10, tick(hum === 'low')), blank(11, 3),
  ], 8.6);
  const r4 = row([
    lab(0, 4, '', { span: 5, w: W[0] + W[1] + W[2] + W[3] + W[4] }),
    lab(5, 4, '', { span: 7, w: W.slice(5).reduce((a, b) => a + b, 0), borders: { top: NONE, left: outer, right: outer, bottom: outer } }),
  ], 9.4);
  return table(W, [r0, r1, r2, r3, r4]);
}

// Manpower + grand total + plant: 17.5 99.9 248.8 292.9 327.6 393.3 440.5 491.4 549
const MP_W = [82.4, 148.9, 44.1, 34.7, 65.7, 47.2, 50.9, 57.6];
const RH = 9.9;

function headRow(labels) {
  return row(labels.map((t, i) => cell({ text: t, w: MP_W[i], bold: true, fill: C.gray, align: AlignmentType.CENTER })), RH);
}

function lineCell(text, i, o = {}) {
  return cell({ text, w: MP_W[i], size: SZ.s72, ...o });
}

function manpowerTables(m, o) {
  const out = [];
  const rows = [];
  if (o.manpower) {
    rows.push(row([cell({
      text: 'PROJECT WIZE - MANPOWER & MECHANIS [LIST THE POSITION AND NO. DEPLOYED AT SITE]',
      w: MP_W.reduce((a, b) => a + b, 0), span: 8, bold: true, size: SZ.s84, align: AlignmentType.CENTER, borders: NO_BORDERS,
    })], 10.4));
    rows.push(headRow(['STAFF', 'TOTAL', 'PRESENT', 'ABSENT', 'TRADESMEN', 'TOTAL', 'PRESENT', 'ABSENT']));
    const staff = m.staff_rows;
    const trades = m.trade_rows;
    const n = Math.max(staff.length, trades.length);
    const pa = (r, k) => (r && Number(r.total) > 0 && m.fill_present_absent ? num(r[k], false) : '');
    for (let k = 0; k < n; k += 1) {
      const s = staff[k];
      const t = trades[k];
      rows.push(row([
        lineCell(s ? s.label : '', 0, { indent: 4 }),
        lineCell(s ? num(s.total) : '', 1, { align: AlignmentType.CENTER }),
        lineCell(pa(s, 'present'), 2, { align: AlignmentType.CENTER }),
        lineCell(pa(s, 'absent'), 3, { align: AlignmentType.CENTER }),
        lineCell(t ? t.label : '', 4, { indent: 4 }),
        lineCell(t ? num(t.total) : '', 5, { align: AlignmentType.CENTER }),
        lineCell(pa(t, 'present'), 6, { align: AlignmentType.CENTER }),
        lineCell(pa(t, 'absent'), 7, { align: AlignmentType.CENTER }),
      ], RH));
    }
    const st = m.staff_total;
    const tt = m.trade_total;
    rows.push(row([
      lineCell('TOTAL', 0, { bold: true, indent: 4 }),
      lineCell(num(st.total, false), 1, { bold: true, align: AlignmentType.CENTER }),
      lineCell(pa(st, 'present'), 2, { bold: true, align: AlignmentType.CENTER }),
      lineCell(pa(st, 'absent'), 3, { bold: true, align: AlignmentType.CENTER }),
      lineCell('TOTAL', 4, { bold: true, indent: 4 }),
      lineCell(num(tt.total, false), 5, { bold: true, align: AlignmentType.CENTER }),
      lineCell(pa(tt, 'present'), 6, { bold: true, align: AlignmentType.CENTER }),
      lineCell(pa(tt, 'absent'), 7, { bold: true, align: AlignmentType.CENTER }),
    ], RH));
    // empty row under the totals (open on the left, as on the form)
    rows.push(row(MP_W.map((w, i) => cell({ w, borders: i < 2 ? NO_BORDERS : { top: line(), bottom: line(), left: line(), right: line() } })), RH));
    rows.push(row([
      cell({ text: 'GRAND TOTAL', w: MP_W[0] + MP_W[1], span: 2, bold: true, align: AlignmentType.CENTER, borders: { ...NO_BORDERS, top: line() } }),
      cell({ text: num(m.grand_total, false), w: MP_W.slice(2).reduce((a, b) => a + b, 0), span: 6, bold: true, align: AlignmentType.CENTER, borders: { ...NO_BORDERS, top: line() } }),
    ], RH));
  }
  if (o.plant) {
    rows.push(headRow(['PLANT', 'OPERATIVE', 'BREAKDOWN', 'IDLE', 'TOOL', 'OPERATIVE', 'BREAKDOWN', 'IDLE']));
    const plant = m.plant_rows;
    const tools = m.tool_rows;
    const n = Math.max(plant.length, tools.length);
    for (let k = 0; k < n; k += 1) {
      const p = plant[k];
      const t = tools[k];
      rows.push(row([
        lineCell(p ? p.label : '', 0, { indent: 4 }),
        lineCell(p ? num(p.operative) : '', 1, { align: AlignmentType.CENTER }),
        lineCell(p ? num(p.breakdown) : '', 2, { align: AlignmentType.CENTER }),
        lineCell(p ? num(p.idle) : '', 3, { align: AlignmentType.CENTER }),
        lineCell(t ? t.label : '', 4, { indent: 4 }),
        lineCell(t ? num(t.operative) : '', 5, { align: AlignmentType.CENTER }),
        lineCell(t ? num(t.breakdown) : '', 6, { align: AlignmentType.CENTER }),
        lineCell(t ? num(t.idle) : '', 7, { align: AlignmentType.CENTER }),
      ], RH));
    }
    const pt = m.plant_total;
    const tt = m.tool_total;
    rows.push(row([
      lineCell('TOTAL', 0, { bold: true, indent: 4 }),
      lineCell(num(pt.operative), 1, { bold: true, align: AlignmentType.CENTER }),
      lineCell(num(pt.breakdown), 2, { bold: true, align: AlignmentType.CENTER }),
      lineCell(num(pt.idle), 3, { bold: true, align: AlignmentType.CENTER }),
      lineCell('', 4),
      lineCell(num(tt.operative), 5, { bold: true, align: AlignmentType.CENTER }),
      lineCell(num(tt.breakdown), 6, { bold: true, align: AlignmentType.CENTER }),
      lineCell(num(tt.idle), 7, { bold: true, align: AlignmentType.CENTER }),
    ], RH));
  }
  if (rows.length) out.push(table(MP_W, rows));
  return out;
}

// ------------------------------------------------------------------ page 2: BOQ
// 17.5 39.1 72.0 356.4 393.3 422.1 440.5 464.8 491.4 520.2
const BOQ_W = [21.6, 32.9, 284.4, 36.9, 28.8, 18.4, 24.3, 26.6, 28.8];

function boqTable(m) {
  const head = ['Task\nCode', 'Cost Code', 'Description', 'Unit', 'Quantity', 'BUDGET', 'CURR', 'CURR', 'BALANCE'];
  const rows = [row(head.map((t, i) => cell({
    text: t, w: BOQ_W[i], bold: true, size: i === 5 ? 9 : (i >= 3 ? SZ.s54 : SZ.s60), fill: C.lightGray, align: AlignmentType.CENTER, padL: 0, padR: 0,
  })), 18.9)];
  const fills = { green: C.green, gray: C.lightGray };
  for (const r of m.boq || []) {
    if (r.type === 'gap') {
      rows.push(row(BOQ_W.map((w) => cell({ w, borders: { top: line(), bottom: line(), left: NONE, right: NONE } })), RH));
      continue;
    }
    const fill = fills[r.fill] || undefined;
    const bold = Boolean(r.bold);
    const c = (text, i, align) => cell({
      text, w: BOQ_W[i], size: SZ.s60, bold: i === 2 ? bold : false, fill, align, padL: 1, padR: 2,
    });
    rows.push(row([
      c(r.task_code, 0, AlignmentType.CENTER),
      c(r.cost_code, 1, AlignmentType.CENTER),
      c(r.description, 2, AlignmentType.CENTER),
      c(r.unit, 3, AlignmentType.CENTER),
      c(r.quantity, 4, AlignmentType.RIGHT),
      c(r.budget, 5, AlignmentType.RIGHT),
      c(r.curr_1, 6, AlignmentType.RIGHT),
      c(r.curr_2, 7, AlignmentType.RIGHT),
      c(r.balance, 8, AlignmentType.RIGHT),
    ], RH, HeightRule.ATLEAST));
  }
  return table(BOQ_W, rows);
}

// ------------------------------------------------------------------ page 3: activities + photos
// 17.5 39.1 422.1 549
const ACT_W = [21.6, 383.0, 126.9];

function activitiesTable(m) {
  const rows = [row([
    cell({ w: ACT_W[0], fill: C.gray }),
    cell({ text: 'Description', w: ACT_W[1], bold: true, underline: true, size: SZ.s84, fill: C.gray, align: AlignmentType.CENTER }),
    cell({ text: 'Location', w: ACT_W[2], bold: true, underline: true, size: SZ.s84, fill: C.gray, align: AlignmentType.CENTER }),
  ], 13.4)];
  const list = m.activities && m.activities.length ? m.activities : [];
  const blanks = list.length ? 0 : 3;
  list.forEach((a, k) => {
    rows.push(row([
      cell({ text: String(k + 1), w: ACT_W[0], size: SZ.s72, align: AlignmentType.CENTER }),
      cell({ text: a.description, w: ACT_W[1], size: SZ.s96, align: AlignmentType.CENTER }),
      cell({ text: a.location, w: ACT_W[2], size: SZ.s96, align: AlignmentType.CENTER }),
    ], 18.5, HeightRule.ATLEAST));
  });
  for (let k = 0; k < blanks; k += 1) {
    rows.push(row(ACT_W.map((w) => cell({ w, size: SZ.s96 })), 18.5, HeightRule.ATLEAST));
  }
  return table(ACT_W, rows);
}

function photosHeading() {
  return [
    spacer(21),
    new Paragraph({ indent: { left: tw(66.5) }, spacing: { before: 0, after: 0 }, children: [run('ACTIVITIES PHOTO: ', { bold: true, size: SZ.s108, color: C.blue })] }),
    // empty lines: the site team pastes the photos here
    new Paragraph({ spacing: { before: tw(4), after: 0 }, children: [] }),
    new Paragraph({ children: [] }),
  ];
}

// ------------------------------------------------------------------ document
/**
 * @param {object} m  model (see projectDailyReportService.buildModel)
 * @returns {Promise<Buffer>}
 */
async function renderProjectDailyReportDocx(m) {
  const o = m.sections;
  const page1 = [];
  if (o.info) {
    page1.push(new Paragraph({
      indent: { left: tw(22.5) },
      spacing: { before: tw(4), after: tw(12) },
      children: [run('PROJECT DAILY REPORT', { bold: true, size: SZ.s66, underline: true })],
    }));
    page1.push(infoTable(m));
  }
  if (o.weather) page1.push(weatherTable(m));
  page1.push(...manpowerTables(m, o));

  const body = [...page1];
  let started = page1.length > 0;
  const newPage = (children) => {
    if (started) children[0] = withPageBreak(children[0]);
    body.push(...children);
    started = true;
  };
  if (o.boq && m.boq && m.boq.length) {
    newPage([new Paragraph({ spacing: { before: 0, after: tw(6) }, children: [] }), boqTable(m)]);
  }
  if (o.activities || o.photos) {
    const part = [new Paragraph({ spacing: { before: 0, after: tw(8) }, children: [] })];
    if (o.activities) part.push(activitiesTable(m));
    if (o.photos) part.push(...photosHeading());
    newPage(part);
  }
  if (!body.length || !(body[body.length - 1] instanceof Paragraph)) {
    body.push(new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: 'exact' }, children: [] }));
  }

  const header = headerBlock(m);
  const doc = new Document({
    creator: 'Team Flow',
    title: `Project Daily Report ${m.info.report_date || ''}`.trim(),
    description: 'UCC-IMS-CM-3003A',
    styles: {
      default: {
        document: {
          run: { font: FONT, size: SZ.s72 },
          paragraph: { spacing: { before: 0, after: 0, line: 240 } },
        },
      },
    },
    sections: [{
      properties: {
        titlePage: true,
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: tw(108), bottom: tw(50), left: tw(17.5), right: tw(46.3), header: tw(10.1), footer: tw(36) },
        },
      },
      headers: { first: header, default: headerBlock(m) },
      footers: { first: footerLine(), default: new Footer({ children: [new Paragraph({ children: [] })] }) },
      children: body,
    }],
  });
  return Packer.toBuffer(doc);
}

// A table cannot carry "page break before": put an empty paragraph with the break in front of it.
function withPageBreak(first) {
  if (first instanceof Paragraph) {
    return new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: tw(6) }, children: [] });
  }
  return first;
}

module.exports = { renderProjectDailyReportDocx, _internal: { num } };
