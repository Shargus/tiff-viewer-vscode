import type { GeoTIFFImage } from 'geotiff';
import { toProj4 } from 'geotiff-geokeys-to-proj4';
import type { GeoInfo } from '../shared/protocol';

/**
 * Georeferencing of an image: its pixel → map transform and its coordinate
 * system as a proj4 definition. Undefined when the image is not georeferenced
 * (no transform, or no coordinate system that can be expressed).
 */
export async function readGeoInfo(image: GeoTIFFImage): Promise<GeoInfo | undefined> {
  const fd = image.getFileDirectory();
  const load = async (tag: string) => {
    try {
      return fd.hasTag(tag as never) ? ((await fd.loadValue(tag as never)) as ArrayLike<number> | undefined) : undefined;
    } catch {
      return undefined;
    }
  };
  let keys: Record<string, unknown> | null = null;
  try {
    keys = image.getGeoKeys() as Record<string, unknown> | null;
  } catch {
    return undefined;
  }
  if (!keys) return undefined;

  // GDAL geotransform order: x = t0 + t1·col + t2·row, y = t3 + t4·col + t5·row (pixel corners).
  let transform: GeoInfo['transform'] | undefined;
  const matrix = await load('ModelTransformation');
  const tiepoints = await load('ModelTiepoint');
  const scale = await load('ModelPixelScale');
  if (matrix && matrix.length >= 16) {
    transform = [matrix[3], matrix[0], matrix[1], matrix[7], matrix[4], matrix[5]];
  } else if (tiepoints && tiepoints.length >= 6 && scale && scale.length >= 2) {
    const [i, j, , x, y] = Array.from(tiepoints);
    const [sx, sy] = Array.from(scale);
    transform = [x - i * sx, sx, 0, y + j * sy, 0, -sy];
  }
  if (!transform || !transform.every(Number.isFinite)) return undefined;
  // PixelIsPoint: the tiepoint is a pixel centre; move to the corner, as GDAL does.
  if (keys.GTRasterTypeGeoKey === 2) {
    transform = [
      transform[0] - 0.5 * transform[1] - 0.5 * transform[2],
      transform[1],
      transform[2],
      transform[3] - 0.5 * transform[4] - 0.5 * transform[5],
      transform[4],
      transform[5],
    ];
  }

  let proj: ReturnType<typeof toProj4>;
  try {
    proj = toProj4(keys as never);
  } catch {
    return undefined;
  }
  if (!proj.proj4 || !/\+proj=/.test(proj.proj4)) return undefined;
  const epsg = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey;
  const citation = keys.GTCitationGeoKey ?? keys.PCSCitationGeoKey ?? keys.GeogCitationGeoKey;
  const crsName =
    typeof epsg === 'number' && epsg > 0 && epsg < 32767
      ? `EPSG:${epsg}${typeof citation === 'string' && citation ? ` (${citation.replace(/\|+$/, '')})` : ''}`
      : typeof citation === 'string' && citation
        ? citation.replace(/\|+$/, '')
        : 'Custom coordinate system';
  return {
    transform,
    proj4: proj.proj4,
    factors: { x: proj.conversionParameters.x, y: proj.conversionParameters.y },
    crsName,
    geographic: proj.isGCS,
  };
}
