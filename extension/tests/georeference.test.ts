/**
 * Placing a scanned sheet (phase G).
 *
 * Two things make this module dangerous, and both have a section of tests:
 *
 *   1. AN AFFINE THROUGH THREE GCPs FITS PERFECTLY AND CAN BE WRONG EVERYWHERE
 *      BETWEEN THEM. Three points and six parameters is exactly determined, so
 *      the residuals are zero by arithmetic rather than by accuracy. A user
 *      shown "RMS 0.000 m" concludes the georeference is excellent. The module
 *      must report `exactlyDetermined` and say what it means.
 *
 *   2. TWO POINTS AND A DISTANCE FIX SCALE AND ROTATION, NOT POSITION. A
 *      scanned sheet looks authoritative; one placed by this route knows
 *      nothing about where on Earth it is, and a coordinate read off it is
 *      meaningless. `georeferenced: false` is the most important field here.
 *
 * The transforms are checked by round-tripping known points rather than by
 * comparing coefficients, because a coefficient array copied from a run tests
 * that the code still does whatever it did.
 */

import { describe, expect, it } from 'vitest';
import {
  affineScale,
  applyAffine,
  describeFit,
  fitGcps,
  fitTwoPointScale,
  type Gcp,
  IDENTITY_AFFINE,
  invertAffine,
} from '@core/georeference';

/** A sheet scanned at 200 units per pixel, 1000x800, placed in UTM 45N. */
function scaledGcps(scale = 2, originX = 412000, originY = 2591000): Gcp[] {
  return [
    { pixel: { u: 0, v: 0 }, ground: [originX, originY], name: 'NW' },
    { pixel: { u: 1000, v: 0 }, ground: [originX + 1000 * scale, originY], name: 'NE' },
    { pixel: { u: 1000, v: 800 }, ground: [originX + 1000 * scale, originY - 800 * scale], name: 'SE' },
    { pixel: { u: 0, v: 800 }, ground: [originX, originY - 800 * scale], name: 'SW' },
  ];
}

describe('the affine itself', () => {
  it('is the identity when it should be', () => {
    expect(applyAffine(IDENTITY_AFFINE, 3, 7)).toEqual([3, 7]);
  });

  it('inverts exactly', () => {
    const affine = { a: 2, b: 0.3, c: 412000, d: -0.1, e: -2, f: 2591000 };
    const inverse = invertAffine(affine)!;
    for (const [u, v] of [[0, 0], [1000, 800], [317, 42]]) {
      const [x, y] = applyAffine(affine, u, v);
      const [backU, backV] = applyAffine(inverse, x, y);
      expect(backU).toBeCloseTo(u, 6);
      expect(backV).toBeCloseTo(v, 6);
    }
  });

  it('refuses to invert a collapsed transform rather than returning infinities', () => {
    // A determinant of zero maps the image onto a line. An Infinity-filled
    // inverse propagates into the draw matrix and blanks the whole canvas,
    // which reads as the tool crashing rather than as a bad georeference.
    expect(invertAffine({ a: 1, b: 2, c: 0, d: 2, e: 4, f: 0 })).toBeNull();
  });

  it('reads back its scale and rotation', () => {
    const scale = affineScale({ a: 2, b: 0, c: 0, d: 0, e: -2, f: 0 });
    expect(scale.x).toBeCloseTo(2, 9);
    expect(scale.y).toBeCloseTo(2, 9);
    expect(scale.rotationDegrees).toBeCloseTo(0, 9);
  });
});

