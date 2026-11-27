import type { Geometry, Position } from 'geojson';
import { BASEMAP_PROVIDERS, type BasemapItem, type BasemapProvider } from '../shared/basemaps';
import type { ByteRange, HostToWebview, PageInfo, PixelWindow, WebviewToHost, WorkerToMain } from '../shared/protocol';
import { localizationSupport, localizeUrl, TileBasemap, VectorBasemap, type Basemap, type Localization, type ViewState } from './basemap';
import { toBytes } from './bytes';
import { converterToLonLat, GeoMapper } from './geo';
import { crsKey, crsOfGeo, parseCrs, regionReference, type CanvasGrid, type Crs, type GridReference } from './grid';
import { extentInCanvas, pixelMapping, RasterLayer, type ByteSource } from './rasterLayer';
import { parseWmtsCapabilities, wmtsSource, xyzSource, type WmtsCapabilities, type WmtsLayer } from './tilegrid';
import { readVectorFiles, type VectorData } from './vectors';

/**
 * The Layers panel, as in QGIS: the opened image, raster layers (other TIFFs)
 * and vector layers in a stack that can be reordered, hidden and made
 * see-through; a basemap under (or over) them; the coordinate system they are
 * drawn in; coordinate ticks and a scale bar. Everything is reprojected into
 * that coordinate system and clipped to the opened image's extent. Layers need
 * a georeferenced image (the panel is greyed out otherwise).
 */

export interface LayersHost {
  post(message: WebviewToHost): void;
  redraw(): void;
  /** Shows a window of the grid (grid pixels). */
  showWindow(window: PixelWindow): void;
  createWorker(onMessage: (message: WorkerToMain) => void): Promise<Worker>;
  /** A raster layer was added: give it its initial rendering. */
  rasterAdded(layer: RasterLayer): void;
  rasterRemoved(layer: RasterLayer): void;
  /** Worker messages of a raster layer that the Rendering panel handles (classify). */
  rasterMessage(layer: RasterLayer, message: WorkerToMain): void;
  /** A raster layer's pixel values arrived (for the value table). */
  rasterPixel(layer: RasterLayer): void;
  /** The raster whose rendering the Rendering panel edits: a layer, or the opened image (undefined). */
  selectTarget(layer: RasterLayer | undefined): void;
  /** Draws everything in another coordinate system. */
  setCrs(crs: Crs): void;
  /** The first layer of an empty viewer: start a grid over `reference`, in `crs`. */
  startGrid(reference: GridReference, crs: Crs): void;
  /** The first data layer on a canvas that already has a grid (a viewer opened from the Command Palette). */
  firstLayer(reference: GridReference): void;
  /** The opened file's layer was removed. */
  imageRemoved(): void;
  /** No layer is left. */
  allRemoved(): void;
  /** Layers were added, removed or reordered (the extent may have changed). */
  layersChanged(): void;
  /** Opens the Rendering panel on a raster (undefined: the opened file's). */
  openRendering(layer: RasterLayer | undefined): void;
  /** Opens the Rendering panel on a vector layer. */
  openVectorRendering(id: number): void;
  /** Opens the Rendering panel on a basemap (its localisation). */
  openBasemapRendering(id: number): void;
  /** Selects a layer (as the Rendering panel's layer) without opening the panel. */
  selectLayer(choice: LayerChoice): void;
}

/** A layer of the stack, for the Rendering panel's layer menu. */
export type RasterChoice = { kind: 'image'; name: string } | { kind: 'raster'; layer: RasterLayer };
export type LayerChoice = RasterChoice | { kind: 'vector'; id: number; name: string } | { kind: 'basemap'; id: number; name: string };

/** How a vector layer is drawn (the Rendering panel's vector view). */
export interface VectorStyle {
  color: string;
  width: number;
  fill: number;
}

/** Bounding box of a dataset's coordinates (in its own coordinate system). */
function dataBounds(data: VectorData): [number, number, number, number] | undefined {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      const [x, y] = c as number[];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      return;
    }
    for (const part of c) visit(part);
  };
  const geometry = (g: Geometry | null | undefined): void => {
    if (!g) return;
    if (g.type === 'GeometryCollection') g.geometries.forEach(geometry);
    else visit(g.coordinates);
  };
  for (const feature of data.features.features) geometry(feature.geometry);
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : undefined;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Distinct, readable layer colours. */
const LAYER_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ff2d92', '#ff9f0a', '#64d2ff', '#bf5af2'];
const RASTER_EXTENSIONS = /\.(tiff?|gtiff?)$/i;
/** Drag data of a layer being moved in the list. */
const LAYER_DRAG = 'application/x-tiff-viewer-layer';

let nextVectorId = 1;

interface VectorLayer {
  id: number;
  data: VectorData;
  visible: boolean;
  color: string;
  width: number;
  opacity: number;
  /** Opacity of polygon fills, 0…1 (times the layer's opacity). */
  fill: number;
  /** In grid pixels. */
  areas: Path2D;
  lines: Path2D;
  points: Float64Array;
  bounds: PixelWindow | undefined;
  count: number;
  /** Features whose extent overlaps the image's. */
  inside: number;
  /** Each feature's geometry in grid pixels, to find the features under the pointer. */
  shapes: FeatureShape[];
}

interface FeatureShape {
  properties: Record<string, unknown> | null;
  bounds: PixelWindow;
  areas?: Path2D;
  lines?: Path2D;
  points?: number[];
}

/** What the value table shows for one layer under the pointer, top layer first. */
export type Identified =
  | { kind: 'image'; name: string }
  | { kind: 'raster'; layer: RasterLayer }
  | { kind: 'vector'; name: string; features: (Record<string, unknown> | null)[]; more: number };

/** An online basemap in the stack: what was chosen in the picker, and its localisation. */
interface BasemapLayer {
  id: number;
  name: string;
  provider: BasemapProvider;
  /** Raster or vector tiles: the provider's map. */
  item?: BasemapItem;
  /** A WMTS service's layer, and its dimension values (e.g. the date). */
  wmts?: { caps: WmtsCapabilities; layer: WmtsLayer; values: Record<string, string> };
  visible: boolean;
  opacity: number;
  localization: Localization;
  basemap?: Basemap;
  /** Drawn opaque on its own canvas, then blended once (the warped cells overlap a little). */
  canvas?: HTMLCanvasElement;
}

let nextBasemapId = 1;

/** A layer of the stack: the opened image, a raster layer, a vector layer or a basemap. */
type Entry = { kind: 'image' } | { kind: 'raster'; layer: RasterLayer; progress?: number } | { kind: 'vector'; layer: VectorLayer } | { kind: 'basemap'; layer: BasemapLayer };

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

function overlaps(a: PixelWindow, b: PixelWindow): boolean {
  return a[2] > b[0] && a[0] < b[2] && a[3] > b[1] && a[1] < b[3];
}

