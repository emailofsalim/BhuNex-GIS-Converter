/**
 * Survey coordinate-table schema recognition.
 *
 * A survey CSV is not a generic table: the column order carries meaning (PNEZD
 * vs PENZD are the same five columns in a different order, and confusing them
 * swaps easting with northing on every point). Detection therefore matches
 * header names first and falls back to positional schemas only when the header
 * is absent, and the result is always shown to the user for confirmation before
 * any geometry is built.
 *
 * Original field names are never renamed — aliases are for detection only
 * (instruction §9.6, §31).
 */

import type { ColumnMapping } from '../../core/cir';

export type RoleId = 'id' | 'easting' | 'northing' | 'elevation' | 'latitude' | 'longitude' | 'code' | 'description';

/** Alias lists are matched case- and separator-insensitively. */
const ALIASES: Record<RoleId, string[]> = {
  id: ['point', 'pointid', 'pointno', 'pointnumber', 'pt', 'ptno', 'ptid', 'no', 'id', 'name', 'station', 'stn', 'sr', 'srno', 'serial'],
  easting: ['easting', 'east', 'e', 'x', 'xcoord', 'xcoordinate', 'utme', 'eastingm', 'ec'],
  northing: ['northing', 'north', 'n', 'y', 'ycoord', 'ycoordinate', 'utmn', 'northingm', 'nc'],
  elevation: ['elevation', 'elev', 'z', 'rl', 'level', 'height', 'ht', 'zcoord', 'reducedlevel', 'altitude', 'alt'],
  latitude: ['latitude', 'lat', 'ylat', 'latdd'],
  longitude: ['longitude', 'lon', 'lng', 'long', 'xlon', 'londd'],
  code: ['code', 'feature', 'featurecode', 'layer', 'type', 'class', 'category'],
  description: ['description', 'desc', 'remark', 'remarks', 'note', 'notes', 'comment', 'comments', 'detail'],
};

/**
 * Mining and cadastral field names that identify a domain but are not
 * coordinates. They are recognised so the inspector can label the dataset and
 * so the DXF writer can offer "layer by field" — the columns keep their
 * original names either way.
 */
export const DOMAIN_FIELDS: Record<string, string> = {
  bhid: 'Borehole ID',
  holeid: 'Borehole ID',
  borehole: 'Borehole ID',
  hole: 'Borehole ID',
  bench: 'Bench',
  crest: 'Crest',
  toe: 'Toe',
  pit: 'Pit',
  block: 'Block',
  plot: 'Plot',
  khasra: 'Khasra number',
  khewat: 'Khewat number',
  khatian: 'Khatian number',
  lithology: 'Lithology',
  assay: 'Assay',
  grade: 'Grade',
  depth: 'Depth',
  dip: 'Dip',
  azimuth: 'Azimuth',
};

function normalise(name: string): string {
  return name.toLowerCase().replace(/[\s_\-.()/]+/g, '');
}

export interface HeaderMatch {
  role: RoleId;
  columnIndex: number;
  /** Exact alias hit beats a prefix hit; used to resolve competing columns. */
  strength: number;
}

/** Matches header names to roles. Exact alias hits outrank prefix hits. */
export function matchHeaders(headers: string[]): HeaderMatch[] {
  const matches: HeaderMatch[] = [];
  headers.forEach((header, columnIndex) => {
    const key = normalise(header);
    if (!key) return;
    for (const [role, aliases] of Object.entries(ALIASES) as [RoleId, string[]][]) {
      if (aliases.includes(key)) {
        matches.push({ role, columnIndex, strength: 2 });
        return;
      }
    }
    for (const [role, aliases] of Object.entries(ALIASES) as [RoleId, string[]][]) {
      // Prefix matching catches "easting_m" and "northing (m)" without letting
      // "note" claim the northing role, because single letters are exact-only.
      if (aliases.some((alias) => alias.length > 2 && key.startsWith(alias))) {
        matches.push({ role, columnIndex, strength: 1 });
        return;
      }
    }
  });
  return matches;
}

export interface PositionalSchema {
  id: string;
  name: string;
  /** Role for each column, in order. */
  order: (RoleId | null)[];
  description: string;
}

