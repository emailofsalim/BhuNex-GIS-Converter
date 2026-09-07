/**
 * Borehole and drill-hole model (spec §28.1).
 *
 * A borehole never arrives as one thing. The collar is a point — hole id,
 * easting, northing, RL, depth, azimuth, dip — and the geology is a separate
 * table of depth intervals keyed by hole id: from, to, lithology, recovery,
 * RQD, sample, assay. Two files, joined by a column, and every mining package
 * spells the columns differently.
 *
 * This module recognises both shapes, joins them, and produces a `Borehole`
 * the KML template and any future 3D trace can render.
 *
 * It does not invent geology. A collar with no intervals is a collar with no
 * intervals; an interval whose hole id matches nothing is reported as orphaned
 * rather than attached to the nearest hole (R2).
 */

import type { CirDataset, CirFeature, Position } from '../../core/cir';

export interface BoreholeInterval {
  from: number;
  to: number;
  /** to − from, computed rather than trusted: sources disagree with themselves. */
  thickness: number;
  lithology?: string;
  /** Core recovery as a percentage, where the source gives one. */
  recovery?: number;
  /** Rock Quality Designation, percent. */
  rqd?: number;
  sampleId?: string;
  /** Assay values by element or oxide, e.g. { Fe: 62.3, SiO2: 3.1 }. */
  assay?: Record<string, number>;
  remarks?: string;
}

export interface Borehole {
  holeId: string;
  /** Collar position in the dataset's CRS. */
  collar: Position | null;
  /** Reduced level of the collar. */
  rl: number | null;
  totalDepth: number | null;
  azimuth: number | null;
  dip: number | null;
  site?: string;
  intervals: BoreholeInterval[];
  /** Everything else on the collar record, kept so nothing is silently dropped. */
  properties: Record<string, unknown>;
}

export interface BoreholeModel {
  holes: Borehole[];
  /** Intervals whose hole id matched no collar. */
  orphanIntervals: { holeId: string; from: number; to: number }[];
  /** Collars that carry no interval data. */
  collarsWithoutLog: string[];
}

/**
 * Column aliases, lower-cased and stripped of separators.
 *
 * Drawn from the naming every mining package actually uses rather than one
 * standard: Datamine, Surpac, Micromine, Vulcan and half the spreadsheets in
 * between all differ, and a model that only read one of them would be useless
 * on the next site.
 */
const ALIASES: Record<string, string[]> = {
  holeId: ['holeid', 'hole', 'bhid', 'boreholeid', 'borehole', 'drillhole', 'dhid', 'holeno', 'holenumber', 'bh', 'id'],
  easting: ['easting', 'east', 'x', 'xcollar', 'collareast', 'collarx', 'e'],
  northing: ['northing', 'north', 'y', 'ycollar', 'collarnorth', 'collary', 'n'],
  rl: ['rl', 'elevation', 'elev', 'z', 'zcollar', 'collarrl', 'collarz', 'level', 'reducedlevel'],
  totalDepth: ['totaldepth', 'depth', 'eoh', 'endofhole', 'maxdepth', 'holedepth', 'td'],
  azimuth: ['azimuth', 'azi', 'bearing', 'brg', 'dipdirection', 'dipdir'],
  dip: ['dip', 'inclination', 'incl', 'plunge'],
  site: ['site', 'project', 'prospect', 'mine', 'lease', 'area'],
  from: ['from', 'depthfrom', 'fromdepth', 'top', 'start'],
  to: ['to', 'depthto', 'todepth', 'bottom', 'end'],
  lithology: ['lithology', 'lith', 'rocktype', 'rock', 'geology', 'litho', 'description', 'desc'],
  recovery: ['recovery', 'corerecovery', 'rec', 'recoverypct', 'recovery%'],
  rqd: ['rqd', 'rqdpct', 'rqd%'],
  sampleId: ['sampleid', 'sample', 'sampleno', 'samplenumber', 'specimen'],
  remarks: ['remarks', 'remark', 'comment', 'comments', 'note', 'notes'],
};

/** Assay columns are recognised by element symbol or a grade-like suffix. */
const ASSAY_PATTERN = /^(au|ag|cu|pb|zn|fe|ni|co|mn|cr|al2o3|sio2|cao|mgo|p2o5|tio2|k2o|na2o|loi|s|as|sb|mo|w|u3o8|v2o5)(_?(ppm|ppb|pct|%|gpt|g_t))?$/i;

function normalise(key: string): string {
  return key.toLowerCase().replace(/[\s_\-.()]/g, '');
}

function findKey(properties: Record<string, unknown>, role: keyof typeof ALIASES): string | null {
  const wanted = ALIASES[role];
  for (const key of Object.keys(properties)) {
    if (wanted.includes(normalise(key))) return key;
  }
  return null;
}

