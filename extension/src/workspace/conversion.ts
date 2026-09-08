/**
 * Getting files in, and converted files out.
 *
 * This is the driver, not a panel: drop handling, inspection, archive
 * expansion, the settings snapshot each run takes, the conversion call itself
 * and the four ways a result leaves the tool.
 *
 * The one rule that shapes it: a conversion RE-READS the source file in the
 * worker. The workspace holds a 5,000-feature preview, so nothing computed on
 * screen is ever written — edits travel as commands (`core/edits.ts`) and are
 * re-planned against the whole file. See `buildSettings`.
 */

import {
  checkNativeHealth,
  hasNativePermission,
  requestNativePermission,
} from '../adapters/native-messaging/client';
import { groupCompanions, type IngestFile } from '../core/companions';
import { ConversionError } from '../core/errors';
import { type ConversionSettings, packageBatch } from '../core/pipeline';
import { fixedPrecision, FULL_PRECISION } from '../core/precision';
import { getFormat } from '../core/registry';
import { crsFromEpsg } from '../crs/epsg';
import { nextId, type QueueItem, rememberCrs, rememberFormat, store } from '../state/store';
import { configurePool, expand, inspect, preflight, runConversion } from '../workers/client';
import { element, formatBytes } from './dom';
import { host } from './host';
import { protectedFor } from './panels/dataset';

/** Reads a File into the shape the grouper and the pipeline expect. */
export async function toIngestFile(file: File, path?: string): Promise<IngestFile> {
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
export async function readEntry(entry: FileSystemEntry, prefix: string, into: IngestFile[]): Promise<void> {
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

export async function filesFromDataTransfer(transfer: DataTransfer): Promise<IngestFile[]> {
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
export async function addFiles(files: IngestFile[], containers?: string[]): Promise<void> {
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
  host.render();
}

export async function inspectItem(id: string): Promise<void> {
  const item = store.get().items.find((candidate) => candidate.id === id);
  if (!item) return;
  store.updateItem(id, { status: 'inspecting' });
  host.render();

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
  host.render();
}

export async function expandArchiveItem(id: string): Promise<void> {
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

export function buildSettings(): Partial<ConversionSettings> {
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
    embedReport: settings.embedReport,
    assessHealth: settings.assessHealth,
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

export async function convertItem(id: string, withQa: boolean): Promise<void> {
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
    host.render();
    return;
  }

  // DWG is the one format that needs a permission, and it is optional so a
  // store install never demands it. Asked for here — inside the click that
  // started the conversion — because Chrome only shows the prompt on a user
  // gesture. Refusing it fails this one file with a reason and leaves the rest
  // of the queue untouched.
  if ((item.forcedFormatId ?? item.detection?.formatId) === 'dwg' && !(await hasNativePermission())) {
    const granted = await requestNativePermission();
    if (!granted) {
      store.updateItem(id, {
        status: 'failed',
        error: {
          code: 'NATIVE_PERMISSION_DENIED',
          what: 'DWG conversion needs permission to talk to the local helper.',
          why: 'The permission was not granted. It is optional, so the extension does not hold it until a DWG is actually converted.',
          action: 'Convert this file again and accept the prompt, or export the drawing to DXF in your CAD software — DXF needs no helper.',
        },
      });
      store.log('warn', `${item.fileName}: DWG helper permission declined; nothing was converted.`);
      host.render();
      return;
    }
    // Re-probe now the permission exists, so the top bar stops saying DWG is off.
    void checkNativeHealth().then((native) => {
      store.set({ native });
      host.render();
    });
  }

  // The job id is chosen HERE rather than inside the client, so the row's
  // Cancel button works from the first frame instead of waiting for a promise
  // that by definition has not resolved.
  const jobId = `convert-${id}-${Date.now()}`;
  store.updateItem(id, { status: 'converting', error: undefined, jobId, phase: 'detecting' });
  host.render();
  const startedAt = performance.now();

  try {
    // `edits` is what carries the attribute table, the layer manager and the
    // vertex editor into the output. They are descriptions, re-planned against
    // the full file in the worker — the workspace only ever held a preview, so
    // sending the changes it computed would edit a fraction of a large layer.
    const settings = {
      ...buildSettings(),
      runQa: withQa && store.get().settings.runQa,
      edits: item.edits,
      protectedLayers: protectedFor(item),
    };
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
      item.forcedFormatId,
      {
        jobId,
        onProgress: ({ phase }) => {
          store.updateItem(id, { phase: phase as never });
          host.renderQueue();
        },
      }
    );
    const durationMs = Math.round(performance.now() - startedAt);
    const outputBytes = result.outputs.reduce((sum, output) => sum + output.bytes.length, 0);

    store.updateItem(id, {
      status: 'done',
      jobId: undefined,
      phase: undefined,
      outputs: result.outputs,
      tree: result.tree,
      prediction: result.prediction,
      diff: result.diff,
      outputDataset: result.outputDataset,
      overlay: result.overlay,
      health: result.health,
      report: result.report,
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
    if (structured.code === 'JOB_CANCELLED') {
      // Cancelling is not a failure. Marking it failed would put a red badge on
      // a row for doing exactly what the user asked, and would make the file
      // look damaged when nothing touched it.
      store.updateItem(id, { status: 'ready', jobId: undefined, phase: undefined, error: undefined });
    } else {
      store.updateItem(id, { status: 'failed', jobId: undefined, phase: undefined, error: structured as QueueItem['error'] });
      store.log('error', `${item.fileName}: ${structured.what} ${structured.why} ${structured.action}`);
    }
  }
  host.render();
}

export async function convertAll(withQa: boolean): Promise<void> {
  const pending = store.get().items.filter((item) => item.status === 'ready' || item.status === 'failed' || item.status === 'done');
  if (pending.length === 0) return;
  store.set({ busy: true, progress: 0 });

  // Error isolation: one failed file never aborts the batch (instruction §12.1).
  //
  // The pool is sized from the setting BEFORE the batch starts. Until the pool
  // existed this loop started N conversions that all queued behind one worker,
  // so the setting described a parallelism the tool did not have.
  let completed = 0;
  const concurrency = Math.max(1, store.get().settings.parallelJobs);
  configurePool(concurrency);
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
  host.render();
}

export function downloadBytes(bytes: Uint8Array, name: string, mimeType: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = element('a', { href: url, download: name });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some Chrome versions.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function downloadSelected(): void {
  const item = store.selected();
  if (!item?.outputs?.length) return;
  for (const output of item.outputs) downloadBytes(output.bytes, output.name, output.mimeType);
  store.log('ok', `Downloaded ${item.outputs.length} file(s) for ${item.fileName}.`);
}

export async function downloadBatchZip(): Promise<void> {
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
  host.render();
}

// --------------------------------------------------------------------- render
