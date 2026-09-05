import { describe, expect, it } from 'vitest';
import {
  geographicToUtm,
  geographicToWebMercator,
  utmCentralMeridian,
  utmToGeographic,
  utmZoneForLongitude,
  webMercatorToGeographic,
  forwardLambertConformalConic,
  inverseLambertConformalConic,
  WGS84,
} from '@crs/projection';
import { crsFromEpsg, searchEpsg, utmCrs } from '@crs/epsg';
import { buildPrj, parsePrj, parseProj4 } from '@crs/wkt';
import { planTransform, suggestCrs, resolveSourceCrs } from '@crs/transform';
import { ConversionError } from '@core/errors';

describe('UTM projection', () => {
  it('round-trips lat/lon through every zone within 1e-7 degrees', () => {
    let worst = 0;
    for (let zone = 1; zone <= 60; zone++) {
      const centre = utmCentralMeridian(zone);
      for (const latitude of [-80, -45, -10, 0, 10, 23.5, 45, 60, 84]) {
        for (const offset of [-2.9, 0, 2.9]) {
          const south = latitude < 0;
          const point = { lon: centre + offset, lat: latitude };
          const projected = geographicToUtm(point, zone, south);
          const back = utmToGeographic(projected, zone, south);
          worst = Math.max(worst, Math.abs(back.lat - point.lat), Math.abs(back.lon - point.lon));
        }
      }
    }
    expect(worst).toBeLessThan(1e-7);
  });

  it('round-trips easting/northing within one millimetre inside the zone', () => {
    // The eastings are derived by projecting points that genuinely lie in the
    // zone rather than being invented: at 80°N a 3° half-width is only ~58 km,
    // so a fixed easting of 800,000 would sit far outside the zone where the
    // Snyder series is not intended to hold.
    let worst = 0;
    for (const zone of [1, 17, 43, 45, 46, 55, 60]) {
      const centre = utmCentralMeridian(zone);
      for (const south of [false, true]) {
        for (const latitude of south ? [-5, -30, -60, -78] : [5, 30, 60, 78]) {
          for (const offset of [-3, -1.5, 0, 1.5, 3]) {
            const projected = geographicToUtm({ lon: centre + offset, lat: latitude }, zone, south);
            const geographic = utmToGeographic(projected, zone, south);
            const back = geographicToUtm(geographic, zone, south);
            worst = Math.max(worst, Math.abs(back.x - projected.x), Math.abs(back.y - projected.y));
          }
        }
      }
    }
    expect(worst).toBeLessThan(0.001);
  });

  it('places a known Jharkhand control point in UTM zone 45N', () => {
    // Pakhar, Lohardaga — the site the original prototype was built for.
    const point = { lon: 84.68, lat: 23.43 };
    expect(utmZoneForLongitude(point.lon)).toBe(45);
    const projected = geographicToUtm(point, 45, false);
    // Zone 45N spans 84°E to 90°E, so a point just east of the western edge sits
    // well west of the 500,000 m central meridian.
    expect(projected.x).toBeGreaterThan(200000);
    expect(projected.x).toBeLessThan(500000);
    expect(projected.y).toBeGreaterThan(2500000);
    expect(projected.y).toBeLessThan(2650000);
  });

  it('derives the correct central meridian for each zone', () => {
    expect(utmCentralMeridian(1)).toBe(-177);
    expect(utmCentralMeridian(31)).toBe(3);
    expect(utmCentralMeridian(45)).toBe(87);
    expect(utmCentralMeridian(60)).toBe(177);
  });

  it('offsets southern-hemisphere northings by 10,000,000 m', () => {
    const north = geographicToUtm({ lon: 87, lat: -10 }, 45, false);
    const south = geographicToUtm({ lon: 87, lat: -10 }, 45, true);
    expect(south.y - north.y).toBeCloseTo(10000000, 6);
  });
});

describe('Web Mercator', () => {
  it('round-trips within 1e-9 degrees', () => {
    for (const point of [
      { lon: 0, lat: 0 },
      { lon: 87, lat: 23.43 },
      { lon: -122.4, lat: 37.8 },
      { lon: 151.2, lat: -33.9 },
    ]) {
      const back = webMercatorToGeographic(geographicToWebMercator(point));
      expect(back.lon).toBeCloseTo(point.lon, 9);
      expect(back.lat).toBeCloseTo(point.lat, 9);
    }
  });

  it('clamps latitude at the projection limit', () => {
    const projected = geographicToWebMercator({ lon: 0, lat: 89 });
    expect(projected.y).toBeLessThan(20048967);
  });
});

describe('Lambert Conformal Conic', () => {
  it('round-trips an Indian zone IIa coordinate', () => {
    const params = {
      ellipsoid: WGS84,
      lat1: 26,
      lat2: 26,
      lat0: 26,
      lon0: 74,
      falseEasting: 2743195.5,
      falseNorthing: 914398.8,
    };
    const point = { lon: 75.5, lat: 26.9 };
    const back = inverseLambertConformalConic(forwardLambertConformalConic(point, params), params);
    expect(back.lon).toBeCloseTo(point.lon, 8);
    expect(back.lat).toBeCloseTo(point.lat, 8);
  });
});

