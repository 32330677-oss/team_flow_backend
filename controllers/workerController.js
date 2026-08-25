const db = require('../config/db');
const multer = require('multer');
const path = require('path');

// إعداد مكان حفظ الملفات واسمائها
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/'); // سيتم حفظ الصور في هذا المجلد
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// تعريف وتصدير الـ Middleware الخاص برفع ملفات العمال (صورتين: الشخصية وصورة الهوية)
exports.uploadWorkerFiles = upload.fields([
    { name: 'personal_photo', maxCount: 1 },
    { name: 'id_photo', maxCount: 1 }
]);

// 1. جلب جميع العمال
exports.getAllWorkers = async (req, res) => {
    try {
        const query = 'SELECT * FROM workers ORDER BY created_at DESC';
        const [rows] = await db.query(query);
        
        // تعديل مسارات الصور لتصبح رابطاً كاملاً أو مساراً صالحاً للاستعراض إذا لزم الأمر
        const processedRows = rows.map(row => {
            if (row.personal_photo && !row.personal_photo.startsWith('http')) {
                row.personal_photo = `${req.protocol}://${req.get('host')}/${row.personal_photo.replace(/\\/g, '/')}`;
            }
            if (row.id_photo && !row.id_photo.startsWith('http')) {
                row.id_photo = `${req.protocol}://${req.get('host')}/${row.id_photo.replace(/\\/g, '/')}`;
            }
            return row;
        });

        return res.status(200).json({ status: 'success', data: processedRows });
    } catch (error) {
        console.error("🚨 FETCH WORKERS ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب بيانات العمال' });
    }
};

// 2. إضافة عامل جديد (مع رفع الصور وتوليد الكود تلقائياً)
exports.createWorker = async (req, res) => {
    const { 
        full_name, phone_number, nationality, job_position, hire_date, notes,
        mothers_name, birth_date, birth_place, location 
    } = req.body;

    if (!full_name) {
        return res.status(400).json({ status: 'error', message: 'Please enter the full name of the worker' });
    }

    // استخراج مسارات الصور المرفوعة إن وجدت
    const personalPhotoPath = req.files && req.files['personal_photo'] ? req.files['personal_photo'][0].path : null;
    const idPhotoPath = req.files && req.files['id_photo'] ? req.files['id_photo'][0].path : null;

    try {
        const initialQuery = `
            INSERT INTO workers (
                worker_unique_id, full_name, phone_number, nationality, job_position, hire_date, notes, status,
                mothers_name, birth_date, birth_place, location, personal_photo, id_photo
            ) 
            VALUES ('TEMP', ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?)
        `;
        
        const [result] = await db.query(initialQuery, [
            full_name,
            phone_number || null,
            nationality || null,
            job_position || null,
            hire_date || new Date().toISOString().split('T')[0],
            notes || null,
            mothers_name || null,
            birth_date || null,
            birth_place || null,
            location || null,
            personalPhotoPath,
            idPhotoPath
        ]);

        const newId = result.insertId; 
        const worker_unique_id = `W-${newId}`; 

        await db.query('UPDATE workers SET worker_unique_id = ? WHERE worker_id = ?', [worker_unique_id, newId]);

        return res.status(201).json({
            status: 'success',
            message: 'Worker added successfully and unique ID generated',
            worker_unique_id: worker_unique_id,
            worker_id: newId
        });
    } catch (error) {
        console.error("🚨 CREATE WORKER ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Server error occurred while adding the worker' });
    }
};

// 3. تعديل بيانات عامل (مع دعم تحديث الصور أيضاً)
exports.updateWorker = async (req, res) => {
    const workerId = req.params.id; // worker_unique_id
    const { 
        full_name, phone_number, nationality, job_position, hire_date, notes, status,
        mothers_name, birth_date, birth_place, location 
    } = req.body;

    // استخدام الـ middleware الخاص برفع الملفات أثناء التعديل أيضاً إذا أردت، أو استقبالها من الـ body
    // هنا سنفترض أن التعديل قد يدعم الملفات المرفوعة عبر Multer إذا تم تمريرها
    const uploadMiddleware = upload.fields([
        { name: 'personal_photo', maxCount: 1 },
        { name: 'id_photo', maxCount: 1 }
    ]);

    uploadMiddleware(req, res, async (err) => {
        if (err) {
            return res.status(500).json({ status: 'error', message: 'Error uploading files' });
        }

        try {
            const [existing] = await db.query('SELECT * FROM workers WHERE worker_unique_id = ?', [workerId]);
            if (existing.length === 0) {
                return res.status(404).json({ status: 'error', message: 'العامل غير موجود' });
            }

            const personalPhotoPath = req.files && req.files['personal_photo'] 
                ? req.files['personal_photo'][0].path 
                : existing[0].personal_photo;

            const idPhotoPath = req.files && req.files['id_photo'] 
                ? req.files['id_photo'][0].path 
                : existing[0].id_photo;

            const query = `
                UPDATE workers 
                SET full_name = COALESCE(?, full_name),
                    phone_number = ?,
                    nationality = ?,
                    job_position = ?,
                    hire_date = COALESCE(?, hire_date),
                    notes = ?,
                    status = COALESCE(?, status),
                    mothers_name = ?,
                    birth_date = ?,
                    birth_place = ?,
                    location = ?,
                    personal_photo = ?,
                    id_photo = ?
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
                mothers_name !== undefined ? mothers_name : existing[0].mothers_name,
                birth_date !== undefined ? birth_date : existing[0].birth_date,
                birth_place !== undefined ? birth_place : existing[0].birth_place,
                location !== undefined ? location : existing[0].location,
                personalPhotoPath,
                idPhotoPath,
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
    });
};

