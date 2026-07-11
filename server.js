const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./config/db');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json()); // لقراءة البيانات القادمة بصيغة JSON

// الـ API الخاص بفحص الاتصال بالـ DBeaver وقاعدة البيانات
app.get('/test-db', async (req, res) => {
    try {
        // استعلام مباشر (Raw SQL) للتأكد من عمل السيرفر
        const [rows] = await db.query('SELECT 1 + 1 AS result');
        res.json({ 
            status: "success", 
            message: "تم الاتصال بقاعدة البيانات workforce_db بنجاح!", 
            result: rows 
        });
    } catch (error) {
        res.status(500).json({ 
            status: "error", 
            message: "فشل الاتصال بقاعدة البيانات الحقيقية", 
            details: error.message 
        });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running beautifully on port ${PORT}`);
});