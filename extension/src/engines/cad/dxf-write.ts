/**
 * DXF writer (ASCII).
 *
 * Emits a complete, loadable AC1015 (R2000) or AC1032 (2018) drawing: HEADER
 * with the unit, a LAYER table (AutoCAD rejects entities on undeclared layers),
 * an empty BLOCKS section, and ENTITIES.
 *
 * Geometry mapping follows instruction §9.2. Z is written as a real vertex
 * ordinate rather than as an elevation attribute, because survey drawings are
 * used for volumes and a flattened polyline is a wrong answer, not a lossy one.
 */

import { allFeatures, type CirDataset, type CirFeature, type Position, type Warning } from '../../core/cir';
import { warn } from '../../core/cir';
import { featuresBounds3 } from '../../core/geometry';
import { formatFixed, type PrecisionPolicy } from '../../core/precision';
import { insunitsFromLinearUnit, type LinearUnitId } from '../../core/units';

export type DxfVersion = 'AC1015' | 'AC1032';

export interface WriteDxfOptions {
  precision: PrecisionPolicy;
  version: DxfVersion;
  /** Linear unit written to $INSUNITS. */
  unit: LinearUnitId;
  /** How points become entities. */
  pointMode: 'point' | 'point-and-label' | 'label';
  /** How lines become entities. */
  lineMode: 'lwpolyline' | 'polyline-3d';
  /** Whether polygons also get a HATCH fill. */
  polygonFill: boolean;
  /** Where the layer name comes from. */
  layerSource: 'source-layer' | 'attribute' | 'single';
  layerAttribute?: string;
  singleLayerName?: string;
  /** Attribute used for TEXT labels. */
  labelField?: string;
  textHeight: number;
  preserveZ: boolean;
}

export const DEFAULT_DXF_OPTIONS: Omit<WriteDxfOptions, 'precision'> = {
  version: 'AC1015',
  unit: 'm',
  pointMode: 'point',
  lineMode: 'lwpolyline',
  polygonFill: false,
  layerSource: 'source-layer',
  singleLayerName: 'CONVERTED',
  textHeight: 1,
  preserveZ: true,
};

