/**
 * Geometry operations (spec §26.2).
 *
 * Buffer, offset, union, intersection, difference, symmetric difference, convex
 * hull, dissolve, centroid, envelope, clip, erase, split by line, line merge,
 * line substring, explode and multipart conversion — each as a plan the caller
 * previews before committing, on the same plan → apply → undo contract as
 * `qa/repair.ts`, `core/vertex-edit.ts`, `core/attributes.ts` and `core/layers.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE CRS GATE
 *
 * Every operation here that takes a DISTANCE — buffer, offset, simplify — is
 * arithmetic on raw coordinates. On a projected CRS those are metres and the
 * answer means what the user meant. On a geographic CRS they are DEGREES, so a
 * "10 metre setback" becomes ten degrees: roughly 1,100 km, and the resulting
 * polygon is a plausible-looking shape that is wrong by five orders of
 * magnitude.
 *
 * This is the same error `core/measure.ts` exists to prevent for lengths, and it
 * is worse here because a buffer produces geometry rather than a number: the
 * number invites a sanity check and the polygon does not. So a distance
 * operation on an undeclared or geographic CRS is REFUSED, with the reprojection
 * to run first.
 *
 * Operations that take no distance — hull, centroid, envelope, the booleans,
 * explode — are scale-free and run on any CRS.
 *
 * ---------------------------------------------------------------------------
 * WHAT A BOOLEAN COSTS
 *
 * Boolean results carry no Z, because a vertex created where two boundaries
 * cross has no elevation in either input (see `core/polygon-boolean.ts`). Where
 * the source had Z, the plan says so before it is applied rather than leaving it
 * to be noticed at export.
 */

import type { CirDataset, CirFeature, CirGeometry, CirLayer, CrsRef, Position } from './cir';
import { collectGeometryTypes } from './cir';
import { bufferGeometry, offsetLine, type BufferOptions } from './buffer';
import { eachPosition, geometryBounds, isFiniteBounds, mapPositions, signedArea } from './geometry';
import { booleanOperation, unionAll, type BooleanOp, type MultiPoly } from './polygon-boolean';

// ===========================================================================
// Conversions between CIR geometry and the boolean core's shape
// ===========================================================================

/** Every polygon in a geometry, as the boolean core wants them. */
export function toMultiPolygon(geometry: CirGeometry | null): MultiPoly {
  if (!geometry) return [];
  switch (geometry.type) {
    case 'Polygon':
      return [geometry.coordinates as Position[][]];
    case 'MultiPolygon':
      return geometry.coordinates as Position[][][];
    case 'GeometryCollection':
      return (geometry.geometries ?? []).flatMap((child) => toMultiPolygon(child));
    default:
      return [];
  }
}

/** Back to CIR. Dimension is 2 because a boolean drops Z — see the header. */
export function fromMultiPolygon(polygons: MultiPoly): CirGeometry | null {
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0], dimension: 2 };
  return { type: 'MultiPolygon', coordinates: polygons, dimension: 2 };
}

function hasZ(geometry: CirGeometry | null): boolean {
  return geometry !== null && geometry.dimension > 2;
}

// ===========================================================================
// Scale-free operations
// ===========================================================================

/** Every position in a geometry, flattened. */
function allPositions(geometry: CirGeometry | null, into: Position[] = []): Position[] {
  if (!geometry) return into;
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      into.push(value as Position);
      return;
    }
    for (const child of value) walk(child);
  };
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries ?? []) allPositions(child, into);
    return into;
  }
  walk(geometry.coordinates);
  return into;
}

/**
 * Convex hull by Andrew's monotone chain.
 *
 * O(n log n) and exact in the sense that matters: the hull is decided by the
 * sign of a cross product, so a point exactly on an edge is excluded
 * consistently rather than depending on a tolerance.
 */
export function convexHull(positions: Position[]): Position[] {
  const points = [...positions]
    .map((position) => [position[0], position[1]] as Position)
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  // Deduplicate, or repeated points make the turn test degenerate.
  const unique: Position[] = [];
  for (const point of points) {
    const previous = unique[unique.length - 1];
    if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
    unique.push(point);
  }
  if (unique.length < 3) return unique;

  const turn = (o: Position, a: Position, b: Position): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Position[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }

  const upper: Position[] = [];
  for (let index = unique.length - 1; index >= 0; index--) {
    const point = unique[index];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  return hull.length >= 3 ? [...hull, hull[0].slice()] : hull;
}

/**
 * The centroid, computed by the rule that suits the geometry's dimension.
 *
 * A polygon's centroid is its area centroid — NOT the mean of its vertices,
 * which drifts towards whichever edge was surveyed in most detail and can fall
 * outside the parcel entirely. A line's is length-weighted for the same reason.
 * Points are averaged, which is the only thing available.
 */
export function centroidOf(geometry: CirGeometry | null): Position | null {
  if (!geometry) return null;

  const polygons = toMultiPolygon(geometry);
  if (polygons.length > 0) {
    let area = 0;
    let x = 0;
    let y = 0;

    for (const rings of polygons) {
      for (let index = 0; index < rings.length; index++) {
        const ring = rings[index];
        let doubleArea = 0;
        let rx = 0;
        let ry = 0;

        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
          doubleArea += cross;
          rx += (ring[j][0] + ring[i][0]) * cross;
          ry += (ring[j][1] + ring[i][1]) * cross;
        }
        if (doubleArea === 0) continue;

        // The ring's own centroid, which is independent of its winding: the
        // sign cancels between the numerator and the denominator.
        const centreX = rx / (3 * doubleArea);
        const centreY = ry / (3 * doubleArea);

        // The weight is |area| with the sign the ROLE demands — exterior adds,
        // hole subtracts — rather than the sign the winding happens to give.
        //
        // Taking the winding's own sign and negating it for holes double-
        // negates a correctly wound hole, so the void gets ADDED. On a 10x10
        // square with a 2x2 void in its lower-left that put the centroid at
        // 4.885 instead of 5.125: not merely imprecise, but moved in the
        // opposite direction to the missing material.
        const weight = (index === 0 ? 1 : -1) * Math.abs(doubleArea / 2);

        area += weight;
        x += weight * centreX;
        y += weight * centreY;
      }
    }

    if (area === 0) return null;
    return [x / area, y / area];
  }

  const lines = linesOf(geometry);
  if (lines.length > 0) {
    let length = 0;
    let x = 0;
    let y = 0;
    for (const line of lines) {
      for (let index = 0; index + 1 < line.length; index++) {
        const segment = Math.hypot(line[index + 1][0] - line[index][0], line[index + 1][1] - line[index][1]);
        length += segment;
        x += ((line[index][0] + line[index + 1][0]) / 2) * segment;
        y += ((line[index][1] + line[index + 1][1]) / 2) * segment;
      }
    }
    if (length === 0) return null;
    return [x / length, y / length];
  }

  const points = allPositions(geometry);
  if (points.length === 0) return null;
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
}

