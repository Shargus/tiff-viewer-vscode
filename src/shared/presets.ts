import { bandIdentifier } from './expression';
import { DEFAULT_CLASS_COLOR, MAX_CLASSES, parseHexColor, type PaletteClass, type RGBA } from './palette';

/**
 * A visualization preset, as stored in ~/.tiff-viewer-vscode/presets.jsonc.
 *
 *   { "name": "Sentinel-2 true colour",
 *     "red": "B04 / 3000", "green": "B03 / 3000", "blue": "B02 / 3000" }
 *
 *   { "name": "NDVI", "value": "(B08 - B04) / (B08 + B04)",
 *     "range": [-1, 1], "colormap": "RdYlGn" }
 */
export interface Preset {
  name: string;
  /** Red, green and blue channel expressions (an RGB composite). */
  red?: string;
  green?: string;
  blue?: string;
  /** Single expression shown through `colormap` (used when red/green/blue are absent). */
  value?: string;
  /**
   * Paletted / unique values (as in QGIS): the band (or expression) whose
   * values are listed in `classes`; values not listed are transparent.
   */
  paletted?: string;
  /** The classes of a paletted preset: value, colour ("#rrggbb" or "#rrggbbaa") and label. */
  classes?: PaletteClass[];
  /** Colour ramp used by Classify in a paletted preset: "random" (default) or a colour map name. */
  colorRamp?: string;
  /**
   * Expression values mapped to black…full brightness: [min, max], or an
   * automatic stretch ("auto" or "minmax": the data's min/max, "percentile":
   * 2%/98%, "full": the data type's range). One for all channels or one per
   * channel. Default [0, 1].
   */
  range?: RangeSetting | RangeSetting[];
  /** Colour map for a single expression. Default "gray". */
  colormap?: string;
  /** As in QGIS: brightness -255…255, contrast and saturation -100…100 (default 0), gamma 0.1…10 (> 1 brightens, default 1). */
  brightness?: number;
  contrast?: number;
  saturation?: number;
  gamma?: number;
  /** Extra band names: name → 1-based band number, e.g. { "B04": 4 }. */
  bands?: Record<string, number>;
  /**
   * Named intermediate expressions, in order: each may use the bands and the
   * variables before it, and the channel expressions may use all of them.
   * Each is computed once per pixel, however often it is used.
   */
  variables?: Record<string, string>;
  /** Apply automatically to files that match (band count and/or file name glob). */
  match?: { bands?: number | number[]; fileName?: string | string[] };
}

export type Range = [number, number];
/** Automatic stretches: the data's min/max, its 2nd/98th percentiles, or the data type's full range. */
export type AutoStretch = 'minmax' | 'percentile' | 'full';
/** A range as written in a preset ("auto" means "minmax"). */
export type RangeSetting = Range | AutoStretch | 'auto';

/** Limits and defaults of the colour adjustments (QGIS's). */
export const ADJUSTMENTS = {
  brightness: { min: -255, max: 255, default: 0 },
  contrast: { min: -100, max: 100, default: 0 },
  saturation: { min: -100, max: 100, default: 0 },
  gamma: { min: 0.1, max: 10, default: 1 },
} as const;
export type Adjustment = keyof typeof ADJUSTMENTS;

/** What the worker needs to render a composite. */
export interface CompositeSpec {
  /** One expression (shown with `colormap`) or three (red, green, blue). */
  expressions: string[];
  /** Band name → 0-based sample index. */
  bands: Record<string, number>;
  /** Named intermediate expressions (see Preset.variables). */
  variables: Record<string, string>;
  /** Range per expression: fixed, or stretched automatically from statistics. */
  ranges: (Range | AutoStretch)[];
  colormap: string;
  /** Paletted rendering: each listed value's colour (and label, for the readout); other values are transparent. */
  classes?: { value: number; rgba: RGBA; label: string }[];
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
}

export type RenderMode = 'rgb' | 'single' | 'paletted';

export function presetMode(preset: Preset): RenderMode {
  if (preset.red !== undefined || preset.green !== undefined || preset.blue !== undefined) return 'rgb';
  if (preset.paletted !== undefined) return 'paletted';
  return 'single';
}

export function presetExpressions(preset: Preset): string[] {
  if (presetMode(preset) === 'paletted') return [preset.paletted ?? 'b1'];
  if (preset.red !== undefined || preset.green !== undefined || preset.blue !== undefined) {
    return [preset.red ?? '0', preset.green ?? '0', preset.blue ?? '0'];
  }
  return [preset.value ?? 'b1'];
}

