// controllers/staffSupervisorAssignmentController.js
//
// Tracks which StaffSupervisor a staff member is currently assigned to.
// Mirrors staffAssignmentController.js's pattern (worker->site assignments)
// but for staff->supervisor assignments. Kept as a separate file/table per
// the "don't merge staff and worker logic" precedent already in this codebase.

const db = require('../config/db');

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// GET /api/staff/:id/supervisor-assignments
exports.getHistory = async (req, res) => {
  const staffId = Number(req.params.id);
  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  try {
    const [rows] = await db.execute(
      `SELECT ssa.*, u.full_name AS supervisor_name, ab.full_name AS assigned_by_name
       FROM staff_supervisor_assignments ssa
       JOIN users u ON u.user_id = ssa.supervisor_user_id
       LEFT JOIN users ab ON ab.user_id = ssa.assigned_by_user_id
       WHERE ssa.staff_id = ?
       ORDER BY ssa.assigned_date DESC, ssa.staff_assignment_id DESC`,
      [staffId]
    );
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET STAFF SUPERVISOR ASSIGNMENT HISTORY ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load assignment history.' });
  }
};

// POST /api/staff/:id/supervisor-assignments
// body: { supervisor_user_id, assigned_date, notes }
exports.assignSupervisor = async (req, res) => {
  const staffId = Number(req.params.id);
  const { supervisor_user_id, assigned_date, notes } = req.body || {};
  const adminId = req.user.user_id;

  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  const supervisorId = Number(supervisor_user_id);
  if (!Number.isInteger(supervisorId) || supervisorId <= 0) {
    return res.status(400).json({ status: 'error', message: 'supervisor_user_id is required.' });
  }
  const effectiveDate = isValidDateOnly(assigned_date) ? assigned_date : new Date().toISOString().slice(0, 10);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [staffRows] = await connection.execute(
      'SELECT staff_id, status FROM staff_members WHERE staff_id = ? FOR UPDATE',
      [staffId]
    );
    if (staffRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Staff member not found.' });
    }
    if (staffRows[0].status === 'Terminated') {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'Cannot assign a supervisor to a terminated staff member.' });
    }

    const [supRows] = await connection.execute(
      `SELECT user_id, role, status FROM users WHERE user_id = ? LIMIT 1`,
      [supervisorId]
    );
    if (supRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'The specified supervisor account does not exist.' });
    }
    if (supRows[0].role !== 'StaffSupervisor') {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'The specified user is not a Staff Supervisor.' });
    }
    if (supRows[0].status !== 'Active') {
      await connection.rollback();
      return res.status(400).json({ status: 'error', message: 'The specified supervisor account is inactive.' });
    }

    // Close any open assignment (explicit reassignment event, mirrors
    // staffAssignmentController.assignToSite's close-then-reopen behavior).
    await connection.execute(
      `UPDATE staff_supervisor_assignments
       SET unassigned_date = ?
       WHERE staff_id = ? AND unassigned_date IS NULL`,
      [effectiveDate, staffId]
    );

    await connection.execute(
      `INSERT INTO staff_supervisor_assignments
         (staff_id, supervisor_user_id, assigned_by_user_id, assigned_date, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [staffId, supervisorId, adminId, effectiveDate, notes || null]
    );

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_members', ?, 'SUPERVISOR_ASSIGNED', ?, NULL, ?)`,
      [staffId, adminId, JSON.stringify({ supervisor_user_id: supervisorId, assigned_date: effectiveDate, notes })]
    );

    await connection.commit();
    return res.status(201).json({ status: 'success', message: 'Staff Supervisor assigned successfully.' });
  } catch (error) {
    await connection.rollback();
    console.error('ASSIGN STAFF SUPERVISOR ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'An error occurred while assigning the supervisor.' });
  } finally {
    connection.release();
  }
};

// DELETE /api/staff/:id/supervisor-assignments/current
exports.unassignCurrent = async (req, res) => {
  const staffId = Number(req.params.id);
  const { unassigned_date } = req.body || {};
  const adminId = req.user.user_id;

  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  const effectiveDate = isValidDateOnly(unassigned_date) ? unassigned_date : new Date().toISOString().slice(0, 10);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `UPDATE staff_supervisor_assignments
       SET unassigned_date = ?
       WHERE staff_id = ? AND unassigned_date IS NULL`,
      [effectiveDate, staffId]
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Staff member has no open supervisor assignment.' });
    }

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_members', ?, 'SUPERVISOR_UNASSIGNED', ?, NULL, ?)`,
      [staffId, adminId, JSON.stringify({ unassigned_date: effectiveDate })]
    );

    await connection.commit();
    return res.status(200).json({ status: 'success', message: 'Staff Supervisor unassigned successfully.' });
  } catch (error) {
    await connection.rollback();
    console.error('UNASSIGN STAFF SUPERVISOR ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'An error occurred while unassigning the supervisor.' });
  } finally {
    connection.release();
  }
};

// Shared helper — used by staffAttendanceController.js for scope filtering.
exports.getAssignedStaffIdsForSupervisor = async (supervisorUserId, executor = db) => {
  const [rows] = await executor.execute(
    `SELECT staff_id FROM staff_supervisor_assignments
     WHERE supervisor_user_id = ? AND unassigned_date IS NULL`,
    [supervisorUserId]
  );
  return rows.map((r) => r.staff_id);
};