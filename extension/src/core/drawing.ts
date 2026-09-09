/**
 * Drawing new geometry, and snapping it to what is already there.
 *
 * Phases F and K of docs/EDITING_WORKSTATION.md. Two asks, one mechanism:
 *
 *   "draw polygon, draw line, add point place marker, add text … as well as
 *    tools like snap … ortho tool"
 *   "user can even import csv and digitize it to make geometry so give this
 *    power as well like using esnap for accurate vertex selection"
 *
 * The second is the first with its snap targets pointed at imported survey
 * points. That is the whole of phase K, and it is why this module exists
 * separately from `qa/snap.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `qa/snap.ts`
 *
 * That module moves vertices that ALREADY EXIST: it plans a correction over a
 * dataset and reports what it would move. This answers a different question —
 * "the pointer is here; where should the vertex I am about to create go?" —
 * before any vertex exists to plan a move for. Bolting that onto the repair
 * planner would mean inventing a fake feature to snap and then unpicking the
 * plan, which is a worse thing to read than two functions.
 *
 * ---------------------------------------------------------------------------
 * SNAPPING THAT ROUNDS IS WORSE THAN NO SNAPPING
 *
 * A digitised vertex must be EXACTLY the observed coordinate — the same double,
 * not one within a few pixels of it. A snap that lands "near" a control point
 * produces a boundary that looks deliberate, passes every visual check, and is
 * off by whatever the pointer happened to be. So `findSnapTarget` returns the
 * stored position BY REFERENCE-EQUAL VALUE, copied but never recomputed, and
 * `snapKind` says which target was taken so the report can name it.
 *
 * ---------------------------------------------------------------------------
 * DRAWN GEOMETRY IS DATA, NOT AN INTENT
 *
 * Every other editing command in this codebase stores an INTENT and is
 * re-planned against the full file at conversion time, because a buffer
 * computed over 5,000 previewed parcels must cover 40,000 real ones. A drawn
 * polygon is the opposite: the user placed those exact vertices, and there is
 * nothing to re-derive. Storing the coordinates verbatim is right here and
 * would be wrong anywhere else, which is worth saying out loud because the
 * asymmetry looks like an inconsistency.
 */

import type { CirFeature, CirGeometry, Position } from './cir';
import { pointInRing } from './geometry';

// ===========================================================================
// What can be drawn
// ===========================================================================

export type DrawKind = 'point' | 'marker' | 'line' | 'polygon' | 'text';

export const DRAW_LABEL: Record<DrawKind, string> = {
  point: 'Point',
  marker: 'Place marker',
  line: 'Line',
  polygon: 'Polygon',
  text: 'Text',
};

export const DRAW_HINT: Record<DrawKind, string> = {
  point: 'Click to place a point. Snapping puts it exactly on an existing vertex.',
  marker: 'Click to place a named marker. You will be asked for its label.',
  line: 'Click each vertex. Double-click, Enter or Escape finishes; Backspace takes the last one back.',
  polygon: 'Click each corner. The ring is closed for you when you finish — three corners minimum.',
  text: 'Click where the text should sit, then type it. It is written as a point carrying a text attribute, because no vector format has a text primitive that survives conversion.',
};

/** The minimum vertices a shape needs before it is a shape at all. */
export const MIN_VERTICES: Record<DrawKind, number> = {
  point: 1,
  marker: 1,
  line: 2,
  polygon: 3,
  text: 1,
};

// ===========================================================================
// Snapping
// ===========================================================================

export type SnapKind = 'vertex' | 'endpoint' | 'midpoint' | 'segment' | 'grid';

export const SNAP_KIND_LABEL: Record<SnapKind, string> = {
  vertex: 'vertex',
  endpoint: 'end of a line',
  midpoint: 'midpoint of a segment',
  segment: 'nearest point on a segment',
  grid: 'grid',
};

/**
 * Snap kinds in the order they win a tie.
 *
 * A vertex beats a midpoint beats a segment, and that order is not arbitrary: a
 * vertex is an OBSERVED point and the others are derived ones. Given a pointer
 * equally close to both, taking the derived point would silently prefer a
 * computed coordinate over a surveyed one.
 */
