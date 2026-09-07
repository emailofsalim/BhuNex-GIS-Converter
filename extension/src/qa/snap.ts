/**
 * Snapping (spec §25.2).
 *
 * Snap to vertex, segment, intersection and grid — and, the one that matters
 * most here, SHARED EDGE:
 *
 *   "Shared-edge snap MUST be applicable to a single boundary between two
 *    parcels without moving anything else — the case cadastral work actually
 *    needs."
 *
 * That sentence rules out the implementation everybody writes first. The usual
 * approach snaps every vertex within tolerance of every other vertex, which
 * closes the gap between two parcels and also silently drags a road centreline,
 * a building corner and a survey monument that happened to be nearby. On
 * cadastral data that is not a tidy-up; a boundary is the legal object, and
 * moving one that nobody asked about is the failure R18 exists to prevent.
 *
 * So this module works the other way round: NOTHING MOVES UNLESS IT IS NAMED.
 * A shared-edge snap takes two features and moves the vertices of the boundary
 * they share, leaving every other vertex of both — and every other feature in
 * the dataset — untouched. The plan says exactly which vertices it would move
 * and by how far before anything happens.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 *
 * The same plan → apply → undo shape as `qa/repair.ts`, deliberately, so the UI
 * has one preview-and-commit flow rather than two that behave almost alike.
 * `planSnap` computes without changing; `applySnap` calls the same code and
 * keeps the result; the `UndoRecord` reverses it exactly.
 *
 * Every operation reports its MAXIMUM DISPLACEMENT. On survey data the question
 * is never "did it snap" but "how far did you move my boundary", and a tool
 * that cannot answer that in the data's own units has not earned the right to
 * move anything (R21).
 */

import type { CirDataset, CirFeature, Position } from '../core/cir';
import type { UndoRecord } from './repair';

export type SnapMode = 'vertex' | 'segment' | 'intersection' | 'grid' | 'shared-edge';

export const SNAP_MODE_LABEL: Record<SnapMode, string> = {
  vertex: 'Snap to vertex',
  segment: 'Snap to the nearest point on a segment',
  intersection: 'Snap to a segment intersection',
  grid: 'Snap to the grid',
  'shared-edge': 'Snap a shared boundary',
};

export interface SnapOptions {
  /** Largest distance a vertex may be moved, in dataset units. */
  tolerance: number;
  /** Grid spacing, for grid snapping. */
  gridSize: number;
  /**
   * Layers whose geometry must not be changed.
   *
   * The same guard `qa/repair.ts` carries, and for the same reason: a lease or
   * cadastral boundary is legally operative, so an automated snap must refuse
   * it rather than improve it.
   */
  protectedLayers: string[];
}

export const DEFAULT_SNAP_OPTIONS: SnapOptions = {
  tolerance: 0.01,
  gridSize: 1,
  protectedLayers: [],
};

/** A vertex the plan would move, addressed precisely enough to undo. */
export interface SnapMove {
  layer: string;
  featureIndex: number;
  /** Path into the geometry: ring or line index, then vertex index. */
  ring: number;
  vertex: number;
  from: Position;
  to: Position;
  distance: number;
  /** What it snapped to, for the preview list. */
  reason: string;
}

export interface SnapPlan {
  mode: SnapMode;
  moves: SnapMove[];
  /** Largest distance any vertex would move. */
  maxDisplacement: number;
  /** Layers skipped because they are protected, with the count of features. */
  refused: { layer: string; featureCount: number; reason: string }[];
  /** Why nothing was found, when nothing was. */
  note?: string;
}

export interface SnapResult {
  dataset: CirDataset;
  plan: SnapPlan;
  undo: UndoRecord;
}

/** Identifies one feature, for an operation the user aimed at a specific thing. */
export interface FeatureRef {
  layer: string;
  featureIndex: number;
}

// --------------------------------------------------------------- geometry access

/**
 * Rings of a geometry as a flat list, whatever its type.
 *
 * A LineString is one "ring", a Polygon has one per ring, a MultiPolygon
 * flattens across its parts. The index returned is what `SnapMove.ring` refers
 * to, so it must be stable — which is why this walks in a fixed order rather
 * than by type.
 */
function ringsOf(feature: CirFeature): Position[][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  switch (geometry.type) {
    case 'LineString':
      return [geometry.coordinates as Position[]];
    case 'MultiLineString':
      return geometry.coordinates as Position[][];
    case 'Polygon':
      return geometry.coordinates as Position[][];
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).flat();
    default:
      return [];
  }
}

