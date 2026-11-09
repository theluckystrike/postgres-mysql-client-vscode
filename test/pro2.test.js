'use strict';
// Explain Plan and Table Data Compare (Zovo Pro, 0.2.0): parsers on plan output shaped like the real servers',
// hints, the static page, value canonical forms, key order, the merge compare and the sync script.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/pro2');

// PostgreSQL 16 EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) shape, trimmed.
const PG_ANALYZE = [{
  Plan: {
    'Node Type': 'Sort', 'Startup Cost': 2000.5, 'Total Cost': 2010.2, 'Plan Rows': 100, 'Actual Total Time': 120.0, 'Actual Rows': 30000, 'Actual Loops': 1,
    'Sort Key': ['p.email'], 'Sort Method': 'external merge', 'Sort Space Used': 4200, 'Sort Space Type': 'Disk',
    Plans: [{
      'Node Type': 'Hash Join', 'Join Type': 'Inner', 'Total Cost': 1800.1, 'Plan Rows': 100, 'Actual Total Time': 90.0, 'Actual Rows': 30000, 'Actual Loops': 1, 'Hash Cond': '(o.person_id = p.id)',
      Plans: [
        { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Schema: 'public', Alias: 'o', 'Total Cost': 1500, 'Plan Rows': 150, 'Actual Total Time': 70.0, 'Actual Rows': 30000, 'Actual Loops': 1, Filter: "(status = 'open'::text)", 'Rows Removed by Filter': 470000 },
        { 'Node Type': 'Hash', 'Total Cost': 20, 'Plan Rows': 50, 'Actual Total Time': 0.2, 'Actual Rows': 50, 'Actual Loops': 1, Plans: [
          { 'Node Type': 'Index Scan', 'Relation Name': 'people', Schema: 'public', Alias: 'p', 'Index Name': 'people_pkey', 'Total Cost': 18, 'Plan Rows': 50, 'Actual Total Time': 0.1, 'Actual Rows': 50, 'Actual Loops': 1 },
        ] },
      ],
    }],
  },
  'Planning Time': 0.42, 'Execution Time': 121.3,
}];

