// tests/security_alerts.unit.test.js — helpers, notifier and the login rate-limiter hook (no database).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOGIN_RATE_LIMIT_MAX = '2';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHAT_ID = '12345';

const telegram = require('../services/telegramNotifier');
const alerts = require('../services/securityAlerts');

test('U1 describeDevice', () => {
  assert.equal(alerts.describeDevice('Dart/3.5 (dart:io)'), 'تطبيق Team Flow');
  assert.equal(alerts.describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge على Windows');
  assert.equal(alerts.describeDevice('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), 'Chrome على Android');
  assert.equal(alerts.describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'), 'Safari على Mac');
  assert.equal(alerts.describeDevice(''), 'غير معروف');
});

test('U2 normalizeDeviceId', () => {
  assert.equal(alerts.normalizeDeviceId('  x  '), 'x');
  assert.equal(alerts.normalizeDeviceId(''), null);
  assert.equal(alerts.normalizeDeviceId(42), null);
  assert.equal(alerts.normalizeDeviceId('a'.repeat(300)).length, 100);
});

test('U3 notifier: off without settings; same key not repeated', async () => {
  const sent = [];
  telegram._setTransport(async (t) => { sent.push(t); });
  telegram._reset();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  assert.equal(telegram.send('x'), false);
  process.env.TELEGRAM_BOT_TOKEN = token;
  assert.equal(telegram.send('a', { key: 'k' }), true);
  assert.equal(telegram.send('b', { key: 'k' }), false);
  assert.equal(telegram.send('c', { key: 'k2' }), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['a', 'c']);
});

test('U4 login limiter: blocked IP gets the same 429 body and one alert', async () => {
  const sent = [];
  telegram._setTransport(async (t) => { sent.push(t); });
  telegram._reset();
  const { loginLimiter } = require('../middleware/rateLimiter');

  async function hit() {
    const req = { ip: '203.0.113.7', method: 'POST', headers: { 'user-agent': 'Dart/3.5 (dart:io)' }, body: { username: 'admin' }, app: { get: () => 1 } };
    const res = {
      statusCode: 200, headers: {}, body: undefined,
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
      append() {}, on() {}, once() {},
      send(b) { this.body = b; return this; },
      get headersSent() { return this.body !== undefined; },
    };
    let nextCalled = false;
    await loginLimiter(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
  }

  assert.equal((await hit()).nextCalled, true);
  assert.equal((await hit()).nextCalled, true);
  const blocked = await hit();
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.deepEqual(blocked.res.body, { status: 'error', message: 'Too many failed login attempts. Please wait 15 minutes and try again.' });
  await hit();
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /203\.0\.113\.7/);
  assert.match(sent[0], /آخر اسم مستخدم انجرّب: admin/);
});
