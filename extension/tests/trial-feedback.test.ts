/**
 * Regressions built from a real trial, on the operator's own files.
 *
 * Three deliverables were converted and the results handed back: a 3.9 MB mining
 * DXF, a 1,025-feature cadastral KMZ, and a 188-point boundary-pillar CSV. Two
 * defects in that batch were the kind this tool exists to prevent — output that
 * is well-formed, opens cleanly, and is wrong.
 *
 * THE ONE THAT MATTERED MOST. The CSV opened with a title banner above its real
 * header:
 *
 *     Pakhar-A 115.13 Ha Boundary Pillars,,,
 *     Sl No,NORTHING,EASTING,Code
 *     1,2605201.531,256320.247,BP1
 *
 * The reader tested row 0 for "does this look like a header", and a banner does
 * — it is text with no numbers. So the real names were never read, NORTHING and
 * EASTING could not be matched, and the mapping fell through to COLUMN
 * POSITION: column 2 became X. Every one of the seventeen exported formats put
 * the northing in the easting's place, and 188 boundary pillars landed about
 * 2,600 km east of the site. Nothing in any output looked wrong.
 *
 * The same banner cost the format detector its header bonus and left an
 * ordinary four-column survey CSV at 35% confidence — below the floor, so the
 * conversion stopped and asked the user to name the format by hand.
 *
 * WHY THE FIXTURES ARE SYNTHETIC AND THE REAL FILES OPTIONAL. The shape of the
 * defect — a banner row, then a header naming northing before easting — is what
 * has to stay fixed, and a small fixture pins it whether or not the trial
 * folders are still in the tree. Where the operator's actual files are present
 * they are used as well, because a fixture I wrote cannot surprise me and a
 * file from the field can.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { convert } from '@core/pipeline';
import { detectFormat } from '@core/detect';
import { SURVEY_DEFAULT_PRECISION } from '@core/precision';
import { crsFromEpsg } from '@crs/epsg';
import { findHeaderRow } from '../src/engines/survey/schema';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The operator's file, shrunk to the four rows that carry the defect. */
const BANNER_CSV = [
  'Pakhar-A 115.13 Ha Boundary Pillars,,,',
  'Sl No,NORTHING,EASTING,Code',
  '1,2605201.531,256320.247,BP1',
  '2,2605250.660,256329.539,BP2',
  '3,2605279.989,256335.087,BP3',
].join('\n');

/** UTM zone 45N: eastings are six digits, northings seven. */
const UTM45N = crsFromEpsg(32645);

async function toGeoJson(text: string, force = true) {
  const result: never = (await convert({
    input: { fileName: 'pillars.csv', bytes: encoder.encode(text) },
    targetFormatId: 'geojson',
    ...(force ? { forcedSourceFormatId: 'csv' } : {}),
    settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N, runQa: false },
  } as never)) as never;
  const value = result as unknown as { outputs: { bytes: Uint8Array }[]; warnings: { code: string }[] };
  return {
    json: JSON.parse(decoder.decode(value.outputs[0].bytes)),
    codes: value.warnings.map((entry) => entry.code),
  };
}

describe('finding the header under a title banner', () => {
  it('skips the banner and takes the row that names the columns', () => {
    const grid = BANNER_CSV.split('\n').map((line) => line.split(','));
    expect(findHeaderRow(grid)).toBe(1);
  });

  it('still takes row 0 when there is no banner', () => {
    const grid = [
      ['Sl No', 'NORTHING', 'EASTING', 'Code'],
      ['1', '2605201.531', '256320.247', 'BP1'],
    ];
    expect(findHeaderRow(grid)).toBe(0);
  });

  it('reports no header for a bare coordinate table', () => {
    // Three numeric columns and nothing naming them. Inventing a header here
    // would eat the first point.
    const grid = [
      ['256320.247', '2605201.531', '412.5'],
      ['256329.539', '2605250.660', '413.1'],
    ];
    expect(findHeaderRow(grid)).toBeNull();
  });

  it('does not hunt indefinitely for a header', () => {
    // Ten lines of letterhead is likelier to be a file with no header at all
    // than a file with ten lines of letterhead. Guessing further would start
    // consuming data.
    const grid = [
      ...Array.from({ length: 10 }, () => ['Report', '', '', '']),
      ['Sl No', 'NORTHING', 'EASTING', 'Code'],
      ['1', '2605201.531', '256320.247', 'BP1'],
    ];
    expect(findHeaderRow(grid)).toBeNull();
  });
});

