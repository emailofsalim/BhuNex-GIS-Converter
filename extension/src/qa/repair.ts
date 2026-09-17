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
import type { Bounds, CirDataset, CirFeature, CirLayer, Position } from '../core/cir';
import { expandBounds, SpatialIndex } from '../core/spatial-index';
import { unionAll } from '../core/polygon-boolean';
import { toMultiPolygon } from '../core/geometry-ops';

export type RepairOperationId =
  | 'close-rings'
  | 'remove-duplicate-vertices'
  | 'remove-zero-length-segments'
  | 'fix-ring-orientation'
  | 'remove-spikes'
  | 'snap-vertices'
  | 'simplify'
  | 'densify'
  | 'smooth'
  | 'regularise'
  | 'remove-holes'
  | 'fill-holes'
  | 'repair-self-intersection'
  // Cross-feature. These read one feature to decide what happens to another,
  // so they run through `rewriteAcross` rather than the per-feature `rewrite`.
  | 'snap-shared-edges'
  | 'rebuild-topology'
  | 'merge-adjacent-polygons'
  | 'remove-slivers'
  | 'extend-trim-lines';

/**
 * The operations that cannot be expressed as a per-feature rewrite.
 *
 * `rewrite(feature, …)` sees one feature and nothing else, which is correct for
 * closing a ring or dropping a spike and useless for anything whose answer
 * depends on a NEIGHBOUR. These three take the whole dataset, and the contract
 * §24.1 defines — preview without touching, undo as a diff, protected layers
 * refused — is preserved by `rewriteAcross` rather than reinvented: `planRepair`
 * and `applyRepair` each call it exactly once, so the preview is still literally
 * the apply run without keeping the result.
 */
export const CROSS_FEATURE_OPERATIONS: RepairOperationId[] = [
  'snap-shared-edges',
  'rebuild-topology',
  'merge-adjacent-polygons',
  // `remove-slivers` looks per-feature and is not: it DELETES, and `rewrite`
  // returns a replacement geometry with no way to say "this feature should not
  // exist". The removal machinery lives on this side.
  'remove-slivers',
  // `extend-trim-lines` needs the line it is reaching for, which is another
  // feature by definition.
  'extend-trim-lines',
];

export const REPAIR_LABEL: Record<RepairOperationId, string> = {
  'close-rings': 'Close open rings',
  'remove-duplicate-vertices': 'Remove duplicate vertices',
  'remove-zero-length-segments': 'Remove zero-length segments',
  'fix-ring-orientation': 'Fix ring direction',
  'remove-spikes': 'Remove spikes',
  'snap-vertices': 'Snap nearby vertices together',
  simplify: 'Simplify (Douglas-Peucker)',
  densify: 'Densify (add vertices along long segments)',
  smooth: 'Smooth corners',
  regularise: 'Regularise to right angles',
  'remove-holes': 'Remove small holes',
  'fill-holes': 'Fill all holes',
  'repair-self-intersection': 'Repair self-intersecting rings',
  'snap-shared-edges': 'Snap shared edges between features',
  'rebuild-topology': 'Rebuild topology (snap and node)',
  'merge-adjacent-polygons': 'Merge adjacent polygons',
  'remove-slivers': 'Remove sliver polygons',
  'extend-trim-lines': 'Extend and trim line ends to junctions',
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
  /**
   * Douglas-Peucker band for `simplify`, in dataset units.
   *
   * Deliberately NOT `tolerance`: that one answers "are these the same point",
   * and is a fraction of a millimetre. A simplification band is a survey
   * decision measured in centimetres or metres, and sharing one number would
   * mean either a simplify that does nothing or a duplicate-vertex test that
   * eats real geometry.
   */
  simplifyTolerance: number;
  /** Longest segment `densify` leaves in place, in dataset units. */
  densifyMaxSegment: number;
  /** Chaikin passes for `smooth`. Each pass replaces a corner with two points. */
  smoothIterations: number;
  /** How far off a right angle `regularise` will still pull square, in degrees. */
  regulariseAngleDegrees: number;
  /** Holes with an area at or below this are removed by `remove-holes`. */
  maxHoleArea: number;
  /**
   * Distance within which vertices of DIFFERENT features are one node.
   *
   * Separate from `tolerance`, which asks "are these the same point" inside one
   * feature and is a fraction of a millimetre. The gap between two parcels
   * digitised from different sheets is centimetres, and using the same number
   * for both would mean either a snap that never fires or a duplicate-vertex
   * test that eats real geometry.
   */
  sharedEdgeTolerance: number;
  /**
   * What to do with the lobes of a self-intersecting ring.
   *
   * THE REASON THIS IS A CHOICE AND NOT A CONSTANT. A bowtie has two
   * defensible resolutions and they are answers to different questions:
   *
   *   'split'   keep every lobe, as separate polygons. Conservative — no area
   *             is lost, which on a parcel means no land quietly disappears.
   *             The right answer when the crossing is a genuine feature, or
   *             when you do not yet know which lobe is the mistake.
   *   'largest' keep the biggest lobe and drop the rest. The right answer for
   *             a digitising slip, where a vertex was typed one row out and
   *             produced a hairline lobe nobody intended.
   *
   * There is no way to tell those apart from the geometry, so the tool does
   * not guess: it defaults to the one that destroys nothing and says which it
   * did in the plan.
   */
  selfIntersectionMode: 'split' | 'largest';
  /**
   * Thinness at or below which a polygon is a sliver: 4·pi·area / perimeter².
   *
   * The same measure `qa/defects.ts` detects with, deliberately — a repair
   * that used a different definition from the check that reported the problem
   * would leave defects on screen after "fixing" them. 1 is a perfect circle;
   * a square is about 0.785; a 100 m × 2 cm shaving is about 0.0008.
   */
  sliverThinnessThreshold: number;
  /**
   * Area below which a thin polygon is a sliver, in squared dataset units.
   *
   * BOTH tests must pass. Thinness alone would delete a legitimate road
   * reserve or a river strip, which are long, thin and entirely real.
   */
  sliverMaxArea: number;
  /**
   * How far `extend-trim-lines` will reach for a junction, in dataset units.
   *
   * Separate from `sharedEdgeTolerance`, which asks "is this already the same
   * node". This one asks "was this meant to reach that line", and the answer
   * is a survey judgement about digitising error — a couple of centimetres on
   * a plan sheet, not a fraction of a millimetre. Beyond it a line end is
   * taken to be a genuine dangle, ending where it was drawn to end.
   */
  danglingTolerance: number;
}

