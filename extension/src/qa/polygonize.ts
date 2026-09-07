/**
 * CAD closed-boundary polygonisation (spec §27.4).
 *
 * A CAD drawing does not have polygons. It has lines. A parcel boundary is a
 * closed LWPOLYLINE if the draughtsman was tidy, and four separate LINE entities
 * meeting at their endpoints if they were not — and to CAD those look identical,
 * because CAD renders strokes and never asks what encloses what.
 *
 * The DXF reader already turns a *closed* polyline into a polygon. This handles
 * the rest:
 *
 *   - boundaries drawn as separate segments, assembled into loops
 *   - boundaries that nearly close, within a stated tolerance
 *   - loops inside loops, resolved into shells and holes
 *
 * The tolerance discipline matters more here than anywhere else in the tool.
 * Closing a 3 mm gap is recovering the draughtsman's intent; closing a 3 m gap
 * is inventing a boundary. So the gap that was closed is recorded per polygon,
 * nothing is closed beyond the tolerance the user set, and a boundary that
 * cannot be closed is returned as an open line rather than quietly forced shut
 * (R18, R21).
 */

import { createLayer, type CirDataset, type CirFeature, type CirLayer, type Position } from '../core/cir';
import { pointInRing, signedArea } from '../core/geometry';

export interface PolygonizeOptions {
  /**
   * Largest gap that may be closed to complete a loop, in dataset units.
   *
   * Deliberately small by default. A survey drawing's snap errors are
   * millimetres; anything larger is a decision, not a fix.
   */
  tolerance: number;
  /** Only polygonise these layers. Empty means every layer. */
  layers: string[];
  /** Resolve a loop inside a loop into a hole rather than a separate polygon. */
  detectHoles: boolean;
  /** Discard loops smaller than this area, in squared dataset units. */
  minArea: number;
  /** Keep the source lines alongside the polygons they produced. */
  keepSourceLines: boolean;
}

export const DEFAULT_POLYGONIZE_OPTIONS: PolygonizeOptions = {
  tolerance: 0.01,
  layers: [],
  detectHoles: true,
  minArea: 0,
  keepSourceLines: true,
};

export interface PolygonizeReport {
  /** Loops built, with the largest gap that had to be closed for each. */
  built: { layer: string; vertices: number; area: number; closedGap: number; sourceIds: (string | number | undefined)[] }[];
  /** Loops that became holes in another loop. */
  holes: number;
  /** Lines that could not be assembled into any loop, and why. */
  unclosed: { layer: string; sourceIds: (string | number | undefined)[]; gap: number; reason: string }[];
  /** Loops discarded for being below `minArea`. */
  discarded: number;
}

export interface PolygonizeResult {
  dataset: CirDataset;
  report: PolygonizeReport;
}

interface Segment {
  path: Position[];
  feature: CirFeature;
  layer: string;
  used: boolean;
}

function distance(left: Position, right: Position): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function linesOf(feature: CirFeature): Position[][] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates as Position[]];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as Position[][];
  return [];
}

function isClosed(path: Position[], tolerance: number): boolean {
  return path.length >= 4 && distance(path[0], path[path.length - 1]) <= tolerance;
}

/**
 * Walks segments end-to-end into loops.
 *
 * A greedy chain walk rather than a full planar-graph noding: it assembles the
 * boundaries a draughtsman actually drew — a chain of segments meeting at their
 * endpoints — and does not attempt to node segments that cross in their
 * interiors. Crossing lines are a *defect* (qa/defects.ts reports them), and
 * silently noding them here would build polygons from geometry the user has not
 * been told is broken.
 */
