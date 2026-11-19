// Band composite tests: expressions, presets, GDAL band descriptions, LZW and
// composite rendering. Runs under Node:  npm test
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist', 'test', 'composite.mjs');
mkdirSync(dirname(bundle), { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      `export * from './src/shared/expression.ts';`,
      `export * from './src/shared/presets.ts';`,
      `export * from './src/shared/colormaps.ts';`,
      `export * from './src/webview/composite.ts';`,
      `export { lzwDecode } from './src/webview/lzw.ts';`,
      `export { parseBandDescriptions, openTiff, readRegion } from './src/webview/tiff.ts';`,
      `export { MessageSource } from './src/webview/messageSource.ts';`,
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'error',
});
const lib = await import(pathToFileURL(bundle).href);

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.log(`  ✗ ${name}\n    ${error.stack.split("\n").slice(0, 12).join("\n    ")}`);
  }
}

const close = (a, b, eps = 1e-5) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const evalOne = (source, bands, data, noData = null) => {
  const compiled = lib.compileExpressions([source], bands);
  return Array.from(compiled.evaluate(compiled.samples.map((s) => data[s]), data[0]?.length ?? 1, noData)[0]);
};

console.log('Expressions');
await test('arithmetic and precedence', () => {
  const bands = { a: 0, b: 1 };
  const data = [Float32Array.of(2, 4), Float32Array.of(3, 1)];
  assert.deepEqual(evalOne('a + b * 2', bands, data), [8, 6]);
  assert.deepEqual(evalOne('(a + b) * 2', bands, data), [10, 10]);
  assert.deepEqual(evalOne('-a ^ 2', bands, data), [-4, -16]);
  assert.deepEqual(evalOne('2 ^ 3 ^ 2', bands, data), [512, 512]);
  assert.deepEqual(evalOne('a ** 2 - 1e1', bands, data), [-6, 6]);
  assert.deepEqual(evalOne('a % 3', bands, data), [2, 1]);
  assert.deepEqual(evalOne('.5 * a', bands, data), [1, 2]);
});
await test('NDVI', () => {
  const bands = { B04: 0, B08: 1 };
  const out = evalOne('(B08 - B04) / (B08 + B04)', bands, [Uint16Array.of(1000, 500), Uint16Array.of(3000, 500)]);
  assert.ok(close(out[0], 0.5) && out[1] === 0);
});
await test('functions and comparisons', () => {
  const bands = { x: 0 };
  const data = [Float32Array.of(-4, 0, 9, 100)];
  assert.deepEqual(evalOne('abs(x)', bands, data), [4, 0, 9, 100]);
  assert.deepEqual(evalOne('clamp(x, 0, 10)', bands, data), [0, 0, 9, 10]);
  assert.deepEqual(evalOne('max(x, 1, 5)', bands, data), [5, 5, 9, 100]);
  assert.deepEqual(evalOne('x > 0', bands, data), [0, 0, 1, 1]);
  assert.deepEqual(evalOne('where(x >= 9, x, -1)', bands, data), [-1, -1, 9, 100]);
  assert.deepEqual(evalOne('log10(x)', bands, data).slice(2), [Math.log10(9), 2].map(Math.fround));
  assert.deepEqual(evalOne('2 * pi', bands, data), new Array(4).fill(Math.fround(2 * Math.PI)));
});
await test('no data becomes NaN, and stays NaN through min/max/where', () => {
  const out = evalOne('max(x, 0) + where(x, 1, 2)', { x: 0 }, [Int16Array.of(-32768, 5)], -32768);
  assert.ok(Number.isNaN(out[0]));
  assert.equal(out[1], 6);
});
await test('constant expression and repeated band', () => {
  const compiled = lib.compileExpressions(['0.5', 'b1 * b1', 'b1'], { b1: 2 });
  assert.deepEqual(compiled.samples, [2]);
  const [c, sq, same] = compiled.evaluate([Uint8Array.of(3, 4)], 2, null);
  assert.deepEqual(Array.from(c), [0.5, 0.5]);
  assert.deepEqual(Array.from(sq), [9, 16]);
  same[0] = 99; // results must not share storage
  assert.deepEqual(Array.from(sq), [9, 16]);
});
await test('errors name the problem, the position and the expression', () => {
  const bad = (sources, pattern, index) => {
    assert.throws(
      () => lib.compileExpressions(sources, { b1: 0 }),
      (e) => e instanceof lib.ExpressionError && pattern.test(e.message) && (index === undefined || e.index === index),
    );
  };
  bad(['B04'], /Unknown band 'B04'/);
  bad(['b1', 'foo(b1)'], /Unknown function 'foo'/, 1);
  bad(['(b1 + 1'], /Missing '\)'/);
  bad(['b1 +'], /Incomplete expression/);
  bad(['b1 b1'], /Unexpected 'b1'/);
  bad(['b1 $ 2'], /Unexpected character '\$'/);
  bad(['clamp(b1, 0)'], /clamp\(\) takes 3 arguments/);
  bad([''], /Empty expression/);
});
await test('band identifiers from descriptions', () => {
  assert.equal(lib.bandIdentifier('B04'), 'B04');
  assert.equal(lib.bandIdentifier(' Band 1 '), 'Band_1');
  assert.equal(lib.bandIdentifier('8A'), '_8A');
  assert.equal(lib.bandIdentifier('log'), undefined);
  assert.equal(lib.bandIdentifier('---'), undefined);
});

