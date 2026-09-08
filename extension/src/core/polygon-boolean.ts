/**
 * Boolean operations on polygons: intersection, union, difference, XOR.
 *
 * A sweep-line implementation of the Martínez–Rueda–Feito algorithm
 * ("A new algorithm for computing Boolean operations on polygons",
 * Computers & Geosciences 35, 2009), with the hole-nesting refinement that
 * tracks contour depth rather than re-testing containment afterwards.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ALGORITHM AND NOT GREINER–HORMANN
 *
 * Greiner–Hormann is shorter and is what most hand-rolled clippers use. It
 * fails on DEGENERACIES: collinear overlapping edges, an intersection exactly
 * at a vertex, and one boundary touching another without crossing.
 *
 * Those are not edge cases in this application, they are the normal case.
 * Two adjacent cadastral parcels SHARE a boundary — their edges are exactly
 * collinear and overlapping, by definition of being adjacent. A union of two
 * neighbouring plots is the single most likely thing a surveyor will ask this
 * tool to do, and Greiner–Hormann's answer to it is either a crash or a
 * silently wrong polygon.
 *
 * Martínez–Rueda classifies each edge as NORMAL, SAME_TRANSITION,
 * DIFFERENT_TRANSITION or NON_CONTRIBUTING precisely so that overlapping
 * collinear edges have a defined, correct outcome. That is why it is worth the
 * extra four hundred lines.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 *
 * Floating-point arithmetic, not exact predicates. Two edges that are collinear
 * to within a nanometre but not bitwise collinear are treated as crossing, and
 * the result can carry a sliver polygon a few nanometres wide. Survey
 * coordinates are large (412345.678) and doubles have ~1e-10 m of resolution
 * there, so this is far below any survey tolerance — but it is real, it is why
 * `cleanResult` drops zero-area contours, and it is why callers are given
 * `slivers` in the report rather than being left to find them at export.
 *
 * Z IS DROPPED. A boolean creates vertices where two boundaries cross, and
 * those points have no elevation in either input — one polygon's surface says
 * one thing there and the other says something else. Interpolating would invent
 * a level nobody surveyed, so the operation is planar and says so (R2, R18).
 */

import type { Position } from './cir';

export type BooleanOp = 'intersection' | 'union' | 'difference' | 'xor';

/** A ring: the closing vertex may be present or absent, both are accepted. */
export type Ring = Position[];
/** [exterior, ...holes]. */
export type Poly = Ring[];
export type MultiPoly = Poly[];

// ===========================================================================
// Geometric predicates
// ===========================================================================

/**
 * Twice the signed area of the triangle (p0, p1, p2).
 *
 * Positive when p2 lies to the LEFT of the directed line p0→p1. Every ordering
 * decision in the sweep reduces to this one sign, so it is defined once.
 */
