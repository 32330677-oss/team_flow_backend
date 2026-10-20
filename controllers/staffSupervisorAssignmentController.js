// controllers/staffSupervisorAssignmentController.js
//
// Tracks which StaffSupervisor a staff member is currently assigned to.
// Mirrors staffAssignmentController.js's pattern (worker->site assignments)
// but for staff->supervisor assignments. Kept as a separate file/table per
// the "don't merge staff and worker logic" precedent already in this codebase.

const db = require('../config/db');
const { businessToday, addDays } = require('../services/businessDate');
const { activeOn } = require('../services/assignmentDates');

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
  const effectiveDate = isValidDateOnly(assigned_date) ? assigned_date : businessToday();   // B10

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
      // §5: the old assignment's LAST day is the day before the new one starts.
      `UPDATE staff_supervisor_assignments
       SET unassigned_date = ?
       WHERE staff_id = ? AND unassigned_date IS NULL`,
      [addDays(effectiveDate, -1), staffId]
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
  // §5: the date given is the LAST assigned day (inclusive). `unassigned_date`
  // is accepted as the same meaning for older clients.
  const lastDay = (req.body || {}).last_day ?? (req.body || {}).unassigned_date;
  const adminId = req.user.user_id;

  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff id.' });
  }
  if (!isValidDateOnly(lastDay)) {
    return res.status(400).json({ status: 'error', message: 'last_day (YYYY-MM-DD) is required: the LAST day of the current assignment.' });
  }
  const effectiveDate = lastDay;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `UPDATE staff_supervisor_assignments
       SET unassigned_date = ?
       WHERE staff_id = ? AND unassigned_date IS NULL AND assigned_date <= DATE_ADD(?, INTERVAL 1 DAY)`,
      [effectiveDate, staffId, effectiveDate]
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
// PATCH /api/staff/:id/supervisor-assignments/:assignmentId/start-date
// body: { new_start_date, reason }
// Corrects the FIRST day of one Staff Supervisor assignment (a date entered
// wrong). Refused when the new start is in the future, after the assignment's
// last day, before the employment start (fix the hire date first), or when an
// earlier start would overlap another supervisor assignment of the same staff
// member. Attendance and payroll are not touched (they never depend on the
// supervisor assignment). Audited (SUPERVISOR_ASSIGNMENT_START_CHANGED).
exports.changeStartDate = async (req, res) => {
  const staffId = Number(req.params.id);
  const assignmentId = Number(req.params.assignmentId);
  const newStart = String((req.body || {}).new_start_date || '').trim();
  const reason = String((req.body || {}).reason || '').trim();
  const adminId = req.user.user_id;

  if (!Number.isInteger(staffId) || staffId <= 0 || !Number.isInteger(assignmentId) || assignmentId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid staff or assignment id.' });
  }
  if (!isValidDateOnly(newStart)) {
    return res.status(400).json({ status: 'error', message: 'new_start_date (YYYY-MM-DD) is required: the new FIRST day of the assignment.' });
  }
  if (newStart > businessToday()) {
    return res.status(400).json({ status: 'error', message: 'The start date cannot be in the future.' });
  }
  if (reason.length < 3) {
    return res.status(400).json({ status: 'error', message: 'A reason is required.' });
  }

  const connection = await db.getConnection();
  const fail = async (code, message, extra = {}) => {
    await connection.rollback();
    return res.status(code).json({ status: 'error', message, ...extra });
  };
  try {
    await connection.beginTransaction();
    // Same lock order as the other staff changes: staff row first.
    const [[staff]] = await connection.execute(
      `SELECT staff_id, DATE_FORMAT(COALESCE(first_hire_date, hire_date), '%Y-%m-%d') AS employment_start
       FROM staff_members WHERE staff_id = ? FOR UPDATE`, [staffId]);
    if (!staff) return fail(404, 'Staff member not found.');

    const [[a]] = await connection.execute(
      `SELECT ssa.staff_assignment_id, ssa.supervisor_user_id, u.full_name AS supervisor_name,
              DATE_FORMAT(ssa.assigned_date, '%Y-%m-%d') AS assigned_date,
              DATE_FORMAT(ssa.unassigned_date, '%Y-%m-%d') AS last_day
       FROM staff_supervisor_assignments ssa
       JOIN users u ON u.user_id = ssa.supervisor_user_id
       WHERE ssa.staff_assignment_id = ? AND ssa.staff_id = ? FOR UPDATE`, [assignmentId, staffId]);
    if (!a) return fail(404, 'Assignment not found.');

    const oldStart = a.assigned_date;
    if (a.last_day !== null && a.last_day < oldStart) {
      return fail(409, 'This assignment was cancelled (it has no assigned day); create a new assignment instead.');
    }
    if (newStart === oldStart) return fail(400, `The assignment already starts on ${oldStart}.`);
    if (a.last_day !== null && newStart > a.last_day) {
      return fail(409, `The new start cannot be after the assignment's last day (${a.last_day}).`);
    }
    if (staff.employment_start && newStart < staff.employment_start) {
      return fail(409,
        `The new start (${newStart}) is before the hire date (${staff.employment_start}). ` +
        'If the hire date is wrong, correct it first from Edit (the first assignment moves with it).',
        { code: 'BEFORE_HIRE_DATE', hire_date: staff.employment_start });
    }

    const earlier = newStart < oldStart;
    if (earlier) {
      // Added days [newStart, oldStart - 1] must not belong to another assignment.
      const addedTo = addDays(oldStart, -1);
      const [overlaps] = await connection.execute(
        `SELECT ssa.staff_assignment_id, u.full_name AS supervisor_name,
                DATE_FORMAT(ssa.assigned_date, '%Y-%m-%d') AS assigned_date,
                DATE_FORMAT(ssa.unassigned_date, '%Y-%m-%d') AS last_day
         FROM staff_supervisor_assignments ssa
         JOIN users u ON u.user_id = ssa.supervisor_user_id
         WHERE ssa.staff_id = ? AND ssa.staff_assignment_id <> ?
           AND (ssa.unassigned_date IS NULL OR ssa.unassigned_date >= ssa.assigned_date)
           AND ssa.assigned_date <= ? AND (ssa.unassigned_date IS NULL OR ssa.unassigned_date >= ?)
         ORDER BY ssa.assigned_date LIMIT 1`,
        [staffId, assignmentId, addedTo, newStart]);
      if (overlaps.length) {
        const o = overlaps[0];
        return fail(409,
          `The previous assignment to ${o.supervisor_name} covers ${o.assigned_date} to ${o.last_day || 'open'}, ` +
          `which overlaps ${newStart} to ${addedTo}. End that assignment earlier first, or choose a later start.`,
          { code: 'OVERLAP', conflict: o });
      }
    }

    await connection.execute(
      'UPDATE staff_supervisor_assignments SET assigned_date = ? WHERE staff_assignment_id = ?',
      [newStart, assignmentId]);
    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_members', ?, 'SUPERVISOR_ASSIGNMENT_START_CHANGED', ?, ?, ?)`,
      [staffId, adminId,
        JSON.stringify({ staff_assignment_id: assignmentId, supervisor_user_id: a.supervisor_user_id, assigned_date: oldStart }),
        JSON.stringify({ assigned_date: newStart, reason })]);
    await connection.commit();
    return res.status(200).json({
      status: 'success',
      message: `${a.supervisor_name} now supervises this staff member from ${newStart}.`,
      data: { staff_assignment_id: assignmentId, old_start_date: oldStart, new_start_date: newStart },
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    console.error('CHANGE STAFF SUPERVISOR ASSIGNMENT START ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'An error occurred while changing the start date.' });
  } finally {
    connection.release();
  }
};

// POST /api/staff/supervisor-assignments/bulk
// body: { staff_ids: number[], supervisor_user_id, assigned_date, notes }
// Assigns the SAME supervisor to multiple staff members in one call.
// Reuses the exact same per-staff logic as assignSupervisor (close-then-reopen),
// just looped inside a single transaction so it's all-or-partial with a clear report.
exports.bulkAssignSupervisor = async (req, res) => {
  const { staff_ids, supervisor_user_id, assigned_date, notes } = req.body || {};
  const adminId = req.user.user_id;

  if (!Array.isArray(staff_ids) || staff_ids.length === 0) {
    return res.status(400).json({ status: 'error', message: 'staff_ids must be a non-empty array.' });
  }
  const supervisorId = Number(supervisor_user_id);
  if (!Number.isInteger(supervisorId) || supervisorId <= 0) {
    return res.status(400).json({ status: 'error', message: 'supervisor_user_id is required.' });
  }
  const effectiveDate = isValidDateOnly(assigned_date) ? assigned_date : businessToday();   // B10

  const uniqueStaffIds = [...new Set(staff_ids.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (uniqueStaffIds.length === 0) {
    return res.status(400).json({ status: 'error', message: 'No valid staff ids provided.' });
  }

  const connection = await db.getConnection();
  const updated = [];
  const skipped = [];
  try {
    await connection.beginTransaction();

    // Validate the supervisor once (shared across the whole batch).
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

    for (const staffId of uniqueStaffIds) {
      const [staffRows] = await connection.execute(
        'SELECT staff_id, status FROM staff_members WHERE staff_id = ? FOR UPDATE',
        [staffId]
      );
      if (staffRows.length === 0) {
        skipped.push({ staff_id: staffId, reason: 'Staff member not found.' });
        continue;
      }
      if (staffRows[0].status === 'Terminated') {
        skipped.push({ staff_id: staffId, reason: 'Staff member is terminated.' });
        continue;
      }

      // Same close-then-reopen pattern as the single-assign endpoint,
      // so each staff member's history stays independent and correct.
      await connection.execute(
        `UPDATE staff_supervisor_assignments
         SET unassigned_date = ?
         WHERE staff_id = ? AND unassigned_date IS NULL`,
        [addDays(effectiveDate, -1), staffId]
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
        [staffId, adminId, JSON.stringify({ supervisor_user_id: supervisorId, assigned_date: effectiveDate, notes, bulk: true })]
      );

      updated.push(staffId);
    }

    await connection.commit();
    return res.status(200).json({
      status: 'success',
      message: `Supervisor assigned to ${updated.length} staff member(s).`,
      data: { updated, skipped },
    });
  } catch (error) {
    await connection.rollback();
    console.error('BULK ASSIGN STAFF SUPERVISOR ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'An error occurred while bulk-assigning the supervisor.' });
  } finally {
    connection.release();
  }
};
// Shared helper — used by staffAttendanceController.js for scope filtering.
// B10: "today" is the business date (Asia/Damascus), not the DB server's CURDATE().
exports.getAssignedStaffIdsForSupervisor = async (supervisorUserId, executor = db) => {
  const today = businessToday();
  const [rows] = await executor.execute(
   `SELECT staff_id FROM staff_supervisor_assignments
 WHERE supervisor_user_id = ?
   AND ${activeOn('', '?')}`,
    [supervisorUserId, today, today]
  );
  return rows.map((r) => r.staff_id);
};


/**
 * A Staff Supervisor's scope on ONE date (not today):
 *  - editableIds: staff assigned to this supervisor on that date. He records
 *    and submits their attendance (also after a termination or a transfer,
 *    for the days that were his).
 *  - viewOnlyIds: staff assigned to this supervisor only AFTER that date, while
 *    another supervisor had them on that date. He sees that day read-only; he
 *    may only fix it if the Admin rejected it (Rejected record).
 *  - since: staff_id -> first date this supervisor has them (for the message).
 * A day on which NO supervisor had the employee stays editable by the
 * supervisor who has them later (nobody else could record it).
 */
exports.getSupervisorScopeOnDate = async (supervisorUserId, date, executor = db) => {
  const [rows] = await executor.execute(
    `SELECT staff_id,
            DATE_FORMAT(assigned_date, '%Y-%m-%d') AS assigned_date,
            DATE_FORMAT(unassigned_date, '%Y-%m-%d') AS unassigned_date
     FROM staff_supervisor_assignments
     WHERE supervisor_user_id = ?`,
    [supervisorUserId]
  );
  const editable = new Set();
  const later = new Map();
  for (const r of rows) {
    const id = Number(r.staff_id);
    if (r.assigned_date <= date && (!r.unassigned_date || r.unassigned_date >= date)) editable.add(id);
    else if (r.assigned_date > date) {
      if (!later.has(id) || r.assigned_date < later.get(id)) later.set(id, r.assigned_date);
    }
  }
  for (const id of editable) later.delete(id);
  const viewOnly = new Set();
  if (later.size) {
    // Who had them on that date? If nobody did, the day stays editable here.
    const ids = [...later.keys()];
    const [others] = await executor.execute(
      `SELECT DISTINCT staff_id FROM staff_supervisor_assignments
       WHERE staff_id IN (${ids.map(() => '?').join(',')})
         AND supervisor_user_id <> ?
         AND ${activeOn('', '?')}`,
      [...ids, supervisorUserId, date, date]
    );
    const coveredByOther = new Set(others.map((o) => Number(o.staff_id)));
    for (const id of ids) {
      if (coveredByOther.has(id)) viewOnly.add(id);
      else editable.add(id);
    }
  }
  return {
    editableIds: [...editable],
    viewOnlyIds: [...viewOnly],
    since: Object.fromEntries([...later.entries()]),
  };
};

/** Staff assigned to this supervisor on at least one day of [from, to]. */
exports.getStaffIdsAssignedDuring = async (supervisorUserId, from, to, executor = db) => {
  const [rows] = await executor.execute(
    `SELECT DISTINCT staff_id FROM staff_supervisor_assignments
     WHERE supervisor_user_id = ? AND assigned_date <= ? AND (unassigned_date IS NULL OR unassigned_date >= ?)`,
    [supervisorUserId, to, from]
  );
  return rows.map((r) => Number(r.staff_id));
};

// GET /api/staff/my-assigned-staff  (StaffSupervisor only)
exports.getMyAssignedStaff = async (req, res) => {
  const supervisorId = req.user.user_id;
  try {
    const [rows] = await db.execute(
      `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position,
              sm.standard_daily_hours, sm.status
       FROM staff_supervisor_assignments ssa
       JOIN staff_members sm ON sm.staff_id = ssa.staff_id
       WHERE ssa.supervisor_user_id = ?
         AND ${activeOn('ssa')}
         AND sm.status = 'Active'
       ORDER BY sm.full_name`,
      [supervisorId, businessToday(), businessToday()]
    );
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('GET MY ASSIGNED STAFF ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load assigned staff.' });
  }
};