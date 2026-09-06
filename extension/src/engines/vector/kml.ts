/**
 * KML and KMZ.
 *
 * KML is defined in WGS 84 longitude/latitude, so projected input must be
 * transformed before it reaches the writer — the pipeline does that and records
 * the transform. The reader keeps the Folder hierarchy as CIR layers, because a
 * mine plan's folder structure is meaningful organisation, not decoration.
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
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { coordinateFormatter, formatFixed, type PrecisionPolicy } from '../../core/precision';
import { crsFromEpsg } from '../../crs/epsg';
import { readZip, writeZip } from '../archives/zip';
import { deriveFields, encodeText, xmlEscape } from '../shared';
import { attribute, child, childText, children, decodeEntities, descendants, documentElement, parseXml, type XmlNode } from '../xml';

/** KML coordinate tuples are `lon,lat[,alt]` separated by whitespace. */
function parseCoordinates(text: string): Position[] {
  const out: Position[] = [];
  for (const token of text.trim().split(/\s+/)) {
    if (!token) continue;
    const parts = token.split(',');
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const alt = parts.length > 2 ? Number(parts[2]) : NaN;
    out.push(Number.isFinite(alt) ? [lon, lat, alt] : [lon, lat]);
  }
  return out;
}

function dimensionOf(positions: Position[]): 2 | 3 {
  return positions.some((position) => position.length >= 3) ? 3 : 2;
}

function readGeometryNode(node: XmlNode, warnings: Warning[]): CirGeometry | null {
  switch (node.local) {
    case 'point': {
      const positions = parseCoordinates(childText(node, 'coordinates'));
      if (positions.length === 0) return null;
      return { type: 'Point', coordinates: positions[0], dimension: dimensionOf(positions) };
    }
    case 'linestring':
    case 'linearring': {
      const positions = parseCoordinates(childText(node, 'coordinates'));
      if (positions.length < 2) return null;
      return { type: 'LineString', coordinates: positions, dimension: dimensionOf(positions) };
    }
    case 'polygon': {
      const rings: Position[][] = [];
      const outer = child(node, 'outerBoundaryIs');
      const outerRing = outer ? child(outer, 'LinearRing') : undefined;
      if (outerRing) rings.push(parseCoordinates(childText(outerRing, 'coordinates')));
      for (const inner of children(node, 'innerBoundaryIs')) {
        const innerRing = child(inner, 'LinearRing');
        if (innerRing) rings.push(parseCoordinates(childText(innerRing, 'coordinates')));
      }
      const usable = rings.filter((ring) => ring.length >= 4);
      if (usable.length === 0) return null;
      return { type: 'Polygon', coordinates: usable, dimension: dimensionOf(usable.flat()) };
    }
    case 'multigeometry': {
      const parts = node.children.map((childNode) => readGeometryNode(childNode, warnings)).filter(Boolean) as CirGeometry[];
      if (parts.length === 0) return null;
      // Collapse to a homogeneous Multi* when every part shares a type; that is
      // what GIS consumers expect, and it survives a Shapefile round trip.
      const types = new Set(parts.map((part) => part.type));
      const dimension = parts.reduce<2 | 3 | 4>((max, part) => (part.dimension > max ? part.dimension : max), 2);
      if (types.size === 1) {
        const only = parts[0].type;
        if (only === 'Point') return { type: 'MultiPoint', coordinates: parts.map((part) => part.coordinates), dimension };
        if (only === 'LineString') return { type: 'MultiLineString', coordinates: parts.map((part) => part.coordinates), dimension };
        if (only === 'Polygon') return { type: 'MultiPolygon', coordinates: parts.map((part) => part.coordinates), dimension };
      }
      return { type: 'GeometryCollection', geometries: parts, dimension };
    }
    case 'model':
    case 'track':
    case 'gx:track':
      warnings.push(
        warn('KML_UNSUPPORTED_GEOMETRY', `A <${node.name}> element was skipped.`, {
          reason: 'Models and gx:Track carry time-stamped or 3D-model geometry that has no equivalent in the vector model.',
          action: 'Export the geometry as Placemarks from the source application.',
        })
      );
      return null;
    default:
      return null;
  }
}

function readExtendedData(placemark: XmlNode): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const extended = child(placemark, 'ExtendedData');
  if (!extended) return properties;
  for (const data of children(extended, 'Data')) {
    const name = attribute(data, 'name');
    if (name) properties[name] = childText(data, 'value') || data.text.trim();
  }
  for (const schemaData of children(extended, 'SchemaData')) {
    for (const simple of children(schemaData, 'SimpleData')) {
      const name = attribute(simple, 'name');
      if (name) properties[name] = simple.text.trim();
    }
  }
  return properties;
}

