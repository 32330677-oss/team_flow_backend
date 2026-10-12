// services/transferDocumentService.js
//
// Worker Transfer Request — PDF (A4, one page), company logo and palette
// (pdfBrand). Replaces the old Word document.
//
// Electronic stamp (same principle as before):
//   * Pending  -> "PENDING" seal + "awaiting management decision" panel and a
//                 light PENDING watermark (the copy cannot pass for a decision);
//   * Approved / Rejected -> round company seal with the decision + a decision
//                 panel: reviewer, decision date, effective date, notes and the
//                 HMAC verification code (stampVerificationCode), so a stamp
//                 copied onto another request / edited decision does not match.
// The status is part of the file name, so a copy generated while the request
// was Pending is never served after the decision (isDocumentCurrent).
//
// Arabic text (names, sites, reason, notes) is drawn with Noto Naskh Arabic,
// right-to-left, with runs of Latin words kept in their own order.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { BRAND } = require('./pdfBrand');

const DEFAULT_COMPANY_NAME = 'ASIK ENGINEERING CONSTRUCTION';
const DEFAULT_COMPANY_INFO = 'Damascus International Airport Project';

const OUTPUT_DIR = path.join(__dirname, '..', 'uploads', 'transfer_requests');
const LOGO_PATH = path.join(__dirname, '../assets/logo_report.png');
const LOGO_FALLBACK = path.join(__dirname, '../assets/logo.png');
const ARABIC_FONT_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Regular.ttf');

// Seal radius (points).
const SEAL_R = 60;

// Decision colours (the stamp keeps its meaning: green / red / amber).
const STAMP_STYLE = {
  Approved: { color: '#1B7F3B', tint: '#EAF5EE', title: 'APPROVED', caption: 'TRANSFER APPROVED' },
  Rejected: { color: '#B3261E', tint: '#FCEDEC', title: 'REJECTED', caption: 'TRANSFER REJECTED' },
  Pending: { color: '#9A7A12', tint: '#FBF5E4', title: 'PENDING', caption: 'AWAITING DECISION' },
};

function sanitizeFileNamePart(value) {
  return String(value || 'Worker')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'Worker';
}

function normalizeStatus(status) {
  return ['Approved', 'Rejected'].includes(status) ? status : 'Pending';
}

function buildFileName(workerName, requestId, status) {
  return `Transfer_Request_${sanitizeFileNamePart(workerName)}_${requestId}_${normalizeStatus(status)}.pdf`;
}

// A stored path is current only when it is the PDF of the current status
// (old .docx files and copies of an earlier status are regenerated).
function isDocumentCurrent(documentPath, status) {
  return Boolean(documentPath) && String(documentPath).endsWith(`_${normalizeStatus(status)}.pdf`);
}

/**
 * Electronic-stamp verification code: an HMAC over the decision facts.
 */
