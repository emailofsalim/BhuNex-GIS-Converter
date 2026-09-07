/**
 * Fidelity prediction (spec §22).
 *
 * Answers "what will this conversion cost me?" *before* it runs, so the
 * engineer picks a target with the price in view rather than discovering it in
 * the QA report afterwards.
 *
 * Two rules shape everything here:
 *
 *  - Every finding is COUNTED and NAMED. "Some attributes may be truncated" is
 *    useless; "3 field names exceed DBF's 10-byte limit: sample_description ->
 *    sample_des, collar_elevation -> collar_ele" is something a surveyor can
 *    act on. A finding that cannot name its subject is not worth raising.
 *  - The predictor NEVER converts. It reads the CIR and the registry only. That
 *    is what makes it cheap enough to run for every candidate target as the
 *    format list is drawn, and what keeps it honest: it cannot accidentally
 *    report what a writer happened to do rather than what the format allows.
 *
 * It is deliberately conservative. Where it cannot tell, it says so at INFO
 * rather than guessing a grade, because a false GREEN is worse than silence.
 */

import type { CirDataset, DataKind, GeometryType } from './cir';
import { allFeatures } from './cir';
import { FORMATS, getFormat, type FormatDef } from './registry';

/** The axes the master document requires a verdict on (spec §22.2). */
export type FidelityAxis =
  | 'geometry'
  | 'attributes'
  | 'crs'
  | 'z'
  | 'style'
  | 'label'
  | 'layer'
  | 'precision'
  | 'entities'
  | 'topology'
  | 'metadata';

export const FIDELITY_AXES: FidelityAxis[] = [
  'geometry',
  'attributes',
  'crs',
  'z',
  'style',
  'label',
  'layer',
  'precision',
  'entities',
  'topology',
  'metadata',
];

export const AXIS_LABEL: Record<FidelityAxis, string> = {
  geometry: 'Geometry',
  attributes: 'Attributes',
  crs: 'Coordinate system',
  z: 'Elevation (Z)',
  style: 'Styling',
  label: 'Labels',
  layer: 'Layers',
  precision: 'Precision',
  entities: 'Source entities',
  topology: 'Topology',
  metadata: 'Metadata',
};

/**
 * green  nothing is lost
 * yellow representable, but changed in a way worth knowing about
 * red    information present in the source cannot exist in the target
 */
export type FidelityGrade = 'green' | 'yellow' | 'red';

export const GRADE_LABEL: Record<FidelityGrade, string> = {
  green: 'High fidelity',
  yellow: 'Partial fidelity',
  red: 'Information loss',
};

export interface FidelityFinding {
  axis: FidelityAxis;
  grade: FidelityGrade;
  /** Stable code, so the UI and the manifest can key off it. */
  code: string;
  /** One sentence, counted and named. This is what the user reads. */
  statement: string;
  /** How many features, fields or values are affected. */
  count?: number;
  /** What to do instead, when there is something to do. */
  remedy?: string;
  /** Machine-readable specifics for the manifest. */
  detail?: Record<string, unknown>;
}

export interface FidelityPrediction {
  targetFormatId: string;
  targetFormatName: string;
  /** The worst grade across all axes. */
  overall: FidelityGrade;
  axes: Record<FidelityAxis, FidelityGrade>;
  findings: FidelityFinding[];
  /** True when the conversion cannot proceed at all. */
  blocked: boolean;
  /** Why it is blocked. Empty when it is not. */
  blockers: FidelityFinding[];
}

export interface PredictOptions {
  /** The CRS the user picked, when the source declares none. */
  sourceCrsEpsg?: number | null;
  /** Target CRS, when a reprojection is configured. */
  targetCrsEpsg?: number | null;
  /** Mirrors ConversionSettings.preserveZ. */
  preserveZ?: boolean;
  /** Decimal places when precision is fixed; undefined means full precision. */
  precisionDecimals?: number;
}

const WORST: Record<FidelityGrade, number> = { green: 0, yellow: 1, red: 2 };

function worse(left: FidelityGrade, right: FidelityGrade): FidelityGrade {
  return WORST[right] > WORST[left] ? right : left;
}

/** Geometry types a format can write, from its flags plus any explicit list. */
function writableGeometry(format: FormatDef): Set<GeometryType> {
  if (format.limits?.geometryTypes) return new Set(format.limits.geometryTypes);
  const types: GeometryType[] = ['Point', 'LineString', 'Polygon'];
  if (format.supportsMultiGeometry) types.push('MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection');
  return new Set(types);
}

