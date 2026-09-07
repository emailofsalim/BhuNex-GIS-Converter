/**
 * The vertex editor (spec §25.1).
 *
 * Add, delete, move, insert-on-segment, multi-select. Coordinate entry in X/Y/Z
 * and by bearing/distance. A live readout of position, segment length, bearing,
 * perimeter and area, in the dataset's own units.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN EDITOR ON SURVEY DATA MUST NOT DO
 *
 * A vertex editor is the most destructive tool in this application. Everything
 * else converts, measures or reports; this one changes the record. Three rules
 * follow, and each is enforced here rather than left to the UI:
 *
 *  - IT REFUSES TO PRODUCE INVALID GEOMETRY. Deleting the third vertex of a
 *    triangle leaves a line pretending to be a polygon. Most editors allow it
 *    and let the topology checker complain afterwards; this one refuses with
 *    the reason, because a polygon with two corners is not an edit anybody
 *    meant to make.
 *  - IT KEEPS CLOSED RINGS CLOSED. The first and last vertex of a ring are the
 *    same point stored twice. Moving one without the other opens the ring —
 *    creating the exact defect `qa/topology.ts` reports. Every operation here
 *    moves them together.
 *  - IT SAYS WHAT IT WILL DO BEFORE IT DOES IT. The same plan → apply → undo
 *    contract as `qa/repair.ts` and `qa/snap.ts`, so there is one
 *    preview-and-commit flow in the whole tool rather than three that behave
 *    almost alike.
 *
 * ---------------------------------------------------------------------------
 * THE READOUT IS THE FEATURE
 *
 * "Live readout of X, Y, Z, segment length, bearing/azimuth, perimeter and
 * area" is not a status bar decoration. It is how a surveyor knows whether the
 * vertex they just dragged is where the field book says it should be. So
 * `readVertex` reports the geometry AND the change: the segment lengths and
 * bearings to both neighbours, and what the feature's area and perimeter would
 * become — through `core/measure.ts`, so a geographic CRS is measured on the
 * ellipsoid rather than as though degrees were metres.
 */

import type { CirDataset, CirFeature, Position } from './cir';
import type { UndoRecord } from '../qa/repair';
import {
  bearing,
  distance,
  fromBearingDistance,
  polygonArea,
  polygonPerimeter,
  type MeasureContext,
  type Measurement,
} from './measure';

/** Addresses one vertex, precisely enough to change and to reverse. */
export interface VertexRef {
  layer: string;
  featureIndex: number;
  /** Ring or line index within the feature. */
  ring: number;
  vertex: number;
}

export type EditOperation = 'move' | 'insert' | 'delete';

export const EDIT_LABEL: Record<EditOperation, string> = {
  move: 'Move vertex',
  insert: 'Insert vertex',
  delete: 'Delete vertex',
};

export interface EditChange {
  operation: EditOperation;
  ref: VertexRef;
  from?: Position;
  to?: Position;
  /** How far the vertex moved. Zero for an insert or a delete. */
  distance: number;
  /** One sentence with the measured quantity in it. */
  description: string;
}

export interface EditPlan {
  operation: EditOperation;
  changes: EditChange[];
  maxDisplacement: number;
  /**
   * Why the edit cannot be made.
   *
   * Present means nothing will happen. An editor that silently declines is
   * worse than one that refuses out loud: the user repeats the gesture.
   */
  refusal?: { what: string; why: string; action: string };
}

export interface EditResult {
  dataset: CirDataset;
  plan: EditPlan;
  undo: UndoRecord;
}

export interface EditOptions {
  /** Layers whose geometry must not be changed. */
  protectedLayers: string[];
  /** Measurement context, so the readout is in the dataset's own terms. */
  measure: MeasureContext;
}

// --------------------------------------------------------------- ring access

/** Rings of a geometry as a flat list, in the order `VertexRef.ring` indexes. */
function ringsOf(feature: CirFeature): Position[][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  switch (geometry.type) {
    case 'LineString':
      return [geometry.coordinates as Position[]];
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates as Position[][];
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).flat();
    default:
      return [];
  }
}

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

