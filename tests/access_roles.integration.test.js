// tests/access_roles.integration.test.js
//
// Roles & accounts of type 'User' — HTTP integration tests.
// Proves: the old roles are untouched (same login response, same access),
// roles and accounts are data (names editable, no hard-coded role), a 'User'
// account reaches nothing of the old system, and every change is audited.
// Run:  npm test   (requires a local MySQL; see tests/helpers.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDatabase, startServer, stopServer, client, q, sh, DB_NAME } = require('./helpers');

const MYSQL = process.env.TEST_MYSQL_CLI || 'mysql -uroot';
const admin = () => client(1, 'Admin');
let base;

async function login(username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: await res.json() };
}

function bearer(token) {
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b ?? {}) };
}

test.before(async () => {
  resetDatabase({ migrate: true });
  base = await startServer();
});
test.after(async () => { await stopServer(); });

let roleId;
let userId;

test('A1 migration: users.role keeps its values and gains User; running it again changes nothing', async () => {
  const [col] = await q("SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'");
  assert.equal(col.COLUMN_TYPE, "enum('Admin','Supervisor','StaffSupervisor','User')");
  assert.equal(col.IS_NULLABLE, 'NO');
  const before = await q('SELECT user_id, role, status FROM users ORDER BY user_id');
  sh(`${MYSQL} ${DB_NAME} < migrations/2026_10_user_dpr/01_ddl.sql`);
  const [again] = await q("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'");
  assert.equal(again.COLUMN_TYPE, col.COLUMN_TYPE);
  assert.deepEqual(await q('SELECT user_id, role, status FROM users ORDER BY user_id'), before);
});

test('A2 old roles: login response has exactly the same fields as before', async () => {
  const r = await login('sup_day', 'x'); // seed: legacy plaintext password
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body.user).sort(), ['email', 'full_name', 'id', 'role', 'status', 'username']);
  assert.equal(r.body.user.role, 'Supervisor');
});

test('A3 only the Admin manages roles and accounts', async () => {
  assert.equal((await client(null).get('/api/access/roles')).status, 401);
  assert.equal((await client(11, 'Supervisor').get('/api/access/roles')).status, 403);
  assert.equal((await client(14, 'StaffSupervisor').post('/api/access/users', {})).status, 403);
  const p = await admin().get('/api/access/permissions');
  assert.equal(p.status, 200);
  assert.ok(p.body.data.some((x) => x.key === 'dpr.view'));
});