console.log('Presets');
await test('band variables: bN, then preset names, then descriptions win', () => {
  const vars = lib.bandVariables(4, ['B02', null, 'B04', null], { B04: 4, B08: 4, B99: 9 });
  assert.equal(vars.b1, 0);
  assert.equal(vars.b4, 3);
  assert.equal(vars.B02, 0);
  assert.equal(vars.B04, 2, 'the file description wins over the preset');
  assert.equal(vars.B08, 3);
  const l2a = lib.bandVariables(3, ['B11', 'B12', null], { B10: 1, B11: 2, B12: 3 });
  assert.equal(l2a.B10, undefined, 'a preset name for a band the file names otherwise is ignored');
  assert.equal(l2a.B11, 0);
  assert.equal(l2a.B12, 1, 'the file description wins');
  assert.equal(vars.B99, undefined, 'out of range');
});
await test('ranges: single, per channel, auto', () => {
  assert.deepEqual(lib.presetRanges({ name: 'x', red: 'b1' }, 3), [[0, 1], [0, 1], [0, 1]]);
  assert.deepEqual(lib.presetRanges({ name: 'x', red: 'b1', range: [0, 3000] }, 3), [[0, 3000], [0, 3000], [0, 3000]]);
  assert.deepEqual(lib.presetRanges({ name: 'x', red: 'b1', range: 'auto' }, 3), [null, null, null]);
  assert.deepEqual(lib.presetRanges({ name: 'x', red: 'b1', range: [[-25, 0], 'auto'] }, 3), [[-25, 0], null, [0, 1]]);
});
await test('expressions: RGB with defaults, or single value', () => {
  assert.deepEqual(lib.presetExpressions({ name: 'x', red: 'b1' }), ['b1', '0', '0']);
  assert.deepEqual(lib.presetExpressions({ name: 'x', value: 'b2' }), ['b2']);
});
await test('built-in Sentinel-2 presets compile for common layouts', () => {
  for (const count of [4, 10, 12, 13]) {
    for (const preset of lib.builtinPresets(count).filter((p) => p.name.startsWith('Sentinel-2'))) {
      if (count === 4 && /SWIR/.test(preset.name)) continue; // no SWIR bands in 10 m stacks
      const spec = lib.compositeSpec(preset, count, new Array(count).fill(null));
      lib.compileExpressions(spec.expressions, spec.bands);
    }
  }
  const l2a = lib.compositeSpec(lib.builtinPresets(12)[2], 12, new Array(12).fill(null));
  assert.equal(l2a.bands.B12, 11);
});
await test('user presets replace built-ins of the same name', () => {
  const all = lib.allPresets([{ name: 'Sentinel-2 NDVI', value: 'b1' }], 13);
  const ndvi = all.filter((p) => p.preset.name === 'Sentinel-2 NDVI');
  assert.equal(ndvi.length, 1);
  assert.equal(ndvi[0].builtin, false);
  assert.equal(all[0].preset.name, 'Sentinel-2 NDVI', 'user presets first');
});
await test('auto-apply rules', () => {
  const p = (match) => ({ name: 'x', value: 'b1', match });
  assert.equal(lib.presetMatches(p(undefined), 'a.tif', 13), false);
  assert.equal(lib.presetMatches(p({}), 'a.tif', 13), false);
  assert.equal(lib.presetMatches(p({ bands: 13 }), 'a.tif', 13), true);
  assert.equal(lib.presetMatches(p({ bands: [12, 13] }), 'a.tif', 12), true);
  assert.equal(lib.presetMatches(p({ bands: 13 }), 'a.tif', 2), false);
  assert.equal(lib.presetMatches(p({ fileName: 'S2*_T*.TIF' }), 's2a_x_t18.tif', 1), true);
  assert.equal(lib.presetMatches(p({ fileName: ['*_a150.tif', '*_d069.tif'], bands: 2 }), '2019_d069.tif', 2), true);
  assert.equal(lib.presetMatches(p({ fileName: 'S2?.tif' }), 'S2AB.tif', 1), false);
  assert.equal(lib.presetMatches(p({ fileName: 'a+b(1).tif' }), 'a+b(1).tif', 1), true, 'regex characters are literal');
});
await test('sanitizing hand-written settings', () => {
  const kept = lib.sanitizePresets([{ name: 'ok', red: 'b1' }, { name: '', value: 'b1' }, { value: 'b1' }, { name: 'none' }, null, 'x']);
  assert.deepEqual(kept.map((p) => p.name), ['ok']);
  assert.deepEqual(lib.sanitizePresets({}), []);
});

