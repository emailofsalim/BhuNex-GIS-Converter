/**
 * Lambert Conformal Conic, from a .prj on disk through to moved coordinates.
 *
 * The projection maths has been in this repository since the CRS engine was
 * written, and it was correct. It was also unreachable: `CrsRef` carried the
 * projection's NAME and none of its parameters, so `transform.ts` could see
 * that a CRS was Lambert and had nothing to project with. Every Lambert file
 * was refused by a tool containing a working implementation of exactly that
 * projection — and `wkt.ts` made it worse by reporting such a file as
 * SUPPORTED, so the refusal arrived at conversion time rather than at load.
 *
 * These tests are therefore mostly about the WIRING. The one that is about the
 * arithmetic is anchored to EPSG's own published worked example, because a
 * round-trip test proves only that a function is self-consistent — a projection
 * with the wrong sign on the false northing round-trips perfectly.
 */

import { describe, expect, it } from 'vitest';
import { crsFromEpsg } from '@crs/epsg';
import { planTransform } from '@crs/transform';
import { buildPrj, parsePrj } from '@crs/wkt';
import { forwardLambertConformalConic, inverseLambertConformalConic } from '@crs/projection';

/** Clarke 1866, as EPSG's Jamaica example uses it. */
const CLARKE_1866 = { name: 'Clarke 1866', a: 6378206.4, invF: 294.9787 };
/** Everest 1830 (1937 adjustment) — what India's legacy sheets are computed on. */
const EVEREST = { name: 'Everest 1830', a: 6377276.345, invF: 300.8017 };

const dms = (d: number, m: number, s: number): number => d + m / 60 + s / 3600;

/** An ESRI-flavoured 2SP Lambert .prj, in the shape ArcGIS actually writes. */
const LCC_2SP_PRJ =
  'PROJCS["USA_Contiguous_Lambert_Conformal_Conic",' +
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],' +
  'PROJECTION["Lambert_Conformal_Conic"],' +
  'PARAMETER["False_Easting",1000000.0],PARAMETER["False_Northing",0.0],' +
  'PARAMETER["Central_Meridian",-96.0],PARAMETER["Standard_Parallel_1",33.0],' +
  'PARAMETER["Standard_Parallel_2",45.0],PARAMETER["Latitude_Of_Origin",39.0],' +
  'UNIT["Meter",1.0]]';

describe('the arithmetic, against EPSG’s published example', () => {
  it('reproduces Guidance Note 7-2 method 9801 (Jamaica) to the centimetre', () => {
    // A round-trip cannot catch a wrong false northing or a flipped sign; only
    // a value someone else computed can. EPSG publishes this one.
    const params = {
      ellipsoid: CLARKE_1866,
      lat1: 18,
      lat2: 18,
      lat0: 18,
      lon0: -77,
      falseEasting: 250000,
      falseNorthing: 150000,
      k0: 1,
    };
    const point = { lat: dms(17, 55, 55.8), lon: -dms(76, 56, 37.26) };
    const projected = forwardLambertConformalConic(point, params);

    expect(projected.x).toBeCloseTo(255966.58, 1);
    expect(projected.y).toBeCloseTo(142493.51, 1);
  });

  it('returns to the same longitude and latitude going back', () => {
    const params = { ellipsoid: EVEREST, lat1: 26, lat2: 26, lat0: 26, lon0: 74, falseEasting: 2743195.5, falseNorthing: 914398.8, k0: 0.99878641 };
    const point = { lon: 75.5, lat: 26.9 };
    const back = inverseLambertConformalConic(forwardLambertConformalConic(point, params), params);
    expect(back.lon).toBeCloseTo(point.lon, 9);
    expect(back.lat).toBeCloseTo(point.lat, 9);
  });

  it('puts the natural origin exactly on the false easting and northing', () => {
    // True for every Lambert, whatever the parameters, so it catches a
    // parameter that has been read into the wrong field.
    const params = { ellipsoid: CLARKE_1866, lat1: 33, lat2: 45, lat0: 39, lon0: -96, falseEasting: 1_000_000, falseNorthing: 0 };
    const origin = forwardLambertConformalConic({ lon: -96, lat: 39 }, params);
    expect(origin.x).toBeCloseTo(1_000_000, 6);
    expect(origin.y).toBeCloseTo(0, 6);
  });
});

