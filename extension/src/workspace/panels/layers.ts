/** The layer manager (spec §25.4): the tree, and the operations on it. */

import {
  describeLayerPlan,
  layerTree,
  type LayerTreeNode,
  listLayers,
  opacityOf,
  planDeleteLayer,
  planMergeLayers,
  planRenameLayer,
  planSplitLayer,
  setAllHidden,
  setView as setLayerView,
  toggleIsolate,
} from '../../core/layers';
import { type QueueItem, store } from '../../state/store';
import { editDialog, element, ghostButton, messageBlock } from '../dom';
import { host } from '../host';
import { datasetForTools, protectedFor, tableStateOf, truncationOf, viewOf } from './dataset';
import { pendingEditsPanel, queueEdit } from './edits';
import { ui } from '../ui-state';

export function layersTab(item: QueueItem): HTMLElement[] {
  const data = datasetForTools(item);
  if (data.layers.length === 0) {
    return [element('p', { class: 'muted', style: 'padding:16px', text: 'This file has no layers.' })];
  }

  const view = viewOf(item);
  const nodes: HTMLElement[] = [];
  const search = ui.layerSearch;

  // Toolbar -------------------------------------------------------------
  const bar = element('div', { class: 'lm__bar' });
  const searchBox = element('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search layers and folders…',
    value: search,
    'aria-label': 'Search layers',
  }) as HTMLInputElement;
  searchBox.addEventListener('input', () => {
    ui.layerSearch = searchBox.value;
    host.renderInspector();
  });
  bar.append(searchBox);

  bar.append(
    ghostButton('Show all', () => {
      const names = data.layers.map((layer: any) => layer.name);
      store.updateItem(item.id, { layerView: setAllHidden(view, names, false) });
      host.render();
    })
  );
  bar.append(
    ghostButton('Hide all', () => {
      const names = data.layers.map((layer: any) => layer.name);
      store.updateItem(item.id, { layerView: setAllHidden(view, names, true) });
      host.render();
    })
  );
  nodes.push(bar);

  // The single most important sentence on this panel.
  nodes.push(
    messageBlock(
      'info',
      'Visibility is a view setting. It does not change what is exported.',
      'Hiding a layer here only removes it from the canvas. Every layer is still written to the output file.',
      'To export a subset, tick the layers you want and use "Export selected" below.'
    )
  );

  const items = listLayers(data, view, search);
  if (items.length === 0) {
    nodes.push(element('p', { class: 'muted', style: 'padding:16px', text: `No layer matches "${search}".` }));
    return nodes;
  }

  const list = element('div', { class: 'lm' });
  for (const node of layerTree(items)) renderLayerNode(node, list, item, 0);
  nodes.push(list);

  // Operations ----------------------------------------------------------
  const selected = ui.layerSelection.filter((name) => data.layers.some((layer: any) => layer.name === name));
  const ops = element('div', { class: 'lm__ops' });
  ops.append(element('div', { class: 'lm__opsTitle', text: `${selected.length} selected` }));

  ops.append(
    ghostButton('Export selected…', () => exportSelectedLayers(item, selected), selected.length === 0),
    ghostButton('Merge…', () => promptMergeLayers(item, selected), selected.length < 2),
    ghostButton('Rename…', () => promptRenameLayer(item, selected[0]), selected.length !== 1),
    ghostButton('Split…', () => promptSplitLayer(item, selected[0]), selected.length !== 1),
    ghostButton('Delete', () => promptDeleteLayer(item, selected[0]), selected.length !== 1)
  );
  nodes.push(ops);

  const pending = (item.edits ?? []).filter((command) => command.kind.startsWith('layer-'));
  if (pending.length > 0) nodes.push(pendingEditsPanel(item, pending));

  return nodes;
}

