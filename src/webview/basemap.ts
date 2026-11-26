import type maplibregl from 'maplibre-gl';
import { lonLatToMercator, mercatorToLonLat, MERCATOR_HALF, type GeoMapper } from './geo';
import type { TileMatrix, TileSource } from './tilegrid';

/** The viewer's view: screen (CSS) pixels per image pixel, image origin on screen, device pixel ratio, stage size. */
export interface ViewState {
  scale: number;
  tx: number;
  ty: number;
  dpr: number;
  width: number;
  height: number;
}

export interface Basemap {
  readonly attribution: string;
  draw(ctx: CanvasRenderingContext2D, view: ViewState): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Localisation: the language of labels, and the region (borders, names)
// ---------------------------------------------------------------------------

/** A basemap's language and region ('' for the provider's default). */
export interface Localization {
  language: string;
  region: string;
}

/** Languages offered for labels: code (as Google takes it) and name. */
export const LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['it', 'Italiano'],
  ['pt', 'Português'],
  ['nl', 'Nederlands'],
  ['pl', 'Polski'],
  ['sv', 'Svenska'],
  ['tr', 'Türkçe'],
  ['ru', 'Русский'],
  ['ar', 'العربية'],
  ['hi', 'हिन्दी'],
  ['zh-CN', '中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
];

/** Countries and regions offered: ISO code and name. */
export const REGIONS: [string, string][] = [
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['CA', 'Canada'],
  ['AU', 'Australia'],
  ['IN', 'India'],
  ['FR', 'France'],
  ['DE', 'Germany'],
  ['IT', 'Italy'],
  ['ES', 'Spain'],
  ['PT', 'Portugal'],
  ['BR', 'Brazil'],
  ['MX', 'Mexico'],
  ['AR', 'Argentina'],
  ['CO', 'Colombia'],
  ['NL', 'Netherlands'],
  ['PL', 'Poland'],
  ['SE', 'Sweden'],
  ['TR', 'Türkiye'],
  ['RU', 'Russia'],
  ['CN', 'China'],
  ['JP', 'Japan'],
  ['KR', 'South Korea'],
  ['SA', 'Saudi Arabia'],
];

/** Bing's markets: a language needs a region (its main one when none is chosen). */
const MAIN_REGION: Record<string, string> = { en: 'US', fr: 'FR', de: 'DE', es: 'ES', it: 'IT', pt: 'BR', nl: 'NL', pl: 'PL', sv: 'SE', tr: 'TR', ru: 'RU', ar: 'SA', hi: 'IN', 'zh-CN': 'CN', ja: 'JP', ko: 'KR' };

/** What a basemap (by its tile or style URL) can be localised by. */
export function localizationSupport(url: string): { language: boolean; region: boolean } {
  // Google's maps with labels (not plain satellite imagery): hl= and gl=.
  if (/mt\d?\.google\.com\/vt\//.test(url)) return /lyrs=s(&|$)/.test(url) ? { language: false, region: false } : { language: true, region: true };
  // Bing's roads and hybrid imagery (not plain aerial): mkt=language-REGION.
  if (/virtualearth\.net/.test(url)) return /\/tiles\/a\{q\}/.test(url) ? { language: false, region: false } : { language: true, region: true };
  // OpenFreeMap's vector styles (OpenMapTiles): labels from name:<language>.
  if (/openfreemap\.org\/styles\//.test(url)) return { language: true, region: false };
  return { language: false, region: false };
}

/** A raster tile URL with the language and region parameters its provider takes. */
export function localizeUrl(url: string, { language, region }: Localization): string {
  const add = (params: Record<string, string>) => {
    const extra = Object.entries(params)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    // Google's URLs carry their parameters after the path without a '?' (vt/lyrs=m&x=…).
    return extra ? `${url}${/[?&]/.test(url) ? '&' : '?'}${extra}` : url;
  };
  if (/mt\d?\.google\.com\/vt\//.test(url)) return add({ hl: language, gl: region });
  if (/virtualearth\.net/.test(url) && (language || region)) {
    const lang = language || 'en';
    return add({ mkt: `${lang.split('-')[0]}-${region || MAIN_REGION[lang] || 'US'}` });
  }
  return url;
}

/** A MapLibre style whose labels show `language` (OpenMapTiles' name:<language>, else the local name). */
export function localizeStyle(style: Record<string, unknown>, language: string): Record<string, unknown> {
  if (!language) return style;
  const code = language.split('-')[0];
  for (const layer of (style.layers as { layout?: Record<string, unknown> }[] | undefined) ?? []) {
    if (layer.layout?.['text-field'] !== undefined) {
      layer.layout['text-field'] = ['coalesce', ['get', `name:${code}`], ...(code === 'en' ? [['get', 'name_en']] : []), ['get', 'name']];
    }
  }
  return style;
}

export type FetchBytes = (url: string) => Promise<Uint8Array>;
export type FetchText = (url: string) => Promise<string>;

/** Points in image pixels, (n + 1)² of them, row by row: the mesh a picture is warped with. */
type Mesh = Float64Array;

/**
 * Draws `source` (a picture whose mesh points are in image pixels) warped onto
 * the canvas: each mesh cell is drawn with the affine transform of its corners.
 */
export function drawWarped(ctx: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number, mesh: Mesh, n: number, view: ViewState): void {
  const k = view.scale * view.dpr;
  const ox = view.tx * view.dpr;
  const oy = view.ty * view.dpr;
  const cw = width / n;
  const ch = height / n;
  const at = (i: number, j: number) => (j * (n + 1) + i) * 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const p00 = at(i, j);
      const p10 = at(i + 1, j);
      const p01 = at(i, j + 1);
      const x0 = mesh[p00] * k + ox;
      const y0 = mesh[p00 + 1] * k + oy;
      const ax = mesh[p10] * k + ox - x0;
      const ay = mesh[p10 + 1] * k + oy - y0;
      const bx = mesh[p01] * k + ox - x0;
      const by = mesh[p01 + 1] * k + oy - y0;
      if (!(Number.isFinite(x0) && Number.isFinite(ax) && Number.isFinite(bx) && Number.isFinite(ay) && Number.isFinite(by))) continue;
      // Cull cells entirely off screen (cheap bounding test on the three known corners).
      const minX = Math.min(x0, x0 + ax, x0 + bx, x0 + ax + bx);
      const maxX = Math.max(x0, x0 + ax, x0 + bx, x0 + ax + bx);
      const minY = Math.min(y0, y0 + ay, y0 + by, y0 + ay + by);
      const maxY = Math.max(y0, y0 + ay, y0 + by, y0 + ay + by);
      if (maxX < 0 || maxY < 0 || minX > ctx.canvas.width || minY > ctx.canvas.height) continue;
      ctx.setTransform(ax, ay, bx, by, x0, y0);
      // A little overlap hides the seams between cells.
      const ex = 0.75 / Math.max(1, Math.hypot(ax, ay));
      const ey = 0.75 / Math.max(1, Math.hypot(bx, by));
      ctx.drawImage(source, i * cw, j * ch, cw, ch, 0, 0, 1 + ex, 1 + ey);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Points across the visible stage, in image pixels (the basemap fills the whole view, not only the image). */
function stageSamples(view: ViewState, steps = 6): [number, number][] {
  const points: [number, number][] = [];
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      points.push([((i / steps) * view.width - view.tx) / view.scale, ((j / steps) * view.height - view.ty) / view.scale]);
    }
  }
  return points;
}

// ---------------------------------------------------------------------------
// Raster tiles (XYZ and WMTS)
// ---------------------------------------------------------------------------

const TILE_MESH = 8;
const MAX_TILES_IN_VIEW = 120;
const MAX_CACHED_TILES = 400;
const MAX_PENDING = 24;
/** Retry a tile that failed for another reason than "not found" after this long. */
const RETRY_MS = 30_000;

interface CachedTile {
  state: 'loading' | 'loaded' | 'failed';
  bitmap?: ImageBitmap;
  mesh?: Mesh;
  used: number;
  failedAt?: number;
}

export class TileBasemap implements Basemap {
  private readonly tiles = new Map<string, CachedTile>();
  private pending = 0;
  private counter = 0;
  private disposed = false;

  constructor(
    private readonly source: TileSource,
    private readonly mapper: GeoMapper,
    private readonly fetchBytes: FetchBytes,
    private readonly redraw: () => void,
  ) {}

  get attribution(): string {
    return this.source.attribution;
  }

  private toGrid(lon: number, lat: number): [number, number] {
    return this.source.grid.crs === 'mercator' ? lonLatToMercator(lon, lat) : [lon, lat];
  }

  private fromGrid(x: number, y: number): [number, number] {
    return this.source.grid.crs === 'mercator' ? mercatorToLonLat(x, y) : [x, y];
  }

  /** Grid units per device pixel at the centre of the view. */
  private targetResolution(view: ViewState): number {
    const cx = (view.width / 2 - view.tx) / view.scale;
    const cy = (view.height / 2 - view.ty) / view.scale;
    const d = 1 / (view.scale * view.dpr);
    const at = (x: number, y: number) => this.toGrid(...this.mapper.pixelToLonLat(x, y));
    const c = at(cx, cy);
    const ex = at(cx + d, cy);
    const ey = at(cx, cy + d);
    return (Math.hypot(ex[0] - c[0], ex[1] - c[1]) + Math.hypot(ey[0] - c[0], ey[1] - c[1])) / 2;
  }

  /** Tiles covering the view: level index and the column/row ranges. */
  private tilesInView(view: ViewState): { level: number; tiles: [number, number][] } | undefined {
    const matrices = this.source.grid.matrices;
    const target = this.targetResolution(view);
    if (!Number.isFinite(target) || target <= 0) return undefined;
    let level = matrices.findIndex((m) => m.resolution <= target * 1.25);
    if (level < 0) level = matrices.length - 1;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of stageSamples(view)) {
      const [lon, lat] = this.mapper.pixelToLonLat(px, py);
      if (!Number.isFinite(lon)) continue;
      const [gx, gy] = this.toGrid(lon, lat);
      minX = Math.min(minX, gx);
      maxX = Math.max(maxX, gx);
      minY = Math.min(minY, gy);
      maxY = Math.max(maxY, gy);
    }
    if (!Number.isFinite(minX)) return undefined;
    for (; level >= 0; level--) {
      const m = matrices[level];
      const spanX = m.resolution * m.tileWidth;
      const spanY = m.resolution * m.tileHeight;
      const c0 = Math.max(0, Math.floor((minX - m.originX) / spanX));
      const c1 = Math.min(m.matrixWidth - 1, Math.floor((maxX - m.originX) / spanX));
      const r0 = Math.max(0, Math.floor((m.originY - maxY) / spanY));
      const r1 = Math.min(m.matrixHeight - 1, Math.floor((m.originY - minY) / spanY));
      if (c1 < c0 || r1 < r0) return { level, tiles: [] };
      if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_TILES_IN_VIEW && level > 0) continue;
      const tiles: [number, number][] = [];
      // Nearest the centre first.
      const cc = (c0 + c1) / 2;
      const rc = (r0 + r1) / 2;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) tiles.push([c, r]);
      tiles.sort((a, b) => Math.hypot(a[0] - cc, a[1] - rc) - Math.hypot(b[0] - cc, b[1] - rc));
      return { level, tiles };
    }
    return undefined;
  }