export function readKml(text: string, source: SourceInfo): CirDataset {
  const document = parseXml(text);
  const root = documentElement(document);
  if (!root || root.local !== 'kml') {
    throw new ConversionError({
      code: 'KML_NO_ROOT',
      what: 'The file has no <kml> root element.',
      why: 'A KML document must be rooted at <kml>. This may be a KMZ that was not unpacked, or a different XML dialect.',
      action: 'Confirm the detected format in the inspector, or unpack the KMZ and add doc.kml directly.',
    });
  }

  const warnings: Warning[] = [];
  // Keyed by the joined folder path, but the segments are kept alongside: KML
  // folders nest arbitrarily, and that nesting is what the layout engine rebuilds
  // as real directories on the way out.
  const layers = new Map<string, { path: string[]; features: CirFeature[] }>();

  /** Folder names build the layer path, so "Pit / Bench_Crest" stays legible. */
  const walk = (node: XmlNode, path: string[]): void => {
    for (const candidate of node.children) {
      if (candidate.local === 'folder' || candidate.local === 'document') {
        const name = childText(candidate, 'name');
        walk(candidate, name ? [...path, name] : path);
        continue;
      }
      if (candidate.local !== 'placemark') {
        walk(candidate, path);
        continue;
      }
      const geometryNode = candidate.children.find((c) =>
        ['point', 'linestring', 'linearring', 'polygon', 'multigeometry', 'model', 'track'].includes(c.local)
      );
      const geometry = geometryNode ? readGeometryNode(geometryNode, warnings) : null;
      const properties = readExtendedData(candidate);
      const name = childText(candidate, 'name');
      const description = childText(candidate, 'description');
      if (name) properties.name = name;
      if (description) properties.description = decodeEntities(description);
      const styleUrl = childText(candidate, 'styleUrl');
      if (styleUrl) properties._styleUrl = styleUrl;

      const segments = path.length > 0 ? path : [source.fileName];
      const layerName = segments.join(' / ');
      const entry = layers.get(layerName) ?? { path: segments, features: [] };
      entry.features.push({
        id: attribute(candidate, 'id') ?? entry.features.length,
        geometry,
        properties,
        sourceLayer: layerName,
        sourceEntity: 'Placemark',
      });
      layers.set(layerName, entry);
    }
  };

  walk(root, []);

  const placemarkCount = descendants(root, 'placemark').length;
  const readCount = [...layers.values()].reduce((sum, entry) => sum + entry.features.length, 0);
  if (placemarkCount > 0 && readCount === 0) {
    throw new ConversionError({
      code: 'KML_NO_GEOMETRY',
      what: `The document holds ${placemarkCount} Placemark(s) but none carried readable geometry.`,
      why: 'The Placemarks contain only Models, gx:Tracks or empty coordinate elements.',
      action: 'Re-export the data as points, lines or polygons from the source application.',
    });
  }

  const cirLayers: CirLayer[] = [...layers.values()].map((entry) =>
    createLayer(entry.path[entry.path.length - 1], entry.features, deriveFields(entry.features), entry.path)
  );

  return createDataset({
    kind: 'vector',
    name: childText(root, 'name') || source.fileName,
    source,
    // KML is defined as WGS 84; this is the specification, not an assumption.
    crs: crsFromEpsg(4326),
    crsOrigin: 'declared',
    axisOrder: 'xy',
    vertical: { kind: 'unknown' },
    layers: cirLayers.length > 0 ? cirLayers : [createLayer(source.fileName, [], [])],
    warnings,
  });
}

export async function readKmz(bytes: Uint8Array, source: SourceInfo): Promise<CirDataset> {
  const entries = await readZip(bytes);
  const kmlEntry =
    entries.find((entry) => entry.name.toLowerCase() === 'doc.kml') ?? entries.find((entry) => entry.name.toLowerCase().endsWith('.kml'));
  if (!kmlEntry) {
    throw new ConversionError({
      code: 'KMZ_NO_KML',
      what: 'The KMZ archive contains no .kml document.',
      why: `The archive holds ${entries.length} file(s), none of which is a KML document.`,
      action: 'Open the archive to check its contents; it may be a plain ZIP that was renamed.',
    });
  }
  const dataset = readKml(new TextDecoder().decode(kmlEntry.bytes), source);
  const resources = entries.filter((entry) => entry !== kmlEntry).map((entry) => entry.name);
  if (resources.length > 0) {
    dataset.warnings.push(
      warn('KMZ_RESOURCES_NOT_CARRIED', `${resources.length} embedded resource(s) in the KMZ were not carried into the conversion.`, {
        severity: 'info',
        count: resources.length,
        reason: 'Icons, overlays and images are presentation resources with no place in the vector model.',
        action: 'Extract them from the KMZ directly if they are needed.',
        detail: { resources: resources.slice(0, 20) },
      })
    );
  }
  return dataset;
}

