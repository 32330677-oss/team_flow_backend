// services/payrollVersionService.js
//
// Version history of one worker payroll "period identity" (same start/end
// date, same site scope, same batch type / off-cycle worker). Each version is
// its own payrollbatches row (v1, v2, ...); regenerating a Generated batch
// supersedes the previous one. This service only READS: it lists the versions
// and computes, for every version, what changed compared with the version
// just before it (workers added / removed / with a different net, totals).
// The optional note typed by the Admin is payrollbatches.supersede_reason.

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const dateOnly = (v) => (v ? String(v).slice(0, 10) : null);

async function loadNetsByWorker(executor, batchIds) {
  const map = new Map(batchIds.map((id) => [Number(id), new Map()]));
  if (!batchIds.length) return map;
  const [rows] = await executor.query(
    `SELECT p.payroll_batch_id, p.worker_id, w.full_name, w.worker_unique_id, SUM(p.net_salary) AS net
     FROM payroll p JOIN workers w ON w.worker_id = p.worker_id
     WHERE p.payroll_batch_id IN (?)
     GROUP BY p.payroll_batch_id, p.worker_id, w.full_name, w.worker_unique_id`,
    [batchIds]
  );
  for (const r of rows) {
    map.get(Number(r.payroll_batch_id))?.set(Number(r.worker_id), {
      worker_id: Number(r.worker_id), name: r.full_name, code: r.worker_unique_id, net: round2(r.net),
    });
  }
  return map;
}

function diffVersions(prevNets, curNets) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, cur] of curNets) {
    const prev = prevNets.get(id);
    if (!prev) added.push({ worker_id: id, name: cur.name, code: cur.code, net: cur.net });
    else if (Math.abs(prev.net - cur.net) > 0.004) {
      changed.push({ worker_id: id, name: cur.name, code: cur.code, before: prev.net, after: cur.net, diff: round2(cur.net - prev.net) });
    }
  }
  for (const [id, prev] of prevNets) {
    if (!curNets.has(id)) removed.push({ worker_id: id, name: prev.name, code: prev.code, net: prev.net });
  }
  const sum = (m) => round2([...m.values()].reduce((t, x) => t + x.net, 0));
  const before = sum(prevNets);
  const after = sum(curNets);
  changed.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return {
    workers_before: prevNets.size,
    workers_after: curNets.size,
    total_before: before,
    total_after: after,
    total_diff: round2(after - before),
    added,
    removed,
    changed,
  };
}

/**
 * All versions of the period identity of `batchId`, oldest first, each with
 * `changes` (null for the first version) and `replaced_by` (next version id).
 */
async function getVersionHistory(executor, batchId) {
  const [[anchor]] = await executor.execute('SELECT * FROM payrollbatches WHERE payroll_batch_id = ?', [batchId]);
  if (!anchor) return null;
  const [all] = await executor.execute(
    `SELECT pb.*, u.full_name AS generated_by, fu.full_name AS finalized_by
     FROM payrollbatches pb
     JOIN users u ON u.user_id = pb.generated_by_user_id
     LEFT JOIN users fu ON fu.user_id = pb.finalized_by_user_id
     WHERE pb.start_date = ? AND pb.end_date = ? AND pb.scope_site_id <=> ?
       AND pb.batch_type = ? AND pb.scope_worker_id <=> ?
     ORDER BY pb.version_number ASC, pb.payroll_batch_id ASC`,
    [anchor.start_date, anchor.end_date, anchor.scope_site_id, anchor.batch_type, anchor.scope_worker_id]
  );
  const nets = await loadNetsByWorker(executor, all.map((b) => Number(b.payroll_batch_id)));
  return all.map((b, i) => {
    const prev = i > 0 ? all[i - 1] : null;
    const next = i < all.length - 1 ? all[i + 1] : null;
    return {
      ...b,
      note: b.supersede_reason || null,
      generated_at: b.generated_at,
      start_date: dateOnly(b.start_date),
      end_date: dateOnly(b.end_date),
      replaced_by: next ? { payroll_batch_id: next.payroll_batch_id, version_number: next.version_number } : null,
      previous: prev ? { payroll_batch_id: prev.payroll_batch_id, version_number: prev.version_number, status: prev.status } : null,
      changes: prev
        ? diffVersions(nets.get(Number(prev.payroll_batch_id)), nets.get(Number(b.payroll_batch_id)))
        : null,
    };
  });
}

