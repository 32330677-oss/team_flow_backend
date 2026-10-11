const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const multer = require('multer');
const db = require('../config/db');
const fileStorage = require('../services/fileStorage');

const ALLOWED_EXT = new Set(['.txt', '.csv', '.dat']);
const MAX_BYTES = 5 * 1024 * 1024;
const RUN_TIMEOUT_MS = 120000;
let running = false; // single backend process; Connector is also checksum-idempotent

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
}).single('file');

exports.uploadMiddleware = (req, res, next) =>
  upload(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        status: 'error',
        message: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB.' : 'Invalid upload.',
      });
    }
    next();
  });

// Reads the Connector's own config.json so folder paths have a single source of truth.
function connectorPaths() {
  const dir = process.env.BIOMETRIC_CONNECTOR_DIR;
  if (!dir) return null;
  try {
    const root = path.resolve(dir);
    const mainJs = path.join(root, 'src', 'main.js');
    const cfgPath = path.join(root, 'config', 'config.json');
    if (!fs.existsSync(mainJs) || !fs.existsSync(cfgPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const abs = (p) => path.resolve(root, p);
    return {
      root,
      mainJs,
      incoming: abs(cfg.folders.incoming),
      processed: abs(cfg.folders.processed),
      failed: abs(cfg.folders.failed),
      pattern: new RegExp(cfg.filePattern || '\\.(txt|csv|dat)$', 'i'),
    };
  } catch (_) {
    return null;
  }
}

function countFiles(dir, filter) {
  try {
    return fs.readdirSync(dir).filter(filter).length;
  } catch (_) {
    return 0;
  }
}

function notConfigured(res) {
  return res.status(501).json({
    status: 'error',
    message:
      'Connector is not reachable from this backend. Set BIOMETRIC_CONNECTOR_DIR to the Connector folder on the same machine.',
  });
}

function runConnector(p) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [p.mainJs],
      {
        cwd: p.root,
        timeout: RUN_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          ASIK_API_URL:
            process.env.BIOMETRIC_CONNECTOR_API_URL ||
            `http://127.0.0.1:${process.env.PORT || 5000}`,
          ASIK_CONNECTOR_TOKEN: process.env.ATTENDANCE_CONNECTOR_TOKEN || '',
        },
      },
      (err, stdout, stderr) => {
        const lines = (String(stdout || '') + String(stderr || '')).split(/\r?\n/).filter(Boolean);
        resolve({
          exit_code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          timed_out: Boolean(err && err.killed),
          output: lines.slice(-30),
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Uploaded files are kept forever in file storage (S3 when STORAGE_DRIVER=s3)
// and indexed in biometric_import_files. The Connector only gets a temporary
// copy on the server disk; after each run that copy is removed again, so the
// server keeps no files. Files the Connector could not import are recorded
// with the reason. Migration: migrations/2026_10_biometric_import_files.
// ---------------------------------------------------------------------------
let filesTableReady = false;
async function hasFilesTable() {
  if (filesTableReady) return true;
  const [[r]] = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biometric_import_files'`
  );
  filesTableReady = Number(r.n) === 1;
  return filesTableReady;
}

function filesTableMissing(res) {
  return res.status(503).json({
    status: 'error',
    message: 'Biometric file storage is not set up. Run migrations/2026_10_biometric_import_files/01_ddl.sql.',
  });
}

const DETAILS_MAX = 60000;

// Files the Connector wrote for one upload: "<stamp>_<workName>" and its
// side files "<stamp>_<workName>.errors.json" / ".reason.txt".
function findOutputs(dir, workName) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return { main: [], side: [] }; }
  const main = names.filter((n) => n.endsWith(`_${workName}`));
  const side = names.filter((n) => main.some((m) => n.startsWith(`${m}.`)));
  return { main, side };
}

function readSide(dir, names) {
  return names
    .map((n) => {
      try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch (_) { return ''; }
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, DETAILS_MAX);
}

function removeAll(dir, names) {
  for (const n of names) {
    try { fs.unlinkSync(path.join(dir, n)); } catch (_) { /* already gone */ }
  }
}

// After a Connector run: record what happened to every uploaded file that was
// still Pending, then remove its temporary copies from the server disk.
async function settleUploads(p) {
  const [rows] = await db.query(
    `SELECT id, checksum, work_name, batch_id FROM biometric_import_files
     WHERE result_status = 'Pending' ORDER BY id`
  );
  for (const row of rows) {
    // Still waiting in incoming (network / server problem): keep it for "Run pending files".
    if (fs.existsSync(path.join(p.incoming, row.work_name))) continue;

    const done = findOutputs(p.processed, row.work_name);
    const failed = findOutputs(p.failed, row.work_name);
    const [[batch]] = await db.query(
      'SELECT id FROM attendance_import_batches WHERE checksum = ? LIMIT 1', [row.checksum]
    );

    let status;
    let details = null;
    if (failed.main.length) {
      status = 'Failed';
      details = readSide(p.failed, failed.side) || 'The Connector rejected the file.';
    } else if (done.main.length || batch) {
      status = row.batch_id ? 'AlreadyImported' : 'Imported';
      details = readSide(p.processed, done.side) || null;
    } else {
      status = 'NotProcessed';
      details = 'The server restarted before this file was processed. Upload it again.';
    }

    await db.execute(
      `UPDATE biometric_import_files SET result_status = ?, result_details = ?, batch_id = ?
       WHERE id = ? AND result_status = 'Pending'`,
      [status, details, batch ? batch.id : null, row.id]
    );
    removeAll(p.processed, [...done.main, ...done.side]);
    removeAll(p.failed, [...failed.main, ...failed.side]);
  }
}

async function audit(userId, action, payload) {
  try {
    await db.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('attendance_import_batches', 0, ?, ?, NULL, ?)`,
      [action, userId, JSON.stringify(payload)]
    );
  } catch (e) {
    console.error('BIOMETRIC IMPORT AUDIT ERROR:', e.message);
  }
}

// POST /api/biometric/import-file  (multipart field "file")
exports.uploadAndRun = async (req, res) => {
  const p = connectorPaths();
  if (!p) return notConfigured(res);
  if (running) return res.status(409).json({ status: 'error', message: 'An import is already running.' });

  const file = req.file;
  if (!file || !file.buffer || file.buffer.length === 0) {
    return res.status(400).json({ status: 'error', message: 'A non-empty file is required.' });
  }
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return res.status(400).json({ status: 'error', message: 'Only .txt, .csv or .dat files are allowed.' });
  }
  if (file.buffer.includes(0)) {
    return res.status(400).json({ status: 'error', message: 'File does not look like a text export.' });
  }

  if (!(await hasFilesTable())) return filesTableMissing(res);

  running = true;
  try {
    const original = path.basename(String(file.originalname)).slice(0, 255);
    const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // 1. Keep the original file forever. If this fails nothing is imported.
    const storedName = fileStorage.newName('biometric-import', original);
    try {
      await fileStorage.save(storedName, file.buffer, 'text/plain; charset=utf-8');
    } catch (error) {
      console.error('BIOMETRIC FILE STORAGE ERROR:', error);
      return res.status(502).json({
        status: 'error',
        message: 'Could not save the file to storage. Nothing was imported. Please try again.',
      });
    }

    const base = path.basename(file.originalname, ext).replace(/[^\w-]/g, '_').slice(0, 40) || 'file';
    const savedAs = `asik_${Date.now()}_${crypto.randomBytes(3).toString('hex')}_${base}${ext}`;
    const [[existing]] = await db.query(
      'SELECT id FROM attendance_import_batches WHERE checksum = ? LIMIT 1', [checksum]
    );
    const [ins] = await db.execute(
      `INSERT INTO biometric_import_files
         (checksum, original_name, stored_name, work_name, size_bytes, uploaded_by, batch_id, result_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
      [checksum, original, storedName, savedAs, file.buffer.length, req.user.user_id, existing ? existing.id : null]
    );

    // 2. Temporary copy for the Connector.
    fs.mkdirSync(p.incoming, { recursive: true });
    fs.writeFileSync(path.join(p.incoming, savedAs), file.buffer, { flag: 'wx' });

    await audit(req.user.user_id, 'BIOMETRIC_FILE_UPLOADED', {
      file_id: ins.insertId, original_name: original, saved_as: savedAs, stored_name: storedName,
      bytes: file.buffer.length, checksum,
    });
    const result = await runConnector(p);
    await settleUploads(p);

    const [[saved]] = await db.query(
      'SELECT id, result_status, batch_id FROM biometric_import_files WHERE id = ?', [ins.insertId]
    );
    return res.status(200).json({
      status: 'success',
      data: {
        saved_as: savedAs,
        file_id: saved.id,
        file_status: saved.result_status,
        batch_id: saved.batch_id,
        ...result,
      },
    });
  } catch (error) {
    console.error('BIOMETRIC UPLOAD/RUN ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to save the file or run the Connector.' });
  } finally {
    running = false;
  }
};

// POST /api/biometric/import-run  (process whatever is already in incoming)
exports.runOnly = async (req, res) => {
  const p = connectorPaths();
  if (!p) return notConfigured(res);
  if (running) return res.status(409).json({ status: 'error', message: 'An import is already running.' });
  running = true;
  try {
    await audit(req.user.user_id, 'BIOMETRIC_CONNECTOR_RUN', {});
    const result = await runConnector(p);
    if (await hasFilesTable()) await settleUploads(p);
    return res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    console.error('BIOMETRIC RUN ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to run the Connector.' });
  } finally {
    running = false;
  }
};