export const DEFAULT_REPAIR_SETTINGS: RepairOptions = {
  tolerance: 0.001,
  spikeAngleDegrees: 5,
  protectedLayers: [],
  maxSafeClosureGap: 0.05,
  simplifyTolerance: 0.05,
  densifyMaxSegment: 10,
  smoothIterations: 1,
  regulariseAngleDegrees: 15,
  maxHoleArea: 1,
  sharedEdgeTolerance: 0.05,
  // The resolution that loses nothing. Dropping a lobe is a decision the user
  // makes, not one a default makes for them.
  selfIntersectionMode: 'split',
  // Matching `DEFAULT_TOPOLOGY_SETTINGS` in qa/defects.ts, so what the scan
  // calls a sliver is what the repair removes.
  sliverThinnessThreshold: 0.02,
  sliverMaxArea: 0.5,
  danglingTolerance: 0.25,
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
  /**
   * Features the operation REMOVED, each with the index it sat at.
   *
   * `merge-adjacent-polygons` is the only operation that deletes anything, and
   * a geometry-only diff cannot reverse a deletion — there is no surviving
   * feature to restore geometry onto. The whole feature is held instead, which
   * is still a diff: three parcels merged costs two stored features, not the
   * four hundred thousand in the layer.
   */
  removed?: { layer: string; featureIndex: number; feature: CirFeature }[];
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

/** Perpendicular distance from `point` to the infinite line through a-b. */
function perpendicularDistance(point: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return distance(point, a);
  // Twice the triangle area over the base length.
  return Math.abs(dy * point[0] - dx * point[1] + b[0] * a[1] - b[1] * a[0]) / Math.hypot(dx, dy);
}

/**
 * Douglas-Peucker. Returns the kept subset of `path`, endpoints always included.
 *
 * Iterative rather than recursive: a contour with 400,000 vertices is an
 * ordinary input here, and the recursive form blows the stack on one.
 */
function douglasPeucker(path: Position[], tolerance: number): Position[] {
  if (path.length < 3) return path;
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    let worst = 0;
    let worstIndex = -1;
    for (let index = first + 1; index < last; index++) {
      const offset = perpendicularDistance(path[index], path[first], path[last]);
      if (offset > worst) {
        worst = offset;
        worstIndex = index;
      }
    }
    if (worstIndex >= 0 && worst > tolerance) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }

  return path.filter((_, index) => keep[index] === 1);
}

/** Splits any segment longer than `maxSegment` into equal parts. */
function densifyPath(path: Position[], maxSegment: number): Position[] {
  if (path.length < 2 || !(maxSegment > 0)) return path;
  const out: Position[] = [path[0]];
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1];
    const to = path[index];
    const span = distance(from, to);
    const pieces = Math.ceil(span / maxSegment);
    for (let piece = 1; piece < pieces; piece++) {
      const ratio = piece / pieces;
      // Z is carried through by interpolation when both ends have one, so a
      // densified contour stays on its own surface instead of dropping to 2D.
      const position: Position =
        from.length > 2 && to.length > 2
          ? [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio, from[2] + (to[2] - from[2]) * ratio]
          : [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio];
      out.push(position);
    }
    out.push(to);
  }
  return out;
}

/**
 * Chaikin corner cutting. Each pass replaces every interior corner with two
 * points at 1/4 and 3/4 of its adjacent segments.
 *
 * A closed ring is smoothed all the way round. An open line keeps both
 * endpoints exactly, because a line's ends are usually where it meets
 * something else.
 */
function chaikin(path: Position[], closed: boolean, passes: number): Position[] {
  let current = path;
  for (let pass = 0; pass < passes; pass++) {
    if (current.length < 3) return current;
    const source = closed ? current.slice(0, -1) : current;
    const out: Position[] = [];
    if (!closed) out.push(source[0]);
    const limit = closed ? source.length : source.length - 1;
    for (let index = 0; index < limit; index++) {
      const from = source[index];
      const to = source[(index + 1) % source.length];
      out.push([from[0] + (to[0] - from[0]) * 0.25, from[1] + (to[1] - from[1]) * 0.25]);
      out.push([from[0] + (to[0] - from[0]) * 0.75, from[1] + (to[1] - from[1]) * 0.75]);
    }
    if (closed) out.push(out[0]);
    else out.push(source[source.length - 1]);
    current = out;
  }
  return current;
}

/** Shoelace area of a ring, unsigned. */
function ringArea(ring: Position[]): number {
  if (ring.length < 4) return 0;
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    sum += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return Math.abs(sum) / 2;
}

/**
 * Where two segments cross, or null when they do not.
 *
 * Returns the parameters along BOTH segments as well as the point, because
 * every caller here needs to know how far along a crossing is: the ring
 * decomposition sorts insertions by it, and the trim decides whether the tail
 * past the crossing is short enough to be an overshoot.
 *
 * Endpoints count as crossings (`>= 0`, `<= 1`) on purpose. A line ending
 * exactly on another line is the T-junction the whole exercise is about, and
 * excluding it would make `extend-trim-lines` blind to the case where the
 * digitiser got it right.
 */
function segmentIntersection(
  a: Position,
  b: Position,
  c: Position,
  d: Position
): { point: Position; t: number; u: number } | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denominator = rx * sy - ry * sx;
  // Parallel, which includes collinear. Collinear overlap has no single
  // crossing point, and inventing one would put a vertex at an arbitrary
  // place along a shared edge.
  if (denominator === 0) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denominator;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: [a[0] + t * rx, a[1] + t * ry], t, u };
}

/** The perimeter of a path, used by the sliver test. */
function pathLength(path: Position[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index++) total += distance(path[index - 1], path[index]);
  return total;
}

/**
 * How round a ring is: 4·pi·area / perimeter², between 0 and 1.
 *
 * The SAME measure `qa/defects.ts` reports a sliver with. Sharing it is the
 * point: a repair that used its own definition would leave the scan still
 * showing defects it had just been told were fixed.
 *
 * 1 is a circle, ~0.785 a square, and a 100 m by 2 cm shaving about 0.0008.
 */
function thinness(ring: Position[]): number {
  const perimeter = pathLength(ring);
  if (perimeter <= 0) return 1;
  return (4 * Math.PI * ringArea(ring)) / (perimeter * perimeter);
}

/**
 * Breaks a self-intersecting ring into the simple rings it is made of.
 *
 * WHAT A BOWTIE IS. A ring whose boundary crosses itself encloses no
 * well-defined area: the shoelace sum counts one lobe positive and the other
 * negative, so a figure-eight of two equal lobes reports an area of zero. Every
 * downstream consumer — the writers, the boolean engine, a CAD hatch — is
 * entitled to assume that does not happen, and most of them fail quietly
 * rather than loudly when it does.
 *
 * THE ALGORITHM, and why this one. Every crossing point is inserted into the
 * ring as a real vertex first, so the ring becomes a closed walk in which each
 * crossing appears TWICE. Walking that with a stack, a point seen before means
 * everything since its first appearance is a closed loop: pop it off and emit
 * it. What remains continues the walk. This is the standard decomposition and
 * it terminates because each pop shortens the stack by at least the loop.
 *
 * Rings are returned largest first, so a caller keeping one keeps the one a
 * person would call "the parcel".
 */
