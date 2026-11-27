// Measurements (the Measure tool): lengths, areas and angles, on the WGS 84
// ellipsoid (geodesics, as QGIS's "Ellipsoidal" measurements) or on a plane
// (QGIS's "Cartesian": in the map's coordinate system, or in pixels).
import { Geodesic } from 'geographiclib-geodesic';
import proj4 from 'proj4';

const WGS84 = Geodesic.WGS84;

export type Point = [number, number];

/** Geodesic distance in metres between two [lon, lat] points. */
export function geodesicDistance(a: Point, b: Point): number {
  return WGS84.Inverse(a[1], a[0], b[1], b[0], Geodesic.DISTANCE).s12 ?? NaN;
}

/** Initial azimuth (degrees clockwise from north) of the geodesic from a to b. */
export function geodesicAzimuth(a: Point, b: Point): number {
  return WGS84.Inverse(a[1], a[0], b[1], b[0], Geodesic.AZIMUTH).azi1 ?? NaN;
}

/**
 * Area (m²) and perimeter (m) of a polygon of [lon, lat] vertices, edges being geodesics.
 * The area is that of everything the polygon encloses, as it is filled on the map
 * (non-zero winding): the lobes of a self-intersecting polygon all count positively.
 */
export function geodesicPolygon(points: Point[]): { area: number; perimeter: number } {
  if (points.length < 3) return { area: 0, perimeter: points.length === 2 ? 2 * geodesicDistance(points[0], points[1]) : 0 };
  const polygon = WGS84.Polygon(false);
  for (const [lon, lat] of points) polygon.AddPoint(lat, lon);
  const r = polygon.Compute(false, true);
  // A simple polygon: GeographicLib's exact area. Self-intersecting: the region enclosed,
  // in an equal-area projection with the geodesic edges densified.
  const projected = equalAreaRing(points);
  const area = projected && selfIntersects(projected.vertices) ? enclosedArea(projected.ring) : Math.abs(r.area ?? 0);
  return { area, perimeter: r.perimeter };
}

/**
 * The polygon in a Lambert azimuthal equal-area projection (on WGS 84) centred on it:
 * its vertices, and its ring with each geodesic edge densified (every 10 km, 4 to 128 points).
 */
function equalAreaRing(points: Point[]): { vertices: Point[]; ring: Point[] } | undefined {
  // The centre: mean longitude (unwrapped around the first vertex) and latitude.
  const lon0 = points[0][0];
  const lon = points.reduce((sum, [x]) => sum + (((x - lon0 + 540) % 360) - 180), 0) / points.length + lon0;
  const lat = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  let project: proj4.Converter;
  try {
    project = proj4('EPSG:4326', `+proj=laea +lat_0=${lat} +lon_0=${lon} +ellps=WGS84 +units=m +no_defs`);
  } catch {
    return undefined;
  }
  const xy = (p: Point): Point => project.forward([p[0], p[1]]) as Point;
  const vertices = points.map(xy);
  const ring: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const line = WGS84.InverseLine(a[1], a[0], b[1], b[0], Geodesic.LATITUDE | Geodesic.LONGITUDE | Geodesic.DISTANCE_IN);
    const length = line.s13 ?? 0;
    const n = Math.max(4, Math.min(128, Math.ceil(length / 10000)));
    ring.push(vertices[i]);
    for (let k = 1; k < n; k++) {
      const q = line.Position((length * k) / n, Geodesic.LATITUDE | Geodesic.LONGITUDE);
      ring.push(xy([q.lon2!, q.lat2!]));
    }
  }
  return vertices.concat(ring).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) ? { vertices, ring } : undefined;
}

export function planarDistance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Area and perimeter of a planar polygon: the area of everything it encloses (non-zero winding). */
export function planarPolygon(points: Point[]): { area: number; perimeter: number } {
  let perimeter = 0;
  for (let i = 0; i < points.length && points.length > 1; i++) perimeter += planarDistance(points[i], points[(i + 1) % points.length]);
  return { area: points.length > 2 ? enclosedArea(points) : 0, perimeter };
}