  private key(level: number, col: number, row: number): string {
    return `${level}/${col}/${row}`;
  }

  private mesh(m: TileMatrix, col: number, row: number): Mesh {
    const mesh = new Float64Array((TILE_MESH + 1) * (TILE_MESH + 1) * 2);
    let k = 0;
    for (let j = 0; j <= TILE_MESH; j++) {
      for (let i = 0; i <= TILE_MESH; i++) {
        const gx = m.originX + (col + i / TILE_MESH) * m.resolution * m.tileWidth;
        const gy = m.originY - (row + j / TILE_MESH) * m.resolution * m.tileHeight;
        const [lon, lat] = this.fromGrid(gx, gy);
        const [px, py] = this.mapper.lonLatToPixel(lon, Math.max(-89.999, Math.min(89.999, lat)));
        mesh[k++] = px;
        mesh[k++] = py;
      }
    }
    return mesh;
  }

  private request(level: number, col: number, row: number): void {
    const key = this.key(level, col, row);
    const existing = this.tiles.get(key);
    if (existing && (existing.state !== 'failed' || (existing.failedAt !== undefined && Date.now() - existing.failedAt < RETRY_MS))) return;
    if (this.pending >= MAX_PENDING) return;
    const tile: CachedTile = { state: 'loading', used: ++this.counter };
    this.tiles.set(key, tile);
    this.pending++;
    const m = this.source.grid.matrices[level];
    this.fetchBytes(this.source.url(m, col, row))
      .then((bytes) => createImageBitmap(new Blob([bytes as BlobPart])))
      .then((bitmap) => {
        if (this.disposed) return bitmap.close();
        tile.bitmap = bitmap;
        tile.mesh = this.mesh(m, col, row);
        tile.state = 'loaded';
        this.evict();
        this.redraw();
      })
      .catch((error: unknown) => {
        tile.state = 'failed';
        // Not found (e.g. beyond the service's deepest level): do not ask again.
        tile.failedAt = /HTTP 404|HTTP 400/.test(String((error as Error)?.message)) ? Infinity : Date.now();
      })
      .finally(() => {
        this.pending--;
        if (!this.disposed) this.redraw();
      });
  }

