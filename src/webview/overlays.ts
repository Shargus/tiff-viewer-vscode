import type { Geometry, Position } from 'geojson';
import { BASEMAP_PROVIDERS, type BasemapProvider } from '../shared/basemaps';
import type { HostToWebview, PageInfo, PixelWindow, WebviewToHost } from '../shared/protocol';
import { TileBasemap, VectorBasemap, type Basemap, type ViewState } from './basemap';
import { converterToLonLat, GeoMapper } from './geo';
import { parseWmtsCapabilities, wmtsSource, xyzSource, type WmtsCapabilities, type WmtsLayer } from './tilegrid';
import { toBytes } from './bytes';
import { readVectorFiles, type VectorData } from './vectors';

/**
 * The Overlays panel: a basemap and vector layers drawn over (or under) a
 * georeferenced image, reprojected into its coordinate system and clipped to
 * its extent, plus coordinate ticks and a scale bar.
 */

export interface OverlayHost {
  post(message: WebviewToHost): void;
  redraw(): void;
  view(): ViewState;
  page(): PageInfo | undefined;
  /** Shows a window of the image (full-resolution pixels). */
  showWindow(window: PixelWindow): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Distinct, readable layer colours. */
const LAYER_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ff2d92', '#ff9f0a', '#64d2ff', '#bf5af2'];

interface VectorLayer {
  data: VectorData;
  visible: boolean;
  color: string;
  width: number;
  opacity: number;
  /** In image pixels. */
  areas: Path2D;
  lines: Path2D;
  points: Float64Array;
  bounds: PixelWindow | undefined;
  count: number;
  /** Features whose extent overlaps the image's. */
  inside: number;
}

function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 1, 2 or 5 × 10ⁿ, the largest not above `value`. */
function niceBelow(value: number): number {
  const p = 10 ** Math.floor(Math.log10(value));
  const f = value / p;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
}

/** 1, 2, 2.5 or 5 × 10ⁿ, the smallest not below `value` (tick spacing). */
function niceAbove(value: number): number {
  const p = 10 ** Math.floor(Math.log10(value));
  const f = value / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

export class Overlays {
  private mapper: GeoMapper | undefined;
  private pageInfo: PageInfo | undefined;
  imageOpacity = 1;
  private basemap: Basemap | undefined;
  private basemapOpacity = 1;
  private basemapAbove = false;
  private ticks = false;
  private layers: VectorLayer[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (m: Extract<HostToWebview, { type: 'fetched' | 'overlayRead' | 'layersChosen' }>) => void }>();
  private readonly capabilities = new Map<string, Promise<WmtsCapabilities>>();
  private wmts: { caps: WmtsCapabilities; provider: Extract<BasemapProvider, { kind: 'wmts' }> } | undefined;

  constructor(private readonly host: OverlayHost) {
    this.setupPanel();
  }

  // --- Host requests ---

  private request<T extends 'fetched' | 'overlayRead' | 'layersChosen'>(message: WebviewToHost & { id: number }): Promise<Extract<HostToWebview, { type: T }>> {
    return new Promise((resolve) => {
      this.pending.set(message.id, { resolve: resolve as never });
      this.host.post(message);
    });
  }

  private readonly fetchBytes = async (url: string): Promise<Uint8Array> => {
    const result = await this.request<'fetched'>({ type: 'fetch', id: this.nextId++, url, as: 'bytes' });
    if (!result.ok || !result.bytes) throw new Error(result.error ?? `HTTP ${result.status}`);
    return result.bytes;
  };

  private readonly fetchText = async (url: string): Promise<string> => {
    const result = await this.request<'fetched'>({ type: 'fetch', id: this.nextId++, url, as: 'text' });
    if (!result.ok || result.text === undefined) throw new Error(result.error ?? `HTTP ${result.status}`);
    return result.text;
  };

  /** Messages from the extension host; returns true when handled. */
  onHostMessage(message: HostToWebview): boolean {
    if (message.type === 'fetched' || message.type === 'overlayRead' || message.type === 'layersChosen') {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.type === 'fetched' && message.bytes) message.bytes = toBytes(message.bytes);
      if (message.type === 'overlayRead' && message.files) message.files = message.files.map((f) => ({ name: f.name, data: toBytes(f.data) }));
      waiter?.resolve(message as never);
      return true;
    }
    if (message.type === 'overlayBrowsed') {
      for (const path of message.paths) void this.addVector(path);
      return true;
    }
    return false;
  }

  // --- Page ---

  /** The current page: overlays are available when it is georeferenced. */
  setPage(page: PageInfo | undefined): void {
    const geo = page?.geo;
    const same = this.pageInfo?.geo && geo && JSON.stringify(this.pageInfo.geo) === JSON.stringify(geo);
    this.pageInfo = page;
    const toggle = $<HTMLButtonElement>('overlaysToggle');
    toggle.disabled = !geo;
    toggle.title = geo ? `Basemaps, vector layers, coordinates and scale (${geo.crsName})` : 'Overlays need a georeferenced image (GeoTIFF)';
    if (!geo) {
      $('overlays').hidden = true;
      toggle.setAttribute('aria-pressed', 'false');
    }
    if (same) return;
    this.mapper = geo ? new GeoMapper(geo) : undefined;
    $('overlayCrs').textContent = geo ? `Coordinate system: ${geo.crsName}` : '';
    // Rebuild what depends on the georeferencing.
    if (this.basemap) this.selectBasemap();
    for (const layer of this.layers) this.build(layer);
    this.renderLayerList();
    this.host.redraw();
  }

  get available(): boolean {
    return !!this.mapper;
  }

  /** Shows or hides the coordinate ticks, grid and scale bar (the button, and the G key). */
  toggleTicks(): void {
    if (!this.mapper) return;
    this.ticks = !this.ticks;
    $<HTMLButtonElement>('ticksToggle').setAttribute('aria-pressed', String(this.ticks));
    this.host.redraw();
  }

  /** Whether the image must be drawn on its own layer (something under it, or see-through). */
  get layered(): boolean {
    return !!this.mapper && ((!!this.basemap && !this.basemapAbove && this.basemapOpacity > 0) || this.imageOpacity < 1);
  }

  // --- Drawing ---

  /** Clips to the image's extent (device pixels). */
  private clipToImage(ctx: CanvasRenderingContext2D, view: ViewState): boolean {
    const page = this.pageInfo;
    if (!page) return false;
    const k = view.dpr;
    const x0 = view.tx * k;
    const y0 = view.ty * k;
    const w = page.width * view.scale * k;
    const h = page.height * view.scale * k;
    ctx.beginPath();
    ctx.rect(Math.round(x0), Math.round(y0), Math.round(x0 + w) - Math.round(x0), Math.round(y0 + h) - Math.round(y0));
    ctx.clip();
    return true;
  }

  private basemapLayer: HTMLCanvasElement | undefined;

  drawBasemap(ctx: CanvasRenderingContext2D, view: ViewState, position: 'below' | 'above'): void {
    if (!this.mapper || !this.basemap || this.basemapAbove !== (position === 'above') || this.basemapOpacity <= 0) return;
    // Drawn opaque on its own layer, then blended once: the warped cells overlap a
    // little (hiding seams), which would show as lines if each were blended.
    const { width, height } = ctx.canvas;
    this.basemapLayer ??= document.createElement('canvas');
    if (this.basemapLayer.width !== width || this.basemapLayer.height !== height) {
      this.basemapLayer.width = width;
      this.basemapLayer.height = height;
    }
    const layer = this.basemapLayer.getContext('2d')!;
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.clearRect(0, 0, width, height);
    layer.save();
    if (this.clipToImage(layer, view)) this.basemap.draw(layer, view);
    layer.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = this.basemapOpacity;
    ctx.drawImage(this.basemapLayer, 0, 0);
    ctx.restore();
  }

  /** Vector layers, ticks, scale bar and attribution: everything above the image. */
  drawTop(ctx: CanvasRenderingContext2D, view: ViewState): void {
    if (!this.mapper) return;
    ctx.save();
    if (this.clipToImage(ctx, view)) {
      for (const layer of this.layers) if (layer.visible && layer.opacity > 0) this.drawLayer(ctx, view, layer);
    }
    ctx.restore();
    if (this.ticks) this.drawTicks(ctx, view);
    if (this.basemap && this.basemapOpacity > 0 && this.basemap.attribution) this.drawAttribution(ctx, view, this.basemap.attribution);
  }

  private drawLayer(ctx: CanvasRenderingContext2D, view: ViewState, layer: VectorLayer): void {
    const k = view.scale * view.dpr;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.setTransform(k, 0, 0, k, view.tx * view.dpr, view.ty * view.dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = (layer.width * view.dpr) / k;
    ctx.strokeStyle = layer.color;
    ctx.fillStyle = layer.color;
    ctx.globalAlpha = layer.opacity * 0.25;
    ctx.fill(layer.areas, 'evenodd');
    ctx.globalAlpha = layer.opacity;
    ctx.stroke(layer.areas);
    ctx.stroke(layer.lines);
    if (layer.points.length) {
      const r = ((layer.width + 2.5) * view.dpr) / k;
      const dots = new Path2D();
      for (let i = 0; i < layer.points.length; i += 2) {
        const x = layer.points[i];
        const y = layer.points[i + 1];
        dots.moveTo(x + r, y);
        dots.arc(x, y, r, 0, 2 * Math.PI);
      }
      ctx.fill(dots);
      ctx.lineWidth = view.dpr / k;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke(dots);
    }
    ctx.restore();
  }

  private text(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, align: CanvasTextAlign, baseline: CanvasTextBaseline): void {
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, x, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x, y);
  }

  private drawAttribution(ctx: CanvasRenderingContext2D, view: ViewState, attribution: string): void {
    ctx.save();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.font = '10px sans-serif';
    this.text(ctx, attribution, view.width - 6, 4, 'right', 'top');
    ctx.restore();
  }

  /** "585 000" for metres, "74.25°W" for degrees, with the precision the spacing needs. */
  private formatCoordinate(value: number, step: number, axis: 'x' | 'y'): string {
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    if (this.pageInfo?.geo?.geographic) {
      const hemisphere = axis === 'x' ? (value < 0 ? 'W' : 'E') : value < 0 ? 'S' : 'N';
      return `${Math.abs(value).toFixed(decimals)}°${value === 0 ? '' : hemisphere}`;
    }
    const fixed = value.toFixed(decimals);
    const [int, frac] = fixed.split('.');
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (frac ? `.${frac}` : '');
  }

  /**
   * Ticks of the image's x coordinate along the lower border and of y along
   * the left border (of the part of the image in view), and a scale bar.
   */
  private drawTicks(ctx: CanvasRenderingContext2D, view: ViewState): void {
    const page = this.pageInfo;
    const mapper = this.mapper;
    if (!page || !mapper) return;
    const ix0 = view.tx;
    const iy0 = view.ty;
    const ix1 = view.tx + page.width * view.scale;
    const iy1 = view.ty + page.height * view.scale;
    const vx0 = Math.max(0, ix0);
    const vx1 = Math.min(view.width, ix1);
    const vy0 = Math.max(0, iy0);
    const vy1 = Math.min(view.height, iy1);
    if (vx1 - vx0 < 40 || vy1 - vy0 < 40) return;
    const crsAt = (sx: number, sy: number) => mapper.pixelToCrs((sx - view.tx) / view.scale, (sy - view.ty) / view.scale);
    ctx.save();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.font = '11px sans-serif';
    const tick = 6;

    // Tick values: whole multiples of the step (no drift from repeated addition).
    const values = (a: number, b: number, step: number) => {
      const out: number[] = [];
      for (let k = Math.ceil(Math.min(a, b) / step); k * step <= Math.max(a, b); k++) out.push(k * step);
      return out;
    };
    const xa = crsAt(vx0, vy1)[0];
    const xb = crsAt(vx1, vy1)[0];
    const xStep = xb !== xa ? niceAbove(Math.abs(xb - xa) / Math.max(2, Math.floor((vx1 - vx0) / 110))) : 0;
    const ya = crsAt(vx0, vy0)[1];
    const yb = crsAt(vx0, vy1)[1];
    const yStep = yb !== ya ? niceAbove(Math.abs(yb - ya) / Math.max(2, Math.floor((vy1 - vy0) / 70))) : 0;

    // A thin grid at the ticks, over the part of the image in view. Lines follow the
    // geotransform, so they stay true for rotated images too.
    ctx.save();
    ctx.beginPath();
    ctx.rect(vx0, vy0, vx1 - vx0, vy1 - vy0);
    ctx.clip();
    const [t0, t1, t2, t3, t4, t5] = mapper.geo.transform;
    const c0 = (vx0 - view.tx) / view.scale;
    const c1 = (vx1 - view.tx) / view.scale;
    const r0 = (vy0 - view.ty) / view.scale;
    const r1 = (vy1 - view.ty) / view.scale;
    const grid = new Path2D();
    const segment = (ca: number, ra: number, cb: number, rb: number) => {
      grid.moveTo(view.tx + ca * view.scale, view.ty + ra * view.scale);
      grid.lineTo(view.tx + cb * view.scale, view.ty + rb * view.scale);
    };
    if (xStep) {
      for (const v of values(xa, xb, xStep)) {
        // x = t0 + t1·col + t2·row = v
        if (Math.abs(t1) >= Math.abs(t2)) segment((v - t0 - t2 * r0) / t1, r0, (v - t0 - t2 * r1) / t1, r1);
        else segment(c0, (v - t0 - t1 * c0) / t2, c1, (v - t0 - t1 * c1) / t2);
      }
    }
    if (yStep) {
      for (const v of values(ya, yb, yStep)) {
        // y = t3 + t4·col + t5·row = v
        if (Math.abs(t5) >= Math.abs(t4)) segment(c0, (v - t3 - t4 * c0) / t5, c1, (v - t3 - t4 * c1) / t5);
        else segment((v - t3 - t5 * r0) / t4, r0, (v - t3 - t5 * r1) / t4, r1);
      }
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.stroke(grid);
    ctx.lineWidth = 0.75;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.stroke(grid);
    ctx.restore();

    // x along the lower border: below it when there is room, else inside.
    const below = view.height - vy1 >= 20;
    if (xStep) {
      const step = xStep;
      for (const v of values(xa, xb, step)) {
        const sx = vx0 + ((v - xa) / (xb - xa)) * (vx1 - vx0);
        const y = below ? vy1 : vy1 - tick;
        this.line(ctx, sx, y, sx, y + tick);
        this.text(ctx, this.formatCoordinate(v, step, 'x'), sx, below ? vy1 + tick + 1 : vy1 - tick - 2, 'center', below ? 'top' : 'bottom');
      }
    }
    // y along the left border: to its left when there is room, else inside.
    const left = vx0 >= 70;
    if (yStep) {
      const step = yStep;
      for (const v of values(ya, yb, step)) {
        const sy = vy0 + ((v - ya) / (yb - ya)) * (vy1 - vy0);
        const x = left ? vx0 - tick : vx0;
        this.line(ctx, x, sy, x + tick, sy);
        this.text(ctx, this.formatCoordinate(v, step, 'y'), left ? vx0 - tick - 3 : vx0 + tick + 3, sy, left ? 'right' : 'left', 'middle');
      }
    }

    // Scale bar near the lower left corner of the image in view, in true ground distance.
    const bx = vx0 + (left ? 16 : 70);
    const by = vy1 - (below ? 18 : 30);
    const [lon1, lat1] = mapper.pixelToLonLat((bx - view.tx) / view.scale, (by - view.ty) / view.scale);
    const [lon2, lat2] = mapper.pixelToLonLat((bx + 100 - view.tx) / view.scale, (by - view.ty) / view.scale);
    const metresPerPixel = haversine(lon1, lat1, lon2, lat2) / 100;
    if (Number.isFinite(metresPerPixel) && metresPerPixel > 0 && vx1 - bx > 80) {
      const length = niceBelow(Math.min(160, vx1 - bx - 20) * metresPerPixel);
      const px = length / metresPerPixel;
      const label = length >= 1000 ? `${length / 1000} km` : length >= 1 ? `${length} m` : `${Math.round(length * 100)} cm`;
      this.line(ctx, bx, by, bx + px, by);
      this.line(ctx, bx, by - 5, bx, by + 1);
      this.line(ctx, bx + px, by - 5, bx + px, by + 1);
      this.text(ctx, label, bx + px / 2, by - 4, 'center', 'bottom');
    }
    ctx.restore();
  }

  private line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, Math.round(y0) + 0.5);
    ctx.lineTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.stroke();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  // --- Vector layers ---

  /** Projects a layer's geometries into image pixels (exactly, vertex by vertex). */
  private build(layer: VectorLayer): void {
    const mapper = this.mapper;
    layer.areas = new Path2D();
    layer.lines = new Path2D();
    layer.bounds = undefined;
    layer.inside = 0;
    if (!mapper) {
      layer.points = new Float64Array();
      return;
    }
    const crs = layer.data.crs;
    const imageEpsg = Number(/^EPSG:(\d+)/.exec(mapper.geo.crsName)?.[1]);
    let toPixel: (p: Position) => [number, number];
    if (!crs) {
      toPixel = (p) => mapper.lonLatToPixel(p[0], p[1]);
    } else if (crs.epsg && crs.epsg === imageEpsg) {
      // Same coordinate system: straight through the geotransform.
      toPixel = (p) => mapper.crsToPixel(p[0], p[1]);
    } else {
      const toLonLat = converterToLonLat(crs.proj4);
      if (!toLonLat) throw new Error(`${layer.data.name}: cannot use its coordinate system`);
      toPixel = (p) => mapper.lonLatToPixel(...toLonLat(p[0], p[1]));
    }
    const points: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    // The current feature's extent, to count the features that reach the image.
    let fMinX = Infinity;
    let fMinY = Infinity;
    let fMaxX = -Infinity;
    let fMaxY = -Infinity;
    const extend = (x: number, y: number) => {
      if (x < fMinX) fMinX = x;
      if (x > fMaxX) fMaxX = x;
      if (y < fMinY) fMinY = y;
      if (y > fMaxY) fMaxY = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    const path = (target: Path2D, coords: Position[], close: boolean) => {
      let started = false;
      for (const c of coords) {
        const [x, y] = toPixel(c);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          started = false;
          continue;
        }
        extend(x, y);
        if (started) target.lineTo(x, y);
        else target.moveTo(x, y);
        started = true;
      }
      if (close && started) target.closePath();
    };
    const add = (g: Geometry | null | undefined) => {
      if (!g) return;
      switch (g.type) {
        case 'Point': {
          const [x, y] = toPixel(g.coordinates);
          if (Number.isFinite(x)) {
            points.push(x, y);
            extend(x, y);
          }
          break;
        }
        case 'MultiPoint':
          for (const c of g.coordinates) add({ type: 'Point', coordinates: c });
          break;
        case 'LineString':
          path(layer.lines, g.coordinates, false);
          break;
        case 'MultiLineString':
          for (const l of g.coordinates) path(layer.lines, l, false);
          break;
        case 'Polygon':
          for (const ring of g.coordinates) path(layer.areas, ring, true);
          break;
        case 'MultiPolygon':
          for (const polygon of g.coordinates) for (const ring of polygon) path(layer.areas, ring, true);
          break;
        case 'GeometryCollection':
          for (const part of g.geometries) add(part);
          break;
      }
    };
    for (const feature of layer.data.features.features) {
      fMinX = fMinY = Infinity;
      fMaxX = fMaxY = -Infinity;
      add(feature.geometry);
      if (Number.isFinite(fMinX) && this.overlapsImage([fMinX, fMinY, fMaxX, fMaxY])) layer.inside++;
    }
    layer.points = Float64Array.from(points);
    layer.bounds = Number.isFinite(minX) ? [minX, minY, maxX, maxY] : undefined;
  }

  async addVector(path: string): Promise<void> {
    const error = $<HTMLDivElement>('vectorError');
    error.hidden = true;
    if (!path.trim()) return;
    const status = $<HTMLButtonElement>('vectorAdd');
    status.disabled = true;
    status.textContent = 'Reading…';
    try {
      const result = await this.request<'overlayRead'>({ type: 'readOverlay', id: this.nextId++, path });
      if (!result.ok || !result.files) throw new Error(result.error ?? 'Could not read the file');
      let datasets = await readVectorFiles(result.name, result.files);
      if (datasets.length > 1) {
        // Several layers (KML folders, GeoPackage tables, files in a zip): ask which.
        status.textContent = 'Choosing…';
        const prefix = `${result.name}: `;
        const chosen = await this.request<'layersChosen'>({
          type: 'chooseLayers',
          id: this.nextId++,
          file: result.name,
          layers: datasets.map((d) => ({ name: d.name.startsWith(prefix) ? d.name.slice(prefix.length) : d.name, count: d.features.features.length })),
        });
        datasets = chosen.indexes.map((i) => datasets[i]).filter(Boolean);
        if (!datasets.length) return;
      }
      for (const data of datasets) {
        const layer: VectorLayer = {
          data,
          visible: true,
          color: LAYER_COLORS[this.layers.length % LAYER_COLORS.length],
          width: 2,
          opacity: 1,
          areas: new Path2D(),
          lines: new Path2D(),
          points: new Float64Array(),
          bounds: undefined,
          count: data.features.features.length,
          inside: 0,
        };
        this.build(layer);
        this.layers.push(layer);
      }
      $<HTMLInputElement>('vectorPath').value = '';
    } catch (e) {
      this.showError((e as Error).message ?? String(e));
    } finally {
      status.disabled = false;
      status.textContent = 'Add';
      this.renderLayerList();
      this.host.redraw();
    }
  }

  private overlapsImage(bounds: PixelWindow): boolean {
    const page = this.pageInfo;
    return !!page && bounds[2] >= 0 && bounds[3] >= 0 && bounds[0] <= page.width && bounds[1] <= page.height;
  }

  private showError(message: string): void {
    const error = $<HTMLDivElement>('vectorError');
    error.hidden = false;
    error.textContent = message;
  }

  private renderLayerList(): void {
    const list = $<HTMLDivElement>('vectorList');
    list.replaceChildren(
      ...this.layers.map((layer) => {
        const row = document.createElement('div');
        row.className = 'vector-layer';
        const visible = Object.assign(document.createElement('input'), { type: 'checkbox', checked: layer.visible, title: 'Show' });
        visible.addEventListener('change', () => {
          layer.visible = visible.checked;
          this.host.redraw();
        });
        const name = document.createElement('span');
        name.className = 'vector-name';
        name.textContent = layer.data.name;
        name.title = `${layer.data.name}: ${layer.count.toLocaleString()} feature${layer.count === 1 ? '' : 's'}${layer.data.crs?.epsg ? `, EPSG:${layer.data.crs.epsg}` : ''}`;
        const count = document.createElement('span');
        count.className = 'hint';
        count.textContent = `${layer.count.toLocaleString()}`;
        const color = Object.assign(document.createElement('input'), { type: 'color', value: layer.color, title: 'Colour' });
        color.addEventListener('input', () => {
          layer.color = color.value;
          this.host.redraw();
        });
        const width = Object.assign(document.createElement('input'), { type: 'number', min: '0.5', max: '20', step: '0.5', value: String(layer.width), title: 'Line width (px)' });
        width.addEventListener('input', () => {
          const v = Number(width.value);
          if (Number.isFinite(v) && v > 0) {
            layer.width = v;
            this.host.redraw();
          }
        });
        const opacity = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(layer.opacity * 100)), title: `Opacity ${Math.round(layer.opacity * 100)}% (double-click: 100%)` });
        opacity.addEventListener('input', () => {
          layer.opacity = Number(opacity.value) / 100;
          opacity.title = `Opacity ${opacity.value}% (double-click: 100%)`;
          this.host.redraw();
        });
        // Double-click resets to fully opaque.
        opacity.addEventListener('dblclick', () => {
          opacity.value = '100';
          opacity.dispatchEvent(new Event('input'));
        });
        const zoom = Object.assign(document.createElement('button'), { textContent: '⌖', title: 'Zoom to layer' });
        zoom.disabled = !layer.bounds;
        zoom.addEventListener('click', () => layer.bounds && this.host.showWindow(layer.bounds));
        const remove = Object.assign(document.createElement('button'), { textContent: '×', title: 'Remove' });
        remove.addEventListener('click', () => {
          this.layers = this.layers.filter((l) => l !== layer);
          this.renderLayerList();
          this.host.redraw();
        });
        const top = document.createElement('div');
        top.className = 'vector-top';
        top.append(visible, name, count, zoom, remove);
        const style = document.createElement('div');
        style.className = 'vector-style';
        style.append(color, width, opacity);
        row.append(top, style);
        if (!layer.inside) {
          // Loaded, but nothing to see over the image.
          const warning = document.createElement('div');
          warning.className = 'vector-warning';
          warning.textContent =
            layer.count === 0
              ? '⚠ This layer has no features.'
              : layer.count === 1
                ? "⚠ Its only feature is outside the image's extent."
                : `⚠ All ${layer.count.toLocaleString()} features are outside the image's extent.`;
          row.append(warning);
        }
        return row;
      }),
    );
  }

  // --- Basemaps ---

  private provider(): BasemapProvider | undefined {
    const value = $<HTMLSelectElement>('basemapProvider').value;
    return value === '' ? undefined : BASEMAP_PROVIDERS[Number(value)];
  }

  private status(text: string): void {
    $('basemapStatus').textContent = text;
  }

  private async onProviderChange(): Promise<void> {
    const provider = this.provider();
    const item = $<HTMLSelectElement>('basemapItem');
    $('basemapFilterRow').hidden = true;
    $('basemapTimeRow').hidden = true;
    $<HTMLInputElement>('basemapFilter').value = '';
    this.wmts = undefined;
    if (!provider) {
      $('basemapItemRow').hidden = true;
      this.selectBasemap();
      return;
    }
    $('basemapItemRow').hidden = false;
    if (provider.kind !== 'wmts') {
      item.replaceChildren(...provider.items.map((it, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: it.name })));
      this.selectBasemap();
      return;
    }
    item.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Loading layers…' }));
    this.status(`Reading the layers of ${provider.name}…`);
    try {
      let caps = this.capabilities.get(provider.capabilities);
      if (!caps) {
        caps = this.fetchText(provider.capabilities).then(parseWmtsCapabilities);
        caps.catch(() => this.capabilities.delete(provider.capabilities));
        this.capabilities.set(provider.capabilities, caps);
      }
      const result = await caps;
      if (this.provider() !== provider) return;
      this.wmts = { caps: result, provider };
      $('basemapFilterRow').hidden = result.layers.length < 30;
      this.fillWmtsLayers();
      if (provider.defaultLayer) {
        const pattern = new RegExp(provider.defaultLayer);
        const ids = result.layers.map((l, i) => ({ id: l.id, i })).filter((l) => pattern.test(l.id)).sort((a, b) => a.id.localeCompare(b.id));
        if (ids.length) item.value = String(ids[ids.length - 1].i);
      }
      this.status('');
      this.selectBasemap();
    } catch (e) {
      this.status(`Could not read the layers of ${provider.name}: ${(e as Error).message}`);
    }
  }

  private fillWmtsLayers(): void {
    if (!this.wmts) return;
    const filter = $<HTMLInputElement>('basemapFilter').value.trim().toLowerCase();
    const item = $<HTMLSelectElement>('basemapItem');
    const previous = item.value;
    const layers = this.wmts.caps.layers
      .map((layer, i) => ({ layer, i }))
      .filter(({ layer }) => !filter || layer.title.toLowerCase().includes(filter) || layer.id.toLowerCase().includes(filter));
    // Newest first for dated services (Wayback), otherwise by title.
    layers.sort((a, b) => (/\d{4}-\d{2}-\d{2}/.test(a.layer.title) ? b.layer.title.localeCompare(a.layer.title) : a.layer.title.localeCompare(b.layer.title)));
    item.replaceChildren(...layers.map(({ layer, i }) => Object.assign(document.createElement('option'), { value: String(i), textContent: layer.title, title: layer.id })));
    if (layers.some(({ i }) => String(i) === previous)) item.value = previous;
  }

  private currentWmtsLayer(): WmtsLayer | undefined {
    const value = $<HTMLSelectElement>('basemapItem').value;
    return this.wmts && value !== '' ? this.wmts.caps.layers[Number(value)] : undefined;
  }

  /** (Re)creates the basemap from the panel's choice. */
  private selectBasemap(): void {
    this.basemap?.dispose();
    this.basemap = undefined;
    const provider = this.provider();
    const mapper = this.mapper;
    $('basemapOptions').hidden = !provider;
    if (!provider || !mapper) {
      $('basemapAttribution').textContent = '';
      this.host.redraw();
      return;
    }
    const redraw = () => this.host.redraw();
    if (provider.kind === 'wmts') {
      const layer = this.currentWmtsLayer();
      const time = layer?.dimensions.find((d) => /time/i.test(d.id));
      $('basemapTimeRow').hidden = !time;
      if (time) $<HTMLInputElement>('basemapTime').placeholder = time.default;
      if (!layer || !this.wmts) return;
      const values = time && $<HTMLInputElement>('basemapTime').value.trim() ? { [time.id]: $<HTMLInputElement>('basemapTime').value.trim() } : {};
      this.basemap = new TileBasemap(wmtsSource(this.wmts.caps, layer, provider.attribution, values), mapper, this.fetchBytes, redraw);
    } else {
      const item = provider.items[Number($<HTMLSelectElement>('basemapItem').value)] ?? provider.items[0];
      if (provider.kind === 'xyz') {
        this.basemap = new TileBasemap(xyzSource(item.url, provider.attribution, provider.maxZoom), mapper, this.fetchBytes, redraw);
      } else {
        this.basemap = new VectorBasemap(item.style!, /arcgis\.com/i.test(item.url) ? item.url : undefined, provider.attribution, mapper, this.fetchBytes, this.fetchText, redraw, (m) => this.status(m));
      }
    }
    this.status('');
    $('basemapAttribution').textContent = provider.attribution;
    this.host.redraw();
  }

  // --- Panel ---

  private setupPanel(): void {
    const toggle = $<HTMLButtonElement>('overlaysToggle');
    toggle.addEventListener('click', () => {
      const panel = $('overlays');
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-pressed', String(!panel.hidden));
    });
    $<HTMLButtonElement>('ticksToggle').addEventListener('click', () => this.toggleTicks());
    const percent = (sliderId: string, numberId: string, set: (v: number) => void) => {
      const slider = $<HTMLInputElement>(sliderId);
      const number = $<HTMLInputElement>(numberId);
      slider.addEventListener('input', () => {
        number.value = slider.value;
        set(Number(slider.value) / 100);
      });
      // Double-click resets to fully opaque.
      slider.title = `${slider.getAttribute('aria-label') ?? 'Opacity'} (double-click: 100%)`;
      slider.addEventListener('dblclick', () => {
        slider.value = '100';
        slider.dispatchEvent(new Event('input'));
      });
      number.addEventListener('input', () => {
        const v = Number(number.value);
        if (!Number.isFinite(v)) return;
        slider.value = String(Math.min(100, Math.max(0, v)));
        set(Math.min(100, Math.max(0, v)) / 100);
      });
    };
    percent('imageOpacity', 'imageOpacityValue', (v) => {
      this.imageOpacity = v;
      this.host.redraw();
    });
    percent('basemapOpacity', 'basemapOpacityValue', (v) => {
      this.basemapOpacity = v;
      this.host.redraw();
    });
    $<HTMLInputElement>('basemapAbove').addEventListener('change', (e) => {
      this.basemapAbove = (e.target as HTMLInputElement).checked;
      this.host.redraw();
    });

    const providers = $<HTMLSelectElement>('basemapProvider');
    const option = (value: string, text: string) => Object.assign(document.createElement('option'), { value, textContent: text });
    providers.append(option('', 'None'));
    const groups: [string, BasemapProvider['kind']][] = [
      ['Raster tiles', 'xyz'],
      ['Vector tiles', 'vector'],
      ['Tile services (WMTS)', 'wmts'],
    ];
    for (const [label, kind] of groups) {
      const group = document.createElement('optgroup');
      group.label = label;
      BASEMAP_PROVIDERS.forEach((p, i) => {
        if (p.kind === kind) group.append(option(String(i), p.name));
      });
      providers.append(group);
    }
    providers.addEventListener('change', () => void this.onProviderChange());
    $('basemapItem').addEventListener('change', () => this.selectBasemap());
    $('basemapFilter').addEventListener('input', () => {
      this.fillWmtsLayers();
      this.selectBasemap();
    });
    $('basemapTime').addEventListener('change', () => this.selectBasemap());

    const path = $<HTMLInputElement>('vectorPath');
    $('vectorAdd').addEventListener('click', () => void this.addVector(path.value));
    path.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.addVector(path.value);
    });
    $('vectorBrowse').addEventListener('click', () => this.host.post({ type: 'browseOverlay' }));
  }
}
