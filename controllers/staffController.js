const db = require('../config/db');

const DEFAULT_DAILY_HOURS = 8.00;

function parsePaidLeaveTypes(value) {
    if (value === undefined || value === null || value === '') return null;
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? JSON.stringify(parsed) : null;
        } catch (_) {
            return null;
        }
    }
    return null;
}

// 1. Get all staff members
exports.getAllStaff = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.phone_number, sm.position,
                    sm.site_id, s.site_name, sm.hire_date, sm.monthly_salary, sm.standard_daily_hours,
                    sm.paid_leave_types, sm.status, sm.created_at
             FROM staff_members sm
             LEFT JOIN sites s ON s.site_id = sm.site_id
             ORDER BY sm.created_at DESC`
        );
        return res.status(200).json({ status: 'success', results: rows.length, data: rows });
    } catch (error) {
        console.error('GET ALL STAFF ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while fetching staff data' });
    }
};

// 2. Create a new staff member
exports.createStaff = async (req, res) => {
    const {
        full_name, phone_number, position,
        site_id, hire_date, monthly_salary, standard_daily_hours, paid_leave_types
    } = req.body;

    if (!full_name || monthly_salary === undefined || monthly_salary === null) {
        return res.status(400).json({ status: 'error', message: 'Please provide the full name and monthly salary' });
    }

    const numericSalary = Number(monthly_salary);
    if (!Number.isFinite(numericSalary) || numericSalary < 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid monthly salary' });
    }

    const numericDailyHours = (standard_daily_hours !== undefined && standard_daily_hours !== null && standard_daily_hours !== '')
        ? Number(standard_daily_hours)
        : DEFAULT_DAILY_HOURS;
    if (!Number.isFinite(numericDailyHours) || numericDailyHours <= 0 || numericDailyHours > 24) {
        return res.status(400).json({ status: 'error', message: 'Invalid daily hours' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        if (site_id) {
            const [siteRows] = await connection.query('SELECT site_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
            if (siteRows.length === 0) {
                throw Object.assign(new Error('The specified site does not exist'), { isOperational: true });
            }
        }

        const [staffResult] = await connection.query(
            `INSERT INTO staff_members
                (staff_unique_id, full_name, phone_number, position, site_id,
                 hire_date, monthly_salary, standard_daily_hours, paid_leave_types, status)
             VALUES ('TEMP', ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
            [
                full_name, phone_number || null, position || null, site_id || null,
                hire_date || null, numericSalary, numericDailyHours, parsePaidLeaveTypes(paid_leave_types)
            ]
        );
        const newStaffId = staffResult.insertId;
        const staffUniqueId = `STF-${newStaffId}`;
        await connection.query('UPDATE staff_members SET staff_unique_id = ? WHERE staff_id = ?', [staffUniqueId, newStaffId]);

        await connection.commit();

        return res.status(201).json({
            status: 'success',
            message: 'Staff member created successfully',
            data: { staff_id: newStaffId, staff_unique_id: staffUniqueId }
        });
    } catch (error) {
        await connection.rollback();
        console.error('CREATE STAFF ERROR:', error);
        const status = error.isOperational ? 400 : 500;
        return res.status(status).json({
            status: 'error',
            message: error.isOperational ? error.message : 'Server error while adding the staff member'
        });
    } finally {
        connection.release();
    }
};

// 3. Update staff member data
exports.updateStaff = async (req, res) => {
    const { id } = req.params; // staff_id
    const {
        full_name, phone_number, position, site_id, hire_date,
        monthly_salary, standard_daily_hours, paid_leave_types
    } = req.body;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [existing] = await connection.query('SELECT * FROM staff_members WHERE staff_id = ? LIMIT 1', [id]);
        if (existing.length === 0) {
            throw Object.assign(new Error('Staff member not found'), { isOperational: true });
        }
        const current = existing[0];

        if (site_id !== undefined && site_id !== null && site_id !== '') {
            const [siteRows] = await connection.query('SELECT site_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
            if (siteRows.length === 0) {
                throw Object.assign(new Error('The specified site does not exist'), { isOperational: true });
            }
        }

        let numericSalary = current.monthly_salary;
        if (monthly_salary !== undefined && monthly_salary !== null && monthly_salary !== '') {
            numericSalary = Number(monthly_salary);
            if (!Number.isFinite(numericSalary) || numericSalary < 0) {
                throw Object.assign(new Error('Invalid monthly salary'), { isOperational: true });
            }
        }

        let numericDailyHours = current.standard_daily_hours;
        if (standard_daily_hours !== undefined && standard_daily_hours !== null && standard_daily_hours !== '') {
            numericDailyHours = Number(standard_daily_hours);
            if (!Number.isFinite(numericDailyHours) || numericDailyHours <= 0 || numericDailyHours > 24) {
                throw Object.assign(new Error('Invalid daily hours'), { isOperational: true });
            }
        }

        await connection.query(
            `UPDATE staff_members
             SET full_name = ?, phone_number = ?, position = ?, site_id = ?,
                 hire_date = ?, monthly_salary = ?, standard_daily_hours = ?, paid_leave_types = ?
             WHERE staff_id = ?`,
            [
                full_name || current.full_name,
                phone_number !== undefined ? phone_number : current.phone_number,
                position !== undefined ? position : current.position,
                site_id !== undefined ? (site_id || null) : current.site_id,
                hire_date !== undefined ? (hire_date || null) : current.hire_date,
                numericSalary,
                numericDailyHours,
                paid_leave_types !== undefined ? parsePaidLeaveTypes(paid_leave_types) : current.paid_leave_types,
                id
            ]
        );

        await connection.commit();
        return res.status(200).json({ status: 'success', message: 'Staff member updated successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('UPDATE STAFF ERROR:', error);
        const status = error.isOperational ? 400 : 500;
        return res.status(status).json({
            status: 'error',
            message: error.isOperational ? error.message : 'An error occurred while updating the staff member'
        });
    } finally {
        connection.release();
    }
};

// 4. Toggle staff member status (Active/Inactive)
exports.toggleStaffStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['Active', 'Inactive'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Status must be either Active or Inactive' });
    }

    try {
        const [existing] = await db.query('SELECT staff_id FROM staff_members WHERE staff_id = ? LIMIT 1', [id]);
        if (existing.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Staff member not found' });
        }

        await db.query('UPDATE staff_members SET status = ? WHERE staff_id = ?', [status, id]);

        return res.status(200).json({ status: 'success', message: `Staff member status changed to ${status}` });
    } catch (error) {
        console.error('TOGGLE STAFF STATUS ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while updating staff member status' });
    }
};