function decomposeSelfIntersection(ring: Position[]): Position[][] {
  if (ring.length < 4) return [ring];

  // ---- pass one: find every crossing, grouped by the segment it lies on.
  const insertions = new Map<number, { t: number; point: Position }[]>();
  let found = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    for (let j = i + 1; j < ring.length - 1; j++) {
      // Adjacent segments share an endpoint by construction, and the first and
      // last share one because the ring is closed. Neither is a crossing.
      if (j === i || j === i + 1 || (i === 0 && j === ring.length - 2)) continue;
      const hit = segmentIntersection(ring[i], ring[i + 1], ring[j], ring[j + 1]);
      if (!hit) continue;
      // A crossing exactly at a shared vertex is the vertex, not a crossing.
      if ((hit.t === 0 || hit.t === 1) && (hit.u === 0 || hit.u === 1)) continue;
      found++;
      for (const [segment, parameter] of [
        [i, hit.t],
        [j, hit.u],
      ] as [number, number][]) {
        const list = insertions.get(segment) ?? [];
        list.push({ t: parameter, point: hit.point });
        insertions.set(segment, list);
      }
    }
  }
  if (found === 0) return [ring];

  // ---- pass two: rebuild the ring with the crossings in it, in order.
  const walk: Position[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    walk.push(ring[i]);
    const list = insertions.get(i);
    if (!list) continue;
    for (const entry of [...list].sort((left, right) => left.t - right.t)) {
      const last = walk[walk.length - 1];
      if (distance(last, entry.point) > 0) walk.push(entry.point);
    }
  }

  // ---- pass three: pop a loop each time the walk revisits a point.
  //
  // Keyed on the coordinate pair rather than on identity, because a crossing
  // point is a DIFFERENT array object on each of the two segments it was
  // inserted into — identity would never match and nothing would ever pop.
  const key = (position: Position): string => `${position[0]},${position[1]}`;
  const loops: Position[][] = [];
  const stack: Position[] = [];
  const seen = new Map<string, number>();

  for (const position of walk) {
    const at = seen.get(key(position));
    if (at !== undefined) {
      const loop = stack.splice(at);
      for (const dropped of loop) seen.delete(key(dropped));
      loop.push(loop[0]);
      if (loop.length >= 4 && ringArea(loop) > 0) loops.push(loop);
    }
    seen.set(key(position), stack.length);
    stack.push(position);
  }
  if (stack.length >= 3) {
    const tail = [...stack, stack[0]];
    if (ringArea(tail) > 0) loops.push(tail);
  }

  if (loops.length === 0) return [ring];
  return loops.sort((left, right) => ringArea(right) - ringArea(left));
}

/**
 * Pulls a ring square.
 *
 * Works in the frame of its own longest edge rather than the grid axes: a
 * building is rarely aligned to north, and squaring it to north would be a
 * rotation dressed up as a repair. Inside that frame, any edge lying within
 * `toleranceDegrees` of horizontal or vertical has its two endpoints averaged
 * onto one coordinate, which makes the edge exactly axis-parallel while
 * keeping it joined to its neighbours. Edges further off are left alone — a
 * genuine diagonal wall is not an error.
 */
