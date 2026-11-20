import { colormapTable } from './colormaps';

/**
 * Paletted / unique values rendering, as in QGIS: each listed value gets a
 * colour (with opacity) and a label; other values are transparent.
 */

/** A class as stored in a preset. */
export interface PaletteClass {
  value: number;
  /** "#rrggbb", or "#rrggbbaa" with opacity. */
  color: string;
  label?: string;
}

export type RGBA = [number, number, number, number];

/** The default colour of a new class (QGIS's). */
export const DEFAULT_CLASS_COLOR: RGBA = [200, 200, 200, 255];

/** Most classes a paletted rendering can have (Classify, files, colour tables and presets). */
export const MAX_CLASSES = 256;

/** "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" to RGBA (0…255); undefined if invalid. */
export function parseHexColor(text: string): RGBA | undefined {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text.trim());
  if (!m) return undefined;
  let hex = m[1];
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), hex.length === 8 ? n(6) : 255];
}

/** RGBA to "#rrggbb", with "aa" appended when not opaque. */
export function toHexColor([r, g, b, a]: RGBA): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}${a < 255 ? h(a) : ''}`;
}

/** A value as a class label (as QGIS does: the number itself). */
export function valueLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)));
}

/** HSV (h 0…359, s and v 0…255, as in Qt) to RGB 0…255. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const sf = s / 255;
  const vf = v / 255;
  const c = vf * sf;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = vf - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * QGIS's "Random colors" ramp for `count` classes: hues evenly spaced from a
 * random start, saturation 100…240 and value 200…240 (Qt's 0…255 scale),
 * then shuffled.
 */
export function randomColors(count: number, random: () => number = Math.random): RGBA[] {
  const colors: RGBA[] = [];
  let hue = 360 * random();
  const step = 359 / Math.max(1, count);
  for (let i = 0; i < count; i++) {
    const s = 100 + Math.floor(random() * 141);
    const v = 200 + Math.floor(random() * 41);
    colors.push([...hsvToRgb(Math.round(hue) % 360, s, v), 255]);
    hue += step;
  }
  for (let i = colors.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }
  return colors;
}

/** Ramps offered for paletted classes: QGIS's random colours, then the colour maps. */
export const RANDOM_RAMP = 'random';

/**
 * Colours for `count` classes from a ramp, as QGIS assigns them: class i gets
 * the ramp's colour at i / (count - 1).
 */
export function rampColors(ramp: string, count: number): RGBA[] {
  if (ramp === RANDOM_RAMP) return randomColors(count);
  const table = colormapTable(ramp);
  const last = Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => {
    const k = Math.round((i / last) * 255) * 3;
    return [table[k], table[k + 1], table[k + 2], 255];
  });
}

/**
 * Reads a colour map file in QGIS's format, one class per line:
 * "value r g b [alpha] [label…]", or "value #colour", or "value" alone.
 * Separators are spaces, commas or colons; other lines (comments,
 * "INTERPOLATION:…") are skipped. QGIS reads integer values only; any number
 * is accepted here. `parseColorName` reads a colour given by name or hex.
 */
export function parseColorMap(text: string, parseColorName: (name: string) => RGBA | undefined = parseHexColor): { value: number; color: RGBA; label: string }[] {
  const classes: { value: number; color: RGBA; label: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(/[\s,:]+/).filter(Boolean);
    if (!parts.length) continue;
    const value = Number(parts[0]);
    if (!Number.isFinite(value) || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(parts[0])) continue;
    if (parts.length === 1) {
      classes.push({ value, color: [...DEFAULT_CLASS_COLOR], label: valueLabel(value) });
    } else if (parts.length === 2) {
      classes.push({ value, color: parseColorName(parts[1]) ?? [...DEFAULT_CLASS_COLOR], label: valueLabel(value) });
    } else if (parts.length >= 4) {
      const [r, g, b] = parts.slice(1, 4).map(Number);
      if (![r, g, b].every(Number.isFinite)) continue;
      const a = parts.length >= 5 && Number.isFinite(Number(parts[4])) ? Number(parts[4]) : 255;
      const label = parts.length > 5 ? parts.slice(5).join(' ') : '';
      classes.push({ value, color: [r, g, b, a], label });
    }
  }
  return classes;
}

/** Writes classes as QGIS exports them: sorted by value, "value r g b alpha label" per line. */
export function colorMapToString(classes: { value: number; color: RGBA; label: string }[]): string {
  return [...classes]
    .sort((a, b) => a.value - b.value)
    .map((c) => `${valueLabel(c.value)} ${c.color[0]} ${c.color[1]} ${c.color[2]} ${c.color[3]} ${c.label}`.trimEnd())
    .join('\n');
}
