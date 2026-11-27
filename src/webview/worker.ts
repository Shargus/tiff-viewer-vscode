import type { CompositeSpec } from '../shared/presets';
import type { ByteRange, MainToWorker, TileSpec, ToneMode, WorkerToMain } from '../shared/protocol';
import { channelRanges, channelStats, compileComposite, compositeKey, compositeSamples, compositeToRGBA, needsStats, type ChannelStats } from './composite';
import type { Range } from '../shared/presets';
import { MAX_CLASSES } from '../shared/palette';
import { DecodePool, serveDecodes } from './decodePool';
import { MessageSource } from './messageSource';
import {
  CancelledError,
  chooseLevel,
  computeStats,
  readStatsSample,
  registerDecoders,
  setDecodePool,
  openTiff,
  readPixel,
  readRegion,
  toRGBA,
  toneRange,
  type OpenedTiff,
  type RegionResult,
} from './tiff';

const scope = self as unknown as {
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
};

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

// ---------------------------------------------------------------------------
// Byte access through the webview / extension host
// ---------------------------------------------------------------------------

let nextReadId = 1;
const pendingReads = new Map<number, { resolve: (data: ArrayBuffer[]) => void; reject: (error: Error) => void }>();

function requestBytes(ranges: ByteRange[]): Promise<ArrayBuffer[]> {
  const id = nextReadId++;
  return new Promise((resolve, reject) => {
    pendingReads.set(id, { resolve, reject });
    post({ type: 'read', id, ranges });
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let opened: Promise<OpenedTiff> | undefined;

type TilesMessage = Extract<MainToWorker, { type: 'tiles' }>;

interface Job {
  generation: number;
  page: number;
  tone: ToneMode;
  composite?: CompositeSpec;
  spec: TileSpec;
  cancelled: boolean;
  /** Set while the tile is not wanted; the job waits before its next batch. */
  paused: boolean;
  resume?: () => void;
}

/** Display tiles rendered at the same time (tile decodes are limited separately). */
const CONCURRENCY = 6;
/** Unwanted tiles kept half-done, in case the view comes back (e.g. zooming out again). */
const MAX_PAUSED = 8;
/** Show a partial tile after this long, then at most this often. */
const FIRST_SNAPSHOT_MS = 600;
const SNAPSHOT_INTERVAL_MS = 1500;

let wanted: TilesMessage | undefined;
/** Position of each wanted tile in the list: its urgency. */
let rank = new Map<string, number>();
let queue: TileSpec[] = [];
const running = new Map<string, Job>();
const paused = new Map<string, Job>();

/** Decoded samples of recently rendered tiles, so that changing the tone only re-maps colours. */
const rawCache = new Map<string, RegionResult>();
let rawCacheBytes = 0;
const RAW_CACHE_BYTES = 128 * 1024 * 1024;

function rawKey(page: number, spec: TileSpec, samples: number[]): string {
  return `${page}|${samples.join(',')}|${spec.window.join(',')}|${spec.outWidth}x${spec.outHeight}`;
}

function rawGet(key: string): RegionResult | undefined {
  const value = rawCache.get(key);
  if (value) {
    rawCache.delete(key);
    rawCache.set(key, value);
  }
  return value;
}

function rawPut(key: string, value: RegionResult): void {
  const bytes = value.data.reduce((sum, band) => sum + (band as Uint8Array).byteLength, 0);
  if (bytes > RAW_CACHE_BYTES / 4 || rawCache.has(key)) {
    return;
  }
  rawCache.set(key, value);
  rawCacheBytes += bytes;
  for (const [oldKey, old] of rawCache) {
    if (rawCacheBytes <= RAW_CACHE_BYTES) break;
    rawCache.delete(oldKey);
    rawCacheBytes -= old.data.reduce((sum, band) => sum + (band as Uint8Array).byteLength, 0);
  }
}

function cancel(job: Job): void {
  job.cancelled = true;
  job.resume?.();
}

function setWanted(message: TilesMessage): void {
  const changed = !wanted || wanted.generation !== message.generation;
  wanted = message;
  rank = new Map(message.tiles.map((t, i) => [t.id, i]));
  for (const job of [...running.values()]) {
    if (changed) {
      cancel(job);
      running.delete(job.spec.id);
    } else if (!rank.has(job.spec.id)) {
      // Keep the work done so far; resume if the tile is wanted again.
      job.paused = true;
      running.delete(job.spec.id);
      paused.set(job.spec.id, job);
    }
  }
  for (const job of [...paused.values()]) {
    if (changed || paused.size > MAX_PAUSED) {
      cancel(job);
      paused.delete(job.spec.id);
    }
  }
  queue = message.tiles.filter((t) => !running.has(t.id));
  pump();
}

function pump(): void {
  while (running.size < CONCURRENCY && queue.length && wanted) {
    const spec = queue.shift()!;
    const halfDone = paused.get(spec.id);
    if (halfDone) {
      paused.delete(spec.id);
      halfDone.paused = false;
      running.set(spec.id, halfDone);
      halfDone.resume?.();
      continue;
    }
    const job: Job = {
      generation: wanted.generation,
      page: wanted.page,
      tone: wanted.tone,
      composite: wanted.composite,
      spec,
      cancelled: false,
      paused: false,
    };
    running.set(spec.id, job);
    void renderTile(job)
      .catch((error: unknown) => {
        if (!(error instanceof CancelledError) && !job.cancelled) {
          post({ type: 'tileError', generation: job.generation, id: spec.id, message: errorMessage(error) });
        }
      })
      .finally(() => {
        if (running.get(spec.id) === job) {
          running.delete(spec.id);
        }
        if (paused.get(spec.id) === job) {
          paused.delete(spec.id);
        }
        pump();
      });
  }
}

const statsReady = new Map<number, Promise<void>>();

/**
 * Contrast stretching needs statistics of the whole page, not of each tile,
 * so that tiles match. They come from an overview or a sample of tiles.
 */
function ensureStats(tiff: OpenedTiff, index: number): Promise<void> {
  const page = tiff.pages[index];
  if (!page.info.toneAdjustable || page.stats) {
    return Promise.resolve();
  }
  let ready = statsReady.get(index);
  if (!ready) {
    ready = readStatsSample(page).then((data) => {
      page.stats = computeStats(page, data);
    });
    ready.catch(() => statsReady.delete(index));
    statsReady.set(index, ready);
  }
  return ready;
}

const compositeStats = new Map<string, Promise<ChannelStats[]>>();

/** Per-channel statistics of a composite over the whole page, when a range is stretched automatically. */
function ensureCompositeStats(tiff: OpenedTiff, index: number, composite: CompositeSpec): Promise<ChannelStats[] | undefined> {
  if (!needsStats(composite)) {
    return Promise.resolve(undefined);
  }
  // Statistics depend on the expressions only, not on how their values are shown.
  const key = `${index}|${expressionsKey(composite)}`;
  let ready = compositeStats.get(key);
  if (!ready) {
    const page = tiff.pages[index];
    const compiled = compileComposite(composite);
    ready = readStatsSample(page, compositeSamples(compiled)).then((data) =>
      channelStats(compiled.evaluate(data, data[0]?.length ?? 0, page.info.noData)),
    );
    ready.catch(() => compositeStats.delete(key));
    compositeStats.set(key, ready);
  }
  return ready;
}

function expressionsKey(composite: CompositeSpec): string {
  return JSON.stringify([composite.expressions, composite.bands, composite.variables]);
}

/** The data type's range, for "full range" stretches (none for floating point data). */
function typeRange(page: OpenedTiff['pages'][number]): Range | undefined {
  if (page.format === 1) return [0, 2 ** page.bits - 1];
  if (page.format === 2) return [-(2 ** (page.bits - 1)), 2 ** (page.bits - 1) - 1];
  return undefined;
}

/**
 * Evaluated composite channels of recently rendered tiles, so that changing
 * how they are shown (ranges, colour map, brightness, contrast, saturation,
 * gamma) only re-colours them.
 */
const channelCache = new Map<string, Float32Array[]>();
let channelCacheBytes = 0;
const CHANNEL_CACHE_BYTES = 128 * 1024 * 1024;

function channelGet(key: string): Float32Array[] | undefined {
  const value = channelCache.get(key);
  if (value) {
    channelCache.delete(key);
    channelCache.set(key, value);
  }
  return value;
}

function channelPut(key: string, value: Float32Array[]): void {
  const bytes = value.reduce((sum, channel) => sum + channel.byteLength, 0);
  if (bytes > CHANNEL_CACHE_BYTES / 4 || channelCache.has(key)) return;
  channelCache.set(key, value);
  channelCacheBytes += bytes;
  for (const [oldKey, old] of channelCache) {
    if (channelCacheBytes <= CHANNEL_CACHE_BYTES) break;
    channelCache.delete(oldKey);
    channelCacheBytes -= old.reduce((sum, channel) => sum + channel.byteLength, 0);
  }
}

/** The 'ranges' key of a plain (greyscale) page, followed by its index and tone. */
const PLAIN_RANGES = 'plain';
/** Composites whose ranges were sent (see 'ranges'). */
const rangesSent = new Set<string>();

async function renderTile(job: Job): Promise<void> {
  const { spec, generation } = job;
  const tiff = await opened!;
  const page = tiff.pages[job.page];
  if (!page) {
    throw new Error(`Page ${job.page + 1} does not exist.`);
  }
  if (page.info.unsupported) {
    throw new Error(page.info.unsupported);
  }
  const { composite } = job;
  const compiled = composite && compileComposite(composite);
  const samples = compiled ? compositeSamples(compiled) : page.samples;
  const stats = composite ? await ensureCompositeStats(tiff, job.page, composite) : await ensureStats(tiff, job.page);
  const { outWidth, outHeight } = spec;
  const fullRange = typeRange(page);
  // The ranges shown, once per composite: the legend's values.
  if (composite) {
    const key = compositeKey(composite);
    if (!rangesSent.has(key)) {
      rangesSent.add(key);
      post({ type: 'ranges', key, ranges: channelRanges(composite, stats || undefined, fullRange) });
    }
  } else if (page.kind === 'gray') {
    // A plain single band image: shown in grey from the low end of its stretch (black) to the high end.
    const key = `${PLAIN_RANGES}|${job.page}|${job.tone}`;
    if (!rangesSent.has(key)) {
      rangesSent.add(key);
      post({ type: 'ranges', key, ranges: [toneRange(page, job.tone, page.stats)], inverted: page.whiteIsZero });
    }
  }
  const post_ = (rgba: Uint8ClampedArray, final: boolean) =>
    post(
      { type: 'tile', generation, id: spec.id, width: outWidth, height: outHeight, rgba: rgba.buffer as ArrayBuffer, final },
      [rgba.buffer as ArrayBuffer],
    );
  const colourChannels = (channels: Float32Array[], n: number, final: boolean) => {
    if (job.cancelled) throw new CancelledError();
    post_(compositeToRGBA(composite!, channels, n, stats || undefined, fullRange, new Uint8ClampedArray(outWidth * outHeight * 4)), final);
  };
  const send = (data: RegionResult['data'], rows: number, final: boolean) => {
    if (job.cancelled) {
      throw new CancelledError();
    }
    const n = rows * outWidth;
    if (composite && compiled) {
      colourChannels(compiled.evaluate(data, n, page.info.noData), n, final);
    } else {
      post_(toRGBA(page, data, n, job.tone, new Uint8ClampedArray(outWidth * outHeight * 4)), final);
    }
  };

  // Class values are taken as they are (an average of classes means nothing).
  const nearest = !!composite?.classes;
  const key = rawKey(job.page, spec, samples) + (nearest ? '|nearest' : '');
  const channelKey = composite ? `${key}|${expressionsKey(composite)}` : '';
  if (composite && compiled) {
    const channels = channelGet(channelKey);
    if (channels) {
      colourChannels(channels, outWidth * outHeight, true);
      return;
    }
  }
  let region = rawGet(key);
  if (!region) {
    const { image, window } = chooseLevel(page, spec.window, outWidth);
    let lastProgress = 0;
    let lastSnapshot = Date.now() - SNAPSHOT_INTERVAL_MS + FIRST_SNAPSHOT_MS;
    region = await readRegion(page, image, window, outWidth, outHeight, {
      samples,
      nearest,
      isCancelled: () => job.cancelled,
      waitTurn: () =>
        job.paused && !job.cancelled
          ? new Promise<void>((resolve) => {
              job.resume = resolve;
            })
          : undefined,
      priority: () => rank.get(spec.id) ?? Infinity,
      onProgress: (done, total) => {
        const now = Date.now();
        if (done === total || now - lastProgress > 200) {
          lastProgress = now;
          post({ type: 'progress', generation, id: spec.id, done, total });
        }
      },
      onRows: (rows, snapshot) => {
        const now = Date.now();
        if (rows >= outHeight || now - lastSnapshot < SNAPSHOT_INTERVAL_MS) return;
        lastSnapshot = now;
        send(snapshot(), rows, false);
      },
    });
    rawPut(key, region);
  }
  if (composite && compiled) {
    const channels = compiled.evaluate(region.data, outWidth * outHeight, page.info.noData);
    channelPut(channelKey, channels);
    colourChannels(channels, outWidth * outHeight, true);
  } else {
    send(region.data, outHeight, true);
  }
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const unknownCompression = /Unknown compression method identifier: (\d+)/.exec(text);
  if (unknownCompression) {
    return `Compression method ${unknownCompression[1]} is not supported.`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Classify: the unique values of an expression over the whole page (as QGIS's paletted renderer)
// ---------------------------------------------------------------------------

/** Rows read at a time: about this many pixels. */
const CLASSIFY_CHUNK_PIXELS = 4 * 1024 * 1024;
let classifying: { reqId: number; cancelled: boolean } | undefined;

async function classify(message: Extract<MainToWorker, { type: 'classify' }>): Promise<void> {
  if (classifying) classifying.cancelled = true;
  const run = { reqId: message.reqId, cancelled: false };
  classifying = run;
  try {
    const tiff = await opened!;
    const page = tiff.pages[message.page];
    const compiled = compileComposite(message.composite);
    const samples = compositeSamples(compiled);
    const image = page.images[0];
    const { width, height, noData } = page.info;
    const rows = Math.max(1, Math.min(height, Math.floor(CLASSIFY_CHUNK_PIXELS / width)));
    const values = new Set<number>();
    let truncated = false;
    let lastProgress = 0;
    for (let y0 = 0; y0 < height && !truncated; y0 += rows) {
      if (run.cancelled) return;
      const y1 = Math.min(height, y0 + rows);
      const region = await readRegion(page, image, [0, y0, width, y1], width, y1 - y0, {
        samples,
        isCancelled: () => run.cancelled,
        // After the tiles in view.
        priority: () => 1e9,
      });
      const channel = compiled.evaluate(region.data, width * (y1 - y0), noData)[0];
      for (let i = 0; i < channel.length; i++) {
        const v = channel[i];
        if (v !== v || values.has(v)) continue;
        if (values.size >= MAX_CLASSES) {
          truncated = true;
          break;
        }
        values.add(v);
      }
      const now = Date.now();
      if (now - lastProgress > 150) {
        lastProgress = now;
        post({ type: 'classifyProgress', reqId: run.reqId, fraction: y1 / height });
      }
    }
    if (run.cancelled) return;
    post({ type: 'classified', reqId: run.reqId, values: [...values].sort((a, b) => a - b), truncated });
  } catch (error) {
    if (!(error instanceof CancelledError) && !run.cancelled) {
      post({ type: 'classifyError', reqId: run.reqId, message: errorMessage(error) });
    }
  } finally {
    if (classifying === run) classifying = undefined;
  }
}

// ---------------------------------------------------------------------------
// Pixel value readout (one request in flight, newest wins)
// ---------------------------------------------------------------------------

let pixelBusy = false;
let pixelNext: Extract<MainToWorker, { type: 'pixel' }> | undefined;

async function handlePixel(message: Extract<MainToWorker, { type: 'pixel' }>): Promise<void> {
  if (pixelBusy) {
    pixelNext = message;
    return;
  }
  pixelBusy = true;
  try {
    const tiff = await opened!;
    const page = tiff.pages[message.page];
    const values = page && !page.info.unsupported ? await readPixel(page, message.x, message.y) : null;
    let computed: number[] | undefined;
    if (values && message.composite) {
      const compiled = compileComposite(message.composite);
      computed = compiled.evaluate(compositeSamples(compiled).map((s) => [values[s]]), 1, page.info.noData).map((v) => v[0]);
    }
    post({ type: 'pixel', reqId: message.reqId, x: message.x, y: message.y, values, computed });
  } catch {
    post({ type: 'pixel', reqId: message.reqId, x: message.x, y: message.y, values: null });
  } finally {
    pixelBusy = false;
    const next = pixelNext;
    pixelNext = undefined;
    if (next) {
      void handlePixel(next);
    }
  }
}

// ---------------------------------------------------------------------------

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'decoders':
      setDecodePool(new DecodePool(message.ports as MessagePort[]));
      break;
    case 'helper':
      serveDecodes(message.port as MessagePort, registerDecoders);
      break;
    case 'open': {
      const source = new MessageSource(message.fileSize, requestBytes);
      opened = openTiff(source);
      opened.then(
        (tiff) => post({ type: 'opened', info: tiff.info }),
        (error) => post({ type: 'openError', message: errorMessage(error) }),
      );
      break;
    }
    case 'readResult':
      pendingReads.get(message.id)?.resolve(message.data);
      pendingReads.delete(message.id);
      break;
    case 'readError':
      pendingReads.get(message.id)?.reject(new Error(message.message));
      pendingReads.delete(message.id);
      break;
    case 'tiles':
      setWanted(message);
      break;
    case 'pixel':
      void handlePixel(message);
      break;
    case 'classify':
      void classify(message);
      break;
    case 'cancelClassify':
      if (classifying?.reqId === message.reqId) classifying.cancelled = true;
      break;
  }
};
