/**
 * Project health (spec §29.2, §29.1).
 *
 * One score from seven components: CRS certainty, geometry validity, topology,
 * duplicate data, missing attributes, conversion risk and unresolved warnings.
 *
 * The spec's sentence about this is the whole design brief:
 *
 *   "always expandable into the exact contributing items. A score with no
 *    drill-down is decoration."
 *
 * So every component carries the findings that produced its number, each one
 * locatable — layer, feature, position — and each naming the threshold it was
 * judged against. "Geometry validity: 72" is decoration. "Geometry validity: 72
 * — 14 unclosed rings, worst in layer PLOT feature 12/A at 512340, 2748115" is
 * a work list.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT MAKES THE SCORE HONEST
 *
 * A component that could NOT be evaluated is not scored. It is excluded from
 * the mean, the weights are renormalised over what remained, and it is named in
 * `notEvaluated`.
 *
 * The alternative — scoring an unevaluated component 100 — is the failure mode
 * that makes health scores worthless: a dataset too large for the pairwise
 * topology check would score *higher* than one small enough to check, because
 * the check that would have found its overlaps silently awarded full marks.
 * This is the same discipline `qa/fidelity.ts` applies with `NOT_VALIDATED`: not
 * knowing is a third state, never a pass.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE DEDUCTIONS, NOT A CURVE
 *
 * Each component starts at 100 and loses points per finding, capped. Deductions
 * are proportional to the SHARE of features affected rather than the raw count,
 * because a hundred overlaps in a four-thousand-parcel sheet is a different
 * situation from a hundred in a hundred-and-ten, and a score that cannot tell
 * them apart is telling the user about the size of their data.
 */

import type { CirDataset, CirFeature, Warning } from '../core/cir';
import type { FidelityPrediction } from '../core/predict';
import { featureCount } from '../core/cir';
import { scanDefects, type Defect, type DefectScanOptions } from './defects';
import { checkTopology, DEFAULT_TOPOLOGY_OPTIONS, type TopologyIssue } from './topology';

export type HealthComponentId =
  | 'crs'
  | 'geometry'
  | 'topology'
  | 'duplicates'
  | 'attributes'
  | 'conversion-risk'
  | 'warnings';

export const HEALTH_COMPONENT_LABEL: Record<HealthComponentId, string> = {
  crs: 'CRS certainty',
  geometry: 'Geometry validity',
  topology: 'Topology',
  duplicates: 'Duplicate data',
  attributes: 'Attribute completeness',
  'conversion-risk': 'Conversion risk',
  warnings: 'Unresolved warnings',
};

/**
 * Relative weights.
 *
 * CRS is weighted highest because it is the one defect that makes everything
 * else meaningless: geometry that is perfectly valid in the wrong coordinate
 * system is perfectly valid and in the wrong place. Attribute completeness is
 * weighted lowest because an empty field is often deliberate.
 */
export const HEALTH_WEIGHTS: Record<HealthComponentId, number> = {
  crs: 25,
  geometry: 20,
  topology: 20,
  duplicates: 10,
  attributes: 5,
  'conversion-risk': 12,
  warnings: 8,
};

export interface HealthFinding {
  /** One sentence, with the measured quantity and the threshold in it. */
  message: string;
  severity: 'error' | 'warning' | 'info';
  /** How many features this finding covers. */
  count: number;
  layer?: string;
  featureId?: string | number;
  /** Where to look, when a single position makes sense. */
  location?: number[];
  /** The threshold this was judged against, in the data's own units. */
  tolerance?: number;
}

export interface HealthComponent {
  id: HealthComponentId;
  label: string;
  /** 0–100, or null when the component could not be evaluated. */
  score: number | null;
  weight: number;
  /** How the number was arrived at, in one sentence. */
  method: string;
  /** The exact contributing items. Empty means nothing was found, not "unknown". */
  findings: HealthFinding[];
  /** Set only when `score` is null: why it could not be evaluated. */
  notEvaluatedReason?: string;
}

