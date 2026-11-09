'use strict';
// Zovo Pro tools added in 0.2.0: Explain Plan (a readable query plan with the slow steps marked and plain hints)
// and Table Data Compare (two tables, any two connections, matched by primary key, with a sync script).
// Pure functions only (no vscode), so the unit tests run them on real plan output and on fake row streams.

const { quoteIdent, qualified, quoteLiteral } = require('./core/dialect');
const { isBinary, toText } = require('./core/values');

// ---------------------------------------------------------------- Explain Plan

/** MariaDB has no EXPLAIN ANALYZE; it runs and measures with ANALYZE FORMAT=JSON. */
function mariaAnalyzeSql(sql) { return `ANALYZE FORMAT=JSON ${String(sql).trim().replace(/;\s*$/, '').trim()}`; }

/** The EXPLAIN statement for a dialect. analyze runs the query (only offered for read-only statements). */
function explainSql(dialect, sql, analyze) {
  const body = String(sql).trim().replace(/;\s*$/, '').trim();
  if (dialect === 'postgres') return `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, ' : ''}FORMAT JSON) ${body}`;
  if (dialect === 'mysql') return analyze ? `EXPLAIN ANALYZE ${body}` : `EXPLAIN FORMAT=JSON ${body}`;
  return `EXPLAIN QUERY PLAN ${body}`;
}

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Postgres EXPLAIN (FORMAT JSON) -> {root, planningMs, executionMs, analyzed}. */
function pgPlan(json) {
  const top = Array.isArray(json) ? json[0] : json;
  if (!top || !top.Plan) throw new Error('The server did not return a plan.');
  const analyzed = top.Plan['Actual Total Time'] !== undefined;
  const walk = (p) => {
    const loops = num(p['Actual Loops']) || 1;
    const kids = (p.Plans || []).map(walk);
    const total = analyzed ? (num(p['Actual Total Time']) || 0) * loops : null;
    const node = {
      op: p['Node Type'] + (p['Join Type'] && /Join|Loop/.test(p['Node Type']) ? ` (${p['Join Type']})` : ''),
      object: [p['Relation Name'] && (p.Schema ? `${p.Schema}.${p['Relation Name']}` : p['Relation Name']), p['Index Name'] && `index ${p['Index Name']}`, p.Alias && p.Alias !== p['Relation Name'] && `as ${p.Alias}`].filter(Boolean).join(' '),
      cost: num(p['Total Cost']),
      estRows: num(p['Plan Rows']),
      actualRows: analyzed ? (num(p['Actual Rows']) || 0) * loops : null,
      loops: analyzed ? loops : null,
      totalMs: total,
      details: [],
      children: kids,
      raw: p,
    };
    for (const k of ['Index Cond', 'Recheck Cond', 'Filter', 'Join Filter', 'Hash Cond', 'Merge Cond', 'Sort Key', 'Group Key', 'Sort Method', 'Rows Removed by Filter', 'Rows Removed by Join Filter', 'Sort Space Used', 'Sort Space Type', 'Workers Planned', 'Workers Launched']) {
      if (p[k] !== undefined) node.details.push([k, Array.isArray(p[k]) ? p[k].join(', ') : String(p[k])]);
    }
    return node;
  };
  const root = walk(top.Plan);
  return { root, planningMs: num(top['Planning Time']), executionMs: num(top['Execution Time']), analyzed };
}

