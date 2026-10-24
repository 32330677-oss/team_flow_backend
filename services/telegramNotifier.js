// services/telegramNotifier.js — short alert messages to one Telegram chat.
//
// Off unless both are set:
//   TELEGRAM_BOT_TOKEN  the bot token from @BotFather
//   TELEGRAM_CHAT_ID    the chat (person or group) that receives the alerts
//
// send() never throws and never waits for Telegram: a slow or failed alert
// must never slow down or break the request that triggered it.
// `key` + `windowMs` stop the same alert from being repeated (in memory; a
// restart of the server forgets it, which only means one extra message).

const lastSent = new Map(); // key -> time (ms) of the last message sent
const MAX_KEYS = 2000;

let transport = null; // tests replace the HTTP call with setTransport()

function config() {
    return {
        token: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
        chatId: String(process.env.TELEGRAM_CHAT_ID || '').trim(),
    };
}

function isEnabled() {
    const { token, chatId } = config();
    return Boolean(token && chatId);
}

/** true when `key` has not been sent within `windowMs` (and records it). */
function claim(key, windowMs, now = Date.now()) {
    const last = lastSent.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    if (lastSent.size >= MAX_KEYS) {
        for (const [k, t] of lastSent) if (now - t >= windowMs) lastSent.delete(k);
        if (lastSent.size >= MAX_KEYS) lastSent.clear();
    }
    lastSent.set(key, now);
    return true;
}

async function httpSend(token, chatId, text) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * Send `text` (plain text, max 4096 chars). Returns true when a message was
 * queued, false when alerts are off or the same key was sent recently.
 */
function send(text, { key = null, windowMs = 30 * 60 * 1000 } = {}) {
    if (!isEnabled()) return false;
    if (key && !claim(key, windowMs)) return false;
    const { token, chatId } = config();
    const body = String(text).slice(0, 4000);
    Promise.resolve()
        .then(() => (transport ? transport(body) : httpSend(token, chatId, body)))
        .catch((error) => console.warn('Telegram alert not sent:', error.message));
    return true;
}

module.exports = {
    isEnabled,
    send,
    // tests only
    _setTransport(fn) { transport = fn; },
    _reset() { lastSent.clear(); },
};
