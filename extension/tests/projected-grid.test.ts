/**
 * Reprojection driven by a target that holds a PLANE GRID, not a globe.
 *
 * `imposed-crs.test.ts` covers one direction: a UTM survey on its way to KML is
 * reprojected into WGS 84, because KML has nowhere to say the coordinates are
 * anything else and a projected easting read back as a longitude lands a
 * continent away. Task #58 built that and stopped there.
 *
 * The mirror was missing, and the missing half is what a user reported:
 *
 *   "when dxf to kml exporting it is working but when kml to dxf importing
 *    not giving out put valid similarly geojeson is also not working"
 *
 * Converting a KML — or any WGS 84 GeoJSON — into DXF wrote `80.1385831`
 * straight into the X ordinate. A parcel sixty metres across became a drawing
 * six ten-thousandths of a unit wide. AutoCAD opens that file: it parses, the
 * entities are all there, the byte count looks healthy. It is a dot at the
 * origin with degenerate extents, and ZOOM EXTENTS shows nothing. No warning
 * was raised anywhere, because nothing in the pipeline considered degrees in a
 * drawing file a problem.
 *
 * WHY AN EARLIER AUDIT MISSED IT. The conversion matrix checked that bytes came
 * out, not that the numbers in them were coordinates anyone could build from.
 * So these assertions are about MAGNITUDE, not about the file being non-empty:
 * a DXF holding values under 180 where metres belong is the failure, however
 * well-formed it is.
 *
 * The tests are written off the registry flag rather than per-case, because the
 * failure they guard is a CAD or mining format being added later and nobody
 * remembering this file exists — and equally, the flag being sprayed onto a
 * format that legitimately holds degrees.
 */

import { describe, expect, it } from 'vitest';
import { convert, type ConversionInput } from '@core/pipeline';
import { SURVEY_DEFAULT_PRECISION } from '@core/precision';
import { FORMATS, type FormatDef } from '@core/registry';
import { crsFromEpsg } from '@crs/epsg';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** WGS 84 / UTM zone 44N — the grid the sample below actually falls on. */
const UTM44N = crsFromEpsg(32644);

/**
 * A parcel near 80.139°E, 23.429°N — the area of the user's own cadastral work.
 *
 * Every assertion turns on the magnitude gap: on this grid metres are six and
 * seven digits, degrees are two. A file that failed to reproject is not subtly
 * wrong, it is wrong by four orders of magnitude, so nothing here needs a
 * tolerance.
 */
const WGS84_PARCEL = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { plot: '890', owner: 'Test' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [80.139, 23.429],
            [80.1396, 23.4291],
            [80.1397, 23.4295],
            [80.1391, 23.4294],
            [80.139, 23.429],
          ],
        ],
      },
    },
  ],
});

/** The same parcel already on a projected grid, declared in the file. */
const UTM_PARCEL = JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32644' } },
  features: [
    {
      type: 'Feature',
      properties: { plot: '890' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [412000, 2591300],
            [412061, 2591311],
            [412072, 2591355],
            [412011, 2591344],
            [412000, 2591300],
          ],
        ],
      },
    },
  ],
});

function wgs84(): ConversionInput {
  return { fileName: 'parcel.geojson', bytes: encoder.encode(WGS84_PARCEL) };
}

function utm(): ConversionInput {
  return { fileName: 'parcel.geojson', bytes: encoder.encode(UTM_PARCEL) };
}

/** Anything with a writer, whether or not everything about it round-trips. */
const writes = (format: FormatDef): boolean => format.support.export === 'full' || format.support.export === 'partial';

const GRID_FORMATS: FormatDef[] = FORMATS.filter((format) => format.limits?.requiresProjectedGrid === true);

/**
 * Every X ordinate in a DXF: the group code 10 and the value on the line after.
 * Reading the writer's own output rather than re-parsing through the reader,
 * because the reader would happily accept the degrees the writer should never
 * have emitted.
 */