/** Rebuilds a geometry from rings produced by `ringsOf`, in the same order. */
function withRings(feature: CirFeature, rings: Position[][]): CirFeature {
  const geometry = feature.geometry;
  if (!geometry) return feature;

  switch (geometry.type) {
    case 'LineString':
      return { ...feature, geometry: { ...geometry, coordinates: rings[0] } };
    case 'MultiLineString':
    case 'Polygon':
      return { ...feature, geometry: { ...geometry, coordinates: rings } };
    case 'MultiPolygon': {
      // Re-nest by the original part shapes, so a MultiPolygon keeps its parts
      // rather than collapsing into one polygon with many rings.
      const parts = geometry.coordinates as Position[][][];
      const rebuilt: Position[][][] = [];
      let cursor = 0;
      for (const part of parts) {
        rebuilt.push(rings.slice(cursor, cursor + part.length));
        cursor += part.length;
      }
      return { ...feature, geometry: { ...geometry, coordinates: rebuilt } };
    }
    default:
      return feature;
  }
}

// --------------------------------------------------------------- maths

function distanceBetween(left: Position, right: Position): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

/** Closest point on segment a→b to p, and how far away it is. */
function closestOnSegment(p: Position, a: Position, b: Position): { point: Position; distance: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;

  // A degenerate segment is a point; projecting onto it would divide by zero.
  if (lengthSq === 0) return { point: a, distance: distanceBetween(p, a) };

  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const point: Position = [a[0] + t * dx, a[1] + t * dy];
  return { point, distance: distanceBetween(p, point) };
}

/** Where two segments cross, or null when they do not. */
function segmentIntersection(a1: Position, a2: Position, b1: Position, b2: Position): Position | null {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const denominator = d1x * d2y - d1y * d2x;

  // Parallel or collinear: no single crossing point to snap to.
  if (Math.abs(denominator) < 1e-12) return null;

  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / denominator;
  const u = ((b1[0] - a1[0]) * d1y - (b1[1] - a1[1]) * d1x) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return [a1[0] + t * d1x, a1[1] + t * d1y];
}

/** Keeps the source vertex's Z, since snapping is a horizontal operation. */
function withZ(target: Position, source: Position): Position {
  return source[2] !== undefined ? [target[0], target[1], source[2]] : [target[0], target[1]];
}

// --------------------------------------------------------------- shared edge

export interface SharedEdgeOptions extends SnapOptions {
  /**
   * Which feature yields.
   *
   * 'second' moves the second feature onto the first, which is the usual
   * cadastral case: an existing parcel is authoritative and the new survey
   * closes onto it. 'midpoint' splits the difference, which is right when
   * neither is more trusted than the other.
   */
  yield: 'second' | 'first' | 'midpoint';
}

export const DEFAULT_SHARED_EDGE_OPTIONS: SharedEdgeOptions = {
  ...DEFAULT_SNAP_OPTIONS,
  yield: 'second',
};

/**
 * Snaps the boundary shared by two named features, and nothing else.
 *
 * This is the operation the spec singles out. Two parcels that should abut have
 * boundaries that differ by millimetres — different surveys, different epochs,
 * a re-digitised sheet. Closing that gap must move the shared run of vertices
 * and leave the rest of both parcels exactly where they are, because the rest
 * of the parcel abuts something else that has not been agreed.
 *
 * How the shared run is found: a vertex of one feature is part of the shared
 * boundary when it lies within tolerance of the OTHER feature's outline. That
 * is a property of the geometry rather than of vertex pairing, so it works when
 * the two boundaries have different vertex counts — which they almost always
 * do, since one has been re-surveyed and the other has not.
 */
