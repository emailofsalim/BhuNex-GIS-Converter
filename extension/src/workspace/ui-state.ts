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
import type { CommandPalette } from '../ui/command-palette';
import type { DualCanvas } from '../ui/dual-canvas';
import type { EditCanvas, EditTarget } from '../ui/edit-canvas';
import type { MeasureCanvas } from '../ui/measure-canvas';
import type { PreviewCanvas } from '../ui/preview';
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
  palette: null,
  basemap: undefined,
};
