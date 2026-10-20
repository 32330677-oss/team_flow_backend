// services/staffHireDateService.js
//
// Correcting a staff member's hire date (a date that was entered wrong).
//
// Payroll and attendance read the employment start from first_hire_date
// (staffEmploymentService), not hire_date. Editing only hire_date therefore
// changed nothing for payroll. A correction now moves, together and inside the
// caller's transaction:
//   * hire_date and first_hire_date;
//   * the first compensation period (salary / standard hours) so that it starts
//     on the new date (moving EARLIER, otherwise payroll finds no rate for the
//     added days; moving LATER, so the history starts with the employment);
//   * the first Staff Supervisor and site assignment that started on the old
//     hire date (moving EARLIER), or any assignment that would start before the
//     new date (moving LATER).
//
// Refused (nothing changes, same as before) when the staff member is in a
// Generated or Paid staff payroll batch.
//
// Previous behaviour kept (only hire_date changes; first_hire_date, the
// salary periods and the assignments stay as they are) when:
//   * a status change (Inactive / Terminated / reactivation) is dated on or
//     before the new date (the employment history would no longer make sense);
//   * moving LATER, attendance exists before the new date (it would fall
//     outside the employment);
//   * moving LATER, an assignment both starts and ends before the new date.
// Every change is audited (HIRE_DATE_CHANGED).

const dateOnly = (v) => (v ? String(v).slice(0, 10) : null);

class HireDateError extends Error {
  constructor(message, extra = null) {
    super(message);
    this.isOperational = true;
    this.statusCode = 409;
    this.extra = extra;
  }
}

/**
 * Plan a hire-date correction without changing anything.
 * Returns { changed, old_date, new_date, direction, blockers[], moves[] }.
 * `lock` = true takes row locks (use inside the transaction that applies it).
 */
async function planHireDateChange(executor, staffId, newDate, { lock = false } = {}) {
  const forUpdate = lock ? ' FOR UPDATE' : '';
  const [[staff]] = await executor.execute(
    `SELECT staff_id, full_name, status,
            DATE_FORMAT(hire_date, '%Y-%m-%d') AS hire_date,
            DATE_FORMAT(first_hire_date, '%Y-%m-%d') AS first_hire_date
     FROM staff_members WHERE staff_id = ?${forUpdate}`,
    [staffId]
  );
  if (!staff) {
    const e = new HireDateError('Staff member not found.');
    e.statusCode = 404;
    throw e;
  }

  const oldDate = dateOnly(staff.first_hire_date) || dateOnly(staff.hire_date);
  const plan = {
    staff_id: Number(staff.staff_id),
    old_date: oldDate,
    shown_hire_date: dateOnly(staff.hire_date),
    new_date: newDate,
    changed: oldDate !== newDate || dateOnly(staff.hire_date) !== newDate,
    direction: !oldDate || newDate < oldDate ? 'earlier' : (newDate > oldDate ? 'later' : 'same'),
    blockers: [],
    moves: [],
    // 'full'           : employment start + linked first rows move together
    // 'hire_date_only' : previous behaviour, only the displayed hire_date changes
    // 'refused'        : nothing changes (payroll exists)
    mode: 'full',
  };
  if (!plan.changed) return plan;

  // 1) Payroll already generated for this person.
  const [payroll] = await executor.execute(
    `SELECT spb.staff_payroll_batch_id AS batch_id,
            DATE_FORMAT(spb.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(spb.end_date, '%Y-%m-%d') AS end_date, spb.status
     FROM staff_payroll sp
     JOIN staff_payroll_batches spb ON spb.staff_payroll_batch_id = sp.staff_payroll_batch_id
     WHERE sp.staff_id = ? AND spb.status IN ('Generated', 'Paid')
     ORDER BY spb.start_date LIMIT 3`,
    [staffId]
  );
  if (payroll.length) {
    plan.blockers.push({
      code: 'IN_PAYROLL',
      message: `This staff member is in payroll batch #${payroll[0].batch_id} ` +
        `(${payroll[0].start_date} to ${payroll[0].end_date}, ${payroll[0].status}). ` +
        'Void that batch first (a Paid batch cannot be changed).',
      batches: payroll,
    });
  }

  // 2) Status changes on or before the new date.
  const [history] = await executor.execute(
    `SELECT DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, new_status
     FROM staff_status_history
     WHERE staff_id = ? AND effective_date <= ?
     ORDER BY effective_date LIMIT 3`,
    [staffId, newDate]
  );
  if (history.length) {
    plan.blockers.push({
      code: 'STATUS_HISTORY',
      message: `A status change (${history[0].new_status}) is dated ${history[0].effective_date}, ` +
        `on or before the new hire date ${newDate}. Choose an earlier date.`,
      history,
    });
  }

  // 3) Attendance before the new date (moving later only).
  if (plan.direction === 'later') {
    const [att] = await executor.execute(
      `SELECT DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date, status
       FROM staff_attendance WHERE staff_id = ? AND record_date < ?
       ORDER BY record_date`,
      [staffId, newDate]
    );
    if (att.length) {
      plan.blockers.push({
        code: 'ATTENDANCE_BEFORE',
        message: `${att.length} attendance record(s) exist before ${newDate} ` +
          `(${att.slice(0, 5).map((a) => a.record_date).join(', ')}${att.length > 5 ? ', ...' : ''}). ` +
          'They would fall outside the employment. Correct or remove them first, or choose an earlier date.',
        records: att.slice(0, 20),
      });
    }
  }

  // 4) First compensation period.
  const [[firstComp]] = await executor.execute(
    `SELECT staff_compensation_id,
            DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from,
            DATE_FORMAT(effective_to, '%Y-%m-%d') AS effective_to
     FROM staff_compensation_history WHERE staff_id = ?
     ORDER BY effective_from ASC, staff_compensation_id ASC LIMIT 1${forUpdate}`,
    [staffId]
  );
  if (firstComp && firstComp.effective_from !== newDate) {
    const moveComp = plan.direction === 'earlier'
      ? firstComp.effective_from > newDate
      : firstComp.effective_from < newDate && (!firstComp.effective_to || firstComp.effective_to >= newDate);
    if (moveComp) {
      plan.moves.push({
        kind: 'compensation', id: firstComp.staff_compensation_id,
        label: 'Salary / hours period start', from: firstComp.effective_from, to: newDate,
      });
    }
  }

  // 5) Supervisor and site assignments.
  for (const [table, kind, label] of [
    ['staff_supervisor_assignments', 'supervisor_assignment', 'Staff Supervisor assignment start'],
    ['staff_site_assignments', 'site_assignment', 'Site assignment start'],
  ]) {
    const [rows] = await executor.execute(
      `SELECT staff_assignment_id,
              DATE_FORMAT(assigned_date, '%Y-%m-%d') AS assigned_date,
              DATE_FORMAT(unassigned_date, '%Y-%m-%d') AS unassigned_date
       FROM ${table} WHERE staff_id = ?
       ORDER BY assigned_date ASC, staff_assignment_id ASC${forUpdate}`,
      [staffId]
    );
    // Cancelled rows (last day before first day) are ignored.
    const live = rows.filter((r) => !r.unassigned_date || r.unassigned_date >= r.assigned_date);
    if (plan.direction === 'earlier') {
      const first = live[0];
      if (first && first.assigned_date === oldDate) {
        plan.moves.push({ kind, id: first.staff_assignment_id, label, from: first.assigned_date, to: newDate });
      }
    } else {
      for (const r of live) {
        if (r.assigned_date >= newDate) continue;
        if (r.unassigned_date && r.unassigned_date < newDate) {
          plan.blockers.push({
            code: 'ASSIGNMENT_BEFORE',
            message: `${label.replace(' start', '')} from ${r.assigned_date} to ${r.unassigned_date} ` +
              `ends before the new hire date ${newDate}. Remove or change it first.`,
          });
        } else {
          plan.moves.push({ kind, id: r.staff_assignment_id, label, from: r.assigned_date, to: newDate });
        }
      }
    }
  }

  if (plan.blockers.some((b) => b.code === 'IN_PAYROLL')) plan.mode = 'refused';
  else if (plan.blockers.length) plan.mode = 'hire_date_only';
  if (plan.mode !== 'full') plan.moves = [];
  return plan;
}

