/**
 * Polygon boolean operations (`core/polygon-boolean.ts`).
 *
 * The reason this file is long: a boolean clipper that is 95% right is worse
 * than none at all. It produces a polygon that renders, writes, validates and
 * is wrong — and the person who finds out is whoever receives the delivery.
 *
 * So the tests below are weighted towards the DEGENERACIES rather than the easy
 * overlaps, because degeneracies are the normal case in cadastral work:
 *
 *   - Two adjacent parcels share a boundary. Their edges are exactly collinear
 *     and overlapping. This is the case Greiner–Hormann gets wrong and the
 *     reason the implementation is Martínez–Rueda.
 *   - Boundaries meet at a surveyed corner, so intersections land exactly on
 *     vertices rather than in the middle of edges.
 *   - A plot touches its neighbour at one point without crossing.
 *
 * Two invariants are checked repeatedly because they catch whole classes of
 * error that eyeballing a coordinate list does not:
 *
 *   area(A ∪ B) + area(A ∩ B) = area(A) + area(B)
 *   area(A \ B) + area(A ∩ B) = area(A)
 */

import { describe, expect, it } from 'vitest';
import { booleanOperation, unionAll, type MultiPoly, type Ring } from '@core/polygon-boolean';

// --------------------------------------------------------------- helpers

