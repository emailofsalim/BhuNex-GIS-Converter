/**
 * Datum shifts.
 *
 * These tests are anchored to properties that can be checked from first
 * principles rather than to published parameter sets, and that is deliberate.
 * A test asserting "Kalianpur 1975 to WGS 84 gives this coordinate" is only as
 * trustworthy as the seven numbers it was written with, and those numbers are
 * exactly what this module refuses to guess. Asserting them from memory would
 * put a fabricated constant behind a green tick, which is worse than having no
 * test at all.
 *
 * What IS checkable without any published set: that a null shift changes
 * nothing, that a shift inverts, that a pure translation moves the geocentric
 * position by exactly that translation, that a scale multiplies the radius,
 * that a rotation moves a point by radius times angle, and that the geodetic
 * conversion agrees with the ellipsoid's own definition at the points where
 * that definition fixes the answer.
 *
 * Every one of those catches a real error — the arcsecond/radian confusion, the
 * ppm/ratio confusion, the semi-major-axis-instead-of-prime-vertical mistake,
 * and a sign flip in the rotation convention.
 */

import { describe, expect, it } from 'vitest';
import {
  applyHelmert,
  datumShiftWarning,
  geocentricToGeodetic,
  geodeticToGeocentric,
  shiftDatum,
  validateShift,
  type DatumShift,
} from '@crs/datum';
import { EVEREST_1830, GRS80, WGS84 } from '@crs/projection';
import { planTransform } from '@crs/transform';
import { crsFromEpsg } from '@crs/epsg';

const NOTHING: DatumShift = {
  name: 'identity',
  tx: 0,
  ty: 0,
  tz: 0,
  rxArcsec: 0,
  ryArcsec: 0,
  rzArcsec: 0,
  scalePpm: 0,
  accuracyMetres: 0,
  source: 'test',
  convention: 'position-vector',
};

describe('geodetic and geocentric coordinates', () => {
  it('puts the equator on the prime meridian at exactly the semi-major axis', () => {
    // Fixed by the definition of the ellipsoid, so it needs no reference value.
    const point = geodeticToGeocentric(0, 0, 0, WGS84);
    expect(point.x).toBeCloseTo(WGS84.a, 6);
    expect(point.y).toBeCloseTo(0, 6);
    expect(point.z).toBeCloseTo(0, 6);
  });

  it('puts the north pole on the semi-minor axis', () => {
    // b = a(1 - f). Getting this right requires the (1 - e²)ν term; using ν
    // alone — which looks almost right — is out by 21 km at the pole.
    const b = WGS84.a * (1 - 1 / WGS84.invF);
    const point = geodeticToGeocentric(0, 90, 0, WGS84);
    expect(point.z).toBeCloseTo(b, 6);
    expect(Math.hypot(point.x, point.y)).toBeCloseTo(0, 6);
  });

  it('puts 90°E on the Y axis', () => {
    const point = geodeticToGeocentric(90, 0, 0, WGS84);
    expect(point.x).toBeCloseTo(0, 6);
    expect(point.y).toBeCloseTo(WGS84.a, 6);
  });

  it('adds ellipsoidal height along the normal at the equator', () => {
    const point = geodeticToGeocentric(0, 0, 1000, WGS84);
    expect(point.x).toBeCloseTo(WGS84.a + 1000, 6);
  });

  it('round-trips to under a micrometre, at every latitude that matters', () => {
    for (const [lon, lat, height] of [
      [0, 0, 0],
      [85.33, 23.36, 412.345],
      [74, 26, 250],
      [-77, 18, 0],
      [139.7, 35.7, -30],
      [-58.4, -34.6, 25],
      [0, 89.9, 0],
    ]) {
      const back = geocentricToGeodetic(geodeticToGeocentric(lon, lat, height, WGS84), WGS84);
      expect(back.lon).toBeCloseTo(lon, 9);
      expect(back.lat).toBeCloseTo(lat, 9);
      expect(back.height).toBeCloseTo(height, 6);
    }
  });

  it('survives a point on the polar axis rather than dividing by zero', () => {
    const b = WGS84.a * (1 - 1 / WGS84.invF);
    const onAxis = geocentricToGeodetic({ x: 0, y: 0, z: b + 500 }, WGS84);
    expect(onAxis.lat).toBe(90);
    expect(onAxis.height).toBeCloseTo(500, 6);
  });

  it('uses the ellipsoid it is given, not a default', () => {
    // Everest 1830 is about 860 m smaller in the semi-major axis than WGS 84.
    // A module quietly assuming WGS 84 would show no difference here.
    const wgs = geodeticToGeocentric(0, 0, 0, WGS84);
    const everest = geodeticToGeocentric(0, 0, 0, EVEREST_1830);
    expect(wgs.x - everest.x).toBeCloseTo(WGS84.a - EVEREST_1830.a, 6);
    expect(wgs.x - everest.x).toBeGreaterThan(800);
  });
});