export function planSharedEdgeSnap(
  dataset: CirDataset,
  first: FeatureRef,
  second: FeatureRef,
  options: Partial<SharedEdgeOptions> = {}
): SnapPlan {
  const settings = { ...DEFAULT_SHARED_EDGE_OPTIONS, ...options };
  const moves: SnapMove[] = [];
  const refused: SnapPlan['refused'] = [];

  const firstFeature = featureAt(dataset, first);
  const secondFeature = featureAt(dataset, second);

  if (!firstFeature || !secondFeature) {
    return { mode: 'shared-edge', moves: [], maxDisplacement: 0, refused, note: 'One of the two features could not be found.' };
  }

  for (const [ref, layerName] of [
    [first, first.layer],
    [second, second.layer],
  ] as const) {
    void ref;
    if (settings.protectedLayers.includes(layerName)) {
      refused.push({
        layer: layerName,
        featureCount: 1,
        reason: 'Layer is marked legally operative, so its boundary is not moved by an automated snap.',
      });
    }
  }

  const firstRings = ringsOf(firstFeature);
  const secondRings = ringsOf(secondFeature);
  if (firstRings.length === 0 || secondRings.length === 0) {
    return { mode: 'shared-edge', moves: [], maxDisplacement: 0, refused, note: 'Both features must have line or polygon geometry.' };
  }

  const firstProtected = settings.protectedLayers.includes(first.layer);
  const secondProtected = settings.protectedLayers.includes(second.layer);

  // Both protected: nothing can move, and saying so is the whole answer.
  if (firstProtected && secondProtected) {
    return {
      mode: 'shared-edge',
      moves: [],
      maxDisplacement: 0,
      refused,
      note: 'Both features are in protected layers, so neither boundary can be moved.',
    };
  }

  /** Moves the vertices of `mover` that lie on `anchor`'s outline. */
  const snapOnto = (
    mover: CirFeature,
    moverRef: FeatureRef,
    moverRings: Position[][],
    anchorRings: Position[][],
    blend: number
  ) => {
    void mover;
    for (const [ringIndex, ring] of moverRings.entries()) {
      for (const [vertexIndex, vertex] of ring.entries()) {
        const nearest = nearestOnRings(vertex, anchorRings);
        if (!nearest || nearest.distance > settings.tolerance) continue;
        // Already coincident: moving it zero units is not a change worth
        // listing, and listing it would bury the ones that matter.
        if (nearest.distance === 0) continue;

        const target: Position = [
          vertex[0] + (nearest.point[0] - vertex[0]) * blend,
          vertex[1] + (nearest.point[1] - vertex[1]) * blend,
        ];
        const moved = withZ(target, vertex);
        const displacement = distanceBetween(vertex, moved);
        if (displacement === 0) continue;

        moves.push({
          layer: moverRef.layer,
          featureIndex: moverRef.featureIndex,
          ring: ringIndex,
          vertex: vertexIndex,
          from: vertex,
          to: moved,
          distance: displacement,
          reason: `On the boundary shared with ${otherLabel(moverRef, first, second)}, ${nearest.distance.toFixed(4)} away.`,
        });
      }
    }
  };

  // 'second' means the second feature yields entirely (blend 1); 'midpoint'
  // moves each halfway, so both sides carry half the correction.
  if (settings.yield === 'midpoint') {
    if (!firstProtected) snapOnto(firstFeature, first, firstRings, secondRings, 0.5);
    if (!secondProtected) snapOnto(secondFeature, second, secondRings, firstRings, 0.5);
  } else if (settings.yield === 'first') {
    if (firstProtected) {
      return { mode: 'shared-edge', moves: [], maxDisplacement: 0, refused, note: 'The feature asked to yield is in a protected layer.' };
    }
    snapOnto(firstFeature, first, firstRings, secondRings, 1);
  } else {
    if (secondProtected) {
      return { mode: 'shared-edge', moves: [], maxDisplacement: 0, refused, note: 'The feature asked to yield is in a protected layer.' };
    }
    snapOnto(secondFeature, second, secondRings, firstRings, 1);
  }

  const maxDisplacement = moves.reduce((max, move) => Math.max(max, move.distance), 0);
  return {
    mode: 'shared-edge',
    moves,
    maxDisplacement,
    refused,
    note:
      moves.length === 0
        ? `No vertex of either feature lies within ${settings.tolerance} of the other. If these parcels should abut, the gap is larger than the tolerance allows.`
        : undefined,
  };
}

function otherLabel(mover: FeatureRef, first: FeatureRef, second: FeatureRef): string {
  const other = mover === first ? second : first;
  return `${other.layer} feature ${other.featureIndex}`;
}

/** Nearest point on any of these rings, treating them as connected outlines. */
function nearestOnRings(point: Position, rings: Position[][]): { point: Position; distance: number } | null {
  let best: { point: Position; distance: number } | null = null;
  for (const ring of rings) {
    for (let index = 0; index < ring.length - 1; index++) {
      const candidate = closestOnSegment(point, ring[index], ring[index + 1]);
      if (!best || candidate.distance < best.distance) best = candidate;
    }
  }
  return best;
}

