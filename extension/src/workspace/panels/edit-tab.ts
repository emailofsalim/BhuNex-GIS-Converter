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
import { EditCanvas, editTargetFor } from '../../ui/edit-canvas';
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
    ui.editTarget = target;
    ui.editCanvas?.setTarget(target);
    ui.editCanvas?.setEnabled(true);
    updateEditBar();
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

/** Snaps a dragged vertex, when snapping is on. */
export function snapDuringDrag(ref: VertexRef, to: number[]): number[] {
  if (!store.get().settings.editSnapEnabled) return to;

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

/** Keeps the edit toolbar and the readout panel in step with the selection. */
export function updateEditBar(): void {
  const toggle = $('editToggle');
  const on = ui.editCanvas?.isEnabled() ?? false;
  toggle.textContent = on ? 'Edit on' : 'Edit off';
  toggle.classList.toggle('btn--on', on);

  // The checkbox reflects the setting rather than only writing to it, so a
  // change made from the command palette shows here too.
  ($('editSnap') as HTMLInputElement).checked = store.get().settings.editSnapEnabled;

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
