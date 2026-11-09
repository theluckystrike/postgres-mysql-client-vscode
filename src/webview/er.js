// ER diagram of one schema: tables with their columns, lines for foreign keys. Drag to pan, wheel to zoom,
// drag a table to move it, "Save SVG" writes the picture through the host.
import { h } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 230;
const HEAD = 26;
const LINE = 18;
const MAX_COLS = 24;

function s(tag, attrs, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

export function startEr(vscode, app, data) {
  const tables = data.tables || [];
  const fks = data.fks || [];
  const bar = h('div', { class: 'toolbar' },
    h('strong', {}, `${data.title || 'Schema'}`),
    h('span', { class: 'hint' }, `${tables.length} tables, ${fks.length} foreign keys${data.truncated ? ` (first ${tables.length} shown)` : ''}. Drag to pan, scroll to zoom, drag a table to move it.`));
  const saveBtn = h('button', { class: 'btn' }, 'Save SVG…');
  const fitBtn = h('button', { class: 'btn' }, 'Fit');
  bar.append(fitBtn, saveBtn);
  const wrap = h('div', { class: 'er-wrap' });
  app.append(bar, wrap);
  const svg = s('svg', { class: 'er', xmlns: NS, width: '100%', height: '100%' });
  const view = s('g', {});
  const edges = s('g', { class: 'edges' });
  const nodes = s('g', { class: 'nodes' });
  view.append(edges, nodes);
  svg.append(view);
  wrap.append(svg);

  // Layout: tables with more links first, in columns of similar height.
  const deg = new Map(tables.map((t) => [t.name, 0]));
  for (const f of fks) { deg.set(f.table, (deg.get(f.table) || 0) + 1); deg.set(f.refTable, (deg.get(f.refTable) || 0) + 1); }
  const order = [...tables].sort((a, b) => (deg.get(b.name) - deg.get(a.name)) || a.name.localeCompare(b.name));
  const cols = Math.max(1, Math.ceil(Math.sqrt(order.length * 1.6)));
  const colY = new Array(cols).fill(20);
  const pos = new Map();
  order.forEach((t, i) => {
    const hgt = HEAD + LINE * Math.min(t.columns.length, MAX_COLS) + (t.columns.length > MAX_COLS ? LINE : 0) + 6;
    let c = 0;
    for (let k = 1; k < cols; k++) if (colY[k] < colY[c]) c = k;
    pos.set(t.name, { x: 20 + c * (W + 70), y: colY[c], h: hgt, t });
    colY[c] += hgt + 34;
    void i;
  });

  const groups = new Map();
  for (const t of tables) {
    const p = pos.get(t.name);
    const g = s('g', { class: 'node' + (t.kind === 'view' ? ' view' : ''), transform: `translate(${p.x},${p.y})` });
    g.append(s('rect', { class: 'box', width: W, height: p.h, rx: 4 }));
    g.append(s('rect', { class: 'title', width: W, height: HEAD, rx: 4 }));
    g.append(s('text', { class: 'tname', x: 10, y: 17 }, (t.kind === 'view' ? 'view ' : '') + t.name));
    t.columns.slice(0, MAX_COLS).forEach((c, i) => {
      const y = HEAD + LINE * i + 13;
      g.append(s('text', { class: 'cname' + (c.pk ? ' pk' : ''), x: 10, y }, (c.pk ? '🔑 ' : '') + c.name));
      g.append(s('text', { class: 'ctype', x: W - 8, y, 'text-anchor': 'end' }, String(c.type || '').slice(0, 18)));
    });
    if (t.columns.length > MAX_COLS) g.append(s('text', { class: 'ctype', x: 10, y: HEAD + LINE * MAX_COLS + 13 }, `+ ${t.columns.length - MAX_COLS} more columns`));
    nodes.append(g);
    groups.set(t.name, g);
    dragNode(g, p);
  }

  function colY0(t, name) {
    const i = t.columns.findIndex((c) => c.name === name);
    return HEAD + LINE * (i < 0 || i >= MAX_COLS ? 0 : i) + 9;
  }

  function drawEdges() {
    edges.textContent = '';
    for (const f of fks) {
      const a = pos.get(f.table);
      const b = pos.get(f.refTable);
      if (!a || !b) continue;
      const ya = a.y + colY0(a.t, f.columns[0]);
      const yb = b.y + colY0(b.t, f.refColumns[0]);
      const right = a.x + W < b.x;
      const left = b.x + W < a.x;
      const xa = right ? a.x + W : a.x;
      const xb = right ? b.x : (left ? b.x + W : b.x);
      const dx = Math.max(40, Math.abs(xb - xa) / 2);
      const ca = right ? xa + dx : xa - dx;
      const cb = right ? xb - dx : (left ? xb + dx : xb - dx);
      const path = s('path', { class: 'edge', d: `M${xa},${ya} C${ca},${ya} ${cb},${yb} ${xb},${yb}` });
      path.append(s('title', {}, `${f.table}(${f.columns.join(', ')}) → ${f.refTable}(${f.refColumns.join(', ')})`));
      edges.append(path, s('circle', { class: 'end', cx: xb, cy: yb, r: 3 }));
    }
  }
  drawEdges();

  // pan and zoom
  let tx = 0; let ty = 0; let k = 1;
  const apply = () => view.setAttribute('transform', `translate(${tx},${ty}) scale(${k})`);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left; const my = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    const nk = Math.min(3, Math.max(0.1, k * f));
    tx = mx - (mx - tx) * (nk / k); ty = my - (my - ty) * (nk / k); k = nk;
    apply();
  }, { passive: false });
  let pan = null;
  svg.addEventListener('mousedown', (e) => { if (e.target === svg || e.target.closest('.edges')) pan = { x: e.clientX - tx, y: e.clientY - ty }; });
  window.addEventListener('mousemove', (e) => { if (pan) { tx = e.clientX - pan.x; ty = e.clientY - pan.y; apply(); } });
  window.addEventListener('mouseup', () => { pan = null; });

  function dragNode(g, p) {
    g.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const sx = e.clientX; const sy = e.clientY; const ox = p.x; const oy = p.y;
      const move = (ev) => { p.x = ox + (ev.clientX - sx) / k; p.y = oy + (ev.clientY - sy) / k; g.setAttribute('transform', `translate(${p.x},${p.y})`); drawEdges(); };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  function fit() {
    const b = view.getBBox ? (() => { const save = view.getAttribute('transform'); view.removeAttribute('transform'); const bb = view.getBBox(); if (save) view.setAttribute('transform', save); return bb; })() : { x: 0, y: 0, width: 1000, height: 800 };
    const r = svg.getBoundingClientRect();
    k = Math.min(1.2, Math.max(0.1, Math.min(r.width / (b.width + 40), r.height / (b.height + 40))));
    tx = -b.x * k + 20; ty = -b.y * k + 20;
    apply();
  }
  fitBtn.addEventListener('click', fit);
  requestAnimationFrame(fit);

  saveBtn.addEventListener('click', () => {
    const bb = (() => { const save = view.getAttribute('transform'); view.removeAttribute('transform'); const x = view.getBBox(); if (save) view.setAttribute('transform', save); return x; })();
    const clone = svg.cloneNode(true);
    clone.querySelector('g').removeAttribute('transform');
    clone.setAttribute('viewBox', `${bb.x - 20} ${bb.y - 20} ${bb.width + 40} ${bb.height + 40}`);
    clone.setAttribute('width', String(Math.ceil(bb.width + 40)));
    clone.setAttribute('height', String(Math.ceil(bb.height + 40)));
    const style = '<style>.box{fill:#fff;stroke:#888}.title{fill:#2b5797}.tname{fill:#fff;font:600 12px sans-serif}.cname{font:12px sans-serif;fill:#222}.ctype{font:11px sans-serif;fill:#777}.edge{fill:none;stroke:#2b5797;stroke-width:1.4}.end{fill:#2b5797}.view .title{fill:#6a4c93}</style>';
    vscode.postMessage({ type: 'saveSvg', svg: new XMLSerializer().serializeToString(clone).replace(/^<svg([^>]*)>/, `<svg$1>${style}`) });
  });
  vscode.postMessage({ type: 'ready' });
}
