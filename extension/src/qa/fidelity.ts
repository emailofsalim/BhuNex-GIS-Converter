/**
 * Fidelity QA.
 *
 * A conversion is not verified because it produced bytes. This module re-imports
 * the written output and compares the resulting CIR against the source, so the
 * verdict describes what actually survived the trip (rule R11).
 *
 * The verdict NOT_VALIDATED exists for a reason: when the target has no reader
 * (Surpac string written from a GIS source, say) there is nothing to compare
 * against, and reporting a green PASS in that case would be a lie.
 */

import {
  allFeatures,
  featureCount,
  type CirDataset,
  type CirFeature,
  type GeometryType,
  type Warning,
} from '../core/cir';
import { countVertices, featuresBounds3, hasZ } from '../core/geometry';
import { crsLabel } from '../crs/transform';

export type FidelityVerdict = 'PASS' | 'PASS_WITH_WARNINGS' | 'FAILED' | 'NOT_VALIDATED';

export interface FidelityCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  /** Value measured on the source. */
  source: string;
  /** Value measured on the re-imported output. */
  target: string;
  note?: string;
}

export interface FidelityReport {
  verdict: FidelityVerdict;
  checks: FidelityCheck[];
  warnings: Warning[];
  /** Largest coordinate difference found, in dataset units. */
  maxCoordinateDrift: number | null;
  summary: string;
}

export interface FidelityOptions {
  /** Coordinate difference accepted as rounding rather than corruption. */
  coordinateTolerance: number;
  /** Feature-count difference accepted, e.g. when a writer splits geometry. */
  allowFeatureCountChange: boolean;
  /**
   * Elevation difference accepted as rounding, in the dataset's vertical unit.
   *
   * Separate from `coordinateTolerance` because the two are not in the same
   * unit whenever the output is geographic: a KML's horizontal tolerance is
   * ~1e-6 DEGREES while its levels are metres, and judging metres by a degree
   * tolerance would fail every file that rounds elevation to millimetres.
   */
  elevationTolerance?: number;
}

export const DEFAULT_FIDELITY_OPTIONS: FidelityOptions = {
  coordinateTolerance: 0.001,
  allowFeatureCountChange: false,
  // One millimetre: finer than any survey level is recorded, coarse enough that
  // writing 412.500 for 412.5 is not a finding.
  elevationTolerance: 0.001,
};

function geometryHistogram(features: CirFeature[]): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const feature of features) {
    const type: GeometryType | 'null' = feature.geometry?.type ?? 'null';
    histogram[type] = (histogram[type] ?? 0) + 1;
  }
  return histogram;
}

function formatHistogram(histogram: Record<string, number>): string {
  const entries = Object.entries(histogram).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? 'none' : entries.map(([type, count]) => `${type} × ${count}`).join(', ');
}

/**
 * Largest positional difference between two feature lists.
 *
 * Features are paired in order — both sides come from one source through one
 * writer and one reader, so a writer that reorders features should show up.
 *
 * WITHIN a feature the vertices are sorted before comparing, and that is the
 * important part. Comparing them index-wise was wrong: a shapefile's outer ring
 * must wind CLOCKWISE where GeoJSON's winds counter-clockwise, so the writer
 * correctly reverses it, and the old comparison then read every vertex of a
 * perfectly round-tripped parcel as displaced. It reported "drift 50.00 m" on a
 * 50 m square whose bounds and vertex count it had just confirmed identical —
 * a FAILED verdict on bytes that were exactly right, which is the one kind of
 * QA result worse than no QA at all.
 *
 * Sorting makes the measure invariant to winding, which is the case that
 * actually occurs, while a vertex that genuinely moved still lands at a
 * different position in the sorted order and is still measured.
 *
 * It is NOT invariant to a ring re-started at a different vertex: a closed ring
 * repeats its first vertex at the end, so rotating the start changes which
 * coordinate is duplicated and the two multisets legitimately differ. No writer
 * here re-starts rings, so that is left alone rather than guessed at — the
 * limit is written down instead of being papered over.
 */
