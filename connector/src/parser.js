// Real device format:
//
//   <employeeId> <YYYY-MM-DD HH:mm:ss> <code> <extra columns...>
//
// Example:
//
//   1    2026-09-23 16:46:58    1    255    1    0
//
// Based on the vendor's current explanation:
//   column 1 = Employee ID
//   column 2 = Date + Time
//   column 3 = IN/OUT code
//
// Columns after column 3 are intentionally NOT interpreted yet.
// The complete original line is preserved in rawLine.
//
// Separators supported:
//   - tabs
//   - spaces
//   - commas
//   - semicolons

const LINE_RE =
  /^\s*(\S+)\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s+(\S+)(?:\s+.*)?$/;

function parseLine(rawLine, lineNumber, punchCodeMap) {
  const fail = (reason) => ({
    ok: false,
    error: {
      lineNumber,
      reason,
      rawLine: rawLine.slice(0, 300),
    },
  });

  const normalized = rawLine
    .replace(/^\uFEFF/, '')
    .replace(/[,;]/g, '\t')
    .trim();

  const match = LINE_RE.exec(normalized);

  if (!match) {
    return fail('Unrecognized device line format.');
  }

  const [
    ,
    employeeId,
    year,
    month,
    day,
    hour,
    minute,
    second,
    punchCode,
  ] = match;

  if (!/^\d{1,20}$/.test(employeeId)) {
    return fail('Invalid employee id.');
  }

  const Y = Number(year);
  const M = Number(month);
  const D = Number(day);
  const H = Number(hour);
  const MI = Number(minute);
  const S = Number(second);

  // Validate the wall-clock date/time without converting
  // it to the machine's local timezone.
  const dt = new Date(
    Date.UTC(Y, M - 1, D, H, MI, S)
  );

  if (
    dt.getUTCFullYear() !== Y ||
    dt.getUTCMonth() !== M - 1 ||
    dt.getUTCDate() !== D ||
    dt.getUTCHours() !== H ||
    dt.getUTCMinutes() !== MI ||
    dt.getUTCSeconds() !== S
  ) {
    return fail('Invalid date/time.');
  }

  const punchType = punchCodeMap[punchCode];

  if (!['IN', 'OUT'].includes(punchType)) {
    return fail(
      `Punch code "${punchCode}" is not mapped to IN/OUT.`
    );
  }

  return {
    ok: true,

    punch: {
      deviceEmployeeId: employeeId,

      punchedAt:
        `${year}-${month}-${day} ` +
        `${hour}:${minute}:${second}`,

      rawPunchCode: punchCode,

      punchType,

      // Preserve the complete original device line.
      rawLine: rawLine.trim().slice(0, 500),

      lineNumber,
    },
  };
}

function parseContent(content, punchCodeMap) {
  const punches = [];
  const errors = [];

  let totalRows = 0;

  content.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      return;
    }

    totalRows += 1;

    const result = parseLine(
      line,
      index + 1,
      punchCodeMap
    );

    if (result.ok) {
      punches.push(result.punch);
    } else {
      errors.push(result.error);
    }
  });

  return {
    totalRows,
    punches,
    errors,
  };
}

module.exports = {
  parseLine,
  parseContent,
};