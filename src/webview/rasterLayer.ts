import type { CompositeSpec } from '../shared/presets';
import type { ByteRange, FileInfo, GeoInfo, MainToWorker, PageInfo, PixelWindow, WorkerToMain } from '../shared/protocol';
import { drawWarped, type ViewState } from './basemap';
import { GeoMapper } from './geo';

/**
 * A raster layer added on top of the opened image (QGIS-like): another TIFF,
 * decoded by its own worker and drawn into the opened image's pixel grid,
 * clipped to its extent.
 *
 * Like a QGIS map canvas, the part of the layer in view is rendered as one
 * picture at the resolution the zoom needs (the worker reads the right
 * pyramid level), and drawn with the mapping from the layer's pixels to the
 * opened image's: an affine transform when both share a coordinate system,
 * otherwise a warp through longitude/latitude (as the basemaps).
 */

/** Random access to the layer's bytes (a file read by the extension host, or a file dropped from the OS). */
export interface ByteSource {
  readonly size: number;
  read(ranges: ByteRange[]): Promise<Uint8Array[]>;
  close(): void;
}

type Point = [number, number];

/** Source pixels (a layer's, or the opened image's) ↔ the canvas grid's pixels. */
export interface PixelMapping {
  toCanvas(x: number, y: number): Point;
  toSource(x: number, y: number): Point;
  /** The same mapping as a canvas transform (a, b, c, d, e, f), when it is affine. */
  affine?: [number, number, number, number, number, number];
}

function sameCrs(a: GeoInfo, b: GeoInfo): boolean {
  return a.proj4 === b.proj4 && a.factors.x === b.factors.x && a.factors.y === b.factors.y;
}

/**
 * How a layer lies on the opened image: reprojected into its coordinate system.
 * Undefined unless both are georeferenced.
 */
export function pixelMapping(layer: GeoInfo | undefined, canvas: GeoInfo | undefined): PixelMapping | undefined {
  const master = canvas;
  if (!layer || !master) return undefined;
  const from = new GeoMapper(layer);
  const to = new GeoMapper(master);
  if (sameCrs(layer, master)) {
    const toCanvas = (x: number, y: number): Point => to.crsToPixel(...from.pixelToCrs(x, y));
    const toSource = (x: number, y: number): Point => from.crsToPixel(...to.pixelToCrs(x, y));
    const o = toCanvas(0, 0);
    const u = toCanvas(1, 0);
    const v = toCanvas(0, 1);
    return { toCanvas, toSource, affine: [u[0] - o[0], u[1] - o[1], v[0] - o[0], v[1] - o[1], o[0], o[1]] };
  }
  return {
    toCanvas: (x, y) => to.lonLatToPixel(...from.pixelToLonLat(x, y)),
    toSource: (x, y) => from.lonLatToPixel(...to.pixelToLonLat(x, y)),
  };
}

/** Points along the border of [x0, y0, x1, y1] (and across it), `n` steps a side. */
function samplePoints(x0: number, y0: number, x1: number, y1: number, n: number): Point[] {
  const points: Point[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) points.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * j) / n]);
  return points;
}

/** The layer's extent in grid pixels (bounding box), or undefined when it cannot be projected. */
export function extentInCanvas(page: PageInfo, mapping: PixelMapping): PixelWindow | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of samplePoints(0, 0, page.width, page.height, 16)) {
    const [mx, my] = mapping.toCanvas(x, y);
    if (!Number.isFinite(mx) || !Number.isFinite(my)) continue;
    minX = Math.min(minX, mx);
    minY = Math.min(minY, my);
    maxX = Math.max(maxX, mx);
    maxY = Math.max(maxY, my);
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : undefined;
}

interface Picture {
  bitmap: ImageBitmap;
  window: PixelWindow;
  generation: number;
  /** Mesh points in the opened image's pixels, for a warped layer. */
  mesh?: Float64Array;
}

const MESH = 16;
/** Largest side of the picture rendered for the view. */
const MAX_SIDE = 4096;

export interface RasterLayerHost {
  createWorker(onMessage: (message: WorkerToMain) => void): Promise<Worker>;
  redraw(): void;
  /** Worker messages the layer does not handle itself (classify answers). */
  onOther(layer: RasterLayer, message: WorkerToMain): void;
  /** Loading progress of this layer, 0…1, or undefined when done. */
  onProgress(layer: RasterLayer, fraction: number | undefined): void;
  /** A pixel's values arrived (see readPixel). */
  onPixel(layer: RasterLayer): void;
}