describe('the Helmert transformation', () => {
  const point = geodeticToGeocentric(85.33, 23.36, 400, WGS84);

  it('changes nothing when every parameter is zero', () => {
    const out = applyHelmert(point, NOTHING);
    expect(out.x).toBeCloseTo(point.x, 9);
    expect(out.y).toBeCloseTo(point.y, 9);
    expect(out.z).toBeCloseTo(point.z, 9);
  });

  it('moves a point by exactly a pure translation', () => {
    const out = applyHelmert(point, { ...NOTHING, tx: 100, ty: -250, tz: 37.5 });
    expect(out.x - point.x).toBeCloseTo(100, 6);
    expect(out.y - point.y).toBeCloseTo(-250, 6);
    expect(out.z - point.z).toBeCloseTo(37.5, 6);
  });

  it('multiplies the radius by a pure scale, in parts per million', () => {
    // 1 ppm of ~6,378 km is about 6.4 m. If ppm were read as a ratio the point
    // would move six thousand kilometres, which is the error this catches.
    const out = applyHelmert(point, { ...NOTHING, scalePpm: 1 });
    const before = Math.hypot(point.x, point.y, point.z);
    const after = Math.hypot(out.x, out.y, out.z);
    expect(after / before).toBeCloseTo(1 + 1e-6, 12);
    expect(after - before).toBeGreaterThan(6);
    expect(after - before).toBeLessThan(7);
  });

  it('treats rotations as arcseconds, not radians', () => {
    // One arcsecond at the Earth's radius is about 31 m. One RADIAN would be
    // 6,378 km — the difference between a datum shift and a different planet.
    const equator = geodeticToGeocentric(0, 0, 0, WGS84);
    const out = applyHelmert(equator, { ...NOTHING, rzArcsec: 1 });
    const moved = Math.hypot(out.x - equator.x, out.y - equator.y, out.z - equator.z);
    expect(moved).toBeGreaterThan(30);
    expect(moved).toBeLessThan(32);
  });

  it('rotates about the axis named, and no other', () => {
    // A rotation about Z moves a point in X and Y and leaves Z alone. Getting
    // the matrix rows crossed shows up here and nowhere else.
    const out = applyHelmert(point, { ...NOTHING, rzArcsec: 10 });
    expect(out.z - point.z).toBeCloseTo(0, 6);
    expect(Math.abs(out.x - point.x) + Math.abs(out.y - point.y)).toBeGreaterThan(1);
  });

  it('inverts back to where it started', () => {
    const shift: DatumShift = {
      ...NOTHING,
      tx: 295,
      ty: 736,
      tz: 257,
      rxArcsec: 0.5,
      ryArcsec: -1.2,
      rzArcsec: 0.9,
      scalePpm: 3.4,
    };
    const there = applyHelmert(point, shift, 'forward');
    const back = applyHelmert(there, shift, 'inverse');
    // Under a tenth of a millimetre, and the figure is predictable rather than
    // empirical: the inverse is algebraic — undo the translation, then the
    // scale, then the rotation — so the only residual is the second-order
    // rotation term, of order r² times the coordinate. With ~1 arcsecond
    // rotations that is (4.85e-6)² × 6.4e6 ≈ 1.5e-4 m, and 8e-5 m is measured.
    //
    // Negating all seven parameters instead — the usual shortcut — would leave
    // the translation × scale product, about 2 mm here and growing with the
    // size of the shift, so it degrades on exactly the large real parameter
    // sets this module exists for.
    expect(back.x).toBeCloseTo(point.x, 3);
    expect(back.y).toBeCloseTo(point.y, 3);
    expect(back.z).toBeCloseTo(point.z, 3);
  });

  it('distinguishes the two rotation conventions by the sign of the rotations', () => {
    // The mistake worth catching: the two differ by a few metres, which reads
    // as ordinary datum noise rather than as a blunder.
    const positionVector = applyHelmert(point, { ...NOTHING, rxArcsec: 1, ryArcsec: 1, rzArcsec: 1 });
    const coordinateFrame = applyHelmert(point, {
      ...NOTHING,
      rxArcsec: 1,
      ryArcsec: 1,
      rzArcsec: 1,
      convention: 'coordinate-frame',
    });
    const apart = Math.hypot(
      positionVector.x - coordinateFrame.x,
      positionVector.y - coordinateFrame.y,
      positionVector.z - coordinateFrame.z
    );
    expect(apart).toBeGreaterThan(10);
    // And they are exact mirror images about the unrotated point.
    expect((positionVector.x + coordinateFrame.x) / 2).toBeCloseTo(point.x, 6);
  });

  it('leaves a translation unaffected by the convention', () => {
    const a = applyHelmert(point, { ...NOTHING, tx: 100 });
    const b = applyHelmert(point, { ...NOTHING, tx: 100, convention: 'coordinate-frame' });
    expect(a.x).toBeCloseTo(b.x, 9);
  });
});

