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
import { createDataset, createLayer, type CirDataset, type CirFeature, type FieldDef, type SourceInfo } from '@core/cir';
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
