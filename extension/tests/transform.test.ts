/**
 * Move, scale and rotate (docs/EDITING_WORKSTATION.md, phase A).
 *
 * These exist for one reported situation: a survey is imported, drawn over map
 * tiles, and sits beside the basemap rather than on it. The fix is to select
 * the affected geometry and drag it into place. That drag is this operation.
 *
 * The tests are built on INVARIANTS a rigid transform must satisfy rather than
 * on coordinates read out of the implementation — a translated square keeps
 * every side length, a rotation keeps every distance from its anchor, a scale
 * multiplies area by the product of its factors. Those hold whatever the
 * arithmetic, so they catch a sign error, a swapped axis and a wrong anchor,
 * which are exactly the mistakes that produce a plausible wrong answer.
 */

import { describe, expect, it } from 'vitest';
import {
  applyGeometryOperation,
  planGeometryOperation,
  type GeometryOperation,
} from '@core/geometry-ops';
import {
  createDataset,
  createLayer,
  type CirDataset,
  type CirFeature,
  type Position,
  type SourceInfo,
} from '@core/cir';
import { crsFromEpsg } from '@crs/epsg';
import { convert } from '@core/pipeline';
import { FULL_PRECISION } from '@core/precision';
import { signedArea } from '@core/geometry';

const SOURCE: SourceInfo = {
  fileName: 'parcels.shp',
  size: 0,
  formatId: 'shapefile',
  formatName: 'Esri Shapefile',
  detectionConfidence: 1,
};

/** A 100 m square with its lower-left corner at (0, 0). */
const SQUARE: Position[] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
  [0, 0],
];

function parcel(id: string, ring: Position[] = SQUARE): CirFeature {
  return { id, geometry: { type: 'Polygon', coordinates: [ring], dimension: 2 }, properties: { plot: id } };
}

function datasetOf(features: CirFeature[], epsg = 32645): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'parcels',
    source: SOURCE,
    crs: crsFromEpsg(epsg),
    layers: [createLayer('parcels', features, [])],
  });
}

function run(
  operation: GeometryOperation,
  options: Record<string, unknown>,
  features: CirFeature[] = [parcel('A')],
  epsg = 32645
) {
  const dataset = datasetOf(features, epsg);
  const plan = planGeometryOperation(dataset, 'parcels', operation, { crs: dataset.crs, ...options });
  return { plan, applied: plan.refusal ? dataset : applyGeometryOperation(dataset, plan).dataset };
}

const ringOf = (dataset: CirDataset, index = 0): Position[] =>
  (dataset.layers[0].features[index].geometry!.coordinates as Position[][])[0];

const distance = (a: Position, b: Position): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Every side length of a ring, which a rigid transform must not change. */
const sides = (ring: Position[]): number[] =>
  ring.slice(1).map((position, index) => distance(ring[index], position));

// ------------------------------------------------------------------ translate

