/**
 * Layered format detection (instruction §5.2).
 *
 * Extension alone is never decisive: a `.txt` holding PNEZD, a `.json` that is
 * not GeoJSON, and a `.dxf` that is really a DWG all occur in real survey
 * deliveries. Each layer contributes weighted evidence and the result carries a
 * confidence the UI must show — below 0.60 the pipeline blocks and asks.
 */

import { FORMATS, formatsForExtension, getFormat, type FormatDef } from './registry';
import { extensionOf } from './naming';

/** Computed once: the signature scan runs on every dropped file. */
const FORMATS_WITH_MAGIC = FORMATS.filter((format) => format.magic);

export interface DetectionInput {
  fileName: string;
  bytes: Uint8Array;
  mimeType?: string;
  /** Extensions of sibling files in the same folder or archive. */
  siblings?: string[];
}

export interface DetectionEvidence {
  layer: string;
  weight: number;
  note: string;
}

export interface DetectionResult {
  formatId: string;
  formatName: string;
  confidence: number;
  evidence: DetectionEvidence[];
  /** Other plausible readings, best first, for the "confirm format" control. */
  alternatives: { formatId: string; confidence: number }[];
  /** True when confidence < 0.60 and the user must confirm before converting. */
  requiresConfirmation: boolean;
}

export const CONFIRM_THRESHOLD = 0.6;
export const AUTO_THRESHOLD = 0.9;

const WEIGHTS = {
  extension: 0.2,
  mime: 0.1,
  magic: 0.45,
  header: 0.4,
  xmlRoot: 0.4,
  jsonShape: 0.4,
  binaryProbe: 0.35,
  textHeuristic: 0.25,
  companion: 0.15,
} as const;

/** Decodes the leading bytes as UTF-8 for the text layers. */
function headText(bytes: Uint8Array, limit = 8192): string {
  const slice = bytes.subarray(0, Math.min(limit, bytes.length));
  return new TextDecoder('utf-8', { fatal: false }).decode(slice).replace(/^﻿/, '');
}

function matchesMagic(bytes: Uint8Array, format: FormatDef): boolean {
  if (!format.magic) return false;
  return format.magic.some((rule) => {
    const expected = typeof rule.bytes === 'string' ? [...rule.bytes].map((c) => c.charCodeAt(0)) : rule.bytes;
    if (bytes.length < rule.offset + expected.length) return false;
    for (let i = 0; i < expected.length; i++) if (bytes[rule.offset + i] !== expected[i]) return false;
    return true;
  });
}

interface Scores {
  add(formatId: string, weight: number, layer: string, note: string): void;
}

function makeScores(): { scores: Map<string, number>; evidence: Map<string, DetectionEvidence[]>; api: Scores } {
  const scores = new Map<string, number>();
  const evidence = new Map<string, DetectionEvidence[]>();
  return {
    scores,
    evidence,
    api: {
      add(formatId, weight, layer, note) {
        scores.set(formatId, (scores.get(formatId) ?? 0) + weight);
        const list = evidence.get(formatId) ?? [];
        list.push({ layer, weight, note });
        evidence.set(formatId, list);
      },
    },
  };
}

