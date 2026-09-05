/**
 * Helpers shared by the format engines.
 *
 * Kept deliberately small: anything with format-specific knowledge belongs in
 * that format's engine, not here.
 */

import type { CirDataset, CirFeature, CirGeometry, FieldDef, Position, SourceInfo } from '../core/cir';
import { allFeatures } from '../core/cir';
import { hasZ } from '../core/geometry';

export function decodeText(bytes: Uint8Array, encoding = 'utf-8'): string {
  const text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
  // Strip the UTF-8 BOM; leaving it makes the first header cell of a CSV, or the
  // first group code of a DXF, silently not match.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function encodeText(text: string, withBom = false): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!withBom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}

export function sourceInfo(fileName: string, size: number, formatId: string, formatName: string, confidence = 1): SourceInfo {
  return { fileName, size, formatId, formatName, detectionConfidence: confidence };
}

/** XML text escape for the characters that break a document. */
export function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Derives the attribute schema from the features themselves.
 *
 * Field order follows first appearance rather than alphabetical order, so a
 * survey table exported and re-imported keeps its familiar column order. The
 * type widens to string as soon as a non-numeric value appears, which is what
 * DBF and XLSX writers need to size their columns.
 */
export function deriveFields(features: CirFeature[]): FieldDef[] {
  const fields = new Map<string, FieldDef>();
  for (const feature of features) {
    for (const [name, value] of Object.entries(feature.properties ?? {})) {
      const existing = fields.get(name);
      const type = inferType(value);
      if (!existing) {
        fields.set(name, { name, type, width: measureWidth(value) });
        continue;
      }
      if (existing.type !== type && type !== 'string' && existing.type !== 'string') existing.type = 'number';
      else if (existing.type !== type) existing.type = 'string';
      existing.width = Math.max(existing.width ?? 0, measureWidth(value));
    }
  }
  return [...fields.values()];
}

function inferType(value: unknown): FieldDef['type'] {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    // Strings that are entirely numeric still come back as text: a point code
    // like "007" loses its leading zeros the moment it becomes a number.
    return 'string';
  }
  return 'string';
}

function measureWidth(value: unknown): number {
  if (value == null) return 0;
  return String(value).length;
}

export function datasetHasZ(dataset: CirDataset): boolean {
  return allFeatures(dataset).some((feature) => hasZ(feature.geometry));
}

/** Flattens a geometry into the individual parts a single-geometry writer needs. */
export function explodeGeometry(geometry: CirGeometry | null): CirGeometry[] {
  if (!geometry) return [];
  switch (geometry.type) {
    case 'MultiPoint':
      return (geometry.coordinates as Position[]).map((coordinates) => ({ type: 'Point', coordinates, dimension: geometry.dimension }));
    case 'MultiLineString':
      return (geometry.coordinates as Position[][]).map((coordinates) => ({
        type: 'LineString',
        coordinates,
        dimension: geometry.dimension,
      }));
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).map((coordinates) => ({
        type: 'Polygon',
        coordinates,
        dimension: geometry.dimension,
      }));
    case 'GeometryCollection':
      return (geometry.geometries ?? []).flatMap((child) => explodeGeometry(child));
    default:
      return [geometry];
  }
}

/** Dimension implied by the deepest position seen — 2, 3 or 4. */
export function inferDimension(positions: Position[]): 2 | 3 | 4 {
  let dimension: 2 | 3 | 4 = 2;
  for (const position of positions) {
    if (position.length >= 4) return 4;
    if (position.length === 3) dimension = 3;
  }
  return dimension;
}

/** Parses a number, returning null rather than NaN so callers must handle it. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
