// Decoder tests: runs the worker's TIFF pipeline (src/webview/tiff.ts) under Node
// against the fixtures produced by test/make_fixtures.py.
//
//   python3 test/make_fixtures.py && npm test
//
// Set DUMP_PNG=1 to also write the rendered previews to test/out/ for inspection.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'test', 'fixtures');
const outDir = join(root, 'test', 'out');
if (!existsSync(fixtures)) {
  console.error('Missing test/fixtures. Run: python3 test/make_fixtures.py');
  process.exit(1);
}

const bundle = join(root, 'dist', 'test', 'tiff.mjs');
await esbuild.build({
  stdin: {
    contents: `export * from './src/webview/tiff.ts'; export { MessageSource } from './src/webview/messageSource.ts';`,
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

async function openFixture(name) {
  const handle = await open(join(fixtures, name), 'r');
  const size = (await handle.stat()).size;
  let reads = 0;
  const source = new lib.MessageSource(size, async (ranges) => {
    reads++;
    return Promise.all(
      ranges.map(async ({ offset, length }) => {
        const buf = new Uint8Array(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        return buf.buffer.slice(0, bytesRead);
      }),
    );
  });
  const tiff = await lib.openTiff(source);
  return { ...tiff, close: () => handle.close(), reads: () => reads };
}

async function render(page, window, outWidth, outHeight, tone = 'minmax') {
  const { image, window: levelWindow } = lib.chooseLevel(page, window, outWidth);
  const region = await lib.readRegion(page, image, levelWindow, outWidth, outHeight);
  if (page.info.toneAdjustable) page.stats ??= lib.computeStats(page, region.data);
  return { rgba: lib.toRGBA(page, region.data, outWidth * outHeight, tone), image, width: outWidth, height: outHeight };
}

function renderFull(page, tone) {
  return render(page, [0, 0, page.info.width, page.info.height], page.info.width, page.info.height, tone);
}

function loadNpy(name) {
  const buf = readFileSync(join(fixtures, name));
  const headerLen = buf.readUInt16LE(8);
  const header = buf.subarray(10, 10 + headerLen).toString('latin1');
  const shape = /'shape': \(([^)]*)\)/.exec(header)[1].split(',').filter(Boolean).map(Number);
  return { shape, data: new Uint8Array(buf.buffer, buf.byteOffset + 10 + headerLen) };
}

function pixel(result, x, y) {
  const o = (y * result.width + x) * 4;
  return Array.from(result.rgba.subarray(o, o + 4));
}

function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function writePng(file, { rgba, width, height }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const dump = process.env.DUMP_PNG === '1';
if (dump) mkdirSync(outDir, { recursive: true });

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.log(`  ✗ ${name}\n    ${error.stack.split('\n').slice(0, 3).join('\n    ')}`);
  }
}

/** `tolerance` is the max per-channel difference, or `{ mean }` for lossy data. */
function assertMatchesRgb(result, tolerance, name) {
  const refName = `${name.replace(/\.tif$/, '')}_reference.npy`;
  const rgbRef = loadNpy(existsSync(join(fixtures, refName)) ? refName : 'rgb8_reference.npy');
  const [h, w] = rgbRef.shape;
  assert.equal(result.width, w);
  assert.equal(result.height, h);
  let worst = 0;
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(result.rgba[i * 4 + c] - rgbRef.data[i * 3 + c]);
      worst = Math.max(worst, d);
      sum += d;
    }
    assert.equal(result.rgba[i * 4 + 3], 255);
  }
  if (typeof tolerance === 'number') {
    assert.ok(worst <= tolerance, `max channel difference ${worst} > ${tolerance}`);
  } else {
    const mean = sum / (w * h * 3);
    assert.ok(mean <= tolerance.mean, `mean channel difference ${mean.toFixed(2)} > ${tolerance.mean}`);
  }
}

async function withFixture(name, fn) {
  const tiff = await openFixture(name);
  try {
    const result = await fn(tiff);
    if (dump && result?.rgba) writePng(join(outDir, name.replace(/\.tif$/, '.png')), result);
  } finally {
    await tiff.close();
  }
}

