import { kmlWithFolders } from '@tmcw/togeojson';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { toProj4 } from 'geotiff-geokeys-to-proj4';
import JSZip from 'jszip';
import shp from 'shpjs';
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js';
import type { OverlayFile } from '../shared/protocol';

/**
 * Reading vector files for overlays: GeoJSON, KML, KMZ, Shapefile (with its
 * .dbf/.prj/.cpg), GeoPackage, and zips of these. Each yields one or more
 * layers as GeoJSON in their own coordinate system (`crs`: undefined for
 * longitude/latitude, else a proj4 definition and possibly its EPSG code).
 */

export interface VectorData {
  name: string;
  features: FeatureCollection;
  crs?: { proj4: string; epsg?: number };
}

/** A proj4 definition for an EPSG code (projected or geographic), from the GeoTIFF key tables. */
export function epsgToProj4(code: number): string | undefined {
  if (code === 4326 || code === 4979) return undefined;
  for (const keys of [{ ProjectedCSTypeGeoKey: code, GTModelTypeGeoKey: 1 }, { GeographicTypeGeoKey: code, GTModelTypeGeoKey: 2 }]) {
    try {
      const result = toProj4(keys as never);
      if (/\+proj=/.test(result.proj4) && !Object.keys(result.errors).length) return result.proj4;
    } catch {
      // Try the next kind of code.
    }
  }
  return undefined;
}

function crsFromEpsg(code: number): VectorData['crs'] | 'unknown' {
  if (code === 4326 || code === 4979 || code === 4258) return undefined;
  const proj4 = epsgToProj4(code);
  return proj4 ? { proj4, epsg: code } : 'unknown';
}

const decoder = new TextDecoder();

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function asCollection(value: unknown): FeatureCollection {
  const v = value as { type?: string };
  if (v?.type === 'FeatureCollection') return value as FeatureCollection;
  if (v?.type === 'Feature') return { type: 'FeatureCollection', features: [value as Feature] };
  if (v?.type) return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: value as Geometry }] };
  throw new Error('Not GeoJSON');
}

function readGeoJson(name: string, text: string): VectorData {
  const json = JSON.parse(text);
  const features = asCollection(json);
  // GeoJSON 2008 allowed a "crs" member; RFC 7946 is always longitude/latitude.
  const crsName = (json?.crs?.properties?.name ?? '') as string;
  const code = Number(/EPSG:{1,2}(\d+)$/i.exec(crsName)?.[1]);
  if (crsName && !/CRS84$/i.test(crsName) && Number.isFinite(code)) {
    const crs = crsFromEpsg(code);
    if (crs === 'unknown') throw new Error(`${name}: unknown coordinate system ${crsName}`);
    return { name, features, crs };
  }
  return { name, features };
}

/**
 * KML: one layer per folder that holds features (named by its folder path,
 * as GDAL's KML driver does), plus one for features outside any folder.
 */
function readKml(name: string, text: string): VectorData[] {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`${name}: not valid KML`);
  type Node = ReturnType<typeof kmlWithFolders>['children'][number];
  const layers: { path: string[]; features: Feature[] }[] = [];
  const walk = (children: Node[], path: string[]) => {
    const features = children.filter((c): c is Feature => c.type === 'Feature');
    if (features.length) layers.push({ path, features });
    children.forEach((c, i) => {
      if (c.type === 'folder') walk(c.children, [...path, String(c.meta?.name ?? `Folder ${i + 1}`)]);
    });
  };
  walk(kmlWithFolders(doc).children, []);
  if (!layers.length) return [{ name, features: { type: 'FeatureCollection', features: [] } }];
  return layers.map((l) => ({
    name: layers.length === 1 || !l.path.length ? name : `${name}: ${l.path.join(' / ')}`,
    features: { type: 'FeatureCollection', features: l.features },
  }));
}

async function readShapefile(name: string, files: OverlayFile[]): Promise<VectorData> {
  const part = (ext: string) => files.find((f) => f.name.toLowerCase().endsWith(`.${ext}`));
  const shpFile = part('shp');
  if (!shpFile) throw new Error(`${name}: no .shp`);
  const result = await shp({
    shp: toBuffer(shpFile.data),
    dbf: part('dbf') ? toBuffer(part('dbf')!.data) : undefined,
    prj: part('prj') ? decoder.decode(part('prj')!.data) : undefined,
    cpg: part('cpg') ? decoder.decode(part('cpg')!.data) : undefined,
  });
  return { name, features: Array.isArray(result) ? result[0] : result };
}

