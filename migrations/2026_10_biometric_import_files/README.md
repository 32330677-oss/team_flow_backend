# 2026-10 Biometric import files

Keeps every device file uploaded from the app (Biometric Import) forever, and
lets the Connector run inside the backend on Render.

## Deploy order
1. Run `01_ddl.sql`. Its last SELECT must show 1 row with `present = 1`. Running it twice is safe.
   It only creates the new table `biometric_import_files`; nothing existing is changed.
2. On Render add:
   - `BIOMETRIC_CONNECTOR_DIR=connector`
   - `ATTENDANCE_CONNECTOR_TOKEN=<32+ random characters>`
3. Deploy the backend, then the app.

Without step 1 the backend still starts; only uploading a file answers
`503 Biometric file storage is not set up`.

## What happens on upload
1. The original file is saved in file storage (S3 when `STORAGE_DRIVER=s3`) and recorded in `biometric_import_files`. If this fails, nothing is imported.
2. A temporary copy goes to `connector/data/incoming`, and the Connector imports it through the API.
3. The result is recorded on the file row: `Imported`, `AlreadyImported`, `Failed` (with the reason), `Pending` (could not reach the API; "Run pending files" retries it) or `NotProcessed` (server restarted before processing).
4. The temporary copies are removed from the server disk. The original in storage is never deleted.

## API (Admin only)
- `GET /api/biometric/import-batches`: each batch has `file_id` / `file_name`; `not_imported` lists uploads that did not create a batch.
- `GET /api/biometric/import-batches/:id`: includes `file`.
- `GET /api/biometric/import-files/:fileId/download`: the original file, exactly as uploaded.

Tests: `tests/biometric_import_files.integration.test.js` (6 scenarios). Full suite: 117 / 117.
