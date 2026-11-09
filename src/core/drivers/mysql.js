'use strict';
// MySQL and MariaDB session with the pure-JS `mysql2` driver (MIT).
// Same shape as the Postgres session: `main` runs the user's statements, `meta` reads the schema, cancels
// (KILL QUERY) and commits grid edits. No keep-alive, no polling.

const mysql = require('mysql2');
const { tlsOptions } = require('../connstr');
const { friendlyError } = require('./errors');
const { wkbToWkt } = require('./wkb');

const NUMBER_TYPES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x08, 0x09, 0xf6]); // DECIMAL..INT24, NEWDECIMAL
const TYPE_NAMES = {
  0x00: 'decimal', 0x01: 'tinyint', 0x02: 'smallint', 0x03: 'int', 0x04: 'float', 0x05: 'double', 0x06: 'null', 0x07: 'timestamp',
  0x08: 'bigint', 0x09: 'mediumint', 0x0a: 'date', 0x0b: 'time', 0x0c: 'datetime', 0x0d: 'year', 0x0f: 'varchar', 0x10: 'bit',
  0xf5: 'json', 0xf6: 'decimal', 0xf7: 'enum', 0xf8: 'set', 0xf9: 'tinyblob', 0xfa: 'mediumblob', 0xfb: 'longblob', 0xfc: 'blob',
  0xfd: 'varchar', 0xfe: 'char', 0xff: 'geometry',
};
const BLOB_TYPES = new Set([0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe]);
const BINARY_CHARSET = 63;

function typeCast(field, next) {
  if (field.type === 'JSON' || field.extendedFormat === 'json') return field.string('utf8');
  if (field.type === 'GEOMETRY') {
    const b = field.buffer();
    if (b === null) return null;
    try { return wkbToWkt(b, true); } catch { return b; }
  }
  if (field.type === 'BIT') {
    const b = field.buffer();
    if (b === null) return null;
    let x = 0n;
    for (const byte of b) x = (x << 8n) | BigInt(byte);
    return x.toString();
  }
  return next();
}

function describe(f) {
  const t = f.columnType;
  const binary = f.characterSet === BINARY_CHARSET && (BLOB_TYPES.has(t));
  let type = TYPE_NAMES[t] || String(t);
  if (f.extendedFormat === 'json') type = 'json';
  else if (f.extendedTypeName) type = f.extendedTypeName;
  if (BLOB_TYPES.has(t) && f.characterSet !== BINARY_CHARSET && type === TYPE_NAMES[t]) type = t === 0xfe ? 'char' : (t === 0xfd || t === 0x0f ? 'varchar' : 'text');
  if (binary && (t === 0xfd || t === 0xfe)) type = t === 0xfe ? 'binary' : 'varbinary';
  return {
    name: f.name,
    type,
    kind: NUMBER_TYPES.has(t) ? 'number' : (t === 0xf5 || f.extendedFormat === 'json' ? 'json' : 'text'),
    binary,
    geometry: t === 0xff,
    db: f.schema,
    orgTable: f.orgTable,
    orgName: f.orgName,
  };
}

class MySqlSession {
  constructor(cfg, password) {
    this.cfg = cfg;
    this.password = password;
    this.dialect = 'mysql';
    this.main = null;
    this.meta = null;
    this.mainThread = 0;
    this.active = null;
    this.onDrop = null;
  }

  options() {
    const c = this.cfg;
    const ssl = tlsOptions(c.sslMode, c.caText, c.host);
    return {
      host: c.host, port: Number(c.port), user: c.user || undefined, password: this.password || '', database: c.database || undefined,
      ssl: ssl || undefined,
      connectTimeout: c.connectTimeoutMs || 10000,
      dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
      multipleStatements: false, rowsAsArray: true, typeCast, charset: 'utf8mb4_general_ci', jsonStrings: true,
      enableKeepAlive: false,
    };
  }

  async connectClient(role) {
    const opts = this.options();
    const tryOnce = (o) => new Promise((resolve, reject) => {
      const conn = mysql.createConnection(o);
      conn.connect((err) => {
        if (err) { try { conn.destroy(); } catch { /* gone */ } reject(err); return; }
        conn.on('error', (e) => this.dropped(role, conn, e));
        conn.on('end', () => { if (this.main === conn) { this.main = null; this.active = null; } if (this.meta === conn) this.meta = null; });
        resolve(conn);
      });
    });
    let conn;
    try {
      conn = await tryOnce(opts);
    } catch (e) {
      if (this.cfg.sslMode === 'prefer' && /SSL/i.test(e.message || '')) conn = await tryOnce({ ...opts, ssl: undefined }).catch((e2) => { throw friendlyError(e2, this.cfg, 'mysql'); });
      else throw friendlyError(e, this.cfg, 'mysql');
    }
    if (this.cfg.readOnly) await q(conn, 'SET SESSION TRANSACTION READ ONLY');
    if (this.cfg.statementTimeoutMs) {
      const ms = Math.max(0, Math.floor(this.cfg.statementTimeoutMs));
      await q(conn, `SET SESSION max_statement_time = ${ms / 1000}`).catch(() => q(conn, `SET SESSION max_execution_time = ${ms}`)).catch(() => {});
    }
    return conn;
  }