console.log('RGB');
for (const [name, tolerance] of [
  ['rgb8_strips_none.tif', 0],
  ['rgb8_tiled_lzw_pred.tif', 0],
  ['rgb8_deflate_bigendian.tif', 0],
  ['rgb8_packbits.tif', 0],
  ['rgb8_planar_separate.tif', 0],
  ['rgb8_zstd.tif', 0],
  // geotiff.js upsamples JPEG chroma with nearest neighbour, libjpeg interpolates.
  ['rgb8_jpeg_rgb.tif', { mean: 2 }],
  ['bigtiff_rgb8_tiled_jpeg.tif', { mean: 2 }],
  ['ycbcr_jpeg.tif', { mean: 2 }],
  ['cmyk8.tif', 2],
  // Pillow's own RGB -> Lab conversion is approximate.
  ['cielab8.tif', 20],
]) {
  await test(name, () =>
    withFixture(name, async (tiff) => {
      const result = await renderFull(tiff.pages[0]);
      assertMatchesRgb(result, tolerance, name);
      return result;
    }),
  );
}

await test('bigtiff flag', () =>
  withFixture('bigtiff_rgb8_tiled_jpeg.tif', async (tiff) => {
    assert.equal(tiff.info.bigTiff, true);
    assert.equal(tiff.info.pages[0].compression, 'JPEG');
  }),
);

await test('palette8.tif', () =>
  withFixture('palette8.tif', async (tiff) => {
    assert.equal(tiff.pages[0].kind, 'palette');
    const result = await renderFull(tiff.pages[0]);
    const [r, g, b] = pixel(result, 200, 150);
    assert.ok(r > 200 && g < 60 && b < 60, `expected red, got ${[r, g, b]}`);
    return result;
  }),
);

await test('rgba8_unassoc_alpha.tif', () =>
  withFixture('rgba8_unassoc_alpha.tif', async (tiff) => {
    assert.equal(tiff.info.pages[0].hasAlpha, true);
    const result = await renderFull(tiff.pages[0]);
    assert.equal(pixel(result, 0, 10)[3], 0);
    assert.equal(pixel(result, 399, 10)[3], 255);
    return result;
  }),
);

