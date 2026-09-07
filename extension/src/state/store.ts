/**
 * Workspace state and persisted settings.
 *
 * A tiny observable store rather than a framework: the workspace has one state
 * tree and a handful of views, and a subscribe/notify pair is the whole
 * requirement. Settings persist through chrome.storage.local, with an in-memory
 * fallback so the same code runs in tests and in a plain page.
 */

import type { DetectionResult } from '../core/detect';
import type { CrsRef, Warning } from '../core/cir';
import type { FidelityReport } from '../qa/fidelity';
import type { NamingPattern } from '../core/naming';
import type { OutputLayout } from '../core/layout';
import type { DatasetProfile, FidelityPrediction } from '../core/predict';
import type { BurnInMode, BurnInPriority } from '../qa/burn-in';
import type { DiffReport } from '../qa/diff';
import type { KmlTemplate } from '../engines/vector/kml-templates';
import type { NativeHealth } from '../adapters/native-messaging/client';
import type { OutputBlobFile } from '../workers/client';

export type QueueStatus = 'queued' | 'inspecting' | 'ready' | 'converting' | 'done' | 'failed' | 'blocked';

export interface QueueItem {
  id: string;
  fileName: string;
  path: string;
  /** Archive nesting chain, when this file came out of a ZIP. */
  containers?: string[];
  size: number;
  bytes: Uint8Array;
  companions?: Map<string, Uint8Array>;
  siblingExtensions?: string[];
  /** Companion extensions the format requires but that were not supplied. */
  missingCompanions: string[];
  detection?: DetectionResult;
  /** Set when the user overrides detection. */
  forcedFormatId?: string;
  dataset?: any;
  /**
   * One-pass summary of the dataset, computed where the full CIR lives.
   *
   * The UI only ever receives a truncated preview of the features, so a
   * prediction made from `dataset` would report counts that are quietly wrong.
   * This carries the exact ones.
   */
  profile?: DatasetProfile;
  targetFormatId?: string;
  status: QueueStatus;
  warnings: Warning[];
  error?: { code: string; what: string; why: string; action: string };
  outputs?: OutputBlobFile[];
  /** Every path inside the delivery, for the structure preview. */
  tree?: string[];
  /** What the pre-flight said this conversion would cost. */
  prediction?: FidelityPrediction;
  /** Measured source-versus-output differences (spec §30.2). */
  diff?: DiffReport;
  qa?: FidelityReport;
  provenance?: any;
  durationMs?: number;
}

export interface AppSettings {
  theme: 'system' | 'dark' | 'light';
  /** Applied to every queued file unless one overrides it. */
  globalTargetFormatId: string | null;
  preserveZ: boolean;
  preserveAttributes: boolean;
  precisionMode: 'full' | 'fixed';
  precisionDecimals: number;
  runQa: boolean;
  arcTolerance: number;
  naming: NamingPattern;
  embedMetadata: boolean;
  /** Repair defaults are off: survey data is evidence, not a draft. */
  repairCloseRings: boolean;
  repairRemoveDuplicateVertices: boolean;
  repairNormalizeOrientation: boolean;
  repairDeduplicateFeatures: boolean;
  snapTolerance: number;
  sourceCrsEpsg: number | null;
  targetCrsEpsg: number | null;
  recentCrs: number[];
  favouriteFormats: string[];
  recentFormats: string[];
  parallelJobs: number;
  maxArchiveMb: number;
  decimationMode: 'none' | 'nth' | 'grid' | 'voxel';
  decimationFactor: number;
  decimationCell: number;
  /** How the delivery is shaped: one file, one per layer, or mirroring the input. */
  outputLayout: OutputLayout;
  /** Place each batch result under the folder its source came from. */
  mirrorBatchTree: boolean;

  // --- Cadastral tools (spec §27). Both off by default: each changes geometry
  // or attributes, so neither may happen because a checkbox was already ticked.
  /** Assemble CAD line work into polygons before writing. */
  polygonizeEnabled: boolean;
  /** Largest boundary gap that may be closed, in dataset units. */
  polygonizeTolerance: number;
  /** Keep the source line work beside the polygons it produced. */
  polygonizeKeepLines: boolean;
  /** Attach text found inside polygons to those polygons. */
  burnInEnabled: boolean;
  /** Layer holding the polygons that receive the text. */
  burnInTargetLayer: string;
  /** Field the burnt-in value is written to. */
  burnInField: string;
  burnInMode: BurnInMode;
  burnInPriority: BurnInPriority;
  /** Delete the source text after burning it in. Never implied (R17). */
  burnInReplaceSource: boolean;

