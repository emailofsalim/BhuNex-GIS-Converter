/**
 * GML simple features.
 *
 * Handles both coordinate encodings — the GML 2 `<gml:coordinates>` string and
 * the GML 3 `<gml:pos>` / `<gml:posList>` forms — and honours srsName axis
 * order. That last part matters: EPSG defines geographic CRS as latitude-first,
 * so a GML file with srsName="EPSG:4326" stores lat,lon while the same file
 * written as urn:...:CRS84 stores lon,lat. Getting it wrong puts Indian data in
 * the Indian Ocean.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirGeometry,
  type CrsRef,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { coordinateFormatter, formatFixed, type PrecisionPolicy } from '../../core/precision';
import { crsFromEpsg } from '../../crs/epsg';
import { deriveFields, xmlEscape } from '../shared';
import { attribute, child, children, descendants, documentElement, parseXml, type XmlNode } from '../xml';

const GEOMETRY_LOCALS = new Set([
  'point',
  'linestring',
  'linearring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multicurve',
  'multipolygon',
  'multisurface',
  'multigeometry',
  'curve',
  'surface',
]);

interface AxisContext {
  /** True when the declared CRS stores latitude/northing first. */
  latitudeFirst: boolean;
  crs: CrsRef | null;
}

/**
 * Resolves srsName to a CRS and an axis order.
 *
 * `urn:ogc:def:crs:EPSG::4326` follows the authority (lat first).
 * `EPSG:4326` in GML 2 practice is lon first.
 * `urn:ogc:def:crs:OGC:1.3:CRS84` is explicitly lon first.
 */
function resolveSrs(srsName: string | undefined): AxisContext {
  if (!srsName) return { latitudeFirst: false, crs: null };
  if (/CRS84/i.test(srsName)) return { latitudeFirst: false, crs: crsFromEpsg(4326) };
  const match = srsName.match(/(\d+)\s*$/);
  const code = match ? Number(match[1]) : NaN;
  const crs = Number.isFinite(code) ? crsFromEpsg(code) : null;
  const urnStyle = /^urn:|^http:\/\/www\.opengis\.net\/def\//i.test(srsName);
  const geographic = crs?.kind === 'geographic';
  return { latitudeFirst: urnStyle && geographic, crs };
}

function parseCoordinateText(text: string, context: AxisContext, tupleSeparator = /\s+/, ordinateSeparator = ','): Position[] {
  const out: Position[] = [];
  for (const tuple of text.trim().split(tupleSeparator)) {
    if (!tuple) continue;
    const parts = tuple.split(ordinateSeparator).map(Number);
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
    const [a, b] = context.latitudeFirst ? [parts[1], parts[0]] : [parts[0], parts[1]];
    out.push(parts.length >= 3 && Number.isFinite(parts[2]) ? [a, b, parts[2]] : [a, b]);
  }
  return out;
}

/** posList is a flat run of ordinates; srsDimension says how many per position. */
function parsePosList(node: XmlNode, context: AxisContext): Position[] {
  const dimension = Number(attribute(node, 'srsDimension') ?? '2') || 2;
  const values = node.text.trim().split(/\s+/).map(Number).filter(Number.isFinite);
  const out: Position[] = [];
  for (let index = 0; index + dimension <= values.length; index += dimension) {
    const first = values[index];
    const second = values[index + 1];
    const [x, y] = context.latitudeFirst ? [second, first] : [first, second];
    out.push(dimension >= 3 ? [x, y, values[index + 2]] : [x, y]);
  }
  return out;
}

function readPositions(node: XmlNode, context: AxisContext): Position[] {
  const coordinates = child(node, 'coordinates');
  if (coordinates) {
    const ts = attribute(coordinates, 'ts') ?? ' ';
    const cs = attribute(coordinates, 'cs') ?? ',';
    return parseCoordinateText(coordinates.text, context, new RegExp(`[${ts.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s]+`), cs);
  }
  const posList = child(node, 'posList');
  if (posList) return parsePosList(posList, context);
  const positions: Position[] = [];
  for (const pos of children(node, 'pos')) positions.push(...parsePosList(pos, context));
  if (positions.length > 0) return positions;
  // Some producers nest the coordinate container one level deeper.
  for (const nested of node.children) {
    const found = readPositions(nested, context);
    if (found.length > 0) return found;
  }
  return [];
}

