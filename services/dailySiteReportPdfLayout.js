// services/dailySiteReportPdfLayout.js
//
// Presentation only: draws the Daily Site Manpower Report from the payload
// built by dailySiteReportService (+ header info). A4 portrait, ASIK logo
// palette (charcoal + gold, services/pdfBrand.js). PDFKit only (no headless
// browser), so it stays light on a small server.
//
// Arabic text (names, sites, recipient) uses the bundled Noto Naskh Arabic
// font with the same technique as the other reports: word order reversed and
// letters shaped by fontkit with the 'rtla' feature.

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { BRAND: P } = require('./pdfBrand');

const COMPANY_NAME = 'ASIK ENGINEERING CONSTRUCTION';
// Small, pre-cropped copy of assets/logo.png (640 px): decoding the 2560 px
// original costs ~180 MB of RAM per render; this one costs a few MB.
const LOGO_PATH = path.join(__dirname, '../assets/logo_report.png');
const LOGO_FALLBACK = path.join(__dirname, '../assets/logo.png');
const ARABIC_FONT_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Regular.ttf');
// The ORIGINAL logo PNG has a white margin; only this part of it is drawn.
const FULL_LOGO_CROP = { x0: 0.18, y0: 0.135, x1: 0.833, y1: 0.81 };
const NO_CROP = { x0: 0, y0: 0, x1: 1, y1: 1 };

const STATUS_LABEL = {
  absent: 'Absent', sick: 'Sick', leave: 'Leave', holiday: 'Holiday', no_record: 'No record yet',
};

const isArabic = (s) => /[؀-ۿ]/.test(String(s || ''));

function clean(str) {
  return String(str ?? '').replace(/\s*→\s*/g, ' to ').replace(/[−—–]/g, '-');
}

function fmtLongDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function pct(a, b) {
  if (!b) return '-';
  return `${Math.round((a * 100) / b)}%`;
}

/**
 * @param {object} r
 *   report_no, report_date, shift_filter, recipient_name, issued_by_name,
 *   issued_by_title, generated_at ('YYYY-MM-DD HH:mm'), data { sites, totals },
 *   options { show_absent_names, include_staff }
 * @returns {Promise<Buffer>}
 */
