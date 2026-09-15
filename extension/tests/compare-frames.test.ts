/**
 * The two compare panes hold the same shape, because they hold the same frame.
 *
 * THE REPORT: "compare the import canvas and convert canvas — both geometries
 * are different, but why? It needs to be the same if no editing is performed."
 *
 * The geometry WAS the same, and the panes were still right to look different.
 * A DXF → KML conversion of the survey fixture comes back with identical vertex
 * counts on all eight rings and a PASSing QA, and yet the two pictures do not
 * lie over each other, because they are drawn in two coordinate systems:
 *
 *   · a 0.34° ROTATION, measured here — meridian convergence, the angle
 *     between grid north and true north, which is a property of UTM and not a
 *     defect in anything;
 *   · an 8% horizontal SQUEEZE at this latitude — a degree of longitude is
 *     cos(23.4°) of a degree of latitude, and a canvas that plots lon/lat
 *     straight onto x/y draws the world stretched by 1/cos(φ). At 60° that is
 *     a factor of two.
 *
 * So there was nothing to fix in the conversion and everything to fix in the
 * view: a compare whose halves cannot be superimposed is not comparing. The
 * output pane is now brought back into the SOURCE's frame for display, and the
 * canvas corrects the longitude squeeze wherever it draws degrees.
 *
 * This suite pins the finding (the geometry survives) and the fix (one frame),
 * because both halves are needed: a future change that quietly dropped a vertex
 * would pass a test that only checked the frames.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convert } from '@core/pipeline';
import { crsFromEpsg } from '@crs/epsg';
import { sameCrs, transformDataset } from '@crs/transform';

const UTM44N = crsFromEpsg(32644);
const DXF = readFileSync(join(import.meta.dirname, 'fixtures', 'survey-multilayer.dxf'));

function ringsOf(dataset: any): number[][][] {
  const out: number[][][] = [];
  for (const layer of dataset?.layers ?? []) {
    for (const feature of layer.features ?? layer.preview ?? []) {
      const geometry = feature.geometry;
      if (!geometry) continue;
      const push = (ring: number[][]) => out.push(ring);
      if (geometry.type === 'Polygon') geometry.coordinates.forEach(push);
      else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach((part: any) => part.forEach(push));
      else if (geometry.type === 'LineString') push(geometry.coordinates);
      else if (geometry.type === 'MultiLineString') geometry.coordinates.forEach(push);
    }
  }
  return out;
}

/** The angle that best rotates one ring onto another, in degrees. */
function bestFitRotation(a: number[][], b: number[][]): number {
  const centre = (r: number[][]) => [
    r.reduce((sum, p) => sum + p[0], 0) / r.length,
    r.reduce((sum, p) => sum + p[1], 0) / r.length,
  ];
  const [ax, ay] = centre(a);
  const [bx, by] = centre(b);
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.length; i++) {
    const px = a[i][0] - ax;
    const py = a[i][1] - ay;
    const qx = b[i][0] - bx;
    const qy = b[i][1] - by;
    num += px * qy - py * qx;
    den += px * qx + py * qy;
  }
  return (Math.atan2(num, den) * 180) / Math.PI;
}

async function convertFixture(): Promise<any> {
  return convert({
    input: { fileName: 'survey-multilayer.dxf', bytes: new Uint8Array(DXF) },
    targetFormatId: 'kml',
    settings: { sourceCrs: UTM44N, runQa: true },
  } as never);
}

describe('the conversion itself changes no geometry', () => {
  it('returns every ring with every vertex', async () => {
    const result = await convertFixture();
    const source = ringsOf(result.sourceDataset).map((r) => r.length);
    const output = ringsOf(result.outputDataset).map((r) => r.length);
    expect(output, 'a ring or a vertex was lost between source and output').toEqual(source);
    expect(result.qa?.verdict).toBe('PASS');
  });
});

describe('the panes differed by frame, not by shape', () => {
  it('is a rotation, and the rotation is meridian convergence', async () => {
    // Pinned as a RANGE rather than a value: it is a real geodetic quantity
    // that depends on where the data sits in the zone, not a magic number. What
    // matters is that it is small, non-zero, and consistent — which is what
    // tells a reader the panes were rotated rather than reshaped.
    const result = await convertFixture();
    const source = ringsOf(result.sourceDataset);
    const output = ringsOf(result.outputDataset);
    const longest = source.reduce((best, ring, index) => (ring.length > source[best].length ? index : best), 0);
    const angle = Math.abs(bestFitRotation(source[longest], output[longest]));
    expect(angle).toBeGreaterThan(0.01);
    expect(angle, 'a whole-shape rotation this large is not convergence').toBeLessThan(5);
  });

  it('disappears once the output is brought into the source frame', async () => {
    // THE FIX, measured the way the eye sees it. Reprojected back, the two
    // datasets sit on top of each other to well under a millimetre.
    const result = await convertFixture();
    const from = result.outputDataset?.crs ?? null;
    const to = result.sourceDataset?.crs ?? UTM44N;
    expect(sameCrs(from, to), 'this pair no longer crosses a CRS, so the test proves nothing').toBe(false);

    const back = transformDataset(result.outputDataset, to);
    const source = ringsOf(result.sourceDataset);
    const moved = ringsOf(back);
    expect(moved.map((r) => r.length)).toEqual(source.map((r) => r.length));

    let worst = 0;
    for (let i = 0; i < source.length; i++) {
      for (let k = 0; k < source[i].length; k++) {
        worst = Math.max(worst, Math.hypot(source[i][k][0] - moved[i][k][0], source[i][k][1] - moved[i][k][1]));
      }
    }
    // ONE CENTIMETRE, not zero, and the difference matters.
    //
    // The output is stored in WGS 84 at the format's decimal precision, so
    // bringing it back is a round trip through a projection and its inverse:
    // measured at 7.2 mm here, consistent with the ~5.8 mm this project already
    // documents for the UTM → WGS 84 → UTM trip. Asserting zero would be
    // asserting that a lossy store is lossless. What the threshold buys is the
    // distinction that matters to a surveyor: a centimetre is the arithmetic,
    // and anything approaching the 0.34° rotation this replaces would be tens
    // of metres.
    expect(worst, `the panes still differ by ${worst.toFixed(4)} m after reprojection`).toBeLessThan(0.01);
  });
});
