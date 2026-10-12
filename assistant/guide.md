<!--
  Team Flow in-app assistant: user guide.
  The assistant answers ONLY from this file.

  Format rules (read by services/assistantService.js):
  * Each section starts with "## [Roles] Title", where Roles is a comma list of
    Admin, Supervisor, StaffSupervisor or All.
  * A user only receives the sections of his own role (plus [All]), so a
    Supervisor never sees Admin instructions.
  * "Screen:" names the screen id the "Open" button should open. Ids must exist
    in services/assistantScreens.js.
  * "Keywords:" are extra search words for the in-app Help Center (comma list).
  * Button names are written exactly as they appear in the app (English), in
    double quotes.

  When you add or change a screen or a button, update this file.
-->

## [All] About Team Flow
Team Flow manages site workers (laborers) and office staff for ASIK Engineering Construction: daily attendance, biometric punches, approval of attendance, payroll, salary advances, transfers between sites and daily site reports.
There are three account types:
- Admin: full access, through the navy sidebar on the left (on a phone, open it with the menu button at the top left).
- Supervisor (site supervisor): records daily attendance of the workers on his sites, resubmits rejected records, asks for worker transfers.
- StaffSupervisor: records daily attendance of office staff.
Attendance workflow states: Draft (saved by the supervisor, can still be changed) → Submitted (sent to the Admin, the supervisor can no longer change it) → Approved (only approved days are paid) or Rejected (sent back with a reason; correct and resubmit).
A night shift is recorded on the date it STARTED; its check-out may be on the next day (IN 12 Oct 19:00, OUT 13 Oct 05:00 is normal).
Attendance can only be recorded for today or past dates.
Keywords: overview, introduction, roles, accounts, workflow, draft, submitted, approved, rejected, status, night shift, states

## [All] Log in, forgot password, change password, log out
- Log in: enter your work "Email" and "Password", then press "Sign in" (or Enter). The app opens your home page by account type.
- Forgot password: on the login page press "Forgot password?", enter your email, press "Send Code", enter the 6-digit "Verification Code" from the email and the "New Password" twice, then press "Reset Password".
- Change password: Admin: sidebar → "Change Password". Supervisor and StaffSupervisor: open the side menu (top left) → "Change Password". Enter "Current Password", "New Password", "Confirm New Password".
- Log out: Admin: sidebar → "Log Out" → confirm. Supervisors: side menu → "Logout".
- If the app says "Your session has expired", just log in again.
Screen: change_password
Keywords: login, sign in, password, reset, forgot, logout, sign out, session expired, account

## [Supervisor] My sites (home page)
After login you see "My Sites Dashboard": one card per site (and shift) you supervise. Tap a site card to open its daily attendance page.
If you see "No sites assigned to you currently", ask the Admin to assign you as the site's Day or Night shift supervisor.
The side menu (top left) has: "My Sites Dashboard", "Rejected Records", "Worker Transfer Request", "Help & Assistant", "Change Password", "Logout". The help icon is also at the top of the home page.
Screen: supervisor_home
Keywords: home, dashboard, sites, my sites, no sites, menu, start

## [Supervisor] Record daily attendance of workers
1. On the home page tap the site card.
2. The page opens on today. Use "Previous day" / "Today" at the top to change the date.
3. For each worker use the buttons on his row: "Check in", "Check out", "Absent / leave" (Absent, Sick, Vacation, Holiday), "Start break" / "End break".
4. The "More actions" (⋮) menu on a row has: "Edit check-in / check-out", "Change status", "Edit lunch", "Request transfer".
5. To act on many workers at once, tick the checkboxes on their rows; a bar appears with "Check in (n)", "Check out (n)", "Absent (n)", "Edit times (n)" and "Clear selection".
6. Lunch for everybody: use "Lunch break (bulk)", set Start and End, untick anyone who did not take lunch, then "Save lunch times". "Different time for this worker" sets a personal lunch time.
7. Everything you enter is saved as Draft and can still be changed.
Use the "How this page works" (?) icon at the top for the rules.
Screen: supervisor_home
Keywords: attendance, check in, check out, absent, sick, vacation, holiday, leave, break, lunch, bulk, mark, record, time, edit time

