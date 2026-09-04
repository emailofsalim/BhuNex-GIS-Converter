/**
 * Unit engine.
 *
 * Linear, angular, area and volume are separate namespaces at the type level, so
 * an area factor can never reach a coordinate (instruction §7.2). The conversion
 * function will not compile — and will not run — across namespaces.
 *
 * The US survey foot and the international foot are distinct constants here on
 * purpose: they differ by 2 ppm, which is 20 mm over a 10 km traverse.
 */

export type LinearUnitId = 'mm' | 'cm' | 'm' | 'km' | 'in' | 'ft' | 'us-ft' | 'yd' | 'mi' | 'nmi';
export type AngularUnitId = 'deg' | 'rad' | 'gon';
export type AreaUnitId = 'm2' | 'ha' | 'acre' | 'ft2' | 'km2';
export type VolumeUnitId = 'm3' | 'ft3' | 'yd3';

export interface UnitDef<T extends string> {
  id: T;
  name: string;
  symbol: string;
  /** Multiply a value in this unit by `toBase` to get the namespace base unit. */
  toBase: number;
}

const FOOT_INTERNATIONAL = 0.3048; // exact by definition
const FOOT_US_SURVEY = 1200 / 3937; // exact by definition, ≈ 0.30480060960122

export const LINEAR_UNITS: Record<LinearUnitId, UnitDef<LinearUnitId>> = {
  mm: { id: 'mm', name: 'Millimetre', symbol: 'mm', toBase: 0.001 },
  cm: { id: 'cm', name: 'Centimetre', symbol: 'cm', toBase: 0.01 },
  m: { id: 'm', name: 'Metre', symbol: 'm', toBase: 1 },
  km: { id: 'km', name: 'Kilometre', symbol: 'km', toBase: 1000 },
  in: { id: 'in', name: 'Inch', symbol: 'in', toBase: FOOT_INTERNATIONAL / 12 },
  ft: { id: 'ft', name: 'Foot (international)', symbol: 'ft', toBase: FOOT_INTERNATIONAL },
  'us-ft': { id: 'us-ft', name: 'US survey foot', symbol: 'usft', toBase: FOOT_US_SURVEY },
  yd: { id: 'yd', name: 'Yard', symbol: 'yd', toBase: FOOT_INTERNATIONAL * 3 },
  mi: { id: 'mi', name: 'Mile', symbol: 'mi', toBase: FOOT_INTERNATIONAL * 5280 },
  nmi: { id: 'nmi', name: 'Nautical mile', symbol: 'NM', toBase: 1852 },
};

export const ANGULAR_UNITS: Record<AngularUnitId, UnitDef<AngularUnitId>> = {
  deg: { id: 'deg', name: 'Degree', symbol: '°', toBase: 1 },
  rad: { id: 'rad', name: 'Radian', symbol: 'rad', toBase: 180 / Math.PI },
  gon: { id: 'gon', name: 'Gon / grad', symbol: 'gon', toBase: 0.9 },
};

export const AREA_UNITS: Record<AreaUnitId, UnitDef<AreaUnitId>> = {
  m2: { id: 'm2', name: 'Square metre', symbol: 'm²', toBase: 1 },
  ha: { id: 'ha', name: 'Hectare', symbol: 'ha', toBase: 10000 },
  acre: { id: 'acre', name: 'Acre', symbol: 'ac', toBase: 4046.8564224 },
  ft2: { id: 'ft2', name: 'Square foot', symbol: 'ft²', toBase: FOOT_INTERNATIONAL ** 2 },
  km2: { id: 'km2', name: 'Square kilometre', symbol: 'km²', toBase: 1e6 },
};

export const VOLUME_UNITS: Record<VolumeUnitId, UnitDef<VolumeUnitId>> = {
  m3: { id: 'm3', name: 'Cubic metre', symbol: 'm³', toBase: 1 },
  ft3: { id: 'ft3', name: 'Cubic foot', symbol: 'ft³', toBase: FOOT_INTERNATIONAL ** 3 },
  yd3: { id: 'yd3', name: 'Cubic yard', symbol: 'yd³', toBase: (FOOT_INTERNATIONAL * 3) ** 3 },
};

function convert<T extends string>(table: Record<T, UnitDef<T>>, value: number, from: T, to: T): number {
  const source = table[from];
  const target = table[to];
  if (!source || !target) throw new Error(`Unknown unit conversion ${String(from)} -> ${String(to)}`);
  if (from === to) return value;
  return (value * source.toBase) / target.toBase;
}

export function convertLinear(value: number, from: LinearUnitId, to: LinearUnitId): number {
  return convert(LINEAR_UNITS, value, from, to);
}

export function convertAngular(value: number, from: AngularUnitId, to: AngularUnitId): number {
  return convert(ANGULAR_UNITS, value, from, to);
}

export function convertArea(value: number, from: AreaUnitId, to: AreaUnitId): number {
  return convert(AREA_UNITS, value, from, to);
}

export function convertVolume(value: number, from: VolumeUnitId, to: VolumeUnitId): number {
  return convert(VOLUME_UNITS, value, from, to);
}

export function isLinearUnit(id: string): id is LinearUnitId {
  return Object.prototype.hasOwnProperty.call(LINEAR_UNITS, id);
}

/**
 * DXF $INSUNITS code -> linear unit. Codes outside this table (astronomical,
 * parsec, microinch) are real but never appear in survey drawings; they map to
 * null so the caller reports "unit not recognised" rather than assuming metres.
 */
const INSUNITS: Record<number, LinearUnitId> = {
  1: 'in',
  2: 'ft',
  3: 'mi',
  4: 'mm',
  5: 'cm',
  6: 'm',
  7: 'km',
  10: 'yd',
  15: 'nmi',
};

export function linearUnitFromInsunits(code: number): LinearUnitId | null {
  return INSUNITS[code] ?? null;
}

export function insunitsFromLinearUnit(unit: LinearUnitId): number {
  for (const [code, id] of Object.entries(INSUNITS)) if (id === unit) return Number(code);
  return 0; // 0 = unitless, which is the honest answer for us-ft in a DXF header
}

/**
 * Maps the unit names that appear in WKT / PRJ text to our ids. WKT spells the
 * US survey foot half a dozen ways, and getting it wrong is a 2 ppm scale error.
 */
export function linearUnitFromWktName(name: string): LinearUnitId | null {
  const key = name.toLowerCase().replace(/[\s_-]+/g, '');
  if (key.includes('ussurvey') || key === 'usft' || key === 'ussurveyfoot' || key === 'footussurvey') return 'us-ft';
  if (key.startsWith('metre') || key.startsWith('meter') || key === 'm') return 'm';
  if (key.startsWith('foot') || key === 'ft') return 'ft';
  if (key.startsWith('kilo')) return 'km';
  if (key.startsWith('milli')) return 'mm';
  if (key.startsWith('centi')) return 'cm';
  if (key.startsWith('inch')) return 'in';
  if (key.startsWith('yard')) return 'yd';
  if (key.startsWith('degree')) return null; // angular — caller handles separately
  return null;
}
