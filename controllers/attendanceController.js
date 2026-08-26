const db = require('../config/db');
const attendanceService = require('../services/attendanceService');

class AppError extends Error {
    constructor(message) {
        super(message);
        this.isOperational = true;
    }
}

const SUPERVISOR_ALLOWED_LEAVE_TYPES = ['Rest', 'Sick', 'Annual', 'Lunch'];

// -------------------------------------------------------------------
// FIXED: Previously this ran the value through `new Date(...).toISOString()`,
// which re-interprets/re-emits the datetime using the Node server's own
// timezone. Since the Flutter side now sends a literal wall-clock string
// with NO timezone marker (e.g. "2026-08-25T11:00:00.000" for 11 AM Syria
// time as picked by the Supervisor), running it through Date/toISOString
// could shift the hour depending on the server's timezone setting — this
// was the root cause of "picked 11, saved as 8" (a 3-hour UTC shift).
//
// The fix: extract the date/time components directly via regex, with NO
// timezone reinterpretation at all. Whatever wall-clock time the
// Supervisor picked is exactly what gets stored.
// -------------------------------------------------------------------
function formatToMySqlDateTime(isoString) {
    if (!isoString) return null;
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(isoString));
    if (!match) return null;
    const [, datePart, hh, mm, ss] = match;
    return `${datePart} ${hh}:${mm}:${ss || '00'}`;
}

// Helper: fetch the active attendance_id for today for a given worker/site.
async function getAttendanceId(worker_id, site_id) {
    const [rows] = await db.execute(
        `SELECT attendance_id FROM attendance 
         WHERE worker_id = ? AND site_id = ? AND check_in_time IS NOT NULL AND check_out_time IS NULL AND status = 'Draft'
         ORDER BY attendance_id DESC LIMIT 1`,
        [worker_id, site_id]
    );
    return rows.length > 0 ? rows[0].attendance_id : null;
}

async function verifySupervisorSite(userId, siteId) {
    const [rows] = await db.execute(
        'SELECT 1 FROM sites WHERE site_id = ? AND supervisor_id = ? LIMIT 1',
        [siteId, userId]
    );
    return rows.length > 0;
}

async function verifyWorkerAssignedToSite(workerId, siteId) {
    const [rows] = await db.execute(
        `SELECT 1
         FROM workersiteassignments wsa
         JOIN workers w ON w.worker_id = wsa.worker_id
         WHERE wsa.worker_id = ?
           AND wsa.site_id = ?
           AND wsa.unassigned_date IS NULL
           AND w.status = 'Active'
         LIMIT 1`,
        [workerId, siteId]
    );
    return rows.length > 0;
}

