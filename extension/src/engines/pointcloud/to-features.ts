/**
 * A point cloud, as vector features.
 *
 * WHY THIS EXISTS
 *
 * `predict.ts` has always listed `pointcloud: ['pointcloud', 'vector', 'table']`
 * — the tool declares that a cloud can be delivered as vector or as a table, and
 * the format list offers GeoJSON, DXF, Shapefile and CSV for a LAS or an XYZ.
 *
 * The points live in `dataset.pointcloud.points`, as parallel typed arrays.
 * Every vector writer reads `dataset.layers[].features`. Nothing joined the two,
 * so the conversion ran, wrote a well-formed file, and put NO POINTS IN IT: a
 * 52-byte GeoJSON with an empty feature array, a 383-byte DXF with no entities.
 * No error, and the three warnings it did raise were about other things.
 *
 * For a surveyor that is the worst possible outcome — a total-station XYZ or a
 * LiDAR strip converted to DXF for the drawing office, delivered empty, with the
 * tool reporting success.
 *
 * THE SIZE PROBLEM IS THE REAL DESIGN CONSTRAINT
 *
 * A cloud is not a parcel layer. Ten million points as ten million GeoJSON
 * Features is a gigabyte of JSON and a dead tab, so this refuses above a budget
 * and names decimation as the way through, rather than trying and hanging. The
 * budget is deliberately generous enough for a survey (a few hundred thousand
 * points is a normal total-station or drone job) and far below the size where
 * the browser stops coping.
 */

import { createLayer, warn, type CirDataset, type CirFeature, type Warning } from '../../core/cir';
import { ConversionError } from '../../core/errors';

/**
 * The most points this will turn into features.
 *
 * Chosen against what the rest of the tool already assumes: the canvas previews
 * 5,000 features per layer, the decimation engine has a 250,000-point preview
 * budget, and a GeoJSON Feature costs roughly 100 bytes minimum. 500,000 points
 * is about 50 MB of JSON — large, writable, and survivable. Past that the honest
 * answer is decimation, not patience.
 */
export const CLOUD_FEATURE_BUDGET = 500_000;

/** Per-point attributes worth carrying onto a feature, when the cloud has them. */
function propertiesAt(points: CirDataset['pointcloud'] extends undefined ? never : NonNullable<CirDataset['pointcloud']>['points'], index: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (points.intensity) properties.intensity = points.intensity[index];
  if (points.classification) properties.classification = points.classification[index];
  if (points.returnNumber) properties.return_number = points.returnNumber[index];
  if (points.numberOfReturns) properties.number_of_returns = points.numberOfReturns[index];
  if (points.gpsTime) properties.gps_time = points.gpsTime[index];
  if (points.scanAngle) properties.scan_angle = points.scanAngle[index];
  if (points.sourceId) properties.source_id = points.sourceId[index];
  if (points.rgb) {
    // LAS stores 16-bit channels; the 8-bit form is what every consumer wants.
    properties.red = points.rgb[index * 3] >> 8;
    properties.green = points.rgb[index * 3 + 1] >> 8;
    properties.blue = points.rgb[index * 3 + 2] >> 8;
  }
  return properties;
}

/**
 * True when this conversion needs the cloud expressed as features.
 *
 * Only when the dataset HAS a cloud and has no features of its own: a LAS that
 * somehow also carried vector layers keeps them, rather than having a second
 * copy of itself appended.
 */
export function needsCloudFeatures(dataset: CirDataset): boolean {
  if (!dataset.pointcloud || dataset.pointcloud.loaded === 0) return false;
  return (dataset.layers ?? []).every((layer) => layer.features.length === 0);
}

/**
 * Materialises the cloud as a layer of Point features.
 *
 * Returns a NEW dataset; the cloud is left in place so a point-cloud target
 * still writes from the arrays rather than from the features made here.
 */
export function cloudToFeatures(dataset: CirDataset, warnings: Warning[]): CirDataset {
  const cloud = dataset.pointcloud;
  if (!cloud) return dataset;

  const count = cloud.loaded;
  if (count > CLOUD_FEATURE_BUDGET) {
    throw new ConversionError({
      code: 'CLOUD_TOO_LARGE_FOR_VECTOR',
      what: `This point cloud has ${count.toLocaleString()} points, which is too many to write as individual vector features.`,
      why:
        `Every point becomes one feature with its own geometry and attributes, so ${count.toLocaleString()} of them ` +
        `would produce a file of hundreds of megabytes that most GIS and CAD software cannot open. ` +
        `The limit is ${CLOUD_FEATURE_BUDGET.toLocaleString()}.`,
      action:
        'Thin the cloud first — set a decimation mode in the conversion settings (every Nth point, or one point per grid cell) — ' +
        'or keep it as a point cloud by converting to LAS, XYZ, PTS or PLY, which store points natively and have no such limit.',
    });
  }

  const { x, y, z } = cloud.points;
  const hasZ = z && z.length === count;
  const features: CirFeature[] = new Array(count);
  for (let index = 0; index < count; index++) {
    features[index] = {
      geometry: {
        type: 'Point',
        coordinates: hasZ ? [x[index], y[index], z[index]] : [x[index], y[index]],
        dimension: hasZ ? 3 : 2,
      },
      properties: propertiesAt(cloud.points, index),
      sourceEntity: 'point-cloud-point',
    };
  }

  warnings.push(
    warn('info', `${count.toLocaleString()} cloud point(s) were written as individual features.`, {
      reason:
        'The target stores vector features rather than a point cloud, so each point became a Point feature. ' +
        (cloud.decimation && cloud.decimation.mode !== 'none'
          ? `The cloud was thinned first (${cloud.decimation.mode}), so this is the thinned count, not the ${cloud.count.toLocaleString()} the file declares.`
          : 'Per-point attributes such as intensity and classification were carried across where the cloud had them.'),
      action: 'Convert to LAS, XYZ, PTS or PLY instead to keep it as a point cloud.',
    })
  );

  const fields = Object.keys(features[0]?.properties ?? {}).map((name) => ({
    name,
    type: 'number' as const,
  }));

  return { ...dataset, layers: [createLayer(dataset.name || 'points', features, fields)] };
}
