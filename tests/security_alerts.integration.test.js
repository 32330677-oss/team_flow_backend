// tests/security_alerts.integration.test.js
//
// Telegram security alerts on login (services/securityAlerts.js).
// Proves: alerts fire at the right count / on a new Admin device only, are not
// repeated, never change the login response, and a broken Telegram call
// cannot break login. The real Telegram API is never called (transport stub).
// Run:  npm test   (requires a local MySQL; see tests/helpers.js)
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHAT_ID = '12345';

const { resetDatabase, startServer, stopServer, q } = require('./helpers');
const telegram = require('../services/telegramNotifier');

let base;
let sent = [];

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DART = 'Dart/3.5 (dart:io)';

async function login(username, password, { deviceId, ua = CHROME_WIN } = {}) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
    body: JSON.stringify({ username, password, ...(deviceId !== undefined ? { device_id: deviceId } : {}) }),
  });
  return { status: res.status, body: await res.json() };
}

// Alerts are sent without waiting; give the background query a moment.
const settle = () => new Promise((r) => setTimeout(r, 150));

test.before(async () => {
  resetDatabase({ migrate: true });
  // Known passwords (legacy plaintext rows are re-hashed on the first login).
  await q("UPDATE users SET password_hash = 'AdminPass1!' WHERE user_id = 1");
  await q("UPDATE users SET password_hash = 'SupPass1!' WHERE user_id = 11");
  telegram._setTransport(async (text) => { sent.push(text); });
  base = await startServer();
});
test.after(async () => {
  telegram._setTransport(null);
  await stopServer();
});
test.beforeEach(() => { sent = []; telegram._reset(); });

test('SEC1 Admin: 3 failed logins -> one alert; the 4th does not repeat it; responses unchanged', async () => {
  for (let i = 1; i <= 2; i += 1) {
    const r = await login('admin', 'wrong');
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { status: 'error', message: 'Invalid username/email or password' });
  }
  await settle();
  assert.equal(sent.length, 0);

  await login('admin', 'wrong');
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /محاولات دخول فاشلة: 3/);
  assert.match(sent[0], /admin \(Admin\) - Admin/);
  assert.match(sent[0], /Chrome على Windows/);

  await login('admin', 'wrong');
  await settle();
  assert.equal(sent.length, 1, 'same account is not alerted again within 30 minutes');
});

test('SEC2 Supervisor: alert only at the 5th failed login', async () => {
  for (let i = 1; i <= 4; i += 1) await login('sup_day', 'wrong');
  await settle();
  assert.equal(sent.length, 0);
  await login('sup_day', 'wrong');
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /sup_day/);
  assert.match(sent[0], /محاولات دخول فاشلة: 5/);
});

test('SEC3 a successful login resets the failed count', async () => {
  await q('DELETE FROM loginhistory');
  await login('admin', 'wrong');
  await login('admin', 'wrong');
  const ok = await login('admin', 'AdminPass1!', { deviceId: 'dev-reset' });
  assert.equal(ok.status, 200);
  sent = [];
  await login('admin', 'wrong');
  await login('admin', 'wrong');
  await settle();
  assert.equal(sent.length, 0, 'only 2 failures since the last success');
});

test('SEC4 Admin new device: first login, same device (no alert), new device (alert); Supervisor never', async () => {
  await q('DELETE FROM loginhistory');

  let r = await login('admin', 'AdminPass1!', { deviceId: 'phone-A', ua: DART });
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /أول دخول لحساب Admin/);
  assert.match(sent[0], /تطبيق Team Flow/);

  sent = []; telegram._reset();
  r = await login('admin', 'AdminPass1!', { deviceId: 'phone-A', ua: DART });
  assert.equal(r.status, 200);
  await settle();
  assert.equal(sent.length, 0, 'known device');

  r = await login('admin', 'AdminPass1!', { deviceId: 'laptop-B', ua: CHROME_WIN });
  assert.equal(r.status, 200);
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /دخول حساب Admin من جهاز جديد/);
  assert.match(sent[0], /Chrome على Windows/);

  sent = []; telegram._reset();
  r = await login('sup_day', 'SupPass1!', { deviceId: 'sup-phone', ua: DART });
  assert.equal(r.status, 200);
  await settle();
  assert.equal(sent.length, 0, 'Supervisor logins are not reported');
});

test('SEC5 old app without device_id: the user agent is the device', async () => {
  await q('DELETE FROM loginhistory');
  await login('admin', 'AdminPass1!', { ua: CHROME_WIN });
  sent = []; telegram._reset();
  await login('admin', 'AdminPass1!', { ua: CHROME_WIN });
  await settle();
  assert.equal(sent.length, 0);
  await login('admin', 'AdminPass1!', { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Safari على iPhone\/iPad/);
});

test('SEC6 device_id is stored (trimmed); a non-string device_id is ignored', async () => {
  await q('DELETE FROM loginhistory');
  await login('admin', 'AdminPass1!', { deviceId: '  abc123  ' });
  await login('admin', 'AdminPass1!', { deviceId: { evil: true } });
  const rows = await q('SELECT device_id FROM loginhistory WHERE user_id = 1 ORDER BY login_id');
  assert.deepEqual(rows.map((x) => x.device_id), ['abc123', null]);
});

test('SEC7 Telegram failing never breaks login', async () => {
  await q('DELETE FROM loginhistory');
  telegram._setTransport(async () => { throw new Error('network down'); });
  try {
    const ok = await login('admin', 'AdminPass1!', { deviceId: 'new-one' });
    assert.equal(ok.status, 200);
    for (let i = 0; i < 4; i += 1) assert.equal((await login('admin', 'wrong')).status, 401);
    await settle();
  } finally {
    telegram._setTransport(async (text) => { sent.push(text); });
  }
});