## [Supervisor] Submit a day for review
When every worker of the day is recorded, press "Submit day for review" at the bottom, then "Submit".
If a worker has no lunch recorded, the app asks for each one: "Did not work lunch" or "Worked through lunch" (a reason is required; it becomes overtime), then "Confirm & submit".
Rules that can block submitting:
- Days are submitted in order, per site and shift: every earlier day must be submitted first. A Friday with nothing entered is skipped.
- "Previous week rule": the previous week (Saturday to Friday) must have no records still in Draft.
- If the page says the payroll for this date is finalized, the date is locked: ask the Admin to correct it.
After submitting, the records wait for the Admin to approve or reject them.
Screen: supervisor_home
Keywords: submit, send, review, day, finish, blocked, cannot submit, previous week, order, lunch, locked

## [Supervisor] Fix a rejected record
1. Open "Rejected Records" (the icon at the top of the home page, the side menu, or the icon at the top of the site attendance page).
2. Read the "Rejection Reason" on the record.
3. Press "Edit & Resubmit", correct the times or the "Attendance status" (tick "Check-out is on the next day (night shift)" if needed), add "Remarks", then "Resubmit".
Screen: rejected_records
Keywords: rejected, reject, fix, correct, resubmit, rejection reason, edit

## [Supervisor] Ask to transfer a worker to another site
Option 1 (quick): on the site attendance page, open the worker's "More actions" (⋮) → "Request transfer", choose "Target site", the shift (Day/Night) for sites with shifts, the "First day at the new site" and a reason.
Option 2: side menu → "Worker Transfer Request": choose "Current Site", "Worker", "Target Site", "Target Shift", "Effective Date (first day at the new site)" and "Reason for transfer (required)". After sending you can "Download Transfer Document".
The Admin must approve the request; the worker moves from the effective date.
Screen: transfer_request
Keywords: transfer, move, worker, site, shift, request, relocate

## [StaffSupervisor] Record office staff attendance
1. On the home page press "Take Staff Attendance".
2. The page opens on today. Use "Previous day" / "Next day" or "Change" to pick another date (past dates show "Backdated"; Friday asks for confirmation because it is normally a non-working day).
3. For each employee choose the attendance status and enter "Check-in" / "Check-out" times. For an absence you can add an "Absence note (optional)" that the Admin will see.
4. Shortcut: "Bulk Preset (optional)" fills the same In/Out/lunch for several employees (it only fills the fields; it does not save). "Mark remaining Present (n)" marks everyone not yet set as Present with the default shift.
5. Press "Save Draft (All)" to save, or submit for Admin review ("Submit for Review"). One employee can be submitted alone with "Submit this employee only".
Biometric employees may show "— enter check-out" while waiting for the biometric OUT; you can enter the real check-out time.
A date inside a finalized staff payroll is locked.
Screen: staff_attendance
Keywords: staff, employees, office, attendance, check in, check out, absent, save draft, submit, backdated, friday, previous day

## [Admin] Admin sidebar map
Sidebar items: "Live Operations", "Workers", "Attendance Review", "Daily Site Report", "Payroll", "Projects", "Worker Distribution", "HR Management", "Transfer Requests", "Staff Attendance & Payroll", "Supervisors Management", "Biometric Processing", "Biometric Import", "Device ID Mapping", then "Help & Assistant", "Change Password", "Log Out".
On a phone the sidebar opens from the menu button at the top left.
Screen: live_operations
Keywords: menu, sidebar, navigation, pages, where, find

## [Admin] Live Operations (dashboard)
Shows today, per site and shift (Day and Night are never combined): workers expected vs recorded, records Draft/Submitted/Approved/Rejected, biometric issues, pending transfers and payroll coverage. It refreshes automatically; "Refresh now" refreshes immediately.
"Needs attention" lists exceptions. Tap a site row to see its workers and issues, with shortcuts "Attendance review", "Biometric review", "Shift & supervisor setup" and "Open review".
"How these numbers are calculated" explains each figure.
Screen: live_operations
Keywords: dashboard, live, operations, today, overview, sites, status, numbers, statistics

## [Admin] Approve or reject worker attendance
1. Sidebar → "Attendance Review".
2. Choose the date and filters at the top; "Needs review only" shows only Submitted records; search a worker by name or ID and press Enter.
3. Per record: "Approve" or "Reject" (a rejection reason is required and is shown to the supervisor).
4. Many at once: tick records, then "Approve N" / "Reject N" (N = number selected).
5. Records flagged "Long session" need you to tick "I checked these times and they are correct" and write a "Review note" before approving.
Only Approved days are paid in payroll.
Screen: attendance_review
Keywords: approve, reject, attendance, review, pending, submitted, long session, bulk approve