const PRIORITY: SnapKind[] = ['vertex', 'endpoint', 'midpoint', 'segment', 'grid'];

export interface SnapTarget {
  position: Position;
  kind: SnapKind;
  /** Which layer the target came from, for the readout. */
  layer?: string;
  /** World distance from the pointer. */
  distance: number;
}

export interface SnapSource {
  name: string;
  features: { geometry: CirGeometry | null }[];
  /** A locked or hidden layer is not a snap target: it cannot be seen or picked. */
  usable?: boolean;
}

export interface SnapSettings {
  vertex: boolean;
  midpoint: boolean;
  segment: boolean;
  /** Grid spacing in world units. Zero or absent means no grid snapping. */
  grid?: number;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = { vertex: true, midpoint: false, segment: false };

/**
 * The best place for a vertex about to be created.
 *
 * `tolerance` is in WORLD units and the caller converts it from a pixel radius,
 * so the snap zone is the same size on screen at every zoom — eight metres is
 * the whole parcel zoomed out and invisible zoomed in.
 *
 * Returns null when nothing is in range, and the caller uses the raw pointer
 * position. It never returns an approximation of a target: either a vertex was
 * close enough and its exact coordinate is used, or it was not.
 */
export function findSnapTarget(
  sources: SnapSource[],
  world: Position,
  tolerance: number,
  settings: SnapSettings = DEFAULT_SNAP_SETTINGS
): SnapTarget | null {
  let best: SnapTarget | null = null;

  const consider = (candidate: SnapTarget): void => {
    if (candidate.distance > tolerance) return;
    if (!best) {
      best = candidate;
      return;
    }
    // Closer wins; on a tie the more meaningful kind wins. Two targets at the
    // same distance is common — the midpoint of a short segment sits close to
    // both its endpoints — and without the tie-break the answer depends on
    // iteration order, which is to say on nothing.
    if (candidate.distance < best.distance - 1e-12) {
      best = candidate;
      return;
    }
    if (
      Math.abs(candidate.distance - best.distance) <= 1e-12 &&
      PRIORITY.indexOf(candidate.kind) < PRIORITY.indexOf(best.kind)
    ) {
      best = candidate;
    }
  };

  for (const source of sources) {
    if (source.usable === false) continue;
    for (const feature of source.features) {
      for (const line of polylinesOf(feature.geometry)) {
        if (settings.vertex) {
          for (const [index, position] of line.positions.entries()) {
            const kind: SnapKind = !line.closed && (index === 0 || index === line.positions.length - 1) ? 'endpoint' : 'vertex';
            consider({
              // Copied, never recomputed: the exported coordinate must be the
              // observed one, bit for bit.
              position: [...position],
              kind,
              layer: source.name,
              distance: Math.hypot(world[0] - position[0], world[1] - position[1]),
            });
          }
        }
        for (let index = 0; index < line.positions.length - 1; index++) {
          const start = line.positions[index];
          const end = line.positions[index + 1];
          if (settings.midpoint) {
            const mid: Position = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
            consider({
              position: mid,
              kind: 'midpoint',
              layer: source.name,
              distance: Math.hypot(world[0] - mid[0], world[1] - mid[1]),
            });
          }
          if (settings.segment) {
            const projected = closestOnSegment(world, start, end);
            consider({ position: projected.point, kind: 'segment', layer: source.name, distance: projected.distance });
          }
        }
      }
    }
  }

  if (settings.grid && settings.grid > 0) {
    const snapped: Position = [
      Math.round(world[0] / settings.grid) * settings.grid,
      Math.round(world[1] / settings.grid) * settings.grid,
    ];
    consider({ position: snapped, kind: 'grid', distance: Math.hypot(world[0] - snapped[0], world[1] - snapped[1]) });
  }

  return best;
}

/** Every polyline in a geometry, flagged with whether it closes. */
function polylinesOf(geometry: CirGeometry | null): { positions: Position[]; closed: boolean }[] {
  if (!geometry) return [];
  switch (geometry.type) {
    case 'Point':
      return [{ positions: [geometry.coordinates as Position], closed: false }];
    case 'MultiPoint':
      return (geometry.coordinates as Position[]).map((position) => ({ positions: [position], closed: false }));
    case 'LineString':
      return [{ positions: geometry.coordinates as Position[], closed: false }];
    case 'MultiLineString':
      return (geometry.coordinates as Position[][]).map((positions) => ({ positions, closed: false }));
    case 'Polygon':
      return (geometry.coordinates as Position[][]).map((positions) => ({ positions, closed: true }));
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).flat().map((positions) => ({ positions, closed: true }));
    case 'GeometryCollection':
      return (geometry.geometries ?? []).flatMap((child) => polylinesOf(child));
    default:
      return [];
  }
}