/** DXF layer names reject these characters; AutoCAD refuses to open the file. */
function sanitizeLayerName(name: string): string {
  const cleaned = name.replace(/[<>/\\":;?*|=`,]/g, '_').trim();
  return cleaned === '' ? '0' : cleaned.slice(0, 255);
}

class DxfBuilder {
  private parts: string[] = [];

  pair(code: number, value: string | number): void {
    this.parts.push(String(code), String(value));
  }

  section(name: string): void {
    this.pair(0, 'SECTION');
    this.pair(2, name);
  }

  endSection(): void {
    this.pair(0, 'ENDSEC');
  }

  toString(): string {
    this.pair(0, 'EOF');
    // DXF group codes and values each occupy their own line, CRLF-terminated,
    // which is what AutoCAD and every DXF reader in the field expect.
    return this.parts.join('\r\n') + '\r\n';
  }
}

interface FeatureWithLayer {
  feature: CirFeature;
  layer: string;
}

/**
 * Chooses the DXF layer for a feature.
 *
 * `_layer` is checked before the CIR layer name because it is the original CAD
 * layer carried through the conversion. A GeoJSON produced from a DXF holds one
 * CIR layer named after the file, so trusting the CIR name first would flatten
 * a DXF -> GeoJSON -> DXF trip onto a single layer.
 */
function resolveLayer(feature: CirFeature, cirLayerName: string, options: WriteDxfOptions): string {
  if (options.layerSource === 'single') return sanitizeLayerName(options.singleLayerName ?? 'CONVERTED');
  if (options.layerSource === 'attribute' && options.layerAttribute) {
    const value = feature.properties?.[options.layerAttribute];
    if (value !== undefined && value !== null && String(value).trim() !== '') return sanitizeLayerName(String(value));
    return '0';
  }
  const carried = feature.properties?._layer;
  if (typeof carried === 'string' && carried.trim() !== '') return sanitizeLayerName(carried);
  if (feature.sourceLayer) return sanitizeLayerName(feature.sourceLayer);
  return sanitizeLayerName(cirLayerName || '0');
}

export function writeDxf(dataset: CirDataset, options: WriteDxfOptions): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const geographic = dataset.crs?.kind === 'geographic';
  const decimals = options.precision.mode === 'full' ? 15 : geographic ? options.precision.geographicDecimals : options.precision.linearDecimals;
  const elevationDecimals = options.precision.mode === 'full' ? 15 : options.precision.elevationDecimals;
  const fmt = (value: number) => formatFixed(value, decimals);
  const fmtZ = (value: number) => formatFixed(value, elevationDecimals);

  const items: FeatureWithLayer[] = [];
  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      if (!feature.geometry) continue;
      items.push({ feature, layer: resolveLayer(feature, layer.name, options) });
    }
  }

  const layerNames = [...new Set(items.map((item) => item.layer))];
  if (layerNames.length === 0) layerNames.push('0');
  if (!layerNames.includes('0')) layerNames.unshift('0');

  const builder = new DxfBuilder();
  const bounds = featuresBounds3(allFeatures(dataset));

  // ---- HEADER
  builder.section('HEADER');
  builder.pair(9, '$ACADVER');
  builder.pair(1, options.version);
  builder.pair(9, '$INSUNITS');
  builder.pair(70, insunitsFromLinearUnit(options.unit));
  if (Number.isFinite(bounds.minX)) {
    builder.pair(9, '$EXTMIN');
    builder.pair(10, fmt(bounds.minX));
    builder.pair(20, fmt(bounds.minY));
    builder.pair(30, Number.isFinite(bounds.minZ) ? fmtZ(bounds.minZ) : '0.0');
    builder.pair(9, '$EXTMAX');
    builder.pair(10, fmt(bounds.maxX));
    builder.pair(20, fmt(bounds.maxY));
    builder.pair(30, Number.isFinite(bounds.maxZ) ? fmtZ(bounds.maxZ) : '0.0');
  }
  builder.endSection();

  // ---- TABLES: LAYER entries are mandatory; entities on undeclared layers make
  // the drawing fail to open in strict readers.
  builder.section('TABLES');
  builder.pair(0, 'TABLE');
  builder.pair(2, 'LTYPE');
  builder.pair(70, 1);
  builder.pair(0, 'LTYPE');
  builder.pair(2, 'CONTINUOUS');
  builder.pair(70, 0);
  builder.pair(3, 'Solid line');
  builder.pair(72, 65);
  builder.pair(73, 0);
  builder.pair(40, '0.0');
  builder.pair(0, 'ENDTAB');

  builder.pair(0, 'TABLE');
  builder.pair(2, 'LAYER');
  builder.pair(70, layerNames.length);
  for (const name of layerNames) {
    builder.pair(0, 'LAYER');
    builder.pair(2, name);
    builder.pair(70, 0);
    builder.pair(62, 7); // white/black, follows the viewport background
    builder.pair(6, 'CONTINUOUS');
  }
  builder.pair(0, 'ENDTAB');
  builder.endSection();

  builder.section('BLOCKS');
  builder.endSection();

  // ---- ENTITIES
  builder.section('ENTITIES');

  let handle = 0x100;
  const nextHandle = () => (handle++).toString(16).toUpperCase();

  const writeCommon = (type: string, layer: string, feature: CirFeature): void => {
    builder.pair(0, type);
    builder.pair(5, nextHandle());
    builder.pair(8, layer);
    const aci = feature.style?.aci ?? (feature.properties?._aci as number | undefined);
    if (typeof aci === 'number' && aci > 0) builder.pair(62, Math.round(aci));
  };

  const writePoint = (position: Position, layer: string, feature: CirFeature): void => {
    writeCommon('POINT', layer, feature);
    builder.pair(10, fmt(position[0]));
    builder.pair(20, fmt(position[1]));
    builder.pair(30, options.preserveZ && position.length > 2 && Number.isFinite(position[2]) ? fmtZ(position[2]) : '0.0');
  };

  const writeText = (position: Position, text: string, layer: string, feature: CirFeature): void => {
    writeCommon('TEXT', layer, feature);
    builder.pair(10, fmt(position[0]));
    builder.pair(20, fmt(position[1]));
    builder.pair(30, options.preserveZ && position.length > 2 && Number.isFinite(position[2]) ? fmtZ(position[2]) : '0.0');
    builder.pair(40, formatFixed(options.textHeight, 4));
    builder.pair(1, text.replace(/\r?\n/g, '\\P'));
  };

  const hasZ = (positions: Position[]) => positions.some((position) => position.length > 2 && Number.isFinite(position[2]));

  const writePolyline = (positions: Position[], closed: boolean, layer: string, feature: CirFeature): void => {
    const use3d = options.preserveZ && (options.lineMode === 'polyline-3d' || hasZ(positions));
    if (use3d) {
      // A 3D POLYLINE carries a real Z per vertex; LWPOLYLINE has only a single
      // elevation for the whole entity, which flattens survey linework.
      writeCommon('POLYLINE', layer, feature);
      builder.pair(66, 1);
      builder.pair(10, '0.0');
      builder.pair(20, '0.0');
      builder.pair(30, '0.0');
      builder.pair(70, 8 | (closed ? 1 : 0)); // 8 = 3D polyline
      for (const position of positions) {
        builder.pair(0, 'VERTEX');
        builder.pair(5, nextHandle());
        builder.pair(8, layer);
        builder.pair(10, fmt(position[0]));
        builder.pair(20, fmt(position[1]));
        builder.pair(30, position.length > 2 && Number.isFinite(position[2]) ? fmtZ(position[2]) : '0.0');
        builder.pair(70, 32); // 3D polyline vertex
      }
      builder.pair(0, 'SEQEND');
      builder.pair(5, nextHandle());
      builder.pair(8, layer);
      return;
    }
    writeCommon('LWPOLYLINE', layer, feature);
    builder.pair(90, positions.length);
    builder.pair(70, closed ? 1 : 0);
    for (const position of positions) {
      builder.pair(10, fmt(position[0]));
      builder.pair(20, fmt(position[1]));
    }
  };

  const writeHatch = (rings: Position[][], layer: string, feature: CirFeature): void => {
    writeCommon('HATCH', layer, feature);
    builder.pair(100, 'AcDbEntity');
    builder.pair(100, 'AcDbHatch');
    builder.pair(10, '0.0');
    builder.pair(20, '0.0');
    builder.pair(30, '0.0');
    builder.pair(210, '0.0');
    builder.pair(220, '0.0');
    builder.pair(230, '1.0');
    builder.pair(2, 'SOLID');
    builder.pair(70, 1); // solid fill
    builder.pair(71, 0); // not associative
    builder.pair(91, rings.length);
    for (const ring of rings) {
      builder.pair(92, 2); // polyline boundary
      builder.pair(72, 0); // no bulges
      builder.pair(73, 1); // closed
      builder.pair(93, ring.length);
      for (const position of ring) {
        builder.pair(10, fmt(position[0]));
        builder.pair(20, fmt(position[1]));
      }
      builder.pair(97, 0); // no source boundary objects
    }
    builder.pair(75, 0);
    builder.pair(76, 1);
    builder.pair(98, 0);
  };

  let droppedZ = 0;
  let labelCount = 0;
  let textFromAttribute = 0;

  const labelFor = (feature: CirFeature): string | null => {
    if (options.labelField) {
      const value = feature.properties?.[options.labelField];
      return value === undefined || value === null || String(value) === '' ? null : String(value);
    }
    const text = feature.properties?._text;
    if (typeof text === 'string' && text !== '') return text;
    return feature.id !== undefined ? String(feature.id) : null;
  };

  for (const { feature, layer } of items) {
    const geometry = feature.geometry!;
    const parts = flatten(geometry);
    if (!options.preserveZ && parts.some((part) => hasZ(part.positions))) droppedZ++;

    for (const part of parts) {
      switch (part.kind) {
        case 'point': {
          const position = part.positions[0];
          if (options.pointMode !== 'label') writePoint(position, layer, feature);
          if (options.pointMode !== 'point') {
            const label = labelFor(feature);
            if (label) {
              writeText(position, label, layer, feature);
              labelCount++;
              if (options.labelField) textFromAttribute++;
            }
          }
          break;
        }
        case 'line':
          writePolyline(part.positions, false, layer, feature);
          break;
        case 'ring':
          writePolyline(part.positions, true, layer, feature);
          break;
        default:
          break;
      }
    }

    if (options.polygonFill && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')) {
      const rings = geometry.type === 'Polygon' ? (geometry.coordinates as Position[][]) : (geometry.coordinates as Position[][][]).flat();
      if (rings.length > 0) writeHatch(rings, layer, feature);
    }
  }

  builder.endSection();

  if (droppedZ > 0) {
    warnings.push(
      warn('DXF_Z_DROPPED', `Z values on ${droppedZ} feature(s) were written as 0.0.`, {
        count: droppedZ,
        reason: '"Preserve Z" is switched off in the conversion settings.',
        action: 'Enable "Preserve Z" to write elevations as real vertex ordinates.',
      })
    );
  }
  if (labelCount > 0) {
    warnings.push(
      warn('DXF_LABELS_WRITTEN', `${labelCount} TEXT label(s) were written${textFromAttribute > 0 ? ` from the "${options.labelField}" field` : ''}.`, {
        severity: 'info',
        count: labelCount,
        reason: 'Point labelling is enabled in the conversion settings.',
      })
    );
  }
  if (!dataset.crs) {
    warnings.push(
      warn('DXF_NO_CRS_CONTAINER', 'DXF cannot record a coordinate reference system.', {
        severity: 'info',
        reason: 'The DXF format has no CRS container, so the recipient has to be told the CRS separately.',
        action: 'Send the accompanying .prj file, or note the CRS in the drawing title block.',
      })
    );
  }

  return { text: builder.toString(), warnings };
}