function regularisePath(path: Position[], toleranceDegrees: number): Position[] {
  if (path.length < 4) return path;
  const closed = distance(path[0], path[path.length - 1]) === 0;
  const source = closed ? path.slice(0, -1) : path.slice();
  if (source.length < 3) return path;

  let longest = 0;
  let bearing = 0;
  for (let index = 0; index < source.length; index++) {
    const from = source[index];
    const to = source[(index + 1) % source.length];
    const span = distance(from, to);
    if (span > longest) {
      longest = span;
      bearing = Math.atan2(to[1] - from[1], to[0] - from[0]);
    }
  }
  if (longest === 0) return path;

  const cos = Math.cos(-bearing);
  const sin = Math.sin(-bearing);
  const rotated = source.map((position): Position => [
    position[0] * cos - position[1] * sin,
    position[0] * sin + position[1] * cos,
  ]);

  const tolerance = (toleranceDegrees * Math.PI) / 180;
  const limit = closed ? rotated.length : rotated.length - 1;
  for (let index = 0; index < limit; index++) {
    const next = (index + 1) % rotated.length;
    const dx = rotated[next][0] - rotated[index][0];
    const dy = rotated[next][1] - rotated[index][1];
    if (dx === 0 && dy === 0) continue;
    const angle = Math.atan2(dy, dx);
    // Distance to the nearest multiple of 90 degrees.
    const quarter = Math.PI / 2;
    const offset = angle - Math.round(angle / quarter) * quarter;
    if (Math.abs(offset) > tolerance) continue;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const y = (rotated[index][1] + rotated[next][1]) / 2;
      rotated[index][1] = y;
      rotated[next][1] = y;
    } else {
      const x = (rotated[index][0] + rotated[next][0]) / 2;
      rotated[index][0] = x;
      rotated[next][0] = x;
    }
  }

  const back = Math.cos(bearing);
  const backSin = Math.sin(bearing);
  const result = rotated.map((position): Position => [
    position[0] * back - position[1] * backSin,
    position[0] * backSin + position[1] * back,
  ]);
  if (closed) result.push(result[0]);
  return result;
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

  if (CROSS_FEATURE_OPERATIONS.includes(operation)) {
    const cross = rewriteAcross(dataset, operation, scope, settings);
    return {
      operation,
      scope,
      options: settings,
      changes: cross.changes,
      refused: cross.refused,
      maxDisplacement: cross.maxDisplacement,
    };
  }

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

  if (CROSS_FEATURE_OPERATIONS.includes(operation)) {
    // ONE call, from which the plan, the new dataset and the undo record are
    // all derived — the same guarantee the per-feature path gets by having
    // plan and apply both call `rewrite`.
    const cross = rewriteAcross(dataset, operation, scope, settings);
    const undo: UndoRecord = { label: REPAIR_LABEL[operation], entries: [], removed: [] };

    const layers = dataset.layers.map((layer) => {
      const edits = cross.geometries.get(layer.name);
      const drop = cross.removals.get(layer.name);
      if (!edits && !drop) return layer;

      const features: CirFeature[] = [];
      layer.features.forEach((feature, featureIndex) => {
        if (drop?.has(featureIndex)) {
          undo.removed!.push({ layer: layer.name, featureIndex, feature });
          return;
        }
        if (edits?.has(featureIndex)) {
          undo.entries.push({ layer: layer.name, featureIndex, geometry: feature.geometry });
          features.push({ ...feature, geometry: edits.get(featureIndex)! });
          return;
        }
        features.push(feature);
      });

      return { ...layer, features };
    });

    const plan: RepairPlan = {
      operation,
      scope,
      options: settings,
      changes: cross.changes,
      refused: cross.refused,
      maxDisplacement: cross.maxDisplacement,
    };
    if (undo.removed!.length === 0) delete undo.removed;
    return { dataset: { ...dataset, layers }, plan, undo };
  }

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

  // Removals are grouped per layer and replayed in ASCENDING index order, so
  // each re-inserted feature lands at the index it originally held. Descending
  // order would put every one of them in the wrong place as soon as a layer
  // lost two features, because each insert shifts the ones after it.
  const removedByLayer = new Map<string, { featureIndex: number; feature: CirFeature }[]>();
  for (const entry of record.removed ?? []) {
    const existing = removedByLayer.get(entry.layer) ?? [];
    existing.push({ featureIndex: entry.featureIndex, feature: entry.feature });
    removedByLayer.set(entry.layer, existing);
  }

  const layers = dataset.layers.map((layer) => {
    const restore = byLayer.get(layer.name);
    const reinsert = removedByLayer.get(layer.name);
    if (!restore && !reinsert) return layer;

    let features = restore
      ? layer.features.map((feature, index) =>
          restore.has(index) ? { ...feature, geometry: restore.get(index)! } : feature
        )
      : [...layer.features];

    if (reinsert) {
      features = [...features];
      for (const entry of [...reinsert].sort((left, right) => left.featureIndex - right.featureIndex)) {
        features.splice(Math.min(entry.featureIndex, features.length), 0, entry.feature);
      }
    }

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

  // Hole operations DELETE rings, which `mapPaths` cannot express — it maps
  // each ring to a ring. They also only mean anything on a polygon, so they
  // are handled here rather than being a case that silently does nothing on
  // every line in the layer.
  // SELF-INTERSECTION, handled here for the same reason the hole operations
  // are: `mapPaths` maps one ring to one ring, and the whole point of this is
  // that one ring becomes several.
  if (operation === 'repair-self-intersection') {
    const geometry = feature.geometry;
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
    const all = geometry.type === 'Polygon' ? [geometry.coordinates as Position[][]] : (geometry.coordinates as Position[][][]);

    const rebuilt: Position[][][] = [];
    let repaired = 0;
    let dropped = 0;
    let droppedArea = 0;
    let where: Position | undefined;

    for (const polygon of all) {
      if (polygon.length === 0) continue;
      const exterior = polygon[0];
      const holes = polygon.slice(1);
      const loops = decomposeSelfIntersection(exterior);

      if (loops.length <= 1) {
        rebuilt.push(polygon);
        continue;
      }
      repaired++;
      where = where ?? loops[0][0];

      if (settings.selfIntersectionMode === 'largest') {
        // `decomposeSelfIntersection` returns largest first, so this is it.
        for (const loop of loops.slice(1)) droppedArea += ringArea(loop);
        dropped += loops.length - 1;
        rebuilt.push([loops[0], ...holes]);
      } else {
        // Every lobe survives as its own polygon. The holes ride with the
        // FIRST (largest) lobe rather than being tested against each: a hole
        // belongs inside exactly one lobe, and re-deciding which without a
        // point-in-polygon test would be a guess. Testing properly is what
        // the boolean engine is for, and running a union here would change
        // the boundary, which this operation must not do.
        loops.forEach((loop, index) => rebuilt.push(index === 0 ? [loop, ...holes] : [loop]));
      }
    }

    if (repaired === 0) return null;

    changes.push({
      location: where,
      description:
        settings.selfIntersectionMode === 'largest'
          ? `${repaired} self-intersecting ring${repaired === 1 ? '' : 's'} resolved by keeping the largest lobe; ` +
            `${dropped} smaller lobe${dropped === 1 ? '' : 's'} totalling ${droppedArea.toFixed(4)} sq units removed.`
          : `${repaired} self-intersecting ring${repaired === 1 ? '' : 's'} split into separate polygons at the crossing. ` +
            'No area is lost and no boundary moves.',
      // Nothing is moved: a vertex is inserted at the crossing, which already
      // lies on both edges, and the ring is cut there. Reporting a
      // displacement would overstate it — even in `largest` mode, where the
      // change is a deletion rather than a move.
      maxDisplacement: 0,
    });

    return {
      geometry:
        rebuilt.length === 1
          ? { ...geometry, type: 'Polygon', coordinates: rebuilt[0] }
          : { ...geometry, type: 'MultiPolygon', coordinates: rebuilt },
      changes,
      maxDisplacement: 0,
    };
  }

  if (operation === 'remove-holes' || operation === 'fill-holes') {
    const geometry = feature.geometry;
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
    const all = geometry.type === 'Polygon' ? [geometry.coordinates as Position[][]] : (geometry.coordinates as Position[][][]);

    let dropped = 0;
    let largestDropped = 0;
    const kept = all.map((polygon) =>
      polygon.filter((ring, index) => {
        if (index === 0) return true; // never the exterior
        const area = ringArea(ring);
        // "Fill all" takes every hole; "remove small" takes only those at or
        // under the stated area, so a genuine courtyard survives a tidy-up
        // aimed at digitising noise.
        const remove = operation === 'fill-holes' || area <= settings.maxHoleArea;
        if (remove) {
          dropped++;
          if (area > largestDropped) largestDropped = area;
        }
        return !remove;
      })
    );

    if (dropped === 0) return null;
    changes.push({
      location: all[0]?.[0]?.[0],
      description:
        operation === 'fill-holes'
          ? `${dropped} hole${dropped === 1 ? '' : 's'} filled; the largest was ${largestDropped.toFixed(4)} square units. The exterior boundary does not move.`
          : `${dropped} hole${dropped === 1 ? '' : 's'} of ${settings.maxHoleArea} square units or less removed; the largest was ${largestDropped.toFixed(4)}. The exterior boundary does not move.`,
      // Removing a hole adds area but moves no surviving vertex.
      maxDisplacement: 0,
    });

    return {
      geometry:
        geometry.type === 'Polygon'
          ? { ...geometry, coordinates: kept[0] }
          : { ...geometry, coordinates: kept },
      changes,
      maxDisplacement: 0,
    };
  }

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

      case 'simplify': {
        // A ring must keep four positions to stay a ring, a line two to stay a
        // line. Douglas-Peucker on a closed ring runs on the open path so the
        // closing duplicate is not a candidate for removal.
        const floor = closed ? 4 : 2;
        if (path.length <= floor) return path;
        const open = closed ? path.slice(0, -1) : path;
        let kept = douglasPeucker(open, settings.simplifyTolerance);
        if (closed && kept.length < 3) return path;
        if (closed) kept = [...kept, kept[0]];
        const removed = path.length - kept.length;
        if (removed === 0) return path;
        // The band IS the bound on displacement: no kept vertex moves, and no
        // dropped one was further than this from the line that replaces it.
        const shift = settings.simplifyTolerance;
        changes.push({
          location: path[0],
          description: `${removed} vert${removed === 1 ? 'ex' : 'ices'} removed; no remaining vertex moves and the boundary shifts by at most ${shift} units.`,
          maxDisplacement: shift,
        });
        if (shift > maxDisplacement) maxDisplacement = shift;
        return kept;
      }

      case 'densify': {
        if (path.length < 2) return path;
        const dense = densifyPath(path, settings.densifyMaxSegment);
        const added = dense.length - path.length;
        if (added === 0) return path;
        changes.push({
          location: path[0],
          description: `${added} vert${added === 1 ? 'ex' : 'ices'} added so no segment exceeds ${settings.densifyMaxSegment} units. Every original position is kept and nothing moves.`,
          maxDisplacement: 0,
        });
        return dense;
      }

      case 'smooth': {
        if (path.length < 3) return path;
        const smoothed = chaikin(path, closed, Math.max(1, settings.smoothIterations));
        let largest = 0;
        for (const position of path) {
          let nearest = Infinity;
          for (const candidate of smoothed) {
            const gap = distance(position, candidate);
            if (gap < nearest) nearest = gap;
          }
          if (nearest > largest) largest = nearest;
        }
        changes.push({
          location: path[0],
          description: `Corners cut over ${Math.max(1, settings.smoothIterations)} pass(es); the boundary moves by up to ${largest.toFixed(4)} units.`,
          maxDisplacement: largest,
        });
        if (largest > maxDisplacement) maxDisplacement = largest;
        return smoothed;
      }

      case 'regularise': {
        if (!closed || path.length < 4) return path;
        const squared = regularisePath(path, settings.regulariseAngleDegrees);
        let largest = 0;
        for (let index = 0; index < Math.min(path.length, squared.length); index++) {
          const shift = distance(path[index], squared[index]);
          if (shift > largest) largest = shift;
        }
        if (largest === 0) return path;
        changes.push({
          location: path[0],
          description: `Edges within ${settings.regulariseAngleDegrees}° of square pulled to right angles; the largest vertex move is ${largest.toFixed(4)} units.`,
          maxDisplacement: largest,
        });
        if (largest > maxDisplacement) maxDisplacement = largest;
        return squared;
      }

      default:
        return path;
    }
  });

  if (changes.length === 0) return null;
  return { geometry, changes, maxDisplacement };
}