## [Admin] Correct a worker's attendance (even after payroll)
Sidebar → "Attendance Review" → on the record press the "Correct attendance (Admin)" icon. Change "Attendance status", "Check-in (YYYY-MM-DD HH:MM)", "Check-out", lunch, "Worked through lunch (no lunch deducted)", write the "Reason (required)", then "Save correction".
If the period is already in a Paid payroll, the money difference is created automatically as a payroll adjustment for the next payroll. If the batch is Finalized but not paid, the app asks you to supersede it.
The "Management leave" icon on a record adds hours paid by management.
Screen: attendance_review
Keywords: correct, correction, edit attendance, fix time, change time, after payroll, paid period, management leave

## [Admin] Attendance & payroll settings
Sidebar → "Attendance Review" → the "Settings" (tune) icon at the top right. Settings: "Lunch is paid", "Standard work minutes per day", "Overtime rate (SYP per hour, workers)", "Long-session review threshold (hours)", "Attendance week starts on", "Supervisors submit days in order".
Every change needs an "Effective from" date and is kept in history; a back-dated change needs a reason.
Screen: attendance_review
Keywords: settings, lunch paid, overtime rate, standard hours, work minutes, week start, threshold, configuration

## [Admin] Generate worker payroll
1. Sidebar → "Payroll".
2. In "Generate New Payroll" choose "Start Date" and "End Date". Optional: use "For Selected Site" / "Filter by Site" for one site only.
3. Press "Generate Payroll Batch".
4. If some attendance in the period is not approved, a dialog lists it: "Cancel — review first" (recommended: approve them in Attendance Review, then generate again) or "Generate without them" (reason required).
5. If the dates overlap an existing period, the app warns ("Overlapping Period").
The new batch appears in "Payroll History" with status Generated.
Screen: payroll
Keywords: payroll, salary, salaries, wages, pay, generate, batch, period, month, workers

## [Admin] Review, finalize, export and pay a payroll batch
1. Sidebar → "Payroll" → in "Payroll History" tap the batch (search by batch ID; "Show history" also shows superseded and voided versions).
2. The batch shows each worker, the per-site breakdown and "Net Salary". "Payslip" prints one worker's payslip; "Print Daily Attendance" prints his days.
3. Export: "Export PDF Report" or "Export Excel Report".
4. Order: Generated → "Finalize" (locks the period and confirms management approval) → "Mark Paid" (cannot be undone).
5. While Generated and not finalized you can "Void" it. After finalizing, use "Correct (supersede)" to create a corrected new version.
Screen: payroll
Keywords: finalize, mark paid, paid, pay, export, excel, pdf, payslip, void, supersede, batch, approve payroll, print

## [Admin] Pay one worker now (off-cycle)
Sidebar → "Payroll" → "Pay one worker now (off-cycle)". Choose the first and last day to pay, pick the worker (search by name or ID), check the amount, write the reason (for example "Worker travelling home, requested his pay"), and confirm. Then finalize that off-cycle batch.
The next normal payroll automatically skips the days already paid off-cycle. Only approved attendance is paid.
Screen: payroll
Keywords: off-cycle, urgent, pay one worker, early payment, travel, advance pay, single worker

## [Admin] Payroll adjustments (pay more or deduct)
Open: Sidebar → "Payroll" → the "Payroll adjustments" icon at the top (also in Staff Payroll).
- "Manual adjustment" (+ button): choose Worker or Staff, the person, "Pay more" or "Deduct", the amount and a reason, then "Save". A deduction waits until you press "Confirm deduction" in the list.
- Adjustments are added to the next payroll of that person. Filter with "All" / "Workers" / "Staff".
- Corrections on paid periods that have no amount yet appear with "Compute".
Screen: payroll_adjustments
Keywords: adjustment, deduct, deduction, bonus, pay more, retro, difference, correction amount

## [Admin] Monthly labor hours report
Sidebar → "Payroll" → card "Monthly Labor Hours & Payroll Report": choose the month (or a range of days inside the month) and export. It shows workers' daily hours, totals and stored payroll values.
Screen: payroll
Keywords: report, monthly, hours, labor, workers report, export

