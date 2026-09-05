/**
 * Delimited coordinate tables (CSV, TSV, TXT, XYZ text).
 *
 * The parser is RFC 4180 aware — quoted fields, embedded delimiters, doubled
 * quotes and embedded newlines — because survey descriptions routinely contain
 * commas ("BM, top of kerb") and a naive split silently shifts every column
 * after them.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirTable,
  type ColumnMapping,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { coordinateFormatter, formatFixed, type PrecisionPolicy } from '../../core/precision';
import { coordinateFromRow, detectSchema, looksLikeHeader } from '../survey/schema';
import { deriveFields } from '../shared';

export type Delimiter = ',' | '\t' | ';' | '|' | ' ';

/**
 * Picks the delimiter by column-count consistency rather than by raw frequency:
 * a file full of decimal commas has more commas than tabs but is tab-delimited.
 */
export function sniffDelimiter(text: string): Delimiter {
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 20);
  if (lines.length === 0) return ',';
  let best: { delimiter: Delimiter; score: number } = { delimiter: ',', score: -1 };
  for (const delimiter of [',', '\t', ';', '|', ' '] as Delimiter[]) {
    const counts = lines.map((line) => splitLine(line, delimiter).length);
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.filter((count) => count === first).length / counts.length;
    // Favour consistency, then more columns — a 5-column split beats a 2-column
    // split when both are perfectly consistent.
    const score = consistent * 100 + Math.min(first, 20);
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

function splitLine(line: string, delimiter: Delimiter): string[] {
  if (delimiter === ' ') return line.trim().split(/\s+/);
  return line.split(delimiter);
}

/** Full RFC 4180 parse, including newlines inside quoted fields. */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  if (delimiter === ' ') {
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => line.trim().split(/\s+/));
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index++;
        continue;
      }
      field += char;
      index++;
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      index++;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      index++;
      continue;
    }
    if (char === '\r') {
      index++;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index++;
      continue;
    }
    field += char;
    index++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop wholly empty trailing rows produced by a final newline.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

export interface ReadCsvOptions {
  delimiter?: Delimiter;
  /** Overrides schema detection when the user has set a mapping. */
  mapping?: ColumnMapping | null;
  /** Forces header handling instead of the heuristic. */
  hasHeader?: boolean;
}

