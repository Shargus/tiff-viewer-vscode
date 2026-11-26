// Presets file tests: runs src/presetStore.ts under Node with a minimal fake
// `vscode` module and HOME pointed at a temporary folder.   npm test
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'tiff-presets-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

// The parts of the vscode API the store uses, recording what it shows.
const fakeVscode = `
  export const shown = { warnings: [], errors: [], opened: [] };
  export const watchers = [];
  export class EventEmitter {
    listeners = [];
    event = (listener) => { this.listeners.push(listener); return { dispose() {} }; };
    fire(value) { this.listeners.forEach((l) => l(value)); }
    dispose() {}
  }
  export const Uri = { file: (path) => ({ fsPath: path, path }) };
  export class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
  const event = (list) => (listener) => { list.push(listener); return { dispose() {} }; };
  export const workspace = {
    createFileSystemWatcher(pattern) {
      const w = { pattern, change: [], dispose() {} };
      w.onDidChange = event(w.change); w.onDidCreate = event(w.change); w.onDidDelete = event(w.change);
      watchers.push(w);
      return w;
    },
  };
  export const window = {
    showWarningMessage: async (message) => { shown.warnings.push(message); return undefined; },
    showErrorMessage: async (message) => { shown.errors.push(message); return undefined; },
    showTextDocument: async (uri) => { shown.opened.push(uri.fsPath); },
  };
`;
const bundle = join(root, 'dist', 'test', 'presetStore.mjs');
await esbuild.build({
  stdin: { contents: `export * from './src/presetStore.ts'; export * as vscode from 'vscode';`, resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  outfile: bundle,
  logLevel: 'error',
  plugins: [
    {
      name: 'fake-vscode',
      setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fake' }));
        build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: fakeVscode, loader: 'js' }));
      },
    },
  ],
});
const lib = await import(pathToFileURL(bundle).href);
const file = join(home, '.tiff-viewer-vscode', 'presets.jsonc');
const text = () => readFileSync(file, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.log(`  ✗ ${name}\n    ${error.stack.split('\n').slice(0, 8).join('\n    ')}`);
  }
}

console.log('Presets file');
const store = new lib.PresetStore();
const changes = [];
store.onDidChange((presets) => changes.push(presets.map((p) => p.name)));

