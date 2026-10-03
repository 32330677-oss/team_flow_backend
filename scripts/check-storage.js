// scripts/check-storage.js
// Quick health check of the file storage settings: write -> read -> delete a tiny test file.
// Usage (from the backend folder, S3_* values in .env):
//   node scripts/check-storage.js
// Prints PASS/FAIL for each step. Touches only the test file "healthcheck-<timestamp>.txt".
require('dotenv').config();

const { Writable } = require('stream');
const storage = require('../services/fileStorage');

function fakeResponse() {
    const chunks = [];
    const res = new Writable({
        write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    res.headers = {};
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.sendFile = (p) => { chunks.push(require('fs').readFileSync(p)); res.end(); };
    res.body = () => Buffer.concat(chunks).toString('utf8');
    return res;
}

(async () => {
    console.log(`Driver: ${storage.DRIVER}`);
    const name = `healthcheck-${Date.now()}.txt`;
    const content = `team-flow storage check ${new Date().toISOString()}`;

    await storage.save(name, Buffer.from(content), 'text/plain');
    console.log('PASS 1/4 write');

    const res = fakeResponse();
    const found = await storage.send(res, name);
    await new Promise((r) => res.on('finish', r));
    if (!found || res.body() !== content) throw new Error('read back did not match');
    console.log('PASS 2/4 read (content matches)');

    await storage.remove(name);
    const res2 = fakeResponse();
    const stillThere = await storage.send(res2, name);
    if (stillThere) throw new Error('file still exists after delete');
    console.log('PASS 3/4 delete');

    const missing = await storage.send(fakeResponse(), 'does-not-exist.jpg');
    if (missing) throw new Error('missing file was reported as found');
    console.log('PASS 4/4 missing file -> 404');

    console.log('\nSTORAGE OK');
    process.exit(0);
})().catch((error) => {
    console.error(`\nFAIL: ${error.name || ''} ${error.message}`);
    if (/Access Denied|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(String(error.name) + error.message)) {
        console.error('-> check S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY and that the token has Object Read & Write on this bucket.');
    }
    if (/NoSuchBucket/i.test(String(error.name) + error.message)) {
        console.error('-> check S3_BUCKET (exact name, lowercase).');
    }
    if (/ENOTFOUND|getaddrinfo/i.test(error.message)) {
        console.error('-> check S3_ENDPOINT (https://<ACCOUNT_ID>.r2.cloudflarestorage.com, no bucket name at the end).');
    }
    process.exit(1);
});