export function presetRanges(preset: Preset, count: number): (Range | AutoStretch)[] {
  const range = preset.range ?? [0, 1];
  const one = (r: unknown): Range | AutoStretch => {
    if (Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === 'number' && Number.isFinite(v))) return [r[0], r[1]];
    return r === 'percentile' || r === 'full' ? r : 'minmax';
  };
  const single = typeof range === 'string' || (Array.isArray(range) && range.length === 2 && typeof range[0] === 'number');
  if (single) return new Array(count).fill(one(range));
  const list = range as RangeSetting[];
  return Array.from({ length: count }, (_, i) => (list[i] === undefined ? [0, 1] : one(list[i])));
}

/** A paletted preset's classes, with colours as RGBA (invalid ones grey). */
export function presetClasses(preset: Preset): { value: number; rgba: RGBA; label: string }[] {
  if (!Array.isArray(preset.classes)) return [];
  return preset.classes
    .filter((c) => c && typeof c.value === 'number' && Number.isFinite(c.value))
    .map((c) => ({
      value: c.value,
      rgba: (typeof c.color === 'string' && parseHexColor(c.color)) || [...DEFAULT_CLASS_COLOR],
      label: typeof c.label === 'string' ? c.label : '',
    }))
    .slice(0, MAX_CLASSES);
}

/** A preset's colour adjustment, limited to QGIS's range (the default when missing or invalid). */
export function presetAdjustment(preset: Preset, name: Adjustment): number {
  const { min, max, default: fallback } = ADJUSTMENTS[name];
  const value = preset[name];
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * Band variables for a page: b1…bN always, the file's band descriptions, and
 * the preset's band names for bands the file does not name. The file is
 * trusted over the preset: a preset's guess of the band layout (e.g. B11 is
 * band 12) must not rename a band the file calls something else.
 */
export function bandVariables(bandCount: number, descriptions: (string | null)[], presetBands?: Record<string, number>): Record<string, number> {
  const vars: Record<string, number> = {};
  for (let i = 0; i < bandCount; i++) vars[`b${i + 1}`] = i;
  for (const [name, band] of Object.entries(presetBands ?? {})) {
    if (Number.isInteger(band) && band >= 1 && band <= bandCount && bandIdentifier(name) === name && !descriptions[band - 1]) {
      vars[name] = band - 1;
    }
  }
  descriptions.forEach((description, i) => {
    const id = description ? bandIdentifier(description) : undefined;
    if (id && i < bandCount) vars[id] = i;
  });
  return vars;
}

export function compositeSpec(preset: Preset, bandCount: number, descriptions: (string | null)[]): CompositeSpec {
  const expressions = presetExpressions(preset);
  return {
    expressions,
    bands: bandVariables(bandCount, descriptions, preset.bands),
    variables: preset.variables && typeof preset.variables === 'object' ? preset.variables : {},
    ranges: presetRanges(preset, expressions.length),
    colormap: expressions.length === 1 ? (preset.colormap ?? 'gray') : 'gray',
    ...(presetMode(preset) === 'paletted' ? { classes: presetClasses(preset), ranges: [[0, 1] as Range] } : {}),
    brightness: presetAdjustment(preset, 'brightness'),
    contrast: presetAdjustment(preset, 'contrast'),
    saturation: presetAdjustment(preset, 'saturation'),
    gamma: presetAdjustment(preset, 'gamma'),
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Whether a preset's `match` rule selects a file. Presets without `match` never match. */
export function presetMatches(preset: Preset, fileName: string, bandCount: number): boolean {
  const match = preset.match;
  if (!match || (match.bands === undefined && match.fileName === undefined)) return false;
  if (match.bands !== undefined) {
    const counts = Array.isArray(match.bands) ? match.bands : [match.bands];
    if (!counts.includes(bandCount)) return false;
  }
  if (match.fileName !== undefined) {
    const globs = Array.isArray(match.fileName) ? match.fileName : [match.fileName];
    if (!globs.some((glob) => globToRegExp(glob).test(fileName))) return false;
  }
  return true;
}

/** Keeps only well-formed presets from the setting (it is edited by hand). */
export function sanitizePresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (p): p is Preset =>
      !!p &&
      typeof p === 'object' &&
      typeof (p as Preset).name === 'string' &&
      (p as Preset).name.trim() !== '' &&
      ['red', 'green', 'blue', 'value', 'paletted'].some((k) => typeof (p as Record<string, unknown>)[k] === 'string'),
  );
}