export type HealthGrade = 'good' | 'fair' | 'poor' | 'unknown';

export interface ProjectHealth {
  /** Weighted mean over EVALUATED components only. Null when none could run. */
  score: number | null;
  grade: HealthGrade;
  components: HealthComponent[];
  /** Component labels that could not be evaluated, for the caveat line. */
  notEvaluated: string[];
  /** Share of the total weight that was actually evaluated, 0–1. */
  coverage: number;
  summary: string;
}

export interface HealthOptions {
  /** Prediction for the chosen target, when one has been chosen. */
  prediction?: FidelityPrediction;
  /** Passed through to the defect scan; its refusals become `notEvaluated`. */
  defects?: Partial<DefectScanOptions>;
  /** Distance below which two vertices count as coincident. */
  tolerance?: number;
}

export function assessHealth(dataset: CirDataset, options: HealthOptions = {}): ProjectHealth {
  const total = featureCount(dataset);
  const components: HealthComponent[] = [
    crsComponent(dataset),
    ...geometryAndTopology(dataset, total, options),
    attributesComponent(dataset, total),
    conversionRiskComponent(options.prediction),
    warningsComponent(dataset.warnings ?? []),
  ];

  const evaluated = components.filter((component) => component.score !== null);
  const weightEvaluated = evaluated.reduce((sum, component) => sum + component.weight, 0);
  const weightAll = components.reduce((sum, component) => sum + component.weight, 0);

  // Renormalised over what actually ran, so an unevaluated component drags the
  // score neither up nor down — it only reduces the coverage, which is stated.
  const score =
    weightEvaluated === 0
      ? null
      : Math.round(evaluated.reduce((sum, component) => sum + component.score! * component.weight, 0) / weightEvaluated);

  const notEvaluated = components.filter((component) => component.score === null).map((component) => component.label);
  const coverage = weightAll === 0 ? 0 : weightEvaluated / weightAll;

  return {
    score,
    grade: gradeFor(score),
    components,
    notEvaluated,
    coverage,
    summary: summarise(score, components, notEvaluated, coverage),
  };
}

function gradeFor(score: number | null): HealthGrade {
  if (score === null) return 'unknown';
  if (score >= 85) return 'good';
  if (score >= 60) return 'fair';
  return 'poor';
}

/**
 * Turns a share of affected features into a deduction.
 *
 * `weight` is the most this finding may ever cost, reached when every feature
 * is affected. The square root makes the first few findings cost more than the
 * last few: going from zero overlaps to five matters more than going from
 * three hundred to three hundred and five, because the first tells you the
 * dataset has a problem and the second tells you how big it already was.
 */
