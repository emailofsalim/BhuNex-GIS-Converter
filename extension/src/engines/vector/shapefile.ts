/**
 * ESRI Shapefile — reader and writer.
 *
 * A shapefile is a package: .shp holds geometry, .shx the index, .dbf the
 * attributes, .prj the CRS and .cpg the attribute encoding. The writer always
 * emits all five inside one ZIP, because handing a user a lone .shp is handing
 * them a file no GIS will open (instruction §35).
 *
 * Two format constraints drive the design: one shapefile holds exactly one
 * geometry type, and ring winding decides outer versus hole. Both are handled
 * explicitly and both are reported when they change the data.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirGeometry,
  type CrsRef,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { assertWithinBuffer, ConversionError } from '../../core/errors';
import { featuresBounds3, orientRing, pointInRing, signedArea, simpleKind } from '../../core/geometry';
import { coordinateFormatter, type PrecisionPolicy } from '../../core/precision';
import { buildPrj, parsePrj } from '../../crs/wkt';
import { writeZip, type ZipInput } from '../archives/zip';
import { deriveFields } from '../shared';
import { planDbfFields, readDbf, writeDbf } from './dbf';

export const SHAPE_TYPES: Record<number, string> = {
  0: 'Null',
  1: 'Point',
  3: 'PolyLine',
  5: 'Polygon',
  8: 'MultiPoint',
  11: 'PointZ',
  13: 'PolyLineZ',
  15: 'PolygonZ',
  18: 'MultiPointZ',
  21: 'PointM',
  23: 'PolyLineM',
  25: 'PolygonM',
  28: 'MultiPointM',
};

const NO_DATA_THRESHOLD = -1e38; // ESRI's "no data" sentinel for M values

interface ShapeReadResult {
  geometry: CirGeometry | null;
  shapeType: number;
}

export interface ShapefileParts {
  shp: Uint8Array;
  dbf?: Uint8Array;
  prj?: string;
  cpg?: string;
  shx?: Uint8Array;
}

export function readShapefile(parts: ShapefileParts, source: SourceInfo): CirDataset {
  const { shp } = parts;
  if (shp.length < 100) {
    throw new ConversionError({
      code: 'SHP_TOO_SHORT',
      what: 'The .shp file is shorter than its 100-byte header.',
      why: 'The file is truncated or was not transferred completely.',
      action: 'Re-copy the whole shapefile package (.shp, .shx, .dbf, .prj, .cpg).',
    });
  }

  const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  if (view.getInt32(0, false) !== 9994) {
    throw new ConversionError({
      code: 'SHP_BAD_MAGIC',
      what: 'The .shp file does not start with the shapefile signature.',
      why: `Expected file code 9994 but found ${view.getInt32(0, false)}.`,
      action: 'Confirm the detected format in the inspector — the file may have been renamed.',
    });
  }

  const warnings: Warning[] = [];
  // The header length is in 16-bit words. A mismatch means truncation, and
  // reading past it would produce fabricated geometry.
  const declaredLength = view.getInt32(24, false) * 2;
  if (declaredLength !== shp.length) {
    warnings.push(
      warn('SHP_LENGTH_MISMATCH', `The header declares ${declaredLength.toLocaleString()} bytes but the file holds ${shp.length.toLocaleString()}.`, {
        severity: declaredLength > shp.length ? 'error' : 'warning',
        reason: declaredLength > shp.length ? 'The file is truncated; records beyond the end cannot be read.' : 'The file has trailing bytes beyond the declared length.',
        action: 'Re-export the shapefile if features appear to be missing.',
      })
    );
  }

  const headerShapeType = view.getInt32(32, true);
  const features: CirFeature[] = [];
  const shapeTypesSeen = new Set<number>();
  let at = 100;
  const limit = Math.min(shp.length, declaredLength > 0 ? Math.min(declaredLength, shp.length) : shp.length);

  while (at + 8 <= limit) {
    const contentLength = view.getInt32(at + 4, false) * 2;
    const contentStart = at + 8;
    if (contentLength <= 0 || contentStart + contentLength > limit) break;
    const { geometry, shapeType } = readShapeRecord(view, contentStart, contentLength);
    shapeTypesSeen.add(shapeType);
    features.push({ id: features.length, geometry, properties: {} });
    at = contentStart + contentLength;
  }

  // Attributes join to geometry by record order — the shapefile specification
  // guarantees the .dbf has one record per shape in the same sequence.
  if (parts.dbf) {
    const table = readDbf(parts.dbf, parts.cpg);
    if (table.records.length !== features.length && table.records.length + table.deletedCount !== features.length) {
      warnings.push(
        warn('SHP_DBF_COUNT_MISMATCH', `The geometry file holds ${features.length} shape(s) but the attribute table holds ${table.records.length} record(s).`, {
          reason: 'Shapefile joins geometry to attributes by record order, so a count mismatch means one of the two files is damaged or partially copied.',
          action: 'Re-export the shapefile; attributes have been attached in order as far as they go.',
        })
      );
    }
    features.forEach((feature, index) => {
      const record = table.records[index];
      if (record) feature.properties = { ...record };
    });
    if (table.deletedCount > 0) {
      warnings.push(
        warn('SHP_DELETED_RECORDS', `${table.deletedCount} attribute record(s) are flagged as deleted and were skipped.`, {
          severity: 'info',
          count: table.deletedCount,
          reason: 'dBASE marks deleted rows in place rather than removing them.',
          action: 'Pack the table in your GIS if the deleted rows should be removed permanently.',
        })
      );
    }
  } else {
    warnings.push(
      warn('SHP_NO_DBF', 'No .dbf attribute table accompanied the .shp file.', {
        reason: 'A shapefile is a package; the .dbf holds every attribute.',
        action: 'Add the matching .dbf file — geometry was read, but all attributes are missing.',
      })
    );
  }

  let crs: CrsRef | null = null;
  if (parts.prj) {
    const parsed = parsePrj(parts.prj);
    crs = parsed.crs;
    if (parsed.unsupportedProjection) {
      warnings.push(
        warn('SHP_PRJ_UNSUPPORTED', `The .prj declares "${parsed.unsupportedProjection}", which the bundled projection engine cannot transform.`, {
          reason: 'Only geographic, Transverse Mercator/UTM, Mercator and Lambert Conformal Conic are implemented.',
          action: 'Convert without changing the CRS, or reproject the data in QGIS first.',
        })
      );
    }
  } else {
    warnings.push(
      warn('SHP_NO_PRJ', 'No .prj file accompanied the shapefile, so the CRS is not declared.', {
        reason: 'Shapefile stores its CRS in a separate .prj file.',
        action: 'Select the source CRS before converting — it cannot be derived from the coordinates alone.',
      })
    );
  }

  if (shapeTypesSeen.size > 1) {
    warnings.push(
      warn('SHP_MIXED_SHAPE_TYPES', `The file mixes shape types: ${[...shapeTypesSeen].map((type) => SHAPE_TYPES[type] ?? type).join(', ')}.`, {
        reason: 'The specification allows only Null records to mix with the header shape type.',
        action: 'Check the output carefully; the file was produced by a non-conforming writer.',
      })
    );
  }

  const dataset = createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    crs,
    crsOrigin: crs ? 'sidecar' : 'unknown',
    units: crs?.kind === 'projected' ? 'm' : null,
    axisOrder: 'xy',
    layers: [createLayer(source.fileName, features, deriveFields(features))],
    warnings,
    metadata: {
      shapeType: SHAPE_TYPES[headerShapeType] ?? headerShapeType,
      declaredLength,
      hasZ: headerShapeType >= 11 && headerShapeType <= 18,
      hasM: headerShapeType >= 21,
    },
  });
  return dataset;
}

function readShapeRecord(view: DataView, at: number, length: number): ShapeReadResult {
  const shapeType = view.getInt32(at, true);
  const end = at + length;

  const readPoints = (offset: number, count: number, zOffset: number | null, mOffset: number | null): Position[] => {
    const positions: Position[] = [];
    for (let index = 0; index < count; index++) {
      const x = view.getFloat64(offset + index * 16, true);
      const y = view.getFloat64(offset + index * 16 + 8, true);
      const position: Position = [x, y];
      if (zOffset !== null) position.push(view.getFloat64(zOffset + index * 8, true));
      if (mOffset !== null) {
        const m = view.getFloat64(mOffset + index * 8, true);
        // Values below -1e38 are ESRI's "no measure" sentinel, not data.
        if (m > NO_DATA_THRESHOLD) {
          if (zOffset === null) position.push(0);
          position.push(m);
        }
      }
      positions.push(position);
    }
    return positions;
  };

  switch (shapeType) {
    case 0:
      return { geometry: null, shapeType };
    case 1:
    case 11:
    case 21: {
      const x = view.getFloat64(at + 4, true);
      const y = view.getFloat64(at + 12, true);
      const position: Position = [x, y];
      if (shapeType === 11) position.push(view.getFloat64(at + 20, true));
      return { geometry: { type: 'Point', coordinates: position, dimension: position.length >= 3 ? 3 : 2 }, shapeType };
    }
    case 8:
    case 18:
    case 28: {
      const count = view.getInt32(at + 36, true);
      const pointsAt = at + 40;
      const zOffset = shapeType === 18 ? pointsAt + count * 16 + 16 : null;
      const positions = readPoints(pointsAt, count, zOffset, null);
      return {
        geometry: { type: 'MultiPoint', coordinates: positions, dimension: zOffset !== null ? 3 : 2 },
        shapeType,
      };
    }
    case 3:
    case 5:
    case 13:
    case 15:
    case 23:
    case 25: {
      const partCount = view.getInt32(at + 36, true);
      const pointCount = view.getInt32(at + 40, true);
      assertWithinBuffer(at + 44 + partCount * 4 + pointCount * 16, end + pointCount * 16, {
        code: 'SHP_RECORD_TRUNCATED',
        unit: 'bytes',
        what: 'A shapefile record declares more geometry than the record holds.',
        action: 'Re-export the shapefile; this record is corrupt.',
      });
      const partsAt = at + 44;
      const pointsAt = partsAt + partCount * 4;
      const hasZ = shapeType === 13 || shapeType === 15;
      const zOffset = hasZ ? pointsAt + pointCount * 16 + 16 : null;
      const positions = readPoints(pointsAt, pointCount, zOffset, null);

      const parts: Position[][] = [];
      for (let index = 0; index < partCount; index++) {
        const start = view.getInt32(partsAt + index * 4, true);
        const stop = index + 1 < partCount ? view.getInt32(partsAt + (index + 1) * 4, true) : pointCount;
        parts.push(positions.slice(start, stop));
      }

      const dimension = hasZ ? 3 : 2;
      const isPolygon = shapeType === 5 || shapeType === 15 || shapeType === 25;
      if (!isPolygon) {
        return {
          geometry:
            parts.length === 1
              ? { type: 'LineString', coordinates: parts[0], dimension }
              : { type: 'MultiLineString', coordinates: parts, dimension },
          shapeType,
        };
      }
      return { geometry: assemblePolygons(parts, dimension), shapeType };
    }
    default:
      return { geometry: null, shapeType };
  }
}

/**
 * Groups shapefile rings into polygons.
 *
 * In the shapefile convention a clockwise ring is an outer boundary and a
 * counter-clockwise ring is a hole belonging to the enclosing outer ring. Any
 * reader that ignores this turns an island with a lake into two overlapping
 * polygons, so the containment test is worth the extra pass.
 */
