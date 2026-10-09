# 2026-10 Payroll adjustments (retro pay)

## Deploy order
1. Take a database backup.
2. Run `migrations/2026_10_recycle_bin/01_ddl.sql`, if it has not been run yet.
3. Run `migrations/2026_10_payroll_adjustments/01_ddl.sql`. Its last SELECT must show 3 rows with `present = 1`. Running it twice is safe.
4. Deploy the backend. It refuses to start if step 3 is missing.
5. Deploy the app.

Rollback: see `99_rollback.sql`. Run its SELECTs first; the DROP statements are commented out.

## What changes in the database
- **New table `payroll_adjustments`:** one row per money difference.
- **New column `payroll.adjustments_amount`:** DEFAULT 0, so every old row stays 0.
- **New column `staff_payroll.adjustments_amount`:** DEFAULT 0.
- **Meaning of the new column:** on new batches, `net_salary` = calculated salary + `adjustments_amount`.
- **No existing value is modified.**

## API (Admin only)
| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/payroll-adjustments?status=&person_type=` | | List adjustments |
| POST | `/api/payroll-adjustments` | `{person_type, person_id, amount, reason}` | Manual adjustment (a negative amount waits for confirmation) |
| PATCH | `/api/payroll-adjustments/:id/confirm` | | Confirm a deduction |
| PATCH | `/api/payroll-adjustments/:id/cancel` | `{reason}` | Cancel a Pending or AwaitingConfirmation adjustment |
| GET | `/api/payroll-adjustments/open-corrections` | | Corrections on finalized or paid periods that have no amount yet |
| POST | `/api/payroll-adjustments/open-corrections/:id/compute` | | Compute the amount for an older correction (its batch must be Paid) |
| GET | `/api/staff-attendance/admin/records?start_date&end_date[&staff_id]` | | Approved staff records, with the payroll batch state for each date |
| POST | `/api/staff-attendance/admin/:id/correction` | adds `complete_day`, `is_management_paid_absence` | Staff correction |

## Rules
- **Correction in a Paid period:**
  - amount = pay(corrected) − pay(original), using the formula and rates of the paid period. The paid batch is never changed.
  - Workers: the one day is recalculated.
  - Staff: the whole month is recalculated twice, so the difference comes from this correction only.
- **Correction in a Finalized period:**
  - No amount is created; the response asks for a Supersede.
  - If the batch is marked Paid instead, the correction becomes an adjustment at that moment.
- **Correction in a period with a non-finalized batch:** the response asks to void and regenerate.
- **Statuses:**
  - `AwaitingConfirmation`: deductions only. The Admin confirms, then it becomes `Pending`.
  - `Pending` → `Included` in the next batch that pays the person → `Applied` when that batch is marked Paid.
  - Void or supersede of that batch returns the adjustment to `Pending`.
- **Worker adjustments:** carried by Regular batches only, never by an off-cycle batch.
- **Pending deductions larger than the pay:** they stay Pending and the generate response gives a warning.
- **Recycle bin:** a staff member with adjustments that are not cancelled cannot be deleted.

Tests: `tests/payroll_adjustments.integration.test.js` (13 scenarios).
