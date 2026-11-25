import * as fs from 'fs';
import * as os from 'os';
import * as pathModule from 'path';
import * as vscode from 'vscode';
import { PRESETS_FILE, type PresetStore } from './presetStore';
import type { Preset } from './shared/presets';
import type { ByteRange, HostToWebview, Selection, WebviewToHost } from './shared/protocol';

/** Largest single read served to the webview (protects against corrupt byte counts). */
const MAX_READ_BYTES = 512 * 1024 * 1024;

/**
 * Random access to the bytes of a TIFF file.
 *
 * Local files are read with positional reads so that multi-gigabyte BigTIFFs
 * never have to be loaded into memory. Files on other file systems (virtual
 * workspaces, etc.) are read once through `vscode.workspace.fs`.
 */
class TiffDocument implements vscode.CustomDocument {
  private handle: fs.promises.FileHandle | undefined;
  private bytes: Uint8Array | undefined;
  private opening: Promise<void> | undefined;
  size = 0;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly uri: vscode.Uri) {
    const folder = vscode.Uri.joinPath(uri, '..');
    const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, name));
    const onChange = () => {
      clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => void this.reopen(), 300);
    };
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
  }

  open(): Promise<void> {
    this.opening ??= this.doOpen();
    return this.opening;
  }

  private async doOpen(): Promise<void> {
    if (this.uri.scheme === 'file') {
      this.handle = await fs.promises.open(this.uri.fsPath, 'r');
      this.size = (await this.handle.stat()).size;
    } else {
      this.bytes = await vscode.workspace.fs.readFile(this.uri);
      this.size = this.bytes.byteLength;
    }
  }

  private async reopen(): Promise<void> {
    await this.close();
    try {
      await this.open();
    } catch {
      // The file may be mid-write or deleted; the viewer shows the error on its next read.
    }
    this.onDidChangeEmitter.fire();
  }

  async read(range: ByteRange): Promise<Uint8Array> {
    await this.open();
    const start = Math.max(0, Math.min(range.offset, this.size));
    const length = Math.max(0, Math.min(range.length, this.size - start, MAX_READ_BYTES));
    if (this.bytes) {
      return plainBytes(this.bytes.subarray(start, start + length));
    }
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle!.read(out, done, length - done, start + done);
      if (bytesRead === 0) {
        break;
      }
      done += bytesRead;
    }
    return done === length ? out : out.subarray(0, done);
  }

  private async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    this.bytes = undefined;
    this.opening = undefined;
    await handle?.close().catch(() => undefined);
  }

  dispose(): void {
    clearTimeout(this.changeTimer);
    this.watcher.dispose();
    this.onDidChangeEmitter.dispose();
    void this.close();
  }
}

export class TiffEditorProvider implements vscode.CustomReadonlyEditorProvider<TiffDocument> {
  static readonly viewType = 'tiffViewer.viewer';