function readGeometry(node: XmlNode, context: AxisContext): CirGeometry | null {
  const dimensionOf = (positions: Position[]): 2 | 3 => (positions.some((p) => p.length >= 3) ? 3 : 2);

  switch (node.local) {
    case 'point': {
      const positions = readPositions(node, context);
      return positions.length ? { type: 'Point', coordinates: positions[0], dimension: dimensionOf(positions) } : null;
    }
    case 'linestring':
    case 'linearring':
    case 'curve': {
      const positions = readPositions(node, context);
      return positions.length >= 2 ? { type: 'LineString', coordinates: positions, dimension: dimensionOf(positions) } : null;
    }
    case 'polygon':
    case 'surface': {
      const rings: Position[][] = [];
      for (const local of ['exterior', 'outerBoundaryIs']) {
        const boundary = child(node, local);
        const ring = boundary ? descendants(boundary, 'linearring')[0] : undefined;
        if (ring) rings.push(readPositions(ring, context));
      }
      for (const local of ['interior', 'innerBoundaryIs']) {
        for (const boundary of children(node, local)) {
          const ring = descendants(boundary, 'linearring')[0];
          if (ring) rings.push(readPositions(ring, context));
        }
      }
      if (rings.length === 0) {
        // gml:Surface wraps its rings in patches; fall back to any LinearRing.
        for (const ring of descendants(node, 'linearring')) rings.push(readPositions(ring, context));
      }
      const usable = rings.filter((ring) => ring.length >= 4);
      return usable.length ? { type: 'Polygon', coordinates: usable, dimension: dimensionOf(usable.flat()) } : null;
    }
    case 'multipoint':
    case 'multilinestring':
    case 'multicurve':
    case 'multipolygon':
    case 'multisurface':
    case 'multigeometry': {
      const parts: CirGeometry[] = [];
      for (const member of [...children(node, 'pointMember'), ...children(node, 'lineStringMember'), ...children(node, 'polygonMember'), ...children(node, 'geometryMember'), ...children(node, 'curveMember'), ...children(node, 'surfaceMember'), ...children(node, 'pointMembers'), ...children(node, 'surfaceMembers')]) {
        for (const candidate of member.children) {
          const geometry = readGeometry(candidate, context);
          if (geometry) parts.push(geometry);
        }
      }
      if (parts.length === 0) return null;
      const dimension = parts.reduce<2 | 3 | 4>((max, part) => (part.dimension > max ? part.dimension : max), 2);
      const types = new Set(parts.map((part) => part.type));
      if (types.size === 1) {
        const only = parts[0].type;
        if (only === 'Point') return { type: 'MultiPoint', coordinates: parts.map((p) => p.coordinates), dimension };
        if (only === 'LineString') return { type: 'MultiLineString', coordinates: parts.map((p) => p.coordinates), dimension };
        if (only === 'Polygon') return { type: 'MultiPolygon', coordinates: parts.map((p) => p.coordinates), dimension };
      }
      return { type: 'GeometryCollection', geometries: parts, dimension };
    }
    default:
      return null;
  }
}

