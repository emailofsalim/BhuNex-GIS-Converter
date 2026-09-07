/**
 * The vertex editor (spec §25.1).
 *
 * A vertex editor is the most destructive tool in this application — everything
 * else converts, measures or reports, and this one changes the record. So most
 * of these tests are about what it REFUSES to do, and about the two ways a
 * hand-rolled editor silently corrupts a polygon layer:
 *
 *   1. Moving a closed ring's first vertex without its repeated last one, which
 *      opens the ring.
 *   2. Deleting past the minimum, which leaves something that still parses,
 *      still writes, and is not a polygon.
 *
 * Neither produces an error at the time. Both produce a bad delivery.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type Position, type SourceInfo } from '@core/cir';
import {
  applyEdit,
  describeEditPlan,
  planDeleteVertex,
  planInsertVertex,
  planMoveByBearing,
  planMoveMany,
  planMoveVertex,
  readVertex,
  type VertexRef,
} from '@core/vertex-edit';
import { undoRepair } from '@qa/repair';
import { crsFromEpsg } from '@crs/epsg';

const SOURCE: SourceInfo = { fileName: 'plots.dxf', size: 0, formatId: 'dxf', formatName: 'AutoCAD DXF', detectionConfidence: 1 };
const UTM = { crs: crsFromEpsg(32645), units: 'metre' };

function polygon(id: string, ring: Position[]): CirFeature {
  return { id, geometry: { type: 'Polygon', coordinates: [ring], dimension: ring[0].length >= 3 ? 3 : 2 }, properties: {} };
}

function line(id: string, positions: Position[]): CirFeature {
  return { id, geometry: { type: 'LineString', coordinates: positions, dimension: 2 }, properties: {} };
}

function dataset(features: CirFeature[], layerName = 'Plots'): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'plots',
    source: SOURCE,
    crs: crsFromEpsg(32645),
    crsOrigin: 'declared',
    units: 'metre',
    layers: [createLayer(layerName, features)],
  });
}

const SQUARE: Position[] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
const REF = (vertex: number): VertexRef => ({ layer: 'Plots', featureIndex: 0, ring: 0, vertex });

function ringOf(data: CirDataset, featureIndex = 0): Position[] {
  return (data.layers[0].features[featureIndex].geometry!.coordinates as Position[][])[0];
}

describe('moving a vertex', () => {
  it('moves it and reports how far', () => {
    const data = dataset([polygon('P', SQUARE)]);
    const plan = planMoveVertex(data, REF(1), [103, 4], { measure: UTM });

    expect(plan.changes).toHaveLength(1);
    expect(plan.maxDisplacement).toBeCloseTo(5, 9); // 3-4-5
    expect(describeEditPlan(plan)).toContain('moving at most 5.000');

    expect(ringOf(applyEdit(data, plan).dataset)[1]).toEqual([103, 4]);
  });

  it('keeps a closed ring closed when the endpoint moves', () => {
    // The failure this guards: moving vertex 0 without its stored duplicate at
    // the end leaves a ring that no longer closes — the exact defect
    // qa/topology.ts reports, created by the editor that was meant to fix them.
    const data = dataset([polygon('P', SQUARE)]);
    const applied = applyEdit(data, planMoveVertex(data, REF(0), [-5, -5], { measure: UTM }));
    const ring = ringOf(applied.dataset);

    expect(ring[0]).toEqual([-5, -5]);
    expect(ring[ring.length - 1]).toEqual([-5, -5]);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('moves both copies when the LAST vertex is the one dragged', () => {
    const data = dataset([polygon('P', SQUARE)]);
    const applied = applyEdit(data, planMoveVertex(data, REF(4), [-5, -5], { measure: UTM }));
    const ring = ringOf(applied.dataset);

    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring[0]).toEqual([-5, -5]);
  });

  it('keeps the existing Z when the drag supplies none', () => {
    // A plan-view drag is horizontal. Flattening a levelled point to zero
    // because the pointer had no third dimension would be a silent data loss.
    const data = dataset([polygon('P', [[0, 0, 512.25], [100, 0, 511], [100, 100, 510], [0, 0, 512.25]])]);
    const applied = applyEdit(data, planMoveVertex(data, REF(1), [105, 5], { measure: UTM }));

    expect(ringOf(applied.dataset)[1]).toEqual([105, 5, 511]);
  });

  it('accepts an explicit Z when the caller supplies one', () => {
    const data = dataset([polygon('P', [[0, 0, 512.25], [100, 0, 511], [100, 100, 510], [0, 0, 512.25]])]);
    const applied = applyEdit(data, planMoveVertex(data, REF(1), [105, 5, 499.5], { measure: UTM }));

    expect(ringOf(applied.dataset)[1]).toEqual([105, 5, 499.5]);
  });

  it('does nothing when the vertex is already there', () => {
    const data = dataset([polygon('P', SQUARE)]);
    const plan = planMoveVertex(data, REF(1), [100, 0], { measure: UTM });
    expect(plan.changes).toHaveLength(0);
    expect(applyEdit(data, plan).dataset).toBe(data);
  });

  it('refuses on a protected layer, with a reason', () => {
    const data = dataset([polygon('P', SQUARE)], 'Cadastre');
    const plan = planMoveVertex(data, { layer: 'Cadastre', featureIndex: 0, ring: 0, vertex: 1 }, [103, 4], {
      measure: UTM,
      protectedLayers: ['Cadastre'],
    });

    expect(plan.refusal).toBeDefined();
    expect(plan.refusal!.why).toContain('legally operative');
    expect(plan.changes).toHaveLength(0);
  });

  it('says so when the vertex does not exist rather than failing silently', () => {
    const data = dataset([polygon('P', SQUARE)]);
    expect(planMoveVertex(data, REF(99), [0, 0], { measure: UTM }).refusal!.what).toContain('could not be found');
  });
});

describe('moving by bearing and distance', () => {
  it('is how a survey correction actually arrives', () => {
    // "Move it 50 m due east" — planar in a projected CRS.
    const data = dataset([polygon('P', SQUARE)]);
    const applied = applyEdit(data, planMoveByBearing(data, REF(0), 90, 50, { measure: UTM }));

    const ring = ringOf(applied.dataset);
    expect(ring[0][0]).toBeCloseTo(50, 6);
    expect(ring[0][1]).toBeCloseTo(0, 6);
    // And the ring is still closed.
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });
});

describe('inserting a vertex', () => {
  it('projects the click onto the segment rather than using it as given', () => {
    // A click is never exactly on the line. Inserting where the pointer was
    // puts a kink in a boundary that was straight — invisible at the working
    // zoom, obvious in the delivered file.
    const data = dataset([polygon('P', SQUARE)]);
    const applied = applyEdit(data, planInsertVertex(data, REF(0), [50, 3.7], { measure: UTM }));
    const ring = ringOf(applied.dataset);

    expect(ring).toHaveLength(6);
    expect(ring[1]).toEqual([50, 0]); // on the segment, not at y = 3.7
  });

  it('interpolates Z rather than dropping the new vertex to zero', () => {
    // A new vertex on a graded haul road arriving at Z = 0 is a hole in the
    // surface.
    const data = dataset([polygon('P', [[0, 0, 100], [100, 0, 200], [100, 100, 150], [0, 0, 100]])]);
    const applied = applyEdit(data, planInsertVertex(data, REF(0), [50, 0], { measure: UTM }));

    expect(ringOf(applied.dataset)[1]).toEqual([50, 0, 150]);
  });

  it('clamps to the segment ends when the click is past them', () => {
    const data = dataset([polygon('P', SQUARE)]);
    const applied = applyEdit(data, planInsertVertex(data, REF(0), [500, 0], { measure: UTM }));
    expect(ringOf(applied.dataset)[1]).toEqual([100, 0]);
  });

  it('refuses on the last vertex, which starts no segment', () => {
    const data = dataset([polygon('P', SQUARE)]);
    const plan = planInsertVertex(data, REF(4), [50, 50], { measure: UTM });
    expect(plan.refusal!.action).toContain('START of the segment');
  });
});

describe('deleting a vertex', () => {
  it('deletes an ordinary vertex', () => {
    const pentagon: Position[] = [[0, 0], [100, 0], [100, 100], [50, 150], [0, 100], [0, 0]];
    const data = dataset([polygon('P', pentagon)]);
    const applied = applyEdit(data, planDeleteVertex(data, REF(3), { measure: UTM }));

    const ring = ringOf(applied.dataset);
    expect(ring).toHaveLength(5);
    expect(ring).not.toContainEqual([50, 150]);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('REFUSES to reduce a polygon below three corners', () => {
    // A triangle stores four positions; deleting one leaves two corners, which
    // is not a polygon. Most editors allow this and let the topology checker
    // complain later — by which time it is in a delivery.
    const triangle: Position[] = [[0, 0], [100, 0], [50, 100], [0, 0]];
    const data = dataset([polygon('T', triangle)]);
    const plan = planDeleteVertex(data, REF(1), { measure: UTM });

    expect(plan.refusal).toBeDefined();
    expect(plan.refusal!.why).toContain('at least three');
    expect(plan.changes).toHaveLength(0);
    // And applying the refused plan changes nothing.
    expect(applyEdit(data, plan).dataset).toBe(data);
  });

  it('REFUSES to reduce a line below two vertices', () => {
    const data = dataset([line('L', [[0, 0], [100, 0]])]);
    const plan = planDeleteVertex(data, REF(0), { measure: UTM });
    expect(plan.refusal!.why).toContain('at least two');
  });

  it('keeps the ring closed when the deleted vertex is the endpoint', () => {
    // Removing the first vertex means the second becomes the new start, and the
    // closing copy has to follow it.
    const pentagon: Position[] = [[0, 0], [100, 0], [100, 100], [50, 150], [0, 100], [0, 0]];
    const data = dataset([polygon('P', pentagon)]);
    const applied = applyEdit(data, planDeleteVertex(data, REF(0), { measure: UTM }));
    const ring = ringOf(applied.dataset);

    expect(ring[0]).toEqual([100, 0]);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring).toHaveLength(5);
  });
});

describe('multi-select drag', () => {
  it('moves every selected vertex by the same offset, as one action', () => {
    const data = dataset([polygon('P', SQUARE)]);
    const plan = planMoveMany(data, [REF(1), REF(2)], { dx: 10, dy: 0 }, { measure: UTM });

    expect(plan.changes).toHaveLength(2);
    expect(plan.maxDisplacement).toBeCloseTo(10, 9);

    const ring = ringOf(applyEdit(data, plan).dataset);
    expect(ring[1]).toEqual([110, 0]);
    expect(ring[2]).toEqual([110, 100]);
    expect(ring[0]).toEqual([0, 0]); // untouched
  });

  it('undoes the whole drag in one step', () => {
    const data = dataset([polygon('P', SQUARE)]);
    const applied = applyEdit(data, planMoveMany(data, [REF(1), REF(2)], { dx: 10, dy: 5 }, { measure: UTM }));

    expect(ringOf(undoRepair(applied.dataset, applied.undo))).toEqual(SQUARE);
  });

  it('refuses the whole drag when any selected layer is protected', () => {
    const data = dataset([polygon('P', SQUARE)], 'Cadastre');
    const plan = planMoveMany(
      data,
      [{ layer: 'Cadastre', featureIndex: 0, ring: 0, vertex: 1 }],
      { dx: 10, dy: 0 },
      { measure: UTM, protectedLayers: ['Cadastre'] }
    );
    expect(plan.refusal).toBeDefined();
  });
});

describe('applying edits', () => {
  it('deletes from the highest index down, so indices do not shift underneath', () => {
    // The classic off-by-one: deleting vertex 1 first renumbers vertex 3, and
    // the second delete then removes the wrong corner.
    const hexagon: Position[] = [[0, 0], [50, -20], [100, 0], [100, 100], [50, 120], [0, 100], [0, 0]];
    const data = dataset([polygon('H', hexagon)]);

    const first = applyEdit(data, planDeleteVertex(data, REF(4), { measure: UTM }));
    const second = applyEdit(first.dataset, planDeleteVertex(first.dataset, REF(1), { measure: UTM }));
    const ring = ringOf(second.dataset);

    // Exactly the two intended corners are gone, and no others.
    expect(ring).not.toContainEqual([50, -20]);
    expect(ring).not.toContainEqual([50, 120]);
    expect(ring).toContainEqual([100, 0]);
    expect(ring).toContainEqual([0, 100]);
  });

  it('undoes exactly', () => {
    const data = dataset([polygon('P', SQUARE)]);
    const applied = applyEdit(data, planMoveVertex(data, REF(2), [123.456, 78.9], { measure: UTM }));
    expect(ringOf(undoRepair(applied.dataset, applied.undo))).toEqual(SQUARE);
  });
});

describe('the live readout', () => {
  it('reports position, both segments and the feature totals', () => {
    const data = dataset([polygon('P', SQUARE)]);
    const readout = readVertex(data, REF(1), { measure: UTM })!;

    expect(readout.x).toBe(100);
    expect(readout.y).toBe(0);
    expect(readout.fromPrevious!.length.value).toBeCloseTo(100, 9);
    expect(readout.fromPrevious!.bearing.value).toBeCloseTo(90, 9); // due east
    expect(readout.toNext!.length.value).toBeCloseTo(100, 9);
    expect(readout.toNext!.bearing.value).toBeCloseTo(0, 9); // due north
    expect(readout.area!.value).toBeCloseTo(10000, 6);
    expect(readout.perimeter!.value).toBeCloseTo(400, 6);
  });

  it('wraps around a closed ring instead of reporting a zero-length segment', () => {
    // The neighbour of vertex 0 is the second-to-last vertex, not the duplicate
    // stored at the end — which would report length 0 and a meaningless bearing.
    const data = dataset([polygon('P', SQUARE)]);
    const readout = readVertex(data, REF(0), { measure: UTM })!;

    expect(readout.isRingEndpoint).toBe(true);
    expect(readout.fromPrevious!.length.value).toBeCloseTo(100, 9);
    expect(readout.fromPrevious!.length.value).not.toBe(0);
  });

  it('measures geodesically on a geographic CRS', () => {
    // Without this the readout would be the most confidently wrong panel in the
    // application: a segment across one degree reported as "1".
    const geo = createDataset({
      kind: 'vector',
      name: 'plots',
      source: SOURCE,
      crs: crsFromEpsg(4326),
      crsOrigin: 'declared',
      layers: [createLayer('Plots', [polygon('P', [[77, 23], [78, 23], [78, 24], [77, 23]])])],
    });

    const readout = readVertex(geo, REF(1), { measure: { crs: crsFromEpsg(4326) } })!;
    expect(readout.fromPrevious!.length.unit).toBe('m');
    expect(readout.fromPrevious!.length.value).toBeCloseTo(102522.5, 0);
    expect(readout.fromPrevious!.length.method).toBe('geodesic');
  });

  it('reports no CRS as raw units rather than implying metres', () => {
    const bare = createDataset({
      kind: 'vector',
      name: 'plots',
      source: SOURCE,
      crs: null,
      crsOrigin: 'unknown',
      layers: [createLayer('Plots', [polygon('P', SQUARE)])],
    });

    const readout = readVertex(bare, REF(1), { measure: { crs: null } })!;
    expect(readout.fromPrevious!.length.unit).toBe('units');
    expect(readout.fromPrevious!.length.caveat).toContain('No CRS is declared');
  });

  it('returns null for a vertex that does not exist', () => {
    const data = dataset([polygon('P', SQUARE)]);
    expect(readVertex(data, REF(99), { measure: UTM })).toBeNull();
  });
});
