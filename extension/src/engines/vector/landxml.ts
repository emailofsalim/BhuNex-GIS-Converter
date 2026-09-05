/**
 * LandXML 1.x — the civil/survey exchange format.
 *
 * Reads CgPoints (survey points), Parcels (cadastral boundaries), Surface
 * Pnts/Faces (TIN vertices and triangles) and PlanFeatures. Alignments,
 * profiles, superelevation and pipe networks are counted and reported rather
 * than silently ignored.
 *
 * LandXML writes **northing before easting** in every point list, so the reader
 * swaps once at the boundary and says so.
 */

import {
  createDataset,
  createLayer,
  warn,
  type CirDataset,
  type CirFeature,
  type CirLayer,
  type CrsRef,
  type Position,
  type SourceInfo,
  type Warning,
} from '../../core/cir';
import { ConversionError } from '../../core/errors';
import { closeRing } from '../../core/geometry';
import { formatFixed, type PrecisionPolicy } from '../../core/precision';
import { crsFromEpsg } from '../../crs/epsg';
import { linearUnitFromWktName, type LinearUnitId } from '../../core/units';
import { deriveFields, xmlEscape } from '../shared';
import { attribute, child, children, descendants, documentElement, parseXml } from '../xml';

/** LandXML point text is "northing easting [elevation]". */
function parsePoint(text: string): Position | null {
  const parts = text.trim().split(/\s+/).map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return parts.length >= 3 && Number.isFinite(parts[2]) ? [parts[1], parts[0], parts[2]] : [parts[1], parts[0]];
}