function featureAt(dataset: CirDataset, layer: string, index: number): CirFeature | null {
  return dataset.layers.find((candidate) => candidate.name === layer)?.features[index] ?? null;
}

/** True when a ring repeats its first vertex at the end, as a closed ring does. */
function isClosed(ring: Position[]): boolean {
  return ring.length > 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
}

/**
 * Whether this ring must stay closed and stay a polygon.
 *
 * A LineString ring may be any length down to two; a polygon ring may not drop
 * below three distinct vertices without ceasing to be a polygon.
 */
function isPolygonRing(feature: CirFeature): boolean {
  return feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon';
}

function refuse(operation: EditOperation, what: string, why: string, action: string): EditPlan {
  return { operation, changes: [], maxDisplacement: 0, refusal: { what, why, action } };
}

// --------------------------------------------------------------- move

/**
 * Moves one vertex to a new position.
 *
 * When the vertex is an endpoint of a closed ring, BOTH stored copies move —
 * otherwise the ring opens, which is the single most common way a hand-rolled
 * vertex editor corrupts a polygon layer.
 */
export function planMoveVertex(
  dataset: CirDataset,
  ref: VertexRef,
  to: Position,
  options: Partial<EditOptions> = {}
): EditPlan {
  const settings = resolve(options);
  if (settings.protectedLayers.includes(ref.layer)) return protectedRefusal('move', ref.layer);

  const feature = featureAt(dataset, ref.layer, ref.featureIndex);
  if (!feature) return refuse('move', 'That feature could not be found.', 'The layer or index does not exist.', 'Reselect the vertex.');

  const rings = ringsOf(feature);
  const ring = rings[ref.ring];
  if (!ring || ref.vertex >= ring.length) {
    return refuse('move', 'That vertex could not be found.', 'The ring or vertex index is out of range.', 'Reselect the vertex.');
  }

  const from = ring[ref.vertex];
  // Keep the source Z unless the caller supplied one: dragging on a plan view
  // is a horizontal operation and must not flatten a levelled point to zero.
  const target: Position = to[2] !== undefined ? to : from[2] !== undefined ? [to[0], to[1], from[2]] : [to[0], to[1]];
  const moved = distance(from, target, settings.measure);

  if (moved.value === 0) {
    return { operation: 'move', changes: [], maxDisplacement: 0 };
  }

  return {
    operation: 'move',
    changes: [
      {
        operation: 'move',
        ref,
        from,
        to: target,
        distance: moved.value,
        description: `Moves vertex ${ref.vertex} of ${ref.layer} feature ${ref.featureIndex} by ${moved.text}.`,
      },
    ],
    maxDisplacement: moved.value,
  };
}

/**
 * Moves a vertex to a bearing and distance from where it is.
 *
 * This is how survey corrections arrive — "move it 0.35 m on a bearing of
 * 212°" — rather than as a coordinate pair. Geodesic on a geographic CRS,
 * planar on a projected one, decided by `core/measure.ts`.
 */
export function planMoveByBearing(
  dataset: CirDataset,
  ref: VertexRef,
  bearingDegrees: number,
  distanceValue: number,
  options: Partial<EditOptions> = {}
): EditPlan {
  const settings = resolve(options);
  const feature = featureAt(dataset, ref.layer, ref.featureIndex);
  const ring = feature ? ringsOf(feature)[ref.ring] : null;
  if (!ring || ref.vertex >= ring.length) {
    return refuse('move', 'That vertex could not be found.', 'The ring or vertex index is out of range.', 'Reselect the vertex.');
  }
  return planMoveVertex(dataset, ref, fromBearingDistance(ring[ref.vertex], bearingDegrees, distanceValue, settings.measure), options);
}

// --------------------------------------------------------------- insert

/**
 * Inserts a vertex on the segment that starts at `ref.vertex`.
 *
 * The position is PROJECTED ONTO THE SEGMENT rather than used as given. A
 * click is never exactly on a line, and an "insert on segment" that inserts
 * slightly beside it puts a kink in a boundary that was straight — a defect
 * that is invisible at the zoom the user was working at and obvious in the
 * delivered file.
 */
