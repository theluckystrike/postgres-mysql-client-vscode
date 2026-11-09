'use strict';
// Saved connections (VS Code global state, no secrets) and their passwords (VS Code SecretStorage).
// Sessions are opened only when the user expands a connection or runs a query.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PgSession } = require('./core/drivers/pg');
const { MySqlSession } = require('./core/drivers/mysql');
const { SqliteSession } = require('./core/drivers/sqlite');

const KEY = 'zovoSql.connections';
const SECRET = (id) => `zovoSql.password.${id}`;
const FIELDS = ['id', 'name', 'type', 'host', 'port', 'user', 'database', 'sslMode', 'caFile', 'readOnly', 'file', 'savePassword'];

class ConnectionStore {
  constructor(vscode, context) {
    this.vscode = vscode;
    this.context = context;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  list() {
    const raw = this.context.globalState.get(KEY, []);
    return Array.isArray(raw) ? raw.filter((c) => c && c.id && c.type) : [];
  }

  get(id) {
    return this.list().find((c) => c.id === id) || null;
  }

  /** Save a connection. password: string to store, '' to clear, undefined to keep the stored one. */
  async save(conn, password) {
    const clean = {};
    for (const f of FIELDS) if (conn[f] !== undefined) clean[f] = conn[f];
    if (!clean.id) clean.id = crypto.randomUUID();
    if (clean.port !== undefined && clean.port !== '') clean.port = Number(clean.port);
    clean.readOnly = !!clean.readOnly;
    const list = this.list();
    const i = list.findIndex((c) => c.id === clean.id);
    if (i >= 0) list[i] = clean; else list.push(clean);
    await this.context.globalState.update(KEY, list);
    if (password !== undefined) {
      if (password && clean.savePassword !== false) await this.context.secrets.store(SECRET(clean.id), password);
      else await this.context.secrets.delete(SECRET(clean.id));
    }
    this.emitter.fire(clean.id);
    return clean;
  }

  async remove(id) {
    await this.context.globalState.update(KEY, this.list().filter((c) => c.id !== id));
    await this.context.secrets.delete(SECRET(id));
    this.emitter.fire(id);
  }

  async password(id) {
    return (await this.context.secrets.get(SECRET(id))) || '';
  }
}

class SessionManager {
  constructor(vscode, context, store, settings) {
    this.vscode = vscode;
    this.context = context;
    this.store = store;
    this.settings = settings;
    this.sessions = new Map(); // `${connId}\u0000${database}` -> session
    this.askedPasswords = new Map(); // passwords typed for this window only (savePassword false)
    this.onDrop = null;
  }

  key(connId, database) {
    return `${connId}\u0000${database || ''}`;
  }

  async get(connId, database) {
    const k = this.key(connId, database);
    if (this.sessions.has(k)) return this.sessions.get(k);
    const c = this.store.get(connId);
    if (!c) throw Object.assign(new Error('This connection was deleted.'), { friendly: true });
    const s = this.settings();
    let session;
    if (c.type === 'sqlite') {
      session = new SqliteSession({ file: c.file, readOnly: c.readOnly, maxFileSizeMB: s.sqliteMaxFileSizeMB, wasmPath: path.join(this.context.extensionPath, 'dist', 'sql-wasm.wasm') });
    } else {
      let password = await this.store.password(connId);
      if (!password && c.savePassword === false) {
        password = this.askedPasswords.get(connId);
        if (password === undefined) {
          password = await this.vscode.window.showInputBox({ title: `Password for ${c.name}`, prompt: `${c.user || 'user'}@${c.host}`, password: true, ignoreFocusOut: true });
          if (password === undefined) throw Object.assign(new Error('No password was typed.'), { friendly: true, cancelled: true });
          this.askedPasswords.set(connId, password);
        }
      }
      let caText;
      if (c.caFile) {
        try { caText = fs.readFileSync(c.caFile, 'utf8'); } catch (e) { throw Object.assign(new Error(`The CA file ${c.caFile} could not be read: ${e.message}`), { friendly: true }); }
      }
      const cfg = { host: c.host, port: c.port, user: c.user, database: database !== undefined && database !== '' ? database : c.database, sslMode: c.sslMode || 'disable', caText, readOnly: c.readOnly, connectTimeoutMs: s.connectTimeoutSeconds * 1000 };
      session = c.type === 'postgres' ? new PgSession(cfg, password) : new MySqlSession(cfg, password);
    }
    session.connId = connId;
    session.database = database || '';
    session.onDrop = (role, err) => { if (this.onDrop) this.onDrop(session, role, err); };
    this.sessions.set(k, session);
    return session;
  }

  /** Close every session of a connection (or all). */
  async close(connId) {
    const all = [...this.sessions.entries()].filter(([k]) => !connId || k.startsWith(`${connId}\u0000`));
    for (const [k] of all) this.sessions.delete(k);
    if (connId) this.askedPasswords.delete(connId); else this.askedPasswords.clear();
    await Promise.all(all.map(([, s]) => s.close().catch(() => {})));
  }

  /** Forget a session after an error that left it unusable. */
  async drop(session) {
    for (const [k, s] of this.sessions) if (s === session) this.sessions.delete(k);
    await session.close().catch(() => {});
  }

  openIds() {
    return new Set([...this.sessions.keys()].map((k) => k.split('\u0000')[0]));
  }
}

module.exports = { ConnectionStore, SessionManager };
