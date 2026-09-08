/**
 * GeoJSON and GeoJSON Sequence.
 *
 * RFC 7946 fixes the CRS at WGS 84 longitude/latitude and removed the `crs`
 * member. Real deliveries still carry projected coordinates with a `crs` member
 * from the 2008 draft, so the reader honours one when present and the writer can
 * emit one — flagged as non-standard rather than written silently.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirGeometry,
  type CrsRef,
  type GeometryType,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { coordinateFormatter, type PrecisionPolicy } from '../../core/precision';
import { crsFromEpsg } from '../../crs/epsg';
import { deriveFields, inferDimension } from '../shared';

const GEOMETRY_TYPES = new Set<GeometryType>([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

export function isGeoJsonObject(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const type = (value as any).type;
  if (type === 'FeatureCollection') return Array.isArray((value as any).features);
  if (type === 'Feature') return 'geometry' in (value as any);
  return GEOMETRY_TYPES.has(type);
}

function readGeometry(raw: any, warnings: Warning[]): CirGeometry | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type as GeometryType;
  if (!GEOMETRY_TYPES.has(type)) {
    warnings.push(
      warn('GEOJSON_UNKNOWN_GEOMETRY', `Geometry type "${String(raw.type)}" is not a GeoJSON type and was skipped.`, {
        reason: 'GeoJSON defines seven geometry types; anything else cannot be interpreted.',
        action: 'Check the source export settings, or convert the file in QGIS first.',
      })
    );
    return null;
  }
  if (type === 'GeometryCollection') {
    const geometries = (raw.geometries ?? []).map((child: any) => readGeometry(child, warnings)).filter(Boolean) as CirGeometry[];
    const dimension = geometries.reduce<2 | 3 | 4>((max, child) => (child.dimension > max ? child.dimension : max), 2);
    return { type, geometries, dimension };
  }
  const coordinates = raw.coordinates;
  if (coordinates == null) return null;
  const flat: Position[] = [];
  const collect = (node: any): void => {
    if (Array.isArray(node) && typeof node[0] === 'number') flat.push(node as Position);
    else if (Array.isArray(node)) for (const child of node) collect(child);
  };
  collect(coordinates);
  return { type, coordinates, dimension: inferDimension(flat) };
}

/**
 * Reads the legacy `crs` member. Both the named form and the EPSG-code form
 * appear in the wild; anything unrecognised is reported rather than assumed.
 */
function readCrsMember(raw: any, warnings: Warning[]): CrsRef | null {
  const crs = raw?.crs;
  if (!crs) return null;
  const name: string | undefined = crs.properties?.name ?? crs.properties?.href;
  if (typeof name === 'string') {
    const match = name.match(/(?:EPSG|epsg)[:\/]{1,2}(\d+)/) ?? name.match(/urn:ogc:def:crs:EPSG:.*?:(\d+)/);
    if (match) {
      const code = Number(match[1]);
      const known = crsFromEpsg(code);
      if (known) return known;
      warnings.push(
        warn('GEOJSON_CRS_UNKNOWN_EPSG', `The file declares EPSG:${code}, which is not in the bundled CRS list.`, {
          reason: 'Only the CRS needed for survey and GIS work in this product are bundled, to keep the extension offline and small.',
          action: 'Select the source CRS manually, or paste its WKT in the CRS panel.',
        })
      );
      return { epsg: code, name: `EPSG:${code}`, kind: 'projected', datum: 'Unknown', projection: 'Unknown', unit: 'unknown', axisOrder: 'xy' };
    }
  }
  return null;
}

export interface ReadGeoJsonOptions {
  /** Set for .geojsonl / .jsonl input. */
  sequence?: boolean;
}

