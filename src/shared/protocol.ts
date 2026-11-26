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

/** How a georeferenced image maps onto the Earth. */
export interface GeoInfo {
  /** GDAL geotransform: x = t0 + t1·col + t2·row, y = t3 + t4·col + t5·row (pixel corners, CRS units). */
  transform: [number, number, number, number, number, number];
  /** The coordinate system as a proj4 definition. */
  proj4: string;
  /** Multipliers taking CRS coordinates to the units proj4 expects (e.g. feet → metres). */
  factors: { x: number; y: number };
  /** e.g. "EPSG:32618 (WGS 84 / UTM zone 18N)". */
  crsName: string;
  geographic: boolean;
}

/** A file read for an overlay: its name and bytes (a shapefile comes with its .dbf, .prj, .cpg). */
export interface OverlayFile {
  name: string;
  data: Uint8Array;
}

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
      /** The file is a vector file (its URI): it is the viewer's first layer. */
      vector?: string;
    }
  | { type: 'presets'; presets: Preset[]; select?: string }
  | { type: 'colorMapLoaded'; text: string; fileName: string }
  /** Answer to 'fetch': the body as bytes or text, or why it failed. */
  | { type: 'fetched'; id: number; ok: boolean; status: number; bytes?: Uint8Array; text?: string; contentType?: string; error?: string }
  /** Answer to 'readOverlay'. */
  | { type: 'overlayRead'; id: number; ok: boolean; path: string; name: string; files?: OverlayFile[]; error?: string }
  /** Answer to 'browseLayers': the chosen paths (relative to the workspace folder when inside it). */
  | { type: 'layersBrowsed'; paths: string[] }
  /** Answer to 'openRaster': the file is open for 'read' with `file: id`. */
  | { type: 'rasterOpened'; id: number; ok: boolean; name: string; fileSize?: number; error?: string }
  /** Answer to 'chooseLayers': the indexes picked, or none when cancelled. */
  | { type: 'layersChosen'; id: number; indexes: number[] }
  /** Answers to 'read'; `file` is the raster layer's id, absent for the opened image. */
  | { type: 'readResult'; id: number; file?: number; data: Uint8Array[] }
  | { type: 'readError'; id: number; file?: number; message: string }
  | { type: 'reload'; fileSize: number };

export type WebviewToHost =
  | { type: 'ready' }
  /** Reads bytes of the opened image, or of raster layer `file`. */
  | { type: 'read'; id: number; file?: number; ranges: ByteRange[] }
  /** Asks for a name (and auto-apply rule) and stores the preset in the presets file. */
  | { type: 'savePreset'; preset: Preset; bandCount: number; fileName?: string }
  | { type: 'deletePreset'; name: string }
  | { type: 'remember'; selection: Selection }
  | { type: 'openPresetsFile' }
  /** Asks for a colour map file (QGIS format) to load; answered with 'colorMapLoaded'. */
  | { type: 'loadColorMap' }
  /** Asks where to save a colour map file, and writes `text` there. */
  | { type: 'exportColorMap'; text: string; fileName: string }
  /** Fetches an http(s) URL through the extension host (map tiles, styles, capabilities). */
  | { type: 'fetch'; id: number; url: string; as: 'bytes' | 'text' }
  /** Reads a vector file for a layer; `path` is absolute, relative to the workspace folder, or a URI. */
  | { type: 'readOverlay'; id: number; path: string }
  /** Asks the user to pick layer files (raster or vector); answered with 'layersBrowsed'. */
  | { type: 'browseLayers' }
  /** Opens a TIFF as raster layer `id`: a path (absolute or relative to the workspace folder) or a URI; answered with 'rasterOpened'. */
  | { type: 'openRaster'; id: number; path: string }
  | { type: 'closeRaster'; id: number }
  /** Asks which layers of a multi-layer vector file to load; answered with 'layersChosen'. */
  | { type: 'chooseLayers'; id: number; file: string; layers: { name: string; count: number }[] };

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
  /** Georeferencing, when the image has it (needed for overlays). */
  geo?: GeoInfo;
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
