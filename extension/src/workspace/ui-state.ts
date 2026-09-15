/**
 * The workspace's VIEW state — one object, in one place.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN THE STORE
 *
 * `state/store.ts` is the single writer for everything that survives a reload
 * or reaches the worker: the queue, the settings, the datasets, the queued
 * edits. None of what lives here does. A canvas instance cannot be serialised,
 * a text filter typed into the layer list is not worth a store round trip on
 * every keystroke, and which vertex is currently selected has no meaning to a
 * conversion.
 *
 * So RULE 24 is not being bent. The rule is that application state has one
 * owner; this is a different kind of state, and giving it its own named owner
 * is the point rather than the exception.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE OBJECT RATHER THAN EXPORTED `let`s
 *
 * An exported `let` is a live binding a reader sees but CANNOT ASSIGN: the edit
 * panel could read `editSelection` and never update it. Splitting the workspace
 * across files therefore turns eight exported `let`s into either eight pairs of
 * getters and setters or a silent bug the compiler does catch — but only after
 * you have written the assignment and wondered why nothing moved.
 *
 * One mutable object is honest about what it is: shared, mutable, and named at
 * every use site as `ui.something`, so a reader of any panel can see instantly
 * that the value is not local.
 */

import type { Basemap } from '../ui/basemap';
import type { GeorefCanvas } from '../ui/georef-canvas';
import type { GeorefSession } from '../core/georeference-apply';
import type { CirDataset, Position } from '../core/cir';
import type { CommandPalette } from '../ui/command-palette';
import type { DualCanvas } from '../ui/dual-canvas';
import type { EditCanvas, EditTarget } from '../ui/edit-canvas';
import type { MeasureCanvas } from '../ui/measure-canvas';
import type { PreviewCanvas } from '../ui/preview';
import type { Backdrop } from '../ui/backdrop';
import type { ToolCanvas } from '../ui/tool-canvas';
import type { Selection } from '../core/selection';
import type { VertexRef } from '../core/vertex-edit';

export interface UiState {
  /** Layer-list search text. UI-local: it is not worth a store round trip. */
  layerSearch: string;
  /** Layers ticked in the layer list, for merge, split, delete and export. */
  layerSelection: string[];
  /** The single-dataset canvas. Created on first use, then reused. */
  previewCanvas: PreviewCanvas | null;
  /** Source and output side by side, for the Compare tab. */
  dualCanvas: DualCanvas | null;
  /** The vertex-editing interaction layer, drawn over `previewCanvas`. */
  editCanvas: EditCanvas | null;
  /** The measuring interaction layer, drawn over `previewCanvas`. */
  measureCanvas: MeasureCanvas | null;
  /** Vertices currently selected in the editor. */
  editSelection: VertexRef[];
  /** The feature being edited: which layer, which index. */
  editTarget: EditTarget | null;
  /** The selecting-and-moving interaction layer, drawn over `previewCanvas`. */
  toolCanvas: ToolCanvas | null;
  georefCanvas: GeorefCanvas | null;
  /** Opens a dock group and section. Set by main.ts; used by tools that own a panel. */
  openPanel?: (group: string, tab?: string) => void;
  /**
   * The dataset as it stood before the first pending edit, drawn as a grey
   * dashed ghost so an edit can be compared with what was there.
   */
  editTrace?: CirDataset | null;
  /**
   * Which ribbon tab is forward — Home, Draw, Modify, Measure or Place.
   *
   * On the UI state rather than in the store because it is where the user is
   * LOOKING, not what the file is: it must not be written into a project, and
   * reopening a file should not restore someone else's idea of which tools they
   * wanted forward.
   */
  ribbonTab?: string;
  /**
   * A folded ribbon, dropped open for one use.
   *
   * Excel's rule, and the one that makes a folded ribbon usable rather than a
   * ribbon you have to unfold: while it is folded, clicking a tab shows that
   * tab's controls until the next click on the canvas, then folds again. It is
   * a transient, so it is NOT persisted — a reload starts folded, the way the
   * user left it.
   */
  ribbonPeek?: boolean;
  /**
   * The placement in progress, and the untouched source it is placed FROM.
   *
   * `georefOriginal` is the surveyor's original local-grid dataset and is never
   * written to. Every drag re-places from it through `georefSession.affine`, so
   * a thousand gestures cost one multiplication rather than a thousand
   * compounding roundings — and cancelling is just dropping both fields.
   */
  georefSession: GeorefSession | null;
  /**
   * The drawing half of a pair, waiting for its reference half.
   *
   * Deliberately NOT on the session: a half-picked pair is interaction state
   * that must never reach a fit or a committed placement.
   */
  georefPending?: Position | null;
  georefOriginal: CirDataset | null;
  /**
   * A local image or scanned sheet drawn UNDER the canvas.
   *
   * Kept apart from `basemap` deliberately: they look alike on screen and are
   * opposites underneath. A basemap is remote, tiled, needs a network, and is
   * authoritative about position whenever it draws at all. A backdrop is local,
   * needs no network ever, and may be placed by a route that fixes scale and
   * rotation while knowing nothing about where on Earth it is.
   */
  backdrop: Backdrop | null;
  /**
   * FEATURES currently selected, which is a different thing from `editSelection`.
   *
   * The vertex editor selects VERTICES inside one open feature; this selects
   * whole features across layers, and is what a transform is applied to. Keeping
   * them apart is deliberate: sharing one list would make Delete in the vertex
   * editor able to reach a feature the user picked on another tab.
   */
  featureSelection: Selection;
  /** Ctrl/Cmd+K. Created once at boot. */
  palette: CommandPalette | null;
  /**
   * The tile layer under the preview canvas, when the user has turned it on.
   *
   * Held here rather than inside PreviewCanvas so the canvas stays unaware that
   * tiles exist, and so switching provider clears one cache rather than leaving
   * a stale one on whichever canvas happens to hold it.
   */
  basemap?: Basemap;
  /**
   * Whether the grid is drawn — a MIRROR of `PreviewCanvas.showGrid`, not the
   * owner of it. The canvas keeps that field private and offers `toggleGrid()`,
   * which is the right shape; this exists only so the toolbar button can light
   * up. Both are flipped at the one call site that toggles either.
   */
  gridOn?: boolean;
  /** Whether new geometry snaps to existing vertices, midpoints and segments. */
  snapOn?: boolean;
  /** Whether new segments are constrained to one axis (F8, as in AutoCAD). */
  orthoOn?: boolean;
  /**
   * Undo and redo, as the workspace implements them.
   *
   * Held here so the toolbar can call them without importing `main.ts`, which
   * already imports the toolbar — a cycle that builds but initialises in an
   * order neither file controls.
   */
  undo?: () => void;
  redo?: () => void;
}

// The tile layer under the preview canvas, when the user has turned it on.
// Held here rather than inside PreviewCanvas so the canvas stays unaware that
// tiles exist, and so switching provider can clear one cache rather than hunt
// for every canvas that might hold one.

export const ui: UiState = {
  layerSearch: '',
  layerSelection: [],
  previewCanvas: null,
  dualCanvas: null,
  editCanvas: null,
  measureCanvas: null,
  editSelection: [],
  editTarget: null,
  toolCanvas: null,
  georefCanvas: null,
  editTrace: null,
  georefSession: null,
  georefPending: null,
  georefOriginal: null,
  backdrop: null,
  featureSelection: { refs: [], wholeLayers: [] },
  palette: null,
  basemap: undefined,
  // The canvas constructs with the grid ON, so the mirror starts true or the
  // button would claim it is off while the grid is drawn.
  gridOn: true,
  snapOn: true,
  orthoOn: false,
};
