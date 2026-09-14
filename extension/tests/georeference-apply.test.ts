/**
 * Placing a local-grid drawing on real coordinates must not deform it.
 *
 * This is the guarantee a cadastral sheet depends on. The surveyor's distances
 * and angles came off a total station; georeferencing is supposed to say WHERE
 * that geometry sits, not to re-measure it. So a similarity placement must
 * leave every interior angle untouched and scale every length by exactly one
 * constant — which means area scales by exactly that constant squared.
 *
 * The tests below check the invariants rather than the matrix, because it is
 * the invariants a surveyor would be able to defend: shape, angle, the ratio of
 * areas between two parcels, and the fact that a height is not a plan
 * coordinate and must not be touched by a plan transform.
 */

import { describe, expect, it } from 'vitest';
import {
  applyGeoreference,
  describeGeoreference,
  fitSurveyControl,
  revertGeoreference,
  type GeoreferenceRecord,
  type SurveyGcp,
} from '@core/georeference-apply';
import type { CirDataset, CirFeature, Position } from '@core/cir';

function parcel(ring: number[][]): CirFeature {
  return { geometry: { type: 'Polygon', coordinates: [ring], dimension: 2 }, properties: {} };
}

function dataset(features: CirFeature[]): CirDataset {
  return {
    kind: 'vector',
    name: 'local.dxf',
    source: { fileName: 'local.dxf', bytes: 0 },
    crs: null,
    crsOrigin: 'unknown',
    units: null,
    axisOrder: 'xy',
    vertical: { kind: 'none' },
    layers: [{ name: 'PARCEL', path: ['PARCEL'], features, fields: [], geometryTypes: ['Polygon'] }],
  } as unknown as CirDataset;
}

function ringOf(data: CirDataset, index = 0): number[][] {
  return (data.layers[0].features[index].geometry as never as { coordinates: number[][][] }).coordinates[0];
}

function area(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(sum / 2);
}

function perimeter(ring: number[][]): number {
  let total = 0;
  for (let i = 1; i < ring.length; i++) total += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
  return total;
}

/** Interior angle at vertex i, in degrees. */
function angleAt(ring: number[][], i: number): number {
  const n = ring.length - 1; // last repeats the first
  const previous = ring[(i - 1 + n) % n];
  const here = ring[i % n];
  const next = ring[(i + 1) % n];
  const a = Math.atan2(previous[1] - here[1], previous[0] - here[0]);
  const b = Math.atan2(next[1] - here[1], next[0] - here[0]);
  let d = ((b - a) * 180) / Math.PI;
  while (d < 0) d += 360;
  return d;
}

/** A closed, irregular parcel on a local grid — no axis-aligned edges to flatter the maths. */
const LOCAL_PARCEL = [
  [0, 0],
  [45.25, 0],
  [47.8, 21.6],
  [22.4, 38.4],
  [-3.1, 19.75],
  [0, 0],
];

/** Control: the same four corners, observed in UTM 44N. */
const CONTROL: SurveyGcp[] = [
  { local: [0, 0], target: [412000, 2591300] },
  { local: [45.25, 0], target: [412043.1, 2591313.7] },
  { local: [47.8, 21.6], target: [412057.3, 2591330.3] },
  { local: [22.4, 38.4], target: [412038.6, 2591352.6] },
];

