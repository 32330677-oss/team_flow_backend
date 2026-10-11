// services/staffAdvancePdf.js
//
// PDFs for staff salary advances (English only, company palette from pdfBrand):
//   * renderVoucherPdf         payment voucher  ADV-YYYY-NNNNNN
//   * renderRepaymentReceiptPdf cash repayment receipt RCP-YYYY-NNNNNN
//   * renderFinancialReportPdf the financial report opened before an advance
// Presentation only: every number comes from staffAdvanceService.

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { BRAND } = require('./pdfBrand');

const COMPANY_NAME = 'ASIK ENGINEERING CONSTRUCTION';
const LOGO_PATH = path.join(__dirname, '../assets/logo_report.png');
const FALLBACK_LOGO = path.join(__dirname, '../assets/logo.png');

const num = (v) => Number(v || 0);
const amount = (v) => num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Amount in words (English): 1250.5 USD -> "One thousand two hundred fifty US Dollars and fifty cents only"
// ---------------------------------------------------------------------------
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];

function intToWords(n) {
  n = Math.floor(Math.abs(n));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${intToWords(n % 100)}` : ''}`;
  for (const [value, word] of SCALES) {
    if (n >= value) {
      const head = Math.floor(n / value);
      const rest = n % value;
      return `${intToWords(head)} ${word}${rest ? ` ${intToWords(rest)}` : ''}`;
    }
  }
  return String(n);
}

const CURRENCY_WORDS = {
  USD: ['US Dollar', 'US Dollars', 'cent', 'cents'],
  SYP: ['Syrian Pound', 'Syrian Pounds', 'piastre', 'piastres'],
  EUR: ['Euro', 'Euros', 'cent', 'cents'],
};

function amountInWords(value, currency) {
  const total = Math.round(num(value) * 100);
  const whole = Math.floor(total / 100);
  const fraction = total % 100;
  const [one, many, subOne, subMany] = CURRENCY_WORDS[currency] || [currency, currency, 'cent', 'cents'];
  let text = `${intToWords(whole)} ${whole === 1 ? one : many}`;
  if (fraction) text += ` and ${intToWords(fraction)} ${fraction === 1 ? subOne : subMany}`;
  text = `${text} only`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Shared drawing helpers
// ---------------------------------------------------------------------------
function newDoc(res, fileName) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: fileName, Author: COMPANY_NAME } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  doc.pipe(res);
  return doc;
}

function drawHeader(doc, title, rightLines) {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const top = doc.page.margins.top;
  const logo = fs.existsSync(LOGO_PATH) ? LOGO_PATH : (fs.existsSync(FALLBACK_LOGO) ? FALLBACK_LOGO : null);
  if (logo) doc.image(logo, L, top, { fit: [90, 52] });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND.muted).text(COMPANY_NAME, L + 100, top + 4, { width: 220 });
  doc.font('Helvetica-Bold').fontSize(15).fillColor(BRAND.charcoalDark).text(title, L + 100, top + 18, { width: 240 });
  // Right box: document number + dates
  const bw = 190;
  const bx = L + W - bw;
  const bh = 14 + rightLines.length * 14;
  doc.rect(bx, top, bw, bh).fill(BRAND.goldLight);
  doc.rect(bx, top, 3, bh).fill(BRAND.gold);
  let y = top + 7;
  rightLines.forEach(([label, value, strong]) => {
    doc.font('Helvetica').fontSize(8).fillColor(BRAND.muted).text(label, bx + 10, y, { width: 70 });
    doc.font(strong ? 'Helvetica-Bold' : 'Helvetica').fontSize(strong ? 10 : 8.5).fillColor(BRAND.charcoalDark)
      .text(String(value ?? '-'), bx + 78, y - (strong ? 1 : 0), { width: bw - 86, align: 'right' });
    y += 14;
  });
  const end = Math.max(top + 60, top + bh) + 10;
  doc.moveTo(L, end).lineTo(L + W, end).lineWidth(1.2).strokeColor(BRAND.gold).stroke();
  doc.lineWidth(1);
  return end + 12;
}

