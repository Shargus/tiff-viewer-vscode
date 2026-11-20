import { copyFileSync, mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  legalComments: 'none',
};

const builds = [
  // Extension host (Node.js)
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    // Prefer ES module builds: jsonc-parser's default UMD build require()s its
    // own files at run time, which a bundle cannot satisfy.
    mainFields: ['module', 'main'],
  },
  // Webview UI
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114',
  },
  // Decoder worker running inside the webview
  {
    ...common,
    entryPoints: ['src/webview/worker.ts'],
    outfile: 'dist/webview/worker.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114',
  },
];

// Loaded by the webview only when needed: MapLibre (vector basemaps) and SQLite (GeoPackage).
const assets = [
  ['node_modules/maplibre-gl/dist/maplibre-gl.js', 'dist/webview/maplibre-gl.js'],
  ['node_modules/sql.js/dist/sql-wasm-browser.wasm', 'dist/webview/sql-wasm.wasm'],
];
mkdirSync('dist/webview', { recursive: true });
for (const [from, to] of assets) copyFileSync(from, to);

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
