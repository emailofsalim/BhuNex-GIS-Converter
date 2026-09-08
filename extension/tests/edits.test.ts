/**
 * Edit commands replayed onto the real dataset (`core/edits.ts`).
 *
 * The bug this file exists to prevent is subtle and expensive:
 *
 *   The workspace previews at most 5,000 features per layer. Conversion re-reads
 *   the source. So an edit had to be carried across that boundary somehow — and
 *   the obvious way, sending the computed change list, is WRONG. A change list
 *   built against 5,000 of 40,000 parcels sets the owner on 5,000 parcels and
 *   leaves 35,000 untouched, with nothing reporting it. The user asked for a
 *   column and got an eighth of one.
 *
 * So the tests below assert the property that makes it safe: a command planned
 * against a small preview, replayed against a large dataset, affects EVERY row
 * of the large dataset. If someone later "optimises" this by sending diffs,
 * `replays a whole-layer edit across every feature` fails.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type CrsRef, type FieldDef, type SourceInfo } from '@core/cir';
import { describeCommand, isWholeLayer, replayEdits, type EditCommand } from '@core/edits';
import { planMoveVertex } from '@core/vertex-edit';

const SOURCE: SourceInfo = {
  fileName: 'plots.shp',
  size: 0,
  formatId: 'shapefile',
  formatName: 'Esri Shapefile',
  detectionConfidence: 1,
};

const FIELDS: FieldDef[] = [
  { name: 'plot', type: 'string' },
  { name: 'owner', type: 'string' },
  { name: 'area', type: 'number' },
];

function parcel(index: number): CirFeature {
  return {
    id: `P${index}`,
    geometry: { type: 'Point', coordinates: [index, index], dimension: 2 },
    properties: { plot: `A-${index}`, owner: index % 2 === 0 ? 'Rao' : null, area: 100 + index },
  };
}

/** `count` parcels, in one layer. The preview would hold only the first 5,000. */
function parcels(count: number): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'plots',
    source: SOURCE,
    layers: [createLayer('Plots', Array.from({ length: count }, (_, index) => parcel(index)), FIELDS)],
  });
}

function ownersOf(dataset: CirDataset): unknown[] {
  return dataset.layers[0].features.map((feature) => feature.properties.owner);
}

// ===========================================================================

describe('a command is an intent, not a diff', () => {
  it('replays a whole-layer edit across every feature, not just the previewed ones', () => {
    // The exact shape of the real problem: the user saw 5,000 rows and asked
    // for the column. The file has 12,000.
    const PREVIEW = 5000;
    const REAL = 12000;

    const command: EditCommand = { kind: 'set', layer: 'Plots', field: 'owner', value: 'State' };

    // Planned against the preview…
    const previewResult = replayEdits(parcels(PREVIEW), [command]);
    expect(previewResult.applied).toBe(1);
    expect(ownersOf(previewResult.dataset)).toHaveLength(PREVIEW);

    // …replayed against the whole file.
    const full = replayEdits(parcels(REAL), [command]);
    expect(full.applied).toBe(1);

    const owners = ownersOf(full.dataset);
    expect(owners).toHaveLength(REAL);
    // Every single one. Not 5,000 of them.
    expect(owners.every((owner) => owner === 'State')).toBe(true);
  });

  it('replays a calculation across every feature', () => {
    const result = replayEdits(parcels(9000), [{ kind: 'calculate', layer: 'Plots', field: 'area', expression: 'area * 2' }]);
    const areas = result.dataset.layers[0].features.map((feature) => feature.properties.area);
    expect(areas).toHaveLength(9000);
    expect(areas[8999]).toBe((100 + 8999) * 2);
  });

  it('keeps a scoped edit scoped', () => {
    // A selection edit names its rows, so it must NOT spread to the whole layer.
    const result = replayEdits(parcels(100), [{ kind: 'set', layer: 'Plots', field: 'owner', value: 'State', scope: [0, 1, 2] }]);
    const owners = ownersOf(result.dataset);
    expect(owners.slice(0, 3)).toEqual(['State', 'State', 'State']);
    expect(owners[3]).toBeNull();
    expect(owners.filter((owner) => owner === 'State')).toHaveLength(3);
  });

  it('knows which commands are whole-layer', () => {
    expect(isWholeLayer({ kind: 'set', layer: 'Plots', field: 'owner', value: 'X' })).toBe(true);
    expect(isWholeLayer({ kind: 'set', layer: 'Plots', field: 'owner', value: 'X', scope: [1] })).toBe(false);
    expect(isWholeLayer({ kind: 'layer-delete', layer: 'Plots' })).toBe(true);
  });
});

