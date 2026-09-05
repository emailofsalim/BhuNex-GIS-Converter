/**
 * dBASE III/IV (.dbf) attribute tables — the attribute half of a shapefile.
 *
 * The format's constraints are the ones that bite in practice: field names are
 * capped at 10 bytes, character values at 254, and the whole table is
 * fixed-width. Truncation and renaming are therefore inevitable for rich
 * attribute sets; every one of them is reported and recorded so the original
 * names survive in the manifest (instruction §9.5, §33).
 */

import type { FieldDef, Warning } from '../../core/cir';
import { warn } from '../../core/cir';
import { ConversionError } from '../../core/errors';

export interface DbfField {
  name: string;
  type: 'C' | 'N' | 'F' | 'D' | 'L' | 'M';
  length: number;
  decimals: number;
}

export interface DbfTable {
  fields: DbfField[];
  records: Record<string, unknown>[];
  encoding: string;
  /** Records flagged as deleted, kept out of `records` but counted. */
  deletedCount: number;
}

/**
 * Language-driver byte to encoding. Only the code pages that appear in real GIS
 * deliveries are mapped; anything else falls back to the .cpg file or Latin-1.
 */
const LDID_ENCODINGS: Record<number, string> = {
  0x01: 'cp437',
  0x02: 'cp850',
  0x03: 'windows-1252',
  0x57: 'windows-1252',
  0x58: 'windows-1252',
  0x59: 'windows-1252',
  0x64: 'cp852',
  0x65: 'cp866',
  0x6a: 'cp737',
  0x87: 'cp852',
  0xc8: 'windows-1250',
  0xc9: 'windows-1251',
  0xca: 'windows-1254',
  0xcb: 'windows-1253',
};

function normaliseEncoding(label: string): string {
  const key = label.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (key === 'utf8' || key === '65001') return 'utf-8';
  if (key.startsWith('cp') || key.startsWith('windows')) return key.replace('cp', 'windows-').replace('windows-4', 'cp4').replace('windows-8', 'cp8');
  if (key === 'iso88591' || key === 'latin1') return 'iso-8859-1';
  return label;
}

export function readDbf(bytes: Uint8Array, cpgText?: string): DbfTable {
  if (bytes.length < 32) {
    throw new ConversionError({
      code: 'DBF_TOO_SHORT',
      what: 'The .dbf attribute table is shorter than its 32-byte header.',
      why: 'The file is truncated or empty.',
      action: 'Re-copy the shapefile package; the .dbf did not transfer completely.',
    });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const recordCount = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const languageDriver = bytes[29];

  let encoding = 'iso-8859-1';
  if (cpgText && cpgText.trim()) encoding = normaliseEncoding(cpgText);
  else if (LDID_ENCODINGS[languageDriver]) encoding = LDID_ENCODINGS[languageDriver];

  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: false });
  } catch {
    // An unsupported label must not abort the read; Latin-1 never throws and
    // keeps byte values recoverable.
    decoder = new TextDecoder('iso-8859-1', { fatal: false });
    encoding = 'iso-8859-1';
  }

  const fields: DbfField[] = [];
  for (let at = 32; at + 32 <= headerLength - 1 && at + 32 <= bytes.length; at += 32) {
    if (bytes[at] === 0x0d) break; // field terminator
    let name = '';
    for (let index = 0; index < 11; index++) {
      const code = bytes[at + index];
      if (code === 0) break;
      name += String.fromCharCode(code);
    }
    name = name.trim();
    if (!name) continue;
    fields.push({
      name,
      type: String.fromCharCode(bytes[at + 11]) as DbfField['type'],
      length: bytes[at + 16],
      decimals: bytes[at + 17],
    });
  }

  if (fields.length === 0) {
    return { fields, records: [], encoding, deletedCount: 0 };
  }

  const records: Record<string, unknown>[] = [];
  let deletedCount = 0;
  let at = headerLength;
  for (let index = 0; index < recordCount; index++) {
    if (at + recordLength > bytes.length) break; // truncated table: stop, do not fabricate
    const deleted = bytes[at] === 0x2a;
    let cursor = at + 1;
    const record: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = decoder.decode(bytes.subarray(cursor, cursor + field.length)).trim();
      cursor += field.length;
      record[field.name] = decodeValue(raw, field);
    }
    at += recordLength;
    if (deleted) deletedCount++;
    else records.push(record);
  }

  return { fields, records, encoding, deletedCount };
}

