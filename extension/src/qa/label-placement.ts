/**
 * Label placement (spec §27.3).
 *
 * A label has to sit *inside* its polygon. That sounds obvious and is where
 * naive implementations fail: the centroid of a C-shaped parcel, a river bend
 * or a mine lease wrapped around a pit lies outside the polygon entirely, so
 * the plot number ends up in the neighbouring plot. On cadastral output that is
 * not a cosmetic problem — it mislabels someone's land.
 *
 * So the anchor is the **pole of inaccessibility**: the interior point furthest
 * from any edge. For a convex polygon it is near the centroid; for a crescent it
 * is in the thick of the crescent; and it is guaranteed inside. It also gives us
 * the label's breathing room for free — the distance to the nearest edge — which
 * is what decides whether the text fits or the polygon needs rotating.
 *
 * The algorithm is the quadtree search Vladimir Agafonkin described for
 * polylabel: subdivide, keep the cell whose *upper bound* on distance is best,
 * stop when the bound can no longer beat the best point found. It converges in
 * milliseconds and, unlike sampling, returns a stated precision rather than a
 * hope.
 */

import type { Position } from '../core/cir';
import { pointInRing, signedArea } from '../core/geometry';

export interface LabelAnchor {
  /** Where the label goes. Always inside the polygon. */
  position: Position;
  /**
   * Distance from the anchor to the nearest edge, in dataset units.
   *
   * The usable half-width for the text: a label wider than twice this will
   * overhang the boundary.
   */
  clearance: number;
  /** Degrees counter-clockwise from east; non-zero only for a narrow polygon. */
  rotation: number;
  /** True when the polygon is too narrow for horizontal text at any size. */
  narrow: boolean;
}

export interface LabelPlacementOptions {
  /** Stop subdividing once the answer cannot improve by more than this. */
  precision: number;
  /**
   * A polygon whose clearance is below this fraction of its longer extent is
   * treated as narrow, and the label is rotated to follow it.
   */
  narrowRatio: number;
  /** Rotate labels in narrow polygons rather than letting them overhang. */
  rotateInNarrow: boolean;
}

export const DEFAULT_LABEL_PLACEMENT: LabelPlacementOptions = {
  precision: 0.01,
  narrowRatio: 0.15,
  rotateInNarrow: true,
};

interface Cell {
  x: number;
  y: number;
  half: number;
  /** Signed distance from the cell centre to the ring: positive inside. */
  distance: number;
  /** Best distance any point in this cell could possibly have. */
  bound: number;
}

/**
 * Signed distance from a point to a polygon boundary.
 *
 * Positive inside, negative outside — which is what lets the search reject a
 * cell that lies wholly outside the polygon without a separate containment test
 * at every step.
 */
function signedDistance(point: Position, rings: Position[][]): number {
  let inside = false;
  let nearest = Infinity;

  rings.forEach((ring, index) => {
    // A point inside a hole is outside the polygon, so containment flips per
    // ring rather than being decided by the shell alone.
    if (pointInRing(point, ring)) inside = index === 0 ? !inside : !inside;
    for (let at = 0; at < ring.length - 1; at++) {
      const gap = pointToSegment(point, ring[at], ring[at + 1]);
      if (gap < nearest) nearest = gap;
    }
  });

  return inside ? nearest : -nearest;
}

function pointToSegment(point: Position, start: Position, end: Position): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  let t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

function makeCell(x: number, y: number, half: number, rings: Position[][]): Cell {
  const distance = signedDistance([x, y], rings);
  // The furthest any point in this cell can be from an edge: its centre's
  // distance plus the cell's own half-diagonal.
  return { x, y, half, distance, bound: distance + half * Math.SQRT2 };
}

/**
 * The interior point of a polygon furthest from its boundary.
 *
 * Returns the anchor, its clearance, and whether the polygon is too narrow to
 * hold horizontal text.
 */
export function labelAnchor(rings: Position[][], options: Partial<LabelPlacementOptions> = {}): LabelAnchor | null {
  const settings = { ...DEFAULT_LABEL_PLACEMENT, ...options };
  const shell = rings[0];
  if (!shell || shell.length < 4) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const position of shell) {
    if (position[0] < minX) minX = position[0];
    if (position[1] < minY) minY = position[1];
    if (position[0] > maxX) maxX = position[0];
    if (position[1] > maxY) maxY = position[1];
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width === 0 || height === 0) return null;

  const cellSize = Math.min(width, height);
  let half = cellSize / 2;
  if (half <= 0) return null;

  // Seed with a grid over the bounding box, and with the centroid as a
  // candidate — for a convex polygon the centroid is already close to optimal,
  // which cuts the search short.
  const queue: Cell[] = [];
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) {
      queue.push(makeCell(x + half, y + half, half, rings));
    }
  }

  let best = centroidCell(shell, rings);
  const bboxCell = makeCell(minX + width / 2, minY + height / 2, 0, rings);
  if (bboxCell.distance > best.distance) best = bboxCell;

  // Precision is bounded so a huge extent cannot spin for ever on a target it
  // will never reach.
  const precision = Math.max(settings.precision, cellSize / 1e5);
  let guard = 0;

  while (queue.length > 0 && guard++ < 100000) {
    // Best-first: take the cell with the highest upper bound.
    let bestIndex = 0;
    for (let index = 1; index < queue.length; index++) {
      if (queue[index].bound > queue[bestIndex].bound) bestIndex = index;
    }
    const cell = queue.splice(bestIndex, 1)[0];

    if (cell.distance > best.distance) best = cell;
    // No point in this cell can beat what we already have.
    if (cell.bound - best.distance <= precision) continue;

    const quarter = cell.half / 2;
    queue.push(makeCell(cell.x - quarter, cell.y - quarter, quarter, rings));
    queue.push(makeCell(cell.x + quarter, cell.y - quarter, quarter, rings));
    queue.push(makeCell(cell.x - quarter, cell.y + quarter, quarter, rings));
    queue.push(makeCell(cell.x + quarter, cell.y + quarter, quarter, rings));
  }

  const clearance = Math.max(best.distance, 0);
  const narrow = clearance < Math.max(width, height) * settings.narrowRatio;
  const rotation = narrow && settings.rotateInNarrow ? dominantAngle(shell) : 0;

  return { position: [best.x, best.y], clearance, rotation, narrow };
}

