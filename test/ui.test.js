'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('../src/html');
const { completionItems, aliases } = require('../src/completion');
const { schemaText, schemaDiffSummary, csvRecords, sniffSep } = require('../src/pro');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('webview CSP: default-src none, scripts by nonce only, no remote sources', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://x', scriptUri: 'vscode-webview://x/w.js', styleUri: 'vscode-webview://x/s.css', title: '<t>', page: 'grid', nonce: 'abc', data: { x: '</script><script>alert(1)</script>' } });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'(;|$)/);
  assert.match(csp, /img-src vscode-webview:\/\/x blob: data:/);
  assert.ok(!/https?:/.test(csp));
  assert.ok(!html.includes('</script><script>alert'));
  assert.ok(html.includes('&lt;t&gt;'));
});

test('package.json: engine floor, display name words, every command has a title', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
  const name = pkg.displayName.toLowerCase();
  for (const phrase of ['mysql client', 'postgres client', 'sql client', 'database client']) for (const w of phrase.split(' ')) assert.ok(name.includes(w), `${w} in name`);
  assert.ok(pkg.description.includes('PostgreSQL'));
  const src = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8') + fs.readFileSync(path.join(root, 'src/pro.js'), 'utf8');
  const listed = new Set(pkg.contributes.commands.map((c) => c.command));
  const registered = [...src.matchAll(/reg\('([A-Za-z]+)'/g)].map((m) => `zovoSql.${m[1]}`);
  for (const id of registered) assert.ok(listed.has(id), `${id} listed in package.json`);
  for (const id of ['zovoSql.supportDeveloper', 'zovoSql.moreViewers', 'zovoSql.enterLicenseKey', 'zovoSql.getPro', 'zovoSql.unlockWithSponsors', 'zovoSql.removeLicense']) assert.ok(listed.has(id));
});

test('no telemetry, no update check: no fetch or http client in our sources', () => {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(root, 'src'));
  for (const f of files) {
    if (f.includes(`${path.sep}license${path.sep}`)) continue; // the Sponsors rail talks to GitHub only after a user click (own tests)
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/\bfetch\(|require\('https?'\)|XMLHttpRequest|setInterval\(/.test(s), `${path.relative(root, f)} has no network call or polling`);
  }
});

test('autocomplete: columns after alias dot, tables and keywords otherwise', () => {
  const schema = [{ name: 'people', kind: 'table', schema: 'public', columns: [{ name: 'id', type: 'int4', pk: true }, { name: 'email', type: 'text' }] }, { name: 'orders', kind: 'table', schema: 'public', columns: [{ name: 'person_id', type: 'int4' }] }];
  const cols = completionItems({ schema, dialect: 'postgres', linePrefix: 'select p.', statement: 'select p. from people p join orders o on o.person_id = p.id' });
  assert.deepEqual(cols.map((c) => c.label), ['id', 'email']);
  const all = completionItems({ schema, dialect: 'mysql', linePrefix: 'select * from ', statement: 'select * from ' });
  assert.ok(all.some((c) => c.label === 'orders' && c.kind === 'table'));
  assert.ok(all.some((c) => c.label === 'ON DUPLICATE KEY UPDATE'));
  assert.equal(aliases('update people as pp set x=1').get('pp'), 'people');
});

test('schema compare text is sorted and stable; summary counts', () => {
  const a = [{ name: 'b', kind: 'table', columns: [{ name: 'id', type: 'int', pk: true, notNull: true }] }, { name: 'a', kind: 'table', columns: [{ name: 'x', type: 'text' }] }];
  const b = [{ name: 'a', kind: 'table', columns: [{ name: 'x', type: 'varchar' }] }, { name: 'c', kind: 'view', columns: [] }];
  const t = schemaText(a, [{ name: 'f', table: 'b', columns: ['id'], refTable: 'a', refColumns: ['x'] }], 'left');
  assert.ok(t.indexOf('TABLE a (') < t.indexOf('TABLE b ('));
  assert.match(t, /FOREIGN KEY \(id\) REFERENCES a \(x\)/);
  assert.deepEqual(schemaDiffSummary(a, b), { onlyA: 1, onlyB: 1, changed: 1 });
});

test('CSV import reader: quotes, newlines in quotes, BOM, separators', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zsql-'));
  try {
    const f = path.join(dir, 'a.csv');
    fs.writeFileSync(f, '﻿name,note\r\n"Ann ""A""","two\nlines"\r\nBo,\r\n');
    const recs = [];
    for await (const r of csvRecords(f, ',')) recs.push(r);
    assert.deepEqual(recs, [['name', 'note'], ['Ann "A"', 'two\nlines'], ['Bo', '']]);
    assert.equal(sniffSep('a;b;c'), ';');
    assert.equal(sniffSep('a\tb'), '\t');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
