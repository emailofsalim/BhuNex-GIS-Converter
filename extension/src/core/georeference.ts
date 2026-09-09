/**
 * Placing an image or a scanned sheet under the canvas (phase G).
 *
 * The owner's situation, in their words:
 *
 *   "if map tile in background is not updated and old enough so the user can
 *    import images or pdf as a background layer if required … when pdf or
 *    images gets import they can be geo ref via Gcp points and from gcp it will
 *    automatically get scalled but if it is in local crs then there must be
 *    option like select two points in the map and giving the distance between
 *    them will scale the pdf ir images"
 *
 * Two routes, because those are two genuinely different situations, and the
 * difference between them is the whole design of this module.
 *
 * ---------------------------------------------------------------------------
 * 1. GCPs — A LEAST-SQUARES AFFINE, AND THE RESIDUALS THAT SAY WHETHER TO TRUST IT
 *
 * Three or more control points give six parameters:
 *
 *     X = a·u + b·v + c
 *     Y = d·u + e·v + f
 *
 * where (u, v) are PIXEL coordinates in the image and (X, Y) are ground
 * coordinates. That is scale, rotation, shear and translation in each axis.
 *
 * With exactly three points the fit is exact and the residuals are all zero —
 * which is not evidence that the georeference is good, only that three points
 * always define an affine. THIS IS THE TRAP THE MODULE EXISTS TO AVOID: an
 * affine through three badly-placed GCPs fits perfectly and is wrong everywhere
 * between them. So `residuals` is always reported, `exactlyDetermined` says
 * when a zero residual means nothing, and a fourth point is what turns the
 * residuals into evidence.
 *
 * Two points give a SIMILARITY transform only — scale, rotation, translation,
 * with no shear and no differential scale. That is a different, weaker thing
 * and it is labelled as such rather than silently fitted as whatever six
 * parameters happen to satisfy four equations.
 *
 * ---------------------------------------------------------------------------
 * 2. TWO POINTS AND A DISTANCE — SCALE AND ROTATION, BUT *NOT* POSITION
 *
 * For an old sheet on a local grid with no control at all: pick two points on
 * the image, say how far apart they are on the ground, and the scale and
 * rotation follow. What does NOT follow is where on Earth it goes.
 *
 * The result is therefore placed relative to the canvas and marked
 * `georeferenced: false`. Every consumer must treat that as "this is a tracing
 * aid, not a coordinate source" — a backdrop that quietly claimed a position it
 * had no basis for would be the single most dangerous thing in this tool,
 * because a scanned sheet looks authoritative.
 */

import type { Position } from './cir';

// ===========================================================================
// The transform
// ===========================================================================

/**
 * An affine from image pixels to ground coordinates.
 *
 * Stored as the six coefficients rather than as a matrix type, because this is
 * exactly the world-file convention (`a d b e c f`, in that order in the file)
 * and keeping the same names makes the sidecar writer obvious.
 */
export interface Affine {
  /** X = a·u + b·v + c */
  a: number;
  b: number;
  c: number;
  /** Y = d·u + e·v + f */
  d: number;
  e: number;
  f: number;
}

export const IDENTITY_AFFINE: Affine = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };

export function applyAffine(affine: Affine, u: number, v: number): Position {
  return [affine.a * u + affine.b * v + affine.c, affine.d * u + affine.e * v + affine.f];
}

/**
 * The inverse affine, or null when the forward one collapses.
 *
 * A determinant of zero means the three control points were collinear, which
 * maps the whole image onto a line. Returning null rather than an Infinity-
 * filled transform matters: the Infinity version propagates into the draw
 * matrix and blanks the canvas, which reads as the tool crashing rather than
 * as a georeference that cannot work.
 */
export function invertAffine(affine: Affine): Affine | null {
  const determinant = affine.a * affine.e - affine.b * affine.d;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  return {
    a: affine.e / determinant,
    b: -affine.b / determinant,
    c: (affine.b * affine.f - affine.e * affine.c) / determinant,
    d: -affine.d / determinant,
    e: affine.a / determinant,
    f: (affine.d * affine.c - affine.a * affine.f) / determinant,
  };
}

/** The ground scale of an affine, in ground units per pixel, per axis. */
export function affineScale(affine: Affine): { x: number; y: number; rotationDegrees: number } {
  const x = Math.hypot(affine.a, affine.d);
  const y = Math.hypot(affine.b, affine.e);
  // Measured from the image's u axis, which is the one a scanner's rotation
  // shows up in. Reported clockwise-positive to match every other angle here.
  const rotationDegrees = (-Math.atan2(affine.d, affine.a) * 180) / Math.PI;
  return { x, y, rotationDegrees };
}

