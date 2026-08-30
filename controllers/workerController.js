const db = require('../config/db');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

exports.uploadWorkerFiles = upload.fields([
    { name: 'personal_photo', maxCount: 1 },
    { name: 'id_photo', maxCount: 1 }
]);

// ---------------------------------------------------------
// Server-side validation — NEVER trust the frontend (section 3)
// ---------------------------------------------------------
function validateCompensationInput({ payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate }) {
    if (!['Hourly', 'Daily'].includes(payment_type)) {
        return 'payment_type must be either "Hourly" or "Daily".';
    }

    const toNumberOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    const dailyRate = toNumberOrNull(daily_rate);
    const regularRate = toNumberOrNull(regular_hourly_rate);
    const overtimeRate = toNumberOrNull(overtime_hourly_rate);

    if (payment_type === 'Hourly') {
        if (regularRate === null || !Number.isFinite(regularRate) || regularRate <= 0) {
            return 'regular_hourly_rate is required and must be a positive number for Hourly workers.';
        }
        if (overtimeRate === null || !Number.isFinite(overtimeRate) || overtimeRate <= 0) {
            return 'overtime_hourly_rate is required and must be a positive number for Hourly workers.';
        }
        if (dailyRate !== null) {
            return 'daily_rate must not be provided for Hourly workers.';
        }
    } else {
        // Daily
        if (dailyRate === null || !Number.isFinite(dailyRate) || dailyRate <= 0) {
            return 'daily_rate is required and must be a positive number for Daily workers.';
        }
        if (regularRate !== null || overtimeRate !== null) {
            return 'regular_hourly_rate and overtime_hourly_rate must not be provided for Daily workers.';
        }
    }
    return null; // valid
}

function normalizedCompensationValues(payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate) {
    if (payment_type === 'Hourly') {
        return { daily_rate: null, regular_hourly_rate: Number(regular_hourly_rate), overtime_hourly_rate: Number(overtime_hourly_rate) };
    }
    return { daily_rate: Number(daily_rate), regular_hourly_rate: null, overtime_hourly_rate: null };
}