// ---------------------------------------------------------------- cross-feature

/** One feature's address, resolved once so the passes below can share it. */
interface Addressed {
  layer: string;
  featureIndex: number;
  feature: CirFeature;
}

interface CrossRewrite {
  /** layer name → feature index → replacement geometry. */
  geometries: Map<string, Map<number, CirFeature['geometry']>>;
  /** layer name → feature indices the operation deletes. */
  removals: Map<string, Set<number>>;
  changes: RepairChange[];
  refused: RepairPlan['refused'];
  maxDisplacement: number;
}

/** Every in-scope, unprotected feature, with the refusals the skip produced. */
function addressable(
  dataset: CirDataset,
  scope: RepairScope,
  settings: RepairOptions
): { items: Addressed[]; refused: RepairPlan['refused'] } {
  const items: Addressed[] = [];
  const refused: RepairPlan['refused'] = [];

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
    layer.features.forEach((feature, featureIndex) => {
      if (!inScope(layer, feature, scope)) return;
      items.push({ layer: layer.name, featureIndex, feature });
    });
  }

  return { items, refused };
}

/** A degenerate box around a point, grown by `pad`, for a tolerance query. */
function pointBounds(position: Position, pad: number): Bounds {
  return { minX: position[0] - pad, maxX: position[0] + pad, minY: position[1] - pad, maxY: position[1] + pad };
}

function geometryBounds(geometry: CirFeature['geometry']): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  eachPosition(geometry, (position) => {
    if (position[0] < minX) minX = position[0];
    if (position[0] > maxX) maxX = position[0];
    if (position[1] < minY) minY = position[1];
    if (position[1] > maxY) maxY = position[1];
  });
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Visits every coordinate of a geometry, whatever its type. */
function eachPosition(geometry: CirFeature['geometry'], visit: (position: Position) => void): void {
  if (!geometry) return;
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      visit(value as Position);
      return;
    }
    for (const child of value) walk(child);
  };
  walk((geometry as { coordinates?: unknown }).coordinates);
}

/**
 * Where a point falls on a segment, and how far off it is.
 *
 * `t` is the fraction along a→b, clamped to the segment, so a point beyond
 * either end reports the end rather than a projection off in space.
 */
function projectOnSegment(point: Position, a: Position, b: Position): { t: number; distance: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { t: 0, distance: distance(point, a) };
  let t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const closest: Position = [a[0] + dx * t, a[1] + dy * t];
  return { t, distance: distance(point, closest) };
}

/**
 * Collapses vertices of DIFFERENT features that sit within the tolerance onto a
 * single shared node.
 *
 * WHICH POSITION WINS. The cluster's mean, not its first member. "First" here
 * would mean whichever feature happens to come first in the file, which is an
 * arbitrary authority to hand one parcel over its neighbour — and it is not
 * even stable, since re-ordering the layer would change the answer. The mean
 * distributes the correction, and the plan reports the largest single move so
 * the size of that correction is never hidden.
 *
 * Clustering is single-pass and greedy: a vertex joins the first cluster whose
 * representative it is within tolerance of. Chains longer than the tolerance
 * therefore do not collapse end to end, which is the behaviour you want — a
 * run of vertices 4 cm apart under a 5 cm tolerance should not slide into one
 * point.
 */
function buildNodeClusters(items: Addressed[], tolerance: number): Map<string, Position> {
  const vertices: { position: Position; owner: number }[] = [];
  items.forEach((item, owner) => {
    eachPosition(item.feature.geometry, (position) => vertices.push({ position, owner }));
  });

  const index = new SpatialIndex(vertices.map((vertex) => ({ bounds: pointBounds(vertex.position, 0), value: vertex })));
  const clusterOf = new Int32Array(vertices.length).fill(-1);
  const clusters: { sumX: number; sumY: number; count: number; owners: Set<number> }[] = [];

  for (let i = 0; i < vertices.length; i++) {
    if (clusterOf[i] !== -1) continue;
    const cluster = { sumX: 0, sumY: 0, count: 0, owners: new Set<number>() };
    const id = clusters.length;
    clusters.push(cluster);

    for (const candidate of index.search(pointBounds(vertices[i].position, tolerance))) {
      if (clusterOf[candidate] !== -1) continue;
      if (distance(vertices[i].position, vertices[candidate].position) > tolerance) continue;
      clusterOf[candidate] = id;
      cluster.sumX += vertices[candidate].position[0];
      cluster.sumY += vertices[candidate].position[1];
      cluster.count++;
      cluster.owners.add(vertices[candidate].owner);
    }
  }

  // Only clusters spanning MORE THAN ONE feature are shared nodes. A cluster
  // inside a single feature is a duplicate vertex, which is a different
  // operation with a different tolerance and is not this one's business.
  const moves = new Map<string, Position>();
  for (let i = 0; i < vertices.length; i++) {
    const cluster = clusters[clusterOf[i]];
    if (!cluster || cluster.owners.size < 2) continue;
    const target: Position = [cluster.sumX / cluster.count, cluster.sumY / cluster.count];
    const from = vertices[i].position;
    if (distance(from, target) === 0) continue;
    moves.set(`${from[0]},${from[1]}`, target);
  }
  return moves;
}

/**
 * The cross-feature operations, planned over the whole dataset at once.
 *
 * Called exactly once by `planRepair` and exactly once by `applyRepair`, which
 * is what keeps the preview and the commit identical without a second code
 * path — the same property the per-feature `rewrite` gives the other nine.
 */
