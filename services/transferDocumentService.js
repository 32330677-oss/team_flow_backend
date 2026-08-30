const fs = require('fs');
const path = require('path');
const companyName = 'ASIK ENGINEERING CONSTRUCTION';
const companyInfo = 'Damascus International Airport Project'; 
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} = require('docx');

const OUTPUT_DIR = path.join(__dirname, '..', 'uploads', 'transfer_requests');

function sanitizeFileNamePart(value) {
  return String(value || 'Worker')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'Worker';
}

function buildFileName(workerName, requestId) {
  return `Transfer_Request_${sanitizeFileNamePart(workerName)}_${requestId}.docx`;
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

function signatureBlock(title, prefilledName, prefilledPosition) {
  return [
    new Paragraph({ spacing: { before: 300, after: 150 }, children: [new TextRun({ text: title, bold: true })] }),
    new Paragraph({ text: `Name: ${prefilledName || '______________________________'}` }),
    new Paragraph({ text: `Position: ${prefilledPosition || '___________________________'}` }),
    new Paragraph({ text: 'Signature: __________________________' }),
    new Paragraph({ text: 'Date: ______________________________' }),
  ];
}

/**
 * data: {
 *   requestId, companyName, companyInfo, requestDate,
 *   worker: { full_name, worker_unique_id, job_position, nationality, phone_number, hire_date },
 *   currentSiteName, targetSiteName, contractName,
 *   requesterName, requesterPosition,
 *   transferReason
 * }
 */
async function generateTransferRequestDocx(data) {
  const {
    requestId, companyName, companyInfo, requestDate,
    worker = {}, currentSiteName, targetSiteName, contractName,
    requesterName, requesterPosition, transferReason,
  } = data;

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
  ].filter(Boolean);

  const bodyParagraphs = [
    new Paragraph({ text: 'Subject: Worker Transfer Request', spacing: { before: 300, after: 200 } }),
    new Paragraph({ text: 'Dear Management,', spacing: { after: 200 } }),
    new Paragraph({
      spacing: { after: 200 },
      text: `We hereby submit this request to transfer the above-mentioned worker from his current work site, ${currentSiteName || '[Current Site]'}, to ${targetSiteName || '[Target Site]'}, effective from [Transfer Date].`,
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
        new Paragraph({ 
          text: companyName, // سيظهر هنا: ASIK ENGINEERING CONSTRUCTION
          heading: HeadingLevel.HEADING_2 
        }),
        ...(companyInfo ? [new Paragraph({ text: companyInfo })] : []),
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
        ...signatureBlock('Requested By:', requesterName, requesterPosition),
        ...signatureBlock('Management Approval:'),
      ],
    },
  ],
});

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const fileName = buildFileName(worker.full_name, requestId);
  const absolutePath = path.join(OUTPUT_DIR, fileName);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(absolutePath, buffer);

  // Path stored in DB / served relative to project root, consistent with how
  // worker photo paths are stored (see workerController.js -> 'uploads/...').
  const relativePath = path.join('uploads', 'transfer_requests', fileName).replace(/\\/g, '/');
  return relativePath;
}

module.exports = { generateTransferRequestDocx };