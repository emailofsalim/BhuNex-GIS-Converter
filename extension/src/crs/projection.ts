/**
 * Projection maths.
 *
 * Transverse Mercator by the classical series (Snyder, Map Projections — A
 * Working Manual, USGS PP 1395, §8), which holds sub-millimetre accuracy within
 * the ±3° half-width of a UTM zone. That is the accuracy survey work needs, and
 * the round-trip is enforced by tests rather than asserted here.
 *
 * The series is a truncation, so accuracy degrades outside the zone: at roughly
 * 10° from the central meridian the error reaches metres. Data that far outside
 * its own zone is misfiled rather than merely wide, so the engine does not
 * silently extend the series to cover it.
 *
 * All angles cross this module's boundary in degrees; radians only exist inside.
 */

export interface Ellipsoid {
  name: string;
  /** Semi-major axis, metres. */
  a: number;
  /** Inverse flattening. */
  invF: number;
}

export const WGS84: Ellipsoid = { name: 'WGS 84', a: 6378137.0, invF: 298.257223563 };
export const GRS80: Ellipsoid = { name: 'GRS 1980', a: 6378137.0, invF: 298.257222101 };
/** Everest 1830 (1937 adjustment) — the basis of Indian legacy grids. */
export const EVEREST_1830: Ellipsoid = { name: 'Everest 1830 (1937 Adjustment)', a: 6377276.345, invF: 300.8017 };

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface TransverseMercatorParams {
  ellipsoid: Ellipsoid;
  /** Central meridian, degrees. */
  lon0: number;
  /** Latitude of origin, degrees. */
  lat0: number;
  /** Scale factor on the central meridian. */
  k0: number;
  falseEasting: number;
  falseNorthing: number;
}

interface EllipsoidConstants {
  a: number;
  e2: number;
  ep2: number;
  e1: number;
  /** Meridional arc coefficients. */
  m: [number, number, number, number];
}

const constantsCache = new WeakMap<Ellipsoid, EllipsoidConstants>();

function constantsFor(ellipsoid: Ellipsoid): EllipsoidConstants {
  const cached = constantsCache.get(ellipsoid);
  if (cached) return cached;
  const f = 1 / ellipsoid.invF;
  const e2 = 2 * f - f * f;
  const value: EllipsoidConstants = {
    a: ellipsoid.a,
    e2,
    ep2: e2 / (1 - e2),
    e1: (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2)),
    m: [
      1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256,
      (3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024,
      (15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024,
      (35 * e2 * e2 * e2) / 3072,
    ],
  };
  constantsCache.set(ellipsoid, value);
  return value;
}

/** Meridional arc distance from the equator to latitude phi (radians). */
function meridionalArc(constants: EllipsoidConstants, phi: number): number {
  const [m0, m1, m2, m3] = constants.m;
  return constants.a * (m0 * phi - m1 * Math.sin(2 * phi) + m2 * Math.sin(4 * phi) - m3 * Math.sin(6 * phi));
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

export interface GeographicPoint {
  lon: number;
  lat: number;
}

export function forwardTransverseMercator(point: GeographicPoint, params: TransverseMercatorParams): ProjectedPoint {
  const constants = constantsFor(params.ellipsoid);
  const phi = point.lat * DEG;
  const lambda = point.lon * DEG;
  const lambda0 = params.lon0 * DEG;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);

  const nu = constants.a / Math.sqrt(1 - constants.e2 * sinPhi * sinPhi);
  const t = tanPhi * tanPhi;
  const c = constants.ep2 * cosPhi * cosPhi;
  // Normalise the meridian difference into (-180°, 180°] so a point east of the
  // antimeridian does not project a full circumference away.
  let dLambda = lambda - lambda0;
  while (dLambda > Math.PI) dLambda -= 2 * Math.PI;
  while (dLambda < -Math.PI) dLambda += 2 * Math.PI;
  const a1 = dLambda * cosPhi;
  const a2 = a1 * a1;

  const m = meridionalArc(constants, phi);
  const m0 = meridionalArc(constants, params.lat0 * DEG);

  const x =
    params.falseEasting +
    params.k0 *
      nu *
      (a1 + ((1 - t + c) * a1 * a2) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * constants.ep2) * a1 * a2 * a2) / 120);

  const y =
    params.falseNorthing +
    params.k0 *
      (m -
        m0 +
        nu *
          tanPhi *
          (a2 / 2 +
            ((5 - t + 9 * c + 4 * c * c) * a2 * a2) / 24 +
            ((61 - 58 * t + t * t + 600 * c - 330 * constants.ep2) * a2 * a2 * a2) / 720));

  return { x, y };
}

export function inverseTransverseMercator(point: ProjectedPoint, params: TransverseMercatorParams): GeographicPoint {
  const constants = constantsFor(params.ellipsoid);
  const x = point.x - params.falseEasting;
  const y = point.y - params.falseNorthing;

  const m0 = meridionalArc(constants, params.lat0 * DEG);
  const m = m0 + y / params.k0;
  const mu = m / (constants.a * constants.m[0]);
  const e1 = constants.e1;

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  // At the pole cosPhi1 is zero and the longitude series divides by it; the
  // latitude is simply phi1 there.
  if (Math.abs(cosPhi1) < 1e-12) return { lon: params.lon0, lat: phi1 * RAD };

  const c1 = constants.ep2 * cosPhi1 * cosPhi1;
  const t1 = tanPhi1 * tanPhi1;
  const n1 = constants.a / Math.sqrt(1 - constants.e2 * sinPhi1 * sinPhi1);
  const r1 = (constants.a * (1 - constants.e2)) / (1 - constants.e2 * sinPhi1 * sinPhi1) ** 1.5;
  const d = x / (n1 * params.k0);
  const d2 = d * d;

  const lat =
    phi1 -
    ((n1 * tanPhi1) / r1) *
      (d2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * constants.ep2) * d2 * d2) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * constants.ep2 - 3 * c1 * c1) * d2 * d2 * d2) / 720);

  const lon =
    params.lon0 * DEG +
    (d -
      ((1 + 2 * t1 + c1) * d * d2) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * constants.ep2 + 24 * t1 * t1) * d * d2 * d2) / 120) /
      cosPhi1;

  return { lon: lon * RAD, lat: lat * RAD };
}

