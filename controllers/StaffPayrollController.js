const pool = require('../config/db');

function isValidDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

function money(value) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

// All days of the week are considered working days except Friday (5 = Friday according to getUTCDay)
function countWorkingDays(startDate, endDate) {
    let count = 0;
    const cursor = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    while (cursor <= end) {
        if (cursor.getUTCDay() !== 5) count += 1;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
}




function isFriday(dateValue) {
    const date = new Date(`${dateValue}T00:00:00Z`);
    return date.getUTCDay() === 5;
}

function getPaidLeaveTypes(staff) {
    const defaults = ['Sick', 'Vacation', 'Holiday'];
    if (!staff.paid_leave_types) return defaults;
    try {
        const parsed = typeof staff.paid_leave_types === 'string' ? JSON.parse(staff.paid_leave_types) : staff.paid_leave_types;
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaults;
    } catch (_) {
        return defaults;
    }
}

// ============================================================
// PARTIAL-DAY (HOURLY-PRORATED) PAY FOR "Present" DAYS
// ------------------------------------------------------------
// A staff member's monthly_salary is converted into a daily_rate
// (monthly_salary / workingDays), same as before. What changed is how
// many "days" a single Present record contributes:
//
//   dayFraction = MIN(1, regular_hours / standard_daily_hours)
//
// - regular_hours is already capped at standard_daily_hours upstream
//   (see staffAttendanceController.js -> selfMarkAttendance and
//   staffAttendanceAdminController.js -> bulkSetAttendance), so this
//   division naturally yields a value between 0 and 1.
// - standard_daily_hours is read per staff member (staff_members table),
//   since different staff can have different standard shifts (e.g. 8h vs
//   10h) and lunch is unpaid uniformly across the board (already baked
//   into how regular_hours/overtime_hours were computed at check-out).
// - overtime_hours is summed and stored/returned for visibility only.
//   It NEVER contributes to net_salary for staff (unlike workers, whose
//   overtime is paid at a flat rate) — this is an explicit, deliberate
//   business rule for staff payroll.
// - Paid leave (Sick/Vacation/Holiday marked is_paid=1) and management-
//   paid absences still count as a FULL day each; they are not tied to
//   worked hours so there is nothing to prorate.
// ============================================================
function computeDayFraction(regularHours, standardDailyHours) {
    const worked = Number(regularHours || 0);
    const standard = Number(standardDailyHours) > 0 ? Number(standardDailyHours) : 8;
    if (!Number.isFinite(worked) || worked <= 0) return 0;
    // Clamp to [0, 1]: defensive in case regular_hours was ever stored
    // slightly above standard due to a rounding edge case upstream.
    return Math.min(1, worked / standard);
}

async function generateStaffPayrollBatch(req, res) {
    const { start_date, end_date } = req.body || {};
    const userId = req.user?.user_id;

    if (!userId) return res.status(401).json({ status: 'error', message: 'Unable to determine user identity' });
    if (!isValidDate(start_date) || !isValidDate(end_date)) {
        return res.status(400).json({ status: 'error', message: 'Please enter valid dates in YYYY-MM-DD format' });
    }
    if (end_date < start_date) {
        return res.status(400).json({ status: 'error', message: 'End date must be after or equal to start date' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [overlap] = await connection.execute(
            `SELECT staff_payroll_batch_id FROM staff_payroll_batches
             WHERE start_date <= ? AND end_date >= ? AND status <> 'Superseded' LIMIT 1 FOR UPDATE`,
            [end_date, start_date]
        );
        if (overlap.length) {
            await connection.rollback();
            return res.status(409).json({ status: 'error', message: 'A payroll batch overlapping with this period already exists' });
        }

        // NOTE: standard_daily_hours is now required per staff member to
        // correctly prorate partial-day attendance.
        const [staffList] = await connection.execute(
            `SELECT staff_id, full_name, monthly_salary, paid_leave_types, standard_daily_hours
             FROM staff_members WHERE status = 'Active'`
        );
        if (!staffList.length) {
            await connection.rollback();
            return res.status(404).json({ status: 'error', message: 'No active staff members found' });
        }

        const workingDays = countWorkingDays(start_date, end_date);
        if (workingDays <= 0) {
            await connection.rollback();
            return res.status(400).json({ status: 'error', message: 'The selected period contains no working days' });
        }

        const [batchResult] = await connection.execute(
            `INSERT INTO staff_payroll_batches (start_date, end_date, generated_by_user_id, status)
             VALUES (?, ?, ?, 'Generated')`,
            [start_date, end_date, userId]
        );
        const batchId = batchResult.insertId;
        let totalStaff = 0;
        let totalAmount = 0;

        for (const staff of staffList) {
            const paidLeaveTypes = getPaidLeaveTypes(staff);
            const standardDailyHours = Number(staff.standard_daily_hours) > 0 ? Number(staff.standard_daily_hours) : 8;

            // Only Approved records enter into salary calculation
const [records] = await connection.execute(
    `SELECT record_date, attendance_status, is_paid, is_management_paid_absence, regular_hours, overtime_hours
     FROM staff_attendance
     WHERE staff_id = ? AND record_date BETWEEN ? AND ? AND status = 'Approved'`,
    [staff.staff_id, start_date, end_date]
);

            let presentDayFraction = 0;   // sum of prorated day-fractions for "Present" records
            let paidLeaveDays = 0;        // full days
            let managementPaidDays = 0;   // full days
            let unpaidAbsenceDays = 0;    // informational only, not paid
            let overtimeHoursTotal = 0;   // display-only, never paid for staff

for (const record of records) {
    if (record.attendance_status === 'Present') {
        // Friday attendance is recorded and remains visible in attendance,
        // but it must not contribute to staff payroll.
        if (isFriday(record.record_date)) {
            continue;
        }

        presentDayFraction += computeDayFraction(record.regular_hours, standardDailyHours);
        overtimeHoursTotal += Number(record.overtime_hours || 0);
    } else if (record.attendance_status === 'Absent') {
                    // Absences are unpaid by default. An Admin can explicitly grant
                    // management-paid leave for a specific absence day beforehand
                    // (see controllers/staffAbsenceController.js). That day is then
                    // paid as a FULL day and tracked separately.
                    if (Number(record.is_management_paid_absence) === 1) {
                        managementPaidDays += 1;
                    } else {
                        unpaidAbsenceDays += 1;
                    }
                } else if (paidLeaveTypes.includes(record.attendance_status) && Number(record.is_paid) === 1) {
                    paidLeaveDays += 1;
                } else {
                    unpaidAbsenceDays += 1;
                }
            }

            const dailyRate = money(Number(staff.monthly_salary) / workingDays);
            const payableDays = money(presentDayFraction + paidLeaveDays + managementPaidDays);
            // Overtime is intentionally excluded from net_salary for staff.
            const netSalary = money(dailyRate * payableDays);

            const [payrollResult] = await connection.execute(
                `INSERT INTO staff_payroll
                    (staff_payroll_batch_id, staff_id, monthly_salary_snapshot, working_days_in_period,
                     present_days, paid_leave_days, management_paid_days, unpaid_absence_days,
                     overtime_hours, daily_rate, net_salary)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    batchId, staff.staff_id, staff.monthly_salary, workingDays,
                    payableDays > 0 ? money(presentDayFraction) : 0,
                    paidLeaveDays, managementPaidDays, unpaidAbsenceDays,
                    money(overtimeHoursTotal), dailyRate, netSalary
                ]
            );
            if (!payrollResult.insertId) continue;

            totalStaff += 1;
            totalAmount = money(totalAmount + netSalary);
        }

        if (!totalStaff) {
            await connection.rollback();
            return res.status(400).json({ status: 'error', message: 'Could not calculate any salary for this period' });
        }

        await connection.execute(
            `UPDATE staff_payroll_batches SET total_staff = ?, total_amount = ? WHERE staff_payroll_batch_id = ?`,
            [totalStaff, totalAmount, batchId]
        );

        await connection.commit();
        return res.status(201).json({ status: 'success', message: 'Staff payroll batch generated successfully', batch_id: batchId });
    } catch (error) {
        await connection.rollback();
        console.error('generateStaffPayrollBatch:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to generate payroll batch' });
    } finally {
        connection.release();
    }
}

async function getStaffPayrollReport(req, res) {
    try {
        const [rows] = await pool.execute(
            `SELECT spb.staff_payroll_batch_id, spb.start_date, spb.end_date,
                    spb.total_staff, spb.total_amount, spb.status, spb.generated_at,
                    u.full_name AS generated_by
             FROM staff_payroll_batches spb
             JOIN users u ON u.user_id = spb.generated_by_user_id
             ORDER BY spb.generated_at DESC`
        );
        return res.json({ status: 'success', data: rows });
    } catch (error) {
        console.error('getStaffPayrollReport:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to load payroll reports' });
    }
}

async function getStaffPayrollBatchDetails(req, res) {
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ status: 'error', message: 'Invalid batch ID' });
    try {
        const [batches] = await pool.execute('SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ?', [batchId]);
        if (!batches.length) return res.status(404).json({ status: 'error', message: 'Payroll batch not found' });

        // overtime_hours is included so the UI/export can show it as an
        // informational figure (hours only — it is never part of net_salary).
        const [items] = await pool.execute(
            `SELECT sp.*, sm.full_name, sm.staff_unique_id, sm.position, sm.standard_daily_hours
             FROM staff_payroll sp
             JOIN staff_members sm ON sm.staff_id = sp.staff_id
             WHERE sp.staff_payroll_batch_id = ?
             ORDER BY sm.full_name`,
            [batchId]
        );
        return res.json({ status: 'success', batch: batches[0], staff: items });
    } catch (error) {
        console.error('getStaffPayrollBatchDetails:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to load batch details' });
    }
}

async function markStaffBatchAsPaid(req, res) {
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ status: 'error', message: 'Invalid batch ID' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [batches] = await connection.execute(
            'SELECT status FROM staff_payroll_batches WHERE staff_payroll_batch_id = ? FOR UPDATE',
            [batchId]
        );
        if (!batches.length) {
            await connection.rollback();
            return res.status(404).json({ status: 'error', message: 'Payroll batch not found' });
        }
        if (batches[0].status === 'Paid') {
            await connection.rollback();
            return res.status(409).json({ status: 'error', message: 'Payroll batch is already paid' });
        }
        await connection.execute(`UPDATE staff_payroll_batches SET status = 'Paid' WHERE staff_payroll_batch_id = ?`, [batchId]);
        await connection.commit();
        return res.json({ status: 'success', message: 'Payroll batch marked as paid successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('markStaffBatchAsPaid:', error);
        return res.status(500).json({ status: 'error', message: 'Failed to update payment status' });
    } finally {
        connection.release();
    }
}

module.exports = {
    generateStaffPayrollBatch,
    getStaffPayrollReport,
    getStaffPayrollBatchDetails,
    markStaffBatchAsPaid,
};