/** The bounding box, as a closed ring. */
export function envelopeOf(geometry: CirGeometry | null): Position[] | null {
  const bounds = geometryBounds(geometry);
  if (!isFiniteBounds(bounds)) return null;
  const { minX, minY, maxX, maxY } = bounds;
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

/** Every linear run in a geometry. Polygon rings are not included. */
export function linesOf(geometry: CirGeometry | null): Position[][] {
  if (!geometry) return [];
  switch (geometry.type) {
    case 'LineString':
      return [geometry.coordinates as Position[]];
    case 'MultiLineString':
      return geometry.coordinates as Position[][];
    case 'GeometryCollection':
      return (geometry.geometries ?? []).flatMap((child) => linesOf(child));
    default:
      return [];
  }
}

/**
 * Splits a multipart geometry into its parts.
 *
 * A multipart feature carries ONE attribute row for several geometries, so
 * exploding it copies that row onto each part — which is right, and worth
 * saying, because the copies are then indistinguishable from separately
 * surveyed features.
 */
export function explodeGeometry(geometry: CirGeometry | null): CirGeometry[] {
  if (!geometry) return [];
  const dimension = geometry.dimension;

  switch (geometry.type) {
    case 'MultiPoint':
      return (geometry.coordinates as Position[]).map((position) => ({ type: 'Point', coordinates: position, dimension }));
    case 'MultiLineString':
      return (geometry.coordinates as Position[][]).map((line) => ({ type: 'LineString', coordinates: line, dimension }));
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).map((polygon) => ({ type: 'Polygon', coordinates: polygon, dimension }));
    case 'GeometryCollection':
      return (geometry.geometries ?? []).flatMap((child) => explodeGeometry(child));
    default:
      return [geometry];
  }
}

/** Gathers single parts of one kind into a single multipart geometry. */
export function toMultipart(geometries: CirGeometry[]): CirGeometry | null {
  const parts = geometries.filter((geometry): geometry is CirGeometry => geometry !== null);
  if (parts.length === 0) return null;
  const dimension = Math.max(...parts.map((part) => part.dimension)) as 2 | 3 | 4;

  const kinds = new Set(parts.map((part) => part.type.replace(/^Multi/, '')));
  if (kinds.size !== 1) {
    // Mixed kinds cannot be one multipart geometry in any format this tool
    // writes, so they stay a collection rather than being silently coerced.
    return { type: 'GeometryCollection', geometries: parts, dimension };
  }

  const kind = [...kinds][0];
  const coordinates = parts.flatMap((part) =>
    part.type.startsWith('Multi') ? (part.coordinates as unknown[]) : [part.coordinates as unknown]
  );

  if (kind === 'Point') return { type: 'MultiPoint', coordinates, dimension };
  if (kind === 'LineString') return { type: 'MultiLineString', coordinates, dimension };
  if (kind === 'Polygon') return { type: 'MultiPolygon', coordinates, dimension };
  return { type: 'GeometryCollection', geometries: parts, dimension };
}

// ===========================================================================
// Line operations
// ===========================================================================

const KEY_PRECISION = 1e9;
const endpointKey = (position: Position): string =>
  `${Math.round(position[0] * KEY_PRECISION)},${Math.round(position[1] * KEY_PRECISION)}`;

/**
 * Joins lines that share an endpoint into the longest runs possible.
 *
 * The CAD clean-up that turns a boundary drawn as forty separate segments into
 * one polyline. Junctions where THREE or more lines meet are left alone: picking
 * a continuation there would be inventing a topology decision, and the two
 * possible answers describe different networks.
 */
export function mergeLines(lines: Position[][]): { merged: Position[][]; junctions: number } {
  const usable = lines.filter((line) => line.length >= 2);
  const byEnd = new Map<string, number[]>();

  for (const [index, line] of usable.entries()) {
    for (const key of [endpointKey(line[0]), endpointKey(line[line.length - 1])]) {
      byEnd.set(key, [...(byEnd.get(key) ?? []), index]);
    }
  }

  let junctions = 0;
  for (const [, indices] of byEnd) if (indices.length > 2) junctions++;

  const used = new Set<number>();
  const merged: Position[][] = [];

  for (const [index, line] of usable.entries()) {
    if (used.has(index)) continue;
    used.add(index);
    let run = [...line];

    // Extend from both ends until nothing single-valued continues the run.
    for (const atEnd of [true, false]) {
      for (;;) {
        const tip = atEnd ? run[run.length - 1] : run[0];
        const candidates = (byEnd.get(endpointKey(tip)) ?? []).filter((candidate) => !used.has(candidate));
        // Exactly one continuation, and the junction must not be shared by more.
        if (candidates.length !== 1 || (byEnd.get(endpointKey(tip)) ?? []).length > 2) break;

        const next = usable[candidates[0]];
        used.add(candidates[0]);
        const forward = endpointKey(next[0]) === endpointKey(tip);
        const addition = forward ? next.slice(1) : [...next].reverse().slice(1);
        run = atEnd ? [...run, ...addition] : [...[...addition].reverse(), ...run];
      }
    }

    merged.push(run);
  }

  return { merged, junctions };
}

/**
 * The part of a line between two distances along it.
 *
 * Distances are measured along the line in dataset units, and the cut points are
 * INTERPOLATED, so the result carries vertices the source never had. Z is
 * interpolated with them when present, because a chainage on a graded road does
 * have a defined level, unlike a boolean's crossing point.
 */
export function lineSubstring(positions: Position[], fromDistance: number, toDistance: number): Position[] {
  if (positions.length < 2) return [];
  const start = Math.max(0, Math.min(fromDistance, toDistance));
  const end = Math.max(fromDistance, toDistance);
  if (end <= start) return [];

  const out: Position[] = [];
  let travelled = 0;

  for (let index = 0; index + 1 < positions.length; index++) {
    const a = positions[index];
    const b = positions[index + 1];
    const segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (segment === 0) continue;

    const segmentEnd = travelled + segment;
    if (segmentEnd >= start && travelled <= end) {
      const enter = Math.max(start, travelled);
      const leave = Math.min(end, segmentEnd);
      const first = interpolate(a, b, (enter - travelled) / segment);
      const last = interpolate(a, b, (leave - travelled) / segment);

      if (out.length === 0) out.push(first);
      const previous = out[out.length - 1];
      if (previous[0] !== last[0] || previous[1] !== last[1]) out.push(last);
    }

    travelled = segmentEnd;
    if (travelled >= end) break;
  }

  return out;
}

function interpolate(a: Position, b: Position, t: number): Position {
  const point: Position = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  if (a.length > 2 && b.length > 2) point.push(a[2] + (b[2] - a[2]) * t);
  return point;
}

