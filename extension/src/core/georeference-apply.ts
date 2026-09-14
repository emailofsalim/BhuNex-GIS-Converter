/**
 * Georeferencing a drawing that has no coordinate system.
 *
 * A cadastral DXF very often arrives on a local grid: the surveyor set an
 * arbitrary origin at a corner peg, and every coordinate in the file is metres
 * from that peg. The geometry is correct — the distances and angles are real
 * survey measurements — but it sits nowhere on Earth, so it cannot be compared
 * with a map, overlaid on a neighbouring sheet, or exported to anything that
 * carries a CRS.
 *
 * Georeferencing is exactly one affine plus a declared CRS:
 *
 *     X = a·u + b·v + c
 *     Y = d·u + e·v + f
 *
 * WHY AN AFFINE AND NOT translate + rotate + scale
 *
 * Those three already exist as geometry operations and the temptation is to
 * decompose a fit into them. It does not survive contact with real control:
 * a least-squares fit over three or more GCPs generally carries SHEAR and
 * unequal axis scales, and no sequence of translate/rotate/uniform-scale can
 * express that. Decomposing would silently discard the part of the fit that
 * does not fit the decomposition — the residual would be wrong, and the user
 * would be told the drawing landed on its control when it had not.
 *
 * So the affine is stored and applied whole, as one atomic, replayable,
 * undoable command. A similarity fit (the honest default for survey work,
 * where the drawing's internal geometry is trusted) is a special case of the
 * same matrix, and `fitGcps` already refuses to produce one where the control
 * cannot support it.
 *
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT
 *
 * A similarity affine preserves shape exactly: every angle is unchanged and
 * every distance is multiplied by one constant scale. Areas scale by that
 * constant squared. This is the transform to use when the drawing's own
 * measurements are the trusted quantity — which, for a cadastral sheet, they
 * are, because they came off a total station.
 *
 * A general affine does NOT preserve shape. It preserves straightness,
 * parallelism and area RATIOS, but it will stretch one axis relative to the
 * other and shear the drawing. That is sometimes the right answer (a scanned
 * sheet with differential paper shrinkage) and sometimes a disaster (a parcel
 * boundary whose bearings are legal evidence). `describeGeoreference` reports
 * which kind was applied and the scale on each axis, so the choice is visible
 * rather than buried.
 */

import {
  applyAffine,
  type Affine,
  affineScale,
  fitGcps,
  type GeoreferenceFit,
  type GeoreferenceRefusal,
  invertAffine,
} from './georeference';
import type { CirDataset, CirFeature, CirLayer, CrsRef, Position } from './cir';
import { mapPositions } from './geometry';

/**
 * A control point as a surveyor states it: this local coordinate is that
 * real-world coordinate.
 *
 * The least-squares fitter in `georeference.ts` already solves exactly this
 * problem, but it was written for image backdrops and speaks in pixels and
 * ground. Rather than duplicate a tested fitter — or rename its fields and
 * churn every raster caller — this adapter translates the vocabulary and
 * re-words the refusals, which for a backdrop talk about "the image" and would
 * read as nonsense next to a cadastral DXF.
 */
export interface SurveyGcp {
  /** The point's coordinate in the drawing's own local grid. */
  local: Position;
  /** Where that point actually is, in the target CRS. */
  target: Position;
  name?: string;
}

/**
 * Fits control for a vector drawing.
 *
 * Two points give a similarity — rotation, uniform scale and shift, which is
 * what a survey drawing on a local grid actually needs, because its internal
 * geometry is already correct and must not be distorted. Three or more give a
 * full affine by least squares, which can also absorb shear; that is the right
 * choice for a scanned or stretched sheet and the wrong one for total-station
 * work, so the caller must choose deliberately.
 */