describe('the scale factor at the natural origin (k0)', () => {
  /**
   * EPSG method 9801 carries a scale factor; 9802 does not, because two
   * standard parallels already fix the scale. Every India zone uses 9801 with
   * k0 = 0.99878641, and the bundled table omitted it.
   */
  const india = (k0?: number) => ({
    ellipsoid: EVEREST,
    lat1: 26,
    lat2: 26,
    lat0: 26,
    lon0: 74,
    falseEasting: 2743195.5,
    falseNorthing: 914398.8,
    ...(k0 === undefined ? {} : { k0 }),
  });

  it('costs 242 m at 200 km from the origin when it is dropped', () => {
    // The number is the point. This was not a rounding difference to tidy up
    // later — it is a quarter of a kilometre on a cadastral sheet, with
    // nothing on the face of the output to show it.
    const point = { lon: 74, lat: 27.8 };
    const correct = forwardLambertConformalConic(point, india(0.99878641));
    const ignoring = forwardLambertConformalConic(point, india());
    expect(ignoring.y - correct.y).toBeCloseTo(242.06, 1);
  });

  it('defaults to 1, so a 2SP definition is untouched', () => {
    const point = { lon: -95, lat: 40 };
    const params = { ellipsoid: CLARKE_1866, lat1: 33, lat2: 45, lat0: 39, lon0: -96, falseEasting: 0, falseNorthing: 0 };
    const implied = forwardLambertConformalConic(point, params);
    const explicit = forwardLambertConformalConic(point, { ...params, k0: 1 });
    expect(explicit.x).toBe(implied.x);
    expect(explicit.y).toBe(implied.y);
  });

  it('is carried on the bundled India zones', () => {
    expect(crsFromEpsg(24378)?.lcc?.k0).toBe(0.99878641);
    expect(crsFromEpsg(24379)?.lcc?.k0).toBe(0.99878641);
  });
});

describe('a Lambert CRS survives the trip from .prj to CrsRef', () => {
  it('reads every parameter that positions the grid', () => {
    const parsed = parsePrj(LCC_2SP_PRJ);
    expect(parsed.crs?.lcc).toEqual({
      lat1: 33,
      lat2: 45,
      lat0: 39,
      lon0: -96,
      falseEasting: 1_000_000,
      falseNorthing: 0,
    });
  });

  it('reads the ellipsoid too, because the datum name does not imply it', () => {
    expect(parsePrj(LCC_2SP_PRJ).crs?.ellipsoid).toEqual({ name: 'WGS_1984', a: 6378137.0, invF: 298.257223563 });
  });

  it('reports it as supported, because now it is', () => {
    expect(parsePrj(LCC_2SP_PRJ).unsupportedProjection).toBeUndefined();
  });

  it('accepts the 1SP spelling, where the tangent parallel is the origin', () => {
    const oneSp = LCC_2SP_PRJ.replace('PARAMETER["Standard_Parallel_1",33.0],PARAMETER["Standard_Parallel_2",45.0],', 'PARAMETER["Scale_Factor",0.99878641],');
    const lcc = parsePrj(oneSp).crs?.lcc;
    // With no standard parallel stated, 1SP means the cone is tangent at the
    // latitude of origin — inventing a different parallel would move the grid.
    expect(lcc?.lat1).toBe(39);
    expect(lcc?.lat2).toBe(39);
    expect(lcc?.k0).toBe(0.99878641);
  });

  it('accepts the OGC spellings as well as the ESRI ones', () => {
    const ogc = LCC_2SP_PRJ.replace('"Central_Meridian"', '"longitude_of_center"').replace('"Latitude_Of_Origin"', '"latitude_of_center"');
    expect(parsePrj(ogc).crs?.lcc?.lon0).toBe(-96);
    expect(parsePrj(ogc).crs?.lcc?.lat0).toBe(39);
  });
});

