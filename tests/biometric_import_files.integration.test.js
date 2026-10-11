// tests/biometric_import_files.integration.test.js
//
// Biometric Import from the app, with the Connector running inside the backend:
// - the original file is kept forever in file storage + biometric_import_files
// - the Connector imports the punches through the real HTTP API
// - the temporary copies on the server disk are removed after the run
// - rejected files are recorded with the reason and can still be downloaded
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated folders for this test (set before the server is loaded).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-bif-'));
const UPLOADS = path.join(TMP, 'uploads');
const CONNECTOR = path.join(TMP, 'connector');
fs.cpSync(path.join(__dirname, '..', 'connector', 'src'), path.join(CONNECTOR, 'src'), { recursive: true });
fs.cpSync(path.join(__dirname, '..', 'connector', 'config'), path.join(CONNECTOR, 'config'), { recursive: true });
process.env.STORAGE_DRIVER = 'local';
process.env.UPLOAD_DIR = UPLOADS;
process.env.BIOMETRIC_CONNECTOR_DIR = CONNECTOR;
const TOKEN = 'connector-token-for-biometric-file-tests-0001';
process.env.ATTENDANCE_CONNECTOR_TOKEN = TOKEN;

const { resetDatabase, startServer, stopServer, client, q, token } = require('./helpers');

const DATA = (sub) => path.join(CONNECTOR, 'data', sub);
const list = (sub) => { try { return fs.readdirSync(DATA(sub)); } catch (_) { return []; } };
const admin = () => client(1, 'Admin');
let base;

