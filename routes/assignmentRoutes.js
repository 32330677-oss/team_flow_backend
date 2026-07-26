const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');
const restrictTo = require('../middleware/roleMiddleware'); // استدعاء حارس البوابة

// 1. جلب التعيينات:
// مسموح للأدمن والمشرف (يمكنك جعلها عامة إذا لزم الأمر، لكن الأفضل حمايتها)
// السماح للأدمن والمشرف برؤية التعيينات والمواقع الموزعة
router.get('/', authMiddleware, restrictTo('Admin', 'Supervisor'), async (req, res) => {
    // أضفنا شرط WHERE wsa.unassigned_date IS NULL
    const query = `
        SELECT 
            wsa.assignment_id,
            wsa.worker_id,
            w.full_name AS worker_name,
            wsa.site_id,
            s.site_name AS project_name,
            wsa.assigned_date AS start_date
        FROM workersiteassignments wsa
        LEFT JOIN workers w ON wsa.worker_id = w.worker_id
        LEFT JOIN sites s ON wsa.site_id = s.site_id
        WHERE wsa.unassigned_date IS NULL
    `;
    
    try {
        const [results] = await db.query(query);
        res.status(200).json({ status: 'success', data: results });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});
// 3. حذف التعيين:
// 3. إنهاء التعيين (Soft Delete بدلاً من DELETE):
router.delete('/:assignment_id', authMiddleware, restrictTo('Admin'), async (req, res) => {
    try {
        // بدلاً من DELETE، نقوم بعمل UPDATE لوضع تاريخ الإنهاء الحالي
        const [result] = await db.query(
            'UPDATE workersiteassignments SET unassigned_date = NOW(), updated_at = NOW() WHERE assignment_id = ? AND unassigned_date IS NULL', 
            [req.params.assignment_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ 
                status: 'fail', 
                message: 'التعيين غير موجود أو أنه منتهي بالفعل!' 
            });
        }

        res.status(200).json({ 
            status: 'success', 
            message: 'تم إنهاء تعيين العامل بنجاح وأرشفة السجل.' 
        });
    } catch (err) {
        console.error("ERROR IN UNASSIGN:", err);
        res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء إنهاء التعيين.' });
    }
});
// 2. إضافة التعيين:
// هذه عملية إدارية حساسة، يجب أن تكون محصورة بـ 'Admin' فقط
// 2. إضافة التعيين:
router.post('/', authMiddleware, restrictTo('Admin'), async (req, res) => {
    const { worker_id, site_id } = req.body;
    const assigned_by_user_id = req.user.user_id;

    if (!worker_id || !site_id) {
        return res.status(400).json({ status: 'fail', message: 'الحقول الأساسية ناقصة' });
    }

    try {
        // التحقق الشامل: هل العامل معيّن حالياً في أي موقع نشط؟
        // JOIN مع sites لجلب اسم الموقع الحالي واستخدامه داخل رسالة الخطأ
        const [activeAssignment] = await db.query(
            `SELECT wsa.assignment_id, wsa.site_id, s.site_name AS current_site_name
             FROM workersiteassignments wsa
             LEFT JOIN sites s ON wsa.site_id = s.site_id
             WHERE wsa.worker_id = ? AND wsa.unassigned_date IS NULL
             LIMIT 1`,
            [worker_id]
        );

        if (activeAssignment.length > 0) {
            const current = activeAssignment[0];

            if (current.site_id === Number(site_id)) {
                return res.status(400).json({
                    status: 'fail',
                    message: `هذا العامل معيّن بالفعل في هذا الموقع (${current.current_site_name || 'الموقع الحالي'}).`
                });
            }

            return res.status(400).json({
                status: 'fail',
                message: `هذا العامل معيّن مسبقاً في موقع "${current.current_site_name || 'غير معروف'}". يجب إنهاء تعيينه من هناك أولاً قبل نقله إلى موقع جديد.`,
                current_site_id: current.site_id,
                current_site_name: current.current_site_name
            });
        }

        const [siteData] = await db.query('SELECT contract_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
        if (siteData.length === 0) {
            return res.status(400).json({ status: 'fail', message: 'الموقع غير موجود' });
        }

        const contract_id = siteData[0].contract_id;

        const query = `
            INSERT INTO workersiteassignments 
            (worker_id, site_id, contract_id, assigned_by_user_id, assigned_date, created_at, updated_at) 
            VALUES (?, ?, ?, ?, CURDATE(), NOW(), NOW())
        `;
        const [result] = await db.query(query, [worker_id, site_id, contract_id, assigned_by_user_id]);

        res.status(201).json({ status: 'success', data: { assignment_id: result.insertId } });
    } catch (err) {
        console.error('CREATE ASSIGNMENT ERROR:', err);
        res.status(500).json({ status: 'error', message: 'حدث خطأ في السيرفر أثناء حفظ التعيين.' });
    }
});

module.exports = router;