export function renderLayerNode(node: LayerTreeNode, into: HTMLElement, item: QueueItem, depth: number): void {
  const view = viewOf(item);

  if (!node.layer) {
    // A folder with no layer of its own — a KML folder level.
    into.append(
      element('div', { class: 'lm__folder', style: `padding-left:${depth * 16 + 8}px` }, [
        element('span', { class: 'lm__folderIcon', text: '▾' }),
        element('span', { text: node.name }),
      ])
    );
    for (const child of node.children) renderLayerNode(child, into, item, depth + 1);
    return;
  }

  const entry = node.layer;
  const row = element('div', {
    class: `lm__row${ui.layerSelection.includes(entry.name) ? ' lm__row--on' : ''}`,
    style: `padding-left:${depth * 16 + 8}px`,
  });

  const tick = element('input', { type: 'checkbox', 'aria-label': `Select ${entry.name}` }) as HTMLInputElement;
  tick.checked = ui.layerSelection.includes(entry.name);
  tick.addEventListener('change', () => {
    ui.layerSelection = tick.checked
      ? [...ui.layerSelection, entry.name]
      : ui.layerSelection.filter((name) => name !== entry.name);
    host.renderInspector();
  });
  row.append(tick);

  // Visibility ----------------------------------------------------------
  const eye = element('button', {
    class: `lm__icon${entry.visible ? ' lm__icon--on' : ''}`,
    title: entry.visible ? 'Hide on the canvas (does not affect the export)' : 'Show on the canvas',
    'aria-label': `${entry.visible ? 'Hide' : 'Show'} ${entry.name}`,
    text: entry.visible ? '👁' : '⌀',
  });
  eye.addEventListener('click', () => {
    store.updateItem(item.id, { layerView: setLayerView(view, entry.name, { hidden: entry.visible }) });
    host.render();
  });
  row.append(eye);

  // Lock ----------------------------------------------------------------
  const lock = element('button', {
    class: `lm__icon${entry.locked ? ' lm__icon--on' : ''}`,
    title: entry.locked ? 'Locked — every edit refuses on this layer' : 'Lock this layer against edits',
    'aria-label': `${entry.locked ? 'Unlock' : 'Lock'} ${entry.name}`,
    text: entry.locked ? '🔒' : '🔓',
  });
  lock.addEventListener('click', () => {
    store.updateItem(item.id, { layerView: setLayerView(view, entry.name, { locked: !entry.locked }) });
    host.render();
  });
  row.append(lock);

  // Isolate -------------------------------------------------------------
  const isolate = element('button', {
    class: `lm__icon${view.isolated === entry.name ? ' lm__icon--on' : ''}`,
    title: 'Show only this layer, without losing what is hidden',
    'aria-label': `Isolate ${entry.name}`,
    text: '◎',
  });
  isolate.addEventListener('click', () => {
    store.updateItem(item.id, { layerView: toggleIsolate(view, entry.name) });
    host.render();
  });
  row.append(isolate);

  const label = element('button', { class: 'lm__name', title: 'Show this layer in the attribute table' });
  label.append(element('span', { class: 'lm__nameText', text: entry.name }));
  label.append(
    element('span', {
      class: 'lm__meta',
      text: `${(truncationOf(item, entry.name)?.total ?? entry.featureCount).toLocaleString()} · ${entry.geometryTypes.join(', ') || 'no geometry'} · ${entry.fieldCount} field${entry.fieldCount === 1 ? '' : 's'}`,
    })
  );
  label.addEventListener('click', () => {
    store.updateItem(item.id, { table: { ...tableStateOf(item), layer: entry.name, selection: [] } });
    store.set({ inspectorTab: 'attributes' });
    host.render();
  });
  row.append(label);

  // Opacity -------------------------------------------------------------
  const opacity = element('input', {
    class: 'lm__opacity',
    type: 'range',
    min: '0',
    max: '100',
    value: String(Math.round(opacityOf(view, entry.name) * 100)),
    title: 'Opacity on the canvas',
    'aria-label': `Opacity of ${entry.name}`,
  }) as HTMLInputElement;
  opacity.addEventListener('input', () => {
    store.updateItem(item.id, {
      layerView: setLayerView(view, entry.name, { opacity: Number(opacity.value) / 100 }),
    });
    host.render();
  });
  row.append(opacity);

  into.append(row);
  for (const child of node.children) renderLayerNode(child, into, item, depth + 1);
}

export function promptRenameLayer(item: QueueItem, layerName: string): void {
  const data = datasetForTools(item);

  editDialog(
    `Rename "${layerName}"`,
    [{ key: 'name', label: 'New name', value: layerName }],
    (values) => {
      const plan = planRenameLayer(data, layerName, values.name, { protectedLayers: protectedFor(item) });
      return { text: describeLayerPlan(plan), blocked: plan.refusal !== undefined };
    },
    (values) => {
      const plan = planRenameLayer(data, layerName, values.name, { protectedLayers: protectedFor(item) });
      queueEdit(item, { kind: 'layer-rename', layer: layerName, to: values.name }, plan, describeLayerPlan(plan));
      ui.layerSelection = ui.layerSelection.map((name) => (name === layerName ? values.name : name));
    },
    'Rename'
  );
}

