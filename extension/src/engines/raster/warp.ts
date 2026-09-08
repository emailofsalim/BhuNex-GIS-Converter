/**
 * Resampling and reprojecting a raster (spec §16, Phase 4).
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO FIX
 *
 * `transformDataset` reprojected every vector layer and left the raster alone —
 * then relabelled the dataset with the target CRS. The output claimed to be in
 * UTM 43N while its pixels were still on the geographic grid they arrived on,
 * and nothing said so. A GeoTIFF like that opens, draws, and is in the wrong
 * place by a few hundred kilometres, which is far enough that it looks like a
 * different dataset rather than a wrong one.
 *
 * ---------------------------------------------------------------------------
 * INVERSE MAPPING, NOT FORWARD
 *
 * The obvious way to warp is to walk the SOURCE pixels, transform each centre
 * into the target, and write it there. It is wrong: the transform is not
 * area-preserving, so target pixels the source stretches over receive nothing
 * and the output is stippled with holes.
 *
 * So the walk is over the TARGET pixels, and each centre is transformed
 * BACKWARDS into source coordinates and sampled there. Every target pixel gets
 * exactly one value by construction, and the cost is that the transform must be
 * invertible — which is why the plan is built from target to source.
 *
 * ---------------------------------------------------------------------------
 * BILINEAR IS WRONG FOR CATEGORIES, AND NEAREST IS LOSSY FOR SURFACES
 *
 * The choice is not a quality setting. Averaging land-cover class 3 with class
 * 5 gives class 4 — a different category, invented, and one that may not even
 * exist in the legend. Averaging two elevations gives an elevation, which is
 * exactly right.
 *
 * So the default follows the data: `isElevation` picks bilinear, everything
 * else picks nearest, and the choice is reported rather than assumed. A
 * categorical raster resampled bilinearly is the classic way to produce a
 * land-cover map full of classes nobody defined.
 *
 * ---------------------------------------------------------------------------
 * NO-DATA IS NOT A NUMBER
 *
 * Bilinear over four neighbours where one is no-data must give NO-DATA, not a
 * three-quarter blend. Blending invents ground at the edge of the surveyed
 * area — a soft ramp down into the hole, which contours beautifully and is
 * entirely fictional. Any no-data neighbour poisons the sample.
 */

import type { CirRaster, Position, Warning } from '../../core/cir';

export type Resampling = 'nearest' | 'bilinear';

export interface WarpOptions {
  /**
   * Target pixel centre → source coordinates.
   *
   * Backwards on purpose: the walk is over target pixels. See the header.
   */
  toSource: (position: Position) => Position;
  /** Target grid. Computed by `planWarpGrid` unless the caller has its own. */
  geotransform: [number, number, number, number, number, number];
  width: number;
  height: number;
  method?: Resampling;
  /** Value written where the target falls outside the source, or on no-data. */
  noData?: number;
}

export interface WarpResult {
  raster?: CirRaster;
  warnings: Warning[];
  /** Target pixels that found a source value, and those that did not. */
  filled: number;
  empty: number;
  refusal?: { what: string; why: string; action: string };
}

/**
 * Resamples a raster onto a new grid.
 *
 * The same routine serves reprojection and plain rescaling: a rescale is a warp
 * whose `toSource` is an affine map. One code path means one set of no-data
 * rules rather than two that drift.
 */