/** L3/L4: binary signature and header structure probes for the binary formats. */
function probeBinary(bytes: Uint8Array, add: Scores): void {
  if (bytes.length < 8) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Shapefile: big-endian magic 9994 at 0 and the file length at byte 24 in
  // 16-bit words. Both agreeing is conclusive.
  if (bytes.length >= 100 && view.getInt32(0, false) === 9994) {
    const declared = view.getInt32(24, false) * 2;
    const note = declared === bytes.length ? 'SHP magic 9994 and file length agree' : 'SHP magic 9994, declared length differs';
    add.add('shapefile', declared === bytes.length ? WEIGHTS.magic + WEIGHTS.header : WEIGHTS.magic, 'binary-probe', note);
  }

  // LAS: 'LASF' plus a header size that matches a known version.
  if (bytes.length >= 227 && bytes[0] === 0x4c && bytes[1] === 0x41 && bytes[2] === 0x53 && bytes[3] === 0x46) {
    const major = bytes[24];
    const minor = bytes[25];
    const headerSize = view.getUint16(94, true);
    const pointFormat = view.getUint8(104);
    const sane = major === 1 && minor <= 4 && headerSize >= 227 && headerSize <= 512;
    // LAZ sets the high bits of the point data record format. Reading such a
    // file as LAS would produce fabricated coordinates (rule R5).
    const compressed = (pointFormat & 0x80) !== 0 || (pointFormat & 0x40) !== 0;
    if (compressed) {
      add.add('laz', WEIGHTS.magic + WEIGHTS.header, 'binary-probe', `LASF header with compressed point format bit set (0x${pointFormat.toString(16)})`);
    } else if (sane) {
      add.add('las', WEIGHTS.magic + WEIGHTS.header, 'binary-probe', `LASF header, version ${major}.${minor}, header size ${headerSize}`);
    } else {
      add.add('las', WEIGHTS.magic, 'binary-probe', 'LASF signature present but header fields are out of range');
    }
  }

  // TIFF/BigTIFF: byte-order mark plus the 42/43 version word.
  const le = bytes[0] === 0x49 && bytes[1] === 0x49;
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (le || be) {
    const version = view.getUint16(2, le);
    if (version === 42 || version === 43) {
      add.add('geotiff', WEIGHTS.magic + WEIGHTS.header, 'binary-probe', version === 43 ? 'BigTIFF header' : 'TIFF header');
    }
  }

  // DBF: version byte plus a header length consistent with 32-byte field descriptors.
  const dbfVersions = new Set([0x02, 0x03, 0x04, 0x05, 0x30, 0x31, 0x43, 0x83, 0x8b, 0xf5]);
  if (bytes.length >= 32 && dbfVersions.has(bytes[0])) {
    const headerLength = view.getUint16(8, true);
    if (headerLength >= 33 && (headerLength - 33) % 32 === 0 && headerLength < bytes.length) {
      add.add('shapefile', WEIGHTS.binaryProbe, 'binary-probe', 'DBF attribute table detected');
    }
  }

  // ZIP-family: PK signature, then the member names decide which family.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const text = headText(bytes, 4096);
    if (text.includes('[Content_Types].xml') || text.includes('xl/workbook')) {
      add.add('xlsx', WEIGHTS.magic + WEIGHTS.binaryProbe, 'binary-probe', 'OOXML workbook members present');
    } else if (/doc\.kml|\.kml/i.test(text)) {
      add.add('kmz', WEIGHTS.magic + WEIGHTS.binaryProbe, 'binary-probe', 'KML member present in ZIP');
    } else {
      add.add('zip', WEIGHTS.magic, 'binary-probe', 'ZIP local file header');
    }
  }

  // WKB: byte-order flag 0/1 then a plausible geometry type code.
  if (bytes.length >= 5 && (bytes[0] === 0 || bytes[0] === 1)) {
    const wkbLittle = bytes[0] === 1;
    const raw = view.getUint32(1, wkbLittle);
    const base = raw % 1000;
    const flavour = Math.floor(raw / 1000);
    if (base >= 1 && base <= 7 && flavour <= 3) {
      add.add('wkb', WEIGHTS.binaryProbe, 'binary-probe', `WKB geometry type ${raw}`);
    }
  }
}

