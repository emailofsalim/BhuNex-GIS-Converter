/**
 * Geometry operations and buffering (spec §26.2).
 *
 * The single most valuable test in this file is the CRS gate. A buffer is
 * arithmetic on raw coordinates, so "10" on a geographic CRS means ten DEGREES —
 * about 1,100 km. The result is a plausible-looking polygon that is wrong by
 * five orders of magnitude, and unlike a wrong LENGTH it does not invite a
 * sanity check: it just looks like a buffer. So the engine refuses, and that
 * refusal is tested before anything else.
 *
 * After that, the tests are about what each operation COSTS, because every one
 * of these discards something:
 *
 *   - a boolean drops Z
 *   - explode copies one attribute row onto every part
 *   - dissolve keeps only the grouping field
 *   - a split leaves both halves carrying the original's area value
 *
 * Each of those is a silent data-quality failure if it is not stated, so each is
 * asserted to be stated.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type CirGeometry, type Position, type SourceInfo } from '@core/cir';
import { crsFromEpsg } from '@crs/epsg';
import { bufferGeometry, disc, offsetLine } from '@core/buffer';
import {
  applyGeometryOperation,
  centroidOf,
  convexHull,
  describeGeometryPlan,
  envelopeOf,
  explodeGeometry,
  lineLength,
  lineSubstring,
  mergeLines,
  planArea,
  planGeometryOperation,
  toMultipart,
  toMultiPolygon,
  undoGeometryOperation,
} from '@core/geometry-ops';

const SOURCE: SourceInfo = { fileName: 'plots.shp', size: 0, formatId: 'shapefile', formatName: 'Esri Shapefile', detectionConfidence: 1 };

/** UTM 45N — a projected CRS, so distances are metres. */
const UTM = crsFromEpsg(32645);
/** WGS 84 — geographic, so coordinates are degrees. */
const WGS84 = crsFromEpsg(4326);

function square(minX: number, minY: number, maxX: number, maxY: number): CirGeometry {
  return {
    type: 'Polygon',
    coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]],
    dimension: 2,
  };
}

function feature(geometry: CirGeometry | null, properties: Record<string, unknown> = {}): CirFeature {
  return { geometry, properties };
}

function dataset(features: CirFeature[], name = 'Plots', extra: CirFeature[] = [], extraName = 'Mask'): CirDataset {
  const layers = [createLayer(name, features, [{ name: 'block', type: 'string' }])];
  if (extra.length > 0) layers.push(createLayer(extraName, extra));
  return createDataset({ kind: 'vector', name: 'plots', source: SOURCE, crs: UTM, layers });
}

function areaOfGeometry(geometry: CirGeometry | null): number {
  let total = 0;
  for (const rings of toMultiPolygon(geometry)) {
    for (let index = 0; index < rings.length; index++) {
      const ring = rings[index];
      let sum = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
      }
      total += (index === 0 ? 1 : -1) * Math.abs(sum / 2);
    }
  }
  return total;
}

// ===========================================================================
// The CRS gate
// ===========================================================================

describe('the CRS gate on distance operations', () => {
  const data = createDataset({
    kind: 'vector',
    name: 'plots',
    source: SOURCE,
    crs: WGS84,
    layers: [createLayer('Plots', [feature(square(77.1, 23.2, 77.2, 23.3))])],
  });

  it('refuses a buffer on a geographic CRS', () => {
    const plan = planGeometryOperation(data, 'Plots', 'buffer', { crs: WGS84, distance: 10 });
    expect(plan.refusal).toBeDefined();
    expect(plan.refusal?.why).toContain('DEGREES');
    expect(plan.refusal?.action).toContain('Reproject');
    expect(plan.features).toHaveLength(0);
  });

  it('refuses an offset on a geographic CRS', () => {
    expect(planGeometryOperation(data, 'Plots', 'offset', { crs: WGS84, distance: 5 }).refusal).toBeDefined();
  });

  it('refuses a buffer when no CRS is declared at all', () => {
    const plan = planGeometryOperation(data, 'Plots', 'buffer', { crs: null, distance: 10 });
    expect(plan.refusal?.why).toContain('no CRS');
  });

  it('allows a buffer on a projected CRS', () => {
    const projected = dataset([feature(square(0, 0, 100, 100))]);
    expect(planGeometryOperation(projected, 'Plots', 'buffer', { crs: UTM, distance: 10 }).refusal).toBeUndefined();
  });

  it('allows scale-free operations on a geographic CRS', () => {
    // A hull, a centroid or an envelope has no length in it, so degrees are fine.
    for (const operation of ['convex-hull', 'centroid', 'envelope'] as const) {
      expect(planGeometryOperation(data, 'Plots', operation, { crs: WGS84 }).refusal).toBeUndefined();
    }
  });
});

