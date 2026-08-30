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

// 3. Review request (Accept / Reject) - Admin only — UNCHANGED
exports.reviewTransferRequest = async (req, res) => {
    // ...existing implementation, no changes...
};

// 4. Download the official Word document (Admin, or the Supervisor who created it)
exports.downloadTransferDocument = async (req, res) => {
    const { id } = req.params;
    try {
        const [[row]] = await db.query(
            `SELECT document_path, requested_by_user_id FROM worker_transfer_requests WHERE request_id = ? LIMIT 1`,
            [id]
        );
        if (!row) return res.status(404).json({ status: 'error', message: 'Transfer request not found.' });
        if (!row.document_path) return res.status(404).json({ status: 'error', message: 'No document has been generated for this request.' });

        const isOwner = req.user.role === 'Supervisor' && req.user.user_id === row.requested_by_user_id;
        if (req.user.role !== 'Admin' && !isOwner) {
            return res.status(403).json({ status: 'error', message: 'You are not authorized to download this document.' });
        }

        const absolutePath = path.join(__dirname, '..', row.document_path);
        if (!fs.existsSync(absolutePath)) {
            return res.status(404).json({ status: 'error', message: 'Document file is missing on the server.' });
        }

        return res.download(absolutePath);
    } catch (error) {
        console.error('DOWNLOAD TRANSFER DOCUMENT ERROR:', error);
        res.status(500).json({ status: 'error', message: 'An error occurred while downloading the document.' });
    }
};