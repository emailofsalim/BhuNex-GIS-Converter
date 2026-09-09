/**
 * OpenStreetMap XML.
 *
 * Nodes become points (only those carrying tags — an untagged node is a way's
 * vertex, not a feature) and ways become lines or, when closed and tagged as an
 * area, polygons. Relations are counted and reported: assembling multipolygon
 * relations correctly needs ring-building across member ways, which is real work
 * and is not pretended here.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { crsFromEpsg } from '../../crs/epsg';
import { deriveFields } from '../shared';
import { coordinateFormatter, formatFixed, type PrecisionPolicy } from '../../core/precision';
import { xmlEscape } from '../shared';
import { attribute, children, documentElement, parseXml, type XmlNode } from '../xml';
import type { CirGeometry } from '../../core/cir';

/** Tags that make a closed way an area rather than a ring-shaped line. */
const AREA_KEYS = new Set([
  'building',
  'landuse',
  'natural',
  'amenity',
  'leisure',
  'area',
  'waterway',
  'place',
  'boundary',
  'man_made',
  'historic',
  'military',
  'shop',
  'tourism',
  'craft',
  'office',
  'quarry',
  'mining',
]);

function readTags(node: XmlNode): Record<string, unknown> {
  const tags: Record<string, unknown> = {};
  for (const tag of children(node, 'tag')) {
    const key = attribute(tag, 'k');
    const value = attribute(tag, 'v');
    if (key) tags[key] = value ?? '';
  }
  return tags;
}

export function readOsm(text: string, source: SourceInfo): CirDataset {
  const document = parseXml(text);
  const root = documentElement(document);
  if (!root || root.local !== 'osm') {
    throw new ConversionError({
      code: 'OSM_NO_ROOT',
      what: 'The file has no <osm> root element.',
      why: 'This is not an OpenStreetMap XML document.',
      action: 'Confirm the detected format in the inspector. PBF files are not supported.',
    });
  }

  const warnings: Warning[] = [];
  const nodes = new Map<string, { position: Position; tags: Record<string, unknown> }>();

  for (const node of children(root, 'node')) {
    const id = attribute(node, 'id');
    const lat = Number(attribute(node, 'lat'));
    const lon = Number(attribute(node, 'lon'));
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    nodes.set(id, { position: [lon, lat], tags: readTags(node) });
  }

  const pointFeatures: CirFeature[] = [];
  for (const [id, node] of nodes) {
    // An untagged node exists only to give a way its shape.
    if (Object.keys(node.tags).length === 0) continue;
    pointFeatures.push({
      id,
      geometry: { type: 'Point', coordinates: node.position, dimension: 2 },
      properties: { osm_id: id, ...node.tags },
      sourceLayer: 'Points',
      sourceEntity: 'node',
    });
  }

  const lineFeatures: CirFeature[] = [];
  const areaFeatures: CirFeature[] = [];
  let missingNodes = 0;

  for (const way of children(root, 'way')) {
    const id = attribute(way, 'id') ?? String(lineFeatures.length);
    const positions: Position[] = [];
    for (const reference of children(way, 'nd')) {
      const ref = attribute(reference, 'ref');
      const node = ref ? nodes.get(ref) : undefined;
      if (node) positions.push(node.position);
      else missingNodes++;
    }
    if (positions.length < 2) continue;
    const tags = readTags(way);
    const first = positions[0];
    const last = positions[positions.length - 1];
    const closed = positions.length >= 4 && first[0] === last[0] && first[1] === last[1];
    const isArea = closed && (tags.area === 'yes' || Object.keys(tags).some((key) => AREA_KEYS.has(key)));

    const feature: CirFeature = {
      id,
      geometry: isArea
        ? { type: 'Polygon', coordinates: [positions], dimension: 2 }
        : { type: 'LineString', coordinates: positions, dimension: 2 },
      properties: { osm_id: id, ...tags },
      sourceLayer: isArea ? 'Areas' : 'Lines',
      sourceEntity: 'way',
    };
    (isArea ? areaFeatures : lineFeatures).push(feature);
  }

  const relationCount = children(root, 'relation').length;
  if (relationCount > 0) {
    warnings.push(
      warn('OSM_RELATIONS_SKIPPED', `${relationCount} relation(s) were not assembled.`, {
        count: relationCount,
        reason: 'Multipolygon and route relations must be built by stitching member ways into rings, which this reader does not do.',
        action: 'Use osmium or QGIS to expand relations before converting, if they are needed.',
      })
    );
  }
  if (missingNodes > 0) {
    warnings.push(
      warn('OSM_MISSING_NODES', `${missingNodes} way node reference(s) pointed at nodes not present in the file.`, {
        count: missingNodes,
        reason: 'The extract was cut at a bounding box, so ways crossing the edge lost their outside vertices.',
        action: 'Export with "include referenced nodes" enabled if the geometry must be complete.',
      })
    );
  }

  const layers = [];
  if (pointFeatures.length) layers.push(createLayer('Points', pointFeatures, deriveFields(pointFeatures)));
  if (lineFeatures.length) layers.push(createLayer('Lines', lineFeatures, deriveFields(lineFeatures)));
  if (areaFeatures.length) layers.push(createLayer('Areas', areaFeatures, deriveFields(areaFeatures)));

  if (layers.length === 0) {
    throw new ConversionError({
      code: 'OSM_NO_FEATURES',
      what: 'No tagged features could be read from the OSM file.',
      why: `The document holds ${nodes.size} node(s) and ${children(root, 'way').length} way(s), but none produced a feature with tags or usable geometry.`,
      action: 'Check the extract in JOSM or re-download it with tags included.',
    });
  }

  return createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    // OSM data is WGS 84 by definition.
    crs: crsFromEpsg(4326),
    crsOrigin: 'declared',
    axisOrder: 'xy',
    layers,
    warnings,
    metadata: { nodeCount: nodes.size, relationCount, generator: attribute(root, 'generator') },
  });
}

