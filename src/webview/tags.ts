import type { GeoTIFFImage } from 'geotiff';
// Not exported from the package entry point.
import { fieldTypes, tagDefinitions } from '../../node_modules/geotiff/dist-module/globals.js';

/**
 * Every tag of an image's directory, for the info panel: known tags by name,
 * any other (private or custom) tag by number, each with its value as text.
 * Large arrays that geotiff.js reads piece by piece (tile and strip offsets)
 * are summarised by their length instead of being read whole.
 */

/** Names of well-known tags that geotiff.js does not name. */
const EXTRA_TAG_NAMES: Record<number, string> = {
  32932: 'WangAnnotation',
  32995: 'Matteing',
  32996: 'DataType',
  32997: 'ImageDepth',
  32998: 'TileDepth',
  33421: 'CFARepeatPatternDim',
  33422: 'CFAPattern',
  34016: 'IT8Site',
  34732: 'ImageLayer',
  34853: 'GPS IFD',
  37724: 'ImageSourceData',
  40965: 'Interoperability IFD',
  42016: 'ImageUniqueID',
  50838: 'ImageJ metadata byte counts',
  50839: 'ImageJ metadata',
};

/** Longest value text sent to the panel; longer values are cut (very large custom blobs). */
const MAX_VALUE_TEXT = 200_000;
/** Numbers shown for an array before "… (N values)". */
const MAX_LISTED = 64;

interface Directory {
  actualizedFields: Map<number, unknown>;
  deferredFields: Map<number, unknown>;
  deferredArrays: Map<number, { length: number }>;
  loadValue(tag: number): Promise<unknown>;
}

export interface TagEntry {
  /** "Name (id)", e.g. "Software (305)" or "Tag 65000". */
  label: string;
  value: string;
}

export function tagName(id: number): string | undefined {
  return (tagDefinitions as Record<number, { name?: string }>)[id]?.name ?? EXTRA_TAG_NAMES[id];
}

function formatNumber(value: number | bigint): string {
  if (typeof value === 'bigint') return value.toString();
  if (Number.isInteger(value) || !Number.isFinite(value)) return String(value);
  return String(Number(value.toPrecision(10)));
}

/** Bytes that read as text (e.g. XMP stored as BYTE/UNDEFINED) are shown as text. */
function bytesAsText(bytes: Uint8Array): string | undefined {
  let printable = 0;
  const end = bytes.length && bytes[bytes.length - 1] === 0 ? bytes.length - 1 : bytes.length;
  for (let i = 0; i < end; i++) {
    const b = bytes[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127)) printable++;
  }
  if (end === 0 || printable < end * 0.95) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    return undefined;
  }
}

function listNumbers(values: ArrayLike<number | bigint>, rational: boolean): string {
  const items: string[] = [];
  if (rational) {
    // RATIONAL / SRATIONAL: numerator, denominator pairs.
    const count = Math.floor(values.length / 2);
    for (let i = 0; i < Math.min(count, MAX_LISTED); i++) {
      const n = Number(values[2 * i]);
      const d = Number(values[2 * i + 1]);
      items.push(d === 1 ? formatNumber(n) : d ? `${formatNumber(n / d)} (${n}/${d})` : `${n}/${d}`);
    }
    return items.join(', ') + (count > MAX_LISTED ? ` … (${count} values)` : '');
  }
  for (let i = 0; i < Math.min(values.length, MAX_LISTED); i++) items.push(formatNumber(values[i]));
  return items.join(', ') + (values.length > MAX_LISTED ? ` … (${values.length} values)` : '');
}

export function formatTagValue(id: number, value: unknown): string {
  const type = (tagDefinitions as Record<number, { type?: number }>)[id]?.type;
  const rational = type === fieldTypes.RATIONAL || type === fieldTypes.SRATIONAL;
  let text: string;
  if (value === undefined || value === null) {
    text = '';
  } else if (typeof value === 'string') {
    // ASCII values may hold several NUL-separated strings.
    text = value.replace(/\0+$/, '').split('\0').join(' | ');
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    text = formatNumber(value);
  } else if (value instanceof Uint8Array || value instanceof Int8Array) {
    const asText = value.length > 8 ? bytesAsText(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) : undefined;
    text = asText ?? (value.length > MAX_LISTED ? `${value.length} bytes` : listNumbers(value, false));
  } else if (ArrayBuffer.isView(value) || Array.isArray(value)) {
    const values = value as ArrayLike<unknown>;
    if (Array.from({ length: Math.min(values.length, 4) }, (_, i) => values[i]).every((v) => typeof v === 'number' || typeof v === 'bigint')) {
      text = listNumbers(values as ArrayLike<number | bigint>, rational);
    } else {
      text = Array.from(values, (v) => formatTagValue(-1, v)).join(', ');
    }
  } else {
    text = String(value);
  }
  return text.length > MAX_VALUE_TEXT ? `${text.slice(0, MAX_VALUE_TEXT)}… (${text.length} characters)` : text;
}

/** Every tag of the image's directory, in tag order. */
export async function readAllTags(image: GeoTIFFImage): Promise<TagEntry[]> {
  const fd = image.getFileDirectory() as unknown as Directory;
  const ids = [...new Set([...fd.actualizedFields.keys(), ...fd.deferredFields.keys(), ...fd.deferredArrays.keys()])]
    .filter((id): id is number => typeof id === 'number')
    .sort((a, b) => a - b);
  const entries: TagEntry[] = [];
  for (const id of ids) {
    const name = tagName(id);
    const label = name ? `${name} (${id})` : `Tag ${id}`;
    const deferredArray = fd.deferredArrays.get(id);
    if (deferredArray) {
      entries.push({ label, value: `${deferredArray.length} values` });
      continue;
    }
    try {
      entries.push({ label, value: formatTagValue(id, await fd.loadValue(id)) });
    } catch (error) {
      entries.push({ label, value: `(cannot read: ${error instanceof Error ? error.message : String(error)})` });
    }
  }
  return entries;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      return String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    }
    return XML_ENTITIES[code] ?? entity;
  });
}

/**
 * The items of GDAL's metadata tag, as gdalinfo lists them: dataset items
 * ("NAME" or "domain: NAME"), then band items ("Band 2: NAME", with roles such
 * as description, scale, offset or unittype shown as their role).
 */
export function parseGdalMetadata(xml: string): [string, string][] {
  const dataset: [string, string][] = [];
  const bands: [number, string, string][] = [];
  for (const m of xml.matchAll(/<Item\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Item>)/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1], decodeXml(a[2])]));
    const value = decodeXml(m[2] ?? '').trim();
    const name = attrs.role && attrs.role !== 'metadata' ? attrs.role : (attrs.name ?? '');
    const key = attrs.domain ? `${attrs.domain}: ${name}` : name;
    const sample = Number(attrs.sample);
    if (attrs.sample !== undefined && Number.isInteger(sample)) bands.push([sample, key, value]);
    else dataset.push([key, value]);
  }
  bands.sort((a, b) => a[0] - b[0]);
  return [...dataset, ...bands.map(([sample, key, value]): [string, string] => [`Band ${sample + 1}: ${key}`, value])];
}

/** The GeoTIFF keys (from GeoKeyDirectory), by name. */
export function readGeoKeys(image: GeoTIFFImage): [string, string][] {
  try {
    const keys = image.getGeoKeys() as Record<string, unknown> | null;
    return Object.entries(keys ?? {}).map(([key, value]) => [key, formatTagValue(-1, value)]);
  } catch {
    return [];
  }
}