function assembleLoops(segments: Segment[], tolerance: number): { loop: Position[]; parts: Segment[]; gap: number }[] {
  const loops: { loop: Position[]; parts: Segment[]; gap: number }[] = [];

  for (const start of segments) {
    if (start.used) continue;
    start.used = true;

    let chain = [...start.path];
    const parts = [start];
    let largestGap = 0;
    let extended = true;

    while (extended && !isClosed(chain, tolerance)) {
      extended = false;
      const tail = chain[chain.length - 1];
      const head = chain[0];

      let best: { segment: Segment; gap: number; append: boolean; reverse: boolean } | null = null;
      for (const candidate of segments) {
        if (candidate.used) continue;
        const first = candidate.path[0];
        const last = candidate.path[candidate.path.length - 1];
        const options: { gap: number; append: boolean; reverse: boolean }[] = [
          { gap: distance(tail, first), append: true, reverse: false },
          { gap: distance(tail, last), append: true, reverse: true },
          { gap: distance(head, last), append: false, reverse: false },
          { gap: distance(head, first), append: false, reverse: true },
        ];
        for (const option of options) {
          if (option.gap > tolerance) continue;
          if (!best || option.gap < best.gap) best = { segment: candidate, ...option };
        }
      }

      if (!best) break;
      best.segment.used = true;
      parts.push(best.segment);
      if (best.gap > largestGap) largestGap = best.gap;

      const piece = best.reverse ? [...best.segment.path].reverse() : best.segment.path;
      // The shared endpoint is dropped so the joint does not become a duplicate
      // vertex, which would then be reported as a defect we created ourselves.
      chain = best.append ? [...chain, ...piece.slice(1)] : [...piece.slice(0, -1), ...chain];
      extended = true;
    }

    const closingGap = distance(chain[0], chain[chain.length - 1]);
    if (chain.length >= 4 && closingGap <= tolerance) {
      // Snap the ring shut on the first vertex rather than leaving a gap the
      // width of the tolerance behind.
      const closed = closingGap === 0 ? chain : [...chain.slice(0, -1), chain[0]];
      loops.push({ loop: closed, parts, gap: Math.max(largestGap, closingGap) });
    } else {
      // Not a loop: release the parts so a different chain can try them.
      for (const part of parts) part.used = false;
      start.used = true;
    }
  }

  return loops;
}

/**
 * Turns CAD line work into polygons.
 *
 * Returns a new dataset with a polygon layer per source layer, preserving the
 * layer name and the source entity handles so provenance survives (R20).
 */