export function warpRaster(source: CirRaster, options: WarpOptions): WarpResult {
  if (!source.hasPixelData || !source.bands || source.bands.length === 0) {
    return refuse(
      'This raster carries no pixel data, so it cannot be resampled.',
      'Only the georeference and the image structure were read.',
      'Convert from a raster whose pixels this tool can read; the Overview tab names the compression when that is the reason.'
    );
  }
  if (!source.geotransform) {
    return refuse(
      'This raster has no georeference, so it cannot be resampled onto another grid.',
      'Without a geotransform there is no way to say which source pixel a target coordinate falls in.',
      'Supply the world file alongside the image, or set the georeference first.'
    );
  }
  if (!(options.width > 0) || !(options.height > 0)) {
    return refuse(
      'The target grid has no size.',
      `A ${options.width} × ${options.height} grid holds no pixels.`,
      'Choose a pixel size that divides into the target extent at least once.'
    );
  }

  const warnings: Warning[] = [];
  const blank = options.noData ?? source.noData;

  if (blank === null || blank === undefined || !Number.isFinite(blank)) {
    return refuse(
      'This raster declares no no-data value, so the area outside it cannot be marked as empty.',
      'A reprojected grid is a rectangle in the TARGET system, and the source — a rectangle in its own system — never fills it exactly. The corners fall outside, and they have to hold something. Zero is not available: it is a real elevation at sea level, and a zero-filled corner contours as ground.',
      'Set a no-data value in the Georeferencing panel — −9999 is the survey convention for elevation — then reproject.'
    );
  }

  // A categorical raster resampled bilinearly is how a land-cover map ends up
  // full of classes nobody defined. Elevation is the case where averaging is
  // meaningful, so it is the case that gets bilinear by default.
  const method: Resampling = options.method ?? (source.isElevation ? 'bilinear' : 'nearest');
  if (!options.method) {
    warnings.push({
      code: 'warp-method-chosen',
      severity: 'info',
      message: `Resampled with ${method === 'bilinear' ? 'bilinear interpolation' : 'nearest neighbour'}.`,
      reason:
        method === 'bilinear'
          ? 'The raster is marked as elevation, and averaging two elevations gives an elevation.'
          : 'The raster is not marked as elevation, and averaging category codes invents categories — class 3 and class 5 would average to class 4, which may not exist in the legend.',
      action: 'Choose the method explicitly if this raster is continuous data that is not elevation.',
    });
  }

  const [sourceOriginX, sourcePixelWidth, sourceRowRotation, sourceOriginY, sourceColumnRotation, sourcePixelHeight] =
    source.geotransform;

  // World → source pixel, by inverting the source's affine transform. The
  // determinant is zero for a degenerate geotransform (a zero pixel size), and
  // dividing by it would fill the output with NaN rather than refusing.
  const determinant = sourcePixelWidth * sourcePixelHeight - sourceRowRotation * sourceColumnRotation;
  if (determinant === 0) {
    return refuse(
      'This raster’s georeference cannot be inverted.',
      'Its geotransform is degenerate — a zero pixel size, or two parallel axes — so a ground coordinate does not map back to a unique pixel.',
      'Correct the world file or the georeference; a pixel size of zero is the usual cause.'
    );
  }

  const toPixel = (x: number, y: number): { column: number; row: number } => {
    const dx = x - sourceOriginX;
    const dy = y - sourceOriginY;
    return {
      column: (dx * sourcePixelHeight - dy * sourceRowRotation) / determinant,
      row: (dy * sourcePixelWidth - dx * sourceColumnRotation) / determinant,
    };
  };

  const [targetOriginX, targetPixelWidth, targetRowRotation, targetOriginY, targetColumnRotation, targetPixelHeight] =
    options.geotransform;

  const bands: Float64Array[] = source.bands.map(() => new Float64Array(options.width * options.height));
  let filled = 0;
  let empty = 0;

  for (let row = 0; row < options.height; row++) {
    for (let column = 0; column < options.width; column++) {
      const groundX = targetOriginX + (column + 0.5) * targetPixelWidth + (row + 0.5) * targetRowRotation;
      const groundY = targetOriginY + (column + 0.5) * targetColumnRotation + (row + 0.5) * targetPixelHeight;

      const [sourceX, sourceY] = options.toSource([groundX, groundY]);
      const target = row * options.width + column;

      if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY)) {
        for (const band of bands) band[target] = blank;
        empty++;
        continue;
      }

      // Back to the CONTINUOUS pixel coordinate, then −0.5 so that a sample
      // sits at a pixel centre rather than its corner. Without the shift every
      // resampled raster is displaced half a pixel — invisible, and half a
      // metre on the ground for a 1 m DEM.
      const { column: pixelColumn, row: pixelRow } = toPixel(sourceX, sourceY);
      const value = sample(source, bands.length, pixelColumn - 0.5, pixelRow - 0.5, method, blank);

      for (const [index, band] of bands.entries()) band[target] = value[index];
      if (value[0] === blank) empty++;
      else filled++;
    }
  }

  if (filled === 0) {
    warnings.push({
      code: 'warp-empty',
      severity: 'warning',
      message: 'No target pixel found a source value.',
      reason: 'The target grid and the source raster do not overlap after the transform — which usually means the source CRS was declared wrongly rather than that the transform failed.',
      action: 'Check the source CRS in the CRS tab against what the file actually is.',
    });
  }

  return {
    raster: {
      ...source,
      width: options.width,
      height: options.height,
      geotransform: options.geotransform,
      noData: blank,
      bands,
      // Recomputing these is a second pass the caller may not want, and a min
      // carried over from the source reads as real ground after a warp that
      // dropped the low corner.
      statistics: undefined,
      extent: extentOf(options),
    },
    warnings,
    filled,
    empty,
  };
}

/**
 * Samples the source at a continuous pixel position.
 *
 * Returns one value per band, so a multi-band raster is sampled once rather
 * than once per band — which also guarantees every band agrees about whether
 * the sample was no-data.
 */