describe('a Lambert CRS that cannot be used says so at load, not at conversion', () => {
  it('refuses a definition with no central meridian or origin', () => {
    // Defaulting these to zero would put the site on the Greenwich meridian,
    // which is a plausible-looking answer and the wrong one.
    const stripped = LCC_2SP_PRJ.replace('PARAMETER["Central_Meridian",-96.0],', '').replace('PARAMETER["Latitude_Of_Origin",39.0],', '');
    const parsed = parsePrj(stripped);
    expect(parsed.crs?.lcc).toBeUndefined();
    expect(parsed.unsupportedProjection).toContain('no usable parameters');
  });

  it('names the missing parameters rather than claiming the projection is unimplemented', () => {
    const stripped = LCC_2SP_PRJ.replace('PARAMETER["Central_Meridian",-96.0],', '').replace('PARAMETER["Latitude_Of_Origin",39.0],', '');
    const crs = parsePrj(stripped).crs!;
    let message = '';
    try {
      planTransform(crs, crsFromEpsg(4326)).transform([0, 0]);
    } catch (error) {
      message = (error as { why?: string }).why ?? String(error);
    }
    expect(message).toContain('carries no standard parallels');
    expect(message).toContain('The projection is implemented');
  });
});

describe('a Lambert CRS can be written back out as a .prj', () => {
  it('writes a definition for a CRS that never came from a .prj', () => {
    // EPSG 24379 is built from the bundled table, so it has no verbatim WKT to
    // echo. Before this, `buildPrj` fell through to the empty string and a
    // shapefile export dropped the coordinate system — with every parameter
    // needed to write it sitting on the CrsRef.
    const prj = buildPrj(crsFromEpsg(24379));
    expect(prj).toContain('Lambert_Conformal_Conic');
    expect(prj).toContain('"Central_Meridian",74');
    expect(prj).toContain('"Scale_Factor",0.99878641');
    expect(prj).toContain('Everest');
  });

  it('reads back as the same grid it was written from', () => {
    const original = crsFromEpsg(24379)!;
    const reparsed = parsePrj(buildPrj(original)).crs!;
    expect(reparsed.lcc).toEqual(original.lcc);
    expect(reparsed.ellipsoid?.a).toBeCloseTo(original.ellipsoid!.a, 6);
  });

  it('projects a point identically before and after the round trip', () => {
    // The definitive check: matching fields could still be assembled into a
    // different grid. Matching coordinates could not.
    const original = crsFromEpsg(24379)!;
    const reparsed = parsePrj(buildPrj(original)).crs!;
    const params = (crs: typeof original) => ({ ...crs.lcc!, ellipsoid: crs.ellipsoid! });
    const a = forwardLambertConformalConic({ lon: 75.5, lat: 26.9 }, params(original));
    const b = forwardLambertConformalConic({ lon: 75.5, lat: 26.9 }, params(reparsed));
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });

  it('echoes the original text when the CRS came from a .prj', () => {
    expect(buildPrj(parsePrj(LCC_2SP_PRJ).crs)).toBe(LCC_2SP_PRJ);
  });
});

describe('the wiring: a Lambert file actually converts', () => {
  const lambert = parsePrj(LCC_2SP_PRJ).crs!;
  const wgs84 = crsFromEpsg(4326);

  it('transforms out of Lambert into WGS 84', () => {
    // Before the parameters were carried, this threw CRS_UNSUPPORTED_SOURCE.
    const plan = planTransform(lambert, wgs84);
    expect(plan.identity).toBe(false);
    const [lon, lat] = plan.transform([1_000_000, 0]);
    expect(lon).toBeCloseTo(-96, 9);
    expect(lat).toBeCloseTo(39, 9);
  });

  it('transforms into Lambert as a target, not only out of it', () => {
    const plan = planTransform(wgs84, lambert);
    const [x, y] = plan.transform([-96, 39]);
    expect(x).toBeCloseTo(1_000_000, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it('returns the coordinate it started from, both ways round', () => {
    const out = planTransform(lambert, wgs84).transform([1_240_000, 512_345.6]);
    const back = planTransform(wgs84, lambert).transform(out);
    expect(back[0]).toBeCloseTo(1_240_000, 4);
    expect(back[1]).toBeCloseTo(512_345.6, 4);
  });

  it('keeps Z untouched, because a horizontal transform says nothing about height', () => {
    const out = planTransform(lambert, wgs84).transform([1_000_000, 0, 412.345]);
    expect(out[2]).toBe(412.345);
  });

  it('still refuses a Lambert grid on a datum it cannot shift', () => {
    // India's zones are on Kalianpur 1975 / Everest 1830. The projection is now
    // reachable; the datum shift is a separate thing and is still not bundled,
    // so this must refuse rather than treat Everest coordinates as WGS 84.
    expect(() => planTransform(crsFromEpsg(24379), wgs84)).toThrow(/datum/i);
  });
});
