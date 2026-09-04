/**
 * Well-Known Text geometry (ISO 19125 / OGC SFA).
 *
 * Handles the Z, M and ZM dimension suffixes and the PostGIS `SRID=n;` prefix,
 * which is how WKT usually arrives from a database export. One geometry per
 * line is the common file convention, so the reader accepts both a single
 * geometry and a line-per-geometry file.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirGeometry,
  type GeometryType,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { coordinateFormatter, formatFixed, type PrecisionPolicy } from '../../core/precision';
import { crsFromEpsg } from '../../crs/epsg';
import { deriveFields } from '../shared';

const KEYWORDS: Record<string, GeometryType> = {
  POINT: 'Point',
  MULTIPOINT: 'MultiPoint',
  LINESTRING: 'LineString',
  MULTILINESTRING: 'MultiLineString',
  POLYGON: 'Polygon',
  MULTIPOLYGON: 'MultiPolygon',
  GEOMETRYCOLLECTION: 'GeometryCollection',
};

interface Cursor {
  text: string;
  at: number;
}

function skipSpace(cursor: Cursor): void {
  while (cursor.at < cursor.text.length && /\s/.test(cursor.text[cursor.at])) cursor.at++;
}

function readWord(cursor: Cursor): string {
  skipSpace(cursor);
  const start = cursor.at;
  while (cursor.at < cursor.text.length && /[A-Za-z]/.test(cursor.text[cursor.at])) cursor.at++;
  return cursor.text.slice(start, cursor.at).toUpperCase();
}

function expect(cursor: Cursor, char: string): void {
  skipSpace(cursor);
  if (cursor.text[cursor.at] !== char) {
    throw new ConversionError({
      code: 'WKT_SYNTAX',
      what: `The WKT geometry is malformed near character ${cursor.at}.`,
      why: `Expected "${char}" but found "${cursor.text[cursor.at] ?? 'end of text'}".`,
      action: 'Check the geometry text for an unbalanced bracket or a missing comma.',
    });
  }
  cursor.at++;
}

function readPosition(cursor: Cursor, dimension: 2 | 3 | 4): Position {
  const values: number[] = [];
  // WKT separates ordinates by whitespace; the count is fixed by the dimension
  // suffix, so a trailing ordinate is a syntax error rather than extra data.
  while (values.length < dimension) {
    skipSpace(cursor);
    const start = cursor.at;
    while (cursor.at < cursor.text.length && /[-+0-9.eE]/.test(cursor.text[cursor.at])) cursor.at++;
    const raw = cursor.text.slice(start, cursor.at);
    if (!raw) break;
    values.push(Number(raw));
  }
  if (values.length < 2) {
    throw new ConversionError({
      code: 'WKT_BAD_COORDINATE',
      what: `A coordinate in the WKT geometry could not be read (character ${cursor.at}).`,
      why: 'At least an X and a Y ordinate are required.',
      action: 'Check the geometry text for a missing or non-numeric ordinate.',
    });
  }
  return values;
}

function readPositionList(cursor: Cursor, dimension: 2 | 3 | 4): Position[] {
  expect(cursor, '(');
  const out: Position[] = [];
  for (;;) {
    out.push(readPosition(cursor, dimension));
    skipSpace(cursor);
    if (cursor.text[cursor.at] === ',') {
      cursor.at++;
      continue;
    }
    expect(cursor, ')');
    return out;
  }
}

function readRingList(cursor: Cursor, dimension: 2 | 3 | 4): Position[][] {
  expect(cursor, '(');
  const out: Position[][] = [];
  for (;;) {
    out.push(readPositionList(cursor, dimension));
    skipSpace(cursor);
    if (cursor.text[cursor.at] === ',') {
      cursor.at++;
      continue;
    }
    expect(cursor, ')');
    return out;
  }
}

function parseGeometry(cursor: Cursor): CirGeometry | null {
  const keyword = readWord(cursor);
  if (!keyword) return null;
  const type = KEYWORDS[keyword];
  if (!type) {
    throw new ConversionError({
      code: 'WKT_UNKNOWN_TYPE',
      what: `"${keyword}" is not a recognised WKT geometry keyword.`,
      why: 'Only the seven OGC simple-feature types are supported. Curved types (CIRCULARSTRING, COMPOUNDCURVE) have no equivalent in the vector model.',
      action: 'Densify curved geometry in the source application before exporting.',
    });
  }

  // The dimension suffix is optional; without it, an extra ordinate per position
  // means Z, which is how most producers write 3D WKT.
  const suffix = readWord(cursor);
  let dimension: 2 | 3 | 4 = 2;
  if (suffix === 'ZM') dimension = 4;
  else if (suffix === 'Z') dimension = 3;
  else if (suffix === 'M') dimension = 3;

  skipSpace(cursor);
  if (cursor.text.slice(cursor.at, cursor.at + 5).toUpperCase() === 'EMPTY') {
    cursor.at += 5;
    return { type, coordinates: type === 'Point' ? [] : [], dimension };
  }

  if (!suffix && type !== 'GeometryCollection') {
    // Look ahead at the first coordinate to settle the dimension.
    const probe: Cursor = { text: cursor.text, at: cursor.at };
    expect(probe, '(');
    while (probe.at < probe.text.length && (probe.text[probe.at] === '(' || /\s/.test(probe.text[probe.at]))) probe.at++;
    const start = probe.at;
    while (probe.at < probe.text.length && !/[,)]/.test(probe.text[probe.at])) probe.at++;
    const ordinates = probe.text.slice(start, probe.at).trim().split(/\s+/).filter(Boolean).length;
    if (ordinates === 3) dimension = 3;
    else if (ordinates >= 4) dimension = 4;
  }

  switch (type) {
    case 'Point': {
      expect(cursor, '(');
      const position = readPosition(cursor, dimension);
      expect(cursor, ')');
      return { type, coordinates: position, dimension };
    }
    case 'MultiPoint': {
      // Both MULTIPOINT(1 2, 3 4) and MULTIPOINT((1 2),(3 4)) are legal.
      skipSpace(cursor);
      const save = cursor.at;
      expect(cursor, '(');
      skipSpace(cursor);
      if (cursor.text[cursor.at] === '(') {
        cursor.at = save;
        const rings = readRingList(cursor, dimension);
        return { type, coordinates: rings.map((ring) => ring[0]), dimension };
      }
      cursor.at = save;
      return { type, coordinates: readPositionList(cursor, dimension), dimension };
    }
    case 'LineString':
      return { type, coordinates: readPositionList(cursor, dimension), dimension };
    case 'MultiLineString':
    case 'Polygon':
      return { type, coordinates: readRingList(cursor, dimension), dimension };
    case 'MultiPolygon': {
      expect(cursor, '(');
      const polygons: Position[][][] = [];
      for (;;) {
        polygons.push(readRingList(cursor, dimension));
        skipSpace(cursor);
        if (cursor.text[cursor.at] === ',') {
          cursor.at++;
          continue;
        }
        expect(cursor, ')');
        break;
      }
      return { type, coordinates: polygons, dimension };
    }
    case 'GeometryCollection': {
      expect(cursor, '(');
      const geometries: CirGeometry[] = [];
      for (;;) {
        const child = parseGeometry(cursor);
        if (child) geometries.push(child);
        skipSpace(cursor);
        if (cursor.text[cursor.at] === ',') {
          cursor.at++;
          continue;
        }
        expect(cursor, ')');
        break;
      }
      const maxDimension = geometries.reduce<2 | 3 | 4>((max, child) => (child.dimension > max ? child.dimension : max), 2);
      return { type, geometries, dimension: maxDimension };
    }
    default:
      return null;
  }
}

export function parseWktGeometry(text: string): CirGeometry | null {
  const stripped = text.replace(/^\s*SRID\s*=\s*\d+\s*;/i, '');
  return parseGeometry({ text: stripped, at: 0 });
}

export function readWkt(text: string, source: SourceInfo): CirDataset {
  const warnings: Warning[] = [];
  const features: CirFeature[] = [];
  let srid: number | null = null;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // A multi-line single geometry is legal too; if no line parses on its own, the
  // whole text is retried as one geometry.
  let parsedAny = false;
  lines.forEach((line, index) => {
    const sridMatch = line.match(/^\s*SRID\s*=\s*(\d+)\s*;/i);
    if (sridMatch) srid = Number(sridMatch[1]);
    try {
      const geometry = parseWktGeometry(line);
      if (geometry) {
        features.push({ id: index, geometry, properties: {} });
        parsedAny = true;
      }
    } catch (error) {
      warnings.push(
        warn('WKT_LINE_SKIPPED', `Line ${index + 1} could not be read as WKT.`, {
          reason: error instanceof Error ? error.message : String(error),
          action: 'Check that each line holds one complete geometry.',
        })
      );
    }
  });

  if (!parsedAny) {
    const geometry = parseWktGeometry(text);
    if (geometry) features.push({ id: 0, geometry, properties: {} });
    warnings.length = 0;
  }

  if (features.length === 0) {
    throw new ConversionError({
      code: 'WKT_EMPTY',
      what: 'No WKT geometry could be read from the file.',
      why: 'No line began with a recognised geometry keyword.',
      action: 'Confirm the file holds WKT geometry rather than a WKT coordinate-system definition (.prj).',
    });
  }

  return createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    crs: srid ? crsFromEpsg(srid) : null,
    crsOrigin: srid ? 'declared' : 'unknown',
    axisOrder: 'xy',
    layers: [createLayer(source.fileName, features, deriveFields(features))],
    warnings,
  });
}

export interface WriteWktOptions {
  precision: PrecisionPolicy;
  /** Emit the PostGIS `SRID=n;` prefix when the CRS has an EPSG code. */
  includeSrid?: boolean;
}

