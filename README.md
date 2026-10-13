# Team Flow – Backend

REST API for **Team Flow**, a workforce management system for construction sites:
workers, staff, sites and contracts, daily attendance (manual and biometric),
transfers, payroll (workers and staff), advances and reports.

The Flutter app lives in [`team_flow`](https://github.com/32330677-oss/team_flow);
the biometric file importer in [`attendance-connector`](https://github.com/32330677-oss/attendance-connector)
(a copy is bundled here under `connector/`).

## Stack

- Node.js 20+ · Express 5
- MySQL 8 (production: Aiven, over SSL)
- File storage: S3-compatible bucket (or local disk in development)
- Deployed on Render

## Run locally

```bash
npm install
cp .env.example .env      # then fill in at least JWT_SECRET and the DB_* values
npm run dev               # nodemon, restarts on change
# or
npm start
```

The server listens on `PORT` (default `5000`). Every variable is listed and
explained in [`.env.example`](.env.example).

### First Admin user

```bash
ADMIN_USERNAME=... ADMIN_PASSWORD=... ADMIN_FULL_NAME=... node scripts/seedAdmin.js
```

The password must be at least 12 characters. The script never overwrites an existing user.

## Database migrations

SQL migrations live in `migrations/<name>/`. Each folder has the forward
scripts (`01_…`, `02_…`) and a `99_rollback.sql`; most also have a `README.md`
with a **Deploy order** section. Run them in that order with the MySQL client:

```bash
mysql -h $DB_HOST -u $DB_USER -p $DB_NAME < migrations/2026_10_recycle_bin/01_ddl.sql
```

Apply `2026_10_hardening` first (`01_precheck_readonly` → `06_validation`), then
the other folders as described in their READMEs.

**The server refuses to start** if a required migration is missing
(hardening marker, off-cycle payroll, recycle bin, payroll adjustments, staff
advances) and prints which one in the log. This is on purpose: it never runs
with a schema that would give wrong dates or wrong payroll.

## Tests

```bash
npm test
```

Integration tests need a local MySQL. They create a throw-away database
(`TEST_DB_NAME`, default `team_flow_test`) through `TEST_MYSQL_CLI`
(default `mysql -uroot`) and load `tests/schema/` plus the migrations.

## Health checks

| Path | Meaning |
| --- | --- |
| `GET /health` | The process is up (no database call). Use this as Render's health check path. |
| `GET /health/db` | The database is reachable (`503` if not). Use it for monitoring. |

## Deployment (Render)

- Build command: `npm install` · Start command: `npm start`
- Set every variable from `.env.example` that applies, and `NODE_ENV=production`.
- On redeploy Render sends `SIGTERM`; the server stops taking requests, lets
  running ones finish and closes the DB pool (up to 10 s).

## Project layout

```
server.js          entry point: middleware, routes, startup checks
config/            database pool
routes/            Express routers (one per feature)
controllers/       request handlers
services/          business logic (payroll, attendance, storage, PDF, …)
middleware/        auth, roles, rate limits
migrations/        SQL migrations (see above)
connector/         bundled biometric connector
templates/, assets/ document templates and fonts
scripts/           one-off maintenance scripts
tests/             integration and unit tests
```
