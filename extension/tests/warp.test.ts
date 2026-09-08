/**
 * Resampling and reprojecting a raster (spec §16).
 *
 * Four errors here produce a file that opens, draws, and is wrong. Each has a
 * test built so that the right answer is known by construction:
 *
 *   FORWARD MAPPING leaves holes — the transform is not area-preserving, so
 *     target pixels the source stretches over receive nothing.
 *
 *   BILINEAR ON CATEGORIES invents classes. Land-cover 3 averaged with 5 gives
 *     4, which may not exist in the legend.
 *
 *   BLENDING ACROSS NO-DATA invents ground at the edge of the surveyed area — a
 *     soft ramp into the hole that contours beautifully and is fiction.
 *
 *   A FLIPPED TARGET GRID. North-up means the origin is the TOP-left and the
 *     pixel height is negative; writing minY as the origin flips every raster
 *     vertically, which is a plausible image of somewhere else.
 */

import { describe, expect, it } from 'vitest';
import type { CirRaster, Position } from '@core/cir';
import { planWarpGrid, warpRaster } from '@engines/raster/warp';

/** North-up: origin top-left at (0, 10), 1-unit pixels, row 0 is the TOP. */
function raster(values: number[][], extra: Partial<CirRaster> = {}): CirRaster {
  const height = values.length;
  const width = values[0].length;
  return {
    width,
    height,
    bandCount: 1,
    pixelType: 'float32',
    noData: -9999,
    geotransform: [0, 1, 0, 10, 0, -1],
    extent: null,
    bands: [Float64Array.from(values.flat())],
    hasPixelData: true,
    statistics: [{ min: 0, max: 1 }],
    ...extra,
  };
}

/** A ramp whose value is its column, so a resample is checkable by hand. */
function ramp(size = 10): CirRaster {
  return raster(
    Array.from({ length: size }, () => Array.from({ length: size }, (_, column) => column)),
    { isElevation: true }
  );
}

const identity = (position: Position): Position => position;

describe('what a warp refuses', () => {
  it('refuses a raster with no pixels', () => {
    const structureOnly: CirRaster = { ...ramp(), hasPixelData: false, bands: undefined };
    const result = warpRaster(structureOnly, {
      toSource: identity,
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 4,
      height: 4,
    });
    expect(result.refusal?.what).toContain('no pixel data');
  });

  it('refuses a raster with no georeference', () => {
    const unpositioned: CirRaster = { ...ramp(), geotransform: null };
    const result = warpRaster(unpositioned, {
      toSource: identity,
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 4,
      height: 4,
    });
    expect(result.refusal?.what).toContain('no georeference');
  });

  it('refuses without a no-data value, because the corners have to hold something', () => {
    // A reprojected grid is a rectangle in the TARGET system; the source is a
    // rectangle in its own, so the corners fall outside. Zero is not available
    // — it is a real elevation, and a zero-filled corner contours as ground.
    const noNoData: CirRaster = { ...ramp(), noData: null };
    const result = warpRaster(noNoData, {
      toSource: identity,
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 4,
      height: 4,
    });
    expect(result.refusal?.what).toContain('no no-data value');
    expect(result.refusal?.why).toContain('corners');
  });

  it('refuses a degenerate geotransform rather than filling the output with NaN', () => {
    // A zero pixel size makes the determinant zero, and dividing by it puts NaN
    // in every pixel — an output that "succeeds" and is entirely unusable.
    const degenerate: CirRaster = { ...ramp(), geotransform: [0, 0, 0, 10, 0, -1] };
    const result = warpRaster(degenerate, {
      toSource: identity,
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 4,
      height: 4,
    });
    expect(result.refusal?.what).toContain('cannot be inverted');
  });

  it('refuses an empty target grid', () => {
    const result = warpRaster(ramp(), { toSource: identity, geotransform: [0, 1, 0, 10, 0, -1], width: 0, height: 4 });
    expect(result.refusal?.what).toContain('no size');
  });
});

