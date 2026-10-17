// services/accessControl.js
//
// Permissions for accounts of type 'User' (users.role = 'User').
//
//   * PERMISSIONS is the list of things the CODE can check (a route asks for
//     one of these keys). It is the only fixed part: a key means nothing
//     until a route uses it.
//   * WHO gets which key is data: the Admin creates roles (any name, editable
//     any time) in app_roles, ticks their keys (app_role_permissions) and
//     gives one role to each account (app_user_roles).
//   * Admin / Supervisor / StaffSupervisor keep their current routes
//     (restrictTo by name) and are not affected. Admin also gets the keys
//     marked `admin: true` so he can see what the new pages show.
//
// Read on every request (one indexed query), so a change of role or a
// deactivated role takes effect immediately, like authMiddleware does.

const pool = require('../config/db');

const PERMISSIONS = [
  { key: 'dpr.view', group: 'Daily Progress Report', label: 'View reports, dashboard and archive', admin: true },
  { key: 'dpr.edit', group: 'Daily Progress Report', label: 'Fill in the daily report', requires: ['dpr.view'] },
  { key: 'dpr.override', group: 'Daily Progress Report', label: 'Change a value taken from the systems (and restore it)', requires: ['dpr.view', 'dpr.edit'] },
  { key: 'dpr.registers', group: 'Daily Progress Report', label: 'NCR and areas of concern registers', requires: ['dpr.view'] },
  { key: 'dpr.issue', group: 'Daily Progress Report', label: 'Issue reports (PDF / Excel)', requires: ['dpr.view'] },
  { key: 'dpr.revise', group: 'Daily Progress Report', label: 'Revise an issued report (new revision)', requires: ['dpr.view', 'dpr.issue'] },
  { key: 'dpr.setup', group: 'Daily Progress Report', label: 'Contract setup (information, BOQ, trades, plant, sections)', requires: ['dpr.view'] },
];

const KEYS = new Set(PERMISSIONS.map((p) => p.key));
const ADMIN_KEYS = PERMISSIONS.filter((p) => p.admin).map((p) => p.key);

/** Names an Admin may not give to a role (they are account types). */
const RESERVED_ROLE_NAMES = ['admin', 'supervisor', 'staffsupervisor', 'staff supervisor', 'user'];

/** Valid keys only, with the keys they require, sorted, no duplicates. */
function normalizePermissions(list) {
  const out = new Set();
  const add = (k) => {
    if (!KEYS.has(k) || out.has(k)) return;
    out.add(k);
    const p = PERMISSIONS.find((x) => x.key === k);
    for (const r of p.requires || []) add(r);
  };
  for (const k of Array.isArray(list) ? list : []) add(String(k));
  return [...out].sort();
}

/**
 * Role and permissions of an authenticated account.
 * @returns {Promise<{type: string, role: {role_id:number,name:string,is_active:boolean}|null, permissions: string[]}>}
 */
async function accessFor(user) {
  if (!user) return { type: null, role: null, permissions: [] };
  if (user.role === 'Admin') return { type: 'Admin', role: null, permissions: [...ADMIN_KEYS] };
  if (user.role !== 'User') return { type: user.role, role: null, permissions: [] };
  const [rows] = await pool.query(
    `SELECT r.role_id, r.name, r.is_active, rp.permission_key
       FROM app_user_roles ur
       JOIN app_roles r ON r.role_id = ur.role_id
       LEFT JOIN app_role_permissions rp ON rp.role_id = r.role_id
      WHERE ur.user_id = ?`, [user.user_id]);
  if (!rows.length) return { type: 'User', role: null, permissions: [] };
  const role = { role_id: Number(rows[0].role_id), name: rows[0].name, is_active: Number(rows[0].is_active) === 1 };
  const permissions = role.is_active
    ? [...new Set(rows.map((r) => r.permission_key).filter((k) => k && KEYS.has(k)))].sort()
    : [];
  return { type: 'User', role, permissions };
}

module.exports = { PERMISSIONS, KEYS, ADMIN_KEYS, RESERVED_ROLE_NAMES, normalizePermissions, accessFor };