describe('a survey CSV behind a title banner converts correctly', () => {
  it('puts the EASTING in x, not the northing', async () => {
    // THE DEFECT. Before the fix this came back [2605201.531, 256320.247] —
    // northing first — in all seventeen delivered formats.
    const { json } = await toGeoJson(BANNER_CSV);
    expect(json.features).toHaveLength(3);
    expect(json.features[0].geometry.coordinates[0]).toBeCloseTo(256320.247, 6);
    expect(json.features[0].geometry.coordinates[1]).toBeCloseTo(2605201.531, 6);
  });

  it('keeps every point on the grid it was surveyed on', async () => {
    // The magnitude test, which is what makes a swap obvious: on zone 45N an
    // easting is six digits and a northing seven. A swapped pair passes every
    // structural check and fails this one.
    const { json } = await toGeoJson(BANNER_CSV);
    for (const feature of json.features) {
      const [x, y] = feature.geometry.coordinates;
      expect(x).toBeGreaterThan(100_000);
      expect(x).toBeLessThan(1_000_000);
      expect(y).toBeGreaterThan(1_000_000);
    }
  });

  it('recovers the real field names instead of Column 2, Column 3', async () => {
    const { json } = await toGeoJson(BANNER_CSV);
    const properties = json.features[0].properties;
    expect(Object.keys(properties)).toContain('Sl No');
    expect(properties.Code).toBe('BP1');
    expect(Object.keys(properties).some((key) => /^Column \d/.test(key))).toBe(false);
  });

  it('says out loud that it skipped the banner', async () => {
    // Silently dropping a row is how a header becomes a data point. The count
    // is stated so it can be checked against the file.
    const { codes } = await toGeoJson(BANNER_CSV);
    expect(codes).toContain('CSV_PREAMBLE_SKIPPED');
  });

  it('no longer needs the columns confirmed by hand', async () => {
    // With the names readable the schema matches on them, so the warning that
    // sent the user to the mapping panel is gone.
    const { codes } = await toGeoJson(BANNER_CSV);
    expect(codes).not.toContain('CSV_SCHEMA_UNCONFIRMED');
  });
});

describe('detection is not defeated by a title banner', () => {
  it('scores the table on its data rows, not on line 0', () => {
    const result = detectFormat({ fileName: 'pillars.csv', bytes: encoder.encode(BANNER_CSV) });
    expect(result.formatId).toBe('csv');
    // 35% before the fix — under the floor, so the conversion refused to start.
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.requiresConfirmation).toBe(false);
  });

  it('credits the header that names the coordinate columns', () => {
    const result = detectFormat({ fileName: 'pillars.csv', bytes: encoder.encode(BANNER_CSV) });
    const notes = result.evidence.map((entry) => entry.note).join(' | ');
    expect(notes).toMatch(/Header names coordinate columns/);
  });

  it('converts without the format being named by hand', async () => {
    const { json } = await toGeoJson(BANNER_CSV, false);
    expect(json.features).toHaveLength(3);
  });
});

// --------------------------------------------------------------------------
// The operator's own files, when they are still in the tree.
// --------------------------------------------------------------------------

const PILLARS = '3_Trial_Feedback_Files/imported file/Pakhar-A 115.13 Ha Boundary Pillars.csv';
const MINING_DXF = '1_Trial_Feedback_Files/imported file/RAM_Pakhar-115.13 Ha Entity LMS Final Data.dxf';