test('A4 roles are data: create with any name, permissions completed, reserved names refused', async () => {
  let r = await admin().post('/api/access/roles', { name: 'Supervisor', permissions: [] });
  assert.equal(r.status, 400, 'an account type is not a role name');
  r = await admin().post('/api/access/roles', { name: 'x', permissions: [] });
  assert.equal(r.status, 400);
  r = await admin().post('/api/access/roles', {
    name: 'QC Manager', description: 'Daily progress report', permissions: ['dpr.override', 'dpr.hack', 'dpr.override'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  roleId = r.body.data.role_id;
  assert.deepEqual(r.body.data.permissions, ['dpr.edit', 'dpr.override', 'dpr.view'], 'unknown key dropped, required keys added');
  r = await admin().post('/api/access/roles', { name: 'qc manager', permissions: [] });
  assert.equal(r.status, 409, 'names are unique (case-insensitive)');
});

test('A5 an account of type User: created by the Admin, logs in with its role and permissions', async () => {
  let r = await admin().post('/api/access/users', { full_name: 'Ahmad QC', username: 'ahmad.qc', password: 'short', role_id: roleId });
  assert.equal(r.status, 400, 'password too short');
  r = await admin().post('/api/access/users', { full_name: 'Ahmad QC', username: 'sup_day', password: 'Passw0rd!', role_id: roleId });
  assert.equal(r.status, 409, 'username taken');
  r = await admin().post('/api/access/users', { full_name: 'Ahmad QC', username: 'ahmad.qc', email: 'ahmad@x.test', password: 'Passw0rd!', role_id: roleId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  userId = r.body.data.user_id;
  const [row] = await q('SELECT role, status FROM users WHERE user_id = ?', [userId]);
  assert.deepEqual({ ...row }, { role: 'User', status: 'Active' });

  const l = await login('ahmad.qc', 'Passw0rd!');
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.user.role, 'User');
  assert.deepEqual(l.body.user.app_role, { id: roleId, name: 'QC Manager' });
  assert.deepEqual(l.body.user.permissions, ['dpr.edit', 'dpr.override', 'dpr.view']);
  const me = await bearer(l.body.token).get('/api/access/me');
  assert.equal(me.body.data.role.name, 'QC Manager');
  assert.equal(me.body.data.labels['dpr.view'], 'View reports, dashboard and archive');
});

test('A6 a User account reaches nothing of the old system', async () => {
  const l = await login('ahmad.qc', 'Passw0rd!');
  const u = bearer(l.body.token);
  // real routes of every old area: each must refuse the account (403), none may answer
  for (const url of ['/api/workers', '/api/sites/my-sites', '/api/sites/all-sites', '/api/attendance/rejected',
    '/api/attendance/sites/8/workers', '/api/admin/payroll/offcycle/candidates', '/api/users/supervisors',
    '/api/assistant/status', '/api/reports/daily-site/options', '/api/reports/project-daily/options',
    '/api/access/roles', '/api/access/users']) {
    const r = await u.get(url);
    assert.equal(r.status, 403, `${url} -> ${r.status}`);
  }
  const sup = await admin().get('/api/users/supervisors');
  assert.ok(!sup.body.data.some((x) => x.user_id === userId), 'not listed as a supervisor');
});

test('A7 rename the role: the account keeps working with the new name', async () => {
  const r = await admin().put(`/api/access/roles/${roleId}`, { name: 'Quality Control Manager' });
  assert.equal(r.status, 200);
  const l = await login('ahmad.qc', 'Passw0rd!');
  assert.equal(l.status, 200);
  assert.equal(l.body.user.app_role.name, 'Quality Control Manager');
});

test('A8 requirePermission: granted, refused, and revoked at once when the role changes', async () => {
  const requirePermission = require('../middleware/requirePermission');
  const run = async (user, ...keys) => {
    let status = 200;
    let passed = false;
    const res = { status: (s) => { status = s; return { json: () => {} }; } };
    await requirePermission(...keys)({ user }, res, () => { passed = true; });
    return passed ? 200 : status;
  };
  const u = { user_id: userId, role: 'User' };
  assert.equal(await run(u, 'dpr.view'), 200);
  assert.equal(await run(u, 'dpr.issue'), 403);
  assert.equal(await run({ user_id: 11, role: 'Supervisor' }, 'dpr.view'), 403, 'old roles get no new keys');
  assert.equal(await run({ user_id: 1, role: 'Admin' }, 'dpr.view'), 200);
  assert.equal(await run({ user_id: 1, role: 'Admin' }, 'dpr.edit'), 403, 'Admin sees, the role edits');
  await admin().put(`/api/access/roles/${roleId}`, { permissions: ['dpr.view', 'dpr.issue'] });
  assert.equal(await run(u, 'dpr.issue'), 200);
  assert.equal(await run(u, 'dpr.edit'), 403);
});

test('A9 deactivated role: no login and no permission; deactivated account: no login', async () => {
  await admin().put(`/api/access/roles/${roleId}`, { is_active: false });
  let l = await login('ahmad.qc', 'Passw0rd!');
  assert.equal(l.status, 403);
  assert.equal(l.body.code, 'NO_ACTIVE_ROLE');
  await admin().put(`/api/access/roles/${roleId}`, { is_active: true });
  l = await login('ahmad.qc', 'Passw0rd!');
  assert.equal(l.status, 200);
  const r = await fetch(`${base}/api/access/users/${userId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${require('./helpers').token(1, 'Admin')}` },
    body: JSON.stringify({ status: 'Inactive' }),
  });
  assert.equal(r.status, 200);
  l = await login('ahmad.qc', 'Passw0rd!');
  assert.equal(l.status, 403);
});

test('A10 these routes never touch Admin / Supervisor accounts', async () => {
  let r = await admin().put('/api/access/users/11', { full_name: 'Hacked Name' });
  assert.equal(r.status, 404);
  r = await admin().put('/api/access/users/1/password', { password: 'NewPassw0rd!' });
  assert.equal(r.status, 404);
  const [sup] = await q('SELECT full_name, role FROM users WHERE user_id = 11');
  assert.deepEqual({ ...sup }, { full_name: 'Day Supervisor', role: 'Supervisor' });
});

test('A11 delete a role only when unused; every change is in the audit', async () => {
  let r = await fetch(`${base}/api/access/roles/${roleId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${require('./helpers').token(1, 'Admin')}` },
  });
  assert.equal(r.status, 409);
  const spare = await admin().post('/api/access/roles', { name: 'Spare', permissions: ['dpr.view'] });
  r = await fetch(`${base}/api/access/roles/${spare.body.data.role_id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${require('./helpers').token(1, 'Admin')}` },
  });
  assert.equal(r.status, 200);
  const a = await admin().get('/api/access/audit');
  const actions = a.body.data.map((x) => x.action);
  for (const k of ['role.create', 'role.update', 'role.delete', 'user.create', 'user.status']) assert.ok(actions.includes(k), k);
  assert.ok(!JSON.stringify(a.body.data).includes('Passw0rd'), 'no password in the audit');
});

test('A12 rollback refuses while a User account exists', async () => {
  assert.throws(() => sh(`${MYSQL} ${DB_NAME} < migrations/2026_10_user_dpr/99_rollback.sql`));
  const [t] = await q("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_roles'");
  assert.equal(Number(t.n), 1, 'nothing changed');
});