/** Where segments a–b and c–d meet (their parameters along each), if they do. */
function crossing(a: Point, b: Point, c: Point, d: Point): [number, number] | undefined {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0) return undefined;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : undefined;
}

/** Whether two edges of a polygon that are not neighbours meet. */
function selfIntersects(points: Point[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (crossing(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * The area of the region a polygon encloses with a non-zero winding number (as a
 * canvas fills it), every part counted once: the lobes of a self-intersecting polygon
 * add up, whichever way round they go. Exact for straight edges: the plane is cut into
 * horizontal slabs at every vertex and crossing, within which edges do not cross.
 */
export function enclosedArea(points: Point[]): number {
  const n = points.length;
  const edges: { a: Point; b: Point; dir: number; y0: number; y1: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (a[1] !== b[1]) edges.push({ a, b, dir: b[1] > a[1] ? 1 : -1, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
  }
  // Edges by their lowest y: each meets only those starting before it ends.
  edges.sort((e, f) => e.y0 - f.y0);
  const ys = points.map((p) => p[1]);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    for (let j = i + 1; j < edges.length && edges[j].y0 <= e.y1; j++) {
      const f = edges[j];
      const t = crossing(e.a, e.b, f.a, f.b);
      if (t) ys.push(e.a[1] + (e.b[1] - e.a[1]) * t[0]);
    }
  }
  ys.sort((p, q) => p - q);
  const xAt = (e: (typeof edges)[number], y: number) => e.a[0] + ((e.b[0] - e.a[0]) * (y - e.a[1])) / (e.b[1] - e.a[1]);
  let area = 0;
  // The edges spanning the current slab: added as the sweep reaches them, dropped once passed.
  let active: (typeof edges)[number][] = [];
  let next = 0;
  for (let k = 1; k < ys.length; k++) {
    const y0 = ys[k - 1];
    const y1 = ys[k];
    if (y1 <= y0) continue;
    while (next < edges.length && edges[next].y0 <= y0) active.push(edges[next++]);
    active = active.filter((e) => e.y1 > y0);
    const ym = (y0 + y1) / 2;
    const across = active
      .filter((e) => e.y1 >= y1)
      .map((e) => ({ x0: xAt(e, y0), x1: xAt(e, y1), xm: xAt(e, ym), dir: e.dir }))
      .sort((p, q) => p.xm - q.xm);
    let winding = 0;
    let start: (typeof across)[number] | undefined;
    for (const e of across) {
      const before = winding;
      winding += e.dir;
      if (before === 0 && winding !== 0) start = e;
      else if (before !== 0 && winding === 0 && start) area += ((e.x0 - start.x0 + (e.x1 - start.x1)) / 2) * (y1 - y0);
    }
  }
  return area;
}

/** The angle (radians, 0..π) at `vertex` between the directions to `a` and `b`, on a plane (y up). */
export function planarAngle(a: Point, vertex: Point, b: Point): number {
  const t1 = Math.atan2(a[1] - vertex[1], a[0] - vertex[0]);
  const t2 = Math.atan2(b[1] - vertex[1], b[0] - vertex[0]);
  return foldAngle(t2 - t1);
}

/** The angle (radians, 0..π) at `vertex` between the geodesics to `a` and to `b`. */
export function geodesicAngle(a: Point, vertex: Point, b: Point): number {
  return foldAngle(((geodesicAzimuth(vertex, b) - geodesicAzimuth(vertex, a)) * Math.PI) / 180);
}

/** An angle folded into 0..π. */
function foldAngle(angle: number): number {
  let d = Math.abs(angle) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

// --- Units ---

export interface Unit {
  id: string;
  label: string;
  /** Metres (or m²) per unit. */
  factor: number;
  symbol: string;
}

export const LENGTH_UNITS: Unit[] = [
  { id: 'm', label: 'Meters', factor: 1, symbol: 'm' },
  { id: 'km', label: 'Kilometers', factor: 1000, symbol: 'km' },
  { id: 'ft', label: 'Feet', factor: 0.3048, symbol: 'ft' },
  { id: 'yd', label: 'Yards', factor: 0.9144, symbol: 'yd' },
  { id: 'mi', label: 'Miles', factor: 1609.344, symbol: 'mi' },
  { id: 'nmi', label: 'Nautical miles', factor: 1852, symbol: 'NM' },
];

export const AREA_UNITS: Unit[] = [
  { id: 'm2', label: 'Square meters', factor: 1, symbol: 'm²' },
  { id: 'km2', label: 'Square kilometers', factor: 1e6, symbol: 'km²' },
  { id: 'ha', label: 'Hectares', factor: 1e4, symbol: 'ha' },
  { id: 'ft2', label: 'Square feet', factor: 0.09290304, symbol: 'ft²' },
  { id: 'yd2', label: 'Square yards', factor: 0.83612736, symbol: 'yd²' },
  { id: 'ac', label: 'Acres', factor: 4046.8564224, symbol: 'ac' },
  { id: 'mi2', label: 'Square miles', factor: 2589988.110336, symbol: 'mi²' },
];

export const ANGLE_UNITS = [
  { id: 'deg', label: 'Degrees' },
  { id: 'rad', label: 'Radians' },
  { id: 'gon', label: 'Gradians' },
  { id: 'dms', label: 'Degrees, minutes, seconds' },
  { id: 'turn', label: 'Turns' },
] as const;

function fixed(value: number, decimals: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Decimals for a value: about four significant digits, at least `min`. */
function decimalsFor(value: number, min = 0): number {
  const a = Math.abs(value);
  return Math.max(min, a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4);
}

/** A length in metres, in a unit ('auto': m below 1 km, km above). */
export function formatLength(metres: number, unit: string): string {
  if (!Number.isFinite(metres)) return '—';
  const u = unit === 'auto' ? LENGTH_UNITS[metres < 1000 ? 0 : 1] : (LENGTH_UNITS.find((x) => x.id === unit) ?? LENGTH_UNITS[0]);
  const v = metres / u.factor;
  return `${fixed(v, decimalsFor(v))} ${u.symbol}`;
}

/** An area in m², in a unit ('auto': m² below 1 km², km² above). */
export function formatArea(squareMetres: number, unit: string): string {
  if (!Number.isFinite(squareMetres)) return '—';
  const u = unit === 'auto' ? AREA_UNITS[squareMetres < 1e6 ? 0 : 1] : (AREA_UNITS.find((x) => x.id === unit) ?? AREA_UNITS[0]);
  const v = squareMetres / u.factor;
  return `${fixed(v, decimalsFor(v))} ${u.symbol}`;
}

/** A plain number with a unit symbol (pixels, degrees or the map's units). */
export function formatPlain(value: number, symbol: string, squared = false): string {
  if (!Number.isFinite(value)) return '—';
  return `${fixed(value, decimalsFor(value))} ${symbol}${squared ? '²' : ''}`;
}

/** An angle in radians, in a unit. */
export function formatAngle(radians: number, unit: string): string {
  if (!Number.isFinite(radians)) return '—';
  const degrees = (radians * 180) / Math.PI;
  switch (unit) {
    case 'rad':
      return `${fixed(radians, 6)} rad`;
    case 'gon':
      return `${fixed((radians * 200) / Math.PI, 4)} gon`;
    case 'turn':
      return `${fixed(radians / (2 * Math.PI), 6)} tr`;
    case 'dms': {
      let total = Math.round(degrees * 36000);
      const tenths = total % 10;
      total = (total - tenths) / 10;
      const s = total % 60;
      const m = ((total - s) / 60) % 60;
      const d = Math.floor(total / 3600);
      return `${d}° ${String(m).padStart(2, '0')}′ ${String(s).padStart(2, '0')}.${tenths}″`;
    }
    default:
      return `${fixed(degrees, 4)}°`;
  }
}
