// scripts/upload-legacy-files.js
// One-time: copy the OLD photos from a local uploads folder into the bucket,
// keeping the same file names, so the paths already stored in the database keep working.
//
// Usage (from the backend folder, with the same S3_* values as Render in .env):
//   STORAGE_DRIVER=s3 node scripts/upload-legacy-files.js "C:\path\to\old\uploads"
// It only uploads; it never deletes or changes the database.
require('dotenv').config();
process.env.STORAGE_DRIVER = 's3';

const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const storage = require('../services/fileStorage');

const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

(async () => {
    const dir = process.argv[2];
    if (!dir || !fs.existsSync(dir)) {
        console.error('Give the old uploads folder as the first argument.');
        process.exit(1);
    }

    const [rows] = await db.query(
        `SELECT worker_id, personal_photo, id_photo FROM workers
         WHERE personal_photo IS NOT NULL OR id_photo IS NOT NULL`
    );

    let uploaded = 0;
    const missing = [];
    for (const row of rows) {
        for (const field of ['personal_photo', 'id_photo']) {
            const name = storage.safeName(row[field]);
            if (!name) continue;
            const local = path.join(dir, name);
            if (!fs.existsSync(local)) { missing.push(`worker ${row.worker_id} ${field}: ${name}`); continue; }
            await storage.save(name, fs.readFileSync(local), TYPES[path.extname(name).toLowerCase()]);
            uploaded += 1;
            console.log(`OK  worker ${row.worker_id} ${field} -> ${name}`);
        }
    }

    console.log(`\nUploaded: ${uploaded}`);
    console.log(`Missing locally: ${missing.length}`);
    missing.forEach((m) => console.log(`  - ${m}`));
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });