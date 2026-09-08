/**
 * The layer manager (spec §25.4).
 *
 * The two things a layer manager gets wrong, and the reason most of these tests
 * exist:
 *
 *   1. CONFUSING THE VIEW WITH THE DATA. Hiding a layer looks like removing it.
 *      If hiding also removed it from an export, every survey delivered from
 *      this tool would be missing whatever the user had tidied off the canvas —
 *      and nothing would report it. So visibility is tested for having NO
 *      effect on the dataset, and export subsetting is tested for taking an
 *      explicit selection.
 *
 *   2. LOSING A SCHEMA IN A MERGE. Two layers merged, one without field
 *      `owner`, and its features come out with `owner: ""` — a value nobody
 *      entered, indistinguishable from a deliberate blank, and unfixable
 *      afterwards because the layer boundary is gone.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type FieldDef, type SourceInfo } from '@core/cir';
import {
  applyLayers,
  describeLayerPlan,
  EMPTY_VIEW,
  isVisible,
  layerTree,
  listLayers,
  lockedLayers,
  opacityOf,
  planDeleteLayer,
  planMergeLayers,
  planRenameLayer,
  planReorder,
  planSplitLayer,
  planStyleLayer,
  selectionForExport,
  setAllHidden,
  setView,
  SPLIT_LIMIT,
  toggleIsolate,
  undoLayers,
} from '@core/layers';

const SOURCE: SourceInfo = { fileName: 'site.kml', size: 0, formatId: 'kml', formatName: 'KML', detectionConfidence: 1 };

function point(id: string, properties: Record<string, unknown> = {}): CirFeature {
  return { id, geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 }, properties };
}

function line(id: string, properties: Record<string, unknown> = {}): CirFeature {
  return {
    id,
    geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]], dimension: 2 },
    properties,
  };
}

function dataset(layers: ReturnType<typeof createLayer>[]): CirDataset {
  return createDataset({ kind: 'vector', name: 'site', source: SOURCE, layers });
}

const PLOT_FIELDS: FieldDef[] = [
  { name: 'plot', type: 'string' },
  { name: 'owner', type: 'string' },
];
const BORE_FIELDS: FieldDef[] = [
  { name: 'plot', type: 'string' },
  { name: 'depth', type: 'number' },
];

/** A KML-shaped dataset: two folders, three layers. */
function site(): CirDataset {
  return dataset([
    createLayer('Plots', [point('P1', { plot: 'A-1', owner: 'Rao' }), point('P2', { plot: 'A-2', owner: null })], PLOT_FIELDS, [
      'Survey',
      'Plots',
    ]),
    createLayer('Boreholes', [point('B1', { plot: 'A-1', depth: 12 })], BORE_FIELDS, ['Survey', 'Boreholes']),
    createLayer('Roads', [line('R1', { plot: 'A-1' })], [{ name: 'plot', type: 'string' }], ['Infrastructure', 'Roads']),
  ]);
}

// ===========================================================================
// View state
// ===========================================================================

describe('view state never touches the dataset', () => {
  it('hides a layer without removing it', () => {
    const data = site();
    const view = setView(EMPTY_VIEW, 'Plots', { hidden: true });

    expect(isVisible(view, 'Plots')).toBe(false);
    expect(isVisible(view, 'Roads')).toBe(true);
    // The whole point: the dataset is untouched, so an export still carries it.
    expect(data.layers).toHaveLength(3);
    expect(selectionForExport(data, ['Plots', 'Boreholes', 'Roads'])?.layers).toHaveLength(3);
  });

  it('isolate overrides hidden without erasing it', () => {
    let view = setView(EMPTY_VIEW, 'Roads', { hidden: true });
    view = toggleIsolate(view, 'Plots');

    expect(isVisible(view, 'Plots')).toBe(true);
    expect(isVisible(view, 'Boreholes')).toBe(false);
    expect(isVisible(view, 'Roads')).toBe(false);

    // Leaving isolate must restore exactly what was hidden before it.
    view = toggleIsolate(view, 'Plots');
    expect(isVisible(view, 'Plots')).toBe(true);
    expect(isVisible(view, 'Boreholes')).toBe(true);
    expect(isVisible(view, 'Roads')).toBe(false);
  });

  it('show-all clears isolation as well as hiding', () => {
    let view = setView(EMPTY_VIEW, 'Roads', { hidden: true });
    view = toggleIsolate(view, 'Plots');
    view = setAllHidden(view, ['Plots', 'Boreholes', 'Roads'], false);

    expect(view.isolated).toBeNull();
    expect(['Plots', 'Boreholes', 'Roads'].every((layer) => isVisible(view, layer))).toBe(true);
  });

  it('clamps opacity and defaults to opaque', () => {
    expect(opacityOf(EMPTY_VIEW, 'Plots')).toBe(1);
    expect(opacityOf(setView(EMPTY_VIEW, 'Plots', { opacity: 0.4 }), 'Plots')).toBe(0.4);
    expect(opacityOf(setView(EMPTY_VIEW, 'Plots', { opacity: 5 }), 'Plots')).toBe(1);
    expect(opacityOf(setView(EMPTY_VIEW, 'Plots', { opacity: -1 }), 'Plots')).toBe(0);
  });

  it('collects locked layers for the editing engines to refuse', () => {
    const view = setView(setView(EMPTY_VIEW, 'Plots', { locked: true }), 'Roads', { hidden: true });
    expect(lockedLayers(view)).toEqual(['Plots']);
  });
});

// ===========================================================================
// The list
// ===========================================================================

describe('the layer list', () => {
  it('reports counts, depth and view flags together', () => {
    const view = setView(EMPTY_VIEW, 'Plots', { hidden: true, locked: true, opacity: 0.5 });
    const items = listLayers(site(), view);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ name: 'Plots', featureCount: 2, fieldCount: 2, depth: 1, visible: false, locked: true });
    expect(items[0].opacity).toBe(0.5);
    expect(items[0].index).toBe(0);
  });

  it('searches the folder path, not only the name', () => {
    expect(listLayers(site(), EMPTY_VIEW, 'infrastructure').map((item) => item.name)).toEqual(['Roads']);
    expect(listLayers(site(), EMPTY_VIEW, 'survey')).toHaveLength(2);
    expect(listLayers(site(), EMPTY_VIEW, 'bore').map((item) => item.name)).toEqual(['Boreholes']);
  });

  it('rebuilds the KML folder hierarchy as a tree', () => {
    const tree = layerTree(listLayers(site()));

    expect(tree.map((node) => node.name)).toEqual(['Survey', 'Infrastructure']);
    expect(tree[0].layer).toBeUndefined(); // a folder, not a layer
    expect(tree[0].children.map((node) => node.name)).toEqual(['Plots', 'Boreholes']);
    expect(tree[0].children[0].layer?.featureCount).toBe(2);
  });

  it('returns a flat list for flat sources like DXF', () => {
    const flat = dataset([createLayer('0', [point('A')]), createLayer('BOUNDARY', [line('B')])]);
    const tree = layerTree(listLayers(flat));
    expect(tree).toHaveLength(2);
    expect(tree.every((node) => node.children.length === 0 && node.layer !== undefined)).toBe(true);
  });

  it('keeps two layers distinct when a name contains the path separator', () => {
    const awkward = dataset([
      createLayer('C', [point('A')], [], ['A', 'B/C']),
      createLayer('C', [point('B')], [], ['A/B', 'C']),
    ]);
    // A naive join('/') would collapse both to "A/B/C" and lose one.
    expect(layerTree(listLayers(awkward))).toHaveLength(2);
  });
});

// ===========================================================================
// Rename
// ===========================================================================

describe('rename', () => {
  it('renames the layer and the last path segment together', () => {
    const before = site();
    const plan = planRenameLayer(before, 'Plots', 'Parcels');
    const { dataset: after, plan: applied } = applyLayers(before, plan);

    expect(after.layers[0].name).toBe('Parcels');
    expect(after.layers[0].path).toEqual(['Survey', 'Parcels']);
    expect(after.layers[0].features).toHaveLength(2);
    expect(undoLayers(after, applied).layers[0].name).toBe('Plots');
  });

  it('refuses a name that already exists', () => {
    const plan = planRenameLayer(site(), 'Plots', 'Roads');
    expect(plan.refusal?.why).toContain('collide');
    expect(applyLayers(site(), plan).dataset.layers[0].name).toBe('Plots');
  });

  it('refuses an empty name and a locked layer', () => {
    expect(planRenameLayer(site(), 'Plots', '   ').refusal).toBeDefined();
    expect(planRenameLayer(site(), 'Plots', 'Parcels', { protectedLayers: ['Plots'] }).refusal?.what).toContain('locked');
  });

  it('warns about a character DXF will not accept', () => {
    const plan = planRenameLayer(site(), 'Plots', 'Plots/2024');
    expect(plan.notes[0]).toContain('DXF');
  });

  it('renames correctly even when the new name matches another layer position', () => {
    // The old apply path inferred the new name by diffing result against the
    // dataset; a rename to a name resembling a neighbour defeated it.
    const before = dataset([createLayer('A', [point('1')]), createLayer('B', [point('2')])]);
    const plan = planRenameLayer(before, 'A', 'B2');
    const { dataset: after } = applyLayers(before, plan);
    expect(after.layers.map((layer) => layer.name)).toEqual(['B2', 'B']);
  });
});

