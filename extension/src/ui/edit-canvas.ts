/**
 * The editing interaction layer (spec §25.1, §25.2).
 *
 * `core/vertex-edit.ts` decides what an edit does and whether it is allowed;
 * `qa/snap.ts` decides where a dragged vertex lands. This is the part that
 * turns a pointer into one of those calls: hit testing, handles, drag, and the
 * hover feedback that tells someone what they are about to grab.
 *
 * It deliberately owns no geometry. Every change goes out through `onEdit` as a
 * plan the host applies, so the undo history records it and the refusals in the
 * editor still apply. An interaction layer that mutated the dataset directly
 * would be a second, unguarded way to change survey data.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PICK RADIUS IS IN PIXELS
 *
 * Hit testing in world units breaks at both ends of the zoom range: eight
 * metres is the whole parcel when zoomed out and invisible when zoomed in. A
 * pixel radius converted to world units through the current scale is constant
 * on screen, which is where the finger actually is.
 *
 * ---------------------------------------------------------------------------
 * DRAGGING DOES NOT COMMIT UNTIL RELEASE
 *
 * The drag draws a preview and reports the live position, but the dataset is
 * not touched until the pointer comes up. Committing per pointermove would put
 * sixty entries in the undo history for one drag, and undoing a mistake would
 * take sixty presses.
 */

import type { Position } from '../core/cir';
import type { PreviewCanvas } from './preview';
import type { VertexRef } from '../core/vertex-edit';

/** The feature currently open for editing, flattened to rings. */
export interface EditTarget {
  layer: string;
  featureIndex: number;
  /** Rings in the order `VertexRef.ring` indexes them. */
  rings: Position[][];
}

export interface PickResult {
  ref: VertexRef;
  position: Position;
  /** Distance from the pointer, in world units. */
  distance: number;
}

/** A point on a segment, for insert-on-segment. */
export interface SegmentPick {
  /** The vertex the segment starts at. */
  ref: VertexRef;
  at: Position;
  distance: number;
}

export interface EditHost {
  /** Commit a vertex move. Called once, on pointer release. */
  onMoveVertex: (ref: VertexRef, to: Position) => void;
  /** Commit a multi-selection drag. Called once, on pointer release. */
  onMoveMany: (refs: VertexRef[], offset: { dx: number; dy: number }) => void;
  /** Insert a vertex on the segment starting at `ref`. */
  onInsertVertex: (ref: VertexRef, at: Position) => void;
  /** Delete the selected vertices. */
  onDeleteVertices: (refs: VertexRef[]) => void;
  /** Selection changed, so the readout panel can follow it. */
  onSelectionChange: (refs: VertexRef[]) => void;
  /**
   * Where a dragged vertex should actually land.
   *
   * The host supplies this so snapping stays in `qa/snap.ts` rather than being
   * reimplemented here. Returning the input unchanged means no snapping.
   */
  snap?: (ref: VertexRef, to: Position) => Position;
  /** Live position during a drag, for the readout. */
  onDragPosition?: (position: Position) => void;
}

/** Pick radius in screen pixels — constant to the finger at any zoom. */
const PICK_RADIUS_PX = 10;

const HANDLE_COLOR = '#58a6ff';
const HANDLE_SELECTED = '#f5b041';
const HANDLE_HOVER = '#ffffff';
const SEGMENT_HINT = '#3fb950';

export class EditCanvas {
  private target: EditTarget | null = null;
  private selection: VertexRef[] = [];
  private hover: PickResult | null = null;
  private segmentHint: SegmentPick | null = null;

  /** Set while a drag is in progress; null otherwise. */
  private drag: {
    ref: VertexRef;
    start: Position;
    current: Position;
    /** Every ref moving together, for a multi-selection drag. */
    refs: VertexRef[];
    moved: boolean;
  } | null = null;

  private enabled = false;
  private readonly onKeyDown: (event: KeyboardEvent) => void;

