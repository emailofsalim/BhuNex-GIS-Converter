/**
 * The geometry defect catalogue (spec §23.1).
 *
 * `topology.ts` checks each feature against itself — is this ring closed, does
 * it cross itself. This module checks features against *each other*, which is
 * where cadastral and mine-survey data actually goes wrong: parcels that
 * overlap, boundaries that nearly but not quite share an edge, contours that
 * cross, lines that stop just short of the junction they were meant to meet.
 *
 * Three rules govern every detector here:
 *
 *  - EVERY DEFECT IS LOCATABLE. Severity, layer, feature id and a position, so
 *    the user can go and look at it. A defect that cannot be found on the
 *    ground is a statistic, not a finding.
 *  - EVERY DEFECT NAMES ITS TOLERANCE. "These parcels overlap" is meaningless
 *    without "by more than 0.01 m". Overlap of a millimetre is survey noise;
 *    overlap of a metre is a boundary dispute. The threshold is always stated
 *    and always the user's to set (R21).
 *  - NOTHING IS REPAIRED HERE. Detection and repair are separate modules on
 *    purpose. A detector that fixed what it found could never be run for
 *    information alone, and legally operative boundaries must be inspectable
 *    without being touched (R18).
 */

import type { Bounds, CirDataset, CirFeature, Position } from '../core/cir';
import { geometryBounds, pointInRing, segmentsIntersect, signedArea } from '../core/geometry';
import { unionAll, type MultiPoly } from '../core/polygon-boolean';
import { SpatialIndex, expandBounds, type IndexedItem } from '../core/spatial-index';

export type DefectType =
  // --- shape of one feature ---
  | 'sliver-polygon'
  | 'spike'
  | 'bow-tie'
  | 'hole-outside-shell'
  | 'z-anomaly'
  | 'coordinate-outlier'
  // --- one feature against another ---
  | 'polygon-overlap'
  | 'boundary-mismatch'
  | 'nested-polygon'
  | 'near-duplicate-geometry'
  | 'crossing-lines'
  | 'dangling-endpoint'
  // --- the coverage as a whole ---
  | 'coverage-gap';

export interface Defect {
  type: DefectType;
  severity: 'error' | 'warning' | 'info';
  layer: string;
  featureId?: string | number;
  /** The second feature, for a defect that is about a relationship. */
  otherLayer?: string;
  otherFeatureId?: string | number;
  /** Where to look. Always set where a single position makes sense. */
  location?: Position;
  /** One sentence, with the measured quantity and the threshold in it. */
  description: string;
  /** What would fix it, in words. Repair itself lives in topology.ts. */
  suggestedRepair?: string;
  detail?: Record<string, unknown>;
}

export interface DefectScanOptions {
  /**
   * Distance below which two positions count as the same point, in the
   * dataset's own units. Everything relational is measured against it.
   */
  tolerance: number;
  /** Area below which a polygon is a sliver, in squared dataset units. */
  sliverAreaThreshold: number;
  /** Thinness below which a polygon is a sliver: 4·pi·area / perimeter². */
  sliverThinnessThreshold: number;
  /** Interior angle, in degrees, below which a vertex is a spike. */
  spikeAngleDegrees: number;
  /**
   * Modified z-score beyond which an elevation is an anomaly.
   *
   * Computed from the median and the median absolute deviation, not the mean
   * and standard deviation. A single transposed decimal — 4123.45 for 412.345 —
   * inflates the standard deviation so far that it drags the threshold past
   * itself and goes unreported. That is the masking effect, and it defeats the
   * one blunder this check exists to catch. 3.5 is the conventional cut-off.
   */
  zAnomalySigma: number;
  /** Cap on features compared pairwise, so a huge layer cannot stall the check. */
  maxPairwiseFeatures: number;
  checkOverlaps: boolean;
  checkBoundaryMismatch: boolean;
  checkNearDuplicates: boolean;
  checkCrossingLines: boolean;
  checkDanglingEndpoints: boolean;
  checkSlivers: boolean;
  checkSpikes: boolean;
  checkZAnomalies: boolean;
  /**
   * Find whole missing parcels inside a coverage, not just gaps along a
   * shared edge.
   *
   * Off by default and it is the one check here with a real cost: it unions
   * every polygon in the layer, which is O(n log n) sweeps rather than a
   * bounded pairwise scan. On a 40,000-parcel sheet that is seconds, not
   * milliseconds, so it is asked for rather than assumed.
   */
  checkCoverageGaps: boolean;
  /**
   * Holes smaller than this are not reported, in squared dataset units.
   *
   * Without it every rounding-level crack between two parcels comes back as a
   * missing parcel and the real one is lost in the noise. The default is one
   * square metre: smaller than any plot and larger than any sliver.
   */
  coverageGapMinArea: number;
}

