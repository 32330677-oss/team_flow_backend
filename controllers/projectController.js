const db = require('../config/db');

// 1. جلب جميع المشاريع من جدول Projects
exports.getAllProjects = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM Projects ORDER BY created_at DESC');
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

// 2. إنشاء مشروع جديد بناءً على الـ Schema الرسمي
exports.createProject = async (req, res) => {
    // السحب متوافق تماماً مع حقول جدولك
    const { project_name, client_name, location } = req.body;

    // التحقق من الحقل الإجباري الوحيد في جدولك وهو الاسم
    if (!project_name) {
        return res.status(400).json({ status: 'error', message: 'اسم المشروع حقل مطلوب إجبارياً' });
    }

    try {
        const query = 'INSERT INTO Projects (project_name, client_name, location) VALUES (?, ?, ?)';
        const [result] = await db.query(query, [project_name, client_name || null, location || null]);

        return res.status(201).json({
            status: 'success',
            message: 'تم إنشاء المشروع بنجاح في النظام',
            project_id: result.insertId
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء إضافة المشروع الجديد' });
    }
};

// 3. تعديل بيانات المشروع
exports.updateProject = async (req, res) => {
    const { id } = req.params;
    const { project_name, client_name, location } = req.body;

    if (!project_name) {
        return res.status(400).json({ status: 'error', message: 'Project name is required' });
    }

    try {
        const [result] = await db.query(
            'UPDATE Projects SET project_name = ?, client_name = ?, location = ? WHERE project_id = ?',
            [project_name, client_name || null, location || null, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'error', message: 'Project not found' });
        }

        return res.status(200).json({
            status: 'success',
            message: 'Project updated successfully'
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
            'UPDATE Projects SET status = ? WHERE project_id = ?',
            [status, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ status: 'error', message: 'Project not found' });
        }

        return res.status(200).json({
            status: 'success',
            message: `Project status updated to ${status}`
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'Server error while updating project status' });
    }
};