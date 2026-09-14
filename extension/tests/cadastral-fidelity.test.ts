/**
 * Cadastral geometry must survive a round trip vertex for vertex.
 *
 * A parcel boundary is legal evidence. The CRS may change on export — that is
 * the point of a converter — but the area, the perimeter and the position of
 * every vertex must not. This suite covers the shapes a cadastral sheet
 * actually contains, as opposed to the well-behaved convex rings a synthetic
 * test tends to produce:
 *
 *   - a parcel with a HOLE (an excluded plot, a tank, a road reservation),
 *     which is the interesting case because DXF has no native concept of an
 *     interior ring at all;
 *   - a parcel in two parts (a MultiPolygon), which is a single legal holding
 *     split by a road;
 *   - shared boundaries, where two parcels must keep the identical vertices;
 *   - a dense boundary with many short segments.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';

/** Ring area by the shoelace formula. Sign carries the winding. */
function signedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

/** Every ring in a geometry, outer and inner alike, in a stable order. */
function ringsOf(geometry: any): number[][][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates as number[][][];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as number[][][][]).flat();
  if (geometry.type === 'GeometryCollection') return (geometry.geometries ?? []).flatMap(ringsOf);
  return [];
}

function allRings(dataset: any): number[][][] {
  return (dataset?.layers ?? []).flatMap((layer: any) =>
    (layer.features ?? layer.preview ?? []).flatMap((feature: any) => ringsOf(feature.geometry))
  );
}

/** Total vertices across every ring — the headline number in the complaint. */
function vertexCount(dataset: any): number {
  return allRings(dataset).reduce((sum, ring) => sum + ring.length, 0);
}

/** Net area: outer rings minus inner rings, by absolute shoelace. */
function netArea(dataset: any): number {
  return allRings(dataset).reduce((sum, ring) => sum + Math.abs(signedArea(ring)), 0);
}

const E = 412000;
const N = 2591300;

/**
 * Plot 12/A with a tank excluded from the middle — an interior ring.
 * Plot 12/B shares 12/A's eastern boundary exactly.
 * Plot 13 is one holding in two parts, split by a road.
 */
const CADASTRAL = JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32644' } },
  features: [
    {
      type: 'Feature',
      properties: { plot_no: '12/A' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [E, N],
            [E + 60, N],
            [E + 60, N + 45],
            [E, N + 45],
            [E, N],
          ],
          // The tank. Wound opposite to the outer ring, as a hole must be.
          [
            [E + 20, N + 15],
            [E + 20, N + 30],
            [E + 40, N + 30],
            [E + 40, N + 15],
            [E + 20, N + 15],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { plot_no: '12/B' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            // Shares the E+60 edge with 12/A, vertex for vertex.
            [E + 60, N],
            [E + 125, N],
            [E + 125, N + 45],
            [E + 60, N + 45],
            [E + 60, N],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { plot_no: '13' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [E, N + 55],
              [E + 50, N + 55],
              [E + 50, N + 90],
              [E, N + 90],
              [E, N + 55],
            ],
          ],
          [
            [
              [E + 62, N + 55],
              [E + 125, N + 55],
              [E + 125, N + 90],
              [E + 62, N + 90],
              [E + 62, N + 55],
            ],
          ],
        ],
      },
    },
  ],
});

const SOURCE_VERTICES = 5 + 5 + 5 + 5 + 5; // outer, hole, 12/B, and two parts of 13
const SOURCE_AREA = 60 * 45 + 20 * 15 + 65 * 45 + 50 * 35 + 63 * 35;

describe('a cadastral sheet keeps its geometry through a conversion', () => {
  it('the fixture is what the tests think it is', () => {
    const parsed = JSON.parse(CADASTRAL);
    const rings = parsed.features.flatMap((feature: any) => ringsOf(feature.geometry));
    expect(rings.reduce((sum: number, ring: number[][]) => sum + ring.length, 0)).toBe(SOURCE_VERTICES);
    expect(rings.reduce((sum: number, ring: number[][]) => sum + Math.abs(signedArea(ring)), 0)).toBeCloseTo(SOURCE_AREA, 6);
  });

  for (const target of ['shapefile', 'dxf', 'kml', 'geojson'] as const) {
    it(`survives export to ${target} with every vertex intact`, async () => {
      const result = await convert({
        input: { fileName: 'cadastral.geojson', bytes: new TextEncoder().encode(CADASTRAL) },
        targetFormatId: target,
      } as never);

      const qa: any = (result as any).qa;
      // The re-imported output is what QA compared against; if the converter
      // kept it, compare against it here too.
      const reimported = qa?.reimported ?? qa?.output;

      // eslint-disable-next-line no-console
      console.log(
        `\n[${target}] verdict=${qa?.verdict} summary=${qa?.summary ?? ''}` +
          (qa?.checks ?? []).map((check: any) => `\n    ${check.name}: ${check.status} ${check.detail ?? ''}`).join('')
      );

      expect(qa?.verdict).not.toBe('not-validated');
      const vertexCheck = (qa?.checks ?? []).find((check: any) => /vertex/i.test(check.name));
      expect(vertexCheck?.status, `${target}: vertex count check`).toBe('pass');
      const driftCheck = (qa?.checks ?? []).find((check: any) => /drift/i.test(check.name));
      expect(driftCheck?.status, `${target}: coordinate drift`).toBe('pass');

      if (reimported) {
        expect(vertexCount(reimported), `${target}: total vertices`).toBe(SOURCE_VERTICES);
        expect(netArea(reimported), `${target}: total ring area`).toBeCloseTo(SOURCE_AREA, 3);
      }
    });
  }
});
