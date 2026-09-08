/**
 * Clipping a raster to a boundary, and cropping it to an extent (spec §16).
 *
 * The delivery problem this solves: a survey office receives a DEM or an
 * orthophoto covering a whole district and has to hand back only the site. Sent
 * whole, the file is a hundred times larger than the job needs, and it contains
 * data for land the client has no business holding.
 *
 * ---------------------------------------------------------------------------
 * CLIPPING SETS PIXELS TO NO-DATA. IT DOES NOT DELETE THEM.
 *
 * A raster is a rectangle. A site boundary is not, so "clip to this polygon"
 * cannot mean "make the raster that shape" — there is no such raster. What it
 * means is: crop the rectangle to the boundary's extent, and inside that
 * rectangle set every pixel outside the boundary to no-data.
 *
 * Which is why a clip REQUIRES a no-data value and refuses without one. Filling
 * with zero instead is the tempting shortcut and it is wrong twice over: zero is
 * a real elevation at sea level, and a zero-filled DEM produces a cliff around
 * the site boundary that every contour, slope and hillshade will then honour as
 * if it were ground.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PIXEL CENTRE DECIDES
 *
 * A pixel is an area, and the boundary cuts through some of them. Three answers
 * are defensible — keep a pixel if its centre is inside, if any part is inside,
 * or weight it by the fraction covered — and they disagree by one pixel all
 * round the edge.
 *
 * The centre rule is used, because it is what a resampled raster means: the
 * value samples the surface AT THAT POINT. Weighting by area would be right for
 * a categorical raster being aggregated and is wrong here, where averaging an
 * elevation with a no-data neighbour invents a slope. `touched` is offered for
 * the case where losing the boundary pixel matters more than gaining a partial
 * one, and it says which it did.
 */

import type { Bounds, CirRaster, Position, Warning } from '../../core/cir';
import { pointInRing } from '../../core/geometry';

export interface ClipOptions {
  /**
   * Rings to clip to: shell first, then holes, per polygon.
   *
   * In the raster's own coordinates. Reprojecting the boundary is the caller's
   * job — doing it here would hide a datum shift inside what looks like a crop.
   */
  polygons: Position[][][];
  /**
   * Keep a pixel whose centre is outside the boundary but whose area is partly
   * inside. Wider by up to one pixel all round; narrower is the default.
   */
  touched?: boolean;
  /**
   * Value for pixels outside the boundary. Falls back to the raster's own
   * no-data, and the operation is refused when neither exists.
   */
  noData?: number;
  /** Crop the output to the boundary's extent rather than keeping the full grid. */
  crop?: boolean;
}

export interface ClipResult {
  raster?: CirRaster;
  warnings: Warning[];
  /** Pixels kept, and pixels blanked, so the effect is countable. */
  kept: number;
  blanked: number;
  refusal?: { what: string; why: string; action: string };
}

