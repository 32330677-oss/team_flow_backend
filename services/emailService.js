const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

function buildResetLink(rawToken) {
    const base = String(process.env.FRONTEND_RESET_URL || '').replace(/\/+$/, '');
    return `${base}/${rawToken}`;
}

async function sendPasswordResetEmail(toEmail, fullName, resetLink) {
    await transporter.sendMail({
        from: `"ASIK Engineering" <${process.env.SMTP_USER}>`,
        to: toEmail,
        subject: 'Password Reset Request',
        html: `
            <p>Hello ${fullName || ''},</p>
            <p>A password reset was requested for your account.</p>
            <p><a href="${resetLink}">Click here to set a new password</a></p>
            <p>This link is valid for 30 minutes only. If you did not request this, please ignore this email.</p>
        `,
    });
}

module.exports = { sendPasswordResetEmail, buildResetLink };