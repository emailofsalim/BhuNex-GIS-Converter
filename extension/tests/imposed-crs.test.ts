/**
 * Reprojection driven by what the target format can store.
 *
 * The reported failure was one conversion: a UTM survey to KML refused, with an
 * error telling the user to set a target CRS of EPSG:4326 — a value KML itself
 * mandates. The tool was holding the answer and asking for it anyway.
 *
 * The rule that replaced the refusal is not about KML. Two registry facts
 * decide it, and only their conjunction matters:
 *
 *   `limits.mandatesCrsEpsg` — the specification names one CRS.
 *   `supportsCRS === false`  — the file has nowhere to name a different one.
 *
 * Where both hold, projected coordinates written into the file are read back as
 * degrees with nothing anywhere in the file to contradict them: the site moves
 * to the Gulf of Guinea and the file still opens. Where only the first holds —
 * GeoJSON, which mandates WGS 84 but carries a `crs` member — the file is
 * unconventional and self-describing, and reprojecting a survey nobody asked to
 * reproject would be the bigger harm.
 *
 * So these tests are written per-format off the registry rather than per-case,
 * because the failure they guard is a format being added later with the same
 * pair of properties and nobody remembering this file exists.
 */

import { describe, expect, it } from 'vitest';
import { convert, type ConversionInput } from '@core/pipeline';
import { SURVEY_DEFAULT_PRECISION } from '@core/precision';
import { FORMATS, type FormatDef } from '@core/registry';
import { crsFromEpsg } from '@crs/epsg';
import { ConversionError } from '@core/errors';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** WGS 84 / UTM zone 45N — the grid most Indian survey deliveries arrive on. */
const UTM45N = crsFromEpsg(32645);

/**
 * A point, a line and a polygon around Ranchi, in UTM zone 45N metres.
 *
 * ~412 km east at ~2591 km north in zone 45N is roughly 86°E, 23°N. Every
 * assertion below turns on that: metres are six or seven digits, degrees are
 * two, so a file that failed to reproject is not subtly wrong, it is obviously
 * wrong, and the tests can say so without a tolerance.
 */
const UTM_SOURCE = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'BM1', code: 'BENCHMARK' },
      geometry: { type: 'Point', coordinates: [412345.678, 2591234.567] },
    },
    {
      type: 'Feature',
      properties: { name: 'Traverse', code: 'LINE' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [412300, 2591200],
          [412400, 2591300],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { name: 'Plot 784', code: 'PARCEL' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [412300, 2591200],
            [412400, 2591200],
            [412400, 2591300],
            [412300, 2591300],
            [412300, 2591200],
          ],
        ],
      },
    },
  ],
});

function source(): ConversionInput {
  return { fileName: 'survey.geojson', bytes: encoder.encode(UTM_SOURCE) };
}

/** Anything with a writer, whether or not everything about it round-trips. */
const writes = (format: FormatDef): boolean => format.support.export === 'full' || format.support.export === 'partial';

/** Formats whose mandate is enforced because the file cannot record anything else. */
const ENFORCED: FormatDef[] = FORMATS.filter(
  (format) => format.limits?.mandatesCrsEpsg !== undefined && !format.supportsCRS && writes(format)
);

/** Formats that name a CRS in their spec but can carry a different one. */
const ADVISORY: FormatDef[] = FORMATS.filter(
  (format) => format.limits?.mandatesCrsEpsg !== undefined && format.supportsCRS && writes(format)
);

/**
 * Every number in the text that could be a coordinate. Crude on purpose: the
 * assertion is about magnitude, and a parser per format would be a second
 * implementation of the writers to get wrong.
 */
function magnitudes(text: string): number[] {
  return (text.match(/-?\d+\.\d+/g) ?? []).map(Number).filter((value) => Math.abs(value) > 0.0001);
}

