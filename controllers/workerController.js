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


// 3. تعديل بيانات عامل أو تغيير حالته (Update Worker)
// 3. تعديل بيانات عامل أو تغيير حالته (Update Worker)
exports.updateWorker = async (req, res) => {
    const workerId = req.params.id; // هنا سيصل الـ worker_unique_id (مثل 'تيست')
    const { full_name, phone_number, nationality, job_position, hire_date, notes, status } = req.body;

    try {
        // التحقق مما إذا كان العامل موجوداً باستخدام worker_unique_id
        const [existing] = await db.query('SELECT * FROM workers WHERE worker_unique_id = ?', [workerId]);
        if (existing.length === 0) {
            return res.status(404).json({ status: 'error', message: 'العامل غير موجود' });
        }

        // بناء استعلام التعديل
        const query = `
            UPDATE workers 
            SET full_name = COALESCE(?, full_name),
                phone_number = ?,
                nationality = ?,
                job_position = ?,
                hire_date = COALESCE(?, hire_date),
                notes = ?,
                status = COALESCE(?, status)
            WHERE worker_unique_id = ?
        `;

        await db.query(query, [
            full_name || null,
            phone_number !== undefined ? phone_number : existing[0].phone_number,
            nationality !== undefined ? nationality : existing[0].nationality,
            job_position !== undefined ? job_position : existing[0].job_position,
            hire_date || null,
            notes !== undefined ? notes : existing[0].notes,
            status || null,
            workerId
        ]);

        return res.status(200).json({
            status: 'success',
            message: 'تم تحديث بيانات العامل بنجاح'
        });
    } catch (error) {
        console.error("🚨 UPDATE WORKER ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ في السيرفر أثناء تحديث العامل' });
    }
};