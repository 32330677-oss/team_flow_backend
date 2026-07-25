const db = require('../config/db');

// 1. Get contracts by project ID
exports.getContractsByProject = async (req, res) => {
    const { projectId } = req.params;
    try {
        const [rows] = await db.query(
            'SELECT * FROM Contracts WHERE project_id = ? ORDER BY created_at DESC', 
            [projectId]
        );
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'Failed to fetch project contracts' });
    }
};

// 2. Create a new contract
exports.createContract = async (req, res) => {
    const { 
        contract_name, description, start_date, end_date, 
        project_id, hourly_rate, overtime_hourly_rate 
    } = req.body;

    const admin_id = req.user.user_id; 

    if (!contract_name || !project_id || !hourly_rate || !overtime_hourly_rate) {
        return res.status(400).json({ status: 'error', message: 'Please fill in all required fields and rates' });
    }

    try {
        const query = `
            INSERT INTO Contracts 
            (contract_name, description, start_date, end_date, project_id, hourly_rate, overtime_hourly_rate, admin_id) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const [result] = await db.query(query, [
            contract_name, description || null, start_date || null, end_date || null, 
            project_id, hourly_rate, overtime_hourly_rate, admin_id
        ]);

        return res.status(201).json({
            status: 'success',
            message: 'Contract created successfully',
            contract_id: result.insertId
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'Server error while creating contract' });
    }
};

// 3. Update contract details
exports.updateContract = async (req, res) => {
    const { contractId } = req.params;
    const { contract_name, description, start_date, end_date, hourly_rate, overtime_hourly_rate } = req.body;

    try {
        const query = `
            UPDATE Contracts 
            SET contract_name = ?, description = ?, start_date = ?, end_date = ?, hourly_rate = ?, overtime_hourly_rate = ? 
            WHERE contract_id = ?
        `;
        const [result] = await db.query(query, [contract_name, description, start_date, end_date, hourly_rate, overtime_hourly_rate, contractId]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'error', message: 'Contract not found' });
        }

        return res.status(200).json({ status: 'success', message: 'Contract updated successfully' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating contract' });
    }
};

// 4. Toggle Contract Status (Active / Suspended / Completed)
exports.toggleContractStatus = async (req, res) => {
    const { contractId } = req.params;
    const { status } = req.body; 

    if (!['Active', 'Completed', 'Suspended'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Invalid status value' });
    }

    try {
        const [result] = await db.query(
            'UPDATE Contracts SET status = ? WHERE contract_id = ?',
            [status, contractId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'error', message: 'Contract not found' });
        }

        return res.status(200).json({
            status: 'success',
            message: `Contract status updated to ${status}`
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating contract status' });
    }
};