/**
 * Contour generation from an elevation raster (spec §16, Phase 4).
 *
 * A DEM comes in and contour lines go out, ready to be written to DXF for a
 * drawing or KML for a site review. For a survey office this is the single most
 * common thing anyone wants to do with a raster, and until now this tool could
 * read the DEM and had nothing to offer once it had.
 *
 * ---------------------------------------------------------------------------
 * MARCHING SQUARES, AND THE TWO CASES THAT ARE NOT OBVIOUS
 *
 * The algorithm is standard: for each threshold, classify the four samples
 * around a cell as above or below it, and the resulting 4-bit code selects
 * which cell edges the contour crosses. Linear interpolation along each crossed
 * edge places the point.
 *
 * Two of the sixteen cases are genuinely ambiguous, and getting them wrong is
 * how contour maps end up with bow-ties:
 *
 *   THE SADDLES (codes 5 and 10). Two opposite corners are above the level and
 *     the other two below. The contour can connect the four edge crossings in
 *     two different ways, and they are not equivalent — one joins the high
 *     ground into a ridge, the other separates it into two hills. The centre
 *     value decides, and the standard estimate for it is the mean of the four
 *     corners. Choosing arbitrarily produces a map that is locally plausible
 *     and topologically wrong.
 *
 *   A SAMPLE EXACTLY ON THE LEVEL. `z > level` and `z >= level` disagree here,
 *     and the disagreement is not cosmetic: adjacent cells that classify the
 *     same shared corner differently emit segments that do not meet, so the
 *     contour breaks into fragments. Integer DEMs at integer intervals hit this
 *     on every cell. One comparison, `z >= level`, is used everywhere.
 *
 * ---------------------------------------------------------------------------
 * WHY SEGMENTS ARE STITCHED BY EDGE IDENTITY, NOT BY COORDINATE
 *
 * Marching squares emits loose two-point segments. A contour map of loose
 * segments is useless — a DXF with 400,000 two-point lines cannot be labelled,
 * styled or snapped to — so they have to be joined into polylines.
 *
 * The obvious way is to hash endpoint coordinates and join the ones that match.
 * That works until it does not: two segments meeting on a shared cell edge have
 * endpoints computed from the same two samples by the same expression, so they
 * ARE bit-identical today — and a later change to how the interpolation is
 * written (`a + t * (b - a)` versus `(1 - t) * a + t * b`) silently makes them
 * differ in the last bit, and the contours fall apart into fragments with no
 * error anywhere.
 *
 * So the join key is the GRID EDGE the point sits on — a row, a column and an
 * orientation, all integers. Two segments meet if and only if they cross the
 * same edge, which is exact by construction and cannot be broken by a rounding
 * change.
 *
 * ---------------------------------------------------------------------------
 * NO-DATA STOPS A CONTOUR, IT DOES NOT INTERPOLATE ACROSS IT
 *
 * A cell with any no-data corner is skipped entirely. The alternative —
 * treating no-data as a very low value, or interpolating over the hole — draws
 * contours through ground that was never surveyed, and they look exactly like
 * the real ones. The count of skipped cells is reported so the gap is visible
 * rather than inferred.
 */

import type { CirFeature, CirRaster, Position, Warning } from '../../core/cir';

export interface ContourOptions {
  /** Vertical distance between contours, in the raster's Z units. */
  interval: number;
  /**
   * Levels are `base + n * interval`. Zero puts a contour on round numbers,
   * which is what a plan expects; a base of 0.5 puts them on half-metres.
   */
  base?: number;
  /**
   * Every Nth contour is marked as an index contour (the heavier, labelled one
   * on a printed plan). 5 is the usual survey convention. 0 disables it.
   */
  indexEvery?: number;
  /** Which band holds the elevation. */
  band?: number;
  /**
   * Refuse rather than emit more than this many contour lines.
   *
   * A 1 m interval over 3 km of relief is 3,000 levels, and a 4000×4000 DEM
   * makes each of them thousands of segments. The result is a file no CAD
   * package will open, produced after a wait long enough that the user assumes
   * it is working. Refusing with the arithmetic shown is more useful.
   */
  maxLines?: number;
  /** Drop contours shorter than this, in ground units. 0 keeps everything. */
  minLength?: number;
}