test('explainSql per dialect; analyze only changes what the user asked for', () => {
  assert.equal(P.explainSql('postgres', 'select 1;', false), 'EXPLAIN (FORMAT JSON) select 1');
  assert.equal(P.explainSql('postgres', 'select 1', true), 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select 1');
  assert.equal(P.explainSql('mysql', 'select 1', false), 'EXPLAIN FORMAT=JSON select 1');
  assert.equal(P.explainSql('mysql', 'select 1', true), 'EXPLAIN ANALYZE select 1');
  assert.equal(P.explainSql('sqlite', 'select 1 ;  ', false), 'EXPLAIN QUERY PLAN select 1');
});

test('PostgreSQL ANALYZE plan: tree, self time, slowest step, hints for the seq scan, disk sort and the row estimate', () => {
  const plan = P.parsePlan('postgres', true, [[JSON.stringify(PG_ANALYZE)]]);
  assert.equal(plan.analyzed, true);
  assert.equal(plan.executionMs, 121.3);
  assert.deepEqual(plan.nodes.map((n) => [n.op, n.depth]), [['Sort', 0], ['Hash Join (Inner)', 1], ['Seq Scan', 2], ['Hash', 2], ['Index Scan', 3]]);
  const seq = plan.nodes[2];
  assert.equal(seq.object, 'public.orders as o');
  assert.equal(seq.selfMs, 70);
  assert.equal(plan.nodes[0].selfMs, 30);
  assert.equal(plan.slowest, seq);
  assert.ok(seq.slowest);
  const text = plan.hints.map((h) => h.text).join('\n');
  assert.match(text, /Seq Scan on public\.orders as o reads the whole table and filters it \(\(status = 'open'::text\), 470,000 rows removed\)/);
  assert.match(text, /spilled to disk \(external merge, 4200 kB\)/);
  assert.match(text, /expected 150 rows and got 30,000 \(199x off\)/);
  assert.equal(plan.hints.filter((h) => /expected/.test(h.text)).length, 1, 'only on the scan, not on every parent');
  assert.equal(seq.flag, 'warn');
});

test('PostgreSQL estimate plan (no ANALYZE): cost bars, no row-estimate hints', () => {
  const est = JSON.parse(JSON.stringify(PG_ANALYZE));
  const strip = (p) => { for (const k of Object.keys(p)) if (/^Actual|Sort Space|Rows Removed/.test(k)) delete p[k]; (p.Plans || []).forEach(strip); };
  strip(est[0].Plan);
  delete est[0]['Execution Time'];
  const plan = P.parsePlan('postgres', false, [[est]]);
  assert.equal(plan.analyzed, false);
  assert.equal(plan.nodes[0].costShare, 1);
  assert.ok(plan.nodes[2].costShare > 0.7);
  assert.ok(!plan.hints.some((h) => /expected/.test(h.text)));
  assert.ok(plan.hints.some((h) => /reads the whole table and filters it/.test(h.text)));
});

test('MySQL / MariaDB FORMAT=JSON: nested loop with a full scan and filesort', () => {
  const json = { query_block: { select_id: 1, cost_info: { query_cost: '1041.25' }, ordering_operation: { using_filesort: true, nested_loop: [
    { table: { table_name: 'o', access_type: 'ALL', possible_keys: null, rows_examined_per_scan: 10000, filtered: '10.00', attached_condition: "(`o`.`status` = 'open')", cost_info: { prefix_cost: '1015.00' } } },
    { table: { table_name: 'p', access_type: 'eq_ref', possible_keys: ['PRIMARY'], key: 'PRIMARY', used_key_parts: ['id'], rows_examined_per_scan: 1, cost_info: { prefix_cost: '1041.25' } } },
  ] } } };
  const plan = P.parsePlan('mysql', false, [[JSON.stringify(json)]]);
  assert.deepEqual(plan.nodes.map((n) => n.op), ['Query', 'Sort (ORDER BY)', 'Nested loop', 'Full table scan', 'Unique index lookup']);
  const scan = plan.nodes[3];
  assert.equal(scan.object, 'o');
  assert.ok(scan.details.some(([k, v]) => k === 'Condition' && /open/.test(v)));
  const text = plan.hints.map((h) => h.text).join('\n');
  assert.match(text, /Full table scan on o: no index is used/);
  assert.match(text, /sorted after reading/);
  assert.equal(plan.root.cost, 1041.25);
});

test('MySQL 8 EXPLAIN ANALYZE text tree: depth from indentation, actual time x loops, table scan flagged', () => {
  const tree = [
    '-> Sort: p.email  (actual time=12.1..12.5 rows=300 loops=1)',
    '    -> Nested loop inner join  (cost=1050 rows=1000) (actual time=0.2..11.0 rows=300 loops=1)',
    '        -> Table scan on o  (cost=1010 rows=10000) (actual time=0.1..9.0 rows=10000 loops=1)',
    '        -> Single-row index lookup on p using PRIMARY (id=o.person_id)  (cost=0.25 rows=1) (actual time=0.001..0.001 rows=1 loops=300)',
  ].join('\n');
  const plan = P.parsePlan('mysql', true, [[tree]]);
  assert.equal(plan.analyzed, true);
  assert.deepEqual(plan.nodes.map((n) => n.depth), [0, 1, 2, 2]);
  assert.equal(plan.nodes[2].op, 'Table scan on o');
  assert.equal(plan.nodes[3].loops, 300);
  assert.ok(Math.abs(plan.nodes[3].totalMs - 0.3) < 1e-9);
  assert.ok(plan.hints.some((h) => /Table scan on o: no index is used/.test(h.text)));
});

test('SQLite EXPLAIN QUERY PLAN rows: parent links, SCAN without index flagged, temp b-tree sort noted', () => {
  const rows = [[2, 0, 0, 'SCAN o'], [5, 0, 0, 'SEARCH p USING INTEGER PRIMARY KEY (rowid=?)'], [9, 0, 0, 'USE TEMP B-TREE FOR ORDER BY'], [12, 0, 0, 'SCAN t USING COVERING INDEX t_idx']];
  const plan = P.parsePlan('sqlite', false, rows);
  assert.equal(plan.root.op, 'Query');
  assert.equal(plan.nodes.length, 5);
  const text = plan.hints.map((h) => h.text).join('\n');
  assert.match(text, /SCAN o: no index is used/);
  assert.doesNotMatch(text, /SCAN t USING COVERING INDEX t_idx: no index/);
  assert.match(text, /USE TEMP B-TREE FOR ORDER BY: the rows are sorted after reading/);
});

test('plan page: static (no script), escaped, CSP without network, hints and the raw plan', () => {
  const plan = P.parsePlan('postgres', true, [[JSON.stringify(PG_ANALYZE)]]);
  const html = P.planHtml({ plan, sql: "select * from orders where status = 'open' <script>", title: 'Explain Analyze · local <pg>', dialect: 'PostgreSQL', cspSource: 'vscode-webview://x', analyzed: true, rawText: '[{"Plan":1}]' });
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /content="default-src 'none'; style-src 'unsafe-inline'"/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /local &lt;pg&gt;/);
  assert.match(html, /slowest step/);
  assert.match(html, /Execution 121 ms · planning 0\.42 ms/);
  assert.match(html, /the query ran \(EXPLAIN ANALYZE\)/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('canonical values: numbers, booleans across servers, binary, JSON key order, NULL', () => {
  assert.equal(P.canon('1.500', 'numeric(10,3)'), '1.5');
  assert.equal(P.canon(1.5, 'decimal(10,2)'), '1.5');
  assert.equal(P.canon('0010', 'int4'), '10');
  assert.equal(P.canon('-0.00', 'numeric'), '0');
  assert.equal(P.canon('t', 'boolean'), '1');
  assert.equal(P.canon(1, 'tinyint(1)'), '1');
  assert.equal(P.canon(Buffer.from([1, 255]), 'bytea'), 'x01ff');
  assert.equal(P.canon('{"b":1, "a":[2,{"d":1,"c":2}]}', 'jsonb'), P.canon('{"a":[2,{"c":2,"d":1}],"b":1}', 'json'));
  assert.equal(P.canon(null, 'text'), null);
  assert.equal(P.canon('00123', 'varchar(10)'), '00123', 'text keeps leading zeros');
  assert.equal(P.canonDecimal('1e3'), '1000');
});

test('key order matches COLLATE "C" / BINARY: code points, not UTF-16 units; numbers by value; ORDER BY terms', () => {
  assert.equal(P.cmpCodePoints('a', 'b'), -1);
  assert.equal(P.cmpCodePoints('～', '\u{1F600}'), -1, 'U+FF5E sorts before U+1F600 by code point');
  assert.equal('～' < '\u{1F600}', false, 'plain JS < gets this wrong');
  assert.equal(P.keyCompare(['10'], ['9'], ['int4']), 1);
  assert.equal(P.keyCompare(['10'], ['9'], ['text']), -1);
  assert.equal(P.keyCompare([null], ['1'], ['int']), -1);
  assert.equal(P.orderTerm('email', 'character varying(80)', 'postgres'), '"email" COLLATE "C"');
  assert.equal(P.orderTerm('email', 'varchar(80)', 'mysql'), 'CAST(`email` AS BINARY)');
  assert.equal(P.orderTerm('id', 'integer', 'postgres'), '"id"');
  assert.equal(P.compareSelect({ schema: 'public', table: 'people', columns: [{ name: 'id', type: 'integer' }, { name: 'email', type: 'text' }] }, ['id', 'email'], ['id'], 'postgres'),
    'SELECT "id", "email" FROM "public"."people" ORDER BY "id"');
});

/** A fake exportQuery: pushes rows in batches with back-pressure, like the drivers do. */
function fakeExport(rows, batch = 3, log = []) {
  return async (onBatch, shouldStop) => {
    for (let i = 0; i < rows.length; i += batch) {
      log.push(i);
      await onBatch([], rows.slice(i, i + batch));
      if (shouldStop()) break;
    }
  };
}

test('pullRows: pull reader over a push stream, one batch in flight, stop ends the producer', async () => {
  const log = [];
  const rows = Array.from({ length: 10 }, (_, i) => [i]);
  const r = P.pullRows(fakeExport(rows, 3, log));
  const got = [];
  for (let x = await r.next(); x; x = await r.next()) { got.push(x[0]); assert.ok(log.length <= Math.floor(got.length / 3) + 2, 'producer runs at most one batch ahead'); }
  assert.deepEqual(got, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const log2 = [];
  const r2 = P.pullRows(fakeExport(rows, 2, log2));
  await r2.next();
  await r2.stop();
  assert.ok(log2.length <= 2);
  const bad = P.pullRows(async () => { throw new Error('connection refused'); });
  await assert.rejects(bad.next(), /connection refused/);
});

test('compareRows: equal, changed, only in A, only in B; values canonical across dialects; then the sync script', async () => {
  const A = [[1, 'ann', '1.50', 't'], [2, 'bob', '2.00', 'f'], [4, 'dan', '4.00', 't'], [5, "o'neil", '5', 't']];
  const B = [[1, 'ann', 1.5, 1], [2, 'bobby', 2, 0], [3, 'cat', 3, 1], [5, "o'neil", 5, 0]];
  const a = P.tracked(P.pullRows(fakeExport(A, 2)));
  const b = P.tracked(P.pullRows(fakeExport(B, 3)));
  const columns = ['id', 'name', 'amount', 'active'];
  const res = await P.compareRows({ a, b, columns, keyCount: 1, types: ['integer', 'text', 'numeric(8,2)', 'boolean'] });
  assert.deepEqual([res.same, res.changed, res.onlyA, res.onlyB, res.rowsA, res.rowsB, res.outOfOrder], [1, 2, 1, 1, 4, 4, false]);
  const ch = res.diffs.filter((d) => d.kind === 'changed');
  assert.deepEqual(ch.map((d) => [d.row[0], d.cols]), [[2, [1]], [5, [3]]]);
  const sql = P.syncScript({ res, columns, keyCount: 1, target: { schema: 'shop', table: 'people' }, dialect: 'mysql', labelA: 'pg · people', labelB: 'maria · people' });
  const lines = sql.split('\n');
  assert.ok(lines.includes('START TRANSACTION;') && lines.includes('COMMIT;'));
  assert.ok(lines.indexOf('DELETE FROM `shop`.`people` WHERE `id` = 3;') < lines.indexOf("UPDATE `shop`.`people` SET `name` = 'bob' WHERE `id` = 2;"));
  assert.ok(lines.includes("UPDATE `shop`.`people` SET `active` = 't' WHERE `id` = 5;"));
  assert.ok(lines.includes("INSERT INTO `shop`.`people` (`id`, `name`, `amount`, `active`) VALUES (4, 'dan', '4.00', 't');"));
  assert.ok(lines.some((l) => /1 row only in pg · people \(INSERT\), 1 only in maria · people \(DELETE\), 2 changed \(UPDATE\), 1 equal/.test(l)));
  const pgSql = P.syncScript({ res, columns, keyCount: 1, target: { schema: 'public', table: 'people' }, dialect: 'postgres', labelA: 'a', labelB: 'b' });
  assert.match(pgSql, /^BEGIN;$/m);
  assert.match(pgSql, /INSERT INTO "public"\."people" \("id", "name", "amount", "active"\) VALUES \(4, 'dan', '4\.00', 't'\);/);
  const md = P.compareReport({ res, columns, keyCount: 1, labelA: 'A', labelB: 'B' });
  assert.match(md, /\| Changed \| 2 \|/);
  assert.match(md, /\| 2 \| name \| bob \| bobby \|/);
  assert.match(md, /## Only in B \(first 1\)/);
});

test('compareRows: composite keys, NULL in a value, out-of-order keys stop the compare, the diff cap', async () => {
  const A = [[1, 'a', null], [1, 'b', 'x'], [2, 'a', 'y']];
  const B = [[1, 'a', 'z'], [1, 'b', 'x'], [2, 'a', 'y']];
  const res = await P.compareRows({ a: P.tracked(P.pullRows(fakeExport(A))), b: P.tracked(P.pullRows(fakeExport(B))), columns: ['k1', 'k2', 'v'], keyCount: 2, types: ['int', 'text', 'text'] });
  assert.deepEqual([res.same, res.changed], [2, 1]);
  const sql = P.syncScript({ res, columns: ['k1', 'k2', 'v'], keyCount: 2, target: { schema: '', table: 't' }, dialect: 'sqlite', labelA: 'a', labelB: 'b' });
  assert.match(sql, /UPDATE "t" SET "v" = NULL WHERE "k1" = 1 AND "k2" = 'a';/);
  const bad = await P.compareRows({ a: P.tracked(P.pullRows(fakeExport([[2], [1]]))), b: P.tracked(P.pullRows(fakeExport([[1], [2]]))), columns: ['id'], keyCount: 1, types: ['int'] });
  assert.equal(bad.outOfOrder, true);
  const many = Array.from({ length: 50 }, (_, i) => [i]);
  const capped = await P.compareRows({ a: P.tracked(P.pullRows(fakeExport(many, 7))), b: P.tracked(P.pullRows(fakeExport([], 7))), columns: ['id'], keyCount: 1, types: ['int'], maxDiffs: 10 });
  assert.deepEqual([capped.onlyA, capped.diffs.length, capped.capped], [50, 10, true]);
  assert.match(P.syncScript({ res: capped, columns: ['id'], keyCount: 1, target: { table: 't' }, dialect: 'postgres', labelA: 'a', labelB: 'b' }), /Only the first 10 differences/);
});