/** The last part of a path or URI, decoded. */
function baseName(path: string): string {
  const clean = path.replace(/[?#].*$/, '').replace(/[\\/]+$/, '');
  const name = clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export class Layers {
  private grid: CanvasGrid | undefined;
  private gridMapper: GeoMapper | undefined;
  private page: PageInfo | undefined;
  private imageName = '';
  private gridCrs: Crs | undefined;
  /** Bottom to top. */
  private entries: Entry[] = [{ kind: 'image' }];
  /** The raster the Rendering panel edits (undefined: the opened image). */
  private target: RasterLayer | undefined;
  imageVisible = true;
  imageOpacity = 1;
  private ticks = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (m: Extract<HostToWebview, { type: 'fetched' | 'overlayRead' | 'layersChosen' | 'rasterOpened' }>) => void }>();
  private readonly reads = new Map<number, { resolve: (data: Uint8Array[]) => void; reject: (error: Error) => void }>();
  private readonly capabilities = new Map<string, Promise<WmtsCapabilities>>();
  private wmts: { caps: WmtsCapabilities; provider: Extract<BasemapProvider, { kind: 'wmts' }> } | undefined;
  private dragged: Entry | undefined;

  constructor(private readonly host: LayersHost) {
    this.setupPanel();
  }

  // --- Host requests ---

  private request<T extends 'fetched' | 'overlayRead' | 'layersChosen' | 'rasterOpened'>(message: WebviewToHost & { id: number }): Promise<Extract<HostToWebview, { type: T }>> {
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

  /** Text from the web, fetched by the extension host (the OSM place search). */
  fetchUrl(url: string): Promise<string> {
    return this.fetchText(url);
  }

  /** Bytes of a raster layer's file, read by the extension host. */
  private readHost(file: number, ranges: ByteRange[]): Promise<Uint8Array[]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.reads.set(id, { resolve, reject });
      this.host.post({ type: 'read', id, file, ranges });
    });
  }

  /** Messages from the extension host; returns true when handled. */
  onHostMessage(message: HostToWebview): boolean {
    switch (message.type) {
      case 'fetched':
      case 'overlayRead':
      case 'layersChosen':
      case 'rasterOpened': {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.type === 'fetched' && message.bytes) message.bytes = toBytes(message.bytes);
        if (message.type === 'overlayRead' && message.files) message.files = message.files.map((f) => ({ name: f.name, data: toBytes(f.data) }));
        waiter?.resolve(message as never);
        return true;
      }
      case 'readResult':
      case 'readError': {
        if (message.file === undefined) return false;
        const read = this.reads.get(message.id);
        this.reads.delete(message.id);
        if (message.type === 'readResult') read?.resolve(message.data.map(toBytes));
        else read?.reject(new Error(message.message));
        return true;
      }
      case 'layersBrowsed':
        void this.addPaths(message.paths);
        return true;
    }
    return false;
  }

  // --- The opened image and the grid ---

  /**
   * The opened file's current page (undefined once its layer is removed). Layers need georeferencing: an image without it is shown alone.
   */
  setPage(page: PageInfo | undefined, name: string): void {
    this.page = page;
    this.imageName = name;
    const usable = !page || !!page.geo;
    const toggle = $<HTMLButtonElement>('layersToggle');
    toggle.disabled = !usable;
    toggle.title = usable ? 'Layers: rasters, vectors, basemap' : 'Layers need a georeferenced image (GeoTIFF)';
    if (!usable) {
      $('layers').hidden = true;
      toggle.setAttribute('aria-pressed', 'false');
      this.closeCrsMenu();
    }
    this.renderLayerList();
  }

  /** The grid everything is drawn in (in `crs`): re-projects the layers into it. */
  setGrid(grid: CanvasGrid | undefined, crs?: Crs): void {
    this.grid = grid;
    this.gridCrs = crs;
    this.gridMapper = grid?.geo ? new GeoMapper(grid.geo) : undefined;
    const geo = grid?.geo;
    for (const entry of this.entries) {
      if (entry.kind === 'basemap') this.createBasemap(entry.layer);
      if (entry.kind === 'vector') this.build(entry.layer);
      if (entry.kind === 'raster' && entry.layer.page) {
        const mapping = pixelMapping(entry.layer.page.geo, geo);
        entry.layer.setMapping(mapping, mapping && extentInCanvas(entry.layer.page, mapping));
      }
    }
    this.updateBounds();
    this.updateMapButtons();
    this.renderLayerList();
    this.host.redraw();
  }

  /** The status bar's map buttons (unbounded view, coordinates & scale): for georeferenced layers only. */
  private updateMapButtons(): void {
    const on = !!this.gridMapper;
    for (const id of ['unboundedToggle', 'ticksToggle']) {
      const button = $<HTMLButtonElement>(id);
      button.dataset.title ??= button.title;
      button.disabled = !on;
      button.title = on ? button.dataset.title : `${button.dataset.title} — needs georeferenced layers`;
    }
    $('unboundedToggle').setAttribute('aria-pressed', String(this.unbounded));
    $('ticksToggle').setAttribute('aria-pressed', String(this.ticks && on));
    if (this.unboundedForced) {
      const globe = $<HTMLButtonElement>('unboundedToggle');
      globe.disabled = true;
      globe.title = 'Unbounded view: always on in a viewer opened from the Command Palette';
    }
  }

  /** The canvas's extent: the union of the layers' extents. */
  /**
   * The canvas's extent: that of the file the viewer was opened on (or of the
   * first layer added to an empty canvas), in the current grid. It bounds the
   * view, clips the layers and decides what can be added, unless the map is unbounded.
   */
  private updateBounds(): void {
    const grid = this.grid;
    if (!grid) return;
    const home = this.home;
    const mapping = home?.geo && grid.geo ? pixelMapping(home.geo, grid.geo) : undefined;
    const extent = mapping && home ? extentInCanvas(home as PageInfo, mapping) : undefined;
    grid.bounds = extent ?? grid.imageBounds;
  }

  /** The region the canvas is bounded by: the opened file's (or the first layer's). */
  private home: GridReference | undefined;

  setHome(reference: GridReference | undefined): void {
    this.home = reference && { width: reference.width, height: reference.height, geo: reference.geo };
    this.updateBounds();
  }

  get homeReference(): GridReference | undefined {
    return this.home;
  }

  /** Unbounded: the view pans over the whole world, and layers anywhere can be added. */
  private unboundedMap = false;

  get unbounded(): boolean {
    return this.unboundedMap && !!this.gridMapper;
  }

  /** The area layers are drawn in: the canvas's extent, or everything when unbounded. */
  get drawArea(): PixelWindow | undefined {
    if (!this.grid) return undefined;
    return this.unbounded ? [-Infinity, -Infinity, Infinity, Infinity] : this.grid.bounds;
  }

  /** Whose extent bounds the map. */
  private homeName(): string {
    return this.homeLabel || 'the opened file';
  }

  homeLabel = '';

  /** Turns the unbounded view on or off (the status bar's globe, and the U key). */
  toggleUnbounded(): void {
    if (this.gridMapper) this.setUnbounded(!this.unboundedMap);
  }

  /** The region of the first data layer (a grid laid out again is laid out around it). */
  dataReference: GridReference | undefined;

  /** Rasters or vector layers (not only basemaps). */
  private hasData(): boolean {
    return this.entries.some((e) => e.kind !== 'basemap');
  }

  /** Always unbounded (a viewer opened from the Command Palette): the toggle is off duty. */
  private unboundedForced = false;

  forceUnbounded(): void {
    this.unboundedForced = true;
    this.unboundedMap = true;
    this.updateMapButtons();
  }

  private setUnbounded(on: boolean): void {
    if (this.unboundedForced) on = true;
    this.unboundedMap = on;
    $('unboundedToggle').setAttribute('aria-pressed', String(this.unbounded));
    // Bounded again: layers outside the extent are greyed out in the list.
    this.renderLayerList();
    this.host.layersChanged();
  }

  /** Whether a layer lies entirely outside the map's extent (it is greyed out while the map is bounded). */
  private outside(entry: Entry): boolean {
    if (this.unbounded || !this.grid || entry.kind === 'image' || entry.kind === 'basemap') return false;
    const box = entry.kind === 'raster' ? entry.layer.extent : entry.layer.bounds;
    return !!box && !overlaps([box[0] - 1e-9, box[1] - 1e-9, box[2] + 1e-9, box[3] + 1e-9], this.grid.bounds);
  }

  /** Layers can be used: georeferenced data on the canvas, or nothing yet. */
  get available(): boolean {
    return !!this.gridMapper || !this.entries.length;
  }

  /** How many layers there are. */
  get count(): number {
    return this.entries.length;
  }

  /** Every layer, top first (the Rendering panel's layer menu). */
  layerChoices(): LayerChoice[] {
    return [...this.entries].reverse().map((e): LayerChoice => {
      if (e.kind === 'image') return { kind: 'image', name: this.imageName };
      if (e.kind === 'raster') return { kind: 'raster', layer: e.layer };
      if (e.kind === 'vector') return { kind: 'vector', id: e.layer.id, name: e.layer.data.name };
      return { kind: 'basemap', id: e.layer.id, name: e.layer.name };
    });
  }

  private basemapEntry(id: number): BasemapLayer | undefined {
    for (const e of this.entries) if (e.kind === 'basemap' && e.layer.id === id) return e.layer;
    return undefined;
  }

  /** A basemap's name and what it can be localised by (the Rendering panel's basemap view). */
  basemapInfo(id: number): { name: string; attribution: string; localization: Localization; language: boolean; region: boolean } | undefined {
    const layer = this.basemapEntry(id);
    if (!layer) return undefined;
    const support = layer.item ? localizationSupport(layer.item.style ?? layer.item.url) : { language: false, region: false };
    return { name: layer.name, attribution: layer.provider.attribution, localization: { ...layer.localization }, ...support };
  }

  setBasemapLocalization(id: number, localization: Partial<Localization>): void {
    const layer = this.basemapEntry(id);
    if (!layer) return;
    Object.assign(layer.localization, localization);
    this.createBasemap(layer);
    this.host.redraw();
  }

  private vector(id: number): VectorLayer | undefined {
    for (const e of this.entries) if (e.kind === 'vector' && e.layer.id === id) return e.layer;
    return undefined;
  }

  /** A vector layer's style and a summary of it, or undefined once removed. */
  vectorStyle(id: number): (VectorStyle & { summary: string }) | undefined {
    const layer = this.vector(id);
    if (!layer) return undefined;
    const crs = layer.data.crs ? (layer.data.crs.epsg ? `EPSG:${layer.data.crs.epsg}` : 'its own coordinate system') : 'longitude / latitude (WGS 84)';
    return { color: layer.color, width: layer.width, fill: layer.fill, summary: `${layer.count.toLocaleString()} feature${layer.count === 1 ? '' : 's'}, in ${crs}.` };
  }

  setVectorStyle(id: number, style: Partial<VectorStyle>): void {
    const layer = this.vector(id);
    if (!layer) return;
    Object.assign(layer, style);
    this.host.redraw();
  }

  /** The rasters, top first. */
  rasterChoices(): RasterChoice[] {
    return [...this.entries].reverse().flatMap((e): RasterChoice[] => (e.kind === 'image' ? [{ kind: 'image', name: this.imageName }] : e.kind === 'raster' ? [{ kind: 'raster', layer: e.layer }] : []));
  }

  /** Shows or hides the coordinate ticks, grid and scale bar (the button, and the G key). */
  toggleTicks(): void {
    if (!this.available) return;
    this.ticks = !this.ticks;
    $<HTMLButtonElement>('ticksToggle').setAttribute('aria-pressed', String(this.ticks));
    this.host.redraw();
  }

  /** Whether the opened image must be drawn on its own layer (something under it, see-through, or warped). */
  get imageLayered(): boolean {
    if (!this.gridMapper) return false;
    if (this.imageOpacity < 1 || !this.grid?.identity) return true;
    const index = this.entries.findIndex((e) => e.kind === 'image');
    return this.entries.slice(0, index).some((e) => this.visibleEntry(e));
  }

  private visibleEntry(entry: Entry): boolean {
    if (entry.kind === 'image') return this.imageVisible && this.imageOpacity > 0;
    return entry.layer.visible && entry.layer.opacity > 0;
  }

  // --- Drawing ---

  /** Clips to the canvas's extent (the union of the layers'). */
  private clip = (ctx: CanvasRenderingContext2D, view: ViewState): void => {
    if (!this.grid || this.unbounded) return;
    const [b0, b1, b2, b3] = this.grid.bounds;
    const k = view.dpr;
    const x0 = Math.round((view.tx + b0 * view.scale) * k);
    const y0 = Math.round((view.ty + b1 * view.scale) * k);
    const x1 = Math.round((view.tx + b2 * view.scale) * k);
    const y1 = Math.round((view.ty + b3 * view.scale) * k);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
  };

  /** A basemap, clipped to the canvas's extent, blended once with its opacity. */
  private drawBasemap(ctx: CanvasRenderingContext2D, view: ViewState, layer: BasemapLayer): void {
    if (!layer.basemap || !layer.visible || layer.opacity <= 0) return;
    const { width, height } = ctx.canvas;
    layer.canvas ??= document.createElement('canvas');
    if (layer.canvas.width !== width || layer.canvas.height !== height) {
      layer.canvas.width = width;
      layer.canvas.height = height;
    }
    const target = layer.canvas.getContext('2d')!;
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, width, height);
    target.save();
    this.clip(target, view);
    layer.basemap.draw(target, view);
    target.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.restore();
  }

  /** The stack, bottom to top; `drawImage` draws the opened image. */
  drawStack(ctx: CanvasRenderingContext2D, view: ViewState, drawImage: () => void): void {
    for (const entry of this.entries) {
      if (entry.kind === 'image') {
        if (this.imageVisible && this.imageOpacity > 0) drawImage();
        continue;
      }
      if (!this.available || !this.grid) continue;
      if (entry.kind === 'raster') {
        entry.layer.update(view, this.drawArea!);
        entry.layer.draw(ctx, view, (c) => this.clip(c, view));
      } else if (entry.kind === 'basemap') {
        this.drawBasemap(ctx, view, entry.layer);
      } else if (entry.layer.visible && entry.layer.opacity > 0) {
        ctx.save();
        this.clip(ctx, view);
        this.drawVector(ctx, view, entry.layer);
        ctx.restore();
      }
    }
  }

  /** Ticks, scale bar and attribution: over everything. */
  drawTop(ctx: CanvasRenderingContext2D, view: ViewState): void {
    if (!this.available) return;
    if (this.ticks) this.drawTicks(ctx, view);
    // The attributions of the basemaps shown.
    const attributions = [...new Set(this.entries.flatMap((e) => (e.kind === 'basemap' && e.layer.visible && e.layer.opacity > 0 && e.layer.basemap?.attribution ? [e.layer.basemap.attribution] : [])))];
    if (attributions.length) this.drawAttribution(ctx, view, attributions.join(' · '));
  }

  private drawVector(ctx: CanvasRenderingContext2D, view: ViewState, layer: VectorLayer): void {
    const k = view.scale * view.dpr;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.setTransform(k, 0, 0, k, view.tx * view.dpr, view.ty * view.dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = (layer.width * view.dpr) / k;
    ctx.strokeStyle = layer.color;
    ctx.fillStyle = layer.color;
    ctx.globalAlpha = layer.opacity * layer.fill;
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
    if (this.grid?.geo?.geographic) {
      const hemisphere = axis === 'x' ? (value < 0 ? 'W' : 'E') : value < 0 ? 'S' : 'N';
      return `${Math.abs(value).toFixed(decimals)}°${value === 0 ? '' : hemisphere}`;
    }
    const fixed = value.toFixed(decimals);
    const [int, frac] = fixed.split('.');
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (frac ? `.${frac}` : '');
  }

  /**
   * Ticks of the grid's x coordinate along the lower border and of y along the
   * left border (of the image's extent in view), and a scale bar.
   */
  private drawTicks(ctx: CanvasRenderingContext2D, view: ViewState): void {
    const grid = this.grid;
    const mapper = this.gridMapper;
    if (!grid || !mapper) return;
    // Along the canvas's extent, or the view's edges when the map is unbounded.
    const [bx0, by0, bx1, by1] = this.unbounded ? [-view.tx / view.scale, -view.ty / view.scale, (view.width - view.tx) / view.scale, (view.height - view.ty) / view.scale] : grid.bounds;
    const ix0 = view.tx + bx0 * view.scale;
    const iy0 = view.ty + by0 * view.scale;
    const ix1 = view.tx + bx1 * view.scale;
    const iy1 = view.ty + by1 * view.scale;
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

    // A thin grid at the ticks, over the image's extent in view. Lines follow the
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
    const lines = new Path2D();
    const segment = (ca: number, ra: number, cb: number, rb: number) => {
      lines.moveTo(view.tx + ca * view.scale, view.ty + ra * view.scale);
      lines.lineTo(view.tx + cb * view.scale, view.ty + rb * view.scale);
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
    ctx.stroke(lines);
    ctx.lineWidth = 0.75;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.stroke(lines);
    ctx.restore();

    // x along the lower border: below it when there is room, else inside.
    const below = view.height - vy1 >= 20;
    if (xStep) {
      for (const v of values(xa, xb, xStep)) {
        const sx = vx0 + ((v - xa) / (xb - xa)) * (vx1 - vx0);
        const y = below ? vy1 : vy1 - tick;
        this.line(ctx, sx, y, sx, y + tick);
        this.text(ctx, this.formatCoordinate(v, xStep, 'x'), sx, below ? vy1 + tick + 1 : vy1 - tick - 2, 'center', below ? 'top' : 'bottom');
      }
    }
    // y along the left border: to its left when there is room, else inside.
    const left = vx0 >= 70;
    if (yStep) {
      for (const v of values(ya, yb, yStep)) {
        const sy = vy0 + ((v - ya) / (yb - ya)) * (vy1 - vy0);
        const x = left ? vx0 - tick : vx0;
        this.line(ctx, x, sy, x + tick, sy);
        this.text(ctx, this.formatCoordinate(v, yStep, 'y'), left ? vx0 - tick - 3 : vx0 + tick + 3, sy, left ? 'right' : 'left', 'middle');
      }
    }

    // Scale bar near the lower left corner of the extent in view, in true ground distance.
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

  /** Projects a layer's geometries into grid pixels (exactly, vertex by vertex). */
  private build(layer: VectorLayer): void {
    const mapper = this.gridMapper;
    layer.areas = new Path2D();
    layer.lines = new Path2D();
    layer.bounds = undefined;
    layer.inside = 0;
    if (!mapper) {
      layer.points = new Float64Array();
      return;
    }
    const crs = layer.data.crs;
    const gridEpsg = Number(/^EPSG:(\d+)/.exec(mapper.geo.crsName)?.[1]);
    let toPixel: (p: Position) => [number, number];
    if (!crs) {
      toPixel = (p) => mapper.lonLatToPixel(p[0], p[1]);
    } else if (crs.epsg && crs.epsg === gridEpsg) {
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
    let shape: FeatureShape | undefined;
    const path = (target: Path2D, coords: Position[], close: boolean) => {
      // Also into the current feature's own path, to find it under the pointer.
      const own = target === layer.lines ? (shape!.lines ??= new Path2D()) : (shape!.areas ??= new Path2D());
      let started = false;
      for (const c of coords) {
        const [x, y] = toPixel(c);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          started = false;
          continue;
        }
        extend(x, y);
        if (started) {
          target.lineTo(x, y);
          own.lineTo(x, y);
        } else {
          target.moveTo(x, y);
          own.moveTo(x, y);
        }
        started = true;
      }
      if (close && started) {
        target.closePath();
        own.closePath();
      }
    };
    const add = (g: Geometry | null | undefined) => {
      if (!g) return;
      switch (g.type) {
        case 'Point': {
          const [x, y] = toPixel(g.coordinates);
          if (Number.isFinite(x)) {
            points.push(x, y);
            (shape!.points ??= []).push(x, y);
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
    layer.shapes = [];
    for (const feature of layer.data.features.features) {
      fMinX = fMinY = Infinity;
      fMaxX = fMaxY = -Infinity;
      shape = { properties: (feature.properties as Record<string, unknown> | null) ?? null, bounds: [0, 0, 0, 0] };
      add(feature.geometry);
      if (!Number.isFinite(fMinX)) continue;
      shape.bounds = [fMinX, fMinY, fMaxX, fMaxY];
      layer.shapes.push(shape);
      if (this.overlapsImage(shape.bounds)) layer.inside++;
    }
    layer.points = Float64Array.from(points);
    layer.bounds = Number.isFinite(minX) ? [minX, minY, maxX, maxY] : undefined;
  }

  /** Whether a box (grid pixels) reaches the other layers' extent (anything does when there are none). */
  private overlapsImage(bounds: PixelWindow): boolean {
    const grid = this.grid;
    if (!grid) return false;
    if (!this.entries.length || this.unbounded) return true;
    // Points and vertical / horizontal lines have an empty box: widen it a hair.
    const box: PixelWindow = [bounds[0] - 1e-9, bounds[1] - 1e-9, bounds[2] + 1e-9, bounds[3] + 1e-9];
    return overlaps(box, grid.bounds);
  }

  /** Adds vector datasets, refusing those with nothing over the other layers. */
  private addVectorData(datasets: VectorData[]): string[] {
    const refused: string[] = [];
    for (const data of datasets) {
      if (!this.grid || !this.hasData()) {
        // The first layer of an empty canvas: the canvas starts in its coordinate system, around it
        // (or, on a canvas already set up, it is laid out around it: see LayersHost.firstLayer).
        const crs = !data.crs ? (parseCrs('4326') as Crs) : data.crs.epsg ? parseCrs(String(data.crs.epsg)) : { proj4: data.crs.proj4, geographic: /\+proj=longlat\b/.test(data.crs.proj4), name: 'Custom (from the file)' };
        const box = dataBounds(data);
        if (typeof crs === 'string' || !box) {
          refused.push(`${data.name} cannot be placed: ${typeof crs === 'string' ? crs : 'it has no coordinates'}.`);
          continue;
        }
        const reference = regionReference(crs, box);
        this.dataReference = reference;
        if (this.grid) {
          this.host.firstLayer(reference);
        } else {
          this.host.startGrid(reference, crs);
          // The first layer of an empty canvas bounds the map.
          this.homeLabel = data.name;
          this.setHome(reference);
        }
      }
      const layer: VectorLayer = {
        id: nextVectorId++,
        fill: 0.25,
        data,
        visible: true,
        color: LAYER_COLORS[this.entries.filter((e) => e.kind === 'vector').length % LAYER_COLORS.length],
        width: 2,
        opacity: 1,
        areas: new Path2D(),
        lines: new Path2D(),
        points: new Float64Array(),
        bounds: undefined,
        count: data.features.features.length,
        inside: 0,
        shapes: [],
      };
      this.build(layer);
      if (!layer.count) refused.push(`${data.name} has no features.`);
      else if (!layer.inside) refused.push(`${data.name} is outside the map's extent (that of ${this.homeName()}): none of its ${layer.count === 1 ? 'features' : `${layer.count.toLocaleString()} features`} is within it. Turn on Unbounded view (the globe in the status bar) to add layers anywhere.`);
      else this.insertEntry({ kind: 'vector', layer });
    }
    return refused;
  }

  /** Several layers in one file (KML folders, GeoPackage tables, files in a zip): asks which. */
  private async chooseDatasets(name: string, datasets: VectorData[]): Promise<VectorData[]> {
    if (datasets.length <= 1) return datasets;
    const prefix = `${name}: `;
    const chosen = await this.request<'layersChosen'>({
      type: 'chooseLayers',
      id: this.nextId++,
      file: name,
      layers: datasets.map((d) => ({ name: d.name.startsWith(prefix) ? d.name.slice(prefix.length) : d.name, count: d.features.features.length })),
    });
    return chosen.indexes.map((i) => datasets[i]).filter(Boolean);
  }

  private async addVectorPath(path: string): Promise<string[]> {
    const result = await this.request<'overlayRead'>({ type: 'readOverlay', id: this.nextId++, path });
    if (!result.ok || !result.files) throw new Error(result.error ?? 'Could not read the file');
    return this.addVectorData(await this.chooseDatasets(result.name, await readVectorFiles(result.name, result.files)));
  }

  // --- Raster layers ---

  private async addRasterPath(path: string): Promise<string[]> {
    const id = this.nextId++;
    const opened = await this.request<'rasterOpened'>({ type: 'openRaster', id, path });
    if (!opened.ok || opened.fileSize === undefined) throw new Error(opened.error ?? `Could not open ${opened.name}`);
    const source: ByteSource = {
      size: opened.fileSize,
      read: (ranges) => this.readHost(id, ranges),
      close: () => this.host.post({ type: 'closeRaster', id }),
    };
    return this.addRaster(opened.name, source);
  }

  private async addRaster(name: string, source: ByteSource): Promise<string[]> {
    const layer = new RasterLayer(name, source, {
      createWorker: (onMessage) => this.host.createWorker(onMessage),
      redraw: () => this.host.redraw(),
      onOther: (l, message) => this.host.rasterMessage(l, message),
      onProgress: (l, fraction) => this.onRasterProgress(l, fraction),
      onPixel: (l) => this.host.rasterPixel(l),
    });
    try {
      const page = await layer.open();
      if (!page.geo) throw new Error(`${name} is not georeferenced, so it cannot be placed with other layers.`);
      if (!this.grid) {
        // The first layer of an empty viewer: the canvas starts in its coordinate system, over it.
        const crs = crsOfGeo(page.geo);
        if (!crs) throw new Error(`${name}: its coordinate system cannot be used for the canvas.`);
        this.host.startGrid(page, crs);
        // The first layer of an empty canvas bounds the map.
        this.homeLabel = name;
        this.setHome(page);
      } else if (!this.hasData()) {
        this.dataReference = page;
        this.host.firstLayer(page);
      }
      const mapping = pixelMapping(page.geo, this.grid?.geo);
      const extent = mapping && extentInCanvas(page, mapping);
      if (!mapping || !extent) throw new Error(`${name} cannot be reprojected into the canvas's coordinate system.`);
      if (!this.overlapsImage(extent)) throw new Error(`${name} is outside the map's extent (that of ${this.homeName()}). Turn on Unbounded view (the globe in the status bar) to add layers anywhere.`);
      layer.setMapping(mapping, extent);
      this.insertEntry({ kind: 'raster', layer });
      this.updateBounds();
      this.host.rasterAdded(layer);
      return [];
    } catch (error) {
      layer.dispose();
      throw error;
    }
  }

  private onRasterProgress(layer: RasterLayer, fraction: number | undefined): void {
    const entry = this.entries.find((e) => e.kind === 'raster' && e.layer === layer) as Extract<Entry, { kind: 'raster' }> | undefined;
    if (!entry) return;
    entry.progress = fraction;
    const hint = document.querySelector<HTMLElement>(`.layer-row[data-raster="${layer.id}"] .layer-progress`);
    if (hint) hint.textContent = fraction === undefined ? '' : `${Math.floor(fraction * 100)}%`;
  }

  // --- What is under the pointer (the value table) ---

  private hitContext: CanvasRenderingContext2D | undefined;

  /** Asks the visible raster layers for their pixel at grid point (gx, gy); undefined clears them. */
  readPixels(point: [number, number] | undefined): void {
    for (const entry of this.entries) {
      if (entry.kind !== 'raster') continue;
      if (point && this.available && entry.layer.visible && entry.layer.opacity > 0) entry.layer.readPixel(point[0], point[1]);
      else entry.layer.clearPixel();
    }
  }

  /**
   * The visible layers at grid point (gx, gy), top first: rasters covering it
   * and vector features under it (within a few screen pixels of lines and points).
   */
  identify(gx: number, gy: number, scale: number): Identified[] {
    const out: Identified[] = [];
    for (const entry of [...this.entries].reverse()) {
      if (entry.kind === 'image') {
        if (this.imageVisible && this.imageOpacity > 0) out.push({ kind: 'image', name: this.imageName });
      } else if (!this.available) {
        continue;
      } else if (entry.kind === 'raster') {
        if (entry.layer.visible && entry.layer.opacity > 0 && entry.layer.readout) out.push({ kind: 'raster', layer: entry.layer });
      } else if (entry.kind === 'vector' && entry.layer.visible && entry.layer.opacity > 0) {
        const hits = this.featuresAt(entry.layer, gx, gy, scale);
        if (hits.length) out.push({ kind: 'vector', name: entry.layer.data.name, features: hits.slice(0, 5), more: Math.max(0, hits.length - 5) });
      }
    }
    return out;
  }

  private featuresAt(layer: VectorLayer, gx: number, gy: number, scale: number): (Record<string, unknown> | null)[] {
    this.hitContext ??= document.createElement('canvas').getContext('2d')!;
    const ctx = this.hitContext;
    // Lines and points count within a few screen pixels.
    const tolerance = (layer.width / 2 + 4) / scale;
    ctx.lineWidth = 2 * tolerance;
    const hits: (Record<string, unknown> | null)[] = [];
    for (const shape of layer.shapes) {
      const [x0, y0, x1, y1] = shape.bounds;
      if (gx < x0 - tolerance || gx > x1 + tolerance || gy < y0 - tolerance || gy > y1 + tolerance) continue;
      let hit = !!shape.areas && (ctx.isPointInPath(shape.areas, gx, gy, 'evenodd') || ctx.isPointInStroke(shape.areas, gx, gy));
      hit ||= !!shape.lines && ctx.isPointInStroke(shape.lines, gx, gy);
      if (!hit && shape.points) {
        const r = tolerance + 2.5 / scale;
        for (let i = 0; i < shape.points.length && !hit; i += 2) hit = Math.hypot(shape.points[i] - gx, shape.points[i + 1] - gy) <= r;
      }
      if (hit) hits.push(shape.properties);
    }
    return hits;
  }

  /** Raster layers, top first (to find the target, and for the host). */
  rasters(): RasterLayer[] {
    return this.entries.flatMap((e) => (e.kind === 'raster' ? [e.layer] : [])).reverse();
  }

  // --- Adding ---

  private busy(on: boolean, label = 'Reading…'): void {
    const add = $<HTMLButtonElement>('layerAdd');
    add.disabled = on;
    $('layerStatus').textContent = on ? label : '';
  }

  private showError(messages: string[]): void {
    const error = $<HTMLDivElement>('layerError');
    error.hidden = !messages.length;
    error.textContent = messages.join('\n');
  }

  private ensureAvailable(): boolean {
    if (this.available) return true;
    this.showError(['Layers need a georeferenced image (GeoTIFF): this one has no georeferencing.']);
    return false;
  }

  /** A new layer: on top. */
  private insertEntry(entry: Entry): void {
    this.entries.push(entry);
  }

  /** Adds files by path (absolute, relative to the workspace folder) or URI. */
  async addPaths(paths: string[]): Promise<void> {
    if (!paths.length || !this.ensureAvailable()) return;
    this.showError([]);
    this.openPanel();
    this.busy(true);
    const errors: string[] = [];
    for (const path of paths.map((p) => p.trim()).filter(Boolean)) {
      try {
        if (RASTER_EXTENSIONS.test(baseName(path))) errors.push(...(await this.addRasterPath(path)));
        else errors.push(...(await this.addVectorPath(path)));
      } catch (e) {
        errors.push((e as Error).message ?? String(e));
      }
    }
    this.busy(false);
    this.finishAdding(errors);
  }

  private finishAdding(errors: string[]): void {
    this.showError(errors);
    this.updateBounds();
    this.host.layersChanged();
    this.renderLayerList();
    this.host.redraw();
  }

  private openPanel(): void {
    const panel = $('layers');
    if (!panel.hidden) return;
    panel.hidden = false;
    $('layersToggle').setAttribute('aria-pressed', 'true');
  }

  // --- The list ---

  private entryName(entry: Entry): string {
    return entry.kind === 'image' ? this.imageName : entry.kind === 'raster' || entry.kind === 'basemap' ? entry.layer.name : entry.layer.data.name;
  }

  /** A raster's name was clicked: its rendering, in the Rendering panel. */
  private selectEntry(entry: Entry): void {
    if (entry.kind === 'vector') return this.host.openVectorRendering(entry.layer.id);
    if (entry.kind === 'basemap') return this.host.openBasemapRendering(entry.layer.id);
    this.host.openRendering(entry.kind === 'raster' ? entry.layer : undefined);
  }

  /** The raster whose rendering the panel edits (undefined: the opened image). */
  get selected(): RasterLayer | undefined {
    return this.target;
  }

  /** Highlights the raster the Rendering panel edits (chosen here, or a layer just added). */
  markSelected(layer: RasterLayer | undefined): void {
    if (layer === this.target) return;
    this.target = layer;
    this.renderLayerList();
  }

  /** The vector layer or basemap the Rendering panel shows, if one is: highlighted instead of the raster. */
  private shown: { kind: 'vector' | 'basemap'; id: number } | undefined;

  markShown(shown: { kind: 'vector' | 'basemap'; id: number } | undefined): void {
    if (shown?.kind === this.shown?.kind && shown?.id === this.shown?.id) return;
    this.shown = shown;
    this.renderLayerList();
  }

  private remove(entry: Entry): void {
    this.entries = this.entries.filter((e) => e !== entry);
    this.updateBounds();
    if (entry.kind === 'image') {
      this.page = undefined;
      this.host.imageRemoved();
    } else if (entry.kind === 'raster') {
      entry.layer.dispose();
      this.host.rasterRemoved(entry.layer);
    } else if (entry.kind === 'basemap') {
      entry.layer.basemap?.dispose();
    }
    this.renderLayerList();
    this.host.layersChanged();
    this.host.redraw();
    if (!this.entries.length) this.host.allRemoved();
  }

  /** Back to an empty canvas (no layers, no grid): the next layer starts a new one. */
  reset(): void {
    for (const entry of this.entries) {
      if (entry.kind === 'raster') entry.layer.dispose();
      if (entry.kind === 'basemap') entry.layer.basemap?.dispose();
    }
    this.entries = [];
    this.target = undefined;
    this.home = undefined;
    this.homeLabel = '';
    this.dataReference = undefined;
    this.grid = undefined;
    this.gridMapper = undefined;
    this.gridCrs = undefined;
    this.closePicker();
    this.renderLayerList();
  }

  /** Moves `entry` above or below `other` in the stack. */
  private move(entry: Entry, other: Entry, above: boolean): void {
    if (entry === other) return;
    const rest = this.entries.filter((e) => e !== entry);
    const index = rest.indexOf(other);
    rest.splice(above ? index + 1 : index, 0, entry);
    this.entries = rest;
    this.renderLayerList();
    this.host.redraw();
  }

  private opacitySlider(value: number, set: (v: number) => void): HTMLInputElement {
    const slider = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(value * 100)) });
    const title = () => `Opacity ${slider.value}% (double-click: 100%)`;
    slider.title = title();
    slider.setAttribute('aria-label', 'Opacity');
    slider.addEventListener('input', () => {
      set(Number(slider.value) / 100);
      slider.title = title();
      this.host.redraw();
    });
    // Double-click resets to fully opaque.
    slider.addEventListener('dblclick', () => {
      slider.value = '100';
      slider.dispatchEvent(new Event('input'));
    });
    return slider;
  }

  private renderLayerList(): void {
    const list = $<HTMLDivElement>('layerList');
    const rows = [...this.entries].reverse().map((entry) => {
      const row = document.createElement('div');
      row.className = `layer-row ${entry.kind}`;
      if (entry.kind === 'raster') row.dataset.raster = String(entry.layer.id);
      row.dataset.index = String(this.entries.indexOf(entry));
      const isTarget =
        this.shown !== undefined
          ? entry.kind === this.shown.kind && (entry.layer as { id: number }).id === this.shown.id
          : entry.kind === 'image' ? !this.target : entry.kind === 'raster' && entry.layer === this.target;
      row.classList.toggle('selected', isTarget);
      const outside = this.outside(entry) ? `Outside the map's extent (that of ${this.homeName()}): turn on Unbounded view to see it.` : '';
      if (outside) {
        row.classList.add('outside');
        row.title = outside;
      }

      // Drag the handle to move the layer up or down.
      const handle = Object.assign(document.createElement('span'), { className: 'layer-handle', textContent: '⠿', title: 'Click to select the layer; drag to move it up or down' });
      handle.addEventListener('pointerdown', () => (row.draggable = true));
      // A click (no drag: a drag fires no click) selects the layer.
      handle.addEventListener('click', () => {
        row.draggable = false;
        this.host.selectLayer(
          entry.kind === 'image' ? { kind: 'image', name: this.imageName } : entry.kind === 'raster' ? { kind: 'raster', layer: entry.layer } : { kind: entry.kind, id: entry.layer.id, name: this.entryName(entry) },
        );
      });
      row.addEventListener('dragstart', (e) => {
        this.dragged = entry;
        e.dataTransfer?.setData(LAYER_DRAG, this.entryName(entry));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => {
        row.draggable = false;
        this.dragged = undefined;
        row.classList.remove('dragging');
        list.querySelectorAll('.drop-above, .drop-below').forEach((el) => el.classList.remove('drop-above', 'drop-below'));
      });
      row.addEventListener('dragover', (e) => {
        if (!this.dragged || this.dragged === entry) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        row.classList.toggle('drop-above', above);
        row.classList.toggle('drop-below', !above);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
      row.addEventListener('drop', (e) => {
        if (!this.dragged) return;
        e.preventDefault();
        e.stopPropagation();
        const r = row.getBoundingClientRect();
        // The list shows the top of the stack first: "above" in the list is higher in the stack.
        this.move(this.dragged, entry, e.clientY < r.top + r.height / 2);
      });

      const visible = Object.assign(document.createElement('input'), {
        type: 'checkbox',
        checked: entry.kind === 'image' ? this.imageVisible : entry.layer.visible,
        title: 'Show',
      });
      visible.addEventListener('change', () => {
        if (entry.kind === 'image') this.imageVisible = visible.checked;
        else entry.layer.visible = visible.checked;
        this.host.redraw();
      });
      const name = Object.assign(document.createElement('span'), { className: 'layer-name', textContent: this.entryName(entry) });
      const kind = Object.assign(document.createElement('span'), { className: 'layer-kind' });
      if (entry.kind === 'vector') {
        const count = entry.layer.count;
        kind.textContent = 'V';
        kind.title = `Vector layer: ${count.toLocaleString()} feature${count === 1 ? '' : 's'}`;
        name.title = `${entry.layer.data.name}: vector layer, ${count.toLocaleString()} feature${count === 1 ? '' : 's'}${entry.layer.data.crs?.epsg ? `, EPSG:${entry.layer.data.crs.epsg}` : ''}. Click to edit its rendering.`;
        const id = entry.layer.id;
        name.addEventListener('click', () => this.host.openVectorRendering(id));
        name.classList.add('selectable');
      } else if (entry.kind === 'basemap') {
        kind.textContent = 'B';
        kind.title = 'Basemap';
        name.title = `${entry.layer.name}: basemap. Click to edit its rendering (language, region).`;
        name.addEventListener('click', () => this.selectEntry(entry));
        name.classList.add('selectable');
      } else {
        const page = entry.kind === 'image' ? this.page : entry.layer.page;
        kind.textContent = 'R';
        kind.title = 'Raster layer';
        name.title = `${this.entryName(entry)}: raster layer${page ? `, ${page.width} × ${page.height}, ${page.samplesPerPixel} band${page.samplesPerPixel === 1 ? '' : 's'}` : ''}${page?.geo ? `, ${page.geo.crsName}` : ''}. Click to edit its rendering.`;
        name.addEventListener('click', () => this.selectEntry(entry));
        name.classList.add('selectable');
      }
      if (outside) name.title = `${outside}\n\n${name.title}`;
      const progress = Object.assign(document.createElement('span'), { className: 'layer-progress hint' });
      if (entry.kind === 'raster' && entry.progress !== undefined) progress.textContent = `${Math.floor(entry.progress * 100)}%`;
      const zoom = Object.assign(document.createElement('button'), { textContent: '⌖', title: 'Zoom to layer' });
      // A basemap covers the world: zooming to it shows all the layers.
      const bounds = entry.kind === 'image' ? this.grid?.imageBounds : entry.kind === 'raster' ? entry.layer.extent : entry.kind === 'vector' ? entry.layer.bounds : this.grid?.bounds;
      zoom.disabled = !bounds;
      zoom.addEventListener('click', () => bounds && this.host.showWindow(bounds));
      const remove = Object.assign(document.createElement('button'), { textContent: '×', title: 'Remove' });
      remove.addEventListener('click', () => this.remove(entry));
      const top = document.createElement('div');
      top.className = 'layer-top';
      top.append(handle, visible, kind, name, progress, zoom, remove);

      const style = document.createElement('div');
      style.className = 'layer-style';
      // Colour, width and fill are in the Rendering panel; the opacity is here, for every layer.
      style.classList.add('raster');
      if (entry.kind === 'vector') {
        const layer = entry.layer;
        style.append(this.opacitySlider(layer.opacity, (v) => (layer.opacity = v)));
      } else {
        style.append(this.opacitySlider(entry.kind === 'image' ? this.imageOpacity : entry.layer.opacity, (v) => (entry.kind === 'image' ? (this.imageOpacity = v) : (entry.layer.opacity = v))));
      }
      row.append(top, style);
      return row;
    });
    list.replaceChildren(...rows);
  }

  // --- Basemap ---

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
      this.updateTimeRow();
      return;
    }
    $('basemapItemRow').hidden = false;
    if (provider.kind !== 'wmts') {
      item.replaceChildren(...provider.items.map((it, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: it.name })));
      this.updateTimeRow();
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
      this.updateTimeRow();
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

  /** The picker's WMTS date field, for the chosen layer's time dimension. */
  private updateTimeRow(): void {
    const layer = this.provider()?.kind === 'wmts' ? this.currentWmtsLayer() : undefined;
    const time = layer?.dimensions.find((d) => /time/i.test(d.id));
    $('basemapTimeRow').hidden = !time;
    if (time) $<HTMLInputElement>('basemapTime').placeholder = time.default;
  }

  /** (Re)creates a basemap layer's map, in the grid's coordinate system, with its localisation. */
  private createBasemap(layer: BasemapLayer): void {
    layer.basemap?.dispose();
    layer.basemap = undefined;
    const mapper = this.gridMapper;
    if (!mapper) return;
    const redraw = () => this.host.redraw();
    const { provider } = layer;
    if (provider.kind === 'wmts') {
      if (layer.wmts) layer.basemap = new TileBasemap(wmtsSource(layer.wmts.caps, layer.wmts.layer, provider.attribution, layer.wmts.values), mapper, this.fetchBytes, redraw);
    } else if (layer.item) {
      if (provider.kind === 'xyz') {
        layer.basemap = new TileBasemap(xyzSource(localizeUrl(layer.item.url, layer.localization), provider.attribution, provider.maxZoom), mapper, this.fetchBytes, redraw);
      } else {
        const tiles = /arcgis\.com/i.test(layer.item.url) ? layer.item.url : undefined;
        layer.basemap = new VectorBasemap(layer.item.style!, tiles, provider.attribution, mapper, this.fetchBytes, this.fetchText, redraw, (m) => this.showError([`${layer.name}: ${m}`]), layer.localization.language);
      }
    }
  }

  private openPicker(): void {
    if (!this.gridMapper) {
      this.showError(['Add a raster or vector layer first: a basemap is drawn under the layers, in their coordinate system.']);
      return;
    }
    this.showError([]);
    $('basemapPicker').hidden = false;
    $('basemapAdd').setAttribute('aria-expanded', 'true');
    if ($<HTMLSelectElement>('basemapProvider').value === '') {
      $<HTMLSelectElement>('basemapProvider').selectedIndex = 0;
    }
    void this.onProviderChange();
  }

  private closePicker(): void {
    $('basemapPicker').hidden = true;
    $('basemapAdd').setAttribute('aria-expanded', 'false');
  }

  /** Adds the basemap chosen in the picker, at the bottom of the stack (the background). */
  private addBasemap(): void {
    const provider = this.provider();
    if (!provider || !this.gridMapper) return;
    const layer: BasemapLayer = { id: nextBasemapId++, name: provider.name, provider, visible: true, opacity: 1, localization: { language: '', region: '' } };
    if (provider.kind === 'wmts') {
      const wmtsLayer = this.currentWmtsLayer();
      if (!wmtsLayer || !this.wmts) {
        this.status('Wait for the list of layers, then choose one.');
        return;
      }
      const time = wmtsLayer.dimensions.find((d) => /time/i.test(d.id));
      const date = $<HTMLInputElement>('basemapTime').value.trim();
      layer.wmts = { caps: this.wmts.caps, layer: wmtsLayer, values: time && date ? { [time.id]: date } : {} };
      layer.name = `${provider.name}: ${wmtsLayer.title}${time && date ? ` (${date})` : ''}`;
    } else {
      layer.item = provider.items[Number($<HTMLSelectElement>('basemapItem').value)] ?? provider.items[0];
      layer.name = provider.items.length > 1 ? `${provider.name}: ${layer.item.name}` : layer.item.name;
    }
    this.createBasemap(layer);
    this.entries.unshift({ kind: 'basemap', layer });
    this.closePicker();
    this.renderLayerList();
    this.host.layersChanged();
    this.host.redraw();
  }

  // --- Coordinate system (chosen from the status bar) ---

  /**
   * What the status bar offers: WGS 84, Web Mercator, and the coordinate systems
   * of the layers, each once (with the layers using it).
   */
  private crsChoices(): { crs: Crs; key: string; label: string; detail: string; layers: string[] }[] {
    const choices: { crs: Crs; key: string; label: string; detail: string; layers: string[] }[] = [];
    const add = (crs: Crs, detail: string, layer?: string) => {
      const key = crsKey(crs);
      const existing = choices.find((c) => c.key === key);
      if (existing) {
        if (layer && !existing.layers.includes(layer)) existing.layers.push(layer);
        if (!existing.detail) existing.detail = detail;
        return;
      }
      choices.push({ crs, key, label: crs.name, detail, layers: layer ? [layer] : [] });
    };
    const describe = (crsName: string) => crsName.replace(/^EPSG:\d+\s*/, '').replace(/^\((.*)\)$/, '$1');
    const wgs84 = parseCrs('4326') as Crs;
    add(wgs84, 'WGS 84 (longitude / latitude)');
    add(parseCrs('3857') as Crs, 'Web Mercator');
    for (const entry of [...this.entries].reverse()) {
      if (entry.kind === 'image' || entry.kind === 'raster') {
        const geo = entry.kind === 'image' ? this.page?.geo : entry.layer.page?.geo;
        const crs = geo && crsOfGeo(geo);
        if (crs && geo) add(crs, describe(geo.crsName), this.entryName(entry));
      } else if (entry.kind === 'vector') {
        const c = entry.layer.data.crs;
        const crs = !c ? wgs84 : c.epsg ? parseCrs(String(c.epsg)) : { proj4: c.proj4, geographic: /\+proj=longlat\b/.test(c.proj4), name: 'Custom (from the file)' };
        if (typeof crs !== 'string') add(crs, '', entry.layer.data.name);
      }
    }
    // The canvas's current one, if no layer has it any more.
    if (this.gridCrs) add(this.gridCrs, describe(this.grid?.geo?.crsName ?? ''));
    return choices;
  }

  private currentCrsKey(): string {
    return this.gridCrs ? crsKey(this.gridCrs) : '';
  }

  private chooseCrs(crs: Crs): void {
    this.closeCrsMenu();
    if (this.gridCrs && crsKey(crs) === crsKey(this.gridCrs)) return;
    this.host.setCrs(crs);
  }

  private renderCrsMenu(): void {
    const current = this.currentCrsKey();
    $('crsChoices').replaceChildren(
      ...this.crsChoices().map((choice) => {
        const button = document.createElement('button');
        button.className = 'crs-choice';
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', String(choice.key === current));
        const check = Object.assign(document.createElement('span'), { className: 'crs-check', textContent: choice.key === current ? '✓' : '' });
        const label = Object.assign(document.createElement('span'), { className: 'crs-label', textContent: choice.label });
        const detail = Object.assign(document.createElement('span'), { className: 'crs-detail', textContent: [choice.detail, choice.layers.length ? `used by ${choice.layers.join(', ')}` : ''].filter(Boolean).join(' · ') });
        button.append(check, label, detail);
        button.title = [choice.label, choice.detail, choice.layers.length ? `Used by: ${choice.layers.join(', ')}` : ''].filter(Boolean).join('\n');
        button.addEventListener('click', () => this.chooseCrs(choice.crs));
        return button;
      }),
    );
  }

  private openCrsMenu(): void {
    if (!this.available) return;
    const menu = $('crsMenu');
    const button = $('statusCrs');
    this.renderCrsMenu();
    $('crsError').hidden = true;
    $<HTMLInputElement>('crsInput').value = '';
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // Above the status bar, right-aligned with the button.
    const r = button.getBoundingClientRect();
    menu.style.right = `${Math.max(4, window.innerWidth - r.right)}px`;
    menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
    menu.querySelector<HTMLButtonElement>('.crs-choice[aria-checked="true"]')?.focus();
  }

  private closeCrsMenu(): void {
    $('crsMenu').hidden = true;
    $('statusCrs').setAttribute('aria-expanded', 'false');
  }

  private applyTypedCrs(): void {
    const error = $('crsError');
    const crs = parseCrs($<HTMLInputElement>('crsInput').value);
    if (typeof crs === 'string') {
      error.hidden = false;
      error.textContent = crs;
      return;
    }
    error.hidden = true;
    this.chooseCrs(crs);
  }

  // --- Panel ---

  private setupPanel(): void {
    const toggle = $<HTMLButtonElement>('layersToggle');
    toggle.addEventListener('click', () => {
      const panel = $('layers');
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-pressed', String(!panel.hidden));
    });
    $<HTMLButtonElement>('ticksToggle').addEventListener('click', () => this.toggleTicks());
    $<HTMLButtonElement>('unboundedToggle').addEventListener('click', () => this.setUnbounded(!this.unboundedMap));
    const providers = $<HTMLSelectElement>('basemapProvider');
    const option = (value: string, text: string) => Object.assign(document.createElement('option'), { value, textContent: text });
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
    $('basemapItem').addEventListener('change', () => this.updateTimeRow());
    $('basemapFilter').addEventListener('input', () => {
      this.fillWmtsLayers();
      this.updateTimeRow();
    });
    $('basemapAdd').addEventListener('click', () => ($('basemapPicker').hidden ? this.openPicker() : this.closePicker()));
    $('basemapPickerAdd').addEventListener('click', () => this.addBasemap());
    $('basemapPickerCancel').addEventListener('click', () => this.closePicker());

    $('layerAdd').addEventListener('click', () => {
      if (this.ensureAvailable()) this.host.post({ type: 'browseLayers' });
    });

    // The coordinate system, from the status bar.
    const status = $<HTMLButtonElement>('statusCrs');
    status.addEventListener('click', () => ($('crsMenu').hidden ? this.openCrsMenu() : this.closeCrsMenu()));
    $('crsApply').addEventListener('click', () => this.applyTypedCrs());
    $('crsInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.applyTypedCrs();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('crsMenu').hidden) {
        this.closeCrsMenu();
        status.focus();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node;
      if (!$('crsMenu').hidden && !$('crsMenu').contains(t) && !status.contains(t)) this.closeCrsMenu();
    });
  }
}
