// Overlay tests: map projections, tile grids, vector geometry decoding and the
// georeferencing of the overlay pipeline, against values computed by GDAL.
//   npm test
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist', 'test', 'overlays.mjs');
mkdirSync(dirname(bundle), { recursive: true });
await esbuild.build({
  stdin: {
    contents: [
      `export * from './src/webview/geo.ts';`,
      `export * from './src/webview/tilegrid.ts';`,
      `export { parseWkb, parseGpkgGeometry, epsgToProj4 } from './src/webview/vectors.ts';`,
      `export { prepareStyle } from './src/webview/basemap.ts';`,
      `export { BASEMAP_PROVIDERS } from './src/shared/basemaps.ts';`,
      `export { toBytes } from './src/webview/bytes.ts';`,
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
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
    console.log(`  ✗ ${name}\n    ${error.stack.split('\n').slice(0, 6).join('\n    ')}`);
  }
}
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

// The georeferencing of the user's Sentinel-2 tiles: UTM 18N, 10 m, origin (580920, 400570).
const geo = {
  transform: [580920, 10, 0, 400570, 0, -10],
  proj4: '+proj=tmerc +lat_0=0 +lon_0=-75 +k_0=0.9996 +x_0=500000 +y_0=0 +ellps=WGS84 +units=m +no_defs',
  factors: { x: 1, y: 1 },
  crsName: 'EPSG:32618',
  geographic: false,
};

console.log('Projections');
await test('image pixels to longitude/latitude and back, as GDAL (gdaltransform)', () => {
  const mapper = new lib.GeoMapper(geo);
  // gdalinfo: Upper Left (580920, 400570) = 74°16'16.91"W, 3°37'25.46"N; Lower Right (605060, 371430) = 74°3'15.41"W, 3°21'35.80"N.
  const dms = (d, m, s) => d + m / 60 + s / 3600;
  const [lon0, lat0] = mapper.pixelToLonLat(0, 0);
  near(lon0, -dms(74, 16, 16.91), 1e-5, 'upper-left longitude');
  near(lat0, dms(3, 37, 25.46), 1e-5, 'upper-left latitude');
  const [lon1, lat1] = mapper.pixelToLonLat(2414, 2914);
  near(lon1, -dms(74, 3, 15.41), 1e-5, 'lower-right longitude');
  near(lat1, dms(3, 21, 35.8), 1e-5, 'lower-right latitude');
  // gdaltransform -i -t_srs EPSG:4326: -74.15 3.5 -> 1349.1939 1366.7255
  const [px, py] = mapper.lonLatToPixel(-74.15, 3.5);
  near(px, 1349.1939, 1e-3, 'column');
  near(py, 1366.7255, 1e-3, 'row');
  const back = mapper.pixelToLonLat(px, py);
  near(back[0], -74.15, 1e-10, 'round trip');
});
await test('Web Mercator conversions', () => {
  // gdaltransform -s_srs EPSG:4326 -t_srs EPSG:3857: -74.15 3.5 -> -8254340.24232124 389860.758254196
  const [x, y] = lib.lonLatToMercator(-74.15, 3.5);
  near(x, -8254340.24232124, 1e-3, 'x');
  near(y, 389860.758254196, 1e-3, 'y');
  const [lon, lat] = lib.mercatorToLonLat(x, y);
  near(lon, -74.15, 1e-10, 'lon');
  near(lat, 3.5, 1e-10, 'lat');
  near(lib.mercatorToLonLat(0, lib.MERCATOR_HALF)[1], 85.0511287798, 1e-9, 'top of the world');
});
await test('EPSG codes to proj4 (projected and geographic)', () => {
  assert.match(lib.epsgToProj4(32618), /\+proj=tmerc/);
  assert.match(lib.epsgToProj4(3857), /\+proj=merc/);
  assert.equal(lib.epsgToProj4(4326), undefined, 'longitude/latitude needs no conversion');
  assert.equal(lib.epsgToProj4(999999), undefined);
});

console.log('Tile grids');
await test('XYZ URLs, Bing quadkeys and TMS rows', () => {
  assert.equal(lib.quadkey(3, 3, 5), '213');
  const m = lib.webMercatorGrid(19).matrices[12];
  assert.equal(lib.xyzSource('https://t/{z}/{x}/{y}.png', '', 19).url(m, 1203, 2007), 'https://t/12/1203/2007.png');
  assert.equal(lib.xyzSource('https://t/a{q}.jpeg', '', 19).url(m, 1203, 2007), `https://t/a${lib.quadkey(12, 1203, 2007)}.jpeg`);
  assert.equal(lib.xyzSource('https://t/{z}/{x}/{-y}', '', 19).url(m, 1, 0), 'https://t/12/1/4095');
  near(m.resolution, 38.21851, 1e-4, 'zoom 12 metres per pixel');
});
await test('the basemap catalogue: every XYZ URL has tile placeholders, every vector map a style', () => {
  let items = 0;
  for (const p of lib.BASEMAP_PROVIDERS) {
    if (p.kind === 'wmts') {
      assert.match(p.capabilities, /^https?:\/\//);
      continue;
    }
    for (const item of p.items) {
      items++;
      assert.ok(/\{q\}/.test(item.url) || ['{z}', '{x}', '{y}'].every((t) => item.url.includes(t)), `${p.name}: ${item.name}: ${item.url}`);
      if (p.kind === 'vector') assert.match(item.style, /^https:\/\//, `${p.name}: ${item.name}`);
    }
  }
  assert.ok(items >= 100, `${items} basemaps`);
});
await test('Esri styles: relative URLs made absolute, vector source pointed at the tiles', () => {
  const style = { version: 8, sprite: '../sprites/sprite', glyphs: '../fonts/{fontstack}/{range}.pbf', sources: { esri: { type: 'vector', url: '../../' } }, layers: [] };
  const out = lib.prepareStyle(style, 'https://h/arcgis/rest/services/X/VectorTileServer/resources/styles/root.json', 'https://h/tile/{z}/{y}/{x}.pbf');
  assert.equal(out.sprite, 'https://h/arcgis/rest/services/X/VectorTileServer/resources/sprites/sprite');
  assert.equal(out.glyphs, 'https://h/arcgis/rest/services/X/VectorTileServer/resources/fonts/{fontstack}/{range}.pbf');
  assert.deepEqual(out.sources.esri.tiles, ['https://h/tile/{z}/{y}/{x}.pbf']);
  assert.equal(out.sources.esri.url, undefined);
});

console.log('Messages from the extension host');
await test('bytes arrive as bytes, however VS Code serialised them', () => {
  const bytes = Uint8Array.of(1, 2, 250);
  assert.deepEqual(Array.from(lib.toBytes(bytes)), [1, 2, 250]);
  assert.deepEqual(Array.from(lib.toBytes(bytes.buffer)), [1, 2, 250]);
  // A Node Buffer posted to a webview: its toJSON runs before VS Code sees the bytes.
  assert.deepEqual(Array.from(lib.toBytes(JSON.parse(JSON.stringify(Buffer.from([1, 2, 250]))))), [1, 2, 250]);
  const big = new Uint8Array(100);
  big.set([7, 8, 9], 40);
  assert.deepEqual(Array.from(lib.toBytes(big.subarray(40, 43))), [7, 8, 9], 'a view inside a larger buffer');
  assert.throws(() => lib.toBytes(undefined), /No data/);
});

console.log('Vector geometry');
await test('WKB: points, lines, polygons, multi-geometries, Z and EWKB', () => {
  const build = (fn) => {
    const bytes = [];
    const u8 = (v) => bytes.push(v);
    const u32 = (v) => { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, v, true); bytes.push(...new Uint8Array(d.buffer)); };
    const f64 = (v) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v, true); bytes.push(...new Uint8Array(d.buffer)); };
    fn(u8, u32, f64);
    return new DataView(Uint8Array.from(bytes).buffer);
  };
  const point = build((u8, u32, f64) => { u8(1); u32(1); f64(1.5); f64(-2); });
  assert.deepEqual(lib.parseWkb(point).geometry, { type: 'Point', coordinates: [1.5, -2] });
  const pointZ = build((u8, u32, f64) => { u8(1); u32(1001); f64(1); f64(2); f64(99); });
  assert.deepEqual(lib.parseWkb(pointZ).geometry, { type: 'Point', coordinates: [1, 2] });
  const ewkbZ = build((u8, u32, f64) => { u8(1); u32(0x80000002); u32(2); f64(0); f64(0); f64(5); f64(1); f64(1); f64(5); });
  assert.deepEqual(lib.parseWkb(ewkbZ).geometry, { type: 'LineString', coordinates: [[0, 0], [1, 1]] });
  const multiPolygon = build((u8, u32, f64) => {
    u8(1); u32(6); u32(1);
    u8(1); u32(3); u32(1); u32(4);
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 0]]) { f64(x); f64(y); }
  });
  assert.deepEqual(lib.parseWkb(multiPolygon).geometry, { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] });
});
await test('GeoPackage geometry blobs: header, envelope, empty geometries', () => {
  const blob = (flags, envelopeDoubles, body) => Uint8Array.from([0x47, 0x50, 0, flags, 0, 0, 0, 0, ...new Uint8Array(new Float64Array(envelopeDoubles).buffer), ...body]);
  const point = [1, 1, 0, 0, 0, ...new Uint8Array(new Float64Array([10, 20]).buffer)];
  assert.deepEqual(lib.parseGpkgGeometry(blob(0b0000_0001, [], point)), { type: 'Point', coordinates: [10, 20] });
  assert.deepEqual(lib.parseGpkgGeometry(blob(0b0000_0011, [10, 10, 20, 20], point)), { type: 'Point', coordinates: [10, 20] }, 'with an XY envelope');
  assert.equal(lib.parseGpkgGeometry(blob(0b0001_0001, [], point)), null, 'empty');
  assert.equal(lib.parseGpkgGeometry(Uint8Array.of(1, 2, 3)), null, 'not a GeoPackage blob');
});

if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll overlay tests passed');
