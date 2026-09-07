/**
 * Configurable topology rules (spec §23.2).
 *
 * The defect catalogue in `defects.ts` answers "what is wrong with this data?".
 * A rule answers a different question: "does this data satisfy the standard it
 * is supposed to meet?" — must not overlap, must be within, lines must connect.
 * The distinction matters because a rule is a *specification the user asserts*,
 * so a violation is a failure against their intent rather than a suspicion
 * raised by a heuristic.
 *
 * Scope is part of every rule (spec §23.2, last line). A surveyor fixing one
 * disputed boundary must be able to run "must not overlap" on that parcel alone
 * and get two violations, not four thousand. Forcing whole-dataset evaluation is
 * how tools push people into global repairs they never wanted (R18).
 */

import type { CirDataset, CirFeature, Position } from '../core/cir';
import { geometryBounds, pointInRing, segmentsIntersect } from '../core/geometry';
import { SpatialIndex, expandBounds, type IndexedItem } from '../core/spatial-index';

export type TopologyRuleId =
  | 'must-not-overlap'
  | 'must-not-have-gaps'
  | 'must-contain'
  | 'must-be-within'
  | 'must-touch'
  | 'must-be-covered-by'
  | 'must-not-self-intersect'
  | 'shared-boundaries-must-match'
  | 'lines-must-connect'
  | 'polygons-must-close';

export const RULE_LABEL: Record<TopologyRuleId, string> = {
  'must-not-overlap': 'Must not overlap',
  'must-not-have-gaps': 'Must not have gaps',
  'must-contain': 'Must contain',
  'must-be-within': 'Must be within',
  'must-touch': 'Must touch',
  'must-be-covered-by': 'Must be covered by',
  'must-not-self-intersect': 'Must not self-intersect',
  'shared-boundaries-must-match': 'Shared boundaries must match',
  'lines-must-connect': 'Lines must connect',
  'polygons-must-close': 'Polygons must close',
};

/** Rules that compare one layer against a second one. */
export const RELATIONAL_RULES: TopologyRuleId[] = ['must-contain', 'must-be-within', 'must-touch', 'must-be-covered-by'];

export type RuleScope =
  | { kind: 'dataset' }
  | { kind: 'layer'; layer: string }
  | { kind: 'features'; layer: string; featureIds: (string | number)[] };

export interface TopologyRule {
  id: TopologyRuleId;
  /** The layer the rule is asserted about. */
  layer: string;
  /** The second layer, for a relational rule. */
  againstLayer?: string;
  /** Distance below which two positions are the same point, in dataset units. */
  tolerance: number;
}

export interface RuleViolation {
  ruleId: TopologyRuleId;
  severity: 'error' | 'warning';
  layer: string;
  featureId?: string | number;
  otherLayer?: string;
  otherFeatureId?: string | number;
  location?: Position;
  description: string;
  suggestedRepair?: string;
}

export interface RuleResult {
  rule: TopologyRule;
  /** True when every feature in scope satisfies the rule. */
  passed: boolean;
  featuresChecked: number;
  violations: RuleViolation[];
  /** Set when the rule could not be evaluated, with the reason. */
  notEvaluated?: string;
}

interface ScopedFeature {
  feature: CirFeature;
  layer: string;
}

function collect(dataset: CirDataset, layerName: string, scope: RuleScope): ScopedFeature[] {
  const layer = dataset.layers.find((entry) => entry.name === layerName);
  if (!layer) return [];
  let features = layer.features;
  if (scope.kind === 'features' && scope.layer === layerName) {
    const wanted = new Set(scope.featureIds.map(String));
    features = features.filter((feature) => wanted.has(String(feature.id)));
  }
  return features.filter((feature) => feature.geometry).map((feature) => ({ feature, layer: layerName }));
}

function polygonsOf(feature: CirFeature): Position[][][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates as Position[][]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as Position[][][];
  return [];
}

function linesOf(feature: CirFeature): Position[][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates as Position[]];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as Position[][];
  return [];
}

function pointsOf(feature: CirFeature): Position[] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'Point') return [geometry.coordinates as Position];
  if (geometry.type === 'MultiPoint') return geometry.coordinates as Position[];
  return [];
}

function distance(left: Position, right: Position): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function indexOf(features: ScopedFeature[]): SpatialIndex<ScopedFeature> {
  return new SpatialIndex<ScopedFeature>(
    features.map((entry): IndexedItem<ScopedFeature> => ({ bounds: geometryBounds(entry.feature.geometry), value: entry }))
  );
}

