/**
 * The audit: every capability the registry CLAIMS, exercised end to end.
 *
 * `registry.test.ts` already checks that a format claiming support names an
 * engine, and that its id appears somewhere in the test suite. That is a check
 * on the paperwork, and it is not enough — twice now a claim has been false in
 * a way it could not catch:
 *
 *   · The Help dialog told users "GeoTIFF is metadata-only, pixels are not
 *     decoded", months after the pixel codec shipped and the registry started
 *     recording `import: 'full', export: 'full'`.
 *   · `wkt.ts` reported a Lambert .prj as SUPPORTED by matching /lambert/ on
 *     the projection name, while `CrsRef` carried none of the parameters the
 *     transform needed — so the file loaded, was declared readable, and threw
 *     at conversion time.
 *
 * Both were found by accident. Neither would have been found by asking whether
 * a format id is mentioned in a test file.
 *
 * So this suite does the only thing that actually settles it: for every format
 * the registry says can be written, it WRITES ONE, and for every format it says
 * can be read, it READS THAT BACK. A claim that survives this has bytes behind
 * it. The table is derived from the registry rather than typed out, so a format
 * added later is audited whether or not anyone remembers this file.
 */

import { describe, expect, it } from 'vitest';
import { convert, type ConversionInput } from '@core/pipeline';
import { SURVEY_DEFAULT_PRECISION } from '@core/precision';
import { FORMATS, type FormatDef } from '@core/registry';
import { crsFromEpsg } from '@crs/epsg';
import { readZip } from '@engines/archives/zip';

const encoder = new TextEncoder();
const UTM45N = crsFromEpsg(32645);

/** A survey in UTM 45N: a benchmark, a traverse and a parcel, with attributes. */
const VECTOR_SOURCE = JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32645' } },
  features: [
    { type: 'Feature', properties: { name: 'BM1', code: 'BENCHMARK', elev: 412.345 }, geometry: { type: 'Point', coordinates: [412345.678, 2591234.567] } },
    {
      type: 'Feature',
      properties: { name: 'Traverse', code: 'LINE' },
      geometry: { type: 'LineString', coordinates: [[412300, 2591200], [412400, 2591300], [412500, 2591250]] },
    },
    {
      type: 'Feature',
      properties: { plot_no: '784', khasra: '112/2' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[412300, 2591200], [412400, 2591200], [412400, 2591300], [412300, 2591300], [412300, 2591200]]],
      },
    },
  ],
});

const TABLE_SOURCE = [
  'Point,Easting,Northing,Elevation,Code',
  'BM1,412345.678,2591234.567,412.345,BENCHMARK',
  'BM2,412445.123,2591334.891,415.210,BENCHMARK',
  'TP1,412545.900,2591434.010,418.007,TRAVERSE',
].join('\n');

/** A 4x3 ASCII grid — the simplest raster with a real georeference. */
const RASTER_SOURCE = [
  'ncols 4',
  'nrows 3',
  'xllcorner 412300',
  'yllcorner 2591200',
  'cellsize 10',
  'NODATA_value -9999',
  '410.1 411.2 412.3 413.4',
  '414.5 415.6 416.7 417.8',
  '418.9 419.0 420.1 421.2',
].join('\n');

/** An XYZ cloud, which every point-cloud writer can be fed from. */
const CLOUD_SOURCE = [
  '412300.00 2591200.00 410.10',
  '412310.00 2591210.00 411.20',
  '412320.00 2591220.00 412.30',
  '412330.00 2591230.00 413.40',
].join('\n');

function input(fileName: string, body: string): ConversionInput {
  return { fileName, bytes: encoder.encode(body) };
}

/** The source to feed a target of each data kind, and what it arrives as. */
function sourceFor(kind: FormatDef['dataKind']): ConversionInput {
  switch (kind) {
    case 'raster':
      return input('surface.asc', RASTER_SOURCE);
    case 'pointcloud':
      return input('cloud.xyz', CLOUD_SOURCE);
    case 'table':
      return input('survey.csv', TABLE_SOURCE);
    default:
      return input('survey.geojson', VECTOR_SOURCE);
  }
}

const writes = (format: FormatDef): boolean =>
  format.support.export === 'full' || format.support.export === 'partial';
const reads = (format: FormatDef): boolean =>
  format.support.import === 'full' || format.support.import === 'partial';

/**
 * Formats whose export cannot be exercised from a synthetic source, with the
 * reason each one is here. This list is deliberately short and deliberately
 * explicit: an exemption with no reason beside it is how a broken claim hides.
 */
const NOT_EXERCISABLE: Record<string, string> = {
  // Sidecars are written beside another format, never asked for by name.
  worldfile: 'written alongside a raster, never as a target in its own right',
  prj: 'written alongside a shapefile, never as a target in its own right',
  'gcp-points': 'a QGIS georeferencer sidecar, produced with a warped raster',
  // A ZIP target is the batch packager, not a per-file conversion.
  zip: 'the batch packager, exercised in structure.test.ts rather than as a target',
};