export function planInsertVertex(
  dataset: CirDataset,
  ref: VertexRef,
  near: Position,
  options: Partial<EditOptions> = {}
): EditPlan {
  const settings = resolve(options);
  if (settings.protectedLayers.includes(ref.layer)) return protectedRefusal('insert', ref.layer);

  const feature = featureAt(dataset, ref.layer, ref.featureIndex);
  if (!feature) return refuse('insert', 'That feature could not be found.', 'The layer or index does not exist.', 'Reselect the segment.');

  const ring = ringsOf(feature)[ref.ring];
  if (!ring || ref.vertex >= ring.length - 1) {
    return refuse(
      'insert',
      'That segment could not be found.',
      'A vertex can only be inserted on a segment, and the selected vertex is the last one in the ring.',
      'Select the vertex at the START of the segment you want to split.'
    );
  }

  const start = ring[ref.vertex];
  const end = ring[ref.vertex + 1];
  const onSegment = projectOntoSegment(near, start, end);

  return {
    operation: 'insert',
    changes: [
      {
        operation: 'insert',
        ref: { ...ref, vertex: ref.vertex + 1 },
        to: onSegment,
        distance: 0,
        description: `Inserts a vertex on the segment from ${ref.vertex} to ${ref.vertex + 1} of ${ref.layer} feature ${ref.featureIndex}.`,
      },
    ],
    maxDisplacement: 0,
  };
}

/** Closest point on a segment, carrying an interpolated Z when both ends have one. */
function projectOntoSegment(point: Position, start: Position, end: Position): Position {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return start.slice();

  let t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const out: Position = [start[0] + t * dx, start[1] + t * dy];
  // Interpolate the elevation rather than dropping it: a new vertex on a graded
  // haul road that arrives at Z = 0 is a hole in the surface.
  if (start[2] !== undefined && end[2] !== undefined) out.push(start[2] + t * (end[2] - start[2]));
  else if (start[2] !== undefined) out.push(start[2]);
  return out;
}

// --------------------------------------------------------------- delete

/**
 * Deletes a vertex, refusing when the result would not be valid geometry.
 *
 * The refusal is the point. A polygon ring needs three distinct vertices; a
 * line needs two. Deleting past that produces something that still parses,
 * still writes, and is not a polygon — and the person who finds out is the
 * recipient of the delivery, not the person who made the edit.
 */
export function planDeleteVertex(
  dataset: CirDataset,
  ref: VertexRef,
  options: Partial<EditOptions> = {}
): EditPlan {
  const settings = resolve(options);
  if (settings.protectedLayers.includes(ref.layer)) return protectedRefusal('delete', ref.layer);

  const feature = featureAt(dataset, ref.layer, ref.featureIndex);
  if (!feature) return refuse('delete', 'That feature could not be found.', 'The layer or index does not exist.', 'Reselect the vertex.');

  const ring = ringsOf(feature)[ref.ring];
  if (!ring || ref.vertex >= ring.length) {
    return refuse('delete', 'That vertex could not be found.', 'The ring or vertex index is out of range.', 'Reselect the vertex.');
  }

  const closed = isClosed(ring);
  // A closed ring stores its first vertex twice, so its distinct count is one
  // fewer than its length.
  const distinct = closed ? ring.length - 1 : ring.length;

  if (isPolygonRing(feature)) {
    if (distinct <= 3) {
      return refuse(
        'delete',
        'That vertex cannot be deleted.',
        `The ring has ${distinct} corners, and a polygon needs at least three. Deleting this one would leave a shape that is not a polygon.`,
        'Delete the whole feature instead, if that is what you meant.'
      );
    }
  } else if (distinct <= 2) {
    return refuse(
      'delete',
      'That vertex cannot be deleted.',
      `The line has ${distinct} vertices, and a line needs at least two. Deleting this one would leave a line with no length.`,
      'Delete the whole feature instead, if that is what you meant.'
    );
  }

  return {
    operation: 'delete',
    changes: [
      {
        operation: 'delete',
        ref,
        from: ring[ref.vertex],
        distance: 0,
        description: `Deletes vertex ${ref.vertex} of ${ref.layer} feature ${ref.featureIndex}, leaving ${distinct - 1} corners.`,
      },
    ],
    maxDisplacement: 0,
  };
}

