/**
 * Rasterize and vectorize (spec §16).
 *
 * The failure that makes vectorize worth testing carefully is not a crash. It
 * is the naive version working: one square per pixel, sixteen million polygons
 * from a 4000x4000 raster, and every internal edge between two cells of the
 * same class drawn as a boundary that does not exist on the ground. It opens
 * (barely), it draws, and it is wrong in a way that looks like detail.
 *
 * So the tests are built around surfaces whose correct region count is known by
 * construction, and they assert the MERGE rather than the pixel count.
 */

import { describe, expect, it } from 'vitest';
import type { CirRaster, Position } from '@core/cir';
import { rasterizePolygons, vectorizeRaster } from '@engines/raster/vectorize';

/** North-up: origin top-left at (0, 10), 1-unit pixels. */
function raster(values: number[][], extra: Partial<CirRaster> = {}): CirRaster {
  const height = values.length;
  const width = values[0].length;
  return {
    width,
    height,
    bandCount: 1,
    pixelType: 'int16',
    noData: -9999,
    geotransform: [0, 1, 0, 10, 0, -1],
    extent: null,
    bands: [Float64Array.from(values.flat())],
    hasPixelData: true,
    isElevation: false,
    ...extra,
  };
}

function ring(minX: number, minY: number, maxX: number, maxY: number): Position[] {
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]];
}

describe('vectorize merges cells rather than emitting one square per pixel', () => {
  it('turns a block of equal cells into ONE polygon', () => {
    // The whole point. Nine cells of class 1 are one field, not nine squares.
    const result = vectorizeRaster(
      raster([
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ])
    );

    expect(result.refusal).toBeUndefined();
    expect(result.features).toHaveLength(1);
    expect(result.features[0].properties.value).toBe(1);
    expect(result.features[0].properties.cells).toBe(9);
  });

  it('separates regions of different values', () => {
    const result = vectorizeRaster(
      raster([
        [1, 1, 2, 2],
        [1, 1, 2, 2],
      ])
    );
    expect(result.features).toHaveLength(2);
    expect(result.features.map((f) => f.properties.value).sort()).toEqual([1, 2]);
  });

  it('separates two regions that share a value but not an edge', () => {
    // Same class, not connected: two fields of wheat are two parcels.
    const result = vectorizeRaster(
      raster([
        [1, 0, 1],
        [1, 0, 1],
      ])
    );
    const ones = result.features.filter((f) => f.properties.value === 1);
    expect(ones).toHaveLength(2);
  });

  it('emits a boundary with no internal edges', () => {
    // A 3x3 block traced per-pixel would have 24 edges; merged it has 4 sides,
    // and after collinear simplification 5 points (the last repeats the first).
    const result = vectorizeRaster(
      raster([
        [7, 7, 7],
        [7, 7, 7],
        [7, 7, 7],
      ])
    );
    const shell = (result.features[0].geometry!.coordinates as Position[][])[0];
    expect(shell).toHaveLength(5);
    expect(shell[0]).toEqual(shell[shell.length - 1]);
  });

  it('drops collinear vertices along a straight run', () => {
    // A 1x8 strip has eight cell edges along each long side; keeping them all
    // makes the file large and the geometry no more accurate.
    const result = vectorizeRaster(raster([[3, 3, 3, 3, 3, 3, 3, 3]]));
    const shell = (result.features[0].geometry!.coordinates as Position[][])[0];
    expect(shell.length).toBeLessThanOrEqual(6);
  });

  it('skips no-data rather than making it a region', () => {
    const result = vectorizeRaster(
      raster([
        [1, -9999],
        [1, -9999],
      ])
    );
    expect(result.features).toHaveLength(1);
    expect(result.features[0].properties.value).toBe(1);
  });

  it('honours an explicit skip value over the raster’s no-data', () => {
    const result = vectorizeRaster(raster([[1, 2], [1, 2]]), { skipValue: 2 });
    expect(result.features).toHaveLength(1);
    expect(result.features[0].properties.value).toBe(1);
  });

  it('georeferences the boundary into ground coordinates', () => {
    // Corners, not centres: a region boundary runs BETWEEN cells, so there is
    // no half-pixel shift here — unlike a contour, which samples at centres.
    const result = vectorizeRaster(raster([[5, 5], [5, 5]]));
    const shell = (result.features[0].geometry!.coordinates as Position[][])[0];
    const xs = shell.map(([x]) => x);
    const ys = shell.map(([, y]) => y);
    expect(Math.min(...xs)).toBeCloseTo(0, 9);
    expect(Math.max(...xs)).toBeCloseTo(2, 9);
    expect(Math.max(...ys)).toBeCloseTo(10, 9);
    expect(Math.min(...ys)).toBeCloseTo(8, 9);
  });

  it('reports the region count and why cells were merged', () => {
    const result = vectorizeRaster(raster([[1, 1], [2, 2]]));
    const done = result.warnings.find((w) => w.code === 'vectorize-done');
    expect(done?.message).toContain('2 region');
    expect(done?.reason).toContain('not boundaries on the ground');
  });
});

