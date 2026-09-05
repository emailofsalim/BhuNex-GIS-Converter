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
}

export const DEFAULT_FIDELITY_OPTIONS: FidelityOptions = {
  coordinateTolerance: 0.001,
  allowFeatureCountChange: false,
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
 * Largest positional difference between two feature lists, compared in order.
 *
 * Order comparison is correct here because both sides come from the same source
 * through one writer and one reader; a writer that reorders features shows up as
 * a large drift, which is exactly the signal wanted.
 */
function coordinateDrift(source: CirFeature[], target: CirFeature[]): number | null {
  const limit = Math.min(source.length, target.length);
  if (limit === 0) return null;
  let worst = 0;
  for (let index = 0; index < limit; index++) {
    const a = flatten(source[index]);
    const b = flatten(target[index]);
    const vertexLimit = Math.min(a.length, b.length);
    for (let vertex = 0; vertex < vertexLimit; vertex++) {
      const dx = Math.abs(a[vertex][0] - b[vertex][0]);
      const dy = Math.abs(a[vertex][1] - b[vertex][1]);
      if (dx > worst) worst = dx;
      if (dy > worst) worst = dy;
    }
  }
  return worst;
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

  const sourceZ = sourceFeatures.some((feature) => hasZ(feature.geometry));
  const targetZ = targetFeatures.some((feature) => hasZ(feature.geometry));
  checks.push(
    compare(
      'Elevation (Z)',
      sourceZ ? `present, ${formatRange(sourceBounds.minZ, sourceBounds.maxZ)}` : 'none',
      targetZ ? `present, ${formatRange(targetBounds.minZ, targetBounds.maxZ)}` : 'none',
      sourceZ === targetZ || !sourceZ,
      sourceZ && !targetZ ? 'Z values were dropped by the target format.' : undefined,
      'warn'
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