describe('shifting a geodetic coordinate between datums', () => {
  it('returns the same position when the shift and the ellipsoid are unchanged', () => {
    const out = shiftDatum(85.33, 23.36, 400, WGS84, WGS84, NOTHING);
    expect(out.lon).toBeCloseTo(85.33, 9);
    expect(out.lat).toBeCloseTo(23.36, 9);
    expect(out.height).toBeCloseTo(400, 6);
  });

  it('changes the height when only the ellipsoid changes', () => {
    // The same physical point takes a different ellipsoidal height on a
    // different ellipsoid. A version that carried the input height through
    // unchanged would look right and be wrong by hundreds of metres.
    const out = shiftDatum(85.33, 23.36, 400, EVEREST_1830, WGS84, NOTHING);
    expect(Math.abs(out.height - 400)).toBeGreaterThan(50);
  });

  it('round-trips through a real-sized shift to under a millimetre', () => {
    const shift: DatumShift = { ...NOTHING, tx: 295, ty: 736, tz: 257, scalePpm: 2.1, rzArcsec: 0.4 };
    const there = shiftDatum(85.33, 23.36, 400, EVEREST_1830, WGS84, shift, 'forward');
    const back = shiftDatum(there.lon, there.lat, there.height, WGS84, EVEREST_1830, shift, 'inverse');
    // Sub-millimetre in all three, which is the same r² residual seen through
    // the geodetic conversion.
    expect(back.lon).toBeCloseTo(85.33, 9);
    expect(back.lat).toBeCloseTo(23.36, 9);
    expect(back.height).toBeCloseTo(400, 3);
  });

  it('moves a point by roughly the size of the translation', () => {
    // A sanity bound rather than a reference value: a few hundred metres of
    // translation must move the ground position by a few hundred metres.
    const out = shiftDatum(85.33, 23.36, 0, WGS84, WGS84, { ...NOTHING, tx: 200, ty: 200, tz: 200 });
    const metresPerDegreeLat = 111132;
    const moved = Math.hypot(
      (out.lat - 23.36) * metresPerDegreeLat,
      (out.lon - 85.33) * metresPerDegreeLat * Math.cos(23.36 * (Math.PI / 180))
    );
    expect(moved).toBeGreaterThan(50);
    expect(moved).toBeLessThan(400);
  });
});

