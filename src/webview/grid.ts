import proj4 from 'proj4';
import type { GeoInfo, PageInfo, PixelWindow } from '../shared/protocol';
import { GeoMapper } from './geo';
import { pixelMapping, type PixelMapping } from './rasterLayer';
import { epsgToProj4 } from './vectors';

/**
 * The grid everything is drawn in (QGIS's project CRS): the opened image's own
 * pixels, or a grid in another coordinate system covering the image at about
 * its resolution, into which the image is warped like any other layer.
 */
export interface CanvasGrid {
  /** Size in grid pixels (what the view scale and pan refer to). */
  width: number;
  height: number;
  /** Georeferencing of the grid; undefined for an image without it. */
  geo: GeoInfo | undefined;
  /** The opened image's pixels ↔ grid pixels (identity, with `affine`, when the grid is the image's own). */
  image: PixelMapping;
  /** Whether the grid is the image's own pixels. */
  identity: boolean;
  /** Grid pixels per image pixel (about), to choose the image's pyramid level. */
  imageScale: number;
  /** The image's outline in grid pixels (a rectangle, or a curved quadrilateral when warped). */
  outline: Float64Array;
  /** Bounding box of the image's outline (while the image is a layer). */
  imageBounds: PixelWindow;
  /** The canvas's extent: the union of all the layers' extents (updated as layers come and go). */
  bounds: PixelWindow;
  /** Short name for the status bar, e.g. "EPSG:4326". */
  label: string;
}

const IDENTITY: PixelMapping = { toCanvas: (x, y) => [x, y], toSource: (x, y) => [x, y], affine: [1, 0, 0, 1, 0, 0] };

function rectangle(width: number, height: number): Float64Array {
  return Float64Array.of(0, 0, width, 0, width, height, 0, height);
}

/** The grid of the image itself. */
export function imageGrid(page: PageInfo): CanvasGrid {
  return {
    width: page.width,
    height: page.height,
    geo: page.geo,
    image: IDENTITY,
    identity: true,
    imageScale: 1,
    outline: rectangle(page.width, page.height),
    imageBounds: [0, 0, page.width, page.height],
    bounds: [0, 0, page.width, page.height],
    label: page.geo ? (/^EPSG:\d+/.exec(page.geo.crsName)?.[0] ?? page.geo.crsName) : '',
  };
}

/** What a grid is laid over: an image (or any georeferenced region) of width × height pixels. */
export interface GridReference {
  width: number;
  height: number;
  geo?: GeoInfo;
}

/** A georeferenced region as a reference for a grid: `bbox` in `crs` coordinates, at about `cells` pixels across. */
export function regionReference(crs: Crs, bbox: [number, number, number, number], cells = 2048): GridReference {
  let [x0, y0, x1, y1] = bbox;
  // A single point (or a line along an axis): a small square around it.
  const pad = crs.geographic ? 0.005 : 500;
  if (x1 - x0 <= 0) [x0, x1] = [x0 - pad, x1 + pad];
  if (y1 - y0 <= 0) [y0, y1] = [y0 - pad, y1 + pad];
  const res = Math.max(x1 - x0, y1 - y0) / cells;
  return {
    width: Math.max(1, Math.ceil((x1 - x0) / res)),
    height: Math.max(1, Math.ceil((y1 - y0) / res)),
    geo: { transform: [x0, res, 0, y1, 0, -res], proj4: crs.proj4, factors: { x: 1, y: 1 }, crsName: crs.name, geographic: crs.geographic },
  };
}

/** The part `window` (grid pixels) of a grid, as a reference for a grid in another coordinate system. */
export function windowReference(grid: CanvasGrid, window: PixelWindow): GridReference | undefined {
  if (!grid.geo) return undefined;
  const [t0, t1, t2, t3, t4, t5] = grid.geo.transform;
  const [x0, y0, x1, y1] = window;
  return {
    width: Math.max(1, Math.ceil(x1 - x0)),
    height: Math.max(1, Math.ceil(y1 - y0)),
    geo: { ...grid.geo, transform: [t0 + t1 * x0 + t2 * y0, t1, t2, t3 + t4 * x0 + t5 * y0, t4, t5] },
  };
}

/** The key two coordinate systems share when they are the same: their EPSG code, else their definition. */
export function crsKey(crs: Crs): string {
  return crs.code ? `EPSG:${crs.code}` : crs.proj4;
}

/** A layer's coordinate system, as something a grid can be drawn in (undefined when it cannot). */
export function crsOfGeo(geo: GeoInfo): Crs | undefined {
  const code = /^EPSG:(\d+)/.exec(geo.crsName)?.[1];
  if (code) {
    const parsed = parseCrs(code);
    if (typeof parsed !== 'string') return parsed;
  }
  // Without an EPSG code: its own definition, when its units are the definition's.
  return geo.factors.x === 1 && geo.factors.y === 1 ? { proj4: geo.proj4, geographic: geo.geographic, name: geo.crsName } : undefined;
}

/** A coordinate system to draw in: its proj4 definition, EPSG code when it has one, and a short name. */
export interface Crs {
  code?: number;
  proj4: string;
  geographic: boolean;
  /** e.g. "EPSG:4326". */
  name: string;
}

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

