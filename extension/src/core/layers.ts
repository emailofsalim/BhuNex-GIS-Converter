/**
 * The layer manager (spec §25.4).
 *
 * Search, visibility, lock, isolate, opacity, reorder, rename, merge, split,
 * export-selected and style-selected, over the CIR's own hierarchy: CAD layer
 * names for CAD, GIS layer names for GIS, KML folders as folders (R16).
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF STATE, KEPT APART ON PURPOSE
 *
 * Half the operations on this list change what you SEE and half change what you
 * HAVE, and the single worst bug a layer manager can have is confusing them:
 *
 *   VIEW      visibility, lock, isolate, opacity, colour, list order
 *             → `LayerViewState`. Never touches the dataset. Hiding a layer
 *               does not remove it from an export, and the UI must say so,
 *               because "I hid it so it won't be delivered" is the assumption
 *               everyone brings from desktop GIS — where it is often true.
 *
 *   DATA      rename, merge, split, reorder-in-dataset, delete
 *             → `LayerPlan`, the same plan → apply → undo contract as
 *               `qa/repair.ts`, `core/vertex-edit.ts` and `core/attributes.ts`.
 *
 * `selectionForExport()` is the one bridge between them, and it takes an
 * explicit selection rather than reading visibility, so an export subset is
 * always something the user chose rather than something the view happened to
 * be showing.
 *
 * ---------------------------------------------------------------------------
 * MERGE LOSES THINGS, AND SAYS WHICH
 *
 * Merging layers unions their schemas — a feature from a layer without field
 * `owner` gets null for it, never "" — and it flattens their hierarchy, which
 * R16 exists to preserve. Both are reported in the plan before it is applied,
 * not discovered in the output tree afterwards.
 */

import type { CirDataset, CirFeature, CirLayer, FieldDef, StyleHint } from './cir';
import { collectGeometryTypes } from './cir';

// =========================================================================
// View state
// =========================================================================

/**
 * How a layer's outline is drawn.
 *
 * A line type is a drawing convention with meaning attached: on a survey sheet
 * a dashed line is a boundary under dispute or a service below ground, and a
 * dash-dot is a centreline. Offering them is not decoration — it is how the
 * exported legend ends up saying something.
 */
export type LineType = 'solid' | 'dashed' | 'dotted' | 'dash-dot';

export const LINE_TYPES: LineType[] = ['solid', 'dashed', 'dotted', 'dash-dot'];

export const LINE_TYPE_LABEL: Record<LineType, string> = {
  solid: 'Solid',
  dashed: 'Dashed',
  dotted: 'Dotted',
  'dash-dot': 'Dash-dot',
};

/**
 * Dash patterns in SCREEN PIXELS, not ground units.
 *
 * A pattern in ground units would vanish when zoomed out and become one long
 * stroke when zoomed in, which is exactly what a line type must not do: its
 * whole job is to stay recognisable at any scale.
 */
const DASH_PATTERNS: Record<LineType, number[]> = {
  solid: [],
  dashed: [8, 5],
  dotted: [1.5, 4],
  'dash-dot': [10, 4, 2, 4],
};

export function dashPattern(type: LineType): number[] {
  return DASH_PATTERNS[type] ?? [];
}

/** Line widths a user may choose, in screen pixels. */
export const MIN_LINE_WIDTH = 0.5;
export const MAX_LINE_WIDTH = 8;
export const DEFAULT_LINE_WIDTH = 1.2;

export interface LayerViewEntry {
  hidden?: boolean;
  /** A locked layer refuses every editing operation, including bulk ones. */
  locked?: boolean;
  /** 0..1. Absent means fully opaque. */
  opacity?: number;
  /** Overrides the layer's own style in the preview only. */
  colour?: string;
  /** Stroke width in SCREEN pixels. Absent means the renderer's default. */
  lineWidth?: number;
  /** Absent means solid. */
  lineType?: LineType;
}