/** MySQL / MariaDB EXPLAIN FORMAT=JSON -> {root}. Each table access becomes a node; operations wrap them. */
function mysqlPlan(json) {
  const qb = json && (json.query_block || json);
  if (!qb || typeof qb !== 'object') throw new Error('The server did not return a plan.');
  const tableNode = (t) => {
    const ci = t.cost_info || {};
    const details = [];
    if (t.access_type) details.push(['Access type', t.access_type]);
    if (t.possible_keys) details.push(['Possible keys', [].concat(t.possible_keys).join(', ')]);
    if (t.key) details.push(['Key', t.key + (t.used_key_parts ? ` (${[].concat(t.used_key_parts).join(', ')})` : '')]);
    if (t.attached_condition) details.push(['Condition', t.attached_condition]);
    if (t.filtered !== undefined) details.push(['Filtered', `${t.filtered} %`]);
    if (t.using_index) details.push(['Covering index', 'yes']);
    return {
      op: accessLabel(t.access_type), object: t.table_name || '', cost: num(ci.prefix_cost || ci.read_cost),
      estRows: num(t.rows_examined_per_scan !== undefined ? t.rows_examined_per_scan : t.rows),
      actualRows: num(t.r_rows), loops: null, totalMs: num(t.r_total_time_ms), details, children: [], raw: t, access: t.access_type,
      noKey: !t.key && /^(ALL|index)$/i.test(t.access_type || ''),
    };
  };
  const walk = (o, label) => {
    const kids = [];
    const node = { op: label, object: '', cost: num(o.cost_info && o.cost_info.query_cost), estRows: null, actualRows: null, loops: null, totalMs: num(o.r_total_time_ms), details: [], children: kids, raw: o };
    if (o.using_filesort) node.details.push(['Using filesort', 'yes']);
    if (o.using_temporary_table) node.details.push(['Using temporary table', 'yes']);
    if (o.filesort_key) node.details.push(['Sort key', [].concat(o.filesort_key).join(', ')]);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'table' && v && typeof v === 'object') kids.push(tableNode(v));
      else if (k === 'nested_loop' && Array.isArray(v)) {
        const loop = { op: 'Nested loop', object: '', cost: null, estRows: null, actualRows: null, loops: null, totalMs: null, details: [], children: [], raw: v };
        for (const x of v) loop.children.push(x.table ? tableNode(x.table) : walk(x, 'Step'));
        kids.push(loop);
      } else if (/^(ordering_operation|grouping_operation|duplicates_removal|windowing|buffer_result|union_result|materialized_from_subquery|query_block|filesort|temporary_table|read_sorted_file)$/.test(k) && v && typeof v === 'object') {
        kids.push(walk(v, OPS[k] || k));
      } else if (/subqueries$/.test(k) && Array.isArray(v)) {
        for (const x of v) kids.push(walk(x.query_block || x, 'Subquery'));
      } else if (k === 'query_specifications' && Array.isArray(v)) {
        for (const x of v) kids.push(walk(x.query_block || x, 'Union part'));
      }
    }
    return node;
  };
  const root = walk(qb, 'Query');
  // MariaDB ANALYZE FORMAT=JSON adds r_rows / r_total_time_ms: the query ran.
  return { root, planningMs: null, executionMs: num(qb.r_total_time_ms), analyzed: JSON.stringify(qb).includes('"r_rows"') };
}
const OPS = { ordering_operation: 'Sort (ORDER BY)', grouping_operation: 'Group (GROUP BY)', duplicates_removal: 'Remove duplicates (DISTINCT)', windowing: 'Window functions', buffer_result: 'Buffer result', union_result: 'Union', materialized_from_subquery: 'Materialized subquery', query_block: 'Query', filesort: 'Filesort', temporary_table: 'Temporary table', read_sorted_file: 'Read sorted file' };
function accessLabel(a) {
  return ({ ALL: 'Full table scan', index: 'Full index scan', range: 'Index range scan', ref: 'Index lookup', eq_ref: 'Unique index lookup', const: 'Constant lookup', system: 'Single row', ref_or_null: 'Index lookup (or NULL)', index_merge: 'Index merge', fulltext: 'Full-text index', unique_subquery: 'Unique subquery', index_subquery: 'Index subquery' })[a] || (a ? `Access ${a}` : 'Table');
}

