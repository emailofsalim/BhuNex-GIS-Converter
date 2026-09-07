/**
 * Text point clouds: XYZ, PTS and PLY.
 *
 * These three share a reader shape — a header (or none) followed by one point
 * per line — so they live together rather than in three near-identical files.
 * PLY binary little-endian is supported on read because terrestrial scanners
 * emit it by default.
 */

import {
  createDataset,
  emptyPointAttributes,
  warn,
  type Bounds3,
  type CirDataset,
  type CirPointArrays,
  type CirPointCloud,
  type PointAttributeFlags,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { formatFixed, type PrecisionPolicy } from '../../core/precision';
import { decodeText } from '../shared';

interface Accumulator {
  x: number[];
  y: number[];
  z: number[];
  intensity: number[];
  red: number[];
  green: number[];
  blue: number[];
  classification: number[];
}

function newAccumulator(): Accumulator {
  return { x: [], y: [], z: [], intensity: [], red: [], green: [], blue: [], classification: [] };
}

function boundsOf(accumulator: Accumulator): Bounds3 {
  const bounds: Bounds3 = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let index = 0; index < accumulator.x.length; index++) {
    const x = accumulator.x[index];
    const y = accumulator.y[index];
    const z = accumulator.z[index];
    if (x < bounds.minX) bounds.minX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (z < bounds.minZ) bounds.minZ = z;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y > bounds.maxY) bounds.maxY = y;
    if (z > bounds.maxZ) bounds.maxZ = z;
  }
  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = bounds.minY = bounds.minZ = 0;
    bounds.maxX = bounds.maxY = bounds.maxZ = 0;
  }
  return bounds;
}

function toCloud(accumulator: Accumulator, attributes: PointAttributeFlags, declaredCount?: number): CirPointCloud {
  const count = accumulator.x.length;
  const points: CirPointArrays = {
    x: Float64Array.from(accumulator.x),
    y: Float64Array.from(accumulator.y),
    z: Float64Array.from(accumulator.z),
  };
  if (attributes.intensity) points.intensity = Uint16Array.from(accumulator.intensity);
  if (attributes.classification) points.classification = Uint8Array.from(accumulator.classification);
  if (attributes.color) {
    const rgb = new Uint16Array(count * 3);
    for (let index = 0; index < count; index++) {
      rgb[index * 3] = accumulator.red[index] ?? 0;
      rgb[index * 3 + 1] = accumulator.green[index] ?? 0;
      rgb[index * 3 + 2] = accumulator.blue[index] ?? 0;
    }
    points.rgb = rgb;
  }
  return {
    count: declaredCount ?? count,
    loaded: count,
    bounds: boundsOf(accumulator),
    scale: null,
    offset: null,
    pointFormat: null,
    versionMajor: null,
    versionMinor: null,
    attributes,
    points,
    decimation: null,
  };
}

export interface ReadTextCloudOptions {
  /** Explicit column roles; inferred from the column count when absent. */
  columns?: ('x' | 'y' | 'z' | 'intensity' | 'r' | 'g' | 'b' | 'classification' | 'ignore')[];
  maxPoints?: number;
}

/**
 * XYZ / TXT / CSV point clouds.
 *
 * Column layout is inferred from the count, using the conventions scanners
 * actually emit: 3 = XYZ, 4 = XYZI, 6 = XYZRGB, 7 = XYZIRGB. The inference is
 * reported so the user can override it rather than discover it later.
 */
