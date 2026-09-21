/**
 * The undo stack, against the dataset shape the workspace actually holds.
 *
 * WHY THESE TESTS LOOK ODD AT FIRST
 *
 * Every history test before this one built a CIR dataset by hand — layers with
 * a `features` array. The workspace never holds one of those. `summarise()`
 * hands the UI a layer carrying `preview` instead, and the history is recorded
 * from and applied to THAT. So the whole apply path had never been run against
 * the only shape it meets in production, and it did not work: `applyChange`
 * read `layer.features.slice()` and threw
 *
 *     TypeError: Cannot read properties of undefined (reading 'slice')
 *
 * on every entry that touched a feature. The History panel's Undo button was
 * broken for the entire class of operation it exists to reverse.
 *
 * The fixtures here are therefore deliberately in the SUMMARISED shape. A test
 * that builds a convenient CIR dataset re-creates the blind spot that hid this.
 */

import { describe, expect, it } from 'vitest';
import {
  applyChange,
  createHistory,
  diffDatasets,
  editsAt,
  recordOperation,
  redo,
  undo,
  weightOf,
  type HistoryState,
} from '../src/core/history';
import type { CirDataset } from '../src/core/cir';
import type { EditCommand } from '../src/core/edits';

/** A layer in the shape `summarise()` produces: `preview`, never `features`. */
function summarisedLayer(name: string, xs: number[]): unknown {
  return {
    name,
    featureCount: xs.length,
    geometryTypes: ['Point'],
    fields: [],
    preview: xs.map((x, index) => ({
      id: `f${index}`,
      geometry: { type: 'Point', dimension: 2, coordinates: [x, 0] },
      properties: {},
      sourceLayer: name,
    })),
    previewTruncated: false,
  };
}

function workspaceDataset(xs: number[], name = 'L'): CirDataset {
  return {
    kind: 'vector',
    name: 'survey',
    source: 'test',
    crs: null,
    crsOrigin: 'unknown',
    units: 'm',
    warnings: [],
    metadata: {},
    layers: [summarisedLayer(name, xs)],
  } as unknown as CirDataset;
}

/** The x coordinates a dataset's single layer is holding, whichever key it uses. */
function xsOf(dataset: CirDataset): number[] {
  const layer = dataset.layers[0] as unknown as {
    preview?: { geometry: { coordinates: number[] } }[];
    features?: { geometry: { coordinates: number[] } }[];
  };
  return (layer.preview ?? layer.features ?? []).map((feature) => feature.geometry.coordinates[0]);
}

const moveCommand = (to: number): EditCommand =>
  ({ kind: 'translate', layer: 'L', dx: to, dy: 0 }) as unknown as EditCommand;

describe('undo against the shape the workspace really holds', () => {
  it('reverses an edit instead of throwing on a layer with no .features', () => {
    const before = workspaceDataset([0, 1]);
    const after = workspaceDataset([0, 9]);
    const history = recordOperation(createHistory(), before, after, { kind: 'edit', label: 'Move' });

    const stepped = undo(history, after);

    expect(xsOf(stepped.dataset)).toEqual([0, 1]);
  });

  it('writes the patch back under the key it read, leaving no second copy', () => {
    // Returning `{...layer, features}` for a summarised layer would leave the
    // stale `preview` in place — and `preview` is what the canvas draws, so the
    // undo would appear to do nothing while the data said otherwise.
    const after = workspaceDataset([0, 9]);
    const history = recordOperation(createHistory(), workspaceDataset([0, 1]), after, { kind: 'edit', label: 'Move' });

    const layer = undo(history, after).dataset.layers[0] as unknown as Record<string, unknown>;

    expect(Array.isArray(layer.preview)).toBe(true);
    expect(layer.features).toBeUndefined();
  });

  it('is symmetric: undo then redo returns exactly what was there', () => {
    const before = workspaceDataset([0, 1, 2]);
    const after = workspaceDataset([0, 9, 2]);
    const history = recordOperation(createHistory(), before, after, { kind: 'edit', label: 'Move' });

    const back = undo(history, after);
    const forward = redo(back.history, back.dataset);

    expect(xsOf(back.dataset)).toEqual([0, 1, 2]);
    expect(xsOf(forward.dataset)).toEqual([0, 9, 2]);
  });

  it('walks a long run of edits all the way back to the file as imported', () => {
    // The case the old toolbar undo handled by replaying every remaining
    // command from pristine on each step. Forty edits cost it about eight
    // hundred command applications; this reverses one patch per step.
    let dataset = workspaceDataset([0]);
    let history: HistoryState = createHistory();
    for (let step = 1; step <= 40; step++) {
      const next = workspaceDataset([step]);
      history = recordOperation(history, dataset, next, { kind: 'edit', label: `Move ${step}` });
      dataset = next;
    }
    expect(xsOf(dataset)).toEqual([40]);

    while (history.position > 0) {
      const stepped = undo(history, dataset);
      history = stepped.history;
      dataset = stepped.dataset;
    }

    expect(xsOf(dataset)).toEqual([0]);
  });
});

