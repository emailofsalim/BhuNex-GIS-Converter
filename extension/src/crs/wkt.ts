/**
 * CRS WKT (well-known text) parsing and generation.
 *
 * Handles WKT1 as ESRI and OGC write it — the flavour that actually appears in
 * .prj sidecars — plus the WKT2 keywords that show up from newer GDAL builds.
 * The parser is a small recursive-descent reader over the bracket tree rather
 * than a regex pile, because .prj files nest deeply and regexes get the
 * PARAMETER/UNIT association wrong in exactly the cases that matter.
 */

import type { CrsRef } from '../core/cir';
import { linearUnitFromWktName } from '../core/units';
import { crsFromEpsg, epsgEntry } from './epsg';
import { utmCentralMeridian } from './projection';

export interface WktNode {
  keyword: string;
  values: (string | number | WktNode)[];
}

export function parseWktTree(text: string): WktNode | null {
  let index = 0;
  const source = text.trim();

  function skipSpace(): void {
    while (index < source.length && /\s/.test(source[index])) index++;
  }

  function parseNode(): WktNode | null {
    skipSpace();
    const start = index;
    while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) index++;
    const keyword = source.slice(start, index).toUpperCase();
    if (!keyword) return null;
    skipSpace();
    const open = source[index];
    if (open !== '[' && open !== '(') return { keyword, values: [] };
    const close = open === '[' ? ']' : ')';
    index++;
    const values: (string | number | WktNode)[] = [];
    for (;;) {
      skipSpace();
      if (index >= source.length) break;
      const char = source[index];
      if (char === close) {
        index++;
        break;
      }
      if (char === ',') {
        index++;
        continue;
      }
      if (char === '"') {
        index++;
        const stringStart = index;
        while (index < source.length && source[index] !== '"') index++;
        values.push(source.slice(stringStart, index));
        index++;
        continue;
      }
      if (/[-+0-9.]/.test(char)) {
        const numberStart = index;
        while (index < source.length && /[-+0-9.eE]/.test(source[index])) index++;
        values.push(Number(source.slice(numberStart, index)));
        continue;
      }
      const child = parseNode();
      if (!child) {
        index++;
        continue;
      }
      values.push(child);
    }
    return { keyword, values };
  }

  return parseNode();
}

function findNode(node: WktNode, keyword: string): WktNode | null {
  for (const value of node.values) {
    if (typeof value === 'object' && value.keyword === keyword) return value;
  }
  for (const value of node.values) {
    if (typeof value === 'object') {
      const nested = findNode(value, keyword);
      if (nested) return nested;
    }
  }
  return null;
}

function findAllNodes(node: WktNode, keyword: string, into: WktNode[] = []): WktNode[] {
  for (const value of node.values) {
    if (typeof value === 'object') {
      if (value.keyword === keyword) into.push(value);
      findAllNodes(value, keyword, into);
    }
  }
  return into;
}

function nodeName(node: WktNode | null): string {
  if (!node) return '';
  const first = node.values[0];
  return typeof first === 'string' ? first : '';
}

function parameterValue(root: WktNode, name: string): number | null {
  const target = name.toLowerCase().replace(/[\s_]/g, '');
  for (const parameter of findAllNodes(root, 'PARAMETER')) {
    const label = String(parameter.values[0] ?? '').toLowerCase().replace(/[\s_]/g, '');
    if (label === target) {
      const value = parameter.values[1];
      if (typeof value === 'number') return value;
    }
  }
  return null;
}

/** Pulls the AUTHORITY["EPSG", "32645"] / ID["EPSG", 32645] code from the root. */
function authorityCode(root: WktNode): number | null {
  for (const keyword of ['AUTHORITY', 'ID']) {
    // Only the root-level authority identifies the CRS; nested ones identify the
    // datum or the unit and would give a wrong code.
    for (const value of root.values) {
      if (typeof value === 'object' && value.keyword === keyword) {
        const name = String(value.values[0] ?? '').toUpperCase();
        const code = Number(value.values[1]);
        if (name === 'EPSG' && Number.isFinite(code)) return code;
      }
    }
  }
  return null;
}

