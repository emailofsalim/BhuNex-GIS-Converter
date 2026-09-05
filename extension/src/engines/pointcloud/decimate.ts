/**
 * Point-cloud decimation and filtering.
 *
 * Decimation is never applied silently (instruction §D). Every mode here is an
 * explicit user choice, and the result records what was applied so the QA report
 * and the manifest can state the point count honestly.
 */

import { warn, type CirDataset, type CirPointArrays, type CirPointCloud, type Warning } from '../../core/cir';

export type DecimationMode = 'none' | 'nth' | 'grid' | 'voxel';

export interface DecimationSettings {
  mode: DecimationMode;
  /** Keep every nth point. */
  factor?: number;
  /** Cell size for grid (2D) and voxel (3D) decimation, in dataset units. */
  cell?: number;
}

export interface PointFilter {
  /** Keep only these classification codes. */
  classifications?: number[];
  /** Rectangular crop in dataset units. */
  crop?: { minX: number; minY: number; maxX: number; maxY: number };
  minZ?: number;
  maxZ?: number;
  minIntensity?: number;
  maxIntensity?: number;
}

function selectByIndex(points: CirPointArrays, indices: Int32Array): CirPointArrays {
  const take = <T extends { length: number; [index: number]: number }>(source: T | undefined, make: (size: number) => T, span = 1): T | undefined => {
    if (!source) return undefined;
    const out = make(indices.length * span);
    for (let index = 0; index < indices.length; index++) {
      for (let offset = 0; offset < span; offset++) out[index * span + offset] = source[indices[index] * span + offset];
    }
    return out;
  };

  return {
    x: take(points.x, (size) => new Float64Array(size))!,
    y: take(points.y, (size) => new Float64Array(size))!,
    z: take(points.z, (size) => new Float64Array(size))!,
    intensity: take(points.intensity, (size) => new Uint16Array(size)),
    classification: take(points.classification, (size) => new Uint8Array(size)),
    returnNumber: take(points.returnNumber, (size) => new Uint8Array(size)),
    numberOfReturns: take(points.numberOfReturns, (size) => new Uint8Array(size)),
    rgb: take(points.rgb, (size) => new Uint16Array(size), 3),
    gpsTime: take(points.gpsTime, (size) => new Float64Array(size)),
    scanAngle: take(points.scanAngle, (size) => new Int16Array(size)),
    sourceId: take(points.sourceId, (size) => new Uint16Array(size)),
  };
}

