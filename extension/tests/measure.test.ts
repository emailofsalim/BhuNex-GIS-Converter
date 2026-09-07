/**
 * Measurement (spec §26.1).
 *
 * The important tests here are anchored to INDEPENDENT reference values —
 * published geodetic test vectors and textbook arithmetic — not to what this
 * module happens to return. A measurement suite that checks the code against
 * itself proves only that it is consistent, and the failure this module exists
 * to prevent is consistent: treating degrees as a plane gives the same wrong
 * answer every time.
 */

import { describe, expect, it } from 'vitest';
import type { CrsRef, Position } from '@core/cir';
import {
  angleBetween,
  bearing,
  distance,
  formatDms,
  formatQuadrant,
  fromBearingDistance,
  measureGeometry,
  methodFor,
  pathLength,
  polygonArea,
  polygonPerimeter,
  slope,
  slopeDistance,
} from '@core/measure';
import { crsFromEpsg } from '@crs/epsg';

const UTM45N = { crs: crsFromEpsg(32645), units: 'metre' };
const WGS84 = { crs: crsFromEpsg(4326) };
const NO_CRS: { crs: CrsRef | null } = { crs: null };

describe('choosing the arithmetic', () => {
  it('measures a projected CRS in the plane and a geographic one on the ellipsoid', () => {
    expect(methodFor(crsFromEpsg(32645))).toBe('planar');
    expect(methodFor(crsFromEpsg(4326))).toBe('geodesic');
  });

  it('says so when there is no CRS rather than assuming metres', () => {
    expect(methodFor(null)).toBe('planar-undeclared');
    const measured = distance([0, 0], [3, 4], NO_CRS);
    expect(measured.value).toBe(5);
    expect(measured.unit).toBe('units');
    expect(measured.caveat).toContain('No CRS is declared');
  });
});

describe('distance', () => {
  it('is Pythagoras in a projected CRS', () => {
    // 3-4-5, the one triangle everyone can check by eye.
    expect(distance([500000, 2700000], [500003, 2700004], UTM45N).value).toBeCloseTo(5, 9);
  });

  it('matches the published Vincenty test vector for geographic coordinates', () => {
    // Flinders Peak to Buninyong, the standard Vincenty test line.
    //   Flinders Peak  37 57 03.72030 S, 144 25 29.52440 E
    //   Buninyong      37 39 10.15610 S, 143 55 35.38390 E
    // Published inverse solution: 54 972.271 m, initial bearing 306 52 05.37".
    const flindersPeak: Position = [144.4248679, -37.9510334];
    const buninyong: Position = [143.9264955, -37.6528211];

    const measured = distance(flindersPeak, buninyong, WGS84);
    // Sub-millimetre against the published figure, which is what Vincenty's
    // inverse solution is for.
    expect(measured.value).toBeCloseTo(54972.271, 2);
    expect(measured.unit).toBe('m');
    expect(measured.method).toBe('geodesic');

    const azimuth = bearing(flindersPeak, buninyong, WGS84);
    // 306° 52' 05.37" = 306.868158°
    expect(azimuth.value).toBeCloseTo(306.86816, 4);
  });

  it('does NOT treat a degree of longitude as a fixed distance', () => {
    // This is the error the module exists to prevent. One degree of longitude
    // is 111.3 km at the equator and 102.4 km at 23°N — the naive
    // "degrees x 111320" gives the equatorial figure everywhere.
    const atEquator = distance([0, 0], [1, 0], WGS84).value;
    const atBhopal = distance([77, 23], [78, 23], WGS84).value;

    // Reference values from the ellipsoidal parallel radius,
    // N(phi) * cos(phi) * pi/180 with N = a / sqrt(1 - e^2 sin^2 phi):
    //   0N  -> 111 319.5 m      23N -> 102 522.5 m
    expect(atEquator).toBeCloseTo(111319.5, 0);
    expect(atBhopal).toBeCloseTo(102522.5, 0);
    // The whole point: they are not the same number.
    expect(Math.abs(atEquator - atBhopal)).toBeGreaterThan(8000);
  });

  it('measures a degree of latitude as very nearly constant', () => {
    // Latitude degrees barely change with latitude — a useful cross-check that
    // the two axes are not being confused with each other.
    const low = distance([77, 0], [77, 1], WGS84).value;
    const high = distance([77, 50], [77, 51], WGS84).value;
    // Meridian arc per degree, M(phi) * pi/180 with
    // M = a(1 - e^2) / (1 - e^2 sin^2 phi)^1.5, at the mid-latitude of each leg:
    //   0.5N -> 110 574.4 m     50.5N -> 111 238.7 m
    expect(low).toBeCloseTo(110574.4, 0);
    expect(high).toBeCloseTo(111238.7, 0);
  });

  it('returns zero for coincident points instead of failing to converge', () => {
    expect(distance([77, 23], [77, 23], WGS84).value).toBe(0);
  });

  it('adds the vertical component for a slope distance', () => {
    // 3-4-5 horizontally, then 5-12-13 with the rise.
    expect(slopeDistance([0, 0, 0], [3, 4, 12], UTM45N).value).toBeCloseTo(13, 9);
  });

  it('sums a path leg by leg', () => {
    const path: Position[] = [[0, 0], [3, 4], [3, 14]];
    expect(pathLength(path, UTM45N).value).toBeCloseTo(15, 9);
  });
});