async function verifySiteAction(req, siteId) {
    if (req.user.role === 'Admin') return true;
    return verifySupervisorSite(req.user.user_id, siteId);
}

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
            SELECT w.*,
                   a.attendance_id,
                   a.status AS workflow_status,
                   a.attendance_status,
                   a.check_in_time,
                   a.check_out_time,
                   a.remarks AS attendance_remarks,
                   (SELECT leave_id
                    FROM attendanceleaveperiods alp
                    WHERE alp.attendance_id = a.attendance_id
                      AND alp.leave_end_time IS NULL
                    ORDER BY alp.leave_id DESC
                    LIMIT 1) AS current_leave_id
            FROM workers w
            JOIN workersiteassignments wsa ON w.worker_id = wsa.worker_id
            LEFT JOIN attendance a ON w.worker_id = a.worker_id
                AND a.site_id = ?
                AND (a.record_date = CURDATE()
                     OR (a.status = 'Draft' AND a.check_in_time IS NOT NULL AND a.check_out_time IS NULL))
            WHERE wsa.site_id = ? 
            AND wsa.unassigned_date IS NULL 
            AND w.status = 'Active'
            AND (a.attendance_id IS NULL OR a.record_date = CURDATE()
                 OR (a.status = 'Draft' AND a.check_in_time IS NOT NULL AND a.check_out_time IS NULL))
        `;

        const [workers] = await db.execute(query, [siteId, siteId]);
        res.status(200).json({ status: 'success', data: workers });
    } catch (error) {
        console.error("SQL ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while fetching worker data, please try again.' });
    }
};

exports.checkIn = async (req, res) => {
    try {
        const { worker_id, site_id, check_in_time } = req.body;
        const recorded_by_user_id = req.user.user_id;

        if (!worker_id || !site_id) {
            return res.status(400).json({ status: 'error', message: 'Worker and site are required.' });
        }
        if (!check_in_time) {
            return res.status(400).json({ status: 'error', message: 'Check-in time is required.' });
        }

        const formattedCheckIn = formatToMySqlDateTime(check_in_time);
        if (!formattedCheckIn) {
            return res.status(400).json({ status: 'error', message: 'Invalid check-in time format.' });
        }

        if (!(await verifySiteAction(req, site_id))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to record attendance at this site.' });
        }
        if (!(await verifyWorkerAssignedToSite(worker_id, site_id))) {
            return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site.' });
        }

        const [existingToday] = await db.execute(
            `SELECT attendance_id, attendance_status, check_in_time, check_out_time, status
             FROM attendance
             WHERE worker_id = ? AND site_id = ? AND record_date = CURDATE()
             ORDER BY attendance_id DESC
             LIMIT 1`,
            [worker_id, site_id]
        );
        if (existingToday.length > 0) {
            const existing = existingToday[0];
            if (existing.status === 'Rejected') {
                return res.status(409).json({
                    status: 'error',
                    message: 'This attendance record was rejected. Open Rejected Records and resubmit it.'
                });
            }
            if (existing.status !== 'Draft') {
                return res.status(409).json({ status: 'error', message: 'Worker already has a finalized attendance record for today.' });
            }
            if (existing.attendance_status === 'Absent' && !existing.check_in_time && !existing.check_out_time) {
                const connection = await db.getConnection();
                try {
                    await connection.beginTransaction();
                    await connection.execute(
                        `UPDATE attendance
                         SET check_in_time = ?, attendance_status = 'Present', remarks = NULL
                         WHERE attendance_id = ? AND status = 'Draft'`,
                        [formattedCheckIn, existing.attendance_id]
                    );
                    await connection.execute(
                        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                         VALUES ('attendance', ?, 'CHECK_IN', ?, ?, ?)`,
                        [existing.attendance_id, recorded_by_user_id, JSON.stringify({ attendance_status: 'Absent' }), JSON.stringify({ check_in_time: formattedCheckIn, attendance_status: 'Present' })]
                    );
                    await connection.commit();
                    return res.status(200).json({
                        status: 'success',
                        message: 'Check-in recorded successfully',
                        data: { attendance_id: existing.attendance_id, check_in_time: formattedCheckIn, attendance_status: 'Present' }
                    });
                } catch (error) {
                    await connection.rollback();
                    throw error;
                } finally {
                    connection.release();
                }
            }
            return res.status(409).json({ status: 'error', message: 'Worker already has an attendance record for today.' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [result] = await connection.execute(
                `INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, status, recorded_by_user_id) 
                 VALUES (?, ?, CURDATE(), ?, 'Draft', ?)`,
                [worker_id, site_id, formattedCheckIn, recorded_by_user_id]
            );

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendance', ?, 'CHECK_IN', ?, NULL, ?)`,
                [result.insertId, recorded_by_user_id, JSON.stringify({ check_in_time: formattedCheckIn })]
            );

            await connection.commit();
            res.status(201).json({
                status: 'success',
                message: 'Check-in recorded successfully',
                data: { attendance_id: result.insertId, check_in_time: formattedCheckIn, attendance_status: 'Present' }
            });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("CHECK-IN ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while recording check-in, please try again.' });
    }
};