describe('fitting ground control points', () => {
  it('recovers a known scale and origin exactly', () => {
    const { fit } = fitGcps(scaledGcps(2));
    expect(fit).toBeDefined();
    // Every GCP must come back where it was put.
    for (const gcp of scaledGcps(2)) {
      const [x, y] = applyAffine(fit!.affine, gcp.pixel.u, gcp.pixel.v);
      expect(x).toBeCloseTo(gcp.ground[0], 6);
      expect(y).toBeCloseTo(gcp.ground[1], 6);
    }
  });

  it('interpolates the middle of the sheet correctly', () => {
    // The property that actually matters: the corners are where you put them
    // whatever the fit does, and the middle is what a bad transform gets wrong.
    const { fit } = fitGcps(scaledGcps(2));
    const [x, y] = applyAffine(fit!.affine, 500, 400);
    expect(x).toBeCloseTo(412000 + 1000, 6);
    expect(y).toBeCloseTo(2591000 - 800, 6);
  });

  it('reports residuals per named point', () => {
    const { fit } = fitGcps(scaledGcps(2));
    expect(fit!.residuals.map((entry) => entry.name)).toEqual(['NW', 'NE', 'SE', 'SW']);
  });

  it('flags an exactly-determined fit, so a zero RMS is not read as accuracy', () => {
    // Three points, six parameters. The residuals are zero by arithmetic.
    const three = scaledGcps(2).slice(0, 3);
    const { fit } = fitGcps(three);
    expect(fit!.exactlyDetermined).toBe(true);
    expect(fit!.rms).toBeCloseTo(0, 9);
    expect(fit!.notes.join(' ')).toContain('arithmetic rather than accuracy');
    expect(describeFit(fit!)).toContain('cannot tell you anything');
  });

  it('does NOT flag four points, where a zero RMS means something', () => {
    const { fit } = fitGcps(scaledGcps(2));
    expect(fit!.exactlyDetermined).toBe(false);
    expect(describeFit(fit!)).toContain('RMS');
  });

  it('surfaces a misplaced GCP as a large residual on that point', () => {
    // The whole reason a fourth point is worth asking for.
    const gcps = scaledGcps(2);
    gcps[3] = { ...gcps[3], ground: [gcps[3].ground[0] + 50, gcps[3].ground[1] - 50] };
    const { fit } = fitGcps(gcps);
    expect(fit!.worst).toBeGreaterThan(10);
    // And it is the moved point that carries it, not spread evenly over four.
    const worstPoint = fit!.residuals.reduce((a, b) => (a.residual > b.residual ? a : b));
    expect(worstPoint.name).toBe('SW');
  });

  it('fits a similarity from exactly two points, and says it is one', () => {
    const two = scaledGcps(2).slice(0, 2);
    const { fit } = fitGcps(two);
    expect(fit!.kind).toBe('similarity');
    expect(fit!.exactlyDetermined).toBe(true);
    expect(fit!.notes.join(' ')).toContain('no shear');
    for (const gcp of two) {
      const [x, y] = applyAffine(fit!.affine, gcp.pixel.u, gcp.pixel.v);
      expect(x).toBeCloseTo(gcp.ground[0], 6);
      expect(y).toBeCloseTo(gcp.ground[1], 6);
    }
  });

  it('rotates a two-point fit without mirroring it', () => {
    // A mirrored scan of a symmetric sheet looks completely normal, so this is
    // worth stating precisely rather than by picking a corner and hoping.
    //
    // A SIMILARITY applies one rotation and one scale to everything. So its
    // invariant is: every image vector comes out the same factor longer, and
    // the SIGNED angle between any two image vectors is preserved. A mirror
    // would preserve the magnitude of that angle and flip its sign, which is
    // exactly the failure this catches.
    const rotated: Gcp[] = [
      { pixel: { u: 0, v: 0 }, ground: [0, 0] },
      { pixel: { u: 100, v: 0 }, ground: [0, 100] },
    ];
    const { fit } = fitGcps(rotated);
    const origin = applyAffine(fit!.affine, 0, 0);
    const alongU = applyAffine(fit!.affine, 100, 0);
    const alongV = applyAffine(fit!.affine, 0, 100);

    const u = [alongU[0] - origin[0], alongU[1] - origin[1]];
    const v = [alongV[0] - origin[0], alongV[1] - origin[1]];

    // Equal scale on both axes, and they stay perpendicular.
    expect(Math.hypot(...u)).toBeCloseTo(100, 6);
    expect(Math.hypot(...v)).toBeCloseTo(100, 6);
    expect(u[0] * v[0] + u[1] * v[1]).toBeCloseTo(0, 6);

    // Handedness preserved: the cross product of the image axes is positive
    // (u=(100,0), v=(0,100) gives +10,000), so the ground one must be too.
    expect(u[0] * v[1] - u[1] * v[0]).toBeGreaterThan(0);
  });

  it('lets a GCP fit flip the image rows, which is not a mirror', () => {
    // A north-up scan has v growing downward while northing grows upward, so
    // its fitted affine has a NEGATIVE determinant — and that is correct, not
    // a mirror. Asserting "determinant > 0" everywhere would be wrong here,
    // which is why the similarity test above states its invariant directly.
    const { fit } = fitGcps(scaledGcps(2));
    const { a, b, d, e } = fit!.affine;
    expect(a * e - b * d).toBeLessThan(0);
  });

  it('refuses fewer than two points, and says what each count buys', () => {
    const { refusal } = fitGcps([{ pixel: { u: 0, v: 0 }, ground: [0, 0] }]);
    expect(refusal).toBeDefined();
    expect(refusal!.why).toContain('says nothing about scale or rotation');
  });

  it('refuses collinear points rather than fitting a line', () => {
    const collinear: Gcp[] = [
      { pixel: { u: 0, v: 0 }, ground: [0, 0] },
      { pixel: { u: 10, v: 0 }, ground: [10, 0] },
      { pixel: { u: 20, v: 0 }, ground: [20, 0] },
    ];
    const { refusal } = fitGcps(collinear);
    expect(refusal).toBeDefined();
    expect(refusal!.why).toContain('collinear');
  });

  it('refuses two coincident points, naming which side is degenerate', () => {
    const samePixel: Gcp[] = [
      { pixel: { u: 5, v: 5 }, ground: [0, 0] },
      { pixel: { u: 5, v: 5 }, ground: [100, 0] },
    ];
    expect(fitGcps(samePixel).refusal!.why).toContain('same pixel');

    const sameGround: Gcp[] = [
      { pixel: { u: 0, v: 0 }, ground: [7, 7] },
      { pixel: { u: 100, v: 0 }, ground: [7, 7] },
    ];
    expect(fitGcps(sameGround).refusal!.why).toContain('same ground coordinate');
  });

  it('notices a differential scale, which is what a scanner does to paper', () => {
    const stretched: Gcp[] = [
      { pixel: { u: 0, v: 0 }, ground: [0, 0] },
      { pixel: { u: 1000, v: 0 }, ground: [2000, 0] },
      { pixel: { u: 1000, v: 800 }, ground: [2000, -1680] },
      { pixel: { u: 0, v: 800 }, ground: [0, -1680] },
    ];
    const { fit } = fitGcps(stretched);
    expect(fit!.notes.join(' ')).toContain('differ in scale');
  });
});

