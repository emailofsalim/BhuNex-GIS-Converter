/**
 * Clipping a raster to a boundary (spec §16).
 *
 * The errors worth testing here are the ones that produce a file which opens,
 * draws, and is wrong:
 *
 *   FILLING THE OUTSIDE WITH ZERO instead of no-data puts a sea-level plateau
 *     around the site, and every contour and slope computed afterwards honours
 *     it as ground. So a clip with no no-data value must REFUSE.
 *
 *   THE SIGN OF pixelHeight. A north-up raster counts rows downward while
 *     northing counts upward, so the row for maxY is the SMALLER index. Getting
 *     it backwards reports "the boundary does not overlap" for a boundary that
 *     plainly does.
 *
 *   STALE STATISTICS. A min carried over from before the clip reads as real
 *     ground and silently rescales every colour ramp downstream.
 */

import { describe, expect, it } from 'vitest';
import type { CirRaster, Position } from '@core/cir';
import { clipRaster } from '@engines/raster/clip';

/** A north-up raster: origin top-left, 1 unit pixels, row 0 is the TOP. */
function raster(values: number[][], noData: number | null = -9999): CirRaster {
  const height = values.length;
  const width = values[0].length;
  return {
    width,
    height,
    bandCount: 1,
    pixelType: 'float32',
    noData,
    geotransform: [0, 1, 0, 10, 0, -1],
    extent: null,
    bands: [Float64Array.from(values.flat())],
    hasPixelData: true,
    statistics: [{ min: Math.min(...values.flat()), max: Math.max(...values.flat()) }],
  };
}

/** A 10x10 grid whose value is its own index, so a pixel can be identified. */
function grid(): CirRaster {
  return raster(Array.from({ length: 10 }, (_, row) => Array.from({ length: 10 }, (_, col) => row * 10 + col)));
}

/** An axis-aligned box as a closed ring. */
function box(minX: number, minY: number, maxX: number, maxY: number): Position[][][] {
  return [[[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]];
}

function values(result: ReturnType<typeof clipRaster>): number[] {
  return Array.from(result.raster!.bands![0]);
}

describe('what a clip refuses', () => {
  it('refuses without a no-data value, and says why zero is not a substitute', () => {
    // The whole point. Filling with 0 gives a DEM a sea-level plateau around
    // the site, and the contour engine will happily contour it.
    const noNoData = raster([[1, 2], [3, 4]], null);
    const result = clipRaster(noNoData, { polygons: box(0, 8, 1, 10) });

    expect(result.refusal?.what).toContain('no no-data value');
    expect(result.refusal?.why).toContain('sea-level plateau');
    expect(result.raster).toBeUndefined();
  });

  it('accepts a no-data value supplied for the operation when the file has none', () => {
    const noNoData = raster([[1, 2], [3, 4]], null);
    const result = clipRaster(noNoData, { polygons: box(0, 8, 1, 10), noData: -1 });
    expect(result.refusal).toBeUndefined();
    expect(result.raster!.noData).toBe(-1);
  });

  it('refuses a raster with no pixels', () => {
    const structureOnly: CirRaster = { ...grid(), hasPixelData: false, bands: undefined };
    expect(clipRaster(structureOnly, { polygons: box(0, 0, 5, 5) }).refusal?.what).toContain('no pixel data');
  });

  it('refuses a raster with no georeference', () => {
    const unpositioned: CirRaster = { ...grid(), geotransform: null };
    expect(clipRaster(unpositioned, { polygons: box(0, 0, 5, 5) }).refusal?.what).toContain('no georeference');
  });

  it('refuses a boundary that is not a closed ring', () => {
    const result = clipRaster(grid(), { polygons: [[[[0, 0], [1, 1]]]] });
    expect(result.refusal?.what).toContain('No usable boundary');
    expect(result.refusal?.action).toContain('polygonisation');
  });

  it('refuses a boundary that misses the raster, and names the likely cause', () => {
    // Different CRS is the reason this happens, and it is worth saying so:
    // both files look correct on their own.
    const result = clipRaster(grid(), { polygons: box(500000, 4000000, 500100, 4000100), crop: true });
    expect(result.refusal?.what).toContain('does not overlap');
    expect(result.refusal?.why).toContain('coordinate systems');
  });
});

describe('which pixels survive', () => {
  it('keeps a pixel when its centre is inside the boundary', () => {
    // Pixel (0,0) centres at (0.5, 9.5) because the origin is top-left and the
    // pixel height is negative. A box over the top-left 2x2 keeps exactly four.
    const result = clipRaster(grid(), { polygons: box(0, 8, 2, 10) });
    expect(result.kept).toBe(4);
    expect(result.blanked).toBe(96);
  });

  it('blanks the pixels outside, with the no-data value', () => {
    const result = clipRaster(grid(), { polygons: box(0, 8, 2, 10) });
    const out = values(result);
    // Kept: rows 0-1, columns 0-1 → source values 0, 1, 10, 11.
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(out[10]).toBe(10);
    expect(out[11]).toBe(11);
    // Everything else is no-data, not zero.
    expect(out[5]).toBe(-9999);
    expect(out[99]).toBe(-9999);
  });

  it('never writes zero for "outside", because zero is a real elevation', () => {
    const result = clipRaster(grid(), { polygons: box(0, 8, 2, 10) });
    const out = values(result);
    // Index 0 legitimately holds the value 0 — every OTHER zero would be a bug.
    const zeros = out.filter((v) => v === 0);
    expect(zeros).toHaveLength(1);
  });

  it('includes partly covered pixels when asked, and says which rule it used', () => {
    const strict = clipRaster(grid(), { polygons: box(0, 8, 2, 10) });
    const generous = clipRaster(grid(), { polygons: box(0, 8, 2, 10), touched: true });

    expect(generous.kept).toBeGreaterThan(strict.kept);
    expect(strict.warnings.find((w) => w.code === 'clip-applied')?.reason).toContain('CENTRE');
    expect(generous.warnings.find((w) => w.code === 'clip-applied')?.reason).toContain('any part');
  });

  it('excludes pixels inside a hole', () => {
    const withHole: Position[][][] = [
      [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[2, 2], [5, 2], [5, 5], [2, 5], [2, 2]],
      ],
    ];
    const full = clipRaster(grid(), { polygons: [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]] });
    const holed = clipRaster(grid(), { polygons: withHole });

    expect(full.kept).toBe(100);
    expect(holed.kept).toBeLessThan(100);
    expect(holed.blanked).toBeGreaterThan(0);
  });

  it('warns when the boundary keeps nothing at all', () => {
    // Overlaps the grid's extent but falls between pixel centres nowhere —
    // a boundary far smaller than one pixel, in a corner.
    const result = clipRaster(grid(), { polygons: box(0, 0, 0.1, 0.1) });
    expect(result.kept).toBe(0);
    expect(result.warnings.find((w) => w.code === 'clip-empty')?.reason).toContain('coordinate systems');
  });
});

