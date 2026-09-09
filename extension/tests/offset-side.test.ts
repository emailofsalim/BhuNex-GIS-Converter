/**
 * Offsetting a polygon inside, outside or both (phase I).
 *
 * The offset already handled lines: sign chooses the side, corners trim. What
 * it did NOT handle was the thing a cadastral drawing actually needs — a
 * building line 3 m inside a parcel, a right of way outside a boundary, a
 * corridor either side of a centreline. A polygon simply produced "an offset
 * applies to lines, and this selection has none".
 *
 * These tests are anchored to what a setback IS rather than to coordinate
 * arrays: a 3 m building line inside a 20 m square is a smaller closed ring
 * whose every vertex is at least 3 m from the parcel boundary, and outside is
 * the same statement in the other direction. Checking a coordinate list copied
 * from a run tests that the code still does whatever it did, which is not the
 * question.
 */

import { describe, expect, it } from 'vitest';
import type { CirDataset, CirGeometry, Position } from '@core/cir';
import { crsFromEpsg } from '@crs/epsg';
import { OFFSET_SIDE_LABEL, type OffsetSide, planGeometryOperation } from '@core/geometry-ops';

const UTM45N = crsFromEpsg(32645);

function ring(x: number, y: number, size: number): Position[] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}

function dataset(geometry: CirGeometry, name = 'parcels'): CirDataset {
  return {
    layers: [
      {
        name,
        path: [name],
        features: [{ geometry, properties: { plot: '784' } }],
        fields: [],
        geometryTypes: [geometry.type],
      },
    ],
    crs: UTM45N,
    warnings: [],
  } as unknown as CirDataset;
}

const SQUARE: CirGeometry = { type: 'Polygon', coordinates: [ring(0, 0, 20)], dimension: 2 };
const LINE: CirGeometry = { type: 'LineString', coordinates: [[0, 0], [100, 0]], dimension: 2 };

function plan(geometry: CirGeometry, distance: number, side?: OffsetSide) {
  return planGeometryOperation(dataset(geometry), 'parcels', 'offset', {
    distance,
    ...(side ? { side } : {}),
    crs: UTM45N,
  });
}

/** Every vertex of a result, flat. */
function vertices(geometry: CirGeometry | null | undefined): Position[] {
  if (!geometry) return [];
  const out: Position[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node) && typeof node[0] === 'number') {
      out.push(node as Position);
      return;
    }
    if (Array.isArray(node)) for (const child of node) walk(child);
  };
  walk(geometry.coordinates);
  return out;
}

