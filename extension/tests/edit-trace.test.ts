/**
 * An edit must leave a trace of where the geometry was — and recording it must
 * not crash on the shape the workspace actually hands over.
 *
 * TWO DEFECTS, ONE GESTURE
 *
 * 1. NOTHING TO COMPARE AGAINST. Dragging a boundary moved it and erased the
 *    position it came from. A surveyor nudging a corner could not see how far
 *    it had gone, or put it back by eye. Now the pre-edit geometry stays on the
 *    canvas as a grey dashed ghost for as long as the edits are pending.
 *
 * 2. THE RECORDER CRASHED ON THE FIRST MOVE. `diffLayer` read `.features` off
 *    each layer. That is the CIR shape. The workspace's own layers carry
 *    `preview` instead — the summarised form the canvas draws — so the first
 *    drag threw "Cannot read properties of undefined (reading 'length')" out of
 *    `recordOperation`, after the command had already been queued.
 *
 *    It had been latent the whole time: the Move tool's engine was never
 *    enabled (see tool-enabled.test.ts), so no drag ever reached the recorder.
 *    Switching the tools on is what exposed it. Measured in a browser: the
 *    exception fired on mouse-up and the move was lost.
 */

import { describe, expect, it } from 'vitest';
import { createHistory, diffDatasets, recordOperation } from '@core/history';
import type { CirDataset, CirFeature } from '@core/cir';

/** A square parcel, as a feature. */
function parcel(x: number, y: number): CirFeature {
  return {
    geometry: {
      type: 'Polygon',
      coordinates: [[[x, y], [x + 60, y], [x + 60, y + 45], [x, y + 45], [x, y]]],
    },
    properties: { plot: '12/A' },
  } as unknown as CirFeature;
}

/** A layer in the CIR shape: features live on `features`. */
function cirDataset(x: number, y: number): CirDataset {
  return {
    layers: [{ name: 'PARCEL', fields: [], geometryTypes: ['Polygon'], features: [parcel(x, y)] }],
  } as unknown as CirDataset;
}

/**
 * A layer in the WORKSPACE shape: features live on `preview`, alongside the
 * true count, because the canvas only ever draws a summarised subset.
 */
function workspaceDataset(x: number, y: number): CirDataset {
  return {
    layers: [
      {
        name: 'PARCEL',
        fields: [],
        geometryTypes: ['Polygon'],
        preview: [parcel(x, y)],
        featureCount: 1,
        previewTruncated: false,
      },
    ],
  } as unknown as CirDataset;
}

describe('recording an edit survives the shape the workspace hands over', () => {
  it('does not throw when layers carry `preview` instead of `features`', () => {
    // THE CRASH, exactly as it reached the user: queue a move, record it.
    expect(() =>
      recordOperation(createHistory(), workspaceDataset(0, 0), workspaceDataset(140, 95), {
        kind: 'edit',
        label: 'Move',
      })
    ).not.toThrow();
  });

  it('still finds the moved feature, rather than merely not crashing', () => {
    // A `?? []` that silently reported "nothing changed" would pass the test
    // above and leave every workspace edit unrecorded — an undo that does
    // nothing. So assert the patch is actually there.
    const change = diffDatasets(workspaceDataset(0, 0), workspaceDataset(140, 95));
    expect(change.features).toHaveLength(1);
    expect(change.features[0].layer).toBe('PARCEL');
    expect(change.features[0].before).not.toBeNull();
    expect(change.features[0].after).not.toBeNull();
  });

  it('reports the same change whichever shape the layers arrive in', () => {
    // The two shapes describe the same edit. If they diverged, an undo recorded
    // from the canvas would restore something different from one recorded by
    // the conversion path.
    const fromWorkspace = diffDatasets(workspaceDataset(0, 0), workspaceDataset(140, 95));
    const fromCir = diffDatasets(cirDataset(0, 0), cirDataset(140, 95));
    expect(fromWorkspace.features).toEqual(fromCir.features);
  });

  it('records nothing for an edit that moved nothing', () => {
    const change = diffDatasets(workspaceDataset(0, 0), workspaceDataset(0, 0));
    expect(change.features).toHaveLength(0);
  });

  it('tolerates a layer with neither shape rather than throwing', () => {
    // An empty layer created by a split or a filter has no features at all.
    const bare = { layers: [{ name: 'PARCEL', fields: [], geometryTypes: [] }] } as unknown as CirDataset;
    expect(() => diffDatasets(bare, workspaceDataset(0, 0))).not.toThrow();
  });
});