function decodeValue(raw: string, field: DbfField): unknown {
  if (raw === '') return null;
  switch (field.type) {
    case 'N':
    case 'F': {
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    }
    case 'L':
      return /^[YyTt]$/.test(raw) ? true : /^[NnFf]$/.test(raw) ? false : null;
    case 'D': {
      // Stored as YYYYMMDD; returned as ISO text so it survives every target.
      if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      return raw;
    }
    default:
      return raw;
  }
}

export interface DbfFieldPlan {
  field: DbfField;
  /** Property key this column is written from. */
  sourceName: string;
}

export interface DbfWritePlan {
  fields: DbfFieldPlan[];
  warnings: Warning[];
  /** Original name -> written name, for the conversion manifest. */
  renames: Record<string, string>;
}

/**
 * Sanitises a field name to the DBF constraints, keeping names unique.
 *
 * Case is preserved. dBASE convention is uppercase, but the format does not
 * require it and GDAL, QGIS and ArcGIS all read mixed case — so upper-casing
 * would destroy information (a `plot_no` field coming back as `PLOT_NO` breaks
 * every downstream join) for no compatibility gain. Uniqueness is therefore
 * checked case-insensitively, since some readers do fold case.
 */
function safeFieldName(name: string, used: Set<string>): string {
  let base = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1')
    .slice(0, 10);
  if (!base) base = 'FIELD';
  if (!used.has(base.toLowerCase())) {
    used.add(base.toLowerCase());
    return base;
  }
  // Suffix with a counter, shrinking the stem so the result still fits in 10.
  for (let index = 1; index < 1000; index++) {
    const suffix = String(index);
    const candidate = `${base.slice(0, 10 - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
  const fallback = `F${Date.now() % 1e9}`.slice(0, 10);
  used.add(fallback.toLowerCase());
  return fallback;
}

/**
 * Plans the DBF column layout from the CIR fields and the actual values, so a
 * numeric column is sized to its widest value rather than to a guess.
 */
export function planDbfFields(fields: FieldDef[], records: Record<string, unknown>[]): DbfWritePlan {
  const used = new Set<string>();
  const warnings: Warning[] = [];
  const renames: Record<string, string> = {};
  const plan: DbfFieldPlan[] = [];
  let truncatedValues = 0;

  for (const field of fields) {
    const written = safeFieldName(field.name, used);
    if (written !== field.name) renames[field.name] = written;

    let type: DbfField['type'] = 'C';
    let length = 0;
    let decimals = 0;

    if (field.type === 'integer' || field.type === 'number') {
      type = 'N';
      let integerDigits = 1;
      let decimalDigits = field.type === 'integer' ? 0 : 0;
      for (const record of records) {
        const value = record[field.name];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const text = String(value);
        const [wholePart, fractionPart = ''] = text.replace('-', '').split('.');
        integerDigits = Math.max(integerDigits, wholePart.length + (value < 0 ? 1 : 0));
        decimalDigits = Math.max(decimalDigits, Math.min(fractionPart.length, 10));
      }
      decimals = decimalDigits;
      // +1 for the decimal point when there is a fractional part.
      length = Math.min(18, integerDigits + (decimals > 0 ? decimals + 1 : 0));
      if (length < 1) length = 1;
    } else if (field.type === 'boolean') {
      type = 'L';
      length = 1;
    } else if (field.type === 'date') {
      type = 'D';
      length = 8;
    } else {
      type = 'C';
      let widest = 1;
      for (const record of records) {
        const value = record[field.name];
        if (value === null || value === undefined) continue;
        const encoded = new TextEncoder().encode(String(value)).length;
        if (encoded > 254) truncatedValues++;
        widest = Math.max(widest, Math.min(254, encoded));
      }
      length = widest;
    }

    plan.push({ field: { name: written, type, length, decimals }, sourceName: field.name });
  }

  const renamedEntries = Object.entries(renames);
  if (renamedEntries.length > 0) {
    warnings.push(
      warn('DBF_FIELDS_RENAMED', `${renamedEntries.length} field name(s) were changed to fit the DBF 10-byte limit.`, {
        count: renamedEntries.length,
        reason: 'dBASE field names are at most 10 bytes, uppercase, and must be unique.',
        action: 'The original names are listed in the conversion manifest. Export to GeoPackage or GeoJSON to keep them intact.',
        detail: Object.fromEntries(renamedEntries.slice(0, 50)),
      })
    );
  }
  if (truncatedValues > 0) {
    warnings.push(
      warn('DBF_VALUES_TRUNCATED', `${truncatedValues} text value(s) exceed the 254-byte DBF limit and will be cut.`, {
        count: truncatedValues,
        reason: 'A dBASE character field cannot hold more than 254 bytes.',
        action: 'Export to GeoPackage, GeoJSON or CSV if the full text must be preserved.',
      })
    );
  }

  return { fields: plan, warnings, renames };
}

export function writeDbf(plan: DbfWritePlan, records: Record<string, unknown>[], encoding: 'utf-8' | 'iso-8859-1' = 'utf-8'): Uint8Array {
  const encoder = new TextEncoder();
  const fields = plan.fields;
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((sum, entry) => sum + entry.field.length, 0);
  const total = headerLength + records.length * recordLength + 1;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out[0] = 0x03; // dBASE III without a memo file
  const now = new Date();
  out[1] = now.getFullYear() - 1900;
  out[2] = now.getMonth() + 1;
  out[3] = now.getDate();
  view.setUint32(4, records.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  // 0x57 is the ANSI language driver; readers that ignore .cpg still get
  // something sane, and the .cpg file carries the authoritative answer.
  out[29] = encoding === 'utf-8' ? 0x00 : 0x57;

  let at = 32;
  for (const entry of fields) {
    const nameBytes = encoder.encode(entry.field.name.slice(0, 10));
    out.set(nameBytes.subarray(0, 10), at);
    out[at + 11] = entry.field.type.charCodeAt(0);
    out[at + 16] = entry.field.length;
    out[at + 17] = entry.field.decimals;
    at += 32;
  }
  out[at++] = 0x0d; // field terminator

  const textEncoder = encoding === 'utf-8' ? encoder : null;
  for (const record of records) {
    out[at++] = 0x20; // not deleted
    for (const entry of fields) {
      const value = record[entry.sourceName];
      const text = formatDbfValue(value, entry.field);
      const bytes = textEncoder ? textEncoder.encode(text) : latin1Bytes(text);
      const width = entry.field.length;
      // Numeric fields are right-aligned; character fields left-aligned. Getting
      // this wrong makes ArcGIS read every number as zero.
      if (entry.field.type === 'N' || entry.field.type === 'F') {
        const clipped = bytes.subarray(0, width);
        out.fill(0x20, at, at + width);
        out.set(clipped, at + width - clipped.length);
      } else {
        out.fill(0x20, at, at + width);
        out.set(bytes.subarray(0, width), at);
      }
      at += width;
    }
  }
  out[at] = 0x1a; // end-of-file marker
  return out;
}

function formatDbfValue(value: unknown, field: DbfField): string {
  if (value === null || value === undefined) return '';
  switch (field.type) {
    case 'N':
    case 'F': {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) return '';
      return field.decimals > 0 ? numeric.toFixed(field.decimals) : String(Math.round(numeric));
    }
    case 'L':
      return value === true ? 'T' : value === false ? 'F' : '';
    case 'D': {
      const text = String(value);
      const match = text.match(/(\d{4})-?(\d{2})-?(\d{2})/);
      return match ? `${match[1]}${match[2]}${match[3]}` : '';
    }
    default:
      return String(value);
  }
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    out[index] = code < 256 ? code : 0x3f; // '?' for anything outside Latin-1
  }
  return out;
}