  dropped(role, conn, e) {
    if (role === 'main' && this.main === conn) { this.main = null; this.active = null; }
    if (role === 'meta' && this.meta === conn) this.meta = null;
    if (this.onDrop && (role === 'main' || role === 'meta')) this.onDrop(role, friendlyError(e, this.cfg, 'mysql'));
  }

  async open() {
    if (!this.main) {
      this.main = await this.connectClient('main');
      this.mainThread = this.main.threadId;
      const [rows] = await q(this.main, 'SELECT VERSION(), DATABASE(), CURRENT_USER()');
      this.info = { version: rows[0][0], database: rows[0][1], user: rows[0][2] };
    }
    return this.info;
  }

  async metaConn() {
    if (!this.meta) this.meta = await this.connectClient('meta');
    return this.meta;
  }

  async metaQuery(sql, params) {
    const c = await this.metaConn();
    try {
      const [rows] = await q(c, { sql, values: params, rowsAsArray: false });
      return rows;
    } catch (e) {
      throw friendlyError(e, this.cfg, 'mysql');
    }
  }

  async closeActive() {
    const a = this.active;
    this.active = null;
    if (a && !a.done) await a.close();
  }

  async run(sql, maxRows) {
    await this.closeActive();
    await this.open();
    const conn = this.main;
    return new Promise((resolve, reject) => {
      let fields = null;
      let header = null;
      const buf = [];
      let want = maxRows;
      let ended = false;
      let failed = null;
      let waiter = null;
      let settled = false;
      const res = {
        columns: [], rows: [], done: false, command: '', rowCount: null, fields: null,
        fetchMore: (n) => new Promise((ok, bad) => {
          if (res.done && !buf.length) { ok([]); return; }
          if (lost && !buf.length) { res.done = true; bad(friendlyError(lost, this.cfg, 'mysql', sql)); return; }
          if (lost) { ok(buf.splice(0, n)); return; }
          want = n;
          const finish = () => {
            const out = buf.splice(0, n);
            if (ended && !buf.length) { res.done = true; if (this.active === res) this.active = null; }
            ok(out);
          };
          if (buf.length >= n || ended) { finish(); return; }
          waiter = { finish, bad };
          conn.resume();
        }),
        close: async () => {
          if (ended || lost) { res.done = true; buf.length = 0; if (this.active === res) this.active = null; return; }
          res.done = true;
          if (this.active === res) this.active = null;
          // Stop the server sending the rest, then read what is already on the way.
          try { await this.killQuery(); } catch { /* the drain below still ends it */ }
          await new Promise((ok) => {
            discard = ok;
            conn.resume();
            if (ended) ok();
          });
          buf.length = 0;
        },
      };
      let discard = null;
      // A connection that drops while the rows are paused never ends the query: watch the connection itself.
      let lost = null;
      const onLost = (e) => {
        unwatch();
        if (ended) return;
        if (this.main === conn) { this.main = null; this.active = null; }
        lost = e && e.message ? e : Object.assign(new Error('Connection lost: the server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });
        if (discard) { const d = discard; discard = null; d(); }
        if (waiter) { const w = waiter; waiter = null; res.done = true; w.bad(friendlyError(lost, this.cfg, 'mysql', sql)); }
        if (!settled) { settled = true; reject(friendlyError(lost, this.cfg, 'mysql', sql)); }
      };
      conn.once('error', onLost);
      conn.once('end', onLost);
      const unwatch = () => { conn.removeListener('error', onLost); conn.removeListener('end', onLost); };
      const query = conn.query({ sql, rowsAsArray: true, typeCast });
      query.on('fields', (f) => { fields = f; });
      query.on('result', (row) => {
        if (discard) return;
        if (Array.isArray(row)) {
          buf.push(row);
          if (!settled && buf.length >= want) { conn.pause(); settle(); return; }
          if (waiter && buf.length >= want) { conn.pause(); const w = waiter; waiter = null; w.finish(); }
        } else header = row; // OK packet of INSERT/UPDATE/DDL
      });
      query.on('error', (e) => {
        failed = e;
        unwatch();
        if (discard) return;
        if (!settled) { settled = true; reject(friendlyError(e, this.cfg, 'mysql', sql)); return; }
        if (waiter) { const w = waiter; waiter = null; res.done = true; w.bad(friendlyError(e, this.cfg, 'mysql', sql)); }
      });
      query.on('end', () => {
        ended = true;
        unwatch();
        if (discard) { const d = discard; discard = null; d(); return; }
        if (failed) return;
        if (!settled) { settle(); return; }
        if (waiter) { const w = waiter; waiter = null; w.finish(); }
      });
      const settle = () => {
        settled = true;
        res.fields = fields;
        res.columns = (fields || []).map(describe);
        res.rows = buf.splice(0, want);
        res.done = ended && !buf.length;
        if (!fields) {
          res.done = true;
          res.rowCount = header ? header.affectedRows : 0;
          res.command = firstWord(sql);
          res.info = header && header.info;
          res.insertId = header && header.insertId;
        } else res.rowCount = null;
        if (!res.done) this.active = res;
        resolve(res);
      };
    });
  }

  async killQuery() {
    if (!this.mainThread) return false;
    const c = await this.metaConn();
    await q(c, `KILL QUERY ${Number(this.mainThread)}`);
    return true;
  }

  async cancel() {
    if (!this.main) return false;
    return this.killQuery();
  }

  async editTarget(columns) {
    if (!columns.length) return { reason: 'This result has no columns.' };
    const tables = new Set(columns.map((c) => `${c.db}\u0000${c.orgTable}`));
    if (tables.size !== 1 || !columns[0].orgTable) return { reason: 'Rows are editable when every column comes from one table. This result has computed columns or a join.' };
    const db = columns[0].db;
    const table = columns[0].orgTable;
    const info = await this.metaQuery('SELECT TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [db, table]);
    if (!info.length) return { reason: `The source table ${table} was not found.` };
    if (!/BASE TABLE/i.test(info[0].t)) return { reason: `${table} is a view, so its rows are read-only here.` };
    const pk = await this.metaQuery("SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION", [db, table]);
    const pkCols = pk.map((r) => r.c);
    if (!pkCols.length) return { reason: `${table} has no primary key, so the grid cannot tell rows apart. It stays read-only.`, schema: db, table };
    const colNames = columns.map((c) => c.orgName || null);
    const missing = pkCols.filter((k) => !colNames.includes(k));
    if (missing.length) return { reason: `Add the key column ${missing.join(', ')} to the SELECT to edit rows.`, schema: db, table };
    const all = await this.columns(db, table);
    return { schema: db, table, pk: pkCols, columns: colNames, editable: columns.map((c, i) => !!colNames[i] && !c.binary && !c.geometry), allColumns: all.map((c) => ({ name: c.name, type: c.type })) };
  }

  async transaction(statements) {
    const c = await this.metaConn();
    await q(c, 'START TRANSACTION');
    const done = [];
    try {
      for (const st of statements) {
        const [r] = await q(c, { sql: st.sql, rowsAsArray: false });
        const n = r && typeof r.affectedRows === 'number' ? r.affectedRows : 0;
        if (st.expect !== undefined && n !== st.expect) throw new Error(`"${st.sql.slice(0, 120)}" changed ${n} rows instead of ${st.expect}. Nothing was saved.`);
        done.push(n);
      }
      await q(c, 'COMMIT');
      return done;
    } catch (e) {
      try { await q(c, 'ROLLBACK'); } catch { /* gone */ }
      throw friendlyError(e, this.cfg, 'mysql');
    }
  }

  async exportQuery(sql, onBatch, shouldStop, batch = 5000) {
    const conn = await this.connectClient('export');
    try {
      return await new Promise((resolve, reject) => {
        let columns = null;
        let rows = [];
        let total = 0;
        let busy = false;
        let ended = false;
        let stopped = false;
        let failed = false;
        const flush = async () => {
          if (!rows.length) return;
          const out = rows; rows = [];
          total += out.length;
          await onBatch(columns, out);
        };
        const query = conn.query({ sql, rowsAsArray: true, typeCast });
        query.on('fields', (f) => { columns = (f || []).map(describe); });
        query.on('result', (row) => {
          if (stopped || !Array.isArray(row)) return;
          rows.push(row);
          if (rows.length >= batch && !busy) {
            busy = true;
            conn.pause();
            flush().then(() => {
              busy = false;
              if (shouldStop && shouldStop()) { stopped = true; conn.destroy(); resolve({ rows: total, columns: columns || [], stopped: true }); return; }
              if (ended) finish(); else conn.resume();
            }, (e) => { failed = true; conn.destroy(); reject(e); });
          }
        });
        const finish = () => flush().then(() => resolve({ rows: total, columns: columns || [] }), reject);
        query.on('error', (e) => { if (!stopped && !failed) { failed = true; reject(friendlyError(e, this.cfg, 'mysql', sql)); } });
        query.on('end', () => { ended = true; if (!busy && !stopped && !failed) finish(); });
      });
    } finally {
      try { conn.destroy(); } catch { /* closed */ }
    }
  }

  // ---------- schema ----------

  async databases() {
    const rows = await this.metaQuery('SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
    const sys = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
    const names = rows.map((r) => r.n);
    return names.filter((n) => !sys.has(n)).concat(names.filter((n) => sys.has(n)));
  }

  async tables(db) {
    const rows = await this.metaQuery('SELECT TABLE_NAME AS n, TABLE_TYPE AS t, TABLE_ROWS AS r FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [db]);
    return rows.map((r) => ({ name: r.n, kind: /VIEW/i.test(r.t) ? 'view' : 'table', rows: r.r === null || r.r === undefined ? null : Number(r.r) }));
  }

  async columns(db, table) {
    const rows = await this.metaQuery('SELECT COLUMN_NAME AS n, COLUMN_TYPE AS t, IS_NULLABLE AS nl, COLUMN_DEFAULT AS d, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [db, table]);
    return rows.map((r) => ({ name: r.n, type: String(r.t), notNull: r.nl === 'NO', default: r.d === null ? null : String(r.d), pk: r.k === 'PRI' }));
  }

  async indexes(db, table) {
    const rows = await this.metaQuery('SELECT INDEX_NAME AS n, NON_UNIQUE AS nu, COLUMN_NAME AS c, SEQ_IN_INDEX AS s FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX', [db, table]);
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.n)) map.set(r.n, { name: r.n, unique: Number(r.nu) === 0, pk: r.n === 'PRIMARY', cols: [] });
      map.get(r.n).cols.push(r.c);
    }
    return [...map.values()].map((x) => ({ name: x.name, unique: x.unique, pk: x.pk, def: `${x.unique ? 'UNIQUE ' : ''}(${x.cols.join(', ')})` }));
  }

  async schemaColumns(db, limit = 20000) {
    const rows = await this.metaQuery(`SELECT c.TABLE_NAME AS t, t.TABLE_TYPE AS tt, c.COLUMN_NAME AS n, c.COLUMN_TYPE AS ty, c.IS_NULLABLE AS nl, c.COLUMN_DEFAULT AS d, c.COLUMN_KEY AS k
      FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = ? ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION LIMIT ${Math.floor(limit)}`, [db]);
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.t)) map.set(r.t, { name: r.t, kind: /VIEW/i.test(r.tt) ? 'view' : 'table', columns: [] });
      map.get(r.t).columns.push({ name: r.n, type: String(r.ty), notNull: r.nl === 'NO', default: r.d === null ? null : String(r.d), pk: r.k === 'PRI' });
    }
    return [...map.values()];
  }

