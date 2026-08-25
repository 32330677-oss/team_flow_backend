require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/db');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

async function closeDatabase() {
  if (typeof db.end === 'function') {
    await db.end();
  }
}

async function seedAdmin() {
  const username = requiredEnv('ADMIN_USERNAME');
  const password = requiredEnv('ADMIN_PASSWORD');
  const email = process.env.ADMIN_EMAIL?.trim() || null;
  const fullName = requiredEnv('ADMIN_FULL_NAME');

  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must contain at least 12 characters');
  }

  const [existingUsername] = await db.query(
    'SELECT user_id, username, email, role, status FROM users WHERE username = ? LIMIT 1',
    [username]
  );

  if (existingUsername.length > 0) {
    console.log(`Admin username already exists: ${username}. No changes were made.`);
    return;
  }

  if (email) {
    const [existingEmail] = await db.query(
      'SELECT user_id, username, email, role, status FROM users WHERE email = ? LIMIT 1',
      [email]
    );

    if (existingEmail.length > 0) {
      throw new Error(`Email is already used by another account: ${email}`);
    }
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const [result] = await db.query(
    `INSERT INTO users
      (username, password_hash, email, full_name, role, status)
     VALUES (?, ?, ?, ?, 'Admin', 'Active')`,
    [username, passwordHash, email, fullName]
  );

  console.log(`Admin created successfully. user_id=${result.insertId}, username=${username}`);
}

(async () => {
  try {
    await seedAdmin();
  } catch (error) {
    console.error('Admin seed failed:', error.message);
    process.exitCode = 1;
  } finally {
    try {
      await closeDatabase();
    } catch (closeError) {
      console.error('Database close failed:', closeError.message);
      process.exitCode = 1;
    }
  }
})();
