/**
 * Bundled EPSG subset.
 *
 * The full EPSG registry is ~7,000 entries and several megabytes; shipping it
 * would bloat an offline extension for no benefit. What is bundled is what
 * survey and GIS work in this product's domain actually uses: WGS 84, Web
 * Mercator, every UTM zone in both hemispheres (generated, not enumerated), and
 * the Indian legacy grids. Anything else is entered as WKT or PROJ text, which
 * the transform engine accepts directly.
 */

import type { CrsRef } from '../core/cir';
import { EVEREST_1830, GRS80, WGS84, type Ellipsoid } from './projection';

export interface EpsgEntry {
  code: number;
  name: string;
  kind: 'geographic' | 'projected';
  datum: string;
  ellipsoid: Ellipsoid;
  projection: string;
  unit: string;
  /** Authority-defined axis order. Readers normalise coordinates to x/y anyway. */
  axisOrder: 'xy' | 'yx';
  utm?: { zone: number; south: boolean };
  /** Region hint shown in the CRS picker. */
  region?: string;
  lcc?: NonNullable<CrsRef['lcc']>;
}

const BASE_ENTRIES: EpsgEntry[] = [
  {
    code: 4326,
    name: 'WGS 84',
    kind: 'geographic',
    datum: 'WGS 1984',
    ellipsoid: WGS84,
    projection: 'Geographic',
    unit: 'degree',
    // EPSG defines 4326 as latitude-first. Readers that follow the authority
    // (GML with srsName=EPSG:4326) must swap; GeoJSON deliberately does not.
    axisOrder: 'yx',
    region: 'World',
  },
  {
    code: 4979,
    name: 'WGS 84 (3D)',
    kind: 'geographic',
    datum: 'WGS 1984',
    ellipsoid: WGS84,
    projection: 'Geographic 3D',
    unit: 'degree',
    axisOrder: 'yx',
    region: 'World',
  },
  {
    code: 4269,
    name: 'NAD83',
    kind: 'geographic',
    datum: 'North American Datum 1983',
    ellipsoid: GRS80,
    projection: 'Geographic',
    unit: 'degree',
    axisOrder: 'yx',
    region: 'North America',
  },
  {
    code: 3857,
    name: 'WGS 84 / Pseudo-Mercator',
    kind: 'projected',
    datum: 'WGS 1984',
    ellipsoid: WGS84,
    projection: 'Popular Visualisation Pseudo Mercator',
    unit: 'metre',
    axisOrder: 'xy',
    region: 'World (web maps)',
  },
];

/** Generates the 120 WGS 84 UTM zone definitions rather than listing them. */
function utmEntries(): EpsgEntry[] {
  const out: EpsgEntry[] = [];
  for (let zone = 1; zone <= 60; zone++) {
    for (const south of [false, true]) {
      const code = (south ? 32700 : 32600) + zone;
      out.push({
        code,
        name: `WGS 84 / UTM zone ${zone}${south ? 'S' : 'N'}`,
        kind: 'projected',
        datum: 'WGS 1984',
        ellipsoid: WGS84,
        projection: 'Transverse Mercator',
        unit: 'metre',
        axisOrder: 'xy',
        utm: { zone, south },
        region: utmRegionHint(zone, south),
      });
    }
  }
  return out;
}

/**
 * Coarse region hints for the zone picker. Indian zones are named explicitly
 * because they are this product's primary field of use (instruction §6.4).
 */
function utmRegionHint(zone: number, south: boolean): string {
  if (!south) {
    switch (zone) {
      case 42:
        return 'India — Gujarat, Rajasthan (west)';
      case 43:
        return 'India — Rajasthan, Gujarat, Maharashtra (west)';
      case 44:
        return 'India — Madhya Pradesh, Maharashtra, Karnataka';
      case 45:
        return 'India — Jharkhand, Odisha, Chhattisgarh, Bihar, Nepal';
      case 46:
        return 'India — West Bengal, Assam, Bangladesh, Bhutan';
      case 47:
        return 'India — north-east, Myanmar (west)';
      default:
        break;
    }
  }
  const centre = (zone - 1) * 6 - 180 + 3;
  return `Central meridian ${Math.abs(centre)}°${centre < 0 ? 'W' : 'E'} ${south ? 'south' : 'north'}`;
}

/**
 * Scale factor at the natural origin, shared by every India zone (EPSG method
 * 9801). Omitting it is not a rounding matter: it shrinks every distance by
 * 1.21 m per kilometre, so a point 200 km from the origin lands about 240 m
 * out with nothing on the face of the file to show it.
 */
