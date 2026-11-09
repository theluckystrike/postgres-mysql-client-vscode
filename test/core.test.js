'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitStatements, statementAt, isUnboundedWrite, isReadOnlyStatement, isWrappable, firstKeyword } = require('../src/core/sqlsplit');
const { parseUrl, validate, displayUrl, tlsOptions } = require('../src/core/connstr');
const { quoteIdent, quoteLiteral, editStatements, wrapQuery, insertLine } = require('../src/core/dialect');
const { gridCell, csvLine, jsonValue, toText } = require('../src/core/values');
const { wkbToWkt } = require('../src/core/drivers/wkb');
const { friendlyError } = require('../src/core/drivers/errors');

test('split keeps semicolons inside strings, comments, identifiers and dollar quotes', () => {
  const sql = `select ';' as a; -- c;omment\nselect "x;y" from t; /* ; */ select $$a;b$$; select $f$ ; $f$;`;
  const s = splitStatements(sql, 'postgres').map((x) => x.text);
  assert.deepEqual(s, ["select ';' as a", '-- c;omment\nselect "x;y" from t', "/* ; */ select $$a;b$$", 'select $f$ ; $f$']);
});

test('split handles MySQL backslash escapes, backticks, # comments and DELIMITER', () => {
  const sql = "select 'it\\'s; ok' from `a;b`; # x;y\nselect 2;\nDELIMITER //\ncreate procedure p() begin select 1; select 2; end//\nDELIMITER ;\nselect 3;";
  const s = splitStatements(sql, 'mysql').map((x) => x.text);
  assert.equal(s[0], "select 'it\\'s; ok' from `a;b`");
  assert.equal(s[1], '# x;y\nselect 2');
  assert.equal(s[2], 'create procedure p() begin select 1; select 2; end');
  assert.equal(s[3], 'select 3');
});

test('split drops comment-only parts and gives exact offsets', () => {
  const sql = '  select 1 ;\n-- only a comment\n;  select 2';
  const s = splitStatements(sql, 'postgres');
  assert.equal(s.length, 2);
  assert.equal(sql.slice(s[1].start, s[1].end), 'select 2');
});

test('statementAt finds the statement at the cursor or just before it', () => {
  const sql = 'select 1;\nselect 2;\n\nselect 3';
  assert.equal(statementAt(sql, 3, 'postgres').text, 'select 1');
  assert.equal(statementAt(sql, sql.indexOf('2') + 2, 'postgres').text, 'select 2');
  assert.equal(statementAt(sql, sql.length, 'postgres').text, 'select 3');
});

test('unbounded writes are detected, WHERE in a string does not count', () => {
  assert.equal(isUnboundedWrite('UPDATE t SET a = 1', 'postgres'), true);
  assert.equal(isUnboundedWrite("update t set a = 'where'", 'postgres'), true);
  assert.equal(isUnboundedWrite('delete from t where id = 1', 'mysql'), false);
  assert.equal(isUnboundedWrite('DELETE FROM t', 'mysql'), true);
  assert.equal(isUnboundedWrite('truncate t', 'postgres'), true);
  assert.equal(isUnboundedWrite('with x as (select 1) delete from t', 'postgres'), true);
  assert.equal(isUnboundedWrite('select * from t', 'postgres'), false);
});

test('read-only and wrappable statements', () => {
  assert.equal(isReadOnlyStatement('  (select 1)', 'postgres'), true);
  assert.equal(isReadOnlyStatement('with a as (delete from t returning *) select * from a', 'postgres'), false);
  assert.equal(isReadOnlyStatement('PRAGMA journal_mode = wal', 'sqlite'), false);
  assert.equal(isWrappable('select * from t for update', 'postgres'), false);
  assert.equal(isWrappable('select * into t2 from t', 'postgres'), false);
  assert.equal(isWrappable('select * from big', 'mysql'), true);
  assert.equal(isWrappable('show tables', 'mysql'), false);
  assert.equal(firstKeyword('/* hi */ -- x\n  Select 1', 'postgres'), 'SELECT');
});