// ===========================================================================
// Merge
// ===========================================================================

describe('merge', () => {
  it('unions the schema and fills the gaps with null, never ""', () => {
    const before = site();
    const plan = planMergeLayers(before, ['Plots', 'Boreholes'], 'Survey points');
    const { dataset: after } = applyLayers(before, plan);

    const merged = after.layers.find((layer) => layer.name === 'Survey points')!;
    expect(merged.fields.map((field) => field.name)).toEqual(['plot', 'owner', 'depth']);
    expect(merged.features).toHaveLength(3);

    // The borehole never had an owner. That is missing, not blank.
    const borehole = merged.features.find((feature) => feature.id === 'B1')!;
    expect(borehole.properties.owner).toBeNull();
    expect(borehole.properties.owner).not.toBe('');

    // The plot never had a depth.
    expect(merged.features.find((feature) => feature.id === 'P1')!.properties.depth).toBeNull();
  });

  it('says which fields only some of the layers had', () => {
    const plan = planMergeLayers(site(), ['Plots', 'Boreholes'], 'Survey points');
    expect(plan.notes.join(' ')).toContain('"owner"');
    expect(plan.notes.join(' ')).toContain('empty cell, not a zero');
  });

  it('records where each feature came from (R20)', () => {
    const before = site();
    const { dataset: after } = applyLayers(before, planMergeLayers(before, ['Plots', 'Boreholes'], 'Survey points'));
    const merged = after.layers.find((layer) => layer.name === 'Survey points')!;
    expect(merged.features.map((feature) => feature.sourceLayer)).toEqual(['Plots', 'Plots', 'Boreholes']);
  });

  it('keeps the merged layer inside a shared folder', () => {
    const before = site();
    const plan = planMergeLayers(before, ['Plots', 'Boreholes'], 'Survey points');
    const { dataset: after } = applyLayers(before, plan);
    expect(after.layers.find((layer) => layer.name === 'Survey points')!.path).toEqual(['Survey', 'Survey points']);
    // Both sources were already under Survey, so nothing about R16 is lost.
    expect(plan.notes.join(' ')).not.toContain('different folders');
  });

  it('warns when merging across folders flattens the hierarchy (R16)', () => {
    const plan = planMergeLayers(site(), ['Plots', 'Roads'], 'Everything');
    expect(plan.notes.join(' ')).toContain('different folders');
    expect(plan.notes.join(' ')).toContain('R16');
  });

  it('warns when the merge mixes geometry families a shapefile cannot hold', () => {
    const plan = planMergeLayers(site(), ['Plots', 'Roads'], 'Everything');
    expect(plan.notes.join(' ')).toContain('shapefile');
  });

  it('takes the position of the first source, not the bottom of the list', () => {
    const before = site();
    const { dataset: after } = applyLayers(before, planMergeLayers(before, ['Plots', 'Roads'], 'Everything'));
    expect(after.layers.map((layer) => layer.name)).toEqual(['Everything', 'Boreholes']);
  });

  it('refuses fewer than two layers, a missing layer and a locked one', () => {
    expect(planMergeLayers(site(), ['Plots'], 'X').refusal).toBeDefined();
    expect(planMergeLayers(site(), ['Plots', 'Nope'], 'X').refusal?.why).toContain('Nope');
    expect(planMergeLayers(site(), ['Plots', 'Roads'], 'X', { protectedLayers: ['Roads'] }).refusal?.what).toContain('locked');
  });

  it('undoes back to the original layers and features', () => {
    const before = site();
    const { dataset: after, plan } = applyLayers(before, planMergeLayers(before, ['Plots', 'Boreholes'], 'Survey points'));
    const reverted = undoLayers(after, plan);
    expect(reverted.layers.map((layer) => layer.name)).toEqual(['Plots', 'Boreholes', 'Roads']);
    expect(reverted.layers[1].features[0].properties.owner).toBeUndefined();
  });
});