export function clipRaster(raster: CirRaster, options: ClipOptions): ClipResult {
  const warnings: Warning[] = [];

  if (!raster.hasPixelData || !raster.bands || raster.bands.length === 0) {
    return refuse(
      'This raster carries no pixel data, so there is nothing to clip.',
      'Only the georeference and the image structure were read — the pixels are in a compression this build does not decode, or the image was never supplied.',
      'Convert from a raster whose pixels this tool can read; the Overview tab names the compression when that is the reason.'
    );
  }

  if (!raster.geotransform) {
    return refuse(
      'This raster has no georeference, so a boundary cannot be located on it.',
      'Without a geotransform there is no way to say which pixel a coordinate falls in.',
      'Supply the world file alongside the image, or set the georeference, then clip.'
    );
  }

  const rings = options.polygons.filter((polygon) => polygon.length > 0 && polygon[0].length >= 4);
  if (rings.length === 0) {
    return refuse(
      'No usable boundary was given.',
      'A clip needs at least one closed ring of four or more positions; none of the supplied polygons qualified.',
      'Choose a polygon layer with closed boundaries, or run the CAD polygonisation step first to build them from line work.'
    );
  }

  // A clip with nothing to write outside the boundary would have to invent a
  // value, and every plausible choice is a real measurement somewhere.
  const blank = options.noData ?? raster.noData;
  if (blank === null || blank === undefined || !Number.isFinite(blank)) {
    return refuse(
      'This raster declares no no-data value, so the area outside the boundary cannot be marked as empty.',
      'Clipping does not cut a raster into the boundary’s shape — a raster is always a rectangle. It marks the pixels outside as no-data, and this file has no value reserved for that. Filling with zero instead would put a sea-level plateau around the site, and every contour and slope computed afterwards would treat it as ground.',
      'Set a no-data value in the Georeferencing panel — −9999 is the survey convention for elevation — then clip.'
    );
  }

  const [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight] = raster.geotransform;
  const rotated = rowRotation !== 0 || columnRotation !== 0;

  // --- the window to write --------------------------------------------
  const bounds = ringBounds(rings);
  let startColumn = 0;
  let startRow = 0;
  let width = raster.width;
  let height = raster.height;

  if (options.crop) {
    if (rotated) {
      warnings.push({
        code: 'clip-rotated-no-crop',
        severity: 'warning',
        message: 'The raster is rotated, so it was clipped but not cropped.',
        reason: 'Cropping a rotated grid to a boundary’s extent would need the grid resampled to a new orientation, which changes every pixel value — a different operation from a clip, and not one that should happen without being asked for.',
        action: 'Reproject or rectify the raster first if a cropped output is needed.',
      });
    } else {
      const window = pixelWindow(bounds, originX, pixelWidth, originY, pixelHeight, raster.width, raster.height);
      if (!window) {
        return refuse(
          'The boundary does not overlap this raster.',
          `The boundary spans ${bounds.minX.toFixed(2)}–${bounds.maxX.toFixed(2)} east and ${bounds.minY.toFixed(2)}–${bounds.maxY.toFixed(2)} north, and the raster covers none of it. The two are usually in different coordinate systems when this happens.`,
          'Check that the boundary and the raster declare the same CRS. Reproject one of them if they do not.'
        );
      }
      startColumn = window.startColumn;
      startRow = window.startRow;
      width = window.width;
      height = window.height;
    }
  }

  // --- write ------------------------------------------------------------
  const bands: Float64Array[] = raster.bands.map(() => new Float64Array(width * height));
  let kept = 0;
  let blanked = 0;

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const sourceColumn = startColumn + column;
      const sourceRow = startRow + row;
      const inside = covered(
        sourceColumn,
        sourceRow,
        rings,
        originX,
        pixelWidth,
        rowRotation,
        originY,
        columnRotation,
        pixelHeight,
        options.touched === true
      );

      const target = row * width + column;
      const source = sourceRow * raster.width + sourceColumn;

      for (const [index, band] of bands.entries()) {
        band[target] = inside ? raster.bands[index][source] : blank;
      }
      if (inside) kept++;
      else blanked++;
    }
  }

  const clipped: CirRaster = {
    ...raster,
    width,
    height,
    noData: blank,
    bands,
    geotransform: [
      originX + startColumn * pixelWidth + startRow * rowRotation,
      pixelWidth,
      rowRotation,
      originY + startColumn * columnRotation + startRow * pixelHeight,
      columnRotation,
      pixelHeight,
    ],
    // Recomputing these from the clipped pixels is a separate pass and the
    // caller may not need it; stale statistics are worse than absent ones,
    // because a min of 0 from before the clip reads as real ground.
    statistics: undefined,
    extent: options.crop && !rotated ? extentOf(startColumn, startRow, width, height, originX, pixelWidth, originY, pixelHeight) : raster.extent,
  };

  if (kept === 0) {
    warnings.push({
      code: 'clip-empty',
      severity: 'warning',
      message: 'Every pixel was outside the boundary, so the clipped raster is entirely no-data.',
      reason: 'The boundary and the raster do not overlap, or they are in different coordinate systems — the usual cause when both look correct on their own.',
      action: 'Check that both declare the same CRS.',
    });
  }

  warnings.push({
    code: 'clip-applied',
    severity: 'info',
    message: `${kept.toLocaleString()} pixel(s) kept, ${blanked.toLocaleString()} set to no-data (${blank}).`,
    reason: options.touched
      ? 'A pixel was kept when any part of it fell inside the boundary, so the result is up to one pixel wider than the boundary all round.'
      : 'A pixel was kept when its CENTRE fell inside the boundary, so the result is up to one pixel narrower than the boundary all round.',
    action: options.touched
      ? 'Turn "include partly covered pixels" off for a result that never extends past the boundary.'
      : 'Turn "include partly covered pixels" on if losing the boundary pixel matters more than gaining a partial one.',
    count: blanked,
  });

  return { raster: clipped, warnings, kept, blanked };
}

