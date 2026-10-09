// controllers/staffApprovedRecordsController.js
//
// GET /api/staff-attendance/admin/records?start_date&end_date[&staff_id][&status]
// Admin view of staff attendance records after review (Approved by default),
// so they can still be marked paid / corrected. Each row says which payroll
// batch covers its date (Paid / Finalized / Generated) so the app can tell
// the Admin what a change will do. Read-only.
const db = require('../config/db');

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

exports.listRecords = async (req, res) => {
  try {
    const { start_date: start, end_date: end } = req.query;
    if (!isDate(start) || !isDate(end) || end < start) {
      return res.status(400).json({ status: 'error', message: 'Valid start_date and end_date (YYYY-MM-DD) are required.' });
    }
    const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
    if (days > 62) return res.status(400).json({ status: 'error', message: 'Choose a range of at most 62 days.' });
    const statuses = ['Approved', 'Submitted', 'Rejected', 'Draft'];
    const status = statuses.includes(req.query.status) ? req.query.status : 'Approved';
    const params = [start, end, status];
    let staffFilter = '';
    if (Number.isInteger(Number(req.query.staff_id)) && Number(req.query.staff_id) > 0) {
      staffFilter = ' AND sa.staff_id = ?';
      params.push(Number(req.query.staff_id));
    }
    const [rows] = await db.execute(
      `SELECT sa.staff_attendance_id, sa.staff_id, sm.full_name, sm.staff_unique_id, sm.position,
              DATE_FORMAT(sa.record_date, '%Y-%m-%d') AS record_date, sa.attendance_status, sa.status,
              DATE_FORMAT(sa.check_in_time, '%Y-%m-%d %H:%i') AS check_in_time,
              DATE_FORMAT(sa.check_out_time, '%Y-%m-%d %H:%i') AS check_out_time,
              DATE_FORMAT(sa.lunch_start_time, '%Y-%m-%d %H:%i') AS lunch_start_time,
              DATE_FORMAT(sa.lunch_end_time, '%Y-%m-%d %H:%i') AS lunch_end_time,
              sa.regular_hours, sa.overtime_hours, sa.is_paid, sa.is_management_paid_absence, sa.remarks,
              sa.standard_minutes_snapshot
       FROM staff_attendance sa
       JOIN staff_members sm ON sm.staff_id = sa.staff_id
       WHERE sa.record_date BETWEEN ? AND ? AND sa.status = ?${staffFilter}
       ORDER BY sa.record_date DESC, sm.full_name
       LIMIT 2000`, params);
    const [batches] = await db.execute(
      `SELECT staff_payroll_batch_id AS batch_id, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, status, is_finalized
       FROM staff_payroll_batches
       WHERE status IN ('Generated','Paid') AND start_date <= ? AND end_date >= ?
       ORDER BY staff_payroll_batch_id DESC`, [end, start]);
    for (const r of rows) {
      const b = batches.find((x) => x.start_date <= r.record_date && x.end_date >= r.record_date);
      r.payroll = b
        ? { batch_id: b.batch_id, state: b.status === 'Paid' ? 'Paid' : (Number(b.is_finalized) ? 'Finalized' : 'Generated') }
        : { batch_id: null, state: 'None' };
    }
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('listRecords:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load staff attendance records.' });
  }
};
