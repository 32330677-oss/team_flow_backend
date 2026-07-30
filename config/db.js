const mysql = require('mysql2');
require('dotenv').config();

// إنشاء Pool لإدارة الاتصالات بشكل سريع ومستقر مع دعم الـ Port ديناميكياً
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306, // 👈 دعم منفذ قاعدة البيانات ديناميكياً مع قيمة افتراضية
    charset: 'utf8mb4',
    dateStrings: true,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// تحويل الـ Pool ليدعم الـ Promises لتسهيل استخدام Async/Await
const promisePool = pool.promise();

// ⚡ اختبار الاتصال فور تشغيل السيرفر للتأكد من سلامة البيانات في الـ .env
pool.getConnection((err, connection) => {
    if (err) {
        console.error('🚨 Database connection failed! Check your .env file:', err.message);
    } else {
        console.log('✅ Connected to MySQL Database successfully!');
        connection.release(); // إعادة الاتصال للـ Pool فوراً بعد نجاح الفحص
    }
});

module.exports = promisePool;