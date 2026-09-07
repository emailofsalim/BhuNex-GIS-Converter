/**
 * Label and attribute burn-in (spec §27).
 *
 * THE PROBLEM. A cadastral DXF holds plot boundaries on one layer and plot
 * numbers as TEXT or MTEXT on another. Nothing links them: the association is
 * spatial and implicit, obvious to a person looking at the drawing and invisible
 * to every format the boundaries are exported to. Converted naively, the
 * polygons arrive unlabelled and the text arrives as a scatter of detached
 * points — which is why CAD-to-GIS cadastral conversion is normally redone by
 * hand, plot by plot.
 *
 * This module makes the implicit link explicit: for each polygon, find the text
 * inside it and attach it as an attribute, a label, or an annotation feature.
 *
 * Two rules it will not bend:
 *
 *  - THE SOURCE SURVIVES. The original text or point is never deleted unless
 *    the caller explicitly asks for `replaceSource`. Burn-in is additive; a user
 *    who wanted a copy must not lose the original (R17).
 *  - AMBIGUITY IS REPORTED, NOT RESOLVED SILENTLY. When three text entities fall
 *    inside one parcel, the rule that picked one is named in the result and the
 *    rejected candidates are listed. A wrong plot number attached confidently is
 *    far worse than one the user was asked about.
 */

import type { CirDataset, CirFeature, CirLayer, Position } from '../core/cir';
import { geometryBounds, pointInRing } from '../core/geometry';
import { SpatialIndex, type IndexedItem } from '../core/spatial-index';
import { labelAnchor } from './label-placement';

export type BurnInMode = 'attribute' | 'label' | 'geometry' | 'cad' | 'kml';

export const BURN_IN_MODE_LABEL: Record<BurnInMode, string> = {
  attribute: 'Attribute burn-in',
  label: 'Label burn-in',
  geometry: 'Geometry burn-in',
  cad: 'CAD annotation burn-in',
  kml: 'KML name and description',
};

export const BURN_IN_MODE_DESCRIPTION: Record<BurnInMode, string> = {
  attribute: 'The text becomes a field on the polygon, so it survives into any format with an attribute table.',
  label: 'The text is bound to the polygon as a label, positioned at the interior point furthest from any edge.',
  geometry: 'A permanent text feature is created inside the polygon, so formats without labels still carry it visibly.',
  cad: 'The text becomes CAD annotation on the polygon layer, keeping the drawing readable when it goes back to CAD.',
  kml: 'The text becomes the placemark name, so Google Earth shows it without further styling.',
};

/** How to choose when several candidates fall inside one polygon. */
export type BurnInPriority = 'nearest-to-centre' | 'largest-text' | 'first-found' | 'concatenate' | 'named-field';

export const PRIORITY_LABEL: Record<BurnInPriority, string> = {
  'nearest-to-centre': 'Nearest to the polygon centre',
  'largest-text': 'Largest text',
  'first-found': 'First found',
  concatenate: 'Join them all together',
  'named-field': 'From a named field',
};

export interface BurnInOptions {
  mode: BurnInMode;
  /** Layer holding the polygons. */
  targetLayer: string;
  /** Layers to take text and points from. Empty means every other layer. */
  sourceLayers: string[];
  /** Field the burnt-in value is written to. */
  fieldName: string;
  /** Which property of the source feature carries the text. */
  sourceField: string;
  priority: BurnInPriority;
  /** Separator when `priority` is 'concatenate'. */
  separator: string;
  /**
   * Remove the source text once it has been burnt in.
   *
   * Off by default and never implied. The whole point of burn-in is to make an
   * association explicit, not to destroy the evidence it was drawn from (R17).
   */
  replaceSource: boolean;
  /** Overwrite a value the polygon already has in `fieldName`. */
  overwriteExisting: boolean;
  /** Text height for placement, in dataset units, when the source has none. */
  defaultTextHeight: number;
}

export const DEFAULT_BURN_IN_OPTIONS: BurnInOptions = {
  mode: 'attribute',
  targetLayer: '',
  sourceLayers: [],
  fieldName: 'label',
  sourceField: 'text',
  priority: 'nearest-to-centre',
  separator: ' / ',
  replaceSource: false,
  overwriteExisting: false,
  defaultTextHeight: 2.5,
};

export interface BurnInMatch {
  polygonId: string | number | undefined;
  /** The value that was attached. */
  value: string;
  /** Where it came from. */
  sourceLayer: string;
  sourceId: string | number | undefined;
  /** Other candidates inside the same polygon that were not chosen. */
  rejected: { sourceId: string | number | undefined; value: string; reason: string }[];
  /** Where a label or annotation was placed, when the mode creates one. */
  placedAt?: Position;
}