describe('cropping to the boundary', () => {
  it('shrinks the grid to the boundary’s extent', () => {
    const result = clipRaster(grid(), { polygons: box(0, 8, 2, 10), crop: true });
    expect(result.raster!.width).toBeLessThan(10);
    expect(result.raster!.height).toBeLessThan(10);
    expect(result.raster!.bands![0].length).toBe(result.raster!.width * result.raster!.height);
  });

  it('moves the origin to the cropped corner rather than leaving it behind', () => {
    // A cropped raster whose geotransform still points at the old origin is
    // georeferenced wrong by the size of the crop, and looks fine on its own.
    const result = clipRaster(grid(), { polygons: box(3, 3, 6, 6), crop: true });
    const [originX, , , originY] = result.raster!.geotransform!;
    expect(originX).toBeGreaterThan(0);
    expect(originY).toBeLessThan(10);
  });

  it('handles the negative pixel height without inverting the window', () => {
    // A north-up raster counts rows down and northing up, so maxY is the
    // SMALLER row index. Getting the sign wrong here produces an empty window
    // and reports "does not overlap" for a boundary that plainly does.
    const result = clipRaster(grid(), { polygons: box(2, 2, 8, 8), crop: true });
    expect(result.refusal).toBeUndefined();
    expect(result.raster!.width).toBeGreaterThan(0);
    expect(result.raster!.height).toBeGreaterThan(0);
    expect(result.kept).toBeGreaterThan(0);
  });

  it('keeps the full grid when cropping is not asked for', () => {
    const result = clipRaster(grid(), { polygons: box(3, 3, 6, 6) });
    expect(result.raster!.width).toBe(10);
    expect(result.raster!.height).toBe(10);
  });

  it('clips a rotated raster but refuses to crop it, and says why', () => {
    const rotated: CirRaster = { ...grid(), geotransform: [0, 1, 0.2, 10, 0.1, -1] };
    const result = clipRaster(rotated, { polygons: box(0, 8, 3, 10), crop: true });

    expect(result.refusal).toBeUndefined();
    expect(result.raster!.width).toBe(10);
    expect(result.warnings.find((w) => w.code === 'clip-rotated-no-crop')?.reason).toContain('resampled');
  });
});

describe('what the result carries', () => {
  it('drops the statistics rather than carrying stale ones', () => {
    // A min of 0 from before the clip reads as real ground and rescales every
    // colour ramp downstream. Absent is better than wrong.
    const result = clipRaster(grid(), { polygons: box(0, 8, 2, 10) });
    expect(result.raster!.statistics).toBeUndefined();
  });

  it('counts what it kept and what it blanked', () => {
    const result = clipRaster(grid(), { polygons: box(0, 8, 2, 10) });
    expect(result.kept + result.blanked).toBe(100);
    const applied = result.warnings.find((w) => w.code === 'clip-applied');
    expect(applied?.message).toContain('96');
    expect(applied?.count).toBe(96);
  });

  it('leaves the source raster untouched', () => {
    const source = grid();
    const before = Array.from(source.bands![0]);
    clipRaster(source, { polygons: box(0, 8, 2, 10) });
    expect(Array.from(source.bands![0])).toEqual(before);
    expect(source.width).toBe(10);
  });
});