  private evict(): void {
    if (this.tiles.size <= MAX_CACHED_TILES) return;
    const loaded = [...this.tiles.entries()].filter(([, t]) => t.state !== 'loading').sort((a, b) => a[1].used - b[1].used);
    for (const [key, tile] of loaded) {
      if (this.tiles.size <= MAX_CACHED_TILES) break;
      tile.bitmap?.close();
      this.tiles.delete(key);
    }
  }

  /** The nearest coarser tile that is loaded, to show while (or instead of) a tile loads. */
  private loadedAncestor(level: number, col: number, row: number): [string, CachedTile, number] | undefined {
    const matrices = this.source.grid.matrices;
    const m = matrices[level];
    const cx = m.originX + (col + 0.5) * m.resolution * m.tileWidth;
    const cy = m.originY - (row + 0.5) * m.resolution * m.tileHeight;
    for (let l = level - 1; l >= 0; l--) {
      const a = matrices[l];
      const c = Math.floor((cx - a.originX) / (a.resolution * a.tileWidth));
      const r = Math.floor((a.originY - cy) / (a.resolution * a.tileHeight));
      const key = this.key(l, c, r);
      const tile = this.tiles.get(key);
      if (tile?.state === 'loaded') return [key, tile, l];
    }
    return undefined;
  }