export interface ContourResult {
  features: CirFeature[];
  /** The levels actually contoured, ascending. */
  levels: number[];
  warnings: Warning[];
  refusal?: { what: string; why: string; action: string };
}

const DEFAULT_MAX_LINES = 50_000;

/** Orientation of a grid edge, used as part of its identity. */
const HORIZONTAL = 0;
const VERTICAL = 1;

/** One crossing point, identified by the grid edge it lies on. */
interface Crossing {
  /** Edge identity: row, column, orientation. Integers, so exact. */
  key: number;
  position: Position;
}

/**
 * Contours an elevation raster.
 *
 * Returns a refusal rather than throwing, on the same contract every other
 * engine here uses: the caller shows `what/why/action` and nothing is produced.
 */
export function generateContours(raster: CirRaster, options: ContourOptions): ContourResult {
  const warnings: Warning[] = [];
  const band = options.band ?? 0;

  if (!raster.hasPixelData || !raster.bands || !raster.bands[band]) {
    return refuse(
      'This raster carries no pixel data, so it cannot be contoured.',
      'Only the georeference and the image structure were read — either the file stores its pixels in a compression this build does not decode, or it is a world-file sidecar describing an image that was not supplied.',
      'Convert from a GeoTIFF or ASCII grid whose pixels this tool can read. The Overview tab names the compression when that is the reason.'
    );
  }

  if (!raster.geotransform) {
    return refuse(
      'This raster has no georeference, so contours would have no position.',
      'No geotransform and no world file were found, so a pixel column and row cannot be turned into a coordinate.',
      'Supply the world file alongside the image, or set the georeference in the Georeferencing panel, then contour it.'
    );
  }

  if (!(options.interval > 0) || !Number.isFinite(options.interval)) {
    return refuse(
      'A contour interval is required.',
      'The interval is the vertical distance between contours and must be a positive number.',
      'Enter an interval in the raster’s elevation units — 1 for one-metre contours.'
    );
  }

  const values = raster.bands[band];
  const { width, height, noData } = raster;

  // --- the levels to contour -------------------------------------------
  const base = options.base ?? 0;
  const { min, max, valid, blank } = extremes(values, noData);

  if (valid === 0) {
    return refuse(
      'Every pixel in this raster is no-data.',
      'There are no elevations to contour.',
      'Check that the correct band was chosen and that the no-data value in the Overview tab matches the file.'
    );
  }

  const first = Math.ceil((min - base) / options.interval);
  const last = Math.floor((max - base) / options.interval);
  const levelCount = last - first + 1;

  if (levelCount <= 0) {
    return refuse(
      'The interval is larger than the relief in this raster.',
      `Elevations run from ${min.toFixed(3)} to ${max.toFixed(3)} — a range of ${(max - min).toFixed(3)} — so an interval of ${options.interval} produces no contour at all.`,
      `Use an interval smaller than ${(max - min).toFixed(3)}.`
    );
  }

  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  if (levelCount > maxLines) {
    return refuse(
      'That interval would produce more contours than any drawing can hold.',
      `Elevations span ${(max - min).toFixed(3)} units, so an interval of ${options.interval} gives ${levelCount.toLocaleString()} levels before a single line is traced — beyond the limit of ${maxLines.toLocaleString()}.`,
      `Use a larger interval. ${suggestInterval(max - min)} would give about ${Math.round((max - min) / suggestInterval(max - min))} contours.`
    );
  }

  const levels: number[] = [];
  for (let n = first; n <= last; n++) levels.push(round(base + n * options.interval));

  if (blank > 0) {
    warnings.push({
      code: 'contour-nodata',
      severity: 'info',
      message: `${blank.toLocaleString()} of ${(width * height).toLocaleString()} pixels are no-data and were not contoured.`,
      reason: 'A cell touching a no-data pixel is skipped entirely rather than interpolated across, because a contour drawn over unsurveyed ground is indistinguishable from a real one.',
      action: 'Expect contours to stop at the edge of the surveyed area. Fill the gaps in the source DEM if continuous contours are needed.',
      count: blank,
    });
  }

  // --- trace ------------------------------------------------------------
  const features: CirFeature[] = [];
  const indexEvery = options.indexEvery ?? 0;
  const minLength = options.minLength ?? 0;
  let dropped = 0;

  for (const level of levels) {
    const segments = marchLevel(values, width, height, noData, level);
    const lines = stitch(segments);

    for (const line of lines) {
      if (line.length < 2) continue;
      const length = polylineLength(line);
      if (minLength > 0 && length < minLength) {
        dropped++;
        continue;
      }

      const step = Math.round((level - base) / options.interval);
      features.push({
        geometry: { type: 'LineString', coordinates: line, dimension: 2 },
        properties: {
          elevation: level,
          // A printed plan draws every fifth contour heavier and labels it.
          // Carrying the distinction as data means the styling survives the
          // hop into DXF or KML instead of being redone by hand.
          index: indexEvery > 0 && step % indexEvery === 0,
          length: round(length),
          closed: closes(line),
        },
      });

      if (features.length > maxLines) {
        return refuse(
          'This DEM produces more contour lines than a drawing can hold.',
          `More than ${maxLines.toLocaleString()} separate lines were traced at an interval of ${options.interval}. A file this size will not open in most CAD packages, and tracing the rest would take far longer than it has already.`,
          `Use a larger interval, or set a minimum length to drop the short fragments that noise in the surface produces. ${suggestInterval(max - min)} is a reasonable starting point.`
        );
      }
    }
  }

  if (dropped > 0) {
    warnings.push({
      code: 'contour-short-dropped',
      severity: 'info',
      message: `${dropped.toLocaleString()} contour fragments shorter than ${minLength} units were dropped.`,
      reason: 'Short closed fragments are usually noise in the surface rather than real relief — a single high pixel produces a ring around itself at every level it crosses.',
      action: 'Lower the minimum length, or set it to 0, to keep them.',
      count: dropped,
    });
  }

  if (features.length === 0) {
    warnings.push({
      code: 'contour-empty',
      severity: 'warning',
      message: 'No contours were produced.',
      reason: `Levels were computed from ${min.toFixed(3)} to ${max.toFixed(3)}, but no cell crossed any of them — which happens when the surface is flat, or when almost every cell touches no-data.`,
      action: 'Check the elevation range in the Overview tab against the interval you chose.',
    });
  }

  return { features, levels, warnings };
}

