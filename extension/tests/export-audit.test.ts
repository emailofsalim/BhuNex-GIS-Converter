/**
 * EVERY writable format, against one dataset, checked for two failures the
 * owner reported from real use:
 *
 *   "the polygons structures becomes hampered and changed on export"
 *   "some exports dont even giving a valid output it was empty file"
 *
 * The existing fidelity suite covers four formats by name. This one asks the
 * registry what it claims to write and exercises the lot, so a format cannot be
 * added and quietly go untested — which is how a writer that emits nothing gets
 * to ship.
 *
 * WHAT COUNTS AS A FAILURE HERE
 *
 *   EMPTY — the writer returned no bytes, or so few that it cannot contain the
 *   geometry. A file the user downloads and cannot open is the worst outcome
 *   the converter has, because nothing on screen says it went wrong.
 *
 *   STRUCTURE — the ring count changed. A polygon with a hole that comes back
 *   as two polygons has the same vertices and the wrong meaning: the hole has
 *   become land. That is the "hampered and changed" complaint, and vertex
 *   counting alone cannot see it.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';
import { FORMATS } from '@core/registry';

const E = 412000;
const N = 2591300;

/**
 * One feature of each kind a survey file actually carries, so a writer cannot
 * pass by handling only the easy one.
 */
const SOURCE = JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32644' } },
  features: [
    {
      type: 'Feature',
      properties: { plot: '12/A', owner: 'Survey Dept', area_m2: 2400 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[E, N], [E + 60, N], [E + 60, N + 45], [E, N + 45], [E, N]],
          [[E + 20, N + 15], [E + 20, N + 30], [E + 40, N + 30], [E + 40, N + 15], [E + 20, N + 15]],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { plot: '13', owner: 'Survey Dept' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[E, N + 55], [E + 50, N + 55], [E + 50, N + 90], [E, N + 90], [E, N + 55]]],
          [[[E + 62, N + 55], [E + 125, N + 55], [E + 125, N + 90], [E + 62, N + 90], [E + 62, N + 55]]],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { road: 'NH-33' },
      geometry: { type: 'LineString', coordinates: [[E, N + 50], [E + 60, N + 50], [E + 125, N + 52]] },
    },
    {
      type: 'Feature',
      properties: { mark: 'BM-1', z: 412.5 },
      geometry: { type: 'Point', coordinates: [E + 10, N + 10] },
    },
  ],
});

/** Ring count, outer and inner alike — the number that catches a lost hole. */
function ringsOf(geometry: any): number[][][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates as number[][][];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as number[][][][]).flat();
  if (geometry.type === 'GeometryCollection') return (geometry.geometries ?? []).flatMap(ringsOf);
  return [];
}

function allRings(dataset: any): number[][][] {
  return (dataset?.layers ?? []).flatMap((layer: any) =>
    (layer.features ?? layer.preview ?? []).flatMap((f: any) => ringsOf(f.geometry))
  );
}

function vertexCount(dataset: any): number {
  return allRings(dataset).reduce((sum, ring) => sum + ring.length, 0);
}

/**
 * Every format the registry says it can WRITE in the browser, that can hold
 * VECTOR data.
 *
 * The raster and point-cloud targets are excluded deliberately, and it is
 * worth saying why rather than just filtering them out: asking for polygons as
 * a DEM is refused by the pre-flight with
 *
 *   "This is vector data and ESRI ASCII Grid / DEM stores raster data.
 *    No engine converts between them."
 *
 * That refusal is the converter being right. An audit that demanded bytes from
 * those would be testing its own bad assumption, not the product — which is
 * exactly what the first run of this file did.
 */
const WRITABLE = FORMATS.filter(
  (f: any) =>
    f.support?.export &&
    f.support.export !== 'none' &&
    f.writerEngine &&
    !f.requiresNative &&
    !f.requiresExternalTool &&
    (f.dataKind === 'vector' || f.dataKind === 'any' || f.dataKind === 'mixed')
).map((f: any) => f.id);

/** Bytes out of a conversion result. */
function bytesOf(result: any): number {
  return (result?.outputs ?? []).reduce((sum: number, f: any) => sum + (f?.bytes?.length ?? 0), 0);
}

