const db = require('../config/db');

class AppError extends Error {
    constructor(message) {
        super(message);
        this.isOperational = true;
    }
}

function isValidDateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatToMySqlDateTime(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(String(value));
    if (!match) return null;
    const [, y, mo, d, h, mi, s = '00'] = match;
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${mo}-${d} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}

const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Sick', 'Vacation', 'Holiday'];

// Helper to normalize and clean worker IDs array
function normalizeWorkerIds(workerIds) {
    if (!Array.isArray(workerIds)) return [];
    return [...new Set(workerIds.map(id => Number(id)).filter(id => !isNaN(id) && id > 0))];
}

// Helper to verify user site authorization
async function verifySiteAction(req, siteId) {
    if (req.user && (req.user.role === 'admin' || req.user.role === 'SuperAdmin')) return true;
    return true; 
}

// Helper to verify workers are active and assigned to the specific site
async function verifyBulkWorkers(workerIds, siteId, executor = db) {
    if (workerIds.length === 0) return new Set();
    const placeholders = workerIds.map(() => '?').join(',');
    const [rows] = await executor.execute(
        `SELECT worker_id FROM workers WHERE site_id = ? AND status = 'Active' AND worker_id IN (${placeholders})`,
        [siteId, ...workerIds]
    );
    return new Set(rows.map(r => r.worker_id));
}

// Helper to get the current attendance record ID
async function getAttendanceId(workerId, siteId, recordDate, executor = db, forUpdate = false) {
    const lock = forUpdate ? 'FOR UPDATE' : '';
    const [rows] = await executor.execute(
        `SELECT attendance_id FROM attendance WHERE worker_id = ? AND site_id = ? AND record_date = ? ORDER BY attendance_id DESC LIMIT 1 ${lock}`,
        [workerId, siteId, recordDate]
    );
    return rows.length > 0 ? rows[0].attendance_id : null;
}

async function getStaffByUserId(userId, executor = db) {
    const [rows] = await executor.query(
        `SELECT staff_id, full_name, status, standard_daily_hours, paid_leave_types
         FROM staff_members WHERE user_id = ? LIMIT 1`,
        [userId]
    );
    return rows.length > 0 ? rows[0] : null;
}

// ==================== Self-service (Staff role) ====================