  static register(context: vscode.ExtensionContext, presets: PresetStore): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      TiffEditorProvider.viewType,
      new TiffEditorProvider(context.extensionUri, context.workspaceState, presets),
      {
        supportsMultipleEditorsPerDocument: true,
        // Decoding large images is expensive; keep the result when the tab is hidden.
        webviewOptions: { retainContextWhenHidden: true },
      },
    );
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** Remembers the composite shown for each file. */
    private readonly state: vscode.Memento,
    private readonly presets: PresetStore,
  ) {}

  async openCustomDocument(uri: vscode.Uri): Promise<TiffDocument> {
    const document = new TiffDocument(uri);
    await document.open();
    return document;
  }

  async resolveCustomEditor(document: TiffDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    webview.html = this.getHtml(webview);

    const post = (message: HostToWebview) => webview.postMessage(message);
    const fileName = document.uri.path.slice(document.uri.path.lastIndexOf('/') + 1);
    const rememberKey = `selection:${document.uri.toString()}`;

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      webview.onDidReceiveMessage(async (message: WebviewToHost) => {
        switch (message.type) {
          case 'ready':
            await Promise.all([document.open().catch(() => undefined), this.presets.init()]);
            void post({
              type: 'init',
              fileName,
              fileSize: document.size,
              presets: this.presets.get(),
              remembered: this.state.get<Selection>(rememberKey),
            });
            break;
          case 'remember':
            // Only explicit choices are sent, so a choice of the plain image also overrides auto-apply rules.
            void this.state.update(rememberKey, message.selection);
            break;
          case 'savePreset': {
            const name = await savePreset(this.presets, message.preset, message.bandCount, fileName);
            if (name) {
              void post({ type: 'presets', presets: this.presets.get(), select: name });
            }
            break;
          }
          case 'deletePreset':
            await deletePreset(this.presets, message.name);
            break;
          case 'openPresetsFile':
            void this.presets.open();
            break;
          case 'fetch':
            void proxyFetch(message.url, message.as).then((result) => post({ type: 'fetched', id: message.id, ...result }));
            break;
          case 'readOverlay':
            void readOverlay(overlayBase(document.uri), message.path).then((result) => post({ type: 'overlayRead', id: message.id, path: message.path, ...result }));
            break;
          case 'browseOverlay': {
            const folder = overlayBase(document.uri);
            const uris = await vscode.window.showOpenDialog({
              title: 'Add vector layers',
              canSelectMany: true,
              defaultUri: vscode.Uri.joinPath(document.uri, '..'),
              filters: { 'Vector files': VECTOR_EXTENSIONS, 'All files': ['*'] },
            });
            if (uris?.length) {
              const base = folder.path.endsWith('/') ? folder.path : `${folder.path}/`;
              void post({ type: 'overlayBrowsed', paths: uris.map((u) => (u.scheme === folder.scheme && u.path.startsWith(base) ? u.path.slice(base.length) : u.fsPath)) });
            }
            break;
          }
          case 'chooseLayers': {
            const items = message.layers.map((l, index) => ({
              label: l.name,
              description: `${l.count} feature${l.count === 1 ? '' : 's'}`,
              picked: true,
              index,
            }));
            const picked = await vscode.window.showQuickPick(items, {
              title: `Layers in ${message.file}`,
              placeHolder: 'Choose the layers to load',
              canPickMany: true,
              matchOnDescription: true,
            });
            void post({ type: 'layersChosen', id: message.id, indexes: picked?.map((p) => p.index) ?? [] });
            break;
          }
          case 'loadColorMap': {
            const [uri] =
              (await vscode.window.showOpenDialog({
                title: 'Load Colour Map from File',
                canSelectMany: false,
                defaultUri: vscode.Uri.joinPath(document.uri, '..'),
                filters: { 'Colour maps': ['clr', 'txt'], 'All files': ['*'] },
              })) ?? [];
            if (uri) {
              try {
                const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
                void post({ type: 'colorMapLoaded', text, fileName: uri.path.slice(uri.path.lastIndexOf('/') + 1) });
              } catch (error) {
                void vscode.window.showErrorMessage(`Could not read ${uri.fsPath}: ${(error as Error).message ?? error}`);
              }
            }
            break;
          }
          case 'exportColorMap': {
            const uri = await vscode.window.showSaveDialog({
              title: 'Export Colour Map to File',
              defaultUri: vscode.Uri.joinPath(document.uri, '..', message.fileName),
              filters: { 'Colour maps': ['clr'] },
            });
            if (uri) {
              const target = /\.clr$/i.test(uri.path) ? uri : uri.with({ path: `${uri.path}.clr` });
              try {
                await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(message.text + '\n'));
              } catch (error) {
                void vscode.window.showErrorMessage(`Could not write ${target.fsPath}: ${(error as Error).message ?? error}`);
              }
            }
            break;
          }
          case 'read':
            try {
              const data = await Promise.all(message.ranges.map((range) => document.read(range)));
              void post({ type: 'readResult', id: message.id, data });
            } catch (error) {
              void post({ type: 'readError', id: message.id, message: String((error as Error)?.message ?? error) });
            }
            break;
        }
      }),
      document.onDidChange(() => void post({ type: 'reload', fileSize: document.size })),
      // Edits of the presets file, by hand or from another viewer or window.
      this.presets.onDidChange((presets) => void post({ type: 'presets', presets })),
    );
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
  }

  private getHtml(webview: vscode.Webview): string {
    const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...path));
    const nonce = createNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      // The decoder worker is fetched from the extension and started from a blob: URL;
      // the ZSTD and LERC decoders load their WebAssembly from data: URLs.
      `connect-src ${webview.cspSource} data:`,
      `worker-src blob:`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'viewer.css')}">
  <title>TIFF Viewer</title>