// ===========================================================================
// Marching squares
// ===========================================================================

/**
 * Every contour segment at one level.
 *
 * Samples are treated as values at pixel CENTRES, so a cell of the marching
 * grid spans the centres of four neighbouring pixels. Treating them as corner
 * values instead shifts every contour by half a pixel — invisible on screen,
 * and half a metre on the ground for a 1 m DEM.
 */
function marchLevel(
  values: Float64Array,
  width: number,
  height: number,
  noData: number | null,
  level: number
): Crossing[][] {
  const segments: Crossing[][] = [];
  const at = (column: number, row: number): number => values[row * width + column];
  const blank = (value: number): boolean =>
    !Number.isFinite(value) || (noData !== null && value === noData);

  for (let row = 0; row < height - 1; row++) {
    for (let column = 0; column < width - 1; column++) {
      // Corners, anticlockwise from the top-left of the cell.
      const topLeft = at(column, row);
      const topRight = at(column + 1, row);
      const bottomRight = at(column + 1, row + 1);
      const bottomLeft = at(column, row + 1);

      // Any no-data corner and the whole cell is skipped. See the header.
      if (blank(topLeft) || blank(topRight) || blank(bottomRight) || blank(bottomLeft)) continue;

      // `>=` throughout, so a sample sitting exactly on the level is classified
      // identically by every cell that shares it.
      const code =
        (topLeft >= level ? 8 : 0) |
        (topRight >= level ? 4 : 0) |
        (bottomRight >= level ? 2 : 0) |
        (bottomLeft >= level ? 1 : 0);

      if (code === 0 || code === 15) continue;

      // The four cell edges, each identified exactly by (row, column, axis).
      const top = (): Crossing => ({
        key: edgeKey(row, column, HORIZONTAL, width),
        position: [column + fraction(topLeft, topRight, level), row],
      });
      const bottom = (): Crossing => ({
        key: edgeKey(row + 1, column, HORIZONTAL, width),
        position: [column + fraction(bottomLeft, bottomRight, level), row + 1],
      });
      const left = (): Crossing => ({
        key: edgeKey(row, column, VERTICAL, width),
        position: [column, row + fraction(topLeft, bottomLeft, level)],
      });
      const right = (): Crossing => ({
        key: edgeKey(row, column + 1, VERTICAL, width),
        position: [column + 1, row + fraction(topRight, bottomRight, level)],
      });

      switch (code) {
        case 1:
        case 14:
          segments.push([left(), bottom()]);
          break;
        case 2:
        case 13:
          segments.push([bottom(), right()]);
          break;
        case 3:
        case 12:
          segments.push([left(), right()]);
          break;
        case 4:
        case 11:
          segments.push([top(), right()]);
          break;
        case 6:
        case 9:
          segments.push([top(), bottom()]);
          break;
        case 7:
        case 8:
          segments.push([left(), top()]);
          break;

        // The saddles. The centre value decides which pairing is correct, and
        // the mean of the four corners is the standard estimate for it. Pairing
        // arbitrarily joins two hills into a ridge, or splits a ridge in two.
        case 5: {
          const centre = (topLeft + topRight + bottomRight + bottomLeft) / 4;
          if (centre >= level) {
            segments.push([left(), top()], [bottom(), right()]);
          } else {
            segments.push([left(), bottom()], [top(), right()]);
          }
          break;
        }
        case 10: {
          const centre = (topLeft + topRight + bottomRight + bottomLeft) / 4;
          if (centre >= level) {
            segments.push([left(), bottom()], [top(), right()]);
          } else {
            segments.push([left(), top()], [bottom(), right()]);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return segments;
}

/**
 * Where along an edge the contour crosses it.
 *
 * Guarded against a zero denominator: two equal samples that both sit exactly
 * on the level would otherwise divide by zero and place the crossing at NaN,
 * which propagates into the geometry and is only noticed when a writer emits
 * "NaN" into a coordinate.
 */
function fraction(from: number, to: number, level: number): number {
  const span = to - from;
  if (span === 0) return 0.5;
  const t = (level - from) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** A grid edge's identity, packed into one integer. Exact, so joins are exact. */
function edgeKey(row: number, column: number, axis: number, width: number): number {
  return (row * (width + 1) + column) * 2 + axis;
}

// ===========================================================================
// Stitching segments into polylines
// ===========================================================================

/**
 * Joins loose segments into the longest polylines they form.
 *
 * Two segments join when they share a grid edge — an integer key, so the test
 * is exact. A chain that returns to its own start is a closed contour (a hill
 * or a basin) and is closed explicitly rather than left one point short.
 */
function stitch(segments: Crossing[][]): Position[][] {
  if (segments.length === 0) return [];

  /** Every segment end that still has a free connection, by edge key. */
  const ends = new Map<number, number[]>();
  const used = new Uint8Array(segments.length);

  for (const [index, segment] of segments.entries()) {
    for (const crossing of segment) {
      const list = ends.get(crossing.key);
      if (list) list.push(index);
      else ends.set(crossing.key, [index]);
    }
  }

  const nextFrom = (key: number, exclude: number): number => {
    const list = ends.get(key);
    if (!list) return -1;
    for (const candidate of list) {
      if (candidate !== exclude && !used[candidate]) return candidate;
    }
    return -1;
  };

  const lines: Position[][] = [];

  for (let seed = 0; seed < segments.length; seed++) {
    if (used[seed]) continue;
    used[seed] = 1;

    const [startCrossing, endCrossing] = segments[seed];
    const chain: Position[] = [startCrossing.position, endCrossing.position];
    let headKey = startCrossing.key;
    let tailKey = endCrossing.key;

    // Grow forward from the tail.
    for (;;) {
      const next = nextFrom(tailKey, -1);
      if (next < 0) break;
      used[next] = 1;
      const [a, b] = segments[next];
      const onward = a.key === tailKey ? b : a;
      chain.push(onward.position);
      tailKey = onward.key;
      if (tailKey === headKey) break; // closed ring
    }

    // Then backward from the head, unless the ring already closed.
    if (tailKey !== headKey) {
      for (;;) {
        const previous = nextFrom(headKey, -1);
        if (previous < 0) break;
        used[previous] = 1;
        const [a, b] = segments[previous];
        const onward = a.key === headKey ? b : a;
        chain.unshift(onward.position);
        headKey = onward.key;
        if (headKey === tailKey) break;
      }
    }

    // A ring's first and last point are the same crossing; say so explicitly,
    // because a reader that assumes closure is a reader that gets it wrong on
    // the one contour that genuinely is open.
    if (headKey === tailKey && chain.length > 2) {
      const first = chain[0];
      const last = chain[chain.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) chain.push([first[0], first[1]]);
    }

    lines.push(chain);
  }

  return lines;
}

// ===========================================================================
// Grid space to ground
// ===========================================================================

/**
 * Converts a contour from pixel coordinates to ground coordinates.
 *
 * Separate from tracing on purpose: marching squares is easier to reason about
 * and to test in grid space, and the georeference is one multiplication applied
 * once at the end. It also means a rotated geotransform costs nothing extra —
 * the rotation terms are simply not zero.
 */
export function toGround(line: Position[], geotransform: CirRaster['geotransform']): Position[] {
  if (!geotransform) return line;
  const [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight] = geotransform;

  // +0.5 because a sample is the value at the pixel CENTRE, and grid position
  // (0,0) is that centre rather than the pixel's upper-left corner.
  return line.map(([column, row]) => {
    const x = originX + (column + 0.5) * pixelWidth + (row + 0.5) * rowRotation;
    const y = originY + (column + 0.5) * columnRotation + (row + 0.5) * pixelHeight;
    return [x, y] as Position;
  });
}

/** Applies `toGround` to every feature a trace produced. */
export function groundContours(result: ContourResult, geotransform: CirRaster['geotransform']): ContourResult {
  return {
    ...result,
    features: result.features.map((feature) => ({
      ...feature,
      geometry:
        feature.geometry && feature.geometry.type === 'LineString'
          ? { ...feature.geometry, coordinates: toGround(feature.geometry.coordinates as Position[], geotransform) }
          : feature.geometry,
    })),
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

function extremes(
  values: Float64Array,
  noData: number | null
): { min: number; max: number; valid: number; blank: number } {
  let min = Infinity;
  let max = -Infinity;
  let valid = 0;
  let blank = 0;

  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value) || (noData !== null && value === noData)) {
      blank++;
      continue;
    }
    if (value < min) min = value;
    if (value > max) max = value;
    valid++;
  }

  return { min, max, valid, blank };
}

function polylineLength(line: Position[]): number {
  let total = 0;
  for (let index = 1; index < line.length; index++) {
    total += Math.hypot(line[index][0] - line[index - 1][0], line[index][1] - line[index - 1][1]);
  }
  return total;
}

function closes(line: Position[]): boolean {
  if (line.length < 4) return false;
  const first = line[0];
  const last = line[line.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/** A round interval that keeps a DEM's relief to roughly a hundred contours. */
function suggestInterval(relief: number): number {
  const rough = relief / 100;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough || 1)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (magnitude * step >= rough) return round(magnitude * step);
  }
  return round(magnitude * 10);
}

/** Kills the float noise that turns a 0.1 m interval into 30.000000000000004. */
function round(value: number): number {
  return Number(value.toFixed(9));
}

function refuse(what: string, why: string, action: string): ContourResult {
  return { features: [], levels: [], warnings: [], refusal: { what, why, action } };
}
