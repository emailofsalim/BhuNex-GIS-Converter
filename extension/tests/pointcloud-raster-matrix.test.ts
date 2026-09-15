/**
 * The last untested corner of the grid: cloud to cloud, and grid to grid.
 *
 * `conversion-matrix.test.ts` crosses the vector formats and `cross-kind.test.ts`
 * crosses the data kinds. Neither touches LAS → PLY, PTS → XYZ or ASCII Grid →
 * GeoTIFF, and the capability audit only ever round-trips a format to ITSELF —
 * so a defect that needs one cloud format's output fed to another's reader had
 * nowhere to show up. That is the same blind spot that hid six defects on the
 * vector side, and it deserved the same treatment.
 *
 * IT FOUND NOTHING, which is worth saying plainly rather than dressing up: all
 * sixteen cloud pairs and all four raster pairs already carried every point and
 * every pixel, exactly. These tests exist to keep it that way, not to record a
 * repair.
 *
 * WHAT IS MEASURED
 *
 * Counts prove nothing on their own — a writer that moved every point a metre
 * would pass a count — so this compares VALUES: each point against its
 * counterpart, and each pixel against the cell it came from.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';
import { FORMATS } from '@core/registry';
import { crsFromEpsg } from '@crs/epsg';

const UTM44N = crsFromEpsg(32644);

/**
 * Ten points with millimetre fractions on every ordinate.
 *
 * Deliberately not round numbers: LAS stores integers against a scale factor,
 * so a cloud on whole metres would round-trip perfectly no matter how wrong the
 * scaling was. These fractions are what make the quantisation observable.
 */
const XYZ = Array.from({ length: 10 }, (_, index) =>
  [
    (412300.123 + index * 10.007).toFixed(3),
    (2591200.456 + index * 7.013).toFixed(3),
    (410.117 + index * 1.371).toFixed(3),
  ].join(' ')
).join('\n');

/** A small DEM with a real georeference and a NODATA value. */
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

const exchangeable = (kind: string) =>
  FORMATS.filter(
    (format) =>
      format.dataKind === kind &&
      ['full', 'partial'].includes(format.support.import) &&
      ['full', 'partial'].includes(format.support.export)
  );

const CLOUDS = exchangeable('pointcloud');
const RASTERS = exchangeable('raster');

async function run(fileName: string, bytes: Uint8Array, targetFormatId: string): Promise<any> {
  return convert({ input: { fileName, bytes }, targetFormatId, settings: { sourceCrs: UTM44N } } as never);
}

/** One real file per readable cloud format, written by this tool. */
const seeds = new Map<string, { name: string; bytes: Uint8Array }>();

async function seed(id: string, sourceName: string, sourceBody: string): Promise<{ name: string; bytes: Uint8Array }> {
  const existing = seeds.get(id);
  if (existing) return existing;
  const written = await run(sourceName, new TextEncoder().encode(sourceBody), id);
  const made = { name: written.outputs[0].name, bytes: written.outputs[0].bytes as Uint8Array };
  seeds.set(id, made);
  return made;
}

/** The furthest any point moved, across all three ordinates. */
function worstDrift(a: any, b: any): number {
  let worst = 0;
  const count = Math.min(a.loaded, b.loaded);
  for (let index = 0; index < count; index++) {
    worst = Math.max(
      worst,
      Math.abs(a.points.x[index] - b.points.x[index]),
      Math.abs(a.points.y[index] - b.points.y[index]),
      Math.abs(a.points.z[index] - b.points.z[index])
    );
  }
  return worst;
}

describe('the point-cloud matrix', () => {
  it('covers every cloud format that can be both read and written', () => {
    expect(CLOUDS.map((format) => format.id).sort()).toEqual(['las', 'ply', 'pts', 'xyz']);
  });

  for (const from of CLOUDS) {
    for (const to of CLOUDS) {
      it(`${from.id} → ${to.id} keeps every point where it was`, async () => {
        const input = await seed(from.id, 'cloud.xyz', XYZ);
        const result: any = await run(input.name, input.bytes, to.id);

        const before = result.sourceDataset?.pointcloud;
        const after = result.outputDataset?.pointcloud;
        expect(before?.loaded, `${from.id} → ${to.id}: the source read as empty`).toBe(10);
        expect(after?.loaded, `${from.id} → ${to.id} lost points`).toBe(10);

        // One millimetre: below any survey tolerance, and the level at which
        // LAS's integer-plus-scale storage is allowed to round.
        expect(
          worstDrift(before, after),
          `${from.id} → ${to.id} moved a point`
        ).toBeLessThanOrEqual(0.001);

        expect(result.qa?.verdict, `${from.id} → ${to.id}: ${result.qa?.summary}`).not.toBe('FAILED');
      });
    }
  }
});

describe('the raster matrix', () => {
  it('covers every grid format that can be both read and written', () => {
    expect(RASTERS.map((format) => format.id).sort()).toEqual(['asciigrid', 'geotiff']);
  });

  for (const from of RASTERS) {
    for (const to of RASTERS) {
      it(`${from.id} → ${to.id} keeps the grid and its georeference`, async () => {
        const input = await seed(from.id, 'surface.asc', ASC);
        const result: any = await run(input.name, input.bytes, to.id);

        const before = result.sourceDataset?.raster;
        const after = result.outputDataset?.raster;
        expect([after?.width, after?.height], `${from.id} → ${to.id} changed the grid shape`).toEqual([
          before?.width,
          before?.height,
        ]);
        expect(result.qa?.verdict, `${from.id} → ${to.id}: ${result.qa?.summary}`).not.toBe('FAILED');
      });
    }
  }

  it('returns every pixel value through GeoTIFF and back', async () => {
    // Read from the written text, because this is about the file a user opens
    // in QGIS rather than an in-memory structure that agreed with itself.
    const tif = await run('surface.asc', new TextEncoder().encode(ASC), 'geotiff');
    const back = await run(tif.outputs[0].name, tif.outputs[0].bytes, 'asciigrid');
    const text = new TextDecoder().decode(back.outputs[0].bytes);

    const values = text
      .split('\n')
      .filter((line) => /^[\d-]/.test(line.trim()))
      .flatMap((line) => line.trim().split(/\s+/).map(Number));
    expect(values).toEqual([
      410.1, 411.2, 412.3, 413.4, 414.5, 415.6, 416.7, 417.8, 418.9, 419.0, 420.1, 421.2,
    ]);
  });

  it('keeps the corner, the cell size and NODATA, which place the grid on the ground', async () => {
    const tif = await run('surface.asc', new TextEncoder().encode(ASC), 'geotiff');
    const back = await run(tif.outputs[0].name, tif.outputs[0].bytes, 'asciigrid');
    const text = new TextDecoder().decode(back.outputs[0].bytes);

    // A DEM that keeps its numbers and loses its corner is in the wrong place,
    // which is harder to notice than losing the numbers outright.
    expect(text).toMatch(/xllcorner\s+412300/);
    expect(text).toMatch(/yllcorner\s+2591200/);
    expect(text).toMatch(/cellsize\s+10\./);
    expect(text).toMatch(/NODATA_value\s+-9999/);
  });
});
