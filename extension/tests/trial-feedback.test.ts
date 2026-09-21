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
 * F6 and F7 — the label on a file and the numbers inside it must agree.
 *
 * Both defects in the delivered cadastral batch were the same defect wearing
 * two formats, and both are already fixed. Nothing pinned them, which is why
 * they are pinned here: this is the class of bug the whole tool exists to
 * prevent, because the output opens, draws, and is wrong.
 *
 * F6. `PKR_CADASTRAL_MAP_converted_to_geojson.geojson` declares
 * `urn:ogc:def:crs:EPSG::32645` — a metre grid — and all 62,111 of its
 * coordinates are degrees (`84.594, 23.544`). Any reader that honours the
 * declaration treats 84.594 as an easting 84 metres from the zone's western
 * edge. The file lies about itself.
 *
 * F7. `..._converted_to_dxf.dxf` has `firstX = 84.594`: longitude written into
 * the X ordinate of a CAD drawing, which has no CRS at all and takes its
 * numbers as plan units. The whole 3.5 km site arrives 0.033 units across and
 * opens as a dot at the origin.
 *
 * The tests below convert the operator's real KMZ and check the two things
 * together — what the output SAYS its CRS is, and what magnitude its numbers
 * actually are. Checking either alone is what let both files out.
 */
const CADASTRAL_KMZ = '2_Trial_Feedback_Files/imported file/PKR_CADASTRAL_MAP.kmz';

/** Every `[code, value]` pair in a DXF, in file order. */
function dxfGroups(text: string): [string, string][] {
  const lines = text.split(/\r?\n/);
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) pairs.push([lines[index].trim(), lines[index + 1]]);
  return pairs;
}

/** The x and y of every VERTEX, which is where a CAD drawing's coordinates live. */
function dxfVertices(text: string): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  let inVertex = false;
  for (const [code, value] of dxfGroups(text)) {
    // Group 0 opens a new entity, so it is also what closes the last one.
    if (code === '0') inVertex = value.trim() === 'VERTEX';
    if (!inVertex) continue;
    if (code === '10') xs.push(Number(value));
    if (code === '20') ys.push(Number(value));
  }
  return { xs, ys };
}

async function convertCadastral(targetFormatId: string, targetCrs: ReturnType<typeof crsFromEpsg> | null) {
  const result: never = (await convert({
    input: { fileName: 'PKR_CADASTRAL_MAP.kmz', bytes: new Uint8Array(readFileSync(CADASTRAL_KMZ)) },
    targetFormatId,
    settings: { precision: SURVEY_DEFAULT_PRECISION, targetCrs, runQa: false },
  } as never)) as never;
  const value = result as unknown as { outputs: { bytes: Uint8Array }[]; warnings: { code: string }[] };
  return { text: decoder.decode(value.outputs[0].bytes), codes: value.warnings.map((entry) => entry.code) };
}

describe.skipIf(!existsSync(CADASTRAL_KMZ))('F6/F7 — the delivered cadastral KMZ', () => {
  it('writes metres when it declares a metre grid', async () => {
    // THE DEFECT, in the format it was delivered in. Before the fix this file
    // said EPSG:32645 and held 84.594.
    const { text, codes } = await convertCadastral('geojson', crsFromEpsg(32645));
    const json = JSON.parse(text);

    expect(json.crs?.properties?.name).toContain('32645');
    expect(json.features).toHaveLength(1025);

    // The label and the numbers, checked against each other. On zone 45N an
    // easting is six digits and a northing seven; a longitude is two.
    for (const feature of json.features.slice(0, 50)) {
      for (const [x, y] of flatCoords(feature.geometry)) {
        expect(x).toBeGreaterThan(100_000);
        expect(x).toBeLessThan(1_000_000);
        expect(y).toBeGreaterThan(1_000_000);
      }
    }
    expect(flatCoords(json.features[0].geometry)[0]).toEqual([254374.143, 2605788.719]);

    // RFC 7946 has no CRS member, so writing one is off-spec and is stated as
    // such rather than done quietly.
    expect(codes).toContain('GEOJSON_NON_WGS84');
    expect(codes).toContain('CRS_TRANSFORMED');
  }, 120_000);

  it('writes degrees when it declares nothing, which is what WGS 84 GeoJSON is', async () => {
    // The same agreement, from the other side: no `crs` member means RFC 7946,
    // which means degrees. A file that omitted the member and held metres
    // would be exactly as wrong as the delivered one.
    const { text } = await convertCadastral('geojson', null);
    const json = JSON.parse(text);
    expect(json.crs).toBeUndefined();
    for (const [x, y] of flatCoords(json.features[0].geometry)) {
      expect(Math.abs(x)).toBeLessThanOrEqual(180);
      expect(Math.abs(y)).toBeLessThanOrEqual(90);
    }
  }, 120_000);

  it('puts a CAD drawing on a metre grid even though no target CRS was asked for', async () => {
    // F7's real fix. DXF has nowhere to record a CRS, so the pipeline chooses
    // the UTM zone the data falls in rather than writing the degrees it
    // arrived as. This is the no-target case, which is how the trial ran it.
    const { text, codes } = await convertCadastral('dxf', null);
    const { xs, ys } = dxfVertices(text);

    expect(xs).toHaveLength(60_748);
    expect(ys).toHaveLength(60_748);
    expect(xs[0]).toBeCloseTo(254374.143, 3);
    expect(ys[0]).toBeCloseTo(2605788.719, 3);

    // Nothing left in degrees anywhere in the drawing. A single stray vertex
    // at 84.594 would sit 254 km from the rest of the site.
    expect(Math.min(...xs)).toBeGreaterThan(100_000);
    expect(Math.min(...ys)).toBeGreaterThan(1_000_000);

    // And the consequence that made it obvious: the site is kilometres across,
    // not hundredths of a unit. 0.033 units is what a degree-written drawing
    // measured, and it opens as a dot at the origin.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(3_000);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(3_000);

    expect(codes).toContain('CRS_TRANSFORMED');
  }, 120_000);

  it('lands on the same grid when that zone is asked for explicitly', async () => {
    // The automatic choice and the explicit one must agree, or "leave it unset"
    // would be advice that moves the drawing.
    const { text } = await convertCadastral('dxf', crsFromEpsg(32645));
    const { xs, ys } = dxfVertices(text);
    expect(xs[0]).toBeCloseTo(254374.143, 3);
    expect(ys[0]).toBeCloseTo(2605788.719, 3);
  }, 120_000);
});