/** MySQL 8 EXPLAIN ANALYZE (a text tree) -> {root}. Lines start with "-> "; indentation gives the depth. */
function mysqlTreePlan(text) {
  const lines = String(text).split('\n').filter((l) => /^\s*->/.test(l));
  if (!lines.length) throw new Error('The server did not return a plan.');
  const root = { op: 'Query', object: '', cost: null, estRows: null, actualRows: null, loops: null, totalMs: null, details: [], children: [] };
  const stack = [{ depth: -1, node: root }];
  for (const l of lines) {
    const depth = l.search(/\S/);
    const body = l.trim().replace(/^->\s*/, '');
    const m = /\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.]+) loops=(\d+)\)/.exec(body);
    const c = /\(cost=([\d.]+)(?:\.\.([\d.]+))? rows=([\d.e+]+)\)/.exec(body);
    const loops = m ? Number(m[4]) : null;
    const node = {
      op: body.replace(/\s*\((cost|actual)[^)]*\)/g, '').trim(), object: '', cost: c ? Number(c[2] || c[1]) : null, estRows: c ? Number(c[3]) : null,
      actualRows: m ? Number(m[3]) * loops : null, loops, totalMs: m ? Number(m[2]) * loops : null, details: [], children: [],
      noKey: /^Table scan on /.test(body),
    };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ depth, node });
  }
  const analyzed = lines.some((l) => /actual time=/.test(l));
  return { root: root.children.length === 1 ? root.children[0] : root, planningMs: null, executionMs: null, analyzed };
}

/** SQLite EXPLAIN QUERY PLAN rows [id, parent, notused, detail] -> {root}. */
function sqlitePlan(rows) {
  const root = { op: 'Query', object: '', cost: null, estRows: null, actualRows: null, loops: null, totalMs: null, details: [], children: [] };
  const byId = new Map([[0, root]]);
  for (const r of rows) {
    const [id, parent, , detail] = r;
    const d = String(detail);
    const node = { op: d, object: '', cost: null, estRows: null, actualRows: null, loops: null, totalMs: null, details: [], children: [], noKey: /^SCAN (?!.*USING (COVERING )?INDEX)/.test(d) && !/^SCAN CONSTANT ROW/.test(d) };
    byId.set(Number(id), node);
    (byId.get(Number(parent)) || root).children.push(node);
  }
  return { root: root.children.length === 1 ? root.children[0] : root, planningMs: null, executionMs: null, analyzed: false };
}

/** Self time per node (total minus children), the share of the whole run, and the hints. */
function analyzePlan(plan) {
  const all = [];
  const visit = (n, depth) => {
    n.depth = depth;
    all.push(n);
    for (const c of n.children) visit(c, depth + 1);
    if (n.totalMs !== null && n.totalMs !== undefined) {
      const kids = n.children.reduce((a, c) => a + (c.totalMs || 0), 0);
      n.selfMs = Math.max(0, n.totalMs - kids);
    } else n.selfMs = null;
  };
  visit(plan.root, 0);
  const whole = plan.root.totalMs || all.reduce((a, n) => a + (n.selfMs || 0), 0) || 0;
  const costTop = plan.root.cost || Math.max(0, ...all.map((n) => n.cost || 0)) || 0;
  for (const n of all) {
    n.share = whole && n.selfMs !== null ? n.selfMs / whole : null;
    n.costShare = costTop && n.cost !== null && n.cost !== undefined ? Math.min(1, n.cost / costTop) : null;
  }
  const hints = [];
  const add = (n, level, text) => { hints.push({ level, text, op: n.op, object: n.object }); n.flag = n.flag === 'warn' || level === 'warn' ? 'warn' : 'info'; };
  for (const n of all) {
    const raw = n.raw || {};
    const what = n.object ? `${n.op} on ${n.object}` : n.op;
    if (/^Seq Scan/.test(n.op)) {
      const removed = num(raw['Rows Removed by Filter']);
      if (raw.Filter && (removed === null || removed > 1000 || (n.estRows || 0) > 1000)) add(n, 'warn', `${what} reads the whole table and filters it (${raw.Filter}${removed !== null ? `, ${removed.toLocaleString('en-US')} rows removed` : ''}). An index on the filtered columns may help.`);
      else if ((n.estRows || 0) > 100000 || (n.actualRows || 0) > 100000) add(n, 'info', `${what} reads about ${Math.round(n.actualRows || n.estRows).toLocaleString('en-US')} rows.`);
    }
    if (n.noKey) add(n, 'warn', `${what}: no index is used${raw.possible_keys ? ` (possible keys: ${[].concat(raw.possible_keys).join(', ')})` : ''}. An index on the columns in WHERE or JOIN may help.`);
    if (raw['Sort Space Type'] === 'Disk' || /external/i.test(String(raw['Sort Method'] || ''))) add(n, 'warn', `${what} spilled to disk (${raw['Sort Method'] || 'external sort'}, ${raw['Sort Space Used'] || '?'} kB). A larger work_mem, or an index that matches the ORDER BY, avoids it.`);
    if (raw.using_filesort || /USE TEMP B-TREE FOR (ORDER|GROUP) BY/.test(n.op)) add(n, 'info', `${what}: the rows are sorted after reading. An index in the ORDER BY / GROUP BY order can skip this step.`);
    if (raw.using_temporary_table) add(n, 'info', `${what}: uses a temporary table.`);
    // Row estimates: reported where they start, on the steps that read a table, not repeated on every parent.
    if (plan.analyzed && n.estRows !== null && n.actualRows !== null && n.loops && (raw['Relation Name'] || !n.children.length)) {
      const est = n.estRows * n.loops;
      const ratio = (Math.max(est, n.actualRows) + 1) / (Math.min(est, n.actualRows) + 1);
      if (ratio >= 10 && Math.max(est, n.actualRows) >= 1000) add(n, 'warn', `${what}: the planner expected ${Math.round(est).toLocaleString('en-US')} rows and got ${Math.round(n.actualRows).toLocaleString('en-US')} (${Math.round(ratio)}x off). Fresh statistics (ANALYZE${n.object ? ` ${String(n.object).split(' ')[0]}` : ''}) can fix the plan.`);
    }
    if (/^Nested Loop/.test(n.op) && plan.analyzed && n.children[1] && (n.children[1].loops || 0) > 10000) add(n, 'info', `${what}: the inner side ran ${n.children[1].loops.toLocaleString('en-US')} times.`);
  }
  const slowest = all.filter((n) => n.share !== null).sort((a, b) => b.selfMs - a.selfMs)[0] || null;
  if (slowest && slowest.share >= 0.3 && all.length > 1) slowest.slowest = true;
  return { nodes: all, hints, slowest, wholeMs: whole || null };
}