/** How far a point is outside the 20 m square: negative means inside. */
function outsideBy(point: Position): number {
  const dx = Math.max(0 - point[0], point[0] - 20);
  const dy = Math.max(0 - point[1], point[1] - 20);
  if (dx <= 0 && dy <= 0) return -Math.min(-dx, -dy);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

describe('a polygon offset inside', () => {
  it('produces a line, not a second parcel', () => {
    const result = plan(SQUARE, 3, 'inside');
    expect(result.refusal).toBeUndefined();
    expect(result.features).toHaveLength(1);
    const type = result.features[0].geometry?.type;
    expect(['LineString', 'MultiLineString']).toContain(type);
  });

  it('sits at least the setback distance inside the boundary', () => {
    const result = plan(SQUARE, 3, 'inside');
    for (const point of vertices(result.features[0].geometry)) {
      // Inside means outsideBy is negative and at least 3 m in.
      expect(outsideBy(point), `${point} is not 3 m inside`).toBeLessThanOrEqual(-3 + 1e-6);
    }
  });

  it('closes the ring, so the setback is a boundary rather than an open trail', () => {
    const result = plan(SQUARE, 3, 'inside');
    const points = vertices(result.features[0].geometry);
    expect(points[0][0]).toBeCloseTo(points[points.length - 1][0], 9);
    expect(points[0][1]).toBeCloseTo(points[points.length - 1][1], 9);
  });

  it('ignores the sign, so a stray minus cannot turn the setback outwards', () => {
    // This is why `side` uses the magnitude. "3 m inside" typed as −3 must
    // still be inside, or the number and the word disagree and the drawing is
    // wrong in a way that looks deliberate.
    const negative = plan(SQUARE, -3, 'inside');
    for (const point of vertices(negative.features[0].geometry)) {
      expect(outsideBy(point)).toBeLessThanOrEqual(-3 + 1e-6);
    }
  });

  it('refuses when the parcel is narrower than twice the setback', () => {
    const thin: CirGeometry = { type: 'Polygon', coordinates: [ring(0, 0, 4)], dimension: 2 };
    const result = plan(thin, 5, 'inside');
    expect(result.refusal).toBeDefined();
    expect(result.refusal!.why).toContain('narrower');
  });
});

describe('a polygon offset outside', () => {
  it('sits at least the distance outside the boundary', () => {
    const result = plan(SQUARE, 3, 'outside');
    expect(result.refusal).toBeUndefined();
    const points = vertices(result.features[0].geometry);
    expect(points.length).toBeGreaterThan(3);
    // Every vertex is outside the parcel, and the nearest of them is about the
    // offset distance away — a right of way, not a shape that swallowed it.
    const distances = points.map(outsideBy);
    expect(Math.min(...distances)).toBeGreaterThan(0);
    expect(Math.min(...distances)).toBeCloseTo(3, 1);
  });

  it('ignores the sign, the same way inside does', () => {
    const negative = plan(SQUARE, -3, 'outside');
    expect(Math.min(...vertices(negative.features[0].geometry).map(outsideBy))).toBeGreaterThan(0);
  });
});

describe('a polygon offset both ways', () => {
  it('produces one geometry carrying both sides', () => {
    const result = plan(SQUARE, 3, 'both');
    expect(result.refusal).toBeUndefined();
    expect(result.features[0].geometry?.type).toBe('MultiLineString');
    const distances = vertices(result.features[0].geometry).map(outsideBy);
    expect(distances.some((value) => value > 0), 'no outer side').toBe(true);
    expect(distances.some((value) => value <= -3 + 1e-6), 'no inner side').toBe(true);
  });

  it('still produces the outer side when the parcel is too thin for the inner one', () => {
    // Half of "both" is better than a refusal, and the note has to say which
    // half was lost — a corridor drawn on one side only is not obviously wrong
    // on screen.
    const thin: CirGeometry = { type: 'Polygon', coordinates: [ring(0, 0, 4)], dimension: 2 };
    const result = plan(thin, 5, 'both');
    expect(result.refusal).toBeUndefined();
    expect(result.notes.join(' ')).toContain('no inward offset');
  });
});

describe('what the polygon offset does not change', () => {
  it('leaves a line offset following the sign, since a line has no inside', () => {
    const positive = plan(LINE, 5);
    const negative = plan(LINE, -5);
    const up = vertices(positive.features[0].geometry)[0][1];
    const down = vertices(negative.features[0].geometry)[0][1];
    // Opposite sides, whichever way round the engine calls positive.
    expect(Math.sign(up)).toBe(-Math.sign(down));
    expect(Math.abs(up)).toBeCloseTo(5, 6);
  });

  it('defaults to the signed behaviour, so no stored command changes meaning', () => {
    const withoutSide = plan(SQUARE, -3);
    const withSigned = plan(SQUARE, -3, 'signed');
    expect(JSON.stringify(withoutSide.features)).toBe(JSON.stringify(withSigned.features));
  });

  it('keeps the source attributes on the setback line', () => {
    const result = plan(SQUARE, 3, 'inside');
    expect(result.features[0].properties).toEqual({ plot: '784' });
  });

  it('still refuses on a geographic CRS, where a metre is not a number', () => {
    const geographic = { ...dataset(SQUARE), crs: crsFromEpsg(4326) } as CirDataset;
    const result = planGeometryOperation(geographic, 'parcels', 'offset', {
      distance: 3,
      side: 'inside',
      crs: crsFromEpsg(4326),
    });
    expect(result.refusal).toBeDefined();
    expect(result.refusal!.why).toContain('degrees');
  });

  it('refuses a selection with neither lines nor polygons', () => {
    const points: CirGeometry = { type: 'Point', coordinates: [5, 5], dimension: 2 };
    const result = plan(points, 3, 'inside');
    expect(result.refusal).toBeDefined();
    expect(result.refusal!.why).toContain('neither');
  });
});

describe('the side options themselves', () => {
  it('labels every one, so the control can be built from the type', () => {
    for (const side of ['signed', 'inside', 'outside', 'both'] as OffsetSide[]) {
      expect(OFFSET_SIDE_LABEL[side], `${side} has no label`).toBeTruthy();
    }
  });

  it('says in the notes which way a polygon went', () => {
    expect(plan(SQUARE, 3, 'inside').notes.join(' ')).toContain('inside');
    expect(plan(SQUARE, 3, 'outside').notes.join(' ')).toContain('outside');
    expect(plan(SQUARE, 3, 'both').notes.join(' ')).toContain('inside and outside');
  });
});