describe('two points and a distance', () => {
  it('scales the image to the distance given', () => {
    const { fit } = fitTwoPointScale({ u: 0, v: 0 }, { u: 100, v: 0 }, 250);
    expect(fit!.unitsPerPixel).toBeCloseTo(2.5, 9);
    const [x] = applyAffine(fit!.affine, 100, 0);
    expect(x).toBeCloseTo(250, 6);
  });

  it('is NOT georeferenced, and says so unmissably', () => {
    // The most important assertion in this file. A backdrop placed this way is
    // a tracing aid; a coordinate read off it means nothing.
    const { fit } = fitTwoPointScale({ u: 0, v: 0 }, { u: 100, v: 0 }, 250);
    expect(fit!.georeferenced).toBe(false);
    expect(fit!.notes.join(' ')).toContain('NOT georeferenced');
    expect(describeFit(fit!)).toContain('not georeferenced');
  });

  it('places the first picked point at the anchor', () => {
    const { fit } = fitTwoPointScale({ u: 40, v: 60 }, { u: 140, v: 60 }, 100, [500, 900]);
    const [x, y] = applyAffine(fit!.affine, 40, 60);
    expect(x).toBeCloseTo(500, 6);
    expect(y).toBeCloseTo(900, 6);
  });

  it('flips the v axis, because image rows grow downward and northing grows up', () => {
    // Getting this wrong mirrors the sheet vertically, which on a plan with no
    // text is very hard to see and completely wrong.
    const { fit } = fitTwoPointScale({ u: 0, v: 0 }, { u: 100, v: 0 }, 100, [0, 0]);
    const [, yBelow] = applyAffine(fit!.affine, 0, 50);
    expect(yBelow).toBeLessThan(0);
  });

  it('honours a stated bearing', () => {
    // The picked line laid due north: 0° bearing means the second point is
    // north of the first.
    const { fit } = fitTwoPointScale({ u: 0, v: 0 }, { u: 100, v: 0 }, 100, [0, 0], { bearingDegrees: 0 });
    const [x, y] = applyAffine(fit!.affine, 100, 0);
    expect(x).toBeCloseTo(100, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it('keeps the scale exactly whatever the rotation', () => {
    for (const bearing of [0, 37, 90, 180, 271]) {
      const { fit } = fitTwoPointScale({ u: 0, v: 0 }, { u: 80, v: 60 }, 500, [0, 0], { bearingDegrees: bearing });
      const [x, y] = applyAffine(fit!.affine, 80, 60);
      expect(Math.hypot(x, y)).toBeCloseTo(500, 6);
    }
  });

  it('refuses two points on the same pixel', () => {
    const { refusal } = fitTwoPointScale({ u: 5, v: 5 }, { u: 5, v: 5 }, 100);
    expect(refusal!.what).toContain('same pixel');
  });

  it('refuses a distance that is not a positive number', () => {
    expect(fitTwoPointScale({ u: 0, v: 0 }, { u: 10, v: 0 }, 0).refusal).toBeDefined();
    expect(fitTwoPointScale({ u: 0, v: 0 }, { u: 10, v: 0 }, -5).refusal).toBeDefined();
    expect(fitTwoPointScale({ u: 0, v: 0 }, { u: 10, v: 0 }, Number.NaN).refusal).toBeDefined();
  });

  it('says it laid the baseline along x when no bearing was given', () => {
    const { fit } = fitTwoPointScale({ u: 0, v: 0 }, { u: 100, v: 0 }, 100);
    expect(fit!.notes.join(' ')).toContain('keeps its own orientation');
  });
});