describe.skipIf(!existsSync(PILLARS))('the delivered boundary-pillar CSV', () => {
  it('reads all 188 pillars with the axes the right way round', async () => {
    const text = readFileSync(PILLARS, 'utf8');
    const { json, codes } = await toGeoJson(text, false);
    expect(json.features).toHaveLength(188);
    const [x, y] = json.features[0].geometry.coordinates;
    expect(x).toBeCloseTo(256320.247, 3);
    expect(y).toBeCloseTo(2605201.531, 3);
    expect(codes).not.toContain('CSV_SCHEMA_UNCONFIRMED');
  });
});

describe.skipIf(!existsSync(MINING_DXF))('the delivered mining DXF', () => {
  it('keeps all 76 entities, lines included', async () => {
    // The delivered GeoJSON held 56 of 76: three layers had collapsed to one
    // feature each and every LineString was gone. Whatever caused that, this
    // is the count that has to stay true.
    const result: never = (await convert({
      input: { fileName: 'mining.dxf', bytes: new Uint8Array(readFileSync(MINING_DXF)) },
      targetFormatId: 'geojson',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N, runQa: false },
    } as never)) as never;
    const value = result as unknown as { outputs: { bytes: Uint8Array }[] };
    const json = JSON.parse(decoder.decode(value.outputs[0].bytes));
    expect(json.features).toHaveLength(76);

    const byLayer = new Map<string, number>();
    for (const feature of json.features) {
      const layer = String(feature.properties?._layer ?? '?');
      byLayer.set(layer, (byLayer.get(layer) ?? 0) + 1);
    }
    expect(byLayer.get('ML Boundary')).toBe(2);
    expect(byLayer.get('Mined Out Area')).toBe(7);
    expect(byLayer.get('Reclaimed')).toBe(14);

    // Lines survived. The delivered file had none at all.
    const lines = json.features.filter((f: { geometry?: { type?: string } }) => f.geometry?.type === 'LineString');
    expect(lines.length).toBeGreaterThan(0);
  });
});

/**
 * F3 — the basemap and the caption must agree about the grid.
 *
 * Twenty of the trial screenshots show a DXF with the caption "UTM 45N
 * (assumed)" over an empty canvas and a terrain readout stuck on a dash, while
 * the KMZ beside it — which declares EPSG:4326 — draws imagery and reads
 * "Terrain 1070.0 m". The caption resolved `declared ?? assumed`; the basemap
 * read only `dataset.crs`. A DXF almost never declares a CRS, so for CAD work
 * the layer was simply never placeable.
 *
 * These pin the shared resolution rather than the rendering, because it is the
 * disagreement between the two callers that was the defect.
 */
describe('F3 — the CRS the canvas works in', () => {
  it('prefers what the file declared, and does not call it assumed', async () => {
    const { previewCrs } = await import('../src/workspace/panels/canvas');
    const { crsFromEpsg } = await import('@crs/epsg');
    const declared = crsFromEpsg(4326);
    const result = previewCrs(declared, 32645);
    expect(result.crs).toBe(declared);
    expect(result.assumed).toBe(false);
  });

  it('falls back to the CRS assigned in settings, and says it is assumed', async () => {
    // THE DEFECT. This is the DXF case, and it returned null to the basemap.
    const { previewCrs } = await import('../src/workspace/panels/canvas');
    const result = previewCrs(null, 32645);
    expect(result.crs?.epsg).toBe(32645);
    expect(result.assumed).toBe(true);
  });

  it('has nothing to offer when the file declares nothing and none was assigned', async () => {
    const { previewCrs } = await import('../src/workspace/panels/canvas');
    expect(previewCrs(null, null).crs).toBeNull();
    expect(previewCrs(null, undefined).crs).toBeNull();
    expect(previewCrs(null, 0).crs).toBeNull();
  });
});

/**
 * F4 — a refusal whose remedy is one setting should offer to change it.
 *
 * Screenshot 1147: `PKR_CADASTRAL_MAP.kmz` → KML, "failed", then "Retry 1
 * failed". Nothing was wrong with the file. A target CRS of EPSG:32645 had been
 * set while working on the mining DXF — the right grid for that site — and the
 * target CRS is ONE GLOBAL SETTING, so it was still set when the cadastral KMZ
 * was converted an hour later. KML stores nothing but WGS 84 and has no field
 * in which to record anything else, so the export was refused.
 *
 * The refusal is correct and stays. What it lacked was a way out: its `action`
 * said "clear the target CRS", and the operator, reading a red block on a file
 * whose settings they had not touched, pressed Retry instead — which re-runs
 * the same settings and fails identically.
 */