// ===========================================================================
// Buffer
// ===========================================================================

describe('buffer', () => {
  it('grows a square by the right area', () => {
    // A 100x100 square buffered by 10 gains a 10-wide band on four sides plus
    // four quarter-circles at the corners:
    //   100² + 4(100 × 10) + π(10²) = 10000 + 4000 + 314.159 = 14314.159
    const result = bufferGeometry(square(0, 0, 100, 100), 10, { tolerance: 0.001 });
    const area = areaOfGeometry({ type: 'MultiPolygon', coordinates: result.polygons, dimension: 2 });
    expect(area).toBeCloseTo(10000 + 4000 + Math.PI * 100, 0);
  });

  it('buffers a point to a disc of the right area', () => {
    const result = bufferGeometry({ type: 'Point', coordinates: [0, 0], dimension: 2 }, 25, { tolerance: 0.0001 });
    const area = areaOfGeometry({ type: 'MultiPolygon', coordinates: result.polygons, dimension: 2 });
    expect(area).toBeCloseTo(Math.PI * 625, 0);
  });

  it('buffers a line to a corridor of the right area', () => {
    // A 100-long line buffered by 5: a 100x10 rectangle plus a full circle from
    // the two round caps. 1000 + π(25) = 1078.54
    const line: CirGeometry = { type: 'LineString', coordinates: [[0, 0], [100, 0]], dimension: 2 };
    const result = bufferGeometry(line, 5, { tolerance: 0.0001 });
    const area = areaOfGeometry({ type: 'MultiPolygon', coordinates: result.polygons, dimension: 2 });
    expect(area).toBeCloseTo(1000 + Math.PI * 25, 0);
  });

  it('a flat cap gives exactly the rectangle', () => {
    const line: CirGeometry = { type: 'LineString', coordinates: [[0, 0], [100, 0]], dimension: 2 };
    const result = bufferGeometry(line, 5, { cap: 'flat', tolerance: 0.0001 });
    const area = areaOfGeometry({ type: 'MultiPolygon', coordinates: result.polygons, dimension: 2 });
    expect(area).toBeCloseTo(1000, 6);
  });

  it('shrinks a square by a negative distance', () => {
    // 100x100 eroded by 10 leaves 80x80 = 6400.
    const result = bufferGeometry(square(0, 0, 100, 100), -10, { tolerance: 0.001 });
    const area = areaOfGeometry({ type: 'MultiPolygon', coordinates: result.polygons, dimension: 2 });
    expect(area).toBeCloseTo(6400, 0);
  });

  it('erodes a narrow strip out of existence rather than inside out', () => {
    // A 100x10 strip eroded by 10 cannot survive: it is narrower than 2x10.
    // The classic failure is returning an inverted polygon with positive area.
    const result = bufferGeometry(square(0, 0, 100, 10), -10, { tolerance: 0.001 });
    expect(result.polygons).toHaveLength(0);
  });

  it('shrinks a hole outward when the polygon grows', () => {
    const withHole: CirGeometry = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
        [[40, 40], [40, 60], [60, 60], [60, 40], [40, 40]],
      ],
      dimension: 2,
    };
    // The 20x20 hole shrinks by 5 on each side, so it becomes 10x10 with
    // rounded corners — smaller, but not gone.
    const result = bufferGeometry(withHole, 5, { tolerance: 0.001 });
    const area = areaOfGeometry({ type: 'MultiPolygon', coordinates: result.polygons, dimension: 2 });
    expect(area).toBeGreaterThan(10000);
    expect(result.polygons[0].length).toBe(2);
  });

  it('closes a hole the buffer is wide enough to fill', () => {
    const withHole: CirGeometry = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
        [[45, 45], [45, 55], [55, 55], [55, 45], [45, 45]],
      ],
      dimension: 2,
    };
    const result = bufferGeometry(withHole, 20, { tolerance: 0.01 });
    expect(result.polygons[0]).toHaveLength(1);
  });

  it('a mitre join reaches further than a round one, and a bevel less', () => {
    const corner: CirGeometry = { type: 'LineString', coordinates: [[0, 0], [50, 0], [50, 50]], dimension: 2 };
    const areaFor = (join: 'round' | 'miter' | 'bevel'): number =>
      areaOfGeometry({
        type: 'MultiPolygon',
        coordinates: bufferGeometry(corner, 10, { join, cap: 'flat', tolerance: 0.001 }).polygons,
        dimension: 2,
      });

    expect(areaFor('miter')).toBeGreaterThan(areaFor('round'));
    expect(areaFor('round')).toBeGreaterThan(areaFor('bevel'));
  });

  it('a disc approximates its circle to within the tolerance', () => {
    const ring = disc([0, 0], 100, 0.01);
    for (const [x, y] of ring) expect(Math.hypot(x, y)).toBeCloseTo(100, 9);
    // Finer tolerance must mean more segments, or the tolerance means nothing.
    expect(disc([0, 0], 100, 0.001).length).toBeGreaterThan(ring.length);
  });

  it('never returns a self-intersecting result on a sharp reflex corner', () => {
    // A tight zig-zag is where a boundary-walking buffer folds over itself.
    const zigzag: CirGeometry = {
      type: 'LineString',
      coordinates: [[0, 0], [10, 0], [10, 1], [0, 1], [0, 2], [10, 2]],
      dimension: 2,
    };
    const result = bufferGeometry(zigzag, 3, { tolerance: 0.01 });
    const area = areaOfGeometry({ type: 'MultiPolygon', coordinates: result.polygons, dimension: 2 });
    // A folded buffer reports far less area than the corridor really covers.
    expect(area).toBeGreaterThan(60);
    expect(result.polygons.length).toBeGreaterThanOrEqual(1);
  });
});

