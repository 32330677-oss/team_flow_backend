// middleware/duplicateGuard.js
//
// Prevents duplicate CREATE requests (double-click, network retry, timeout
// retry, concurrent requests) for entities that have NO natural DB
// uniqueness rule (e.g. two workers can legitimately share a name/phone).
//
// Uses MySQL's GET_LOCK()/RELEASE_LOCK(): a real named lock enforced by the
// MySQL server itself, so it correctly serializes concurrent requests even
// across different app processes/instances sharing the same DB — unlike an
// in-memory Map (per-process only) or a bare SELECT-then-INSERT (races).
//
// Usage: acquire the lock on the SAME connection you'll do your
// SELECT-dup-check + INSERT on, then always release it in a finally block
// BEFORE returning the connection to the pool (GET_LOCK is session-scoped;
// pooled connections are reused, so a forgotten RELEASE_LOCK would wedge
// the lock for the lifetime of that pooled connection).

async function acquireCreateLock(connection, lockKey, timeoutSeconds = 5) {
  const [[row]] = await connection.query(
    "SELECT GET_LOCK(CONCAT('wf_', MD5(?)), ?) AS locked",
    [lockKey, timeoutSeconds]
  );
  return row.locked === 1;
}

async function releaseCreateLock(connection, lockKey) {
  try {
    await connection.query("SELECT RELEASE_LOCK(CONCAT('wf_', MD5(?)))", [lockKey]);
  } catch (_) {
    // best-effort — the lock also auto-releases if the connection is ever closed
  }
}

module.exports = { acquireCreateLock, releaseCreateLock };