export function polygonize(dataset: CirDataset, options: Partial<PolygonizeOptions> = {}): PolygonizeResult {
  const settings = { ...DEFAULT_POLYGONIZE_OPTIONS, ...options };
  const wanted = new Set(settings.layers);
  const report: PolygonizeReport = { built: [], holes: 0, unclosed: [], discarded: 0 };
  const newLayers: CirLayer[] = [];

  for (const layer of dataset.layers) {
    if (wanted.size > 0 && !wanted.has(layer.name)) continue;

    const segments: Segment[] = [];
    for (const feature of layer.features) {
      for (const path of linesOf(feature)) {
        if (path.length >= 2) segments.push({ path, feature, layer: layer.name, used: false });
      }
    }
    if (segments.length === 0) continue;

    const loops = assembleLoops(segments, settings.tolerance);

    // Anything still unused is line work that never closed.
    const leftovers = segments.filter((segment) => !segment.used || !loops.some((entry) => entry.parts.includes(segment)));
    const orphaned = leftovers.filter((segment) => !loops.some((entry) => entry.parts.includes(segment)));
    if (orphaned.length > 0) {
      // Reported with the gap that defeated it, so the user can decide whether
      // raising the tolerance is honest or whether the boundary is genuinely
      // incomplete.
      let smallestGap = Infinity;
      for (const segment of orphaned) {
        const tail = segment.path[segment.path.length - 1];
        for (const other of segments) {
          if (other === segment) continue;
          const gap = Math.min(distance(tail, other.path[0]), distance(tail, other.path[other.path.length - 1]));
          if (gap > 0 && gap < smallestGap) smallestGap = gap;
        }
      }
      report.unclosed.push({
        layer: layer.name,
        sourceIds: orphaned.map((segment) => segment.feature.id),
        gap: Number.isFinite(smallestGap) ? smallestGap : 0,
        reason: Number.isFinite(smallestGap)
          ? `The nearest unconnected end is ${smallestGap.toFixed(4)} units away, beyond the ${settings.tolerance} tolerance.`
          : 'The line work does not form a closed boundary.',
      });
    }

    // Sort by area descending so a containing loop is always seen before the
    // loops inside it, which is what makes the hole test a single pass.
    const ranked = loops
      .map((entry) => ({ ...entry, area: Math.abs(signedArea(entry.loop)) }))
      .filter((entry) => {
        if (entry.area >= settings.minArea) return true;
        report.discarded++;
        return false;
      })
      .sort((left, right) => right.area - left.area);

    const built: { rings: Position[][]; parts: Segment[]; gap: number; area: number }[] = [];
    for (const entry of ranked) {
      let nested = false;
      if (settings.detectHoles) {
        for (const outer of built) {
          // A loop whose every vertex sits inside an existing shell is a hole in
          // it — an island courtyard, a lake in a lease, an exclusion.
          if (entry.loop.every((position) => pointInRing(position, outer.rings[0]))) {
            outer.rings.push(entry.loop);
            report.holes++;
            nested = true;
            break;
          }
        }
      }
      if (!nested) built.push({ rings: [entry.loop], parts: entry.parts, gap: entry.gap, area: entry.area });
    }

    if (built.length === 0) continue;

    const features: CirFeature[] = built.map((entry, index) => {
      const source = entry.parts[0].feature;
      report.built.push({
        layer: layer.name,
        vertices: entry.rings[0].length,
        area: entry.area,
        closedGap: entry.gap,
        sourceIds: entry.parts.map((part) => part.feature.id),
      });
      return {
        id: source.id ?? `${layer.name}-poly-${index}`,
        geometry: { type: 'Polygon', coordinates: entry.rings, dimension: 2 },
        // Provenance: which entities this polygon was assembled from, and how
        // much it had to be closed (R20).
        properties: {
          ...source.properties,
          _polygonized_from: entry.parts.map((part) => part.feature.sourceHandle ?? part.feature.id).filter(Boolean).join(','),
          _polygonized_segments: entry.parts.length,
          _polygonized_gap: entry.gap,
        },
        sourceLayer: source.sourceLayer ?? layer.name,
        sourceEntity: source.sourceEntity,
        sourceHandle: source.sourceHandle,
        style: source.style,
      };
    });

    newLayers.push(createLayer(`${layer.name}`, features, layer.fields, [...layer.path]));
  }

  if (newLayers.length === 0) return { dataset, report };

  // Replace each source layer with its polygons, or add a polygon layer beside
  // it when the caller asked to keep the line work.
  const byName = new Map(newLayers.map((layer) => [layer.name, layer]));
  const layers: CirLayer[] = [];
  for (const layer of dataset.layers) {
    const replacement = byName.get(layer.name);
    if (!replacement) {
      layers.push(layer);
      continue;
    }
    if (settings.keepSourceLines) {
      layers.push(layer);
      layers.push({ ...replacement, name: `${layer.name} polygons`, path: [...layer.path.slice(0, -1), `${layer.name} polygons`] });
    } else {
      layers.push(replacement);
    }
  }

  return { dataset: { ...dataset, layers }, report };
}

/** One-line summary, with the honest caveats attached. */
export function describePolygonize(report: PolygonizeReport, options: PolygonizeOptions): string {
  const parts = [`${report.built.length} polygon(s) built from CAD line work`];
  if (report.holes > 0) parts.push(`${report.holes} nested loop(s) became holes`);

  const closed = report.built.filter((entry) => entry.closedGap > 0);
  if (closed.length > 0) {
    const largest = Math.max(...closed.map((entry) => entry.closedGap));
    parts.push(`${closed.length} needed closing, the largest gap ${largest.toFixed(4)} units (tolerance ${options.tolerance})`);
  }
  if (report.unclosed.length > 0) parts.push(`${report.unclosed.length} boundar(y/ies) would not close and were left as lines`);
  if (report.discarded > 0) parts.push(`${report.discarded} loop(s) were below the minimum area`);
  return `${parts.join('; ')}.`;
}
