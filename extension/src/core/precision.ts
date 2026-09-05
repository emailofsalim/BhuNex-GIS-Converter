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

export function fixedPrecision(decimals: number): PrecisionPolicy {
  return { mode: 'fixed', linearDecimals: decimals, geographicDecimals: decimals, elevationDecimals: decimals };
}

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