/** A pixel of the layer and its values (and the rendering's values there). */
export interface PixelReadout {
  x: number;
  y: number;
  values: number[] | null;
  computed?: number[];
}

let nextLayerId = 1;

export class RasterLayer {
  readonly id = nextLayerId++;
  visible = true;
  opacity = 1;
  info: FileInfo | undefined;
  page: PageInfo | undefined;
  mapping: PixelMapping | undefined;
  composite: CompositeSpec | undefined;
  /** The Rendering panel's state for this layer, kept while another layer is edited. */
  renderState: unknown;
  /** Where the layer lies on the opened image (its pixels). */
  extent: PixelWindow | undefined;
  /** The layer's outline in grid pixels, when warped (its drawing is clipped to it). */
  private outline: Float64Array | undefined;
  private worker: Worker | undefined;
  private generation = 1;
  private picture: Picture | undefined;
  private partial: Picture | undefined;
  private requests = 0;
  private wantedKey = '';
  private pending = new Map<string, { window: PixelWindow; generation: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private disposed = false;
  /** The pixel under the pointer, once its values arrive. */
  readout: PixelReadout | undefined;
  private pixelReq = 0;
  private pixelShown = 0;
  private pixelKey = '';

  constructor(
    readonly name: string,
    private readonly source: ByteSource,
    private readonly host: RasterLayerHost,
  ) {}

  /** Opens the file; resolves with its first page (the one shown). */
  async open(): Promise<PageInfo> {
    const opened = new Promise<FileInfo>((resolve, reject) => {
      void this.host
        .createWorker((message) => {
          if (message.type === 'opened') resolve(message.info);
          else if (message.type === 'openError') reject(new Error(message.message));
          else this.onMessage(message);
        })
        .then((worker) => {
          if (this.disposed) {
            worker.terminate();
            return;
          }
          this.worker = worker;
          this.post({ type: 'open', fileSize: this.source.size });
        }, reject);
    });
    this.info = await opened;
    const page = this.info.pages[0];
    if (!page) throw new Error('The file contains no images.');
    if (page.unsupported) throw new Error(page.unsupported);
    this.page = page;
    return page;
  }

  post(message: MainToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(message, transfer);
  }

  private onMessage(message: WorkerToMain): void {
    switch (message.type) {
      case 'read':
        this.source.read(message.ranges).then(
          (chunks) => {
            const buffers = chunks.map((c) => (c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c.buffer : c.slice().buffer) as ArrayBuffer);
            this.post({ type: 'readResult', id: message.id, data: buffers }, buffers);
          },
          (error) => this.post({ type: 'readError', id: message.id, message: String((error as Error)?.message ?? error) }),
        );
        break;
      case 'tile':
        void this.onTile(message);
        break;
      case 'progress': {
        if (message.generation !== this.generation || !this.pending.has(message.id)) break;
        this.host.onProgress(this, message.total ? message.done / message.total : undefined);
        break;
      }
      case 'tileError':
        if (this.pending.delete(message.id)) this.host.onProgress(this, undefined);
        break;
      case 'pixel':
        // Newest request wins; answers to older ones still show while the pointer moves.
        if (message.reqId > this.pixelShown && this.pixelKey) {
          this.pixelShown = message.reqId;
          this.readout = { x: message.x, y: message.y, values: message.values, computed: message.computed };
          this.host.onPixel(this);
        }
        break;
      default:
        this.host.onOther(this, message);
    }
  }

  private async onTile(message: Extract<WorkerToMain, { type: 'tile' }>): Promise<void> {
    const request = this.pending.get(message.id);
    if (!request || message.generation !== this.generation) return;
    const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(message.rgba), message.width, message.height));
    if (this.disposed || !this.pending.has(message.id)) {
      bitmap.close();
      return;
    }
    const picture: Picture = { bitmap, window: request.window, generation: request.generation, mesh: this.meshFor(request.window) };
    if (message.final) {
      this.pending.delete(message.id);
      this.picture?.bitmap.close();
      this.picture = picture;
      this.partial?.bitmap.close();
      this.partial = undefined;
      this.host.onProgress(this, undefined);
    } else {
      // Rows decoded so far, over the previous picture until the new one is complete.
      this.partial?.bitmap.close();
      this.partial = picture;
    }
    this.host.redraw();
  }

  private meshFor(window: PixelWindow): Float64Array | undefined {
    const mapping = this.mapping;
    if (!mapping || mapping.affine) return undefined;
    const [x0, y0, x1, y1] = window;
    const mesh = new Float64Array((MESH + 1) * (MESH + 1) * 2);
    let k = 0;
    for (const [x, y] of samplePoints(x0, y0, x1, y1, MESH)) {
      const [mx, my] = mapping.toCanvas(x, y);
      mesh[k++] = mx;
      mesh[k++] = my;
    }
    return mesh;
  }

  /** Asks for the values of the layer's pixel at grid point (gx, gy); none when outside the layer. */
  readPixel(gx: number, gy: number): void {
    const page = this.page;
    const mapping = this.mapping;
    if (!page || !mapping || !this.visible) return this.clearPixel();
    const [lx, ly] = mapping.toSource(gx, gy);
    const x = Math.floor(lx);
    const y = Math.floor(ly);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= page.width || y >= page.height) return this.clearPixel();
    const key = `${x},${y},${this.generation}`;
    if (key === this.pixelKey) return;
    this.pixelKey = key;
    this.post({ type: 'pixel', reqId: ++this.pixelReq, page: 0, x, y, composite: this.composite });
  }

  clearPixel(): void {
    this.pixelKey = '';
    this.pixelShown = this.pixelReq;
    this.readout = undefined;
  }

  /** Places the layer on (another page of) the opened image; drops pictures placed the old way. */
  setMapping(mapping: PixelMapping | undefined, extent: PixelWindow | undefined): void {
    this.mapping = mapping;
    this.extent = extent;
    this.outline = undefined;
    if (mapping && !mapping.affine && this.page) {
      const { width, height } = this.page;
      const n = 32;
      const border: [number, number][] = [];
      for (let i = 0; i < n; i++) border.push([(width * i) / n, 0]);
      for (let i = 0; i < n; i++) border.push([width, (height * i) / n]);
      for (let i = n; i > 0; i--) border.push([(width * i) / n, height]);
      for (let i = n; i > 0; i--) border.push([0, (height * i) / n]);
      this.outline = Float64Array.from(border.flatMap(([x, y]) => mapping.toCanvas(x, y)));
    }
    this.picture?.bitmap.close();
    this.partial?.bitmap.close();
    this.picture = this.partial = undefined;
    this.pending.clear();
    this.wantedKey = '';
  }

  /** Renders with `spec` (undefined: the file's own colours). */
  setComposite(spec: CompositeSpec | undefined): void {
    if (JSON.stringify(spec ?? null) === JSON.stringify(this.composite ?? null)) return;
    this.composite = spec;
    this.generation++;
    this.wantedKey = '';
    this.host.redraw();
  }

  /**
   * Called on every redraw: asks for a new picture when the view needs one
   * (debounced). `area` is where layers show (the opened image's extent), in grid pixels.
   */
  update(view: ViewState, area: PixelWindow): void {
    if (!this.visible || this.opacity <= 0 || !this.page || !this.mapping || !this.worker) return;
    const request = this.wanted(view, area);
    if (!request) return;
    const key = `${this.generation}|${request.window.join(',')}|${request.outWidth}x${request.outHeight}`;
    if (key === this.wantedKey) return;
    this.wantedKey = key;
    clearTimeout(this.timer);
    // The first picture at once, later ones once the view settles.
    this.timer = setTimeout(() => this.request(request.window, request.outWidth, request.outHeight), this.picture ? 150 : 0);
  }

  private request(window: PixelWindow, outWidth: number, outHeight: number): void {
    const id = `v${++this.requests}`;
    this.pending.clear();
    this.pending.set(id, { window, generation: this.generation });
    this.post({ type: 'tiles', generation: this.generation, page: 0, tone: 'minmax', composite: this.composite, tiles: [{ id, window, outWidth, outHeight }] });
  }

  /** The window of the layer in view (clipped to the opened image) and the picture size the zoom needs. */
  private wanted(view: ViewState, area: PixelWindow): { window: PixelWindow; outWidth: number; outHeight: number } | undefined {
    const page = this.page!;
    const mapping = this.mapping!;
    const s = view.scale;
    const vx0 = Math.max(area[0], -view.tx / s);
    const vy0 = Math.max(area[1], -view.ty / s);
    const vx1 = Math.min(area[2], (view.width - view.tx) / s);
    const vy1 = Math.min(area[3], (view.height - view.ty) / s);
    if (vx1 <= vx0 || vy1 <= vy0) return undefined;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of samplePoints(vx0, vy0, vx1, vy1, mapping.affine ? 1 : 8)) {
      const [lx, ly] = mapping.toSource(x, y);
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue;
      minX = Math.min(minX, lx);
      minY = Math.min(minY, ly);
      maxX = Math.max(maxX, lx);
      maxY = Math.max(maxY, ly);
    }
    if (!Number.isFinite(minX)) return undefined;
    // A little margin for the warp's curvature between sample points.
    const pad = mapping.affine ? 1 : 2 + (maxX - minX) * 0.01;
    const x0 = Math.max(0, Math.floor(minX - pad));
    const y0 = Math.max(0, Math.floor(minY - pad));
    const x1 = Math.min(page.width, Math.ceil(maxX + pad));
    const y1 = Math.min(page.height, Math.ceil(maxY + pad));
    if (x1 <= x0 || y1 <= y0) return undefined;
    // Device pixels per layer pixel, at the centre of the window.
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const o = mapping.toCanvas(cx, cy);
    const u = mapping.toCanvas(cx + 1, cy);
    const v = mapping.toCanvas(cx, cy + 1);
    const perPixel = Math.max(Math.hypot(u[0] - o[0], u[1] - o[1]), Math.hypot(v[0] - o[0], v[1] - o[1])) * s * view.dpr;
    const k = Number.isFinite(perPixel) && perPixel > 0 ? Math.min(1, perPixel) : 1;
    let outWidth = Math.max(1, Math.round((x1 - x0) * k));
    let outHeight = Math.max(1, Math.round((y1 - y0) * k));
    const shrink = Math.min(1, MAX_SIDE / Math.max(outWidth, outHeight));
    outWidth = Math.max(1, Math.round(outWidth * shrink));
    outHeight = Math.max(1, Math.round(outHeight * shrink));
    return { window: [x0, y0, x1, y1], outWidth, outHeight };
  }

  /** Draws the layer (clipped to the opened image by `clip`) with its opacity. */
  draw(ctx: CanvasRenderingContext2D, view: ViewState, clip: (ctx: CanvasRenderingContext2D) => void): void {
    if (!this.visible || this.opacity <= 0 || !this.mapping || (!this.picture && !this.partial)) return;
    const { width, height } = ctx.canvas;
    // On a layer of its own, blended once: warped cells overlap a little (hiding seams),
    // which would show as lines if each were blended.
    this.canvas ??= document.createElement('canvas');
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const layer = this.canvas.getContext('2d')!;
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.clearRect(0, 0, width, height);
    layer.save();
    clip(layer);
    if (this.outline) {
      // Warped cells overlap a little to hide seams: keep them within the layer's outline.
      const o = this.outline;
      const k = view.dpr;
      layer.beginPath();
      let started = false;
      for (let i = 0; i < o.length; i += 2) {
        if (!Number.isFinite(o[i]) || !Number.isFinite(o[i + 1])) continue;
        const x = (view.tx + o[i] * view.scale) * k;
        const y = (view.ty + o[i + 1] * view.scale) * k;
        if (started) layer.lineTo(x, y);
        else layer.moveTo(x, y);
        started = true;
      }
      layer.closePath();
      layer.clip();
    }
    for (const picture of [this.picture, this.partial]) if (picture) this.drawPicture(layer, view, picture);
    layer.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = this.opacity;
    ctx.drawImage(this.canvas, 0, 0);
    ctx.restore();
  }

  private drawPicture(ctx: CanvasRenderingContext2D, view: ViewState, picture: Picture): void {
    const [x0, y0, x1, y1] = picture.window;
    const { bitmap } = picture;
    const k = view.scale * view.dpr;
    const affine = this.mapping?.affine;
    // Crisp pixels when magnifying the layer's full resolution; smooth otherwise.
    const magnified = bitmap.width >= x1 - x0 && k * Math.hypot(affine?.[0] ?? 1, affine?.[1] ?? 0) >= 1;
    ctx.imageSmoothingEnabled = !magnified;
    ctx.imageSmoothingQuality = 'high';
    if (affine) {
      const [a, b, c, d, e, f] = affine;
      ctx.setTransform(k * a, k * b, k * c, k * d, k * e + view.tx * view.dpr, k * f + view.ty * view.dpr);
      ctx.drawImage(bitmap, x0, y0, x1 - x0, y1 - y0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else if (picture.mesh) {
      drawWarped(ctx, bitmap, bitmap.width, bitmap.height, picture.mesh, MESH, view);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = undefined;
    this.picture?.bitmap.close();
    this.partial?.bitmap.close();
    this.picture = this.partial = undefined;
    this.source.close();
  }
}