export function readXyzCloud(bytes: Uint8Array, source: SourceInfo, options: ReadTextCloudOptions = {}): CirDataset {
  const text = decodeText(bytes);
  const lines = text.split(/\r?\n/);
  const accumulator = newAccumulator();
  const warnings: Warning[] = [];
  let columns = options.columns;
  let skipped = 0;
  let inferredFrom = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const cells = trimmed.split(/[\s,;]+/);
    const values = cells.map(Number);
    if (values.length < 3 || !Number.isFinite(values[0]) || !Number.isFinite(values[1]) || !Number.isFinite(values[2])) {
      skipped++;
      continue;
    }
    if (!columns) {
      columns = inferColumns(values.length);
      inferredFrom = values.length;
    }
    if (options.maxPoints && accumulator.x.length >= options.maxPoints) break;

    columns.forEach((role, index) => {
      const value = values[index];
      if (!Number.isFinite(value)) return;
      switch (role) {
        case 'x':
          accumulator.x.push(value);
          break;
        case 'y':
          accumulator.y.push(value);
          break;
        case 'z':
          accumulator.z.push(value);
          break;
        case 'intensity':
          accumulator.intensity.push(value);
          break;
        case 'r':
          accumulator.red.push(scaleColor(value));
          break;
        case 'g':
          accumulator.green.push(scaleColor(value));
          break;
        case 'b':
          accumulator.blue.push(scaleColor(value));
          break;
        case 'classification':
          accumulator.classification.push(value);
          break;
        default:
          break;
      }
    });
  }

  if (accumulator.x.length === 0) {
    throw new ConversionError({
      code: 'XYZ_NO_POINTS',
      what: 'No coordinate triples could be read.',
      why: skipped > 0 ? `${skipped} line(s) did not hold three or more numeric values.` : 'The file is empty.',
      action: 'Check the file in a text editor. If it is a coordinate table with headers, import it with the CSV reader and map the columns.',
    });
  }

  const used = columns ?? inferColumns(3);
  const attributes: PointAttributeFlags = {
    ...emptyPointAttributes(),
    intensity: used.includes('intensity'),
    color: used.includes('r'),
    classification: used.includes('classification'),
  };

  if (inferredFrom > 0 && !options.columns) {
    warnings.push(
      warn('XYZ_COLUMNS_INFERRED', `Column layout inferred from ${inferredFrom} columns: ${used.join(', ')}.`, {
        severity: 'info',
        reason: 'XYZ files carry no header, so the layout is inferred from the column count.',
        action: 'Override the column roles in the conversion settings if this is wrong.',
      })
    );
  }
  if (skipped > 0) {
    warnings.push(
      warn('XYZ_LINES_SKIPPED', `${skipped} line(s) were skipped.`, {
        count: skipped,
        reason: 'They held fewer than three numeric values.',
        action: 'Check for header or comment lines that use an unrecognised marker.',
      })
    );
  }

  return createDataset({
    kind: 'pointcloud',
    name: source.fileName,
    source,
    crs: null,
    crsOrigin: 'unknown',
    axisOrder: 'xy',
    layers: [],
    pointcloud: toCloud(accumulator, attributes),
    warnings,
  });
}

function inferColumns(count: number): ('x' | 'y' | 'z' | 'intensity' | 'r' | 'g' | 'b' | 'classification' | 'ignore')[] {
  switch (count) {
    case 3:
      return ['x', 'y', 'z'];
    case 4:
      return ['x', 'y', 'z', 'intensity'];
    case 5:
      return ['x', 'y', 'z', 'intensity', 'classification'];
    case 6:
      return ['x', 'y', 'z', 'r', 'g', 'b'];
    case 7:
      return ['x', 'y', 'z', 'intensity', 'r', 'g', 'b'];
    default: {
      const roles: ('x' | 'y' | 'z' | 'ignore')[] = ['x', 'y', 'z'];
      while (roles.length < count) roles.push('ignore');
      return roles;
    }
  }
}

/** 8-bit colour channels are widened to the 16-bit range LAS and PLY use. */
function scaleColor(value: number): number {
  return value <= 255 ? Math.round(value * 257) : Math.round(value);
}

