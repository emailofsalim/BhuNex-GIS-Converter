/**
 * The vertex editor's panel: target selection, the toolbar, and the readout.
 *
 * The interaction layer (`ui/edit-canvas.ts`) owns no geometry. Every change
 * leaves here as a PLAN that the engine applies, so the editor's refusals still
 * hold and the history records it.
 */

import { recordOperation } from '../../core/history';
import { formatDms, METHOD_LABEL } from '../../core/measure';
import {
  applyEdit,
  describeEditPlan,
  planDeleteVertex,
  planInsertVertex,
  planMoveMany,
  planMoveVertex,
  readVertex,
  type VertexRef,
} from '../../core/vertex-edit';
import { planVertexSnap } from '../../qa/snap';
import { type QueueItem, store } from '../../state/store';
import { hitTest } from '../../core/selection';
import { EditCanvas, editTargetFor, PICK_RADIUS_PX } from '../../ui/edit-canvas';
import { $, element, keyValues } from '../dom';
import { host } from '../host';
import { historyOf } from './history';
import { ui } from '../ui-state';

/**
 * The Edit tab: pick a feature, then edit it on the canvas.
 *
 * A feature has to be chosen explicitly rather than inferred from a click,
 * because the editor's guarantee is that nothing moves unless it was named —
 * the same rule `qa/snap.ts` follows. Opening a feature is the naming.
 */
export function editTab(item: QueueItem): HTMLElement[] {
  const wrap = element('div', { style: 'padding:12px' });

  const layers = (item.dataset?.layers ?? []) as any[];
  if (layers.length === 0) {
    wrap.append(element('p', { class: 'muted', text: 'This file has no vector layers to edit.' }));
    return [wrap];
  }

  wrap.append(
    element('p', {
      class: 'small faint',
      text: 'Editing works on the preview geometry. Every change is recorded in the History tab and can be undone; a protected layer refuses to change at all.',
    })
  );

  const picker = element('div', { class: 'section' });
  picker.append(element('h3', { class: 'section__title', text: 'Feature to edit' }));

  const layerSelect = element('select', { class: 'input' }) as HTMLSelectElement;
  for (const layer of layers) {
    layerSelect.append(element('option', { value: layer.name, text: `${layer.name} (${(layer.preview ?? []).length} shown)` }));
  }
  layerSelect.value = ui.editTarget?.layer ?? layers[0].name;
  picker.append(layerSelect);

  const featureSelect = element('select', { class: 'input', style: 'margin-top:8px' }) as HTMLSelectElement;
  const fillFeatures = () => {
    featureSelect.replaceChildren();
    const layer = layers.find((candidate) => candidate.name === layerSelect.value);
    const features = (layer?.preview ?? []) as any[];
    features.forEach((feature, index) => {
      const type = feature.geometry?.type ?? 'none';
      const label = feature.id !== undefined ? `${feature.id} — ${type}` : `#${index} — ${type}`;
      featureSelect.append(element('option', { value: String(index), text: label }));
    });
    if (features.length === 0) featureSelect.append(element('option', { value: '', text: 'No features in this layer' }));
  };
  fillFeatures();
  if (ui.editTarget && ui.editTarget.layer === layerSelect.value) featureSelect.value = String(ui.editTarget.featureIndex);
  picker.append(featureSelect);

  const open = element('button', { class: 'btn btn--primary', type: 'button', text: 'Open on the canvas', style: 'margin-top:8px' });
  const openSelected = () => {
    const index = Number(featureSelect.value);
    if (!Number.isFinite(index)) return;
    const layer = layers.find((candidate) => candidate.name === layerSelect.value);
    const feature = (layer?.preview ?? [])[index];
    const target = editTargetFor(layerSelect.value, index, feature?.geometry);

    if (!target) {
      store.log('warn', 'That geometry has no editable vertices — points and geometry collections are not vertex-editable.');
      host.render();
      return;
    }
    openForVertexEdit(layerSelect.value, index, feature?.geometry);
    host.render();
  };
  open.addEventListener('click', openSelected);
  layerSelect.addEventListener('change', fillFeatures);
  picker.append(open);
  wrap.append(picker);

  if (ui.editTarget) {
    const active = element('div', { class: 'section' });
    active.append(element('h3', { class: 'section__title', text: 'Selected vertex' }));
    active.append(element('div', { id: 'editReadoutPanel' }));
    wrap.append(active);
  }

  return [wrap];
}