describe('inverse mapping', () => {
  it('fills every target pixel — no holes', () => {
    // The whole reason the walk is over target pixels. Forward mapping leaves
    // target pixels the source stretches over with nothing in them, scattered
    // through the middle of the image rather than around its edge.
    const result = warpRaster(ramp(10), {
      toSource: identity,
      geotransform: [0, 0.5, 0, 10, 0, -0.5], // twice the resolution
      width: 20,
      height: 20,
      method: 'nearest',
    });

    expect(result.refusal).toBeUndefined();
    expect(result.filled).toBe(400);
    expect(result.empty).toBe(0);
    for (const value of result.raster!.bands![0]) expect(Number.isFinite(value)).toBe(true);
  });

  it('leaves bilinear’s outer half-pixel as no-data rather than extrapolating', () => {
    // Not a hole — a refusal. Bilinear needs four surrounding pixel CENTRES,
    // and the outermost half-pixel of the target has only two or one. The
    // alternative is extrapolating past the edge of the data, which invents
    // ground exactly where a surveyed area stops.
    const result = warpRaster(ramp(10), {
      toSource: identity,
      geotransform: [0, 0.5, 0, 10, 0, -0.5],
      width: 20,
      height: 20,
      method: 'bilinear',
    });

    // A one-pixel border of a 20x20 grid: 400 - 18*18 = 76.
    expect(result.filled).toBe(324);
    expect(result.empty).toBe(76);

    // And the blanks are the BORDER, not scattered through the middle — which
    // is what distinguishes this from the forward-mapping holes above.
    const band = result.raster!.bands![0];
    for (let row = 1; row < 19; row++) {
      for (let column = 1; column < 19; column++) {
        expect(band[row * 20 + column]).not.toBe(-9999);
      }
    }
  });

  it('reproduces the source exactly when the grid and the transform are identity', () => {
    const source = ramp(6);
    const result = warpRaster(source, {
      toSource: identity,
      geotransform: source.geotransform!,
      width: source.width,
      height: source.height,
      method: 'nearest',
    });
    expect(Array.from(result.raster!.bands![0])).toEqual(Array.from(source.bands![0]));
  });

  it('samples at the pixel centre, not its corner', () => {
    // Without the half-pixel shift every resampled raster is displaced by half
    // a pixel — invisible on screen, half a metre on a 1 m DEM.
    const source = ramp(10);
    const shifted = warpRaster(source, {
      toSource: identity,
      geotransform: source.geotransform!,
      width: 10,
      height: 10,
      method: 'bilinear',
    });
    // Value equals the column, so an unshifted sample would be off by 0.5.
    expect(shifted.raster!.bands![0][0]).toBeCloseTo(0, 9);
    expect(shifted.raster!.bands![0][5]).toBeCloseTo(5, 9);
  });

  it('marks target pixels that fall outside the source as no-data', () => {
    const result = warpRaster(ramp(4), {
      toSource: identity,
      // A target grid twice as wide as the source, so half of it is empty.
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 8,
      height: 4,
      method: 'nearest',
    });
    expect(result.empty).toBeGreaterThan(0);
    expect(Array.from(result.raster!.bands![0])).toContain(-9999);
  });

  it('warns when nothing overlaps, and names the likely cause', () => {
    const result = warpRaster(ramp(4), {
      toSource: () => [1e9, 1e9],
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 4,
      height: 4,
    });
    expect(result.filled).toBe(0);
    expect(result.warnings.find((w) => w.code === 'warp-empty')?.reason).toContain('declared wrongly');
  });
});

describe('choosing the resampling method', () => {
  it('defaults to bilinear for elevation, because averaging elevations gives an elevation', () => {
    const result = warpRaster(ramp(6), {
      toSource: identity,
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 6,
      height: 6,
    });
    const chosen = result.warnings.find((w) => w.code === 'warp-method-chosen');
    expect(chosen?.message).toContain('bilinear');
    expect(chosen?.reason).toContain('elevation');
  });

  it('defaults to nearest for anything else, because averaging classes invents classes', () => {
    // The classic land-cover error: class 3 and class 5 average to class 4,
    // which may not exist in the legend at all.
    const categorical = raster([[3, 5], [3, 5]], { isElevation: false });
    const result = warpRaster(categorical, {
      toSource: identity,
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 2,
      height: 2,
    });
    const chosen = result.warnings.find((w) => w.code === 'warp-method-chosen');
    expect(chosen?.message).toContain('nearest');
    expect(chosen?.reason).toContain('class 4');
    // And no invented class appears in the output.
    for (const value of result.raster!.bands![0]) expect([3, 5, -9999]).toContain(value);
  });

  it('does not second-guess an explicit choice', () => {
    const result = warpRaster(ramp(4), {
      toSource: identity,
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 4,
      height: 4,
      method: 'nearest',
    });
    expect(result.warnings.find((w) => w.code === 'warp-method-chosen')).toBeUndefined();
  });

  it('interpolates between samples when bilinear', () => {
    // Value equals the column, so sampling half way between columns 2 and 3
    // must give 2.5 rather than 2 or 3.
    const source = ramp(10);
    const result = warpRaster(source, {
      toSource: identity,
      // Offset the grid half a pixel east.
      geotransform: [0.5, 1, 0, 10, 0, -1],
      width: 8,
      height: 8,
      method: 'bilinear',
    });
    expect(result.raster!.bands![0][2]).toBeCloseTo(2.5, 9);
  });
});

