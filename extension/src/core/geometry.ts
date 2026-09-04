/**
 * Geometry utilities over the CIR.
 *
 * Curve handling is the part that matters most for survey work: a CAD arc has no
 * GIS equivalent, so it must be segmentized with a stated tolerance and the
 * substitution must be reported. Silently replacing an arc with its chord is the
 * classic way a boundary loses area, so it is prohibited (instruction §8.2).
 */

import type { Bounds, Bounds3, CirFeature, CirGeometry, GeometryType, Position } from './cir';

/** Default sagitta (mid-ordinate) tolerance in dataset units. */
export const DEFAULT_ARC_TOLERANCE = 0.01;
/** A full circle never degrades below this many segments regardless of tolerance. */
export const MIN_ARC_SEGMENTS = 8;
export const MAX_ARC_SEGMENTS = 4096;

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function isFiniteBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY) && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.maxY)
  );
}

export function eachPosition(geometry: CirGeometry | null, visit: (position: Position) => void): void {
  if (!geometry) return;
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries ?? []) eachPosition(child, visit);
    return;
  }
  const walk = (node: any, depth: number): void => {
    if (node == null) return;
    if (depth === 0) {
      visit(node as Position);
      return;
    }
    for (const child of node as any[]) walk(child, depth - 1);
  };
  walk(geometry.coordinates, nestingDepth(geometry.type));
}

function nestingDepth(type: GeometryType): number {
  switch (type) {
    case 'Point':
      return 0;
    case 'MultiPoint':
    case 'LineString':
      return 1;
    case 'MultiLineString':
    case 'Polygon':
      return 2;
    case 'MultiPolygon':
      return 3;
    default:
      return 0;
  }
}

export function geometryBounds(geometry: CirGeometry | null, into: Bounds = emptyBounds()): Bounds {
  eachPosition(geometry, (position) => {
    if (position[0] < into.minX) into.minX = position[0];
    if (position[1] < into.minY) into.minY = position[1];
    if (position[0] > into.maxX) into.maxX = position[0];
    if (position[1] > into.maxY) into.maxY = position[1];
  });
  return into;
}

export function featuresBounds(features: CirFeature[]): Bounds {
  const bounds = emptyBounds();
  for (const feature of features) geometryBounds(feature.geometry, bounds);
  return bounds;
}

export function featuresBounds3(features: CirFeature[]): Bounds3 {
  const bounds: Bounds3 = { ...emptyBounds(), minZ: Infinity, maxZ: -Infinity };
  for (const feature of features) {
    eachPosition(feature.geometry, (position) => {
      if (position[0] < bounds.minX) bounds.minX = position[0];
      if (position[1] < bounds.minY) bounds.minY = position[1];
      if (position[0] > bounds.maxX) bounds.maxX = position[0];
      if (position[1] > bounds.maxY) bounds.maxY = position[1];
      const z = position[2];
      if (typeof z === 'number' && Number.isFinite(z)) {
        if (z < bounds.minZ) bounds.minZ = z;
        if (z > bounds.maxZ) bounds.maxZ = z;
      }
    });
  }
  return bounds;
}

export function countVertices(geometry: CirGeometry | null): number {
  let n = 0;
  eachPosition(geometry, () => {
    n++;
  });
  return n;
}

export function hasZ(geometry: CirGeometry | null): boolean {
  let found = false;
  eachPosition(geometry, (position) => {
    if (position.length >= 3 && Number.isFinite(position[2])) found = true;
  });
  return found;
}

export function mapPositions(geometry: CirGeometry, transform: (position: Position) => Position): CirGeometry {
  if (geometry.type === 'GeometryCollection') {
    return { ...geometry, geometries: (geometry.geometries ?? []).map((child) => mapPositions(child, transform)) };
  }
  const depth = nestingDepth(geometry.type);
  const walk = (node: any, level: number): any => {
    if (level === 0) return transform(node as Position);
    return (node as any[]).map((child) => walk(child, level - 1));
  };
  return { ...geometry, coordinates: walk(geometry.coordinates, depth) };
}

/**
 * Number of segments needed to approximate an arc within `tolerance` measured as
 * sagitta (the largest gap between the chord and the true arc):
 *
 *   sagitta = r * (1 - cos(Δθ / 2))   =>   Δθ = 2 * acos(1 - tolerance / r)
 *
 * A tolerance at or above the radius degenerates, so the clamp keeps the result
 * inside [MIN_ARC_SEGMENTS, MAX_ARC_SEGMENTS].
 */