/**
 * F11 and F12 — every delivered format has to land on the same hill.
 *
 * The register named GeoJSON and DXF because those were the two files anyone
 * had opened. Auditing the rest of the delivered batch found the same defect
 * class in three more formats, and nothing was pinning any of them:
 *
 *   F11. `..._converted_to_gml.gml` carries `srsName="EPSG:32645"` — a metre
 *        grid — around `<posList>84.594 23.544</posList>`. Exactly F6, in GML.
 *
 *   F12. `..._converted_to_kml.kml` and the GeoJSON Sequence beside it hold
 *        `82.51201422,0.00021242`. That is not a label problem, it is the wrong
 *        place: the degrees were fed through a UTM 45N INVERSE as though they
 *        were metres, so 84.594 m east and 23.544 m north of the zone origin
 *        came back as a point on the equator, about 2,600 km south of the site
 *        and 200 km west of it. The cadastral map opens in Google Earth in the
 *        Gulf of Guinea's latitude band off Sumatra.
 *
 *        Folder 3 shows the same machinery amplifying F1's swap: its KML holds
 *        `105.59634894,2.19719737`, which is the swapped UTM pair reprojected —
 *        the boundary pillars land in the South China Sea.
 *
 * WHY THIS TEST IS SHAPED THIS WAY. Five defects, five formats, one sentence:
 * the site is in Jharkhand. Whatever units a format stores, and whichever axis
 * it puts first, the first point has to be ON THE SITE — so that is what is
 * asserted, once, for every text format in the delivered batch. A per-format
 * assertion would have been five tests that each pass while the next format
 * ships wrong; this one cannot be satisfied by a file that is merely
 * well-formed.
 */