describe('the warning that travels with every shift', () => {
  it('states the accuracy the parameters were quoted at', () => {
    const warning = datumShiftWarning({ ...NOTHING, accuracyMetres: 12, source: 'Survey of India' }, 'Kalianpur 1975', 'WGS 84');
    expect(warning.reason).toContain('±12 m');
    expect(warning.reason).toContain('Survey of India');
    expect(warning.severity).toBe('warning');
  });

  it('says plainly when the accuracy is unknown', () => {
    const warning = datumShiftWarning({ ...NOTHING, accuracyMetres: null }, 'A', 'B');
    expect(warning.reason).toContain('accuracy of this result is unknown');
  });

  it('tells the user a metre-level shift is not a cadastral answer', () => {
    // The whole point of carrying the accuracy: a result good enough for a
    // basemap is not good enough for a boundary, and the tool says which.
    const warning = datumShiftWarning({ ...NOTHING, accuracyMetres: 15 }, 'A', 'B');
    expect(warning.action).toContain('NOT enough for a cadastral boundary');
  });

  it('names the convention, because the two differ by metres', () => {
    expect(datumShiftWarning({ ...NOTHING, convention: 'coordinate-frame' }, 'A', 'B').reason).toContain('coordinate-frame');
  });
});

describe('what a user-entered parameter set must not be', () => {
  const good = { tx: 295, ty: 736, tz: 257, rxArcsec: 0.5, ryArcsec: 1.2, rzArcsec: -0.9, scalePpm: 3.4 };

  it('accepts a plausible published set', () => {
    expect(validateShift(good).ok).toBe(true);
  });

  it('accepts a three-parameter set entered with zeros', () => {
    // Molodensky sets publish only translations, and requiring all seven with
    // zeros is clearer than guessing which the user meant to omit.
    expect(validateShift({ ...good, rxArcsec: 0, ryArcsec: 0, rzArcsec: 0, scalePpm: 0 }).ok).toBe(true);
  });

  it('refuses a missing parameter rather than defaulting it', () => {
    const result = validateShift({ ...good, tz: undefined });
    expect(result.ok).toBe(false);
    expect(result.problem).toContain('tz');
  });

  it('catches rotations entered in radians', () => {
    // 0.5 radians is 103,000 arcseconds. This is the error that moves a site
    // to another continent while looking like a perfectly ordinary number.
    const result = validateShift({ ...good, rxArcsec: 0.5e6 });
    expect(result.ok).toBe(false);
    expect(result.problem).toContain('ARCSECONDS');
  });

  it('catches a scale entered as a ratio', () => {
    const result = validateShift({ ...good, scalePpm: 1.0000034e6 });
    expect(result.ok).toBe(false);
    expect(result.problem).toContain('PARTS PER MILLION');
  });

  it('catches a translation that is not a datum shift', () => {
    const result = validateShift({ ...good, tx: 6378137 });
    expect(result.ok).toBe(false);
    expect(result.problem).toContain('not a datum shift');
  });

  it('allows a large but real translation', () => {
    // Some published sets reach several hundred metres; the bound is there to
    // catch a unit error, not to second-guess a geodesist.
    expect(validateShift({ ...good, tx: -900, ty: 850, tz: -300 }).ok).toBe(true);
  });
});

describe('the ellipsoids this has to work across', () => {
  it('handles the three the bundled CRS table uses', () => {
    for (const ellipsoid of [WGS84, GRS80, EVEREST_1830]) {
      const back = geocentricToGeodetic(geodeticToGeocentric(74, 26, 300, ellipsoid), ellipsoid);
      expect(back.lon).toBeCloseTo(74, 9);
      expect(back.lat).toBeCloseTo(26, 9);
      expect(back.height).toBeCloseTo(300, 6);
    }
  });
});