export function readGml(text: string, source: SourceInfo): CirDataset {
  const document = parseXml(text);
  const root = documentElement(document);
  if (!root) {
    throw new ConversionError({
      code: 'GML_NO_ROOT',
      what: 'The file has no XML root element.',
      why: 'The document is empty or malformed.',
      action: 'Open the file in a text editor to check it transferred completely.',
    });
  }

  const warnings: Warning[] = [];
  const documentSrs = attribute(root, 'srsName');
  const rootContext = resolveSrs(documentSrs);

  /** Feature members are the children of featureMember/featureMembers wrappers. */
  const memberNodes: XmlNode[] = [];
  for (const local of ['featuremember', 'featuremembers', 'member']) {
    for (const wrapper of descendants(root, local)) memberNodes.push(...wrapper.children);
  }
  if (memberNodes.length === 0) {
    // Some producers put feature elements directly under the root.
    for (const candidate of root.children) {
      if (descendants(candidate, 'point').length || descendants(candidate, 'polygon').length || descendants(candidate, 'linestring').length) {
        memberNodes.push(candidate);
      }
    }
  }

  const byType = new Map<string, CirFeature[]>();
  let unresolvedAxis = 0;

  for (const member of memberNodes) {
    const geometryNode = findGeometry(member);
    if (!geometryNode) continue;
    const srsName = attribute(geometryNode, 'srsName') ?? findSrsName(member) ?? documentSrs;
    const context = srsName ? resolveSrs(srsName) : rootContext;
    if (!srsName) unresolvedAxis++;
    const geometry = readGeometry(geometryNode, context);
    if (!geometry) continue;

    const properties: Record<string, unknown> = {};
    for (const candidate of member.children) {
      if (GEOMETRY_LOCALS.has(candidate.local) || candidate.children.some((c) => GEOMETRY_LOCALS.has(c.local))) continue;
      const value = candidate.text.trim();
      if (value) properties[candidate.name.replace(/^[^:]+:/, '')] = Number.isFinite(Number(value)) ? Number(value) : value;
    }
    const gmlId = attribute(member, 'id');
    if (gmlId) properties.gml_id = gmlId;

    const typeName = member.name.replace(/^[^:]+:/, '');
    const list = byType.get(typeName) ?? [];
    list.push({ id: gmlId ?? list.length, geometry, properties, sourceLayer: typeName, sourceEntity: geometryNode.name });
    byType.set(typeName, list);
  }

  if (byType.size === 0) {
    throw new ConversionError({
      code: 'GML_NO_FEATURES',
      what: 'No GML geometry could be read.',
      why: `The document has ${memberNodes.length} member element(s) but none carried a readable gml:Point, LineString, Polygon or Multi* geometry.`,
      action: 'The file may use an application schema with curved primitives, which this reader does not interpret. Convert it in QGIS or GDAL first.',
    });
  }

  if (rootContext.crs) {
    warnings.push(
      warn(
        'GML_AXIS_ORDER',
        `srsName "${documentSrs}" was read as ${rootContext.latitudeFirst ? 'latitude/northing first (authority order)' : 'longitude/easting first'}.`,
        {
          severity: 'info',
          reason: 'EPSG defines geographic CRS as latitude-first, but the short "EPSG:4326" form is written longitude-first in practice. The URN form is treated as authority order.',
          action: 'Check a known point in the inspector if the geometry appears transposed.',
        }
      )
    );
  }
  if (unresolvedAxis > 0) {
    warnings.push(
      warn('GML_NO_SRSNAME', `${unresolvedAxis} geometr${unresolvedAxis === 1 ? 'y has' : 'ies have'} no srsName.`, {
        count: unresolvedAxis,
        reason: 'Without srsName the axis order cannot be derived from the file.',
        action: 'Select the source CRS and confirm the coordinate order before converting.',
      })
    );
  }

  return createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    crs: rootContext.crs,
    crsOrigin: rootContext.crs ? 'declared' : 'unknown',
    axisOrder: 'xy',
    layers: [...byType.entries()].map(([name, features]) => createLayer(name, features, deriveFields(features))),
    warnings,
    metadata: { srsName: documentSrs, featureTypes: [...byType.keys()] },
  });
}

function findGeometry(node: XmlNode): XmlNode | undefined {
  for (const candidate of node.children) {
    if (GEOMETRY_LOCALS.has(candidate.local)) return candidate;
    const nested = findGeometry(candidate);
    if (nested) return nested;
  }
  return undefined;
}

function findSrsName(node: XmlNode): string | undefined {
  const direct = attribute(node, 'srsName');
  if (direct) return direct;
  for (const candidate of node.children) {
    const nested = findSrsName(candidate);
    if (nested) return nested;
  }
  return undefined;
}

export interface WriteGmlOptions {
  precision: PrecisionPolicy;
  featureTypeName?: string;
  /** Write srsName in the URN form, which implies authority axis order. */
  useUrnSrs?: boolean;
}

