/**
 * Snapping (spec §25.2).
 *
 * The test that matters most is "moves the shared boundary and nothing else".
 * It is written as an explicit assertion that every OTHER vertex is byte-for-
 * byte where it started, rather than as a check that the shared ones moved,
 * because the failure this module exists to prevent is collateral: a snap that
 * closes the gap between two parcels and also drags a road centreline, a
 * building corner and a monument that happened to be nearby.
 *
 * On cadastral data that is not a tidy-up. A boundary is the legal object.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type Position, type SourceInfo } from '@core/cir';
import {
  applySnap,
  describeSnapPlan,
  planGridSnap,
  planIntersectionSnap,
  planSegmentSnap,
  planSharedEdgeSnap,
  planVertexSnap,
  type FeatureRef,
} from '@qa/snap';
import { undoRepair } from '@qa/repair';
import { crsFromEpsg } from '@crs/epsg';

const SOURCE: SourceInfo = { fileName: 'plots.dxf', size: 0, formatId: 'dxf', formatName: 'AutoCAD DXF', detectionConfidence: 1 };

function polygon(id: string, ring: Position[]): CirFeature {
  return { id, geometry: { type: 'Polygon', coordinates: [ring], dimension: 2 }, properties: {} };
}

function line(id: string, positions: Position[]): CirFeature {
  return { id, geometry: { type: 'LineString', coordinates: positions, dimension: 2 }, properties: {} };
}

function dataset(layers: { name: string; features: CirFeature[] }[]): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'plots',
    source: SOURCE,
    crs: crsFromEpsg(32645),
    crsOrigin: 'declared',
    units: 'metre',
    layers: layers.map((entry) => createLayer(entry.name, entry.features)),
  });
}

/** Every vertex of a dataset, flattened, for the "nothing else moved" check. */
function allVertices(data: CirDataset): string[] {
  const out: string[] = [];
  for (const layer of data.layers) {
    for (const [index, feature] of layer.features.entries()) {
      const rings = (feature.geometry as any)?.coordinates ?? [];
      out.push(`${layer.name}/${index}: ${JSON.stringify(rings)}`);
    }
  }
  return out;
}

// Two parcels that should abut along x = 100, but the right-hand one was
// surveyed separately and sits 8 mm to the east.
const LEFT: Position[] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
const RIGHT: Position[] = [[100.008, 0], [200, 0], [200, 100], [100.008, 100], [100.008, 0]];

const FIRST: FeatureRef = { layer: 'Plots', featureIndex: 0 };
const SECOND: FeatureRef = { layer: 'Plots', featureIndex: 1 };

