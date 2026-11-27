import { COLORMAP_NAMES } from '../shared/colormaps';
import {
  colorMapToString,
  DEFAULT_CLASS_COLOR,
  MAX_CLASSES,
  parseColorMap,
  parseHexColor,
  RANDOM_RAMP,
  rampColors,
  toHexColor,
  valueLabel,
  type RGBA,
} from '../shared/palette';
import { bandIdentifier as bandIdentifierOf, compileExpressions, ExpressionError } from '../shared/expression';
import {
  bandVariables,
  compositeSpec,
  presetExpressions,
  presetMatches,
  presetAdjustment,
  presetClasses,
  presetMode,
  presetRanges,
  type RenderMode,
  ADJUSTMENTS,
  type Adjustment,
  type AutoStretch,
  type CompositeSpec,
  type Preset,
  type RangeSetting,
} from '../shared/presets';
import { drawWarped, LANGUAGES, REGIONS } from './basemap';
import { toBytes } from './bytes';
import { GeoMapper } from './geo';
import { crsKey, crsOfGeo, imageGrid, outlinePath, parseCrs, regionReference, warpedGrid, windowReference, type CanvasGrid, type Crs, type GridReference } from './grid';
import { Layers, type LayerChoice } from './layers';
import { MeasureTool } from './measureTool';
import { PlaceSearch, type Place } from './placeSearch';
import type { RasterLayer } from './rasterLayer';
import type {
  FileInfo,
  HostToWebview,
  MainToWorker,
  PageInfo,
  PixelWindow,
  Selection,
  TileSpec,
  ToneMode,
  WebviewToHost,
  WorkerToMain,
} from '../shared/protocol';

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void };
declare global {
  interface Window {
    TIFF_WORKER_URL: string;
    TIFF_MAPLIBRE_URL: string;
    TIFF_SQLJS_WASM_URL: string;
    TIFF_NONCE: string;
  }
}

/**
 * The image is shown as a pyramid of display tiles: at level z one tile pixel
 * spans 2^z image pixels, and a tile is TILE_SIZE pixels square. Only tiles in
 * view are rendered, at the level that matches the zoom; coarser tiles already
 * loaded fill in while finer ones arrive.
 */
const TILE_SIZE = 512;
/** The coarsest level shows the whole page at most this large. It is loaded first. */
const TOP_SIZE = 32;
/**
 * Coarser levels are loaded before the level the view needs only when they
 * need at most this fraction of its data, so that they add little work.
 */
const COARSE_LEVEL_SHARE = 1 / 8;
/** Rendered tiles kept, in pixels (4 bytes each). */
const TILE_CACHE_PIXELS = 64 * 1024 * 1024;
const MAX_ZOOM = 64;
const ZOOM_STEP = 1.25;

const vscode = acquireVsCodeApi();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const pageGroup = $<HTMLLabelElement>('pageGroup');
const pageSelect = $<HTMLSelectElement>('page');
const zoomLabel = $<HTMLSpanElement>('zoomLabel');
const infoToggle = $<HTMLButtonElement>('infoToggle');
const infoPanel = $<HTMLElement>('info');
const infoContent = $<HTMLDivElement>('infoContent');
const progress = $<HTMLDivElement>('progress');
const progressBar = $<HTMLDivElement>('progressBar');
const messageBox = $<HTMLDivElement>('message');
const statusSize = $<HTMLSpanElement>('statusSize');
const statusProgress = $<HTMLSpanElement>('statusProgress');
const statusFileSize = $<HTMLSpanElement>('statusFileSize');
const statusPos = $<HTMLSpanElement>('statusPos');
const statusCrs = $<HTMLSpanElement>('statusCrs');
/** Pixel to longitude/latitude for a georeferenced page. */
let geoMapper: GeoMapper | undefined;
const valuesToggle = $<HTMLButtonElement>('valuesToggle');

interface DisplayTile {
  z: number;
  window: PixelWindow;
  bitmap: ImageBitmap;
  final: boolean;
  /** Tiles of an older generation (before a tone change) are shown until replaced. */
  generation: number;
  used: number;
  /** Where the tile goes in a warped grid (mesh points in grid pixels), and for which grid. */
  mesh?: Float64Array;
  meshGrid?: CanvasGrid;
}

let worker: Worker | undefined;
/** The grid everything is drawn in: the image's pixels, or another coordinate system (Layers panel). */
let grid: CanvasGrid | undefined;
/** The grid's georeferencing as a mapper (pointer → longitude / latitude). */
let gridMapper: GeoMapper | undefined;
/** The status bar's Measure tool and OSM place search (set up once the layers are). */
let measureTool: MeasureTool | undefined;
let placeSearch: PlaceSearch | undefined;
let chosenCrs: Crs | undefined;
/** The opened file's layer was removed (the viewer stays the file's). */
let imageGone = false;
/** The opened file is a vector file (it was added as a vector layer). */
let vectorFile = false;
/** Opened from the Command Palette: no file, EPSG:4326, unbounded view, over Europe to start. */
let blank = false;
/** Where a viewer opened from the Command Palette starts: Europe (lon / lat). */
const EUROPE: [number, number, number, number] = [-25, 34, 40, 72];
const EMPTY_MESSAGE = 'No layers. Add them with + Add layer… in the Layers panel.';
let fileName = '';
let info: FileInfo | undefined;
/** Rough compressed size of one pixel, to estimate how much a view needs to read. */
let bytesPerPixel = 1;
let pageIndex = 0;
/** The plain image is stretched min to max; stretches are chosen per channel in the Rendering panel. */
const tone: ToneMode = 'minmax';

/** Screen (CSS) pixels per image pixel, and the screen position of the image origin. */
const view = { scale: 1, tx: 0, ty: 0 };
/** 'auto': fit but never enlarge; 'fit': fit to window; undefined: user zoom. */
let fitMode: 'auto' | 'fit' | undefined = 'auto';

/** Changes with the page or tone; rendering results of other generations are stale. */
let generation = 0;
const tiles = new Map<string, DisplayTile>();
let tilePixels = 0;
let drawCounter = 0;
/** Tiles asked from the worker for the current view, with their progress in source tiles. */
let requested = new Map<string, { done: number; total: number }>();
let lastRequest = '';
const failed = new Set<string>();
/** Level the current view is rendered at. */
let viewLevel = 0;
let tilesTimer: ReturnType<typeof setTimeout> | undefined;
let requestCounter = 0;
/** The latest pixel readout requested (0: the pointer is not over the image), and its pixel. */
let pixelReq = 0;
let requestedPixel = '';
let requestedComposite: unknown;
/** The readout last shown: a pixel and its values, as the worker answered. */
let shownReq = 0;
let shown: { x: number; y: number; values: number[] | null; computed?: number[] } | undefined;
/** Whether the value table is on (Space toggles it), and where the pointer is (client coordinates). */
let tipOn = false;
let pointer: { x: number; y: number } | undefined;
/** The pointer in grid pixels, while it is over the image. */
let pointerGrid: [number, number] | undefined;
/** Dimensions of the page last shown, to keep the view across file reloads. */
let shownSize = '';

function currentPage(): PageInfo | undefined {
  return info?.pages[pageIndex];
}

function imageInfo(): FileInfo | undefined {
  return info;
}

function currentPageIndex(): number {
  return pageIndex;
}