// --- GeoPackage ---

let sqlJs: ReturnType<typeof initSqlJs> | undefined;

/** OGC WKB (with ISO or EWKB Z/M flags) to a GeoJSON geometry. */
export function parseWkb(view: DataView, start = 0): { geometry: Geometry | null; end: number } {
  let pos = start;
  const read = (): Geometry | null => {
    const little = view.getUint8(pos) === 1;
    pos += 1;
    let type = view.getUint32(pos, little);
    pos += 4;
    let dims = 2;
    if (type & 0x80000000) dims++; // EWKB Z
    if (type & 0x40000000) dims++; // EWKB M
    if (type & 0x20000000) pos += 4; // EWKB SRID
    type &= 0x0fffffff;
    if (type >= 3000) {
      dims = 4;
      type -= 3000;
    } else if (type >= 2000 || type >= 1000) {
      dims = 3;
      type %= 1000;
    }
    const point = (): Position => {
      const p: Position = [view.getFloat64(pos, little), view.getFloat64(pos + 8, little)];
      pos += dims * 8;
      return p;
    };
    const count = () => {
      const n = view.getUint32(pos, little);
      pos += 4;
      return n;
    };
    const points = () => Array.from({ length: count() }, point);
    const rings = () => Array.from({ length: count() }, points);
    switch (type) {
      case 1: {
        const p = point();
        return Number.isNaN(p[0]) ? null : { type: 'Point', coordinates: p };
      }
      case 2:
        return { type: 'LineString', coordinates: points() };
      case 3:
        return { type: 'Polygon', coordinates: rings() };
      case 4:
      case 5:
      case 6:
      case 7: {
        const parts = Array.from({ length: count() }, read).filter((g): g is Geometry => !!g);
        if (type === 7) return { type: 'GeometryCollection', geometries: parts };
        if (type === 4) return { type: 'MultiPoint', coordinates: parts.map((g) => (g as { coordinates: Position }).coordinates) };
        if (type === 5) return { type: 'MultiLineString', coordinates: parts.map((g) => (g as { coordinates: Position[] }).coordinates) };
        return { type: 'MultiPolygon', coordinates: parts.map((g) => (g as { coordinates: Position[][] }).coordinates) };
      }
      default:
        throw new Error(`Unsupported WKB geometry type ${type}`);
    }
  };
  const geometry = read();
  return { geometry, end: pos };
}

/** A GeoPackage geometry blob: "GP" header (with optional envelope), then WKB. */
export function parseGpkgGeometry(blob: Uint8Array): Geometry | null {
  if (blob.length < 8 || blob[0] !== 0x47 || blob[1] !== 0x50) return null;
  const flags = blob[3];
  if (flags & 0x10) return null; // Empty geometry.
  const envelope = [0, 32, 48, 48, 64][(flags >> 1) & 7] ?? 0;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return parseWkb(view, 8 + envelope).geometry;
}