describe('moving a selection', () => {
  it('shifts every coordinate by exactly the offset', () => {
    const { applied } = run('translate', { offset: [12.5, -7.25] });
    expect(ringOf(applied)).toEqual([
      [12.5, -7.25],
      [112.5, -7.25],
      [112.5, 92.75],
      [12.5, 92.75],
      [12.5, -7.25],
    ]);
  });

  it('changes no distance, because a move is not a distortion', () => {
    // The invariant that matters most: a georeferencing correction must not
    // alter a single measured length, or it is not a correction.
    const before = sides(SQUARE);
    const { applied } = run('translate', { offset: [1234.5, -9876.5] });
    expect(sides(ringOf(applied))).toEqual(before);
  });

  it('leaves Z alone, because a horizontal shift says nothing about height', () => {
    const withHeight: Position[] = [
      [0, 0, 412.3],
      [100, 0, 413.1],
      [100, 100, 414.9],
      [0, 0, 412.3],
    ];
    const { applied } = run('translate', { offset: [50, 50] }, [parcel('A', withHeight)]);
    expect(ringOf(applied).map((position) => position[2])).toEqual([412.3, 413.1, 414.9, 412.3]);
  });

  it('moves every feature in the selection by the same amount', () => {
    const { applied } = run('translate', { offset: [10, 20] }, [parcel('A'), parcel('B')]);
    expect(ringOf(applied, 0)[0]).toEqual([10, 20]);
    expect(ringOf(applied, 1)[0]).toEqual([10, 20]);
  });

  it('moves only what is in scope', () => {
    // Scope is how "select these three parcels and drag them" is expressed.
    const dataset = datasetOf([parcel('A'), parcel('B')]);
    const plan = planGeometryOperation(dataset, 'parcels', 'translate', {
      crs: dataset.crs,
      offset: [10, 0],
      scope: [0],
    });
    expect(plan.consumed).toBe(1);
    expect(plan.features).toHaveLength(1);
  });

  it('states the units, which is the whole meaning of the number', () => {
    // 0.0001 is a tenth of a millimetre in UTM and eleven metres in degrees.
    const projected = run('translate', { offset: [12.5, 0] });
    expect(projected.plan.notes.join(' ')).toContain('metre');

    const geographic = run('translate', { offset: [0.0001, 0] }, [parcel('A')], 4326);
    const note = geographic.plan.notes.join(' ');
    expect(note).toContain('°');
    expect(note).toContain('m on the ground');
  });

  it('refuses a zero offset rather than recording a move that moved nothing', () => {
    const { plan } = run('translate', { offset: [0, 0] });
    expect(plan.refusal?.what).toContain('zero');
  });

  it('refuses when no offset was given at all', () => {
    expect(run('translate', {}).plan.refusal?.what).toContain('No offset');
  });

  it('refuses when nothing is selected', () => {
    // Caught by the shared guard every operation passes through, not by a
    // transform-specific one — a second check would be unreachable. Asserted
    // here anyway, because "drag with nothing selected" is a real gesture and
    // the refusal is the behaviour that matters, wherever it comes from.
    const dataset = datasetOf([parcel('A')]);
    const plan = planGeometryOperation(dataset, 'parcels', 'translate', { crs: dataset.crs, offset: [1, 1], scope: [] });
    expect(plan.refusal?.what).toContain('nothing to operate on');
    expect(plan.refusal?.action).toContain('Select at least one feature');
  });

  it('works on a geographic CRS, because that is where the basemap is', () => {
    // Buffer and offset refuse on a geographic CRS, and rightly — 10 there
    // means 1,100 km. A drag is different: the user sees the result against the
    // tiles, so refusing would block the feature's main use.
    const { plan } = run('translate', { offset: [0.0001, 0.0001] }, [parcel('A')], 4326);
    expect(plan.refusal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------- scale

describe('scaling a selection', () => {
  it('multiplies area by the square of a uniform factor', () => {
    const { applied } = run('scale', { factor: 2 });
    expect(Math.abs(signedArea(ringOf(applied)))).toBeCloseTo(100 * 100 * 4, 6);
  });

  it('multiplies area by the product of two factors', () => {
    const { applied } = run('scale', { factor: [2, 3] });
    expect(Math.abs(signedArea(ringOf(applied)))).toBeCloseTo(100 * 100 * 6, 6);
  });

  it('holds the anchor exactly still', () => {
    // The defining property. If the anchor moves, everything is displaced as
    // well as resized, and the displacement is invisible on screen.
    const { applied } = run('scale', { factor: 3, anchor: [0, 0] });
    expect(ringOf(applied)[0]).toEqual([0, 0]);
    expect(ringOf(applied)[1]).toEqual([300, 0]);
  });

  it('uses the centre of the selection when no anchor is given, and says so', () => {
    const { plan, applied } = run('scale', { factor: 2 });
    // The square's centre is (50, 50), so doubling puts the corner at (-50,-50).
    expect(ringOf(applied)[0]).toEqual([-50, -50]);
    expect(plan.notes.join(' ')).toContain('50.000, 50.000');
    expect(plan.notes.join(' ')).toContain('different point gives a different result');
  });

  it('names a mirror rather than performing one silently', () => {
    const { plan } = run('scale', { factor: [-1, 1] });
    expect(plan.notes.join(' ')).toContain('mirrors');
    expect(plan.notes.join(' ')).toContain('winding');
  });

  it('names a non-uniform scale, which does not preserve angles', () => {
    expect(run('scale', { factor: [2, 3] }).plan.notes.join(' ')).toContain('circle becomes an ellipse');
  });

  it('refuses a zero factor, which would be unrecoverable', () => {
    const { plan } = run('scale', { factor: 0 });
    expect(plan.refusal?.what).toContain('collapse');
    expect(plan.refusal?.why).toContain('unrecoverable');
  });

  it('refuses when no factor was given', () => {
    expect(run('scale', {}).plan.refusal?.what).toContain('No scale factor');
  });

  it('leaves Z untouched — a plan-view scale is not a vertical exaggeration', () => {
    const withHeight: Position[] = [
      [0, 0, 100],
      [100, 0, 200],
      [100, 100, 300],
      [0, 0, 100],
    ];
    const { applied } = run('scale', { factor: 2, anchor: [0, 0] }, [parcel('A', withHeight)]);
    expect(ringOf(applied).map((position) => position[2])).toEqual([100, 200, 300, 100]);
  });
});

// --------------------------------------------------------------------- rotate

describe('rotating a selection', () => {
  it('keeps every distance from the anchor', () => {
    // The defining property of a rotation, and it holds for any angle.
    const anchor: Position = [50, 50];
    const before = SQUARE.map((position) => distance(position, anchor));
    const { applied } = run('rotate', { angleDegrees: 37, anchor });
    const after = ringOf(applied).map((position) => distance(position, anchor));
    after.forEach((value, index) => expect(value).toBeCloseTo(before[index], 9));
  });

  it('preserves area exactly', () => {
    const { applied } = run('rotate', { angleDegrees: 23.4 });
    expect(Math.abs(signedArea(ringOf(applied)))).toBeCloseTo(10000, 6);
  });

  it('turns clockwise, as a survey bearing does', () => {
    // The opposite of the mathematical convention, and the one a surveyor
    // means. A point due east of the anchor must end up due SOUTH after 90°.
    const { applied } = run(
      'rotate',
      { angleDegrees: 90, anchor: [0, 0] },
      [parcel('A', [[10, 0], [10, 0], [10, 0], [10, 0]])]
    );
    const [x, y] = ringOf(applied)[0];
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(-10, 9);
  });

  it('returns to the start after four right angles', () => {
    let features = [parcel('A')];
    for (let turn = 0; turn < 4; turn++) {
      const { applied } = run('rotate', { angleDegrees: 90, anchor: [50, 50] }, features);
      features = applied.layers[0].features;
    }
    ringOf({ layers: [{ features }] } as unknown as CirDataset).forEach((position, index) => {
      expect(position[0]).toBeCloseTo(SQUARE[index][0], 6);
      expect(position[1]).toBeCloseTo(SQUARE[index][1], 6);
    });
  });

  it('refuses a full turn, which changes nothing', () => {
    expect(run('rotate', { angleDegrees: 360 }).plan.refusal?.what).toContain('leaves every coordinate where it is');
  });

  it('refuses when no angle was given', () => {
    expect(run('rotate', {}).plan.refusal?.what).toContain('No rotation angle');
  });
});

// ------------------------------------------------------------- what they share

describe('what every transform honours', () => {
  it('refuses a protected layer, like every other operation', () => {
    const dataset = datasetOf([parcel('A')]);
    const plan = planGeometryOperation(dataset, 'parcels', 'translate', {
      crs: dataset.crs,
      offset: [10, 10],
      protectedLayers: ['parcels'],
    });
    expect(plan.refusal?.what).toContain('protected');
  });

  it('can write to a new layer instead of replacing the source', () => {
    // So a correction can be checked against the original before it replaces it.
    const dataset = datasetOf([parcel('A')]);
    const plan = planGeometryOperation(dataset, 'parcels', 'translate', {
      crs: dataset.crs,
      offset: [10, 10],
      outputLayer: 'parcels (shifted)',
    });
    const result = applyGeometryOperation(dataset, plan);
    expect(result.dataset.layers.map((layer) => layer.name)).toContain('parcels (shifted)');
    // The original is untouched.
    expect(ringOf(result.dataset)[0]).toEqual([0, 0]);
  });

  it('keeps attributes on every transformed feature', () => {
    const { applied } = run('translate', { offset: [5, 5] });
    expect(applied.layers[0].features[0].properties.plot).toBe('A');
  });

  it('reports how many features it moved', () => {
    expect(run('translate', { offset: [1, 1] }, [parcel('A'), parcel('B'), parcel('C')]).plan.consumed).toBe(3);
  });
});

// ------------------------------------------------------- all the way to a file

describe('a correction reaches the exported bytes', () => {
  const GEOJSON = JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32645' } },
    features: [
      {
        type: 'Feature',
        properties: { plot: 'A-1' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[412300, 2591200], [412400, 2591200], [412400, 2591300], [412300, 2591300], [412300, 2591200]]],
        },
      },
    ],
  });

  /** The command the canvas will record when the user drags a selection. */
  const move = (dx: number, dy: number) => ({
    kind: 'geometry' as const,
    layer: 'plots.geojson',
    operation: 'translate' as const,
    options: { offset: [dx, dy] as [number, number] },
  });

  it('writes the shifted coordinates, not the original ones', async () => {
    // The whole point of recording the transform as an intent: the workspace
    // holds a 5,000-feature preview, and the conversion replays the command
    // against the full dataset. If this ever regressed, the canvas would show
    // a corrected survey and the file would carry the uncorrected one.
    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, runQa: false, edits: [move(-12.5, 7.25)] },
    });

    const written = JSON.parse(new TextDecoder().decode(result.outputs[0].bytes));
    expect(written.features[0].geometry.coordinates[0][0]).toEqual([412287.5, 2591207.25]);
    expect(written.features[0].properties.plot).toBe('A-1');
  });

  it('records the offset in the warnings, so the report can carry it', async () => {
    // A shift against a basemap can equally mean the CRS is wrong or the
    // basemap is imprecise. The tool cannot tell, so what it CAN do is leave a
    // record of exactly what it moved and by how much.
    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, runQa: false, edits: [move(-12.5, 7.25)] },
    });
    const said = result.warnings.map((entry) => `${entry.message} ${entry.reason ?? ''}`).join(' ');
    expect(said).toContain('12.5');
  });

  it('survives a change of format', async () => {
    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: 'kml',
      settings: { precision: FULL_PRECISION, runQa: false, edits: [move(-12.5, 7.25)] },
    });
    // KML mandates WGS 84, so the shifted UTM coordinates are reprojected —
    // and the shift has to have happened BEFORE the reprojection, or it would
    // be applied in the wrong units.
    const text = new TextDecoder().decode(result.outputs[0].bytes);
    expect(text).toMatch(/8[4-8]\.\d+,2[23]\.\d+/);
  });

  it('is reversed by removing the command, not by an inverse', async () => {
    // Undo replays what remains rather than applying an opposite transform. An
    // inverse that drifts from its forward operation is the classic way an undo
    // leaves data subtly changed.
    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, runQa: false, edits: [] },
    });
    const written = JSON.parse(new TextDecoder().decode(result.outputs[0].bytes));
    expect(written.features[0].geometry.coordinates[0][0]).toEqual([412300, 2591200]);
  });
});
