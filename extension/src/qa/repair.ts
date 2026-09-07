/**
 * Preview-and-apply geometry repair (spec §24, rules R18 and R19).
 *
 * `topology.ts` already repairs, but only as part of a conversion: switch an
 * option on, and the pipeline applies it. That is the wrong shape for editing.
 * A surveyor deciding whether to close a ring needs to see *what* would change
 * and *by how much* first, apply it to one feature rather than to the whole
 * layer, and be able to undo it.
 *
 * So every operation here is split in two:
 *
 *   plan(dataset, operation, scope) -> RepairPlan   nothing is modified
 *   applyPlan(dataset, plan)        -> RepairResult new dataset + inverse
 *
 * The plan is inspectable — every change lists the feature, the position and
 * the distance moved — and the result carries an inverse plan, so undo is not a
 * snapshot of the whole dataset but a description of how to get back. On a
 * 400,000-feature layer that difference is the difference between undo working
 * and undo running the tab out of memory.
 *
 * Nothing in this module is applied automatically. `fixSafeIssues` exists
 * because the master document asks for it (§52), and it is restricted to
 * changes that are reversible and cannot move a boundary: it will not touch a
 * ring closure larger than a stated tolerance, and it will not run at all on a
 * layer the caller marks as legally operative.
 */

import { closeRing, isClockwise, removeDuplicateVertices } from '../core/geometry';
import type { CirDataset, CirFeature, CirLayer, Position } from '../core/cir';

export type RepairOperationId =
  | 'close-rings'
  | 'remove-duplicate-vertices'
  | 'remove-zero-length-segments'
  | 'fix-ring-orientation'
  | 'remove-spikes'
  | 'snap-vertices';

export const REPAIR_LABEL: Record<RepairOperationId, string> = {
  'close-rings': 'Close open rings',
  'remove-duplicate-vertices': 'Remove duplicate vertices',
  'remove-zero-length-segments': 'Remove zero-length segments',
  'fix-ring-orientation': 'Fix ring direction',
  'remove-spikes': 'Remove spikes',
  'snap-vertices': 'Snap nearby vertices together',
};

/**
 * Operations that cannot move a boundary by more than the tolerance and can be
 * undone exactly. Only these are eligible for "fix all safe issues" (§52).
 *
 * `snap-vertices` is deliberately absent: snapping moves survey positions, and
 * on cadastral data that is a legal act, not a tidy-up.
 */
export const SAFE_OPERATIONS: RepairOperationId[] = [
  'close-rings',
  'remove-duplicate-vertices',
  'remove-zero-length-segments',
  'fix-ring-orientation',
];

export interface RepairScope {
  /** Restrict to one layer. Absent means every layer. */
  layer?: string;
  /** Restrict to these features within the layer. Absent means all of them. */
  featureIds?: (string | number)[];
}

export interface RepairOptions {
  /** Distance below which two vertices are the same point, in dataset units. */
  tolerance: number;
  /** Interior angle in degrees below which a vertex counts as a spike. */
  spikeAngleDegrees: number;
  /**
   * Refuse to change geometry in these layers.
   *
   * Cadastral and lease boundaries are legally operative: a repair that moves
   * one is a change to a title, not a data fix (R18). Named layers are reported
   * as refused rather than quietly skipped.
   */
  protectedLayers: string[];
  /** Largest ring gap that "fix safe issues" will close without asking. */
  maxSafeClosureGap: number;
}

export const DEFAULT_REPAIR_SETTINGS: RepairOptions = {
  tolerance: 0.001,
  spikeAngleDegrees: 5,
  protectedLayers: [],
  maxSafeClosureGap: 0.05,
};

/** One concrete change the plan would make, in terms a person can check. */
export interface RepairChange {
  layer: string;
  featureId?: string | number;
  /** Where the change happens. */
  location?: Position;
  /** What changes, in one sentence with the measured quantity in it. */
  description: string;
  /** Largest distance any position moves. 0 for a change that moves nothing. */
  maxDisplacement: number;
}

export interface RepairPlan {
  operation: RepairOperationId;
  scope: RepairScope;
  options: RepairOptions;
  changes: RepairChange[];
  /** Layers skipped because they are protected, with the count of features. */
  refused: { layer: string; featureCount: number; reason: string }[];
  /** Largest distance any position would move across the whole plan. */
  maxDisplacement: number;
}

