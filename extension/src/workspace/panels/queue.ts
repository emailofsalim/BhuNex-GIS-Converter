/** The file queue: one row per input, its status, and what can be done to it. */

import { PHASE_LABEL } from '../../core/pipeline';
import { getFormat } from '../../core/registry';
import { crsLabel } from '../../crs/transform';
import { type QueueItem, store } from '../../state/store';
import { cancelJob } from '../../workers/client';
import { expandArchiveItem } from '../conversion';
import { $, badge, element, formatBytes } from '../dom';
import { host } from '../host';

export function renderQueue(): void {
  const state = store.get();
  const container = $('queue');
  container.replaceChildren();

  if (state.items.length === 0) {
    container.append(
      element('p', { class: 'queue__empty' }, ['Nothing queued yet.', element('br'), 'Drop files anywhere, or use Add Files.'])
    );
    return;
  }

  for (const item of state.items) {
    const row = element('div', {
      class: `qrow${item.id === state.selectedId ? ' qrow--selected' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${item.fileName}, ${item.status}`,
    });
    row.addEventListener('click', () => {
      store.set({ selectedId: item.id });
      host.render();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        store.set({ selectedId: item.id });
        host.render();
      }
    });

    row.append(element('div', { class: 'qrow__name', text: item.fileName, title: item.path }));

    const actions = element('div', { class: 'qrow__actions' });
    if (item.detection?.formatId === 'zip') {
      const expandBtn = element('button', { class: 'btn btn--ghost', text: 'Expand', title: 'Add the archive contents as separate items' });
      expandBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void expandArchiveItem(item.id);
      });
      actions.append(expandBtn);
    }
    if (item.status === 'converting' && item.jobId) {
      const cancelBtn = element('button', {
        class: 'btn btn--ghost btn--danger',
        text: 'Cancel',
        title: 'Stop this conversion. The worker running it is terminated, so it stops immediately rather than at the next checkpoint.',
      });
      cancelBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        cancelJob(item.jobId as string);
        store.log('warn', `${item.fileName}: cancelled.`);
        // The promise rejects with CancelledError, which convertItem turns into
        // the row's state — nothing else to do here.
      });
      actions.append(cancelBtn);
    }

    const removeBtn = element('button', { class: 'btn btn--ghost btn--danger', text: '✕', 'aria-label': `Remove ${item.fileName}` });
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      store.removeItem(item.id);
      host.render();
    });
    actions.append(removeBtn);
    row.append(actions);

    const meta = element('div', { class: 'qrow__meta' });
    meta.append(badge(statusLabel(item), statusKind(item)));
    if (item.status === 'converting' && item.phase) {
      meta.append(
        badge(
          PHASE_LABEL[item.phase],
          'accent',
          'The stage the conversion has reached. There is no percentage because the pipeline knows which stage it is in, not how far through one it is — and a number that means nothing is worse than no number.'
        )
      );
    }
    if (item.detection) {
      meta.append(
        badge(
          `${item.detection.formatName} ${(item.detection.confidence * 100).toFixed(0)}%`,
          item.detection.confidence >= 0.9 ? 'muted' : 'warn',
          item.detection.evidence.map((evidence) => `${evidence.layer}: ${evidence.note}`).join('\n')
        )
      );
    }
    meta.append(element('span', { text: formatBytes(item.size) }));
    const summary = datasetSummary(item);
    if (summary) meta.append(element('span', { text: summary }));
    if (item.dataset?.crs) meta.append(badge(crsShort(item.dataset.crs), 'muted', crsLabel(item.dataset.crs)));
    else if (item.dataset) meta.append(badge('CRS not declared', 'warn', 'Select a source CRS before transforming coordinates.'));
    if (item.targetFormatId) meta.append(badge(`→ ${getFormat(item.targetFormatId)?.name ?? item.targetFormatId}`, 'accent'));
    if (item.tree && item.tree.length > 1) {
      meta.append(badge(`${item.tree.length} files`, 'accent', item.tree.slice(0, 20).join('\n')));
    }
    if (item.warnings.length > 0) meta.append(badge(`${item.warnings.length} warning${item.warnings.length === 1 ? '' : 's'}`, 'warn'));
    if (item.missingCompanions.length > 0) {
      meta.append(badge(`missing .${item.missingCompanions.join(', .')}`, 'error', 'A required companion file was not supplied.'));
    }
    row.append(meta);
    container.append(row);
  }
}

export function statusLabel(item: QueueItem): string {
  switch (item.status) {
    case 'queued':
      return 'queued';
    case 'inspecting':
      return 'reading…';
    case 'ready':
      return 'ready';
    case 'converting':
      return 'converting…';
    case 'done':
      return item.qa ? item.qa.verdict.replace(/_/g, ' ').toLowerCase() : 'done';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'confirm format';
    default:
      return item.status;
  }
}

export function statusKind(item: QueueItem): string {
  switch (item.status) {
    case 'done':
      return item.qa?.verdict === 'FAILED' ? 'error' : item.qa?.verdict === 'PASS' ? 'ok' : 'warn';
    case 'failed':
      return 'error';
    case 'blocked':
      return 'warn';
    case 'converting':
    case 'inspecting':
      return 'info';
    default:
      return 'muted';
  }
}

export function datasetSummary(item: QueueItem): string | null {
  const dataset = item.dataset;
  if (!dataset) return null;
  if (dataset.pointcloud) return `${dataset.pointcloud.count.toLocaleString()} points`;
  if (dataset.raster) return `${dataset.raster.width} × ${dataset.raster.height} px, ${dataset.raster.bandCount} band(s)`;
  if (dataset.table) return `${dataset.table.rowCount.toLocaleString()} rows`;
  const features = (dataset.layers ?? []).reduce((sum: number, layer: any) => sum + layer.featureCount, 0);
  return features > 0 ? `${features.toLocaleString()} features` : null;
}

export function crsShort(crs: any): string {
  return crs?.epsg ? `EPSG:${crs.epsg}` : (crs?.name ?? 'CRS');
}

// ------------------------------------------------------------- format picker
