/**
 * Dragging a local-grid drawing onto the map.
 *
 * WHY THIS RE-PLACES FROM THE ORIGINAL EVERY TIME
 *
 * The obvious implementation applies each drag to the coordinates it finds and
 * moves on. It is wrong twice over. Numerically, a hundred small drags compound
 * a hundred roundings into the parcel — exactly the silent deformation this
 * whole feature exists to avoid. Structurally, it destroys the only copy of the
 * surveyor's original numbers, so "cancel" has nothing to go back to.
 *
 * So the session keeps the pristine local dataset and a single affine. Every
 * gesture revises the MATRIX and re-places from the original. Drag for an hour
 * and the arithmetic is still one multiplication deep, and abandoning costs
 * nothing because the source was never touched.
 *
 * WHY THE DATASET IS PLACED RATHER THAN DRAWN THROUGH A TRANSFORM
 *
 * The basemap refuses to draw without a CRS it can turn into WGS 84, and it is
 * right to: imagery under a survey at the wrong position is more dangerous than
 * no imagery, because a parcel that does not line up with a convincing map
 * reads as a bad survey rather than a bad basemap. Rather than teach the
 * basemap about provisional placements, the working copy is given the target
 * CRS the moment a session starts. Tiles, fit, measurement and the preview then
 * all work unmodified, because from their point of view the data simply has a
 * CRS now.
 *
 * THE GESTURES
 *
 *   drag          move
 *   Shift + drag  rotate about the drawing's centre
 *   Alt + drag    scale about the drawing's centre
 *
 * Rotation and scale are about the CENTRE, never the grid origin: the origin of
 * a UTM zone is on the equator, and rotating a cadastral sheet about it would
 * throw it several hundred kilometres off screen.
 */

import {
  composeAffine,
  type GeorefSession,
  rotationAffineAbout,
  scaleAffineAbout,
  translationAffine,
} from '../core/georeference-apply';
import type { Position } from '../core/cir';
import type { PreviewCanvas } from './preview';

export type GeorefGesture = 'move' | 'rotate' | 'scale';

export interface GeorefHost {
  /** The session as it stands. Null when no placement is in progress. */
  session(): GeorefSession | null;
  /** Hands back a revised matrix; the host re-places and re-renders. */
  onChange(affine: GeorefSession['affine']): void;
  /** The centre of the drawing as currently placed, in target units. */
  centre(): Position | null;
  /**
   * A click while picking matching points, in TARGET units.
   *
   * The panel decides whether it is the drawing half or the reference half of
   * a pair — the canvas only reports where the pointer went, because which
   * half is expected next is a question about the panel's state, not the
   * canvas's.
   */
  onPick?(position: Position): void;
}

/** Which gesture the modifier keys ask for. */
export function gestureFor(event: { shiftKey: boolean; altKey: boolean }): GeorefGesture {
  if (event.shiftKey) return 'rotate';
  if (event.altKey) return 'scale';
  return 'move';
}

/**
 * The matrix a drag produces, given where it started and where it is now.
 *
 * Pure, and separately tested, because this is where a sign error turns into a
 * drawing that rotates the wrong way under the user's hand — the kind of defect
 * that is obvious in use and invisible in review.
 */
export function gestureAffine(
  gesture: GeorefGesture,
  pivot: Position,
  from: Position,
  to: Position
): GeorefSession['affine'] {
  if (gesture === 'move') {
    return translationAffine(to[0] - from[0], to[1] - from[1]);
  }
  if (gesture === 'rotate') {
    const before = Math.atan2(from[1] - pivot[1], from[0] - pivot[0]);
    const after = Math.atan2(to[1] - pivot[1], to[0] - pivot[0]);
    return rotationAffineAbout(pivot, ((after - before) * 180) / Math.PI);
  }
  // Scale by the ratio of the two radii. A drag that starts on the pivot has no
  // radius to take a ratio from, so it is ignored rather than producing an
  // infinity that would collapse the drawing to a point.
  const radiusBefore = Math.hypot(from[0] - pivot[0], from[1] - pivot[1]);
  const radiusAfter = Math.hypot(to[0] - pivot[0], to[1] - pivot[1]);
  if (radiusBefore === 0 || !Number.isFinite(radiusAfter / radiusBefore)) {
    return { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };
  }
  return scaleAffineAbout(pivot, radiusAfter / radiusBefore);
}