/** One call from the extension: rows of the EXPLAIN result -> analyzed plan. */
function parsePlan(dialect, analyze, rows) {
  let plan;
  if (dialect === 'postgres') {
    const cell = rows[0] && rows[0][0];
    plan = pgPlan(typeof cell === 'string' ? JSON.parse(cell) : cell);
  } else if (dialect === 'mysql') {
    const cell = rows.map((r) => toText(r[0])).join('\n');
    plan = /^\s*[{[]/.test(cell) ? mysqlPlan(JSON.parse(cell)) : mysqlTreePlan(cell);
  } else plan = sqlitePlan(rows);
  return Object.assign(plan, analyzePlan(plan));
}

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtMs = (ms) => (ms === null || ms === undefined ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms >= 10 ? ms.toFixed(0) : ms.toFixed(2)} ms`);
const fmtN = (n) => (n === null || n === undefined ? '' : Math.round(n).toLocaleString('en-US'));

/** A static page (no script): summary, hints, then the plan tree with a bar per step. */
function planHtml({ plan, sql, title, dialect, cspSource, analyzed, rawText }) {
  const csp = `default-src 'none'; style-src 'unsafe-inline' ${cspSource || ''}`;
  const head = [];
  if (plan.executionMs !== null && plan.executionMs !== undefined) head.push(`Execution ${fmtMs(plan.executionMs)}`);
  else if (plan.wholeMs) head.push(`Run time ${fmtMs(plan.wholeMs)}`);
  if (plan.planningMs !== null && plan.planningMs !== undefined) head.push(`planning ${fmtMs(plan.planningMs)}`);
  if (plan.root.cost !== null && plan.root.cost !== undefined) head.push(`estimated cost ${plan.root.cost.toLocaleString('en-US')}`);
  head.push(`${plan.nodes.length} step${plan.nodes.length === 1 ? '' : 's'}`);
  const hint = plan.hints.length
    ? `<ul class="hints">${plan.hints.map((h) => `<li class="${h.level}">${esc(h.text)}</li>`).join('')}</ul>`
    : '<p class="ok">No full scans on filtered tables, no disk sorts and no bad row estimates were found in this plan.</p>';
  const rows = plan.nodes.map((n) => {
    const share = n.share !== null && n.share !== undefined ? n.share : n.costShare;
    const bar = share !== null && share !== undefined ? `<span class="bar" style="width:${Math.max(1, Math.round(share * 100))}%"></span>` : '';
    const nums = [
      n.selfMs !== null && n.selfMs !== undefined ? `self ${fmtMs(n.selfMs)}` : '',
      n.actualRows !== null && n.actualRows !== undefined ? `${fmtN(n.actualRows)} rows` : '',
      n.estRows !== null && n.estRows !== undefined ? `est. ${fmtN(n.estRows)}` : '',
      n.loops && n.loops > 1 ? `${fmtN(n.loops)} loops` : '',
      n.cost !== null && n.cost !== undefined ? `cost ${n.cost.toLocaleString('en-US')}` : '',
    ].filter(Boolean).join(' · ');
    const det = n.details.length ? `<div class="det">${n.details.map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`).join('')}</div>` : '';
    return `<div class="node ${n.flag || ''}${n.slowest ? ' slowest' : ''}" style="margin-left:${n.depth * 18}px"><div class="line"><span class="op">${esc(n.op)}</span>${n.object ? ` <span class="obj">${esc(n.object)}</span>` : ''}${n.slowest ? ' <span class="tag">slowest step</span>' : ''}<span class="nums">${esc(nums)}</span></div><div class="track">${bar}</div>${det}</div>`;
  }).join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${esc(title)}</title><style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:12px 18px;line-height:1.45}