function sample(
  source: CirRaster,
  bandCount: number,
  column: number,
  row: number,
  method: Resampling,
  blank: number
): number[] {
  const bands = source.bands as Float64Array[];
  const { width, height } = source;

  const at = (bandIndex: number, c: number, r: number): number => {
    if (c < 0 || r < 0 || c >= width || r >= height) return blank;
    const value = bands[bandIndex][r * width + c];
    if (!Number.isFinite(value)) return blank;
    if (source.noData !== null && value === source.noData) return blank;
    return value;
  };

  if (method === 'nearest') {
    const c = Math.round(column);
    const r = Math.round(row);
    return Array.from({ length: bandCount }, (_, index) => at(index, c, r));
  }

  const c0 = Math.floor(column);
  const r0 = Math.floor(row);
  const fx = column - c0;
  const fy = row - r0;

  return Array.from({ length: bandCount }, (_, index) => {
    const v00 = at(index, c0, r0);
    const v10 = at(index, c0 + 1, r0);
    const v01 = at(index, c0, r0 + 1);
    const v11 = at(index, c0 + 1, r0 + 1);

    // ANY no-data neighbour poisons the sample. A three-quarter blend would
    // ramp gently down into the hole, which contours beautifully and is
    // entirely invented — see the header.
    if (v00 === blank || v10 === blank || v01 === blank || v11 === blank) return blank;

    const top = v00 + (v10 - v00) * fx;
    const bottom = v01 + (v11 - v01) * fx;
    return top + (bottom - top) * fy;
  });
}

// ===========================================================================
// Planning a target grid
// ===========================================================================

export interface WarpGrid {
  geotransform: [number, number, number, number, number, number];
  width: number;
  height: number;
  /** Ground units per pixel in the target system. */
  pixelSize: number;
}

/**
 * Chooses a target grid for a reprojection.
 *
 * The source's four corners are not enough: a projection bends the edges, so a
 * box built from corners alone clips the bulge in the middle of each side. The
 * edges are therefore sampled — the standard remedy, and cheap at this size.
 *
 * The pixel size is chosen so the target holds roughly as many pixels as the
 * source. Keeping the source's numeric pixel size would be wrong whenever the
 * units change: 0.0001 degrees is about 11 m, and a raster reprojected from
 * degrees to metres with its pixel size carried across becomes 11 metres wide.
 */
export function planWarpGrid(
  source: CirRaster,
  toTarget: (position: Position) => Position,
  samplesPerEdge = 16
): WarpGrid | null {
  if (!source.geotransform || source.width === 0 || source.height === 0) return null;
  const [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight] = source.geotransform;

  const ground = (column: number, row: number): Position => [
    originX + column * pixelWidth + row * rowRotation,
    originY + column * columnRotation + row * pixelHeight,
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = 0;

  const consider = (position: Position): void => {
    const [x, y] = toTarget(position);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    seen++;
  };

  for (let step = 0; step <= samplesPerEdge; step++) {
    const t = step / samplesPerEdge;
    consider(ground(t * source.width, 0));
    consider(ground(t * source.width, source.height));
    consider(ground(0, t * source.height));
    consider(ground(source.width, t * source.height));
  }

  if (seen === 0 || !Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;

  const targetPixels = source.width * source.height;
  const pixelSize = Math.sqrt(((maxX - minX) * (maxY - minY)) / targetPixels);
  if (!(pixelSize > 0) || !Number.isFinite(pixelSize)) return null;

  const width = Math.max(1, Math.ceil((maxX - minX) / pixelSize));
  const height = Math.max(1, Math.ceil((maxY - minY) / pixelSize));

  return {
    // North-up: the origin is the TOP-left, so the pixel height is negative and
    // the origin's Y is maxY. Writing minY here flips every raster vertically,
    // which looks like a plausible image of somewhere else.
    geotransform: [minX, pixelSize, 0, maxY, 0, -pixelSize],
    width,
    height,
    pixelSize,
  };
}

function extentOf(options: WarpOptions): { minX: number; minY: number; maxX: number; maxY: number } {
  const [originX, pixelWidth, , originY, , pixelHeight] = options.geotransform;
  const x1 = originX;
  const x2 = originX + options.width * pixelWidth;
  const y1 = originY;
  const y2 = originY + options.height * pixelHeight;
  return {
    minX: Math.min(x1, x2),
    maxX: Math.max(x1, x2),
    minY: Math.min(y1, y2),
    maxY: Math.max(y1, y2),
  };
}

function refuse(what: string, why: string, action: string): WarpResult {
  return { warnings: [], filled: 0, empty: 0, refusal: { what, why, action } };
}
