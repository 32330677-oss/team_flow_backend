// services/dpr/dec.js
//
// Exact decimal arithmetic for the Daily Progress Report (no float, no
// rounding). Values are BigInt scaled by 10^8 (8 decimal places), enough for
// DECIMAL(18,4) quantities x DECIMAL(18,4) rates. MySQL returns DECIMAL as
// strings: they are parsed exactly.
//
//   D.of('617.2') + ...   -> use add/sub/mul helpers
//   D.str(x)              -> '643' / '1167.2' (no trailing zeros)
//   D.num(x)              -> JS number (only for ratios / display)
'use strict';

const SCALE = 100000000n; // 10^8
const DIGITS = 8;

function of(v) {
  if (v === null || v === undefined || v === '') return 0n;
  if (typeof v === 'bigint') return v * SCALE;
  let s = typeof v === 'number' ? numberToString(v) : String(v).trim();
  if (!/^[-+]?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || s === '-' || s === '+') {
    throw new Error(`Not a decimal number: ${v}`);
  }
  let neg = false;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; s = s.slice(1); }
  const [i, f = ''] = s.split('.');
  if (f.length > DIGITS && /[1-9]/.test(f.slice(DIGITS))) {
    throw new Error(`Too many decimal places (max ${DIGITS}): ${v}`);
  }
  const frac = (f + '0'.repeat(DIGITS)).slice(0, DIGITS);
  const out = BigInt(i || '0') * SCALE + BigInt(frac || '0');
  return neg ? -out : out;
}

function numberToString(n) {
  if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${n}`);
  // shortest exact representation of the double as typed (e.g. 0.1 -> "0.1")
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(DIGITS);
}

const add = (...xs) => xs.reduce((a, b) => a + b, 0n);
const sub = (a, b) => a - b;
/** a x b (both scaled) -> scaled. Exact while the true result has <= 8 decimals. */
const mul = (a, b) => (a * b) / SCALE;
/** a x integer n */
const mulInt = (a, n) => a * BigInt(n);
const min = (a, b) => (a < b ? a : b);
const isZero = (a) => a === 0n;

function str(a) {
  const neg = a < 0n;
  const x = neg ? -a : a;
  const i = x / SCALE;
  let f = (x % SCALE).toString().padStart(DIGITS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${i}${f ? `.${f}` : ''}`;
}

/** As a JS number (ratios, charts). */
const num = (a) => Number(str(a));

/** a / b as a JS number (percentages, output per MH). null when b = 0. */
function ratio(a, b) {
  if (b === 0n) return null;
  return Number(a) / Number(b);
}

module.exports = { SCALE, of, add, sub, mul, mulInt, min, isZero, str, num, ratio };