function dxfEastings(bytes: Uint8Array): number[] {
  const text = decoder.decode(bytes);
  return [...text.matchAll(/^\s*10\r?\n\s*(-?[\d.]+)/gm)].map((match) => Number(match[1]));
}

describe('which formats are declared to need a projected grid', () => {
  it('covers DXF, DWG and Surpac strings, and nothing else', () => {
    // If this list grows, a format was flagged. Check it is genuinely a site
    // grid in linear units before accepting the change — an over-broad first
    // pass of this very flag caught eleven formats because eight of them shared
    // one `limits` object.
    expect(GRID_FORMATS.map((format) => format.id).sort()).toEqual(['dwg', 'dxf', 'surpac-str']);
  });

  it('leaves formats that legitimately hold degrees unflagged', () => {
    // The distinction is not "can the format name its CRS". A shapefile cannot
    // name one inside the .shp either, yet it takes a .prj sidecar and is
    // perfectly happy in degrees. These carry whatever they are given, and
    // reprojecting them would move survey data nobody asked to move (R18).
    const mustNotBeFlagged = [
      'geojson',
      'kml',
      'shapefile',
      'gpkg',
      'wkt',
      'wkb',
      'geotiff',
      'las',
      'laz',
      'xyz',
      'pts',
      'ply',
      'flatgeobuf',
      'csv',
    ];
    for (const id of mustNotBeFlagged) {
      const format = FORMATS.find((entry) => entry.id === id);
      if (!format) continue; // Renamed or retired; the loop above is the real gate.
      expect(`${id}:${format.limits?.requiresProjectedGrid ?? false}`).toBe(`${id}:false`);
    }
  });

  it('never flags a format that also mandates a CRS', () => {
    // The two rules would fight: one says "must be WGS 84", the other says
    // "must not be degrees". No format can be both, and a format that claimed
    // both would reproject twice and land wherever the ordering happened to put
    // it.
    for (const format of GRID_FORMATS) {
      expect(format.limits?.mandatesCrsEpsg).toBeUndefined();
    }
  });
});

describe('geographic data converted to a grid format', () => {
  // DWG is written by the native ODA helper, which is not present in CI. Its
  // flag is covered by the registry tests above; the pipeline behaviour is the
  // same code path for all three.
  const testable = GRID_FORMATS.filter((format) => writes(format) && format.writerEngine !== 'adapters/native-messaging');

  it('has something to test', () => {
    expect(testable.map((format) => format.id).sort()).toEqual(['dxf', 'surpac-str']);
  });

  for (const format of testable) {
    it(`writes metres, not degrees, into ${format.name}`, async () => {
      const result = await convert({
        input: wgs84(),
        targetFormatId: format.id,
        settings: { precision: SURVEY_DEFAULT_PRECISION },
      });

      expect(result.outputs.length).toBeGreaterThan(0);
      const text = decoder.decode(result.outputs[0].bytes);
      const values = (text.match(/\d+\.\d+/g) ?? []).map(Number).filter((value) => value > 1);

      expect(values.length).toBeGreaterThan(0);
      // The tell: on zone 44N this site is at ~412 km east, ~2591 km north.
      // Degrees left in place would put every ordinate under 100.
      expect(values.some((value) => value > 400000 && value < 420000)).toBe(true);
      expect(values.every((value) => value < 180)).toBe(false);
    });

    it(`says it reprojected, and why, when writing ${format.name}`, async () => {
      const result = await convert({
        input: wgs84(),
        targetFormatId: format.id,
        settings: { precision: SURVEY_DEFAULT_PRECISION },
      });

      const transformed = result.warnings.find((entry) => entry.code === 'CRS_TRANSFORMED');
      // Silence was the original defect. The user got a broken drawing and no
      // indication anything had been decided on their behalf.
      expect(transformed).toBeDefined();
      expect(transformed?.message).toContain('32644');
      expect(transformed?.reason).toContain('plane grid');
      // And it points at the override, because a site grid is the user's call.
      expect(transformed?.action).toContain('CRS panel');
    });

    it(`leaves data already on a grid alone when writing ${format.name}`, async () => {
      const result = await convert({
        input: utm(),
        targetFormatId: format.id,
        settings: { precision: SURVEY_DEFAULT_PRECISION },
      });

      expect(result.warnings.find((entry) => entry.code === 'CRS_TRANSFORMED')).toBeUndefined();
      const text = decoder.decode(result.outputs[0].bytes);
      expect(text).toMatch(/412000/);
    });

    it(`never second-guesses an explicit target CRS for ${format.name}`, async () => {
      // A user who names a grid has made a decision. Overriding it would be the
      // same class of error as the one this file exists to fix, in reverse.
      const result = await convert({
        input: utm(),
        targetFormatId: format.id,
        settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM44N, targetCrs: crsFromEpsg(32645) },
      });

      const transformed = result.warnings.find((entry) => entry.code === 'CRS_TRANSFORMED');
      expect(transformed?.message).toContain('32645');
      expect(transformed?.reason).toContain('set in the conversion settings');
    });
  }
});

