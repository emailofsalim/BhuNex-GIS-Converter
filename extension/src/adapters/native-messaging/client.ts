/**
 * Native messaging adapter.
 *
 * DWG is the one format the extension cannot handle itself, so it is routed to a
 * local helper that drives the user's own ODA File Converter. The adapter's job
 * is to be honest about that: it reports a status the UI can show, and when the
 * helper is absent it fails with an actionable message rather than degrading to
 * something that looks like DWG support (rule R7).
 */

import { warn, type CirDataset, type SourceInfo, type Warning } from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { readDxf } from '../../engines/cad/dxf-read';
import { decodeText } from '../../engines/shared';

export const HOST_NAME = 'com.universal_bhunex_converter.host';

export type NativeStatus = 'READY' | 'NOT_INSTALLED' | 'CONFIGURATION_ERROR' | 'ENGINE_ERROR' | 'TIMEOUT' | 'UNKNOWN';

export interface EngineInfo {
  name: string;
  version: string;
  path: string;
  ready: boolean;
}

export interface NativeHealth {
  status: NativeStatus;
  /** One line the top bar can show verbatim. */
  message: string;
  engine?: EngineInfo;
  hostVersion?: string;
  detail?: Record<string, unknown>;
}

interface HostResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; what: string; why: string; action: string };
  engine?: EngineInfo;
}

function hasNativeMessaging(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendNativeMessage);
}

/**
 * `nativeMessaging` is an OPTIONAL permission, and that is a deliberate choice.
 *
 * The extension is published on the Chrome Web Store and Edge Add-ons. Asking
 * every user to grant "communicate with cooperating native applications" at
 * install time — when only the ones converting DWG will ever use it — is both a
 * worse install prompt and a slower review. So it is requested at the moment
 * DWG is first used, by the one user in twenty who needs it.
 *
 * Everything else in the tool works without it, and must keep working: the
 * refusal path below returns a normal, actionable error rather than breaking
 * the conversion queue.
 */
export async function hasNativePermission(): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return hasNativeMessaging();
  try {
    return await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
  } catch {
    return false;
  }
}

/**
 * Asks for the native-messaging permission.
 *
 * MUST be called from a user gesture — Chrome refuses the prompt otherwise —
 * which is why it is invoked from the DWG button rather than from the pipeline.
 */
export async function requestNativePermission(): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return hasNativeMessaging();
  try {
    return await chrome.permissions.request({ permissions: ['nativeMessaging'] });
  } catch {
    return false;
  }
}

/**
 * One request/response exchange with the helper.
 *
 * `sendNativeMessage` starts the host, delivers one message and closes the pipe,
 * which suits a whole-file conversion and avoids leaving a process running
 * between jobs.
 */