/** Runs one rule over the requested scope. */
export function evaluateRule(dataset: CirDataset, rule: TopologyRule, scope: RuleScope = { kind: 'dataset' }): RuleResult {
  const subject = collect(dataset, rule.layer, scope);
  const base: RuleResult = { rule, passed: true, featuresChecked: subject.length, violations: [] };

  if (subject.length === 0) {
    return { ...base, notEvaluated: `Layer "${rule.layer}" holds no geometry in this scope.` };
  }
  if (RELATIONAL_RULES.includes(rule.id) && !rule.againstLayer) {
    return { ...base, notEvaluated: `"${RULE_LABEL[rule.id]}" needs a second layer to compare against.` };
  }

  const against = rule.againstLayer ? collect(dataset, rule.againstLayer, { kind: 'dataset' }) : [];
  if (RELATIONAL_RULES.includes(rule.id) && against.length === 0) {
    return { ...base, notEvaluated: `Layer "${rule.againstLayer}" holds no geometry to compare against.` };
  }

  const violations = evaluate(rule, subject, against);
  return { ...base, passed: violations.length === 0, violations };
}

export function evaluateRules(dataset: CirDataset, rules: TopologyRule[], scope: RuleScope = { kind: 'dataset' }): RuleResult[] {
  return rules.map((rule) => evaluateRule(dataset, rule, scope));
}

function evaluate(rule: TopologyRule, subject: ScopedFeature[], against: ScopedFeature[]): RuleViolation[] {
  switch (rule.id) {
    case 'must-not-overlap':
      return mustNotOverlap(rule, subject);
    case 'must-not-self-intersect':
      return mustNotSelfIntersect(rule, subject);
    case 'polygons-must-close':
      return polygonsMustClose(rule, subject);
    case 'lines-must-connect':
      return linesMustConnect(rule, subject);
    case 'shared-boundaries-must-match':
      return sharedBoundariesMustMatch(rule, subject);
    case 'must-not-have-gaps':
      return mustNotHaveGaps(rule, subject);
    case 'must-be-within':
    case 'must-be-covered-by':
      return mustBeWithin(rule, subject, against);
    case 'must-contain':
      return mustContain(rule, subject, against);
    case 'must-touch':
      return mustTouch(rule, subject, against);
    default:
      return [];
  }
}