function assemblePolygons(rings: Position[][], dimension: 2 | 3 | 4): CirGeometry {
  const outers: Position[][] = [];
  const holes: Position[][] = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    // The shapefile specification: walking an outer ring in vertex order keeps
    // the polygon interior on your right, which is clockwise, which is a
    // negative shoelace area. Holes run the other way.
    if (signedArea(ring) < 0) outers.push(ring);
    else holes.push(ring);
  }
  if (outers.length === 0) {
    // A file with only counter-clockwise rings was written by a non-conforming
    // producer; treating them all as outer rings loses less than dropping them.
    outers.push(...holes.splice(0, holes.length));
  }

  const polygons: Position[][][] = outers.map((outer) => [outer]);
  for (const hole of holes) {
    const probe = hole[0];
    let target = 0;
    let smallest = Infinity;
    for (let index = 0; index < outers.length; index++) {
      if (!pointInRing(probe, outers[index])) continue;
      const area = Math.abs(signedArea(outers[index]));
      // Nest into the smallest containing ring so a hole inside an island inside
      // a lake attaches to the island, not the outermost boundary.
      if (area < smallest) {
        smallest = area;
        target = index;
      }
    }
    polygons[target].push(hole);
  }

  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0], dimension };
  return { type: 'MultiPolygon', coordinates: polygons, dimension };
}

