// services/dailySiteReportPdfLayout.js
//
// Daily Site Report (sent to the sub-contractor / client). LAYOUT V2,
// 2026-10-12. Presentation only. A4 portrait, ASIK logo palette
// (services/pdfBrand.js), PDFKit only (no headless browser), so it stays
// light on a small server.
//
// What is printed (head counts only, never names, IDs, check-in times,
// hours, rates or money):
//   Page 1  header, prepared for / issued by, report facts, KPI tiles,
//           summary by site, manpower by trade (trade x site matrix).
//   Then    one section per site: manpower by trade and shift, attendance
//           breakdown, and the notes typed at issue time (weather, work
//           carried out, plan for tomorrow, HSE, issues / instructions
//           required). An empty note is simply not printed.
//   End     sign-off boxes (Issued by / Received by).
//
// Reports saved before v2 (payload without `layout: 2`) are re-printed with
// this same layout: their payload has the counts and trades it needs; the
// name lists they also carry are simply not printed.
//
// Arabic text (sites, recipient, notes) uses the bundled Noto Naskh Arabic
// font. That font has no Latin letters, so text is drawn in runs: Arabic
// runs with the Arabic font ('rtla' shaping, words in visual order) and
// everything else with Helvetica. Paragraphs that are mostly Arabic are laid
// out right to left and right-aligned.

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { BRAND: P } = require('./pdfBrand');

const COMPANY_NAME = 'ASIK ENGINEERING CONSTRUCTION';
const LOGO_PATH = path.join(__dirname, '../assets/logo_report.png');
const LOGO_FALLBACK = path.join(__dirname, '../assets/logo.png');
const ARABIC_FONT_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Regular.ttf');
const FULL_LOGO_CROP = { x0: 0.18, y0: 0.135, x1: 0.833, y1: 0.81 };
const NO_CROP = { x0: 0, y0: 0, x1: 1, y1: 1 };

const WEATHER_LABEL = {
  sunny: 'Sunny', cloudy: 'Cloudy', rain: 'Rain', wind: 'Strong wind', dust: 'Dust',
  hot: 'Extreme heat', cold: 'Cold', storm: 'Storm',
};
const IMPACT_LABEL = { none: 'No impact on work', slowed: 'Work slowed', stopped: 'Work stopped' };
const HSE_LABEL = {
  no_incident: 'No incident', near_miss: 'Near miss', first_aid: 'First aid case', lost_time: 'Lost time incident',
};

const AR_CHAR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LATIN_LETTER = /[A-Za-z]/;