interface Drag {
  gesture: GeorefGesture;
  /** Where the drag began, in target units. */
  from: Position;
  /** The matrix as it was when the drag began — every move recomputes from this. */
  base: GeorefSession['affine'];
  pivot: Position;
}

export class GeorefCanvas {
  private enabled = false;
  private drag: Drag | null = null;
  /** While picking pairs, a click identifies a point instead of starting a drag. */
  private picking = false;

  constructor(
    private readonly preview: PreviewCanvas,
    private readonly host: GeorefHost
  ) {
    const element = this.preview.element;
    element.addEventListener('pointerdown', this.handlePointerDown, { capture: true });
    element.addEventListener('pointermove', this.handlePointerMove, { capture: true });
    element.addEventListener('pointerup', this.handlePointerUp, { capture: true });
    element.addEventListener('pointercancel', this.handlePointerUp, { capture: true });
  }

  /**
   * Turns point-picking on or off.
   *
   * Picking and dragging are mutually exclusive by construction rather than by
   * convention: a click that is meant to identify a control point must not also
   * shove the drawing sideways, which is exactly what would happen if both
   * lived on the same pointerdown.
   */
  setPicking(picking: boolean): void {
    this.picking = picking;
    this.drag = null;
  }

  isPicking(): boolean {
    return this.picking;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.drag = null;
    if (!enabled) this.picking = false;
    if (enabled) this.reattach();
    else if (this.preview.onOverlay) this.preview.onOverlay = undefined;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Re-claims the canvas's single overlay hook, as the other engines do. */
  reattach(): void {
    this.preview.onOverlay = (context, project) => this.draw(context, project);
  }

  /** Screen pixels to target-CRS units. `offsetX/Y` are already canvas-relative. */
  private world(event: PointerEvent): Position | null {
    const point = this.preview.unproject(event.offsetX, event.offsetY);
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? [point.x, point.y] : null;
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.enabled || event.button !== 0) return;
    const session = this.host.session();
    const pivot = this.host.centre();
    const from = this.world(event);
    if (!session || !pivot || !from) return;

    event.preventDefault();
    event.stopPropagation();

    if (this.picking) {
      this.host.onPick?.(from);
      return;
    }

    this.drag = { gesture: gestureFor(event), from, base: session.affine, pivot };
    this.preview.element.setPointerCapture?.(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.enabled || !this.drag) return;
    const to = this.world(event);
    if (!to) return;
    event.preventDefault();
    event.stopPropagation();
    // Always from `base`, never from the live matrix: compounding every move
    // would accumulate rounding into the parcel.
    const step = gestureAffine(this.drag.gesture, this.drag.pivot, this.drag.from, to);
    this.host.onChange(composeAffine(step, this.drag.base));
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.drag) return;
    this.preview.element.releasePointerCapture?.(event.pointerId);
    this.drag = null;
  };

  /** Draws the pivot, so the user can see what a rotation will turn about. */
  private draw(context: CanvasRenderingContext2D, project: (x: number, y: number) => { x: number; y: number }): void {
    const centre = this.host.centre();
    if (!centre) return;
    const { x, y } = project(centre[0], centre[1]);
    context.save();
    context.strokeStyle = '#0f766e';
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(x, y, 9, 0, Math.PI * 2);
    context.moveTo(x - 14, y);
    context.lineTo(x + 14, y);
    context.moveTo(x, y - 14);
    context.lineTo(x, y + 14);
    context.stroke();
    context.restore();
  }
}
