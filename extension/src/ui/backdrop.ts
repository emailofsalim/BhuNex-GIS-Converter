/**
 * An imported image or scanned sheet drawn under the canvas (phase G).
 *
 * The basemap's sibling, and deliberately a separate class rather than a mode
 * of it. They look alike on screen and are opposites underneath:
 *
 *   BASEMAP    remote, tiled, needs a network and a CRS it can place, and is
 *              authoritative about position when it draws at all.
 *   BACKDROP   local, one image, needs no network ever, and may be placed by a
 *              route that fixes scale and rotation while knowing NOTHING about
 *              absolute position.
 *
 * Folding them together would mean one `usable` covering two different sets of
 * conditions, and one draw path in which "not georeferenced" was a flag rather
 * than a type. `core/georeference.ts` keeps that distinction in the return
 * type; this keeps it on screen, by drawing a placed-but-not-georeferenced
 * backdrop with a visible border and saying so.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IMAGE IS DRAWN THROUGH THE AFFINE RATHER THAN INTO A BOX
 *
 * A georeferenced scan is rotated, and usually sheared a little — paper
 * stretches and scanners stretch it further along the feed direction. Drawing
 * it into an axis-aligned rectangle would throw both away, and the result would
 * line up at the middle and be metres out at the corners, which is the worst
 * possible failure mode: convincing everywhere the user looks first.
 */

import { applyAffine, type Affine } from '../core/georeference';
import type { PreviewCanvas } from './preview';

export interface BackdropSource {
  /** The decoded image. */
  image: CanvasImageSource;
  width: number;
  height: number;
  /** What it came from, for the panel. */
  label: string;
  /** Which PDF page, when it came from one. */
  page?: number;
}

export interface BackdropPlacement {
  affine: Affine;
  /**
   * False for a two-point scale, which fixes scale and rotation only.
   *
   * A backdrop that is not georeferenced is a TRACING AID. Coordinates read
   * from it mean nothing, and the tool says so rather than letting a scanned
   * sheet's authority stand in for a georeference it does not have.
   */
  georeferenced: boolean;
}

export class Backdrop {
  private source: BackdropSource | null = null;
  private placement: BackdropPlacement | null = null;
  private opacity = 0.75;

  constructor(private readonly preview: PreviewCanvas) {}

  setSource(source: BackdropSource | null): void {
    this.source = source;
    // A new image with the old placement would draw the new sheet through the
    // previous one's transform — plausible-looking and completely wrong.
    if (!source) this.placement = null;
    this.preview.render();
  }

  setPlacement(placement: BackdropPlacement | null): void {
    this.placement = placement;
    this.preview.render();
  }

  setOpacity(value: number): void {
    this.opacity = Math.max(0.05, Math.min(1, value));
    this.preview.render();
  }

  getSource(): BackdropSource | null {
    return this.source;
  }

  get usable(): boolean {
    return this.source !== null && this.placement !== null;
  }

  /** True when the backdrop is placed but its position means nothing. */
  get placedOnly(): boolean {
    return this.usable && this.placement!.georeferenced === false;
  }

  /**
   * Draws the image under everything else.
   *
   * The affine maps IMAGE PIXELS to WORLD coordinates, and `project` maps world
   * to screen. Composing them gives pixels to screen, which is exactly what
   * `setTransform` wants — so the image is drawn once, at 1:1, through a matrix
   * that does all the work. Sampling it manually would be slower and would lose
   * the browser's own interpolation.
   */
  draw(context: CanvasRenderingContext2D, project: (x: number, y: number) => { x: number; y: number }): void {
    if (!this.source || !this.placement) return;

    // Three corners are enough to define the composed affine, and they are
    // taken through the same `project` the geometry uses — so the backdrop
    // cannot drift from the data by a transform they do not share.
    const origin = screenOf(this.placement.affine, project, 0, 0);
    const alongU = screenOf(this.placement.affine, project, 1, 0);
    const alongV = screenOf(this.placement.affine, project, 0, 1);

    const matrix = {
      a: alongU.x - origin.x,
      b: alongU.y - origin.y,
      c: alongV.x - origin.x,
      d: alongV.y - origin.y,
      e: origin.x,
      f: origin.y,
    };
    if (!Number.isFinite(matrix.a) || !Number.isFinite(matrix.d)) return;
    // A degenerate matrix draws nothing rather than throwing. It happens when
    // the view is zoomed so far out that a pixel maps to sub-float distances.
    if (matrix.a === 0 && matrix.b === 0 && matrix.c === 0 && matrix.d === 0) return;

    context.save();
    context.globalAlpha = this.opacity;
    context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    context.imageSmoothingEnabled = true;
    try {
      context.drawImage(this.source.image, 0, 0, this.source.width, this.source.height);
    } catch {
      // A detached ImageBitmap, or a source the canvas will not take. Nothing
      // is drawn; the panel already knows what it loaded.
    }
    context.restore();

    // A dashed border on a placed-but-not-georeferenced sheet, so its status is
    // visible on the canvas and not only in a panel the user has scrolled past.
    if (this.placement.georeferenced === false) {
      const corners = [
        screenOf(this.placement.affine, project, 0, 0),
        screenOf(this.placement.affine, project, this.source.width, 0),
        screenOf(this.placement.affine, project, this.source.width, this.source.height),
        screenOf(this.placement.affine, project, 0, this.source.height),
      ];
      context.save();
      context.strokeStyle = '#d29922';
      context.lineWidth = 2;
      context.setLineDash([8, 5]);
      context.beginPath();
      context.moveTo(corners[0].x, corners[0].y);
      for (const corner of corners.slice(1)) context.lineTo(corner.x, corner.y);
      context.closePath();
      context.stroke();
      context.restore();
    }
  }
}

function screenOf(
  affine: Affine,
  project: (x: number, y: number) => { x: number; y: number },
  u: number,
  v: number
): { x: number; y: number } {
  const [x, y] = applyAffine(affine, u, v);
  return project(x, y);
}