console.log('GDAL band descriptions');
await test('parses descriptions, ignores other items, decodes entities', () => {
  const xml = `<GDALMetadata>
  <Item name="DESCRIPTION" sample="0" role="description">B01</Item>
  <Item name="SCALE" sample="0" role="scale">0.0001</Item>
  <Item role="description" sample="2" name="DESCRIPTION">NIR &amp; red</Item>
  <Item name="DESCRIPTION" sample="9" role="description">out of range</Item>
  <Item name="resolution">10</Item>
</GDALMetadata>`;
  assert.deepEqual(lib.parseBandDescriptions(xml, 3), ['B01', null, 'NIR & red']);
  assert.deepEqual(lib.parseBandDescriptions('', 2), [null, null]);
});

console.log('LZW');
// Reference TIFF LZW encoder (MSB-first, early change), to check the decoder on
// clear codes, code width changes and the KwKwK case.
function lzwEncode(input, clearEvery = Infinity) {
  const out = [];
  let bits = 0, count = 0;
  const emit = (code, width) => {
    bits = (bits << width) | code;
    count += width;
    while (count >= 8) {
      out.push((bits >>> (count - 8)) & 255);
      count -= 8;
    }
    bits &= (1 << count) - 1;
  };
  let table = new Map();
  let next = 258, width = 9, emitted = 0;
  const reset = () => { table = new Map(); next = 258; width = 9; };
  emit(256, 9);
  let w = '';
  for (const byte of input) {
    const wc = w + String.fromCharCode(byte);
    if (w === '' || table.has(wc)) { w = wc; continue; }
    emit(w.length === 1 ? w.charCodeAt(0) : table.get(w), width);
    emitted++;
    table.set(wc, next++);
    if (next >= 1 << width) width++; // libtiff: free_ent > maxcode
    w = String.fromCharCode(byte);
    if (next >= 4093 || emitted >= clearEvery) { emit(w.length === 1 ? w.charCodeAt(0) : table.get(w), width); w = ''; emit(256, width); reset(); emitted = 0; }
  }
  if (w) emit(w.length === 1 ? w.charCodeAt(0) : table.get(w), width);
  emit(257, width);
  if (count) out.push((bits << (8 - count)) & 255);
  return Uint8Array.from(out);
}
await test('round trip: random, repetitive (KwKwK) and long inputs, with clear codes', () => {
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const inputs = [
    Uint8Array.from({ length: 1000 }, () => Math.floor(rand() * 256)),
    new Uint8Array(5000).fill(7),
    Uint8Array.from({ length: 200000 }, (_, i) => (i % 97) ^ Math.floor(rand() * 4)),
    Uint8Array.of(),
  ];
  for (const input of inputs) {
    for (const clearEvery of [Infinity, 100]) {
      const decoded = lib.lzwDecode(lzwEncode(input, clearEvery), input.length);
      assert.equal(decoded.length, input.length);
      assert.ok(decoded.every((v, i) => v === input[i]));
    }
  }
});
await test('grows the output when the expected size is too small, and stops at the end of data', () => {
  const input = Uint8Array.from({ length: 10000 }, (_, i) => i % 13);
  assert.equal(lib.lzwDecode(lzwEncode(input), 10).length, 10000);
  const truncated = lzwEncode(input).slice(0, 50);
  assert.ok(lib.lzwDecode(truncated).length > 0);
});

