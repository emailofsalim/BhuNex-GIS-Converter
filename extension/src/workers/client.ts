/**
 * Worker client.
 *
 * Runs conversions off the UI thread. DWG is the exception: native messaging is
 * only reachable from an extension page, so those jobs run on the main thread —
 * which is fine, because the actual work happens in a separate native process.
 *
 * The worker is created lazily and reused, so a batch of 200 files does not pay
 * 200 start-up costs.
 */

import type { ConversionSettings } from '../core/pipeline';
import { convert, expandArchive, readSource } from '../core/pipeline';
import { detectFormat, type DetectionResult } from '../core/detect';
import { profileDataset, type DatasetProfile, type FidelityPrediction } from '../core/predict';
import { ConversionError } from '../core/errors';
import type { TransferableFile, WorkerRequest, WorkerResponse } from './convert.worker';

/** Files under this size are converted inline; a worker hop would cost more. */
export const WORKER_THRESHOLD_BYTES = 2 * 1024 * 1024;

export interface QueuedFile {
  fileName: string;
  bytes: Uint8Array;
  mimeType?: string;
  companions?: Map<string, Uint8Array>;
  siblingExtensions?: string[];
  /** Path as presented, so the output can mirror the folder it came from. */
  path?: string;
  /** Archive nesting chain for a file found inside a ZIP. */
  containers?: string[];
}

export interface OutputBlobFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ConvertPayload {
  detection: DetectionResult;
  dataset: any;
  outputs: OutputBlobFile[];
  /** Every path inside the delivery, before packaging — the structure preview. */
  tree: string[];
  /** What the pre-flight said this conversion would cost. */
  prediction: FidelityPrediction;
  warnings: any[];
  qa: any;
  provenance: any;
}

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: unknown) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./convert.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(response.payload);
    else entry.reject(new ConversionError({ ...response.error }));
  });
  worker.addEventListener('error', (event) => {
    // A worker-level failure orphans every in-flight job, so they all have to be
    // rejected rather than left pending for ever.
    const error = new ConversionError({
      code: 'WORKER_CRASHED',
      what: 'The conversion worker stopped unexpectedly.',
      why: event.message || 'The worker terminated without a message.',
      action: 'Reload the workspace and try the file again; if it repeats, the file may be far larger than available memory.',
    });
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
}

export function releaseWorker(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}

function toTransferable(file: QueuedFile): { file: TransferableFile; transfer: ArrayBuffer[] } {
  // The bytes are copied before transfer because the caller keeps the queue
  // entry: transferring the original would detach it and break a re-convert.
  const buffer = file.bytes.slice().buffer;
  const companions = file.companions
    ? [...file.companions.entries()].map(([extension, bytes]) => ({ extension, buffer: bytes.slice().buffer }))
    : undefined;
  return {
    file: {
      fileName: file.fileName,
      buffer,
      mimeType: file.mimeType,
      companions,
      siblingExtensions: file.siblingExtensions,
      path: file.path,
      containers: file.containers,
    },
    transfer: [buffer, ...(companions?.map((companion) => companion.buffer) ?? [])],
  };
}

function request<T>(build: (id: string) => { message: WorkerRequest; transfer: ArrayBuffer[] }): Promise<T> {
  const id = `job-${++sequence}`;
  const { message, transfer } = build(id);
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage(message, transfer);
  });
}

function toInput(file: QueuedFile) {
  return {
    fileName: file.fileName,
    bytes: file.bytes,
    mimeType: file.mimeType,
    companions: file.companions,
    siblingExtensions: file.siblingExtensions,
    path: file.path,
    containers: file.containers,
  };
}

/** Detection is cheap and reads only the head of the file, so it stays inline. */
export function detect(file: QueuedFile): DetectionResult {
  return detectFormat({
    fileName: file.fileName,
    bytes: file.bytes,
    mimeType: file.mimeType,
    siblings: file.siblingExtensions,
  });
}

export async function inspect(
  file: QueuedFile,
  forcedFormatId?: string
): Promise<{ detection: DetectionResult; dataset: any; profile: DatasetProfile }> {
  if (file.bytes.length < WORKER_THRESHOLD_BYTES) {
    const detection = forcedFormatId
      ? { formatId: forcedFormatId, formatName: forcedFormatId, confidence: 1, evidence: [], alternatives: [], requiresConfirmation: false }
      : detect(file);
    // Small files are read in full: the pixel statistics and histogram the
    // inspector shows are worth the milliseconds at this size.
    const dataset = await readSource(toInput(file), detection, { preserveZ: true } as ConversionSettings);
    return { detection, dataset, profile: profileDataset(dataset) };
  }
  return request(( id) => {
    const { file: transferable, transfer } = toTransferable(file);
    return { message: { id, op: 'inspect', file: transferable, forcedFormatId }, transfer };
  });
}

