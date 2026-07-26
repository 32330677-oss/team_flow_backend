const db = require('../config/db');
const attendanceService = require('../services/attendanceService');

// "Safe" intentional error (a message that can be shown to the user directly),
// used to distinguish it from any unexpected internal error (SQL, etc.)
// so we never leak database structure details when an unexpected error occurs.
class AppError extends Error {
    constructor(message) {
        super(message);
        this.isOperational = true;
    }
}

// Leave types that a Supervisor is allowed to set from the field (this screen).
// 'Management' is intentionally excluded here — it is only ever set by an
// Admin through the separate `/attendance/:attendance_id/management-leave` route.
const SUPERVISOR_ALLOWED_LEAVE_TYPES = ['Rest', 'Sick', 'Annual'];

// Helper: fetch the active attendance_id for today for a given worker/site.
async function getAttendanceId(worker_id, site_id) {
    const [rows] = await db.execute(
        'SELECT attendance_id FROM attendance WHERE worker_id = ? AND site_id = ? AND record_date = CURDATE()',
        [worker_id, site_id]
    );
    return rows.length > 0 ? rows[0].attendance_id : null;
}

// Helper: verify that the given supervisor actually owns/is assigned to the given site.
// Used to prevent a supervisor from checking-in/checking-out/viewing workers
// at a site that isn't theirs.
async function verifySupervisorSite(userId, siteId) {
    const [rows] = await db.execute(
        'SELECT 1 FROM sites WHERE site_id = ? AND supervisor_id = ? LIMIT 1',
        [siteId, userId]
    );
    return rows.length > 0;
}

// -------------------------------------------------------------------
// Get all active workers assigned to a site who either have no attendance
// record yet today, or whose record is still in 'Draft' status.
// Includes a security check: a Supervisor can only view workers of a site
// that is actually assigned to them. Admins bypass this check.
// -------------------------------------------------------------------
exports.getSiteWorkers = async (req, res) => {
    try {
        const { siteId } = req.params;
        const supervisor_id = req.user.user_id;

        if (req.user.role !== 'Admin') {
            const isAuthorized = await verifySupervisorSite(supervisor_id, siteId);
            if (!isAuthorized) {
                return res.status(403).json({ status: 'error', message: 'You are not authorized to access this site\'s data.' });
            }
        }

        const query = `
            SELECT w.*, a.attendance_id, a.status as attendance_status,
            (SELECT leave_id FROM attendanceleaveperiods alp 
             WHERE alp.attendance_id = a.attendance_id AND alp.leave_end_time IS NULL 
             LIMIT 1) as current_leave_id
            FROM workers w
            JOIN workersiteassignments wsa ON w.worker_id = wsa.worker_id
            LEFT JOIN attendance a ON w.worker_id = a.worker_id 
                AND a.record_date = CURDATE()
            WHERE wsa.site_id = ? 
            AND wsa.unassigned_date IS NULL 
            AND w.status = 'Active'
            -- Only fetch workers who have no record yet, or whose record is still a Draft
            AND (a.attendance_id IS NULL OR a.status = 'Draft')
        `;

        const [workers] = await db.execute(query, [siteId]);
        res.status(200).json({ status: 'success', data: workers });
    } catch (error) {
        console.error("SQL ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while fetching worker data, please try again.' });
    }
};

// -------------------------------------------------------------------
// Check a worker in (creates a Draft attendance record for today).
// Includes the same site-ownership security check as getSiteWorkers.
// -------------------------------------------------------------------
exports.checkIn = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;
        const recorded_by_user_id = req.user.user_id;

        if (req.user.role !== 'Admin') {
            const isAuthorized = await verifySupervisorSite(recorded_by_user_id, site_id);
            if (!isAuthorized) {
                return res.status(403).json({ status: 'error', message: 'You are not authorized to record attendance at this site.' });
            }
        }

        await db.execute(
            `INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, status, recorded_by_user_id) 
             VALUES (?, ?, CURDATE(), NOW(), 'Draft', ?)`,
            [worker_id, site_id, recorded_by_user_id]
        );
        res.status(201).json({ status: 'success', message: 'Check-in recorded successfully' });
    } catch (error) {
        console.error("CHECK-IN ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while recording check-in, please try again.' });
    }
};