export const DEFAULT_DEFECT_OPTIONS: DefectScanOptions = {
  // 10 mm: below normal total-station repeatability, so anything larger is a
  // real difference rather than instrument noise.
  tolerance: 0.01,
  sliverAreaThreshold: 0.5,
  sliverThinnessThreshold: 0.02,
  spikeAngleDegrees: 5,
  zAnomalySigma: 3.5,
  maxPairwiseFeatures: 20000,
  checkOverlaps: true,
  checkBoundaryMismatch: true,
  checkNearDuplicates: true,
  checkCrossingLines: true,
  checkDanglingEndpoints: true,
  checkSlivers: true,
  checkSpikes: true,
  checkZAnomalies: true,
  checkCoverageGaps: false,
  coverageGapMinArea: 1,
};

export interface DefectReport {
  defects: Defect[];
  counts: Record<string, number>;
  featuresChecked: number;
  /** Checks that were skipped, and why — never silently reduced. */
  skipped: string[];
  tolerance: number;
}

interface Candidate {
  feature: CirFeature;
  layer: string;
  bounds: Bounds;
}

/** Scans a dataset (or one layer of it) for the relational defect catalogue. */
export function scanDefects(dataset: CirDataset, options: Partial<DefectScanOptions> = {}, layerFilter?: string): DefectReport {
  const settings = { ...DEFAULT_DEFECT_OPTIONS, ...options };
  const defects: Defect[] = [];
  const skipped: string[] = [];

  const candidates: Candidate[] = [];
  for (const layer of dataset.layers) {
    if (layerFilter && layer.name !== layerFilter) continue;
    for (const feature of layer.features) {
      if (!feature.geometry) continue;
      candidates.push({ feature, layer: layer.name, bounds: geometryBounds(feature.geometry) });
    }
  }

  // --- per-feature shape checks -------------------------------------------
  for (const candidate of candidates) {
    if (settings.checkSlivers) defects.push(...findSlivers(candidate, settings));
    if (settings.checkSpikes) defects.push(...findSpikes(candidate, settings));
    defects.push(...findBowTies(candidate));
    defects.push(...findHolesOutsideShell(candidate));
  }

  if (settings.checkZAnomalies) defects.push(...findZAnomalies(candidates, settings));

  // --- pairwise checks -----------------------------------------------------
  if (candidates.length > settings.maxPairwiseFeatures) {
    // Refusing loudly beats running for twenty minutes, and beats silently
    // checking a subset and reporting a clean result that is not.
    skipped.push(
      `Pairwise checks (overlaps, gaps, duplicates, crossings) were skipped: ${candidates.length.toLocaleString()} features exceed the ${settings.maxPairwiseFeatures.toLocaleString()} limit. Run the check on one layer at a time.`
    );
  } else if (candidates.length > 1) {
    const index = new SpatialIndex<Candidate>(
      candidates.map((candidate): IndexedItem<Candidate> => ({ bounds: candidate.bounds, value: candidate }))
    );
    defects.push(...findPairwiseDefects(index, settings));
  }

  if (settings.checkCoverageGaps) {
    const coverage = findCoverageGaps(candidates, settings);
    defects.push(...coverage.defects);
    skipped.push(...coverage.skipped);
  }

  const counts: Record<string, number> = {};
  for (const defect of defects) counts[defect.type] = (counts[defect.type] ?? 0) + 1;

  return { defects, counts, featuresChecked: candidates.length, skipped, tolerance: settings.tolerance };
}

// ---------------------------------------------------------------- shape checks

function ringsOf(feature: CirFeature): Position[][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates as Position[][];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Position[][][]).flat();
  return [];
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