export interface RepairResult {
  dataset: CirDataset;
  plan: RepairPlan;
  /** Applying this restores the previous geometry exactly. */
  undo: UndoRecord;
}

/**
 * Undo as a diff, not a snapshot.
 *
 * Only the features that actually changed are held, each as its geometry
 * before the edit. A layer of 400,000 contours where one ring was closed costs
 * one stored geometry, not 400,000.
 */
export interface UndoRecord {
  label: string;
  entries: { layer: string; featureIndex: number; geometry: CirFeature['geometry'] }[];
}

function inScope(layer: CirLayer, feature: CirFeature, scope: RepairScope): boolean {
  if (scope.layer && layer.name !== scope.layer) return false;
  if (scope.featureIds && scope.featureIds.length > 0) {
    return scope.featureIds.some((id) => String(id) === String(feature.id));
  }
  return true;
}

function distance(left: Position, right: Position): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

/** Rewrites every ring and line of a geometry through `transform`. */
function mapPaths(geometry: CirFeature['geometry'], transform: (path: Position[], isExterior: boolean, closed: boolean) => Position[]): CirFeature['geometry'] {
  if (!geometry) return geometry;
  switch (geometry.type) {
    case 'LineString':
      return { ...geometry, coordinates: transform(geometry.coordinates as Position[], true, false) };
    case 'MultiLineString':
      return { ...geometry, coordinates: (geometry.coordinates as Position[][]).map((line) => transform(line, true, false)) };
    case 'Polygon':
      return { ...geometry, coordinates: (geometry.coordinates as Position[][]).map((ring, index) => transform(ring, index === 0, true)) };
    case 'MultiPolygon':
      return {
        ...geometry,
        coordinates: (geometry.coordinates as Position[][][]).map((polygon) =>
          polygon.map((ring, index) => transform(ring, index === 0, true))
        ),
      };
    default:
      return geometry;
  }
}

/**
 * Works out what an operation would change, without changing anything.
 *
 * The plan and the apply share `rewrite` below, so what the preview shows and
 * what the apply does cannot drift apart — the classic way a preview feature
 * becomes a lie.
 */
export function planRepair(
  dataset: CirDataset,
  operation: RepairOperationId,
  scope: RepairScope = {},
  options: Partial<RepairOptions> = {}
): RepairPlan {
  const settings = { ...DEFAULT_REPAIR_SETTINGS, ...options };
  const changes: RepairChange[] = [];
  const refused: RepairPlan['refused'] = [];
  let maxDisplacement = 0;

  for (const layer of dataset.layers) {
    if (scope.layer && layer.name !== scope.layer) continue;
    if (settings.protectedLayers.includes(layer.name)) {
      const count = layer.features.filter((feature) => inScope(layer, feature, scope)).length;
      if (count > 0) {
        refused.push({
          layer: layer.name,
          featureCount: count,
          reason: 'Layer is marked legally operative, so its geometry is not changed by an automated repair.',
        });
      }
      continue;
    }

    for (const feature of layer.features) {
      if (!inScope(layer, feature, scope)) continue;
      const rewritten = rewrite(feature, operation, settings);
      if (!rewritten) continue;
      changes.push(...rewritten.changes.map((change) => ({ ...change, layer: layer.name, featureId: feature.id })));
      if (rewritten.maxDisplacement > maxDisplacement) maxDisplacement = rewritten.maxDisplacement;
    }
  }

  return { operation, scope, options: settings, changes, refused, maxDisplacement };
}

/** Applies a plan, returning a new dataset and the record that reverses it. */
export function applyRepair(
  dataset: CirDataset,
  operation: RepairOperationId,
  scope: RepairScope = {},
  options: Partial<RepairOptions> = {}
): RepairResult {
  const settings = { ...DEFAULT_REPAIR_SETTINGS, ...options };
  const plan = planRepair(dataset, operation, scope, settings);
  const undo: UndoRecord = { label: REPAIR_LABEL[operation], entries: [] };

  const layers = dataset.layers.map((layer) => {
    if (scope.layer && layer.name !== scope.layer) return layer;
    if (settings.protectedLayers.includes(layer.name)) return layer;

    let touched = false;
    const features = layer.features.map((feature, featureIndex) => {
      if (!inScope(layer, feature, scope)) return feature;
      const rewritten = rewrite(feature, operation, settings);
      if (!rewritten || rewritten.changes.length === 0) return feature;
      touched = true;
      undo.entries.push({ layer: layer.name, featureIndex, geometry: feature.geometry });
      return { ...feature, geometry: rewritten.geometry };
    });

    return touched ? { ...layer, features } : layer;
  });

  return { dataset: { ...dataset, layers }, plan, undo };
}

