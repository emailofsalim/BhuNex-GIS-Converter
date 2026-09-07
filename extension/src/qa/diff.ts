/**
 * Source-versus-output comparison (spec §30.2).
 *
 * `fidelity.ts` answers "did the conversion survive its own round trip?" — it
 * re-reads what was written and checks nothing broke. This answers a different
 * question the master document asks for: "how does the output DIFFER from the
 * source, measured, in the units I work in?"
 *
 * The distinction matters because the interesting answer is usually a number,
 * not a verdict:
 *
 *     Source polygon area   1250.21 m²
 *     Output polygon area   1250.20 m²
 *     Difference            0.01 m²    PASS (tolerance 0.05 m²)
 *
 * A surveyor signing off a deliverable needs that line. "PASS" alone tells them
 * nothing about whether the difference is rounding or a defect, and a raw dump
 * of every coordinate tells them nothing at all.
 *
 * Every axis reports the measured difference, the tolerance it was judged
 * against, and where the worst case is — so a failure can be gone and looked at
 * rather than merely known about.
 */

import { allFeatures, featureCount, type CirDataset, type CirFeature, type Position } from '../core/cir';
import { featuresBounds, signedArea } from '../core/geometry';

export type DiffAxis =
  | 'feature-count'
  | 'geometry-types'
  | 'vertex-count'
  | 'coordinates'
  | 'area'
  | 'perimeter'
  | 'extent'
  | 'attributes'
  | 'crs'
  | 'z-range';

export const DIFF_AXIS_LABEL: Record<DiffAxis, string> = {
  'feature-count': 'Feature count',
  'geometry-types': 'Geometry types',
  'vertex-count': 'Vertex count',
  coordinates: 'Coordinates',
  area: 'Area',
  perimeter: 'Perimeter',
  extent: 'Extent',
  attributes: 'Attributes',
  crs: 'Coordinate system',
  'z-range': 'Elevation range',
};

export type DiffVerdict = 'identical' | 'within-tolerance' | 'differs' | 'not-comparable';

export interface DiffEntry {
  axis: DiffAxis;
  verdict: DiffVerdict;
  /** What the source holds, formatted for reading. */
  source: string;
  /** What the output holds. */
  output: string;
  /** The measured difference, formatted with its unit. */
  difference: string;
  /** The tolerance this axis was judged against, when it is numeric. */
  tolerance?: string;
  /** Where the worst case is, so it can be found on the canvas. */
  at?: Position;
  /** Why, when the verdict needs explaining. */
  note?: string;
}

export interface DiffOptions {
  /** Coordinate difference accepted as rounding, in dataset units. */
  coordinateTolerance: number;
  /** Area difference accepted, in squared dataset units. */
  areaTolerance: number;
  /** Perimeter and extent difference accepted, in dataset units. */
  lengthTolerance: number;
  /** Feature count difference accepted — non-zero when a writer splits geometry. */
  featureCountTolerance: number;
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  // A millimetre: below it, survey work is unaffected by the difference.
  coordinateTolerance: 0.001,
  areaTolerance: 0.05,
  lengthTolerance: 0.01,
  featureCountTolerance: 0,
};

export interface DiffReport {
  entries: DiffEntry[];
  /** True when every axis is identical or within tolerance. */
  passed: boolean;
  /** One line, for a log or a status bar. */
  summary: string;
  options: DiffOptions;
}

const UNIT = 'units';

function formatNumber(value: number, decimals = 3): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(decimals);
}

function positionsOf(feature: CirFeature): Position[] {
  const out: Position[] = [];
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      out.push(value as Position);
      return;
    }
    for (const child of value) walk(child);
  };
  walk(feature.geometry?.coordinates);
  return out;
}

function allPositions(dataset: CirDataset): Position[] {
  return allFeatures(dataset).flatMap(positionsOf);
}

function ringsOf(feature: CirFeature): Position[][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates as Position[][];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Position[][][]).flat();
  return [];
}

function pathsOf(feature: CirFeature): Position[][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates as Position[]];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as Position[][];
  return ringsOf(feature);
}

function totalArea(dataset: CirDataset): number {
  let total = 0;
  for (const feature of allFeatures(dataset)) {
    const rings = ringsOf(feature);
    // Holes subtract, which is the whole reason to walk rings rather than
    // shells: a parcel with a 200 m² exclusion is not 200 m² larger than it is.
    rings.forEach((ring, index) => {
      const area = Math.abs(signedArea(ring));
      total += index === 0 ? area : -area;
    });
  }
  return total;
}

function totalPerimeter(dataset: CirDataset): number {
  let total = 0;
  for (const feature of allFeatures(dataset)) {
    for (const path of pathsOf(feature)) {
      for (let index = 1; index < path.length; index++) {
        total += Math.hypot(path[index][0] - path[index - 1][0], path[index][1] - path[index - 1][1]);
      }
    }
  }
  return total;
}

function geometryHistogram(dataset: CirDataset): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const feature of allFeatures(dataset)) {
    const type = feature.geometry?.type ?? 'null';
    histogram[type] = (histogram[type] ?? 0) + 1;
  }
  return histogram;
}

