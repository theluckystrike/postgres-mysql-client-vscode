'use strict';
// Explain Plan and Table Data Compare against the real local servers (skipped unless ZOVO_SQL_IT=1).
// Same servers as integration.test.js: PostgreSQL 16 on 127.0.0.1:55432, MariaDB on 127.0.0.1:53306, SQLite file.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { PgSession } = require('../src/core/drivers/pg');
const { MySqlSession } = require('../src/core/drivers/mysql');
const { SqliteSession } = require('../src/core/drivers/sqlite');
const { splitStatements } = require('../src/core/sqlsplit');
const P = require('../src/pro2');

const IT = process.env.ZOVO_SQL_IT === '1';
const SQLITE = process.env.ZOVO_SQL_SQLITE || path.join(os.homedir(), 'zovo-sql-client-work', 'sqlite', 'shop.sqlite');
const WASM = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const opts = { skip: !IT && 'set ZOVO_SQL_IT=1 with the local test servers running' };
const pg = () => new PgSession({ host: '127.0.0.1', port: 55432, user: 'zovo', database: 'zovotest', sslMode: 'disable' }, 'zovopass');
const my = () => new MySqlSession({ host: '127.0.0.1', port: 53306, user: 'zovo', database: 'zovotest', sslMode: 'disable' }, 'zovopass');

async function explainRows(s, dialect, sql, analyze) {
  const r = await s.run(P.explainSql(dialect, sql, analyze), 100000);
  const rows = r.rows.slice();
  if (r.close) await r.close();
  return rows;
}

async function compare(A, B, opts2 = {}) {
  const [colsA, colsB] = await Promise.all([A.s.columns(A.schema, A.table), B.s.columns(B.schema, B.table)]);
  const key = colsA.filter((c) => c.pk).map((c) => c.name);
  const columns = key.concat(colsA.map((c) => c.name).filter((n) => !key.includes(n) && colsB.some((b) => b.name === n)));
  const types = columns.map((n) => colsA.find((c) => c.name === n).type);
  const sqlA = P.compareSelect({ schema: A.schema, table: A.table, columns: colsA }, columns, key, A.dialect);
  const sqlB = P.compareSelect({ schema: B.schema, table: B.table, columns: colsB }, columns, key, B.dialect);
  const a = P.tracked(P.pullRows((onBatch, stop) => A.s.exportQuery(sqlA, onBatch, stop, 2000)));
  const b = P.tracked(P.pullRows((onBatch, stop) => B.s.exportQuery(sqlB, onBatch, stop, 2000)));
  let peak = process.memoryUsage().rss;
  const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  try {
    const res = await P.compareRows({ a, b, columns, keyCount: key.length, types, maxDiffs: opts2.maxDiffs });
    return { res, columns, key, peak };
  } finally { clearInterval(t); await Promise.all([a.stop(), b.stop()]); }
}

async function runScript(s, dialect, script) {
  for (const st of splitStatements(script, dialect)) { const r = await s.run(st.text, 10); if (r.close) await r.close(); }
}

test('postgres: Explain estimate and Explain Analyze on a join; the filtered seq scan is found', opts, async () => {
  const s = pg();
  try {
    const sql = "select p.name, sum(o.amount) from orders o join people p on p.id = o.person_id where o.status = 'paid' group by p.name order by 2 desc";
    const est = P.parsePlan('postgres', false, await explainRows(s, 'postgres', sql, false));
    assert.equal(est.analyzed, false);
    assert.ok(est.nodes.length >= 3);
    assert.ok(est.root.cost > 0);
    const an = P.parsePlan('postgres', true, await explainRows(s, 'postgres', sql, true));
    assert.equal(an.analyzed, true);
    assert.ok(an.executionMs > 0);
    assert.ok(an.nodes.some((n) => /Seq Scan/.test(n.op) && /orders/.test(n.object)));
    const big = P.parsePlan('postgres', true, await explainRows(s, 'postgres', "select count(*) from big where label = 'row-7'", true));
    assert.ok(big.hints.some((h) => /reads the whole table and filters it/.test(h.text)), JSON.stringify(big.hints));
    const html = P.planHtml({ plan: big, sql: 'x', title: 't', dialect: 'PostgreSQL', cspSource: '', analyzed: true, rawText: '' });
    assert.match(html, /Seq Scan|Parallel Seq Scan/);
  } finally { await s.close(); }
});

