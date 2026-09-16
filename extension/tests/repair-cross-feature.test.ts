/**
 * The §24.2 operations that could not be a per-feature rewrite.
 *
 * WHY THESE NEEDED A CONTRACT CHANGE RATHER THAN A SWITCH CASE
 *
 * `rewrite(feature, operation, settings)` sees one feature and nothing else.
 * That is correct for closing a ring or dropping a spike, and useless for any
 * operation whose answer depends on a NEIGHBOUR. The previous session left
 * these three listed as open for exactly that reason: half-building them behind
 * an API that cannot express them is how a preview stops matching its apply.
 *
 * `rewriteAcross` is the extension. It takes the whole dataset and is called
 * ONCE by `planRepair` and ONCE by `applyRepair`, which preserves the §24.1
 * guarantee — the preview is literally the apply, run without keeping the
 * result — without a second code path.
 *
 * WHAT EACH ONE ACTUALLY DOES
 *
 *   snap-shared-edges       collapses vertices of DIFFERENT features that sit
 *                           within the tolerance onto one node, at the mean of
 *                           the cluster
 *   rebuild-topology        that, plus inserting a node where a neighbour's
 *                           corner lands on the MIDDLE of this boundary — the
 *                           case snapping cannot reach, because the positions
 *                           already agree and there is nothing to move
 *   merge-adjacent-polygons unions polygons sharing an edge, and is the only
 *                           operation in the engine that DELETES a feature
 *
 * That last one is why `UndoRecord` grew a `removed` list. A geometry-only diff
 * cannot reverse a deletion: there is no surviving feature to restore geometry
 * onto. It is still a diff — three parcels merged costs two stored features,
 * not the four hundred thousand in the layer.
 */

import { describe, expect, it } from 'vitest';

import {
  applyRepair,
  planRepair,
  undoRepair,
  CROSS_FEATURE_OPERATIONS,
  REPAIR_LABEL,
  SAFE_OPERATIONS,
  type RepairOperationId,
} from '../src/qa/repair';
import type { CirDataset } from '../src/core/cir';

function polygon(ring: number[][]) {
  return { type: 'Polygon', coordinates: [ring], dimension: 2 as const };
}

function datasetOf(features: { id: string; geometry: unknown; properties?: Record<string, unknown> }[], layer = 'PARCELS'): CirDataset {
  return {
    layers: [{ name: layer, features: features.map((f) => ({ properties: {}, ...f })) }],
  } as never;
}

/**
 * Two 10 m squares that SHOULD share the edge x=10, digitised 3 cm apart —
 * the everyday result of two sheets captured separately.
 */
const LEFT = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const RIGHT = [[10.03, 0.03], [20, 0], [20, 10], [10.03, 9.97], [10.03, 0.03]];

describe('snap-shared-edges', () => {
  it('collapses the gap between two features onto one node', () => {
    const before = planRepair(datasetOf([
      { id: 'A', geometry: polygon(LEFT) },
      { id: 'B', geometry: polygon(RIGHT) },
    ]), 'snap-shared-edges', {}, { sharedEdgeTolerance: 0.05 });

    expect(before.changes.length).toBeGreaterThan(0);
    // Nothing moves further than the tolerance that authorised the move.
    expect(before.maxDisplacement).toBeLessThanOrEqual(0.05);
    expect(before.maxDisplacement).toBeGreaterThan(0);
  });

  it('puts the node at the MEAN, not at whichever feature came first', () => {
    // File order is an arbitrary authority to hand one parcel over its
    // neighbour, and it is not even stable — reordering the layer would change
    // the answer. The mean shares the correction.
    const result = applyRepair(datasetOf([
      { id: 'A', geometry: polygon(LEFT) },
      { id: 'B', geometry: polygon(RIGHT) },
    ]), 'snap-shared-edges', {}, { sharedEdgeTolerance: 0.05 });

    const a = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][] }).coordinates[0];
    const b = (result.dataset.layers[0].features[1].geometry as never as { coordinates: number[][][] }).coordinates[0];

    // A's (10,0) and B's (10.03,0.03) become the same point, and it is between.
    const aCorner = a.find((p) => Math.abs(p[1]) < 0.05 && p[0] > 9)!;
    const bCorner = b.find((p) => Math.abs(p[1]) < 0.05 && p[0] < 11)!;
    expect(aCorner[0]).toBeCloseTo(bCorner[0], 9);
    expect(aCorner[1]).toBeCloseTo(bCorner[1], 9);
    expect(aCorner[0]).toBeGreaterThan(10);
    expect(aCorner[0]).toBeLessThan(10.03);
  });

  it('leaves a lone feature alone — a shared node needs two owners', () => {
    // A cluster inside ONE feature is a duplicate vertex, which is a different
    // operation with a different tolerance.
    const plan = planRepair(datasetOf([{ id: 'A', geometry: polygon(LEFT) }]), 'snap-shared-edges', {}, {
      sharedEdgeTolerance: 5,
    });
    expect(plan.changes).toHaveLength(0);
  });

  it('does nothing when the features already agree exactly', () => {
    const shared = [[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]];
    const plan = planRepair(datasetOf([
      { id: 'A', geometry: polygon(LEFT) },
      { id: 'B', geometry: polygon(shared) },
    ]), 'snap-shared-edges', {}, { sharedEdgeTolerance: 0.05 });
    expect(plan.maxDisplacement).toBe(0);
  });
});

