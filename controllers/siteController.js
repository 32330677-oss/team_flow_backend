const db = require('../config/db');

// 1. جلب المواقع التابعة لعقد معين (List Sites)
// 1. جلب المواقع التابعة لعقد معين مع اسم المشرف الصحيح
exports.getSitesByContract = async (req, res) => {
    const { contractId } = req.params;
    try {
        // الربط الصحيح باستخدام u.full_name بناءً على هيكلية جدولك
        const query = `
            SELECT s.*, u.full_name AS supervisor_name 
            FROM Sites s
            LEFT JOIN Users u ON s.supervisor_id = u.user_id
            WHERE s.contract_id = ? 
            ORDER BY s.created_at DESC
        `;
        const [rows] = await db.query(query, [contractId]);
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("🚨 FETCH ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب مواقع العقد' });
    }
};

// 2. إنشاء موقع جديد (Create Site)
exports.createSite = async (req, res) => {
    // 👈 استقبلنا الأسامي الجديدة القادمة من الفرونت إند
    const { site_name, location, contract_id, supervisor_id } = req.body;

    if (!site_name || !contract_id) {
        return res.status(400).json({ status: 'error', message: 'يرجى إدخال اسم الموقع وتحديد العقد' });
    }

    try {
        // 👈 تم تعديل أسماء الأعمدة لتطابق الجدول تماماً: location و site_status
        const query = `
            INSERT INTO Sites (site_name, location, contract_id, supervisor_id, site_status) 
            VALUES (?, ?, ?, ?, 'Active')
        `;
        const [result] = await db.query(query, [
            site_name, 
            location || null, 
            contract_id, 
            supervisor_id || null
        ]);

        return res.status(201).json({
            status: 'success',
            message: 'تم إنشاء الموقع بنجاح',
            site_id: result.insertId
        });
    } catch (error) {
        console.error("🚨 DATABASE ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ في السيرفر أثناء إنشاء الموقع' });
    }
};