describe('F4 — clearing a target CRS the format cannot store', () => {
  it('still refuses the export, with the code that names the cause', async () => {
    // The trial case, reproduced: projected source, KML target, EPSG:32645 left
    // over from another file. A refusal here is the correct behaviour — writing
    // eastings into a longitude field would open cleanly off the coast of
    // Africa. This pins that the refusal survives the remedy being added.
    await expect(
      convert({
        input: { fileName: 'pillars.csv', bytes: encoder.encode(BANNER_CSV) },
        targetFormatId: 'kml',
        forcedSourceFormatId: 'csv',
        settings: {
          precision: SURVEY_DEFAULT_PRECISION,
          sourceCrs: UTM45N,
          targetCrs: UTM45N,
          runQa: false,
        },
      } as never)
    ).rejects.toMatchObject({ code: 'TARGET_CRS_NOT_STORABLE' });
  });

  it('offers to clear the setting, naming the code that is in the way', async () => {
    const { remedyFor } = await import('../src/workspace/remedies');
    const { store } = await import('../src/state/store');

    await store.patchSettings({ targetCrsEpsg: 32645 });
    const remedy = remedyFor('item-1', { code: 'TARGET_CRS_NOT_STORABLE' });
    // Named, not "clear the setting": the point is that the user recognises the
    // code as one they set for a different file.
    expect(remedy?.label).toContain('32645');
    expect(remedy?.label).toContain('convert again');
    await store.patchSettings({ targetCrsEpsg: null });
  });

  it('offers nothing when no target CRS is set', async () => {
    // The same error has a second cause — a source CRS that never resolved —
    // and there the only fix is a CRS the tool refuses to invent (R4). A button
    // that cleared an unset setting would be a click that changes nothing.
    const { remedyFor } = await import('../src/workspace/remedies');
    const { store } = await import('../src/state/store');
    await store.patchSettings({ targetCrsEpsg: null });
    expect(remedyFor('item-1', { code: 'TARGET_CRS_NOT_STORABLE' })).toBeNull();
  });

  it('offers nothing for errors it has no answer to', async () => {
    const { remedyFor } = await import('../src/workspace/remedies');
    const { store } = await import('../src/state/store');
    await store.patchSettings({ targetCrsEpsg: 32645 });
    expect(remedyFor('item-1', { code: 'CRS_REQUIRED' })).toBeNull();
    expect(remedyFor('item-1', { code: 'TOO_LARGE_FOR_BROWSER' })).toBeNull();
    await store.patchSettings({ targetCrsEpsg: null });
  });

  it('actually clears it, and says so in the log', async () => {
    // The button pressed, not merely built. The CRS-panel form takes no item id
    // and so runs no conversion, which is what makes it testable without a
    // worker pool — and is also the right behaviour: nothing has failed yet.
    const { clearTargetCrsRemedy } = await import('../src/workspace/remedies');
    const { store } = await import('../src/state/store');
    const { installHost } = await import('../src/workspace/host');

    let renders = 0;
    installHost({ render: () => void renders++ });
    await store.patchSettings({ targetCrsEpsg: 32645 });

    const remedy = clearTargetCrsRemedy(null);
    expect(remedy?.label).not.toContain('convert again');
    remedy?.run();
    // `run` is synchronous and starts an async settings write; one turn of the
    // microtask queue is enough for a store that persists through a no-op.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.get().settings.targetCrsEpsg).toBeNull();
    expect(renders).toBeGreaterThan(0);
    const last = store.get().log.at(-1);
    expect(last?.message).toContain('Target CRS cleared');
    // It was global, and saying so is the part that prevents the next surprise.
    expect(last?.message).toContain('whole queue');
  });
});
