/**
 * Fidelity prediction tests (spec §22).
 *
 * The predictor's whole value is that its statements are true and specific, so
 * these assert on the *content* of a finding — the count, the named field, the
 * ground distance — not merely that some warning was raised. A predictor that
 * says "attributes may be affected" would pass a laxer test and help nobody.
 */

import { describe, expect, it } from 'vitest';
import { convert, type ConversionInput } from '@core/pipeline';
import {
  predictConversion,
  rankTargets,
  summarisePrediction,
  validateExport,
  type FidelityFinding,
} from '@core/predict';
import { createDataset, createLayer, type CirDataset, type CirFeature, type SourceInfo } from '@core/cir';
import { crsFromEpsg } from '@crs/epsg';
import { FULL_PRECISION, SURVEY_DEFAULT_PRECISION } from '@core/precision';

const encoder = new TextEncoder();

function input(fileName: string, body: string | Uint8Array): ConversionInput {
  return { fileName, bytes: typeof body === 'string' ? encoder.encode(body) : body };
}

const SOURCE: SourceInfo = { fileName: 'plots.dxf', size: 0, formatId: 'dxf', formatName: 'AutoCAD DXF', detectionConfidence: 1 };

function feature(
  type: 'Point' | 'LineString' | 'Polygon' | 'MultiPolygon',
  properties: Record<string, unknown> = {},
  extra: Partial<CirFeature> = {}
): CirFeature {
  const coordinates =
    type === 'Point'
      ? [412300, 2591200]
      : type === 'LineString'
        ? [[412300, 2591200], [412400, 2591300]]
        : type === 'Polygon'
          ? [[[412300, 2591200], [412400, 2591200], [412400, 2591300], [412300, 2591200]]]
          : [[[[412300, 2591200], [412400, 2591200], [412400, 2591300], [412300, 2591200]]]];
  return { geometry: { type, coordinates: coordinates as never, dimension: 2 }, properties, ...extra };
}

function vectorDataset(features: CirFeature[], options: Partial<CirDataset> = {}): CirDataset {
  const fields = [...new Set(features.flatMap((entry) => Object.keys(entry.properties)))].map((name) => ({
    name,
    type: 'string' as const,
  }));
  return createDataset({
    kind: 'vector',
    name: 'plots',
    source: SOURCE,
    crs: crsFromEpsg(32645),
    crsOrigin: 'declared',
    layers: [createLayer('Plots', features, fields)],
    ...options,
  });
}

function find(findings: FidelityFinding[], code: string): FidelityFinding | undefined {
  return findings.find((entry) => entry.code === code);
}

describe('fidelity prediction — what a target cannot hold', () => {
  it('says GeoJSON keeps a projected CRS rather than claiming it reprojects', () => {
    const prediction = predictConversion(vectorDataset([feature('Polygon', { plot_no: '784' })]), 'geojson', {
      sourceCrsEpsg: 32645,
    });

    // This assertion used to read CRS_REPROJECTION_REQUIRED, with a comment
    // saying "GeoJSON reprojects to WGS 84". It does not: the writer keeps the
    // source CRS and adds a legacy `crs` member (GEOJSON_NON_WGS84). RFC 7946
    // mandates WGS 84, but the format has somewhere to say otherwise, so the
    // mandate is a convention rather than a constraint — and a prediction that
    // promised a transform nobody performs is the exact failure §22 exists to
    // prevent.
    expect(prediction.blocked).toBe(false);
    expect(prediction.overall).toBe('yellow');
    expect(find(prediction.findings, 'CRS_REPROJECTION_REQUIRED')).toBeUndefined();
    expect(find(prediction.findings, 'CRS_NON_STANDARD_KEPT')?.statement).toContain('EPSG:32645');
    expect(prediction.findings.every((entry) => entry.grade !== 'red')).toBe(true);
  });

  it('promises reprojection only where the format really enforces its CRS', () => {
    // KML cannot record a CRS at all, so the mandate is enforced and the
    // pipeline reprojects automatically. Here the promise is one the tool keeps.
    const prediction = predictConversion(vectorDataset([feature('Point', { id: '1' })]), 'kml', {
      sourceCrsEpsg: 32645,
    });
    expect(find(prediction.findings, 'CRS_REPROJECTION_REQUIRED')?.remedy).toContain('automatic');
    expect(find(prediction.findings, 'CRS_NON_STANDARD_KEPT')).toBeUndefined();
  });

  it('names the polygons GPX cannot store, and counts them', () => {
    const prediction = predictConversion(
      vectorDataset([feature('Polygon'), feature('Polygon'), feature('Point'), feature('LineString')]),
      'gpx'
    );
    const finding = find(prediction.findings, 'GEOM_UNSUPPORTED');
    expect(finding?.grade).toBe('red');
    expect(finding?.count).toBe(2);
    expect(finding?.statement).toMatch(/2 Polygon feature\(s\) cannot be written/);
    expect(prediction.overall).toBe('red');
  });

  it('distinguishes a multi-part split from a geometry that cannot exist', () => {
    // A MultiPolygon in a shapefile is split into several rows — recoverable.
    // A Polygon in GPX is gone. Grading both the same would be misleading.
    const split = predictConversion(vectorDataset([feature('MultiPolygon')]), 'shapefile');
    expect(find(split.findings, 'GEOM_MULTIPART_SPLIT')?.grade).toBe('yellow');

    const gone = predictConversion(vectorDataset([feature('Polygon')]), 'gpx');
    expect(find(gone.findings, 'GEOM_UNSUPPORTED')?.grade).toBe('red');
  });

  it('warns that mixed geometry becomes several shapefiles', () => {
    const prediction = predictConversion(vectorDataset([feature('Point'), feature('LineString'), feature('Polygon')]), 'shapefile');
    const finding = find(prediction.findings, 'GEOM_SPLIT_BY_TYPE');
    expect(finding?.count).toBe(3);
    expect(finding?.statement).toMatch(/3 separate ESRI Shapefile files/);
  });
});

