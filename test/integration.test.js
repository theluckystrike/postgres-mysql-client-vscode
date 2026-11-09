'use strict';
// Integration tests against real local servers. Skipped unless ZOVO_SQL_IT=1.
// Servers (lane DBUILD1 setup, ~/zovo-sql-client-work/SETUP.md): PostgreSQL 16 on 127.0.0.1:55432,
// MariaDB on 127.0.0.1:53306, both with the database zovotest; SQLite file in ZOVO_SQL_SQLITE.
// Large exports go to ZOVO_SQL_WORK (not the temp folder) and are deleted at the end of each test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PgSession } = require('../src/core/drivers/pg');
const { MySqlSession } = require('../src/core/drivers/mysql');
const { SqliteSession } = require('../src/core/drivers/sqlite');
const { exportToFile } = require('../src/export');
const { editStatements, wrapQuery } = require('../src/core/dialect');
const { importCsv } = require('../src/pro');

const IT = process.env.ZOVO_SQL_IT === '1';
const WORK = process.env.ZOVO_SQL_WORK || path.join(os.homedir(), 'zovo-sql-client-work', 'it');
const SQLITE = process.env.ZOVO_SQL_SQLITE || path.join(os.homedir(), 'zovo-sql-client-work', 'sqlite', 'shop.sqlite');
const WASM = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const PG = { host: '127.0.0.1', port: 55432, user: 'zovo', database: 'zovotest', sslMode: 'disable' };
const MY = { host: '127.0.0.1', port: 53306, user: 'zovo', database: 'zovotest', sslMode: 'disable' };
const opts = { skip: !IT && 'set ZOVO_SQL_IT=1 with the local test servers running' };

const pg = () => new PgSession({ ...PG }, 'zovopass');
const my = () => new MySqlSession({ ...MY }, 'zovopass');

function lines(file) {
  return new Promise((resolve) => {
    let n = 0;
    fs.createReadStream(file).on('data', (b) => { for (const x of b) if (x === 10) n++; }).on('end', () => resolve(n));
  });
}

async function peakRss(fn) {
  let peak = process.memoryUsage().rss;
  const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  try { const r = await fn(); return { r, peak }; } finally { clearInterval(t); }
}

