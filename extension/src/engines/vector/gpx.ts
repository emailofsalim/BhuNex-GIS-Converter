/**
 * GPX 1.1.
 *
 * GPX is WGS 84 only and has three feature kinds: waypoints (points), routes and
 * tracks (lines). It has no polygon, so a polygon export becomes a closed track
 * and the substitution is reported rather than performed quietly.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirLayer,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { coordinateFormatter, formatFixed, type PrecisionPolicy } from '../../core/precision';
import { crsFromEpsg } from '../../crs/epsg';
import { deriveFields, xmlEscape } from '../shared';
import { attribute, child, childText, children, descendants, documentElement, parseXml, type XmlNode } from '../xml';

function readPoint(node: XmlNode): { position: Position; properties: Record<string, unknown> } | null {
  const lat = Number(attribute(node, 'lat'));
  const lon = Number(attribute(node, 'lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const elevationText = childText(node, 'ele');
  const elevation = elevationText ? Number(elevationText) : NaN;
  const properties: Record<string, unknown> = {};
  for (const key of ['name', 'desc', 'cmt', 'sym', 'type', 'time', 'src']) {
    const value = childText(node, key);
    if (value) properties[key] = value;
  }
  // GPS quality fields matter to surveyors and are cheap to keep.
  for (const key of ['hdop', 'vdop', 'pdop', 'sat', 'fix', 'magvar', 'geoidheight']) {
    const value = childText(node, key);
    if (value) properties[key] = Number.isFinite(Number(value)) ? Number(value) : value;
  }
  return {
    position: Number.isFinite(elevation) ? [lon, lat, elevation] : [lon, lat],
    properties,
  };
}

export function readGpx(text: string, source: SourceInfo): CirDataset {
  const document = parseXml(text);
  const root = documentElement(document);
  if (!root || root.local !== 'gpx') {
    throw new ConversionError({
      code: 'GPX_NO_ROOT',
      what: 'The file has no <gpx> root element.',
      why: 'A GPX document must be rooted at <gpx>.',
      action: 'Confirm the detected format in the inspector — this may be another XML dialect.',
    });
  }

  const warnings: Warning[] = [];
  const waypoints: CirFeature[] = [];
  const routes: CirFeature[] = [];
  const tracks: CirFeature[] = [];

  for (const [index, node] of children(root, 'wpt').entries()) {
    const point = readPoint(node);
    if (!point) continue;
    waypoints.push({
      id: (point.properties.name as string | undefined) ?? index,
      geometry: { type: 'Point', coordinates: point.position, dimension: point.position.length >= 3 ? 3 : 2 },
      properties: point.properties,
      sourceEntity: 'wpt',
    });
  }

  for (const [index, node] of children(root, 'rte').entries()) {
    const positions: Position[] = [];
    for (const routePoint of children(node, 'rtept')) {
      const point = readPoint(routePoint);
      if (point) positions.push(point.position);
    }
    if (positions.length < 2) continue;
    routes.push({
      id: childText(node, 'name') || index,
      geometry: { type: 'LineString', coordinates: positions, dimension: positions.some((p) => p.length >= 3) ? 3 : 2 },
      properties: { name: childText(node, 'name'), desc: childText(node, 'desc') },
      sourceEntity: 'rte',
    });
  }

  for (const [index, node] of children(root, 'trk').entries()) {
    const segments = children(node, 'trkseg');
    const lines: Position[][] = [];
    for (const segment of segments) {
      const positions: Position[] = [];
      for (const trackPoint of children(segment, 'trkpt')) {
        const point = readPoint(trackPoint);
        if (point) positions.push(point.position);
      }
      if (positions.length >= 2) lines.push(positions);
    }
    if (lines.length === 0) continue;
    const dimension = lines.flat().some((position) => position.length >= 3) ? 3 : 2;
    tracks.push({
      id: childText(node, 'name') || index,
      // A multi-segment track is genuinely a MultiLineString; flattening it
      // would join segments that a pause deliberately separated.
      geometry:
        lines.length === 1
          ? { type: 'LineString', coordinates: lines[0], dimension }
          : { type: 'MultiLineString', coordinates: lines, dimension },
      properties: { name: childText(node, 'name'), desc: childText(node, 'desc'), type: childText(node, 'type') },
      sourceEntity: 'trk',
    });
  }

  const layers: CirLayer[] = [];
  if (waypoints.length) layers.push(createLayer('Waypoints', waypoints, deriveFields(waypoints)));
  if (routes.length) layers.push(createLayer('Routes', routes, deriveFields(routes)));
  if (tracks.length) layers.push(createLayer('Tracks', tracks, deriveFields(tracks)));

  if (layers.length === 0) {
    const total = descendants(root, 'wpt').length + descendants(root, 'trkpt').length + descendants(root, 'rtept').length;
    throw new ConversionError({
      code: 'GPX_NO_FEATURES',
      what: 'No waypoints, routes or tracks could be read.',
      why: total > 0 ? `${total} point element(s) were present but none had valid lat/lon attributes.` : 'The document contains no wpt, rte or trk elements.',
      action: 'Check the file in a GPS application to confirm it holds data.',
    });
  }

  const creator = attribute(root, 'creator');
  return createDataset({
    kind: 'vector',
    name: childText(child(root, 'metadata') ?? root, 'name') || source.fileName,
    source,
    crs: crsFromEpsg(4326),
    crsOrigin: 'declared',
    axisOrder: 'xy',
    // GPX <ele> is defined as height above the WGS 84 ellipsoid corrected by the
    // geoid separation — in practice, orthometric height from the receiver.
    vertical: { kind: 'orthometric', name: 'GPX <ele> (geoid-corrected height)' },
    layers,
    warnings,
    metadata: { creator, version: attribute(root, 'version') },
  });
}

export interface WriteGpxOptions {
  precision: PrecisionPolicy;
  /** Field used for <name>. */
  labelField?: string;
  /** Write lines as tracks (default) or routes. */
  lineKind: 'trk' | 'rte';
  creator?: string;
}

