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
import type { ConversionPhase } from '../core/pipeline';
import type { OutputLayout } from '../core/layout';
import type { DatasetProfile, FidelityPrediction } from '../core/predict';
import type { BurnInMode, BurnInPriority } from '../qa/burn-in';
import type { DiffReport } from '../qa/diff';
import type { GeometryOverlay } from '../qa/geometry-overlay';
import type { ProjectHealth } from '../qa/health';
import type { ConversionReport } from '../core/report';
import type { EditCommand } from '../core/edits';
import type { LayerViewState } from '../core/layers';
import type { HistoryState } from '../core/history';
import type { Workflow } from '../core/workflow';
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
  /**
   * The stage the conversion has reached, while it is running.
   *
   * A stage, not a percentage: the pipeline knows where it is and not how far
   * through a reader it is. See `ConversionPhase` for why an invented
   * percentage is worse than no percentage.
   */
  phase?: ConversionPhase;
  /** The id the pool cancels by. Present only while the job is in flight. */
  jobId?: string;
  warnings: Warning[];
  error?: { code: string; what: string; why: string; action: string };
  outputs?: OutputBlobFile[];
  /** Every path inside the delivery, for the structure preview. */
  tree?: string[];
  /** What the pre-flight said this conversion would cost. */
  prediction?: FidelityPrediction;
  /** Measured source-versus-output differences (spec §30.2). */
  diff?: DiffReport;
  /** The output read back, for the second canvas (spec §30.1). */
  outputDataset?: any;
  /** Where the source and the output differ, drawn over both canvases. */
  overlay?: GeometryOverlay;
  /** Project health, assessed on the source (spec §29.2). */
  health?: ProjectHealth;
  /** The per-file conversion report (spec §22.4). */
  report?: ConversionReport;
  /**
   * Every operation that changed this file's data, each reversible (§31.1).
   *
   * Per item rather than global: two queued surveys are two independent jobs,
   * and an undo that reached across them would reverse work on a file the user
   * is not even looking at.
   */
  history?: HistoryState;
  /**
   * Edits the user made, as intents rather than diffs (spec §25.1/§25.4/§25.5).
   *
   * Replayed onto the FULL dataset at conversion time by `core/edits.ts`. The
   * workspace only holds a 5,000-feature preview per layer, so storing the
   * computed changes here would export an eighth of a 40,000-parcel edit.
   */
  edits?: EditCommand[];
  /**
   * The preview exactly as it was read, before any edit.
   *
   * Undo rebuilds from here by replaying the commands that remain, rather than
   * inverting the one removed: an inverse that drifts from its forward
   * operation is the classic way an undo leaves the data subtly changed.
   */
  pristineDataset?: any;
  /** Per-layer visibility, lock, isolate and opacity — view only, never data. */
  layerView?: LayerViewState;
  /** Sort, filter, search and selection in the attribute table. */
  table?: TableState;
  qa?: FidelityReport;
  provenance?: any;
  durationMs?: number;
}

/** What the attribute table is currently showing. Per item, like the history. */
export interface TableState {
  layer: string | null;
  sortBy?: string;
  sortDirection: 'asc' | 'desc';
  search: string;
  filter: string;
  /** Feature indices the user selected, shared with the canvas. */
  selection: number[];
}

export const EMPTY_TABLE: TableState = { layer: null, sortDirection: 'asc', search: '', filter: '', selection: [] };

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
  /**
   * Trace contours from an elevation raster (spec §16).
   *
   * The interval is 0 until someone sets one, and 0 means "do not contour".
   * There is no interval that is right for every survey — 0.5 m on a building
   * plot and 10 m on a catchment are both correct — so a default would be
   * silently wrong for one of them.
   */
  contourInterval: number;
  /** Every Nth contour is the heavier, labelled one on a plan. */
  contourIndexEvery: number;
  /** Drop contour fragments shorter than this. 0 keeps them all. */
  contourMinLength: number;
  /**
   * Queue id of the file whose polygons clip the raster. Empty means no clip.
   *
   * An id rather than the rings themselves: the boundary file can be edited,
   * reconverted or removed between now and the conversion, and a copy of its
   * geometry taken when the checkbox was ticked would quietly go stale.
   */
  clipBoundaryItemId: string;
  /** Keep pixels only partly inside the boundary. Wider by up to one pixel. */
  clipTouched: boolean;
  /** Shrink the output grid to the boundary's extent. */
  clipCrop: boolean;
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

  /**
   * Layers whose geometry must not be changed by any automated operation.
   *
   * A cadastral or lease boundary is legally operative — moving one is a change
   * to a title, not a data fix. Repair, snap and the vertex editor all refuse
   * a layer named here rather than quietly skipping it (R18).
   */
  protectedLayers: string[];
  /** Snap a dragged vertex to nearby geometry while editing (spec §25.2). */
  editSnapEnabled: boolean;

  /** Attach a per-file conversion report to the delivery (spec §22.4). */
  embedReport: boolean;
  /** Assess project health while converting (spec §29.2). */
  assessHealth: boolean;
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
  contourInterval: 0,
  contourIndexEvery: 5,
  contourMinLength: 0,
  clipBoundaryItemId: '',
  clipTouched: false,
  clipCrop: true,
  burnInEnabled: false,
  burnInTargetLayer: '',
  burnInField: 'label',
  burnInMode: 'attribute',
  burnInPriority: 'nearest-to-centre',
  burnInReplaceSource: false,
  kmlTemplate: 'plain',
  kmlBoreholeLog: false,
  kmlBalloonFooter: '',
  protectedLayers: [],
  // Off by default: snapping moves a vertex somewhere other than where the
  // pointer was released, and that must be asked for rather than assumed.
  editSnapEnabled: false,
  embedReport: false,
  // On by default: it is the one component that costs nothing the user did not
  // already ask for when they enabled QA, and a health score nobody switched on
  // is a health score nobody ever sees.
  assessHealth: true,
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
  /**
   * Saved workflows (§31.2).
   *
   * Held in state rather than only in settings because they travel with the
   * project file, and because a workflow is data the user authored rather than
   * a preference the tool remembers.
   */
  workflows: Workflow[];
  /** Name of the open project, when one has been opened or saved. */
  projectName: string | null;
  /** Panes of the compare view are linked until the user unlinks them. */
  compareLinked: boolean;
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
    workflows: [],
    projectName: null,
    compareLinked: true,
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