  constructor(
    private readonly preview: PreviewCanvas,
    private readonly host: EditHost
  ) {
    this.preview.onOverlay = (context, project) => this.draw(context, project);

    const element = this.preview.element;
    element.addEventListener('pointerdown', this.handlePointerDown, { capture: true });
    element.addEventListener('pointermove', this.handlePointerMove, { capture: true });
    element.addEventListener('pointerup', this.handlePointerUp, { capture: true });

    this.onKeyDown = (event) => this.handleKey(event);
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** Turns editing on or off. Off restores plain pan-and-zoom. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.selection = [];
      this.hover = null;
      this.segmentHint = null;
      this.drag = null;
      this.host.onSelectionChange([]);
    }
    this.preview.element.style.cursor = enabled ? 'crosshair' : '';
    this.preview.render();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Opens a feature for editing, or closes the editor with null. */
  setTarget(target: EditTarget | null): void {
    this.target = target;
    this.selection = [];
    this.hover = null;
    this.drag = null;
    this.host.onSelectionChange([]);
    this.preview.render();
  }

  getSelection(): VertexRef[] {
    return this.selection;
  }

  dispose(): void {
    const element = this.preview.element;
    element.removeEventListener('pointerdown', this.handlePointerDown, { capture: true });
    element.removeEventListener('pointermove', this.handlePointerMove, { capture: true });
    element.removeEventListener('pointerup', this.handlePointerUp, { capture: true });
    window.removeEventListener('keydown', this.onKeyDown);
    this.preview.onOverlay = undefined;
  }

  // ------------------------------------------------------------- hit testing

  /** Nearest vertex to a world position, within the pick radius. */
  pickVertex(world: { x: number; y: number }): PickResult | null {
    if (!this.target) return null;
    const radius = PICK_RADIUS_PX * this.preview.unitsPerPixel;
    let best: PickResult | null = null;

    for (const [ringIndex, ring] of this.target.rings.entries()) {
      // A closed ring stores its first vertex twice. Only the first copy is
      // pickable, so clicking the shared corner cannot select "the other one"
      // and leave the user wondering why their drag moved nothing.
      const closed = isClosed(ring);
      const limit = closed ? ring.length - 1 : ring.length;

      for (let vertexIndex = 0; vertexIndex < limit; vertexIndex++) {
        const position = ring[vertexIndex];
        const gap = Math.hypot(position[0] - world.x, position[1] - world.y);
        if (gap > radius) continue;
        if (!best || gap < best.distance) {
          best = {
            ref: { layer: this.target.layer, featureIndex: this.target.featureIndex, ring: ringIndex, vertex: vertexIndex },
            position,
            distance: gap,
          };
        }
      }
    }

    return best;
  }

  /** Nearest point on a segment, for insert-on-segment. */
  pickSegment(world: { x: number; y: number }): SegmentPick | null {
    if (!this.target) return null;
    const radius = PICK_RADIUS_PX * this.preview.unitsPerPixel;
    let best: SegmentPick | null = null;

    for (const [ringIndex, ring] of this.target.rings.entries()) {
      for (let index = 0; index < ring.length - 1; index++) {
        const projected = closestOnSegment([world.x, world.y], ring[index], ring[index + 1]);
        if (projected.distance > radius) continue;
        if (!best || projected.distance < best.distance) {
          best = {
            ref: { layer: this.target.layer, featureIndex: this.target.featureIndex, ring: ringIndex, vertex: index },
            at: projected.point,
            distance: projected.distance,
          };
        }
      }
    }

    return best;
  }

