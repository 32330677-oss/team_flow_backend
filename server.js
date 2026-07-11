const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // استيراد التشفير لزرع الأدمن
const db = require('./config/db');
require('dotenv').config();

// استيراد مسارات الـ Auth
const authRoutes = require('./routes/authRoutes');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// ربط مسارات الـ Auth بالسيرفر
app.use('/api/auth', authRoutes);

// 1. فحص الاتصال بقاعدة البيانات (القديم)
app.get('/seed-admin', async (req, res) => {
    try {
        // تشفير كلمة مرور تجريبية (مثلاً: admin123)
        const hashedPassword = await bcrypt.hash('admin123', 10);
        
        // استعلام إدخال الأدمن المطابق تماماً لجدولك الحقيقي
        const sql = `
            INSERT INTO Users (username, password_hash, email, full_name, role) 
            VALUES (?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.query(sql, [
            'hamza_admin', 
            hashedPassword, 
            'hamza@teamflow.com', 
            'Hamza Ahmed Hashma', 
            'Admin' // تأكد من الحرف الكبير A
        ]);

        res.json({ 
            status: "success", 
            message: "تم زرع الأدمن الأول بنجاح في قاعدة البيانات الحقيقية!", 
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

// 2. راوت مؤقت لزرع أول مستخدم أدمن (Admin Seeder)
app.get('/seed-admin', async (req, res) => {
    try {
        // تشفير كلمة مرور تجريبية (مثلاً: admin123)
        const hashedPassword = await bcrypt.hash('admin123', 10);
        
        // استعلام إدخال الأدمن في جدول Users
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
            message: "تم زرع الأدمن الأول بنجاح في قاعدة البيانات!", 
            userId: result.insertId 
        });

    } catch (error) {
        res.status(500).json({ 
            status: "error", 
            message: "فشل زرع الأدمن (قد يكون الإيميل موجوداً مسبقاً أو هناك خطأ بأسماء الحقول)", 
            details: error.message 
        });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running beautifully on port ${PORT}`);
});