function postToWorker(message: MainToWorker, transfer: Transferable[] = []): void {
  worker?.postMessage(message, transfer);
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

/** Helper workers that decode tiles in parallel for the decoder worker. */
let helpers: Worker[] = [];
const HELPER_COUNT = Math.max(0, Math.min(6, (navigator.hardwareConcurrency || 2) - 1));

let workerCode: Promise<string> | undefined;

/** A decoder worker (with `helperCount` decode helpers) whose messages go to `onMessage`. */
async function createWorker(onMessage: (message: WorkerToMain) => void, helperCount = HELPER_COUNT): Promise<Worker> {
  // Webview resources are cross-origin for Worker(), so start it from a blob URL.
  workerCode ??= fetch(window.TIFF_WORKER_URL).then((response) => response.text());
  workerCode.catch(() => (workerCode = undefined));
  const code = await workerCode;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const w = new Worker(url);
  w.onmessage = (event: MessageEvent<WorkerToMain>) => onMessage(event.data);
  w.onerror = (event) => showMessage(`Decoder error: ${event.message}`);
  // Same script, started as decode helpers, each connected to the decoder worker by a channel.
  const ports: MessagePort[] = [];
  try {
    for (let i = 0; i < helperCount; i++) {
      const helper = new Worker(url);
      const channel = new MessageChannel();
      helper.postMessage({ type: 'helper', port: channel.port1 } satisfies MainToWorker, [channel.port1]);
      helpers.push(helper);
      ports.push(channel.port2);
    }
  } catch {
    // Decoding then happens in the decoder worker alone.
  }
  URL.revokeObjectURL(url);
  if (ports.length) {
    w.postMessage({ type: 'decoders', ports } satisfies MainToWorker, ports);
  }
  return w;
}

function stopWorkers(): void {
  worker?.terminate();
  worker = undefined;
  helpers.forEach((helper) => helper.terminate());
  helpers = [];
}

async function start(fileSize: number): Promise<void> {
  stopWorkers();
  statusFileSize.textContent = formatBytes(fileSize);
  info = undefined;
  clearTiles();
  showMessage(undefined);
  showProgress(undefined);
  if (fileSize === 0) {
    showMessage('The file is empty.');
    return;
  }
  try {
    worker = await createWorker((message) => void onWorkerMessage(message));
  } catch (error) {
    showMessage(`Could not start the decoder: ${String(error)}`);
    return;
  }
  postToWorker({ type: 'open', fileSize });
}

/**
 * Removes a tile and releases its bitmap. Its size is taken before closing:
 * a closed ImageBitmap reports 0 × 0, which used to leave the cache size
 * growing until every new tile was evicted on arrival (a blurry view for good).
 */
function removeTile(id: string): void {
  const tile = tiles.get(id);
  if (!tile) return;
  tilePixels -= tile.bitmap.width * tile.bitmap.height;
  tile.bitmap.close();
  tiles.delete(id);
}

function clearTiles(): void {
  for (const tile of tiles.values()) {
    tile.bitmap.close();
  }
  tiles.clear();
  tilePixels = 0;
  generation++;
  requested = new Map();
  lastRequest = '';
  failed.clear();
  draw();
}

async function onWorkerMessage(message: WorkerToMain): Promise<void> {
  switch (message.type) {
    case 'read':
      vscode.postMessage({ type: 'read', id: message.id, ranges: message.ranges });
      break;
    case 'opened': {
      info = message.info;
      const pixels = info.pages.reduce((sum, p) => sum + p.levels.reduce((s, l) => s + l.width * l.height, 0), 0);
      bytesPerPixel = pixels ? info.fileSize / pixels : 1;
      setupPages();
      selectPage(Math.min(pageIndex, info.pages.length - 1), true);
      break;
    }
    case 'openError':
      showProgress(undefined);
      showMessage(`Cannot open ${fileName}: ${message.message}`);
      break;
    case 'progress': {
      const entry = message.generation === generation ? requested.get(message.id) : undefined;
      if (entry) {
        entry.done = message.done;
        entry.total = message.total;
        updateProgress();
      }
      break;
    }
    case 'tile':
      await onTile(message);
      break;
    case 'tileError':
      if (message.generation === generation) {
        failed.add(message.id);
        requested.delete(message.id);
        updateProgress();
        if (![...tiles.values()].some((t) => t.generation === generation)) {
          showMessage(message.message);
        }
      }
      break;
    case 'classifyProgress':
    case 'classified':
    case 'classifyError':
      if (!target) onClassifyMessage(message);
      break;
    case 'pixel':
      // Answers come one at a time, the newest request next: show each (not only the
      // latest request's), so the readout follows a moving pointer. Its pixel is shown
      // with its values, never the pointer's newer position with older values.
      if (pixelReq !== 0 && message.reqId > shownReq && message.reqId <= pixelReq) {
        shownReq = message.reqId;
        shown = { x: message.x, y: message.y, values: message.values, computed: message.computed };
        renderReadout();
      }
      break;
  }
}

async function onTile(message: Extract<WorkerToMain, { type: 'tile' }>): Promise<void> {
  if (message.generation !== generation) {
    return;
  }
  const image = new ImageData(new Uint8ClampedArray(message.rgba), message.width, message.height);
  const bitmap = await createImageBitmap(image);
  const page = currentPage();
  if (message.generation !== generation || !page) {
    bitmap.close();
    return;
  }
  const [z, i, j] = message.id.split('/').map(Number);
  removeTile(message.id);
  tiles.set(message.id, {
    z,
    window: tileWindow(page, z, i, j),
    bitmap,
    final: message.final,
    generation,
    used: ++drawCounter,
  });
  tilePixels += bitmap.width * bitmap.height;
  if (message.final) {
    const entry = requested.get(message.id);
    if (entry) entry.done = entry.total;
    updateProgress();
    showMessage(undefined);
  }
  evictTiles();
  draw();
}

/** Drops the least recently drawn tiles beyond the cache size (never the overview). */
function evictTiles(): void {
  if (tilePixels <= TILE_CACHE_PIXELS) {
    return;
  }
  const page = currentPage();
  const top = page ? topLevel(page) : Infinity;
  const byAge = [...tiles.entries()].filter(([, t]) => t.z !== top).sort((a, b) => a[1].used - b[1].used);
  for (const [id] of byAge) {
    if (tilePixels <= TILE_CACHE_PIXELS) break;
    removeTile(id);
  }
}

// ---------------------------------------------------------------------------
// Pages and tiles
// ---------------------------------------------------------------------------

function setupPages(): void {
  const pages = info!.pages;
  pageSelect.replaceChildren(
    ...pages.map((page, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `${i + 1} / ${pages.length}  (${page.width} × ${page.height})`;
      return option;
    }),
  );
  pageGroup.hidden = pages.length < 2;
}

function selectPage(index: number, keepView = false): void {
  const page = info?.pages[index];
  if (!page) {
    showMessage('This file contains no images.');
    return;
  }
  const size = `${page.width}x${page.height}`;
  const sameSize = keepView && size === shownSize;
  shownSize = size;
  pageIndex = index;
  pageSelect.value = String(index);
  clearTiles();
  showMessage(undefined);

  if (target) {
    // The Rendering panel shows a layer: resolve the image's own selection without it.
    const saved = imageRenderState!;
    if (!selectionResolved) {
      selectionResolved = true;
      saved.selection = initialSelection(page, fileName);
    }
    setImageComposite(compositeFor(saved.selection, page));
  } else if (!selectionResolved) {
    selectionResolved = true;
    applySelection(initialSelection(page, fileName), false);
  } else {
    // The band count may differ between pages; resolve the composite again.
    applySelection(selection, false);
  }
  try {
    geoMapper = page.geo ? new GeoMapper(page.geo) : undefined;
  } catch {
    geoMapper = undefined;
  }
  layers.setPage(page, fileName);
  rebuildGrid();
  // The opened file's extent bounds the map.
  layers.homeLabel = fileName;
  layers.setHome(page);
  // After the Layers panel knows the file's layer: the Rendering panel's menu lists it.
  updateRenderingTarget();

  if (!sameSize) {
    fitMode = 'auto';
  }
  if (page.unsupported) {
    showProgress(undefined);
    showMessage(page.unsupported);
  } else {
    showProgress(0, 'Loading');
  }
  layout(0);
}

/** The grid for the current page and chosen coordinate system (the image's own when it cannot be warped). */
function rebuildGrid(): void {
  const page = currentPage();
  let next: CanvasGrid | undefined;
  let problem = '';
  const own = page?.geo ? crsOfGeo(page.geo) : undefined;
  if (page && (!page.geo || !chosenCrs || (own && crsKey(own) === crsKey(chosenCrs)))) {
    // The opened file's own pixels: exact, nothing warped.
    next = imageGrid(page);
    if (own) chosenCrs = own;
  } else if (chosenCrs) {
    // Another coordinate system: over the opened file, or over the layers' extent.
    const reference: GridReference | undefined = page?.geo ? page : (layers.dataReference ?? layers.homeReference ?? (grid && windowReference(grid, grid.bounds)));
    try {
      next = reference ? warpedGrid(reference, chosenCrs) : undefined;
    } catch (error) {
      problem = (error as Error).message;
      next = grid;
    }
  }
  setGrid(next);
  if (problem) showMessage(problem);
}

function setGrid(next: CanvasGrid | undefined): void {
  grid = next;
  gridMapper = grid?.geo ? new GeoMapper(grid.geo) : undefined;
  // The coordinate system: its EPSG code, or its name when it has none.
  statusCrs.textContent = grid?.label ?? '';
  statusCrs.hidden = !grid?.label;
  statusCrs.title = grid?.geo ? `Coordinate system: ${grid.geo.crsName}. Click to change it.` : '';
  layers.setGrid(grid, chosenCrs);
  // Measurements switch to pixels, or back to metres; places can be searched on a map.
  measureTool?.refresh();
  placeSearch?.updateButton();
}

/** The first layer of an empty viewer: a grid over it, in its coordinate system. */
function startGrid(reference: GridReference, crs: Crs): void {
  chosenCrs = crs;
  setGrid(warpedGrid(reference, crs));
  showMessage(undefined);
  fitMode = 'auto';
  layout(0);
}

/** A viewer opened from the Command Palette: no layers yet, EPSG:4326, unbounded, over Europe. */
function startBlank(): void {
  stopWorkers();
  blank = true;
  imageGone = true;
  info = undefined;
  clearTiles();
  statusFileSize.textContent = '';
  statusSize.textContent = '';
  pageGroup.hidden = true;
  layers.reset();
  layers.setPage(undefined, '');
  const crs = parseCrs('4326') as Crs;
  const europe = regionReference(crs, EUROPE);
  startGrid(europe, crs);
  layers.homeLabel = 'Europe';
  layers.setHome(europe);
  layers.forceUnbounded();
  showProgress(undefined);
  showMessage(EMPTY_MESSAGE);
  $('layers').hidden = false;
  $('layersToggle').setAttribute('aria-pressed', 'true');
  updateRenderingTarget();
  layout(0);
}

/**
 * The first data layer of a viewer opened from the Command Palette: the grid is laid
 * out again around it (same coordinate system, at about its resolution), so that
 * zooming deep into it stays precise. The view stays where it is.
 */
function firstLayer(reference: GridReference): void {
  if (!blank || !grid?.geo || !chosenCrs) return;
  const old = new GeoMapper(grid.geo);
  const oldRes = Math.hypot(grid.geo.transform[1], grid.geo.transform[4]);
  // The view's centre in the coordinate system, and its scale in units per screen pixel.
  const [cx, cy] = old.pixelToCrs((stage.clientWidth / 2 - view.tx) / view.scale, (stage.clientHeight / 2 - view.ty) / view.scale);
  const unitsPerPixel = oldRes / view.scale;
  let next: CanvasGrid;
  try {
    next = warpedGrid(reference, chosenCrs);
  } catch {
    return;
  }
  setGrid(next);
  const res = Math.hypot(next.geo!.transform[1], next.geo!.transform[4]);
  const [gx, gy] = new GeoMapper(next.geo!).crsToPixel(cx, cy);
  view.scale = res / unitsPerPixel;
  view.tx = stage.clientWidth / 2 - gx * view.scale;
  view.ty = stage.clientHeight / 2 - gy * view.scale;
  fitMode = undefined;
  layout();
}

/** The viewer of a vector file: no TIFF to decode; the file is its first layer. */
function startVector(uri: string, fileSize: number): void {
  stopWorkers();
  vectorFile = true;
  imageGone = true;
  info = undefined;
  clearTiles();
  statusFileSize.textContent = formatBytes(fileSize);
  statusSize.textContent = '';
  pageGroup.hidden = true;
  layers.reset();
  layers.setPage(undefined, fileName);
  setGrid(undefined);
  showProgress(undefined);
  showMessage(`Reading ${fileName}…`);
  updateRenderingTarget();
  void layers.addPaths([uri]).then(() => {
    if (!layers.count) showMessage(`${fileName} could not be shown: see the Layers panel.`);
  });
}

/** The opened file's layer was removed: the other layers stay, in the same grid. */
function imageRemoved(): void {
  imageGone = true;
  stopWorkers();
  info = undefined;
  clearTiles();
  statusFileSize.textContent = '';
  pageGroup.hidden = true;
  pixelReq = 0;
  shown = undefined;
  if (!target) {
    const next = layers.rasterChoices()[0];
    if (next?.kind === 'raster') selectTarget(next.layer);
  }
  updateRenderingTarget();
  renderInfo();
  draw();
}

/**
 * No layer is left: an empty canvas, in the same viewer (still the file's): the
 * next layer added starts a new canvas, in its coordinate system.
 */
function allRemoved(): void {
  if (blank) {
    // A viewer opened from the Command Palette keeps its canvas (coordinate system, view).
    showMessage(EMPTY_MESSAGE);
    updateRenderingTarget();
    draw();
    return;
  }
  chosenCrs = undefined;
  layers.reset();
  setGrid(undefined);
  showMessage(EMPTY_MESSAGE);
  updateRenderingTarget();
  draw();
}

function topLevel(page: PageInfo): number {
  return Math.max(0, Math.ceil(Math.log2(Math.max(page.width, page.height) / TOP_SIZE)));
}

function tileWindow(page: PageInfo, z: number, i: number, j: number): PixelWindow {
  const span = TILE_SIZE * 2 ** z;
  return [i * span, j * span, Math.min(page.width, (i + 1) * span), Math.min(page.height, (j + 1) * span)];
}

function tileSpec(page: PageInfo, z: number, i: number, j: number): TileSpec {
  const window = tileWindow(page, z, i, j);
  const f = 2 ** z;
  return {
    id: `${z}/${i}/${j}`,
    window,
    outWidth: Math.max(1, Math.ceil((window[2] - window[0]) / f)),
    outHeight: Math.max(1, Math.ceil((window[3] - window[1]) / f)),
  };
}

/** Image area in view, in full-resolution pixels. */
function visibleWindow(page: PageInfo): PixelWindow | undefined {
  const s = view.scale;
  if (grid && !grid.identity) {
    // The view in grid pixels, back into the image's pixels (sampled: the warp bends edges).
    const [bx0, by0, bx1, by1] = grid.bounds;
    const gx0 = Math.max(bx0, -view.tx / s);
    const gy0 = Math.max(by0, -view.ty / s);
    const gx1 = Math.min(bx1, (stage.clientWidth - view.tx) / s);
    const gy1 = Math.min(by1, (stage.clientHeight - view.ty) / s);
    if (gx1 <= gx0 || gy1 <= gy0) return undefined;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let j = 0; j <= 8; j++) {
      for (let i = 0; i <= 8; i++) {
        const [x, y] = grid.image.toSource(gx0 + ((gx1 - gx0) * i) / 8, gy0 + ((gy1 - gy0) * j) / 8);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    const pad = 2 + (maxX - minX) * 0.01;
    const warped: PixelWindow = [
      Math.max(0, Math.floor(minX - pad)),
      Math.max(0, Math.floor(minY - pad)),
      Math.min(page.width, Math.ceil(maxX + pad)),
      Math.min(page.height, Math.ceil(maxY + pad)),
    ];
    return warped[2] > warped[0] && warped[3] > warped[1] ? warped : undefined;
  }
  const visible: PixelWindow = [
    Math.max(0, Math.floor(-view.tx / s)),
    Math.max(0, Math.floor(-view.ty / s)),
    Math.min(page.width, Math.ceil((stage.clientWidth - view.tx) / s)),
    Math.min(page.height, Math.ceil((stage.clientHeight - view.ty) / s)),
  ];
  return visible[2] > visible[0] && visible[3] > visible[1] ? visible : undefined;
}

/** Tiles of level z overlapping `visible`, nearest to its centre first. */
function tilesInView(page: PageInfo, z: number, visible: PixelWindow): TileSpec[] {
  const span = TILE_SIZE * 2 ** z;
  const cx = (visible[0] + visible[2]) / 2;
  const cy = (visible[1] + visible[3]) / 2;
  const specs: { spec: TileSpec; d: number }[] = [];
  for (let j = Math.floor(visible[1] / span); j < Math.ceil(visible[3] / span); j++) {
    for (let i = Math.floor(visible[0] / span); i < Math.ceil(visible[2] / span); i++) {
      const d = Math.hypot((i + 0.5) * span - cx, (j + 0.5) * span - cy);
      specs.push({ spec: tileSpec(page, z, i, j), d });
    }
  }
  return specs.sort((a, b) => a.d - b.d).map((s) => s.spec);
}

/**
 * Estimated file tiles (or strips) a display tile needs, and their bytes. It
 * mirrors the worker: the smallest pyramid level with enough resolution, and
 * at most one file tile per output pixel when sampling sparsely.
 */
function estimate(page: PageInfo, spec: TileSpec): { tiles: number; bytes: number } {
  const [x0, y0, x1, y1] = spec.window;
  const scale = spec.outWidth / (x1 - x0);
  let level = page.levels[0];
  for (const candidate of page.levels) {
    if (candidate.width / page.width >= scale * 0.98) level = candidate;
  }
  const fx = level.width / page.width;
  const fy = level.height / page.height;
  const across = Math.ceil((x1 * fx) / level.tileWidth) - Math.floor((x0 * fx) / level.tileWidth);
  const down = Math.ceil((y1 * fy) / level.tileHeight) - Math.floor((y0 * fy) / level.tileHeight);
  const count = Math.min(across, spec.outWidth) * Math.min(down, spec.outHeight);
  return { tiles: count, bytes: count * level.tileWidth * level.tileHeight * bytesPerPixel };
}

function scheduleTiles(delay = 120): void {
  clearTimeout(tilesTimer);
  tilesTimer = setTimeout(updateTiles, delay);
}

/** Asks the worker for the tiles the current view needs, coarse levels first. */
function updateTiles(): void {
  const page = currentPage();
  if (!page || page.unsupported || !worker) {
    return;
  }
  const visible = visibleWindow(page);
  if (!visible) {
    return;
  }
  const top = topLevel(page);
  const levelCost = new Map<number, number>();
  const cost = (z: number) => {
    let bytes = levelCost.get(z);
    if (bytes === undefined) {
      bytes = tilesInView(page, z, visible).reduce((sum, spec) => sum + estimate(page, spec).bytes, 0);
      levelCost.set(z, bytes);
    }
    return bytes;
  };
  // Always the full sharpness the zoom needs, however much data that is.
  const z = Math.min(top, Math.max(0, Math.floor(Math.log2(1 / (view.scale * devicePixelRatio * (grid?.imageScale ?? 1))))));
  if (z !== viewLevel) {
    viewLevel = z;
    draw();
  }

  // The overview first, then coarser levels that cost much less than the
  // target level (they show something quickly), then the target level.
  // A huge image without overviews needs every file tile when zoomed out;
  // the coarse levels only sample some of them.
  const levels = [top];
  for (let l = top - 1; l > z; l--) {
    if (cost(l) <= cost(z) * COARSE_LEVEL_SHARE) levels.push(l);
  }
  if (z < top) levels.push(z);

  const list: TileSpec[] = [];
  for (const l of levels) {
    for (const spec of tilesInView(page, l, l === top ? [0, 0, page.width, page.height] : visible)) {
      const tile = tiles.get(spec.id);
      if ((tile?.final && tile.generation === generation) || failed.has(spec.id)) continue;
      list.push(spec);
    }
  }
  const key = `${generation}|${list.map((s) => s.id).join(',')}`;
  if (key === lastRequest) {
    return;
  }
  lastRequest = key;
  const previous = requested;
  requested = new Map(
    list.map((spec) => [spec.id, previous.get(spec.id) ?? { done: 0, total: Math.max(1, estimate(page, spec).tiles) }]),
  );
  updateProgress();
  postToWorker({ type: 'tiles', generation, page: pageIndex, tone, composite, tiles: list });
}

function updateProgress(): void {
  let done = 0;
  let total = 0;
  for (const entry of requested.values()) {
    done += entry.done;
    total += entry.total;
  }
  showProgress(total && done < total ? done / total : undefined, 'Loading');
  if (total && done >= total) {
    dropStaleTiles();
  }
}

/** Once the view is complete with the current settings, tiles rendered with older settings are no longer needed. */
function dropStaleTiles(): void {
  for (const [id, tile] of [...tiles]) {
    if (tile.generation !== generation) removeTile(id);
  }
}

// ---------------------------------------------------------------------------
// View transform
// ---------------------------------------------------------------------------

function fitScale(): number {
  if (!grid) {
    return 1;
  }
  const [b0, b1, b2, b3] = grid.bounds;
  return Math.min(stage.clientWidth / Math.max(1e-9, b2 - b0), stage.clientHeight / Math.max(1e-9, b3 - b1));
}

function minScale(): number {
  if (layers.unbounded && grid?.geo) {
    // The whole world fits in the view: 360° or 40 000 km across.
    const res = Math.hypot(grid.geo.transform[1], grid.geo.transform[4]) || 1;
    const world = (grid.geo.geographic ? 360 : 4.0075e7) / res;
    return Math.min(fitScale() * 0.5, 1, stage.clientWidth / world);
  }
  return Math.min(fitScale() * 0.5, 1);
}

function maxScale(): number {
  return Math.max(MAX_ZOOM, fitScale() * 4);
}

/** Keeps the canvas's extent (all the layers) in view: centred when smaller than the view. */
function clampView(): void {
  // An unbounded map pans freely.
  if (!grid || layers.unbounded) {
    return;
  }
  const [b0, b1, b2, b3] = grid.bounds;
  const clampAxis = (offset: number, lo: number, hi: number, viewport: number) => {
    const size = (hi - lo) * view.scale;
    return size <= viewport ? (viewport - size) / 2 - lo * view.scale : Math.min(-lo * view.scale, Math.max(viewport - hi * view.scale, offset));
  };
  view.tx = clampAxis(view.tx, b0, b2, stage.clientWidth);
  view.ty = clampAxis(view.ty, b1, b3, stage.clientHeight);
}

function layout(delay?: number): void {
  if (fitMode) {
    const s = fitScale();
    view.scale = fitMode === 'auto' ? Math.min(1, s) : s;
    // Unbounded, nothing keeps the extent in place: fitting centres it.
    if (grid && layers.unbounded) {
      const [b0, b1, b2, b3] = grid.bounds;
      view.tx = (stage.clientWidth - (b2 - b0) * view.scale) / 2 - b0 * view.scale;
      view.ty = (stage.clientHeight - (b3 - b1) * view.scale) / 2 - b1 * view.scale;
    }
  }
  clampView();
  updateZoomLabel();
  draw();
  scheduleTiles(delay);
}

function zoomTo(scale: number, anchorX = stage.clientWidth / 2, anchorY = stage.clientHeight / 2): void {
  if (!grid) {
    return;
  }
  const next = Math.min(maxScale(), Math.max(minScale(), scale));
  view.tx = anchorX - ((anchorX - view.tx) * next) / view.scale;
  view.ty = anchorY - ((anchorY - view.ty) * next) / view.scale;
  view.scale = next;
  fitMode = undefined;
  layout();
}

function setFit(mode: 'auto' | 'fit'): void {
  fitMode = mode;
  layout();
}

function updateZoomLabel(): void {
  const percent = view.scale * 100;
  // Down to world scale on an unbounded map: two significant digits below 1%.
  zoomLabel.textContent = grid ? `${percent >= 10 ? Math.round(percent) : percent >= 1 ? percent.toFixed(1) : Number(percent.toPrecision(2))}%` : '–';
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

let checker: CanvasPattern | undefined;
let checkerTheme = '';

function checkerPattern(): CanvasPattern {
  const light = document.body.classList.contains('vscode-light');
  const theme = light ? 'light' : 'dark';
  if (!checker || checkerTheme !== theme) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 16;
    const t = tile.getContext('2d')!;
    t.fillStyle = light ? '#ffffff' : '#3a3a3a';
    t.fillRect(0, 0, 16, 16);
    t.fillStyle = light ? '#e6e6e6' : '#2c2c2c';
    t.fillRect(0, 0, 8, 8);
    t.fillRect(8, 8, 8, 8);
    checker = ctx.createPattern(tile, 'repeat')!;
    checkerTheme = theme;
  }
  return checker;
}

/** The image on its own layer, when layers or a basemap go under it, it is see-through, or warped. */
let imageLayer: HTMLCanvasElement | undefined;

function draw(): void {
  const dpr = devicePixelRatio;
  const width = Math.round(stage.clientWidth * dpr);
  const height = Math.round(stage.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const page = currentPage();
  if (!grid) {
    return;
  }
  const viewState = { scale: view.scale, tx: view.tx, ty: view.ty, dpr, width: stage.clientWidth, height: stage.clientHeight };
  const layered = layers.imageLayered;
  // A chequerboard where nothing covers the canvas: under the layers' extent, or the
  // opened file's outline when it is alone.
  if (layers.unbounded) {
    // A map with no edges: empty (chequered) everywhere the layers and basemaps leave uncovered.
    ctx.fillStyle = checkerPattern();
    ctx.fillRect(0, 0, width, height);
  } else if (!page || layers.count > 1) {
    const [b0, b1, b2, b3] = grid.bounds;
    const x0 = Math.round((view.tx + b0 * view.scale) * dpr);
    const y0 = Math.round((view.ty + b1 * view.scale) * dpr);
    ctx.fillStyle = checkerPattern();
    ctx.fillRect(x0, y0, Math.round((view.tx + b2 * view.scale) * dpr) - x0, Math.round((view.ty + b3 * view.scale) * dpr) - y0);
  } else if (hasTransparency(page) || layered) {
    ctx.save();
    outlinePath(ctx, grid, view.scale, view.tx, view.ty, dpr);
    ctx.fillStyle = checkerPattern();
    ctx.fill();
    ctx.restore();
  }
  layers.drawStack(ctx, viewState, () => page && drawImage(page, layered, width, height));
  layers.drawTop(ctx, viewState);
  drawPlaceMarker(dpr);
  measureTool?.draw(ctx, dpr);
}

/** The opened image: straight onto the canvas, or onto its own layer (to go over other layers, be see-through or warped). */
function drawImage(page: PageInfo, layered: boolean, width: number, height: number): void {
  const visible = visibleWindow(page);
  if (!visible) {
    return;
  }
  // Coarse levels first, finer ones on top. Finer tiles than the view needs
  // (left from zooming in) are drawn too, down to two levels below.
  const shown = [...tiles.values()]
    .filter(
      (t) =>
        t.z >= viewLevel - 2 &&
        t.window[0] < visible[2] &&
        t.window[2] > visible[0] &&
        t.window[1] < visible[3] &&
        t.window[3] > visible[1],
    )
    // Tiles rendered with older settings first, as placeholders, then the current
    // ones on top; within each, coarse levels first and finer ones on top. (Drawing
    // by level alone let sharp tiles left from zooming in, rendered with older
    // settings, cover current ones for good.)
    .sort((a, b) => (a.generation === generation ? 1 : 0) - (b.generation === generation ? 1 : 0) || b.z - a.z || a.generation - b.generation);
  let target = ctx;
  if (layered) {
    imageLayer ??= document.createElement('canvas');
    if (imageLayer.width !== width || imageLayer.height !== height) {
      imageLayer.width = width;
      imageLayer.height = height;
    }
    target = imageLayer.getContext('2d')!;
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, width, height);
  }
  const warpedTransparent = !!grid && !grid.identity && hasTransparency(page);
  // Warped: a coarser tile is not drawn at all where finer, final tiles cover it (in view).
  // Clearing under them (below) leaves half a pixel of it along anti-aliased edges, which
  // showed as a faint line along the image's outline.
  const covered = (tile: DisplayTile): boolean => {
    const x0 = Math.max(tile.window[0], visible[0]);
    const y0 = Math.max(tile.window[1], visible[1]);
    const x1 = Math.min(tile.window[2], visible[2]);
    const y1 = Math.min(tile.window[3], visible[3]);
    const need = (x1 - x0) * (y1 - y0);
    if (need <= 0) return true;
    const byLevel = new Map<number, number>();
    for (const t of shown) {
      if (t.z >= tile.z || !t.final || t.generation !== generation) continue;
      const w = Math.min(t.window[2], x1) - Math.max(t.window[0], x0);
      const h = Math.min(t.window[3], y1) - Math.max(t.window[1], y0);
      if (w > 0 && h > 0) byLevel.set(t.z, (byLevel.get(t.z) ?? 0) + w * h);
    }
    return [...byLevel.values()].some((area) => area >= need - 1e-6);
  };
  // Warped cells overlap a little to hide seams; along the image's right and bottom
  // edges that would draw thin lines just outside it: clip to its outline.
  const warped = !!grid && !grid.identity;
  if (warped) {
    target.save();
    outlinePath(target, grid!, view.scale, view.tx, view.ty, devicePixelRatio);
    target.clip();
  }
  let groupKey = '';
  for (const [index, tile] of shown.entries()) {
    tile.used = ++drawCounter;
    if (warpedTransparent && covered(tile)) continue;
    if (warpedTransparent && tile.final) {
      const key = `${tile.generation}/${tile.z}`;
      if (key !== groupKey) {
        groupKey = key;
        clearWarpedFootprints(target, shown.slice(index).filter((t) => t.final && `${t.generation}/${t.z}` === key));
      }
    }
    drawTile(target, page, tile, width, height, !layered);
  }
  if (warped) target.restore();
  if (layered && imageLayer) {
    ctx.save();
    ctx.globalAlpha = layers.imageOpacity;
    ctx.drawImage(imageLayer, 0, 0);
    ctx.restore();
  }
}

function hasTransparency(page: PageInfo): boolean {
  return page.hasAlpha || !!composite;
}

/** Canvas (device pixel) rectangle of an image window, with edges rounded so that tiles meet exactly. */
function deviceRect(page: PageInfo, window: PixelWindow): [number, number, number, number] {
  const dpr = devicePixelRatio;
  const s = view.scale * dpr;
  const ox = view.tx * dpr;
  const oy = view.ty * dpr;
  return [
    Math.round(ox + window[0] * s),
    Math.round(oy + window[1] * s),
    Math.round(ox + window[2] * s),
    Math.round(oy + window[3] * s),
  ];
}

const TILE_MESH = 8;

/** Where a tile goes in a warped grid: mesh points in grid pixels (kept until the grid changes). */
function tileMesh(tile: DisplayTile): Float64Array {
  if (tile.meshGrid !== grid && grid) {
    const [wx0, wy0, wx1, wy1] = tile.window;
    const mesh = new Float64Array((TILE_MESH + 1) * (TILE_MESH + 1) * 2);
    let k = 0;
    for (let j = 0; j <= TILE_MESH; j++) {
      for (let i = 0; i <= TILE_MESH; i++) {
        const [gx, gy] = grid.image.toCanvas(wx0 + ((wx1 - wx0) * i) / TILE_MESH, wy0 + ((wy1 - wy0) * j) / TILE_MESH);
        mesh[k++] = gx;
        mesh[k++] = gy;
      }
    }
    tile.mesh = mesh;
    tile.meshGrid = grid;
  }
  return tile.mesh!;
}

/**
 * Clears where the final tiles of a group (same level and settings) go in a warped
 * grid, in one fill: coarser tiles must not show through transparent pixels
 * (NoData), and one fill leaves no seams where tiles meet.
 */
function clearWarpedFootprints(target: CanvasRenderingContext2D, group: DisplayTile[]): void {
  const n = TILE_MESH + 1;
  const k = view.scale * devicePixelRatio;
  const ox = view.tx * devicePixelRatio;
  const oy = view.ty * devicePixelRatio;
  const border: number[] = [];
  for (let i = 0; i < n; i++) border.push(i);
  for (let j = 1; j < n; j++) border.push(j * n + n - 1);
  for (let i = n - 2; i >= 0; i--) border.push((n - 1) * n + i);
  for (let j = n - 2; j > 0; j--) border.push(j * n);
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.beginPath();
  for (const tile of group) {
    const mesh = tileMesh(tile);
    border.forEach((p, i) => {
      const x = mesh[2 * p] * k + ox;
      const y = mesh[2 * p + 1] * k + oy;
      if (i) target.lineTo(x, y);
      else target.moveTo(x, y);
    });
    target.closePath();
  }
  target.globalCompositeOperation = 'destination-out';
  target.fill('nonzero');
  target.restore();
}

function drawTile(ctx: CanvasRenderingContext2D, page: PageInfo, tile: DisplayTile, width: number, height: number, checker: boolean): void {
  if (grid && !grid.identity) {
    // Warped into another coordinate system: a mesh of affine cells, like the basemap.
    tileMesh(tile);
    ctx.imageSmoothingEnabled = !(tile.z === 0 && view.scale * devicePixelRatio * grid.imageScale >= 1);
    ctx.imageSmoothingQuality = 'high';
    drawWarped(ctx, tile.bitmap, tile.bitmap.width, tile.bitmap.height, tile.mesh!, TILE_MESH, {
      scale: view.scale,
      tx: view.tx,
      ty: view.ty,
      dpr: devicePixelRatio,
      width: stage.clientWidth,
      height: stage.clientHeight,
    });
    return;
  }
  const [x0, y0, x1, y1] = deviceRect(page, tile.window);
  // Clip to the canvas to keep coordinates small at high zoom.
  const cx0 = Math.max(0, x0);
  const cy0 = Math.max(0, y0);
  const cx1 = Math.min(width, x1);
  const cy1 = Math.min(height, y1);
  if (cx1 <= cx0 || cy1 <= cy0) {
    return;
  }
  const bw = tile.bitmap.width;
  const bh = tile.bitmap.height;
  const sx0 = ((cx0 - x0) / (x1 - x0)) * bw;
  const sy0 = ((cy0 - y0) / (y1 - y0)) * bh;
  const sx1 = ((cx1 - x0) / (x1 - x0)) * bw;
  const sy1 = ((cy1 - y0) / (y1 - y0)) * bh;
  if (hasTransparency(page) && tile.final) {
    // Do not let coarser tiles show through transparent pixels.
    ctx.clearRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    if (checker) {
      ctx.fillStyle = checkerPattern();
      ctx.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    }
  }
  // Show crisp pixels when magnifying full-resolution data; smooth otherwise.
  ctx.imageSmoothingEnabled = !(tile.z === 0 && view.scale * devicePixelRatio >= 1);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tile.bitmap, sx0, sy0, sx1 - sx0, sy1 - sy0, cx0, cy0, cx1 - cx0, cy1 - cy0);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function showProgress(fraction: number | undefined, label = 'Loading'): void {
  progress.hidden = fraction === undefined;
  const percent = (fraction ?? 0) * 100;
  progressBar.style.width = `${percent}%`;
  statusProgress.textContent =
    fraction === undefined ? '' : `${label} ${percent < 10 ? percent.toFixed(1) : Math.floor(percent)}%`;
}

function showMessage(text: string | undefined): void {
  messageBox.hidden = !text;
  messageBox.textContent = text ?? '';
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  return Number(value.toPrecision(6)).toString();
}

/** A band value as shown: NoData values are labelled as such. */
function showValue(page: PageInfo, v: number): string {
  return page.noData !== null && v === page.noData ? 'NoData' : formatNumber(v);
}

/** A composite's computed value, with its class label in paletted mode (the image's classes by default). */
function showComputed(v: number, classes = composite?.classes): string {
  if (Number.isNaN(v)) return 'NoData';
  if (!classes) return formatNumber(v);
  const match = classes.find((c) => Math.fround(c.value) === Math.fround(v));
  return match ? `${formatNumber(v)}${match.label && match.label !== formatNumber(v) ? ` (${match.label})` : ''}` : `${formatNumber(v)} (no class)`;
}

/** Labels of a composite's computed values: R, G, B, or none for a single value. */
function computedLabels(computed: number[]): string[] {
  return computed.length === 3 ? ['R', 'G', 'B'] : [''];
}


/** Longitude and latitude of the centre of pixel (x, y) of a georeferenced raster; '' otherwise. */
function formatLonLat(x: number, y: number, mapper = geoMapper): string {
  if (!mapper) return '';
  return lonLatText(...mapper.pixelToLonLat(x + 0.5, y + 0.5));
}

function lonLatText(lon: number, lat: number): string {
  // Six decimals: about 0.1 m.
  return Number.isFinite(lon) && Number.isFinite(lat) ? `lon ${lon.toFixed(6)}, lat ${lat.toFixed(6)}` : '';
}

// --- Pixel readout: in the status bar, or in a table next to the pointer (Space) ---

const pixelTip = $<HTMLDivElement>('pixelTip');

/** Shows the pixel readout: in the value table when it is on, otherwise in the status bar. */
/** A raster's pixel under the pointer, with what it takes to show it. */
interface RasterReadout {
  x: number;
  y: number;
  values: number[] | null;
  computed?: number[];
  page: PageInfo;
  classes: CompositeSpec['classes'];
  mapper: GeoMapper | undefined;
}

/** The opened file's pixel under the pointer, if it is a layer and the pointer is over it. */
function imageReadout(): RasterReadout | undefined {
  const page = currentPage();
  return page && shown && pixelReq !== 0 ? { ...shown, page, classes: composite?.classes, mapper: geoMapper } : undefined;
}

/** The pixel of the raster selected in the Layers panel (whose values the status bar shows). */
function selectedReadout(): RasterReadout | undefined {
  if (!target) return imageReadout();
  const r = target.readout;
  const page = target.page;
  return r && page ? { ...r, page, classes: target.composite?.classes, mapper: page.geo ? new GeoMapper(page.geo) : undefined } : undefined;
}

/** Longitude / latitude of the pointer, from the canvas's grid. */
function pointerLonLat(): string {
  return pointerGrid && gridMapper ? lonLatText(...gridMapper.pixelToLonLat(pointerGrid[0], pointerGrid[1])) : '';
}

/**
 * Shows the pixel readout. The status bar has the position only: the pixel of the
 * raster selected in the Layers panel and its longitude / latitude (hidden while the
 * value table is on). Band and rendered values are only in the value table.
 */
function renderReadout(): void {
  if (!pointerGrid) {
    statusPos.textContent = '';
    pixelTip.hidden = true;
    return;
  }
  if (tipOn) {
    statusPos.textContent = '';
  } else {
    const r = selectedReadout();
    const lonLat = r ? formatLonLat(r.x, r.y, r.mapper) : pointerLonLat();
    statusPos.textContent = [r ? `x ${r.x}, y ${r.y}` : '', lonLat].filter(Boolean).join('  |  ');
  }
  updatePixelTip();
}

/**
 * The value table next to the pointer, while it is on: one table per layer
 * under the pointer, top layer first. Rasters show their pixel's band values
 * (and the rendering's values), vector layers the attributes of the features
 * under the pointer.
 */
function updatePixelTip(): void {
  if (!tipOn || !pointer || !pointerGrid) {
    pixelTip.hidden = true;
    return;
  }
  const row = (name: string, value: string) => {
    const tr = document.createElement('tr');
    tr.append(Object.assign(document.createElement('th'), { scope: 'row', textContent: name }), Object.assign(document.createElement('td'), { textContent: value }));
    return tr;
  };
  const head = (first: string, second: string) => {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    tr.append(Object.assign(document.createElement('th'), { scope: 'col', textContent: first }), Object.assign(document.createElement('th'), { scope: 'col', textContent: second }));
    thead.append(tr);
    return thead;
  };
  const table = (title: string, detail: string, ...sections: HTMLElement[]) => {
    const t = document.createElement('table');
    const caption = document.createElement('caption');
    caption.append(Object.assign(document.createElement('strong'), { textContent: title }));
    if (detail) caption.append(document.createElement('br'), detail);
    t.append(caption, ...sections);
    return t;
  };
  /** A raster's pixel: its bands, then the rendering's values. */
  const rasterTable = (name: string, layerPage: PageInfo, readout: { x: number; y: number; values: number[] | null; computed?: number[] }, classes: CompositeSpec['classes']) => {
    const body = document.createElement('tbody');
    // The band's name in the file (GDAL description, e.g. B04), else b1…bN.
    (readout.values ?? []).forEach((v, i) => body.append(row(layerPage.bandNames[i] || `b${i + 1}`, showValue(layerPage, v))));
    const sections: HTMLElement[] = [head('Band', 'Value'), body];
    if (readout.computed?.length) {
      const result = document.createElement('tbody');
      result.className = 'computed';
      const labels = computedLabels(readout.computed);
      readout.computed.forEach((v, i) => result.append(row(labels[i] ? `Rendered ${labels[i]}` : 'Rendered', showComputed(v, classes))));
      sections.push(result);
    }
    return table(name, `x ${readout.x}, y ${readout.y}`, ...sections);
  };
  const tables: HTMLElement[] = [];
  const identified = layers.identify(pointerGrid[0], pointerGrid[1], view.scale);
  const several = identified.length > 1;
  for (const item of identified) {
    if (item.kind === 'image') {
      const r = imageReadout();
      if (r?.values) tables.push(rasterTable(item.name, r.page, r, r.classes));
    } else if (item.kind === 'raster' && item.layer.readout && item.layer.page) {
      tables.push(rasterTable(item.layer.name, item.layer.page, item.layer.readout, item.layer.composite?.classes));
    } else if (item.kind === 'vector') {
      item.features.forEach((properties, i) => {
        const body = document.createElement('tbody');
        const entries = Object.entries(properties ?? {});
        for (const [key, value] of entries.slice(0, 40)) {
          body.append(row(key, value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)));
        }
        if (!entries.length) body.append(row('(no attributes)', ''));
        if (entries.length > 40) body.append(row(`… ${entries.length - 40} more`, ''));
        const count = item.features.length + item.more;
        const detail = count > 1 ? `feature ${i + 1} of ${count}${i === item.features.length - 1 && item.more ? ` (${item.more} more not shown)` : ''}` : '';
        tables.push(table(item.name, detail, head('Attribute', 'Value'), body));
      });
    }
  }
  if (!tables.length) {
    pixelTip.hidden = true;
    return;
  }
  if (several) {
    // Where the pointer is, then each layer's table (each names its own pixel).
    const where = Object.assign(document.createElement('div'), { className: 'tip-where', textContent: pointerLonLat() });
    pixelTip.replaceChildren(...(where.textContent ? [where] : []), ...tables);
  } else {
    // One layer: its pixel and longitude / latitude in the caption.
    const only = tables[0];
    const r = identified[0].kind === 'image' ? imageReadout() : identified[0].kind === 'raster' ? identified[0].layer.readout : undefined;
    const caption = only.querySelector('caption');
    if (caption && r) {
      const mapper = identified[0].kind === 'raster' ? (identified[0].layer.page?.geo ? new GeoMapper(identified[0].layer.page.geo) : undefined) : geoMapper;
      const lonLat = formatLonLat(r.x, r.y, mapper);
      caption.replaceChildren(`x ${r.x}, y ${r.y}`, ...(lonLat ? [document.createElement('br'), lonLat] : []));
    }
    pixelTip.replaceChildren(only);
  }
  pixelTip.hidden = false;
  placePixelTip();
}

/** Puts the value table beside the pointer, flipped to stay inside the image area. */
function placePixelTip(): void {
  if (pixelTip.hidden || !pointer) return;
  const rect = stage.getBoundingClientRect();
  const gap = 14;
  const w = pixelTip.offsetWidth;
  const h = pixelTip.offsetHeight;
  let left = pointer.x - rect.left + gap;
  let top = pointer.y - rect.top + gap;
  if (left + w > rect.width - 4) left = pointer.x - rect.left - gap - w;
  if (top + h > rect.height - 4) top = pointer.y - rect.top - gap - h;
  pixelTip.style.left = `${Math.max(4, left)}px`;
  pixelTip.style.top = `${Math.max(4, top)}px`;
}

/** The value table on hover (Space, or its button in the status bar). */
function setTipOn(on: boolean): void {
  tipOn = on;
  valuesToggle.setAttribute('aria-pressed', String(on));
  layers.readPixels(tipOn ? pointerGrid : undefined);
  renderReadout();
}
valuesToggle.addEventListener('click', () => setTipOn(!tipOn));

const TEXT_INPUTS = new Set(['text', 'number', 'search', 'url', 'email', 'password', 'tel']);

/** Whether `target` takes typed text (where Space is a character). */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type)) ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