describe('fidelity prediction — attributes', () => {
  it('names the field names DBF will shorten, not just how many', () => {
    // The point of naming them: a downstream join on `sample_description`
    // breaks silently when it becomes `sample_des`, and the user finds out
    // weeks later.
    const dataset = vectorDataset([
      feature('Point', { sample_description: 'quartz vein', collar_elevation: '412.3', id: '1' }),
    ]);
    const prediction = predictConversion(dataset, 'shapefile');
    const finding = find(prediction.findings, 'ATTR_NAME_TRUNCATED');
    expect(finding?.count).toBe(2);
    expect(finding?.statement).toContain('sample_description -> sample_des');
    expect(finding?.statement).toContain('collar_elevation -> collar_ele');
    expect(finding?.statement).not.toContain('id ->');
  });

  it('counts the text values that exceed the DBF byte limit', () => {
    const long = 'x'.repeat(300);
    const dataset = vectorDataset([feature('Point', { remarks: long }), feature('Point', { remarks: 'short' })]);
    const finding = find(predictConversion(dataset, 'shapefile').findings, 'ATTR_VALUE_TRUNCATED');
    expect(finding?.count).toBe(1);
    expect(finding?.statement).toMatch(/254-byte limit/);
  });

  it('reports every field lost to a format that stores geometry alone', () => {
    const dataset = vectorDataset([feature('Point', { plot_no: '784', khasra: '112/2' })]);
    const finding = find(predictConversion(dataset, 'wkt').findings, 'ATTR_UNSUPPORTED');
    expect(finding?.grade).toBe('red');
    expect(finding?.count).toBe(2);
  });
});