/** Restores the geometry an undo record captured. Exact, not approximate. */
export function undoRepair(dataset: CirDataset, record: UndoRecord): CirDataset {
  const byLayer = new Map<string, Map<number, CirFeature['geometry']>>();
  for (const entry of record.entries) {
    const existing = byLayer.get(entry.layer) ?? new Map();
    existing.set(entry.featureIndex, entry.geometry);
    byLayer.set(entry.layer, existing);
  }

  const layers = dataset.layers.map((layer) => {
    const restore = byLayer.get(layer.name);
    if (!restore) return layer;
    const features = layer.features.map((feature, index) =>
      restore.has(index) ? { ...feature, geometry: restore.get(index)! } : feature
    );
    return { ...layer, features };
  });

  return { ...dataset, layers };
}

interface Rewrite {
  geometry: CirFeature['geometry'];
  changes: Omit<RepairChange, 'layer' | 'featureId'>[];
  maxDisplacement: number;
}

/**
 * The single implementation of every operation.
 *
 * Both `planRepair` and `applyRepair` call this: the preview is literally the
 * apply, run without keeping the result. There is no second code path that
 * could describe one thing and do another.
 */
function rewrite(feature: CirFeature, operation: RepairOperationId, settings: RepairOptions): Rewrite | null {
  if (!feature.geometry) return null;
  const changes: Omit<RepairChange, 'layer' | 'featureId'>[] = [];
  let maxDisplacement = 0;

  const geometry = mapPaths(feature.geometry, (path, isExterior, closed) => {
    switch (operation) {
      case 'close-rings': {
        if (!closed || path.length < 3) return path;
        const gap = distance(path[0], path[path.length - 1]);
        if (gap === 0) return path;
        changes.push({
          location: path[path.length - 1],
          description: `Ring closed: the last vertex moves ${gap.toFixed(4)} units to meet the first.`,
          maxDisplacement: gap,
        });
        if (gap > maxDisplacement) maxDisplacement = gap;
        return closeRing(path);
      }

      case 'remove-duplicate-vertices':
      case 'remove-zero-length-segments': {
        // A zero-length segment IS a pair of duplicate vertices; the two
        // operations differ only in the tolerance they use, so they share code
        // rather than drifting apart.
        const tolerance = operation === 'remove-zero-length-segments' ? 0 : settings.tolerance;
        const cleaned = removeDuplicateVertices(path, tolerance);
        const removed = path.length - cleaned.length;
        if (removed === 0) return path;
        changes.push({
          location: path[0],
          description: `${removed} duplicate vert${removed === 1 ? 'ex' : 'ices'} removed (within ${tolerance} units). No position moves.`,
          maxDisplacement: 0,
        });
        return cleaned;
      }

      case 'fix-ring-orientation': {
        if (!closed || path.length < 4) return path;
        // RFC 7946: exterior counter-clockwise, interior clockwise.
        const wantClockwise = !isExterior;
        if (isClockwise(path) === wantClockwise) return path;
        changes.push({
          location: path[0],
          description: `Ring direction reversed to ${wantClockwise ? 'clockwise (interior)' : 'counter-clockwise (exterior)'}. Vertices keep their positions.`,
          maxDisplacement: 0,
        });
        return [...path].reverse();
      }

      case 'remove-spikes': {
        const threshold = (settings.spikeAngleDegrees * Math.PI) / 180;
        const kept: Position[] = [];
        let removed = 0;
        let firstSpike: Position | undefined;

        for (let index = 0; index < path.length; index++) {
          const previous = kept[kept.length - 1] ?? path[index === 0 ? path.length - 1 : index - 1];
          const next = path[index + 1] ?? path[0];
          const vertex = path[index];
          if (index === 0 || index === path.length - 1) {
            kept.push(vertex);
            continue;
          }
          const incoming = [vertex[0] - previous[0], vertex[1] - previous[1]];
          const outgoing = [next[0] - vertex[0], next[1] - vertex[1]];
          const inLength = Math.hypot(incoming[0], incoming[1]);
          const outLength = Math.hypot(outgoing[0], outgoing[1]);
          if (inLength === 0 || outLength === 0) {
            kept.push(vertex);
            continue;
          }
          const cosine = (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / (inLength * outLength);
          const interior = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosine)));
          if (interior < threshold) {
            removed++;
            firstSpike ??= vertex;
            continue;
          }
          kept.push(vertex);
        }

        if (removed === 0) return path;
        changes.push({
          location: firstSpike,
          description: `${removed} spike vert${removed === 1 ? 'ex' : 'ices'} removed (interior angle below ${settings.spikeAngleDegrees}°).`,
          maxDisplacement: 0,
        });
        return kept;
      }

      case 'snap-vertices': {
        // Snapping within one feature: collapse vertices closer than the
        // tolerance onto the first of the group. Cross-feature snapping is a
        // different operation and belongs with the editor, not here.
        const snapped: Position[] = [];
        let moved = 0;
        let largest = 0;
        for (const position of path) {
          const anchor = snapped.find((candidate) => distance(candidate, position) <= settings.tolerance);
          if (anchor) {
            const shift = distance(anchor, position);
            if (shift > 0) {
              moved++;
              if (shift > largest) largest = shift;
            }
            continue;
          }
          snapped.push(position);
        }
        if (moved === 0) return path;
        changes.push({
          location: path[0],
          description: `${moved} vert${moved === 1 ? 'ex' : 'ices'} snapped together; the largest move is ${largest.toFixed(4)} units.`,
          maxDisplacement: largest,
        });
        if (largest > maxDisplacement) maxDisplacement = largest;
        return snapped;
      }

      default:
        return path;
    }
  });

  if (changes.length === 0) return null;
  return { geometry, changes, maxDisplacement };
}

