const db = require('../config/db');
const bcrypt = require('bcryptjs');

const SUPERVISOR_ROLES = ['Supervisor', 'StaffSupervisor'];
function resolveRole(value) {
    return SUPERVISOR_ROLES.includes(value) ? value : 'Supervisor';
}

// 1. List supervisors, optionally scoped by ?role=Supervisor|StaffSupervisor (default: Supervisor)
exports.getAllSupervisors = async (req, res) => {
    const role = resolveRole(req.query.role);
    try {
        const query = `
            SELECT user_id, full_name, username, role, status, created_at, last_login 
            FROM users 
            WHERE role = ?
            ORDER BY created_at DESC
        `;
        const [supervisors] = await db.query(query, [role]);

        res.status(200).json({
            status: 'success',
            results: supervisors.length,
            data: supervisors
        });
    } catch (err) {
        console.error("🚨 Error fetching supervisors:", err.message);
        res.status(500).json({
            status: 'error',
            message: 'حدث خطأ في الخادم أثناء جلب قائمة المشرفين'
        });
    }
};

// 2. Add a new supervisor. body.role optional, defaults to 'Supervisor' (Worker Supervisor)
exports.createSupervisor = async (req, res) => {
    const { full_name, username, password, email, role } = req.body;
    const targetRole = resolveRole(role);

    if (!full_name || !username || !password) {
        return res.status(400).json({
            status: 'fail',
            message: 'Please provide all required fields'
        });
    }

    try {
        const [existingUser] = await db.query('SELECT user_id FROM users WHERE username = ?', [username]);
        if (existingUser.length > 0) {
            return res.status(400).json({
                status: 'fail',
                message: 'This username is already in use'
            });
        }

        const normalizedEmail = email && String(email).trim() ? email.trim() : null;
        if (normalizedEmail) {
            const [existingEmail] = await db.query('SELECT user_id FROM users WHERE email = ?', [normalizedEmail]);
            if (existingEmail.length > 0) {
                return res.status(400).json({
                    status: 'fail',
                    message: 'This email is already in use by another account'
                });
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const insertQuery = `
            INSERT INTO users (full_name, username, password_hash, email, role, status) 
            VALUES (?, ?, ?, ?, ?, 'Active')
        `;

        const [result] = await db.query(insertQuery, [
            full_name,
            username,
            hashedPassword,
            normalizedEmail,
            targetRole
        ]);

        res.status(201).json({
            status: 'success',
            message: 'Supervisor registered successfully in the system',
            data: {
                user_id: result.insertId,
                full_name,
                username,
                email: normalizedEmail,
                role: targetRole,
                status: 'Active'
            }
        });
    } catch (err) {
        console.error("🚨 Error creating supervisor:", err);
        res.status(500).json({
            status: 'error',
            message: `Failed to insert supervisor: ${err.message}`
        });
    }
};

// 3. Update supervisor name and details (with email). Works for either supervisor role.
exports.updateSupervisor = async (req, res) => {
    const { id } = req.params;
    const { full_name, username, email } = req.body;

    if (!full_name || !username) {
        return res.status(400).json({
            status: 'fail',
            message: 'Please provide full name and username to complete the update'
        });
    }

    try {
        const [duplicateCheck] = await db.query(
            'SELECT user_id FROM users WHERE username = ? AND user_id != ?',
            [username, id]
        );
        if (duplicateCheck.length > 0) {
            return res.status(400).json({
                status: 'fail',
                message: 'The new username is already taken by another account'
            });
        }

        if (email && String(email).trim()) {
            const [emailCheck] = await db.query(
                'SELECT user_id FROM users WHERE email = ? AND user_id != ?',
                [email, id]
            );
            if (emailCheck.length > 0) {
                return res.status(400).json({
                    status: 'fail',
                    message: 'The email address is already in use by another account'
                });
            }
        }

        const updateQuery = `
            UPDATE users 
            SET full_name = ?, username = ?, email = ?
            WHERE user_id = ? AND role IN (?, ?)
        `;
        const [result] = await db.query(updateQuery, [
            full_name,
            username,
            email && String(email).trim() ? email.trim() : null,
            id,
            'Supervisor',
            'StaffSupervisor'
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                status: 'fail',
                message: 'Supervisor not found or their role has already been modified'
            });
        }

        res.status(200).json({
            status: 'success',
            message: 'Supervisor details updated successfully'
        });
    } catch (err) {
        console.error("🚨 Error updating supervisor:", err.message);
        res.status(500).json({
            status: 'error',
            message: 'An error occurred while trying to update supervisor details'
        });
    }
};

// 4. Toggle status for either supervisor role
exports.toggleSupervisorStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['Active', 'Inactive'].includes(status)) {
        return res.status(400).json({
            status: 'fail',
            message: 'الحالة المرسلة غير صالحة، يجب أن تكون Active أو Inactive'
        });
    }

    try {
        const query = `
            UPDATE users 
            SET status = ?
            WHERE user_id = ? AND role IN (?, ?)
        `;
        const [result] = await db.query(query, [status, id, 'Supervisor', 'StaffSupervisor']);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                status: 'fail',
                message: 'المشرف المستهدف غير موجود'
            });
        }

        res.status(200).json({
            status: 'success',
            message: `تم تغيير حالة حساب المشرف بنجاح إلى ${status}`
        });
    } catch (err) {
        console.error("🚨 Error toggling status:", err.message);
        res.status(500).json({
            status: 'error',
            message: 'فشل تعديل حالة حساب المشرف في قاعدة البيانات'
        });
    }
};