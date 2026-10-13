const fs = require('fs');
const mysql = require('mysql2');
require('dotenv').config();

const dbPort = Number(process.env.DB_PORT || 3306);
const useSsl = String(process.env.DB_SSL).toLowerCase() === 'true';

// Aiven CA certificate (ca.pem). When it is set, the server certificate is
// verified, so the app only ever talks to the real database. Two ways:
//   DB_CA_CERT_PATH  path to the file (Render "Secret File": /etc/secrets/ca.pem)
//   DB_CA_CERT       the PEM text itself
// Neither set: encrypted but not verified (the previous behaviour).
function loadCaCert() {
  const caPath = (process.env.DB_CA_CERT_PATH || '').trim();
  if (caPath) {
    try {
      return fs.readFileSync(caPath, 'utf8');
    } catch (error) {
      // Fail loudly: a wrong path must not silently turn verification off.
      throw new Error(`DB_CA_CERT_PATH is set but the file cannot be read (${caPath}): ${error.message}`);
    }
  }
  const inline = (process.env.DB_CA_CERT || '').trim();
  return inline ? inline.replace(/\\n/g, '\n') : null;
}

const caCert = useSsl ? loadCaCert() : null;
if (useSsl) {
  console.log(caCert
    ? 'DB SSL: encrypted, server certificate verified (CA).'
    : 'DB SSL: encrypted, server certificate NOT verified (set DB_CA_CERT_PATH to verify).');
}

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
    ? (caCert
        ? { ca: caCert, rejectUnauthorized: true }
        // Aiven requires SSL; without the CA the certificate is not verified.
        : { rejectUnauthorized: false })
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