function cross(p0: Position, p1: Position, p2: Position): number {
  return (p0[0] - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (p0[1] - p2[1]);
}

function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

// ===========================================================================
// Sweep events
// ===========================================================================

/**
 * How an edge contributes to the result.
 *
 * The three non-NORMAL cases exist entirely for overlapping collinear edges —
 * the shared parcel boundary case described at the top of this file.
 */
const enum EdgeType {
  /** An ordinary edge, overlapping nothing. */
  Normal = 0,
  /** Overlaps an edge of the other polygon, both entering or both leaving. */
  SameTransition = 1,
  /** Overlaps an edge of the other polygon, one entering while the other leaves. */
  DifferentTransition = 2,
  /** Overlapped by an edge already accounted for. Contributes nothing. */
  NonContributing = 3,
}

class SweepEvent {
  /** Set once the partner event is constructed. */
  other!: SweepEvent;

  type: EdgeType = EdgeType.Normal;
  /** Does this edge take us out of its own polygon's interior? */
  inOut = false;
  /** Same question, for the other polygon. */
  otherInOut = false;
  /** The closest edge below this one that is in the result. Drives hole nesting. */
  prevInResult: SweepEvent | null = null;
  inResult = false;
  /** +1 when the result's interior is above this edge, -1 when below. */
  resultTransition = 0;

  // Filled in during contour assembly.
  otherPos = -1;
  outputContourId = -1;

  constructor(
    readonly point: Position,
    public left: boolean,
    readonly isSubject: boolean,
    /** Which ring of the input this came from — distinguishes touching rings. */
    readonly contourId: number
  ) {}

  /** A vertical edge has no "below", which changes how fields propagate. */
  isVertical(): boolean {
    return this.point[0] === this.other.point[0];
  }

  /** Is `p` strictly above this edge's supporting line? */
  isBelow(p: Position): boolean {
    return this.left ? cross(this.point, this.other.point, p) > 0 : cross(this.other.point, this.point, p) > 0;
  }

  isAbove(p: Position): boolean {
    return !this.isBelow(p);
  }
}

/**
 * Sweep order: left to right, then bottom to top.
 *
 * Returns 1 when `a` must be processed AFTER `b`.
 */
function compareEvents(a: SweepEvent, b: SweepEvent): number {
  if (a.point[0] > b.point[0]) return 1;
  if (a.point[0] < b.point[0]) return -1;
  if (a.point[1] !== b.point[1]) return a.point[1] > b.point[1] ? 1 : -1;

  // Same point. A right endpoint is processed before a left one, so a segment
  // that ends here leaves the status line before one that starts here joins it.
  if (a.left !== b.left) return a.left ? 1 : -1;

  // Both the same kind at the same point: the lower edge goes first.
  if (cross(a.point, a.other.point, b.other.point) !== 0) return a.isBelow(b.other.point) ? -1 : 1;

  return !a.isSubject && b.isSubject ? 1 : -1;
}

/**
 * Status-line order: which edge is lower where the sweep line stands.
 *
 * Returns -1 when `a` is below `b`.
 */
function compareSegments(a: SweepEvent, b: SweepEvent): number {
  if (a === b) return 0;

  // Not collinear: the usual case, decided by orientation.
  if (cross(a.point, a.other.point, b.point) !== 0 || cross(a.point, a.other.point, b.other.point) !== 0) {
    if (samePoint(a.point, b.point)) return a.isBelow(b.other.point) ? -1 : 1;
    if (a.point[0] === b.point[0]) return a.point[1] < b.point[1] ? -1 : 1;
    // Whichever entered the status line first decides the comparison.
    if (compareEvents(a, b) === 1) return b.isAbove(a.point) ? -1 : 1;
    return a.isBelow(b.point) ? -1 : 1;
  }

  // Collinear, and from the same polygon: order by ring, then by sweep order.
  if (a.isSubject === b.isSubject) {
    if (samePoint(a.point, b.point)) {
      if (samePoint(a.other.point, b.other.point)) return 0;
      return a.contourId > b.contourId ? 1 : -1;
    }
    return compareEvents(a, b) === 1 ? 1 : -1;
  }

  // Collinear and from DIFFERENT polygons — the shared-boundary case. Subject
  // first, deterministically, so the overlap classification below is stable.
  return a.isSubject ? -1 : 1;
}

// ===========================================================================
// Priority queue
// ===========================================================================

/** A binary heap over `compareEvents`. The sweep pulls millions of events. */
class EventQueue {
  private readonly heap: SweepEvent[] = [];

  get length(): number {
    return this.heap.length;
  }

  push(event: SweepEvent): void {
    this.heap.push(event);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareEvents(this.heap[index], this.heap[parent]) >= 0) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
      index = parent;
    }
  }

  pop(): SweepEvent | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop() as SweepEvent;
    if (this.heap.length === 0) return top;

    this.heap[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.heap.length && compareEvents(this.heap[left], this.heap[smallest]) < 0) smallest = left;
      if (right < this.heap.length && compareEvents(this.heap[right], this.heap[smallest]) < 0) smallest = right;
      if (smallest === index) break;
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
    return top;
  }
}

/**
 * The sweep-line status: edges currently crossed, ordered bottom to top.
 *
 * A sorted array with binary search for position and `splice` to insert, which
 * is O(n) per insertion and therefore O(n²) overall in the worst case. A
 * balanced tree would be O(n log n), and is the right change IF a real dataset
 * ever makes this the bottleneck — for the parcel and boundary work this tool
 * does, n is in the hundreds and an array is faster in practice than a tree
 * with the same asymptotics. Recorded here rather than discovered later.
 */
class StatusLine {
  private readonly items: SweepEvent[] = [];

  /** Inserts and returns the index it landed at. */
  insert(event: SweepEvent): number {
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (compareSegments(this.items[mid], event) < 0) low = mid + 1;
      else high = mid;
    }
    this.items.splice(low, 0, event);
    return low;
  }

  remove(event: SweepEvent): void {
    const index = this.items.indexOf(event);
    if (index >= 0) this.items.splice(index, 1);
  }

  indexOf(event: SweepEvent): number {
    return this.items.indexOf(event);
  }

  at(index: number): SweepEvent | null {
    return index >= 0 && index < this.items.length ? this.items[index] : null;
  }
}

// ===========================================================================
// Building the event queue
// ===========================================================================

