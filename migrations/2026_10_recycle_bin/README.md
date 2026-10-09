# 2026-10 Recycle bin (Staff safe delete, 30-day undo)

## Deploy order
1. Take a database backup.
2. Run `01_ddl.sql` once. It only creates `recycle_bin` and `entity_deletion_holds` and the setting `recycle_bin_retention_days = 30`. Running it twice is safe.
3. Deploy the backend. It refuses to start if step 2 is missing, because payroll generation reads `entity_deletion_holds`.
4. Deploy the app.

Rollback: see `99_rollback.sql`. Run its SELECT first, and drop the tables only when the bin is empty.

## API (Admin only)
| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/staff/:id/deletion-check` | | Lists the blockers and what would move to the bin |
| POST | `/api/staff/:id/deletion-hold` | `{reason}` | Leaves the person out of new payroll (needed before superseding a finalized batch) |
| DELETE | `/api/staff/:id/deletion-hold` | `{reason}` | Releases the hold |
| DELETE | `/api/staff/:id` | `{reason, confirm_name}` | Moves the person to the bin |
| GET | `/api/recycle-bin?status=Deleted\|Restored` | | Lists bin entries (the payload is never sent) |
| POST | `/api/recycle-bin/:id/restore` | `{reason}` | Restores every row with its original id |
| DELETE | `/api/recycle-bin/:id` | `{reason}` | Deletes the entry permanently now |

## Rules
- **Paid batch:** never deleted.
- **Generated batch (not finalized):** void it first.
- **Finalized batch:** hold, then supersede, then delete.
- **Voided / Superseded batches:** the person's lines move to the bin. The batch header totals are kept as history.
- **Biometric data:** a device mapping or processed punches block the delete for now, because biometric is not in use yet.
- **Unknown tables:** any other table with a foreign key that still points to the person blocks the delete (`UNHANDLED_DEPENDENCY`).
- **Restore:**
  - Refused while a Paid batch, or a non-finalized batch generated after the person was excluded, covers his employment.
  - A finalized batch only produces a warning, so it can be corrected with Supersede after the restore.
- **Purge:** entries are purged after 30 days, at server start and every 6 hours. Only an audit row with ids and no name remains.

Tests: `tests/recycle_bin.integration.test.js` (10 scenarios).
