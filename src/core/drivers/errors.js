'use strict';
// Turns driver errors into one clear sentence. Keeps the server's own text and, when there is one,
// the position of the error in the statement (pg: character offset; MySQL: "at line N").
// Never puts a password in a message.

function where(cfg) {
  if (!cfg) return 'the server';
  if (cfg.file) return cfg.file;
  return `${cfg.host}:${cfg.port}`;
}

function friendlyError(e, cfg, dialect, sql) {
  if (!e) return new Error('Unknown error.');
  if (e.friendly) return e;
  const code = e.code || '';
  const raw = String(e.message || e);
  let msg = raw;
  if (code === 'ECONNREFUSED') msg = `Could not connect to ${where(cfg)}: the connection was refused. Check that the server is running and the host and port are right.`;
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') msg = `The host name "${cfg && cfg.host}" was not found. Check the spelling, or your VPN.`;
  else if (code === 'ETIMEDOUT' || /timeout expired|connect ETIMEDOUT|Connection terminated due to connection timeout/i.test(raw)) msg = `No answer from ${where(cfg)} in time. Check the host, the port and any firewall or VPN.`;
  else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') msg = `${where(cfg)} cannot be reached from this computer (no route). Check your network or VPN.`;
  else if (code === '28P01' || code === 'ER_ACCESS_DENIED_ERROR' || e.errno === 1045) msg = `The server refused the user name or password${cfg && cfg.user ? ` for "${cfg.user}"` : ''}. Edit the connection to fix them. ${serverText(raw)}`;
  else if (code === '28000' && /pg_hba\.conf/i.test(raw) && /no encryption/i.test(raw)) msg = `The server needs an SSL connection for this user. Edit the connection and set SSL mode to "require". (${raw})`;
  else if (code === '28000') msg = `The server refused this connection: ${raw}`;
  else if (code === '3D000' || code === 'ER_BAD_DB_ERROR' || e.errno === 1049) msg = `The database does not exist on ${where(cfg)}: ${raw}`;
  else if (code === '57014' || code === 'ER_QUERY_INTERRUPTED' || e.errno === 1317) msg = 'The query was cancelled.';
  else if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || /self[- ]signed certificate/i.test(raw)) msg = `The server's SSL certificate is not trusted (${raw}). Choose the CA file in the connection, or use SSL mode "require" to encrypt without checking the certificate.`;
  else if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') msg = `The server's certificate is for another host name (${raw}). Use the host name in the certificate, or SSL mode "verify-ca".`;
  else if (/The server does not support SSL connections/i.test(raw) || code === 'HANDSHAKE_NO_SSL_SUPPORT') msg = `This server does not accept SSL. Edit the connection and set SSL mode to "disable" or "prefer".`;
  else if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'PROTOCOL_CONNECTION_LOST' || /Connection terminated unexpectedly|server closed the connection/i.test(raw)) msg = `The server closed the connection (${raw}). Run the query again to reconnect.`;
  else if (code === 'ER_NOT_SUPPORTED_AUTH_MODE') msg = `The server asks for an authentication method this driver does not support: ${raw}`;
  const out = new Error(msg.trim());
  out.friendly = true;
  out.code = code;
  // Position of the error in the statement, for the editor marker.
  if (e.position && Number(e.position) > 0) out.position = Number(e.position) - 1; // pg: 1-based character offset
  else if (dialect === 'mysql') {
    const m = /at line (\d+)\s*$/.exec(raw);
    if (m) out.line = Number(m[1]) - 1;
    const near = /near '([\s\S]*?)' at line \d+\s*$/.exec(raw);
    if (near && sql && near[1]) {
      const idx = sql.indexOf(near[1].slice(0, 40));
      if (idx >= 0) out.position = idx;
    }
  }
  if (e.hint) out.message += ` Hint: ${e.hint}`;
  return out;
}

function serverText(raw) {
  return raw ? `(${raw})` : '';
}

module.exports = { friendlyError };
