/**
 * Surpac string files (.str) — the workhorse mine-survey exchange format.
 *
 * Layout:
 *   line 1  purpose/name, date
 *   line 2  axis/scale header (0, 1.000, 1.000, 1.000)
 *   then    stringNumber, y, x, z, d1, d2, ... per point
 *           a record with stringNumber 0 closes the current string
 *   end     "0, 0.000, 0.000, 0.000, END"
 *
 * Note the axis order: Surpac writes **northing before easting**. Reading it as
 * x/y transposes every coordinate, which is why the swap is explicit here and
 * recorded in the dataset warnings.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { formatFixed, type PrecisionPolicy } from '../../core/precision';
import { deriveFields } from '../shared';

interface StringRecord {
  stringNumber: number;
  position: Position;
  description: string[];
}

function parseRecord(line: string): StringRecord | null {
  const cells = line.split(',').map((cell) => cell.trim());
  if (cells.length < 4) return null;
  const stringNumber = Number(cells[0]);
  const northing = Number(cells[1]);
  const easting = Number(cells[2]);
  const elevation = Number(cells[3]);
  if (!Number.isInteger(stringNumber) || !Number.isFinite(northing) || !Number.isFinite(easting) || !Number.isFinite(elevation)) {
    return null;
  }
  return {
    stringNumber,
    // Swap to x/y here, once, at the boundary.
    position: [easting, northing, elevation],
    description: cells.slice(4).filter((cell) => cell !== ''),
  };
}

export function readSurpacStr(text: string, source: SourceInfo): CirDataset {
  const lines = text.split(/\r?\n/);
  if (lines.length < 3) {
    throw new ConversionError({
      code: 'STR_TOO_SHORT',
      what: 'The Surpac string file has fewer than three lines.',
      why: 'A .str file needs a header line, an axis line and at least one point record.',
      action: 'Check that the file exported completely from Surpac.',
    });
  }

  const warnings: Warning[] = [];
  const title = (lines[0] ?? '').split(',')[0]?.trim() || source.fileName;

  const strings = new Map<number, StringRecord[][]>();
  let current: StringRecord[] = [];
  let currentNumber: number | null = null;
  let skipped = 0;

  const flush = (): void => {
    if (currentNumber === null || current.length === 0) return;
    const list = strings.get(currentNumber) ?? [];
    list.push(current);
    strings.set(currentNumber, list);
    current = [];
  };

  // Line 0 is the title and line 1 the axis header; records start at line 2.
  for (let index = 2; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^0\s*,/.test(line)) {
      // A zero string number terminates the current string (and, at the end of
      // the file, carries the END marker).
      flush();
      currentNumber = null;
      continue;
    }
    const record = parseRecord(line);
    if (!record) {
      skipped++;
      continue;
    }
    if (currentNumber !== null && record.stringNumber !== currentNumber) flush();
    currentNumber = record.stringNumber;
    current.push(record);
  }
  flush();

  if (strings.size === 0) {
    throw new ConversionError({
      code: 'STR_NO_RECORDS',
      what: 'No Surpac string records could be read.',
      why: skipped > 0 ? `${skipped} line(s) did not match the "string, y, x, z" record shape.` : 'The file contains only header lines.',
      action: 'Confirm the file is a Surpac .str export rather than another comma-delimited format.',
    });
  }

  const features: CirFeature[] = [];
  for (const [stringNumber, segments] of [...strings.entries()].sort((a, b) => a[0] - b[0])) {
    segments.forEach((segment, segmentIndex) => {
      const positions = segment.map((record) => record.position);
      const descriptions = segment.map((record) => record.description.join(' ')).filter(Boolean);
      const properties: Record<string, unknown> = {
        string_number: stringNumber,
        point_count: positions.length,
      };
      if (descriptions.length > 0) properties.description = descriptions[0];

      if (positions.length === 1) {
        features.push({
          id: `${stringNumber}-${segmentIndex}`,
          geometry: { type: 'Point', coordinates: positions[0], dimension: 3 },
          properties,
          sourceLayer: `String ${stringNumber}`,
          sourceEntity: 'surpac-point',
        });
        return;
      }

      const first = positions[0];
      const last = positions[positions.length - 1];
      const closed = positions.length >= 4 && Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9;
      features.push({
        id: `${stringNumber}-${segmentIndex}`,
        geometry: closed
          ? { type: 'Polygon', coordinates: [positions], dimension: 3 }
          : { type: 'LineString', coordinates: positions, dimension: 3 },
        properties,
        sourceLayer: `String ${stringNumber}`,
        sourceEntity: closed ? 'surpac-closed-string' : 'surpac-string',
      });
    });
  }

  warnings.push(
    warn('STR_AXIS_SWAPPED', 'Surpac stores northing before easting; coordinates were swapped to x/y on import.', {
      severity: 'info',
      reason: 'The .str record layout is "string, Y (north), X (east), Z". Reading it verbatim would transpose every point.',
      action: 'Check a known point in the inspector to confirm the coordinates landed where you expect.',
    })
  );
  if (skipped > 0) {
    warnings.push(
      warn('STR_LINES_SKIPPED', `${skipped} line(s) did not match the string record layout and were skipped.`, {
        count: skipped,
        reason: 'Only "string, y, x, z[, description...]" records are read.',
        action: 'Open the file to check for stray header or comment lines.',
      })
    );
  }

  const layers = new Map<string, CirFeature[]>();
  for (const feature of features) {
    const key = feature.sourceLayer ?? 'Strings';
    const list = layers.get(key) ?? [];
    list.push(feature);
    layers.set(key, list);
  }

  return createDataset({
    kind: 'vector',
    name: title,
    source,
    // Surpac strings carry a site grid with no CRS declaration.
    crs: null,
    crsOrigin: 'unknown',
    axisOrder: 'xy',
    vertical: { kind: 'local', name: 'Mine RL' },
    layers: [...layers.entries()].map(([name, list]) => createLayer(name, list, deriveFields(list))),
    warnings,
    metadata: { title, stringCount: strings.size },
  });
}

export interface WriteSurpacOptions {
  precision: PrecisionPolicy;
  /** Attribute whose value becomes the string number, when present. */
  stringNumberField?: string;
  /** Attribute written into the description field. */
  descriptionField?: string;
  title?: string;
}