export function readGeoJson(text: string, source: SourceInfo, options: ReadGeoJsonOptions = {}): CirDataset {
  const warnings: Warning[] = [];
  const features: CirFeature[] = [];
  let declaredCrs: CrsRef | null = null;

  const pushFeature = (raw: any, index: number): void => {
    if (!raw || typeof raw !== 'object') return;
    if (raw.type === 'Feature') {
      const properties = raw.properties && typeof raw.properties === 'object' ? { ...raw.properties } : {};
      features.push({
        id: raw.id ?? index,
        geometry: readGeometry(raw.geometry, warnings),
        properties,
        // Restore the CAD provenance this writer emits, so a DXF -> GeoJSON ->
        // DXF trip keeps its layers, entity types and handles rather than
        // collapsing onto one default layer.
        sourceLayer: typeof properties._layer === 'string' ? properties._layer : undefined,
        sourceEntity: typeof properties._srcEntity === 'string' ? properties._srcEntity : undefined,
        sourceHandle: typeof properties._srcHandle === 'string' ? properties._srcHandle : undefined,
      });
      return;
    }
    if (GEOMETRY_TYPES.has(raw.type)) {
      features.push({ id: index, geometry: readGeometry(raw, warnings), properties: {} });
    }
  };

  if (options.sequence) {
    const lines = text.split(/\r?\n/);
    let skipped = 0;
    lines.forEach((line, index) => {
      const trimmed = line.trim().replace(/^\x1e/, ''); // RFC 8142 record separator
      if (!trimmed) return;
      try {
        pushFeature(JSON.parse(trimmed), index);
      } catch {
        skipped++;
      }
    });
    if (skipped > 0) {
      warnings.push(
        warn('GEOJSONSEQ_BAD_LINES', `${skipped} line(s) could not be parsed as JSON and were skipped.`, {
          count: skipped,
          reason: 'GeoJSON Sequence requires one complete JSON value per line.',
          action: 'Open the file and check for wrapped or truncated lines.',
        })
      );
    }
  } else {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ConversionError({
        code: 'GEOJSON_INVALID_JSON',
        what: 'The file could not be parsed as JSON.',
        why: error instanceof Error ? error.message : String(error),
        action: 'Validate the file in a JSON linter, or re-export it from the source application.',
      });
    }
    if (!isGeoJsonObject(parsed)) {
      throw new ConversionError({
        code: 'GEOJSON_NOT_GEOJSON',
        what: 'The file is valid JSON but is not GeoJSON.',
        why: 'It has no FeatureCollection, Feature or geometry structure, so there is nothing to read as geometry.',
        action: 'If it is a table of coordinates, import it with the CSV/table reader and map the columns.',
      });
    }
    declaredCrs = readCrsMember(parsed, warnings);
    if (parsed.type === 'FeatureCollection') (parsed.features ?? []).forEach(pushFeature);
    else pushFeature(parsed, 0);
  }

  // GeoJSON is a flat FeatureCollection, but a file this tool wrote carries the
  // source hierarchy in each feature's `_layer`. Regrouping by it means a
  // DXF or KML tree survives a GeoJSON hop instead of collapsing to one layer —
  // which is what makes "input structure = output structure" hold across formats
  // rather than only within one.
  const grouped = new Map<string, CirFeature[]>();
  for (const feature of features) {
    const key = typeof feature.properties?._layer === 'string' ? feature.properties._layer : '';
    const list = grouped.get(key) ?? [];
    list.push(feature);
    grouped.set(key, list);
  }
  const carriesHierarchy = grouped.size > 1 || (grouped.size === 1 && !grouped.has(''));
  const layers = carriesHierarchy
    ? [...grouped.entries()].map(([key, list]) => {
        // The KML reader joins folder segments with ' / '; splitting on it here
        // rebuilds the same tree the writer will emit.
        const segments = key ? key.split(' / ').map((segment) => segment.trim()).filter(Boolean) : [source.fileName];
        return createLayer(segments[segments.length - 1], list, deriveFields(list), segments);
      })
    : [createLayer(source.fileName, features, deriveFields(features))];

  const dataset = createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    // RFC 7946 pins GeoJSON to WGS 84, so an undeclared file is read as WGS 84.
    // That is the standard speaking rather than a guess — but it is still an
    // assumption, and it is wrong for every projected GeoJSON that QGIS writes,
    // because RFC 7946 removed the `crs` member those files would have used to
    // say so. Marking it `assumed` is what lets the CRS panel override it.
    crs: declaredCrs ?? crsFromEpsg(4326),
    crsOrigin: declaredCrs ? 'declared' : 'assumed',
    units: declaredCrs && declaredCrs.kind === 'projected' ? 'm' : null,
    axisOrder: 'xy',
    layers,
    warnings,
  });
  return dataset;
}

