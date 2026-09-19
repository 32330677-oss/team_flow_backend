const db = require('../config/db');
const { acquireCreateLock, releaseCreateLock } = require('../middleware/duplicateGuard');

// 1. جلب جميع المشاريع من جدول projects
exports.getAllProjects = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM projects ORDER BY created_at DESC');
        return res.status(200).json({
            status: 'success',
            results: rows.length,
            data: rows
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ في السيرفر أثناء جلب المشاريع' });
    }
};


exports.createProject = async (req, res) => {
    const { project_name, client_name, location } = req.body;

    if (!project_name) {
        return res.status(400).json({ status: 'error', message: 'اسم المشروع حقل مطلوب إجبارياً' });
    }

    const connection = await db.getConnection();
    const lockKey = `create_project:${project_name}`;

    try {
        const locked = await acquireCreateLock(connection, lockKey, 5);
        if (!locked) {
            return res.status(409).json({ status: 'error', message: 'طلب مشابه قيد المعالجة حالياً، الرجاء المحاولة لاحقاً' });
        }

        const [dupRows] = await connection.query(
            `SELECT project_id FROM projects
             WHERE project_name = ? AND client_name <=> ?
               AND created_at >= (NOW() - INTERVAL 10 SECOND)
             LIMIT 1`,
            [project_name, client_name || null]
        );
        if (dupRows.length > 0) {
            return res.status(409).json({ status: 'error', message: 'يبدو أن هذا المشروع تمت إضافته للتو.' });
        }

        const [result] = await connection.query(
            'INSERT INTO projects (project_name, client_name, location) VALUES (?, ?, ?)',
            [project_name, client_name || null, location || null]
        );

        return res.status(201).json({
            status: 'success',
            message: 'تم إنشاء المشروع بنجاح في النظام',
            project_id: result.insertId
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء إضافة المشروع الجديد' });
    } finally {
        await releaseCreateLock(connection, lockKey);
        connection.release();
    }
};

// 3. تعديل بيانات المشروع
exports.updateProject = async (req, res) => {
    const { id } = req.params;
    const { project_name, client_name, location } = req.body;

    if (!project_name) {
        return res.status(400).json({ status: 'error', message: 'project name is required' });
    }

    try {
        const [result] = await db.query(
            'UPDATE projects SET project_name = ?, client_name = ?, location = ? WHERE project_id = ?',

            [project_name, client_name || null, location || null, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'error', message: 'project not found' });
        }

        return res.status(200).json({
            status: 'success',
            message: 'project updated successfully'
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating project' });
    }
};

// 4. تغيير حالة المشروع (Active / Inactive)
// 4. تغيير حالة المشروع (Active / Suspended / Completed)
exports.toggleProjectStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; 

    if (!['Active', 'Completed', 'Suspended'].includes(status)) {
        return res.status(400).json({ status: 'error', message: 'Invalid status value' });
    }

    try {
        const [result] = await db.query(
            'UPDATE projects SET status = ? WHERE project_id = ?',

            [status, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'error', message: 'project not found' });
        }

        return res.status(200).json({
            status: 'success',
            message: `project status updated to ${status}`
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating project status' });
    }
};