// --------------------------------------------------------------- multi-select

/**
 * Moves several vertices by the same offset — a drag of a multi-selection.
 *
 * Applied as one plan so it undoes as one action. A multi-select drag that
 * undoes one vertex at a time is a multi-select drag nobody uses twice.
 */
export function planMoveMany(
  dataset: CirDataset,
  refs: VertexRef[],
  offset: { dx: number; dy: number; dz?: number },
  options: Partial<EditOptions> = {}
): EditPlan {
  const settings = resolve(options);
  const changes: EditChange[] = [];
  let maxDisplacement = 0;

  const blocked = [...new Set(refs.map((ref) => ref.layer))].filter((layer) => settings.protectedLayers.includes(layer));
  if (blocked.length > 0) return protectedRefusal('move', blocked.join(', '));

  for (const ref of refs) {
    const feature = featureAt(dataset, ref.layer, ref.featureIndex);
    const ring = feature ? ringsOf(feature)[ref.ring] : null;
    if (!ring || ref.vertex >= ring.length) continue;

    const from = ring[ref.vertex];
    const to: Position = [from[0] + offset.dx, from[1] + offset.dy];
    if (from[2] !== undefined) to.push(from[2] + (offset.dz ?? 0));

    const moved = distance(from, to, settings.measure);
    if (moved.value === 0) continue;
    if (moved.value > maxDisplacement) maxDisplacement = moved.value;

    changes.push({
      operation: 'move',
      ref,
      from,
      to,
      distance: moved.value,
      description: `Moves vertex ${ref.vertex} of ${ref.layer} feature ${ref.featureIndex} by ${moved.text}.`,
    });
  }

  return { operation: 'move', changes, maxDisplacement };
}

// --------------------------------------------------------------- apply

/**
 * Applies a plan, returning a new dataset and the record that reverses it.
 *
 * Deletes and inserts are applied from the highest index down, so an earlier
 * change cannot shift the index an later one refers to — the classic off-by-one
 * that makes a multi-vertex edit delete the wrong corner.
 */