// GET /api/biometric/import-batches?limit=30
exports.listBatches = async (req, res) => {
  const requested = Number(req.query.limit);
  const limit = Number.isInteger(requested) && requested >= 1 && requested <= 100 ? requested : 30;
  try {
    const filesReady = await hasFilesTable();
    const [rows] = await db.query(
      `SELECT b.id, b.source_file, b.status, b.total_rows, b.inserted_rows, b.duplicate_rows, b.error_rows,
              b.imported_at, b.created_at
              ${filesReady
                ? `, (SELECT f.id FROM biometric_import_files f WHERE f.checksum = b.checksum
                      ORDER BY f.id LIMIT 1) AS file_id,
                   (SELECT f.original_name FROM biometric_import_files f WHERE f.checksum = b.checksum
                      ORDER BY f.id LIMIT 1) AS file_name`
                : ''}
       FROM attendance_import_batches b
       ORDER BY b.id DESC
       LIMIT ${limit}`
    );
    // Uploads that did not become a batch (rejected, or not processed yet).
    let notImported = [];
    if (filesReady) {
      [notImported] = await db.query(
        `SELECT id, original_name, size_bytes, uploaded_at, result_status, result_details
         FROM biometric_import_files
         WHERE batch_id IS NULL
         ORDER BY id DESC
         LIMIT ${limit}`
      );
    }
    const p = connectorPaths();
    const connector = p
      ? {
          enabled: true,
          running,
          incoming_files: countFiles(p.incoming, (f) => p.pattern.test(f)),
          failed_files: countFiles(p.failed, (f) => p.pattern.test(f)),
          file_storage: filesReady,
        }
      : { enabled: false, running: false, incoming_files: 0, failed_files: 0, file_storage: filesReady };
    return res.status(200).json({ status: 'success', data: rows, not_imported: notImported, connector });
  } catch (error) {
    console.error('LIST IMPORT BATCHES ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load import batches.' });
  }
};