// ------------------------------------------------------------------ writing

export interface WriteOsmOptions {
  precision: PrecisionPolicy;
  /** Written into the <osm generator="..."> attribute. */
  generator?: string;
  /** Attribute keys to drop; internal provenance keys are always dropped. */
  excludeFields?: string[];
}

export const DEFAULT_OSM_OPTIONS: Omit<WriteOsmOptions, 'precision'> = {
  generator: 'BhuNex GIS Converter',
};

/**
 * Writes OpenStreetMap XML.
 *
 * Two things matter for honesty here.
 *
 * Every element gets a **negative id**. That is the OSM convention for objects
 * that do not exist in the database yet, and it is the difference between "here
 * is data shaped like OSM" and "here are edits claiming to be existing OSM
 * objects". Writing positive ids would invite an editor to treat them as
 * modifications of real features that happen to share a number.
 *
 * Polygon interior rings are **not** written. A hole in OSM is a multipolygon
 * relation, and emitting the outer ring alone would silently turn a plot with an
 * excluded area into a plot without one. The loss is reported instead.
 */
export function writeOsm(dataset: CirDataset, options: WriteOsmOptions): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  if (dataset.crs && dataset.crs.kind !== 'geographic') {
    warnings.push(
      warn('OSM_NOT_GEOGRAPHIC', `Coordinates were written without transforming from ${dataset.crs.name}.`, {
        severity: 'error',
        reason: 'OSM stores WGS 84 latitude and longitude. Projected metres are outside the ±90 / ±180 range every OSM tool accepts.',
        action: 'Set the target CRS to WGS 84 (EPSG:4326) so the coordinates are transformed before writing.',
      })
    );
  }

  const format = coordinateFormatter(options.precision, true);
  // OSM stores 7 decimal places — about 11 mm — and more is discarded by every
  // consumer, so the writer does not pretend to carry survey precision here.
  const decimals = options.precision.mode === 'full' ? 7 : Math.min(7, Math.max(6, options.precision.geographicDecimals));

  const excluded = new Set([...(options.excludeFields ?? [])]);
  const nodes: string[] = [];
  const ways: string[] = [];
  let nodeId = -1;
  let wayId = -1;
  let droppedHoles = 0;
  let droppedMulti = 0;

  const tagsFor = (properties: Record<string, unknown>): string =>
    Object.entries(properties)
      .filter(([key, value]) => !key.startsWith('_') && !excluded.has(key) && value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `<tag k="${xmlEscape(key)}" v="${xmlEscape(value)}"/>`)
      .join('');

  /** Emits a node and returns its id, so a way can reference it. */
  const emitNode = (position: Position, tags: string): number => {
    const id = nodeId--;
    const lon = formatFixed(format.x(position[0]), decimals);
    const lat = formatFixed(format.y(position[1]), decimals);
    nodes.push(`<node id="${id}" lat="${lat}" lon="${lon}" version="1"${tags ? `>${tags}</node>` : '/>'}`);
    return id;
  };

  const emitWay = (positions: Position[], tags: string, closed: boolean): void => {
    if (positions.length < 2) return;
    // A closed way repeats its first node reference rather than its first
    // coordinate: duplicating the node would leave a stray untagged point.
    const ring = closed ? positions.slice(0, -1) : positions;
    const references = ring.map((position) => emitNode(position, ''));
    if (closed) references.push(references[0]);
    ways.push(
      `<way id="${wayId--}" version="1">${references.map((reference) => `<nd ref="${reference}"/>`).join('')}${tags}</way>`
    );
  };

  const emitGeometry = (geometry: CirGeometry, tags: string): void => {
    switch (geometry.type) {
      case 'Point':
        emitNode(geometry.coordinates as Position, tags);
        break;
      case 'MultiPoint':
        for (const position of geometry.coordinates as Position[]) emitNode(position, tags);
        break;
      case 'LineString':
        emitWay(geometry.coordinates as Position[], tags, false);
        break;
      case 'MultiLineString':
        for (const line of geometry.coordinates as Position[][]) emitWay(line, tags, false);
        break;
      case 'Polygon': {
        const rings = geometry.coordinates as Position[][];
        if (rings.length > 1) droppedHoles += rings.length - 1;
        // `area=yes` is what tells an OSM consumer a closed way is a filled area
        // rather than a loop of fence.
        emitWay(rings[0] ?? [], tags.includes('k="area"') ? tags : `${tags}<tag k="area" v="yes"/>`, true);
        break;
      }
      case 'MultiPolygon': {
        const polygons = geometry.coordinates as Position[][][];
        if (polygons.length > 1) droppedMulti++;
        for (const rings of polygons) {
          if (rings.length > 1) droppedHoles += rings.length - 1;
          emitWay(rings[0] ?? [], tags.includes('k="area"') ? tags : `${tags}<tag k="area" v="yes"/>`, true);
        }
        break;
      }
      case 'GeometryCollection':
        for (const child of geometry.geometries ?? []) emitGeometry(child, tags);
        break;
      default:
        break;
    }
  };

  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      if (!feature.geometry) continue;
      const properties = { ...(feature.properties ?? {}) };
      // The layer name is meaningful organisation, and OSM has no layer concept,
      // so it is preserved as a tag rather than dropped.
      if (layer.name && properties.layer_name === undefined) properties.layer_name = layer.name;
      emitGeometry(feature.geometry, tagsFor(properties));
    }
  }

  if (droppedHoles > 0) {
    warnings.push(
      warn('OSM_HOLES_DROPPED', `${droppedHoles} interior ring(s) were not written.`, {
        count: droppedHoles,
        reason: 'A hole in OSM is a multipolygon relation, and this writer emits nodes and ways only. Writing the outer ring alone would turn a plot with an excluded area into one without.',
        action: 'Export to GeoJSON, Shapefile or GeoPackage if the holes must be preserved.',
      })
    );
  }
  if (droppedMulti > 0) {
    warnings.push(
      warn('OSM_MULTIPOLYGON_SPLIT', `${droppedMulti} multipolygon(s) were written as separate closed ways.`, {
        severity: 'info',
        count: droppedMulti,
        reason: 'Their parts are no longer grouped, because grouping requires a relation.',
        action: 'Export to GeoJSON or Shapefile to keep multi-part features together.',
      })
    );
  }
  warnings.push(
    warn('OSM_NEGATIVE_IDS', 'Elements were written with negative ids.', {
      severity: 'info',
      reason: 'Negative ids are the OSM convention for objects that do not exist in the database. Positive ids would look like edits to real, unrelated features.',
      action: 'Review the file in JOSM before any upload; this export is data shaped like OSM, not an OSM changeset.',
    })
  );

  const text =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<osm version="0.6" generator="${xmlEscape(options.generator ?? 'BhuNex GIS Converter')}">\n` +
    nodes.join('\n') +
    (nodes.length && ways.length ? '\n' : '') +
    ways.join('\n') +
    `\n</osm>\n`;

  return { text, warnings };
}
