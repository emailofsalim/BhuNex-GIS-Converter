/**
 * The QA verdict must be true in BOTH directions.
 *
 * Two defects met here, and each one alone would have been caught by the other's
 * absence — which is why neither was.
 *
 *   THE RE-IMPORT NEVER RAN for a packaged target. `runQa` unzipped `files[0]`
 *     whenever `target.packaging === 'zip'`, but a shapefile arrives there as
 *     the LOOSE .shp/.shx/.dbf/.prj the writer produced; the ZIP is built later,
 *     at delivery. `readZip` threw, the throw was caught, and every shapefile
 *     export reported "NOT VALIDATED — output written but not verified".
 *
 *   THE DRIFT CHECK WAS WRONG. It compared vertices index-wise. A shapefile's
 *     outer ring must wind CLOCKWISE where GeoJSON's winds counter-clockwise,
 *     so the writer correctly reverses it — and the check read a perfectly
 *     round-tripped 50 m parcel as having drifted 50 m, on the same run where
 *     it confirmed the bounds and vertex count identical.
 *
 * Fixing only the first turns a silent gap into a false FAILED on correct bytes,
 * which is worse. So these tests pin both ends: a correct round trip must PASS,
 * and a coordinate that genuinely moved must still be caught.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';
import { compareVector } from '@qa/fidelity';
import { createLayer, type CirDataset, type CirFeature } from '@core/cir';

const PARCELS = JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32644' } },
  features: Array.from({ length: 12 }, (_, i) => {
    const column = i % 4;
    const row = Math.floor(i / 4);
    const x = 412000 + column * 60;
    const y = 2591300 + row * 55;
    return {
      type: 'Feature',
      properties: { plot_no: `${12 + i}/A` },
      geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 50, y], [x + 50, y + 45], [x, y + 45], [x, y]]] },
    };
  }),
});

describe('a packaged target is actually re-imported and checked', () => {
  it('verifies a shapefile round trip instead of skipping it', async () => {
    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(PARCELS) },
      targetFormatId: 'shapefile',
    });

    // The specific failure this replaces: "not-validated" with the summary
    // "Re-import failed: ... has no ZIP signature".
    expect(result.qa.verdict).not.toBe('not-validated');
    expect(result.qa.summary).not.toMatch(/ZIP signature/i);

    const drift = result.qa.checks.find((check) => check.name === 'Max coordinate drift');
    expect(drift?.status).toBe('pass');
    expect(result.qa.verdict).toBe('PASS');
  });

  it('still round-trips MIF/MID, the other loose-file package', async () => {
    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(PARCELS) },
      targetFormatId: 'mifmid',
    });
    expect(result.qa.summary).not.toMatch(/ZIP signature/i);
  });
});

function polygon(coordinates: number[][]): CirFeature {
  return { geometry: { type: 'Polygon', coordinates: [coordinates], dimension: 2 }, properties: {} };
}

function datasetOf(features: CirFeature[]): CirDataset {
  return { kind: 'vector', name: 'd', layers: [createLayer('d', features, [])], warnings: [] } as unknown as CirDataset;
}

describe('the drift check, in both directions', () => {
  const ring = [[0, 0], [50, 0], [50, 45], [0, 45], [0, 0]];

  it('does not report drift for a ring the writer legitimately reversed', () => {
    // Exactly what a shapefile writer does to an outer ring. Same parcel.
    const reversed = [...ring].reverse();
    const report = compareVector(datasetOf([polygon(ring)]), datasetOf([polygon(reversed)]));
    const drift = report.checks.find((check) => check.name === 'Max coordinate drift');

    expect(drift?.status).toBe('pass');
    expect(Number(drift?.target)).toBeCloseTo(0, 6);
  });

  it('is winding-invariant on an OPEN ring too, where there is no closing duplicate', () => {
    const open = [[0, 0], [50, 0], [50, 45], [0, 45]];
    const drift = compareVector(
      datasetOf([{ geometry: { type: 'LineString', coordinates: open, dimension: 2 }, properties: {} }]),
      datasetOf([{ geometry: { type: 'LineString', coordinates: [...open].reverse(), dimension: 2 }, properties: {} }])
    ).checks.find((check) => check.name === 'Max coordinate drift');

    expect(drift?.status).toBe('pass');
  });

  it('does NOT claim invariance to a re-started ring — the documented limit', () => {
    // A closed ring repeats its first vertex, so rotating the start genuinely
    // changes the coordinate multiset. This is pinned so the limitation stays
    // visible rather than being discovered as a surprise later; no writer here
    // re-starts rings, which is why it is left as-is.
    const rotated = [[50, 0], [50, 45], [0, 45], [0, 0], [50, 0]];
    const drift = compareVector(datasetOf([polygon(ring)]), datasetOf([polygon(rotated)])).checks.find(
      (check) => check.name === 'Max coordinate drift'
    );

    expect(drift?.status).toBe('fail');
  });

  it('STILL CATCHES a coordinate that genuinely moved', () => {
    // One corner pushed 3 m east: a real error, and the whole reason the check
    // exists. Relaxing the comparison must not relax this.
    const moved = [[0, 0], [53, 0], [50, 45], [0, 45], [0, 0]];
    const drift = compareVector(datasetOf([polygon(ring)]), datasetOf([polygon(moved)])).checks.find(
      (check) => check.name === 'Max coordinate drift'
    );

    expect(drift?.status).toBe('fail');
    expect(Number(drift?.target)).toBeGreaterThan(1);
  });

  it('catches a whole feature shifted, not just one vertex', () => {
    const shifted = ring.map(([x, y]) => [x + 2, y + 2]);
    const drift = compareVector(datasetOf([polygon(ring)]), datasetOf([polygon(shifted)])).checks.find(
      (check) => check.name === 'Max coordinate drift'
    );
    expect(drift?.status).toBe('fail');
  });
});