test('connection URLs: postgres, mysql, sqlite, ssl modes, IPv6, encoded password', () => {
  assert.deepEqual(parseUrl('postgres://bob:p%40ss%3Aw@db.example.com:6543/shop?sslmode=verify-full'), { type: 'postgres', host: 'db.example.com', port: 6543, user: 'bob', password: 'p@ss:w', database: 'shop', sslMode: 'verify-full' });
  const m = parseUrl('mysql://root@[::1]/app?ssl-mode=REQUIRED');
  assert.equal(m.type, 'mysql'); assert.equal(m.host, '::1'); assert.equal(m.port, 3306); assert.equal(m.sslMode, 'require');
  assert.equal(parseUrl('postgresql://localhost').port, 5432);
  assert.deepEqual(parseUrl('sqlite:///tmp/a.db'), { type: 'sqlite', file: '/tmp/a.db' });
  assert.equal(parseUrl('/home/me/app.sqlite3').type, 'sqlite');
  assert.throws(() => parseUrl('mongodb://x'), /MongoDB is not supported/);
  assert.throws(() => parseUrl('postgres://h:99999/db'), /port/);
  assert.throws(() => parseUrl('hello'), /not a connection URL/);
});

test('validate and displayUrl never show a password', () => {
  assert.deepEqual(validate({ type: 'postgres', name: 'a', host: 'h', port: 5432 }), []);
  assert.ok(validate({ type: 'mysql', name: '', host: '', port: 0 }).length >= 3);
  const u = displayUrl({ type: 'postgres', host: 'h', port: 5432, user: 'u', database: 'd', sslMode: 'require', password: 'secret' });
  assert.equal(u, 'postgres://u@h:5432/d?sslmode=require');
  assert.ok(!u.includes('secret'));
  assert.equal(tlsOptions('disable'), null);
  assert.equal(tlsOptions('require').rejectUnauthorized, false);
  assert.equal(tlsOptions('verify-full', 'CA', 'db.example.com').rejectUnauthorized, true);
});

test('quoting of names and values per dialect', () => {
  assert.equal(quoteIdent('we"ird', 'postgres'), '"we""ird"');
  assert.equal(quoteIdent('we`ird', 'mysql'), '`we``ird`');
  assert.equal(quoteLiteral("O'Brien", 'postgres'), "'O''Brien'");
  assert.equal(quoteLiteral("a\\b'c\n", 'mysql'), "'a\\\\b\\'c\\n'");
  assert.equal(quoteLiteral(null, 'sqlite'), 'NULL');
  assert.equal(quoteLiteral(Buffer.from([1, 255]), 'postgres'), "'\\x01ff'::bytea");
  assert.equal(quoteLiteral(Buffer.from([1, 255]), 'mysql'), "X'01ff'");
  assert.equal(quoteLiteral('👩‍💻 مرحبا', 'postgres'), "'👩‍💻 مرحبا'");
  assert.throws(() => quoteLiteral('a\u0000b', 'postgres'), /zero byte/);
});

test('edit statements: update, delete and insert by primary key', () => {
  const st = editStatements({ schema: 'public', table: 'people' }, [
    { kind: 'update', key: { id: '7' }, set: { name: "Ann's", note: null } },
    { kind: 'delete', key: { id: '8', k2: null } },
    { kind: 'insert', values: { name: 'Bo' } },
    { kind: 'insert', values: {} },
  ], 'postgres');
  assert.deepEqual(st.map((x) => x.sql), [
    `UPDATE "public"."people" SET "name" = 'Ann''s', "note" = NULL WHERE "id" = '7'`,
    `DELETE FROM "public"."people" WHERE "id" = '8' AND "k2" IS NULL`,
    `INSERT INTO "public"."people" ("name") VALUES ('Bo')`,
    'INSERT INTO "public"."people" DEFAULT VALUES',
  ]);
  assert.ok(st.every((x) => x.expect === 1));
  const my = editStatements({ schema: 'shop', table: 't' }, [{ kind: 'insert', values: {} }], 'mysql');
  assert.equal(my[0].sql, 'INSERT INTO `shop`.`t` () VALUES ()');
});