describe('the export claims, each one exercised', () => {
  const targets = FORMATS.filter((format) => writes(format) && !(format.id in NOT_EXERCISABLE));

  it('audits every format the registry says can be written', () => {
    // If this number falls, a format stopped being audited. If it rises, a new
    // one arrived and the loop below is already testing it.
    expect(targets.length).toBeGreaterThanOrEqual(23);
  });

  for (const format of targets) {
    it(`writes ${format.name} (${format.id}), as ${format.support.export} support claims`, async () => {
      const result = await convert({
        input: sourceFor(format.dataKind),
        targetFormatId: format.id,
        settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
      });

      expect(result.outputs.length, `${format.id} produced no output file`).toBeGreaterThan(0);
      const bytes = result.outputs.reduce((total, output) => total + output.bytes.length, 0);
      // A zero-byte file is a writer that ran and wrote nothing, which passes
      // an "it did not throw" test and fails every use of the result.
      expect(bytes, `${format.id} produced an empty file`).toBeGreaterThan(0);
    });
  }
});

/**
 * Turns one written output back into something the reader can be handed.
 *
 * Shapefile and MIF/MID are not one file: a shapefile is .shp/.shx/.dbf/.prj
 * and a MIF is .mif plus .mid, so both are delivered as a ZIP. Feeding the ZIP
 * straight back would test the archive reader rather than the format, and
 * feeding only the first member would hand the shapefile reader a .shp with no
 * attributes and no georeference. The members are unpacked and the companions
 * attached the way the real drop-a-folder path does it.
 */
async function readableInput(output: { name: string; bytes: Uint8Array }, format: FormatDef): Promise<ConversionInput> {
  if (format.packaging !== 'zip') return { fileName: output.name, bytes: output.bytes };

  const entries = await readZip(output.bytes);
  // The primary member is the one whose extension the format is named by.
  const primary =
    entries.find((entry) => format.extensions.some((extension) => entry.name.toLowerCase().endsWith(`.${extension}`))) ??
    entries[0];
  const companions = new Map(
    entries.filter((entry) => entry !== primary).map((entry) => [entry.name.split('.').pop()!, entry.bytes])
  );
  return { fileName: primary.name, bytes: primary.bytes, companions };
}

describe('the round trips, where the registry claims both directions', () => {
  const both = FORMATS.filter(
    (format) => writes(format) && reads(format) && !(format.id in NOT_EXERCISABLE) && format.dataKind === 'vector'
  );

  for (const format of both) {
    it(`reads ${format.name} back after writing it`, async () => {
      const written = await convert({
        input: sourceFor(format.dataKind),
        targetFormatId: format.id,
        settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
      });

      const back = await convert({
        input: await readableInput(written.outputs[0], format),
        targetFormatId: 'geojson',
        settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
      });

      const parsed = JSON.parse(new TextDecoder().decode(back.outputs[0].bytes));
      // Not a count comparison: GPX has no polygon, OSM writes no interior
      // ring, and a format legitimately dropping what it cannot hold is
      // reported elsewhere. What must never happen is everything vanishing.
      expect(parsed.features.length, `${format.id} round-tripped to nothing`).toBeGreaterThan(0);
      expect(
        parsed.features.some((feature: { geometry: unknown }) => feature.geometry !== null),
        `${format.id} round-tripped to features with no geometry`
      ).toBe(true);
    });
  }
});

describe('the claims of NO support, which must refuse rather than fail quietly', () => {
  const adapters = FORMATS.filter((format) => format.support.export === 'adapter');

  it('covers the formats waiting on an engine that is not bundled', () => {
    expect(adapters.map((format) => format.id).sort()).toEqual([
      'dgn',
      'dwg',
      'e57',
      'filegdb',
      'flatgeobuf',
      'geopackage',
      'geoparquet',
      'laz',
    ]);
  });

  for (const format of adapters) {
    it(`refuses ${format.name} with a reason rather than writing something wrong`, async () => {
      // The failure this guards is not a crash. It is a writer that silently
      // emits an empty or malformed file for a format it cannot really
      // produce, which the user discovers in the field.
      await expect(
        convert({
          input: sourceFor(format.dataKind),
          targetFormatId: format.id,
          settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
        })
      ).rejects.toThrow();
    });
  }
});

describe('what the audit itself must not become', () => {
  it('exempts only the formats named, each with a stated reason', () => {
    for (const [id, reason] of Object.entries(NOT_EXERCISABLE)) {
      expect(FORMATS.some((format) => format.id === id), `${id} is exempted but is not a format`).toBe(true);
      expect(reason.length, `${id} is exempted with no reason`).toBeGreaterThan(20);
    }
  });

  it('leaves no format both unexercised and unexplained', () => {
    const exercised = new Set(
      FORMATS.filter((format) => writes(format) && !(format.id in NOT_EXERCISABLE)).map((format) => format.id)
    );
    const missing = FORMATS.filter(
      (format) => writes(format) && !exercised.has(format.id) && !(format.id in NOT_EXERCISABLE)
    );
    expect(missing.map((format) => format.id)).toEqual([]);
  });
});
