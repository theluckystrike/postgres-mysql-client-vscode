// Results grid webview: tabs for result sets, a virtual-scroll grid (only visible rows are in the DOM),
// sort and filter (here when every row is loaded, on the server otherwise), copy, export, cell view and
// staged row edits that the host shows as SQL before it commits them.

import { h, fmtBytes, debounce } from './dom.js';

const ROW_H = 24;
const OVERSCAN = 12;

export function startGrid(vscode, app) {
  const st = { sets: [], active: null, messages: null, running: null, edit: null, toast: null };
  const saved = vscode.getState() || {};

  // ---------- layout ----------
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const toolbar = h('div', { class: 'toolbar' });
  const scroller = h('div', { class: 'scroller', tabindex: '0' });
  const sizer = h('div', { class: 'sizer' });
  const head = h('div', { class: 'head' });
  const body = h('div', { class: 'body' });
  sizer.append(head, body);
  scroller.append(sizer);
  const empty = h('div', { class: 'empty' }, 'Run a query with Ctrl+Enter (Cmd+Enter on macOS), or click a table in the Database Explorer.');
  const msgBox = h('div', { class: 'messages hidden' });
  const errBox = h('div', { class: 'error hidden', role: 'alert' });
  const status = h('div', { class: 'status' });
  const statusText = h('span', { class: 'status-text' });
  status.append(statusText);
  const supportLine = document.getElementById('zovo-support');
  if (supportLine) status.append(supportLine);
  const toastBox = h('div', { class: 'toast hidden', role: 'status' });
  app.append(tabs, toolbar, errBox, empty, msgBox, scroller, status, toastBox);

  const cur = () => st.sets.find((s) => s.id === st.active) || null;

  // ---------- messages from the host ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    switch (m.type) {
      case 'clear': st.sets = []; st.active = null; st.messages = null; hideError(); render(); break;
      case 'running': st.running = { id: m.id, sql: m.sql, t0: Date.now(), keep: m.keep }; if (!m.keep) hideError(); renderToolbar(); tick(); break;
      case 'loading': st.running = { id: m.id, t0: Date.now(), more: true }; renderToolbar(); tick(); break;
      case 'result': onResult(m.set, m.fresh); break;
      case 'append': onAppend(m); break;
      case 'editable': { const s = st.sets.find((x) => x.id === m.id); if (s) { s.edit = m.edit; if (s.id === st.active) { renderToolbar(); renderGrid(true); } } break; }
      case 'error': st.running = null; showError(m.message, m.sql); renderToolbar(); break;
      case 'messages': st.messages = m.messages; if (!st.sets.length) st.active = 'messages'; render(); break;
      case 'toast': toast(m.message, m.level); break;
      case 'review': showReview(m); break;
      case 'committed': onCommitted(m); break;
      default:
    }
  });

  function onResult(set, fresh) {
    st.running = null;
    const old = st.sets.find((s) => s.id === set.id);
    const s = Object.assign(old || {}, set, {
      view: null, localSort: old && !set.server ? old.localSort : null, localFilters: old && !set.server ? old.localFilters : {},
      sel: new Set(), focus: { row: 0, col: 0 }, staged: (old && old.staged && !fresh) ? old.staged : newStaged(),
      edit: old ? old.edit : null, widths: old && old.widths ? old.widths : null,
    });
    if (!old) st.sets.push(s);
    if (fresh || !st.active || st.active === 'messages' && !st.messages) st.active = st.active && st.sets.some((x) => x.id === st.active) ? st.active : s.id;
    if (fresh && st.sets.length === 1) st.active = s.id;
    computeView(s);
    if (!s.widths) s.widths = measure(s);
    if (s.id === st.active) scroller.scrollTop = 0; // a new result (or a server sort or filter) starts at row 1
    render();
  }

  function onAppend(m) {
    st.running = null;
    const s = st.sets.find((x) => x.id === m.id);
    if (!s) return;
    for (const r of m.rows) s.rows.push(r);
    s.done = m.done;
    s.message = `${s.rows.length.toLocaleString('en-US')}${s.done ? '' : '+'} rows`;
    computeView(s);
    if (s.id === st.active) { renderToolbar(); renderGrid(true); }
  }

  function newStaged() { return { updates: new Map(), inserts: [], deletes: new Set() }; }
  function stagedCount(s) { return s.staged.updates.size + s.staged.inserts.length + s.staged.deletes.size; }

  // ---------- view order (local sort and filter) ----------
  function computeView(s) {
    let idx = s.rows.map((_, i) => i);
    const lf = s.localFilters || {};
    const active = Object.keys(lf).filter((k) => lf[k]);
    if (active.length) {
      idx = idx.filter((i) => active.every((c) => cellText(s.rows[i][c]).toLowerCase().includes(lf[c].toLowerCase())));
    }
    if (s.localSort) {
      const { col, desc } = s.localSort;
      const num = s.columns[col] && s.columns[col].kind === 'number';
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      idx.sort((a, b) => {
        const x = s.rows[a][col];
        const y = s.rows[b][col];
        if (x === null && y === null) return a - b;
        if (x === null) return desc ? 1 : -1;
        if (y === null) return desc ? -1 : 1;
        let r = num ? (Number(cellText(x)) - Number(cellText(y))) : coll.compare(cellText(x), cellText(y));
        if (Number.isNaN(r)) r = coll.compare(cellText(x), cellText(y));
        return (desc ? -r : r) || a - b;
      });
    }
    s.view = idx;
  }

  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return v.t === 'long' ? v.s : (v.t === 'bin' ? `${v.k || 'binary'} ${v.n}` : '');
    return String(v);
  }

  function measure(s) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = getComputedStyle(document.body).font || '13px sans-serif';
    return s.columns.map((c, i) => {
      let w = ctx.measureText(c.name).width + 46;
      for (let r = 0; r < Math.min(s.rows.length, 200); r++) w = Math.max(w, ctx.measureText(display(s.rows[r][i]).slice(0, 80)).width + 18);
      return Math.round(Math.min(Math.max(w, 64), 420));
    });
  }

  function display(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'object') {
      if (v.t === 'bin') return `${v.k ? v.k.toUpperCase() + ' ' : ''}${fmtBytes(v.n)} 0x${v.h}${v.n > v.h.length / 2 ? '…' : ''}`;
      if (v.t === 'long') return `${v.s.slice(0, 200).replace(/\s+/g, ' ')}… (${fmtBytes(v.n)} of text)`;
    }
    return String(v).replace(/[\r\n\t]+/g, ' ');
  }

  // ---------- render ----------
  function render() {
    renderTabs();
    renderToolbar();
    const s = cur();
    const showMsgs = st.active === 'messages';
    msgBox.classList.toggle('hidden', !showMsgs);
    scroller.classList.toggle('hidden', !s || showMsgs);
    empty.classList.toggle('hidden', !!s || showMsgs || !!st.messages);
    if (showMsgs) renderMessages();
    if (s && !showMsgs) renderGrid(true);
    vscode.setState({ ...saved });
  }

  function renderTabs() {
    tabs.textContent = '';
    const many = st.sets.length > 1 || st.messages;
    tabs.classList.toggle('hidden', !many);
    for (const s of st.sets) {
      const b = h('button', { class: 'tab' + (s.id === st.active ? ' active' : ''), role: 'tab', 'aria-selected': String(s.id === st.active), title: s.sql }, s.n ? `Result ${s.n}` : 'Result', h('span', { class: 'badge' }, `${s.rows.length}${s.done ? '' : '+'}`));
      b.addEventListener('click', () => { st.active = s.id; render(); });
      tabs.append(b);
    }
    if (st.messages) {
      const b = h('button', { class: 'tab' + (st.active === 'messages' ? ' active' : ''), role: 'tab' }, 'Messages', h('span', { class: 'badge' }, String(st.messages.length)));
      b.addEventListener('click', () => { st.active = 'messages'; render(); });
      tabs.append(b);
    }
  }

  function renderMessages() {
    msgBox.textContent = '';
    for (const m of st.messages || []) {
      msgBox.append(h('div', { class: 'msg ' + (m.ok ? 'ok' : 'bad') }, h('div', { class: 'msg-text' }, m.text || ''), h('pre', { class: 'msg-sql' }, m.sql.length > 600 ? m.sql.slice(0, 600) + '…' : m.sql)));
    }
  }

  function btn(label, title, onClick, opts = {}) {
    const b = h('button', { class: 'btn' + (opts.primary ? ' primary' : '') + (opts.cls ? ' ' + opts.cls : ''), title }, label);
    if (opts.disabled) b.disabled = true;
    b.addEventListener('click', onClick);
    return b;
  }

  function menuBtn(label, title, items) {
    const b = btn(label + ' ▾', title, (e) => openMenu(e.currentTarget, items));
    return b;
  }

  function renderToolbar() {
    toolbar.textContent = '';
    const s = cur();
    const run = st.running;
    if (run) {
      toolbar.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'running', id: 'elapsed' }, run.more ? 'Loading rows…' : 'Running…'));
      toolbar.append(btn('Cancel', 'Stop the running statement on the server', () => vscode.postMessage({ type: 'cancel' }), { cls: 'danger' }));
    }
    if (!s || st.active === 'messages') { statusText.textContent = st.messages ? `${st.messages.length} statements` : ''; return; }
    const loaded = s.rows.length;
    const shown = s.view ? s.view.length : loaded;
    statusText.textContent = `${loaded.toLocaleString('en-US')}${s.done ? '' : '+'} rows${shown !== loaded ? ` · ${shown.toLocaleString('en-US')} shown` : ''}${s.ms !== undefined ? ` · ${s.ms} ms` : ''}${s.server ? ' · sorted/filtered on the server' : ''}${s.columns.length ? ` · ${s.columns.length} columns` : ''}`;
    if (!run) {
      if (!s.done) toolbar.append(btn('Load more', 'Read the next rows from the server', () => vscode.postMessage({ type: 'loadMore', id: s.id }), { primary: true }));
      toolbar.append(btn('↻', 'Run this query again', () => vscode.postMessage({ type: 'refresh', id: s.id })));
    }
    toolbar.append(menuBtn('Copy', 'Copy the selected rows, or all loaded rows', [
      ['CSV', () => copy('csv')], ['JSON', () => copy('json')], ['Markdown table', () => copy('markdown')], ['Tab-separated', () => copy('tsv')],
    ]));
    toolbar.append(menuBtn('Export', 'Write every row of this result to a file (streamed)', [
      ['CSV…', () => vscode.postMessage({ type: 'export', id: s.id, format: 'csv' })],
      ['JSON…', () => vscode.postMessage({ type: 'export', id: s.id, format: 'json' })],
      ['SQL INSERT…', () => vscode.postMessage({ type: 'export', id: s.id, format: 'sql' })],
    ]));
    const e = s.edit;
    if (e && e.ok) {
      const n = stagedCount(s);
      toolbar.append(h('span', { class: 'sep' }));
      toolbar.append(btn('+ Row', `Add a row to ${e.table}`, () => addRow(s)));
      toolbar.append(btn('Delete', 'Mark the selected rows for deletion', () => markDelete(s), { disabled: !s.sel.size }));
      if (n) {
        toolbar.append(btn(`Review ${n} change${n === 1 ? '' : 's'}…`, 'See the SQL, then save it in one transaction', () => sendEdits(s), { primary: true }));
        toolbar.append(btn('Discard', 'Forget the changes that are not saved', () => { s.staged = newStaged(); renderToolbar(); renderGrid(true); }));
      } else toolbar.append(h('span', { class: 'hint', title: `Rows of ${e.table} are editable: double-click a cell, add a row or delete rows. You review the SQL before it runs.` }, `Double-click to edit ${e.table}`));
    } else if (e && e.reason) {
      toolbar.append(h('span', { class: 'hint', title: e.reason }, `Read-only: ${e.reason}`));
    }
  }

  function tick() {
    const el = document.getElementById('elapsed');
    if (!el || !st.running) return;
    const secs = ((Date.now() - st.running.t0) / 1000).toFixed(1);
    el.textContent = `${st.running.more ? 'Loading rows' : 'Running'}… ${secs} s`;
    setTimeout(tick, 200);
  }

  function renderGrid(full) {
    const s = cur();
    if (!s) return;
    const widths = s.widths || [];
    const numW = 56;
    const total = numW + widths.reduce((a, b) => a + b, 0);
    const rowsN = s.view.length + s.staged.inserts.length;
    sizer.style.width = `${total}px`;
    sizer.style.height = `${(rowsN + 2) * ROW_H + 4}px`;
    if (full) {
      head.textContent = '';
      const hr = h('div', { class: 'row hrow' });
      const fr = h('div', { class: 'row frow' });
      hr.append(h('div', { class: 'cell num', style: `width:${numW}px` }, '#'));
      fr.append(h('div', { class: 'cell num', style: `width:${numW}px`, title: 'Filter: type in a column box' }, '⌕'));
      s.columns.forEach((c, i) => {
        const sorted = s.server ? (s.sort && s.sort.col === i + 1 ? s.sort : null) : (s.localSort && s.localSort.col === i ? s.localSort : null);
        const arrow = sorted ? (sorted.desc ? ' ▼' : ' ▲') : '';
        const editable = s.edit && s.edit.ok && s.edit.editable[i];
        const cell = h('div', { class: 'cell hcell' + (c.kind === 'number' ? ' right' : ''), style: `width:${widths[i]}px`, title: `${c.name} (${c.type})${editable ? ' · editable' : ''}\nClick to sort` },
          h('span', { class: 'hname' }, c.name + arrow), h('span', { class: 'htype' }, c.type));
        cell.addEventListener('click', () => sortBy(s, i));
        const grip = h('span', { class: 'grip', title: 'Drag to resize' });
        grip.addEventListener('mousedown', (ev) => startResize(ev, s, i));
        grip.addEventListener('click', (ev) => ev.stopPropagation());
        cell.append(grip);
        hr.append(cell);
        const fval = s.server ? ((s.filters || []).find((f) => f.col === i) || {}).text || '' : (s.localFilters || {})[i] || '';
        const inp = h('input', { class: 'filter', type: 'text', placeholder: 'filter', value: fval, 'aria-label': `Filter ${c.name}` });
        inp.addEventListener('input', debounce(() => filterBy(s, i, inp.value), 450));
        inp.addEventListener('keydown', (ev) => ev.stopPropagation());
        fr.append(h('div', { class: 'cell fcell', style: `width:${widths[i]}px` }, inp));
      });
      head.append(hr, fr);
    }
    paintRows();
  }

  function paintRows() {
    const s = cur();
    if (!s) return;
    const widths = s.widths;
    const top = Math.max(0, scroller.scrollTop - 2 * ROW_H);
    const visible = Math.ceil(scroller.clientHeight / ROW_H);
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const rowsN = s.view.length + s.staged.inserts.length;
    const last = Math.min(rowsN, first + visible + OVERSCAN * 2);
    body.textContent = '';
    body.style.transform = `translateY(${first * ROW_H}px)`;
    const frag = document.createDocumentFragment();
    for (let vi = first; vi < last; vi++) {
      const isIns = vi >= s.view.length;
      const ri = isIns ? -1 - (vi - s.view.length) : s.view[vi];
      const row = isIns ? null : s.rows[ri];
      const upd = isIns ? s.staged.inserts[vi - s.view.length].values : s.staged.updates.get(ri);
      const del = !isIns && s.staged.deletes.has(ri);
      const r = h('div', { class: 'row' + (s.sel.has(ri) ? ' sel' : '') + (del ? ' del' : '') + (isIns ? ' ins' : ''), 'data-r': String(ri), 'data-v': String(vi) });
      r.append(h('div', { class: 'cell num', style: `width:56px` }, isIns ? '+' : String(ri + 1)));
      s.columns.forEach((c, ci) => {
        const changed = upd && Object.prototype.hasOwnProperty.call(upd, ci);
        const v = changed ? upd[ci] : (row ? row[ci] : undefined);
        const cls = ['cell'];
        if (v === null) cls.push('null');
        if (v === undefined) cls.push('dflt');
        if (c.kind === 'number' && v !== null) cls.push('right');
        if (v && typeof v === 'object') cls.push(v.t === 'bin' ? 'bin' : 'long');
        if (changed) cls.push('changed');
        if (s.focus && s.focus.row === vi && s.focus.col === ci) cls.push('focus');
        const text = v === undefined ? (isIns ? 'DEFAULT' : '') : display(v);
        r.append(h('div', { class: cls.join(' '), style: `width:${widths[ci]}px`, 'data-c': String(ci), title: text.length > 60 ? text.slice(0, 500) : '' }, text));
      });
      frag.append(r);
    }
    body.append(frag);
  }

  // Selection and focus change classes in place: rebuilding the rows between the two clicks of a
  // double-click would stop the browser from firing dblclick.
  function updateSel() {
    const s = cur();
    if (!s) return;
    for (const r of body.children) {
      const ri = Number(r.dataset.r);
      const vi = Number(r.dataset.v);
      r.classList.toggle('sel', s.sel.has(ri));
      for (const c of r.children) {
        if (c.dataset.c === undefined) continue;
        c.classList.toggle('focus', !!s.focus && s.focus.row === vi && s.focus.col === Number(c.dataset.c));
      }
    }
  }

  scroller.addEventListener('scroll', () => { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; paintRows(); maybeAutoLoad(); }); } });
  let rafPending = false;
  window.addEventListener('resize', () => paintRows());

  function maybeAutoLoad() {
    const s = cur();
    if (!s || s.done || st.running || s.server && false) return;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - ROW_H * 3 && s.rows.length < s.maxRows && !s.localSort && !Object.values(s.localFilters || {}).some(Boolean)) {
      vscode.postMessage({ type: 'loadMore', id: s.id });
    }
  }

  // ---------- sort, filter, resize ----------
  function local(s) { return s.done && !s.server; }

  function sortBy(s, col) {
    if (stagedCount(s)) { toast('Save or discard your changes before you sort.', 'info'); return; }
    if (local(s) || !s.canServer) {
      const cur0 = s.localSort;
      s.localSort = !cur0 || cur0.col !== col ? { col, desc: false } : (cur0.desc ? null : { col, desc: true });
      computeView(s); renderGrid(true); renderToolbar();
      return;
    }
    const cur1 = s.sort && s.sort.col === col + 1 ? s.sort : null;
    const next = !cur1 ? { col, desc: false } : (cur1.desc ? null : { col, desc: true });
    vscode.postMessage({ type: 'sort', id: s.id, col: next ? next.col : null, desc: next ? next.desc : false });
  }

  function filterBy(s, col, text) {
    if (local(s) || !s.canServer) {
      s.localFilters = { ...(s.localFilters || {}), [col]: text };
      computeView(s); scroller.scrollTop = 0; paintRows(); renderToolbar();
      return;
    }
    const f = (s.filters || []).filter((x) => x.col !== col);
    if (text) f.push({ col, text });
    vscode.postMessage({ type: 'filter', id: s.id, filters: f });
  }

  function startResize(ev, s, i) {
    ev.preventDefault(); ev.stopPropagation();
    const x0 = ev.clientX;
    const w0 = s.widths[i];
    const move = (e) => { s.widths[i] = Math.max(40, w0 + e.clientX - x0); renderGrid(true); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ---------- selection, keyboard, editing ----------
  function cellAt(target) {
    const cell = target.closest('.cell');
    const row = target.closest('.row');
    if (!cell || !row || !row.dataset.v) return null;
    return { vi: Number(row.dataset.v), ri: Number(row.dataset.r), ci: cell.dataset.c === undefined ? -1 : Number(cell.dataset.c), el: cell };
  }

  body.addEventListener('mousedown', (ev) => {
    const s = cur();
    const at = cellAt(ev.target);
    if (!s || !at || ev.button !== 0) return;
    if (ev.shiftKey && s.anchor !== undefined) {
      const [a, b] = [Math.min(s.anchor, at.vi), Math.max(s.anchor, at.vi)];
      s.sel = new Set();
      for (let i = a; i <= b; i++) if (i < s.view.length) s.sel.add(s.view[i]);
    } else if (ev.metaKey || ev.ctrlKey) {
      if (at.ri >= 0) { if (s.sel.has(at.ri)) s.sel.delete(at.ri); else s.sel.add(at.ri); }
      s.anchor = at.vi;
    } else {
      s.sel = new Set(at.ri >= 0 ? [at.ri] : []);
      s.anchor = at.vi;
    }
    s.focus = { row: at.vi, col: Math.max(0, at.ci) };
    updateSel(); renderToolbar();
    scroller.focus({ preventScroll: true });
  });

  body.addEventListener('dblclick', (ev) => {
    const s = cur();
    const at = cellAt(ev.target);
    if (!s || !at || at.ci < 0) return;
    startEditOrOpen(s, at);
  });

  body.addEventListener('contextmenu', (ev) => {
    const s = cur();
    const at = cellAt(ev.target);
    if (!s || !at || at.ci < 0) return;
    ev.preventDefault();
    if (at.ri >= 0 && !s.sel.has(at.ri)) { s.sel = new Set([at.ri]); s.anchor = at.vi; }
    s.focus = { row: at.vi, col: at.ci };
    updateSel(); renderToolbar();
    const canEdit = s.edit && s.edit.ok && s.edit.editable[at.ci];
    const items = [];
    if (canEdit) items.push(['Edit cell', () => startEditOrOpen(s, at, true)], ['Set NULL', () => stage(s, at, null)]);
    if (at.ri >= 0) items.push(['Open value', () => vscode.postMessage({ type: 'openCell', id: s.id, row: at.ri, col: at.ci })]);
    if (at.ri >= 0) items.push(['Copy value', () => vscode.postMessage({ type: 'copy', id: s.id, rows: [at.ri], cols: [at.ci], format: 'value' })]);
    items.push(['Copy rows as CSV', () => copy('csv')], ['Copy rows as JSON', () => copy('json')], ['Copy rows as Markdown', () => copy('markdown')]);
    if (s.edit && s.edit.ok && at.ri >= 0) items.push([s.staged.deletes.has(at.ri) ? 'Undo delete' : 'Delete row', () => markDelete(s)]);
    if (at.ri < 0) items.push(['Remove new row', () => { s.staged.inserts.splice(-1 - at.ri, 1); renderGrid(true); renderToolbar(); }]);
    openMenu({ getBoundingClientRect: () => ({ left: ev.clientX, bottom: ev.clientY, top: ev.clientY }) }, items);
  });

  scroller.addEventListener('keydown', (ev) => {
    const s = cur();
    if (!s || document.querySelector('.editor')) return;
    const rowsN = s.view.length + s.staged.inserts.length;
    const f = s.focus || { row: 0, col: 0 };
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === 'c') { ev.preventDefault(); copy(s.sel.size > 1 ? 'tsv' : 'value', s.sel.size > 1 ? null : [f.col]); return; }
    if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); s.sel = new Set(s.view); paintRows(); renderToolbar(); return; }
    let moved = true;
    if (ev.key === 'ArrowDown') f.row = Math.min(rowsN - 1, f.row + 1);
    else if (ev.key === 'ArrowUp') f.row = Math.max(0, f.row - 1);
    else if (ev.key === 'ArrowRight') f.col = Math.min(s.columns.length - 1, f.col + 1);
    else if (ev.key === 'ArrowLeft') f.col = Math.max(0, f.col - 1);
    else if (ev.key === 'PageDown') f.row = Math.min(rowsN - 1, f.row + Math.floor(scroller.clientHeight / ROW_H));
    else if (ev.key === 'PageUp') f.row = Math.max(0, f.row - Math.floor(scroller.clientHeight / ROW_H));
    else if (ev.key === 'Home' && mod) f.row = 0;
    else if (ev.key === 'End' && mod) f.row = rowsN - 1;
    else moved = false;
    if (moved) {
      ev.preventDefault();
      s.focus = f;
      const ri = f.row < s.view.length ? s.view[f.row] : -1 - (f.row - s.view.length);
      if (!ev.shiftKey) { s.sel = new Set(ri >= 0 ? [ri] : []); s.anchor = f.row; } else if (ri >= 0) s.sel.add(ri);
      const y = f.row * ROW_H;
      if (y < scroller.scrollTop) scroller.scrollTop = y;
      else if (y + 3 * ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + 3 * ROW_H - scroller.clientHeight;
      paintRows(); renderToolbar();
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'F2') {
      ev.preventDefault();
      const ri = f.row < s.view.length ? s.view[f.row] : -1 - (f.row - s.view.length);
      const el = body.querySelector(`.row[data-v="${f.row}"] .cell[data-c="${f.col}"]`);
      if (el) startEditOrOpen(s, { vi: f.row, ri, ci: f.col, el }, true);
    } else if (ev.key === 'Delete' && s.edit && s.edit.ok && s.sel.size) {
      ev.preventDefault();
      markDelete(s);
    }
  });

  function startEditOrOpen(s, at, forceEdit) {
    const canEdit = s.edit && s.edit.ok && s.edit.editable[at.ci] && !(at.ri >= 0 && s.staged.deletes.has(at.ri));
    if (!canEdit) {
      if (at.ri >= 0) vscode.postMessage({ type: 'openCell', id: s.id, row: at.ri, col: at.ci });
      else toast('This column cannot be edited here.', 'info');
      return;
    }
    const orig = at.ri >= 0 ? s.rows[at.ri][at.ci] : undefined;
    if (orig && typeof orig === 'object' && !forceEdit) { vscode.postMessage({ type: 'openCell', id: s.id, row: at.ri, col: at.ci }); return; }
    if (orig && typeof orig === 'object') { toast('This value is too long to edit in the grid. Use an UPDATE statement.', 'info'); return; }
    const staged = at.ri >= 0 ? s.staged.updates.get(at.ri) : s.staged.inserts[-1 - at.ri].values;
    const curVal = staged && Object.prototype.hasOwnProperty.call(staged, at.ci) ? staged[at.ci] : orig;
    const rect = at.el.getBoundingClientRect();
    const multi = typeof curVal === 'string' && curVal.length > 80;
    const ed = h(multi ? 'textarea' : 'input', { class: 'editor', 'aria-label': `Edit ${s.columns[at.ci].name}` });
    ed.value = curVal === null || curVal === undefined ? '' : String(curVal);
    ed.placeholder = curVal === null ? 'NULL' : '';
    Object.assign(ed.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${Math.max(rect.width, 160)}px`, height: multi ? '120px' : `${rect.height}px` });
    document.body.append(ed);
    ed.focus(); ed.select();
    let closed = false;
    const finish = (save) => {
      if (closed) return;
      closed = true;
      const val = ed.value;
      ed.remove();
      if (save && !(curVal === null && val === '') && val !== (curVal === null || curVal === undefined ? '' : String(curVal))) stage(s, at, val);
      else if (save && curVal === undefined && at.ri < 0 && val !== '') stage(s, at, val);
      scroller.focus({ preventScroll: true });
    };
    ed.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      if (e.key === 'Tab') { e.preventDefault(); finish(true); }
    });
    ed.addEventListener('blur', () => finish(true));
  }

  function stage(s, at, val) {
    if (at.ri >= 0) {
      const orig = s.rows[at.ri][at.ci];
      const u = s.staged.updates.get(at.ri) || {};
      if (val === orig || (val !== null && orig !== null && typeof orig !== 'object' && String(orig) === val)) delete u[at.ci];
      else u[at.ci] = val;
      if (Object.keys(u).length) s.staged.updates.set(at.ri, u); else s.staged.updates.delete(at.ri);
    } else {
      s.staged.inserts[-1 - at.ri].values[at.ci] = val;
    }
    paintRows(); renderToolbar();
  }

  function addRow(s) {
    if (s.localSort || Object.values(s.localFilters || {}).some(Boolean)) { s.localSort = null; s.localFilters = {}; computeView(s); renderGrid(true); }
    s.staged.inserts.push({ values: {} });
    renderGrid(true); renderToolbar();
    scroller.scrollTop = scroller.scrollHeight;
    const vi = s.view.length + s.staged.inserts.length - 1;
    // Start in the first editable column that is not part of the key (keys are often filled by the database).
    const pk = new Set(s.edit.pk || []);
    let firstEditable = s.edit.editable.findIndex((e, i) => e && !pk.has(s.columns[i].name));
    if (firstEditable < 0) firstEditable = Math.max(0, s.edit.editable.findIndex(Boolean));
    s.focus = { row: vi, col: firstEditable };
    requestAnimationFrame(() => {
      paintRows();
      const el = body.querySelector(`.row[data-v="${vi}"] .cell[data-c="${firstEditable}"]`);
      if (el) startEditOrOpen(s, { vi, ri: -s.staged.inserts.length, ci: firstEditable, el }, true);
    });
  }

  function markDelete(s) {
    for (const ri of s.sel) {
      if (ri < 0) continue;
      if (s.staged.deletes.has(ri)) s.staged.deletes.delete(ri); else s.staged.deletes.add(ri);
    }
    paintRows(); renderToolbar();
  }

  function sendEdits(s) {
    const changes = {
      deletes: [...s.staged.deletes],
      updates: [...s.staged.updates.entries()].filter(([ri]) => !s.staged.deletes.has(ri)).map(([row, values]) => ({ row, values })),
      inserts: s.staged.inserts,
    };
    vscode.postMessage({ type: 'edits', id: s.id, changes });
  }

  function showReview(m) {
    const s = st.sets.find((x) => x.id === m.id);
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Review changes' });
    const box = h('div', { class: 'dialog' },
      h('h2', {}, `Save ${m.sql.length} change${m.sql.length === 1 ? '' : 's'}?`),
      h('p', {}, 'These statements run in one transaction. If any of them does not change exactly one row, nothing is saved.'),
      h('pre', { class: 'review-sql' }, m.sql.join('\n')));
    const go = btn('Save in one transaction', 'Run these statements now', () => { overlay.remove(); vscode.postMessage({ type: 'commit', id: m.id, token: m.token }); toast('Saving…', 'info'); }, { primary: true });
    const back = btn('Back', 'Keep editing', () => overlay.remove());
    box.append(h('div', { class: 'dialog-buttons' }, go, back));
    overlay.append(box);
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove(); });
    document.body.append(overlay);
    go.focus();
    if (!s) overlay.remove();
  }

  function onCommitted(m) {
    const s = st.sets.find((x) => x.id === m.id);
    if (m.ok && s) s.staged = newStaged();
    toast(m.message, m.ok ? 'info' : 'error');
    if (!m.ok) showError(m.message);
    renderToolbar();
    if (s && s.id === st.active) paintRows();
  }

  function copy(format, cols) {
    const s = cur();
    if (!s) return;
    const rows = s.sel.size ? s.view.filter((r) => s.sel.has(r)) : s.view;
    const c = cols || (format === 'value' ? [s.focus ? s.focus.col : 0] : null);
    if (format === 'value') {
      const r = s.sel.size ? [...s.sel][0] : s.view[s.focus ? s.focus.row : 0];
      vscode.postMessage({ type: 'copy', id: s.id, rows: [r], cols: c, format });
      return;
    }
    vscode.postMessage({ type: 'copy', id: s.id, rows, format });
  }

  // ---------- small UI parts ----------
  let menu = null;
  function openMenu(anchor, items) {
    closeMenu();
    const r = anchor.getBoundingClientRect();
    menu = h('div', { class: 'menu', role: 'menu' });
    for (const [label, fn] of items) {
      const it = h('button', { class: 'menu-item', role: 'menuitem' }, label);
      it.addEventListener('click', () => { closeMenu(); fn(); });
      menu.append(it);
    }
    document.body.append(menu);
    const mh = menu.offsetHeight;
    const top = r.bottom + mh > window.innerHeight ? Math.max(0, r.top - mh) : r.bottom;
    Object.assign(menu.style, { left: `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 4)}px`, top: `${top}px` });
    const first = menu.querySelector('button');
    if (first) first.focus();
    menu.addEventListener('keydown', (e) => {
      const all = [...menu.querySelectorAll('button')];
      const i = all.indexOf(document.activeElement);
      if (e.key === 'Escape') closeMenu();
      if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length].focus(); }
    });
  }
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); });

  function showError(message, sql) {
    errBox.textContent = '';
    errBox.append(h('strong', {}, 'Error: '), document.createTextNode(message));
    if (sql) errBox.append(h('pre', { class: 'msg-sql' }, sql.length > 400 ? sql.slice(0, 400) + '…' : sql));
    const close = h('button', { class: 'btn close', title: 'Hide' }, '×');
    close.addEventListener('click', hideError);
    errBox.append(close);
    errBox.classList.remove('hidden');
  }
  function hideError() { errBox.classList.add('hidden'); }

  let toastTimer = null;
  function toast(message, level) {
    toastBox.textContent = message;
    toastBox.className = `toast ${level || 'info'}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastBox.classList.add('hidden'), level === 'error' ? 8000 : 3500);
  }

  render();
  vscode.postMessage({ type: 'ready' });
}