function normaliseRing(ring: Ring): Position[] {
  const points: Position[] = [];
  for (const position of ring) {
    const previous = points[points.length - 1];
    // Consecutive duplicates create zero-length edges, which have no
    // orientation and therefore no place in the status line ordering.
    if (previous && samePoint(previous, position)) continue;
    points.push([position[0], position[1]]);
  }
  // Also drop a duplicate that closes the ring; edges are generated cyclically.
  while (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  return points;
}

function addRing(ring: Ring, isSubject: boolean, contourId: number, queue: EventQueue): void {
  const points = normaliseRing(ring);
  if (points.length < 3) return;

  for (let index = 0; index < points.length; index++) {
    const from = points[index];
    const to = points[(index + 1) % points.length];

    const e1 = new SweepEvent(from, false, isSubject, contourId);
    const e2 = new SweepEvent(to, false, isSubject, contourId);
    e1.other = e2;
    e2.other = e1;

    // "Left" means first in sweep order, which is what the algorithm means by
    // the segment's start — not the smaller x alone, because vertical edges tie.
    if (compareEvents(e1, e2) < 0) e1.left = true;
    else e2.left = true;

    queue.push(e1);
    queue.push(e2);
  }
}

// ===========================================================================
// Field computation
// ===========================================================================

function edgeInResult(event: SweepEvent, operation: BooleanOp): boolean {
  switch (event.type) {
    case EdgeType.Normal:
      switch (operation) {
        case 'intersection':
          return !event.otherInOut;
        case 'union':
          return event.otherInOut;
        case 'difference':
          // An edge survives a difference when it bounds the subject's interior
          // and lies outside the clip, or bounds the clip inside the subject.
          return (event.isSubject && event.otherInOut) || (!event.isSubject && !event.otherInOut);
        case 'xor':
          return true;
      }
      return false;
    case EdgeType.SameTransition:
      return operation === 'intersection' || operation === 'union';
    case EdgeType.DifferentTransition:
      return operation === 'difference';
    case EdgeType.NonContributing:
      return false;
  }
}

/** +1 when the result's interior lies above the edge, -1 when below. */
function resultTransition(event: SweepEvent, operation: BooleanOp): number {
  const thisIn = !event.inOut;
  const thatIn = !event.otherInOut;
  let inside: boolean;

  switch (operation) {
    case 'intersection':
      inside = thisIn && thatIn;
      break;
    case 'union':
      inside = thisIn || thatIn;
      break;
    case 'xor':
      inside = thisIn !== thatIn;
      break;
    case 'difference':
      inside = event.isSubject ? thisIn && !thatIn : thatIn && !thisIn;
      break;
  }
  return inside ? 1 : -1;
}

function computeFields(event: SweepEvent, previous: SweepEvent | null, operation: BooleanOp): void {
  if (previous === null) {
    event.inOut = false;
    event.otherInOut = true;
  } else if (event.isSubject === previous.isSubject) {
    event.inOut = !previous.inOut;
    event.otherInOut = previous.otherInOut;
  } else {
    event.inOut = !previous.otherInOut;
    // A vertical predecessor gives no usable transition for the other polygon.
    event.otherInOut = previous.isVertical() ? !previous.inOut : previous.inOut;
  }

  if (previous) {
    event.prevInResult =
      !edgeInResult(previous, operation) || previous.isVertical() ? previous.prevInResult : previous;
  }

  const inResult = edgeInResult(event, operation);
  event.resultTransition = inResult ? resultTransition(event, operation) : 0;
  event.inResult = inResult;
}

// ===========================================================================
// Intersection handling
// ===========================================================================

/** Splits an edge at `point`, queuing the two halves. */
function divideSegment(event: SweepEvent, point: Position, queue: EventQueue): void {
  // A split exactly on an existing endpoint would create a zero-length edge,
  // which has no orientation and so no defined place in the status-line order.
  // The point is already a vertex, so there is nothing to do.
  if (samePoint(event.point, point) || samePoint(event.other.point, point)) return;

  const right = new SweepEvent(point, false, event.isSubject, event.contourId);
  const left = new SweepEvent(point, true, event.isSubject, event.contourId);

  right.other = event;
  left.other = event.other;

  // Rounding can put the new left event AFTER the right endpoint it is supposed
  // to precede. Left over right is what the sweep relies on to keep the status
  // line consistent, so the flags are swapped rather than the order violated —
  // without this the sweep can revisit the same pair forever.
  if (compareEvents(left, event.other) > 0) {
    event.other.left = true;
    left.left = false;
  }

  event.other.other = left;
  event.other = right;

  queue.push(left);
  queue.push(right);
}

interface Crossing {
  /** 0, 1 or 2 intersection points. Two means the edges overlap collinearly. */
  count: number;
  first?: Position;
  second?: Position;
}

/** Where two edges meet: a point, an overlapping run, or nothing. */
function intersectEdges(a0: Position, a1: Position, b0: Position, b1: Position): Crossing {
  const va: Position = [a1[0] - a0[0], a1[1] - a0[1]];
  const vb: Position = [b1[0] - b0[0], b1[1] - b0[1]];
  const e: Position = [b0[0] - a0[0], b0[1] - a0[1]];

  const kross = va[0] * vb[1] - va[1] * vb[0];
  const sqrLenA = va[0] * va[0] + va[1] * va[1];

  if (kross !== 0) {
    const s = (e[0] * vb[1] - e[1] * vb[0]) / kross;
    if (s < 0 || s > 1) return { count: 0 };
    const t = (e[0] * va[1] - e[1] * va[0]) / kross;
    if (t < 0 || t > 1) return { count: 0 };
    // Snap to an existing vertex when the parameter is exactly an endpoint, so
    // an intersection at a shared corner does not create a near-duplicate.
    if (s === 0) return { count: 1, first: a0 };
    if (s === 1) return { count: 1, first: a1 };
    if (t === 0) return { count: 1, first: b0 };
    if (t === 1) return { count: 1, first: b1 };
    return { count: 1, first: [a0[0] + s * va[0], a0[1] + s * va[1]] };
  }

  // Parallel. Collinear only if the offset between them is parallel too.
  const sqrKross = e[0] * va[1] - e[1] * va[0];
  if (sqrKross !== 0) return { count: 0 };

  // Collinear: find the overlapping parameter range along `a`.
  const sa = (e[0] * va[0] + e[1] * va[1]) / sqrLenA;
  const sb = sa + (vb[0] * va[0] + vb[1] * va[1]) / sqrLenA;
  const low = Math.min(sa, sb);
  const high = Math.max(sa, sb);

  if (low > 1 || high < 0) return { count: 0 };

  const from = Math.max(low, 0);
  const to = Math.min(high, 1);
  const at = (s: number): Position => (s === 0 ? a0 : s === 1 ? a1 : [a0[0] + s * va[0], a0[1] + s * va[1]]);

  if (from === to) return { count: 1, first: at(from) };
  return { count: 2, first: at(from), second: at(to) };
}

/**
 * Handles a possible intersection between two edges adjacent in the status line.
 *
 * Returns 2 when the two edges OVERLAP and were classified, which the caller
 * needs to know: an overlap rewrites both edges' contribution, so the fields
 * computed a moment ago no longer describe them.
 *
 * The overlap branch is the one that makes shared parcel boundaries work. The
 * two collinear edges are classified so exactly one contributes, and which way
 * depends on whether the two polygons are entering or leaving together.
 */
function possibleIntersection(a: SweepEvent, b: SweepEvent, queue: EventQueue): number {
  const crossing = intersectEdges(a.point, a.other.point, b.point, b.other.point);
  if (crossing.count === 0) return 0;

  // They only touch at a shared endpoint: nothing to subdivide.
  if (crossing.count === 1 && (samePoint(a.point, b.point) || samePoint(a.other.point, b.other.point))) return 0;

  // Overlapping edges from the same polygon means the ring overlaps itself,
  // which no valid ring does. Contributing both would double-count the region.
  if (crossing.count === 2 && a.isSubject === b.isSubject) return 0;

  if (crossing.count === 1) {
    const point = crossing.first as Position;
    divideSegment(a, point, queue);
    divideSegment(b, point, queue);
    return 1;
  }

  // ---- Overlap. Collect the four endpoints in sweep order.
  const events: SweepEvent[] = [];
  let leftCoincide = false;
  let rightCoincide = false;

  if (samePoint(a.point, b.point)) leftCoincide = true;
  else if (compareEvents(a, b) === 1) events.push(b, a);
  else events.push(a, b);

  if (samePoint(a.other.point, b.other.point)) rightCoincide = true;
  else if (compareEvents(a.other, b.other) === 1) events.push(b.other, a.other);
  else events.push(a.other, b.other);

  if (leftCoincide) {
    // The overlap starts together, so one edge carries the whole shared run and
    // the other contributes nothing.
    b.type = EdgeType.NonContributing;
    a.type = a.inOut === b.inOut ? EdgeType.SameTransition : EdgeType.DifferentTransition;

    if (!rightCoincide) divideSegment(events[1].other, events[0].point, queue);
    return 2;
  }

  if (rightCoincide) {
    // They finish together: split the longer one where the shorter begins.
    divideSegment(events[0], events[1].point, queue);
    return 3;
  }

  if (events[0] !== events[3].other) {
    // Staggered overlap: cut at both ends of the shared run.
    divideSegment(events[0], events[1].point, queue);
    divideSegment(events[1], events[2].point, queue);
    return 3;
  }

  // One edge contains the other entirely: cut the container at both ends.
  divideSegment(events[0], events[1].point, queue);
  divideSegment(events[3].other, events[2].point, queue);
  return 3;
}

// ===========================================================================
// The sweep
// ===========================================================================

/**
 * The largest number of events one operation may process.
 *
 * This runs in a browser tab, on a file the user chose and this code has never
 * seen. A pathological or malformed input must fail with a message, not freeze
 * the window — an unresponsive tab is indistinguishable from a crashed tool and
 * gives the user nothing to act on. Each input vertex generates two events plus
 * two more per intersection, so a legitimate operation on survey data is orders
 * of magnitude below this.
 */
export const MAX_SWEEP_EVENTS = 4_000_000;

export class BooleanLimitError extends Error {
  constructor(readonly processed: number) {
    super(
      `This boolean operation exceeded ${MAX_SWEEP_EVENTS.toLocaleString()} sweep events and was stopped. ` +
        'That usually means a self-intersecting or duplicated ring rather than a genuinely large polygon.'
    );
    this.name = 'BooleanLimitError';
  }
}

function subdivide(queue: EventQueue, operation: BooleanOp, subjectMaxX: number, clipMaxX: number): SweepEvent[] {
  const status = new StatusLine();
  const sorted: SweepEvent[] = [];
  const rightBound = Math.min(subjectMaxX, clipMaxX);

  while (queue.length > 0) {
    if (sorted.length > MAX_SWEEP_EVENTS) throw new BooleanLimitError(sorted.length);

    const event = queue.pop() as SweepEvent;
    sorted.push(event);

    // Past this point one operand is exhausted, so no remaining event of the
    // other can change an intersection, or a difference of the subject.
    if (operation === 'intersection' && event.point[0] > rightBound) break;
    if (operation === 'difference' && event.point[0] > subjectMaxX) break;

    if (event.left) {
      const position = status.insert(event);
      const previous = status.at(position - 1);
      const next = status.at(position + 1);

      computeFields(event, previous, operation);

      // A return of 2 means the edges overlapped and were reclassified, so the
      // fields computed a moment ago describe a contribution that no longer
      // holds and both edges have to be recomputed.
      if (next && possibleIntersection(event, next, queue) === 2) {
        computeFields(event, previous, operation);
        computeFields(next, event, operation);
      }

      if (previous && possibleIntersection(previous, event, queue) === 2) {
        const previousIndex = status.indexOf(previous);
        computeFields(previous, status.at(previousIndex - 1), operation);
        computeFields(event, previous, operation);
      }
      continue;
    }

    // A right endpoint: its partner leaves the status line, and the two edges
    // it separated become neighbours and may now intersect.
    const partner = event.other;
    const position = status.indexOf(partner);
    if (position < 0) continue;

    const previous = status.at(position - 1);
    const next = status.at(position + 1);
    status.remove(partner);
    if (previous && next) possibleIntersection(previous, next, queue);
  }

  return sorted;
}

// ===========================================================================
// Contour assembly
// ===========================================================================

interface Contour {
  points: Position[];
  holeOf: number | null;
  holeIds: number[];
  depth: number;
}

function orderEvents(sorted: SweepEvent[]): SweepEvent[] {
  const result: SweepEvent[] = [];
  for (const event of sorted) {
    if ((event.left && event.inResult) || (!event.left && event.other.inResult)) result.push(event);
  }

  // Subdivision can leave the collected events slightly out of order. A single
  // bubble pass to fixpoint is what the reference implementation does, and the
  // list is already nearly sorted, so it is close to linear in practice.
  let sortedNow = false;
  while (!sortedNow) {
    sortedNow = true;
    for (let index = 0; index + 1 < result.length; index++) {
      if (compareEvents(result[index], result[index + 1]) === 1) {
        [result[index], result[index + 1]] = [result[index + 1], result[index]];
        sortedNow = false;
      }
    }
  }

  for (let index = 0; index < result.length; index++) result[index].otherPos = index;

  // A right event can be reached before its left partner was numbered, so the
  // two positions are swapped into the arrangement the walk below expects.
  for (const event of result) {
    if (!event.left) {
      const temporary = event.otherPos;
      event.otherPos = event.other.otherPos;
      event.other.otherPos = temporary;
    }
  }

  return result;
}

/**
 * Chooses which edge to leave a junction by.
 *
 * At an ordinary point on a contour exactly two result edges meet — the one
 * arrived on and the one to leave by — and there is nothing to decide. Where
 * result components TOUCH at a point, four or more meet, and the choice is the
 * whole correctness of the operation.
 *
 * Picking by position in the sorted array, which is what the reference
 * implementation does, is arbitrary at such a junction. The observed cost: a
 * square unioned with a block sitting in the mouth of its re-entrant boundary
 * traced one tangled curve with the block wound backwards, so its area was
 * SUBTRACTED — 60 m² reported where the answer is 76 m². That configuration is
 * an ordinary one in cadastral work: a plot abutting a neighbour's notch.
 *
 * The rule that is not arbitrary is the planar-graph one: leave by the edge
 * that is the first turn CLOCKWISE from the direction you came in on. That
 * keeps the face on a consistent side and traces each component separately.
 */
function chooseByAngle(position: number, candidates: number[], events: SweepEvent[]): number {
  const here = events[position].point;
  const cameFrom = events[position].other.point;
  const back = Math.atan2(cameFrom[1] - here[1], cameFrom[0] - here[0]);

  let best = candidates[0];
  let bestTurn = Infinity;

  for (const candidate of candidates) {
    const towards = events[candidate].other.point;
    const angle = Math.atan2(towards[1] - here[1], towards[0] - here[0]);

    // The turn from the way back to this edge, measured clockwise into (0, 2π].
    // Zero is excluded deliberately: that is the edge we arrived on.
    let turn = back - angle;
    while (turn <= 0) turn += Math.PI * 2;
    while (turn > Math.PI * 2) turn -= Math.PI * 2;

    if (turn < bestTurn) {
      bestTurn = turn;
      best = candidate;
    }
  }

  return best;
}

function nextPosition(position: number, events: SweepEvent[], processed: Set<number>, origin: number): number {
  const here = events[position].point;

  // Events at one point are contiguous in the sorted array, but `position` may
  // sit anywhere among them, so both directions are searched.
  const candidates: number[] = [];
  for (let scan = position + 1; scan < events.length && samePoint(here, events[scan].point); scan++) {
    if (!processed.has(scan)) candidates.push(scan);
  }
  for (let scan = position - 1; scan >= 0 && samePoint(here, events[scan].point); scan--) {
    if (!processed.has(scan)) candidates.push(scan);
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return chooseByAngle(position, candidates, events);

  // Nothing unprocessed left here: walk back to close the contour.
  let next = position - 1;
  while (next > origin && processed.has(next)) next--;
  return next;
}

/**
 * Decides whether a new contour is an exterior ring or a hole.
 *
 * Read off `prevInResult` — the nearest result edge below the contour's first
 * vertex — rather than by point-in-polygon testing every contour against every
 * other afterwards, which is both O(n²) and wrong for touching rings.
 */
function contourFromContext(event: SweepEvent, contours: Contour[], contourId: number): Contour {
  const contour: Contour = { points: [], holeOf: null, holeIds: [], depth: 0 };
  if (event.prevInResult === null) return contour;

  const below = event.prevInResult;
  const belowId = below.outputContourId;

  if (below.resultTransition > 0) {
    const lower = contours[belowId];
    if (lower.holeOf !== null) {
      // Below us is a hole, so we are a new island at the same depth inside it.
      contours[lower.holeOf].holeIds.push(contourId);
      contour.holeOf = lower.holeOf;
      contour.depth = lower.depth;
    } else {
      lower.holeIds.push(contourId);
      contour.holeOf = belowId;
      contour.depth = lower.depth + 1;
    }
  } else {
    contour.depth = contours[belowId].depth;
  }

  return contour;
}

function connectEdges(sorted: SweepEvent[]): MultiPoly {
  const events = orderEvents(sorted);
  const processed = new Set<number>();
  const contours: Contour[] = [];

  for (let index = 0; index < events.length; index++) {
    if (processed.has(index)) continue;

    const contourId = contours.length;
    const contour = contourFromContext(events[index], contours, contourId);
    contour.points.push(events[index].point);

    const mark = (at: number): void => {
      processed.add(at);
      // Recorded on BOTH endpoints. `contourFromContext` reads it off whichever
      // event happened to be the one below, and only ever finding it on left
      // events would make hole nesting depend on which end was visited first.
      events[at].outputContourId = contourId;
    };

    let position = index;
    for (;;) {
      mark(position);

      position = events[position].otherPos;
      mark(position);
      contour.points.push(events[position].point);

      position = nextPosition(position, events, processed, index);

      // The walk ends when it arrives back where it started. Testing
      // `position >= index` instead looks equivalent and is not: a step that
      // lands exactly on the origin satisfies it, and the contour is then
      // traced round again, and again, until the array refuses to grow.
      if (position === index) break;
    }

    contours.push(contour);
  }

  // Exterior contours become polygons; their recorded holes follow them.
  const polygons: MultiPoly = [];
  for (const contour of contours) {
    if (contour.holeOf !== null) continue;
    const rings: Poly = [contour.points];
    for (const holeId of contour.holeIds) rings.push(contours[holeId].points);
    polygons.push(rings);
  }

  return polygons;
}

// ===========================================================================
// Public API
// ===========================================================================

export interface BooleanReport {
  /** Rings discarded for enclosing no area. See the note on precision above. */
  slivers: number;
  /** True when Z values were present in the input and dropped. */
  droppedZ: boolean;
  /** Set when the operation short-circuited because the inputs are disjoint. */
  trivial?: 'disjoint' | 'empty-subject' | 'empty-clip';
}

export interface BooleanResult {
  polygons: MultiPoly;
  report: BooleanReport;
}

/** Smallest ring area kept, in squared coordinate units. */
const SLIVER_AREA = 1e-9;

function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

/**
 * Splits a contour that revisits a vertex into the separate rings it really is.
 *
 * The sweep traces result components that touch at a single point as ONE
 * contour passing through that point twice. Four triangles left when a diamond
 * is cut out of a square all meet their neighbours at an edge midpoint, so they
 * come back as two bow-ties rather than four triangles.
 *
 * That is not a cosmetic difference. The shoelace formula on a self-touching
 * ring CANCELS the two lobes against each other, so such a ring reports an area
 * that is simply wrong — an XOR of an L-shape and a bar measured 24 m² instead
 * of 64 — and no format defines what a self-touching exterior ring means, so
 * every consumer downstream is free to disagree about it too.
 *
 * Walking with a stack and cutting each loop out as its touch point recurs is
 * O(n) and gives back exactly the simple rings the sweep found.
 */
function splitSelfTouching(points: Position[]): Position[][] {
  const rings: Position[][] = [];
  const stack: Position[] = [];
  const seen = new Map<string, number>();

  for (const point of points) {
    const key = `${point[0]},${point[1]}`;
    const at = seen.get(key);

    if (at === undefined) {
      seen.set(key, stack.length);
      stack.push(point);
      continue;
    }

    // Everything since the first visit is a closed loop hanging off this point.
    const loop = stack.splice(at);
    for (const popped of loop) {
      const poppedKey = `${popped[0]},${popped[1]}`;
      const index = seen.get(poppedKey);
      if (index !== undefined && index >= at) seen.delete(poppedKey);
    }
    if (loop.length >= 3) rings.push(loop);

    seen.set(key, stack.length);
    stack.push(point);
  }

  if (stack.length >= 3) rings.push(stack);
  return rings;
}

/** Is `point` inside `ring`? Used only to re-home holes after a split. */
function inRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const crossesRay =
      ring[i][1] > point[1] !== ring[j][1] > point[1] &&
      point[0] < ((ring[j][0] - ring[i][0]) * (point[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0];
    if (crossesRay) inside = !inside;
  }
  return inside;
}

/**
 * Turns assembled contours into well-formed polygons.
 *
 * Splits self-touching rings, drops what encloses no area, closes the
 * survivors, and re-homes each hole onto whichever exterior ring now contains
 * it — because a split exterior means the hole's original parent may no longer
 * be the ring it sits in.
 */
function cleanResult(polygons: MultiPoly): { polygons: MultiPoly; slivers: number } {
  const out: MultiPoly = [];
  let slivers = 0;

  const usable = (ring: Position[]): Position[][] => {
    const kept: Position[][] = [];
    for (const part of splitSelfTouching(normaliseRing(ring))) {
      if (part.length < 3 || Math.abs(ringArea(part)) < SLIVER_AREA) {
        slivers++;
        continue;
      }
      kept.push(part);
    }
    return kept;
  };

  for (const rings of polygons) {
    const exteriors = usable(rings[0] ?? []);
    // An exterior that vanished takes its holes with it: a hole in nothing is
    // not a hole, and promoting it to an exterior would invent solid ground.
    if (exteriors.length === 0) continue;

    const holes: Position[][] = [];
    for (let index = 1; index < rings.length; index++) holes.push(...usable(rings[index]));

    const assembled: Poly[] = exteriors.map((exterior) => [exterior]);
    for (const hole of holes) {
      const owner = assembled.findIndex((poly) => inRing(hole[0], poly[0]));
      // A hole no exterior contains is a contradiction in the assembly rather
      // than data; dropping it is the only reading that leaves a valid polygon.
      if (owner < 0) {
        slivers++;
        continue;
      }
      assembled[owner].push(hole);
    }

    for (const poly of assembled) {
      out.push(poly.map((ring) => [...ring, ring[0].slice()]));
    }
  }

  return { polygons: out, slivers };
}

function boundsOf(polygons: MultiPoly): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rings of polygons) {
    for (const position of rings[0] ?? []) {
      if (position[0] < minX) minX = position[0];
      if (position[0] > maxX) maxX = position[0];
      if (position[1] < minY) minY = position[1];
      if (position[1] > maxY) maxY = position[1];
    }
  }
  return { minX, minY, maxX, maxY };
}