export function geometryToWkt(geometry: CirGeometry, precision: PrecisionPolicy, geographic: boolean): string {
  const format = coordinateFormatter(precision, geographic);
  const decimals = precision.mode === 'full' ? 15 : geographic ? precision.geographicDecimals : precision.linearDecimals;
  const elevationDecimals = precision.mode === 'full' ? 15 : precision.elevationDecimals;

  const position = (p: Position): string => {
    const parts = [formatFixed(format.x(p[0]), decimals), formatFixed(format.y(p[1]), decimals)];
    if (geometry.dimension >= 3 && p.length > 2 && Number.isFinite(p[2])) parts.push(formatFixed(format.z(p[2]), elevationDecimals));
    if (geometry.dimension === 4 && p.length > 3 && Number.isFinite(p[3])) parts.push(formatFixed(p[3], elevationDecimals));
    return parts.join(' ');
  };

  const suffix = geometry.dimension === 4 ? ' ZM' : geometry.dimension === 3 ? ' Z' : '';
  const keyword = Object.entries(KEYWORDS).find(([, value]) => value === geometry.type)?.[0] ?? 'GEOMETRYCOLLECTION';

  switch (geometry.type) {
    case 'Point': {
      const coordinates = geometry.coordinates as Position;
      if (!coordinates || coordinates.length === 0) return `${keyword}${suffix} EMPTY`;
      return `${keyword}${suffix}(${position(coordinates)})`;
    }
    case 'MultiPoint':
    case 'LineString': {
      const list = (geometry.coordinates as Position[]) ?? [];
      if (list.length === 0) return `${keyword}${suffix} EMPTY`;
      return `${keyword}${suffix}(${list.map(position).join(', ')})`;
    }
    case 'MultiLineString':
    case 'Polygon': {
      const rings = (geometry.coordinates as Position[][]) ?? [];
      if (rings.length === 0) return `${keyword}${suffix} EMPTY`;
      return `${keyword}${suffix}(${rings.map((ring) => `(${ring.map(position).join(', ')})`).join(', ')})`;
    }
    case 'MultiPolygon': {
      const polygons = (geometry.coordinates as Position[][][]) ?? [];
      if (polygons.length === 0) return `${keyword}${suffix} EMPTY`;
      return `${keyword}${suffix}(${polygons
        .map((rings) => `(${rings.map((ring) => `(${ring.map(position).join(', ')})`).join(', ')})`)
        .join(', ')})`;
    }
    case 'GeometryCollection': {
      const children = geometry.geometries ?? [];
      if (children.length === 0) return `${keyword}${suffix} EMPTY`;
      return `${keyword}${suffix}(${children.map((child) => geometryToWkt(child, precision, geographic)).join(', ')})`;
    }
    default:
      return `${keyword} EMPTY`;
  }
}

export function writeWkt(dataset: CirDataset, options: WriteWktOptions): { text: string; warnings: Warning[] } {
  const geographic = dataset.crs?.kind === 'geographic';
  const prefix = options.includeSrid && dataset.crs?.epsg ? `SRID=${dataset.crs.epsg};` : '';
  const lines: string[] = [];
  let attributeCount = 0;
  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      if (!feature.geometry) continue;
      if (Object.keys(feature.properties ?? {}).length > 0) attributeCount++;
      lines.push(prefix + geometryToWkt(feature.geometry, options.precision, geographic));
    }
  }
  const warnings: Warning[] = [];
  if (attributeCount > 0) {
    warnings.push(
      warn('WKT_ATTRIBUTES_DROPPED', `Attributes on ${attributeCount} feature(s) were not written.`, {
        count: attributeCount,
        reason: 'WKT carries geometry only; it has no attribute container.',
        action: 'Export to GeoJSON, Shapefile or CSV if the attributes must be preserved.',
      })
    );
  }
  return { text: lines.join('\n') + '\n', warnings };
}
