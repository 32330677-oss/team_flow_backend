const db = require('../config/db'); // حسب مسار قاعدة البيانات عندك

let cache = null; 
let isLoading = null; 

async function loadFromDb() {
    const [rows] = await db.execute(
        'SELECT setting_key, setting_value FROM system_settings'
    );
    const map = {};
    for (const row of rows) {
        map[row.setting_key] = row.setting_value;
    }
    return map;
}

// جلب الإعداد (مع قيمة افتراضية احتياطية)
async function getSetting(key, fallback) {
    if (!cache) await refresh();
    return cache[key] !== undefined ? cache[key] : fallback;
}

// تحديث الـ Cache فوراً بعد أي تعديل من الأدمن
async function refresh() {
    if (isLoading) return isLoading; 
    isLoading = loadFromDb().then(map => {
        cache = map;
        isLoading = null;
        return map;
    });
    return isLoading;
}

module.exports = { getSetting, refresh };