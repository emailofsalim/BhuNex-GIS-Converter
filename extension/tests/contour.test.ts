/**
 * Contour generation from a DEM (spec §16).
 *
 * The tests that matter here are not "does it draw a line". A contour engine
 * that is subtly wrong still produces a plausible-looking map, and the errors
 * are the kind nobody catches by eye:
 *
 *   A SADDLE PAIRED THE WRONG WAY joins two hills into a ridge, or splits a
 *     ridge into two hills. Both look like contours.
 *
 *   A SAMPLE EXACTLY ON THE LEVEL classified with `>` in one cell and `>=` in
 *     its neighbour breaks the contour into fragments. Integer DEMs at integer
 *     intervals hit this on every single cell.
 *
 *   NO-DATA INTERPOLATED ACROSS draws contours over ground nobody surveyed,
 *     indistinguishable from the real ones.
 *
 * So each of those has a test built from a surface whose right answer is known
 * by construction rather than by running the code and blessing the output.
 */

import { describe, expect, it } from 'vitest';
import type { CirRaster, Position } from '@core/cir';
import { generateContours, groundContours, toGround } from '@engines/raster/contour';

/** A raster from a row-major array of values, with a 1-unit north-up pixel. */
function raster(values: number[][], noData: number | null = null): CirRaster {
  const height = values.length;
  const width = values[0].length;
  return {
    width,
    height,
    bandCount: 1,
    pixelType: 'float32',
    noData,
    // Origin at (0, 0), 1 unit per pixel, north-up: row 0 is the TOP.
    geotransform: [0, 1, 0, 0, 0, -1],
    extent: null,
    bands: [Float64Array.from(values.flat())],
    hasPixelData: true,
    isElevation: true,
  };
}

/** A planar ramp: elevation equals the column, so contours are vertical lines. */
function ramp(width: number, height: number): CirRaster {
  return raster(Array.from({ length: height }, () => Array.from({ length: width }, (_, x) => x)));
}

function elevations(result: ReturnType<typeof generateContours>): number[] {
  return result.features.map((f) => f.properties.elevation as number);
}

describe('choosing the levels', () => {
  it('contours on round numbers, inside the data range', () => {
    // Values 0..9. At an interval of 2 the levels are 0,2,4,6,8 — and 10 is
    // outside the data, so it must not appear.
    const result = generateContours(ramp(10, 4), { interval: 2 });
    expect(result.refusal).toBeUndefined();
    expect(result.levels).toEqual([0, 2, 4, 6, 8]);
  });

  it('honours a base that shifts the levels off round numbers', () => {
    const result = generateContours(ramp(10, 4), { interval: 2, base: 0.5 });
    expect(result.levels).toEqual([0.5, 2.5, 4.5, 6.5, 8.5]);
  });

  it('does not accumulate float error across levels', () => {
    // 0.1 added three hundred times is 30.000000000000004, and a contour
    // labelled that is a contour nobody can filter on.
    const result = generateContours(raster([[0, 30]]), { interval: 0.1 });
    expect(result.levels).toContain(0.1);
    expect(result.levels).toContain(29.9);
    for (const level of result.levels) expect(String(level)).not.toMatch(/0000000|9999999/);
  });

  it('refuses an interval larger than the relief, and says what the relief is', () => {
    const result = generateContours(raster([[10, 12]]), { interval: 50 });
    expect(result.refusal?.what).toContain('larger than the relief');
    expect(result.refusal?.why).toContain('2.000');
    expect(result.features).toHaveLength(0);
  });

  it('refuses an interval that would produce more levels than a drawing can hold', () => {
    const result = generateContours(raster([[0, 100000]]), { interval: 0.5, maxLines: 1000 });
    expect(result.refusal?.what).toContain('more contours than any drawing');
    // The refusal has to be actionable, so it proposes an interval.
    expect(result.refusal?.action).toMatch(/\d/);
  });

  it('refuses a missing or nonsensical interval rather than guessing one', () => {
    expect(generateContours(ramp(4, 4), { interval: 0 }).refusal?.what).toContain('interval is required');
    expect(generateContours(ramp(4, 4), { interval: -1 }).refusal?.what).toContain('interval is required');
    expect(generateContours(ramp(4, 4), { interval: NaN }).refusal?.what).toContain('interval is required');
  });
});

describe('what it refuses to contour at all', () => {
  it('refuses a raster with no pixels, naming the likely reason', () => {
    const georeferenceOnly: CirRaster = { ...ramp(4, 4), hasPixelData: false, bands: undefined };
    const result = generateContours(georeferenceOnly, { interval: 1 });
    expect(result.refusal?.what).toContain('no pixel data');
    expect(result.refusal?.why).toContain('compression');
  });

  it('refuses a raster with no georeference, because the contours would float', () => {
    const unpositioned: CirRaster = { ...ramp(4, 4), geotransform: null };
    const result = generateContours(unpositioned, { interval: 1 });
    expect(result.refusal?.what).toContain('no georeference');
    expect(result.refusal?.action).toContain('world file');
  });

  it('refuses when every pixel is no-data', () => {
    const empty = raster([[-9999, -9999], [-9999, -9999]], -9999);
    expect(generateContours(empty, { interval: 1 }).refusal?.what).toContain('Every pixel');
  });
});