// Space turns the value table on and off everywhere except in text fields: it does
// not press a focused button, tick a checkbox or open a dropdown.
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    setTipOn(!tipOn);
  },
  { capture: true },
);
// Space is what presses buttons and ticks boxes on key up: cancel that too.
window.addEventListener(
  'keyup',
  (event) => {
    if (event.key === ' ' && !isTyping(event.target)) event.preventDefault();
  },
  { capture: true },
);

// Controls give the keyboard back to the image once used (a chosen preset, a clicked
// button, a moved slider), so that Space and the other keys act on the viewer.
// Text fields keep it, and so does a control that moved the focus elsewhere itself.
const returnFocus = (control: Element) => {
  if (document.activeElement === control || document.activeElement === document.body) stage.focus({ preventScroll: true });
};
document.addEventListener('change', (event) => {
  const t = event.target;
  if ((t instanceof HTMLSelectElement || t instanceof HTMLInputElement) && !isTyping(t)) returnFocus(t);
});
document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  // detail 0: pressed from the keyboard, where moving the focus would be unexpected.
  if (button && event.detail > 0) returnFocus(button);
});

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

/** Values longer than this start collapsed in the info panel. */
const LONG_VALUE = 300;

function renderInfo(): void {
  // The raster selected in the Layers panel (the opened file's, or another layer).
  const page = targetPage();
  const info = target ? target.info : imageInfo();
  const fileName = targetName();
  const pageIndex = target ? 0 : currentPageIndex();
  if (!info || !page) {
    infoContent.replaceChildren();
    return;
  }
  const section = (title: string, rows: [string, string][]) => {
    const h = document.createElement('h3');
    h.textContent = title;
    const dl = document.createElement('dl');
    for (const [key, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      if (value.length > LONG_VALUE) {
        // Long values (XML metadata, long custom strings) start collapsed.
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `${value.slice(0, 120).replace(/\s+/g, ' ')}… (${value.length.toLocaleString()} characters)`;
        const full = document.createElement('div');
        full.className = 'long-value';
        full.textContent = value;
        details.append(summary, full);
        dd.append(details);
      } else {
        dd.textContent = value;
      }
      dl.append(dt, dd);
    }
    return [h, dl];
  };
  const fileRows: [string, string][] = [
    ['Name', fileName],
    ['Format', info.bigTiff ? 'BigTIFF (64-bit offsets)' : 'TIFF (32-bit offsets)'],
    ['Byte order', info.littleEndian ? 'Little-endian (II)' : 'Big-endian (MM)'],
    ['File size', formatBytes(info.fileSize)],
    ['Images (IFDs)', String(info.ifdCount)],
    ['Pages', String(info.pages.length)],
  ];
  const pageRows: [string, string][] = [
    ['Dimensions', `${page.width} × ${page.height}`],
    ['Samples per pixel', `${page.samplesPerPixel} (${page.sampleLabels.join(', ')})`],
    ['Bits per sample', page.bitsPerSample.join(', ')],
    ['Sample format', page.sampleFormat],
    ['Photometric', page.photometric],
    ['Compression', page.compression],
    ['Planar config', page.planar],
    ['Layout', page.layout],
  ];
  if (page.levels.length > 1) {
    pageRows.push(['Pyramid levels', page.levels.map((l) => `${l.width}×${l.height}`).join(', ')]);
  }
  if (page.noData !== null) {
    pageRows.push(['NoData', String(page.noData)]);
  }
  infoContent.replaceChildren(
    ...section('File', fileRows),
    ...section(info.pages.length > 1 ? `Page ${pageIndex + 1}` : 'Image', pageRows),
    ...(page.tags.length ? section('Summary', page.tags) : []),
    ...(page.metadata.length ? section('Metadata (GDAL)', page.metadata) : []),
    ...(page.geoKeys.length ? section('GeoTIFF keys', page.geoKeys) : []),
    ...section(`TIFF tags (${page.allTags.length})`, page.allTags),
  );
}

function toggleInfo(): void {
  infoPanel.hidden = !infoPanel.hidden;
  infoToggle.setAttribute('aria-pressed', String(!infoPanel.hidden));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** A press on the map: it pans once moved (at once with the middle button); a left click that barely moves measures. */
let drag: { x: number; y: number; id: number; startX: number; startY: number; moved: boolean } | undefined;
/** How far (CSS pixels) the pointer may move for a press to count as a click (the Measure tool). */
const CLICK_SLOP = 4;

function stagePoint(event: MouseEvent): [number, number] {
  const rect = stage.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

stage.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    // The wheel zooms around the pointer (panning is by dragging with the mouse).
    const lineScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    const [x, y] = stagePoint(event);
    const delta = Math.max(-100, Math.min(100, (event.deltaY || event.deltaX) * lineScale));
    if (!delta) return;
    zoomTo(view.scale * Math.exp(-delta * 0.01), x, y);
    // The pixel under the pointer may change: refresh the readout and the value table.
    updatePointerReadout(event);
  },
  { passive: false },
);

stage.addEventListener('pointerdown', (event) => {
  // Right-click undoes the last point (as Backspace).
  if (event.button === 2 && measureTool?.active) {
    measureTool.undo();
    return;
  }
  if (event.button !== 0 && event.button !== 1) {
    return;
  }
  stage.focus();
  const measuring = event.button === 0 && !!measureTool?.active;
  drag = { x: event.clientX, y: event.clientY, id: event.pointerId, startX: event.clientX, startY: event.clientY, moved: !measuring };
  stage.setPointerCapture(event.pointerId);
  if (!measuring) stage.classList.add('dragging');
});

stage.addEventListener('contextmenu', (event) => {
  if (measureTool?.active) event.preventDefault();
});

stage.addEventListener('pointermove', (event) => {
  if (drag && drag.id === event.pointerId && !drag.moved) {
    // Measuring: a press only pans once it moves more than a click would.
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < CLICK_SLOP) {
      updatePointerReadout(event);
      return;
    }
    drag.moved = true;
    stage.classList.add('dragging');
  }
  if (drag && drag.id === event.pointerId) {
    view.tx += event.clientX - drag.x;
    view.ty += event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    clampView();
    draw();
    scheduleTiles();
    return;
  }
  updatePointerReadout(event);
});

