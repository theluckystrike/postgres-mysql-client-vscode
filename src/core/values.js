'use strict';
// Cell values: what the grid gets, and how exports write them.
// Drivers return text for most types (exactly what the server sent), Buffers for binary, null for NULL,
// numbers only for SQLite numbers. The grid gets short strings; long text and binary get a stub, and the
// full value is read from the host when the user opens the cell.

const GRID_TEXT_MAX = 2000;
const HEX_PREVIEW = 32;

function isBinary(v) {
  return Buffer.isBuffer(v) || v instanceof Uint8Array;
}

function toText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return isNaN(v) ? String(v) : v.toISOString();
  if (isBinary(v)) return hexLiteral(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function hexLiteral(b) {
  return '\\x' + Buffer.from(b.buffer ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : b).toString('hex');
}

/** Kind of binary data, from its first bytes, for the grid label. */
function sniffBinary(b) {
  const h = Buffer.from(b.subarray(0, 12));
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'png';
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'jpeg';
  if (h.slice(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (h.slice(0, 4).toString('latin1') === 'RIFF' && h.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (h.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (h[0] === 0x50 && h[1] === 0x4b) return 'zip';
  return '';
}

/**
 * One cell for the grid: null | number | string | {t:'bin', n:size, h:hex preview, k:kind} | {t:'long', s:head, n:length}
 */
function gridCell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (isBinary(v)) {
    const b = Buffer.from(v.buffer ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
    return { t: 'bin', n: b.length, h: b.subarray(0, HEX_PREVIEW).toString('hex'), k: sniffBinary(b) };
  }
  const s = toText(v);
  if (s.length > GRID_TEXT_MAX) return { t: 'long', s: s.slice(0, GRID_TEXT_MAX), n: s.length };
  return s;
}

function gridRows(rows) {
  return rows.map((r) => r.map(gridCell));
}

// ---------- export formats ----------

function csvField(v, sep) {
  if (v === null || v === undefined) return '';
  const s = isBinary(v) ? hexLiteral(v) : toText(v);
  if (s === '' || /["\r\n]/.test(s) || s.includes(sep) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvLine(row, sep = ',') {
  return row.map((v) => csvField(v, sep)).join(sep) + '\r\n';
}

/** JSON value for export. jsonKind per column: 'number' | 'bool' | 'json' | 'text'. */
function jsonValue(v, kind) {
  if (v === null || v === undefined) return null;
  if (isBinary(v)) return Buffer.from(v).toString('base64');
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  const s = toText(v);
  if (kind === 'number') {
    const x = Number(s);
    return Number.isFinite(x) && String(x) === s.replace(/^\+/, '') ? x : s;
  }
  if (kind === 'bool') {
    if (s === 't' || s === 'true' || s === '1') return true;
    if (s === 'f' || s === 'false' || s === '0') return false;
    return s;
  }
  if (kind === 'json') { try { return JSON.parse(s); } catch { return s; } }
  return s;
}

module.exports = { GRID_TEXT_MAX, isBinary, toText, hexLiteral, sniffBinary, gridCell, gridRows, csvField, csvLine, jsonValue };