function perimeter(ring: Position[]): number {
  let total = 0;
  for (let index = 1; index < ring.length; index++) total += distance(ring[index - 1], ring[index]);
  return total;
}

function distance(left: Position, right: Position): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

/**
 * A sliver is thin, not merely small.
 *
 * A 0.2 m² survey monument pad is small and perfectly valid; a 0.2 m² strip
 * 40 m long between two parcels is a digitising artefact. The Polsby-Popper
 * ratio 4·pi·area / perimeter² separates them: 1 for a circle, near 0 for a
 * sliver. Testing area alone would flag every small legitimate parcel.
 */
function findSlivers(candidate: Candidate, settings: DefectScanOptions): Defect[] {
  const defects: Defect[] = [];
  for (const polygon of polygonsOf(candidate.feature)) {
    const shell = polygon[0];
    if (!shell || shell.length < 4) continue;
    const area = Math.abs(signedArea(shell));
    const edge = perimeter(shell);
    if (edge <= 0) continue;
    const thinness = (4 * Math.PI * area) / (edge * edge);
    if (thinness < settings.sliverThinnessThreshold && area < settings.sliverAreaThreshold) {
      defects.push({
        type: 'sliver-polygon',
        severity: 'warning',
        layer: candidate.layer,
        featureId: candidate.feature.id,
        location: shell[0],
        description: `Sliver polygon: ${area.toFixed(3)} sq units over a ${edge.toFixed(2)}-unit perimeter (thinness ${thinness.toFixed(4)}, below ${settings.sliverThinnessThreshold}).`,
        suggestedRepair: 'Remove it, or merge it into the adjacent parcel it was split from. Check the source before deleting — a genuine strip of land looks the same to the geometry.',
        detail: { area, perimeter: edge, thinness },
      });
    }
  }
  return defects;
}

/**
 * A spike is a vertex the line runs out to and comes straight back from.
 *
 * Detected by interior angle rather than by distance, because the giveaway is
 * the near-zero turn, not how far the excursion went — a 2 mm spike and a 200 m
 * spike are the same digitising slip.
 */
function findSpikes(candidate: Candidate, settings: DefectScanOptions): Defect[] {
  const defects: Defect[] = [];
  const threshold = (settings.spikeAngleDegrees * Math.PI) / 180;
  const paths = [...ringsOf(candidate.feature), ...linesOf(candidate.feature)];

  for (const path of paths) {
    for (let index = 1; index < path.length - 1; index++) {
      const previous = path[index - 1];
      const vertex = path[index];
      const next = path[index + 1];
      const incoming = [vertex[0] - previous[0], vertex[1] - previous[1]];
      const outgoing = [next[0] - vertex[0], next[1] - vertex[1]];
      const inLength = Math.hypot(incoming[0], incoming[1]);
      const outLength = Math.hypot(outgoing[0], outgoing[1]);
      if (inLength < settings.tolerance || outLength < settings.tolerance) continue;

      // Interior angle at the vertex: pi minus the turn.
      const cosine = (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / (inLength * outLength);
      const turn = Math.acos(Math.max(-1, Math.min(1, cosine)));
      const interior = Math.PI - turn;
      if (interior < threshold) {
        defects.push({
          type: 'spike',
          severity: 'warning',
          layer: candidate.layer,
          featureId: candidate.feature.id,
          location: vertex,
          description: `Spike: the line turns back on itself at ${((interior * 180) / Math.PI).toFixed(1)}°, below the ${settings.spikeAngleDegrees}° threshold.`,
          suggestedRepair: 'Delete the spike vertex. Confirm it is not a genuine feature — a jetty or a survey offset can look identical.',
          detail: { interiorDegrees: (interior * 180) / Math.PI },
        });
      }
    }
  }
  return defects;
}

/**
 * A bow-tie is a ring that crosses itself, splitting into lobes of opposite
 * winding. Reported separately from a plain self-intersection because the area
 * is wrong as well as the shape, so every area-based calculation downstream is
 * already incorrect.
 */
function findBowTies(candidate: Candidate): Defect[] {
  const defects: Defect[] = [];
  for (const ring of ringsOf(candidate.feature)) {
    if (ring.length < 5 || ring.length > 1000) continue;
    let crossings = 0;
    let where: Position | undefined;
    for (let i = 0; i < ring.length - 1 && crossings < 3; i++) {
      for (let j = i + 2; j < ring.length - 1; j++) {
        if (i === 0 && j === ring.length - 2) continue;
        if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) {
          crossings++;
          where ??= ring[i];
          break;
        }
      }
    }
    if (crossings > 0) {
      defects.push({
        type: 'bow-tie',
        severity: 'error',
        layer: candidate.layer,
        featureId: candidate.feature.id,
        location: where,
        description: `Bow-tie: the ring crosses itself, so its computed area (${Math.abs(signedArea(ring)).toFixed(3)} sq units) is not the area it encloses.`,
        suggestedRepair: 'Reorder or split the ring at the crossing. Any area or perimeter already reported from this feature is wrong.',
        detail: { crossings },
      });
    }
  }
  return defects;
}

