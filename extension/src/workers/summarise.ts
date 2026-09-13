/**
 * The dataset, reduced to what the workspace renders.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * This used to live inside `convert.worker.ts`, which meant only the WORKER
 * path produced it. `workers/client.ts` runs anything under
 * `WORKER_THRESHOLD_BYTES` (2 MB) inline on the main thread, and that branch
 * returned the raw CIR instead — layers carrying `features`, with no `preview`
 * and no `featureCount`.
 *
 * Every panel in the workspace reads `layer.preview` and `layer.featureCount`.
 * So every file under 2 MB — which is most survey files: a parcel GeoJSON, a
 * boundary DXF, a levelling CSV, a GPX track — imported "successfully" and then
 * drew an EMPTY CANVAS with a feature count of 0, while the file's real
 * features sat in a key nothing looked at. The geometry tab additionally threw
 * on `featureCount.toLocaleString()`, and that exception aborted the render.
 *
 * The shape is the contract between the reader and the UI. Two code paths
 * producing two different shapes is the defect; one exported function that both
 * paths call is the fix, and `tests/summarise.test.ts` holds it there.
 */

import type { CirDataset } from '../core/cir';

export function summarise(dataset: CirDataset, previewFeatureLimit = 5000) {
  const layers = dataset.layers.map((layer) => ({
    name: layer.name,
    // Carried so the layer tree can indent a KML's folders as the source had
    // them (R16). Without it every layer renders at depth 0.
    path: layer.path,
    featureCount: layer.features.length,
    geometryTypes: layer.geometryTypes,
    fields: layer.fields,
    style: layer.style,
    // Preview geometry only. The label matters: the UI must never present this
    // as the data that will be exported.
    preview: layer.features.slice(0, previewFeatureLimit).map((feature) => ({
      id: feature.id,
      geometry: feature.geometry,
      properties: feature.properties,
      sourceLayer: feature.sourceLayer,
      sourceEntity: feature.sourceEntity,
    })),
    previewTruncated: layer.features.length > previewFeatureLimit,
  }));

  const cloud = dataset.pointcloud;
  return {
    kind: dataset.kind,
    name: dataset.name,
    source: dataset.source,
    crs: dataset.crs,
    crsOrigin: dataset.crsOrigin,
    units: dataset.units,
    axisOrder: dataset.axisOrder,
    vertical: dataset.vertical,
    warnings: dataset.warnings,
    metadata: dataset.metadata,
    layers,
    table: dataset.table
      ? {
          columns: dataset.table.columns,
          mapping: dataset.table.mapping,
          detectedSchema: dataset.table.detectedSchema,
          hasHeader: dataset.table.hasHeader,
          rowCount: dataset.table.rows.length,
          previewRows: dataset.table.rows.slice(0, 100),
        }
      : undefined,
    raster: dataset.raster
      ? {
          width: dataset.raster.width,
          height: dataset.raster.height,
          bandCount: dataset.raster.bandCount,
          pixelType: dataset.raster.pixelType,
          noData: dataset.raster.noData,
          geotransform: dataset.raster.geotransform,
          extent: dataset.raster.extent,
          statistics: dataset.raster.statistics,
          hasPixelData: dataset.raster.hasPixelData,
          isElevation: dataset.raster.isElevation,
          metadata: dataset.raster.metadata,
        }
      : undefined,
    pointcloud: cloud
      ? {
          count: cloud.count,
          loaded: cloud.loaded,
          bounds: cloud.bounds,
          scale: cloud.scale,
          offset: cloud.offset,
          pointFormat: cloud.pointFormat,
          version: cloud.versionMajor !== null ? `${cloud.versionMajor}.${cloud.versionMinor}` : null,
          attributes: cloud.attributes,
          decimation: cloud.decimation,
          // A thinned copy for the plan view, transferred as typed arrays.
          previewX: thin(cloud.points.x, cloud.loaded),
          previewY: thin(cloud.points.y, cloud.loaded),
          previewZ: thin(cloud.points.z, cloud.loaded),
          previewClassification: cloud.attributes.classification ? thinU8(cloud.points.classification, cloud.loaded) : undefined,
        }
      : undefined,
  };
}

const PREVIEW_POINTS = 120000;

function thin(source: Float64Array, count: number): Float32Array {
  const stride = count > PREVIEW_POINTS ? Math.ceil(count / PREVIEW_POINTS) : 1;
  const size = Math.ceil(count / stride);
  const out = new Float32Array(size);
  for (let index = 0, write = 0; index < count && write < size; index += stride, write++) out[write] = source[index];
  return out;
}

function thinU8(source: Uint8Array | undefined, count: number): Uint8Array | undefined {
  if (!source) return undefined;
  const stride = count > PREVIEW_POINTS ? Math.ceil(count / PREVIEW_POINTS) : 1;
  const size = Math.ceil(count / stride);
  const out = new Uint8Array(size);
  for (let index = 0, write = 0; index < count && write < size; index += stride, write++) out[write] = source[index];
  return out;
}