function closestOnSegment(point: Position, start: Position, end: Position): { point: Position; distance: number } {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { point: [...start], distance: Math.hypot(point[0] - start[0], point[1] - start[1]) };
  let t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const projected: Position = [start[0] + t * dx, start[1] + t * dy];
  return { point: projected, distance: Math.hypot(point[0] - projected[0], point[1] - projected[1]) };
}

// ===========================================================================
// Constraints
// ===========================================================================

/**
 * Ortho: constrains a point to the axis it has travelled furthest along.
 *
 * The tie at exactly 45° goes to the horizontal deliberately. A strict
 * comparison makes the constraint flip between axes on every pixel of a
 * diagonal drag, which shows up as the line flickering rather than as a
 * decision anyone made.
 */
export function constrainOrtho(from: Position, to: Position): Position {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return Math.abs(dx) >= Math.abs(dy) ? [to[0], from[1]] : [from[0], to[1]];
}

/**
 * Constrains a point to the nearest multiple of `step` degrees from `from`.
 *
 * For laying out a boundary on known bearings. The distance is preserved
 * exactly and only the direction is rounded, so a 30 m leg stays 30 m.
 */
export function constrainAngle(from: Position, to: Position, stepDegrees: number): Position {
  if (!Number.isFinite(stepDegrees) || stepDegrees <= 0) return to;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return to;
  const step = (stepDegrees * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [from[0] + length * Math.cos(angle), from[1] + length * Math.sin(angle)];
}

// ===========================================================================
// Building the feature
// ===========================================================================

export interface DrawResult {
  feature: CirFeature;
  notes: string[];
}

export interface DrawRefusal {
  what: string;
  why: string;
  action: string;
}

/**
 * Turns a run of clicked positions into a feature, or says why it cannot.
 *
 * The refusals are the useful part. A two-vertex "polygon" and a one-vertex
 * "line" are both things a user can produce by double-clicking too early, and
 * both would be written out as degenerate geometry that every downstream tool
 * reports as corrupt without saying where it came from.
 */
export function buildDrawnFeature(
  kind: DrawKind,
  positions: Position[],
  options: { properties?: Record<string, unknown>; text?: string; name?: string } = {}
): { result?: DrawResult; refusal?: DrawRefusal } {
  const cleaned = dropRepeats(positions);
  const needed = MIN_VERTICES[kind];

  if (cleaned.length < needed) {
    return {
      refusal: {
        what: `A ${DRAW_LABEL[kind].toLowerCase()} needs ${needed} ${needed === 1 ? 'point' : 'points'}.`,
        why:
          cleaned.length === positions.length
            ? `Only ${cleaned.length} ${cleaned.length === 1 ? 'was' : 'were'} placed.`
            : `${positions.length} clicks produced ${cleaned.length} distinct ${cleaned.length === 1 ? 'point' : 'points'} — the rest landed on top of one another.`,
        action: 'Place the remaining points, or press Escape to abandon the shape.',
      },
    };
  }

  const notes: string[] = [];
  if (cleaned.length < positions.length) {
    notes.push(
      `${positions.length - cleaned.length} duplicate click(s) were dropped: a repeated vertex is a zero-length segment, which several formats reject.`
    );
  }

  const properties: Record<string, unknown> = { ...(options.properties ?? {}) };
  if (options.name) properties.name = options.name;
  if (kind === 'text') {
    if (!options.text || options.text.trim() === '') {
      return {
        refusal: {
          what: 'Text needs something to say.',
          why: 'No text was entered.',
          action: 'Type the label, or press Escape.',
        },
      };
    }
    properties.text = options.text;
    // Said out loud rather than assumed: a "text" object in CAD is an entity,
    // and in every vector GIS format it is an attribute on a point. Converting
    // between them loses the font, the height and the rotation, and a user who
    // expected a drawing annotation should find that out now.
    notes.push(
      'Written as a point carrying a "text" attribute. No vector GIS format has a text primitive that survives conversion, so font, height and rotation are not stored.'
    );
  }

  switch (kind) {
    case 'point':
    case 'marker':
    case 'text':
      return {
        result: {
          feature: { geometry: { type: 'Point', coordinates: cleaned[0], dimension: cleaned[0].length >= 3 ? 3 : 2 }, properties },
          notes,
        },
      };

    case 'line':
      return {
        result: {
          feature: {
            geometry: { type: 'LineString', coordinates: cleaned, dimension: dimensionOf(cleaned) },
            properties,
          },
          notes,
        },
      };

    case 'polygon': {
      const ring = [...cleaned, [...cleaned[0]]];
      if (selfIntersects(ring)) {
        notes.push(
          'The ring crosses itself. It is kept as drawn rather than repaired, because which crossing was intended is a drafting decision — the QA scan will report it.'
        );
      }
      return {
        result: {
          feature: { geometry: { type: 'Polygon', coordinates: [ring], dimension: dimensionOf(ring) }, properties },
          notes,
        },
      };
    }
  }
}

function dimensionOf(positions: Position[]): 2 | 3 {
  return positions.some((position) => position.length >= 3) ? 3 : 2;
}

/** Drops consecutive repeats, which are what a double-click leaves behind. */
function dropRepeats(positions: Position[]): Position[] {
  const out: Position[] = [];
  for (const position of positions) {
    const last = out[out.length - 1];
    if (last && last[0] === position[0] && last[1] === position[1]) continue;
    out.push(position);
  }
  return out;
}

/** Whether a closed ring crosses itself, ignoring the shared closing vertex. */
function selfIntersects(ring: Position[]): boolean {
  for (let i = 0; i < ring.length - 1; i++) {
    for (let j = i + 2; j < ring.length - 1; j++) {
      // The first and last segments share the closing vertex legitimately.
      if (i === 0 && j === ring.length - 2) continue;
      if (properCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

function properCross(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
  const d = (a: Position, b: Position, c: Position) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// ===========================================================================
// Digitising from imported points (phase K)
// ===========================================================================

/**
 * The snap sources for digitising a boundary from a survey CSV.
 *
 * A CSV of observed points imports as a point layer, and drawing the boundary
 * they describe means clicking each in order with the snap ON and set to
 * vertices only. Midpoint and segment snapping are deliberately NOT offered as
 * defaults here: neither is an observed position, and a boundary that runs
 * through the midpoint of a line between two control points is not the boundary
 * that was surveyed.
 */
export function pointSnapSources(layers: SnapSource[]): SnapSource[] {
  return layers.filter((layer) => layer.features.some((feature) => isPointish(feature.geometry)));
}

function isPointish(geometry: CirGeometry | null): boolean {
  return geometry?.type === 'Point' || geometry?.type === 'MultiPoint';
}

/**
 * Whether a drawn ring encloses points that were not clicked.
 *
 * Digitising from a CSV, this is the check worth having: a boundary that has a
 * survey point sitting inside it usually means a corner was missed, and the
 * ring closed one point early. Reported, never fixed — a point genuinely inside
 * a parcel is also completely normal.
 */
export function pointsInsideRing(ring: Position[], sources: SnapSource[], used: Position[]): number {
  const clicked = new Set(used.map((position) => `${position[0]},${position[1]}`));
  let count = 0;
  for (const source of sources) {
    for (const feature of source.features) {
      for (const line of polylinesOf(feature.geometry)) {
        for (const position of line.positions) {
          if (clicked.has(`${position[0]},${position[1]}`)) continue;
          if (pointInRing(position, ring)) count++;
        }
      }
    }
  }
  return count;
}