/** The positional layouts total stations and survey controllers actually emit. */
export const POSITIONAL_SCHEMAS: PositionalSchema[] = [
  {
    id: 'pnezd',
    name: 'PNEZD',
    order: ['id', 'northing', 'easting', 'elevation', 'description'],
    description: 'Point, Northing, Easting, Elevation, Description — the Carlson/TDS default.',
  },
  {
    id: 'penzd',
    name: 'PENZD',
    order: ['id', 'easting', 'northing', 'elevation', 'description'],
    description: 'Point, Easting, Northing, Elevation, Description.',
  },
  {
    id: 'nez',
    name: 'NEZ',
    order: ['northing', 'easting', 'elevation'],
    description: 'Northing, Easting, Elevation with no point number.',
  },
  {
    id: 'enz',
    name: 'ENZ',
    order: ['easting', 'northing', 'elevation'],
    description: 'Easting, Northing, Elevation with no point number.',
  },
  {
    id: 'xyz',
    name: 'XYZ',
    order: ['easting', 'northing', 'elevation'],
    description: 'X, Y, Z — treated as easting, northing, elevation.',
  },
  {
    id: 'id-xyz',
    name: 'ID, X, Y, Z',
    order: ['id', 'easting', 'northing', 'elevation'],
    description: 'Identifier followed by X, Y, Z.',
  },
  {
    id: 'id-yxz',
    name: 'ID, Y, X, Z',
    order: ['id', 'northing', 'easting', 'elevation'],
    description: 'Identifier followed by Y, X, Z.',
  },
  {
    id: 'lonlatz',
    name: 'Longitude, Latitude, Elevation',
    order: ['longitude', 'latitude', 'elevation'],
    description: 'Geographic coordinates, longitude first.',
  },
  {
    id: 'latlonz',
    name: 'Latitude, Longitude, Elevation',
    order: ['latitude', 'longitude', 'elevation'],
    description: 'Geographic coordinates, latitude first.',
  },
];

export interface SchemaDetection {
  mapping: ColumnMapping | null;
  schemaId: string | null;
  schemaName: string | null;
  /** Human-readable account of how the mapping was reached, shown in the inspector. */
  rationale: string;
  /** True when the user must confirm before geometry is built. */
  requiresConfirmation: boolean;
  /** Domain labels recognised in the header, for the dataset summary. */
  domainHints: string[];
}