console.log('Composite rendering');
await test('RGB with ranges, gamma and no data', () => {
  const spec = { expressions: ['b1', 'b2', 'b3'], bands: {}, ranges: [[0, 100], [0, 100], [0, 100]], colormap: 'gray', gamma: 1 };
  const nan = NaN;
  const rgba = lib.compositeToRGBA(spec, [Float32Array.of(0, 50, 200, nan), Float32Array.of(100, 50, -5, nan), Float32Array.of(25, nan, 0, nan)], 4, 'minmax');
  assert.deepEqual(Array.from(rgba.subarray(0, 4)), [0, 255, 64, 255]);
  assert.deepEqual(Array.from(rgba.subarray(4, 8)), [128, 128, 0, 255], 'a single NaN channel shows as 0');
  assert.deepEqual(Array.from(rgba.subarray(8, 12)), [255, 0, 0, 255], 'clamped');
  assert.equal(rgba[15], 0, 'all NaN: transparent');
  const bright = lib.compositeToRGBA({ ...spec, gamma: 2 }, [Float32Array.of(25), Float32Array.of(25), Float32Array.of(25)], 1, 'minmax');
  assert.ok(Math.abs(bright[0] - 128) <= 1, 'gamma 2 maps 0.25 to 0.5');
});
await test('single band through a colour map, with auto range from statistics', () => {
  const spec = { expressions: ['b1'], bands: {}, ranges: [null], colormap: 'viridis', gamma: 1 };
  const values = Float32Array.from({ length: 101 }, (_, i) => i);
  const stats = lib.channelStats([values]);
  assert.deepEqual([stats[0].min, stats[0].max, stats[0].p02, stats[0].p98], [0, 100, 2, 98]);
  const rgba = lib.compositeToRGBA(spec, [values], 101, 'minmax', stats);
  const table = lib.colormapTable('viridis');
  assert.deepEqual(Array.from(rgba.subarray(0, 3)), Array.from(table.subarray(0, 3)));
  assert.deepEqual(Array.from(rgba.subarray(400, 403)), Array.from(table.subarray(765, 768)));
  const pct = lib.compositeToRGBA(spec, [values], 101, 'percentile', stats);
  assert.deepEqual(Array.from(pct.subarray(8, 11)), Array.from(table.subarray(0, 3)), 'p02 maps to the bottom');
  assert.deepEqual(Array.from(lib.colormapTable('viridis_r').subarray(0, 3)), Array.from(table.subarray(765, 768)));
});

// End to end on a generated 5-band uint16 GeoTIFF with band descriptions (Deflate, two strips).
console.log('End to end');
await test('reads only the bands a composite uses, with band names from the file', async () => {
  const tiffLib = lib;
  const width = 8, height = 6, bands = 5;
  const pixels = new Uint16Array(width * height * bands);
  for (let i = 0; i < width * height; i++) for (let b = 0; b < bands; b++) pixels[i * bands + b] = (b + 1) * 1000 + i;
  pixels.fill(0, 0, bands); // pixel 0: no data in every band
  const names = ['B02', 'B03', 'B04', 'B08', 'SCL'];
  const xml = `<GDALMetadata>${names.map((n, i) => `<Item name="DESCRIPTION" sample="${i}" role="description">${n}</Item>`).join('')}</GDALMetadata>\0`;
  const file = buildTiff({ width, height, bands, pixels, xml, noData: '0\0' });
  const source = new tiffLib.MessageSource(file.byteLength, async (ranges) => ranges.map(({ offset, length }) => file.slice(offset, offset + length).buffer));
  const tiff = await tiffLib.openTiff(source);
  const page = tiff.pages[0];
  assert.deepEqual(page.info.bandNames, names);
  assert.deepEqual(page.info.sampleLabels, names);
  const spec = lib.compositeSpec({ name: 't', red: 'B04 / 10000', green: 'B03 / 10000', blue: 'B02 / 10000' }, bands, page.info.bandNames);
  const compiled = lib.compileExpressions(spec.expressions, spec.bands);
  assert.deepEqual(compiled.samples, [2, 1, 0]);
  const region = await tiffLib.readRegion(page, page.images[0], [0, 0, width, height], width, height, { samples: compiled.samples });
  const channels = compiled.evaluate(region.data, width * height, page.info.noData);
  const rgba = lib.compositeToRGBA(spec, channels, width * height, 'minmax');
  assert.equal(rgba[3], 0, 'no-data pixel is transparent');
  assert.deepEqual(Array.from(rgba.subarray(4 * 9, 4 * 9 + 4)), [Math.round(3009 * 0.0255), Math.round(2009 * 0.0255), Math.round(1009 * 0.0255), 255]);
});

