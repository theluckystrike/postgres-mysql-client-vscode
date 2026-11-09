'use strict';
// PostgreSQL session with the pure-JS `pg` driver (MIT) and `pg-cursor` (MIT).
// Two connections at most, both opened only when the user acts: `main` runs the user's statements (so SET,
// BEGIN and temp tables behave like psql), `meta` reads the schema for the tree, cancels, and commits grid edits.
// No keep-alive query, no polling: nothing runs while the user does nothing.

const { Client } = require('pg');
const Cursor = require('pg-cursor');
const pgTypes = require('pg-types');
const { tlsOptions } = require('../connstr');
const { friendlyError } = require('./errors');

const byteaParser = pgTypes.getTypeParser(17, 'text');
// Text for every type (exactly what the server sent, so an edit writes back the same literal), Buffer for bytea.
const TYPES = { getTypeParser: (oid) => (oid === 17 ? byteaParser : (v) => v) };

const NUMBER_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
const TYPE_NAMES = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid', 114: 'json',
  142: 'xml', 600: 'point', 601: 'lseg', 602: 'path', 603: 'box', 604: 'polygon', 628: 'line', 650: 'cidr', 700: 'float4', 701: 'float8',
  718: 'circle', 790: 'money', 829: 'macaddr', 869: 'inet', 1000: 'bool[]', 1001: 'bytea[]', 1005: 'int2[]', 1007: 'int4[]',
  1009: 'text[]', 1016: 'int8[]', 1021: 'float4[]', 1022: 'float8[]', 1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1083: 'time',
  1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1231: 'numeric[]', 1266: 'timetz', 1560: 'bit', 1562: 'varbit',
  1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 3807: 'jsonb[]', 2951: 'uuid[]', 1015: 'varchar[]', 1182: 'date[]', 1115: 'timestamp[]',
};

function jsonKind(oid) {
  if (NUMBER_OIDS.has(oid)) return 'number';
  if (oid === 16) return 'bool';
  if (oid === 114 || oid === 3802) return 'json';
  return 'text';
}

class PgSession {
  /**
   * cfg: {host, port, user, database, sslMode, caText, readOnly, connectTimeoutMs, statementTimeoutMs}
   */
  constructor(cfg, password) {
    this.cfg = cfg;
    this.password = password;
    this.dialect = 'postgres';
    this.main = null;
    this.meta = null;
    this.mainPid = 0;
    this.active = null; // open Result on main
    this.typeCache = new Map(Object.entries(TYPE_NAMES).map(([k, v]) => [Number(k), v]));
    this.broken = false;
    this.onDrop = null;
  }

  clientConfig(sslOverride) {
    const c = this.cfg;
    const mode = sslOverride !== undefined ? sslOverride : c.sslMode;
    const ssl = tlsOptions(mode, c.caText, c.host);
    return {
      host: c.host, port: Number(c.port), user: c.user || undefined, password: this.password || '',
      database: c.database || undefined,
      ssl: ssl || false,
      connectionTimeoutMillis: c.connectTimeoutMs || 10000,
      application_name: 'Zovo SQL Client (VS Code)',
      keepAlive: false,
      types: TYPES,
    };
  }

