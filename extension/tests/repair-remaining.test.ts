/**
 * The last three §24.2 operations, and why each one was genuinely hard.
 *
 * These were recorded as unbuilt on purpose rather than half-built, and the
 * reasons recorded with them are the design of what is here now:
 *
 *   repair self-intersection  "a bowtie can be resolved by dropping the smaller
 *                             lobe or by splitting into two polygons, and those
 *                             are different answers to what the surveyor meant"
 *                             → so it is a CHOICE, defaulting to the one that
 *                               destroys nothing.
 *   remove slivers            "needs a thinness measure before it can have a
 *                             threshold worth exposing"
 *                             → the measure already existed in qa/defects.ts,
 *                               and is now SHARED rather than reinvented, so a
 *                               scan cannot report a defect the repair does not
 *                               recognise.
 *   extend and trim lines     "both need a TARGET, which is a second selection
 *                             the repair scope has no way to express"
 *                             → the survey case does not need one. The target is
 *                               whichever line the end is closest to within the
 *                               reach, which is exactly the question the dangle
 *                               detector already answers.
 *
 * WHAT THESE TESTS ARE FOR. Each operation has a failure mode that looks like
 * success: a decomposition that returns the ring unchanged, a sliver rule that
 * eats a road reserve, an extend that bends the line sideways instead of
 * carrying its bearing. Counting changes would pass all three. So every
 * assertion here is about the geometry that comes out.
 */

import { describe, expect, it } from 'vitest';

import {
  applyRepair,
  planRepair,
  undoRepair,
  CROSS_FEATURE_OPERATIONS,
  DEFAULT_REPAIR_SETTINGS,
  REPAIR_LABEL,
  SAFE_OPERATIONS,
} from '../src/qa/repair';
import type { CirDataset } from '../src/core/cir';

function polygon(...rings: number[][][]) {
  return { type: 'Polygon', coordinates: rings, dimension: 2 as const };
}
function line(path: number[][]) {
  return { type: 'LineString', coordinates: path, dimension: 2 as const };
}
function datasetOf(
  features: { id: string; geometry: unknown; properties?: Record<string, unknown> }[],
  layer = 'PARCELS'
): CirDataset {
  return { layers: [{ name: layer, features: features.map((f) => ({ properties: {}, ...f })) }] } as never;
}

const coordsOf = (dataset: CirDataset, index = 0): any =>
  (dataset.layers[0].features[index].geometry as never as { coordinates: unknown }).coordinates;
const typeOf = (dataset: CirDataset, index = 0): string =>
  (dataset.layers[0].features[index].geometry as never as { type: string }).type;

/** Shoelace, signed, so a bowtie's cancellation is visible. */
function signedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}
function absArea(ring: number[][]): number {
  return Math.abs(signedArea(ring));
}

/**
 * A figure-eight: two 10x10 lobes meeting at (10,10), wound opposite ways.
 *
 * The classic digitising slip — two vertices typed in the wrong order. Its
 * shoelace sum is ZERO, because the lobes cancel, which is exactly why every
 * area-based check downstream fails silently on it.
 */
const BOWTIE = [
  [0, 0],
  [10, 0],
  [0, 20],
  [10, 20],
  [0, 0],
];

