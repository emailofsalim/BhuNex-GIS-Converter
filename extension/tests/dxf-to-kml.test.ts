/**
 * DXF to KML and KMZ, held to the standard the work needs.
 *
 * This is the conversion the tool will be used for most: a survey drawing goes
 * to Google Earth so someone can look at it in the field. It has to be exact,
 * and where it cannot be exact it has to refuse rather than approximate.
 *
 * The fixture is a real sheet's worth of awkwardness rather than one tidy
 * square — `fixtures/survey-multilayer.dxf` carries six layers:
 *
 *   PARCEL    a regular rectangle AND a nine-vertex CONCAVE boundary, because
 *             a convex test polygon hides winding and ring-orientation bugs
 *   BOUNDARY  a 180-vertex ring, the "irregular curve" case at real density
 *   ROAD      two open polylines, one of 60 vertices
 *   CONTOUR   three closed rings carrying an elevation
 *   CONTROL   four survey marks with levels
 *   LABELS    text entities
 *
 * WHAT IS ACTUALLY CHECKED
 *
 * Counting vertices is not enough — a writer that moved every vertex ten metres
 * would pass a count. So the output is compared POSITIONALLY against the source
 * reprojected into the output's own CRS: every vertex KML emitted must sit on a
 * source vertex.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convert } from '@core/pipeline';
import { planTransform } from '../src/crs/transform';
import { utmCrs } from '../src/crs/epsg';

const DXF = new Uint8Array(readFileSync(resolve('extension', 'tests', 'fixtures', 'survey-multilayer.dxf')));

/** The sheet is on UTM zone 44N. DXF carries no CRS, so this is stated. */
const SOURCE_CRS = utmCrs(44, false);

/** Every layer the fixture defines, and how many entities each holds. */
const EXPECTED_LAYERS: Record<string, number> = {
  PARCEL: 2,
  BOUNDARY: 1,
  ROAD: 2,
  CONTOUR: 3,
  CONTROL: 4,
  LABELS: 2,
};

function positions(geometry: any): number[][] {
  if (!geometry) return [];
  const { type, coordinates } = geometry;
  if (type === 'Point') return [coordinates];
  if (type === 'MultiPoint' || type === 'LineString') return coordinates;
  if (type === 'MultiLineString' || type === 'Polygon') return coordinates.flat();
  if (type === 'MultiPolygon') return coordinates.flat(2);
  if (type === 'GeometryCollection') return (geometry.geometries ?? []).flatMap(positions);
  return [];
}

const allPositions = (dataset: any): number[][] =>
  (dataset?.layers ?? []).flatMap((layer: any) => (layer.features ?? []).flatMap((f: any) => positions(f.geometry)));

const layerCounts = (dataset: any): Record<string, number> =>
  Object.fromEntries((dataset?.layers ?? []).map((layer: any) => [layer.name, (layer.features ?? []).length]));

async function run(target: string, settings?: Record<string, unknown>): Promise<any> {
  return convert({
    input: { fileName: 'survey.dxf', bytes: DXF },
    targetFormatId: target,
    settings: { sourceCrs: SOURCE_CRS, ...(settings ?? {}) },
  } as never);
}

describe.each(['kml', 'kmz'])('DXF → %s keeps the whole drawing', (target) => {
  it('keeps every layer, by name and by count', async () => {
    const result = await run(target);
    // Layer identity is what makes the output navigable in Google Earth: a
    // conversion that merged CONTOUR into PARCEL would still have every vertex
    // and be useless to the surveyor reading it.
    expect(layerCounts(result.outputDataset)).toEqual(EXPECTED_LAYERS);
  });

  it('keeps every vertex, including the 180-vertex curve and the concave ring', async () => {
    const result = await run(target);
    const before = allPositions(result.sourceDataset).length;
    const after = allPositions(result.outputDataset).length;
    expect(before, 'the fixture did not read as expected').toBeGreaterThan(350);
    expect(after, `${target} dropped vertices`).toBe(before);
  });

  it('puts every vertex where the source said, not merely the right number of them', async () => {
    const result = await run(target);
    // Like against like: the source is in UTM metres, the output in degrees.
    //
    // Transformed from SOURCE_CRS rather than from `sourceDataset.crs`, because
    // a DXF declares no coordinate system at all — that field is null, and
    // `planTransform(null, …)` correctly returns the identity. Reading it off
    // the dataset therefore compared metres against degrees and reported a
    // "drift" of 2,591,276 — which is a northing, not an error.
    const plan = planTransform(SOURCE_CRS, result.outputDataset?.crs ?? null);
    const source = allPositions(result.sourceDataset).map((p: any) => plan.transform(p as never) as number[]);
    const output = allPositions(result.outputDataset);

    // 1e-7 degrees is about 1 cm — below any survey tolerance, and far tighter
    // than the ~1 m a rounding bug would produce.
    let worst = 0;
    for (const point of output) {
      let best = Infinity;
      for (const other of source) {
        const d = Math.max(Math.abs(point[0] - other[0]), Math.abs(point[1] - other[1]));
        if (d < best) best = d;
      }
      if (best > worst) worst = best;
    }
    expect(worst, `${target}: a vertex landed ${worst} degrees from any source vertex`).toBeLessThan(1e-7);
  });

  it('reprojects into WGS 84, which is the only thing KML stores', async () => {
    const result = await run(target);
    expect(result.outputDataset?.crs?.epsg).toBe(4326);
  });

  it('passes its own re-import check', async () => {
    const result = await run(target);
    expect(result.qa?.verdict, `${target}: ${result.qa?.summary}`).toBe('PASS');
  });
});

/**
 * THE REFUSAL IS A FEATURE, and this test exists so nobody "helpfully" removes
 * it.
 *
 * DXF carries no coordinate system. KML stores nothing but WGS 84. Converting
 * between them REQUIRES knowing what the DXF's numbers mean, and the numbers
 * cannot say: an easting near 500,000 is valid in all sixty UTM zones and in
 * both hemispheres. A converter that guessed would put a parcel in the wrong
 * country while looking completely confident.
 */
describe('without a source CRS it refuses rather than guesses', () => {
  it('refuses, and says why and what to do', async () => {
    await expect(
      convert({ input: { fileName: 'survey.dxf', bytes: DXF }, targetFormatId: 'kml' } as never)
    ).rejects.toThrow(/source CRS is unknown|CRS_REQUIRED/i);
  });

  it('names the zone ambiguity rather than blaming the file', async () => {
    const error = await convert({ input: { fileName: 'survey.dxf', bytes: DXF }, targetFormatId: 'kml' } as never).catch(
      (e: Error) => e
    );
    // The message has to leave the user knowing the next action. "Invalid
    // input" would be true and useless.
    expect(String((error as Error).message)).toMatch(/zone|CRS panel|choose/i);
  });
});
