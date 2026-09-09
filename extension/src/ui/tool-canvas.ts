/**
 * One active tool on the canvas (phase C of docs/EDITING_WORKSTATION.md).
 *
 * This is the layer that turns a pointer into a selection or a move. It is the
 * gesture half of the owner's original request:
 *
 *   "select multiple geometry which need to shift then simply drag or pan all
 *    that geometry to the position with the help of map tile"
 *
 * `core/selection.ts` decides WHAT a gesture caught. `core/geometry-ops.ts`
 * decides what a translate DOES. This decides only what the pointer meant, and
 * owns no geometry of its own — a completed drag leaves through `onMove` as an
 * offset for the host to turn into a replayable command, exactly as the vertex
 * editor hands out a plan rather than mutating the dataset.
 *
 * ---------------------------------------------------------------------------
 * WHY A MODE, AND NOT A HANDFUL OF MODIFIER KEYS
 *
 * There are already three overlays sharing `PreviewCanvas.onOverlay` — editing,
 * measuring and the geometry planner — and the hook is deliberately singular so
 * a stale tool cannot keep drawing over a tab it no longer belongs to. A dozen
 * tools cannot each own a modifier combination without colliding, so there is
 * ONE active tool, Escape always returns to select, and one place decides what a
 * click means.
 *
 * ---------------------------------------------------------------------------
 * THE TWO CONVENTIONS BORROWED FROM CAD, BECAUSE THE USER ALREADY KNOWS THEM
 *
 * · A rubber band dragged LEFT TO RIGHT takes only what is wholly inside; one
 *   dragged RIGHT TO LEFT takes anything it touches. Every CAD package a
 *   surveyor uses does this, and inventing a different rule here would make the
 *   tool feel wrong in a way that is hard to articulate and easy to resent.
 * · Holding Shift DURING a drag constrains it to the nearer axis — ortho. That
 *   does not collide with Shift-click-to-toggle, because toggling is decided at
 *   pointer-down and ortho only applies once the pointer has moved.
 *
 * ---------------------------------------------------------------------------
 * NOTHING COMMITS UNTIL RELEASE
 *
 * A drag draws a preview and reports its live offset; the dataset is untouched
 * until the pointer comes up. Committing per pointermove would put sixty
 * translate commands in the history for one drag.
 */

import type { Bounds, CirGeometry, Position } from '../core/cir';
import {
  constrainOrtho,
  DEFAULT_SNAP_SETTINGS,
  DRAW_HINT,
  type DrawKind,
  findSnapTarget,
  MIN_VERTICES,
  SNAP_KIND_LABEL,
  type SnapSettings,
  type SnapSource,
  type SnapTarget,
} from '../core/drawing';
import {
  type FeatureRef,
  type SelectMode,
  type SelectableLayer,
  type Selection,
  combine,
  describeSelection,
  hitTest,
  isEmpty,
  scopeFor,
  selectInLasso,
  selectInRectangle,
  selectedLayers,
} from '../core/selection';
import type { PreviewCanvas } from './preview';

export type CanvasTool = 'select' | 'lasso' | 'move' | DrawTool;

/** The drawing tools, named after what they produce. */
export type DrawTool = 'draw-point' | 'draw-marker' | 'draw-line' | 'draw-polygon' | 'draw-text';

export const DRAW_TOOLS: DrawTool[] = ['draw-point', 'draw-marker', 'draw-line', 'draw-polygon', 'draw-text'];

/** The `DrawKind` a drawing tool produces. */
export function kindOfTool(tool: CanvasTool): DrawKind | null {
  switch (tool) {
    case 'draw-point':
      return 'point';
    case 'draw-marker':
      return 'marker';
    case 'draw-line':
      return 'line';
    case 'draw-polygon':
      return 'polygon';
    case 'draw-text':
      return 'text';
    default:
      return null;
  }
}

export const TOOL_LABEL: Record<CanvasTool, string> = {
  select: 'Select',
  lasso: 'Lasso',
  move: 'Move',
  'draw-point': 'Point',
  'draw-marker': 'Marker',
  'draw-line': 'Line',
  'draw-polygon': 'Polygon',
  'draw-text': 'Text',
};

