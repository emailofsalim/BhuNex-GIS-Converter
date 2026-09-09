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

export type CanvasTool = 'select' | 'lasso' | 'move';

export const TOOL_LABEL: Record<CanvasTool, string> = {
  select: 'Select',
  lasso: 'Lasso',
  move: 'Move',
};

export const TOOL_HINT: Record<CanvasTool, string> = {
  select:
    'Click a feature to select it, Shift-click to add or remove. Drag from empty space for a rubber band — left to right takes only what is wholly inside, right to left takes anything it touches. Drag from a selected feature to move the whole selection.',
  lasso: 'Draw a freehand outline around the features to select. Shift adds to the selection instead of replacing it.',
  move: 'Drag anywhere to move the current selection. Hold Shift to constrain to one axis.',
};

/** Pick radius in screen pixels — constant to the finger at any zoom. */
const PICK_RADIUS_PX = 8;

/** A drag shorter than this is a click that wobbled, not a move. */
const DRAG_THRESHOLD_PX = 3;

const SELECTED_COLOR = '#f5b041';
const BAND_CONTAIN = '#58a6ff';
const BAND_INTERSECT = '#3fb950';
const MOVE_GHOST = '#f5b041';

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

export class ToolCanvas {
  private tool: CanvasTool = 'select';
  private gesture: Gesture | null = null;
  private hover: FeatureRef | null = null;
  private enabled = false;
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
    // half-drawn lasso into the move tool would apply it as something else.
    this.gesture = null;
    this.preview.element.style.cursor = this.cursorFor(tool);
    this.host.onToolChange?.(tool);
    this.host.onStatus?.(TOOL_HINT[tool]);
    this.preview.render();
  }

  getTool(): CanvasTool {
    return this.tool;
  }

  dispose(): void {
    const element = this.preview.element;
    element.removeEventListener('pointerdown', this.handlePointerDown, { capture: true });
    element.removeEventListener('pointermove', this.handlePointerMove, { capture: true });
    element.removeEventListener('pointerup', this.handlePointerUp, { capture: true });
    element.removeEventListener('pointercancel', this.handlePointerCancel, { capture: true });
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

  private handlePointerCancel = (): void => {
    // A cancelled pointer — the browser taking over, a palm rejected — must not
    // commit a half-finished drag as if it were released deliberately.
    if (!this.gesture) return;
    this.gesture = null;
    this.preview.render();
  };

  private handleKey(event: KeyboardEvent): void {
    if (!this.enabled) return;
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;

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
