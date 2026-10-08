// services/preliminaryReportPdfLayout.js
//
// Presentation only: draws the PRELIMINARY (unofficial) staff attendance &
// expected-payroll report built by staffPayrollPreviewService. No payroll or
// attendance logic lives here. Colours follow the ASIK logo (charcoal + gold).
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const COMPANY_NAME = 'ASIK ENGINEERING CONSTRUCTION';
const LOGO_PATH = path.join(__dirname, '../assets/logo.png');
const ARABIC_FONT_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Regular.ttf');
// The logo PNG has a lot of white margin; draw only this part of it (fractions of width/height).
const LOGO_CROP = { x0: 0.18, y0: 0.135, x1: 0.833, y1: 0.81 };

// Logo palette
const P = {
  charcoal: '#4B4A4D', charcoalDark: '#2F2E31', ink: '#2B2A2E', muted: '#6E6D72', white: '#FFFFFF',
  gold: '#CBAB5A', goldDark: '#8A6A1F', goldLight: '#F4ECD6', goldPale: '#FBF8EF',
  grey: '#F1F1F2', greyMid: '#E2E1E3', grid: '#D6D4D0', zebra: '#FAFAFA', friday: '#EDECEE',
  red: '#B3261E', redLight: '#FCE4E2', pending: '#D97706',
};

const TONES = {
  A: ['#FDE2E1', '#9C0006'], 'A*': ['#FCE4D6', '#843C0C'], S: ['#E4DFEC', '#5B3E8A'],
  V: ['#E2F0D9', '#375623'], H: ['#DDEBF7', '#1F4E79'],
  missing: [P.redLight, P.red], draft: [P.greyMid, P.red], rejected: [P.greyMid, P.red],
  friq: [P.goldLight, P.goldDark], ot: [P.goldLight, P.goldDark],
};

const isArabic = (s) => /[؀-ۿ]/.test(String(s || ''));
function clean(str) {
  return String(str ?? '').replace(/\s*→\s*/g, ' to ').replace(/−/g, '-').replace(/—/g, '-').replace(/[•]/g, '|');
}
// Arabic: reverse word order and let fontkit shape the letters with 'rtla'
// (same technique as monthlyReportPdfLayout).
function shape(str, hasArabicFont) {
  const text = String(str ?? '');
  if (!isArabic(text) || !hasArabicFont) return clean(text);
  return text.trim().split(/\s+/).reverse().join(' ');
}

const fmtHours = (v) => {
  const n = Number(v || 0);
  if (!n) return '-';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtDay = (v) => (typeof v === 'number'
  ? (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))
  : String(v ?? ''));