/**
 * Opens one feature for vertex editing, wherever the request came from.
 *
 * The panel's "Open on the canvas" button and a click on the drawing itself
 * both land here, so the two routes cannot drift — the click is not a second,
 * looser path that skips the geometry check the button makes.
 */
export function openForVertexEdit(layerName: string, index: number, geometry: unknown): boolean {
  const target = editTargetFor(layerName, index, geometry as never);
  if (!target) return false;
  ui.editTarget = target;
  ui.editCanvas?.setTarget(target);
  ui.editCanvas?.setEnabled(true);
  updateEditBar();
  return true;
}

/**
 * The feature under a world position, in the preview the canvas draws.
 *
 * ONE hit test behind three callers — the click that opens a feature, the
 * hover that pre-highlights it, and (through `hitTest`) the Select tool — so
 * "what is under the cursor" cannot be answered differently depending on which
 * gesture asked. The pick radius is converted from the canvas's screen
 * tolerance, so the target stays the same size under the finger at any zoom.
 */
function featureUnder(world: { x: number; y: number }): { layer: string; index: number; geometry: unknown } | null {
  const item = store.selected();
  const layers = (item?.dataset?.layers ?? []).map((layer: any) => ({
    name: layer.name,
    visible: layer.visible !== false,
    features: layer.preview ?? [],
  }));
  if (layers.length === 0) return null;

  const scale = ui.previewCanvas?.getView().scale ?? 1;
  const tolerance = PICK_RADIUS_PX / (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const hit = hitTest(layers as never, [world.x, world.y], tolerance);
  if (!hit) return null;

  const layer = layers.find((candidate: any) => candidate.name === hit.ref.layer);
  return { layer: hit.ref.layer, index: hit.ref.index, geometry: (layer?.features ?? [])[hit.ref.index]?.geometry };
}

/**
 * The rings a click would open, for the canvas's pre-highlight.
 *
 * Deliberately built through `editTargetFor`, the same function the click
 * uses: a feature that cannot be vertex-edited produces no target and so
 * lights up nothing, rather than inviting a click that would only log a
 * refusal.
 */
export function ringsUnderPointer(world: { x: number; y: number }): number[][][] | null {
  const hit = featureUnder(world);
  if (!hit) return null;
  return editTargetFor(hit.layer, hit.index, hit.geometry as never)?.rings ?? null;
}

/**
 * Closes the open feature and goes back to picking one.
 *
 * `ui.editTarget` is the panel's copy; clearing only the canvas's would let
 * the next render re-open the feature Escape just dismissed.
 */
export function closeVertexEdit(): void {
  ui.editTarget = null;
  ui.editSelection = [];
  updateEditBar();
  host.render();
}

/**
 * The feature under the pointer, opened for editing.
 *
 * Hit-tests the same preview dataset the canvas draws, with the same helper
 * `ToolCanvas` uses to decide what a click selected — so "what the Vertex tool
 * opens" and "what the Select tool picks" can never disagree about which
 * feature is under the cursor.
 */
export function pickFeatureForEdit(world: { x: number; y: number }): boolean {
  const hit = featureUnder(world);
  if (!hit) return false;

  const opened = openForVertexEdit(hit.layer, hit.index, hit.geometry);
  if (!opened) {
    store.log('warn', `${hit.layer}: that geometry has no editable vertices — a point or a geometry collection cannot be vertex-edited.`);
  }
  host.render();

  // RE-CLAIM THE OVERLAY, AFTER the render and not before it.
  //
  // The canvas has ONE overlay hook and `renderPreview` resets it, which is why
  // `renderEdit` takes it back rather than relying on the constructor. Calling
  // `host.render()` here therefore handed the hook away a moment after the
  // editor had been armed: the target was set, the panel updated, and the
  // vertices were not drawn — the tool looked exactly as dead as before the
  // fix, for a completely different reason.
  if (opened) {
    ui.editCanvas?.reattach();
    ui.previewCanvas?.render();
  }
  return opened;
}

/** Creates the interaction layer the first time the Edit tab is opened. */
export function renderEdit(item: QueueItem): void {
  if (!ui.previewCanvas) return;
  if (!ui.editCanvas) {
    ui.editCanvas = new EditCanvas(ui.previewCanvas, {
      onMoveVertex: (ref, to) => commitEdit(planMoveVertex(datasetForEdit(), ref, to, editOptions())),
      onMoveMany: (refs, offset) => commitEdit(planMoveMany(datasetForEdit(), refs, offset, editOptions())),
      onInsertVertex: (ref, at) => commitEdit(planInsertVertex(datasetForEdit(), ref, at, editOptions())),
      onDeleteVertices: (refs) => {
        // Deleting several at once would need each refusal checked against the
        // ring as it shrinks; one at a time keeps the guard honest.
        if (refs.length !== 1) {
          store.log('warn', 'Delete one vertex at a time: each deletion is checked against what the ring would become.');
          host.render();
          return;
        }
        commitEdit(planDeleteVertex(datasetForEdit(), refs[0], editOptions()));
      },
      onSelectionChange: (refs) => {
        ui.editSelection = refs;
        updateEditBar();
      },
      onDragPosition: (position) => {
        $('editReadout').textContent = `${position[0].toFixed(3)}, ${position[1].toFixed(3)}`;
      },
      snap: (ref, to) => snapDuringDrag(ref, to),
      onPickFeature: (world) => pickFeatureForEdit(world),
      ringsUnder: (world) => ringsUnderPointer(world) as never,
      onCloseTarget: () => closeVertexEdit(),
    });
  }

  void item;
  // `renderPreview` runs first and resets the shared overlay hook, so the
  // editor takes it back here rather than only in its constructor.
  ui.editCanvas.reattach();
  if (ui.editTarget) ui.editCanvas.setTarget(ui.editTarget);
  updateEditBar();
}

/**
 * The dataset the editor works on.
 *
 * This is the worker's PREVIEW summary, not the full CIR — the same object the
 * canvas draws. Edits therefore change what is previewed and what the history
 * records; the conversion itself always re-reads the source in the worker, so
 * an edit here cannot silently diverge from what gets written.
 */
export function datasetForEdit(): any {
  const item = store.selected();
  return { layers: (item?.dataset?.layers ?? []).map((layer: any) => ({ name: layer.name, features: layer.preview ?? [] })) };
}

export function editOptions() {
  const settings = store.get().settings;
  const item = store.selected();
  return {
    protectedLayers: settings.protectedLayers ?? [],
    measure: { crs: item?.dataset?.crs ?? null, units: item?.dataset?.units ?? null },
  };
}

/**
 * Snaps a dragged vertex, when snapping is on.
 *
 * "On" now means the one Snap button on the canvas toolbar. It used to mean
 * `settings.editSnapEnabled`, a second snap control that only governed vertex
 * dragging and lived in a different panel from the one that governed drawing —
 * so whichever the user found, the other half of their editing did not snap.
 * The setting is still the persisted default; the toolbar is the live switch.
 */
export function snapDuringDrag(ref: VertexRef, to: number[]): number[] {
  if (ui.snapOn === false) return to;

  // Snap against a dataset in which the dragged vertex already sits at the
  // pointer, so the snap sees the position being proposed rather than the one
  // being left behind.
  const data = datasetForEdit();
  const layer = data.layers.find((candidate: any) => candidate.name === ref.layer);
  const feature = layer?.features[ref.featureIndex];
  if (!feature) return to;

  const plan = planVertexSnap(data, [{ layer: ref.layer, featureIndex: ref.featureIndex }], {
    tolerance: store.get().settings.snapTolerance || 0.05,
  });
  const move = plan.moves.find((candidate) => candidate.ring === ref.ring && candidate.vertex === ref.vertex);
  return move ? move.to : to;
}

/**
 * Applies an edit plan and records it in the history.
 *
 * A refusal is logged with its reason rather than swallowed: the whole point of
 * the editor's guards is that the user finds out why the gesture did nothing.
 */
export function commitEdit(plan: ReturnType<typeof planMoveVertex>): void {
  const item = store.selected();
  if (!item) return;

  if (plan.refusal) {
    store.log('warn', `${plan.refusal.what} ${plan.refusal.why} ${plan.refusal.action}`);
    host.render();
    return;
  }
  if (plan.changes.length === 0) return;

  const before = datasetForEdit();
  const applied = applyEdit(before, plan);

  // Write the edited rings back into the preview dataset the UI holds.
  const dataset = {
    ...item.dataset,
    layers: (item.dataset.layers ?? []).map((layer: any) => {
      const edited = applied.dataset.layers.find((candidate: any) => candidate.name === layer.name);
      return edited ? { ...layer, preview: edited.features } : layer;
    }),
  };

  store.updateItem(item.id, {
    dataset,
    // The command, not just its result. Without this the edit changed the
    // PREVIEW and nothing else: conversion re-reads the source file in the
    // worker and replays `item.edits`, so a vertex moved here never reached
    // the exported bytes. The editor looked like it worked, the canvas showed
    // the corrected boundary, and the delivered file had the original one.
    //
    // `core/edits.ts` has handled `{ kind: 'vertices' }` since it was written,
    // including the guard for a plan addressing a feature the source no longer
    // has. It was a complete replay path with nothing constructing its input.
    //
    // The plan is stored as computed rather than re-planned, unlike a geometry
    // operation: a vertex move is a list of exact coordinates the user placed,
    // and the preview is a PREFIX of the layer, so feature index i means the
    // same thing in both. Re-planning could only move it somewhere else.
    edits: [...(item.edits ?? []), { kind: 'vertices', plan }],
    history: recordOperation(historyOf(item), item.dataset, dataset, {
      kind: 'edit',
      label: describeEditPlan(plan),
      maxDisplacement: plan.maxDisplacement,
    }),
  });

  // Re-open the target so the handles follow the geometry they now describe.
  if (ui.editTarget) {
    const layer = dataset.layers.find((candidate: any) => candidate.name === ui.editTarget!.layer);
    const feature = (layer?.preview ?? [])[ui.editTarget.featureIndex];
    const refreshed = editTargetFor(ui.editTarget.layer, ui.editTarget.featureIndex, feature?.geometry);
    if (refreshed) {
      ui.editTarget = refreshed;
      ui.editCanvas?.setTarget(refreshed);
    }
  }

  store.log('ok', describeEditPlan(plan));
  host.render();
}

/**
 * Keeps the vertex readout in step with the selection.
 *
 * The "Edit on/off" button and the snap checkbox that used to live here are
 * gone: vertex editing is the `vertex` tool on the one canvas toolbar, and snap
 * is the one Snap button beside it. Two separate snap controls — one for
 * drawing, one for vertex editing — was a distinction only the code cared
 * about, and left the user to discover that turning "Snap" on did not snap the
 * thing they were dragging.
 */
export function updateEditBar(): void {
  const panel = document.getElementById('editReadoutPanel');
  if (!panel) return;
  panel.replaceChildren();

  if (ui.editSelection.length === 0) {
    panel.append(element('p', { class: 'muted small', text: 'No vertex selected. Click one on the canvas.' }));
    return;
  }
  if (ui.editSelection.length > 1) {
    panel.append(element('p', { class: 'small', text: `${ui.editSelection.length} vertices selected. Drag any one to move them together.` }));
    return;
  }

  const readout = readVertex(datasetForEdit(), ui.editSelection[0], editOptions());
  if (!readout) return;

  const rows: [string, string][] = [
    ['X', readout.x.toFixed(4)],
    ['Y', readout.y.toFixed(4)],
  ];
  if (readout.z !== undefined) rows.push(['Z', readout.z.toFixed(4)]);
  rows.push(['Vertex', `${readout.index + 1} of ${readout.ringVertexCount}${readout.isRingEndpoint ? ' (ring endpoint)' : ''}`]);
  if (readout.fromPrevious) {
    rows.push(['From previous', `${readout.fromPrevious.length.text} at ${formatDms(readout.fromPrevious.bearing.value)}`]);
  }
  if (readout.toNext) {
    rows.push(['To next', `${readout.toNext.length.text} at ${formatDms(readout.toNext.bearing.value)}`]);
  }
  if (readout.perimeter) rows.push(['Perimeter', readout.perimeter.text]);
  if (readout.area) rows.push(['Area', readout.area.text]);

  panel.append(keyValues(rows));

  const method = readout.fromPrevious?.length.method ?? readout.perimeter?.method;
  if (method) {
    panel.append(element('p', { class: 'small faint', style: 'margin-top:6px', text: METHOD_LABEL[method] }));
  }
}

// ------------------------------------------------------------ settings panel
