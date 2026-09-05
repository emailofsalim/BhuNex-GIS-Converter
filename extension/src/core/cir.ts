/**
 * Canonical Intermediate Representation (CIR).
 *
 * Every reader produces a CirDataset and every writer consumes one. There are no
 * direct format-to-format paths: N formats then cost 2N engines instead of
 * N*(N-1) converters, and a capability or a warning added once is visible on
 * every path through the tool.
 *
 * Two invariants the whole pipeline leans on:
 *  - Coordinates are stored in the dataset CRS in x/y order (easting/northing or
 *    longitude/latitude). Axis-order quirks are resolved inside readers and
 *    re-applied inside writers, never carried through the middle.
 *  - Unknown is a real value. `crs: null` means "not declared", which is a
 *    different thing from a default, and the UI must show the difference.
 */

export type DataKind = 'vector' | 'raster' | 'pointcloud' | 'table' | 'archive' | 'sidecar';

export type GeometryType =
  | 'Point'
  | 'MultiPoint'
  | 'LineString'
  | 'MultiLineString'
  | 'Polygon'
  | 'MultiPolygon'
  | 'GeometryCollection';

/** [x, y] | [x, y, z] | [x, y, z, m] — never [lat, lon]. */
export type Position = number[];

export interface CirGeometry {
  type: GeometryType;
  /** Point: Position. LineString/MultiPoint: Position[]. Polygon/MultiLineString: Position[][]. MultiPolygon: Position[][][]. */
  coordinates?: any;
  geometries?: CirGeometry[];
  /** 2 = XY, 3 = XYZ, 4 = XYZM. Recorded rather than inferred so a 3D file with flat terrain stays 3D. */
  dimension: 2 | 3 | 4;
}

export interface FieldDef {
  name: string;
  /** Original name before any target-format mangling (DBF 10-byte truncation, etc.). */
  sourceName?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'date';
  width?: number;
  precision?: number;
}

export interface StyleHint {
  color?: string;
  lineWidth?: number;
  fillColor?: string;
  /** AutoCAD Color Index, preserved verbatim from CAD sources. */
  aci?: number;
  linetype?: string;
}

export interface CirFeature {
  id?: string | number;
  geometry: CirGeometry | null;
  properties: Record<string, unknown>;
  sourceLayer?: string;
  /** e.g. 'LWPOLYLINE', 'ARC', 'trkpt' — preserved so CAD provenance survives a GIS hop. */
  sourceEntity?: string;
  /** DXF handle or equivalent source identity. Never regenerated. */
  sourceHandle?: string;
  style?: StyleHint;
}

export interface CirLayer {
  name: string;
  features: CirFeature[];
  fields: FieldDef[];
  geometryTypes: GeometryType[];
  style?: StyleHint;
}

export type PixelType =
  | 'uint8'
  | 'int8'
  | 'uint16'
  | 'int16'
  | 'uint32'
  | 'int32'
  | 'float32'
  | 'float64'
  | 'unknown';