for (const [name, make] of [['postgres', pg], ['mysql', my]]) {
  test(`${name}: first 1000 rows of 5M, Load more, close early, next query works`, opts, async () => {
    const s = make();
    try {
      const r = await s.run('select * from big order by id', 1000);
      assert.equal(r.rows.length, 1000);
      assert.equal(r.done, false);
      const more = await r.fetchMore(1000);
      assert.equal(more.length, 1000);
      assert.equal(String(more[0][0]), '1001');
      const t0 = Date.now();
      const r2 = await s.run('select count(*) from people', 10); // closes the open 5M result first
      assert.equal(String(r2.rows[0][0]), '50');
      assert.ok(Date.now() - t0 < 5000, `switching away from an open 5M result took ${Date.now() - t0} ms`);
    } finally { await s.close(); }
  });

  test(`${name}: server-side sort of 5M rows returns the top rows`, opts, async () => {
    const s = make();
    try {
      const r = await s.run(wrapQuery('select id, n from big', name, { col: 1, desc: true }, []), 5);
      assert.equal(String(r.rows[0][0]), '5000000');
      const f = await s.run(wrapQuery('select id, label from big where id <= 2000', name, null, [{ name: 'label', text: 'row-199' }]), 100);
      assert.ok(f.rows.length >= 1 && f.rows.every((x) => String(x[1]).includes('row-199')));
    } finally { await s.close(); }
  });

  test(`${name}: Cancel stops a 60 s query within seconds`, opts, async () => {
    const s = make();
    try {
      await s.open();
      const t0 = Date.now();
      const p = s.run(name === 'postgres' ? 'select pg_sleep(60)' : 'select sleep(60)', 10);
      await new Promise((r) => setTimeout(r, 800));
      await s.cancel();
      if (name === 'postgres') await assert.rejects(p, /cancel/i);
      else {
        // MySQL SLEEP() returns 1 when it is interrupted by KILL QUERY instead of failing.
        const r = await p.catch((e) => e);
        assert.ok(r instanceof Error ? /cancel|interrupt/i.test(r.message) : String(r.rows[0][0]) === '1');
      }
      assert.ok(Date.now() - t0 < 5000, `cancel took ${Date.now() - t0} ms`);
      const after = await s.run('select 1', 1);
      assert.equal(String(after.rows[0][0]), '1');
    } finally { await s.close(); }
  });

  test(`${name}: wrong password and refused port give clear messages fast`, opts, async () => {
    const cfg = name === 'postgres' ? PG : MY;
    const Session = name === 'postgres' ? PgSession : MySqlSession;
    const bad = new Session({ ...cfg }, 'not-the-password');
    await assert.rejects(bad.open(), /refused the user name or password/);
    await bad.close();
    const t0 = Date.now();
    const off = new Session({ ...cfg, port: cfg.port + 7 }, 'x');
    await assert.rejects(off.open(), /connection was refused/);
    assert.ok(Date.now() - t0 < 3000);
    await off.close();
  });

  test(`${name}: edits run in one transaction and roll back when a key is gone`, opts, async () => {
    const s = make();
    try {
      const stamp = `it ${Date.now()} 👩‍💻 مرحبا`;
      const table = { schema: name === 'postgres' ? 'public' : 'zovotest', table: 'people' };
      await s.transaction(editStatements(table, [{ kind: 'update', key: { id: '1' }, set: { note: stamp } }], name));
      const r = await s.run('select note from people where id = 1', 1);
      assert.equal(r.rows[0][0], stamp);
      const before = (await s.run('select count(*) from people', 1)).rows[0][0];
      await assert.rejects(s.transaction(editStatements(table, [
        { kind: 'insert', values: { name: 'temp row', email: 'temp@example.com', age: '30' } },
        { kind: 'update', key: { id: '999999' }, set: { note: 'x' } },
      ], name)), /changed 0 rows instead of 1/);
      const after = (await s.run('select count(*) from people', 1)).rows[0][0];
      assert.equal(String(after), String(before), 'the insert was rolled back');
    } finally { await s.close(); }
  });

  test(`${name}: hostile values: 10 MB text, binary, JSON, emoji, RTL, NULL row`, opts, async () => {
    const s = make();
    try {
      const r = await s.run('select * from hostile order by id', 100);
      const col = (n) => r.columns.findIndex((c) => c.name === n);
      assert.equal(r.rows.length, 10);
      assert.equal(String(r.rows[1][col('big_text')]).length, 10485760);
      assert.ok(Buffer.isBuffer(r.rows[6][col('bin')]));
      assert.equal(r.rows[6][col('bin')][1], 0x50); // PNG
      assert.ok(r.rows[2].slice(1).every((v) => v === null), 'row 3 is NULL in every column except id');
      assert.ok(String(r.rows[3][col('note')]).includes('👩‍💻'));
      assert.ok(/[؀-ۿ]/.test(String(r.rows[4][col('note')])));
      JSON.parse(r.rows[0][col('doc')]);
      const t = await s.editTarget(r.columns);
      assert.deepEqual(t.pk, ['id']);
      assert.equal(t.editable[col('bin')], false);
      const v = await s.editTarget((await s.run('select * from v_people_adults', 1)).columns);
      assert.ok(!v.pk);
      const np = await s.editTarget((await s.run('select * from nopk', 10)).columns);
      assert.match(np.reason, /no primary key/);
      const j = await s.editTarget((await s.run('select p.id, o.id from people p join orders o on o.person_id = p.id', 1)).columns);
      assert.match(j.reason, /one table/);
    } finally { await s.close(); }
  });

  test(`${name}: export of 5,000,000 rows streams to CSV under 500 MB of memory`, { ...opts, timeout: 600000 }, async () => {
    fs.mkdirSync(WORK, { recursive: true });
    const file = path.join(WORK, `big-${name}.csv`);
    const s = make();
    try {
      const { r, peak } = await peakRss(() => exportToFile(s, 'select * from big', { format: 'csv', file, table: 'big', dialect: name }));
      assert.equal(r.rows, 5000000);
      assert.equal(await lines(file), 5000001);
      assert.ok(peak < 500 * 1048576, `peak RSS ${(peak / 1048576).toFixed(0)} MB`);
      console.log(`# ${name} export: ${r.rows} rows, ${(fs.statSync(file).size / 1048576).toFixed(0)} MB file, peak RSS ${(peak / 1048576).toFixed(0)} MB`);
    } finally {
      await s.close();
      fs.rmSync(file, { force: true });
    }
  });

  test(`${name}: JSON and SQL exports are valid`, opts, async () => {
    fs.mkdirSync(WORK, { recursive: true });
    const fj = path.join(WORK, `people-${name}.json`);
    const fs2 = path.join(WORK, `people-${name}.sql`);
    const s = make();
    try {
      await exportToFile(s, 'select * from people order by id', { format: 'json', file: fj, table: 'people', dialect: name });
      const arr = JSON.parse(fs.readFileSync(fj, 'utf8'));
      assert.equal(arr.length, 50);
      assert.equal(typeof arr[0].id, 'number');
      await exportToFile(s, 'select * from people order by id', { format: 'sql', file: fs2, table: 'people', dialect: name });
      assert.equal((await lines(fs2)), 50);
      assert.match(fs.readFileSync(fs2, 'utf8'), /^INSERT INTO/);
    } finally { await s.close(); fs.rmSync(fj, { force: true }); fs.rmSync(fs2, { force: true }); }
  });

  test(`${name}: a server that drops the connection mid-result gives a clear error, then reconnects`, opts, async () => {
    const s = make();
    const killer = make();
    try {
      await s.open();
      const r = await s.run('select * from big', 1000);
      assert.equal(r.done, false);
      if (name === 'postgres') await killer.run(`select pg_terminate_backend(${s.mainPid})`, 1);
      else await killer.run(`kill connection ${s.mainThread}`, 1);
      await new Promise((ok) => setTimeout(ok, 300));
      await assert.rejects(r.fetchMore(100000), /closed the connection|terminat|Connection|killed|lost/i);
      const again = await s.run('select 2', 1);
      assert.equal(String(again.rows[0][0]), '2');
    } finally { await s.close(); await killer.close(); }
  });

  test(`${name}: read-only connection blocks writes on the server`, opts, async () => {
    const Session = name === 'postgres' ? PgSession : MySqlSession;
    const s = new Session({ ...(name === 'postgres' ? PG : MY), readOnly: true }, 'zovopass');
    try {
      await assert.rejects(s.run("update people set note = 'x' where id = 1", 1), /read.only/i);
      const r = await s.run('select count(*) from people', 1);
      assert.equal(String(r.rows[0][0]), '50');
    } finally { await s.close(); }
  });
}

