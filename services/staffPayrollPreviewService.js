// services/staffPayrollPreviewService.js
//
// PRELIMINARY (unofficial) staff attendance & expected-payroll report.
//
// READ-ONLY: this service never writes to the database, never creates a batch
// and never changes any record. It answers one question:
//   "If every SUBMITTED day were approved as it is now, what would staff
//    payroll for this period look like?"
//
// The salary math is a line-by-line mirror of
// StaffPayrollController.generateStaffPayrollBatch. The only intentional
// difference is the attendance status filter:
//     payroll  : status = 'Approved'
//     preview  : status IN ('Submitted', 'Approved')
// Draft / Rejected days are NOT counted (exactly like payroll today: a day
// without a counted record is an unpaid absence) and are listed so the Admin
// can see them.
//
// If the payroll formula in StaffPayrollController changes, this file must be
// updated with it (search for "MIRROR" below).

const pool = require('../config/db');
const { countNonFridayDays, listNonFridayDates, isFriday, round2 } = require('./staffAttendanceService');
const { getActiveSpansOverlapping } = require('./staffEmploymentService');
const { buildStaffCompensationTimeline } = require('./staffCompensationService');
const { businessToday } = require('./businessDate');
const settingsCache = require('./settingsCache');

const COUNTED_STATUSES = ['Submitted', 'Approved'];
const MAX_RANGE_DAYS = 40;
const LEAVE_CODE = { Absent: 'A', Sick: 'S', Vacation: 'V', Holiday: 'H' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

// Same default as StaffPayrollController.getPaidLeaveTypes.
function getPaidLeaveTypes(staff) {
  const defaults = ['Sick', 'Vacation', 'Holiday'];
  if (!staff.paid_leave_types) return defaults;
  try {
    const parsed = typeof staff.paid_leave_types === 'string' ? JSON.parse(staff.paid_leave_types) : staff.paid_leave_types;
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaults;
  } catch (_) {
    return defaults;
  }
}

function listDates(start, end) {
  const out = [];
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * MIRROR of the per-staff body of generateStaffPayrollBatch.
 * Returns null when payroll would skip the staff member, otherwise the
 * figures payroll would store (plus `unresolved` when payroll would refuse).
 */
async function calculateStaff(staff, startDate, endDate, batchNonFridayDays, executor) {
  const resolveComp = await buildStaffCompensationTimeline(staff.staff_id, executor);

  const employmentSpans = await getActiveSpansOverlapping(staff.staff_id, startDate, endDate, executor);
  if (employmentSpans.length === 0) return { skipped: 'not_employed' };

  const effectiveStart = employmentSpans[0].start;
  const effectiveEnd = employmentSpans[employmentSpans.length - 1].end;

  const calendarDates = employmentSpans.flatMap((span) => listNonFridayDates(span.start, span.end)).sort();
  const calendarDateSet = new Set(calendarDates);
  const requiredDays = calendarDates.length;
  if (requiredDays <= 0) return { skipped: 'no_working_days', employmentSpans };

  const [records] = await executor.query(
    `SELECT staff_attendance_id, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date, attendance_status, is_paid,
            is_management_paid_absence, regular_hours, overtime_hours, is_friday_worked,
            standard_minutes_snapshot
     FROM staff_attendance
     WHERE staff_id = ? AND record_date BETWEEN ? AND ? AND status IN (?)`,
    [staff.staff_id, effectiveStart, effectiveEnd, COUNTED_STATUSES]
  );

  const relevantRecords = records.filter((r) => calendarDateSet.has(String(r.record_date).slice(0, 10)));
  if (relevantRecords.length === 0) return { skipped: 'no_counted_records', employmentSpans };

  const recordsByDate = new Map();
  for (const record of records) recordsByDate.set(String(record.record_date).slice(0, 10), record);

  const standardHoursByDate = new Map();
  const periodCompByDate = new Map();
  const staffUnresolved = [];
  for (const dateStr of calendarDates) {
    const record = recordsByDate.get(dateStr);
    const snapshotMinutes = Number(record?.standard_minutes_snapshot);
    const daily = resolveComp(dateStr, { hoursSnapshot: snapshotMinutes > 0 ? snapshotMinutes / 60 : null });
    const period = resolveComp(dateStr);
    for (const u of [...daily.unresolved, ...period.unresolved]) {
      if (!staffUnresolved.some((x) => x.date === dateStr && x.field === u.field)) staffUnresolved.push({ date: dateStr, ...u });
    }
    if (record && !['Present', 'Absent'].includes(record.attendance_status) && !daily.paid_leave_types) {
      staffUnresolved.push({ date: dateStr, field: 'paid_leave_types',
        reason: 'compensation history exists for this staff member but does not cover this date' });
    }
    standardHoursByDate.set(dateStr, daily.standard_daily_hours);
    periodCompByDate.set(dateStr, { ...period, paid_leave_types: daily.paid_leave_types });
  }
  if (staffUnresolved.length > 0) return { unresolved: staffUnresolved, employmentSpans };

  const paidLeaveTypesFor = (dateStr) => periodCompByDate.get(dateStr)?.paid_leave_types || getPaidLeaveTypes(staff);

  const segments = [];
  for (const dateStr of calendarDates) {
    const c = periodCompByDate.get(dateStr);
    const last = segments[segments.length - 1];
    if (last && last.monthly_salary === c.monthly_salary && last.standard_daily_hours === c.standard_daily_hours) {
      last.dates.push(dateStr);
    } else {
      segments.push({ monthly_salary: c.monthly_salary, standard_daily_hours: c.standard_daily_hours, dates: [dateStr] });
    }
  }
  const standardDailyHours = segments[segments.length - 1].standard_daily_hours;
  const monthlySalary = segments[segments.length - 1].monthly_salary;

  const requiredHours = round2(calendarDates.reduce((sum, d) => sum + standardHoursByDate.get(d), 0));
  if (requiredHours <= 0) return { skipped: 'no_required_hours', employmentSpans };

  let actualRegularRaw = 0;
  let workedDayShortfall = 0;
  let absenceShortfall = 0;
  let dailyOtEarned = 0;
  let presentDaysCount = 0;
  let paidLeaveDays = 0;
  let managementPaidDays = 0;
  let unpaidAbsenceDays = 0;
  const workedShortfallByDate = new Map();
  const absenceShortfallByDate = new Map();
  const addTo = (map, key, v) => map.set(key, (map.get(key) || 0) + v);
  const dayOutcome = new Map(); // date -> 'present' | 'paid_leave' | 'mgmt_paid' | 'unpaid'

  // MIRROR: confirmed Fridays inside an employment span count entirely as OT.
  const isDateInEmployment = (ds) => employmentSpans.some((span) => ds >= span.start && ds <= span.end);
  for (const record of records) {
    const ds = String(record.record_date).slice(0, 10);
    if (isFriday(ds) && isDateInEmployment(ds)
        && record.attendance_status === 'Present' && Number(record.is_friday_worked) === 1) {
      dailyOtEarned += Number(record.regular_hours || 0) + Number(record.overtime_hours || 0);
      presentDaysCount += 1;
    }
  }

  for (const dateStr of calendarDates) {
    const record = recordsByDate.get(dateStr);
    const dailyStandardHours = standardHoursByDate.get(dateStr) || standardDailyHours;

    if (!record) {
      absenceShortfall += dailyStandardHours;
      addTo(absenceShortfallByDate, dateStr, dailyStandardHours);
      unpaidAbsenceDays += 1;
      dayOutcome.set(dateStr, 'unpaid');
      continue;
    }
    if (record.attendance_status === 'Present') {
      const regHours = Number(record.regular_hours || 0);
      workedDayShortfall += Math.max(0, dailyStandardHours - regHours);
      addTo(workedShortfallByDate, dateStr, Math.max(0, dailyStandardHours - regHours));
      actualRegularRaw += regHours;
      dailyOtEarned += Number(record.overtime_hours || 0);
      presentDaysCount += 1;
      dayOutcome.set(dateStr, 'present');
    } else if (record.attendance_status === 'Absent') {
      if (Number(record.is_management_paid_absence) === 1) {
        actualRegularRaw += dailyStandardHours;
        managementPaidDays += 1;
        dayOutcome.set(dateStr, 'mgmt_paid');
      } else {
        absenceShortfall += dailyStandardHours;
        addTo(absenceShortfallByDate, dateStr, dailyStandardHours);
        unpaidAbsenceDays += 1;
        dayOutcome.set(dateStr, 'unpaid');
      }
    } else if (paidLeaveTypesFor(dateStr).includes(record.attendance_status) && Number(record.is_paid) === 1) {
      actualRegularRaw += dailyStandardHours;
      paidLeaveDays += 1;
      dayOutcome.set(dateStr, 'paid_leave');
    } else {
      absenceShortfall += dailyStandardHours;
      addTo(absenceShortfallByDate, dateStr, dailyStandardHours);
      unpaidAbsenceDays += 1;
      dayOutcome.set(dateStr, 'unpaid');
    }
  }

  const actualRegularHours = round2(Math.min(actualRegularRaw, requiredHours));
  const otEarnedHours = round2(dailyOtEarned);
  const otUsedHours = round2(Math.min(otEarnedHours, workedDayShortfall));
  const uncoveredWorked = round2(Math.max(0, workedDayShortfall - otUsedHours));
  const shortageHours = round2(workedDayShortfall + absenceShortfall);
  const uncoveredShortageHours = round2(uncoveredWorked + absenceShortfall);

  let proratedBaseSalary;
  let hourlyRateRaw;
  let salaryDeduction;
  if (segments.length === 1) {
    const periodRequiredHours = round2(batchNonFridayDays * standardDailyHours);
    const ratio = periodRequiredHours > 0 ? Math.min(1, Math.max(0, requiredHours / periodRequiredHours)) : 0;
    proratedBaseSalary = money(Number(monthlySalary) * ratio);
    hourlyRateRaw = requiredHours > 0 ? proratedBaseSalary / requiredHours : 0;
    salaryDeduction = money(uncoveredShortageHours * hourlyRateRaw);
  } else {
    let baseSum = 0;
    const rateByDate = new Map();
    segments.forEach((seg) => {
      const segRequired = seg.dates.reduce((sum, dt) => sum + standardHoursByDate.get(dt), 0);
      const segPeriodHours = batchNonFridayDays * seg.standard_daily_hours;
      const ratio = segPeriodHours > 0 ? Math.min(1, Math.max(0, segRequired / segPeriodHours)) : 0;
      const segBase = Number(seg.monthly_salary) * ratio;
      const segRate = segRequired > 0 ? segBase / segRequired : 0;
      seg.dates.forEach((dt) => rateByDate.set(dt, segRate));
      baseSum += segBase;
    });
    proratedBaseSalary = money(baseSum);
    hourlyRateRaw = requiredHours > 0 ? proratedBaseSalary / requiredHours : 0;
    let absenceAmount = 0;
    for (const [dt, h] of absenceShortfallByDate) absenceAmount += h * (rateByDate.get(dt) || 0);
    let workedAmount = 0;
    for (const [dt, h] of workedShortfallByDate) workedAmount += h * (rateByDate.get(dt) || 0);
    const uncoveredShare = workedDayShortfall > 0 ? uncoveredWorked / workedDayShortfall : 0;
    salaryDeduction = money(absenceAmount + workedAmount * uncoveredShare);
  }
  const netSalary = money(proratedBaseSalary - salaryDeduction);

  return {
    employmentSpans,
    calendarDateSet,
    dayOutcome,
    calc: {
      monthly_salary: Number(monthlySalary),
      segments: segments.length,
      required_days: requiredDays,
      required_hours: requiredHours,
      actual_regular_hours: actualRegularHours,
      present_days: presentDaysCount,
      paid_leave_days: paidLeaveDays,
      management_paid_days: managementPaidDays,
      unpaid_absence_days: unpaidAbsenceDays,
      ot_earned_hours: otEarnedHours,
      ot_used_hours: otUsedHours,
      shortage_hours: shortageHours,
      uncovered_shortage_hours: uncoveredShortageHours,
      hourly_rate: money(hourlyRateRaw),
      prorated_base_salary: proratedBaseSalary,
      salary_deduction: salaryDeduction,
      net_salary: netSalary,
    },
  };
}

/**
 * Builds the whole preliminary report (data only, no rendering).
 */
async function buildStaffPreliminaryReport(startDate, endDate) {
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    throw badRequest('start_date and end_date are required in YYYY-MM-DD format.');
  }
  if (endDate < startDate) throw badRequest('end_date must be on or after start_date.');
  const allDates = listDates(startDate, endDate);
  if (allDates.length > MAX_RANGE_DAYS) throw badRequest(`The period cannot be longer than ${MAX_RANGE_DAYS} days.`);

  const batchNonFridayDays = countNonFridayDays(startDate, endDate);
  if (batchNonFridayDays <= 0) throw badRequest('The selected period contains no working days.');

  const today = businessToday();
  const currency = String(await settingsCache.getSetting('staff_payroll_currency', 'USD') || 'USD').toUpperCase();

  // Same staff selection as payroll.
  const [staffList] = await pool.execute(
    `SELECT sm.staff_id, sm.staff_unique_id, sm.full_name, sm.position, sm.monthly_salary,
            sm.paid_leave_types, sm.standard_daily_hours, s.site_name
     FROM staff_members sm
     LEFT JOIN sites s ON s.site_id = sm.site_id
     WHERE COALESCE(sm.first_hire_date, sm.hire_date) IS NOT NULL
       AND COALESCE(sm.first_hire_date, sm.hire_date) <= ?
     ORDER BY sm.full_name`,
    [endDate]
  );

  // Every attendance row of the period, any status (for the day grid).
  const [allRecords] = await pool.execute(
    `SELECT staff_id, DATE_FORMAT(record_date, '%Y-%m-%d') AS record_date, attendance_status, status,
            regular_hours, overtime_hours, is_friday_worked, is_management_paid_absence, is_paid,
            DATE_FORMAT(check_in_time, '%H:%i') AS check_in, DATE_FORMAT(check_out_time, '%H:%i') AS check_out,
            source
     FROM staff_attendance
     WHERE record_date BETWEEN ? AND ?`,
    [startDate, endDate]
  );
  const recordsByStaff = new Map();
  for (const r of allRecords) {
    if (!recordsByStaff.has(r.staff_id)) recordsByStaff.set(r.staff_id, new Map());
    recordsByStaff.get(r.staff_id).set(r.record_date, r);
  }

  const [overlapBatches] = await pool.execute(
    `SELECT staff_payroll_batch_id, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, status, is_finalized
     FROM staff_payroll_batches
     WHERE start_date <= ? AND end_date >= ? AND status IN ('Generated', 'Paid')`,
    [endDate, startDate]
  );

  const rows = [];
  const attention = []; // { uid, name, date, kind, detail }
  const counts = { approved: 0, submitted: 0, draft: 0, rejected: 0 };

  for (const staff of staffList) {
    const recs = recordsByStaff.get(staff.staff_id) || new Map();
    const result = await calculateStaff(staff, startDate, endDate, batchNonFridayDays, pool);
    if (result.skipped === 'not_employed') continue;
    if (result.skipped && recs.size === 0) continue;

    const uid = staff.staff_unique_id || `#${staff.staff_id}`;
    const name = staff.full_name || `Staff #${staff.staff_id}`;
    const spans = result.employmentSpans || [];
    const employed = (d) => spans.some((s) => d >= s.start && d <= s.end);
    const st = { approved: 0, submitted: 0, draft: 0, rejected: 0 };
    const days = {};
    let normal = 0;
    let ot = 0;
    let fridayHours = 0;

    for (const d of allDates) {
      const dayNum = d;
      const rec = recs.get(d);
      if (rec) {
        const key = rec.status.toLowerCase();
        if (st[key] !== undefined) st[key] += 1;
      }
      if (d > today) { days[dayNum] = { kind: 'future' }; continue; }
      if (!employed(d)) { days[dayNum] = { kind: 'na' }; continue; }

      const fri = isFriday(d);
      if (!rec) {
        days[dayNum] = fri ? { kind: 'empty' } : { kind: 'missing', value: '—' };
        continue;
      }
      const counted = COUNTED_STATUSES.includes(rec.status);
      const pending = rec.status === 'Submitted';
      if (!counted) {
        // Draft / Rejected: not counted -> payroll treats the day as an unpaid absence.
        days[dayNum] = { kind: rec.status === 'Draft' ? 'draft' : 'rejected', value: rec.status === 'Draft' ? 'D' : 'R' };
        if (!fri) {
          attention.push({ uid, name, date: d, kind: rec.status,
            detail: `${rec.attendance_status} — not counted; payroll treats the day as an UNPAID ABSENCE until it is submitted and approved` });
        }
        continue;
      }
      if (rec.attendance_status === 'Present') {
        const reg = Number(rec.regular_hours || 0);
        const o = Number(rec.overtime_hours || 0);
        if (fri) {
          if (Number(rec.is_friday_worked) === 1) {
            fridayHours += reg + o;
            days[dayNum] = { kind: 'hours', value: round2(reg + o), ot: true, pending };
          } else {
            days[dayNum] = { kind: 'friq', value: 'F?', pending };
            attention.push({ uid, name, date: d, kind: 'Friday', detail: 'Present on Friday without Friday confirmation — not counted' });
          }
        } else {
          normal += reg;
          ot += o;
          days[dayNum] = { kind: 'hours', value: round2(reg + o), ot: o > 0, pending };
        }
      } else {
        let code = LEAVE_CODE[rec.attendance_status] || '?';
        if (rec.attendance_status === 'Absent' && Number(rec.is_management_paid_absence) === 1) code = 'A*';
        const out = result.dayOutcome && result.dayOutcome.get(d);
        days[dayNum] = { kind: 'code', value: code, pending, unpaidLeave: code !== 'A' && out === 'unpaid' };
      }
    }

    Object.keys(counts).forEach((k) => { counts[k] += st[k]; });

    const flags = [];
    if (result.unresolved) {
      flags.push('Historical salary / standard hours cannot be reconstructed for some dates — expected salary not calculated (payroll would refuse to generate)');
      result.unresolved.slice(0, 3).forEach((u) => attention.push({ uid, name, date: u.date, kind: 'Salary data', detail: `${u.field}: ${u.reason}` }));
    }
    if (result.skipped === 'no_counted_records') {
      flags.push('No Submitted/Approved day in the period — payroll would skip this employee');
    }

    rows.push({
      staff_id: staff.staff_id, uid, name, position: staff.position || '', site: staff.site_name || '',
      days, normal: round2(normal), ot: round2(ot), fridayHours: round2(fridayHours), status: st,
      calc: result.calc || null, flags,
    });
    flags.forEach((f) => attention.push({ uid, name, date: '', kind: 'Payroll', detail: f }));
  }

  attention.sort((a, b) => a.name.localeCompare(b.name) || String(a.date).localeCompare(String(b.date)));

  const totals = rows.reduce((t, r) => {
    t.normal += r.normal; t.ot += r.ot;
    if (r.calc) {
      t.base += r.calc.prorated_base_salary; t.deduction += r.calc.salary_deduction; t.net += r.calc.net_salary;
      t.present += r.calc.present_days; t.unpaid += r.calc.unpaid_absence_days;
      t.paidLeave += r.calc.paid_leave_days; t.mgmt += r.calc.management_paid_days;
    }
    return t;
  }, { normal: 0, ot: 0, base: 0, deduction: 0, net: 0, present: 0, unpaid: 0, paidLeave: 0, mgmt: 0 });

  return {
    startDate, endDate, today, currency,
    days: allDates.map((d) => {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      return { date: d, d: Number(d.slice(8, 10)), m: Number(d.slice(5, 7)), dow: DOW[dow], isFriday: dow === 5 };
    }),
    rows,
    attention,
    counts,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round2(v)])),
    overlapBatches,
    extendsPastToday: endDate > today,
  };
}

module.exports = { buildStaffPreliminaryReport, calculateStaff, COUNTED_STATUSES };