function clean(str) {
  return String(str ?? '')
    .replace(/\s*→\s*/g, ' to ')
    .replace(/[−—–]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-')
    .replace(/\t/g, ' ');
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

const dash = (v) => (Number(v) ? String(v) : '-');

function hasNotes(n) {
  if (!n) return false;
  return Boolean(n.weather || n.weather_impact || n.work_done || n.work_planned || n.hse_status
    || n.hse_details || n.toolbox_talk || n.issues);
}

/** Entry point for new reports and re-prints (any payload version). */
function renderDailySiteReportPdf(r) {
  return renderV2(r);
}

function renderV2(r) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', layout: 'portrait', margin: 36, bufferPages: true,
      info: {
        Title: `Daily Site Report ${r.report_no} (${r.report_date})`,
        Author: COMPANY_NAME,
        Subject: 'Daily site report',
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      draw(doc, r);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function draw(doc, r) {
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
  const totals = r.data.totals || {};
  const tw = totals.workers || {};
  const ts = totals.staff || {};
  const showStaff = Boolean(r.options && r.options.include_staff);
  const hasNight = sites.some((s) => (s.shifts || []).some((sh) => sh.shift_type === 'Night'));

  // ============================================================ text engine
  // A token is one word, split into segments that each use one font.
  const isAr = (s) => hasArabicFont && AR_CHAR.test(s);
  function segmentsOf(word) {
    const segs = [];
    for (const ch of word) {
      const ar = isAr(ch);
      const last = segs[segs.length - 1];
      if (last && last.ar === ar) last.text += ch;
      else segs.push({ text: ch, ar });
    }
    return segs;
  }
  const fontOf = (ar, bold) => (ar ? 'Arabic' : (bold ? 'Helvetica-Bold' : 'Helvetica'));
  function segWidth(seg, size, bold, spacing = 0) {
    doc.font(fontOf(seg.ar, bold)).fontSize(size);
    return doc.widthOfString(seg.text, seg.ar ? { features: ['rtla'] } : { characterSpacing: spacing });
  }
  function tokenize(str, size, bold, spacing = 0) {
    return clean(str).trim().split(/\s+/).filter(Boolean).map((w) => {
      const segs = segmentsOf(w);
      const width = segs.reduce((a, s) => a + segWidth(s, size, bold, spacing), 0);
      return { segs, w: width, ar: segs.some((s) => s.ar) };
    });
  }
  function spaceW(size, bold, spacing = 0) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    return doc.widthOfString(' ') + spacing * 2;
  }
  // Right-to-left context: a bracket is drawn mirrored, and a run of
  // punctuation stuck to a word is drawn in reverse order.
  const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
  const PUNCT_ONLY = /^[^\p{L}\p{N}]+$/u;
  const mirrorRun = (t) => [...t].reverse().map((ch) => MIRROR[ch] || ch).join('');
  function rtlToken(t) {
    if (t.ar) {
      const segs = [...t.segs].reverse().map((sg) => (!sg.ar && PUNCT_ONLY.test(sg.text) ? { ...sg, text: mirrorRun(sg.text) } : sg));
      return { ...t, segs };
    }
    const m = t.segs.length === 1 ? t.segs[0].text.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u) : null;
    if (!m || (!m[1] && !m[3])) return t;
    return { ...t, segs: [{ text: mirrorRun(m[3]) + m[2] + mirrorRun(m[1]), ar: false }] };
  }
  function isRtl(str) {
    const s = String(str || '');
    let ar = 0; let la = 0;
    for (const ch of s) { if (isAr(ch)) ar += 1; else if (LATIN_LETTER.test(ch)) la += 1; }
    return ar > 0 && ar >= la;
  }
  const lineWidth = (tokens, sp) => tokens.reduce((a, t) => a + t.w, 0) + sp * Math.max(0, tokens.length - 1);

  // Draws one line of tokens. Right-to-left lines: Arabic words in reverse
  // order, runs of Latin words keep their own order.
  function drawTokens(tokens, x, y, w, size, o) {
    const sp = spaceW(size, o.bold, o.spacing || 0);
    const lw = lineWidth(tokens, sp);
    let visual = tokens;
    if (o.rtl) {
      const groups = [];
      for (const t of tokens) {
        const last = groups[groups.length - 1];
        if (!t.ar && last && !last.ar) last.items.push(t);
        else groups.push({ ar: t.ar, items: [t] });
      }
      visual = groups.reverse().flatMap((g) => g.items).map(rtlToken);
    }
    const align = o.align || (o.rtl ? 'right' : 'left');
    let cx = x;
    if (align === 'right') cx = x + w - lw;
    else if (align === 'center') cx = x + (w - lw) / 2;
    for (const t of visual) {
      for (const s of t.segs) {
        const sw = segWidth(s, size, o.bold, o.spacing || 0);
        doc.font(fontOf(s.ar, o.bold)).fontSize(size).fillColor(o.color || P.ink)
          .text(s.text, cx, y + (s.ar ? -size * 0.24 : 0), {
            lineBreak: false, characterSpacing: s.ar ? 0 : (o.spacing || 0),
            features: s.ar ? ['rtla'] : undefined,
          });
        cx += sw;
      }
      cx += sp;
    }
  }

  // Single-line text in a box, vertically centred. Shrinks to fit (down to
  // 75 %), then cuts with "..." — never wraps.
  function cell(str, x, y, w, h, o = {}) {
    const raw = clean(str).trim();
    if (!raw) return;
    const pad = o.pad ?? 5;
    const avail = Math.max(1, w - pad * 2);
    let size = o.size || 8.5;
    const bold = Boolean(o.bold);
    const rtl = isRtl(raw);
    const spc = o.spacing || 0;
    let tokens = tokenize(raw, size, bold, spc);
    let lw = lineWidth(tokens, spaceW(size, bold, spc));
    if (lw > avail) {
      size = Math.max(size * 0.75, size * (avail / lw));
      tokens = tokenize(raw, size, bold, spc);
      lw = lineWidth(tokens, spaceW(size, bold, spc));
      if (lw > avail) {
        const ell = tokenize('...', size, bold, spc)[0];
        while (tokens.length > 1 && lineWidth(tokens, spaceW(size, bold, spc)) + ell.w > avail) tokens.pop();
        tokens.push(ell);
      }
    }
    const ty = y + (h - size) / 2 + 0.5;
    // A cell keeps its column alignment even for Arabic (only the word order
    // changes); paragraphs are the ones that align right when Arabic.
    drawTokens(tokens, x + pad, ty, avail, size, { bold, color: o.color, align: o.align || 'left', rtl, spacing: spc });
  }
  const label = (str, x, y, w, o = {}) => cell(str, x, y, w, 10, { size: 6.8, bold: true, color: P.muted, spacing: 0.8, pad: 0, ...o });

  // Wrapped paragraph(s). Returns the lines; draw with drawPara.
  function layoutPara(str, w, size, bold = false) {
    const out = [];
    const sp = spaceW(size, bold);
    for (const para of clean(str).split('\n')) {
      const rtl = isRtl(para);
      const tokens = tokenize(para, size, bold);
      if (!tokens.length) { out.push({ tokens: [], rtl }); continue; }
      let line = [];
      for (const t of tokens) {
        if (line.length && lineWidth([...line, t], sp) > w) { out.push({ tokens: line, rtl }); line = []; }
        line.push(t);
      }
      if (line.length) out.push({ tokens: line, rtl });
    }
    while (out.length && !out[out.length - 1].tokens.length) out.pop();
    return out;
  }
  function drawPara(lines, x, y, w, size, lineH, o = {}) {
    lines.forEach((ln, i) => {
      if (ln.tokens.length) drawTokens(ln.tokens, x, y + i * lineH, w, size, { ...o, rtl: ln.rtl, align: ln.rtl ? 'right' : 'left' });
    });
    return lines.length * lineH;
  }

  // ============================================================ primitives
  const rect = (x, y, w, h, color) => { doc.save().rect(x, y, w, h).fill(color).restore(); };
  const strokeRect = (x, y, w, h, color, lw = 0.6) => { doc.save().lineWidth(lw).rect(x, y, w, h).stroke(color).restore(); };
  const hline = (x1, x2, y, color = P.grid, lw = 0.6) => {
    doc.save().lineWidth(lw).moveTo(x1, y).lineTo(x2, y).stroke(color).restore();
  };
  function pill(text, x, y, o = {}) {
    const size = o.size || 7.2;
    doc.font('Helvetica-Bold').fontSize(size);
    const w = doc.widthOfString(text) + 16;
    const h = o.h || 14;
    doc.save().roundedRect(x, y, w, h, h / 2).fill(o.fill || P.grey).restore();
    cell(text, x, y, w, h, { size, bold: true, color: o.color || P.charcoalDark, align: 'center', pad: 0 });
    return w;
  }

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

  // ================================================================ header
  function pageHeader(first) {
    const top = doc.page.margins.top;
    const logoH = first ? 50 : 30;
    drawLogo(L, top, logoH);
    doc.font('Helvetica-Bold').fontSize(first ? 16 : 11).fillColor(P.charcoalDark)
      .text('DAILY SITE REPORT', L, top + (first ? 8 : 3), { width: W, align: 'right', characterSpacing: 0.6, lineBreak: false });
    doc.font('Helvetica').fontSize(first ? 8.5 : 7.5).fillColor(P.goldDark)
      .text(first ? fmtLongDate(r.report_date).toUpperCase() : `${r.report_no}   |   ${fmtLongDate(r.report_date)}`,
        L, top + (first ? 30 : 18), { width: W, align: 'right', characterSpacing: first ? 1.2 : 0.3, lineBreak: false });
    const y = top + logoH + 8;
    hline(L, R, y, P.gold, first ? 1.6 : 1);
    return y + (first ? 14 : 12);
  }

  let pageTop = 0;
  function newPage() {
    doc.addPage();
    const y0 = pageHeader(false);
    pageTop = y0;
    return y0;
  }

  let y = pageHeader(true);
  pageTop = y;
  const ensure = (h) => { if (y + h > bottom()) y = newPage(); };

  // ================================================================ tables
  // columns: [{ title, w (fraction), align, bold }]
  // rows:    [{ cells: [], bold, fill, color, group }]  group = full-width label row
  function table(columns, rows, o = {}) {
    const x0 = o.x ?? L;
    const width = o.w ?? W;
    let rowH = o.rowH || 17;
    const headH = o.headH || 19;
    const total = columns.reduce((a, c) => a + c.w, 0);
    const widths = columns.map((c) => (c.w / total) * width);
    const xs = [];
    let acc = x0;
    widths.forEach((cw) => { xs.push(acc); acc += cw; });

    const head = () => {
      rect(x0, y, width, headH, P.charcoal);
      columns.forEach((c, i) => {
        if (o.wrapHead && i > 0) {
          const size = 6.6;
          const lines = layoutPara(c.title, widths[i] - 6, size, true).slice(0, 2);
          const lh = 8;
          const top = y + (headH - lines.length * lh) / 2 + 0.5;
          lines.forEach((ln, li) => drawTokens(ln.tokens, xs[i] + 3, top + li * lh, widths[i] - 6, size,
            { bold: true, color: P.white, align: c.align === 'right' ? 'right' : 'center', rtl: ln.rtl }));
        } else {
          cell(c.title, xs[i], y, widths[i], headH, { size: 6.6, bold: true, color: P.white, align: c.align || 'left', spacing: 0.2, pad: 4 });
        }
      });
      y += headH;
    };
    // fit: a table that overflows the page by a few rows is tightened to
    // stay on it instead of leaving one orphan row on the next page.
    if (o.fit) {
      const avail = bottom() - y - headH;
      const over = rows.length * rowH - avail;
      if (over > 0 && over <= 4 * rowH && avail / rows.length >= 12.5) rowH = avail / rows.length;
    }
    if (y + headH + rowH * Math.min(rows.length, 3) > bottom()) y = newPage();
    head();
    let zebra = 0;
    rows.forEach((row) => {
      if (y + rowH > bottom()) { y = newPage(); head(); }
      if (row.group) {
        rect(x0, y, width, rowH, P.goldPale);
        rect(x0, y, 2.5, rowH, P.gold);
        cell(row.group, x0 + 4, y, width - 8, rowH, { size: 6.8, bold: true, color: P.goldDark, spacing: 0.8 });
        y += rowH;
        hline(x0, x0 + width, y, P.greyMid, 0.4);
        zebra = 0;
        return;
      }
      if (row.fill) rect(x0, y, width, rowH, row.fill);
      else if (zebra % 2 === 1) rect(x0, y, width, rowH, P.zebra);
      zebra += 1;
      row.cells.forEach((v, i) => cell(v, xs[i], y, widths[i], rowH, {
        size: row.size || 8.3,
        bold: row.bold || Boolean(columns[i].bold),
        color: row.color || columns[i].color || P.ink,
        align: columns[i].align || 'left',
      }));
      y += rowH;
      hline(x0, x0 + width, y, P.greyMid, 0.4);
    });
    y += o.after ?? 14;
  }

  function sectionTitle(text, sub) {
    ensure(60);
    cell(text, L, y, W * 0.6, 14, { size: 10.5, bold: true, color: P.charcoalDark, pad: 0, spacing: 0.4 });
    if (sub) cell(sub, L + W * 0.4, y, W * 0.6, 14, { size: 7.5, color: P.muted, pad: 0, align: 'right' });
    y += 16;
    rect(L, y, 28, 2, P.gold);
    y += 8;
  }

  // ============================================================ meta block
  {
    const boxH = 74;
    const gap = 12;
    const leftW = W * 0.5 - gap / 2;
    const rightX = L + leftW + gap;
    const rightW = W - leftW - gap;

    rect(L, y, leftW, boxH, P.goldPale);
    rect(L, y, 3, boxH, P.gold);
    label('PREPARED FOR', L + 14, y + 10, leftW - 20);
    cell(r.recipient_name || '-', L + 14, y + 20, leftW - 20, 16, { size: 11, bold: true, color: P.charcoalDark, pad: 0 });
    label('ISSUED BY', L + 14, y + 42, leftW - 20);
    const issuer = [r.issued_by_name, r.issued_by_title].filter(Boolean).join('  -  ');
    cell(issuer || '-', L + 14, y + 52, leftW - 20, 13, { size: 9, color: P.ink, pad: 0 });

    const siteCount = totals.sites ?? sites.length;
    const facts = [
      ['REPORT NO.', r.report_no],
      ['REPORT DATE', fmtLongDate(r.report_date)],
      ['COVERAGE', `${siteCount} site${siteCount === 1 ? '' : 's'}  |  ${r.shift_filter === 'All' ? 'Day & Night shifts' : `${r.shift_filter} shift only`}`],
      ['ISSUED AT', `${r.generated_at} (local time)`],
    ];
    strokeRect(rightX, y, rightW, boxH, P.greyMid);
    const rowH = boxH / facts.length;
    facts.forEach(([k, v], i) => {
      const ry = y + i * rowH;
      if (i) hline(rightX + 10, rightX + rightW - 10, ry, P.greyMid, 0.5);
      label(k, rightX + 12, ry + (rowH - 10) / 2, 80);
      cell(v, rightX + 92, ry, rightW - 100, rowH, { size: 9, bold: i === 0, color: P.charcoalDark, pad: 0 });
    });
    y += boxH + 16;
  }

  // ============================================================== KPI tiles
  {
    const sum = (k) => (Number(tw[k]) || 0) + (showStaff ? (Number(ts[k]) || 0) : 0);
    const onSite = Number(totals.on_site_total) || 0;
    const assigned = Number(totals.assigned_total) || 0;
    const notOnSite = assigned - onSite;
    const dayOn = sites.reduce((a, s) => a + (s.shifts || []).filter((x) => x.shift_type === 'Day').reduce((b, x) => b + x.counts.on_site, 0), 0);
    const nightOn = sites.reduce((a, s) => a + (s.shifts || []).filter((x) => x.shift_type === 'Night').reduce((b, x) => b + x.counts.on_site, 0), 0);

    const notOnParts = [];
    if (sum('absent')) notOnParts.push(`${sum('absent')} absent`);
    if (sum('sick')) notOnParts.push(`${sum('sick')} sick`);
    if (sum('leave') + sum('holiday')) notOnParts.push(`${sum('leave') + sum('holiday')} leave`);
    if (sum('no_record')) notOnParts.push(`${sum('no_record')} no record`);

    const tiles = [
      { k: 'TOTAL MANPOWER ON SITE', v: String(onSite), sub: `of ${assigned} assigned  |  ${pct(onSite, assigned)} attendance`, hero: true, flex: 1.5 },
      { k: 'WORKERS', v: String(tw.on_site || 0), sub: hasNight ? `Day ${dayOn}  |  Night ${nightOn}` : `of ${tw.assigned || 0} assigned` },
      ...(showStaff ? [{ k: 'STAFF', v: String(ts.on_site || 0), sub: `of ${ts.assigned || 0} assigned` }] : []),
      { k: 'NOT ON SITE', v: String(notOnSite), sub: notOnParts.join('  |  ') || 'everyone is on site' },
    ];

    // Safety tile only when HSE was reported for at least one site.
    const hse = sites.map((s) => s.notes && s.notes.hse_status).filter(Boolean);
    if (hse.length) {
      const inc = hse.filter((h) => h !== 'no_incident');
      const parts = ['near_miss', 'first_aid', 'lost_time']
        .map((k) => [k, inc.filter((h) => h === k).length]).filter(([, c]) => c)
        .map(([k, c]) => `${c} ${HSE_LABEL[k].toLowerCase()}`);
      tiles.push({ k: 'SAFETY', v: inc.length ? String(inc.length) : '0', sub: inc.length ? parts.join('  |  ') : `incidents  |  ${hse.length} site${hse.length === 1 ? '' : 's'} reported` });
    }

    const gap = 8;
    const flexSum = tiles.reduce((a, t) => a + (t.flex || 1), 0);
    const unit = (W - gap * (tiles.length - 1)) / flexSum;
    const th = 62;
    let x = L;
    tiles.forEach((t) => {
      const w = unit * (t.flex || 1);
      rect(x, y, w, th, t.hero ? P.charcoal : P.grey);
      if (t.hero) rect(x, y + th - 3, w, 3, P.gold);
      label(t.k, x + 10, y + 9, w - 16, { color: t.hero ? P.goldMid : P.muted, size: 6.5 });
      cell(t.v, x + 10, y + 21, w - 16, 24, { size: 21, bold: true, color: t.hero ? P.white : P.charcoalDark, pad: 0 });
      cell(t.sub, x + 10, y + 46, w - 14, 10, { size: 6.6, color: t.hero ? '#D9D8DB' : P.muted, pad: 0 });
      x += w + gap;
    });
    y += th + 20;
  }

  // ======================================================== summary by site
  const supervisorsOf = (s) => [...new Set((s.shifts || []).map((sh) => sh.supervisor).filter(Boolean))].join(' / ');
  const shiftOn = (s, type) => (s.shifts || []).filter((x) => x.shift_type === type).reduce((a, x) => a + x.counts.on_site, 0);
  const siteCounts = (s) => {
    const c = { ...(s.workers_counts || {}) };
    if (showStaff && s.staff_counts) for (const k of Object.keys(c)) c[k] = (c[k] || 0) + (s.staff_counts[k] || 0);
    return c;
  };

  sectionTitle('SUMMARY BY SITE', 'On site = checked in on the report date');
  {
    const cols = [
      { title: 'SITE', w: 2.3, bold: true },
      { title: 'SUPERVISOR', w: 1.9 },
      { title: 'DAY', w: 0.75, align: 'right' },
      ...(hasNight ? [{ title: 'NIGHT', w: 0.85, align: 'right' }] : []),
      ...(showStaff ? [{ title: 'STAFF', w: 0.8, align: 'right' }] : []),
      { title: 'ON SITE', w: 1.0, align: 'right', bold: true },
      { title: 'ASSIGNED', w: 1.25, align: 'right' },
      { title: 'ABSENT', w: 0.95, align: 'right' },
      { title: 'SICK', w: 0.72, align: 'right' },
      { title: 'LEAVE', w: 0.85, align: 'right' },
      { title: 'NO REC.', w: 1.05, align: 'right' },
      { title: 'RATE', w: 0.8, align: 'right' },
    ];
    const sum = { day: 0, night: 0, staff: 0, assigned: 0, on_site: 0, absent: 0, sick: 0, leave: 0, no_record: 0 };
    const rows = sites.map((s) => {
      const c = siteCounts(s);
      const day = shiftOn(s, 'Day');
      const night = shiftOn(s, 'Night');
      const staffOn = s.staff_counts ? s.staff_counts.on_site || 0 : 0;
      const leave = (c.leave || 0) + (c.holiday || 0);
      sum.day += day; sum.night += night; sum.staff += staffOn; sum.assigned += c.assigned || 0;
      sum.on_site += c.on_site || 0; sum.absent += c.absent || 0; sum.sick += c.sick || 0;
      sum.leave += leave; sum.no_record += c.no_record || 0;
      return {
        cells: [s.site_name, supervisorsOf(s) || '-', dash(day), ...(hasNight ? [dash(night)] : []),
          ...(showStaff ? [dash(staffOn)] : []), c.on_site || 0, c.assigned || 0, dash(c.absent), dash(c.sick),
          dash(leave), dash(c.no_record), pct(c.on_site || 0, c.assigned || 0)],
      };
    });
    if (!rows.length) rows.push({ cells: ['No active site selected', ...cols.slice(1).map(() => '')] });
    rows.push({
      fill: P.goldLight, bold: true, color: P.charcoalDark,
      cells: ['TOTAL', '', dash(sum.day), ...(hasNight ? [dash(sum.night)] : []), ...(showStaff ? [dash(sum.staff)] : []),
        sum.on_site, sum.assigned, dash(sum.absent), dash(sum.sick), dash(sum.leave), dash(sum.no_record),
        pct(sum.on_site, sum.assigned)],
    });
    table(cols, rows);
  }

  // ============================================ manpower by trade (matrix)
  // Trade rows x site columns, value = people on site. Staff positions are
  // listed under their own group.
  function tradeIndex(siteList, pick) {
    const map = new Map();
    for (const s of siteList) {
      for (const t of pick(s)) {
        const row = map.get(t.trade) || { trade: t.trade, per: new Map(), on: 0, as: 0 };
        row.per.set(s.site_id, (row.per.get(s.site_id) || 0) + t.on_site);
        row.on += t.on_site;
        row.as += t.assigned;
        map.set(t.trade, row);
      }
    }
    return [...map.values()].sort((a, b) => b.on - a.on || b.as - a.as || a.trade.localeCompare(b.trade));
  }
  const workerTrades = (s) => (s.shifts || []).flatMap((sh) => sh.trades || []);
  const staffTrades = (s) => (showStaff && s.staff ? s.staff.trades || [] : []);

  // One site: its own section already has the trade table, so no matrix.
  if (sites.length > 1) {
    const wRows = tradeIndex(sites, workerTrades);
    const sRows = tradeIndex(sites, staffTrades);
    if (wRows.length || sRows.length) {
      sectionTitle('MANPOWER BY TRADE', 'People on site today, by trade and site');
      const MAX_COLS = 7;
      for (let i = 0; i < sites.length; i += MAX_COLS) {
        const part = sites.slice(i, i + MAX_COLS);
        const single = sites.length === 1;
        const cols = [
          { title: 'TRADE / POSITION', w: 2.6, bold: false },
          ...(single ? [] : part.map((s) => ({ title: s.site_name, w: 1, align: 'center' }))),
          { title: single ? 'ON SITE' : 'TOTAL ON SITE', w: 1.05, align: 'center', bold: true },
          { title: 'ASSIGNED', w: 0.95, align: 'center' },
        ];
        const toRow = (t) => ({
          cells: [t.trade, ...(single ? [] : part.map((s) => dash(t.per.get(s.site_id) || 0))), t.on, t.as],
        });
        const rows = [];
        if (wRows.length) {
          if (sRows.length) rows.push({ group: 'WORKERS' });
          rows.push(...wRows.map(toRow));
        }
        if (sRows.length) {
          rows.push({ group: 'SITE STAFF' });
          rows.push(...sRows.map(toRow));
        }
        const all = [...wRows, ...sRows];
        const colTotal = (s) => all.reduce((a, t) => a + (t.per.get(s.site_id) || 0), 0);
        rows.push({
          fill: P.goldLight, bold: true, color: P.charcoalDark,
          cells: ['TOTAL', ...(single ? [] : part.map((s) => dash(colTotal(s)))),
            all.reduce((a, t) => a + t.on, 0), all.reduce((a, t) => a + t.as, 0)],
        });
        const longest = Math.max(0, ...part.map((s) => String(s.site_name || '').length));
        table(cols, rows, { rowH: 16, headH: !single && longest > 9 ? 28 : 19, wrapHead: !single, fit: true });
      }
    }
  }

  // ========================================================== site sections
  function noteBox(title, text, x, w, o = {}) {
    const size = 8.6;
    const lineH = 12.2;
    const lines = layoutPara(text, w - 20, size);
    const h = 24 + lines.length * lineH + 8;
    return {
      h,
      draw(yy) {
        rect(x, yy, w, h, o.fill || P.zebra);
        rect(x, yy, 2.5, h, o.bar || P.greyMid);
        label(title, x + 10, yy + 8, w - 20, { color: o.titleColor || P.muted });
        drawPara(lines, x + 10, yy + 22, w - 20, size, lineH, { color: P.ink });
      },
    };
  }

  function attendanceCard(c, x, yy, w) {
    const h = 150;
    strokeRect(x, yy, w, h, P.greyMid);
    rect(x, yy, w, 20, P.grey);
    label('ATTENDANCE', x + 10, yy + 5, w - 20, { color: P.charcoal });
    const rate = c.assigned ? Math.round((c.on_site * 100) / c.assigned) : 0;
    cell(c.assigned ? `${rate}%` : '-', x + 10, yy + 26, w - 20, 24, { size: 20, bold: true, color: P.charcoalDark, pad: 0 });
    cell('on site', x + 10, yy + 26, w - 20, 24, { size: 7.5, color: P.muted, pad: 0, align: 'right' });
    // Stacked bar: on site / absent / sick / leave / no record.
    const bx = x + 10; const bw = w - 20; const by = yy + 54; const bh = 7;
    rect(bx, by, bw, bh, P.greyMid);
    const parts = [
      [c.on_site, P.charcoal], [c.absent, P.gold], [c.sick, P.goldMid], [(c.leave || 0) + (c.holiday || 0), P.goldLight],
    ];
    let cx = bx;
    if (c.assigned) {
      for (const [v, color] of parts) {
        const pw = (bw * (v || 0)) / c.assigned;
        if (pw > 0) rect(cx, by, pw, bh, color);
        cx += pw;
      }
    }
    const items = [
      ['Assigned', c.assigned, null],
      ['On site', c.on_site, P.charcoal],
      ['Absent', c.absent, P.gold],
      ['Sick', c.sick, P.goldMid],
      ['Leave / holiday', (c.leave || 0) + (c.holiday || 0), P.goldLight],
      ['Not checked in yet', c.no_record, P.greyMid],
    ];
    let iy = by + 14;
    items.forEach(([k, v, color], i) => {
      if (color) rect(x + 10, iy + 4, 6, 6, color);
      cell(k, x + (color ? 20 : 10), iy, w * 0.7, 13, { size: 7.8, color: i === 0 ? P.charcoalDark : P.ink, bold: i === 0, pad: 0 });
      cell(String(v || 0), x + 10, iy, w - 20, 13, { size: 8, bold: true, color: P.charcoalDark, pad: 0, align: 'right' });
      iy += 13;
    });
    return h;
  }

  function siteSection(s, idx) {
    const workerShifts = s.shifts || [];
    const siteHasNight = workerShifts.some((sh) => sh.shift_type === 'Night');
    const tradeRowsW = new Map();
    for (const sh of workerShifts) {
      for (const t of sh.trades || []) {
        const row = tradeRowsW.get(t.trade) || { trade: t.trade, day: 0, night: 0, on: 0, as: 0 };
        if (sh.shift_type === 'Night') row.night += t.on_site; else row.day += t.on_site;
        row.on += t.on_site;
        row.as += t.assigned;
        tradeRowsW.set(t.trade, row);
      }
    }
    const wRows = [...tradeRowsW.values()].sort((a, b) => b.on - a.on || b.as - a.as || a.trade.localeCompare(b.trade));
    const sRows = (showStaff && s.staff ? s.staff.trades || [] : [])
      .map((t) => ({ trade: t.trade, day: t.on_site, night: 0, on: t.on_site, as: t.assigned }))
      .sort((a, b) => b.on - a.on || a.trade.localeCompare(b.trade));
    const c = siteCounts(s);
    const n = s.notes || {};

    // Keep the band + the manpower block together.
    const tableRows = wRows.length + sRows.length + (sRows.length && wRows.length ? 2 : (sRows.length ? 1 : 0)) + 1;
    const blockH = 46 + 8 + 24 + 10 + Math.max(150, 19 + tableRows * 15) + 10;
    const firstOfMany = idx === 0 && sites.length > 1;
    if (firstOfMany || (y > pageTop + 1 && y + Math.min(blockH, 330) > bottom())) y = newPage();
    else y += 6;

    // ---- band
    const bandH = 46;
    rect(L, y, W, bandH, P.charcoal);
    rect(L, y + bandH - 3, W, 3, P.gold);
    cell(s.site_name, L + 14, y + 6, W * 0.64, 20, { size: 14, bold: true, color: P.white, pad: 0 });
    const sub = [s.project_name, s.contract_name, s.location].filter(Boolean).join('   |   ');
    cell(sub || ' ', L + 14, y + 26, W * 0.64, 12, { size: 7.8, color: P.goldMid, pad: 0 });
    label('ON SITE', L + W - 130, y + 9, 116, { color: P.goldMid, align: 'right' });
    cell(`${c.on_site || 0} / ${c.assigned || 0}`, L + W - 160, y + 19, 146, 20, { size: 15, bold: true, color: P.white, align: 'right', pad: 0 });
    y += bandH;

    // ---- info strip: supervisors + weather
    {
      const h = 24;
      rect(L, y, W, h, P.grey);
      const sups = workerShifts.length > 1
        ? workerShifts.map((sh) => `${sh.shift_type}: ${sh.supervisor || 'not assigned'}`).join('  |  ')
        : (workerShifts[0] && workerShifts[0].supervisor) || 'not assigned';
      label('SUPERVISOR', L + 12, y + 7, 70);
      cell(sups, L + 76, y, W * 0.55 - 70, h, { size: 8, color: P.charcoalDark, pad: 0 });
      const weather = [WEATHER_LABEL[n.weather], IMPACT_LABEL[n.weather_impact]].filter(Boolean).join('  -  ');
      if (weather) {
        label('WEATHER', L + W * 0.56, y + 7, 52);
        cell(weather, L + W * 0.56 + 54, y, W * 0.44 - 66, h, {
          size: 8, color: n.weather_impact && n.weather_impact !== 'none' ? P.goldDark : P.charcoalDark,
          bold: Boolean(n.weather_impact && n.weather_impact !== 'none'), pad: 0,
        });
      }
      y += h + 10;
    }

    // ---- manpower (left) + attendance card (right)
    {
      const gap = 12;
      const cardW = 158;
      const tableW = W - cardW - gap;
      const startY = y;
      const startPage = doc.bufferedPageRange().count;
      const cardH = attendanceCard(c, L + tableW + gap, y, cardW);

      if (wRows.length || sRows.length) {
        const cols = [
          { title: 'TRADE / POSITION', w: 2.6 },
          ...(siteHasNight ? [{ title: 'DAY', w: 0.8, align: 'right' }, { title: 'NIGHT', w: 0.8, align: 'right' }] : []),
          { title: 'ON SITE', w: 0.95, align: 'right', bold: true },
          { title: 'ASSIGNED', w: 1.0, align: 'right' },
        ];
        const toRow = (t, isStaff) => ({
          cells: [t.trade, ...(siteHasNight ? [isStaff ? '-' : dash(t.day), isStaff ? '-' : dash(t.night)] : []), t.on, t.as],
        });
        const rows = [];
        if (wRows.length) {
          if (sRows.length) rows.push({ group: 'WORKERS' });
          rows.push(...wRows.map((t) => toRow(t, false)));
        }
        if (sRows.length) {
          rows.push({ group: 'SITE STAFF' });
          rows.push(...sRows.map((t) => toRow(t, true)));
        }
        const all = [...wRows, ...sRows];
        rows.push({
          fill: P.goldLight, bold: true, color: P.charcoalDark,
          cells: ['TOTAL', ...(siteHasNight ? [dash(wRows.reduce((a, t) => a + t.day, 0)), dash(wRows.reduce((a, t) => a + t.night, 0))] : []),
            all.reduce((a, t) => a + t.on, 0), all.reduce((a, t) => a + t.as, 0)],
        });
        table(cols, rows, { x: L, w: tableW, rowH: 15, after: 0 });
      } else {
        cell('No one is assigned to this site on this date.', L, y, tableW, 16, { size: 8.5, color: P.muted, pad: 0 });
        y += 16;
      }
      const samePage = doc.bufferedPageRange().count === startPage;
      y = samePage ? Math.max(y, startY + cardH) : y;
      y += 12;
    }

    // ---- notes (printed only when typed)
    if (!hasNotes(n)) return;
    const gap = 12;
    const half = (W - gap) / 2;
    const place = (boxes) => {
      const h = Math.max(...boxes.map((b) => b.h));
      ensure(h + 4);
      boxes.forEach((b) => b.draw(y));
      y += h + 8;
    };

    if (n.work_done && n.work_planned) {
      place([
        noteBox('WORK CARRIED OUT TODAY', n.work_done, L, half),
        noteBox('PLANNED FOR TOMORROW', n.work_planned, L + half + gap, half),
      ]);
    } else if (n.work_done) {
      place([noteBox('WORK CARRIED OUT TODAY', n.work_done, L, W)]);
    } else if (n.work_planned) {
      place([noteBox('PLANNED FOR TOMORROW', n.work_planned, L, W)]);
    }

    if (n.hse_status || n.hse_details || n.toolbox_talk) {
      const size = 8.6;
      const lineH = 12.2;
      const details = n.hse_details ? layoutPara(n.hse_details, W - 20, size) : [];
      const TBT_W = 78;
      const tbt = n.toolbox_talk ? layoutPara(n.toolbox_talk, W - 20 - TBT_W, size) : [];
      const h = 26 + (tbt.length + details.length) * lineH + (details.length && tbt.length ? 3 : 0) + 6;
      ensure(h + 4);
      const incident = n.hse_status && n.hse_status !== 'no_incident';
      rect(L, y, W, h, incident ? P.goldPale : P.zebra);
      rect(L, y, 2.5, h, incident ? P.gold : P.charcoal2);
      label('HEALTH, SAFETY & ENVIRONMENT', L + 10, y + 9, 200, { color: incident ? P.goldDark : P.muted });
      if (n.hse_status) {
        doc.font('Helvetica-Bold').fontSize(7.2);
        const txt = HSE_LABEL[n.hse_status] || n.hse_status;
        const pw = doc.widthOfString(txt) + 16;
        pill(txt, R - 10 - pw, y + 7, { fill: incident ? P.charcoal : P.greyMid, color: incident ? P.white : P.charcoalDark });
      }
      let yy = y + 26;
      if (tbt.length) label('TOOLBOX TALK', L + 10, yy + 1, TBT_W - 6, { size: 6.4 });
      yy += drawPara(tbt, L + 10 + TBT_W, yy, W - 20 - TBT_W, size, lineH, { color: P.charcoalDark });
      if (details.length && tbt.length) yy += 3;
      drawPara(details, L + 10, yy, W - 20, size, lineH, { color: P.ink });
      y += h + 8;
    }

    if (n.issues) {
      place([noteBox('ISSUES, DELAYS & INSTRUCTIONS REQUIRED', n.issues, L, W,
        { fill: P.goldPale, bar: P.gold, titleColor: P.goldDark })]);
    }
  }

  sites.forEach((s, i) => siteSection(s, i));

  // =============================================================== sign-off
  {
    const boxH = 80;
    if (y + boxH + 16 > bottom()) y = newPage();
    else y += 10;
    const gap = 16;
    const bw = (W - gap) / 2;
    const box = (x, title, name, sub) => {
      strokeRect(x, y, bw, boxH, P.greyMid, 0.7);
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

  // ================================================== footer on all pages
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - doc.page.margins.bottom - FOOTER_H + 10;
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    hline(L, R, fy, P.greyMid, 0.6);
    doc.font('Helvetica').fontSize(6.6).fillColor(P.muted)
      .text('Manpower figures are based on check-in records at the time of issue and remain subject to final attendance approval.',
        L, fy + 5, { width: W * 0.8, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(7).fillColor(P.charcoal)
      .text(`${COMPANY_NAME}   |   ${r.report_no}`, L, fy + 15, { width: W * 0.78, lineBreak: false, characterSpacing: 0.3 });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(P.goldDark)
      .text(`Page ${i - range.start + 1} of ${range.count}`, L, fy + 10, { width: W, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
}

module.exports = {
  renderDailySiteReportPdf,
  COMPANY_NAME,
  WEATHER_KEYS: Object.keys(WEATHER_LABEL),
  IMPACT_KEYS: Object.keys(IMPACT_LABEL),
  HSE_KEYS: Object.keys(HSE_LABEL),
};
