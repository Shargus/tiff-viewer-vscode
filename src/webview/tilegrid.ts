import { MERCATOR_HALF } from './geo';

/** One zoom level of a tile grid. */
export interface TileMatrix {
  id: string;
  /** Grid units (metres or degrees) per tile pixel. */
  resolution: number;
  /** Top-left corner of the matrix, in grid units (x = easting / longitude). */
  originX: number;
  originY: number;
  tileWidth: number;
  tileHeight: number;
  matrixWidth: number;
  matrixHeight: number;
}

/** A tile grid in Web Mercator or in longitude/latitude (the two kinds basemaps use). */
export interface TileGrid {
  crs: 'mercator' | 'lonlat';
  /** Coarse to fine. */
  matrices: TileMatrix[];
}

/** Where tiles come from. */
export interface TileSource {
  /** Identifies the source in caches. */
  key: string;
  grid: TileGrid;
  url(matrix: TileMatrix, col: number, row: number): string;
  attribution: string;
}

/** The standard Web Mercator ("Google") grid, levels 0 … maxZoom. */
export function webMercatorGrid(maxZoom: number, tileSize = 256): TileGrid {
  return {
    crs: 'mercator',
    matrices: Array.from({ length: maxZoom + 1 }, (_, z) => ({
      id: String(z),
      resolution: (2 * MERCATOR_HALF) / (tileSize * 2 ** z),
      originX: -MERCATOR_HALF,
      originY: MERCATOR_HALF,
      tileWidth: tileSize,
      tileHeight: tileSize,
      matrixWidth: 2 ** z,
      matrixHeight: 2 ** z,
    })),
  };
}

/** Bing's quadkey for a tile. */
export function quadkey(z: number, x: number, y: number): string {
  let key = '';
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    key += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return key;
}

/** An XYZ source: a URL with {z}, {x}, {y} (or {-y}, TMS) and/or {q} (Bing quadkey). */
export function xyzSource(template: string, attribution: string, maxZoom: number): TileSource {
  return {
    key: template,
    grid: webMercatorGrid(maxZoom),
    attribution,
    url(matrix, col, row) {
      const z = Number(matrix.id);
      return template
        .replace(/\{z\}/g, String(z))
        .replace(/\{x\}/g, String(col))
        .replace(/\{y\}/g, String(row))
        .replace(/\{-y\}/g, String(2 ** z - 1 - row))
        .replace(/\{q\}/g, quadkey(z, col, row));
    },
  };
}

// ---------------------------------------------------------------------------
// WMTS capabilities
// ---------------------------------------------------------------------------

export interface WmtsLayer {
  id: string;
  title: string;
  format: string;
  style: string;
  /** Dimensions (e.g. Time) with their default values and, when listed, their values. */
  dimensions: { id: string; default: string; values: string[] }[];
  grid: TileGrid;
  matrixSet: string;
  /** REST template, or undefined to use the KVP GetTile endpoint. */
  template?: string;
}

export interface WmtsCapabilities {
  layers: WmtsLayer[];
  /** GetTile KVP endpoint (for layers without a REST template). */
  getTileUrl?: string;
}

const METERS_PER_DEGREE = (2 * Math.PI * 6378137) / 360;
const OWS = 'http://www.opengis.net/ows/1.1';
const WMTS = 'http://www.opengis.net/wmts/1.0';

/** Child elements (childNodes, which every DOM implementation has). */
function elements(el: Element): Element[] {
  return Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1);
}

/**
 * Elements are matched by local name: names are unambiguous in WMTS
 * capabilities, and some services write the namespaces differently (Esri's
 * Wayback uses https:// namespace URIs). `ns` documents which one is meant.
 */
function child(el: Element, _ns: string, name: string): Element | undefined {
  return elements(el).find((c) => c.localName === name);
}

function children(el: Element, _ns: string, name: string): Element[] {
  return elements(el).filter((c) => c.localName === name);
}

function descendants(el: Element, name: string): Element[] {
  return Array.from(el.getElementsByTagName('*')).filter((e) => e.localName === name);
}

function text(el: Element | undefined): string {
  return el?.textContent?.trim() ?? '';
}

/** Tile matrix sets in Web Mercator or longitude/latitude; others (e.g. UTM grids) are left out. */
function parseMatrixSet(set: Element): TileGrid | undefined {
  const crs = text(child(set, OWS, 'SupportedCRS'));
  const id = text(child(set, OWS, 'Identifier'));
  let kind: TileGrid['crs'];
  let latFirst = false;
  if (/3857|900913|GoogleMapsCompatible/i.test(crs) || /GoogleMapsCompatible/i.test(id)) {
    kind = 'mercator';
  } else if (/CRS84/i.test(crs)) {
    kind = 'lonlat';
  } else if (/EPSG:[0-9.]*:?4326$|EPSG::4326$|EPSG:4326$/i.test(crs)) {
    // EPSG:4326 is latitude first.
    kind = 'lonlat';
    latFirst = true;
  } else {
    return undefined;
  }
  const metersPerUnit = kind === 'mercator' ? 1 : METERS_PER_DEGREE;
  const matrices: TileMatrix[] = children(set, WMTS, 'TileMatrix').map((m) => {
    const corner = text(child(m, WMTS, 'TopLeftCorner')).split(/\s+/).map(Number);
    const [originX, originY] = latFirst ? [corner[1], corner[0]] : [corner[0], corner[1]];
    return {
      id: text(child(m, OWS, 'Identifier')),
      resolution: (Number(text(child(m, WMTS, 'ScaleDenominator'))) * 0.00028) / metersPerUnit,
      originX,
      originY,
      tileWidth: Number(text(child(m, WMTS, 'TileWidth'))),
      tileHeight: Number(text(child(m, WMTS, 'TileHeight'))),
      matrixWidth: Number(text(child(m, WMTS, 'MatrixWidth'))),
      matrixHeight: Number(text(child(m, WMTS, 'MatrixHeight'))),
    };
  });
  matrices.sort((a, b) => b.resolution - a.resolution);
  return matrices.length && matrices.every((m) => Number.isFinite(m.resolution) && m.resolution > 0) ? { crs: kind, matrices } : undefined;
}

