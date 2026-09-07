/**
 * Operation history (spec §31.1, rule R19).
 *
 * `qa/repair.ts` already returns an `UndoRecord` that reverses one repair. This
 * is the layer above: an ordered history of EVERY operation that changed the
 * data — import, CRS assignment, repair, polygonisation, burn-in, reprojection,
 * a vertex edit — each reversible, with checkpoints to return to.
 *
 * Rule R19 says edits are reversible. One repair's undo does not satisfy that:
 * a user who polygonises, burns text in, then repairs, and discovers the
 * polygonisation tolerance was wrong, needs to get back to before the
 * polygonisation — not to before the repair. That means a stack, and it means
 * every operation contributes to it, not just the ones that happen to have
 * written an undo record.
 *
 * ---------------------------------------------------------------------------
 * HOW A CHANGE IS STORED, AND WHY IT IS NOT A SNAPSHOT
 *
 * Snapshotting the dataset per operation is the obvious design and the wrong
 * one: ten operations on a 400,000-feature layer is ten copies of it. Instead
 * each entry holds a PATCH — only what actually differs — computed by
 * `diffDatasets` below.
 *
 * The patch is computed with a reference-equality fast path first. Every engine
 * in this project rewrites immutably and returns the *same object* for a
 * feature it did not touch (`repair.ts` returns `feature`, not `{...feature}`),
 * so an operation that changes three features out of 400,000 costs 400,000
 * pointer comparisons and three stored features. When an engine does rebuild
 * every object, the fallback is a structural comparison — one walk over the
 * data, the same order of cost as the operation itself, and still only the
 * genuinely-changed features are kept.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not merge or coalesce adjacent entries. A history that quietly folds
 * "close rings" and "remove duplicate vertices" into one "repair" step is a
 * history that cannot undo one of them, and the whole reason for the stack is
 * that the user's regret is usually about a specific step.
 */

import type { CirDataset, CirFeature, CirLayer, CrsRef } from './cir';

/**
 * What kind of operation an entry records.
 *
 * These are the operations spec §31.1 enumerates. `edit` covers the vertex and
 * attribute editing of §25, which is why it is here before that editor exists:
 * the history contract is what the editor will be built against.
 */
export type OperationKind =
  | 'import'
  | 'crs-assign'
  | 'reproject'
  | 'repair'
  | 'polygonize'
  | 'burn-in'
  | 'snap'
  | 'simplify'
  | 'decimate'
  | 'edit'
  | 'export';

export const OPERATION_LABEL: Record<OperationKind, string> = {
  import: 'Import',
  'crs-assign': 'Assign CRS',
  reproject: 'Reproject',
  repair: 'Repair',
  polygonize: 'Build polygons',
  'burn-in': 'Attach text to polygons',
  snap: 'Snap',
  simplify: 'Simplify',
  decimate: 'Decimate',
  edit: 'Edit',
  export: 'Export',
};

/** One feature's state before and after, addressed by its position. */
export interface FeaturePatch {
  layer: string;
  index: number;
  before: CirFeature | null;
  after: CirFeature | null;
}

/** One layer's presence, for operations that add or remove whole layers. */
export interface LayerPatch {
  name: string;
  index: number;
  before: CirLayer | null;
  after: CirLayer | null;
}

/** Dataset-level scalars an operation may change. */
export interface DatasetPatch {
  crs?: { before: CrsRef | null; after: CrsRef | null };
  crsOrigin?: { before: CirDataset['crsOrigin']; after: CirDataset['crsOrigin'] };
  units?: { before: string | null; after: string | null };
  name?: { before: string; after: string };
}

export interface ChangeSet {
  features: FeaturePatch[];
  layers: LayerPatch[];
  dataset: DatasetPatch;
}

export interface HistoryEntry {
  id: string;
  kind: OperationKind;
  /** What the user asked for, in their words: "Close rings, tolerance 0.01". */
  label: string;
  at: number;
  /** The reversible change. Empty for an operation that changed nothing. */
  change: ChangeSet;
  /**
   * How many features the operation touched.
   *
   * Held separately from `change.features.length` because an operation that
   * only changed dataset-level values still touched something worth reporting.
   */
  touched: number;
  /** Largest distance any coordinate moved, when the operation moved geometry. */
  maxDisplacement?: number;
  /** Settings the operation ran with, so a workflow can replay it exactly. */
  settings?: Record<string, unknown>;
  /** True for a named point the user can return to. */
  checkpoint?: string;
}