describe('repair-self-intersection', () => {
  it('starts from a ring whose area really does cancel', () => {
    // If this ever stops being true the fixture has drifted and every
    // assertion below is testing something else.
    expect(Math.abs(signedArea(BOWTIE))).toBeLessThan(1e-9);
  });

  it('finds the crossing and splits the ring in two', () => {
    const result = applyRepair(
      datasetOf([{ id: 'A', geometry: polygon(BOWTIE) }]),
      'repair-self-intersection',
      {},
      { selfIntersectionMode: 'split' }
    );

    expect(typeOf(result.dataset)).toBe('MultiPolygon');
    const parts = coordsOf(result.dataset) as number[][][][];
    expect(parts.length).toBe(2);
    // Each lobe is a real triangle with real area, where the input had none.
    for (const part of parts) expect(absArea(part[0])).toBeGreaterThan(1);
  });

  it('loses no area when splitting', () => {
    // The whole reason 'split' is the default. Two 50-unit triangles meeting
    // at (5,10): the total is 100 whichever way it is read.
    const result = applyRepair(
      datasetOf([{ id: 'A', geometry: polygon(BOWTIE) }]),
      'repair-self-intersection',
      {},
      { selfIntersectionMode: 'split' }
    );
    const parts = coordsOf(result.dataset) as number[][][][];
    const total = parts.reduce((sum, part) => sum + absArea(part[0]), 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it('keeps only the largest lobe in the other mode, and says how much went', () => {
    // A ring with lobes of DIFFERENT sizes, so "largest" has something to
    // choose. The assertion compares the two modes against each other rather
    // than against a number worked out by hand: the claim is "it keeps the
    // biggest of the lobes it found", and only the split mode can say what
    // those were.
    // Lobes of 272.7 and 2.7 — the shape of a real digitising slip, where a
    // vertex typed one row out throws a hairline spur across the boundary of
    // an otherwise sound parcel. My first two attempts at this fixture came
    // out perfectly symmetric, which would have passed a "keeps one lobe"
    // test while proving nothing about WHICH.
    const lopsided = [
      [0, 0],
      [20, 0],
      [0, 30],
      [2, 30],
      [0, 0],
    ];

    const split = applyRepair(
      datasetOf([{ id: 'A', geometry: polygon(lopsided) }]),
      'repair-self-intersection',
      {},
      { selfIntersectionMode: 'split' }
    );
    const lobes = (coordsOf(split.dataset) as number[][][][]).map((part) => absArea(part[0]));
    expect(lobes.length).toBeGreaterThan(1);
    const biggest = Math.max(...lobes);
    const smallest = Math.min(...lobes);
    expect(biggest).toBeGreaterThan(smallest);

    const plan = planRepair(
      datasetOf([{ id: 'A', geometry: polygon(lopsided) }]),
      'repair-self-intersection',
      {},
      { selfIntersectionMode: 'largest' }
    );
    expect(plan.changes.length).toBe(1);
    expect(plan.changes[0].description).toContain('largest lobe');
    // It states the area it removes, because that is the number a surveyor
    // checks against a schedule.
    expect(plan.changes[0].description).toMatch(/sq units removed/);

    const kept = applyRepair(
      datasetOf([{ id: 'A', geometry: polygon(lopsided) }]),
      'repair-self-intersection',
      {},
      { selfIntersectionMode: 'largest' }
    );
    expect(typeOf(kept.dataset)).toBe('Polygon');
    expect(absArea((coordsOf(kept.dataset) as number[][][])[0])).toBeCloseTo(biggest, 6);
  });

  it('moves nothing — the crossing is already on both edges', () => {
    const plan = planRepair(
      datasetOf([{ id: 'A', geometry: polygon(BOWTIE) }]),
      'repair-self-intersection',
      {},
      {}
    );
    expect(plan.maxDisplacement).toBe(0);
  });

  it('leaves a simple ring completely alone', () => {
    // The commonest input by far. An operation that rewrote every polygon it
    // was pointed at would churn a whole layer to fix nothing.
    const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const plan = planRepair(datasetOf([{ id: 'A', geometry: polygon(square) }]), 'repair-self-intersection', {}, {});
    expect(plan.changes.length).toBe(0);
    expect(plan.maxDisplacement).toBe(0);
  });

  it('is idempotent: repairing the repair changes nothing', () => {
    const once = applyRepair(
      datasetOf([{ id: 'A', geometry: polygon(BOWTIE) }]),
      'repair-self-intersection',
      {},
      { selfIntersectionMode: 'split' }
    );
    const twice = planRepair(once.dataset, 'repair-self-intersection', {}, { selfIntersectionMode: 'split' });
    expect(twice.changes.length).toBe(0);
  });

  it('keeps holes on the polygon, not on the floor', () => {
    const outer = [[0, 0], [30, 0], [0, 40], [30, 40], [0, 0]];
    const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
    const result = applyRepair(
      datasetOf([{ id: 'A', geometry: polygon(outer, hole) }]),
      'repair-self-intersection',
      {},
      { selfIntersectionMode: 'split' }
    );
    const parts = coordsOf(result.dataset) as number[][][][];
    const holes = parts.reduce((sum, part) => sum + part.length - 1, 0);
    expect(holes).toBe(1);
  });

  it('undoes exactly', () => {
    const start = datasetOf([{ id: 'A', geometry: polygon(BOWTIE) }]);
    const result = applyRepair(start, 'repair-self-intersection', {}, { selfIntersectionMode: 'split' });
    const back = undoRepair(result.dataset, result.undo);
    expect(coordsOf(back)).toEqual([BOWTIE]);
  });
});

describe('remove-slivers', () => {
  /**
   * 100 long, 4 mm wide: area 0.4, thinness ~0.00013. Thin AND small — the
   * shaving left where two surveys of one boundary disagree by millimetres,
   * which is the thing this operation exists for.
   */
  const SLIVER = [[0, 0], [100, 0], [100, 0.004], [0, 0.004], [0, 0]];
  /**
   * 100 long, half a metre wide: thinness ~0.0155, so THIN by the measure —
   * and an area of 50, so nowhere near small. A drain or a footpath reserve,
   * entirely real, and exactly what the second test is there to protect.
   */
  const RESERVE = [[0, 0], [100, 0], [100, 0.5], [0, 0.5], [0, 0]];
  /** 0.5 x 0.5: small, and NOT thin. A garden plot. */
  const PLOT = [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5], [0, 0]];

  it('removes the shaving', () => {
    const result = applyRepair(
      datasetOf([
        { id: 'GOOD', geometry: polygon([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) },
        { id: 'SLIVER', geometry: polygon(SLIVER) },
      ]),
      'remove-slivers',
      {},
      {}
    );
    const ids = result.dataset.layers[0].features.map((feature: any) => feature.id);
    expect(ids).toEqual(['GOOD']);
  });

  it('keeps a road reserve: thin, but not small', () => {
    // Thinness alone would delete this, and it is entirely real. Both tests
    // exist precisely for it.
    const plan = planRepair(datasetOf([{ id: 'ROAD', geometry: polygon(RESERVE) }]), 'remove-slivers', {}, {});
    expect(plan.changes.length).toBe(0);
  });

  it('keeps a small plot: small, but not thin', () => {
    const plan = planRepair(datasetOf([{ id: 'PLOT', geometry: polygon(PLOT) }]), 'remove-slivers', {}, {});
    expect(plan.changes.length).toBe(0);
  });

  it('reports the area and the thinness it measured', () => {
    // A count alone ("3 slivers removed") is the same sentence whether it took
    // 6 cm² of noise or a parcel.
    const plan = planRepair(datasetOf([{ id: 'S', geometry: polygon(SLIVER) }]), 'remove-slivers', {}, {});
    expect(plan.changes[0].description).toMatch(/sq units/);
    expect(plan.changes[0].description).toMatch(/thinness/);
  });

  it('uses the same thinness measure the QA scan reports with', async () => {
    // If these two ever disagree, a scan reports a sliver the repair refuses to
    // see, and the user is told to fix something that cannot be fixed.
    const { DEFAULT_DEFECT_OPTIONS } = await import('../src/qa/defects');
    expect(DEFAULT_REPAIR_SETTINGS.sliverThinnessThreshold).toBe(DEFAULT_DEFECT_OPTIONS.sliverThinnessThreshold);
    expect(DEFAULT_REPAIR_SETTINGS.sliverMaxArea).toBe(DEFAULT_DEFECT_OPTIONS.sliverAreaThreshold);
  });

  it('drops a sliver PART and keeps the feature it hangs off', () => {
    const sound = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const multi = {
      type: 'MultiPolygon',
      coordinates: [[sound], [SLIVER]],
      dimension: 2 as const,
    };
    const result = applyRepair(datasetOf([{ id: 'A', geometry: multi }]), 'remove-slivers', {}, {});
    expect(result.dataset.layers[0].features.length).toBe(1);
    expect(typeOf(result.dataset)).toBe('Polygon');
    expect(absArea((coordsOf(result.dataset) as number[][][])[0])).toBeCloseTo(100, 6);
  });

  it('restores a deleted sliver exactly on undo', () => {
    // A geometry-only diff cannot reverse a deletion — there is no surviving
    // feature to restore geometry onto — which is why `UndoRecord` carries a
    // removed list.
    const start = datasetOf([
      { id: 'GOOD', geometry: polygon([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) },
      { id: 'SLIVER', geometry: polygon(SLIVER), properties: { khasra: '77/2' } },
    ]);
    const result = applyRepair(start, 'remove-slivers', {}, {});
    const back = undoRepair(result.dataset, result.undo);
    expect(back.layers[0].features.length).toBe(2);
    expect((back.layers[0].features[1] as any).id).toBe('SLIVER');
    expect((back.layers[0].features[1] as any).properties.khasra).toBe('77/2');
  });
});

describe('extend-trim-lines', () => {
  /** A north-south line for ends to meet. */
  const TARGET = [[10, -10], [10, 10]];

  it('extends an undershoot along its own bearing', () => {
    // 4 cm short of the target, running due east.
    const short = [[0, 0], [9.96, 0]];
    const result = applyRepair(
      datasetOf([
        { id: 'SHORT', geometry: line(short) },
        { id: 'TARGET', geometry: line(TARGET) },
      ]),
      'extend-trim-lines',
      {},
      { danglingTolerance: 0.25 }
    );

    const fixed = coordsOf(result.dataset) as number[][];
    expect(fixed[fixed.length - 1][0]).toBeCloseTo(10, 9);
    // ALONG THE BEARING, not sideways onto the nearest point. Here they agree
    // in y, which is the point: the end did not move off its own line.
    expect(fixed[fixed.length - 1][1]).toBeCloseTo(0, 9);
    // And the far end is untouched.
    expect(fixed[0]).toEqual([0, 0]);
  });

  it('does not bend the line when the target is oblique', () => {
    // THE DEFECT THIS GUARDS. Snapping the end to the nearest point on the
    // target would move it perpendicular to its own direction — which for a
    // traverse leg is a bearing error introduced by a "repair". Extending
    // along the bearing keeps the leg straight and lands where the two lines
    // actually meet.
    const oblique = [[-10, -10], [10, 10]]; // 45°, crosses x=5 at y=5
    const stub = [[0, 5], [4.9, 5]]; // due east, 10 cm short of the crossing
    const result = applyRepair(
      datasetOf([
        { id: 'STUB', geometry: line(stub) },
        { id: 'OBLIQUE', geometry: line(oblique) },
      ]),
      'extend-trim-lines',
      {},
      { danglingTolerance: 0.25 }
    );

    const fixed = coordsOf(result.dataset) as number[][];
    expect(fixed[1][1]).toBeCloseTo(5, 9); // y unchanged: the leg did not bend
    expect(fixed[1][0]).toBeCloseTo(5, 9); // and it reached the crossing
  });

  it('trims an overshoot back to the crossing', () => {
    // 5 cm past the target.
    const long = [[0, 0], [10.05, 0]];
    const result = applyRepair(
      datasetOf([
        { id: 'LONG', geometry: line(long) },
        { id: 'TARGET', geometry: line(TARGET) },
      ]),
      'extend-trim-lines',
      {},
      { danglingTolerance: 0.25 }
    );

    const fixed = coordsOf(result.dataset) as number[][];
    expect(fixed[fixed.length - 1][0]).toBeCloseTo(10, 9);
    expect(fixed[fixed.length - 1][1]).toBeCloseTo(0, 9);
  });

  it('leaves a genuine dangle where it was drawn', () => {
    // A line ending in open country is not a defect. Reaching further than the
    // tolerance would INVENT a junction rather than repair one.
    const far = [[0, 0], [5, 0]];
    const plan = planRepair(
      datasetOf([
        { id: 'FAR', geometry: line(far) },
        { id: 'TARGET', geometry: line(TARGET) },
      ]),
      'extend-trim-lines',
      {},
      { danglingTolerance: 0.25 }
    );
    expect(plan.changes.length).toBe(0);
  });

  it('leaves an end that already meets the target', () => {
    const exact = [[0, 0], [10, 0]];
    const plan = planRepair(
      datasetOf([
        { id: 'EXACT', geometry: line(exact) },
        { id: 'TARGET', geometry: line(TARGET) },
      ]),
      'extend-trim-lines',
      {},
      { danglingTolerance: 0.25 }
    );
    expect(plan.changes.length).toBe(0);
  });

  it('is idempotent, which is the same claim as the one above', () => {
    // Running it twice must be running it once. Without the "already
    // connected" test the second pass would find the end sitting exactly on
    // the target and have to decide all over again.
    const short = [[0, 0], [9.96, 0]];
    const once = applyRepair(
      datasetOf([
        { id: 'SHORT', geometry: line(short) },
        { id: 'TARGET', geometry: line(TARGET) },
      ]),
      'extend-trim-lines',
      {},
      { danglingTolerance: 0.25 }
    );
    const twice = planRepair(once.dataset, 'extend-trim-lines', {}, { danglingTolerance: 0.25 });
    expect(twice.changes.length).toBe(0);
  });

  it('never reaches further than the tolerance it was given', () => {
    const short = [[0, 0], [9.96, 0]];
    const plan = planRepair(
      datasetOf([
        { id: 'SHORT', geometry: line(short) },
        { id: 'TARGET', geometry: line(TARGET) },
      ]),
      'extend-trim-lines',
      {},
      { danglingTolerance: 0.25 }
    );
    expect(plan.maxDisplacement).toBeGreaterThan(0);
    expect(plan.maxDisplacement).toBeLessThanOrEqual(0.25);
  });

  it('ignores a line that only ever meets itself', () => {
    // One line in the layer has no target by definition, and an operation that
    // extended an end to its own other end would close a loop nobody asked for.
    const plan = planRepair(
      datasetOf([{ id: 'ONLY', geometry: line([[0, 0], [9.96, 0]]) }]),
      'extend-trim-lines',
      {},
      { danglingTolerance: 0.25 }
    );
    expect(plan.changes.length).toBe(0);
  });

  it('repairs a 4 cm undershoot ON THE SHIPPED DEFAULTS', () => {
    // THE DEFECT THIS PINS, found by driving the panel and not by the suite.
    //
    // "Already connected" used to be judged by `sharedEdgeTolerance`, which
    // ships at 0.05 against a reach of 0.25. So the commonest undershoot there
    // is — a few centimetres — was declared already connected and left alone,
    // and only gaps between 5 and 25 cm were ever repaired. On a real file the
    // operation looked broken.
    //
    // Every test above passed, because every one of them set both numbers
    // explicitly and never exercised what ships. They do not any more.
    const short = [[0, 0], [9.96, 0]];
    const plan = planRepair(
      datasetOf([
        { id: 'SHORT', geometry: line(short) },
        { id: 'TARGET', geometry: line(TARGET) },
      ]),
      'extend-trim-lines',
      {},
      {}
    );
    expect(plan.changes.length).toBe(1);
    expect(plan.maxDisplacement).toBeCloseTo(0.04, 6);
  });

  it('undoes exactly', () => {
    const short = [[0, 0], [9.96, 0]];
    const start = datasetOf([
      { id: 'SHORT', geometry: line(short) },
      { id: 'TARGET', geometry: line(TARGET) },
    ]);
    const result = applyRepair(start, 'extend-trim-lines', {}, { danglingTolerance: 0.25 });
    const back = undoRepair(result.dataset, result.undo);
    expect(coordsOf(back)).toEqual(short);
  });
});

describe('the three are registered like every other operation', () => {
  it('has a label for each', () => {
    // The panel builds its list from REPAIR_LABEL. An operation with no label
    // is an operation nobody can choose.
    expect(REPAIR_LABEL['repair-self-intersection']).toBeTruthy();
    expect(REPAIR_LABEL['remove-slivers']).toBeTruthy();
    expect(REPAIR_LABEL['extend-trim-lines']).toBeTruthy();
  });

  it('routes the two that need a neighbour through the cross-feature path', () => {
    expect(CROSS_FEATURE_OPERATIONS).toContain('remove-slivers');
    expect(CROSS_FEATURE_OPERATIONS).toContain('extend-trim-lines');
    // Self-intersection is NOT cross-feature: a ring crosses itself, which one
    // feature knows on its own.
    expect(CROSS_FEATURE_OPERATIONS).not.toContain('repair-self-intersection');
  });

  it('keeps all three out of "fix all safe issues"', () => {
    // Safe means it cannot move a boundary further than the tolerance and can
    // be undone exactly. Two of these DELETE, and the third changes how many
    // polygons a feature has. None of them runs unattended.
    expect(SAFE_OPERATIONS).not.toContain('repair-self-intersection');
    expect(SAFE_OPERATIONS).not.toContain('remove-slivers');
    expect(SAFE_OPERATIONS).not.toContain('extend-trim-lines');
  });

  it('refuses a protected layer, like every other operation', () => {
    // R18. A repair that moves a cadastral boundary is a change to a title.
    const plan = planRepair(
      datasetOf([{ id: 'A', geometry: polygon(BOWTIE) }], 'CADASTRE'),
      'repair-self-intersection',
      {},
      { protectedLayers: ['CADASTRE'] }
    );
    expect(plan.changes.length).toBe(0);
    expect(plan.refused.length).toBeGreaterThan(0);
  });
});