export interface BurnInReport {
  matched: BurnInMatch[];
  /** Polygons with no candidate inside them. */
  unmatched: (string | number | undefined)[];
  /** Text that fell inside no polygon at all. */
  orphanText: { sourceLayer: string; sourceId: string | number | undefined; value: string; at: Position }[];
  /** Polygons skipped because they already held a value. */
  skippedExisting: (string | number | undefined)[];
  ambiguous: number;
}

export interface BurnInResult {
  dataset: CirDataset;
  report: BurnInReport;
}

interface TextCandidate {
  feature: CirFeature;
  layer: string;
  at: Position;
  value: string;
  height: number;
}

/**
 * The CAD entities that carry text worth burning in.
 *
 * A POINT with a description is included: survey point codes are how plot
 * numbers arrive from a total station, and excluding them would miss the most
 * common case outside CAD entirely.
 */
const TEXT_ENTITIES = new Set(['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF', 'INSERT', 'POINT']);

/**
 * Property names that commonly hold the text, in the order worth trying.
 *
 * The underscore-prefixed names come first because they are what this project's
 * own DXF reader writes (`_text` for TEXT and MTEXT contents). A burn-in engine
 * that only understood the GIS-style names would find nothing at all in the CAD
 * files it exists to handle.
 */
const TEXT_PROPERTY_ORDER = [
  '_text',
  'text',
  '_label',
  'label',
  'name',
  'value',
  'string',
  'contents',
  'description',
  'code',
  'plot_no',
];

/** Property names carrying the text height, in the same spirit. */
const HEIGHT_PROPERTY_ORDER = ['_textHeight', 'height', 'text_height', 'size'];

