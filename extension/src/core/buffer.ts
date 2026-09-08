/**
 * Buffering and offsetting (spec §26.2).
 *
 * ---------------------------------------------------------------------------
 * HOW THIS IS BUILT, AND WHY THAT WAY
 *
 * The textbook buffer walks the boundary emitting offset segments and join arcs,
 * then untangles the self-intersections the walk creates. Untangling is the hard
 * part, and getting it subtly wrong produces a buffer with a fold in it: an area
 * that looks plausible, exports cleanly, and is wrong wherever the source
 * geometry turned sharply or a corridor was narrower than twice the distance.
 *
 * This builds the buffer as a UNION instead:
 *
 *     buffer(G, d) = ⋃ { the region swept by each segment }
 *                  ∪ G itself, when G is a polygon and d > 0
 *
 * Every piece is convex and trivially correct on its own, and `unionAll` already
 * handles overlap, containment and shared edges — the exact cases the walk gets
 * wrong. It costs more time than the walk. It cannot fold.
 *
 * The swept region for a round join is a CAPSULE, not a rectangle plus a disc
 * at each vertex: see `sweptPiece` for why that distinction was worth six
 * thousand square metres on a hundred-metre square.
 *
 * ---------------------------------------------------------------------------
 * A NEGATIVE BUFFER IS NOT THE SAME OPERATION
 *
 * Shrinking a parcel is not "buffer by −d". A region narrower than 2d vanishes
 * entirely, and a polygon can split into several or disappear. Erosion is built
 * as `G \ buffer(boundary(G), d)`, which handles all of that by construction,
 * and the result reports whether anything was lost so a setback that erases a
 * plot says so instead of returning an empty layer.
 *
 * ---------------------------------------------------------------------------
 * THE DISTANCE IS IN THE DATASET'S OWN UNITS
 *
 * A 10 m setback on a geographic CRS means 10 DEGREES here — about 1,100 km.
 * This module does not know the CRS, so it cannot refuse; `qa/geometry-ops.ts`
 * checks the CRS before it calls this and refuses there. Recorded in both places
 * because a caller that skipped the check would otherwise get silence.
 */

import type { CirGeometry, Position } from './cir';
import { arcSegmentCount, DEFAULT_ARC_TOLERANCE } from './geometry';
import { booleanOperation, unionAll, type MultiPoly } from './polygon-boolean';

export type JoinStyle = 'round' | 'miter' | 'bevel';
export type CapStyle = 'round' | 'flat' | 'square';

export interface BufferOptions {
  /** Largest deviation between the true arc and its chords, in dataset units. */
  tolerance: number;
  join: JoinStyle;
  cap: CapStyle;
  /**
   * How far a mitre may extend past the corner, as a multiple of the distance.
   *
   * An acute corner mitres to a spike that runs away to infinity as the angle
   * closes, so past this limit the corner is bevelled instead. 2 is the usual
   * default and matches what CAD offsets do.
   */
  miterLimit: number;
}

export const DEFAULT_BUFFER_OPTIONS: BufferOptions = {
  tolerance: DEFAULT_ARC_TOLERANCE,
  join: 'round',
  cap: 'round',
  miterLimit: 2,
};

// ===========================================================================
// Primitive pieces
// ===========================================================================

/** A regular polygon approximating a circle, accurate to `tolerance`. */
export function disc(centre: Position, radius: number, tolerance: number): Position[] {
  const steps = Math.max(8, arcSegmentCount(radius, Math.PI * 2, tolerance));
  const ring: Position[] = [];
  for (let step = 0; step < steps; step++) {
    const angle = (step / steps) * Math.PI * 2;
    ring.push([centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)]);
  }
  return ring;
}

/**
 * The rectangle swept by a segment offset `radius` to both sides.
 *
 * Zero-length segments produce nothing: they have no direction, so there is no
 * rectangle, and the vertex disc already covers that point.
 */
function segmentBox(from: Position, to: Position, radius: number): Position[] | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  const nx = (-dy / length) * radius;
  const ny = (dx / length) * radius;

  return [
    [from[0] + nx, from[1] + ny],
    [to[0] + nx, to[1] + ny],
    [to[0] - nx, to[1] - ny],
    [from[0] - nx, from[1] - ny],
  ];
}

