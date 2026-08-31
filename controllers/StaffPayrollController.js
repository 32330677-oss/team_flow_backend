const pool = require('../config/db');

function isValidDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

function money(value) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

// كل أيام الأسبوع تُعتبر أيام عمل ما عدا الجمعة (5 = Friday حسب getUTCDay)
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

async function generateStaffPayrollBatch(req, res) {
    const { start_date, end_date } = req.body || {};
    const userId = req.user?.user_id;

    if (!userId) return res.status(401).json({ status: 'error', message: 'تعذر تحديد هوية الأدمن' });
    if (!isValidDate(start_date) || !isValidDate(end_date)) {
        return res.status(400).json({ status: 'error', message: 'يرجى إدخال تواريخ صحيحة بصيغة YYYY-MM-DD' });
    }
    if (end_date < start_date) {
        return res.status(400).json({ status: 'error', message: 'تاريخ النهاية يجب أن يكون بعد أو يساوي تاريخ البداية' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [overlap] = await connection.execute(
            `SELECT staff_payroll_batch_id FROM staff_payroll_batches
             WHERE start_date <= ? AND end_date >= ? LIMIT 1 FOR UPDATE`,
            [end_date, start_date]
        );
        if (overlap.length) {
            await connection.rollback();
            return res.status(409).json({ status: 'error', message: 'يوجد كشف رواتب متداخل مع هذه الفترة بالفعل' });
        }

        const [staffList] = await connection.execute(
            `SELECT staff_id, full_name, monthly_salary, paid_leave_types
             FROM staff_members WHERE status = 'Active'`
        );
        if (!staffList.length) {
            await connection.rollback();
            return res.status(404).json({ status: 'error', message: 'لا يوجد موظفون إداريون نشطون' });
        }

        const workingDays = countWorkingDays(start_date, end_date);
        if (workingDays <= 0) {
            await connection.rollback();
            return res.status(400).json({ status: 'error', message: 'الفترة المحددة لا تحتوي على أيام عمل' });
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

            // فقط السجلات المعتمدة (Approved) من قبل الأدمن تدخل في احتساب الراتب
            const [records] = await connection.execute(
                `SELECT attendance_status, is_paid FROM staff_attendance
                 WHERE staff_id = ? AND record_date BETWEEN ? AND ? AND status = 'Approved'`,
                [staff.staff_id, start_date, end_date]
            );

            let presentDays = 0;
            let paidLeaveDays = 0;
            let unpaidAbsenceDays = 0;

            for (const record of records) {
                if (record.attendance_status === 'Present') {
                    presentDays += 1;
                } else if (record.attendance_status === 'Absent') {
                    unpaidAbsenceDays += 1;
                } else if (paidLeaveTypes.includes(record.attendance_status) && Number(record.is_paid) === 1) {
                    paidLeaveDays += 1;
                } else {
                    unpaidAbsenceDays += 1;
                }
            }

            const dailyRate = money(Number(staff.monthly_salary) / workingDays);
            const payableDays = presentDays + paidLeaveDays;
            const netSalary = money(dailyRate * payableDays);

            const [payrollResult] = await connection.execute(
                `INSERT INTO staff_payroll
                    (staff_payroll_batch_id, staff_id, monthly_salary_snapshot, working_days_in_period,
                     present_days, paid_leave_days, unpaid_absence_days, daily_rate, net_salary)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [batchId, staff.staff_id, staff.monthly_salary, workingDays,
                    presentDays, paidLeaveDays, unpaidAbsenceDays, dailyRate, netSalary]
            );
            if (!payrollResult.insertId) continue;

            totalStaff += 1;
            totalAmount = money(totalAmount + netSalary);
        }

        if (!totalStaff) {
            await connection.rollback();
            return res.status(400).json({ status: 'error', message: 'تعذر احتساب أي راتب لهذه الفترة' });
        }

        await connection.execute(
            `UPDATE staff_payroll_batches SET total_staff = ?, total_amount = ? WHERE staff_payroll_batch_id = ?`,
            [totalStaff, totalAmount, batchId]
        );

        await connection.commit();
        return res.status(201).json({ status: 'success', message: 'تم إنشاء كشف رواتب الموظفين الإداريين بنجاح', batch_id: batchId });
    } catch (error) {
        await connection.rollback();
        console.error('generateStaffPayrollBatch:', error);
        return res.status(500).json({ status: 'error', message: 'فشل إنشاء كشف الرواتب' });
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
        return res.status(500).json({ status: 'error', message: 'فشل تحميل تقارير الرواتب' });
    }
}

async function getStaffPayrollBatchDetails(req, res) {
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ status: 'error', message: 'رقم الكشف غير صالح' });
    try {
        const [batches] = await pool.execute('SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ?', [batchId]);
        if (!batches.length) return res.status(404).json({ status: 'error', message: 'الكشف غير موجود' });

        const [items] = await pool.execute(
            `SELECT sp.*, sm.full_name, sm.staff_unique_id
             FROM staff_payroll sp
             JOIN staff_members sm ON sm.staff_id = sp.staff_id
             WHERE sp.staff_payroll_batch_id = ?
             ORDER BY sm.full_name`,
            [batchId]
        );
        return res.json({ status: 'success', batch: batches[0], staff: items });
    } catch (error) {
        console.error('getStaffPayrollBatchDetails:', error);
        return res.status(500).json({ status: 'error', message: 'فشل تحميل تفاصيل الكشف' });
    }
}

async function markStaffBatchAsPaid(req, res) {
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) return res.status(400).json({ status: 'error', message: 'رقم الكشف غير صالح' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [batches] = await connection.execute(
            'SELECT status FROM staff_payroll_batches WHERE staff_payroll_batch_id = ? FOR UPDATE',
            [batchId]
        );
        if (!batches.length) {
            await connection.rollback();
            return res.status(404).json({ status: 'error', message: 'الكشف غير موجود' });
        }
        if (batches[0].status === 'Paid') {
            await connection.rollback();
            return res.status(409).json({ status: 'error', message: 'الكشف مدفوع بالفعل' });
        }
        await connection.execute(`UPDATE staff_payroll_batches SET status = 'Paid' WHERE staff_payroll_batch_id = ?`, [batchId]);
        await connection.commit();
        return res.json({ status: 'success', message: 'تم تعليم الكشف كمدفوع' });
    } catch (error) {
        await connection.rollback();
        console.error('markStaffBatchAsPaid:', error);
        return res.status(500).json({ status: 'error', message: 'فشل تحديث حالة الدفع' });
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