export function writeGml(dataset: CirDataset, options: WriteGmlOptions): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const geographic = dataset.crs?.kind === 'geographic';
  const format = coordinateFormatter(options.precision, geographic);
  const decimals = options.precision.mode === 'full' ? 15 : geographic ? options.precision.geographicDecimals : options.precision.linearDecimals;

  const epsg = dataset.crs?.epsg;
  // The short form is written longitude-first, which is what almost every
  // consumer expects; the URN form would demand authority order.
  const srsName = epsg ? (options.useUrnSrs ? `urn:ogc:def:crs:EPSG::${epsg}` : `EPSG:${epsg}`) : undefined;
  const latitudeFirst = Boolean(options.useUrnSrs && geographic);
  const srsAttribute = srsName ? ` srsName="${srsName}"` : '';

  if (!srsName) {
    warnings.push(
      warn('GML_NO_SRS_WRITTEN', 'No srsName was written because the dataset CRS has no EPSG code.', {
        reason: 'GML identifies its CRS by srsName; an undeclared or custom CRS has no code to write.',
        action: 'Select an EPSG-coded target CRS so consumers can georeference the output.',
      })
    );
  }

  const posList = (positions: Position[]): string =>
    positions
      .map((position) => {
        const x = formatFixed(format.x(position[0]), decimals);
        const y = formatFixed(format.y(position[1]), decimals);
        return latitudeFirst ? `${y} ${x}` : `${x} ${y}`;
      })
      .join(' ');

  const geometryXml = (geometry: CirGeometry): string => {
    switch (geometry.type) {
      case 'Point':
        return `<gml:Point${srsAttribute}><gml:pos>${posList([geometry.coordinates as Position])}</gml:pos></gml:Point>`;
      case 'MultiPoint':
        return `<gml:MultiPoint${srsAttribute}>${(geometry.coordinates as Position[])
          .map((position) => `<gml:pointMember><gml:Point><gml:pos>${posList([position])}</gml:pos></gml:Point></gml:pointMember>`)
          .join('')}</gml:MultiPoint>`;
      case 'LineString':
        return `<gml:LineString${srsAttribute}><gml:posList>${posList(geometry.coordinates as Position[])}</gml:posList></gml:LineString>`;
      case 'MultiLineString':
        return `<gml:MultiLineString${srsAttribute}>${(geometry.coordinates as Position[][])
          .map((line) => `<gml:lineStringMember><gml:LineString><gml:posList>${posList(line)}</gml:posList></gml:LineString></gml:lineStringMember>`)
          .join('')}</gml:MultiLineString>`;
      case 'Polygon': {
        const rings = geometry.coordinates as Position[][];
        const exterior = `<gml:exterior><gml:LinearRing><gml:posList>${posList(rings[0] ?? [])}</gml:posList></gml:LinearRing></gml:exterior>`;
        const interiors = rings
          .slice(1)
          .map((ring) => `<gml:interior><gml:LinearRing><gml:posList>${posList(ring)}</gml:posList></gml:LinearRing></gml:interior>`)
          .join('');
        return `<gml:Polygon${srsAttribute}>${exterior}${interiors}</gml:Polygon>`;
      }
      case 'MultiPolygon':
        return `<gml:MultiSurface${srsAttribute}>${(geometry.coordinates as Position[][][])
          .map((rings) => `<gml:surfaceMember>${geometryXml({ type: 'Polygon', coordinates: rings, dimension: geometry.dimension })}</gml:surfaceMember>`)
          .join('')}</gml:MultiSurface>`;
      case 'GeometryCollection':
        return `<gml:MultiGeometry${srsAttribute}>${(geometry.geometries ?? [])
          .map((child) => `<gml:geometryMember>${geometryXml(child)}</gml:geometryMember>`)
          .join('')}</gml:MultiGeometry>`;
      default:
        return '';
    }
  };

  const typeName = options.featureTypeName ?? 'feature';
  const members: string[] = [];
  let droppedZ = 0;
  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      if (!feature.geometry) continue;
      if (feature.geometry.dimension >= 3) droppedZ++;
      const properties = Object.entries(feature.properties ?? {})
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, value]) => `<ugc:${sanitizeTag(key)}>${xmlEscape(value)}</ugc:${sanitizeTag(key)}>`)
        .join('');
      members.push(
        `<gml:featureMember><ugc:${typeName}${feature.id !== undefined ? ` gml:id="${xmlEscape(String(feature.id))}"` : ''}>` +
          `${properties}<ugc:geometry>${geometryXml(feature.geometry)}</ugc:geometry>` +
          `</ugc:${typeName}></gml:featureMember>`
      );
    }
  }

  if (droppedZ > 0) {
    warnings.push(
      warn('GML_Z_DROPPED', `Z values on ${droppedZ} feature(s) were not written.`, {
        count: droppedZ,
        reason: 'The writer emits two-dimensional posList values so that consumers reading srsDimension="2" are not misled.',
        action: 'Export to GeoJSON, DXF or Shapefile (PolygonZ) to keep elevations.',
      })
    );
  }

  const text =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ugc:FeatureCollection xmlns:gml="http://www.opengis.net/gml" xmlns:ugc="http://universal-geo-converter.local/ns">\n` +
    members.join('\n') +
    `\n</ugc:FeatureCollection>\n`;

  return { text, warnings };
}

function sanitizeTag(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[^A-Za-z_]/, '_');
  return cleaned || 'field';
}