describe('EPSG registry', () => {
  it('generates all 120 WGS 84 UTM zones', () => {
    expect(crsFromEpsg(32645)?.name).toBe('WGS 84 / UTM zone 45N');
    expect(crsFromEpsg(32745)?.name).toBe('WGS 84 / UTM zone 45S');
    expect(crsFromEpsg(32601)?.utm).toEqual({ zone: 1, south: false });
    expect(crsFromEpsg(32760)?.utm).toEqual({ zone: 60, south: true });
  });

  it('marks EPSG:4326 as latitude-first, matching the authority', () => {
    expect(crsFromEpsg(4326)?.axisOrder).toBe('yx');
    expect(crsFromEpsg(32645)?.axisOrder).toBe('xy');
  });

  it('finds a zone by code and by name', () => {
    expect(searchEpsg('32645')[0].code).toBe(32645);
    expect(searchEpsg('utm zone 45n').some((entry) => entry.code === 32645)).toBe(true);
  });
});

describe('WKT / PRJ', () => {
  it('recovers a UTM zone from an ESRI .prj with no authority code', () => {
    const prj =
      'PROJCS["WGS_1984_UTM_Zone_45N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",' +
      'SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],' +
      'UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
      'PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],' +
      'PARAMETER["Central_Meridian",87.0],PARAMETER["Scale_Factor",0.9996],' +
      'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
    const parsed = parsePrj(prj);
    expect(parsed.crs?.epsg).toBe(32645);
    expect(parsed.crs?.utm).toEqual({ zone: 45, south: false });
  });

  it('reads a southern-hemisphere .prj by its false northing', () => {
    const prj =
      'PROJCS["WGS_1984_UTM_Zone_55S",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",' +
      'SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],' +
      'UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
      'PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],' +
      'PARAMETER["Central_Meridian",147.0],PARAMETER["Scale_Factor",0.9996],' +
      'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
    expect(parsePrj(prj).crs?.epsg).toBe(32755);
  });

  it('prefers an explicit authority code over the projection fingerprint', () => {
    const prj = 'PROJCS["Anything",AUTHORITY["EPSG","3857"]]';
    expect(parsePrj(prj).crs?.epsg).toBe(3857);
  });

  it('round-trips a UTM CRS through .prj generation', () => {
    const generated = buildPrj(utmCrs(43, false));
    expect(parsePrj(generated).crs?.epsg).toBe(32643);
  });

  it('reads a PROJ string', () => {
    expect(parseProj4('+proj=utm +zone=45 +datum=WGS84 +units=m +no_defs')?.epsg).toBe(32645);
    expect(parseProj4('+proj=longlat +datum=WGS84 +no_defs')?.epsg).toBe(4326);
  });

  it('returns no CRS for an empty or unreadable .prj', () => {
    expect(parsePrj('').crs).toBeNull();
    expect(parsePrj('   ').crs).toBeNull();
  });
});

describe('transform safety', () => {
  it('refuses a datum shift it cannot perform', () => {
    const everest = crsFromEpsg(4145)!;
    expect(() => planTransform(everest, crsFromEpsg(4326))).toThrow(ConversionError);
    try {
      planTransform(everest, crsFromEpsg(4326));
    } catch (error) {
      expect((error as ConversionError).code).toBe('CRS_DATUM_SHIFT_UNAVAILABLE');
      // The message must say what to do instead, not merely that it failed.
      expect((error as ConversionError).action).toMatch(/QGIS|GDAL/);
    }
  });

  it('is the identity when source and target match', () => {
    const plan = planTransform(crsFromEpsg(32645), crsFromEpsg(32645));
    expect(plan.identity).toBe(true);
  });

  it('transforms UTM to WGS 84 and back through the plan', () => {
    const toGeographic = planTransform(crsFromEpsg(32645), crsFromEpsg(4326));
    const toProjected = planTransform(crsFromEpsg(4326), crsFromEpsg(32645));
    const original = [412345.678, 2591234.567, 412.5];
    const geographic = toGeographic.transform(original);
    const back = toProjected.transform(geographic);
    expect(back[0]).toBeCloseTo(original[0], 3);
    expect(back[1]).toBeCloseTo(original[1], 3);
    // Z passes through a horizontal transform untouched.
    expect(back[2]).toBe(412.5);
  });
});

describe('CRS suggestion', () => {
  it('suggests geographic for lat/lon-range coordinates', () => {
    const suggestion = suggestCrs({ minX: 84.6, minY: 23.4, maxX: 84.8, maxY: 23.5 });
    expect(suggestion.crs?.epsg).toBe(4326);
    expect(suggestion.ambiguous).toBe(false);
  });

  it('refuses to pick a UTM zone from magnitudes alone', () => {
    const suggestion = suggestCrs({ minX: 412000, minY: 2591000, maxX: 415000, maxY: 2594000 });
    expect(suggestion.crs).toBeNull();
    expect(suggestion.ambiguous).toBe(true);
    expect(suggestion.rationale).toMatch(/60 zones|every one of the 60/i);
  });

  it('blocks conversion when nothing resolves the CRS', () => {
    const resolved = resolveSourceCrs({ suggestion: suggestCrs({ minX: 412000, minY: 2591000, maxX: 415000, maxY: 2594000 }) });
    expect(resolved.blocked).toBe(true);
    expect(resolved.crs).toBeNull();
  });

  it('prefers a declared CRS over a user selection', () => {
    const resolved = resolveSourceCrs({ declared: crsFromEpsg(32645), user: crsFromEpsg(4326) });
    expect(resolved.crs?.epsg).toBe(32645);
    expect(resolved.origin).toBe('declared');
  });
});
