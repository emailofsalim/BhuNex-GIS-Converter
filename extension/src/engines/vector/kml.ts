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
import { buildBoreholeModel } from '../survey/borehole';
import { descriptionElement, renderBalloon, renderBoreholeBalloon, type KmlTemplate } from './kml-templates';
import { coordinateFormatter, formatFixed, type PrecisionPolicy } from '../../core/precision';
import { crsFromEpsg } from '../../crs/epsg';
import { readZip, writeZip } from '../archives/zip';
import { encodePng, type PngColour } from '../raster/png';
import { RASTER_FOOTPRINT_LAYER } from '../raster/geotiff';
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

/**
 * A GroundOverlay's footprint, as a polygon feature.
 *
 * WHAT IS AND IS NOT IMPORTED
 *
 * KML gives a ground overlay its position two ways, and only one of them is a
 * rectangle. `<LatLonBox>` is axis-aligned north/south/east/west with an
 * optional rotation about the centre; `<gx:LatLonQuad>` gives four arbitrary
 * corners. Both are read — the quad as the polygon it already is, the box as
 * the four corners it implies — because a quad silently skipped is the same
 * silent loss this function exists to end.
 *
 * A rotated box is reported rather than rotated. Turning the corners by the
 * stated angle is easy arithmetic and the wrong answer here: KML rotates about
 * the box centre in SCREEN space at draw time, so the ground footprint of a
 * rotated overlay is not the rotated rectangle. Emitting the unrotated box and
 * naming the angle in an attribute leaves a reader something true to work
 * with, and the warning says the picture will sit at an angle inside it.
 */