describe('no-data is not a number', () => {
  it('does not blend across a no-data neighbour', () => {
    // THE ONE THAT MATTERS. A three-quarter blend ramps gently down into the
    // hole, and the result contours beautifully and is entirely invented.
    const holed = raster(
      [
        [10, 10, -9999],
        [10, 10, -9999],
        [10, 10, -9999],
      ],
      { isElevation: true }
    );
    const result = warpRaster(holed, {
      toSource: identity,
      geotransform: [0, 0.5, 0, 10, 0, -0.5],
      width: 6,
      height: 6,
      method: 'bilinear',
    });

    // Every value is either the real elevation or no-data — never between.
    for (const value of result.raster!.bands![0]) {
      const clean = value === -9999 || Math.abs(value - 10) < 1e-9;
      expect(clean).toBe(true);
    }
  });

  it('treats a non-finite pixel as no-data', () => {
    const withNaN = raster([[1, NaN], [1, 1]], { isElevation: true });
    const result = warpRaster(withNaN, {
      toSource: identity,
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 2,
      height: 2,
      method: 'bilinear',
    });
    for (const value of result.raster!.bands![0]) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('planning the target grid', () => {
  it('produces a north-up grid: origin at the top, negative pixel height', () => {
    // Writing minY as the origin flips the raster vertically, which is a
    // perfectly plausible image of somewhere else.
    const grid = planWarpGrid(ramp(10), identity)!;
    const [originX, pixelWidth, , originY, , pixelHeight] = grid.geotransform;

    expect(pixelWidth).toBeGreaterThan(0);
    expect(pixelHeight).toBeLessThan(0);
    expect(originY).toBeGreaterThan(0); // the TOP of the source, not the bottom
    expect(originX).toBeCloseTo(0, 6);
  });

  it('keeps roughly the source pixel count rather than the source pixel size', () => {
    // A raster reprojected from degrees to metres with its numeric pixel size
    // carried across becomes 11 metres wide. The count is what transfers.
    const source = ramp(20);
    const toMetres = ([x, y]: Position): Position => [x * 111000, y * 111000];
    const grid = planWarpGrid(source, toMetres)!;

    expect(grid.pixelSize).toBeGreaterThan(1000);
    const pixels = grid.width * grid.height;
    expect(pixels).toBeGreaterThan(source.width * source.height * 0.5);
    expect(pixels).toBeLessThan(source.width * source.height * 2);
  });

  it('samples the edges, not just the corners, so a bend is not clipped', () => {
    // A projection bows the edges outward; a box from four corners cuts the
    // bulge off the middle of each side.
    const source = ramp(10);
    const bowed = ([x, y]: Position): Position => [x, y + Math.sin((x / 10) * Math.PI) * 5];

    const fromCorners = planWarpGrid(source, bowed, 1)!;
    const fromEdges = planWarpGrid(source, bowed, 32)!;

    const cornerTop = fromCorners.geotransform[3];
    const edgeTop = fromEdges.geotransform[3];
    expect(edgeTop).toBeGreaterThan(cornerTop);
  });

  it('returns null rather than a nonsense grid when the transform collapses', () => {
    expect(planWarpGrid(ramp(4), () => [0, 0])).toBeNull();
    expect(planWarpGrid(ramp(4), () => [NaN, NaN])).toBeNull();
  });
});

describe('what the warped raster carries', () => {
  it('drops the statistics rather than carrying stale ones', () => {
    const result = warpRaster(ramp(4), {
      toSource: identity,
      geotransform: [0, 1, 0, 10, 0, -1],
      width: 4,
      height: 4,
      method: 'nearest',
    });
    expect(result.raster!.statistics).toBeUndefined();
  });

  it('takes the target geotransform and size, not the source’s', () => {
    const target: [number, number, number, number, number, number] = [100, 2, 0, 500, 0, -2];
    const result = warpRaster(ramp(10), {
      toSource: identity,
      geotransform: target,
      width: 3,
      height: 7,
      method: 'nearest',
    });
    expect(result.raster!.geotransform).toEqual(target);
    expect(result.raster!.width).toBe(3);
    expect(result.raster!.height).toBe(7);
  });

  it('leaves the source raster untouched', () => {
    const source = ramp(5);
    const before = Array.from(source.bands![0]);
    warpRaster(source, { toSource: identity, geotransform: [0, 2, 0, 10, 0, -2], width: 3, height: 3 });
    expect(Array.from(source.bands![0])).toEqual(before);
    expect(source.width).toBe(5);
  });
});