function rewriteAcross(
  dataset: CirDataset,
  operation: RepairOperationId,
  scope: RepairScope,
  settings: RepairOptions
): CrossRewrite {
  const { items, refused } = addressable(dataset, scope, settings);
  const geometries = new Map<string, Map<number, CirFeature['geometry']>>();
  const removals = new Map<string, Set<number>>();
  const changes: RepairChange[] = [];
  let maxDisplacement = 0;

  const record = (item: Addressed, geometry: CirFeature['geometry']): void => {
    const existing = geometries.get(item.layer) ?? new Map<number, CirFeature['geometry']>();
    existing.set(item.featureIndex, geometry);
    geometries.set(item.layer, existing);
  };

  if (operation === 'merge-adjacent-polygons') {
    return mergeAdjacent(items, refused, settings);
  }
  if (operation === 'remove-slivers') {
    return removeSlivers(items, refused, settings);
  }
  if (operation === 'extend-trim-lines') {
    return extendTrimLines(items, refused, settings);
  }

  const tolerance = settings.sharedEdgeTolerance;
  const moves = buildNodeClusters(items, tolerance);

  // Pass one: every vertex that belongs to a shared node moves to it.
  const snapped: (CirFeature['geometry'] | null)[] = items.map((item) => {
    if (!item.feature.geometry || moves.size === 0) return null;
    let moved = 0;
    let largest = 0;
    let where: Position | undefined;
    const geometry = mapPaths(item.feature.geometry, (path) =>
      path.map((position) => {
        const target = moves.get(`${position[0]},${position[1]}`);
        if (!target) return position;
        const shift = distance(position, target);
        if (shift === 0) return position;
        moved++;
        if (shift > largest) {
          largest = shift;
          where = position;
        }
        return position.length > 2 ? ([target[0], target[1], position[2]] as Position) : target;
      })
    );
    if (moved === 0) return null;
    changes.push({
      layer: item.layer,
      featureId: item.feature.id,
      location: where,
      description: `${moved} vert${moved === 1 ? 'ex' : 'ices'} snapped onto a node shared with a neighbouring feature; the largest move is ${largest.toFixed(4)} units.`,
      maxDisplacement: largest,
    });
    if (largest > maxDisplacement) maxDisplacement = largest;
    return geometry;
  });

  snapped.forEach((geometry, position) => {
    if (geometry) record(items[position], geometry);
  });

  if (operation === 'snap-shared-edges') {
    return { geometries, removals, changes, refused, maxDisplacement };
  }

  // Pass two, `rebuild-topology` only: T-JUNCTION NODES.
  //
  // A corner of parcel A touching the MIDDLE of parcel B's edge is the defect
  // snapping cannot reach — the positions already agree, so there is nothing to
  // move, but B has no vertex there. Every later overlay, dissolve or union
  // then sees a boundary that diverges by the sagitta of that segment and
  // leaves a sliver. Inserting the node into B is what makes the two agree.
  const current = items.map(
    (item, position) => snapped[position] ?? item.feature.geometry
  );

  const nodes: Position[] = [];
  current.forEach((geometry) => eachPosition(geometry, (position) => nodes.push(position)));
  const nodeIndex = new SpatialIndex(nodes.map((position) => ({ bounds: pointBounds(position, 0), value: position })));

  current.forEach((geometry, position) => {
    if (!geometry) return;
    let inserted = 0;
    let where: Position | undefined;

    const noded = mapPaths(geometry, (path) => {
      if (path.length < 2) return path;
      const out: Position[] = [path[0]];
      for (let segment = 1; segment < path.length; segment++) {
        const from = path[segment - 1];
        const to = path[segment];
        const box: Bounds = {
          minX: Math.min(from[0], to[0]) - tolerance,
          maxX: Math.max(from[0], to[0]) + tolerance,
          minY: Math.min(from[1], to[1]) - tolerance,
          maxY: Math.max(from[1], to[1]) + tolerance,
        };
        const hits: { t: number; position: Position }[] = [];
        for (const candidate of nodeIndex.search(box)) {
          const node = nodes[candidate];
          // Already an endpoint of this segment: nothing to insert.
          if (distance(node, from) <= tolerance || distance(node, to) <= tolerance) continue;
          const projected = projectOnSegment(node, from, to);
          if (projected.distance > tolerance) continue;
          if (projected.t <= 0 || projected.t >= 1) continue;
          hits.push({ t: projected.t, position: node });
        }
        hits.sort((left, right) => left.t - right.t);
        let previous = -1;
        for (const hit of hits) {
          if (hit.t === previous) continue;
          previous = hit.t;
          out.push(hit.position);
          inserted++;
          where ??= hit.position;
        }
        out.push(to);
      }
      return out;
    });

    if (inserted === 0) return;
    changes.push({
      layer: items[position].layer,
      featureId: items[position].feature.id,
      location: where,
      description: `${inserted} node${inserted === 1 ? '' : 's'} inserted where a neighbouring feature's vertex sits on this boundary. No existing position moves.`,
      maxDisplacement: 0,
    });
    record(items[position], noded);
  });

  return { geometries, removals, changes, refused, maxDisplacement };
}

/**
 * Unions polygons that share a boundary, keeping one feature per group.
 *
 * ADJACENCY IS TESTED BY SHARED NODES, not by a boolean intersection: two
 * parcels that touch along an edge have an intersection of zero area, so an
 * area test reports them as unrelated. Two vertices within the tolerance is the
 * cheap statement of "these share an edge", and it is the same tolerance the
 * snapping operations use, so running snap first makes this find more.
 *
 * ATTRIBUTES. The lowest-indexed feature of each group survives and keeps its
 * properties; the others are removed and theirs go with them. There is no
 * defensible way to merge two owners into one field, so the plan SAYS what is
 * being dropped rather than inventing a rule.
 */
function mergeAdjacent(
  items: Addressed[],
  refused: RepairPlan['refused'],
  settings: RepairOptions
): CrossRewrite {
  const geometries = new Map<string, Map<number, CirFeature['geometry']>>();
  const removals = new Map<string, Set<number>>();
  const changes: RepairChange[] = [];

  const polygons = items.filter(
    (item) => item.feature.geometry?.type === 'Polygon' || item.feature.geometry?.type === 'MultiPolygon'
  );
  if (polygons.length < 2) return { geometries, removals, changes, refused, maxDisplacement: 0 };

  const tolerance = settings.sharedEdgeTolerance;
  // GROWN BY THE TOLERANCE, and that is not a detail.
  //
  // Two parcels digitised 3 cm apart have bounds that do not touch: one ends at
  // x=412010, the next starts at 412010.03, and `boundsIntersect` says no. They
  // would never become a candidate pair, so the operation would find nothing in
  // precisely the case it exists for — while still passing a test whose parcels
  // share exact coordinates. Found by driving the real panel, not by the suite.
  const boxes = polygons.map((item) => {
    const bounds = geometryBounds(item.feature.geometry);
    return bounds ? expandBounds(bounds, tolerance) : null;
  });
  const index = new SpatialIndex(
    polygons.map((_, position) => ({
      bounds: boxes[position] ?? { minX: 0, maxX: 0, minY: 0, maxY: 0 },
      value: position,
    }))
  );

  // Union-find over "shares at least two nodes with".
  const parent = polygons.map((_, position) => position);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== root) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const join = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };

  const verticesOf = polygons.map((item) => {
    const list: Position[] = [];
    eachPosition(item.feature.geometry, (position) => list.push(position));
    return list;
  });

  index.eachCandidatePair((left, right) => {
    const a = index.item(left).value;
    const b = index.item(right).value;
    let shared = 0;
    for (const position of verticesOf[a]) {
      for (const other of verticesOf[b]) {
        if (distance(position, other) <= tolerance) {
          shared++;
          break;
        }
      }
      // Two shared nodes is an edge. More is still an edge, so stop counting.
      if (shared >= 2) break;
    }
    if (shared >= 2) join(a, b);
  });

  const groups = new Map<number, number[]>();
  polygons.forEach((_, position) => {
    const root = find(position);
    const existing = groups.get(root) ?? [];
    existing.push(position);
    groups.set(root, existing);
  });

  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((left, right) => left - right);
    const survivor = polygons[ordered[0]];
    const united = unionAll(ordered.map((position) => toMultiPolygon(polygons[position].feature.geometry)));
    if (united.polygons.length === 0) continue;

    // Dimension 2, matching what `geometry-ops` records for the same union:
    // the boolean works in plan and reports `droppedZ`, so calling the result
    // 3D would be a claim about elevations the operation did not carry.
    const geometry: CirFeature['geometry'] =
      united.polygons.length === 1
        ? { type: 'Polygon', coordinates: united.polygons[0], dimension: 2 }
        : { type: 'MultiPolygon', coordinates: united.polygons, dimension: 2 };

    const edits = geometries.get(survivor.layer) ?? new Map<number, CirFeature['geometry']>();
    edits.set(survivor.featureIndex, geometry);
    geometries.set(survivor.layer, edits);

    for (const position of ordered.slice(1)) {
      const member = polygons[position];
      const drop = removals.get(member.layer) ?? new Set<number>();
      drop.add(member.featureIndex);
      removals.set(member.layer, drop);
    }

    changes.push({
      layer: survivor.layer,
      featureId: survivor.feature.id,
      location: verticesOf[ordered[0]][0],
      description:
        `${ordered.length} adjacent polygons merged into one; ${ordered.length - 1} feature${ordered.length === 2 ? '' : 's'} removed and ` +
        `their attributes dropped. The surviving feature keeps the properties of "${String(survivor.feature.id ?? survivor.featureIndex)}". ` +
        'The outer boundary does not move.',
      // A union moves no surviving vertex; it deletes the shared edge between
      // them. Reporting a displacement here would overstate what happened.
      maxDisplacement: 0,
    });
    void root;
  }

  return { geometries, removals, changes, refused, maxDisplacement: 0 };
}

