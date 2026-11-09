'use strict';
// SQL text the extension writes itself: quoted names and values, row edits, sort and filter wrappers,
// INSERT export lines. Every statement the grid commits is built here and shown to the user before it runs.

const { isBinary, toText } = require('./values');

function quoteIdent(name, dialect) {
  const s = String(name);
  if (dialect === 'mysql') return '`' + s.replace(/`/g, '``') + '`';
  return '"' + s.replace(/"/g, '""') + '"';
}

/** schema.table (schema left out when empty). */
function qualified(schema, table, dialect) {
  return (schema ? quoteIdent(schema, dialect) + '.' : '') + quoteIdent(table, dialect);
}

function quoteLiteral(v, dialect) {
  if (v === null || v === undefined) return 'NULL';
  if (isBinary(v)) {
    const hex = Buffer.from(v).toString('hex');
    return dialect === 'postgres' ? `'\\x${hex}'::bytea` : `X'${hex}'`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${String(v)}'`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = toText(v);
  if (dialect === 'mysql') {
    return "'" + s.replace(/[\0\n\r\b\t\\'"\x1a]/g, (c) => ({ '\0': '\\0', '\n': '\\n', '\r': '\\r', '\b': '\\b', '\t': '\\t', '\x1a': '\\Z', '\\': '\\\\', "'": "\\'", '"': '\\"' }[c])) + "'";
  }
  if (s.includes('\0')) throw new Error('This text holds a zero byte, which the database cannot store in a text value.');
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Statements for the staged grid edits.
 * target: {schema, table, pk:[column names], columns:[result column -> table column name or null]}
 * changes: [{kind:'update', key:{col:value}, set:{col:value}} | {kind:'insert', values:{col:value}} | {kind:'delete', key:{col:value}}]
 * Values are text from the grid ('' stays '' ), null for NULL, or Buffers kept from the original row.
 */
function editStatements(target, changes, dialect) {
  const t = qualified(target.schema, target.table, dialect);
  const where = (key) => Object.keys(key).map((c) => key[c] === null
    ? `${quoteIdent(c, dialect)} IS NULL`
    : `${quoteIdent(c, dialect)} = ${quoteLiteral(key[c], dialect)}`).join(' AND ');
  const out = [];
  for (const ch of changes) {
    if (ch.kind === 'update') {
      const cols = Object.keys(ch.set || {});
      if (!cols.length) continue;
      const set = cols.map((c) => `${quoteIdent(c, dialect)} = ${quoteLiteral(ch.set[c], dialect)}`).join(', ');
      out.push({ sql: `UPDATE ${t} SET ${set} WHERE ${where(ch.key)}`, expect: 1 });
    } else if (ch.kind === 'delete') {
      out.push({ sql: `DELETE FROM ${t} WHERE ${where(ch.key)}`, expect: 1 });
    } else if (ch.kind === 'insert') {
      const cols = Object.keys(ch.values || {});
      if (!cols.length) {
        out.push({ sql: dialect === 'mysql' ? `INSERT INTO ${t} () VALUES ()` : `INSERT INTO ${t} DEFAULT VALUES`, expect: 1 });
      } else {
        out.push({ sql: `INSERT INTO ${t} (${cols.map((c) => quoteIdent(c, dialect)).join(', ')}) VALUES (${cols.map((c) => quoteLiteral(ch.values[c], dialect)).join(', ')})`, expect: 1 });
      }
    }
  }
  return out;
}

/**
 * Wrap a SELECT for a server-side sort and filter.
 * sort: {col: 1-based position, desc}, filters: [{name, text}] (column names; LIKE on the text form)
 */
function wrapQuery(sql, dialect, sort, filters) {
  const inner = String(sql).replace(/;\s*$/, '');
  const parts = [`SELECT * FROM (\n${inner}\n) AS zovo_q`];
  const f = (filters || []).filter((x) => x && String(x.text || '') !== '');
  if (f.length) {
    const conds = f.map((x) => {
      const col = `zovo_q.${quoteIdent(x.name, dialect)}`;
      const pat = quoteLiteral('%' + String(x.text).replace(/[\\%_]/g, (c) => '\\' + c) + '%', dialect);
      if (dialect === 'postgres') return `CAST(${col} AS TEXT) ILIKE ${pat}`;
      if (dialect === 'mysql') return `CAST(${col} AS CHAR) LIKE ${pat}`;
      return `CAST(${col} AS TEXT) LIKE ${pat} ESCAPE '\\'`;
    });
    parts.push('WHERE ' + conds.join(' AND '));
  }
  if (sort && sort.col) {
    const dir = sort.desc ? 'DESC' : 'ASC';
    parts.push(`ORDER BY ${Number(sort.col)} ${dir}${dialect === 'postgres' ? (sort.desc ? ' NULLS LAST' : ' NULLS FIRST') : ''}`);
  }
  return parts.join('\n');
}

/** One INSERT line for an export. */
function insertLine(table, columns, row, dialect) {
  return `INSERT INTO ${quoteIdent(table, dialect)} (${columns.map((c) => quoteIdent(c, dialect)).join(', ')}) VALUES (${row.map((v) => quoteLiteral(v, dialect)).join(', ')});\n`;
}

/** SELECT * of a table, for "Open table". */
function selectAll(schema, table, dialect) {
  return `SELECT * FROM ${qualified(schema, table, dialect)}`;
}

module.exports = { quoteIdent, qualified, quoteLiteral, editStatements, wrapQuery, insertLine, selectAll };
