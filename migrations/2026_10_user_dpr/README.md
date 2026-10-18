# 2026-10 — accounts of type "User", roles & permissions, Daily Progress Report (DPR)

One migration for everything about the new account type. It **adds** only:

* the value `'User'` at the end of `users.role` (existing values, rows, default unchanged);
* 19 new tables: `app_roles`, `app_role_permissions`, `app_user_roles`, `app_access_audit`
  and the `dpr_*` tables (one set of data per contract: 71, 26, 59… are rows, not code).

Nothing else in the database is changed. The DPR only **reads** Team Flow
(attendance, workers, staff, sites) and reads the equipment system through its
read-only API (`/api/integration/*`).

## Files

| File | What it does |
|---|---|
| `01_ddl.sql` | Installs everything. Idempotent: running it twice changes nothing. |
| `98_remove_user_accounts.sql` | OPTIONAL, before a rollback: deletes the accounts of type `User` (and only them). All or nothing. |
| `02_ucc_v2.sql` | DPR v2 (the client's form UCC-IMS-CM-3003A + full control of the QC). Run AFTER `01_ddl.sql`. Adds columns to `dpr_*` tables and 5 new `dpr_*` tables (manual values with scope, areas, crews, materials, fixed pages). Idempotent. |
| `92_rollback_v2.sql` | Removes only what `02_ucc_v2.sql` added. Refuses while staff / tool rows or activities without BOQ item exist. |
| `97_reset_dpr_test_data.sql` | OPTIONAL: clears the DPR test data (A: daily data only, B: everything). Works before and after `02`. |
| `99_rollback.sql` | Removes all the DPR / roles tables (v2 included) and the value `'User'`. Refuses (changes nothing) while a `User` account exists. |

## Install (Aiven)

1. Backup first:
   `mysqldump -h HOST -P PORT -u avnadmin -p --single-transaction --routines defaultdb > backup_before_user_dpr.sql`
2. `mysql -h HOST -P PORT -u avnadmin -p defaultdb < 01_ddl.sql`
3. Check: `SHOW TABLES LIKE 'dpr%';` (15 rows) and `SHOW TABLES LIKE 'app%';` (4 rows).

## Install v2 (after 01 is installed)

1. Backup (as above).
2. `mysql -h HOST -P PORT -u avnadmin -p defaultdb < 02_ucc_v2.sql`
3. Check: `SHOW TABLES LIKE 'dpr%';` (20 rows) and `SHOW COLUMNS FROM dpr_contracts LIKE 'template';` (1 row).
4. Optional: `97_reset_dpr_test_data.sql` to clear the test days (keeps the setup).

## Rollback

1. Backup (the DPR data typed by the users is deleted with its tables).
2. `98_remove_user_accounts.sql` (only if `User` accounts exist).
3. `99_rollback.sql`.
4. Deploy the previous backend version.

## Render

New optional settings: none required. The plant figures use the existing
`EQUIPMENT_API_URL` and `EQUIPMENT_INTEGRATION_TOKEN`. The equipment backend
must be deployed with its new read-only routes `/api/integration/plant-days`
and `/api/integration/vendors` (otherwise the DPR shows a warning and plant = unknown).