/**
 * Deletes sliver polygons — thin AND small, never merely small.
 *
 * WHY BOTH TESTS. A road reserve, a river strip and a boundary buffer are all
 * long, thin and entirely real; thinness alone would delete them. A small
 * garden plot is small and entirely real; area alone would delete it. What
 * makes a sliver a sliver is being both at once — a shaving left where two
 * surveys of the same boundary disagree by centimetres, with no ground
 * meaning at all.
 *
 * WHY IT DELETES RATHER THAN MERGES. Merging a sliver into whichever neighbour
 * it touches is what a topology cleaner does, and it is a decision about whose
 * land grows. `merge-adjacent-polygons` already exists for when the user wants
 * that and can see which parcels are involved. This one removes an artefact,
 * and says how much area went with it so the number can be checked against the
 * schedule.
 *
 * MULTIPART POLYGONS are measured per part: one thin shaving hanging off an
 * otherwise sound parcel is dropped as a part, and the feature survives. Only
 * a feature whose every part is a sliver is removed outright.
 */
function removeSlivers(
  items: Addressed[],
  refused: RepairPlan['refused'],
  settings: RepairOptions
): CrossRewrite {
  const geometries = new Map<string, Map<number, CirFeature['geometry']>>();
  const removals = new Map<string, Set<number>>();
  const changes: RepairChange[] = [];

  const isSliver = (ring: Position[]): boolean => {
    const area = ringArea(ring);
    if (area <= 0) return true;
    return thinness(ring) <= settings.sliverThinnessThreshold && area <= settings.sliverMaxArea;
  };

  for (const item of items) {
    const geometry = item.feature.geometry;
    if (!geometry) continue;
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') continue;

    const all =
      geometry.type === 'Polygon' ? [geometry.coordinates as Position[][]] : (geometry.coordinates as Position[][][]);
    if (all.length === 0) continue;

    const kept = all.filter((polygon) => polygon.length > 0 && !isSliver(polygon[0]));
    if (kept.length === all.length) continue;

    const removedArea = all
      .filter((polygon) => polygon.length > 0 && isSliver(polygon[0]))
      .reduce((total, polygon) => total + ringArea(polygon[0]), 0);
    const where = all.find((polygon) => polygon.length > 0 && isSliver(polygon[0]))?.[0]?.[0];
    const worst = Math.min(
      ...all.filter((polygon) => polygon.length > 0 && isSliver(polygon[0])).map((polygon) => thinness(polygon[0]))
    );

    if (kept.length === 0) {
      const drop = removals.get(item.layer) ?? new Set<number>();
      drop.add(item.featureIndex);
      removals.set(item.layer, drop);
      changes.push({
        layer: item.layer,
        featureId: item.feature.id,
        location: where,
        description:
          `Sliver removed: ${removedArea.toFixed(4)} sq units at thinness ${worst.toFixed(4)}, at or below the ` +
          `${settings.sliverThinnessThreshold} threshold and under ${settings.sliverMaxArea} sq units. The whole feature goes, with its attributes.`,
        maxDisplacement: 0,
      });
      continue;
    }

    const edits = geometries.get(item.layer) ?? new Map<number, CirFeature['geometry']>();
    edits.set(
      item.featureIndex,
      kept.length === 1
        ? { ...geometry, type: 'Polygon', coordinates: kept[0] }
        : { ...geometry, type: 'MultiPolygon', coordinates: kept }
    );
    geometries.set(item.layer, edits);
    changes.push({
      layer: item.layer,
      featureId: item.feature.id,
      location: where,
      description:
        `${all.length - kept.length} sliver part${all.length - kept.length === 1 ? '' : 's'} dropped from a multipart polygon, ` +
        `totalling ${removedArea.toFixed(4)} sq units. The feature and its attributes survive.`,
      maxDisplacement: 0,
    });
  }

  // Nothing MOVES: a sliver is deleted, not shifted. Reporting a displacement
  // would make the panel offer "moves up to N units" for an operation whose
  // whole effect is a removal.
  return { geometries, removals, changes, refused, maxDisplacement: 0 };
}

/**
 * Closes undershoots and cuts overshoots at line junctions.
 *
 * THE TARGET PROBLEM, and how it is answered without a second selection. The
 * reason this went unbuilt is that "extend" and "trim" in a CAD package take a
 * cutting edge you pick by hand, and `RepairScope` addresses a layer and a set
 * of features — there is nowhere to say "against THAT one". Waiting for a
 * second selection model would have meant waiting indefinitely.
 *
 * The survey case does not need one. A dangle is a line end that was MEANT to
 * meet another line and misses it by a digitising error, and `qa/defects.ts`
 * already reports exactly that, down to the gap. The target is therefore not a
 * user choice at all: it is whichever line the end is closest to within
 * `danglingTolerance`. That is the same question the detector answers, so what
 * the scan flags is what this fixes.
 *
 * TWO DIRECTIONS, ONE OPERATION, because they are the same mistake with the
 * sign flipped and a dataset has both:
 *
 *   UNDERSHOOT  the end stops short. The last segment is extended ALONG ITS OWN
 *               BEARING to where it would meet the other line. Not moved to the
 *               nearest point on it, which would bend the line — the direction
 *               the surveyor drew is evidence, and the intersection of that
 *               bearing with the target is where the junction was intended.
 *   OVERSHOOT   the end runs past. The tail beyond the crossing is cut off at
 *               the crossing itself.
 *
 * WHAT IS LEFT ALONE. An end already within `sharedEdgeTolerance` of another
 * line is connected and is not touched — running this twice must be the same
 * as running it once. An end with nothing within `danglingTolerance` is a
 * genuine dangle, a line ending where it was drawn to end, and reaching for
 * something that far away would invent a junction rather than repair one.
 */