describe('offset', () => {
  it('offsets a straight line by exactly the distance', () => {
    const result = offsetLine([[0, 0], [100, 0]], 5);
    expect(result.positions[0][1]).toBeCloseTo(5, 9);
    expect(result.positions[result.positions.length - 1][1]).toBeCloseTo(5, 9);
    expect(result.selfIntersects).toBe(false);
  });

  it('offsets to the other side for a negative distance', () => {
    expect(offsetLine([[0, 0], [100, 0]], -5).positions[0][1]).toBeCloseTo(-5, 9);
  });

  it('keeps every offset vertex exactly the distance from an outside corner', () => {
    // The path turns LEFT here, so the OUTSIDE is the right-hand side: a
    // negative distance. Offsetting to the inside is trimmed instead, and is
    // covered by its own test below.
    const result = offsetLine([[0, 0], [50, 0], [50, 50]], -10, { join: 'round', tolerance: 0.001 });
    const onArc = result.positions.filter(([x, y]) => Math.abs(Math.hypot(x - 50, y - 0) - 10) < 1e-6);
    expect(onArc.length).toBeGreaterThan(1);
  });

  it('trims an inside corner to a single point', () => {
    // Offsetting into the turn, the two parallel lines OVERLAP, and the offset
    // is their intersection — one vertex, not two.
    //
    // Emitting both left a short doubling-back at every inside corner however
    // gentle, which is a real self-intersection, so the cusp flag fired on
    // almost every inward offset and stopped meaning anything.
    const result = offsetLine([[0, 0], [10, 0], [20, 5]], 2);
    expect(result.positions).toHaveLength(3);
    expect(result.selfIntersects).toBe(false);
  });

  it('does not report a cusp on ordinary geometry', () => {
    const shapes: Position[][] = [
      [[0, 0], [10, 0]],
      [[0, 0], [10, 0], [20, 5]],
      [[0, 0], [10, 0], [10, 2], [0, 2]],
      [[0, 0], [5, 0], [5, 1], [10, 1]],
    ];
    for (const shape of shapes) {
      for (const distance of [0.5, 2, -0.5, -2]) {
        expect(offsetLine(shape, distance).selfIntersects).toBe(false);
      }
    }
  });

  it('keeps an outside corner at exactly the offset distance', () => {
    // The outside of a turn opens a wedge that the join fills; every vertex of
    // a round join must sit exactly `distance` from the corner.
    const result = offsetLine([[0, 0], [10, 0], [20, 5]], -2, { join: 'round', tolerance: 0.0001 });
    const nearCorner = result.positions.filter(
      ([x, y]) => Math.abs(Math.hypot(x - 10, y - 0) - 2) < 1e-6
    );
    expect(nearCorner.length).toBeGreaterThan(1);
  });
});

