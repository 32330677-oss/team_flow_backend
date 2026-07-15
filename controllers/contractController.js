const db = require('../config/db');

// 1. جلب العقود (لا يحتاج لتعديل، هو محمي بالـ Middleware في الروتر)
exports.getContractsByProject = async (req, res) => {
    const { projectId } = req.params;
    try {
        const [rows] = await db.query(
            'SELECT * FROM Contracts WHERE project_id = ? ORDER BY created_at DESC', 
            [projectId]
        );
        return res.status(200).json({ status: 'success', data: rows });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء جلب عقود المشروع' });
    }
};

// 2. إنشاء عقد جديد (مؤمن الآن باستخدام التوكن)
exports.createContract = async (req, res) => {
    const { 
        contract_name, description, start_date, end_date, 
        project_id, hourly_rate, overtime_hourly_rate 
    } = req.body;

    // استخراج هوية المشرف من التوكن (req.user) وليس من الـ body
    const admin_id = req.user.user_id; 

    if (!contract_name || !project_id || !hourly_rate || !overtime_hourly_rate) {
        return res.status(400).json({ status: 'error', message: 'يرجى ملء كافة الحقول الأساسية وأسعار الساعات' });
    }

    try {
        const query = `
            INSERT INTO Contracts 
            (contract_name, description, start_date, end_date, project_id, hourly_rate, overtime_hourly_rate, admin_id) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const [result] = await db.query(query, [
            contract_name, description || null, start_date || null, end_date || null, 
            project_id, hourly_rate, overtime_hourly_rate, admin_id
        ]);

        return res.status(201).json({
            status: 'success',
            message: 'تم إنشاء العقد بنجاح',
            contract_id: result.insertId
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ في السيرفر أثناء إنشاء العقد' });
    }
};

// 3. تعديل العقد (محمي بالـ Middleware في الروتر)
exports.updateContract = async (req, res) => {
    const { contractId } = req.params;
    const { contract_name, description, start_date, end_date, hourly_rate, overtime_hourly_rate } = req.body;

    try {
        const query = `
            UPDATE Contracts 
            SET contract_name = ?, description = ?, start_date = ?, end_date = ?, hourly_rate = ?, overtime_hourly_rate = ? 
            WHERE contract_id = ?
        `;
        await db.query(query, [contract_name, description, start_date, end_date, hourly_rate, overtime_hourly_rate, contractId]);
        
        return res.status(200).json({ status: 'success', message: 'تم تحديث بيانات العقد بنجاح' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ status: 'error', message: 'حدث خطأ أثناء تعديل العقد' });
    }
};