const endDrag = (event: PointerEvent) => {
  if (drag && drag.id === event.pointerId) {
    const click = !drag.moved && event.type === 'pointerup';
    drag = undefined;
    stage.classList.remove('dragging');
    if (click && measureTool?.active && grid) {
      const [sx, sy] = stagePoint(event);
      measureTool.click((sx - view.tx) / view.scale, (sy - view.ty) / view.scale, sx, sy);
    }
  }
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
// Take keyboard focus when the pointer enters the image, so that Space toggles the
// value table without clicking first: while another part of VS Code has focus, key
// presses never reach the viewer. An input in the side panels keeps its focus.
stage.addEventListener('pointerenter', () => {
  if (!document.hasFocus() || !isTyping(document.activeElement)) stage.focus({ preventScroll: true });
});

stage.addEventListener('pointerleave', () => {
  pixelReq = 0;
  requestedPixel = '';
  pointer = undefined;
  pointerGrid = undefined;
  layers.readPixels(undefined);
  renderReadout();
  measureTool?.move(undefined, undefined);
});

stage.addEventListener('dblclick', (event) => {
  // Measuring: a double-click finishes the measurement (it does not zoom).
  if (measureTool?.active) {
    measureTool.finish();
    return;
  }
  const [x, y] = stagePoint(event);
  if (Math.abs(view.scale - Math.min(1, fitScale())) < 1e-6 || fitMode) {
    zoomTo(view.scale < 1 ? 1 : view.scale * 2, x, y);
  } else {
    setFit('auto');
  }
});

function updatePointerReadout(event: MouseEvent): void {
  if (!grid) {
    return;
  }
  const [px, py] = stagePoint(event);
  // Grid pixels, then each raster's pixel there.
  const gx = (px - view.tx) / view.scale;
  const gy = (py - view.ty) / view.scale;
  // The measurement follows the pointer.
  measureTool?.move(gx, gy);
  pointer = { x: event.clientX, y: event.clientY };
  const [b0, b1, b2, b3] = grid.bounds;
  if (!layers.unbounded && !(gx >= b0 && gy >= b1 && gx < b2 && gy < b3)) {
    pixelReq = 0;
    requestedPixel = '';
    pointerGrid = undefined;
    layers.readPixels(undefined);
    renderReadout();
    return;
  }
  pointerGrid = [gx, gy];
  // The raster layers' pixels (for the status bar's selected raster, and the value table).
  layers.readPixels(pointerGrid);
  placePixelTip();
  // The opened file's pixel, while it is a layer.
  const page = currentPage();
  if (!page || page.unsupported) {
    renderReadout();
    return;
  }
  const [ix, iy] = grid.identity ? [gx, gy] : grid.image.toSource(gx, gy);
  const x = Math.floor(ix);
  const y = Math.floor(iy);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= page.width || y >= page.height) {
    pixelReq = 0;
    requestedPixel = '';
    renderReadout();
    return;
  }
  // One request per pixel (and rendering): moving within a pixel asks nothing new.
  const key = `${pageIndex}:${x}:${y}`;
  if (key === requestedPixel && composite === requestedComposite && pixelReq !== 0) return renderReadout();
  requestedPixel = key;
  requestedComposite = composite;
  pixelReq = ++requestCounter;
  postToWorker({ type: 'pixel', reqId: pixelReq, page: pageIndex, x, y, composite });
  renderReadout();
}

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement || event.altKey) {
    return;
  }
  const mod = event.ctrlKey || event.metaKey;
  let handled = true;
  switch (event.key) {
    case '+':
    case '=':
      zoomTo(view.scale * ZOOM_STEP);
      break;
    case '-':
    case '_':
      zoomTo(view.scale / ZOOM_STEP);
      break;
    case '0':
      setFit('fit');
      break;
    case '1':
      zoomTo(1);
      break;
    case 'PageDown':
    case ']':
      changePage(1);
      break;
    case 'PageUp':
    case '[':
      changePage(-1);
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      const step = event.shiftKey ? 200 : 50;
      view.tx += event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0;
      view.ty += event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
      clampView();
      draw();
      scheduleTiles();
      break;
    }
    case 'u':
    case 'U':
      // Unbounded view, for georeferenced layers.
      if (mod || !layers.available || !grid?.geo) handled = false;
      else layers.toggleUnbounded();
      break;
    case 'g':
    case 'G':
      // Coordinates & scale, for georeferenced images.
      if (mod || !layers.available) handled = false;
      else layers.toggleTicks();
      break;
    case 'r':
    case 'R':
      // The Measure tool, on or off.
      if (mod || !measureTool || !grid) handled = false;
      else measureTool.setOn(!measureTool.active);
      break;
    case 's':
    case 'S':
      if (mod || !grid) handled = false;
      else takeScreenshot();
      break;
    case 'Backspace':
    case 'Delete':
      // The last point measured.
      handled = !mod && !!measureTool?.undo();
      break;
    case 'Escape':
      // Start the measurement over; or hide the place found.
      handled = !!measureTool?.clear() || clearPlaceMarker();
      break;
    default:
      handled = false;
  }
  if (handled && !mod) {
    event.preventDefault();
  }
});

function changePage(delta: number): void {
  if (!info) {
    return;
  }
  const next = pageIndex + delta;
  if (next >= 0 && next < info.pages.length) {
    selectPage(next);
  }
}

$('zoomIn').addEventListener('click', () => zoomTo(view.scale * ZOOM_STEP));
$('zoomOut').addEventListener('click', () => zoomTo(view.scale / ZOOM_STEP));
$('fit').addEventListener('click', () => setFit('fit'));
$('actual').addEventListener('click', () => zoomTo(1));
infoToggle.addEventListener('click', toggleInfo);

// Each open side panel's left border can be dragged to resize it (double-click: default width).
for (const resizer of document.querySelectorAll<HTMLDivElement>('.panel-resizer')) {
  const panel = $<HTMLElement>(resizer.dataset.panel!);
  let start: { x: number; width: number; id: number } | undefined;
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    start = { x: event.clientX, width: panel.getBoundingClientRect().width, id: event.pointerId };
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('dragging');
  });
  resizer.addEventListener('pointermove', (event) => {
    if (!start || start.id !== event.pointerId) return;
    // Wider to the left; at least 220 px, and at least 200 px left for the image.
    const others = [...document.querySelectorAll<HTMLElement>('#main > aside')]
      .filter((p) => p !== panel && !p.hidden)
      .reduce((sum, p) => sum + p.getBoundingClientRect().width, 0);
    const max = Math.max(220, window.innerWidth - others - 200);
    const width = Math.min(max, Math.max(220, start.width + start.x - event.clientX));
    panel.style.width = `${Math.round(width)}px`;
    panel.style.maxWidth = 'none';
  });
  const end = (event: PointerEvent) => {
    if (!start || start.id !== event.pointerId) return;
    start = undefined;
    resizer.classList.remove('dragging');
  };
  resizer.addEventListener('pointerup', end);
  resizer.addEventListener('pointercancel', end);
  resizer.addEventListener('dblclick', () => {
    panel.style.width = '';
    panel.style.maxWidth = '';
  });
  // The size lasts while the viewer is open (closing and reopening the panel keeps it);
  // it is not saved, so a new viewer starts with the default widths.
}