  draw(ctx: CanvasRenderingContext2D, view: ViewState): void {
    const wanted = this.tilesInView(view);
    if (!wanted) return;
    const fallbacks = new Map<string, [CachedTile, number]>();
    const ready: CachedTile[] = [];
    for (const [col, row] of wanted.tiles) {
      const tile = this.tiles.get(this.key(wanted.level, col, row));
      if (tile?.state === 'loaded') {
        ready.push(tile);
        continue;
      }
      this.request(wanted.level, col, row);
      const ancestor = this.loadedAncestor(wanted.level, col, row);
      if (ancestor) fallbacks.set(ancestor[0], [ancestor[1], ancestor[2]]);
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const m = this.source.grid.matrices;
    for (const [tile, level] of [...fallbacks.values()].sort((a, b) => a[1] - b[1])) {
      tile.used = ++this.counter;
      drawWarped(ctx, tile.bitmap!, m[level].tileWidth, m[level].tileHeight, tile.mesh!, TILE_MESH, view);
    }
    const w = m[wanted.level];
    for (const tile of ready) {
      tile.used = ++this.counter;
      drawWarped(ctx, tile.bitmap!, w.tileWidth, w.tileHeight, tile.mesh!, TILE_MESH, view);
    }
    ctx.restore();
  }

  dispose(): void {
    this.disposed = true;
    for (const tile of this.tiles.values()) tile.bitmap?.close();
    this.tiles.clear();
  }
}

// ---------------------------------------------------------------------------
// Vector tiles (MapLibre styles)
// ---------------------------------------------------------------------------

type MapLibre = typeof maplibregl;
let mapLibre: Promise<MapLibre> | undefined;
let protocolFetch: FetchBytes | undefined;

/** Loads MapLibre (a separate script, only when a vector basemap is used) and routes its requests through `fetchBytes`. */
function loadMapLibre(fetchBytes: FetchBytes): Promise<MapLibre> {
  protocolFetch = fetchBytes;
  mapLibre ??= new Promise<MapLibre>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = window.TIFF_MAPLIBRE_URL;
    script.nonce = window.TIFF_NONCE;
    script.onload = () => {
      const lib = (window as unknown as { maplibregl?: MapLibre }).maplibregl;
      if (!lib) return reject(new Error('MapLibre did not load'));
      // Network requests go through the extension host: "tvf://https://…".
      lib.addProtocol('tvf', async (params) => {
        const url = params.url.slice('tvf://'.length);
        const bytes = await protocolFetch!(url);
        if (params.type === 'json') return { data: JSON.parse(new TextDecoder().decode(bytes)) };
        if (params.type === 'string') return { data: new TextDecoder().decode(bytes) };
        return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      });
      resolve(lib);
    };
    script.onerror = () => reject(new Error('Could not load MapLibre'));
    document.head.append(script);
  });
  return mapLibre;
}