export function readLandXml(text: string, source: SourceInfo): CirDataset {
  const document = parseXml(text);
  const root = documentElement(document);
  if (!root || root.local !== 'landxml') {
    throw new ConversionError({
      code: 'LANDXML_NO_ROOT',
      what: 'The file has no <LandXML> root element.',
      why: 'This XML document is a different dialect — possibly KML, GML or a CAD export.',
      action: 'Confirm the detected format in the inspector.',
    });
  }

  const warnings: Warning[] = [];
  const layers: CirLayer[] = [];
  const unsupported = new Map<string, number>();

  // ---- Units and CRS.
  let units: LinearUnitId | null = null;
  const unitsNode = child(root, 'Units');
  if (unitsNode) {
    const metric = child(unitsNode, 'Metric') ?? child(unitsNode, 'Imperial');
    const linear = metric ? attribute(metric, 'linearUnit') : undefined;
    if (linear) units = linearUnitFromWktName(linear) ?? (linear.toLowerCase().includes('meter') ? 'm' : null);
  }

  let crs: CrsRef | null = null;
  const crsNode = child(root, 'CoordinateSystem');
  if (crsNode) {
    const epsg = attribute(crsNode, 'epsgCode') ?? attribute(crsNode, 'EPSGCode');
    if (epsg && Number.isFinite(Number(epsg))) crs = crsFromEpsg(Number(epsg));
    if (!crs) {
      const name = attribute(crsNode, 'name') ?? attribute(crsNode, 'desc') ?? '';
      if (name) {
        warnings.push(
          warn('LANDXML_CRS_NAME_ONLY', `The file names its coordinate system as "${name}" without an EPSG code.`, {
            reason: 'A name alone cannot be resolved to a transformation.',
            action: 'Select the matching CRS manually before converting coordinates.',
          })
        );
      }
    }
  }

  // ---- CgPoints: survey points, optionally with a code and description.
  const cgPointFeatures: CirFeature[] = [];
  for (const container of children(root, 'CgPoints')) {
    for (const node of children(container, 'CgPoint')) {
      const position = parsePoint(node.text);
      if (!position) continue;
      const properties: Record<string, unknown> = {};
      for (const key of ['name', 'code', 'desc', 'pntRef', 'state', 'featureRef']) {
        const value = attribute(node, key);
        if (value) properties[key] = value;
      }
      cgPointFeatures.push({
        id: attribute(node, 'name') ?? cgPointFeatures.length,
        geometry: { type: 'Point', coordinates: position, dimension: position.length >= 3 ? 3 : 2 },
        properties,
        sourceLayer: 'CgPoints',
        sourceEntity: 'CgPoint',
      });
    }
  }
  if (cgPointFeatures.length) layers.push(createLayer('CgPoints', cgPointFeatures, deriveFields(cgPointFeatures)));

  // ---- Parcels: cadastral boundaries, either as a CoordGeom or a point list.
  const parcelFeatures: CirFeature[] = [];
  const pointIndex = new Map<string, Position>();
  for (const node of descendants(root, 'cgpoint')) {
    const name = attribute(node, 'name');
    const position = parsePoint(node.text);
    if (name && position) pointIndex.set(name, position);
  }

  for (const container of children(root, 'Parcels')) {
    for (const parcel of children(container, 'Parcel')) {
      const ring: Position[] = [];
      const coordGeom = child(parcel, 'CoordGeom');
      if (coordGeom) {
        for (const element of coordGeom.children) {
          if (element.local === 'line') {
            const start = child(element, 'Start');
            const end = child(element, 'End');
            const startPosition = start ? parsePoint(start.text) : null;
            const endPosition = end ? parsePoint(end.text) : null;
            if (startPosition && (ring.length === 0 || !samePoint(ring[ring.length - 1], startPosition))) ring.push(startPosition);
            if (endPosition) ring.push(endPosition);
          } else if (element.local === 'curve' || element.local === 'spiral') {
            // Curved parcel edges need densification against a radius the
            // reader does not carry through the CIR; the chord is used and the
            // substitution is reported rather than hidden.
            const start = child(element, 'Start');
            const end = child(element, 'End');
            const startPosition = start ? parsePoint(start.text) : null;
            const endPosition = end ? parsePoint(end.text) : null;
            if (startPosition && (ring.length === 0 || !samePoint(ring[ring.length - 1], startPosition))) ring.push(startPosition);
            if (endPosition) ring.push(endPosition);
            bump(unsupported, element.name);
          }
        }
      }
      if (ring.length === 0) {
        for (const reference of children(parcel, 'Center')) {
          const position = parsePoint(reference.text);
          if (position) ring.push(position);
        }
      }
      if (ring.length < 3) continue;
      const properties: Record<string, unknown> = {};
      for (const key of ['name', 'parcelType', 'state', 'class', 'desc', 'area', 'useOfParcel', 'owner']) {
        const value = attribute(parcel, key);
        if (value) properties[key] = Number.isFinite(Number(value)) && key === 'area' ? Number(value) : value;
      }
      parcelFeatures.push({
        id: attribute(parcel, 'name') ?? parcelFeatures.length,
        geometry: { type: 'Polygon', coordinates: [closeRing(ring)], dimension: ring.some((p) => p.length >= 3) ? 3 : 2 },
        properties,
        sourceLayer: 'Parcels',
        sourceEntity: 'Parcel',
      });
    }
  }
  if (parcelFeatures.length) layers.push(createLayer('Parcels', parcelFeatures, deriveFields(parcelFeatures)));

  // ---- Surfaces: TIN vertices and faces.
  for (const surfaces of children(root, 'Surfaces')) {
    for (const surface of children(surfaces, 'Surface')) {
      const surfaceName = attribute(surface, 'name') ?? 'Surface';
      const definition = child(surface, 'Definition');
      if (!definition) continue;
      const vertices = new Map<string, Position>();
      const pnts = child(definition, 'Pnts');
      if (pnts) {
        for (const point of children(pnts, 'P')) {
          const id = attribute(point, 'id');
          const position = parsePoint(point.text);
          if (id && position) vertices.set(id, position);
        }
      }
      const faceFeatures: CirFeature[] = [];
      const faces = child(definition, 'Faces');
      if (faces) {
        for (const face of children(faces, 'F')) {
          const ids = face.text.trim().split(/\s+/);
          const triangle = ids.map((id) => vertices.get(id)).filter(Boolean) as Position[];
          if (triangle.length < 3) continue;
          faceFeatures.push({
            id: faceFeatures.length,
            geometry: { type: 'Polygon', coordinates: [closeRing(triangle)], dimension: 3 },
            properties: { surface: surfaceName },
            sourceLayer: `${surfaceName} faces`,
            sourceEntity: 'TIN face',
          });
        }
      }
      if (faceFeatures.length > 0) {
        layers.push(createLayer(`${surfaceName} faces`, faceFeatures, deriveFields(faceFeatures)));
      } else if (vertices.size > 0) {
        const pointFeatures: CirFeature[] = [...vertices.entries()].map(([id, position]) => ({
          id,
          geometry: { type: 'Point' as const, coordinates: position, dimension: 3 as const },
          properties: { surface: surfaceName, point_id: id },
          sourceLayer: `${surfaceName} points`,
          sourceEntity: 'TIN vertex',
        }));
        layers.push(createLayer(`${surfaceName} points`, pointFeatures, deriveFields(pointFeatures)));
      }
    }
  }

  // ---- PlanFeatures: linework.
  const planFeatures: CirFeature[] = [];
  for (const container of children(root, 'PlanFeatures')) {
    for (const feature of children(container, 'PlanFeature')) {
      const positions: Position[] = [];
      for (const coordGeom of children(feature, 'CoordGeom')) {
        for (const element of coordGeom.children) {
          for (const endpoint of ['Start', 'End']) {
            const node = child(element, endpoint);
            const position = node ? parsePoint(node.text) : null;
            if (position && (positions.length === 0 || !samePoint(positions[positions.length - 1], position))) positions.push(position);
          }
        }
      }
      if (positions.length < 2) continue;
      planFeatures.push({
        id: attribute(feature, 'name') ?? planFeatures.length,
        geometry: { type: 'LineString', coordinates: positions, dimension: positions.some((p) => p.length >= 3) ? 3 : 2 },
        properties: { name: attribute(feature, 'name'), desc: attribute(feature, 'desc') },
        sourceLayer: 'PlanFeatures',
        sourceEntity: 'PlanFeature',
      });
    }
  }
  if (planFeatures.length) layers.push(createLayer('PlanFeatures', planFeatures, deriveFields(planFeatures)));

  // ---- Report what was present but not converted.
  for (const name of ['Alignments', 'Profile', 'Superelevation', 'PipeNetworks', 'Roadways', 'GradeModel']) {
    const count = descendants(root, name.toLowerCase()).length;
    if (count > 0) unsupported.set(name, count);
  }

  if (layers.length === 0) {
    throw new ConversionError({
      code: 'LANDXML_NO_GEOMETRY',
      what: 'No convertible geometry was found in the LandXML file.',
      why:
        unsupported.size > 0
          ? `The file holds ${[...unsupported.entries()].map(([key, value]) => `${value} ${key}`).join(', ')}, none of which the vector model can represent.`
          : 'It contains no CgPoints, Parcels, Surfaces or PlanFeatures.',
      action: 'Export points, parcels or a surface from your civil application, or convert alignments to polylines first.',
    });
  }

  if (unsupported.size > 0) {
    const summary = [...unsupported.entries()].map(([key, value]) => `${key} × ${value}`).join(', ');
    warnings.push(
      warn('LANDXML_UNSUPPORTED', `Elements not converted: ${summary}.`, {
        count: [...unsupported.values()].reduce((sum, value) => sum + value, 0),
        reason: 'Alignments, profiles, superelevation and pipe networks are parametric civil objects with no vector-geometry equivalent.',
        action: 'Export them as 3D polylines from the civil application if their geometry is needed.',
        detail: Object.fromEntries(unsupported),
      })
    );
  }

  warnings.push(
    warn('LANDXML_AXIS_SWAPPED', 'LandXML stores northing before easting; coordinates were swapped to x/y on import.', {
      severity: 'info',
      reason: 'Every LandXML point list is "north east [elev]". Reading it verbatim would transpose the data.',
      action: 'Check a known point in the inspector to confirm.',
    })
  );

  return createDataset({
    kind: 'vector',
    name: source.fileName,
    source,
    crs,
    crsOrigin: crs ? 'declared' : 'unknown',
    units,
    axisOrder: 'xy',
    layers,
    warnings,
    metadata: { version: attribute(root, 'version'), unsupported: Object.fromEntries(unsupported) },
  });
}

