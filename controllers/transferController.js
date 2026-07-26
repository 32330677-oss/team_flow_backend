const db = require('../config/db');

// 1. Create a new transfer request (by Supervisor)
exports.createTransferRequest = async (req, res) => {
    const { worker_id, current_site_id, target_site_id } = req.body;
    const requested_by_user_id = req.user.user_id;

    if (!worker_id || !current_site_id || !target_site_id) {
        return res.status(400).json({ status: 'error', message: 'Please specify the worker, current site, and target site.' });
    }

    if (current_site_id === target_site_id) {
        return res.status(400).json({ status: 'error', message: 'The target site cannot be the same as the current site.' });
    }

    try {
        // التحقق الأمني: التأكد أن الموقع الحالي تابع لهذا المشرف (إذا لم يكن Admin)
        if (req.user.role !== 'Admin') {
            const [checkSite] = await db.execute(
                'SELECT 1 FROM sites WHERE site_id = ? AND supervisor_id = ? LIMIT 1',
                [current_site_id, requested_by_user_id]
            );
            if (checkSite.length === 0) {
                return res.status(403).json({ status: 'error', message: 'You are not authorized to transfer workers from this site.' });
            }
        }

        // Prevent duplicate pending requests for the same worker
        const [existing] = await db.query(
            `SELECT request_id FROM worker_transfer_requests WHERE worker_id = ? AND status = 'Pending'`,
            [worker_id]
        );
        if (existing.length > 0) {
            return res.status(400).json({ status: 'error', message: 'A pending transfer request already exists for this worker.' });
        }

        const [result] = await db.query(
            `INSERT INTO worker_transfer_requests 
             (worker_id, current_site_id, target_site_id, requested_by_user_id, status, created_at, updated_at) 
             VALUES (?, ?, ?, ?, 'Pending', NOW(), NOW())`,
            [worker_id, current_site_id, target_site_id, requested_by_user_id]
        );

        res.status(201).json({
            status: 'success',
            message: 'Transfer request submitted successfully for review.',
            request_id: result.insertId
        });
    } catch (error) {
        console.error('CREATE TRANSFER ERROR:', error);
        res.status(500).json({ status: 'error', message: 'An error occurred while creating the transfer request.' });
    }
};

// 2. Fetch pending requests (for Admin)
exports.getPendingTransfers = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT 
                t.request_id, t.status, t.admin_notes, t.created_at,
                w.worker_id, w.full_name AS worker_name,
                cs.site_id AS current_site_id, cs.site_name AS current_site_name,
                ts.site_id AS target_site_id, ts.site_name AS target_site_name,
                u.full_name AS requested_by_name
             FROM worker_transfer_requests t
             JOIN workers w ON t.worker_id = w.worker_id
             JOIN sites cs ON t.current_site_id = cs.site_id
             JOIN sites ts ON t.target_site_id = ts.site_id
             JOIN users u ON t.requested_by_user_id = u.user_id
             WHERE t.status = 'Pending'
             ORDER BY t.created_at DESC`
        );
        res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error('FETCH PENDING TRANSFERS ERROR:', error);
        res.status(500).json({ status: 'error', message: 'An error occurred while fetching transfer requests.' });
    }
};

// 3. Review request (Accept / Reject) - Admin only
exports.reviewTransferRequest = async (req, res) => {
    const { id } = req.params;
    const { status, admin_notes } = req.body; // status: 'Approved' | 'Rejected'
    const adminId = req.user.user_id;

    if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Invalid status provided.' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            `SELECT * FROM worker_transfer_requests WHERE request_id = ? FOR UPDATE`,
            [id]
        );
        if (rows.length === 0) throw new Error('Transfer request not found.');

        const request = rows[0];
        if (request.status !== 'Pending') {
            throw new Error('This request cannot be reviewed because it has already been processed.');
        }

        if (status === 'Approved') {
            // A. End current assignment at the old site
            await connection.execute(
                `UPDATE workersiteassignments 
                 SET unassigned_date = NOW(), updated_at = NOW() 
                 WHERE worker_id = ? AND site_id = ? AND unassigned_date IS NULL`,
                [request.worker_id, request.current_site_id]
            );

            // B. Fetch contract_id for the target site
            const [targetSite] = await connection.execute(
                `SELECT contract_id FROM sites WHERE site_id = ? LIMIT 1`,
                [request.target_site_id]
            );
            if (targetSite.length === 0) throw new Error('Target site does not exist.');
            const contract_id = targetSite[0].contract_id;

            // C. Create new assignment at the target site
            await connection.execute(
                `INSERT INTO workersiteassignments 
                 (worker_id, site_id, contract_id, assigned_by_user_id, assigned_date, created_at, updated_at) 
                 VALUES (?, ?, ?, ?, CURDATE(), NOW(), NOW())`,
                [request.worker_id, request.target_site_id, contract_id, adminId]
            );
        }

        // D. Update transfer request status
        await connection.execute(
            `UPDATE worker_transfer_requests 
             SET status = ?, admin_notes = ?, updated_at = NOW() 
             WHERE request_id = ?`,
            [status, admin_notes || null, id]
        );

        await connection.commit();
        res.status(200).json({
            status: 'success',
            message: status === 'Approved' ? 'Request approved and worker transferred successfully.' : 'Transfer request rejected.'
        });
    } catch (error) {
        await connection.rollback();
        console.error('REVIEW TRANSFER ERROR:', error);
        res.status(400).json({ status: 'error', message: error.message || 'An error occurred while processing the request.' });
    } finally {
        connection.release();
    }
};