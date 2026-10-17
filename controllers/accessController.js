// controllers/accessController.js
//
// Roles & accounts of type 'User' (Admin only, except GET /me).
//
//   GET    /api/access/me                    role + permissions of the caller (any signed-in account)
//   GET    /api/access/permissions           the permission list (what the code can check)
//   GET    /api/access/roles                 roles with their permissions and number of accounts
//   POST   /api/access/roles                 { name, description, permissions[], is_active }
//   PUT    /api/access/roles/:id             { name?, description?, permissions?, is_active? }
//   DELETE /api/access/roles/:id             only while no account uses it
//   GET    /api/access/users                 accounts of type 'User'
//   POST   /api/access/users                 { full_name, username, email?, password, role_id }
//   PUT    /api/access/users/:id             { full_name?, username?, email?, role_id? }
//   PATCH  /api/access/users/:id/status      { status: 'Active'|'Inactive' }
//   PUT    /api/access/users/:id/password    { password }
//   GET    /api/access/audit                 last changes (who / what / when)
//
// Only accounts with users.role = 'User' are created or changed here. Admin,
// Supervisor and StaffSupervisor accounts are never touched by these routes.

const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const {
  PERMISSIONS, RESERVED_ROLE_NAMES, normalizePermissions, accessFor,
} = require('../services/accessControl');

const PASSWORD_MIN_LENGTH = 8;

class AccessError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function fail(res, error, where) {
  if (error && error.code === 'ER_NO_SUCH_TABLE') {
    return res.status(503).json({
      status: 'error',
      message: 'Roles are not set up yet. Run migrations/2026_10_user_dpr/01_ddl.sql first.',
    });
  }
  if (error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062)) {
    return res.status(409).json({ status: 'error', message: 'This name, username or email is already in use.' });
  }
  if (error && (error.code === 'WARN_DATA_TRUNCATED' || error.errno === 1265)) {
    return res.status(503).json({
      status: 'error',
      message: "The account type 'User' is missing. Run migrations/2026_10_user_dpr/01_ddl.sql first.",
    });
  }
  if (error && error.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({ status: 'error', message: error.message });
  }
  console.error(`${where}:`, error);
  return res.status(500).json({ status: 'error', message: 'Something went wrong. Please try again.' });
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function id(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AccessError('Invalid id.');
  return n;
}

function roleName(v) {
  const name = clean(v, 100);
  if (name.length < 2) throw new AccessError('Enter a role name (at least 2 characters).');
  if (RESERVED_ROLE_NAMES.includes(name.toLowerCase())) {
    throw new AccessError(`"${name}" is an account type of the system. Choose another role name.`);
  }
  return name;
}

function fullName(v) {
  const s = clean(v, 255);
  if (s.length < 3) throw new AccessError('Enter the full name (at least 3 characters).');
  return s;
}

function username(v) {
  const s = String(v ?? '').trim();
  if (!/^[A-Za-z0-9._@-]{3,50}$/.test(s)) {
    throw new AccessError('Username: 3 to 50 characters, letters, numbers and . _ @ - only (no spaces).');
  }
  return s;
}

function email(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new AccessError('Enter a valid email address or leave it empty.');
  return s;
}

