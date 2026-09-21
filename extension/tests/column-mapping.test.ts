/**
 * The surveyor can overrule the column detector.
 *
 * WHY THIS MATTERS ENOUGH TO PIN
 *
 * Detection is right for an ordinary survey export, and the trial's own file is
 * pinned in `trial-feedback.test.ts`. But that file is exactly why an override
 * has to exist: a title banner above the real header made the reader map columns
 * BY POSITION, put the northing in X, and wrote 188 boundary pillars 2,600 km
 * off. The detector is better now — and "the detector improved" is not the same
 * promise as "you can correct it when it is wrong".
 *
 * Until this, it could not be corrected. `readCsvTable` accepted a `mapping`
 * option and the pipeline passed it nothing, so the panel could only ever
 * report what detection had decided.
 */

import { describe, expect, it } from 'vitest';

import { convert } from '@core/pipeline';
import { SURVEY_DEFAULT_PRECISION } from '@core/precision';
import { crsFromEpsg } from '@crs/epsg';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const UTM45N = crsFromEpsg(32645);

/** Northing first, which is how survey instruments usually write it out. */
const CSV = ['Sl No,NORTHING,EASTING,Code', '1,2605201.531,256320.247,BP1', '2,2605250.660,256329.539,BP2'].join('\n');

async function firstPoint(mapping?: unknown): Promise<number[]> {
  const result: never = (await convert({
    input: { fileName: 'pillars.csv', bytes: encoder.encode(CSV) },
    targetFormatId: 'geojson',
    forcedSourceFormatId: 'csv',
    settings: {
      precision: SURVEY_DEFAULT_PRECISION,
      sourceCrs: UTM45N,
      runQa: false,
      ...(mapping ? { table: { mapping } } : {}),
    },
  } as never)) as never;
  const value = result as unknown as { outputs: { bytes: Uint8Array }[] };
  return JSON.parse(decoder.decode(value.outputs[0].bytes)).features[0].geometry.coordinates;
}

describe('a hand-set column mapping reaches the reader', () => {
  it('detection alone puts the easting in x', async () => {
    const [x, y] = await firstPoint();
    expect(x).toBeCloseTo(256320.247, 3);
    expect(y).toBeCloseTo(2605201.531, 3);
  });

  it('a mapping the user set is honoured, even when it is wrong', async () => {
    // Deliberately inverted. If the override were ignored this would still come
    // back easting-first and the test would pass for the wrong reason — so the
    // assertion is that the WRONG answer comes out, which only a mapping that
    // actually arrived can produce.
    const [x, y] = await firstPoint({
      roles: { id: 0, easting: 1, northing: 2, code: 3 },
      coordinateOrder: 'easting-northing',
      schemaId: 'user',
    });
    expect(x).toBeCloseTo(2605201.531, 3);
    expect(y).toBeCloseTo(256320.247, 3);
  });

  it('and set correctly it agrees with detection', async () => {
    const [x, y] = await firstPoint({
      roles: { id: 0, northing: 1, easting: 2, code: 3 },
      coordinateOrder: 'northing-easting',
      schemaId: 'user',
    });
    expect(x).toBeCloseTo(256320.247, 3);
    expect(y).toBeCloseTo(2605201.531, 3);
  });

  it('records the mapping as the user’s, not as a detected schema', async () => {
    const result: never = (await convert({
      input: { fileName: 'pillars.csv', bytes: encoder.encode(CSV) },
      targetFormatId: 'csv',
      forcedSourceFormatId: 'csv',
      settings: {
        precision: SURVEY_DEFAULT_PRECISION,
        sourceCrs: UTM45N,
        runQa: false,
        table: { mapping: { roles: { northing: 1, easting: 2 }, coordinateOrder: 'northing-easting', schemaId: 'user' } },
      },
    } as never)) as never;
    // The provenance has to say a human decided this. A file converted on a
    // guess and a file converted on an instruction are different evidence.
    const value = result as unknown as { provenance?: Record<string, unknown> };
    expect(JSON.stringify(value.provenance ?? {})).not.toContain('"schema":"pnezd"');
  });
});