// ===========================================================================
// Split
// ===========================================================================

describe('split', () => {
  function parcels(): CirDataset {
    return dataset([
      createLayer(
        'Plots',
        [
          point('1', { block: 'A' }),
          point('2', { block: 'A' }),
          point('3', { block: 'B' }),
          point('4', { block: null }),
        ],
        [{ name: 'block', type: 'string' }]
      ),
    ]);
  }

  it('splits by field value and nests the parts under the original (R16)', () => {
    const before = parcels();
    const plan = planSplitLayer(before, 'Plots', { kind: 'field', field: 'block' });
    const { dataset: after } = applyLayers(before, plan);

    expect(after.layers.map((layer) => layer.name)).toEqual(['Plots_A', 'Plots_B', 'Plots_(empty)']);
    expect(after.layers[0].path).toEqual(['Plots', 'A']);
    expect(after.layers[0].features).toHaveLength(2);
  });

  it('gives the features with no value their own layer rather than dropping them', () => {
    const before = parcels();
    const plan = planSplitLayer(before, 'Plots', { kind: 'field', field: 'block' });
    expect(plan.notes.join(' ')).toContain('rather than being discarded');

    const { dataset: after } = applyLayers(before, plan);
    // Every feature survives the split.
    expect(after.layers.reduce((total, layer) => total + layer.features.length, 0)).toBe(4);
  });

  it('splits by geometry type', () => {
    const mixed = dataset([createLayer('CAD', [point('1'), line('2'), point('3')])]);
    const { dataset: after } = applyLayers(mixed, planSplitLayer(mixed, 'CAD', { kind: 'geometry' }));
    expect(after.layers.map((layer) => layer.name)).toEqual(['CAD_Point', 'CAD_LineString']);
    expect(after.layers[0].features).toHaveLength(2);
  });

  it('applies exactly what it planned', () => {
    const before = parcels();
    const plan = planSplitLayer(before, 'Plots', { kind: 'field', field: 'block' });
    const { dataset: after } = applyLayers(before, plan);
    // The preview and the result are the same grouping, not two that agree.
    expect(after.layers.map((layer) => ({ name: layer.name, featureCount: layer.features.length }))).toEqual(
      plan.result.map((entry) => ({ name: entry.name, featureCount: entry.featureCount }))
    );
  });

  it('refuses to explode a layer into one part per feature', () => {
    const many = dataset([
      createLayer(
        'Points',
        Array.from({ length: SPLIT_LIMIT + 5 }, (_, index) => point(String(index), { id: index })),
        [{ name: 'id', type: 'integer' }]
      ),
    ]);
    const plan = planSplitLayer(many, 'Points', { kind: 'field', field: 'id' });
    expect(plan.refusal?.what).toContain(`${SPLIT_LIMIT + 5}`);
    expect(applyLayers(many, plan).dataset.layers).toHaveLength(1);
  });

  it('refuses a split that would produce one layer', () => {
    const uniform = dataset([createLayer('Plots', [point('1', { block: 'A' }), point('2', { block: 'A' })], [{ name: 'block', type: 'string' }])]);
    expect(planSplitLayer(uniform, 'Plots', { kind: 'field', field: 'block' }).refusal).toBeDefined();
  });

  it('refuses an unknown field, an empty layer and a locked layer', () => {
    expect(planSplitLayer(parcels(), 'Plots', { kind: 'field', field: 'nope' }).refusal).toBeDefined();
    expect(planSplitLayer(dataset([createLayer('Empty', [])]), 'Empty', { kind: 'geometry' }).refusal).toBeDefined();
    expect(planSplitLayer(parcels(), 'Plots', { kind: 'geometry' }, { protectedLayers: ['Plots'] }).refusal?.what).toContain('locked');
  });

  it('undoes back to one layer', () => {
    const before = parcels();
    const { dataset: after, plan } = applyLayers(before, planSplitLayer(before, 'Plots', { kind: 'field', field: 'block' }));
    expect(undoLayers(after, plan).layers).toHaveLength(1);
  });
});

// ===========================================================================
// Reorder, delete, style
// ===========================================================================

