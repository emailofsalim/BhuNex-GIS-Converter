/**
 * Datum shifts: the seven-parameter Helmert transformation.
 *
 * WHY THIS MODULE SHIPS WITH AN EMPTY PARAMETER TABLE
 *
 * Until now `planTransform` refused every transform whose datum was outside the
 * WGS 84 family, which made India's own cadastral grids — Kalianpur 1975 and
 * Everest 1830, the sheets this product exists to work with — unusable. The
 * missing piece was never the arithmetic. It was the SEVEN NUMBERS, and those
 * are the part that must not be guessed.
 *
 * A Helmert transformation is only as good as its parameters, and parameters
 * are regional: the published values for an Indian datum differ by tens of
 * metres depending on which adjustment and which region they were derived for,
 * and Survey of India controls the authoritative ones. A wrong set does not
 * fail — it produces coordinates that look entirely reasonable and put a
 * boundary somewhere it is not. On a cadastral plot that is a legal document
 * with the wrong answer on it.
 *
 * So the mechanism is here, complete and tested, and the numbers come from the
 * user: whoever is doing the work holds their department's published
 * parameters, along with the accuracy those parameters are quoted at. Every
 * transform records which set was used and what accuracy was stated, so the
 * output can never be more confident than its input (rule R4).
 *
 * That is a deliberate refusal to be convenient. A bundled table of plausible
 * numbers would make this feature look finished and make the tool dangerous.
 */

import { warn, type Warning } from '../core/cir';
import type { Ellipsoid } from './projection';

const DEG = Math.PI / 180;
/** Arcseconds to radians. Rotations are published in arcseconds, always. */
const ARCSEC = Math.PI / 648000;

export interface GeocentricPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * A seven-parameter Helmert transformation towards WGS 84.
 *
 * Translations in metres, rotations in ARCSECONDS, scale in PARTS PER MILLION —
 * the units every authority publishes them in. Converting on the way in rather
 * than asking the caller for radians is what stops the commonest error with
 * these: a rotation entered in arcseconds and used as radians is out by a
 * factor of 206,265, which relocates the site to another continent, and a scale
 * entered in ppm and used as a ratio makes the Earth a million times too big.
 */
export interface DatumShift {
  /** How this set is identified in the manifest and the warnings. */
  name: string;
  tx: number;
  ty: number;
  tz: number;
  rxArcsec: number;
  ryArcsec: number;
  rzArcsec: number;
  scalePpm: number;
  /**
   * The accuracy the publisher quotes, in metres, or null when unstated.
   *
   * Carried because it is the number that decides whether a result may be used.
   * A ±10 m shift is fine for putting a survey on a basemap and is not fine for
   * a boundary, and the tool must not let the second happen quietly.
   */
  accuracyMetres: number | null;
  /** Where the parameters came from — an authority, a document, a person. */
  source: string;
  /**
   * Rotation sign convention.
   *
   * `position-vector` rotates the POINT; `coordinate-frame` rotates the AXES.
   * They differ only in the sign of the three rotations, which is exactly why
   * the mistake is so easy and so hard to see: a wrong convention displaces a
   * point by a few metres, which looks like ordinary datum noise rather than a
   * blunder. EPSG names them methods 1033/9606 (position vector) and 1032/9607
   * (coordinate frame), and any published set states which it is.
   */
  convention: 'position-vector' | 'coordinate-frame';
}

/** Geodetic longitude/latitude/height to earth-centred, earth-fixed XYZ. */
export function geodeticToGeocentric(
  lon: number,
  lat: number,
  height: number,
  ellipsoid: Ellipsoid
): GeocentricPoint {
  const f = 1 / ellipsoid.invF;
  const e2 = 2 * f - f * f;
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const sinPhi = Math.sin(phi);
  // The prime vertical radius of curvature. Using the semi-major axis here
  // instead — which looks almost right — is a several-kilometre error.
  const nu = ellipsoid.a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  return {
    x: (nu + height) * Math.cos(phi) * Math.cos(lambda),
    y: (nu + height) * Math.cos(phi) * Math.sin(lambda),
    z: (nu * (1 - e2) + height) * sinPhi,
  };
}