async function upload(name, content) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), name);
  const res = await fetch(`${base}/api/biometric/import-file`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token(1, 'Admin')}` },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function download(fileId, userId = 1, role = 'Admin') {
  const res = await fetch(`${base}/api/biometric/import-files/${fileId}/download`, {
    headers: { Authorization: `Bearer ${token(userId, role)}` },
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const GOOD = [
  '901 2026-09-28 07:58:12 1 255 1 02',
  '901 2026-09-28 16:46:58 0 255 1 02',
  '902 2026-09-28 08:03:40 1 255 1 01',
  'this line is not a punch',
].join('\n') + '\n';
const BAD = 'hello\nnot a device export\n';

test.before(async () => {
  resetDatabase({ migrate: true });
  base = await startServer();
  process.env.BIOMETRIC_CONNECTOR_API_URL = base;
});
test.after(async () => {
  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('BI1 upload: punches imported, original kept, server disk clean', async () => {
  const r = await upload('device export.txt', GOOD);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.exit_code, 0, r.body.data.output.join('\n'));
  assert.equal(r.body.data.file_status, 'Imported');
  const batchId = r.body.data.batch_id;
  assert.ok(batchId);

  const [b] = await q('SELECT status, inserted_rows, error_rows FROM attendance_import_batches WHERE id = ?', [batchId]);
  assert.equal(b.status, 'CompletedWithErrors');
  assert.equal(b.inserted_rows, 3);
  assert.equal(b.error_rows, 1);

  const [f] = await q('SELECT * FROM biometric_import_files WHERE id = ?', [r.body.data.file_id]);
  assert.equal(f.original_name, 'device export.txt');
  assert.equal(f.batch_id, batchId);
  assert.equal(f.size_bytes, Buffer.byteLength(GOOD));
  assert.match(f.result_details || '', /not a punch|Invalid|line/i); // invalid line kept
  assert.equal(fs.readFileSync(path.join(UPLOADS, f.stored_name), 'utf8'), GOOD);

  assert.deepEqual(list('incoming'), []);
  assert.deepEqual(list('processed'), []);
  assert.deepEqual(list('failed'), []);

  const l = await admin().get('/api/biometric/import-batches');
  assert.equal(l.status, 200);
  const row = l.body.data.find((x) => x.id === batchId);
  assert.equal(row.file_id, f.id);
  assert.equal(row.file_name, 'device export.txt');
  assert.equal(l.body.connector.enabled, true);
  assert.equal(l.body.connector.file_storage, true);

  const d = await admin().get(`/api/biometric/import-batches/${batchId}`);
  assert.equal(d.body.data.file.id, f.id);

  const dl = await download(f.id);
  assert.equal(dl.status, 200);
  assert.equal(dl.text, GOOD);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="device export.txt"/);
});

test('BI2 same file again: already imported, no new punches, the copy is still kept', async () => {
  const [before] = await q('SELECT COUNT(*) AS n FROM attendance_punches');
  const r = await upload('device export again.txt', GOOD);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.file_status, 'AlreadyImported');
  const [after] = await q('SELECT COUNT(*) AS n FROM attendance_punches');
  assert.equal(after.n, before.n);
  const [n] = await q('SELECT COUNT(*) AS n FROM biometric_import_files WHERE checksum = (SELECT checksum FROM biometric_import_files WHERE id = ?)', [r.body.data.file_id]);
  assert.equal(n.n, 2);
  assert.deepEqual(list('processed'), []);
});

test('BI3 rejected file: recorded with the reason, listed, downloadable, disk clean', async () => {
  const r = await upload('wrong.txt', BAD);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.file_status, 'Failed');
  assert.equal(r.body.data.batch_id, null);
  const [f] = await q('SELECT * FROM biometric_import_files WHERE id = ?', [r.body.data.file_id]);
  assert.ok(f.result_details && f.result_details.length > 0);
  assert.deepEqual(list('failed'), []);

  const l = await admin().get('/api/biometric/import-batches');
  const ni = l.body.not_imported.find((x) => x.id === f.id);
  assert.equal(ni.result_status, 'Failed');
  assert.equal(ni.original_name, 'wrong.txt');

  const dl = await download(f.id);
  assert.equal(dl.status, 200);
  assert.equal(dl.text, BAD);
});

test('BI4 connector cannot authenticate: file waits in incoming, Run pending finishes it', async () => {
  process.env.ATTENDANCE_CONNECTOR_TOKEN = 'short';
  const content = '903 2026-09-29 07:00:00 1\n';
  const r = await upload('late.txt', content);
  process.env.ATTENDANCE_CONNECTOR_TOKEN = TOKEN;
  assert.equal(r.status, 200);
  assert.equal(r.body.data.file_status, 'Pending');
  assert.equal(list('incoming').length, 1);

  const run = await admin().post('/api/biometric/import-run');
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const [f] = await q('SELECT result_status, batch_id FROM biometric_import_files WHERE id = ?', [r.body.data.file_id]);
  assert.equal(f.result_status, 'Imported');
  assert.ok(f.batch_id);
  assert.deepEqual(list('incoming'), []);
  assert.deepEqual(list('processed'), []);
});

test('BI5 storage failure: nothing is imported', async () => {
  const [before] = await q('SELECT (SELECT COUNT(*) FROM biometric_import_files) AS f, (SELECT COUNT(*) FROM attendance_import_batches) AS b');
  fs.renameSync(UPLOADS, `${UPLOADS}.off`);
  fs.writeFileSync(UPLOADS, 'not a folder');
  try {
    const r = await upload('other.txt', '904 2026-09-30 07:00:00 1\n');
    assert.equal(r.status, 502);
  } finally {
    fs.rmSync(UPLOADS);
    fs.renameSync(`${UPLOADS}.off`, UPLOADS);
  }
  const [after] = await q('SELECT (SELECT COUNT(*) FROM biometric_import_files) AS f, (SELECT COUNT(*) FROM attendance_import_batches) AS b');
  assert.deepEqual(after, before);
  assert.deepEqual(list('incoming'), []);
});

test('BI6 download is Admin only; unknown file is 404', async () => {
  const [f] = await q('SELECT id FROM biometric_import_files ORDER BY id LIMIT 1');
  assert.equal((await download(f.id, 11, 'Supervisor')).status, 403);
  assert.equal((await download(999999)).status, 404);
  assert.equal((await download('abc')).status, 400);
});