// -------------------------------------------------------------------
// Check a worker out (sets check_out_time on today's active record).
// Includes the same site-ownership security check as getSiteWorkers.
// -------------------------------------------------------------------
exports.checkOut = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;
        const supervisor_id = req.user.user_id;

        if (req.user.role !== 'Admin') {
            const isAuthorized = await verifySupervisorSite(supervisor_id, site_id);
            if (!isAuthorized) {
                return res.status(403).json({ status: 'error', message: 'You are not authorized to perform this action at the specified site.' });
            }
        }

        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) return res.status(404).json({ status: 'error', message: 'Attendance record not found!' });

        await db.execute('UPDATE attendance SET check_out_time = NOW() WHERE attendance_id = ?', [att_id]);
        res.status(200).json({ status: 'success', message: 'Check-out recorded successfully.' });
    } catch (error) {
        console.error("CHECK-OUT ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred during check-out, please try again.' });
    }
};

// -------------------------------------------------------------------
// Submit the day: converts all 'Draft' records for the site into
// 'Submitted', triggering the working-hours calculation for each.
// -------------------------------------------------------------------
exports.submitDay = async (req, res) => {
    try {
        const { siteId } = req.body;
        const [records] = await db.execute(
            'SELECT attendance_id FROM attendance WHERE site_id = ? AND record_date = CURDATE() AND status = "Draft"',
            [siteId]
        );

        for (let record of records) {
            await attendanceService.calculateWorkingHours(record.attendance_id);
            await db.execute('UPDATE attendance SET status = "Submitted" WHERE attendance_id = ?', [record.attendance_id]);
        }
        res.status(200).json({ status: 'success', message: 'Day submitted for review successfully' });
    } catch (error) {
        console.error("SUBMIT DAY ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while submitting the day, please try again.' });
    }
};

// -------------------------------------------------------------------
// Fetch rejected records for the currently logged-in supervisor.
// -------------------------------------------------------------------
exports.getRejectedRecords = async (req, res) => {
    try {
        const supervisor_id = req.user.user_id;
        const [rows] = await db.execute(
            `SELECT a.*, w.full_name, s.site_name 
             FROM attendance a
             JOIN workers w ON a.worker_id = w.worker_id
             JOIN sites s ON a.site_id = s.site_id
             WHERE a.status = 'Rejected' AND a.recorded_by_user_id = ?
             ORDER BY s.site_name, a.record_date DESC, w.full_name`,
            [supervisor_id]
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("GET REJECTED ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while fetching rejected records, please try again.' });
    }
};

// -------------------------------------------------------------------
// Start a break/leave period for a worker.
// SECURITY / VALIDATION: only Rest, Sick, and Annual are accepted from
// this field-facing endpoint. 'Management' (and any other unexpected
// value) is rejected outright — that type can ONLY be set by an Admin
// through the dedicated setManagementLeaveHours endpoint below.
// -------------------------------------------------------------------
exports.startLeave = async (req, res) => {
    try {
        const { worker_id, site_id, leave_type } = req.body;

        if (!SUPERVISOR_ALLOWED_LEAVE_TYPES.includes(leave_type)) {
            return res.status(400).json({
                status: 'error',
                message: `Invalid leave type. Allowed values are: ${SUPERVISOR_ALLOWED_LEAVE_TYPES.join(', ')}.`
            });
        }

        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) return res.status(404).json({ status: 'error', message: 'No active attendance record found!' });

        await db.execute(
            'INSERT INTO attendanceleaveperiods (attendance_id, leave_start_time, leave_type) VALUES (?, NOW(), ?)',
            [att_id, leave_type]
        );
        res.status(200).json({ status: 'success', message: 'Leave/break started successfully' });
    } catch (error) {
        console.error("START LEAVE ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while starting the break, please try again.' });
    }
};

// -------------------------------------------------------------------
// End the currently active break/leave period for a worker.
// -------------------------------------------------------------------
exports.endLeave = async (req, res) => {
    try {
        const { worker_id, site_id } = req.body;
        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) return res.status(404).json({ status: 'error', message: 'Attendance record not found!' });

        const [result] = await db.execute(
            `UPDATE attendanceleaveperiods SET leave_end_time = NOW() 
             WHERE attendance_id = ? AND leave_end_time IS NULL ORDER BY leave_id DESC LIMIT 1`,
            [att_id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ status: 'error', message: 'No active break found!' });

        res.status(200).json({ status: 'success', message: 'Break ended successfully' });
    } catch (error) {
        console.error("END LEAVE ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while ending the break, please try again.' });
    }
};

// -------------------------------------------------------------------
// Admin-only: set management leave hours (administrative allowance)
// for a specific attendance record. This is the ONLY place 'Management'
// hours can be set — never through startLeave/leave_type.
// -------------------------------------------------------------------
exports.setManagementLeaveHours = async (req, res) => {
    const { attendance_id } = req.params;
    const { hours, reason } = req.body;
    const adminId = req.user.user_id;

    if (hours === undefined || Number(hours) < 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid hours value' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute('SELECT * FROM attendance WHERE attendance_id = ?', [attendance_id]);
        if (rows.length === 0) throw new AppError('Record not found');
        const oldRecord = rows[0];

        await connection.execute(
            'UPDATE attendance SET management_leave_hours = ? WHERE attendance_id = ?',
            [hours, attendance_id]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'MANAGEMENT_LEAVE', ?, ?, ?)`,
            [attendance_id, adminId, JSON.stringify(oldRecord), JSON.stringify({ management_leave_hours: hours, reason })]
        );

        // Recalculate hours if the record is already complete (has a check-out time).
        if (oldRecord.check_out_time) {
            await attendanceService.calculateWorkingHours(attendance_id);
        }

        await connection.commit();
        res.status(200).json({ status: 'success', message: 'Management leave hours recorded successfully' });
    } catch (error) {
        await connection.rollback();
        console.error("MANAGEMENT LEAVE ERROR:", error);
        const message = error.isOperational ? error.message : 'An error occurred while recording management leave hours.';
        res.status(400).json({ status: 'error', message });
    } finally {
        connection.release();
    }
};

// -------------------------------------------------------------------
// Resubmit a previously Rejected attendance record after corrections.
// Converts Flutter's ISO datetime strings into MySQL DATETIME format
// before the UPDATE, since MySQL rejects the raw ISO format
// (e.g. 2026-07-16T09:11:29.000Z) with an "Incorrect datetime value" error.
// -------------------------------------------------------------------
exports.resubmitAttendance = async (req, res) => {
    const { attendance_id } = req.params;
    const { check_in_time, check_out_time, remarks } = req.body;
    const supervisor_id = req.user.user_id;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [records] = await connection.execute(
            'SELECT * FROM attendance WHERE attendance_id = ? AND status = "Rejected" AND recorded_by_user_id = ?',
            [attendance_id, supervisor_id]
        );

        if (records.length === 0) throw new AppError('Record not found or you are not allowed to edit it');

        const oldRecord = records[0];

        const formattedCheckIn = check_in_time
            ? new Date(check_in_time).toISOString().slice(0, 19).replace('T', ' ')
            : null;

        const formattedCheckOut = check_out_time
            ? new Date(check_out_time).toISOString().slice(0, 19).replace('T', ' ')
            : null;

        // Logical check: check-out time must be after check-in time.
        if (formattedCheckIn && formattedCheckOut && new Date(check_out_time) <= new Date(check_in_time)) {
            throw new AppError('Check-out time must be after check-in time');
        }

        await connection.execute(
            `UPDATE attendance SET check_in_time = ?, check_out_time = ?, remarks = ?, status = 'Submitted', updated_at = NOW() WHERE attendance_id = ?`,
            [formattedCheckIn, formattedCheckOut, remarks, attendance_id]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values) VALUES (?, ?, ?, ?, ?, ?)`,
            ['attendance', attendance_id, 'RESUBMIT', supervisor_id, JSON.stringify(oldRecord), JSON.stringify({ check_in_time: formattedCheckIn, check_out_time: formattedCheckOut, remarks, status: 'Submitted' })]
        );

        await connection.commit();
        res.status(200).json({ status: 'success', message: 'Resubmitted successfully' });
    } catch (error) {
        await connection.rollback();
        console.error("RESUBMIT ERROR:", error);
        // "Operational" (expected/safe) errors show their own message directly
        // (e.g. record not found, invalid time order). Any other error (SQL, etc.)
        // shows a generic message to avoid leaking database details.
        const message = error.isOperational
            ? error.message
            : 'An error occurred while resubmitting, please try again.';
        res.status(400).json({ status: 'error', message });
    } finally {
        connection.release();
    }
};