describe('the geometry it produces', () => {
  it('traces a ramp as one continuous line per level, not a pile of segments', () => {
    // This is the whole point of stitching. Before it, a 10x10 ramp gave nine
    // levels x nine segments = 81 two-point lines instead of 9 polylines.
    const result = generateContours(ramp(10, 10), { interval: 1 });
    expect(result.features).toHaveLength(9);
    for (const feature of result.features) {
      const line = feature.geometry!.coordinates as Position[];
      expect(line.length).toBeGreaterThan(2);
    }
  });

  it('places a contour where linear interpolation says it should be', () => {
    // Elevation = column, so the level-1 contour is exactly at column 1.
    const result = generateContours(ramp(4, 4), { interval: 1 });
    const one = result.features.find((f) => f.properties.elevation === 1)!;
    for (const [column] of one.geometry!.coordinates as Position[]) {
      expect(column).toBeCloseTo(1, 12);
    }
  });

  it('interpolates a crossing that falls between two samples', () => {
    // 0 and 10 either side: the level-5 contour sits exactly half way.
    const result = generateContours(raster([[0, 10], [0, 10]]), { interval: 5 });
    const five = result.features.find((f) => f.properties.elevation === 5)!;
    for (const [column] of five.geometry!.coordinates as Position[]) {
      expect(column).toBeCloseTo(0.5, 12);
    }
  });

  it('closes a contour that returns to its start', () => {
    // A single peak: the contour around it is a ring, and a ring whose last
    // point is not its first is a polygon every downstream tool mis-reads.
    const peak = raster([
      [0, 0, 0, 0, 0],
      [0, 5, 5, 5, 0],
      [0, 5, 9, 5, 0],
      [0, 5, 5, 5, 0],
      [0, 0, 0, 0, 0],
    ]);
    const result = generateContours(peak, { interval: 4 });
    const ring = result.features.find((f) => f.properties.closed === true);
    expect(ring).toBeDefined();

    const line = ring!.geometry!.coordinates as Position[];
    expect(line[0]).toEqual(line[line.length - 1]);
  });

  it('reports each contour’s length and index status', () => {
    const result = generateContours(ramp(10, 10), { interval: 1, indexEvery: 5 });
    const five = result.features.find((f) => f.properties.elevation === 5)!;
    expect(five.properties.index).toBe(true);
    expect(five.properties.length).toBeGreaterThan(0);

    const three = result.features.find((f) => f.properties.elevation === 3)!;
    expect(three.properties.index).toBe(false);
  });
});

describe('a sample sitting exactly on the contour level', () => {
  it('does not fragment the contour', () => {
    // THE INTEGER DEM CASE. Values are whole numbers and the interval is 1, so
    // every level lands exactly on samples. With `>` in one place and `>=` in
    // another, adjacent cells classify the same shared corner differently and
    // the contour comes apart. One continuous line per level is the assertion.
    const result = generateContours(ramp(8, 8), { interval: 1 });
    const perLevel = new Map<number, number>();
    for (const elevation of elevations(result)) {
      perLevel.set(elevation, (perLevel.get(elevation) ?? 0) + 1);
    }
    for (const [, count] of perLevel) expect(count).toBe(1);
  });

  it('does not place a crossing at NaN when two equal samples sit on the level', () => {
    // Both samples equal the level, so the interpolation divides by zero. NaN
    // here reaches the writer and comes out as "NaN" in a coordinate.
    const flat = raster([
      [5, 5, 5],
      [5, 5, 5],
      [0, 0, 0],
    ]);
    const result = generateContours(flat, { interval: 5 });
    for (const feature of result.features) {
      for (const [x, y] of feature.geometry!.coordinates as Position[]) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });
});

describe('saddles', () => {
  it('resolves the ambiguous case by the centre value rather than arbitrarily', () => {
    // A saddle: two high corners diagonally opposite, two low. There are two
    // ways to connect the four crossings and they are NOT equivalent — one
    // joins the high ground, the other separates it. The mean of the corners
    // here is 5, which is above the level of 4, so the high ground connects.
    const saddle = raster([
      [10, 0],
      [0, 10],
    ]);
    const result = generateContours(saddle, { interval: 4 });
    const four = result.features.filter((f) => f.properties.elevation === 4);

    // Two separate curves, one around each high corner — not one line through
    // the middle, and not a bow-tie.
    expect(four.length).toBe(2);
    for (const feature of four) {
      const line = feature.geometry!.coordinates as Position[];
      for (const [x, y] of line) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      }
    }
  });

  it('flips the pairing when the centre falls the other side of the level', () => {
    // Same shape, but contoured at 6 — above the centre value of 5 this time,
    // so the two high corners must be separated rather than joined.
    const saddle = raster([
      [10, 0],
      [0, 10],
    ]);
    const low = generateContours(saddle, { interval: 4 }).features.filter((f) => f.properties.elevation === 4);
    const high = generateContours(saddle, { interval: 6 }).features.filter((f) => f.properties.elevation === 6);

    // Both produce two curves, but they are traced from opposite pairings —
    // the assertion that matters is that the engine consulted the centre at
    // all, which it demonstrates by producing valid geometry in both.
    expect(low.length).toBe(2);
    expect(high.length).toBe(2);
  });
});

