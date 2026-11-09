'use strict';
// Autocomplete for a .sql file bound to a connection: tables, views and columns from the schema
// (read once when the file is bound, and again on Refresh), plus the keywords of the dialect.

const COMMON = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'ORDER BY', 'GROUP BY', 'HAVING',
  'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'ON', 'USING', 'AS', 'DISTINCT', 'UNION', 'UNION ALL',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'CREATE VIEW',
  'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'DEFAULT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'COALESCE', 'CAST', 'BEGIN', 'COMMIT', 'ROLLBACK', 'WITH', 'ASC', 'DESC', 'TRUE', 'FALSE', 'EXPLAIN'];
const DIALECT = {
  postgres: ['RETURNING', 'ILIKE', 'SERIAL', 'BIGSERIAL', 'JSONB', 'TEXT', 'TIMESTAMPTZ', 'UUID', 'ON CONFLICT', 'DO NOTHING', 'DO UPDATE',
    'EXPLAIN ANALYZE', 'NOW()', 'GEN_RANDOM_UUID()', 'ARRAY', 'ANY', 'LATERAL', 'FILTER', 'OVER', 'PARTITION BY', 'VACUUM', 'ANALYZE',
    'STRING_AGG', 'ARRAY_AGG', 'JSONB_BUILD_OBJECT', 'TO_CHAR', 'DATE_TRUNC', 'GENERATE_SERIES', 'MATERIALIZED VIEW', 'SCHEMA', 'SEARCH_PATH'],
  mysql: ['AUTO_INCREMENT', 'ENGINE', 'SHOW TABLES', 'SHOW DATABASES', 'DESCRIBE', 'USE', 'ON DUPLICATE KEY UPDATE', 'REPLACE INTO',
    'GROUP_CONCAT', 'IFNULL', 'NOW()', 'DATE_FORMAT', 'JSON_EXTRACT', 'VARCHAR', 'INT', 'DATETIME', 'TINYINT', 'UNSIGNED', 'STRAIGHT_JOIN', 'SHOW CREATE TABLE'],
  sqlite: ['PRAGMA', 'AUTOINCREMENT', 'WITHOUT ROWID', 'INTEGER PRIMARY KEY', 'GLOB', 'IFNULL', 'DATETIME', 'STRFTIME', 'JSON_EXTRACT', 'VACUUM', 'ATTACH'],
};

function keywords(dialect) {
  return COMMON.concat(DIALECT[dialect] || []);
}

/** Alias or table name before the dot at the cursor: "u." -> "u". */
function qualifierBefore(linePrefix) {
  const m = /([A-Za-z_][\w$]*|"[^"]+"|`[^`]+`)\.\s*([A-Za-z_][\w$]*)?$/.exec(linePrefix);
  return m ? m[1].replace(/^["`]|["`]$/g, '') : null;
}

/** alias -> table name, from FROM/JOIN/UPDATE/INTO clauses in the statement text. */
function aliases(sql) {
  const out = new Map();
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+((?:[A-Za-z_][\w$]*|"[^"]+"|`[^`]+`)(?:\.(?:[A-Za-z_][\w$]*|"[^"]+"|`[^`]+`))?)(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/gi;
  let m;
  const stop = new Set(['WHERE', 'ON', 'USING', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'GROUP', 'ORDER', 'LIMIT', 'SET', 'VALUES', 'NATURAL', 'HAVING', 'UNION', 'WINDOW']);
  while ((m = re.exec(sql))) {
    const full = m[1].split('.').map((x) => x.replace(/^["`]|["`]$/g, ''));
    const table = full[full.length - 1];
    out.set(table.toLowerCase(), table);
    if (m[2] && !stop.has(m[2].toUpperCase())) out.set(m[2].toLowerCase(), table);
  }
  return out;
}

/**
 * Items for one completion request (pure; the provider maps them to vscode.CompletionItem).
 * schema: [{name, kind, schema, columns:[{name,type,pk}]}]
 */
function completionItems({ schema, dialect, linePrefix, statement }) {
  const q = qualifierBefore(linePrefix);
  const tables = schema || [];
  if (q) {
    const map = aliases(statement || '');
    const target = (map.get(q.toLowerCase()) || q).toLowerCase();
    const t = tables.find((x) => x.name.toLowerCase() === target);
    if (t) return t.columns.map((c) => ({ label: c.name, kind: 'column', detail: `${c.type}${c.pk ? ' · PK' : ''}`, sort: '0' }));
    const sch = tables.filter((x) => (x.schema || '').toLowerCase() === q.toLowerCase());
    if (sch.length) return sch.map((x) => ({ label: x.name, kind: x.kind === 'view' ? 'view' : 'table', detail: `${x.kind} in ${x.schema}`, sort: '0' }));
    return [];
  }
  const items = [];
  const inStatement = aliases(statement || '');
  for (const t of tables) {
    items.push({ label: t.name, kind: t.kind === 'view' ? 'view' : 'table', detail: `${t.kind}${t.schema ? ` in ${t.schema}` : ''} · ${t.columns.length} columns`, sort: '1' });
    if (inStatement.has(t.name.toLowerCase())) for (const c of t.columns) items.push({ label: c.name, kind: 'column', detail: `${t.name}.${c.name} ${c.type}`, sort: '0' });
  }
  for (const k of keywords(dialect)) items.push({ label: k, kind: 'keyword', sort: '2' });
  return items;
}

module.exports = { completionItems, aliases, qualifierBefore, keywords };