// The × at the top right of each side panel closes it (as its toolbar button does).
for (const button of document.querySelectorAll<HTMLButtonElement>('.panel-close')) {
  button.addEventListener('click', () => {
    const panel = button.closest('aside')!;
    if (panel.id === 'composite') return showComposite(false);
    // Closing the Measure panel turns the tool off.
    if (panel.id === 'measure') return measureTool?.setOn(false);
    panel.hidden = true;
    $(button.dataset.toggle!).setAttribute('aria-pressed', 'false');
  });
}
pageSelect.addEventListener('change', () => selectPage(Number(pageSelect.value)));

new ResizeObserver(() => layout()).observe(stage);
new MutationObserver(() => draw()).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ---------------------------------------------------------------------------
// Band composites
// ---------------------------------------------------------------------------

const presetGroup = $<HTMLLabelElement>('presetGroup');
const presetSelect = $<HTMLSelectElement>('preset');
const compositeToggle = $<HTMLButtonElement>('compositeToggle');
const compositePanel = $<HTMLElement>('composite');
const channelsBox = $<HTMLDivElement>('channels');
const colormapRow = $<HTMLDivElement>('colormapRow');
const colormapSelect = $<HTMLSelectElement>('colormap');
const adjustmentsBox = $<HTMLDivElement>('adjustments');
const compositeError = $<HTMLDivElement>('compositeError');
const deleteButton = $<HTMLButtonElement>('deletePreset');
const bandList = $<HTMLDivElement>('bandList');

/** Presets from the presets file. */
let userPresets: Preset[] = [];
/** What was shown for this file last time (from the extension host). */
let remembered: Selection | undefined;
let selection: Selection = { kind: 'none' };
let selectionResolved = false;
/** The composite being rendered; undefined shows the image's own colours. */
let composite: CompositeSpec | undefined;
/** The preset in the editor. Its name, bands and match rule carry over from the selected preset. */
let editing: Preset = { name: '' };
interface ChannelRow {
  expression: HTMLInputElement;
  min: HTMLInputElement;
  max: HTMLInputElement;
  /** "auto = [stretch]", shown while min and max are empty. */
  autoRow: HTMLDivElement;
  auto: HTMLSelectElement;
}

type Mode = RenderMode;
/** A class of the paletted mode. */
interface PaletteRow {
  value: number;
  rgba: RGBA;
  label: string;
}
/** Everything the panel shows for one mode, as typed (so that switching modes restores it exactly). */
interface PanelState {
  expressions: string[];
  mins: string[];
  maxs: string[];
  autos: string[];
  colormap: string;
  adjustments: Record<Adjustment, string>;
  palette?: { rows: PaletteRow[]; ramp: string; note: string };
}
/** The panel of the mode not shown, kept while the image is open. */
const modeStates: Partial<Record<Mode, PanelState>> = {};
let currentMode: Mode = 'rgb';
let panelFilled = false;
let rows: ChannelRow[] = [];
let lastExpression: HTMLInputElement | undefined;
let editTimer: ReturnType<typeof setTimeout> | undefined;

for (const name of COLORMAP_NAMES) {
  for (const value of [name, `${name}_r`]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === name ? name : `${name} (reversed)`;
    colormapSelect.append(option);
  }
}

// --- Which raster the panel edits: the opened image, or a raster layer (Layers panel) ---

/** The selected raster layer; undefined: the opened image. */
let target: RasterLayer | undefined;
const renderingLayer = $<HTMLSelectElement>('renderingLayer');
const rasterView = $<HTMLDivElement>('rasterRendering');
const vectorView = $<HTMLDivElement>('vectorRendering');
/** The vector layer shown in the Rendering panel (its vector view), if one is. */
let vectorChoice: number | undefined;
/** The basemap shown in the Rendering panel (its basemap view), if one is. */
let basemapChoice: number | undefined;
const basemapView = $<HTMLDivElement>('basemapRendering');

/** Everything the panel holds for one raster, kept while another one is edited. */
interface RenderState {
  selection: Selection;
  editing: Preset;
  modeStates: Partial<Record<Mode, PanelState>>;
  currentMode: Mode;
  panelFilled: boolean;
  panel?: PanelState;
}
/** The opened image's state while a layer is edited. */
let imageRenderState: RenderState | undefined;

function targetPage(): PageInfo | undefined {
  return target ? target.page : currentPage();
}

function targetName(): string {
  return target ? target.name : fileName;
}

function postToTarget(message: MainToWorker): void {
  if (target) target.post(message);
  else postToWorker(message);
}

function saveRenderState(): RenderState {
  return { selection, editing, modeStates: { ...modeStates }, currentMode, panelFilled, panel: panelFilled ? captureState() : undefined };
}

function loadRenderState(state: RenderState | undefined, page: PageInfo, name: string): void {
  for (const key of Object.keys(modeStates) as Mode[]) delete modeStates[key];
  if (!state || !state.panelFilled || !state.panel) {
    // A raster not edited yet: its own starting point (a matching preset, or its colours).
    panelFilled = false;
    applySelection(state?.selection ?? initialSelection(page, name, false), false);
    return;
  }
  Object.assign(modeStates, state.modeStates);
  selection = state.selection;
  editing = state.editing;
  setMode(state.currentMode);
  restoreState(state.panel);
  renderVariables(editing.variables);
  panelFilled = true;
  updatePresetSelect();
  renderBandList();
  showCompositeError(undefined);
}

/** Makes the panel (and its Preset menu) edit `layer`, or the opened image. */
function selectTarget(layer: RasterLayer | undefined): void {
  if (layer === target) return;
  if (classifyRequest) {
    postToTarget({ type: 'cancelClassify', reqId: classifyRequest });
    endClassify();
  }
  clearTimeout(editTimer);
  const state = saveRenderState();
  if (target) target.renderState = state;
  else imageRenderState = state;
  target = layer;
  layers.markSelected(layer);
  const page = targetPage();
  updateRenderingTarget();
  renderReadout();
  if (!page) return;
  loadRenderState(layer ? (layer.renderState as RenderState | undefined) : imageRenderState, page, targetName());
  if (!layer) imageRenderState = undefined;
}

function choiceValue(choice: LayerChoice): string {
  return choice.kind === 'image' ? 'image' : choice.kind === 'raster' ? `raster:${choice.layer.id}` : `${choice.kind}:${choice.id}`;
}

/**
 * The Rendering panel's layer menu (every layer, top first) and its view: the
 * raster view for the selected raster, or the vector view for a vector layer.
 * The Preset menu, the Info panel and the status bar follow the selected raster.
 */
function updateRenderingTarget(): void {
  const choices = layers.layerChoices();
  if (vectorChoice !== undefined && !choices.some((c) => c.kind === 'vector' && c.id === vectorChoice)) vectorChoice = undefined;
  if (basemapChoice !== undefined && !choices.some((c) => c.kind === 'basemap' && c.id === basemapChoice)) basemapChoice = undefined;
  const page = targetPage();
  const rasters = choices.filter((c) => c.kind === 'image' || c.kind === 'raster');
  renderingLayer.replaceChildren(
    ...choices.map((c) => Object.assign(document.createElement('option'), { value: choiceValue(c), textContent: c.kind === 'raster' ? c.layer.name : c.name })),
  );
  renderingLayer.value =
    vectorChoice !== undefined ? `vector:${vectorChoice}` : basemapChoice !== undefined ? `basemap:${basemapChoice}` : target ? `raster:${target.id}` : page ? 'image' : '';
  const vector = vectorChoice !== undefined;
  const basemap = basemapChoice !== undefined;
  layers.markShown(vector ? { kind: 'vector', id: vectorChoice! } : basemap ? { kind: 'basemap', id: basemapChoice! } : undefined);
  rasterView.hidden = vector || basemap || !page || !!page.unsupported;
  vectorView.hidden = !vector;
  basemapView.hidden = !basemap;
  if (vector) fillVectorView();
  if (basemap) fillBasemapView();
  presetGroup.title = target ? `Rendering preset of ${target.name}` : 'Rendering preset';
  // Presets are rasters' (the raster view only).
  presetGroup.hidden = !page || !!page.unsupported || vector || basemap;
  compositeToggle.hidden = !choices.length || (choices.length === rasters.length && (!page || !!page.unsupported));
  if (compositeToggle.hidden) showComposite(false);
  statusSize.textContent = page ? `${page.width} × ${page.height}` : '';
  renderInfo();
}

function fillVectorView(): void {
  const style = vectorChoice !== undefined ? layers.vectorStyle(vectorChoice) : undefined;
  if (!style) return;
  $<HTMLInputElement>('vectorColor').value = style.color;
  $<HTMLInputElement>('vectorWidth').value = String(style.width);
  $<HTMLInputElement>('vectorFill').value = String(Math.round(style.fill * 100));
  $<HTMLInputElement>('vectorFillValue').value = String(Math.round(style.fill * 100));
  $('vectorInfo').textContent = style.summary;
}

/** The basemap view: its name, and its language and region where the provider has them. */
function fillBasemapView(): void {
  const info = basemapChoice !== undefined ? layers.basemapInfo(basemapChoice) : undefined;
  if (!info) return;
  $('basemapInfo').textContent = info.attribution;
  $('basemapLanguageRow').hidden = !info.language;
  $('basemapRegionRow').hidden = !info.region;
  $('basemapNoLocalization').hidden = info.language || info.region;
  $<HTMLSelectElement>('basemapLanguage').value = info.localization.language;
  $<HTMLSelectElement>('basemapRegion').value = info.localization.region;
}

{
  const option = (value: string, text: string) => Object.assign(document.createElement('option'), { value, textContent: text });
  $('basemapLanguage').append(option('', 'Default'), ...LANGUAGES.map(([code, name]) => option(code, name)));
  $('basemapRegion').append(option('', 'Default'), ...REGIONS.map(([code, name]) => option(code, name)));
  for (const [id, key] of [['basemapLanguage', 'language'], ['basemapRegion', 'region']] as const) {
    $(id).addEventListener('change', (e) => {
      if (basemapChoice !== undefined) layers.setBasemapLocalization(basemapChoice, { [key]: (e.target as HTMLSelectElement).value });
    });
  }
}

/** Opens the Rendering panel on a basemap (its basemap view). */
function openBasemapRendering(id: number, open = true): void {
  vectorChoice = undefined;
  basemapChoice = id;
  updateRenderingTarget();
  if (open) showComposite(true);
}

/** Opens the Rendering panel on a vector layer (its vector view). */
function openVectorRendering(id: number, open = true): void {
  basemapChoice = undefined;
  vectorChoice = id;
  updateRenderingTarget();
  if (open) showComposite(true);
}

/** Opens the Rendering panel on a raster (undefined: the opened file's). */
function openRendering(layer: RasterLayer | undefined, open = true): void {
  vectorChoice = undefined;
  basemapChoice = undefined;
  selectTarget(layer);
  updateRenderingTarget();
  if (open) showComposite(true);
}

renderingLayer.addEventListener('change', () => {
  const value = renderingLayer.value;
  if (value.startsWith('vector:')) return openVectorRendering(Number(value.slice(7)));
  if (value.startsWith('basemap:')) return openBasemapRendering(Number(value.slice(8)));
  const layer = value.startsWith('raster:') ? layers.rasters().find((l) => l.id === Number(value.slice(7))) : undefined;
  openRendering(layer);
});
$('vectorColor').addEventListener('input', (e) => vectorChoice !== undefined && layers.setVectorStyle(vectorChoice, { color: (e.target as HTMLInputElement).value }));
$('vectorWidth').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  if (vectorChoice !== undefined && Number.isFinite(v) && v > 0) layers.setVectorStyle(vectorChoice, { width: Math.min(20, v) });
});
for (const [id, other] of [['vectorFill', 'vectorFillValue'], ['vectorFillValue', 'vectorFill']]) {
  $(id).addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (vectorChoice === undefined || !Number.isFinite(v)) return;
    const clamped = Math.min(100, Math.max(0, v));
    $<HTMLInputElement>(other).value = String(clamped);
    layers.setVectorStyle(vectorChoice, { fill: clamped / 100 });
  });
}
// Double-click the fill slider: back to the default (25%).
$('vectorFill').addEventListener('dblclick', () => {
  $<HTMLInputElement>('vectorFill').value = '25';
  $('vectorFill').dispatchEvent(new Event('input'));
});

/** A raster layer was added: render it with a matching preset (or its colours), and edit it. */
function rasterAdded(layer: RasterLayer): void {
  const page = layer.page!;
  const initial = initialSelection(page, layer.name, false);
  layer.renderState = { selection: initial, editing: { name: '' }, modeStates: {}, currentMode: 'rgb', panelFilled: false } satisfies RenderState;
  layer.setComposite(compositeFor(initial, page));
  selectTarget(layer);
}

function rasterRemoved(layer: RasterLayer): void {
  if (target !== layer) return;
  // The next raster takes its place in the panel (the opened file's, or the top one).
  const choices = layers.rasterChoices();
  const next = choices.find((c) => c.kind === 'image') ?? choices[0];
  selectTarget(next?.kind === 'raster' ? next.layer : undefined);
  if (!next) target = undefined;
}

/** Presets changed: re-resolve the rasters not in the panel (the panel's is re-applied by the caller). */
function refreshOtherRenderings(): void {
  const image = currentPage();
  if (target && image && imageRenderState) setImageComposite(compositeFor(imageRenderState.selection, image));
  for (const layer of layers.rasters()) {
    if (layer === target || !layer.page) continue;
    const state = layer.renderState as RenderState | undefined;
    if (state) layer.setComposite(compositeFor(state.selection, layer.page));
  }
}

function findPreset(name: string): Preset | undefined {
  return userPresets.find((p) => p.name === name);
}

function initialSelection(page: PageInfo, name: string, useRemembered = true): Selection {
  // Unsaved composites last only while the image is open; presets and the plain image are remembered.
  if (useRemembered && (remembered?.kind === 'none' || (remembered?.kind === 'preset' && findPreset(remembered.name)))) {
    return remembered;
  }
  const match = userPresets.find((p) => presetMatches(p, name, page.samplesPerPixel));
  return match ? { kind: 'preset', name: match.name } : { kind: 'none' };
}

/** A starting point for a new composite: the first three bands, or the first band, by their names in the file. */
function defaultPreset(page: PageInfo): Preset {
  const name = (i: number) => {
    const description = page.bandNames[i];
    return (description && bandIdentifierOf(description)) || `b${i + 1}`;
  };
  return page.samplesPerPixel >= 3
    ? { name: '', red: name(0), green: name(1), blue: name(2), range: 'auto' }
    : { name: '', value: name(0), range: 'auto', colormap: 'gray' };
}

/** Shows `next` (a preset, an unsaved composite or the plain image) and fills the editor with it. */
function applySelection(next: Selection, remember: boolean): void {
  const page = targetPage();
  if (!page) return;
  let preset: Preset | undefined;
  if (next.kind === 'preset') {
    preset = findPreset(next.name);
    if (!preset) next = { kind: 'none' };
  } else if (next.kind === 'custom') {
    preset = next.preset;
  }
  selection = next;
  if (preset || !panelFilled) {
    // Choosing the plain image keeps the panel as it is, so that custom settings stay at hand.
    editing = structuredClone(preset ?? defaultPreset(page));
    fillEditor();
  }
  updatePresetSelect();
  // What is shown is remembered for the opened image (by the extension host), not for added layers.
  if (remember && !target) {
    vscode.postMessage({ type: 'remember', selection });
  }
  if (!preset) {
    setComposite(undefined);
    showCompositeError(undefined);
    return;
  }
  const spec = compositeSpec(preset, page.samplesPerPixel, page.bandNames);
  const error = validate(spec);
  if (error) {
    // Show the plain image, and why the preset does not apply.
    setComposite(undefined);
    showCompositeError(error.message, error.index, variableField(error.variable));
    showComposite(true);
  } else {
    showCompositeError(undefined);
    setComposite(spec);
  }
}

