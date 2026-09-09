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

async function sendPasswordResetOtp(toEmail, fullName, otp) {
    await transporter.sendMail({
        from: `"ASIK Engineering" <${process.env.SMTP_USER}>`,
        to: toEmail,
        subject: 'Password Reset Code',
        html: `
            <p>Hello ${fullName || ''},</p>
            <p>A password reset was requested for your account.</p>
            <p>Your verification code is:</p>
            <p style="font-size:28px; font-weight:bold; letter-spacing:4px;">${otp}</p>
            <p>This code is valid for 10 minutes only. If you did not request this, please ignore this email.</p>
        `,
    });
}

module.exports = { sendPasswordResetOtp };