describe('what vectorize refuses', () => {
  it('refuses an elevation raster, and names the two things that do work', () => {
    // A DEM has a different value in almost every cell, so every cell becomes
    // its own region. Quantising it silently would invent classes.
    const dem = raster([[1.1, 2.2], [3.3, 4.4]], { isElevation: true });
    const result = vectorizeRaster(dem);
    expect(result.refusal?.what).toContain('continuous rather than classified');
    expect(result.refusal?.action).toContain('contour');
    expect(result.refusal?.action).toContain('classify');
  });

  it('vectorizes a zone map even when the reader guessed "elevation"', () => {
    // The ASCII grid format cannot say whether a grid holds heights or class
    // codes, so the reader assumes elevation — right for most .asc files and
    // wrong for a zone map. Three whole numbers are a classification whatever
    // the flag says, and refusing on the strength of the guess would make the
    // commonest .asc zone map unvectorizable.
    const zones = raster([[1, 1, 2], [1, 3, 2]], { isElevation: true });
    const result = vectorizeRaster(zones);

    expect(result.refusal).toBeUndefined();
    expect(result.features.length).toBeGreaterThan(0);
    // And it says it overrode the flag, rather than doing it silently.
    expect(result.warnings.find((w) => w.code === 'vectorize-elevation-classified')?.action).toContain('contour');
  });

  it('refuses a raster with too many distinct values even when not marked elevation', () => {
    // The marker is a hint, not a guarantee. The value count is the evidence.
    const many = Array.from({ length: 40 }, (_, row) =>
      Array.from({ length: 40 }, (_, column) => row * 40 + column)
    );
    const result = vectorizeRaster(raster(many));
    expect(result.refusal?.what).toContain('one polygon per pixel');
    expect(result.refusal?.why).toContain('measurements rather than categories');
  });

  it('refuses a raster with no pixels', () => {
    const structureOnly: CirRaster = { ...raster([[1]]), hasPixelData: false, bands: undefined };
    expect(vectorizeRaster(structureOnly).refusal?.what).toContain('no pixel data');
  });

  it('refuses a raster with no georeference', () => {
    const unpositioned: CirRaster = { ...raster([[1, 1], [1, 1]]), geotransform: null };
    expect(vectorizeRaster(unpositioned).refusal?.what).toContain('no georeference');
  });

  it('refuses when there are more regions than a vector file can hold', () => {
    // A checkerboard: every cell is its own region, which is the worst case.
    const checker = Array.from({ length: 30 }, (_, row) =>
      Array.from({ length: 30 }, (_, column) => (row + column) % 2)
    );
    const result = vectorizeRaster(raster(checker), { maxRegions: 50 });
    expect(result.refusal?.what).toContain('more regions');
    expect(result.refusal?.action).toContain('fewer categories');
  });

  it('warns rather than refusing when everything is no-data', () => {
    const empty = raster([[-9999, -9999], [-9999, -9999]]);
    const result = vectorizeRaster(empty);
    expect(result.features).toHaveLength(0);
    expect(result.warnings.find((w) => w.code === 'vectorize-empty')).toBeDefined();
  });
});