function hasZ(polygons: MultiPoly): boolean {
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const position of ring) if (position.length > 2) return true;
    }
  }
  return false;
}

/**
 * Runs a boolean operation on two multipolygons.
 *
 * Both operands are treated as sets of rings with holes; the result is a
 * multipolygon with holes assigned. Rings may be given open or closed, in
 * either winding — the sweep derives orientation itself, so a caller does not
 * have to normalise first and cannot get it wrong.
 */
export function booleanOperation(subject: MultiPoly, clip: MultiPoly, operation: BooleanOp): BooleanResult {
  // ---- XOR is composed rather than swept directly.
  //
  // XOR is the only operation that keeps EVERY edge of both polygons in the
  // result: every piece of either boundary separates "inside exactly one" from
  // "inside none or both". That makes it the only operation where a crossing
  // point can carry four result edges at once, and the contour walk pairs them
  // by sweep order, which at such a vertex does not say which incoming edge
  // belongs with which outgoing one.
  //
  // The visible symptom: a square XOR a bar overhanging its right side traced
  // one self-touching curve with the overhang wound backwards, so it was
  // subtracted instead of added — 60 m² reported for a 76 m² answer.
  //
  // The other three operations drop edges, so their arrangements stay
  // unambiguous, and each is covered by its own tests. Building XOR out of them
  // is therefore not papering over a general defect; it is declining to rely on
  // the one case where the tracing is ambiguous, and it is exact:
  //
  //     A △ B  ≡  (A \ B) ∪ (B \ A)
  if (operation === 'xor') {
    const left = booleanOperation(subject, clip, 'difference');
    const right = booleanOperation(clip, subject, 'difference');
    const combined = booleanOperation(left.polygons, right.polygons, 'union');
    return {
      polygons: combined.polygons,
      report: {
        slivers: left.report.slivers + right.report.slivers + combined.report.slivers,
        droppedZ: hasZ(subject) || hasZ(clip),
      },
    };
  }

  const droppedZ = hasZ(subject) || hasZ(clip);
  const report = (extra: Partial<BooleanReport> = {}): BooleanReport => ({ slivers: 0, droppedZ, ...extra });

  // ---- Trivial cases, answered without sweeping.
  if (subject.length === 0 || clip.length === 0) {
    const which = subject.length === 0 ? 'empty-subject' : 'empty-clip';
    switch (operation) {
      case 'intersection':
        return { polygons: [], report: report({ trivial: which }) };
      case 'difference':
        return { polygons: subject.length === 0 ? [] : subject, report: report({ trivial: which }) };
      case 'union':
        return { polygons: subject.length === 0 ? clip : subject, report: report({ trivial: which }) };
    }
  }

  const a = boundsOf(subject);
  const b = boundsOf(clip);
  const disjoint = a.minX > b.maxX || b.minX > a.maxX || a.minY > b.maxY || b.minY > a.maxY;

  if (disjoint) {
    switch (operation) {
      case 'intersection':
        return { polygons: [], report: report({ trivial: 'disjoint' }) };
      case 'difference':
        return { polygons: subject, report: report({ trivial: 'disjoint' }) };
      case 'union':
        return { polygons: [...subject, ...clip], report: report({ trivial: 'disjoint' }) };
    }
  }

  // ---- Sweep.
  const queue = new EventQueue();
  let contourId = 0;
  for (const rings of subject) for (const ring of rings) addRing(ring, true, contourId++, queue);
  for (const rings of clip) for (const ring of rings) addRing(ring, false, contourId++, queue);

  const sorted = subdivide(queue, operation, a.maxX, b.maxX);
  const assembled = connectEdges(sorted);
  const cleaned = cleanResult(assembled);

  return { polygons: cleaned.polygons, report: report({ slivers: cleaned.slivers }) };
}

/** Union of many polygons at once, folded pairwise. */
export function unionAll(polygons: MultiPoly[]): BooleanResult {
  if (polygons.length === 0) return { polygons: [], report: { slivers: 0, droppedZ: false } };

  let accumulated = polygons[0];
  let slivers = 0;
  let droppedZ = hasZ(polygons[0]);

  for (let index = 1; index < polygons.length; index++) {
    const step = booleanOperation(accumulated, polygons[index], 'union');
    accumulated = step.polygons;
    slivers += step.report.slivers;
    droppedZ = droppedZ || step.report.droppedZ;
  }

  return { polygons: accumulated, report: { slivers, droppedZ } };
}
