/**
 * Output precision.
 *
 * Internal storage is always IEEE-754 double. Rounding happens exactly once, on
 * the way out of a writer, and never feeds back into computation (rule R10).
 * Display formatting is a separate concern and lives in the UI layer.
 */

export type PrecisionMode = 'full' | 'fixed';

export interface PrecisionPolicy {
  mode: PrecisionMode;
  /** Decimals for projected/linear coordinates when mode = 'fixed'. */
  linearDecimals: number;
  /** Decimals for geographic coordinates; 7 dp ≈ 11 mm at the equator. */
  geographicDecimals: number;
  /** Decimals for elevations. */
  elevationDecimals: number;
}

export const FULL_PRECISION: PrecisionPolicy = {
  mode: 'full',
  linearDecimals: 15,
  geographicDecimals: 15,
  elevationDecimals: 15,
};

/**
 * Survey default: millimetre on projected coordinates, ~11 mm on geographic.
 * Human-readable targets get this; binary targets keep full precision because
 * there is no readability argument for throwing bits away.
 */
export const SURVEY_DEFAULT_PRECISION: PrecisionPolicy = {
  mode: 'fixed',
  linearDecimals: 3,
  geographicDecimals: 7,
  elevationDecimals: 3,
};

/**
 * A degree is not a metre, and a decimal place does not mean the same thing in
 * each.
 *
 * THE DEFECT THIS EXISTS TO PREVENT
 *
 * This used to set all three fields to the SAME number, and the workspace
 * builds its policy from it with the user's "Output precision" setting —
 * which defaults to 3 and is labelled "3 decimals (millimetre)". True of
 * metres. In DEGREES, three decimals is 0.001° ≈ 111 METRES.
 *
 * So every export to a format that imposes WGS 84 — KML, KMZ, GPX, OSM,
 * GeoJSON text sequences — was writing coordinates rounded to a 111 m grid.
 * A cadastral plot of a few tens of metres does not survive that: every vertex
 * collapses onto one or two grid nodes and the parcel comes back as a blocky
 * rectangle. Observed exactly that way in Google Earth, and reproduced here:
 * a twelve-vertex boundary written as `23.429 80.139` twelve times over.
 *
 * Nothing about the old code looked wrong in isolation, and no test caught it
 * because the suites checked feature COUNTS and round-trip verdicts rather than
 * shape, and because `SURVEY_DEFAULT_PRECISION` — used by the pipeline default
 * and the side panel — had the correct 7 all along. Only the workspace, which
 * is where people actually convert, went through this function.
 *
 * THE CONVERSION
 *
 * One degree of latitude is about 111,320 m, so the same ground resolution
 * needs roughly five more decimal places in degrees than in metres. The floor
 * of 7 keeps the documented ~11 mm even when someone asks for a coarse output,
 * because coarse is a REQUEST ABOUT FILE SIZE and nobody asking for it means
 * "destroy the geometry".
 */
export function fixedPrecision(decimals: number): PrecisionPolicy {
  return {
    mode: 'fixed',
    linearDecimals: decimals,
    geographicDecimals: Math.min(15, Math.max(7, decimals + DEGREES_PER_METRE_DECIMALS)),
    elevationDecimals: decimals,
  };
}

/**
 * How many more decimal places a degree needs than a metre for the same ground
 * resolution: log10(111,320) ≈ 5.05, taken as 5.
 */
const DEGREES_PER_METRE_DECIMALS = 5;

/**
 * Rounds without the trailing-noise that toFixed+parseFloat produces on values
 * like 1.005. Returns the value unchanged in 'full' mode so a writer can call
 * this unconditionally.
 */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  if (decimals >= 15) return value;
  const factor = 10 ** decimals;
  // The epsilon nudge fixes binary representations that sit a hair below the
  // tie, e.g. 1.005 stored as 1.00499999999999989.
  return Math.round((value + Number.EPSILON * Math.abs(value)) * factor) / factor;
}

/** Fixed-notation string with no exponent — CSV, DXF and WKT all reject 1e-7. */
export function formatFixed(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '';
  if (decimals >= 15) {
    // Full precision: use the shortest round-trippable form, expanding any
    // exponent notation that JS would otherwise emit for small magnitudes.
    const text = String(value);
    return text.includes('e') || text.includes('E') ? value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : text;
  }
  return value.toFixed(decimals);
}

export interface CoordinateFormatter {
  x(value: number): number;
  y(value: number): number;
  z(value: number): number;
  /** Largest absolute change this policy can introduce, for the QA report. */
  maxDelta(): number;
}

export function coordinateFormatter(policy: PrecisionPolicy, geographic: boolean): CoordinateFormatter {
  const horizontal = policy.mode === 'full' ? 15 : geographic ? policy.geographicDecimals : policy.linearDecimals;
  const vertical = policy.mode === 'full' ? 15 : policy.elevationDecimals;
  return {
    x: (value) => roundTo(value, horizontal),
    y: (value) => roundTo(value, horizontal),
    z: (value) => roundTo(value, vertical),
    maxDelta: () => (horizontal >= 15 ? 0 : 0.5 * 10 ** -horizontal),
  };
}

/**
 * The decimals to write a coordinate with, given what the coordinate IS.
 *
 * Formats fall into three groups. KML, GPX and OSM mandate WGS 84, so they can
 * reach for `geographicDecimals` directly. DXF, Surpac and the point-cloud text
 * writers only ever hold a projected grid, so `linearDecimals` is always right
 * for them. The rest — LandXML, GML, WKT, TopoJSON, CSV, XLSX, MIF/MID — carry
 * whatever the dataset is in, and every one of them reached for
 * `linearDecimals` unconditionally.
 *
 * That is how a LandXML export of a WGS 84 dataset came to write
 * `23.429 80.139`: three decimals, chosen because three decimals of a METRE is
 * a millimetre, applied to degrees where it is 111 m. Eleven distinct vertices
 * collapsed onto three.
 *
 * Structural rather than importing `CrsRef`, to keep this module free of
 * dependencies on the data model it formats.
 */
export function decimalsFor(policy: PrecisionPolicy, crs: { kind?: string } | null | undefined, fullDefault = 15): number {
  if (policy.mode === 'full') return fullDefault;
  return crs?.kind === 'geographic' ? policy.geographicDecimals : policy.linearDecimals;
}