/** Total length of a run, in dataset units. */
export function lineLength(positions: Position[]): number {
  let total = 0;
  for (let index = 0; index + 1 < positions.length; index++) {
    total += Math.hypot(positions[index + 1][0] - positions[index][0], positions[index + 1][1] - positions[index][1]);
  }
  return total;
}

/**
 * Splits polygons with a cutting line.
 *
 * Implemented as a boolean against the two half-planes the line's buffer
 * separates, rather than by walking the intersections: the walk has the same
 * degeneracy problems as a hand-rolled clipper, and this reuses the machinery
 * that is already tested against them.
 *
 * The cut has zero width. `gap` exists only so the two halves do not share
 * floating-point-identical edges; it defaults to nothing and the caller should
 * leave it alone unless a downstream format cannot hold coincident boundaries.
 */
export function splitPolygonByLine(polygons: MultiPoly, cut: Position[], gap = 0): MultiPoly[] {
  if (cut.length < 2 || polygons.length === 0) return [polygons];

  // A blade long enough to cross the whole polygon, so an under-length cutting
  // line still separates the parts it was drawn to separate.
  const extended = extendLine(cut, boundsDiagonal(polygons));
  const blade = bufferGeometry({ type: 'LineString', coordinates: extended, dimension: 2 }, Math.max(gap, 1e-9), {
    cap: 'square',
    join: 'round',
  });

  const left = booleanOperation(polygons, blade.polygons, 'difference');
  // Each connected piece of the remainder is one side of the cut.
  return left.polygons.map((polygon) => [polygon]);
}

function boundsDiagonal(polygons: MultiPoly): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rings of polygons) {
    for (const position of rings[0] ?? []) {
      minX = Math.min(minX, position[0]);
      maxX = Math.max(maxX, position[0]);
      minY = Math.min(minY, position[1]);
      maxY = Math.max(maxY, position[1]);
    }
  }
  return Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY) : 0;
}

/** Extends a polyline past both ends by `by`, along its terminal directions. */
function extendLine(positions: Position[], by: number): Position[] {
  if (positions.length < 2 || by <= 0) return positions;
  const out = positions.map((position) => [position[0], position[1]] as Position);

  const lead = direction(out[1], out[0]);
  out[0] = [out[0][0] + lead[0] * by, out[0][1] + lead[1] * by];

  const tail = direction(out[out.length - 2], out[out.length - 1]);
  out[out.length - 1] = [out[out.length - 1][0] + tail[0] * by, out[out.length - 1][1] + tail[1] * by];

  return out;
}

function direction(from: Position, to: Position): Position {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  return length === 0 ? [0, 0] : [dx / length, dy / length];
}

// ===========================================================================
// The plan layer
// ===========================================================================

export type GeometryOperation =
  | 'buffer'
  | 'offset'
  | 'union'
  | 'intersection'
  | 'difference'
  | 'symmetric-difference'
  | 'convex-hull'
  | 'dissolve'
  | 'centroid'
  | 'envelope'
  | 'clip'
  | 'erase'
  | 'split-by-line'
  | 'line-merge'
  | 'explode'
  | 'multipart'
  // Rigid transforms. These move geometry without changing its shape, which is
  // what a georeferencing correction is.
  | 'translate'
  | 'scale'
  | 'rotate';

export const GEOMETRY_LABEL: Record<GeometryOperation, string> = {
  buffer: 'Buffer',
  offset: 'Offset',
  union: 'Union',
  intersection: 'Intersection',
  difference: 'Difference',
  'symmetric-difference': 'Symmetric difference',
  'convex-hull': 'Convex hull',
  dissolve: 'Dissolve',
  centroid: 'Centroid',
  envelope: 'Envelope',
  clip: 'Clip',
  erase: 'Erase',
  'split-by-line': 'Split by line',
  'line-merge': 'Merge lines',
  explode: 'Explode multipart',
  multipart: 'Combine into multipart',
  translate: 'Move',
  scale: 'Scale',
  rotate: 'Rotate',
};

/** Operations whose parameter is a length in dataset units. */
const DISTANCE_OPERATIONS = new Set<GeometryOperation>(['buffer', 'offset']);

/**
 * Which side of a polygon an offset goes.
 *
 * `signed` keeps the sign-of-the-distance behaviour a line offset has always
 * had, so no stored command changes meaning. The other three are the polygon
 * forms the owner asked for.
 */
export type OffsetSide = 'signed' | 'inside' | 'outside' | 'both';

export const OFFSET_SIDE_LABEL: Record<OffsetSide, string> = {
  signed: 'By the sign of the distance',
  inside: 'Inside (a building line or setback)',
  outside: 'Outside (a right of way)',
  both: 'Both sides (a corridor)',
};

export interface GeometryPlan {
  operation: GeometryOperation;
  layer: string;
  /** The layer the result becomes. Absent means the source layer is replaced. */
  outputLayer?: string;
  /** The features the operation produces, ready to apply. */
  features: CirFeature[];
  /** How many source features contributed. */
  consumed: number;
  notes: string[];
  refusal?: { what: string; why: string; action: string };
}

export interface GeometryOptions {
  protectedLayers: string[];
  /** Restrict the operation to these feature indices. */
  scope?: number[];
  /** Needed by every distance operation, to decide whether it may run at all. */
  crs?: CrsRef | null;
  distance?: number;
  /** Field to group by, for dissolve. */
  field?: string;
  /** The masking layer, for clip and erase. */
  maskLayer?: string;
  buffer?: Partial<BufferOptions>;
  cut?: Position[];
  /** Write the result to a new layer rather than replacing the source. */
  outputLayer?: string;

  /**
   * How far to move, in DATASET UNITS, for `translate`.
   *
   * Dataset units and not metres, deliberately: a drag on the canvas is
   * measured in the coordinates the canvas is drawing, and converting to metres
   * and back would introduce a rounding the user never asked for. What the
   * units MEAN is stated in the plan's notes instead, which is where it
   * matters — 0.0001 is a hundred metres in UTM and eleven metres in degrees.
   */
  offset?: [number, number];

  /**
   * Scale factors for `scale`. A single number scales both axes equally.
   *
   * Non-uniform scaling is offered because a scanned sheet stretched by its
   * scanner is stretched along one axis, and forcing a uniform factor would
   * make that uncorrectable.
   */
  factor?: number | [number, number];

  /** Clockwise rotation in degrees, for `rotate`. */
  angleDegrees?: number;

  /**
   * Which side of a POLYGON an offset goes, for `offset`.
   *
   * `signed` is the original behaviour and stays the default: the sign of the
   * distance decides, which is what a line offset means and what every command
   * already stored expects. `inside`, `outside` and `both` are the polygon
   * forms — a building line, a right-of-way, a corridor — and use the MAGNITUDE
   * of the distance rather than its sign, so "3 m inside" cannot be turned
   * outwards by a stray minus.
   */
  side?: OffsetSide;