describe('the command list follows the history position', () => {
  it('drops an undone edit from the commands the conversion will replay', () => {
    // THE BUG THIS PINS: `item.edits` is what `pipeline.ts` replays onto the
    // freshly-read source, and it is the only thing that reaches the exported
    // file. It used to be kept alongside the history rather than derived from
    // it, so undoing an edit reverted the drawing on screen and shipped the
    // edit anyway — with the preview standing as evidence that it had not.
    const first = workspaceDataset([0]);
    const second = workspaceDataset([1]);
    const third = workspaceDataset([2]);

    let history = recordOperation(createHistory(), first, second, {
      kind: 'edit',
      label: 'Move 1',
      command: moveCommand(1),
    });
    history = recordOperation(history, second, third, { kind: 'edit', label: 'Move 2', command: moveCommand(2) });

    expect(editsAt(history)).toHaveLength(2);

    const back = undo(history, third);
    expect(editsAt(back.history)).toHaveLength(1);

    const further = undo(back.history, back.dataset);
    expect(editsAt(further.history)).toHaveLength(0);
  });

  it('leaves out entries that carry no command, so a CRS assignment is not an edit', () => {
    // Assigning a CRS is undoable and is NOT a replayable edit command. If it
    // leaked into `edits` the pipeline would be handed something it cannot
    // replay.
    const before = workspaceDataset([0]);
    const after = { ...workspaceDataset([0]), crs: { epsg: 32645, name: 'UTM 45N', kind: 'projected' } } as CirDataset;
    const history = recordOperation(createHistory(), before, after, { kind: 'crs-assign', label: 'Assign CRS' });

    expect(history.entries).toHaveLength(1);
    expect(editsAt(history)).toHaveLength(0);
  });

  it('keeps an edit APPLIED once it is too old to undo', () => {
    // An entry that falls off the front stops being reversible. It must not
    // stop being applied: silently removing it from the command list would
    // ship a file missing an edit the user made and never took back. Losing
    // the ability to reverse something is a documented limit; losing the
    // something is data loss.
    let dataset = workspaceDataset([0]);
    let history: HistoryState = createHistory();
    for (let step = 1; step <= 5; step++) {
      const next = workspaceDataset([step]);
      history = recordOperation(history, dataset, next, {
        kind: 'edit',
        label: `Move ${step}`,
        command: moveCommand(step),
        // A cap of two, so three of the five are forced out.
      }, { limit: 2 });
      dataset = next;
    }

    expect(history.entries).toHaveLength(2);
    expect(history.dropped).toBe(3);
    expect(history.baseEdits).toHaveLength(3);
    // All five survive as commands: three banked, two still undoable.
    expect(editsAt(history)).toHaveLength(5);
  });
});

