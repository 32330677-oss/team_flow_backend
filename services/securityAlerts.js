// services/securityAlerts.js — Telegram alerts about suspicious logins.
//
//   1. Many failed logins on ONE account (since its last successful login,
//      within the last 15 minutes): 3 for an Admin, 5 for anyone else.
//   2. One IP blocked by the login rate limiter (many failed logins, any
//      usernames, including names that do not exist).
//   3. An Admin logged in from a device not seen before for that account.
//      The device is the app's install id (`device_id`) when the app sends
//      it, otherwise the browser/app user agent.
//
// Every function here is best-effort: it never throws and never changes the
// login result. With TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset it does
// nothing at all (not even a database query).
//
// Optional settings:
//   SECURITY_ALERT_FAILED_LOGINS        default 5
//   SECURITY_ALERT_FAILED_LOGINS_ADMIN  default 3
//   SECURITY_ALERT_NEW_DEVICE_ROLES     default "Admin" (comma separated)

const telegram = require('./telegramNotifier');

const WINDOW_MINUTES = 15;
const REPEAT_WINDOW_MS = 30 * 60 * 1000;

function positiveInt(name, def) {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n > 0 ? n : def;
}

function settings() {
    return {
        failed: positiveInt('SECURITY_ALERT_FAILED_LOGINS', 5),
        failedAdmin: positiveInt('SECURITY_ALERT_FAILED_LOGINS_ADMIN', 3),
        newDeviceRoles: String(process.env.SECURITY_ALERT_NEW_DEVICE_ROLES || 'Admin')
            .split(',').map((s) => s.trim()).filter(Boolean),
    };
}

function db() {
    // Loaded lazily so the pure helpers below can be unit-tested without a database.
    return require('../config/db');
}

/** Short description of a user agent ("Chrome على Windows", "تطبيق Team Flow"). */
function describeDevice(userAgent) {
    const ua = String(userAgent || '');
    if (!ua) return 'غير معروف';
    if (/^Dart\//.test(ua)) return 'تطبيق Team Flow';
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /OPR\//.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari'
        : null;
    const os = /Windows/.test(ua) ? 'Windows'
        : /Android/.test(ua) ? 'Android'
        : /iPhone|iPad/.test(ua) ? 'iPhone/iPad'
        : /Mac OS X/.test(ua) ? 'Mac'
        : /Linux/.test(ua) ? 'Linux'
        : null;
    if (browser && os) return `${browser} على ${os}`;
    return browser || os || ua.slice(0, 60);
}

/** Business wall-clock time, e.g. "2026-10-24 18:05". */
function nowText(date = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: process.env.APP_TIME_ZONE || 'Asia/Damascus',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Clean device id from the request body (string, max 100 chars) or null. */
function normalizeDeviceId(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().slice(0, 100);
    return v || null;
}

function clip(value, max = 60) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max) || '-';
}

function accountLine(user) {
    const name = user.full_name ? ` (${clip(user.full_name)})` : '';
    return `${clip(user.username)}${name} - ${clip(user.role, 30)}`;
}

function failedLoginsMessage(user, count, req) {
    return [
        'Team Flow - تنبيه أمني',
        `محاولات دخول فاشلة: ${count} خلال آخر ${WINDOW_MINUTES} دقيقة`,
        `الحساب: ${accountLine(user)}`,
        `الجهاز: ${describeDevice(req.headers['user-agent'])}`,
        `IP: ${clip(req.ip, 45)}`,
        `الوقت: ${nowText()}`,
        user.role === 'Admin'
            ? 'إذا ما كنت انت: غيّر كلمة السر فوراً.'
            : 'إذا ما كان صاحب الحساب: تواصل معه وغيّر كلمة السر.',
    ].join('\n');
}

function ipBlockedMessage(req) {
    const tried = (req.body && (req.body.email || req.body.username)) || '';
    return [
        'Team Flow - تنبيه أمني',
        'انمنع الدخول 15 دقيقة: محاولات فاشلة كتير من نفس الـ IP',
        `IP: ${clip(req.ip, 45)}`,
        `آخر اسم مستخدم انجرّب: ${clip(tried)}`,
        `الجهاز: ${describeDevice(req.headers['user-agent'])}`,
        `الوقت: ${nowText()}`,
    ].join('\n');
}

function newDeviceMessage(user, req, firstLogin) {
    return [
        'Team Flow - تنبيه أمني',
        firstLogin ? `أول دخول لحساب ${clip(user.role, 30)}` : `دخول حساب ${clip(user.role, 30)} من جهاز جديد`,
        `الحساب: ${accountLine(user)}`,
        `الجهاز: ${describeDevice(req.headers['user-agent'])}`,
        `IP: ${clip(req.ip, 45)}`,
        `الوقت: ${nowText()}`,
        'إذا ما كنت انت: غيّر كلمة السر فوراً.',
    ].join('\n');
}

/**
 * Call AFTER the failed attempt is written to loginhistory.
 * Not awaited by the caller.
 */
async function failedLogin(user, req) {
    try {
        if (!telegram.isEnabled() || !user) return;
        const s = settings();
        const threshold = user.role === 'Admin' ? s.failedAdmin : s.failed;
        const [[row]] = await db().query(
            `SELECT COUNT(*) AS n
             FROM loginhistory
             WHERE user_id = ? AND success = 0
               AND login_time >= NOW() - INTERVAL ${WINDOW_MINUTES} MINUTE
               AND login_id > COALESCE((SELECT MAX(login_id) FROM loginhistory WHERE user_id = ? AND success = 1), 0)`,
            [user.user_id, user.user_id]
        );
        const count = Number(row && row.n) || 0;
        if (count < threshold) return;
        telegram.send(failedLoginsMessage(user, count, req), { key: `failed:${user.user_id}`, windowMs: REPEAT_WINDOW_MS });
    } catch (error) {
        console.warn('Security alert (failed logins) skipped:', error.message);
    }
}

/** Called by the login rate limiter when it blocks an IP. */
function ipBlocked(req) {
    try {
        telegram.send(ipBlockedMessage(req), { key: `ip:${req.ip}`, windowMs: REPEAT_WINDOW_MS });
    } catch (error) {
        console.warn('Security alert (IP blocked) skipped:', error.message);
    }
}

/**
 * Call on a successful login BEFORE the success row is written to
 * loginhistory (it compares with the earlier successful logins).
 */
async function successfulLogin(user, req, deviceId) {
    try {
        if (!telegram.isEnabled() || !user) return;
        if (!settings().newDeviceRoles.includes(user.role)) return;
        const ua = String(req.headers['user-agent'] || '');
        const [[row]] = await db().query(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN ${deviceId ? 'device_id = ?' : 'device_id IS NULL AND user_agent = ?'} THEN 1 ELSE 0 END) AS same_device
             FROM loginhistory
             WHERE user_id = ? AND success = 1`,
            [deviceId || ua, user.user_id]
        );
        const total = Number(row && row.total) || 0;
        const sameDevice = Number(row && row.same_device) || 0;
        if (sameDevice > 0) return;
        const deviceKey = deviceId || ua;
        telegram.send(newDeviceMessage(user, req, total === 0), {
            key: `device:${user.user_id}:${deviceKey}`, windowMs: REPEAT_WINDOW_MS,
        });
    } catch (error) {
        console.warn('Security alert (new device) skipped:', error.message);
    }
}

module.exports = {
    failedLogin,
    ipBlocked,
    successfulLogin,
    normalizeDeviceId,
    describeDevice,
    // exported for tests
    _messages: { failedLoginsMessage, ipBlockedMessage, newDeviceMessage },
};