export const TOOL_HINT: Record<CanvasTool, string> = {
  select:
    'Click a feature to select it, Shift-click to add or remove. Drag from empty space for a rubber band — left to right takes only what is wholly inside, right to left takes anything it touches. Drag from a selected feature to move the whole selection.',
  lasso: 'Draw a freehand outline around the features to select. Shift adds to the selection instead of replacing it.',
  move: 'Drag anywhere to move the current selection. Hold Shift to constrain to one axis.',
  'draw-point': DRAW_HINT.point,
  'draw-marker': DRAW_HINT.marker,
  'draw-line': DRAW_HINT.line,
  'draw-polygon': DRAW_HINT.polygon,
  'draw-text': DRAW_HINT.text,
};

/** Pick radius in screen pixels — constant to the finger at any zoom. */
const PICK_RADIUS_PX = 8;

/** A drag shorter than this is a click that wobbled, not a move. */
const DRAG_THRESHOLD_PX = 3;

const SELECTED_COLOR = '#f5b041';
const BAND_CONTAIN = '#58a6ff';
const BAND_INTERSECT = '#3fb950';
const MOVE_GHOST = '#f5b041';
const DRAW_COLOR = '#3fb950';
/** A snapped vertex is a different colour from a free one, deliberately. */
const SNAP_COLOR = '#58a6ff';

export interface MoveOffset {
  dx: number;
  dy: number;
}

export interface ToolHost {
  /** The layers as the canvas currently draws them, including lock and visibility. */
  layers: () => SelectableLayer[];
  /** The current selection, owned by the host so a panel can change it too. */
  selection: () => Selection;
  onSelectionChange: (selection: Selection) => void;
  /** A completed drag, in world units. Called once, on release. */
  onMove: (selection: Selection, offset: MoveOffset) => void;
  /** A live status line, for the readout while a gesture is in progress. */
  onStatus?: (text: string) => void;
  onToolChange?: (tool: CanvasTool) => void;
  /** A finished drawing, in world coordinates. Called once, when it closes. */
  onDraw?: (kind: DrawKind, positions: Position[], usedSnaps: SnapTarget[]) => void;
  /** Layers a drawn vertex may snap to. Empty means no snapping. */
  snapSources?: () => SnapSource[];
  /** Which snap kinds are live. Absent means vertices only. */
  snapSettings?: () => SnapSettings;
  /**
   * Where a move should actually land.
   *
   * Supplied by the host so snapping stays in one place rather than being
   * reimplemented here. Returning the offset unchanged means no snapping.
   */
  snapMove?: (offset: MoveOffset, selection: Selection) => MoveOffset;
}

type Gesture =
  | { kind: 'band'; from: Position; to: Position }
  | { kind: 'lasso'; points: Position[] }
  | { kind: 'move'; from: Position; to: Position; moved: boolean };

/** A drawing in progress: the vertices placed so far, and how each was found. */
interface Drawing {
  tool: DrawTool;
  positions: Position[];
  /** One per placed vertex, null where the pointer position was taken as-is. */
  snaps: (SnapTarget | null)[];
  /** Where the pointer is now, for the rubber-banded segment. */
  cursor: Position | null;
  /** The snap the cursor is currently over, for the highlight and the readout. */
  hoverSnap: SnapTarget | null;
}

export class ToolCanvas {
  private tool: CanvasTool = 'select';
  private gesture: Gesture | null = null;
  private drawing: Drawing | null = null;
  private hover: FeatureRef | null = null;
  private enabled = false;
  /** Ortho is a sticky mode as well as a Shift modifier, as CAD's F8 is. */
  private ortho = false;
  private readonly onKeyDown: (event: KeyboardEvent) => void;