describe('KML into DXF: the round trip the user reported', () => {
  /** The exact route: a UTM survey out to KML, then that KML back into DXF. */
  async function kmlFromUtm(): Promise<Uint8Array> {
    const result = await convert({
      input: utm(),
      targetFormatId: 'kml',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM44N },
    });
    return result.outputs[0].bytes as Uint8Array;
  }

  it('comes back on the grid it left on, not in degrees', async () => {
    const kml = await kmlFromUtm();
    // The KML itself is in degrees — that half always worked and must not change.
    expect(decoder.decode(kml)).toMatch(/80\.13/);

    const back = await convert({
      input: { fileName: 'parcel.kml', bytes: kml },
      targetFormatId: 'dxf',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    });

    const eastings = dxfEastings(back.outputs[0].bytes as Uint8Array);
    expect(eastings.length).toBeGreaterThan(0);
    // Round-trip through degrees costs a few millimetres. Landing within a
    // metre of where it started is the whole claim.
    for (const easting of eastings) {
      expect(easting).toBeGreaterThan(411900);
      expect(easting).toBeLessThan(412200);
    }
  });

  it('produces a drawing with real extents rather than a dot at the origin', async () => {
    const back = await convert({
      input: { fileName: 'parcel.kml', bytes: await kmlFromUtm() },
      targetFormatId: 'dxf',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    });

    const eastings = dxfEastings(back.outputs[0].bytes as Uint8Array);
    const span = Math.max(...eastings) - Math.min(...eastings);
    // The parcel is ~72 m wide. Before the fix this span was 0.0007.
    expect(span).toBeGreaterThan(50);
  });
});

describe('the zone is chosen from the data, not assumed', () => {
  it('picks the zone the coordinates fall in', async () => {
    // Same geometry, moved to Rajasthan — zone 43N, EPSG:32643. A hard-coded
    // zone would pass every test above and put this site 500 km out.
    const west = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [73.139, 26.429],
                [73.1396, 26.4291],
                [73.1397, 26.4295],
                [73.139, 26.429],
              ],
            ],
          },
        },
      ],
    });

    const result = await convert({
      input: { fileName: 'west.geojson', bytes: encoder.encode(west) },
      targetFormatId: 'dxf',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    });

    expect(result.warnings.find((entry) => entry.code === 'CRS_TRANSFORMED')?.message).toContain('32643');
  });

  it('picks the southern-hemisphere zone below the equator', async () => {
    // Northings would otherwise go negative, which CAD tolerates and surveyors
    // do not. EPSG:327xx carries the 10 000 000 m false northing.
    const south = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [28.04, -26.2],
              [28.045, -26.205],
            ],
          },
        },
      ],
    });

    const result = await convert({
      input: { fileName: 'south.geojson', bytes: encoder.encode(south) },
      targetFormatId: 'dxf',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    });

    expect(result.warnings.find((entry) => entry.code === 'CRS_TRANSFORMED')?.message).toContain('32735');
  });
});
