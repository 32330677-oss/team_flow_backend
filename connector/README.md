# Biometric Connector (inside the backend)

A copy of the `attendance-connector` repository (`src/` and `config/`), so the
backend can run it on the same server.

How it is used:
1. The Admin uploads a device export file in the app (Biometric Import).
2. The backend keeps the original file forever in file storage (S3) and records it in `biometric_import_files`.
3. It puts a temporary copy in `connector/data/incoming` and runs `node connector/src/main.js`.
4. The Connector sends the punches to the backend (`/api/biometric/batches`, `/punches`, `/complete`) using `ATTENDANCE_CONNECTOR_TOKEN`.
5. The backend records the result and removes the temporary copy.

Required env on the backend:
- `BIOMETRIC_CONNECTOR_DIR=connector`
- `ATTENDANCE_CONNECTOR_TOKEN` (32+ characters)
- Optional `BIOMETRIC_CONNECTOR_API_URL` (default `http://127.0.0.1:$PORT`).

`connector/data/` and `connector/logs/` are created at run time and are not in git.
If you change the Connector, change it here as well as in the `attendance-connector` repository.