const INDIA_ZONE_K0 = 0.99878641;

/** Indian legacy grids that still appear in cadastral and mining deliveries. */
const INDIAN_ENTRIES: EpsgEntry[] = [
  {
    code: 4240,
    name: 'Indian 1975',
    kind: 'geographic',
    datum: 'Indian 1975',
    ellipsoid: EVEREST_1830,
    projection: 'Geographic',
    unit: 'degree',
    axisOrder: 'yx',
    region: 'India, Thailand',
  },
  {
    code: 4145,
    name: 'Kalianpur 1975',
    kind: 'geographic',
    datum: 'Kalianpur 1975',
    ellipsoid: EVEREST_1830,
    projection: 'Geographic',
    unit: 'degree',
    axisOrder: 'yx',
    region: 'India',
  },
  {
    code: 24378,
    name: 'Kalianpur 1975 / India zone I',
    kind: 'projected',
    datum: 'Kalianpur 1975',
    ellipsoid: EVEREST_1830,
    projection: 'Lambert Conic Conformal (1SP)',
    unit: 'metre',
    axisOrder: 'xy',
    region: 'India — north of 28°N',
    lcc: { lat1: 32.5, lat2: 32.5, lat0: 32.5, lon0: 68, falseEasting: 2743195.5, falseNorthing: 914398.8, k0: INDIA_ZONE_K0 },
  },
  {
    code: 24379,
    name: 'Kalianpur 1975 / India zone IIa',
    kind: 'projected',
    datum: 'Kalianpur 1975',
    ellipsoid: EVEREST_1830,
    projection: 'Lambert Conic Conformal (1SP)',
    unit: 'metre',
    axisOrder: 'xy',
    region: 'India — 21°N to 28°N, west',
    lcc: { lat1: 26, lat2: 26, lat0: 26, lon0: 74, falseEasting: 2743195.5, falseNorthing: 914398.8, k0: INDIA_ZONE_K0 },
  },
];

export const EPSG_ENTRIES: EpsgEntry[] = [...BASE_ENTRIES, ...utmEntries(), ...INDIAN_ENTRIES];

const BY_CODE = new Map(EPSG_ENTRIES.map((entry) => [entry.code, entry]));

export function epsgEntry(code: number): EpsgEntry | undefined {
  return BY_CODE.get(code);
}

export function crsFromEpsg(code: number): CrsRef | null {
  const entry = BY_CODE.get(code);
  if (!entry) return null;
  return {
    epsg: entry.code,
    name: entry.name,
    kind: entry.kind,
    datum: entry.datum,
    projection: entry.projection,
    unit: entry.unit,
    axisOrder: entry.axisOrder,
    utm: entry.utm,
    // Both of these used to be dropped here, which is why the bundled Lambert
    // engine could never be reached: the table knew the parameters and the
    // CrsRef handed to the transform did not.
    lcc: entry.lcc,
    ellipsoid: entry.ellipsoid,
  };
}

export const WGS84_CRS: CrsRef = crsFromEpsg(4326)!;
export const WEB_MERCATOR_CRS: CrsRef = crsFromEpsg(3857)!;

export function utmCrs(zone: number, south: boolean): CrsRef {
  return crsFromEpsg((south ? 32700 : 32600) + zone)!;
}

/** Free-text search over the bundled entries, for the CRS picker. */
export function searchEpsg(query: string, limit = 40): EpsgEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return EPSG_ENTRIES.slice(0, limit);
  const numeric = Number(trimmed.replace(/^epsg:?/, ''));
  if (Number.isInteger(numeric) && numeric > 0) {
    const exact = BY_CODE.get(numeric);
    if (exact) return [exact];
  }
  const terms = trimmed.split(/\s+/);
  const scored: { entry: EpsgEntry; score: number }[] = [];
  for (const entry of EPSG_ENTRIES) {
    const haystack = `${entry.code} ${entry.name} ${entry.datum} ${entry.projection} ${entry.region ?? ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!haystack.includes(term)) {
        score = -1;
        break;
      }
      score += haystack.startsWith(term) ? 2 : 1;
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.code - b.entry.code);
  return scored.slice(0, limit).map((item) => item.entry);
}

/** UTM zones pinned to the top of the picker for Indian survey work. */
export const QUICK_ZONES = [42, 43, 44, 45, 46, 47];