/**
 * One segment swept into a closed piece, with a chosen end treatment.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A RECTANGLE PLUS A DISC AT EACH VERTEX
 *
 * That was the first implementation, and it was wrong about half the time. A
 * disc of radius d at a corner is exactly TANGENT to the offset edges of the
 * rectangles either side of it — they touch along a line and share no area.
 *
 * Tangency is the single hardest case for a sweep-line boolean using
 * floating-point predicates: whether the curve grazes, just crosses, or just
 * misses comes down to the last bit of a cosine. The result was a tangled ring
 * whose shoelace cancelled, so a 100 m square buffered by 5 m reported 6,664 m²
 * instead of 12,079 m². Buffering by 10 m happened to work, which is worse:
 * a bug that passes half its cases looks like a rounding issue rather than a
 * defect.
 *
 * A capsule ends the problem instead of patching it. Consecutive capsules
 * overlap in the whole half-disc around the vertex they share — a genuine
 * two-dimensional overlap, which is the case the boolean is well tested on.
 * Mitre and bevel joins never had the problem, because their join pieces share
 * real edges with the rectangles rather than touching at a point.
 */
function sweptPiece(
  from: Position,
  to: Position,
  radius: number,
  roundAtFrom: boolean,
  roundAtTo: boolean,
  tolerance: number
): Position[] | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  const ux = dx / length;
  const uy = dy / length;
  // Left normal, so the ring below runs consistently one way round.
  const nx = -uy * radius;
  const ny = ux * radius;

  const ring: Position[] = [[from[0] + nx, from[1] + ny], [to[0] + nx, to[1] + ny]];

  const sweepHalfTurn = (centre: Position, startAngle: number): void => {
    const steps = Math.max(2, Math.ceil(arcSegmentCount(radius, Math.PI, tolerance)));
    for (let step = 1; step < steps; step++) {
      const angle = startAngle - (Math.PI * step) / steps;
      ring.push([centre[0] + Math.cos(angle) * radius, centre[1] + Math.sin(angle) * radius]);
    }
  };

  // Round the far end by sweeping half a turn from the left normal to the
  // right one, which passes through the direction of travel — beyond `to`.
  if (roundAtTo) sweepHalfTurn(to, Math.atan2(ny, nx));
  ring.push([to[0] - nx, to[1] - ny]);

  ring.push([from[0] - nx, from[1] - ny]);
  if (roundAtFrom) sweepHalfTurn(from, Math.atan2(-ny, -nx));

  return ring;
}

/**
 * The join placed at a vertex where two segments meet.
 *
 * Round is a disc, and is the only join that cannot extend past `radius` from
 * the corner — which is why it is the default for a setback, where "no closer
 * than d" is the actual requirement being expressed.
 */
function joinPiece(
  previous: Position,
  vertex: Position,
  next: Position,
  radius: number,
  options: BufferOptions
): Position[] | null {
  if (options.join === 'round') return disc(vertex, radius, options.tolerance);

  const inAngle = Math.atan2(vertex[1] - previous[1], vertex[0] - previous[0]);
  const outAngle = Math.atan2(next[1] - vertex[1], next[0] - vertex[0]);

  // The turn at the corner, in (-π, π]. A straight run needs no join at all.
  let turn = outAngle - inAngle;
  while (turn <= -Math.PI) turn += Math.PI * 2;
  while (turn > Math.PI) turn -= Math.PI * 2;
  if (turn === 0) return null;

  const half = Math.abs(turn) / 2;
  const side = turn > 0 ? -1 : 1;

  const inNormal: Position = [Math.cos(inAngle + (side * Math.PI) / 2) * radius, Math.sin(inAngle + (side * Math.PI) / 2) * radius];
  const outNormal: Position = [Math.cos(outAngle + (side * Math.PI) / 2) * radius, Math.sin(outAngle + (side * Math.PI) / 2) * radius];

  const a: Position = [vertex[0] + inNormal[0], vertex[1] + inNormal[1]];
  const b: Position = [vertex[0] + outNormal[0], vertex[1] + outNormal[1]];

  if (options.join === 'bevel') return [vertex, a, b];

  // Mitre: the tip sits 1/cos(half-angle) further out than the offset itself.
  const reach = 1 / Math.cos(Math.PI / 2 - half);
  if (!Number.isFinite(reach) || reach > options.miterLimit) return [vertex, a, b];

  const bisector = inAngle + turn / 2 + (side * Math.PI) / 2;
  const tip: Position = [vertex[0] + Math.cos(bisector) * radius * reach, vertex[1] + Math.sin(bisector) * radius * reach];
  return [vertex, a, tip, b];
}