## [Admin] Workers: add, edit, activate, rates
Sidebar → "Workers" (or "HR Management" → "Workers Management").
- Add: the "Add Worker" (+) button. Fill "Full Name", "Hire Date" (set an earlier date if he started before today), job position, payment type (Hourly / Daily) and rates.
- Edit: on the worker row, menu → "Edit". Changing payment, rate or position needs a reason and an effective date.
- Activate / deactivate: row menu → "Set Inactive" / "Set Active", choose the effective date; "Also end site assignments" ends his assignments.
- Assign or transfer to a site: the site icon on the row ("Assign to site" / "Transfer to another site").
- Change rates for many workers: "Bulk Update Compensation" icon at the top: payment type, rates, reason, effective date, all active workers or selected ones, then "Apply Bulk Update".
- Tap a worker to open his "Worker Profile" (details, rate history, ID documents).
Screen: workers
Keywords: worker, add worker, new worker, edit, deactivate, activate, inactive, rate, daily rate, hourly rate, compensation, salary change, profile, hire

## [Admin] Assign workers to sites (Worker Distribution)
Sidebar → "Worker Distribution": sites with their Day Shift / Night Shift workers.
- New assignment: the add button → "Assign Worker to Site": "Select Worker", "Select Site", "Shift Type" (Day/Night), "Assignment Date" (back-date it if he started earlier), then "Save Assignment".
- On a worker: "Transfer Worker" (direct transfer, the old assignment ends the day before), "End Assignment" (choose the LAST assigned day; that day still counts), "Change start date", "Assignment history".
Screen: worker_distribution
Keywords: assign, assignment, distribution, site, shift, end assignment, start date, transfer, history

## [Admin] Approve worker transfer requests
Sidebar → "Transfer Requests". Each request shows From, To, reason, effective date and who asked.
- "Approve": confirm or change the "Transfer effective date"; the worker moves from that date.
- "Reject": write the reason (Admin Notes) → "Confirm Rejection".
- "Word Doc" downloads the transfer document.
Screen: transfer_requests
Keywords: transfer, approve transfer, reject transfer, requests, move worker, document

## [Admin] Projects, contracts and sites
Sidebar → "Projects".
- Add project: + button → "Project Name", "Client Name", "Location".
- Tap a project → its contracts. Add contract: + → "Contract Name", "Hourly Rate", "Overtime Hourly Rate".
- Tap a contract → its sites. Add site: + → "Site Name / Sector", address, tick "Supports Day/Night shifts" for sites with two shifts, optionally "Assign Supervisor".
- On a site: "Shifts" to set "Day Shift Supervisor" and "Night Shift Supervisor" → "Save Shift Supervisors"; "Edit Site"; "Set Active" / "Set Suspended" / "Set Completed".
- Projects and contracts have the same "Edit" and status actions.
Screen: projects
Keywords: project, contract, site, add site, new site, client, hourly rate, shift supervisor, suspend, complete

## [Admin] Supervisor accounts
Sidebar → "Supervisors Management". Tabs: "Worker Supervisors" and "Staff Supervisors".
- Add: the add button → "Full Name", "Username", "Email", "Password".
- Edit: the pencil icon. Activate / deactivate: the block / check icon. A deactivated account is logged out immediately.
- To give a supervisor a site, set him as Day/Night shift supervisor of the site (Projects → contract → site → "Shifts").
Screen: supervisors_management
Keywords: supervisor, account, user, create user, username, deactivate, activate, staff supervisor

## [Admin] Office staff (Staff Management)
Sidebar → "HR Management" → "Staff Management".
- Add: + button → "Full Name", "Hire Date", "Position / Job Title", "Monthly Salary", "Standard Daily Hours".
- Row actions: "Edit" (salary or hours change asks from which date it applies), "Change status", "Lifecycle & Site" (assign / unassign a site, status history), "Assign Supervisor", "Monthly Extra time Ledger", "Delete…" (moves to the Recycle Bin after checks).
- "Bulk Assign Supervisor" at the top assigns one Staff Supervisor to many staff members.
Screen: staff_management
Keywords: staff, employee, add staff, salary, position, status, terminate, delete, supervisor, lifecycle, extra time

## [Admin] Recycle Bin (restore a deleted person)
Sidebar → "HR Management" → "Recycle Bin". People deleted in the last 30 days: "Restore" (reason required) or "Delete now". After 30 days they are removed permanently.
Screen: recycle_bin
Keywords: recycle bin, restore, deleted, undo delete, trash, staff, worker, employee, person, recover

