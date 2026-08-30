const db = require('../config/db');
const path = require('path');
const fs = require('fs');
const { generateTransferRequestDocx } = require('../services/transferDocumentService');

// 1. Create a new transfer request (by Supervisor)
exports.createTransferRequest = async (req, res) => {
    const { worker_id, current_site_id, target_site_id, transfer_reason } = req.body;
    const requested_by_user_id = req.user.user_id;

    if (!worker_id || !current_site_id || !target_site_id) {
        return res.status(400).json({ status: 'error', message: 'Please specify the worker, current site, and target site.' });
    }

    if (current_site_id === target_site_id) {
        return res.status(400).json({ status: 'error', message: 'The target site cannot be the same as the current site.' });
    }

    try {
        if (req.user.role !== 'Admin') {
            const [checkSite] = await db.execute(
                'SELECT 1 FROM sites WHERE site_id = ? AND supervisor_id = ? LIMIT 1',
                [current_site_id, requested_by_user_id]
            );
            if (checkSite.length === 0) {
                return res.status(403).json({ status: 'error', message: 'You are not authorized to transfer workers from this site.' });
            }
        }

        const [existing] = await db.query(
            `SELECT request_id FROM worker_transfer_requests WHERE worker_id = ? AND status = 'Pending'`,
            [worker_id]
        );
        if (existing.length > 0) {
            return res.status(400).json({ status: 'error', message: 'A pending transfer request already exists for this worker.' });
        }

        const [result] = await db.query(
            `INSERT INTO worker_transfer_requests
             (worker_id, current_site_id, target_site_id, requested_by_user_id, status, admin_notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'Pending', ?, NOW(), NOW())`,
            [worker_id, current_site_id, target_site_id, requested_by_user_id, transfer_reason || null]
        );
        const requestId = result.insertId;

        // --- Generate the official Word document (best-effort; never blocks the electronic request) ---
        let documentPath = null;
        try {
            const [[workerRow]] = await db.query(
                `SELECT full_name, worker_unique_id, job_position, nationality, phone_number, hire_date
                 FROM workers WHERE worker_id = ? LIMIT 1`,
                [worker_id]
            );
            const [[currentSiteRow]] = await db.query(
                `SELECT s.site_name, c.contract_name
                 FROM sites s LEFT JOIN contracts c ON c.contract_id = s.contract_id
                 WHERE s.site_id = ? LIMIT 1`,
                [current_site_id]
            );
            const [[targetSiteRow]] = await db.query(
                `SELECT site_name FROM sites WHERE site_id = ? LIMIT 1`,
                [target_site_id]
            );
            const [[requesterRow]] = await db.query(
                `SELECT full_name, role FROM users WHERE user_id = ? LIMIT 1`,
                [requested_by_user_id]
            );

            documentPath = await generateTransferRequestDocx({
                requestId,
                companyName: process.env.COMPANY_NAME || null,
                companyInfo: process.env.COMPANY_INFO || null,
                requestDate: new Date().toISOString().slice(0, 10),
                worker: workerRow || {},
                currentSiteName: currentSiteRow?.site_name,
                targetSiteName: targetSiteRow?.site_name,
                contractName: currentSiteRow?.contract_name,
                requesterName: requesterRow?.full_name,
                requesterPosition: requesterRow?.role,
                transferReason: transfer_reason,
            });

            await db.query(
                `UPDATE worker_transfer_requests SET document_path = ? WHERE request_id = ?`,
                [documentPath, requestId]
            );
        } catch (docError) {
            console.error('TRANSFER DOCX GENERATION ERROR:', docError);
            // Electronic request still succeeds even if the Word file couldn't be built.
        }

        res.status(201).json({
            status: 'success',
            message: 'Transfer request submitted successfully for review.',
            request_id: requestId,
            document_available: Boolean(documentPath),
        });
    } catch (error) {
        console.error('CREATE TRANSFER ERROR:', error);
        res.status(500).json({ status: 'error', message: 'An error occurred while creating the transfer request.' });
    }
};