/**
 * Earth-centred XYZ back to geodetic longitude/latitude/height.
 *
 * Iterated rather than closed-form. Bowring's formula is one step and good to a
 * fraction of a millimetre for terrestrial heights, but it degrades near the
 * axis and this loop costs nothing at the volumes involved: the fixed point is
 * reached in three or four passes, and the exit is on convergence rather than
 * on a fixed count, so a hard case takes the iterations it needs.
 */
export function geocentricToGeodetic(
  point: GeocentricPoint,
  ellipsoid: Ellipsoid
): { lon: number; lat: number; height: number } {
  const f = 1 / ellipsoid.invF;
  const e2 = 2 * f - f * f;
  const p = Math.hypot(point.x, point.y);

  // On the polar axis longitude is undefined and p is zero; latitude is ±90 and
  // the height is measured from the pole. Iterating here divides by zero.
  if (p < 1e-9) {
    const b = ellipsoid.a * (1 - f);
    return { lon: 0, lat: point.z >= 0 ? 90 : -90, height: Math.abs(point.z) - b };
  }

  let lat = Math.atan2(point.z, p * (1 - e2));
  let nu = ellipsoid.a;
  for (let i = 0; i < 12; i++) {
    const sinLat = Math.sin(lat);
    nu = ellipsoid.a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const next = Math.atan2(point.z + e2 * nu * sinLat, p);
    if (Math.abs(next - lat) < 1e-14) {
      lat = next;
      break;
    }
    lat = next;
  }

  const sinLat = Math.sin(lat);
  nu = ellipsoid.a / Math.sqrt(1 - e2 * sinLat * sinLat);
  return {
    lon: Math.atan2(point.y, point.x) / DEG,
    lat: lat / DEG,
    height: p / Math.cos(lat) - nu,
  };
}

/**
 * Applies a Helmert shift to a geocentric point.
 *
 * The forward transformation is
 *
 *     X' = T + (1 + s)·R·X
 *
 * with R the small-angle rotation matrix. The inverse is computed as the
 * ALGEBRAIC INVERSE
 *
 *     X = Rᵀ·(X' − T) / (1 + s)
 *
 * and not by negating all seven parameters, which is the usual shortcut. The
 * shortcut is wrong by the products of pairs of parameters, and the dominant
 * pair is translation × scale: with a 700 m translation and 3 ppm of scale that
 * is about 2 mm, and it grows with the size of the shift — so precisely the
 * large, real parameter sets this exists for are the ones it degrades on. The
 * form above leaves only the second-order rotation terms, of order r² times the
 * coordinate, which is well under a tenth of a millimetre.
 */
export function applyHelmert(
  point: GeocentricPoint,
  shift: DatumShift,
  direction: 'forward' | 'inverse' = 'forward'
): GeocentricPoint {
  // The convention decides the sign of the rotations, and nothing else.
  const rotationSign = shift.convention === 'position-vector' ? 1 : -1;
  const rx = shift.rxArcsec * ARCSEC * rotationSign;
  const ry = shift.ryArcsec * ARCSEC * rotationSign;
  const rz = shift.rzArcsec * ARCSEC * rotationSign;
  const scale = 1 + shift.scalePpm * 1e-6;

  if (direction === 'forward') {
    const { x, y, z } = point;
    return {
      x: shift.tx + scale * (x - rz * y + ry * z),
      y: shift.ty + scale * (rz * x + y - rx * z),
      z: shift.tz + scale * (-ry * x + rx * y + z),
    };
  }

  // Undo in the opposite order: translation, then scale, then rotation. R is
  // orthogonal to first order, so its inverse is its transpose — which is the
  // same matrix with the three rotations negated.
  const x = (point.x - shift.tx) / scale;
  const y = (point.y - shift.ty) / scale;
  const z = (point.z - shift.tz) / scale;
  return {
    x: x + rz * y - ry * z,
    y: -rz * x + y + rx * z,
    z: ry * x - rx * y + z,
  };
}

