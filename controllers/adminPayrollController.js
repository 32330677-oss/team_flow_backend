const pool = require('../config/db');

async function generatePayrollBatch(req, res) {
    const { start_date, end_date, site_id } = req.body;
    const userId = req.user?.user_id;

    // ✅ تحقق من المدخلات أولاً، قبل أي استعلام
   if (!start_date || !end_date) {
        console.log("❌ Validation Error: Missing dates");
        return res.status(400).json({ success: false, message: 'Start date and end date are required' });
    }
    if (new Date(end_date) < new Date(start_date)) {
        console.log("❌ Validation Error: End date before start date");
        return res.status(400).json({ success: false, message: 'End date must be after start date' });
    }
    if (!userId) {
        console.log("❌ Validation Error: User ID missing from request");
        return res.status(401).json({ success: false, message: 'Admin identification not found' });
    }

    const connection = await pool.getConnection();
    try {
        // ✅ فحص تداخل التواريخ بشرط واحد بسيط وصحيح منطقياً، وقبل فتح أي transaction
        const [overlapping] = await connection.query(
            `SELECT payroll_batch_id FROM payrollbatches WHERE start_date <= ? AND end_date >= ?`,
            [end_date, start_date]
        );
        if (overlapping.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'A payroll batch for this period or overlapping dates already exists.'
            });
        }

        await connection.beginTransaction();

        const isSpecificSite = site_id && site_id !== '' && site_id !== 'null' && site_id !== '0' && site_id !== 'All';

        let workersQuery = `
            SELECT DISTINCT w.worker_id, w.full_name
            FROM workers w
            JOIN workersiteassignments wsa ON w.worker_id = wsa.worker_id AND wsa.unassigned_date IS NULL
            WHERE w.status = 'Active'
        `;
        const queryParams = [];
        if (isSpecificSite) {
            workersQuery += ` AND wsa.site_id = ?`;
            queryParams.push(site_id);
        }

        const [workers] = await connection.query(workersQuery, queryParams);
        if (!workers.length) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'No active assigned workers found' });
        }

        const [batchResult] = await connection.query(
            `INSERT INTO payrollbatches (start_date, end_date, generated_by_user_id, status) VALUES (?, ?, ?, 'Generated')`,
            [start_date, end_date, userId]
        );
        const batchId = batchResult.insertId;

        let totalWorkers = 0;
        let totalAmount = 0;

        for (const worker of workers) {
            let assignmentsQuery = `
                SELECT wsa.site_id, wsa.contract_id, c.hourly_rate, c.overtime_hourly_rate
                FROM workersiteassignments wsa
                JOIN contracts c ON wsa.contract_id = c.contract_id
                WHERE wsa.worker_id = ? AND wsa.unassigned_date IS NULL
            `;
            const assignParams = [worker.worker_id];
            if (isSpecificSite) {
                assignmentsQuery += ` AND wsa.site_id = ?`;
                assignParams.push(site_id);
            }

            const [assignments] = await connection.query(assignmentsQuery, assignParams);
            if (!assignments.length) continue;

            const siteRateMap = new Map();
            assignments.forEach(a => siteRateMap.set(a.site_id, a));

            let attQuery = `
                SELECT site_id,
                       SUM(total_working_hours) AS reg_hours,
                       SUM(overtime_hours) AS ot_hours
                FROM attendance
                WHERE worker_id = ? AND record_date BETWEEN ? AND ? AND status = 'Approved'
            `;
            const attParams = [worker.worker_id, start_date, end_date];
            if (isSpecificSite) {
                attQuery += ` AND site_id = ?`;
                attParams.push(site_id);
            }
            attQuery += ` GROUP BY site_id`;

            const [logs] = await connection.query(attQuery, attParams);
            if (!logs.length) continue;

            const siteBreakdown = [];
            let workerNetSalary = 0;

            for (const log of logs) {
                const regHours = Number(log.reg_hours || 0);
                const otHours = Number(log.ot_hours || 0);
                const logSiteId = log.site_id;

                if ((regHours === 0 && otHours === 0) || !logSiteId) continue;

                const rateInfo = siteRateMap.get(logSiteId);
                if (!rateInfo) continue;

                const hourlyRate = Number(rateInfo.hourly_rate || 0);
                const overtimeRate = Number(rateInfo.overtime_hourly_rate || 0);
                const baseSalary = regHours * hourlyRate;
                const overtimePay = otHours * overtimeRate;

                siteBreakdown.push({
                    site_id: logSiteId,
                    contract_id: rateInfo.contract_id,
                    regHours, otHours, hourlyRate, overtimeRate,
                    baseSalary, overtimePay
                });

                workerNetSalary += (baseSalary + overtimePay);
            }

            if (!siteBreakdown.length) continue;

            const [payrollResult] = await connection.query(
                `INSERT INTO payroll (payroll_batch_id, worker_id, start_date, end_date, gross_salary, net_salary, status, generated_by_user_id)
                 VALUES (?, ?, ?, ?, ?, ?, 'Generated', ?)`,
                [batchId, worker.worker_id, start_date, end_date, workerNetSalary, workerNetSalary, userId]
            );
            const payrollId = payrollResult.insertId;

            for (const item of siteBreakdown) {
                await connection.query(
                    `INSERT INTO payrollitems
                     (payroll_id, contract_id, site_id, regular_hours_worked, overtime_hours_worked, hourly_rate_snapshot, overtime_hourly_rate_snapshot, base_salary, overtime_pay)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [payrollId, item.contract_id, item.site_id, item.regHours, item.otHours, item.hourlyRate, item.overtimeRate, item.baseSalary, item.overtimePay]
                );
            }

            totalWorkers++;
            totalAmount += workerNetSalary;
        }

        if (totalWorkers === 0) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'No approved attendance found for this period' });
        }

        await connection.query(
            `UPDATE payrollbatches SET total_workers = ?, total_amount = ? WHERE payroll_batch_id = ?`,
            [totalWorkers, totalAmount, batchId]
        );

        await connection.commit();
        return res.status(201).json({ success: true, message: 'Payroll generated successfully', batch_id: batchId });

    } catch (error) {
        await connection.rollback();
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
}


async function getPayrollReport(req, res) {
    try {
        const { site_id } = req.query;

        let query = `
            SELECT DISTINCT
                pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_workers, pb.total_amount, pb.status, pb.generated_at,
                u.full_name AS generated_by
            FROM payrollbatches pb
            JOIN users u ON pb.generated_by_user_id = u.user_id
        `;
        const params = [];

        const isSpecificSite = site_id && site_id !== '' && site_id !== 'null' && site_id !== '0' && site_id !== 'All';

        if (isSpecificSite) {
            query = `
                SELECT DISTINCT
                    pb.payroll_batch_id, pb.start_date, pb.end_date, pb.total_workers, pb.total_amount, pb.status, pb.generated_at,
                    u.full_name AS generated_by
                FROM payrollbatches pb
                JOIN users u ON pb.generated_by_user_id = u.user_id
                JOIN payroll p ON pb.payroll_batch_id = p.payroll_batch_id
                JOIN payrollitems pi ON p.payroll_id = pi.payroll_id AND pi.site_id = ?
            `;
            params.push(site_id);
        }

        query += ` ORDER BY pb.generated_at DESC`;

        const [batches] = await pool.query(query, params);
        res.status(200).json({ success: true, data: batches });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error fetching payroll reports' });
    }
}

async function getPayrollBatchDetails(req, res) {
    const { batchId } = req.params;
    try {
        const [batches] = await pool.query(`SELECT * FROM payrollbatches WHERE payroll_batch_id = ?`, [batchId]);
        if (!batches.length) return res.status(404).json({ success: false, message: 'Batch not found' });

        const [items] = await pool.query(`
            SELECT p.payroll_id, p.gross_salary, p.net_salary,
                   w.worker_id, w.full_name AS worker_name,
                   pi.site_id, s.site_name,
                   pi.regular_hours_worked, pi.overtime_hours_worked,
                   pi.hourly_rate_snapshot, pi.overtime_hourly_rate_snapshot,
                   pi.base_salary, pi.overtime_pay
            FROM payroll p
            JOIN workers w ON p.worker_id = w.worker_id
            JOIN payrollitems pi ON p.payroll_id = pi.payroll_id
            LEFT JOIN sites s ON pi.site_id = s.site_id
            WHERE p.payroll_batch_id = ?
        `, [batchId]);

        res.status(200).json({ success: true, batch: batches[0], workers: items });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: `Error fetching payroll details` });
    }
}

async function markBatchAsPaid(req, res) {
    const { batchId } = req.params;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query(`UPDATE payrollbatches SET status = 'Paid' WHERE payroll_batch_id = ?`, [batchId]);
        await connection.query(`UPDATE payroll SET status = 'Paid', paid_date = CURDATE() WHERE payroll_batch_id = ?`, [batchId]);
        await connection.commit();
        res.status(200).json({ success: true, message: 'Batch marked as paid' });
    } catch (error) {
        await connection.rollback();
        console.error(error);
        res.status(500).json({ success: false, message: 'Error updating payment status' });
    } finally {
        connection.release();
    }
}

async function getLastBatchEndDate(req, res) {
    try {
        const [rows] = await pool.query(
            `SELECT end_date FROM payrollbatches ORDER BY end_date DESC LIMIT 1`
        );
        if (rows.length === 0) {
            return res.status(200).json({ success: true, last_end_date: null });
        }
        res.status(200).json({ success: true, last_end_date: rows[0].end_date });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error fetching last batch end date' });
    }
}

module.exports = { 
    generatePayrollBatch, 
    getPayrollReport, 
    getPayrollBatchDetails, 
    markBatchAsPaid, 
    getLastBatchEndDate 
};