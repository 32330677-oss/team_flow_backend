const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // استيراد التشفير لزرع الأدمن
const db = require('./config/db');
const contractRoutes = require('./routes/contractRoutes');
const siteRoutes = require('./routes/siteRoutes');
const workerRoutes = require('./routes/workerRoutes');
const assignmentRoutes = require('./routes/assignmentRoutes');
require('dotenv').config();

// استيراد المسارات (Routes)
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes'); // 👈 إضافة مسار المشاريع الجديد

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// ربط المسارات بالسيرفر
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes); // 👈 تفعيل الـ API الخاص بالمشاريع
app.use('/api/contracts', contractRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/assignments', assignmentRoutes);
// 1. فحص الاتصال بقاعدة البيانات وزرع الأدمن (النسخة الأولى - حقول كاملة)
app.get('/seed-admin-1', async (req, res) => {
    try {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        
        const sql = `
            INSERT INTO Users (username, password_hash, email, full_name, role) 
            VALUES (?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.query(sql, [
            'hamza_admin', 
            hashedPassword, 
            'hamza@teamflow.com', 
            'Hamza Ahmed Hashma', 
            'Admin'
        ]);

        res.json({ 
            status: "success", 
            message: "تم زرع الأدمن الأول (الخيار 1) بنجاح في قاعدة البيانات الحقيقية!", 
            userId: result.insertId 
        });

    } catch (error) {
        res.status(500).json({ 
            status: "error", 
            message: "فشل زرع الأدمن في قاعدة البيانات (الخيار 1)", 
            details: error.message 
        });
    }
});

// 2. راوت مؤقت لزرع أول مستخدم أدمن (النسخة الثانية - مع حقل status)
app.get('/seed-admin-2', async (req, res) => {
    try {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        
        const sql = `
            INSERT INTO Users (username, email, password_hash, role, status) 
            VALUES (?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.query(sql, [
            'Hamza Admin', 
            'hamza@teamflow.com', 
            hashedPassword, 
            'admin', 
            'active'
        ]);

        res.json({ 
            status: "success", 
            message: "تم زرع الأدمن الأول (الخيار 2) بنجاح في قاعدة البيانات!", 
            userId: result.insertId 
        });

    } catch (error) {
        res.status(500).json({ 
            status: "error", 
            message: "فشل زرع الأدمن (الخيار 2) (قد يكون الإيميل موجوداً مسبقاً أو هناك خطأ بأسماء الحقول)", 
            details: error.message 
        });
    }
});

const PORT = process.env.PORT || 5000;

// تشغيل السيرفر ليستقبل الاتصالات من الموبايل
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running beautifully on http://192.168.1.3:${PORT}`);
});