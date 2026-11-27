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
  private readonly watcher: vscode.FileSystemWatcher | undefined;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly uri: vscode.Uri,
    watch = true,
  ) {
    if (!watch) return;
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
    this.watcher?.dispose();
    this.onDidChangeEmitter.dispose();
    void this.close();
  }
}

export class TiffEditorProvider implements vscode.CustomReadonlyEditorProvider<TiffDocument> {
  static readonly viewType = 'tiffViewer.viewer';
  static readonly blankViewType = 'tiffViewer.blank';
  /** The same viewer for vector files: never their default editor, offered by "Open With…". */
  static readonly vectorViewTypes = ['tiffViewer.vector'];

  static register(context: vscode.ExtensionContext, presets: PresetStore): vscode.Disposable {
    const provider = new TiffEditorProvider(context.extensionUri, context.workspaceState, presets);
    const options = {
      supportsMultipleEditorsPerDocument: true,
      // Decoding large images is expensive; keep the result when the tab is hidden.
      webviewOptions: { retainContextWhenHidden: true },
    };
    return vscode.Disposable.from(
      vscode.commands.registerCommand('tiffViewer.open', () => provider.openBlank()),
      ...[TiffEditorProvider.viewType, ...TiffEditorProvider.vectorViewTypes].map((viewType) => vscode.window.registerCustomEditorProvider(viewType, provider, options)),
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

  /**
   * The command "Open TIFF Viewer VS Code": a viewer with no file, for georeferenced
   * data (a plain panel: its tab names no file). The viewer itself is the same.
   */
  openBlank(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(TiffEditorProvider.blankViewType, 'TIFF Viewer VS Code', vscode.ViewColumn.Active, { retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'images', 'icon.png');
    this.attach(panel, undefined);
    return panel;
  }

  async resolveCustomEditor(document: TiffDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.attach(panel, document);
  }

  /** Runs the viewer of `document` in `panel`. */
  private attach(panel: vscode.WebviewPanel, document: TiffDocument | undefined): void {
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
    const fileName = document ? document.uri.path.slice(document.uri.path.lastIndexOf('/') + 1) : '';
    // A vector file: the viewer starts with it as its layer (read like any vector layer).
    const vector = !!document && !/\.(tiff?|btf|tf8|tf2)$/i.test(fileName);
    const rememberKey = document ? `selection:${document.uri.toString()}` : undefined;
    /** Where relative paths start, and dialogs open. */
    const base = overlayBase(document?.uri);
    const folder = document ? vscode.Uri.joinPath(document.uri, '..') : base;

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('tiffViewer.placeSearch.language')) void post({ type: 'placeLanguage', language: placeLanguage() });
      }),
    );
    /** Raster layers added in this viewer, by id. */
    const rasters = new Map<number, TiffDocument>();
    disposables.push(
      webview.onDidReceiveMessage(async (message: WebviewToHost) => {
        switch (message.type) {
          case 'ready':
            await Promise.all([document?.open().catch(() => undefined), this.presets.init()]);
            void post({
              type: 'init',
              fileName,
              fileSize: document?.size ?? 0,
              vector: vector && document ? document.uri.toString() : undefined,
              blank: !document,
              presets: this.presets.get(),
              remembered: rememberKey ? this.state.get<Selection>(rememberKey) : undefined,
              placeLanguage: placeLanguage(),
            });
            break;
          case 'remember':
            // Only explicit choices are sent, so a choice of the plain image also overrides auto-apply rules.
            if (rememberKey) void this.state.update(rememberKey, message.selection);
            break;
          case 'savePreset': {
            const name = await savePreset(this.presets, message.preset, message.bandCount, message.fileName ?? fileName);
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
            void readOverlay(base, message.path).then((result) => post({ type: 'overlayRead', id: message.id, path: message.path, ...result }));
            break;
          case 'browseLayers': {
            const uris = await vscode.window.showOpenDialog({
              title: 'Add layers',
              canSelectMany: true,
              defaultUri: folder,
              filters: { 'Raster and vector files': [...RASTER_EXTENSIONS, ...VECTOR_EXTENSIONS], 'Raster files': RASTER_EXTENSIONS, 'Vector files': VECTOR_EXTENSIONS, 'All files': ['*'] },
            });
            if (uris?.length) {
              const prefix = base.path.endsWith('/') ? base.path : `${base.path}/`;
              void post({ type: 'layersBrowsed', paths: uris.map((u) => (u.scheme === base.scheme && u.path.startsWith(prefix) ? u.path.slice(prefix.length) : u.scheme === 'file' ? u.fsPath : u.toString())) });
            }
            break;
          }
          case 'openRaster': {
            const uri = resolveLayerPath(base, message.path);
            const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
            try {
              const stat = await vscode.workspace.fs.stat(uri);
              if (stat.type & vscode.FileType.Directory) throw new Error(`${name} is a folder, not a TIFF file.`);
              const raster = new TiffDocument(uri, false);
              await raster.open();
              rasters.get(message.id)?.dispose();
              rasters.set(message.id, raster);
              void post({ type: 'rasterOpened', id: message.id, ok: true, name, fileSize: raster.size });
            } catch (error) {
              const text = error instanceof vscode.FileSystemError && error.code === 'FileNotFound' ? `${uri.scheme === 'file' ? uri.fsPath : uri.toString()} does not exist.` : String((error as Error)?.message ?? error);
              void post({ type: 'rasterOpened', id: message.id, ok: false, name, error: text });
            }
            break;
          }
          case 'closeRaster':
            rasters.get(message.id)?.dispose();
            rasters.delete(message.id);
            break;


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
                defaultUri: folder,
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
          case 'saveScreenshot': {
            const uri = await vscode.window.showSaveDialog({
              title: 'Save Screenshot',
              defaultUri: vscode.Uri.joinPath(folder, message.name),
              filters: { 'PNG images': ['png'] },
            });
            if (uri) {
              const target = /\.png$/i.test(uri.path) ? uri : uri.with({ path: `${uri.path}.png` });
              try {
                await vscode.workspace.fs.writeFile(target, Buffer.from(message.data, 'base64'));
                const name = target.path.slice(target.path.lastIndexOf('/') + 1);
                void vscode.window.showInformationMessage(`Screenshot saved: ${name}`, 'Open').then((choice) => {
                  if (choice === 'Open') void vscode.commands.executeCommand('vscode.open', target, { viewColumn: vscode.ViewColumn.Beside });
                });
              } catch (error) {
                void vscode.window.showErrorMessage(`Could not write ${target.fsPath}: ${(error as Error).message ?? error}`);
              }
            }
            break;
          }
          case 'exportColorMap': {
            const uri = await vscode.window.showSaveDialog({
              title: 'Export Colour Map to File',
              defaultUri: vscode.Uri.joinPath(folder, message.fileName),
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
          case 'read': {
            const source = message.file === undefined ? document : rasters.get(message.file);
            try {
              if (!source) throw new Error('The layer is closed.');
              const data = await Promise.all(message.ranges.map((range) => source.read(range)));
              void post({ type: 'readResult', id: message.id, file: message.file, data });
            } catch (error) {
              void post({ type: 'readError', id: message.id, file: message.file, message: String((error as Error)?.message ?? error) });
            }
            break;
          }
        }
      }),
      ...(document ? [document.onDidChange(() => void post({ type: 'reload', fileSize: document.size }))] : []),
      // Edits of the presets file, by hand or from another viewer or window.
      this.presets.onDidChange((presets) => void post({ type: 'presets', presets })),
    );
    panel.onDidDispose(() => {
      disposables.forEach((d) => d.dispose());
      for (const raster of rasters.values()) raster.dispose();
      rasters.clear();
    });
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
    <button id="compositeToggle" hidden title="Band rendering: RGB, single band or paletted" aria-pressed="false">Rendering</button>
    <button id="layersToggle" disabled title="Layers need a georeferenced image (GeoTIFF)" aria-pressed="false">Layers</button>
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
    <div class="panel-resizer" data-panel="composite" role="separator" aria-orientation="vertical" title="Drag to resize the panel (double-click: default width)"></div>
    <aside id="composite" class="panel" hidden>
      <button class="panel-close" data-toggle="compositeToggle" title="Close" aria-label="Close panel">×</button>
      <h3>Rendering</h3>
      <label class="rendering-layer"><span>Layer</span><select id="renderingLayer" title="The layer whose rendering is edited" aria-label="Layer whose rendering is edited"></select></label>
      <label class="rendering-layer" id="presetGroup" hidden title="Rendering preset"><span>Preset</span><select id="preset" aria-label="Rendering preset"></select></label>
      <div id="basemapRendering" class="vector-rendering" hidden>
        <p class="hint" id="basemapInfo"></p>
        <div class="field" id="basemapLanguageRow"><span>Language</span><select id="basemapLanguage" title="Language of the map's labels"></select></div>
        <div class="field" id="basemapRegionRow"><span>Region</span><select id="basemapRegion" title="Country or region the map is shown for (borders, place names)"></select></div>
        <p class="hint" id="basemapNoLocalization">This basemap has no language or region options.</p>
      </div>
      <div id="vectorRendering" class="vector-rendering" hidden>
        <div class="field"><span>Colour</span><input type="color" id="vectorColor" title="Colour of lines, outlines, points and fills"></div>
        <div class="field"><span>Line width</span><input type="number" id="vectorWidth" min="0.5" max="20" step="0.5" title="Width of lines and outlines, in screen pixels"></div>
        <div class="field slider-field"><span>Fill opacity</span><input type="range" id="vectorFill" min="0" max="100" step="1" aria-label="Fill opacity"><input type="number" id="vectorFillValue" min="0" max="100" step="1" aria-label="Fill opacity (%)"></div>
        <p class="hint" id="vectorInfo"></p>
      </div>
      <div id="rasterRendering">
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
      <h3>Variables</h3>
      <p class="hint">Named expressions, computed in order: each can use the bands and the variables above it; the channels can use them all. Drag ⠿ to reorder; ↵ inserts a variable into the expression being edited.</p>
      <div id="variableList" class="variable-list"></div>
      <div class="buttons"><button id="variableAdd" title="Add a named expression">+ Add variable</button></div>
      <h3>Expressions</h3>
      <p class="hint">Operators <code>+ - * / ^ %</code>, comparisons <code>&lt; &lt;= &gt; &gt;= == !=</code> (1 or 0),
      <code>abs sqrt exp log log10 log2 pow min max clamp where isnan round floor ceil sin cos tan atan2</code>,
      <code>pi</code>, and <code>nodata</code> (a missing value: transparent; <code>x == nodata</code> tests for it).
      Example: <code>(B08 - B04) / (B08 + B04)</code>.</p>
      <p class="hint"><a href="#" id="openSettings">Open the presets file</a> (<code>~/.tiff-viewer-vscode/presets.jsonc</code>)</p>
      </div>
    </aside>
    <div class="panel-resizer" data-panel="layers" role="separator" aria-orientation="vertical" title="Drag to resize the panel (double-click: default width)"></div>
    <aside id="layers" class="panel side-panel" hidden>
      <button class="panel-close" data-toggle="layersToggle" title="Close" aria-label="Close panel">×</button>
      <h3>Layers</h3>
      <div class="layer-add">
        <button id="layerAdd" title="Add raster (GeoTIFF) or vector files">+ Add layer…</button>
        <button id="basemapAdd" title="Add an online basemap (it goes to the bottom of the list)" aria-expanded="false">+ Add basemap…</button>
        <span class="hint" id="layerStatus"></span>
      </div>
      <div id="basemapPicker" class="basemap-picker" hidden>
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
        <p class="hint" id="basemapStatus"></p>
        <div class="buttons">
          <button id="basemapPickerAdd">Add</button>
          <button id="basemapPickerCancel">Cancel</button>
        </div>
      </div>
      <div id="layerError" class="error" role="alert" hidden></div>
      <div id="layerList" class="layer-list"></div>
    </aside>
    <div class="panel-resizer" data-panel="info" role="separator" aria-orientation="vertical" title="Drag to resize the panel (double-click: default width)"></div>
    <aside id="info" class="panel" hidden>
      <button class="panel-close" data-toggle="infoToggle" title="Close" aria-label="Close panel">×</button>
      <div id="infoContent"></div>
    </aside>
    <div class="panel-resizer" data-panel="measure" role="separator" aria-orientation="vertical" title="Drag to resize the panel (double-click: default width)"></div>
    <aside id="measure" class="panel" hidden>
      <button class="panel-close" data-toggle="measureToggle" title="Close" aria-label="Close panel">×</button>
      <h3 id="measureTitle">Measure line</h3>
      <div class="field" id="measureMethodRow"><span>Method</span><select id="measureMethod" title="Ellipsoidal: along geodesics on the WGS 84 ellipsoid. Cartesian: on the plane of the map's coordinate system."><option value="ellipsoidal">Ellipsoidal (WGS 84)</option><option value="cartesian">Cartesian (map CRS)</option></select></div>
      <div class="field"><span>Units</span><select id="measureUnits"></select></div>
      <table id="measureSegments" class="measure-segments"><thead><tr><th>#</th><th>Segment</th></tr></thead><tbody></tbody></table>
      <dl id="measureResults" class="measure-results"></dl>
      <p class="hint" id="measureHint"></p>
    </aside>
  </div>
  <div id="status">
    <span id="statusSize"></span>
    <span class="status-tools" role="toolbar" aria-label="View options">
      <button id="unboundedToggle" class="status-icon" aria-pressed="false" title="Unbounded view: pan over the whole world and add layers anywhere (off: the view is bounded by the extent of the file the viewer was opened on) (U)" aria-label="Unbounded view"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><ellipse cx="8" cy="8" rx="2.6" ry="6.2"/><path d="M1.8 8h12.4M2.9 4.6h10.2M2.9 11.4h10.2"/></svg></button>
      <button id="ticksToggle" class="status-icon" aria-pressed="false" title="Show coordinates &amp; scale: ticks along the borders, a grid at the ticks, and a scale bar (G)" aria-label="Show coordinates and scale"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="1.8" width="12.4" height="12.4" rx="0.8"/><path d="M5.9 1.8v12.4M10.1 1.8v12.4M1.8 5.9h12.4M1.8 10.1h12.4"/></svg></button>
      <button id="valuesToggle" class="status-icon" aria-pressed="false" title="Show band and rendered values on hovering, in a table next to the pointer (Space)" aria-label="Show band and rendered values on hovering"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5.3" y="1.6" width="9.2" height="7.6" rx="1"/><path d="M7 4h5.6M7 6.6h5.6M9.6 1.6v7.6"/><path d="M1.6 7.4l1.9 7.2 1.4-2.6 2.7 2.4 1-1.1-2.6-2.4 2.9-.8z" fill="currentColor" stroke-width="0.6"/></svg></button>
      <span class="split-button">
        <button id="measureToggle" class="status-icon" aria-pressed="false" title="Measure line (R)" aria-label="Measure line"></button>
        <button id="measureMenuButton" class="status-icon split-arrow" aria-haspopup="menu" aria-expanded="false" title="Choose what to measure: line, area or angle" aria-label="Choose what to measure"><svg viewBox="0 0 6 16" width="6" height="16" aria-hidden="true" focusable="false"><path d="M0.5 6.8h5L3 9.8z" fill="currentColor"/></svg></button>
      </span>
      <button id="placeSearchToggle" class="status-icon wide" aria-haspopup="dialog" aria-expanded="false" title="OSM place search: find a place by name (OpenStreetMap)" aria-label="OSM place search"><svg viewBox="0 0 28 16" width="28" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><text x="0.2" y="11.4" fill="currentColor" stroke="none" font-family="sans-serif" font-size="7.4" font-weight="700" letter-spacing="-0.2">OSM</text><circle cx="21.4" cy="6.9" r="3.5"/><path d="M24 9.5l2.8 2.8"/></svg></button>
      <button id="screenshotButton" class="status-icon" title="Take screenshot: save the view as a PNG image (S)" aria-label="Take screenshot"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M2 4.8h2.6L5.9 3h4.2l1.3 1.8H14a.9.9 0 0 1 .9.9v6.6a.9.9 0 0 1-.9.9H2a.9.9 0 0 1-.9-.9V5.7a.9.9 0 0 1 .9-.9z"/><circle cx="8" cy="8.9" r="2.6"/></svg></button>
    </span>
    <span id="statusPos"></span>
    <span class="spacer"></span>
    <span id="statusProgress"></span>
    <button id="statusCrs" class="status-button" hidden aria-haspopup="menu" aria-expanded="false"></button>
    <span id="statusFileSize" title="File size"></span>
  </div>
  <div id="measureMenu" class="crs-menu measure-menu" role="menu" aria-label="Measure" hidden></div>
  <div id="placeSearch" class="crs-menu place-search" role="dialog" aria-label="OSM place search" hidden>
    <div id="placeResults" class="place-results" role="listbox" aria-label="Places" hidden></div>
    <div id="placeStatus" class="place-status" role="status" hidden></div>
    <input type="search" id="placeInput" placeholder="Place name, then Enter" spellcheck="false" autocomplete="off" role="combobox" aria-controls="placeResults" aria-label="Place name">
    <div class="place-attribution">Search by Nominatim · Data © OpenStreetMap contributors</div>
  </div>
  <div id="crsMenu" class="crs-menu" role="menu" hidden>
    <div id="crsChoices" class="crs-choices"></div>
    <div class="crs-other">
      <input type="text" id="crsInput" placeholder="EPSG code, e.g. 32633" spellcheck="false" aria-label="Another coordinate system (EPSG code)">
      <button id="crsApply">Apply</button>
    </div>
    <div id="crsError" class="error" role="alert" hidden></div>
  </div>
  <script nonce="${nonce}">window.TIFF_WORKER_URL = ${JSON.stringify(asset('dist', 'webview', 'worker.js').toString())}; window.TIFF_MAPLIBRE_URL = ${JSON.stringify(asset('dist', 'webview', 'maplibre-gl.js').toString())}; window.TIFF_SQLJS_WASM_URL = ${JSON.stringify(asset('dist', 'webview', 'sql-wasm.wasm').toString())}; window.TIFF_NONCE = ${JSON.stringify(nonce)};</script>
  <script nonce="${nonce}" src="${asset('dist', 'webview', 'main.js')}"></script>
</body>
</html>`;
  }
}

/** The OSM place search's language: the setting, or VS Code's display language. */
function placeLanguage(): string {
  return vscode.workspace.getConfiguration('tiffViewer').get<string>('placeSearch.language')?.trim() || vscode.env.language || 'en';
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
    { label: 'Only when chosen', description: 'Choose it from the Preset menu', match: undefined },
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
const RASTER_EXTENSIONS = ['tif', 'tiff', 'gtif', 'gtiff'];

/**
 * A layer's file: a URI (possibly remote), a path
 * starting with ~, an absolute path, or a path relative to `base`.
 */
function resolveLayerPath(base: vscode.Uri, path: string): vscode.Uri {
  const trimmed = path.trim().replace(/^"(.*)"$/, '$1');
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(trimmed)) {
    const uri = vscode.Uri.parse(trimmed);
    // Dragged from the Explorer of a remote window (SSH, WSL, containers), a file is named as
    // the UI sees it, vscode-remote://<authority>/path; here, on the remote side, it is a file.
    if (uri.scheme === 'vscode-remote' && vscode.env.remoteName) return vscode.Uri.file(uri.path);
    return uri;
  }
  const home = os.homedir();
  const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') ? pathModule.join(home, trimmed.slice(2)) : trimmed;
  return pathModule.isAbsolute(expanded) ? base.with({ path: vscode.Uri.file(expanded).path }) : vscode.Uri.joinPath(base, expanded);
}

/**
 * The folder relative overlay paths start from: the workspace folder holding
 * the image, else the first workspace folder, else the image's folder.
 */
function overlayBase(image: vscode.Uri | undefined): vscode.Uri {
  return (
    (image && vscode.workspace.getWorkspaceFolder(image)?.uri) ??
    vscode.workspace.workspaceFolders?.[0]?.uri ??
    (image ? vscode.Uri.joinPath(image, '..') : vscode.Uri.file(os.homedir()))
  );
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
  const uri = resolveLayerPath(base, path);
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
