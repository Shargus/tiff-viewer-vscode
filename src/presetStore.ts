import * as fs from 'fs';
import { applyEdits, modify, parse, printParseErrorCode, type FormattingOptions, type ParseError } from 'jsonc-parser';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { sanitizePresets, type Preset } from './shared/presets';

/** Folder in the user's home directory that belongs to this extension. */
export const PRESETS_DIR = path.join(os.homedir(), '.tiff-viewer-vscode');
export const PRESETS_FILE = path.join(PRESETS_DIR, 'presets.jsonc');

const FORMATTING: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

/** Written when the file does not exist yet: documentation and a commented-out example. */
const INITIAL_CONTENT = `// Band rendering presets for the TIFF Viewer VS Code extension.
//
// Presets appear in the viewer's "Bands" menu. Write them here, or use
// "Save as preset…" in the viewer's Rendering panel (it edits this file and
// keeps your comments). Open viewers pick up changes when the file is saved.
//
// Each preset:
//   "name"                  Shown in the Bands menu.
//   "red", "green", "blue"  An RGB composite: one expression per channel, e.g. "B04 / 3000".
//   "value"                 Or a single expression, shown with "colormap".
//   "paletted"              Or paletted / unique values (as in QGIS): the band (or expression) whose
//                           values get the colours in "classes"; values not listed are transparent.
//   "classes"               [{ "value": 4, "color": "#00a000", "label": "Vegetation" }, …]; colours
//                           "#rrggbb" or "#rrggbbaa" (with opacity).
//   "colorRamp"             For "paletted": colours given by Classify, "random" or a colour map.
//   "range"                 Values shown as black … full brightness: [min, max], or an automatic
//                           stretch: "auto" (min / max of the image), "percentile" (2% / 98%) or
//                           "full" (the data type's range). One for all channels, or one per
//                           channel: [[0, 3000], "auto", "percentile"]. Default [0, 1].
//   "colormap"              gray, viridis, magma, inferno, plasma, turbo, RdYlGn, RdBu, Spectral,
//                           terrain; add "_r" to reverse. Default gray.
//   "brightness"            As in QGIS: -255 … 255 (default 0).
//   "contrast"              As in QGIS: -100 … 100 (default 0).
//   "saturation"            As in QGIS: -100 … 100 (default 0; -100 is grey).
//   "gamma"                 As in QGIS: 0.1 … 10 (default 1); above 1 brightens dark tones.
//   "bands"                 Extra band names for files without band descriptions: { "B04": 4 }.
//   "variables"             Named intermediate expressions, computed once and usable by later
//                           variables and by the channels: { "r": "clamp(B04 / 10000, 0, 1)" }.
//   "match"                 Apply automatically to matching files, e.g. { "bands": 13 } or
//                           { "fileName": ["S2*_*.tif", "*_l2a.tif"] } (* any text, ? one character).
//
// Band names in expressions: b1 … bN, the file's band descriptions (e.g. B04, B8A, VV),
// and the names in "bands".
// Expressions: + - * / % ^, comparisons < <= > >= == != (1 or 0), and the functions
// abs sqrt exp log log10 log2 pow min max clamp where isnan round floor ceil sin cos tan atan2,
// pi, and nodata: a missing value (shown transparent, as NoData); x == nodata tests for it.
{
  "presets": [
    // {
    //   "name": "Sentinel-2 true colour (bright)",
    //   "red": "B04 / 3000", "green": "B03 / 3000", "blue": "B02 / 3000",
    //   "gamma": 1.3,
    //   "match": { "bands": 13 }
    // }
  ]
}
`;

/**
 * User presets, kept in PRESETS_FILE so that they are easy to find, edit and
 * copy between machines. The file is JSON with comments; the extension edits
 * it in place, changing only the preset concerned.
 */
export class PresetStore implements vscode.Disposable {
  private presets: Preset[] = [];
  private readonly onDidChangeEmitter = new vscode.EventEmitter<Preset[]>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [this.onDidChangeEmitter];
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last syntax error reported, so that it is not reported again on every reload. */
  private reportedError = '';
  private ready: Promise<void> | undefined;

  /** Creates the file if needed, loads it, and watches it for changes from any editor or window. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      await this.ensureFile();
      await this.reload();
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(PRESETS_DIR), path.basename(PRESETS_FILE)));
      const schedule = () => {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.reload(), 200);
      };
      this.disposables.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule));
    })().catch((error) => {
      void vscode.window.showWarningMessage(`TIFF Viewer VS Code: cannot use the presets file ${PRESETS_FILE}: ${errorText(error)}`);
    });
    return this.ready;
  }

  /** The presets in the file (the last valid version, if it currently has errors). */
  get(): Preset[] {
    return this.presets;
  }

