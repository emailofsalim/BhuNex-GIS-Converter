/**
 * MapInfo Interchange Format (.mif geometry + .mid attributes).
 *
 * The two files are positionally joined: the Nth object in the .mif belongs to
 * the Nth row in the .mid. That coupling is why a missing .mid is a named
 * warning rather than a silent attribute loss.
 *
 * MIF is two-dimensional, so Z is dropped on export and the loss is reported.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirGeometry,
  type FieldDef,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { closeRing, orientRing, pointInRing, signedArea } from '../../core/geometry';
import { coordinateFormatter, formatFixed, type PrecisionPolicy } from '../../core/precision';
import { crsFromEpsg } from '../../crs/epsg';
import { deriveFields } from '../shared';
import { parseDelimited } from './csv';

interface MifColumn {
  name: string;
  type: string;
}

function parseCoordinatePair(line: string): Position | null {
  const parts = line.trim().split(/[\s,]+/).map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return [parts[0], parts[1]];
}

export function readMifMid(mifText: string, midText: string | undefined, source: SourceInfo): CirDataset {
  const lines = mifText.split(/\r?\n/);
  const warnings: Warning[] = [];
  const columns: MifColumn[] = [];
  let delimiter = '\t';
  let coordSys = '';
  let dataIndex = -1;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('DELIMITER')) {
      const match = line.match(/"(.)"/);
      if (match) delimiter = match[1];
    } else if (upper.startsWith('COORDSYS')) {
      coordSys = line;
    } else if (upper.startsWith('COLUMNS')) {
      const count = Number(line.split(/\s+/)[1]) || 0;
      for (let offset = 1; offset <= count && index + offset < lines.length; offset++) {
        const parts = lines[index + offset].trim().split(/\s+/);
        if (parts.length >= 2) columns.push({ name: parts[0], type: parts.slice(1).join(' ') });
      }
      index += count;
    } else if (upper === 'DATA') {
      dataIndex = index + 1;
      break;
    }
  }

  if (dataIndex < 0) {
    throw new ConversionError({
      code: 'MIF_NO_DATA_SECTION',
      what: 'The .mif file has no DATA section.',
      why: 'A MIF file declares its columns in a header and its geometry after a DATA line; neither was found.',
      action: 'Confirm the file is a MapInfo Interchange export rather than another text format.',
    });
  }

  const geometries: (CirGeometry | null)[] = [];
  const unsupported = new Map<string, number>();

  for (let index = dataIndex; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const [keywordRaw, ...rest] = line.split(/\s+/);
    const keyword = keywordRaw.toUpperCase();

    switch (keyword) {
      case 'POINT': {
        const position = parseCoordinatePair(rest.join(' '));
        geometries.push(position ? { type: 'Point', coordinates: position, dimension: 2 } : null);
        break;
      }
      case 'LINE': {
        const values = rest.map(Number);
        if (values.length >= 4 && values.every(Number.isFinite)) {
          geometries.push({ type: 'LineString', coordinates: [[values[0], values[1]], [values[2], values[3]]], dimension: 2 });
        } else {
          geometries.push(null);
        }
        break;
      }
      case 'PLINE': {
        // Either "PLINE n" followed by n vertices, or "PLINE MULTIPLE m" with m
        // sections, each introduced by its own vertex count.
        const isMultiple = (rest[0] ?? '').toUpperCase() === 'MULTIPLE';
        const sections: Position[][] = [];
        if (isMultiple) {
          const sectionCount = Number(rest[1]) || 0;
          for (let section = 0; section < sectionCount; section++) {
            const count = Number(lines[++index]?.trim()) || 0;
            const positions: Position[] = [];
            for (let vertex = 0; vertex < count; vertex++) {
              const position = parseCoordinatePair(lines[++index] ?? '');
              if (position) positions.push(position);
            }
            if (positions.length >= 2) sections.push(positions);
          }
        } else {
          const count = Number(rest[0]) || 0;
          const positions: Position[] = [];
          for (let vertex = 0; vertex < count; vertex++) {
            const position = parseCoordinatePair(lines[++index] ?? '');
            if (position) positions.push(position);
          }
          if (positions.length >= 2) sections.push(positions);
        }
        geometries.push(
          sections.length === 0
            ? null
            : sections.length === 1
              ? { type: 'LineString', coordinates: sections[0], dimension: 2 }
              : { type: 'MultiLineString', coordinates: sections, dimension: 2 }
        );
        break;
      }
      case 'REGION': {
        const polygonCount = Number(rest[0]) || 0;
        const rings: Position[][] = [];
        for (let polygon = 0; polygon < polygonCount; polygon++) {
          const count = Number(lines[++index]?.trim()) || 0;
          const ring: Position[] = [];
          for (let vertex = 0; vertex < count; vertex++) {
            const position = parseCoordinatePair(lines[++index] ?? '');
            if (position) ring.push(position);
          }
          if (ring.length >= 3) rings.push(closeRing(ring));
        }
        geometries.push(rings.length > 0 ? assembleRegion(rings) : null);
        break;
      }
      case 'MULTIPOINT': {
        const count = Number(rest[0]) || 0;
        const positions: Position[] = [];
        for (let vertex = 0; vertex < count; vertex++) {
          const position = parseCoordinatePair(lines[++index] ?? '');
          if (position) positions.push(position);
        }
        geometries.push(positions.length > 0 ? { type: 'MultiPoint', coordinates: positions, dimension: 2 } : null);
        break;
      }
      case 'NONE':
        geometries.push(null);
        break;
      case 'ARC':
      case 'TEXT':
      case 'RECT':
      case 'ROUNDRECT':
      case 'ELLIPSE':
      case 'COLLECTION':
        unsupported.set(keyword, (unsupported.get(keyword) ?? 0) + 1);
        geometries.push(null);
        break;
      default:
        // PEN, BRUSH, SYMBOL, SMOOTH and CENTER are styling directives that
        // follow an object; they are not objects themselves.
        break;
    }
  }

  const attributeRows: string[][] = midText ? parseDelimited(midText, (delimiter === '\t' ? '\t' : delimiter) as any) : [];
  if (!midText) {
    warnings.push(
      warn('MIF_NO_MID', 'No .mid file accompanied the .mif, so no attributes were read.', {
        reason: 'MapInfo Interchange splits geometry (.mif) from attributes (.mid); they join by row order.',
        action: 'Add the matching .mid file to recover the attribute table.',
      })
    );
  } else if (attributeRows.length !== geometries.length) {
    warnings.push(
      warn('MIF_MID_COUNT_MISMATCH', `The .mif holds ${geometries.length} object(s) but the .mid holds ${attributeRows.length} row(s).`, {
        reason: 'The two files join by position, so a count mismatch means one of them is truncated.',
        action: 'Re-export the pair from MapInfo; attributes were attached in order as far as they go.',
      })
    );
  }

  const features: CirFeature[] = [];
  geometries.forEach((geometry, index) => {
    if (!geometry) return;
    const properties: Record<string, unknown> = {};
    const row = attributeRows[index];
    if (row) {
      columns.forEach((column, columnIndex) => {
        const raw = (row[columnIndex] ?? '').replace(/^"|"$/g, '');
        if (raw === '') {
          properties[column.name] = null;
          return;
        }
        const isNumeric = /^(integer|smallint|decimal|float)/i.test(column.type);
        properties[column.name] = isNumeric && Number.isFinite(Number(raw)) ? Number(raw) : raw;
      });
    }
    features.push({ id: index, geometry, properties, sourceEntity: 'mif-object' });
  });

  if (unsupported.size > 0) {
    const summary = [...unsupported.entries()].map(([key, value]) => `${key} × ${value}`).join(', ');
    warnings.push(
      warn('MIF_UNSUPPORTED_OBJECTS', `Objects not converted: ${summary}.`, {
        count: [...unsupported.values()].reduce((sum, value) => sum + value, 0),
        reason: 'ARC, TEXT, RECT, ROUNDRECT and ELLIPSE are parametric MapInfo objects with no direct vector-geometry equivalent.',
        action: 'Convert them to regions or polylines in MapInfo before exporting.',
        detail: Object.fromEntries(unsupported),
      })
    );
  }

  const epsgMatch = coordSys.match(/EPSG[:\s]*(\d+)/i);
  const crs = epsgMatch ? crsFromEpsg(Number(epsgMatch[1])) : null;
  if (coordSys && !crs) {
    warnings.push(
      warn('MIF_COORDSYS_UNRESOLVED', 'The CoordSys clause could not be resolved to an EPSG code.', {
        reason: `MapInfo declares its CRS in its own syntax: "${coordSys.slice(0, 120)}".`,
        action: 'Select the source CRS manually before converting coordinates.',
      })
    );
  }

  return createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    crs,
    crsOrigin: crs ? 'declared' : 'unknown',
    axisOrder: 'xy',
    layers: [createLayer(source.fileName, features, deriveFields(features))],
    warnings,
    metadata: { coordSys, columns: columns.map((column) => `${column.name} ${column.type}`) },
  });
}

/** MapInfo REGION rings: the enclosing test decides outer versus hole. */
function assembleRegion(rings: Position[][]): CirGeometry {
  if (rings.length === 1) return { type: 'Polygon', coordinates: rings, dimension: 2 };
  const outers: Position[][] = [];
  const holes: Position[][] = [];
  for (const ring of rings) {
    const enclosed = outers.some((outer) => pointInRing(ring[0], outer));
    (enclosed ? holes : outers).push(ring);
  }
  if (outers.length === 0) return { type: 'Polygon', coordinates: rings, dimension: 2 };
  const polygons: Position[][][] = outers.map((outer) => [outer]);
  for (const hole of holes) {
    let target = 0;
    let smallest = Infinity;
    outers.forEach((outer, index) => {
      if (!pointInRing(hole[0], outer)) return;
      const area = Math.abs(signedArea(outer));
      if (area < smallest) {
        smallest = area;
        target = index;
      }
    });
    polygons[target].push(hole);
  }
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0], dimension: 2 }
    : { type: 'MultiPolygon', coordinates: polygons, dimension: 2 };
}

