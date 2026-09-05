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
import { attribute, children, documentElement, parseXml, type XmlNode } from '../xml';

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
