# 2026-10 Staff salary advances

Staff only. Worker payroll is not touched.

## Deploy order
1. Take a database backup.
2. Run `migrations/2026_10_payroll_adjustments/01_ddl.sql` if it has not been run yet.
3. Run `migrations/2026_10_staff_advances/01_ddl.sql`. Its last SELECT must show 6 rows with `present = 1`. Running it twice is safe.
4. Run `migrations/2026_10_staff_advances/02_frozen_documents.sql`. Its last SELECT must show 8 rows with `present = 1`. Running it twice is safe. It only adds nullable columns, so it is safe on a database where advances already exist.
5. Deploy the backend. It refuses to start if step 3 or 4 is missing.
   - Optional env `PUBLIC_BASE_URL` (e.g. `https://team-flow-backend-f15z.onrender.com`): the address printed in the QR codes. Without it, the address the request came in on is used.
   - Optional env `PUBLIC_DOC_RATE_LIMIT_MAX` (default 60 per 15 minutes per IP) for QR downloads.
6. Deploy the app.

Rollback: see `99_rollback.sql`. Run its SELECTs first; the DROP statements are commented out.

## What changes in the database
- **New tables:**
  - `document_sequences`: one row per document series (`ADV-2026`, `RCP-2026`).
  - `staff_financial_reports`: the report the Admin must open before an advance, saved as a snapshot.
  - `staff_advances`: one row per advance, with a `UNIQUE` voucher number.
  - `staff_advance_installments`: the deduction schedule (month + amount).
  - `staff_advance_ledger`: an append-only money ledger. The balance is `SUM(amount)`.
- **New column `staff_payroll.advance_deduction_amount`:** `DEFAULT 0`, so every old row stays 0.
- **Meaning of `net_salary` on new staff batches:** `net_salary = calculated + adjustments_amount - advance_deduction_amount`.
- **New settings:**
  - `advance_cancel_window_hours = 72`
  - `advance_allow_multiple_open = false`
  - `advance_report_valid_minutes = 30`
- **No existing value is modified.**

## API (Admin only)
| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/api/staff-advances/financial-report` | `{staff_id}` | Open the financial report (required before an advance) |
| GET | `/api/staff-advances/financial-report/:id(.pdf)` | | Read or print a saved report |
| GET | `/api/staff-advances/months` | | Next 12 months: Paid (not selectable) / batch exists (warning) |
| GET | `/api/staff-advances?status=&staff_id=&month=&q=` | | List, plus open balance per currency |
| POST | `/api/staff-advances` | `{staff_id, amount, schedule:[{month:'YYYY-MM', amount}], reason, payment_method?, payment_reference?, financial_report_id, idempotency_key?}` | Create: the voucher number is assigned now |
| GET | `/api/staff-advances/:id` | | Details, schedule and ledger |
| GET | `/api/staff-advances/:id/voucher.pdf` | | Payment voucher. Every print is counted; reprints say COPY, a cancelled voucher says CANCELLED |
| POST | `/api/staff-advances/:id/cancel` | `{reason}` | Cancel within 72h: everything goes back to how it was |
| PUT | `/api/staff-advances/:id/schedule` | `{schedule, reason}` | Move installments that are not in a batch yet |
| POST | `/api/staff-advances/:id/repay` | `{amount, reason, payment_method?}` | Cash repayment with a receipt `RCP-YYYY-NNNNNN` |
| GET | `/api/staff-advances/:id/repayments/:entryId/receipt.pdf` | | Repayment receipt |
| POST | `/api/staff-advances/:id/write-off` | `{reason}` | Write off the balance |
| POST / GET | `/api/staff-advances/:id/signed-receipt` | multipart `file` | Upload / download the signed voucher (JPG, PNG, WEBP or PDF, max 8 MB) |
| GET | `/api/staff-advances/:id/statement.pdf` | | Advance Statement: the CURRENT state (schedule, deductions, repayments, balance) |
| GET | `/api/public/documents/:token.pdf` | | **No login.** The QR code on a voucher / receipt. Downloads that document as issued |

## Frozen documents and QR codes
- **When a voucher or receipt is frozen:** at the moment it is issued, in the same transaction. Its content is stored as JSON (`voucher_snapshot` / `document_snapshot`) with a SHA-256 fingerprint.
- **What a print shows:** every print and every QR download is drawn from that frozen content, so a copy always matches the signed paper.
  - Reprints say "COPY n"; QR downloads say "COPY (QR download)".
  - A cancelled voucher is stamped CANCELLED.
- **Where the current state is:** the **Advance Statement** shows it. The voucher never changes after it is issued.
- **The fingerprint:** if the stored content no longer matches it, the document is refused (`409 DOCUMENT_INTEGRITY`) instead of being printed.
- **The QR code:**
  - It holds a random, unguessable 32-character token. Unknown tokens get 404; downloads are rate limited and recorded in `auditlogs` (`PUBLIC_DOCUMENT_DOWNLOADED`).
  - Anyone holding the paper can download the document, so treat the QR like the paper itself.
- **Advances created before step 4:** they are frozen on their first print. Their schedule is taken from the creation audit entry, i.e. the schedule that was signed.

## Rules
- **Deduction month:**
  - The Admin chooses it. Full = one month; Partial = several months whose amounts add up to the advance.
  - A month that has a **Paid** staff batch is refused (`MONTH_PAID`). Months before the current month are refused.
  - The installment is carried by the staff batch whose `end_date` falls in that month.
  - If that month's batch already exists:
    - not finalized: the Admin is told to void it and generate it again;
    - finalized: the Admin is told to supersede it.
- **Generation:**
  - The advance is deducted after pending adjustments, and net never goes below 0.
  - An amount that cannot be deducted, or an installment of a staff member who is not in the batch, becomes **Unscheduled**. The generate response lists it in `advance_warnings`, and the Admin chooses a new month for it.
- **Void / supersede:** everything the batch did is undone. Split remainders merge back and installments return to Scheduled.
- **Mark Paid:** installments become Deducted and a ledger entry is written. At a 0 balance the advance becomes Settled.
- **Cancel (within 72h of creation):**
  - **The advance:** marked Cancelled, its number stays reserved, and a ledger entry brings the balance to 0.
  - **A deduction already in a Generated, not finalized batch:** removed from that batch. Net and the batch total go back to their exact previous values.
  - **Refused** if the batch is finalized (supersede first) or Paid, or if anything was already deducted or repaid.
- **After 72h:** an advance can only be closed by payroll deduction, cash repayment or write-off.
- **Voucher numbers:**
  - `ADV-YYYY-NNNNNN` and `RCP-YYYY-NNNNNN` are unique (`UNIQUE` keys) and never reused.
  - A double click with the same `idempotency_key` returns the same advance.
- **Blocks:**
  - A staff member with an open balance cannot be set Inactive or Terminated (`409 ADVANCE_OUTSTANDING`, no override).
  - A staff member with any advance cannot be deleted (`STAFF_ADVANCES` blocker).
- **Documents:**
  - **Staff batch Excel:** "Advance Deduction" and "Advance Voucher(s)" columns, plus an "Advances" sheet.
  - **Staff batch PDF:** an "Advance Deduction" column plus an "ADVANCES DEDUCTED IN THIS BATCH" table, with voucher numbers.
  - **Monthly staff report:** DEDUCTION includes the advance, so TOTAL still equals net.

Tests: `tests/staff_advances.integration.test.js` (19 scenarios). Full suite: 111 / 111.