export interface ParsedPrj {
  crs: CrsRef | null;
  /** Verbatim source text, retained so an export can echo the original .prj. */
  wkt: string;
  /** Set when the WKT is structurally readable but the projection is unsupported. */
  unsupportedProjection?: string;
}

/**
 * Parses a .prj / .qpj / WKT string into a CrsRef.
 *
 * Resolution order matters: an explicit EPSG authority code wins, then a UTM
 * projection recognised from its central meridian, then a name match. If none
 * resolve, the CRS is returned with epsg: null rather than a guess — the caller
 * shows "declared but unrecognised" and asks (rule R2).
 */
export function parsePrj(text: string | null | undefined): ParsedPrj {
  const source = (text ?? '').trim();
  if (!source) return { crs: null, wkt: '' };
  const root = parseWktTree(source);
  if (!root) return { crs: null, wkt: source };

  const code = authorityCode(root);
  if (code) {
    const known = crsFromEpsg(code);
    if (known) return { crs: { ...known, wkt: source }, wkt: source };
  }

  const isProjected = ['PROJCS', 'PROJCRS'].includes(root.keyword);
  const name = nodeName(root) || (isProjected ? 'Unnamed projected CRS' : 'Unnamed geographic CRS');
  const datum = nodeName(findNode(root, 'DATUM')) || nodeName(findNode(root, 'GEOGCS')) || 'Unknown';
  const projectionName = nodeName(findNode(root, 'PROJECTION'));
  const unitNode = findNode(root, 'UNIT') ?? findNode(root, 'LENGTHUNIT');
  const unitName = nodeName(unitNode) || (isProjected ? 'metre' : 'degree');

  if (isProjected && /transverse[_\s]?mercator/i.test(projectionName)) {
    const centralMeridian = parameterValue(root, 'central_meridian') ?? parameterValue(root, 'longitude_of_center');
    const falseNorthing = parameterValue(root, 'false_northing') ?? 0;
    const scale = parameterValue(root, 'scale_factor') ?? 1;
    // UTM has a distinctive fingerprint: k0 = 0.9996 and a central meridian on
    // the 6°-zone grid. Recognising it recovers the EPSG code that ESRI .prj
    // files habitually omit.
    if (centralMeridian !== null && Math.abs(scale - 0.9996) < 1e-9) {
      const zone = Math.round((centralMeridian + 183) / 6);
      if (zone >= 1 && zone <= 60 && Math.abs(utmCentralMeridian(zone) - centralMeridian) < 1e-6) {
        const south = falseNorthing > 0;
        const utmCode = (south ? 32700 : 32600) + zone;
        const entry = epsgEntry(utmCode);
        // Only claim the WGS 84 EPSG code when the datum really is WGS 84.
        // The name arrives in many spellings — "WGS 84", "WGS_1984",
        // "D_WGS_1984", "World Geodetic System 1984" — so match them all.
        if (entry && /wgs[\s_]*(19)?84|world geodetic system 1984/i.test(datum)) {
          return { crs: { ...crsFromEpsg(utmCode)!, wkt: source }, wkt: source };
        }
        return {
          crs: {
            epsg: null,
            name,
            kind: 'projected',
            datum,
            projection: 'Transverse Mercator',
            unit: linearUnitFromWktName(unitName) ?? unitName,
            axisOrder: 'xy',
            wkt: source,
            utm: { zone, south },
          },
          wkt: source,
        };
      }
    }
  }

  const crs: CrsRef = {
    epsg: null,
    name,
    kind: isProjected ? 'projected' : 'geographic',
    datum,
    projection: projectionName || (isProjected ? 'Unknown projection' : 'Geographic'),
    unit: (isProjected ? linearUnitFromWktName(unitName) : null) ?? unitName,
    // WKT1 rarely states an axis order; x/y is the near-universal storage order
    // for projected data and for the geographic data written by GIS tools.
    axisOrder: 'xy',
    wkt: source,
  };

  const supported = isProjected ? /transverse[_\s]?mercator|mercator|lambert/i.test(projectionName) : true;
  return supported ? { crs, wkt: source } : { crs, wkt: source, unsupportedProjection: projectionName };
}

