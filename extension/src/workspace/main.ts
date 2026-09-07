/**
 * Universal BhuNex Converter workspace.
 *
 * Framework-free: the workspace has one state tree and a handful of views, and a
 * render-on-change loop is the whole requirement. It also keeps the bundle small
 * and provably free of remote code, which the offline rule needs.
 *
 * The layout follows instruction §11.3 — queue on the left, inspector and
 * preview in the centre, target format and settings on the right, QA and log
 * along the bottom — with the three primary actions always visible and every
 * advanced control collapsed until asked for.
 */

import './styles.css';

import { ENGINE_VERSION } from '../core/cir';
import { groupCompanions, type IngestFile } from '../core/companions';
import { CONFIRM_THRESHOLD } from '../core/detect';
import { ConversionError } from '../core/errors';
import { packageBatch, type ConversionSettings } from '../core/pipeline';
import { describeTree, OUTPUT_LAYOUT_DESCRIPTION, OUTPUT_LAYOUT_LABEL, type OutputLayout } from '../core/layout';
import {
  AXIS_LABEL,
  FIDELITY_AXES,
  GRADE_LABEL,
  predictFromProfile,
  summarisePrediction,
  type FidelityGrade,
  type FidelityPrediction,
} from '../core/predict';
import { FULL_PRECISION, fixedPrecision } from '../core/precision';
import {
  CATEGORY_LABEL,
  FORMATS,
  SUPPORT_LABEL,
  exportTargetsFor,
  getFormat,
  isAvailable,
  type FormatCategory,
  type FormatDef,
} from '../core/registry';
import {
  BURN_IN_MODE_DESCRIPTION,
  BURN_IN_MODE_LABEL,
  PRIORITY_LABEL,
  type BurnInMode,
  type BurnInPriority,
} from '../qa/burn-in';
import { KML_TEMPLATE_DESCRIPTION, KML_TEMPLATE_LABEL, type KmlTemplate } from '../engines/vector/kml-templates';
import { describePreset, presetsFor, type Preset } from '../core/presets';
import { CommandPalette, type Command } from '../ui/command-palette';
import { DualCanvas } from '../ui/dual-canvas';
import { DIFF_AXIS_LABEL } from '../qa/diff';
import { OVERLAY_ROLE_LABEL, type GeometryOverlay } from '../qa/geometry-overlay';
import {
  canRedo,
  canUndo,
  createHistory,
  describeEntry,
  markCheckpoint,
  nextRedoLabel,
  nextUndoLabel,
  recordOperation,
  revertTo,
  type HistoryState,
} from '../core/history';
import {
  buildProject,
  matchSources,
  readProject,
  summariseMatches,
  writeProject,
  PROJECT_EXTENSION,
  type ProjectSource,
} from '../core/project';
import {
  describeWorkflow,
  recordWorkflow,
  runWorkflow,
  validateWorkflow,
  type Workflow,
  type WorkflowSettings,
} from '../core/workflow';
import { crsFromEpsg, QUICK_ZONES, searchEpsg, utmCrs } from '../crs/epsg';
import { crsLabel } from '../crs/transform';
import { checkNativeHealth, NATIVE_STATUS_LABEL } from '../adapters/native-messaging/client';
import { LAYER_COLORS, PreviewCanvas, type PreviewData } from '../ui/preview';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  nextId,
  rememberCrs,
  rememberFormat,
  store,
  type AppSettings,
  type QueueItem,
} from '../state/store';
import { expand, inspect, preflight, runConversion } from '../workers/client';

// --------------------------------------------------------------------- helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

function element<K extends keyof HTMLElementTagNameMap>(
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function badge(text: string, kind = 'muted', title?: string): HTMLElement {
  const node = element('span', { class: `badge badge--${kind}`, text });
  if (title) node.title = title;
  return node;
}

// ----------------------------------------------------------------- ingestion

/** Reads a File into the shape the grouper and the pipeline expect. */
async function toIngestFile(file: File, path?: string): Promise<IngestFile> {
  const buffer = await file.arrayBuffer();
  return {
    path: path ?? (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name,
    name: file.name,
    size: file.size,
    bytes: new Uint8Array(buffer),
    mimeType: file.type || undefined,
  };
}

/** Walks a dropped directory so a folder of shapefiles arrives grouped. */
async function readEntry(entry: FileSystemEntry, prefix: string, into: IngestFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    into.push(await toIngestFile(file, `${prefix}${entry.name}`));
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    // readEntries returns at most 100 entries per call, so it must be drained.
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, into);
  }
}

async function filesFromDataTransfer(transfer: DataTransfer): Promise<IngestFile[]> {
  const out: IngestFile[] = [];
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(transfer.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length > 0) {
    for (const entry of entries) await readEntry(entry, '', out);
    return out;
  }
  for (const file of Array.from(transfer.files)) out.push(await toIngestFile(file));
  return out;
}

/**
 * Adds files to the queue, grouping companions first.
 *
 * `containers` names the archive chain these files came out of, so an expanded
 * ZIP keeps its own name as a folder level in the output tree.
 */
async function addFiles(files: IngestFile[], containers?: string[]): Promise<void> {
  if (files.length === 0) return;
  const groups = groupCompanions(files);
  const items: QueueItem[] = groups.map((group) => ({
    id: nextId(),
    fileName: group.primary.name,
    path: group.primary.path,
    containers,
    size: group.primary.size,
    bytes: group.primary.bytes,
    companions: group.companions.size > 0 ? new Map([...group.companions].map(([key, file]) => [key, file.bytes])) : undefined,
    siblingExtensions: group.siblingExtensions,
    missingCompanions: group.missing,
    status: 'queued',
    warnings: [],
  }));

  store.addItems(items);
  store.log('info', `Added ${items.length} dataset${items.length === 1 ? '' : 's'} (${files.length} file${files.length === 1 ? '' : 's'}).`);

  for (const item of items) {
    if (item.missingCompanions.length > 0) {
      store.log(
        'warn',
        `${item.fileName}: missing companion file${item.missingCompanions.length === 1 ? '' : 's'} ${item.missingCompanions
          .map((extension) => `.${extension}`)
          .join(', ')} — the dataset is incomplete.`
      );
    }
    await inspectItem(item.id);
  }
  render();
}

async function inspectItem(id: string): Promise<void> {
  const item = store.get().items.find((candidate) => candidate.id === id);
  if (!item) return;
  store.updateItem(id, { status: 'inspecting' });
  render();

  try {
    const { detection, dataset, profile } = await inspect(
      {
        fileName: item.fileName,
        bytes: item.bytes,
        companions: item.companions,
        siblingExtensions: item.siblingExtensions,
      },
      item.forcedFormatId
    );

    const blocked = detection.requiresConfirmation && !item.forcedFormatId;
    store.updateItem(id, {
      detection,
      dataset,
      profile,
      warnings: dataset.warnings ?? [],
      status: blocked ? 'blocked' : 'ready',
      // Suggest the global target, or the first valid one for this data kind.
      targetFormatId: item.targetFormatId ?? store.get().settings.globalTargetFormatId ?? undefined,
    });

    if (blocked) {
      store.log(
        'warn',
        `${item.fileName}: format not identified with confidence (${detection.formatName}, ${(detection.confidence * 100).toFixed(0)}%). Confirm it in the inspector before converting.`
      );
    } else {
      store.log('ok', `${item.fileName}: ${detection.formatName} (${(detection.confidence * 100).toFixed(0)}% confidence).`);
    }
  } catch (error) {
    const structured =
      error instanceof ConversionError
        ? error.toJSON()
        : { code: 'INSPECT_FAILED', what: 'The file could not be read.', why: String(error), action: 'Confirm the source format in the inspector.' };
    store.updateItem(id, { status: 'failed', error: structured as QueueItem['error'] });
    store.log('error', `${item.fileName}: ${structured.what} ${structured.why}`);
  }
  render();
}