</head>
<body>
  <div id="toolbar" role="toolbar">
    <label class="group" id="pageGroup" hidden>
      <span>Page</span>
      <select id="page" title="Page (PageUp / PageDown)"></select>
    </label>
    <div class="group">
      <button id="zoomOut" title="Zoom out (-)" aria-label="Zoom out">&minus;</button>
      <span id="zoomLabel" class="zoom-label">&ndash;</span>
      <button id="zoomIn" title="Zoom in (+)" aria-label="Zoom in">+</button>
      <button id="fit" title="Fit to window (0)">Fit</button>
      <button id="actual" title="Actual size (1)">1:1</button>
    </div>
    <label class="group" id="presetGroup" hidden title="Rendering preset">
      <span>Bands</span>
      <select id="preset"></select>
    </label>
    <button id="compositeToggle" hidden title="Band rendering: RGB, single band or paletted" aria-pressed="false">Rendering</button>
    <button id="overlaysToggle" disabled title="Overlays need a georeferenced image (GeoTIFF)" aria-pressed="false">Overlays</button>
    <span class="spacer"></span>
    <button id="infoToggle" title="Image information" aria-pressed="false">Info</button>
  </div>
  <div id="main">
    <div id="stage" tabindex="0">
      <canvas id="canvas"></canvas>
      <div id="progress" hidden><div id="progressBar"></div></div>
      <div id="message" hidden></div>
      <div id="pixelTip" role="tooltip" hidden></div>
    </div>
    <aside id="composite" class="panel" hidden>
      <h3>Band rendering</h3>
      <div class="mode" role="radiogroup" aria-label="Render type">
        <label><input type="radio" name="mode" value="rgb" checked> RGB</label>
        <label><input type="radio" name="mode" value="single"> Single band</label>
        <label title="Paletted / unique values, as in QGIS: a colour for each value"><input type="radio" name="mode" value="paletted"> Paletted</label>
      </div>
      <div id="channels" class="channels">
        <span></span><span class="col">Expression</span><span class="col col-range">Min</span><span class="col col-range">Max</span>
      </div>
      <div class="field" id="colormapRow" hidden>
        <span>Colour map</span><select id="colormap"></select>
      </div>
      <p class="hint" id="rangeHint">Leave min and max empty to stretch automatically.</p>
      <div id="paletteBox" class="palette" hidden>
        <div class="field">
          <span>Colour ramp</span><select id="paletteRamp" title="Colours given to classes by Classify and +, and to all classes when changed"></select>
        </div>
        <div class="palette-table-wrap">
          <table id="paletteTable">
            <thead><tr>
              <th><input type="checkbox" id="paletteSelectAll" aria-label="Select all classes" title="Select all"></th>
              <th>Value</th><th>Colour</th><th title="Opacity, %">Opacity</th><th>Label</th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <p class="hint" id="paletteNote"></p>
        <div id="paletteSelected" class="palette-selected" hidden>
          <span id="paletteSelectedCount"></span>
          <input type="color" id="paletteSelectedColor" title="Change colour of the selected classes">
          <input type="number" id="paletteSelectedOpacity" min="0" max="100" step="1" title="Change opacity (%) of the selected classes">
          <input type="text" id="paletteSelectedLabel" placeholder="label" title="Change label of the selected classes (Enter)">
        </div>
        <div class="buttons">
          <button id="paletteClassify" title="List the band's unique values (keeps the colours and labels of values already listed)">Classify</button>
          <button id="paletteAdd" title="Add a value">+</button>
          <button id="paletteDelete" title="Delete the selected classes">−</button>
          <button id="paletteDeleteAll" title="Delete all classes">Delete all</button>
          <button id="paletteMore" title="Advanced options" aria-expanded="false">…</button>
        </div>
        <div id="paletteMenu" class="palette-menu" hidden>
          <button id="paletteLoadLayer" title="Use the image's own colour table">Load classes from layer</button>
          <button id="paletteLoadFile">Load colour map from file…</button>
          <button id="paletteExport">Export colour map to file…</button>
        </div>
      </div>
      <h3>Adjustments</h3>
      <div id="adjustments" class="adjustments"></div>
      <div class="buttons"><button id="resetAdjustments" title="Brightness, contrast and saturation 0, gamma 1">Reset adjustments</button></div>
      <div id="compositeError" class="error" role="alert" hidden></div>
      <div class="buttons">
        <button id="saveComposite" title="Save these settings as a preset">Save as preset…</button>
        <button id="deletePreset" title="Delete the selected preset from the presets file">Delete preset</button>
      </div>
      <h3>Bands</h3>
      <p class="hint">Click a band to insert it into the expression being edited.</p>
      <div id="bandList" class="band-list"></div>
      <h3>Expressions</h3>
      <p class="hint">Operators <code>+ - * / ^ %</code>, comparisons <code>&lt; &lt;= &gt; &gt;= == !=</code> (1 or 0),
      <code>abs sqrt exp log log10 log2 pow min max clamp where isnan round floor ceil sin cos tan atan2</code>,
      <code>pi</code>, and <code>nodata</code> (a missing value: transparent; <code>x == nodata</code> tests for it).
      Example: <code>(B08 - B04) / (B08 + B04)</code>.</p>
      <p class="hint"><a href="#" id="openSettings">Open the presets file</a> (<code>~/.tiff-viewer-vscode/presets.jsonc</code>)</p>
    </aside>
    <aside id="overlays" class="panel side-panel" hidden>
      <h3>Overlays</h3>
      <p class="hint" id="overlayCrs"></p>
      <div class="buttons">
        <button id="ticksToggle" aria-pressed="false" title="Coordinate ticks along the image's lower and left borders, a grid at the ticks, and a scale bar (G)">Show coordinates &amp; scale</button>
      </div>
      <div class="field slider-field">
        <span>Image opacity</span><input type="range" id="imageOpacity" min="0" max="100" step="1" value="100" aria-label="Image opacity"><input type="number" id="imageOpacityValue" min="0" max="100" step="1" value="100" aria-label="Image opacity (%)">
      </div>
      <h3>Basemap</h3>
      <div class="field">
        <span>Provider</span><select id="basemapProvider"></select>
      </div>
      <div class="field" id="basemapItemRow" hidden>
        <span>Map</span><select id="basemapItem"></select>
      </div>
      <div class="field" id="basemapFilterRow" hidden>
        <span>Filter</span><input type="text" id="basemapFilter" placeholder="filter layers" spellcheck="false">
      </div>
      <div class="field" id="basemapTimeRow" hidden>
        <span>Date</span><input type="text" id="basemapTime" placeholder="default" spellcheck="false" title="Date of time-enabled layers (YYYY-MM-DD), or 'default'">
      </div>
      <div id="basemapOptions" hidden>
        <div class="field slider-field">
          <span>Opacity</span><input type="range" id="basemapOpacity" min="0" max="100" step="1" value="100" aria-label="Basemap opacity"><input type="number" id="basemapOpacityValue" min="0" max="100" step="1" value="100" aria-label="Basemap opacity (%)">
        </div>
        <label class="check"><input type="checkbox" id="basemapAbove"> Above the image</label>
        <p class="hint" id="basemapAttribution"></p>
      </div>
      <p class="hint" id="basemapStatus"></p>
      <h3>Vector layers</h3>
      <div class="vector-add">
        <input type="text" id="vectorPath" placeholder="path to vector file" title="Path to a vector file: absolute, or relative to the workspace folder" spellcheck="false" aria-label="Vector file path">
        <button id="vectorAdd">Add</button>
        <button id="vectorBrowse" title="Choose files">Browse…</button>
      </div>
      <p class="hint">GeoJSON, KML, KMZ, Shapefile, GeoPackage, or a zip of them.</p>
      <div id="vectorError" class="error" role="alert" hidden></div>
      <div id="vectorList" class="vector-list"></div>
    </aside>
    <aside id="info" class="panel" hidden></aside>
  </div>
  <div id="status">
    <span id="statusSize"></span>
    <span id="statusPos"></span>
    <span id="statusValue"></span>
    <span class="spacer"></span>
    <span id="statusProgress"></span>
    <span id="statusCrs"></span>
    <span id="statusFileSize" title="File size"></span>
  </div>
  <script nonce="${nonce}">window.TIFF_WORKER_URL = ${JSON.stringify(asset('dist', 'webview', 'worker.js').toString())}; window.TIFF_MAPLIBRE_URL = ${JSON.stringify(asset('dist', 'webview', 'maplibre-gl.js').toString())}; window.TIFF_SQLJS_WASM_URL = ${JSON.stringify(asset('dist', 'webview', 'sql-wasm.wasm').toString())}; window.TIFF_NONCE = ${JSON.stringify(nonce)};</script>
  <script nonce="${nonce}" src="${asset('dist', 'webview', 'main.js')}"></script>