export interface HistoryOptions {
  /**
   * How many entries to keep.
   *
   * A bound is necessary — the patches are small but not free — and the moment
   * one is exceeded the user is TOLD, because an undo stack that silently
   * stops going back far enough is worse than one that admits its limit.
   */
  limit: number;
}

export const DEFAULT_HISTORY_OPTIONS: HistoryOptions = { limit: 200 };

export interface HistoryState {
  entries: HistoryEntry[];
  /**
   * How many entries are currently applied.
   *
   * Undo decrements, redo increments. Entries beyond it are still held so redo
   * works, and are discarded the moment a new operation is recorded — the
   * standard branch-discard, because keeping both branches means asking the
   * user which future they meant.
   */
  position: number;
  /** Entries dropped off the front because `limit` was reached. */
  dropped: number;
}

export function createHistory(): HistoryState {
  return { entries: [], position: 0, dropped: 0 };
}

let sequence = 0;
function nextEntryId(): string {
  return `op-${Date.now().toString(36)}-${++sequence}`;
}

/**
 * Computes the reversible change between two versions of a dataset.
 *
 * Features are addressed by (layer name, index), which is the same addressing
 * `qa/repair.ts` uses for its undo records — so an operation that already
 * produced one can be recorded here without a second walk if it wants to.
 */
export function diffDatasets(before: CirDataset, after: CirDataset): ChangeSet {
  const features: FeaturePatch[] = [];
  const layers: LayerPatch[] = [];
  const dataset: DatasetPatch = {};

  if (before.crs !== after.crs && !sameCrs(before.crs, after.crs)) {
    dataset.crs = { before: before.crs, after: after.crs };
  }
  if (before.crsOrigin !== after.crsOrigin) {
    dataset.crsOrigin = { before: before.crsOrigin, after: after.crsOrigin };
  }
  if (before.units !== after.units) dataset.units = { before: before.units, after: after.units };
  if (before.name !== after.name) dataset.name = { before: before.name, after: after.name };

  const beforeLayers = new Map(before.layers.map((layer, index) => [layer.name, { layer, index }]));
  const afterLayers = new Map(after.layers.map((layer, index) => [layer.name, { layer, index }]));

  for (const [name, entry] of beforeLayers) {
    const match = afterLayers.get(name);
    if (!match) {
      layers.push({ name, index: entry.index, before: entry.layer, after: null });
      continue;
    }
    // Reference equality first: the common case is an operation that touched
    // one layer and returned the others untouched.
    if (entry.layer === match.layer) continue;
    features.push(...diffLayer(name, entry.layer, match.layer));
  }

  for (const [name, entry] of afterLayers) {
    if (!beforeLayers.has(name)) layers.push({ name, index: entry.index, before: null, after: entry.layer });
  }

  return { features, layers, dataset };
}

function diffLayer(name: string, before: CirLayer, after: CirLayer): FeaturePatch[] {
  const patches: FeaturePatch[] = [];
  const length = Math.max(before.features.length, after.features.length);

  for (let index = 0; index < length; index++) {
    const left = before.features[index] ?? null;
    const right = after.features[index] ?? null;
    if (left === right) continue;
    if (left && right && sameFeature(left, right)) continue;
    patches.push({ layer: name, index, before: left, after: right });
  }

  return patches;
}

function sameCrs(left: CrsRef | null, right: CrsRef | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.epsg === right.epsg && left.name === right.name && left.kind === right.kind;
}

/**
 * Structural feature comparison.
 *
 * Only reached when the references differ, so this runs on the features an
 * operation rebuilt — never on the ones it left alone.
 */
function sameFeature(left: CirFeature, right: CirFeature): boolean {
  if (left.id !== right.id) return false;
  if (left.sourceLayer !== right.sourceLayer) return false;
  if (!sameGeometry(left.geometry, right.geometry)) return false;
  return sameProperties(left.properties, right.properties);
}

function sameGeometry(left: CirFeature['geometry'], right: CirFeature['geometry']): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.type !== right.type || left.dimension !== right.dimension) return false;
  if (left.type === 'GeometryCollection') {
    const a = left.geometries ?? [];
    const b = right.geometries ?? [];
    return a.length === b.length && a.every((child, index) => sameGeometry(child, b[index]));
  }
  return sameCoordinates(left.coordinates, right.coordinates);
}

