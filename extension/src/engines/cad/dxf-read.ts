/**
 * DXF reader (ASCII).
 *
 * DXF is a stream of (group code, value) pairs, so the reader tokenizes once and
 * then walks sections. Entity coverage is deliberately wide (instruction §9.1)
 * because survey drawings use the full palette — and, just as importantly, every
 * entity class the reader meets but cannot convert is counted by name and
 * reported. Silent loss is the failure mode that costs a surveyor a boundary.
 *
 * Curves are never replaced by their chord. ARC, CIRCLE, ELLIPSE, SPLINE and
 * polyline bulges are densified against an explicit sagitta tolerance, and the
 * substitution is reported with its parameters.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirGeometry,
  type CirLayer,
  type Position,
  type SourceInfo,
  type StyleHint,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import {
  DEFAULT_ARC_TOLERANCE,
  arcSegmentCount,
  closeRing,
  segmentizeArc,
  segmentizeBSpline,
  segmentizeCircle,
  segmentizeEllipse,
} from '../../core/geometry';
import { linearUnitFromInsunits, type LinearUnitId } from '../../core/units';
import { deriveFields } from '../shared';

export interface DxfPair {
  code: number;
  value: string;
}

/** Entity classes that carry geometry this reader converts. */
const SUPPORTED = new Set([
  'POINT',
  'LINE',
  'LWPOLYLINE',
  'POLYLINE',
  'VERTEX',
  'SEQEND',
  '3DFACE',
  'SOLID',
  'TRACE',
  'ARC',
  'CIRCLE',
  'ELLIPSE',
  'SPLINE',
  'TEXT',
  'MTEXT',
  'INSERT',
  'ATTRIB',
  'DIMENSION',
  'LEADER',
  'MLEADER',
  'HATCH',
  'MESH',
]);

export function tokenizeDxf(text: string): DxfPair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: DxfPair[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const rawCode = lines[index].trim();
    if (rawCode === '') {
      // A stray blank line would desynchronise the code/value pairing for the
      // rest of the file, so resynchronise on the next non-empty line instead.
      index -= 1;
      continue;
    }
    const code = Number(rawCode);
    if (!Number.isInteger(code)) {
      index -= 1;
      continue;
    }
    pairs.push({ code, value: lines[index + 1] ?? '' });
  }
  return pairs;
}

interface EntityRecord {
  type: string;
  /** All pairs belonging to the entity, in file order. */
  pairs: DxfPair[];
  /** VERTEX children for a POLYLINE. */
  children?: EntityRecord[];
}

function readSections(pairs: DxfPair[]): Map<string, DxfPair[]> {
  const sections = new Map<string, DxfPair[]>();
  let current: string | null = null;
  let buffer: DxfPair[] = [];
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];
    if (pair.code === 0 && pair.value === 'SECTION') {
      const nameEntry = pairs[index + 1];
      current = nameEntry && nameEntry.code === 2 ? nameEntry.value.toUpperCase() : null;
      buffer = [];
      index++;
      continue;
    }
    if (pair.code === 0 && pair.value === 'ENDSEC') {
      if (current) sections.set(current, buffer);
      current = null;
      buffer = [];
      continue;
    }
    if (current) buffer.push(pair);
  }
  if (current && buffer.length) sections.set(current, buffer);
  return sections;
}

function groupEntities(pairs: DxfPair[]): EntityRecord[] {
  const entities: EntityRecord[] = [];
  let current: EntityRecord | null = null;
  for (const pair of pairs) {
    if (pair.code === 0) {
      const type = pair.value.toUpperCase();
      // VERTEX and SEQEND belong to the POLYLINE that opened the sequence.
      if ((type === 'VERTEX' || type === 'SEQEND') && current && (current.type === 'POLYLINE' || current.children)) {
        if (type === 'SEQEND') continue;
        const child: EntityRecord = { type, pairs: [] };
        current.children = current.children ?? [];
        current.children.push(child);
        continue;
      }
      current = { type, pairs: [] };
      entities.push(current);
      continue;
    }
    if (!current) continue;
    const lastChild = current.children?.[current.children.length - 1];
    if (lastChild && lastChild.type === 'VERTEX') lastChild.pairs.push(pair);
    else current.pairs.push(pair);
  }
  return entities;
}

function first(record: EntityRecord, code: number): string | undefined {
  return record.pairs.find((pair) => pair.code === code)?.value;
}

