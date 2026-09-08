/** The attribute table (spec §25.5): the grid, and the operations on it. */

import {
  type AttributePlan,
  buildTable,
  describeAttributePlan,
  type FieldType,
  planAddField,
  planCalculate,
  planDeleteField,
  planRenameField,
  planRetypeField,
  planSetValue,
  summariseField,
} from '../../core/attributes';
import { type EditCommand } from '../../core/edits';
import { checkExpression, FUNCTION_NAMES } from '../../core/expression';
import { type QueueItem, store, type TableState } from '../../state/store';
import { $, editDialog, element, ghostButton, messageBlock } from '../dom';
import { host } from '../host';
import { datasetForTools, protectedFor, tableStateOf, truncationOf } from './dataset';
import { pendingEditsPanel, queueEdit } from './edits';
import { columnMappingPanel } from './inspector';

export function attributesTab(item: QueueItem): HTMLElement[] {
  const dataset = item.dataset;
  if (dataset?.table) return [columnMappingPanel(item)];

  const data = datasetForTools(item);
  if (data.layers.length === 0) {
    return [element('p', { class: 'muted', style: 'padding:16px', text: 'This dataset has no attribute fields.' })];
  }

  const state = tableStateOf(item);
  const layerName = state.layer && data.layers.some((layer: any) => layer.name === state.layer) ? state.layer : data.layers[0].name;
  const layer = data.layers.find((candidate: any) => candidate.name === layerName);
  const nodes: HTMLElement[] = [];

  const patch = (change: Partial<TableState>): void => {
    store.updateItem(item.id, { table: { ...state, layer: layerName, ...change } });
    host.render();
  };

  // Toolbar -------------------------------------------------------------
  const bar = element('div', { class: 'at__bar' });

  const picker = element('select', { class: 'select', 'aria-label': 'Layer' }) as HTMLSelectElement;
  for (const candidate of data.layers) {
    const option = element('option', { value: candidate.name, text: `${candidate.name} (${candidate.features.length})` });
    if (candidate.name === layerName) option.setAttribute('selected', 'selected');
    picker.append(option);
  }
  picker.addEventListener('change', () => patch({ layer: picker.value, selection: [] }));
  bar.append(picker);

  const searchBox = element('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search every column…',
    value: state.search,
    'aria-label': 'Search the table',
  }) as HTMLInputElement;
  searchBox.addEventListener('change', () => patch({ search: searchBox.value }));
  bar.append(searchBox);

  const filterBox = element('input', {
    class: 'input at__filter',
    type: 'text',
    placeholder: 'Filter, e.g. area > 1000 and owner = \'Rao\'',
    value: state.filter,
    'aria-label': 'Filter expression',
  }) as HTMLInputElement;

  // The filter is validated as it is typed, because a filter that matches
  // nothing and a filter that does not parse look identical in the result.
  const filterNote = element('span', { class: 'at__filterNote' });
  const validate = (): void => {
    const text = filterBox.value.trim();
    if (text === '') {
      filterNote.textContent = '';
      filterBox.classList.remove('input--bad');
      return;
    }
    const error = checkExpression(text, (layer?.fields ?? []).map((field: any) => field.name));
    filterBox.classList.toggle('input--bad', error !== null);
    filterNote.textContent = error ? `${error.message} (at character ${error.position + 1})` : '';
  };
  filterBox.addEventListener('input', validate);
  filterBox.addEventListener('change', () => patch({ filter: filterBox.value }));
  bar.append(filterBox);
  nodes.push(bar, filterNote);
  validate();

  if (!layer) return nodes;

  // What is loaded versus what exists ------------------------------------
  const truncated = truncationOf(item, layerName);
  if (truncated) {
    nodes.push(
      messageBlock(
        'info',
        `Showing the first ${truncated.shown.toLocaleString()} of ${truncated.total.toLocaleString()} features.`,
        'The workspace loads a preview so a large file opens quickly. A bulk edit made here is still applied to every feature: it is stored as an instruction and re-run against the whole file when you convert.',
        'A row selection, however, can only cover the rows loaded.'
      )
    );
  }

  const view = buildTable(layer, {
    sortBy: state.sortBy,
    sortDirection: state.sortDirection,
    search: state.search,
    filter: state.filter,
    limit: 500,
  });

  const count = element('div', { class: 'at__count' });
  const matched = state.filter || state.search ? `${view.rows.length.toLocaleString()} of ${view.totalRows.toLocaleString()} rows` : `${view.totalRows.toLocaleString()} rows`;
  count.append(element('span', { text: matched }));
  if (view.truncated) count.append(element('span', { class: 'muted', text: ' · first 500 rendered' }));
  if (state.selection.length > 0) count.append(element('span', { class: 'at__selCount', text: ` · ${state.selection.length} selected` }));
  nodes.push(count);

  // The table -----------------------------------------------------------
  const table = element('table', { class: 'table at__table' });
  const headRow = element('tr');
  headRow.append(element('th', { class: 'at__tick' }));

  for (const field of layer.fields) {
    const on = state.sortBy === field.name;
    const head = element('th', { class: `at__th${on ? ' at__th--on' : ''}` });
    const sort = element('button', {
      class: 'at__sort',
      title: `Sort by ${field.name}. Empty cells stay at the bottom in both directions.`,
    });
    sort.append(element('span', { text: field.name }));
    sort.append(element('span', { class: 'at__type', text: field.type }));
    if (on) sort.append(element('span', { class: 'at__arrow', text: state.sortDirection === 'asc' ? '▲' : '▼' }));
    sort.addEventListener('click', () =>
      patch({ sortBy: field.name, sortDirection: on && state.sortDirection === 'asc' ? 'desc' : 'asc' })
    );
    head.append(sort);

    const menu = element('button', { class: 'at__fieldMenu', text: '⋯', title: `Operations on "${field.name}"` });
    menu.addEventListener('click', () => openFieldMenu(item, layerName, field.name));
    head.append(menu);
    headRow.append(head);
  }
  table.append(element('thead', {}, [headRow]));

  const body = element('tbody');
  for (const row of view.rows) {
    const tr = element('tr', { class: state.selection.includes(row.index) ? 'at__row--on' : '' });

    const tick = element('input', { type: 'checkbox', 'aria-label': `Select row ${row.index + 1}` }) as HTMLInputElement;
    tick.checked = state.selection.includes(row.index);
    tick.addEventListener('change', () =>
      patch({
        selection: tick.checked
          ? [...state.selection, row.index]
          : state.selection.filter((index) => index !== row.index),
      })
    );
    tr.append(element('td', { class: 'at__tick' }, [tick]));

    for (const field of layer.fields) {
      const value = row.values[field.name];
      const cell = element('td', { class: 'mono at__cell' });

      // An empty cell and a missing one are different facts, so they look
      // different: "" renders as nothing, null renders as a dimmed marker.
      if (value === null || value === undefined) {
        cell.append(element('span', { class: 'at__null', text: '∅', title: 'No value recorded — this is not zero and not an empty string' }));
      } else {
        cell.textContent = String(value);
      }

      cell.title = 'Double-click to edit this cell';
      cell.addEventListener('dblclick', () => editCell(item, layerName, row.index, field.name, value));
      tr.append(cell);
    }
    body.append(tr);
  }
  table.append(body);
  nodes.push(element('div', { class: 'scroll-x' }, [table]));

  // Operations ----------------------------------------------------------
  const ops = element('div', { class: 'at__ops' });
  ops.append(
    ghostButton(state.selection.length > 0 ? `Set value on ${state.selection.length} selected…` : 'Set value on every row…', () =>
      promptSetValue(item, layerName, state.selection)
    ),
    ghostButton('Calculate field…', () => promptCalculate(item, layerName, state.selection)),
    ghostButton('Add field…', () => promptAddField(item, layerName)),
    ghostButton('Clear selection', () => patch({ selection: [] }), state.selection.length === 0),
    ghostButton('Column statistics…', () => showFieldStatistics(item, layerName))
  );
  nodes.push(ops);

  const pending = (item.edits ?? []).filter((command) => !command.kind.startsWith('layer-') && command.kind !== 'vertices');
  if (pending.length > 0) nodes.push(pendingEditsPanel(item, pending));

  return nodes;
}