/** Image layers of a WMTS capabilities document, each on a Web Mercator or lon/lat grid (Mercator preferred). */
export function parseWmtsCapabilities(xml: string): WmtsCapabilities {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  const contents = child(root, WMTS, 'Contents');
  if (!contents) throw new Error('Not a WMTS capabilities document');
  const sets = new Map<string, TileGrid>();
  for (const set of children(contents, WMTS, 'TileMatrixSet')) {
    const grid = parseMatrixSet(set);
    if (grid) sets.set(text(child(set, OWS, 'Identifier')), grid);
  }
  let getTileUrl: string | undefined;
  for (const op of descendants(root, 'Operation')) {
    if (op.getAttribute('name') !== 'GetTile') continue;
    for (const get of descendants(op, 'Get')) {
      const href = Array.from(get.attributes).find((a) => a.localName === 'href')?.value;
      const encoding = text(descendants(get, 'Value')[0]);
      if (href && (!encoding || /KVP/i.test(encoding))) getTileUrl = href;
    }
  }
  const layers: WmtsLayer[] = [];
  for (const layer of children(contents, WMTS, 'Layer')) {
    const formats = children(layer, WMTS, 'Format').map(text);
    const format = formats.find((f) => /^image\//.test(f));
    if (!format) continue; // Vector tile layers need styles that are not available.
    const links = children(layer, WMTS, 'TileMatrixSetLink').map((l) => text(child(l, WMTS, 'TileMatrixSet')));
    const matrixSet = links.find((id) => sets.get(id)?.crs === 'mercator') ?? links.find((id) => sets.has(id));
    if (!matrixSet) continue;
    const styles = children(layer, WMTS, 'Style');
    const style = text(child(styles.find((s) => s.getAttribute('isDefault') === 'true') ?? styles[0] ?? layer, OWS, 'Identifier')) || 'default';
    const dimensions = children(layer, WMTS, 'Dimension').map((d) => ({
      id: text(child(d, OWS, 'Identifier')),
      default: text(child(d, WMTS, 'Default')) || 'default',
      values: children(d, WMTS, 'Value').map(text),
    }));
    const resource = children(layer, WMTS, 'ResourceURL').find((r) => r.getAttribute('resourceType') === 'tile' && /^image\//.test(r.getAttribute('format') ?? ''));
    layers.push({
      id: text(child(layer, OWS, 'Identifier')),
      title: text(child(layer, OWS, 'Title')) || text(child(layer, OWS, 'Identifier')),
      format: resource?.getAttribute('format') ?? format,
      style,
      dimensions,
      grid: sets.get(matrixSet)!,
      matrixSet,
      template: resource?.getAttribute('template') ?? undefined,
    });
  }
  if (!layers.length) throw new Error('No image layers in a supported tile grid');
  return { layers, getTileUrl };
}

/** A tile source for a WMTS layer; `dimensionValues` overrides dimension defaults (e.g. { Time: '2024-05-01' }). */
export function wmtsSource(
  caps: WmtsCapabilities,
  layer: WmtsLayer,
  attribution: string,
  dimensionValues: Record<string, string> = {},
): TileSource {
  const values = Object.fromEntries(layer.dimensions.map((d) => [d.id.toLowerCase(), dimensionValues[d.id] || d.default]));
  const key = `wmts|${layer.template ?? caps.getTileUrl}|${layer.id}|${JSON.stringify(values)}`;
  return {
    key,
    grid: layer.grid,
    attribution,
    url(matrix, col, row) {
      if (layer.template) {
        return layer.template.replace(/\{([^}]+)\}/g, (all, name: string) => {
          switch (name.toLowerCase()) {
            case 'tilematrixset':
              return layer.matrixSet;
            case 'tilematrix':
              return matrix.id;
            case 'tilerow':
              return String(row);
            case 'tilecol':
              return String(col);
            case 'style':
              return layer.style;
            default:
              return values[name.toLowerCase()] ?? all;
          }
        });
      }
      const base = caps.getTileUrl ?? '';
      const params = new URLSearchParams({
        SERVICE: 'WMTS',
        REQUEST: 'GetTile',
        VERSION: '1.0.0',
        LAYER: layer.id,
        STYLE: layer.style,
        FORMAT: layer.format,
        TILEMATRIXSET: layer.matrixSet,
        TILEMATRIX: matrix.id,
        TILEROW: String(row),
        TILECOL: String(col),
      });
      for (const d of layer.dimensions) params.set(d.id.toUpperCase(), values[d.id.toLowerCase()]);
      return `${base}${base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?'}${params}`;
    },
  };
}