  // ------------------------------------------------------------- interaction

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.enabled || !this.target || event.button !== 0) return;

    const world = this.preview.unproject(event.offsetX, event.offsetY);
    const picked = this.pickVertex(world);

    // Alt-click on a segment inserts. Checked before the vertex pick would
    // otherwise win, since the two targets overlap near a corner.
    if (event.altKey) {
      const segment = this.pickSegment(world);
      if (segment) {
        stop(event);
        this.host.onInsertVertex(segment.ref, segment.at);
      }
      return;
    }

    if (!picked) {
      // A click on empty space clears the selection rather than starting a
      // drag — and does NOT stop the event, so the canvas still pans.
      if (this.selection.length > 0) {
        this.selection = [];
        this.host.onSelectionChange([]);
        this.preview.render();
      }
      return;
    }

    // From here the pointer belongs to the editor, not to panning.
    stop(event);
    this.preview.element.setPointerCapture(event.pointerId);

    if (event.shiftKey) {
      this.selection = toggle(this.selection, picked.ref);
    } else if (!this.selection.some((ref) => sameRef(ref, picked.ref))) {
      this.selection = [picked.ref];
    }
    this.host.onSelectionChange(this.selection);

    this.drag = {
      ref: picked.ref,
      start: picked.position,
      current: picked.position,
      // Dragging a vertex that is part of the selection drags the whole
      // selection; dragging one outside it drags only that vertex.
      refs: this.selection.some((ref) => sameRef(ref, picked.ref)) ? this.selection : [picked.ref],
      moved: false,
    };
    this.preview.render();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.enabled || !this.target) return;
    const world = this.preview.unproject(event.offsetX, event.offsetY);

    if (this.drag) {
      stop(event);
      const raw: Position = [world.x, world.y];
      const snapped = this.host.snap ? this.host.snap(this.drag.ref, raw) : raw;
      this.drag.current = snapped;
      this.drag.moved = true;
      this.host.onDragPosition?.(snapped);
      this.preview.render();
      return;
    }

    // Hover feedback: a vertex if one is near, otherwise a segment when Alt is
    // held, so the insert target is visible before the click commits it.
    const previousHover = this.hover?.ref;
    this.hover = this.pickVertex(world);
    this.segmentHint = this.hover ? null : event.altKey ? this.pickSegment(world) : null;

    this.preview.element.style.cursor = this.hover ? 'grab' : this.segmentHint ? 'copy' : 'crosshair';
    if (!sameRefOrNull(previousHover, this.hover?.ref) || this.segmentHint) this.preview.render();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.drag) return;
    stop(event);
    this.preview.element.releasePointerCapture(event.pointerId);

    const drag = this.drag;
    this.drag = null;

    // A click that did not move is a selection, not an edit. Committing a
    // zero-length move would put a no-op in the undo history.
    if (!drag.moved) {
      this.preview.render();
      return;
    }

    if (drag.refs.length > 1) {
      this.host.onMoveMany(drag.refs, {
        dx: drag.current[0] - drag.start[0],
        dy: drag.current[1] - drag.start[1],
      });
    } else {
      this.host.onMoveVertex(drag.ref, drag.current);
    }
  };

  private handleKey(event: KeyboardEvent): void {
    if (!this.enabled || this.selection.length === 0) return;
    // Never steal a key from a text field the user is typing in.
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.host.onDeleteVertices(this.selection);
    } else if (event.key === 'Escape') {
      this.selection = [];
      this.host.onSelectionChange([]);
      this.preview.render();
    }
  }

  // ------------------------------------------------------------- drawing

  private draw(context: CanvasRenderingContext2D, project: (x: number, y: number) => { x: number; y: number }): void {
    if (!this.enabled || !this.target) return;
    context.save();

    // The dragged geometry, previewed in place before it is committed.
    if (this.drag) this.drawDragPreview(context, project);

    for (const [ringIndex, ring] of this.target.rings.entries()) {
      const closed = isClosed(ring);
      const limit = closed ? ring.length - 1 : ring.length;

      for (let vertexIndex = 0; vertexIndex < limit; vertexIndex++) {
        const ref = { layer: this.target.layer, featureIndex: this.target.featureIndex, ring: ringIndex, vertex: vertexIndex };
        const dragging = this.drag?.refs.some((candidate) => sameRef(candidate, ref)) ?? false;
        const position = dragging ? this.offsetForDrag(ring[vertexIndex]) : ring[vertexIndex];
        const screen = project(position[0], position[1]);

        const selected = this.selection.some((candidate) => sameRef(candidate, ref));
        const hovered = this.hover ? sameRef(this.hover.ref, ref) : false;

        context.beginPath();
        context.arc(screen.x, screen.y, selected || hovered ? 5.5 : 4, 0, Math.PI * 2);
        context.fillStyle = selected ? HANDLE_SELECTED : hovered ? HANDLE_HOVER : HANDLE_COLOR;
        context.fill();
        context.lineWidth = 1.5;
        context.strokeStyle = '#0d1117';
        context.stroke();
      }
    }

    if (this.segmentHint) {
      const screen = project(this.segmentHint.at[0], this.segmentHint.at[1]);
      context.beginPath();
      context.arc(screen.x, screen.y, 5, 0, Math.PI * 2);
      context.strokeStyle = SEGMENT_HINT;
      context.lineWidth = 2;
      context.stroke();
      // A cross, so an insert target reads differently from a vertex handle at
      // a glance rather than only by colour.
      context.beginPath();
      context.moveTo(screen.x - 8, screen.y);
      context.lineTo(screen.x + 8, screen.y);
      context.moveTo(screen.x, screen.y - 8);
      context.lineTo(screen.x, screen.y + 8);
      context.stroke();
    }

    context.restore();
  }

  /** Where a vertex sits mid-drag, offset by however far the pointer has come. */
  private offsetForDrag(position: Position): Position {
    if (!this.drag) return position;
    return [
      position[0] + (this.drag.current[0] - this.drag.start[0]),
      position[1] + (this.drag.current[1] - this.drag.start[1]),
    ];
  }

  /** The dragged ring, drawn dashed in its proposed position. */
  private drawDragPreview(context: CanvasRenderingContext2D, project: (x: number, y: number) => { x: number; y: number }): void {
    if (!this.target || !this.drag) return;
    const moving = new Set(this.drag.refs.map((ref) => `${ref.ring}/${ref.vertex}`));

    context.save();
    context.strokeStyle = HANDLE_SELECTED;
    context.lineWidth = 1.8;
    context.setLineDash([5, 4]);

    for (const [ringIndex, ring] of this.target.rings.entries()) {
      if (!ring.some((_, vertexIndex) => moving.has(`${ringIndex}/${vertexIndex}`))) continue;

      context.beginPath();
      for (const [vertexIndex, position] of ring.entries()) {
        const closed = isClosed(ring);
        // The duplicated endpoint follows the first vertex, so a dragged corner
        // does not tear the ring open in the preview either.
        const key = closed && vertexIndex === ring.length - 1 ? `${ringIndex}/0` : `${ringIndex}/${vertexIndex}`;
        const drawn = moving.has(key) ? this.offsetForDrag(position) : position;
        const screen = project(drawn[0], drawn[1]);
        if (vertexIndex === 0) context.moveTo(screen.x, screen.y);
        else context.lineTo(screen.x, screen.y);
      }
      context.stroke();
    }

    context.restore();
  }
}