function describeHistogram(histogram: Record<string, number>): string {
  const entries = Object.entries(histogram).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? 'none' : entries.map(([type, count]) => `${count} ${type}`).join(', ');
}

function fieldNames(dataset: CirDataset): string[] {
  const names = new Set<string>();
  for (const layer of dataset.layers) for (const field of layer.fields) names.add(field.name);
  return [...names].sort();
}

function zRange(dataset: CirDataset): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const position of allPositions(dataset)) {
    if (position.length < 3 || !Number.isFinite(position[2])) continue;
    if (position[2] < min) min = position[2];
    if (position[2] > max) max = position[2];
  }
  return Number.isFinite(min) ? { min, max } : null;
}

function numericEntry(
  axis: DiffAxis,
  sourceValue: number,
  outputValue: number,
  tolerance: number,
  unit: string,
  decimals = 3
): DiffEntry {
  const difference = Math.abs(sourceValue - outputValue);
  const verdict: DiffVerdict = difference === 0 ? 'identical' : difference <= tolerance ? 'within-tolerance' : 'differs';
  return {
    axis,
    verdict,
    source: `${formatNumber(sourceValue, decimals)} ${unit}`.trim(),
    output: `${formatNumber(outputValue, decimals)} ${unit}`.trim(),
    difference: `${formatNumber(difference, decimals)} ${unit}`.trim(),
    tolerance: `${formatNumber(tolerance, decimals)} ${unit}`.trim(),
  };
}

/**
 * Compares two datasets across every axis the master document names.
 *
 * Order matters: the axes a reader checks first — did I lose features, did the
 * geometry change type — come before the ones that only matter once those pass.
 */
