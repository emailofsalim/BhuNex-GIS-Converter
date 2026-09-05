/**
 * TopoJSON.
 *
 * Reading is complete: arcs are dequantized, delta-decoded and stitched, with
 * negative arc indices meaning "reverse the arc" (~i = -i-1). Writing is honest
 * about being partial — one arc per ring or line, with no shared-arc detection —
 * so the output is valid TopoJSON but not topologically minimal.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirGeometry,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { coordinateFormatter, roundTo, type PrecisionPolicy } from '../../core/precision';
import { deriveFields } from '../shared';

interface Transform {
  scale: [number, number];
  translate: [number, number];
}

function decodeArc(arc: number[][], transform: Transform | null): Position[] {
  const out: Position[] = [];
  let x = 0;
  let y = 0;
  for (const point of arc) {
    if (transform) {
      // Quantized arcs store deltas; the running sum is the actual position.
      x += point[0];
      y += point[1];
      out.push([x * transform.scale[0] + transform.translate[0], y * transform.scale[1] + transform.translate[1]]);
    } else {
      out.push([point[0], point[1]]);
    }
  }
  return out;
}

export function readTopoJson(text: string, source: SourceInfo): CirDataset {
  let topology: any;
  try {
    topology = JSON.parse(text);
  } catch (error) {
    throw new ConversionError({
      code: 'TOPOJSON_INVALID_JSON',
      what: 'The file could not be parsed as JSON.',
      why: error instanceof Error ? error.message : String(error),
      action: 'Validate the file in a JSON linter or re-export it.',
    });
  }
  if (topology?.type !== 'Topology' || !topology.objects) {
    throw new ConversionError({
      code: 'TOPOJSON_NOT_TOPOLOGY',
      what: 'The file is valid JSON but is not TopoJSON.',
      why: 'A TopoJSON document must have type "Topology" and an "objects" member.',
      action: 'If this is plain GeoJSON, confirm the format in the inspector and convert again.',
    });
  }

  const transform: Transform | null = topology.transform ?? null;
  const arcs: Position[][] = (topology.arcs ?? []).map((arc: number[][]) => decodeArc(arc, transform));
  const warnings: Warning[] = [];

  /** Stitches an arc index list into one ring or line. */
  const stitch = (indices: number[]): Position[] => {
    const out: Position[] = [];
    for (const index of indices) {
      const reversed = index < 0;
      const arc = arcs[reversed ? ~index : index];
      if (!arc) continue;
      const positions = reversed ? [...arc].reverse() : arc;
      // Consecutive arcs share their join vertex; keeping both would create a
      // zero-length segment on every arc boundary.
      for (let cursor = out.length > 0 ? 1 : 0; cursor < positions.length; cursor++) out.push(positions[cursor]);
    }
    return out;
  };

  const toGeometry = (object: any): CirGeometry | null => {
    switch (object?.type) {
      case 'Point':
        return { type: 'Point', coordinates: applyTransform(object.coordinates, transform), dimension: 2 };
      case 'MultiPoint':
        return { type: 'MultiPoint', coordinates: (object.coordinates ?? []).map((p: number[]) => applyTransform(p, transform)), dimension: 2 };
      case 'LineString':
        return { type: 'LineString', coordinates: stitch(object.arcs ?? []), dimension: 2 };
      case 'MultiLineString':
        return { type: 'MultiLineString', coordinates: (object.arcs ?? []).map(stitch), dimension: 2 };
      case 'Polygon':
        return { type: 'Polygon', coordinates: (object.arcs ?? []).map(stitch), dimension: 2 };
      case 'MultiPolygon':
        return {
          type: 'MultiPolygon',
          coordinates: (object.arcs ?? []).map((rings: number[][]) => rings.map(stitch)),
          dimension: 2,
        };
      case 'GeometryCollection':
        return {
          type: 'GeometryCollection',
          geometries: (object.geometries ?? []).map(toGeometry).filter(Boolean),
          dimension: 2,
        };
      default:
        return null;
    }
  };

  const layers = Object.entries(topology.objects).map(([name, object]: [string, any]) => {
    const features: CirFeature[] = [];
    const collect = (node: any, index: number): void => {
      if (node?.type === 'GeometryCollection') {
        (node.geometries ?? []).forEach(collect);
        return;
      }
      const geometry = toGeometry(node);
      if (!geometry) return;
      features.push({ id: node.id ?? index, geometry, properties: { ...(node.properties ?? {}) } });
    };
    collect(object, 0);
    return createLayer(name, features, deriveFields(features));
  });

  if (layers.every((layer) => layer.features.length === 0)) {
    throw new ConversionError({
      code: 'TOPOJSON_NO_FEATURES',
      what: 'No geometry could be read from the topology.',
      why: `The document declares ${Object.keys(topology.objects).length} object(s) and ${arcs.length} arc(s), but no object resolved to geometry.`,
      action: 'Check that the objects reference valid arc indices.',
    });
  }

  warnings.push(
    warn('TOPOJSON_2D', 'TopoJSON carries 2D coordinates only; no elevations were read.', {
      severity: 'info',
      reason: 'The TopoJSON specification has no Z ordinate.',
    })
  );

  return createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    crs: null,
    crsOrigin: 'unknown',
    axisOrder: 'xy',
    layers,
    warnings,
    metadata: { arcCount: arcs.length, quantized: transform !== null },
  });
}