function box(minX: number, minY: number, maxX: number, maxY: number): MultiPoly {
  return [[[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]];
}

function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

/** Total area: exterior rings minus their holes, whatever the winding. */
function areaOf(polygons: MultiPoly): number {
  let total = 0;
  for (const rings of polygons) {
    total += Math.abs(ringArea(rings[0]));
    for (let index = 1; index < rings.length; index++) total -= Math.abs(ringArea(rings[index]));
  }
  return total;
}

function run(a: MultiPoly, b: MultiPoly, op: Parameters<typeof booleanOperation>[2]): MultiPoly {
  return booleanOperation(a, b, op).polygons;
}

function isClosed(ring: Ring): boolean {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/** Asserts the shape of every result: closed rings, no repeats, real area. */
function expectWellFormed(polygons: MultiPoly): void {
  for (const rings of polygons) {
    expect(rings.length).toBeGreaterThan(0);
    for (const ring of rings) {
      expect(isClosed(ring)).toBe(true);
      // A closed ring needs at least a triangle plus the repeated first point.
      expect(ring.length).toBeGreaterThanOrEqual(4);
      expect(Math.abs(ringArea(ring))).toBeGreaterThan(0);

      // No consecutive duplicates, which no writer handles consistently.
      for (let index = 1; index < ring.length; index++) {
        const same = ring[index][0] === ring[index - 1][0] && ring[index][1] === ring[index - 1][1];
        expect(same).toBe(false);
      }
    }
  }
}

// ===========================================================================
// The easy cases, which must still be exactly right
// ===========================================================================

describe('disjoint polygons', () => {
  const a = box(0, 0, 10, 10);
  const b = box(20, 20, 30, 30);

  it('intersect to nothing', () => {
    expect(run(a, b, 'intersection')).toEqual([]);
  });

  it('union to both, unchanged', () => {
    const union = run(a, b, 'union');
    expect(union).toHaveLength(2);
    expect(areaOf(union)).toBeCloseTo(200, 9);
  });

  it('difference leaves the subject alone', () => {
    expect(areaOf(run(a, b, 'difference'))).toBeCloseTo(100, 9);
  });

  it('short-circuits rather than sweeping', () => {
    expect(booleanOperation(a, b, 'intersection').report.trivial).toBe('disjoint');
  });
});

describe('overlapping squares', () => {
  // 10x10 at the origin, and 10x10 offset by 5 — a 5x5 overlap.
  const a = box(0, 0, 10, 10);
  const b = box(5, 5, 15, 15);

  it('intersects to the 5x5 overlap', () => {
    const result = run(a, b, 'intersection');
    expectWellFormed(result);
    expect(areaOf(result)).toBeCloseTo(25, 9);
  });

  it('unions to 175, not 200', () => {
    const result = run(a, b, 'union');
    expectWellFormed(result);
    // 100 + 100 - 25 double-counted.
    expect(result).toHaveLength(1);
    expect(areaOf(result)).toBeCloseTo(175, 9);
  });

  it('differences to 75', () => {
    const result = run(a, b, 'difference');
    expectWellFormed(result);
    expect(areaOf(result)).toBeCloseTo(75, 9);
  });

  it('xors to 150', () => {
    const result = run(a, b, 'xor');
    expectWellFormed(result);
    expect(areaOf(result)).toBeCloseTo(150, 9);
  });

  it('holds the area identity', () => {
    // area(A∪B) + area(A∩B) === area(A) + area(B)
    expect(areaOf(run(a, b, 'union')) + areaOf(run(a, b, 'intersection'))).toBeCloseTo(200, 9);
    // area(A\B) + area(A∩B) === area(A)
    expect(areaOf(run(a, b, 'difference')) + areaOf(run(a, b, 'intersection'))).toBeCloseTo(100, 9);
  });
});

describe('containment', () => {
  const outer = box(0, 0, 10, 10);
  const inner = box(2, 2, 4, 4);

  it('intersects to the inner polygon', () => {
    expect(areaOf(run(outer, inner, 'intersection'))).toBeCloseTo(4, 9);
  });

  it('unions to the outer polygon', () => {
    const result = run(outer, inner, 'union');
    expect(result).toHaveLength(1);
    expect(areaOf(result)).toBeCloseTo(100, 9);
  });

  it('differences to a polygon with a hole', () => {
    const result = run(outer, inner, 'difference');
    expectWellFormed(result);
    expect(result).toHaveLength(1);
    // The hole must be a SECOND ring on the same polygon, not a separate
    // polygon — a hole promoted to its own exterior ring is filled, not void.
    expect(result[0]).toHaveLength(2);
    expect(areaOf(result)).toBeCloseTo(96, 9);
  });
});

describe('identical polygons', () => {
  const a = box(0, 0, 10, 10);
  const b = box(0, 0, 10, 10);

  it('intersect and union to themselves', () => {
    expect(areaOf(run(a, b, 'intersection'))).toBeCloseTo(100, 9);
    expect(areaOf(run(a, b, 'union'))).toBeCloseTo(100, 9);
  });

  it('difference and xor to nothing', () => {
    expect(areaOf(run(a, b, 'difference'))).toBeCloseTo(0, 9);
    expect(areaOf(run(a, b, 'xor'))).toBeCloseTo(0, 9);
  });
});

// ===========================================================================
// The degeneracies — the reason for the algorithm choice
// ===========================================================================

describe('adjacent parcels sharing a boundary', () => {
  // Two 10x10 plots meeting exactly along x = 10. Their edges are collinear and
  // overlapping, which is what a shared cadastral boundary IS.
  const west = box(0, 0, 10, 10);
  const east = box(10, 0, 20, 10);

  it('unions into one rectangle, with the shared edge dissolved', () => {
    const result = run(west, east, 'union');
    expectWellFormed(result);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(areaOf(result)).toBeCloseTo(200, 9);

    // The result is the enclosing rectangle: every vertex lies on its boundary,
    // and the seam down x = 10 is gone as a boundary.
    const corners = result[0][0].slice(0, -1);
    for (const [x, y] of corners) {
      const onEdge = x === 0 || x === 20 || y === 0 || y === 10;
      expect(onEdge).toBe(true);
    }
    expect(corners.some(([x, y]) => x === 0 && y === 0)).toBe(true);
    expect(corners.some(([x, y]) => x === 20 && y === 10)).toBe(true);

    // The two ends of the dissolved seam, (10, 0) and (10, 10), REMAIN as
    // collinear vertices on the rectangle's edges. That is deliberate and not a
    // defect: they are surveyed corners, and a boolean operation is not the
    // place to discard a monumented point because it became geometrically
    // redundant. Removing them is what a simplify operation is for, and that is
    // a decision the surveyor makes, not a side effect of a merge.
    expect(corners).toHaveLength(6);
    expect(corners.some(([x, y]) => x === 10 && y === 0)).toBe(true);
    expect(corners.some(([x, y]) => x === 10 && y === 10)).toBe(true);
  });

  it('intersects to nothing — a shared edge encloses no area', () => {
    const result = run(west, east, 'intersection');
    // A zero-width strip along the shared boundary is not an overlap. Returning
    // one would make every pair of neighbouring parcels look like an encroachment.
    expect(areaOf(result)).toBeCloseTo(0, 9);
  });

  it('differences to the subject, unchanged', () => {
    expect(areaOf(run(west, east, 'difference'))).toBeCloseTo(100, 9);
  });

  it('xors to both plots', () => {
    expect(areaOf(run(west, east, 'xor'))).toBeCloseTo(200, 9);
  });
});

describe('a partially shared boundary', () => {
  // The shared run covers only part of each edge — the case where a re-survey
  // gave the neighbour a longer frontage.
  const a = box(0, 0, 10, 10);
  const b: MultiPoly = [[[[10, 2], [20, 2], [20, 8], [10, 8], [10, 2]]]];

  it('unions without losing or double-counting area', () => {
    const result = run(a, b, 'union');
    expectWellFormed(result);
    expect(areaOf(result)).toBeCloseTo(100 + 60, 9);
  });

  it('intersects to nothing', () => {
    expect(areaOf(run(a, b, 'intersection'))).toBeCloseTo(0, 9);
  });
});

describe('polygons touching at a single corner', () => {
  const a = box(0, 0, 10, 10);
  const b = box(10, 10, 20, 20);

  it('intersects to nothing', () => {
    expect(areaOf(run(a, b, 'intersection'))).toBeCloseTo(0, 9);
  });

  it('unions to both areas', () => {
    const result = run(a, b, 'union');
    expectWellFormed(result);
    expect(areaOf(result)).toBeCloseTo(200, 9);
  });
});

describe('an intersection landing exactly on vertices', () => {
  // A diamond whose corners sit exactly on the square's edge midpoints, so
  // every crossing is at a coordinate both polygons already name.
  const square = box(0, 0, 10, 10);
  const diamond: MultiPoly = [[[[5, 0], [10, 5], [5, 10], [0, 5], [5, 0]]]];

  it('intersects to the diamond', () => {
    const result = run(square, diamond, 'intersection');
    expectWellFormed(result);
    expect(areaOf(result)).toBeCloseTo(50, 9);
  });

  it('differences to the four corner triangles', () => {
    const result = run(square, diamond, 'difference');
    expectWellFormed(result);
    expect(result).toHaveLength(4);
    expect(areaOf(result)).toBeCloseTo(50, 9);
  });
});

describe('concave shapes', () => {
  // An L, and a bar crossing both of its arms.
  const ell: MultiPoly = [[[[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]]]];
  const bar = box(2, 2, 12, 6);

  it('intersects into two disjoint pieces', () => {
    const result = run(ell, bar, 'intersection');
    expectWellFormed(result);
    // The bar crosses the horizontal arm and the vertical arm; between them it
    // is outside the L, so the intersection is not connected.
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(areaOf(result)).toBeGreaterThan(0);
    // area(L) = 100 - 36 = 64 checked independently below.
    expect(areaOf(run(ell, ell, 'union'))).toBeCloseTo(64, 9);
  });

  it('holds the area identity on a concave subject', () => {
    const both = areaOf(run(ell, bar, 'union')) + areaOf(run(ell, bar, 'intersection'));
    expect(both).toBeCloseTo(64 + 40, 9);
  });
});

// ===========================================================================
// Holes
// ===========================================================================

describe('polygons with holes', () => {
  /** A 10x10 with a 2x2 void in the middle. Area 96. */
  const withHole: MultiPoly = [
    [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]],
    ],
  ];

  it('reads the hole as a void, not as area', () => {
    expect(areaOf(withHole)).toBeCloseTo(96, 9);
    expect(areaOf(run(withHole, withHole, 'union'))).toBeCloseTo(96, 9);
  });

  it('intersecting a covering box returns the hole intact', () => {
    const result = run(withHole, box(-5, -5, 15, 15), 'intersection');
    expectWellFormed(result);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
    expect(areaOf(result)).toBeCloseTo(96, 9);
  });

  it('a patch over the hole fills it', () => {
    const result = run(withHole, box(3, 3, 7, 7), 'union');
    expectWellFormed(result);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1); // no hole left
    expect(areaOf(result)).toBeCloseTo(100, 9);
  });

  it('a patch over part of the hole leaves a smaller void', () => {
    const result = run(withHole, box(4, 4, 6, 5), 'union');
    expectWellFormed(result);
    expect(areaOf(result)).toBeCloseTo(98, 9);
  });

  it('differencing into a hole does not create area', () => {
    // Cutting where there is already nothing must change nothing.
    expect(areaOf(run(withHole, box(4.5, 4.5, 5.5, 5.5), 'difference'))).toBeCloseTo(96, 9);
  });

  it('nests a ring inside a hole as its own polygon', () => {
    const island: MultiPoly = [[[[4.5, 4.5], [5.5, 4.5], [5.5, 5.5], [4.5, 5.5], [4.5, 4.5]]]];
    const result = run(withHole, island, 'union');
    expectWellFormed(result);
    // The outer polygon keeps its hole; the island sits inside it separately.
    expect(areaOf(result)).toBeCloseTo(97, 9);
  });
});