export function arcSegmentCount(radius: number, sweepRadians: number, tolerance = DEFAULT_ARC_TOLERANCE): number {
  const sweep = Math.abs(sweepRadians);
  if (!(radius > 0) || sweep <= 0) return MIN_ARC_SEGMENTS;
  const ratio = 1 - tolerance / radius;
  if (ratio <= -1) return MIN_ARC_SEGMENTS;
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, ratio)));
  if (!Number.isFinite(step) || step <= 0) return MAX_ARC_SEGMENTS;
  const perFullCircle = Math.ceil((Math.PI * 2) / step);
  const count = Math.ceil((sweep / (Math.PI * 2)) * Math.max(perFullCircle, MIN_ARC_SEGMENTS));
  return Math.max(MIN_ARC_SEGMENTS === 8 && sweep >= Math.PI * 2 ? MIN_ARC_SEGMENTS : 2, Math.min(MAX_ARC_SEGMENTS, count));
}

export interface ArcSpec {
  cx: number;
  cy: number;
  z?: number;
  radius: number;
  /** Radians, counter-clockwise from +X, matching DXF convention. */
  startAngle: number;
  endAngle: number;
}

/** Densifies an arc into vertices, inclusive of both endpoints. */
export function segmentizeArc(arc: ArcSpec, tolerance = DEFAULT_ARC_TOLERANCE): Position[] {
  let sweep = arc.endAngle - arc.startAngle;
  while (sweep <= 0) sweep += Math.PI * 2;
  const count = arcSegmentCount(arc.radius, sweep, tolerance);
  const out: Position[] = [];
  for (let i = 0; i <= count; i++) {
    const angle = arc.startAngle + (sweep * i) / count;
    const position: Position = [arc.cx + Math.cos(angle) * arc.radius, arc.cy + Math.sin(angle) * arc.radius];
    if (arc.z !== undefined) position.push(arc.z);
    out.push(position);
  }
  return out;
}

export function segmentizeCircle(cx: number, cy: number, radius: number, z: number | undefined, tolerance = DEFAULT_ARC_TOLERANCE): Position[] {
  const points = segmentizeArc({ cx, cy, z, radius, startAngle: 0, endAngle: Math.PI * 2 }, tolerance);
  // Close the ring exactly on the start vertex rather than on a re-computed
  // point, so the closure test is bit-exact for downstream writers.
  points[points.length - 1] = points[0].slice();
  return points;
}

export function segmentizeEllipse(
  cx: number,
  cy: number,
  majorX: number,
  majorY: number,
  ratio: number,
  startParam: number,
  endParam: number,
  z: number | undefined,
  tolerance = DEFAULT_ARC_TOLERANCE
): Position[] {
  const major = Math.hypot(majorX, majorY);
  const minor = major * ratio;
  const rotation = Math.atan2(majorY, majorX);
  let sweep = endParam - startParam;
  while (sweep <= 0) sweep += Math.PI * 2;
  // Segment against the larger semi-axis: it is where the chord error peaks.
  const count = arcSegmentCount(Math.max(major, minor), sweep, tolerance);
  const out: Position[] = [];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  for (let i = 0; i <= count; i++) {
    const t = startParam + (sweep * i) / count;
    const ex = Math.cos(t) * major;
    const ey = Math.sin(t) * minor;
    const position: Position = [cx + ex * cos - ey * sin, cy + ex * sin + ey * cos];
    if (z !== undefined) position.push(z);
    out.push(position);
  }
  return out;
}

/**
 * Evaluates a non-uniform B-spline. DXF stores splines as control points, knots
 * and a degree; the alternative — connecting control points directly — is simply
 * the wrong curve, and for a road centreline it is wrong by metres.
 */