/**
 * Drives the real `queueEdit`, not a re-statement of its guard.
 *
 * An earlier draft of these two cases copied the `if (!ui.editTrace)` line into
 * the test and asserted on that. It passed with the feature deleted, which is
 * the definition of a test that measures nothing. So the store is loaded for
 * real, the host is stubbed at its one seam, and the edits go through the
 * function the toolbar calls.
 */
async function workspace() {
  const [{ store }, { installHost }, { ui }, edits, canvas] = await Promise.all([
    import('../src/state/store'),
    import('../src/workspace/host'),
    import('../src/workspace/ui-state'),
    import('../src/workspace/panels/edits'),
    import('../src/workspace/panels/canvas'),
  ]);
  // The host throws by design until `main.ts` wires it; a stub is the seam.
  installHost({ render: () => undefined });
  ui.editTrace = null;
  ui.previewCanvas = null;

  const item = { id: 'parcel-1', name: 'parcel.dxf', dataset: workspaceDataset(0, 0), edits: [] };
  store.set({ items: [item as never], selectedId: item.id });
  const current = () => store.get().items.find((each) => each.id === 'parcel-1')!;
  return { store, ui, current, ...edits, clearPreview: canvas.clearPreview };
}

describe('the trace lives exactly as long as the edits it is the ghost of', () => {
  it('is captured before the first edit and not refreshed by later ones', async () => {
    // The useful comparison is against the file as it ARRIVED. Refreshing the
    // trace per edit would make three small corrections show where the parcel
    // was one nudge ago rather than where it started.
    const { ui, current, queueEdit } = await workspace();
    const asImported = current().dataset;

    queueEdit(current(), { kind: 'set', layer: 'PARCEL', field: 'plot', value: '13/B' }, {}, 'Set plot');
    const afterFirst = ui.editTrace;
    expect(afterFirst, 'no trace was captured at all').toBe(asImported);

    // The dataset has moved on by now, so a per-edit capture would replace it.
    queueEdit(current(), { kind: 'set', layer: 'PARCEL', field: 'plot', value: '14/C' }, {}, 'Set plot again');
    expect(ui.editTrace, 'the trace was refreshed by the second edit').toBe(asImported);
    expect(current().edits).toHaveLength(2);
  });

  it('is dropped when every edit is discarded', async () => {
    // A ghost outliving its edits is a grey outline of a change the user has
    // just undone — the most confusing thing that can be on the canvas.
    const { ui, current, queueEdit, rebuildPreviewFrom } = await workspace();
    queueEdit(current(), { kind: 'set', layer: 'PARCEL', field: 'plot', value: '13/B' }, {}, 'Set plot');
    expect(ui.editTrace).not.toBeNull();

    rebuildPreviewFrom(current(), []);
    expect(ui.editTrace).toBeNull();
  });

  it('survives an undo that leaves edits behind', async () => {
    // Undoing the last of three corrections must not erase the comparison the
    // other two are still judged against.
    const { ui, current, queueEdit, rebuildPreviewFrom } = await workspace();
    const asImported = current().dataset;
    queueEdit(current(), { kind: 'set', layer: 'PARCEL', field: 'plot', value: '13/B' }, {}, 'One');
    queueEdit(current(), { kind: 'set', layer: 'PARCEL', field: 'plot', value: '14/C' }, {}, 'Two');

    rebuildPreviewFrom(current(), current().edits!.slice(0, -1));
    expect(ui.editTrace).toBe(asImported);
  });

  it('is dropped when the file itself goes', async () => {
    // Cutting or clearing the queue leaves no geometry for a ghost to be the
    // ghost OF, and the next file would open under the last one's outline.
    const { ui, current, queueEdit, clearPreview } = await workspace();
    queueEdit(current(), { kind: 'set', layer: 'PARCEL', field: 'plot', value: '13/B' }, {}, 'Set plot');
    expect(ui.editTrace).not.toBeNull();

    clearPreview();
    expect(ui.editTrace).toBeNull();
  });
});