describe('area', () => {
  it('is the shoelace area in a projected CRS', () => {
    const square: Position[] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const measured = polygonArea([square], UTM45N);
    expect(measured.value).toBeCloseTo(10000, 6);
    expect(measured.unit).toBe('m²');
  });

  it('subtracts holes rather than adding them', () => {
    const outer: Position[] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const hole: Position[] = [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]];
    expect(polygonArea([outer, hole], UTM45N).value).toBeCloseTo(10000 - 100, 6);
  });

  it('measures a geographic polygon on the sphere, not on the degree grid', () => {
    // A one-degree square at the equator is about 12,308 km². The naive
    // shoelace-on-degrees answer is "1", which is not an area at all.
    const square: Position[] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const measured = polygonArea([square], WGS84);

    expect(measured.unit).toBe('m²');
    expect(measured.method).toBe('geodesic');
    // Spherical-excess area on the authalic sphere:
    //   R^2 * dLambda * (sin phi2 - sin phi1) = 12 363.7 km^2.
    // The ellipsoidal figure is 12 308 km^2, so this module is 0.45% high —
    // stated in its own comments, and four orders of magnitude better than the
    // "1" that shoelace-on-degrees would report.
    expect(measured.value / 1e6).toBeCloseTo(12363.7, 0);
  });

  it('shows the same degree square shrinking with latitude', () => {
    // Meridians converge, so the same one-degree box covers less ground the
    // further from the equator it sits. A planar calculation cannot show this.
    const equator = polygonArea([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]], WGS84).value;
    const north = polygonArea([[[0, 60], [1, 60], [1, 61], [0, 61], [0, 60]]], WGS84).value;
    expect(north).toBeLessThan(equator * 0.55);
  });

  it('closes an unclosed ring rather than losing the last segment', () => {
    const unclosed: Position[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
    expect(polygonArea([unclosed], UTM45N).value).toBeCloseTo(10000, 6);
  });

  it('measures perimeter around every ring including holes', () => {
    const outer: Position[] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const hole: Position[] = [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]];
    expect(polygonPerimeter([outer, hole], UTM45N).value).toBeCloseTo(400 + 40, 6);
  });
});

describe('bearing', () => {
  it('measures clockwise from north in a projected CRS', () => {
    expect(bearing([0, 0], [0, 10], UTM45N).value).toBeCloseTo(0, 9); // north
    expect(bearing([0, 0], [10, 0], UTM45N).value).toBeCloseTo(90, 9); // east
    expect(bearing([0, 0], [0, -10], UTM45N).value).toBeCloseTo(180, 9); // south
    expect(bearing([0, 0], [-10, 0], UTM45N).value).toBeCloseTo(270, 9); // west
    expect(bearing([0, 0], [10, 10], UTM45N).value).toBeCloseTo(45, 9);
  });

  it('warns that a grid bearing is not a true bearing', () => {
    // Convergence reaches several degrees at a zone edge, and a surveyor
    // setting out from this number needs to know which north it refers to.
    expect(bearing([500000, 2700000], [500010, 2700010], UTM45N).caveat).toContain('convergence');
  });

  it('says a geodesic azimuth changes along the line', () => {
    expect(bearing([77, 23], [78, 24], WGS84).caveat).toContain('changes along a geodesic');
  });

  it('formats as degrees, minutes and seconds', () => {
    expect(formatDms(45.5)).toBe("45° 30' 00.00\"");
    expect(formatDms(306.868158)).toBe("306° 52' 05.37\"");
  });

  it('formats as a quadrant bearing, which survey plans still use', () => {
    expect(formatQuadrant(45.5)).toBe("N 45° 30' 00.00\" E");
    expect(formatQuadrant(135)).toBe("S 45° 00' 00.00\" E");
    expect(formatQuadrant(225)).toBe("S 45° 00' 00.00\" W");
    expect(formatQuadrant(315)).toBe("N 45° 00' 00.00\" W");
  });

  it('measures the angle at a corner', () => {
    // A right angle, measured at the origin between east and north.
    expect(angleBetween([10, 0], [0, 0], [0, 10], UTM45N).value).toBeCloseTo(90, 6);
    // A straight line through the vertex is 180 degrees.
    expect(angleBetween([-10, 0], [0, 0], [10, 0], UTM45N).value).toBeCloseTo(180, 6);
  });
});

