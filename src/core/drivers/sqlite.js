'use strict';
// SQLite session with sql.js (MIT, SQLite compiled to WebAssembly), the engine of the Zovo SQLite viewer.
// The file is read into memory. A statement that changes data is written back to the file at once
// (atomic rename), unless a transaction is open or the connection is read-only. If another program changed
// the file since it was read, the write is refused instead of overwriting that change.

const fs = require('fs');
const path = require('path');
const { friendlyError } = require('./errors');
const { isReadOnlyStatement, firstKeyword } = require('../sqlsplit');
const { quoteIdent } = require('../dialect');

let sqlJsPromise = null;
function loadSqlJs(wasmPath) {
  if (!sqlJsPromise) {
    // eslint-disable-next-line global-require
    const initSqlJs = require('sql.js');
    sqlJsPromise = initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
  }
  return sqlJsPromise;
}

class SqliteSession {
  /** cfg: {file, readOnly, maxFileSizeMB, wasmPath} */
  constructor(cfg) {
    this.cfg = cfg;
    this.dialect = 'sqlite';
    this.db = null;
    this.mtimeMs = 0;
    this.size = 0;
    this.inTx = false;
    this.active = null;
  }

  async open() {
    if (this.db) return this.info;
    const file = this.cfg.file;
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch (e) {
      if (e.code === 'ENOENT') {
        if (this.cfg.readOnly) throw friendlyError(new Error(`The file ${file} does not exist.`), this.cfg, 'sqlite');
        st = null;
      } else throw friendlyError(e, this.cfg, 'sqlite');
    }
    const limit = (this.cfg.maxFileSizeMB || 512) * 1048576;
    if (st && st.size > limit) throw Object.assign(new Error(`This SQLite file is ${(st.size / 1048576).toFixed(0)} MB. It is read into memory, and the limit is ${this.cfg.maxFileSizeMB || 512} MB (setting zovoSql.sqliteMaxFileSizeMB).`), { friendly: true });
    let bytes = null;
    if (st) {
      const fd = await fs.promises.open(file, 'r');
      try {
        const head = Buffer.alloc(16);
        await fd.read(head, 0, 16, 0);
        if (st.size > 0 && head.toString('latin1') !== 'SQLite format 3\u0000') throw Object.assign(new Error(`${path.basename(file)} is not a SQLite database (it does not start with "SQLite format 3").`), { friendly: true });
      } finally { await fd.close(); }
      bytes = await fs.promises.readFile(file);
    }
    const SQL = await loadSqlJs(this.cfg.wasmPath);
    try {
      this.db = new SQL.Database(bytes || undefined);
      this.db.exec('SELECT count(*) FROM sqlite_master');
    } catch (e) {
      this.db = null;
      throw Object.assign(new Error(`SQLite could not read ${path.basename(file)}: ${e.message}`), { friendly: true });
    }
    this.mtimeMs = st ? st.mtimeMs : 0;
    this.size = st ? st.size : 0;
    const v = this.db.exec('SELECT sqlite_version()')[0].values[0][0];
    this.info = { version: `SQLite ${v}`, database: path.basename(file), user: '' };
    if (fs.existsSync(file + '-wal') && fs.statSync(file + '-wal').size > 0) this.info.walWarning = true;
    return this.info;
  }

  async closeActive() {
    const a = this.active;
    this.active = null;
    if (a && !a.done) await a.close();
  }