/** A minimal little-endian TIFF: uint16, pixel-interleaved, Deflate, two strips, GDAL metadata and nodata tags. */
function buildTiff({ width, height, bands, pixels, xml, noData }) {
  const rowsPerStrip = Math.ceil(height / 2);
  const bytes = new Uint8Array(pixels.buffer);
  const rowBytes = width * bands * 2;
  const strips = [0, 1].map((s) => deflateSync(bytes.subarray(s * rowsPerStrip * rowBytes, Math.min(height, (s + 1) * rowsPerStrip) * rowBytes)));
  const entries = [];
  const extra = [];
  let extraOffset = 0;
  const tagData = (data) => { const offset = extraOffset; extra.push(data); extraOffset += data.length + (data.length & 1); if (data.length & 1) extra.push(new Uint8Array(1)); return offset; };
  const u16s = (values) => new Uint8Array(Uint16Array.from(values).buffer);
  const u32s = (values) => new Uint8Array(Uint32Array.from(values).buffer);
  const ascii = (text) => new TextEncoder().encode(text);
  const add = (tag, type, count, value) => entries.push({ tag, type, count, value });
  add(256, 3, 1, width);
  add(257, 3, 1, height);
  add(258, 3, bands, { data: u16s(new Array(bands).fill(16)) });
  add(259, 3, 1, 8);
  add(262, 3, 1, 1);
  add(273, 4, 2, { strips: true });
  add(277, 3, 1, bands);
  add(278, 3, 1, rowsPerStrip);
  add(279, 4, 2, { data: u32s(strips.map((s) => s.length)) });
  add(284, 3, 1, 1);
  add(338, 3, bands - 1, { data: u16s(new Array(bands - 1).fill(0)) });
  add(339, 3, bands, { data: u16s(new Array(bands).fill(1)) });
  add(42112, 2, ascii(xml).length, { data: ascii(xml) });
  add(42113, 2, ascii(noData).length, { data: ascii(noData) });
  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  const extraBase = ifdOffset + ifdSize;
  const resolved = entries.map((e) => (e.value?.data ? { ...e, offset: tagData(e.value.data) } : e));
  const stripOffsetsAt = tagData(new Uint8Array(8));
  const extraBytes = new Uint8Array(extraOffset);
  let pos = 0;
  for (const chunk of extra) { extraBytes.set(chunk, pos); pos += chunk.length; }
  const dataBase = extraBase + extraBytes.length;
  const offsets = [dataBase, dataBase + strips[0].length];
  extraBytes.set(u32s(offsets), stripOffsetsAt);
  const out = new Uint8Array(dataBase + strips[0].length + strips[1].length);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries.length, true);
  resolved.forEach((e, i) => {
    const at = ifdOffset + 2 + i * 12;
    view.setUint16(at, e.tag, true);
    view.setUint16(at + 2, e.type, true);
    view.setUint32(at + 4, e.count, true);
    if (e.value?.strips) view.setUint32(at + 8, extraBase + stripOffsetsAt, true);
    else if (e.value?.data) {
      if (e.value.data.length <= 4) out.set(e.value.data, at + 8);
      else view.setUint32(at + 8, extraBase + e.offset, true);
    } else if (e.type === 3) view.setUint16(at + 8, e.value, true);
    else view.setUint32(at + 8, e.value, true);
  });
  out.set(extraBytes, extraBase);
  out.set(strips[0], dataBase);
  out.set(strips[1], dataBase + strips[0].length);
  return out;
}

if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll composite tests passed');
