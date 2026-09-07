/**
 * Measurement (spec §26.1).
 *
 * Distance, area, perimeter, bearing, azimuth, elevation difference, slope and
 * angle — every one of them CRS-aware.
 *
 * ---------------------------------------------------------------------------
 * THE ERROR THIS MODULE EXISTS TO NOT MAKE
 *
 * The spec names it directly:
 *
 *   "Geographic coordinates use geodesic computation, never planar arithmetic
 *    on degrees, which is the classic silent error in this class of tool."
 *
 * Applying Pythagoras to longitude and latitude produces a number. It is not a
 * distance, it is a length in degrees, and multiplying it by 111,320 — the
 * usual fix — is only right on the equator along a meridian. At Bhopal (23°N)
 * a degree of longitude is 102 km, not 111; at 60°N it is 56 km. A tool that
 * gets this wrong reports areas that are out by a factor that grows with
 * latitude, and reports them confidently, to two decimal places.
 *
 * So:
 *  - A PROJECTED CRS measures planar. That is what a projection is for, and the
 *    grid distance is the number a surveyor working in that projection wants.
 *  - A GEOGRAPHIC CRS measures GEODESIC — Vincenty's inverse on the ellipsoid
 *    for distance and azimuth, and the exact spherical-excess formula for area.
 *  - AN UNKNOWN CRS measures planar and SAYS SO. Every result carries the
 *    method it was computed by and the unit it is in, so a number can never be
 *    read without knowing what produced it.
 *
 * The last point is the one that makes this safe. `Measurement.method` is not
 * decoration: it is how the UI shows "planar, CRS not declared" beside a
 * length, instead of a bare figure that looks like metres.
 */

import type { CirGeometry, CrsRef, Position } from './cir';
import { WGS84, type Ellipsoid } from '../crs/projection';

export type MeasureMethod = 'planar' | 'geodesic' | 'planar-undeclared';

export const METHOD_LABEL: Record<MeasureMethod, string> = {
  planar: 'Planar, in the projected CRS',
  geodesic: 'Geodesic on the ellipsoid',
  'planar-undeclared': 'Planar — no CRS is declared, so these are raw coordinate units',
};

export interface Measurement {
  value: number;
  /** 'm', 'm²', '°', or 'units' when the CRS declares none. */
  unit: string;
  method: MeasureMethod;
  /** Formatted for display, with the unit. */
  text: string;
  /** Present when the number needs a caveat read alongside it. */
  caveat?: string;
}

export interface MeasureContext {
  crs: CrsRef | null;
  /** Linear unit name from the CRS, e.g. 'metre'. */
  units?: string | null;
  /** Decimal places for linear values. Angles always get 4. */
  decimals?: number;
}

/** Which arithmetic applies to this CRS. */
export function methodFor(crs: CrsRef | null): MeasureMethod {
  if (!crs) return 'planar-undeclared';
  if (crs.kind === 'geographic') return 'geodesic';
  return 'planar';
}

function linearUnit(context: MeasureContext): string {
  if (methodFor(context.crs) === 'geodesic') return 'm';
  if (!context.crs) return 'units';
  const unit = (context.units ?? context.crs.unit ?? '').toLowerCase();
  if (unit.includes('metre') || unit.includes('meter')) return 'm';
  if (unit.includes('foot') || unit.includes('feet')) return 'ft';
  return unit || 'units';
}

function ellipsoidFor(crs: CrsRef | null): Ellipsoid {
  // Only the WGS 84 family is bundled, and `crs/transform.ts` refuses datum
  // shifts beyond it, so using WGS 84 here cannot silently mix datums: a
  // dataset on another datum never reaches this point declared as geographic
  // with a different ellipsoid.
  void crs;
  return WGS84;
}

