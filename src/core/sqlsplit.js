'use strict';
// Splits SQL text into statements without a parser. Knows quotes, comments and Postgres dollar quotes,
// so a semicolon inside a string, an identifier, a comment or a function body never splits a statement.
// dialect: 'postgres' | 'mysql' | 'sqlite'

/**
 * @returns {{start:number,end:number,text:string}[]} statements with their offsets in the input
 * (start..end covers the text without the trailing semicolon; text is trimmed of leading/trailing space).
 */
function splitStatements(sql, dialect) {
  const s = String(sql || '');
  const out = [];
  let i = 0;
  let stmtStart = 0;
  const n = s.length;
  const push = (end) => {
    const raw = s.slice(stmtStart, end);
    const lead = raw.length - raw.replace(/^\s+/, '').length;
    const text = raw.trim();
    if (text && !onlyComments(text, dialect)) out.push({ start: stmtStart + lead, end: stmtStart + lead + text.length, text });
  };
  // MySQL "DELIMITER //" lines change the separator (used by dump files and procedure scripts).
  let delim = ';';
  while (i < n) {
    const c = s[i];
    const next = s[i + 1];
    if (dialect === 'mysql' && (i === 0 || s[i - 1] === '\n') && /^delimiter\s+\S+/i.test(s.slice(i, i + 40))) {
      push(i);
      const m = /^delimiter\s+(\S+)[^\n]*\n?/i.exec(s.slice(i));
      delim = m[1];
      i += m[0].length;
      stmtStart = i;
      continue;
    }
    if (c === '-' && next === '-') { i = lineEnd(s, i); continue; }
    if (c === '#' && dialect === 'mysql') { i = lineEnd(s, i); continue; }
    if (c === '/' && next === '*') {
      const e = s.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'" || c === '"' || (c === '`' && dialect !== 'postgres')) {
      i = quoteEnd(s, i, c, dialect);
      continue;
    }
    if (c === '[' && dialect === 'sqlite') {
      const e = s.indexOf(']', i + 1);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
      if (m && !(i > 0 && /[A-Za-z0-9_]/.test(s[i - 1]))) {
        const tag = m[0];
        const e = s.indexOf(tag, i + tag.length);
        i = e < 0 ? n : e + tag.length;
        continue;
      }
    }
    if (s.startsWith(delim, i)) {
      push(i);
      i += delim.length;
      stmtStart = i;
      continue;
    }
    i++;
  }
  push(n);
  return out;
}

function lineEnd(s, i) {
  const e = s.indexOf('\n', i);
  return e < 0 ? s.length : e + 1;
}

function quoteEnd(s, i, q, dialect) {
  let j = i + 1;
  const backslash = dialect === 'mysql' && q !== '`';
  while (j < s.length) {
    const c = s[j];
    if (backslash && c === '\\') { j += 2; continue; }
    if (c === q) {
      if (s[j + 1] === q) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return s.length;
}

function onlyComments(text, dialect) {
  return stripComments(text, dialect).trim() === '';
}

/** The text with comments removed (strings kept). */
function stripComments(sql, dialect) {
  const s = String(sql || '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if ((c === '-' && next === '-') || (c === '#' && dialect === 'mysql')) { i = lineEnd(s, i); out += '\n'; continue; }
    if (c === '/' && next === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || (c === '`' && dialect !== 'postgres')) { const e = quoteEnd(s, i, c, dialect); out += s.slice(i, e); i = e; continue; }
    if (c === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
      if (m && !(i > 0 && /[A-Za-z0-9_]/.test(s[i - 1]))) {
        const e = s.indexOf(m[0], i + m[0].length);
        const end = e < 0 ? s.length : e + m[0].length;
        out += s.slice(i, end); i = end; continue;
      }
    }
    out += c; i++;
  }
  return out;
}

/** The statement that holds the offset (or the one just before it when the cursor sits after a semicolon). */
function statementAt(sql, offset, dialect) {
  const list = splitStatements(sql, dialect);
  if (!list.length) return null;
  for (const st of list) if (offset >= st.start && offset <= st.end + 1) return st;
  let best = null;
  for (const st of list) if (st.end <= offset) best = st;
  return best || list[0];
}

/** Text of the statement with strings, identifiers and comments blanked, for keyword checks. */
function skeleton(sql, dialect) {
  const s = stripComments(sql, dialect);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || (c === '`' && dialect !== 'postgres')) { const e = quoteEnd(s, i, c, dialect); out += ' '.repeat(e - i); i = e; continue; }
    if (c === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 64));
      if (m && !(i > 0 && /[A-Za-z0-9_]/.test(s[i - 1]))) {
        const e = s.indexOf(m[0], i + m[0].length);
        const end = e < 0 ? s.length : e + m[0].length;
        out += ' '.repeat(end - i); i = end; continue;
      }
    }
    out += c; i++;
  }
  return out;
}

function firstKeyword(sql, dialect) {
  const m = /^[\s(]*([A-Za-z]+)/.exec(skeleton(sql, dialect));
  return m ? m[1].toUpperCase() : '';
}

/** UPDATE or DELETE with no WHERE clause: changes every row of the table. */
function isUnboundedWrite(sql, dialect) {
  const k = firstKeyword(sql, dialect);
  const sk = skeleton(sql, dialect).toUpperCase();
  if (k === 'UPDATE' || k === 'DELETE') return !/\bWHERE\b/.test(sk);
  if (k === 'WITH') {
    // WITH ... UPDATE/DELETE: check the main statement after the last closing parenthesis of the CTE list.
    const m = /\)\s*(UPDATE|DELETE)\b([\s\S]*)$/.exec(sk);
    if (m) return !/\bWHERE\b/.test(m[2]);
  }
  if (k === 'TRUNCATE') return true;
  return false;
}

const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE', 'PRAGMA']);

/** True when the statement only reads (by its first keyword). WITH ... UPDATE counts as a write. */
function isReadOnlyStatement(sql, dialect) {
  const k = firstKeyword(sql, dialect);
  if (!READ_KEYWORDS.has(k)) return false;
  const sk = skeleton(sql, dialect).toUpperCase();
  if (k === 'WITH' && /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(sk)) return false;
  if (k === 'PRAGMA' && /=/.test(sk)) return false;
  return true;
}

/** A query whose result can be wrapped in SELECT * FROM (...) for server-side sort and filter. */
function isWrappable(sql, dialect) {
  const k = firstKeyword(sql, dialect);
  if (!(k === 'SELECT' || k === 'WITH' || k === 'VALUES' || k === 'TABLE')) return false;
  const sk = skeleton(sql, dialect).toUpperCase();
  if (k === 'WITH' && /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(sk)) return false;
  if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY|KEY)\b/.test(sk)) return false;
  if (/\bINTO\b/.test(sk)) return false; // SELECT ... INTO creates a table or sets variables
  return true;
}

module.exports = { splitStatements, statementAt, stripComments, skeleton, firstKeyword, isUnboundedWrite, isReadOnlyStatement, isWrappable };