describe('reorder', () => {
  it('moves a layer and says order is data, not view', () => {
    const before = site();
    const plan = planReorder(before, 'Roads', 0);
    const { dataset: after } = applyLayers(before, plan);
    expect(after.layers.map((layer) => layer.name)).toEqual(['Roads', 'Plots', 'Boreholes']);
    expect(plan.notes[0]).toContain('draw order');
  });

  it('clamps an index past the end rather than dropping the layer', () => {
    const before = site();
    const { dataset: after } = applyLayers(before, planReorder(before, 'Plots', 99));
    expect(after.layers.map((layer) => layer.name)).toEqual(['Boreholes', 'Roads', 'Plots']);
  });

  it('undoes', () => {
    const before = site();
    const { dataset: after, plan } = applyLayers(before, planReorder(before, 'Roads', 0));
    expect(undoLayers(after, plan).layers.map((layer) => layer.name)).toEqual(['Plots', 'Boreholes', 'Roads']);
  });
});

describe('delete', () => {
  it('removes the layer and counts what goes with it', () => {
    const before = site();
    const planned = planDeleteLayer(before, 'Plots');
    expect(planned.notes[0]).toContain('2 feature');

    const { dataset: after, plan } = applyLayers(before, planned);
    expect(after.layers.map((layer) => layer.name)).toEqual(['Boreholes', 'Roads']);
    expect(undoLayers(after, plan).layers).toHaveLength(3);
  });

  it('refuses to delete the last layer', () => {
    const single = dataset([createLayer('Only', [point('1')])]);
    const plan = planDeleteLayer(single, 'Only');
    expect(plan.refusal?.why).toContain('no format can write');
    expect(applyLayers(single, plan).dataset.layers).toHaveLength(1);
  });

  it('refuses a locked layer', () => {
    expect(planDeleteLayer(site(), 'Plots', { protectedLayers: ['Plots'] }).refusal).toBeDefined();
  });
});

describe('style', () => {
  it('sets the style that will be written to the output', () => {
    const before = site();
    const { dataset: after } = applyLayers(before, planStyleLayer(before, 'Roads', { color: '#ff0000', lineWidth: 2 }));
    expect(after.layers[2].style).toMatchObject({ color: '#ff0000', lineWidth: 2 });
  });

  it('warns when an RGB colour replaces a CAD colour index', () => {
    const cad = dataset([{ ...createLayer('BOUNDARY', [line('1')]), style: { aci: 7 } }]);
    const plan = planStyleLayer(cad, 'BOUNDARY', { color: '#00ff00' });
    expect(plan.notes[0]).toContain('AutoCAD Color Index 7');
  });

  it('refuses a locked layer', () => {
    expect(planStyleLayer(site(), 'Plots', { color: '#000' }, { protectedLayers: ['Plots'] }).refusal).toBeDefined();
  });
});

// ===========================================================================
// Export-selected
// ===========================================================================

describe('export-selected', () => {
  it('keeps only the chosen layers and records the subset', () => {
    const subset = selectionForExport(site(), ['Plots', 'Roads']);
    expect(subset?.layers.map((layer) => layer.name)).toEqual(['Plots', 'Roads']);
    expect(subset?.warnings.some((warning) => warning.code === 'layers-subset')).toBe(true);
  });

  it('adds no warning when everything was selected', () => {
    const all = selectionForExport(site(), ['Plots', 'Boreholes', 'Roads']);
    expect(all?.warnings.some((warning) => warning.code === 'layers-subset')).toBe(false);
  });

  it('returns null rather than an empty export when nothing was selected', () => {
    expect(selectionForExport(site(), [])).toBeNull();
    expect(selectionForExport(site(), ['Nope'])).toBeNull();
  });

  it('ignores visibility — an export subset is chosen, not inferred', () => {
    const data = site();
    const hidden = setView(EMPTY_VIEW, 'Roads', { hidden: true });
    void hidden;
    // Hiding Roads does not change what an export of all three layers contains.
    expect(selectionForExport(data, ['Plots', 'Boreholes', 'Roads'])?.layers).toHaveLength(3);
  });
});

describe('describing a plan', () => {
  it('states the operation, its subjects and the resulting count', () => {
    expect(describeLayerPlan(planReorder(site(), 'Roads', 0))).toContain('Reorder layers: Roads → 3 layers');
  });

  it('gives the refusal in full when there is one', () => {
    const text = describeLayerPlan(planDeleteLayer(site(), 'Plots', { protectedLayers: ['Plots'] }));
    expect(text).toContain('locked');
    expect(text).toContain('Unlock it');
  });
});