h1{font-size:1.15em;margin:0 0 4px}.sum{opacity:.85;margin-bottom:10px}.hints{margin:6px 0 14px;padding-left:18px}.hints li{margin:3px 0}.hints li.warn::marker{color:var(--vscode-editorWarning-foreground,#cca700)}
.ok{opacity:.85}.node{border-left:2px solid var(--vscode-panel-border,#8884);padding:3px 0 5px 8px;margin:2px 0}.node.warn{border-left-color:var(--vscode-editorWarning-foreground,#cca700)}.node.slowest{border-left-color:var(--vscode-errorForeground,#f14c4c)}
.line{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}.op{font-weight:600}.obj{font-family:var(--vscode-editor-font-family);opacity:.9}.nums{margin-left:auto;opacity:.75;font-size:.92em;white-space:nowrap}
.tag{font-size:.8em;padding:0 5px;border-radius:3px;background:var(--vscode-inputValidation-errorBackground,#5a1d1d)}.track{height:4px;background:var(--vscode-editorWidget-background,#8882);margin:3px 0;max-width:600px}.bar{display:block;height:4px;background:var(--vscode-progressBar-background,#0e70c0)}
.det{font-size:.9em;opacity:.85;display:flex;flex-direction:column;gap:1px;font-family:var(--vscode-editor-font-family)}pre{white-space:pre-wrap;word-break:break-word;font-family:var(--vscode-editor-font-family);font-size:.9em;opacity:.9}details{margin-top:14px}
</style></head><body><h1>${esc(title)}</h1><div class="sum">${esc(head.join(' · '))}${analyzed ? ' · the query ran (EXPLAIN ANALYZE)' : ' · estimate only, the query did not run'}</div>
${hint}
${rows}
<details><summary>SQL</summary><pre>${esc(sql)}</pre></details>
<details><summary>Raw plan from the server (${esc(dialect)})</summary><pre>${esc(rawText)}</pre></details>
</body></html>`;
}

// ---------------------------------------------------------------- Table Data Compare

/** Unicode code point order (what COLLATE "C", CAST(... AS BINARY) on utf8mb4 and SQLite BINARY give). */
function cmpCodePoints(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i); const y = b.codePointAt(i);
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

const NUMERIC_TYPE = /^(small|big|medium|tiny)?int|integer|serial|numeric|decimal|real|double|float|number|money|year|bit/i;
const isNumType = (t) => NUMERIC_TYPE.test(String(t || ''));
const isTextType = (t) => /char|text|string|clob|uuid|enum|set|citext|name/i.test(String(t || '')) && !isNumType(t);

/** ORDER BY one key column so that both servers sort in the same (code point) order. */
function orderTerm(col, type, dialect) {
  const q = quoteIdent(col, dialect);
  if (!isTextType(type)) return q;
  if (dialect === 'postgres') return `${q} COLLATE "C"`;
  if (dialect === 'mysql') return `CAST(${q} AS BINARY)`;
  return q; // SQLite compares text with memcmp (BINARY) by default
}

function compareSelect(t, columns, key, dialect) {
  const types = new Map(t.columns.map((c) => [c.name, c.type]));
  return `SELECT ${columns.map((c) => quoteIdent(c, dialect)).join(', ')} FROM ${qualified(t.schema, t.table, dialect)} ORDER BY ${key.map((k) => orderTerm(k, types.get(k), dialect)).join(', ')}`;
}

/** Decimal text without leading/trailing zeros: "001.500" -> "1.5", "-0.0" -> "0". */
function canonDecimal(s) {
  const m = /^\s*([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  if (m[4]) { const n = Number(s); return Number.isFinite(n) ? String(n) : null; }
  const int = (m[2] || '0').replace(/^0+(?=\d)/, '');
  const frac = (m[3] || '').replace(/0+$/, '');
  const body = frac ? `${int}.${frac}` : int;
  return body === '0' ? '0' : (m[1] === '-' ? '-' : '') + body;
}

/** A value as comparable text: NULL stays null, numbers and booleans in one form, binary as hex, JSON key-sorted. */
function canon(v, type) {
  if (v === null || v === undefined) return null;
  const t = String(type || '');
  if (isBinary(v)) return 'x' + Buffer.from(v).toString('hex');
  if (/^bool/i.test(t) || (/^tinyint\(1\)/i.test(t))) {
    if (v === true || v === 1 || v === '1' || v === 't' || v === 'true') return '1';
    if (v === false || v === 0 || v === '0' || v === 'f' || v === 'false') return '0';
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return canonDecimal(String(v)) || String(v);
  const s = toText(v);
  if (isNumType(t) || /^(bool|tinyint)/i.test(t)) { const d = canonDecimal(s); if (d !== null) return d; }
  if (/json/i.test(t)) { try { return stableJson(JSON.parse(s)); } catch { return s; } }
  return s;
}
function stableJson(x) {
  if (Array.isArray(x)) return '[' + x.map(stableJson).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + stableJson(x[k])).join(',') + '}';
  return JSON.stringify(x);
}

/** Key compare in the ORDER BY order above: numbers by value, text by code point, NULL first. */
function keyCompare(a, b, types) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x === y) continue;
    if (x === null) return -1;
    if (y === null) return 1;
    let c;
    const nx = Number(x); const ny = Number(y);
    if (isNumType(types[i]) && Number.isFinite(nx) && Number.isFinite(ny)) c = nx < ny ? -1 : nx > ny ? 1 : 0;
    else c = cmpCodePoints(x, y);
    if (c) return c;
  }
  return 0;
}

/** Turn a push stream (exportQuery's onBatch) into a pull reader: next() -> row array or null at the end. */
function pullRows(start) {
  const q = []; let done = false; let error = null; let wake = null; let resume = null; let stopped = false;
  const signal = () => { if (wake) { const w = wake; wake = null; w(); } };
  const finished = start(async (_cols, rows) => {
    q.push(rows);
    signal();
    if (!stopped) await new Promise((r) => { resume = r; });
  }, () => stopped).then(() => { done = true; signal(); }, (e) => { error = e; done = true; signal(); });
  let cur = []; let pos = 0;
  return {
    async next() {
      while (pos >= cur.length) {
        if (q.length) { cur = q.shift(); pos = 0; if (resume) { const r = resume; resume = null; r(); } continue; }
        if (error) throw error;
        if (done) return null;
        await new Promise((r) => { wake = r; });
      }
      return cur[pos++];
    },
    stop() { stopped = true; if (resume) { const r = resume; resume = null; r(); } return finished; },
  };
}

/**
 * Compare two tables by key. a, b: {read: pullRows reader (rows in the column order of `columns`), dialect}.
 * columns: shared columns, key first. types: the A column types. Returns counts and the differences (capped).
 */
async function compareRows({ a, b, columns, keyCount, types, maxDiffs = 100000, shouldStop, onProgress }) {
  const res = { onlyA: 0, onlyB: 0, changed: 0, same: 0, rowsA: 0, rowsB: 0, diffs: [], capped: false, stopped: false, outOfOrder: false };
  const keyTypes = types.slice(0, keyCount);
  const canonRow = (r) => (r ? r.map((v, i) => canon(v, types[i])) : null);
  let ra = canonRow(await a.next());
  let rb = canonRow(await b.next());
  let prevA = null; let prevB = null;
  let rowA = a.lastRaw; let rowB = b.lastRaw;
  const push = (d) => { if (res.diffs.length < maxDiffs) res.diffs.push(d); else res.capped = true; };
  let n = 0;
  while (ra || rb) {
    if (shouldStop && shouldStop()) { res.stopped = true; break; }
    const c = !ra ? 1 : !rb ? -1 : keyCompare(ra.slice(0, keyCount), rb.slice(0, keyCount), keyTypes);
    if (c < 0) { res.onlyA++; push({ kind: 'onlyA', row: rowA }); }
    else if (c > 0) { res.onlyB++; push({ kind: 'onlyB', row: rowB }); }
    else {
      const changedCols = [];
      for (let i = keyCount; i < columns.length; i++) if (ra[i] !== rb[i]) changedCols.push(i);
      if (changedCols.length) { res.changed++; push({ kind: 'changed', row: rowA, other: rowB, cols: changedCols }); } else res.same++;
    }
    if (c <= 0) {
      prevA = ra; res.rowsA++;
      ra = canonRow(await a.next()); rowA = a.lastRaw;
      if (ra && prevA && keyCompare(prevA.slice(0, keyCount), ra.slice(0, keyCount), keyTypes) >= 0) res.outOfOrder = true;
    }
    if (c >= 0) {
      prevB = rb; res.rowsB++;
      rb = canonRow(await b.next()); rowB = b.lastRaw;
      if (rb && prevB && keyCompare(prevB.slice(0, keyCount), rb.slice(0, keyCount), keyTypes) >= 0) res.outOfOrder = true;
    }
    if (res.outOfOrder) break;
    if (onProgress && ++n % 5000 === 0) onProgress(res);
  }
  return res;
}

/** Wrap a pullRows reader so compareRows can keep the raw row next to its canonical form. */
function tracked(reader) {
  const t = { lastRaw: null, async next() { const r = await reader.next(); t.lastRaw = r; return r; }, stop: () => reader.stop() };
  return t;
}

const rowsWord = (n) => `${n.toLocaleString('en-US')} row${n === 1 ? '' : 's'}`;

/** SQL that makes table B equal to table A (B's dialect): DELETE, then UPDATE, then INSERT, in one transaction. */
function syncScript({ res, columns, keyCount, target, dialect, labelA, labelB, limit = 100000 }) {
  const tbl = qualified(target.schema, target.table, dialect);
  const where = (row) => columns.slice(0, keyCount).map((c, i) => (row[i] === null ? `${quoteIdent(c, dialect)} IS NULL` : `${quoteIdent(c, dialect)} = ${quoteLiteral(row[i], dialect)}`)).join(' AND ');
  const out = [
    `-- Make ${labelB} match ${labelA}.`,
    `-- ${rowsWord(res.onlyA)} only in ${labelA} (INSERT), ${res.onlyB.toLocaleString('en-US')} only in ${labelB} (DELETE), ${res.changed.toLocaleString('en-US')} changed (UPDATE), ${res.same.toLocaleString('en-US')} equal.`,
    '-- Review it before you run it. It runs on the connection this file is bound to, in one transaction.',
  ];
  if (res.capped) out.push(`-- Only the first ${res.diffs.length.toLocaleString('en-US')} differences are in this script.`);
  out.push(dialect === 'mysql' ? 'START TRANSACTION;' : 'BEGIN;');
  let n = 0;
  for (const d of res.diffs) if (d.kind === 'onlyB' && n++ < limit) out.push(`DELETE FROM ${tbl} WHERE ${where(d.row)};`);
  for (const d of res.diffs) {
    if (d.kind !== 'changed' || n++ >= limit) continue;
    out.push(`UPDATE ${tbl} SET ${d.cols.map((i) => `${quoteIdent(columns[i], dialect)} = ${quoteLiteral(d.row[i], dialect)}`).join(', ')} WHERE ${where(d.row)};`);
  }
  for (const d of res.diffs) {
    if (d.kind !== 'onlyA' || n++ >= limit) continue;
    out.push(`INSERT INTO ${tbl} (${columns.map((c) => quoteIdent(c, dialect)).join(', ')}) VALUES (${d.row.map((v) => quoteLiteral(v, dialect)).join(', ')});`);
  }
  if (n > limit) out.push(`-- ${(n - limit).toLocaleString('en-US')} more statements were left out (limit ${limit.toLocaleString('en-US')}).`);
  out.push('COMMIT;', '');
  return out.join('\n');
}

/** Short Markdown report: counts plus the first rows of each kind. */
function compareReport({ res, columns, keyCount, labelA, labelB, sample = 20 }) {
  const cell = (v) => (v === null || v === undefined ? 'NULL' : isBinary(v) ? `0x${Buffer.from(v).toString('hex').slice(0, 32)}` : toText(v).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 80));
  const lines = [
    `# Data compare: ${labelA} vs ${labelB}`, '',
    '| | Rows |', '|---|---|',
    `| Rows in ${labelA} | ${res.rowsA.toLocaleString('en-US')} |`,
    `| Rows in ${labelB} | ${res.rowsB.toLocaleString('en-US')} |`,
    `| Equal | ${res.same.toLocaleString('en-US')} |`,
    `| Changed | ${res.changed.toLocaleString('en-US')} |`,
    `| Only in ${labelA} | ${res.onlyA.toLocaleString('en-US')} |`,
    `| Only in ${labelB} | ${res.onlyB.toLocaleString('en-US')} |`, '',
    `Matched by ${columns.slice(0, keyCount).join(', ')}. Compared columns: ${columns.join(', ')}.`, '',
  ];
  const changed = res.diffs.filter((d) => d.kind === 'changed').slice(0, sample);
  if (changed.length) {
    lines.push(`## Changed rows (first ${changed.length})`, '', `| ${columns.slice(0, keyCount).join(', ')} | Column | ${labelA} | ${labelB} |`, '|---|---|---|---|');
    for (const d of changed) for (const i of d.cols) lines.push(`| ${d.row.slice(0, keyCount).map(cell).join(', ')} | ${columns[i]} | ${cell(d.row[i])} | ${cell(d.other[i])} |`);
    lines.push('');
  }
  for (const [kind, label] of [['onlyA', `Only in ${labelA}`], ['onlyB', `Only in ${labelB}`]]) {
    const list = res.diffs.filter((d) => d.kind === kind).slice(0, sample);
    if (!list.length) continue;
    lines.push(`## ${label} (first ${list.length})`, '', `| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`);
    for (const d of list) lines.push(`| ${d.row.map(cell).join(' | ')} |`);
    lines.push('');
  }
  if (res.outOfOrder) lines.push('The compare stopped early: a server returned keys out of order (different collations). Compare tables with numeric keys, or with the same collation on both sides.', '');
  if (res.stopped) lines.push('The compare was cancelled. The numbers above cover the rows read until then.', '');
  return lines.join('\n');
}

module.exports = {
  explainSql, mariaAnalyzeSql, pgPlan, mysqlPlan, mysqlTreePlan, sqlitePlan, analyzePlan, parsePlan, planHtml,
  cmpCodePoints, canon, canonDecimal, keyCompare, orderTerm, compareSelect, pullRows, tracked, compareRows, syncScript, compareReport, isTextType, isNumType,
};