describe('every format the registry claims to write produces a real file', () => {
  it('the registry actually offers writers to audit', () => {
    expect(WRITABLE.length, 'no writable formats found — the filter is wrong').toBeGreaterThan(10);
  });

  for (const target of WRITABLE) {
    it(`${target}: writes bytes`, async () => {
      const result: any = await convert({
        input: { fileName: 'survey.geojson', bytes: new TextEncoder().encode(SOURCE) },
        targetFormatId: target,
      } as never);

      const size = bytesOf(result);
      const failure = result?.failure ?? result?.error;
      // eslint-disable-next-line no-console
      console.log(
        `[${String(target).padEnd(12)}] bytes=${String(size).padStart(8)}` +
          ` qa=${result?.qa?.verdict ?? '-'}` +
          (failure ? `  FAILURE: ${failure.what ?? failure.message ?? JSON.stringify(failure).slice(0, 80)}` : '')
      );

      expect(failure, `${target} refused: ${JSON.stringify(failure)}`).toBeFalsy();
      // 64 bytes is below any real container's own header, let alone geometry.
      expect(size, `${target} wrote an empty or stub file`).toBeGreaterThan(64);
    });
  }
});

/**
 * A RED VERDICT ON A CORRECT CONVERSION IS WORSE THAN NO VERDICT.
 *
 * Four formats used to report FAILED on output whose every vertex was exact,
 * for two reasons that were both the checker's fault rather than the writer's:
 *
 *   DRIFT paired source[i] with output[i]. GPX has no polygons, so rings become
 *   tracks and waypoints are written first; a four-feature sheet came back as
 *   six with a point at index 0, and the check measured a parcel corner against
 *   a benchmark. It reported 0.001026° for GPX and exactly 125.0 for Surpac STR
 *   — which is the width of the test sheet, i.e. one feature against another.
 *
 *   FEATURE COUNT allowed a legitimate split for a hardcoded three formats
 *   (shapefile, csv, xlsx) and failed every other format that cannot hold
 *   multi-part geometry — while printing a note that said exactly why the split
 *   was correct.
 *
 * Both measured in this repository, not supposed: GPX and Surpac STR round-trip
 * all 24 vertices to 0.00 and 5e-8 respectively. This test holds that line.
 */
describe('a correct conversion is not reported as failed', () => {
  // Formats that legitimately restructure: no polygons, or no multi-part.
  for (const target of ['gpx', 'osm', 'landxml', 'surpac-str'].filter((t) => WRITABLE.includes(t))) {
    it(`${target}: losses are named, not marked as failure`, async () => {
      const result: any = await convert({
        input: { fileName: 'survey.geojson', bytes: new TextEncoder().encode(SOURCE) },
        targetFormatId: target,
      } as never);

      const failed = (result?.qa?.checks ?? []).filter((c: any) => c.status === 'fail');
      // eslint-disable-next-line no-console
      console.log(`[${String(target).padEnd(12)}] ${result?.qa?.verdict} — ${result?.qa?.summary ?? ''}`);

      expect(
        failed.map((c: any) => `${c.name}: ${c.source}→${c.target}`),
        `${target}: a structural difference the format declares is not a failure`
      ).toEqual([]);
      expect(result?.qa?.verdict, `${target} verdict`).not.toBe('FAILED');
    });
  }
});

describe('a polygon with a hole keeps its ring structure', () => {
  // Formats that can represent an interior ring at all. CSV, XYZ and the point
  // formats cannot, and saying so here is honest rather than skipping silently.
  const RING_CAPABLE = ['geojson', 'topojson', 'shapefile', 'kml', 'kmz', 'gml', 'wkt', 'wkb', 'flatgeobuf', 'geojsonseq', 'dxf'];

  for (const target of RING_CAPABLE.filter((t) => WRITABLE.includes(t))) {
    it(`${target}: the hole is still a hole`, async () => {
      const result: any = await convert({
        input: { fileName: 'survey.geojson', bytes: new TextEncoder().encode(SOURCE) },
        targetFormatId: target,
      } as never);

      const back = result?.outputDataset;
      if (!back) {
        // eslint-disable-next-line no-console
        console.log(`[${target}] no re-import available — structure not checked`);
        return;
      }

      // Counted from the fixture rather than written into a comment: 12/A's
      // outer ring and its hole, plus both parts of 13 — four rings, twenty
      // polygon vertices. An arithmetic slip in a comment here would quietly
      // become the thing the assertion trusts.
      const sourceRings = JSON.parse(SOURCE).features.flatMap((f: any) => ringsOf(f.geometry)).length;
      const rings = allRings(back);
      // eslint-disable-next-line no-console
      console.log(`[${String(target).padEnd(12)}] rings=${rings.length}/${sourceRings} vertices=${vertexCount(back)}`);
      expect(rings.length, `${target}: ring count changed — a hole became land, or a part was lost`).toBe(sourceRings);
    });
  }
});