function format(value: number, unit: string, decimals: number): string {
  const rounded = value.toFixed(decimals);
  // Thousands separators: a cadastral area is commonly seven digits, and
  // 1204338.75 is a number people misread.
  const [whole, fraction] = rounded.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${fraction ? `${grouped}.${fraction}` : grouped} ${unit}`;
}

function measurement(value: number, unit: string, method: MeasureMethod, decimals: number, caveat?: string): Measurement {
  return { value, unit, method, text: format(value, unit, decimals), caveat };
}

const UNDECLARED_CAVEAT =
  'No CRS is declared, so this is arithmetic on raw coordinates. It is a real number only if the coordinates are already in a projected system.';

// --------------------------------------------------------------- distance

/**
 * Distance between two positions.
 *
 * Geodesic for geographic coordinates, planar otherwise.
 */
export function distance(from: Position, to: Position, context: MeasureContext): Measurement {
  const method = methodFor(context.crs);
  const decimals = context.decimals ?? 3;

  if (method === 'geodesic') {
    const solved = vincentyInverse(from, to, ellipsoidFor(context.crs));
    return measurement(solved.distance, 'm', method, decimals, solved.caveat);
  }

  const value = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return measurement(value, linearUnit(context), method, decimals, method === 'planar-undeclared' ? UNDECLARED_CAVEAT : undefined);
}

/** Distance in three dimensions, when both positions carry a Z. */
export function slopeDistance(from: Position, to: Position, context: MeasureContext): Measurement {
  const horizontal = distance(from, to, context);
  const rise = (to[2] ?? 0) - (from[2] ?? 0);
  if (rise === 0) return horizontal;
  const value = Math.hypot(horizontal.value, rise);
  return measurement(value, horizontal.unit, horizontal.method, context.decimals ?? 3, horizontal.caveat);
}

/** Total length along a path. */
export function pathLength(positions: Position[], context: MeasureContext): Measurement {
  let total = 0;
  for (let index = 1; index < positions.length; index++) {
    total += distance(positions[index - 1], positions[index], context).value;
  }
  const method = methodFor(context.crs);
  return measurement(
    total,
    method === 'geodesic' ? 'm' : linearUnit(context),
    method,
    context.decimals ?? 3,
    method === 'planar-undeclared' ? UNDECLARED_CAVEAT : undefined
  );
}

// --------------------------------------------------------------- area

/**
 * Ring area.
 *
 * Planar rings use the shoelace formula. Geographic rings use the exact
 * spherical-excess area on the authalic sphere — NOT the shoelace applied to
 * degrees, which is the error this module exists to avoid.
 *
 * Holes subtract, which is the same convention `qa/diff.ts` uses: a parcel with
 * a 200 m² exclusion is 200 m² smaller, not larger.
 */
export function ringArea(ring: Position[], context: MeasureContext): number {
  if (ring.length < 3) return 0;
  return methodFor(context.crs) === 'geodesic' ? Math.abs(geodesicRingArea(ring)) : Math.abs(shoelace(ring));
}

function shoelace(ring: Position[]): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    sum += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  // Close the ring implicitly when the source did not.
  const last = ring[ring.length - 1];
  const first = ring[0];
  if (last[0] !== first[0] || last[1] !== first[1]) {
    sum += last[0] * first[1] - first[0] * last[1];
  }
  return sum / 2;
}

/**
 * Area of a ring of longitude/latitude on the authalic sphere, in square metres.
 *
 * The standard spherical-excess integral. Exact for a spherical earth, and
 * within about 0.3% of the ellipsoidal answer at any latitude — far better than
 * the order-of-magnitude error that treating degrees as a plane produces, and
 * good enough that the remaining difference is smaller than the coordinate
 * precision of the data it is applied to.
 */
function geodesicRingArea(ring: Position[]): number {
  const radius = 6371008.8; // authalic mean radius, metres
  if (ring.length < 3) return 0;

  let total = 0;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    total += toRadians(next[0] - current[0]) * (2 + Math.sin(toRadians(current[1])) + Math.sin(toRadians(next[1])));
  }
  return (total * radius * radius) / 2;
}

/** Area of a polygon's rings, outer minus holes. */
export function polygonArea(rings: Position[][], context: MeasureContext): Measurement {
  let total = 0;
  for (const [index, ring] of rings.entries()) {
    const area = ringArea(ring, context);
    total += index === 0 ? area : -area;
  }

  const method = methodFor(context.crs);
  const unit = method === 'geodesic' ? 'm²' : `${linearUnit(context)}²`;
  return measurement(
    Math.max(0, total),
    unit,
    method,
    context.decimals ?? 2,
    method === 'planar-undeclared' ? UNDECLARED_CAVEAT : undefined
  );
}

/** Total perimeter of a polygon's rings, holes included. */
export function polygonPerimeter(rings: Position[][], context: MeasureContext): Measurement {
  let total = 0;
  for (const ring of rings) total += pathLength(ring, context).value;
  const method = methodFor(context.crs);
  return measurement(
    total,
    method === 'geodesic' ? 'm' : linearUnit(context),
    method,
    context.decimals ?? 3,
    method === 'planar-undeclared' ? UNDECLARED_CAVEAT : undefined
  );
}

// --------------------------------------------------------------- angles

/**
 * Bearing from one position to another, in degrees clockwise from north.
 *
 * Geographic coordinates get the true forward azimuth, which CHANGES ALONG THE
 * LINE on an ellipsoid — the value returned is the azimuth at the start point,
 * which is what "bearing to" means in survey practice.
 *
 * Projected coordinates get the grid bearing. It is not the true bearing:
 * convergence between grid north and true north reaches several degrees at the
 * edge of a UTM zone. The distinction is carried in `method` so the UI can say
 * which one it is showing.
 */
export function bearing(from: Position, to: Position, context: MeasureContext): Measurement {
  const method = methodFor(context.crs);

  if (method === 'geodesic') {
    const solved = vincentyInverse(from, to, ellipsoidFor(context.crs));
    return {
      value: solved.azimuth,
      unit: '°',
      method,
      text: `${solved.azimuth.toFixed(4)}°`,
      caveat: solved.caveat ?? 'True azimuth at the start point; it changes along a geodesic.',
    };
  }

  const degrees = normaliseDegrees(toDegrees(Math.atan2(to[0] - from[0], to[1] - from[1])));
  return {
    value: degrees,
    unit: '°',
    method,
    text: `${degrees.toFixed(4)}°`,
    caveat:
      method === 'planar-undeclared'
        ? UNDECLARED_CAVEAT
        : 'Grid bearing. Grid north and true north differ by the convergence, which reaches several degrees at a zone edge.',
  };
}

/** Bearing as degrees, minutes and seconds, which is how it is written down. */
export function formatDms(degrees: number): string {
  const normalised = normaliseDegrees(degrees);
  const whole = Math.floor(normalised);
  const minutesFull = (normalised - whole) * 60;
  const minutes = Math.floor(minutesFull);
  const seconds = (minutesFull - minutes) * 60;
  return `${whole}° ${String(minutes).padStart(2, '0')}' ${seconds.toFixed(2).padStart(5, '0')}"`;
}