describe('commands compose in order', () => {
  it('applies a rename and then a calculation that depends on it', () => {
    const result = replayEdits(parcels(10), [
      { kind: 'rename-field', layer: 'Plots', field: 'area', newName: 'area_m2' },
      { kind: 'add-field', layer: 'Plots', field: { name: 'area_ha', type: 'number' } },
      { kind: 'calculate', layer: 'Plots', field: 'area_ha', expression: 'round(area_m2 / 10000, 4)' },
    ]);

    expect(result.failure).toBeUndefined();
    expect(result.applied).toBe(3);

    const first = result.dataset.layers[0].features[0].properties;
    expect(first.area_m2).toBe(100);
    expect(first.area_ha).toBeCloseTo(0.01, 10);
    expect(first.area).toBeUndefined();
  });

  it('applies layer operations and attribute operations together', () => {
    const result = replayEdits(parcels(6), [
      { kind: 'set', layer: 'Plots', field: 'owner', value: 'State' },
      { kind: 'layer-rename', layer: 'Plots', to: 'Parcels' },
      { kind: 'add-field', layer: 'Parcels', field: { name: 'status', type: 'string' }, initialValue: 'checked' },
    ]);

    expect(result.failure).toBeUndefined();
    expect(result.dataset.layers[0].name).toBe('Parcels');
    expect(result.dataset.layers[0].features[0].properties.status).toBe('checked');
    expect(result.dataset.layers[0].features[0].properties.owner).toBe('State');
  });
});

describe('a refused command stops the replay', () => {
  it('stops rather than skipping, and names the command that failed', () => {
    const result = replayEdits(parcels(10), [
      { kind: 'set', layer: 'Plots', field: 'owner', value: 'State' },
      // "nosuch" is not a field: the plan refuses.
      { kind: 'calculate', layer: 'Plots', field: 'area', expression: 'nosuch * 2' },
      { kind: 'set', layer: 'Plots', field: 'plot', value: 'never applied' },
    ]);

    expect(result.failure?.index).toBe(1);
    expect(result.applied).toBe(1);
    // The first command's effect is visible…
    expect(ownersOf(result.dataset)[0]).toBe('State');
    // …and the third never ran, because it was written against a dataset the
    // second command was supposed to produce.
    expect(result.dataset.layers[0].features[0].properties.plot).toBe('A-0');
  });

  it('refuses every command on a protected layer', () => {
    const commands: EditCommand[] = [{ kind: 'set', layer: 'Plots', field: 'owner', value: 'State' }];
    const result = replayEdits(parcels(10), commands, { protectedLayers: ['Plots'] });

    expect(result.failure).toBeDefined();
    expect(result.failure?.what).toContain('protected');
    expect(ownersOf(result.dataset)[0]).toBe('Rao');
  });

  it('refuses a layer operation on a protected layer too', () => {
    // One list, checked by both planners — the padlock cannot be half-enforced.
    const result = replayEdits(parcels(10), [{ kind: 'layer-delete', layer: 'Plots' }], { protectedLayers: ['Plots'] });
    expect(result.failure?.what).toContain('locked');
    expect(result.dataset.layers).toHaveLength(1);
  });

  it('reports a retype that would lose values instead of applying it', () => {
    const mixed = createDataset({
      kind: 'vector',
      name: 'plots',
      source: SOURCE,
      layers: [
        createLayer(
          'Plots',
          [
            { id: 'A', geometry: null, properties: { level: '41.5' } },
            { id: 'B', geometry: null, properties: { level: 'n/a' } },
          ],
          [{ name: 'level', type: 'string' }]
        ),
      ],
    });

    const refused = replayEdits(mixed, [{ kind: 'retype-field', layer: 'Plots', field: 'level', type: 'number' }]);
    expect(refused.failure?.what).toContain('cannot be read as number');

    const forced = replayEdits(mixed, [{ kind: 'retype-field', layer: 'Plots', field: 'level', type: 'number', force: true }]);
    expect(forced.failure).toBeUndefined();
    expect(forced.dataset.layers[0].features.map((feature) => feature.properties.level)).toEqual([41.5, null]);
  });
});