describe('the budget is spent on what an entry actually costs', () => {
  it('weighs a one-feature edit at one and a whole-layer rewrite at its size', () => {
    const small = diffDatasets(workspaceDataset([0, 1, 2]), workspaceDataset([0, 9, 2]));
    const large = diffDatasets(workspaceDataset([0, 1, 2]), workspaceDataset([7, 8, 9]));

    expect(weightOf({ change: small } as never)).toBe(1);
    expect(weightOf({ change: large } as never)).toBe(3);
  });

  it('keeps cheap steps in depth, which is the whole point', () => {
    // Counting entries alone treats a one-vertex nudge and a reprojection of
    // the whole drawing as the same size. A run of small corrections is
    // exactly what a surveyor walks backwards through, so it is kept.
    let dataset = workspaceDataset([0, 0, 0]);
    let history: HistoryState = createHistory();
    for (let step = 1; step <= 300; step++) {
      const next = workspaceDataset([step, 0, 0]);
      history = recordOperation(history, dataset, next, { kind: 'edit', label: `Nudge ${step}` });
      dataset = next;
    }

    expect(history.entries).toHaveLength(300);
    expect(history.dropped).toBe(0);
  });

  it('bounds heavy entries by their weight rather than by a count that cannot see them', () => {
    // Each of these rewrites every feature, so a flat entry cap would hold all
    // of them in memory. The weight bound does not.
    const wide = (seed: number) => workspaceDataset(Array.from({ length: 400 }, (_, i) => seed * 1000 + i));
    let dataset = wide(0);
    let history: HistoryState = createHistory();
    for (let step = 1; step <= 12; step++) {
      const next = wide(step);
      history = recordOperation(history, dataset, next, { kind: 'reproject', label: `Reproject ${step}` }, { limit: 1000, maxPatchedFeatures: 2000 });
      dataset = next;
    }

    expect(history.entries.length).toBeLessThanOrEqual(5);
    expect(history.dropped).toBeGreaterThan(0);
    const retained = history.entries.reduce((sum, entry) => sum + weightOf(entry), 0);
    expect(retained).toBeLessThanOrEqual(2000);
  });

  it('never drops the entry it has just recorded, however heavy', () => {
    // An operation larger than the entire budget would otherwise be
    // unrecordable, and therefore unundoable the instant it happened — the
    // one moment a user is most likely to want it back.
    const huge = workspaceDataset(Array.from({ length: 5000 }, (_, i) => i));
    const history = recordOperation(createHistory(), workspaceDataset([0]), huge, { kind: 'reproject', label: 'Reproject' }, { limit: 1000, maxPatchedFeatures: 10 });

    expect(history.entries).toHaveLength(1);
    expect(history.position).toBe(1);
  });
});

describe('applyChange on a CIR dataset still behaves', () => {
  it('reads and writes `features` when that is the key the layer uses', () => {
    const cir = (xs: number[]) =>
      ({
        kind: 'vector',
        name: 'n',
        source: 's',
        crs: null,
        crsOrigin: 'unknown',
        units: 'm',
        warnings: [],
        metadata: {},
        layers: [
          {
            name: 'L',
            geometryTypes: ['Point'],
            fields: [],
            features: xs.map((x, i) => ({
              id: `f${i}`,
              geometry: { type: 'Point', dimension: 2, coordinates: [x, 0] },
              properties: {},
              sourceLayer: 'L',
            })),
          },
        ],
      }) as unknown as CirDataset;

    const change = diffDatasets(cir([0, 1]), cir([0, 9]));
    const reversed = applyChange(cir([0, 9]), change, 'before');
    const layer = reversed.layers[0] as unknown as Record<string, unknown>;

    expect(xsOf(reversed)).toEqual([0, 1]);
    expect(Array.isArray(layer.features)).toBe(true);
    expect(layer.preview).toBeUndefined();
  });
});