export function diffDatasets(source: CirDataset, output: CirDataset, options: Partial<DiffOptions> = {}): DiffReport {
  const settings = { ...DEFAULT_DIFF_OPTIONS, ...options };
  const entries: DiffEntry[] = [];

  // --- counts -------------------------------------------------------------
  entries.push(
    numericEntry('feature-count', featureCount(source), featureCount(output), settings.featureCountTolerance, 'features', 0)
  );

  const sourceHistogram = geometryHistogram(source);
  const outputHistogram = geometryHistogram(output);
  const sameShape = JSON.stringify(sourceHistogram) === JSON.stringify(outputHistogram);
  entries.push({
    axis: 'geometry-types',
    verdict: sameShape ? 'identical' : 'differs',
    source: describeHistogram(sourceHistogram),
    output: describeHistogram(outputHistogram),
    difference: sameShape ? 'none' : 'the mix of geometry types changed',
    note: sameShape
      ? undefined
      : 'A writer that splits multi-part geometry, or a format with no polygons, changes this legitimately — check it is the change you asked for.',
  });

  const sourcePositions = allPositions(source);
  const outputPositions = allPositions(output);
  entries.push(numericEntry('vertex-count', sourcePositions.length, outputPositions.length, 0, 'vertices', 0));

  // --- coordinates --------------------------------------------------------
  if (sourcePositions.length === outputPositions.length && sourcePositions.length > 0) {
    let worst = 0;
    let at: Position | undefined;
    for (let index = 0; index < sourcePositions.length; index++) {
      const drift = Math.hypot(
        sourcePositions[index][0] - outputPositions[index][0],
        sourcePositions[index][1] - outputPositions[index][1]
      );
      if (drift > worst) {
        worst = drift;
        at = sourcePositions[index];
      }
    }
    entries.push({
      ...numericEntry('coordinates', 0, worst, settings.coordinateTolerance, UNIT, 4),
      source: 'reference',
      output: `worst drift ${formatNumber(worst, 4)} ${UNIT}`,
      difference: `${formatNumber(worst, 4)} ${UNIT}`,
      at,
      note: worst > settings.coordinateTolerance ? 'Vertex order is unchanged, so this is a real positional difference rather than a reordering.' : undefined,
    });
  } else {
    entries.push({
      axis: 'coordinates',
      verdict: 'not-comparable',
      source: `${sourcePositions.length} vertices`,
      output: `${outputPositions.length} vertices`,
      difference: 'vertex counts differ',
      note: 'Coordinates are compared vertex by vertex in order. With different counts there is no correspondence to compare, so no drift is reported rather than a misleading one.',
    });
  }

  // --- measured quantities ------------------------------------------------
  entries.push(numericEntry('area', totalArea(source), totalArea(output), settings.areaTolerance, `sq ${UNIT}`, 2));
  entries.push(numericEntry('perimeter', totalPerimeter(source), totalPerimeter(output), settings.lengthTolerance, UNIT, 3));

  const sourceBounds = featuresBounds(allFeatures(source));
  const outputBounds = featuresBounds(allFeatures(output));
  const extentDrift = Math.max(
    Math.abs(sourceBounds.minX - outputBounds.minX),
    Math.abs(sourceBounds.minY - outputBounds.minY),
    Math.abs(sourceBounds.maxX - outputBounds.maxX),
    Math.abs(sourceBounds.maxY - outputBounds.maxY)
  );
  entries.push({
    ...numericEntry('extent', 0, Number.isFinite(extentDrift) ? extentDrift : 0, settings.lengthTolerance, UNIT, 4),
    source: `${formatNumber(sourceBounds.minX, 3)}, ${formatNumber(sourceBounds.minY, 3)} → ${formatNumber(sourceBounds.maxX, 3)}, ${formatNumber(sourceBounds.maxY, 3)}`,
    output: `${formatNumber(outputBounds.minX, 3)}, ${formatNumber(outputBounds.minY, 3)} → ${formatNumber(outputBounds.maxX, 3)}, ${formatNumber(outputBounds.maxY, 3)}`,
    note:
      Number.isFinite(extentDrift) && extentDrift > 1000
        ? 'An extent this far apart is almost always a coordinate system mismatch rather than a geometry change.'
        : undefined,
  });

  // --- attributes ---------------------------------------------------------
  const sourceFields = fieldNames(source);
  const outputFields = fieldNames(output);
  const lost = sourceFields.filter((name) => !outputFields.includes(name));
  const gained = outputFields.filter((name) => !sourceFields.includes(name));
  entries.push({
    axis: 'attributes',
    verdict: lost.length === 0 && gained.length === 0 ? 'identical' : lost.length > 0 ? 'differs' : 'within-tolerance',
    source: sourceFields.length > 0 ? sourceFields.join(', ') : 'none',
    output: outputFields.length > 0 ? outputFields.join(', ') : 'none',
    difference:
      lost.length === 0 && gained.length === 0
        ? 'none'
        : [lost.length > 0 ? `${lost.length} lost: ${lost.join(', ')}` : '', gained.length > 0 ? `${gained.length} added: ${gained.join(', ')}` : '']
            .filter(Boolean)
            .join('; '),
    note: lost.length > 0 ? 'A renamed field shows as one lost and one added — DBF shortens names to 10 characters.' : undefined,
  });

  // --- CRS ----------------------------------------------------------------
  const sourceCrs = source.crs ? `${source.crs.name}${source.crs.epsg ? ` (EPSG:${source.crs.epsg})` : ''}` : 'undeclared';
  const outputCrs = output.crs ? `${output.crs.name}${output.crs.epsg ? ` (EPSG:${output.crs.epsg})` : ''}` : 'undeclared';
  entries.push({
    axis: 'crs',
    verdict: sourceCrs === outputCrs ? 'identical' : 'differs',
    source: sourceCrs,
    output: outputCrs,
    difference: sourceCrs === outputCrs ? 'none' : 'the declared coordinate system changed',
    note:
      sourceCrs === outputCrs
        ? undefined
        : 'Expected when a transform was configured, or when the target format mandates its own CRS. Unexpected otherwise.',
  });

  // --- Z ------------------------------------------------------------------
  const sourceZ = zRange(source);
  const outputZ = zRange(output);
  if (sourceZ && outputZ) {
    const drift = Math.max(Math.abs(sourceZ.min - outputZ.min), Math.abs(sourceZ.max - outputZ.max));
    entries.push({
      ...numericEntry('z-range', 0, drift, settings.coordinateTolerance, UNIT, 4),
      source: `${formatNumber(sourceZ.min, 3)} → ${formatNumber(sourceZ.max, 3)}`,
      output: `${formatNumber(outputZ.min, 3)} → ${formatNumber(outputZ.max, 3)}`,
    });
  } else if (sourceZ && !outputZ) {
    entries.push({
      axis: 'z-range',
      verdict: 'differs',
      source: `${formatNumber(sourceZ.min, 3)} → ${formatNumber(sourceZ.max, 3)}`,
      output: 'no elevation',
      difference: 'every Z value was dropped',
      note: 'Either the target stores 2D only, or "preserve Z" is switched off.',
    });
  }

  const failing = entries.filter((entry) => entry.verdict === 'differs');
  const passed = failing.length === 0;
  const summary = passed
    ? `Output matches the source on all ${entries.length} axes${entries.some((entry) => entry.verdict === 'within-tolerance') ? ', within tolerance' : ''}.`
    : `${failing.length} of ${entries.length} axes differ: ${failing.map((entry) => DIFF_AXIS_LABEL[entry.axis]).join(', ')}.`;

  return { entries, passed, summary, options: settings };
}

/**
 * The single line a status bar or a log wants.
 *
 * Formatted the way the master document asks for (§30.2): the two values and
 * the difference, not a bare verdict.
 */
export function describeDiffEntry(entry: DiffEntry): string {
  const verdict = entry.verdict === 'differs' ? 'FAIL' : entry.verdict === 'not-comparable' ? 'N/A' : 'PASS';
  const tolerance = entry.tolerance ? ` (tolerance ${entry.tolerance})` : '';
  return `${DIFF_AXIS_LABEL[entry.axis]}: ${entry.source} → ${entry.output}; difference ${entry.difference}. ${verdict}${tolerance}`;
}
