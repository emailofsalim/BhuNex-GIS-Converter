/**
 * The §24.2 repair operations, and the contract they had to inherit.
 *
 * `qa/repair.ts` shipped with six operations and a preview/apply/undo contract
 * that §24.2 said the rest would "inherit rather than reinvent". These are the
 * six that fit that contract without changing its shape: every one is a
 * per-feature rewrite, so `planRepair` previews it, `applyRepair` returns an
 * undo diff, and protected layers refuse it — none of which is re-implemented
 * here, which is the point.
 *
 *   simplify      Douglas-Peucker, iterative so a 400,000-vertex contour does
 *                 not blow the stack
 *   densify       splits long segments, interpolating Z
 *   smooth        Chaikin corner cutting
 *   regularise    pulls a footprint square IN ITS OWN FRAME, not the grid's
 *   remove-holes  drops holes at or under an area
 *   fill-holes    drops every hole
 *
 * WHAT IS DELIBERATELY NOT HERE. Snap-shared-edges, merge-adjacent-polygons
 * and rebuild-topology are CROSS-feature: they read one feature to decide what
 * happens to another, and `rewrite(feature, …)` cannot see a second feature.
 * Adding them means extending the contract, not adding a case to a switch, and
 * doing that badly is how a preview stops matching its apply. They stay listed
 * as open rather than half-built behind an API that cannot express them.
 */

import { describe, expect, it } from 'vitest';

import {
  applyRepair,
  planRepair,
  undoRepair,
  REPAIR_LABEL,
  SAFE_OPERATIONS,
  type RepairOperationId,
} from '../src/qa/repair';
import type { CirDataset } from '../src/core/cir';

function datasetOf(geometry: unknown, layerName = 'PARCELS'): CirDataset {
  return {
    layers: [{ name: layerName, features: [{ id: '1', geometry, properties: {} }] }],
  } as never;
}

/** A 20 m square with a staircase of tiny steps along its north edge. */
const NOISY_SQUARE = [
  [0, 0],
  [20, 0],
  [20, 20],
  [15, 20.01],
  [10, 19.99],
  [5, 20.01],
  [0, 20],
  [0, 0],
];

const SQUARE_WITH_HOLES = [
  [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
    [0, 0],
  ],
  // A 0.5 x 0.5 speck — digitising noise, area 0.25.
  [
    [10, 10],
    [10.5, 10],
    [10.5, 10.5],
    [10, 10.5],
    [10, 10],
  ],
  // A 20 x 20 courtyard — real, area 400.
  [
    [40, 40],
    [60, 40],
    [60, 60],
    [40, 60],
    [40, 40],
  ],
];

describe('simplify', () => {
  it('drops the staircase and keeps the corners', () => {
    const result = applyRepair(datasetOf({ type: 'Polygon', coordinates: [NOISY_SQUARE] }), 'simplify', {}, {
      simplifyTolerance: 0.5,
    });
    const ring = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][] }).coordinates[0];
    expect(ring.length).toBeLessThan(NOISY_SQUARE.length);
    // The four real corners survive; only the ±0.01 steps go.
    expect(ring.length).toBe(5);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('never takes a ring below the four positions that make it a ring', () => {
    // A triangle under an absurd tolerance still has to come back a triangle.
    const triangle = [[0, 0], [10, 0], [5, 8], [0, 0]];
    const plan = planRepair(datasetOf({ type: 'Polygon', coordinates: [triangle] }), 'simplify', {}, {
      simplifyTolerance: 1000,
    });
    const applied = applyRepair(datasetOf({ type: 'Polygon', coordinates: [triangle] }), 'simplify', {}, {
      simplifyTolerance: 1000,
    });
    const ring = (applied.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][] }).coordinates[0];
    expect(ring.length).toBeGreaterThanOrEqual(4);
    expect(plan.maxDisplacement).toBeGreaterThanOrEqual(0);
  });

  it('reports the band as the displacement bound, because that is what it is', () => {
    const plan = planRepair(datasetOf({ type: 'Polygon', coordinates: [NOISY_SQUARE] }), 'simplify', {}, {
      simplifyTolerance: 0.5,
    });
    expect(plan.maxDisplacement).toBe(0.5);
  });

  it('handles a long path iteratively rather than recursively', () => {
    // The recursive form overflows here. 60,000 vertices on a sine wave is an
    // ordinary contour, not a stress test.
    const long = Array.from({ length: 60_000 }, (_, index): [number, number] => [index * 0.1, Math.sin(index / 50)]);
    const result = applyRepair(datasetOf({ type: 'LineString', coordinates: long }), 'simplify', {}, {
      simplifyTolerance: 0.01,
    });
    const line = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][] }).coordinates;
    expect(line.length).toBeGreaterThan(1);
    expect(line.length).toBeLessThan(long.length);
  });
});