exports.setAttendanceStatus = async (req, res) => {
    const { worker_id, site_id, attendance_status, remarks } = req.body;
    const allowedStatuses = ['Absent', 'Sick', 'Annual', 'Holiday'];
    const recordedByUserId = req.user.user_id;

    try {
        if (!worker_id || !site_id || !attendance_status) {
            return res.status(400).json({ status: 'error', message: 'Worker, site, and attendance status are required.' });
        }
        if (!allowedStatuses.includes(attendance_status)) {
            return res.status(400).json({ status: 'error', message: 'Invalid attendance status.' });
        }
        if (!(await verifySiteAction(req, site_id))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to update this site.' });
        }
        if (!(await verifyWorkerAssignedToSite(worker_id, site_id))) {
            return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site.' });
        }

        const [existingRows] = await db.execute(
            `SELECT attendance_id, status, attendance_status
             FROM attendance
             WHERE worker_id = ? AND site_id = ? AND record_date = CURDATE()
             ORDER BY attendance_id DESC LIMIT 1`,
            [worker_id, site_id]
        );

        if (existingRows.length > 0) {
            const existing = existingRows[0];
            if (existing.status !== 'Draft') {
                return res.status(409).json({ status: 'error', message: 'Attendance cannot be changed after it has been submitted.' });
            }

            await db.execute(
                `UPDATE attendance
                 SET attendance_status = ?, remarks = ?, recorded_by_user_id = ?
                 WHERE attendance_id = ? AND status = 'Draft'`,
                [attendance_status, remarks || `${attendance_status} - recorded by supervisor`, recordedByUserId, existing.attendance_id]
            );

            await db.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendance', ?, 'STATUS_UPDATED', ?, ?, ?)`,
                [
                    existing.attendance_id,
                    recordedByUserId,
                    JSON.stringify({ attendance_status: existing.attendance_status }),
                    JSON.stringify({ attendance_status, remarks: remarks || null })
                ]
            );

            return res.status(200).json({ status: 'success', message: 'Attendance status updated successfully.' });
        }

        const [inserted] = await db.execute(
            `INSERT INTO attendance
                (worker_id, site_id, record_date, attendance_status, status, recorded_by_user_id, remarks)
             VALUES (?, ?, CURDATE(), ?, 'Draft', ?, ?)`,
            [worker_id, site_id, attendance_status, recordedByUserId, remarks || `${attendance_status} - recorded by supervisor`]
        );

        await db.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'STATUS_CREATED', ?, NULL, ?)`,
            [inserted.insertId, recordedByUserId, JSON.stringify({ attendance_status, remarks: remarks || null })]
        );

        return res.status(201).json({ status: 'success', message: 'Attendance status recorded successfully.' });
    } catch (error) {
        console.error('SET ATTENDANCE STATUS ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while saving attendance status.' });
    }
};

exports.checkOut = async (req, res) => {
    try {
        const { worker_id, site_id, check_out_time } = req.body;
        const supervisor_id = req.user.user_id;

        if (!worker_id || !site_id) {
            return res.status(400).json({ status: 'error', message: 'Worker and site are required.' });
        }
        if (!check_out_time) {
            return res.status(400).json({ status: 'error', message: 'Check-out time is required.' });
        }

        const formattedCheckOut = formatToMySqlDateTime(check_out_time);
        if (!formattedCheckOut) {
            return res.status(400).json({ status: 'error', message: 'Invalid check-out time format.' });
        }

        if (!(await verifySiteAction(req, site_id))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to perform this action at the specified site.' });
        }
        if (!(await verifyWorkerAssignedToSite(worker_id, site_id))) {
            return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site.' });
        }

        const [rows] = await db.execute(
            `SELECT attendance_id, check_in_time, attendance_status, status FROM attendance
             WHERE worker_id = ? AND site_id = ?
               AND check_in_time IS NOT NULL AND check_out_time IS NULL AND status = 'Draft' 
             ORDER BY attendance_id DESC LIMIT 1`,
            [worker_id, site_id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Attendance record not found!' });
        }

        const att_id = rows[0].attendance_id;
        const existingCheckIn = rows[0].check_in_time;

        const checkInDate = parseAttendanceDate(existingCheckIn);
        const checkOutDate = parseAttendanceDate(formattedCheckOut);
        if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) {
            return res.status(400).json({ status: 'error', message: 'Check-out time must be after check-in time.' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [openLeaves] = await connection.execute(
                `SELECT leave_id FROM attendanceleaveperiods
                 WHERE attendance_id = ? AND leave_end_time IS NULL
                 LIMIT 1`,
                [att_id]
            );
            if (openLeaves.length > 0) {
                throw new AppError('End the active break before checking out.');
            }

            await connection.execute(
                'UPDATE attendance SET check_out_time = ? WHERE attendance_id = ? AND status = \'Draft\'',
                [formattedCheckOut, att_id]
            );

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendance', ?, 'CHECK_OUT', ?, ?, ?)`,
                [
                    att_id,
                    supervisor_id,
                    JSON.stringify({ check_in_time: existingCheckIn }),
                    JSON.stringify({ check_out_time: formattedCheckOut })
                ]
            );

            await connection.commit();
            res.status(200).json({
                status: 'success',
                message: 'Check-out recorded successfully.',
                data: { attendance_id: att_id, check_out_time: formattedCheckOut }
            });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("CHECK-OUT ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred during check-out, please try again.' });
    }
};