function mustNotOverlap(rule: TopologyRule, subject: ScopedFeature[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const index = indexOf(subject);
  index.eachCandidatePair((leftIndex, rightIndex) => {
    const left = index.item(leftIndex).value;
    const right = index.item(rightIndex).value;
    const leftShell = polygonsOf(left.feature)[0]?.[0];
    const rightShell = polygonsOf(right.feature)[0]?.[0];
    if (!leftShell || !rightShell) return;

    if (ringsShareInterior(leftShell, rightShell)) {
      violations.push({
        ruleId: rule.id,
        severity: 'error',
        layer: left.layer,
        featureId: left.feature.id,
        otherLayer: right.layer,
        otherFeatureId: right.feature.id,
        location: leftShell[0],
        description: 'These two polygons share interior area.',
        suggestedRepair:
          'Establish which boundary the source survey supports, then snap the shared edge to it. A cadastral overlap is a legal question before it is a geometry one.',
      });
    }
  });
  return violations;
}

function ringsShareInterior(left: Position[], right: Position[]): boolean {
  for (let i = 0; i < left.length - 1; i++) {
    for (let j = 0; j < right.length - 1; j++) {
      if (segmentsIntersect(left[i], left[i + 1], right[j], right[j + 1])) return true;
    }
  }
  // No crossings: containment still counts as shared interior.
  return right.every((position) => pointInRing(position, left)) || left.every((position) => pointInRing(position, right));
}

function mustNotSelfIntersect(rule: TopologyRule, subject: ScopedFeature[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  for (const entry of subject) {
    const paths = [...polygonsOf(entry.feature).flat(), ...linesOf(entry.feature)];
    for (const path of paths) {
      if (path.length > 2000) continue;
      let found: Position | null = null;
      for (let i = 0; i < path.length - 1 && !found; i++) {
        for (let j = i + 2; j < path.length - 1; j++) {
          if (i === 0 && j === path.length - 2) continue;
          if (segmentsIntersect(path[i], path[i + 1], path[j], path[j + 1])) {
            found = path[i];
            break;
          }
        }
      }
      if (found) {
        violations.push({
          ruleId: rule.id,
          severity: 'error',
          layer: entry.layer,
          featureId: entry.feature.id,
          location: found,
          description: 'The geometry crosses itself.',
          suggestedRepair: 'Split the ring at the crossing, or reorder the vertices. Any area computed from it is currently wrong.',
        });
        break;
      }
    }
  }
  return violations;
}

function polygonsMustClose(rule: TopologyRule, subject: ScopedFeature[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  for (const entry of subject) {
    for (const polygon of polygonsOf(entry.feature)) {
      for (const ring of polygon) {
        if (ring.length < 3) continue;
        const gap = distance(ring[0], ring[ring.length - 1]);
        if (gap > rule.tolerance) {
          violations.push({
            ruleId: rule.id,
            severity: 'error',
            layer: entry.layer,
            featureId: entry.feature.id,
            location: ring[ring.length - 1],
            description: `The ring does not close: first and last vertices are ${gap.toFixed(4)} units apart, beyond the ${rule.tolerance} tolerance.`,
            suggestedRepair: `Close the ring. The gap is ${gap.toFixed(4)} units — confirm that is a digitising error and not a genuinely open boundary.`,
          });
        }
      }
    }
  }
  return violations;
}

function linesMustConnect(rule: TopologyRule, subject: ScopedFeature[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const index = indexOf(subject);

  for (let position = 0; position < index.size; position++) {
    const entry = index.item(position).value;
    for (const line of linesOf(entry.feature)) {
      if (line.length < 2) continue;
      for (const endpoint of [line[0], line[line.length - 1]]) {
        const query = expandBounds({ minX: endpoint[0], minY: endpoint[1], maxX: endpoint[0], maxY: endpoint[1] }, rule.tolerance);
        let connected = false;
        for (const neighbourIndex of index.search(query)) {
          if (neighbourIndex === position) continue;
          const neighbour = index.item(neighbourIndex).value;
          for (const other of linesOf(neighbour.feature)) {
            if (other.some((vertex) => distance(endpoint, vertex) <= rule.tolerance)) {
              connected = true;
              break;
            }
          }
          if (connected) break;
        }
        if (!connected) {
          violations.push({
            ruleId: rule.id,
            severity: 'warning',
            layer: entry.layer,
            featureId: entry.feature.id,
            location: endpoint,
            description: `Endpoint connects to nothing within ${rule.tolerance} units.`,
            suggestedRepair: 'Snap the endpoint to the line it should join, or extend it to the junction.',
          });
        }
      }
    }
  }
  return violations;
}

function sharedBoundariesMustMatch(rule: TopologyRule, subject: ScopedFeature[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const index = indexOf(subject);

  index.eachCandidatePair((leftIndex, rightIndex) => {
    const left = index.item(leftIndex).value;
    const right = index.item(rightIndex).value;
    const leftShell = polygonsOf(left.feature)[0]?.[0];
    const rightShell = polygonsOf(right.feature)[0]?.[0];
    if (!leftShell || !rightShell) return;

    let shared = 0;
    let nearMiss: { at: Position; gap: number } | null = null;
    for (const position of leftShell) {
      let best = Infinity;
      for (const other of rightShell) {
        const gap = distance(position, other);
        if (gap < best) best = gap;
      }
      if (best <= rule.tolerance) shared++;
      else if (best < rule.tolerance * 100 && (!nearMiss || best < nearMiss.gap)) nearMiss = { at: position, gap: best };
    }

    // Two coincident vertices mean a shared edge rather than a touching corner,
    // so a near miss alongside them is a mismatch rather than two separate
    // boundaries that happen to run close.
    if (shared >= 2 && nearMiss) {
      violations.push({
        ruleId: rule.id,
        severity: 'error',
        layer: left.layer,
        featureId: left.feature.id,
        otherLayer: right.layer,
        otherFeatureId: right.feature.id,
        location: nearMiss.at,
        description: `Shared boundary does not match: vertices coincide elsewhere but diverge by ${nearMiss.gap.toFixed(4)} units here.`,
        suggestedRepair: `Snap the shared edge with a tolerance above ${nearMiss.gap.toFixed(4)}. Left as is, dissolving these parcels will produce a sliver.`,
      });
    }
  });
  return violations;
}

/**
 * Gaps between polygons that are meant to form a continuous coverage.
 *
 * Detected as boundaries running near each other without meeting, not by
 * computing the union and looking for holes. That is a real limitation and it
 * is stated in the violation text: this finds the sliver-gap along a shared
 * edge, which is the one that actually occurs in cadastral data, and does not
 * find an entire missing parcel in the middle of a coverage.
 */
function mustNotHaveGaps(rule: TopologyRule, subject: ScopedFeature[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const index = indexOf(subject);

  index.eachCandidatePair((leftIndex, rightIndex) => {
    const left = index.item(leftIndex).value;
    const right = index.item(rightIndex).value;
    const leftShell = polygonsOf(left.feature)[0]?.[0];
    const rightShell = polygonsOf(right.feature)[0]?.[0];
    if (!leftShell || !rightShell) return;

    let closest = Infinity;
    let at: Position | undefined;
    for (const position of leftShell) {
      for (const other of rightShell) {
        const gap = distance(position, other);
        if (gap < closest) {
          closest = gap;
          at = position;
        }
      }
    }

    if (at && closest > rule.tolerance && closest < rule.tolerance * 50) {
      violations.push({
        ruleId: rule.id,
        severity: 'warning',
        layer: left.layer,
        featureId: left.feature.id,
        otherLayer: right.layer,
        otherFeatureId: right.feature.id,
        location: at,
        description: `Gap of ${closest.toFixed(4)} units between adjacent polygons, beyond the ${rule.tolerance} tolerance.`,
        suggestedRepair:
          'Snap the shared edge. Note this rule finds gaps along adjacent boundaries; it does not find a whole missing parcel inside a coverage.',
      });
    }
  });
  return violations;
}

function mustBeWithin(rule: TopologyRule, subject: ScopedFeature[], against: ScopedFeature[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const containerIndex = indexOf(against);

  for (const entry of subject) {
    const positions = [...pointsOf(entry.feature), ...polygonsOf(entry.feature).flat().flat(), ...linesOf(entry.feature).flat()];
    if (positions.length === 0) continue;
    const bounds = geometryBounds(entry.feature.geometry);

    let inside = false;
    for (const candidateIndex of containerIndex.search(expandBounds(bounds, rule.tolerance))) {
      const container = containerIndex.item(candidateIndex).value;
      const shell = polygonsOf(container.feature)[0]?.[0];
      if (!shell) continue;
      if (positions.every((position) => pointInRing(position, shell))) {
        inside = true;
        break;
      }
    }

    if (!inside) {
      violations.push({
        ruleId: rule.id,
        severity: 'error',
        layer: entry.layer,
        featureId: entry.feature.id,
        otherLayer: rule.againstLayer,
        location: positions[0],
        description: `Not contained by any polygon in "${rule.againstLayer}".`,
        suggestedRepair: 'Check the coordinate system of both layers first — a feature outside its container is far more often a CRS mismatch than a survey error.',
      });
    }
  }
  return violations;
}

function mustContain(rule: TopologyRule, subject: ScopedFeature[], against: ScopedFeature[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const contentIndex = indexOf(against);

  for (const entry of subject) {
    const shell = polygonsOf(entry.feature)[0]?.[0];
    if (!shell) continue;
    const bounds = geometryBounds(entry.feature.geometry);
    let holds = false;

    for (const candidateIndex of contentIndex.search(bounds)) {
      const content = contentIndex.item(candidateIndex).value;
      const positions = [...pointsOf(content.feature), ...polygonsOf(content.feature).flat().flat(), ...linesOf(content.feature).flat()];
      if (positions.length > 0 && positions.every((position) => pointInRing(position, shell))) {
        holds = true;
        break;
      }
    }

    if (!holds) {
      violations.push({
        ruleId: rule.id,
        severity: 'warning',
        layer: entry.layer,
        featureId: entry.feature.id,
        otherLayer: rule.againstLayer,
        location: shell[0],
        description: `Contains no feature from "${rule.againstLayer}".`,
        suggestedRepair: 'Either the expected feature is missing, or it was digitised outside the boundary.',
      });
    }
  }
  return violations;
}

function mustTouch(rule: TopologyRule, subject: ScopedFeature[], against: ScopedFeature[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const otherIndex = indexOf(against);

  for (const entry of subject) {
    const positions = [...pointsOf(entry.feature), ...polygonsOf(entry.feature).flat().flat(), ...linesOf(entry.feature).flat()];
    if (positions.length === 0) continue;
    const bounds = expandBounds(geometryBounds(entry.feature.geometry), rule.tolerance);
    let touches = false;

    for (const candidateIndex of otherIndex.search(bounds)) {
      const other = otherIndex.item(candidateIndex).value;
      const otherPositions = [...pointsOf(other.feature), ...polygonsOf(other.feature).flat().flat(), ...linesOf(other.feature).flat()];
      if (positions.some((position) => otherPositions.some((candidate) => distance(position, candidate) <= rule.tolerance))) {
        touches = true;
        break;
      }
    }

    if (!touches) {
      violations.push({
        ruleId: rule.id,
        severity: 'warning',
        layer: entry.layer,
        featureId: entry.feature.id,
        otherLayer: rule.againstLayer,
        location: positions[0],
        description: `Does not touch any feature in "${rule.againstLayer}" within ${rule.tolerance} units.`,
        suggestedRepair: 'Snap it to the feature it should meet, or raise the tolerance if the separation is within survey accuracy.',
      });
    }
  }
  return violations;
}