function sameCoordinates(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!sameCoordinates(left[index], right[index])) return false;
    }
    return true;
  }
  // Object.is rather than ===, so a NaN that survived a round trip compares
  // equal to itself instead of registering as a change on every operation.
  return Object.is(left, right);
}

function sameProperties(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}

export interface RecordOptions {
  kind: OperationKind;
  label: string;
  settings?: Record<string, unknown>;
  maxDisplacement?: number;
  checkpoint?: string;
}

/**
 * Records an operation, returning the new history.
 *
 * The history is immutable in the same way the rest of the state is: the caller
 * replaces its reference. That is what lets the UI diff it cheaply.
 *
 * Recording DISCARDS any redo branch. Once new work is done on top of an undo,
 * the undone future cannot be reached without asking the user which of two
 * histories they meant, and a tool that asks that question has already lost.
 */
export function recordOperation(
  history: HistoryState,
  before: CirDataset,
  after: CirDataset,
  options: RecordOptions,
  settings: HistoryOptions = DEFAULT_HISTORY_OPTIONS
): HistoryState {
  const change = diffDatasets(before, after);
  const entry: HistoryEntry = {
    id: nextEntryId(),
    kind: options.kind,
    label: options.label,
    at: Date.now(),
    change,
    touched: change.features.length + change.layers.length,
    maxDisplacement: options.maxDisplacement,
    settings: options.settings,
    checkpoint: options.checkpoint,
  };

  const kept = history.entries.slice(0, history.position);
  kept.push(entry);

  let dropped = history.dropped;
  while (kept.length > settings.limit) {
    kept.shift();
    dropped++;
  }

  return { entries: kept, position: kept.length, dropped };
}

/** Marks the entry at the top of the history as a named checkpoint. */
export function markCheckpoint(history: HistoryState, name: string): HistoryState {
  if (history.position === 0) return history;
  const entries = history.entries.slice();
  entries[history.position - 1] = { ...entries[history.position - 1], checkpoint: name };
  return { ...history, entries };
}

export function canUndo(history: HistoryState): boolean {
  return history.position > 0;
}

export function canRedo(history: HistoryState): boolean {
  return history.position < history.entries.length;
}

/** What undoing next would reverse, for the button's label. */
export function nextUndoLabel(history: HistoryState): string | null {
  return canUndo(history) ? history.entries[history.position - 1].label : null;
}

export function nextRedoLabel(history: HistoryState): string | null {
  return canRedo(history) ? history.entries[history.position].label : null;
}

export interface HistoryStep {
  history: HistoryState;
  dataset: CirDataset;
  /** The entry that was reversed or reapplied, null when there was nothing to do. */
  entry: HistoryEntry | null;
}

/** Reverses the most recent operation. */
export function undo(history: HistoryState, dataset: CirDataset): HistoryStep {
  if (!canUndo(history)) return { history, dataset, entry: null };
  const entry = history.entries[history.position - 1];
  return {
    history: { ...history, position: history.position - 1 },
    dataset: applyChange(dataset, entry.change, 'before'),
    entry,
  };
}

/** Reapplies the operation that undo reversed. */
export function redo(history: HistoryState, dataset: CirDataset): HistoryStep {
  if (!canRedo(history)) return { history, dataset, entry: null };
  const entry = history.entries[history.position];
  return {
    history: { ...history, position: history.position + 1 },
    dataset: applyChange(dataset, entry.change, 'after'),
    entry,
  };
}

/**
 * Returns to a point in the history, undoing or redoing as far as needed.
 *
 * `position` is a count of applied entries, so 0 is the state as imported.
 * Reverting to a checkpoint is this with the checkpoint's index looked up.
 */
export function revertTo(history: HistoryState, dataset: CirDataset, position: number): HistoryStep {
  const target = Math.max(0, Math.min(position, history.entries.length));
  let state: HistoryStep = { history, dataset, entry: null };
  let last: HistoryEntry | null = null;

  while (state.history.position > target) {
    state = undo(state.history, state.dataset);
    last = state.entry ?? last;
  }
  while (state.history.position < target) {
    state = redo(state.history, state.dataset);
    last = state.entry ?? last;
  }

  return { ...state, entry: last };
}

/** Finds a named checkpoint's position, or null when there is no such name. */
export function checkpointPosition(history: HistoryState, name: string): number | null {
  const index = history.entries.findIndex((entry) => entry.checkpoint === name);
  return index < 0 ? null : index + 1;
}