  async connectClient(role) {
    const tryOnce = async (ssl) => {
      const client = new Client(this.clientConfig(ssl));
      client.on('error', (e) => this.dropped(role, e));
      try {
        await client.connect();
      } catch (e) {
        try { await client.end(); } catch { /* already closed */ }
        throw e;
      }
      return client;
    };
    let client;
    try {
      client = await tryOnce();
    } catch (e) {
      // sslmode=prefer: fall back to plain TCP when the server has no SSL.
      if (this.cfg.sslMode === 'prefer' && /does not support SSL/i.test(e.message || '')) client = await tryOnce('disable');
      else throw friendlyError(e, this.cfg, 'postgres');
    }
    if (this.cfg.readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    if (this.cfg.statementTimeoutMs) await client.query(`SET statement_timeout = ${Math.max(0, Math.floor(this.cfg.statementTimeoutMs))}`);
    return client;
  }

  dropped(role, e) {
    if (role === 'main') { this.main = null; this.active = null; } else this.meta = null;
    this.broken = true;
    if (this.onDrop) this.onDrop(role, friendlyError(e, this.cfg, 'postgres'));
  }

  async open() {
    if (!this.main) {
      this.main = await this.connectClient('main');
      const r = await this.main.query("SELECT pg_backend_pid() AS pid, version() AS v, current_database() AS db, current_user AS u, current_setting('server_version_num') AS num");
      this.mainPid = Number(r.rows[0].pid);
      this.versionNum = Number(r.rows[0].num) || 0;
      this.info = { version: r.rows[0].v, database: r.rows[0].db, user: r.rows[0].u };
      this.broken = false;
    }
    return this.info;
  }

  async metaClient() {
    if (!this.meta) this.meta = await this.connectClient('meta');
    return this.meta;
  }

  async metaQuery(sql, params) {
    const c = await this.metaClient();
    try {
      return await c.query({ text: sql, values: params, types: TYPES });
    } catch (e) {
      throw friendlyError(e, this.cfg, 'postgres');
    }
  }

  async closeActive() {
    const a = this.active;
    this.active = null;
    if (a && !a.done) await a.close();
  }

  /**
   * Run one statement on the main connection. Reads at most maxRows rows now; result.fetchMore reads more.
   * @returns Result {columns, rows, done, command, rowCount, fetchMore(n), close()}
   */
  async run(sql, maxRows) {
    await this.closeActive();
    await this.open();
    const client = this.main;
    const cursor = client.query(new Cursor(sql, null, { rowMode: 'array', types: TYPES }));
    const read = (n) => new Promise((resolve, reject) => cursor.read(n, (err, rows, result) => (err ? reject(err) : resolve({ rows, result }))));
    let first;
    try {
      first = await read(maxRows);
    } catch (e) {
      try { await new Promise((r) => cursor.close(() => r())); } catch { /* closed */ }
      throw friendlyError(e, this.cfg, 'postgres', sql);
    }
    const fields = (first.result && first.result.fields) || [];
    const columns = await this.describeFields(fields);
    const res = {
      columns,
      rows: first.rows,
      done: !fields.length || first.rows.length < maxRows,
      command: first.result && first.result.command,
      rowCount: first.result && first.result.rowCount,
      fields,
      fetchMore: async (n) => {
        if (res.done) return [];
        let more;
        try {
          more = await read(n);
        } catch (e) {
          res.done = true;
          throw friendlyError(e, this.cfg, 'postgres', sql);
        }
        if (more.rows.length < n) { res.done = true; await res.close(); }
        return more.rows;
      },
      close: () => new Promise((resolve) => {
        res.done = true;
        if (this.active === res) this.active = null;
        try { cursor.close(() => resolve()); } catch { resolve(); }
      }),
    };
    if (res.done) await res.close();
    else this.active = res;
    return res;
  }

  async describeFields(fields) {
    const unknown = [...new Set(fields.map((f) => f.dataTypeID).filter((o) => !this.typeCache.has(o)))];
    if (unknown.length) {
      try {
        const r = await this.metaQuery('SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])', [unknown]);
        for (const row of r.rows) this.typeCache.set(Number(row.oid), row.name);
      } catch { /* names are only labels */ }
    }
    return fields.map((f) => ({
      name: f.name,
      type: this.typeCache.get(f.dataTypeID) || String(f.dataTypeID),
      kind: jsonKind(f.dataTypeID),
      binary: f.dataTypeID === 17,
      tableID: f.tableID,
      columnID: f.columnID,
    }));
  }

  /** Stop the statement running on main (pg_cancel_backend from the meta connection). */
  async cancel() {
    if (!this.main || !this.mainPid) return false;
    const r = await this.metaQuery('SELECT pg_cancel_backend($1) AS ok', [this.mainPid]);
    return r.rows[0] && (r.rows[0].ok === 't' || r.rows[0].ok === true);
  }

  /** Table and key for a result whose columns all come from one table with a primary key, or a reason why not. */
  async editTarget(columns) {
    const ids = [...new Set(columns.map((c) => c.tableID))];
    if (!columns.length) return { reason: 'This result has no columns.' };
    if (ids.length !== 1 || !ids[0]) return { reason: 'Rows are editable when every column comes from one table. This result has computed columns or a join.' };
    const t = await this.metaQuery(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1`, [ids[0]]);
    if (!t.rows.length) return { reason: 'The source table was not found.' };
    const { schema, name, kind } = t.rows[0];
    if (kind !== 'r' && kind !== 'p') return { reason: `${name} is a view, so its rows are read-only here.` };
    const attrs = await this.metaQuery(`SELECT attnum::int AS num, attname AS name, format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped`, [ids[0]]);
    const byNum = new Map(attrs.rows.map((a) => [Number(a.num), a]));
    const pk = await this.metaQuery(`SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1 AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [ids[0]]);
    const pkCols = pk.rows.map((r) => r.name);
    if (!pkCols.length) return { reason: `${name} has no primary key, so the grid cannot tell rows apart. It stays read-only.`, schema, table: name };
    const colNames = columns.map((c) => (byNum.get(c.columnID) || {}).name || null);
    const missing = pkCols.filter((k) => !colNames.includes(k));
    if (missing.length) return { reason: `Add the key column ${missing.join(', ')} to the SELECT to edit rows.`, schema, table: name };
    const allCols = attrs.rows.sort((a, b) => a.num - b.num).map((a) => ({ name: a.name, type: a.type }));
    return { schema, table: name, pk: pkCols, columns: colNames, editable: columns.map((c, i) => !!colNames[i] && !c.binary), allColumns: allCols };
  }

  /** Run the statements in one transaction on the meta connection. Each must change exactly `expect` rows. */
  async transaction(statements) {
    const c = await this.metaClient();
    await c.query('BEGIN');
    const done = [];
    try {
      for (const st of statements) {
        const r = await c.query({ text: st.sql, types: TYPES });
        if (st.expect !== undefined && r.rowCount !== st.expect) {
          throw new Error(`"${st.sql.slice(0, 120)}" changed ${r.rowCount} rows instead of ${st.expect}. Nothing was saved.`);
        }
        done.push(r.rowCount);
      }
      await c.query('COMMIT');
      return done;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* connection gone */ }
      throw friendlyError(e, this.cfg, 'postgres');
    }
  }