function textOf(feature: CirFeature, preferred: string): string | null {
  const properties = feature.properties ?? {};
  const direct = properties[preferred];
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  if (typeof direct === 'number') return String(direct);
  for (const key of TEXT_PROPERTY_ORDER) {
    const value = properties[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function anchorOf(feature: CirFeature): Position | null {
  const geometry = feature.geometry;
  if (!geometry) return null;
  if (geometry.type === 'Point') return geometry.coordinates as Position;
  if (geometry.type === 'MultiPoint') return (geometry.coordinates as Position[])[0] ?? null;
  // A text entity read as a tiny line or polygon still has a position; the
  // first vertex is where CAD placed the insertion point.
  const bounds = geometryBounds(geometry);
  if (!Number.isFinite(bounds.minX)) return null;
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

function ringsOf(feature: CirFeature): Position[][][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates as Position[][]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as Position[][][];
  return [];
}

/** True when the position is inside the polygon and outside all of its holes. */
function containsPoint(polygons: Position[][][], point: Position): boolean {
  for (const polygon of polygons) {
    const [shell, ...holes] = polygon;
    if (!shell || !pointInRing(point, shell)) continue;
    if (holes.some((hole) => pointInRing(point, hole))) continue;
    return true;
  }
  return false;
}

function collectCandidates(dataset: CirDataset, options: BurnInOptions): TextCandidate[] {
  const wanted = new Set(options.sourceLayers);
  const candidates: TextCandidate[] = [];

  for (const layer of dataset.layers) {
    if (layer.name === options.targetLayer) continue;
    if (wanted.size > 0 && !wanted.has(layer.name)) continue;

    for (const feature of layer.features) {
      const geometry = feature.geometry;
      if (!geometry) continue;
      // Only point-like features and CAD text entities are candidates; a
      // neighbouring parcel polygon is not a label for this one.
      const isPointLike = geometry.type === 'Point' || geometry.type === 'MultiPoint';
      const isTextEntity = feature.sourceEntity ? TEXT_ENTITIES.has(feature.sourceEntity) : false;
      if (!isPointLike && !isTextEntity) continue;

      const value = textOf(feature, options.sourceField);
      const at = anchorOf(feature);
      if (!value || !at) continue;

      let height = options.defaultTextHeight;
      for (const key of HEIGHT_PROPERTY_ORDER) {
        const value = feature.properties?.[key];
        if (typeof value === 'number' && value > 0) {
          height = value;
          break;
        }
      }
      candidates.push({ feature, layer: layer.name, at, value, height });
    }
  }

  return candidates;
}

/**
 * Chooses among several candidates inside one polygon.
 *
 * Returns the winner and the reason each loser was rejected, so the result can
 * explain itself. Every priority is deterministic: the same input must always
 * give the same plot number.
 */
function choose(
  candidates: TextCandidate[],
  centre: Position,
  options: BurnInOptions
): { value: string; winner: TextCandidate; rejected: BurnInMatch['rejected'] } {
  if (candidates.length === 1) return { value: candidates[0].value, winner: candidates[0], rejected: [] };

  const reject = (entry: TextCandidate, reason: string) => ({ sourceId: entry.feature.id, value: entry.value, reason });

  switch (options.priority) {
    case 'concatenate': {
      // Sorted so the joined string does not depend on read order.
      const sorted = [...candidates].sort((left, right) => left.value.localeCompare(right.value));
      return {
        value: sorted.map((entry) => entry.value).join(options.separator),
        winner: sorted[0],
        rejected: [],
      };
    }
    case 'largest-text': {
      const sorted = [...candidates].sort((left, right) => right.height - left.height || left.value.localeCompare(right.value));
      return {
        value: sorted[0].value,
        winner: sorted[0],
        rejected: sorted.slice(1).map((entry) => reject(entry, `Smaller text (${entry.height} vs ${sorted[0].height}).`)),
      };
    }
    case 'first-found':
      return {
        value: candidates[0].value,
        winner: candidates[0],
        rejected: candidates.slice(1).map((entry) => reject(entry, 'A candidate was found before this one.')),
      };
    case 'named-field': {
      const named = candidates.filter((entry) => typeof entry.feature.properties?.[options.sourceField] === 'string');
      const pool = named.length > 0 ? named : candidates;
      return {
        value: pool[0].value,
        winner: pool[0],
        rejected: candidates.filter((entry) => entry !== pool[0]).map((entry) => reject(entry, `Does not carry the field "${options.sourceField}".`)),
      };
    }
    case 'nearest-to-centre':
    default: {
      const distance = (entry: TextCandidate) => Math.hypot(entry.at[0] - centre[0], entry.at[1] - centre[1]);
      const sorted = [...candidates].sort((left, right) => distance(left) - distance(right) || left.value.localeCompare(right.value));
      return {
        value: sorted[0].value,
        winner: sorted[0],
        rejected: sorted
          .slice(1)
          .map((entry) => reject(entry, `Further from the polygon centre (${distance(entry).toFixed(2)} vs ${distance(sorted[0]).toFixed(2)} units).`)),
      };
    }
  }
}

/**
 * Burns text found inside polygons onto those polygons.
 *
 * Returns a new dataset; the input is not modified.
 */
export function burnIn(dataset: CirDataset, options: Partial<BurnInOptions> = {}): BurnInResult {
  const settings = { ...DEFAULT_BURN_IN_OPTIONS, ...options };
  const report: BurnInReport = { matched: [], unmatched: [], orphanText: [], skippedExisting: [], ambiguous: 0 };

  const targetLayer = dataset.layers.find((layer) => layer.name === settings.targetLayer);
  if (!targetLayer) return { dataset, report };

  const candidates = collectCandidates(dataset, settings);
  if (candidates.length === 0) {
    report.unmatched = targetLayer.features.map((feature) => feature.id);
    return { dataset, report };
  }

  // Index the polygons and probe with each text position, rather than the other
  // way round: there are usually far more text entities than parcels, and this
  // way each text is located in one query.
  const polygons = targetLayer.features
    .map((feature, index) => ({ feature, index, polygons: ringsOf(feature) }))
    .filter((entry) => entry.polygons.length > 0);

  const index = new SpatialIndex(
    polygons.map((entry): IndexedItem<(typeof polygons)[number]> => ({ bounds: geometryBounds(entry.feature.geometry), value: entry }))
  );

  const byPolygon = new Map<number, TextCandidate[]>();
  const consumed = new Set<CirFeature>();

  for (const candidate of candidates) {
    let placed = false;
    for (const hit of index.search({ minX: candidate.at[0], minY: candidate.at[1], maxX: candidate.at[0], maxY: candidate.at[1] })) {
      const entry = index.item(hit).value;
      if (!containsPoint(entry.polygons, candidate.at)) continue;
      const list = byPolygon.get(entry.index) ?? [];
      list.push(candidate);
      byPolygon.set(entry.index, list);
      placed = true;
      break;
    }
    if (!placed) {
      report.orphanText.push({ sourceLayer: candidate.layer, sourceId: candidate.feature.id, value: candidate.value, at: candidate.at });
    }
  }

  const annotations: CirFeature[] = [];

  const features = targetLayer.features.map((feature, featureIndex) => {
    const inside = byPolygon.get(featureIndex);
    if (!inside || inside.length === 0) {
      report.unmatched.push(feature.id);
      return feature;
    }

    const existing = feature.properties?.[settings.fieldName];
    if (!settings.overwriteExisting && typeof existing === 'string' && existing.trim() !== '') {
      report.skippedExisting.push(feature.id);
      return feature;
    }

    const rings = ringsOf(feature)[0] ?? [];
    const anchor = rings.length > 0 ? labelAnchor(rings) : null;
    const centre = anchor?.position ?? inside[0].at;
    const { value, winner, rejected } = choose(inside, centre, settings);
    if (inside.length > 1) report.ambiguous++;

    report.matched.push({
      polygonId: feature.id,
      value,
      sourceLayer: winner.layer,
      sourceId: winner.feature.id,
      rejected,
      placedAt: anchor?.position,
    });

    if (settings.replaceSource) for (const entry of inside) consumed.add(entry.feature);

    const properties = { ...feature.properties, [settings.fieldName]: value };

    switch (settings.mode) {
      case 'kml':
        // KML shows the placemark name without any styling, so writing `name`
        // is what actually makes the label visible in Google Earth.
        properties.name = value;
        break;
      case 'label':
        if (anchor) {
          properties._label = value;
          properties._label_x = anchor.position[0];
          properties._label_y = anchor.position[1];
          properties._label_rotation = anchor.rotation;
        }
        break;
      case 'cad':
        // Written back to CAD as annotation on the polygon's own layer.
        properties._annotation = value;
        properties._annotation_layer = feature.properties?._layer ?? targetLayer.name;
        break;
      case 'geometry':
        if (anchor) {
          annotations.push({
            id: `${feature.id ?? featureIndex}-label`,
            geometry: { type: 'Point', coordinates: anchor.position, dimension: 2 },
            properties: { text: value, rotation: anchor.rotation, height: winner.height, _label_for: feature.id ?? featureIndex },
            sourceEntity: 'TEXT',
            sourceLayer: targetLayer.name,
          });
        }
        break;
      default:
        break;
    }

    return { ...feature, properties };
  });

  // Rebuild the layer set: the target gains its values, source layers lose only
  // what was explicitly consumed, and geometry mode adds an annotation layer.
  const layers: CirLayer[] = dataset.layers.map((layer) => {
    if (layer.name === settings.targetLayer) {
      const fields = layer.fields.some((field) => field.name === settings.fieldName)
        ? layer.fields
        : [...layer.fields, { name: settings.fieldName, type: 'string' as const }];
      return { ...layer, features, fields };
    }
    if (consumed.size === 0) return layer;
    const kept = layer.features.filter((feature) => !consumed.has(feature));
    return kept.length === layer.features.length ? layer : { ...layer, features: kept };
  });

  if (annotations.length > 0) {
    layers.push({
      name: `${targetLayer.name} labels`,
      path: [...targetLayer.path, 'labels'],
      features: annotations,
      fields: [
        { name: 'text', type: 'string' },
        { name: 'rotation', type: 'number' },
        { name: 'height', type: 'number' },
      ],
      geometryTypes: ['Point'],
    });
  }

  return { dataset: { ...dataset, layers }, report };
}

/** One-line summary of a burn-in, for the log and a confirmation prompt. */
export function describeBurnIn(report: BurnInReport, options: BurnInOptions): string {
  const parts = [`${BURN_IN_MODE_LABEL[options.mode]}: ${report.matched.length} polygon(s) labelled`];
  if (report.ambiguous > 0) parts.push(`${report.ambiguous} had several candidates, resolved by "${PRIORITY_LABEL[options.priority]}"`);
  if (report.unmatched.length > 0) parts.push(`${report.unmatched.length} found no text inside`);
  if (report.orphanText.length > 0) parts.push(`${report.orphanText.length} text item(s) fell outside every polygon`);
  if (report.skippedExisting.length > 0) parts.push(`${report.skippedExisting.length} already had a value and were left alone`);
  return `${parts.join('; ')}.`;
}

/**
 * Reports what a burn-in would do, without doing it.
 *
 * Same code path as `burnIn` — the preview runs the operation and throws the
 * dataset away — so the preview cannot describe something the apply would not
 * do (the same discipline as `qa/repair.ts`).
 */
export function previewBurnIn(dataset: CirDataset, options: Partial<BurnInOptions> = {}): BurnInReport {
  return burnIn(dataset, options).report;
}