/**
 * Applies one side of a change set to a dataset.
 *
 * `'before'` reverses the operation, `'after'` reapplies it — the same code
 * both ways, which is what makes undo and redo provably symmetric rather than
 * two implementations that agree until they do not.
 */
export function applyChange(dataset: CirDataset, change: ChangeSet, side: 'before' | 'after'): CirDataset {
  const other = side === 'before' ? 'after' : 'before';
  let next: CirDataset = { ...dataset };

  if (change.dataset.crs) next.crs = change.dataset.crs[side];
  if (change.dataset.crsOrigin) next.crsOrigin = change.dataset.crsOrigin[side];
  if (change.dataset.units) next.units = change.dataset.units[side];
  if (change.dataset.name) next.name = change.dataset.name[side];

  // Feature patches first, on the layers that exist in both states; layer
  // additions and removals are handled after, so a patch never lands on a
  // layer this side of the change does not have.
  const byLayer = new Map<string, FeaturePatch[]>();
  for (const patch of change.features) {
    const list = byLayer.get(patch.layer) ?? [];
    list.push(patch);
    byLayer.set(patch.layer, list);
  }

  if (byLayer.size > 0) {
    next.layers = next.layers.map((layer) => {
      const patches = byLayer.get(layer.name);
      if (!patches) return layer;
      const features = layer.features.slice();

      // Removals first, highest index down, so removing one does not shift the
      // index of another still to be removed. Then the replacements and
      // appends, lowest index up, so a run of appends lands in order instead of
      // all piling onto the first free slot.
      //
      // Positional addressing means an insertion in the middle is recorded as a
      // cascade of replacements plus one append rather than as a single insert.
      // That is more patches than strictly necessary and exactly reversible,
      // which is the trade worth making: the alternative needs stable feature
      // identity, and the formats this tool reads do not all provide one.
      const removals = patches.filter((patch) => patch[side] === null).sort((left, right) => right.index - left.index);
      const sets = patches.filter((patch) => patch[side] !== null).sort((left, right) => left.index - right.index);

      for (const patch of removals) features.splice(patch.index, 1);
      for (const patch of sets) {
        const wanted = patch[side]!;
        if (patch.index < features.length) features[patch.index] = wanted;
        else features.push(wanted);
      }

      return { ...layer, features };
    });
  }

  for (const patch of change.layers) {
    const wanted = patch[side];
    const present = patch[other];
    if (wanted === null && present !== null) {
      next.layers = next.layers.filter((layer) => layer.name !== patch.name);
    } else if (wanted !== null) {
      const at = next.layers.findIndex((layer) => layer.name === patch.name);
      if (at >= 0) {
        const layers = next.layers.slice();
        layers[at] = wanted;
        next.layers = layers;
      } else {
        const layers = next.layers.slice();
        layers.splice(Math.min(patch.index, layers.length), 0, wanted);
        next.layers = layers;
      }
    }
  }

  return next;
}

/**
 * A one-line account of an entry, for the history panel.
 *
 * The displacement is included when there is one because that is the number a
 * surveyor judges an edit by: "moved 2 vertices" says nothing, "moved 2
 * vertices, at most 0.004" says whether it mattered.
 */
export function describeEntry(entry: HistoryEntry): string {
  const parts = [entry.label];
  if (entry.touched > 0) parts.push(`${entry.touched.toLocaleString()} changed`);
  if (entry.maxDisplacement !== undefined && entry.maxDisplacement > 0) {
    parts.push(`moved at most ${entry.maxDisplacement.toPrecision(3)}`);
  }
  if (entry.touched === 0 && Object.keys(entry.change.dataset).length === 0) parts.push('no change');
  return parts.join(' · ');
}

/**
 * The history as plain data for the project file.
 *
 * The patches go with it: reopening a project and finding the undo stack empty
 * would mean the edits are no longer reversible, which is R19 broken by a save.
 */
export interface HistorySnapshot {
  entries: HistoryEntry[];
  position: number;
  dropped: number;
}

export function snapshotHistory(history: HistoryState): HistorySnapshot {
  return { entries: history.entries, position: history.position, dropped: history.dropped };
}

export function restoreHistory(snapshot: HistorySnapshot | undefined): HistoryState {
  if (!snapshot || !Array.isArray(snapshot.entries)) return createHistory();
  const position = Math.max(0, Math.min(snapshot.position ?? snapshot.entries.length, snapshot.entries.length));
  return { entries: snapshot.entries, position, dropped: snapshot.dropped ?? 0 };
}
