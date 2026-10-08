// services/payrollLock.js
//
// D-02: once a payroll period is Finalized (or Paid), normal attendance
// operations for dates inside that period are locked, for workers and staff
// separately. Only the explicit Admin correction workflow
// (attendanceCorrectionController) may change such records, and it never
// changes the finalized payroll itself.
//
// "Locked" = an active (not Superseded / not Voided) batch with
// is_finalized = 1 that covers the date, and:
//   * Regular worker batch: the site, when the batch is scoped to one site;
//   * OffCycle worker batch (urgent payroll of ONE worker): only that worker.
//     A finalized off-cycle batch never locks the other workers of the site,
//     so their attendance can still be entered, submitted and approved.
//
// Callers that check a whole site/day (no worker given) only see Regular
// batches; every per-worker path passes workerId so off-cycle locks apply.

class PayrollLockedError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.isOperational = true;
    this.statusCode = 409;
    this.code = 'PAYROLL_PERIOD_FINALIZED';
    this.extra = extra;
  }
}

function toWorkerId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function findLockedWorkerBatch(executor, { siteId, date, workerId = null }) {
  const wid = toWorkerId(workerId);
  const [rows] = await executor.execute(
    `SELECT pb.payroll_batch_id, pb.start_date, pb.end_date, pb.scope_site_id, pb.status, pb.is_finalized,
            pb.batch_type, pb.scope_worker_id, w.full_name AS scope_worker_name
     FROM payrollbatches pb
     LEFT JOIN workers w ON w.worker_id = pb.scope_worker_id
     WHERE pb.status IN ('Generated', 'Paid') AND pb.is_finalized = 1
       AND pb.start_date <= ? AND pb.end_date >= ?
       AND (
         (pb.batch_type = 'Regular' AND (pb.scope_site_id IS NULL OR pb.scope_site_id = ?))
         OR (pb.batch_type = 'OffCycle' AND pb.scope_worker_id = ?)
       )
     ORDER BY (pb.batch_type = 'Regular') DESC, pb.payroll_batch_id DESC LIMIT 1`,
    [date, date, siteId ?? null, wid]
  );
  return rows[0] || null;
}

async function findLockedStaffBatch(executor, { date }) {
  const [rows] = await executor.execute(
    `SELECT staff_payroll_batch_id, start_date, end_date, status, is_finalized
     FROM staff_payroll_batches
     WHERE status IN ('Generated', 'Paid') AND is_finalized = 1
       AND start_date <= ? AND end_date >= ?
     ORDER BY staff_payroll_batch_id DESC LIMIT 1`,
    [date, date]
  );
  return rows[0] || null;
}

/**
 * Worker ids (of `workerIds`) whose own off-cycle payroll covers `date` and is
 * finalized/paid. Their attendance on that date can no longer be recorded, so
 * "missing attendance" checks must not wait for them.
 */
async function offCycleLockedWorkerIds(executor, workerIds, date) {
  const ids = [...new Set((workerIds || []).map(toWorkerId).filter(Boolean))];
  if (!ids.length) return new Set();
  const [rows] = await executor.query(
    `SELECT DISTINCT scope_worker_id
     FROM payrollbatches
     WHERE batch_type = 'OffCycle' AND status IN ('Generated', 'Paid') AND is_finalized = 1
       AND start_date <= ? AND end_date >= ? AND scope_worker_id IN (?)`,
    [date, date, ids]
  );
  return new Set(rows.map((r) => Number(r.scope_worker_id)));
}

function lockMessage(kind, batch, date) {
  const id = kind === 'Worker' ? batch.payroll_batch_id : batch.staff_payroll_batch_id;
  const period = `(${String(batch.start_date).slice(0, 10)} to ${String(batch.end_date).slice(0, 10)})`;
  const state = batch.status === 'Paid' ? 'Paid' : 'Finalized';
  if (kind === 'Worker' && batch.batch_type === 'OffCycle') {
    const who = batch.scope_worker_name ? `${batch.scope_worker_name} (worker #${batch.scope_worker_id})` : `worker #${batch.scope_worker_id}`;
    return `${who} was already paid for ${date} by off-cycle payroll batch #${id} ${period}, which is ${state}. ` +
      'This worker\'s attendance is locked for that period (other workers are not affected). ' +
      'An Admin can use "Correct finalized attendance" (reason required); the finalized payroll is not changed.';
  }
  return `${date} is inside ${kind === 'Worker' ? 'worker' : 'staff'} payroll batch #${id} ${period}, which is ` +
    `${state}. Normal attendance changes are locked for this period. ` +
    'An Admin can use "Correct finalized attendance" (reason required); the finalized payroll is not changed.';
}

async function assertWorkerDateEditable(executor, siteId, date, workerId = null) {
  const d = String(date).slice(0, 10);
  const batch = await findLockedWorkerBatch(executor, { siteId, date: d, workerId });
  if (batch) {
    throw new PayrollLockedError(lockMessage('Worker', batch, d), {
      payroll_batch_id: batch.payroll_batch_id,
      batch_type: batch.batch_type,
      ...(batch.batch_type === 'OffCycle' ? { worker_id: batch.scope_worker_id } : {}),
    });
  }
}

async function assertStaffDateEditable(executor, date) {
  const d = String(date).slice(0, 10);
  const batch = await findLockedStaffBatch(executor, { date: d });
  if (batch) {
    throw new PayrollLockedError(lockMessage('Staff', batch, d), { staff_payroll_batch_id: batch.staff_payroll_batch_id });
  }
}

/** Express helper: turn a PayrollLockedError into the standard JSON reply. */
function sendLocked(res, error) {
  return res.status(409).json({ status: 'error', code: error.code, message: error.message, ...(error.extra || {}) });
}

/**
 * Startup interlock: this backend needs migrations/2026_10_offcycle_payroll.
 * Without its columns every attendance lock check would fail, so refuse to
 * start instead (same pattern as assertSemanticsMarker).
 */
async function assertOffCycleSchema(db) {
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'payrollbatches'
       AND column_name IN ('batch_type', 'scope_worker_id', 'offcycle_reason')`
  );
  if (Number(rows[0] && rows[0].n) !== 3) {
    const error = new Error(
      'payrollbatches is missing the off-cycle payroll columns (batch_type, scope_worker_id, offcycle_reason). ' +
      'Run migrations/2026_10_offcycle_payroll (steps 01-04) before starting this version.'
    );
    error.code = 'OFFCYCLE_SCHEMA_MISSING';
    throw error;
  }
  return true;
}

module.exports = {
  PayrollLockedError,
  findLockedWorkerBatch,
  findLockedStaffBatch,
  offCycleLockedWorkerIds,
  assertWorkerDateEditable,
  assertStaffDateEditable,
  assertOffCycleSchema,
  sendLocked,
};