function password(v) {
  const s = String(v ?? '');
  if (s.length < PASSWORD_MIN_LENGTH) throw new AccessError(`The password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (s.length > 128) throw new AccessError('The password is too long.');
  return s;
}

async function audit(conn, actorId, action, targetType, targetId, details) {
  await conn.query(
    `INSERT INTO app_access_audit (actor_user_id, action, target_type, target_id, details)
     VALUES (?, ?, ?, ?, ?)`,
    [actorId, action, targetType, targetId, details ? JSON.stringify(details) : null]);
}

async function inTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

async function loadRole(conn, roleId) {
  const [[r]] = await conn.query(
    `SELECT r.role_id, r.name, r.description, r.is_active,
            DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i') AS created_at,
            DATE_FORMAT(r.updated_at, '%Y-%m-%d %H:%i') AS updated_at,
            (SELECT COUNT(*) FROM app_user_roles ur WHERE ur.role_id = r.role_id) AS accounts
       FROM app_roles r WHERE r.role_id = ?`, [roleId]);
  if (!r) return null;
  const [perms] = await conn.query(
    'SELECT permission_key FROM app_role_permissions WHERE role_id = ? ORDER BY permission_key', [roleId]);
  return {
    role_id: Number(r.role_id),
    name: r.name,
    description: r.description || '',
    is_active: Number(r.is_active) === 1,
    accounts: Number(r.accounts),
    permissions: perms.map((p) => p.permission_key),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function loadUser(conn, userId) {
  const [[u]] = await conn.query(
    `SELECT u.user_id, u.full_name, u.username, u.email, u.status,
            DATE_FORMAT(u.created_at, '%Y-%m-%d %H:%i') AS created_at,
            DATE_FORMAT(u.last_login, '%Y-%m-%d %H:%i') AS last_login,
            r.role_id, r.name AS role_name, r.is_active AS role_active
       FROM users u
       LEFT JOIN app_user_roles ur ON ur.user_id = u.user_id
       LEFT JOIN app_roles r ON r.role_id = ur.role_id
      WHERE u.user_id = ? AND u.role = 'User'`, [userId]);
  if (!u) return null;
  return {
    user_id: Number(u.user_id),
    full_name: u.full_name,
    username: u.username,
    email: u.email || '',
    status: u.status,
    role_id: u.role_id === null ? null : Number(u.role_id),
    role_name: u.role_name || null,
    role_active: u.role_id === null ? false : Number(u.role_active) === 1,
    created_at: u.created_at,
    last_login: u.last_login,
  };
}

async function activeRoleOrFail(conn, roleId) {
  const [[r]] = await conn.query('SELECT role_id, is_active FROM app_roles WHERE role_id = ?', [roleId]);
  if (!r) throw new AccessError('The selected role was not found.', 404);
  if (Number(r.is_active) !== 1) throw new AccessError('The selected role is inactive. Activate it first or choose another role.');
}

async function uniqueAccount(conn, { username: un, email: em }, exceptId = 0) {
  if (un) {
    const [[x]] = await conn.query('SELECT user_id FROM users WHERE username = ? AND user_id <> ?', [un, exceptId]);
    if (x) throw new AccessError('This username is already in use.', 409);
  }
  if (em) {
    const [[x]] = await conn.query('SELECT user_id FROM users WHERE email = ? AND user_id <> ?', [em, exceptId]);
    if (x) throw new AccessError('This email is already in use by another account.', 409);
  }
}

// ------------------------------------------------------------------ me
exports.me = async (req, res) => {
  try {
    const access = await accessFor(req.user);
    // labels: what each of the account's permissions means (for its home page)
    const labels = Object.fromEntries(
      PERMISSIONS.filter((p) => access.permissions.includes(p.key)).map((p) => [p.key, p.label]));
    return res.json({ status: 'success', data: { ...access, labels } });
  } catch (error) {
    return fail(res, error, 'access.me');
  }
};

// ------------------------------------------------------------------ permissions
exports.listPermissions = (req, res) => res.json({
  status: 'success',
  data: PERMISSIONS.map(({ key, group, label, requires }) => ({ key, group, label, requires: requires || [] })),
});

// ------------------------------------------------------------------ roles
exports.listRoles = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT role_id FROM app_roles ORDER BY is_active DESC, name');
    const out = [];
    for (const r of rows) out.push(await loadRole(pool, r.role_id));
    return res.json({ status: 'success', data: out });
  } catch (error) {
    return fail(res, error, 'access.listRoles');
  }
};

exports.createRole = async (req, res) => {
  try {
    const b = req.body || {};
    const name = roleName(b.name);
    const description = clean(b.description, 500) || null;
    const permissions = normalizePermissions(b.permissions);
    const isActive = b.is_active === false ? 0 : 1;
    const role = await inTransaction(async (conn) => {
      const [ins] = await conn.query(
        `INSERT INTO app_roles (name, description, is_active, created_by_user_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?)`, [name, description, isActive, req.user.user_id, req.user.user_id]);
      for (const k of permissions) {
        await conn.query('INSERT INTO app_role_permissions (role_id, permission_key) VALUES (?, ?)', [ins.insertId, k]);
      }
      await audit(conn, req.user.user_id, 'role.create', 'Role', ins.insertId, { name, permissions, is_active: isActive === 1 });
      return loadRole(conn, ins.insertId);
    });
    return res.status(201).json({ status: 'success', data: role });
  } catch (error) {
    return fail(res, error, 'access.createRole');
  }
};

exports.updateRole = async (req, res) => {
  try {
    const roleId = id(req.params.id);
    const b = req.body || {};
    const role = await inTransaction(async (conn) => {
      const before = await loadRole(conn, roleId);
      if (!before) throw new AccessError('Role not found.', 404);
      const name = b.name !== undefined ? roleName(b.name) : before.name;
      const description = b.description !== undefined ? (clean(b.description, 500) || null) : (before.description || null);
      const isActive = b.is_active !== undefined ? (b.is_active === true || b.is_active === 1 || b.is_active === 'true') : before.is_active;
      await conn.query(
        'UPDATE app_roles SET name = ?, description = ?, is_active = ?, updated_by_user_id = ? WHERE role_id = ?',
        [name, description, isActive ? 1 : 0, req.user.user_id, roleId]);
      let permissions = before.permissions;
      if (b.permissions !== undefined) {
        permissions = normalizePermissions(b.permissions);
        await conn.query('DELETE FROM app_role_permissions WHERE role_id = ?', [roleId]);
        for (const k of permissions) {
          await conn.query('INSERT INTO app_role_permissions (role_id, permission_key) VALUES (?, ?)', [roleId, k]);
        }
      }
      const changes = {};
      if (name !== before.name) changes.name = { from: before.name, to: name };
      if ((description || '') !== (before.description || '')) changes.description = { from: before.description, to: description };
      if (isActive !== before.is_active) changes.is_active = { from: before.is_active, to: isActive };
      if (permissions.join(',') !== before.permissions.join(',')) changes.permissions = { from: before.permissions, to: permissions };
      if (Object.keys(changes).length) await audit(conn, req.user.user_id, 'role.update', 'Role', roleId, changes);
      return loadRole(conn, roleId);
    });
    return res.json({ status: 'success', data: role });
  } catch (error) {
    return fail(res, error, 'access.updateRole');
  }
};

exports.deleteRole = async (req, res) => {
  try {
    const roleId = id(req.params.id);
    await inTransaction(async (conn) => {
      const before = await loadRole(conn, roleId);
      if (!before) throw new AccessError('Role not found.', 404);
      if (before.accounts > 0) {
        throw new AccessError(`This role is used by ${before.accounts} account(s). Give them another role first, or deactivate the role instead.`, 409);
      }
      await conn.query('DELETE FROM app_roles WHERE role_id = ?', [roleId]);
      await audit(conn, req.user.user_id, 'role.delete', 'Role', roleId, { name: before.name, permissions: before.permissions });
    });
    return res.json({ status: 'success' });
  } catch (error) {
    return fail(res, error, 'access.deleteRole');
  }
};

// ------------------------------------------------------------------ accounts
exports.listUsers = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT user_id FROM users WHERE role = 'User' ORDER BY status = 'Active' DESC, full_name");
    const out = [];
    for (const r of rows) out.push(await loadUser(pool, r.user_id));
    return res.json({ status: 'success', data: out });
  } catch (error) {
    return fail(res, error, 'access.listUsers');
  }
};

exports.createUser = async (req, res) => {
  try {
    const b = req.body || {};
    const data = {
      full_name: fullName(b.full_name),
      username: username(b.username),
      email: email(b.email),
      password: password(b.password),
      role_id: id(b.role_id),
    };
    const user = await inTransaction(async (conn) => {
      await activeRoleOrFail(conn, data.role_id);
      await uniqueAccount(conn, data);
      const hash = await bcrypt.hash(data.password, 10);
      const [ins] = await conn.query(
        `INSERT INTO users (full_name, username, password_hash, email, role, status)
         VALUES (?, ?, ?, ?, 'User', 'Active')`, [data.full_name, data.username, hash, data.email]);
      await conn.query(
        'INSERT INTO app_user_roles (user_id, role_id, assigned_by_user_id) VALUES (?, ?, ?)',
        [ins.insertId, data.role_id, req.user.user_id]);
      await audit(conn, req.user.user_id, 'user.create', 'User', ins.insertId,
        { full_name: data.full_name, username: data.username, email: data.email, role_id: data.role_id });
      return loadUser(conn, ins.insertId);
    });
    return res.status(201).json({ status: 'success', data: user });
  } catch (error) {
    return fail(res, error, 'access.createUser');
  }
};

exports.updateUser = async (req, res) => {
  try {
    const userId = id(req.params.id);
    const b = req.body || {};
    const user = await inTransaction(async (conn) => {
      const before = await loadUser(conn, userId);
      if (!before) throw new AccessError('Account not found.', 404);
      const next = {
        full_name: b.full_name !== undefined ? fullName(b.full_name) : before.full_name,
        username: b.username !== undefined ? username(b.username) : before.username,
        email: b.email !== undefined ? email(b.email) : (before.email || null),
        role_id: b.role_id !== undefined ? id(b.role_id) : before.role_id,
      };
      await uniqueAccount(conn, next, userId);
      if (next.role_id !== before.role_id) await activeRoleOrFail(conn, next.role_id);
      await conn.query(
        "UPDATE users SET full_name = ?, username = ?, email = ? WHERE user_id = ? AND role = 'User'",
        [next.full_name, next.username, next.email, userId]);
      if (next.role_id !== before.role_id) {
        await conn.query(
          `INSERT INTO app_user_roles (user_id, role_id, assigned_by_user_id) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE role_id = VALUES(role_id), assigned_by_user_id = VALUES(assigned_by_user_id)`,
          [userId, next.role_id, req.user.user_id]);
      }
      const prev = { ...before, email: before.email || null };
      const changes = {};
      for (const k of ['full_name', 'username', 'email', 'role_id']) {
        if ((prev[k] ?? null) !== (next[k] ?? null)) changes[k] = { from: prev[k] ?? null, to: next[k] ?? null };
      }
      if (Object.keys(changes).length) await audit(conn, req.user.user_id, 'user.update', 'User', userId, changes);
      return loadUser(conn, userId);
    });
    return res.json({ status: 'success', data: user });
  } catch (error) {
    return fail(res, error, 'access.updateUser');
  }
};

exports.setUserStatus = async (req, res) => {
  try {
    const userId = id(req.params.id);
    const status = String((req.body || {}).status || '');
    if (!['Active', 'Inactive'].includes(status)) throw new AccessError("status must be 'Active' or 'Inactive'.");
    const user = await inTransaction(async (conn) => {
      const before = await loadUser(conn, userId);
      if (!before) throw new AccessError('Account not found.', 404);
      if (before.status !== status) {
        await conn.query("UPDATE users SET status = ? WHERE user_id = ? AND role = 'User'", [status, userId]);
        await audit(conn, req.user.user_id, 'user.status', 'User', userId, { from: before.status, to: status });
      }
      return loadUser(conn, userId);
    });
    return res.json({ status: 'success', data: user });
  } catch (error) {
    return fail(res, error, 'access.setUserStatus');
  }
};

exports.resetUserPassword = async (req, res) => {
  try {
    const userId = id(req.params.id);
    const pw = password((req.body || {}).password);
    await inTransaction(async (conn) => {
      const before = await loadUser(conn, userId);
      if (!before) throw new AccessError('Account not found.', 404);
      const hash = await bcrypt.hash(pw, 10);
      await conn.query("UPDATE users SET password_hash = ? WHERE user_id = ? AND role = 'User'", [hash, userId]);
      await audit(conn, req.user.user_id, 'user.password', 'User', userId, null);
    });
    return res.json({ status: 'success' });
  } catch (error) {
    return fail(res, error, 'access.resetUserPassword');
  }
};

// ------------------------------------------------------------------ audit
exports.listAudit = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const [rows] = await pool.query(
      `SELECT a.audit_id, a.action, a.target_type, a.target_id, a.details,
              DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i') AS created_at,
              u.full_name AS actor_name,
              CASE a.target_type
                WHEN 'Role' THEN (SELECT name FROM app_roles r WHERE r.role_id = a.target_id)
                ELSE (SELECT full_name FROM users t WHERE t.user_id = a.target_id)
              END AS target_name
         FROM app_access_audit a
         LEFT JOIN users u ON u.user_id = a.actor_user_id
        ORDER BY a.audit_id DESC
        LIMIT ${limit}`);
    return res.json({
      status: 'success',
      data: rows.map((r) => ({
        ...r,
        details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
      })),
    });
  } catch (error) {
    return fail(res, error, 'access.listAudit');
  }
};
