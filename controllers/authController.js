const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendPasswordResetEmail, buildResetLink } = require('../services/emailService');
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
            FROM users 
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
        const jwtSecret = process.env.JWT_SECRET;
        const token = jwt.sign(
            { user_id: user.user_id, role: user.role },
            jwtSecret,
            { expiresIn: '24h' }
        );

        // 6. Update last login time in the database
        await db.query('UPDATE users SET last_login = NOW() WHERE user_id = ?', [user.user_id]);

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


// ---------------------------------------------------------------------
// Helper: parse MySQL DATETIME strings safely.
// config/db.js sets dateStrings: true, so password_reset_expires comes
// back as 'YYYY-MM-DD HH:mm:ss', not a Date object — new Date() on that
// exact format is fine in Node/V8, but we parse explicitly to avoid
// relying on implicit engine behavior and to match the pattern used
// elsewhere in this codebase (see attendanceController.js).
// ---------------------------------------------------------------------
function parseMySqlDateTime(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value));
    if (!match) return null;
    const [, y, mo, d, h, mi, s] = match;
    return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

const PASSWORD_MIN_LENGTH = 8;

// 1) Request a password reset (sends the email)
exports.forgotPassword = async (req, res) => {
    const { email } = req.body;
    if (!email || !String(email).trim()) {
        return res.status(400).json({ status: 'error', message: 'Please provide an email address' });
    }

    try {
        const [users] = await db.query(
            'SELECT user_id, full_name, email FROM users WHERE email = ? LIMIT 1',
            [email]
        );

        // Always return the same response whether or not the email exists,
        // to avoid leaking which addresses are registered (timing is close
        // enough here since both branches hit the DB and neither does bcrypt).
        const genericResponse = {
            status: 'success',
            message: 'If this email is registered, a password reset link has been sent.'
        };

        if (users.length === 0) {
            return res.status(200).json(genericResponse);
        }

        const user = users[0];
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expires = new Date(Date.now() + 30 * 60 * 1000); // valid for 30 minutes

        await db.query(
            'UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE user_id = ?',
            [hashedToken, expires, user.user_id]
        );

        await db.query(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('users', ?, 'PASSWORD_RESET_REQUESTED', ?, NULL, ?)`,
            [user.user_id, user.user_id, JSON.stringify({ email: user.email })]
        );

        const resetLink = buildResetLink(rawToken);

        try {
            await sendPasswordResetEmail(user.email, user.full_name, resetLink);
        } catch (mailError) {
            // The token is already saved; a resend will simply overwrite it.
            // We still return the generic success message to the caller so
            // we don't leak account existence, but we log the real failure.
            console.error('FORGOT PASSWORD - EMAIL SEND FAILED:', mailError);
        }

        return res.status(200).json(genericResponse);
    } catch (error) {
        console.error('FORGOT PASSWORD ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while processing the password reset request' });
    }
};

// 2) Perform the reset (after clicking the emailed link)
exports.resetPassword = async (req, res) => {
    const { token } = req.params;
    const { new_password } = req.body;

    if (!token) {
        return res.status(400).json({ status: 'error', message: 'Reset token is required' });
    }
    if (!new_password || new_password.length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({ status: 'error', message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    }

    try {
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        const [users] = await db.query(
            'SELECT user_id, password_reset_expires FROM users WHERE password_reset_token = ? LIMIT 1',
            [hashedToken]
        );

        const expiresAt = users.length > 0 ? parseMySqlDateTime(users[0].password_reset_expires) : null;

        if (users.length === 0 || !expiresAt || expiresAt < new Date()) {
            return res.status(400).json({ status: 'error', message: 'This reset link is invalid or has expired' });
        }

        const hashedPassword = await bcrypt.hash(new_password, 12);

        await db.query(
            `UPDATE users
             SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL
             WHERE user_id = ?`,
            [hashedPassword, users[0].user_id]
        );

        await db.query(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('users', ?, 'PASSWORD_RESET_COMPLETED', ?, NULL, NULL)`,
            [users[0].user_id, users[0].user_id]
        );

        return res.status(200).json({ status: 'success', message: 'Password has been reset successfully' });
    } catch (error) {
        console.error('RESET PASSWORD ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while resetting the password' });
    }
};

// 3) Change password while logged in
exports.changePassword = async (req, res) => {
    const { current_password, new_password } = req.body;
    const userId = req.user.user_id;

    if (!current_password || !new_password || new_password.length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({
            status: 'error',
            message: `Please provide your current password and a new password of at least ${PASSWORD_MIN_LENGTH} characters`
        });
    }
    if (current_password === new_password) {
        return res.status(400).json({ status: 'error', message: 'New password must be different from the current password' });
    }

    try {
        const [users] = await db.query('SELECT password_hash FROM users WHERE user_id = ? LIMIT 1', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ status: 'error', message: 'User not found' });
        }

        const isMatch = await bcrypt.compare(current_password, users[0].password_hash);
        if (!isMatch) {
            return res.status(401).json({ status: 'error', message: 'Current password is incorrect' });
        }

        const hashedPassword = await bcrypt.hash(new_password, 12);
        await db.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hashedPassword, userId]);

        await db.query(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('users', ?, 'PASSWORD_CHANGED', ?, NULL, NULL)`,
            [userId, userId]
        );

        return res.status(200).json({ status: 'success', message: 'Password changed successfully' });
    } catch (error) {
        console.error('CHANGE PASSWORD ERROR:', error);
        return res.status(500).json({ status: 'error', message: 'An error occurred while changing the password' });
    }
};