// --------------------------------------------------------------- helpers

function stop(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function sameRef(left: VertexRef, right: VertexRef): boolean {
  return (
    left.layer === right.layer &&
    left.featureIndex === right.featureIndex &&
    left.ring === right.ring &&
    left.vertex === right.vertex
  );
}

function sameRefOrNull(left: VertexRef | undefined, right: VertexRef | undefined): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return sameRef(left, right);
}

function toggle(selection: VertexRef[], ref: VertexRef): VertexRef[] {
  return selection.some((candidate) => sameRef(candidate, ref))
    ? selection.filter((candidate) => !sameRef(candidate, ref))
    : [...selection, ref];
}

function isClosed(ring: Position[]): boolean {
  return ring.length > 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
}

function closestOnSegment(point: Position, start: Position, end: Position): { point: Position; distance: number } {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { point: start, distance: Math.hypot(point[0] - start[0], point[1] - start[1]) };

  let t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const projected: Position = [start[0] + t * dx, start[1] + t * dy];
  return { point: projected, distance: Math.hypot(point[0] - projected[0], point[1] - projected[1]) };
}

/** Flattens a feature's geometry into the rings an `EditTarget` carries. */
export function editTargetFor(layer: string, featureIndex: number, geometry: any): EditTarget | null {
  if (!geometry) return null;
  switch (geometry.type) {
    case 'LineString':
      return { layer, featureIndex, rings: [geometry.coordinates] };
    case 'MultiLineString':
    case 'Polygon':
      return { layer, featureIndex, rings: geometry.coordinates };
    case 'MultiPolygon':
      return { layer, featureIndex, rings: (geometry.coordinates as Position[][][]).flat() };
    default:
      // Points have nothing to edit vertex-wise, and a GeometryCollection has
      // no stable ring order to address — refusing is better than an editor
      // whose indices mean something different from the engine's.
      return null;
  }
}