function normalizeTimeForDate(value, date) {
    if (!value) return null;
    const text = String(value);
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(text)) {
        return `${date} ${text.length === 5 ? text + ':00' : text}`;
    }
    return formatToMySqlDateTime(text);
}

function parseAttendanceDate(value) {
    if (!value) return null;
    const normalized = String(value).replace(' ', 'T');
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function timeToMinutes(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.getHours() * 60 + value.getMinutes();
    }
    const text = String(value);
    const match = /(?:^|T| )((?:[01]\d|2[0-3])):([0-5]\d)(?::[0-5]\d)?/.exec(text);
    if (match) return Number(match[1]) * 60 + Number(match[2]);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.getHours() * 60 + parsed.getMinutes();
    }
    return null;
}

exports.saveLunchBulk = async (req, res) => {
    const { siteId, date, default_start_time, default_end_time, overrides = {} } = req.body;
    const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : null;
    const safeOverrides = overrides && typeof overrides === 'object' ? overrides : {};
    const hasOverrides = Object.keys(safeOverrides).length > 0;
    if (!siteId || !selectedDate) {
        return res.status(400).json({ status: 'error', message: 'siteId and date are required.' });
    }
    if (!hasOverrides && (!default_start_time || !default_end_time)) {
        return res.status(400).json({ status: 'error', message: 'Provide a default lunch time or worker-specific times.' });
    }

    try {
        if (!(await verifySiteAction(req, siteId))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to manage this site.' });
        }

        const defaultStart = default_start_time ? normalizeTimeForDate(default_start_time, selectedDate) : null;
        const defaultEnd = default_end_time ? normalizeTimeForDate(default_end_time, selectedDate) : null;
        if ((default_start_time && !defaultStart) || (default_end_time && !defaultEnd)) {
            return res.status(400).json({ status: 'error', message: 'Invalid default lunch time format.' });
        }

        const [records] = await db.execute(
            `SELECT a.attendance_id, a.worker_id, a.check_in_time, a.check_out_time
             FROM attendance a
             JOIN workers w ON w.worker_id = a.worker_id
             JOIN workersiteassignments wsa ON wsa.worker_id = a.worker_id AND wsa.site_id = a.site_id
             WHERE a.site_id = ? AND a.record_date = ? AND a.status = 'Draft'
               AND w.status = 'Active' AND wsa.unassigned_date IS NULL
               AND a.check_in_time IS NOT NULL AND a.check_out_time IS NOT NULL`,
            [siteId, selectedDate]
        );
            if (records.length === 0) {
            return res.status(400).json({ status: 'error', message: 'No completed attendance records found for this date.' });
        }

        const recordsToUpdate = records.filter((record) => {
            const override = safeOverrides[String(record.worker_id)] || safeOverrides[record.worker_id] || {};
            return Boolean((override.start_time || default_start_time) && (override.end_time || default_end_time));
        });
        if (recordsToUpdate.length === 0) {
            return res.status(400).json({ status: 'error', message: 'Set lunch time for at least one worker or provide a default lunch time.' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            for (const record of recordsToUpdate) {
                const override = safeOverrides[String(record.worker_id)] || safeOverrides[record.worker_id] || {};
                const rawStart = override.start_time || default_start_time;
                const rawEnd = override.end_time || default_end_time;
                if (!rawStart || !rawEnd) continue;
                const start = normalizeTimeForDate(rawStart, selectedDate);
                const end = normalizeTimeForDate(rawEnd, selectedDate);
                const checkIn = timeToMinutes(record.check_in_time);
                const checkOut = timeToMinutes(record.check_out_time);
                const lunchStart = timeToMinutes(start);
                const lunchEnd = timeToMinutes(end);
                if ([checkIn, checkOut, lunchStart, lunchEnd].some(v => v === null)) {
                    throw new AppError(`Invalid time for worker ${record.worker_id}`);
                }
                if (lunchEnd <= lunchStart) throw new AppError(`Lunch end must be after lunch start for worker ${record.worker_id}`);
                if (lunchStart < checkIn || lunchEnd > checkOut) {
                    throw new AppError(`Lunch must be between check-in and check-out for worker ${record.worker_id}`);
                }

                const [existing] = await connection.execute(
                    `SELECT leave_id FROM attendanceleaveperiods
                     WHERE attendance_id = ? AND leave_type = 'Lunch'
                     ORDER BY leave_id DESC LIMIT 1`,
                    [record.attendance_id]
                );
                if (existing.length > 0) {
                    await connection.execute(
                        `UPDATE attendanceleaveperiods
                         SET leave_start_time = ?, leave_end_time = ?
                         WHERE leave_id = ?`,
                        [start, end, existing[0].leave_id]
                    );
                    await connection.execute(
                        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                         VALUES ('attendanceleaveperiods', ?, 'LUNCH_BULK_UPDATE', ?, ?, ?)`,
                        [existing[0].leave_id, req.user.user_id, JSON.stringify({ attendance_id: record.attendance_id }), JSON.stringify({ leave_start_time: start, leave_end_time: end })]
                    );
                } else {
                    const [result] = await connection.execute(
                        `INSERT INTO attendanceleaveperiods
                         (attendance_id, leave_start_time, leave_end_time, leave_type)
                         VALUES (?, ?, ?, 'Lunch')`,
                        [record.attendance_id, start, end]
                    );
                    await connection.execute(
                        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                         VALUES ('attendanceleaveperiods', ?, 'LUNCH_BULK_CREATE', ?, NULL, ?)`,
                        [result.insertId, req.user.user_id, JSON.stringify({ attendance_id: record.attendance_id, leave_start_time: start, leave_end_time: end, leave_type: 'Lunch' })]
                    );
                }
            }
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

        for (const record of recordsToUpdate) {
            await attendanceService.calculateWorkingHours(record.attendance_id);
        }
        return res.status(200).json({ status: 'success', message: 'Lunch times saved successfully.', updated_records: recordsToUpdate.length });
    } catch (error) {
        console.error('SAVE BULK LUNCH ERROR:', error);
        const status = error.isOperational ? 400 : 500;
        return res.status(status).json({ status: 'error', message: error.isOperational ? error.message : 'An error occurred while saving lunch times.' });
    }
};

exports.submitDay = async (req, res) => {
    const { siteId } = req.body;
    if (!siteId) return res.status(400).json({ status: 'error', message: 'Site is required.' });

    try {
        if (!(await verifySiteAction(req, siteId))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to submit this site.' });
        }

        await db.execute(
            `INSERT INTO attendance
                (worker_id, site_id, record_date, attendance_status, status, recorded_by_user_id, remarks)
             SELECT w.worker_id, wsa.site_id, CURDATE(), 'Absent', 'Draft', ?, 'Absent - no check-in recorded'
             FROM workers w
             JOIN workersiteassignments wsa ON wsa.worker_id = w.worker_id
             LEFT JOIN attendance a
               ON a.worker_id = w.worker_id
              AND a.site_id = wsa.site_id
              AND a.record_date = CURDATE()
             WHERE wsa.site_id = ?
               AND wsa.unassigned_date IS NULL
               AND w.status = 'Active'
               AND a.attendance_id IS NULL`,
            [req.user.user_id, siteId]
        );

        const [openRecords] = await db.execute(
            `SELECT attendance_id
             FROM attendance
             WHERE site_id = ? AND status = 'Draft'
               AND (record_date = CURDATE()
                    OR record_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY))
               AND check_in_time IS NOT NULL AND check_out_time IS NULL`,
            [siteId]
        );
        if (openRecords.length > 0) {
            return res.status(400).json({ status: 'error', message: 'All checked-in workers must check out before submitting the day.' });
        }

        const [openLeaves] = await db.execute(
            `SELECT a.attendance_id
             FROM attendance a
             JOIN attendanceleaveperiods alp ON alp.attendance_id = a.attendance_id
             WHERE a.site_id = ? AND a.status = 'Draft'
               AND (a.record_date = CURDATE()
                    OR a.record_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY))
               AND alp.leave_end_time IS NULL
             LIMIT 1`,
            [siteId]
        );
        if (openLeaves.length > 0) {
            return res.status(400).json({ status: 'error', message: 'All breaks must be ended before submitting the day.' });
        }

        const [records] = await db.execute(
            `SELECT attendance_id, attendance_status
             FROM attendance
             WHERE site_id = ? AND status = 'Draft'
               AND (record_date = CURDATE()
                    OR (record_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
                        AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL))
               AND ((check_in_time IS NOT NULL AND check_out_time IS NOT NULL)
                    OR attendance_status IN ('Absent', 'Sick', 'Annual', 'Vacation', 'Holiday'))`,
            [siteId]
        );
        if (records.length === 0) {
            return res.status(400).json({ status: 'error', message: 'No completed attendance records found for today.' });
        }

        for (const record of records) {
            if (record.attendance_status === 'Absent' || record.attendance_status === 'Sick' || record.attendance_status === 'Annual' || record.attendance_status === 'Vacation' || record.attendance_status === 'Holiday') {
                await db.execute(
                    "UPDATE attendance SET status = 'Submitted' WHERE attendance_id = ? AND status = 'Draft'",
                    [record.attendance_id]
                );
            } else {
                await attendanceService.calculateWorkingHours(record.attendance_id);
                await db.execute("UPDATE attendance SET status = 'Submitted' WHERE attendance_id = ? AND status = 'Draft'", [record.attendance_id]);
            }
        }
        res.status(200).json({ status: 'success', message: 'Day submitted for review successfully' });
    } catch (error) {
        console.error('SUBMIT DAY ERROR:', error);
        res.status(500).json({ status: 'error', message: 'An error occurred while submitting the day, please try again.' });
    }
};

exports.getRejectedRecords = async (req, res) => {
    try {
        const supervisor_id = req.user.user_id;
        const isAdmin = req.user.role === 'Admin';
        const query = `
            SELECT a.*, w.full_name, s.site_name
            FROM attendance a
            JOIN workers w ON a.worker_id = w.worker_id
            JOIN sites s ON a.site_id = s.site_id
            WHERE a.status = 'Rejected'
              ${isAdmin ? '' : 'AND a.recorded_by_user_id = ?'}
            ORDER BY s.site_name, a.record_date DESC, w.full_name`;
        const [rows] = await db.execute(query, isAdmin ? [] : [supervisor_id]);
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("GET REJECTED ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while fetching rejected records, please try again.' });
    }
};

exports.startLeave = async (req, res) => {
    try {
        const { worker_id, site_id, leave_type, leave_start_time } = req.body;
        const recorded_by_user_id = req.user.user_id;

        if (!worker_id || !site_id) {
            return res.status(400).json({ status: 'error', message: 'Worker and site are required.' });
        }

        if (!SUPERVISOR_ALLOWED_LEAVE_TYPES.includes(leave_type)) {
            return res.status(400).json({
                status: 'error',
                message: `Invalid leave type. Allowed values are: ${SUPERVISOR_ALLOWED_LEAVE_TYPES.join(', ')}.`
            });
        }

        if (!leave_start_time) {
            return res.status(400).json({ status: 'error', message: 'Break start time is required.' });
        }

        const formattedStart = formatToMySqlDateTime(leave_start_time);
        if (!formattedStart) {
            return res.status(400).json({ status: 'error', message: 'Invalid break start time format.' });
        }

        if (!(await verifySiteAction(req, site_id))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to manage leave at this site.' });
        }
        if (!(await verifyWorkerAssignedToSite(worker_id, site_id))) {
            return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site.' });
        }

        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) return res.status(404).json({ status: 'error', message: 'No active attendance record found!' });

        const [attendanceRows] = await db.execute(
            'SELECT check_in_time FROM attendance WHERE attendance_id = ? LIMIT 1',
            [att_id]
        );
        const checkInMinutes = timeToMinutes(attendanceRows[0]?.check_in_time);
        const leaveStartMinutes = timeToMinutes(formattedStart);
        if (checkInMinutes === null || leaveStartMinutes === null || leaveStartMinutes < checkInMinutes) {
            return res.status(400).json({ status: 'error', message: 'Break start time cannot be before check-in time.' });
        }

        const [existingOpenLeave] = await db.execute(
            'SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1',
            [att_id]
        );
        if (existingOpenLeave.length > 0) {
            return res.status(409).json({ status: 'error', message: 'Worker already has an active break.' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [result] = await connection.execute(
                'INSERT INTO attendanceleaveperiods (attendance_id, leave_start_time, leave_type) VALUES (?, ?, ?)',
                [att_id, formattedStart, leave_type]
            );

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendanceleaveperiods', ?, 'LEAVE_START', ?, NULL, ?)`,
                [result.insertId, recorded_by_user_id, JSON.stringify({ leave_type, leave_start_time: formattedStart })]
            );

            await connection.commit();
            res.status(200).json({ status: 'success', message: 'Leave/break started successfully' });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("START LEAVE ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while starting the break, please try again.' });
    }
};

exports.endLeave = async (req, res) => {
    try {
        const { worker_id, site_id, leave_end_time } = req.body;
        const recorded_by_user_id = req.user.user_id;

        if (!leave_end_time) {
            return res.status(400).json({ status: 'error', message: 'Break end time is required.' });
        }

        const formattedEnd = formatToMySqlDateTime(leave_end_time);
        if (!formattedEnd) {
            return res.status(400).json({ status: 'error', message: 'Invalid break end time format.' });
        }

        const att_id = await getAttendanceId(worker_id, site_id);
        if (!att_id) return res.status(404).json({ status: 'error', message: 'Attendance record not found!' });

        const [openLeaves] = await db.execute(
            `SELECT leave_id, leave_start_time FROM attendanceleaveperiods
             WHERE attendance_id = ? AND leave_end_time IS NULL ORDER BY leave_id DESC LIMIT 1`,
            [att_id]
        );
        if (openLeaves.length === 0) {
            return res.status(404).json({ status: 'error', message: 'No active break found!' });
        }

        const leave_id = openLeaves[0].leave_id;
        const existingStart = openLeaves[0].leave_start_time;

        const startMinutes = timeToMinutes(existingStart);
        const endMinutes = timeToMinutes(formattedEnd);
        if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
            return res.status(400).json({ status: 'error', message: 'Break end time must be after break start time.' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            await connection.execute(
                'UPDATE attendanceleaveperiods SET leave_end_time = ? WHERE leave_id = ?',
                [formattedEnd, leave_id]
            );

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendanceleaveperiods', ?, 'LEAVE_END', ?, ?, ?)`,
                [
                    leave_id,
                    recorded_by_user_id,
                    JSON.stringify({ leave_start_time: existingStart }),
                    JSON.stringify({ leave_end_time: formattedEnd })
                ]
            );

            await connection.commit();
            res.status(200).json({ status: 'success', message: 'Break ended successfully' });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error("END LEAVE ERROR:", error);
        res.status(500).json({ status: 'error', message: 'An error occurred while ending the break, please try again.' });
    }
};

exports.setManagementLeaveHours = async (req, res) => {
    const { attendance_id } = req.params;
    const { hours, reason } = req.body;
    const adminId = req.user.user_id;

    const numericHours = Number(hours);
    if (hours === undefined || !Number.isFinite(numericHours) || numericHours < 0 || numericHours > 24) {
        return res.status(400).json({ status: 'error', message: 'Hours must be a finite number between 0 and 24.' });
    }
    if (req.user.role !== 'Admin') {
        return res.status(403).json({ status: 'error', message: 'Only an Admin can grant management leave hours.' });
    }

    const connection = await db.getConnection();
    let shouldRecalculate = false;
    let oldRecord;

    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute('SELECT * FROM attendance WHERE attendance_id = ?', [attendance_id]);
        if (rows.length === 0) throw new AppError('Record not found');
        oldRecord = rows[0];

        await connection.execute(
            'UPDATE attendance SET management_leave_hours = ? WHERE attendance_id = ?',
            [numericHours, attendance_id]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'MANAGEMENT_LEAVE', ?, ?, ?)`,
            [attendance_id, adminId, JSON.stringify(oldRecord), JSON.stringify({ management_leave_hours: numericHours, reason })]
        );

        await connection.commit();
        shouldRecalculate = Boolean(oldRecord.check_out_time);
    } catch (error) {
        await connection.rollback();
        console.error("MANAGEMENT LEAVE ERROR:", error);
        const message = error.isOperational ? error.message : 'An error occurred while recording management leave hours.';
        return res.status(400).json({ status: 'error', message });
    } finally {
        connection.release();
    }

    if (shouldRecalculate) {
        try {
            await attendanceService.calculateWorkingHours(attendance_id);
        } catch (calcError) {
            console.error("Error in background calculation:", calcError);
        }
    }

    res.status(200).json({ status: 'success', message: 'Management leave hours recorded successfully' });
};

exports.resubmitAttendance = async (req, res) => {
    const { attendance_id } = req.params;
    const { check_in_time, check_out_time, remarks } = req.body;
    const supervisor_id = req.user.user_id;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [records] = await connection.execute(
            "SELECT * FROM attendance WHERE attendance_id = ? AND status = 'Rejected' AND recorded_by_user_id = ?",
            [attendance_id, supervisor_id]
        );

        if (records.length === 0) throw new AppError('Record not found or you are not allowed to edit it');

        const oldRecord = records[0];

        const formattedCheckIn = formatToMySqlDateTime(check_in_time);
        const formattedCheckOut = formatToMySqlDateTime(check_out_time);
        if (!formattedCheckIn || !formattedCheckOut) {
            throw new AppError('Both check-in and check-out times are required');
        }

        const checkInMinutes = timeToMinutes(formattedCheckIn);
        const checkOutMinutes = timeToMinutes(formattedCheckOut);
        if (checkInMinutes === null || checkOutMinutes === null || checkOutMinutes <= checkInMinutes) {
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
        await attendanceService.calculateWorkingHours(attendance_id);
        res.status(200).json({ status: 'success', message: 'Resubmitted successfully' });
    } catch (error) {
        await connection.rollback();
        console.error("RESUBMIT ERROR:", error);
        const message = error.isOperational
            ? error.message
            : 'An error occurred while resubmitting, please try again.';
        res.status(400).json({ status: 'error', message });
    } finally {
        connection.release();
    }
};