  /**
   * Stream a query to onBatch(columns, rows) in batches, on its own connection so the editor stays free.
   * onBatch may return a promise (back-pressure). shouldStop() ends early.
   */
  async exportQuery(sql, onBatch, shouldStop, batch = 5000) {
    const client = await this.connectClient('export');
    try {
      const cursor = client.query(new Cursor(sql, null, { rowMode: 'array', types: TYPES }));
      const read = (n) => new Promise((resolve, reject) => cursor.read(n, (err, rows, result) => (err ? reject(err) : resolve({ rows, result }))));
      let columns = null;
      let total = 0;
      for (;;) {
        const { rows, result } = await read(batch);
        if (!columns) columns = await this.describeFields(result.fields || []);
        if (rows.length) { await onBatch(columns, rows); total += rows.length; }
        if (rows.length < batch || (shouldStop && shouldStop())) break;
      }
      await new Promise((r) => cursor.close(() => r()));
      return { rows: total, columns: columns || [] };
    } catch (e) {
      throw friendlyError(e, this.cfg, 'postgres', sql);
    } finally {
      try { await client.end(); } catch { /* closed */ }
    }
  }

  // ---------- schema for the tree, autocomplete, ER diagram and schema compare ----------

  async databases() {
    const r = await this.metaQuery('SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1');
    return r.rows.map((x) => x.name);
  }

