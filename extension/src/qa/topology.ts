/**
 * Topology validation and repair.
 *
 * Repair defaults to OFF everywhere (instruction §8.4). Survey data is legal
 * evidence; a tool that quietly closes a ring or snaps a vertex has changed a
 * boundary. Enabling repair is a deliberate act and every change it makes is
 * counted and reported.
 */

import { warn, type CirDataset, type CirFeature, type Position, type Warning } from '../core/cir';
import { closeRing, isClockwise, removeDuplicateVertices, segmentsIntersect, signedArea } from '../core/geometry';

export type TopologyIssueType =
  | 'self-intersection'
  | 'duplicate-vertex'
  | 'zero-length-segment'
  | 'unclosed-ring'
  | 'ring-orientation'
  | 'degenerate-ring'
  | 'duplicate-feature'
  | 'null-geometry';

export interface TopologyIssue {
  type: TopologyIssueType;
  severity: 'error' | 'warning' | 'info';
  featureId: string | number | undefined;
  layer: string;
  description: string;
  location?: Position;
}

export interface TopologyReport {
  issues: TopologyIssue[];
  counts: Record<TopologyIssueType, number>;
  featuresChecked: number;
}

function emptyCounts(): Record<TopologyIssueType, number> {
  return {
    'self-intersection': 0,
    'duplicate-vertex': 0,
    'zero-length-segment': 0,
    'unclosed-ring': 0,
    'ring-orientation': 0,
    'degenerate-ring': 0,
    'duplicate-feature': 0,
    'null-geometry': 0,
  };
}

/** Rings for a feature, whatever its geometry type. */
function ringsOf(feature: CirFeature): Position[][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates as Position[][];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Position[][][]).flat();
  return [];
}

function linesOf(feature: CirFeature): Position[][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates as Position[]];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as Position[][];
  return [];
}

/**
 * Brute-force self-intersection test, skipping adjacent segments (which share a
 * vertex by construction). Capped because the check is O(n²): a 50,000-vertex
 * contour would otherwise stall the worker, and the cap is reported rather than
 * silently reducing the check.
 */
const SELF_INTERSECTION_VERTEX_CAP = 2000;

function findSelfIntersection(ring: Position[]): { at: Position; capped: boolean } | { at: null; capped: boolean } {
  const capped = ring.length > SELF_INTERSECTION_VERTEX_CAP;
  const limit = Math.min(ring.length - 1, SELF_INTERSECTION_VERTEX_CAP);
  for (let i = 0; i < limit; i++) {
    for (let j = i + 2; j < limit; j++) {
      // The first and last segments of a closed ring legitimately touch.
      if (i === 0 && j === limit - 1) continue;
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return { at: ring[i], capped };
    }
  }
  return { at: null, capped };
}

export interface TopologyOptions {
  checkSelfIntersection: boolean;
  checkDuplicateVertices: boolean;
  checkRingClosure: boolean;
  checkRingOrientation: boolean;
  checkDuplicateFeatures: boolean;
  /** Distance below which two vertices count as duplicates, in dataset units. */
  tolerance: number;
}

export const DEFAULT_TOPOLOGY_OPTIONS: TopologyOptions = {
  checkSelfIntersection: true,
  checkDuplicateVertices: true,
  checkRingClosure: true,
  checkRingOrientation: false,
  checkDuplicateFeatures: true,
  tolerance: 0,
};

