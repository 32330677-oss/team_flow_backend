const express = require('express');
const router = express.Router();
const db = require('../config/db'); // نظام الـ Promises

// 1. جلب التعيينات الحقيقية من جدول workersiteassignments بربط العمال والسايتات
router.get('/', async (req, res) => {
    const query = `
        SELECT 
            wsa.assignment_id,
            wsa.worker_id,
            w.full_name AS worker_name,
            wsa.site_id,
            s.site_name AS project_name, -- اسم السايت الفعلي ليظهر للمستخدم
            wsa.assigned_date AS start_date
        FROM workersiteassignments wsa
        LEFT JOIN workers w ON wsa.worker_id = w.worker_id
        LEFT JOIN sites s ON wsa.site_id = s.site_id
    `;
    
    try {
        const [results] = await db.query(query);
        res.status(200).json({
            status: 'success',
            data: results
        });
    } catch (err) {
        console.error("❌ خطأ SQL في جلب التعيينات:", err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 2. إضافة التعيين وربطه بالسايت والعقد التابع له تلقائياً
router.post('/', async (req, res) => {
    const { worker_id, site_id, assigned_by_user_id } = req.body;

    if (!worker_id || !site_id) {
        return res.status(400).json({ status: 'fail', message: 'الحقول الأساسية ناقصة' });
    }

    try {
        // 1. جلب الـ contract_id المرتبط بهذا السايت تلقائياً من جدول sites
        const [siteData] = await db.query('SELECT contract_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
        
        if (siteData.length === 0) {
            return res.status(400).json({ status: 'fail', message: 'السايت المختار غير موجود' });
        }

        const contract_id = siteData[0].contract_id;

        if (!contract_id) {
            return res.status(400).json({ 
                status: 'fail', 
                message: 'هذا السايت غير مرتبط بأي عقد حالياً. يرجى ربطه بعقد أولاً في جدول sites' 
            });
        }

        // 2. إدخال التعيين الحقيقي في جدول التوزيع
        const query = `
            INSERT INTO workersiteassignments 
            (worker_id, site_id, contract_id, assigned_by_user_id, assigned_date, created_at, updated_at) 
            VALUES (?, ?, ?, ?, CURDATE(), NOW(), NOW())
        `;

        const [result] = await db.query(query, [
            worker_id, 
            site_id, 
            contract_id, 
            assigned_by_user_id || 1
        ]);

        res.status(201).json({ 
            status: 'success', 
            data: { assignment_id: result.insertId } 
        });

    } catch (err) {
        console.error("❌ خطأ SQL في إضافة تعيين:", err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;