function deduct(affected: number, total: number, weight: number): number {
  if (total <= 0 || affected <= 0) return 0;
  const share = Math.min(1, affected / total);
  return Math.min(weight, weight * Math.sqrt(share));
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

// --------------------------------------------------------------------- CRS

function crsComponent(dataset: CirDataset): HealthComponent {
  const findings: HealthFinding[] = [];
  let score = 100;

  const base: Omit<HealthComponent, 'score' | 'findings'> = {
    id: 'crs',
    label: HEALTH_COMPONENT_LABEL.crs,
    weight: HEALTH_WEIGHTS.crs,
    method: 'From what the file declared, and whether the coordinates are consistent with it.',
  };

  if (!dataset.crs) {
    findings.push({
      message:
        'No coordinate reference system is declared. Every distance, area and overlay depends on it, and a conversion has to guess or refuse.',
      severity: 'error',
      count: 1,
    });
    score -= 60;
  } else {
    switch (dataset.crsOrigin) {
      case 'declared':
      case 'sidecar':
        break;
      case 'user':
        findings.push({
          message: `The CRS ${describeCrs(dataset)} was asserted by you, not declared by the file. If the assertion is wrong the data lands in the wrong place and still looks right.`,
          severity: 'warning',
          count: 1,
        });
        score -= 15;
        break;
      case 'inferred':
        findings.push({
          message: `The CRS ${describeCrs(dataset)} was inferred from the coordinates, not read from the file. Confirm it before delivering.`,
          severity: 'warning',
          count: 1,
        });
        score -= 30;
        break;
      default:
        findings.push({
          message: 'The CRS is not known with any confidence.',
          severity: 'error',
          count: 1,
        });
        score -= 50;
        break;
    }

    if (dataset.crs.kind === 'local') {
      findings.push({
        message: 'The coordinate system is local, so the data cannot be placed on the earth without a transformation nobody has supplied.',
        severity: 'warning',
        count: 1,
      });
      score -= 20;
    }
  }

  // A projected CRS with degree-sized coordinates, or a geographic one with
  // metre-sized coordinates, is the mismatch that silently puts a survey in the
  // Gulf of Guinea. Cheap to check and worth checking every time.
  const mismatch = coordinateRangeMismatch(dataset);
  if (mismatch) {
    findings.push(mismatch);
    score -= 35;
  }

  if (dataset.vertical.kind === 'unknown' && hasZ(dataset)) {
    findings.push({
      message: 'Elevations are present but the vertical datum is not declared, so it is not known whether they are ellipsoidal or orthometric.',
      severity: 'info',
      count: 1,
    });
    score -= 5;
  }

  return { ...base, score: clamp(score), findings };
}

function describeCrs(dataset: CirDataset): string {
  const crs = dataset.crs;
  if (!crs) return 'none';
  return crs.epsg ? `EPSG:${crs.epsg}` : crs.name || 'unnamed';
}

function coordinateRangeMismatch(dataset: CirDataset): HealthFinding | null {
  const crs = dataset.crs;
  if (!crs) return null;

  let maxAbsX = 0;
  let maxAbsY = 0;
  let seen = 0;
  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      const position = firstPosition(feature);
      if (!position) continue;
      maxAbsX = Math.max(maxAbsX, Math.abs(position[0]));
      maxAbsY = Math.max(maxAbsY, Math.abs(position[1]));
      // A sample is enough: this is a magnitude check, not a survey.
      if (++seen >= 500) break;
    }
    if (seen >= 500) break;
  }
  if (seen === 0) return null;

  if (crs.kind === 'geographic' && (maxAbsX > 180 || maxAbsY > 90)) {
    return {
      message: `The CRS is geographic but coordinates reach ${maxAbsX.toFixed(0)}, ${maxAbsY.toFixed(0)} — far outside the ±180 / ±90 degrees a geographic system can hold. These look projected.`,
      severity: 'error',
      count: seen,
    };
  }

  if (crs.kind === 'projected' && maxAbsX <= 180 && maxAbsY <= 90 && maxAbsX > 0) {
    return {
      message: `The CRS is projected but every coordinate fits inside ±180 / ±90. These look like degrees, which would place the data within a few hundred metres of the equator.`,
      severity: 'error',
      count: seen,
    };
  }

  return null;
}

function firstPosition(feature: CirFeature): number[] | null {
  let node: unknown = feature.geometry?.coordinates;
  while (Array.isArray(node) && Array.isArray(node[0])) node = node[0];
  return Array.isArray(node) && typeof node[0] === 'number' ? (node as number[]) : null;
}

function hasZ(dataset: CirDataset): boolean {
  return dataset.layers.some((layer) => layer.features.some((feature) => (feature.geometry?.dimension ?? 2) >= 3));
}

// ------------------------------------------- geometry, topology, duplicates

/**
 * Three components from two scans.
 *
 * `checkTopology` looks at each feature against itself; `scanDefects` looks at
 * features against each other. Running both once and splitting the results is
 * what keeps the cost to one pass rather than three.
 */
