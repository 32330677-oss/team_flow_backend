const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

// 1. جلب التعيينات (تم تركها بدون Auth إذا كنت تحتاج عرضها للجميع، 
//    ويمكنك إضافة authMiddleware لها إذا أردت حمايتها)
router.get('/', async (req, res) => {
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

// 2. إضافة التعيين (تم حمايته بـ authMiddleware واعتماد التوكن للهوية)
router.post('/', authMiddleware, async (req, res) => {
    const { worker_id, site_id } = req.body;
    
    // استخراج هوية المستخدم من التوكن الذي يفككه الميدل وير
    const assigned_by_user_id = req.user.user_id;

    if (!worker_id || !site_id) {
        return res.status(400).json({ status: 'fail', message: 'الحقول الأساسية ناقصة' });
    }

    try {
        // 1. جلب الـ contract_id المرتبط بهذا السايت
        const [siteData] = await db.query('SELECT contract_id FROM sites WHERE site_id = ? LIMIT 1', [site_id]);
        
        if (siteData.length === 0) {
            return res.status(400).json({ status: 'fail', message: 'السايت المختار غير موجود' });
        }

        const contract_id = siteData[0].contract_id;

        if (!contract_id) {
            return res.status(400).json({ 
                status: 'fail', 
                message: 'هذا السايت غير مرتبط بأي عقد حالياً.' 
            });
        }

        // 2. إدخال التعيين الحقيقي
        const query = `
            INSERT INTO workersiteassignments 
            (worker_id, site_id, contract_id, assigned_by_user_id, assigned_date, created_at, updated_at) 
            VALUES (?, ?, ?, ?, CURDATE(), NOW(), NOW())
        `;

        const [result] = await db.query(query, [
            worker_id, 
            site_id, 
            contract_id, 
            assigned_by_user_id // هنا نستخدم الـ ID المستخرج من التوكن
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