// 1. جلب جميع العمال
exports.getAllWorkers = async (req, res) => {
    try {
        const query = 'SELECT * FROM workers ORDER BY created_at DESC';
        const [rows] = await db.query(query);

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

// 2. إضافة عامل جديد (مع الراتب من أول يوم)
exports.createWorker = async (req, res) => {
    const {
        full_name, phone_number, nationality, job_position, hire_date, notes,
        mothers_name, birth_date, birth_place, location,
        payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate
    } = req.body;

    if (!full_name) {
        return res.status(400).json({ status: 'error', message: 'Please enter the full name of the worker' });
    }

    const validationError = validateCompensationInput({ payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate });
    if (validationError) {
        return res.status(400).json({ status: 'error', message: validationError });
    }

    const comp = normalizedCompensationValues(payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate);

    const personalPhotoPath = req.files && req.files['personal_photo'] ? req.files['personal_photo'][0].path : null;
    const idPhotoPath = req.files && req.files['id_photo'] ? req.files['id_photo'][0].path : null;
    const effectiveHireDate = hire_date || new Date().toISOString().split('T')[0];

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const [result] = await connection.execute(
            `INSERT INTO workers (
                worker_unique_id, full_name, phone_number, nationality, job_position, hire_date, notes, status,
                mothers_name, birth_date, birth_place, location, personal_photo, id_photo,
                payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate
            )
            VALUES ('TEMP', ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                full_name, phone_number || null, nationality || null, job_position || null,
                effectiveHireDate, notes || null, mothers_name || null, birth_date || null,
                birth_place || null, location || null, personalPhotoPath, idPhotoPath,
                payment_type, comp.daily_rate, comp.regular_hourly_rate, comp.overtime_hourly_rate
            ]
        );

        const newId = result.insertId;
        const worker_unique_id = `W-${newId}`;
        await connection.execute('UPDATE workers SET worker_unique_id = ? WHERE worker_id = ?', [worker_unique_id, newId]);

        // First compensation history row
        await connection.execute(
            `INSERT INTO workercompensationhistory
                (worker_id, payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate,
                 job_position, effective_from, effective_to, reason, changed_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'Initial compensation on hire', ?)`,
            [newId, payment_type, comp.daily_rate, comp.regular_hourly_rate, comp.overtime_hourly_rate,
             job_position || null, effectiveHireDate, req.user.user_id]
        );

        await connection.execute(
            `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
             VALUES ('workers', ?, 'WORKER_CREATED', ?, NULL, ?)`,
            [newId, req.user.user_id, JSON.stringify({ payment_type, ...comp })]
        );

        await connection.commit();
        return res.status(201).json({
            status: 'success',
            message: 'Worker added successfully with auto ID',
            worker_unique_id,
            worker_id: newId
        });
    } catch (error) {
        await connection.rollback();
        console.error("🚨 CREATE WORKER ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Server error occurred while adding the worker' });
    } finally {
        connection.release();
    }
};

// 3. تعديل بيانات عامل (مع دعم Rate History عند تغيير الراتب/النوع/المنصب)
exports.updateWorker = async (req, res) => {
    const workerId = req.params.id; // worker_unique_id
    const uploadMiddleware = upload.fields([
        { name: 'personal_photo', maxCount: 1 },
        { name: 'id_photo', maxCount: 1 }
    ]);

    uploadMiddleware(req, res, async (err) => {
        if (err) {
            return res.status(500).json({ status: 'error', message: 'Error uploading files' });
        }

        const connection = await db.getConnection();
        try {
            const {
                full_name, phone_number, nationality, job_position, hire_date, notes, status,
                mothers_name, birth_date, birth_place, location,
                payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate,
                reason, effective_from
            } = req.body || {};

            await connection.beginTransaction();

            const [existingRows] = await connection.execute(
                'SELECT * FROM workers WHERE worker_unique_id = ? FOR UPDATE',
                [workerId]
            );
            if (existingRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ status: 'error', message: 'العامل غير موجود' });
            }
            const existing = existingRows[0];

            // Does this request touch compensation-sensitive fields?
            const touchesCompensation =
                payment_type !== undefined ||
                daily_rate !== undefined ||
                regular_hourly_rate !== undefined ||
                overtime_hourly_rate !== undefined ||
                (job_position !== undefined && job_position !== existing.job_position);

            let newPaymentType = existing.payment_type;
            let newComp = {
                daily_rate: existing.daily_rate,
                regular_hourly_rate: existing.regular_hourly_rate,
                overtime_hourly_rate: existing.overtime_hourly_rate
            };
            let newJobPosition = job_position !== undefined ? job_position : existing.job_position;

            if (touchesCompensation) {
                // Section 16: reason is mandatory for any compensation/position change
                if (!reason || !String(reason).trim()) {
                    await connection.rollback();
                    return res.status(400).json({
                        status: 'error',
                        message: 'A reason is required when changing payment type, rates, or job position.'
                    });
                }

                newPaymentType = payment_type !== undefined ? payment_type : existing.payment_type;
                const validationError = validateCompensationInput({
                    payment_type: newPaymentType,
                    daily_rate: daily_rate !== undefined ? daily_rate : (newPaymentType === 'Daily' ? existing.daily_rate : null),
                    regular_hourly_rate: regular_hourly_rate !== undefined ? regular_hourly_rate : (newPaymentType === 'Hourly' ? existing.regular_hourly_rate : null),
                    overtime_hourly_rate: overtime_hourly_rate !== undefined ? overtime_hourly_rate : (newPaymentType === 'Hourly' ? existing.overtime_hourly_rate : null),
                });
                if (validationError) {
                    await connection.rollback();
                    return res.status(400).json({ status: 'error', message: validationError });
                }

                newComp = normalizedCompensationValues(
                    newPaymentType,
                    daily_rate !== undefined ? daily_rate : existing.daily_rate,
                    regular_hourly_rate !== undefined ? regular_hourly_rate : existing.regular_hourly_rate,
                    overtime_hourly_rate !== undefined ? overtime_hourly_rate : existing.overtime_hourly_rate
                );

                const effectiveDate = effective_from || new Date().toISOString().split('T')[0];

                // Section 19: lock current active compensation row, close it, open a new one
                const [activeCompRows] = await connection.execute(
                    `SELECT compensation_id, effective_from FROM workercompensationhistory
                     WHERE worker_id = ? AND effective_to IS NULL
                     ORDER BY compensation_id DESC LIMIT 1 FOR UPDATE`,
                    [existing.worker_id]
                );

                if (activeCompRows.length > 0) {
                    const activeComp = activeCompRows[0];
                    if (effectiveDate <= activeComp.effective_from) {
                        await connection.rollback();
                        return res.status(400).json({
                            status: 'error',
                            message: 'The new effective date must be after the current compensation period start date.'
                        });
                    }
                    const closeDate = new Date(effectiveDate);
                    closeDate.setDate(closeDate.getDate() - 1);
                    const closeDateStr = closeDate.toISOString().split('T')[0];

                    await connection.execute(
                        `UPDATE workercompensationhistory SET effective_to = ? WHERE compensation_id = ?`,
                        [closeDateStr, activeComp.compensation_id]
                    );
                }

                await connection.execute(
                    `INSERT INTO workercompensationhistory
                        (worker_id, payment_type, daily_rate, regular_hourly_rate, overtime_hourly_rate,
                         job_position, effective_from, effective_to, reason, changed_by_user_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
                    [existing.worker_id, newPaymentType, newComp.daily_rate, newComp.regular_hourly_rate,
                     newComp.overtime_hourly_rate, newJobPosition, effectiveDate, reason, req.user.user_id]
                );

                await connection.execute(
                    `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
                     VALUES ('workers', ?, 'COMPENSATION_CHANGED', ?, ?, ?)`,
                    [
                        existing.worker_id, req.user.user_id,
                        JSON.stringify({
                            job_position: existing.job_position, payment_type: existing.payment_type,
                            daily_rate: existing.daily_rate, regular_hourly_rate: existing.regular_hourly_rate,
                            overtime_hourly_rate: existing.overtime_hourly_rate
                        }),
                        JSON.stringify({ job_position: newJobPosition, payment_type: newPaymentType, ...newComp, reason })
                    ]
                );
            }

            const personalPhotoPath = req.files && req.files['personal_photo']
                ? req.files['personal_photo'][0].path
                : existing.personal_photo;
            const idPhotoPath = req.files && req.files['id_photo']
                ? req.files['id_photo'][0].path
                : existing.id_photo;
            const birthDateValue = typeof birth_date === 'string' && birth_date.trim() === '' ? null : birth_date;

            await connection.execute(
                `UPDATE workers
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
                     id_photo = ?,
                     payment_type = ?,
                     daily_rate = ?,
                     regular_hourly_rate = ?,
                     overtime_hourly_rate = ?
                 WHERE worker_unique_id = ?`,
                [
                    full_name || null,
                    phone_number !== undefined ? phone_number : existing.phone_number,
                    nationality !== undefined ? nationality : existing.nationality,
                    newJobPosition,
                    hire_date || null,
                    notes !== undefined ? notes : existing.notes,
                    status || null,
                    mothers_name !== undefined ? mothers_name : existing.mothers_name,
                    birth_date !== undefined ? birthDateValue : existing.birth_date,
                    birth_place !== undefined ? birth_place : existing.birth_place,
                    location !== undefined ? location : existing.location,
                    personalPhotoPath,
                    idPhotoPath,
                    newPaymentType,
                    newComp.daily_rate,
                    newComp.regular_hourly_rate,
                    newComp.overtime_hourly_rate,
                    workerId
                ]
            );

            await connection.commit();
            return res.status(200).json({ status: 'success', message: 'updated data' });
        } catch (error) {
            await connection.rollback();
            console.error("🚨 UPDATE WORKER ERROR:", error);
            return res.status(500).json({ status: 'error', message: 'حدث خطأ في السيرفر أثناء تحديث العامل' });
        } finally {
            connection.release();
        }
    });
};

// 4. جلب سجل تاريخ الرواتب لعامل معيّن (Admin only)
exports.getCompensationHistory = async (req, res) => {
    try {
        const { id } = req.params; // worker_id (numeric)
        const [rows] = await db.execute(
            `SELECT wch.*, u.full_name AS changed_by_name
             FROM workercompensationhistory wch
             LEFT JOIN users u ON u.user_id = wch.changed_by_user_id
             WHERE wch.worker_id = ?
             ORDER BY wch.effective_from DESC`,
            [id]
        );
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("🚨 FETCH COMPENSATION HISTORY ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'Failed to load compensation history' });
    }
};