function numberAt(properties: Record<string, unknown>, key: string | null): number | null {
  if (!key) return null;
  const value = properties[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function textAt(properties: Record<string, unknown>, key: string | null): string | undefined {
  if (!key) return undefined;
  const value = properties[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** True when a record looks like a depth interval rather than a collar. */
export function looksLikeInterval(properties: Record<string, unknown>): boolean {
  return findKey(properties, 'from') !== null && findKey(properties, 'to') !== null;
}

/** True when a record looks like a collar. */
export function looksLikeCollar(properties: Record<string, unknown>): boolean {
  if (looksLikeInterval(properties)) return false;
  const hasId = findKey(properties, 'holeId') !== null;
  const hasDepthOrOrientation =
    findKey(properties, 'totalDepth') !== null || findKey(properties, 'azimuth') !== null || findKey(properties, 'dip') !== null;
  return hasId && hasDepthOrOrientation;
}

function readAssay(properties: Record<string, unknown>): Record<string, number> | undefined {
  const assay: Record<string, number> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!ASSAY_PATTERN.test(normalise(key))) continue;
    const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
    if (Number.isFinite(parsed)) assay[key] = parsed;
  }
  return Object.keys(assay).length > 0 ? assay : undefined;
}

function readInterval(properties: Record<string, unknown>): { holeId: string; interval: BoreholeInterval } | null {
  const holeId = textAt(properties, findKey(properties, 'holeId'));
  const from = numberAt(properties, findKey(properties, 'from'));
  const to = numberAt(properties, findKey(properties, 'to'));
  if (!holeId || from === null || to === null) return null;

  return {
    holeId,
    interval: {
      from,
      to,
      // Computed, never read: sources routinely carry a thickness column that
      // disagrees with its own from/to, and the depths are the measurement.
      thickness: to - from,
      lithology: textAt(properties, findKey(properties, 'lithology')),
      recovery: numberAt(properties, findKey(properties, 'recovery')) ?? undefined,
      rqd: numberAt(properties, findKey(properties, 'rqd')) ?? undefined,
      sampleId: textAt(properties, findKey(properties, 'sampleId')),
      assay: readAssay(properties),
      remarks: textAt(properties, findKey(properties, 'remarks')),
    },
  };
}

function collarPosition(feature: CirFeature, properties: Record<string, unknown>): Position | null {
  const geometry = feature.geometry;
  if (geometry?.type === 'Point') return geometry.coordinates as Position;
  const easting = numberAt(properties, findKey(properties, 'easting'));
  const northing = numberAt(properties, findKey(properties, 'northing'));
  return easting !== null && northing !== null ? [easting, northing] : null;
}

/**
 * Builds boreholes from a dataset holding collars and interval rows.
 *
 * Both may be in the same layer or different ones; the join is by hole id, not
 * by layer, because that is how the data actually arrives.
 */
export function buildBoreholeModel(dataset: CirDataset): BoreholeModel {
  const collars = new Map<string, Borehole>();
  const intervalsByHole = new Map<string, BoreholeInterval[]>();
  const orphanIntervals: BoreholeModel['orphanIntervals'] = [];

  const records: { feature: CirFeature; properties: Record<string, unknown> }[] = [];
  for (const layer of dataset.layers) {
    for (const feature of layer.features) records.push({ feature, properties: feature.properties ?? {} });
  }
  // A table that was never converted to points still holds the log.
  if (dataset.table) {
    for (const row of dataset.table.rows) {
      const properties: Record<string, unknown> = {};
      dataset.table.columns.forEach((column, index) => {
        properties[column.name] = row[index];
      });
      records.push({ feature: { geometry: null, properties }, properties });
    }
  }

  for (const record of records) {
    if (looksLikeInterval(record.properties)) {
      const parsed = readInterval(record.properties);
      if (!parsed) continue;
      const list = intervalsByHole.get(parsed.holeId) ?? [];
      list.push(parsed.interval);
      intervalsByHole.set(parsed.holeId, list);
      continue;
    }

    const holeId = textAt(record.properties, findKey(record.properties, 'holeId'));
    if (!holeId) continue;
    if (collars.has(holeId)) continue;

    collars.set(holeId, {
      holeId,
      collar: collarPosition(record.feature, record.properties),
      rl: numberAt(record.properties, findKey(record.properties, 'rl')),
      totalDepth: numberAt(record.properties, findKey(record.properties, 'totalDepth')),
      azimuth: numberAt(record.properties, findKey(record.properties, 'azimuth')),
      dip: numberAt(record.properties, findKey(record.properties, 'dip')),
      site: textAt(record.properties, findKey(record.properties, 'site')),
      intervals: [],
      properties: record.properties,
    });
  }

  for (const [holeId, intervals] of intervalsByHole) {
    const hole = collars.get(holeId);
    if (!hole) {
      // Reported, never attached to the nearest hole. A log against the wrong
      // borehole is worse than a log the user is told is unmatched.
      for (const interval of intervals) orphanIntervals.push({ holeId, from: interval.from, to: interval.to });
      continue;
    }
    hole.intervals = intervals.sort((left, right) => left.from - right.from);
  }

  const holes = [...collars.values()];
  return {
    holes,
    orphanIntervals,
    collarsWithoutLog: holes.filter((hole) => hole.intervals.length === 0).map((hole) => hole.holeId),
  };
}

/**
 * Gaps and overlaps in a hole's log.
 *
 * A logged hole should be continuous from collar to end of hole. A gap means a
 * missing interval; an overlap means two records claim the same metre, and one
 * of them is wrong. Both are common in hand-compiled logs and neither is
 * visible from the table.
 */
export function checkLogContinuity(hole: Borehole): { gaps: { from: number; to: number }[]; overlaps: { from: number; to: number }[] } {
  const gaps: { from: number; to: number }[] = [];
  const overlaps: { from: number; to: number }[] = [];
  const sorted = [...hole.intervals].sort((left, right) => left.from - right.from);

  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.from > previous.to) gaps.push({ from: previous.to, to: current.from });
    else if (current.from < previous.to) overlaps.push({ from: current.from, to: previous.to });
  }

  if (sorted.length > 0) {
    if (sorted[0].from > 0) gaps.unshift({ from: 0, to: sorted[0].from });
    const last = sorted[sorted.length - 1];
    if (hole.totalDepth !== null && last.to < hole.totalDepth) gaps.push({ from: last.to, to: hole.totalDepth });
  }

  return { gaps, overlaps };
}
