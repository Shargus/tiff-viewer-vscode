// Measure tool maths: geodesic lengths, azimuths and areas on WGS 84, against
// PROJ's geod (lengths, azimuths), equal-area projections (areas) and SpatiaLite (perimeters),
// planar measurements, angles and unit formatting.
//   npm test
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist', 'test', 'measure.mjs');
mkdirSync(dirname(bundle), { recursive: true });
await esbuild.build({
  entryPoints: [join(root, 'src', 'shared', 'measure.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'error',
});
const m = await import(pathToFileURL(bundle).href);
const geographiclib = await import('geographiclib-geodesic');
const lib = (geographiclib.Geodesic ?? geographiclib.default.Geodesic);

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}
const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} != ${expected} (±${tolerance})`);

// geod +ellps=WGS84 -I (input: lat1 lon1 lat2 lon2; output: azimuth, back azimuth, metres).
const GEOD = [
  [[7, 45], [7.8, 45.5], 48.213749, 83856.23],
  [[151.2, -33.9], [-0.13, 51.5], -40.766025, 16991896.109],
  [[0, 0], [1, 0], 90, 111319.491],
  [[0, 0], [0, 1], 0, 110574.389],
  [[10, 60], [10.0001, 60.0001], 26.603575, 12.46],
];
test('geodesic lengths and azimuths match PROJ geod', () => {
  for (const [a, b, azimuth, metres] of GEOD) {
    near(m.geodesicDistance(a, b), metres, 0.001, `distance ${a} → ${b}`);
    near(m.geodesicAzimuth(a, b), azimuth, 1e-6, `azimuth ${a} → ${b}`);
  }
});

// Areas: each edge densified along its geodesic (geod +n_S=20000), projected to a
// Lambert azimuthal equal-area projection on WGS 84 (cs2cs), shoelace.
// Perimeters: SpatiaLite's ST_Perimeter(geometry, 1).
const POLYGONS = [
  [[[0, 0], [1, 0], [1, 1], [0, 1]], 12308778361.468184, 443770.917248302],
  [[[7, 45], [7.8, 45.5], [8.2, 44.9], [7.4, 44.6]], 4910932012.805196, 283726.539002484],
  [[[-10, 60], [30, 62], [20, 40]], 2738909441504.035, 7723855.52828659],
];
test('geodesic areas and perimeters match the references, either way round', () => {
  for (const [ring, area, perimeter] of POLYGONS) {
    for (const points of [ring, [...ring].reverse()]) {
      const r = m.geodesicPolygon(points);
      near(r.area, area, area * 1e-7, 'area');
      near(r.perimeter, perimeter, 0.001, 'perimeter');
    }
  }
});

test('planar lengths, areas and angles', () => {
  assert.equal(m.planarDistance([0, 0], [3, 4]), 5);
  assert.deepEqual(m.planarPolygon([[0, 0], [4, 0], [4, 3], [0, 3]]), { area: 12, perimeter: 14 });
  assert.deepEqual(m.planarPolygon([[0, 3], [4, 3], [4, 0], [0, 0]]), { area: 12, perimeter: 14 });
  near(m.planarAngle([5, 0], [0, 0], [0, 5]), Math.PI / 2, 1e-12, 'right angle');
  near(m.planarAngle([0, 5], [0, 0], [5, 0]), Math.PI / 2, 1e-12, 'right angle, other way');
  near(m.planarAngle([1, 0], [0, 0], [-1, 1e-12]), Math.PI, 1e-9, 'straight');
  near(m.planarAngle([1, 0], [0, 0], [1, -1]), Math.PI / 4, 1e-12, 'below');
});

test('geodesic angles: at the equator, between a meridian and the equator', () => {
  near((m.geodesicAngle([0, 1], [0, 0], [1, 0]) * 180) / Math.PI, 90, 1e-9, 'north and east');
  near((m.geodesicAngle([1, 0], [0, 0], [-1, 0]) * 180) / Math.PI, 180, 1e-9, 'east and west');
});

test('self-intersecting polygons: every enclosed part counts once, positively', () => {
  // A bow tie: two triangles of area 1 (signed sums cancel them out).
  assert.equal(m.planarPolygon([[0, 0], [2, 2], [2, 0], [0, 2]]).area, 2);
  assert.equal(m.planarPolygon([[0, 2], [2, 0], [2, 2], [0, 0]]).area, 2);
  // Simple polygons: as the shoelace formula.
  near(m.enclosedArea([[0, 0], [4, 0], [5, 3], [2, 5], [-1, 2]]), 20, 1e-12, 'pentagon (shoelace: 20)');
  // A pentagram: its centre is wound twice, and counted once (as filled with the non-zero rule).
  const star = [0, 2, 4, 1, 3].map((k) => [Math.sin((2 * Math.PI * k) / 5), Math.cos((2 * Math.PI * k) / 5)]);
  const inside = ([x, y]) => {
    let w = 0;
    for (let i = 0; i < star.length; i++) {
      const [ax, ay] = star[i];
      const [bx, by] = star[(i + 1) % star.length];
      const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
      if (ay <= y && by > y && cross > 0) w++;
      else if (ay > y && by <= y && cross < 0) w--;
    }
    return w !== 0;
  };
  const N = 2000;
  let count = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (inside([-1 + (2 * (i + 0.5)) / N, -1 + (2 * (j + 0.5)) / N])) count++;
  near(m.enclosedArea(star), (count * 4) / (N * N), 2e-3, 'pentagram');
  // A geodesic bow tie: the sum of its two triangles, split where the geodesics cross
  // (on the meridian 0.5° by symmetry; found by bisection along the first geodesic).
  const A = [0, 0], B = [1, 1], C = [1, 0], D = [0, 1];
  const along = (t) => { const s = m.geodesicDistance(A, B) * t; return lib.WGS84.Direct(A[1], A[0], m.geodesicAzimuth(A, B), s); };
  let lo = 0, hi = 1;
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (along(mid).lon2 < 0.5) lo = mid; else hi = mid; }
  const X = [along(lo).lon2, along(lo).lat2];
  const expected = m.geodesicPolygon([A, X, D]).area + m.geodesicPolygon([X, B, C]).area;
  near(m.geodesicPolygon([A, B, C, D]).area, expected, expected * 1e-6, 'geodesic bow tie');
});

test('units', () => {
  assert.equal(m.formatLength(83856.23, 'auto'), '83.86 km');
  assert.equal(m.formatLength(12.46, 'auto'), '12.46 m');
  assert.equal(m.formatLength(1609.344, 'mi'), '1.000 mi');
  assert.equal(m.formatLength(1852 * 2500, 'nmi'), '2,500 NM');
  assert.equal(m.formatArea(12308463893.9752, 'auto'), '12,308 km²');
  assert.equal(m.formatArea(25000, 'ha'), '2.500 ha');
  assert.equal(m.formatArea(500, 'auto'), '500.0 m²');
  assert.equal(m.formatAngle(Math.PI / 2, 'deg'), '90.0000°');
  assert.equal(m.formatAngle(Math.PI / 2, 'gon'), '100.0000 gon');
  assert.equal(m.formatAngle((45.5125 * Math.PI) / 180, 'dms'), '45° 30′ 45.0″');
  assert.equal(m.formatPlain(12.5, 'px', true), '12.50 px²');
});

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nmeasure tests passed');