function samePoint(a: Position, b: Position): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

export interface WriteLandXmlOptions {
  precision: PrecisionPolicy;
  /** Field used for the CgPoint name. */
  nameField?: string;
  /** Field used for the CgPoint code. */
  codeField?: string;
  projectName?: string;
}

/**
 * Writes CgPoints for point geometry and Parcels for closed geometry. Lines
 * become PlanFeatures. This is the subset a civil application will re-import
 * cleanly; anything richer would need alignment and surface semantics the CIR
 * does not carry.
 */
export function writeLandXml(dataset: CirDataset, options: WriteLandXmlOptions): { text: string; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const decimals = options.precision.mode === 'full' ? 6 : options.precision.linearDecimals;
  const point = (position: Position): string => {
    const north = formatFixed(position[1], decimals);
    const east = formatFixed(position[0], decimals);
    const elevation = position.length > 2 && Number.isFinite(position[2]) ? ` ${formatFixed(position[2], decimals)}` : '';
    // Northing first: the format's own axis order, restored on write.
    return `${north} ${east}${elevation}`;
  };

  const cgPoints: string[] = [];
  const parcels: string[] = [];
  const planFeatures: string[] = [];
  let index = 0;

  for (const layer of dataset.layers) {
    for (const feature of layer.features) {
      const geometry = feature.geometry;
      if (!geometry) continue;
      index++;
      const name = xmlEscape(
        (options.nameField ? feature.properties?.[options.nameField] : undefined) ?? feature.properties?.name ?? feature.id ?? index
      );
      const code = options.codeField ? feature.properties?.[options.codeField] : feature.properties?.code;
      const codeAttribute = code ? ` code="${xmlEscape(code)}"` : '';

      switch (geometry.type) {
        case 'Point':
          cgPoints.push(`<CgPoint name="${name}"${codeAttribute}>${point(geometry.coordinates as Position)}</CgPoint>`);
          break;
        case 'MultiPoint':
          for (const position of geometry.coordinates as Position[]) {
            cgPoints.push(`<CgPoint name="${name}"${codeAttribute}>${point(position)}</CgPoint>`);
          }
          break;
        case 'Polygon':
        case 'MultiPolygon': {
          const rings = geometry.type === 'Polygon' ? (geometry.coordinates as Position[][]) : (geometry.coordinates as Position[][][]).flat();
          const outer = rings[0] ?? [];
          if (outer.length < 3) break;
          const segments: string[] = [];
          for (let vertex = 0; vertex + 1 < outer.length; vertex++) {
            segments.push(`<Line><Start>${point(outer[vertex])}</Start><End>${point(outer[vertex + 1])}</End></Line>`);
          }
          parcels.push(`<Parcel name="${name}" parcelType="Single"><CoordGeom>${segments.join('')}</CoordGeom></Parcel>`);
          if (rings.length > 1) {
            warnings.push(
              warn('LANDXML_HOLES_DROPPED', `Interior rings on parcel "${name}" were not written.`, {
                reason: 'A LandXML Parcel CoordGeom describes a single closed boundary; it has no interior-ring container.',
                action: 'Export to Shapefile, GeoPackage or GeoJSON to keep holes.',
              })
            );
          }
          break;
        }
        case 'LineString':
        case 'MultiLineString': {
          const lines = geometry.type === 'LineString' ? [geometry.coordinates as Position[]] : (geometry.coordinates as Position[][]);
          for (const line of lines) {
            const segments: string[] = [];
            for (let vertex = 0; vertex + 1 < line.length; vertex++) {
              segments.push(`<Line><Start>${point(line[vertex])}</Start><End>${point(line[vertex + 1])}</End></Line>`);
            }
            planFeatures.push(`<PlanFeature name="${name}"><CoordGeom>${segments.join('')}</CoordGeom></PlanFeature>`);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const stamp = new Date().toISOString();
  const linearUnit = dataset.units === 'ft' ? 'foot' : dataset.units === 'us-ft' ? 'USSurveyFoot' : 'meter';
  const unitsBlock =
    linearUnit === 'meter'
      ? `<Units><Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars" angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>`
      : `<Units><Imperial areaUnit="squareFoot" linearUnit="${linearUnit}" volumeUnit="cubicFeet" temperatureUnit="fahrenheit" pressureUnit="inchHG" angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>`;

  const crsBlock = dataset.crs?.epsg
    ? `<CoordinateSystem epsgCode="${dataset.crs.epsg}" desc="${xmlEscape(dataset.crs.name)}"/>`
    : '';

  const text =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="${stamp.slice(0, 10)}" time="${stamp.slice(11, 19)}">\n` +
    `${unitsBlock}\n${crsBlock}\n` +
    `<Project name="${xmlEscape(options.projectName ?? dataset.name)}"/>\n` +
    (cgPoints.length ? `<CgPoints>${cgPoints.join('')}</CgPoints>\n` : '') +
    (parcels.length ? `<Parcels>${parcels.join('')}</Parcels>\n` : '') +
    (planFeatures.length ? `<PlanFeatures>${planFeatures.join('')}</PlanFeatures>\n` : '') +
    `</LandXML>\n`;

  return { text, warnings };
}