  async run(sql, maxRows) {
    await this.closeActive();
    await this.open();
    const kw = firstKeyword(sql, 'sqlite');
    const reads = isReadOnlyStatement(sql, 'sqlite');
    if (this.cfg.readOnly && !reads && !['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(kw)) {
      throw Object.assign(new Error('This connection is read-only. Turn off "Read-only" in the connection settings to change data.'), { friendly: true });
    }
    let stmt;
    try {
      stmt = this.db.prepare(sql);
    } catch (e) {
      throw Object.assign(new Error(e.message), { friendly: true });
    }
    const names = stmt.getColumnNames();
    const rows = [];
    let done = false;
    const step = (n) => {
      const out = [];
      try {
        while (out.length < n) {
          if (!stmt.step()) { done = true; break; }
          out.push(stmt.get());
        }
      } catch (e) {
        done = true;
        try { stmt.free(); } catch { /* freed */ }
        throw Object.assign(new Error(e.message), { friendly: true });
      }
      if (done) { try { stmt.free(); } catch { /* freed */ } }
      return out;
    };
    rows.push(...step(names.length ? maxRows : 1));
    if (kw === 'BEGIN' || kw === 'SAVEPOINT') this.inTx = true;
    if (kw === 'COMMIT' || kw === 'END' || kw === 'ROLLBACK' && !/\bTO\b/i.test(sql)) this.inTx = false;
    if (!reads && !this.inTx && !this.cfg.readOnly) await this.persist();
    const columns = names.map((n, i) => ({ name: n, type: guessType(rows, i), kind: guessKind(rows, i), binary: rows.some((r) => r[i] instanceof Uint8Array) }));
    const res = {
      columns, rows, done: done || !names.length, command: kw, rowCount: null,
      fetchMore: async (n) => {
        if (res.done) return [];
        const more = step(n);
        res.done = done;
        return more;
      },
      close: async () => {
        if (!res.done) { res.done = true; try { stmt.free(); } catch { /* freed */ } }
        if (this.active === res) this.active = null;
      },
    };
    if (!names.length) res.rowCount = this.db.getRowsModified();
    if (!res.done) this.active = res;
    return res;
  }

  /** Write the in-memory database back to its file, if nobody else changed the file meanwhile. */
  async persist() {
    const file = this.cfg.file;
    let st = null;
    try { st = await fs.promises.stat(file); } catch { /* new file */ }
    if (st && this.mtimeMs && Math.abs(st.mtimeMs - this.mtimeMs) > 1) {
      throw Object.assign(new Error(`${path.basename(file)} was changed by another program after it was opened, so the change was not saved to the file. Reconnect to read the new file.`), { friendly: true });
    }
    if (fs.existsSync(file + '-wal') && fs.statSync(file + '-wal').size > 0) {
      throw Object.assign(new Error(`${path.basename(file)} has a -wal file with changes another program has not yet merged. The change was not saved; close that program and reconnect.`), { friendly: true });
    }
    const data = this.db.export();
    const tmp = `${file}.zovo-${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
    const st2 = await fs.promises.stat(file);
    this.mtimeMs = st2.mtimeMs;
    this.size = st2.size;
  }

  async cancel() {
    return false; // sql.js runs in this process; long SQLite statements cannot be interrupted
  }

  async editTarget(columns, sql, known) {
    let table = known && known.table;
    if (!table) {
      const m = /^\s*SELECT\s+[\s\S]+?\s+FROM\s+("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)\s*(?:AS\s+\w+\s*)?(?:WHERE\b[\s\S]*|ORDER\b[\s\S]*|LIMIT\b[\s\S]*)?;?\s*$/i.exec(sql || '');
      if (!m || /\bJOIN\b|,\s*[A-Za-z_"`[]+\s*(WHERE|$)/i.test(sql.slice(sql.toUpperCase().indexOf('FROM')))) return { reason: 'Rows are editable for a SELECT from one table.' };
      table = m[1].replace(/^["`[]|["`\]]$/g, '').replace(/""/g, '"');
    }
    await this.open();
    const info = this.db.exec(`SELECT type FROM sqlite_master WHERE name = ${sqlStr(table)}`);
    if (!info.length) return { reason: `${table} was not found.` };
    if (info[0].values[0][0] !== 'table') return { reason: `${table} is a view, so its rows are read-only here.` };
    const cols = await this.columns('', table);
    const pk = cols.filter((c) => c.pk).sort((a, b) => a.pkOrder - b.pkOrder).map((c) => c.name);
    if (!pk.length) return { reason: `${table} has no primary key, so the grid cannot tell rows apart. It stays read-only.`, table };
    const names = new Set(cols.map((c) => c.name));
    const colNames = columns.map((c) => (names.has(c.name) ? c.name : null));
    const missing = pk.filter((k) => !colNames.includes(k));
    if (missing.length) return { reason: `Add the key column ${missing.join(', ')} to the SELECT to edit rows.`, table };
    return { schema: '', table, pk, columns: colNames, editable: columns.map((c, i) => !!colNames[i] && !c.binary), allColumns: cols.map((c) => ({ name: c.name, type: c.type })) };
  }

  async transaction(statements) {
    if (this.cfg.readOnly) throw Object.assign(new Error('This connection is read-only.'), { friendly: true });
    await this.closeActive();
    await this.open();
    this.db.exec('BEGIN');
    const done = [];
    try {
      for (const st of statements) {
        this.db.run(st.sql);
        const n = this.db.getRowsModified();
        if (st.expect !== undefined && n !== st.expect) throw new Error(`"${st.sql.slice(0, 120)}" changed ${n} rows instead of ${st.expect}. Nothing was saved.`);
        done.push(n);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      throw Object.assign(new Error(e.message), { friendly: true });
    }
    await this.persist();
    return done;
  }

  async exportQuery(sql, onBatch, shouldStop, batch = 5000) {
    await this.open();
    const stmt = this.db.prepare(sql);
    try {
      const names = stmt.getColumnNames();
      let columns = null;
      let total = 0;
      for (;;) {
        const rows = [];
        while (rows.length < batch && stmt.step()) rows.push(stmt.get());
        if (!columns) columns = names.map((n, i) => ({ name: n, type: guessType(rows, i), kind: guessKind(rows, i), binary: false }));
        if (rows.length) { await onBatch(columns, rows); total += rows.length; }
        if (rows.length < batch || (shouldStop && shouldStop())) break;
      }
      return { rows: total, columns: columns || [] };
    } finally {
      stmt.free();
    }
  }

  async databases() { return ['main']; }

  async tables() {
    await this.open();
    const r = this.db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return r.length ? r[0].values.map(([name, type]) => ({ name, kind: type === 'view' ? 'view' : 'table', rows: null })) : [];
  }

  async columns(_s, table) {
    await this.open();
    const r = this.db.exec(`PRAGMA table_info(${quoteIdent(table, 'sqlite')})`);
    if (!r.length) return [];
    return r[0].values.map(([, name, type, notnull, dflt, pk]) => ({ name, type: type || '', notNull: !!notnull, default: dflt === null ? null : String(dflt), pk: pk > 0, pkOrder: pk }));
  }

  async indexes(_s, table) {
    await this.open();
    const r = this.db.exec(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ${sqlStr(table)} ORDER BY name`);
    return r.length ? r[0].values.map(([name, s]) => ({ name, def: s || '(automatic index)', unique: /UNIQUE/i.test(s || ''), pk: /autoindex/.test(name) })) : [];
  }

  async schemaColumns() {
    const out = [];
    for (const t of await this.tables()) out.push({ name: t.name, kind: t.kind, columns: (await this.columns('', t.name)).map(({ pkOrder, ...c }) => c) });
    return out;
  }

  async foreignKeys() {
    const out = [];
    for (const t of await this.tables()) {
      if (t.kind !== 'table') continue;
      const r = this.db.exec(`PRAGMA foreign_key_list(${quoteIdent(t.name, 'sqlite')})`);
      if (!r.length) continue;
      const map = new Map();
      for (const [id, , refTable, from, to] of r[0].values) {
        if (!map.has(id)) map.set(id, { name: `fk_${t.name}_${id}`, table: t.name, columns: [], refSchema: '', refTable, refColumns: [] });
        map.get(id).columns.push(from); map.get(id).refColumns.push(to || from);
      }
      out.push(...map.values());
    }
    return out;
  }

  async close() {
    await this.closeActive().catch(() => {});
    if (this.db) { try { this.db.close(); } catch { /* closed */ } this.db = null; }
  }
}

function sqlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function guessKind(rows, i) {
  for (const r of rows) { const v = r[i]; if (v === null || v === undefined) continue; return typeof v === 'number' ? 'number' : 'text'; }
  return 'text';
}

function guessType(rows, i) {
  for (const r of rows) {
    const v = r[i];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'real';
    if (v instanceof Uint8Array) return 'blob';
    return 'text';
  }
  return '';
}

module.exports = { SqliteSession };