function validate(spec: CompositeSpec): { message: string; index?: number; variable?: string } | undefined {
  try {
    compileExpressions(spec.expressions, spec.bands, spec.variables);
    return undefined;
  } catch (error) {
    const { index, variable } = error as ExpressionError;
    const where =
      variable !== undefined
        ? `Variable '${variable}': `
        : spec.expressions.length === 3 && index !== undefined
          ? `${['Red', 'Green', 'Blue'][index]}: `
          : '';
    return { message: where + (error instanceof ExpressionError ? error.message : String(error)), index, variable };
  }
}

/** Renders the raster the panel edits (the opened image, or the selected layer) with `spec`. */
function setComposite(spec: CompositeSpec | undefined): void {
  if (target) target.setComposite(spec);
  else setImageComposite(spec);
}

/** The composite a selection gives on `page`, or undefined (the plain image, or one that does not apply). */
function compositeFor(selected: Selection, page: PageInfo): CompositeSpec | undefined {
  const preset = selected.kind === 'preset' ? findPreset(selected.name) : selected.kind === 'custom' ? selected.preset : undefined;
  if (!preset) return undefined;
  const spec = compositeSpec(preset, page.samplesPerPixel, page.bandNames);
  return validate(spec) ? undefined : spec;
}

function setImageComposite(spec: CompositeSpec | undefined): void {
  if (JSON.stringify(spec ?? null) === JSON.stringify(composite ?? null)) {
    return;
  }
  composite = spec;
  // Like a tone change: keep the tiles on screen until replaced.
  generation++;
  requested = new Map();
  lastRequest = '';
  failed.clear();
  draw();
  scheduleTiles(0);
}

function updatePresetSelect(): void {
  const options: HTMLElement[] = [];
  const option = (value: string, text: string) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  const fallback = option('none', 'Default');
  // What the file itself describes: its RGB or palette colours, or its first band in grey.
  fallback.title = "The file's own rendering: RGB and palette images in their colours, other images' first band in grey";
  options.push(fallback);
  if (userPresets.length) {
    const group = document.createElement('optgroup');
    group.label = 'Presets';
    group.append(...userPresets.map((p) => option(`preset:${p.name}`, p.name)));
    options.push(group);
  }
  if (selection.kind === 'custom') {
    options.push(option('custom', editing.name ? `${editing.name} (modified)` : 'Custom'));
  }
  presetSelect.replaceChildren(...options);
  presetSelect.value = selection.kind === 'preset' ? `preset:${selection.name}` : selection.kind;
  const saved = selection.kind === 'preset';
  deleteButton.disabled = !saved;
  deleteButton.title = saved ? `Delete "${(selection as { name: string }).name}" from the presets file` : 'Select a saved preset to delete it';
}

function checkedMode(): Mode {
  return compositePanel.querySelector<HTMLInputElement>('input[name="mode"]:checked')!.value as Mode;
}

const AUTO_LABELS: [AutoStretch, string][] = [
  ['minmax', 'Min / Max'],
  ['percentile', '2% / 98%'],
  ['full', 'Full range'],
];

/** Writes `editing` into the editor fields (the panel of its mode; the other mode's panel is kept). */
function fillEditor(): void {
  const expressions = presetExpressions(editing);
  const ranges = presetRanges(editing, expressions.length);
  const mode: Mode = presetMode(editing);
  if (panelFilled && mode !== currentMode) modeStates[currentMode] = captureState();
  setMode(mode);
  if (mode === 'paletted') {
    setPalette(presetClasses(editing).map((c) => ({ value: c.value, rgba: c.rgba, label: c.label })), editing.colorRamp ?? RANDOM_RAMP, '');
  }
  rows.forEach((row, i) => {
    const range = ranges[i];
    row.expression.value = expressions[i];
    row.min.value = Array.isArray(range) ? String(range[0]) : '';
    row.max.value = Array.isArray(range) ? String(range[1]) : '';
    row.auto.value = Array.isArray(range) ? 'minmax' : range;
  });
  updateAutoRows();
  colormapSelect.value = COLORMAP_NAMES.includes((editing.colormap ?? 'gray').replace(/_r$/, '')) ? (editing.colormap ?? 'gray') : 'gray';
  for (const name of ADJUSTMENT_NAMES) setAdjustment(name, presetAdjustment(editing, name));
  renderVariables(editing.variables);
  panelFilled = true;
  renderBandList();
}

/** Shows the panel of a mode with empty rows. */
function setMode(mode: Mode): void {
  currentMode = mode;
  compositePanel.querySelector<HTMLInputElement>(`input[name="mode"][value="${mode}"]`)!.checked = true;
  buildRows(mode);
  colormapRow.hidden = mode !== 'single';
  paletteBox.hidden = mode !== 'paletted';
  rangeHint.hidden = mode === 'paletted';
  channelsBox.classList.toggle('paletted', mode === 'paletted');
}

function captureState(): PanelState {
  return {
    expressions: rows.map((row) => row.expression.value),
    mins: rows.map((row) => row.min.value),
    maxs: rows.map((row) => row.max.value),
    autos: rows.map((row) => row.auto.value),
    colormap: colormapSelect.value,
    adjustments: Object.fromEntries(ADJUSTMENT_NAMES.map((name) => [name, adjustmentInputs[name].number.value])) as Record<Adjustment, string>,
    palette: currentMode === 'paletted' ? { rows: paletteRows.map((r) => ({ ...r, rgba: [...r.rgba] as RGBA })), ramp: paletteRamp.value, note: paletteNoteText } : undefined,
  };
}

function restoreState(state: PanelState): void {
  rows.forEach((row, i) => {
    row.expression.value = state.expressions[i] ?? '';
    row.min.value = state.mins[i] ?? '';
    row.max.value = state.maxs[i] ?? '';
    row.auto.value = state.autos[i] ?? 'minmax';
  });
  updateAutoRows();
  colormapSelect.value = state.colormap;
  for (const name of ADJUSTMENT_NAMES) {
    adjustmentInputs[name].number.value = state.adjustments[name];
    syncSlider(name);
  }
  if (state.palette) setPalette(state.palette.rows, state.palette.ramp, state.palette.note);
}

/** A mode's panel the first time it is shown: the file's first bands, stretched automatically (Min / Max). */
function defaultState(mode: Mode, page: PageInfo): PanelState {
  const preset = defaultPreset(page);
  const names = presetExpressions(preset);
  const expressions = mode === 'rgb' ? [names[0], names[1] ?? names[0], names[2] ?? names[0]] : [names[0]];
  // As in QGIS, a paletted rendering starts from the image's own colour table when it has one.
  const fromLayer = page.palette ? limitClasses(layerClasses(page.palette), "The image's colour table") : { rows: [], note: '' };
  const palette = mode === 'paletted' ? { rows: fromLayer.rows, ramp: RANDOM_RAMP, note: fromLayer.note } : undefined;
  return {
    palette,
    expressions,
    mins: expressions.map(() => ''),
    maxs: expressions.map(() => ''),
    autos: expressions.map(() => 'minmax'),
    colormap: 'gray',
    adjustments: Object.fromEntries(ADJUSTMENT_NAMES.map((name) => [name, formatAdjustment(name, ADJUSTMENTS[name].default)])) as Record<Adjustment, string>,
  };
}

function buildRows(mode: Mode): void {
  const labels =
    mode === 'rgb'
      ? [['R', 'r', 'Red'], ['G', 'g', 'Green'], ['B', 'b', 'Blue']]
      : mode === 'paletted'
        ? [['V', '', 'Band (or expression) whose values are listed']]
        : [['V', '', 'Value']];
  channelsBox.querySelectorAll('.row-cell').forEach((cell) => cell.remove());
  const fullAvailable = targetPage()?.sampleFormat !== 'Floating point';
  rows = labels.map(([short, cls, long]) => {
    const label = document.createElement('span');
    label.className = `row-cell channel-label ${cls}`;
    label.textContent = short;
    label.title = long;
    const input = (type: string, className: string, placeholder: string, title: string) => {
      const el = document.createElement('input');
      el.type = type;
      el.className = `row-cell ${className}`;
      el.placeholder = placeholder;
      el.title = title;
      el.spellcheck = false;
      el.setAttribute('aria-label', title);
      el.addEventListener('input', () => onEdit());
      return el;
    };
    const autoRow = document.createElement('div');
    autoRow.className = 'row-cell auto-row';
    const autoLabel = document.createElement('span');
    autoLabel.textContent = 'auto =';
    const auto = document.createElement('select');
    auto.setAttribute('aria-label', `${long}: automatic stretch`);
    for (const [value, text] of AUTO_LABELS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (value === 'full' && !fullAvailable) {
        option.disabled = true;
        option.title = 'Floating point data has no fixed range';
      }
      auto.append(option);
    }
    auto.title = 'Min / Max: the lowest and highest values of the image. 2% / 98%: ignores the darkest and brightest 2%. Full range: the whole range of the data type (e.g. 0 to 65535).';
    auto.addEventListener('change', () => onEdit(0));
    autoRow.append(autoLabel, auto);
    const row: ChannelRow = {
      expression: input('text', 'expression', 'e.g. B04 / 3000', `${long} expression`),
      min: input('number', 'range', 'auto', `${long}: value shown as black (empty: automatic)`),
      max: input('number', 'range', 'auto', `${long}: value shown at full brightness (empty: automatic)`),
      autoRow,
      auto,
    };
    for (const field of [row.min, row.max]) field.addEventListener('input', updateAutoRows);
    row.expression.addEventListener('focus', () => (lastExpression = row.expression));
    channelsBox.append(label, row.expression, row.min, row.max, autoRow);
    return row;
  });
  lastExpression = rows[0].expression;
}

/** "auto = …" appears under a channel whose min and max are both empty. */
function updateAutoRows(): void {
  for (const row of rows) row.autoRow.hidden = !!(row.min.value.trim() || row.max.value.trim());
}

// --- Brightness, contrast, saturation, gamma: a slider and a number each ---

const ADJUSTMENT_NAMES = Object.keys(ADJUSTMENTS) as Adjustment[];
const ADJUSTMENT_LABELS: Record<Adjustment, [string, string]> = {
  brightness: ['Brightness', 'Added to every colour component, -255 to 255 (as in QGIS)'],
  contrast: ['Contrast', 'Spreads colours away from (or towards) mid-grey, -100 to 100 (as in QGIS)'],
  saturation: ['Saturation', 'Colour intensity, -100 (grey) to 100 (as in QGIS)'],
  gamma: ['Gamma', 'Above 1 brightens dark tones, below 1 darkens them, 0.1 to 10 (as in QGIS)'],
};
const adjustmentInputs = {} as Record<Adjustment, { slider: HTMLInputElement; number: HTMLInputElement }>;

/** Gamma's slider is logarithmic (0.1 … 1 … 10 evenly spaced); the others are linear. */
const toSlider = (name: Adjustment, value: number) => (name === 'gamma' ? Math.round(Math.log10(value) * 100) : value);
const fromSlider = (name: Adjustment, position: number) => (name === 'gamma' ? Number((10 ** (position / 100)).toFixed(2)) : position);
const formatAdjustment = (name: Adjustment, value: number) => (name === 'gamma' ? String(Number(value.toFixed(2))) : String(Math.round(value)));

for (const name of ADJUSTMENT_NAMES) {
  const { min, max, default: fallback } = ADJUSTMENTS[name];
  const [text, title] = ADJUSTMENT_LABELS[name];
  const label = document.createElement('label');
  label.textContent = text;
  label.title = title;
  label.htmlFor = `adjust-${name}`;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(toSlider(name, min));
  slider.max = String(toSlider(name, max));
  slider.step = '1';
  slider.title = title;
  slider.setAttribute('aria-label', text);
  const number = document.createElement('input');
  number.type = 'number';
  number.id = `adjust-${name}`;
  number.min = String(min);
  number.max = String(max);
  number.step = name === 'gamma' ? '0.05' : '1';
  number.title = title;
  slider.addEventListener('input', () => {
    number.value = formatAdjustment(name, fromSlider(name, Number(slider.value)));
    onEdit(120);
  });
  number.addEventListener('input', () => {
    syncSlider(name);
    onEdit();
  });
  // Double-click a slider to reset it.
  slider.addEventListener('dblclick', () => {
    setAdjustment(name, fallback);
    onEdit(0);
  });
  adjustmentsBox.append(label, slider, number);
  adjustmentInputs[name] = { slider, number };
}

function setAdjustment(name: Adjustment, value: number): void {
  adjustmentInputs[name].number.value = formatAdjustment(name, value);
  syncSlider(name);
}

function syncSlider(name: Adjustment): void {
  const { slider, number } = adjustmentInputs[name];
  const value = Number(number.value);
  const { min, max } = ADJUSTMENTS[name];
  if (number.value.trim() && Number.isFinite(value)) slider.value = String(toSlider(name, Math.min(max, Math.max(min, value))));
}

$('resetAdjustments').addEventListener('click', () => {
  for (const name of ADJUSTMENT_NAMES) setAdjustment(name, ADJUSTMENTS[name].default);
  onEdit(0);
});

/** Reads the editor fields into a preset, or returns an error message. */
function readEditor(): { preset: Preset } | { error: string; field?: HTMLInputElement } {
  const preset: Preset = { name: editing.name };
  if (editing.bands) preset.bands = editing.bands;
  const variables = readVariables();
  if ('error' in variables) return variables;
  if (variables.variables) preset.variables = variables.variables;
  if (editing.match) preset.match = editing.match;
  const expressions = rows.map((row) => row.expression.value.trim());
  if (currentMode === 'rgb') {
    [preset.red, preset.green, preset.blue] = expressions;
  } else if (currentMode === 'paletted') {
    preset.paletted = expressions[0];
    preset.classes = [...paletteRows]
      .sort((a, b) => a.value - b.value)
      .map((c) => ({ value: c.value, color: toHexColor(c.rgba), ...(c.label ? { label: c.label } : {}) }));
    if (paletteRamp.value !== RANDOM_RAMP) preset.colorRamp = paletteRamp.value;
  } else {
    preset.value = expressions[0];
    preset.colormap = colormapSelect.value;
  }
  const ranges: RangeSetting[] = [];
  for (const row of currentMode === 'paletted' ? [] : rows) {
    const lo = row.min.value.trim();
    const hi = row.max.value.trim();
    if (!lo && !hi) {
      const auto = row.auto.value as AutoStretch;
      ranges.push(auto === 'minmax' ? 'auto' : auto);
    } else if (!lo || !hi || !Number.isFinite(Number(lo)) || !Number.isFinite(Number(hi))) {
      return { error: 'Give both a minimum and a maximum, or leave both empty to stretch automatically.', field: lo ? row.max : row.min };
    } else {
      ranges.push([Number(lo), Number(hi)]);
    }
  }
  const same = ranges.every((r) => JSON.stringify(r) === JSON.stringify(ranges[0]));
  if (currentMode === 'paletted') {
    // Classes have no range.
  } else if (!same) preset.range = ranges;
  else if (JSON.stringify(ranges[0]) !== '[0,1]') preset.range = ranges[0];
  for (const name of ADJUSTMENT_NAMES) {
    const field = adjustmentInputs[name].number;
    const { min, max, default: fallback } = ADJUSTMENTS[name];
    const value = field.value.trim() === '' ? fallback : Number(field.value);
    if (!Number.isFinite(value) || value < min || value > max) {
      return { error: `${ADJUSTMENT_LABELS[name][0]} must be a number from ${min} to ${max}.`, field };
    }
    if (value !== fallback) preset[name] = value;
  }
  return { preset };
}

function renderBandList(): void {
  const page = targetPage();
  if (!page) return;
  const vars = bandVariables(page.samplesPerPixel, page.bandNames, editing.bands);
  const names: string[][] = Array.from({ length: page.samplesPerPixel }, () => []);
  for (const [name, index] of Object.entries(vars)) names[index].push(name);
  // The layer's own bands only (variables have their section).
  bandList.replaceChildren(
    ...names.map((list, i) => {
      // Prefer the file's name for the band (B04, VV), then a preset's, then b4.
      const described = page.bandNames[i] ? list.find((n) => vars[n] === i && n !== `b${i + 1}` && n === bandIdentifierOf(page.bandNames[i]!)) : undefined;
      const primary = described ?? list.find((n) => n !== `b${i + 1}`) ?? `b${i + 1}`;
      const button = document.createElement('button');
      const index = document.createElement('span');
      index.className = 'index';
      index.textContent = String(i + 1);
      button.append(index, primary);
      button.title = `Band ${i + 1}: ${list.join(', ')}`;
      button.addEventListener('click', () => insertBand(primary));
      return button;
    }),
  );
}

