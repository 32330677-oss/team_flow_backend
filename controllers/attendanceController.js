const db = require('../config/db');
const attendanceService = require('../services/attendanceService');

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
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

function requireRecordDate(value) {
    if (!isValidDateOnly(value)) throw new AppError('A valid record_date (YYYY-MM-DD) is required.');
    return String(value);
}

const SUPERVISOR_ALLOWED_LEAVE_TYPES = ['Rest', 'Lunch'];
function formatToMySqlDateTime(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(String(value));
    if (!match) return null;

    const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (Number.isNaN(date.getTime())) return null;
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day || date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;

    const pad = (n) => String(n).padStart(2, '0');
    return `${yearText}-${monthText}-${dayText} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

// Fetch the only actionable open Draft shift, including a shift that started yesterday.
async function getAttendanceId(worker_id, site_id, recordDate, executor = db, forUpdate = false) {
    const lock = forUpdate ? ' FOR UPDATE' : '';
    const [rows] = await executor.execute(
        `SELECT attendance_id FROM attendance
         WHERE worker_id = ? AND site_id = ?
           AND record_date >= DATE_SUB(?, INTERVAL 1 DAY)
           AND check_in_time IS NOT NULL AND check_out_time IS NULL
           AND status = 'Draft'
         ORDER BY check_in_time DESC, attendance_id DESC LIMIT 1${lock}`,
        [worker_id, site_id, recordDate]
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
        const recordDate = requireRecordDate(req.query.record_date);
        const supervisor_id = req.user.user_id;

        if (req.user.role !== 'Admin') {
            const isAuthorized = await verifySupervisorSite(supervisor_id, siteId);
            if (!isAuthorized) {
                return res.status(403).json({ status: 'error', message: 'You are not authorized to access this site\'s data.' });
            }
        }

        const query = `
            SELECT DISTINCT w.*,
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
            LEFT JOIN attendance a ON a.attendance_id = (
                SELECT a2.attendance_id
                FROM attendance a2
                WHERE a2.worker_id = w.worker_id
                  AND a2.site_id = ?
                  AND (a2.record_date = ?
                       OR (a2.status = 'Draft' AND a2.check_in_time IS NOT NULL AND a2.check_out_time IS NULL
                           AND a2.record_date >= DATE_SUB(?, INTERVAL 1 DAY)))
                ORDER BY (a2.record_date = ?) DESC, a2.attendance_id DESC
                LIMIT 1
            )
            WHERE wsa.site_id = ?
            AND wsa.unassigned_date IS NULL
            AND w.status = 'Active'
        `;

        const [workers] = await db.execute(query, [siteId, recordDate, recordDate, recordDate, siteId]);
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

        const recordDate = formattedCheckIn.slice(0, 10);
        const [existingToday] = await db.execute(
            `SELECT attendance_id, attendance_status, check_in_time, check_out_time, status
             FROM attendance
             WHERE worker_id = ? AND site_id = ? AND record_date = ?
             ORDER BY attendance_id DESC
             LIMIT 1`,
            [worker_id, site_id, recordDate]
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
            if (['Absent', 'Sick', 'Vacation', 'Holiday'].includes(existing.attendance_status) && !existing.check_in_time && !existing.check_out_time) {
                const connection = await db.getConnection();
                try {
                    await connection.beginTransaction();
                    const [revived] = await connection.execute(
                        `UPDATE attendance
                         SET check_in_time = ?, attendance_status = 'Present', remarks = NULL
                         WHERE attendance_id = ? AND status = 'Draft'
                           AND check_in_time IS NULL AND check_out_time IS NULL`,
                        [formattedCheckIn, existing.attendance_id]
                    );
                    if (revived.affectedRows !== 1) {
                        throw new AppError('Attendance was changed by another request.');
                    }
                    await connection.execute(
                        `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                         VALUES ('attendance', ?, 'CHECK_IN', ?, ?, ?)`,
                        [existing.attendance_id, recorded_by_user_id, JSON.stringify({ attendance_status: existing.attendance_status }), JSON.stringify({ check_in_time: formattedCheckIn, attendance_status: 'Present' })]
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
                `INSERT INTO attendance (worker_id, site_id, record_date, check_in_time, attendance_status, status, recorded_by_user_id)
                 VALUES (?, ?, ?, ?, 'Present', 'Draft', ?)`,
                [worker_id, site_id, recordDate, formattedCheckIn, recorded_by_user_id]
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
        if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
            return res.status(409).json({ status: 'error', message: 'Worker already has an attendance record for this date.' });
        }
        const status = error.isOperational ? 400 : 500;
        return res.status(status).json({
            status: 'error',
            message: error.isOperational ? error.message : 'An error occurred while recording check-in, please try again.'
        });
    }
};


function normalizeWorkerIds(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 500) return null;
    const ids = [...new Set(value.map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return null;
    return ids;
}

async function verifyBulkWorkers(workerIds, siteId, executor) {
    const valid = new Set();
    for (const workerId of workerIds) {
        const [rows] = await executor.execute(
            `SELECT 1 FROM workersiteassignments wsa
             JOIN workers w ON w.worker_id = wsa.worker_id
             WHERE wsa.worker_id = ? AND wsa.site_id = ?
               AND wsa.unassigned_date IS NULL AND w.status = 'Active'
             LIMIT 1`,
            [workerId, siteId]
        );
        if (rows.length > 0) valid.add(workerId);
    }
    return valid;
}

async function runBulkAttendance(req, res, mode) {
    const { site_id, record_date, worker_ids } = req.body;
    const workerIds = normalizeWorkerIds(worker_ids);
    const timeField = mode === 'checkin' ? 'check_in_time' : 'check_out_time';
    const rawTime = req.body[timeField];

    if (!site_id || !isValidDateOnly(record_date) || !workerIds || !rawTime) {
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
                    await attendanceService.calculateWorkingHours(attendanceId, connection);
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
        const status = successful.length === workerIds.length ? 'success' : successful.length > 0 ? 'partial_success' : 'error';
        return res.status(status === 'error' ? 409 : 200).json({ status, successful, failed });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        console.error(`BULK ${mode.toUpperCase()} ERROR:`, error);
        return res.status(error.isOperational ? 400 : 500).json({ status: 'error', message: error.isOperational ? error.message : `Bulk ${mode} failed.` });
    } finally {
        connection.release();
    }
}

exports.bulkCheckIn = (req, res) => runBulkAttendance(req, res, 'checkin');
exports.bulkCheckOut = (req, res) => runBulkAttendance(req, res, 'checkout');

exports.setAttendanceStatus = async (req, res) => {
    const { worker_id, site_id, attendance_status, remarks, record_date } = req.body;
    const normalizedStatus = attendance_status === 'Annual' ? 'Vacation' : attendance_status;
    const allowedStatuses = ['Absent', 'Sick', 'Vacation', 'Holiday'];
    const recordedByUserId = req.user.user_id;

    if (!worker_id || !site_id || !attendance_status || !isValidDateOnly(record_date)) {
        return res.status(400).json({ status: 'error', message: 'Worker, site, and attendance status are required.' });
    }
    if (!allowedStatuses.includes(normalizedStatus)) {
        return res.status(400).json({ status: 'error', message: 'Invalid attendance status.' });
    }

    if (!(await verifySiteAction(req, site_id))) {
        return res.status(403).json({ status: 'error', message: 'You are not authorized to update this site.' });
    }
    if (!(await verifyWorkerAssignedToSite(worker_id, site_id))) {
        return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [existingRows] = await connection.execute(
            `SELECT attendance_id, status, attendance_status, check_in_time, check_out_time
             FROM attendance
             WHERE worker_id = ? AND site_id = ? AND record_date = ?
             ORDER BY attendance_id DESC LIMIT 1 FOR UPDATE`,
            [worker_id, site_id, record_date]
        );
        const message = remarks || `${normalizedStatus} - recorded by supervisor`;

        if (existingRows.length > 0) {
            const existing = existingRows[0];
            if (existing.status !== 'Draft') throw new AppError('Attendance cannot be changed after it has been submitted.');
            if (existing.check_in_time || existing.check_out_time) throw new AppError('Cannot change attendance status after clock activity exists.');

            const [updated] = await connection.execute(
                `UPDATE attendance
                 SET attendance_status = ?, remarks = ?, recorded_by_user_id = ?
                 WHERE attendance_id = ? AND status = 'Draft'
                   AND check_in_time IS NULL AND check_out_time IS NULL`,
                [normalizedStatus, message, recordedByUserId, existing.attendance_id]
            );
            if (updated.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendance', ?, 'STATUS_UPDATED', ?, ?, ?)`,
                [existing.attendance_id, recordedByUserId,
                 JSON.stringify({ attendance_status: existing.attendance_status, remarks: null }),
                 JSON.stringify({ attendance_status: normalizedStatus, remarks: message })]
            );
            await connection.commit();
            return res.status(200).json({ status: 'success', message: 'Attendance status updated successfully.' });
        }

        const [inserted] = await connection.execute(
            `INSERT INTO attendance
                (worker_id, site_id, record_date, attendance_status, status, recorded_by_user_id, remarks)
             VALUES (?, ?, ?, ?, 'Draft', ?, ?)`,
            [worker_id, site_id, record_date, normalizedStatus, recordedByUserId, message]
        );
        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'STATUS_CREATED', ?, NULL, ?)`,
            [inserted.insertId, recordedByUserId, JSON.stringify({ attendance_status: normalizedStatus, remarks: message })]
        );
        await connection.commit();
        return res.status(201).json({ status: 'success', message: 'Attendance status recorded successfully.' });
    } catch (error) {
        await connection.rollback();
        console.error('SET ATTENDANCE STATUS ERROR:', error);
        if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
            return res.status(409).json({ status: 'error', message: 'Worker already has an attendance record for this date.' });
        }
        const status = error.isOperational ? 400 : 500;
        return res.status(status).json({ status: 'error', message: error.isOperational ? error.message : 'An error occurred while saving attendance status.' });
    } finally {
        connection.release();
    }
};

exports.checkOut = async (req, res) => {
    const { worker_id, site_id, check_out_time, record_date } = req.body;
    const userId = req.user.user_id;
    if (!worker_id || !site_id || !isValidDateOnly(record_date)) return res.status(400).json({ status: 'error', message: 'Worker, site, and valid record_date are required.' });
    if (!check_out_time) return res.status(400).json({ status: 'error', message: 'Check-out time is required.' });

    const formattedCheckOut = formatToMySqlDateTime(check_out_time);
    if (!formattedCheckOut) return res.status(400).json({ status: 'error', message: 'Invalid check-out time format.' });
    if (!(await verifySiteAction(req, site_id))) return res.status(403).json({ status: 'error', message: 'You are not authorized to perform this action at the specified site.' });
    if (!(await verifyWorkerAssignedToSite(worker_id, site_id))) return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site.' });

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const attId = await getAttendanceId(worker_id, site_id, record_date, connection, true);
        if (!attId) throw new AppError('Attendance record not found.');

        const [[row]] = await connection.execute(
            'SELECT check_in_time, check_out_time FROM attendance WHERE attendance_id = ? FOR UPDATE', [attId]
        );
        const checkInDate = parseAttendanceDate(row?.check_in_time);
        const checkOutDate = parseAttendanceDate(formattedCheckOut);
        if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) throw new AppError('Check-out time must be after check-in time.');

        const [openLeaves] = await connection.execute(
            'SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1 FOR UPDATE', [attId]
        );
        if (openLeaves.length > 0) throw new AppError('End the active break before checking out.');

        const [updated] = await connection.execute(
            `UPDATE attendance SET check_out_time = ?
             WHERE attendance_id = ? AND status = 'Draft' AND check_out_time IS NULL`,
            [formattedCheckOut, attId]
        );
        if (updated.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

        await attendanceService.calculateWorkingHours(attId, connection);
        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'CHECK_OUT', ?, ?, ?)`,
            [attId, userId, JSON.stringify({ check_in_time: row.check_in_time, check_out_time: null }), JSON.stringify({ check_out_time: formattedCheckOut })]
        );
        await connection.commit();
        return res.status(200).json({ status: 'success', message: 'Check-out recorded successfully.', data: { attendance_id: attId, check_out_time: formattedCheckOut } });
    } catch (error) {
        await connection.rollback();
        console.error('CHECK-OUT ERROR:', error);
        const status = error.isOperational ? 400 : 500;
        return res.status(status).json({ status: 'error', message: error.isOperational ? error.message : 'An error occurred during check-out, please try again.' });
    } finally {
        connection.release();
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

function formatUtcDateAsMySql(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

// Convert a time-only input to the occurrence inside the actual shift window.
// This makes 23:00 -> 01:00 and breaks such as 00:30 unambiguous.
function normalizeTimeForShift(value, shiftStart, shiftEnd) {
    if (!value || !shiftStart || !shiftEnd) return null;
    const text = String(value);
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(text)) return formatToMySqlDateTime(text);
    const parts = text.split(':').map(Number);
    const candidate = new Date(shiftStart.getTime());
    candidate.setUTCHours(parts[0], parts[1], parts[2] || 0, 0);
    while (candidate < shiftStart) candidate.setUTCDate(candidate.getUTCDate() + 1);
    if (candidate > shiftEnd) {
        const previousDay = new Date(candidate.getTime());
        previousDay.setUTCDate(previousDay.getUTCDate() - 1);
        if (previousDay >= shiftStart && previousDay <= shiftEnd) return formatUtcDateAsMySql(previousDay);
    }
    return candidate <= shiftEnd ? formatUtcDateAsMySql(candidate) : null;
}

function parseAttendanceDate(value) {
    const formatted = formatToMySqlDateTime(value);
    if (!formatted) return null;
    const [datePart, timePart] = formatted.split(' ');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second] = timePart.split(':').map(Number);
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function timeToMinutes(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.getUTCHours() * 60 + value.getUTCMinutes();
    }
    const text = String(value);
    const match = /(?:^|T| )((?:[01]\d|2[0-3])):([0-5]\d)(?::[0-5]\d)?/.exec(text);
    if (match) return Number(match[1]) * 60 + Number(match[2]);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.getUTCHours() * 60 + parsed.getUTCMinutes();
    }
    return null;
}

