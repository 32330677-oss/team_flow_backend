// controllers/staffLifecycleController.js
//
// Handles staff status transitions (Active / Inactive / Terminated) with a
// mandatory reason and audit trail in staff_status_history. This is a new
// file, separate from staffController.js's simple toggleStaffStatus, because
// lifecycle changes now require an effective date + reason and must never
// silently overwrite history.
//
// Wire into routes/staffRoutes.js:
//   const staffLifecycleController = require('../controllers/staffLifecycleController');
//   router.patch('/:id/lifecycle', restrictTo('Admin'), staffLifecycleController.changeStatus);
//   router.get('/:id/lifecycle-history', restrictTo('Admin'), staffLifecycleController.getStatusHistory);

const db = require('../config/db');

const VALID_STATUSES = ['Active', 'Inactive', 'Terminated'];

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// PATCH /api/staff/:id/lifecycle
// body: { new_status, effective_date, reason }
exports.changeStatus = async (req, res) => {
  const staffId = Number(req.params.id);
  const { new_status, effective_date, reason } = req.body || {};
  const adminId = req.user.user_id;

  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  if (!VALID_STATUSES.includes(new_status)) {
    return res.status(400).json({ status: 'error', message: `new_status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  if (!isValidDateOnly(effective_date)) {
    return res.status(400).json({ status: 'error', message: 'A valid effective_date (YYYY-MM-DD) is required.' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ status: 'error', message: 'A reason is required for any status change.' });
  }
  if (new_status === 'Terminated' && effective_date > new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ status: 'error', message: 'Termination effective date cannot be in the future.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT staff_id, status FROM staff_members WHERE staff_id = ? FOR UPDATE',
      [staffId]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Staff member not found.' });
    }
    const current = rows[0];

    if (current.status === new_status) {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: `Staff member is already ${new_status}.` });
    }
    if (current.status === 'Terminated') {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'A terminated staff member cannot change status. Create a new record instead.' });
    }

    await connection.execute(
      `UPDATE staff_members
       SET status = ?, termination_date = ?
       WHERE staff_id = ?`,
      [new_status, new_status === 'Terminated' ? effective_date : null, staffId]
    );

    await connection.execute(
      `INSERT INTO staff_status_history
         (staff_id, old_status, new_status, effective_date, reason, changed_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [staffId, current.status, new_status, effective_date, reason.trim(), adminId]
    );

    // Terminating staff automatically closes any open site assignment.
    if (new_status === 'Terminated') {
      await connection.execute(
        `UPDATE staff_site_assignments
         SET unassigned_date = ?
         WHERE staff_id = ? AND unassigned_date IS NULL`,
        [effective_date, staffId]
      );
    }

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_members', ?, 'STATUS_CHANGED', ?, ?, ?)`,
      [staffId, adminId, JSON.stringify({ status: current.status }), JSON.stringify({ status: new_status, effective_date, reason })]
    );

    await connection.commit();
    return res.status(200).json({ status: 'success', message: `Staff status updated to ${new_status}.` });
  } catch (error) {
    await connection.rollback();
    console.error('CHANGE STAFF LIFECYCLE STATUS ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'An error occurred while updating staff status.' });
  } finally {
    connection.release();
  }
};

// GET /api/staff/:id/lifecycle-history
exports.getStatusHistory = async (req, res) => {
  const staffId = Number(req.params.id);
  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  try {
    const [rows] = await db.execute(
      `SELECT ssh.*, u.full_name AS changed_by_name
       FROM staff_status_history ssh
       LEFT JOIN users u ON u.user_id = ssh.changed_by_user_id
       WHERE ssh.staff_id = ?
       ORDER BY ssh.effective_date DESC, ssh.status_history_id DESC`,
      [staffId]
    );
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET STAFF LIFECYCLE HISTORY ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load status history.' });
  }
};