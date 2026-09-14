/**
 * Conversions that cross a DATA KIND — a table to geometry, a cloud to CAD, a
 * raster to vector.
 *
 * `conversion-matrix.test.ts` crosses the vector grid. This file crosses the
 * other boundary, which is where the kinds have to agree about what a
 * conversion even means, and where the pipeline had been claiming a capability
 * it did not have.
 *
 * WHAT THIS FOUND
 *
 * `checkDataKind` permits raster → vector, with a comment naming the reason:
 * "a raster's footprint is exportable as vector (rasterFootprint)". The
 * prediction engine states it to the user's face — "Only the raster's footprint
 * will be written as a polygon". And `rasterFootprint` was never called. Every
 * writer was handed a dataset with no features and wrote an empty document:
 *
 *     raster → WKB      0 bytes          a file that will not open
 *     raster → WKT      1 byte           a newline
 *     raster → GeoJSON  an empty collection
 *     raster → KML      an empty Document
 *
 * all reported as successful conversions. This is the "some exports don't even
 * give a valid output, it was an empty file" complaint, found at its source.
 *
 * The one writer that behaved was Shapefile, which refuses when it has nothing
 * to write — and that refusal is what made the rest visible.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';
import { FORMATS } from '@core/registry';
import { crsFromEpsg } from '@crs/epsg';

const UTM44N = crsFromEpsg(32644);

/** A levelled survey table — the "point list to Google Earth" workflow. */
const CSV = [
  'Point,Easting,Northing,Elevation,Code',
  'BM1,412345.678,2591234.567,412.345,BENCHMARK',
  'BM2,412445.123,2591334.891,415.210,BENCHMARK',
  'TP1,412545.900,2591434.010,418.007,TRAVERSE',
].join('\n');