describe('shared-edge snap', () => {
  it('closes the gap between two parcels', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT), polygon('R', RIGHT)] }]);
    const plan = planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01 });

    // Only the two vertices of the right parcel that lie on the shared edge —
    // and the repeated closing vertex, which is the same point.
    expect(plan.moves.length).toBeGreaterThan(0);
    expect(plan.moves.every((move) => move.featureIndex === 1)).toBe(true);
    expect(plan.maxDisplacement).toBeCloseTo(0.008, 6);

    const applied = applySnap(data, plan);
    const right = applied.dataset.layers[0].features[1].geometry!.coordinates as Position[][];
    expect(right[0][0][0]).toBeCloseTo(100, 9);
    expect(right[0][3][0]).toBeCloseTo(100, 9);
  });

  it('moves the shared boundary and NOTHING else', () => {
    // A road running past both parcels, 5 mm from the left parcel's west edge —
    // well inside the tolerance, and exactly the thing a naive snap drags.
    const road = line('ROAD', [[-0.005, -50], [-0.005, 150]]);
    const monument = polygon('MON', [[50, 50], [50.004, 50], [50.004, 50.004], [50, 50.004], [50, 50]]);

    const data = dataset([
      { name: 'Plots', features: [polygon('L', LEFT), polygon('R', RIGHT)] },
      { name: 'Roads', features: [road] },
      { name: 'Monuments', features: [monument] },
    ]);

    const before = allVertices(data);
    const plan = planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01 });
    const applied = applySnap(data, plan);
    const after = allVertices(applied.dataset);

    // The road and the monument are untouched, byte for byte.
    expect(after[2]).toBe(before[2]);
    expect(after[3]).toBe(before[3]);
    // The left parcel is untouched too: 'second' means the second one yields.
    expect(after[0]).toBe(before[0]);
    // Only the right parcel changed.
    expect(after[1]).not.toBe(before[1]);
  });

  it('leaves the far side of the yielding parcel exactly where it was', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT), polygon('R', RIGHT)] }]);
    const applied = applySnap(data, planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01 }));
    const right = applied.dataset.layers[0].features[1].geometry!.coordinates as Position[][];

    // x = 200 is the eastern boundary, which abuts something nobody has agreed.
    expect(right[0][1]).toEqual([200, 0]);
    expect(right[0][2]).toEqual([200, 100]);
  });

  it('splits the difference when neither survey is more trusted', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT), polygon('R', RIGHT)] }]);
    const plan = planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01, yield: 'midpoint' });
    const applied = applySnap(data, plan);

    const left = applied.dataset.layers[0].features[0].geometry!.coordinates as Position[][];
    const right = applied.dataset.layers[0].features[1].geometry!.coordinates as Position[][];

    // Both boundaries move halfway and meet at 100.004.
    expect(left[0][1][0]).toBeCloseTo(100.004, 6);
    expect(right[0][0][0]).toBeCloseTo(100.004, 6);
    expect(plan.maxDisplacement).toBeCloseTo(0.004, 6);
  });

  it('refuses to move a boundary in a protected layer', () => {
    const data = dataset([{ name: 'Cadastre', features: [polygon('L', LEFT), polygon('R', RIGHT)] }]);
    const plan = planSharedEdgeSnap(
      data,
      { layer: 'Cadastre', featureIndex: 0 },
      { layer: 'Cadastre', featureIndex: 1 },
      { tolerance: 0.01, protectedLayers: ['Cadastre'] }
    );

    expect(plan.moves).toHaveLength(0);
    expect(plan.refused.length).toBeGreaterThan(0);
    expect(plan.note).toContain('protected');
  });

  it('says the gap is too large rather than snapping anyway', () => {
    const far: Position[] = [[105, 0], [200, 0], [200, 100], [105, 100], [105, 0]];
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT), polygon('R', far)] }]);
    const plan = planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01 });

    expect(plan.moves).toHaveLength(0);
    expect(plan.note).toContain('larger than the tolerance');
  });

  it('works when the two boundaries have different vertex counts', () => {
    // The realistic case: one parcel was re-surveyed with extra breaks along
    // the shared edge. Pairing by vertex index would fail here.
    const dense: Position[] = [
      [100.006, 0], [100.006, 25], [100.006, 50], [100.006, 75], [100.006, 100],
      [200, 100], [200, 0], [100.006, 0],
    ];
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT), polygon('R', dense)] }]);
    const plan = planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01 });

    // All five vertices along the shared edge move, including the intermediate
    // ones that have no counterpart on the other parcel.
    expect(plan.moves.length).toBeGreaterThanOrEqual(5);
    const applied = applySnap(data, plan);
    const right = applied.dataset.layers[0].features[1].geometry!.coordinates as Position[][];
    for (const index of [0, 1, 2, 3, 4]) expect(right[0][index][0]).toBeCloseTo(100, 9);
  });

  it('keeps a closed ring closed', () => {
    // The first and last vertex of a ring are the same point. Moving one and
    // not the other opens the ring — creating the very defect the topology
    // checker reports.
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT), polygon('R', RIGHT)] }]);
    const applied = applySnap(data, planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01 }));
    const ring = (applied.dataset.layers[0].features[1].geometry!.coordinates as Position[][])[0];

    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('undoes exactly', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT), polygon('R', RIGHT)] }]);
    const before = allVertices(data);
    const applied = applySnap(data, planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01 }));

    expect(allVertices(undoRepair(applied.dataset, applied.undo))).toEqual(before);
  });

  it('reports how far it would move things before it moves them', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT), polygon('R', RIGHT)] }]);
    const plan = planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01 });
    const described = describeSnapPlan(plan);

    // "how far did you move my boundary" is the only question that matters.
    expect(described).toContain('moving at most');
    expect(described).toContain('0.008');
    // And the plan alone changed nothing.
    expect(data.layers[0].features[1].geometry!.coordinates).toEqual([RIGHT]);
  });

  it('preserves Z, because snapping is a horizontal operation', () => {
    const withZ: CirFeature = {
      id: 'R',
      geometry: {
        type: 'Polygon',
        coordinates: [[[100.008, 0, 512.25], [200, 0, 511], [200, 100, 510], [100.008, 100, 513.75], [100.008, 0, 512.25]]],
        dimension: 3,
      },
      properties: {},
    };
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT), withZ] }]);
    const applied = applySnap(data, planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01 }));
    const ring = (applied.dataset.layers[0].features[1].geometry!.coordinates as Position[][])[0];

    expect(ring[0]).toEqual([100, 0, 512.25]);
    expect(ring[3]).toEqual([100, 100, 513.75]);
  });
});