describe('fidelity prediction — elevation, CRS and precision', () => {
  it('counts the features whose Z a 2D format will drop', () => {
    const withZ = feature('Point');
    withZ.geometry!.dimension = 3;
    withZ.geometry!.coordinates = [412300, 2591200, 412.5] as never;
    const finding = find(predictConversion(vectorDataset([withZ, feature('Point')]), 'topojson').findings, 'Z_UNSUPPORTED');
    expect(finding?.grade).toBe('red');
    expect(finding?.count).toBe(1);
  });

  it('reports Z loss caused by the setting, not the format', () => {
    const withZ = feature('Point');
    withZ.geometry!.dimension = 3;
    const finding = find(predictConversion(vectorDataset([withZ]), 'geojson', { preserveZ: false }).findings, 'Z_DISABLED');
    expect(finding?.grade).toBe('red');
    expect(finding?.remedy).toMatch(/Preserve Z/);
  });

  it('refuses to let an unknown CRS pass as merely a change', () => {
    const dataset = vectorDataset([feature('Point')], { crs: null, crsOrigin: 'unknown' });
    const finding = find(predictConversion(dataset, 'geojson').findings, 'CRS_UNKNOWN');
    expect(finding?.grade).toBe('red');
    expect(finding?.remedy).toMatch(/never guessed/);
  });

  it('states rounding as a ground distance, in the right units for the CRS', () => {
    // 3 dp of a metre is a millimetre — fine for survey work, so green (silent).
    const projected = predictConversion(vectorDataset([feature('Point')]), 'geojson', { precisionDecimals: 3 });
    expect(find(projected.findings, 'PRECISION_ROUNDED')).toBeUndefined();

    // 3 dp of a *degree* is about 111 m. Same number, entirely different cost —
    // which is why the grade is computed from ground distance, not decimals.
    const geographic = predictConversion(
      vectorDataset([feature('Point')], { crs: crsFromEpsg(4326), crsOrigin: 'declared' }),
      'geojson',
      { precisionDecimals: 3 }
    );
    const finding = find(geographic.findings, 'PRECISION_ROUNDED');
    expect(finding?.grade).toBe('yellow');
    expect(finding?.statement).toMatch(/111 m/);
  });
});

describe('fidelity prediction — layers, style and CAD entities', () => {
  it('grades layer handling by what the target can actually express', () => {
    const layers = [createLayer('Boundary', [feature('Polygon')]), createLayer('Roads', [feature('LineString')])];
    const dataset = createDataset({ kind: 'vector', name: 'site', source: SOURCE, crs: crsFromEpsg(32645), layers });

    // KML nests folders natively — no finding at all.
    expect(find(predictConversion(dataset, 'kml').findings, 'LAYER_AS_PROPERTY')).toBeUndefined();
    expect(predictConversion(dataset, 'kml').axes.layer).toBe('green');

    // GeoJSON carries them in a property and rebuilds them on read.
    expect(find(predictConversion(dataset, 'geojson').findings, 'LAYER_AS_PROPERTY')?.count).toBe(2);

    // Shapefile becomes one file per layer.
    expect(find(predictConversion(dataset, 'shapefile').findings, 'LAYER_SPLIT_TO_FILES')?.count).toBe(2);

    // WKT has nowhere to put them at all.
    expect(find(predictConversion(dataset, 'wkt').findings, 'LAYER_FLATTENED')?.grade).toBe('red');
  });

  it('counts the CAD arcs a GIS target will densify, by entity type', () => {
    const arc = feature('LineString', {}, { sourceEntity: 'ARC' });
    const circle = feature('LineString', {}, { sourceEntity: 'CIRCLE' });
    const plain = feature('LineString', {}, { sourceEntity: 'LWPOLYLINE' });
    const finding = find(predictConversion(vectorDataset([arc, arc, circle, plain]), 'geojson').findings, 'ENTITY_CURVES_DENSIFIED');
    expect(finding?.count).toBe(3);
    expect(finding?.statement).toContain('2 ARC');
    expect(finding?.statement).toContain('1 CIRCLE');
    expect(finding?.remedy).toMatch(/arc tolerance/);

    // DXF keeps true arcs, so it must raise nothing.
    expect(find(predictConversion(vectorDataset([arc]), 'dxf').findings, 'ENTITY_CURVES_DENSIFIED')).toBeUndefined();
  });

  it('reports styling loss only where the target genuinely has no styling', () => {
    const styled = feature('Polygon', {}, { style: { color: '#ff0000' } });
    expect(find(predictConversion(vectorDataset([styled]), 'kml').findings, 'STYLE_DROPPED')).toBeUndefined();
    expect(find(predictConversion(vectorDataset([styled]), 'geojson').findings, 'STYLE_DROPPED')?.count).toBe(1);
  });
});

