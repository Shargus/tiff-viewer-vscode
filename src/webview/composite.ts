import { colormapTable } from '../shared/colormaps';
import { compileExpressions, type CompiledExpressions } from '../shared/expression';
import type { CompositeSpec, Range } from '../shared/presets';
import type { ToneMode } from '../shared/protocol';

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
  const key = JSON.stringify([spec.expressions, spec.bands]);
  let compiled = compiledCache.get(key);
  if (!compiled) {
    compiled = compileExpressions(spec.expressions, spec.bands);
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

/** The value range shown for each channel: fixed, or from statistics with the tone setting. */
export function channelRanges(spec: CompositeSpec, tone: ToneMode, stats: ChannelStats[] | undefined): Range[] {
  return spec.ranges.map((range, c) => {
    if (range) return range;
    const s = stats?.[c] ?? { min: 0, max: 1, p02: 0, p98: 1 };
    return tone === 'percentile' ? [s.p02, s.p98] : [s.min, s.max];
  });
}

/**
 * Converts evaluated channels to RGBA. A pixel is transparent when every
 * channel is NaN (no data); a single NaN channel shows as zero.
 */
export function compositeToRGBA(
  spec: CompositeSpec,
  channels: Float32Array[],
  n: number,
  tone: ToneMode,
  stats: ChannelStats[] | undefined,
  out = new Uint8ClampedArray(n * 4),
): Uint8ClampedArray {
  const ranges = channelRanges(spec, tone, stats);
  // Scaling and gamma go through a 4096-step lookup, which keeps pow() out of the pixel loop.
  const STEPS = 4096;
  const curve = new Float32Array(STEPS + 1);
  for (let i = 0; i <= STEPS; i++) curve[i] = (i / STEPS) ** (1 / spec.gamma);
  const scale = ranges.map(([lo, hi]) => (hi !== lo ? STEPS / (hi - lo) : 0));
  const offset = ranges.map(([lo]) => lo);
  const level = (v: number, c: number) => {
    if (v !== v) return 0;
    const t = (v - offset[c]) * scale[c];
    return curve[t <= 0 ? 0 : t >= STEPS ? STEPS : t | 0];
  };

  if (channels.length === 1) {
    const table = colormapTable(spec.colormap);
    const values = channels[0];
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const v = values[i];
      if (v !== v) continue;
      const k = Math.round(level(v, 0) * 255) * 3;
      out[o] = table[k];
      out[o + 1] = table[k + 1];
      out[o + 2] = table[k + 2];
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
    out[o] = level(vr, 0) * 255;
    out[o + 1] = level(vg, 1) * 255;
    out[o + 2] = level(vb, 2) * 255;
    out[o + 3] = 255;
  }
  return out;
}