describe('rebuild-topology', () => {
  it('inserts the node snapping cannot reach', () => {
    // THE T-JUNCTION. B's corner sits exactly on the middle of A's right edge.
    // The positions already AGREE, so snapping has nothing to move — and yet A
    // has no vertex there, so every later overlay leaves a sliver.
    const a = polygon([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
    const b = polygon([[10, 5], [20, 5], [20, 10], [10, 10], [10, 5]]);

    const snap = planRepair(datasetOf([{ id: 'A', geometry: a }, { id: 'B', geometry: b }]), 'snap-shared-edges', {}, {
      sharedEdgeTolerance: 0.05,
    });
    expect(snap.maxDisplacement).toBe(0);

    const rebuilt = applyRepair(datasetOf([{ id: 'A', geometry: a }, { id: 'B', geometry: b }]), 'rebuild-topology', {}, {
      sharedEdgeTolerance: 0.05,
    });
    const ring = (rebuilt.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][] }).coordinates[0];
    // A now carries a vertex at (10,5).
    expect(ring.some((p) => Math.abs(p[0] - 10) < 1e-9 && Math.abs(p[1] - 5) < 1e-9)).toBe(true);
    expect(ring.length).toBeGreaterThan(5);
  });

  it('reports the insertion as moving nothing, because it does not', () => {
    const plan = planRepair(datasetOf([
      { id: 'A', geometry: polygon([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) },
      { id: 'B', geometry: polygon([[10, 5], [20, 5], [20, 10], [10, 10], [10, 5]]) },
    ]), 'rebuild-topology', {}, { sharedEdgeTolerance: 0.05 });
    expect(plan.maxDisplacement).toBe(0);
    expect(plan.changes.some((c) => /node/.test(c.description))).toBe(true);
  });

  it('does both halves: snaps the near-misses AND nodes the junctions', () => {
    const result = applyRepair(datasetOf([
      { id: 'A', geometry: polygon(LEFT) },
      { id: 'B', geometry: polygon(RIGHT) },
    ]), 'rebuild-topology', {}, { sharedEdgeTolerance: 0.05 });
    const a = (result.dataset.layers[0].features[0].geometry as never as { coordinates: number[][][] }).coordinates[0];
    const b = (result.dataset.layers[0].features[1].geometry as never as { coordinates: number[][][] }).coordinates[0];
    const corner = a.find((p) => Math.abs(p[1]) < 0.05 && p[0] > 9)!;
    expect(b.some((p) => Math.abs(p[0] - corner[0]) < 1e-9 && Math.abs(p[1] - corner[1]) < 1e-9)).toBe(true);
  });
});

describe('merge-adjacent-polygons', () => {
  const TOUCHING = [
    { id: 'A', geometry: polygon([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]), properties: { owner: 'Singh' } },
    { id: 'B', geometry: polygon([[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]), properties: { owner: 'Devi' } },
  ];

  it('unions two parcels sharing an edge into one feature', () => {
    const result = applyRepair(datasetOf(TOUCHING), 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    expect(result.dataset.layers[0].features).toHaveLength(1);
  });

  it('keeps the surviving feature\'s attributes and says the others are dropped', () => {
    // There is no defensible way to merge two owners into one field, so the
    // plan states what is lost rather than inventing a rule.
    const result = applyRepair(datasetOf(TOUCHING), 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    expect(result.dataset.layers[0].features[0].properties).toEqual({ owner: 'Singh' });
    expect(result.plan.changes[0].description).toMatch(/attributes dropped/);
  });

  it('merges parcels that are APART but within the tolerance', () => {
    // THE REGRESSION. The first version of this indexed raw bounds, so two
    // parcels digitised 3 cm apart — one ending at x=10, the next starting at
    // 10.03 — had bounds that did not intersect and never became a candidate
    // pair. The operation found nothing in exactly the case it exists for.
    //
    // Every test above passed, because their parcels share EXACT coordinates
    // and therefore have bounds that touch. It took driving the real panel to
    // see it. The bounds are grown by the tolerance now.
    const apart = [
      { id: 'A', geometry: polygon(LEFT) },
      { id: 'B', geometry: polygon(RIGHT) },
    ];
    const plan = planRepair(datasetOf(apart), 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    expect(plan.changes, 'parcels within the tolerance were not seen as adjacent').toHaveLength(1);

    const result = applyRepair(datasetOf(apart), 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    expect(result.dataset.layers[0].features).toHaveLength(1);
  });

  it('still leaves parcels further apart than the tolerance', () => {
    // The mirror of the above: growing the bounds must not make everything
    // adjacent to everything.
    const far = [
      { id: 'A', geometry: polygon([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) },
      { id: 'B', geometry: polygon([[11, 0], [21, 0], [21, 10], [11, 10], [11, 0]]) },
    ];
    const plan = planRepair(datasetOf(far), 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    expect(plan.changes).toHaveLength(0);
  });

  it('leaves polygons that only come close', () => {
    // Sharing ONE node is a corner touch, not an edge.
    const apart = [
      { id: 'A', geometry: polygon([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) },
      { id: 'B', geometry: polygon([[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]) },
    ];
    const plan = planRepair(datasetOf(apart), 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    expect(plan.changes).toHaveLength(0);
  });

  it('reports no displacement, because a union moves no surviving vertex', () => {
    const plan = planRepair(datasetOf(TOUCHING), 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    expect(plan.maxDisplacement).toBe(0);
  });

  it('merges a chain of three transitively', () => {
    const chain = [
      { id: 'A', geometry: polygon([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) },
      { id: 'B', geometry: polygon([[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]) },
      { id: 'C', geometry: polygon([[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]) },
    ];
    const result = applyRepair(datasetOf(chain), 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    // A-B and B-C are adjacent; A-C are not, but the union-find joins all three.
    expect(result.dataset.layers[0].features).toHaveLength(1);
  });

  it('ignores lines, which have no area to union', () => {
    const lines = [
      { id: 'A', geometry: { type: 'LineString', coordinates: [[0, 0], [10, 0]], dimension: 2 } },
      { id: 'B', geometry: { type: 'LineString', coordinates: [[10, 0], [20, 0]], dimension: 2 } },
    ];
    const plan = planRepair(datasetOf(lines), 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    expect(plan.changes).toHaveLength(0);
  });
});

describe('undo survives a deletion, which a geometry diff cannot', () => {
  it('restores merged-away features at the index they held', () => {
    const three = [
      { id: 'A', geometry: polygon([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]), properties: { n: 1 } },
      { id: 'B', geometry: polygon([[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]), properties: { n: 2 } },
      { id: 'C', geometry: polygon([[100, 100], [110, 100], [110, 110], [100, 110], [100, 100]]), properties: { n: 3 } },
    ];
    const dataset = datasetOf(three);
    const result = applyRepair(dataset, 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    expect(result.dataset.layers[0].features).toHaveLength(2);
    expect(result.undo.removed).toHaveLength(1);

    const restored = undoRepair(result.dataset, result.undo);
    expect(restored.layers[0].features).toHaveLength(3);
    // Order and identity are both back, not just the count.
    expect(restored.layers[0].features.map((f) => f.id)).toEqual(['A', 'B', 'C']);
    expect(JSON.stringify(restored.layers[0].features)).toBe(JSON.stringify(dataset.layers[0].features));
  });

  it('re-inserts several removals in the right places', () => {
    // Ascending order matters: each insert shifts the ones after it, so
    // replaying descending would misplace every removal past the first.
    const row = [
      { id: 'A', geometry: polygon([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]) },
      { id: 'B', geometry: polygon([[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]) },
      { id: 'C', geometry: polygon([[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]) },
      { id: 'D', geometry: polygon([[30, 0], [40, 0], [40, 10], [30, 10], [30, 0]]) },
    ];
    const dataset = datasetOf(row);
    const result = applyRepair(dataset, 'merge-adjacent-polygons', {}, { sharedEdgeTolerance: 0.05 });
    expect(result.undo.removed).toHaveLength(3);
    const restored = undoRepair(result.dataset, result.undo);
    expect(restored.layers[0].features.map((f) => f.id)).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('the cross-feature operations keep the contract they inherited', () => {
  const PAIR = [
    { id: 'A', geometry: polygon(LEFT) },
    { id: 'B', geometry: polygon(RIGHT) },
  ];

  it('previews without modifying, for all three', () => {
    for (const operation of CROSS_FEATURE_OPERATIONS) {
      const dataset = datasetOf(PAIR);
      const before = JSON.stringify(dataset);
      planRepair(dataset, operation, {}, { sharedEdgeTolerance: 0.05 });
      expect(JSON.stringify(dataset), `${operation} mutated the dataset while planning`).toBe(before);
    }
  });

  it('gives the plan and the apply the same answer, for all three', () => {
    // The whole reason both call `rewriteAcross` exactly once.
    for (const operation of CROSS_FEATURE_OPERATIONS) {
      const dataset = datasetOf(PAIR);
      const plan = planRepair(dataset, operation, {}, { sharedEdgeTolerance: 0.05 });
      const applied = applyRepair(dataset, operation, {}, { sharedEdgeTolerance: 0.05 });
      expect(applied.plan.changes.length, `${operation} previewed a different number of changes`).toBe(plan.changes.length);
      expect(applied.plan.maxDisplacement).toBe(plan.maxDisplacement);
    }
  });

  it('undoes exactly, for all three', () => {
    for (const operation of CROSS_FEATURE_OPERATIONS) {
      const dataset = datasetOf(PAIR);
      const result = applyRepair(dataset, operation, {}, { sharedEdgeTolerance: 0.05 });
      const restored = undoRepair(result.dataset, result.undo);
      expect(JSON.stringify(restored.layers), `${operation} did not undo exactly`).toBe(JSON.stringify(dataset.layers));
    }
  });

  it('refuses a protected layer, for all three', () => {
    // R18. Merging two cadastral parcels is a change to a title, and snapping
    // one onto its neighbour moves a legally operative boundary.
    for (const operation of CROSS_FEATURE_OPERATIONS) {
      const plan = planRepair(datasetOf(PAIR, 'CADASTRE'), operation, {}, {
        protectedLayers: ['CADASTRE'],
        sharedEdgeTolerance: 0.05,
      });
      expect(plan.changes, `${operation} edited a protected layer`).toHaveLength(0);
      expect(plan.refused[0]?.layer).toBe('CADASTRE');
    }
  });

  it('keeps all three out of "fix all safe issues"', () => {
    for (const operation of CROSS_FEATURE_OPERATIONS) {
      expect(SAFE_OPERATIONS, `${operation} is in the safe set`).not.toContain(operation);
    }
  });

  it('has a label for each, so the undo record and the UI can name it', () => {
    for (const operation of CROSS_FEATURE_OPERATIONS) {
      expect(REPAIR_LABEL[operation as RepairOperationId], `${operation} has no label`).toBeTruthy();
    }
  });
});