/** PTS: first line is the point count, then "X Y Z [intensity] [R G B]". */
export function readPts(bytes: Uint8Array, source: SourceInfo): CirDataset {
  const text = decodeText(bytes);
  const lines = text.split(/\r?\n/);
  const declared = Number(lines[0]?.trim());
  const hasCountHeader = Number.isInteger(declared) && declared >= 0;
  const accumulator = newAccumulator();
  const warnings: Warning[] = [];
  let hasIntensity = false;
  let hasColor = false;

  for (let index = hasCountHeader ? 1 : 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    const values = trimmed.split(/\s+/).map(Number);
    if (values.length < 3 || !values.slice(0, 3).every(Number.isFinite)) continue;
    accumulator.x.push(values[0]);
    accumulator.y.push(values[1]);
    accumulator.z.push(values[2]);
    if (values.length >= 4 && Number.isFinite(values[3])) {
      hasIntensity = true;
      // PTS intensity is conventionally -2048..2047; shift it into unsigned.
      accumulator.intensity.push(Math.max(0, Math.min(65535, values[3] < 0 ? values[3] + 2048 : values[3])));
    }
    if (values.length >= 7) {
      hasColor = true;
      accumulator.red.push(scaleColor(values[4]));
      accumulator.green.push(scaleColor(values[5]));
      accumulator.blue.push(scaleColor(values[6]));
    }
  }

  if (accumulator.x.length === 0) {
    throw new ConversionError({
      code: 'PTS_NO_POINTS',
      what: 'No points could be read from the PTS file.',
      why: hasCountHeader ? `The header declares ${declared} points but no valid records followed.` : 'No line held three numeric values.',
      action: 'Re-export the scan from your scanner software.',
    });
  }
  if (hasCountHeader && declared !== accumulator.x.length) {
    warnings.push(
      warn('PTS_COUNT_MISMATCH', `The header declares ${declared.toLocaleString()} points; ${accumulator.x.length.toLocaleString()} were read.`, {
        reason: declared > accumulator.x.length ? 'The file is truncated.' : 'The file holds more records than the header declares.',
        action: 'Re-export the scan if points appear to be missing.',
      })
    );
  }

  return createDataset({
    kind: 'pointcloud',
    name: source.fileName,
    source,
    crs: null,
    crsOrigin: 'unknown',
    axisOrder: 'xy',
    layers: [],
    pointcloud: toCloud(accumulator, { ...emptyPointAttributes(), intensity: hasIntensity, color: hasColor }, hasCountHeader ? declared : undefined),
    warnings,
  });
}

interface PlyProperty {
  name: string;
  type: string;
  /** Set for list properties, e.g. face vertex_indices. */
  countType?: string;
  valueType?: string;
}

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

const PLY_TYPE_SIZES: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