export interface WriteMifMidOptions {
  precision: PrecisionPolicy;
  layerName: string;
  fields?: string[];
}

/** Maps a CIR field to the MIF column type declaration. */
function mifColumnType(field: FieldDef): string {
  if (field.type === 'integer') return 'Integer';
  if (field.type === 'number') return `Decimal(${Math.max(10, (field.width ?? 10) + 4)},6)`;
  if (field.type === 'date') return 'Date';
  if (field.type === 'boolean') return 'Logical';
  return `Char(${Math.min(254, Math.max(1, field.width ?? 32))})`;
}

export function writeMifMid(
  dataset: CirDataset,
  options: WriteMifMidOptions
): { mif: string; mid: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const geographic = dataset.crs?.kind === 'geographic';
  const format = coordinateFormatter(options.precision, geographic);
  const decimals = options.precision.mode === 'full' ? 15 : geographic ? options.precision.geographicDecimals : options.precision.linearDecimals;

  const features = dataset.layers.flatMap((layer) => layer.features).filter((feature) => feature.geometry);
  const allFields = deriveFields(features);
  const fields = options.fields ? allFields.filter((field) => options.fields!.includes(field.name)) : allFields;

  const coordSys = dataset.crs?.epsg
    ? `CoordSys Earth Projection 1, 104\r\n` // generic lat/long placeholder; the EPSG comment carries the truth
    : '';

  const header: string[] = ['Version 300', 'Charset "WindowsLatin1"', 'Delimiter ","'];
  if (dataset.crs?.epsg) header.push(` `); // replaced below
  const headerLines = header.filter((line) => line !== ' ');
  if (coordSys) headerLines.push(coordSys.trim());
  headerLines.push(`Columns ${fields.length}`);
  for (const field of fields) headerLines.push(`  ${sanitizeColumnName(field.name)} ${mifColumnType(field)}`);
  headerLines.push('Data', '');

  const point = (position: Position) => `${formatFixed(format.x(position[0]), decimals)} ${formatFixed(format.y(position[1]), decimals)}`;
  const body: string[] = [];
  const midRows: string[] = [];
  let droppedZ = 0;

  for (const feature of features) {
    const geometry = feature.geometry!;
    if (geometry.dimension >= 3) droppedZ++;
    switch (geometry.type) {
      case 'Point':
        body.push(`Point ${point(geometry.coordinates as Position)}`, '    Symbol (34,0,12)');
        break;
      case 'MultiPoint': {
        const positions = geometry.coordinates as Position[];
        body.push(`Multipoint ${positions.length}`, ...positions.map((position) => `  ${point(position)}`));
        break;
      }
      case 'LineString': {
        const positions = geometry.coordinates as Position[];
        body.push(`Pline ${positions.length}`, ...positions.map((position) => `  ${point(position)}`), '    Pen (1,2,0)');
        break;
      }
      case 'MultiLineString': {
        const lines = geometry.coordinates as Position[][];
        body.push(`Pline Multiple ${lines.length}`);
        for (const line of lines) body.push(`  ${line.length}`, ...line.map((position) => `  ${point(position)}`));
        body.push('    Pen (1,2,0)');
        break;
      }
      case 'Polygon':
      case 'MultiPolygon': {
        const rings =
          geometry.type === 'Polygon' ? (geometry.coordinates as Position[][]) : (geometry.coordinates as Position[][][]).flat();
        body.push(`Region ${rings.length}`);
        rings.forEach((ring, index) => {
          // MapInfo expects clockwise outer rings and counter-clockwise holes.
          const oriented = orientRing(closeRing(ring), index === 0);
          body.push(`  ${oriented.length}`, ...oriented.map((position) => `  ${point(position)}`));
        });
        body.push('    Pen (1,2,0)', '    Brush (2,16777215,16777215)');
        break;
      }
      default:
        body.push('None');
        break;
    }
    midRows.push(
      fields
        .map((field) => {
          const value = feature.properties?.[field.name];
          if (value === null || value === undefined) return '';
          const text = String(value);
          return field.type === 'string' || text.includes(',') ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(',')
    );
  }

  if (droppedZ > 0) {
    warnings.push(
      warn('MIF_Z_DROPPED', `Z values on ${droppedZ} feature(s) were not written.`, {
        count: droppedZ,
        reason: 'MapInfo Interchange stores two-dimensional coordinates only.',
        action: 'Export to DXF, GeoJSON or Shapefile (PolygonZ/PolyLineZ) to keep elevations.',
      })
    );
  }
  if (dataset.crs && !coordSys) {
    warnings.push(
      warn('MIF_NO_COORDSYS', 'No CoordSys clause was written.', {
        reason: 'MapInfo declares projections in its own syntax, which is not generated for arbitrary EPSG codes.',
        action: `Set the projection to ${dataset.crs.name} manually when opening the table in MapInfo.`,
      })
    );
  }

  return { mif: [...headerLines, ...body].join('\r\n') + '\r\n', mid: midRows.join('\r\n') + '\r\n', warnings };
}

function sanitizeColumnName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return (cleaned || 'field').slice(0, 31);
}
