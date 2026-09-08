/**
 * Scaling benchmarks (architecture spec RULE 31, §25).
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE MEASURE, AND WHAT THEY DELIBERATELY DO NOT
 *
 * They measure SCALING — how the cost grows as the input grows — and not
 * absolute milliseconds.
 *
 * An absolute number from a CI runner is close to meaningless: it depends on
 * the machine, the other jobs on it, and the JIT's mood. Asserting one turns a
 * shared runner having a busy minute into a failed build, and the usual response
 * to that is to loosen the threshold until it never fails and never means
 * anything either.
 *
 * A scaling exponent is a property of the ALGORITHM. Doubling the input and
 * seeing the time roughly double is O(n); seeing it quadruple is O(n²). That
 * holds on a slow runner and a fast laptop alike, and it is the thing worth
 * knowing: the specification's §25 says measure before optimising, and this is
 * what there is to measure.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE THREE
 *
 * `docs/ARCHITECTURE_CONFORMANCE.md` named two known suspects, and both are
 * here rather than guessed at:
 *
 *   - `StatusLine` in the boolean core is a sorted ARRAY. Insertion is O(n) by
 *     `splice`, so the sweep is O(n²) in the worst case. A balanced tree would
 *     be O(n log n) and is the right change IF a real dataset makes this the
 *     bottleneck — which is exactly what these numbers are for.
 *   - The buffer folds its pieces with `unionAll`, pairwise. Each fold unions a
 *     growing accumulated shape against one more small piece, which is
 *     quadratic in the piece count if the accumulated shape grows.
 *
 * Run with `npm run bench`. Not part of `npm test`: a timing run on a shared CI
 * runner is noise, and a suite that is noisy stops being read.
 */

import { bench, describe } from 'vitest';
import { booleanOperation, unionAll, type MultiPoly } from '@core/polygon-boolean';
import { bufferGeometry } from '@core/buffer';
import { convexHull } from '@core/geometry-ops';
import type { CirGeometry, Position } from '@core/cir';

// --------------------------------------------------------------- fixtures

/** `count` square parcels in a row, each sharing an edge with the next. */
function parcelStrip(count: number): MultiPoly[] {
  return Array.from({ length: count }, (_, index) => [
    [
      [
        [index * 10, 0],
        [(index + 1) * 10, 0],
        [(index + 1) * 10, 10],
        [index * 10, 10],
        [index * 10, 0],
      ] as Position[],
    ],
  ]);
}

/** A ring with `count` vertices, so the sweep sees a long boundary. */
function circle(count: number, radius = 1000): MultiPoly {
  const ring: Position[] = [];
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2;
    ring.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  ring.push(ring[0].slice());
  return [[ring]];
}

/** A polyline with `count` vertices, as a survey traverse would be. */
function traverse(count: number): CirGeometry {
  const positions: Position[] = [];
  for (let index = 0; index < count; index++) {
    positions.push([index * 5, Math.sin(index / 4) * 20]);
  }
  return { type: 'LineString', coordinates: positions, dimension: 2 };
}

function scatter(count: number): Position[] {
  // Deterministic, so two runs measure the same work.
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: count }, () => [next() * 10000, next() * 10000] as Position);
}

// ===========================================================================
// The boolean sweep — StatusLine is a sorted array, O(n) per insert
// ===========================================================================

describe('boolean sweep, by boundary size', () => {
  const a256 = circle(256);
  const a512 = circle(512);
  const a1024 = circle(1024);
  const offset = (polygons: MultiPoly, by: number): MultiPoly =>
    polygons.map((rings) => rings.map((ring) => ring.map(([x, y]) => [x + by, y] as Position)));

  bench('union, 256-vertex rings', () => {
    booleanOperation(a256, offset(a256, 500), 'union');
  });

  bench('union, 512-vertex rings', () => {
    booleanOperation(a512, offset(a512, 500), 'union');
  });

  bench('union, 1024-vertex rings', () => {
    booleanOperation(a1024, offset(a1024, 500), 'union');
  });

  bench('intersection, 1024-vertex rings', () => {
    booleanOperation(a1024, offset(a1024, 500), 'intersection');
  });
});

// ===========================================================================
// unionAll — pairwise folding, the buffer's inner loop
// ===========================================================================

describe('unionAll, by piece count', () => {
  const strip32 = parcelStrip(32);
  const strip64 = parcelStrip(64);
  const strip128 = parcelStrip(128);

  bench('dissolve 32 adjacent parcels', () => {
    unionAll(strip32);
  });

  bench('dissolve 64 adjacent parcels', () => {
    unionAll(strip64);
  });

  bench('dissolve 128 adjacent parcels', () => {
    unionAll(strip128);
  });
});

// ===========================================================================
// Buffer — one capsule per segment, then folded
// ===========================================================================

describe('buffer, by vertex count', () => {
  const t64 = traverse(64);
  const t128 = traverse(128);
  const t256 = traverse(256);

  bench('buffer a 64-vertex traverse', () => {
    bufferGeometry(t64, 15, { tolerance: 0.05 });
  });

  bench('buffer a 128-vertex traverse', () => {
    bufferGeometry(t128, 15, { tolerance: 0.05 });
  });

  bench('buffer a 256-vertex traverse', () => {
    bufferGeometry(t256, 15, { tolerance: 0.05 });
  });

  bench('buffer at a finer tolerance (more arc vertices)', () => {
    bufferGeometry(t128, 15, { tolerance: 0.001 });
  });
});

// ===========================================================================
// A control: an operation that is provably O(n log n)
// ===========================================================================

describe('convex hull, by point count', () => {
  const p10k = scatter(10_000);
  const p20k = scatter(20_000);
  const p40k = scatter(40_000);

  // Andrew's monotone chain is O(n log n), dominated by the sort. These three
  // are the reference against which the sweep numbers above are read: if the
  // hull scales cleanly on a runner and the boolean does not, the difference is
  // the algorithm rather than the machine.
  bench('hull of 10,000 points', () => {
    convexHull(p10k);
  });

  bench('hull of 20,000 points', () => {
    convexHull(p20k);
  });

  bench('hull of 40,000 points', () => {
    convexHull(p40k);
  });
});