/** A 4x3 grid with a real georeference. */
const ASC = [
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

const XYZ = [
  '412300.00 2591200.00 410.10',
  '412310.00 2591210.00 411.20',
  '412320.00 2591220.00 412.30',
  '412330.00 2591230.00 413.40',
].join('\n');

const VECTOR_TARGETS = FORMATS.filter(
  (format) => format.dataKind === 'vector' && ['full', 'partial'].includes(format.support.export)
);

async function run(fileName: string, body: string, targetFormatId: string): Promise<any> {
  return convert({
    input: { fileName, bytes: new TextEncoder().encode(body) },
    targetFormatId,
    settings: { sourceCrs: UTM44N },
  } as never);
}

function featureCount(dataset: unknown): number {
  const layers = (dataset as { layers?: { features?: unknown[] }[] } | undefined)?.layers ?? [];
  return layers.reduce((total, layer) => total + (layer.features ?? []).length, 0);
}

describe('a raster written to a vector format', () => {
  for (const target of VECTOR_TARGETS) {
    it(`gives ${target.id} a real footprint rather than an empty file`, async () => {
      const result = await run('surface.asc', ASC, target.id);
      const bytes = result.outputs.reduce((total: number, output: any) => total + output.bytes.length, 0);
      // 20 bytes is below any real format's own header, let alone a polygon.
      // The failing case was literally zero.
      expect(bytes, `${target.id} wrote ${bytes} bytes`).toBeGreaterThan(20);
      expect(featureCount(result.outputDataset), `${target.id} contains no geometry`).toBe(1);
    });
  }

  it('is a rectangle on the raster’s own corners, not an approximation', async () => {
    const result = await run('surface.asc', ASC, 'geojson');
    const parsed = JSON.parse(new TextDecoder().decode(result.outputs[0].bytes));
    const ring = parsed.features[0].geometry.coordinates[0];
    const xs = ring.map((p: number[]) => p[0]);
    const ys = ring.map((p: number[]) => p[1]);
    // 4 columns x 10 m from 412300, 3 rows x 10 m from 2591200.
    expect(Math.min(...xs)).toBeCloseTo(412300, 6);
    expect(Math.max(...xs)).toBeCloseTo(412340, 6);
    expect(Math.min(...ys)).toBeCloseTo(2591200, 6);
    expect(Math.max(...ys)).toBeCloseTo(2591230, 6);
  });

  it('says it wrote the footprint, and how to keep the pixels instead', async () => {
    const result = await run('surface.asc', ASC, 'geojson');
    const notice = (result.warnings ?? []).find((warning: any) => warning.code === 'RASTER_FOOTPRINT_ONLY');
    expect(notice, 'the substitution was silent').toBeTruthy();
    expect(notice.action).toMatch(/GeoTIFF|ASCII Grid/);
    expect(notice.action).toMatch(/Vectorise/i);
  });

  it('checks the footprint against the footprint, not against the pixel grid', async () => {
    // Comparing a footprint polygon with the raster it came from asks a question
    // neither can answer, which is why every one of these read NOT VALIDATED.
    const result = await run('surface.asc', ASC, 'geojson');
    expect(result.qa?.verdict, result.qa?.summary).toBe('PASS');
  });
});

describe('a point cloud written to a vector format', () => {
  it('keeps every point and is verified, rather than left unchecked', async () => {
    const result = await run('cloud.xyz', XYZ, 'geojson');
    expect(featureCount(result.outputDataset)).toBe(4);
    expect(result.qa?.verdict, result.qa?.summary).toBe('PASS');
  });

  it('keeps the levels, which are the reason the cloud exists', async () => {
    const result = await run('cloud.xyz', XYZ, 'geojson');
    const parsed = JSON.parse(new TextDecoder().decode(result.outputs[0].bytes));
    const zs = parsed.features.map((f: any) => f.geometry.coordinates[2]).sort((a: number, b: number) => a - b);
    expect(zs).toEqual([410.1, 411.2, 412.3, 413.4]);
  });
});

describe('a survey table written to a vector format', () => {
  it('becomes points in every vector format', async () => {
    for (const target of VECTOR_TARGETS) {
      const result = await run('survey.csv', CSV, target.id);
      expect(featureCount(result.outputDataset), `${target.id} lost the points`).toBeGreaterThanOrEqual(3);
    }
  });

  /**
   * The column called "Point".
   *
   * A survey table's first column is the point number, and it is very often
   * headed exactly that. The GML writer namespaces it correctly as
   * `<ugc:Point>`, beside the real `<gml:Point>` geometry — but the reader
   * matched on the LOCAL name, found the attribute first, saw no coordinates in
   * it and rejected the whole document: "3 member elements but none carried a
   * readable geometry". A good file, every feature lost, to a name collision.
   */
  it('survives an attribute named after a GML geometry', async () => {
    const result = await run('survey.csv', CSV, 'gml');
    expect(result.qa?.verdict, result.qa?.summary).not.toBe('NOT_VALIDATED');
    expect(featureCount(result.outputDataset)).toBe(3);
  });

  it('keeps that column as an attribute rather than mistaking it for geometry', async () => {
    const result = await run('survey.csv', CSV, 'gml');
    const properties = (result.outputDataset?.layers ?? [])
      .flatMap((layer: any) => layer.features ?? [])
      .map((feature: any) => feature.properties?.Point);
    expect(properties.sort()).toEqual(['BM1', 'BM2', 'TP1']);
  });

  it('carries the levels into GML, which has always been able to hold them', async () => {
    // GML declares its dimension on the ordinate element, and this reader has
    // always honoured `srsDimension`. The writer never emitted one, so every
    // reduced level was dropped on the way out.
    const result = await run('survey.csv', CSV, 'gml');
    const text = new TextDecoder().decode(result.outputs[0].bytes);
    expect(text).toContain('srsDimension="3"');
    expect(text).toContain('412.345');

    const zs = (result.outputDataset?.layers ?? [])
      .flatMap((layer: any) => layer.features ?? [])
      .map((feature: any) => feature.geometry?.coordinates?.[2])
      .sort((a: number, b: number) => a - b);
    expect(zs).toEqual([412.345, 415.21, 418.007]);
  });
});

describe('the kinds that genuinely cannot convert', () => {
  const impossible: [string, string, string][] = [
    ['survey.csv', CSV, 'geotiff'],
    ['survey.csv', CSV, 'las'],
    ['surface.asc', ASC, 'csv'],
    ['surface.asc', ASC, 'las'],
    ['cloud.xyz', XYZ, 'geotiff'],
  ];

  for (const [fileName, body, target] of impossible) {
    it(`refuses ${fileName} → ${target} and names both kinds`, async () => {
      // The refusal is the product here. A tool that guesses at a conversion it
      // has no engine for is worse than one that says no.
      const error = await run(fileName, body, target).then(
        () => null,
        (e: Error) => e
      );
      expect(error, `${fileName} → ${target} did not refuse`).toBeTruthy();
      expect(error!.message).toMatch(/No engine converts between them/);
      expect(error!.message, 'the refusal suggests nothing').toMatch(/Choose a .* target instead/);
    });
  }
});
