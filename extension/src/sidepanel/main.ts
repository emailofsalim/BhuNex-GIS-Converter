/**
 * Side panel — drop, pick a target, convert, download.
 *
 * Deliberately the short path: it sits beside whatever the user is actually
 * working on, so it carries the queue and nothing else. Anything needing an
 * inspector, a preview or per-file settings opens the full workspace.
 *
 * It runs the same pipeline as the workspace, so a conversion started here is
 * the same conversion, with the same QA and the same warnings.
 */

import '../workspace/styles.css';

import { groupCompanions, type IngestFile } from '../core/companions';
import { ConversionError } from '../core/errors';
import { SURVEY_DEFAULT_PRECISION } from '../core/precision';
import { exportTargetsFor, getFormat, isAvailable } from '../core/registry';
import { detect, runConversion, type OutputBlobFile } from '../workers/client';
import { loadSettings } from '../state/store';

interface PanelItem {
  fileName: string;
  bytes: Uint8Array;
  companions?: Map<string, Uint8Array>;
  formatId: string;
  formatName: string;
  confidence: number;
  status: 'ready' | 'converting' | 'done' | 'failed';
  message?: string;
  outputs?: OutputBlobFile[];
  qaVerdict?: string;
}

const items: PanelItem[] = [];
let targetFormatId: string | null = null;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function toIngestFile(file: File): Promise<IngestFile> {
  return { path: file.name, name: file.name, size: file.size, bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type || undefined };
}

function addFiles(files: IngestFile[]): void {
  for (const group of groupCompanions(files)) {
    const detection = detect({ fileName: group.primary.name, bytes: group.primary.bytes, siblingExtensions: group.siblingExtensions });
    items.push({
      fileName: group.primary.name,
      bytes: group.primary.bytes,
      companions: group.companions.size > 0 ? new Map([...group.companions].map(([key, file]) => [key, file.bytes])) : undefined,
      formatId: detection.formatId,
      formatName: detection.formatName,
      confidence: detection.confidence,
      status: 'ready',
      message:
        group.missing.length > 0
          ? `Missing companion file${group.missing.length === 1 ? '' : 's'}: .${group.missing.join(', .')}`
          : detection.requiresConfirmation
            ? 'Format not identified with confidence — open the workspace to confirm it.'
            : undefined,
    });
  }
  refreshTargets();
  render();
}

function refreshTargets(): void {
  const select = byId<HTMLSelectElement>('targetSelect');
  const previous = select.value;
  select.replaceChildren();
  // Offer targets valid for what is actually queued, not the whole registry.
  const kinds = new Set(items.map((item) => getFormat(item.formatId)?.dataKind ?? 'vector'));
  const targets = [...kinds].flatMap((kind) => exportTargetsFor(kind as never));
  const unique = [...new Map(targets.map((format) => [format.id, format])).values()].filter((format) => isAvailable(format, 'export', false));

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = unique.length > 0 ? 'Choose an output format…' : 'Add a file first';
  select.append(placeholder);
  for (const format of unique) {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = `${format.name} (.${format.extensions[0]})`;
    select.append(option);
  }
  if (previous && unique.some((format) => format.id === previous)) select.value = previous;
  targetFormatId = select.value || null;
}

async function convertAll(): Promise<void> {
  if (!targetFormatId) return;
  const settings = await loadSettings();
  const progressBar = byId<HTMLElement>('progressBar');
  let completed = 0;

  for (const item of items) {
    item.status = 'converting';
    render();
    try {
      const result = await runConversion(
        { fileName: item.fileName, bytes: item.bytes, companions: item.companions },
        targetFormatId,
        {
          precision: SURVEY_DEFAULT_PRECISION,
          preserveZ: settings.preserveZ,
          runQa: settings.runQa,
          sourceCrs: settings.sourceCrsEpsg ? undefined : null,
        }
      );
      item.status = 'done';
      item.outputs = result.outputs;
      item.qaVerdict = result.qa.verdict;
      item.message = result.warnings.length > 0 ? `${result.warnings.length} warning(s) — see the workspace for detail.` : undefined;
    } catch (error) {
      item.status = 'failed';
      // The short form here; the workspace shows why and what to do about it.
      item.message = error instanceof ConversionError ? `${error.what} ${error.action}` : String(error);
    }
    completed++;
    progressBar.style.width = `${Math.round((completed / items.length) * 100)}%`;
    render();
  }
}

function downloadAll(): void {
  for (const item of items) {
    for (const output of item.outputs ?? []) {
      const blob = new Blob([output.bytes as unknown as BlobPart], { type: output.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = output.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }
}

function render(): void {
  const queue = byId<HTMLElement>('queue');
  queue.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'queue__empty';
    empty.textContent = 'Nothing queued yet.';
    queue.append(empty);
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'qrow';

    const name = document.createElement('div');
    name.className = 'qrow__name';
    name.textContent = item.fileName;
    row.append(name, document.createElement('div'));

    const meta = document.createElement('div');
    meta.className = 'qrow__meta';
    const status = document.createElement('span');
    const kind =
      item.status === 'done' ? (item.qaVerdict === 'PASS' ? 'ok' : 'warn') : item.status === 'failed' ? 'error' : item.status === 'converting' ? 'info' : 'muted';
    status.className = `badge badge--${kind}`;
    status.textContent = item.status === 'done' ? (item.qaVerdict ?? 'done').replace(/_/g, ' ').toLowerCase() : item.status;
    meta.append(status);

    const format = document.createElement('span');
    format.className = `badge badge--${item.confidence >= 0.9 ? 'muted' : 'warn'}`;
    format.textContent = `${item.formatName} ${(item.confidence * 100).toFixed(0)}%`;
    meta.append(format);

    if (item.message) {
      const message = document.createElement('span');
      message.className = item.status === 'failed' ? 'badge badge--error' : 'faint';
      message.textContent = item.message;
      meta.append(message);
    }
    row.append(meta);
    queue.append(row);
  }

  byId<HTMLButtonElement>('convertBtn').disabled = items.length === 0 || !targetFormatId;
  byId<HTMLButtonElement>('downloadBtn').disabled = !items.some((item) => item.outputs?.length);
}

function wire(): void {
  const dropzone = byId<HTMLElement>('dropzone');
  const picker = byId<HTMLInputElement>('filePicker');

  for (const eventName of ['dragenter', 'dragover'] as const) {
    document.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add('dropzone--active');
    });
  }
  document.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) dropzone.classList.remove('dropzone--active');
  });
  document.addEventListener('drop', async (event) => {
    event.preventDefault();
    dropzone.classList.remove('dropzone--active');
    const files = await Promise.all(Array.from(event.dataTransfer?.files ?? []).map(toIngestFile));
    addFiles(files);
  });

  dropzone.addEventListener('click', () => picker.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      picker.click();
    }
  });
  picker.addEventListener('change', async () => {
    const files = await Promise.all(Array.from(picker.files ?? []).map(toIngestFile));
    picker.value = '';
    addFiles(files);
  });

  byId<HTMLSelectElement>('targetSelect').addEventListener('change', (event) => {
    targetFormatId = (event.target as HTMLSelectElement).value || null;
    render();
  });
  byId('convertBtn').addEventListener('click', () => void convertAll());
  byId('downloadBtn').addEventListener('click', downloadAll);
  byId('openWorkspace').addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/workspace/index.html') });
  });
}

void (async () => {
  const settings = await loadSettings();
  document.documentElement.dataset.theme = settings.theme === 'system' ? '' : settings.theme;
  wire();
  refreshTargets();
  render();
})();