describe('a format that mandates a CRS it cannot record gets reprojected into it', () => {
  it('covers KML, KMZ, GPX, OSM and GeoJSON text sequences', () => {
    // If this list shrinks, a format stopped being covered. If it grows, a new
    // one arrived and the loop below is already testing it.
    expect(ENFORCED.map((format) => format.id).sort()).toEqual(['geojsonseq', 'gpx', 'kml', 'kmz', 'osm']);
  });

  for (const format of ENFORCED) {
    it(`converts a UTM source to ${format.name} without a target CRS being set`, async () => {
      const result = await convert({
        input: source(),
        targetFormatId: format.id,
        settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
      });

      expect(result.outputs.length).toBeGreaterThan(0);

      const transformed = result.warnings.find((entry) => entry.code === 'CRS_TRANSFORMED');
      expect(transformed?.message).toContain('EPSG:4326');
      // It reprojected because the format required it, not because it guessed.
      expect(transformed?.reason).toContain('no field in which to record a different one');
    });

    it(`writes degrees rather than metres into ${format.name}`, async () => {
      const result = await convert({
        input: source(),
        targetFormatId: format.id,
        settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
      });

      // KMZ is a ZIP, so the coordinates are not in the bytes as text. Its
      // reprojection is covered by the CRS_TRANSFORMED assertion above and by
      // the read-back test at the end of this file.
      if (format.packaging === 'zip') return;

      const text = decoder.decode(result.outputs[0].bytes);
      const values = magnitudes(text);
      expect(values.length).toBeGreaterThan(0);
      // Nothing left at survey-metre magnitude anywhere in the file.
      expect(values.every((value) => Math.abs(value) < 1000)).toBe(true);
      // And the site is where zone 45N says it is, not on the null island.
      expect(values.some((value) => value > 84 && value < 88)).toBe(true);
      expect(values.some((value) => value > 22 && value < 24)).toBe(true);
    });

    it(`refuses ${format.name} when the user asks for a CRS it cannot store`, async () => {
      // Filling in a gap is helpful. Overriding an explicit instruction is not,
      // and writing eastings where a reader expects longitude would be worse
      // than either.
      await expect(
        convert({
          input: source(),
          targetFormatId: format.id,
          settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N, targetCrs: UTM45N },
        })
      ).rejects.toThrow(ConversionError);
    });
  }
});

describe('a format that can record its own CRS is left alone', () => {
  it('covers GeoJSON and nothing else', () => {
    expect(ADVISORY.map((format) => format.id)).toEqual(['geojson']);
  });

  for (const format of ADVISORY) {
    it(`keeps the source CRS when converting to ${format.name}`, async () => {
      const result = await convert({
        input: source(),
        targetFormatId: format.id,
        settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
      });

      expect(result.warnings.find((entry) => entry.code === 'CRS_TRANSFORMED')).toBeUndefined();

      const text = decoder.decode(result.outputs[0].bytes);
      // Still metres, and the file says which metres.
      expect(magnitudes(text).some((value) => value > 400000)).toBe(true);
      expect(text).toContain('32645');
    });
  }
});

describe('what the imposed CRS does not change', () => {
  it('leaves a format with no mandate on the CRS it arrived in', async () => {
    // Shapefile carries a .prj, so there is nothing to impose and nothing to
    // warn about. A survey exported for a downstream CAD package must come out
    // on the grid it went in on.
    const result = await convert({
      input: source(),
      targetFormatId: 'shapefile',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
    });
    expect(result.warnings.find((entry) => entry.code === 'CRS_TRANSFORMED')).toBeUndefined();
  });

  it('still honours a target CRS the user did set', async () => {
    const result = await convert({
      input: source(),
      targetFormatId: 'shapefile',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N, targetCrs: crsFromEpsg(4326) },
    });
    const transformed = result.warnings.find((entry) => entry.code === 'CRS_TRANSFORMED');
    expect(transformed?.reason).toContain('set in the conversion settings');
  });

  it('refuses rather than reprojecting from a source CRS nobody established', async () => {
    // The reprojection is automatic; the source CRS is never guessed. These
    // coordinates are metres, and the same easting is valid in every UTM zone,
    // so there is no defensible answer to invent here (R4).
    await expect(
      convert({
        input: source(),
        targetFormatId: 'kml',
        settings: { precision: SURVEY_DEFAULT_PRECISION },
      })
    ).rejects.toThrow(/source CRS is unknown/);
  });
});

