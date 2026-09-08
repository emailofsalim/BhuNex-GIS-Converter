/**
 * The measuring interaction layer (spec §26.1).
 *
 * `core/measure.ts` decides what a distance, an area or a bearing IS — and,
 * critically, which arithmetic the CRS calls for. This file is only the part
 * that turns clicks into positions and draws what has been clicked. It computes
 * nothing itself, for the same reason `ui/edit-canvas.ts` owns no geometry: a
 * second implementation of "how long is this" is a second answer, and the two
 * disagree the first time a geographic dataset is opened.
 *
 * ---------------------------------------------------------------------------
 * WHY CLICK-TO-ADD RATHER THAN DRAG
 *
 * A drag measures exactly two points, and a traverse leg is rarely the thing
 * being measured — a boundary run, a road frontage and a parcel are all
 * polylines. Clicking adds a vertex, double-clicking or Escape ends the run,
 * and the running total updates on every click, which is what a tape does.
 *
 * Drag is still pan, because taking pan away from the canvas to add measuring
 * would trade a thing people use constantly for a thing they use occasionally.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SEGMENT LABELS ARE DRAWN AND NOT JUST THE TOTAL
 *
 * The number an engineer needs to check against a plan is usually a single
 * leg, not the sum. A tool that reports only the total makes them measure each
 * leg separately to find the one that disagrees.
 */

import type { Position } from '../core/cir';
import type { PreviewCanvas } from './preview';

export type MeasureMode = 'off' | 'distance' | 'area';

export interface MeasureHost {
  /** The run changed: a point was added, removed, or the run was cleared. */
  onChange: (points: Position[], closed: boolean) => void;
}

/** How near a click must be to the first point to close a ring, in pixels. */
const CLOSE_RADIUS_PX = 10;

export class MeasureCanvas {
  private mode: MeasureMode = 'off';
  private points: Position[] = [];
  /** Set when an area run has been closed back onto its first point. */
  private closed = false;
  /** Where the pointer is, so the pending segment can be rubber-banded. */
  private cursor: Position | null = null;

  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly onPointerDown: (event: PointerEvent) => void;
  private readonly onPointerMove: (event: PointerEvent) => void;
  private readonly onDoubleClick: (event: MouseEvent) => void;

  constructor(
    private readonly preview: PreviewCanvas,
    private readonly host: MeasureHost
  ) {
    this.preview.onOverlay = (context, project) => this.draw(context, project);

    this.onPointerDown = (event) => this.handlePointerDown(event);
    this.onPointerMove = (event) => this.handlePointerMove(event);
    this.onDoubleClick = (event) => this.handleDoubleClick(event);
    this.onKeyDown = (event) => this.handleKey(event);

    const element = this.preview.element;
    element.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    element.addEventListener('pointermove', this.onPointerMove, { capture: true });
    element.addEventListener('dblclick', this.onDoubleClick, { capture: true });
    window.addEventListener('keydown', this.onKeyDown);
  }

  /**
   * Re-claims the canvas's single overlay hook. See `EditCanvas.reattach`:
   * three tools share one hook so that a stale one cannot keep drawing.
   */
  reattach(): void {
    this.preview.onOverlay = (context, project) => this.draw(context, project);
  }

  setMode(mode: MeasureMode): void {
    this.mode = mode;
    if (mode === 'off') this.clear();
    this.preview.element.style.cursor = mode === 'off' ? '' : 'crosshair';
    this.preview.render();
  }

  getMode(): MeasureMode {
    return this.mode;
  }

  clear(): void {
    this.points = [];
    this.closed = false;
    this.cursor = null;
    this.host.onChange([], false);
    this.preview.render();
  }

  /** Removes the last point. Undo for a misplaced click, which is every third one. */
  undoPoint(): void {
    if (this.points.length === 0) return;
    this.points = this.points.slice(0, -1);
    this.closed = false;
    this.host.onChange([...this.points], false);
    this.preview.render();
  }