/**
 * Moves a geodetic coordinate from one datum to another through a shift.
 *
 * Height is carried through because a datum shift genuinely changes it: the two
 * ellipsoids sit differently relative to the Earth, so a point keeping the same
 * physical position takes a different ellipsoidal height on each. Dropping it
 * and re-attaching the original would introduce an error of tens of metres in
 * the horizontal as well, through the geocentric conversion.
 */
export function shiftDatum(
  lon: number,
  lat: number,
  height: number,
  from: Ellipsoid,
  to: Ellipsoid,
  shift: DatumShift,
  direction: 'forward' | 'inverse' = 'forward'
): { lon: number; lat: number; height: number } {
  const geocentric = geodeticToGeocentric(lon, lat, height, from);
  const shifted = applyHelmert(geocentric, shift, direction);
  return geocentricToGeodetic(shifted, to);
}

/**
 * The warning that must accompany every shifted coordinate.
 *
 * Not optional and not suppressible. A datum shift is the one operation in this
 * tool whose output looks exactly like its input — same shape, same magnitude,
 * plausible position — while being wrong by however much the parameters are
 * wrong by. The number that decides whether the result may be used is the
 * quoted accuracy, so the quoted accuracy travels with it.
 */
export function datumShiftWarning(shift: DatumShift, fromDatum: string, toDatum: string): Warning {
  const accuracy =
    shift.accuracyMetres === null
      ? 'The accuracy of these parameters was not stated, so the accuracy of this result is unknown.'
      : `These parameters are quoted at ±${shift.accuracyMetres} m, so no position here is better than that.`;

  return warn('DATUM_SHIFTED', `Coordinates were moved from ${fromDatum} to ${toDatum} using "${shift.name}".`, {
    severity: 'warning',
    reason: `A seven-parameter Helmert transformation was applied (${shift.convention} convention), from parameters you supplied: source "${shift.source}". ${accuracy}`,
    action:
      shift.accuracyMetres !== null && shift.accuracyMetres > 1
        ? 'This is enough to place the data on a map and NOT enough for a cadastral boundary or a setting-out coordinate. For those, transform through the grid file your survey authority publishes.'
        : 'Check this against a known control point before the result leaves your desk.',
    detail: {
      name: shift.name,
      convention: shift.convention,
      accuracyMetres: shift.accuracyMetres,
      source: shift.source,
    },
  });
}

/**
 * Whether a user-entered parameter set can be used.
 *
 * The bounds are deliberately wide — real published sets vary enormously — and
 * they exist to catch the two errors that produce a confident wrong answer:
 * arcseconds entered as radians (a rotation of 0.5 radians is 103,000
 * arcseconds, which is not a datum shift, it is a different planet), and a
 * scale entered as a ratio rather than in parts per million.
 */
export function validateShift(shift: Partial<DatumShift>): { ok: boolean; problem?: string } {
  const numbers: [string, number | undefined][] = [
    ['tx', shift.tx],
    ['ty', shift.ty],
    ['tz', shift.tz],
    ['rx', shift.rxArcsec],
    ['ry', shift.ryArcsec],
    ['rz', shift.rzArcsec],
    ['scale', shift.scalePpm],
  ];
  for (const [label, value] of numbers) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, problem: `${label} is missing or not a number. All seven parameters are required; leave a value at 0 if the published set omits it.` };
    }
  }
  for (const [label, value] of numbers.slice(0, 3)) {
    if (Math.abs(value as number) > 10000) {
      return { ok: false, problem: `${label} = ${value} m. A translation larger than 10 km is not a datum shift — check the units.` };
    }
  }
  for (const [label, value] of numbers.slice(3, 6)) {
    if (Math.abs(value as number) > 3600) {
      return {
        ok: false,
        problem: `${label} = ${value}. Rotations are given in ARCSECONDS, and one degree is 3,600 of them. A value this large is almost always radians entered by mistake, which would move the result by thousands of kilometres.`,
      };
    }
  }
  if (Math.abs(shift.scalePpm as number) > 1000) {
    return {
      ok: false,
      problem: `scale = ${shift.scalePpm}. Scale is given in PARTS PER MILLION, so a typical value is under 100. A value this large is usually a ratio entered by mistake.`,
    };
  }
  return { ok: true };
}
