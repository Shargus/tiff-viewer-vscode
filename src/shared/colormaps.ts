/**
 * Colour maps for single-expression composites, as evenly spaced control
 * colours (matplotlib / ColorBrewer), interpolated into 256-entry tables.
 */
const STOPS: Record<string, string[]> = {
  gray: ['#000000', '#ffffff'],
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  plasma: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
  turbo: [
    '#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#24eca6', '#61fc6c', '#a4fc3b',
    '#d1e834', '#f3c63a', '#fe9b2d', '#f36315', '#d93806', '#b11901', '#7a0403',
  ],
  RdYlGn: ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850', '#006837'],
  RdBu: ['#67001f', '#b2182b', '#d6604d', '#f4a582', '#fddbc7', '#f7f7f7', '#d1e5f0', '#92c5de', '#4393c3', '#2166ac', '#053061'],
  Spectral: ['#9e0142', '#d53e4f', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#e6f598', '#abdda4', '#66c2a5', '#3288bd', '#5e4fa2'],
  terrain: ['#333399', '#1177ee', '#00bb99', '#55dd66', '#ccee88', '#eedd88', '#bb9966', '#886655', '#aa9999', '#ffffff'],
};

export const COLORMAP_NAMES = Object.keys(STOPS);

const tables = new Map<string, Uint8Array>();

/** 256 RGB triplets for a colour map name (gray when unknown; a "_r" suffix reverses it). */
export function colormapTable(name: string): Uint8Array {
  let table = tables.get(name);
  if (table) return table;
  const reversed = name.endsWith('_r');
  const stops = (STOPS[reversed ? name.slice(0, -2) : name] ?? STOPS.gray).map((hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]);
  if (reversed) stops.reverse();
  table = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) table[i * 3 + c] = Math.round(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f);
  }
  tables.set(name, table);
  return table;
}