/** Makes a style's relative URLs absolute, and points vector sources at `tileUrl` when given (Esri styles). */
export function prepareStyle(style: Record<string, unknown>, styleUrl: string, tileUrl?: string): Record<string, unknown> {
  const abs = (u: unknown) => (typeof u === 'string' && !/^[a-z]+:\/\//i.test(u) ? new URL(u, styleUrl).toString() : u);
  const out = { ...style } as Record<string, unknown>;
  if (typeof out.sprite === 'string') out.sprite = abs(out.sprite);
  else if (Array.isArray(out.sprite)) out.sprite = (out.sprite as { id: string; url: string }[]).map((s) => ({ ...s, url: abs(s.url) as string }));
  if (out.glyphs) out.glyphs = (abs(out.glyphs) as string).replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  const sources = { ...(out.sources as Record<string, Record<string, unknown>>) };
  for (const [id, source] of Object.entries(sources)) {
    const s = { ...source };
    if (s.type === 'vector' && tileUrl) {
      s.tiles = [tileUrl];
      delete s.url;
      s.maxzoom ??= 15;
    } else {
      if (s.url) s.url = abs(s.url);
      if (Array.isArray(s.tiles)) s.tiles = (s.tiles as string[]).map((t) => (abs(t) as string).replace(/%7B/gi, '{').replace(/%7D/gi, '}'));
    }
    sources[id] = s;
  }
  out.sources = sources;
  return out;
}

const VECTOR_MESH = 16;
/** Largest off-screen map rendered, in pixels per side. */
const MAX_RENDER = 2048;

export class VectorBasemap implements Basemap {
  private map: maplibregl.Map | undefined;
  private container: HTMLDivElement | undefined;
  private snapshot: { bitmap: ImageBitmap; mesh: Mesh; width: number; height: number } | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private lastViewKey = '';
  private disposed = false;
  private rendering = false;
  private error: string | undefined;

  constructor(
    private readonly styleUrl: string,
    private readonly tileUrl: string | undefined,
    readonly attribution: string,
    private readonly mapper: GeoMapper,
    private readonly fetchBytes: FetchBytes,
    private readonly fetchText: FetchText,
    private readonly redraw: () => void,
    private readonly onError: (message: string) => void,
    /** Language of the labels ('' for the style's own). */
    private readonly language = '',
  ) {}

  private async init(): Promise<maplibregl.Map> {
    if (this.map) return this.map;
    const lib = await loadMapLibre(this.fetchBytes);
    const style = localizeStyle(prepareStyle(JSON.parse(await this.fetchText(this.styleUrl)), this.styleUrl, this.tileUrl), this.language);
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-100000px;top:0;width:256px;height:256px;pointer-events:none;';
    document.body.append(container);
    this.container = container;
    this.map = new lib.Map({
      container,
      style: style as unknown as maplibregl.StyleSpecification,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: 1,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      transformRequest: (url) => ({ url: /^https?:\/\//i.test(url) ? `tvf://${url}` : url }),
    });
    this.map.on('error', (e) => {
      const message = String((e as { error?: Error }).error?.message ?? 'error');
      // Missing tiles and sprites are common and harmless; report the rest once.
      if (!/HTTP 404|tile|sprite|glyph/i.test(message) && !this.error) {
        this.error = message;
        this.onError(`Vector basemap: ${message}`);
      }
    });
    return this.map;
  }

  private scheduleRender(view: ViewState): void {
    const key = `${view.scale.toFixed(6)}|${view.tx.toFixed(1)}|${view.ty.toFixed(1)}|${view.width}x${view.height}|${view.dpr}`;
    if (key === this.lastViewKey) return;
    this.lastViewKey = key;
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => void this.render({ ...view }), this.snapshot ? 250 : 0);
  }

  /** Renders the Web Mercator view that covers the stage, at about the screen's resolution. */
  private async render(view: ViewState): Promise<void> {
    if (this.disposed) return;
    if (this.rendering) {
      // Render again when the current one is done.
      this.lastViewKey = '';
      return;
    }
    this.rendering = true;
    try {
      const map = await this.init();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [px, py] of stageSamples(view)) {
        const [lon, lat] = this.mapper.pixelToLonLat(px, py);
        if (!Number.isFinite(lon)) continue;
        const [x, y] = lonLatToMercator(lon, lat);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      if (!Number.isFinite(minX)) return;
      minX = Math.max(-MERCATOR_HALF, minX);
      maxX = Math.min(MERCATOR_HALF, maxX);
      minY = Math.max(-MERCATOR_HALF, minY);
      maxY = Math.min(MERCATOR_HALF, maxY);
      // Mercator metres per device pixel at the centre of the view.
      const cx = (view.width / 2 - view.tx) / view.scale;
      const cy = (view.height / 2 - view.ty) / view.scale;
      const d = 1 / (view.scale * view.dpr);
      const c = lonLatToMercator(...this.mapper.pixelToLonLat(cx, cy));
      const e = lonLatToMercator(...this.mapper.pixelToLonLat(cx + d, cy));
      let resolution = Math.hypot(e[0] - c[0], e[1] - c[1]);
      if (!Number.isFinite(resolution) || resolution <= 0) return;
      resolution = Math.max(resolution, (maxX - minX) / MAX_RENDER, (maxY - minY) / MAX_RENDER);
      const width = Math.max(64, Math.round((maxX - minX) / resolution));
      const height = Math.max(64, Math.round((maxY - minY) / resolution));
      this.container!.style.width = `${width}px`;
      this.container!.style.height = `${height}px`;
      map.resize();
      const sw = mercatorToLonLat(minX, minY);
      const ne = mercatorToLonLat(maxX, maxY);
      map.fitBounds([sw, ne], { padding: 0, animate: false, duration: 0 });
      await new Promise<void>((resolve) => {
        if (map.loaded() && map.areTilesLoaded() && !map.isMoving()) map.once('render', () => resolve());
        map.once('idle', () => resolve());
        map.triggerRepaint();
      });
      if (this.disposed) return;
      const canvas = map.getCanvas();
      const bitmap = await createImageBitmap(canvas);
      const mesh = new Float64Array((VECTOR_MESH + 1) * (VECTOR_MESH + 1) * 2);
      let k = 0;
      const cssWidth = canvas.clientWidth || width;
      const cssHeight = canvas.clientHeight || height;
      for (let j = 0; j <= VECTOR_MESH; j++) {
        for (let i = 0; i <= VECTOR_MESH; i++) {
          const ll = map.unproject([(i / VECTOR_MESH) * cssWidth, (j / VECTOR_MESH) * cssHeight]);
          const [px, py] = this.mapper.lonLatToPixel(ll.lng, ll.lat);
          mesh[k++] = px;
          mesh[k++] = py;
        }
      }
      this.snapshot?.bitmap.close();
      this.snapshot = { bitmap, mesh, width: bitmap.width, height: bitmap.height };
      this.redraw();
    } catch (error) {
      if (!this.error) {
        this.error = (error as Error).message ?? String(error);
        this.onError(`Vector basemap: ${this.error}`);
      }
    } finally {
      this.rendering = false;
      if (!this.lastViewKey && !this.disposed) this.redraw();
    }
  }

  draw(ctx: CanvasRenderingContext2D, view: ViewState): void {
    this.scheduleRender(view);
    if (!this.snapshot) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    drawWarped(ctx, this.snapshot.bitmap, this.snapshot.width, this.snapshot.height, this.snapshot.mesh, VECTOR_MESH, view);
    ctx.restore();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.renderTimer);
    this.snapshot?.bitmap.close();
    this.map?.remove();
    this.container?.remove();
  }
}