function renderDailySiteReportPdf(r) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', layout: 'portrait', margin: 36, bufferPages: true,
      info: {
        Title: `Daily Site Manpower Report ${r.report_no} (${r.report_date})`,
        Author: COMPANY_NAME,
        Subject: 'Daily site manpower report',
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const hasArabicFont = fs.existsSync(ARABIC_FONT_PATH);
    if (hasArabicFont) doc.registerFont('Arabic', ARABIC_FONT_PATH);
    let logo = null;
    let LOGO_CROP = NO_CROP;
    const logoFile = fs.existsSync(LOGO_PATH) ? LOGO_PATH : (fs.existsSync(LOGO_FALLBACK) ? LOGO_FALLBACK : null);
    if (logoFile) {
      try { logo = doc.openImage(logoFile); } catch (_) { logo = null; }
      if (logoFile === LOGO_FALLBACK) LOGO_CROP = FULL_LOGO_CROP;
    }

    const L = doc.page.margins.left;
    const W = doc.page.width - L - doc.page.margins.right;
    const R = L + W;
    const FOOTER_H = 34;
    const bottom = () => doc.page.height - doc.page.margins.bottom - FOOTER_H;

    const sites = r.data.sites || [];
    const totals = r.data.totals;
    const showStaff = Boolean(r.options && r.options.include_staff);
    const showAway = Boolean(r.options && r.options.show_absent_names);

    // ---------------------------------------------------------------- utils
    const rect = (x, y, w, h, color) => { doc.save().rect(x, y, w, h).fill(color).restore(); };
    const hline = (x1, x2, y, color = P.grid, lw = 0.6) => {
      doc.save().lineWidth(lw).moveTo(x1, y).lineTo(x2, y).stroke(color).restore();
    };
    // Single-line text in a box, vertically centred. Arabic-aware.
    const cell = (str, x, y, w, h, o = {}) => {
      const raw = clean(str);
      if (!raw) return;
      const ar = hasArabicFont && isArabic(raw);
      const shown = ar ? raw.trim().split(/\s+/).reverse().join(' ') : raw;
      const font = ar ? 'Arabic' : (o.bold ? 'Helvetica-Bold' : 'Helvetica');
      const pad = o.pad ?? 5;
      const avail = Math.max(1, w - pad * 2);
      // Shrink to fit (down to 75 %), then cut with an ellipsis: never wrap.
      let size = o.size || 8.5;
      const spacing = o.spacing || 0;
      doc.font(font).fontSize(size);
      const measured = doc.widthOfString(shown, { characterSpacing: spacing });
      if (measured > avail) size = Math.max(size * 0.75, size * (avail / measured));
      const ty = y + (h - size) / 2 + (ar ? -1.5 : 0.5);
      doc.font(font).fontSize(size).fillColor(o.color || P.ink)
        .text(shown, x + pad, ty, {
          width: avail, height: size * 1.25, align: o.align || 'left', lineBreak: false, ellipsis: true,
          characterSpacing: spacing,
          features: ar ? ['rtla'] : undefined,
        });
    };
    const label = (str, x, y, w, o = {}) => cell(str, x, y, w, 10, { size: 6.8, bold: true, color: P.muted, spacing: 0.8, pad: 0, ...o });

    function drawLogo(x, y, h) {
      if (!logo) return 0;
      const cw = (LOGO_CROP.x1 - LOGO_CROP.x0) * logo.width;
      const ch = (LOGO_CROP.y1 - LOGO_CROP.y0) * logo.height;
      const s = h / ch;
      const w = cw * s;
      doc.save();
      doc.rect(x, y, w, h).clip();
      doc.image(logo, x - LOGO_CROP.x0 * logo.width * s, y - LOGO_CROP.y0 * logo.height * s,
        { width: logo.width * s, height: logo.height * s });
      doc.restore();
      return w;
    }

    // ------------------------------------------------------------- header
    function pageHeader(first) {
      const top = doc.page.margins.top;
      const logoH = first ? 50 : 30;
      drawLogo(L, top, logoH);
      const titleSize = first ? 16 : 11;
      doc.font('Helvetica-Bold').fontSize(titleSize).fillColor(P.charcoalDark)
        .text('DAILY SITE MANPOWER REPORT', L, top + (first ? 8 : 3), { width: W, align: 'right', characterSpacing: 0.6 });
      doc.font('Helvetica').fontSize(first ? 8.5 : 7.5).fillColor(P.goldDark)
        .text(first ? fmtLongDate(r.report_date).toUpperCase() : `${r.report_no}   |   ${fmtLongDate(r.report_date)}`,
          L, top + (first ? 30 : 18), { width: W, align: 'right', characterSpacing: first ? 1.2 : 0.3 });
      const y = top + logoH + 8;
      hline(L, R, y, P.gold, first ? 1.6 : 1);
      return y + (first ? 14 : 10);
    }

    function newPage() {
      doc.addPage();
      return pageHeader(false);
    }

    let y = pageHeader(true);
    const ensure = (h) => {
      if (y + h > bottom()) y = newPage();
    };

    // --------------------------------------------------------- meta block
    {
      const boxH = 74;
      const gap = 12;
      const leftW = W * 0.5 - gap / 2;
      const rightX = L + leftW + gap;
      const rightW = W - leftW - gap;

      // TO / FROM
      rect(L, y, leftW, boxH, P.goldPale);
      rect(L, y, 3, boxH, P.gold);
      label('PREPARED FOR', L + 14, y + 10, leftW - 20);
      cell(r.recipient_name || '-', L + 14, y + 20, leftW - 20, 16, { size: 11, bold: true, color: P.charcoalDark, pad: 0 });
      label('ISSUED BY', L + 14, y + 42, leftW - 20);
      const issuer = [r.issued_by_name, r.issued_by_title].filter(Boolean).join('  -  ');
      cell(`${issuer}`, L + 14, y + 52, leftW - 20, 13, { size: 9, color: P.ink, pad: 0 });

      // Report facts
      const facts = [
        ['REPORT NO.', r.report_no],
        ['REPORT DATE', fmtLongDate(r.report_date)],
        ['SHIFT', r.shift_filter === 'All' ? 'Day & Night' : `${r.shift_filter} only`],
        ['ISSUED AT', `${r.generated_at} (local time)`],
      ];
      doc.save().lineWidth(0.6).rect(rightX, y, rightW, boxH).stroke(P.greyMid).restore();
      const rowH = boxH / facts.length;
      facts.forEach(([k, v], i) => {
        const ry = y + i * rowH;
        if (i) hline(rightX + 10, rightX + rightW - 10, ry, P.greyMid, 0.5);
        label(k, rightX + 12, ry + (rowH - 10) / 2, 80);
        cell(v, rightX + 92, ry, rightW - 100, rowH, { size: 9, bold: i === 0, color: P.charcoalDark, pad: 0 });
      });
      y += boxH + 16;
    }

    // ----------------------------------------------------------- KPI tiles
    {
      const w = totals.workers;
      const s = totals.staff;
      const notOnSite = (w.assigned - w.on_site) + (showStaff ? (s.assigned - s.on_site) : 0);
      const tiles = [
        { k: 'ON SITE TODAY', v: String(totals.on_site_total), sub: `of ${totals.assigned_total} assigned  |  ${pct(totals.on_site_total, totals.assigned_total)}`, hero: true },
        { k: 'WORKERS ON SITE', v: String(w.on_site), sub: `of ${w.assigned} assigned` },
        ...(showStaff ? [{ k: 'STAFF ON SITE', v: String(s.on_site), sub: `of ${s.assigned} assigned` }] : []),
        { k: 'NOT ON SITE', v: String(notOnSite), sub: `${w.absent + s.absent} absent  |  ${w.sick + s.sick} sick  |  ${w.leave + w.holiday + s.leave + s.holiday} leave` },
        { k: 'SITES COVERED', v: String(totals.sites), sub: r.shift_filter === 'All' ? 'Day & Night shifts' : `${r.shift_filter} shift` },
      ];
      const gap = 8;
      const tw = (W - gap * (tiles.length - 1)) / tiles.length;
      const th = 62;
      tiles.forEach((t, i) => {
        const x = L + i * (tw + gap);
        rect(x, y, tw, th, t.hero ? P.charcoal : P.grey);
        if (t.hero) rect(x, y + th - 3, tw, 3, P.gold);
        label(t.k, x + 10, y + 9, tw - 16, { color: t.hero ? P.goldMid : P.muted, size: 6.5 });
        cell(t.v, x + 10, y + 21, tw - 16, 24, { size: 21, bold: true, color: t.hero ? P.white : P.charcoalDark, pad: 0 });
        cell(t.sub, x + 10, y + 46, tw - 14, 10, { size: 6.6, color: t.hero ? '#D9D8DB' : P.muted, pad: 0 });
      });
      y += th + 20;
    }

    // ------------------------------------------------------------- tables
    // columns: [{ title, w (fraction), align }]; rows: [{ cells: [], bold, fill }]
    function table(columns, rows, o = {}) {
      const rowH = o.rowH || 17;
      const headH = 19;
      const xs = [];
      let acc = L;
      const total = columns.reduce((a, c) => a + c.w, 0);
      const widths = columns.map((c) => (c.w / total) * W);
      widths.forEach((w) => { xs.push(acc); acc += w; });

      const head = () => {
        rect(L, y, W, headH, P.charcoal);
        columns.forEach((c, i) => cell(c.title, xs[i], y, widths[i], headH,
          { size: 6.8, bold: true, color: P.white, align: c.align || 'left', spacing: 0.3 }));
        y += headH;
      };
      ensure(headH + rowH * Math.min(rows.length, 3));
      head();
      rows.forEach((row, ri) => {
        if (y + rowH > bottom()) { y = newPage(); head(); }
        if (row.fill) rect(L, y, W, rowH, row.fill);
        else if (ri % 2 === 1) rect(L, y, W, rowH, P.zebra);
        row.cells.forEach((v, i) => cell(v, xs[i], y, widths[i], rowH, {
          size: row.size || 8.3, bold: row.bold || (columns[i].bold && !row.muted),
          color: row.color || (columns[i].color) || P.ink, align: columns[i].align || 'left',
        }));
        y += rowH;
        hline(L, R, y, P.greyMid, 0.4);
      });
      y += o.after ?? 14;
    }

    function sectionTitle(text, sub) {
      ensure(40);
      cell(text, L, y, W, 14, { size: 10.5, bold: true, color: P.charcoalDark, pad: 0, spacing: 0.4 });
      if (sub) cell(sub, L, y, W, 14, { size: 7.5, color: P.muted, pad: 0, align: 'right' });
      y += 16;
      rect(L, y, 28, 2, P.gold);
      y += 8;
    }

    // ------------------------------------------------- summary by site
    sectionTitle('SUMMARY BY SITE', 'On site = checked in on the report date');
    {
      const cols = [
        { title: 'SITE', w: 2.7, bold: true },
        { title: 'SHIFT', w: 0.9 },
        { title: 'SUPERVISOR', w: 2.2 },
        { title: 'ASSIGNED', w: 1.3, align: 'right' },
        { title: 'ON SITE', w: 1.15, align: 'right', bold: true },
        { title: 'ABSENT', w: 1.1, align: 'right' },
        { title: 'SICK', w: 0.8, align: 'right' },
        { title: 'LEAVE', w: 1.0, align: 'right' },
        { title: 'NO RECORD', w: 1.45, align: 'right' },
        { title: 'RATE', w: 0.9, align: 'right' },
      ];
      const rows = [];
      const sum = { assigned: 0, on_site: 0, absent: 0, sick: 0, leave: 0, no_record: 0 };
      const line = (siteName, shiftLabel, sup, c) => {
        rows.push({
          cells: [siteName, shiftLabel, sup || '-', c.assigned, c.on_site, c.absent || '-', c.sick || '-',
            (c.leave + c.holiday) || '-', c.no_record || '-', pct(c.on_site, c.assigned)],
        });
        sum.assigned += c.assigned; sum.on_site += c.on_site; sum.absent += c.absent; sum.sick += c.sick;
        sum.leave += c.leave + c.holiday; sum.no_record += c.no_record;
      };
      for (const s of sites) {
        s.shifts.forEach((sh, i) => line(i === 0 ? s.site_name : '', `${sh.shift_type}`, sh.supervisor, sh.counts));
        if (showStaff && s.staff && s.staff.counts.assigned > 0) line(s.shifts.length ? '' : s.site_name, 'Staff', '', s.staff.counts);
      }
      rows.push({
        fill: P.goldLight, bold: true, color: P.charcoalDark,
        cells: ['TOTAL', '', '', sum.assigned, sum.on_site, sum.absent || '-', sum.sick || '-', sum.leave || '-',
          sum.no_record || '-', pct(sum.on_site, sum.assigned)],
      });
      if (!sites.length) rows.unshift({ cells: ['No active site selected', '', '', '', '', '', '', '', '', ''] });
      table(cols, rows);
    }

    // ---------------------------------------------------- sign-off block
    // On the first page (the page the sub-contractor signs); the site pages
    // after it are the detail annex.
    function signOff() {
      const boxH = 92;
      if (y + boxH + 30 > bottom()) y = newPage();
      y = Math.max(y + 10, bottom() - boxH - 6);
      const gap = 16;
      const bw = (W - gap) / 2;
      const box = (x, title, name, sub) => {
        doc.save().lineWidth(0.7).rect(x, y, bw, boxH).stroke(P.greyMid).restore();
        rect(x, y, bw, 18, P.grey);
        label(title, x + 10, y + 4, bw - 20, { color: P.charcoal });
        cell(name || ' ', x + 10, y + 24, bw - 20, 14, { size: 9.5, bold: true, color: P.charcoalDark, pad: 0 });
        cell(sub || ' ', x + 10, y + 38, bw - 20, 12, { size: 8, color: P.muted, pad: 0 });
        hline(x + 10, x + bw * 0.62, y + boxH - 18, P.charcoal2, 0.6);
        hline(x + bw * 0.68, x + bw - 10, y + boxH - 18, P.charcoal2, 0.6);
        cell('Signature', x + 10, y + boxH - 16, bw * 0.5, 10, { size: 6.8, color: P.muted, pad: 0 });
        cell('Date', x + bw * 0.68, y + boxH - 16, bw * 0.3, 10, { size: 6.8, color: P.muted, pad: 0 });
      };
      box(L, `ISSUED BY  -  ${COMPANY_NAME}`, r.issued_by_name, r.issued_by_title);
      box(L + bw + gap, 'RECEIVED BY', r.recipient_name, 'Name, title and stamp');
      y += boxH;
    }

    signOff();

    // ------------------------------------------------- site detail pages
    function chips(c, x, yy) {
      const items = [
        ['Assigned', c.assigned], ['On site', c.on_site], ['Absent', c.absent], ['Sick', c.sick],
        ['Leave', c.leave + c.holiday], ['No record', c.no_record],
      ].filter(([k, v]) => v > 0 || k === 'Assigned' || k === 'On site');
      let cx = x;
      for (const [k, v] of items) {
        const txt = `${k}  ${v}`;
        doc.font('Helvetica-Bold').fontSize(7.2);
        const w = doc.widthOfString(txt) + 14;
        const strong = k === 'On site';
        doc.save().roundedRect(cx, yy, w, 14, 7).fill(strong ? P.charcoal : P.grey).restore();
        cell(txt, cx, yy, w, 14, { size: 7.2, bold: true, color: strong ? P.white : P.charcoalDark, align: 'center', pad: 0 });
        cx += w + 5;
      }
    }

    function tradesTable(trades) {
      if (!trades.length) return;
      // Compact: two trade lists side by side when long.
      const cols = [
        { title: 'TRADE / POSITION', w: 3 }, { title: 'ASSIGNED', w: 1, align: 'right' }, { title: 'ON SITE', w: 1, align: 'right', bold: true },
      ];
      const rows = trades.map((t) => ({ cells: [t.trade, t.assigned, t.on_site] }));
      table(cols, rows, { rowH: 15, after: 10 });
    }

    function peopleBlock(title, block, supervisor) {
      ensure(70);
      // block header band
      rect(L, y, W, 24, P.goldPale);
      rect(L, y, 3, 24, P.gold);
      cell(title, L + 10, y, W * 0.5, 24, { size: 9.5, bold: true, color: P.charcoalDark, pad: 0 });
      if (supervisor !== undefined) {
        cell(`Supervisor: ${supervisor || 'not assigned'}`, L + W * 0.45, y, W * 0.55 - 10, 24, { size: 8, color: P.muted, align: 'right', pad: 0 });
      }
      y += 30;
      chips(block.counts, L, y);
      y += 22;

      if (block.counts.assigned === 0) {
        cell('No one is assigned on this date.', L, y, W, 14, { size: 8.5, color: P.muted, pad: 0 });
        y += 22;
        return;
      }

      tradesTable(block.trades);

      if (block.present.length) {
        table([
          { title: '#', w: 0.45, align: 'right' }, { title: 'ID', w: 1.0 }, { title: 'NAME', w: 4.2 },
          { title: 'TRADE / POSITION', w: 2.4 }, { title: 'CHECK-IN', w: 1.1, align: 'right' },
        ], block.present.map((p, i) => ({ cells: [i + 1, p.code, p.name, p.trade, p.check_in || '-'] })), { rowH: 16 });
      }

      if (showAway && block.away.length) {
        ensure(40);
        cell('NOT ON SITE', L, y, W, 12, { size: 7.5, bold: true, color: P.muted, pad: 0, spacing: 0.8 });
        y += 14;
        table([
          { title: '#', w: 0.45, align: 'right' }, { title: 'ID', w: 1.0 }, { title: 'NAME', w: 4.2 },
          { title: 'TRADE / POSITION', w: 2.4 }, { title: 'STATUS', w: 1.1, align: 'right', bold: true },
        ], block.away.map((p, i) => ({ cells: [i + 1, p.code, p.name, p.trade, STATUS_LABEL[p.status] || p.status] })), { rowH: 16 });
      }

      const moves = [
        ...block.joined.map((p) => ['Joined this site today', p]),
        ...block.leaving.map((p) => ['Last day on this site', p]),
      ];
      if (moves.length) {
        ensure(40);
        cell('MOVEMENTS', L, y, W, 12, { size: 7.5, bold: true, color: P.muted, pad: 0, spacing: 0.8 });
        y += 14;
        table([{ title: 'MOVEMENT', w: 2.4 }, { title: 'ID', w: 1.0 }, { title: 'NAME', w: 4.2 }, { title: 'TRADE / POSITION', w: 2.4 }],
          moves.map(([k, p]) => ({ cells: [k, p.code, p.name, p.trade] })), { rowH: 16 });
      }
      y += 4;
    }

    for (const s of sites) {
      y = newPage();
      // Site band
      const bandH = 46;
      rect(L, y, W, bandH, P.charcoal);
      rect(L, y + bandH - 3, W, 3, P.gold);
      cell(s.site_name, L + 14, y + 6, W * 0.62, 20, { size: 14, bold: true, color: P.white, pad: 0 });
      const sub = [s.project_name, s.contract_name, s.location].filter(Boolean).join('   |   ');
      cell(sub || ' ', L + 14, y + 26, W * 0.62, 12, { size: 7.8, color: P.goldMid, pad: 0 });
      const siteOn = s.workers_counts.on_site + (showStaff ? s.staff_counts.on_site : 0);
      const siteAs = s.workers_counts.assigned + (showStaff ? s.staff_counts.assigned : 0);
      label('ON SITE', L + W - 130, y + 9, 116, { color: P.goldMid, align: 'right' });
      cell(`${siteOn} / ${siteAs}`, L + W - 160, y + 19, 146, 20, { size: 15, bold: true, color: P.white, align: 'right', pad: 0 });
      y += bandH + 14;

      for (const sh of s.shifts) {
        peopleBlock(`${sh.shift_type.toUpperCase()} SHIFT - WORKERS`, sh, sh.supervisor);
      }
      if (showStaff && s.staff && s.staff.counts.assigned > 0) {
        peopleBlock('SITE STAFF', s.staff, undefined);
      }
    }

    // ------------------------------------------------- footer on all pages
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const fy = doc.page.height - doc.page.margins.bottom - FOOTER_H + 10;
      // Writing inside the bottom margin must not trigger a new page.
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      hline(L, R, fy, P.greyMid, 0.6);
      doc.font('Helvetica').fontSize(6.6).fillColor(P.muted)
        .text('Figures are based on check-in records at the time of issue and remain subject to final attendance approval.',
          L, fy + 5, { width: W * 0.78, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(7).fillColor(P.charcoal)
        .text(`${COMPANY_NAME}   |   ${r.report_no}`, L, fy + 15, { width: W * 0.78, lineBreak: false, characterSpacing: 0.3 });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(P.goldDark)
        .text(`Page ${i - range.start + 1} of ${range.count}`, L, fy + 10, { width: W, align: 'right', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }

    doc.end();
  });
}

module.exports = { renderDailySiteReportPdf, COMPANY_NAME };