interface GeometryPart {
  kind: 'point' | 'line' | 'ring';
  positions: Position[];
}

function flatten(geometry: { type: string; coordinates?: any; geometries?: any[] }): GeometryPart[] {
  switch (geometry.type) {
    case 'Point':
      return [{ kind: 'point', positions: [geometry.coordinates as Position] }];
    case 'MultiPoint':
      return (geometry.coordinates as Position[]).map((position) => ({ kind: 'point' as const, positions: [position] }));
    case 'LineString':
      return [{ kind: 'line', positions: geometry.coordinates as Position[] }];
    case 'MultiLineString':
      return (geometry.coordinates as Position[][]).map((positions) => ({ kind: 'line' as const, positions }));
    case 'Polygon':
      return (geometry.coordinates as Position[][]).map((ring) => ({ kind: 'ring' as const, positions: dropClosingVertex(ring) }));
    case 'MultiPolygon':
      return (geometry.coordinates as Position[][][])
        .flat()
        .map((ring) => ({ kind: 'ring' as const, positions: dropClosingVertex(ring) }));
    case 'GeometryCollection':
      return (geometry.geometries ?? []).flatMap((child: any) => flatten(child));
    default:
      return [];
  }
}

/**
 * A closed LWPOLYLINE must not repeat its first vertex: the closed flag already
 * implies the closing segment, and the duplicate shows up as a zero-length
 * segment in CAD.
 */
function dropClosingVertex(ring: Position[]): Position[] {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring;
}