function send(op: string, payload: Record<string, unknown> = {}, timeoutMs = 300000): Promise<HostResponse> {
  if (!hasNativeMessaging()) {
    return Promise.reject(
      new ConversionError({
        code: 'NATIVE_UNAVAILABLE',
        what: 'The native helper cannot be reached from this context.',
        why: 'chrome.runtime.sendNativeMessage is not available — this code is running outside an extension page, or the nativeMessaging permission is missing.',
        action: 'Open the converter workspace from the extension toolbar and try again.',
      })
    );
  }

  return new Promise((resolve, reject) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;

    // A helper that hangs (an ODA dialog waiting for input, say) would otherwise
    // leave the conversion pending for ever.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new ConversionError({
          code: 'NATIVE_TIMEOUT',
          what: `The native helper did not respond within ${Math.round(timeoutMs / 1000)} seconds.`,
          why: 'The helper or ODA File Converter may be waiting on a dialog, or the drawing may be very large.',
          action: 'Open ODA File Converter once to clear any prompt, or convert the drawing to DXF there and import the DXF.',
        })
      );
    }, timeoutMs);

    chrome.runtime.sendNativeMessage(HOST_NAME, { id, op, payload }, (response: HostResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        // Chrome reports a missing manifest and a crashed host through the same
        // channel, so the message text is the only way to tell them apart.
        const text = lastError.message ?? 'unknown native messaging error';
        const missing = /not found|no such native|Specified native messaging host not found/i.test(text);
        reject(
          new ConversionError({
            code: missing ? 'NATIVE_NOT_INSTALLED' : 'NATIVE_HOST_ERROR',
            what: missing ? 'The native helper is not installed for this extension.' : 'The native helper failed to run.',
            why: missing
              ? `Chrome could not find a native messaging host named "${HOST_NAME}" registered for this extension id.`
              : text,
            action: missing
              ? 'Run native-host/install.py with this extension id (see docs/NATIVE_HOST.md), then restart the browser.'
              : 'Check that Python 3 is installed and that native-host/universal_bhunex_host.py is executable.',
          })
        );
        return;
      }
      if (!response) {
        reject(
          new ConversionError({
            code: 'NATIVE_NO_RESPONSE',
            what: 'The native helper returned no response.',
            why: 'The host process exited without writing a message, which usually means it crashed on start-up.',
            action: 'Run `python3 native-host/universal_bhunex_host.py` in a terminal to see the start-up error.',
          })
        );
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Asks the helper for its status. Never throws: the UI needs a status to display
 * in every case, including "not installed", which is a normal state rather than
 * an error.
 */
export async function checkNativeHealth(): Promise<NativeHealth> {
  if (!hasNativeMessaging()) {
    return { status: 'UNKNOWN', message: 'Native messaging is not available in this context.' };
  }
  // Not granted is a normal state, not a failure: the permission is optional and
  // most users never convert a DWG. Probing without it would make Chrome log a
  // permission error on every start-up of an extension working exactly as
  // intended.
  if (!(await hasNativePermission())) {
    return {
      status: 'NOT_INSTALLED',
      message: 'DWG support is off. Convert a DWG to grant the helper permission; every other format works without it.',
    };
  }
  try {
    const response = await send('health', {}, 10000);
    if (!response.ok) {
      return {
        status: 'CONFIGURATION_ERROR',
        message: response.error ? `${response.error.what} ${response.error.action}` : 'The helper reported an error.',
        engine: response.engine,
      };
    }
    const engine = response.engine;
    const ready = engine?.ready === true;
    return {
      status: ready ? 'READY' : 'NOT_INSTALLED',
      message: ready
        ? `${engine!.name} ${engine!.version} ready`
        : 'Helper installed, but ODA File Converter was not found. Set its path in native-host/host-config.json.',
      engine,
      hostVersion: response.result?.hostVersion as string | undefined,
      detail: response.result,
    };
  } catch (error) {
    if (error instanceof ConversionError) {
      return {
        status: error.code === 'NATIVE_NOT_INSTALLED' ? 'NOT_INSTALLED' : error.code === 'NATIVE_TIMEOUT' ? 'TIMEOUT' : 'ENGINE_ERROR',
        message: `${error.what} ${error.action}`,
      };
    }
    return { status: 'ENGINE_ERROR', message: error instanceof Error ? error.message : String(error) };
  }
}

function toBase64(bytes: Uint8Array): string {
  // Chunked so a large drawing does not blow the argument limit of
  // String.fromCharCode with a spread.
  const chunkSize = 0x8000;
  let binary = '';
  for (let at = 0; at < bytes.length; at += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface DwgConversionResult {
  dxfBytes: Uint8Array;
  engine: EngineInfo;
  outputName: string;
  warnings: Warning[];
}

/** Converts DWG bytes to DXF through the helper. */
export async function convertDwgToDxf(bytes: Uint8Array, fileName: string): Promise<DwgConversionResult> {
  const response = await send('convert', {
    sourceName: fileName,
    sourceBase64: toBase64(bytes),
  });

  if (!response.ok || !response.result) {
    const error = response.error;
    throw new ConversionError({
      code: error?.code ?? 'NATIVE_CONVERSION_FAILED',
      what: error?.what ?? 'The DWG conversion failed in the native helper.',
      why: error?.why ?? 'The helper returned no detail.',
      action: error?.action ?? 'Open the drawing in ODA File Converter to see the failure directly.',
    });
  }

  const engine = response.engine ?? { name: 'ODA File Converter', version: 'unknown', path: '', ready: true };
  return {
    dxfBytes: fromBase64(String(response.result.dxfBase64)),
    engine,
    outputName: String(response.result.fileName ?? fileName.replace(/\.dwg$/i, '.dxf')),
    warnings: [
      warn(
        'DWG_VIA_NATIVE_ENGINE',
        `DWG was converted to DXF by ${engine.name}${engine.version !== 'unknown' ? ` ${engine.version}` : ''} on this machine.`,
        {
          severity: 'info',
          reason: 'DWG is a proprietary binary format with no bundled reader, so the conversion runs through your own installed converter.',
          action: `Output version: ${String(response.result.outputVersion ?? 'ACAD2018')}. Change it in native-host/host-config.json if the recipient needs another.`,
        }
      ),
    ],
  };
}

/** Reads a DWG into the CIR by way of the helper's DXF output. */
export async function readDwg(bytes: Uint8Array, source: SourceInfo, arcTolerance?: number): Promise<CirDataset> {
  const converted = await convertDwgToDxf(bytes, source.fileName);
  const dataset = readDxf(decodeText(converted.dxfBytes), source, { arcTolerance });
  dataset.warnings.push(...converted.warnings);
  dataset.metadata = {
    ...dataset.metadata,
    nativeEngine: `${converted.engine.name} ${converted.engine.version}`,
    nativeEnginePath: converted.engine.path,
    intermediateFormat: 'DXF',
  };
  return dataset;
}

export const NATIVE_STATUS_LABEL: Record<NativeStatus, string> = {
  READY: 'Native engine: ready',
  NOT_INSTALLED: 'Native engine: not installed',
  CONFIGURATION_ERROR: 'Native engine: configuration error',
  ENGINE_ERROR: 'Native engine: error',
  TIMEOUT: 'Native engine: timed out',
  UNKNOWN: 'Native engine: unknown',
};
