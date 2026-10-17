// tests/dpr_safety.unit.test.js
// GUARD: the DPR code may only WRITE to its own tables (dpr_*). Every INSERT / UPDATE /
// DELETE / REPLACE / ALTER / DROP / TRUNCATE in services/dpr and the DPR controller is
// checked. Team Flow tables are read only (SELECT); the equipment system is reached only
// through its read-only API.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const files = [
  ...fs.readdirSync(path.join(__dirname, '..', 'services', 'dpr')).map((f) => path.join(__dirname, '..', 'services', 'dpr', f)),
  path.join(__dirname, '..', 'controllers', 'dprController.js'),
  path.join(__dirname, '..', 'routes', 'dprRoutes.js'),
];

test('DPR code writes only to dpr_* tables', () => {
  const bad = [];
  let writes = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /\b(INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE(?:\s+TABLE)?)\s+([`$\w{}]+)/gi;
    let m;
    while ((m = re.exec(src))) {
      const table = m[2].replace(/`/g, '');
      const before = src.slice(Math.max(0, m.index - 20), m.index);
      if (/DUPLICATE\s+KEY\s+$/i.test(before)) continue; // ON DUPLICATE KEY UPDATE col = ...
      if (/^(SET|ON|the|a|an)$/i.test(table)) continue;
      writes += 1;
      if (!/^dpr_/.test(table) && table !== '${R') bad.push(`${path.basename(f)}: ${m[0]}`);
    }
    assert.ok(!/require\(['"].*equipment.*db/i.test(src), `${path.basename(f)} must not open the equipment database`);
  }
  assert.ok(writes > 20, 'the guard found the write statements');
  assert.deepEqual(bad, []);
});

test('the register tables used through ${R.table} are dpr_* tables', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'dpr', 'dprDay.js'), 'utf8');
  const tables = [...src.matchAll(/table: '([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(tables.sort(), ['dpr_concerns', 'dpr_ncr']);
});