export function promptSetValue(item: QueueItem, layerName: string, selection: number[]): void {
  const data = datasetForTools(item);
  const layer = data.layers.find((candidate: any) => candidate.name === layerName);
  if (!layer) return;
  const scope = selection.length > 0 ? selection : undefined;

  editDialog(
    scope ? `Set a value on ${scope.length} selected row(s)` : 'Set a value on every row',
    [
      {
        key: 'field',
        label: 'Field',
        kind: 'select',
        value: layer.fields[0]?.name,
        options: layer.fields.map((field: any) => ({ value: field.name, label: `${field.name} (${field.type})` })),
      },
      { key: 'value', label: 'Value', hint: 'Leave empty and tick "empty" below to clear the cells.' },
      { key: 'null', label: 'Set to empty (no value)', kind: 'checkbox' },
    ],
    (values) => {
      const value = values.null === 'true' ? null : values.value;
      const plan = planSetValue(data, layerName, values.field, value, { protectedLayers: protectedFor(item), scope });
      return { text: describeAttributePlan(plan), blocked: plan.refusal !== undefined };
    },
    (values) => {
      const value = values.null === 'true' ? null : values.value;
      const plan = planSetValue(data, layerName, values.field, value, { protectedLayers: protectedFor(item), scope });
      queueEdit(item, { kind: 'set', layer: layerName, field: values.field, value, scope }, plan, describeAttributePlan(plan));
    }
  );
}