/** A hole must lie inside its shell; one that does not is a mis-assigned ring. */
function findHolesOutsideShell(candidate: Candidate): Defect[] {
  const defects: Defect[] = [];
  for (const polygon of polygonsOf(candidate.feature)) {
    const [shell, ...holes] = polygon;
    if (!shell) continue;
    for (const hole of holes) {
      if (hole.length === 0) continue;
      const outside = hole.filter((position) => !pointInRing(position, shell)).length;
      if (outside > 0) {
        defects.push({
          type: 'hole-outside-shell',
          severity: 'error',
          layer: candidate.layer,
          featureId: candidate.feature.id,
          location: hole[0],
          description: `Hole outside shell: ${outside} of ${hole.length} hole vertices fall outside the outer ring.`,
          suggestedRepair: 'The ring is probably a separate polygon rather than a hole. Split it out, or re-order the rings.',
          detail: { verticesOutside: outside, holeVertices: hole.length },
        });
      }
    }
  }
  return defects;
}

/**
 * Elevations far from the rest of the dataset.
 *
 * A single mistyped RL — 4123.45 for 412.345 — is the classic survey blunder,
 * and it is invisible in plan view. Reported against the dataset's own spread
 * rather than an absolute range, because a mine bench and a coastal survey have
 * nothing in common except that an outlier stands out from its neighbours.
 */