/** One short line, e.g. "Workers 41 -> 42 (+1: AHMAD X) | 3 changed | Total 18,200.00 -> 18,450.00 (+250.00)". */
function summarizeChanges(c, fmtMoney = (v) => round2(v).toFixed(2), maxNames = 5) {
  if (!c) return '';
  const names = (list) => list.slice(0, maxNames).map((x) => x.name).join(', ') + (list.length > maxNames ? `, +${list.length - maxNames} more` : '');
  const parts = [];
  let workers = `Workers ${c.workers_before} -> ${c.workers_after}`;
  const extra = [];
  if (c.added.length) extra.push(`+${c.added.length}: ${names(c.added)}`);
  if (c.removed.length) extra.push(`-${c.removed.length}: ${names(c.removed)}`);
  if (extra.length) workers += ` (${extra.join('; ')})`;
  parts.push(workers);
  if (c.changed.length) parts.push(`${c.changed.length} with a different net`);
  const sign = c.total_diff > 0 ? '+' : '';
  parts.push(`Total ${fmtMoney(c.total_before)} -> ${fmtMoney(c.total_after)} (${sign}${fmtMoney(c.total_diff)})`);
  return parts.join(' | ');
}

/**
 * Lines for the optional "VERSION NOTES" section of a printed batch.
 * Only the versions the Admin ticked when exporting (`selectedIds`, batch ids)
 * are printed, oldest first (v1 -> latest), and never versions newer than the
 * printed batch. Each version: who / when / total, the automatic change
 * summary and the Admin's note. "Replaced by" is added when the printed batch
 * is no longer the active version. Returns [] when nothing is selected.
 */
function buildVersionNoteLines(history, batchId, fmtMoney, selectedIds = null) {
  if (!Array.isArray(history) || !history.length) return [];
  const idx = history.findIndex((v) => Number(v.payroll_batch_id) === Number(batchId));
  if (idx < 0) return [];
  const current = history[idx];
  const wanted = selectedIds ? new Set([...selectedIds].map(Number)) : null;
  const shown = history.slice(0, idx + 1)
    .filter((v) => !wanted || wanted.has(Number(v.payroll_batch_id)));
  if (!shown.length) return [];
  const when = (v) => String(v.generated_at || '').replace('T', ' ').slice(0, 16);
  const lines = [];
  for (const v of shown) {
    const isThis = Number(v.payroll_batch_id) === Number(batchId);
    lines.push({
      bold: true,
      text: `v${v.version_number}${isThis ? ' (this document)' : ''} - Batch #${v.payroll_batch_id} - ` +
        `${when(v)} by ${v.generated_by || '-'} - Total ${fmtMoney(v.total_amount)} - ${v.status}`,
    });
    if (v.changes) lines.push({ indent: true, text: `Changes vs v${v.previous.version_number}: ${summarizeChanges(v.changes, fmtMoney)}` });
    if (v.note) lines.push({ indent: true, text: `Note: ${v.note}` });
  }
  if (current.replaced_by) {
    lines.push({ bold: true, text: `This batch was replaced by v${current.replaced_by.version_number} (Batch #${current.replaced_by.payroll_batch_id}).` });
  }
  return lines;
}

/** ?versions=101,102 -> [101, 102]; missing / empty -> null (all). */
function parseSelectedVersions(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return String(value).split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

module.exports = { getVersionHistory, summarizeChanges, diffVersions, buildVersionNoteLines, parseSelectedVersions };