export interface LayerViewState {
  entries: Record<string, LayerViewEntry>;
  /** When set, only this layer is drawn — isolate, without losing what was hidden. */
  isolated: string | null;
}

export const EMPTY_VIEW: LayerViewState = { entries: {}, isolated: null };

function entryOf(view: LayerViewState, layer: string): LayerViewEntry {
  return view.entries[layer] ?? {};
}

/**
 * Whether a layer is drawn.
 *
 * Isolate wins over hidden, and does NOT clear it: leaving isolate restores
 * exactly the visibility that was there before, which is the whole point of
 * having isolate as well as hide.
 */
export function isVisible(view: LayerViewState, layer: string): boolean {
  if (view.isolated !== null) return view.isolated === layer;
  return entryOf(view, layer).hidden !== true;
}

export function isLocked(view: LayerViewState, layer: string): boolean {
  return entryOf(view, layer).locked === true;
}

export function opacityOf(view: LayerViewState, layer: string): number {
  const value = entryOf(view, layer).opacity;
  return value === undefined ? 1 : Math.max(0, Math.min(1, value));
}

/**
 * The stroke width for a layer, clamped to something drawable.
 *
 * Clamped rather than trusted: a width of 0 draws nothing at all, and a project
 * file carrying a width of 400 from a hand-edited JSON would paint the canvas a
 * solid colour. Neither reads as a settings problem when it happens.
 */
export function lineWidthOf(view: LayerViewState, layer: string, fallback = DEFAULT_LINE_WIDTH): number {
  const value = entryOf(view, layer).lineWidth;
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_LINE_WIDTH, Math.min(MAX_LINE_WIDTH, value));
}

export function lineTypeOf(view: LayerViewState, layer: string): LineType {
  const value = entryOf(view, layer).lineType;
  return value !== undefined && LINE_TYPES.includes(value) ? value : 'solid';
}