describe('a CRS the file assumed rather than stated', () => {
  /**
   * The second half of the reported failure, and probably the half that was
   * actually hit. RFC 7946 removed GeoJSON's `crs` member, so QGIS writes a
   * projected export with nothing in it that says "UTM". The reader filled in
   * WGS 84 — correct by the standard — and recorded it as `declared`, which put
   * it above the user's selection in the resolution order. The CRS panel then
   * had no effect at all, and the KML came out in metres labelled as degrees.
   */
  it('lets the CRS panel override an assumption the file never made', async () => {
    const result = await convert({
      input: source(),
      targetFormatId: 'kml',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
    });

    const text = decoder.decode(result.outputs[0].bytes);
    expect(magnitudes(text).some((value) => value > 84 && value < 88)).toBe(true);
    // Replacing an assumption is not disagreeing with the file, so it is
    // reported as a selection rather than as an override.
    expect(result.warnings.find((entry) => entry.code === 'CRS_SELECTED')).toBeDefined();
    expect(result.warnings.find((entry) => entry.code === 'CRS_OVERRIDDEN')).toBeUndefined();
  });

  it('refuses when the assumption is contradicted and nothing replaces it', async () => {
    // 412,345 is not a longitude. Writing it into a KML as one would produce a
    // file that opens, draws, and puts the site in the Gulf of Guinea.
    await expect(
      convert({
        input: source(),
        targetFormatId: 'kml',
        settings: { precision: SURVEY_DEFAULT_PRECISION },
      })
    ).rejects.toThrow(/source CRS is unknown/);
  });

  it('warns about the contradiction even when no transform was needed', async () => {
    // Shapefile imposes nothing, so nothing blocks — but a .prj claiming WGS 84
    // over metre coordinates is a wrong file, and it must not be written mute.
    const result = await convert({
      input: source(),
      targetFormatId: 'shapefile',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    });
    const contradicted = result.warnings.find((entry) => entry.code === 'CRS_ASSUMPTION_CONTRADICTED');
    expect(contradicted?.message).toContain('±180');
    expect(contradicted?.severity).toBe('warning');
  });

  it('says nothing when the assumption holds', async () => {
    const wgs84 = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [86.2, 23.35] } }],
    });
    const result = await convert({
      input: { fileName: 'points.geojson', bytes: encoder.encode(wgs84) },
      targetFormatId: 'kml',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    });
    expect(result.warnings.find((entry) => entry.code === 'CRS_ASSUMPTION_CONTRADICTED')).toBeUndefined();
    expect(result.warnings.find((entry) => entry.code === 'CRS_TRANSFORMED')).toBeUndefined();
  });

  it('warns loudly when a selection contradicts a CRS the file really stated', async () => {
    // A GeoJSON that carries a legacy `crs` member has stated something. The
    // user may still override it — a .prj from the wrong job is common — but
    // that is a disagreement, and it gets said out loud rather than filed as a
    // routine selection.
    const declared = JSON.stringify({
      type: 'FeatureCollection',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32644' } },
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [412345.678, 2591234.567] } }],
    });

    const result = await convert({
      input: { fileName: 'stated.geojson', bytes: encoder.encode(declared) },
      targetFormatId: 'kml',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
    });

    const overridden = result.warnings.find((entry) => entry.code === 'CRS_OVERRIDDEN');
    expect(overridden?.severity).toBe('warning');
    expect(overridden?.message).toContain('32644');
    expect(overridden?.message).toContain('32645');
  });
});

describe('the reprojected file reads back where it was written', () => {
  it('round-trips UTM to KML and back to degrees in the right place', async () => {
    const toKml = await convert({
      input: source(),
      targetFormatId: 'kml',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
    });

    const back = await convert({
      input: { fileName: 'out.kml', bytes: toKml.outputs[0].bytes },
      targetFormatId: 'geojson',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    });

    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    const point = parsed.features.find((entry: { geometry: { type: string } }) => entry.geometry.type === 'Point');
    expect(point.geometry.coordinates[0]).toBeGreaterThan(84);
    expect(point.geometry.coordinates[0]).toBeLessThan(88);
    expect(point.geometry.coordinates[1]).toBeGreaterThan(22);
    expect(point.geometry.coordinates[1]).toBeLessThan(24);
  });

  it('round-trips UTM to KMZ, which is the same writer inside a ZIP', async () => {
    const toKmz = await convert({
      input: source(),
      targetFormatId: 'kmz',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
    });

    const back = await convert({
      input: { fileName: 'out.kmz', bytes: toKmz.outputs[0].bytes },
      targetFormatId: 'geojson',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    });

    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    const point = parsed.features.find((entry: { geometry: { type: string } }) => entry.geometry.type === 'Point');
    expect(point.geometry.coordinates[0]).toBeGreaterThan(84);
    expect(point.geometry.coordinates[0]).toBeLessThan(88);
  });
});
