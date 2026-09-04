/**
 * CRS transformation with the safety rules the product depends on.
 *
 * The engine will refuse a transform it cannot actually perform rather than
 * approximate one (rule R4). Concretely: datum shifts outside the WGS 84 family
 * are refused, because doing them properly needs Helmert parameters or grid
 * files that are not bundled, and silently treating Everest 1830 coordinates as
 * WGS 84 puts a boundary hundreds of metres from where it belongs.
 */

import type { CirDataset, CirFeature, CrsRef, Position } from '../core/cir';
import { warn, type Warning } from '../core/cir';
import { ConversionError } from '../core/errors';
import { mapPositions } from '../core/geometry';
import { epsgEntry, WGS84_CRS } from './epsg';
import {
  geographicToUtm,
  geographicToWebMercator,
  utmToGeographic,
  webMercatorToGeographic,
  type GeographicPoint,
} from './projection';

/** Datums the bundled engine can move between without a shift (they coincide within ~1 m). */
const WGS84_FAMILY = new Set(['WGS 1984', 'WGS84', 'WGS 84', 'World Geodetic System 1984', 'D_WGS_1984']);

export function isWgs84Family(crs: CrsRef | null): boolean {
  if (!crs) return false;
  const datum = crs.datum.replace(/^D_/, '').replace(/_/g, ' ').trim();
  return WGS84_FAMILY.has(crs.datum) || WGS84_FAMILY.has(datum) || /wgs\s*(19)?84/i.test(datum);
}

export function crsLabel(crs: CrsRef | null): string {
  if (!crs) return 'Not declared';
  return crs.epsg ? `EPSG:${crs.epsg} — ${crs.name}` : crs.name;
}

export function sameCrs(a: CrsRef | null, b: CrsRef | null): boolean {
  if (!a || !b) return false;
  if (a.epsg && b.epsg) return a.epsg === b.epsg;
  if (a.utm && b.utm) return a.utm.zone === b.utm.zone && a.utm.south === b.utm.south && a.datum === b.datum;
  return a.name === b.name && a.datum === b.datum && a.projection === b.projection;
}

/** Converts a coordinate in `crs` to WGS 84 longitude/latitude. */
function toGeographic(x: number, y: number, crs: CrsRef): GeographicPoint {
  if (crs.kind === 'geographic') return { lon: x, lat: y };
  if (crs.epsg === 3857) return webMercatorToGeographic({ x, y });
  if (crs.utm) return utmToGeographic({ x, y }, crs.utm.zone, crs.utm.south);
  throw new ConversionError({
    code: 'CRS_UNSUPPORTED_SOURCE',
    what: `Coordinates cannot be transformed out of ${crsLabel(crs)}.`,
    why: 'The bundled projection engine supports geographic CRS, Web Mercator and Transverse Mercator / UTM. This CRS uses a projection that is not implemented.',
    action: 'Reproject the file in QGIS or GDAL first, or choose a target that keeps the source CRS unchanged.',
  });
}

/** Converts WGS 84 longitude/latitude into `crs`. */
function fromGeographic(point: GeographicPoint, crs: CrsRef): { x: number; y: number } {
  if (crs.kind === 'geographic') return { x: point.lon, y: point.lat };
  if (crs.epsg === 3857) return geographicToWebMercator(point);
  if (crs.utm) return geographicToUtm(point, crs.utm.zone, crs.utm.south);
  throw new ConversionError({
    code: 'CRS_UNSUPPORTED_TARGET',
    what: `Coordinates cannot be transformed into ${crsLabel(crs)}.`,
    why: 'The bundled projection engine supports geographic CRS, Web Mercator and Transverse Mercator / UTM as targets.',
    action: 'Pick a UTM zone, WGS 84 or Web Mercator, or export in the source CRS and reproject downstream.',
  });
}

export type CoordinateTransform = (position: Position) => Position;

export interface TransformPlan {
  transform: CoordinateTransform;
  /** True when source and target are the same CRS and no arithmetic is applied. */
  identity: boolean;
  warnings: Warning[];
  from: CrsRef | null;
  to: CrsRef | null;
}

/**
 * Builds a transform from `from` to `to`.
 *
 * Throws when the transform is impossible with the bundled engine. Refusing is
 * the correct behaviour: an approximate answer in a cadastral or mine-survey
 * context is worse than no answer.
 */
export function planTransform(from: CrsRef | null, to: CrsRef | null): TransformPlan {
  const warnings: Warning[] = [];

  if (!to || !from || sameCrs(from, to)) {
    return { transform: (position) => position, identity: true, warnings, from, to };
  }

  if (!isWgs84Family(from) || !isWgs84Family(to)) {
    const foreign = !isWgs84Family(from) ? from : to;
    throw new ConversionError({
      code: 'CRS_DATUM_SHIFT_UNAVAILABLE',
      what: `A datum shift involving ${crsLabel(foreign)} was requested.`,
      why: `${foreign.datum} is not in the WGS 84 family, and no Helmert parameters or NTv2 grid for it are bundled. Treating the coordinates as WGS 84 would displace them by hundreds of metres.`,
      action: 'Transform the datum in QGIS, GDAL or your survey software first, then convert here; or keep the source CRS and only change format.',
    });
  }

  // The axis-order flag describes the authority's storage convention. CIR
  // coordinates are already normalised to x/y by the readers, so a transform
  // never has to swap — but a mismatch is worth recording in provenance.
  if (from.axisOrder !== to.axisOrder) {
    warnings.push(
      warn('CRS_AXIS_ORDER', `Source and target declare different authority axis orders (${from.axisOrder} → ${to.axisOrder}).`, {
        severity: 'info',
        reason: 'Coordinates are held internally in x/y order, so no swap is applied during the transform.',
        action: 'Check the coordinate order shown in the inspector if the output looks mirrored.',
      })
    );
  }

  const transform: CoordinateTransform = (position) => {
    const geographic = toGeographic(position[0], position[1], from);
    const projected = fromGeographic(geographic, to);
    const out: Position = [projected.x, projected.y];
    // Z passes through untouched: a horizontal transform says nothing about
    // heights, and inventing a vertical shift here would violate rule R4.
    if (position.length > 2) out.push(position[2]);
    if (position.length > 3) out.push(position[3]);
    return out;
  };

  return { transform, identity: false, warnings, from, to };
}