/**
 * Apply a planned correction inside the caller's transaction.
 * Throws HireDateError (409) when the plan has blockers.
 */
async function applyHireDateChange(executor, staffId, newDate, { userId, reason } = {}) {
  const plan = await planHireDateChange(executor, staffId, newDate, { lock: true });
  if (!plan.changed) return plan;
  if (plan.mode === 'refused') {
    const b = plan.blockers.find((x) => x.code === 'IN_PAYROLL');
    throw new HireDateError(b.message, { code: b.code, blockers: [b] });
  }
  if (plan.mode === 'hire_date_only') {
    // Previous behaviour: only the displayed hire date changes.
    await executor.execute('UPDATE staff_members SET hire_date = ? WHERE staff_id = ?', [newDate, staffId]);
    await executor.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_members', ?, 'HIRE_DATE_CHANGED', ?, ?, ?)`,
      [staffId, userId || null,
        JSON.stringify({ hire_date: plan.shown_hire_date }),
        JSON.stringify({ hire_date: newDate, reason: reason || null, mode: 'hire_date_only',
          employment_start_kept: plan.old_date, why: plan.blockers.map((b) => b.code) })]
    );
    return plan;
  }

  await executor.execute(
    'UPDATE staff_members SET hire_date = ?, first_hire_date = ? WHERE staff_id = ?',
    [newDate, newDate, staffId]
  );
  for (const m of plan.moves) {
    if (m.kind === 'compensation') {
      await executor.execute('UPDATE staff_compensation_history SET effective_from = ? WHERE staff_compensation_id = ?', [newDate, m.id]);
    } else if (m.kind === 'supervisor_assignment') {
      await executor.execute('UPDATE staff_supervisor_assignments SET assigned_date = ? WHERE staff_assignment_id = ?', [newDate, m.id]);
    } else if (m.kind === 'site_assignment') {
      await executor.execute('UPDATE staff_site_assignments SET assigned_date = ? WHERE staff_assignment_id = ?', [newDate, m.id]);
    }
  }
  await executor.execute(
    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
     VALUES ('staff_members', ?, 'HIRE_DATE_CHANGED', ?, ?, ?)`,
    [staffId, userId || null,
      JSON.stringify({ hire_date: plan.shown_hire_date, first_hire_date: plan.old_date }),
      JSON.stringify({ hire_date: newDate, first_hire_date: newDate, reason: reason || null, moved: plan.moves })]
  );
  return plan;
}

module.exports = { planHireDateChange, applyHireDateChange, HireDateError };