export function segmentizeBSpline(controlPoints: Position[], knots: number[], degree: number, samples: number): Position[] {
  if (controlPoints.length === 0) return [];
  if (controlPoints.length <= degree || knots.length < controlPoints.length + degree + 1) {
    // Not enough information for a proper evaluation; the caller reports this as
    // a warning rather than silently emitting a wrong curve.
    return controlPoints.map((p) => p.slice());
  }
  const n = controlPoints.length - 1;
  const domainStart = knots[degree];
  const domainEnd = knots[n + 1];
  const out: Position[] = [];
  const dimension = Math.max(2, Math.min(3, controlPoints[0].length));

  const basis = (i: number, k: number, t: number): number => {
    if (k === 0) {
      // The final span is closed on the right so t === domainEnd evaluates.
      if (knots[i] <= t && (t < knots[i + 1] || (t === domainEnd && knots[i + 1] === domainEnd))) return 1;
      return 0;
    }
    let left = 0;
    const denomLeft = knots[i + k] - knots[i];
    if (denomLeft !== 0) left = ((t - knots[i]) / denomLeft) * basis(i, k - 1, t);
    let right = 0;
    const denomRight = knots[i + k + 1] - knots[i + 1];
    if (denomRight !== 0) right = ((knots[i + k + 1] - t) / denomRight) * basis(i + 1, k - 1, t);
    return left + right;
  };

  for (let s = 0; s <= samples; s++) {
    const t = domainStart + ((domainEnd - domainStart) * s) / samples;
    const position: Position = dimension === 3 ? [0, 0, 0] : [0, 0];
    for (let i = 0; i <= n; i++) {
      const weight = basis(i, degree, t);
      if (weight === 0) continue;
      position[0] += controlPoints[i][0] * weight;
      position[1] += controlPoints[i][1] * weight;
      if (dimension === 3) position[2] += (controlPoints[i][2] ?? 0) * weight;
    }
    out.push(position);
  }
  return out;
}

/** Shoelace area. Positive means counter-clockwise in a right-handed x/y frame. */
export function signedArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

export function isClockwise(ring: Position[]): boolean {
  return signedArea(ring) > 0;
}

export function closeRing(ring: Position[]): Position[] {
  if (ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first.slice()];
}

/**
 * Normalises ring winding. GeoJSON (RFC 7946) wants counter-clockwise exterior
 * rings; Shapefile wants clockwise. Writers state which convention they need
 * rather than hoping the source already matched.
 */
export function orientRing(ring: Position[], clockwise: boolean): Position[] {
  return isClockwise(ring) === clockwise ? ring : [...ring].reverse();
}

export function removeDuplicateVertices(ring: Position[], tolerance = 0): Position[] {
  const out: Position[] = [];
  for (const position of ring) {
    const previous = out[out.length - 1];
    if (previous && Math.abs(previous[0] - position[0]) <= tolerance && Math.abs(previous[1] - position[1]) <= tolerance) continue;
    out.push(position);
  }
  return out;
}

/** True when segments p1-p2 and p3-p4 cross, excluding shared endpoints. */
export function segmentsIntersect(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
  const d = (a: Position, b: Position, c: Position) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const intersects =
      ring[i][1] > point[1] !== ring[j][1] > point[1] &&
      point[0] < ((ring[j][0] - ring[i][0]) * (point[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0];
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Flattens any geometry to the vertex lists a simple renderer or writer needs. */
export function toPolylines(geometry: CirGeometry | null): Position[][] {
  if (!geometry) return [];
  switch (geometry.type) {
    case 'Point':
      return [[geometry.coordinates as Position]];
    case 'MultiPoint':
      return (geometry.coordinates as Position[]).map((p) => [p]);
    case 'LineString':
      return [geometry.coordinates as Position[]];
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates as Position[][];
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][]).flat();
    case 'GeometryCollection':
      return (geometry.geometries ?? []).flatMap((child) => toPolylines(child));
    default:
      return [];
  }
}

export function multiplex(type: GeometryType): GeometryType {
  switch (type) {
    case 'Point':
      return 'MultiPoint';
    case 'LineString':
      return 'MultiLineString';
    case 'Polygon':
      return 'MultiPolygon';
    default:
      return type;
  }
}

/** 'point' | 'line' | 'polygon' — the three buckets writers actually branch on. */
export function simpleKind(type: GeometryType): 'point' | 'line' | 'polygon' | 'mixed' {
  switch (type) {
    case 'Point':
    case 'MultiPoint':
      return 'point';
    case 'LineString':
    case 'MultiLineString':
      return 'line';
    case 'Polygon':
    case 'MultiPolygon':
      return 'polygon';
    default:
      return 'mixed';
  }
}
