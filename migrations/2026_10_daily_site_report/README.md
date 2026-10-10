# 2026-10 Daily Site Manpower Report (sub-contractor PDF)

## Deploy order
1. Take a database backup.
2. Run `01_ddl.sql` once. It only creates two NEW tables (`report_signatories`, `daily_site_reports`). Running it twice is safe.
3. Deploy the backend (the server starts even without step 2; the report endpoints then answer 503 with a clear message).
4. Deploy the app. Admin sidebar → **Daily Site Report**.

Rollback: `99_rollback.sql` (shows how many reports would be lost, then drops both tables).

## API (Admin only) — `/api/reports/daily-site`
| Method | Path | Purpose |
|---|---|---|
| GET | `/options` | Active sites (with shifts, project, client), active signatories, business today |
| POST | `/preview` | Counts only (JSON). Nothing is saved |
| POST | `/generate` | PDF. Saved with number `DSR-YYYYMMDD-####` (header `X-Report-No`) |
| GET | `/history?limit=` | Last issued reports |
| GET | `/:id/pdf` | Re-print a saved report with the SAME data it was issued with |
| GET / POST / PUT | `/signatories[/:id]` | "Issued by" list (deactivate with `{is_active:false}`) |

Body of `preview` / `generate`:
`{ date, site_ids: [..] | 'all', shift: 'All'|'Day'|'Night', recipient_name, signatory_id, include_staff, show_absent_names }`
(`issued_by_name` / `issued_by_title` can replace `signatory_id`.)

## Rules
- **Assigned** = Active worker whose assignment covers the date (inclusive last day) on an Active site, per site + shift. Staff: `staff_site_assignments` covering the date.
- Only records **dated** the report date count. A Night shift that starts on D is dated D.
- **On site** = status Present with a check-in. Draft / Submitted / Approved all count (the report is issued during the day); the PDF footer says the figures are subject to final approval.
- **Not on site** = Absent, Sick, Leave (Vacation/Holiday) or no record yet.
- Never printed: hours, overtime, rates, salaries, phone, birth data, photos, internal notes, workflow status.
- Rendering: PDFKit (no headless browser). One PDF at a time (queue). Typical render < 1 s, ~180 KB file.

Tests: `tests/daily_site_report.integration.test.js` (5 scenarios).
