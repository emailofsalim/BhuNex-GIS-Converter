/**
 * DOM helpers shared by every panel.
 *
 * Nothing here knows what a dataset is. `element()` exists because building a
 * node, setting three attributes and appending two children is five statements
 * of noise around one line of intent, and a workspace this size is mostly that.
 *
 * `checkbox` and `numberField` call `host.render()` on change, which is the one
 * thing in this file that is not pure DOM: a settings control that does not
 * redraw is a control that appears not to work.
 */

import { host } from './host';

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function badge(text: string, kind = 'muted', title?: string): HTMLElement {
  const node = element('span', { class: `badge badge--${kind}`, text });
  if (title) node.title = title;
  return node;
}

// ----------------------------------------------------------------- ingestion

export function messageBlock(kind: 'error' | 'warn' | 'info', what: string, why?: string, action?: string): HTMLElement {
  const node = element('div', { class: `msg msg--${kind}`, style: 'margin:12px' });
  node.append(element('span', { class: 'msg__icon', text: kind === 'error' ? '✕' : kind === 'warn' ? '!' : 'i' }));
  const body = element('div', { class: 'msg__body' });
  body.append(element('div', { class: 'msg__what', text: what }));
  if (why) body.append(element('div', { class: 'msg__why', text: why }));
  if (action) body.append(element('div', { class: 'msg__action', text: action }));
  node.append(body);
  return node;
}

export function keyValues(pairs: [string, string][]): HTMLElement {
  const grid = element('div', { class: 'kv' });
  for (const [key, value] of pairs) {
    grid.append(element('div', { class: 'kv__k', text: key }));
    grid.append(element('div', { class: 'kv__v', text: value }));
  }
  return grid;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function ghostButton(text: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const button = element('button', { class: 'btn btn--ghost', text }) as HTMLButtonElement;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

export interface PromptField {
  key: string;
  label: string;
  kind?: 'text' | 'select' | 'checkbox' | 'expression';
  value?: string;
  options?: { value: string; label: string }[];
  hint?: string;
}

/**
 * One dialog shape for every edit, with a live preview of the plan.
 *
 * The preview is the point. Every one of these operations can affect thousands
 * of rows, and "what will this do" has to be answerable BEFORE it happens —
 * which is the same contract `describeAttributePlan` and `describeLayerPlan`
 * were written for.
 */
export function editDialog(
  title: string,
  fields: PromptField[],
  describe: (values: Record<string, string>) => { text: string; blocked: boolean },
  onConfirm: (values: Record<string, string>) => void,
  confirmLabel = 'Apply'
): void {
  const dialog = $('settingsDialog') as HTMLDialogElement;
  dialog.replaceChildren();

  const head = element('div', { class: 'dialog__head' });
  head.append(element('span', { class: 'dialog__title', text: title }));
  const close = element('button', { class: 'btn btn--ghost', text: 'Close' });
  close.addEventListener('click', () => dialog.close());
  head.append(element('span', { class: 'topbar__spacer' }), close);

  const body = element('div', { class: 'dialog__body stack' });
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const summary = element('div', { class: 'msg msg--info' });
  const summaryText = element('div', { class: 'msg__body' });
  summary.append(element('span', { class: 'msg__icon', text: 'i' }), summaryText);

  const confirm = element('button', { class: 'btn btn--primary', text: confirmLabel }) as HTMLButtonElement;

  const refresh = (): void => {
    const values: Record<string, string> = {};
    for (const [key, input] of inputs) {
      values[key] = input instanceof HTMLInputElement && input.type === 'checkbox' ? String(input.checked) : input.value;
    }
    const outcome = describe(values);
    summaryText.textContent = outcome.text;
    summary.className = `msg msg--${outcome.blocked ? 'warn' : 'info'}`;
    confirm.disabled = outcome.blocked;
  };

  for (const field of fields) {
    const row = element('label', { class: 'field' });
    row.append(element('span', { class: 'field__label', text: field.label }));

    let input: HTMLInputElement | HTMLSelectElement;
    if (field.kind === 'select') {
      const select = element('select', { class: 'select' }) as HTMLSelectElement;
      for (const option of field.options ?? []) {
        const node = element('option', { value: option.value, text: option.label });
        if (option.value === field.value) node.setAttribute('selected', 'selected');
        select.append(node);
      }
      input = select;
    } else if (field.kind === 'checkbox') {
      const tick = element('input', { type: 'checkbox' }) as HTMLInputElement;
      tick.checked = field.value === 'true';
      input = tick;
    } else {
      input = element('input', { class: 'input', type: 'text', value: field.value ?? '' }) as HTMLInputElement;
    }

    input.addEventListener('input', refresh);
    input.addEventListener('change', refresh);
    inputs.set(field.key, input);
    row.append(input);
    if (field.hint) row.append(element('span', { class: 'field__hint', text: field.hint }));
    body.append(row);
  }

  body.append(summary);

  const foot = element('div', { class: 'dialog__foot' });
  const cancel = element('button', { class: 'btn', text: 'Cancel' });
  cancel.addEventListener('click', () => dialog.close());
  confirm.addEventListener('click', () => {
    const values: Record<string, string> = {};
    for (const [key, input] of inputs) {
      values[key] = input instanceof HTMLInputElement && input.type === 'checkbox' ? String(input.checked) : input.value;
    }
    dialog.close();
    onConfirm(values);
  });
  foot.append(element('span', { class: 'topbar__spacer' }), cancel, confirm);

  dialog.append(head, body, foot);
  refresh();
  dialog.showModal();
}

// ------------------------------------------------------------- attributes

/** A single-line text input, for a field name and similar. */
export function textField(label: string, value: string, onChange: (next: string) => void): HTMLElement {
  const wrap = element('div', { class: 'field' });
  wrap.append(element('label', { class: 'field__label', text: label }));
  const input = element('input', { class: 'input', type: 'text' }) as HTMLInputElement;
  input.value = value;
  input.addEventListener('change', () => onChange(input.value.trim()));
  wrap.append(input);
  return wrap;
}

export function checkbox(label: string, checked: boolean, onChange: (value: boolean) => void, hint?: string): HTMLElement {
  const wrap = element('label', { class: 'checkbox' });
  const input = element('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => {
    onChange(input.checked);
    host.render();
  });
  wrap.append(input, element('span', { text: label }));
  if (hint) wrap.append(element('span', { class: 'hint', text: '?', title: hint }));
  return wrap;
}

export function numberField(label: string, value: number, step: number, onChange: (value: number) => void): HTMLElement {
  const wrap = element('div', { class: 'field' });
  wrap.append(element('label', { class: 'field__label', text: label }));
  const input = element('input', { class: 'input', type: 'number', step: String(step), value: String(value) }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) {
      onChange(parsed);
      host.render();
    }
  });
  wrap.append(input);
  return wrap;
}

// -------------------------------------------------------------------- bottom

// --------------------------------------------------- health and the report
