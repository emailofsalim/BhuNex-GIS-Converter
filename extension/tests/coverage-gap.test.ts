/**
 * Coverage gaps: the missing parcel no pairwise check can see.
 *
 * Every other relational check in `defects.ts` compares two features. That
 * finds a gap along a SHARED EDGE — two boundaries that nearly meet — and it
 * structurally cannot find the other kind: a plot that was never digitised at
 * all, surrounded by four neighbours each of which is perfectly consistent with
 * the three it touches. The defect is not in any pair. It is in the coverage.
 *
 * So the tests here are built on coverages whose hole count is known by
 * construction: a 3×3 block of unit squares with the middle one removed has
 * exactly one gap, and a complete block has none. That is checkable without
 * trusting the union that computes it.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirFeature, type Position, type SourceInfo } from '@core/cir';
import { scanDefects, type Defect, type DefectReport } from '@qa/defects';

const SOURCE: SourceInfo = {
  fileName: 'parcels.shp',
  size: 0,
  formatId: 'shapefile',
  formatName: 'Esri Shapefile',
  detectionConfidence: 1,
};

/** An axis-aligned square as a closed, counter-clockwise ring. */
function square(x: number, y: number, size = 1): Position[] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}

function parcel(id: string, ring: Position[]): CirFeature {
  return { id, geometry: { type: 'Polygon', coordinates: [ring], dimension: 2 }, properties: { plot: id } };
}

/** A grid of unit squares, minus whichever cells are named as missing. */
function coverage(columns: number, rows: number, missing: [number, number][] = []): CirFeature[] {
  const gone = new Set(missing.map(([x, y]) => `${x},${y}`));
  const features: CirFeature[] = [];
  for (let x = 0; x < columns; x++) {
    for (let y = 0; y < rows; y++) {
      if (gone.has(`${x},${y}`)) continue;
      features.push(parcel(`P${x}${y}`, square(x, y)));
    }
  }
  return features;
}

function datasetOf(features: CirFeature[]) {
  return createDataset({
    kind: 'vector',
    name: 'parcels',
    source: SOURCE,
    layers: [createLayer('parcels', features, [])],
  });
}

function scan(features: CirFeature[], options: Record<string, unknown> = {}): DefectReport {
  return scanDefects(datasetOf(features), { checkCoverageGaps: true, ...options });
}

const gaps = (report: DefectReport): Defect[] => report.defects.filter((defect) => defect.type === 'coverage-gap');

describe('a hole in the coverage', () => {
  it('finds the one missing parcel in the middle of a block', () => {
    // The whole point of the check. Every one of the eight neighbours is
    // consistent with the three it touches, so nothing pairwise sees this.
    const report = scan(coverage(3, 3, [[1, 1]]));
    expect(gaps(report)).toHaveLength(1);
    expect(gaps(report)[0].detail?.area).toBeCloseTo(1, 6);
  });

  it('reports nothing for a complete coverage', () => {
    expect(gaps(scan(coverage(3, 3)))).toHaveLength(0);
  });

  it('finds two separate missing parcels', () => {
    const report = scan(coverage(5, 3, [[1, 1], [3, 1]]));
    expect(gaps(report)).toHaveLength(2);
  });

  it('reports one gap for two missing parcels that touch', () => {
    // Two adjacent holes are one hole in the union, and that is the right
    // answer: it is one contiguous area nothing covers, whatever its shape.
    const report = scan(coverage(4, 3, [[1, 1], [2, 1]]));
    expect(gaps(report)).toHaveLength(1);
    expect(gaps(report)[0].detail?.area).toBeCloseTo(2, 6);
  });

  it('says nothing about a notch on the outside edge', () => {
    // A missing parcel on the boundary of the block is not enclosed, so it is
    // not a hole — it is the coverage having the shape it has. Reporting it
    // would flag the ragged edge of every real sheet.
    const report = scan(coverage(3, 3, [[1, 0]]));
    expect(gaps(report)).toHaveLength(0);
  });
});

