'use strict';
// Zovo Pro features: ER diagram, schema compare, CSV import into a table and the saved query library.
// Everything else (unlimited connections, queries, row editing, export, read-only mode, history,
// autocomplete) is free and stays free. Each Pro feature can be tried 3 times; after that one quiet
// explanation offers the unlock (GitHub Sponsors or a license key, both checked without a server of ours).
// PRO_ENABLED = false makes every Pro feature free (one switch, nothing else changes).

const fs = require('fs');
const readline = require('readline');
const { createLicense } = require('./license');
const { buildHtml } = require('./html');
const { quoteIdent, qualified, quoteLiteral } = require('./core/dialect');

const PRO_ENABLED = true;
const FREE_TRIES = 3;
const SKU = 'sql-client-pro';
const TRIES_KEY = 'zovoSql.proTries';
const SAVED_KEY = 'zovoSql.savedQueries';

function createPro(vscode, context) {
  // name 'Zovo' makes the label "Zovo Pro": one purchase for every Zovo extension.
  const license = createLicense({ vscode, context, sku: SKU, name: 'Zovo', commandPrefix: 'zovoSql' });

  /** True when the user may run the feature now (unlocked, a free try left, or the user unlocked it in the dialog). */
  async function allow(feature, detail) {
    if (!PRO_ENABLED) return true;
    await license.ready;
    if (license.isPro(SKU)) { license.refresh().catch(() => {}); return true; }
    const tries = context.globalState.get(TRIES_KEY, {});
    const used = Number(tries[feature] || 0);
    if (used < FREE_TRIES) {
      tries[feature] = used + 1;
      await context.globalState.update(TRIES_KEY, tries);
      return true;
    }
    return license.requirePro(feature, `${detail} You used your ${FREE_TRIES} free tries. It is USD 19 once on GitHub Sponsors (the "$19 one time" tier) and unlocks Pro in every Zovo extension. Already bought it? Choose Unlock with GitHub Sponsors (one question to GitHub, nothing else is sent). Queries, editing, export and unlimited connections stay free.`);
  }

  return { license, allow, enabled: PRO_ENABLED };
}

// ---------- ER diagram ----------

async function showErDiagram(vscode, context, session, schema, title) {
  const [tables, fks] = await Promise.all([session.schemaColumns(schema, 20000), session.foreignKeys(schema)]);
  const max = 200;
  const shown = tables.slice(0, max);
  const names = new Set(shown.map((t) => t.name));
  const panel = vscode.window.createWebviewPanel('zovoSql.er', `ER: ${title}`, vscode.ViewColumn.Active, {
    enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  panel.webview.html = buildHtml({
    cspSource: panel.webview.cspSource,
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js')).toString(),
    styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.css')).toString(),
    title: `ER: ${title}`, page: 'er', footer: false,
    data: { title, truncated: tables.length > max, tables: shown, fks: fks.filter((f) => names.has(f.table) && names.has(f.refTable)) },
  });
  panel.webview.onDidReceiveMessage(async (m) => {
    if (!m || m.type !== 'saveSvg' || typeof m.svg !== 'string') return;
    const target = await vscode.window.showSaveDialog({ title: 'Save the ER diagram', filters: { SVG: ['svg'] }, defaultUri: vscode.workspace.workspaceFolders ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `${String(title).replace(/[^\w.-]+/g, '_')}-er.svg`) : undefined });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(m.svg, 'utf8'));
    vscode.window.showInformationMessage(`Saved ${target.path.split('/').pop()}.`);
  });
  return panel;
}

// ---------- schema compare ----------