// ------------------------------------------------------------------ writing

type ShapeKind = 'point' | 'line' | 'polygon';

const SHAPE_TYPE_FOR: Record<ShapeKind, { flat: number; z: number }> = {
  point: { flat: 1, z: 11 },
  line: { flat: 3, z: 13 },
  polygon: { flat: 5, z: 15 },
};

export interface WriteShapefileOptions {
  precision: PrecisionPolicy;
  layerName: string;
  preserveZ: boolean;
  encoding: 'utf-8' | 'iso-8859-1';
  /** Fields to write; undefined writes all. */
  fields?: string[];
}

export interface ShapefileOutput {
  /** One package per geometry type present in the source. */
  packages: { name: string; kind: ShapeKind; files: ZipInput[] }[];
  warnings: Warning[];
  renames: Record<string, string>;
}

export function buildShapefile(dataset: CirDataset, options: WriteShapefileOptions): ShapefileOutput {
  const warnings: Warning[] = [];
  const renames: Record<string, string> = {};
  const byKind = new Map<ShapeKind, CirFeature[]>();

  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      if (!feature.geometry) continue;
      const kind = simpleKind(feature.geometry.type);
      if (kind === 'mixed') {
        // A GeometryCollection cannot be a shapefile record; split it so nothing
        // is silently dropped.
        for (const child of feature.geometry.geometries ?? []) {
          const childKind = simpleKind(child.type);
          if (childKind === 'mixed') continue;
          const list = byKind.get(childKind) ?? [];
          list.push({ ...feature, geometry: child });
          byKind.set(childKind, list);
        }
        continue;
      }
      const list = byKind.get(kind) ?? [];
      list.push({ ...feature, sourceLayer: feature.sourceLayer ?? layer.name });
      byKind.set(kind, list);
    }
  }

  if (byKind.size > 1) {
    warnings.push(
      warn('SHP_SPLIT_BY_TYPE', `The data holds ${byKind.size} geometry types and was split into ${byKind.size} shapefiles.`, {
        count: byKind.size,
        reason: 'One shapefile can hold exactly one geometry type.',
        action: `Files are named ${options.layerName}_point, _line and _polygon as applicable. Export to GeoPackage or GeoJSON to keep them together.`,
      })
    );
  }

  const prjText = buildPrj(dataset.crs);
  if (!prjText) {
    warnings.push(
      warn('SHP_NO_PRJ_WRITTEN', 'No .prj file was written because the CRS is undeclared or is a local grid.', {
        reason: 'Writing a .prj for an unknown CRS would assert a projection the data may not use.',
        action: 'Select a source CRS before converting so the package carries its projection.',
      })
    );
  }

  const packages: ShapefileOutput['packages'] = [];
  for (const [kind, features] of byKind) {
    const suffix = byKind.size > 1 ? `_${kind}` : '';
    const name = `${options.layerName}${suffix}`;
    const built = buildOnePackage(kind, features, dataset, options);
    warnings.push(...built.warnings);
    Object.assign(renames, built.renames);
    const files: ZipInput[] = [
      { name: `${name}.shp`, bytes: built.shp },
      { name: `${name}.shx`, bytes: built.shx },
      { name: `${name}.dbf`, bytes: built.dbf },
      { name: `${name}.cpg`, bytes: new TextEncoder().encode(options.encoding === 'utf-8' ? 'UTF-8' : 'ISO-8859-1') },
    ];
    if (prjText) files.push({ name: `${name}.prj`, bytes: new TextEncoder().encode(prjText) });
    packages.push({ name, kind, files });
  }

  return { packages, warnings, renames };
}

