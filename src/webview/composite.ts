import { colormapTable } from '../shared/colormaps';
import { compileExpressions, type CompiledExpressions } from '../shared/expression';
import type { CompositeSpec, Range } from '../shared/presets';

/** Statistics of one composite channel, for ranges stretched automatically. */
export interface ChannelStats {
  min: number;
  max: number;
  p02: number;
  p98: number;
}

export function compositeKey(spec: CompositeSpec): string {
  return JSON.stringify(spec);
}

const compiledCache = new Map<string, CompiledExpressions>();

export function compileComposite(spec: CompositeSpec): CompiledExpressions {
  const key = JSON.stringify([spec.expressions, spec.bands, spec.variables]);
  let compiled = compiledCache.get(key);
  if (!compiled) {
    compiled = compileExpressions(spec.expressions, spec.bands, spec.variables);
    if (compiledCache.size > 32) compiledCache.clear();
    compiledCache.set(key, compiled);
  }
  return compiled;
}

/** Samples to read for a composite (at least one, so that constant expressions still get a size). */
export function compositeSamples(compiled: CompiledExpressions): number[] {
  return compiled.samples.length ? compiled.samples : [0];
}

export function channelStats(channels: Float32Array[]): ChannelStats[] {
  return channels.map((values) => {
    const step = Math.max(1, Math.floor(values.length / (1 << 20)));
    const finite: number[] = [];
    for (let i = 0; i < values.length; i += step) {
      const v = values[i];
      if (Number.isFinite(v)) finite.push(v);
    }
    if (finite.length === 0) return { min: 0, max: 1, p02: 0, p98: 1 };
    const sorted = Float64Array.from(finite).sort();
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
    return { min: sorted[0], max: sorted[sorted.length - 1], p02: at(0.02), p98: at(0.98) };
  });
}

/**
 * The value range shown for each channel: fixed, or from statistics (min/max
 * or 2%/98%), or the full range of the data type (`fullRange`; min/max when
 * the data has none, e.g. floating point).
 */
export function channelRanges(spec: CompositeSpec, stats: ChannelStats[] | undefined, fullRange?: Range): Range[] {
  return spec.ranges.map((range, c) => {
    if (Array.isArray(range)) return range;
    const s = stats?.[c] ?? { min: 0, max: 1, p02: 0, p98: 1 };
    if (range === 'full' && fullRange) return fullRange;
    return range === 'percentile' ? [s.p02, s.p98] : [s.min, s.max];
  });
}

/** Whether an automatic stretch needs statistics of the page. */
export function needsStats(spec: CompositeSpec): boolean {
  return spec.ranges.some((range) => range === 'minmax' || range === 'percentile');
}

/**
 * QGIS's brightness / contrast / gamma filter on a colour component in 0…1:
 * ((c - 0.5) · ((contrast + 100) / 100)² + 0.5 + brightness / 255) ^ (1 / gamma), clamped.
 */
function adjustComponent(c: number, brightness: number, contrastFactor: number, inverseGamma: number): number {
  const v = (c - 0.5) * contrastFactor + 0.5 + brightness / 255;
  return v <= 0 ? 0 : v >= 1 ? 1 : inverseGamma === 1 ? v : v ** inverseGamma;
}

/**
 * Converts evaluated channels to RGBA, like a QGIS raster renderer followed
 * by its brightness/contrast/gamma and hue/saturation filters. A pixel is
 * transparent when every channel is NaN (no data); a single NaN channel
 * shows as zero.
 */