function geometryAndTopology(dataset: CirDataset, total: number, options: HealthOptions): HealthComponent[] {
  const tolerance = options.tolerance ?? 0;
  const topology = checkTopology(dataset, { ...DEFAULT_TOPOLOGY_OPTIONS, tolerance });
  const defects = scanDefects(dataset, { ...options.defects, tolerance });

  // --- geometry validity: a feature judged against itself
  const selfIssues = topology.issues.filter((issue) => issue.type !== 'duplicate-feature');
  const geometryFindings = groupTopology(selfIssues);
  const geometry: HealthComponent = {
    id: 'geometry',
    label: HEALTH_COMPONENT_LABEL.geometry,
    weight: HEALTH_WEIGHTS.geometry,
    method: `Each feature checked against itself — ring closure, self-intersection, duplicate vertices, degenerate rings — at a tolerance of ${tolerance}.`,
    score: clamp(100 - geometryFindings.reduce((sum, finding) => sum + deduct(finding.count, total, severityWeight(finding.severity)), 0)),
    findings: geometryFindings,
  };

  // --- topology: features against each other
  const relational = defects.defects.filter((defect) => RELATIONAL_DEFECTS.has(defect.type));
  const shapeDefects = defects.defects.filter((defect) => SHAPE_DEFECTS.has(defect.type));
  // Shape defects are about one feature's geometry, so they belong with
  // geometry validity rather than with topology.
  const shapeFindings = groupDefects(shapeDefects);
  geometry.findings.push(...shapeFindings);
  geometry.score = clamp(
    geometry.score! - shapeFindings.reduce((sum, finding) => sum + deduct(finding.count, total, severityWeight(finding.severity)), 0)
  );

  const topologyComponent: HealthComponent =
    defects.skipped.length > 0 && relational.length === 0
      ? {
          id: 'topology',
          label: HEALTH_COMPONENT_LABEL.topology,
          weight: HEALTH_WEIGHTS.topology,
          method: 'Features checked against each other for overlaps, shared-edge mismatch, crossings and dangles.',
          score: null,
          findings: [],
          // Refused rather than reduced to a subset: an overlap check that
          // silently looked at a tenth of the parcels would report a tenth of
          // the overlaps and call it a clean sheet.
          notEvaluatedReason: defects.skipped.join(' '),
        }
      : {
          id: 'topology',
          label: HEALTH_COMPONENT_LABEL.topology,
          weight: HEALTH_WEIGHTS.topology,
          method: `Features checked against each other at a tolerance of ${defects.tolerance}: overlaps, shared-edge mismatch, nesting, crossings, dangles.`,
          score: clamp(
            100 - groupDefects(relational).reduce((sum, finding) => sum + deduct(finding.count, total, severityWeight(finding.severity)), 0)
          ),
          findings: groupDefects(relational),
        };

  if (defects.skipped.length > 0 && relational.length > 0) {
    topologyComponent.findings.push({
      message: `Some checks did not run: ${defects.skipped.join(' ')}`,
      severity: 'info',
      count: 0,
    });
  }

  // --- duplicates
  const duplicateIssues = topology.issues.filter((issue) => issue.type === 'duplicate-feature');
  const nearDuplicates = defects.defects.filter((defect) => defect.type === 'near-duplicate-geometry');
  const duplicateFindings = [...groupTopology(duplicateIssues), ...groupDefects(nearDuplicates)];
  const duplicates: HealthComponent = {
    id: 'duplicates',
    label: HEALTH_COMPONENT_LABEL.duplicates,
    weight: HEALTH_WEIGHTS.duplicates,
    method: 'Identical features, and geometry that differs by less than the tolerance.',
    score: clamp(100 - duplicateFindings.reduce((sum, finding) => sum + deduct(finding.count, total, 60), 0)),
    findings: duplicateFindings,
  };

  return [geometry, topologyComponent, duplicates];
}