function coordinateDrift(source: CirFeature[], target: CirFeature[]): number | null {
  const limit = Math.min(source.length, target.length);
  if (limit === 0) return null;

  // WHEN THE FEATURE LISTS DO NOT LINE UP, INDEX PAIRING IS MEANINGLESS.
  //
  // The sorted-vertex fix above solved this one level down. The same mistake
  // survived one level up: pairing source[i] with target[i] assumes the writer
  // kept both the count and the order, and several formats legitimately keep
  // neither.
  //
  // GPX has no polygons at all — every ring becomes a track, and waypoints are
  // written first — so a four-feature sheet comes back as six with a point at
  // index 0. The comparison then measured a parcel corner against a benchmark
  // and called the difference drift. Measured: GPX and Surpac STR both round-
  // tripped every one of 24 vertices EXACTLY, and both were reported FAILED,
  // with a fabricated "0.001026°" and a suspiciously round "125.0" — which is
  // precisely the width of the test sheet, i.e. one feature against another.
  //
  // A red verdict on a perfect conversion is worse than no verdict: it teaches
  // the user to ignore the one signal that would have told them about a real
  // loss. So when the counts differ, fall back to a nearest-vertex measure,
  // which is invariant to regrouping and still sees a vertex that genuinely
  // moved — nothing near it will match. Loss is not this check's job; the
  // feature-count and vertex-count checks report that, separately and already.
  if (source.length !== target.length) return nearestVertexDrift(source, target);

  let worst = 0;
  for (let index = 0; index < limit; index++) {
    const a = sortVertices(flatten(source[index]));
    const b = sortVertices(flatten(target[index]));
    // Same reasoning within a feature: differing vertex counts mean the writer
    // restructured this geometry, so index pairing cannot be trusted here
    // either.
    if (a.length !== b.length) return nearestVertexDrift(source, target);
    for (let vertex = 0; vertex < a.length; vertex++) {
      const dx = Math.abs(a[vertex][0] - b[vertex][0]);
      const dy = Math.abs(a[vertex][1] - b[vertex][1]);
      if (dx > worst) worst = dx;
      if (dy > worst) worst = dy;
    }
  }
  return worst;
}

/**
 * Worst distance from an OUTPUT vertex to the nearest source vertex.
 *
 * Used when the writer regrouped the features, so there is no correspondence
 * to pair by.
 *
 * THE DIRECTION IS THE WHOLE POINT, and the obvious one is wrong. Measuring
 * source → output asks "did every source vertex survive", which is a question
 * about LOSS, and loss is what the feature-count and vertex-count checks
 * already report. Pointed that way it double-counts: LandXML cannot store an
 * interior ring, so a dropped 20 m hole left its five vertices with nothing
 * near them and drift read "20.00" — a displacement that never happened, on a
 * conversion whose every written vertex was exact.
 *
 * Output → source asks the question this check is actually for: every vertex
 * the writer DID emit should sit on a source vertex. A coordinate that moved
 * lands away from all of them and is caught; a systematic shift moves them all
 * and is caught; a declared, honest omission contributes no output vertices
 * and correctly says nothing here.
 *
 * The known limit, written down rather than papered over: a reader that
 * densifies — turning an arc into segments — invents vertices that sit on no
 * source vertex, and this would read them as drift. No engine here densifies
 * on read, so it is left alone.
 *
 * Bucketed into a grid so this stays linear rather than quadratic: a survey
 * sheet can carry hundreds of thousands of vertices, and QA runs on every
 * conversion.
 */
