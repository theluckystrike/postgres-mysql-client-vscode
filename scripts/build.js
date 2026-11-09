'use strict';
// Bundles the extension host and the webview with esbuild, and copies the sql.js wasm next to them.
// pg, pg-cursor, mysql2 and sql.js are pure JavaScript (plus sql.js's wasm): no native module ships.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: !prod, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/sql.js/dist/sql-wasm.wasm'), path.join(root, 'dist/sql-wasm.wasm'));
Promise.all([
  esbuild.build({
    ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18',
    // pg-native is an optional native addon that pg only loads when asked; cloudflare:sockets is for Workers.
    external: ['vscode', 'pg-native', 'cloudflare:sockets'],
  }),
  esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
]).catch(() => process.exit(1));