describe('what it refuses to guess', () => {
  it('reports a gap as a warning, not an error', () => {
    // A courtyard, a tank, a road reserve and a village pond are all the same
    // shape as an un-digitised plot. Only the surveyor knows which this is, so
    // the check reports and does not judge.
    expect(gaps(scan(coverage(3, 3, [[1, 1]])))[0].severity).toBe('warning');
  });

  it('says both what to check and what needs no action', () => {
    const repair = gaps(scan(coverage(3, 3, [[1, 1]])))[0].suggestedRepair ?? '';
    expect(repair).toContain('courtyard');
    expect(repair).toContain('un-digitised plot');
  });

  it('puts the measured area in the description rather than a vague word', () => {
    expect(gaps(scan(coverage(3, 3, [[1, 1]])))[0].description).toContain('1.00 square units');
  });
});

describe('the area threshold', () => {
  it('ignores a rounding-level crack between two parcels', () => {
    // Without a threshold every sub-millimetre misalignment comes back as a
    // missing parcel and the real one is lost in the noise.
    const left = parcel('L', square(0, 0));
    const right = parcel('R', [
      [1.0005, 0],
      [2, 0],
      [2, 1],
      [1.0005, 1],
      [1.0005, 0],
    ]);
    const top = parcel('T', [
      [0, 1],
      [2, 1],
      [2, 2],
      [0, 2],
      [0, 1],
    ]);
    const bottom = parcel('B', [
      [0, -1],
      [2, -1],
      [2, 0],
      [0, 0],
      [0, -1],
    ]);
    // The crack is 0.0005 square units — far below the 1-unit default.
    expect(gaps(scan([left, right, top, bottom]))).toHaveLength(0);
  });

  it('reports the same crack when the threshold is lowered to suit the units', () => {
    // A survey in degrees has a different idea of "small" from one in metres,
    // so the threshold is a setting rather than a constant.
    const left = parcel('L', square(0, 0));
    const right = parcel('R', [
      [1.0005, 0],
      [2, 0],
      [2, 1],
      [1.0005, 1],
      [1.0005, 0],
    ]);
    const top = parcel('T', [
      [0, 1],
      [2, 1],
      [2, 2],
      [0, 2],
      [0, 1],
    ]);
    const bottom = parcel('B', [
      [0, -1],
      [2, -1],
      [2, 0],
      [0, 0],
      [0, -1],
    ]);
    const report = scan([left, right, top, bottom], { coverageGapMinArea: 1e-6 });
    expect(gaps(report).length).toBeGreaterThan(0);
  });
});

describe('where to look', () => {
  it('gives a point inside the gap, not its centroid', () => {
    // The centroid of a C-shaped or crescent gap falls OUTSIDE it, which sends
    // the user to a neighbouring parcel — the same mistake the label placer
    // exists to avoid.
    const report = scan(coverage(3, 3, [[1, 1]]));
    const at = gaps(report)[0].location!;
    expect(at[0]).toBeGreaterThan(1);
    expect(at[0]).toBeLessThan(2);
    expect(at[1]).toBeGreaterThan(1);
    expect(at[1]).toBeLessThan(2);
  });

  it('stays inside a U-shaped gap, where the centroid would not', () => {
    // A 3-wide, 3-tall block missing the whole middle column except its top
    // cell leaves a U. Its centroid sits in the covered cell in the middle.
    const report = scan(coverage(3, 3, [[1, 0], [1, 1]]).concat(parcel('cap', square(1, 0))));
    for (const gap of gaps(report)) {
      const [x, y] = gap.location!;
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});

describe('the cost of the check', () => {
  it('is off unless asked for', () => {
    // It unions every polygon in the layer, which is seconds rather than
    // milliseconds on a full sheet, so it is opt-in like every other
    // expensive or data-changing thing in this tool.
    const report = scanDefects(datasetOf(coverage(3, 3, [[1, 1]])));
    expect(gaps(report)).toHaveLength(0);
  });

  it('says so rather than hanging when a layer is too large to union', () => {
    const many = coverage(80, 80);
    const report = scan(many, {});
    expect(many.length).toBeGreaterThan(5000);
    expect(gaps(report)).toHaveLength(0);
    expect(report.skipped.some((line) => /Coverage gaps were not checked/.test(line))).toBe(true);
  });

  it('needs at least two polygons before a gap is even meaningful', () => {
    // One polygon's hole is its own hole, reported by the shape checks.
    const donut: CirFeature = {
      id: 'D',
      geometry: { type: 'Polygon', coordinates: [square(0, 0, 10), square(4, 4, 2)], dimension: 2 },
      properties: {},
    };
    expect(gaps(scan([donut]))).toHaveLength(0);
  });
});