async function expandArchiveItem(id: string): Promise<void> {
  const item = store.get().items.find((candidate) => candidate.id === id);
  if (!item) return;
  try {
    const expanded = await expand({ fileName: item.fileName, bytes: item.bytes });
    store.removeItem(id);
    await addFiles(
      expanded.map((entry) => ({
        path: entry.path ?? entry.fileName,
        name: entry.fileName,
        size: entry.bytes.length,
        bytes: entry.bytes,
      })),
      // The archive becomes a folder level, so a ZIP of folders expands into
      // those folders rather than a flat list.
      expanded[0]?.containers
    );
    store.log('ok', `${item.fileName}: expanded to ${expanded.length} file(s).`);
  } catch (error) {
    store.log('error', `${item.fileName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ----------------------------------------------------------------- conversion

function buildSettings(): Partial<ConversionSettings> {
  const settings = store.get().settings;
  const sourceCrs = settings.sourceCrsEpsg ? crsFromEpsg(settings.sourceCrsEpsg) : null;
  const targetCrs = settings.targetCrsEpsg ? crsFromEpsg(settings.targetCrsEpsg) : null;
  return {
    precision: settings.precisionMode === 'full' ? FULL_PRECISION : fixedPrecision(settings.precisionDecimals),
    sourceCrs,
    targetCrs,
    preserveZ: settings.preserveZ,
    naming: { pattern: settings.naming },
    layout: settings.outputLayout,
    runQa: settings.runQa,
    arcTolerance: settings.arcTolerance,
    embedMetadata: settings.embedMetadata,
    repair: {
      closeRings: settings.repairCloseRings,
      removeDuplicateVertices: settings.repairRemoveDuplicateVertices,
      normalizeRingOrientation: settings.repairNormalizeOrientation,
      removeDuplicateFeatures: settings.repairDeduplicateFeatures,
      snapTolerance: settings.snapTolerance,
    },
    decimation:
      settings.decimationMode === 'none'
        ? undefined
        : { mode: settings.decimationMode, factor: settings.decimationFactor, cell: settings.decimationCell },
    dxf: { arcTolerance: settings.arcTolerance } as never,
    // Both cadastral tools are opt-in: passing undefined leaves the pipeline
    // stage switched off entirely rather than running it with defaults.
    kml: {
      template: settings.kmlTemplate,
      boreholeLog: settings.kmlBoreholeLog,
      balloonFooter: settings.kmlBalloonFooter || undefined,
    },
    polygonize: settings.polygonizeEnabled
      ? {
          tolerance: settings.polygonizeTolerance,
          keepSourceLines: settings.polygonizeKeepLines,
        }
      : undefined,
    burnIn:
      settings.burnInEnabled && settings.burnInTargetLayer
        ? {
            targetLayer: settings.burnInTargetLayer,
            fieldName: settings.burnInField,
            mode: settings.burnInMode,
            priority: settings.burnInPriority,
            replaceSource: settings.burnInReplaceSource,
          }
        : undefined,
  };
}

async function convertItem(id: string, withQa: boolean): Promise<void> {
  const item = store.get().items.find((candidate) => candidate.id === id);
  if (!item) return;
  const targetId = item.targetFormatId ?? store.get().settings.globalTargetFormatId;
  if (!targetId) {
    store.log('warn', `${item.fileName}: choose an output format first.`);
    return;
  }

  const check = preflight(item.size, item.detection?.formatId ?? 'unknown');
  if (!check.ok) {
    store.updateItem(id, {
      status: 'failed',
      error: {
        code: 'TOO_LARGE_FOR_BROWSER',
        what: 'The dataset is too large to convert in the browser.',
        why: check.message ?? '',
        action: 'Reduce it with a crop, filter or decimation setting, or convert it with a desktop tool.',
      },
    });
    store.log('error', `${item.fileName}: ${check.message}`);
    render();
    return;
  }

  store.updateItem(id, { status: 'converting', error: undefined });
  render();
  const startedAt = performance.now();

  try {
    const settings = { ...buildSettings(), runQa: withQa && store.get().settings.runQa };
    const result = await runConversion(
      {
        fileName: item.fileName,
        bytes: item.bytes,
        companions: item.companions,
        siblingExtensions: item.siblingExtensions,
        path: item.path,
        containers: item.containers,
      },
      targetId,
      settings,
      item.forcedFormatId
    );
    const durationMs = Math.round(performance.now() - startedAt);
    const outputBytes = result.outputs.reduce((sum, output) => sum + output.bytes.length, 0);

    store.updateItem(id, {
      status: 'done',
      outputs: result.outputs,
      tree: result.tree,
      prediction: result.prediction,
      diff: result.diff,
      outputDataset: result.outputDataset,
      overlay: result.overlay,
      qa: result.qa,
      warnings: result.warnings,
      provenance: result.provenance,
      durationMs,
    });
    await store.patchSettings({
      recentFormats: rememberFormat(store.get().settings, targetId),
      recentCrs: rememberCrs(store.get().settings, crsFromEpsg(store.get().settings.targetCrsEpsg ?? 0)),
    });
    store.set({
      perf: `${formatBytes(item.size)} in ${durationMs} ms · ${formatBytes(outputBytes)} out · ${(item.size / 1024 / 1024 / (durationMs / 1000)).toFixed(1)} MB/s`,
    });
    store.log('ok', `${item.fileName} → ${getFormat(targetId)?.name}: ${result.qa.verdict.replace(/_/g, ' ')} in ${durationMs} ms.`);
    for (const warning of result.warnings) {
      if (warning.severity !== 'info') store.log(warning.severity === 'error' ? 'error' : 'warn', `${item.fileName}: ${warning.message}`);
    }
  } catch (error) {
    const structured =
      error instanceof ConversionError
        ? error.toJSON()
        : {
            code: 'CONVERT_FAILED',
            what: 'The conversion did not complete.',
            why: error instanceof Error ? error.message : String(error),
            action: 'Check the source file in the inspector.',
          };
    store.updateItem(id, { status: 'failed', error: structured as QueueItem['error'] });
    store.log('error', `${item.fileName}: ${structured.what} ${structured.why} ${structured.action}`);
  }
  render();
}

async function convertAll(withQa: boolean): Promise<void> {
  const pending = store.get().items.filter((item) => item.status === 'ready' || item.status === 'failed' || item.status === 'done');
  if (pending.length === 0) return;
  store.set({ busy: true, progress: 0 });

  // Error isolation: one failed file never aborts the batch (instruction §12.1).
  let completed = 0;
  const concurrency = Math.max(1, store.get().settings.parallelJobs);
  const queue = [...pending];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      await convertItem(item.id, withQa);
      completed++;
      store.set({ progress: completed / pending.length });
    }
  });
  await Promise.all(workers);

  store.set({ busy: false, progress: 1 });
  const done = store.get().items.filter((item) => item.status === 'done').length;
  const failed = store.get().items.filter((item) => item.status === 'failed').length;
  store.log(failed > 0 ? 'warn' : 'ok', `Batch finished: ${done} converted, ${failed} failed.`);
  render();
}

function downloadBytes(bytes: Uint8Array, name: string, mimeType: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = element('a', { href: url, download: name });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some Chrome versions.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function downloadSelected(): void {
  const item = store.selected();
  if (!item?.outputs?.length) return;
  for (const output of item.outputs) downloadBytes(output.bytes, output.name, output.mimeType);
  store.log('ok', `Downloaded ${item.outputs.length} file(s) for ${item.fileName}.`);
}

async function downloadBatchZip(): Promise<void> {
  const done = store.get().items.filter((item) => item.status === 'done' && item.outputs?.length);
  if (done.length === 0) return;
  const results = done.map((item) => ({
    input: { fileName: item.fileName, bytes: item.bytes },
    detection: item.detection!,
    sourceDataset: item.dataset,
    outputs: item.outputs!.map((output) => ({ name: output.name, bytes: output.bytes, mimeType: output.mimeType })),
    warnings: item.warnings,
    qa: item.qa!,
    provenance: item.provenance,
  }));
  const { zip, manifestCsv, tree } = await packageBatch(results as never, { mirrorSource: store.get().settings.mirrorBatchTree });
  store.set({ manifestCsv });
  downloadBytes(zip, `universal-bhunex-converter-batch-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip');
  store.log('ok', `Batch ZIP written with ${done.length} dataset(s), ${tree.length} file(s) and a manifest.`);
  render();
}

// --------------------------------------------------------------------- render

let preview: PreviewCanvas | null = null;
let dual: DualCanvas | null = null;
let palette: CommandPalette | null = null;
/** Opens the project picker. Assigned in `wire`, where the input is created. */
let openProjectPicker: () => void = () => {};

function render(): void {
  const state = store.get();
  renderQueue();
  renderFormats();
  renderInspector();
  renderSettingsPanel();
  renderBottom();

  $('queueCount').textContent = `${state.items.length} file${state.items.length === 1 ? '' : 's'}`;
  ($('progressBar') as HTMLElement).style.width = `${Math.round(state.progress * 100)}%`;
  $('perfBadge').textContent = state.perf;

  const selected = store.selected();
  const canConvert = Boolean(selected && (selected.status === 'ready' || selected.status === 'done') && (selected.targetFormatId ?? state.settings.globalTargetFormatId));
  ($('convertBtn') as HTMLButtonElement).disabled = !canConvert || state.busy;
  ($('convertQaBtn') as HTMLButtonElement).disabled = !canConvert || state.busy;
  ($('downloadBtn') as HTMLButtonElement).disabled = !selected?.outputs?.length;
  ($('batchZipBtn') as HTMLButtonElement).disabled = !state.items.some((item) => item.status === 'done');

  const target = selected?.targetFormatId ?? state.settings.globalTargetFormatId;
  $('targetBadge').textContent = target ? (getFormat(target)?.name ?? target) : 'none selected';
  $('targetBadge').className = target ? 'badge badge--accent' : 'badge badge--muted';

  const dropzone = $('dropzone');
  dropzone.classList.toggle('dropzone--compact', state.items.length > 0);
  $('inspectorTabs').classList.toggle('hidden', !selected);
  $('previewWrap').classList.toggle('hidden', state.inspectorTab !== 'preview' || !selected);
  $('compareWrap').classList.toggle('hidden', state.inspectorTab !== 'compare' || !selected);
}

function renderQueue(): void {
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
      render();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        store.set({ selectedId: item.id });
        render();
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
    const removeBtn = element('button', { class: 'btn btn--ghost btn--danger', text: '✕', 'aria-label': `Remove ${item.fileName}` });
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      store.removeItem(item.id);
      render();
    });
    actions.append(removeBtn);
    row.append(actions);

    const meta = element('div', { class: 'qrow__meta' });
    meta.append(badge(statusLabel(item), statusKind(item)));
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

function statusLabel(item: QueueItem): string {
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

function statusKind(item: QueueItem): string {
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

function datasetSummary(item: QueueItem): string | null {
  const dataset = item.dataset;
  if (!dataset) return null;
  if (dataset.pointcloud) return `${dataset.pointcloud.count.toLocaleString()} points`;
  if (dataset.raster) return `${dataset.raster.width} × ${dataset.raster.height} px, ${dataset.raster.bandCount} band(s)`;
  if (dataset.table) return `${dataset.table.rowCount.toLocaleString()} rows`;
  const features = (dataset.layers ?? []).reduce((sum: number, layer: any) => sum + layer.featureCount, 0);
  return features > 0 ? `${features.toLocaleString()} features` : null;
}

function crsShort(crs: any): string {
  return crs?.epsg ? `EPSG:${crs.epsg}` : (crs?.name ?? 'CRS');
}

// ------------------------------------------------------------- format picker

/**
 * Options the predictor needs, taken from the settings the user has actually set.
 *
 * Kept in one place so the format cards, the "what will be lost" dialog and the
 * conversion itself all predict against identical inputs — a card promising
 * GREEN while the conversion reports loss would destroy the feature's whole
 * point.
 */
function predictOptions(): Parameters<typeof predictFromProfile>[2] {
  const settings = store.get().settings;
  return {
    sourceCrsEpsg: settings.sourceCrsEpsg,
    targetCrsEpsg: settings.targetCrsEpsg,
    preserveZ: settings.preserveZ,
    precisionDecimals: settings.precisionMode === 'fixed' ? settings.precisionDecimals : undefined,
  };
}

/** The prediction for one candidate target, or null when nothing is inspected yet. */
function predictionFor(targetFormatId: string): FidelityPrediction | null {
  const item = store.selected();
  if (!item?.profile) return null;
  return predictFromProfile(item.profile, targetFormatId, predictOptions());
}

function gradeTone(grade: FidelityGrade): 'ok' | 'warn' | 'error' {
  return grade === 'green' ? 'ok' : grade === 'yellow' ? 'warn' : 'error';
}

function renderFormats(): void {
  const state = store.get();
  const selected = store.selected();
  const kind = selected?.dataset?.kind ?? 'vector';
  const nativeReady = state.native.status === 'READY';

  const chips = $('categoryChips');
  chips.replaceChildren();
  const categories: (FormatCategory | null)[] = [null, 'gis', 'cad', 'raster', 'lidar', 'survey', 'gps', 'mining', 'spreadsheet'];
  for (const category of categories) {
    const label = category ? CATEGORY_LABEL[category] : 'All';
    const chip = element('button', { class: `chip${state.formatCategory === category ? ' chip--on' : ''}`, text: label });
    chip.addEventListener('click', () => {
      store.set({ formatCategory: category });
      render();
    });
    chips.append(chip);
  }

  const search = state.formatSearch.trim().toLowerCase();
  const candidates = selected ? exportTargetsFor(kind) : FORMATS.filter((format) => format.support.export !== 'none');
  const visible = candidates
    .filter((format) => !state.formatCategory || format.category === state.formatCategory)
    .filter(
      (format) =>
        !search ||
        format.name.toLowerCase().includes(search) ||
        format.extensions.some((extension) => extension.includes(search)) ||
        format.id.includes(search)
    )
    // Recent formats first — a user converting a hundred files to the same
    // target should not have to hunt for it. After that, and only once a file
    // has been inspected, the ranking is by what this particular data would
    // actually cost in each format (spec §25.3): a faithful target above a
    // lossy one above an impossible one. Before inspection there is nothing to
    // predict from, so it falls back to declared support.
    .sort((a, b) => {
      const recentA = state.settings.recentFormats.indexOf(a.id);
      const recentB = state.settings.recentFormats.indexOf(b.id);
      if (recentA !== recentB) return (recentA < 0 ? 99 : recentA) - (recentB < 0 ? 99 : recentB);

      const profile = selected?.profile;
      if (profile) {
        const score = (format: FormatDef) => {
          const prediction = predictFromProfile(profile, format.id, predictOptions());
          if (prediction.blocked) return 4;
          return prediction.overall === 'green' ? 0 : prediction.overall === 'yellow' ? 1 : 2;
        };
        const byFidelity = score(a) - score(b);
        if (byFidelity !== 0) return byFidelity;
      }

      const rank = (format: FormatDef) => (format.support.export === 'full' ? 0 : format.support.export === 'partial' ? 1 : 2);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });

  const container = $('formatCards');
  container.replaceChildren();
  if (visible.length === 0) {
    container.append(element('p', { class: 'muted small', text: 'No output format matches this search for the selected data.' }));
    return;
  }

  const current = selected?.targetFormatId ?? state.settings.globalTargetFormatId;
  for (const format of visible) {
    const available = isAvailable(format, 'export', nativeReady);
    const card = element('button', {
      class: `fcard${current === format.id ? ' fcard--on' : ''}`,
      type: 'button',
      title: [format.notes, ...(format.warnings ?? [])].filter(Boolean).join('\n\n'),
    }) as HTMLButtonElement;
    card.disabled = !available;

    card.append(element('span', { class: 'fcard__name', text: format.name }));
    card.append(element('span', { class: 'fcard__ext', text: format.extensions.map((extension) => `.${extension}`).join(' ') }));

    const badges = element('div', { class: 'fcard__badges' });
    badges.append(badge(SUPPORT_LABEL[format.support.export], format.support.export === 'full' ? 'ok' : format.support.export === 'partial' ? 'warn' : 'muted'));
    if (format.supports3D) badges.append(badge('3D', 'info'));
    if (format.supportsAttributes) badges.append(badge('attrs', 'muted'));
    if (format.supportsCRS) badges.append(badge('CRS', 'muted'));
    if (format.requiresNative) badges.append(badge(nativeReady ? 'native ready' : 'native required', nativeReady ? 'ok' : 'error'));
    if (format.requiresWasm) badges.append(badge('engine required', 'error'));
    if (format.packaging === 'zip') badges.append(badge('ZIP package', 'muted', 'Multiple files are packaged automatically.'));

    // The fidelity verdict for THIS data, not a generic capability claim. It is
    // the first badge because it is the one that decides whether this format is
    // the right choice.
    const prediction = available ? predictionFor(format.id) : null;
    if (prediction) {
      const tone = prediction.blocked ? 'error' : gradeTone(prediction.overall);
      badges.prepend(
        badge(prediction.blocked ? 'Not possible' : GRADE_LABEL[prediction.overall], tone, summarisePrediction(prediction))
      );
      if (prediction.blocked) card.disabled = true;
    }
    card.append(badges);

    if (prediction && !prediction.blocked && prediction.findings.length > 0) {
      const detail = element('span', { class: 'fcard__detail', text: summarisePrediction(prediction) });
      card.append(detail);
    }

    card.addEventListener('click', () => {
      if (selected) store.updateItem(selected.id, { targetFormatId: format.id });
      else void store.patchSettings({ globalTargetFormatId: format.id });
      render();
    });
    container.append(card);
  }
}

// ---------------------------------------------------------------- inspector

function renderInspector(): void {
  const state = store.get();
  const body = $('inspectorBody');
  const item = store.selected();
  body.replaceChildren();
  $('warnCount').textContent = String(item?.warnings.length ?? 0);

  if (!item) {
    body.append(element('p', { class: 'muted', style: 'padding:16px', text: 'Select a queued file to inspect it.' }));
    return;
  }

  if (item.error) {
    body.append(messageBlock('error', item.error.what, item.error.why, item.error.action));
  }

  switch (state.inspectorTab) {
    case 'overview':
      body.append(...overviewTab(item));
      break;
    case 'geometry':
      body.append(...geometryTab(item));
      break;
    case 'crs':
      body.append(...crsTab(item));
      break;
    case 'attributes':
      body.append(...attributesTab(item));
      break;
    case 'preview':
      renderPreview(item);
      break;
    case 'metadata':
      body.append(keyValues(Object.entries(item.dataset?.metadata ?? {}).map(([key, value]) => [key, formatValue(value)])));
      break;
    case 'fidelity':
      body.append(...fidelityTab(item));
      break;
    case 'compare':
      body.append(...compareTab(item));
      renderCompare(item);
      break;
    case 'warnings':
      body.append(...warningsTab(item));
      break;
    default:
      break;
  }
}

function messageBlock(kind: 'error' | 'warn' | 'info', what: string, why?: string, action?: string): HTMLElement {
  const node = element('div', { class: `msg msg--${kind}`, style: 'margin:12px' });
  node.append(element('span', { class: 'msg__icon', text: kind === 'error' ? '✕' : kind === 'warn' ? '!' : 'i' }));
  const body = element('div', { class: 'msg__body' });
  body.append(element('div', { class: 'msg__what', text: what }));
  if (why) body.append(element('div', { class: 'msg__why', text: why }));
  if (action) body.append(element('div', { class: 'msg__action', text: action }));
  node.append(body);
  return node;
}

function keyValues(pairs: [string, string][]): HTMLElement {
  const grid = element('div', { class: 'kv' });
  for (const [key, value] of pairs) {
    grid.append(element('div', { class: 'kv__k', text: key }));
    grid.append(element('div', { class: 'kv__v', text: value }));
  }
  return grid;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function overviewTab(item: QueueItem): HTMLElement[] {
  const dataset = item.dataset;
  const nodes: HTMLElement[] = [];

  if (item.status === 'blocked' && item.detection) {
    const block = messageBlock(
      'warn',
      `Detected as ${item.detection.formatName} with ${(item.detection.confidence * 100).toFixed(0)}% confidence.`,
      `That is below the ${(CONFIRM_THRESHOLD * 100).toFixed(0)}% threshold, so the format has to be confirmed before converting.`,
      'Pick the correct source format below.'
    );
    const select = element('select', { class: 'select', style: 'margin-top:8px' }) as HTMLSelectElement;
    select.append(element('option', { value: '', text: 'Confirm source format…' }));
    for (const format of FORMATS.filter((candidate) => candidate.support.import !== 'none')) {
      select.append(element('option', { value: format.id, text: `${format.name} (.${format.extensions[0]})` }));
    }
    select.addEventListener('change', () => {
      if (!select.value) return;
      store.updateItem(item.id, { forcedFormatId: select.value });
      void inspectItem(item.id);
    });
    block.querySelector('.msg__body')?.append(select);
    nodes.push(block);
  }

  if (!dataset) return nodes;

  const pairs: [string, string][] = [
    ['File', item.fileName],
    ['Size', formatBytes(item.size)],
    ['Detected', `${item.detection?.formatName ?? '—'}`],
    ['Confidence', item.detection ? `${(item.detection.confidence * 100).toFixed(0)}%` : '—'],
    ['Data kind', dataset.kind],
    ['CRS', crsLabel(dataset.crs)],
    ['CRS source', dataset.crsOrigin],
    ['Units', dataset.units ?? 'not declared'],
    ['Coordinate order', dataset.axisOrder],
    ['Vertical reference', dataset.vertical?.kind ?? 'unknown'],
  ];

  if (dataset.pointcloud) {
    const cloud = dataset.pointcloud;
    pairs.push(
      ['Total points', cloud.count.toLocaleString()],
      ['Loaded points', cloud.loaded.toLocaleString()],
      ['LAS version', cloud.version ?? '—'],
      ['Point format', String(cloud.pointFormat ?? '—')],
      ['Z range', cloud.bounds ? `${cloud.bounds.minZ.toFixed(3)} → ${cloud.bounds.maxZ.toFixed(3)}` : '—'],
      ['Attributes', Object.entries(cloud.attributes).filter(([, on]) => on).map(([name]) => name).join(', ') || 'none']
    );
  } else if (dataset.raster) {
    const raster = dataset.raster;
    pairs.push(
      ['Dimensions', `${raster.width} × ${raster.height} px`],
      ['Bands', String(raster.bandCount)],
      ['Pixel type', raster.pixelType],
      ['Pixel size', raster.geotransform ? `${Math.abs(raster.geotransform[1])} × ${Math.abs(raster.geotransform[5])}` : 'not georeferenced'],
      ['NoData', raster.noData === null ? 'none' : String(raster.noData)],
      ['Raster type', raster.isElevation ? 'elevation / DEM' : 'image'],
      ['Pixel data', raster.hasPixelData ? 'decoded' : 'not decoded — georeference only']
    );
  } else if (dataset.table) {
    pairs.push(
      ['Rows', dataset.table.rowCount.toLocaleString()],
      ['Columns', String(dataset.table.columns.length)],
      ['Detected schema', dataset.table.detectedSchema ?? 'none matched'],
      ['Header row', dataset.table.hasHeader ? 'yes' : 'no']
    );
  } else {
    const features = (dataset.layers ?? []).reduce((sum: number, layer: any) => sum + layer.featureCount, 0);
    pairs.push(['Layers', String(dataset.layers?.length ?? 0)], ['Features', features.toLocaleString()]);
  }

  nodes.push(keyValues(pairs));
  return nodes;
}

function geometryTab(item: QueueItem): HTMLElement[] {
  const dataset = item.dataset;
  if (!dataset?.layers?.length) return [element('p', { class: 'muted', style: 'padding:16px', text: 'No vector layers in this dataset.' })];
  const table = element('table', { class: 'table' });
  table.append(
    element('thead', {}, [
      element('tr', {}, [
        element('th', { text: 'Layer' }),
        element('th', { text: 'Features' }),
        element('th', { text: 'Geometry types' }),
        element('th', { text: 'Fields' }),
      ]),
    ])
  );
  const body = element('tbody');
  for (const layer of dataset.layers) {
    body.append(
      element('tr', {}, [
        element('td', { text: layer.name }),
        element('td', { class: 'num', text: layer.featureCount.toLocaleString() }),
        element('td', { text: layer.geometryTypes.join(', ') || '—' }),
        element('td', { class: 'num', text: String(layer.fields.length) }),
      ])
    );
  }
  table.append(body);
  return [element('div', { class: 'scroll-x' }, [table])];
}

function crsTab(item: QueueItem): HTMLElement[] {
  const state = store.get();
  const dataset = item.dataset;
  const nodes: HTMLElement[] = [];

  nodes.push(
    keyValues([
      ['Declared CRS', crsLabel(dataset?.crs ?? null)],
      ['Origin', dataset?.crsOrigin ?? 'unknown'],
      ['Axis order (authority)', dataset?.crs?.axisOrder ?? '—'],
      ['Datum', dataset?.crs?.datum ?? '—'],
      ['Projection', dataset?.crs?.projection ?? '—'],
      ['Linear unit', dataset?.crs?.unit ?? '—'],
    ])
  );

  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Source CRS (used when the file declares none)' }));
  section.append(crsSelect(state.settings.sourceCrsEpsg, (epsg) => void assignSourceCrs(item.id, epsg)));
  nodes.push(section);

  const targetSection = element('div', { class: 'section' });
  targetSection.append(element('h3', { class: 'section__title', text: 'Target CRS (leave unset to keep the source CRS)' }));
  targetSection.append(crsSelect(state.settings.targetCrsEpsg, (epsg) => void store.patchSettings({ targetCrsEpsg: epsg })));
  targetSection.append(
    element('p', { class: 'small faint', style: 'margin-top:8px', text: 'A datum shift outside the WGS 84 family is refused rather than approximated. Reproject those in QGIS or GDAL first.' })
  );
  nodes.push(targetSection);

  return nodes;
}

function crsSelect(current: number | null, onChange: (epsg: number | null) => void): HTMLElement {
  const wrap = element('div', { class: 'stack' });
  const search = element('input', { class: 'input', type: 'search', placeholder: 'Search EPSG code or name…' }) as HTMLInputElement;
  const select = element('select', { class: 'select' }) as HTMLSelectElement;

  const fill = (query: string) => {
    select.replaceChildren();
    select.append(element('option', { value: '', text: 'Not set' }));
    // Indian UTM zones first: they cover this product's primary field of use.
    const quick = QUICK_ZONES.map((zone) => utmCrs(zone, false));
    if (!query) {
      const group = element('optgroup', { label: 'Common UTM zones (India)' });
      for (const crs of quick) group.append(element('option', { value: String(crs.epsg), text: `EPSG:${crs.epsg} — ${crs.name}` }));
      select.append(group);
      const common = element('optgroup', { label: 'Common' });
      for (const code of [4326, 3857]) {
        const crs = crsFromEpsg(code)!;
        common.append(element('option', { value: String(code), text: `EPSG:${code} — ${crs.name}` }));
      }
      select.append(common);
    }
    const results = element('optgroup', { label: query ? 'Search results' : 'All bundled CRS' });
    for (const entry of searchEpsg(query, 60)) {
      results.append(element('option', { value: String(entry.code), text: `EPSG:${entry.code} — ${entry.name}` }));
    }
    select.append(results);
    select.value = current ? String(current) : '';
  };

  fill('');
  search.addEventListener('input', () => fill(search.value));
  select.addEventListener('change', () => {
    onChange(select.value ? Number(select.value) : null);
    render();
  });

  wrap.append(search, select);
  return wrap;
}

function attributesTab(item: QueueItem): HTMLElement[] {
  const dataset = item.dataset;
  if (dataset?.table) return [columnMappingPanel(item)];
  const fields = (dataset?.layers ?? []).flatMap((layer: any) => layer.fields);
  if (fields.length === 0) return [element('p', { class: 'muted', style: 'padding:16px', text: 'This dataset has no attribute fields.' })];
  const table = element('table', { class: 'table' });
  table.append(element('thead', {}, [element('tr', {}, [element('th', { text: 'Field' }), element('th', { text: 'Type' }), element('th', { text: 'Width' })])]));
  const body = element('tbody');
  for (const field of fields) {
    body.append(
      element('tr', {}, [
        element('td', { class: 'mono', text: field.name }),
        element('td', { text: field.type }),
        element('td', { class: 'num', text: String(field.width ?? '—') }),
      ])
    );
  }
  table.append(body);
  return [element('div', { class: 'scroll-x' }, [table])];
}

/** Column mapping with a preview table, as instruction §E requires. */
function columnMappingPanel(item: QueueItem): HTMLElement {
  const table = item.dataset.table;
  const wrap = element('div');

  if (table.mapping) {
    const roles = Object.entries(table.mapping.roles)
      .map(([role, index]) => `${role} → column ${Number(index) + 1} (${table.columns[Number(index)]?.name ?? '?'})`)
      .join('\n');
    wrap.append(
      messageBlock(
        item.status === 'blocked' ? 'warn' : 'info',
        `Schema: ${table.detectedSchema ?? 'user-defined'} · coordinate order ${table.mapping.coordinateOrder}`,
        roles,
        item.dataset.metadata?.schemaRationale
      )
    );
  } else {
    wrap.append(messageBlock('error', 'No coordinate columns identified.', 'Geometry cannot be built until easting/northing or longitude/latitude are named.', 'Pick the columns below.'));
  }

  const preview = element('table', { class: 'table' });
  preview.append(
    element('thead', {}, [
      element(
        'tr',
        {},
        table.columns.map((column: any, index: number) => {
          const role = Object.entries(table.mapping?.roles ?? {}).find(([, columnIndex]) => columnIndex === index)?.[0];
          return element('th', { text: role ? `${column.name} · ${role}` : column.name });
        })
      ),
    ])
  );
  const body = element('tbody');
  for (const row of table.previewRows.slice(0, 12)) {
    body.append(element('tr', {}, row.map((cell: unknown) => element('td', { class: 'mono', text: cell === null ? '' : String(cell) }))));
  }
  preview.append(body);
  wrap.append(element('div', { class: 'scroll-x' }, [preview]));
  wrap.append(element('p', { class: 'small faint', style: 'padding:0 12px 12px', text: `${table.rowCount.toLocaleString()} rows total; first ${Math.min(12, table.previewRows.length)} shown.` }));
  return wrap;
}

/**
 * "Show exactly what will be lost" (spec §22.3).
 *
 * Deliberately not a modal that interrupts: it is a tab the user can sit in
 * while trying different targets, because choosing a format IS the comparison.
 * Every row is one counted, named statement with the remedy beside it — a list
 * of vague risks would be worse than nothing, since it teaches people to ignore
 * the panel.
 */
function fidelityTab(item: QueueItem): HTMLElement[] {
  const wrap = element('div', { style: 'padding:12px' });
  const targetId = item.targetFormatId ?? store.get().settings.globalTargetFormatId;

  if (!item.profile) {
    wrap.append(element('p', { class: 'muted', text: 'Inspect the file first — the prediction is computed from the data, not from the format alone.' }));
    return [wrap];
  }
  if (!targetId) {
    wrap.append(element('p', { class: 'muted', text: 'Pick an output format to see what the conversion would cost.' }));
    return [wrap];
  }

  // The prediction the conversion itself would make, recomputed live so it
  // tracks the settings panel as the user changes precision or Z handling.
  const prediction = item.prediction?.targetFormatId === targetId ? item.prediction : predictFromProfile(item.profile, targetId, predictOptions());

  const head = element('div', { class: 'fidelity__head' });
  head.append(
    badge(prediction.blocked ? 'Not possible' : GRADE_LABEL[prediction.overall], prediction.blocked ? 'error' : gradeTone(prediction.overall))
  );
  head.append(element('span', { class: 'fidelity__target', text: `${item.dataset?.name ?? item.fileName} → ${prediction.targetFormatName}` }));
  wrap.append(head);

  if (item.prediction && item.prediction.targetFormatId === targetId) {
    wrap.append(element('p', { class: 'muted small', text: 'This is the prediction made before the conversion that has already run.' }));
  }

  // The axis grid: eleven verdicts at a glance, so an engineer can see that
  // geometry is fine and only attributes suffer, without reading every row.
  const grid = element('div', { class: 'fidelity__axes' });
  for (const axis of FIDELITY_AXES) {
    const grade = prediction.axes[axis];
    const cell = element('div', { class: `fidelity__axis fidelity__axis--${grade}` });
    cell.append(element('span', { class: 'fidelity__axis-name', text: AXIS_LABEL[axis] }));
    cell.append(element('span', { class: 'fidelity__axis-grade', text: GRADE_LABEL[grade] }));
    grid.append(cell);
  }
  wrap.append(grid);

  if (prediction.findings.length === 0) {
    wrap.append(element('p', { class: 'msg msg--info', text: 'Nothing is lost in this conversion. Every axis is faithful.' }));
    return [wrap];
  }

  // Losses first: a user scanning this list should meet the expensive news
  // before the merely-interesting news.
  const ordered = [...prediction.findings].sort((left, right) => (left.grade === right.grade ? 0 : left.grade === 'red' ? -1 : 1));
  for (const finding of ordered) {
    const node = element('div', { class: `msg msg--${finding.grade === 'red' ? 'error' : 'warn'}` });
    node.append(element('span', { class: 'msg__icon', text: finding.grade === 'red' ? '✕' : '!' }));
    const body = element('div', { class: 'msg__body' });
    body.append(element('div', { class: 'msg__what', text: finding.statement }));
    body.append(element('div', { class: 'msg__why', text: `${AXIS_LABEL[finding.axis]} · ${GRADE_LABEL[finding.grade]}` }));
    if (finding.remedy) body.append(element('div', { class: 'msg__action', text: finding.remedy }));
    node.append(body);
    wrap.append(node);
  }

  const foot = element('p', { class: 'muted small' });
  foot.textContent =
    'Predicted from what this data holds and what the format can store — no conversion has been run. ' +
    'Nothing here blocks the export: the trade-off is yours to make.';
  wrap.append(foot);
  return [wrap];
}

/**
 * Source versus output, measured (spec §30.2).
 *
 * The number is the deliverable here. "PASS" tells a surveyor signing off a
 * job nothing about whether the difference is rounding or a defect, so every
 * axis shows both values, the difference, and the tolerance it was judged
 * against — the format the master document asks for.
 */
function compareTab(item: QueueItem): HTMLElement[] {
  const wrap = element('div', { style: 'padding:12px' });

  if (!item.diff) {
    wrap.append(
      element('p', {
        class: 'muted',
        text: item.qa
          ? 'No measured comparison for this conversion — the target has no reader, so there is nothing to read back and compare against.'
          : 'Convert the file to compare its output with the source.',
      })
    );
    return [wrap];
  }

  const head = element('div', { class: 'fidelity__head' });
  head.append(badge(item.diff.passed ? 'Matches the source' : 'Differs from the source', item.diff.passed ? 'ok' : 'warn'));
  head.append(element('span', { class: 'fidelity__target', text: item.diff.summary }));
  wrap.append(head);

  const header = element('div', { class: 'diff__row diff__row--head' });
  for (const label of ['Axis', 'Source', 'Output', 'Difference', '']) header.append(element('span', { text: label }));
  wrap.append(header);

  for (const entry of item.diff.entries) {
    const row = element('div', { class: 'diff__row' });
    row.append(element('span', { class: 'diff__axis', text: DIFF_AXIS_LABEL[entry.axis] }));
    row.append(element('span', { class: 'diff__value', text: entry.source }));
    row.append(element('span', { class: 'diff__value', text: entry.output }));
    row.append(element('span', { class: 'diff__value', text: entry.difference }));

    const verdict =
      entry.verdict === 'differs' ? 'FAIL' : entry.verdict === 'not-comparable' ? 'N/A' : entry.verdict === 'identical' ? 'EXACT' : 'PASS';
    const tone = entry.verdict === 'differs' ? 'fail' : entry.verdict === 'not-comparable' ? 'na' : 'pass';
    const verdictNode = element('span', { class: `diff__verdict diff__verdict--${tone}`, text: verdict });
    if (entry.tolerance) verdictNode.title = `Tolerance ${entry.tolerance}`;
    row.append(verdictNode);

    if (entry.note) row.append(element('span', { class: 'diff__note', text: entry.note }));
    wrap.append(row);
  }

  wrap.append(
    element('p', {
      class: 'small faint',
      style: 'margin-top:10px',
      text: 'Measured against the output re-imported during QA, so these numbers describe the bytes that were actually written.',
    })
  );

  if (item.overlay) wrap.append(overlaySummary(item.overlay));
  return [wrap];
}

/**
 * The overlay's findings as text beside the canvases.
 *
 * The picture shows where; this says how many and how far, which is what gets
 * written into a handover note. An unpaired layer is stated rather than left as
 * an absence — a user who sees nothing marked "moved" must be able to tell the
 * difference between "nothing moved" and "we could not tell".
 */
function overlaySummary(overlay: GeometryOverlay): HTMLElement {
  const wrap = element('div', { class: 'section', style: 'margin-top:12px' });
  wrap.append(element('h3', { class: 'section__title', text: 'Where the differences are' }));
  wrap.append(element('p', { class: 'small', text: overlay.summary }));

  const roles = ['added', 'removed', 'moved', 'retyped'] as const;
  const chips = element('div', { class: 'chips' });
  for (const role of roles) {
    if (overlay.counts[role] === 0) continue;
    chips.append(element('span', { class: `chip chip--overlay chip--overlay-${role}`, text: `${OVERLAY_ROLE_LABEL[role]}: ${overlay.counts[role].toLocaleString()}` }));
  }
  if (chips.childElementCount > 0) wrap.append(chips);

  for (const unpaired of overlay.unpaired) {
    wrap.append(
      messageBlock(
        'warn',
        `Layer “${unpaired.layer}” could not be paired feature for feature.`,
        `${unpaired.sourceFeatures.toLocaleString()} features in the source, ${unpaired.outputFeatures.toLocaleString()} in the output. ${unpaired.reason}`
      )
    );
  }

  if (overlay.omitted > 0) {
    wrap.append(
      element('p', {
        class: 'small faint',
        text: `${overlay.omitted.toLocaleString()} more differences are counted above but not drawn — the canvas caps what it renders. The counts are exact.`,
      })
    );
  }

  return wrap;
}

function warningsTab(item: QueueItem): HTMLElement[] {
  if (item.warnings.length === 0) return [element('p', { class: 'muted', style: 'padding:16px', text: 'No warnings for this dataset.' })];
  const wrap = element('div', { style: 'padding:12px' });
  for (const warning of item.warnings) {
    const node = element('div', { class: `msg msg--${warning.severity === 'error' ? 'error' : warning.severity === 'warning' ? 'warn' : 'info'}` });
    node.append(element('span', { class: 'msg__icon', text: warning.severity === 'error' ? '✕' : warning.severity === 'warning' ? '!' : 'i' }));
    const body = element('div', { class: 'msg__body' });
    body.append(element('div', { class: 'msg__what', text: warning.count && warning.count > 1 ? `${warning.message} (×${warning.count})` : warning.message }));
    if (warning.reason) body.append(element('div', { class: 'msg__why', text: warning.reason }));
    if (warning.action) body.append(element('div', { class: 'msg__action', text: warning.action }));
    node.append(body);
    wrap.append(node);
  }
  return [wrap];
}

function renderPreview(item: QueueItem): void {
  const canvas = $('previewCanvas') as HTMLCanvasElement;
  if (!preview) preview = new PreviewCanvas(canvas, (text) => ($('readout').textContent = text));

  const dataset = item.dataset;
  const data: PreviewData = { layers: [], truncated: false };

  if (dataset?.layers?.length) {
    dataset.layers.forEach((layer: any, index: number) => {
      data.layers.push({
        name: layer.name,
        visible: true,
        color: LAYER_COLORS[index % LAYER_COLORS.length],
        features: layer.preview ?? [],
      });
      if (layer.previewTruncated) data.truncated = true;
    });
  }
  if (dataset?.pointcloud) {
    data.cloud = {
      x: dataset.pointcloud.previewX,
      y: dataset.pointcloud.previewY,
      z: dataset.pointcloud.previewZ,
      classification: dataset.pointcloud.previewClassification,
    };
    if (dataset.pointcloud.previewX.length < dataset.pointcloud.loaded) data.truncated = true;
  }
  if (dataset?.raster?.extent) {
    data.raster = {
      extent: dataset.raster.extent,
      label: `${dataset.raster.width} × ${dataset.raster.height}${dataset.raster.hasPixelData ? '' : ' — georeference only'}`,
    };
  }

  $('previewOnlyBadge').classList.toggle('hidden', !data.truncated);
  preview.setData(data);
}

/** Builds the drawable form of a worker-summarised dataset. */
function previewDataFor(dataset: any): PreviewData {
  const data: PreviewData = { layers: [], truncated: false };
  if (dataset?.layers?.length) {
    dataset.layers.forEach((layer: any, index: number) => {
      data.layers.push({
        name: layer.name,
        visible: true,
        color: LAYER_COLORS[index % LAYER_COLORS.length],
        features: layer.preview ?? [],
      });
      if (layer.previewTruncated) data.truncated = true;
    });
  }
  if (dataset?.pointcloud?.previewX) {
    data.cloud = {
      x: dataset.pointcloud.previewX,
      y: dataset.pointcloud.previewY,
      z: dataset.pointcloud.previewZ,
      classification: dataset.pointcloud.previewClassification,
    };
  }
  if (dataset?.raster?.extent) {
    data.raster = {
      extent: dataset.raster.extent,
      label: `${dataset.raster.width} × ${dataset.raster.height}${dataset.raster.hasPixelData ? '' : ' — georeference only'}`,
    };
  }
  return data;
}

/**
 * Splits the overlay into what each pane draws.
 *
 * The left pane gets the source geometry of every difference, the right pane
 * the output geometry — so a feature that exists only in the output appears on
 * the right and is simply absent on the left, which is the truth about it. The
 * alternative, drawing both sides on both canvases, produces two identical
 * pictures and answers nothing.
 */
function splitOverlay(overlay: GeometryOverlay | undefined): {
  source: PreviewData['overlay'];
  output: PreviewData['overlay'];
} {
  if (!overlay) return { source: [], output: [] };
  const source: NonNullable<PreviewData['overlay']> = [];
  const output: NonNullable<PreviewData['overlay']> = [];
  for (const item of overlay.items) {
    if (item.role === 'unchanged') continue;
    if (item.source) source.push({ role: item.role, geometry: item.source, at: item.at });
    if (item.output) output.push({ role: item.role, geometry: item.output, at: item.at });
  }
  return { source, output };
}

function renderCompare(item: QueueItem): void {
  const host = $('compareCanvas');
  if (!dual) {
    dual = new DualCanvas(host, {
      onReadout: (text, side) => ($('compareReadout').textContent = `${side === 'source' ? 'Source' : 'Output'} ${text}`),
      onAutoUnlink: (reason) => {
        store.set({ compareLinked: false });
        const note = $('compareNote');
        note.textContent = reason;
        note.classList.remove('hidden');
        updateLinkButton();
      },
    });
  }

  const overlay = splitOverlay(item.overlay);
  const sourceData = previewDataFor(item.dataset);
  sourceData.overlay = overlay.source;

  const hasOutput = Boolean(item.outputDataset);
  const outputData = hasOutput ? previewDataFor(item.outputDataset) : null;
  if (outputData) outputData.overlay = overlay.output;

  dual.setData(sourceData, outputData);
  dual.setLinked(store.get().compareLinked);
  dual.setStatus('source', describeDatasetShort(item.dataset));
  dual.setStatus(
    'output',
    hasOutput
      ? describeDatasetShort(item.outputDataset)
      : item.status === 'done'
        ? 'The target has no reader in this build, so the output cannot be drawn.'
        : 'Not converted yet.'
  );

  renderOverlayLegend(item.overlay);
  updateLinkButton();
}

function describeDatasetShort(dataset: any): string {
  if (!dataset) return '';
  const features = (dataset.layers ?? []).reduce((sum: number, layer: any) => sum + (layer.featureCount ?? 0), 0);
  const crs = dataset.crs ? crsLabel(dataset.crs) : 'no CRS declared';
  return `${features.toLocaleString()} features · ${crs}`;
}

function renderOverlayLegend(overlay: GeometryOverlay | undefined): void {
  const legend = $('compareLegend');
  legend.replaceChildren();
  if (!overlay) return;
  for (const role of ['added', 'removed', 'moved', 'retyped'] as const) {
    if (overlay.counts[role] === 0) continue;
    const item = element('span', { class: `compare__key compare__key--${role}` });
    item.append(element('i', { class: 'compare__swatch' }));
    item.append(element('span', { text: `${OVERLAY_ROLE_LABEL[role]} (${overlay.counts[role].toLocaleString()})` }));
    legend.append(item);
  }
}

function updateLinkButton(): void {
  const linked = store.get().compareLinked;
  const button = $('compareLinkBtn');
  button.textContent = linked ? 'Linked' : 'Unlinked';
  button.title = linked
    ? 'The two panes pan and zoom together. Click to move them independently.'
    : 'The two panes move independently. Click to link them.';
  button.classList.toggle('btn--on', linked);
}

// ------------------------------------------------------------ settings panel

function renderSettingsPanel(): void {
  const state = store.get();
  const panel = $('settingsPanel');
  panel.replaceChildren();
  const item = store.selected();
  const targetId = item?.targetFormatId ?? state.settings.globalTargetFormatId;
  if (!targetId) return;
  const target = getFormat(targetId);
  if (!target) return;

  const common = element('div', { class: 'section' });
  common.append(element('h3', { class: 'section__title', text: 'Conversion settings' }));
  common.append(
    checkbox('Preserve Z (elevations)', state.settings.preserveZ, (value) => void store.patchSettings({ preserveZ: value }))
  );
  common.append(
    checkbox('Run QA after conversion', state.settings.runQa, (value) => void store.patchSettings({ runQa: value }), 'Re-imports the output and compares it with the source.')
  );

  // Output structure sits beside precision because it is a first-class choice,
  // not an advanced one: it decides whether the delivery is one file or a tree.
  const layoutField = element('div', { class: 'field' });
  const layoutLabel = element('label', { class: 'field__label', text: 'Output structure' });
  layoutLabel.append(element('span', { class: 'hint', text: '?', title: OUTPUT_LAYOUT_DESCRIPTION[state.settings.outputLayout] }));
  layoutField.append(layoutLabel);
  const layoutSelect = element('select', { class: 'select' }) as HTMLSelectElement;
  for (const value of ['single', 'per-layer', 'mirror-source'] as OutputLayout[]) {
    layoutSelect.append(element('option', { value, text: OUTPUT_LAYOUT_LABEL[value] }));
  }
  layoutSelect.value = state.settings.outputLayout;
  layoutSelect.addEventListener('change', () => void store.patchSettings({ outputLayout: layoutSelect.value as OutputLayout }));
  layoutField.append(layoutSelect);
  layoutField.append(element('p', { class: 'small faint', text: OUTPUT_LAYOUT_DESCRIPTION[state.settings.outputLayout] }));

  const layerCount = item?.dataset?.layers?.length ?? 0;
  if (state.settings.outputLayout !== 'single' && layerCount > 1) {
    layoutField.append(
      element('p', {
        class: 'small muted',
        text: `${layerCount} layers will become ${layerCount} files, packaged as one ZIP whose folders are the layer hierarchy.`,
      })
    );
  }
  common.append(layoutField);

  const precision = element('div', { class: 'field' });
  precision.append(element('label', { class: 'field__label', text: 'Output precision' }));
  const precisionSelect = element('select', { class: 'select' }) as HTMLSelectElement;
  for (const [value, label] of [
    ['full', 'Full source precision'],
    ['3', '3 decimals (millimetre)'],
    ['4', '4 decimals'],
    ['5', '5 decimals'],
    ['6', '6 decimals'],
  ] as [string, string][]) {
    precisionSelect.append(element('option', { value, text: label }));
  }
  precisionSelect.value = state.settings.precisionMode === 'full' ? 'full' : String(state.settings.precisionDecimals);
  precisionSelect.addEventListener('change', () => {
    const value = precisionSelect.value;
    void store.patchSettings(value === 'full' ? { precisionMode: 'full' } : { precisionMode: 'fixed', precisionDecimals: Number(value) });
  });
  precision.append(precisionSelect);
  common.append(precision);
  panel.append(common);

  // Target-specific settings, so the panel only ever shows what applies.
  const specific = element('details', { class: 'adv' });
  specific.append(element('summary', { text: `${target.name} options` }));
  const body = element('div');

  if (target.id === 'dxf') {
    body.append(
      numberField('Arc segmentation tolerance (sagitta, drawing units)', state.settings.arcTolerance, 0.0001, (value) =>
        void store.patchSettings({ arcTolerance: value })
      )
    );
    body.append(element('p', { class: 'small faint', text: 'Curved entities have no GIS equivalent. A smaller tolerance follows the true curve more closely at the cost of more vertices.' }));
  }
  if (target.id === 'kml' || target.id === 'kmz') {
    body.append(element('p', { class: 'small faint', text: 'KML is written in WGS 84 longitude/latitude. Set the target CRS to EPSG:4326 so projected data is transformed rather than mis-placed.' }));

    const templateField = element('div', { class: 'field' });
    templateField.append(element('label', { class: 'field__label', text: 'Balloon template' }));
    const templateSelect = element('select', { class: 'select' }) as HTMLSelectElement;
    for (const template of ['plain', 'cadastral', 'survey', 'borehole', 'mining', 'contour'] as KmlTemplate[]) {
      templateSelect.append(element('option', { value: template, text: KML_TEMPLATE_LABEL[template] }));
    }
    templateSelect.value = state.settings.kmlTemplate;
    templateSelect.addEventListener('change', () => void store.patchSettings({ kmlTemplate: templateSelect.value as KmlTemplate }));
    templateField.append(templateSelect);
    templateField.append(element('p', { class: 'small faint', text: KML_TEMPLATE_DESCRIPTION[state.settings.kmlTemplate] }));
    body.append(templateField);

    body.append(
      checkbox(
        'Render boreholes as core logs',
        state.settings.kmlBoreholeLog,
        (value) => void store.patchSettings({ kmlBoreholeLog: value }),
        'Joins collars to their depth intervals by hole id and renders a full log — from, to, thickness, lithology, recovery, RQD, sample and assay — in each balloon.'
      )
    );
    body.append(
      textField('Balloon footer (optional)', state.settings.kmlBalloonFooter, (value) => void store.patchSettings({ kmlBalloonFooter: value }))
    );
    body.append(
      element('p', {
        class: 'small faint',
        text: 'Fields whose names or values look like credentials are left out of the balloons, and the omission is reported. A KMZ is shared freely, so a token inside one has leaked.',
      })
    );
  }
  if (target.id === 'shapefile') {
    body.append(element('p', { class: 'small faint', text: 'Mixed geometry is split into _point, _line and _polygon files, and the package is delivered as one ZIP with .prj and .cpg. DBF field names are capped at 10 bytes; every rename is listed in the manifest.' }));
  }
  if (target.id === 'las') {
    body.append(element('p', { class: 'small faint', text: 'Scale and offset are derived from the data extent unless pinned, so the stored resolution matches the data rather than a default.' }));
  }
  if (target.dataKind === 'pointcloud' || item?.dataset?.pointcloud) {
    const decimation = element('div', { class: 'field' });
    decimation.append(element('label', { class: 'field__label', text: 'Decimation (export)' }));
    const select = element('select', { class: 'select' }) as HTMLSelectElement;
    for (const [value, label] of [
      ['none', 'None — every point'],
      ['nth', 'Keep every nth point'],
      ['grid', 'One point per 2D grid cell'],
      ['voxel', 'One point per 3D voxel'],
    ] as [string, string][]) {
      select.append(element('option', { value, text: label }));
    }
    select.value = state.settings.decimationMode;
    select.addEventListener('change', () => void store.patchSettings({ decimationMode: select.value as AppSettings['decimationMode'] }));
    decimation.append(select);
    body.append(decimation);
    if (state.settings.decimationMode === 'nth') {
      body.append(numberField('Keep every nth point', state.settings.decimationFactor, 1, (value) => void store.patchSettings({ decimationFactor: value })));
    }
    if (state.settings.decimationMode === 'grid' || state.settings.decimationMode === 'voxel') {
      body.append(numberField('Cell size (dataset units)', state.settings.decimationCell, 0.01, (value) => void store.patchSettings({ decimationCell: value })));
    }
  }

  body.append(
    checkbox('Embed conversion metadata alongside the output', state.settings.embedMetadata, (value) => void store.patchSettings({ embedMetadata: value }))
  );
  specific.append(body);
  panel.append(specific);

  // Repair is deliberately buried and off: survey data is evidence.
  const repair = element('details', { class: 'adv' });
  repair.append(element('summary', { text: 'Geometry repair (off by default)' }));
  const repairBody = element('div');
  repairBody.append(element('p', { class: 'small faint', text: 'Repair edits your geometry. It stays off so survey data converts exactly as delivered; every change it makes is reported.' }));
  repairBody.append(checkbox('Close unclosed rings', state.settings.repairCloseRings, (value) => void store.patchSettings({ repairCloseRings: value })));
  repairBody.append(checkbox('Remove duplicate vertices', state.settings.repairRemoveDuplicateVertices, (value) => void store.patchSettings({ repairRemoveDuplicateVertices: value })));
  repairBody.append(checkbox('Normalise ring orientation', state.settings.repairNormalizeOrientation, (value) => void store.patchSettings({ repairNormalizeOrientation: value })));
  repairBody.append(checkbox('Remove duplicate features', state.settings.repairDeduplicateFeatures, (value) => void store.patchSettings({ repairDeduplicateFeatures: value })));
  repair.append(repairBody);
  panel.append(repair);

  // Cadastral tools. Only shown for vector data, because polygonising a point
  // cloud or burning text into a raster is meaningless and an option that can
  // never apply is noise.
  const layerNames: string[] = (item?.dataset?.layers ?? []).map((layer: { name: string }) => layer.name);
  if (item?.dataset?.kind === 'vector' && layerNames.length > 0) {
    panel.append(cadastralTools(state.settings, layerNames));
  }
}

/**
 * The CAD-to-cadastral-GIS tools (spec §27).
 *
 * Both change the data, so both are off until switched on, and each states what
 * it will do before it does it. They live together because they are one
 * workflow: a cadastral DXF needs polygonising *and* burning-in, in that order,
 * and separating them would hide that.
 */
function cadastralTools(settings: AppSettings, layerNames: string[]): HTMLElement {
  const tools = element('details', { class: 'adv' });
  tools.append(element('summary', { text: 'Cadastral tools — polygons and labels from CAD' }));
  const body = element('div');
  body.append(
    element('p', {
      class: 'small faint',
      text: 'A cadastral drawing holds boundaries as line work and plot numbers as separate text, with nothing linking them. These two steps make that link explicit. Both are off by default and both change your data.',
    })
  );

  // ---- Polygonise -------------------------------------------------------
  body.append(
    checkbox(
      'Build polygons from closed CAD line work',
      settings.polygonizeEnabled,
      (value) => void store.patchSettings({ polygonizeEnabled: value }),
      'Assembles separate LINE entities into closed boundaries, so parcels export as areas rather than as strokes.'
    )
  );
  if (settings.polygonizeEnabled) {
    body.append(
      numberField('Largest gap that may be closed (dataset units)', settings.polygonizeTolerance, 0.0001, (value) =>
        void store.patchSettings({ polygonizeTolerance: value })
      )
    );
    body.append(
      element('p', {
        class: 'small faint',
        text: 'Closing a few millimetres recovers a snap error. Closing metres invents a boundary — a gap larger than this is left as an open line and reported.',
      })
    );
    body.append(
      checkbox('Keep the source line work alongside the polygons', settings.polygonizeKeepLines, (value) =>
        void store.patchSettings({ polygonizeKeepLines: value })
      )
    );
  }

  // ---- Burn-in ----------------------------------------------------------
  body.append(
    checkbox(
      'Attach text found inside polygons to those polygons',
      settings.burnInEnabled,
      (value) => void store.patchSettings({ burnInEnabled: value }),
      'The plot number drawn beside a boundary becomes an attribute on it, so it survives into any GIS format.'
    )
  );
  if (settings.burnInEnabled) {
    const targetField = element('div', { class: 'field' });
    targetField.append(element('label', { class: 'field__label', text: 'Polygon layer to label' }));
    const targetSelect = element('select', { class: 'select' }) as HTMLSelectElement;
    targetSelect.append(element('option', { value: '', text: 'Choose a layer…' }));
    for (const name of layerNames) targetSelect.append(element('option', { value: name, text: name }));
    targetSelect.value = settings.burnInTargetLayer;
    targetSelect.addEventListener('change', () => void store.patchSettings({ burnInTargetLayer: targetSelect.value }));
    targetField.append(targetSelect);
    body.append(targetField);

    const modeField = element('div', { class: 'field' });
    modeField.append(element('label', { class: 'field__label', text: 'How the text is attached' }));
    const modeSelect = element('select', { class: 'select' }) as HTMLSelectElement;
    for (const mode of ['attribute', 'label', 'geometry', 'cad', 'kml'] as BurnInMode[]) {
      modeSelect.append(element('option', { value: mode, text: BURN_IN_MODE_LABEL[mode] }));
    }
    modeSelect.value = settings.burnInMode;
    modeSelect.addEventListener('change', () => void store.patchSettings({ burnInMode: modeSelect.value as BurnInMode }));
    modeField.append(modeSelect);
    modeField.append(element('p', { class: 'small faint', text: BURN_IN_MODE_DESCRIPTION[settings.burnInMode] }));
    body.append(modeField);

    body.append(
      textField('Field name for the value', settings.burnInField, (value) => void store.patchSettings({ burnInField: value }))
    );

    const priorityField = element('div', { class: 'field' });
    priorityField.append(element('label', { class: 'field__label', text: 'When a polygon holds several texts' }));
    const prioritySelect = element('select', { class: 'select' }) as HTMLSelectElement;
    for (const priority of ['nearest-to-centre', 'largest-text', 'first-found', 'concatenate', 'named-field'] as BurnInPriority[]) {
      prioritySelect.append(element('option', { value: priority, text: PRIORITY_LABEL[priority] }));
    }
    prioritySelect.value = settings.burnInPriority;
    prioritySelect.addEventListener('change', () => void store.patchSettings({ burnInPriority: prioritySelect.value as BurnInPriority }));
    priorityField.append(prioritySelect);
    priorityField.append(
      element('p', { class: 'small faint', text: 'Whichever rule is used, the candidates it rejected are listed in the conversion report.' })
    );
    body.append(priorityField);

    body.append(
      checkbox(
        'Delete the source text after attaching it',
        settings.burnInReplaceSource,
        (value) => void store.patchSettings({ burnInReplaceSource: value }),
        'Off by default. Burn-in adds an association; it should not have to destroy the drawing it was read from.'
      )
    );
  }

  tools.append(body);
  return tools;
}

/** A single-line text input, for a field name and similar. */
function textField(label: string, value: string, onChange: (next: string) => void): HTMLElement {
  const wrap = element('div', { class: 'field' });
  wrap.append(element('label', { class: 'field__label', text: label }));
  const input = element('input', { class: 'input', type: 'text' }) as HTMLInputElement;
  input.value = value;
  input.addEventListener('change', () => onChange(input.value.trim()));
  wrap.append(input);
  return wrap;
}

function checkbox(label: string, checked: boolean, onChange: (value: boolean) => void, hint?: string): HTMLElement {
  const wrap = element('label', { class: 'checkbox' });
  const input = element('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => {
    onChange(input.checked);
    render();
  });
  wrap.append(input, element('span', { text: label }));
  if (hint) wrap.append(element('span', { class: 'hint', text: '?', title: hint }));
  return wrap;
}

function numberField(label: string, value: number, step: number, onChange: (value: number) => void): HTMLElement {
  const wrap = element('div', { class: 'field' });
  wrap.append(element('label', { class: 'field__label', text: label }));
  const input = element('input', { class: 'input', type: 'number', step: String(step), value: String(value) }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) {
      onChange(parsed);
      render();
    }
  });
  wrap.append(input);
  return wrap;
}

// -------------------------------------------------------------------- bottom

// ------------------------------------------------- history, workflows, project

function historyOf(item: QueueItem | undefined): HistoryState {
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
function historyPanel(item: QueueItem | undefined): HTMLElement[] {
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
    render();
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

function historyRow(
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
function stepHistory(itemId: string, position: number): void {
  const item = store.get().items.find((entry) => entry.id === itemId);
  if (!item?.history) return;
  const stepped = revertTo(item.history, item.dataset, position);
  store.updateItem(itemId, { history: stepped.history, dataset: stepped.dataset });
  if (stepped.entry) {
    store.log('info', `${item.fileName}: history moved to “${position === 0 ? 'as imported' : stepped.entry.label}”.`);
  }
  render();
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
async function assignSourceCrs(itemId: string, epsg: number | null): Promise<void> {
  await store.patchSettings({ sourceCrsEpsg: epsg });

  const item = store.get().items.find((entry) => entry.id === itemId);
  if (!item?.dataset || item.dataset.crsOrigin === 'declared' || item.dataset.crsOrigin === 'sidecar') {
    render();
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
  render();
}

/** The settings in force, in the shape a workflow records and replays. */
function workflowSettings(): WorkflowSettings {
  const settings = store.get().settings;
  return {
    globalTargetFormatId: settings.globalTargetFormatId ?? undefined,
    outputLayout: settings.outputLayout,
    precisionMode: settings.precisionMode,
    precisionDecimals: settings.precisionDecimals,
    preserveZ: settings.preserveZ,
    sourceCrsEpsg: settings.sourceCrsEpsg,
    targetCrsEpsg: settings.targetCrsEpsg,
    arcTolerance: settings.arcTolerance,
    kmlTemplate: settings.kmlTemplate,
    kmlBoreholeLog: settings.kmlBoreholeLog,
    kmlBalloonFooter: settings.kmlBalloonFooter,
    polygonizeEnabled: settings.polygonizeEnabled,
    polygonizeTolerance: settings.polygonizeTolerance,
    polygonizeKeepLines: settings.polygonizeKeepLines,
    burnInEnabled: settings.burnInEnabled,
    burnInField: settings.burnInField,
    burnInMode: settings.burnInMode,
    burnInPriority: settings.burnInPriority,
    burnInReplaceSource: settings.burnInReplaceSource,
    decimationMode: settings.decimationMode,
    mirrorBatchTree: settings.mirrorBatchTree,
    repairCloseRings: settings.repairCloseRings,
    repairRemoveDuplicateVertices: settings.repairRemoveDuplicateVertices,
    repairNormalizeOrientation: settings.repairNormalizeOrientation,
    repairDeduplicateFeatures: settings.repairDeduplicateFeatures,
    snapTolerance: settings.snapTolerance,
    runQa: settings.runQa,
    embedMetadata: settings.embedMetadata,
  };
}

function workflowsPanel(): HTMLElement[] {
  const state = store.get();
  const wrap = element('div', { style: 'padding:12px' });

  const controls = element('div', { class: 'row', style: 'gap:8px; margin-bottom:10px; flex-wrap:wrap' });
  const record = element('button', { class: 'btn btn--primary', type: 'button', text: 'Record current settings as a workflow' });
  record.addEventListener('click', () => saveWorkflowFromSettings());
  controls.append(record);
  wrap.append(controls);

  wrap.append(
    element('p', {
      class: 'small faint',
      text: 'A workflow replays the settings that produced a conversion on new data. Steps that would ask before running — a CRS assertion, polygonisation, a burn-in that deletes the source text — still ask on replay.',
    })
  );

  if (state.workflows.length === 0) {
    wrap.append(element('p', { class: 'muted', text: 'No workflows saved yet.' }));
    return [wrap];
  }

  for (const workflow of state.workflows) {
    const card = element('div', { class: 'section' });
    const head = element('div', { class: 'row', style: 'gap:8px; align-items:center' });
    head.append(element('h3', { class: 'section__title', style: 'margin:0', text: workflow.name }));
    head.append(element('span', { class: 'topbar__spacer' }));

    const runButton = element('button', { class: 'btn', type: 'button', text: 'Replay' }) as HTMLButtonElement;
    runButton.disabled = !store.selected();
    runButton.title = store.selected() ? 'Applies this workflow to the selected file.' : 'Select a file to replay a workflow onto it.';
    runButton.addEventListener('click', () => void replayWorkflow(workflow));
    head.append(runButton);

    const remove = element('button', { class: 'btn btn--ghost', type: 'button', text: 'Delete' });
    remove.addEventListener('click', () => {
      store.set({ workflows: store.get().workflows.filter((entry) => entry.id !== workflow.id) });
      store.log('info', `Workflow “${workflow.name}” deleted.`);
      render();
    });
    head.append(remove);
    card.append(head);

    if (workflow.recordedFrom) {
      card.append(element('p', { class: 'small faint', text: `Recorded from a ${workflow.recordedFrom.toUpperCase()} source.` }));
    }

    const steps = element('ol', { class: 'workflow__steps' });
    for (const line of describeWorkflow(workflow)) {
      steps.append(element('li', { class: 'workflow__step', text: line.replace(/^\d+\.\s*/, '') }));
    }
    card.append(steps);

    for (const problem of validateWorkflow(workflow)) {
      card.append(messageBlock(problem.severity === 'error' ? 'error' : 'warn', problem.message));
    }

    wrap.append(card);
  }

  return [wrap];
}

function saveWorkflowFromSettings(): void {
  const item = store.selected();
  const suggestion = item?.detection?.formatId ? `${item.detection.formatId.toUpperCase()} job` : 'New workflow';
  const name = window.prompt('Name this workflow', suggestion);
  if (!name) return;

  const workflow = recordWorkflow(workflowSettings(), { name, recordedFrom: item?.detection?.formatId });
  const problems = validateWorkflow(workflow);
  const blocking = problems.filter((problem) => problem.severity === 'error');
  if (blocking.length > 0) {
    store.log('error', `Workflow “${name}” not saved: ${blocking.map((problem) => problem.message).join(' ')}`);
    render();
    return;
  }

  store.set({ workflows: [...store.get().workflows, workflow] });
  store.log('ok', `Workflow “${name}” saved with ${workflow.steps.length} steps.`);
  render();
}

/**
 * Replays a workflow onto the selected file.
 *
 * The confirmation handler is a real prompt, not a rubber stamp: it is what
 * keeps a replayed step and a hand-run step the same act (R18). A user who
 * cancels a step gets a conversion without it, and the log says which step did
 * not run rather than reporting a clean replay.
 */
async function replayWorkflow(workflow: Workflow): Promise<void> {
  const item = store.selected();
  if (!item) return;

  const result = await runWorkflow(workflow, {
    base: workflowSettings(),
    confirm: (request) =>
      window.confirm(
        `${workflow.name} — step ${request.index} of ${request.total}\n\n${request.step.label}\n\n${request.confirmation.what}\n\n${request.confirmation.why}\n\nRun this step?`
      ),
  });

  const patch: Partial<AppSettings> = {};
  for (const [key, value] of Object.entries(result.settings)) {
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }
  await store.patchSettings(patch);

  store.log(result.complete ? 'ok' : 'warn', result.summary);
  render();
}

/**
 * Saves the project (§31.4).
 *
 * Sources are recorded as identities rather than embedded: see `core/project.ts`
 * for why. What travels is every decision — CRS, settings, edits, workflows and
 * the export configuration — which is what makes reopening one resume the job
 * rather than restart it.
 */
async function saveProject(): Promise<void> {
  const state = store.get();
  const name = window.prompt('Project name', state.projectName ?? 'Untitled project');
  if (!name) return;

  const sources: ProjectSource[] = state.items.map((item) => ({
    id: item.id,
    fileName: item.fileName,
    path: item.path,
    containers: item.containers ?? [],
    size: item.size,
    sha256: item.provenance?.sha256,
    formatId: item.detection?.formatId ?? 'unknown',
    formatName: item.detection?.formatName ?? 'Unknown',
    detectionConfidence: item.detection?.confidence ?? 0,
    forcedFormatId: item.forcedFormatId,
    crs: item.dataset?.crs ?? null,
    crsOrigin: item.dataset?.crsOrigin ?? 'unknown',
    targetFormatId: item.targetFormatId,
    carriage: 'reference',
    history: item.history ? { entries: item.history.entries, position: item.history.position, dropped: item.history.dropped } : undefined,
    qa: item.qa ? { passed: item.qa.verdict === 'PASS', summary: item.qa.summary, checkedAt: Date.now() } : undefined,
    diff: item.diff ? { passed: item.diff.passed, summary: item.diff.summary } : undefined,
  }));

  const project = buildProject({
    name,
    productVersion: ENGINE_VERSION,
    settings: state.settings as unknown as Record<string, unknown>,
    sources,
    workflows: state.workflows,
    exportConfig: {
      globalTargetFormatId: state.settings.globalTargetFormatId,
      outputLayout: state.settings.outputLayout,
      naming: state.settings.naming,
      mirrorBatchTree: state.settings.mirrorBatchTree,
      embedMetadata: state.settings.embedMetadata,
    },
  });

  downloadBytes(writeProject(project), `${sanitiseFileName(name)}.${PROJECT_EXTENSION}`, 'application/json');
  store.set({ projectName: name });
  if (project.droppedSecretFields.length > 0) {
    store.log('warn', `Project saved. ${project.droppedSecretFields.length} credential-shaped field(s) were not written: ${project.droppedSecretFields.join(', ')}.`);
  } else {
    store.log('ok', `Project “${name}” saved with ${sources.length} source(s) and ${state.workflows.length} workflow(s).`);
  }
  render();
}

/** Opens a project file and restores what does not need the source bytes. */
async function openProject(file: File): Promise<void> {
  const result = readProject(new Uint8Array(await file.arrayBuffer()));
  if (!result.project) {
    store.log('error', `${file.name}: ${result.error?.what} ${result.error?.why} ${result.error?.action}`);
    render();
    return;
  }

  const project = result.project;
  for (const note of result.notes) store.log('info', `${project.name}: ${note}`);

  // Settings are merged over the defaults so a project written by an older
  // build gains this build's new settings instead of leaving them undefined.
  await store.patchSettings({ ...DEFAULT_SETTINGS, ...(project.settings as Partial<AppSettings>) });
  store.set({ workflows: project.workflows, projectName: project.name });

  const matches = matchSources(
    project,
    store.get().items.map((item) => ({ fileName: item.fileName, path: item.path, size: item.size, sha256: item.provenance?.sha256 }))
  );
  store.log('ok', `Project “${project.name}” opened. ${summariseMatches(matches)}`);

  for (const match of matches) {
    if (match.state === 'same' || match.state === 'missing') continue;
    store.log('warn', `${match.source.fileName}: ${match.note}`);
  }
  render();
}

function sanitiseFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

/**
 * Selects a tab from code, moving the button state with it.
 *
 * Setting `inspectorTab` alone renders the right panel under the wrong
 * highlighted tab — a small inconsistency that makes a palette command look
 * like it half worked.
 */
function showInspectorTab(name: string): void {
  store.set({ inspectorTab: name });
  for (const tab of Array.from(document.querySelectorAll('[data-tab]'))) {
    const on = (tab as HTMLElement).dataset.tab === name;
    tab.classList.toggle('tab--on', on);
    tab.setAttribute('aria-selected', String(on));
  }
  render();
}

function showBottomTab(name: string): void {
  store.set({ bottomTab: name });
  for (const tab of Array.from(document.querySelectorAll('[data-bottom]'))) {
    tab.classList.toggle('tab--on', (tab as HTMLElement).dataset.bottom === name);
  }
  renderBottom();
}

function renderBottom(): void {
  const state = store.get();
  const body = $('bottomBody');
  body.replaceChildren();

  if (state.bottomTab === 'log') {
    const log = element('div', { class: 'log' });
    for (const entry of state.log) {
      const line = element('div', { class: `log__line log__line--${entry.level}` });
      line.append(element('span', { class: 'log__time', text: new Date(entry.at).toLocaleTimeString() }));
      line.append(element('span', { class: 'log__msg', text: entry.message }));
      log.append(line);
    }
    body.append(log);
    log.scrollTop = log.scrollHeight;
    return;
  }

  if (state.bottomTab === 'manifest') {
    if (!state.manifestCsv) {
      body.append(element('p', { class: 'muted', style: 'padding:16px', text: 'Convert a batch and choose Batch ZIP to produce a manifest.' }));
      return;
    }
    body.append(element('pre', { class: 'log', text: state.manifestCsv }));
    return;
  }

  if (state.bottomTab === 'workflows') {
    body.append(...workflowsPanel());
    return;
  }

  const item = store.selected();

  if (state.bottomTab === 'history') {
    body.append(...historyPanel(item));
    return;
  }

  if (state.bottomTab === 'delivery') {
    if (!item?.tree?.length) {
      body.append(
        element('p', {
          class: 'muted',
          style: 'padding:16px',
          text: 'Convert a file to see the structure of its delivery — the folders and files it produced.',
        })
      );
      return;
    }
    const header = element('div', { class: 'qa__verdict' });
    header.append(badge(`${item.tree.length} file${item.tree.length === 1 ? '' : 's'}`, 'accent'));
    header.append(
      element('span', {
        class: 'muted',
        text:
          item.outputs && item.outputs.length === 1 && item.outputs[0].name.endsWith('.zip')
            ? `Packaged as ${item.outputs[0].name} — the ZIP's folders are this tree.`
            : 'Delivered as loose file(s).',
      })
    );
    body.append(header);
    body.append(element('pre', { class: 'log', text: describeTree(item.tree).join('\n') }));
    return;
  }

  if (!item?.qa) {
    body.append(element('p', { class: 'muted', style: 'padding:16px', text: 'Convert a file to see its fidelity report.' }));
    return;
  }

  const verdict = element('div', { class: 'qa__verdict' });
  const kind = item.qa.verdict === 'PASS' ? 'ok' : item.qa.verdict === 'FAILED' ? 'error' : item.qa.verdict === 'NOT_VALIDATED' ? 'muted' : 'warn';
  verdict.append(badge(`Fidelity: ${item.qa.verdict.replace(/_/g, ' ')}`, kind));
  verdict.append(element('span', { class: 'muted', text: item.qa.summary }));
  body.append(verdict);

  if (item.qa.checks.length > 0) {
    const table = element('table', { class: 'table' });
    table.append(
      element('thead', {}, [
        element('tr', {}, [element('th', { text: 'Check' }), element('th', { text: 'Source' }), element('th', { text: 'Re-imported output' }), element('th', { text: 'Result' })]),
      ])
    );
    const tbody = element('tbody');
    for (const check of item.qa.checks) {
      const row = element('tr');
      row.append(element('td', { text: check.name }));
      row.append(element('td', { class: 'mono', text: check.source }));
      row.append(element('td', { class: 'mono', text: check.target }));
      const statusCell = element('td');
      statusCell.append(badge(check.status, check.status === 'pass' ? 'ok' : check.status === 'fail' ? 'error' : check.status === 'warn' ? 'warn' : 'muted'));
      if (check.note) statusCell.append(element('div', { class: 'small muted', text: check.note }));
      row.append(statusCell);
      tbody.append(row);
    }
    table.append(tbody);
    body.append(element('div', { class: 'scroll-x' }, [table]));
  }
}

// --------------------------------------------------------------------- setup

function openSettingsDialog(): void {
  const dialog = $('settingsDialog') as HTMLDialogElement;
  const state = store.get();
  dialog.replaceChildren();

  const head = element('div', { class: 'dialog__head' });
  head.append(element('span', { class: 'dialog__title', text: 'Settings' }));
  const close = element('button', { class: 'btn btn--ghost', text: 'Close' });
  close.addEventListener('click', () => dialog.close());
  head.append(close);

  const body = element('div', { class: 'dialog__body stack' });

  body.append(element('h3', { class: 'section__title', text: 'Privacy' }));
  body.append(
    messageBlock(
      'info',
      'Local-only mode is on and cannot be switched off.',
      'No file byte ever leaves this machine. There is no network code in any conversion path, no telemetry, and host_permissions is empty.',
      'The only local process ever contacted is the optional DWG helper you install yourself.'
    )
  );

  body.append(element('h3', { class: 'section__title', text: 'Native engine' }));
  body.append(
    keyValues([
      ['Status', NATIVE_STATUS_LABEL[state.native.status]],
      ['Detail', state.native.message],
      ['Engine', state.native.engine ? `${state.native.engine.name} ${state.native.engine.version}` : '—'],
      ['Path', state.native.engine?.path || '—'],
    ])
  );
  const rescan = element('button', { class: 'btn', text: 'Re-scan engines' });
  rescan.addEventListener('click', () => void refreshNative());
  body.append(rescan);

  body.append(element('h3', { class: 'section__title', text: 'Performance' }));
  body.append(numberField('Parallel jobs', state.settings.parallelJobs, 1, (value) => void store.patchSettings({ parallelJobs: Math.max(1, Math.round(value)) })));
  body.append(numberField('Maximum archive expansion (MB)', state.settings.maxArchiveMb, 64, (value) => void store.patchSettings({ maxArchiveMb: value })));

  body.append(element('h3', { class: 'section__title', text: 'Delivery structure' }));
  body.append(
    checkbox(
      'Mirror the input folder tree in a batch ZIP',
      state.settings.mirrorBatchTree,
      (value) => void store.patchSettings({ mirrorBatchTree: value }),
      'Each converted file is placed under the folder its source came from, so two files with the same name in different folders stay apart.'
    )
  );

  body.append(element('h3', { class: 'section__title', text: 'Naming' }));
  const naming = element('select', { class: 'select' }) as HTMLSelectElement;
  for (const [value, label] of [
    ['converted-to', '{name}_converted_to_{format}.{ext}'],
    ['target-suffix', '{name}_{format}.{ext}'],
    ['dated', '{name}_{date}_{format}.{ext}'],
  ] as [string, string][]) {
    naming.append(element('option', { value, text: label }));
  }
  naming.value = state.settings.naming;
  naming.addEventListener('change', () => void store.patchSettings({ naming: naming.value as AppSettings['naming'] }));
  body.append(naming);

  const foot = element('div', { class: 'dialog__foot' });
  const reset = element('button', { class: 'btn btn--danger', text: 'Reset to defaults' });
  reset.addEventListener('click', () => {
    void store.patchSettings({ ...DEFAULT_SETTINGS });
    dialog.close();
    render();
  });
  const done = element('button', { class: 'btn btn--primary', text: 'Done' });
  done.addEventListener('click', () => dialog.close());
  foot.append(reset, done);

  dialog.append(head, body, foot);
  dialog.showModal();
}

function openHelpDialog(): void {
  const dialog = $('helpDialog') as HTMLDialogElement;
  dialog.replaceChildren();
  const head = element('div', { class: 'dialog__head' });
  head.append(element('span', { class: 'dialog__title', text: 'How this converter behaves' }));
  const close = element('button', { class: 'btn btn--ghost', text: 'Close' });
  close.addEventListener('click', () => dialog.close());
  head.append(close);

  const body = element('div', { class: 'dialog__body stack' });
  const rules: [string, string][] = [
    ['Nothing is uploaded', 'Every conversion runs in this browser. The only exception is the optional DWG helper, which is a program on your own machine.'],
    ['A CRS is never invented', 'If a file declares no coordinate system and the numbers are ambiguous, the conversion stops and asks. The same easting is valid in all 60 UTM zones.'],
    ['Nothing is dropped silently', 'Unsupported CAD entities, lost attributes, dropped Z values and segmentized curves are all counted by name and reported.'],
    ['Curves are segmentized with a stated tolerance', 'An arc has no GIS equivalent. It is densified against a sagitta tolerance you control, never replaced by its chord.'],
    ['LAZ is refused, not guessed', 'No LAZ decoder is bundled, so compressed point data is reported honestly instead of being read as raw LAS coordinates.'],
    ['GeoTIFF is metadata-only', 'Georeference, dimensions and CRS are read; pixels are not decoded, so raster output from a GeoTIFF source is disabled.'],
    ['QA means re-import', 'A green PASS means the output was read back and compared with the source — not merely that bytes were written.'],
    ['Repair is off', 'Geometry repair edits your data, so it stays off until you turn it on, and reports every change it makes.'],
  ];
  for (const [title, text] of rules) body.append(messageBlock('info', title, text));

  const foot = element('div', { class: 'dialog__foot' });
  const done = element('button', { class: 'btn btn--primary', text: 'Close' });
  done.addEventListener('click', () => dialog.close());
  foot.append(done);

  dialog.append(head, body, foot);
  dialog.showModal();
}

async function refreshNative(): Promise<void> {
  const health = await checkNativeHealth();
  store.set({ native: health });
  const nativeBadge = $('nativeBadge');
  nativeBadge.textContent = NATIVE_STATUS_LABEL[health.status];
  nativeBadge.className = `badge badge--${health.status === 'READY' ? 'ok' : health.status === 'NOT_INSTALLED' ? 'muted' : 'warn'}`;
  nativeBadge.title = health.message;
  render();
}

function applyTheme(theme: AppSettings['theme']): void {
  document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
}

function wire(): void {
  const dropzone = $('dropzone');
  const filePicker = $('filePicker') as HTMLInputElement;

  for (const eventName of ['dragenter', 'dragover'] as const) {
    document.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add('dropzone--active');
    });
  }
  document.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) dropzone.classList.remove('dropzone--active');
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dropzone--active');
    if (event.dataTransfer) void filesFromDataTransfer(event.dataTransfer).then(addFiles);
  });

  const browse = () => filePicker.click();
  dropzone.addEventListener('click', browse);
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      browse();
    }
  });
  $('dropBrowseBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    browse();
  });
  $('addFilesBtn').addEventListener('click', browse);
  filePicker.addEventListener('change', async () => {
    const files = await Promise.all(Array.from(filePicker.files ?? []).map((file) => toIngestFile(file)));
    filePicker.value = '';
    await addFiles(files);
  });

  $('clearQueueBtn').addEventListener('click', () => {
    store.set({ items: [], selectedId: null, manifestCsv: undefined });
    store.log('info', 'Queue cleared.');
    render();
  });

  $('convertBtn').addEventListener('click', () => {
    const item = store.selected();
    if (item) void convertItem(item.id, store.get().settings.runQa);
  });
  $('convertQaBtn').addEventListener('click', () => {
    const item = store.selected();
    if (item) void convertItem(item.id, true);
  });
  $('downloadBtn').addEventListener('click', downloadSelected);
  $('batchZipBtn').addEventListener('click', () => void downloadBatchZip());

  $('settingsBtn').addEventListener('click', openSettingsDialog);
  $('helpBtn').addEventListener('click', openHelpDialog);
  $('themeBtn').addEventListener('click', () => {
    const order: AppSettings['theme'][] = ['system', 'dark', 'light'];
    const next = order[(order.indexOf(store.get().settings.theme) + 1) % order.length];
    void store.patchSettings({ theme: next });
    applyTheme(next);
  });

  $('formatSearch').addEventListener('input', (event) => {
    store.set({ formatSearch: (event.target as HTMLInputElement).value });
    renderFormats();
  });

  for (const tab of Array.from(document.querySelectorAll('[data-tab]'))) {
    tab.addEventListener('click', () => {
      const name = (tab as HTMLElement).dataset.tab!;
      store.set({ inspectorTab: name });
      for (const other of Array.from(document.querySelectorAll('[data-tab]'))) {
        other.classList.toggle('tab--on', other === tab);
        other.setAttribute('aria-selected', String(other === tab));
      }
      render();
    });
  }
  for (const tab of Array.from(document.querySelectorAll('[data-bottom]'))) {
    tab.addEventListener('click', () => {
      store.set({ bottomTab: (tab as HTMLElement).dataset.bottom! });
      for (const other of Array.from(document.querySelectorAll('[data-bottom]'))) other.classList.toggle('tab--on', other === tab);
      renderBottom();
    });
  }

  $('fitBtn').addEventListener('click', () => preview?.fit());
  $('gridBtn').addEventListener('click', () => preview?.toggleGrid());

  $('compareFitBtn').addEventListener('click', () => dual?.fit());
  $('compareGridBtn').addEventListener('click', () => dual?.toggleGrid());
  $('compareLinkBtn').addEventListener('click', () => {
    const linked = !store.get().compareLinked;
    store.set({ compareLinked: linked });
    dual?.setLinked(linked);
    // The auto-unlink note is about a state the user has now overridden, so it
    // stops being true the moment they choose for themselves.
    $('compareNote').classList.add('hidden');
    updateLinkButton();
  });

  // The project picker is separate from the file picker: a .ubnx is not a
  // dataset, and routing it through the converter's ingest would have the
  // detector trying to work out what kind of survey a project file is.
  const projectPicker = document.createElement('input');
  projectPicker.type = 'file';
  projectPicker.accept = `.${PROJECT_EXTENSION},application/json`;
  projectPicker.className = 'hidden';
  projectPicker.addEventListener('change', async () => {
    const file = projectPicker.files?.[0];
    projectPicker.value = '';
    if (file) await openProject(file);
  });
  document.body.append(projectPicker);
  openProjectPicker = () => projectPicker.click();

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'o') {
      event.preventDefault();
      browse();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void convertAll(store.get().settings.runQa);
    }
    // Undo and redo, on the keys every application uses. Scoped to the selected
    // file, because two queued surveys are two independent jobs.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      const item = store.selected();
      if (!item?.history) return;
      event.preventDefault();
      stepHistory(item.id, item.history.position + (event.shiftKey ? 1 : -1));
    }
    // Ctrl/Cmd+K, the shortcut every palette uses. Muscle memory is the whole
    // point of matching the convention rather than inventing one.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      palette ??= new CommandPalette($('commandPalette') as HTMLDialogElement, {
        onRun: (command) => void command.run(),
      });
      palette.open(buildCommands());
    }
  });

  // The format registry drives even the drop-zone hint, so it can never drift
  // from what the engines actually support.
  const importable = FORMATS.filter((format) => format.support.import === 'full').length;
  $('dropFormats').textContent = `${importable} formats read directly · Shapefile, DXF, KML/KMZ, GeoJSON, LAS, CSV/PNEZD, LandXML, Surpac STR, ASCII grid and more`;
}