exports.selfMarkAttendance = async (req, res) => {
    try {
        const staff = await getStaffByUserId(req.user.user_id);
        if (!staff) return res.status(404).json({ status: 'error', message: 'No administrative staff record linked to this account.' });
        if (staff.status !== 'Active') return res.status(403).json({ status: 'error', message: 'Your staff account is currently inactive.' });

        const { record_date, attendance_status, check_in_time, check_out_time, remarks } = req.body;

        if (!isValidDateOnly(record_date)) {
            return res.status(400).json({ status: 'error', message: 'Please provide a valid date (YYYY-MM-DD).' });
        }
        if (!ATTENDANCE_STATUSES.includes(attendance_status)) {
            return res.status(400).json({ status: 'error', message: 'Invalid attendance status.' });
        }

        const nowLocal = new Date();
        const year = nowLocal.getFullYear();
        const month = String(nowLocal.getMonth() + 1).padStart(2, '0');
        const day = String(nowLocal.getDate()).padStart(2, '0');
        const today = `${year}-${month}-${day}`;

        if (record_date > today) {
            return res.status(400).json({ status: 'error', message: 'Cannot mark attendance for a future date.' });
        }

        const formattedIn = check_in_time ? formatToMySqlDateTime(check_in_time) : null;
        const formattedOut = check_out_time ? formatToMySqlDateTime(check_out_time) : null;
        if (check_in_time && !formattedIn) return res.status(400).json({ status: 'error', message: 'Invalid check-in time format.' });
        if (check_out_time && !formattedOut) return res.status(400).json({ status: 'error', message: 'Invalid check-out time format.' });

        let regularHours = null;
        let overtimeHours = null;
        if (formattedIn && formattedOut) {
            const start = new Date(formattedIn.replace(' ', 'T'));
            const end = new Date(formattedOut.replace(' ', 'T'));
            if (end <= start) return res.status(400).json({ status: 'error', message: 'Check-out time must be after check-in time.' });
            const totalHours = (end.getTime() - start.getTime()) / 3600000;
            const standardHours = Number(staff.standard_daily_hours || 8);
            regularHours = Math.min(totalHours, standardHours).toFixed(2);
            overtimeHours = Math.max(0, totalHours - standardHours).toFixed(2);
        }

        const [existing] = await db.execute(
            'SELECT staff_attendance_id, status FROM staff_attendance WHERE staff_id = ? AND record_date = ? LIMIT 1',
            [staff.staff_id, record_date]
        );

        if (existing.length > 0) {
            const record = existing[0];
            if (record.status === 'Approved') {
                return res.status(409).json({ status: 'error', message: 'Cannot modify an already approved record.' });
            }
            if (record.status === 'Submitted') {
                return res.status(409).json({ status: 'error', message: 'Record is already pending admin review.' });
            }
            
            await db.execute(
                `UPDATE staff_attendance
                 SET attendance_status = ?, check_in_time = ?, check_out_time = ?,
                     regular_hours = ?, overtime_hours = ?, remarks = ?,
                     recorded_by_user_id = ?, status = 'Submitted',
                     admin_rejection_notes = NULL, approved_by_user_id = NULL, approval_date = NULL
                 WHERE staff_attendance_id = ?`,
                [attendance_status, formattedIn, formattedOut, regularHours, overtimeHours,
                    remarks || null, req.user.user_id, record.staff_attendance_id]
            );
            return res.status(200).json({ status: 'success', message: 'Attendance record updated and submitted for review.' });
        }

        const [result] = await db.execute(
            `INSERT INTO staff_attendance
                (staff_id, record_date, check_in_time, check_out_time, attendance_status,
                 regular_hours, overtime_hours, remarks, recorded_by_user_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted')`,
            [staff.staff_id, record_date, formattedIn, formattedOut, attendance_status,
                regularHours, overtimeHours, remarks || null, req.user.user_id]
        );

        return res.status(201).json({
            status: 'success',
            message: 'Attendance record submitted for review.',
            data: { staff_attendance_id: result.insertId }
        });
    } catch (error) {
        console.error('SELF MARK ATTENDANCE ERROR:', error);
        if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
            return res.status(409).json({ status: 'error', message: 'An attendance record already exists for this date.' });
        }
        return res.status(500).json({ status: 'error', message: 'An error occurred while recording attendance.' });
    }
};

exports.getMyAttendance = async (req, res) => {
    try {
        const staff = await getStaffByUserId(req.user.user_id);
        if (!staff) return res.status(404).json({ status: 'error', message: 'No administrative staff record linked to this account.' });

        const { start_date, end_date } = req.query;
        let query = 'SELECT * FROM staff_attendance WHERE staff_id = ?';
        const params = [staff.staff_id];
        if (isValidDateOnly(start_date) && isValidDateOnly(end_date)) {
            query += ' AND record_date BETWEEN ? AND ?';
            params.push(start_date, end_date);
        }
        query += ' ORDER BY record_date DESC';

        const [rows] = await db.execute(query, params);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('GET MY ATTENDANCE ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while fetching attendance records.' });
    }
};

// ==================== Workers Bulk Attendance (Check-in / Check-out) ====================