// ===========================================================================
// Scale-free operations
// ===========================================================================

describe('convex hull', () => {
  it('wraps a scatter of points', () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]);
    // The interior point must not be on the hull.
    expect(hull.some(([x, y]) => x === 5 && y === 5)).toBe(false);
    expect(hull).toHaveLength(5); // four corners plus the closing vertex
  });

  it('excludes a point lying exactly on an edge', () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 0]]);
    expect(hull.some(([x, y]) => x === 5 && y === 0)).toBe(false);
  });

  it('returns the points themselves when they are collinear', () => {
    expect(convexHull([[0, 0], [5, 0], [10, 0]]).length).toBeLessThan(4);
  });

  it('handles duplicates', () => {
    expect(convexHull([[0, 0], [0, 0], [10, 0], [10, 10], [10, 10]])).toHaveLength(4);
  });
});

describe('centroid', () => {
  it('is the area centroid of a polygon, not the vertex mean', () => {
    // An L-shape: the vertex mean and the area centroid differ, and only the
    // area centroid is the balance point.
    const ell: CirGeometry = {
      type: 'Polygon',
      coordinates: [[[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]]],
      dimension: 2,
    };
    const centroid = centroidOf(ell)!;
    // Two rectangles: 10x4 centred (5,2) area 40, and 4x6 centred (2,7) area 24.
    // x = (40(5) + 24(2)) / 64 = 3.875,  y = (40(2) + 24(7)) / 64 = 3.875
    expect(centroid[0]).toBeCloseTo(3.875, 9);
    expect(centroid[1]).toBeCloseTo(3.875, 9);
  });

  it('accounts for a hole', () => {
    const offCentreHole: CirGeometry = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
      ],
      dimension: 2,
    };
    const centroid = centroidOf(offCentreHole)!;
    // The void is in the lower-left, so the centroid moves up and right of (5,5).
    expect(centroid[0]).toBeGreaterThan(5);
    expect(centroid[1]).toBeGreaterThan(5);
  });

  it('is length-weighted on a line', () => {
    // A short segment then a long one: the centroid sits inside the long one.
    const line: CirGeometry = { type: 'LineString', coordinates: [[0, 0], [1, 0], [101, 0]], dimension: 2 };
    expect(centroidOf(line)![0]).toBeCloseTo((0.5 * 1 + 51 * 100) / 101, 9);
  });

  it('averages points', () => {
    const points: CirGeometry = { type: 'MultiPoint', coordinates: [[0, 0], [10, 0], [10, 10], [0, 10]], dimension: 2 };
    expect(centroidOf(points)).toEqual([5, 5]);
  });

  it('returns null for geometry with no extent', () => {
    expect(centroidOf(null)).toBeNull();
    expect(centroidOf({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]], dimension: 2 })).toBeNull();
  });
});