export function fitSurveyControl(
  gcps: SurveyGcp[],
  options: { kind?: 'similarity' | 'affine' } = {}
): { fit?: GeoreferenceFit; refusal?: GeoreferenceRefusal } {
  // THE DEFAULT IS SIMILARITY, AND THAT IS A DELIBERATE DEPARTURE.
  //
  // `fitGcps` gives a similarity for exactly two points and a full affine for
  // three or more, which is right for an image: a scan really can be stretched
  // unevenly, and more control should buy a better-fitting warp.
  //
  // It is wrong for a survey drawing. The drawing's internal geometry is the
  // trusted quantity — it came off a total station — and the only unknowns are
  // where it sits, which way it faces, and (at most) one scale factor. Handing
  // four control points to an affine fit lets least squares absorb the control's
  // own observation error as SHEAR in the parcel, which silently deforms every
  // boundary to make the residuals look smaller. The user asked for area,
  // perimeter and vertices to stay put; an affine fit is how that promise gets
  // broken while the report still says the fit is good.
  //
  // So N points give a least-squares 4-parameter Helmert here, and an affine is
  // available only when the caller asks for it by name.
  if ((options.kind ?? 'similarity') === 'similarity' && gcps.length >= 2) {
    return fitLeastSquaresSimilarity(gcps);
  }
  const result = fitGcps(
    gcps.map((gcp) => ({
      pixel: { u: gcp.local[0], v: gcp.local[1] },
      ground: gcp.target,
      name: gcp.name,
    }))
  );
  if (!result.refusal) return result;
  // Re-word the backdrop vocabulary for a drawing.
  return {
    refusal: {
      ...result.refusal,
      what: result.refusal.what.replace('A backdrop needs', 'Placing a drawing needs').replace('the image', 'the drawing'),
      why: result.refusal.why.replace('the image', 'the drawing'),
      action: result.refusal.action.replace('the image', 'the drawing'),
    },
  };
}

/**
 * Least-squares 4-parameter Helmert: scale, rotation, and a shift in each axis.
 *
 *     X = a·u + b·v + tx
 *     Y = −b·u + a·v + ty
 *
 * Writing the rotation and scale as the pair (a, b) = (s·cosθ, −s·sinθ) makes
 * the normal equations linear, so there is a closed form and no iteration:
 * centre both point sets on their centroids, then
 *
 *     a =  Σ(u'x' + v'y') / Σ(u'² + v'²)
 *     b = −Σ(u'y' − v'x') / Σ(u'² + v'²)
 *
 * The single (a, b) pair appearing in both rows is the whole point: it is what
 * forces one scale on both axes and keeps the axes perpendicular, which is what
 * makes the result shape-preserving no matter how many points are supplied or
 * how noisy they are.
 */
function fitLeastSquaresSimilarity(gcps: SurveyGcp[]): { fit?: GeoreferenceFit; refusal?: GeoreferenceRefusal } {
  const n = gcps.length;
  let su = 0;
  let sv = 0;
  let sx = 0;
  let sy = 0;
  for (const gcp of gcps) {
    su += gcp.local[0];
    sv += gcp.local[1];
    sx += gcp.target[0];
    sy += gcp.target[1];
  }
  const ubar = su / n;
  const vbar = sv / n;
  const xbar = sx / n;
  const ybar = sy / n;

  let numeratorA = 0;
  let numeratorB = 0;
  let denominator = 0;
  for (const gcp of gcps) {
    const u = gcp.local[0] - ubar;
    const v = gcp.local[1] - vbar;
    const x = gcp.target[0] - xbar;
    const y = gcp.target[1] - ybar;
    numeratorA += u * x + v * y;
    numeratorB += u * y - v * x;
    denominator += u * u + v * v;
  }

  if (denominator === 0) {
    return {
      refusal: {
        what: 'The control points sit on top of each other.',
        why: 'Every point has the same local coordinate, so there is no baseline to take a scale or a rotation from.',
        action: 'Use control points that are genuinely apart — ideally at opposite corners of the drawing.',
      },
    };
  }

  const a = numeratorA / denominator;
  const b = -numeratorB / denominator;
  if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) {
    return {
      refusal: {
        what: 'The control points do not define a placement.',
        why: 'The fit collapsed to zero scale, which would put the whole drawing on a single point.',
        action: 'Check the control coordinates: a local and a target point are probably transposed.',
      },
    };
  }

  const affine: Affine = { a, b, c: xbar - a * ubar - b * vbar, d: -b, e: a, f: ybar + b * ubar - a * vbar };

  // Residuals are reported in target units at each named point — the figure a
  // surveyor checks the placement against, and the reason not to hide a bad
  // control point behind a single RMS.
  const residuals = gcps.map((gcp, index) => {
    const [fx, fy] = applyAffine(affine, gcp.local[0], gcp.local[1]);
    return {
      name: gcp.name ?? `Point ${index + 1}`,
      residual: Math.hypot(fx - gcp.target[0], fy - gcp.target[1]),
    };
  });
  const worst = residuals.reduce((max, entry) => Math.max(max, entry.residual), 0);
  const rms = Math.sqrt(residuals.reduce((sum, entry) => sum + entry.residual ** 2, 0) / n);
  const scale = Math.hypot(a, b);

  const notes = [
    `Similarity fit over ${n} control point${n === 1 ? '' : 's'}: shape, angles and area ratios are preserved exactly.`,
    `Scale ${scale.toFixed(9)}, rotation ${((Math.atan2(-b, a) * 180) / Math.PI).toFixed(6)}°.`,
  ];
  if (n === 2) {
    notes.push('Two points determine a similarity exactly, so a zero residual here is arithmetic, not a measure of accuracy. Add a third to get a real check.');
  }

  return {
    fit: {
      affine,
      kind: 'similarity',
      residuals,
      rms,
      worst,
      exactlyDetermined: n === 2,
      georeferenced: true,
      notes,
    },
  };
}