describe('vertex edits', () => {
  function square(): CirDataset {
    return createDataset({
      kind: 'vector',
      name: 'plots',
      source: SOURCE,
      layers: [
        createLayer('Plots', [
          {
            id: 'P',
            geometry: {
              type: 'Polygon',
              coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]],
              dimension: 2,
            },
            properties: {},
          },
        ]),
      ],
    });
  }

  it('carries its change list, because a coordinate has no re-plannable description', () => {
    const data = square();
    const plan = planMoveVertex(data, { layer: 'Plots', featureIndex: 0, ring: 0, vertex: 1 }, [103, 4]);

    const result = replayEdits(data, [{ kind: 'vertices', plan }]);
    expect(result.failure).toBeUndefined();

    const ring = (result.dataset.layers[0].features[0].geometry!.coordinates as number[][][])[0];
    expect(ring[1]).toEqual([103, 4]);
  });

  it('refuses when the source no longer has the feature the edit names', () => {
    const data = square();
    const plan = planMoveVertex(data, { layer: 'Plots', featureIndex: 0, ring: 0, vertex: 1 }, [103, 4]);

    // The same edit against a file that has since lost its features.
    const emptied = createDataset({ kind: 'vector', name: 'plots', source: SOURCE, layers: [createLayer('Plots', [])] });
    const result = replayEdits(emptied, [{ kind: 'vertices', plan }]);

    expect(result.failure?.what).toContain('the source file does not have');
    expect(result.failure?.why).toContain('feature 1');
  });
});

describe('the replay log', () => {
  it('records what each command actually did, with row counts', () => {
    const result = replayEdits(parcels(250), [{ kind: 'set', layer: 'Plots', field: 'owner', value: 'State' }]);
    expect(result.log[0]).toContain('Set "owner" on Plots');
    expect(result.log[0]).toContain('250 rows');
  });

  it('describes a command in one line for the history', () => {
    expect(describeCommand({ kind: 'calculate', layer: 'Plots', field: 'area', expression: 'a * 2' })).toBe(
      'Calculate "area" = a * 2'
    );
    expect(describeCommand({ kind: 'layer-merge', layers: ['A', 'B'], into: 'C' })).toBe('Merge A, B into "C"');
    expect(describeCommand({ kind: 'retype-field', layer: 'L', field: 'f', type: 'number', force: true })).toContain(
      'accepting the loss'
    );
  });
});

describe('the source dataset is never mutated', () => {
  it('leaves the input alone', () => {
    const before = parcels(20);
    replayEdits(before, [
      { kind: 'set', layer: 'Plots', field: 'owner', value: 'State' },
      { kind: 'layer-rename', layer: 'Plots', to: 'Parcels' },
    ]);
    expect(before.layers[0].name).toBe('Plots');
    expect(ownersOf(before)[0]).toBe('Rao');
  });
});

// ===========================================================================
// Geometry operations (§26.2) as commands
// ===========================================================================

/**
 * The same 5,000-of-40,000 problem, and one more that is specific to geometry.
 *
 * An attribute edit planned on a preview is a smaller version of the right
 * answer. A geometry operation planned on a preview is a DIFFERENT answer: the
 * convex hull of the first five parcels is not a subset of the hull of two
 * hundred, it is the wrong polygon. So these tests plan against a preview-sized
 * dataset and assert the replay produced the whole-dataset result.
 *
 * The second property is the CRS gate. A command must NOT carry the CRS it was
 * planned under, or a buffer configured while a projected copy was loaded would
 * replay against a geographic source and silently mean 1,100 km.
 */