export function writeSurpacStr(dataset: CirDataset, options: WriteSurpacOptions): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const decimals = options.precision.mode === 'full' ? 6 : options.precision.linearDecimals;
  const lines: string[] = [];
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '-');

  lines.push(`${(options.title ?? dataset.name).slice(0, 40)}, ${stamp}, ,`);
  lines.push('0, 1.000, 1.000, 1.000,');

  let stringNumber = 1;
  let pointsWritten = 0;

  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      if (!feature.geometry) continue;
      const explicit = options.stringNumberField ? Number(feature.properties?.[options.stringNumberField]) : NaN;
      const number = Number.isInteger(explicit) && explicit > 0 ? explicit : stringNumber++;
      const description = options.descriptionField
        ? String(feature.properties?.[options.descriptionField] ?? '')
        : String(feature.properties?.description ?? '');

      for (const part of partsOf(feature.geometry)) {
        for (const position of part) {
          const northing = formatFixed(position[1], decimals);
          const easting = formatFixed(position[0], decimals);
          const elevation = formatFixed(position.length > 2 && Number.isFinite(position[2]) ? position[2] : 0, decimals);
          // Northing first: the format's own axis order, restored on the way out.
          lines.push(`${number}, ${northing}, ${easting}, ${elevation},${description ? ` ${description}` : ''}`);
          pointsWritten++;
        }
        lines.push('0, 0.000, 0.000, 0.000,');
      }
    }
  }

  lines.push('0, 0.000, 0.000, 0.000, END');

  if (pointsWritten === 0) {
    warnings.push(
      warn('STR_NO_POINTS', 'No coordinates were written to the string file.', {
        severity: 'error',
        reason: 'The dataset holds no features with geometry.',
        action: 'Check the source in the inspector.',
      })
    );
  }
  warnings.push(
    warn('STR_AXIS_ORDER', 'Coordinates were written in Surpac order: string number, northing, easting, elevation.', {
      severity: 'info',
      reason: 'Surpac expects Y before X. The internal x/y order is reversed on write.',
    })
  );

  return { text: lines.join('\r\n') + '\r\n', warnings };
}

function partsOf(geometry: { type: string; coordinates?: any; geometries?: any[] }): Position[][] {
  switch (geometry.type) {
    case 'Point':
      return [[geometry.coordinates as Position]];
    case 'MultiPoint':
      return [(geometry.coordinates as Position[])];
    case 'LineString':
      return [geometry.coordinates as Position[]];
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates as Position[][];
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).flat();
    case 'GeometryCollection':
      return (geometry.geometries ?? []).flatMap((child: any) => partsOf(child));
    default:
      return [];
  }
}