async function hasOverlappingLeave(executor, attendanceId, start, end, excludeLeaveId = null) {
    const params = [attendanceId, end, start];
    let exclusion = '';
    if (excludeLeaveId !== null) {
        exclusion = ' AND leave_id <> ?';
        params.push(excludeLeaveId);
    }
    const [rows] = await executor.execute(
        `SELECT leave_id
         FROM attendanceleaveperiods
         WHERE attendance_id = ?
           AND leave_start_time < ?
           AND COALESCE(leave_end_time, '9999-12-31 23:59:59') > ?${exclusion}
         LIMIT 1
         FOR UPDATE`,
        params
    );
    return rows.length > 0;
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
             WHERE a.site_id = ? AND (a.record_date = ? OR
                    (a.record_date = DATE_SUB(?, INTERVAL 1 DAY)
                     AND DATE(a.check_out_time) > a.record_date))
               AND a.status = 'Draft'
               AND w.status = 'Active' AND wsa.unassigned_date IS NULL
               AND a.check_in_time IS NOT NULL AND a.check_out_time IS NOT NULL`,
            [siteId, selectedDate, selectedDate]
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
                const checkInDate = parseAttendanceDate(record.check_in_time);
                const checkOutDate = parseAttendanceDate(record.check_out_time);
                const start = normalizeTimeForShift(rawStart, checkInDate, checkOutDate);
                const end = normalizeTimeForShift(rawEnd, checkInDate, checkOutDate);
                const lunchStartDate = parseAttendanceDate(start);
                const lunchEndDate = parseAttendanceDate(end);
                if (!checkInDate || !checkOutDate || !start || !end || !lunchStartDate || !lunchEndDate) {
                    throw new AppError(`Invalid time for worker ${record.worker_id}`);
                }
                if (lunchEndDate <= lunchStartDate) throw new AppError(`Lunch end must be after lunch start for worker ${record.worker_id}`);
                if (lunchStartDate < checkInDate || lunchEndDate > checkOutDate) {
                    throw new AppError(`Lunch must be between check-in and check-out for worker ${record.worker_id}`);
                }

                const [existing] = await connection.execute(
                    `SELECT leave_id FROM attendanceleaveperiods
                     WHERE attendance_id = ? AND leave_type = 'Lunch'
                     ORDER BY leave_id DESC LIMIT 1`,
                    [record.attendance_id]
                );
                const currentLunchId = existing.length > 0 ? existing[0].leave_id : null;
                if (await hasOverlappingLeave(connection, record.attendance_id, start, end, currentLunchId)) {
                    throw new AppError(`Lunch period overlaps another break for worker ${record.worker_id}.`);
                }
                if (existing.length > 0) {
                    const [lunchUpdated] = await connection.execute(
                        `UPDATE attendanceleaveperiods
                         SET leave_start_time = ?, leave_end_time = ?
                         WHERE leave_id = ?`,
                        [start, end, existing[0].leave_id]
                    );
                    if (lunchUpdated.affectedRows !== 1) throw new AppError('Lunch record was changed by another request.');
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
                await attendanceService.calculateWorkingHours(record.attendance_id, connection);
            }
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

        return res.status(200).json({ status: 'success', message: 'Lunch times saved successfully.', updated_records: recordsToUpdate.length });
    } catch (error) {
        console.error('SAVE BULK LUNCH ERROR:', error);
        const status = error.isOperational ? 400 : 500;
        return res.status(status).json({ status: 'error', message: error.isOperational ? error.message : 'An error occurred while saving lunch times.' });
    }
};

exports.submitDay = async (req, res) => {
    const { siteId, record_date } = req.body;
    if (!siteId || !isValidDateOnly(record_date)) return res.status(400).json({ status: 'error', message: 'Site and valid record_date are required.' });

    // 1. فتح اتصال جديد خاص بهذه المعاملة (Transaction Connection)
    const connection = await db.getConnection();

    try {
        if (!(await verifySiteAction(req, siteId))) {
            connection.release();
            return res.status(403).json({ status: 'error', message: 'You are not authorized to submit this site.' });
        }

        // بدء المعاملة
        await connection.beginTransaction();

        // 2. الفحوصات أولاً (قبل أي عملية إدخال أو تعديل) لتجنب ترك بيانات تالفة عند الفشل
        const [openRecords] = await connection.execute(
            `SELECT attendance_id
             FROM attendance
             WHERE site_id = ? AND status = 'Draft'
               AND (record_date = ?
                    OR record_date = DATE_SUB(?, INTERVAL 1 DAY))
               AND check_in_time IS NOT NULL AND check_out_time IS NULL
             FOR UPDATE`,
            [siteId, record_date, record_date]
        );
        if (openRecords.length > 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ status: 'error', message: 'All checked-in workers must check out before submitting the day.' });
        }

        const [openLeaves] = await connection.execute(
            `SELECT a.attendance_id
             FROM attendance a
             JOIN attendanceleaveperiods alp ON alp.attendance_id = a.attendance_id
             WHERE a.site_id = ? AND a.status = 'Draft'
               AND (a.record_date = ?
                    OR a.record_date = DATE_SUB(?, INTERVAL 1 DAY))
               AND alp.leave_end_time IS NULL
             LIMIT 1 FOR UPDATE`,
            [siteId, record_date, record_date]
        );
        if (openLeaves.length > 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ status: 'error', message: 'All breaks must be ended before submitting the day.' });
        }

        // 3. بعد نجاح الفحوصات، نقوم بإدخال سجلات الغياب للذين لم يسجلوا حضوراً
        await connection.execute(
            `INSERT INTO attendance
                (worker_id, site_id, record_date, attendance_status, status, recorded_by_user_id, remarks)
             SELECT w.worker_id, wsa.site_id, ?, 'Absent', 'Draft', ?, 'Absent - no check-in recorded'
             FROM workers w
             JOIN workersiteassignments wsa ON wsa.worker_id = w.worker_id
             LEFT JOIN attendance a
               ON a.worker_id = w.worker_id
              AND a.site_id = wsa.site_id
              AND a.record_date = ?
             WHERE wsa.site_id = ?
               AND wsa.unassigned_date IS NULL
               AND w.status = 'Active'
               AND a.attendance_id IS NULL`,
            [record_date, req.user.user_id, record_date, siteId]
        );

        // 4. جلب كل السجلات الجاهزة للإرسال
        const [records] = await connection.execute(
            `SELECT attendance_id, attendance_status
             FROM attendance
             WHERE site_id = ? AND status = 'Draft'
               AND (record_date = ?
                    OR (record_date = DATE_SUB(?, INTERVAL 1 DAY)
                        AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL))
               AND ((check_in_time IS NOT NULL AND check_out_time IS NOT NULL)
                    OR attendance_status IN ('Absent', 'Sick', 'Vacation', 'Holiday'))`,
            [siteId, record_date, record_date]
        );
        
        if (records.length === 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ status: 'error', message: 'No completed attendance records found for today.' });
        }

        for (const record of records) {
            if (!['Absent', 'Sick', 'Vacation', 'Holiday'].includes(record.attendance_status)) {
                await attendanceService.calculateWorkingHours(record.attendance_id, connection);
            }
            const [submitted] = await connection.execute(
                `UPDATE attendance
                 SET status = 'Submitted', updated_at = NOW()
                 WHERE attendance_id = ? AND status = 'Draft'`,
                [record.attendance_id]
            );
            if (submitted.affectedRows !== 1) {
                throw new AppError(`Attendance ${record.attendance_id} was changed by another request.`);
            }
            await connection.execute(
                `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                 VALUES ('attendance', ?, 'SUBMITTED', ?, ?, ?)`,
                [record.attendance_id, req.user.user_id,
                 JSON.stringify({ status: 'Draft' }),
                 JSON.stringify({ status: 'Submitted' })]
            );
        }

        await connection.commit();
        connection.release();
        
        return res.status(200).json({ status: 'success', message: 'Day submitted for review successfully' });

    } catch (error) {
        await connection.rollback();
        connection.release();
        
        console.error('SUBMIT DAY ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while submitting the day, please try again.' });
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
              ${isAdmin ? '' : 'AND s.supervisor_id = ?'}
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
        const { worker_id, site_id, leave_type, leave_start_time, record_date } = req.body;
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

        const att_id = await getAttendanceId(worker_id, site_id, record_date);
        if (!att_id) return res.status(404).json({ status: 'error', message: 'No active attendance record found!' });

        const [attendanceRows] = await db.execute(
            'SELECT check_in_time, check_out_time FROM attendance WHERE attendance_id = ? LIMIT 1',
            [att_id]
        );
        const checkInDate = parseAttendanceDate(attendanceRows[0]?.check_in_time);
        const checkOutDate = attendanceRows[0]?.check_out_time ? parseAttendanceDate(attendanceRows[0].check_out_time) : null;
        const leaveStartDate = parseAttendanceDate(formattedStart);
        if (!checkInDate || !leaveStartDate || leaveStartDate < checkInDate || (checkOutDate && leaveStartDate > checkOutDate)) {
            return res.status(400).json({ status: 'error', message: 'Break start time must be within the attendance shift.' });
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
            await connection.execute(
                'SELECT attendance_id FROM attendance WHERE attendance_id = ? FOR UPDATE',
                [att_id]
            );
            const shiftEndForLeave = checkOutDate ? formatUtcDateAsMySql(checkOutDate) : '9999-12-31 23:59:59';
            if (await hasOverlappingLeave(connection, att_id, formattedStart, shiftEndForLeave, null)) {
                throw new AppError('Break overlaps an existing break.');
            }

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
        const status = error.isOperational ? 400 : 500;
        res.status(status).json({ status: 'error', message: error.isOperational ? error.message : 'An error occurred while starting the break, please try again.' });
    }
};

exports.endLeave = async (req, res) => {
    try {
        const { worker_id, site_id, leave_end_time, record_date } = req.body;
        const recorded_by_user_id = req.user.user_id;

        if (!leave_end_time) {
            return res.status(400).json({ status: 'error', message: 'Break end time is required.' });
        }

        const formattedEnd = formatToMySqlDateTime(leave_end_time);
        if (!formattedEnd) {
            return res.status(400).json({ status: 'error', message: 'Invalid break end time format.' });
        }

        if (!worker_id || !site_id || !isValidDateOnly(record_date)) {
            return res.status(400).json({ status: 'error', message: 'Worker, site, and valid record_date are required.' });
        }
        if (!(await verifySiteAction(req, site_id))) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to manage leave at this site.' });
        }
        if (!(await verifyWorkerAssignedToSite(worker_id, site_id))) {
            return res.status(400).json({ status: 'error', message: 'Worker is not active or is not assigned to this site.' });
        }

        const att_id = await getAttendanceId(worker_id, site_id, record_date);
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
        const [attendanceRows] = await db.execute(
            'SELECT check_out_time FROM attendance WHERE attendance_id = ? LIMIT 1',
            [att_id]
        );
        const startDate = parseAttendanceDate(existingStart);
        const endDate = parseAttendanceDate(formattedEnd);
        const checkOutDate = parseAttendanceDate(attendanceRows[0]?.check_out_time);
        if (!startDate || !endDate || endDate <= startDate || (checkOutDate && endDate > checkOutDate)) {
            return res.status(400).json({ status: 'error', message: 'Break end time must be after break start and within the shift.' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            await connection.execute('SELECT leave_id FROM attendanceleaveperiods WHERE leave_id = ? FOR UPDATE', [leave_id]);

            const [ended] = await connection.execute(
                `UPDATE attendanceleaveperiods
                 SET leave_end_time = ?
                 WHERE leave_id = ? AND leave_end_time IS NULL`,
                [formattedEnd, leave_id]
            );
            if (ended.affectedRows !== 1) throw new AppError('Break was changed by another request.');

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
        const status = error.isOperational ? 400 : 500;
        res.status(status).json({ status, message: error.isOperational ? error.message : 'An error occurred while ending the break, please try again.' });
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
    let oldRecord;

    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute('SELECT * FROM attendance WHERE attendance_id = ? FOR UPDATE', [attendance_id]);
        if (rows.length === 0) throw new AppError('Record not found');
        oldRecord = rows[0];

        const [updated] = await connection.execute(
            'UPDATE attendance SET management_leave_hours = ? WHERE attendance_id = ?',
            [numericHours, attendance_id]
        );
        if (updated.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('attendance', ?, 'MANAGEMENT_LEAVE', ?, ?, ?)`,
            [attendance_id, adminId, JSON.stringify(oldRecord), JSON.stringify({ management_leave_hours: numericHours, reason })]
        );

        if (oldRecord.check_out_time) {
            await attendanceService.calculateWorkingHours(attendance_id, connection);
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        console.error("MANAGEMENT LEAVE ERROR:", error);
        const status = error.isOperational ? 400 : 500;
        const message = error.isOperational ? error.message : 'An error occurred while recording management leave hours.';
        return res.status(status).json({ status: 'error', message });
    } finally {
        connection.release();
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
            "SELECT * FROM attendance WHERE attendance_id = ? AND status = 'Rejected' AND recorded_by_user_id = ? FOR UPDATE",
            [attendance_id, supervisor_id]
        );

        if (records.length === 0) throw new AppError('Record not found or you are not allowed to edit it');

        const oldRecord = records[0];
        if (!(await verifySiteAction(req, oldRecord.site_id))) {
            throw new AppError('You are not authorized to resubmit attendance for this site.');
        }
        if (!(await verifyWorkerAssignedToSite(oldRecord.worker_id, oldRecord.site_id))) {
            throw new AppError('Worker is not active or is not assigned to this site.');
        }
        const [openLeaves] = await connection.execute(
            'SELECT leave_id FROM attendanceleaveperiods WHERE attendance_id = ? AND leave_end_time IS NULL LIMIT 1 FOR UPDATE',
            [attendance_id]
        );
        if (openLeaves.length > 0) throw new AppError('End the active break before resubmitting attendance.');

        const formattedCheckIn = formatToMySqlDateTime(check_in_time);
        const formattedCheckOut = formatToMySqlDateTime(check_out_time);
        if (!formattedCheckIn || !formattedCheckOut) {
            throw new AppError('Both check-in and check-out times are required');
        }

        const checkInDate = parseAttendanceDate(formattedCheckIn);
        const checkOutDate = parseAttendanceDate(formattedCheckOut);
        if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) {
            throw new AppError('Check-out time must be after check-in time');
        }

        const [resubmitted] = await connection.execute(
            `UPDATE attendance SET check_in_time = ?, check_out_time = ?, attendance_status = 'Present', remarks = ?, status = 'Submitted', updated_at = NOW() WHERE attendance_id = ? AND status = 'Rejected'`,
            [formattedCheckIn, formattedCheckOut, remarks, attendance_id]
        );
        if (resubmitted.affectedRows !== 1) throw new AppError('Attendance was changed by another request.');

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values) VALUES (?, ?, ?, ?, ?, ?)`,
            ['attendance', attendance_id, 'RESUBMIT', supervisor_id, JSON.stringify(oldRecord), JSON.stringify({ check_in_time: formattedCheckIn, check_out_time: formattedCheckOut, remarks, status: 'Submitted' })]
        );

        await attendanceService.calculateWorkingHours(attendance_id, connection);
        await connection.commit();
        res.status(200).json({ status: 'success', message: 'Resubmitted successfully' });
    } catch (error) {
        await connection.rollback();
        console.error("RESUBMIT ERROR:", error);
        const status = error.isOperational ? 400 : 500;
        const message = error.isOperational ? error.message : 'An error occurred while resubmitting, please try again.';
        res.status(status).json({ status: 'error', message });
    } finally {
        connection.release();
    }
};