function nearestVertexDrift(source: CirFeature[], target: CirFeature[]): number | null {
  const from = target.flatMap(flatten);
  const to = source.flatMap(flatten);
  if (from.length === 0 || to.length === 0) return null;

  // Cell size from the target's own spread, so the grid adapts to degrees and
  // to metres without being told which it is holding.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of to) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY);
  const cell = span > 0 ? span / Math.max(1, Math.floor(Math.sqrt(to.length))) : 1;

  const buckets = new Map<string, number[][]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  for (const position of to) {
    const k = key(position[0], position[1]);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(position);
    else buckets.set(k, [position]);
  }

  let worst = 0;
  for (const position of from) {
    const cx = Math.floor(position[0] / cell);
    const cy = Math.floor(position[1] / cell);
    let best = Infinity;
    // Widen the search until something is found: a vertex with no near
    // neighbour is exactly the case this must still measure, not skip.
    for (let radius = 1; radius <= 3 && best === Infinity; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (const other of buckets.get(`${cx + dx}:${cy + dy}`) ?? []) {
            const d = Math.max(Math.abs(position[0] - other[0]), Math.abs(position[1] - other[1]));
            if (d < best) best = d;
          }
        }
      }
    }
    if (best === Infinity) {
      // Nothing within three cells. Fall back to the honest full scan for this
      // vertex rather than reporting a number the grid invented.
      for (const other of to) {
        const d = Math.max(Math.abs(position[0] - other[0]), Math.abs(position[1] - other[1]));
        if (d < best) best = d;
      }
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/** Canonical vertex order: by x, then y. Copies, so the geometry is untouched. */
function sortVertices(vertices: number[][]): number[][] {
  return [...vertices].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function flatten(feature: CirFeature): number[][] {
  const out: number[][] = [];
  const walk = (node: any): void => {
    if (Array.isArray(node) && typeof node[0] === 'number') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) for (const child of node) walk(child);
  };
  if (feature.geometry?.type === 'GeometryCollection') {
    for (const child of feature.geometry.geometries ?? []) walk(child.coordinates);
  } else {
    walk(feature.geometry?.coordinates);
  }
  return out;
}

function compare(name: string, source: string, target: string, ok: boolean, note?: string, severity: 'warn' | 'fail' = 'fail'): FidelityCheck {
  return { name, source, target, status: ok ? 'pass' : severity, note };
}

export function compareVector(
  source: CirDataset,
  target: CirDataset,
  options: FidelityOptions = DEFAULT_FIDELITY_OPTIONS
): FidelityReport {
  const checks: FidelityCheck[] = [];
  const warnings: Warning[] = [];

  const sourceFeatures = allFeatures(source);
  const targetFeatures = allFeatures(target);
  const sourceCount = featureCount(source);
  const targetCount = featureCount(target);

  checks.push(
    compare(
      'Feature count',
      String(sourceCount),
      String(targetCount),
      sourceCount === targetCount || options.allowFeatureCountChange,
      sourceCount === targetCount
        ? undefined
        : targetCount > sourceCount
          ? 'The target format split multi-part geometry into separate features.'
          : 'Features were merged or dropped by the target format.'
    )
  );

  const sourceHistogram = geometryHistogram(sourceFeatures);
  const targetHistogram = geometryHistogram(targetFeatures);
  const sameShape = formatHistogram(sourceHistogram) === formatHistogram(targetHistogram);
  checks.push(
    compare(
      'Geometry types',
      formatHistogram(sourceHistogram),
      formatHistogram(targetHistogram),
      sameShape,
      sameShape ? undefined : 'The target format represents some geometry differently — check the type mapping below.',
      'warn'
    )
  );

  const sourceVertices = sourceFeatures.reduce((sum, feature) => sum + countVertices(feature.geometry), 0);
  const targetVertices = targetFeatures.reduce((sum, feature) => sum + countVertices(feature.geometry), 0);
  checks.push(
    compare(
      'Vertex count',
      sourceVertices.toLocaleString(),
      targetVertices.toLocaleString(),
      sourceVertices === targetVertices,
      sourceVertices === targetVertices
        ? undefined
        : targetVertices > sourceVertices
          ? 'The writer closed rings or densified curves, adding vertices.'
          : 'Vertices were removed — check for duplicate-vertex repair or geometry simplification.',
      'warn'
    )
  );

  const sourceBounds = featuresBounds3(sourceFeatures);
  const targetBounds = featuresBounds3(targetFeatures);
  const boundsDelta = Math.max(
    Math.abs(sourceBounds.minX - targetBounds.minX),
    Math.abs(sourceBounds.minY - targetBounds.minY),
    Math.abs(sourceBounds.maxX - targetBounds.maxX),
    Math.abs(sourceBounds.maxY - targetBounds.maxY)
  );
  const boundsOk = !Number.isFinite(boundsDelta) || boundsDelta <= options.coordinateTolerance;
  checks.push(
    compare(
      'Bounds',
      formatBounds(sourceBounds),
      formatBounds(targetBounds),
      boundsOk,
      boundsOk ? undefined : `Extent moved by up to ${boundsDelta.toPrecision(4)} units — larger than the ${options.coordinateTolerance} tolerance.`
    )
  );

  const drift = coordinateDrift(sourceFeatures, targetFeatures);
  const driftOk = drift === null || drift <= options.coordinateTolerance;
  checks.push({
    name: 'Max coordinate drift',
    source: '0',
    target: drift === null ? 'not measured' : drift.toPrecision(4),
    status: drift === null ? 'skip' : driftOk ? 'pass' : 'fail',
    note: driftOk ? undefined : 'Coordinates moved by more than the output precision can explain.',
  });

  // ---- Elevation, compared BY VALUE and not merely by presence.
  //
  // This asked one question: does any feature still have a third ordinate? A
  // writer that kept the ordinate and replaced every level with zero therefore
  // passed. That is not hypothetical — it is exactly what the KML writer did in
  // its default mode, so a levelled drawing reported "Elevation (Z): pass" with
  // every reduced level in it destroyed. The point-cloud comparison beside this
  // one has always checked the range; the vector one now does the same.
  const sourceZ = sourceFeatures.some((feature) => hasZ(feature.geometry));
  const targetZ = targetFeatures.some((feature) => hasZ(feature.geometry));
  const zTolerance = options.elevationTolerance ?? DEFAULT_FIDELITY_OPTIONS.elevationTolerance!;
  let zOk = sourceZ === targetZ || !sourceZ;
  let zNote = sourceZ && !targetZ ? 'Z values were dropped by the target format.' : undefined;
  let zSeverity: 'warn' | 'fail' = 'warn';

  if (sourceZ && targetZ) {
    const sourceSpan = sourceBounds.maxZ - sourceBounds.minZ;
    const targetSpan = targetBounds.maxZ - targetBounds.minZ;
    const delta = Math.max(
      Math.abs(sourceBounds.minZ - targetBounds.minZ),
      Math.abs(sourceBounds.maxZ - targetBounds.maxZ)
    );
    if (sourceSpan > zTolerance && targetSpan <= zTolerance) {
      // Levels that varied came back all the same. The ordinate survived and
      // the survey did not, which is worse than an honest drop: a drop is
      // reported, this looks like data.
      zOk = false;
      zSeverity = 'fail';
      zNote =
        `Every vertex came back at ${targetBounds.minZ.toFixed(3)}, but the source ranged ` +
        `${formatRange(sourceBounds.minZ, sourceBounds.maxZ)}. The elevations were replaced, not kept.`;
    } else if (delta > zTolerance) {
      zOk = false;
      zNote = `Elevations moved by up to ${delta.toPrecision(4)} — larger than the ${zTolerance} tolerance.`;
    }
  }

  checks.push(
    compare(
      'Elevation (Z)',
      sourceZ ? `present, ${formatRange(sourceBounds.minZ, sourceBounds.maxZ)}` : 'none',
      targetZ ? `present, ${formatRange(targetBounds.minZ, targetBounds.maxZ)}` : 'none',
      zOk,
      zNote,
      zSeverity
    )
  );

  const sourceFields = new Set(sourceFeatures.flatMap((feature) => Object.keys(feature.properties ?? {})).filter((key) => !key.startsWith('_')));
  const targetFields = new Set(targetFeatures.flatMap((feature) => Object.keys(feature.properties ?? {})).filter((key) => !key.startsWith('_')));
  const missingFields = [...sourceFields].filter((field) => !targetFields.has(field));
  checks.push({
    name: 'Attribute fields',
    source: String(sourceFields.size),
    target: String(targetFields.size),
    status: missingFields.length === 0 ? 'pass' : 'warn',
    note:
      missingFields.length === 0
        ? undefined
        : `Not found after re-import: ${missingFields.slice(0, 8).join(', ')}${missingFields.length > 8 ? ` and ${missingFields.length - 8} more` : ''}. Field names may have been shortened by the target format — check the manifest.`,
  });

  checks.push({
    name: 'Coordinate reference system',
    source: crsLabel(source.crs),
    target: crsLabel(target.crs),
    // A target format with no CRS container (DXF, GPX) legitimately loses it.
    status: target.crs === null && source.crs !== null ? 'warn' : 'pass',
    note: target.crs === null && source.crs !== null ? 'The target format has no CRS container; send the .prj or record the CRS separately.' : undefined,
  });

  return finalise(checks, warnings, drift);
}

export function comparePointCloud(
  source: CirDataset,
  target: CirDataset,
  options: FidelityOptions = DEFAULT_FIDELITY_OPTIONS
): FidelityReport {
  const checks: FidelityCheck[] = [];
  const a = source.pointcloud;
  const b = target.pointcloud;
  if (!a || !b) {
    return {
      verdict: 'NOT_VALIDATED',
      checks,
      warnings: [],
      maxCoordinateDrift: null,
      summary: 'One side of the comparison holds no point cloud, so no fidelity check was possible.',
    };
  }

  checks.push(compare('Point count', a.loaded.toLocaleString(), b.loaded.toLocaleString(), a.loaded === b.loaded));

  const bounds = (cloud: typeof a) =>
    cloud.bounds
      ? `${cloud.bounds.minX.toFixed(3)}, ${cloud.bounds.minY.toFixed(3)} → ${cloud.bounds.maxX.toFixed(3)}, ${cloud.bounds.maxY.toFixed(3)}`
      : 'unknown';
  const boundsDelta =
    a.bounds && b.bounds
      ? Math.max(
          Math.abs(a.bounds.minX - b.bounds.minX),
          Math.abs(a.bounds.minY - b.bounds.minY),
          Math.abs(a.bounds.maxX - b.bounds.maxX),
          Math.abs(a.bounds.maxY - b.bounds.maxY)
        )
      : null;
  checks.push(
    compare('Bounding box', bounds(a), bounds(b), boundsDelta === null || boundsDelta <= options.coordinateTolerance)
  );

  const zRange = (cloud: typeof a) => (cloud.bounds ? formatRange(cloud.bounds.minZ, cloud.bounds.maxZ) : 'unknown');
  const zDelta =
    a.bounds && b.bounds ? Math.max(Math.abs(a.bounds.minZ - b.bounds.minZ), Math.abs(a.bounds.maxZ - b.bounds.maxZ)) : null;
  checks.push(compare('Z range', zRange(a), zRange(b), zDelta === null || zDelta <= options.coordinateTolerance));

  // A LAS scale sets the storable resolution; drift below half a scale unit is
  // quantisation, not loss.
  let drift = 0;
  const sampleCount = Math.min(a.loaded, b.loaded, 5000);
  const step = Math.max(1, Math.floor(Math.min(a.loaded, b.loaded) / Math.max(1, sampleCount)));
  for (let index = 0; index < Math.min(a.loaded, b.loaded); index += step) {
    drift = Math.max(
      drift,
      Math.abs(a.points.x[index] - b.points.x[index]),
      Math.abs(a.points.y[index] - b.points.y[index]),
      Math.abs(a.points.z[index] - b.points.z[index])
    );
  }
  const quantisation = b.scale ? Math.max(...b.scale) / 2 : options.coordinateTolerance;
  checks.push({
    name: 'Sampled coordinate drift',
    source: '0',
    target: drift.toPrecision(4),
    status: drift <= Math.max(quantisation, options.coordinateTolerance) ? 'pass' : 'fail',
    note:
      drift <= quantisation
        ? `Within the ${b.scale ? b.scale.join(', ') : 'output'} storage resolution.`
        : 'Larger than the output scale can explain — check the scale and offset settings.',
  });

  const attributeNames: (keyof typeof a.attributes)[] = ['intensity', 'classification', 'returnNumber', 'color', 'gpsTime'];
  const lost = attributeNames.filter((name) => a.attributes[name] && !b.attributes[name]);
  checks.push({
    name: 'Point attributes',
    source: attributeNames.filter((name) => a.attributes[name]).join(', ') || 'none',
    target: attributeNames.filter((name) => b.attributes[name]).join(', ') || 'none',
    status: lost.length === 0 ? 'pass' : 'warn',
    note: lost.length === 0 ? undefined : `Not carried by the target format: ${lost.join(', ')}.`,
  });

  return finalise(checks, [], drift);
}

export function compareRaster(source: CirDataset, target: CirDataset): FidelityReport {
  const checks: FidelityCheck[] = [];
  const a = source.raster;
  const b = target.raster;
  if (!a || !b) {
    return {
      verdict: 'NOT_VALIDATED',
      checks,
      warnings: [],
      maxCoordinateDrift: null,
      summary: 'One side of the comparison holds no raster, so no fidelity check was possible.',
    };
  }

  checks.push(compare('Dimensions', `${a.width} × ${a.height}`, `${b.width} × ${b.height}`, a.width === b.width && a.height === b.height));
  checks.push(compare('Band count', String(a.bandCount), String(b.bandCount), a.bandCount === b.bandCount, undefined, 'warn'));

  const pixelSize = (raster: typeof a) => (raster.geotransform ? `${Math.abs(raster.geotransform[1])} × ${Math.abs(raster.geotransform[5])}` : 'unknown');
  const sizeOk =
    a.geotransform && b.geotransform
      ? Math.abs(Math.abs(a.geotransform[1]) - Math.abs(b.geotransform[1])) < 1e-9 &&
        Math.abs(Math.abs(a.geotransform[5]) - Math.abs(b.geotransform[5])) < 1e-9
      : false;
  checks.push(compare('Pixel size', pixelSize(a), pixelSize(b), sizeOk));

  const extent = (raster: typeof a) =>
    raster.extent ? `${raster.extent.minX.toFixed(3)}, ${raster.extent.minY.toFixed(3)} → ${raster.extent.maxX.toFixed(3)}, ${raster.extent.maxY.toFixed(3)}` : 'unknown';
  const extentDelta =
    a.extent && b.extent
      ? Math.max(
          Math.abs(a.extent.minX - b.extent.minX),
          Math.abs(a.extent.minY - b.extent.minY),
          Math.abs(a.extent.maxX - b.extent.maxX),
          Math.abs(a.extent.maxY - b.extent.maxY)
        )
      : null;
  checks.push(compare('Extent', extent(a), extent(b), extentDelta !== null && extentDelta < 1e-6));

  checks.push(compare('NoData value', String(a.noData ?? 'none'), String(b.noData ?? 'none'), a.noData === b.noData, undefined, 'warn'));
  checks.push({
    name: 'Coordinate reference system',
    source: crsLabel(source.crs),
    target: crsLabel(target.crs),
    status: target.crs === null && source.crs !== null ? 'warn' : 'pass',
  });

  // Pixel comparison only means something when both sides decoded their values.
  if (a.hasPixelData && b.hasPixelData && a.bands && b.bands) {
    let worst = 0;
    let compared = 0;
    const bandCount = Math.min(a.bands.length, b.bands.length);
    for (let band = 0; band < bandCount; band++) {
      const left = a.bands[band];
      const right = b.bands[band];
      const length = Math.min(left.length, right.length);
      const step = Math.max(1, Math.floor(length / 10000));
      for (let index = 0; index < length; index += step) {
        const difference = Math.abs(left[index] - right[index]);
        if (Number.isFinite(difference)) {
          worst = Math.max(worst, difference);
          compared++;
        }
      }
    }
    checks.push({
      name: 'Sampled pixel difference',
      source: '0',
      target: worst.toPrecision(4),
      status: worst < 1e-6 ? 'pass' : worst < 0.001 ? 'warn' : 'fail',
      note: `${compared.toLocaleString()} sample(s) compared.`,
    });
  } else {
    checks.push({
      name: 'Pixel values',
      source: a.hasPixelData ? 'decoded' : 'not decoded',
      target: b.hasPixelData ? 'decoded' : 'not decoded',
      status: 'skip',
      note: 'One side was read metadata-only, so pixel values could not be compared.',
    });
  }

  return finalise(checks, [], null);
}

function finalise(checks: FidelityCheck[], warnings: Warning[], drift: number | null): FidelityReport {
  const failed = checks.filter((check) => check.status === 'fail');
  const warned = checks.filter((check) => check.status === 'warn');
  const verdict: FidelityVerdict = failed.length > 0 ? 'FAILED' : warned.length > 0 ? 'PASS_WITH_WARNINGS' : 'PASS';
  const summary =
    failed.length > 0
      ? `${failed.length} check(s) failed: ${failed.map((check) => check.name).join(', ')}.`
      : warned.length > 0
        ? `Re-imported and verified with ${warned.length} known loss(es): ${warned.map((check) => check.name).join(', ')}.`
        : 'Re-imported and verified: every check matched the source.';
  return { verdict, checks, warnings, maxCoordinateDrift: drift, summary };
}

/**
 * The report for a target with no reader. Producing bytes is not verification,
 * so this is the honest result rather than a green PASS.
 */
export function notValidated(reason: string): FidelityReport {
  return {
    verdict: 'NOT_VALIDATED',
    checks: [],
    warnings: [],
    maxCoordinateDrift: null,
    summary: `Output was written but not verified. ${reason}`,
  };
}

function formatBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }): string {
  if (!Number.isFinite(bounds.minX)) return 'empty';
  return `${bounds.minX.toFixed(3)}, ${bounds.minY.toFixed(3)} → ${bounds.maxX.toFixed(3)}, ${bounds.maxY.toFixed(3)}`;
}

function formatRange(min: number, max: number): string {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 'unknown';
  return `${min.toFixed(3)} → ${max.toFixed(3)}`;
}

export const VERDICT_LABEL: Record<FidelityVerdict, string> = {
  PASS: 'Fidelity: PASS',
  PASS_WITH_WARNINGS: 'Fidelity: PASS WITH WARNINGS',
  FAILED: 'Fidelity: FAILED',
  NOT_VALIDATED: 'Fidelity: NOT VALIDATED',
};