const RELATIONAL_DEFECTS = new Set([
  'polygon-overlap',
  'boundary-mismatch',
  'nested-polygon',
  'crossing-lines',
  'dangling-endpoint',
]);

const SHAPE_DEFECTS = new Set(['sliver-polygon', 'spike', 'bow-tie', 'hole-outside-shell', 'z-anomaly', 'coordinate-outlier']);

/** Most a single finding may deduct, by how serious it is. */
function severityWeight(severity: 'error' | 'warning' | 'info'): number {
  return severity === 'error' ? 55 : severity === 'warning' ? 30 : 8;
}

/**
 * Collapses issues of one type into a single finding.
 *
 * Four hundred unclosed rings is one problem with the drawing, not four hundred
 * problems, and a drill-down listing them individually is one nobody scrolls.
 * The first example keeps its location so the user can go and look.
 */
function groupTopology(issues: TopologyIssue[]): HealthFinding[] {
  const byType = new Map<string, TopologyIssue[]>();
  for (const issue of issues) byType.set(issue.type, [...(byType.get(issue.type) ?? []), issue]);

  return [...byType.entries()].map(([, group]) => ({
    message: group.length === 1 ? group[0].description : `${group.length.toLocaleString()} features: ${group[0].description}`,
    severity: group[0].severity,
    count: group.length,
    layer: group[0].layer,
    featureId: group[0].featureId,
    location: group[0].location,
  }));
}

function groupDefects(defects: Defect[]): HealthFinding[] {
  const byType = new Map<string, Defect[]>();
  for (const defect of defects) byType.set(defect.type, [...(byType.get(defect.type) ?? []), defect]);

  return [...byType.entries()].map(([, group]) => ({
    message: group.length === 1 ? group[0].description : `${group.length.toLocaleString()} found. First: ${group[0].description}`,
    severity: group[0].severity,
    count: group.length,
    layer: group[0].layer,
    featureId: group[0].featureId,
    location: group[0].location,
  }));
}

// ------------------------------------------------------------- attributes

/**
 * Attribute completeness.
 *
 * Deliberately the lowest-weighted component and deliberately never an error:
 * an empty field is very often correct. A parcel with no owner recorded is a
 * parcel whose owner is not recorded, which may be exactly the state of the
 * record. This reports the shape of the table so a missing join is visible,
 * and does not pretend to know what should be there.
 */
function attributesComponent(dataset: CirDataset, total: number): HealthComponent {
  const base: Omit<HealthComponent, 'score' | 'findings'> = {
    id: 'attributes',
    label: HEALTH_COMPONENT_LABEL.attributes,
    weight: HEALTH_WEIGHTS.attributes,
    method: 'Share of values that are empty, per declared field. An empty field is reported, never treated as an error.',
  };

  const fields = dataset.layers.flatMap((layer) => layer.fields.map((field) => ({ layer: layer.name, field: field.name })));
  if (fields.length === 0 || total === 0) {
    return {
      ...base,
      score: null,
      findings: [],
      notEvaluatedReason:
        total === 0
          ? 'There are no features to check.'
          : 'This dataset declares no attribute fields, so there is no completeness to measure.',
    };
  }

  const findings: HealthFinding[] = [];
  let deduction = 0;

  for (const layer of dataset.layers) {
    if (layer.features.length === 0) continue;
    for (const field of layer.fields) {
      let empty = 0;
      for (const feature of layer.features) {
        const value = feature.properties?.[field.name];
        if (value === null || value === undefined || value === '') empty++;
      }
      if (empty === 0) continue;
      const share = empty / layer.features.length;
      // Only worth saying when it is most of the column: a handful of blanks in
      // a survey table is normal and reporting it trains people to ignore this.
      if (share < 0.5) continue;
      findings.push({
        message: `“${field.name}” is empty on ${empty.toLocaleString()} of ${layer.features.length.toLocaleString()} features in ${layer.name} (${Math.round(share * 100)}%).`,
        severity: 'info',
        count: empty,
        layer: layer.name,
      });
      deduction += share * 12;
    }
  }

  return { ...base, score: clamp(100 - deduction), findings };
}