export function checkTopology(dataset: CirDataset, options: TopologyOptions = DEFAULT_TOPOLOGY_OPTIONS): TopologyReport {
  const issues: TopologyIssue[] = [];
  const counts = emptyCounts();
  let featuresChecked = 0;
  let cappedFeatures = 0;

  const record = (issue: TopologyIssue): void => {
    issues.push(issue);
    counts[issue.type]++;
  };

  const seenGeometries = new Map<string, string | number | undefined>();

  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      featuresChecked++;
      if (!feature.geometry) {
        record({ type: 'null-geometry', severity: 'warning', featureId: feature.id, layer: layer.name, description: 'Feature has no geometry.' });
        continue;
      }

      if (options.checkDuplicateFeatures) {
        // Hash on rounded coordinates so numerically identical geometry matches
        // regardless of how each writer formatted it.
        const key = JSON.stringify(feature.geometry.coordinates, (_, value) =>
          typeof value === 'number' ? Number(value.toFixed(9)) : value
        );
        const previous = seenGeometries.get(key);
        if (previous !== undefined) {
          record({
            type: 'duplicate-feature',
            severity: 'warning',
            featureId: feature.id,
            layer: layer.name,
            description: `Geometry is identical to feature ${previous}.`,
          });
        } else {
          seenGeometries.set(key, feature.id);
        }
      }

      const parts = [...ringsOf(feature), ...linesOf(feature)];
      const isPolygon = ringsOf(feature).length > 0;

      for (const [ringIndex, ring] of parts.entries()) {
        if (options.checkDuplicateVertices) {
          const deduplicated = removeDuplicateVertices(ring, options.tolerance);
          if (deduplicated.length < ring.length) {
            record({
              type: options.tolerance > 0 ? 'duplicate-vertex' : 'zero-length-segment',
              severity: 'warning',
              featureId: feature.id,
              layer: layer.name,
              description: `${ring.length - deduplicated.length} consecutive duplicate vertex/vertices in part ${ringIndex + 1}.`,
              location: ring[0],
            });
          }
        }

        if (isPolygon) {
          if (ring.length < 4) {
            record({
              type: 'degenerate-ring',
              severity: 'error',
              featureId: feature.id,
              layer: layer.name,
              description: `Ring ${ringIndex + 1} has ${ring.length} vertices; a closed ring needs at least four.`,
              location: ring[0],
            });
            continue;
          }
          if (options.checkRingClosure) {
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
              record({
                type: 'unclosed-ring',
                severity: 'error',
                featureId: feature.id,
                layer: layer.name,
                description: `Ring ${ringIndex + 1} does not close: first (${first[0]}, ${first[1]}) ≠ last (${last[0]}, ${last[1]}).`,
                location: last,
              });
            }
          }
          if (options.checkRingOrientation) {
            // Exterior rings are expected counter-clockwise (RFC 7946); the
            // Shapefile writer re-orients on its own.
            const clockwise = isClockwise(ring);
            if ((ringIndex === 0) === clockwise) {
              record({
                type: 'ring-orientation',
                severity: 'info',
                featureId: feature.id,
                layer: layer.name,
                description: `Ring ${ringIndex + 1} is ${clockwise ? 'clockwise' : 'counter-clockwise'}; ${ringIndex === 0 ? 'exterior rings are expected counter-clockwise' : 'interior rings are expected clockwise'}.`,
              });
            }
          }
        }

        if (options.checkSelfIntersection && ring.length >= 4) {
          const found = findSelfIntersection(ring);
          if (found.capped) cappedFeatures++;
          if (found.at) {
            record({
              type: 'self-intersection',
              severity: 'error',
              featureId: feature.id,
              layer: layer.name,
              description: `Part ${ringIndex + 1} intersects itself.`,
              location: found.at,
            });
          }
        }
      }
    }
  }

  if (cappedFeatures > 0) {
    issues.push({
      type: 'self-intersection',
      severity: 'info',
      featureId: undefined,
      layer: '',
      description: `Self-intersection checking was limited to the first ${SELF_INTERSECTION_VERTEX_CAP.toLocaleString()} vertices on ${cappedFeatures} large part(s); the test is quadratic and would otherwise stall on dense contours.`,
    });
  }

  return { issues, counts, featuresChecked };
}

export interface RepairOptions {
  removeDuplicateVertices: boolean;
  closeRings: boolean;
  normalizeRingOrientation: boolean;
  removeDuplicateFeatures: boolean;
  /** Snap vertices closer than this together, in dataset units. 0 disables. */
  snapTolerance: number;
}

/** Every repair is off by default — see the module note. */
export const DEFAULT_REPAIR_OPTIONS: RepairOptions = {
  removeDuplicateVertices: false,
  closeRings: false,
  normalizeRingOrientation: false,
  removeDuplicateFeatures: false,
  snapTolerance: 0,
};

