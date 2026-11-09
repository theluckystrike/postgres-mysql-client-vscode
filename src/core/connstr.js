'use strict';
// Connection settings: parse a pasted URL, check a form, and build driver options.
// Passwords are never part of a saved connection. They live in VS Code SecretStorage.

const DEFAULT_PORT = { postgres: 5432, mysql: 3306 };
const SSL_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];

/**
 * Parse postgres://, postgresql://, mysql://, mariadb:// or sqlite:// (or a bare .db/.sqlite path).
 * @returns {{type,host,port,user,password,database,sslMode,file}} or throws an Error with a clear message.
 */
function parseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste a connection URL, for example postgres://user@localhost:5432/mydb');
  if (/^sqlite:/i.test(raw)) {
    let file = raw.replace(/^sqlite:(\/\/)?/i, '');
    try { file = decodeURIComponent(file); } catch { /* keep as is */ }
    if (!file) throw new Error('The sqlite: URL has no file path.');
    return { type: 'sqlite', file };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && /\.(db|sqlite3?|db3|s3db|sl3)$/i.test(raw)) return { type: 'sqlite', file: raw };
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  if (!m) throw new Error('This is not a connection URL. It must start with postgres://, mysql:// or sqlite:.');
  const scheme = m[1].toLowerCase();
  let type;
  if (scheme === 'postgres' || scheme === 'postgresql' || scheme === 'pg') type = 'postgres';
  else if (scheme === 'mysql' || scheme === 'mariadb' || scheme === 'mysqlx') type = 'mysql';
  else if (scheme === 'mongodb' || scheme === 'mongodb+srv') throw new Error('MongoDB is not supported. This extension connects to PostgreSQL, MySQL, MariaDB and SQLite.');
  else throw new Error(`"${m[1]}://" is not supported. Use postgres://, mysql:// or sqlite:.`);
  let rest = m[2];
  let query = '';
  const q = rest.indexOf('?');
  if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  let auth = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) { auth = rest.slice(0, at); rest = rest.slice(at + 1); }
  const slash = rest.indexOf('/');
  const hostPort = slash >= 0 ? rest.slice(0, slash) : rest;
  const database = slash >= 0 ? dec(rest.slice(slash + 1)) : '';
  let host = hostPort;
  let port = DEFAULT_PORT[type];
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  if (v6) { host = v6[1]; if (v6[2]) port = Number(v6[2]); } else {
    const c = hostPort.lastIndexOf(':');
    if (c >= 0) { host = hostPort.slice(0, c); const p = hostPort.slice(c + 1); if (p) port = Number(p); }
  }
  if (host.includes(',')) throw new Error('URLs with several hosts are not supported. Use one host.');
  host = dec(host) || 'localhost';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`The port in the URL is not a number from 1 to 65535.`);
  let user = '';
  let password = '';
  if (auth) {
    const c = auth.indexOf(':');
    user = dec(c >= 0 ? auth.slice(0, c) : auth);
    password = c >= 0 ? dec(auth.slice(c + 1)) : '';
  }
  const params = new URLSearchParams(query);
  let sslMode = 'disable';
  const ssl = (params.get('sslmode') || params.get('ssl-mode') || params.get('ssl') || '').toLowerCase();
  if (ssl) {
    if (ssl === 'true' || ssl === '1' || ssl === 'required') sslMode = 'require';
    else if (ssl === 'false' || ssl === '0' || ssl === 'disabled') sslMode = 'disable';
    else if (ssl === 'preferred') sslMode = 'prefer';
    else if (ssl === 'verify_identity' || ssl === 'verify-identity') sslMode = 'verify-full';
    else if (ssl === 'verify_ca') sslMode = 'verify-ca';
    else if (SSL_MODES.includes(ssl)) sslMode = ssl;
    else if (ssl === 'allow') sslMode = 'prefer';
    else throw new Error(`Unknown sslmode "${ssl}". Use disable, require, verify-ca or verify-full.`);
  }
  if (!user && params.get('user')) user = params.get('user');
  if (!password && params.get('password')) password = params.get('password');
  return { type, host, port, user, password, database: database || params.get('dbname') || params.get('database') || '', sslMode };
}

function dec(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Check a connection form. Returns a list of problems ('' fields named). */
function validate(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['No connection settings.'];
  if (!['postgres', 'mysql', 'sqlite'].includes(c.type)) errs.push('Pick PostgreSQL, MySQL/MariaDB or SQLite.');
  if (!String(c.name || '').trim()) errs.push('Give the connection a name.');
  if (c.type === 'sqlite') {
    if (!String(c.file || '').trim()) errs.push('Pick the SQLite file.');
  } else if (c.type) {
    if (!String(c.host || '').trim()) errs.push('Type the host name or address.');
    const p = Number(c.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errs.push('The port must be a number from 1 to 65535.');
    if (c.sslMode && !SSL_MODES.includes(c.sslMode)) errs.push('Unknown SSL mode.');
  }
  return errs;
}

/** A URL to show in the tree tooltip. Never holds the password. */
function displayUrl(c) {
  if (c.type === 'sqlite') return `sqlite:${c.file}`;
  const scheme = c.type === 'postgres' ? 'postgres' : 'mysql';
  const user = c.user ? `${encodeURIComponent(c.user)}@` : '';
  const host = /:/.test(c.host) ? `[${c.host}]` : c.host;
  return `${scheme}://${user}${host}:${c.port}/${c.database ? encodeURIComponent(c.database) : ''}${c.sslMode && c.sslMode !== 'disable' ? `?sslmode=${c.sslMode}` : ''}`;
}

/** TLS options for pg and mysql2 from an SSL mode and an optional CA file text. */
function tlsOptions(mode, caText, host) {
  if (!mode || mode === 'disable') return null;
  const o = {};
  if (caText) o.ca = caText;
  if (mode === 'prefer' || mode === 'require') o.rejectUnauthorized = false;
  else {
    o.rejectUnauthorized = true;
    if (mode === 'verify-ca') o.checkServerIdentity = () => undefined;
    else if (host) o.servername = /^[\d.]+$|:/.test(host) ? undefined : host;
  }
  return o;
}

module.exports = { parseUrl, validate, displayUrl, tlsOptions, DEFAULT_PORT, SSL_MODES };