/**
 * Emits an ESRI-flavoured WKT1 .prj. Shapefile consumers are the main audience
 * and ESRI WKT is what they accept without complaint.
 */
export function buildPrj(crs: CrsRef | null): string {
  if (!crs) return '';
  if (crs.wkt) return crs.wkt;

  // ESRI names the geographic CS "GCS_x" and its datum "D_x"; they are separate
  // strings, not one derived from the other, and conflating them produces a
  // datum name ("D_GCS_WGS_1984") that no reader recognises.
  const geogcs = (geographicName: string, datumName: string, spheroidName: string, a: number, invF: number, primeMeridian = 0) =>
    `GEOGCS["${geographicName}",DATUM["${datumName}",SPHEROID["${spheroidName}",${a},${invF}]],` +
    `PRIMEM["Greenwich",${primeMeridian}],UNIT["Degree",0.0174532925199433]]`;

  const wgs84Geogcs = geogcs('GCS_WGS_1984', 'D_WGS_1984', 'WGS_1984', 6378137.0, 298.257223563);

  if (crs.kind === 'geographic' || crs.epsg === 4326) {
    return `${wgs84Geogcs}${crs.epsg ? `` : ''}`;
  }

  if (crs.epsg === 3857) {
    return (
      `PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",${wgs84Geogcs},PROJECTION["Mercator_Auxiliary_Sphere"],` +
      `PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],` +
      `PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]`
    );
  }

  if (crs.utm) {
    const { zone, south } = crs.utm;
    return (
      `PROJCS["WGS_1984_UTM_Zone_${zone}${south ? 'S' : 'N'}",${wgs84Geogcs},PROJECTION["Transverse_Mercator"],` +
      `PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",${south ? '10000000.0' : '0.0'}],` +
      `PARAMETER["Central_Meridian",${utmCentralMeridian(zone).toFixed(1)}],PARAMETER["Scale_Factor",0.9996],` +
      `PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`
    );
  }

  // A local/engineering grid has no geodetic definition to write. Emitting a
  // wrong .prj would be worse than emitting none, so the caller warns instead.
  return '';
}

/** Minimal PROJ string, for users pasting into QGIS or GDAL. */
export function buildProj4(crs: CrsRef | null): string {
  if (!crs) return '';
  if (crs.proj4) return crs.proj4;
  if (crs.epsg === 4326) return '+proj=longlat +datum=WGS84 +no_defs';
  if (crs.epsg === 3857) return '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs';
  if (crs.utm) return `+proj=utm +zone=${crs.utm.zone}${crs.utm.south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
  return '';
}

/** Reads the UTM zone out of a PROJ string, for the custom-CRS input box. */
export function parseProj4(text: string): CrsRef | null {
  const source = text.trim();
  if (!source.startsWith('+')) return null;
  const parts = new Map<string, string>();
  for (const token of source.split(/\s+/)) {
    const [key, value] = token.replace(/^\+/, '').split('=');
    parts.set(key, value ?? 'true');
  }
  const projection = parts.get('proj');
  if (projection === 'longlat') return crsFromEpsg(4326);
  if (projection === 'utm') {
    const zone = Number(parts.get('zone'));
    if (Number.isInteger(zone) && zone >= 1 && zone <= 60) {
      const south = parts.has('south');
      const datum = parts.get('datum') ?? 'WGS84';
      if (datum === 'WGS84') return crsFromEpsg((south ? 32700 : 32600) + zone);
      return {
        epsg: null,
        name: `${datum} / UTM zone ${zone}${south ? 'S' : 'N'}`,
        kind: 'projected',
        datum,
        projection: 'Transverse Mercator',
        unit: 'metre',
        axisOrder: 'xy',
        proj4: source,
        utm: { zone, south },
      };
    }
  }
  return null;
}