// --- Variables: named expressions, computed in order (each can use the ones above it) ---

const variableList = $<HTMLDivElement>('variableList');
const VARIABLE_DRAG = 'application/x-tiff-viewer-variable';

interface VariableRow {
  row: HTMLDivElement;
  name: HTMLInputElement;
  expression: HTMLInputElement;
}

let variableRows: VariableRow[] = [];
let draggedVariable: VariableRow | undefined;

/** Fills the Variables section (in order). */
function renderVariables(variables: Record<string, string> | undefined): void {
  variableRows = [];
  variableList.replaceChildren();
  for (const [name, source] of Object.entries(variables ?? {})) addVariableRow(name, String(source));
}

function addVariableRow(nameValue: string, source: string): VariableRow {
  const row = document.createElement('div');
  row.className = 'variable-row';
  const handle = Object.assign(document.createElement('span'), { className: 'layer-handle', textContent: '⠿', title: 'Drag to change the order (a variable can use the ones above it)' });
  const name = Object.assign(document.createElement('input'), { type: 'text', className: 'variable-name', value: nameValue, placeholder: 'name', spellcheck: false, title: 'Name (letters, digits and _)' });
  name.setAttribute('aria-label', 'Variable name');
  const equals = Object.assign(document.createElement('span'), { className: 'hint', textContent: '=' });
  const expression = Object.assign(document.createElement('input'), { type: 'text', className: 'variable-expression', value: source, placeholder: 'e.g. B08 - B04', spellcheck: false, title: 'Expression' });
  expression.setAttribute('aria-label', `Expression of ${nameValue || 'the variable'}`);
  const insert = Object.assign(document.createElement('button'), { textContent: '↵', title: 'Insert this variable into the expression being edited' });
  const remove = Object.assign(document.createElement('button'), { textContent: '×', title: 'Remove the variable' });
  row.append(handle, name, equals, expression, insert, remove);
  const entry: VariableRow = { row, name, expression };
  for (const field of [name, expression]) field.addEventListener('input', () => onEdit());
  // Bands (and variables) clicked go into the variable's expression when it was edited last.
  expression.addEventListener('focus', () => (lastExpression = expression));
  insert.addEventListener('click', () => name.value.trim() && insertBand(name.value.trim()));
  remove.addEventListener('click', () => {
    variableRows = variableRows.filter((r) => r !== entry);
    row.remove();
    if (lastExpression === expression) lastExpression = rows[0]?.expression;
    onEdit(0);
  });
  // Drag by the handle to reorder.
  handle.addEventListener('pointerdown', () => (row.draggable = true));
  row.addEventListener('dragstart', (e) => {
    draggedVariable = entry;
    e.dataTransfer?.setData(VARIABLE_DRAG, name.value);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    row.draggable = false;
    draggedVariable = undefined;
    row.classList.remove('dragging');
    variableList.querySelectorAll('.drop-above, .drop-below').forEach((el) => el.classList.remove('drop-above', 'drop-below'));
  });
  row.addEventListener('dragover', (e) => {
    if (!draggedVariable || draggedVariable === entry) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const above = e.clientY < r.top + r.height / 2;
    row.classList.toggle('drop-above', above);
    row.classList.toggle('drop-below', !above);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
  row.addEventListener('drop', (e) => {
    const moved = draggedVariable;
    if (!moved || moved === entry) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const above = e.clientY < r.top + r.height / 2;
    variableRows = variableRows.filter((v) => v !== moved);
    variableRows.splice(variableRows.indexOf(entry) + (above ? 0 : 1), 0, moved);
    variableList.replaceChildren(...variableRows.map((v) => v.row));
    onEdit(0);
  });
  variableRows.push(entry);
  variableList.append(row);
  return entry;
}

/** A variable's expression field, to mark it when the variable is wrong. */
function variableField(name: string | undefined): HTMLInputElement | undefined {
  return name === undefined ? undefined : variableRows.find((v) => v.name.value.trim() === name)?.expression;
}

/** The variables as typed, in order; rows left empty are ignored. */
function readVariables(): { variables?: Record<string, string> } | { error: string; field?: HTMLInputElement } {
  const variables: Record<string, string> = {};
  for (const { name, expression } of variableRows) {
    const n = name.value.trim();
    const e = expression.value.trim();
    if (!n && !e) continue;
    if (!n) return { error: 'Give the variable a name.', field: name };
    if (!e) return { error: `Give the variable '${n}' an expression.`, field: expression };
    if (n in variables) return { error: `There are two variables named '${n}'.`, field: name };
    variables[n] = e;
  }
  return Object.keys(variables).length ? { variables } : {};
}

$('variableAdd').addEventListener('click', () => {
  const used = new Set(variableRows.map((v) => v.name.value.trim()));
  let i = 1;
  while (used.has(`v${i}`)) i++;
  const entry = addVariableRow(`v${i}`, '');
  entry.expression.focus();
});

function insertBand(name: string): void {
  const input = lastExpression ?? rows[0]?.expression;
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(name, start, end, 'end');
  input.focus();
  onEdit();
}

// --- Paletted / unique values (QGIS's paletted renderer) ---

const paletteBox = $<HTMLDivElement>('paletteBox');
const rangeHint = $<HTMLParagraphElement>('rangeHint');
const paletteRamp = $<HTMLSelectElement>('paletteRamp');
const paletteBody = document.querySelector<HTMLTableSectionElement>('#paletteTable tbody')!;
const paletteSelectAll = $<HTMLInputElement>('paletteSelectAll');
const paletteNote = $<HTMLParagraphElement>('paletteNote');
const paletteSelected = $<HTMLDivElement>('paletteSelected');
const paletteClassify = $<HTMLButtonElement>('paletteClassify');
const paletteMenu = $<HTMLDivElement>('paletteMenu');
const paletteMore = $<HTMLButtonElement>('paletteMore');

let paletteRows: PaletteRow[] = [];
const paletteSelection = new Set<PaletteRow>();
let paletteNoteText = '';
let classifyRequest = 0;

{
  const option = (value: string, text: string) => Object.assign(document.createElement('option'), { value, textContent: text });
  paletteRamp.append(option(RANDOM_RAMP, 'Random colors'));
  for (const name of COLORMAP_NAMES) paletteRamp.append(option(name, name), option(`${name}_r`, `${name} (reversed)`));
}

/** Classes from a TIFF colour table (16-bit reds, greens, blues), one per index, as QGIS's "Load Classes from Layer". */
function layerClasses(colorMap: number[]): PaletteRow[] {
  const size = Math.floor(colorMap.length / 3);
  return Array.from({ length: size }, (_, i) => ({
    value: i,
    rgba: [Math.round(colorMap[i] / 257), Math.round(colorMap[size + i] / 257), Math.round(colorMap[2 * size + i] / 257), 255] as RGBA,
    label: valueLabel(i),
  }));
}

/** At most MAX_CLASSES classes; the note says when some were dropped. */
function limitClasses(rows: PaletteRow[], source: string): { rows: PaletteRow[]; note: string } {
  if (rows.length <= MAX_CLASSES) return { rows, note: '' };
  return {
    rows: rows.slice(0, MAX_CLASSES),
    note: `${source} has ${rows.length.toLocaleString()} classes; only the first ${MAX_CLASSES} are kept (the limit).`,
  };
}

function setPalette(rows: PaletteRow[], ramp: string, note: string): void {
  paletteRows = rows.slice(0, MAX_CLASSES);
  paletteSelection.clear();
  paletteRamp.value = ramp;
  paletteNoteText = note;
  renderPaletteTable();
}

function cssColor(rgba: RGBA): string {
  return toHexColor([rgba[0], rgba[1], rgba[2], 255]);
}

/** The table, sorted by value as in QGIS. */
function renderPaletteTable(): void {
  paletteRows.sort((a, b) => a.value - b.value);
  paletteBody.replaceChildren(
    ...paletteRows.map((row) => {
      const tr = document.createElement('tr');
      tr.classList.toggle('selected', paletteSelection.has(row));
      const cell = (...children: HTMLElement[]) => {
        const td = document.createElement('td');
        td.append(...children);
        return td;
      };
      const select = Object.assign(document.createElement('input'), { type: 'checkbox', checked: paletteSelection.has(row), title: 'Select' });
      select.addEventListener('change', () => {
        if (select.checked) paletteSelection.add(row);
        else paletteSelection.delete(row);
        tr.classList.toggle('selected', select.checked);
        updatePaletteSelection();
      });
      const value = Object.assign(document.createElement('input'), { type: 'number', step: 'any', value: valueLabel(row.value), title: 'Value' });
      value.addEventListener('change', () => {
        const v = Number(value.value);
        if (value.value.trim() === '' || !Number.isFinite(v)) {
          value.setAttribute('aria-invalid', 'true');
          return;
        }
        value.removeAttribute('aria-invalid');
        if (row.label === valueLabel(row.value)) row.label = valueLabel(v);
        row.value = v;
        renderPaletteTable();
        onEdit(0);
      });
      const color = Object.assign(document.createElement('input'), { type: 'color', value: cssColor(row.rgba), title: 'Colour' });
      color.addEventListener('input', () => {
        const rgba = parseHexColor(color.value);
        if (rgba) row.rgba = [rgba[0], rgba[1], rgba[2], row.rgba[3]];
        onEdit(120);
      });
      const opacity = Object.assign(document.createElement('input'), { type: 'number', min: '0', max: '100', step: '1', value: String(Math.round((row.rgba[3] / 255) * 100)), title: 'Opacity (%)' });
      opacity.addEventListener('input', () => {
        const v = Number(opacity.value);
        if (!Number.isFinite(v)) return;
        row.rgba[3] = Math.round((Math.min(100, Math.max(0, v)) / 100) * 255);
        onEdit();
      });
      const label = Object.assign(document.createElement('input'), { type: 'text', value: row.label, title: 'Label', spellcheck: false });
      label.addEventListener('input', () => {
        row.label = label.value;
        onEdit();
      });
      tr.append(cell(select), cell(value), cell(color), cell(opacity), cell(label));
      return tr;
    }),
  );
  if (!paletteRows.length) {
    paletteNote.textContent = paletteNoteText || 'No classes yet: click Classify to list the values of the band (values not listed are transparent).';
  } else {
    const full = paletteRows.length >= MAX_CLASSES;
    paletteNote.textContent = [
      `${paletteRows.length} class${paletteRows.length === 1 ? '' : 'es'}${full ? ` (the limit is ${MAX_CLASSES})` : ''}.`,
      paletteNoteText,
    ]
      .filter(Boolean)
      .join(' ');
  }
  const add = $('paletteAdd') as HTMLButtonElement;
  add.disabled = paletteRows.length >= MAX_CLASSES;
  add.title = add.disabled ? `At most ${MAX_CLASSES} classes` : 'Add a value';
  updatePaletteSelection();
}

/** "N selected": colour, opacity and label for all of them (QGIS's Change Color… / Opacity… / Label…). */
function updatePaletteSelection(): void {
  for (const row of paletteSelection) if (!paletteRows.includes(row)) paletteSelection.delete(row);
  const count = paletteSelection.size;
  paletteSelected.hidden = count === 0;
  paletteSelectAll.checked = count > 0 && count === paletteRows.length;
  paletteSelectAll.indeterminate = count > 0 && count < paletteRows.length;
  ($('paletteDelete') as HTMLButtonElement).disabled = count === 0;
  if (count === 0) return;
  const first = [...paletteSelection][0];
  $('paletteSelectedCount').textContent = `${count} selected:`;
  ($('paletteSelectedColor') as HTMLInputElement).value = cssColor(first.rgba);
  ($('paletteSelectedOpacity') as HTMLInputElement).value = String(Math.round((first.rgba[3] / 255) * 100));
}

function paletteChanged(): void {
  renderPaletteTable();
  onEdit(0);
}

paletteSelectAll.addEventListener('change', () => {
  paletteSelection.clear();
  if (paletteSelectAll.checked) for (const row of paletteRows) paletteSelection.add(row);
  renderPaletteTable();
});
$('paletteSelectedColor').addEventListener('input', (event) => {
  const rgba = parseHexColor((event.target as HTMLInputElement).value);
  if (!rgba) return;
  for (const row of paletteSelection) row.rgba = [rgba[0], rgba[1], rgba[2], row.rgba[3]];
  renderPaletteTable();
  onEdit(120);
});
$('paletteSelectedOpacity').addEventListener('change', (event) => {
  const v = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(v)) return;
  for (const row of paletteSelection) row.rgba[3] = Math.round((Math.min(100, Math.max(0, v)) / 100) * 255);
  paletteChanged();
});
$('paletteSelectedLabel').addEventListener('change', (event) => {
  const text = (event.target as HTMLInputElement).value;
  for (const row of paletteSelection) row.label = text;
  paletteChanged();
});

// Changing the ramp re-colours every class, as in QGIS.
paletteRamp.addEventListener('change', () => {
  const colors = rampColors(paletteRamp.value, paletteRows.length);
  paletteRows.sort((a, b) => a.value - b.value).forEach((row, i) => (row.rgba = [...colors[i]] as RGBA));
  paletteChanged();
});

// "+": the next whole value after the largest, coloured from the ramp's end (as QGIS).
$('paletteAdd').addEventListener('click', () => {
  const max = paletteRows.reduce((m, r) => Math.max(m, Math.trunc(r.value)), -Infinity);
  const value = Math.max(0, max + 1);
  const ramp = paletteRamp.value;
  const rgba: RGBA = ramp === RANDOM_RAMP ? rampColors(ramp, 1)[0] : (rampColors(ramp, 2)[1] ?? [...DEFAULT_CLASS_COLOR]);
  const row: PaletteRow = { value, rgba: [...rgba] as RGBA, label: valueLabel(value) };
  paletteRows.push(row);
  paletteSelection.clear();
  paletteSelection.add(row);
  paletteChanged();
});
$('paletteDelete').addEventListener('click', () => {
  paletteRows = paletteRows.filter((row) => !paletteSelection.has(row));
  paletteSelection.clear();
  paletteChanged();
});
$('paletteDeleteAll').addEventListener('click', () => {
  paletteRows = [];
  paletteSelection.clear();
  paletteNoteText = '';
  paletteChanged();
});

paletteMore.addEventListener('click', () => {
  paletteMenu.hidden = !paletteMenu.hidden;
  paletteMore.setAttribute('aria-expanded', String(!paletteMenu.hidden));
  ($('paletteLoadLayer') as HTMLButtonElement).disabled = !targetPage()?.palette;
  $('paletteLoadLayer').title = targetPage()?.palette ? "Use the image's own colour table" : 'This image has no colour table';
});
const closeMenu = () => {
  paletteMenu.hidden = true;
  paletteMore.setAttribute('aria-expanded', 'false');
};
$('paletteLoadLayer').addEventListener('click', () => {
  closeMenu();
  const palette = targetPage()?.palette;
  if (!palette) return;
  ({ rows: paletteRows, note: paletteNoteText } = limitClasses(layerClasses(palette), "The image's colour table"));
  paletteSelection.clear();
  paletteChanged();
});
$('paletteLoadFile').addEventListener('click', () => {
  closeMenu();
  vscode.postMessage({ type: 'loadColorMap' });
});
$('paletteExport').addEventListener('click', () => {
  closeMenu();
  const base = targetName().replace(/\.[^.]*$/, '') || 'colormap';
  vscode.postMessage({ type: 'exportColorMap', text: colorMapToString(paletteRows.map((r) => ({ value: r.value, color: r.rgba, label: r.label }))), fileName: `${base}.clr` });
});

/** Colour names in a colour map file ("red", "#ff0000"), read by the browser. */
function parseCssColor(name: string): RGBA | undefined {
  const hex = parseHexColor(name);
  if (hex) return hex;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.fillStyle = '#010203';
  probe.fillStyle = name;
  const resolved = String(probe.fillStyle);
  return resolved === '#010203' && name.toLowerCase() !== '#010203' ? undefined : parseHexColor(resolved);
}

function onColorMapLoaded(text: string, file: string): void {
  const classes = parseColorMap(text, parseCssColor);
  if (!classes.length) {
    showCompositeError(`Could not interpret ${file} as a raster colour table.`);
    return;
  }
  if (currentMode !== 'paletted') return;
  ({ rows: paletteRows, note: paletteNoteText } = limitClasses(
    classes.map((c) => ({ value: c.value, rgba: c.color, label: c.label })),
    file,
  ));
  paletteSelection.clear();
  paletteChanged();
}

// Classify: the band's unique values, keeping the colours and labels of values already listed (as QGIS).
paletteClassify.addEventListener('click', () => {
  if (classifyRequest) {
    postToTarget({ type: 'cancelClassify', reqId: classifyRequest });
    endClassify();
    return;
  }
  const page = targetPage();
  const expression = rows[0]?.expression.value.trim() ?? '';
  if (!page || !expression) return;
  const typed = readVariables();
  if ('error' in typed) {
    showCompositeError(typed.error, undefined, typed.field);
    return;
  }
  const spec = compositeSpec({ name: '', value: expression, variables: typed.variables, bands: editing.bands }, page.samplesPerPixel, page.bandNames);
  const error = validate(spec);
  if (error) {
    showCompositeError(error.message, 0);
    return;
  }
  classifyRequest = ++requestCounter;
  paletteClassify.textContent = 'Cancel';
  paletteClassify.title = 'Stop collecting values';
  paletteNote.textContent = 'Collecting values… 0%';
  postToTarget({ type: 'classify', reqId: classifyRequest, page: target ? 0 : pageIndex, composite: spec });
});

/** Classify progress and results from the worker of the raster the panel edits. */
function onClassifyMessage(message: WorkerToMain): void {
  switch (message.type) {
    case 'classifyProgress':
      if (message.reqId === classifyRequest) paletteNote.textContent = `Collecting values… ${Math.floor(message.fraction * 100)}%`;
      break;
    case 'classified':
      if (message.reqId === classifyRequest) onClassified(message.values, message.truncated);
      break;
    case 'classifyError':
      if (message.reqId === classifyRequest) {
        endClassify();
        showCompositeError(message.message);
      }
      break;
  }
}

function endClassify(): void {
  classifyRequest = 0;
  paletteClassify.textContent = 'Classify';
  paletteClassify.title = "List the band's unique values (keeps the colours and labels of values already listed)";
  renderPaletteTable();
}

function onClassified(values: number[], truncated: boolean): void {
  const colors = rampColors(paletteRamp.value, values.length);
  const existing = new Map(paletteRows.map((row) => [row.value, row]));
  paletteRows = values.map((value, i) => {
    const old = existing.get(value);
    return old ? { value, rgba: old.rgba, label: old.label } : { value, rgba: [...colors[i]] as RGBA, label: valueLabel(value) };
  });
  paletteSelection.clear();
  paletteNoteText = truncated
    ? `The band has more than ${MAX_CLASSES} different values; the first ${MAX_CLASSES} found are listed. For continuous data, Single band suits better.`
    : '';
  endClassify();
  onEdit(0);
}

function showCompositeError(message: string | undefined, index?: number, field?: HTMLInputElement): void {
  compositeError.hidden = !message;
  compositeError.textContent = message ?? '';
  for (const el of compositePanel.querySelectorAll('input')) el.removeAttribute('aria-invalid');
  const invalid = field ?? (index !== undefined ? rows[index]?.expression : undefined);
  invalid?.setAttribute('aria-invalid', 'true');
}

/** Any change in the editor: validate, then show it (debounced) as an unsaved composite. */
function onEdit(delay = 300): void {
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    const page = targetPage();
    if (!page) return;
    const result = readEditor();
    if ('error' in result) {
      showCompositeError(result.error, undefined, result.field);
      return;
    }
    const spec = compositeSpec(result.preset, page.samplesPerPixel, page.bandNames);
    const error = validate(spec);
    if (error) {
      showCompositeError(error.message, error.index, variableField(error.variable));
      return;
    }
    showCompositeError(undefined);
    editing = result.preset;
    selection = { kind: 'custom', preset: result.preset };
    updatePresetSelect();
    setComposite(spec);
  }, delay);
}

