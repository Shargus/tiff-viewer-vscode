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
import { toBytes } from './bytes';
import { Overlays } from './overlays';
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
const progress = $<HTMLDivElement>('progress');
const progressBar = $<HTMLDivElement>('progressBar');
const messageBox = $<HTMLDivElement>('message');
const statusSize = $<HTMLSpanElement>('statusSize');
const statusProgress = $<HTMLSpanElement>('statusProgress');
const statusFileSize = $<HTMLSpanElement>('statusFileSize');
const statusPos = $<HTMLSpanElement>('statusPos');
const statusValue = $<HTMLSpanElement>('statusValue');

interface DisplayTile {
  z: number;
  window: PixelWindow;
  bitmap: ImageBitmap;
  final: boolean;
  /** Tiles of an older generation (before a tone change) are shown until replaced. */
  generation: number;
  used: number;
}

let worker: Worker | undefined;
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
let pixelReq = 0;
/** Dimensions of the page last shown, to keep the view across file reloads. */
let shownSize = '';

function currentPage(): PageInfo | undefined {
  return info?.pages[pageIndex];
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

async function createWorker(): Promise<Worker> {
  // Webview resources are cross-origin for Worker(), so start it from a blob URL.
  const response = await fetch(window.TIFF_WORKER_URL);
  const code = await response.text();
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const w = new Worker(url);
  w.onmessage = (event: MessageEvent<WorkerToMain>) => void onWorkerMessage(event.data);
  w.onerror = (event) => showMessage(`Decoder error: ${event.message}`);
  // Same script, started as decode helpers, each connected to the decoder worker by a channel.
  const ports: MessagePort[] = [];
  try {
    for (let i = 0; i < HELPER_COUNT; i++) {
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
    worker = await createWorker();
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
    case 'pixel':
      if (message.reqId === pixelReq) {
        statusValue.textContent = formatValues(message.values, message.computed);
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

  if (!selectionResolved) {
    selectionResolved = true;
    applySelection(initialSelection(page), false);
  } else {
    // The band count may differ between pages; resolve the composite again.
    applySelection(selection, false);
  }
  presetGroup.hidden = !!page.unsupported;
  compositeToggle.hidden = !!page.unsupported;

  statusSize.textContent = `${page.width} × ${page.height}`;
  renderInfo();
  overlays.setPage(page);

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
  const z = Math.min(top, Math.max(0, Math.floor(Math.log2(1 / (view.scale * devicePixelRatio)))));
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
  const page = currentPage();
  if (!page) {
    return 1;
  }
  return Math.min(stage.clientWidth / page.width, stage.clientHeight / page.height);
}

function minScale(): number {
  return Math.min(fitScale() * 0.5, 1);
}

function maxScale(): number {
  return Math.max(MAX_ZOOM, fitScale() * 4);
}

function clampView(): void {
  const page = currentPage();
  if (!page) {
    return;
  }
  const clampAxis = (offset: number, size: number, viewport: number) =>
    size <= viewport ? (viewport - size) / 2 : Math.min(0, Math.max(viewport - size, offset));
  view.tx = clampAxis(view.tx, page.width * view.scale, stage.clientWidth);
  view.ty = clampAxis(view.ty, page.height * view.scale, stage.clientHeight);
}

function layout(delay?: number): void {
  if (fitMode) {
    const s = fitScale();
    view.scale = fitMode === 'auto' ? Math.min(1, s) : s;
  }
  clampView();
  updateZoomLabel();
  draw();
  scheduleTiles(delay);
}

function zoomTo(scale: number, anchorX = stage.clientWidth / 2, anchorY = stage.clientHeight / 2): void {
  if (!currentPage()) {
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
  zoomLabel.textContent = currentPage() ? `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%` : '–';
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

/** The image on its own layer, when overlays go under it or it is see-through. */
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
  if (!page) {
    return;
  }
  const visible = visibleWindow(page);
  if (!visible) {
    return;
  }
  const viewState = { scale: view.scale, tx: view.tx, ty: view.ty, dpr, width: stage.clientWidth, height: stage.clientHeight };
  const layered = overlays.layered;
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
  if (hasTransparency(page) || layered) {
    const [x0, y0, x1, y1] = deviceRect(page, [0, 0, page.width, page.height]);
    ctx.fillStyle = checkerPattern();
    ctx.fillRect(Math.max(0, x0), Math.max(0, y0), Math.min(width, x1) - Math.max(0, x0), Math.min(height, y1) - Math.max(0, y0));
  }
  overlays.drawBasemap(ctx, viewState, 'below');
  // The image: straight onto the canvas, or onto its own layer to go over the basemap / be see-through.
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
  for (const tile of shown) {
    tile.used = ++drawCounter;
    drawTile(target, page, tile, width, height, !layered);
  }
  if (layered && imageLayer) {
    ctx.globalAlpha = overlays.imageOpacity;
    ctx.drawImage(imageLayer, 0, 0);
    ctx.globalAlpha = 1;
  }
  overlays.drawBasemap(ctx, viewState, 'above');
  overlays.drawTop(ctx, viewState);
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

function drawTile(ctx: CanvasRenderingContext2D, page: PageInfo, tile: DisplayTile, width: number, height: number, checker: boolean): void {
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

function formatValues(values: number[] | null, computed?: number[]): string {
  const page = currentPage();
  if (!values || !page) {
    return '';
  }
  // NoData values (and composite values computed from them) are labelled as such.
  const show = (v: number) => (page.noData !== null && v === page.noData ? 'NoData' : formatNumber(v));
  let text =
    values.length === 1
      ? `${page.sampleLabels[0]}: ${show(values[0])}`
      : values.map((v, i) => `${page.sampleLabels[i] ?? `S${i}`} ${show(v)}`).join('  ');
  if (computed?.length) {
    const labels = computed.length === 3 ? ['R', 'G', 'B'] : [''];
    const classes = composite?.classes;
    const result = (v: number) => {
      if (Number.isNaN(v)) return 'NoData';
      if (!classes) return formatNumber(v);
      const match = classes.find((c) => Math.fround(c.value) === Math.fround(v));
      return match ? `${formatNumber(v)}${match.label && match.label !== formatNumber(v) ? ` (${match.label})` : ''}` : `${formatNumber(v)} (no class)`;
    };
    text = `${computed.map((v, i) => `${labels[i]}${labels[i] ? ' ' : ''}${result(v)}`).join('  ')}   ←   ${text}`;
  }
  return text;
}

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
  const page = currentPage();
  if (!info || !page) {
    infoPanel.replaceChildren();
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
  infoPanel.replaceChildren(
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

let drag: { x: number; y: number; id: number } | undefined;

function stagePoint(event: MouseEvent): [number, number] {
  const rect = stage.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

stage.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const lineScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    if (event.ctrlKey || event.metaKey) {
      const [x, y] = stagePoint(event);
      const delta = Math.max(-100, Math.min(100, event.deltaY * lineScale));
      zoomTo(view.scale * Math.exp(-delta * 0.01), x, y);
    } else {
      view.tx -= event.deltaX * lineScale;
      view.ty -= event.deltaY * lineScale;
      clampView();
      draw();
      scheduleTiles();
    }
  },
  { passive: false },
);

stage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.button !== 1) {
    return;
  }
  stage.focus();
  drag = { x: event.clientX, y: event.clientY, id: event.pointerId };
  stage.setPointerCapture(event.pointerId);
  stage.classList.add('dragging');
});

stage.addEventListener('pointermove', (event) => {
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
    drag = undefined;
    stage.classList.remove('dragging');
  }
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('pointerleave', () => {
  statusPos.textContent = '';
  statusValue.textContent = '';
  pixelReq = 0;
});

stage.addEventListener('dblclick', (event) => {
  const [x, y] = stagePoint(event);
  if (Math.abs(view.scale - Math.min(1, fitScale())) < 1e-6 || fitMode) {
    zoomTo(view.scale < 1 ? 1 : view.scale * 2, x, y);
  } else {
    setFit('auto');
  }
});

function updatePointerReadout(event: MouseEvent): void {
  const page = currentPage();
  if (!page || page.unsupported) {
    return;
  }
  const [px, py] = stagePoint(event);
  const x = Math.floor((px - view.tx) / view.scale);
  const y = Math.floor((py - view.ty) / view.scale);
  if (x < 0 || y < 0 || x >= page.width || y >= page.height) {
    statusPos.textContent = '';
    statusValue.textContent = '';
    pixelReq = 0;
    return;
  }
  statusPos.textContent = `x ${x}, y ${y}`;
  pixelReq = ++requestCounter;
  postToWorker({ type: 'pixel', reqId: pixelReq, page: pageIndex, x, y, composite });
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
    case 'i':
    case 'I':
      if (mod) handled = false;
      else toggleInfo();
      break;
    case 'b':
    case 'B':
      if (mod || compositeToggle.hidden) handled = false;
      else toggleComposite();
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

function findPreset(name: string): Preset | undefined {
  return userPresets.find((p) => p.name === name);
}

function initialSelection(page: PageInfo): Selection {
  // Unsaved composites last only while the image is open; presets and the plain image are remembered.
  if (remembered?.kind === 'none' || (remembered?.kind === 'preset' && findPreset(remembered.name))) {
    return remembered;
  }
  const match = userPresets.find((p) => presetMatches(p, fileName, page.samplesPerPixel));
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
  const page = currentPage();
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
  if (remember) {
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
    showCompositeError(error.message, error.index);
    showComposite(true);
  } else {
    showCompositeError(undefined);
    setComposite(spec);
  }
}

function validate(spec: CompositeSpec): { message: string; index?: number } | undefined {
  try {
    compileExpressions(spec.expressions, spec.bands, spec.variables);
    return undefined;
  } catch (error) {
    const { index, variable } = error as ExpressionError;
    const where =
      variable !== undefined
        ? `Variable '${variable}' (in the presets file): `
        : spec.expressions.length === 3 && index !== undefined
          ? `${['Red', 'Green', 'Blue'][index]}: `
          : '';
    return { message: where + (error instanceof ExpressionError ? error.message : String(error)), index };
  }
}

function setComposite(spec: CompositeSpec | undefined): void {
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
  const fullAvailable = currentPage()?.sampleFormat !== 'Floating point';
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
  // Variables are edited in the presets file; keep them.
  if (editing.variables) preset.variables = editing.variables;
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
  const page = currentPage();
  if (!page) return;
  const vars = bandVariables(page.samplesPerPixel, page.bandNames, editing.bands);
  const names: string[][] = Array.from({ length: page.samplesPerPixel }, () => []);
  for (const [name, index] of Object.entries(vars)) names[index].push(name);
  const variableButtons = Object.entries(editing.variables ?? {}).map(([name, source]) => {
    const button = document.createElement('button');
    const tag = document.createElement('span');
    tag.className = 'index';
    tag.textContent = 'var';
    button.append(tag, name);
    button.title = `Variable defined in the preset: ${name} = ${source}`;
    button.addEventListener('click', () => insertBand(name));
    return button;
  });
  bandList.replaceChildren(
    ...variableButtons,
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
  ($('paletteLoadLayer') as HTMLButtonElement).disabled = !currentPage()?.palette;
  $('paletteLoadLayer').title = currentPage()?.palette ? "Use the image's own colour table" : 'This image has no colour table';
});
const closeMenu = () => {
  paletteMenu.hidden = true;
  paletteMore.setAttribute('aria-expanded', 'false');
};
$('paletteLoadLayer').addEventListener('click', () => {
  closeMenu();
  const palette = currentPage()?.palette;
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
  const base = fileName.replace(/\.[^.]*$/, '') || 'colormap';
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
    postToWorker({ type: 'cancelClassify', reqId: classifyRequest });
    endClassify();
    return;
  }
  const page = currentPage();
  const expression = rows[0]?.expression.value.trim() ?? '';
  if (!page || !expression) return;
  const spec = compositeSpec({ name: '', value: expression, variables: editing.variables, bands: editing.bands }, page.samplesPerPixel, page.bandNames);
  const error = validate(spec);
  if (error) {
    showCompositeError(error.message, 0);
    return;
  }
  classifyRequest = ++requestCounter;
  paletteClassify.textContent = 'Cancel';
  paletteClassify.title = 'Stop collecting values';
  paletteNote.textContent = 'Collecting values… 0%';
  postToWorker({ type: 'classify', reqId: classifyRequest, page: pageIndex, composite: spec });
});

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
    const page = currentPage();
    if (!page) return;
    const result = readEditor();
    if ('error' in result) {
      showCompositeError(result.error, undefined, result.field);
      return;
    }
    const spec = compositeSpec(result.preset, page.samplesPerPixel, page.bandNames);
    const error = validate(spec);
    if (error) {
      showCompositeError(error.message, error.index);
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
  if (!compositePanel.hidden) (lastExpression ?? rows[0]?.expression)?.focus();
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
    const page = currentPage();
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
  const page = currentPage();
  if ('error' in result || !page) {
    if ('error' in result) showCompositeError(result.error, undefined, result.field);
    return;
  }
  const error = validate(compositeSpec(result.preset, page.samplesPerPixel, page.bandNames));
  if (error) {
    showCompositeError(error.message, error.index);
    return;
  }
  vscode.postMessage({ type: 'savePreset', preset: withUsedBandNames(result.preset, page), bandCount: page.samplesPerPixel });
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
// Overlays
// ---------------------------------------------------------------------------

const overlays = new Overlays({
  post: (message) => vscode.postMessage(message),
  redraw: () => draw(),
  view: () => ({ scale: view.scale, tx: view.tx, ty: view.ty, dpr: devicePixelRatio, width: stage.clientWidth, height: stage.clientHeight }),
  page: () => currentPage(),
  showWindow: (window) => {
    const page = currentPage();
    if (!page) return;
    const [x0, y0, x1, y1] = [Math.max(0, window[0]), Math.max(0, window[1]), Math.min(page.width, window[2]), Math.min(page.height, window[3])];
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    view.scale = Math.min(maxScale(), Math.max(minScale(), 0.9 * Math.min(stage.clientWidth / w, stage.clientHeight / h)));
    view.tx = stage.clientWidth / 2 - ((x0 + x1) / 2) * view.scale;
    view.ty = stage.clientHeight / 2 - ((y0 + y1) / 2) * view.scale;
    fitMode = undefined;
    layout();
  },
});

// ---------------------------------------------------------------------------
// Extension host messages
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  if (overlays.onHostMessage(message)) return;
  switch (message.type) {
    case 'init':
      fileName = message.fileName;
      userPresets = message.presets;
      remembered = message.remembered;
      void start(message.fileSize);
      break;
    case 'colorMapLoaded':
      onColorMapLoaded(message.text, message.fileName);
      break;
    case 'presets':
      userPresets = message.presets;
      if (currentPage()) {
        applySelection(message.select ? { kind: 'preset', name: message.select } : selection, !!message.select);
      }
      break;
    case 'reload':
      void start(message.fileSize);
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