function num(record: EntityRecord, code: number, fallback?: number): number | undefined {
  const raw = first(record, code);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function all(record: EntityRecord, code: number): number[] {
  const out: number[] = [];
  for (const pair of record.pairs) {
    if (pair.code === code) {
      const value = Number(pair.value);
      if (Number.isFinite(value)) out.push(value);
    }
  }
  return out;
}

/**
 * Reads coordinate triples from repeated 10/20/30 groups in file order.
 * Positional pairing matters: a vertex may omit its 30 (Z) group, and matching
 * by index rather than by position would then attach the next vertex's Z.
 */
function readPointStream(record: EntityRecord, xCode = 10, yCode = 20, zCode = 30): Position[] {
  const out: Position[] = [];
  let pending: { x?: number; y?: number; z?: number } = {};
  const flush = () => {
    if (pending.x !== undefined && pending.y !== undefined) {
      out.push(pending.z !== undefined ? [pending.x, pending.y, pending.z] : [pending.x, pending.y]);
    }
    pending = {};
  };
  for (const pair of record.pairs) {
    const value = Number(pair.value);
    if (pair.code === xCode) {
      if (pending.x !== undefined) flush();
      pending.x = value;
    } else if (pair.code === yCode) {
      pending.y = value;
    } else if (pair.code === zCode) {
      pending.z = value;
    }
  }
  flush();
  return out;
}

/**
 * Densifies a polyline bulge. A bulge is tan(theta/4) where theta is the arc's
 * included angle; the sign gives the direction. Treating a bulged segment as a
 * straight chord is the classic way a plot boundary loses area.
 */
function bulgeArc(from: Position, to: Position, bulge: number, tolerance: number): Position[] {
  if (!Number.isFinite(bulge) || bulge === 0) return [to];
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (chord === 0) return [to];
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  if (!Number.isFinite(radius) || radius === 0) return [to];

  const midX = (from[0] + to[0]) / 2;
  const midY = (from[1] + to[1]) / 2;
  const apothem = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2));
  // The centre sits perpendicular to the chord; the sign of the bulge decides
  // which side, and |theta| > pi puts it on the far side.
  const direction = bulge > 0 ? 1 : -1;
  const sideways = Math.abs(theta) > Math.PI ? -1 : 1;
  const nx = -(to[1] - from[1]) / chord;
  const ny = (to[0] - from[0]) / chord;
  const cx = midX + nx * apothem * direction * sideways;
  const cy = midY + ny * apothem * direction * sideways;

  const startAngle = Math.atan2(from[1] - cy, from[0] - cx);
  const endAngle = Math.atan2(to[1] - cy, to[0] - cx);
  let sweep = endAngle - startAngle;
  if (bulge > 0) {
    while (sweep <= 0) sweep += Math.PI * 2;
  } else {
    while (sweep >= 0) sweep -= Math.PI * 2;
  }

  const segments = arcSegmentCount(radius, sweep, tolerance);
  const out: Position[] = [];
  const zFrom = from[2];
  const zTo = to[2];
  for (let index = 1; index <= segments; index++) {
    const t = index / segments;
    const angle = startAngle + sweep * t;
    const position: Position = [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
    if (zFrom !== undefined && zTo !== undefined) position.push(zFrom + (zTo - zFrom) * t);
    else if (zFrom !== undefined) position.push(zFrom);
    out.push(position);
  }
  // Land exactly on the stored end vertex rather than on a computed point.
  out[out.length - 1] = to.slice();
  return out;
}

export interface ReadDxfOptions {
  /** Sagitta tolerance for curve densification, in drawing units. */
  arcTolerance?: number;
  /** Expand INSERT references by copying the block's geometry. */
  expandBlocks?: boolean;
  /** Emit TEXT/MTEXT as point features carrying the string. */
  includeText?: boolean;
  /** Maximum SPLINE samples; caps runaway densification on huge control nets. */
  maxSplineSamples?: number;
}

interface BlockDefinition {
  name: string;
  basePoint: Position;
  entities: EntityRecord[];
}

interface CurveStat {
  arcs: number;
  circles: number;
  ellipses: number;
  splines: number;
  bulges: number;
  vertices: number;
}