// 2. Fetch pending requests (for Admin) — unchanged, document_path not needed in the list
exports.getPendingTransfers = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT
                t.request_id, t.status, t.admin_notes, t.created_at, t.document_path,
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

// 4. Download the official Word document (Admin, or the Supervisor who created it)
// 4. Download the official Word document (Admin, or the Supervisor who created it)
exports.downloadTransferDocument = async (req, res) => {
    const { id } = req.params;
    try {
        // 1. جلب بيانات الطلب كاملة مع تفاصيل العامل والمواقع والمستخدم لتكون جاهزة عند الحاجة للتوليد الفوري
        const [[row]] = await db.query(
            `SELECT 
                t.document_path, t.requested_by_user_id, t.created_at, t.admin_notes,
                w.full_name, w.worker_unique_id, w.job_position, w.nationality, w.phone_number, w.hire_date,
                cs.site_name AS current_site_name, c.contract_name,
                ts.site_name AS target_site_name,
                u.full_name AS requester_name, u.role AS requester_role
             FROM worker_transfer_requests t
             JOIN workers w ON t.worker_id = w.worker_id
             JOIN sites cs ON t.current_site_id = cs.site_id
             JOIN sites ts ON t.target_site_id = ts.site_id
             LEFT JOIN contracts c ON c.contract_id = cs.contract_id
             JOIN users u ON t.requested_by_user_id = u.user_id
             WHERE t.request_id = ? LIMIT 1`,
            [id]
        );

        if (!row) {
            return res.status(404).json({ status: 'error', message: 'Transfer request not found.' });
        }

        // 2. التحقق من الصلاحيات (Admin أو صاحب الطلب Supervisor)
        const isOwner = req.user.role === 'Supervisor' && req.user.user_id === row.requested_by_user_id;
        if (req.user.role !== 'Admin' && !isOwner) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to download this document.' });
        }

        let absolutePath = row.document_path ? path.join(__dirname, '..', row.document_path) : null;

        // 3. التوليد التلقائي الفوري (On-the-Fly) إذا كان مسار الملف فارغاً أو غير موجود على السيرفر
        if (!absolutePath || !fs.existsSync(absolutePath)) {
            try {
                const generatedPath = await generateTransferRequestDocx({
                    requestId: id,
                    companyName: process.env.COMPANY_NAME || null,
                    companyInfo: process.env.COMPANY_INFO || null,
                    requestDate: row.created_at ? String(row.created_at).slice(0, 10) : new Date().toISOString().slice(0, 10),
                    worker: {
                        full_name: row.full_name,
                        worker_unique_id: row.worker_unique_id,
                        job_position: row.job_position,
                        nationality: row.nationality,
                        phone_number: row.phone_number,
                        hire_date: row.hire_date,
                    },
                    currentSiteName: row.current_site_name,
                    targetSiteName: row.target_site_name,
                    contractName: row.contract_name,
                    requesterName: row.requester_name,
                    requesterPosition: row.requester_role,
                    transferReason: row.admin_notes,
                });

                // تحديث المسار في قاعدة البيانات للمستقبل
                await db.query(
                    `UPDATE worker_transfer_requests SET document_path = ? WHERE request_id = ?`,
                    [generatedPath, id]
                );

                absolutePath = path.join(__dirname, '..', generatedPath);
            } catch (genError) {
                console.error('ON-THE-FLY DOCX GENERATION ERROR:', genError);
                return res.status(500).json({ status: 'error', message: 'Failed to generate document on the fly.' });
            }
        }

        // 4. إرسال الملف بنجاح
        return res.download(absolutePath);

    } catch (error) {
        console.error('DOWNLOAD TRANSFER DOCUMENT ERROR:', error);
        res.status(500).json({ status: 'error', message: 'An error occurred while downloading the document.' });
    }
};