export async function writeShapefileZip(dataset: CirDataset, options: WriteShapefileOptions): Promise<{ bytes: Uint8Array; warnings: Warning[]; renames: Record<string, string> }> {
  const built = buildShapefile(dataset, options);
  const files = built.packages.flatMap((entry) => entry.files);
  if (files.length === 0) {
    throw new ConversionError({
      code: 'SHP_NO_GEOMETRY',
      what: 'No features with geometry were available to write.',
      why: 'Every feature in the dataset has a null geometry.',
      action: 'Check the source file in the inspector — the geometry may have failed to parse.',
    });
  }
  return { bytes: await writeZip(files), warnings: built.warnings, renames: built.renames };
}

interface BuiltPackage {
  shp: Uint8Array;
  shx: Uint8Array;
  dbf: Uint8Array;
  warnings: Warning[];
  renames: Record<string, string>;
}

function buildOnePackage(
  kind: ShapeKind,
  features: CirFeature[],
  dataset: CirDataset,
  options: WriteShapefileOptions
): BuiltPackage {
  const warnings: Warning[] = [];
  const geographic = dataset.crs?.kind === 'geographic';
  const format = coordinateFormatter(options.precision, geographic);
  const bounds = featuresBounds3(features);
  const wantsZ = options.preserveZ && Number.isFinite(bounds.minZ);
  const shapeType = wantsZ ? SHAPE_TYPE_FOR[kind].z : SHAPE_TYPE_FOR[kind].flat;

  if (!options.preserveZ && Number.isFinite(bounds.minZ)) {
    warnings.push(
      warn('SHP_Z_DROPPED', `Elevations were dropped: the package was written as ${SHAPE_TYPES[SHAPE_TYPE_FOR[kind].flat]} (2D).`, {
        reason: '"Preserve Z" is switched off in the conversion settings.',
        action: `Enable "Preserve Z" to write ${SHAPE_TYPES[SHAPE_TYPE_FOR[kind].z]} instead.`,
      })
    );
  }

  interface Record_ {
    parts: Position[][];
    properties: Record<string, unknown>;
  }

  const records: Record_[] = features.map((feature) => ({
    parts: shapeParts(feature.geometry!, kind, format, wantsZ),
    properties: feature.properties ?? {},
  }));

  const allFields = deriveFields(features);
  const selected = options.fields ? allFields.filter((field) => options.fields!.includes(field.name)) : allFields;
  if (options.fields && selected.length < allFields.length) {
    const dropped = allFields.filter((field) => !options.fields!.includes(field.name)).map((field) => field.name);
    warnings.push(
      warn('SHP_FIELDS_EXCLUDED', `${dropped.length} attribute field(s) were excluded by the field selection.`, {
        severity: 'info',
        count: dropped.length,
        reason: 'The conversion settings limit which attributes are written.',
        action: 'Clear the field selection to write every attribute.',
        detail: { excluded: dropped.slice(0, 50) },
      })
    );
  }
  const plan = planDbfFields(selected, records.map((record) => record.properties));
  warnings.push(...plan.warnings);

  // ---- .shp and .shx are built together; the index mirrors the record offsets.
  const bodies: Uint8Array[] = [];
  const offsets: number[] = [];
  const lengths: number[] = [];
  let offsetWords = 50; // 100-byte header in 16-bit words

  records.forEach((record, index) => {
    const content = encodeShape(record.parts, kind, shapeType, wantsZ);
    const header = new Uint8Array(8);
    const headerView = new DataView(header.buffer);
    headerView.setInt32(0, index + 1, false); // record numbers are 1-based
    headerView.setInt32(4, content.length / 2, false);
    bodies.push(header, content);
    offsets.push(offsetWords);
    lengths.push(content.length / 2);
    offsetWords += 4 + content.length / 2;
  });

  const bodyLength = bodies.reduce((sum, chunk) => sum + chunk.length, 0);
  const shp = new Uint8Array(100 + bodyLength);
  writeShapeHeader(shp, shapeType, 100 + bodyLength, bounds, wantsZ);
  let at = 100;
  for (const chunk of bodies) {
    shp.set(chunk, at);
    at += chunk.length;
  }

  const shx = new Uint8Array(100 + records.length * 8);
  writeShapeHeader(shx, shapeType, 100 + records.length * 8, bounds, wantsZ);
  const shxView = new DataView(shx.buffer);
  offsets.forEach((offset, index) => {
    shxView.setInt32(100 + index * 8, offset, false);
    shxView.setInt32(100 + index * 8 + 4, lengths[index], false);
  });

  const dbf = writeDbf(plan, records.map((record) => record.properties), options.encoding);
  return { shp, shx, dbf, warnings, renames: plan.renames };
}

