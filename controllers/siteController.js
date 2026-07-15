const db = require('../config/db');

// 1. جلب المواقع التابعة لعقد معين (يجب أن يكون المشرف هو المسؤول عن الموقع)
exports.getSitesByContract = async (req, res) => {
    const { contractId } = req.params;
    try {
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

// 2. إنشاء موقع جديد (مؤمن: يُسند تلقائياً للمشرف صاحب التوكن)
exports.createSite = async (req, res) => {
    const { site_name, location, contract_id } = req.body;
    const supervisor_id = req.user.user_id; // الهوية من التوكن حصراً

    if (!site_name || !contract_id) {
        return res.status(400).json({ status: 'error', message: 'يرجى إدخال اسم الموقع وتحديد العقد' });
    }

    try {
        const query = `
            INSERT INTO Sites (site_name, location, contract_id, supervisor_id, site_status) 
            VALUES (?, ?, ?, ?, 'Active')
        `;
        const [result] = await db.query(query, [site_name, location || null, contract_id, supervisor_id]);
        return res.status(201).json({ status: 'success', message: 'تم إنشاء الموقع بنجاح', site_id: result.insertId });
    } catch (error) {
        console.error("🚨 DATABASE ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ في السيرفر أثناء إنشاء الموقع' });
    }
};
exports.getAllSites = async (req, res) => {
    try {
        // بدون أي WHERE، جلب كل المواقع المتاحة
        const query = `
            SELECT site_id, site_name 
            FROM Sites 
            WHERE site_status = 'Active'
            ORDER BY site_name ASC
        `;
        const [rows] = await db.query(query);
        
        return res.status(200).json({ 
            status: 'success', 
            data: rows 
        });
    } catch (error) {
        console.error("خطأ في جلب المواقع للأدمن:", error);
        return res.status(500).json({ status: 'error', message: 'فشل جلب قائمة المواقع' });
    }
};
// 3. جلب مواقع المشرف الحالي فقط (هذه هي البوابة الوحيدة للمشرف لرؤية مواقعه)
exports.getMySites = async (req, res) => {
    const supervisorId = req.user.user_id; 
    try {
        const query = `
            SELECT s.*, c.contract_name, p.project_name
            FROM Sites s
            LEFT JOIN Contracts c ON s.contract_id = c.contract_id
            LEFT JOIN Projects p ON c.project_id = p.project_id
            WHERE s.supervisor_id = ? AND s.site_status = 'Active'
            ORDER BY s.created_at DESC
        `;
        const [rows] = await db.query(query, [supervisorId]);
        console.log("--- فحص بيانات المواقع ---");
console.log("عدد الصفوف المجلوبة:", rows.length);
if (rows.length > 0) {
    console.log("مثال عن أول سجل:", JSON.stringify(rows[0], null, 2));
}
console.log("--------------------------");
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error("🚨 FETCH MY SITES ERROR:", error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب مواقعك' });
    }
};