function showComposite(show: boolean): void {
  compositePanel.hidden = !show;
  compositeToggle.setAttribute('aria-pressed', String(show));
  if (show) renderBandList();
}

function toggleComposite(): void {
  showComposite(compositePanel.hidden);
}

compositeToggle.addEventListener('click', toggleComposite);
presetSelect.addEventListener('change', () => {
  const value = presetSelect.value;
  if (value === 'custom') return;
  applySelection(value === 'none' ? { kind: 'none' } : { kind: 'preset', name: value.slice('preset:'.length) }, true);
});
for (const radio of compositePanel.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  radio.addEventListener('change', () => {
    // Each mode keeps its own panel while the image is open: switching back restores it.
    const page = targetPage();
    const next = checkedMode();
    if (!page || next === currentMode) return;
    modeStates[currentMode] = captureState();
    setMode(next);
    restoreState(modeStates[next] ?? defaultState(next, page));
    onEdit(0);
  });
}
colormapSelect.addEventListener('change', () => onEdit(0));
$('saveComposite').addEventListener('click', () => {
  const result = readEditor();
  const page = targetPage();
  if ('error' in result || !page) {
    if ('error' in result) showCompositeError(result.error, undefined, result.field);
    return;
  }
  const error = validate(compositeSpec(result.preset, page.samplesPerPixel, page.bandNames));
  if (error) {
    showCompositeError(error.message, error.index, variableField(error.variable));
    return;
  }
  vscode.postMessage({ type: 'savePreset', preset: withUsedBandNames(result.preset, page), bandCount: page.samplesPerPixel, fileName: targetName() });
});

/**
 * Keeps only the preset band names the expressions use and the file does not
 * provide itself, so that a saved preset carries only the band names it needs.
 */
function withUsedBandNames(preset: Preset, page: PageInfo): Preset {
  if (!preset.bands) return preset;
  const sources = [...presetExpressions(preset), ...Object.values(preset.variables ?? {})];
  const used = new Set(sources.flatMap((e) => String(e).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []));
  const fromFile = bandVariables(page.samplesPerPixel, page.bandNames);
  const bands = Object.fromEntries(Object.entries(preset.bands).filter(([name]) => used.has(name) && !(name in fromFile)));
  const { bands: _, ...rest } = preset;
  return Object.keys(bands).length ? { ...rest, bands } : rest;
}
deleteButton.addEventListener('click', () => {
  if (selection.kind === 'preset') vscode.postMessage({ type: 'deletePreset', name: selection.name });
});
$('openSettings').addEventListener('click', (event) => {
  event.preventDefault();
  vscode.postMessage({ type: 'openPresetsFile' });
});

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const layers = new Layers({
  post: (message) => vscode.postMessage(message),
  redraw: () => draw(),
  showWindow,
  // Added rasters decode in their own worker, without helpers (the opened image keeps those).
  createWorker: (onMessage) => createWorker(onMessage, 0),
  rasterAdded,
  rasterRemoved,
  rasterMessage: (layer, message) => {
    if (layer === target) onClassifyMessage(message);
  },
  rasterPixel: () => renderReadout(),
  selectTarget,
  setCrs: (crs) => {
    chosenCrs = crs;
    rebuildGrid();
    fitMode = 'auto';
    layout(0);
  },
  startGrid,
  firstLayer,
  imageRemoved,
  allRemoved,
  layersChanged: () => {
    updateRenderingTarget();
    // Layers came: the "No layers" hint goes.
    if (layers.count && messageBox.textContent === EMPTY_MESSAGE) showMessage(undefined);
    // Bounded again after zooming out over the world: back to the map's extent.
    if (!layers.unbounded && view.scale < minScale() * 0.999) {
      setFit('auto');
      return;
    }
    clampView();
    updateZoomLabel();
    draw();
    scheduleTiles();
  },
  openRendering: (layer) => openRendering(layer),
  openVectorRendering: (id) => openVectorRendering(id),
  openBasemapRendering: (id) => openBasemapRendering(id),
  // Selected without opening the Rendering panel (a click on a layer's ⠿).
  selectLayer: (choice) => {
    if (choice.kind === 'vector') openVectorRendering(choice.id, false);
    else if (choice.kind === 'basemap') openBasemapRendering(choice.id, false);
    else openRendering(choice.kind === 'raster' ? choice.layer : undefined, false);
  },
});

// ---------------------------------------------------------------------------
// Measure, OSM place search, screenshot (the status bar's tools)
// ---------------------------------------------------------------------------

/** Units of the map's coordinate system: metres per unit, or undefined (degrees, unknown units). */
function crsUnits(): { symbol: string; metres: number | undefined } | undefined {
  const geo = grid?.geo;
  if (!geo || !gridMapper) return undefined;
  const def = geo.proj4;
  if (geo.geographic || /\+proj=longlat\b/.test(def)) return { symbol: '°', metres: undefined };
  const toMeter = /\+to_meter=([\d.eE+-]+)/.exec(def);
  if (toMeter) return { symbol: 'map units', metres: Number(toMeter[1]) };
  const units = /\+units=([\w-]+)/.exec(def)?.[1] ?? 'm';
  const known: Record<string, number> = { m: 1, km: 1000, cm: 0.01, ft: 0.3048, 'us-ft': 1200 / 3937, yd: 0.9144, mi: 1609.344 };
  return { symbol: units, metres: known[units] };
}

measureTool = new MeasureTool({
  toLonLat: (gx, gy) => gridMapper?.pixelToLonLat(gx, gy),
  toGrid: (lon, lat) => gridMapper ? gridMapper.lonLatToPixel(lon, lat) : [NaN, NaN],
  toCrs: (gx, gy) => {
    if (!gridMapper || !grid?.geo) return undefined;
    const [x, y] = gridMapper.pixelToCrs(gx, gy);
    return [x * grid.geo.factors.x, y * grid.geo.factors.y];
  },
  crsUnits,
  gridToStage: (gx, gy) => [view.tx + gx * view.scale, view.ty + gy * view.scale],
  redraw: () => draw(),
  activeChanged: (on) => stage.classList.toggle('measuring', on),
});

/** Shows a window of the canvas grid: within the canvas's extent when bounded, wherever it is when unbounded. */
function showWindow(window: PixelWindow): void {
  if (!grid) return;
  const [b0, b1, b2, b3] = layers.unbounded ? [-Infinity, -Infinity, Infinity, Infinity] : grid.bounds;
  const [x0, y0, x1, y1] = [Math.max(b0, window[0]), Math.max(b1, window[1]), Math.min(b2, window[2]), Math.min(b3, window[3])];
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  view.scale = Math.min(maxScale(), Math.max(minScale(), 0.9 * Math.min(stage.clientWidth / w, stage.clientHeight / h)));
  view.tx = stage.clientWidth / 2 - ((x0 + x1) / 2) * view.scale;
  view.ty = stage.clientHeight / 2 - ((y0 + y1) / 2) * view.scale;
  fitMode = undefined;
  layout();
}

/** The canvas grid window covering a lon/lat box (its edges sampled: the grid may be warped). */
function lonLatToWindow(box: [number, number, number, number]): PixelWindow | undefined {
  if (!gridMapper) return undefined;
  const [w, s, e, n] = box;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    for (const [lon, lat] of [[w + (e - w) * t, s], [w + (e - w) * t, n], [w, s + (n - s) * t], [e, s + (n - s) * t]]) {
      const [x, y] = gridMapper.lonLatToPixel(lon, lat);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : undefined;
}

/** The lon/lat box of the bounded map (its outline sampled). */
function boundsLonLat(): [number, number, number, number] | undefined {
  if (!grid || !gridMapper) return undefined;
  const [b0, b1, b2, b3] = grid.bounds;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    for (const [x, y] of [[b0 + (b2 - b0) * t, b1], [b0 + (b2 - b0) * t, b3], [b0, b1 + (b3 - b1) * t], [b2, b1 + (b3 - b1) * t]]) {
      const [lon, lat] = gridMapper.pixelToLonLat(x, y);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      w = Math.min(w, lon); s = Math.min(s, lat); e = Math.max(e, lon); n = Math.max(n, lat);
    }
  }
  return w <= e && s <= n ? [w, s, e, n] : undefined;
}

/** The place found last, marked on the map until Esc or the next search. */
let placeMarker: Place | undefined;

function clearPlaceMarker(): boolean {
  if (!placeMarker) return false;
  placeMarker = undefined;
  draw();
  return true;
}

/** A pin on the place found. */
function drawPlaceMarker(dpr: number): void {
  if (!placeMarker || !gridMapper) return;
  const [gx, gy] = gridMapper.lonLatToPixel(placeMarker.lon, placeMarker.lat);
  const x = view.tx + gx * view.scale;
  const y = view.ty + gy * view.scale;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pin = new Path2D();
  pin.moveTo(x, y);
  pin.bezierCurveTo(x - 2, y - 7, x - 9, y - 11, x - 9, y - 18);
  pin.arc(x, y - 18, 9, Math.PI, 0);
  pin.bezierCurveTo(x + 9, y - 11, x + 2, y - 7, x, y);
  pin.closePath();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 4;
  ctx.fillStyle = '#e31a1c';
  ctx.fill(pin);
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#fff';
  ctx.stroke(pin);
  ctx.beginPath();
  ctx.arc(x, y - 18, 3.5, 0, 2 * Math.PI);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}

placeSearch = new PlaceSearch({
  fetchText: (url) => layers.fetchUrl(url),
  available: () => !!gridMapper,
  limit: () => (layers.unbounded ? undefined : boundsLonLat()),
  inside: (lon, lat) => {
    if (layers.unbounded) return true;
    if (!grid || !gridMapper) return false;
    const [x, y] = gridMapper.lonLatToPixel(lon, lat);
    const [b0, b1, b2, b3] = grid.bounds;
    return x >= b0 && y >= b1 && x <= b2 && y <= b3;
  },
  show: (place) => {
    // The place's extent, at least about 300 m across (a point: about 1 km).
    const half = place.extent ? 150 : 500;
    const dLat = half / 111320;
    const dLon = dLat / Math.max(0.01, Math.cos((place.lat * Math.PI) / 180));
    const [w, s, e, n] = place.extent ?? [place.lon, place.lat, place.lon, place.lat];
    const box: [number, number, number, number] = [Math.min(w, place.lon - dLon), Math.min(s, place.lat - dLat), Math.max(e, place.lon + dLon), Math.max(n, place.lat + dLat)];
    placeMarker = place;
    const window = lonLatToWindow(box);
    if (window) showWindow(window);
    else draw();
  },
});
$('placeSearchToggle').addEventListener('click', () => clearPlaceMarker());
placeSearch.updateButton();

/** Saves the view (the map as drawn, with measurements and markers) as a PNG, where the user chooses. */
function takeScreenshot(): void {
  if (!grid || !canvas.width || !canvas.height) return;
  const data = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  const stem = (fileName.replace(/\.[^.]+$/, '') || 'TIFF Viewer VS Code').replace(/[\\/:*?"<>|]/g, '_');
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  vscode.postMessage({ type: 'saveScreenshot', data, name: `${stem} ${stamp}.png` });
}
$('screenshotButton').addEventListener('click', takeScreenshot);

// ---------------------------------------------------------------------------
// Extension host messages
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  if (layers.onHostMessage(message)) return;
  switch (message.type) {
    case 'init':
      fileName = message.fileName;
      userPresets = message.presets;
      remembered = message.remembered;
      if (placeSearch) placeSearch.language = message.placeLanguage || 'en';
      if (message.blank) startBlank();
      else if (message.vector) startVector(message.vector, message.fileSize);
      else void start(message.fileSize);
      break;
    case 'placeLanguage':
      if (placeSearch) placeSearch.language = message.language || 'en';
      break;
    case 'colorMapLoaded':
      onColorMapLoaded(message.text, message.fileName);
      break;
    case 'presets':
      userPresets = message.presets;
      if (targetPage()) {
        applySelection(message.select ? { kind: 'preset', name: message.select } : selection, !!message.select);
      }
      refreshOtherRenderings();
      break;
    case 'reload':
      // The file changed on disk: show it again, unless its layer was removed.
      if (!imageGone && !vectorFile && !blank) void start(message.fileSize);
      break;
    case 'readResult': {
      const buffers = message.data.map(toBytes).map((chunk) =>
        chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
          ? (chunk.buffer as ArrayBuffer)
          : (chunk.slice().buffer as ArrayBuffer),
      );
      postToWorker({ type: 'readResult', id: message.id, data: buffers }, buffers);
      break;
    }
    case 'readError':
      postToWorker({ type: 'readError', id: message.id, message: message.message });
      break;
  }
});

vscode.postMessage({ type: 'ready' });