  constructor(
    private readonly preview: PreviewCanvas,
    private readonly host: ToolHost
  ) {
    const element = this.preview.element;
    element.addEventListener('pointerdown', this.handlePointerDown, { capture: true });
    element.addEventListener('pointermove', this.handlePointerMove, { capture: true });
    element.addEventListener('pointerup', this.handlePointerUp, { capture: true });
    element.addEventListener('pointercancel', this.handlePointerCancel, { capture: true });
    element.addEventListener('dblclick', this.handleDoubleClick, { capture: true });

    this.onKeyDown = (event) => this.handleKey(event);
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** Re-claims the canvas's single overlay hook. See the class header. */
  reattach(): void {
    this.preview.onOverlay = (context, project) => this.draw(context, project);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.gesture = null;
      this.hover = null;
    }
    this.preview.element.style.cursor = enabled ? this.cursorFor(this.tool) : '';
    this.preview.render();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setTool(tool: CanvasTool): void {
    if (this.tool === tool) return;
    this.tool = tool;
    // An in-flight gesture belongs to the tool that started it. Carrying a
    // half-drawn lasso into the move tool would apply it as something else,
    // and a half-drawn polygon into the point tool would place a stray point.
    this.gesture = null;
    this.drawing = null;
    this.preview.element.style.cursor = this.cursorFor(tool);
    this.host.onToolChange?.(tool);
    this.host.onStatus?.(TOOL_HINT[tool]);
    this.preview.render();
  }

  getTool(): CanvasTool {
    return this.tool;
  }

  /** Ortho as a sticky mode, the way F8 works in every CAD package. */
  setOrtho(on: boolean): void {
    this.ortho = on;
    this.preview.render();
  }

  isOrtho(): boolean {
    return this.ortho;
  }

  /** How many vertices the drawing in progress has, for the panel. */
  drawnCount(): number {
    return this.drawing?.positions.length ?? 0;
  }

  /** Abandons a drawing in progress without placing anything. */
  cancelDrawing(): void {
    if (!this.drawing) return;
    this.drawing = null;
    this.host.onStatus?.('Drawing abandoned.');
    this.preview.render();
  }

  /** Closes the drawing in progress, as double-click or Enter does. */
  finishDrawing(): void {
    this.completeDrawing();
  }

  dispose(): void {
    const element = this.preview.element;
    element.removeEventListener('pointerdown', this.handlePointerDown, { capture: true });
    element.removeEventListener('pointermove', this.handlePointerMove, { capture: true });
    element.removeEventListener('pointerup', this.handlePointerUp, { capture: true });
    element.removeEventListener('pointercancel', this.handlePointerCancel, { capture: true });
    element.removeEventListener('dblclick', this.handleDoubleClick, { capture: true });
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.preview.onOverlay) this.preview.onOverlay = undefined;
  }

  private cursorFor(tool: CanvasTool): string {
    return tool === 'move' ? 'move' : tool === 'lasso' ? 'crosshair' : 'default';
  }

  /** Pick tolerance in world units, from a constant number of screen pixels. */
  private get tolerance(): number {
    return PICK_RADIUS_PX * this.preview.unitsPerPixel;
  }