export const DEFAULT_GPX_OPTIONS: Omit<WriteGpxOptions, 'precision'> = {
  lineKind: 'trk',
  creator: 'Universal BhuNex Converter',
};

export function writeGpx(dataset: CirDataset, options: WriteGpxOptions): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  if (dataset.crs?.kind !== 'geographic') {
    warnings.push(
      warn('GPX_NOT_GEOGRAPHIC', `Coordinates were written without transforming from ${dataset.crs?.name ?? 'an undeclared CRS'}.`, {
        severity: 'error',
        reason: 'GPX stores latitude and longitude in WGS 84 degrees. Projected values are outside the ±90 / ±180 range GPS software accepts.',
        action: 'Set the target CRS to WGS 84 (EPSG:4326).',
      })
    );
  }

  const format = coordinateFormatter(options.precision, true);
  const decimals = options.precision.mode === 'full' ? 15 : Math.max(6, options.precision.geographicDecimals);
  const elevationDecimals = options.precision.mode === 'full' ? 15 : options.precision.elevationDecimals;

  const attributes = (position: Position) =>
    `lat="${formatFixed(format.y(position[1]), decimals)}" lon="${formatFixed(format.x(position[0]), decimals)}"`;
  const elevation = (position: Position) =>
    position.length > 2 && Number.isFinite(position[2]) ? `<ele>${formatFixed(format.z(position[2]), elevationDecimals)}</ele>` : '';

  const waypoints: string[] = [];
  const lines: string[] = [];
  let polygonCount = 0;

  const nameOf = (feature: CirFeature, fallback: number): string => {
    const value = options.labelField ? feature.properties?.[options.labelField] : (feature.properties?.name ?? feature.id ?? fallback);
    return xmlEscape(value ?? fallback);
  };

  const emitLine = (positions: Position[], name: string, description: string): void => {
    if (options.lineKind === 'rte') {
      lines.push(
        `<rte><name>${name}</name>${description}${positions
          .map((position) => `<rtept ${attributes(position)}>${elevation(position)}</rtept>`)
          .join('')}</rte>`
      );
      return;
    }
    lines.push(
      `<trk><name>${name}</name>${description}<trkseg>${positions
        .map((position) => `<trkpt ${attributes(position)}>${elevation(position)}</trkpt>`)
        .join('')}</trkseg></trk>`
    );
  };

  let index = 0;
  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      const geometry = feature.geometry;
      if (!geometry) continue;
      const name = nameOf(feature, ++index);
      const descriptionValue = feature.properties?.desc ?? feature.properties?.description;
      const description = descriptionValue ? `<desc>${xmlEscape(descriptionValue)}</desc>` : '';

      switch (geometry.type) {
        case 'Point':
          waypoints.push(`<wpt ${attributes(geometry.coordinates as Position)}>${elevation(geometry.coordinates as Position)}<name>${name}</name>${description}</wpt>`);
          break;
        case 'MultiPoint':
          for (const position of geometry.coordinates as Position[]) {
            waypoints.push(`<wpt ${attributes(position)}>${elevation(position)}<name>${name}</name>${description}</wpt>`);
          }
          break;
        case 'LineString':
          emitLine(geometry.coordinates as Position[], name, description);
          break;
        case 'MultiLineString':
          for (const line of geometry.coordinates as Position[][]) emitLine(line, name, description);
          break;
        case 'Polygon':
        case 'MultiPolygon': {
          polygonCount++;
          const rings = geometry.type === 'Polygon' ? (geometry.coordinates as Position[][]) : (geometry.coordinates as Position[][][]).flat();
          for (const ring of rings) {
            const closed = ring.length > 2 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ? [...ring, ring[0]] : ring;
            emitLine(closed, name, description);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  if (polygonCount > 0) {
    warnings.push(
      warn('GPX_POLYGON_AS_TRACK', `${polygonCount} polygon(s) were written as closed ${options.lineKind === 'rte' ? 'routes' : 'tracks'}.`, {
        count: polygonCount,
        reason: 'GPX has no polygon type; only waypoints, routes and tracks exist.',
        action: 'Export to KML, GeoJSON or Shapefile to keep true polygon geometry.',
      })
    );
  }

  const text =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="${xmlEscape(options.creator ?? 'Universal BhuNex Converter')}" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `<metadata><name>${xmlEscape(dataset.name)}</name></metadata>\n` +
    waypoints.join('\n') +
    (waypoints.length && lines.length ? '\n' : '') +
    lines.join('\n') +
    `\n</gpx>\n`;

  return { text, warnings };
}