/** L5/L6/L8: text-shaped evidence. */
function probeText(text: string, add: Scores): void {
  if (!text.trim()) return;
  const head = text.slice(0, 4096);

  // DXF: the group-code stream always opens with a 0/SECTION pair.
  if (/^\s*0\s*[\r\n]+\s*SECTION/i.test(head) || /[\r\n]\s*0\s*[\r\n]+\s*SECTION/i.test(head)) {
    add.add('dxf', WEIGHTS.header + WEIGHTS.textHeuristic, 'text-heuristic', 'DXF group-code stream opens with 0/SECTION');
  } else if (/AutoCAD Binary DXF/.test(head)) {
    add.add('dxf', WEIGHTS.magic, 'text-heuristic', 'Binary DXF sentinel');
  }

  // XML roots.
  const xmlRoot = head.match(/<\s*([A-Za-z_][\w.-]*)(?::([\w.-]+))?[\s>]/);
  if (head.trimStart().startsWith('<')) {
    const local = (xmlRoot?.[2] ?? xmlRoot?.[1] ?? '').toLowerCase();
    const ns = head.slice(0, 2048);
    if (local === 'kml' || ns.includes('opengis.net/kml')) add.add('kml', WEIGHTS.xmlRoot, 'xml-root', 'KML root element');
    else if (local === 'gpx' || ns.includes('topografix.com/GPX')) add.add('gpx', WEIGHTS.xmlRoot, 'xml-root', 'GPX root element');
    else if (local === 'osm') add.add('osm', WEIGHTS.xmlRoot, 'xml-root', 'OSM root element');
    else if (local === 'landxml') add.add('landxml', WEIGHTS.xmlRoot, 'xml-root', 'LandXML root element');
    else if (ns.includes('opengis.net/gml') || /<gml:/.test(ns)) add.add('gml', WEIGHTS.xmlRoot, 'xml-root', 'GML namespace present');
  }

  // JSON shape — a .json file is GeoJSON only if it validates structurally (§5.5).
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const type = (parsed as any).type;
        if (type === 'Topology' && (parsed as any).objects) {
          add.add('topojson', WEIGHTS.jsonShape, 'json-shape', 'TopoJSON Topology with objects');
        } else if (
          type === 'FeatureCollection' && Array.isArray((parsed as any).features)
        ) {
          add.add('geojson', WEIGHTS.jsonShape, 'json-shape', 'GeoJSON FeatureCollection');
        } else if (
          type === 'Feature' ||
          ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].includes(type)
        ) {
          add.add('geojson', WEIGHTS.jsonShape, 'json-shape', `GeoJSON ${type}`);
        }
      }
    } catch {
      // Truncated head or a genuinely invalid document. Line-delimited GeoJSON
      // is the common case, so try the first line on its own.
      const firstLine = text.split(/\r?\n/, 1)[0];
      try {
        const parsed = JSON.parse(firstLine);
        if (parsed && (parsed as any).type === 'Feature') {
          add.add('geojsonseq', WEIGHTS.jsonShape, 'json-shape', 'First line parses as a GeoJSON Feature');
        }
      } catch {
        /* not JSON at all */
      }
    }
  }

  // ASCII grid header.
  if (/^\s*ncols\s+\d+/i.test(head) && /nrows\s+\d+/i.test(head)) {
    add.add('asciigrid', WEIGHTS.header, 'text-heuristic', 'ASCII grid ncols/nrows header');
  }

  // MapInfo interchange.
  if (/^\s*version\s+\d+/im.test(head) && /\bcolumns\s+\d+/i.test(head) && /\bdata\b/i.test(head)) {
    add.add('mifmid', WEIGHTS.header, 'text-heuristic', 'MIF Version/Columns/Data header');
  }

  // PLY.
  if (/^ply\s*[\r\n]+format\s+(ascii|binary_little_endian|binary_big_endian)/i.test(head)) {
    add.add('ply', WEIGHTS.header + WEIGHTS.magic, 'text-heuristic', 'PLY header');
  }

  // WKT geometry (not a CRS WKT — those start with PROJCS/GEOGCS).
  if (/^\s*(SRID=\d+;)?\s*(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*(Z|M|ZM)?\s*[(EMPTY]/i.test(head)) {
    add.add('wkt', WEIGHTS.header, 'text-heuristic', 'WKT geometry keyword');
  }

  // CRS WKT belongs to the .prj sidecar family.
  if (/^\s*(PROJCS|GEOGCS|PROJCRS|GEOGCRS|COMPD_CS)\s*\[/i.test(head)) {
    add.add('prj', WEIGHTS.header, 'text-heuristic', 'CRS WKT root keyword');
  }

  // Surpac string: header lines then records shaped `string,y,x,z,description`.
  const surpacLines = head.split(/\r?\n/).slice(0, 12);
  const surpacRecords = surpacLines.filter((line) => /^\s*\d+\s*,\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*,/.test(line));
  if (surpacRecords.length >= 2 && /^\s*0\s*,\s*0\.000\s*,\s*0\.000\s*,\s*0\.000/m.test(head)) {
    add.add('surpac-str', WEIGHTS.header, 'text-heuristic', 'Surpac string records with a 0,0,0,0 terminator');
  }

  // Delimited coordinate table. Requires several rows with a consistent
  // delimiter and at least two numeric columns, which is what separates a real
  // coordinate table from arbitrary prose.
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 25);
  if (lines.length >= 2) {
    for (const [delimiter, label] of [
      [',', 'comma'],
      ['\t', 'tab'],
      [';', 'semicolon'],
      [/\s+/, 'whitespace'],
    ] as const) {
      const columnCounts = lines.map((line) => (typeof delimiter === 'string' ? line.split(delimiter) : line.trim().split(delimiter)).length);
      const consistent = columnCounts.every((count) => count === columnCounts[0]) && columnCounts[0] >= 2;
      if (!consistent) continue;
      const dataRows = lines.slice(1);
      const numericColumns = countNumericColumns(dataRows, delimiter);
      if (numericColumns >= 2) {
        const isWhitespaceXyz = label === 'whitespace' && columnCounts[0] >= 3 && numericColumns >= 3;
        add.add(isWhitespaceXyz ? 'xyz' : 'csv', WEIGHTS.textHeuristic + 0.15, 'text-heuristic', `${label}-delimited table with ${numericColumns} numeric columns`);
        if (isWhitespaceXyz) add.add('csv', WEIGHTS.textHeuristic, 'text-heuristic', 'Whitespace table also readable as a coordinate table');
        break;
      }
    }
  }
}

function countNumericColumns(rows: string[], delimiter: string | RegExp): number {
  if (rows.length === 0) return 0;
  const split = (line: string) => (typeof delimiter === 'string' ? line.split(delimiter) : line.trim().split(delimiter));
  const columns = split(rows[0]).length;
  let numeric = 0;
  for (let column = 0; column < columns; column++) {
    const allNumeric = rows.every((row) => {
      const cell = (split(row)[column] ?? '').trim().replace(/^"|"$/g, '');
      return cell !== '' && Number.isFinite(Number(cell));
    });
    if (allNumeric) numeric++;
  }
  return numeric;
}

export function detectFormat(input: DetectionInput): DetectionResult {
  const { scores, evidence, api } = makeScores();
  const extension = extensionOf(input.fileName);

  // L1 extension — weak on its own, and deliberately shared when several
  // formats claim it (.json, .xml, .txt).
  const byExtension = formatsForExtension(extension);
  for (const format of byExtension) {
    api.add(format.id, WEIGHTS.extension / Math.max(1, byExtension.length), 'extension', `.${extension} is registered to ${format.name}`);
  }

  // L2 MIME.
  if (input.mimeType) {
    for (const format of byExtension.length ? byExtension : []) {
      if (format.mimeTypes.includes(input.mimeType)) api.add(format.id, WEIGHTS.mime, 'mime', `MIME ${input.mimeType}`);
    }
  }

  // L3 registered magic signatures.
  for (const format of FORMATS_WITH_MAGIC) {
    if (matchesMagic(input.bytes, format)) api.add(format.id, WEIGHTS.magic * 0.6, 'magic', `${format.name} signature`);
  }

  // L4/L7 binary structure.
  probeBinary(input.bytes, api);

  // L5/L6/L8 text structure.
  if (looksTextual(input.bytes)) probeText(headText(input.bytes, 65536), api);

  // L9 companion context.
  if (input.siblings?.length) {
    const siblingSet = new Set(input.siblings.map((s) => s.toLowerCase()));
    if (extension === 'shp' && (siblingSet.has('shx') || siblingSet.has('dbf'))) {
      api.add('shapefile', WEIGHTS.companion, 'companion', 'Shapefile companions present');
    }
    if (extension === 'mif' && siblingSet.has('mid')) api.add('mifmid', WEIGHTS.companion, 'companion', '.mid companion present');
    if ((extension === 'tif' || extension === 'tiff') && siblingSet.has('tfw')) {
      api.add('geotiff', WEIGHTS.companion, 'companion', '.tfw world file present');
    }
  }

  if (scores.size === 0) {
    return {
      formatId: 'unknown',
      formatName: 'Unrecognised',
      confidence: 0,
      evidence: [],
      alternatives: [],
      requiresConfirmation: true,
    };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [winnerId, rawScore] = ranked[0];
  const winner = getFormat(winnerId);
  // The score is a weighted sum whose theoretical maximum sits near 1.2 when
  // several strong layers agree; clamping keeps the displayed percentage honest.
  const confidence = Math.max(0, Math.min(1, rawScore / 1.05));

  return {
    formatId: winnerId,
    formatName: winner?.name ?? winnerId,
    confidence,
    evidence: evidence.get(winnerId) ?? [],
    alternatives: ranked.slice(1, 4).map(([id, score]) => ({ formatId: id, confidence: Math.min(1, score / 1.05) })),
    requiresConfirmation: confidence < CONFIRM_THRESHOLD,
  };
}

/**
 * Heuristic textuality test: a NUL byte in the first kilobyte means binary. This
 * is what keeps the text probes from decoding a LAS file into mojibake.
 */
export function looksTextual(bytes: Uint8Array): boolean {
  const limit = Math.min(1024, bytes.length);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return false;
  return true;
}