console.log('Gray / high bit depth');
await test('gray16_deflate.tif (min-max stretch)', () =>
  withFixture('gray16_deflate.tif', async (tiff) => {
    const page = tiff.pages[0];
    assert.equal(page.info.toneAdjustable, true);
    const result = await renderFull(page, 'minmax');
    assert.deepEqual(pixel(result, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(pixel(result, 0, 299), [255, 255, 255, 255]);
    const full = await renderFull(page, 'full');
    assert.ok(pixel(full, 0, 299)[0] < 40, 'full range of a 16-bit image should be dark');
    return result;
  }),
);

await test('bigtiff_gray16_lzw.tif', () =>
  withFixture('bigtiff_gray16_lzw.tif', async (tiff) => {
    assert.equal(tiff.info.bigTiff, true);
    const result = await renderFull(tiff.pages[0]);
    assert.equal(pixel(result, 0, 0)[0], 0);
    assert.equal(pixel(result, 399, 0)[0], 255);
    return result;
  }),
);

await test('int16_signed.tif', () =>
  withFixture('int16_signed.tif', async (tiff) => {
    const result = await renderFull(tiff.pages[0]);
    assert.equal(pixel(result, 0, 0)[0], 0);
    assert.equal(pixel(result, 399, 0)[0], 255);
    const values = await lib.readPixel(tiff.pages[0], 0, 0);
    assert.deepEqual(values, [-20000]);
    return result;
  }),
);

for (const name of ['float32_nan_zstd_pred.tif', 'float64_gray.tif']) {
  await test(name, () =>
    withFixture(name, async (tiff) => {
      const page = tiff.pages[0];
      assert.equal(page.info.fullRangeAvailable, false);
      const result = await renderFull(page);
      assert.equal(pixel(result, 5, 5)[3], 0, 'NaN should be transparent');
      assert.equal(pixel(result, 200, 200)[3], 255);
      return result;
    }),
  );
}

console.log('Bilevel / CCITT');
const bilevelRef = loadNpy('bilevel_reference.npy');
for (const name of ['bilevel_none.tif', 'bilevel_packbits.tif', 'bilevel_rle.tif', 'bilevel_g3.tif', 'bilevel_g4.tif']) {
  await test(name, () =>
    withFixture(name, async (tiff) => {
      const page = tiff.pages[0];
      const result = await renderFull(page);
      const [h, w] = bilevelRef.shape;
      let mismatches = 0;
      for (let i = 0; i < w * h; i++) {
        const expected = bilevelRef.data[i] ? 255 : 0;
        if (result.rgba[i * 4] !== expected) mismatches++;
      }
      assert.equal(mismatches, 0, `${mismatches} pixels differ (${page.info.compression})`);
      // Downsampled preview averages to grey levels.
      const small = await render(page, [0, 0, w, h], 425, 550);
      assert.equal(small.width, 425);
      return result;
    }),
  );
}

console.log('NoData');
await test('float32 NoData written in shortened form is still NoData', () =>
  withFixture('float32_gdal_nodata.tif', async (tiff) => {
    const page = tiff.pages[0];
    assert.equal(page.info.noData, Math.fround(-3.4028234663852886e38));
    const result = await renderFull(page);
    assert.equal(pixel(result, 10, 10)[3], 0, 'NoData is transparent');
    assert.equal(pixel(result, 100, 10)[3], 255);
    assert.ok(page.stats.min >= 0, `the stretch ignores NoData (min ${page.stats.min})`);
    return result;
  }),
);
await test('zoomed out, each band averages only its own valid pixels', () =>
  withFixture('two_band_nodata_masks.tif', async (tiff) => {
    const page = tiff.pages[0];
    // 256 -> 86 columns: output column 21 covers source columns 63..65, where band 2 is valid, NoData, NoData.
    const region = await lib.readRegion(page, page.images[0], [0, 0, 256, 256], 86, 86, { samples: [0, 1] });
    const at = (band, column) => region.data[band][10 * 86 + column];
    assert.equal(at(0, 21), 1000);
    assert.equal(at(1, 21), 1000, 'NoData in band 2 is not averaged in');
    assert.ok(Number.isNaN(at(1, 30)), 'all NoData in band 2: NaN');
    assert.ok(Number.isNaN(at(0, 5)) && Number.isNaN(at(1, 5)), 'NoData in both bands');
    assert.equal(at(0, 30), 1000, 'band 1 valid where band 2 is not');
  }),
);

console.log('Georeferencing');
for (const [name, shift] of [['geotiff_utm_area.tif', 0], ['geotiff_utm_point.tif', 5]]) {
  await test(`${name}: transform and coordinate system`, () =>
    withFixture(name, async (tiff) => {
      const geo = tiff.pages[0].info.geo;
      assert.ok(geo, 'georeferenced');
      assert.match(geo.crsName, /^EPSG:32618/);
      assert.match(geo.proj4, /\+proj=tmerc .*\+lon_0=-75 .*\+k_0=0\.9996 .*\+x_0=500000/);
      // PixelIsPoint: the tiepoint is the centre of the first pixel, so the corner is half a pixel up-left (as GDAL).
      assert.deepEqual(geo.transform, [580920 - shift, 10, 0, 400570 + shift, 0, -10]);
    }),
  );
}
await test('a plain TIFF is not georeferenced', () =>
  withFixture('gray16_deflate.tif', async (tiff) => assert.equal(tiff.pages[0].info.geo, undefined)),
);

console.log('Info panel');
await test('every tag is listed, custom ones by number, with GDAL metadata items', () =>
  withFixture('custom_tags.tif', async (tiff) => {
    const info = tiff.pages[0].info;
    const tags = Object.fromEntries(info.allTags);
    assert.equal(tags['Software (305)'], 'my-pipeline 1.2');
    assert.equal(tags['ImageWidth (256)'], '64');
    assert.equal(tags['Tag 65000'], 'campaign=Mesetas 2019; operator=TM');
    assert.equal(tags['Tag 65001'], '1.5, -2.25, 1e-7');
    assert.equal(tags['Tag 65002'], '0, 1, 2, 250, 251, 255');
    assert.equal(tags['Tag 65004'].length, 5000, 'long values are complete');
    assert.ok(tags['GDAL_METADATA (42112)'].startsWith('<GDALMetadata>'));
    assert.deepEqual(info.metadata, [['SENSOR', 'S2B'], ['QA: CLOUD', '12 & less'], ['Band 1: description', 'B04']]);
    const ids = info.allTags.map(([label]) => Number(/(\d+)\)?$/.exec(label)[1]));
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'in tag order');
  }),
);