export interface SafeFixResult {
  dataset: CirDataset;
  applied: { operation: RepairOperationId; changes: number }[];
  /** Operations or features deliberately not touched, each with a reason. */
  skipped: { operation: RepairOperationId; reason: string }[];
  undo: UndoRecord[];
}

/**
 * "Fix all safe issues" (spec §52).
 *
 * Safe means two things at once: reversible, and incapable of moving a boundary
 * beyond a stated tolerance. Ring closure qualifies only when the gap is small
 * enough to be a digitising slip rather than an open boundary — a ring left
 * half a metre open is a question for the surveyor, not something to quietly
 * shut.
 *
 * Snapping is never included, and protected layers are never touched (R18).
 */
export function fixSafeIssues(dataset: CirDataset, scope: RepairScope = {}, options: Partial<RepairOptions> = {}): SafeFixResult {
  const settings = { ...DEFAULT_REPAIR_SETTINGS, ...options };
  const applied: SafeFixResult['applied'] = [];
  const skipped: SafeFixResult['skipped'] = [];
  const undo: UndoRecord[] = [];
  let current = dataset;

  for (const operation of SAFE_OPERATIONS) {
    const preview = planRepair(current, operation, scope, settings);
    if (preview.changes.length === 0) continue;

    if (operation === 'close-rings' && preview.maxDisplacement > settings.maxSafeClosureGap) {
      skipped.push({
        operation,
        reason: `The largest ring gap is ${preview.maxDisplacement.toFixed(4)} units, beyond the ${settings.maxSafeClosureGap} safe limit. A gap that size may be a genuinely open boundary — close it deliberately, not automatically.`,
      });
      continue;
    }

    const result = applyRepair(current, operation, scope, settings);
    current = result.dataset;
    applied.push({ operation, changes: result.plan.changes.length });
    undo.push(result.undo);
  }

  return { dataset: current, applied, skipped, undo };
}

/** Describes a plan in one line, for a confirmation prompt or a log entry. */
export function describePlan(plan: RepairPlan): string {
  if (plan.changes.length === 0) return `${REPAIR_LABEL[plan.operation]}: nothing to change.`;
  const displacement =
    plan.maxDisplacement > 0 ? ` The largest position moves ${plan.maxDisplacement.toFixed(4)} units.` : ' No position moves.';
  const refused = plan.refused.length > 0 ? ` ${plan.refused.length} protected layer(s) were not touched.` : '';
  return `${REPAIR_LABEL[plan.operation]}: ${plan.changes.length} change(s).${displacement}${refused}`;
}