exports.runBulkAttendance = async (req, res, mode) => {
    const { site_id, record_date, worker_ids } = req.body;
    const workerIds = normalizeWorkerIds(worker_ids);
    const timeField = mode === 'checkin' ? 'check_in_time' : 'check_out_time';
    const rawTime = req.body[timeField];

    if (!site_id || !isValidDateOnly(record_date) || workerIds.length === 0 || !rawTime) {
        return res.status(400).json({
            status: 'error',
            message: `site_id, record_date, worker_ids, and ${timeField} are required.`
        });
    }

    const formattedTime = formatToMySqlDateTime(rawTime);
    if (!formattedTime) return res.status(400).json({ status: 'error', message: `Invalid ${timeField} format.` });
    
    if (!(await verifySiteAction(req, site_id))) {
        return res.status(403).json({ status: 'error', message: 'You are not authorized to manage this site.' });
    }

    const connection = await db.getConnection();
    const successful = [];
    const failed = [];
    try {
        await connection.beginTransaction();
        const validWorkers = await verifyBulkWorkers(workerIds, site_id, connection);
        
        for (const workerId of workerIds) {
            if (!validWorkers.has(workerId)) {
                failed.push({ worker_id: workerId, message: 'Worker is not active or is not assigned to this site.' });
                continue;
            }

            try {
                if (mode === 'checkin') {
                    const [rows] = await connection.execute(
                        `SELECT attendance_id, attendance_status, check_in_time, check_out_time, status
                         FROM attendance
                         WHERE worker_id = ? AND site_id = ? AND record_date = ?
                         ORDER BY attendance_id DESC LIMIT 1 FOR UPDATE`,
                        [workerId, site_id, record_date]
                    );
                    if (rows.length > 0) {
                        const existing = rows[0];
                        if (existing.status !== 'Draft') throw new AppError('Attendance is already finalized.');
                        if (existing.check_in_time || existing.check_out_time) throw new AppError('Worker is already checked in or checked out.');
                        if (!['Absent', 'Sick', 'Vacation', 'Holiday'].includes(existing.attendance_status)) throw new AppError('Worker already has an attendance record.');
                        
                        const [updated] = await connection.execute(
                            `UPDATE attendance
                             SET check_in_time = ?, attendance_status = 'Present', remarks = NULL
                             WHERE attendance_id = ? AND status = 'Draft'
                               AND check_in_time IS NULL AND check_out_time IS NULL`,
                            [formattedTime, existing.attendance_id]
                        );
                        if (updated.affectedRows !== 1) throw new AppError('Attendance changed by another request.');
                        
                        await connection.execute(
                            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                             VALUES ('attendance', ?, 'CHECK_IN', ?, ?, ?)`,
                            [existing.attendance_id, req.user.user_id, JSON.stringify({ attendance_status: existing.attendance_status }), JSON.stringify({ check_in_time: formattedTime, attendance_status: 'Present', source: 'bulk' })]
                        );
                        successful.push(workerId);
                    } else {
                        const [inserted] = await connection.execute(
                            `INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, attendance_status, status, recorded_by_user_id)
                             VALUES (?, ?, ?, ?, 'Present', 'Draft', ?)`,
                            [workerId, site_id, record_date, formattedTime, req.user.user_id]
                        );
                        await connection.execute(
                            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                             VALUES ('attendance', ?, 'CHECK_IN', ?, NULL, ?)`,
                            [inserted.insertId, req.user.user_id, JSON.stringify({ check_in_time: formattedTime, source: 'bulk' })]
                        );
                        successful.push(workerId);
                    }
                } else {
                    const attendanceId = await getAttendanceId(workerId, site_id, record_date, connection, true);
                    if (!attendanceId) throw new AppError('No open check-in found for this worker.');
                    
                    const [[attendance]] = await connection.execute(
                        `SELECT check_in_time, check_out_time FROM attendance WHERE attendance_id = ? FOR UPDATE`,
                        [attendanceId]
                    );
                    if (!attendance || attendance.check_out_time) throw new AppError('Worker is already checked out.');
                    
                    const [[openLeave]] = await connection.execute(
                        `SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1 FOR UPDATE`,
                        [attendanceId]
                    );
                    if (openLeave) throw new AppError('Worker has an open break.');
                    
                    const [updated] = await connection.execute(
                        `UPDATE attendance SET check_out_time = ?, attendance_status = 'Present'
                         WHERE attendance_id = ? AND status = 'Draft' AND check_out_time IS NULL`,
                        [formattedTime, attendanceId]
                    );
                    if (updated.affectedRows !== 1) throw new AppError('Attendance changed by another request.');

                    await connection.execute(
                        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                         VALUES ('attendance', ?, 'CHECK_OUT', ?, ?, ?)`,
                        [attendanceId, req.user.user_id, JSON.stringify({ check_out_time: null }), JSON.stringify({ check_out_time: formattedTime, source: 'bulk' })]
                    );
                    successful.push(workerId);
                }
            } catch (error) {
                if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
                    failed.push({ worker_id: workerId, message: 'Attendance already exists for this date.' });
                } else {
                    failed.push({ worker_id: workerId, message: error.isOperational ? error.message : 'Bulk operation failed.' });
                }
            }
        }
        await connection.commit();
        const responseStatus = successful.length === workerIds.length ? 'success' : successful.length > 0 ? 'partial_success' : 'error';
        return res.status(responseStatus === 'error' ? 409 : 200).json({ status: responseStatus, successful, failed });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        console.error(`BULK ${mode.toUpperCase()} ERROR:`, error);
        return res.status(error.isOperational ? 400 : 500).json({ status: 'error', message: error.isOperational ? error.message : `Bulk ${mode} failed.` });
    } finally {
        connection.release();
    }
};

exports.bulkCheckIn = (req, res) => exports.runBulkAttendance(req, res, 'checkin');
exports.bulkCheckOut = (req, res) => exports.runBulkAttendance(req, res, 'checkout');

// ==================== Admin review ====================

exports.getPendingStaffAttendance = async (req, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT sa.*, sm.full_name, sm.staff_unique_id, s.site_name
             FROM staff_attendance sa
             JOIN staff_members sm ON sm.staff_id = sa.staff_id
             LEFT JOIN sites s ON s.site_id = sm.site_id
             WHERE sa.status IN ('Submitted', 'Rejected')
             ORDER BY sa.record_date DESC`
        );
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('GET PENDING STAFF ATTENDANCE ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while fetching pending records.' });
    }
};

exports.reviewStaffAttendance = async (req, res) => {
    const { staff_attendance_id, status, admin_note, is_paid } = req.body;
    const adminId = req.user.user_id;

    if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Status must be Approved or Rejected.' });
    }
    if (status === 'Rejected' && (!admin_note || !String(admin_note).trim())) {
        return res.status(400).json({ status: 'error', message: 'Rejection reason is required.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            'SELECT * FROM staff_attendance WHERE staff_attendance_id = ? FOR UPDATE',
            [staff_attendance_id]
        );
        if (rows.length === 0) throw new AppError('Record not found.');
        const record = rows[0];
        if (record.status !== 'Submitted') throw new AppError('Cannot review a record that is not in pending status.');

        const resolvedIsPaid = (is_paid === 0 || is_paid === 1) ? is_paid : record.is_paid;

        await connection.execute(
            `UPDATE staff_attendance
             SET status = ?, admin_rejection_notes = ?, approved_by_user_id = ?, approval_date = NOW(), is_paid = ?
             WHERE staff_attendance_id = ?`,
            [status, status === 'Rejected' ? admin_note : null, adminId, resolvedIsPaid, staff_attendance_id]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('staff_attendance', ?, ?, ?, ?, ?)`,
            [staff_attendance_id, status.toUpperCase(), adminId, JSON.stringify(record), JSON.stringify({ status, admin_note, is_paid: resolvedIsPaid })]
        );

        await connection.commit();
        return res.status(200).json({ status: 'success', message: 'Request processed successfully.' });
    } catch (error) {
        await connection.rollback();
        console.error('REVIEW STAFF ATTENDANCE ERROR:', error);
        const httpStatus = error.isOperational ? 400 : 500;
        return res.status(httpStatus).json({
            status: 'error',
            message: error.isOperational ? error.message : 'An error occurred while reviewing the record.'
        });
    } finally {
        connection.release();
    }
};

exports.getStaffAttendanceByDate = async (req, res) => {
    const { date } = req.query;
    if (!isValidDateOnly(date)) return res.status(400).json({ status: 'error', message: 'Please provide a valid date.' });
    try {
        const [rows] = await db.execute(
            `SELECT sa.*, sm.full_name, sm.staff_unique_id, s.site_name
             FROM staff_attendance sa
             JOIN staff_members sm ON sm.staff_id = sa.staff_id
             LEFT JOIN sites s ON s.site_id = sm.site_id
             WHERE sa.record_date = ?
             ORDER BY sm.full_name`,
            [date]
        );
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('GET STAFF ATTENDANCE BY DATE ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while fetching records.' });
    }
};

exports.getStaffByUserId = getStaffByUserId;