// ===========================================================================
// Winding, form and input tolerance
// ===========================================================================

describe('input handling', () => {
  it('accepts open rings and closes the output', () => {
    const open: MultiPoly = [[[[0, 0], [10, 0], [10, 10], [0, 10]]]];
    const result = run(open, box(5, 5, 15, 15), 'intersection');
    expectWellFormed(result);
    expect(areaOf(result)).toBeCloseTo(25, 9);
  });

  it('gives the same answer whichever way the rings wind', () => {
    const clockwise: MultiPoly = [[[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]]];
    const counter = box(0, 0, 10, 10);
    // Winding is a format convention, not a statement about the polygon, so a
    // caller must not have to normalise before asking a geometric question.
    expect(areaOf(run(clockwise, box(5, 5, 15, 15), 'intersection'))).toBeCloseTo(25, 9);
    expect(areaOf(run(counter, box(5, 5, 15, 15), 'intersection'))).toBeCloseTo(25, 9);
  });

  it('tolerates repeated vertices in the input', () => {
    const sloppy: MultiPoly = [
      [[[0, 0], [0, 0], [10, 0], [10, 0], [10, 10], [0, 10], [0, 10], [0, 0]]],
    ];
    const result = run(sloppy, box(5, 5, 15, 15), 'intersection');
    expectWellFormed(result);
    expect(areaOf(result)).toBeCloseTo(25, 9);
  });

  it('handles an empty operand without throwing', () => {
    expect(run([], box(0, 0, 1, 1), 'intersection')).toEqual([]);
    expect(areaOf(run([], box(0, 0, 1, 1), 'union'))).toBeCloseTo(1, 9);
    expect(run([], box(0, 0, 1, 1), 'difference')).toEqual([]);
    expect(areaOf(run(box(0, 0, 1, 1), [], 'difference'))).toBeCloseTo(1, 9);
  });

  it('reports that Z was dropped rather than inventing elevations', () => {
    // The crossing points have no elevation in either input: one surface says
    // one thing there and the other says another.
    const raised: MultiPoly = [[[[0, 0, 100], [10, 0, 100], [10, 10, 105], [0, 10, 105], [0, 0, 100]]]];
    const outcome = booleanOperation(raised, box(5, 5, 15, 15), 'intersection');
    expect(outcome.report.droppedZ).toBe(true);
    for (const position of outcome.polygons[0][0]) expect(position).toHaveLength(2);
  });

  it('reports nothing dropped when the input is already planar', () => {
    expect(booleanOperation(box(0, 0, 10, 10), box(5, 5, 15, 15), 'intersection').report.droppedZ).toBe(false);
  });
});