  /**
   * The fixed point of a scale or a rotation.
   *
   * Absent means the centre of the affected features' bounding box, which is
   * computed and then RECORDED in the notes rather than left implicit: the
   * same rotation about two different anchors produces two different results,
   * and a report that does not say which was used cannot be checked.
   */
  anchor?: Position;
}

function refuse(
  operation: GeometryOperation,
  layer: string,
  what: string,
  why: string,
  action: string
): GeometryPlan {
  return { operation, layer, features: [], consumed: 0, notes: [], refusal: { what, why, action } };
}

/**
 * Whether a distance in dataset units means what the user thinks it means.
 *
 * See the header. This is the single most valuable check in the module.
 */
function crsGate(operation: GeometryOperation, layer: string, crs: CrsRef | null | undefined): GeometryPlan | null {
  if (!DISTANCE_OPERATIONS.has(operation)) return null;

  if (!crs) {
    return refuse(
      operation,
      layer,
      `${GEOMETRY_LABEL[operation]} needs to know what the coordinates mean.`,
      'This dataset declares no CRS, so a distance here is a number of unknown units — it could be metres, feet or degrees.',
      'Set the source CRS in the CRS tab, then run the operation again.'
    );
  }

  if (crs.kind === 'geographic') {
    return refuse(
      operation,
      layer,
      `${GEOMETRY_LABEL[operation]} cannot run on a geographic CRS.`,
      `Coordinates here are degrees of latitude and longitude, so a distance of 10 would mean 10 DEGREES — about 1,100 km, not 10 metres. ` +
        'The result would look like a plausible polygon and be wrong by five orders of magnitude.',
      'Reproject to a projected CRS first — a UTM zone covering the site is the usual choice — then buffer in metres.'
    );
  }

  return null;
}

function layerOf(dataset: CirDataset, name: string): CirLayer | undefined {
  return dataset.layers.find((candidate) => candidate.name === name);
}

function scopedFeatures(layer: CirLayer, scope?: number[]): CirFeature[] {
  if (!scope) return layer.features;
  return scope.map((index) => layer.features[index]).filter((feature): feature is CirFeature => feature !== undefined);
}

/**
 * Plans one geometry operation.
 *
 * Nothing is applied here: the returned plan carries the features it would
 * produce, so the caller can draw them over the source before committing. That
 * is what "preview before commit" in §26.2 asks for, and it is the same
 * contract every other editing engine in this codebase uses.
 */