// ===========================================================================
// Ground control points
// ===========================================================================

export interface Gcp {
  /** Where on the image, in pixels from the top-left. */
  pixel: { u: number; v: number };
  /** Where on the ground, in the dataset's CRS. */
  ground: Position;
  /** Optional label, so a residual can be reported against a named point. */
  name?: string;
}

export type FitKind = 'affine' | 'similarity';

export interface GeoreferenceFit {
  affine: Affine;
  kind: FitKind;
  /** Per-point ground distance between the GCP and where the fit puts it. */
  residuals: { name: string; residual: number }[];
  /** Root mean square of the residuals, in ground units. */
  rms: number;
  /** The largest single residual, which is what actually disqualifies a fit. */
  worst: number;
  /**
   * True when there are exactly as many points as parameters.
   *
   * A zero RMS here is arithmetic, not accuracy. Callers MUST say so rather
   * than showing "RMS 0.000 m" as though it were a quality figure.
   */
  exactlyDetermined: boolean;
  /** True when the result can be trusted as an absolute position. */
  georeferenced: true;
  notes: string[];
}

export interface GeoreferenceRefusal {
  what: string;
  why: string;
  action: string;
}

/**
 * Fits an image to ground control points.
 *
 * Three or more give a full affine by least squares; exactly two give a
 * similarity. Fewer than two, or a degenerate arrangement, is refused with the
 * reason rather than fitted to whatever the arithmetic permits.
 */
export function fitGcps(gcps: Gcp[]): { fit?: GeoreferenceFit; refusal?: GeoreferenceRefusal } {
  if (gcps.length < 2) {
    return {
      refusal: {
        what: 'A backdrop needs at least two control points.',
        why: `${gcps.length} ${gcps.length === 1 ? 'was' : 'were'} given. One point fixes position only — it says nothing about scale or rotation.`,
        action: 'Add a second point for scale and rotation, or three for a full affine that can also correct shear.',
      },
    };
  }

  if (gcps.length === 2) return fitSimilarity(gcps);
  return fitAffine(gcps);
}

/**
 * Least-squares affine through three or more points.
 *
 * The two axes are independent — X depends on (u, v) and so does Y, with
 * different coefficients — so this is two separate 3-parameter least-squares
 * problems sharing one normal matrix. Solving them together as a 6x6 would be
 * the same arithmetic written less clearly.
 */
function fitAffine(gcps: Gcp[]): { fit?: GeoreferenceFit; refusal?: GeoreferenceRefusal } {
  // Normal equations: (AᵀA)·x = Aᵀb, where each row of A is [u, v, 1].
  let suu = 0;
  let suv = 0;
  let su = 0;
  let svv = 0;
  let sv = 0;
  let n = 0;
  let sux = 0;
  let svx = 0;
  let sx = 0;
  let suy = 0;
  let svy = 0;
  let sy = 0;

  for (const gcp of gcps) {
    const { u, v } = gcp.pixel;
    const [x, y] = gcp.ground;
    suu += u * u;
    suv += u * v;
    su += u;
    svv += v * v;
    sv += v;
    n += 1;
    sux += u * x;
    svx += v * x;
    sx += x;
    suy += u * y;
    svy += v * y;
    sy += y;
  }

  const normal: number[][] = [
    [suu, suv, su],
    [suv, svv, sv],
    [su, sv, n],
  ];

  const forX = solve3(normal, [sux, svx, sx]);
  const forY = solve3(normal, [suy, svy, sy]);

  if (!forX || !forY) {
    return {
      refusal: {
        what: 'These control points cannot define a transform.',
        why: 'They are collinear or coincident on the image, so they describe a line rather than a plane — an infinite number of transforms fit them equally well.',
        action: 'Spread the points out: three points near the corners of the area you care about, not three along one edge.',
      },
    };
  }

  const affine: Affine = { a: forX[0], b: forX[1], c: forX[2], d: forY[0], e: forY[1], f: forY[2] };
  return { fit: assess(affine, gcps, 'affine', gcps.length === 3) };
}

/**
 * Similarity through exactly two points: scale, rotation, translation.
 *
 * Four equations, four unknowns, so this is exact — and the exactness is
 * reported, because two points ALWAYS fit a similarity perfectly and that says
 * nothing at all about whether they were placed correctly.
 */