/** Coarse family, so a MultiPolygon counts as a polygon for a shapefile split. */
function geometryFamily(type: GeometryType): 'point' | 'line' | 'polygon' | 'mixed' {
  if (type === 'Point' || type === 'MultiPoint') return 'point';
  if (type === 'LineString' || type === 'MultiLineString') return 'line';
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon';
  return 'mixed';
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Entities that have no GIS equivalent and are densified or dropped on the way out. */
const CURVE_ENTITIES = new Set(['ARC', 'CIRCLE', 'ELLIPSE', 'SPLINE']);
const ANNOTATION_ENTITIES = new Set(['TEXT', 'MTEXT', 'DIMENSION', 'LEADER', 'ATTDEF', 'ATTRIB']);

/**
 * Everything the predictor needs about a dataset, gathered in ONE pass.
 *
 * Ranking thirty candidate targets used to mean thirty walks over every
 * feature; with a profile it means one walk and thirty cheap comparisons. That
 * matters at the size these files actually come in — and it is also what lets
 * the worker compute a profile once, hand it to the UI thread, and have the UI
 * predict against any target without shipping millions of features across the
 * boundary or, worse, predicting from a truncated preview and reporting counts
 * that are quietly wrong.
 */
export interface DatasetProfile {
  kind: DataKind;
  featureCount: number;
  /** Feature count per geometry type. */
  geometryCounts: Partial<Record<GeometryType, number>>;
  /** Distinct coarse families present: point, line, polygon. */
  families: string[];
  nullGeometry: number;
  withZ: number;
  fields: string[];
  /** Count of text values longer than each byte limit any format declares. */
  textOverflow: Record<number, { count: number; fields: string[] }>;
  /** Field names longer than each length limit any format declares. */
  nameOverflow: Record<number, string[]>;
  styledCount: number;
  labelledCount: number;
  entityCounts: Record<string, number>;
  layerCount: number;
  metadataKeys: string[];
  crsEpsg: number | null;
  crsKind: string | null;
  hasCrs: boolean;
  raster: { width: number; height: number; bandCount: number; hasPixelData: boolean; rotated: boolean } | null;
  pointcloud: { count: number; loaded: number; decimated: boolean; attributes: string[] } | null;
}

/** Byte and character limits that any format in the registry declares. */
const TEXT_LIMITS = [...new Set(FORMATS.map((format) => format.limits?.maxTextValueBytes).filter((limit): limit is number => !!limit))];
const NAME_LIMITS = [...new Set(FORMATS.map((format) => format.limits?.maxFieldNameLength).filter((limit): limit is number => !!limit))];

export function profileDataset(dataset: CirDataset): DatasetProfile {
  const features = dataset.kind === 'vector' ? allFeatures(dataset) : [];
  const geometryCounts: Partial<Record<GeometryType, number>> = {};
  const families = new Set<string>();
  const entityCounts: Record<string, number> = {};
  const textOverflow: Record<number, { count: number; fields: Set<string> }> = {};
  for (const limit of TEXT_LIMITS) textOverflow[limit] = { count: 0, fields: new Set() };

  let nullGeometry = 0;
  let withZ = 0;
  let styledCount = dataset.layers.filter((layer) => layer.style).length;
  let labelledCount = 0;

  for (const feature of features) {
    if (feature.geometry) {
      const type = feature.geometry.type;
      geometryCounts[type] = (geometryCounts[type] ?? 0) + 1;
      families.add(geometryFamily(type));
      if ((feature.geometry.dimension ?? 2) >= 3) withZ++;
    } else {
      nullGeometry++;
    }
    if (feature.style) styledCount++;
    if (feature.sourceEntity) entityCounts[feature.sourceEntity] = (entityCounts[feature.sourceEntity] ?? 0) + 1;

    const properties = feature.properties ?? {};
    if (typeof properties.name === 'string' || typeof properties.label === 'string') labelledCount++;
    if (TEXT_LIMITS.length > 0) {
      for (const [key, value] of Object.entries(properties)) {
        if (typeof value !== 'string') continue;
        const length = utf8Length(value);
        for (const limit of TEXT_LIMITS) {
          if (length > limit) {
            textOverflow[limit].count++;
            textOverflow[limit].fields.add(key);
          }
        }
      }
    }
  }

  const fieldNames = new Set<string>();
  for (const layer of dataset.layers) for (const field of layer.fields) fieldNames.add(field.name);
  if (fieldNames.size === 0 && dataset.table) for (const column of dataset.table.columns) fieldNames.add(column.name);

  const nameOverflow: Record<number, string[]> = {};
  for (const limit of NAME_LIMITS) nameOverflow[limit] = [...fieldNames].filter((name) => utf8Length(name) > limit);

  const raster = dataset.raster;
  const cloud = dataset.pointcloud;

  return {
    kind: dataset.kind,
    featureCount: features.length,
    geometryCounts,
    families: [...families],
    nullGeometry,
    withZ,
    fields: [...fieldNames],
    textOverflow: Object.fromEntries(
      Object.entries(textOverflow).map(([limit, entry]) => [Number(limit), { count: entry.count, fields: [...entry.fields] }])
    ),
    nameOverflow,
    styledCount,
    labelledCount,
    entityCounts,
    layerCount: dataset.layers.length,
    metadataKeys: Object.keys(dataset.metadata ?? {}),
    crsEpsg: dataset.crs?.epsg ?? null,
    crsKind: dataset.crs?.kind ?? null,
    hasCrs: Boolean(dataset.crs),
    raster: raster
      ? {
          width: raster.width,
          height: raster.height,
          bandCount: raster.bandCount,
          hasPixelData: raster.hasPixelData,
          rotated: Boolean(raster.geotransform && (raster.geotransform[2] !== 0 || raster.geotransform[4] !== 0)),
        }
      : null,
    pointcloud: cloud
      ? {
          count: cloud.count,
          loaded: cloud.loaded,
          decimated: Boolean(cloud.decimation) && cloud.loaded < cloud.count,
          attributes: Object.entries(cloud.attributes).filter(([, present]) => present).map(([name]) => name),
        }
      : null,
  };
}

/**
 * Predicts what a conversion of `dataset` to `targetFormatId` would cost.
 *
 * Pure: no bytes are written and the dataset is not modified.
 */
export function predictConversion(dataset: CirDataset, targetFormatId: string, options: PredictOptions = {}): FidelityPrediction {
  return predictFromProfile(profileDataset(dataset), targetFormatId, options);
}

/**
 * The same prediction, from a profile that has already been computed.
 *
 * This is the form the UI uses: profile once where the full dataset lives,
 * then rank every candidate target without touching a feature again.
 */
export function predictFromProfile(profile: DatasetProfile, targetFormatId: string, options: PredictOptions = {}): FidelityPrediction {
  const format = getFormat(targetFormatId);
  const findings: FidelityFinding[] = [];

  if (!format) {
    return blockedPrediction(targetFormatId, targetFormatId, {
      axis: 'geometry',
      grade: 'red',
      code: 'TARGET_UNKNOWN',
      statement: `"${targetFormatId}" is not a format this build knows.`,
    });
  }

  // --- can this conversion happen at all? ---------------------------------
  if (format.support.export === 'none') {
    return blockedPrediction(format.id, format.name, {
      axis: 'geometry',
      grade: 'red',
      code: 'TARGET_READ_ONLY',
      statement: `${format.name} can be read but not written by this build.`,
      remedy: 'Pick a different target format.',
    });
  }
  if (format.support.export === 'adapter') {
    return blockedPrediction(format.id, format.name, {
      axis: 'geometry',
      grade: 'red',
      code: 'TARGET_NEEDS_ENGINE',
      statement: `${format.name} needs an engine that is not installed${format.requiresNative ? ' (native helper)' : format.requiresWasm ? ' (WASM codec)' : ''}.`,
      remedy: format.requiresNative
        ? 'Install the local helper described in docs/NATIVE_HOST.md, or pick another target.'
        : 'Pick another target format.',
    });
  }

  const kindFinding = checkDataKind(profile.kind, format);
  if (kindFinding) return blockedPrediction(format.id, format.name, kindFinding);

  // --- axis by axis --------------------------------------------------------
  findings.push(...predictGeometry(profile, format));
  findings.push(...predictZ(profile, format, options));
  findings.push(...predictAttributes(profile, format));
  findings.push(...predictCrs(profile, format, options));
  findings.push(...predictLayers(profile, format));
  findings.push(...predictStyleAndLabels(profile, format));
  findings.push(...predictEntities(profile, format));
  findings.push(...predictPrecision(profile, options));
  findings.push(...predictRaster(profile, format));
  findings.push(...predictPointCloud(profile, format));
  findings.push(...predictMetadata(profile, format));

  const axes = {} as Record<FidelityAxis, FidelityGrade>;
  for (const axis of FIDELITY_AXES) axes[axis] = 'green';
  let overall: FidelityGrade = 'green';
  for (const finding of findings) {
    axes[finding.axis] = worse(axes[finding.axis], finding.grade);
    overall = worse(overall, finding.grade);
  }

  // A red finding describes loss, not impossibility. Only the checks above,
  // which return early, can block a conversion — otherwise the user would be
  // prevented from making a trade-off they may well accept.
  return { targetFormatId: format.id, targetFormatName: format.name, overall, axes, findings, blocked: false, blockers: [] };
}

function blockedPrediction(id: string, name: string, finding: Omit<FidelityFinding, 'grade'> & { grade?: FidelityGrade }): FidelityPrediction {
  const full: FidelityFinding = { grade: 'red', ...finding };
  const axes = {} as Record<FidelityAxis, FidelityGrade>;
  for (const axis of FIDELITY_AXES) axes[axis] = 'green';
  axes[full.axis] = 'red';
  return { targetFormatId: id, targetFormatName: name, overall: 'red', axes, findings: [full], blocked: true, blockers: [full] };
}

/**
 * Data-kind compatibility.
 *
 * A vector source cannot become a raster without a rasteriser, and a raster
 * cannot become vector without a vectoriser; neither is built. Saying so up
 * front is better than a writer-level refusal halfway through a batch.
 */
function checkDataKind(from: DataKind, format: FormatDef): FidelityFinding | null {
  const to = format.dataKind;
  if (from === to) return null;
  if (to === 'sidecar' || to === 'archive') return null;

  // The genuinely supported cross-kind paths.
  const allowed: Record<string, string[]> = {
    // A survey table becomes points; points become a table of coordinates.
    table: ['vector', 'table'],
    vector: ['vector', 'table'],
    // A cloud can be written as points or as a coordinate list.
    pointcloud: ['pointcloud', 'vector', 'table'],
    // A raster's footprint is exportable as vector (rasterFootprint).
    raster: ['raster', 'vector'],
  };
  if (allowed[from]?.includes(to)) return null;

  return {
    axis: 'geometry',
    grade: 'red',
    code: 'KIND_INCOMPATIBLE',
    statement: `This is ${describeKind(from)} data and ${format.name} stores ${describeKind(to)} data. No engine converts between them.`,
    remedy: `Choose a ${describeKind(from)} target instead.`,
    detail: { sourceKind: from, targetKind: to },
  };
}

function describeKind(kind: string): string {
  switch (kind) {
    case 'vector':
      return 'vector';
    case 'raster':
      return 'raster';
    case 'pointcloud':
      return 'point-cloud';
    case 'table':
      return 'tabular';
    default:
      return kind;
  }
}

function predictGeometry(profile: DatasetProfile, format: FormatDef): FidelityFinding[] {
  if (profile.kind !== 'vector' || profile.featureCount === 0) return [];
  const findings: FidelityFinding[] = [];
  const writable = writableGeometry(format);

  const unsupported = new Map<GeometryType, number>();
  for (const [type, count] of Object.entries(profile.geometryCounts)) {
    if (!writable.has(type as GeometryType)) unsupported.set(type as GeometryType, count);
  }
  const families = new Set(profile.families);
  const nullGeometry = profile.nullGeometry;

  for (const [type, count] of unsupported) {
    // A multi-geometry in a single-geometry format is split, not lost — that is
    // a different cost from a polygon in a format with no polygons.
    const isMulti = type.startsWith('Multi');
    const family = geometryFamily(type);
    const singleEquivalent = family === 'point' ? 'Point' : family === 'line' ? 'LineString' : 'Polygon';
    if (isMulti && writable.has(singleEquivalent as GeometryType)) {
      findings.push({
        axis: 'geometry',
        grade: 'yellow',
        code: 'GEOM_MULTIPART_SPLIT',
        statement: `${count.toLocaleString()} ${type} feature(s) will be split into separate ${singleEquivalent} features: ${format.name} has no multi-part geometry.`,
        count,
        remedy: 'Use GeoJSON, KML or GeoPackage if the multi-part grouping matters.',
        detail: { geometryType: type },
      });
    } else {
      findings.push({
        axis: 'geometry',
        grade: 'red',
        code: 'GEOM_UNSUPPORTED',
        statement: `${count.toLocaleString()} ${type} feature(s) cannot be written: ${format.name} does not store that geometry.`,
        count,
        remedy: `${format.name} writes ${[...writable].join(', ')}.`,
        detail: { geometryType: type },
      });
    }
  }

  if (nullGeometry > 0 && format.dataKind === 'vector') {
    findings.push({
      axis: 'geometry',
      grade: 'yellow',
      code: 'GEOM_NULL',
      statement: `${nullGeometry.toLocaleString()} feature(s) have no geometry and will be written as attributes only, or dropped by readers that require geometry.`,
      count: nullGeometry,
    });
  }

  if (format.limits?.singleGeometryTypePerFile && families.size > 1) {
    findings.push({
      axis: 'geometry',
      grade: 'yellow',
      code: 'GEOM_SPLIT_BY_TYPE',
      statement: `The data mixes ${[...families].join(', ')} geometry, so the output becomes ${families.size} separate ${format.name} files.`,
      count: families.size,
      remedy: 'This is how the format works; the delivery keeps the files together.',
      detail: { families: [...families] },
    });
  }

  return findings;
}

function predictZ(profile: DatasetProfile, format: FormatDef, options: PredictOptions): FidelityFinding[] {
  const withZ = profile.withZ;
  if (withZ === 0) return [];

  if (!format.supportsZ) {
    return [
      {
        axis: 'z',
        grade: 'red',
        code: 'Z_UNSUPPORTED',
        statement: `${withZ.toLocaleString()} feature(s) carry elevation, and ${format.name} stores 2D coordinates only. Every Z value will be dropped.`,
        count: withZ,
        remedy: 'Use GeoJSON, KML, DXF, Shapefile (PointZ/PolyLineZ) or LandXML to keep elevations.',
      },
    ];
  }
  if (options.preserveZ === false) {
    return [
      {
        axis: 'z',
        grade: 'red',
        code: 'Z_DISABLED',
        statement: `${withZ.toLocaleString()} feature(s) carry elevation, but "Preserve Z" is switched off, so it will not be written.`,
        count: withZ,
        remedy: 'Switch "Preserve Z" on in the conversion settings.',
      },
    ];
  }
  return [];
}

function predictAttributes(profile: DatasetProfile, format: FormatDef): FidelityFinding[] {
  const findings: FidelityFinding[] = [];
  const fields = profile.fields;
  if (fields.length === 0) return findings;

  if (!format.supportsAttributes) {
    findings.push({
      axis: 'attributes',
      grade: 'red',
      code: 'ATTR_UNSUPPORTED',
      statement: `${fields.length} attribute field(s) will be dropped: ${format.name} stores geometry only.`,
      count: fields.length,
      remedy: 'Use GeoJSON, Shapefile, KML or CSV to keep the attribute table.',
      detail: { fields: fields.slice(0, 20) },
    });
    return findings;
  }

  const maxName = format.limits?.maxFieldNameLength;
  if (maxName) {
    const overlong = profile.nameOverflow[maxName] ?? [];
    if (overlong.length > 0) {
      // Naming the renames is the point: a downstream join breaks silently
      // otherwise, and the user finds out weeks later.
      const examples = overlong.slice(0, 4).map((name) => `${name} -> ${name.slice(0, maxName)}`);
      findings.push({
        axis: 'attributes',
        grade: 'yellow',
        code: 'ATTR_NAME_TRUNCATED',
        statement: `${overlong.length} field name(s) exceed ${format.name}'s ${maxName}-character limit and will be shortened: ${examples.join(', ')}${overlong.length > examples.length ? ', …' : ''}.`,
        count: overlong.length,
        remedy: 'Rename the fields before converting if downstream joins depend on the full names.',
        detail: { fields: overlong.slice(0, 20) },
      });
    }
  }

  const maxValue = format.limits?.maxTextValueBytes;
  const overflow = maxValue ? profile.textOverflow[maxValue] : undefined;
  if (overflow && overflow.count > 0) {
    findings.push({
      axis: 'attributes',
      grade: 'yellow',
      code: 'ATTR_VALUE_TRUNCATED',
      statement: `${overflow.count.toLocaleString()} text value(s) in ${overflow.fields.slice(0, 3).join(', ')} exceed ${format.name}'s ${maxValue}-byte limit and will be cut.`,
      count: overflow.count,
      remedy: 'Use GeoJSON or GeoPackage if the full text matters.',
      detail: { fields: overflow.fields },
    });
  }

  return findings;
}

function predictCrs(profile: DatasetProfile, format: FormatDef, options: PredictOptions): FidelityFinding[] {
  const findings: FidelityFinding[] = [];
  const sourceEpsg = profile.crsEpsg ?? options.sourceCrsEpsg ?? null;
  const mandated = format.limits?.mandatesCrsEpsg;

  if (!profile.hasCrs && !options.sourceCrsEpsg && profile.kind !== 'table') {
    findings.push({
      axis: 'crs',
      grade: 'red',
      code: 'CRS_UNKNOWN',
      statement: 'The source declares no coordinate reference system, so the output cannot state one either.',
      remedy: 'Select the source CRS in the conversion settings. It is never guessed from the coordinates alone.',
    });
  }

  if (mandated && sourceEpsg && sourceEpsg !== mandated) {
    findings.push({
      axis: 'crs',
      grade: 'yellow',
      code: 'CRS_REPROJECTION_REQUIRED',
      statement: `${format.name} is defined in EPSG:${mandated}, so coordinates will be reprojected from EPSG:${sourceEpsg}.`,
      remedy: 'Expected for this format. Reprojection is recorded in the conversion report.',
      detail: { from: sourceEpsg, to: mandated },
    });
  }

  if (!format.supportsCRS && sourceEpsg && !mandated) {
    findings.push({
      axis: 'crs',
      grade: 'yellow',
      code: 'CRS_NOT_CARRIED',
      statement: `${format.name} has no place to record a coordinate system, so EPSG:${sourceEpsg} will not travel with the file.`,
      remedy: 'Keep the .prj alongside, or use a format that carries its CRS.',
      detail: { epsg: sourceEpsg },
    });
  }

  if (options.targetCrsEpsg && sourceEpsg && options.targetCrsEpsg !== sourceEpsg) {
    findings.push({
      axis: 'crs',
      grade: 'yellow',
      code: 'CRS_TRANSFORM_CONFIGURED',
      statement: `Coordinates will be transformed from EPSG:${sourceEpsg} to EPSG:${options.targetCrsEpsg}.`,
      remedy: 'Intended, if you configured it. Every transform is recorded.',
      detail: { from: sourceEpsg, to: options.targetCrsEpsg },
    });
  }

  return findings;
}

function predictLayers(profile: DatasetProfile, format: FormatDef): FidelityFinding[] {
  const layerCount = profile.layerCount;
  if (layerCount <= 1) return [];
  const model = format.limits?.layerModel ?? 'none';

  switch (model) {
    case 'native':
    case 'folders':
      return [];
    case 'files':
      return [
        {
          axis: 'layer',
          grade: 'yellow',
          code: 'LAYER_SPLIT_TO_FILES',
          statement: `${layerCount} layers become ${layerCount} separate ${format.name} files, in folders that reproduce the layer hierarchy.`,
          count: layerCount,
          remedy: 'The delivery keeps them together; the folder tree is shown before download.',
        },
      ];
    case 'property':
      return [
        {
          axis: 'layer',
          grade: 'yellow',
          code: 'LAYER_AS_PROPERTY',
          statement: `${format.name} has no layer concept, so the ${layerCount} layers are carried in a "_layer" property and rebuilt on re-import.`,
          count: layerCount,
          remedy: 'Choose "one file per layer" in the output structure setting to keep them as separate files.',
        },
      ];
    default:
      return [
        {
          axis: 'layer',
          grade: 'red',
          code: 'LAYER_FLATTENED',
          statement: `${format.name} cannot express layers, so the ${layerCount} layers will be merged into one.`,
          count: layerCount,
          remedy: 'Choose "one file per layer" in the output structure setting to keep them separate.',
        },
      ];
  }
}

function predictStyleAndLabels(profile: DatasetProfile, format: FormatDef): FidelityFinding[] {
  const findings: FidelityFinding[] = [];
  const styled = profile.styledCount;
  if (styled > 0 && !format.limits?.stylePreserved) {
    findings.push({
      axis: 'style',
      grade: 'yellow',
      code: 'STYLE_DROPPED',
      statement: `${styled.toLocaleString()} styled feature(s) or layer(s) will lose colour, line width and fill: ${format.name} carries no styling.`,
      count: styled,
      remedy: 'Use KML/KMZ or DXF to keep appearance.',
    });
  }

  // A label is only "kept" if the target has somewhere a viewer will show it.
  const labelled = profile.labelledCount;
  if (labelled > 0 && !format.limits?.labelPreserved && format.supportsAttributes) {
    findings.push({
      axis: 'label',
      grade: 'yellow',
      code: 'LABEL_AS_ATTRIBUTE_ONLY',
      statement: `${labelled.toLocaleString()} label(s) will survive as an attribute but ${format.name} has no label that a viewer displays.`,
      count: labelled,
      remedy: 'Use KML/KMZ or DXF if the label must be visible without styling the layer.',
    });
  }

  return findings;
}

function predictEntities(profile: DatasetProfile, format: FormatDef): FidelityFinding[] {
  const findings: FidelityFinding[] = [];
  const byEntity = new Map(Object.entries(profile.entityCounts));
  if (byEntity.size === 0) return findings;

  if (!format.supportsCurves) {
    const curves = [...byEntity.entries()].filter(([entity]) => CURVE_ENTITIES.has(entity));
    const total = curves.reduce((sum, [, count]) => sum + count, 0);
    if (total > 0) {
      findings.push({
        axis: 'entities',
        grade: 'yellow',
        code: 'ENTITY_CURVES_DENSIFIED',
        statement: `${total.toLocaleString()} curved entit(y/ies) (${curves.map(([entity, count]) => `${count} ${entity}`).join(', ')}) will be densified into straight segments: ${format.name} has no arcs.`,
        count: total,
        remedy: 'The arc tolerance setting controls how closely the segments follow the original curve. DXF keeps true arcs.',
        detail: { entities: Object.fromEntries(curves) },
      });
    }
  }

  const annotations = [...byEntity.entries()].filter(([entity]) => ANNOTATION_ENTITIES.has(entity));
  const annotationTotal = annotations.reduce((sum, [, count]) => sum + count, 0);
  if (annotationTotal > 0 && !format.limits?.labelPreserved) {
    findings.push({
      axis: 'entities',
      grade: 'yellow',
      code: 'ENTITY_ANNOTATION_TO_POINTS',
      statement: `${annotationTotal.toLocaleString()} CAD annotation entit(y/ies) (${annotations.map(([entity, count]) => `${count} ${entity}`).join(', ')}) become plain points carrying their text as an attribute.`,
      count: annotationTotal,
      remedy: 'DXF and KML keep annotation as annotation.',
      detail: { entities: Object.fromEntries(annotations) },
    });
  }

  return findings;
}

function predictPrecision(profile: DatasetProfile, options: PredictOptions): FidelityFinding[] {
  const decimals = options.precisionDecimals;
  if (decimals === undefined) return [];

  // Decimals mean nothing until they are ground distance. A surveyor reads
  // "0.001 m" instantly; "3 decimal places" needs converting in their head, and
  // means something wildly different in degrees than in metres — 3 dp of a
  // degree is about 111 m, which would be a serious loss nobody intended.
  const geographic = profile.crsKind === 'geographic';
  const metres = geographic ? 10 ** -decimals * 111_320 : 10 ** -decimals;
  // A millimetre is the threshold below which survey work is unaffected.
  const grade: FidelityGrade = metres <= 0.001 ? 'green' : 'yellow';
  if (grade === 'green') return [];

  const rounded = metres >= 1 ? `${metres.toFixed(0)} m` : metres >= 0.01 ? `${(metres * 100).toFixed(1)} cm` : `${(metres * 1000).toFixed(1)} mm`;
  return [
    {
      axis: 'precision',
      grade,
      code: 'PRECISION_ROUNDED',
      statement: geographic
        ? `Coordinates will be written to ${decimals} decimal place(s) of a degree, rounding every position to about ${rounded} on the ground.`
        : `Coordinates will be written to ${decimals} decimal place(s), rounding every position to the nearest ${rounded}.`,
      remedy: 'Set precision to "full" in the conversion settings to write every digit the source carries.',
      detail: { decimals, groundMetres: metres },
    },
  ];
}

function predictRaster(profile: DatasetProfile, format: FormatDef): FidelityFinding[] {
  const raster = profile.raster;
  if (!raster) return [];
  const findings: FidelityFinding[] = [];

  if (format.dataKind === 'vector') {
    findings.push({
      axis: 'geometry',
      grade: 'red',
      code: 'RASTER_TO_FOOTPRINT',
      statement: `Only the raster's footprint will be written as a polygon; the ${(raster.width * raster.height).toLocaleString()} pixels are not vectorised.`,
      remedy: 'No vectoriser is bundled. Use a raster target to keep the pixels.',
    });
    return findings;
  }

  if (!raster.hasPixelData) {
    findings.push({
      axis: 'geometry',
      grade: 'red',
      code: 'RASTER_NO_PIXELS',
      statement: 'The source raster has georeference but no decoded pixel values, so no raster output can be produced from it.',
      remedy: 'Re-export the source with a compression this build decodes, or export the footprint as vector.',
    });
    return findings;
  }

  const maxBands = format.limits?.maxBands;
  if (maxBands && raster.bandCount > maxBands) {
    findings.push({
      axis: 'geometry',
      grade: 'red',
      code: 'RASTER_BANDS_DROPPED',
      statement: `The raster has ${raster.bandCount} bands and ${format.name} stores ${maxBands}. Band 1 will be written and ${raster.bandCount - maxBands} discarded.`,
      count: raster.bandCount - maxBands,
      remedy: 'Use GeoTIFF to keep every band.',
    });
  }

  if (raster.rotated) {
    findings.push({
      axis: 'crs',
      grade: 'yellow',
      code: 'RASTER_ROTATION_DROPPED',
      statement: 'The raster georeference includes rotation, which an axis-aligned writer cannot express.',
      remedy: 'Rectify the raster first if the rotation matters. Pixel values are unaffected.',
    });
  }

  return findings;
}

function predictPointCloud(profile: DatasetProfile, format: FormatDef): FidelityFinding[] {
  const cloud = profile.pointcloud;
  if (!cloud) return [];
  const findings: FidelityFinding[] = [];

  if (cloud.decimated) {
    findings.push({
      axis: 'geometry',
      grade: 'red',
      code: 'CLOUD_DECIMATED',
      statement: `${cloud.loaded.toLocaleString()} of ${cloud.count.toLocaleString()} points are loaded; the output will contain the decimated set, not the full cloud.`,
      count: cloud.count - cloud.loaded,
      remedy: 'Set decimation to "none" to write every point.',
    });
  }

  if (format.dataKind === 'pointcloud' || format.dataKind === 'table') {
    const attributes = cloud.attributes;
    if (attributes.length > 0 && format.id !== 'las' && format.id !== 'laz') {
      findings.push({
        axis: 'attributes',
        grade: 'yellow',
        code: 'CLOUD_ATTRIBUTES_REDUCED',
        statement: `${format.name} carries fewer per-point attributes than the source, which has ${attributes.join(', ')}.`,
        remedy: 'Use LAS to keep classification, intensity, return number and GPS time.',
        detail: { attributes },
      });
    }
  }

  if (format.dataKind === 'vector') {
    findings.push({
      axis: 'geometry',
      grade: 'yellow',
      code: 'CLOUD_TO_POINTS',
      statement: `${cloud.loaded.toLocaleString()} point(s) become individual vector features, which most GIS tools handle far more slowly than a point cloud.`,
      count: cloud.loaded,
      remedy: 'Keep a point-cloud target, or decimate first, if the tool downstream is a GIS.',
    });
  }

  return findings;
}

function predictMetadata(profile: DatasetProfile, format: FormatDef): FidelityFinding[] {
  const keys = profile.metadataKeys;
  if (keys.length === 0) return [];
  // Formats with a native metadata slot. Everywhere else it travels only in the
  // conversion manifest, which is worth saying rather than implying.
  const carriers = new Set(['geojson', 'kml', 'kmz', 'gml', 'landxml', 'geotiff', 'las', 'xlsx']);
  if (carriers.has(format.id)) return [];
  return [
    {
      axis: 'metadata',
      grade: 'yellow',
      code: 'METADATA_MANIFEST_ONLY',
      statement: `${keys.length} source metadata item(s) have no place in ${format.name} and will appear only in the conversion manifest.`,
      count: keys.length,
      remedy: 'Enable "embed metadata" to include the provenance record in the delivery.',
      detail: { keys: keys.slice(0, 20) },
    },
  ];
}

/**
 * Ranks candidate targets best-first (spec §25, "recommend compatible output
 * formats and explain why").
 *
 * Ordering is by grade, then by how few findings the conversion raises, then by
 * name so the list is stable between runs.
 */
export function rankTargets(dataset: CirDataset, targetIds: string[], options: PredictOptions = {}): FidelityPrediction[] {
  return rankTargetsFromProfile(profileDataset(dataset), targetIds, options);
}

/** Ranks from a profile, so the whole candidate list costs one pass in total. */
export function rankTargetsFromProfile(profile: DatasetProfile, targetIds: string[], options: PredictOptions = {}): FidelityPrediction[] {
  return targetIds
    .map((id) => predictFromProfile(profile, id, options))
    .sort((left, right) => {
      if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
      const byGrade = WORST[left.overall] - WORST[right.overall];
      if (byGrade !== 0) return byGrade;
      const byCount = left.findings.length - right.findings.length;
      if (byCount !== 0) return byCount;
      return left.targetFormatName.localeCompare(right.targetFormatName);
    });
}

/**
 * Export validation (rule R22, spec §35).
 *
 * READY or BLOCKED, with the exact reasons. Only genuine impossibility blocks:
 * a red finding is a cost the user is entitled to accept, and refusing it would
 * be this tool deciding what someone may do with their own data.
 */
export interface ExportReadiness {
  ready: boolean;
  reasons: FidelityFinding[];
  /** Losses the user should acknowledge, which do not block. */
  acknowledgements: FidelityFinding[];
}

export function validateExport(dataset: CirDataset, targetFormatId: string, options: PredictOptions = {}): ExportReadiness {
  const prediction = predictConversion(dataset, targetFormatId, options);
  if (prediction.blocked) return { ready: false, reasons: prediction.blockers, acknowledgements: [] };
  return {
    ready: true,
    reasons: [],
    acknowledgements: prediction.findings.filter((finding) => finding.grade === 'red'),
  };
}

/** One-line summary for a format card. */
export function summarisePrediction(prediction: FidelityPrediction): string {
  if (prediction.blocked) return prediction.blockers[0]?.statement ?? 'Not available.';
  if (prediction.findings.length === 0) return 'Nothing is lost in this conversion.';
  const reds = prediction.findings.filter((finding) => finding.grade === 'red').length;
  const yellows = prediction.findings.length - reds;
  if (reds > 0) return `${reds} loss${reds === 1 ? '' : 'es'}${yellows > 0 ? ` and ${yellows} change${yellows === 1 ? '' : 's'}` : ''} — see what will be lost.`;
  return `${yellows} change${yellows === 1 ? '' : 's'} worth knowing about.`;
}