function recomputeBounds(points: CirPointArrays, count: number): CirPointCloud['bounds'] {
  if (count === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < count; index++) {
    const x = points.x[index];
    const y = points.y[index];
    const z = points.z[index];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/**
 * Selects the point indices that survive a filter and a decimation setting.
 *
 * Grid and voxel modes keep the first point encountered in each cell rather than
 * a cell centroid: a centroid is a synthetic point that was never measured, and
 * inventing measurements is exactly what rule R2 forbids.
 */
export function selectIndices(cloud: CirPointCloud, decimation: DecimationSettings, filter?: PointFilter): Int32Array {
  const count = cloud.loaded;
  const keep: number[] = [];
  const classSet = filter?.classifications?.length ? new Set(filter.classifications) : null;

  const passesFilter = (index: number): boolean => {
    if (filter?.crop) {
      const x = cloud.points.x[index];
      const y = cloud.points.y[index];
      if (x < filter.crop.minX || x > filter.crop.maxX || y < filter.crop.minY || y > filter.crop.maxY) return false;
    }
    if (filter?.minZ !== undefined && cloud.points.z[index] < filter.minZ) return false;
    if (filter?.maxZ !== undefined && cloud.points.z[index] > filter.maxZ) return false;
    if (classSet && !classSet.has(cloud.points.classification?.[index] ?? 0)) return false;
    const intensity = cloud.points.intensity?.[index];
    if (filter?.minIntensity !== undefined && (intensity ?? 0) < filter.minIntensity) return false;
    if (filter?.maxIntensity !== undefined && (intensity ?? 0) > filter.maxIntensity) return false;
    return true;
  };

  switch (decimation.mode) {
    case 'nth': {
      const stride = Math.max(1, Math.floor(decimation.factor ?? 1));
      for (let index = 0; index < count; index += stride) if (passesFilter(index)) keep.push(index);
      break;
    }
    case 'grid':
    case 'voxel': {
      const cell = decimation.cell && decimation.cell > 0 ? decimation.cell : 1;
      const seen = new Set<string>();
      const threeDimensional = decimation.mode === 'voxel';
      for (let index = 0; index < count; index++) {
        if (!passesFilter(index)) continue;
        const cx = Math.floor(cloud.points.x[index] / cell);
        const cy = Math.floor(cloud.points.y[index] / cell);
        const key = threeDimensional ? `${cx}|${cy}|${Math.floor(cloud.points.z[index] / cell)}` : `${cx}|${cy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        keep.push(index);
      }
      break;
    }
    case 'none':
    default:
      for (let index = 0; index < count; index++) if (passesFilter(index)) keep.push(index);
      break;
  }

  return Int32Array.from(keep);
}

export function applyDecimation(
  dataset: CirDataset,
  decimation: DecimationSettings,
  filter?: PointFilter
): { dataset: CirDataset; warnings: Warning[] } {
  const cloud = dataset.pointcloud;
  const warnings: Warning[] = [];
  if (!cloud) return { dataset, warnings };
  const noFilter = !filter || Object.keys(filter).length === 0;
  if (decimation.mode === 'none' && noFilter) return { dataset, warnings };

  const indices = selectIndices(cloud, decimation, filter);
  const kept = indices.length;
  // Nothing was removed, so the original typed arrays are reused rather than
  // copied — a 40-million-point clone is not free.
  const points = kept === cloud.loaded ? cloud.points : selectByIndex(cloud.points, indices);

  if (kept < cloud.loaded) {
    const percentage = cloud.loaded > 0 ? ((kept / cloud.loaded) * 100).toFixed(1) : '0';
    warnings.push(
      warn(
        'CLOUD_DECIMATED',
        `${kept.toLocaleString()} of ${cloud.loaded.toLocaleString()} points kept (${percentage}%).`,
        {
          severity: 'info',
          count: cloud.loaded - kept,
          reason:
            decimation.mode === 'none'
              ? 'A point filter was applied.'
              : decimation.mode === 'nth'
                ? `Every ${decimation.factor ?? 1}th point was kept.`
                : `One point per ${decimation.cell ?? 1} unit ${decimation.mode === 'voxel' ? 'voxel' : 'grid cell'} was kept — the first point measured in each cell, never a synthetic centroid.`,
          action: 'Set decimation to "None" and clear the filters to convert every point.',
        }
      )
    );
  }
  if (kept === 0) {
    warnings.push(
      warn('CLOUD_FILTER_EMPTY', 'The filter removed every point.', {
        severity: 'error',
        reason: 'No point satisfied the classification, crop, elevation or intensity limits.',
        action: 'Widen the filter — the inspector shows the actual value ranges in this cloud.',
      })
    );
  }

  const next: CirPointCloud = {
    ...cloud,
    loaded: kept,
    points,
    bounds: recomputeBounds(points, kept),
    decimation: decimation.mode === 'none' ? cloud.decimation : { mode: decimation.mode, factor: decimation.factor, cell: decimation.cell },
  };

  return { dataset: { ...dataset, pointcloud: next, warnings: [...dataset.warnings, ...warnings] }, warnings };
}

/**
 * Preview decimation target. A canvas cannot usefully draw more points than it
 * has pixels, so the preview caps hard — and the UI labels it PREVIEW ONLY.
 */
export const PREVIEW_POINT_BUDGET = 250000;

export function previewStride(pointCount: number, budget = PREVIEW_POINT_BUDGET): number {
  return pointCount <= budget ? 1 : Math.ceil(pointCount / budget);
}