function stampVerificationCode({ requestId, status, reviewerId, reviewedAt, effectiveDate }) {
  const secret = process.env.DOC_STAMP_SECRET || process.env.JWT_SECRET || 'team-flow-stamp';
  const payload = [requestId, status, reviewerId || '', reviewedAt || '', effectiveDate || ''].join('|');
  const hex = crypto.createHmac('sha256', secret).update(payload).digest('hex').toUpperCase();
  return `TF-${requestId}-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

// ---------------------------------------------------------------------------
// Mixed Arabic / Latin text
// ---------------------------------------------------------------------------
const AR_CHAR = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const LATIN_LETTER = /[A-Za-z]/;

function createWriter(doc) {
  const hasArabic = fs.existsSync(ARABIC_FONT_PATH);
  if (hasArabic) doc.registerFont('Arabic', ARABIC_FONT_PATH);

  // Helvetica (WinAnsi) cannot draw some symbols.
  const clean = (s) => String(s ?? '').replace(/\s*→\s*/g, ' to ').replace(/[−–—]/g, '-').replace(/\s+/g, ' ').trim();
  const isArWord = (w) => hasArabic && AR_CHAR.test(w);
  const latinFont = (bold) => (bold ? 'Helvetica-Bold' : 'Helvetica');
  const wordWidth = (w, size, bold) => {
    if (isArWord(w)) return doc.font('Arabic').fontSize(size).widthOfString(w, { features: ['rtla'] });
    return doc.font(latinFont(bold)).fontSize(size).widthOfString(w);
  };
  const isRtl = (text) => {
    let ar = 0; let la = 0;
    for (const ch of text) { if (hasArabic && AR_CHAR.test(ch)) ar += 1; else if (LATIN_LETTER.test(ch)) la += 1; }
    return ar > 0 && ar >= la;
  };

  // Wrap in logical order.
  function lines(text, width, size, bold) {
    const words = clean(text).split(' ').filter(Boolean);
    const space = wordWidth(' ', size, bold) || size * 0.28;
    const out = [];
    let cur = [];
    let curW = 0;
    for (const w of words) {
      const ww = wordWidth(w, size, bold);
      if (cur.length && curW + space + ww > width) { out.push(cur); cur = []; curW = 0; }
      cur.push({ w, ww });
      curW += (cur.length > 1 ? space : 0) + ww;
    }
    if (cur.length) out.push(cur);
    return { out, space };
  }

  // Right-to-left visual order: Arabic words reversed, Latin runs kept.
  function visual(tokens) {
    const groups = [];
    for (const t of tokens) {
      const ltr = !isArWord(t.w);
      const last = groups[groups.length - 1];
      if (ltr && last && last.ltr) last.items.push(t);
      else groups.push({ ltr, items: [t] });
    }
    return groups.reverse().flatMap((g) => g.items);
  }

  const lineHeight = (size) => size * 1.45;

  /**
   * Draws (or measures, when o.measure) a paragraph. Returns its height.
   * o: { size, bold, color, align ('left'|'right'|'center'|auto), maxLines }
   */
  function text(str, x, y, width, o = {}) {
    const size = o.size || 9.5;
    const raw = clean(str);
    if (!raw) return 0;
    const rtl = isRtl(raw);
    let { out, space } = lines(raw, width, size, o.bold);
    if (o.maxLines && out.length > o.maxLines) {
      out = out.slice(0, o.maxLines);
      const last = out[out.length - 1];
      last[last.length - 1] = { w: `${last[last.length - 1].w}...`, ww: wordWidth(`${last[last.length - 1].w}...`, size, o.bold) };
    }
    const lh = lineHeight(size);
    if (o.measure) return out.length * lh;
    const align = o.align || (rtl ? 'right' : 'left');
    out.forEach((tokens, i) => {
      const lw = tokens.reduce((a, t) => a + t.ww, 0) + space * (tokens.length - 1);
      let cx = x;
      if (align === 'right') cx = x + width - lw;
      else if (align === 'center') cx = x + (width - lw) / 2;
      const order = rtl ? visual(tokens) : tokens;
      const ly = y + i * lh;
      for (const t of order) {
        if (isArWord(t.w)) {
          doc.font('Arabic').fontSize(size).fillColor(o.color || BRAND.ink)
            .text(t.w, cx, ly - size * 0.24, { lineBreak: false, features: ['rtla'] });
        } else {
          doc.font(latinFont(o.bold)).fontSize(size).fillColor(o.color || BRAND.ink)
            .text(t.w, cx, ly, { lineBreak: false });
        }
        cx += t.ww + space;
      }
    });
    return out.length * lh;
  }

  return { text, measure: (s, w, o = {}) => text(s, 0, 0, w, { ...o, measure: true }), clean };
}

// ---------------------------------------------------------------------------
// Seal: round rubber-stamp look, text on the ring, decision in the centre band.
// ---------------------------------------------------------------------------
// Font size (and letter spacing) so `str` covers at most `maxDeg` of the ring.
function fitArc(doc, str, r, maxDeg, { size, spacing, minSize = 5 }) {
  const maxLen = (r * maxDeg * Math.PI) / 180;
  let s = size;
  let sp = spacing;
  const len = () => {
    doc.font('Helvetica-Bold').fontSize(s);
    return [...str].reduce((a, c) => a + doc.widthOfString(c) + sp, 0) - sp;
  };
  while (len() > maxLen && (s > minSize || sp > 0.2)) {
    if (sp > 0.4) sp -= 0.2; else s -= 0.2;
  }
  return { size: s, spacing: sp };
}

function textOnArc(doc, str, cx, cy, r, { size, top, color, spacing = 1.2 }) {
  doc.font('Helvetica-Bold').fontSize(size);
  const chars = [...str];
  const widths = chars.map((c) => doc.widthOfString(c) + spacing);
  const total = widths.reduce((a, b) => a + b, 0) - spacing;
  let a = -(total / r) / 2; // radians, from the top (or bottom) centre
  chars.forEach((c, i) => {
    const half = widths[i] / 2 / r;
    const ang = a + half;
    const deg = (ang * 180) / Math.PI;
    const px = cx + r * Math.sin(ang);
    const py = top ? cy - r * Math.cos(ang) : cy + r * Math.cos(ang);
    doc.save();
    doc.rotate(top ? deg : -deg, { origin: [px, py] });
    doc.fillColor(color).text(c, px - (widths[i] - spacing) / 2, py - size * (top ? 0.5 : 0.36), { lineBreak: false });
    doc.restore();
    a += widths[i] / r;
  });
}

function drawSeal(doc, cx, cy, { status, companyName, dateText }) {
  const s = STAMP_STYLE[status];
  const R = SEAL_R;
  const ringR = R - 11;        // radius of the ring text
  const innerR = R - 20;       // inner circle
  doc.save();
  doc.rotate(-8, { origin: [cx, cy] });
  doc.opacity(0.93);
  if (status === 'Pending') {
    doc.circle(cx, cy, R).dash(4, { space: 3 }).lineWidth(1.8).strokeColor(s.color).stroke();
    doc.undash();
  } else {
    doc.circle(cx, cy, R).lineWidth(2.6).strokeColor(s.color).stroke();
  }
  doc.circle(cx, cy, R - 4).lineWidth(0.7).strokeColor(s.color).stroke();
  doc.circle(cx, cy, innerR).lineWidth(0.9).strokeColor(s.color).stroke();

  // Ring texts: company name on the top arc (max 150 deg), stamp label on the
  // bottom arc (max 110 deg), so they never meet on the sides.
  const ring = companyName.toUpperCase().slice(0, 34);
  const topFit = fitArc(doc, ring, ringR, 150, { size: 7.2, spacing: 0.9 });
  textOnArc(doc, ring, cx, cy, ringR, { ...topFit, top: true, color: s.color });
  const botFit = fitArc(doc, 'ELECTRONIC STAMP', ringR, 110, { size: 7, spacing: 1.4 });
  textOnArc(doc, 'ELECTRONIC STAMP', cx, cy, ringR, { ...botFit, top: false, color: s.color });
  // small dots on the sides, between the two ring texts
  [-1, 1].forEach((side) => {
    doc.circle(cx + side * ringR, cy + 1, 1.6).fill(s.color);
  });

  // Centre band with the decision word: its ends sit on the inner circle.
  const bandH = 18;
  const bandW = 2 * Math.sqrt(innerR * innerR - (bandH / 2) * (bandH / 2)) - 1;
  doc.rect(cx - bandW / 2, cy - bandH / 2, bandW, bandH).fill(s.color);
  let titleSize = 11.5;
  doc.font('Helvetica-Bold');
  while (titleSize > 8 && doc.fontSize(titleSize).widthOfString(s.title, { characterSpacing: 1.2 }) > bandW - 8) titleSize -= 0.5;
  doc.fontSize(titleSize).fillColor('#FFFFFF')
    .text(s.title, cx - bandW / 2, cy - titleSize * 0.5 + 0.5, { width: bandW, align: 'center', characterSpacing: 1.2, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(6.3).fillColor(s.color)
    .text('TRANSFER', cx - 30, cy - bandH / 2 - 12, { width: 60, align: 'center', characterSpacing: 1.6, lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor(s.color)
    .text(dateText || '', cx - 32, cy + bandH / 2 + 5, { width: 64, align: 'center', lineBreak: false });
  doc.opacity(1);
  doc.restore();
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
/**
 * data: {
 *   requestId, companyName, companyInfo, requestDate, effectiveDate,
 *   worker: { full_name, worker_unique_id, job_position, nationality, phone_number, hire_date },
 *   currentSiteName, targetSiteName, contractName,
 *   requesterName, requesterPosition, transferReason,
 *   review: { status, reviewerId, reviewerName, reviewedAt, adminNotes, effectiveDate }
 * }
 * Returns a Buffer with the PDF.
 */
function renderTransferRequestPdf(data) {
  const {
    requestId, requestDate, effectiveDate,
    worker = {}, currentSiteName, targetSiteName, contractName,
    requesterName, requesterPosition, transferReason,
  } = data;
  const companyName = data.companyName || DEFAULT_COMPANY_NAME;
  const companyInfo = data.companyInfo || DEFAULT_COMPANY_INFO;
  const review = { ...(data.review || {}), status: normalizeStatus(data.review?.status) };
  const status = review.status;
  const decided = status !== 'Pending';
  const st = STAMP_STYLE[status];
  const code = decided ? stampVerificationCode({
    requestId, status, reviewerId: review.reviewerId, reviewedAt: review.reviewedAt, effectiveDate: review.effectiveDate,
  }) : null;

  const doc = new PDFDocument({
    size: 'A4', margins: { top: 36, bottom: 36, left: 42, right: 42 },
    info: { Title: `Worker Transfer Request #${requestId}`, Author: companyName, Subject: `Status: ${status}` },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const w = createWriter(doc);
  const L = doc.page.margins.left;
  const R = doc.page.width - doc.page.margins.right;
  const W = R - L;
  const pageBottom = doc.page.height - doc.page.margins.bottom;

  // Pending watermark (very light): the copy cannot pass for a decision.
  if (!decided) {
    doc.save();
    doc.rotate(-32, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.opacity(0.05).font('Helvetica-Bold').fontSize(92).fillColor(st.color)
      .text('PENDING', 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center', lineBreak: false });
    doc.opacity(1);
    doc.restore();
  }

  // ---- Header: logo | document box ------------------------------------------
  let y = doc.page.margins.top;
  const logo = fs.existsSync(LOGO_PATH) ? LOGO_PATH : (fs.existsSync(LOGO_FALLBACK) ? LOGO_FALLBACK : null);
  if (logo) { try { doc.image(logo, L, y - 2, { fit: [118, 68] }); } catch (_) { /* bad logo: skip */ } }

  const boxW = 196;
  const boxX = R - boxW;
  const meta = [
    ['Request No.', `#${requestId}`, true],
    ['Request date', requestDate || '-'],
    ['Effective date', effectiveDate || '-'],
    ['Status', status.toUpperCase(), true, st.color],
  ];
  const boxH = 12 + meta.length * 15;
  doc.rect(boxX, y, boxW, boxH).fill(BRAND.goldPale);
  doc.rect(boxX, y, 3, boxH).fill(BRAND.gold);
  let my = y + 7;
  meta.forEach(([k, v, strong, color]) => {
    doc.font('Helvetica').fontSize(7.8).fillColor(BRAND.muted).text(k, boxX + 12, my + 1, { width: 80, lineBreak: false });
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 10 : 9).fillColor(color || BRAND.charcoalDark)
      .text(String(v), boxX + 86, my, { width: boxW - 96, align: 'right', lineBreak: false });
    my += 15;
  });

  // Company text between logo and box.
  const midX = L + 130;
  const midW = boxX - midX - 12;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND.goldDark)
    .text('PROJECT', midX, y + 16, { characterSpacing: 1.2, lineBreak: false });
  w.text(companyInfo, midX, y + 29, midW, { size: 9.5, bold: true, color: BRAND.charcoalDark, maxLines: 2, align: 'left' });

  y = Math.max(y + 70, y + boxH) + 8;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1.4).strokeColor(BRAND.gold).stroke();
  doc.moveTo(L, y + 2.5).lineTo(R, y + 2.5).lineWidth(0.4).strokeColor(BRAND.goldMid).stroke();
  y += 16;

  // ---- Title ---------------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(17).fillColor(BRAND.charcoalDark)
    .text('WORKER TRANSFER REQUEST', L, y, { width: W, align: 'center', characterSpacing: 2.2, lineBreak: false });
  y += 23;
  doc.font('Helvetica').fontSize(8.5).fillColor(BRAND.muted)
    .text('Request to move a worker between company work sites', L, y, { width: W, align: 'center', lineBreak: false });
  y += 20;

  const section = (title) => {
    doc.rect(L, y, 3, 11).fill(BRAND.gold);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND.charcoalDark)
      .text(title.toUpperCase(), L + 9, y + 1.5, { characterSpacing: 0.9, lineBreak: false });
    y += 17;
  };

  // ---- Worker details (2 x 3 grid) -----------------------------------------
  section('Worker details');
  const fields = [
    ['Worker name', worker.full_name],
    ['Worker ID', worker.worker_unique_id],
    ['Job position', worker.job_position],
    ['Nationality', worker.nationality],
    ['Phone number', worker.phone_number],
    ['Hire date', worker.hire_date ? String(worker.hire_date).slice(0, 10) : null],
  ];
  const cols = 3;
  const cw = W / cols;
  const rh = 33;
  fields.forEach(([k, v], i) => {
    const cx = L + (i % cols) * cw;
    const cy = y + Math.floor(i / cols) * rh;
    doc.rect(cx, cy, cw, rh).lineWidth(0.6).strokeColor(BRAND.grid).stroke();
    doc.font('Helvetica').fontSize(7.2).fillColor(BRAND.muted).text(k.toUpperCase(), cx + 9, cy + 6, { characterSpacing: 0.4, lineBreak: false });
    const val = v === undefined || v === null || String(v).trim() === '' ? '-' : String(v);
    w.text(val, cx + 9, cy + 17, cw - 18, { size: 9.8, bold: true, color: BRAND.ink, maxLines: 1, align: 'left' });
  });
  y += Math.ceil(fields.length / cols) * rh + 16;

  // ---- Transfer: FROM -> TO --------------------------------------------------
  section('Transfer details');
  const cardH = 50;
  const gap = 34;
  const cardW = (W - gap) / 2;
  const card = (x, label, value, filled) => {
    doc.roundedRect(x, y, cardW, cardH, 4).fill(filled ? BRAND.goldLight : BRAND.grey);
    doc.font('Helvetica-Bold').fontSize(7.2).fillColor(filled ? BRAND.goldDark : BRAND.muted)
      .text(label, x + 12, y + 8, { characterSpacing: 0.8, lineBreak: false });
    w.text(value || '-', x + 12, y + 22, cardW - 24, { size: 11, bold: true, color: BRAND.charcoalDark, maxLines: 1, align: 'left' });
  };
  card(L, 'FROM  •  CURRENT SITE', currentSiteName, false);
  card(L + cardW + gap, 'TO  •  NEW SITE', targetSiteName, true);
  // arrow
  const ax = L + cardW + 7;
  const ay = y + cardH / 2;
  doc.moveTo(ax, ay).lineTo(ax + gap - 16, ay).lineWidth(1.6).strokeColor(BRAND.gold).stroke();
  doc.polygon([ax + gap - 16, ay - 4.5], [ax + gap - 9, ay], [ax + gap - 16, ay + 4.5]).fill(BRAND.gold);
  y += cardH + 8;

  const smallFacts = [
    ['Contract', contractName],
    ['Effective from', effectiveDate],
    ['Requested by', [requesterName, requesterPosition].filter(Boolean).join(' - ')],
  ];
  const fw = W / 3;
  smallFacts.forEach(([k, v], i) => {
    const fx = L + i * fw;
    doc.font('Helvetica').fontSize(7.2).fillColor(BRAND.muted).text(k.toUpperCase(), fx, y, { characterSpacing: 0.4, lineBreak: false });
    w.text(v || '-', fx, y + 11, fw - 10, { size: 9.3, bold: true, color: BRAND.ink, maxLines: 1, align: 'left' });
  });
  y += 34;

  // ---- Request letter ---------------------------------------------------------
  section('Request');
  const para = (t, o = {}) => { y += w.text(t, L, y, W, { size: 9.3, color: BRAND.ink, align: 'left', ...o }) + 5; };
  para('Dear Management,');
  para(`We hereby request the transfer of the above-mentioned worker from his current work site, ${currentSiteName || '[Current Site]'}, `
    + `to ${targetSiteName || '[Target Site]'}, effective from ${effectiveDate || '[Transfer Date]'}. This request is made based on operational `
    + "and work requirements and the need to organize the workforce across the company's sites. The worker will continue to perform his "
    + "duties in accordance with his approved position and the company's applicable policies and instructions.");
  para('We kindly request management to review and approve this transfer request accordingly.');

  if (transferReason && String(transferReason).trim()) {
    const reasonH = w.measure(transferReason, W - 26, { size: 9.3 });
    const boxHt = Math.min(reasonH, 4 * 9.3 * 1.45) + 24;
    doc.rect(L, y + 2, W, boxHt).fill(BRAND.goldPale);
    doc.rect(L, y + 2, 3, boxHt).fill(BRAND.gold);
    doc.font('Helvetica-Bold').fontSize(7.2).fillColor(BRAND.goldDark).text('REASON FOR TRANSFER', L + 13, y + 8, { characterSpacing: 0.6, lineBreak: false });
    w.text(transferReason, L + 13, y + 20, W - 26, { size: 9.3, color: BRAND.ink, maxLines: 4 });
    y += boxHt + 10;
  } else {
    y += 4;
  }

  // ---- Signatures + stamp -----------------------------------------------------
  // Keep the decision block at the bottom of the page.
  const blockH = 214;
  y = Math.max(y, pageBottom - 40 - blockH);
  section('Approval');
  const sigTop = y;

  // Left column: requester signature.
  const colW = (W - 16) / 2;
  const sig = (x, title, rows, note) => {
    doc.roundedRect(x, sigTop, colW, 66, 3).lineWidth(0.6).strokeColor(BRAND.grid).stroke();
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(BRAND.goldDark).text(title, x + 10, sigTop + 8, { characterSpacing: 0.6, lineBreak: false });
    let ry = sigTop + 22;
    rows.forEach(([k, v]) => {
      doc.font('Helvetica').fontSize(7.8).fillColor(BRAND.muted).text(k, x + 10, ry, { width: 52, lineBreak: false });
      w.text(v || '-', x + 62, ry - 1, colW - 72, { size: 8.8, bold: true, color: BRAND.ink, maxLines: 1, align: 'left' });
      ry += 13;
    });
    if (note) {
      doc.font('Helvetica-Oblique').fontSize(7.2).fillColor(BRAND.muted).text(note, x + 10, sigTop + 69, { width: colW - 20, lineBreak: false });
    }
  };
  sig(L, 'REQUESTED BY', [['Name', requesterName], ['Position', requesterPosition], ['Date', requestDate]]);
  // signature line
  doc.moveTo(L + colW - 120, sigTop + 56).lineTo(L + colW - 12, sigTop + 56).lineWidth(0.6).strokeColor(BRAND.charcoal2).stroke();
  doc.font('Helvetica').fontSize(6.8).fillColor(BRAND.muted).text('Signature', L + colW - 120, sigTop + 58, { width: 108, align: 'center', lineBreak: false });

  sig(L + colW + 16, 'MANAGEMENT DECISION', decided
    ? [['Decision', status], ['By', review.reviewerName || 'Management'], ['Date', review.reviewedAt]]
    : [['Decision', 'Pending'], ['By', '-'], ['Date', '-']],
  decided ? 'Electronically stamped - no handwritten signature required.' : null);

  // Decision panel (left) + seal (right).
  const py = sigTop + 94;
  const sealR = SEAL_R;
  const panelW = W - (sealR * 2 + 34);
  const panelH = 96;
  doc.rect(L, py, panelW, panelH).fill(st.tint);
  doc.rect(L, py, 4, panelH).fill(st.color);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(st.color)
    .text(decided ? `ELECTRONIC STAMP  •  ${st.caption}` : 'AWAITING MANAGEMENT DECISION', L + 14, py + 9, { characterSpacing: 0.7, lineBreak: false });
  let ly = py + 24;
  if (decided) {
    const facts = [
      ['Reviewed by', review.reviewerName || 'Management'],
      ['Decision date', review.reviewedAt],
    ];
    if (status === 'Approved' && review.effectiveDate) facts.push(['Effective from', review.effectiveDate]);
    if (review.adminNotes && String(review.adminNotes).trim()) facts.push([status === 'Rejected' ? 'Reason' : 'Notes', String(review.adminNotes).trim()]);
    facts.slice(0, 4).forEach(([k, v]) => {
      doc.font('Helvetica').fontSize(7.8).fillColor(BRAND.muted).text(k, L + 14, ly + 1, { width: 70, lineBreak: false });
      w.text(v || '-', L + 86, ly, panelW - 100, { size: 8.6, bold: true, color: BRAND.ink, maxLines: 1, align: 'left' });
      ly += 12;
    });
  } else {
    w.text('This copy records the request only. The final copy carrying the electronic APPROVED / REJECTED stamp '
      + 'is issued automatically once management decides.', L + 14, ly, panelW - 28, { size: 8.4, color: BRAND.ink, maxLines: 4, align: 'left' });
  }
  if (code) {
    doc.font('Helvetica').fontSize(6.8).fillColor(BRAND.muted).text('VERIFICATION CODE', L + 14, py + panelH - 17, { characterSpacing: 0.5, lineBreak: false });
    doc.font('Courier-Bold').fontSize(9).fillColor(BRAND.charcoalDark).text(code, L + 92, py + panelH - 18.5, { lineBreak: false });
  }

  drawSeal(doc, R - sealR - 4, py + panelH / 2, {
    status, companyName, dateText: decided ? String(review.reviewedAt || '').slice(0, 10) : requestDate,
  });

  // ---- Footer ---------------------------------------------------------------
  const fy = pageBottom - 14;
  doc.moveTo(L, fy - 6).lineTo(R, fy - 6).lineWidth(0.5).strokeColor(BRAND.goldMid).stroke();
  doc.font('Helvetica').fontSize(6.8).fillColor(BRAND.muted)
    .text(`${companyName}  •  Worker Transfer Request #${requestId}  •  Generated by Team Flow`, L, fy, { width: W * 0.6, lineBreak: false });
  doc.text(code ? `Valid only with verification code ${code}` : 'Not valid as a decision until stamped', L + W * 0.4, fy, { width: W * 0.6, align: 'right', lineBreak: false });

  doc.end();
  return done;
}

/**
 * Generates the PDF for the request in its CURRENT status and stores it under
 * uploads/transfer_requests. Returns the relative path.
 */
async function generateTransferRequestPdf(data) {
  const buffer = await renderTransferRequestPdf(data);
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const fileName = buildFileName(data.worker?.full_name, data.requestId, data.review?.status);
  fs.writeFileSync(path.join(OUTPUT_DIR, fileName), buffer);
  // Same relative-path convention as worker photos ('uploads/...').
  return path.join('uploads', 'transfer_requests', fileName).replace(/\\/g, '/');
}

module.exports = { generateTransferRequestPdf, renderTransferRequestPdf, isDocumentCurrent, stampVerificationCode };