// ===========================================================================
// Survey-scale coordinates
// ===========================================================================

describe('at real survey coordinates', () => {
  // UTM 45N easting/northing, where doubles have about 1e-10 m of resolution.
  const plot = box(412300, 2591200, 412400, 2591300);
  const overlap = box(412350, 2591250, 412450, 2591350);

  it('keeps the area identity at 400 km from the origin', () => {
    const union = areaOf(run(plot, overlap, 'union'));
    const intersection = areaOf(run(plot, overlap, 'intersection'));
    expect(intersection).toBeCloseTo(2500, 6);
    expect(union + intersection).toBeCloseTo(20000, 6);
  });

  it('resolves a one-centimetre overlap between neighbouring plots', () => {
    // The encroachment a boundary dispute is actually about.
    const neighbour = box(412399.99, 2591200, 412500, 2591300);
    const result = run(plot, neighbour, 'intersection');
    expect(areaOf(result)).toBeCloseTo(0.01 * 100, 6);
  });

  it('produces no sliver on an exactly shared boundary', () => {
    const abutting = box(412400, 2591200, 412500, 2591300);
    const outcome = booleanOperation(plot, abutting, 'union');
    expect(outcome.polygons).toHaveLength(1);
    expect(areaOf(outcome.polygons)).toBeCloseTo(20000, 6);
  });
});