  // ------------------------------------------------------------- interaction

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.enabled || event.button !== 0) return;
    const world = this.preview.unproject(event.offsetX, event.offsetY);
    const at: Position = [world.x, world.y];

    const drawKind = kindOfTool(this.tool);
    if (drawKind) {
      stop(event);
      this.placeVertex(drawKind, at, event.shiftKey);
      return;
    }

    if (this.tool === 'lasso') {
      stop(event);
      this.preview.element.setPointerCapture(event.pointerId);
      this.gesture = { kind: 'lasso', points: [at] };
      return;
    }

    if (this.tool === 'move') {
      if (isEmpty(this.host.selection())) {
        this.host.onStatus?.('Select something first — the move tool drags the current selection.');
        return;
      }
      stop(event);
      this.preview.element.setPointerCapture(event.pointerId);
      this.gesture = { kind: 'move', from: at, to: at, moved: false };
      return;
    }

    // --- the select tool ---------------------------------------------------
    const picked = hitTest(this.host.layers(), at, this.tolerance);

    if (picked && this.isSelected(picked.ref) && !event.shiftKey) {
      // Pressing on something already selected begins a move of the whole
      // selection. This is what makes the shift-correction gesture a single
      // motion rather than a tool change between selecting and dragging.
      stop(event);
      this.preview.element.setPointerCapture(event.pointerId);
      this.gesture = { kind: 'move', from: at, to: at, moved: false };
      return;
    }

    if (picked) {
      stop(event);
      this.preview.element.setPointerCapture(event.pointerId);
      const mode: SelectMode = event.shiftKey ? 'toggle' : 'replace';
      this.host.onSelectionChange(combine(this.host.selection(), [picked.ref], mode));
      // A press on a newly selected feature can still become a drag, so the
      // gesture is armed either way; a release without movement is just the
      // selection that already happened.
      this.gesture = { kind: 'move', from: at, to: at, moved: false };
      this.preview.render();
      return;
    }

    // Empty space. The band is armed but the event is NOT stopped, so a plain
    // press that turns out to be a pan still pans — the band only takes over
    // once the pointer has actually moved past the threshold.
    this.gesture = { kind: 'band', from: at, to: at };
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    const world = this.preview.unproject(event.offsetX, event.offsetY);
    const at: Position = [world.x, world.y];

    const drawKind = kindOfTool(this.tool);
    if (drawKind) {
      const resolved = this.resolveDrawPosition(at, event.shiftKey);
      if (this.drawing) {
        this.drawing.cursor = resolved.position;
        this.drawing.hoverSnap = resolved.snap;
      }
      this.preview.element.style.cursor = resolved.snap ? 'cell' : 'crosshair';
      this.host.onStatus?.(this.describeDrawing(drawKind, resolved.snap));
      this.preview.render();
      return;
    }

    if (!this.gesture) {
      if (this.tool !== 'select') return;
      const picked = hitTest(this.host.layers(), at, this.tolerance);
      const changed = (picked?.ref.layer ?? null) !== (this.hover?.layer ?? null) || (picked?.ref.index ?? -1) !== (this.hover?.index ?? -1);
      this.hover = picked?.ref ?? null;
      this.preview.element.style.cursor = picked
        ? this.isSelected(picked.ref)
          ? 'move'
          : 'pointer'
        : this.cursorFor(this.tool);
      if (changed) this.preview.render();
      return;
    }

    switch (this.gesture.kind) {
      case 'band': {
        if (!this.passedThreshold(this.gesture.from, at)) return;
        stop(event);
        this.preview.element.setPointerCapture(event.pointerId);
        this.gesture.to = at;
        this.host.onStatus?.(this.describeBand(this.gesture));
        this.preview.render();
        return;
      }
      case 'lasso': {
        stop(event);
        const points = this.gesture.points;
        const last = points[points.length - 1];
        // One point per pixel of travel is plenty: a lasso sampled per event on
        // a fast pointer collects thousands of near-identical vertices, and
        // every one costs a crossing test against every feature.
        if (Math.hypot(at[0] - last[0], at[1] - last[1]) >= this.preview.unitsPerPixel) points.push(at);
        this.preview.render();
        return;
      }
      case 'move': {
        if (!this.gesture.moved && !this.passedThreshold(this.gesture.from, at)) return;
        stop(event);
        this.gesture.moved = true;
        this.gesture.to = event.shiftKey ? orthogonal(this.gesture.from, at) : at;
        this.host.onStatus?.(this.describeMove(this.offsetOf(this.gesture)));
        this.preview.render();
        return;
      }
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.gesture) return;
    const gesture = this.gesture;
    this.gesture = null;

    if (this.preview.element.hasPointerCapture(event.pointerId)) {
      this.preview.element.releasePointerCapture(event.pointerId);
    }

    switch (gesture.kind) {
      case 'band': {
        const at = this.preview.unproject(event.offsetX, event.offsetY);
        if (!this.passedThreshold(gesture.from, [at.x, at.y])) {
          // A click on empty space clears the selection. Not stopped, so a
          // click that was really the end of a pan still behaves as a pan.
          if (!isEmpty(this.host.selection())) {
            this.host.onSelectionChange({ refs: [], wholeLayers: [] });
            this.preview.render();
          }
          return;
        }
        stop(event);
        const rectangle = boundsOf(gesture.from, gesture.to);
        const mode = gesture.to[0] >= gesture.from[0] ? 'contain' : 'intersect';
        const found = selectInRectangle(this.host.layers(), rectangle, mode);
        this.host.onSelectionChange(combine(this.host.selection(), found, event.shiftKey ? 'add' : 'replace'));
        this.report();
        this.preview.render();
        return;
      }
      case 'lasso': {
        stop(event);
        const found = selectInLasso(this.host.layers(), gesture.points, 'intersect');
        this.host.onSelectionChange(combine(this.host.selection(), found, event.shiftKey ? 'add' : 'replace'));
        this.report();
        this.preview.render();
        return;
      }
      case 'move': {
        if (!gesture.moved) {
          // A press and release with no travel: the selection made on
          // pointer-down stands, and no zero-length translate is recorded.
          this.report();
          this.preview.render();
          return;
        }
        stop(event);
        const raw = this.offsetOf(gesture);
        const offset = this.host.snapMove ? this.host.snapMove(raw, this.host.selection()) : raw;
        this.host.onMove(this.host.selection(), offset);
        this.preview.render();
        return;
      }
    }
  };

  // ------------------------------------------------------------------ drawing

  /**
   * Where a drawn vertex should actually land.
   *
   * Snapping wins over ortho when both apply, and that order matters: ortho is
   * a convenience for placing a vertex where nothing exists, while a snap puts
   * it on something that DOES exist. Constraining a snapped vertex to an axis
   * would move it off the thing it was snapped to, which defeats the snap and
   * produces a boundary that misses the control point by a metre while looking
   * exactly right.
   */
  private resolveDrawPosition(raw: Position, shift: boolean): { position: Position; snap: SnapTarget | null } {
    const sources = this.host.snapSources?.() ?? [];
    const settings = this.host.snapSettings?.() ?? DEFAULT_SNAP_SETTINGS;
    const snap = sources.length > 0 ? findSnapTarget(sources, raw, this.tolerance, settings) : null;
    if (snap) return { position: snap.position, snap };

    const previous = this.drawing?.positions[this.drawing.positions.length - 1];
    if (previous && (shift || this.ortho)) return { position: constrainOrtho(previous, raw), snap: null };
    return { position: raw, snap: null };
  }

  private placeVertex(kind: DrawKind, raw: Position, shift: boolean): void {
    const { position, snap } = this.resolveDrawPosition(raw, shift);

    if (!this.drawing) {
      this.drawing = { tool: this.tool as DrawTool, positions: [], snaps: [], cursor: position, hoverSnap: snap };
    }
    this.drawing.positions.push(position);
    this.drawing.snaps.push(snap);
    this.drawing.cursor = position;

    // A point, a marker and a text object are one click each, so they close
    // immediately rather than waiting for a double-click nobody would make.
    if (MIN_VERTICES[kind] === 1) {
      this.completeDrawing();
      return;
    }

    this.host.onStatus?.(this.describeDrawing(kind, snap));
    this.preview.render();
  }

  private completeDrawing(): void {
    const drawing = this.drawing;
    if (!drawing) return;
    const kind = kindOfTool(drawing.tool);
    if (!kind) {
      this.drawing = null;
      return;
    }

    this.drawing = null;
    // The refusals live in `buildDrawnFeature`, so a two-vertex "polygon" is
    // rejected in one place whether it came from a double-click, from Enter or
    // from a command. The host reports whatever comes back.
    this.host.onDraw?.(kind, drawing.positions, drawing.snaps.filter((snap): snap is SnapTarget => snap !== null));
    this.preview.render();
  }

  private describeDrawing(kind: DrawKind, snap: SnapTarget | null): string {
    const placed = this.drawing?.positions.length ?? 0;
    const needed = MIN_VERTICES[kind];
    const snapText = snap ? ` · snapping to a ${SNAP_KIND_LABEL[snap.kind]}${snap.layer ? ` in ${snap.layer}` : ''}` : '';
    if (placed === 0) return `${TOOL_LABEL[this.tool]}: click to start${snapText}`;
    if (placed < needed) {
      return `${placed} of ${needed} placed — ${needed - placed} more needed${snapText}`;
    }
    return `${placed} placed · double-click or Enter to finish · Backspace undoes one${snapText}`;
  }

  private handlePointerCancel = (): void => {
    // A cancelled pointer — the browser taking over, a palm rejected — must not
    // commit a half-finished drag as if it were released deliberately. A
    // drawing in progress is left alone: it is a run of deliberate clicks, not
    // one gesture, and discarding four placed corners because a palm brushed
    // the screen would be the worse failure.
    if (!this.gesture) return;
    this.gesture = null;
    this.preview.render();
  };

  /**
   * Double-click closes a line or a polygon.
   *
   * The second click of the double has already placed a vertex on top of the
   * first, and `buildDrawnFeature` drops consecutive repeats — so the shape
   * closes on the vertices the user meant rather than one duplicated corner.
   */
  private handleDoubleClick = (event: MouseEvent): void => {
    if (!this.enabled || !this.drawing) return;
    stop(event);
    this.completeDrawing();
  };

  private handleKey(event: KeyboardEvent): void {
    if (!this.enabled) return;
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;

    if (this.drawing) {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.completeDrawing();
        return;
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        this.drawing.positions.pop();
        this.drawing.snaps.pop();
        if (this.drawing.positions.length === 0) this.drawing = null;
        this.preview.render();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelDrawing();
        return;
      }
    }

    // F8 toggles ortho, as it does in AutoCAD. The one keyboard convention
    // worth borrowing verbatim, because a surveyor's hand already knows it.
    if (event.key === 'F8') {
      event.preventDefault();
      this.setOrtho(!this.ortho);
      this.host.onStatus?.(this.ortho ? 'Ortho on — new segments follow one axis.' : 'Ortho off.');
      this.host.onToolChange?.(this.tool);
      return;
    }

    if (event.key === 'Escape') {
      if (this.gesture) {
        this.gesture = null;
        this.preview.render();
        return;
      }
      if (this.tool !== 'select') {
        this.setTool('select');
        return;
      }
      if (!isEmpty(this.host.selection())) {
        this.host.onSelectionChange({ refs: [], wholeLayers: [] });
        this.preview.render();
      }
    }
  }

  private passedThreshold(from: Position, to: Position): boolean {
    const pixels = Math.hypot(to[0] - from[0], to[1] - from[1]) / this.preview.unitsPerPixel;
    return pixels >= DRAG_THRESHOLD_PX;
  }

  private isSelected(ref: FeatureRef): boolean {
    const selection = this.host.selection();
    if (selection.wholeLayers.includes(ref.layer)) return true;
    return selection.refs.some((candidate) => candidate.layer === ref.layer && candidate.index === ref.index);
  }

  private offsetOf(gesture: { from: Position; to: Position }): MoveOffset {
    return { dx: gesture.to[0] - gesture.from[0], dy: gesture.to[1] - gesture.from[1] };
  }

  private describeBand(gesture: { from: Position; to: Position }): string {
    return gesture.to[0] >= gesture.from[0]
      ? 'Taking only features wholly inside the band.'
      : 'Taking every feature the band touches.';
  }

  private describeMove(offset: MoveOffset): string {
    const distance = Math.hypot(offset.dx, offset.dy);
    return `Moving ${format(offset.dx)} east, ${format(offset.dy)} north — ${format(distance)} in all. Hold Shift for one axis only.`;
  }

  private report(): void {
    this.host.onStatus?.(describeSelection(this.host.selection(), this.host.layers()));
  }

  // ------------------------------------------------------------------ drawing

  private draw(context: CanvasRenderingContext2D, project: (x: number, y: number) => { x: number; y: number }): void {
    if (!this.enabled) return;
    context.save();

    const selection = this.host.selection();
    const layers = this.host.layers();
    const offset = this.gesture?.kind === 'move' && this.gesture.moved ? this.offsetOf(this.gesture) : null;

    // Selected features, highlighted where they are — and, mid-drag, a dashed
    // ghost where they would land. Both are drawn so the user can see how far
    // they have come, which is the whole point of dragging against a basemap.
    context.lineWidth = 2.4;
    context.strokeStyle = SELECTED_COLOR;
    for (const geometry of selectedGeometries(selection, layers)) {
      drawGeometry(context, project, geometry, null);
    }

    if (offset) {
      context.setLineDash([6, 4]);
      context.strokeStyle = MOVE_GHOST;
      context.lineWidth = 1.8;
      for (const geometry of selectedGeometries(selection, layers)) {
        drawGeometry(context, project, geometry, offset);
      }
      context.setLineDash([]);
      this.drawMoveVector(context, project);
    }

    if (this.hover && !this.isSelected(this.hover) && !this.gesture) {
      const geometry = geometryAt(layers, this.hover);
      if (geometry) {
        context.lineWidth = 2;
        context.strokeStyle = '#ffffff';
        drawGeometry(context, project, geometry, null);
      }
    }

    if (this.gesture?.kind === 'band') this.drawBand(context, project, this.gesture);
    if (this.gesture?.kind === 'lasso') this.drawLasso(context, project, this.gesture.points);
    if (this.drawing) this.drawInProgress(context, project, this.drawing);

    context.restore();
  }

  /**
   * The shape being drawn, with its placed vertices and the live segment.
   *
   * A snapped vertex is drawn differently from a free one, on purpose: after
   * twenty clicks the only way to know the boundary actually landed on the
   * control points is to be able to see which vertices took a snap.
   */
  private drawInProgress(
    context: CanvasRenderingContext2D,
    project: (x: number, y: number) => { x: number; y: number },
    drawing: Drawing
  ): void {
    const closing = drawing.tool === 'draw-polygon';
    context.save();
    context.strokeStyle = DRAW_COLOR;
    context.fillStyle = 'rgba(63, 185, 80, 0.14)';
    context.lineWidth = 2;

    const screens = drawing.positions.map((position) => project(position[0], position[1]));
    const live = drawing.cursor ? project(drawing.cursor[0], drawing.cursor[1]) : null;

    if (screens.length > 0) {
      context.beginPath();
      context.moveTo(screens[0].x, screens[0].y);
      for (const screen of screens.slice(1)) context.lineTo(screen.x, screen.y);
      // The rubber-banded segment to the pointer, dashed because it is not
      // placed yet — a solid one reads as a vertex that has been committed.
      if (live) {
        context.stroke();
        context.save();
        context.setLineDash([6, 4]);
        context.beginPath();
        context.moveTo(screens[screens.length - 1].x, screens[screens.length - 1].y);
        context.lineTo(live.x, live.y);
        // A polygon shows the closing edge too, so the shape being committed is
        // visible rather than inferred from a run of corners.
        if (closing && screens.length >= 2) context.lineTo(screens[0].x, screens[0].y);
        context.stroke();
        context.restore();
      } else {
        if (closing && screens.length >= 3) context.closePath();
        context.stroke();
      }
    }

    for (const [index, screen] of screens.entries()) {
      const snapped = drawing.snaps[index] !== null;
      context.beginPath();
      context.arc(screen.x, screen.y, snapped ? 5.5 : 4, 0, Math.PI * 2);
      context.fillStyle = snapped ? SNAP_COLOR : DRAW_COLOR;
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = '#0d1117';
      context.stroke();
    }

    // The snap the pointer is over, marked before the click commits to it.
    if (drawing.hoverSnap) {
      const screen = project(drawing.hoverSnap.position[0], drawing.hoverSnap.position[1]);
      context.beginPath();
      context.strokeStyle = SNAP_COLOR;
      context.lineWidth = 2;
      context.rect(screen.x - 7, screen.y - 7, 14, 14);
      context.stroke();
    }

    context.restore();
  }

  private drawBand(
    context: CanvasRenderingContext2D,
    project: (x: number, y: number) => { x: number; y: number },
    gesture: { from: Position; to: Position }
  ): void {
    const contain = gesture.to[0] >= gesture.from[0];
    const a = project(gesture.from[0], gesture.from[1]);
    const b = project(gesture.to[0], gesture.to[1]);
    context.save();
    context.strokeStyle = contain ? BAND_CONTAIN : BAND_INTERSECT;
    context.fillStyle = contain ? 'rgba(88, 166, 255, 0.12)' : 'rgba(63, 185, 80, 0.12)';
    context.lineWidth = 1.5;
    // Dashed for the crossing band, solid for the window band: the same
    // distinction CAD draws, so the difference is visible before release.
    context.setLineDash(contain ? [] : [5, 4]);
    context.beginPath();
    context.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    context.fill();
    context.stroke();
    context.restore();
  }

  private drawLasso(
    context: CanvasRenderingContext2D,
    project: (x: number, y: number) => { x: number; y: number },
    points: Position[]
  ): void {
    if (points.length < 2) return;
    context.save();
    context.strokeStyle = BAND_INTERSECT;
    context.fillStyle = 'rgba(63, 185, 80, 0.12)';
    context.lineWidth = 1.5;
    context.beginPath();
    for (const [index, position] of points.entries()) {
      const screen = project(position[0], position[1]);
      if (index === 0) context.moveTo(screen.x, screen.y);
      else context.lineTo(screen.x, screen.y);
    }
    // Closed while drawing, because that is the shape the release will test
    // against — showing an open trail would mislead about what will be caught.
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();
  }

  /** The arrow from where the drag started to where it is, with the distance. */
  private drawMoveVector(
    context: CanvasRenderingContext2D,
    project: (x: number, y: number) => { x: number; y: number }
  ): void {
    if (this.gesture?.kind !== 'move') return;
    const a = project(this.gesture.from[0], this.gesture.from[1]);
    const b = project(this.gesture.to[0], this.gesture.to[1]);

    context.save();
    context.strokeStyle = MOVE_GHOST;
    context.fillStyle = MOVE_GHOST;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();

    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    context.beginPath();
    context.moveTo(b.x, b.y);
    context.lineTo(b.x - 10 * Math.cos(angle - 0.4), b.y - 10 * Math.sin(angle - 0.4));
    context.lineTo(b.x - 10 * Math.cos(angle + 0.4), b.y - 10 * Math.sin(angle + 0.4));
    context.closePath();
    context.fill();

    const offset = this.offsetOf(this.gesture);
    context.font = '12px ui-monospace, monospace';
    context.fillStyle = '#ffffff';
    context.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    context.lineWidth = 3;
    const label = `Δ ${format(offset.dx)}, ${format(offset.dy)}`;
    context.strokeText(label, b.x + 10, b.y - 8);
    context.fillText(label, b.x + 10, b.y - 8);
    context.restore();
  }
}