  async open(): Promise<void> {
    await this.ensureFile().catch(() => undefined);
    // A tab of its own: not a preview, which would replace the viewer's tab when that is a preview too.
    await vscode.window.showTextDocument(vscode.Uri.file(PRESETS_FILE), { preview: false });
  }

  /** Adds `preset`, or replaces the preset with its name. */
  async save(preset: Preset): Promise<boolean> {
    return this.edit(({ text, raw, path: at }) => {
      if (!raw) {
        return modify(text, at, [preset], { formattingOptions: FORMATTING });
      }
      const index = raw.findIndex((p) => isNamed(p, preset.name));
      return index >= 0
        ? modify(text, [...at, index], preset, { formattingOptions: FORMATTING })
        : modify(text, [...at, raw.length], preset, { formattingOptions: FORMATTING, isArrayInsertion: true });
    });
  }

  async delete(name: string): Promise<boolean> {
    return this.edit(({ text, raw, path: at }) => {
      const index = raw?.findIndex((p) => isNamed(p, name)) ?? -1;
      return index >= 0 ? modify(text, [...at, index], undefined, { formattingOptions: FORMATTING }) : [];
    });
  }

  dispose(): void {
    clearTimeout(this.reloadTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  private async ensureFile(): Promise<void> {
    await fs.promises.mkdir(PRESETS_DIR, { recursive: true });
    try {
      // 'wx': never overwrite, even if another VS Code window creates the file at the same time.
      await fs.promises.writeFile(PRESETS_FILE, INITIAL_CONTENT, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  private async read(): Promise<FileContents> {
    let text = '';
    try {
      text = await fs.promises.readFile(PRESETS_FILE, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return parseContents(text);
  }

  private async reload(): Promise<void> {
    const { text, raw, errors } = await this.read();
    if (errors.length) {
      this.reportError(text, errors);
      return; // Keep the last valid presets while the file is being edited.
    }
    this.reportedError = '';
    const presets = sanitizePresets(raw ?? []);
    if (JSON.stringify(presets) !== JSON.stringify(this.presets)) {
      this.presets = presets;
      this.onDidChangeEmitter.fire(presets);
    }
  }

  /** Applies edits computed from the current file contents, and writes it back. */
  private async edit(compute: (contents: FileContents) => ReturnType<typeof modify>): Promise<boolean> {
    try {
      await this.ensureFile();
      let contents = await this.read();
      if (contents.errors.length) {
        this.reportedError = '';
        this.reportError(contents.text, contents.errors, 'Fix the presets file first: ');
        return false;
      }
      if (!contents.text.trim()) {
        // Emptied by hand: start again from the documented template.
        contents = parseContents(INITIAL_CONTENT);
      }
      const edits = compute(contents);
      if (edits.length) {
        await fs.promises.writeFile(PRESETS_FILE, applyEdits(contents.text, edits));
      }
      await this.reload();
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not update ${PRESETS_FILE}: ${errorText(error)}`);
      return false;
    }
  }

  private reportError(text: string, errors: ParseError[], prefix = ''): void {
    const first = errors[0];
    const line = text.slice(0, first.offset).split('\n').length;
    const message = `${prefix}${PRESETS_FILE} line ${line}: ${printParseErrorCode(first.error)}. The presets in it are not updated until it is fixed.`;
    if (message === this.reportedError) return;
    this.reportedError = message;
    void vscode.window.showWarningMessage(message, 'Open File').then((choice) => {
      if (choice) void this.open();
    });
  }
}

interface FileContents {
  text: string;
  errors: ParseError[];
  /** The presets array as written (undefined if there is none). */
  raw: unknown[] | undefined;
  /** JSON path of that array: ["presets"], or [] when the file is a bare array. */
  path: (string | number)[];
}

function parseContents(text: string): FileContents {
  const errors: ParseError[] = [];
  const value: unknown = text.trim() ? parse(text, errors, { allowTrailingComma: true }) : undefined;
  if (Array.isArray(value)) {
    return { text, errors, raw: value, path: [] };
  }
  const presets = (value as { presets?: unknown } | undefined)?.presets;
  return { text, errors, raw: Array.isArray(presets) ? presets : undefined, path: ['presets'] };
}

function isNamed(value: unknown, name: string): boolean {
  return !!value && typeof value === 'object' && (value as { name?: unknown }).name === name;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
