const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs'); 
const db = require('./config/db');
const contractRoutes = require('./routes/contractRoutes');
const siteRoutes = require('./routes/siteRoutes');
const workerRoutes = require('./routes/workerRoutes');
const assignmentRoutes = require('./routes/assignmentRoutes');
const supervisorRouter = require('./routes/supervisorRoutes');
const adminAttendanceRoutes = require('./routes/adminAttendanceRoutes');
const transferRoutes = require('./routes/transferRoutes');
const adminPayrollRoutes = require('./routes/adminPayrollRoutes');
require('dotenv').config();
if (!process.env.JWT_SECRET) {
    console.error("FATAL ERROR: JWT_SECRET environment variable is not defined.");
    process.exit(1);
}
// استيراد المسارات (Routes)
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes'); 

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// ربط المسارات بالسيرفر
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes); 
app.use('/api/contracts', contractRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/users/supervisors', supervisorRouter);
app.use('/api/attendance', require('./routes/attendanceRoutes'));
app.use('/api/admin/attendance', adminAttendanceRoutes);
app.use('/api/admin/payroll', adminPayrollRoutes);
app.use('/api/transfers', transferRoutes);
app.get('/seed-admin-secure', async (req, res) => {
     // Check if the server is running in production mode
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({
            status: "fail",
            message: "This initialization endpoint is strictly disabled in production environments."
        });
    }
    try {
        // تشفير الباسورد باستخدام bcrypt
        const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD;

if (!initialAdminPassword) {
    return res.status(500).json({
        status: "error",
        message: "Initial admin password is not configured."
    });
}

const hashedPassword = await bcrypt.hash(initialAdminPassword, 10); // استخدام كلمة المرور الآمنة الخاصة بك
        
        // التحقق أولاً لمنع تكرار الحساب
        const [existing] = await db.query('SELECT user_id FROM Users WHERE username = ?', ['hamza_admin']);
        if (existing.length > 0) {
            return res.status(400).json({
                status: "fail",
                message: "الأدمن موجود بالفعل في قاعدة البيانات!"
            });
        }

        const sql = `
            INSERT INTO Users (username, password_hash, email, full_name, role, status) 
            VALUES (?, ?, ?, ?, 'Admin', 'Active')
        `;
        
        const [result] = await db.query(sql, [
            'hamza_admin', 
            hashedPassword, 
            'hamza@teamflow.com', 
            'Hamza Ahmed Hashma'
        ]);

        res.json({ 
            status: "success", 
            message: "تم زرع الأدمن الرئيسي بنجاح وبشكل آمن تماماً!", 
            userId: result.insertId 
        });

    } catch (error) {
        res.status(500).json({ 
            status: "error", 
            message: "فشل زرع الأدمن في قاعدة البيانات", 
            details: error.message 
        });
    }
});

const PORT = process.env.PORT || 5000;

// تشغيل السيرفر على جميع الواجهات ليستقبل الاتصالات من أي جهاز في الشبكة
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running beautifully on Port: ${PORT}`);
    console.log(`👉 Local: http://localhost:${PORT}`);
    console.log(`👉 Network check: check your local computer IP to connect your Infinix phone.`);
});