export function readPly(bytes: Uint8Array, source: SourceInfo): CirDataset {
  // The header is always ASCII, even in a binary PLY, so decoding the first
  // kilobytes is safe regardless of the body format.
  const headerText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const endMatch = headerText.match(/end_header\s*?\r?\n/);
  if (!headerText.startsWith('ply') || !endMatch) {
    throw new ConversionError({
      code: 'PLY_BAD_HEADER',
      what: 'The file does not have a valid PLY header.',
      why: 'A PLY starts with "ply" and ends its header with "end_header".',
      action: 'Confirm the detected format in the inspector.',
    });
  }

  const headerEnd = (endMatch.index ?? 0) + endMatch[0].length;
  const headerLines = headerText.slice(0, endMatch.index).split(/\r?\n/);
  let format = 'ascii';
  const elements: PlyElement[] = [];

  for (const line of headerLines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') format = parts[1];
    else if (parts[0] === 'element') elements.push({ name: parts[1], count: Number(parts[2]) || 0, properties: [] });
    else if (parts[0] === 'property' && elements.length > 0) {
      const element = elements[elements.length - 1];
      if (parts[1] === 'list') element.properties.push({ name: parts[4], type: 'list', countType: parts[2], valueType: parts[3] });
      else element.properties.push({ name: parts[2], type: parts[1] });
    }
  }

  const vertexElement = elements.find((element) => element.name === 'vertex');
  if (!vertexElement) {
    throw new ConversionError({
      code: 'PLY_NO_VERTEX_ELEMENT',
      what: 'The PLY header declares no "vertex" element.',
      why: `Elements found: ${elements.map((element) => element.name).join(', ') || 'none'}.`,
      action: 'Re-export the file with vertex data.',
    });
  }

  const accumulator = newAccumulator();
  const warnings: Warning[] = [];
  const names = vertexElement.properties.map((property) => property.name);
  const hasColor = names.includes('red') || names.includes('r');
  const hasIntensity = names.includes('intensity') || names.includes('scalar_intensity');

  if (format === 'ascii') {
    const body = new TextDecoder().decode(bytes.subarray(headerEnd));
    const lines = body.split(/\r?\n/);
    for (let index = 0; index < vertexElement.count && index < lines.length; index++) {
      const values = lines[index].trim().split(/\s+/).map(Number);
      if (values.length < vertexElement.properties.length) continue;
      pushVertex(accumulator, vertexElement.properties, values, hasColor, hasIntensity);
    }
  } else if (format === 'binary_little_endian' || format === 'binary_big_endian') {
    const littleEndian = format === 'binary_little_endian';
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = headerEnd;
    const stride = vertexElement.properties.reduce((sum, property) => sum + (PLY_TYPE_SIZES[property.type] ?? 0), 0);
    if (stride === 0) {
      throw new ConversionError({
        code: 'PLY_LIST_VERTEX_PROPERTY',
        what: 'The vertex element uses a list property, which the binary reader cannot stride over.',
        why: 'List properties have a variable length, so vertex records are not fixed-size.',
        action: 'Re-export the file with scalar vertex properties, or convert it to ASCII PLY.',
      });
    }
    if (headerEnd + stride * vertexElement.count > bytes.length) {
      warnings.push(
        warn('PLY_TRUNCATED', `The header declares ${vertexElement.count.toLocaleString()} vertices but the file is too short to hold them.`, {
          severity: 'error',
          reason: 'The file is truncated.',
          action: 'Re-copy the file; the vertices present were read.',
        })
      );
    }
    const readable = Math.min(vertexElement.count, Math.floor((bytes.length - headerEnd) / stride));
    for (let index = 0; index < readable; index++) {
      const values: number[] = [];
      let cursor = at;
      for (const property of vertexElement.properties) {
        values.push(readBinaryValue(view, cursor, property.type, littleEndian));
        cursor += PLY_TYPE_SIZES[property.type] ?? 0;
      }
      pushVertex(accumulator, vertexElement.properties, values, hasColor, hasIntensity);
      at += stride;
    }
  } else {
    throw new ConversionError({
      code: 'PLY_UNKNOWN_FORMAT',
      what: `PLY format "${format}" is not supported.`,
      why: 'Only ascii, binary_little_endian and binary_big_endian are defined.',
      action: 'Re-export the file as ASCII or binary little-endian PLY.',
    });
  }

  const faceElement = elements.find((element) => element.name === 'face');
  if (faceElement && faceElement.count > 0) {
    warnings.push(
      warn('PLY_FACES_SKIPPED', `${faceElement.count.toLocaleString()} face(s) were not read; only vertices were imported.`, {
        count: faceElement.count,
        reason: 'The point-cloud model has no mesh primitive.',
        action: 'Convert the mesh to a surface in CloudCompare or MeshLab if the triangulation is needed.',
      })
    );
  }

  return createDataset({
    kind: 'pointcloud',
    name: source.fileName,
    source,
    crs: null,
    crsOrigin: 'unknown',
    axisOrder: 'xy',
    layers: [],
    pointcloud: toCloud(accumulator, { ...emptyPointAttributes(), color: hasColor, intensity: hasIntensity }, vertexElement.count),
    warnings,
    metadata: { plyFormat: format, elements: elements.map((element) => `${element.name} × ${element.count}`) },
  });
}