/** A stable, sorted text description of a schema, one table per block, for a side-by-side diff. */
function schemaText(tables, fks, label) {
  const lines = [`-- ${label}`, `-- ${tables.length} tables and views`, ''];
  const byTable = new Map();
  for (const f of fks) { if (!byTable.has(f.table)) byTable.set(f.table, []); byTable.get(f.table).push(f); }
  for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${t.kind === 'view' ? 'VIEW' : 'TABLE'} ${t.name} (`);
    for (const c of t.columns) lines.push(`  ${c.name} ${c.type}${c.notNull ? ' NOT NULL' : ''}${c.default != null ? ` DEFAULT ${c.default}` : ''}${c.pk ? ' PRIMARY KEY' : ''}`);
    for (const f of (byTable.get(t.name) || []).sort((a, b) => a.name.localeCompare(b.name))) lines.push(`  FOREIGN KEY (${f.columns.join(', ')}) REFERENCES ${f.refTable} (${f.refColumns.join(', ')})`);
    lines.push(')', '');
  }
  return lines.join('\n');
}

/** Counts of tables and columns only in A, only in B, or changed. */
function schemaDiffSummary(a, b) {
  const ma = new Map(a.map((t) => [t.name, t]));
  const mb = new Map(b.map((t) => [t.name, t]));
  let onlyA = 0; let onlyB = 0; let changed = 0;
  for (const [n, t] of ma) {
    const u = mb.get(n);
    if (!u) { onlyA++; continue; }
    const ca = t.columns.map((c) => `${c.name} ${c.type} ${c.notNull} ${c.pk}`).join('|');
    const cb = u.columns.map((c) => `${c.name} ${c.type} ${c.notNull} ${c.pk}`).join('|');
    if (ca !== cb) changed++;
  }
  for (const n of mb.keys()) if (!ma.has(n)) onlyB++;
  return { onlyA, onlyB, changed };
}

// ---------- CSV import ----------

/** Parse CSV lines one record at a time (quotes, doubled quotes, newlines in quotes). */
async function* csvRecords(file, sep) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let rec = [];
  let field = '';
  let inQ = false;
  let first = true;
  for await (let line of rl) {
    if (first) { line = line.replace(/^﻿/, ''); first = false; }
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (inQ) {
        if (c === '"') { if (line[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { inQ = true; i++; continue; }
      if (c === sep) { rec.push(field); field = ''; i++; continue; }
      field += c; i++;
    }
    if (inQ) { field += '\n'; continue; }
    rec.push(field);
    yield rec;
    rec = []; field = '';
  }
  if (inQ || field || rec.length) { rec.push(field); yield rec; }
}

function sniffSep(headerLine) {
  const counts = [',', ';', '\t', '|'].map((s) => [s, headerLine.split(s).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

/**
 * Import a CSV file into a table: header names matched to columns (case-insensitive), batched INSERTs of
 * 500 rows in one transaction per batch. Empty fields become NULL when emptyAsNull is set.
 */
async function importCsv(session, file, schema, table, opts = {}) {
  const fd = await fs.promises.open(file, 'r');
  let head = '';
  try { const b = Buffer.alloc(65536); const { bytesRead } = await fd.read(b, 0, b.length, 0); head = b.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0]; } finally { await fd.close(); }
  const sep = opts.sep || sniffSep(head);
  const cols = await session.columns(schema, table);
  const byLower = new Map(cols.map((c) => [c.name.toLowerCase(), c.name]));
  const d = session.dialect;
  let header = null;
  let map = null;
  let batch = [];
  let total = 0;
  const flush = async () => {
    if (!batch.length) return;
    const names = map.filter((m) => m).map((m) => quoteIdent(m, d)).join(', ');
    const values = batch.map((r) => `(${map.map((m, i) => (m ? (r[i] === undefined || (opts.emptyAsNull !== false && r[i] === '') ? 'NULL' : quoteLiteral(r[i], d)) : null)).filter((x) => x !== null).join(', ')})`).join(',\n');
    await session.transaction([{ sql: `INSERT INTO ${qualified(schema, table, d)} (${names}) VALUES\n${values}` }]);
    total += batch.length;
    batch = [];
    if (opts.onProgress) opts.onProgress(total);
  };
  for await (const rec of csvRecords(file, sep)) {
    if (!header) {
      header = rec;
      map = header.map((h) => byLower.get(String(h).trim().toLowerCase()) || null);
      if (!map.some(Boolean)) throw Object.assign(new Error(`No CSV header matches a column of ${table}. Header: ${header.slice(0, 8).join(', ')}`), { friendly: true });
      continue;
    }
    if (rec.length === 1 && rec[0] === '') continue;
    batch.push(rec);
    if (batch.length >= 500) await flush();
    if (opts.shouldStop && opts.shouldStop()) break;
  }
  await flush();
  return { rows: total, matched: map ? map.filter(Boolean) : [], skipped: header ? header.filter((_, i) => !map[i]) : [] };
}

// ---------- saved queries ----------

function savedQueries(context) {
  const x = context.globalState.get(SAVED_KEY, []);
  return Array.isArray(x) ? x : [];
}

async function saveQuery(context, item) {
  const list = savedQueries(context).filter((q) => q.name !== item.name);
  list.unshift({ ...item, savedAt: new Date().toISOString() });
  await context.globalState.update(SAVED_KEY, list.slice(0, 500));
}

async function deleteSavedQuery(context, name) {
  await context.globalState.update(SAVED_KEY, savedQueries(context).filter((q) => q.name !== name));
}

module.exports = { createPro, showErDiagram, schemaText, schemaDiffSummary, importCsv, csvRecords, sniffSep, savedQueries, saveQuery, deleteSavedQuery, PRO_ENABLED, FREE_TRIES, SKU };
