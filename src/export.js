'use strict';
// Streamed export to CSV, JSON or SQL INSERT. Rows go from the server to the file in batches of 5,000 with
// back-pressure, so a 5-million-row table never sits in memory.

const fs = require('fs');
const { csvLine, jsonValue } = require('./core/values');
const { insertLine } = require('./core/dialect');

const FORMATS = [
  { id: 'csv', label: 'CSV', ext: 'csv', description: 'comma-separated, header row, UTF-8' },
  { id: 'json', label: 'JSON', ext: 'json', description: 'an array of objects' },
  { id: 'sql', label: 'SQL INSERT', ext: 'sql', description: 'one INSERT statement per row' },
];

/**
 * session.exportQuery streams rows; this writes them.
 * opts: {format, file, table, dialect, shouldStop, onProgress(rows)}
 */
async function exportToFile(session, sql, opts) {
  const out = fs.createWriteStream(opts.file, { encoding: 'utf8' });
  let failed = null;
  out.on('error', (e) => { failed = e; });
  const write = (s) => new Promise((resolve, reject) => {
    if (failed) { reject(failed); return; }
    if (out.write(s)) resolve(); else out.once('drain', resolve);
  });
  let first = true;
  let total = 0;
  try {
    const res = await session.exportQuery(sql, async (columns, rows) => {
      const names = columns.map((c) => c.name);
      let chunk = '';
      if (first) {
        if (opts.format === 'csv') chunk += csvLine(names);
        else if (opts.format === 'json') chunk += '[\n';
      }
      for (const row of rows) {
        if (opts.format === 'csv') chunk += csvLine(row);
        else if (opts.format === 'json') {
          const o = {};
          names.forEach((n, i) => { o[n] = jsonValue(row[i], columns[i].kind); });
          chunk += (first ? '' : ',\n') + JSON.stringify(o);
          first = false;
        } else chunk += insertLine(opts.table || 'query_result', names, row, opts.dialect);
        first = false;
      }
      total += rows.length;
      await write(chunk);
      if (opts.onProgress) opts.onProgress(total);
    }, opts.shouldStop);
    if (opts.format === 'json') await write(total ? '\n]\n' : '[]\n');
    else if (opts.format === 'csv' && total === 0 && res.columns.length) await write(csvLine(res.columns.map((c) => c.name)));
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (failed) throw failed;
    return { rows: total, stopped: !!(opts.shouldStop && opts.shouldStop()) };
  } catch (e) {
    out.destroy();
    throw e;
  }
}

module.exports = { exportToFile, FORMATS };