export function promptCalculate(item: QueueItem, layerName: string, selection: number[]): void {
  const data = datasetForTools(item);
  const layer = data.layers.find((candidate: any) => candidate.name === layerName);
  if (!layer) return;
  const scope = selection.length > 0 ? selection : undefined;

  editDialog(
    'Calculate a field',
    [
      {
        key: 'field',
        label: 'Write the result into',
        kind: 'select',
        value: layer.fields[0]?.name,
        options: layer.fields.map((field: any) => ({ value: field.name, label: `${field.name} (${field.type})` })),
      },
      {
        key: 'expression',
        label: 'Expression',
        value: '',
        hint: `Fields: ${layer.fields.map((field: any) => field.name).join(', ')}. Functions: ${FUNCTION_NAMES.join(', ')}. Use [brackets] for a name with spaces. Arithmetic on an empty cell gives an empty cell, never zero.`,
      },
    ],
    (values) => {
      if (!values.expression.trim()) return { text: 'Type an expression.', blocked: true };
      const plan = planCalculate(data, layerName, values.field, values.expression, {
        protectedLayers: protectedFor(item),
        scope,
      });
      return { text: describeAttributePlan(plan), blocked: plan.refusal !== undefined };
    },
    (values) => {
      const plan = planCalculate(data, layerName, values.field, values.expression, {
        protectedLayers: protectedFor(item),
        scope,
      });
      queueEdit(
        item,
        { kind: 'calculate', layer: layerName, field: values.field, expression: values.expression, scope },
        plan,
        describeAttributePlan(plan)
      );
    }
  );
}

export const FIELD_TYPES: FieldType[] = ['string', 'number', 'integer', 'boolean', 'date'];