function readGroundOverlay(node: XmlNode, warnings: Warning[]): Omit<CirFeature, 'id' | 'sourceLayer'> | null {
  const properties: Record<string, unknown> = {};
  const name = childText(node, 'name');
  if (name) properties.name = name;
  const description = childText(node, 'description');
  if (description) properties.description = decodeEntities(description);

  // The image, which stays where it is. Named so the user can find it in the
  // KMZ they already have.
  const icon = node.children.find((child) => child.local === 'icon');
  const href = icon ? childText(icon, 'href') : null;
  if (href) properties.overlayImage = href;

  const drawOrder = childText(node, 'draworder');
  if (drawOrder) properties.drawOrder = Number(drawOrder);

  const quad = node.children.find((child) => child.local === 'latlonquad');
  if (quad) {
    const corners = parseCoordinates(childText(quad, 'coordinates') ?? '');
    if (corners.length >= 3) {
      const ring = [...corners, corners[0]].map((position) => [position[0], position[1]] as Position);
      return {
        geometry: { type: 'Polygon', dimension: 2, coordinates: [ring] },
        properties,
        sourceEntity: 'GroundOverlay',
      };
    }
  }

  const box = node.children.find((child) => child.local === 'latlonbox');
  if (!box) {
    warnings.push(
      warn('KML_OVERLAY_NO_BOX', `A ground overlay${name ? ` (“${name}”)` : ''} has no LatLonBox or gx:LatLonQuad.`, {
        severity: 'warning',
        reason: 'Without one of those the overlay states no position, so there is nothing to place on the ground.',
        action: 'Open the KML and check the overlay, or place the image with the Georeference tool instead.',
      })
    );
    return null;
  }

  const north = Number(childText(box, 'north'));
  const south = Number(childText(box, 'south'));
  const east = Number(childText(box, 'east'));
  const west = Number(childText(box, 'west'));
  if (![north, south, east, west].every(Number.isFinite)) return null;

  const rotation = Number(childText(box, 'rotation') ?? '0');
  if (Number.isFinite(rotation) && rotation !== 0) {
    properties.rotation = rotation;
    warnings.push(
      warn('KML_OVERLAY_ROTATED', `A ground overlay${name ? ` (“${name}”)` : ''} is rotated ${rotation}°.`, {
        severity: 'info',
        reason:
          'KML rotates an overlay about its box centre when it is drawn, so the ground footprint is not the rotated rectangle. The unrotated box is imported and the angle kept as an attribute.',
        action: 'Treat the footprint as the extent, not as the exact outline of the picture inside it.',
      })
    );
  }

  const ring: Position[] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  return {
    geometry: { type: 'Polygon', dimension: 2, coordinates: [ring] },
    properties,
    sourceEntity: 'GroundOverlay',
  };
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
      // A GROUND OVERLAY IS CONTENT, and it used to be walked straight past.
      //
      // `walk` looked for Placemarks and recursed through everything else, so
      // a KMZ whose whole content is a scanned plan or an orthophoto draped on
      // the terrain — which is how a great many survey deliverables arrive —
      // read as a document with ZERO features and no warning saying why. Total
      // silent loss, of the one thing in the file.
      //
      // The pixels are not decoded: the image lives beside the doc.kml inside
      // the KMZ, and re-encoding someone's scan into a vector target is not a
      // conversion anyone asked for. What IS imported is the thing that is
      // genuinely georeferenced — the LatLonBox — as a footprint polygon
      // carrying the image's name, its rotation and its draw order. A surveyor
      // converting to GeoJSON or DXF then gets a rectangle on the right ground
      // labelled with the file that belongs in it, instead of an empty layer.
      if (candidate.local === 'groundoverlay') {
        const footprint = readGroundOverlay(candidate, warnings);
        if (footprint) {
          const segments = path.length > 0 ? path : [source.fileName];
          const layerName = segments.join(' / ');
          const entry = layers.get(layerName) ?? { path: segments, features: [] };
          entry.features.push({ ...footprint, id: attribute(candidate, 'id') ?? entry.features.length, sourceLayer: layerName });
          layers.set(layerName, entry);
        }
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

  // A SCREEN OVERLAY IS REPORTED, NEVER IMPORTED.
  //
  // It is pinned to the viewport — a logo, a north arrow, a legend — and has
  // no ground position at all: its `<overlayXY>` and `<screenXY>` are screen
  // fractions, not coordinates. Inventing geometry for one would put a
  // company logo on the survey as if it were surveyed. But dropping it in
  // silence is how a user ends up asking where their north arrow went, so the
  // count and the names are stated.
  const screenOverlays = descendants(root, 'screenoverlay');
  if (screenOverlays.length > 0) {
    const named = screenOverlays
      .map((node) => childText(node, 'name'))
      .filter((label): label is string => Boolean(label))
      .slice(0, 3);
    warnings.push(
      warn('KML_SCREEN_OVERLAY', `${screenOverlays.length} screen overlay(s) were not imported.`, {
        severity: 'info',
        reason:
          'A screen overlay is pinned to the viewport rather than to the ground — its position is a fraction of the window, not a coordinate — so there is no location to convert it to.',
        action: named.length > 0 ? `The images stay in the source file: ${named.join(', ')}.` : 'The images stay in the source file.',
      })
    );
  }

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
  /**
   * Which balloon the description uses (spec §28.5).
   *
   * 'plain' is the default and is never wrong. The others reorder the fields so
   * the identity a reader is looking for — the plot number, the hole id — is at
   * the top instead of alphabetically in the middle.
   */
  template: KmlTemplate;
  /** Render boreholes as core-log balloons instead of attribute tables. */
  boreholeLog: boolean;
  /** Optional footer on every balloon, e.g. a survey date or licence note. */
  balloonFooter?: string;
  /**
   * An image to drape on the terrain, written as a `<GroundOverlay>`.
   *
   * Supplied by `writeKmz`, which is the only caller that can put the image
   * where the href points: a plain `.kml` is one text file and cannot carry
   * bytes. The descriptor is kept separate from the pixels on purpose — this
   * function stays synchronous and string-only, and the encoding lives with
   * the archive that holds the result.
   */
  groundOverlay?: GroundOverlaySpec;
}

/** Where a draped image sits, in the degrees KML insists on. */
export interface GroundOverlaySpec {
  /** Path inside the KMZ, e.g. `overlay.png`. */
  href: string;
  north: number;
  south: number;
  east: number;
  west: number;
  name?: string;
  /** Drawn under the vectors by default, so a plan does not hide the survey. */
  drawOrder?: number;
}

export const DEFAULT_KML_OPTIONS: Omit<WriteKmlOptions, 'precision'> = {
  altitudeMode: 'clampToGround',
  useFolders: true,
  descriptionTable: true,
  lineColor: '#0e7c86',
  lineWidth: 2,
  polygonFill: true,
  polygonColor: '#0e7c86',
  template: 'plain',
  boreholeLog: false,
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

  /**
   * Writes lon,lat,alt — with the REAL altitude whenever the vertex has one.
   *
   * `altitudeMode` says how Google Earth DRAWS the geometry; it says nothing
   * about what the coordinate tuple is allowed to carry. KML coordinates are
   * lon,lat,alt in every mode, and a clamped Placemark simply ignores the third
   * number when drawing — it does not require it to be zero.
   *
   * Conflating the two meant the default mode (clampToGround) wrote `,0` for
   * every vertex, so a levelled survey — contours, spot heights, a parcel with
   * reduced levels on every corner — arrived in Google Earth with its levels
   * replaced by zeros. Nothing on screen changes by keeping them: the drawing
   * still clamps to terrain, and the levels are now there for whoever reads the
   * file back or opens it in software that wants them.
   *
   * The altitude is OMITTED where the vertex has none. `lon,lat` is valid KML,
   * and the alternative — writing `,0` — is not a neutral placeholder but a
   * claim that the point sits at sea level. Read back, that claim becomes a
   * real elevation: a flat cadastral sheet returned as a 3D drawing pinned to
   * zero, its 2D honesty gone. Measured on the survey fixture, the round trip
   * turned 115 levelled vertices into 376.
   */
  const coordinate = (position: Position): string => {
    const lon = formatFixed(format.x(position[0]), decimals);
    const lat = formatFixed(format.y(position[1]), decimals);
    if (position.length > 2 && Number.isFinite(position[2])) {
      return `${lon},${lat},${formatFixed(format.z(position[2]), elevationDecimals)}`;
    }
    return `${lon},${lat}`;
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

  // Boreholes are modelled once, up front: the collar/interval join is by hole
  // id across the whole dataset, so it cannot be done per placemark.
  const boreholes = options.boreholeLog ? new Map(buildBoreholeModel(dataset).holes.map((hole) => [hole.holeId, hole])) : null;
  const droppedSecrets = new Set<string>();

  const holeIdOf = (properties: Record<string, unknown>): string | null => {
    for (const [key, value] of Object.entries(properties)) {
      if (!/^(hole|bh|dh)[\s_-]?(id|no|number)?$/i.test(key.replace(/\s/g, ''))) continue;
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return null;
  };

  const balloon = (properties: Record<string, unknown>, name: string | undefined): string => {
    const holeId = boreholes ? holeIdOf(properties) : null;
    const hole = holeId ? boreholes?.get(holeId) : undefined;
    const rendered = hole
      ? renderBoreholeBalloon(hole, { footer: options.balloonFooter })
      : renderBalloon(properties, { template: options.template, title: name, footer: options.balloonFooter });
    for (const field of rendered.droppedSecrets) droppedSecrets.add(field);
    return descriptionElement(rendered.html);
  };

  /**
   * Per-layer styles, so a layer coloured in the workspace is that colour in
   * Google Earth.
   *
   * Before this every placemark shared three document-wide styles, which meant
   * the layer colour controls changed the preview canvas and nothing in the
   * exported file — and an automatically generated legend beside such a file
   * would have been a document asserting something false about its companion.
   *
   * A layer with no style of its own keeps the document defaults exactly, so
   * nothing about an unstyled conversion changes.
   */
  const layerStyles = new Map<string, { id: string; xml: string }>();
  for (const [index, layer] of dataset.layers.entries()) {
    const colour = layer.style?.color;
    const width = layer.style?.lineWidth;
    if (!colour && width === undefined) continue;
    const id = `ugcLayer${index}`;
    const line = colour ? kmlColor(colour) : kmlColor(options.lineColor);
    const stroke = width !== undefined && Number.isFinite(width) ? Math.max(0.5, Math.min(8, width)) : options.lineWidth;
    layerStyles.set(layer.name, {
      id,
      xml:
        `<Style id="${id}">` +
        `<LineStyle><color>${line}</color><width>${stroke}</width></LineStyle>` +
        `<PolyStyle><color>${colour ? kmlColor(colour, options.polygonFill ? '80' : '00') : kmlColor(options.polygonColor, options.polygonFill ? '80' : '00')}</color>` +
        `<fill>${options.polygonFill ? 1 : 0}</fill><outline>1</outline></PolyStyle>` +
        `<IconStyle><color>${line}</color><scale>0.9</scale></IconStyle>` +
        `</Style>`,
    });
  }

  const placemark = (feature: CirFeature, layerName?: string): string => {
    if (!feature.geometry) return '';
    const label = options.labelField
      ? feature.properties?.[options.labelField]
      : (feature.properties?.name ?? feature.properties?._text ?? feature.id);
    const own = layerName ? layerStyles.get(layerName) : undefined;
    const styleId = own
      ? `#${own.id}`
      : feature.geometry.type.includes('Polygon')
        ? '#ugcPoly'
        : feature.geometry.type.includes('Point')
          ? '#ugcPoint'
          : '#ugcLine';
    return (
      `<Placemark>` +
      (label !== undefined && label !== null && String(label) !== '' ? `<name>${xmlEscape(label)}</name>` : '') +
      `<styleUrl>${styleId}</styleUrl>` +
      (options.descriptionTable ? balloon(feature.properties ?? {}, label === undefined || label === null ? undefined : String(label)) : '') +
      geometryXml(feature.geometry) +
      `</Placemark>`
    );
  };

  const styles =
    `<Style id="ugcLine"><LineStyle><color>${kmlColor(options.lineColor)}</color><width>${options.lineWidth}</width></LineStyle></Style>` +
    `<Style id="ugcPoly"><LineStyle><color>${kmlColor(options.lineColor)}</color><width>${options.lineWidth}</width></LineStyle>` +
    `<PolyStyle><color>${kmlColor(options.polygonColor, options.polygonFill ? '80' : '00')}</color><fill>${options.polygonFill ? 1 : 0}</fill><outline>1</outline></PolyStyle></Style>` +
    `<Style id="ugcPoint"><IconStyle><color>${kmlColor(options.lineColor)}</color><scale>0.9</scale></IconStyle></Style>` +
    [...layerStyles.values()].map((style) => style.xml).join('');

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
      node.placemarks.push(...layer.features.map((feature) => placemark(feature, layer.name)));
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

  const body = options.useFolders
    ? buildFolders()
    : dataset.layers.flatMap((layer) => layer.features.map((feature) => placemark(feature, layer.name))).join('');

  /**
   * The draped image, written BEFORE the placemarks.
   *
   * Document order is not decorative here. Google Earth draws overlays sharing
   * a `drawOrder` in document order, and an aerial photo emitted after the
   * parcels would cover the very boundaries the user converted. `drawOrder` 0
   * against the placemarks' implicit 0, plus being written first, puts the
   * picture underneath where a basemap belongs.
   */
  const overlay = options.groundOverlay
    ? `<GroundOverlay>` +
      `<name>${xmlEscape(options.groundOverlay.name ?? 'Image')}</name>` +
      `<drawOrder>${options.groundOverlay.drawOrder ?? 0}</drawOrder>` +
      `<Icon><href>${xmlEscape(options.groundOverlay.href)}</href></Icon>` +
      `<LatLonBox>` +
      // The same precision policy the coordinates use: a box stated to more
      // decimals than the geometry inside it would claim an accuracy the
      // survey does not have.
      `<north>${formatFixed(format.y(options.groundOverlay.north), decimals)}</north>` +
      `<south>${formatFixed(format.y(options.groundOverlay.south), decimals)}</south>` +
      `<east>${formatFixed(format.x(options.groundOverlay.east), decimals)}</east>` +
      `<west>${formatFixed(format.x(options.groundOverlay.west), decimals)}</west>` +
      `</LatLonBox>` +
      `</GroundOverlay>\n`
    : '';

  const text =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n` +
    `<name>${xmlEscape(options.documentName ?? dataset.name)}</name>\n${styles}\n${overlay}${body}\n` +
    `</Document>\n</kml>\n`;

  if (droppedSecrets.size > 0) {
    // A KMZ gets emailed around. A credential inside one has leaked, so the
    // fields are withheld — and saying so is part of the same rule: a silent
    // drop would be its own dishonesty (R3, R23).
    warnings.push(
      warn('KML_SECRETS_WITHHELD', `${droppedSecrets.size} field(s) were left out of the balloons because their names or values look like credentials.`, {
        count: droppedSecrets.size,
        reason: `Withheld: ${[...droppedSecrets].join(', ')}. A KML or KMZ is shared freely, so anything token-shaped in one is a leak.`,
        action: 'Rename the field if it is not a secret, or remove it from the source before converting.',
        detail: { fields: [...droppedSecrets] },
      })
    );
  }

  return { text, warnings };
}

/** The overlay image, or the reason there is not one. */
interface OverlayResult {
  spec?: GroundOverlaySpec;
  png?: Uint8Array;
  warning?: Warning;
}

/**
 * Turns a raster into a `<GroundOverlay>` image, or says why it cannot.
 *
 * KMZ IS THE ONE VECTOR TARGET THAT CAN KEEP PIXELS. Everywhere else the
 * pipeline is right to reduce a raster to its footprint polygon — a vector
 * format stores geometry, not pixels — and for KML it did the same, so a
 * scanned plan or an orthophoto converted to KMZ came out as an empty
 * rectangle. KML has carried `<GroundOverlay>` since version 2.0 precisely for
 * this, and a KMZ is a ZIP that can hold the image beside the doc.
 *
 * WHAT IS REFUSED, AND WHY IT IS A REFUSAL RATHER THAN AN APPROXIMATION
 *
 * `<LatLonBox>` is four numbers — north, south, east, west — and is therefore
 * AXIS-ALIGNED IN DEGREES. A geotransform carries two rotation terms, and when
 * either is non-zero the pixels sit on a grid that no box can describe.
 * Writing the bounding box anyway would place the image square when it is not,
 * and a scan that is visibly the right shape in the wrong orientation is far
 * more dangerous than one that is missing: it looks converted. So a rotated or
 * skewed raster is refused BY NAME, with the operation that fixes it —
 * `warp.ts` reprojects to a north-up grid and is already in this build.
 */
function overlayFor(dataset: CirDataset): OverlayResult {
  const raster = dataset.raster;
  if (!raster) return {};

  if (!raster.hasPixelData || !raster.bands || raster.bands.length === 0) {
    return {
      warning: warn('KML_OVERLAY_NO_PIXELS', 'The raster was written as its footprint only.', {
        severity: 'info',
        reason: 'Only the georeference was read from the source, so there are no pixels to drape.',
        action: 'Convert from a file that carries the image data to get a picture in Google Earth.',
      }),
    };
  }

  const transform = raster.geotransform;
  if (!transform) {
    return {
      warning: warn('KML_OVERLAY_NO_GEOREF', 'The raster was written as its footprint only.', {
        severity: 'warning',
        reason: 'It carries no geotransform, so there is no ground position to drape the image at.',
        action: 'Georeference the image with the Georeference tool, or supply its world file alongside it.',
      }),
    };
  }

  const [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight] = transform;
  if (rowRotation !== 0 || columnRotation !== 0) {
    return {
      warning: warn('KML_OVERLAY_ROTATED', 'The raster was written as its footprint only.', {
        severity: 'warning',
        reason:
          "KML's LatLonBox is four numbers — north, south, east and west — so it can only describe a north-up rectangle. This raster's geotransform is rotated, and squaring it up would place the image at the wrong angle while looking correct.",
        action: 'Reproject the raster to a north-up grid first (Data › Reproject), then convert again.',
      }),
    };
  }

  if (dataset.crs?.kind !== 'geographic') {
    // The vector path already warns about this loudly; the overlay adds the
    // consequence specific to it rather than repeating the general one.
    return {
      warning: warn('KML_OVERLAY_NOT_GEOGRAPHIC', 'The raster was written as its footprint only.', {
        severity: 'warning',
        reason: `A LatLonBox is stated in WGS 84 degrees, and this raster is on ${dataset.crs?.name ?? 'an undeclared grid'}.`,
        action: 'Set the target CRS to WGS 84 (EPSG:4326) so the image is placed in degrees.',
      }),
    };
  }

  const { width, height } = raster;
  const west = originX;
  const east = originX + pixelWidth * width;
  const north = originY;
  const south = originY + pixelHeight * height;

  return {
    spec: {
      href: 'overlay.png',
      // A negative pixelHeight is the normal north-up case and puts `south`
      // below `north`; a positive one means the rows run the other way. Sorting
      // rather than assuming keeps a bottom-up raster from producing a box with
      // its edges inverted, which Google Earth draws as nothing at all.
      north: Math.max(north, south),
      south: Math.min(north, south),
      east: Math.max(east, west),
      west: Math.min(east, west),
      name: dataset.name,
      drawOrder: 0,
    },
    png: rasterToPng(raster),
  };
}

/**
 * Eight-bit samples from whatever the raster holds.
 *
 * Three bands or more are taken as RGB; anything else is rendered as grey,
 * which is what an elevation model or a single-band classification is. The
 * stretch is over the band's own range rather than a fixed 0-255, because a
 * DEM in metres above sea level would otherwise come out uniformly white.
 *
 * NO-DATA BECOMES TRANSPARENT, not black. A DEM's void filled with black would
 * read as a pit in the terrain — the most confident kind of wrong — so the
 * output gains an alpha channel whenever the raster declares a no-data value.
 */
function rasterToPng(raster: NonNullable<CirDataset['raster']>): Uint8Array {
  const { width, height, noData } = raster;
  const bands = raster.bands!;
  const rgb = bands.length >= 3;
  const source = rgb ? [bands[0], bands[1], bands[2]] : [bands[0]];
  const alpha = noData !== null && noData !== undefined;

  // One stretch per band, from the data itself. `statistics` is used when the
  // reader supplied it, since it saw the whole raster and this preview may be
  // looking at a subset.
  const ranges = source.map((band, index) => {
    const stats = raster.statistics?.[index];
    if (stats && Number.isFinite(stats.min) && Number.isFinite(stats.max)) return { min: stats.min, max: stats.max };
    let min = Infinity;
    let max = -Infinity;
    for (const value of band) {
      if (!Number.isFinite(value) || value === noData) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : { min: 0, max: 1 };
  });

  // PNG has a grey+alpha colour type and this encoder does not implement it,
  // so a single band that needs transparency is written as RGBA with the grey
  // value in all three colour channels. Four bytes a pixel instead of two, for
  // a picture that is about to be deflated inside the KMZ anyway — and it
  // keeps the encoder to the three types every one of its callers needs.
  const colour: PngColour = rgb ? (alpha ? 'rgba' : 'rgb') : alpha ? 'rgba' : 'grey';
  const channels = colour === 'grey' ? 1 : colour === 'rgb' ? 3 : 4;
  const colourChannels = colour === 'grey' ? 1 : 3;

  const out = new Uint8Array(width * height * channels);
  for (let pixel = 0; pixel < width * height; pixel++) {
    let transparent = false;
    const levels: number[] = [];
    for (let band = 0; band < source.length; band++) {
      const value = source[band][pixel];
      if (!Number.isFinite(value) || value === noData) transparent = true;
      const { min, max } = ranges[band];
      const span = max - min || 1;
      const scaled = Math.round(((value - min) / span) * 255);
      levels.push(Math.max(0, Math.min(255, Number.isFinite(scaled) ? scaled : 0)));
    }
    for (let channel = 0; channel < colourChannels; channel++) {
      // One band into three channels when the output is RGBA but the source is
      // a single band: `levels[channel] ?? levels[0]` is the grey replication.
      out[pixel * channels + channel] = levels[channel] ?? levels[0] ?? 0;
    }
    if (colour === 'rgba') out[pixel * channels + 3] = transparent ? 0 : 255;
  }

  return encodePng(out, width, height, colour);
}

export async function writeKmz(dataset: CirDataset, options: WriteKmlOptions): Promise<{ bytes: Uint8Array; warnings: Warning[] }> {
  const overlay = overlayFor(dataset);

  // THE FOOTPRINT AND THE OVERLAY ARE THE SAME RECTANGLE, so only one of them
  // is written.
  //
  // The pipeline turns a raster into a footprint polygon on the way to any
  // vector target, which is right for all of them except this one. The
  // overlay's LatLonBox already states that extent, and more usefully, so
  // emitting both puts two identical rectangles in one file — and a raster
  // converted to KMZ and read back would come out with twice the geometry it
  // went in with, which is exactly what `cross-kind.test.ts` caught.
  //
  // The footprint is kept whenever the overlay is REFUSED, because then it is
  // the only thing standing between the user and an empty KMZ.
  const body =
    overlay.spec && overlay.png
      ? { ...dataset, layers: dataset.layers.filter((layer) => (layer.path[0] ?? layer.name) !== RASTER_FOOTPRINT_LAYER) }
      : dataset;

  const { text, warnings } = writeKml(body, { ...options, groundOverlay: overlay.spec });
  if (overlay.warning) warnings.push(overlay.warning);

  const files = [{ name: 'doc.kml', bytes: encodeText(text) }];
  if (overlay.spec && overlay.png) files.push({ name: overlay.spec.href, bytes: overlay.png });

  const bytes = await writeZip(files);
  return { bytes, warnings };
}