function writeShapeHeader(target: Uint8Array, shapeType: number, byteLength: number, bounds: ReturnType<typeof featuresBounds3>, wantsZ: boolean): void {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
  view.setInt32(0, 9994, false);
  view.setInt32(24, byteLength / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, shapeType, true);
  const finite = Number.isFinite(bounds.minX);
  view.setFloat64(36, finite ? bounds.minX : 0, true);
  view.setFloat64(44, finite ? bounds.minY : 0, true);
  view.setFloat64(52, finite ? bounds.maxX : 0, true);
  view.setFloat64(60, finite ? bounds.maxY : 0, true);
  view.setFloat64(68, wantsZ && Number.isFinite(bounds.minZ) ? bounds.minZ : 0, true);
  view.setFloat64(76, wantsZ && Number.isFinite(bounds.maxZ) ? bounds.maxZ : 0, true);
  view.setFloat64(84, 0, true);
  view.setFloat64(92, 0, true);
}

function shapeParts(
  geometry: CirGeometry,
  kind: ShapeKind,
  format: ReturnType<typeof coordinateFormatter>,
  wantsZ: boolean
): Position[][] {
  const round = (position: Position): Position => {
    const out: Position = [format.x(position[0]), format.y(position[1])];
    if (wantsZ) out.push(position.length > 2 && Number.isFinite(position[2]) ? format.z(position[2]) : 0);
    return out;
  };

  switch (geometry.type) {
    case 'Point':
      return [[round(geometry.coordinates as Position)]];
    case 'MultiPoint':
      return [(geometry.coordinates as Position[]).map(round)];
    case 'LineString':
      return [(geometry.coordinates as Position[]).map(round)];
    case 'MultiLineString':
      return (geometry.coordinates as Position[][]).map((line) => line.map(round));
    case 'Polygon':
      return orientPolygon(geometry.coordinates as Position[][]).map((ring) => ring.map(round));
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).flatMap((rings) => orientPolygon(rings).map((ring) => ring.map(round)));
    default:
      return kind === 'point' ? [[]] : [];
  }
}