export function repairTopology(dataset: CirDataset, options: RepairOptions): { dataset: CirDataset; warnings: Warning[] } {
  const anyEnabled =
    options.removeDuplicateVertices ||
    options.closeRings ||
    options.normalizeRingOrientation ||
    options.removeDuplicateFeatures ||
    options.snapTolerance > 0;
  if (!anyEnabled) return { dataset, warnings: [] };

  const warnings: Warning[] = [];
  let verticesRemoved = 0;
  let ringsClosed = 0;
  let ringsReoriented = 0;
  let featuresRemoved = 0;

  const repairRing = (ring: Position[], isExterior: boolean, polygon: boolean): Position[] => {
    let out = ring;
    if (options.removeDuplicateVertices || options.snapTolerance > 0) {
      const before = out.length;
      out = removeDuplicateVertices(out, options.snapTolerance);
      verticesRemoved += before - out.length;
    }
    if (polygon && options.closeRings) {
      const before = out.length;
      out = closeRing(out);
      if (out.length > before) ringsClosed++;
    }
    if (polygon && options.normalizeRingOrientation && out.length >= 4) {
      // RFC 7946: exterior counter-clockwise, interior clockwise.
      const wantClockwise = !isExterior;
      if (isClockwise(out) !== wantClockwise) {
        out = [...out].reverse();
        ringsReoriented++;
      }
    }
    return out;
  };

  const seen = new Set<string>();
  const layers = dataset.layers.map((layer) => {
    const features: CirFeature[] = [];
    for (const feature of layer.features) {
      if (options.removeDuplicateFeatures && feature.geometry) {
        const key = JSON.stringify(feature.geometry.coordinates, (_, value) =>
          typeof value === 'number' ? Number(value.toFixed(9)) : value
        );
        if (seen.has(key)) {
          featuresRemoved++;
          continue;
        }
        seen.add(key);
      }

      const geometry = feature.geometry;
      if (!geometry) {
        features.push(feature);
        continue;
      }

      let repaired = geometry;
      if (geometry.type === 'Polygon') {
        repaired = {
          ...geometry,
          coordinates: (geometry.coordinates as Position[][]).map((ring, index) => repairRing(ring, index === 0, true)),
        };
      } else if (geometry.type === 'MultiPolygon') {
        repaired = {
          ...geometry,
          coordinates: (geometry.coordinates as Position[][][]).map((rings) =>
            rings.map((ring, index) => repairRing(ring, index === 0, true))
          ),
        };
      } else if (geometry.type === 'LineString') {
        repaired = { ...geometry, coordinates: repairRing(geometry.coordinates as Position[], true, false) };
      } else if (geometry.type === 'MultiLineString') {
        repaired = {
          ...geometry,
          coordinates: (geometry.coordinates as Position[][]).map((line) => repairRing(line, true, false)),
        };
      }
      features.push({ ...feature, geometry: repaired });
    }
    return { ...layer, features };
  });

  const changes: string[] = [];
  if (verticesRemoved > 0) changes.push(`${verticesRemoved} duplicate vertex/vertices removed`);
  if (ringsClosed > 0) changes.push(`${ringsClosed} ring(s) closed`);
  if (ringsReoriented > 0) changes.push(`${ringsReoriented} ring(s) re-oriented`);
  if (featuresRemoved > 0) changes.push(`${featuresRemoved} duplicate feature(s) removed`);

  if (changes.length > 0) {
    warnings.push(
      warn('TOPOLOGY_REPAIRED', `Geometry repair changed the data: ${changes.join(', ')}.`, {
        reason: 'Geometry repair is enabled in the conversion settings.',
        action: 'Switch repair off in Settings → Conversion to convert the source geometry exactly as delivered.',
        detail: { verticesRemoved, ringsClosed, ringsReoriented, featuresRemoved },
      })
    );
  }

  return { dataset: { ...dataset, layers, warnings: [...dataset.warnings, ...warnings] }, warnings };
}

/** Ring area in dataset units, for the QA summary. */
export function ringArea(ring: Position[]): number {
  return Math.abs(signedArea(ring));
}