export type AltitudeMode = 'clampToGround' | 'relativeToGround' | 'absolute';

export interface WriteKmlOptions {
  precision: PrecisionPolicy;
  altitudeMode: AltitudeMode;
  /** Write folders from the CIR layer names. */
  useFolders: boolean;
  /** Field used for the Placemark name. */
  labelField?: string;
  /** Emit an attribute table in the description balloon. */
  descriptionTable: boolean;
  lineColor: string;
  lineWidth: number;
  polygonFill: boolean;
  polygonColor: string;
  documentName?: string;
}

export const DEFAULT_KML_OPTIONS: Omit<WriteKmlOptions, 'precision'> = {
  altitudeMode: 'clampToGround',
  useFolders: true,
  descriptionTable: true,
  lineColor: '#0e7c86',
  lineWidth: 2,
  polygonFill: true,
  polygonColor: '#0e7c86',
};

/** KML colours are aabbggrr — the reverse of the usual #rrggbb. */
function kmlColor(hex: string, alpha = 'ff'): string {
  const clean = hex.replace('#', '').padEnd(6, '0');
  return `${alpha}${clean.slice(4, 6)}${clean.slice(2, 4)}${clean.slice(0, 2)}`.toLowerCase();
}

export function writeKml(dataset: CirDataset, options: WriteKmlOptions): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const geographic = dataset.crs?.kind === 'geographic';
  if (!geographic) {
    warnings.push(
      warn('KML_NOT_GEOGRAPHIC', `Coordinates were written without transforming from ${dataset.crs?.name ?? 'an undeclared CRS'}.`, {
        severity: 'error',
        reason: 'KML is defined in WGS 84 longitude/latitude. Projected values written into a KML place the geometry in the wrong part of the world.',
        action: 'Set the target CRS to WGS 84 (EPSG:4326) so the coordinates are transformed before writing.',
      })
    );
  }

  const format = coordinateFormatter(options.precision, true);
  const decimals = options.precision.mode === 'full' ? 15 : options.precision.geographicDecimals;
  const elevationDecimals = options.precision.mode === 'full' ? 15 : options.precision.elevationDecimals;
  const hasAltitude = options.altitudeMode !== 'clampToGround';

  const coordinate = (position: Position): string => {
    const lon = formatFixed(format.x(position[0]), decimals);
    const lat = formatFixed(format.y(position[1]), decimals);
    if (hasAltitude && position.length > 2 && Number.isFinite(position[2])) {
      return `${lon},${lat},${formatFixed(format.z(position[2]), elevationDecimals)}`;
    }
    return `${lon},${lat},0`;
  };

  const geometryXml = (geometry: CirGeometry): string => {
    const altitude = `<altitudeMode>${options.altitudeMode}</altitudeMode>`;
    const extrude = hasAltitude ? '<extrude>0</extrude>' : '';
    switch (geometry.type) {
      case 'Point':
        return `<Point>${altitude}<coordinates>${coordinate(geometry.coordinates as Position)}</coordinates></Point>`;
      case 'MultiPoint':
        return `<MultiGeometry>${(geometry.coordinates as Position[])
          .map((position) => `<Point>${altitude}<coordinates>${coordinate(position)}</coordinates></Point>`)
          .join('')}</MultiGeometry>`;
      case 'LineString':
        return `<LineString>${extrude}<tessellate>1</tessellate>${altitude}<coordinates>${(geometry.coordinates as Position[])
          .map(coordinate)
          .join(' ')}</coordinates></LineString>`;
      case 'MultiLineString':
        return `<MultiGeometry>${(geometry.coordinates as Position[][])
          .map(
            (line) =>
              `<LineString>${extrude}<tessellate>1</tessellate>${altitude}<coordinates>${line.map(coordinate).join(' ')}</coordinates></LineString>`
          )
          .join('')}</MultiGeometry>`;
      case 'Polygon': {
        const rings = geometry.coordinates as Position[][];
        const outer = rings[0] ?? [];
        const inner = rings.slice(1);
        return (
          `<Polygon>${extrude}<tessellate>1</tessellate>${altitude}` +
          `<outerBoundaryIs><LinearRing><coordinates>${outer.map(coordinate).join(' ')}</coordinates></LinearRing></outerBoundaryIs>` +
          inner
            .map(
              (ring) =>
                `<innerBoundaryIs><LinearRing><coordinates>${ring.map(coordinate).join(' ')}</coordinates></LinearRing></innerBoundaryIs>`
            )
            .join('') +
          `</Polygon>`
        );
      }
      case 'MultiPolygon':
        return `<MultiGeometry>${(geometry.coordinates as Position[][][])
          .map((rings) => geometryXml({ type: 'Polygon', coordinates: rings, dimension: geometry.dimension }))
          .join('')}</MultiGeometry>`;
      case 'GeometryCollection':
        return `<MultiGeometry>${(geometry.geometries ?? []).map(geometryXml).join('')}</MultiGeometry>`;
      default:
        return '';
    }
  };

  const balloon = (properties: Record<string, unknown>): string => {
    const rows = Object.entries(properties).filter(([key]) => !key.startsWith('_'));
    if (rows.length === 0) return '';
    const cells = rows
      .map(([key, value]) => `<tr><td><b>${xmlEscape(key)}</b></td><td>${xmlEscape(value)}</td></tr>`)
      .join('');
    return `<description><![CDATA[<table border="0" cellpadding="3">${cells}</table>]]></description>`;
  };

  const placemark = (feature: CirFeature): string => {
    if (!feature.geometry) return '';
    const label = options.labelField
      ? feature.properties?.[options.labelField]
      : (feature.properties?.name ?? feature.properties?._text ?? feature.id);
    const styleId = feature.geometry.type.includes('Polygon') ? '#ugcPoly' : feature.geometry.type.includes('Point') ? '#ugcPoint' : '#ugcLine';
    return (
      `<Placemark>` +
      (label !== undefined && label !== null && String(label) !== '' ? `<name>${xmlEscape(label)}</name>` : '') +
      `<styleUrl>${styleId}</styleUrl>` +
      (options.descriptionTable ? balloon(feature.properties ?? {}) : '') +
      geometryXml(feature.geometry) +
      `</Placemark>`
    );
  };

  const styles =
    `<Style id="ugcLine"><LineStyle><color>${kmlColor(options.lineColor)}</color><width>${options.lineWidth}</width></LineStyle></Style>` +
    `<Style id="ugcPoly"><LineStyle><color>${kmlColor(options.lineColor)}</color><width>${options.lineWidth}</width></LineStyle>` +
    `<PolyStyle><color>${kmlColor(options.polygonColor, options.polygonFill ? '80' : '00')}</color><fill>${options.polygonFill ? 1 : 0}</fill><outline>1</outline></PolyStyle></Style>` +
    `<Style id="ugcPoint"><IconStyle><color>${kmlColor(options.lineColor)}</color><scale>0.9</scale></IconStyle></Style>`;

  /**
   * Rebuilds the source's folder nesting rather than emitting one flat Folder
   * per layer. A mine plan's `Pit / Bench crests / Toe` hierarchy is meaningful
   * organisation, and flattening it to `Pit - Bench crests - Toe` loses the tree
   * that Google Earth's places panel would otherwise show.
   */
  const buildFolders = (): string => {
    interface Node {
      children: Map<string, Node>;
      placemarks: string[];
    }
    const root: Node = { children: new Map(), placemarks: [] };
    for (const layer of dataset.layers) {
      let node = root;
      for (const segment of layer.path.length > 0 ? layer.path : [layer.name]) {
        const next = node.children.get(segment) ?? { children: new Map(), placemarks: [] };
        node.children.set(segment, next);
        node = next;
      }
      node.placemarks.push(...layer.features.map(placemark));
    }
    // Each node emits its own placemarks and then its child folders. Emitting a
    // child's placemarks at the parent level as well would duplicate every one.
    const render = (node: Node): string =>
      node.placemarks.join('') +
      [...node.children.entries()]
        .map(([name, child]) => `<Folder><name>${xmlEscape(name)}</name>${render(child)}</Folder>`)
        .join('');
    return render(root);
  };

  const body = options.useFolders ? buildFolders() : dataset.layers.flatMap((layer) => layer.features.map(placemark)).join('');

  const text =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n` +
    `<name>${xmlEscape(options.documentName ?? dataset.name)}</name>\n${styles}\n${body}\n` +
    `</Document>\n</kml>\n`;

  return { text, warnings };
}

export async function writeKmz(dataset: CirDataset, options: WriteKmlOptions): Promise<{ bytes: Uint8Array; warnings: Warning[] }> {
  const { text, warnings } = writeKml(dataset, options);
  const bytes = await writeZip([{ name: 'doc.kml', bytes: encodeText(text) }]);
  return { bytes, warnings };
}