/** Quadrant bearing, e.g. N 45° 30' 00" E — still standard on Indian survey plans. */
export function formatQuadrant(degrees: number): string {
  const normalised = normaliseDegrees(degrees);
  if (normalised <= 90) return `N ${formatDms(normalised)} E`;
  if (normalised <= 180) return `S ${formatDms(180 - normalised)} E`;
  if (normalised <= 270) return `S ${formatDms(normalised - 180)} W`;
  return `N ${formatDms(360 - normalised)} W`;
}

/** The angle at `vertex` between two arms, 0–180 degrees. */
export function angleBetween(from: Position, vertex: Position, to: Position, context: MeasureContext): Measurement {
  const first = bearing(vertex, from, context).value;
  const second = bearing(vertex, to, context).value;
  let difference = Math.abs(first - second);
  if (difference > 180) difference = 360 - difference;
  return { value: difference, unit: '°', method: methodFor(context.crs), text: `${difference.toFixed(4)}°` };
}

// --------------------------------------------------------------- elevation

export interface SlopeResult {
  /** Vertical difference, `to` minus `from`. */
  rise: Measurement;
  /** Horizontal distance. */
  run: Measurement;
  /** Slope as a percentage. */
  percent: number;
  /** Slope as an angle in degrees. */
  degrees: number;
  /** "1 in 12" — how a gradient is usually specified on a drawing. */
  ratio: string;
}

