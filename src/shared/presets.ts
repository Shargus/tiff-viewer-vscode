import { bandIdentifier } from './expression';

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
   * Expression values mapped to black…full brightness. One range for all
   * channels, one per channel, or "auto" (stretch with the Contrast setting).
   * Default [0, 1].
   */
  range?: Range | 'auto' | (Range | 'auto')[];
  /** Colour map for a single expression. Default "gray". */
  colormap?: string;
  /** Gamma applied after scaling to the range; > 1 brightens. Default 1. */
  gamma?: number;
  /** Extra band names: name → 1-based band number, e.g. { "B04": 4 }. */
  bands?: Record<string, number>;
  /** Apply automatically to files that match (band count and/or file name glob). */
  match?: { bands?: number | number[]; fileName?: string | string[] };
}

export type Range = [number, number];

/** What the worker needs to render a composite. */
export interface CompositeSpec {
  /** One expression (shown with `colormap`) or three (red, green, blue). */
  expressions: string[];
  /** Variable name → 0-based sample index. */
  bands: Record<string, number>;
  /** Range per expression; null stretches from statistics with the tone setting. */
  ranges: (Range | null)[];
  colormap: string;
  gamma: number;
}

const S2_LAYOUTS: Record<number, string[]> = {
  // L1C, all bands
  13: ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B09', 'B10', 'B11', 'B12'],
  // L2A, all bands (no cirrus band)
  12: ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B09', 'B11', 'B12'],
  // 10 m and 20 m bands
  10: ['B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B11', 'B12'],
  // 10 m bands
  4: ['B02', 'B03', 'B04', 'B08'],
};

/**
 * Sentinel-2 band names for a band count, for files without band
 * descriptions. Descriptions in the file (GDAL band names) take precedence.
 */
function sentinel2Bands(bandCount: number): Record<string, number> {
  const layout = S2_LAYOUTS[bandCount] ?? S2_LAYOUTS[13];
  return Object.fromEntries(layout.map((name, i) => [name, i + 1]));
}

/** Presets shipped with the extension; user presets with the same name replace them. */
export function builtinPresets(bandCount: number): Preset[] {
  const s2 = sentinel2Bands(bandCount);
  const s1 = { VV: 1, VH: 2 };
  return [
    { name: 'Sentinel-2 true colour', bands: s2, red: 'B04 / 3000', green: 'B03 / 3000', blue: 'B02 / 3000' },
    { name: 'Sentinel-2 false colour (NIR)', bands: s2, red: 'B08 / 5000', green: 'B04 / 3000', blue: 'B03 / 3000' },
    { name: 'Sentinel-2 SWIR', bands: s2, red: 'B12 / 4000', green: 'B8A / 5000', blue: 'B04 / 3000' },
    { name: 'Sentinel-2 NDVI', bands: s2, value: '(B08 - B04) / (B08 + B04)', range: [-1, 1], colormap: 'RdYlGn' },
    { name: 'Sentinel-2 NDWI', bands: s2, value: '(B03 - B08) / (B03 + B08)', range: [-1, 1], colormap: 'RdBu' },
    {
      name: 'Sentinel-1 VV/VH (dB values)',
      bands: s1,
      red: 'VV',
      green: 'VH',
      blue: 'VV - VH',
      range: [[-25, 0], [-30, -5], [0, 15]],
    },
    {
      name: 'Sentinel-1 VV/VH (linear power)',
      bands: s1,
      red: '10 * log10(VV)',
      green: '10 * log10(VH)',
      blue: '10 * log10(VV / VH)',
      range: [[-25, 0], [-30, -5], [0, 15]],
    },
  ];
}

/** User presets first, then built-ins not overridden by a user preset of the same name. */
export function allPresets(user: Preset[], bandCount: number): { preset: Preset; builtin: boolean }[] {
  const names = new Set(user.map((p) => p.name));
  return [
    ...user.map((preset) => ({ preset, builtin: false })),
    ...builtinPresets(bandCount)
      .filter((p) => !names.has(p.name))
      .map((preset) => ({ preset, builtin: true })),
  ];
}

export function presetExpressions(preset: Preset): string[] {
  if (preset.red !== undefined || preset.green !== undefined || preset.blue !== undefined) {
    return [preset.red ?? '0', preset.green ?? '0', preset.blue ?? '0'];
  }
  return [preset.value ?? 'b1'];
}

export function presetRanges(preset: Preset, count: number): (Range | null)[] {
  const range = preset.range ?? [0, 1];
  const one = (r: unknown): Range | null =>
    Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === 'number' && Number.isFinite(v)) ? [r[0], r[1]] : null;
  if (range === 'auto') return new Array(count).fill(null);
  if (Array.isArray(range) && range.length === 2 && typeof range[0] === 'number') {
    return new Array(count).fill(one(range));
  }
  const list = range as (Range | 'auto')[];
  return Array.from({ length: count }, (_, i) => (list[i] === undefined ? [0, 1] : one(list[i])));
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
  const gamma = typeof preset.gamma === 'number' && preset.gamma > 0 ? preset.gamma : 1;
  return {
    expressions,
    bands: bandVariables(bandCount, descriptions, preset.bands),
    ranges: presetRanges(preset, expressions.length),
    colormap: expressions.length === 1 ? (preset.colormap ?? 'gray') : 'gray',
    gamma,
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
      ['red', 'green', 'blue', 'value'].some((k) => typeof (p as Record<string, unknown>)[k] === 'string'),
  );
}