/** The end cap on an open line. */
function capPiece(end: Position, towards: Position, radius: number, options: BufferOptions): Position[] | null {
  if (options.cap === 'flat') return null;
  if (options.cap === 'round') return disc(end, radius, options.tolerance);

  // Square: extend half a width past the end, then close across.
  const dx = end[0] - towards[0];
  const dy = end[1] - towards[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  const ux = (dx / length) * radius;
  const uy = (dy / length) * radius;
  const nx = -uy;
  const ny = ux;

  return [
    [end[0] + nx, end[1] + ny],
    [end[0] + nx + ux, end[1] + ny + uy],
    [end[0] - nx + ux, end[1] - ny + uy],
    [end[0] - nx, end[1] - ny],
  ];
}

// ===========================================================================
// Geometry decomposition
// ===========================================================================

interface Parts {
  points: Position[];
  /** Open runs: lines, and the boundaries of polygons treated as closed runs. */
  lines: { positions: Position[]; closed: boolean }[];
  polygons: MultiPoly;
}

function decompose(geometry: CirGeometry | null, into: Parts = { points: [], lines: [], polygons: [] }): Parts {
  if (!geometry) return into;

  switch (geometry.type) {
    case 'Point':
      into.points.push(geometry.coordinates as Position);
      break;
    case 'MultiPoint':
      into.points.push(...(geometry.coordinates as Position[]));
      break;
    case 'LineString':
      into.lines.push({ positions: geometry.coordinates as Position[], closed: false });
      break;
    case 'MultiLineString':
      for (const line of geometry.coordinates as Position[][]) into.lines.push({ positions: line, closed: false });
      break;
    case 'Polygon':
      into.polygons.push(geometry.coordinates as Position[][]);
      break;
    case 'MultiPolygon':
      for (const polygon of geometry.coordinates as Position[][][]) into.polygons.push(polygon);
      break;
    case 'GeometryCollection':
      for (const child of geometry.geometries ?? []) decompose(child, into);
      break;
  }

  return into;
}

/**
 * Every piece covering a run of positions, offset `radius` to both sides.
 *
 * Round joins sweep each segment as a capsule, which overlaps its neighbours
 * rather than touching them (see `sweptPiece`). Mitre and bevel joins use a
 * rectangle plus an explicit join piece, which share edges — also an overlap the
 * boolean handles reliably.
 */
function coverRun(positions: Position[], closed: boolean, radius: number, options: BufferOptions): MultiPoly {
  const pieces: MultiPoly = [];
  if (positions.length === 0) return pieces;
  if (positions.length === 1) return [[disc(positions[0], radius, options.tolerance)]];

  const count = closed ? positions.length : positions.length - 1;

  if (options.join === 'round') {
    for (let index = 0; index < count; index++) {
      const isFirst = !closed && index === 0;
      const isLast = !closed && index === count - 1;

      // An interior vertex is always rounded — that IS the round join. Only the
      // two ends of an open run take the cap style.
      let from = positions[index];
      let to = positions[(index + 1) % positions.length];
      let roundAtFrom = !isFirst || options.cap === 'round';
      let roundAtTo = !isLast || options.cap === 'round';

      // A square cap is a flat end pushed `radius` further out.
      if (isFirst && options.cap === 'square') {
        from = extend(from, to, radius);
        roundAtFrom = false;
      }
      if (isLast && options.cap === 'square') {
        to = extend(to, from, radius);
        roundAtTo = false;
      }

      const piece = sweptPiece(from, to, radius, roundAtFrom, roundAtTo, options.tolerance);
      if (piece) pieces.push([piece]);
    }
    return pieces;
  }

  for (let index = 0; index < count; index++) {
    const box = segmentBox(positions[index], positions[(index + 1) % positions.length], radius);
    if (box) pieces.push([box]);
  }

  const first = closed ? 0 : 1;
  const last = closed ? positions.length : positions.length - 1;
  for (let index = first; index < last; index++) {
    const previous = positions[(index - 1 + positions.length) % positions.length];
    const vertex = positions[index];
    const next = positions[(index + 1) % positions.length];
    const join = joinPiece(previous, vertex, next, radius, options);
    if (join) pieces.push([join]);
  }

  if (!closed) {
    const startCap = capPiece(positions[0], positions[1], radius, options);
    if (startCap) pieces.push([startCap]);
    const endCap = capPiece(positions[positions.length - 1], positions[positions.length - 2], radius, options);
    if (endCap) pieces.push([endCap]);
  }

  return pieces;
}

/** Moves `point` away from `towards` by `by`, along the line between them. */
function extend(point: Position, towards: Position, by: number): Position {
  const dx = point[0] - towards[0];
  const dy = point[1] - towards[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return point;
  return [point[0] + (dx / length) * by, point[1] + (dy / length) * by];
}

// ===========================================================================
// Public API
// ===========================================================================

export interface BufferResult {
  polygons: MultiPoly;
  /** True when a negative buffer removed a whole part. */
  erased: boolean;
  /** Rings dropped for enclosing no area, carried up from the boolean core. */
  slivers: number;
}

/**
 * Buffers any geometry by `distance` in the dataset's own units.
 *
 * A positive distance grows, a negative distance shrinks. Zero returns the
 * polygonal parts unchanged and nothing else, since a zero-width buffer of a
 * line is not a polygon.
 */
export function bufferGeometry(
  geometry: CirGeometry | null,
  distance: number,
  options: Partial<BufferOptions> = {}
): BufferResult {
  const settings = { ...DEFAULT_BUFFER_OPTIONS, ...options };
  const parts = decompose(geometry);
  const radius = Math.abs(distance);

  if (distance === 0) {
    const merged = unionAll(parts.polygons.map((polygon) => [polygon]));
    return { polygons: merged.polygons, erased: false, slivers: merged.report.slivers };
  }

  if (distance < 0) return erode(parts, radius, settings);

  const pieces: MultiPoly[] = [];
  for (const point of parts.points) pieces.push([[disc(point, radius, settings.tolerance)]]);
  for (const line of parts.lines) for (const piece of coverRun(line.positions, line.closed, radius, settings)) pieces.push([piece]);

  for (const polygon of parts.polygons) {
    // The polygon itself, plus a collar over every ring — including holes, whose
    // collar is what shrinks them by the same distance.
    pieces.push([polygon]);
    for (const ring of polygon) for (const piece of coverRun(ring, true, radius, settings)) pieces.push([piece]);
  }

  const merged = unionAll(pieces);
  return { polygons: merged.polygons, erased: false, slivers: merged.report.slivers };
}

/**
 * Shrinks polygons by `radius`.
 *
 * `G \ buffer(boundary(G), radius)`: everything within `radius` of any edge is
 * removed, which is precisely the definition, and handles a part vanishing or
 * splitting in two without a special case for either.
 */
function erode(parts: Parts, radius: number, settings: BufferOptions): BufferResult {
  if (parts.polygons.length === 0) {
    // Eroding a line or a point leaves nothing. Saying so beats returning an
    // empty result that looks like a failure.
    return { polygons: [], erased: parts.lines.length > 0 || parts.points.length > 0, slivers: 0 };
  }

  const collar: MultiPoly[] = [];
  for (const polygon of parts.polygons) {
    for (const ring of polygon) for (const piece of coverRun(ring, true, radius, settings)) collar.push([piece]);
  }

  const boundary = unionAll(collar);
  const shrunk = booleanOperation(parts.polygons, boundary.polygons, 'difference');

  return {
    polygons: shrunk.polygons,
    erased: shrunk.polygons.length < parts.polygons.length,
    slivers: boundary.report.slivers + shrunk.report.slivers,
  };
}

/**
 * Offsets a line to ONE side — the CAD operation, not a buffer.
 *
 * A buffer of a line is a closed corridor around it; an offset is a new line
 * running parallel. Surveyors ask for both and mean different things: a road
 * reserve is a buffer, a kerb line is an offset.
 *
 * Returned as an open line. Where the source turns tighter than the offset
 * distance the parallel curve self-intersects, and that loop is reported rather
 * than removed: which side of a cusp is wanted is a drafting decision.
 */
export function offsetLine(
  positions: Position[],
  distance: number,
  options: Partial<BufferOptions> = {}
): { positions: Position[]; selfIntersects: boolean } {
  const settings = { ...DEFAULT_BUFFER_OPTIONS, ...options };
  if (positions.length < 2 || distance === 0) return { positions: [...positions], selfIntersects: false };

  const side = Math.sign(distance);
  const radius = Math.abs(distance);

  // The offset of each segment, as a parallel line. Zero-length segments carry
  // no direction and are dropped rather than producing a normal of (0, 0).
  const runs: { from: Position; to: Position; normal: Position; at: number }[] = [];
  for (let index = 0; index + 1 < positions.length; index++) {
    const from = positions[index];
    const to = positions[index + 1];
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;

    const normal: Position = [(-dy / length) * radius * side, (dx / length) * radius * side];
    runs.push({ from, to, normal, at: index });
  }
  if (runs.length === 0) return { positions: [], selfIntersects: false };

  const shift = (point: Position, normal: Position): Position => [point[0] + normal[0], point[1] + normal[1]];
  const out: Position[] = [shift(runs[0].from, runs[0].normal)];

  for (let index = 0; index + 1 < runs.length; index++) {
    const current = runs[index];
    const next = runs[index + 1];
    const vertex = current.to;

    const startAngle = Math.atan2(current.normal[1], current.normal[0]);
    const endAngle = Math.atan2(next.normal[1], next.normal[0]);
    let sweep = endAngle - startAngle;
    while (sweep <= -Math.PI) sweep += Math.PI * 2;
    while (sweep > Math.PI) sweep -= Math.PI * 2;

    // Which side of the turn the offset falls on decides the whole treatment.
    const outside = sweep * side < 0;

    if (outside) {
      // OUTSIDE: the two offset lines leave a wedge open at the corner, and the
      // join fills it. Every vertex of a round join sits exactly `distance` from
      // the corner, which is the property a setback is actually asking for.
      out.push(shift(vertex, current.normal));
      if (settings.join === 'round' && sweep !== 0) {
        const steps = Math.max(1, arcSegmentCount(radius, Math.abs(sweep), settings.tolerance));
        for (let step = 1; step < steps; step++) {
          const angle = startAngle + (sweep * step) / steps;
          out.push([vertex[0] + Math.cos(angle) * radius, vertex[1] + Math.sin(angle) * radius]);
        }
      }
      out.push(shift(vertex, next.normal));
      continue;
    }

    // INSIDE: the two offset lines OVERLAP, and the parallel curve is their
    // intersection — one point, not two.
    //
    // Emitting both endpoints instead leaves a short doubling-back at every
    // inside corner, however gentle. That is a real self-intersection, so
    // `selfIntersects` then fired on almost every inward offset and stopped
    // meaning anything. Trimming here is what a CAD offset does, and it leaves
    // the flag for the case that genuinely cannot be resolved: a corner so tight
    // that the trim point lies beyond the far end of the next segment.
    const meeting = intersectLines(
      shift(current.from, current.normal),
      shift(current.to, current.normal),
      shift(next.from, next.normal),
      shift(next.to, next.normal)
    );

    if (meeting) {
      out.push(meeting);
    } else {
      // Parallel offset lines: a straight run, so one point serves for both.
      out.push(shift(vertex, current.normal));
    }
  }

  const last = runs[runs.length - 1];
  out.push(shift(last.to, last.normal));

  return { positions: out, selfIntersects: hasSelfIntersection(out) };
}

/** Where two infinite lines meet, or null when they are parallel. */
function intersectLines(a1: Position, a2: Position, b1: Position, b2: Position): Position | null {
  const ax = a2[0] - a1[0];
  const ay = a2[1] - a1[1];
  const bx = b2[0] - b1[0];
  const by = b2[1] - b1[1];

  const denominator = ax * by - ay * bx;
  if (denominator === 0) return null;

  const t = ((b1[0] - a1[0]) * by - (b1[1] - a1[1]) * bx) / denominator;
  return [a1[0] + ax * t, a1[1] + ay * t];
}

/** Does an open polyline cross itself? O(n²), used only to report a cusp. */
function hasSelfIntersection(positions: Position[]): boolean {
  for (let i = 0; i + 1 < positions.length; i++) {
    for (let j = i + 2; j + 1 < positions.length; j++) {
      if (crosses(positions[i], positions[i + 1], positions[j], positions[j + 1])) return true;
    }
  }
  return false;
}

function crosses(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
  const orient = (a: Position, b: Position, c: Position) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