// --------------------------------------------------------------- other modes

/**
 * Snaps the vertices of named features to nearby vertices of other features.
 *
 * `scope` is required rather than optional: a snap with no scope would be the
 * dataset-wide operation this module exists not to provide. Naming what may
 * move is how "nothing moves unless it is named" is enforced rather than
 * merely intended.
 */
export function planVertexSnap(
  dataset: CirDataset,
  scope: FeatureRef[],
  options: Partial<SnapOptions> = {}
): SnapPlan {
  const settings = { ...DEFAULT_SNAP_OPTIONS, ...options };
  const moves: SnapMove[] = [];
  const refused: SnapPlan['refused'] = [];
  const targets = collectVertices(dataset, scope);

  for (const ref of scope) {
    if (settings.protectedLayers.includes(ref.layer)) {
      refused.push({ layer: ref.layer, featureCount: 1, reason: 'Layer is marked legally operative.' });
      continue;
    }
    const feature = featureAt(dataset, ref);
    if (!feature) continue;

    for (const [ringIndex, ring] of ringsOf(feature).entries()) {
      for (const [vertexIndex, vertex] of ring.entries()) {
        let best: { position: Position; distance: number } | null = null;
        for (const target of targets) {
          // Never snap a feature to itself: every vertex is zero from itself,
          // and its neighbours would pull it along its own edge.
          if (target.layer === ref.layer && target.featureIndex === ref.featureIndex) continue;
          const gap = distanceBetween(vertex, target.position);
          if (gap > settings.tolerance || gap === 0) continue;
          if (!best || gap < best.distance) best = { position: target.position, distance: gap };
        }
        if (!best) continue;

        moves.push({
          layer: ref.layer,
          featureIndex: ref.featureIndex,
          ring: ringIndex,
          vertex: vertexIndex,
          from: vertex,
          to: withZ(best.position, vertex),
          distance: best.distance,
          reason: `Within ${settings.tolerance} of another feature's vertex.`,
        });
      }
    }
  }

  return {
    mode: 'vertex',
    moves,
    maxDisplacement: moves.reduce((max, move) => Math.max(max, move.distance), 0),
    refused,
    note: moves.length === 0 ? `No vertex is within ${settings.tolerance} of another feature's vertex.` : undefined,
  };
}

/** Snaps named features' vertices to a grid. */
export function planGridSnap(dataset: CirDataset, scope: FeatureRef[], options: Partial<SnapOptions> = {}): SnapPlan {
  const settings = { ...DEFAULT_SNAP_OPTIONS, ...options };
  const moves: SnapMove[] = [];
  const refused: SnapPlan['refused'] = [];

  if (!(settings.gridSize > 0)) {
    return { mode: 'grid', moves: [], maxDisplacement: 0, refused, note: 'The grid size must be greater than zero.' };
  }

  for (const ref of scope) {
    if (settings.protectedLayers.includes(ref.layer)) {
      refused.push({ layer: ref.layer, featureCount: 1, reason: 'Layer is marked legally operative.' });
      continue;
    }
    const feature = featureAt(dataset, ref);
    if (!feature) continue;

    for (const [ringIndex, ring] of ringsOf(feature).entries()) {
      for (const [vertexIndex, vertex] of ring.entries()) {
        const snapped: Position = [
          Math.round(vertex[0] / settings.gridSize) * settings.gridSize,
          Math.round(vertex[1] / settings.gridSize) * settings.gridSize,
        ];
        const displacement = distanceBetween(vertex, snapped);
        // The tolerance still applies: a grid snap that drags a vertex half a
        // cell is a grid snap that should not have been offered for that data.
        if (displacement === 0 || displacement > settings.tolerance) continue;

        moves.push({
          layer: ref.layer,
          featureIndex: ref.featureIndex,
          ring: ringIndex,
          vertex: vertexIndex,
          from: vertex,
          to: withZ(snapped, vertex),
          distance: displacement,
          reason: `Onto the ${settings.gridSize} grid.`,
        });
      }
    }
  }

  return {
    mode: 'grid',
    moves,
    maxDisplacement: moves.reduce((max, move) => Math.max(max, move.distance), 0),
    refused,
    note: moves.length === 0 ? `No vertex is within ${settings.tolerance} of a grid node.` : undefined,
  };
}