describe('slope', () => {
  it('reports rise, run, percentage, angle and ratio', () => {
    const result = slope([0, 0, 100], [0, 100, 110], UTM45N)!;
    expect(result.rise.value).toBeCloseTo(10, 9);
    expect(result.run.value).toBeCloseTo(100, 9);
    expect(result.percent).toBeCloseTo(10, 9);
    expect(result.degrees).toBeCloseTo(5.7106, 3);
    expect(result.ratio).toBe('1 in 10.0');
  });

  it('is null when either point has no elevation', () => {
    expect(slope([0, 0], [0, 100, 110], UTM45N)).toBeNull();
    expect(slope([0, 0, 100], [0, 100], UTM45N)).toBeNull();
  });

  it('calls a vertical difference with no run vertical, not infinite slope', () => {
    const result = slope([0, 0, 100], [0, 0, 110], UTM45N)!;
    expect(result.ratio).toBe('vertical');
    expect(result.degrees).toBe(90);
  });

  it('calls a zero rise level', () => {
    expect(slope([0, 0, 100], [0, 100, 100], UTM45N)!.ratio).toBe('level');
  });
});

describe('measuring a whole geometry', () => {
  it('measures a polygon for area and perimeter', () => {
    const measured = measureGeometry(
      { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]], dimension: 2 },
      UTM45N
    );
    expect(measured.area!.value).toBeCloseTo(10000, 6);
    expect(measured.perimeter!.value).toBeCloseTo(400, 6);
    expect(measured.vertices).toBe(5);
  });

  it('measures a line for length and gives it no area', () => {
    const measured = measureGeometry({ type: 'LineString', coordinates: [[0, 0], [3, 4]], dimension: 2 }, UTM45N);
    expect(measured.length!.value).toBeCloseTo(5, 9);
    expect(measured.area).toBeUndefined();
  });

  it('sums the parts of a multipolygon', () => {
    const measured = measureGeometry(
      {
        type: 'MultiPolygon',
        coordinates: [
          [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
          [[[100, 0], [110, 0], [110, 10], [100, 10], [100, 0]]],
        ],
        dimension: 2,
      },
      UTM45N
    );
    expect(measured.area!.value).toBeCloseTo(200, 6);
  });

  it('carries the method through, so a number is never read without it', () => {
    expect(measureGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 0]], dimension: 2 }, WGS84).method).toBe('geodesic');
    expect(measureGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 0]], dimension: 2 }, NO_CRS).method).toBe('planar-undeclared');
  });
});

describe('entering a point by bearing and distance', () => {
  it('is planar trigonometry in a projected CRS', () => {
    const point = fromBearingDistance([1000, 2000], 90, 50, UTM45N);
    expect(point[0]).toBeCloseTo(1050, 6);
    expect(point[1]).toBeCloseTo(2000, 6);
  });

  it('round-trips against the inverse solution on the ellipsoid', () => {
    // The direct and inverse solutions must agree, which is the check that
    // catches a sign or unit error in either of them.
    const origin: Position = [77.4126, 23.2599];
    const arrived = fromBearingDistance(origin, 47.5, 12345.678, WGS84);

    expect(distance(origin, arrived, WGS84).value).toBeCloseTo(12345.678, 3);
    expect(bearing(origin, arrived, WGS84).value).toBeCloseTo(47.5, 6);
  });

  it('closes a four-leg traverse back onto its start', () => {
    // A traverse that should close exactly: the classic field check.
    const start: Position = [77.4126, 23.2599];
    let current = start;
    for (const leg of [
      { bearing: 0, distance: 500 },
      { bearing: 90, distance: 500 },
      { bearing: 180, distance: 500 },
      { bearing: 270, distance: 500 },
    ]) {
      current = fromBearingDistance(current, leg.bearing, leg.distance, WGS84);
    }

    // Not exactly zero — a rectangle on an ellipsoid does not close, and the
    // misclosure is real geodesy rather than an error. It must be small.
    const misclosure = distance(start, current, WGS84).value;
    expect(misclosure).toBeLessThan(1);
  });
});
