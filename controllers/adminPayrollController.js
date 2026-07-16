const db = require('../config/db');

exports.getPayrollReport = async (req, res) => {
    try {
        // هون رح نحط منطق حساب الرواتب لاحقاً
        res.status(200).json({ status: 'success', data: "تقرير الرواتب قريباً" });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
};