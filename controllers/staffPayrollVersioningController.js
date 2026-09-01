// controllers/staffPayrollVersioningController.js
//
// Adds finalization and versioning on top of the existing
// controllers/StaffPayrollController.js. Kept as a separate file so the
// original generation/report/details logic is untouched; wire these two
// new endpoints in alongside the existing ones.
//
// IMPORTANT — one required change to the existing generateStaffPayrollBatch
// overlap check in StaffPayrollController.js: its overlap query currently
// does:
//   SELECT staff_payroll_batch_id FROM staff_payroll_batches
//   WHERE start_date <= ? AND end_date >= ? LIMIT 1 FOR UPDATE
// This must be changed to exclude superseded batches so a corrected/new
// version can be generated for a period whose old batch was superseded:
//   ... WHERE start_date <= ? AND end_date >= ? AND status <> 'Superseded'
//       LIMIT 1 FOR UPDATE
//
// Wire into routes/StaffPayrollRoutes.js:
//   const versioning = require('../controllers/staffPayrollVersioningController');
//   router.patch('/batch/:batchId/finalize', versioning.finalizeBatch);
//   router.post('/batch/:batchId/new-version', versioning.createNewVersion);
//   router.get('/batch/:batchId/versions', versioning.getVersionChain);

const pool = require('../config/db');

// PATCH /api/staff-payroll/batch/:batchId/finalize
// A batch must be finalized before it can be marked Paid. Finalizing freezes
// it: no further "new-version" chains can point to editing it directly —
// corrections after finalization must go through createNewVersion, which
// supersedes it rather than mutating it.
async function finalizeBatch(req, res) {
  const batchId = Number(req.params.batchId);
  const userId = req.user?.user_id;
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ? FOR UPDATE',
      [batchId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Payroll batch not found.' });
    }
    const batch = rows[0];
    if (batch.status === 'Superseded') {
      await connection.rollback();
      return res.status(409).json({ status: 'error', message: 'A superseded batch cannot be finalized.' });
    }
    if (batch.is_finalized) {
      await connection.rollback();
      return res.status(409).json({ status: 'error', message: 'This batch is already finalized.' });
    }

    await connection.execute(
      `UPDATE staff_payroll_batches
       SET is_finalized = 1, finalized_by_user_id = ?, finalized_at = NOW()
       WHERE staff_payroll_batch_id = ?`,
      [userId, batchId]
    );

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_payroll_batches', ?, 'FINALIZED', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ is_finalized: false }), JSON.stringify({ is_finalized: true })]
    );

    await connection.commit();
    return res.json({ status: 'success', message: 'Payroll batch finalized. It can now be marked as paid.' });
  } catch (error) {
    await connection.rollback();
    console.error('finalizeBatch:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to finalize payroll batch.' });
  } finally {
    connection.release();
  }
}

// POST /api/staff-payroll/batch/:batchId/new-version
// Marks the given batch as Superseded and returns the parameters the client
// should call /generate with, for the SAME period, so the normal generation
// path (with all its validation) produces the replacement. This endpoint
// does NOT itself recompute salaries — it only performs the supersession,
// keeping the money-calculation logic in exactly one place
// (generateStaffPayrollBatch).
async function createNewVersion(req, res) {
  const batchId = Number(req.params.batchId);
  const { reason } = req.body || {};
  const userId = req.user?.user_id;

  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ status: 'error', message: 'A reason is required to supersede a payroll batch.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ? FOR UPDATE',
      [batchId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ status: 'error', message: 'Payroll batch not found.' });
    }
    const batch = rows[0];
    if (batch.status === 'Superseded') {
      await connection.rollback();
      return res.status(409).json({ status: 'error', message: 'This batch has already been superseded.' });
    }

    // A Paid batch can still be corrected (money already sent doesn't vanish
    // from history), but the correction is always a NEW batch, never an edit.
    await connection.execute(
      `UPDATE staff_payroll_batches SET status = 'Superseded' WHERE staff_payroll_batch_id = ?`,
      [batchId]
    );

    await connection.execute(
      `INSERT INTO auditlogs (table_name, record_id, action_type, user_id, old_values, new_values)
       VALUES ('staff_payroll_batches', ?, 'SUPERSEDED', ?, ?, ?)`,
      [batchId, userId, JSON.stringify({ status: batch.status }), JSON.stringify({ status: 'Superseded', reason })]
    );

    await connection.commit();
    return res.json({
      status: 'success',
      message: 'Batch marked as superseded. Generate a new batch for the same period to create version ' + (batch.version_number + 1) + '.',
      next_version_params: {
        start_date: batch.start_date,
        end_date: batch.end_date,
        version_number: batch.version_number + 1,
        supersedes_batch_id: batchId,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error('createNewVersion:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to supersede payroll batch.' });
  } finally {
    connection.release();
  }
}

// GET /api/staff-payroll/batch/:batchId/versions
// Walks both directions of the supersedes_batch_id chain so the UI can show
// "Version 1 (superseded) -> Version 2 (superseded) -> Version 3 (current)".
async function getVersionChain(req, res) {
  const batchId = Number(req.params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid batch id.' });
  }
  try {
    const [anchorRows] = await pool.execute(
      'SELECT * FROM staff_payroll_batches WHERE staff_payroll_batch_id = ?',
      [batchId]
    );
    if (!anchorRows.length) {
      return res.status(404).json({ status: 'error', message: 'Payroll batch not found.' });
    }

    const [allForPeriod] = await pool.execute(
      `SELECT spb.*, u.full_name AS generated_by
       FROM staff_payroll_batches spb
       JOIN users u ON u.user_id = spb.generated_by_user_id
       WHERE spb.start_date = ? AND spb.end_date = ?
       ORDER BY spb.version_number ASC`,
      [anchorRows[0].start_date, anchorRows[0].end_date]
    );

    return res.json({ status: 'success', data: allForPeriod });
  } catch (error) {
    console.error('getVersionChain:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to load version history.' });
  }
}

module.exports = { finalizeBatch, createNewVersion, getVersionChain };