describe('densify', () => {
  it('splits a long segment and moves nothing', () => {
    const line = [[0, 0], [100, 0]];
    const plan = planRepair(datasetOf({ type: 'LineString', coordinates: line }), 'densify', {}, {
      densifyMaxSegment: 10,
    });
    expect(plan.maxDisplacement).toBe(0);

    const result = applyRepair(datasetOf({ type: 'LineString', coordinates: line }), 'densify', {}, {
      densifyMaxSegment: 10,
    });
    const dense = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][] }).coordinates;
    expect(dense.length).toBe(11);
    // Both originals are still there, exactly.
    expect(dense[0]).toEqual([0, 0]);
    expect(dense[dense.length - 1]).toEqual([100, 0]);
  });

  it('interpolates Z so a densified contour stays on its surface', () => {
    // Dropping Z here would silently flatten a contour onto z=0, which is worse
    // than not densifying at all.
    const line = [[0, 0, 100], [100, 0, 110]];
    const result = applyRepair(datasetOf({ type: 'LineString', coordinates: line }), 'densify', {}, {
      densifyMaxSegment: 50,
    });
    const dense = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][] }).coordinates;
    expect(dense).toHaveLength(3);
    expect(dense[1]).toEqual([50, 0, 105]);
  });

  it('leaves a path whose segments are already short enough', () => {
    const plan = planRepair(datasetOf({ type: 'LineString', coordinates: [[0, 0], [1, 0]] }), 'densify', {}, {
      densifyMaxSegment: 10,
    });
    expect(plan.changes).toHaveLength(0);
  });
});

describe('smooth', () => {
  it('cuts corners and keeps an open line anchored at both ends', () => {
    // A line's endpoints are usually where it meets something else, so they are
    // the two positions smoothing must not move.
    const line = [[0, 0], [10, 10], [20, 0]];
    const result = applyRepair(datasetOf({ type: 'LineString', coordinates: line }), 'smooth', {}, {
      smoothIterations: 1,
    });
    const smoothed = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][] }).coordinates;
    expect(smoothed[0]).toEqual([0, 0]);
    expect(smoothed[smoothed.length - 1]).toEqual([20, 0]);
    expect(smoothed.length).toBeGreaterThan(line.length);
  });

  it('keeps a ring closed', () => {
    const result = applyRepair(datasetOf({ type: 'Polygon', coordinates: [NOISY_SQUARE] }), 'smooth', {}, {
      smoothIterations: 2,
    });
    const ring = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][] }).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('states how far the boundary actually moved', () => {
    const plan = planRepair(datasetOf({ type: 'LineString', coordinates: [[0, 0], [10, 10], [20, 0]] }), 'smooth');
    expect(plan.maxDisplacement).toBeGreaterThan(0);
    expect(plan.changes[0].description).toMatch(/moves by up to/);
  });
});

describe('regularise', () => {
  it('squares a footprint that is off true north', () => {
    // THE POINT OF THE OWN-FRAME ROTATION. This square is rotated 30°, with one
    // corner knocked 0.3 m out. Squaring it to the GRID would rotate the whole
    // building; squaring it to its own longest edge fixes only the corner.
    const angle = (30 * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const corners: [number, number][] = [[0, 0], [20, 0], [20, 20], [0, 20]];
    const rotated = corners.map(([x, y]): [number, number] => [x * cos - y * sin, x * sin + y * cos]);
    rotated[2] = [rotated[2][0] + 0.3, rotated[2][1]];
    const ring = [...rotated, rotated[0]];

    const result = applyRepair(datasetOf({ type: 'Polygon', coordinates: [ring] }), 'regularise', {}, {
      regulariseAngleDegrees: 15,
    });
    const squared = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][] }).coordinates[0];

    // Nothing moved more than the error that was introduced.
    let largest = 0;
    for (let index = 0; index < ring.length; index++) {
      largest = Math.max(largest, Math.hypot(squared[index][0] - ring[index][0], squared[index][1] - ring[index][1]));
    }
    expect(largest).toBeLessThan(0.5);
    expect(squared[0]).toEqual(squared[squared.length - 1]);
  });

  it('leaves a genuine diagonal alone', () => {
    // A 45° wall is not an error, and pulling it square would be vandalism.
    const wedge = [[0, 0], [20, 0], [0, 20], [0, 0]];
    const plan = planRepair(datasetOf({ type: 'Polygon', coordinates: [wedge] }), 'regularise', {}, {
      regulariseAngleDegrees: 10,
    });
    expect(plan.maxDisplacement).toBeLessThan(1e-9);
  });

  it('does nothing to an open line, which has no corners to square', () => {
    const plan = planRepair(datasetOf({ type: 'LineString', coordinates: [[0, 0], [10, 0.5], [20, 0]] }), 'regularise');
    expect(plan.changes).toHaveLength(0);
  });
});