  /** Which balloon a KML/KMZ description uses (spec §28.5). */
  kmlTemplate: KmlTemplate;
  /** Render boreholes as core-log balloons rather than attribute tables. */
  kmlBoreholeLog: boolean;
  /** Footer line on every balloon, e.g. a survey date. */
  kmlBalloonFooter: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  globalTargetFormatId: null,
  preserveZ: true,
  preserveAttributes: true,
  precisionMode: 'fixed',
  precisionDecimals: 3,
  runQa: true,
  arcTolerance: 0.01,
  naming: 'converted-to',
  embedMetadata: false,
  repairCloseRings: false,
  repairRemoveDuplicateVertices: false,
  repairNormalizeOrientation: false,
  repairDeduplicateFeatures: false,
  snapTolerance: 0,
  sourceCrsEpsg: null,
  targetCrsEpsg: null,
  recentCrs: [],
  favouriteFormats: [],
  recentFormats: [],
  parallelJobs: Math.min(4, navigator.hardwareConcurrency || 4),
  maxArchiveMb: 1024,
  decimationMode: 'none',
  decimationFactor: 10,
  decimationCell: 1,
  // 'single' by default so the obvious case stays obvious: one file in, one out.
  outputLayout: 'single',
  mirrorBatchTree: true,
  polygonizeEnabled: false,
  polygonizeTolerance: 0.01,
  polygonizeKeepLines: false,
  burnInEnabled: false,
  burnInTargetLayer: '',
  burnInField: 'label',
  burnInMode: 'attribute',
  burnInPriority: 'nearest-to-centre',
  burnInReplaceSource: false,
  kmlTemplate: 'plain',
  kmlBoreholeLog: false,
  kmlBalloonFooter: '',
};

export interface LogEntry {
  at: number;
  level: 'info' | 'ok' | 'warn' | 'error';
  message: string;
}

export interface AppState {
  items: QueueItem[];
  selectedId: string | null;
  settings: AppSettings;
  native: NativeHealth;
  log: LogEntry[];
  inspectorTab: string;
  bottomTab: string;
  formatSearch: string;
  formatCategory: string | null;
  busy: boolean;
  progress: number;
  perf: string;
  batchZip?: { name: string; bytes: Uint8Array };
  manifestCsv?: string;
}

type Listener = (state: AppState) => void;

const STORAGE_KEY = 'ugc.settings.v1';

class Store {
  private state: AppState = {
    items: [],
    selectedId: null,
    settings: { ...DEFAULT_SETTINGS },
    native: { status: 'UNKNOWN', message: 'Checking…' },
    log: [],
    inspectorTab: 'overview',
    bottomTab: 'qa',
    formatSearch: '',
    formatCategory: null,
    busy: false,
    progress: 0,
    perf: '',
  };

  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  updateItem(id: string, patch: Partial<QueueItem>): void {
    this.set({ items: this.state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  }

  addItems(items: QueueItem[]): void {
    this.set({ items: [...this.state.items, ...items], selectedId: this.state.selectedId ?? items[0]?.id ?? null });
  }

  removeItem(id: string): void {
    const items = this.state.items.filter((item) => item.id !== id);
    this.set({ items, selectedId: this.state.selectedId === id ? (items[0]?.id ?? null) : this.state.selectedId });
  }

  selected(): QueueItem | undefined {
    return this.state.items.find((item) => item.id === this.state.selectedId);
  }

  log(level: LogEntry['level'], message: string): void {
    // The log is a rolling buffer: a 500-file batch would otherwise grow it
    // without bound while the user watches.
    const log = [...this.state.log, { at: Date.now(), level, message }].slice(-500);
    this.set({ log });
  }

  async patchSettings(patch: Partial<AppSettings>): Promise<void> {
    const settings = { ...this.state.settings, ...patch };
    this.set({ settings });
    await saveSettings(settings);
  }
}

export const store = new Store();

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

export async function loadSettings(): Promise<AppSettings> {
  if (!hasChromeStorage()) return { ...DEFAULT_SETTINGS };
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const saved = stored?.[STORAGE_KEY];
    // Merge over the defaults so a settings file written by an older version
    // gains new keys instead of leaving them undefined.
    return saved && typeof saved === 'object' ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  } catch {
    // Storage can be unavailable (quota, private mode). Settings still apply for
    // this session; failing the conversion over a preference would be worse.
  }
}

/** Records a CRS in the recent list, newest first, capped at eight. */
export function rememberCrs(settings: AppSettings, crs: CrsRef | null): number[] {
  if (!crs?.epsg) return settings.recentCrs;
  const epsg = Number(crs.epsg);
  return [epsg, ...settings.recentCrs.filter((code) => code !== epsg)].slice(0, 8);
}

export function rememberFormat(settings: AppSettings, formatId: string): string[] {
  return [formatId, ...settings.recentFormats.filter((id) => id !== formatId)].slice(0, 8);
}

let counter = 0;
export function nextId(): string {
  return `item-${Date.now().toString(36)}-${++counter}`;
}