/** The colour override for a layer, or null to keep the palette's own. */
export function colourOf(view: LayerViewState, layer: string): string | null {
  const value = entryOf(view, layer).colour;
  // A colour has to be one the canvas will accept; a bad string silently makes
  // `strokeStyle` keep its PREVIOUS value, so the layer takes on the colour of
  // whichever layer was drawn before it.
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

export function setView(view: LayerViewState, layer: string, patch: LayerViewEntry): LayerViewState {
  return { ...view, entries: { ...view.entries, [layer]: { ...entryOf(view, layer), ...patch } } };
}

/** Isolating the already-isolated layer clears the isolation — one toggle. */
export function toggleIsolate(view: LayerViewState, layer: string): LayerViewState {
  return { ...view, isolated: view.isolated === layer ? null : layer };
}

export function setAllHidden(view: LayerViewState, layers: string[], hidden: boolean): LayerViewState {
  const entries = { ...view.entries };
  for (const layer of layers) entries[layer] = { ...entryOf(view, layer), hidden };
  return { ...view, entries, isolated: null };
}

/**
 * The layers a locked-aware edit may touch.
 *
 * This is what connects the padlock in the list to the refusals in
 * `core/attributes.ts` and `core/vertex-edit.ts`: both take a `protectedLayers`
 * list, and a locked layer belongs on it.
 */
export function lockedLayers(view: LayerViewState): string[] {
  return Object.entries(view.entries)
    .filter(([, entry]) => entry.locked)
    .map(([name]) => name);
}

// =========================================================================
// The list
// =========================================================================

export interface LayerListItem {
  name: string;
  path: string[];
  /** Nesting depth, so the list can be indented as the source folders were. */
  depth: number;
  featureCount: number;
  fieldCount: number;
  geometryTypes: string[];
  visible: boolean;
  locked: boolean;
  opacity: number;
  colour?: string;
  style?: StyleHint;
  /** Index into `dataset.layers` — the identity every operation uses. */
  index: number;
}

/**
 * Builds the list, filtered by a search term.
 *
 * The search matches the layer name AND its folder path, because in a KML with
 * forty folders "the one under Boreholes" is how people describe a layer.
 * Original order is preserved: the list order is the dataset order, and
 * reordering the list is a data operation with a plan (see `planReorder`).
 */
export function listLayers(dataset: CirDataset, view: LayerViewState = EMPTY_VIEW, search = ''): LayerListItem[] {
  const needle = search.trim().toLowerCase();

  return dataset.layers
    .map((layer, index) => ({
      name: layer.name,
      path: layer.path,
      depth: Math.max(0, layer.path.length - 1),
      featureCount: layer.features.length,
      fieldCount: layer.fields.length,
      geometryTypes: layer.geometryTypes,
      visible: isVisible(view, layer.name),
      locked: isLocked(view, layer.name),
      opacity: opacityOf(view, layer.name),
      colour: entryOf(view, layer.name).colour,
      style: layer.style,
      index,
    }))
    .filter((item) => needle === '' || item.path.join('/').toLowerCase().includes(needle));
}

export interface LayerTreeNode {
  /** Folder name, or the layer's own name at a leaf. */
  name: string;
  path: string[];
  /** Absent on a folder that holds no layer of its own. */
  layer?: LayerListItem;
  children: LayerTreeNode[];
}

/**
 * Rebuilds the source hierarchy as a tree.
 *
 * DXF and shapefile layers are flat and come back as a flat list; KML folders
 * nest and come back nested. The renderer does not need to know which.
 */
export function layerTree(items: LayerListItem[]): LayerTreeNode[] {
  const roots: LayerTreeNode[] = [];
  const byPath = new Map<string, LayerTreeNode>();

  for (const item of items) {
    let parent: LayerTreeNode[] = roots;

    for (let depth = 0; depth < item.path.length; depth++) {
      const segments = item.path.slice(0, depth + 1);
      // NUL as the separator: it is the one character a layer or folder
      // name cannot contain, so ['A', 'B/C'] and ['A/B', 'C'] stay distinct.
      const key = segments.join('\u0000');
      let node = byPath.get(key);

      if (!node) {
        node = { name: segments[depth], path: segments, children: [] };
        byPath.set(key, node);
        parent.push(node);
      }

      if (depth === item.path.length - 1) node.layer = item;
      parent = node.children;
    }
  }

  return roots;
}

// =========================================================================
// Data operations
// =========================================================================

export type LayerOperation = 'rename' | 'merge' | 'split' | 'reorder' | 'delete' | 'style';

export const LAYER_LABEL: Record<LayerOperation, string> = {
  rename: 'Rename layer',
  merge: 'Merge layers',
  split: 'Split layer',
  reorder: 'Reorder layers',
  delete: 'Delete layer',
  style: 'Style layer',
};

export type SplitBy = { kind: 'field'; field: string } | { kind: 'geometry' };

export interface LayerPlan {
  operation: LayerOperation;
  /** The layers the operation reads or replaces. */
  subjects: string[];
  /** The layers the dataset would have afterwards, in order. */
  result: { name: string; path: string[]; featureCount: number }[];
  notes: string[];
  refusal?: { what: string; why: string; action: string };
  /**
   * The operation's own parameters.
   *
   * `applyLayers` reads these rather than inferring the intent by diffing
   * `result` against the dataset — a rename to a name that already appears
   * elsewhere in the list, or a merge whose output name matches a source, would
   * both defeat that inference and produce a different dataset from the one the
   * plan described and the user approved.
   */
  target?: string;
  style?: StyleHint;
  splitBy?: SplitBy;
  toIndex?: number;
  /** Set by `applyLayers`; `undoLayers` needs nothing else. */
  before?: CirLayer[];
}

/**
 * A plan that has been applied, and can therefore be undone.
 *
 * A separate type rather than an optional field, so that handing `undoLayers`
 * the plan you already had — instead of the one `applyLayers` handed back — is
 * a compile error. The alternative is an undo that silently does nothing, which
 * is the worst possible behaviour for an undo: the user sees the button work
 * and the data stay wrong.
 */
export interface AppliedLayerPlan extends LayerPlan {
  before: CirLayer[];
}

export interface LayerOptions {
  /**
   * Layers no edit may touch, from `lockedLayers(view)`.
   *
   * Named to match `core/attributes.ts` and `core/vertex-edit.ts`: the padlock
   * in the layer list and the "legally operative" marker are one list, and
   * giving it two names is how one of them ends up not being checked.
   */
  protectedLayers: string[];
}

function refuse(operation: LayerOperation, subjects: string[], what: string, why: string, action: string): LayerPlan {
  return { operation, subjects, result: [], notes: [], refusal: { what, why, action } };
}

function lockRefusal(operation: LayerOperation, subjects: string[], locked: string[]): LayerPlan {
  return refuse(
    operation,
    subjects,
    `${locked.join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked.`,
    'A locked layer is one someone deliberately took out of reach, usually because it is the received survey rather than the working copy.',
    'Unlock it in the layer list if you intend to change it.'
  );
}

function summarise(layers: CirLayer[]): LayerPlan['result'] {
  return layers.map((layer) => ({ name: layer.name, path: layer.path, featureCount: layer.features.length }));
}

/** Renames a layer, keeping its place in the hierarchy. */
export function planRenameLayer(
  dataset: CirDataset,
  from: string,
  to: string,
  options: Partial<LayerOptions> = {}
): LayerPlan {
  const locked = options.protectedLayers ?? [];
  if (locked.includes(from)) return lockRefusal('rename', [from], [from]);

  const layer = dataset.layers.find((candidate) => candidate.name === from);
  if (!layer) return refuse('rename', [from], 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');
  if (to.trim() === '') return refuse('rename', [from], 'A layer needs a name.', 'The new name is empty.', 'Type a name.');
  if (dataset.layers.some((candidate) => candidate.name === to)) {
    return refuse(
      'rename',
      [from],
      `A layer called "${to}" already exists.`,
      'Two layers with one name collide in every output format — one silently overwrites the other in a shapefile folder or a DXF.',
      'Choose a different name, or merge the two layers deliberately.'
    );
  }

  const renamed = dataset.layers.map((candidate) => (candidate.name === from ? renameLayer(candidate, to) : candidate));
  const notes: string[] = [];
  // DXF layer names have their own constraints; worth saying before export.
  if (/[<>/\\":;?*|=`,]/.test(to)) {
    notes.push(`"${to}" contains a character DXF does not allow in a layer name; it will be substituted on export.`);
  }

  return { operation: 'rename', subjects: [from], target: to, result: summarise(renamed), notes };
}

function renameLayer(layer: CirLayer, to: string): CirLayer {
  return {
    ...layer,
    name: to,
    // The last path segment IS the name, so the hierarchy stays consistent.
    path: [...layer.path.slice(0, -1), to],
  };
}

/**
 * Merges layers into one.
 *
 * Field union, hierarchy flattened to the shallowest common ancestor, and both
 * facts stated. Geometry types are not required to match: a CAD layer holding
 * lines and points is ordinary, and refusing it would be refusing the source.
 */
export function planMergeLayers(
  dataset: CirDataset,
  names: string[],
  into: string,
  options: Partial<LayerOptions> = {}
): LayerPlan {
  const locked = (options.protectedLayers ?? []).filter((name) => names.includes(name));
  if (locked.length > 0) return lockRefusal('merge', names, locked);

  if (names.length < 2) {
    return refuse('merge', names, 'Merging needs at least two layers.', `${names.length} were selected.`, 'Select another layer.');
  }

  const sources = names.map((name) => dataset.layers.find((candidate) => candidate.name === name));
  const missing = names.filter((_, index) => !sources[index]);
  if (missing.length > 0) {
    return refuse('merge', names, 'Some selected layers could not be found.', `Missing: ${missing.join(', ')}.`, 'Reselect the layers.');
  }
  if (into.trim() === '') return refuse('merge', names, 'The merged layer needs a name.', 'The name is empty.', 'Type a name.');
  if (dataset.layers.some((candidate) => candidate.name === into && !names.includes(candidate.name))) {
    return refuse('merge', names, `A layer called "${into}" already exists.`, 'The merge would collide with it.', 'Choose a different name.');
  }

  const present = sources as CirLayer[];
  const merged = mergeInto(present, into);

  const notes: string[] = [];
  const fieldNames = new Set(merged.fields.map((field) => field.name));
  const partial = [...fieldNames].filter((field) => present.some((layer) => !layer.fields.some((f) => f.name === field)));
  if (partial.length > 0) {
    notes.push(
      `${partial.length} field(s) exist in some of these layers but not all — ${partial
        .slice(0, 5)
        .map((field) => `"${field}"`)
        .join(', ')}${partial.length > 5 ? '…' : ''}. Features from a layer without one get an empty cell, not a zero or a blank string.`
    );
  }

  const paths = new Set(present.map((layer) => layer.path.slice(0, -1).join('/')));
  if (paths.size > 1) {
    notes.push(
      `These layers sit in ${paths.size} different folders. The merged layer can only sit in one, so the folder structure of the others is not preserved in the output (R16).`
    );
  }

  const conflicting = conflictingTypes(present);
  if (conflicting.length > 0) {
    notes.push(
      `The merged layer holds ${conflicting.join(' and ')} together. Formats that allow one geometry type per file — shapefile among them — will split it again on export.`
    );
  }

  // The merged layer takes the position of the first source, so a merge does
  // not silently move the result to the bottom of the list.
  const firstIndex = dataset.layers.findIndex((candidate) => candidate.name === names[0]);
  const kept = dataset.layers.filter((candidate) => !names.includes(candidate.name));
  kept.splice(Math.min(firstIndex, kept.length), 0, merged);

  return { operation: 'merge', subjects: names, target: into, result: summarise(kept), notes };
}

function mergeInto(layers: CirLayer[], name: string): CirLayer {
  const fields: FieldDef[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    for (const field of layer.fields) {
      if (seen.has(field.name)) continue;
      seen.add(field.name);
      fields.push(field);
    }
  }

  const features: CirFeature[] = [];
  for (const layer of layers) {
    for (const feature of layer.features) {
      const properties: Record<string, unknown> = { ...feature.properties };
      // A field this feature's layer never had is missing, not empty. Null is
      // the only honest value.
      for (const field of fields) {
        if (!(field.name in properties)) properties[field.name] = null;
      }
      features.push({
        ...feature,
        properties,
        // R20: where each feature came from survives the merge.
        sourceLayer: feature.sourceLayer ?? layer.name,
      });
    }
  }

  // The shallowest common ancestor, so a merge inside one folder stays in it.
  const shared = commonPrefix(layers.map((layer) => layer.path.slice(0, -1)));

  return {
    name,
    path: [...shared, name],
    features,
    fields,
    geometryTypes: collectGeometryTypes(features),
    style: layers[0].style,
  };
}

function commonPrefix(paths: string[][]): string[] {
  if (paths.length === 0) return [];
  const shared: string[] = [];
  for (let index = 0; index < paths[0].length; index++) {
    const segment = paths[0][index];
    if (!paths.every((path) => path[index] === segment)) break;
    shared.push(segment);
  }
  return shared;
}

function conflictingTypes(layers: CirLayer[]): string[] {
  const families = new Set<string>();
  for (const layer of layers) {
    for (const type of layer.geometryTypes) {
      if (type.includes('Point')) families.add('points');
      else if (type.includes('LineString')) families.add('lines');
      else if (type.includes('Polygon')) families.add('polygons');
    }
  }
  return families.size > 1 ? [...families] : [];
}

/** How many layers a split may produce before it stops being useful. */
export const SPLIT_LIMIT = 200;

/**
 * Splits one layer into several, by a field's value or by geometry type.
 *
 * REFUSES above `SPLIT_LIMIT`, because splitting on a unique id produces one
 * layer per feature — an operation that succeeds, takes a long time and leaves
 * a dataset nobody can use or export.
 */
export function planSplitLayer(
  dataset: CirDataset,
  name: string,
  by: { kind: 'field'; field: string } | { kind: 'geometry' },
  options: Partial<LayerOptions> = {}
): LayerPlan {
  const locked = options.protectedLayers ?? [];
  if (locked.includes(name)) return lockRefusal('split', [name], [name]);

  const layer = dataset.layers.find((candidate) => candidate.name === name);
  if (!layer) return refuse('split', [name], 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');
  if (layer.features.length === 0) {
    return refuse('split', [name], 'That layer is empty.', 'There is nothing to split.', 'Choose a layer with features.');
  }

  if (by.kind === 'field' && !layer.fields.some((field) => field.name === by.field)) {
    return refuse('split', [name], `There is no field called "${by.field}".`, 'It is not in the layer schema.', 'Choose a field from the list.');
  }

  const { groups, nullGroup } = groupForSplit(layer, by);

  if (groups.size > SPLIT_LIMIT) {
    return refuse(
      'split',
      [name],
      `That split would produce ${groups.size.toLocaleString()} layers.`,
      `The limit is ${SPLIT_LIMIT}. A field with a value per feature — an id or a coordinate — splits into one layer per feature, which no output format handles usefully.`,
      'Split on a field with fewer distinct values, or filter the layer first.'
    );
  }
  if (groups.size < 2) {
    return refuse(
      'split',
      [name],
      'That split would produce one layer.',
      `Every feature has the same value for ${by.kind === 'geometry' ? 'geometry type' : `"${by.field}"`}.`,
      'Choose a different field.'
    );
  }

  const parts = partsFrom(layer, groups);

  const notes: string[] = [];
  if (nullGroup > 0) {
    notes.push(
      `${nullGroup.toLocaleString()} feature(s) have no value for "${by.kind === 'field' ? by.field : ''}" and go to a layer called "(empty)" rather than being discarded.`
    );
  }

  const index = dataset.layers.findIndex((candidate) => candidate.name === name);
  const kept = [...dataset.layers];
  kept.splice(index, 1, ...parts);

  return { operation: 'split', subjects: [name], splitBy: by, result: summarise(kept), notes };
}

/**
 * Groups a layer's features for a split.
 *
 * Shared by the planner and by `applyLayers`, so what is applied is what was
 * described. Two implementations that "obviously agree" is how a preview stops
 * matching its result.
 */
function groupForSplit(layer: CirLayer, by: SplitBy): { groups: Map<string, CirFeature[]>; nullGroup: number } {
  const groups = new Map<string, CirFeature[]>();
  let nullGroup = 0;

  for (const feature of layer.features) {
    let key: string;
    if (by.kind === 'geometry') {
      key = feature.geometry?.type ?? 'no geometry';
    } else {
      const value = feature.properties?.[by.field];
      if (value === null || value === undefined || value === '') {
        // Features with no value get their own named layer rather than being
        // dropped, which is what "split by owner" would otherwise do to every
        // unregistered parcel.
        key = '(empty)';
        nullGroup++;
      } else {
        key = String(value);
      }
    }
    groups.set(key, [...(groups.get(key) ?? []), feature]);
  }

  return { groups, nullGroup };
}

function partsFrom(layer: CirLayer, groups: Map<string, CirFeature[]>): CirLayer[] {
  return [...groups.entries()].map(([key, features]) => ({
    name: `${layer.name}_${sanitiseSegment(key)}`,
    // Splitting nests the parts under the original name, so the output tree
    // gains a folder rather than a scatter of siblings (R16).
    path: [...layer.path, sanitiseSegment(key)],
    features,
    fields: layer.fields,
    geometryTypes: collectGeometryTypes(features),
    style: layer.style,
  }));
}

/** Strips what no format allows in a layer or folder name. */
function sanitiseSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'unnamed';
}

/** Moves a layer to a new position in the dataset — draw order and output order. */
export function planReorder(dataset: CirDataset, name: string, toIndex: number): LayerPlan {
  const from = dataset.layers.findIndex((candidate) => candidate.name === name);
  if (from < 0) return refuse('reorder', [name], 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');

  const target = Math.max(0, Math.min(dataset.layers.length - 1, toIndex));
  const layers = [...dataset.layers];
  const [moved] = layers.splice(from, 1);
  layers.splice(target, 0, moved);

  return {
    operation: 'reorder',
    subjects: [name],
    toIndex: target,
    result: summarise(layers),
    notes:
      from === target
        ? []
        : ['Layer order is draw order in the preview and file order in the output — it is a property of the dataset, not of the view.'],
  };
}

/** Removes a layer and everything in it. */
export function planDeleteLayer(dataset: CirDataset, name: string, options: Partial<LayerOptions> = {}): LayerPlan {
  const locked = options.protectedLayers ?? [];
  if (locked.includes(name)) return lockRefusal('delete', [name], [name]);

  const layer = dataset.layers.find((candidate) => candidate.name === name);
  if (!layer) return refuse('delete', [name], 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');
  if (dataset.layers.length === 1) {
    return refuse(
      'delete',
      [name],
      'That is the only layer.',
      'Deleting it would leave a dataset with nothing in it, which no format can write.',
      'Hide the layer instead, or start again from the source file.'
    );
  }

  return {
    operation: 'delete',
    subjects: [name],
    result: summarise(dataset.layers.filter((candidate) => candidate.name !== name)),
    notes: [
      `${layer.features.length.toLocaleString()} feature(s) would be removed. This can be undone here, but not from an exported file.`,
    ],
  };
}

/** Sets a layer's style — this one is data, because it is written to the output. */
export function planStyleLayer(
  dataset: CirDataset,
  name: string,
  style: StyleHint,
  options: Partial<LayerOptions> = {}
): LayerPlan {
  const locked = options.protectedLayers ?? [];
  if (locked.includes(name)) return lockRefusal('style', [name], [name]);

  const layer = dataset.layers.find((candidate) => candidate.name === name);
  if (!layer) return refuse('style', [name], 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');

  const notes: string[] = [];
  // The ACI came from a CAD source and means something there; replacing it with
  // an RGB colour loses the index the drawing was authored with.
  if (layer.style?.aci !== undefined && style.color !== undefined && style.aci === undefined) {
    notes.push(
      `"${name}" carries AutoCAD Color Index ${layer.style.aci} from its source. Setting an RGB colour replaces it, and a DXF export will write the nearest index rather than the original.`
    );
  }

  return { operation: 'style', subjects: [name], style, result: summarise(dataset.layers), notes };
}

// =========================================================================
// Apply and undo
// =========================================================================

export interface LayerApplyResult {
  dataset: CirDataset;
  plan: AppliedLayerPlan;
}

/**
 * Applies a plan.
 *
 * The plan carries the layer NAMES and order it wants; the transformation is
 * recomputed here from the dataset so the plan stays small enough to sit in a
 * project file and a history entry. `before` is stamped on the returned plan,
 * and is what `undoLayers` restores.
 */
export function applyLayers(dataset: CirDataset, plan: LayerPlan): LayerApplyResult {
  // A refused plan still comes back undoable, so a caller that undoes
  // unconditionally gets a no-op rather than a crash.
  if (plan.refusal) return { dataset, plan: { ...plan, before: dataset.layers } };

  const before = dataset.layers;
  let layers: CirLayer[];

  switch (plan.operation) {
    case 'rename': {
      const to = plan.target;
      layers = to === undefined ? before : before.map((layer) => (layer.name === plan.subjects[0] ? renameLayer(layer, to) : layer));
      break;
    }

    case 'merge': {
      const sources = plan.subjects
        .map((subject) => before.find((layer) => layer.name === subject))
        .filter((layer): layer is CirLayer => layer !== undefined);
      if (sources.length < 2) {
        layers = before;
        break;
      }
      const merged = mergeInto(sources, plan.target ?? plan.subjects[0]);
      const firstIndex = before.findIndex((layer) => layer.name === plan.subjects[0]);
      const kept = before.filter((layer) => !plan.subjects.includes(layer.name));
      kept.splice(Math.min(firstIndex, kept.length), 0, merged);
      layers = kept;
      break;
    }

    case 'split': {
      const layer = before.find((candidate) => candidate.name === plan.subjects[0]);
      if (!layer || !plan.splitBy) {
        layers = before;
        break;
      }
      // The same grouping the planner ran, rather than a stored copy of every
      // feature: a plan small enough to live in a project file and a history
      // entry, and one implementation so preview and result cannot diverge.
      const { groups } = groupForSplit(layer, plan.splitBy);
      const index = before.indexOf(layer);
      layers = [...before];
      layers.splice(index, 1, ...partsFrom(layer, groups));
      break;
    }

    case 'reorder': {
      const from = before.findIndex((layer) => layer.name === plan.subjects[0]);
      if (from < 0 || plan.toIndex === undefined) {
        layers = before;
        break;
      }
      const target = Math.max(0, Math.min(before.length - 1, plan.toIndex));
      layers = [...before];
      const [moved] = layers.splice(from, 1);
      layers.splice(target, 0, moved);
      break;
    }

    case 'delete':
      layers = before.filter((layer) => layer.name !== plan.subjects[0]);
      break;

    case 'style':
      layers = before.map((layer) =>
        layer.name === plan.subjects[0] ? { ...layer, style: { ...layer.style, ...(plan.style ?? {}) } } : layer
      );
      break;

    default:
      layers = before;
  }

  return { dataset: { ...dataset, layers }, plan: { ...plan, before } };
}

/** Restores the layer list a plan replaced. Takes the plan `applyLayers` returned. */
export function undoLayers(dataset: CirDataset, plan: AppliedLayerPlan): CirDataset {
  return { ...dataset, layers: plan.before };
}

/** A one-line account of a plan, for the confirmation prompt. */
export function describeLayerPlan(plan: LayerPlan): string {
  if (plan.refusal) return `${plan.refusal.what} ${plan.refusal.why} ${plan.refusal.action}`;
  const head = `${LAYER_LABEL[plan.operation]}: ${plan.subjects.join(', ')} → ${plan.result.length} layer${plan.result.length === 1 ? '' : 's'}`;
  return plan.notes.length > 0 ? `${head}. ${plan.notes.join(' ')}` : `${head}.`;
}

// =========================================================================
// Export-selected
// =========================================================================

/**
 * A dataset holding only the chosen layers.
 *
 * Takes an explicit selection rather than reading `LayerViewState`: an export
 * subset must be something the user picked, not a side effect of what the
 * canvas happened to be showing. Returns null when nothing was selected, so the
 * caller reports it rather than exporting an empty file.
 */
export function selectionForExport(dataset: CirDataset, selected: string[]): CirDataset | null {
  const wanted = new Set(selected);
  const layers = dataset.layers.filter((layer) => wanted.has(layer.name));
  if (layers.length === 0) return null;

  return {
    ...dataset,
    layers,
    warnings:
      layers.length === dataset.layers.length
        ? dataset.warnings
        : [
            ...dataset.warnings,
            {
              code: 'layers-subset',
              severity: 'info' as const,
              message: `Exported ${layers.length} of ${dataset.layers.length} layers: ${layers.map((layer) => layer.name).join(', ')}.`,
            },
          ],
  };
}