export async function runConversion(
  file: QueuedFile,
  targetFormatId: string,
  settings?: Partial<ConversionSettings>,
  forcedFormatId?: string
): Promise<ConvertPayload> {
  const detection = forcedFormatId ? null : detect(file);
  const isDwg = (forcedFormatId ?? detection?.formatId) === 'dwg';

  // DWG has to stay on the main thread: chrome.runtime.sendNativeMessage is not
  // exposed to workers. The heavy lifting is in the native process anyway.
  if (isDwg || file.bytes.length < WORKER_THRESHOLD_BYTES) {
    const result = await convert({ input: toInput(file), targetFormatId, settings, forcedSourceFormatId: forcedFormatId });
    return {
      detection: result.detection,
      dataset: result.sourceDataset,
      outputs: result.outputs.map((output) => ({ name: output.name, mimeType: output.mimeType, bytes: output.bytes })),
      tree: result.tree,
      prediction: result.prediction,
      warnings: result.warnings,
      qa: result.qa,
      provenance: result.provenance,
    };
  }

  const payload = await request<{
    detection: DetectionResult;
    dataset: any;
    outputs: { name: string; mimeType: string; buffer: ArrayBuffer }[];
    tree: string[];
    prediction: FidelityPrediction;
    warnings: any[];
    qa: any;
    provenance: any;
  }>((id) => {
    const { file: transferable, transfer } = toTransferable(file);
    return { message: { id, op: 'convert', file: transferable, targetFormatId, settings, forcedFormatId }, transfer };
  });

  return {
    ...payload,
    outputs: payload.outputs.map((output) => ({ name: output.name, mimeType: output.mimeType, bytes: new Uint8Array(output.buffer) })),
  };
}

export async function expand(file: QueuedFile): Promise<QueuedFile[]> {
  if (file.bytes.length < WORKER_THRESHOLD_BYTES) {
    const expanded = await expandArchive(toInput(file));
    return expanded.map((entry) => ({
      fileName: entry.fileName,
      bytes: entry.bytes,
      siblingExtensions: entry.siblingExtensions,
      path: entry.path,
      containers: entry.containers,
    }));
  }
  const files = await request<
    { fileName: string; buffer: ArrayBuffer; siblingExtensions?: string[]; path?: string; containers?: string[] }[]
  >((id) => {
    const { file: transferable, transfer } = toTransferable(file);
    return { message: { id, op: 'expand', file: transferable }, transfer };
  });
  return files.map((entry) => ({
    fileName: entry.fileName,
    bytes: new Uint8Array(entry.buffer),
    siblingExtensions: entry.siblingExtensions,
    path: entry.path,
    containers: entry.containers,
  }));
}

/**
 * Rough pre-flight memory estimate (instruction §14.3).
 *
 * The expansion factors are engine-shaped rather than exact: a DXF becomes a
 * token stream plus a CIR, a LAS becomes typed arrays roughly 1.6× its record
 * size. The purpose is to refuse a job that will certainly fail, with a message
 * that says what to do instead — not to predict peak usage precisely.
 */
export function estimatePeakBytes(sizeBytes: number, formatId: string): number {
  const factors: Record<string, number> = {
    dxf: 8,
    geojson: 6,
    topojson: 6,
    kml: 7,
    gml: 8,
    osm: 9,
    xlsx: 6,
    csv: 5,
    las: 2,
    laz: 6,
    shapefile: 4,
    asciigrid: 6,
  };
  return sizeBytes * (factors[formatId] ?? 5);
}

export function memoryBudgetBytes(): number {
  // navigator.deviceMemory is coarse (rounded to a power of two, capped at 8) and
  // absent outside Chromium, so half of 4 GB is the conservative fallback.
  const deviceMemoryGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  return deviceMemoryGb * 1024 * 1024 * 1024 * 0.5;
}

export function preflight(sizeBytes: number, formatId: string): { ok: boolean; estimateBytes: number; message?: string } {
  const estimate = estimatePeakBytes(sizeBytes, formatId);
  const budget = memoryBudgetBytes();
  if (estimate <= budget) return { ok: true, estimateBytes: estimate };
  return {
    ok: false,
    estimateBytes: estimate,
    message:
      `This dataset is too large for in-browser processing (estimated ${(estimate / 1024 / 1024 / 1024).toFixed(1)} GB peak against a ` +
      `${(budget / 1024 / 1024 / 1024).toFixed(1)} GB budget). Use the optional local engine, or reduce the dataset first with a crop, ` +
      `filter or decimation setting.`,
  };
}
