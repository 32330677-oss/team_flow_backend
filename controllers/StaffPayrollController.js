const pool = require('../config/db');
const { countNonFridayDays, isFriday, round2 } = require('../services/staffAttendanceService');

function isValidDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

function money(value) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
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
// NEW MONTHLY PRINCIPLE (replaces the old day-fraction/manual-OT-grant model)
//
//   required_hours       = non-Friday working days in period * standard_daily_hours
//   actual_regular_raw    = sum(regular_hours) over Present days
//                           + standard_daily_hours for every paid-leave day
//                           + standard_daily_hours for every management-paid absence day
//   actual_regular_hours  = MIN(actual_regular_raw, required_hours)   -- capped, rule 11
//   overflow_as_ot        = MAX(0, actual_regular_raw - required_hours)
//   ot_earned_hours       = sum(daily overtime_hours over Present days) + overflow_as_ot
//   shortage_hours        = MAX(0, required_hours - actual_regular_hours)
//   ot_used_hours         = MIN(shortage_hours, ot_earned_hours)
//   ot_remaining_hours    = ot_earned_hours - ot_used_hours
//   uncovered_shortage    = shortage_hours - ot_used_hours
//   hourly_rate           = monthly_salary / required_hours
//   salary_deduction      = uncovered_shortage * hourly_rate
//   net_salary            = monthly_salary - salary_deduction
//
// Friday: only counted via actual_regular_raw when explicitly confirmed
// (is_friday_worked = 1) for that staff member on that day; required_hours
// is NEVER increased by Friday, so Friday hours only ever help cover an
// existing shortage or spill over into overtime — never inflate the basic
// salary beyond what the required hours already buy (rule 11).
// ============================================================

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

        // Staff who were Active for at least part of this period, even if
        // since Terminated (as long as termination happened on/after start).
        const [staffList] = await connection.execute(
            `SELECT staff_id, full_name, monthly_salary, paid_leave_types, standard_daily_hours,
                    hire_date, termination_date, status
             FROM staff_members
             WHERE status = 'Active' OR (status = 'Terminated' AND termination_date >= ?)`,
            [start_date]
        );
        if (!staffList.length) {
            await connection.rollback();
            return res.status(404).json({ status: 'error', message: 'No active staff members found' });
        }

        const batchNonFridayDays = countNonFridayDays(start_date, end_date);
        if (batchNonFridayDays <= 0) {
            await connection.rollback();
            return res.status(400).json({ status: 'error', message: 'The selected period contains no working days' });
        }

        // payroll_month for the ledger: the period's start month (a payroll
        // period is expected to sit within a single calendar month; if it
        // spans months, the ledger is keyed to the start month).
        const payrollMonth = start_date.slice(0, 7);

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

            // Clamp to this staff member's actual employment window.
            let effectiveStart = start_date;
            let effectiveEnd = end_date;
            if (staff.hire_date) {
                const hireStr = String(staff.hire_date).slice(0, 10);
                if (hireStr > effectiveStart) effectiveStart = hireStr;
            }
            if (staff.termination_date) {
                const termStr = String(staff.termination_date).slice(0, 10);
                if (termStr < effectiveEnd) effectiveEnd = termStr;
            }
            if (effectiveStart > effectiveEnd) continue; // not employed at all during this period

            const requiredHours = round2(countNonFridayDays(effectiveStart, effectiveEnd) * standardDailyHours);
            if (requiredHours <= 0) continue;

            const [records] = await connection.execute(
                `SELECT staff_attendance_id, record_date, attendance_status, is_paid,
                        is_management_paid_absence, regular_hours, overtime_hours, is_friday_worked
                 FROM staff_attendance
                 WHERE staff_id = ? AND record_date BETWEEN ? AND ? AND status = 'Approved'`,
                [staff.staff_id, effectiveStart, effectiveEnd]
            );

            let actualRegularRaw = 0;   // hours toward the required monthly entitlement
            let dailyOtEarned = 0;      // sum of per-day overtime_hours (Present days only)
            let presentDaysCount = 0;
            let paidLeaveDays = 0;
            let managementPaidDays = 0;
            let unpaidAbsenceDays = 0;

            for (const record of records) {
                const recordDateStr = String(record.record_date).slice(0, 10);
                const recordIsFriday = isFriday(recordDateStr);

                if (record.attendance_status === 'Present') {
                    // A Friday Present record only counts if it was explicitly
                    // confirmed (is_friday_worked = 1) when it was recorded.
                    if (recordIsFriday && Number(record.is_friday_worked) !== 1) {
                        continue;
                    }
                    actualRegularRaw += Number(record.regular_hours || 0);
                    dailyOtEarned += Number(record.overtime_hours || 0);
                    presentDaysCount += 1;
                } else if (record.attendance_status === 'Absent') {
                    if (Number(record.is_management_paid_absence) === 1) {
                        actualRegularRaw += standardDailyHours;
                        managementPaidDays += 1;
                    } else {
                        unpaidAbsenceDays += 1;
                    }
                } else if (paidLeaveTypes.includes(record.attendance_status) && Number(record.is_paid) === 1) {
                    actualRegularRaw += standardDailyHours;
                    paidLeaveDays += 1;
                } else {
                    unpaidAbsenceDays += 1;
                }
            }

            const actualRegularHours = round2(Math.min(actualRegularRaw, requiredHours));
            const overflowAsOt = round2(Math.max(0, actualRegularRaw - requiredHours));
            const otEarnedHours = round2(dailyOtEarned + overflowAsOt);

            const shortageHours = round2(Math.max(0, requiredHours - actualRegularHours));
            const otUsedHours = round2(Math.min(shortageHours, otEarnedHours));
            const otRemainingHours = round2(otEarnedHours - otUsedHours);
            const uncoveredShortageHours = round2(shortageHours - otUsedHours);

            const hourlyRate = money(Number(staff.monthly_salary) / requiredHours);
            const salaryDeduction = money(uncoveredShortageHours * hourlyRate);
            const netSalary = money(Number(staff.monthly_salary) - salaryDeduction);

            const [payrollResult] = await connection.execute(
                `INSERT INTO staff_payroll
                    (staff_payroll_batch_id, staff_id, monthly_salary_snapshot, working_days_in_period,
                     present_days, paid_leave_days, management_paid_days, unpaid_absence_days,
                     overtime_hours, daily_rate, net_salary,
                     required_hours, ot_earned_hours, ot_used_hours, ot_remaining_hours,
                     shortage_hours, salary_deduction_amount)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    batchId, staff.staff_id, staff.monthly_salary, countNonFridayDays(effectiveStart, effectiveEnd),
                    presentDaysCount, paidLeaveDays, managementPaidDays, unpaidAbsenceDays,
                    otEarnedHours, hourlyRate, netSalary,
                    requiredHours, otEarnedHours, otUsedHours, otRemainingHours,
                    shortageHours, salaryDeduction,
                ]
            );
            if (!payrollResult.insertId) continue;

            // One ledger row per (staff, payroll_month). If a batch is
            // regenerated for the same month, this overwrites the prior
            // snapshot rather than duplicating (rule: monthly OT is not
            // day-by-day, and must not double count across regenerations).
            await connection.execute(
                `INSERT INTO staff_monthly_overtime_ledger
                    (staff_id, payroll_month, required_hours, actual_regular_hours,
                     ot_earned_hours, ot_used_hours, ot_remaining_hours,
                     shortage_hours, uncovered_shortage_hours,
                     hourly_rate_snapshot, salary_deduction_amount, staff_payroll_batch_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    required_hours = VALUES(required_hours),
                    actual_regular_hours = VALUES(actual_regular_hours),
                    ot_earned_hours = VALUES(ot_earned_hours),
                    ot_used_hours = VALUES(ot_used_hours),
                    ot_remaining_hours = VALUES(ot_remaining_hours),
                    shortage_hours = VALUES(shortage_hours),
                    uncovered_shortage_hours = VALUES(uncovered_shortage_hours),
                    hourly_rate_snapshot = VALUES(hourly_rate_snapshot),
                    salary_deduction_amount = VALUES(salary_deduction_amount),
                    staff_payroll_batch_id = VALUES(staff_payroll_batch_id)`,
                [
                    staff.staff_id, payrollMonth, requiredHours, actualRegularHours,
                    otEarnedHours, otUsedHours, otRemainingHours,
                    shortageHours, uncoveredShortageHours,
                    hourlyRate, salaryDeduction, batchId,
                ]
            );

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
    'SELECT status, is_finalized FROM staff_payroll_batches WHERE staff_payroll_batch_id = ? FOR UPDATE',
    [batchId]
);
if (!batches.length) {
    await connection.rollback();
    return res.status(404).json({ status: 'error', message: 'Payroll batch not found' });
}
if (batches[0].status === 'Superseded') {
    await connection.rollback();
    return res.status(409).json({ status: 'error', message: 'A superseded batch cannot be marked as paid' });
}
if (batches[0].status === 'Paid') {
    await connection.rollback();
    return res.status(409).json({ status: 'error', message: 'Payroll batch is already paid' });
}
if (!batches[0].is_finalized) {
    await connection.rollback();
    return res.status(409).json({ status: 'error', message: 'Finalize this payroll batch before marking it as paid.' });
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
// ============================================================
// GET /api/staff-payroll/batch/:batchId/export.xlsx
// Streams a formatted Excel report for one staff payroll batch:
// company logo, period, finalized/paid status, and full breakdown.
// ============================================================
async function exportStaffPayrollExcel(req, res) {
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
    }

    try {
        const ExcelJS = require('exceljs');
        const path = require('path');

        const [batches] = await pool.execute(
            `SELECT spb.*, u.full_name AS generated_by, fu.full_name AS finalized_by
             FROM staff_payroll_batches spb
             JOIN users u ON u.user_id = spb.generated_by_user_id
             LEFT JOIN users fu ON fu.user_id = spb.finalized_by_user_id
             WHERE spb.staff_payroll_batch_id = ?`,
            [batchId]
        );
        if (!batches.length) return res.status(404).json({ status: 'error', message: 'Payroll batch not found.' });
        const batch = batches[0];

        const [rows] = await pool.execute(
            `SELECT sp.*, sm.full_name, sm.staff_unique_id, sm.position, sm.standard_daily_hours
             FROM staff_payroll sp
             JOIN staff_members sm ON sm.staff_id = sp.staff_id
             WHERE sp.staff_payroll_batch_id = ?
             ORDER BY sm.full_name`,
            [batchId]
        );
        if (!rows.length) return res.status(404).json({ status: 'error', message: 'No staff found in this batch.' });

        const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
        const logoPath = path.join(__dirname, '../assets/logo.png');

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Staff Payroll');

        try {
            const logoId = workbook.addImage({ filename: logoPath, extension: 'png' });
            sheet.addImage(logoId, { tl: { col: 0.1, row: 0.1 }, ext: { width: 130, height: 45 } });
        } catch (e) {
            console.warn('Logo not added:', e.message);
        }

        sheet.columns = [
            { header: 'No.', key: 'number', width: 6 },
            { header: 'Staff ID', key: 'staff_id', width: 14 },
            { header: 'Full Name', key: 'full_name', width: 26 },
            { header: 'Position', key: 'position', width: 20 },
            { header: 'Monthly Salary', key: 'monthly_salary', width: 16 },
            { header: 'Working Days', key: 'working_days', width: 14 },
            { header: 'Present Days', key: 'present_days', width: 14 },
            { header: 'Paid Leave Days', key: 'paid_leave_days', width: 16 },
            { header: 'Mgmt-Paid Absence', key: 'management_paid_days', width: 18 },
            { header: 'Unpaid Absence', key: 'unpaid_absence_days', width: 16 },
            { header: 'Required Hrs', key: 'required_hours', width: 14 },
            { header: 'OT Earned', key: 'ot_earned_hours', width: 12 },
            { header: 'OT Used', key: 'ot_used_hours', width: 12 },
            { header: 'OT Remaining', key: 'ot_remaining_hours', width: 14 },
            { header: 'Shortage Hrs', key: 'shortage_hours', width: 14 },
            { header: 'Deduction', key: 'salary_deduction_amount', width: 14 },
            { header: 'Net Salary', key: 'net_salary', width: 16 },
            { header: 'Signature', key: 'signature', width: 18 },
        ];

        const statusLabel = batch.status === 'Superseded' ? 'Superseded'
            : batch.status === 'Paid' ? 'Paid' : 'Generated';
        const finalizedLabel = (batch.is_finalized === 1 || batch.is_finalized === true)
            ? 'Finalized ✅' : 'Not Finalized ⚠️';

        sheet.mergeCells('A1:R1');
        sheet.getCell('A1').value =
            `Staff Payroll Batch #${batchId} (v${batch.version_number || 1}) — ${finalizedLabel}`;
        sheet.mergeCells('A2:R2');
        sheet.getCell('A2').value = `Period: ${dateOnly(batch.start_date)}  →  ${dateOnly(batch.end_date)}`;
        sheet.mergeCells('A3:R3');
        sheet.getCell('A3').value =
            `Status: ${statusLabel}   |   Generated By: ${batch.generated_by || '-'}` +
            (batch.finalized_by ? `   |   Finalized By: ${batch.finalized_by}` : '');
        sheet.mergeCells('A4:R4');
        sheet.getCell('A4').value = `Total Staff Paid: ${batch.total_staff || rows.length}`;
        sheet.getCell('A4').font = { bold: true };

        sheet.getRow(1).height = 26;
        sheet.getRow(1).font = { bold: true, size: 15 };
        sheet.getRow(2).height = 22;
        sheet.getRow(3).height = 22;
        sheet.getRow(4).height = 20;
        sheet.getRow(5).values = sheet.columns.map((c) => c.header);

        let grandTotalNet = 0;
        rows.forEach((r, index) => {
            sheet.addRow({
                number: index + 1,
                staff_id: r.staff_unique_id,
                full_name: r.full_name,
                position: r.position || '-',
                monthly_salary: Number(r.monthly_salary_snapshot || 0),
                working_days: r.working_days_in_period,
                present_days: Number(r.present_days || 0),
                paid_leave_days: Number(r.paid_leave_days || 0),
                management_paid_days: Number(r.management_paid_days || 0),
                unpaid_absence_days: Number(r.unpaid_absence_days || 0),
                required_hours: Number(r.required_hours || 0),
                ot_earned_hours: Number(r.ot_earned_hours || 0),
                ot_used_hours: Number(r.ot_used_hours || 0),
                ot_remaining_hours: Number(r.ot_remaining_hours || 0),
                shortage_hours: Number(r.shortage_hours || 0),
                salary_deduction_amount: Number(r.salary_deduction_amount || 0),
                net_salary: Number(r.net_salary || 0),
                signature: '',
            });
            grandTotalNet += Number(r.net_salary || 0);
        });

        const totalRow = sheet.addRow({
            full_name: 'GRAND TOTAL',
            net_salary: Math.round(grandTotalNet * 100) / 100,
        });
        totalRow.font = { bold: true };

        sheet.getRow(5).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2A6C' } };
        sheet.getRow(5).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

        for (let r = 6; r <= sheet.rowCount; r += 1) {
            sheet.getCell(r, 5).numFmt = '#,##0.00';   // monthly_salary
            sheet.getCell(r, 16).numFmt = '#,##0.00';  // deduction
            sheet.getCell(r, 17).numFmt = '#,##0.00';  // net_salary
        }
        sheet.views = [{ state: 'frozen', ySplit: 5 }];
        sheet.autoFilter = { from: 'A5', to: 'R5' };

        const fileName = `staff_payroll_batch_${batchId}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('exportStaffPayrollExcel:', error);
        if (!res.headersSent) {
            return res.status(500).json({ status: 'error', message: 'Failed to export staff payroll Excel report.' });
        }
    }
}
module.exports = {
    generateStaffPayrollBatch,
    getStaffPayrollReport,
    getStaffPayrollBatchDetails,
    markStaffBatchAsPaid,
    exportStaffPayrollExcel, // ← جديد
};