function extendTrimLines(
  items: Addressed[],
  refused: RepairPlan['refused'],
  settings: RepairOptions
): CrossRewrite {
  const geometries = new Map<string, Map<number, CirFeature['geometry']>>();
  const removals = new Map<string, Set<number>>();
  const changes: RepairChange[] = [];
  let maxDisplacement = 0;

  const lines = items.filter(
    (item) => item.feature.geometry?.type === 'LineString' || item.feature.geometry?.type === 'MultiLineString'
  );
  if (lines.length < 2) return { geometries, removals, changes, refused, maxDisplacement: 0 };

  const reach = settings.danglingTolerance;
  // "ALREADY CONNECTED" MEANS TOUCHING, and it is `tolerance` rather than
  // `sharedEdgeTolerance` that says so.
  //
  // Found by driving the panel: with the shipped defaults the shared-edge
  // number is 0.05 and the reach is 0.25, so an end 4 cm short of a junction —
  // the commonest undershoot there is — was declared already connected and
  // left alone. Only gaps between 5 and 25 cm were repaired, which is a band
  // narrow enough that the operation looks broken on a real file. Every unit
  // test passed, because each one set both numbers explicitly.
  //
  // The reasoning behind the old value was that `snap-shared-edges` would
  // handle anything inside its tolerance. That is passing the buck: somebody
  // who chose "extend and trim line ends" is asking for their undershoots
  // fixed, not to be told a different operation might have done it. `tolerance`
  // asks the only question that matters here — is the end ON the line — and
  // idempotency still holds, because an extended end lands exactly on the
  // segment it was aimed at, seven orders of magnitude inside 1 mm.
  const connected = settings.tolerance;

  /** Every segment of every OTHER feature, as a flat list to test against. */
  const pathsOf = (item: Addressed): Position[][] => {
    const geometry = item.feature.geometry;
    if (!geometry) return [];
    if (geometry.type === 'LineString') return [geometry.coordinates as Position[]];
    if (geometry.type === 'MultiLineString') return geometry.coordinates as Position[][];
    return [];
  };

  const segments: { owner: number; a: Position; b: Position }[] = [];
  lines.forEach((item, owner) => {
    for (const path of pathsOf(item)) {
      for (let index = 1; index < path.length; index++) segments.push({ owner, a: path[index - 1], b: path[index] });
    }
  });
  const index = new SpatialIndex(
    segments.map((segment, position) => ({
      bounds: expandBounds(
        {
          minX: Math.min(segment.a[0], segment.b[0]),
          maxX: Math.max(segment.a[0], segment.b[0]),
          minY: Math.min(segment.a[1], segment.b[1]),
          maxY: Math.max(segment.a[1], segment.b[1]),
        },
        reach
      ),
      value: position,
    }))
  );

  lines.forEach((item, owner) => {
    let extended = 0;
    let trimmed = 0;
    let largest = 0;
    let where: Position | undefined;

    const fixPath = (path: Position[]): Position[] => {
      if (path.length < 2) return path;
      let working = path;

      // Both ends, same logic mirrored. `end` is the index of the terminal
      // vertex and `inner` the one before it, which together give the bearing.
      for (const atStart of [false, true]) {
        const end = atStart ? 0 : working.length - 1;
        const inner = atStart ? 1 : working.length - 2;
        if (working.length < 2) break;
        const tip = working[end];
        const back = working[inner];

        const query = expandBounds({ minX: tip[0], maxX: tip[0], minY: tip[1], maxY: tip[1] }, reach);
        const near = index.search(query).map((position) => segments[index.item(position).value]);
        const foreign = near.filter((segment) => segment.owner !== owner);
        if (foreign.length === 0) continue;

        // Already joined? Then there is nothing to repair, and running this a
        // second time must do nothing.
        const joined = foreign.some(
          (segment) => projectOnSegment(tip, segment.a, segment.b).distance <= connected
        );
        if (joined) continue;

        // ---- OVERSHOOT. Does the terminal segment CROSS a foreign line, with
        // only a short tail past the crossing? Then the tail is the mistake.
        let cut: { point: Position; tail: number } | null = null;
        for (const segment of foreign) {
          const hit = segmentIntersection(back, tip, segment.a, segment.b);
          if (!hit) continue;
          const tail = distance(hit.point, tip);
          if (tail <= 0 || tail > reach) continue;
          if (!cut || tail < cut.tail) cut = { point: hit.point, tail };
        }
        if (cut) {
          const next = [...working];
          next[end] = next[end].length > 2 ? ([cut.point[0], cut.point[1], next[end][2]] as Position) : cut.point;
          working = next;
          trimmed++;
          if (cut.tail > largest) {
            largest = cut.tail;
            where = cut.point;
          }
          continue;
        }

        // ---- UNDERSHOOT. Cast the bearing forward and take the first foreign
        // line it meets within reach.
        const dx = tip[0] - back[0];
        const dy = tip[1] - back[1];
        const span = Math.hypot(dx, dy);
        if (span === 0) continue;
        const probe: Position = [tip[0] + (dx / span) * reach, tip[1] + (dy / span) * reach];

        let hitAt: { point: Position; gap: number } | null = null;
        for (const segment of foreign) {
          const hit = segmentIntersection(tip, probe, segment.a, segment.b);
          if (!hit) continue;
          const gap = distance(tip, hit.point);
          if (gap <= 0 || gap > reach) continue;
          if (!hitAt || gap < hitAt.gap) hitAt = { point: hit.point, gap };
        }
        if (!hitAt) continue;

        const next = [...working];
        next[end] = next[end].length > 2 ? ([hitAt.point[0], hitAt.point[1], next[end][2]] as Position) : hitAt.point;
        working = next;
        extended++;
        if (hitAt.gap > largest) {
          largest = hitAt.gap;
          where = hitAt.point;
        }
      }

      return working;
    };

    const geometry = item.feature.geometry;
    if (!geometry) return;
    const rebuilt =
      geometry.type === 'LineString'
        ? { ...geometry, coordinates: fixPath(geometry.coordinates as Position[]) }
        : { ...geometry, coordinates: (geometry.coordinates as Position[][]).map(fixPath) };

    if (extended === 0 && trimmed === 0) return;

    const edits = geometries.get(item.layer) ?? new Map<number, CirFeature['geometry']>();
    edits.set(item.featureIndex, rebuilt as CirFeature['geometry']);
    geometries.set(item.layer, edits);

    const parts: string[] = [];
    if (extended) parts.push(`${extended} end${extended === 1 ? '' : 's'} extended to a junction`);
    if (trimmed) parts.push(`${trimmed} overshoot${trimmed === 1 ? '' : 's'} trimmed back to the crossing`);
    changes.push({
      layer: item.layer,
      featureId: item.feature.id,
      location: where,
      description: `${parts.join(' and ')}; the largest move is ${largest.toFixed(4)} units, within the ${reach} reach.`,
      maxDisplacement: largest,
    });
    if (largest > maxDisplacement) maxDisplacement = largest;
  });

  return { geometries, removals, changes, refused, maxDisplacement };
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