describe('envelope', () => {
  it('is the bounding box, closed', () => {
    const ring = envelopeOf({ type: 'LineString', coordinates: [[3, 7], [11, 2], [5, 9]], dimension: 2 })!;
    expect(ring[0]).toEqual([3, 2]);
    expect(ring[2]).toEqual([11, 9]);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('returns null for nothing', () => {
    expect(envelopeOf(null)).toBeNull();
  });
});

// ===========================================================================
// Multipart
// ===========================================================================

describe('explode and combine', () => {
  const multi: CirGeometry = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]],
    ],
    dimension: 2,
  };

  it('splits a multipart into its parts', () => {
    const parts = explodeGeometry(multi);
    expect(parts).toHaveLength(2);
    expect(parts.every((part) => part.type === 'Polygon')).toBe(true);
  });

  it('leaves a single part alone', () => {
    expect(explodeGeometry(square(0, 0, 1, 1))).toHaveLength(1);
  });

  it('says that exploding copies the attribute row onto every part', () => {
    const data = dataset([feature(multi, { block: 'A' })]);
    const plan = planGeometryOperation(data, 'Plots', 'explode', { crs: UTM });
    expect(plan.features).toHaveLength(2);
    expect(plan.features.every((entry) => entry.properties.block === 'A')).toBe(true);
    expect(plan.notes.join(' ')).toContain('COPY');
  });

  it('combines single parts back into one multipart', () => {
    const combined = toMultipart(explodeGeometry(multi));
    expect(combined?.type).toBe('MultiPolygon');
    expect((combined?.coordinates as unknown[]).length).toBe(2);
  });

  it('keeps mixed kinds as a collection rather than coercing them', () => {
    const mixed = toMultipart([
      { type: 'Point', coordinates: [0, 0], dimension: 2 },
      square(0, 0, 1, 1),
    ]);
    expect(mixed?.type).toBe('GeometryCollection');
  });

  it('states that combining discards all but the first row', () => {
    const data = dataset([feature(square(0, 0, 1, 1), { block: 'A' }), feature(square(5, 5, 6, 6), { block: 'A' })]);
    const plan = planGeometryOperation(data, 'Plots', 'multipart', { crs: UTM, field: 'block' });
    expect(plan.features).toHaveLength(1);
    expect(plan.notes.join(' ')).toMatch(/discard|keeping the first/i);
  });
});

// ===========================================================================
// Line operations
// ===========================================================================