// -------------------------------------------------------- conversion risk

function conversionRiskComponent(prediction: FidelityPrediction | undefined): HealthComponent {
  const base: Omit<HealthComponent, 'score' | 'findings'> = {
    id: 'conversion-risk',
    label: HEALTH_COMPONENT_LABEL['conversion-risk'],
    weight: HEALTH_WEIGHTS['conversion-risk'],
    method: 'What the pre-flight predicts the chosen output format would cost, before it runs.',
  };

  if (!prediction) {
    return {
      ...base,
      score: null,
      findings: [],
      notEvaluatedReason: 'No output format has been chosen, so there is no conversion to assess.',
    };
  }

  const findings: HealthFinding[] = [];
  let score = 100;

  for (const finding of prediction.findings) {
    if (finding.grade === 'green') continue;
    findings.push({
      // The remedy is carried with the statement: a conversion risk the user
      // cannot act on is a reason to stop, and one they can is a decision.
      message: finding.remedy ? `${finding.statement} ${finding.remedy}` : finding.statement,
      severity: finding.grade === 'red' ? 'error' : 'warning',
      count: finding.count ?? 1,
    });
    score -= finding.grade === 'red' ? 30 : 10;
  }

  return { ...base, score: clamp(score), findings };
}

// ------------------------------------------------------------- warnings

function warningsComponent(warnings: Warning[]): HealthComponent {
  const findings: HealthFinding[] = warnings
    .filter((warning) => warning.severity !== 'info')
    .map((warning) => ({
      message: warning.count && warning.count > 1 ? `${warning.message} (×${warning.count})` : warning.message,
      severity: warning.severity === 'error' ? ('error' as const) : ('warning' as const),
      count: warning.count ?? 1,
    }));

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const others = findings.length - errors;

  return {
    id: 'warnings',
    label: HEALTH_COMPONENT_LABEL.warnings,
    weight: HEALTH_WEIGHTS.warnings,
    method: 'Warnings raised while reading the file that nothing has resolved.',
    score: clamp(100 - errors * 25 - others * 8),
    findings,
  };
}

// -------------------------------------------------------------- summary

function summarise(score: number | null, components: HealthComponent[], notEvaluated: string[], coverage: number): string {
  if (score === null) {
    return 'Nothing could be assessed: no component of the health score could be evaluated on this dataset.';
  }

  const worst = components
    .filter((component) => component.score !== null && component.findings.length > 0)
    .sort((left, right) => left.score! - right.score!)[0];

  const grade = gradeFor(score);
  const opening =
    grade === 'good'
      ? `Health ${score}/100.`
      : grade === 'fair'
        ? `Health ${score}/100 — usable, with things to look at.`
        : `Health ${score}/100 — needs attention before this is delivered.`;

  const detail = worst
    ? ` Weakest: ${worst.label} at ${worst.score}, from ${worst.findings.length} finding${worst.findings.length === 1 ? '' : 's'}.`
    : ' Nothing was found against any component that ran.';

  const caveat =
    notEvaluated.length > 0
      ? ` ${notEvaluated.join(' and ')} could not be evaluated, so this score covers ${Math.round(coverage * 100)}% of what it normally would.`
      : '';

  return opening + detail + caveat;
}

/** Findings across every component, worst first, for a single work list. */
export function allFindings(health: ProjectHealth): { component: string; finding: HealthFinding }[] {
  const order = { error: 0, warning: 1, info: 2 };
  return health.components
    .flatMap((component) => component.findings.map((finding) => ({ component: component.label, finding })))
    .sort((left, right) => order[left.finding.severity] - order[right.finding.severity] || right.finding.count - left.finding.count);
}