await test('lives in ~/.tiff-viewer-vscode and is created with documentation on first run', async () => {
  assert.equal(lib.PRESETS_FILE, file);
  await store.init();
  assert.match(text(), /^\/\/ Band rendering presets/);
  assert.match(text(), /"presets": \[/);
  assert.deepEqual(store.get(), []);
  assert.equal(lib.vscode.watchers[0].pattern.base.fsPath, join(home, '.tiff-viewer-vscode'));
  assert.equal(lib.vscode.watchers[0].pattern.pattern, 'presets.jsonc');
});

await test('saving adds a preset and keeps the comments', async () => {
  assert.equal(await store.save({ name: 'S2 RGB', red: 'B04 / 3000', green: 'B03 / 3000', blue: 'B02 / 3000' }), true);
  assert.match(text(), /^\/\/ Band rendering presets/, 'header kept');
  assert.match(text(), /\/\/   "name": "Sentinel-2 true colour \(bright\)"/, 'commented example kept');
  assert.deepEqual(store.get().map((p) => p.name), ['S2 RGB']);
  await store.save({ name: 'NDVI', value: '(B08 - B04) / (B08 + B04)', range: [-1, 1], colormap: 'RdYlGn' });
  assert.deepEqual(store.get().map((p) => p.name), ['S2 RGB', 'NDVI']);
  assert.deepEqual(changes.at(-1), ['S2 RGB', 'NDVI']);
});

await test('saving a preset with an existing name replaces it in place', async () => {
  await store.save({ name: 'S2 RGB', red: 'B04 / 2500', green: 'B03 / 2500', blue: 'B02 / 2500', match: { bands: 13 } });
  assert.deepEqual(store.get().map((p) => p.name), ['S2 RGB', 'NDVI']);
  assert.equal(store.get()[0].red, 'B04 / 2500');
  assert.equal((text().match(/"S2 RGB"/g) ?? []).length, 1);
});

await test('variables made in the Rendering panel are saved and read back as made, in order', async () => {
  // As the viewer sends it: a variable dragged to the top, one using another, a variable named like a channel.
  const preset = {
    name: 'Vars',
    variables: { green: 'clamp(B03 / 3000, 0, 1)', v1: 'B04 / 10000', v2: 'clamp(v1 * 3, 0, 1)' },
    red: 'v2',
    green: 'green',
    blue: 'v1 * 2',
  };
  assert.equal(await store.save(preset), true);
  const saved = store.get().find((p) => p.name === 'Vars');
  assert.deepEqual(saved, preset);
  assert.deepEqual(Object.keys(saved.variables), ['green', 'v1', 'v2'], 'order kept');
  // As written in the file, and as a new store reads it.
  assert.match(text(), /"variables": \{\s*"green": "clamp\(B03 \/ 3000, 0, 1\)",\s*"v1": "B04 \/ 10000",\s*"v2": "clamp\(v1 \* 3, 0, 1\)"\s*\}/);
  const fresh = new lib.PresetStore();
  await fresh.init();
  assert.deepEqual(Object.keys(fresh.get().find((p) => p.name === 'Vars').variables), ['green', 'v1', 'v2']);
  fresh.dispose();
  await store.delete('Vars');
});

await test('hand edits (comments, trailing commas) are read, and survive the next save', async () => {
  writeFileSync(
    file,
    text().replace('"presets": [', '"presets": [\n    // my favourite\n    { "name": "VV dB", "value": "VV / 100", "range": [-25, 0], },'),
  );
  lib.vscode.watchers[0].change.forEach((f) => f());
  await sleep(300);
  assert.deepEqual(store.get().map((p) => p.name), ['VV dB', 'S2 RGB', 'NDVI']);
  await store.delete('NDVI');
  assert.match(text(), /\/\/ my favourite/);
  assert.deepEqual(store.get().map((p) => p.name), ['VV dB', 'S2 RGB']);
});

await test('a syntax error keeps the last valid presets, is reported once, and blocks saving', async () => {
  const before = text();
  writeFileSync(file, before.replace('"VV dB",', '"VV dB"'));
  const warnings = lib.vscode.shown.warnings.length;
  lib.vscode.watchers[0].change.forEach((f) => f());
  await sleep(300);
  lib.vscode.watchers[0].change.forEach((f) => f());
  await sleep(300);
  assert.deepEqual(store.get().map((p) => p.name), ['VV dB', 'S2 RGB']);
  assert.equal(lib.vscode.shown.warnings.length, warnings + 1);
  assert.match(lib.vscode.shown.warnings.at(-1), /presets\.jsonc line \d+/);
  assert.equal(await store.save({ name: 'x', value: 'b1' }), false);
  assert.ok(!text().includes('"x"'), 'file untouched');
  writeFileSync(file, before);
});

await test('an emptied file starts again from the template; a bare array also works', async () => {
  writeFileSync(file, '');
  await store.save({ name: 'A', value: 'b1' });
  assert.match(text(), /^\/\/ Band rendering presets/);
  assert.deepEqual(store.get().map((p) => p.name), ['A']);
  writeFileSync(file, '[{ "name": "B", "value": "b2" }]');
  await store.save({ name: 'C', value: 'b3' });
  assert.deepEqual(JSON.parse(text()).map((p) => p.name), ['B', 'C']);
  await store.delete('B');
  assert.deepEqual(JSON.parse(text()).map((p) => p.name), ['C']);
});

await test('an existing file is never overwritten by the template', async () => {
  writeFileSync(file, '{ "presets": [{ "name": "keep", "value": "b1" }] }');
  const other = new lib.PresetStore();
  await other.init();
  assert.deepEqual(other.get().map((p) => p.name), ['keep']);
  assert.equal(text(), '{ "presets": [{ "name": "keep", "value": "b1" }] }');
  other.dispose();
});

store.dispose();
rmSync(home, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll presets file tests passed');