function sectionTitle(doc, y, text) {
  const L = doc.page.margins.left;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND.goldDark).text(text.toUpperCase(), L, y, { characterSpacing: 0.6 });
  return doc.y + 4;
}

// Two-column key/value grid.
function kvGrid(doc, y, pairs, cols = 2) {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const colW = W / cols;
  const rowH = 30;
  pairs.forEach(([k, v], i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = L + c * colW;
    const yy = y + r * rowH;
    doc.rect(x, yy, colW, rowH).strokeColor(BRAND.grid).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(BRAND.muted).text(k, x + 8, yy + 5, { width: colW - 16 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.ink).text(String(v ?? '-'), x + 8, yy + 15, { width: colW - 16, lineBreak: false, ellipsis: true });
  });
  return y + Math.ceil(pairs.length / cols) * rowH + 12;
}

// Simple table. cols: [{ h, w (fraction), align }]
function table(doc, y, cols, rows, { totalRow = null, fontSize = 8.5 } = {}) {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const widths = cols.map((c) => c.w * W);
  const rowH = 18;
  const bottom = doc.page.height - doc.page.margins.bottom - 20;
  const drawRow = (yy, cells, { head = false, bold = false, fill = null } = {}) => {
    if (fill) doc.rect(L, yy, W, rowH).fill(fill);
    let x = L;
    cells.forEach((cell, i) => {
      doc.rect(x, yy, widths[i], rowH).strokeColor(BRAND.grid).stroke();
      doc.font(head || bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(head ? 7.5 : fontSize)
        .fillColor(head ? BRAND.white : BRAND.ink)
        .text(String(cell ?? ''), x + 5, yy + 5, { width: widths[i] - 10, align: cols[i].align || 'left', lineBreak: false, ellipsis: true });
      x += widths[i];
    });
    return yy + rowH;
  };
  y = drawRow(y, cols.map((c) => c.h), { head: true, fill: BRAND.charcoal });
  rows.forEach((r, i) => {
    if (y > bottom) { doc.addPage(); y = doc.page.margins.top; y = drawRow(y, cols.map((c) => c.h), { head: true, fill: BRAND.charcoal }); }
    y = drawRow(y, r, { fill: i % 2 ? BRAND.zebra : null });
  });
  if (totalRow) y = drawRow(y, totalRow, { bold: true, fill: BRAND.goldMid });
  return y + 12;
}

function watermark(doc, text) {
  doc.save();
  doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc.font('Helvetica-Bold').fontSize(90).fillColor(BRAND.charcoal).opacity(0.08)
    .text(text, 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
  doc.restore();
  doc.opacity(1);
}

function signatureBlock(doc, y, boxes) {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const h = 78;
  if (y + h > doc.page.height - doc.page.margins.bottom - 20) { doc.addPage(); y = doc.page.margins.top; }
  const bw = W / boxes.length;
  boxes.forEach((b, i) => {
    const x = L + i * bw;
    doc.rect(x + 4, y, bw - 8, h).strokeColor(BRAND.grid).stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND.charcoalDark).text(b.title, x + 10, y + 7, { width: bw - 20 });
    doc.font('Helvetica').fontSize(7.5).fillColor(BRAND.muted).text(`Name: ${b.name || '______________'}`, x + 10, y + 22, { width: bw - 20 });
    doc.text('Signature:', x + 10, y + 40, { width: bw - 20 });
    doc.moveTo(x + 10, y + 62).lineTo(x + bw - 14, y + 62).strokeColor(BRAND.grid).stroke();
    doc.text('Date: ____/____/________', x + 10, y + 66, { width: bw - 20 });
  });
  return y + h + 10;
}

function footer(doc, text) {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const y = doc.page.height - doc.page.margins.bottom - 10;
  doc.font('Helvetica').fontSize(7).fillColor(BRAND.muted).text(text, L, y, { width: W, align: 'center', lineBreak: false });
}

const STATUS_LABEL = { Active: 'ACTIVE', Settled: 'SETTLED', Cancelled: 'CANCELLED', WrittenOff: 'WRITTEN OFF' };

// ---------------------------------------------------------------------------
// Payment voucher
// ---------------------------------------------------------------------------
function renderVoucherPdf(res, { advance, staff, report, printNumber, printedBy }) {
  const doc = newDoc(res, `${advance.voucher_no}.pdf`);
  const cur = advance.currency;
  let y = drawHeader(doc, 'SALARY ADVANCE PAYMENT VOUCHER', [
    ['Voucher No.', advance.voucher_no, true],
    ['Date', String(advance.created_at).slice(0, 16)],
    ['Status', STATUS_LABEL[advance.status] || advance.status],
    ['Print', printNumber > 1 ? `COPY ${printNumber - 1}` : 'ORIGINAL'],
  ]);
  if (advance.status === 'Cancelled') watermark(doc, 'CANCELLED');
  else if (printNumber > 1) watermark(doc, 'COPY');

  y = sectionTitle(doc, y, 'Paid to');
  y = kvGrid(doc, y, [
    ['Staff name', staff.full_name],
    ['Staff ID', staff.staff_unique_id],
    ['Position', staff.position || '-'],
    ['Site', staff.site_name || '-'],
    ['Hire date', staff.hire_date || '-'],
    [`Monthly salary (${cur})`, amount(staff.monthly_salary)],
  ]);

  y = sectionTitle(doc, y, 'Amount');
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  doc.rect(L, y, W, 46).fill(BRAND.goldPale);
  doc.rect(L, y, 3, 46).fill(BRAND.gold);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(BRAND.charcoalDark).text(`${amount(advance.amount)} ${cur}`, L + 12, y + 7, { width: 220 });
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(BRAND.ink).text(amountInWords(advance.amount, cur), L + 12, y + 29, { width: W - 24 });
  y += 58;
  y = kvGrid(doc, y, [
    ['Payment method', advance.payment_method === 'BankTransfer' ? 'Bank transfer' : advance.payment_method],
    ['Payment reference', advance.payment_reference || '-'],
    ['Deduction', advance.deduction_mode === 'Full' ? 'Full (one month)' : `Partial (${advance.installments.filter((i) => i.status !== 'Replaced').length} months)`],
    ['Cancel window ends', advance.cancel_deadline],
  ]);
  doc.font('Helvetica').fontSize(7.5).fillColor(BRAND.muted).text('Reason', L, y);
  doc.font('Helvetica').fontSize(9).fillColor(BRAND.ink).text(advance.reason, L, doc.y + 2, { width: W });
  y = doc.y + 12;

  y = sectionTitle(doc, y, 'Salary deduction schedule');
  const shown = advance.installments.filter((i) => !['Replaced'].includes(i.status));
  y = table(doc, y, [
    { h: '#', w: 0.07, align: 'center' }, { h: 'Payroll month', w: 0.33 }, { h: `Amount (${cur})`, w: 0.25, align: 'right' },
    { h: 'Status', w: 0.35 },
  ], shown.map((i, idx) => [idx + 1, i.month_label || 'To be scheduled', amount(i.amount),
    i.status === 'Included' ? `In staff batch #${i.included_batch_id}` : i.status === 'Deducted' ? `Deducted (batch #${i.included_batch_id})` : i.status]),
  { totalRow: ['', 'TOTAL', amount(shown.reduce((s, i) => s + num(i.amount), 0)), `Balance: ${amount(advance.outstanding_balance)}`] });

  if (y > doc.page.height - 260) { doc.addPage(); y = doc.page.margins.top; }
  y = sectionTitle(doc, y, 'Employee acknowledgement');
  doc.font('Helvetica').fontSize(8.5).fillColor(BRAND.ink).text(
    `I, ${staff.full_name} (${staff.staff_unique_id}), acknowledge that I received ${amount(advance.amount)} ${cur} ` +
    `(${amountInWords(advance.amount, cur)}) from ${COMPANY_NAME} as an advance on my salary. I authorize the company to deduct ` +
    'this amount from my salary according to the schedule above. If my employment ends before the advance is fully recovered, ' +
    'I authorize the company to deduct the outstanding balance from my final dues.',
    L, y, { width: W, align: 'justify', lineGap: 1.5 });
  y = doc.y + 14;

  signatureBlock(doc, y, [
    { title: 'Prepared by', name: advance.created_by },
    { title: 'Approved by', name: '' },
    { title: 'Cashier', name: '' },
    { title: 'Received by (employee)', name: staff.full_name },
  ]);
  footer(doc, `${advance.voucher_no}  |  Financial report #${report ? report.report_id : advance.financial_report_id}  |  ` +
    `Printed ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by ${printedBy || '-'}  |  Print #${printNumber}`);
  doc.end();
}

// ---------------------------------------------------------------------------
// Cash repayment receipt
// ---------------------------------------------------------------------------
function renderRepaymentReceiptPdf(res, { advance, staff, entry }) {
  const doc = newDoc(res, `${entry.receipt_no}.pdf`);
  const cur = advance.currency;
  let y = drawHeader(doc, 'ADVANCE REPAYMENT RECEIPT', [
    ['Receipt No.', entry.receipt_no, true],
    ['Date', entry.created_at],
    ['Advance', advance.voucher_no],
  ]);
  if (advance.status === 'Cancelled') watermark(doc, 'CANCELLED');
  y = sectionTitle(doc, y, 'Received from');
  y = kvGrid(doc, y, [
    ['Staff name', staff.full_name], ['Staff ID', staff.staff_unique_id],
    ['Advance voucher', advance.voucher_no], [`Advance amount (${cur})`, amount(advance.amount)],
  ]);
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  y = sectionTitle(doc, y, 'Amount received');
  doc.rect(L, y, W, 46).fill(BRAND.goldPale);
  doc.rect(L, y, 3, 46).fill(BRAND.gold);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(BRAND.charcoalDark).text(`${amount(-entry.amount)} ${cur}`, L + 12, y + 7);
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(BRAND.ink).text(amountInWords(-entry.amount, cur), L + 12, y + 29, { width: W - 24 });
  y += 58;
  y = kvGrid(doc, y, [
    ['Payment method', entry.payment_method === 'BankTransfer' ? 'Bank transfer' : (entry.payment_method || 'Cash')],
    [`Balance after this receipt (${cur})`, amount(entry.balance_after)],
  ]);
  doc.font('Helvetica').fontSize(7.5).fillColor(BRAND.muted).text('Note', L, y);
  doc.font('Helvetica').fontSize(9).fillColor(BRAND.ink).text(entry.note || '-', L, doc.y + 2, { width: W });
  y = doc.y + 18;
  signatureBlock(doc, y, [
    { title: 'Received by (cashier)', name: entry.created_by },
    { title: 'Paid by (employee)', name: staff.full_name },
  ]);
  footer(doc, `${entry.receipt_no}  |  ${advance.voucher_no}`);
  doc.end();
}

// ---------------------------------------------------------------------------
// Financial report
// ---------------------------------------------------------------------------
function renderFinancialReportPdf(res, report) {
  const doc = newDoc(res, `financial_report_${report.staff.staff_unique_id}_${report.report_id}.pdf`);
  const cur = report.currency;
  const s = report.staff;
  let y = drawHeader(doc, 'STAFF FINANCIAL REPORT', [
    ['Report No.', `#${report.report_id}`, true],
    ['Generated', String(report.generated_at).slice(0, 16)],
    ['By', report.generated_by || '-'],
  ]);
  y = sectionTitle(doc, y, 'Staff member');
  y = kvGrid(doc, y, [
    ['Name', s.full_name], ['Staff ID', s.staff_unique_id], ['Position', s.position || '-'], ['Site', s.site_name || '-'],
    ['Status', s.status], ['Hire date', s.hire_date || '-'], [`Monthly salary (${cur})`, amount(s.monthly_salary)],
    ['Standard daily hours', s.standard_daily_hours],
  ]);

  const m = report.current_month;
  y = sectionTitle(doc, y, `Expected salary: ${m.label} (to ${m.to})`);
  if (m.available) {
    y = kvGrid(doc, y, [
      [`Prorated base (${cur})`, amount(m.prorated_base_salary)], [`Deduction (${cur})`, amount(m.salary_deduction)],
      [`Expected net to date (${cur})`, amount(m.net_salary)], ['Present days', m.present_days],
      ['Paid leave days', m.paid_leave_days], ['Unpaid absence days', m.unpaid_absence_days],
      ['Shortage hours', m.shortage_hours], ['Draft / Submitted / Rejected',
        `${report.attendance_pending.draft} / ${report.attendance_pending.submitted} / ${report.attendance_pending.rejected}`],
    ], 4);
  } else {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(BRAND.muted).text(m.note || 'Not available.', doc.page.margins.left, y);
    y = doc.y + 12;
  }

  y = sectionTitle(doc, y, 'Payroll history (last 6)');
  y = report.payroll_history.length
    ? table(doc, y, [
      { h: 'Batch', w: 0.09 }, { h: 'Period', w: 0.25 }, { h: 'Status', w: 0.14 },
      { h: 'Base', w: 0.12, align: 'right' }, { h: 'Deduction', w: 0.12, align: 'right' },
      { h: 'Advance', w: 0.12, align: 'right' }, { h: 'Net', w: 0.16, align: 'right' },
    ], report.payroll_history.map((p) => [`#${p.batch_id}`, `${p.start_date} to ${p.end_date}`,
      p.status === 'Paid' ? 'Paid' : (p.is_finalized ? 'Finalized' : 'Generated'),
      amount(p.prorated_base_salary), amount(p.salary_deduction_amount), amount(p.advance_deduction_amount), amount(p.net_salary)]))
    : (doc.font('Helvetica-Oblique').fontSize(9).fillColor(BRAND.muted).text('No payroll yet.', doc.page.margins.left, y), doc.y + 12);

  y = sectionTitle(doc, y, `Open advances: balance ${amount(report.open_advances.balance)} ${cur}`);
  y = report.advance_history.length
    ? table(doc, y, [
      { h: 'Voucher', w: 0.2 }, { h: 'Date', w: 0.18 }, { h: 'Amount', w: 0.16, align: 'right' },
      { h: 'Balance', w: 0.16, align: 'right' }, { h: 'Status', w: 0.3 },
    ], report.advance_history.map((a) => [a.voucher_no, a.created_at, amount(a.amount), amount(a.outstanding_balance), a.status]))
    : (doc.font('Helvetica-Oblique').fontSize(9).fillColor(BRAND.muted).text('No advances.', doc.page.margins.left, y), doc.y + 12);

  if (report.pending_adjustments.items.length) {
    y = sectionTitle(doc, y, `Pending payroll adjustments: ${amount(report.pending_adjustments.total)} ${cur}`);
    y = table(doc, y, [{ h: '#', w: 0.1 }, { h: 'Status', w: 0.2 }, { h: 'Amount', w: 0.15, align: 'right' }, { h: 'Reason', w: 0.55 }],
      report.pending_adjustments.items.map((a) => [a.adjustment_id, a.status, amount(a.amount), a.reason]));
  }
  if (report.blockers && report.blockers.length) {
    y = sectionTitle(doc, y, 'Advance not possible');
    report.blockers.forEach((b) => { doc.font('Helvetica').fontSize(9).fillColor(BRAND.ink).text(`- ${b}`, doc.page.margins.left, y); y = doc.y + 3; });
  }
  footer(doc, `Financial report #${report.report_id}  |  ${s.full_name} (${s.staff_unique_id})  |  ${report.generated_at}`);
  doc.end();
}

module.exports = { renderVoucherPdf, renderRepaymentReceiptPdf, renderFinancialReportPdf, amountInWords };