  async foreignKeys(db) {
    const rows = await this.metaQuery(`SELECT CONSTRAINT_NAME AS n, TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_SCHEMA AS rs, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc
      FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, [db]);
    const map = new Map();
    for (const r of rows) {
      const k = `${r.t}\u0000${r.n}`;
      if (!map.has(k)) map.set(k, { name: r.n, table: r.t, columns: [], refSchema: r.rs, refTable: r.rt, refColumns: [] });
      map.get(k).columns.push(r.c); map.get(k).refColumns.push(r.rc);
    }
    return [...map.values()];
  }

  async close() {
    const all = [this.main, this.meta].filter(Boolean);
    this.main = null; this.meta = null; this.active = null;
    await Promise.all(all.map((c) => new Promise((ok) => { try { c.end(() => ok()); } catch { ok(); } setTimeout(() => { try { c.destroy(); } catch { /* gone */ } ok(); }, 2000); })));
  }
}

function q(conn, sql) {
  return new Promise((resolve, reject) => conn.query(sql, (err, rows, fields) => (err ? reject(err) : resolve([rows, fields]))));
}

function firstWord(sql) {
  const m = /^[\s(]*([A-Za-z]+)/.exec(String(sql).replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|#[^\n]*\n)*/, ''));
  return m ? m[1].toUpperCase() : '';
}

module.exports = { MySqlSession, describe, typeCast };