test('server-side sort and filter wrap the query', () => {
  const w = wrapQuery('select * from big;', 'postgres', { col: 2, desc: true }, [{ name: 'label', text: '50%_x' }]);
  assert.equal(w, `SELECT * FROM (\nselect * from big\n) AS zovo_q\nWHERE CAST(zovo_q."label" AS TEXT) ILIKE '%50\\%\\_x%'\nORDER BY 2 DESC NULLS LAST`);
  assert.match(wrapQuery('select 1', 'mysql', { col: 1, desc: false }, []), /ORDER BY 1 ASC$/);
  assert.match(wrapQuery('select a from t', 'mysql', null, [{ name: 'a', text: 'x' }]), /CAST\(zovo_q\.`a` AS CHAR\) LIKE '%x%'/);
});

test('grid cells: NULL, numbers, long text stub, binary stub with kind', () => {
  assert.equal(gridCell(null), null);
  assert.equal(gridCell(5), 5);
  const long = gridCell('x'.repeat(10 * 1024 * 1024));
  assert.equal(long.t, 'long'); assert.equal(long.n, 10485760); assert.equal(long.s.length, 2000);
  const png = gridCell(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
  assert.equal(png.t, 'bin'); assert.equal(png.k, 'png'); assert.equal(png.n, 10);
  assert.equal(toText(new Uint8Array([1, 2])), '\\x0102');
});

test('CSV lines quote what needs quoting; JSON values keep types', () => {
  assert.equal(csvLine(['a', 'b,c', 'say "hi"', null, 'line\nbreak', '']), 'a,"b,c","say ""hi""",,"line\nbreak",""\r\n');
  assert.equal(jsonValue('42', 'number'), 42);
  assert.equal(jsonValue('12345678901234567890', 'number'), '12345678901234567890');
  assert.equal(jsonValue('t', 'bool'), true);
  assert.deepEqual(jsonValue('{"a":[1]}', 'json'), { a: [1] });
  assert.equal(jsonValue(Buffer.from('hi'), 'text'), 'aGk=');
  assert.equal(insertLine('t', ['a', 'b'], ['1', null], 'postgres'), `INSERT INTO "t" ("a", "b") VALUES ('1', NULL);\n`);
});

test('MySQL geometry WKB becomes WKT', () => {
  const b = Buffer.alloc(4 + 21);
  b.writeUInt32LE(4326, 0); b[4] = 1; b.writeUInt32LE(1, 5); b.writeDoubleLE(1.5, 9); b.writeDoubleLE(-2, 17);
  assert.equal(wkbToWkt(b, true), 'SRID=4326;POINT(1.5 -2)');
});

test('driver errors become clear sentences without passwords', () => {
  const cfg = { host: 'db', port: 5432, user: 'bob' };
  assert.match(friendlyError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), cfg).message, /refused.*running/);
  assert.match(friendlyError(Object.assign(new Error('password authentication failed for user "bob"'), { code: '28P01' }), cfg).message, /user name or password for "bob"/);
  assert.match(friendlyError(Object.assign(new Error('no pg_hba.conf entry for host "1.2.3.4", user "x", database "y", no encryption'), { code: '28000' }), cfg).message, /SSL mode to "require"/);
  const pos = friendlyError(Object.assign(new Error('syntax error at or near "selec"'), { code: '42601', position: '5' }), cfg, 'postgres', 'x');
  assert.equal(pos.position, 4);
  const my = friendlyError(Object.assign(new Error("You have an error in your SQL syntax; ... near 'frm t' at line 2"), { code: 'ER_PARSE_ERROR' }), cfg, 'mysql', 'select *\nfrm t');
  assert.equal(my.line, 1); assert.equal(my.position, 9);
});