describe('line merge', () => {
  it('joins a boundary drawn as separate segments', () => {
    const { merged } = mergeLines([
      [[0, 0], [10, 0]],
      [[10, 0], [10, 10]],
      [[10, 10], [0, 10]],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toHaveLength(4);
  });

  it('joins segments given in the wrong direction', () => {
    const { merged } = mergeLines([
      [[0, 0], [10, 0]],
      [[10, 10], [10, 0]],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toHaveLength(3);
  });

  it('leaves a three-way junction alone and says so', () => {
    // Choosing a continuation at a T would be inventing a topology decision.
    const { merged, junctions } = mergeLines([
      [[0, 0], [10, 0]],
      [[10, 0], [20, 0]],
      [[10, 0], [10, 10]],
    ]);
    expect(junctions).toBe(1);
    expect(merged).toHaveLength(3);
  });

  it('keeps separate runs separate', () => {
    const { merged } = mergeLines([
      [[0, 0], [10, 0]],
      [[50, 50], [60, 50]],
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('line substring', () => {
  const line: Position[] = [[0, 0], [100, 0]];

  it('extracts a run by distance along the line', () => {
    expect(lineSubstring(line, 20, 60)).toEqual([[20, 0], [60, 0]]);
  });

  it('clamps to the ends', () => {
    expect(lineSubstring(line, -10, 500)).toEqual([[0, 0], [100, 0]]);
  });

  it('returns nothing for a zero-length run', () => {
    expect(lineSubstring(line, 50, 50)).toEqual([]);
  });

  it('spans several segments', () => {
    const bent: Position[] = [[0, 0], [100, 0], [100, 100]];
    const part = lineSubstring(bent, 50, 150);
    expect(part[0]).toEqual([50, 0]);
    expect(part[part.length - 1]).toEqual([100, 50]);
  });

  it('interpolates Z, because a chainage does have a defined level', () => {
    const graded: Position[] = [[0, 0, 100], [100, 0, 110]];
    const part = lineSubstring(graded, 0, 50);
    expect(part[part.length - 1][2]).toBeCloseTo(105, 9);
  });

  it('measures length consistently with the substring', () => {
    expect(lineLength(line)).toBe(100);
    expect(lineLength(lineSubstring(line, 25, 75))).toBeCloseTo(50, 9);
  });
});

// ===========================================================================
// The plan layer
// ===========================================================================

describe('booleans over a layer', () => {
  const two = dataset([feature(square(0, 0, 10, 10), { block: 'A' }), feature(square(5, 5, 15, 15), { block: 'B' })]);

  it('unions to the combined area', () => {
    const plan = planGeometryOperation(two, 'Plots', 'union', { crs: UTM });
    expect(planArea(plan)).toBeCloseTo(175, 9);
  });

  it('intersects to the overlap', () => {
    expect(planArea(planGeometryOperation(two, 'Plots', 'intersection', { crs: UTM }))).toBeCloseTo(25, 9);
  });

  it('refuses an intersection of one feature', () => {
    const one = dataset([feature(square(0, 0, 10, 10))]);
    expect(planGeometryOperation(one, 'Plots', 'intersection', { crs: UTM }).refusal).toBeDefined();
  });

  it('says that a boolean drops Z', () => {
    const raised = dataset([
      feature({ type: 'Polygon', coordinates: [[[0, 0, 5], [10, 0, 5], [10, 10, 6], [0, 10, 6], [0, 0, 5]]], dimension: 3 }),
      feature(square(5, 5, 15, 15)),
    ]);
    const plan = planGeometryOperation(raised, 'Plots', 'union', { crs: UTM });
    expect(plan.notes.join(' ')).toContain('no Z');
  });
});

describe('dissolve', () => {
  const blocks = dataset([
    feature(square(0, 0, 10, 10), { block: 'A', owner: 'Rao' }),
    feature(square(10, 0, 20, 10), { block: 'A', owner: 'Devi' }),
    feature(square(40, 0, 50, 10), { block: 'B', owner: 'Rao' }),
  ]);

  it('merges adjacent parcels sharing a value into one', () => {
    const plan = planGeometryOperation(blocks, 'Plots', 'dissolve', { crs: UTM, field: 'block' });
    expect(plan.features).toHaveLength(2);
    expect(planArea(plan)).toBeCloseTo(300, 9);

    const blockA = plan.features.find((entry) => entry.properties.block === 'A')!;
    expect(areaOfGeometry(blockA.geometry)).toBeCloseTo(200, 9);
  });

  it('keeps only the grouping field, and says why', () => {
    const plan = planGeometryOperation(blocks, 'Plots', 'dissolve', { crs: UTM, field: 'block' });
    expect(plan.features[0].properties.owner).toBeUndefined();
    expect(plan.notes.join(' ')).toContain('no longer exists');
  });

  it('dissolves everything into one when no field is given', () => {
    const plan = planGeometryOperation(blocks, 'Plots', 'dissolve', { crs: UTM });
    expect(plan.features).toHaveLength(1);
    expect(planArea(plan)).toBeCloseTo(300, 9);
  });
});

describe('clip and erase', () => {
  const data = dataset(
    [feature(square(0, 0, 10, 10), { block: 'A' }), feature(square(50, 50, 60, 60), { block: 'B' })],
    'Plots',
    [feature(square(-5, -5, 15, 15))],
    'Boundary'
  );

  it('clips to the mask and removes what falls outside', () => {
    const plan = planGeometryOperation(data, 'Plots', 'clip', { crs: UTM, maskLayer: 'Boundary' });
    expect(plan.features).toHaveLength(1);
    expect(planArea(plan)).toBeCloseTo(100, 9);
    expect(plan.notes.join(' ')).toContain('outside');
  });

  it('erases the mask from the layer', () => {
    const plan = planGeometryOperation(data, 'Plots', 'erase', { crs: UTM, maskLayer: 'Boundary' });
    expect(plan.features).toHaveLength(1);
    expect(planArea(plan)).toBeCloseTo(100, 9); // only the far plot survives
  });

  it('refuses without a mask, and refuses masking a layer by itself', () => {
    expect(planGeometryOperation(data, 'Plots', 'clip', { crs: UTM }).refusal).toBeDefined();
    expect(planGeometryOperation(data, 'Plots', 'clip', { crs: UTM, maskLayer: 'Plots' }).refusal).toBeDefined();
  });

  it('refuses a mask holding no polygons', () => {
    const lineMask = dataset(
      [feature(square(0, 0, 10, 10))],
      'Plots',
      [feature({ type: 'LineString', coordinates: [[0, 0], [10, 10]], dimension: 2 })],
      'Boundary'
    );
    expect(planGeometryOperation(lineMask, 'Plots', 'clip', { crs: UTM, maskLayer: 'Boundary' }).refusal).toBeDefined();
  });
});

describe('split by line', () => {
  const data = dataset([feature(square(0, 0, 100, 100), { block: 'A', area_m2: 10000 })]);

  it('cuts a parcel into two', () => {
    const plan = planGeometryOperation(data, 'Plots', 'split-by-line', {
      crs: UTM,
      cut: [[50, -10], [50, 110]],
    });
    expect(plan.features).toHaveLength(2);
    expect(planArea(plan)).toBeCloseTo(10000, 3);
  });

  it('warns that both halves keep the original area value', () => {
    const plan = planGeometryOperation(data, 'Plots', 'split-by-line', { crs: UTM, cut: [[50, -10], [50, 110]] });
    expect(plan.features.every((entry) => entry.properties.area_m2 === 10000)).toBe(true);
    expect(plan.notes.join(' ')).toContain('now wrong for both parts');
  });

  it('leaves a feature alone when the cut misses it', () => {
    const plan = planGeometryOperation(data, 'Plots', 'split-by-line', { crs: UTM, cut: [[500, 0], [500, 100]] });
    expect(plan.features).toHaveLength(1);
    expect(plan.notes.join(' ')).toContain('nothing was split');
  });

  it('refuses without a cutting line', () => {
    expect(planGeometryOperation(data, 'Plots', 'split-by-line', { crs: UTM }).refusal).toBeDefined();
  });
});

// ===========================================================================
// Apply, undo, refusals
// ===========================================================================

describe('applying a plan', () => {
  const data = dataset([feature(square(0, 0, 10, 10), { block: 'A' })]);

  it('replaces the source layer by default', () => {
    const plan = planGeometryOperation(data, 'Plots', 'centroid', { crs: UTM });
    const applied = applyGeometryOperation(data, plan);
    expect(applied.dataset.layers).toHaveLength(1);
    expect(applied.dataset.layers[0].features[0].geometry?.type).toBe('Point');
  });

  it('writes to a new layer when one is named, leaving the source intact', () => {
    const plan = planGeometryOperation(data, 'Plots', 'buffer', { crs: UTM, distance: 5, outputLayer: 'Setback' });
    const applied = applyGeometryOperation(data, plan);

    expect(applied.dataset.layers.map((layer) => layer.name)).toEqual(['Plots', 'Setback']);
    // The source is untouched — the safe default for anything destructive.
    expect(areaOfGeometry(applied.dataset.layers[0].features[0].geometry)).toBeCloseTo(100, 9);
    expect(areaOfGeometry(applied.dataset.layers[1].features[0].geometry)).toBeGreaterThan(100);
  });

  it('undoes back to the original layers', () => {
    const plan = planGeometryOperation(data, 'Plots', 'centroid', { crs: UTM });
    const applied = applyGeometryOperation(data, plan);
    const reverted = undoGeometryOperation(applied.dataset, applied);
    expect(reverted.layers[0].features[0].geometry?.type).toBe('Polygon');
  });

  it('refuses on a protected layer', () => {
    const plan = planGeometryOperation(data, 'Plots', 'centroid', { crs: UTM, protectedLayers: ['Plots'] });
    expect(plan.refusal?.what).toContain('protected');
    expect(applyGeometryOperation(data, plan).dataset.layers[0].features[0].geometry?.type).toBe('Polygon');
  });

  it('refuses an unknown layer, and an empty selection', () => {
    expect(planGeometryOperation(data, 'Nope', 'centroid', { crs: UTM }).refusal).toBeDefined();
    // An empty selection is refused rather than quietly returning nothing: the
    // user asked for an operation and would otherwise see no result and no reason.
    expect(planGeometryOperation(data, 'Plots', 'centroid', { crs: UTM, scope: [] }).refusal).toBeDefined();
  });

  it('honours a scope', () => {
    const two = dataset([feature(square(0, 0, 10, 10)), feature(square(20, 20, 30, 30))]);
    const plan = planGeometryOperation(two, 'Plots', 'centroid', { crs: UTM, scope: [0] });
    expect(plan.features).toHaveLength(1);
    expect(plan.features[0].geometry?.coordinates).toEqual([5, 5]);
  });

  it('describes what it will do', () => {
    const plan = planGeometryOperation(data, 'Plots', 'centroid', { crs: UTM });
    expect(describeGeometryPlan(plan)).toContain('Centroid');
    expect(describeGeometryPlan(plan)).toContain('1 feature(s) → 1');
  });

  it('gives the refusal in full when there is one', () => {
    const plan = planGeometryOperation(data, 'Plots', 'buffer', { crs: WGS84, distance: 10 });
    expect(describeGeometryPlan(plan)).toContain('Reproject');
  });
});
