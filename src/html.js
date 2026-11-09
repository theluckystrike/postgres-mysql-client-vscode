'use strict';
// Webview HTML with a strict CSP: default-src 'none', scripts by nonce only, no remote anything.
// Kept free of the vscode module so tests can check the CSP.

const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function nonce() {
  return crypto.randomBytes(24).toString('base64url');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * p: {cspSource, scriptUri, styleUri, title, showSupportLinks, page, data}
 * page names the webview script's view ('grid', 'form', 'er'); data is JSON for the first render.
 */
function buildHtml(p) {
  const n = p.nonce || nonce();
  const footer = p.footer === false ? '' : footerHtml('zovoSql', p.showSupportLinks !== false, '');
  const csp = [
    "default-src 'none'",
    `style-src ${p.cspSource} 'nonce-${n}'`,
    `script-src 'nonce-${n}'`,
    `img-src ${p.cspSource} blob: data:`,
    `font-src ${p.cspSource}`,
  ].join('; ');
  const data = JSON.stringify(p.data || {}).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.styleUri)}">
<style nonce="${n}">${FOOTER_CSS}</style>
<title>${escapeAttr(p.title)}</title>
</head>
<body data-page="${escapeAttr(p.page || 'grid')}">
<div id="app"></div>
${footer}
<script nonce="${n}" type="application/json" id="zovo-data">${data}</script>
<script nonce="${n}" src="${escapeAttr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, escapeAttr, nonce };
