// Webview entry: picks the page (results grid, connection form or ER diagram) from <body data-page>.
import { startGrid } from './grid.js';
import { startForm } from './form.js';
import { startEr } from './er.js';

// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
let data = {};
try { data = JSON.parse(document.getElementById('zovo-data').textContent || '{}'); } catch { data = {}; }
const page = document.body.dataset.page;
if (page === 'form') startForm(vscode, app, data);
else if (page === 'er') startEr(vscode, app, data);
else startGrid(vscode, app, data);