// GET /api/biometric/import-files/:fileId/download  - the original file as uploaded
exports.downloadFile = async (req, res) => {
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid file id.' });
  }
  try {
    if (!(await hasFilesTable())) return filesTableMissing(res);
    const [[f]] = await db.query(
      'SELECT id, original_name, stored_name FROM biometric_import_files WHERE id = ?', [fileId]
    );
    if (!f) return res.status(404).json({ status: 'error', message: 'File not found.' });
    res.attachment(f.original_name);
    const sent = await fileStorage.send(res, f.stored_name);
    if (!sent) {
      res.removeHeader('Content-Disposition');
      return res.status(404).json({ status: 'error', message: 'The stored file could not be found.' });
    }
    await audit(req.user.user_id, 'BIOMETRIC_FILE_DOWNLOADED', { file_id: f.id, original_name: f.original_name });
  } catch (error) {
    console.error('BIOMETRIC FILE DOWNLOAD ERROR:', error);
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      return res.status(500).json({ status: 'error', message: 'Failed to download the file.' });
    }
  }
};

// GET /api/biometric/import-batches/:batchId
exports.getBatchDetail = async (req, res) => {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
  }
  try {
    const [rows] = await db.execute('SELECT * FROM attendance_import_batches WHERE id = ?', [batchId]);
    if (!rows.length) return res.status(404).json({ status: 'error', message: 'Batch not found.' });
    const b = rows[0];

    const [proc] = await db.execute(
      `SELECT pr.processing_status, COUNT(*) AS cnt
       FROM attendance_punches p
       JOIN attendance_punch_processing pr ON pr.punch_id = p.id
       WHERE p.batch_id = ?
       GROUP BY pr.processing_status`,
      [batchId]
    );
    const processing = { Pending: 0, Processed: 0, Skipped: 0, Failed: 0 };
    proc.forEach((r) => { processing[r.processing_status] = Number(r.cnt); });

    let errors = b.error_details;
    if (typeof errors === 'string') {
      try { errors = JSON.parse(errors); } catch (_) { errors = []; }
    }
if (
  errors &&
  !Array.isArray(errors) &&
  Array.isArray(errors.parse_errors)
) {
  errors = errors.parse_errors;
}
    let fileRow = null;
    if (await hasFilesTable()) {
      [[fileRow]] = await db.query(
        `SELECT id, original_name, size_bytes, uploaded_at FROM biometric_import_files
         WHERE checksum = ? ORDER BY id LIMIT 1`, [b.checksum]
      );
    }
    return res.status(200).json({
      status: 'success',
      data: {
        file: fileRow || null,
        batch: {
          id: b.id, source_file: b.source_file, status: b.status,
          total_rows: b.total_rows, inserted_rows: b.inserted_rows,
          duplicate_rows: b.duplicate_rows, error_rows: b.error_rows,
          imported_at: b.imported_at, created_at: b.created_at,
        },
        processing,
        errors: Array.isArray(errors) ? errors : [],
      },
    });
  } catch (error) {
    console.error('GET IMPORT BATCH DETAIL ERROR:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load batch.' });
  }
};