describe('hole operations', () => {
  it('removes the speck and keeps the courtyard', () => {
    const result = applyRepair(datasetOf({ type: 'Polygon', coordinates: SQUARE_WITH_HOLES }), 'remove-holes', {}, {
      maxHoleArea: 1,
    });
    const rings = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][] }).coordinates;
    expect(rings).toHaveLength(2);
    // The survivor is the 20x20 courtyard, not the 0.5x0.5 speck.
    expect(rings[1][0]).toEqual([40, 40]);
  });

  it('fill-holes takes every hole regardless of area', () => {
    const result = applyRepair(datasetOf({ type: 'Polygon', coordinates: SQUARE_WITH_HOLES }), 'fill-holes');
    const rings = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][] }).coordinates;
    expect(rings).toHaveLength(1);
  });

  it('never touches the exterior ring', () => {
    const result = applyRepair(datasetOf({ type: 'Polygon', coordinates: SQUARE_WITH_HOLES }), 'fill-holes');
    const rings = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][] }).coordinates;
    expect(rings[0]).toEqual(SQUARE_WITH_HOLES[0]);
  });

  it('reports no displacement, because filling a hole moves nothing', () => {
    const plan = planRepair(datasetOf({ type: 'Polygon', coordinates: SQUARE_WITH_HOLES }), 'fill-holes');
    expect(plan.maxDisplacement).toBe(0);
  });

  it('declines a line rather than reporting a change it did not make', () => {
    const plan = planRepair(datasetOf({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }), 'fill-holes');
    expect(plan.changes).toHaveLength(0);
  });

  it('handles a MultiPolygon, hole-by-hole', () => {
    const multi = { type: 'MultiPolygon', coordinates: [SQUARE_WITH_HOLES, SQUARE_WITH_HOLES] };
    const result = applyRepair(datasetOf(multi), 'fill-holes');
    const polygons = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][][] }).coordinates;
    expect(polygons).toHaveLength(2);
    expect(polygons[0]).toHaveLength(1);
    expect(polygons[1]).toHaveLength(1);
  });
});

describe('every new operation inherits the contract rather than reinventing it', () => {
  const ADDED: RepairOperationId[] = ['simplify', 'densify', 'smooth', 'regularise', 'remove-holes', 'fill-holes'];

  it('has a label, so the undo record and the UI can name it', () => {
    for (const operation of ADDED) {
      expect(REPAIR_LABEL[operation], `${operation} has no label`).toBeTruthy();
    }
  });

  it('previews without modifying, for all of them', () => {
    // The whole reason plan and apply share one rewrite function.
    for (const operation of ADDED) {
      const dataset = datasetOf({ type: 'Polygon', coordinates: SQUARE_WITH_HOLES });
      const before = JSON.stringify(dataset);
      planRepair(dataset, operation, {}, { simplifyTolerance: 1, densifyMaxSegment: 5, maxHoleArea: 1 });
      expect(JSON.stringify(dataset), `${operation} mutated the dataset while planning`).toBe(before);
    }
  });

  it('undoes exactly, for all of them', () => {
    for (const operation of ADDED) {
      const dataset = datasetOf({ type: 'Polygon', coordinates: SQUARE_WITH_HOLES });
      const result = applyRepair(dataset, operation, {}, {
        simplifyTolerance: 1,
        densifyMaxSegment: 5,
        maxHoleArea: 1,
        regulariseAngleDegrees: 20,
      });
      const restored = undoRepair(result.dataset, result.undo);
      expect(
        JSON.stringify(restored.layers[0].features[0].geometry),
        `${operation} did not undo exactly`
      ).toBe(JSON.stringify(dataset.layers[0].features[0].geometry));
    }
  });

  it('refuses a protected layer, for all of them', () => {
    // R18: a cadastral boundary is legally operative, and every operation added
    // here can move one. Refusal is reported and counted, never silent.
    for (const operation of ADDED) {
      const plan = planRepair(
        datasetOf({ type: 'Polygon', coordinates: SQUARE_WITH_HOLES }, 'CADASTRE'),
        operation,
        {},
        { protectedLayers: ['CADASTRE'], maxHoleArea: 1000 }
      );
      expect(plan.changes, `${operation} edited a protected layer`).toHaveLength(0);
      expect(plan.refused[0]?.layer).toBe('CADASTRE');
    }
  });

  it('keeps all of them out of "fix all safe issues"', () => {
    // Safe means reversible AND incapable of moving a boundary beyond a stated
    // tolerance. Simplify, smooth and regularise move boundaries by design;
    // the hole operations change area. Densify moves nothing, but it is not
    // fixing a defect — it is a preparation step, and sweeping it into an
    // automatic tidy-up would multiply vertex counts nobody asked to change.
    for (const operation of ADDED) {
      expect(SAFE_OPERATIONS, `${operation} is in the safe set`).not.toContain(operation);
    }
  });
});