  async schemas() {
    const r = await this.metaQuery(`SELECT n.nspname AS name, (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f'))::int AS n
      FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' ORDER BY (n.nspname = 'public') DESC, 1`);
    return r.rows.map((x) => ({ name: x.name, count: Number(x.n) }));
  }

  async tables(schema) {
    const r = await this.metaQuery(`SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS est
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') ORDER BY 1`, [schema]);
    return r.rows.map((x) => ({ name: x.name, kind: x.kind === 'v' || x.kind === 'm' ? 'view' : 'table', rows: Number(x.est) >= 0 ? Number(x.est) : null }));
  }

  async columns(schema, table) {
    const r = await this.metaQuery(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
        pg_get_expr(d.adbin, d.adrelid) AS dflt,
        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = format('%I.%I', $1::text, $2::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [schema, table]);
    return r.rows.map((x) => ({ name: x.name, type: x.type, notNull: x.notnull === 't' || x.notnull === true, default: x.dflt, pk: x.pk === 't' || x.pk === true }));
  }

  async indexes(schema, table) {
    const r = await this.metaQuery(`SELECT ic.relname AS name, pg_get_indexdef(i.indexrelid) AS def, i.indisprimary AS pk, i.indisunique AS uniq
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = format('%I.%I', $1::text, $2::text)::regclass ORDER BY 1`, [schema, table]);
    return r.rows.map((x) => ({ name: x.name, def: x.def, pk: x.pk === 't' || x.pk === true, unique: x.uniq === 't' || x.uniq === true }));
  }

  /** Leaves out partitions (PostgreSQL 10+): the parent table stands for them in diagrams and autocomplete. */
  async noPartitions(alias) {
    if (!this.versionNum) { try { await this.open(); } catch { return ''; } }
    return this.versionNum >= 100000 ? ` AND NOT ${alias}.relispartition` : '';
  }

  /** Every column of every table in a schema, for autocomplete, the ER diagram and schema compare. */
  async schemaColumns(schema, limit = 20000) {
    const np = await this.noPartitions('c');
    const r = await this.metaQuery(`SELECT c.relname AS t, c.relkind AS k, a.attname AS c, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS nn,
        pg_get_expr(d.adbin, d.adrelid) AS dflt,
        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')${np} ORDER BY c.relname, a.attnum LIMIT $2`, [schema, limit]);
    return groupColumns(r.rows.map((x) => ({ table: x.t, kind: x.k === 'v' || x.k === 'm' ? 'view' : 'table', name: x.c, type: x.type, notNull: x.nn === 't' || x.nn === true, default: x.dflt, pk: x.pk === 't' || x.pk === true })));
  }

  async foreignKeys(schema) {
    const np = await this.noPartitions('cl');
    const r = await this.metaQuery(`SELECT con.conname AS name, cl.relname AS t, fcl.relname AS ft, fn.nspname AS fschema,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(num, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num) AS cols,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(num, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num) AS fcols
      FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_class fcl ON fcl.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fcl.relnamespace
      WHERE con.contype = 'f' AND n.nspname = $1${np}${this.versionNum >= 110000 ? ' AND con.conparentid = 0' : ''} ORDER BY 2, 1`, [schema]);
    return r.rows.map((x) => ({ name: x.name, table: x.t, columns: String(x.cols || '').split(','), refSchema: x.fschema, refTable: x.ft, refColumns: String(x.fcols || '').split(',') }));
  }

  async close() {
    const all = [this.main, this.meta].filter(Boolean);
    this.main = null; this.meta = null; this.active = null;
    await Promise.all(all.map((c) => c.end().catch(() => {})));
  }
}

function groupColumns(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.table)) map.set(r.table, { name: r.table, kind: r.kind, columns: [] });
    map.get(r.table).columns.push({ name: r.name, type: r.type, notNull: r.notNull, default: r.default == null ? null : String(r.default), pk: r.pk });
  }
  return [...map.values()];
}

module.exports = { PgSession, groupColumns, TYPES, jsonKind };