export function planGeometryOperation(
  dataset: CirDataset,
  layerName: string,
  operation: GeometryOperation,
  options: Partial<GeometryOptions> = {}
): GeometryPlan {
  const protectedLayers = options.protectedLayers ?? [];
  if (protectedLayers.includes(layerName)) {
    return refuse(
      operation,
      layerName,
      `${layerName} is protected, so its geometry was not changed.`,
      'The layer is marked legally operative — its geometry is part of a record, not a working file.',
      'Remove the layer from the protected list if you genuinely intend to change it.'
    );
  }

  const layer = layerOf(dataset, layerName);
  if (!layer) {
    return refuse(operation, layerName, 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');
  }

  const gate = crsGate(operation, layerName, options.crs);
  if (gate) return gate;

  const features = scopedFeatures(layer, options.scope);
  if (features.length === 0) {
    return refuse(operation, layerName, 'There is nothing to operate on.', 'The layer, or the selection, is empty.', 'Select at least one feature.');
  }

  const notes: string[] = [];
  const droppedZ = features.some((feature) => hasZ(feature.geometry));

  switch (operation) {
    case 'buffer':
      return planBuffer(layerName, features, options, notes);
    case 'offset':
      return planOffset(layerName, features, options, notes);
    case 'convex-hull':
      return planHull(layerName, features, options, notes);
    case 'centroid':
      return planCentroid(layerName, features, options, notes);
    case 'envelope':
      return planEnvelope(layerName, features, options, notes);
    case 'explode':
      return planExplode(layerName, features, options, notes);
    case 'multipart':
      return planMultipart(layerName, features, options, notes);
    case 'line-merge':
      return planLineMerge(layerName, features, options, notes);
    case 'translate':
    case 'scale':
    case 'rotate':
      return planTransform(layerName, features, operation, options, notes);
    case 'union':
    case 'intersection':
    case 'difference':
    case 'symmetric-difference':
      return planSelfBoolean(layerName, features, operation, options, notes, droppedZ);
    case 'dissolve':
      return planDissolve(layerName, features, options, notes, droppedZ);
    case 'clip':
    case 'erase':
      return planMasked(dataset, layerName, features, operation, options, notes, droppedZ);
    case 'split-by-line':
      return planSplit(layerName, features, options, notes, droppedZ);
    default:
      return refuse(operation, layerName, 'That operation is not available.', 'It is not implemented.', 'Choose another operation.');
  }
}

// --------------------------------------------------------------- per-operation

function output(
  operation: GeometryOperation,
  layer: string,
  features: CirFeature[],
  consumed: number,
  notes: string[],
  options: Partial<GeometryOptions>
): GeometryPlan {
  return { operation, layer, outputLayer: options.outputLayer, features, consumed, notes };
}

function planBuffer(
  layerName: string,
  features: CirFeature[],
  options: Partial<GeometryOptions>,
  notes: string[]
): GeometryPlan {
  const distance = options.distance ?? 0;
  if (distance === 0) {
    return refuse('buffer', layerName, 'A buffer needs a distance.', 'The distance is zero.', 'Enter a distance in the dataset’s units.');
  }

  const out: CirFeature[] = [];
  let erased = 0;

  for (const feature of features) {
    const result = bufferGeometry(feature.geometry, distance, options.buffer);
    if (result.erased || result.polygons.length === 0) {
      erased++;
      continue;
    }
    out.push({ ...feature, geometry: fromMultiPolygon(result.polygons) });
  }

  if (erased > 0) {
    notes.push(
      `${erased} feature(s) disappeared: a negative buffer removes everything within ${Math.abs(distance)} of an edge, and these were narrower than twice that.`
    );
  }
  if (features.some((feature) => hasZ(feature.geometry))) {
    notes.push('A buffer is a planar operation, so the result carries no Z.');
  }

  return output('buffer', layerName, out, features.length, notes, options);
}

/**
 * Offsets lines by the signed distance, and polygons inside, outside or both.
 *
 * ---------------------------------------------------------------------------
 * WHY A POLYGON OFFSET IS A DIFFERENT OPERATION FROM A LINE OFFSET
 *
 * A line has two sides and the sign of the distance chooses one. A polygon has
 * an INSIDE and an OUTSIDE, and "offset by −2" does not obviously mean either
 * of them to the person typing it. The owner asked for exactly the polygon
 * form — "if user want to make offset inside or outside then user can also able
 * to do different kind of offset" — which is a building line or a setback, the
 * commonest thing a cadastral drawing needs.
 *
 * So `side` names it. `inside` and `outside` produce the setback boundary as a
 * LINE, because that is what it is: a parcel with a 3 m building line is one
 * parcel and one line, not two overlapping parcels. `both` produces both, which
 * is how a right-of-way corridor is drawn.
 *
 * The polygon path runs through `bufferGeometry` rather than through new
 * offsetting code. That engine already handles the two things that make an
 * inward offset hard — a shape narrower than twice the distance collapsing
 * entirely, and rings that merge as they grow — and a second implementation
 * would only be a second place for those to be got wrong.
 */
function planOffset(
  layerName: string,
  features: CirFeature[],
  options: Partial<GeometryOptions>,
  notes: string[]
): GeometryPlan {
  const distance = options.distance ?? 0;
  if (distance === 0) {
    return refuse('offset', layerName, 'An offset needs a distance.', 'The distance is zero.', 'Enter a distance; the sign chooses the side.');
  }

  const side: OffsetSide = options.side ?? 'signed';
  const out: CirFeature[] = [];
  let cusps = 0;
  let collapsed = 0;
  let lineFeatures = 0;
  let polygonFeatures = 0;

  for (const feature of features) {
    const lines = linesOf(feature.geometry);
    if (lines.length > 0) {
      lineFeatures++;
      // A line offset ignores `side`: inside and outside are not defined for
      // something that encloses nothing, and quietly reinterpreting them as
      // left and right would put the setback on whichever side the line
      // happened to be digitised towards.
      const offsets = lines.map((line) => offsetLine(line, distance, options.buffer));
      if (offsets.some((result) => result.selfIntersects)) cusps++;

      const coordinates = offsets.map((result) => result.positions).filter((positions) => positions.length >= 2);
      if (coordinates.length === 0) continue;

      out.push({ ...feature, geometry: linesGeometry(coordinates) });
      continue;
    }

    const rings = toMultiPolygon(feature.geometry);
    if (rings.length === 0) continue;
    polygonFeatures++;

    const magnitude = Math.abs(distance);
    const wanted: number[] =
      side === 'inside'
        ? [-magnitude]
        : side === 'outside'
          ? [magnitude]
          : side === 'both'
            ? [-magnitude, magnitude]
            : [distance];

    const produced: Position[][] = [];
    let lostOne = false;
    for (const signed of wanted) {
      const result = bufferGeometry(feature.geometry, signed, options.buffer);
      if (result.erased || result.polygons.length === 0) {
        lostOne = true;
        continue;
      }
      // The boundary of the buffered shape IS the offset line, including the
      // boundaries of any holes, which is right: a setback inside a parcel with
      // a courtyard has a line around the courtyard too.
      for (const polygon of result.polygons) for (const ring of polygon) produced.push(ring);
    }
    if (lostOne) collapsed++;
    if (produced.length === 0) continue;

    out.push({ ...feature, geometry: linesGeometry(produced) });
  }

  if (out.length === 0) {
    return refuse(
      'offset',
      layerName,
      'Nothing here could be offset.',
      lineFeatures + polygonFeatures === 0
        ? 'An offset applies to lines and polygons, and this selection has neither.'
        : 'Every feature collapsed: an inward offset removes everything within the distance of an edge, and these were narrower than twice it.',
      lineFeatures + polygonFeatures === 0 ? 'Select a line or polygon layer.' : 'Use a smaller distance.'
    );
  }
  if (cusps > 0) {
    notes.push(
      `${cusps} offset line(s) cross themselves, because the source turns tighter than the offset distance. The loop is left in rather than removed — which side of a cusp to keep is a drafting decision.`
    );
  }
  if (collapsed > 0) {
    notes.push(
      `${collapsed} polygon(s) produced no inward offset: they are narrower than twice ${Math.abs(distance)}, so a setback that far in leaves nothing.`
    );
  }
  if (polygonFeatures > 0) {
    notes.push(
      `${polygonFeatures.toLocaleString()} polygon(s) offset ${side === 'both' ? 'inside and outside' : side === 'signed' ? (distance < 0 ? 'inwards' : 'outwards') : side}, produced as lines — a setback is a line on the parcel, not a second parcel.`
    );
  }

  return output('offset', layerName, out, features.length, notes, options);
}

/** One line or several, as the geometry type the count calls for. */
function linesGeometry(coordinates: Position[][]): CirGeometry {
  return coordinates.length === 1
    ? { type: 'LineString', coordinates: coordinates[0], dimension: 2 }
    : { type: 'MultiLineString', coordinates, dimension: 2 };
}

function planHull(layerName: string, features: CirFeature[], options: Partial<GeometryOptions>, notes: string[]): GeometryPlan {
  const positions = features.flatMap((feature) => allPositions(feature.geometry));
  const hull = convexHull(positions);
  if (hull.length < 4) {
    return refuse('convex-hull', layerName, 'These features have no hull.', 'They are collinear or coincident, so they enclose no area.', 'Include features that are not all on one line.');
  }

  notes.push(`${features.length.toLocaleString()} feature(s) reduced to one hull of ${hull.length - 1} vertices.`);
  return output(
    'convex-hull',
    layerName,
    [{ geometry: { type: 'Polygon', coordinates: [hull], dimension: 2 }, properties: {} }],
    features.length,
    notes,
    options
  );
}

function planCentroid(layerName: string, features: CirFeature[], options: Partial<GeometryOptions>, notes: string[]): GeometryPlan {
  const out: CirFeature[] = [];
  let skipped = 0;

  for (const feature of features) {
    const centroid = centroidOf(feature.geometry);
    if (!centroid) {
      skipped++;
      continue;
    }
    out.push({ ...feature, geometry: { type: 'Point', coordinates: centroid, dimension: 2 } });
  }

  if (skipped > 0) notes.push(`${skipped} feature(s) have no centroid — they enclose no area and have no length.`);
  notes.push('Polygon centroids are area-weighted, so a centroid can fall outside a concave parcel. That is correct, and it is not a point inside the plot.');
  return output('centroid', layerName, out, features.length, notes, options);
}

function planEnvelope(layerName: string, features: CirFeature[], options: Partial<GeometryOptions>, notes: string[]): GeometryPlan {
  const out: CirFeature[] = [];
  for (const feature of features) {
    const ring = envelopeOf(feature.geometry);
    if (!ring) continue;
    out.push({ ...feature, geometry: { type: 'Polygon', coordinates: [ring], dimension: 2 } });
  }
  return output('envelope', layerName, out, features.length, notes, options);
}

function planExplode(layerName: string, features: CirFeature[], options: Partial<GeometryOptions>, notes: string[]): GeometryPlan {
  const out: CirFeature[] = [];
  let multipart = 0;

  for (const feature of features) {
    const parts = explodeGeometry(feature.geometry);
    if (parts.length > 1) multipart++;
    for (const part of parts) out.push({ ...feature, geometry: part });
  }

  if (multipart > 0) {
    notes.push(
      `${multipart} multipart feature(s) became ${out.length - (features.length - multipart)} single parts, each carrying a COPY of the original attribute row. The copies are indistinguishable from separately surveyed features afterwards.`
    );
  }
  return output('explode', layerName, out, features.length, notes, options);
}

function planMultipart(layerName: string, features: CirFeature[], options: Partial<GeometryOptions>, notes: string[]): GeometryPlan {
  const field = options.field;
  const groups = new Map<string, CirFeature[]>();

  for (const feature of features) {
    const key = field ? String(feature.properties?.[field] ?? '(empty)') : '__all__';
    groups.set(key, [...(groups.get(key) ?? []), feature]);
  }

  const out: CirFeature[] = [];
  for (const [, group] of groups) {
    const geometry = toMultipart(group.map((feature) => feature.geometry).filter((g): g is CirGeometry => g !== null));
    if (!geometry) continue;
    // The first feature's attributes represent the group; the rest are dropped,
    // which is the whole cost of combining and so is stated.
    out.push({ ...group[0], geometry });
  }

  notes.push(
    field
      ? `Grouped by "${field}" into ${out.length} multipart feature(s). Each keeps the attributes of its first member; the others are discarded.`
      : `Combined into ${out.length} multipart feature(s), keeping the first feature's attributes only.`
  );
  return output('multipart', layerName, out, features.length, notes, options);
}

function planLineMerge(layerName: string, features: CirFeature[], options: Partial<GeometryOptions>, notes: string[]): GeometryPlan {
  const lines = features.flatMap((feature) => linesOf(feature.geometry));
  if (lines.length === 0) {
    return refuse('line-merge', layerName, 'There are no lines to merge.', 'This selection holds no linear geometry.', 'Select a line layer.');
  }

  const { merged, junctions } = mergeLines(lines);
  if (junctions > 0) {
    notes.push(
      `${junctions} junction(s) where three or more lines meet were left unmerged: choosing a continuation there would be inventing a topology decision.`
    );
  }
  notes.push(`${lines.length.toLocaleString()} line(s) merged into ${merged.length.toLocaleString()}. Attributes are not carried over — a merged run may come from several source rows.`);

  return output(
    'line-merge',
    layerName,
    merged.map((positions) => ({ geometry: { type: 'LineString' as const, coordinates: positions, dimension: 2 as const }, properties: {} })),
    features.length,
    notes,
    options
  );
}

const BOOLEAN_FOR: Record<string, BooleanOp> = {
  union: 'union',
  intersection: 'intersection',
  difference: 'difference',
  'symmetric-difference': 'xor',
};

/** Folds one layer's polygons together with a boolean. */
function planSelfBoolean(
  layerName: string,
  features: CirFeature[],
  operation: GeometryOperation,
  options: Partial<GeometryOptions>,
  notes: string[],
  droppedZ: boolean
): GeometryPlan {
  const polygons = features.map((feature) => toMultiPolygon(feature.geometry)).filter((multi) => multi.length > 0);
  if (polygons.length === 0) {
    return refuse(operation, layerName, 'There are no polygons here.', `${GEOMETRY_LABEL[operation]} applies to polygons.`, 'Select a polygon layer.');
  }
  if (polygons.length < 2 && operation !== 'union') {
    return refuse(operation, layerName, `${GEOMETRY_LABEL[operation]} needs at least two polygons.`, `${polygons.length} was selected.`, 'Select more features.');
  }

  let accumulated = polygons[0];
  let slivers = 0;
  for (let index = 1; index < polygons.length; index++) {
    const step = booleanOperation(accumulated, polygons[index], BOOLEAN_FOR[operation]);
    accumulated = step.polygons;
    slivers += step.report.slivers;
  }

  if (accumulated.length === 0) {
    notes.push(`${GEOMETRY_LABEL[operation]} of these features encloses no area.`);
  }
  if (droppedZ) notes.push('Boolean operations are planar: the result carries no Z, because a vertex where two boundaries cross has no elevation in either input.');
  if (slivers > 0) notes.push(`${slivers} zero-area ring(s) were discarded.`);

  const geometry = fromMultiPolygon(accumulated);
  return output(operation, layerName, geometry ? [{ geometry, properties: { ...features[0].properties } }] : [], features.length, notes, options);
}

function planDissolve(
  layerName: string,
  features: CirFeature[],
  options: Partial<GeometryOptions>,
  notes: string[],
  droppedZ: boolean
): GeometryPlan {
  const field = options.field;
  const groups = new Map<string, CirFeature[]>();

  for (const feature of features) {
    const key = field ? String(feature.properties?.[field] ?? '(empty)') : '__all__';
    groups.set(key, [...(groups.get(key) ?? []), feature]);
  }

  const out: CirFeature[] = [];
  let slivers = 0;

  for (const [key, group] of groups) {
    const polygons = group.map((feature) => toMultiPolygon(feature.geometry)).filter((multi) => multi.length > 0);
    if (polygons.length === 0) continue;

    const merged = unionAll(polygons);
    slivers += merged.report.slivers;

    const geometry = fromMultiPolygon(merged.polygons);
    if (!geometry) continue;

    // Only the grouping field survives: every other attribute described one of
    // the parcels that no longer exists separately.
    const properties = field ? { [field]: key === '(empty)' ? null : group[0].properties?.[field] } : {};
    out.push({ geometry, properties });
  }

  notes.push(
    field
      ? `${features.length.toLocaleString()} feature(s) dissolved into ${out.length} by "${field}". Only "${field}" is kept: every other attribute described a parcel that no longer exists on its own.`
      : `${features.length.toLocaleString()} feature(s) dissolved into ${out.length}. Attributes are not carried over.`
  );
  if (droppedZ) notes.push('Dissolve is planar: the result carries no Z.');
  if (slivers > 0) notes.push(`${slivers} zero-area ring(s) were discarded.`);

  return output('dissolve', layerName, out, features.length, notes, options);
}

function planMasked(
  dataset: CirDataset,
  layerName: string,
  features: CirFeature[],
  operation: GeometryOperation,
  options: Partial<GeometryOptions>,
  notes: string[],
  droppedZ: boolean
): GeometryPlan {
  const maskName = options.maskLayer;
  if (!maskName) {
    return refuse(operation, layerName, `${GEOMETRY_LABEL[operation]} needs a second layer.`, 'No masking layer was chosen.', 'Pick the layer to use as the boundary.');
  }
  if (maskName === layerName) {
    return refuse(operation, layerName, 'The mask cannot be the layer being changed.', 'Clipping a layer by itself returns the layer unchanged.', 'Pick a different layer.');
  }

  const mask = layerOf(dataset, maskName);
  if (!mask) {
    return refuse(operation, layerName, `The masking layer "${maskName}" could not be found.`, 'It is not in this dataset.', 'Reselect the layer.');
  }

  const maskPolygons = unionAll(mask.features.map((feature) => toMultiPolygon(feature.geometry)).filter((multi) => multi.length > 0));
  if (maskPolygons.polygons.length === 0) {
    return refuse(operation, layerName, `"${maskName}" holds no polygons.`, 'A mask has to enclose area.', 'Pick a polygon layer as the mask.');
  }

  const op: BooleanOp = operation === 'clip' ? 'intersection' : 'difference';
  const out: CirFeature[] = [];
  let removed = 0;
  let slivers = 0;

  for (const feature of features) {
    const polygons = toMultiPolygon(feature.geometry);
    if (polygons.length === 0) continue;

    const result = booleanOperation(polygons, maskPolygons.polygons, op);
    slivers += result.report.slivers;

    const geometry = fromMultiPolygon(result.polygons);
    if (!geometry) {
      removed++;
      continue;
    }
    out.push({ ...feature, geometry });
  }

  if (removed > 0) {
    notes.push(
      operation === 'clip'
        ? `${removed} feature(s) fall entirely outside "${maskName}" and are removed.`
        : `${removed} feature(s) fall entirely inside "${maskName}" and are removed.`
    );
  }
  if (droppedZ) notes.push(`${GEOMETRY_LABEL[operation]} is planar: the result carries no Z.`);
  if (slivers > 0) notes.push(`${slivers} zero-area ring(s) were discarded.`);

  return output(operation, layerName, out, features.length, notes, options);
}

function planSplit(
  layerName: string,
  features: CirFeature[],
  options: Partial<GeometryOptions>,
  notes: string[],
  droppedZ: boolean
): GeometryPlan {
  const cut = options.cut;
  if (!cut || cut.length < 2) {
    return refuse('split-by-line', layerName, 'A split needs a cutting line.', 'No line was given, or it has fewer than two points.', 'Draw the cut on the canvas.');
  }

  const out: CirFeature[] = [];
  let split = 0;

  for (const feature of features) {
    const polygons = toMultiPolygon(feature.geometry);
    if (polygons.length === 0) {
      out.push(feature);
      continue;
    }

    const parts = splitPolygonByLine(polygons, cut);
    if (parts.length > 1) split++;
    for (const part of parts) {
      const geometry = fromMultiPolygon(part);
      if (geometry) out.push({ ...feature, geometry });
    }
  }

  notes.push(
    split > 0
      ? `${split} feature(s) were split, and each part carries a COPY of the original attribute row — including its area field, which is now wrong for both parts.`
      : 'The cutting line does not cross any of these features, so nothing was split.'
  );
  if (droppedZ) notes.push('Splitting is planar: the parts carry no Z.');

  return output('split-by-line', layerName, out, features.length, notes, options);
}

// ===========================================================================
// Apply
// ===========================================================================

export interface GeometryApplyResult {
  dataset: CirDataset;
  plan: GeometryPlan;
  /** The layers as they were, so the operation can be reversed. */
  before: CirLayer[];
}

/**
 * Applies a plan.
 *
 * With `outputLayer` the result becomes a NEW layer and the source is untouched,
 * which is the safe default for anything destructive — a clip that replaced its
 * source would discard the parcels outside the boundary with no way back except
 * the history.
 */
export function applyGeometryOperation(dataset: CirDataset, plan: GeometryPlan): GeometryApplyResult {
  const before = dataset.layers;
  if (plan.refusal) return { dataset, plan, before };

  if (plan.outputLayer) {
    const source = layerOf(dataset, plan.layer);
    const created: CirLayer = {
      name: plan.outputLayer,
      path: [...(source?.path.slice(0, -1) ?? []), plan.outputLayer],
      features: plan.features,
      fields: source?.fields ?? [],
      geometryTypes: collectGeometryTypes(plan.features),
      style: source?.style,
    };
    return { dataset: { ...dataset, layers: [...before, created] }, plan, before };
  }

  const layers = before.map((layer) =>
    layer.name === plan.layer
      ? { ...layer, features: plan.features, geometryTypes: collectGeometryTypes(plan.features) }
      : layer
  );
  return { dataset: { ...dataset, layers }, plan, before };
}

export function undoGeometryOperation(dataset: CirDataset, result: GeometryApplyResult): CirDataset {
  return { ...dataset, layers: result.before };
}

/** A one-line account of a plan, for the confirmation prompt. */
export function describeGeometryPlan(plan: GeometryPlan): string {
  if (plan.refusal) return `${plan.refusal.what} ${plan.refusal.why} ${plan.refusal.action}`;
  const head = `${GEOMETRY_LABEL[plan.operation]}: ${plan.consumed.toLocaleString()} feature(s) → ${plan.features.length.toLocaleString()}`;
  return plan.notes.length > 0 ? `${head}. ${plan.notes.join(' ')}` : `${head}.`;
}

/** Total area of a plan's polygonal output, for a before-and-after readout. */
export function planArea(plan: GeometryPlan): number {
  let total = 0;
  for (const feature of plan.features) {
    for (const rings of toMultiPolygon(feature.geometry)) {
      total += Math.abs(signedArea(rings[0]));
      for (let index = 1; index < rings.length; index++) total -= Math.abs(signedArea(rings[index]));
    }
  }
  return total;
}

// ------------------------------------------------------------------ transforms

/**
 * Moves, scales or rotates features without changing their shape.
 *
 * WHY THESE ARE OPERATIONS AND NOT CANVAS MUTATIONS. Dragging a selection over
 * a basemap to correct a georeferencing shift is the motivating case, and the
 * workspace only holds a 5,000-feature preview of each layer. A drag that
 * edited the preview would export an eighth of a 40,000-parcel correction and
 * look completely right on screen while doing it. Recording the INTENT —
 * "translate by (dx, dy)" — and replaying it against the full dataset at
 * conversion time is the same reasoning that makes a buffer store its distance
 * rather than its result.
 *
 * WHAT A TRANSFORM DOES NOT DO IS DECIDE WHETHER IT SHOULD HAVE HAPPENED. A
 * survey that looks shifted against OpenStreetMap has three possible causes: a
 * wrong or missing datum shift, a local grid with no relationship to WGS 84, or
 * a basemap that is simply imprecise. Only the middle one is fixed by dragging;
 * in the first the CRS is wrong and in the third the survey is right. This tool
 * cannot tell them apart, so it applies what it was asked for and RECORDS the
 * exact offset, and the conversion report carries it.
 */
function planTransform(
  layerName: string,
  features: CirFeature[],
  operation: GeometryOperation,
  options: Partial<GeometryOptions>,
  notes: string[]
): GeometryPlan {
  // No empty-scope guard here: `planGeometryOperation` already refuses an empty
  // selection for every operation, before the switch reaches this function. A
  // second check would be unreachable, and unreachable code that looks like a
  // safety net is worse than none — it invites the next reader to trust it.
  const transform = transformFor(operation, features, options, notes);
  if ('refusal' in transform) {
    return refuse(operation, layerName, transform.refusal.what, transform.refusal.why, transform.refusal.action);
  }

  describeUnits(operation, options, notes);

  const moved = features.map((feature) => ({
    ...feature,
    geometry: feature.geometry ? mapPositions(feature.geometry, transform.apply) : null,
  }));

  return {
    operation,
    layer: layerName,
    outputLayer: options.outputLayer,
    features: moved,
    consumed: features.length,
    notes,
  };
}

type PlannedTransform = { apply: (position: Position) => Position } | { refusal: { what: string; why: string; action: string } };

function transformFor(
  operation: GeometryOperation,
  features: CirFeature[],
  options: Partial<GeometryOptions>,
  notes: string[]
): PlannedTransform {
  if (operation === 'translate') {
    const offset = options.offset;
    if (!offset || !Number.isFinite(offset[0]) || !Number.isFinite(offset[1])) {
      return {
        refusal: {
          what: 'No offset was given, so nothing was moved.',
          why: 'A move needs a distance in each axis, in the dataset’s own units.',
          action: 'Drag the selection on the canvas, or type an easting and northing shift.',
        },
      };
    }
    if (offset[0] === 0 && offset[1] === 0) {
      return {
        refusal: {
          what: 'The offset is zero, so nothing would move.',
          why: 'A transform that changes nothing is recorded in the history as though it did, which makes the record harder to read rather than easier.',
          action: 'Drag further, or cancel.',
        },
      };
    }
    // Z is left alone. A horizontal correction says nothing about elevation,
    // and silently moving heights would corrupt a levelling run.
    return { apply: (position) => withZ(position, position[0] + offset[0], position[1] + offset[1]) };
  }

  const anchor = options.anchor ?? centreOf(features);
  if (!anchor || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1])) {
    return {
      refusal: {
        what: 'The features have no finite extent, so there is no point to transform about.',
        why: 'Every selected feature is empty or carries non-finite coordinates.',
        action: 'Check the selection.',
      },
    };
  }
  notes.push(
    options.anchor
      ? `About the anchor given: ${anchor[0].toFixed(3)}, ${anchor[1].toFixed(3)}.`
      : `About the centre of the selection: ${anchor[0].toFixed(3)}, ${anchor[1].toFixed(3)}. The same transform about a different point gives a different result, so the point used is recorded here.`
  );

  if (operation === 'scale') {
    const raw = options.factor;
    const [fx, fy] = typeof raw === 'number' ? [raw, raw] : Array.isArray(raw) ? raw : [Number.NaN, Number.NaN];
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
      return {
        refusal: {
          what: 'No scale factor was given.',
          why: 'A scale needs a factor — 2 doubles the size, 0.5 halves it.',
          action: 'Enter a factor, or two for a non-uniform scale.',
        },
      };
    }
    if (fx === 0 || fy === 0) {
      return {
        refusal: {
          what: 'A scale factor of zero would collapse every feature to a point.',
          why: 'The result would have no area and no length, and the original coordinates would be unrecoverable.',
          action: 'Use a non-zero factor. To remove features, delete them instead.',
        },
      };
    }
    if (fx < 0 || fy < 0) {
      // A negative factor is a mirror. That is a real operation and a
      // catastrophic accident, so it is named rather than silently performed.
      notes.push(
        `A negative factor mirrors the geometry as well as scaling it${fx < 0 && fy < 0 ? '' : fx < 0 ? ', about the vertical axis' : ', about the horizontal axis'}. Ring winding is reversed by this and is not corrected.`
      );
    }
    if (fx !== fy) notes.push(`Non-uniform scale: ${fx} across, ${fy} up. Angles are not preserved and a circle becomes an ellipse.`);
    return {
      apply: (position) =>
        withZ(position, anchor[0] + (position[0] - anchor[0]) * fx, anchor[1] + (position[1] - anchor[1]) * fy),
    };
  }

  const degrees = options.angleDegrees;
  if (typeof degrees !== 'number' || !Number.isFinite(degrees)) {
    return {
      refusal: {
        what: 'No rotation angle was given.',
        why: 'A rotation needs an angle in degrees.',
        action: 'Enter an angle. Positive is clockwise, matching a survey bearing.',
      },
    };
  }
  if (degrees % 360 === 0) {
    return {
      refusal: {
        what: `A rotation of ${degrees}° leaves every coordinate where it is.`,
        why: 'The transform would be recorded in the history without changing anything.',
        action: 'Enter a different angle, or cancel.',
      },
    };
  }
  // Clockwise, because that is how a survey bearing is measured — the opposite
  // of the mathematical convention, and worth being explicit about.
  const radians = (-degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    apply: (position) => {
      const dx = position[0] - anchor[0];
      const dy = position[1] - anchor[1];
      return withZ(position, anchor[0] + dx * cos - dy * sin, anchor[1] + dx * sin + dy * cos);
    },
  };
}

