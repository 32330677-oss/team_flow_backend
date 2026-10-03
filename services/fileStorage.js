// services/fileStorage.js
// One place that decides WHERE uploaded files live.
//   STORAGE_DRIVER=local (default) -> a folder on disk (UPLOAD_DIR, default ./uploads)
//   STORAGE_DRIVER=s3              -> an S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2...)
// The database stores ONLY the file name (e.g. "personal_photo-1696...-ab12cd.jpg").
// Legacy values like "uploads/x.jpg", "uploads\\x.jpg" or a full URL still work,
// because every lookup uses path.basename() of the stored value.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DRIVER = String(process.env.STORAGE_DRIVER || 'local').toLowerCase();
const LOCAL_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
const PREFIX = String(process.env.S3_PREFIX || 'worker-files').replace(/^\/+|\/+$/g, '');
const BUCKET = process.env.S3_BUCKET;

let S3 = null;
let s3 = null;
if (DRIVER === 's3') {
    S3 = require('@aws-sdk/client-s3');
    const missing = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !process.env[k]);
    if (missing.length) {
        console.error(`FATAL: STORAGE_DRIVER=s3 but missing env: ${missing.join(', ')}`);
        process.exit(1);
    }
    s3 = new S3.S3Client({
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT || undefined, // R2: https://<account_id>.r2.cloudflarestorage.com
        forcePathStyle: Boolean(process.env.S3_ENDPOINT),
        credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
    });
}

const keyOf = (name) => (PREFIX ? `${PREFIX}/${name}` : name);

/** Stored DB value -> safe bare file name (no folders, no traversal). */
function safeName(stored) {
    if (!stored) return null;
    const name = path.basename(String(stored).split('?')[0].replace(/\\/g, '/'));
    return name && name !== '.' && name !== '..' ? name : null;
}

/** New unique file name: <field>-<timestamp>-<random>.<ext> */
function newName(field, originalName) {
    const ext = path.extname(originalName || '').toLowerCase();
    return `${field}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

/** Save a buffer; returns the name to store in the database. */
async function save(name, buffer, contentType) {
    if (DRIVER === 's3') {
        await s3.send(new S3.PutObjectCommand({
            Bucket: BUCKET, Key: keyOf(name), Body: buffer, ContentType: contentType || 'application/octet-stream',
        }));
    } else {
        fs.mkdirSync(LOCAL_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOCAL_DIR, name), buffer);
    }
    return name;
}

/** Stream a stored file to the HTTP response. Returns false when it does not exist. */
async function send(res, stored) {
    const name = safeName(stored);
    if (!name) return false;

    if (DRIVER === 's3') {
        let out;
        try {
            out = await s3.send(new S3.GetObjectCommand({ Bucket: BUCKET, Key: keyOf(name) }));
        } catch (error) {
            if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return false;
            throw error;
        }
        if (out.ContentType) res.setHeader('Content-Type', out.ContentType);
        if (out.ContentLength) res.setHeader('Content-Length', out.ContentLength);
        out.Body.pipe(res);
        return true;
    }

    const absolute = path.join(LOCAL_DIR, name);
    if (!absolute.startsWith(LOCAL_DIR + path.sep) || !fs.existsSync(absolute)) return false;
    res.sendFile(absolute);
    return true;
}

/** Best-effort delete (used when a photo is replaced). Never throws. */
async function remove(stored) {
    const name = safeName(stored);
    if (!name) return;
    try {
        if (DRIVER === 's3') {
            await s3.send(new S3.DeleteObjectCommand({ Bucket: BUCKET, Key: keyOf(name) }));
        } else {
            const absolute = path.join(LOCAL_DIR, name);
            if (absolute.startsWith(LOCAL_DIR + path.sep)) fs.unlinkSync(absolute);
        }
    } catch (_) { /* ignore */ }
}

module.exports = { DRIVER, safeName, newName, save, send, remove };