export function promptAddField(item: QueueItem, layerName: string): void {
  const data = datasetForTools(item);

  editDialog(
    'Add a field',
    [
      { key: 'name', label: 'Name', hint: 'Shapefile truncates field names to 10 characters.' },
      {
        key: 'type',
        label: 'Type',
        kind: 'select',
        value: 'string',
        options: FIELD_TYPES.map((type) => ({ value: type, label: type })),
      },
      { key: 'initial', label: 'Starting value', hint: 'Leave empty to create the column with no values.' },
    ],
    (values) => {
      if (!values.name.trim()) return { text: 'Type a name.', blocked: true };
      const plan = planAddField(
        data,
        layerName,
        { name: values.name, type: values.type as FieldType },
        values.initial === '' ? null : values.initial,
        { protectedLayers: protectedFor(item) }
      );
      return { text: describeAttributePlan(plan), blocked: plan.refusal !== undefined };
    },
    (values) => {
      const field = { name: values.name, type: values.type as FieldType };
      const initial = values.initial === '' ? null : values.initial;
      const plan = planAddField(data, layerName, field, initial, { protectedLayers: protectedFor(item) });
      queueEdit(item, { kind: 'add-field', layer: layerName, field, initialValue: initial }, plan, describeAttributePlan(plan));
    },
    'Add field'
  );
}

/** Rename, retype or delete one column. */
export function openFieldMenu(item: QueueItem, layerName: string, fieldName: string): void {
  const data = datasetForTools(item);
  const layer = data.layers.find((candidate: any) => candidate.name === layerName);
  const current = layer?.fields.find((field: any) => field.name === fieldName);

  editDialog(
    `"${fieldName}"`,
    [
      {
        key: 'action',
        label: 'Operation',
        kind: 'select',
        value: 'rename',
        options: [
          { value: 'rename', label: 'Rename' },
          { value: 'retype', label: 'Change type' },
          { value: 'delete', label: 'Delete the field' },
        ],
      },
      { key: 'newName', label: 'New name', value: fieldName },
      {
        key: 'type',
        label: 'New type',
        kind: 'select',
        value: current?.type ?? 'string',
        options: FIELD_TYPES.map((type) => ({ value: type, label: type })),
      },
      {
        key: 'force',
        label: 'Convert anyway, accepting the loss',
        kind: 'checkbox',
        hint: 'Only relevant when changing the type: values that cannot be converted become empty.',
      },
    ],
    (values) => {
      const plan = fieldPlan(item, data, layerName, fieldName, values);
      return { text: describeAttributePlan(plan), blocked: plan.refusal !== undefined };
    },
    (values) => {
      const plan = fieldPlan(item, data, layerName, fieldName, values);
      const command = fieldCommand(layerName, fieldName, values);
      if (command) queueEdit(item, command, plan, describeAttributePlan(plan));
    }
  );
}

export function fieldPlan(item: QueueItem, data: any, layerName: string, fieldName: string, values: Record<string, string>): AttributePlan {
  const options = { protectedLayers: protectedFor(item) };
  if (values.action === 'delete') return planDeleteField(data, layerName, fieldName, options);
  if (values.action === 'retype') {
    return planRetypeField(data, layerName, fieldName, values.type as FieldType, {
      ...options,
      force: values.force === 'true',
    });
  }
  return planRenameField(data, layerName, fieldName, values.newName, options);
}

export function fieldCommand(layerName: string, fieldName: string, values: Record<string, string>): EditCommand | null {
  if (values.action === 'delete') return { kind: 'delete-field', layer: layerName, field: fieldName };
  if (values.action === 'retype') {
    return {
      kind: 'retype-field',
      layer: layerName,
      field: fieldName,
      type: values.type as FieldType,
      force: values.force === 'true',
    };
  }
  return { kind: 'rename-field', layer: layerName, field: fieldName, newName: values.newName };
}