describe('fidelity prediction — blocking', () => {
  it('blocks a target this build can only read', () => {
    const prediction = predictConversion(vectorDataset([feature('Point')]), 'dwg');
    expect(prediction.blocked).toBe(true);
    expect(prediction.blockers[0].code).toBe('TARGET_NEEDS_ENGINE');
    expect(prediction.blockers[0].statement).toMatch(/native helper/);
  });

  it('blocks a data-kind pairing no engine bridges, and says which way round', () => {
    const prediction = predictConversion(vectorDataset([feature('Polygon')]), 'geotiff');
    expect(prediction.blocked).toBe(true);
    expect(prediction.blockers[0].code).toBe('KIND_INCOMPATIBLE');
    expect(prediction.blockers[0].statement).toMatch(/vector data and GeoTIFF stores raster data/);
  });

  it('allows the cross-kind paths that do have an engine', () => {
    // Table -> vector (points), and vector -> table (coordinate list) both work.
    expect(predictConversion(vectorDataset([feature('Point')]), 'csv').blocked).toBe(false);
  });

  it('does not block a merely lossy conversion — that is the engineer\'s call', () => {
    const prediction = predictConversion(vectorDataset([feature('Polygon')]), 'gpx');
    expect(prediction.overall).toBe('red');
    expect(prediction.blocked).toBe(false);

    const readiness = validateExport(vectorDataset([feature('Polygon')]), 'gpx');
    expect(readiness.ready).toBe(true);
    expect(readiness.acknowledgements.length).toBeGreaterThan(0);
  });

  it('reports an impossible export as not ready, with the reason', () => {
    const readiness = validateExport(vectorDataset([feature('Point')]), 'geotiff');
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons[0].code).toBe('KIND_INCOMPATIBLE');
  });
});

describe('target ranking and summaries', () => {
  it('ranks faithful targets above lossy ones and blocked ones last', () => {
    const dataset = vectorDataset([feature('Polygon', { plot_no: '784' })]);
    const ranked = rankTargets(dataset, ['gpx', 'geojson', 'dwg', 'kml']);
    expect(ranked[ranked.length - 1].targetFormatId).toBe('dwg');
    const gpxAt = ranked.findIndex((entry) => entry.targetFormatId === 'gpx');
    const geojsonAt = ranked.findIndex((entry) => entry.targetFormatId === 'geojson');
    expect(geojsonAt).toBeLessThan(gpxAt);
  });

  it('summarises in a sentence a person would act on', () => {
    // Genuinely lossless needs the dataset already in GeoJSON's own CRS — the
    // dataset's declared CRS wins over the option, which is only a fallback for
    // a source that declares none.
    const lossless = predictConversion(
      vectorDataset([feature('Point')], { crs: crsFromEpsg(4326), crsOrigin: 'declared' }),
      'geojson'
    );
    expect(summarisePrediction(lossless)).toBe('Nothing is lost in this conversion.');

    const lossy = predictConversion(vectorDataset([feature('Polygon')]), 'gpx');
    expect(summarisePrediction(lossy)).toMatch(/loss/);
  });
});

describe('prediction through the pipeline', () => {
  const DXF_WITH_ARC = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'ARC', '5', 'A1', '8', 'Bench_Crest', '10', '412700.0', '20', '2591700.0', '40', '50.0', '50', '0.0', '51', '90.0',
    '0', 'LWPOLYLINE', '5', 'A2', '8', 'Plot', '90', '4', '70', '1',
    '10', '412500.0', '20', '2591500.0',
    '10', '412600.0', '20', '2591500.0',
    '10', '412600.0', '20', '2591600.0',
    '10', '412500.0', '20', '2591600.0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');

  it('attaches the prediction to the conversion result', async () => {
    const result = await convert({
      input: input('plots.dxf', DXF_WITH_ARC),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: crsFromEpsg(32645) },
    });
    expect(result.prediction.targetFormatId).toBe('geojson');
    expect(result.prediction.blocked).toBe(false);
    expect(find(result.prediction.findings, 'ENTITY_CURVES_DENSIFIED')).toBeDefined();
  });

  it('raises predicted losses as warnings before the writers run', async () => {
    const result = await convert({
      input: input('plots.dxf', DXF_WITH_ARC),
      targetFormatId: 'wkt',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: crsFromEpsg(32645) },
    });
    // WKT stores geometry only, so the attribute loss is predicted up front and
    // appears in the same warning list as anything the writer reports.
    expect(result.warnings.some((entry) => entry.code.startsWith('PREDICTED_'))).toBe(true);
  });

  it('refuses an impossible target with the pre-flight reason, not a writer error', async () => {
    await expect(
      convert({
        input: input('plots.dxf', DXF_WITH_ARC),
        targetFormatId: 'geotiff',
        settings: { precision: FULL_PRECISION, sourceCrs: crsFromEpsg(32645) },
      })
    ).rejects.toMatchObject({ code: 'KIND_INCOMPATIBLE' });
  });
});