function findZAnomalies(candidates: Candidate[], settings: DefectScanOptions): Defect[] {
  const values: { z: number; candidate: Candidate; position: Position }[] = [];
  for (const candidate of candidates) {
    eachPositionOf(candidate.feature, (position) => {
      if (position.length >= 3 && Number.isFinite(position[2])) values.push({ z: position[2], candidate, position });
    });
  }
  if (values.length < 8) return [];

  const sorted = values.map((entry) => entry.z).sort((left, right) => left - right);
  const median = percentile(sorted, 0.5);
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
  const mad = percentile(deviations, 0.5);
  // Every value identical, or so nearly so that a scale cannot be estimated.
  // Reporting an "outlier" from a zero spread would be noise, not a finding.
  if (mad === 0) return [];
  // 0.6745 makes the modified z-score comparable to a standard deviation for
  // normally distributed data.
  const scale = mad / 0.6745;

  const defects: Defect[] = [];
  const seen = new Set<string | number | undefined>();
  for (const entry of values) {
    const sigma = Math.abs(entry.z - median) / scale;
    if (sigma < settings.zAnomalySigma) continue;
    // One report per feature: a single bad traverse would otherwise produce
    // hundreds of identical rows and bury everything else.
    const key = entry.candidate.feature.id ?? `${entry.candidate.layer}:${entry.position[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    defects.push({
      type: 'z-anomaly',
      severity: 'warning',
      layer: entry.candidate.layer,
      featureId: entry.candidate.feature.id,
      location: entry.position,
      description: `Elevation ${entry.z.toFixed(3)} is ${sigma.toFixed(1)} robust deviations from the dataset median of ${median.toFixed(3)} — check for a transposed decimal point.`,
      suggestedRepair: 'Verify against the field book. Nothing is corrected automatically: an outlier can be a genuine feature.',
      detail: { z: entry.z, median, sigma },
    });
  }
  return defects;
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const at = (sortedValues.length - 1) * fraction;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return low === high ? sortedValues[low] : sortedValues[low] + (sortedValues[high] - sortedValues[low]) * (at - low);
}

function eachPositionOf(feature: CirFeature, visit: (position: Position) => void): void {
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      visit(value as Position);
      return;
    }
    for (const child of value) walk(child);
  };
  walk(feature.geometry?.coordinates);
}

// ------------------------------------------------------------- pairwise checks

function findPairwiseDefects(index: SpatialIndex<Candidate>, settings: DefectScanOptions): Defect[] {
  const defects: Defect[] = [];

  index.eachCandidatePair((leftIndex, rightIndex) => {
    const left = index.item(leftIndex).value;
    const right = index.item(rightIndex).value;

    const leftPolygons = polygonsOf(left.feature);
    const rightPolygons = polygonsOf(right.feature);
    const leftLines = linesOf(left.feature);
    const rightLines = linesOf(right.feature);

    if (settings.checkNearDuplicates) {
      const duplicate = nearDuplicate(left.feature, right.feature, settings.tolerance);
      if (duplicate) {
        defects.push({
          type: 'near-duplicate-geometry',
          severity: 'warning',
          layer: left.layer,
          featureId: left.feature.id,
          otherLayer: right.layer,
          otherFeatureId: right.feature.id,
          location: duplicate.at,
          description: `Near-duplicate geometry: every vertex matches another feature to within ${settings.tolerance} units (largest difference ${duplicate.maxOffset.toFixed(4)}).`,
          suggestedRepair: 'Keep one. Check the attributes first — duplicated geometry with differing attributes usually means two survey epochs, not a mistake.',
          detail: { maxOffset: duplicate.maxOffset },
        });
        return;
      }
    }

    if (settings.checkOverlaps && leftPolygons.length > 0 && rightPolygons.length > 0) {
      const relation = polygonRelation(leftPolygons, rightPolygons);
      if (relation === 'overlap') {
        defects.push({
          type: 'polygon-overlap',
          severity: 'error',
          layer: left.layer,
          featureId: left.feature.id,
          otherLayer: right.layer,
          otherFeatureId: right.feature.id,
          location: leftPolygons[0][0][0],
          description: 'Polygon overlap: these two parcels share interior area.',
          suggestedRepair: 'Decide which boundary is correct from the source survey, then snap the shared edge. Never resolve a cadastral overlap by geometry alone.',
        });
      } else if (relation === 'contains') {
        defects.push({
          type: 'nested-polygon',
          severity: 'info',
          layer: left.layer,
          featureId: left.feature.id,
          otherLayer: right.layer,
          otherFeatureId: right.feature.id,
          location: rightPolygons[0][0][0],
          description: 'Nested polygon: one parcel lies entirely inside the other and is not recorded as a hole.',
          suggestedRepair: 'If the inner parcel is an exclusion, make it a hole in the outer one. If it is a genuine sub-parcel, nothing needs fixing.',
        });
      }
    }

    if (settings.checkBoundaryMismatch && leftPolygons.length > 0 && rightPolygons.length > 0) {
      const mismatch = boundaryMismatch(leftPolygons, rightPolygons, settings.tolerance);
      if (mismatch) {
        defects.push({
          type: 'boundary-mismatch',
          severity: 'warning',
          layer: left.layer,
          featureId: left.feature.id,
          otherLayer: right.layer,
          otherFeatureId: right.feature.id,
          location: mismatch.at,
          description: `Shared-edge mismatch: boundaries run within ${mismatch.gap.toFixed(4)} units of each other without meeting — a gap or overlap too small to see at plot scale.`,
          suggestedRepair: `Snap the shared edge with a tolerance above ${mismatch.gap.toFixed(4)}. This is the defect that produces slivers when the parcels are later dissolved.`,
          detail: { gap: mismatch.gap },
        });
      }
    }

    if (settings.checkCrossingLines && leftLines.length > 0 && rightLines.length > 0) {
      const crossing = linesCross(leftLines, rightLines, settings.tolerance);
      if (crossing) {
        defects.push({
          type: 'crossing-lines',
          severity: 'warning',
          layer: left.layer,
          featureId: left.feature.id,
          otherLayer: right.layer,
          otherFeatureId: right.feature.id,
          location: crossing,
          description: 'Crossing lines: two lines intersect away from either endpoint, with no node at the crossing.',
          suggestedRepair: 'Split both lines at the intersection if they are meant to connect. Contours that cross indicate a surface error, not a topology one.',
        });
      }
    }
  });

  if (settings.checkDanglingEndpoints) defects.push(...findDanglingEndpoints(index, settings));
  return defects;
}

/**
 * Line endpoints that meet nothing.
 *
 * A road or boundary network is meant to connect. An endpoint sitting 30 mm
 * from another line is a break that no plot will show and every routing,
 * polygonisation or dissolve will fail on.
 */
function findDanglingEndpoints(index: SpatialIndex<Candidate>, settings: DefectScanOptions): Defect[] {
  const defects: Defect[] = [];

  for (let position = 0; position < index.size; position++) {
    const candidate = index.item(position).value;
    const lines = linesOf(candidate.feature);
    if (lines.length === 0) continue;

    for (const line of lines) {
      if (line.length < 2) continue;
      for (const endpoint of [line[0], line[line.length - 1]]) {
        // Searched at the *reporting* radius, not the connection tolerance: the
        // whole point is to find a line that ends near another without meeting
        // it, and a box the width of the tolerance can never contain one.
        const reportRadius = settings.tolerance * 100;
        const query = expandBounds({ minX: endpoint[0], minY: endpoint[1], maxX: endpoint[0], maxY: endpoint[1] }, reportRadius);
        let connected = false;
        let nearest = Infinity;

        for (const neighbourIndex of index.search(query)) {
          const neighbour = index.item(neighbourIndex).value;
          for (const other of linesOf(neighbour.feature)) {
            for (const vertex of other) {
              if (other === line && vertex === endpoint) continue;
              const gap = distance(endpoint, vertex);
              if (gap <= settings.tolerance && !(other === line && (vertex === line[0] || vertex === line[line.length - 1]))) {
                connected = true;
                break;
              }
              if (other !== line && gap < nearest) nearest = gap;
            }
            if (connected) break;
          }
          if (connected) break;
        }

        // Only report a dangle that is *nearly* connected. A line ending in open
        // country is not a defect, and flagging every one would make the check
        // useless on any real dataset.
        if (!connected && Number.isFinite(nearest) && nearest <= reportRadius) {
          defects.push({
            type: 'dangling-endpoint',
            severity: 'warning',
            layer: candidate.layer,
            featureId: candidate.feature.id,
            location: endpoint,
            description: `Unconnected endpoint: the nearest other line is ${nearest.toFixed(4)} units away, beyond the ${settings.tolerance} tolerance but close enough to be intended as a junction.`,
            suggestedRepair: `Snap the endpoint, or extend the line to the junction. Raising the snap tolerance above ${nearest.toFixed(4)} would connect it.`,
            detail: { gap: nearest },
          });
        }
      }
    }
  }
  return defects;
}

function nearDuplicate(left: CirFeature, right: CirFeature, tolerance: number): { at: Position; maxOffset: number } | null {
  if (left.geometry?.type !== right.geometry?.type) return null;
  const leftPositions: Position[] = [];
  const rightPositions: Position[] = [];
  eachPositionOf(left, (position) => leftPositions.push(position));
  eachPositionOf(right, (position) => rightPositions.push(position));
  if (leftPositions.length === 0 || leftPositions.length !== rightPositions.length) return null;

  let maxOffset = 0;
  for (let index = 0; index < leftPositions.length; index++) {
    const offset = distance(leftPositions[index], rightPositions[index]);
    if (offset > tolerance) return null;
    if (offset > maxOffset) maxOffset = offset;
  }
  return { at: leftPositions[0], maxOffset };
}

type PolygonRelation = 'disjoint' | 'overlap' | 'contains' | 'within';

/**
 * Classifies two polygons by edge crossings and point containment.
 *
 * Not a full boolean-overlay engine: it answers whether interiors meet, which
 * is what a topology rule needs, without carrying the cost and the failure
 * modes of computing the intersection itself.
 */
function polygonRelation(left: Position[][][], right: Position[][][]): PolygonRelation {
  const leftShell = left[0]?.[0];
  const rightShell = right[0]?.[0];
  if (!leftShell || !rightShell) return 'disjoint';

  for (let i = 0; i < leftShell.length - 1; i++) {
    for (let j = 0; j < rightShell.length - 1; j++) {
      if (segmentsIntersect(leftShell[i], leftShell[i + 1], rightShell[j], rightShell[j + 1])) return 'overlap';
    }
  }

  // No edges cross, so one is inside the other or they are apart.
  if (rightShell.every((position) => pointInRing(position, leftShell))) return 'contains';
  if (leftShell.every((position) => pointInRing(position, rightShell))) return 'within';
  return 'disjoint';
}

/**
 * Boundaries that run close together without sharing vertices.
 *
 * The cadastral failure that matters: two parcels digitised separately, their
 * common boundary agreeing to a few millimetres. Nothing looks wrong until they
 * are dissolved and a chain of slivers appears along the edge.
 */
function boundaryMismatch(left: Position[][][], right: Position[][][], tolerance: number): { at: Position; gap: number } | null {
  const leftShell = left[0]?.[0];
  const rightShell = right[0]?.[0];
  if (!leftShell || !rightShell) return null;

  // Measured vertex-to-SEGMENT, not vertex-to-vertex. The usual mismatch is one
  // parcel carrying an extra vertex that bulges a few millimetres into the
  // other's straight edge — there is no opposing vertex anywhere near it, so a
  // vertex-to-vertex test finds nothing and the sliver survives to the dissolve.
  const check = (probe: Position[], against: Position[]): { at: Position; gap: number; coincident: number } => {
    let closest = Infinity;
    let at: Position | undefined;
    let coincident = 0;
    for (const position of probe) {
      let best = Infinity;
      for (let index = 0; index < against.length - 1; index++) {
        const gap = pointToSegment(position, against[index], against[index + 1]);
        if (gap < best) best = gap;
      }
      if (best <= tolerance) coincident++;
      else if (best < closest) {
        closest = best;
        at = position;
      }
    }
    return { at: at ?? probe[0], gap: closest, coincident };
  };

  const forward = check(leftShell, rightShell);
  const backward = check(rightShell, leftShell);
  // Two coincident vertices mean a shared *edge* rather than parcels that merely
  // touch at a corner; the near miss alongside them is then a real mismatch.
  for (const result of [forward, backward]) {
    if (result.coincident >= 2 && result.gap > tolerance && result.gap < tolerance * 100) {
      return { at: result.at, gap: result.gap };
    }
  }
  return null;
}

/** Shortest distance from a point to a line segment. */
function pointToSegment(point: Position, start: Position, end: Position): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);
  let t = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

function linesCross(left: Position[][], right: Position[][], tolerance: number): Position | null {
  for (const leftLine of left) {
    for (const rightLine of right) {
      for (let i = 0; i < leftLine.length - 1; i++) {
        for (let j = 0; j < rightLine.length - 1; j++) {
          if (!segmentsIntersect(leftLine[i], leftLine[i + 1], rightLine[j], rightLine[j + 1])) continue;
          // Lines that meet at a shared node are connected, not crossing.
          const endpoints = [leftLine[i], leftLine[i + 1], rightLine[j], rightLine[j + 1]];
          const sharesNode = endpoints.some((position, index) =>
            endpoints.some((other, otherIndex) => index < otherIndex && distance(position, other) <= tolerance)
          );
          if (!sharesNode) return leftLine[i];
        }
      }
    }
  }
  return null;
}

// ------------------------------------------------------------- coverage gaps

/**
 * Finds whole missing parcels inside a coverage.
 *
 * The pairwise checks above compare features two at a time, which finds a gap
 * along a SHARED EDGE and cannot find the other kind: a parcel that was never
 * digitised at all, surrounded by four neighbours that are each perfectly
 * consistent with the three they touch. Nothing pairwise sees it, because the
 * defect is not in any pair — it is in the coverage.
 *
 * Union every polygon in the layer and the answer falls out: a hole in the
 * union is a hole in the coverage. That union has been available in
 * `core/polygon-boolean.ts` since the geometry operations landed, and the
 * README said this check needed "a boolean union this build does not have"
 * for as long as it has had one.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is decide whether a hole is a mistake.
 * A courtyard, a tank, a road reserve and a village pond are all legitimate
 * holes in a cadastral coverage, and telling them apart from an un-digitised
 * plot needs knowledge this tool does not have. So every hole above the area
 * threshold is REPORTED with its area and where to look, and it is reported as
 * a warning rather than an error — the surveyor knows which of them is a pond.
 */
function findCoverageGaps(
  candidates: Candidate[],
  settings: DefectScanOptions
): { defects: Defect[]; skipped: string[] } {
  const defects: Defect[] = [];
  const skipped: string[] = [];

  const byLayer = new Map<string, Position[][][]>();
  for (const candidate of candidates) {
    const polygons = polygonsOf(candidate.feature);
    if (polygons.length === 0) continue;
    const list = byLayer.get(candidate.layer) ?? [];
    for (const polygon of polygons) list.push(polygon);
    byLayer.set(candidate.layer, list);
  }

  for (const [layer, polygons] of byLayer) {
    // One polygon cannot have a coverage gap: any hole in it is its own hole,
    // already reported by the shape checks if it is malformed.
    if (polygons.length < 2) continue;

    if (polygons.length > COVERAGE_UNION_LIMIT) {
      skipped.push(
        `Coverage gaps were not checked on "${layer}": ${polygons.length.toLocaleString()} polygons exceed the ${COVERAGE_UNION_LIMIT.toLocaleString()} limit for a union. Check it one block at a time.`
      );
      continue;
    }

    let united;
    try {
      united = unionAll(polygons.map((polygon) => [polygon] as MultiPoly));
    } catch {
      // A union that fails on degenerate input must not take the whole scan
      // with it — every other defect found is still worth reporting.
      skipped.push(`Coverage gaps could not be computed on "${layer}": the polygons could not be unioned.`);
      continue;
    }

    for (const polygon of united.polygons) {
      // Ring 0 is the shell; everything after it is a hole in the coverage.
      for (let index = 1; index < polygon.length; index++) {
        const hole = polygon[index];
        const area = Math.abs(signedArea(hole));
        if (area < settings.coverageGapMinArea) continue;

        defects.push({
          type: 'coverage-gap',
          // A warning, not an error: a courtyard and a missing plot are the
          // same shape, and only the surveyor knows which this is.
          severity: 'warning',
          layer,
          location: representativePoint(hole),
          description: `Coverage gap of ${area.toFixed(2)} square units enclosed by the parcels in "${layer}" — an area no polygon covers.`,
          suggestedRepair:
            'Check whether a parcel is missing here. A courtyard, tank, road reserve or pond is a legitimate hole and needs no action; an un-digitised plot does.',
          detail: { area, vertices: hole.length },
        });
      }
    }
  }

  return { defects, skipped };
}

/**
 * A point guaranteed to be inside the ring, for "where to look".
 *
 * The centroid is not good enough — the centroid of a C-shaped or crescent gap
 * falls outside it, which sends the user to a neighbouring parcel. This walks
 * the horizontal line through the ring's mid-latitude and takes the midpoint of
 * its widest interior span, which is inside by construction.
 */
function representativePoint(ring: Position[]): Position {
  const ys = ring.map((position) => position[1]);
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;

  const crossings: number[] = [];
  for (let index = 1; index < ring.length; index++) {
    const [x1, y1] = ring[index - 1];
    const [x2, y2] = ring[index];
    if (y1 === y2) continue;
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
      crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
  }
  crossings.sort((a, b) => a - b);

  let bestX = ring[0][0];
  let widest = -1;
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    const span = crossings[index + 1] - crossings[index];
    if (span > widest) {
      widest = span;
      bestX = (crossings[index] + crossings[index + 1]) / 2;
    }
  }
  return [bestX, y];
}

/**
 * Above this many polygons the union is refused rather than attempted.
 *
 * A sweep over a very large coverage is minutes, not seconds, and a check that
 * appears to hang is worse than one that says it will not run.
 */
const COVERAGE_UNION_LIMIT = 5000;