describe('georeferencing a local-grid drawing', () => {
  it('a similarity placement preserves every angle and scales area by exactly scale squared', () => {
    const before = dataset([parcel(LOCAL_PARCEL)]);
    const { fit } = fitSurveyControl(CONTROL);
    expect(fit).toBeDefined();

    const record: GeoreferenceRecord = {
      affine: fit!.affine,
      crs: { epsg: 32644, name: 'WGS 84 / UTM 44N' } as never,
      kind: fit!.kind === 'similarity' ? 'similarity' : 'affine',
    };

    const described = describeGeoreference(record.affine);
    const after = applyGeoreference(before, record);

    const source = ringOf(before);
    const placed = ringOf(after);

    expect(placed).toHaveLength(source.length);

    // Every interior angle unchanged — this is what "the shape is not disturbed"
    // means in a form a surveyor can check against the field book.
    for (let i = 0; i < source.length - 1; i++) {
      expect(angleAt(placed, i)).toBeCloseTo(angleAt(source, i), 6);
    }

    // Not conditional. Four noisy control points must still yield a
    // shape-preserving placement, because the survey default is a similarity
    // fit; if this ever becomes an affine again, the parcel silently shears and
    // this assertion is the thing that catches it.
    expect(described.preservesShape).toBe(true);
    const k = described.scaleX;
    expect(perimeter(placed)).toBeCloseTo(perimeter(source) * k, 6);
    expect(area(placed)).toBeCloseTo(area(source) * k * k, 4);
  });

  it('an affine fit over the same control DOES shear it — which is why it is not the default', () => {
    const { fit: similarity } = fitSurveyControl(CONTROL);
    const { fit: affine } = fitSurveyControl(CONTROL, { kind: 'affine' });
    expect(similarity!.kind).toBe('similarity');
    expect(affine!.kind).toBe('affine');

    // The affine fits the control more closely — that is exactly its seduction.
    expect(affine!.rms).toBeLessThanOrEqual(similarity!.rms + 1e-9);
    // And it pays for that with a deformed parcel.
    expect(describeGeoreference(similarity!.affine).preservesShape).toBe(true);
    expect(describeGeoreference(affine!.affine).preservesShape).toBe(false);
  });

  it('reports per-point residuals, so one bad peg cannot hide inside an RMS', () => {
    const { fit } = fitSurveyControl(CONTROL);
    expect(fit!.residuals).toHaveLength(CONTROL.length);
    expect(fit!.worst).toBeGreaterThanOrEqual(fit!.rms);
    for (const entry of fit!.residuals) expect(Number.isFinite(entry.residual)).toBe(true);
  });

  it('calls a two-point fit exactly determined rather than reporting RMS 0 as accuracy', () => {
    const { fit } = fitSurveyControl(CONTROL.slice(0, 2));
    expect(fit!.exactlyDetermined).toBe(true);
    expect(fit!.notes.join(' ')).toMatch(/arithmetic, not a measure of accuracy/i);
  });

  it('refuses control that cannot define a placement', () => {
    const stacked = fitSurveyControl([
      { local: [10, 10], target: [412000, 2591300] },
      { local: [10, 10], target: [412050, 2591330] },
    ]);
    expect(stacked.fit).toBeUndefined();
    expect(stacked.refusal?.what).toMatch(/on top of each other/i);
  });

  it('keeps the vertex count exactly — nothing is dropped or merged', () => {
    const before = dataset([parcel(LOCAL_PARCEL)]);
    const { fit } = fitSurveyControl(CONTROL);
    const after = applyGeoreference(before, {
      affine: fit!.affine,
      crs: { epsg: 32644 } as never,
      kind: 'similarity',
    });
    expect(ringOf(after)).toHaveLength(LOCAL_PARCEL.length);
  });

  it('leaves Z alone: a plan transform must not rescale a levelled height', () => {
    const withHeight = dataset([
      {
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0, 41.237],
            [45.25, 0, 41.982],
          ] as Position[],
          dimension: 3,
        },
        properties: {},
      } as unknown as CirFeature,
    ]);
    const { fit } = fitSurveyControl(CONTROL);
    const after = applyGeoreference(withHeight, { affine: fit!.affine, crs: { epsg: 32644 } as never, kind: 'similarity' });
    const line = (after.layers[0].features[0].geometry as never as { coordinates: number[][] }).coordinates;
    expect(line[0][2]).toBe(41.237);
    expect(line[1][2]).toBe(41.982);
  });

  it('round-trips: placing then reverting returns the original coordinates', () => {
    const before = dataset([parcel(LOCAL_PARCEL)]);
    const { fit } = fitSurveyControl(CONTROL);
    const record: GeoreferenceRecord = { affine: fit!.affine, crs: { epsg: 32644 } as never, kind: 'similarity' };
    const reverted = revertGeoreference(applyGeoreference(before, record), record);
    expect(reverted).not.toBeNull();
    const back = ringOf(reverted!);
    for (const [i, position] of LOCAL_PARCEL.entries()) {
      expect(back[i][0]).toBeCloseTo(position[0], 6);
      expect(back[i][1]).toBeCloseTo(position[1], 6);
    }
    expect(reverted!.crs).toBeNull();
  });

  it('stamps the CRS and records that a person placed it, not the file', () => {
    const before = dataset([parcel(LOCAL_PARCEL)]);
    const { fit } = fitSurveyControl(CONTROL);
    const after = applyGeoreference(before, { affine: fit!.affine, crs: { epsg: 32644 } as never, kind: 'similarity' });
    expect(after.crs).toEqual({ epsg: 32644 });
    // Never 'declared': the file said nothing, and a QA report must not imply it did.
    expect(after.crsOrigin).toBe('user');
  });

  it('reports shear honestly when the fit is a general affine', () => {
    // A deliberately non-conformal matrix: x stretched 1.5x, y left alone.
    const sheared = describeGeoreference({ a: 1.5, b: 0.2, c: 0, d: 0, e: 1, f: 0 });
    expect(sheared.preservesShape).toBe(false);
    expect(sheared.shearPpm).toBeGreaterThan(1);

    const clean = describeGeoreference({ a: 0.6, b: -0.8, c: 412000, d: 0.8, e: 0.6, f: 2591300 });
    expect(clean.preservesShape).toBe(true);
    expect(clean.scaleX).toBeCloseTo(1, 9);
  });
});