describe.skipIf(!existsSync(CADASTRAL_KMZ) || !existsSync(PILLARS))('F11/F12 — every delivered format lands on the site', () => {
  /** The first coordinate pair in any text format, whatever its punctuation. */
  const firstPair = (text: string): [number, number] | null => {
    const match = text.match(/(-?\d+\.\d+)[ ,](-?\d+\.\d+)/);
    return match ? [Number(match[1]), Number(match[2])] : null;
  };

  /** Pakhar, Jharkhand: about 84.6°E, 23.5°N, or 256 km E / 2,605 km N on 45N. */
  const onSiteDegrees = ([a, b]: [number, number]) => {
    // Either axis order is allowed here — LandXML writes north first by
    // convention — so the pair is checked as a set, not as x then y.
    const [lon, lat] = Math.abs(a) > Math.abs(b) ? [a, b] : [b, a];
    return lon > 84 && lon < 85 && lat > 23 && lat < 24;
  };
  const onSiteGrid = ([a, b]: [number, number]) => {
    const [east, north] = a < b ? [a, b] : [b, a];
    return east > 250_000 && east < 260_000 && north > 2_600_000 && north < 2_610_000;
  };

  it('writes the cadastral KMZ into every format somewhere in Jharkhand', async () => {
    // THE DEFECT. Before the fix, kml and geojsonseq put this on the equator.
    for (const target of ['kml', 'gml', 'geojsonseq', 'topojson', 'landxml']) {
      const { text } = await convertCadastral(target, null);
      const pair = firstPair(text);
      expect(pair, `${target} produced no coordinate pair`).not.toBeNull();
      expect(onSiteDegrees(pair!), `${target} wrote ${JSON.stringify(pair)}`).toBe(true);
    }
  }, 300_000);

  it('never labels a WGS 84 export as a metre grid', async () => {
    // F11 exactly. The delivered GML declared EPSG:32645 over degrees; any CRS
    // a format states has to be the one its numbers are actually in.
    //
    // Only `srsName` counts. "EPSG:32645" also appears 360 times in the parcel
    // balloons, where each attribute table states the source's projected CRS —
    // that is data the file is carrying, not a claim about its own geometry,
    // and a test that could not tell the two apart would fail on a correct file.
    const { text } = await convertCadastral('gml', null);
    const declared = [...new Set(text.match(/srsName="[^"]*"/g) ?? [])];
    expect(declared).toEqual(['srsName="EPSG:4326"']);
  }, 120_000);

  it('writes the boundary pillars into every format somewhere in Jharkhand', async () => {
    // Folder 3's KML held 105.6°E, 2.2°N — the South China Sea — because F1's
    // swap was reprojected rather than caught. Grid formats keep metres,
    // geographic ones get degrees, and both have to be the same hill.
    const pillars = readFileSync(PILLARS);
    const run = async (target: string) => {
      const result: never = (await convert({
        input: { fileName: 'pillars.csv', bytes: new Uint8Array(pillars) },
        targetFormatId: target,
        settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N, runQa: false },
      } as never)) as never;
      return decoder.decode((result as unknown as { outputs: { bytes: Uint8Array }[] }).outputs[0].bytes);
    };

    for (const target of ['gml', 'topojson', 'wkt', 'landxml']) {
      const pair = firstPair(await run(target));
      expect(pair, `${target} produced no coordinate pair`).not.toBeNull();
      expect(onSiteGrid(pair!), `${target} wrote ${JSON.stringify(pair)}`).toBe(true);
    }
    for (const target of ['kml', 'geojsonseq']) {
      const pair = firstPair(await run(target));
      expect(pair, `${target} produced no coordinate pair`).not.toBeNull();
      expect(onSiteDegrees(pair!), `${target} wrote ${JSON.stringify(pair)}`).toBe(true);
    }
  }, 300_000);

  it('keeps the two north-first formats north-first, on purpose', async () => {
    // Both of these look like the F1 swap and are not, so they are pinned
    // rather than left for the next reader to "fix". CSV round-trips the
    // source table's own column names, and every LandXML point list is
    // "north east [elev]" — see engines/vector/landxml.ts, which swaps back on
    // import and says so with LANDXML_AXIS_SWAPPED.
    const pillars = new Uint8Array(readFileSync(PILLARS));
    const run = async (target: string) => {
      const result: never = (await convert({
        input: { fileName: 'pillars.csv', bytes: pillars },
        targetFormatId: target,
        settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N, runQa: false },
      } as never)) as never;
      return decoder.decode((result as unknown as { outputs: { bytes: Uint8Array }[] }).outputs[0].bytes);
    };

    const csv = await run('csv');
    expect(csv.split('\n')[0]).toBe('Sl No,NORTHING,EASTING,Code');
    // The value under NORTHING is a northing. That is the whole point.
    expect(csv.split('\n')[1]).toBe('1,2605201.531,256320.247,BP1');

    expect(firstPair(await run('landxml'))).toEqual([2605201.531, 256320.247]);
  }, 300_000);
});

/**
 * The checks above, run against the files that were actually delivered.
 *
 * A regression test that passes proves the code is right today. It does not
 * prove the test would have noticed when the code was wrong — and a check that
 * cannot fail is worse than no check, because it reads like cover. The two
 * broken files are still in the tree, so the same two helpers are pointed at
 * them here. If these ever stop failing, the checks above have gone blind.
 */
const DELIVERED_GEOJSON = '2_Trial_Feedback_Files/exported file/PKR_CADASTRAL_MAP_converted_to_geojson.geojson';
const DELIVERED_DXF = '2_Trial_Feedback_Files/exported file/PKR_CADASTRAL_MAP_converted_to_dxf.dxf';

describe.skipIf(!existsSync(DELIVERED_GEOJSON) || !existsSync(DELIVERED_DXF))('the checks bite', () => {
  it('sees that the delivered GeoJSON says metres and holds degrees', () => {
    const json = JSON.parse(readFileSync(DELIVERED_GEOJSON, 'utf8'));
    expect(json.crs?.properties?.name).toContain('32645');
    const [x, y] = flatCoords(json.features[0].geometry)[0];
    // What the file says it is, against what it is.
    expect(x).toBeLessThan(180);
    expect(y).toBeLessThan(90);
  });

  it('sees that the delivered DXF is a third of a unit across', () => {
    const { xs, ys } = dxfVertices(readFileSync(DELIVERED_DXF, 'utf8'));
    expect(xs.length).toBeGreaterThan(0);
    expect(xs[0]).toBeLessThan(180);
    // 0.033 units, where the site is 3.5 km. This is the dot at the origin.
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1);
  });
});

/** Every `[x, y]` in a GeoJSON geometry, however deeply nested. */
function flatCoords(geometry: { coordinates: unknown }): [number, number][] {
  const out: [number, number][] = [];
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number') {
      out.push([node[0] as number, node[1] as number]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geometry.coordinates);
  return out;
}

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
