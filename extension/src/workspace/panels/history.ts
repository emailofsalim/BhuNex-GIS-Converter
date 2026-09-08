/** Undo / redo (spec §31.1), and the one assertion that rewrites history. */

import {
  canRedo,
  canUndo,
  createHistory,
  describeEntry,
  type HistoryState,
  markCheckpoint,
  nextRedoLabel,
  nextUndoLabel,
  recordOperation,
  revertTo,
} from '../../core/history';
import { crsFromEpsg } from '../../crs/epsg';
import { crsLabel } from '../../crs/transform';
import { type QueueItem, store } from '../../state/store';
import { element, messageBlock } from '../dom';
import { host } from '../host';

export function historyOf(item: QueueItem | undefined): HistoryState {
  return item?.history ?? createHistory();
}

/**
 * The operation history for the selected file (§31.1, R19).
 *
 * Every entry is clickable: clicking one returns the data to the state just
 * after it. That is the whole point of keeping a stack rather than a single
 * undo — the regret is usually about a specific step three operations back, not
 * about the last thing that happened.
 */
export function historyPanel(item: QueueItem | undefined): HTMLElement[] {
  const wrap = element('div', { style: 'padding:12px' });

  if (!item) {
    wrap.append(element('p', { class: 'muted', text: 'Select a file to see what has been done to it.' }));
    return [wrap];
  }

  const history = historyOf(item);
  const controls = element('div', { class: 'row', style: 'gap:8px; margin-bottom:10px; flex-wrap:wrap' });

  const undoButton = element('button', {
    class: 'btn',
    type: 'button',
    text: canUndo(history) ? `Undo ${nextUndoLabel(history)}` : 'Undo',
  }) as HTMLButtonElement;
  undoButton.disabled = !canUndo(history);
  undoButton.addEventListener('click', () => stepHistory(item.id, historyOf(store.selected()).position - 1));
  controls.append(undoButton);

  const redoButton = element('button', {
    class: 'btn',
    type: 'button',
    text: canRedo(history) ? `Redo ${nextRedoLabel(history)}` : 'Redo',
  }) as HTMLButtonElement;
  redoButton.disabled = !canRedo(history);
  redoButton.addEventListener('click', () => stepHistory(item.id, historyOf(store.selected()).position + 1));
  controls.append(redoButton);

  const checkpoint = element('button', { class: 'btn btn--ghost', type: 'button', text: 'Mark checkpoint' }) as HTMLButtonElement;
  checkpoint.disabled = history.position === 0;
  checkpoint.title = 'Names the current state so it can be returned to later.';
  checkpoint.addEventListener('click', () => {
    const name = window.prompt('Name this checkpoint', `Checkpoint ${history.entries.filter((entry) => entry.checkpoint).length + 1}`);
    if (!name) return;
    store.updateItem(item.id, { history: markCheckpoint(historyOf(store.selected()), name) });
    store.log('info', `${item.fileName}: checkpoint “${name}” marked.`);
    host.render();
  });
  controls.append(checkpoint);
  wrap.append(controls);

  if (history.entries.length === 0) {
    wrap.append(
      element('p', {
        class: 'muted',
        text: 'Nothing has changed this file yet. Repairs, polygonisation, burn-in and CRS changes are recorded here as they happen, and each one can be reversed.',
      })
    );
    return [wrap];
  }

  if (history.dropped > 0) {
    wrap.append(
      messageBlock(
        'info',
        `The ${history.dropped} oldest operation(s) can no longer be undone.`,
        'The history keeps a bounded number of steps so a long session cannot grow without limit.'
      )
    );
  }

  const list = element('div', { class: 'history' });
  // The imported state is an entry too: it is where "undo everything" lands,
  // and a stack whose bottom is unreachable is a stack missing a rung.
  list.append(historyRow(item.id, 'As imported', 'The file exactly as it was read.', 0, history.position === 0, false));

  history.entries.forEach((entry, index) => {
    list.append(
      historyRow(
        item.id,
        entry.label,
        describeEntry(entry),
        index + 1,
        history.position === index + 1,
        index + 1 > history.position,
        entry.checkpoint
      )
    );
  });

  wrap.append(list);
  return [wrap];
}

export function historyRow(
  itemId: string,
  label: string,
  detail: string,
  position: number,
  current: boolean,
  undone: boolean,
  checkpoint?: string
): HTMLElement {
  const row = element('button', {
    class: `history__row${current ? ' history__row--now' : ''}${undone ? ' history__row--undone' : ''}`,
    type: 'button',
  });
  row.append(element('span', { class: 'history__label', text: label }));
  if (checkpoint) row.append(element('span', { class: 'badge badge--accent', text: checkpoint }));
  row.append(element('span', { class: 'history__detail', text: detail }));
  if (current) row.append(element('span', { class: 'badge badge--muted', text: 'current' }));
  row.addEventListener('click', () => stepHistory(itemId, position));
  return row;
}

/**
 * Moves a file's data to a point in its history.
 *
 * The dataset held in the workspace is the worker's summary, not the full CIR,
 * so what is reversed here is the preview. The conversion itself always re-reads
 * the source in the worker, which is why undoing in the UI cannot leave the
 * exported bytes disagreeing with what is on screen.
 */
export function stepHistory(itemId: string, position: number): void {
  const item = store.get().items.find((entry) => entry.id === itemId);
  if (!item?.history) return;
  const stepped = revertTo(item.history, item.dataset, position);
  store.updateItem(itemId, { history: stepped.history, dataset: stepped.dataset });
  if (stepped.entry) {
    store.log('info', `${item.fileName}: history moved to “${position === 0 ? 'as imported' : stepped.entry.label}”.`);
  }
  host.render();
}

/**
 * Asserts a source CRS on a file that declares none (§31.1).
 *
 * The assertion is applied to the preview dataset as well as to the settings,
 * so the CRS tab and the compare panes show what the conversion will actually
 * use rather than leaving the user to hold the difference in their head. It is
 * recorded in the history because reinterpreting every coordinate in a file is
 * exactly the kind of decision R19 says must be reversible.
 *
 * A file that DECLARES a CRS is left alone: this setting exists for the ones
 * that do not, and silently overriding a declaration would be the tool
 * inventing a fact about someone's survey.
 */
export async function assignSourceCrs(itemId: string, epsg: number | null): Promise<void> {
  await store.patchSettings({ sourceCrsEpsg: epsg });

  const item = store.get().items.find((entry) => entry.id === itemId);
  if (!item?.dataset || item.dataset.crsOrigin === 'declared' || item.dataset.crsOrigin === 'sidecar') {
    host.render();
    return;
  }

  const before = item.dataset;
  const crs = epsg ? crsFromEpsg(epsg) : null;
  const after = { ...before, crs, crsOrigin: crs ? 'user' : 'unknown' };

  store.updateItem(itemId, {
    dataset: after,
    history: recordOperation(historyOf(item), before, after, {
      kind: 'crs-assign',
      label: crs ? `Assign source CRS ${crsLabel(crs)}` : 'Clear the asserted source CRS',
      settings: { sourceCrsEpsg: epsg },
    }),
  });
  store.log('info', `${item.fileName}: source CRS set to ${crs ? crsLabel(crs) : 'unset'}.`);
  host.render();
}