export function readDxf(text: string, source: SourceInfo, options: ReadDxfOptions = {}): CirDataset {
  const tolerance = options.arcTolerance ?? DEFAULT_ARC_TOLERANCE;
  const expandBlocks = options.expandBlocks ?? true;
  const includeText = options.includeText ?? true;
  const maxSplineSamples = options.maxSplineSamples ?? 512;

  const pairs = tokenizeDxf(text);
  if (pairs.length === 0) {
    throw new ConversionError({
      code: 'DXF_EMPTY',
      what: 'No DXF group codes were found in the file.',
      why: 'A DXF is a stream of alternating group-code and value lines; none were present.',
      action: 'If this is a DWG, convert it with the native helper — a DWG cannot be read as DXF.',
    });
  }

  const sections = readSections(pairs);
  const warnings: Warning[] = [];
  const unsupported = new Map<string, number>();
  const curves: CurveStat = { arcs: 0, circles: 0, ellipses: 0, splines: 0, bulges: 0, vertices: 0 };

  // ---- HEADER: units and extents.
  let units: LinearUnitId | null = null;
  const headerPairs = sections.get('HEADER') ?? [];
  let acadVersion = '';
  for (let index = 0; index < headerPairs.length; index++) {
    const pair = headerPairs[index];
    if (pair.code !== 9) continue;
    const variable = pair.value.toUpperCase();
    const next = headerPairs[index + 1];
    if (variable === '$INSUNITS' && next) {
      units = linearUnitFromInsunits(Number(next.value));
      if (units === null && Number(next.value) !== 0) {
        warnings.push(
          warn('DXF_UNKNOWN_UNITS', `The drawing declares $INSUNITS = ${next.value}, which is not a survey linear unit.`, {
            reason: 'Only the linear unit codes used in survey and mapping drawings are mapped.',
            action: 'Set the source unit manually in the conversion settings.',
          })
        );
      }
    }
    if (variable === '$ACADVER' && next) acadVersion = next.value;
  }
  if (units === null) {
    warnings.push(
      warn('DXF_NO_UNITS', 'The drawing does not declare a linear unit ($INSUNITS is 0 or absent).', {
        severity: 'info',
        reason: 'AutoCAD treats unitless drawings as dimensionless; the correct unit is a site convention.',
        action: 'Set the source unit in the conversion settings if the target needs one.',
      })
    );
  }

  // ---- TABLES: layer names, colours and linetypes.
  const layerStyles = new Map<string, StyleHint>();
  const tablePairs = sections.get('TABLES') ?? [];
  {
    let currentLayer: string | null = null;
    let style: StyleHint = {};
    for (const pair of tablePairs) {
      if (pair.code === 0) {
        if (currentLayer) layerStyles.set(currentLayer, style);
        currentLayer = pair.value.toUpperCase() === 'LAYER' ? '' : null;
        style = {};
        continue;
      }
      if (currentLayer === null) continue;
      if (pair.code === 2) currentLayer = pair.value;
      else if (pair.code === 62) style.aci = Math.abs(Number(pair.value));
      else if (pair.code === 6) style.linetype = pair.value;
      else if (pair.code === 420) style.color = `#${(Number(pair.value) & 0xffffff).toString(16).padStart(6, '0')}`;
    }
    if (currentLayer) layerStyles.set(currentLayer, style);
  }

  // ---- BLOCKS: definitions for INSERT expansion.
  const blocks = new Map<string, BlockDefinition>();
  {
    const blockEntities = groupEntities(sections.get('BLOCKS') ?? []);
    let current: BlockDefinition | null = null;
    for (const record of blockEntities) {
      if (record.type === 'BLOCK') {
        const name = first(record, 2) ?? '';
        current = { name, basePoint: [num(record, 10, 0)!, num(record, 20, 0)!, num(record, 30, 0)!], entities: [] };
        blocks.set(name.toUpperCase(), current);
        continue;
      }
      if (record.type === 'ENDBLK') {
        current = null;
        continue;
      }
      if (current) current.entities.push(record);
    }
  }

  // ---- ENTITIES.
  const layers = new Map<string, CirFeature[]>();
  const pushFeature = (layerName: string, feature: CirFeature): void => {
    const list = layers.get(layerName) ?? [];
    list.push(feature);
    layers.set(layerName, list);
  };

  interface Placement {
    dx: number;
    dy: number;
    dz: number;
    sx: number;
    sy: number;
    sz: number;
    rotation: number;
  }

  const IDENTITY: Placement = { dx: 0, dy: 0, dz: 0, sx: 1, sy: 1, sz: 1, rotation: 0 };

  const place = (position: Position, placement: Placement): Position => {
    if (placement === IDENTITY) return position;
    const x = position[0] * placement.sx;
    const y = position[1] * placement.sy;
    const cos = Math.cos(placement.rotation);
    const sin = Math.sin(placement.rotation);
    const out: Position = [x * cos - y * sin + placement.dx, x * sin + y * cos + placement.dy];
    if (position.length > 2) out.push(position[2] * placement.sz + placement.dz);
    return out;
  };

  const baseProperties = (record: EntityRecord): Record<string, unknown> => {
    const properties: Record<string, unknown> = { _srcEntity: record.type };
    const layer = first(record, 8);
    if (layer) properties._layer = layer;
    const handle = first(record, 5);
    if (handle) properties._srcHandle = handle;
    const color = num(record, 62);
    if (color !== undefined) properties._aci = color;
    const linetype = first(record, 6);
    if (linetype) properties._linetype = linetype;
    const elevation = num(record, 38);
    if (elevation !== undefined && elevation !== 0) properties._elevation = elevation;
    return properties;
  };

  const emit = (
    record: EntityRecord,
    geometry: CirGeometry | null,
    placement: Placement,
    extra: Record<string, unknown> = {}
  ): void => {
    if (!geometry) return;
    const layerName = first(record, 8) || '0';
    const style = layerStyles.get(layerName);
    const aci = num(record, 62);
    pushFeature(layerName, {
      id: first(record, 5),
      geometry: placement === IDENTITY ? geometry : transformGeometry(geometry, (position) => place(position, placement)),
      properties: { ...baseProperties(record), ...extra },
      sourceLayer: layerName,
      sourceEntity: record.type,
      sourceHandle: first(record, 5),
      style: aci !== undefined ? { ...style, aci } : style,
    });
  };

  const convert = (record: EntityRecord, placement: Placement, depth: number): void => {
    switch (record.type) {
      case 'POINT': {
        const position = point3(record);
        emit(record, { type: 'Point', coordinates: position, dimension: position.length >= 3 ? 3 : 2 }, placement);
        curves.vertices += 1;
        break;
      }
      case 'LINE': {
        const from = point3(record, 10, 20, 30);
        const to = point3(record, 11, 21, 31);
        const dimension = from.length >= 3 || to.length >= 3 ? 3 : 2;
        emit(record, { type: 'LineString', coordinates: [pad(from, dimension), pad(to, dimension)], dimension }, placement);
        curves.vertices += 2;
        break;
      }
      case 'LWPOLYLINE': {
        const geometry = readLwPolyline(record, tolerance, curves);
        emit(record, geometry, placement);
        break;
      }
      case 'POLYLINE': {
        const geometry = readPolyline(record, tolerance, curves);
        emit(record, geometry, placement);
        break;
      }
      case 'ARC': {
        const centre = point3(record);
        const radius = num(record, 40, 0)!;
        const start = ((num(record, 50, 0)! % 360) * Math.PI) / 180;
        const end = ((num(record, 51, 360)! % 360) * Math.PI) / 180;
        const positions = segmentizeArc({ cx: centre[0], cy: centre[1], z: centre[2], radius, startAngle: start, endAngle: end }, tolerance);
        curves.arcs++;
        curves.vertices += positions.length;
        emit(record, { type: 'LineString', coordinates: positions, dimension: centre.length >= 3 ? 3 : 2 }, placement, {
          _arcRadius: radius,
          _arcStartDeg: num(record, 50, 0),
          _arcEndDeg: num(record, 51, 360),
          _segmentTolerance: tolerance,
        });
        break;
      }
      case 'CIRCLE': {
        const centre = point3(record);
        const radius = num(record, 40, 0)!;
        const ring = segmentizeCircle(centre[0], centre[1], radius, centre[2], tolerance);
        curves.circles++;
        curves.vertices += ring.length;
        emit(record, { type: 'Polygon', coordinates: [ring], dimension: centre.length >= 3 ? 3 : 2 }, placement, {
          _circleRadius: radius,
          _segmentTolerance: tolerance,
        });
        break;
      }
      case 'ELLIPSE': {
        const centre = point3(record);
        const majorX = num(record, 11, 0)!;
        const majorY = num(record, 21, 0)!;
        const ratio = num(record, 40, 1)!;
        const startParam = num(record, 41, 0)!;
        const endParam = num(record, 42, Math.PI * 2)!;
        const positions = segmentizeEllipse(centre[0], centre[1], majorX, majorY, ratio, startParam, endParam, centre[2], tolerance);
        curves.ellipses++;
        curves.vertices += positions.length;
        const closed = Math.abs(endParam - startParam - Math.PI * 2) < 1e-6;
        emit(
          record,
          closed
            ? { type: 'Polygon', coordinates: [closeRing(positions)], dimension: centre.length >= 3 ? 3 : 2 }
            : { type: 'LineString', coordinates: positions, dimension: centre.length >= 3 ? 3 : 2 },
          placement,
          { _ellipseRatio: ratio, _segmentTolerance: tolerance }
        );
        break;
      }
      case 'SPLINE': {
        const degree = num(record, 71, 3)!;
        const controlPoints = readPointStream(record, 10, 20, 30);
        const fitPoints = readPointStream(record, 11, 21, 31);
        const knots = all(record, 40);
        const closed = (num(record, 70, 0)! & 1) !== 0;
        let positions: Position[];
        if (controlPoints.length > degree && knots.length >= controlPoints.length + degree + 1) {
          const samples = Math.min(maxSplineSamples, Math.max(16, controlPoints.length * 12));
          positions = segmentizeBSpline(controlPoints, knots, degree, samples);
        } else if (fitPoints.length >= 2) {
          // Without a usable knot vector the fit points are the honest fallback:
          // they lie on the curve, unlike the control points.
          positions = fitPoints;
          warnings.push(
            warn('DXF_SPLINE_FIT_POINTS', 'A SPLINE was rebuilt from its fit points because its knot vector was incomplete.', {
              reason: 'The control-point count and knot count do not satisfy knots = control points + degree + 1.',
              action: 'Re-export the drawing from the CAD application if exact spline geometry matters.',
            })
          );
        } else {
          positions = controlPoints;
          warnings.push(
            warn('DXF_SPLINE_CONTROL_POLYGON', 'A SPLINE was reduced to its control polygon.', {
              severity: 'warning',
              reason: 'It carried neither a valid knot vector nor fit points, so the true curve cannot be evaluated.',
              action: 'Convert the spline to a polyline in the CAD application before exporting.',
            })
          );
        }
        curves.splines++;
        curves.vertices += positions.length;
        const dimension = positions.some((position) => position.length >= 3) ? 3 : 2;
        emit(
          record,
          closed
            ? { type: 'Polygon', coordinates: [closeRing(positions)], dimension }
            : { type: 'LineString', coordinates: positions, dimension },
          placement,
          { _splineDegree: degree, _segmentTolerance: tolerance }
        );
        break;
      }
      case '3DFACE':
      case 'SOLID':
      case 'TRACE': {
        const corners = [point3(record, 10, 20, 30), point3(record, 11, 21, 31), point3(record, 12, 22, 32), point3(record, 13, 23, 33)];
        // A three-sided face repeats its third corner as the fourth.
        const unique = corners.filter(
          (corner, index) => index === 0 || Math.hypot(corner[0] - corners[index - 1][0], corner[1] - corners[index - 1][1]) > 1e-9
        );
        const dimension = unique.some((corner) => corner.length >= 3) ? 3 : 2;
        const ring = closeRing(unique.map((corner) => pad(corner, dimension)));
        curves.vertices += ring.length;
        if (ring.length >= 4) emit(record, { type: 'Polygon', coordinates: [ring], dimension }, placement);
        break;
      }
      case 'TEXT':
      case 'MTEXT': {
        if (!includeText) {
          bump(unsupported, record.type);
          break;
        }
        const position = point3(record);
        // MTEXT splits long strings across repeated group 3 fragments with the
        // tail in group 1; concatenating in file order is the only correct read.
        const fragments = record.pairs.filter((pair) => pair.code === 3 || pair.code === 1).map((pair) => pair.value);
        const raw = fragments.join('');
        emit(record, { type: 'Point', coordinates: position, dimension: position.length >= 3 ? 3 : 2 }, placement, {
          _text: cleanDxfText(raw),
          _textHeight: num(record, 40),
          _textRotation: num(record, 50),
        });
        curves.vertices += 1;
        break;
      }
      case 'INSERT': {
        const blockName = (first(record, 2) ?? '').toUpperCase();
        const block = blocks.get(blockName);
        const insertion = point3(record);
        if (!expandBlocks || !block || depth > 8) {
          // Depth guard: a block that references itself would recurse forever.
          emit(record, { type: 'Point', coordinates: insertion, dimension: insertion.length >= 3 ? 3 : 2 }, placement, {
            _blockName: first(record, 2),
            _blockExpanded: false,
          });
          if (block && depth > 8) {
            warnings.push(
              warn('DXF_BLOCK_DEPTH', `Block "${first(record, 2)}" nests deeper than 8 levels and was kept as an insertion point.`, {
                reason: 'Deeper nesting is usually a self-referencing block definition.',
                action: 'Flatten the block in the CAD application if its geometry is needed.',
              })
            );
          }
          break;
        }
        const nested: Placement = {
          dx: placement.dx + insertion[0] * placement.sx,
          dy: placement.dy + insertion[1] * placement.sy,
          dz: placement.dz + (insertion[2] ?? 0) * placement.sz,
          sx: placement.sx * (num(record, 41, 1) || 1),
          sy: placement.sy * (num(record, 42, 1) || 1),
          sz: placement.sz * (num(record, 43, 1) || 1),
          rotation: placement.rotation + ((num(record, 50, 0)! * Math.PI) / 180),
        };
        // The block's own base point is subtracted so its geometry lands on the
        // insertion point rather than offset by the base.
        const basePlacement: Placement = {
          ...nested,
          dx: nested.dx - block.basePoint[0] * nested.sx,
          dy: nested.dy - block.basePoint[1] * nested.sy,
          dz: nested.dz - (block.basePoint[2] ?? 0) * nested.sz,
        };
        for (const child of block.entities) convert(child, basePlacement, depth + 1);
        break;
      }
      case 'ATTRIB': {
        const position = point3(record);
        emit(record, { type: 'Point', coordinates: position, dimension: position.length >= 3 ? 3 : 2 }, placement, {
          _text: cleanDxfText(first(record, 1) ?? ''),
          _tag: first(record, 2),
        });
        break;
      }
      case 'DIMENSION': {
        const definition = point3(record, 10, 20, 30);
        const textPoint = point3(record, 11, 21, 31);
        emit(record, { type: 'Point', coordinates: textPoint.length ? textPoint : definition, dimension: 2 }, placement, {
          _text: cleanDxfText(first(record, 1) ?? ''),
          _dimensionType: num(record, 70),
        });
        warnings.push(
          warn('DXF_DIMENSION_ANCHOR', 'DIMENSION entities were converted to their text anchor point only.', {
            severity: 'info',
            reason: 'A dimension is an annotation assembly (extension lines, arrows, text) with no single geometry in the vector model.',
            action: 'Explode dimensions in the CAD application if the leader lines are needed as geometry.',
          })
        );
        break;
      }
      case 'LEADER':
      case 'MLEADER': {
        const positions = readPointStream(record);
        if (positions.length >= 2) {
          const dimension = positions.some((position) => position.length >= 3) ? 3 : 2;
          emit(record, { type: 'LineString', coordinates: positions, dimension }, placement);
          curves.vertices += positions.length;
        } else {
          bump(unsupported, record.type);
        }
        break;
      }
      case 'HATCH': {
        // Only the boundary paths are geometry; the fill pattern is styling.
        const positions = readPointStream(record);
        if (positions.length >= 3) {
          const ring = closeRing(positions);
          emit(record, { type: 'Polygon', coordinates: [ring], dimension: 2 }, placement, {
            _hatchPattern: first(record, 2),
          });
          curves.vertices += ring.length;
        } else {
          bump(unsupported, record.type);
        }
        break;
      }
      case 'MESH': {
        const positions = readPointStream(record);
        if (positions.length > 0) {
          const dimension = positions.some((position) => position.length >= 3) ? 3 : 2;
          emit(record, { type: 'MultiPoint', coordinates: positions, dimension }, placement, { _meshVertices: positions.length });
          curves.vertices += positions.length;
          warnings.push(
            warn('DXF_MESH_VERTICES_ONLY', 'MESH entities were converted to their vertices; face topology was not preserved.', {
              reason: 'The vector model has no mesh primitive.',
              action: 'Export to a point cloud or convert the mesh to 3DFACE entities in the CAD application.',
            })
          );
        } else {
          bump(unsupported, record.type);
        }
        break;
      }
      case 'ENDBLK':
      case 'BLOCK':
      case 'SEQEND':
        break;
      default:
        bump(unsupported, record.type);
        break;
    }
  };

  const entities = groupEntities(sections.get('ENTITIES') ?? []);
  if (entities.length === 0 && !sections.has('ENTITIES')) {
    throw new ConversionError({
      code: 'DXF_NO_ENTITIES',
      what: 'The DXF has no ENTITIES section.',
      why: 'A drawing without an ENTITIES section carries no geometry — this is usually a header-only or template file.',
      action: 'Check that the export included model-space geometry.',
    });
  }
  for (const record of entities) convert(record, IDENTITY, 0);

  // ---- Warnings that summarise what happened.
  if (unsupported.size > 0) {
    const summary = [...unsupported.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type} × ${count}`)
      .join(', ');
    const total = [...unsupported.values()].reduce((sum, count) => sum + count, 0);
    warnings.push(
      warn('DXF_UNSUPPORTED_ENTITIES', `${total} entit${total === 1 ? 'y was' : 'ies were'} not converted: ${summary}.`, {
        count: total,
        reason: 'These entity classes have no representation in the vector model used for GIS targets.',
        action: 'Explode or convert them to lines, polylines or points in the CAD application, then convert again.',
        detail: Object.fromEntries(unsupported),
      })
    );
  }

  const curveTotal = curves.arcs + curves.circles + curves.ellipses + curves.splines + curves.bulges;
  if (curveTotal > 0) {
    warnings.push(
      warn(
        'DXF_CURVES_SEGMENTIZED',
        `${curveTotal} curved entit${curveTotal === 1 ? 'y was' : 'ies were'} densified to line segments at ${tolerance} unit sagitta tolerance ` +
          `(${curves.arcs} arc, ${curves.circles} circle, ${curves.ellipses} ellipse, ${curves.splines} spline, ${curves.bulges} polyline bulge).`,
        {
          severity: 'info',
          count: curveTotal,
          reason: 'GIS vector models have no arc or spline primitive, so true curves cannot be carried across.',
          action: 'Lower the sagitta tolerance for a closer fit, or export to DXF to keep the original curve entities.',
          detail: { ...curves, tolerance },
        }
      )
    );
  }

  const cirLayers: CirLayer[] = [...layers.entries()].map(([name, features]) => {
    const layer = createLayer(name, features, deriveFields(features));
    layer.style = layerStyles.get(name);
    return layer;
  });

  return createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    // DXF has no CRS container. Claiming one would violate rule R2, so the
    // dataset stays unknown and the pipeline asks.
    crs: null,
    crsOrigin: 'unknown',
    units,
    axisOrder: 'xy',
    layers: cirLayers.length > 0 ? cirLayers : [createLayer(source.fileName, [], [])],
    warnings,
    metadata: {
      acadVersion,
      layerCount: cirLayers.length,
      blockCount: blocks.size,
      insunits: units,
      unsupportedEntities: Object.fromEntries(unsupported),
    },
  });
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function point3(record: EntityRecord, xCode = 10, yCode = 20, zCode = 30): Position {
  const x = num(record, xCode);
  const y = num(record, yCode);
  const z = num(record, zCode);
  if (x === undefined || y === undefined) return [];
  return z === undefined ? [x, y] : [x, y, z];
}

function pad(position: Position, dimension: number): Position {
  if (position.length >= dimension) return position;
  const out = position.slice();
  while (out.length < dimension) out.push(0);
  return out;
}

function readLwPolyline(record: EntityRecord, tolerance: number, curves: CurveStat): CirGeometry | null {
  const flags = num(record, 70, 0)!;
  const closed = (flags & 1) !== 0;
  const elevation = num(record, 38);

  // Vertices and their bulges interleave in file order: each 42 belongs to the
  // segment leaving the most recent vertex.
  const vertices: { position: Position; bulge: number }[] = [];
  let pending: { x?: number; y?: number } = {};
  for (const pair of record.pairs) {
    const value = Number(pair.value);
    if (pair.code === 10) {
      if (pending.x !== undefined && pending.y !== undefined) {
        vertices.push({ position: elevation !== undefined ? [pending.x, pending.y, elevation] : [pending.x, pending.y], bulge: 0 });
      }
      pending = { x: value };
    } else if (pair.code === 20) {
      pending.y = value;
    } else if (pair.code === 42) {
      if (pending.x !== undefined && pending.y !== undefined) {
        vertices.push({ position: elevation !== undefined ? [pending.x, pending.y, elevation] : [pending.x, pending.y], bulge: value });
        pending = {};
      } else if (vertices.length > 0) {
        vertices[vertices.length - 1].bulge = value;
      }
    }
  }
  if (pending.x !== undefined && pending.y !== undefined) {
    vertices.push({ position: elevation !== undefined ? [pending.x, pending.y, elevation] : [pending.x, pending.y], bulge: 0 });
  }
  if (vertices.length === 0) return null;

  const positions = densify(vertices, closed, tolerance, curves);
  const dimension = elevation !== undefined ? 3 : 2;
  if (positions.length < 2) return { type: 'Point', coordinates: positions[0], dimension };
  if (closed && positions.length >= 4) return { type: 'Polygon', coordinates: [closeRing(positions)], dimension };
  return { type: 'LineString', coordinates: positions, dimension };
}

function readPolyline(record: EntityRecord, tolerance: number, curves: CurveStat): CirGeometry | null {
  const flags = num(record, 70, 0)!;
  const closed = (flags & 1) !== 0;
  const isPolyfaceMesh = (flags & 64) !== 0;
  const vertices: { position: Position; bulge: number }[] = [];

  for (const child of record.children ?? []) {
    const vertexFlags = num(child, 70, 0)!;
    // In a polyface mesh, flag bit 128 marks vertices and bit 64 marks the face
    // records that index them; face records carry no coordinates.
    if (isPolyfaceMesh && (vertexFlags & 128) !== 0 && (vertexFlags & 64) === 0) continue;
    const x = num(child, 10);
    const y = num(child, 20);
    if (x === undefined || y === undefined) continue;
    const z = num(child, 30);
    vertices.push({ position: z === undefined ? [x, y] : [x, y, z], bulge: num(child, 42, 0)! });
  }
  if (vertices.length === 0) return null;

  const positions = densify(vertices, closed, tolerance, curves);
  const dimension = positions.some((position) => position.length >= 3) ? 3 : 2;
  if (positions.length < 2) return { type: 'Point', coordinates: positions[0], dimension };
  if (closed && positions.length >= 4) return { type: 'Polygon', coordinates: [closeRing(positions.map((p) => pad(p, dimension)))], dimension };
  return { type: 'LineString', coordinates: positions.map((p) => pad(p, dimension)), dimension };
}

function densify(
  vertices: { position: Position; bulge: number }[],
  closed: boolean,
  tolerance: number,
  curves: CurveStat
): Position[] {
  const positions: Position[] = [vertices[0].position];
  const limit = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < limit; index++) {
    const from = vertices[index];
    const to = vertices[(index + 1) % vertices.length];
    if (from.bulge !== 0) {
      curves.bulges++;
      positions.push(...bulgeArc(from.position, to.position, from.bulge, tolerance));
    } else {
      positions.push(to.position);
    }
  }
  curves.vertices += positions.length;
  return positions;
}

function transformGeometry(geometry: CirGeometry, transform: (position: Position) => Position): CirGeometry {
  if (geometry.type === 'GeometryCollection') {
    return { ...geometry, geometries: (geometry.geometries ?? []).map((child) => transformGeometry(child, transform)) };
  }
  const walk = (node: any): any => {
    if (Array.isArray(node) && typeof node[0] === 'number') return transform(node as Position);
    return (node as any[]).map(walk);
  };
  return { ...geometry, coordinates: walk(geometry.coordinates) };
}

/** Strips MTEXT formatting codes so the string is usable as a label. */
export function cleanDxfText(raw: string): string {
  return raw
    .replace(/\\P/g, '\n')
    .replace(/\\~/g, ' ')
    .replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, 'Ø')
    .trim();
}

/** Entity histogram for the inspector, without a full parse. */
export function dxfEntityHistogram(text: string): Record<string, number> {
  const pairs = tokenizeDxf(text);
  const sections = readSections(pairs);
  const histogram: Record<string, number> = {};
  for (const record of groupEntities(sections.get('ENTITIES') ?? [])) {
    histogram[record.type] = (histogram[record.type] ?? 0) + 1;
  }
  return histogram;
}

export function isSupportedDxfEntity(type: string): boolean {
  return SUPPORTED.has(type.toUpperCase());
}