export interface WriteGeoJsonOptions {
  precision: PrecisionPolicy;
  /** Emit one Feature per line (GeoJSON Sequence). */
  sequence?: boolean;
  /** Write a legacy `crs` member for non-WGS 84 output. */
  includeCrsMember?: boolean;
  indent?: number;
}

function roundGeometry(geometry: CirGeometry, format: ReturnType<typeof coordinateFormatter>): any {
  if (geometry.type === 'GeometryCollection') {
    return { type: geometry.type, geometries: (geometry.geometries ?? []).map((child) => roundGeometry(child, format)) };
  }
  const walk = (node: any): any => {
    if (Array.isArray(node) && typeof node[0] === 'number') {
      const position = node as Position;
      const out: number[] = [format.x(position[0]), format.y(position[1])];
      if (position.length > 2 && Number.isFinite(position[2])) out.push(format.z(position[2]));
      return out;
    }
    return (node as any[]).map(walk);
  };
  return { type: geometry.type, coordinates: walk(geometry.coordinates) };
}

export function writeGeoJson(dataset: CirDataset, options: WriteGeoJsonOptions): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const geographic = dataset.crs?.kind === 'geographic';
  const format = coordinateFormatter(options.precision, geographic);

  if (!geographic && dataset.crs?.epsg !== null) {
    warnings.push(
      warn('GEOJSON_NON_WGS84', `Coordinates were written in ${dataset.crs?.name ?? 'the source CRS'} rather than WGS 84 longitude/latitude.`, {
        severity: 'info',
        reason: 'RFC 7946 defines GeoJSON as WGS 84. Writing projected coordinates keeps the survey values exact but is outside the standard.',
        action: 'Set the target CRS to WGS 84 (EPSG:4326) if the consumer expects standard GeoJSON.',
      })
    );
  }

  const features = dataset.layers.flatMap((layer) =>
    layer.features.map((feature) => {
      const properties: Record<string, unknown> = { ...feature.properties };
      // CAD provenance travels with the feature so a DXF -> GeoJSON -> DXF trip
      // can restore layers and entity types instead of guessing them.
      if (feature.sourceLayer && properties._layer === undefined) properties._layer = feature.sourceLayer;
      if (feature.sourceEntity && properties._srcEntity === undefined) properties._srcEntity = feature.sourceEntity;
      if (feature.sourceHandle && properties._srcHandle === undefined) properties._srcHandle = feature.sourceHandle;
      return {
        type: 'Feature' as const,
        ...(feature.id !== undefined ? { id: feature.id } : {}),
        geometry: feature.geometry ? roundGeometry(feature.geometry, format) : null,
        properties,
      };
    })
  );

  if (options.sequence) {
    return { text: features.map((feature) => JSON.stringify(feature)).join('\n') + '\n', warnings };
  }

  const collection: Record<string, unknown> = { type: 'FeatureCollection' };
  if (options.includeCrsMember && dataset.crs?.epsg && dataset.crs.epsg !== 4326) {
    collection.crs = { type: 'name', properties: { name: `urn:ogc:def:crs:EPSG::${dataset.crs.epsg}` } };
  }
  collection.features = features;
  return { text: JSON.stringify(collection, null, options.indent ?? 0) + '\n', warnings };
}
