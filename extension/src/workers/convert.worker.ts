/**
 * Conversion worker.
 *
 * Parsing and writing happen here so the UI thread stays responsive on a
 * 200 MB point cloud (rule R9). The worker owns the whole pipeline rather than
 * just the parse step, because the expensive parts — segmentizing a DXF,
 * writing a shapefile, running the QA re-import — are spread across all of it.
 *
 * Payloads move as transferable ArrayBuffers, so a large file is handed over
 * rather than cloned.
 */

import { convert, expandArchive, readSource, type ConversionInput, type ConversionPhase, type ConversionSettings } from '../core/pipeline';
import { profileDataset } from '../core/predict';
import { detectFormat } from '../core/detect';
import { ConversionError } from '../core/errors';
import { summarise } from './summarise';

export type WorkerRequest =
  | { id: string; op: 'detect'; file: TransferableFile }
  | { id: string; op: 'inspect'; file: TransferableFile; forcedFormatId?: string }
  | { id: string; op: 'convert'; file: TransferableFile; targetFormatId: string; settings?: Partial<ConversionSettings>; forcedFormatId?: string }
  | { id: string; op: 'expand'; file: TransferableFile };

export interface TransferableFile {
  fileName: string;
  buffer: ArrayBuffer;
  mimeType?: string;
  companions?: { extension: string; buffer: ArrayBuffer }[];
  siblingExtensions?: string[];
  /** Path as presented, so mirror-source layout works off the main thread too. */
  path?: string;
  containers?: string[];
}

export type WorkerResponse =
  | { id: string; ok: true; op: string; payload: unknown; transfer?: ArrayBuffer[] }
  | { id: string; ok: false; op: string; error: { code: string; what: string; why: string; action: string } }
  /**
   * A stage boundary, not a percentage.
   *
   * Sent while the job is still running, so the pool must not treat it as a
   * completion — see `WorkerPool`, which keeps the slot occupied on this kind.
   */
  | { id: string; kind: 'progress'; progress: { phase: ConversionPhase; detail?: string } };

function toInput(file: TransferableFile): ConversionInput {
  return {
    fileName: file.fileName,
    bytes: new Uint8Array(file.buffer),
    mimeType: file.mimeType,
    companions: file.companions
      ? new Map(file.companions.map((companion) => [companion.extension, new Uint8Array(companion.buffer)]))
      : undefined,
    siblingExtensions: file.siblingExtensions,
    path: file.path,
    containers: file.containers,
  };
}

/**
 * Strips a dataset down to what the inspector and preview actually render.
 *
 * A full CIR of a 40-million-point cloud cannot cross the worker boundary, and
 * the UI does not need it: the preview is explicitly a preview, and the export
 * re-reads the source in the worker.
 */
function errorPayload(error: unknown) {
  if (error instanceof ConversionError) return error.toJSON();
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'WORKER_UNEXPECTED',
    what: 'The conversion stopped with an unexpected engine error.',
    why: message,
    action: 'Check the file in the inspector; if it looks correct, please report this with the message above.',
  };
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const post = (response: WorkerResponse, transfer: Transferable[] = []) => {
    (self as unknown as Worker).postMessage(response, transfer);
  };

  try {
    switch (request.op) {
      case 'detect': {
        const input = toInput(request.file);
        const detection = detectFormat({
          fileName: input.fileName,
          bytes: input.bytes,
          mimeType: input.mimeType,
          siblings: input.siblingExtensions,
        });
        post({ id: request.id, ok: true, op: request.op, payload: detection });
        break;
      }
      case 'inspect': {
        const input = toInput(request.file);
        const detection = request.forcedFormatId
          ? { formatId: request.forcedFormatId, formatName: request.forcedFormatId, confidence: 1, evidence: [], alternatives: [], requiresConfirmation: false }
          : detectFormat({ fileName: input.fileName, bytes: input.bytes, mimeType: input.mimeType, siblings: input.siblingExtensions });
        // Anything routed to the worker is above the inline threshold, so the
        // inspector reads structure only: decoding a large raster's pixels here
        // would be thrown away and paid for again by the conversion itself.
        const dataset = await readSource(input, detection, { preserveZ: true, metadataOnly: true } as ConversionSettings);
        const summary = summarise(dataset);
        // The profile is computed here, where the whole dataset is, so the UI can
        // predict fidelity against exact counts rather than the truncated
        // preview it receives.
        const profile = profileDataset(dataset);
        const transfer: ArrayBuffer[] = [];
        if (summary.pointcloud) {
          transfer.push(summary.pointcloud.previewX.buffer, summary.pointcloud.previewY.buffer, summary.pointcloud.previewZ.buffer);
        }
        post({ id: request.id, ok: true, op: request.op, payload: { detection, dataset: summary, profile } }, transfer);
        break;
      }
      case 'convert': {
        const result = await convert({
          input: toInput(request.file),
          targetFormatId: request.targetFormatId,
          settings: request.settings,
          forcedSourceFormatId: request.forcedFormatId,
          onPhase: (phase) => post({ id: request.id, kind: 'progress', progress: { phase } }),
        });
        const outputs = result.outputs.map((output) => ({ name: output.name, mimeType: output.mimeType, buffer: output.bytes.buffer as ArrayBuffer }));
        post(
          {
            id: request.id,
            ok: true,
            op: request.op,
            payload: {
              detection: result.detection,
              dataset: summarise(result.sourceDataset, 2000),
              outputs,
              tree: result.tree,
              prediction: result.prediction,
              diff: result.diff,
              // The output as it was read back, summarised the same way the
              // source is, so the second canvas draws the geometry the QA
              // verdict describes rather than a separate reading of the file.
              outputDataset: result.outputDataset ? summarise(result.outputDataset, 2000) : undefined,
              overlay: result.overlay,
              health: result.health,
              report: result.report,
              warnings: result.warnings,
              qa: result.qa,
              provenance: result.provenance,
            },
          },
          outputs.map((output) => output.buffer)
        );
        break;
      }
      case 'expand': {
        const expanded = await expandArchive(toInput(request.file));
        const files = expanded.map((entry) => ({
          fileName: entry.fileName,
          buffer: entry.bytes.buffer as ArrayBuffer,
          siblingExtensions: entry.siblingExtensions,
          path: entry.path,
          containers: entry.containers,
        }));
        post({ id: request.id, ok: true, op: request.op, payload: files }, files.map((file) => file.buffer));
        break;
      }
      default:
        post({ id: (request as { id: string }).id, ok: false, op: 'unknown', error: errorPayload(new Error('Unknown worker operation')) });
        break;
    }
  } catch (error) {
    post({ id: request.id, ok: false, op: request.op, error: errorPayload(error) });
  }
});