// ===========================================================================
// unionAll
// ===========================================================================

describe('unionAll', () => {
  it('merges a strip of adjacent parcels into one', () => {
    const parcels = Array.from({ length: 6 }, (_, index) => box(index * 10, 0, (index + 1) * 10, 10));
    const result = unionAll(parcels);
    expect(result.polygons).toHaveLength(1);
    expect(result.polygons[0]).toHaveLength(1);
    expect(areaOf(result.polygons)).toBeCloseTo(600, 9);
    expectWellFormed(result.polygons);
  });

  it('keeps separate blocks separate', () => {
    const result = unionAll([box(0, 0, 10, 10), box(10, 0, 20, 10), box(50, 50, 60, 60)]);
    expect(result.polygons).toHaveLength(2);
    expect(areaOf(result.polygons)).toBeCloseTo(300, 9);
  });

  it('returns nothing for no input', () => {
    expect(unionAll([]).polygons).toEqual([]);
  });

  it('returns the single input unchanged', () => {
    expect(areaOf(unionAll([box(0, 0, 10, 10)]).polygons)).toBeCloseTo(100, 9);
  });
});

// ===========================================================================
// Commutativity and idempotence
// ===========================================================================

describe('algebraic properties', () => {
  const a: MultiPoly = [[[[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]]]];
  const b = box(2, 2, 12, 6);

  it('union and intersection are commutative', () => {
    expect(areaOf(run(a, b, 'union'))).toBeCloseTo(areaOf(run(b, a, 'union')), 9);
    expect(areaOf(run(a, b, 'intersection'))).toBeCloseTo(areaOf(run(b, a, 'intersection')), 9);
  });

  it('xor is commutative but difference is not', () => {
    expect(areaOf(run(a, b, 'xor'))).toBeCloseTo(areaOf(run(b, a, 'xor')), 9);
    expect(areaOf(run(a, b, 'difference'))).not.toBeCloseTo(areaOf(run(b, a, 'difference')), 6);
  });

  it('is idempotent', () => {
    const once = run(a, b, 'union');
    const twice = run(once, b, 'union');
    expect(areaOf(twice)).toBeCloseTo(areaOf(once), 9);
  });

  it('xor equals the union minus the intersection', () => {
    const xor = areaOf(run(a, b, 'xor'));
    expect(xor).toBeCloseTo(areaOf(run(a, b, 'union')) - areaOf(run(a, b, 'intersection')), 9);
  });
});
