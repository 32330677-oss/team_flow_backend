// services/staffAttendanceService.js
// خاص بـ Staff فقط — منفصل تمامًا عن services/attendanceService.js (العمال)

function isValidDateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const [y, m, d] = String(value).split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isFriday(dateOnlyStr) {
    const d = new Date(`${dateOnlyStr}T00:00:00Z`);
    return d.getUTCDay() === 5;
}

function round2(value) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

// عدد الأيام (باستثناء الجمعة) بين تاريخين شاملين الطرفين — YYYY-MM-DD
function countNonFridayDays(startDateStr, endDateStr) {
    const start = new Date(`${startDateStr}T00:00:00Z`);
    const end = new Date(`${endDateStr}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
    let count = 0;
    const cursor = new Date(start.getTime());
    while (cursor <= end) {
        if (cursor.getUTCDay() !== 5) count += 1;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
}

function parseWallClockDateTime(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value));
    if (!match) return null;
    const [, y, mo, d, h, mi, s = '00'] = match;
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
    if (Number.isNaN(date.getTime())) return null;
    return date;
}

// خصم ساعة غداء واحدة إذا الفترة تقاطعت مع نافذة نهارية (12-13) أو ليلية (23-00)
function computeLunchDeductionHours(checkInDate, checkOutDate) {
    const HOUR_MS = 60 * 60 * 1000, DAY_MS = 24 * HOUR_MS;
    const midnight = new Date(Date.UTC(checkInDate.getUTCFullYear(), checkInDate.getUTCMonth(), checkInDate.getUTCDate()));
    const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

    const dayStart = new Date(midnight.getTime() + 12 * HOUR_MS);
    const dayEnd = new Date(midnight.getTime() + 13 * HOUR_MS);
    const nightStart = new Date(midnight.getTime() + 23 * HOUR_MS);
    const nightEnd = new Date(midnight.getTime() + DAY_MS);

    if (overlaps(checkInDate, checkOutDate, dayStart, dayEnd)) return 1;
    if (overlaps(checkInDate, checkOutDate, nightStart, nightEnd)) return 1;
    return 0;
}

/**
 * يحسب ساعات شيفت Staff الصافية مع خصم الغداء وتقسيمها إلى Regular/Overtime
 * حسب standardDailyHours لهذا اليوم بالتحديد (يدعم شيفت ليلي عابر لمنتصف الليل
 * طالما checkOutRaw أصلاً بتاريخ اليوم التالي).
 *
 * @param {Object} params
 * @param {string} params.checkInRaw   'YYYY-MM-DD HH:mm:ss'
 * @param {string} params.checkOutRaw  'YYYY-MM-DD HH:mm:ss'
 * @param {string} params.recordDate   'YYYY-MM-DD' (تاريخ الدخول = تاريخ سجل الحضور)
 * @param {number} params.standardDailyHours
 */
function calculateStaffShiftHours({ checkInRaw, checkOutRaw, recordDate, standardDailyHours }) {
    const checkIn = parseWallClockDateTime(checkInRaw);
    const checkOut = parseWallClockDateTime(checkOutRaw);
    if (!checkIn || !checkOut) throw new Error('Invalid check-in/check-out time.');
    if (!(checkOut > checkIn)) throw new Error('Check-out time must be after check-in time.');

    const grossHoursRaw = (checkOut.getTime() - checkIn.getTime()) / 3600000;
    if (grossHoursRaw > 24) throw new Error('Shift duration cannot exceed 24 hours.');

    const lunchHours = computeLunchDeductionHours(checkIn, checkOut);
    const netHours = Math.max(0, grossHoursRaw - lunchHours);

    const standard = Number(standardDailyHours) > 0 ? Number(standardDailyHours) : 8;
    const regularHours = round2(Math.min(netHours, standard));
    const overtimeHours = round2(Math.max(0, netHours - standard));

    return {
        regularHours,
        overtimeHours,
        lunchHours: round2(lunchHours),
        grossHours: round2(grossHoursRaw),
        netHours: round2(netHours),
    };
}

module.exports = {
    isValidDateOnly,
    isFriday,
    round2,
    countNonFridayDays,
    parseWallClockDateTime,
    computeLunchDeductionHours,
    calculateStaffShiftHours,
};