/** Replaces x and y, keeping Z and M exactly as they were. */
function withZ(position: Position, x: number, y: number): Position {
  const out: Position = [x, y];
  if (position.length > 2) out.push(position[2]);
  if (position.length > 3) out.push(position[3]);
  return out;
}

/** The centre of the bounding box of everything in scope. */
function centreOf(features: CirFeature[]): Position | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const feature of features) {
    if (!feature.geometry) continue;
    eachPosition(feature.geometry, (position) => {
      if (position[0] < minX) minX = position[0];
      if (position[1] < minY) minY = position[1];
      if (position[0] > maxX) maxX = position[0];
      if (position[1] > maxY) maxY = position[1];
    });
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/**
 * Says what the numbers mean, which for a translate is the whole story.
 *
 * An offset of 0.0001 is 11 metres in degrees and a tenth of a millimetre in
 * UTM. A note that repeats the number back without its units tells the user
 * nothing they did not already type.
 */
function describeUnits(operation: GeometryOperation, options: Partial<GeometryOptions>, notes: string[]): void {
  if (operation !== 'translate' || !options.offset) return;
  const [dx, dy] = options.offset;
  const crs = options.crs;

  if (crs?.kind === 'geographic') {
    // A rough ground distance, and said to be rough. A degree of longitude
    // shortens with latitude, and this does not know the latitude.
    const metresPerDegree = 111320;
    notes.push(
      `Moved ${dx} ° east and ${dy} ° north — roughly ${(dx * metresPerDegree).toFixed(1)} m and ${(dy * metresPerDegree).toFixed(1)} m on the ground, though a degree of longitude shortens away from the equator.`
    );
    return;
  }
  const unit = crs?.unit ?? 'dataset units';
  notes.push(`Moved ${dx} ${unit} east and ${dy} ${unit} north.`);
}