test('mariadb: Explain FORMAT=JSON on a join, full scan hint; ANALYZE gives a readable error or a plan', opts, async () => {
  const s = my();
  try {
    const sql = "select p.name, sum(o.amount) from orders o join people p on p.id = o.person_id where o.status = 'paid' group by p.name order by 2 desc";
    const est = P.parsePlan('mysql', false, await explainRows(s, 'mysql', sql, false));
    assert.ok(est.nodes.some((n) => n.object === 'o' || n.object === 'orders'), JSON.stringify(est.nodes.map((n) => [n.op, n.object])));
    assert.ok(est.hints.some((h) => /no index is used/.test(h.text)), JSON.stringify(est.hints));
    // MariaDB has no EXPLAIN ANALYZE (it has ANALYZE ...). The extension shows the server's error; it must not hang.
    await assert.rejects(explainRows(s, 'mysql', 'select count(*) from people', true), /syntax/i);
    const r = await s.run(P.mariaAnalyzeSql(sql), 1000);
    const an = P.parsePlan('mysql', true, r.rows);
    if (r.close) await r.close();
    assert.equal(an.analyzed, true);
    assert.ok(an.nodes.some((n) => n.actualRows !== null), JSON.stringify(an.nodes.map((n) => [n.op, n.actualRows])));
  } finally { await s.close(); }
});

test('sqlite: Explain Query Plan on the shop file', opts, async () => {
  const s = new SqliteSession({ file: SQLITE, wasmPath: WASM, maxFileSizeMB: 512 });
  try {
    const tables = await s.tables();
    const t = tables.find((x) => x.kind === 'table');
    const plan = P.parsePlan('sqlite', false, await explainRows(s, 'sqlite', `select * from "${t.name}" order by 1 desc`, false));
    assert.ok(plan.nodes.length >= 1);
  } finally { await s.close(); }
});

test('data compare across servers: PostgreSQL people vs MariaDB people, then the sync script makes them equal', opts, async () => {
  const p = pg(); const m = my();
  try {
    for (const st of ['DROP TABLE IF EXISTS cmp_people', 'CREATE TABLE cmp_people AS SELECT * FROM people', 'ALTER TABLE cmp_people ADD PRIMARY KEY (id)']) { const r = await m.run(st, 1); if (r.close) await r.close(); }
    for (const st of ["UPDATE cmp_people SET name = 'Changed' WHERE id = 3", 'DELETE FROM cmp_people WHERE id = 7', "INSERT INTO cmp_people (id, name, email, age, note) VALUES (999, 'Extra 👩‍💻', 'x@example.test', 40, NULL)", 'UPDATE cmp_people SET note = NULL WHERE id = 13']) { const r = await m.run(st, 1); if (r.close) await r.close(); }
    const A = { s: p, schema: 'public', table: 'people', dialect: 'postgres' };
    const B = { s: m, schema: 'zovotest', table: 'cmp_people', dialect: 'mysql' };
    const first = await compare(A, B);
    assert.deepEqual([first.res.onlyA, first.res.onlyB, first.res.changed, first.res.outOfOrder], [1, 1, 2, false], JSON.stringify(first.res.diffs.slice(0, 5)));
    assert.equal(first.res.same, 47);
    const script = P.syncScript({ res: first.res, columns: first.columns, keyCount: first.key.length, target: { schema: 'zovotest', table: 'cmp_people' }, dialect: 'mysql', labelA: 'pg', labelB: 'maria' });
    await runScript(m, 'mysql', script);
    const again = await compare(A, B);
    assert.deepEqual([again.res.onlyA, again.res.onlyB, again.res.changed, again.res.same], [0, 0, 0, 50], JSON.stringify(again.res.diffs.slice(0, 3)));
  } finally {
    try { const r = await m.run('DROP TABLE IF EXISTS cmp_people', 1); if (r.close) await r.close(); } catch { /* cleanup */ }
    await p.close(); await m.close();
  }
});

