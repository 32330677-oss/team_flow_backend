const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.login = async (req, res) => {
    // 1. Receive identifier (email or username) along with password and device_id
    const loginIdentifier = req.body.email || req.body.username;
    const { password, device_id } = req.body;

    if (!loginIdentifier || !password) {
        return res.status(400).json({ 
            status: "error", 
            message: "Please enter username/email and password" 
        });
    }

    try {
        // 2. Smart search: matches either username or email
        const query = `
            SELECT user_id, username, password_hash, email, full_name, role, status 
            FROM Users 
            WHERE username = ? OR email = ?
        `;
        const [users] = await db.query(query, [loginIdentifier, loginIdentifier]);
        
        if (users.length === 0) {
            return res.status(401).json({ 
                status: "error", 
                message: "Invalid username/email or password" 
            });
        }

        const user = users[0];

        // 3. Real check of account status
        if (user.status === 'Inactive') {
            return res.status(403).json({ 
                status: "error", 
                message: "This account is currently deactivated by management" 
            });
        }

        // 4. Flexible password verification (supports old and new hashes to prevent locking admin accounts)
        let isMatch = false;
        if (user.password_hash.startsWith('$2a$') || user.password_hash.startsWith('$2b$')) {
            isMatch = await bcrypt.compare(password, user.password_hash);
        } else {
            isMatch = (password === user.password_hash);
        }

        if (!isMatch) {
            // Log failed login attempt in loginhistory (success = 0) with device_id
            await db.query(
                `INSERT INTO loginhistory (user_id, device_id, user_agent, success) VALUES (?, ?, ?, ?)`,
                [user.user_id, device_id || null, req.headers['user-agent'] || '', 0]
            );

            return res.status(401).json({ 
                status: "error", 
                message: "Invalid username/email or password" 
            });
        }

        // 5. Generate JWT with a fallback secret to prevent server crash
        const jwtSecret = process.env.JWT_SECRET || 'teamflow_super_secure_fallback_key';
        const token = jwt.sign(
            { user_id: user.user_id, role: user.role },
            jwtSecret,
            { expiresIn: '24h' }
        );

        // 6. Update last login time in the database
        await db.query('UPDATE Users SET last_login = NOW() WHERE user_id = ?', [user.user_id]);

        // 7. Log successful login attempt in loginhistory (success = 1) with device_id
        await db.query(
            `INSERT INTO loginhistory (user_id, device_id, user_agent, success) VALUES (?, ?, ?, ?)`,
            [user.user_id, device_id || null, req.headers['user-agent'] || '', 1]
        );

        // 8. Return successful response
        res.json({
            status: "success",
            message: "Login successful",
            token,
            user: {
                id: user.user_id,
                username: user.username,
                full_name: user.full_name,
                email: user.email,
                role: user.role,
                status: user.status
            }
        });

    } catch (error) {
        console.error("🚨 Login Server Error:", error);
        res.status(500).json({ 
            status: "error", 
            message: "A server error occurred while processing login", 
            details: error.message 
        });
    }
};