export function compositeToRGBA(
  spec: CompositeSpec,
  channels: Float32Array[],
  n: number,
  stats: ChannelStats[] | undefined,
  fullRange?: Range,
  out = new Uint8ClampedArray(n * 4),
): Uint8ClampedArray {
  const ranges = channelRanges(spec, stats, fullRange);
  const brightness = spec.brightness ?? 0;
  const contrast = spec.contrast ?? 0;
  const saturation = spec.saturation ?? 0;
  const gamma = spec.gamma ?? 1;
  const adjusted = brightness !== 0 || contrast !== 0 || gamma !== 1;

  // Brightness/contrast/gamma through a lookup table over 0…1 (keeps pow() out of the
  // pixel loop); without adjustments values are scaled exactly.
  const STEPS = 4096;
  const curve = new Float32Array(STEPS + 1);
  const contrastFactor = ((contrast + 100) / 100) ** 2;
  for (let i = 0; i <= STEPS; i++) curve[i] = adjustComponent(i / STEPS, brightness, contrastFactor, 1 / gamma);
  const adjust = (t: number) => (adjusted ? curve[Math.round(t * STEPS)] : t);

  // QGIS's saturation: HSL saturation S becomes S · k below 1, or 1 - (1 - S)^(k²) above (k = 1 + saturation / 100).
  // With hue and lightness kept, each component moves away from the lightness in proportion to S.
  const k = 1 + saturation / 100;
  const saturate = (rgb: [number, number, number]): void => {
    const [r, g, b] = rgb;
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const d = max - min;
    if (d === 0) return;
    const l = (max + min) / 2;
    // (Rounding can put S a hair above 1, where the power below would give NaN.)
    const s = Math.min(1, l > 0.5 ? d / (2 - max - min) : d / (max + min));
    const s2 = k < 1 ? s * k : 1 - (1 - s) ** (k * k);
    const f = s2 / s;
    rgb[0] = l + (r - l) * f;
    rgb[1] = l + (g - l) * f;
    rgb[2] = l + (b - l) * f;
  };

  if (spec.classes) {
    return palettedToRGBA(spec.classes, channels[0], n, out, (rgb) => {
      if (adjusted) for (let c = 0; c < 3; c++) rgb[c] = adjust(rgb[c]);
      if (saturation !== 0) saturate(rgb);
    });
  }

  const scale = ranges.map(([lo, hi]) => (hi !== lo ? 1 / (hi - lo) : 0));
  const offset = ranges.map(([lo]) => lo);
  const level = (v: number, c: number) => {
    if (v !== v) return 0;
    const t = (v - offset[c]) * scale[c];
    return t <= 0 ? 0 : t >= 1 ? 1 : t;
  };
  const rgb: [number, number, number] = [0, 0, 0];

  if (channels.length === 1) {
    const table = colormapTable(spec.colormap);
    const values = channels[0];
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const v = values[i];
      if (v !== v) continue;
      const m = Math.round(level(v, 0) * 255) * 3;
      if (!adjusted && saturation === 0) {
        out[o] = table[m];
        out[o + 1] = table[m + 1];
        out[o + 2] = table[m + 2];
      } else {
        // The colour map gives the colours; the filters apply to them, as in QGIS.
        rgb[0] = adjust(table[m] / 255);
        rgb[1] = adjust(table[m + 1] / 255);
        rgb[2] = adjust(table[m + 2] / 255);
        if (saturation !== 0) saturate(rgb);
        out[o] = rgb[0] * 255;
        out[o + 1] = rgb[1] * 255;
        out[o + 2] = rgb[2] * 255;
      }
      out[o + 3] = 255;
    }
    return out;
  }
  const [r, g, b] = channels;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const vr = r[i];
    const vg = g[i];
    const vb = b[i];
    if (vr !== vr && vg !== vg && vb !== vb) continue;
    rgb[0] = adjust(level(vr, 0));
    rgb[1] = adjust(level(vg, 1));
    rgb[2] = adjust(level(vb, 2));
    if (saturation !== 0) saturate(rgb);
    out[o] = rgb[0] * 255;
    out[o + 1] = rgb[1] * 255;
    out[o + 2] = rgb[2] * 255;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * Paletted / unique values rendering (as QGIS's): each listed value gets its
 * class colour and opacity; NoData and values not listed are transparent.
 * `adjustColor` applies the colour adjustments (on components 0…1) to each
 * class colour once.
 */
function palettedToRGBA(
  classes: NonNullable<CompositeSpec['classes']>,
  values: Float32Array,
  n: number,
  out: Uint8ClampedArray,
  adjustColor: (rgb: [number, number, number]) => void,
): Uint8ClampedArray {
  // Keys as float32, the precision of the evaluated values (so that 0.1 matches 0.1).
  const colors = new Map<number, number>();
  for (const { value, rgba } of classes) {
    const key = Math.fround(value);
    if (colors.has(key)) continue; // The first class listed for a value wins.
    const rgb: [number, number, number] = [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255];
    adjustColor(rgb);
    const r = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255);
    const g = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255);
    const b = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255);
    colors.set(key, (r | (g << 8) | (b << 16) | (Math.round(Math.min(255, Math.max(0, rgba[3]))) << 24)) >>> 0);
  }
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const v = values[i];
    if (v !== v) continue;
    const c = colors.get(v);
    if (c === undefined) continue;
    out[o] = c & 255;
    out[o + 1] = (c >>> 8) & 255;
    out[o + 2] = (c >>> 16) & 255;
    out[o + 3] = c >>> 24;
  }
  return out;
}