/**
 * Everything the palette can do (spec §31.5).
 *
 * Built fresh on every open rather than once at start-up, because most commands
 * depend on what is selected: "Convert to Shapefile" is meaningless with nothing
 * queued, and a palette that offers it anyway and then fails is worse than one
 * that says why it cannot.
 */
function buildCommands(): Command[] {
  const state = store.get();
  const item = store.selected();
  const commands: Command[] = [];

  commands.push({
    id: 'add-files',
    title: 'Add files',
    group: 'File',
    keywords: ['open', 'import', 'browse', 'drop', 'load'],
    shortcut: 'Ctrl+O',
    // Clicks the same picker the toolbar button does, so the two can never
    // diverge in what "Add files" means.
    run: () => ($('filePicker') as HTMLInputElement).click(),
  });

  commands.push({
    id: 'convert-all',
    title: 'Convert everything in the queue',
    group: 'Convert',
    keywords: ['run', 'export', 'go', 'batch'],
    shortcut: 'Ctrl+Enter',
    enabled: state.items.length > 0,
    disabledReason: 'Nothing is queued yet.',
    run: () => void convertAll(state.settings.runQa),
  });

  // One command per available target, so "kmz" or "shapefile" goes straight
  // there instead of through the format picker.
  const kind = item?.dataset?.kind ?? 'vector';
  for (const format of exportTargetsFor(kind)) {
    if (!isAvailable(format, 'export', state.native.status === 'READY')) continue;
    commands.push({
      id: `target-${format.id}`,
      title: `Convert to ${format.name}`,
      group: 'Convert',
      keywords: [...format.extensions, format.category, format.id],
      detail: item?.profile ? summarisePrediction(predictionFor(format.id)!) : undefined,
      enabled: Boolean(item),
      disabledReason: 'Select a queued file first.',
      run: () => {
        if (item) store.updateItem(item.id, { targetFormatId: format.id });
        else void store.patchSettings({ globalTargetFormatId: format.id });
        render();
      },
    });
  }

  for (const preset of presetsFor(item?.detection?.formatId)) {
    commands.push({
      id: `preset-${preset.id}`,
      title: preset.name,
      group: 'Preset',
      keywords: ['preset', 'workflow', 'template', ...preset.name.toLowerCase().split(/[^a-z]+/)],
      detail: preset.purpose,
      run: () => void applyPreset(preset),
    });
  }

  // --- history, workflows and the project (spec §31.1, §31.2, §31.4)
  const history = historyOf(item);

  commands.push({
    id: 'undo',
    title: canUndo(history) ? `Undo ${nextUndoLabel(history)}` : 'Undo',
    group: 'History',
    keywords: ['undo', 'revert', 'back', 'reverse', 'mistake'],
    shortcut: 'Ctrl+Z',
    enabled: Boolean(item) && canUndo(history),
    disabledReason: item ? 'Nothing has changed this file yet.' : 'Select a queued file first.',
    run: () => item && stepHistory(item.id, history.position - 1),
  });

  commands.push({
    id: 'redo',
    title: canRedo(history) ? `Redo ${nextRedoLabel(history)}` : 'Redo',
    group: 'History',
    keywords: ['redo', 'forward', 'reapply'],
    shortcut: 'Ctrl+Shift+Z',
    enabled: Boolean(item) && canRedo(history),
    disabledReason: item ? 'There is nothing to redo.' : 'Select a queued file first.',
    run: () => item && stepHistory(item.id, history.position + 1),
  });

  commands.push({
    id: 'show-history',
    title: 'Show the operation history',
    group: 'History',
    keywords: ['history', 'operations', 'checkpoint', 'audit', 'what changed'],
    detail: 'Every change to this file, each reversible.',
    run: () => showBottomTab('history'),
  });

  commands.push({
    id: 'record-workflow',
    title: 'Record these settings as a workflow',
    group: 'Workflow',
    keywords: ['workflow', 'record', 'save', 'automate', 'repeat', 'macro'],
    detail: 'Replays this configuration on new data, still asking before anything destructive.',
    run: () => saveWorkflowFromSettings(),
  });

  for (const workflow of state.workflows) {
    commands.push({
      id: `run-workflow-${workflow.id}`,
      title: `Replay “${workflow.name}”`,
      group: 'Workflow',
      keywords: ['workflow', 'replay', 'run', ...workflow.name.toLowerCase().split(/[^a-z]+/)],
      detail: `${workflow.steps.length} steps.`,
      enabled: Boolean(item),
      disabledReason: 'Select a queued file to replay a workflow onto.',
      run: () => void replayWorkflow(workflow),
    });
  }

  commands.push({
    id: 'save-project',
    title: 'Save project',
    group: 'Project',
    keywords: ['project', 'save', 'session', 'ubnx'],
    detail: 'Sources, CRS decisions, settings, edits and workflows — no source bytes, no credentials.',
    enabled: state.items.length > 0,
    disabledReason: 'There is nothing to save yet.',
    run: () => void saveProject(),
  });

  commands.push({
    id: 'open-project',
    title: 'Open project',
    group: 'Project',
    keywords: ['project', 'open', 'load', 'reopen', 'ubnx'],
    run: () => openProjectPicker(),
  });

  commands.push({
    id: 'compare-canvases',
    title: 'Compare source and output side by side',
    group: 'View',
    keywords: ['compare', 'diff', 'dual', 'canvas', 'overlay', 'side by side', 'before after'],
    detail: 'Two canvases with the geometry difference drawn over both.',
    enabled: Boolean(item),
    disabledReason: 'Select a queued file first.',
    run: () => showInspectorTab('compare'),
  });

  commands.push({
    id: 'toggle-link',
    title: state.compareLinked ? 'Unlink the compare panes' : 'Link the compare panes',
    group: 'View',
    keywords: ['link', 'sync', 'pan', 'zoom', 'together', 'independent'],
    run: () => {
      const linked = !store.get().compareLinked;
      store.set({ compareLinked: linked });
      dual?.setLinked(linked);
      updateLinkButton();
    },
  });

  for (const [tab, label] of [
    ['overview', 'Overview'],
    ['geometry', 'Geometry'],
    ['crs', 'CRS'],
    ['attributes', 'Attributes'],
    ['preview', 'Preview'],
    ['fidelity', 'What will be lost'],
    ['compare', 'Compare source and output'],
    ['warnings', 'Warnings'],
  ] as [string, string][]) {
    commands.push({
      id: `tab-${tab}`,
      title: `Show ${label}`,
      group: 'View',
      keywords: ['tab', 'panel', 'inspect', tab],
      enabled: Boolean(item),
      disabledReason: 'Select a queued file first.',
      run: () => showInspectorTab(tab),
    });
  }

  commands.push({
    id: 'settings',
    title: 'Open settings',
    group: 'View',
    keywords: ['preferences', 'options', 'configure'],
    run: () => openSettingsDialog(),
  });
  commands.push({
    id: 'help',
    title: 'Open help',
    group: 'View',
    keywords: ['about', 'docs', 'shortcuts'],
    run: () => openHelpDialog(),
  });
  commands.push({
    id: 'theme',
    title: 'Switch theme',
    group: 'View',
    keywords: ['dark', 'light', 'appearance'],
    run: () => {
      const order: AppSettings['theme'][] = ['system', 'dark', 'light'];
      const next = order[(order.indexOf(store.get().settings.theme) + 1) % order.length];
      void store.patchSettings({ theme: next });
      applyTheme(next);
    },
  });
  commands.push({
    id: 'clear-queue',
    title: 'Clear the queue',
    group: 'File',
    keywords: ['remove', 'reset', 'empty'],
    enabled: state.items.length > 0,
    disabledReason: 'The queue is already empty.',
    run: () => {
      store.set({ items: [], selectedId: null });
      render();
    },
  });

  return commands;
}

/**
 * Applies a preset, saying what it changed.
 *
 * The log line is the point: a preset that silently rewrites eight settings is
 * a trap the next conversion springs. Listing them makes it an informed act.
 */
async function applyPreset(preset: Preset): Promise<void> {
  const before = store.get().settings as unknown as Record<string, unknown>;
  const changes = describePreset(preset, before);
  await store.patchSettings(preset.settings as never);
  store.log(
    'ok',
    changes.length > 0
      ? `Preset "${preset.name}" applied — ${changes.join('; ')}.`
      : `Preset "${preset.name}": every setting was already as it wants them.`
  );
  render();
}

async function boot(): Promise<void> {
  const settings = await loadSettings();
  store.set({ settings });
  applyTheme(settings.theme);
  wire();
  store.subscribe(() => {
    /* views re-render explicitly; the subscription keeps the store honest */
  });
  store.log('info', 'Universal BhuNex Converter ready. All processing is local.');
  render();
  void refreshNative();
}

void boot();