export interface CirRaster {
  width: number;
  height: number;
  bandCount: number;
  pixelType: PixelType;
  noData: number | null;
  /** GDAL order: [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight]. */
  geotransform: [number, number, number, number, number, number] | null;
  extent: Bounds | null;
  statistics?: { min: number; max: number; mean?: number }[];
  /** One entry per band, row-major. Absent when only the georeference was read. */
  bands?: Float64Array[];
  /**
   * False means georeference/structure only. A writer must refuse to emit a
   * raster product from such a source rather than invent pixels (rule R2).
   */
  hasPixelData: boolean;
  /** Elevation rasters get different defaults and different QA checks. */
  isElevation?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PointAttributeFlags {
  intensity: boolean;
  classification: boolean;
  returnNumber: boolean;
  numberOfReturns: boolean;
  color: boolean;
  gpsTime: boolean;
  scanAngle: boolean;
  sourceId: boolean;
}

/**
 * Typed arrays, not an array of point objects. A 40-million-point cloud as
 * objects is an out-of-memory crash; as typed arrays it is a buffer that
 * transfers to a worker at zero copy cost.
 */
export interface CirPointArrays {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  intensity?: Uint16Array;
  classification?: Uint8Array;
  returnNumber?: Uint8Array;
  numberOfReturns?: Uint8Array;
  /** Interleaved RGB triples, 16-bit as LAS stores them. */
  rgb?: Uint16Array;
  gpsTime?: Float64Array;
  scanAngle?: Int16Array;
  sourceId?: Uint16Array;
}

export interface CirPointCloud {
  /** Points the source declares. */
  count: number;
  /** Points actually materialised — differs from `count` only when decimated. */
  loaded: number;
  bounds: Bounds3 | null;
  scale: [number, number, number] | null;
  offset: [number, number, number] | null;
  pointFormat: number | null;
  versionMajor: number | null;
  versionMinor: number | null;
  attributes: PointAttributeFlags;
  points: CirPointArrays;
  decimation: { mode: 'none' | 'nth' | 'grid' | 'voxel'; factor?: number; cell?: number } | null;
}

export interface ColumnDef {
  name: string;
  type: 'string' | 'number';
}

export type ColumnRole =
  | 'id'
  | 'easting'
  | 'northing'
  | 'elevation'
  | 'latitude'
  | 'longitude'
  | 'code'
  | 'description'
  | 'ignore';

export interface ColumnMapping {
  /** Column index for each role. Roles absent from the table are simply missing. */
  roles: Partial<Record<Exclude<ColumnRole, 'ignore'>, number>>;
  /** Explicit, so latitude and longitude can never be swapped by accident. */
  coordinateOrder: 'easting-northing' | 'northing-easting' | 'lon-lat' | 'lat-lon';
  schemaId?: string;
}

export interface CirTable {
  columns: ColumnDef[];
  rows: (string | number | null)[][];
  mapping: ColumnMapping | null;
  detectedSchema: string | null;
  /** Header row present in the source; false means positional schema. */
  hasHeader: boolean;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Bounds3 extends Bounds {
  minZ: number;
  maxZ: number;
}

export type CrsOrigin = 'declared' | 'sidecar' | 'user' | 'inferred' | 'unknown';

export interface CrsRef {
  /** EPSG code where known, e.g. 32645. */
  epsg: number | null;
  name: string;
  kind: 'geographic' | 'projected' | 'local' | 'unknown';
  datum: string;
  projection: string;
  unit: string;
  /** Storage order the authority defines; readers normalise to x/y regardless. */
  axisOrder: 'xy' | 'yx';
  /** Original WKT/PROJ text when the source carried one, kept verbatim. */
  wkt?: string;
  proj4?: string;
  utm?: { zone: number; south: boolean };
}

export type VerticalKind = 'unknown' | 'ellipsoidal' | 'orthometric' | 'local';

export interface VerticalRef {
  kind: VerticalKind;
  name?: string;
}

export type WarningSeverity = 'info' | 'warning' | 'error';

export interface Warning {
  code: string;
  severity: WarningSeverity;
  /** What happened. */
  message: string;
  /** Why it happened — the format limitation or the missing input. */
  reason?: string;
  /** What the user can do about it. */
  action?: string;
  count?: number;
  detail?: Record<string, unknown>;
}

export interface SourceInfo {
  fileName: string;
  size: number;
  sha256?: string;
  formatId: string;
  formatName: string;
  detectionConfidence: number;
  /** Companion files that were grouped into this dataset. */
  companions?: string[];
}

export interface Provenance {
  sourceFile: string;
  sha256?: string;
  sourceFormat: string;
  detectionConfidence: number;
  sourceCrs: string | null;
  targetCrs: string | null;
  settingsSnapshot?: Record<string, unknown>;
  engineVersions: Record<string, string>;
  warnings: Warning[];
  qaResult?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface CirDataset {
  kind: DataKind;
  name: string;
  source: SourceInfo;
  crs: CrsRef | null;
  crsOrigin: CrsOrigin;
  /** Linear unit id from core/units.ts, or null when the source declares none. */
  units: string | null;
  axisOrder: 'xy' | 'yx' | 'unknown';
  vertical: VerticalRef;
  layers: CirLayer[];
  raster?: CirRaster;
  pointcloud?: CirPointCloud;
  table?: CirTable;
  warnings: Warning[];
  provenance?: Provenance;
  /** Free-form values a reader wants the inspector to show (DXF header, LAS VLRs). */
  metadata?: Record<string, unknown>;
}

export const ENGINE_VERSION = '1.0.0';

export function emptyPointAttributes(): PointAttributeFlags {
  return {
    intensity: false,
    classification: false,
    returnNumber: false,
    numberOfReturns: false,
    color: false,
    gpsTime: false,
    scanAngle: false,
    sourceId: false,
  };
}

export function createDataset(init: Partial<CirDataset> & { name: string; kind: DataKind; source: SourceInfo }): CirDataset {
  return {
    crs: null,
    crsOrigin: 'unknown',
    units: null,
    axisOrder: 'unknown',
    vertical: { kind: 'unknown' },
    layers: [],
    warnings: [],
    ...init,
  };
}

export function createLayer(name: string, features: CirFeature[] = [], fields: FieldDef[] = []): CirLayer {
  return { name, features, fields, geometryTypes: collectGeometryTypes(features) };
}

export function collectGeometryTypes(features: CirFeature[]): GeometryType[] {
  const seen = new Set<GeometryType>();
  for (const feature of features) if (feature.geometry) seen.add(feature.geometry.type);
  return [...seen];
}

export function allFeatures(dataset: CirDataset): CirFeature[] {
  if (dataset.layers.length === 1) return dataset.layers[0].features;
  const out: CirFeature[] = [];
  for (const layer of dataset.layers) out.push(...layer.features);
  return out;
}

export function featureCount(dataset: CirDataset): number {
  let total = 0;
  for (const layer of dataset.layers) total += layer.features.length;
  return total;
}

export function warn(
  code: string,
  message: string,
  options: { severity?: WarningSeverity; reason?: string; action?: string; count?: number; detail?: Record<string, unknown> } = {}
): Warning {
  return {
    code,
    severity: options.severity ?? 'warning',
    message,
    reason: options.reason,
    action: options.action,
    count: options.count,
    detail: options.detail,
  };
}

/**
 * Merges repeated warnings of the same code into one counted entry, so a DXF with
 * 4,000 unsupported entities produces one honest line rather than 4,000.
 */
export function collapseWarnings(warnings: Warning[]): Warning[] {
  const byCode = new Map<string, Warning>();
  for (const warning of warnings) {
    const key = `${warning.code}|${warning.message}`;
    const existing = byCode.get(key);
    if (existing) existing.count = (existing.count ?? 1) + (warning.count ?? 1);
    else byCode.set(key, { ...warning, count: warning.count ?? 1 });
  }
  return [...byCode.values()];
}
