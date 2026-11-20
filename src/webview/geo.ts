import proj4 from 'proj4';
import type { GeoInfo } from '../shared/protocol';

/** Half the Web Mercator world width, in metres. */
export const MERCATOR_HALF = 20037508.342789244;
const MAX_MERCATOR_LAT = 85.0511287798066;

export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return [(lon / 180) * MERCATOR_HALF, (Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / Math.PI) * MERCATOR_HALF];
}

export function mercatorToLonLat(x: number, y: number): [number, number] {
  return [(x / MERCATOR_HALF) * 180, (Math.atan(Math.exp((y / MERCATOR_HALF) * Math.PI)) * 360) / Math.PI - 90];
}

/**
 * Converts between the image's pixels, its coordinate system and longitude /
 * latitude (WGS 84). Points that cannot be projected come back as NaN.
 */
export class GeoMapper {
  private readonly toLonLat: proj4.Converter;
  /** Inverse of the geotransform. */
  private readonly inverse: [number, number, number, number, number, number];

  constructor(readonly geo: GeoInfo) {
    this.toLonLat = proj4(geo.proj4, 'EPSG:4326');
    const [t0, t1, t2, t3, t4, t5] = geo.transform;
    const det = t1 * t5 - t2 * t4;
    this.inverse = [t5 / det, -t2 / det, (t2 * t3 - t0 * t5) / det, -t4 / det, t1 / det, (t4 * t0 - t1 * t3) / det];
  }

  pixelToCrs(col: number, row: number): [number, number] {
    const t = this.geo.transform;
    return [t[0] + t[1] * col + t[2] * row, t[3] + t[4] * col + t[5] * row];
  }

  crsToPixel(x: number, y: number): [number, number] {
    const v = this.inverse;
    return [v[0] * x + v[1] * y + v[2], v[3] * x + v[4] * y + v[5]];
  }

  pixelToLonLat(col: number, row: number): [number, number] {
    const [x, y] = this.pixelToCrs(col, row);
    try {
      const p = this.toLonLat.forward([x * this.geo.factors.x, y * this.geo.factors.y]);
      return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : [NaN, NaN];
    } catch {
      return [NaN, NaN];
    }
  }

  lonLatToPixel(lon: number, lat: number): [number, number] {
    try {
      const p = this.toLonLat.inverse([lon, lat]);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return [NaN, NaN];
      return this.crsToPixel(p[0] / this.geo.factors.x, p[1] / this.geo.factors.y);
    } catch {
      return [NaN, NaN];
    }
  }
}

/** A proj4 definition for another coordinate system (e.g. a vector file's), to longitude/latitude. */
export function converterToLonLat(definition: string): ((x: number, y: number) => [number, number]) | undefined {
  try {
    const converter = proj4(definition, 'EPSG:4326');
    return (x, y) => {
      try {
        const p = converter.forward([x, y]);
        return [p[0], p[1]];
      } catch {
        return [NaN, NaN];
      }
    };
  } catch {
    return undefined;
  }
}