/** Shapefile wants clockwise outer rings and counter-clockwise holes. */
function orientPolygon(rings: Position[][]): Position[][] {
  return rings.map((ring, index) => {
    const closed = ring.length > 2 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ? [...ring, ring[0]] : ring;
    return orientRing(closed, index === 0);
  });
}

function encodeShape(parts: Position[][], kind: ShapeKind, shapeType: number, wantsZ: boolean): Uint8Array {
  if (kind === 'point') {
    const position = parts[0]?.[0] ?? [0, 0, 0];
    const size = wantsZ ? 36 : 20; // type + x + y [+ z + m]
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setInt32(0, shapeType, true);
    view.setFloat64(4, position[0] ?? 0, true);
    view.setFloat64(12, position[1] ?? 0, true);
    if (wantsZ) {
      view.setFloat64(20, position[2] ?? 0, true);
      view.setFloat64(28, -1e39, true); // no measure
    }
    return out;
  }

  const points = parts.flat();
  const partCount = parts.length;
  const pointCount = points.length;
  const base = 44 + partCount * 4 + pointCount * 16;
  const size = wantsZ ? base + 16 + pointCount * 8 : base;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const position of points) {
    if (position[0] < minX) minX = position[0];
    if (position[1] < minY) minY = position[1];
    if (position[0] > maxX) maxX = position[0];
    if (position[1] > maxY) maxY = position[1];
    const z = position[2];
    if (wantsZ && typeof z === 'number') {
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = minY = maxX = maxY = 0;
  }
  if (!Number.isFinite(minZ)) {
    minZ = maxZ = 0;
  }

  view.setInt32(0, shapeType, true);
  view.setFloat64(4, minX, true);
  view.setFloat64(12, minY, true);
  view.setFloat64(20, maxX, true);
  view.setFloat64(28, maxY, true);
  view.setInt32(36, partCount, true);
  view.setInt32(40, pointCount, true);

  let partStart = 0;
  parts.forEach((part, index) => {
    view.setInt32(44 + index * 4, partStart, true);
    partStart += part.length;
  });

  const pointsAt = 44 + partCount * 4;
  points.forEach((position, index) => {
    view.setFloat64(pointsAt + index * 16, position[0], true);
    view.setFloat64(pointsAt + index * 16 + 8, position[1], true);
  });

  if (wantsZ) {
    const zAt = pointsAt + pointCount * 16;
    view.setFloat64(zAt, minZ, true);
    view.setFloat64(zAt + 8, maxZ, true);
    points.forEach((position, index) => {
      view.setFloat64(zAt + 16 + index * 8, position[2] ?? 0, true);
    });
  }

  return out;
}