function fitSimilarity(gcps: Gcp[]): { fit?: GeoreferenceFit; refusal?: GeoreferenceRefusal } {
  const [first, second] = gcps;
  const du = second.pixel.u - first.pixel.u;
  const dv = second.pixel.v - first.pixel.v;
  const dx = second.ground[0] - first.ground[0];
  const dy = second.ground[1] - first.ground[1];

  const pixelSpan = Math.hypot(du, dv);
  const groundSpan = Math.hypot(dx, dy);
  if (pixelSpan < 1e-9 || groundSpan < 1e-9) {
    return {
      refusal: {
        what: 'The two control points are in the same place.',
        why:
          pixelSpan < 1e-9
            ? 'They sit on the same pixel of the image, so there is no distance to scale from.'
            : 'They have the same ground coordinate, so there is no distance to scale to.',
        action: 'Pick two points as far apart as the sheet allows — a short baseline multiplies every error in it.',
      },
    };
  }

  // The similarity's rotation and scale come from one complex division:
  // (dx + i·dy) / (du + i·dv). Written out rather than left implicit because
  // getting the sign of the rotation wrong mirrors the image, and a mirrored
  // scan of a symmetric sheet looks completely normal.
  const denominator = du * du + dv * dv;
  const scaleCos = (dx * du + dy * dv) / denominator;
  const scaleSin = (dy * du - dx * dv) / denominator;

  const affine: Affine = {
    a: scaleCos,
    b: -scaleSin,
    c: first.ground[0] - scaleCos * first.pixel.u + scaleSin * first.pixel.v,
    d: scaleSin,
    e: scaleCos,
    f: first.ground[1] - scaleSin * first.pixel.u - scaleCos * first.pixel.v,
  };

  return { fit: assess(affine, gcps, 'similarity', true) };
}

/** Measures a candidate transform against the points it was fitted to. */
function assess(affine: Affine, gcps: Gcp[], kind: FitKind, exactlyDetermined: boolean): GeoreferenceFit {
  const residuals = gcps.map((gcp, index) => {
    const [x, y] = applyAffine(affine, gcp.pixel.u, gcp.pixel.v);
    return {
      name: gcp.name ?? `Point ${index + 1}`,
      residual: Math.hypot(x - gcp.ground[0], y - gcp.ground[1]),
    };
  });

  const rms = Math.sqrt(residuals.reduce((sum, entry) => sum + entry.residual ** 2, 0) / Math.max(residuals.length, 1));
  const worst = residuals.reduce((max, entry) => Math.max(max, entry.residual), 0);

  const notes: string[] = [];
  if (exactlyDetermined) {
    notes.push(
      kind === 'similarity'
        ? 'Two points always fit a similarity exactly, so the zero residual is arithmetic rather than accuracy. Add a third point to find out whether the placement is actually right.'
        : 'Three points always fit an affine exactly, so the zero residuals are arithmetic rather than accuracy. A fourth point is what turns them into evidence.'
    );
  }
  if (kind === 'similarity') {
    notes.push(
      'Two points give scale, rotation and position only — no shear and no differential scale, so a sheet stretched along one axis by its scanner cannot be corrected from this.'
    );
  }

  const scale = affineScale(affine);
  notes.push(
    `Ground scale ${scale.x.toPrecision(4)} × ${scale.y.toPrecision(4)} units per pixel, rotated ${scale.rotationDegrees.toFixed(2)}° clockwise.`
  );
  if (kind === 'affine' && Math.abs(scale.x - scale.y) / Math.max(scale.x, scale.y) > 0.02) {
    notes.push(
      'The two axes differ in scale by more than 2%. On a scanned sheet that is usually real — paper stretches, and scanners stretch it further along the feed direction — but it can also mean a GCP was placed on the wrong feature.'
    );
  }

  return { affine, kind, residuals, rms, worst, exactlyDetermined, georeferenced: true, notes };
}

// ===========================================================================
// Two points and a distance
// ===========================================================================

export interface ScaleFit {
  affine: Affine;
  kind: 'two-point-scale';
  /** Ground units per pixel. Uniform: this route cannot see differential scale. */
  unitsPerPixel: number;
  rotationDegrees: number;
  /**
   * Always false, and it is the most important field in this module.
   *
   * Two points and a distance fix scale and rotation. They fix NOTHING about
   * absolute position, because no ground coordinate was supplied. The result is
   * placed relative to the canvas and a consumer must never treat a coordinate
   * read from it as a survey coordinate.
   */
  georeferenced: false;
  notes: string[];
}

/**
 * Scale and rotate an image from two picked points and the distance between
 * them, without claiming to know where on Earth it is.
 *
 * `anchor` is where the FIRST picked point should sit in canvas coordinates —
 * usually wherever the user dropped the image. It is a placement, not a
 * georeference, and the distinction is carried in the return type rather than
 * left to a comment.
 */