function looksGeographic(rows: (string | number | null)[][], xIndex: number, yIndex: number): boolean {
  let checked = 0;
  for (const row of rows.slice(0, 50)) {
    const x = Number(row[xIndex]);
    const y = Number(row[yIndex]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    checked++;
    if (Math.abs(x) > 180 || Math.abs(y) > 90) return false;
  }
  return checked > 0;
}

/**
 * Detects the schema of a coordinate table.
 *
 * Header names win when present. Without a header, a positional schema is only
 * offered as a suggestion that the user must confirm: PNEZD and PENZD are
 * indistinguishable from the numbers alone, and choosing wrongly transposes
 * every coordinate.
 */
export function detectSchema(
  headers: string[] | null,
  rows: (string | number | null)[][],
  columnCount: number
): SchemaDetection {
  const domainHints = new Set<string>();
  if (headers) {
    for (const header of headers) {
      const label = DOMAIN_FIELDS[normalise(header)];
      if (label) domainHints.add(label);
    }
  }

  if (headers && headers.length > 0) {
    const matches = matchHeaders(headers);
    const roles: ColumnMapping['roles'] = {};
    // Strongest match wins each role; first column wins a tie so the leftmost
    // "E" column is the easting when a file repeats a name.
    for (const role of ['id', 'easting', 'northing', 'elevation', 'latitude', 'longitude', 'code', 'description'] as RoleId[]) {
      const candidates = matches.filter((match) => match.role === role).sort((a, b) => b.strength - a.strength || a.columnIndex - b.columnIndex);
      if (candidates.length > 0) roles[role] = candidates[0].columnIndex;
    }

    const hasProjected = roles.easting !== undefined && roles.northing !== undefined;
    const hasGeographic = roles.latitude !== undefined && roles.longitude !== undefined;

    if (hasProjected || hasGeographic) {
      // A header naming X/Y whose values fall inside ±180/±90 is far more likely
      // to be longitude/latitude than a projected grid, so it is re-labelled and
      // the change is stated in the rationale rather than applied invisibly.
      if (hasProjected && !hasGeographic && looksGeographic(rows, roles.easting!, roles.northing!)) {
        return {
          mapping: {
            roles: { ...roles, longitude: roles.easting, latitude: roles.northing, easting: undefined, northing: undefined },
            coordinateOrder: 'lon-lat',
          },
          schemaId: 'header-geographic',
          schemaName: 'Header-named geographic table',
          rationale: `Columns "${headers[roles.easting!]}" and "${headers[roles.northing!]}" were matched to X/Y, but every value falls within ±180° / ±90°, so they are read as longitude and latitude.`,
          requiresConfirmation: true,
          domainHints: [...domainHints],
        };
      }
      const order: ColumnMapping['coordinateOrder'] = hasGeographic ? 'lon-lat' : 'easting-northing';
      const named = hasGeographic
        ? `"${headers[roles.longitude!]}" / "${headers[roles.latitude!]}"`
        : `"${headers[roles.easting!]}" / "${headers[roles.northing!]}"`;
      return {
        mapping: { roles, coordinateOrder: order },
        schemaId: 'header-named',
        schemaName: 'Header-named coordinate table',
        rationale: `Coordinate columns identified from the header row: ${named}. Column order in the file does not affect the mapping.`,
        requiresConfirmation: false,
        domainHints: [...domainHints],
      };
    }
  }

  // No usable header. Offer the positional schema whose column count matches,
  // preferring PNEZD for five columns because it is the most common controller
  // export — but always requiring confirmation.
  const candidates = POSITIONAL_SCHEMAS.filter((schema) => schema.order.length === columnCount);
  const chosen = candidates[0] ?? POSITIONAL_SCHEMAS.find((schema) => schema.order.length <= columnCount) ?? null;
  if (!chosen) {
    return {
      mapping: null,
      schemaId: null,
      schemaName: null,
      rationale: `The table has ${columnCount} column(s) and no recognisable header, so no coordinate schema could be matched.`,
      requiresConfirmation: true,
      domainHints: [...domainHints],
    };
  }

  const roles: ColumnMapping['roles'] = {};
  chosen.order.forEach((role, index) => {
    if (role) roles[role] = index;
  });

  const geographicSchema = chosen.id === 'lonlatz' || chosen.id === 'latlonz';
  const order: ColumnMapping['coordinateOrder'] = geographicSchema
    ? chosen.id === 'latlonz'
      ? 'lat-lon'
      : 'lon-lat'
    : chosen.order.indexOf('northing') < chosen.order.indexOf('easting')
      ? 'northing-easting'
      : 'easting-northing';

  return {
    mapping: { roles, coordinateOrder: order, schemaId: chosen.id },
    schemaId: chosen.id,
    schemaName: chosen.name,
    rationale: `No header row was found. ${chosen.name} (${chosen.description}) matches the ${columnCount}-column layout. Confirm the order before converting — ${chosen.id === 'pnezd' ? 'PNEZD and PENZD are indistinguishable from the values alone' : 'a wrong choice transposes easting and northing'}.`,
    requiresConfirmation: true,
    domainHints: [...domainHints],
  };
}

/** True when the first row looks like labels rather than measurements. */
export function looksLikeHeader(row: (string | number | null)[]): boolean {
  let textCells = 0;
  let numericCells = 0;
  for (const cell of row) {
    const text = String(cell ?? '').trim();
    if (!text) continue;
    if (Number.isFinite(Number(text))) numericCells++;
    else textCells++;
  }
  if (textCells === 0) return false;
  // A header is mostly text; a data row with a point code is mostly numbers.
  return textCells >= numericCells;
}

/** Reads the coordinate for one row through a mapping, or null when incomplete. */
export function coordinateFromRow(
  row: (string | number | null)[],
  mapping: ColumnMapping
): { x: number; y: number; z: number | null } | null {
  const read = (index: number | undefined): number | null => {
    if (index === undefined) return null;
    const value = row[index];
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : null;
  };

  const { roles } = mapping;
  const geographic = roles.longitude !== undefined && roles.latitude !== undefined;
  const x = geographic ? read(roles.longitude) : read(roles.easting);
  const y = geographic ? read(roles.latitude) : read(roles.northing);
  if (x === null || y === null) return null;
  return { x, y, z: read(roles.elevation) };
}
