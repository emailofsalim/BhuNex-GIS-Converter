/**
 * A degree is not a metre, and "3 decimals" does not mean millimetres in both.
 *
 * THE DEFECT
 *
 * `fixedPrecision(n)` set linear, geographic AND elevation decimals to the same
 * `n`. The workspace builds its policy from it with the user's "Output
 * precision" setting, which defaults to 3 and is labelled "3 decimals
 * (millimetre)" — true of metres, and 0.001° ≈ 111 METRES in degrees.
 *
 * Every workspace export to a format that imposes WGS 84 — KML, KMZ, GPX, OSM
 * — therefore wrote coordinates rounded onto a 111 m grid. A cadastral plot of
 * a few tens of metres does not survive that: every vertex lands on one or two
 * grid nodes and the parcel comes back a blocky rectangle. That is the
 * "geometry becomes like square" a user reported from Google Earth, and it
 * reproduced here as a twelve-vertex boundary written as `23.429 80.139` over
 * and over.
 *
 * WHY NOTHING CAUGHT IT
 *
 * Three suites cover these conversions and all three passed. The conversion
 * matrix asserts feature COUNTS — a collapsed parcel is still one feature. The
 * QA re-import compares the output against the source through the same rounding
 * and agrees with itself. And the pipeline's own default, `SURVEY_DEFAULT_
 * PRECISION`, has the correct 7 decimals — so every test that did not go
 * through the workspace's settings was testing a path the user never uses.
 *
 * These tests go through `fixedPrecision`, the workspace's path, and assert
 * SHAPE rather than counts.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';
import { crsFromEpsg } from '@crs/epsg';
import { fixedPrecision, SURVEY_DEFAULT_PRECISION } from '@core/precision';

const UTM44N = crsFromEpsg(32644);
const E = 412000;
const N = 2591300;

/** An irregular parcel about 60 m across — smaller than the old 111 m grid. */
const RING = [
  [E, N], [E + 37, N + 4], [E + 52, N + 21], [E + 48, N + 44], [E + 61, N + 63],
  [E + 40, N + 78], [E + 19, N + 71], [E + 7, N + 55], [E + 14, N + 38],
  [E + 3, N + 25], [E + 11, N + 12], [E, N],
];

const SOURCE = JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32644' } },
  features: [{ type: 'Feature', properties: { plot: '890' }, geometry: { type: 'Polygon', coordinates: [RING] } }],
});

describe('the policy translates the request into the output unit', () => {
  it('gives degrees the decimals they need for the same ground resolution', () => {
    // THE FIX. A metre asked for at 3 dp is a millimetre; a degree at 3 dp is
    // 111 m, which is not a rounding, it is a demolition.
    expect(fixedPrecision(3).linearDecimals).toBe(3);
    expect(fixedPrecision(3).geographicDecimals).toBe(8);
    expect(fixedPrecision(6).geographicDecimals).toBe(11);
  });

  it('never drops geographic precision below the documented floor', () => {
    // Asking for a coarse output is a request about FILE SIZE. Nobody making it
    // means "throw the shape away".
    expect(fixedPrecision(0).geographicDecimals).toBeGreaterThanOrEqual(7);
    expect(fixedPrecision(1).geographicDecimals).toBeGreaterThanOrEqual(7);
  });

  it('agrees with the survey default it is meant to generalise', () => {
    expect(fixedPrecision(3).geographicDecimals).toBeGreaterThanOrEqual(
      SURVEY_DEFAULT_PRECISION.geographicDecimals
    );
  });
});

describe('a parcel survives the workspace precision setting', () => {
  /** Distinct coordinate pairs in the KML, which is what collapsing destroys. */
  async function distinctVertices(decimals: number): Promise<number> {
    const result: any = await convert({
      input: { fileName: 'parcel.geojson', bytes: new TextEncoder().encode(SOURCE) },
      targetFormatId: 'kml',
      // EXACTLY what `workspace/conversion.ts` builds from the settings.
      settings: { sourceCrs: UTM44N, precision: fixedPrecision(decimals) },
    } as never);
    const text = new TextDecoder().decode(result.outputs[0].bytes as Uint8Array);
    const block = text.match(/<coordinates>([\s\S]*?)<\/coordinates>/)?.[1] ?? '';
    return new Set(block.trim().split(/\s+/).filter(Boolean)).size;
  }

  it('keeps every distinct vertex at the default setting', async () => {
    // Eleven distinct corners plus the repeated closing vertex. Before the fix
    // this came back as 2 — the parcel had become a rectangle.
    expect(await distinctVertices(3)).toBe(11);
  });

  it('keeps them at every precision the workspace offers', async () => {
    for (const decimals of [3, 4, 5, 6]) {
      expect(await distinctVertices(decimals), `precision ${decimals} collapsed the parcel`).toBe(11);
    }
  });
});