/**
 * Finds where a moving feature's vertices should sit on another feature's
 * segments — the case where a vertex is near an edge but not near any of its
 * vertices, which is what a T-junction between parcels looks like.
 */
export function planSegmentSnap(
  dataset: CirDataset,
  scope: FeatureRef[],
  options: Partial<SnapOptions> = {}
): SnapPlan {
  const settings = { ...DEFAULT_SNAP_OPTIONS, ...options };
  const moves: SnapMove[] = [];
  const refused: SnapPlan['refused'] = [];

  for (const ref of scope) {
    if (settings.protectedLayers.includes(ref.layer)) {
      refused.push({ layer: ref.layer, featureCount: 1, reason: 'Layer is marked legally operative.' });
      continue;
    }
    const feature = featureAt(dataset, ref);
    if (!feature) continue;

    const others: Position[][] = [];
    for (const [layerIndex, layer] of dataset.layers.entries()) {
      void layerIndex;
      for (const [featureIndex, candidate] of layer.features.entries()) {
        if (layer.name === ref.layer && featureIndex === ref.featureIndex) continue;
        others.push(...ringsOf(candidate));
      }
    }

    for (const [ringIndex, ring] of ringsOf(feature).entries()) {
      for (const [vertexIndex, vertex] of ring.entries()) {
        const nearest = nearestOnRings(vertex, others);
        if (!nearest || nearest.distance === 0 || nearest.distance > settings.tolerance) continue;

        moves.push({
          layer: ref.layer,
          featureIndex: ref.featureIndex,
          ring: ringIndex,
          vertex: vertexIndex,
          from: vertex,
          to: withZ(nearest.point, vertex),
          distance: nearest.distance,
          reason: `Onto another feature's edge, ${nearest.distance.toFixed(4)} away.`,
        });
      }
    }
  }

  return {
    mode: 'segment',
    moves,
    maxDisplacement: moves.reduce((max, move) => Math.max(max, move.distance), 0),
    refused,
    note: moves.length === 0 ? `No vertex is within ${settings.tolerance} of another feature's edge.` : undefined,
  };
}

/**
 * Snaps vertices onto the crossing point of two segments.
 *
 * The case this is for: two boundaries that cross where they should meet at a
 * corner, leaving a small X. The corner is the intersection, and neither
 * feature has a vertex there.
 */
export function planIntersectionSnap(
  dataset: CirDataset,
  scope: FeatureRef[],
  options: Partial<SnapOptions> = {}
): SnapPlan {
  const settings = { ...DEFAULT_SNAP_OPTIONS, ...options };
  const moves: SnapMove[] = [];
  const refused: SnapPlan['refused'] = [];
  const crossings = collectIntersections(dataset);

  for (const ref of scope) {
    if (settings.protectedLayers.includes(ref.layer)) {
      refused.push({ layer: ref.layer, featureCount: 1, reason: 'Layer is marked legally operative.' });
      continue;
    }
    const feature = featureAt(dataset, ref);
    if (!feature) continue;

    for (const [ringIndex, ring] of ringsOf(feature).entries()) {
      for (const [vertexIndex, vertex] of ring.entries()) {
        let best: { position: Position; distance: number } | null = null;
        for (const crossing of crossings) {
          const gap = distanceBetween(vertex, crossing);
          if (gap === 0 || gap > settings.tolerance) continue;
          if (!best || gap < best.distance) best = { position: crossing, distance: gap };
        }
        if (!best) continue;

        moves.push({
          layer: ref.layer,
          featureIndex: ref.featureIndex,
          ring: ringIndex,
          vertex: vertexIndex,
          from: vertex,
          to: withZ(best.position, vertex),
          distance: best.distance,
          reason: `Onto a segment crossing ${best.distance.toFixed(4)} away.`,
        });
      }
    }
  }

  return {
    mode: 'intersection',
    moves,
    maxDisplacement: moves.reduce((max, move) => Math.max(max, move.distance), 0),
    refused,
    note: moves.length === 0 ? `No vertex is within ${settings.tolerance} of a segment crossing.` : undefined,
  };
}

// --------------------------------------------------------------- apply

/**
 * Applies a plan, returning a new dataset and the record that reverses it.
 *
 * The plan is applied exactly as computed — this does not recompute anything —
 * so what the user previewed and what they committed are the same set of moves
 * by construction, not by two code paths agreeing.
 */
