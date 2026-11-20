/**
 * Message types exchanged between the extension host, the webview UI and the
 * decoder worker that runs inside the webview.
 *
 *   extension host  <-- postMessage -->  webview (main.ts)  <-- postMessage -->  worker.ts
 *
 * The worker never touches the file directly: it asks for byte ranges, the
 * webview relays the request to the extension host, which reads the file.
 */

import type { CompositeSpec, Preset } from './presets';

export interface ByteRange {
  offset: number;
  length: number;
}

/** [x0, y0, x1, y1] in pixels, x1/y1 exclusive. */
export type PixelWindow = [number, number, number, number];

export type ToneMode = 'minmax' | 'percentile' | 'full';

// ---------------------------------------------------------------------------
// Extension host <-> webview
// ---------------------------------------------------------------------------

/** What the viewer shows for a file: the plain image, a saved preset, or an unsaved composite. */
export type Selection = { kind: 'none' } | { kind: 'preset'; name: string } | { kind: 'custom'; preset: Preset };

export type HostToWebview =
  | {
      type: 'init';
      fileName: string;
      fileSize: number;
      /** User presets from the presets file. */
      presets: Preset[];
      /** Last selection for this file, if any. */
      remembered?: Selection;
    }
  | { type: 'presets'; presets: Preset[]; select?: string }
  | { type: 'colorMapLoaded'; text: string; fileName: string }
  | { type: 'readResult'; id: number; data: Uint8Array[] }
  | { type: 'readError'; id: number; message: string }
  | { type: 'reload'; fileSize: number };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'read'; id: number; ranges: ByteRange[] }
  /** Asks for a name (and auto-apply rule) and stores the preset in the presets file. */
  | { type: 'savePreset'; preset: Preset; bandCount: number }
  | { type: 'deletePreset'; name: string }
  | { type: 'remember'; selection: Selection }
  | { type: 'openPresetsFile' }
  /** Asks for a colour map file (QGIS format) to load; answered with 'colorMapLoaded'. */
  | { type: 'loadColorMap' }
  /** Asks where to save a colour map file, and writes `text` there. */
  | { type: 'exportColorMap'; text: string; fileName: string };

// ---------------------------------------------------------------------------
// Webview <-> worker
// ---------------------------------------------------------------------------

export interface LevelInfo {
  /** IFD index inside the file. */
  ifd: number;
  width: number;
  height: number;
  /** Size of a tile, or width × rows per strip. */
  tileWidth: number;
  tileHeight: number;
}

export interface PageInfo {
  /** IFD index inside the file. */
  ifd: number;
  width: number;
  height: number;
  samplesPerPixel: number;
  bitsPerSample: number[];
  sampleFormat: string;
  photometric: string;
  compression: string;
  planar: string;
  layout: string;
  hasAlpha: boolean;
  noData: number | null;
  /** Full resolution first, then reduced-resolution overviews (largest first). */
  levels: LevelInfo[];
  /** Whether the tone (contrast stretch) selector is meaningful for this page. */
  toneAdjustable: boolean;
  /** Whether "full range" makes sense (integer data). */
  fullRangeAvailable: boolean;
  /** Label of each sample, e.g. R, G, B, A, or the band description. */
  sampleLabels: string[];
  /** Band descriptions from GDAL metadata (e.g. "B04", "VV"), null where absent. */
  bandNames: (string | null)[];
  /** A short summary for the info panel (resolution, predictor, GeoTIFF). */
  tags: [string, string][];
  /** Every TIFF tag of the image: "Name (id)" or "Tag id", and its value. */
  allTags: [string, string][];
  /** Items of GDAL's metadata tag (dataset items, then "Band N: item"). */
  metadata: [string, string][];
  /** GeoTIFF keys by name. */
  geoKeys: [string, string][];
  /** The image's colour table (TIFF ColorMap: all reds, then greens, then blues, 16-bit), for palette images. */
  palette?: number[];
  /** Decoding problem detected up front (e.g. unsupported compression). */
  unsupported?: string;
}

export interface FileInfo {
  bigTiff: boolean;
  littleEndian: boolean;
  fileSize: number;
  ifdCount: number;
  pages: PageInfo[];
}

/** One display tile: `window` (full-resolution pixels) rendered at outWidth × outHeight. */
export interface TileSpec {
  id: string;
  window: PixelWindow;
  outWidth: number;
  outHeight: number;
}

/** A DOM MessagePort (this file is also compiled for the extension host, without DOM types). */
export type Port = { postMessage(message: unknown, transfer?: unknown[]): void };

export type MainToWorker =
  /** Ports to helper workers that decode tiles in parallel (see decodePool.ts). */
  | { type: 'decoders'; ports: Port[] }
  /** Turns this worker into a decode helper serving requests on `port`. */
  | { type: 'helper'; port: Port }
  | { type: 'open'; fileSize: number }
  | { type: 'readResult'; id: number; data: ArrayBuffer[] }
  | { type: 'readError'; id: number; message: string }
  | {
      /**
       * The display tiles wanted now, most urgent first. Replaces the previous
       * list: tiles no longer listed are abandoned. `generation` changes when
       * the page or tone changes, which invalidates everything rendered before.
       */
      type: 'tiles';
      generation: number;
      page: number;
      tone: ToneMode;
      /** Band composite to render instead of the image's own colours. */
      composite?: CompositeSpec;
      tiles: TileSpec[];
    }
  | { type: 'pixel'; reqId: number; page: number; x: number; y: number; composite?: CompositeSpec }
  /** Collects the unique values of a composite's (single) expression over the whole page. */
  | { type: 'classify'; reqId: number; page: number; composite: CompositeSpec }
  | { type: 'cancelClassify'; reqId: number };

export type WorkerToMain =
  | { type: 'read'; id: number; ranges: ByteRange[] }
  | { type: 'opened'; info: FileInfo }
  | { type: 'openError'; message: string }
  | { type: 'progress'; generation: number; id: string; done: number; total: number }
  | {
      type: 'tile';
      generation: number;
      id: string;
      width: number;
      height: number;
      rgba: ArrayBuffer;
      /** False for a partial result (rows not decoded yet are transparent). */
      final: boolean;
    }
  | { type: 'tileError'; generation: number; id: string; message: string }
  | {
      type: 'pixel';
      reqId: number;
      x: number;
      y: number;
      values: number[] | null;
      /** Values of the composite's expressions at the pixel. */
      computed?: number[];
    }
  | { type: 'classifyProgress'; reqId: number; fraction: number }
  /** Unique values, sorted; `truncated` when there were more than MAX_CLASSES. */
  | { type: 'classified'; reqId: number; values: number[]; truncated: boolean }
  | { type: 'classifyError'; reqId: number; message: string };
