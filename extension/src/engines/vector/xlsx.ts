/**
 * XLSX workbooks — the spreadsheet path for survey coordinate tables.
 *
 * Reading walks the OOXML package: workbook.xml names the sheets,
 * sharedStrings.xml holds the string pool, and each sheet stores cells by A1
 * reference. Cell references are honoured rather than assuming dense rows,
 * because a survey sheet with a blank column would otherwise shift every value
 * left by one.
 *
 * Writing produces the minimum valid package that Excel, LibreOffice and Google
 * Sheets all open: content types, the two rels parts, workbook, styles and one
 * worksheet with inline strings.
 */

import { warn, type CirDataset, type SourceInfo, type Warning } from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { readZip, writeZip } from '../archives/zip';
import { encodeText, xmlEscape } from '../shared';
import { attribute, children, descendants, documentElement, parseXml } from '../xml';
import { readCsvTable } from './csv';
import { coordinateFormatter, formatFixed, type PrecisionPolicy } from '../../core/precision';
import { deriveFields } from '../shared';
import type { Position } from '../../core/cir';

/** Converts an A1-style column reference to a zero-based index. */
export function columnIndexFromRef(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0] ?? 'A';
  let index = 0;
  for (const character of letters.toUpperCase()) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

export function columnLetter(index: number): string {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

export async function readXlsxSheets(bytes: Uint8Array): Promise<XlsxSheet[]> {
  const entries = await readZip(bytes);
  const byName = new Map(entries.map((entry) => [entry.name.replace(/^\/+/, '').toLowerCase(), entry]));
  const decoder = new TextDecoder();

  const workbookEntry = byName.get('xl/workbook.xml');
  if (!workbookEntry) {
    throw new ConversionError({
      code: 'XLSX_NO_WORKBOOK',
      what: 'The archive has no xl/workbook.xml part.',
      why: 'This is a ZIP archive but not an Office Open XML workbook.',
      action: 'Confirm the detected format in the inspector — a .xlsx renamed from .xls will not open either.',
    });
  }

  // Shared strings are a pool that cells reference by index; a cell of type "s"
  // holds the index, not the text.
  const sharedStrings: string[] = [];
  const sharedEntry = byName.get('xl/sharedstrings.xml');
  if (sharedEntry) {
    const document = parseXml(decoder.decode(sharedEntry.bytes));
    const root = documentElement(document);
    if (root) {
      for (const si of children(root, 'si')) {
        // Rich text splits a single string across several <t> runs.
        sharedStrings.push(descendants(si, 't').map((node) => node.text).join('') || si.text);
      }
    }
  }

  // Sheet order and names come from workbook.xml; the file path comes from the
  // relationship id in workbook.xml.rels.
  const relationships = new Map<string, string>();
  const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
  if (relsEntry) {
    const document = parseXml(decoder.decode(relsEntry.bytes));
    const root = documentElement(document);
    if (root) {
      for (const relationship of children(root, 'Relationship')) {
        const id = attribute(relationship, 'Id');
        const target = attribute(relationship, 'Target');
        if (id && target) relationships.set(id, target.replace(/^\/?(xl\/)?/, ''));
      }
    }
  }

  const workbook = parseXml(decoder.decode(workbookEntry.bytes));
  const workbookRoot = documentElement(workbook);
  const sheetNodes = workbookRoot ? descendants(workbookRoot, 'sheet') : [];
  const sheets: XlsxSheet[] = [];

  sheetNodes.forEach((sheetNode, index) => {
    const name = attribute(sheetNode, 'name') ?? `Sheet${index + 1}`;
    const relationshipId = attribute(sheetNode, 'r:id') ?? attribute(sheetNode, 'id');
    const target = relationshipId ? relationships.get(relationshipId) : undefined;
    const entry =
      (target ? byName.get(`xl/${target}`.toLowerCase()) : undefined) ?? byName.get(`xl/worksheets/sheet${index + 1}.xml`);
    if (!entry) return;

    const document = parseXml(decoder.decode(entry.bytes));
    const root = documentElement(document);
    if (!root) return;
    const rows: string[][] = [];
    for (const row of descendants(root, 'row')) {
      const cells: string[] = [];
      for (const cell of children(row, 'c')) {
        const ref = attribute(cell, 'r');
        const columnIndex = ref ? columnIndexFromRef(ref) : cells.length;
        while (cells.length < columnIndex) cells.push('');
        const type = attribute(cell, 't');
        let value = '';
        if (type === 's') {
          const poolIndex = Number(children(cell, 'v')[0]?.text ?? '');
          value = Number.isInteger(poolIndex) ? (sharedStrings[poolIndex] ?? '') : '';
        } else if (type === 'inlineStr') {
          value = descendants(cell, 't').map((node) => node.text).join('');
        } else {
          value = children(cell, 'v')[0]?.text ?? '';
        }
        cells.push(value);
      }
      rows.push(cells);
    }
    sheets.push({ name, rows });
  });

  if (sheets.length === 0) {
    throw new ConversionError({
      code: 'XLSX_NO_SHEETS',
      what: 'No worksheets could be read from the workbook.',
      why: 'workbook.xml declares no sheets, or the sheet parts are missing from the package.',
      action: 'Open the file in Excel and re-save it as .xlsx.',
    });
  }
  return sheets;
}

export interface ReadXlsxOptions {
  /** Which sheet to convert; defaults to the first non-empty one. */
  sheetName?: string;
}

export async function readXlsx(bytes: Uint8Array, source: SourceInfo, options: ReadXlsxOptions = {}): Promise<CirDataset> {
  const sheets = await readXlsxSheets(bytes);
  const chosen =
    (options.sheetName ? sheets.find((sheet) => sheet.name === options.sheetName) : undefined) ??
    sheets.find((sheet) => sheet.rows.length > 1) ??
    sheets[0];

  // Re-using the CSV reader keeps schema detection, column mapping and the
  // survey-alias logic in exactly one place.
  const csvText = chosen.rows
    .map((row) => row.map((cell) => (cell.includes(',') || cell.includes('"') ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','))
    .join('\n');

  const dataset = readCsvTable(csvText, source, { delimiter: ',' });
  dataset.name = `${source.fileName} — ${chosen.name}`;
  dataset.metadata = { ...dataset.metadata, sheetName: chosen.name, sheetNames: sheets.map((sheet) => sheet.name) };
  if (sheets.length > 1) {
    dataset.warnings.push(
      warn('XLSX_MULTIPLE_SHEETS', `The workbook has ${sheets.length} sheets; "${chosen.name}" was converted.`, {
        severity: 'info',
        count: sheets.length,
        reason: 'One conversion produces one dataset.',
        action: `Other sheets: ${sheets.map((sheet) => sheet.name).filter((name) => name !== chosen.name).join(', ')}. Re-run the conversion and pick another sheet to convert it.`,
      })
    );
  }
  return dataset;
}

export interface WriteXlsxOptions {
  precision: PrecisionPolicy;
  sheetName?: string;
  coordinateOrder?: 'easting-northing' | 'northing-easting';
  fields?: string[];
}

/**
 * Writes a coordinate workbook. Numbers are written as numbers, not text, so
 * the recipient can compute with them without a re-import step.
 */
export async function writeXlsx(dataset: CirDataset, options: WriteXlsxOptions): Promise<{ bytes: Uint8Array; warnings: Warning[] }> {
  const warnings: Warning[] = [];
  const geographic = dataset.crs?.kind === 'geographic';
  const format = coordinateFormatter(options.precision, geographic);
  const decimals = options.precision.mode === 'full' ? 15 : geographic ? options.precision.geographicDecimals : options.precision.linearDecimals;
  const elevationDecimals = options.precision.mode === 'full' ? 15 : options.precision.elevationDecimals;

  // A table converted to a table passes through verbatim. Routing it via point
  // geometry would silently drop every column that is not a coordinate.
  if (dataset.layers.length === 0 && dataset.table) {
    const header = dataset.table.columns.map((column) => column.name);
    const rows: (string | number | null)[][] = dataset.table.hasHeader ? [header, ...dataset.table.rows] : [header, ...dataset.table.rows];
    return { bytes: await buildXlsxPackage(options.sheetName ?? 'Coordinates', rows), warnings };
  }

  const features = dataset.layers.flatMap((layer) => layer.features);
  const allFields = deriveFields(features);
  const fields = options.fields ? allFields.filter((field) => options.fields!.includes(field.name)) : allFields;

  const xLabel = geographic ? 'Longitude' : 'Easting';
  const yLabel = geographic ? 'Latitude' : 'Northing';
  const coordinateHeaders =
    options.coordinateOrder === 'northing-easting' ? [yLabel, xLabel, 'Elevation'] : [xLabel, yLabel, 'Elevation'];

  const rows: (string | number | null)[][] = [['Point', ...coordinateHeaders, 'Part', 'Vertex', ...fields.map((field) => field.name)]];
  let expanded = 0;

  features.forEach((feature, featureIndex) => {
    if (!feature.geometry) return;
    const parts = partsOf(feature.geometry);
    if (parts.length > 1 || parts.some((part) => part.length > 1)) expanded++;
    parts.forEach((part, partIndex) => {
      part.forEach((position, vertexIndex) => {
        const x = Number(formatFixed(format.x(position[0]), decimals));
        const y = Number(formatFixed(format.y(position[1]), decimals));
        const z = position.length > 2 && Number.isFinite(position[2]) ? Number(formatFixed(format.z(position[2]), elevationDecimals)) : null;
        const coordinates = options.coordinateOrder === 'northing-easting' ? [y, x, z] : [x, y, z];
        rows.push([
          feature.id ?? featureIndex + 1,
          ...coordinates,
          partIndex + 1,
          vertexIndex + 1,
          ...fields.map((field) => {
            const value = feature.properties?.[field.name];
            return value === undefined ? null : (value as string | number | null);
          }),
        ]);
      });
    });
  });

  if (expanded > 0) {
    warnings.push(
      warn('XLSX_EXPANDED_VERTICES', `${expanded} multi-vertex feature(s) were expanded to one row per vertex.`, {
        severity: 'info',
        count: expanded,
        reason: 'A spreadsheet holds points, not lines or polygons.',
        action: 'The Part and Vertex columns preserve vertex order so the geometry can be rebuilt.',
      })
    );
  }

  const bytes = await buildXlsxPackage(options.sheetName ?? 'Coordinates', rows);
  return { bytes, warnings };
}

function partsOf(geometry: { type: string; coordinates?: any; geometries?: any[] }): Position[][] {
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
      return (geometry.geometries ?? []).flatMap((child: any) => partsOf(child));
    default:
      return [];
  }
}

/** Builds the minimal OOXML package Excel will open without repair prompts. */
export async function buildXlsxPackage(sheetName: string, rows: (string | number | null)[][]): Promise<Uint8Array> {
  const safeSheetName = sheetName.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet1';

  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (value === null || value === undefined || value === '') return '';
          const ref = `${columnLetter(columnIndex)}${rowIndex + 1}`;
          if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
          // Inline strings avoid a shared-strings part entirely; the file is
          // slightly larger and considerably simpler to generate correctly.
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows}</sheetData></worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEscape(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  // A styles part is required by the schema even when no style is applied.
  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
    `<cellXfs count="1"><xf xfId="0"/></cellXfs>` +
    `</styleSheet>`;

  return writeZip([
    { name: '[Content_Types].xml', bytes: encodeText(contentTypes) },
    { name: '_rels/.rels', bytes: encodeText(rootRels) },
    { name: 'xl/workbook.xml', bytes: encodeText(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: encodeText(workbookRels) },
    { name: 'xl/styles.xml', bytes: encodeText(stylesXml) },
    { name: 'xl/worksheets/sheet1.xml', bytes: encodeText(sheetXml) },
  ]);
}