test('postgres: SSL required for ssl_only: refused without SSL, works with require', opts, async () => {
  const plain = new PgSession({ ...PG, user: 'ssl_only', sslMode: 'disable' }, 'sslpass');
  await assert.rejects(plain.open(), /needs an SSL connection|refused this connection/);
  await plain.close();
  const tls = new PgSession({ ...PG, user: 'ssl_only', sslMode: 'require' }, 'sslpass');
  const info = await tls.open();
  assert.equal(info.user, 'ssl_only');
  await tls.close();
  const verify = new PgSession({ ...PG, user: 'ssl_only', sslMode: 'verify-full' }, 'sslpass');
  await assert.rejects(verify.open(), /not trusted|certificate/);
  await verify.close();
});

test('postgres: 5,000 tables in one schema list in one query', opts, async () => {
  const s = pg();
  try {
    const t0 = Date.now();
    const t = await s.tables('many');
    assert.equal(t.length, 5000);
    assert.ok(Date.now() - t0 < 3000);
    const schemas = await s.schemas();
    assert.ok(schemas.some((x) => x.name === 'many' && x.count === 5000));
  } finally { await s.close(); }
});

test('postgres and mysql: Pagila and Sakila browse', opts, async () => {
  const p = new PgSession({ ...PG, database: 'pagila' }, 'zovopass');
  const m = new MySqlSession({ ...MY, database: 'sakila' }, 'zovopass');
  try {
    assert.ok((await p.databases()).includes('pagila'));
    const film = await p.run('select * from film order by film_id', 1000);
    assert.equal(film.rows.length, 1000);
    assert.ok((await p.foreignKeys('public')).length > 10);
    const sfilm = await m.run('select * from film order by film_id', 1000);
    assert.equal(sfilm.rows.length, 1000);
    assert.ok((await m.foreignKeys('sakila')).length > 10);
    const geo = await m.run('select id, pt, geom from zovotest.hostile where id = 1', 1);
    assert.match(String(geo.rows[0][1]), /^POINT\(/);
    assert.match(String(geo.rows[0][2]), /^POLYGON\(/);
  } finally { await p.close(); await m.close(); }
});

test('sqlite: query, edit with write-back, read-only refuses writes, CSV import', opts, async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const copy = path.join(WORK, 'shop-copy.sqlite');
  fs.copyFileSync(SQLITE, copy);
  try {
    const s = new SqliteSession({ file: copy, wasmPath: WASM, maxFileSizeMB: 512 });
    const r = await s.run('select * from orders', 1000);
    assert.equal(r.rows.length, 1000);
    assert.equal(r.done, false);
    const t = await s.editTarget(r.columns, 'select * from orders');
    assert.ok(t.pk && t.pk.length);
    await s.transaction(editStatements({ schema: '', table: 'people' }, [{ kind: 'update', key: { id: 1 }, set: { note: 'שלום 🚀' } }], 'sqlite'));
    await s.close();
    const again = new SqliteSession({ file: copy, wasmPath: WASM, readOnly: true });
    const n = await again.run('select note from people where id = 1', 1);
    assert.equal(n.rows[0][0], 'שלום 🚀');
    await assert.rejects(again.run("delete from people", 1), /read-only/);
    await again.close();
    const w = new SqliteSession({ file: copy, wasmPath: WASM });
    const csv = path.join(WORK, 'people.csv');
    fs.writeFileSync(csv, 'name,email,age,unknown_col\n"Imp, One",imp1@example.com,33,x\nImp Two,,,y\n');
    const res = await importCsv(w, csv, '', 'people');
    assert.equal(res.rows, 2);
    assert.deepEqual(res.skipped, ['unknown_col']);
    const c = await w.run("select count(*) from people where name like 'Imp%'", 1);
    assert.equal(c.rows[0][0], 2);
    await w.close();
    fs.rmSync(csv, { force: true });
  } finally { fs.rmSync(copy, { force: true }); }
});

test('sqlite: a file that is not SQLite gives a clear message', opts, async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const f = path.join(WORK, 'not.db');
  fs.writeFileSync(f, 'hello, I am text');
  try {
    const s = new SqliteSession({ file: f, wasmPath: WASM });
    await assert.rejects(s.open(), /not a SQLite database/);
  } finally { fs.rmSync(f, { force: true }); }
});