export function transformFeatures(features: CirFeature[], plan: TransformPlan): CirFeature[] {
  if (plan.identity) return features;
  return features.map((feature) => ({
    ...feature,
    geometry: feature.geometry ? mapPositions(feature.geometry, plan.transform) : null,
  }));
}

export function transformDataset(dataset: CirDataset, target: CrsRef | null): CirDataset {
  const plan = planTransform(dataset.crs, target);
  if (plan.identity) return dataset;
  return {
    ...dataset,
    crs: target,
    crsOrigin: dataset.crsOrigin,
    layers: dataset.layers.map((layer) => ({ ...layer, features: transformFeatures(layer.features, plan) })),
    warnings: [...dataset.warnings, ...plan.warnings],
  };
}

export interface CrsSuggestion {
  crs: CrsRef | null;
  /** Why this was suggested — shown next to the INFERRED label. */
  rationale: string;
  /** Ambiguous data blocks conversion until the user chooses (instruction §6.3). */
  ambiguous: boolean;
}

/**
 * Suggests — never decides — a source CRS from coordinate magnitudes.
 *
 * The UTM case is deliberately marked ambiguous: an easting of 412,345 is valid
 * in all 60 zones and in both hemispheres, so the tool cannot know which one
 * without being told.
 */
export function suggestCrs(bounds: { minX: number; minY: number; maxX: number; maxY: number }): CrsSuggestion {
  const { minX, minY, maxX, maxY } = bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return { crs: null, rationale: 'No finite coordinates were found.', ambiguous: true };
  }

  const geographicRange = Math.abs(minX) <= 180 && Math.abs(maxX) <= 180 && Math.abs(minY) <= 90 && Math.abs(maxY) <= 90;
  if (geographicRange) {
    return {
      crs: WGS84_CRS,
      rationale: 'All coordinates fall inside ±180° / ±90°, which is consistent with geographic degrees.',
      // A local site grid with small coordinates looks identical, so this is a
      // suggestion the user still has to confirm — but it is the strong case.
      ambiguous: Math.abs(maxX) < 10 && Math.abs(maxY) < 10,
    };
  }

  const utmRange = minX >= 100000 && maxX <= 900000 && minY >= 0 && maxY <= 10000000;
  if (utmRange) {
    return {
      crs: null,
      rationale:
        'Coordinate magnitudes match a UTM grid, but an easting near 500,000 is valid in every one of the 60 zones and in both hemispheres. The zone cannot be derived from the numbers alone.',
      ambiguous: true,
    };
  }

  if (Math.abs(minX) <= 20037509 && Math.abs(maxX) <= 20037509 && Math.abs(maxY) <= 20048967 && Math.abs(maxX) > 900000) {
    return {
      crs: epsgEntry(3857) ? { ...WGS84_CRS, epsg: 3857, name: 'WGS 84 / Pseudo-Mercator', kind: 'projected', projection: 'Popular Visualisation Pseudo Mercator', unit: 'metre', axisOrder: 'xy' } : null,
      rationale: 'Coordinate magnitudes match the Web Mercator world extent.',
      ambiguous: true,
    };
  }

  return {
    crs: null,
    rationale: 'Coordinates do not match a geographic, UTM or Web Mercator range. This looks like a local or engineering grid.',
    ambiguous: true,
  };
}

/**
 * Applies the CRS resolution order from instruction §6.3: a declared CRS beats a
 * sidecar, which beats a user selection, which beats a suggestion. The result
 * records where the answer came from so the manifest can show it.
 */
export function resolveSourceCrs(candidates: {
  declared?: CrsRef | null;
  sidecar?: CrsRef | null;
  user?: CrsRef | null;
  suggestion?: CrsSuggestion;
}): { crs: CrsRef | null; origin: CirDataset['crsOrigin']; blocked: boolean; message?: string } {
  if (candidates.declared) return { crs: candidates.declared, origin: 'declared', blocked: false };
  if (candidates.sidecar) return { crs: candidates.sidecar, origin: 'sidecar', blocked: false };
  if (candidates.user) return { crs: candidates.user, origin: 'user', blocked: false };
  const suggestion = candidates.suggestion;
  if (suggestion && suggestion.crs && !suggestion.ambiguous) {
    return { crs: suggestion.crs, origin: 'inferred', blocked: false };
  }
  return {
    crs: null,
    origin: 'unknown',
    blocked: true,
    message: suggestion?.rationale ?? 'The source declares no CRS and the coordinates are ambiguous.',
  };
}