async function readGeoPackage(name: string, data: Uint8Array): Promise<VectorData[]> {
  sqlJs ??= initSqlJs({ locateFile: () => window.TIFF_SQLJS_WASM_URL });
  const SQL = await sqlJs;
  const db = new SQL.Database(data);
  try {
    const rows = (sql: string) => {
      const [result] = db.exec(sql);
      return result ? result.values.map((v) => Object.fromEntries(result.columns.map((c, i) => [c, v[i]]))) : [];
    };
    const srs = new Map(rows('SELECT srs_id, organization, organization_coordsys_id, definition FROM gpkg_spatial_ref_sys').map((r) => [Number(r.srs_id), r]));
    const layers: VectorData[] = [];
    for (const g of rows("SELECT g.table_name, g.column_name, g.srs_id FROM gpkg_geometry_columns g JOIN gpkg_contents c ON c.table_name = g.table_name WHERE c.data_type = 'features'")) {
      const table = String(g.table_name);
      const column = String(g.column_name);
      const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;
      const [result] = db.exec(`SELECT * FROM ${quote(table)}`);
      const features: Feature[] = [];
      if (result) {
        const gi = result.columns.indexOf(column);
        for (const values of result.values) {
          const blob = values[gi];
          const geometry = blob instanceof Uint8Array ? parseGpkgGeometry(blob) : null;
          if (!geometry) continue;
          const properties = Object.fromEntries(result.columns.map((c, i) => [c, values[i]]).filter(([c, v]) => c !== column && !(v instanceof Uint8Array)));
          features.push({ type: 'Feature', properties, geometry });
        }
      }
      const srsId = Number(g.srs_id);
      const ref = srs.get(srsId);
      let crs: VectorData['crs'];
      if (srsId === 4326 || srsId === 0 || (ref && String(ref.organization).toUpperCase() === 'EPSG' && Number(ref.organization_coordsys_id) === 4326)) {
        crs = undefined;
      } else if (ref && String(ref.organization).toUpperCase() === 'EPSG' && epsgToProj4(Number(ref.organization_coordsys_id))) {
        const code = Number(ref.organization_coordsys_id);
        crs = { proj4: epsgToProj4(code)!, epsg: code };
      } else if (ref && typeof ref.definition === 'string' && ref.definition !== 'undefined') {
        crs = { proj4: ref.definition };
      } else {
        throw new Error(`${name} (${table}): unknown coordinate system (srs_id ${srsId})`);
      }
      layers.push({ name: `${name}: ${table}`, features: { type: 'FeatureCollection', features }, crs });
    }
    if (!layers.length) throw new Error(`${name}: no feature tables`);
    return layers;
  } finally {
    db.close();
  }
}

// --- Dispatch ---

function extension(name: string): string {
  return /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
}

async function readZip(name: string, data: Uint8Array): Promise<VectorData[]> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name));
  if (entries.some((f) => /\.gdb\//i.test(f.name)) && !entries.some((f) => /\.(shp|geojson|json|kml|gpkg)$/i.test(f.name))) {
    throw new Error(`${name}: File Geodatabase (.gdb) is not supported. Export the layers to GeoPackage or GeoJSON.`);
  }
  const layers: VectorData[] = [];
  if (entries.some((f) => extension(f.name) === 'shp')) {
    const result = await shp(toBuffer(data));
    for (const fc of Array.isArray(result) ? result : [result]) layers.push({ name: `${name}: ${fc.fileName ?? 'shapefile'}`, features: fc });
  }
  for (const entry of entries) {
    const ext = extension(entry.name);
    if (!['geojson', 'json', 'kml', 'kmz', 'gpkg', 'zip'].includes(ext)) continue;
    const bytes = await entry.async('uint8array');
    layers.push(...(await readVectorFiles(`${name}: ${entry.name}`, [{ name: entry.name, data: bytes }])));
  }
  if (!layers.length) throw new Error(`${name}: no vector files found in the zip`);
  return layers;
}

/** Reads the files of one overlay into one or more layers. */
export async function readVectorFiles(name: string, files: OverlayFile[]): Promise<VectorData[]> {
  const main = files[0];
  const ext = extension(main.name);
  switch (ext) {
    case 'geojson':
    case 'json':
      return [readGeoJson(name, decoder.decode(main.data))];
    case 'kml':
      return readKml(name, decoder.decode(main.data));
    case 'kmz': {
      const zip = await JSZip.loadAsync(main.data);
      const doc = zip.file('doc.kml') ?? Object.values(zip.files).find((f) => !f.dir && extension(f.name) === 'kml');
      if (!doc) throw new Error(`${name}: no KML inside`);
      return readKml(name, await doc.async('string'));
    }
    case 'shp':
      return [await readShapefile(name, files)];
    case 'gpkg':
      return readGeoPackage(name, main.data);
    case 'zip':
      return readZip(name, main.data);
    case 'gdb':
      throw new Error('File Geodatabase (.gdb) is not supported. Export the layers to GeoPackage or GeoJSON.');
    default:
      // Try by content.
      try {
        return [readGeoJson(name, decoder.decode(main.data))];
      } catch {
        throw new Error(`${name}: unsupported file type (GeoJSON, KML, KMZ, Shapefile, GeoPackage or a zip of them)`);
      }
  }
}