export function applySnap(dataset: CirDataset, plan: SnapPlan): SnapResult {
  const undo: UndoRecord = { label: SNAP_MODE_LABEL[plan.mode], entries: [] };
  if (plan.moves.length === 0) return { dataset, plan, undo };

  // Group by feature so each is rewritten once even when many of its vertices
  // move, which is the normal case for a shared edge.
  const byFeature = new Map<string, SnapMove[]>();
  for (const move of plan.moves) {
    const key = `${move.layer} ${move.featureIndex}`;
    byFeature.set(key, [...(byFeature.get(key) ?? []), move]);
  }

  const layers = dataset.layers.map((layer) => {
    let touched = false;
    const features = layer.features.map((feature, featureIndex) => {
      const moves = byFeature.get(`${layer.name} ${featureIndex}`);
      if (!moves || moves.length === 0) return feature;

      const rings = ringsOf(feature).map((ring) => ring.slice());
      for (const move of moves) {
        const ring = rings[move.ring];
        if (!ring || move.vertex >= ring.length) continue;
        ring[move.vertex] = move.to;

        // A closed ring repeats its first vertex at the end. Moving one without
        // the other opens the ring — a repair that creates the very defect the
        // topology checker reports.
        const isClosed =
          ring.length > 2 &&
          ring[0][0] === ring[ring.length - 1][0] &&
          ring[0][1] === ring[ring.length - 1][1];
        if (isClosed && (move.vertex === 0 || move.vertex === ring.length - 1)) {
          ring[0] = move.to;
          ring[ring.length - 1] = move.to;
        }
      }

      touched = true;
      undo.entries.push({ layer: layer.name, featureIndex, geometry: feature.geometry });
      return withRings(feature, rings);
    });

    return touched ? { ...layer, features } : layer;
  });

  return { dataset: { ...dataset, layers }, plan, undo };
}

/** A one-line account of a plan, for the confirmation prompt. */
export function describeSnapPlan(plan: SnapPlan): string {
  if (plan.moves.length === 0) return plan.note ?? 'Nothing to snap.';

  const features = new Set(plan.moves.map((move) => `${move.layer} ${move.featureIndex}`)).size;
  const parts = [
    `${SNAP_MODE_LABEL[plan.mode]}: ${plan.moves.length} vertex${plan.moves.length === 1 ? '' : 'es'} on ${features} feature${features === 1 ? '' : 's'}`,
    `moving at most ${plan.maxDisplacement.toPrecision(4)}`,
  ];
  if (plan.refused.length > 0) parts.push(`${plan.refused.length} layer(s) refused as protected`);
  return `${parts.join(', ')}.`;
}

// --------------------------------------------------------------- helpers

function featureAt(dataset: CirDataset, ref: FeatureRef): CirFeature | null {
  const layer = dataset.layers.find((candidate) => candidate.name === ref.layer);
  return layer?.features[ref.featureIndex] ?? null;
}

interface VertexTarget {
  layer: string;
  featureIndex: number;
  position: Position;
}

/** Every vertex in the dataset, excluding the features being moved. */
function collectVertices(dataset: CirDataset, exclude: FeatureRef[]): VertexTarget[] {
  const excluded = new Set(exclude.map((ref) => `${ref.layer} ${ref.featureIndex}`));
  const out: VertexTarget[] = [];

  for (const layer of dataset.layers) {
    for (const [featureIndex, feature] of layer.features.entries()) {
      if (excluded.has(`${layer.name} ${featureIndex}`)) continue;
      for (const ring of ringsOf(feature)) {
        for (const position of ring) out.push({ layer: layer.name, featureIndex, position });
      }
    }
  }
  return out;
}

/**
 * Every point where two segments in the dataset cross.
 *
 * Quadratic in the number of segments, and deliberately not indexed: this runs
 * on a handful of features the user has selected, never on a whole coverage.
 * A dataset-wide intersection snap is not offered, because it is the operation
 * that silently moves things nobody asked about.
 */
function collectIntersections(dataset: CirDataset): Position[] {
  const segments: [Position, Position][] = [];
  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      for (const ring of ringsOf(feature)) {
        for (let index = 0; index < ring.length - 1; index++) segments.push([ring[index], ring[index + 1]]);
      }
    }
  }

  const out: Position[] = [];
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const crossing = segmentIntersection(segments[i][0], segments[i][1], segments[j][0], segments[j][1]);
      if (crossing) out.push(crossing);
    }
  }
  return out;
}