export function readCsvTable(text: string, source: SourceInfo, options: ReadCsvOptions = {}): CirDataset {
  const delimiter = options.delimiter ?? sniffDelimiter(text);
  // Comment lines are common in controller exports and in .xyz files.
  const cleaned = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*[#;]/.test(line))
    .join('\n');
  const grid = parseDelimited(cleaned, delimiter);

  if (grid.length === 0) {
    throw new ConversionError({
      code: 'CSV_EMPTY',
      what: 'The table has no rows.',
      why: 'Every line was blank or a comment.',
      action: 'Check the file in a text editor — it may be an empty export.',
    });
  }

  const warnings: Warning[] = [];
  const hasHeader = options.hasHeader ?? looksLikeHeader(grid[0]);
  const headers = hasHeader ? grid[0].map((cell) => cell.trim()) : null;
  const bodyRows = hasHeader ? grid.slice(1) : grid;

  const columnCount = Math.max(...grid.map((row) => row.length));
  const ragged = grid.filter((row) => row.length !== columnCount).length;
  if (ragged > 0) {
    warnings.push(
      warn('CSV_RAGGED_ROWS', `${ragged} row(s) do not have ${columnCount} columns.`, {
        count: ragged,
        reason: 'The rows have inconsistent column counts, usually from an unquoted delimiter inside a description field.',
        action: 'Check the preview table; short rows are padded and long rows keep their extra columns as unnamed fields.',
      })
    );
  }

  const rows: (string | number | null)[][] = bodyRows.map((row) => {
    const out: (string | number | null)[] = new Array(columnCount).fill(null);
    for (let index = 0; index < columnCount; index++) {
      const cell = (row[index] ?? '').trim();
      if (cell === '') {
        out[index] = null;
        continue;
      }
      // Values are kept as text unless they are unambiguously numeric. A point
      // code of "007" must not become 7.
      const numeric = Number(cell);
      out[index] = Number.isFinite(numeric) && !/^0\d/.test(cell) ? numeric : cell;
    }
    return out;
  });

  const detection = options.mapping
    ? { mapping: options.mapping, schemaId: options.mapping.schemaId ?? 'user', schemaName: 'User-defined mapping', rationale: 'Column mapping was set manually.', requiresConfirmation: false, domainHints: [] }
    : detectSchema(headers, rows, columnCount);

  if (detection.requiresConfirmation) {
    warnings.push(
      warn('CSV_SCHEMA_UNCONFIRMED', `Coordinate columns need confirmation: ${detection.schemaName ?? 'no schema matched'}.`, {
        severity: detection.mapping ? 'warning' : 'error',
        reason: detection.rationale,
        action: 'Open the column mapping panel and confirm which columns hold easting, northing and elevation before converting.',
      })
    );
  }
  if (detection.domainHints.length > 0) {
    warnings.push(
      warn('CSV_DOMAIN_FIELDS', `Recognised survey/mining fields: ${detection.domainHints.join(', ')}.`, {
        severity: 'info',
        reason: 'These columns are recognised for labelling and layer-by-field export. Their original names are preserved.',
      })
    );
  }

  const table: CirTable = {
    columns: (headers ?? Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`)).map((name, index) => ({
      name: name || `Column ${index + 1}`,
      type: rows.every((row) => row[index] === null || typeof row[index] === 'number') ? 'number' : 'string',
    })),
    rows,
    mapping: detection.mapping,
    detectedSchema: detection.schemaId,
    hasHeader,
  };

  const dataset = createDataset({
    kind: 'table',
    name: source.fileName,
    source,
    crs: null,
    crsOrigin: 'unknown',
    axisOrder: detection.mapping?.coordinateOrder.startsWith('lat') ? 'yx' : 'xy',
    layers: [],
    table,
    warnings,
    metadata: { delimiter, schemaRationale: detection.rationale, columnCount },
  });
  return dataset;
}

/**
 * Turns a mapped table into point features. Unmapped columns are carried through
 * as attributes under their original names so nothing is lost.
 */
export function tableToPoints(dataset: CirDataset): { dataset: CirDataset; warnings: Warning[] } {
  const table = dataset.table;
  const warnings: Warning[] = [];
  if (!table || !table.mapping) {
    throw new ConversionError({
      code: 'TABLE_NO_MAPPING',
      what: 'The coordinate table has no confirmed column mapping.',
      why: 'Geometry cannot be built until the easting/northing (or longitude/latitude) columns are identified.',
      action: 'Open the column mapping panel, pick the coordinate columns, and convert again.',
    });
  }

  const { roles } = table.mapping;
  const mappedIndices = new Set(Object.values(roles).filter((value): value is number => typeof value === 'number'));
  const features: CirFeature[] = [];
  let skipped = 0;
  let zCount = 0;

  table.rows.forEach((row, index) => {
    const coordinate = coordinateFromRow(row, table.mapping!);
    if (!coordinate) {
      skipped++;
      return;
    }
    const properties: Record<string, unknown> = {};
    table.columns.forEach((column, columnIndex) => {
      // Coordinate columns are not duplicated into attributes, but the id, code
      // and description columns are: they are what the user labels points with.
      const isCoordinate =
        columnIndex === roles.easting || columnIndex === roles.northing || columnIndex === roles.elevation || columnIndex === roles.latitude || columnIndex === roles.longitude;
      if (isCoordinate) return;
      const value = row[columnIndex];
      if (value !== null && value !== undefined && value !== '') properties[column.name] = value;
      else if (!mappedIndices.has(columnIndex)) properties[column.name] = null;
    });

    const position: Position = coordinate.z !== null ? [coordinate.x, coordinate.y, coordinate.z] : [coordinate.x, coordinate.y];
    if (coordinate.z !== null) zCount++;
    features.push({
      id: roles.id !== undefined ? (row[roles.id] as string | number) ?? index : index,
      geometry: { type: 'Point', coordinates: position, dimension: coordinate.z !== null ? 3 : 2 },
      properties,
      sourceEntity: 'survey-point',
    });
  });

  if (skipped > 0) {
    warnings.push(
      warn('TABLE_ROWS_SKIPPED', `${skipped} row(s) had no usable coordinate pair and produced no point.`, {
        count: skipped,
        reason: 'The mapped coordinate columns were empty or non-numeric in those rows.',
        action: 'Check the preview table for blank or text values in the coordinate columns.',
      })
    );
  }
  if (zCount > 0 && zCount < features.length) {
    warnings.push(
      warn('TABLE_PARTIAL_Z', `${features.length - zCount} of ${features.length} points have no elevation.`, {
        severity: 'info',
        count: features.length - zCount,
        reason: 'The elevation column is empty for those rows.',
        action: 'Points without elevation are written as 2D. Fill or remove the blank cells if 3D output is required.',
      })
    );
  }

  return {
    dataset: {
      ...dataset,
      kind: 'vector',
      layers: [createLayer(dataset.name, features, deriveFields(features))],
      warnings: [...dataset.warnings, ...warnings],
    },
    warnings,
  };
}

export interface WriteCsvOptions {
  precision: PrecisionPolicy;
  delimiter: Delimiter;
  includeHeader: boolean;
  /** Column order for the coordinates. */
  coordinateOrder: 'easting-northing' | 'northing-easting';
  includeBom: boolean;
  /** Attribute columns to write; empty means all. */
  fields?: string[];
  idColumnName?: string;
}

export const DEFAULT_CSV_OPTIONS: Omit<WriteCsvOptions, 'precision'> = {
  delimiter: ',',
  includeHeader: true,
  coordinateOrder: 'easting-northing',
  includeBom: false,
  idColumnName: 'Point',
};

function quote(value: unknown, delimiter: Delimiter): string {
  const text = value == null ? '' : String(value);
  if (delimiter !== ' ' && (text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\r'))) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Writes a coordinate table. Multi-vertex geometry is expanded to one row per
 * vertex with a part index, so a polygon boundary exported to CSV is still a
 * usable list of boundary points rather than a lost feature.
 */
export function writeCsv(dataset: CirDataset, options: WriteCsvOptions): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = [];

  // A table converted to a table passes through verbatim. Routing it via point
  // geometry would silently drop every column that is not a coordinate.
  if (dataset.layers.length === 0 && dataset.table) {
    const lines: string[] = [];
    if (options.includeHeader) lines.push(dataset.table.columns.map((column) => quote(column.name, options.delimiter)).join(options.delimiter));
    for (const row of dataset.table.rows) lines.push(row.map((cell) => quote(cell, options.delimiter)).join(options.delimiter));
    return { text: lines.join('\n') + '\n', warnings };
  }

  const geographic = dataset.crs?.kind === 'geographic';
  const format = coordinateFormatter(options.precision, geographic);
  const decimals = options.precision.mode === 'full' ? 15 : geographic ? options.precision.geographicDecimals : options.precision.linearDecimals;
  const elevationDecimals = options.precision.mode === 'full' ? 15 : options.precision.elevationDecimals;

  const features = dataset.layers.flatMap((layer) => layer.features);
  const fields = options.fields ?? deriveFields(features).map((field) => field.name);

  const xLabel = geographic ? 'Longitude' : 'Easting';
  const yLabel = geographic ? 'Latitude' : 'Northing';
  const coordinateHeaders =
    options.coordinateOrder === 'northing-easting' ? [yLabel, xLabel, 'Elevation'] : [xLabel, yLabel, 'Elevation'];

  const header = [options.idColumnName ?? 'Point', ...coordinateHeaders, 'Part', 'Vertex', ...fields];
  const lines: string[] = [];
  if (options.includeHeader) lines.push(header.map((cell) => quote(cell, options.delimiter)).join(options.delimiter));

  let multiVertex = 0;
  features.forEach((feature, featureIndex) => {
    if (!feature.geometry) return;
    const parts = collectParts(feature.geometry);
    if (parts.length > 1 || parts.some((part) => part.length > 1)) multiVertex++;
    parts.forEach((part, partIndex) => {
      part.forEach((position, vertexIndex) => {
        const x = formatFixed(format.x(position[0]), decimals);
        const y = formatFixed(format.y(position[1]), decimals);
        const z = position.length > 2 && Number.isFinite(position[2]) ? formatFixed(format.z(position[2]), elevationDecimals) : '';
        const coordinates = options.coordinateOrder === 'northing-easting' ? [y, x, z] : [x, y, z];
        const attributes = fields.map((field) => quote(feature.properties?.[field], options.delimiter));
        lines.push(
          [
            quote(feature.id ?? featureIndex + 1, options.delimiter),
            ...coordinates,
            String(partIndex + 1),
            String(vertexIndex + 1),
            ...attributes,
          ].join(options.delimiter)
        );
      });
    });
  });

  if (multiVertex > 0) {
    warnings.push(
      warn('CSV_EXPANDED_VERTICES', `${multiVertex} multi-vertex feature(s) were expanded to one row per vertex.`, {
        severity: 'info',
        count: multiVertex,
        reason: 'A coordinate table holds points, not lines or polygons.',
        action: 'The Part and Vertex columns preserve the original order so the geometry can be rebuilt. Export to DXF, GeoJSON or Shapefile to keep the geometry intact.',
      })
    );
  }

  return { text: lines.join('\n') + '\n', warnings };
}

function collectParts(geometry: { type: string; coordinates?: any; geometries?: any[] }): Position[][] {
  switch (geometry.type) {
    case 'Point':
      return [[geometry.coordinates as Position]];
    case 'MultiPoint':
      return (geometry.coordinates as Position[]).map((position) => [position]);
    case 'LineString':
      return [geometry.coordinates as Position[]];
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates as Position[][];
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).flat();
    case 'GeometryCollection':
      return (geometry.geometries ?? []).flatMap((child: any) => collectParts(child));
    default:
      return [];
  }
}