## [Admin] Staff attendance review and staff payroll
Sidebar → "Staff Attendance & Payroll". Two tabs:
- "Attendance": records submitted by the Staff Supervisor. "Approve" / "Reject" (reason required), or tick several and "Approve N" / "Reject N" (N = number selected); "Select all". Sick, vacation and holiday days are not paid automatically: decide in "Paid leave decision". "Approved records" (top) lists approved records by month and lets you correct one ("Complete the day (management decision)" pays missing hours).
- "Payroll": "Generate Staff Payroll": "Monthly (recommended)" or "Custom range", choose the month, press "Generate". Tap a batch in the list: "Export PDF Report", "Export Excel Report", "Finalize", "Mark Paid", "Void", "Correct (supersede)". "Review Absences (Management-Paid Leave)" lets management pay chosen absences. The "Monthly Staff Hours & Payroll Report" card exports a month.
Screen: staff_attendance_payroll
Keywords: staff payroll, staff attendance, approve staff, employees salary, monthly payroll, paid leave, absences

## [Admin] Staff salary advances
Sidebar → "Staff Attendance & Payroll" → "Payroll" tab → switch to "Advances".
- "New advance": choose the staff member, check "Expected salary" and open advances, press "Continue to advance", enter "Advance amount", choose "Full (one month)" or "Partial (several months)" with the amount per month, "Payment method" (Cash / Bank transfer / Cheque), reason → "Create advance & voucher", then "Print voucher".
- Tap an advance to see the "Deduction schedule": "Change months", "Record a repayment" (cash repayment with receipt), "Cancel advance" (only for a short time after creation), "Write off", "Statement".
- The deduction is taken automatically by the staff payroll of the scheduled month. Months with a Paid batch cannot be chosen.
Screen: staff_attendance_payroll
Keywords: advance, loan, salary advance, voucher, repayment, deduction schedule, write off, cancel advance, employee, staff, borrow

## [Admin] Daily Site Report (PDF for the client)
Sidebar → "Daily Site Report".
1. "Date & shift": choose the report date and "Day", "Night" or "Day & Night".
2. "Sites in the report": choose one or more Active sites.
3. "Prepared for & issued by": "Prepared for" is filled from the project client; choose "Issued by" ("Add person" adds a name and job title).
4. "Content": write site notes (issues, delays, what you need from the client). "Copy text from" copies the previous report's notes.
5. Press "Generate PDF report".
"Issued reports" lists earlier reports; "Re-print" gives exactly the report that was issued. Head counts use check-ins recorded so far; names, times and rates are never printed.
Screen: daily_site_report
Keywords: daily report, site report, pdf, client report, print, notes, issued by

## [Admin] Biometric: import files
Sidebar → "Biometric Import".
- "Select file & Import": choose the device export file and confirm "Import".
- "Run pending files (n)": imports files the Connector placed on the server.
- "Import History": tap a batch for rows, duplicates and "Invalid lines"; "Close stale batch" closes an interrupted upload. "Files not imported" shows the reason for each file.
- After import, press "Go to Biometric Processing".
Screen: biometric_import
Keywords: biometric, fingerprint, import, upload, file, device, connector

## [Admin] Biometric: process punches and daily review
Sidebar → "Biometric Processing". Tabs:
- "Processing": "Process Pending Punches" turns imported punches into attendance (oldest first). "Retry All Failed" retries failed punches.
- "Daily Review": choose a date (or "All unresolved (any date)"). For each item only valid actions are shown: "Use as Checkout", "Keep as New IN", "Mark as Duplicate", "Dismiss", "Review Later", "Re-queue punch". "Missing checkouts": "Enter Checkout" with the real time (a check-out is never invented). "Unmapped device IDs": "Map Employee". "Staff lunch" sets lunch for biometric staff.
- "Biometric Attendance": records created from punches; edit times or "Clear this check-out (it is wrong)"; "Download Excel".
Screen: biometric_processing
Keywords: biometric, punches, process, review, missing checkout, duplicate, failed, retry, fingerprint

## [Admin] Biometric: map device IDs to people
Sidebar → "Device ID Mapping": the "Unmapped Device IDs" table shows device employee IDs with punches. Choose the Worker or Staff member in "Select" and press "Map", check the "Effective from" date and confirm. Then retry the related punches in Biometric Processing → "Daily Review".
"Historical (closed) mapping" is for people who are inactive or terminated (an end date is required).
"Existing mappings (End / Void / Impact)" opens the list of mappings: search, "End" (last valid day), "Void" (reason), "Impact" (punches and records that used it, with "Re-queue").
Screen: device_id_mapping
Keywords: device id, mapping, map, biometric, unmapped, fingerprint, link employee