/** How the drawing was placed, for the report and the QA trail. */
export interface GeoreferenceRecord {
  affine: Affine;
  crs: CrsRef;
  /** 'similarity' preserves shape; 'affine' may shear. */
  kind: 'similarity' | 'affine';
  /** RMS residual at the control points, in target units. Absent for a manual placement. */
  rmsResidual?: number;
  /** Control points used, when the placement came from a fit rather than dragging. */
  gcpCount?: number;
}

/**
 * Scale on each axis and the rotation, read back out of the matrix.
 *
 * `affineScale` already does the decomposition; this wraps it with the
 * shape-preservation verdict, which is the part a surveyor actually needs to
 * see before accepting a placement.
 */
export function describeGeoreference(affine: Affine): {
  scaleX: number;
  scaleY: number;
  rotationDegrees: number;
  /** True when the two axis scales agree to 1 ppm and the transform is conformal. */
  preservesShape: boolean;
  shearPpm: number;
} {
  const { x, y, rotationDegrees } = affineScale(affine);
  // Shear shows up as a departure from orthogonality between the mapped axes.
  // The dot product of the two column vectors is zero for a conformal matrix.
  const dot = affine.a * affine.b + affine.d * affine.e;
  const magnitude = Math.hypot(affine.a, affine.d) * Math.hypot(affine.b, affine.e);
  const shearPpm = magnitude === 0 ? 0 : Math.abs(dot / magnitude) * 1e6;
  const scaleAgreement = x === 0 && y === 0 ? 0 : Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y));
  return {
    scaleX: x,
    scaleY: y,
    rotationDegrees,
    preservesShape: scaleAgreement <= 1e-6 && shearPpm <= 1,
    shearPpm,
  };
}

/** Applies the affine to one feature, leaving properties untouched. */
function placeFeature(feature: CirFeature, affine: Affine): CirFeature {
  // An attribute-only feature (a DBF row with no shape, which a shapefile is
  // entitled to carry) has nothing to place. Returning it untouched keeps the
  // feature count stable through a placement.
  if (!feature.geometry) return feature;
  return {
    ...feature,
    geometry: mapPositions(feature.geometry, (position: Position) => {
      const [x, y] = applyAffine(affine, position[0], position[1]);
      // Z is a height, not a plan coordinate: a plan affine must not touch it.
      // Scaling elevation by a horizontal grid factor is a classic way to turn
      // good levelling into nonsense, so the third ordinate passes through.
      return position.length > 2 ? [x, y, position[2]] : [x, y];
    }),
  };
}

function placeLayer(layer: CirLayer, affine: Affine): CirLayer {
  return { ...layer, features: layer.features.map((feature) => placeFeature(feature, affine)) };
}

/**
 * Places a whole dataset on its control.
 *
 * Every vertex moves through the same matrix, so relative geometry is preserved
 * exactly as the matrix allows — with a similarity fit, a parcel's shape and
 * its internal angles survive untouched and its area scales by exactly the
 * square of the scale factor.
 *
 * The CRS is stamped at the same moment, and `crsOrigin` records that a person
 * placed it rather than the file declaring it. That distinction matters
 * downstream: a QA report should never present a hand-placed drawing as though
 * its coordinate system came off the file.
 */
export function applyGeoreference(dataset: CirDataset, record: GeoreferenceRecord): CirDataset {
  return {
    ...dataset,
    crs: record.crs,
    crsOrigin: 'user',
    layers: dataset.layers.map((layer) => placeLayer(layer, record.affine)),
  };
}

/**
 * Undoes a placement.
 *
 * Returns null when the affine is singular — a fit that collapsed the drawing
 * to a line or a point, which `fitGcps` refuses to produce but which a manual
 * scale-to-zero could otherwise reach.
 */
export function revertGeoreference(dataset: CirDataset, record: GeoreferenceRecord): CirDataset | null {
  const inverse = invertAffine(record.affine);
  if (!inverse) return null;
  return {
    ...dataset,
    crs: null,
    crsOrigin: 'unknown',
    layers: dataset.layers.map((layer) => placeLayer(layer, inverse)),
  };
}
