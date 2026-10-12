const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
} = require('docx');

const DEFAULT_COMPANY_NAME = 'ASIK ENGINEERING CONSTRUCTION';
const DEFAULT_COMPANY_INFO = 'Damascus International Airport Project';

const OUTPUT_DIR = path.join(__dirname, '..', 'uploads', 'transfer_requests');

// Stamp look per decision. Pending is a neutral "awaiting" box so the
// supervisor's copy always shows where the request stands.
const STAMP_STYLE = {
  Approved: { color: '1B7F3B', fill: 'E8F5EC', title: 'APPROVED', mark: '' },
  Rejected: { color: 'B3261E', fill: 'FCEBEA', title: 'REJECTED', mark: '' },
  Pending:  { color: '8A6D00', fill: 'FFF8E1', title: 'PENDING MANAGEMENT APPROVAL', mark: '' },
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

// The status is part of the file name, so a document generated while the
// request was Pending is never served after the request is approved/rejected.
function buildFileName(workerName, requestId, status) {
  return `Transfer_Request_${sanitizeFileNamePart(workerName)}_${requestId}_${normalizeStatus(status)}.docx`;
}

function isDocumentCurrent(documentPath, status) {
  return Boolean(documentPath) && String(documentPath).endsWith(`_${normalizeStatus(status)}.docx`);
}

/**
 * Electronic-stamp verification code: an HMAC over the decision facts, so a
 * stamp copied onto another request / edited decision does not match.
 */
function stampVerificationCode({ requestId, status, reviewerId, reviewedAt, effectiveDate }) {
  const secret = process.env.DOC_STAMP_SECRET || process.env.JWT_SECRET || 'team-flow-stamp';
  const payload = [requestId, status, reviewerId || '', reviewedAt || '', effectiveDate || ''].join('|');
  const hex = crypto.createHmac('sha256', secret).update(payload).digest('hex').toUpperCase();
  return `TF-${requestId}-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

function infoRow(label, value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 30, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })],
      }),
      new TableCell({
        width: { size: 70, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ text: String(value) })],
      }),
    ],
  });
}

function signatureBlock(title, prefilledName, prefilledPosition, prefilledDate) {
  return [
    new Paragraph({ spacing: { before: 300, after: 150 }, children: [new TextRun({ text: title, bold: true })] }),
    new Paragraph({ text: `Name: ${prefilledName || '______________________________'}` }),
    new Paragraph({ text: `Position: ${prefilledPosition || '___________________________'}` }),
    new Paragraph({ text: 'Signature: __________________________' }),
    new Paragraph({ text: `Date: ${prefilledDate || '______________________________'}` }),
  ];
}

function stampLine(text, { bold = false, size = 20, color } = {}) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 60 },
    children: [new TextRun({ text, bold, size, color })],
  });
}

/** The electronic stamp: a framed, coloured box with the decision facts. */
function electronicStamp({ requestId, companyName, review }) {
  const status = normalizeStatus(review?.status);
  const s = STAMP_STYLE[status];
  const border = { style: BorderStyle.DOUBLE, size: 18, color: s.color };

  const lines = [
    stampLine(companyName.toUpperCase(), { bold: true, size: 18, color: s.color }),
    stampLine(s.mark ? `${s.mark}  ${s.title}` : s.title, { bold: true, size: 40, color: s.color }),
  ];

  if (status === 'Pending') {
    lines.push(
      stampLine('This request is awaiting the management decision.', { size: 18 }),
      stampLine('The final stamped copy is issued automatically once it is approved or rejected.', { size: 16, color: '555555' }),
    );
  } else {
    lines.push(stampLine('ELECTRONICALLY STAMPED', { bold: true, size: 16, color: s.color }));
    lines.push(stampLine(`Reviewed by: ${review.reviewerName || 'Management'}`, { size: 20 }));
    if (review.reviewedAt) lines.push(stampLine(`Decision date: ${review.reviewedAt}`, { size: 20 }));
    if (status === 'Approved' && review.effectiveDate) {
      lines.push(stampLine(`Transfer effective from: ${review.effectiveDate}`, { bold: true, size: 20 }));
    }
    if (review.adminNotes && String(review.adminNotes).trim()) {
      lines.push(stampLine(`${status === 'Rejected' ? 'Rejection reason' : 'Notes'}: ${String(review.adminNotes).trim()}`, { size: 18 }));
    }
    lines.push(stampLine(
      `Verification code: ${stampVerificationCode({
        requestId,
        status,
        reviewerId: review.reviewerId,
        reviewedAt: review.reviewedAt,
        effectiveDate: review.effectiveDate,
      })}`,
      { size: 16, color: '555555' },
    ));
  }

  return new Table({
    width: { size: 70, type: WidthType.PERCENTAGE },
    alignment: AlignmentType.CENTER,
    rows: [
      new TableRow({
        cantSplit: true, // keep the stamp in one piece on one page
        children: [
          new TableCell({
            borders: { top: border, bottom: border, left: border, right: border },
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: s.fill },
            margins: { top: 160, bottom: 160, left: 200, right: 200 },
            children: lines,
          }),
        ],
      }),
    ],
  });
}

/**
 * data: {
 *   requestId, companyName, companyInfo, requestDate, effectiveDate,
 *   worker: { full_name, worker_unique_id, job_position, nationality, phone_number, hire_date },
 *   currentSiteName, targetSiteName, contractName,
 *   requesterName, requesterPosition,
 *   transferReason,
 *   review: { status, reviewerId, reviewerName, reviewedAt, adminNotes, effectiveDate }
 * }
 * Returns the relative path (uploads/transfer_requests/...) of the generated file.
 */
async function generateTransferRequestDocx(data) {
  const {
    requestId, requestDate, effectiveDate,
    worker = {}, currentSiteName, targetSiteName, contractName,
    requesterName, requesterPosition, transferReason,
  } = data;
  const companyName = data.companyName || DEFAULT_COMPANY_NAME;
  const companyInfo = data.companyInfo || DEFAULT_COMPANY_INFO;
  const review = { ...(data.review || {}), status: normalizeStatus(data.review?.status) };
  const decided = review.status !== 'Pending';

  const infoRows = [
    infoRow('Worker Name', worker.full_name),
    infoRow('Worker ID', worker.worker_unique_id),
    infoRow('Job Position', worker.job_position),
    infoRow('Nationality', worker.nationality),
    infoRow('Phone Number', worker.phone_number),
    infoRow('Hire Date', worker.hire_date ? String(worker.hire_date).slice(0, 10) : null),
    infoRow('Contract', contractName),
    infoRow('Current Site', currentSiteName),
    infoRow('Target Site', targetSiteName),
    infoRow('Requested Effective Date', effectiveDate),
    infoRow('Request Status', review.status),
  ].filter(Boolean);

  const bodyParagraphs = [
    new Paragraph({ text: 'Subject: Worker Transfer Request', spacing: { before: 300, after: 200 } }),
    new Paragraph({ text: 'Dear Management,', spacing: { after: 200 } }),
    new Paragraph({
      spacing: { after: 200 },
      text: `We hereby submit this request to transfer the above-mentioned worker from his current work site, ${currentSiteName || '[Current Site]'}, to ${targetSiteName || '[Target Site]'}, effective from ${effectiveDate || '[Transfer Date]'}.`,
    }),
    new Paragraph({
      spacing: { after: 200 },
      text: "This request is made based on operational and work requirements and the need to organize the workforce across the company's sites. The worker will continue to perform his duties and responsibilities in accordance with his approved position and the company's applicable policies and instructions.",
    }),
    new Paragraph({
      spacing: { after: 200 },
      text: 'We kindly request management to review and approve this transfer request accordingly.',
    }),
    new Paragraph({ text: 'Thank you for your consideration.', spacing: { after: 200 } }),
    new Paragraph({ text: 'Sincerely,', spacing: { after: 300 } }),
  ];

  if (transferReason && String(transferReason).trim()) {
    bodyParagraphs.push(
      new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: 'Transfer Reason:', bold: true })] }),
      new Paragraph({ text: String(transferReason).trim(), spacing: { after: 200 } }),
    );
  }

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: companyName, heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: companyInfo }),
          new Paragraph({ text: `Date: ${requestDate}`, spacing: { after: 300 } }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 300 },
            children: [new TextRun({ text: 'WORKER TRANSFER REQUEST', bold: true })],
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: infoRows,
          }),
          ...bodyParagraphs,
          new Paragraph({ text: `Request ID: #${requestId}`, spacing: { before: 200, after: 400 } }),
          ...signatureBlock('Requested By:', requesterName, requesterPosition, requestDate),
          ...signatureBlock(
            'Management Decision:',
            decided ? review.reviewerName : null,
            decided ? 'Admin' : null,
            decided ? review.reviewedAt : null,
          ),
          new Paragraph({ text: '', spacing: { before: 120 } }),
          electronicStamp({ requestId, companyName, review }),
        ],
      },
    ],
  });

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const fileName = buildFileName(worker.full_name, requestId, review.status);
  const absolutePath = path.join(OUTPUT_DIR, fileName);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(absolutePath, buffer);

  // Path stored in DB / served relative to project root, consistent with how
  // worker photo paths are stored (see workerController.js -> 'uploads/...').
  return path.join('uploads', 'transfer_requests', fileName).replace(/\\/g, '/');
}

module.exports = { generateTransferRequestDocx, isDocumentCurrent, stampVerificationCode };