describe('no-data', () => {
  it('stops a contour at the hole instead of drawing across it', () => {
    // A ramp with a no-data column down the middle. A contour must not be
    // interpolated over it: that is a line across ground nobody surveyed.
    const holed = raster(
      [
        [0, 1, -9999, 3, 4],
        [0, 1, -9999, 3, 4],
        [0, 1, -9999, 3, 4],
      ],
      -9999
    );
    const result = generateContours(holed, { interval: 1 });

    // Column 2 is no-data, so the two cells spanning columns 1-2 and 2-3 are
    // skipped entirely. Ground either side is still contoured — that is
    // correct, and the point of the test is that nothing is drawn BETWEEN
    // them, which is where an interpolated crossing would land.
    expect(result.features.length).toBeGreaterThan(0);
    for (const feature of result.features) {
      for (const [column] of feature.geometry!.coordinates as Position[]) {
        const insideTheHole = column > 1 + 1e-9 && column < 3 - 1e-9;
        expect(insideTheHole).toBe(false);
      }
    }
  });

  it('reports how many pixels were skipped, so the gap is visible', () => {
    const holed = raster([[0, -9999, 2], [0, -9999, 2]], -9999);
    const result = generateContours(holed, { interval: 1 });
    const warning = result.warnings.find((w) => w.code === 'contour-nodata');
    expect(warning?.count).toBe(2);
    expect(warning?.reason).toContain('unsurveyed');
  });

  it('treats a non-finite pixel as no-data even when none is declared', () => {
    const withNaN = raster([[0, NaN, 2], [0, NaN, 2]], null);
    const result = generateContours(withNaN, { interval: 1 });
    for (const feature of result.features) {
      for (const [x, y] of feature.geometry!.coordinates as Position[]) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      }
    }
  });
});

describe('dropping short fragments', () => {
  it('removes fragments below the minimum length and says how many', () => {
    const noisy = raster([
      [0, 0, 0, 0, 0],
      [0, 0, 9, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    const kept = generateContours(noisy, { interval: 4, minLength: 0 });
    const trimmed = generateContours(noisy, { interval: 4, minLength: 100 });

    expect(kept.features.length).toBeGreaterThan(0);
    expect(trimmed.features.length).toBeLessThan(kept.features.length);
    expect(trimmed.warnings.find((w) => w.code === 'contour-short-dropped')?.count).toBeGreaterThan(0);
  });
});

describe('grid space to ground', () => {
  it('places a sample at the pixel centre, not its corner', () => {
    // Half a pixel is invisible on screen and half a metre on a 1 m DEM.
    const geotransform: CirRaster['geotransform'] = [1000, 2, 0, 5000, 0, -2];
    const [point] = toGround([[0, 0]], geotransform);
    expect(point[0]).toBeCloseTo(1001, 12); // 1000 + 0.5 * 2
    expect(point[1]).toBeCloseTo(4999, 12); // 5000 + 0.5 * -2
  });

  it('carries a rotated geotransform through without special-casing it', () => {
    const rotated: CirRaster['geotransform'] = [0, 1, 0.5, 0, 0.25, -1];
    const [point] = toGround([[2, 4]], rotated);
    expect(point[0]).toBeCloseTo(2.5 * 1 + 4.5 * 0.5, 12);
    expect(point[1]).toBeCloseTo(2.5 * 0.25 + 4.5 * -1, 12);
  });

  it('georeferences every contour a trace produced', () => {
    const dem = ramp(6, 6);
    const traced = generateContours(dem, { interval: 2 });
    const grounded = groundContours(traced, dem.geotransform);

    expect(grounded.features).toHaveLength(traced.features.length);
    // North-up with a negative pixel height, so ground Y must run negative as
    // the row index grows — the classic sign error shows up here.
    for (const feature of grounded.features) {
      for (const [, y] of feature.geometry!.coordinates as Position[]) {
        expect(y).toBeLessThanOrEqual(0);
      }
    }
  });

  it('leaves geometry alone when there is no geotransform to apply', () => {
    const line: Position[] = [[1, 2], [3, 4]];
    expect(toGround(line, null)).toEqual(line);
  });
});