// ===========================================================================
// Geometry
// ===========================================================================

/** Whether a pixel counts as inside the boundary. See the header on the rule. */
function covered(
  column: number,
  row: number,
  polygons: Position[][][],
  originX: number,
  pixelWidth: number,
  rowRotation: number,
  originY: number,
  columnRotation: number,
  pixelHeight: number,
  touched: boolean
): boolean {
  const toGround = (dx: number, dy: number): Position => [
    originX + (column + dx) * pixelWidth + (row + dy) * rowRotation,
    originY + (column + dx) * columnRotation + (row + dy) * pixelHeight,
  ];

  if (!touched) return insideAny(toGround(0.5, 0.5), polygons);

  // "Touched" tests the centre and the four corners rather than doing exact
  // rectangle-polygon intersection. Five samples catch every case where the
  // boundary crosses a pixel except one: a boundary that enters and leaves
  // through the same edge without reaching a corner, which needs a polygon
  // vertex spacing finer than the pixel. At that point the raster is the wrong
  // resolution for the boundary, and one pixel either way is not the problem.
  for (const [dx, dy] of [
    [0.5, 0.5],
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const) {
    if (insideAny(toGround(dx, dy), polygons)) return true;
  }
  return false;
}

function insideAny(point: Position, polygons: Position[][][]): boolean {
  for (const rings of polygons) {
    const [shell, ...holes] = rings;
    if (!shell || !pointInRing(point, shell)) continue;
    if (holes.some((hole) => pointInRing(point, hole))) continue;
    return true;
  }
  return false;
}

function ringBounds(polygons: Position[][][]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The pixel window covering a ground extent, clamped to the raster.
 *
 * `pixelHeight` is normally NEGATIVE — a north-up raster counts rows downward
 * while northing counts upward — so the row for `maxY` is the SMALLER index.
 * Assuming otherwise produces an empty or inverted window, which reads as "the
 * boundary does not overlap" on a boundary that plainly does.
 */
function pixelWindow(
  bounds: Bounds,
  originX: number,
  pixelWidth: number,
  originY: number,
  pixelHeight: number,
  rasterWidth: number,
  rasterHeight: number
): { startColumn: number; startRow: number; width: number; height: number } | null {
  const columnA = (bounds.minX - originX) / pixelWidth;
  const columnB = (bounds.maxX - originX) / pixelWidth;
  const rowA = (bounds.minY - originY) / pixelHeight;
  const rowB = (bounds.maxY - originY) / pixelHeight;

  const startColumn = Math.max(0, Math.floor(Math.min(columnA, columnB)));
  const endColumn = Math.min(rasterWidth - 1, Math.ceil(Math.max(columnA, columnB)));
  const startRow = Math.max(0, Math.floor(Math.min(rowA, rowB)));
  const endRow = Math.min(rasterHeight - 1, Math.ceil(Math.max(rowA, rowB)));

  if (endColumn < startColumn || endRow < startRow) return null;
  return { startColumn, startRow, width: endColumn - startColumn + 1, height: endRow - startRow + 1 };
}

function extentOf(
  startColumn: number,
  startRow: number,
  width: number,
  height: number,
  originX: number,
  pixelWidth: number,
  originY: number,
  pixelHeight: number
): Bounds {
  const x1 = originX + startColumn * pixelWidth;
  const x2 = originX + (startColumn + width) * pixelWidth;
  const y1 = originY + startRow * pixelHeight;
  const y2 = originY + (startRow + height) * pixelHeight;
  return {
    minX: Math.min(x1, x2),
    maxX: Math.max(x1, x2),
    minY: Math.min(y1, y2),
    maxY: Math.max(y1, y2),
  };
}

function refuse(what: string, why: string, action: string): ClipResult {
  return { warnings: [], kept: 0, blanked: 0, refusal: { what, why, action } };
}