console.log('Structure');
await test('multipage.tif', () =>
  withFixture('multipage.tif', async (tiff) => {
    assert.equal(tiff.pages.length, 3);
    assert.deepEqual(
      tiff.info.pages.map((p) => [p.width, p.height]),
      [[400, 300], [200, 150], [400, 300]],
    );
    const second = await renderFull(tiff.pages[1]);
    assert.equal(second.width, 200);
    return second;
  }),
);

await test('pyramid_bigtiff.tif uses overviews', () =>
  withFixture('pyramid_bigtiff.tif', async (tiff) => {
    const page = tiff.pages[0];
    assert.equal(tiff.pages.length, 1);
    assert.deepEqual(
      page.info.levels.map((l) => l.width),
      [3200, 1600, 800, 400],
    );
    const readsBefore = tiff.reads();
    const preview = await render(page, [0, 0, 3200, 2400], 400, 300);
    assert.equal(preview.image.getWidth(), 400, 'preview should come from the smallest overview');
    assert.ok(tiff.reads() - readsBefore < 20, `too many reads: ${tiff.reads() - readsBefore}`);
    // Full-resolution detail window: red square of tile (1,1) at (1350..1450, 400..500)
    const detail = await render(page, [1300, 350, 1500, 550], 200, 200);
    assert.equal(detail.image.getWidth(), 3200);
    assert.deepEqual(pixel(detail, 100, 100), [255, 0, 0, 255]);
    return preview;
  }),
);

await test('nearest sampling for huge windows skips work', () =>
  withFixture('rgb8_tiled_lzw_pred.tif', async (tiff) => {
    const page = tiff.pages[0];
    const result = await render(page, [0, 0, 400, 300], 4, 3);
    assert.equal(result.width, 4);
    assert.equal(result.rgba.length, 4 * 3 * 4);
  }),
);

console.log('Pixel readout');
await test('pixel values from the tile cache equal geotiff.js readRasters, in every fixture', async () => {
  const { readdirSync } = await import('node:fs');
  let checked = 0;
  for (const name of readdirSync(fixtures).filter((n) => /\.tiff?$/.test(n)).sort()) {
    const tiff = await openFixture(name).catch(() => undefined);
    if (!tiff) continue;
    try {
      for (const page of tiff.pages) {
        if (page.info.unsupported) continue;
        const image = page.images[0];
        const w = image.getWidth();
        const h = image.getHeight();
        const tw = image.getTileWidth();
        const th = image.getTileHeight();
        // Corners, the centre, and both sides of the first tile boundaries.
        const points = [[0, 0], [w - 1, h - 1], [w >> 1, h >> 1], [Math.min(w - 1, tw - 1), Math.min(h - 1, th - 1)], [Math.min(w - 1, tw), Math.min(h - 1, th)], [w - 1, 0], [0, h - 1]];
        for (const [x, y] of points) {
          const expected = (await image.readRasters({ window: [x, y, x + 1, y + 1], interleave: false })).map((r) => Number(r[0]));
          const actual = await lib.readPixel(page, x, y);
          assert.deepEqual(actual, expected, `${name} page ${page.info.index ?? ''} pixel (${x}, ${y})`);
          checked++;
        }
      }
    } finally {
      await tiff.close();
    }
  }
  assert.ok(checked > 100, `only ${checked} pixels checked`);
  console.log(`    (${checked} pixels compared)`);
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
