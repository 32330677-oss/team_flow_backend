// services/staffEmploymentService.js
//
// يعيد بناء فترات التوظيف الفعلية (Active spans) لموظف الإداري من
// staff_status_history بدل الاعتماد على زوج hire_date/termination_date
// الوحيد. هذا يحل مشكلتين:
// 1) تعليم موظف "Inactive" كان يخفيه من أي توليد/إعادة توليد لرواتب
//    فترات قديمة كان فيها فعلاً شغال ومعتمد له حضور.
// 2) إنهاء ثم إعادة تفعيل (Terminated -> Active) كان يفقد النظام معرفة
//    أن هذا موظف قديم رجع، وقد يُحسب راتب فترة تقع داخل فجوة الانقطاع
//    وكأنه كان موظفاً طوال الوقت.

const db = require('../config/db');

function toDateOnly(value) {
    if (!value) return null;
    return String(value).slice(0, 10);
}

function subtractOneDay(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

/**
 * يبني قائمة فترات "Active" الكاملة لموظف معيّن، بالترتيب الزمني.
 * end === null تعني أن الفترة ما زالت مستمرة حتى الآن.
 */
async function getActiveSpans(staffId, executor = db) {
    const [staffRows] = await executor.execute(
        `SELECT hire_date, first_hire_date FROM staff_members WHERE staff_id = ? LIMIT 1`,
        [staffId]
    );
    if (staffRows.length === 0) return [];

    // first_hire_date هو المرساة الثابتة؛ hire_date احتياطي للموظفين
    // القدامى الذين أُنشئوا قبل إضافة هذا العمود.
    const anchor = toDateOnly(staffRows[0].first_hire_date) || toDateOnly(staffRows[0].hire_date);
    if (!anchor) return [];

    const [history] = await executor.execute(
        `SELECT new_status, effective_date
         FROM staff_status_history
         WHERE staff_id = ?
         ORDER BY effective_date ASC, status_history_id ASC`,
        [staffId]
    );

    const spans = [];
    let cursorDate = anchor;
    let cursorStatus = 'Active'; // كل موظف يبدأ Active عند التوظيف

    for (const row of history) {
        const rowDate = toDateOnly(row.effective_date);
        if (!rowDate) continue;

        if (cursorStatus === 'Active') {
            const lastActiveDay = subtractOneDay(rowDate);
            if (lastActiveDay >= cursorDate) {
                spans.push({ start: cursorDate, end: lastActiveDay });
            }
        }
        cursorStatus = row.new_status;
        cursorDate = rowDate;
    }

    if (cursorStatus === 'Active') {
        spans.push({ start: cursorDate, end: null }); // ما زال Active الآن
    }

    return spans;
}

/**
 * يرجّع فترات Active المتقاطعة فقط مع [periodStart, periodEnd]، مقصوصة
 * على حدود الفترة المطلوبة (وأبداً بعد اليوم الحالي).
 */
async function getActiveSpansOverlapping(staffId, periodStart, periodEnd, executor = db) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const clampedPeriodEnd = periodEnd > todayStr ? todayStr : periodEnd;
    if (periodStart > clampedPeriodEnd) return [];

    const spans = await getActiveSpans(staffId, executor);
    const overlapping = [];

    for (const span of spans) {
        const spanEnd = span.end || clampedPeriodEnd;
        const clippedStart = span.start > periodStart ? span.start : periodStart;
        const clippedEnd = spanEnd < clampedPeriodEnd ? spanEnd : clampedPeriodEnd;
        if (clippedStart <= clippedEnd) {
            overlapping.push({ start: clippedStart, end: clippedEnd });
        }
    }
    return overlapping;
}

/** true إذا كان للموظف أكثر من فترة Active واحدة (أي انتهى ثم رجع). */
async function isReturningEmployee(staffId, executor = db) {
    const spans = await getActiveSpans(staffId, executor);
    return spans.length > 1;
}

module.exports = { getActiveSpans, getActiveSpansOverlapping, isReturningEmployee };