describe('geometry operations as commands', () => {
  const PROJECTED: CrsRef = {
    epsg: 32643,
    name: 'WGS 84 / UTM zone 43N',
    kind: 'projected',
    datum: 'WGS 84',
    projection: 'Transverse Mercator',
    unit: 'metre',
    axisOrder: 'xy',
  };

  const GEOGRAPHIC: CrsRef = { ...PROJECTED, epsg: 4326, name: 'WGS 84', kind: 'geographic', projection: 'none', unit: 'degree' };

  /** `count` unit squares in a row, so the hull of the first N differs from the hull of all. */
  function squares(count: number, crs: CrsRef | null): CirDataset {
    const features: CirFeature[] = Array.from({ length: count }, (_, index) => ({
      id: `S${index}`,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [index * 10, 0],
            [index * 10 + 8, 0],
            [index * 10 + 8, 8],
            [index * 10, 8],
            [index * 10, 0],
          ],
        ],
        dimension: 2,
      },
      properties: { plot: `A-${index}`, block: index < 3 ? 'north' : 'south' },
    }));
    return createDataset({
      kind: 'vector',
      name: 'plots',
      source: SOURCE,
      crs,
      layers: [createLayer('Plots', features, [{ name: 'plot', type: 'string' }, { name: 'block', type: 'string' }])],
    });
  }

  function ringOf(dataset: CirDataset, layerName: string): number[][] {
    const layer = dataset.layers.find((candidate) => candidate.name === layerName);
    return (layer!.features[0].geometry!.coordinates as number[][][])[0];
  }

  it('re-plans against the whole dataset, not the preview it was configured on', () => {
    const command: EditCommand = {
      kind: 'geometry',
      layer: 'Plots',
      operation: 'convex-hull',
      options: { outputLayer: 'Extent' },
    };

    // Configured while five squares were loaded...
    const preview = replayEdits(squares(5, PROJECTED), [command]);
    expect(ringOf(preview.dataset, 'Extent').some((position) => position[0] === 48)).toBe(true);

    // ...replayed against all twenty. The hull now reaches x = 198, which is not
    // a bigger version of the preview's answer — it is a different polygon.
    const full = replayEdits(squares(20, PROJECTED), [command]);
    const ring = ringOf(full.dataset, 'Extent');
    expect(Math.max(...ring.map((position) => position[0]))).toBe(198);
    expect(full.dataset.layers.find((layer) => layer.name === 'Plots')!.features).toHaveLength(20);
  });

  it('writes into a new layer and leaves the source alone', () => {
    const result = replayEdits(squares(4, PROJECTED), [
      { kind: 'geometry', layer: 'Plots', operation: 'envelope', options: { outputLayer: 'Envelopes' } },
    ]);
    expect(result.dataset.layers.map((layer) => layer.name)).toEqual(['Plots', 'Envelopes']);
    expect(result.dataset.layers[0].features).toHaveLength(4);
    expect(result.dataset.layers[1].features).toHaveLength(4);
  });

  it('replaces the source layer when no output layer is named', () => {
    const result = replayEdits(squares(4, PROJECTED), [
      { kind: 'geometry', layer: 'Plots', operation: 'centroid', options: {} },
    ]);
    expect(result.dataset.layers).toHaveLength(1);
    expect(result.dataset.layers[0].features[0].geometry!.type).toBe('Point');
  });

  it('takes the CRS from the dataset it is replayed against, not from the command', () => {
    // A buffer configured while a projected dataset was loaded. The command
    // stores no CRS, deliberately — see `StoredGeometryOptions`.
    const command: EditCommand = {
      kind: 'geometry',
      layer: 'Plots',
      operation: 'buffer',
      options: { distance: 10, outputLayer: 'Setback' },
    };

    expect(replayEdits(squares(3, PROJECTED), [command]).failure).toBeUndefined();

    // The same command against degrees. 10 there is about 1,100 km.
    const refused = replayEdits(squares(3, GEOGRAPHIC), [command]);
    expect(refused.failure?.what).toContain('cannot run on a geographic CRS');
    expect(refused.failure?.why).toContain('1,100 km');
    expect(refused.applied).toBe(0);
  });

  it('refuses a distance operation when the dataset declares no CRS at all', () => {
    const refused = replayEdits(squares(3, null), [
      { kind: 'geometry', layer: 'Plots', operation: 'buffer', options: { distance: 10 } },
    ]);
    expect(refused.failure?.why).toContain('declares no CRS');
  });

  it('refuses on a protected layer, like every other command', () => {
    const refused = replayEdits(
      squares(3, PROJECTED),
      [{ kind: 'geometry', layer: 'Plots', operation: 'centroid', options: {} }],
      { protectedLayers: ['Plots'] }
    );
    expect(refused.failure?.what).toContain('protected');
  });

  it('dissolves by a field, merging only what shares its value', () => {
    const result = replayEdits(squares(5, PROJECTED), [
      { kind: 'geometry', layer: 'Plots', operation: 'dissolve', options: { field: 'block' } },
    ]);
    // Three "north" squares and two "south" ones: two features, not one and not five.
    expect(result.dataset.layers[0].features).toHaveLength(2);
  });

  it('reports what it did in the replay log', () => {
    const result = replayEdits(squares(6, PROJECTED), [
      { kind: 'geometry', layer: 'Plots', operation: 'convex-hull', options: { outputLayer: 'Extent' } },
    ]);
    expect(result.log[0]).toContain('Convex hull');
    expect(result.log[0]).toContain('6 feature(s) → 1');
  });

  it('describes itself in one line, naming the distance and the destination', () => {
    expect(
      describeCommand({ kind: 'geometry', layer: 'Plots', operation: 'buffer', options: { distance: 7.5, outputLayer: 'Setback' } })
    ).toBe('Buffer "Plots" by 7.5 → "Setback"');
    expect(describeCommand({ kind: 'geometry', layer: 'Plots', operation: 'centroid', options: {} })).toBe('Centroid "Plots"');
  });

  it('counts as a whole-layer edit only when it is not scoped to named features', () => {
    expect(isWholeLayer({ kind: 'geometry', layer: 'L', operation: 'centroid', options: {} })).toBe(true);
    expect(isWholeLayer({ kind: 'geometry', layer: 'L', operation: 'centroid', options: { scope: [0, 1] } })).toBe(false);
  });
});
