const db = require('../config/db');

// Get sites by contract ID
exports.getSitesByContract = async (req, res) => {
    const { contractId } = req.params;
    try {
        const query = `
            SELECT s.*, u.full_name AS supervisor_name 
            FROM Sites s
            LEFT JOIN users u ON s.supervisor_id = u.user_id
            WHERE s.contract_id = ? 
            ORDER BY s.created_at DESC
        `;
        const [rows] = await db.query(query, [contractId]);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("🚨 FETCH ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Failed to fetch contract sites' });
    }
};

// Create a new site
exports.createSite = async (req, res) => {
    const { site_name, location, contract_id, supervisor_id } = req.body;

    if (!site_name || !contract_id) {
        return res.status(400).json({ status: 'error', message: 'Please provide site name and contract ID' });
    }

    try {
        const query = `
            INSERT INTO Sites (site_name, location, contract_id, supervisor_id, site_status) 
            VALUES (?, ?, ?, ?, 'Active')
        `;
        const [result] = await db.query(query, [site_name, location || null, contract_id, supervisor_id || null]);
        return res.status(201).json({ status: 'success', message: 'Site created successfully', site_id: result.insertId });
    } catch (error) {
        console.error("🚨 DATABASE ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Server error while creating site' });
    }
};

// Update site details
exports.updateSite = async (req, res) => {
    const { siteId } = req.params;
    const { site_name, location, supervisor_id } = req.body;

    try {
        const query = `
            UPDATE Sites 
            SET site_name = ?, location = ?, supervisor_id = ?
            WHERE site_id = ?
        `;
        const [result] = await db.query(query, [site_name, location || null, supervisor_id || null, siteId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'error', message: 'Site not found' });
        }

        return res.status(200).json({ status: 'success', message: 'Site updated successfully' });
    } catch (error) {
        console.error("🚨 UPDATE ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating site' });
    }
};

// Toggle site status (Active / Suspended / Completed)
exports.toggleSiteStatus = async (req, res) => {
    const { siteId } = req.params;
    const { status } = req.body;

    if (!['Active', 'Completed', 'Suspended'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Invalid status value' });
    }

    try {
        const [result] = await db.query(
            'UPDATE Sites SET site_status = ? WHERE site_id = ?',
            [status, siteId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'error', message: 'Site not found' });
        }

        return res.status(200).json({
            status: 'success',
            message: `Site status updated to ${status}`
        });
    } catch (error) {
        console.error("🚨 STATUS ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating site status' });
    }
};

exports.getAllSites = async (req, res) => {
    try {
        const query = `
            SELECT site_id, site_name 
            FROM Sites 
            WHERE site_status = 'Active'
            ORDER BY site_name ASC
        `;
        const [rows] = await db.query(query);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("🚨 FETCH ALL SITES ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Failed to fetch sites list' });
    }
};

exports.getMySites = async (req, res) => {
    const supervisorId = req.user.user_id; 
    try {
        const query = `
            SELECT s.*, c.contract_name, p.project_name
            FROM Sites s
            LEFT JOIN Contracts c ON s.contract_id = c.contract_id
            LEFT JOIN Projects p ON c.project_id = p.project_id
            WHERE s.supervisor_id = ? AND s.site_status = 'Active'
            ORDER BY s.created_at DESC
        `;
        const [rows] = await db.query(query, [supervisorId]);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("🚨 FETCH MY SITES ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Failed to fetch your sites' });
    }
};