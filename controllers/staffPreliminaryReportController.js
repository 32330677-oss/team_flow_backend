// controllers/staffPreliminaryReportController.js
// PRELIMINARY (unofficial) staff attendance & expected payroll PDF.
// Read-only: nothing is written to the database.
const { buildStaffPreliminaryReport } = require('../services/staffPayrollPreviewService');
const { renderPreliminaryReportPdf } = require('../services/preliminaryReportPdfLayout');

// GET /api/staff-payroll/preliminary-report.pdf?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
exports.exportStaffPreliminaryReportPdf = async (req, res) => {
  try {
    const { start_date, end_date } = req.query || {};
    const report = await buildStaffPreliminaryReport(start_date, end_date);
    if (!report.rows.length) {
      return res.status(400).json({ status: 'error', message: 'No staff attendance found for the selected period.' });
    }
    const buffer = await renderPreliminaryReportPdf(report);
    const fileName = `PRELIMINARY_staff_payroll_${report.startDate}_to_${report.endDate}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.end(buffer);
  } catch (error) {
    if (error.statusCode === 400) return res.status(400).json({ status: 'error', message: error.message });
    console.error('exportStaffPreliminaryReportPdf:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to generate the preliminary staff report.' });
  }
};