  dispose(): void {
    const element = this.preview.element;
    element.removeEventListener('pointerdown', this.onPointerDown, { capture: true } as EventListenerOptions);
    element.removeEventListener('pointermove', this.onPointerMove, { capture: true } as EventListenerOptions);
    element.removeEventListener('dblclick', this.onDoubleClick, { capture: true } as EventListenerOptions);
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.preview.onOverlay) this.preview.onOverlay = undefined;
  }

  // ---------------------------------------------------------------- pointer

  private worldAt(event: { clientX: number; clientY: number }): Position {
    const rect = this.preview.element.getBoundingClientRect();
    const point = this.preview.unproject(event.clientX - rect.left, event.clientY - rect.top);
    return [point.x, point.y];
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.mode === 'off' || event.button !== 0) return;

    // A completed area run starts a new one rather than growing the old one:
    // the alternative is a click that silently reopens a closed ring.
    if (this.closed) {
      this.points = [];
      this.closed = false;
    }

    const position = this.worldAt(event);

    // Closing an area run by clicking its first point again is the gesture
    // every drawing tool uses, so it is the one people try first.
    if (this.mode === 'area' && this.points.length >= 3 && this.nearFirst(event)) {
      this.closed = true;
      this.cursor = null;
      event.preventDefault();
      event.stopPropagation();
      this.host.onChange([...this.points], true);
      this.preview.render();
      return;
    }

    this.points.push(position);
    // Stopping propagation keeps the click from also starting a pan, which
    // would drag the map out from under the point just placed.
    event.preventDefault();
    event.stopPropagation();
    this.host.onChange([...this.points], false);
    this.preview.render();
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.mode === 'off' || this.points.length === 0 || this.closed) return;
    this.cursor = this.worldAt(event);
    this.preview.render();
  }

  private handleDoubleClick(event: MouseEvent): void {
    if (this.mode === 'off') return;
    event.preventDefault();
    event.stopPropagation();
    // The double-click's second press already added a duplicate point.
    if (this.points.length >= 2) {
      const last = this.points[this.points.length - 1];
      const previous = this.points[this.points.length - 2];
      if (last[0] === previous[0] && last[1] === previous[1]) this.points.pop();
    }
    if (this.mode === 'area' && this.points.length >= 3) this.closed = true;
    this.cursor = null;
    this.host.onChange([...this.points], this.closed);
    this.preview.render();
  }

  private handleKey(event: KeyboardEvent): void {
    if (this.mode === 'off') return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      this.clear();
      return;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      this.undoPoint();
    }
  }

  private nearFirst(event: PointerEvent): boolean {
    const first = this.points[0];
    const rect = this.preview.element.getBoundingClientRect();
    const screen = this.preview.project(first[0], first[1]);
    return Math.hypot(screen.x - (event.clientX - rect.left), screen.y - (event.clientY - rect.top)) <= CLOSE_RADIUS_PX;
  }

  // ---------------------------------------------------------------- drawing

  private draw(context: CanvasRenderingContext2D, project: (x: number, y: number) => { x: number; y: number }): void {
    if (this.mode === 'off' || this.points.length === 0) return;

    const screen = this.points.map((position) => project(position[0], position[1]));
    const pending = this.cursor && !this.closed ? project(this.cursor[0], this.cursor[1]) : null;

    context.save();

    if (this.mode === 'area' && (this.closed || screen.length > 2)) {
      context.beginPath();
      screen.forEach((point, index) => (index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)));
      if (pending) context.lineTo(pending.x, pending.y);
      context.closePath();
      context.fillStyle = 'rgba(88, 166, 255, 0.16)';
      context.fill();
    }

    context.strokeStyle = '#58a6ff';
    context.lineWidth = 2;
    context.setLineDash([]);
    context.beginPath();
    screen.forEach((point, index) => (index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)));
    context.stroke();

    if (pending) {
      context.beginPath();
      context.setLineDash([4, 4]);
      const last = screen[screen.length - 1];
      context.moveTo(last.x, last.y);
      context.lineTo(pending.x, pending.y);
      context.stroke();
      context.setLineDash([]);
    }

    // Handles. The first is drawn larger in area mode because it is the one
    // that has to be hit to close the ring.
    context.fillStyle = '#0d1117';
    for (const [index, point] of screen.entries()) {
      const radius = this.mode === 'area' && index === 0 && !this.closed ? 6 : 4;
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }

    context.restore();
  }
}