/** "EPSG:4326", "4326" or "epsg 32633" → the coordinate system, or an error message. */
export function parseCrs(text: string): Crs | string {
  const match = /^\s*(?:epsg\s*:?\s*)?(\d{4,6})\s*$/i.exec(text);
  if (!match) return 'Give an EPSG code, e.g. EPSG:4326 or 32633.';
  const code = Number(match[1]);
  const definition = code === 4326 ? WGS84 : epsgToProj4(code);
  if (!definition) return `EPSG:${code} is not a coordinate system this viewer knows.`;
  return { code, proj4: definition, geographic: /\+proj=longlat\b/.test(definition), name: `EPSG:${code}` };
}

/** The UTM zone (WGS 84) containing a point, as an EPSG code. */
export function utmCode(lon: number, lat: number): number {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return (lat >= 0 ? 32600 : 32700) + zone;
}

/**
 * A grid in `crs` covering the image: its outline projected (edges sampled, so
 * curved borders are covered), with square pixels of about the image's area.
 */
export function warpedGrid(page: GridReference, crs: Crs): CanvasGrid {
  const geo = page.geo!;
  const from = new GeoMapper(geo);
  const forward = proj4(WGS84, crs.proj4);
  const project = (x: number, y: number): [number, number] => {
    const [lon, lat] = from.pixelToLonLat(x, y);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [NaN, NaN];
    try {
      const p = forward.forward([lon, lat]);
      return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : [NaN, NaN];
    } catch {
      return [NaN, NaN];
    }
  };
  // Bounding box of the outline in the new coordinates.
  const n = 32;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const border: [number, number][] = [];
  for (let i = 0; i < n; i++) border.push([(page.width * i) / n, 0]);
  for (let i = 0; i < n; i++) border.push([page.width, (page.height * i) / n]);
  for (let i = n; i > 0; i--) border.push([(page.width * i) / n, page.height]);
  for (let i = n; i > 0; i--) border.push([0, (page.height * i) / n]);
  for (const [x, y] of border) {
    const [px, py] = project(x, y);
    if (!Number.isFinite(px)) continue;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  if (!Number.isFinite(minX)) throw new Error(`The image cannot be shown in ${crs.name}.`);
  // Pixel size: the image pixel's area at its centre, in the new units.
  const cx = page.width / 2;
  const cy = page.height / 2;
  const o = project(cx, cy);
  const u = project(cx + 1, cy);
  const v = project(cx, cy + 1);
  const area = Math.abs((u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]));
  let res = Math.sqrt(area);
  if (!Number.isFinite(res) || res <= 0) res = Math.max(maxX - minX, maxY - minY) / Math.max(page.width, page.height);
  // Keep the grid within a sane size (a few times the image's pixels).
  const width = Math.max(1, Math.ceil((maxX - minX) / res));
  const height = Math.max(1, Math.ceil((maxY - minY) / res));
  const gridGeo: GeoInfo = {
    transform: [minX, res, 0, maxY, 0, -res],
    proj4: crs.proj4,
    factors: { x: 1, y: 1 },
    crsName: crs.name,
    geographic: crs.geographic,
  };
  const image = pixelMapping(geo, gridGeo)!;
  const outline = new Float64Array(border.length * 2);
  let k = 0;
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const [x, y] of border) {
    const [gx, gy] = image.toCanvas(x, y);
    outline[k++] = gx;
    outline[k++] = gy;
    if (Number.isFinite(gx) && Number.isFinite(gy)) {
      bx0 = Math.min(bx0, gx);
      by0 = Math.min(by0, gy);
      bx1 = Math.max(bx1, gx);
      by1 = Math.max(by1, gy);
    }
  }
  const s = image.toCanvas(cx, cy);
  const t = image.toCanvas(cx + 1, cy);
  const imageScale = Math.hypot(t[0] - s[0], t[1] - s[1]) || 1;
  return {
    width,
    height,
    geo: gridGeo,
    image,
    identity: false,
    imageScale,
    outline,
    imageBounds: [bx0, by0, bx1, by1],
    bounds: [bx0, by0, bx1, by1],
    label: crs.name,
  };
}

/** Traces the image's outline (grid pixels) on `ctx` with the view's transform, for clipping. */
export function outlinePath(ctx: CanvasRenderingContext2D, grid: CanvasGrid, scale: number, tx: number, ty: number, dpr: number): void {
  const o = grid.outline;
  ctx.beginPath();
  if (grid.identity) {
    const x0 = Math.round(tx * dpr);
    const y0 = Math.round(ty * dpr);
    const x1 = Math.round((tx + grid.width * scale) * dpr);
    const y1 = Math.round((ty + grid.height * scale) * dpr);
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    return;
  }
  let started = false;
  for (let i = 0; i < o.length; i += 2) {
    if (!Number.isFinite(o[i]) || !Number.isFinite(o[i + 1])) continue;
    const x = (tx + o[i] * scale) * dpr;
    const y = (ty + o[i + 1] * scale) * dpr;
    if (started) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    started = true;
  }
  ctx.closePath();
}