export function slope(from: Position, to: Position, context: MeasureContext): SlopeResult | null {
  if (from[2] === undefined || to[2] === undefined) return null;

  const run = distance(from, to, context);
  const rise = to[2] - from[2];
  const decimals = context.decimals ?? 3;

  // A vertical difference with no horizontal distance is not a slope; saying
  // "infinite" would be arithmetic, not information.
  if (run.value === 0) {
    return {
      rise: measurement(rise, run.unit, run.method, decimals),
      run,
      percent: Number.POSITIVE_INFINITY,
      degrees: rise === 0 ? 0 : 90,
      ratio: rise === 0 ? 'level' : 'vertical',
    };
  }

  const percent = (rise / run.value) * 100;
  return {
    rise: measurement(rise, run.unit, run.method, decimals),
    run,
    percent,
    degrees: toDegrees(Math.atan2(rise, run.value)),
    ratio: rise === 0 ? 'level' : `1 in ${Math.abs(run.value / rise).toFixed(1)}`,
  };
}

// --------------------------------------------------------------- geometry

export interface GeometryMeasurement {
  length?: Measurement;
  area?: Measurement;
  perimeter?: Measurement;
  vertices: number;
  method: MeasureMethod;
}

/** Measures whatever a geometry has to measure. */
export function measureGeometry(geometry: CirGeometry | null, context: MeasureContext): GeometryMeasurement {
  const method = methodFor(context.crs);
  if (!geometry) return { vertices: 0, method };

  switch (geometry.type) {
    case 'LineString':
      return { length: pathLength(geometry.coordinates as Position[], context), vertices: (geometry.coordinates as Position[]).length, method };

    case 'MultiLineString': {
      const lines = geometry.coordinates as Position[][];
      let total = 0;
      let vertices = 0;
      for (const line of lines) {
        total += pathLength(line, context).value;
        vertices += line.length;
      }
      return {
        length: measurement(total, method === 'geodesic' ? 'm' : linearUnit(context), method, context.decimals ?? 3),
        vertices,
        method,
      };
    }

    case 'Polygon': {
      const rings = geometry.coordinates as Position[][];
      return {
        area: polygonArea(rings, context),
        perimeter: polygonPerimeter(rings, context),
        vertices: rings.reduce((sum, ring) => sum + ring.length, 0),
        method,
      };
    }

    case 'MultiPolygon': {
      const polygons = geometry.coordinates as Position[][][];
      let area = 0;
      let perimeter = 0;
      let vertices = 0;
      for (const rings of polygons) {
        area += polygonArea(rings, context).value;
        perimeter += polygonPerimeter(rings, context).value;
        vertices += rings.reduce((sum, ring) => sum + ring.length, 0);
      }
      const unit = method === 'geodesic' ? 'm²' : `${linearUnit(context)}²`;
      return {
        area: measurement(area, unit, method, context.decimals ?? 2),
        perimeter: measurement(perimeter, method === 'geodesic' ? 'm' : linearUnit(context), method, context.decimals ?? 3),
        vertices,
        method,
      };
    }

    case 'Point':
      return { vertices: 1, method };

    case 'MultiPoint':
      return { vertices: (geometry.coordinates as Position[]).length, method };

    case 'GeometryCollection': {
      let area = 0;
      let length = 0;
      let vertices = 0;
      for (const child of geometry.geometries ?? []) {
        const measured = measureGeometry(child, context);
        area += measured.area?.value ?? 0;
        length += measured.length?.value ?? 0;
        vertices += measured.vertices;
      }
      const result: GeometryMeasurement = { vertices, method };
      if (area > 0) result.area = measurement(area, method === 'geodesic' ? 'm²' : `${linearUnit(context)}²`, method, context.decimals ?? 2);
      if (length > 0) result.length = measurement(length, method === 'geodesic' ? 'm' : linearUnit(context), method, context.decimals ?? 3);
      return result;
    }

    default:
      return { vertices: 0, method };
  }
}

// --------------------------------------------------------------- Vincenty

interface Geodesic {
  distance: number;
  /** Forward azimuth at the start point, degrees clockwise from north. */
  azimuth: number;
  caveat?: string;
}

/**
 * Vincenty's inverse solution: distance and azimuth between two points on an
 * ellipsoid, accurate to a fraction of a millimetre.
 *
 * The iteration fails to converge for nearly-antipodal points — a known
 * property of the method, not a bug in this implementation. When it does, the
 * result FALLS BACK to the great-circle distance and SAYS SO in the caveat,
 * rather than returning the last iterate as though it had converged. Two
 * survey points are never antipodal, so this path is about not lying in a case
 * that should not arise rather than about accuracy in one that does.
 */