export function applyEdit(dataset: CirDataset, plan: EditPlan): EditResult {
  const undo: UndoRecord = { label: EDIT_LABEL[plan.operation], entries: [] };
  if (plan.refusal || plan.changes.length === 0) return { dataset, plan, undo };

  const byFeature = new Map<string, EditChange[]>();
  for (const change of plan.changes) {
    const key = `${change.ref.layer} ${change.ref.featureIndex}`;
    byFeature.set(key, [...(byFeature.get(key) ?? []), change]);
  }

  const layers = dataset.layers.map((layer) => {
    let touched = false;
    const features = layer.features.map((feature, featureIndex) => {
      const changes = byFeature.get(`${layer.name} ${featureIndex}`);
      if (!changes || changes.length === 0) return feature;

      const rings = ringsOf(feature).map((ring) => ring.slice());
      const ordered = [...changes].sort((left, right) => right.ref.vertex - left.ref.vertex);

      for (const change of ordered) {
        const ring = rings[change.ref.ring];
        if (!ring) continue;
        const closed = isClosed(ring);

        if (change.operation === 'delete') {
          const isEndpoint = closed && (change.ref.vertex === 0 || change.ref.vertex === ring.length - 1);
          if (isEndpoint) {
            // Removing a ring's first vertex means the second becomes the new
            // start, and the closing copy has to follow it.
            ring.splice(0, 1);
            ring[ring.length - 1] = ring[0].slice();
          } else {
            ring.splice(change.ref.vertex, 1);
          }
        } else if (change.operation === 'insert') {
          ring.splice(change.ref.vertex, 0, change.to!);
        } else {
          ring[change.ref.vertex] = change.to!;
          if (closed && (change.ref.vertex === 0 || change.ref.vertex === ring.length - 1)) {
            ring[0] = change.to!;
            ring[ring.length - 1] = change.to!;
          }
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

// --------------------------------------------------------------- readout

export interface VertexReadout {
  position: Position;
  x: number;
  y: number;
  z?: number;
  /** Distance and bearing back to the previous vertex, when there is one. */
  fromPrevious?: { length: Measurement; bearing: Measurement };
  /** Distance and bearing on to the next vertex, when there is one. */
  toNext?: { length: Measurement; bearing: Measurement };
  /** The feature's totals as they stand. */
  perimeter?: Measurement;
  area?: Measurement;
  /** Which vertex, and how many the ring has. */
  index: number;
  ringVertexCount: number;
  /** True when this vertex is a closed ring's repeated endpoint. */
  isRingEndpoint: boolean;
}

/**
 * Everything the editor shows about the selected vertex.
 *
 * Measured through `core/measure.ts`, so a geographic CRS reports geodesic
 * lengths and true azimuths rather than arithmetic on degrees. Without that
 * this panel would be the most confidently wrong part of the application.
 */
export function readVertex(dataset: CirDataset, ref: VertexRef, options: Partial<EditOptions> = {}): VertexReadout | null {
  const settings = resolve(options);
  const feature = featureAt(dataset, ref.layer, ref.featureIndex);
  if (!feature) return null;

  const rings = ringsOf(feature);
  const ring = rings[ref.ring];
  if (!ring || ref.vertex >= ring.length) return null;

  const position = ring[ref.vertex];
  const closed = isClosed(ring);
  const readout: VertexReadout = {
    position,
    x: position[0],
    y: position[1],
    z: position[2],
    index: ref.vertex,
    ringVertexCount: ring.length,
    isRingEndpoint: closed && (ref.vertex === 0 || ref.vertex === ring.length - 1),
  };

  // On a closed ring the neighbour of the first vertex is the second-to-last,
  // not the duplicate stored at the end — which would report a zero-length
  // segment and a meaningless bearing.
  const previousIndex = ref.vertex > 0 ? ref.vertex - 1 : closed ? ring.length - 2 : -1;
  const nextIndex = ref.vertex < ring.length - 1 ? ref.vertex + 1 : closed ? 1 : -1;

  if (previousIndex >= 0 && previousIndex < ring.length) {
    readout.fromPrevious = {
      length: distance(ring[previousIndex], position, settings.measure),
      bearing: bearing(ring[previousIndex], position, settings.measure),
    };
  }
  if (nextIndex >= 0 && nextIndex < ring.length) {
    readout.toNext = {
      length: distance(position, ring[nextIndex], settings.measure),
      bearing: bearing(position, ring[nextIndex], settings.measure),
    };
  }

  if (isPolygonRing(feature)) {
    readout.area = polygonArea(rings, settings.measure);
    readout.perimeter = polygonPerimeter(rings, settings.measure);
  } else {
    readout.perimeter = polygonPerimeter(rings, settings.measure);
  }

  return readout;
}

/** A one-line account of a plan, for the confirmation prompt. */
export function describeEditPlan(plan: EditPlan): string {
  if (plan.refusal) return `${plan.refusal.what} ${plan.refusal.why} ${plan.refusal.action}`;
  if (plan.changes.length === 0) return 'Nothing would change.';

  const count = plan.changes.length;
  const noun = `${count} vertex${count === 1 ? '' : 'es'}`;
  if (plan.operation === 'move') return `${EDIT_LABEL.move}: ${noun}, moving at most ${plan.maxDisplacement.toPrecision(4)}.`;
  return `${EDIT_LABEL[plan.operation]}: ${noun}.`;
}

// --------------------------------------------------------------- helpers

function resolve(options: Partial<EditOptions>): EditOptions {
  return {
    protectedLayers: options.protectedLayers ?? [],
    measure: options.measure ?? { crs: null },
  };
}

function protectedRefusal(operation: EditOperation, layer: string): EditPlan {
  return refuse(
    operation,
    `${layer} is protected, so its geometry was not changed.`,
    'The layer is marked legally operative — a cadastral or lease boundary is a title, not a drawing.',
    'Remove the layer from the protected list if you genuinely intend to edit it.'
  );
}