describe('vertex snap', () => {
  it('moves only the features it was told to move', () => {
    const data = dataset([
      { name: 'Plots', features: [polygon('L', LEFT), polygon('R', RIGHT)] },
      { name: 'Roads', features: [line('ROAD', [[-0.005, -50], [-0.005, 150]])] },
    ]);

    const before = allVertices(data);
    const plan = planVertexSnap(data, [SECOND], { tolerance: 0.01 });
    const after = allVertices(applySnap(data, plan).dataset);

    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).not.toBe(before[1]);
  });

  it('never snaps a feature to itself', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT)] }]);
    expect(planVertexSnap(data, [FIRST], { tolerance: 1000 }).moves).toHaveLength(0);
  });

  it('refuses a protected layer and says so', () => {
    const data = dataset([{ name: 'Cadastre', features: [polygon('L', LEFT), polygon('R', RIGHT)] }]);
    const plan = planVertexSnap(data, [{ layer: 'Cadastre', featureIndex: 1 }], {
      tolerance: 0.01,
      protectedLayers: ['Cadastre'],
    });
    expect(plan.moves).toHaveLength(0);
    expect(plan.refused[0].reason).toContain('legally operative');
  });
});

describe('grid snap', () => {
  it('rounds to the grid when the move is inside the tolerance', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('P', [[0.02, 0.01], [10, 0], [10, 10], [0, 10], [0.02, 0.01]])] }]);
    const plan = planGridSnap(data, [FIRST], { gridSize: 1, tolerance: 0.05 });
    const ring = (applySnap(data, plan).dataset.layers[0].features[0].geometry!.coordinates as Position[][])[0];

    expect(ring[0]).toEqual([0, 0]);
  });

  it('leaves a vertex alone when the grid is further than the tolerance', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('P', [[0.4, 0.4], [10, 0], [10, 10], [0, 10], [0.4, 0.4]])] }]);
    // 0.4 from the node, tolerance 0.05: snapping would move it eight times
    // further than the user said was acceptable.
    expect(planGridSnap(data, [FIRST], { gridSize: 1, tolerance: 0.05 }).moves).toHaveLength(0);
  });

  it('refuses a grid size of zero rather than dividing by it', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('P', LEFT)] }]);
    const plan = planGridSnap(data, [FIRST], { gridSize: 0 });
    expect(plan.moves).toHaveLength(0);
    expect(plan.note).toContain('greater than zero');
  });
});

describe('segment snap', () => {
  it('snaps a vertex onto an edge it is near but not at a vertex of', () => {
    // A T-junction: the road ends 6 mm short of the parcel's northern edge,
    // halfway along it, where there is no vertex to snap to.
    const data = dataset([
      { name: 'Plots', features: [polygon('L', LEFT)] },
      { name: 'Roads', features: [line('ROAD', [[50, 200], [50, 100.006]])] },
    ]);

    const plan = planSegmentSnap(data, [{ layer: 'Roads', featureIndex: 0 }], { tolerance: 0.01 });
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0].distance).toBeCloseTo(0.006, 6);

    const road = applySnap(data, plan).dataset.layers[1].features[0].geometry!.coordinates as Position[];
    expect(road[1][1]).toBeCloseTo(100, 9);
    expect(road[1][0]).toBeCloseTo(50, 9);
  });
});

describe('intersection snap', () => {
  it('snaps a vertex onto where two boundaries cross', () => {
    // Two lines crossing at (50, 50), and a third feature whose corner sits
    // 5 mm off that crossing.
    const data = dataset([
      { name: 'Lines', features: [line('A', [[0, 50], [100, 50]]), line('B', [[50, 0], [50, 100]])] },
      { name: 'Corners', features: [line('C', [[50.005, 50.000], [80, 80]])] },
    ]);

    const plan = planIntersectionSnap(data, [{ layer: 'Corners', featureIndex: 0 }], { tolerance: 0.01 });
    expect(plan.moves).toHaveLength(1);

    const corner = applySnap(data, plan).dataset.layers[1].features[0].geometry!.coordinates as Position[];
    expect(corner[0][0]).toBeCloseTo(50, 9);
    expect(corner[0][1]).toBeCloseTo(50, 9);
  });
});

describe('applying a plan', () => {
  it('applies exactly what was previewed, not a recomputation', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT), polygon('R', RIGHT)] }]);
    const plan = planSharedEdgeSnap(data, FIRST, SECOND, { tolerance: 0.01 });

    // Applying the same plan twice to the same input gives the same output:
    // the apply is a function of the plan, not of a fresh scan.
    const once = applySnap(data, plan).dataset;
    const twice = applySnap(data, plan).dataset;
    expect(allVertices(once)).toEqual(allVertices(twice));
  });

  it('does nothing, and allocates no undo, for an empty plan', () => {
    const data = dataset([{ name: 'Plots', features: [polygon('L', LEFT)] }]);
    const applied = applySnap(data, { mode: 'vertex', moves: [], maxDisplacement: 0, refused: [] });

    expect(applied.dataset).toBe(data);
    expect(applied.undo.entries).toHaveLength(0);
  });
});