function vincentyInverse(from: Position, to: Position, ellipsoid: Ellipsoid): Geodesic {
  const a = ellipsoid.a;
  const f = 1 / ellipsoid.invF;
  const b = a * (1 - f);

  const L = toRadians(to[0] - from[0]);
  const U1 = Math.atan((1 - f) * Math.tan(toRadians(from[1])));
  const U2 = Math.atan((1 - f) * Math.tan(toRadians(to[1])));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let sinLambda = 0;
  let cosLambda = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;
  let converged = false;

  for (let iteration = 0; iteration < 200; iteration++) {
    sinLambda = Math.sin(lambda);
    cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2
    );

    // Coincident points: distance zero, azimuth undefined but reported as 0.
    if (sinSigma === 0) return { distance: 0, azimuth: 0 };

    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    // Equatorial line: cosSqAlpha is 0 and cos2SigmaM is undefined. Zero is the
    // conventional substitution and is correct for that case.
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;

    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    const previous = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));

    if (Math.abs(lambda - previous) < 1e-12) {
      converged = true;
      break;
    }
  }

  if (!converged) {
    // Great-circle fallback, clearly labelled.
    const radius = 6371008.8;
    const phi1 = toRadians(from[1]);
    const phi2 = toRadians(to[1]);
    const deltaPhi = phi2 - phi1;
    const deltaLambda = toRadians(to[0] - from[0]);
    const h = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
    return {
      distance: 2 * radius * Math.asin(Math.min(1, Math.sqrt(h))),
      azimuth: normaliseDegrees(
        toDegrees(
          Math.atan2(
            Math.sin(deltaLambda) * Math.cos(phi2),
            Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda)
          )
        )
      ),
      caveat:
        'The ellipsoidal solution did not converge — the points are nearly antipodal — so this is a great-circle distance on a sphere, accurate to a few kilometres rather than a millimetre.',
    };
  }

  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));

  return {
    distance: b * A * (sigma - deltaSigma),
    azimuth: normaliseDegrees(toDegrees(Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda))),
  };
}

// --------------------------------------------------------------- helpers

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function normaliseDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Converts a bearing and distance into a position — the other half of how
 * survey data is actually recorded (spec §25.1: "coordinate entry in X/Y/Z and
 * by bearing/distance").
 *
 * Planar for a projected CRS; the direct geodesic problem for a geographic one,
 * so that entering a traverse leg in lat/lon lands where the ground does.
 */
export function fromBearingDistance(
  origin: Position,
  bearingDegrees: number,
  distanceValue: number,
  context: MeasureContext
): Position {
  if (methodFor(context.crs) === 'geodesic') return vincentyDirect(origin, bearingDegrees, distanceValue, ellipsoidFor(context.crs));
  const radians = toRadians(bearingDegrees);
  return [origin[0] + distanceValue * Math.sin(radians), origin[1] + distanceValue * Math.cos(radians), ...(origin[2] !== undefined ? [origin[2]] : [])];
}

/** Vincenty's direct solution: where you arrive from a point, azimuth and distance. */
function vincentyDirect(origin: Position, bearingDegrees: number, distanceValue: number, ellipsoid: Ellipsoid): Position {
  const a = ellipsoid.a;
  const f = 1 / ellipsoid.invF;
  const b = a * (1 - f);

  const alpha1 = toRadians(bearingDegrees);
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);

  const tanU1 = (1 - f) * Math.tan(toRadians(origin[1]));
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;

  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  let sigma = distanceValue / (b * A);
  let sinSigma = 0;
  let cosSigma = 0;
  let cos2SigmaM = 0;

  for (let iteration = 0; iteration < 200; iteration++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const deltaSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    const previous = sigma;
    sigma = distanceValue / (b * A) + deltaSigma;
    if (Math.abs(sigma - previous) < 1e-12) break;
  }

  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const latitude = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - f) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp)
  );
  const lambda = Math.atan2(sinSigma * sinAlpha1, cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1);
  const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
  const L =
    lambda -
    (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));

  const longitude = toDegrees(toRadians(origin[0]) + L);
  const out: Position = [((longitude + 540) % 360) - 180, toDegrees(latitude)];
  if (origin[2] !== undefined) out.push(origin[2]);
  return out;
}