describe('the transform layer: a datum that used to be refused', () => {
  it('still refuses without parameters, and says where to get them', () => {
    // India's zones are on Kalianpur 1975 / Everest 1830. Refusing remains the
    // default, because the alternative to "no answer" here is not "an answer",
    // it is "a confident wrong answer".
    let message = { why: '', action: '' };
    try {
      planTransform(crsFromEpsg(24379), crsFromEpsg(4326));
    } catch (error) {
      message = error as { why: string; action: string };
    }
    expect(message.why).toContain('no Helmert parameters for it are bundled');
    expect(message.action).toContain('your survey authority publishes');
  });

  it('converts once the parameters are supplied', () => {
    // The capability that was missing. The numbers here are illustrative — the
    // point is that a supplied set is USED, not that this set is correct for
    // Kalianpur, which only Survey of India can say.
    const shift: DatumShift = {
      ...NOTHING,
      name: 'illustrative',
      tx: 295,
      ty: 736,
      tz: 257,
      accuracyMetres: 15,
      source: 'test fixture, not an authority',
    };
    const plan = planTransform(crsFromEpsg(24379), crsFromEpsg(4326), shift);
    expect(plan.identity).toBe(false);

    // The false origin of India zone IIa is 26°N, 74°E on its own datum, so it
    // must land near there — displaced by the shift, not by a zone error.
    const [lon, lat] = plan.transform([2743195.5, 914398.8]);
    expect(lon).toBeGreaterThan(73);
    expect(lon).toBeLessThan(75);
    expect(lat).toBeGreaterThan(25);
    expect(lat).toBeLessThan(27);
  });

  it('carries the accuracy warning into the plan, every time', () => {
    const shift: DatumShift = { ...NOTHING, tx: 295, accuracyMetres: 15, source: 'test fixture' };
    const plan = planTransform(crsFromEpsg(24379), crsFromEpsg(4326), shift);
    const warning = plan.warnings.find((entry) => entry.code === 'DATUM_SHIFTED');
    expect(warning).toBeDefined();
    expect(warning?.reason).toContain('±15 m');
  });

  it('ignores a shift where none is needed', () => {
    // Both sides on WGS 84: supplying parameters must not apply them, or a
    // UTM-to-UTM conversion would move by 295 m because a field was filled in.
    const shift: DatumShift = { ...NOTHING, tx: 295, source: 'test fixture' };
    const plan = planTransform(crsFromEpsg(32645), crsFromEpsg(4326), shift);
    expect(plan.warnings.find((entry) => entry.code === 'DATUM_SHIFTED')).toBeUndefined();
    // Zone 45N's central meridian is 87°E, and an easting of 412,345 is
    // 87.7 km west of the 500,000 false easting — about 0.86° — so 86.1°E is
    // the right answer, not the 85.3° a quick guess suggests.
    const [lon] = plan.transform([412345.678, 2591234.567]);
    expect(lon).toBeGreaterThan(86);
    expect(lon).toBeLessThan(86.3);
  });

  it('uses the Z it is given rather than assuming sea level', () => {
    const shift: DatumShift = { ...NOTHING, tx: 295, ty: 736, tz: 257, source: 'test fixture' };
    const plan = planTransform(crsFromEpsg(24379), crsFromEpsg(4326), shift);
    const atSeaLevel = plan.transform([2743195.5, 914398.8, 0]);
    const onAPlateau = plan.transform([2743195.5, 914398.8, 2000]);
    // A 2 km height difference changes the horizontal result, slightly. If the
    // height were being discarded these would be identical.
    expect(atSeaLevel[0]).not.toBe(onAPlateau[0]);
    // And Z passes through untouched: a horizontal shift states nothing about
    // orthometric height.
    expect(onAPlateau[2]).toBe(2000);
  });
});
