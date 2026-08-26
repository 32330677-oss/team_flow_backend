const mysql = require('mysql2');
require('dotenv').config();

const dbPort = Number(process.env.DB_PORT || 3306);
const useSsl = String(process.env.DB_SSL).toLowerCase() === 'true';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: dbPort,
  charset: 'utf8mb4',
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: useSsl
    ? {
        // Aiven requires an encrypted SSL connection.
        // Certificate verification can be hardened later with Aiven's CA file.
        rejectUnauthorized: false,
      }
    : undefined,
});

const promisePool = pool.promise();

pool.getConnection((err, connection) => {
  if (err) {
    console.error(
      'Database connection failed. Check DB_HOST, DB_PORT, credentials, and SSL:',
      err.message
    );
  } else {
    console.log('Connected to MySQL Database successfully!');
    connection.release();
  }
});

module.exports = promisePool;