// ---------------------------------------------------------------------------- UTM

export const UTM_K0 = 0.9996;
export const UTM_FALSE_EASTING = 500000;
export const UTM_FALSE_NORTHING_SOUTH = 10000000;

export function utmCentralMeridian(zone: number): number {
  return (zone - 1) * 6 - 180 + 3;
}

export function utmParams(zone: number, south: boolean, ellipsoid: Ellipsoid = WGS84): TransverseMercatorParams {
  return {
    ellipsoid,
    lon0: utmCentralMeridian(zone),
    lat0: 0,
    k0: UTM_K0,
    falseEasting: UTM_FALSE_EASTING,
    falseNorthing: south ? UTM_FALSE_NORTHING_SOUTH : 0,
  };
}

/** Zone containing a longitude, ignoring the Norway/Svalbard exceptions. */
export function utmZoneForLongitude(lon: number): number {
  const normalised = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Math.min(60, Math.max(1, Math.floor((normalised + 180) / 6) + 1));
}

export function geographicToUtm(point: GeographicPoint, zone: number, south: boolean, ellipsoid: Ellipsoid = WGS84): ProjectedPoint {
  return forwardTransverseMercator(point, utmParams(zone, south, ellipsoid));
}

export function utmToGeographic(point: ProjectedPoint, zone: number, south: boolean, ellipsoid: Ellipsoid = WGS84): GeographicPoint {
  return inverseTransverseMercator(point, utmParams(zone, south, ellipsoid));
}

// -------------------------------------------------------------------- Web Mercator

const WEB_MERCATOR_R = 6378137.0;
/** EPSG:3857 clips at ±85.051129°, where the projection reaches ±20048966.10 m. */
export const WEB_MERCATOR_MAX_LAT = 85.05112877980659;

export function geographicToWebMercator(point: GeographicPoint): ProjectedPoint {
  const lat = Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, point.lat));
  return {
    x: WEB_MERCATOR_R * point.lon * DEG,
    y: WEB_MERCATOR_R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)),
  };
}

export function webMercatorToGeographic(point: ProjectedPoint): GeographicPoint {
  return {
    lon: (point.x / WEB_MERCATOR_R) * RAD,
    lat: (2 * Math.atan(Math.exp(point.y / WEB_MERCATOR_R)) - Math.PI / 2) * RAD,
  };
}

// ------------------------------------------------------------ Lambert Conformal Conic

export interface LambertConformalConicParams {
  ellipsoid: Ellipsoid;
  lat1: number;
  lat2: number;
  lat0: number;
  lon0: number;
  falseEasting: number;
  falseNorthing: number;
}

interface LccConstants {
  n: number;
  F: number;
  rho0: number;
  e: number;
  a: number;
}

function lccConstants(params: LambertConformalConicParams): LccConstants {
  const f = 1 / params.ellipsoid.invF;
  const e2 = 2 * f - f * f;
  const e = Math.sqrt(e2);
  const a = params.ellipsoid.a;
  const phi1 = params.lat1 * DEG;
  const phi2 = params.lat2 * DEG;
  const phi0 = params.lat0 * DEG;

  const m = (phi: number) => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = (phi: number) =>
    Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);

  const m1 = m(phi1);
  const t1 = t(phi1);
  // Equal standard parallels collapse to the tangent (1SP) case.
  const n = Math.abs(phi1 - phi2) < 1e-10 ? Math.sin(phi1) : Math.log(m1 / m(phi2)) / Math.log(t1 / t(phi2));
  const F = m1 / (n * t1 ** n);
  return { n, F, rho0: a * F * t(phi0) ** n, e, a };
}

export function forwardLambertConformalConic(point: GeographicPoint, params: LambertConformalConicParams): ProjectedPoint {
  const { n, F, rho0, e, a } = lccConstants(params);
  const phi = point.lat * DEG;
  const t = Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const rho = a * F * t ** n;
  let dLambda = (point.lon - params.lon0) * DEG;
  while (dLambda > Math.PI) dLambda -= 2 * Math.PI;
  while (dLambda < -Math.PI) dLambda += 2 * Math.PI;
  const theta = n * dLambda;
  return {
    x: params.falseEasting + rho * Math.sin(theta),
    y: params.falseNorthing + rho0 - rho * Math.cos(theta),
  };
}

export function inverseLambertConformalConic(point: ProjectedPoint, params: LambertConformalConicParams): GeographicPoint {
  const { n, F, rho0, e, a } = lccConstants(params);
  const x = point.x - params.falseEasting;
  const y = rho0 - (point.y - params.falseNorthing);
  const rho = Math.sign(n) * Math.hypot(x, y);
  const theta = Math.atan2(Math.sign(n) * x, Math.sign(n) * y);
  const t = (rho / (a * F)) ** (1 / n);

  // Iterate the conformal latitude; five rounds settle well below a micrometre.
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 8; i++) {
    const next = Math.PI / 2 - 2 * Math.atan(t * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2));
    if (Math.abs(next - phi) < 1e-12) {
      phi = next;
      break;
    }
    phi = next;
  }
  return { lon: params.lon0 + (theta / n) * RAD, lat: phi * RAD };
}
