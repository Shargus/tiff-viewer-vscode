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
      `export { prepareStyle, localizeUrl, localizeStyle, localizationSupport } from './src/webview/basemap.ts';`,
      `export { BASEMAP_PROVIDERS } from './src/shared/basemaps.ts';`,
      `export { toBytes } from './src/webview/bytes.ts';`,
      `export { imageGrid, warpedGrid, parseCrs, utmCode } from './src/webview/grid.ts';`,
      `export { pixelMapping, extentInCanvas } from './src/webview/rasterLayer.ts';`,
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

console.log('Layers and coordinate systems');
await test('EPSG codes for the canvas: parsed, unknown ones refused', () => {
  assert.equal(lib.parseCrs('EPSG:4326').code, 4326);
  assert.equal(lib.parseCrs(' epsg 32633 ').code, 32633);
  assert.ok(lib.parseCrs('3857').proj4.includes('+proj=merc'));
  assert.ok(lib.parseCrs('EPSG:4326').geographic);
  assert.match(lib.parseCrs('EPSG:999999'), /not a coordinate system/);
  assert.match(lib.parseCrs('UTM'), /EPSG code/);
  assert.equal(lib.utmCode(-74.2, 3.5), 32618);
  assert.equal(lib.utmCode(-43.3, -21.7), 32723);
});
await test("the image warped into EPSG:4326: every pixel lands where its longitude / latitude says, and back", () => {
  const page = { width: 2414, height: 2914, geo };
  const crs = lib.parseCrs('EPSG:4326');
  const grid = lib.warpedGrid(page, crs);
  assert.equal(grid.identity, false);
  const image = new lib.GeoMapper(geo);
  const canvas = new lib.GeoMapper(grid.geo);
  let worst = 0;
  let back = 0;
  for (const [x, y] of [[0, 0], [2414, 2914], [1207, 1457], [100, 2800], [2400, 30]]) {
    const [gx, gy] = grid.image.toCanvas(x, y);
    const [lon1, lat1] = image.pixelToLonLat(x, y);
    const [lon2, lat2] = canvas.pixelToLonLat(gx, gy);
    worst = Math.max(worst, Math.abs(lon1 - lon2), Math.abs(lat1 - lat2));
    const [bx, by] = grid.image.toSource(gx, gy);
    back = Math.max(back, Math.abs(bx - x), Math.abs(by - y));
  }
  assert.ok(worst < 1e-9, `lon/lat off by ${worst}`);
  assert.ok(back < 1e-6, `round trip off by ${back} px`);
  // About the image's resolution: 10 m is about 9e-5 degrees here.
  near(grid.geo.transform[1], 9.0e-5, 0.3e-5, 'pixel size');
  // The grid covers the image's outline.
  const [b0, b1, b2, b3] = grid.bounds;
  assert.ok(b0 >= -1e-6 && b1 >= -1e-6 && b2 <= grid.width + 1e-6 && b3 <= grid.height + 1e-6);
});
await test('a layer in the same coordinate system is placed with an affine transform; others are warped; non-georeferenced refused', () => {
  // A second Sentinel-2 grid, 20 m, offset by 1000 m east and 500 m south.
  const other = { ...geo, transform: [581920, 20, 0, 400070, 0, -20] };
  const same = lib.pixelMapping(other, geo);
  assert.deepEqual(same.affine.map((v) => +v.toFixed(9)), [2, 0, 0, 2, 100, 50]);
  const wgs = { transform: [-74.27, 0.0001, 0, 3.62, 0, -0.0001], proj4: '+proj=longlat +datum=WGS84 +no_defs', factors: { x: 1, y: 1 }, crsName: 'EPSG:4326', geographic: true };
  const warped = lib.pixelMapping(wgs, geo);
  assert.equal(warped.affine, undefined);
  const [x, y] = warped.toCanvas(100, 100);
  const [lon, lat] = new lib.GeoMapper(geo).pixelToLonLat(x, y);
  near(lon, -74.27 + 0.01, 1e-9, 'lon');
  near(lat, 3.62 - 0.01, 1e-9, 'lat');
  assert.equal(lib.pixelMapping(undefined, geo), undefined);
  // Its extent in the image's pixels.
  const extent = lib.extentInCanvas({ width: 50, height: 50 }, same);
  assert.deepEqual(extent.map((v) => +v.toFixed(6)), [100, 50, 200, 150]);
});

await test('basemap localisation: Google hl/gl, Bing mkt, OpenFreeMap label language; others none', () => {
  const google = 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}';
  assert.deepEqual(lib.localizationSupport(google), { language: true, region: true });
  assert.deepEqual(lib.localizationSupport('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'), { language: false, region: false }, 'satellite: no labels');
  assert.equal(lib.localizeUrl(google, { language: 'ja', region: 'JP' }), google + '&hl=ja&gl=JP');
  assert.equal(lib.localizeUrl(google, { language: '', region: '' }), google);
  const bing = 'http://ecn.t3.tiles.virtualearth.net/tiles/r{q}.png?g=1';
  assert.equal(lib.localizeUrl(bing, { language: 'fr', region: '' }), bing + '&mkt=fr-FR');
  assert.equal(lib.localizeUrl(bing, { language: 'en', region: 'GB' }), bing + '&mkt=en-GB');
  assert.deepEqual(lib.localizationSupport('http://ecn.t3.tiles.virtualearth.net/tiles/a{q}.jpeg?g=1'), { language: false, region: false }, 'aerial');
  assert.deepEqual(lib.localizationSupport('https://tiles.openfreemap.org/styles/liberty'), { language: true, region: false });
  assert.deepEqual(lib.localizationSupport('https://tile.openstreetmap.org/{z}/{x}/{y}.png'), { language: false, region: false });
  const style = lib.localizeStyle({ layers: [{ layout: { 'text-field': ['get', 'name'] } }, { layout: {} }] }, 'de');
  assert.deepEqual(style.layers[0].layout['text-field'], ['coalesce', ['get', 'name:de'], ['get', 'name']]);
  assert.equal(style.layers[1].layout['text-field'], undefined);
});

if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll overlay tests passed');
