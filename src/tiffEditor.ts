import * as fs from 'fs';
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
      return this.bytes.slice(start, start + length);
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
    <button id="compositeToggle" hidden title="Band rendering: RGB, single band or paletted (B)" aria-pressed="false">Rendering</button>
    <span class="spacer"></span>
    <button id="infoToggle" title="Image information (I)" aria-pressed="false">Info</button>
  </div>
  <div id="main">
    <div id="stage" tabindex="0">
      <canvas id="canvas"></canvas>
      <div id="progress" hidden><div id="progressBar"></div></div>
      <div id="message" hidden></div>
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
      <p class="hint">Operators <code>+ - * / ^ %</code>, comparisons <code>&lt; &gt; ==</code> (1 or 0), and
      <code>abs sqrt exp log log10 log2 min max clamp pow where isnan round floor ceil</code>.
      Example: <code>(B08 - B04) / (B08 + B04)</code>.</p>
      <p class="hint"><a href="#" id="openSettings">Open the presets file</a> (<code>~/.tiff-viewer-vscode/presets.jsonc</code>)</p>
    </aside>
    <aside id="info" class="panel" hidden></aside>
  </div>
  <div id="status">
    <span id="statusSize"></span>
    <span id="statusPos"></span>
    <span id="statusValue"></span>
    <span class="spacer"></span>
    <span id="statusProgress"></span>
    <span id="statusFileSize" title="File size"></span>
  </div>
  <script nonce="${nonce}">window.TIFF_WORKER_URL = ${JSON.stringify(asset('dist', 'webview', 'worker.js').toString())};</script>
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

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