export function fitTwoPointScale(
  first: { u: number; v: number },
  second: { u: number; v: number },
  groundDistance: number,
  anchor: Position = [0, 0],
  options: { bearingDegrees?: number } = {}
): { fit?: ScaleFit; refusal?: GeoreferenceRefusal } {
  const du = second.u - first.u;
  const dv = second.v - first.v;
  const pixelSpan = Math.hypot(du, dv);

  if (pixelSpan < 1e-9) {
    return {
      refusal: {
        what: 'The two points are on the same pixel.',
        why: 'There is no image distance to scale from.',
        action: 'Pick two points as far apart as the sheet allows — a short baseline multiplies every error in it.',
      },
    };
  }
  if (!Number.isFinite(groundDistance) || groundDistance <= 0) {
    return {
      refusal: {
        what: 'The ground distance must be a positive number.',
        why: `"${groundDistance}" is not one.`,
        action: 'Enter the distance between the two points in the dataset’s own units.',
      },
    };
  }

  const unitsPerPixel = groundDistance / pixelSpan;

  // Without a stated bearing the image keeps the orientation it was drawn in:
  // the picked line lies along the canvas x axis. A north-up scan is the
  // common case, and inventing a rotation from nothing would be worse than
  // leaving it alone.
  const imageAngle = Math.atan2(dv, du);
  const targetAngle =
    options.bearingDegrees === undefined ? 0 : (-options.bearingDegrees * Math.PI) / 180;
  const rotation = targetAngle - imageAngle;

  const cos = Math.cos(rotation) * unitsPerPixel;
  const sin = Math.sin(rotation) * unitsPerPixel;

  const affine: Affine = {
    a: cos,
    // v grows downward in an image and northing grows upward, so the v column
    // is negated. Getting this wrong flips the sheet vertically, which on a
    // plan with no text is very hard to see.
    b: sin,
    c: anchor[0] - cos * first.u - sin * first.v,
    d: sin,
    e: -cos,
    f: anchor[1] - sin * first.u + cos * first.v,
  };

  const notes: string[] = [
    `Scaled to ${unitsPerPixel.toPrecision(4)} ground units per pixel from the ${groundDistance} you entered.`,
    'NOT georeferenced. Two points and a distance fix scale and rotation only — nothing here says where on Earth the sheet is, so it is placed where you dropped it. Trace from it; do not read coordinates off it.',
  ];
  if (options.bearingDegrees === undefined) {
    notes.push('No bearing given, so the two points were laid along the canvas x axis and the sheet keeps its own orientation.');
  }

  return {
    fit: {
      affine,
      kind: 'two-point-scale',
      unitsPerPixel,
      rotationDegrees: (-rotation * 180) / Math.PI,
      georeferenced: false,
      notes,
    },
  };
}

// ===========================================================================
// Solving
// ===========================================================================

/**
 * Solves a 3x3 system by Gaussian elimination with partial pivoting.
 *
 * Partial pivoting rather than the naive form, because the normal matrix of a
 * set of GCPs in UTM has entries spanning many orders of magnitude — pixel
 * counts in the hundreds against sums of products in the billions — and
 * eliminating on a small pivot loses most of the significant digits.
 *
 * Returns null when the matrix is singular, which is what collinear GCPs
 * produce, rather than a vector of infinities.
 */
function solve3(matrix: number[][], rhs: number[]): number[] | null {
  const m = matrix.map((row, index) => [...row, rhs[index]]);

  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) {
      if (Math.abs(m[row][column]) > Math.abs(m[pivot][column])) pivot = row;
    }
    if (Math.abs(m[pivot][column]) < 1e-12) return null;
    [m[column], m[pivot]] = [m[pivot], m[column]];

    for (let row = column + 1; row < 3; row++) {
      const factor = m[row][column] / m[column][column];
      for (let k = column; k < 4; k++) m[row][k] -= factor * m[column][k];
    }
  }

  const out = [0, 0, 0];
  for (let row = 2; row >= 0; row--) {
    let sum = m[row][3];
    for (let column = row + 1; column < 3; column++) sum -= m[row][column] * out[column];
    out[row] = sum / m[row][row];
  }
  return out.every((value) => Number.isFinite(value)) ? out : null;
}

// ===========================================================================
// Reporting
// ===========================================================================

/** A one-line verdict on a fit, for the panel. */
export function describeFit(fit: GeoreferenceFit | ScaleFit): string {
  if (fit.kind === 'two-point-scale') {
    return `Scaled at ${fit.unitsPerPixel.toPrecision(4)} units per pixel — placed, not georeferenced.`;
  }
  if (fit.exactlyDetermined) {
    return `${fit.kind === 'similarity' ? 'Similarity' : 'Affine'} through ${fit.residuals.length} points — exactly determined, so the residuals cannot tell you anything.`;
  }
  return `${fit.residuals.length} points, RMS ${fit.rms.toPrecision(3)}, worst ${fit.worst.toPrecision(3)} ground units.`;
}