function pushVertex(
  accumulator: Accumulator,
  properties: PlyProperty[],
  values: number[],
  hasColor: boolean,
  hasIntensity: boolean
): void {
  const get = (...names: string[]): number | undefined => {
    for (const name of names) {
      const index = properties.findIndex((property) => property.name === name);
      if (index >= 0 && Number.isFinite(values[index])) return values[index];
    }
    return undefined;
  };
  const x = get('x');
  const y = get('y');
  const z = get('z');
  if (x === undefined || y === undefined || z === undefined) return;
  accumulator.x.push(x);
  accumulator.y.push(y);
  accumulator.z.push(z);
  if (hasColor) {
    accumulator.red.push(scaleColor(get('red', 'r', 'diffuse_red') ?? 0));
    accumulator.green.push(scaleColor(get('green', 'g', 'diffuse_green') ?? 0));
    accumulator.blue.push(scaleColor(get('blue', 'b', 'diffuse_blue') ?? 0));
  }
  if (hasIntensity) accumulator.intensity.push(Math.max(0, Math.min(65535, get('intensity', 'scalar_intensity') ?? 0)));
}

function readBinaryValue(view: DataView, at: number, type: string, littleEndian: boolean): number {
  switch (type) {
    case 'char':
    case 'int8':
      return view.getInt8(at);
    case 'uchar':
    case 'uint8':
      return view.getUint8(at);
    case 'short':
    case 'int16':
      return view.getInt16(at, littleEndian);
    case 'ushort':
    case 'uint16':
      return view.getUint16(at, littleEndian);
    case 'int':
    case 'int32':
      return view.getInt32(at, littleEndian);
    case 'uint':
    case 'uint32':
      return view.getUint32(at, littleEndian);
    case 'float':
    case 'float32':
      return view.getFloat32(at, littleEndian);
    case 'double':
    case 'float64':
      return view.getFloat64(at, littleEndian);
    default:
      return NaN;
  }
}

// ------------------------------------------------------------------ writing

export interface WriteTextCloudOptions {
  precision: PrecisionPolicy;
  delimiter: ' ' | ',' | '\t';
  includeIntensity: boolean;
  includeColor: boolean;
  includeClassification: boolean;
  includeHeader: boolean;
}

export const DEFAULT_TEXT_CLOUD_OPTIONS: Omit<WriteTextCloudOptions, 'precision'> = {
  delimiter: ' ',
  includeIntensity: true,
  includeColor: true,
  includeClassification: false,
  includeHeader: false,
};

export function writeXyzCloud(dataset: CirDataset, options: WriteTextCloudOptions): { text: string; warnings: Warning[] } {
  const cloud = requireCloud(dataset);
  const warnings: Warning[] = [];
  const decimals = options.precision.mode === 'full' ? 15 : options.precision.linearDecimals;
  const wantsIntensity = options.includeIntensity && cloud.attributes.intensity;
  const wantsColor = options.includeColor && cloud.attributes.color;
  const wantsClass = options.includeClassification && cloud.attributes.classification;

  const lines: string[] = [];
  if (options.includeHeader) {
    const header = ['X', 'Y', 'Z'];
    if (wantsIntensity) header.push('Intensity');
    if (wantsColor) header.push('R', 'G', 'B');
    if (wantsClass) header.push('Classification');
    lines.push(`# ${header.join(options.delimiter)}`);
  }

  for (let index = 0; index < cloud.loaded; index++) {
    const cells = [
      formatFixed(cloud.points.x[index], decimals),
      formatFixed(cloud.points.y[index], decimals),
      formatFixed(cloud.points.z[index], decimals),
    ];
    if (wantsIntensity) cells.push(String(cloud.points.intensity?.[index] ?? 0));
    if (wantsColor) {
      // Written back as 8-bit, which is what every consumer of a text cloud
      // expects; the 16-bit source range is divided by 257.
      cells.push(
        String(Math.round((cloud.points.rgb?.[index * 3] ?? 0) / 257)),
        String(Math.round((cloud.points.rgb?.[index * 3 + 1] ?? 0) / 257)),
        String(Math.round((cloud.points.rgb?.[index * 3 + 2] ?? 0) / 257))
      );
    }
    if (wantsClass) cells.push(String(cloud.points.classification?.[index] ?? 0));
    lines.push(cells.join(options.delimiter));
  }

  if (cloud.attributes.gpsTime) {
    warnings.push(
      warn('XYZ_GPS_TIME_DROPPED', 'GPS time was not written.', {
        reason: 'A text point cloud has no standard column for GPS time.',
        action: 'Export to LAS (point format 1, 3, 6 or 7) to keep GPS time.',
      })
    );
  }

  return { text: lines.join('\n') + '\n', warnings };
}