/** The area centroid, used as a starting candidate. */
function centroidCell(shell: Position[], rings: Position[][]): Cell {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let index = 0, previous = shell.length - 1; index < shell.length; previous = index++) {
    const cross = shell[previous][0] * shell[index][1] - shell[index][0] * shell[previous][1];
    area += cross;
    x += (shell[previous][0] + shell[index][0]) * cross;
    y += (shell[previous][1] + shell[index][1]) * cross;
  }
  if (area === 0) return makeCell(shell[0][0], shell[0][1], 0, rings);
  return makeCell(x / (3 * area), y / (3 * area), 0, rings);
}

/**
 * The direction a narrow polygon runs in, so a label can follow it.
 *
 * Taken from the longest edge rather than from a full principal-axis fit: for
 * the shapes this matters on — road reserves, canal strips, boundary buffers —
 * the longest edge *is* the axis, and it costs one pass instead of an
 * eigen-decomposition.
 */
function dominantAngle(shell: Position[]): number {
  let longest = 0;
  let angle = 0;
  for (let index = 0; index < shell.length - 1; index++) {
    const dx = shell[index + 1][0] - shell[index][0];
    const dy = shell[index + 1][1] - shell[index][1];
    const length = Math.hypot(dx, dy);
    if (length > longest) {
      longest = length;
      angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    }
  }
  // Keep text upright: nobody reads a label rotated past vertical.
  if (angle > 90) angle -= 180;
  if (angle < -90) angle += 180;
  return angle;
}

export interface PlacedLabel {
  text: string;
  anchor: LabelAnchor;
  /** Estimated half-width of the rendered text, in dataset units. */
  halfWidth: number;
  /** True when the text is wider than the polygon can hold at this size. */
  overflows: boolean;
}

/**
 * Places one label and reports whether it actually fits.
 *
 * `overflows` is the honest part. A label that does not fit is still placed —
 * suppressing it would silently lose the plot number — but the caller is told,
 * so it can shrink the text, rotate it, or leave it to the user to decide.
 */
export function placeLabel(
  text: string,
  rings: Position[][],
  textHeight: number,
  options: Partial<LabelPlacementOptions> = {}
): PlacedLabel | null {
  const anchor = labelAnchor(rings, options);
  if (!anchor) return null;
  // A rough advance width of 0.6 em per character is close enough for a fit
  // test; the exact metric depends on a font this tool never sees.
  const halfWidth = (text.length * textHeight * 0.6) / 2;
  return { text, anchor, halfWidth, overflows: halfWidth > anchor.clearance };
}

/**
 * Resolves collisions between labels that would overlap.
 *
 * Priority order is by clearance: the label with the most room keeps its
 * position, because moving it would waste the space it earned. A label that
 * cannot be placed without overlapping is returned with `suppressed: true`
 * rather than nudged somewhere arbitrary — a plot number a few metres into the
 * neighbouring parcel is worse than one the user can see is missing.
 */
export function resolveCollisions(labels: PlacedLabel[], textHeight: number): { label: PlacedLabel; suppressed: boolean }[] {
  const ordered = [...labels].sort((left, right) => right.anchor.clearance - left.anchor.clearance);
  const placed: PlacedLabel[] = [];
  const results: { label: PlacedLabel; suppressed: boolean }[] = [];

  for (const label of ordered) {
    const collides = placed.some((other) => {
      const dx = Math.abs(other.anchor.position[0] - label.anchor.position[0]);
      const dy = Math.abs(other.anchor.position[1] - label.anchor.position[1]);
      return dx < other.halfWidth + label.halfWidth && dy < textHeight;
    });
    if (collides) {
      results.push({ label, suppressed: true });
      continue;
    }
    placed.push(label);
    results.push({ label, suppressed: false });
  }

  return results;
}

/** Ring area, for choosing the largest candidate polygon. */
export function ringArea(ring: Position[]): number {
  return Math.abs(signedArea(ring));
}