function applyTransform(point: number[], transform: Transform | null): Position {
  if (!transform) return [point[0], point[1]];
  return [point[0] * transform.scale[0] + transform.translate[0], point[1] * transform.scale[1] + transform.translate[1]];
}

export interface WriteTopoJsonOptions {
  precision: PrecisionPolicy;
  /** Quantize coordinates onto an integer grid to shrink the file. */
  quantization?: number;
}

export function writeTopoJson(dataset: CirDataset, options: WriteTopoJsonOptions): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = [
    warn('TOPOJSON_NO_ARC_SHARING', 'Arcs were written one per ring or line, without shared-arc detection.', {
      severity: 'info',
      reason: 'The writer does not compute shared boundaries, so the output is valid TopoJSON but is not topologically minimal.',
      action: 'Run the file through the topojson toolchain if minimal shared arcs are required.',
    }),
  ];

  const geographic = dataset.crs?.kind === 'geographic';
  const format = coordinateFormatter(options.precision, geographic);
  const arcs: Position[][] = [];
  const pushArc = (positions: Position[]): number => {
    arcs.push(positions.map((position) => [format.x(position[0]), format.y(position[1])] as Position));
    return arcs.length - 1;
  };

  const objects: Record<string, any> = {};
  let droppedZ = 0;

  for (const layer of dataset.layers) {
    const geometries: any[] = [];
    for (const feature of layer.features) {
      const geometry = feature.geometry;
      if (!geometry) continue;
      if (geometry.dimension >= 3) droppedZ++;
      switch (geometry.type) {
        case 'Point':
          geometries.push({ type: 'Point', coordinates: (geometry.coordinates as Position).slice(0, 2), properties: feature.properties, id: feature.id });
          break;
        case 'MultiPoint':
          geometries.push({
            type: 'MultiPoint',
            coordinates: (geometry.coordinates as Position[]).map((p) => p.slice(0, 2)),
            properties: feature.properties,
            id: feature.id,
          });
          break;
        case 'LineString':
          geometries.push({ type: 'LineString', arcs: [pushArc(geometry.coordinates as Position[])], properties: feature.properties, id: feature.id });
          break;
        case 'MultiLineString':
          geometries.push({
            type: 'MultiLineString',
            arcs: (geometry.coordinates as Position[][]).map((line) => [pushArc(line)]),
            properties: feature.properties,
            id: feature.id,
          });
          break;
        case 'Polygon':
          geometries.push({
            type: 'Polygon',
            arcs: (geometry.coordinates as Position[][]).map((ring) => [pushArc(ring)]),
            properties: feature.properties,
            id: feature.id,
          });
          break;
        case 'MultiPolygon':
          geometries.push({
            type: 'MultiPolygon',
            arcs: (geometry.coordinates as Position[][][]).map((rings) => rings.map((ring) => [pushArc(ring)])),
            properties: feature.properties,
            id: feature.id,
          });
          break;
        default:
          break;
      }
    }
    objects[layer.name] = { type: 'GeometryCollection', geometries };
  }

  if (droppedZ > 0) {
    warnings.push(
      warn('TOPOJSON_Z_DROPPED', `Z values on ${droppedZ} feature(s) were not written.`, {
        count: droppedZ,
        reason: 'TopoJSON has no Z ordinate.',
        action: 'Export to GeoJSON, DXF or Shapefile (PolygonZ/PolyLineZ) to keep elevations.',
      })
    );
  }

  const topology: Record<string, unknown> = { type: 'Topology' };
  if (options.quantization && options.quantization > 1 && arcs.length > 0) {
    const flat = arcs.flat();
    const minX = Math.min(...flat.map((p) => p[0]));
    const minY = Math.min(...flat.map((p) => p[1]));
    const maxX = Math.max(...flat.map((p) => p[0]));
    const maxY = Math.max(...flat.map((p) => p[1]));
    const scale: [number, number] = [
      (maxX - minX) / (options.quantization - 1) || 1,
      (maxY - minY) / (options.quantization - 1) || 1,
    ];
    const translate: [number, number] = [minX, minY];
    topology.transform = { scale, translate };
    topology.arcs = arcs.map((arc) => {
      let previousX = 0;
      let previousY = 0;
      return arc.map((position) => {
        const x = Math.round((position[0] - translate[0]) / scale[0]);
        const y = Math.round((position[1] - translate[1]) / scale[1]);
        const delta = [x - previousX, y - previousY];
        previousX = x;
        previousY = y;
        return delta;
      });
    });
  } else {
    const decimals = options.precision.mode === 'full' ? 15 : geographic ? options.precision.geographicDecimals : options.precision.linearDecimals;
    topology.arcs = arcs.map((arc) => arc.map((position) => [roundTo(position[0], decimals), roundTo(position[1], decimals)]));
  }
  topology.objects = objects;

  return { text: JSON.stringify(topology) + '\n', warnings };
}