function renderPreliminaryReportPdf(report) {
  const usd = report.currency === 'USD';
  const fmtMoney = (v) => {
    if (v === null || v === undefined || v === '') return 'n/a';
    const n = Number(v);
    if (usd) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `${Math.round(n).toLocaleString('en-US')}`;
  };
  const moneyKpi = (v) => (usd ? fmtMoney(v) : `${fmtMoney(v)} ${report.currency}`);
  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const periodLabel = `${report.startDate} to ${report.endDate}`;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A3', layout: 'landscape', margin: 28, bufferPages: true,
      info: { Title: `PRELIMINARY staff attendance & expected payroll ${periodLabel}`, Author: 'Team Flow',
        Subject: 'Unofficial preliminary statement - not reviewed by Admin' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const hasArabicFont = fs.existsSync(ARABIC_FONT_PATH);
    if (hasArabicFont) doc.registerFont('Arabic', ARABIC_FONT_PATH);
    let logo = null;
    if (fs.existsSync(LOGO_PATH)) { try { logo = doc.openImage(LOGO_PATH); } catch (_) { logo = null; } }

    const L = doc.page.margins.left;
    const pageW = doc.page.width - L - doc.page.margins.right;
    const bottomLimit = () => doc.page.height - 42;
    const fontFor = (s, bold) => (hasArabicFont && isArabic(s) ? 'Arabic' : bold ? 'Helvetica-Bold' : 'Helvetica');

    const rect = (x, y, w, h, color) => { doc.save().rect(x, y, w, h).fill(color).restore(); };
    const strokeRect = (x, y, w, h, color = P.grid, lw = 0.5) => { doc.save().lineWidth(lw).rect(x, y, w, h).stroke(color).restore(); };
    const line = (x1, y1, x2, y2, color, lw = 1) => { doc.save().lineWidth(lw).moveTo(x1, y1).lineTo(x2, y2).stroke(color).restore(); };
    const text = (str, x, y, w, h, o = {}) => {
      const raw = String(str ?? '');
      if (!raw) return;
      const s = shape(raw, hasArabicFont);
      const size = o.size || 7;
      const lines = raw.split('\n').length;
      const ty = y + (h - size * 1.15 * lines) / 2 + 0.5;
      doc.font(o.font || fontFor(raw, o.bold)).fontSize(size).fillColor(o.color || P.ink)
        .text(s, x + 2, ty, {
          width: w - 4, align: o.align || 'center', lineGap: 0, height: h, ellipsis: lines === 1,
          features: isArabic(raw) && hasArabicFont ? ['rtla'] : undefined,
        });
    };
    const pendingMark = (x, y, w) => {
      doc.save().moveTo(x + w - 5, y).lineTo(x + w, y).lineTo(x + w, y + 5).closePath().fill(P.pending).restore();
    };

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

    // ---- page header ----------------------------------------------------
    function drawPageHeader(first) {
      let y = doc.page.margins.top;
      const logoH = first ? 62 : 36;
      drawLogo(L, y, logoH);

      // "not official" stamp (top right)
      const stampW = first ? 210 : 170;
      const stampH = first ? 34 : 22;
      const sx = L + pageW - stampW;
      doc.save().lineWidth(1.6).roundedRect(sx, y + 2, stampW, stampH, 4).stroke(P.red).restore();
      text('PRELIMINARY - NOT OFFICIAL', sx, y + 2, stampW, first ? 18 : stampH, { size: first ? 10.5 : 8.5, bold: true, color: P.red });
      if (first) text('Not reviewed by Admin', sx, y + 17, stampW, 17, { size: 8.5, color: P.red });

      doc.font('Helvetica-Bold').fontSize(first ? 18 : 12).fillColor(P.charcoalDark)
        .text('STAFF ATTENDANCE & EXPECTED PAYROLL', L, y + (first ? 6 : 4), { width: pageW, align: 'center' });
      doc.font('Helvetica').fontSize(first ? 9.5 : 8).fillColor(P.goldDark)
        .text(first ? `${COMPANY_NAME}   |   PRELIMINARY DRAFT FOR INTERNAL REVIEW`
          : `${COMPANY_NAME}   |   ${periodLabel}   |   PRELIMINARY (continued)`,
        L, y + (first ? 30 : 20), { width: pageW, align: 'center' });
      y += logoH + 6;
      line(L, y, L + pageW, y, P.gold, 2.4);
      line(L, y + 3.5, L + pageW, y + 3.5, P.charcoal, 0.8);
      y += 10;
      if (!first) return y;

      // Disclaimer (English + Arabic)
      const boxH = 44;
      rect(L, y, pageW, boxH, P.redLight);
      rect(L, y, 6, boxH, P.red);
      strokeRect(L, y, pageW, boxH, P.red, 0.8);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(P.red)
        .text('UNOFFICIAL STATEMENT - PRELIMINARY VERSION', L + 14, y + 7, { width: pageW - 28 });
      doc.font('Helvetica').fontSize(8.5).fillColor(P.ink)
        .text('The attendance records in this report have NOT yet been reviewed or approved by the Admin. '
          + 'Salaries are ESTIMATES calculated from Submitted and Approved records and may change after review. '
          + 'This document is not valid for payment or for any official use.', L + 14, y + 22, { width: pageW - 28 });
      y += boxH + 8;

      // Period band
      rect(L, y, pageW, 22, P.charcoal);
      rect(L, y + 20, pageW, 2, P.gold);
      text(`Period: ${periodLabel}   |   Counted: SUBMITTED + APPROVED records   |   Currency: ${report.currency}   |   Generated ${generatedAt}`,
        L, y, pageW, 20, { size: 9.5, bold: true, color: P.white });
      y += 28;

      // KPI cards
      const c = report.counts;
      const kpis = [
        ['Employees', String(report.rows.length)],
        ['Approved days', String(c.approved)],
        ['Submitted (awaiting approval)', String(c.submitted), P.pending],
        ['Draft / Rejected (not counted)', String(c.draft + c.rejected), (c.draft + c.rejected) ? P.red : null],
        ['Unpaid absence days', String(report.totals.unpaid), report.totals.unpaid ? P.red : null],
        ['Normal hours', fmtHours(report.totals.normal)],
        ['OT hours', fmtHours(report.totals.ot)],
        ['Expected net total', moneyKpi(report.totals.net), P.goldDark],
      ];
      const gap = 7;
      const kw = (pageW - gap * (kpis.length - 1)) / kpis.length;
      kpis.forEach(([label, value, color], i) => {
        const x = L + i * (kw + gap);
        rect(x, y, kw, 42, i === kpis.length - 1 ? P.goldLight : P.grey);
        rect(x, y + 40, kw, 2, i === kpis.length - 1 ? P.gold : P.charcoal);
        text(label.toUpperCase(), x, y + 3, kw, 12, { size: 6.6, bold: true, color: P.muted });
        text(value, x, y + 15, kw, 22, { size: 13, bold: true, color: color || P.charcoalDark });
      });
      y += 50;

      // Notes
      const notes = [
        'Expected salary uses the SAME formula as staff payroll generation (proration, standard hours per date, paid leave types, '
          + 'management-paid absences, OT offsetting worked-day shortage only). The only difference: Submitted days are counted as if approved.',
        'A working day with no Submitted/Approved record (shown "-", "D" or "R") is an UNPAID ABSENCE, exactly as payroll will treat it. '
          + 'Cells with an orange corner are Submitted and still awaiting Admin approval.',
      ];
      if (report.extendsPastToday) {
        notes.push(`The period ends after today (${report.today}). Days after today are not counted and the salary is prorated to date - `
          + 'the same result payroll would give if it were generated today.');
      }
      if (report.overlapBatches.length) {
        notes.push('A payroll batch already exists for part of this period: ' + report.overlapBatches.map((b) =>
          `#${b.staff_payroll_batch_id} (${b.start_date} to ${b.end_date}, ${b.status}${b.is_finalized ? ', finalized' : ''})`).join(', ')
          + '. A new batch cannot be generated for overlapping dates.');
      }
      notes.forEach((nt) => {
        doc.font('Helvetica-Oblique').fontSize(7.6);
        const t = clean(nt);
        const h = doc.heightOfString(t, { width: pageW - 16 }) + 5;
        rect(L, y, pageW, h, P.goldPale);
        rect(L, y, 3, h, P.gold);
        doc.fillColor(P.charcoalDark).text(t, L + 9, y + 2.5, { width: pageW - 16 });
        y += h;
      });
      return y + 10;
    }

    const sectionTitle = (y, title, sub) => {
      rect(L, y, pageW, 18, P.charcoal);
      rect(L, y, 5, 18, P.gold);
      text(title, L + 10, y, pageW - 20, 18, { size: 9, bold: true, color: P.white, align: 'left' });
      if (sub) text(sub, L + 10, y, pageW - 20, 18, { size: 7.5, color: P.goldLight, align: 'right' });
      return y + 18;
    };

    // ===== Table 1: day grid ============================================
    const fixedCols = [
      { h: 'S/N', w: 4 }, { h: 'Staff Name', w: 22, left: true, bold: true }, { h: 'Staff ID', w: 10 }, { h: 'Position', w: 12 },
    ];
    const tailCols = [
      { h: 'Present\ndays', w: 7, k: 'int' }, { h: 'Paid\nleave', w: 6, k: 'int' }, { h: 'Mgmt\npaid', w: 6, k: 'int' },
      { h: 'Unpaid\nabsence', w: 7.4, k: 'abs' }, { h: 'Awaiting\napproval', w: 8.4, k: 'pend' },
      { h: 'Normal\nhours', w: 7, k: 'hours' }, { h: 'OT\nhours', w: 6, k: 'hours' },
      { h: 'Base\n(prorated)', w: 10, k: 'money' }, { h: 'Deduction', w: 9, k: 'money' }, { h: 'EXPECTED\nNET', w: 11, k: 'net' },
    ];
    const cols = [
      ...fixedCols.map((c) => ({ ...c, type: 'fixed' })),
      ...report.days.map((d) => ({ w: 4.4, type: 'day', day: d })),
      ...tailCols.map((c) => ({ ...c, type: 'tail' })),
    ];
    const scale = pageW / cols.reduce((s, c) => s + c.w, 0);
    let cx = L;
    cols.forEach((c) => { c.x = cx; c.cw = c.w * scale; cx += c.cw; });
    const F = fixedCols.length;
    const fixedW = cols.slice(0, F).reduce((s, c) => s + c.cw, 0);

    const H1 = 12; const H2 = 13;
    function drawGridHeader(y) {
      cols.forEach((c) => {
        if (c.type === 'day') {
          const bg = c.day.isFriday ? P.charcoal : P.grey;
          const fg = c.day.isFriday ? P.white : P.charcoalDark;
          rect(c.x, y, c.cw, H1 + H2, bg);
          strokeRect(c.x, y, c.cw, H1); strokeRect(c.x, y + H1, c.cw, H2);
          text(c.day.dow, c.x - 1, y, c.cw + 2, H1, { size: 5.6, bold: true, color: fg });
          text(String(c.day.d), c.x, y + H1, c.cw, H2, { size: 7, bold: true, color: fg });
          return;
        }
        let bg = P.grey; let fg = P.charcoalDark;
        if (c.type === 'tail') {
          if (c.k === 'money') { bg = P.goldLight; fg = P.goldDark; }
          else if (c.k === 'net') { bg = P.gold; fg = P.white; }
          else if (c.k === 'abs') { bg = P.redLight; fg = P.red; }
          else if (c.k === 'pend') { bg = '#FDEBD3'; fg = '#9A4F00'; }
          else { bg = P.greyMid; }
        }
        rect(c.x, y, c.cw, H1 + H2, bg);
        strokeRect(c.x, y, c.cw, H1 + H2);
        text(c.h, c.x, y, c.cw, H1 + H2, { size: c.type === 'tail' ? 6.2 : 6.6, bold: true, color: fg });
      });
      line(L, y, L + pageW, y, P.charcoal, 1.2);
      line(L, y + H1 + H2, L + pageW, y + H1 + H2, P.gold, 1.4);
      return y + H1 + H2;
    }

    let y = drawPageHeader(true);
    y = sectionTitle(y, '1. DAILY ATTENDANCE GRID', 'hours worked per day  |  codes = leave / absence  |  orange corner = awaiting approval');
    y = drawGridHeader(y);
    const RH = 15;
    const gridNewPage = () => { doc.addPage(); y = drawPageHeader(false); y = drawGridHeader(y); };

    report.rows.forEach((row, idx) => {
      if (y + RH > bottomLimit()) gridNewPage();
      const zebra = idx % 2 ? P.zebra : P.white;
      const calc = row.calc;
      const tailVals = [
        calc ? calc.present_days : '', calc ? calc.paid_leave_days : '', calc ? calc.management_paid_days : '',
        calc ? calc.unpaid_absence_days : '', row.status.submitted,
        row.normal, row.ot,
        calc ? calc.prorated_base_salary : null, calc ? calc.salary_deduction : null, calc ? calc.net_salary : null,
      ];
      cols.forEach((c, ci) => {
        if (c.type === 'fixed') {
          const v = [idx + 1, row.name, row.uid, row.position][ci];
          rect(c.x, y, c.cw, RH, zebra);
          strokeRect(c.x, y, c.cw, RH);
          text(v, c.x + (c.left ? 2 : 0), y, c.cw - (c.left ? 2 : 0), RH, {
            size: c.bold ? 7.6 : 6.8, bold: c.bold, align: c.left ? (isArabic(v) ? 'right' : 'left') : 'center',
          });
          return;
        }
        if (c.type === 'day') {
          const e = row.days[c.day.date] || { kind: 'empty' };
          let fill = c.day.isFriday ? P.friday : zebra; let ink = P.ink; let bold = false; let val = '';
          if (e.kind === 'hours') {
            val = fmtDay(e.value);
            if (e.ot) { [fill, ink] = TONES.ot; bold = true; }
          } else if (e.kind === 'code') {
            val = e.value; [fill, ink] = TONES[e.value] || [fill, ink]; bold = true;
          } else if (['missing', 'draft', 'rejected', 'friq'].includes(e.kind)) {
            val = e.value; [fill, ink] = TONES[e.kind]; bold = true;
          } else if (e.kind === 'na') {
            fill = P.greyMid;
          } else if (e.kind === 'future') {
            fill = '#F7F7F8';
          }
          rect(c.x, y, c.cw, RH, fill);
          strokeRect(c.x, y, c.cw, RH);
          if (e.kind === 'na') line(c.x + 1, y + RH - 1, c.x + c.cw - 1, y + 1, P.grid, 0.6);
          if (val) text(val, c.x - 1, y, c.cw + 2, RH, { size: 6.4, bold, color: ink });
          if (e.pending) pendingMark(c.x, y, c.cw);
          return;
        }
        const ti = ci - F - report.days.length;
        const v = tailVals[ti];
        let bg = zebra; let color = P.ink; let bold = false; let s;
        if (c.k === 'money' || c.k === 'net') {
          s = fmtMoney(v);
          if (c.k === 'net') { bg = P.goldPale; bold = true; color = P.charcoalDark; }
          if (v === null) color = P.muted;
        } else if (c.k === 'hours') {
          s = fmtHours(v);
        } else {
          s = v === '' ? '' : String(v);
          if (c.k === 'abs' && Number(v) > 0) { color = P.red; bold = true; }
          if (c.k === 'pend' && Number(v) > 0) { color = '#9A4F00'; bold = true; bg = '#FEF5EA'; }
        }
        rect(c.x, y, c.cw, RH, bg);
        strokeRect(c.x, y, c.cw, RH);
        text(s, c.x, y, c.cw, RH, { size: 6.9, bold, color, align: c.k === 'money' || c.k === 'net' ? 'right' : 'center' });
      });
      y += RH;
    });

    // Grand total
    if (y + 18 > bottomLimit()) gridNewPage();
    const TH = 17;
    rect(L, y, pageW, TH, P.goldLight);
    text(`TOTAL  (${report.rows.length} employees)`, L, y, fixedW, TH, { size: 8, bold: true, color: P.charcoalDark });
    const t = report.totals;
    const totalTail = [t.present, t.paidLeave, t.mgmt, t.unpaid, report.counts.submitted, t.normal, t.ot, t.base, t.deduction, t.net];
    cols.forEach((c, ci) => {
      if (c.type !== 'tail') { if (c.type === 'day') strokeRect(c.x, y, c.cw, TH); return; }
      const v = totalTail[ci - F - report.days.length];
      if (c.k === 'net') rect(c.x, y, c.cw, TH, P.charcoal);
      strokeRect(c.x, y, c.cw, TH);
      const s = c.k === 'money' || c.k === 'net' ? fmtMoney(v) : c.k === 'hours' ? fmtHours(v) : String(v);
      text(s, c.x, y, c.cw, TH, { size: 7.2, bold: true, color: c.k === 'net' ? P.gold : P.charcoalDark,
        align: c.k === 'money' || c.k === 'net' ? 'right' : 'center' });
    });
    strokeRect(L, y, fixedW, TH);
    line(L, y, L + pageW, y, P.charcoal, 1.2);
    line(L, y + TH, L + pageW, y + TH, P.gold, 1.6);
    y += TH + 12;

    // Legend
    const legend = [
      ['8', TONES.ot, 'Hours incl. OT'], ['8', [P.white, P.ink], 'Hours worked'],
      ['A', TONES.A, 'Absent (unpaid)'], ['A*', TONES['A*'], 'Management-paid absence'],
      ['S', TONES.S, 'Sick'], ['V', TONES.V, 'Vacation'], ['H', TONES.H, 'Holiday'],
      ['-', TONES.missing, 'No record = unpaid absence'], ['D', TONES.draft, 'Draft (not counted)'],
      ['R', TONES.rejected, 'Rejected (not counted)'], ['F?', TONES.friq, 'Friday not confirmed'],
      ['', [P.greyMid, P.ink], 'Not employed'], ['', [P.white, P.ink], 'Awaiting approval', true],
    ];
    if (y + 16 > bottomLimit()) { doc.addPage(); y = drawPageHeader(false); }
    doc.font('Helvetica-Bold').fontSize(8).fillColor(P.charcoalDark).text('LEGEND', L, y + 3);
    let lx = L + 48;
    legend.forEach(([code, [fill, ink], label, pend]) => {
      doc.font('Helvetica').fontSize(7.2);
      const need = 26 + doc.widthOfString(label) + 14;
      if (lx + need > L + pageW) { lx = L + 48; y += 18; }
      rect(lx, y, 20, 13, fill);
      strokeRect(lx, y, 20, 13);
      if (code) text(code, lx, y, 20, 13, { size: 7, bold: true, color: ink });
      if (pend) pendingMark(lx, y, 20);
      doc.font('Helvetica').fontSize(7.2).fillColor(P.muted).text(label, lx + 24, y + 3, { lineBreak: false });
      lx += need;
    });
    y += 28;

    // ===== Table 2: salary calculation details =========================
    const dCols = [
      { h: 'S/N', w: 3.5 }, { h: 'Staff Name', w: 20, left: true, bold: true }, { h: 'Staff ID', w: 9 },
      { h: 'Monthly\nsalary', w: 9, k: 'money' }, { h: 'Working\ndays', w: 6 }, { h: 'Required\nhours', w: 7, k: 'hours' },
      { h: 'Counted\nhours', w: 7, k: 'hours' }, { h: 'OT\nearned', w: 6.5, k: 'hours' }, { h: 'OT used vs\nshortage', w: 7.5, k: 'hours' },
      { h: 'Uncovered\nshortage h', w: 8, k: 'hours' }, { h: 'Hourly\nrate', w: 7, k: 'money' },
      { h: 'Base\n(prorated)', w: 9, k: 'money' }, { h: 'Deduction', w: 8.5, k: 'money' }, { h: 'EXPECTED\nNET', w: 10, k: 'net' },
      { h: 'Records\nApp / Sub / Draft / Rej', w: 13 },
    ];
    const dScale = pageW / dCols.reduce((s, c) => s + c.w, 0);
    let dx = L;
    dCols.forEach((c) => { c.x = dx; c.cw = c.w * dScale; dx += c.cw; });
    const drawDetailHeader = (yy) => {
      dCols.forEach((c) => {
        const bg = c.k === 'net' ? P.gold : c.k === 'money' ? P.goldLight : P.grey;
        const fg = c.k === 'net' ? P.white : c.k === 'money' ? P.goldDark : P.charcoalDark;
        rect(c.x, yy, c.cw, 24, bg);
        strokeRect(c.x, yy, c.cw, 24);
        text(c.h, c.x, yy, c.cw, 24, { size: 6.6, bold: true, color: fg });
      });
      line(L, yy + 24, L + pageW, yy + 24, P.gold, 1.4);
      return yy + 24;
    };
    if (y + 70 > bottomLimit()) { doc.addPage(); y = drawPageHeader(false); }
    y = sectionTitle(y, '2. EXPECTED SALARY - CALCULATION DETAILS', 'same formula as payroll generation  |  estimate only');
    y = drawDetailHeader(y);
    report.rows.forEach((row, idx) => {
      if (y + RH > bottomLimit()) { doc.addPage(); y = drawPageHeader(false); y = drawDetailHeader(y); }
      const c = row.calc;
      const st = row.status;
      const vals = [
        idx + 1, row.name, row.uid,
        c ? c.monthly_salary : null, c ? c.required_days : '', c ? c.required_hours : '', c ? c.actual_regular_hours : '',
        c ? c.ot_earned_hours : '', c ? c.ot_used_hours : '', c ? c.uncovered_shortage_hours : '', c ? c.hourly_rate : null,
        c ? c.prorated_base_salary : null, c ? c.salary_deduction : null, c ? c.net_salary : null,
        `${st.approved} / ${st.submitted} / ${st.draft} / ${st.rejected}`,
      ];
      const zebra = idx % 2 ? P.zebra : P.white;
      dCols.forEach((col, i) => {
        const v = vals[i];
        let s = v; let bg = zebra; let bold = !!col.bold; let color = P.ink; let align = 'center';
        if (col.k === 'money' || col.k === 'net') { s = fmtMoney(v); align = 'right'; if (v === null) color = P.muted; }
        else if (col.k === 'hours') s = v === '' ? '' : fmtHours(v);
        if (col.k === 'net') { bg = P.goldPale; bold = true; color = v === null ? P.muted : P.charcoalDark; }
        if (col.left) align = isArabic(v) ? 'right' : 'left';
        if (i === dCols.length - 1 && (st.draft + st.rejected) > 0) color = P.red;
        rect(col.x, y, col.cw, RH, bg);
        strokeRect(col.x, y, col.cw, RH);
        text(s, col.x + (col.left ? 2 : 0), y, col.cw - (col.left ? 2 : 0), RH, { size: 6.9, bold, color, align });
      });
      y += RH;
    });
    y += 14;

    // ===== Table 3: items needing attention ===========================
    const items = report.attention;
    if (y + 60 > bottomLimit()) { doc.addPage(); y = drawPageHeader(false); }
    y = sectionTitle(y, `3. RECORDS NEEDING ATTENTION BEFORE APPROVAL (${items.length})`,
      items.length ? 'Draft / Rejected days are deducted as unpaid absence unless fixed' : '');
    if (!items.length) {
      rect(L, y, pageW, 18, P.goldPale);
      text('Nothing to flag: no Draft / Rejected days, unconfirmed Fridays or salary-history problems in this period.',
        L + 8, y, pageW - 16, 18, { size: 8, color: P.charcoalDark, align: 'left' });
      y += 18;
    } else {
      const ac = [{ w: 30, k: 'n' }, { w: 80, k: 'uid' }, { w: 180, k: 'name' }, { w: 80, k: 'date' }, { w: 90, k: 'kind' }];
      ac.push({ w: pageW - ac.reduce((s, c) => s + c.w, 0), k: 'detail' });
      const head = { n: '#', uid: 'Staff ID', name: 'Staff Name', date: 'Date', kind: 'Type', detail: 'Detail' };
      const drawAttHeader = (yy) => {
        let x = L;
        ac.forEach((c) => { rect(x, yy, c.w, 15, P.grey); strokeRect(x, yy, c.w, 15); text(head[c.k], x, yy, c.w, 15, { size: 7, bold: true, color: P.charcoalDark }); x += c.w; });
        return yy + 15;
      };
      y = drawAttHeader(y);
      items.forEach((it, i) => {
        doc.font('Helvetica').fontSize(7.2);
        const detail = clean(it.detail);
        const h = Math.max(14, doc.heightOfString(detail, { width: ac[5].w - 10 }) + 5);
        if (y + h > bottomLimit()) { doc.addPage(); y = drawPageHeader(false); y = drawAttHeader(y); }
        const vals = { n: String(i + 1), uid: it.uid, name: it.name, date: it.date || '-', kind: it.kind, detail };
        const red = ['Draft', 'Rejected', 'Salary data'].includes(it.kind);
        let x = L;
        ac.forEach((c) => {
          rect(x, y, c.w, h, i % 2 ? P.zebra : P.white);
          strokeRect(x, y, c.w, h);
          if (c.k === 'detail') {
            doc.font('Helvetica').fontSize(7.2).fillColor(P.ink).text(detail, x + 5, y + 3, { width: c.w - 10 });
          } else {
            text(vals[c.k], x, y, c.w, h, { size: 7.2, bold: c.k === 'kind', color: c.k === 'kind' && red ? P.red : P.ink,
              align: c.k === 'name' ? (isArabic(vals.name) ? 'right' : 'left') : 'center' });
          }
          x += c.w;
        });
        y += h;
      });
    }

    // ---- watermark + footer on every page -------------------------------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;

      const cxp = doc.page.width / 2; const cyp = doc.page.height / 2;
      doc.save();
      doc.rotate(-24, { origin: [cxp, cyp] });
      doc.fillOpacity(0.07).font('Helvetica-Bold').fontSize(80).fillColor(P.red)
        .text('PRELIMINARY - NOT OFFICIAL', -doc.page.width * 0.25, cyp - 40,
          { width: doc.page.width * 1.5, align: 'center', lineBreak: false });
      doc.restore();

      const fy = doc.page.height - 26;
      line(L, fy - 5, L + pageW, fy - 5, P.gold, 1);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(P.red)
        .text('NOT OFFICIAL - records not yet reviewed/approved by Admin - not valid for payment', L, fy, { width: pageW / 2, lineBreak: false });
      doc.font('Helvetica').fontSize(7.5).fillColor(P.muted)
        .text(`Team Flow  |  ${periodLabel}  |  Page ${i + 1} of ${range.count}`, L + pageW / 2, fy, { width: pageW / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

module.exports = { renderPreliminaryReportPdf };