export function writePts(dataset: CirDataset, options: WriteTextCloudOptions): { text: string; warnings: Warning[] } {
  const cloud = requireCloud(dataset);
  const decimals = options.precision.mode === 'full' ? 15 : options.precision.linearDecimals;
  const wantsColor = options.includeColor && cloud.attributes.color;
  const lines: string[] = [String(cloud.loaded)];
  for (let index = 0; index < cloud.loaded; index++) {
    const cells = [
      formatFixed(cloud.points.x[index], decimals),
      formatFixed(cloud.points.y[index], decimals),
      formatFixed(cloud.points.z[index], decimals),
      // PTS always carries an intensity column, so a source without one gets 0.
      String(cloud.points.intensity?.[index] ?? 0),
    ];
    if (wantsColor) {
      cells.push(
        String(Math.round((cloud.points.rgb?.[index * 3] ?? 0) / 257)),
        String(Math.round((cloud.points.rgb?.[index * 3 + 1] ?? 0) / 257)),
        String(Math.round((cloud.points.rgb?.[index * 3 + 2] ?? 0) / 257))
      );
    }
    lines.push(cells.join(' '));
  }
  return { text: lines.join('\n') + '\n', warnings: [] };
}

export function writePly(dataset: CirDataset, options: WriteTextCloudOptions): { text: string; warnings: Warning[] } {
  const cloud = requireCloud(dataset);
  const warnings: Warning[] = [
    warn('PLY_ASCII_VERTICES_ONLY', 'ASCII PLY vertices were written; no faces were generated.', {
      severity: 'info',
      reason: 'The writer emits a point cloud, not a mesh.',
      action: 'Triangulate the cloud in CloudCompare or MeshLab if a surface is needed.',
    }),
  ];
  const decimals = options.precision.mode === 'full' ? 15 : options.precision.linearDecimals;
  const wantsColor = options.includeColor && cloud.attributes.color;
  const wantsIntensity = options.includeIntensity && cloud.attributes.intensity;

  const header = [
    'ply',
    'format ascii 1.0',
    'comment Universal BhuNex Converter',
    `element vertex ${cloud.loaded}`,
    'property float x',
    'property float y',
    'property float z',
  ];
  if (wantsColor) header.push('property uchar red', 'property uchar green', 'property uchar blue');
  if (wantsIntensity) header.push('property float intensity');
  header.push('end_header');

  const lines: string[] = [...header];
  for (let index = 0; index < cloud.loaded; index++) {
    const cells = [
      formatFixed(cloud.points.x[index], decimals),
      formatFixed(cloud.points.y[index], decimals),
      formatFixed(cloud.points.z[index], decimals),
    ];
    if (wantsColor) {
      cells.push(
        String(Math.round((cloud.points.rgb?.[index * 3] ?? 0) / 257)),
        String(Math.round((cloud.points.rgb?.[index * 3 + 1] ?? 0) / 257)),
        String(Math.round((cloud.points.rgb?.[index * 3 + 2] ?? 0) / 257))
      );
    }
    if (wantsIntensity) cells.push(String(cloud.points.intensity?.[index] ?? 0));
    lines.push(cells.join(' '));
  }

  return { text: lines.join('\n') + '\n', warnings };
}

function requireCloud(dataset: CirDataset): CirPointCloud {
  if (!dataset.pointcloud) {
    throw new ConversionError({
      code: 'CLOUD_MISSING',
      what: 'The dataset holds no point cloud to write.',
      why: 'This target needs point data; the dataset is vector, raster or table only.',
      action: 'Pick a vector or table target instead.',
    });
  }
  return dataset.pointcloud;
}