</body>
</html>`;
  }
}

/**
 * Asks for a name and an auto-apply rule, then stores the preset in the
 * presets file (replacing one of the same name). Returns the name, or undefined if cancelled.
 */
async function savePreset(store: PresetStore, preset: Preset, bandCount: number, fileName: string): Promise<string | undefined> {
  const existing = store.get();
  const name = (
    await vscode.window.showInputBox({
      title: 'Save band composite preset',
      prompt: 'Preset name. A preset with the same name is replaced.',
      value: preset.name,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a name'),
    })
  )?.trim();
  if (!name) return undefined;

  const pattern = suggestPattern(fileName);
  type Rule = vscode.QuickPickItem & { match?: Preset['match'] | 'pattern' };
  const rules: Rule[] = [
    { label: 'Only when chosen', description: 'Select it from the Bands menu', match: undefined },
    { label: `Files with ${bandCount} band${bandCount === 1 ? '' : 's'}`, description: 'Apply automatically when opened', match: { bands: bandCount } },
    { label: 'Files whose name matches…', description: `A pattern such as ${pattern}`, match: 'pattern' },
  ];
  const previous = existing.find((p) => p.name === name)?.match ?? preset.match;
  if (previous) {
    rules.unshift({ label: 'Keep the current rule', description: JSON.stringify(previous), match: previous });
  }
  const rule = await vscode.window.showQuickPick(rules, { title: `Apply "${name}" automatically?`, placeHolder: 'Choose when to apply the preset' });
  if (!rule) return undefined;
  let match = rule.match;
  if (match === 'pattern') {
    const glob = await vscode.window.showInputBox({
      title: `Apply "${name}" to files named like`,
      prompt: 'File name pattern; * matches any text, ? one character. Case does not matter.',
      value: pattern,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a pattern'),
    });
    if (!glob) return undefined;
    match = { fileName: glob.trim(), bands: bandCount };
  }

  const saved: Preset = { ...preset, name };
  delete saved.match;
  if (match) saved.match = match;
  return (await store.save(saved)) ? name : undefined;
}

async function deletePreset(store: PresetStore, name: string): Promise<void> {
  const answer = await vscode.window.showWarningMessage(`Delete the preset "${name}" from ${PRESETS_FILE}?`, { modal: true }, 'Delete');
  if (answer === 'Delete') {
    await store.delete(name);
  }
}

/** A file name pattern from a name: numbers and dates become wildcards (S2A_20190926_T18NWL.tif → S2A_*_T*NWL.tif). */
function suggestPattern(fileName: string): string {
  return fileName.replace(/\d{2,}/g, '*').replace(/\*([^A-Za-z]*\*)+/g, '*');
}

// ---------------------------------------------------------------------------
// Overlays: network access and vector files, for the webview
// ---------------------------------------------------------------------------

/** Identifies the extension to tile servers (OpenStreetMap's tile policy asks for this). */
const USER_AGENT = 'tiff-viewer-vscode (+https://github.com/Shargus/tiff-viewer-vscode)';
const MAX_PARALLEL_FETCHES = 12;
let activeFetches = 0;
const fetchQueue: (() => void)[] = [];

/**
 * Fetches a URL for the webview, which has no network access of its own
 * (its content security policy keeps it closed). http(s) only.
 */
async function proxyFetch(
  url: string,
  as: 'bytes' | 'text',
): Promise<{ ok: boolean; status: number; bytes?: Uint8Array; text?: string; contentType?: string; error?: string }> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, status: 0, error: 'Only http(s) URLs can be fetched' };
  if (activeFetches >= MAX_PARALLEL_FETCHES) await new Promise<void>((resolve) => fetchQueue.push(resolve));
  activeFetches++;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000), redirect: 'follow' });
    const contentType = response.headers.get('content-type') ?? undefined;
    if (!response.ok) return { ok: false, status: response.status, contentType, error: `HTTP ${response.status}` };
    if (as === 'text') return { ok: true, status: response.status, contentType, text: await response.text() };
    return { ok: true, status: response.status, contentType, bytes: new Uint8Array(await response.arrayBuffer()) };
  } catch (error) {
    return { ok: false, status: 0, error: (error as Error).message ?? String(error) };
  } finally {
    activeFetches--;
    fetchQueue.shift()?.();
  }
}

const VECTOR_EXTENSIONS = ['geojson', 'json', 'kml', 'kmz', 'shp', 'gpkg', 'zip'];

/**
 * The folder relative overlay paths start from: the workspace folder holding
 * the image, else the first workspace folder, else the image's folder.
 */
function overlayBase(image: vscode.Uri): vscode.Uri {
  return vscode.workspace.getWorkspaceFolder(image)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.joinPath(image, '..');
}

/**
 * Reads a vector file for an overlay. `path` is absolute (or starts with ~)
 * or relative to `base` (see overlayBase). A shapefile comes with its .dbf, .prj
 * and .cpg; a File Geodatabase is refused.
 */
async function readOverlay(
  base: vscode.Uri,
  path: string,
): Promise<{ ok: boolean; name: string; files?: { name: string; data: Uint8Array }[]; error?: string }> {
  const trimmed = path.trim().replace(/^"(.*)"$/, '$1');
  const home = os.homedir();
  const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') ? pathModule.join(home, trimmed.slice(2)) : trimmed;
  const uri = pathModule.isAbsolute(expanded) ? base.with({ path: vscode.Uri.file(expanded).path }) : vscode.Uri.joinPath(base, expanded);
  const name = uri.path.slice(uri.path.replace(/\/+$/, '').lastIndexOf('/') + 1).replace(/\/+$/, '');
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      return /\.gdb$/i.test(name)
        ? { ok: false, name, error: 'File Geodatabase (.gdb) is not supported. Export the layers to GeoPackage or GeoJSON (e.g. with QGIS or ogr2ogr).' }
        : { ok: false, name, error: `${name} is a folder, not a vector file.` };
    }
    const files = [{ name, data: plainBytes(await vscode.workspace.fs.readFile(uri)) }];
    if (/\.shp$/i.test(name)) {
      // The attributes, projection and encoding live next to it.
      const stem = name.slice(0, -4);
      for (const ext of ['dbf', 'prj', 'cpg']) {
        for (const candidate of [`${stem}.${ext}`, `${stem}.${ext.toUpperCase()}`]) {
          try {
            files.push({ name: candidate, data: plainBytes(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(uri, '..', candidate))) });
            break;
          } catch {
            // Not there; .prj and .cpg are optional, and a missing .dbf only loses attributes.
          }
        }
      }
    }
    return { ok: true, name, files };
  } catch (error) {
    return { ok: false, name, error: error instanceof vscode.FileSystemError && error.code === 'FileNotFound' ? `${uri.fsPath} does not exist.` : `Could not read ${uri.fsPath}: ${(error as Error).message ?? error}` };
  }
}

/**
 * A copy as a plain Uint8Array. vscode.workspace.fs returns Node Buffers, and a
 * Buffer posted to a webview arrives as {type: 'Buffer', data: [...]} (its
 * toJSON runs before VS Code's message serialisation sees the bytes).
 */
function plainBytes(bytes: Uint8Array): Uint8Array {
  return Object.getPrototypeOf(bytes) === Uint8Array.prototype ? bytes : new Uint8Array(bytes);
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