// --------------------------------------------------------------------- helpers

function stop(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function boundsOf(a: Position, b: Position): Bounds {
  return {
    minX: Math.min(a[0], b[0]),
    minY: Math.min(a[1], b[1]),
    maxX: Math.max(a[0], b[0]),
    maxY: Math.max(a[1], b[1]),
  };
}

/**
 * Constrains a drag to the axis it has travelled furthest along.
 *
 * Exported for the tests: an ortho that picks the wrong axis near 45° is the
 * kind of thing that only shows up as "it sometimes jumps sideways".
 */
export function orthogonal(from: Position, to: Position): Position {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  return Math.abs(dx) >= Math.abs(dy) ? [to[0], from[1]] : [from[0], to[1]];
}

function geometryAt(layers: SelectableLayer[], ref: FeatureRef): CirGeometry | null {
  return layers.find((layer) => layer.name === ref.layer)?.features[ref.index]?.geometry ?? null;
}

/** Every geometry the selection covers, whether picked or taken whole. */
function selectedGeometries(selection: Selection, layers: SelectableLayer[]): CirGeometry[] {
  const found: CirGeometry[] = [];
  for (const name of selectedLayers(selection)) {
    const layer = layers.find((candidate) => candidate.name === name);
    if (!layer) continue;
    const scope = scopeFor(selection, name);
    if (scope === null) continue;
    const indices = scope ?? layer.features.map((_, index) => index);
    for (const index of indices) {
      const geometry = layer.features[index]?.geometry;
      if (geometry) found.push(geometry);
    }
  }
  return found;
}

function drawGeometry(
  context: CanvasRenderingContext2D,
  project: (x: number, y: number) => { x: number; y: number },
  geometry: CirGeometry | null,
  offset: MoveOffset | null
): void {
  if (!geometry) return;
  const at = (position: Position): { x: number; y: number } =>
    project(position[0] + (offset?.dx ?? 0), position[1] + (offset?.dy ?? 0));

  const path = (positions: Position[]): void => {
    if (positions.length < 2) return;
    context.beginPath();
    for (const [index, position] of positions.entries()) {
      const screen = at(position);
      if (index === 0) context.moveTo(screen.x, screen.y);
      else context.lineTo(screen.x, screen.y);
    }
    context.stroke();
  };

  switch (geometry.type) {
    case 'Point':
    case 'MultiPoint': {
      const points =
        geometry.type === 'Point' ? [geometry.coordinates as Position] : (geometry.coordinates as Position[]);
      for (const position of points) {
        const screen = at(position);
        context.beginPath();
        context.arc(screen.x, screen.y, 5, 0, Math.PI * 2);
        context.stroke();
      }
      return;
    }
    case 'LineString':
      path(geometry.coordinates as Position[]);
      return;
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of geometry.coordinates as Position[][]) path(ring);
      return;
    case 'MultiPolygon':
      for (const rings of geometry.coordinates as Position[][][]) for (const ring of rings) path(ring);
      return;
    case 'GeometryCollection':
      for (const child of geometry.geometries ?? []) drawGeometry(context, project, child, offset);
      return;
    default:
      return;
  }
}

/** A distance in dataset units, at a precision that suits its size. */
function format(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '0';
  if (magnitude < 0.001) return value.toExponential(3);
  if (magnitude < 1) return value.toFixed(4);
  if (magnitude < 1000) return value.toFixed(3);
  return value.toFixed(1);
}