describe('rasterize', () => {
  const grid = {
    width: 10,
    height: 10,
    geotransform: [0, 1, 0, 10, 0, -1] as [number, number, number, number, number, number],
  };

  it('burns a polygon into the cells its centres cover', () => {
    const result = rasterizePolygons({
      ...grid,
      polygons: [{ rings: [ring(0, 8, 2, 10)], value: 5 }],
    });
    expect(result.refusal).toBeUndefined();
    expect(result.burned).toBe(4);
    expect(result.raster!.bands![0][0]).toBe(5);
    expect(result.raster!.bands![0][99]).toBe(-9999);
  });

  it('lets the last polygon win where they overlap', () => {
    // Predictable beats clever: refusing on overlap makes a cadastral layer
    // with one shared boundary impossible, and averaging invents a class.
    const result = rasterizePolygons({
      ...grid,
      polygons: [
        { rings: [ring(0, 0, 10, 10)], value: 1 },
        { rings: [ring(0, 8, 2, 10)], value: 2 },
      ],
    });
    expect(result.raster!.bands![0][0]).toBe(2);
    expect(result.raster!.bands![0][99]).toBe(1);
    expect(result.warnings[0].action).toContain('last one in the layer wins');
  });

  it('leaves the inside of a hole as background', () => {
    const result = rasterizePolygons({
      ...grid,
      polygons: [{ rings: [ring(0, 0, 10, 10), ring(3, 3, 7, 7)], value: 4 }],
    });
    // The centre of the hole is background; a corner of the shell is burned.
    const middle = result.raster!.bands![0][5 * 10 + 5];
    expect(middle).toBe(-9999);
    expect(result.raster!.bands![0][0]).toBe(4);
  });

  it('includes partly covered cells when asked', () => {
    const strict = rasterizePolygons({ ...grid, polygons: [{ rings: [ring(0, 8, 2, 10)], value: 1 }] });
    const generous = rasterizePolygons({
      ...grid,
      polygons: [{ rings: [ring(0, 8, 2, 10)], value: 1 }],
      touched: true,
    });
    expect(generous.burned).toBeGreaterThan(strict.burned);
  });

  it('does not mark the result as elevation', () => {
    // The values are class codes. Marking it elevation would let the contour
    // engine offer to contour a category.
    const result = rasterizePolygons({ ...grid, polygons: [{ rings: [ring(0, 0, 5, 5)], value: 3 }] });
    expect(result.raster!.isElevation).toBe(false);
  });

  it('refuses an empty polygon list and an empty grid', () => {
    expect(rasterizePolygons({ ...grid, polygons: [] }).refusal?.what).toContain('No polygons');
    expect(
      rasterizePolygons({ ...grid, width: 0, polygons: [{ rings: [ring(0, 0, 1, 1)], value: 1 }] }).refusal?.what
    ).toContain('no size');
  });
});

describe('rasterize and vectorize are inverses, within a cell', () => {
  it('round-trips a block through both and gets the shape back', () => {
    const burned = rasterizePolygons({
      width: 10,
      height: 10,
      geotransform: [0, 1, 0, 10, 0, -1],
      polygons: [{ rings: [ring(2, 2, 6, 6)], value: 9 }],
    });

    const back = vectorizeRaster(burned.raster!);
    expect(back.features).toHaveLength(1);
    expect(back.features[0].properties.value).toBe(9);

    const shell = (back.features[0].geometry!.coordinates as Position[][])[0];
    const xs = shell.map(([x]) => x);
    const ys = shell.map(([, y]) => y);
    // Back to the original box, to within the cell size the raster imposes.
    expect(Math.min(...xs)).toBeCloseTo(2, 6);
    expect(Math.max(...xs)).toBeCloseTo(6, 6);
    expect(Math.min(...ys)).toBeCloseTo(2, 6);
    expect(Math.max(...ys)).toBeCloseTo(6, 6);
  });
});
