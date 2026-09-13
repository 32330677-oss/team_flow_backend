// services/staffAttendanceService.js
// خاص بـ Staff فقط — منفصل تمامًا عن services/attendanceService.js (العمال)

function isFriday(dateOnlyStr) {
  const d = new Date(`${dateOnlyStr}T00:00:00Z`);
  return d.getUTCDay() === 5;
}

// خصم ساعة غداء واحدة إذا الفترة تقاطعت مع نافذة نهارية (12-13) أو ليلية (23-00)
function computeLunchDeductionHours(checkInDate, checkOutDate) {
  const HOUR_MS = 60 * 60 * 1000, DAY_MS = 24 * HOUR_MS;
  const midnight = new Date(Date.UTC(checkInDate.getUTCFullYear(), checkInDate.getUTCMonth(), checkInDate.getUTCDate()));
  const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

  const dayStart = new Date(midnight.getTime() + 12 * HOUR_MS);
  const dayEnd   = new Date(midnight.getTime() + 13 * HOUR_MS);
  const nightStart = new Date(midnight.getTime() + 23 * HOUR_MS);
  const nightEnd    = new Date(midnight.getTime() + DAY_MS);

  if (overlaps(checkInDate, checkOutDate, dayStart, dayEnd)) return 1;
  if (overlaps(checkInDate, checkOutDate, nightStart, nightEnd)) return 1;
  return 0;
}

function calculateStaffShiftHours(checkInDate, checkOutDate) {
  if (!(checkOutDate > checkInDate)) throw new Error('Check-out time must be after check-in time.');
  const grossHours = (checkOutDate - checkInDate) / 3600000;
  const lunchHours = computeLunchDeductionHours(checkInDate, checkOutDate);
  return { grossHours, lunchHours, netHours: Math.max(0, grossHours - lunchHours) };
}

module.exports = { isFriday, computeLunchDeductionHours, calculateStaffShiftHours };