/** Double-clicking a cell edits that one row, which is a scoped `set`. */
export function editCell(item: QueueItem, layerName: string, featureIndex: number, field: string, current: unknown): void {
  const data = datasetForTools(item);

  editDialog(
    `Row ${featureIndex + 1} · "${field}"`,
    [
      { key: 'value', label: 'Value', value: current === null || current === undefined ? '' : String(current) },
      {
        key: 'null',
        label: 'No value (empty)',
        kind: 'checkbox',
        value: current === null || current === undefined ? 'true' : 'false',
        hint: 'An empty cell and a cell holding "" are different facts, and both are preserved as written.',
      },
    ],
    (values) => {
      const value = values.null === 'true' ? null : values.value;
      const plan = planSetValue(data, layerName, field, value, {
        protectedLayers: protectedFor(item),
        scope: [featureIndex],
      });
      return { text: describeAttributePlan(plan), blocked: plan.refusal !== undefined };
    },
    (values) => {
      const value = values.null === 'true' ? null : values.value;
      const plan = planSetValue(data, layerName, field, value, {
        protectedLayers: protectedFor(item),
        scope: [featureIndex],
      });
      queueEdit(item, { kind: 'set', layer: layerName, field, value, scope: [featureIndex] }, plan, describeAttributePlan(plan));
    },
    'Set'
  );
}

/** Unique values, null count and range for one column. */
export function showFieldStatistics(item: QueueItem, layerName: string): void {
  const data = datasetForTools(item);
  const layer = data.layers.find((candidate: any) => candidate.name === layerName);
  if (!layer || layer.fields.length === 0) return;

  const dialog = $('helpDialog') as HTMLDialogElement;
  dialog.replaceChildren();

  const head = element('div', { class: 'dialog__head' });
  head.append(element('span', { class: 'dialog__title', text: `Column statistics · ${layerName}` }));
  const close = element('button', { class: 'btn btn--ghost', text: 'Close' });
  close.addEventListener('click', () => dialog.close());
  head.append(element('span', { class: 'topbar__spacer' }), close);

  const body = element('div', { class: 'dialog__body stack' });
  const truncated = truncationOf(item, layerName);
  if (truncated) {
    body.append(
      messageBlock(
        'warn',
        `These statistics cover the ${truncated.shown.toLocaleString()} features loaded, not all ${truncated.total.toLocaleString()}.`,
        'The workspace holds a preview of a large file. A range or a null count computed from part of a column can be very different from the whole.',
        'Convert with "Assess project health" on for figures over the complete file.'
      )
    );
  }

  for (const field of layer.fields) {
    const summary = summariseField(layer, field.name);
    if (!summary) continue;

    const block = element('div', { class: 'stat' });
    block.append(element('div', { class: 'stat__name', text: `${field.name} · ${field.type}` }));
    block.append(
      element('div', {
        class: 'stat__line',
        text: `${summary.distinct.toLocaleString()} distinct value(s) · ${summary.nulls.toLocaleString()} empty`,
      })
    );
    if (summary.numeric) {
      block.append(
        element('div', {
          class: 'stat__line',
          text: `min ${summary.numeric.min} · max ${summary.numeric.max} · mean ${summary.numeric.mean.toFixed(3)}${summary.numeric.nonNumeric > 0 ? ` · ${summary.numeric.nonNumeric} non-numeric` : ''}`,
        })
      );
    }
    if (summary.top.length > 0) {
      block.append(
        element('div', {
          class: 'stat__top',
          text: summary.top
            .slice(0, 8)
            .map((entry) => `${String(entry.value)} (${entry.count})`)
            .join(' · '),
        })
      );
    }
    body.append(block);
  }

  const foot = element('div', { class: 'dialog__foot' });
  const done = element('button', { class: 'btn btn--primary', text: 'Done' });
  done.addEventListener('click', () => dialog.close());
  foot.append(element('span', { class: 'topbar__spacer' }), done);

  dialog.append(head, body, foot);
  dialog.showModal();
}

// ------------------------------------------------------------- layers