export function promptMergeLayers(item: QueueItem, names: string[]): void {
  const data = datasetForTools(item);

  editDialog(
    `Merge ${names.length} layers`,
    [{ key: 'name', label: 'Name for the merged layer', value: names[0] }],
    (values) => {
      const plan = planMergeLayers(data, names, values.name, { protectedLayers: protectedFor(item) });
      return { text: describeLayerPlan(plan), blocked: plan.refusal !== undefined };
    },
    (values) => {
      const plan = planMergeLayers(data, names, values.name, { protectedLayers: protectedFor(item) });
      queueEdit(item, { kind: 'layer-merge', layers: names, into: values.name }, plan, describeLayerPlan(plan));
      ui.layerSelection = [values.name];
    },
    'Merge'
  );
}

export function promptSplitLayer(item: QueueItem, layerName: string): void {
  const data = datasetForTools(item);
  const layer = data.layers.find((candidate: any) => candidate.name === layerName);
  if (!layer) return;

  const options = [
    { value: '__geometry__', label: 'geometry type' },
    ...layer.fields.map((field: any) => ({ value: field.name, label: `field "${field.name}"` })),
  ];

  const by = (value: string) => (value === '__geometry__' ? ({ kind: 'geometry' } as const) : ({ kind: 'field', field: value } as const));

  editDialog(
    `Split "${layerName}"`,
    [
      {
        key: 'by',
        label: 'Split by',
        kind: 'select',
        value: '__geometry__',
        options,
        hint: 'A field with a distinct value per feature would produce one layer per feature, and is refused.',
      },
    ],
    (values) => {
      const plan = planSplitLayer(data, layerName, by(values.by), { protectedLayers: protectedFor(item) });
      return { text: describeLayerPlan(plan), blocked: plan.refusal !== undefined };
    },
    (values) => {
      const plan = planSplitLayer(data, layerName, by(values.by), { protectedLayers: protectedFor(item) });
      queueEdit(item, { kind: 'layer-split', layer: layerName, by: by(values.by) }, plan, describeLayerPlan(plan));
      ui.layerSelection = [];
    },
    'Split'
  );
}

export function promptDeleteLayer(item: QueueItem, layerName: string): void {
  const data = datasetForTools(item);

  editDialog(
    `Delete "${layerName}"`,
    [],
    () => {
      const plan = planDeleteLayer(data, layerName, { protectedLayers: protectedFor(item) });
      return { text: describeLayerPlan(plan), blocked: plan.refusal !== undefined };
    },
    () => {
      const plan = planDeleteLayer(data, layerName, { protectedLayers: protectedFor(item) });
      queueEdit(item, { kind: 'layer-delete', layer: layerName }, plan, describeLayerPlan(plan));
      ui.layerSelection = ui.layerSelection.filter((name) => name !== layerName);
    },
    'Delete'
  );
}

/**
 * Exports only the selected layers, by queuing deletions for the rest.
 *
 * Expressed as edits rather than as a special export path, so the subset is
 * visible in the pending-edits list, reversible like any other edit, and
 * applied by the same replay against the full file. A separate "export subset"
 * flag would be a second way to decide what gets written, and the two would
 * eventually disagree.
 */
export function exportSelectedLayers(item: QueueItem, selected: string[]): void {
  const data = datasetForTools(item);
  const dropped = data.layers.map((layer: any) => layer.name).filter((name: string) => !selected.includes(name));

  if (dropped.length === 0) {
    store.log('warn', 'Every layer is already selected — nothing would be excluded.');
    host.render();
    return;
  }

  editDialog(
    'Export only the selected layers',
    [],
    () => ({
      text: `Keeps ${selected.join(', ')}. Removes ${dropped.join(', ')} from the output. This is queued as ${dropped.length} deletion(s) you can undo, not a hidden export setting.`,
      blocked: false,
    }),
    () => {
      let working = item;
      for (const name of dropped) {
        const plan = planDeleteLayer(datasetForTools(working), name, { protectedLayers: protectedFor(working) });
        if (plan.refusal) {
          store.log('warn', `${plan.refusal.what} ${plan.refusal.why}`);
          break;
        }
        queueEdit(working, { kind: 'layer-delete', layer: name }, plan, describeLayerPlan(plan));
        working = store.selected() ?? working;
      }
    },
    'Keep only these'
  );
}
