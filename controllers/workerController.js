const db = require('../config/db');

// 1. جلب جميع العمال (Get All Workers)
exports.getAllWorkers = async (req, res) => {
    try {
        const query = 'SELECT * FROM workers ORDER BY created_at DESC';
        const [rows] = await db.query(query);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("🚨 FETCH WORKERS ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب بيانات العمال' });
    }
};

// 2. إضافة عامل جديد (Create Worker)
exports.createWorker = async (req, res) => {
    const { worker_unique_id, full_name, phone_number, nationality, job_position, hire_date, notes } = req.body;

    // التحقق من الحقول الإجبارية
    if (!worker_unique_id || !full_name) {
        return res.status(400).json({ status: 'error', message: 'يرجى إدخال كود العامل واسمه بالكامل' });
    }

    try {
        const query = `
            INSERT INTO workers (worker_unique_id, full_name, phone_number, nationality, job_position, hire_date, notes, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, 'Active')
        `;
        const [result] = await db.query(query, [
            worker_unique_id,
            full_name,
            phone_number || null,
            nationality || null,
            job_position || null,
            hire_date || new Date().toISOString().split('T')[0], // التاريخ الحالي إذا لم يُرسل
            notes || null
        ]);

        return res.status(201).json({
            status: 'success',
            message: 'تم إضافة العامل بنجاح',
            worker_id: result.insertId
        });
    } catch (error) {
        console.error("🚨 CREATE WORKER ERROR:", error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ status: 'error', message: 'كود العامل مسجل مسبقاً، يرجى استخدام كود فريد' });
        }
        return res.status(500).json({ status: 'error', message: 'حدث خطأ في السيرفر أثناء إضافة العامل' });
    }
};