test('data compare with text keys across servers sorts the same way (code point order, unicode keys)', opts, async () => {
  const p = pg(); const m = my();
  const keys = ['a', 'B', 'Z', 'b', 'é', 'Ñ', 'ｚ', '😀', 'zz', 'Zoë', 'سارة', '10', '9'];
  try {
    for (const st of ['DROP TABLE IF EXISTS cmp_keys', 'CREATE TABLE cmp_keys (k text PRIMARY KEY, v int)', `INSERT INTO cmp_keys VALUES ${keys.map((k, i) => `('${k}', ${i})`).join(', ')}`]) { const r = await p.run(st, 1); if (r.close) await r.close(); }
    for (const st of ['DROP TABLE IF EXISTS cmp_keys', 'CREATE TABLE cmp_keys (k varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY, v int)', `INSERT INTO cmp_keys VALUES ${keys.filter((k) => k !== 'b' && k !== 'Ñ').map((k, i) => `('${k}', ${i})`).join(', ')}`]) {
      try { const r = await m.run(st, 1); if (r.close) await r.close(); } catch (e) { if (/Duplicate/.test(e.message)) continue; throw e; }
    }
    const res = (await compare({ s: p, schema: 'public', table: 'cmp_keys', dialect: 'postgres' }, { s: m, schema: 'zovotest', table: 'cmp_keys', dialect: 'mysql' })).res;
    assert.equal(res.outOfOrder, false);
    assert.ok(res.onlyA >= 2, JSON.stringify(res));
  } finally {
    try { const r = await p.run('DROP TABLE IF EXISTS cmp_keys', 1); if (r.close) await r.close(); } catch { /* cleanup */ }
    try { const r = await m.run('DROP TABLE IF EXISTS cmp_keys', 1); if (r.close) await r.close(); } catch { /* cleanup */ }
    await p.close(); await m.close();
  }
});

test('data compare at scale: 5,000,000 rows PostgreSQL big vs MariaDB big, streamed, memory stays flat', { ...opts, timeout: 900000 }, async () => {
  const p = pg(); const m = my();
  try {
    const t0 = Date.now();
    const before = process.memoryUsage().rss;
    const { res, peak } = await compare({ s: p, schema: 'public', table: 'big', dialect: 'postgres' }, { s: m, schema: 'zovotest', table: 'big', dialect: 'mysql' }, { maxDiffs: 1000 });
    const ms = Date.now() - t0;
    console.log(`# big compare: ${res.rowsA} vs ${res.rowsB} rows, same ${res.same}, changed ${res.changed}, onlyA ${res.onlyA}, onlyB ${res.onlyB}, ${ms} ms, rss +${Math.round((peak - before) / 1048576)} MB`);
    assert.equal(res.rowsA, 5000000);
    assert.equal(res.outOfOrder, false);
    // The test data really differs: MariaDB filled its TIMESTAMP column in the +07 session time zone, so only
    // created_at differs (by 7 hours) and every row counts as changed.
    assert.equal(res.same + res.changed, 5000000);
    assert.ok(res.diffs.every((d) => d.kind === 'changed' && d.cols.length === 1 && d.cols[0] === 3), JSON.stringify(res.diffs[0]));
    assert.ok(peak - before < 300 * 1048576, `rss grew ${Math.round((peak - before) / 1048576)} MB`);
  } finally { await p.close(); await m.close(); }
});
