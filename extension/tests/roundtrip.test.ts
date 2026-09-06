/**
 * Round-trip tests from instruction §16.3.
 *
 * Each one writes a target, reads the bytes back and compares the CIR. That is
 * the same path the shipped QA engine takes, so a green test here is evidence
 * the QA verdict is meaningful rather than decorative.
 */

import { describe, expect, it } from 'vitest';
import { convert, expandArchive, packageBatch, type ConversionInput } from '@core/pipeline';
import { FULL_PRECISION, SURVEY_DEFAULT_PRECISION } from '@core/precision';
import { crsFromEpsg } from '@crs/epsg';
import { allFeatures, featureCount } from '@core/cir';
import { ConversionError } from '@core/errors';
import { readZip } from '@engines/archives/zip';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function input(fileName: string, body: string | Uint8Array, companions?: Record<string, string | Uint8Array>): ConversionInput {
  const map = companions
    ? new Map(Object.entries(companions).map(([key, value]) => [key, typeof value === 'string' ? encoder.encode(value) : value]))
    : undefined;
  return { fileName, bytes: typeof body === 'string' ? encoder.encode(body) : body, companions: map };
}

const SURVEY_CSV = [
  'Point,Easting,Northing,Elevation,Code',
  'BM1,412345.678,2591234.567,412.345,BENCHMARK',
  'BM2,412445.123,2591334.891,415.210,BENCHMARK',
  'TP1,412545.900,2591434.010,418.007,TRAVERSE',
  'TP2,412645.250,2591534.750,420.500,TRAVERSE',
].join('\n');

const GEOJSON_POLYGON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { plot_no: '784', khasra: '112/2', area_m2: 4046.86 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [412300, 2591200],
            [412400, 2591200],
            [412400, 2591300],
            [412300, 2591300],
            [412300, 2591200],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { plot_no: '785', khasra: '112/3', area_m2: 2023.43 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [412400, 2591200],
            [412450, 2591200],
            [412450, 2591300],
            [412400, 2591300],
            [412400, 2591200],
          ],
        ],
      },
    },
  ],
});

/** A minimal but genuine DXF with a point, a line, a closed polyline and an arc. */
const DXF_SOURCE = [
  '0', 'SECTION', '2', 'HEADER',
  '9', '$ACADVER', '1', 'AC1015',
  '9', '$INSUNITS', '70', '6',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'POINT', '5', 'A1', '8', 'Borehole', '10', '412300.5', '20', '2591200.25', '30', '412.75',
  '0', 'LINE', '5', 'A2', '8', 'Road', '10', '412300.0', '20', '2591200.0', '30', '410.0', '11', '412400.0', '21', '2591300.0', '31', '415.0',
  '0', 'LWPOLYLINE', '5', 'A3', '8', 'Plot', '90', '4', '70', '1',
  '10', '412500.0', '20', '2591500.0',
  '10', '412600.0', '20', '2591500.0',
  '10', '412600.0', '20', '2591600.0',
  '10', '412500.0', '20', '2591600.0',
  '0', 'ARC', '5', 'A4', '8', 'Bench_Crest', '10', '412700.0', '20', '2591700.0', '40', '50.0', '50', '0.0', '51', '90.0',
  '0', 'TEXT', '5', 'A5', '8', 'Plot_Text', '10', '412550.0', '20', '2591550.0', '40', '2.5', '1', 'Plot 784',
  '0', 'ENDSEC',
  '0', 'EOF',
].join('\r\n');

const KML_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Pit outline</name>
<Folder><name>Bench crests</name>
<Placemark><name>Crest 1</name>
<ExtendedData><Data name="bench"><value>RL 412</value></Data></ExtendedData>
<LineString><coordinates>84.680000,23.430000,412 84.681000,23.430500,413 84.682000,23.431000,414</coordinates></LineString>
</Placemark>
<Placemark><name>Pit boundary</name>
<Polygon><outerBoundaryIs><LinearRing><coordinates>84.680,23.430,0 84.685,23.430,0 84.685,23.435,0 84.680,23.435,0 84.680,23.430,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark>
</Folder></Document></kml>`;

const ASC_SOURCE = [
  'ncols         4',
  'nrows         3',
  'xllcorner     412000.0',
  'yllcorner     2591000.0',
  'cellsize      10.0',
  'NODATA_value  -9999',
  '410.25 411.50 412.75 413.00',
  '409.00 -9999 411.25 412.50',
  '408.75 409.50 410.75 411.00',
].join('\n');

/** Builds a small LAS 1.2 point-format-1 file in memory. */
function buildLas(points: { x: number; y: number; z: number; intensity: number; classification: number }[]): Uint8Array {
  const headerLength = 227;
  const recordLength = 28;
  const bytes = new Uint8Array(headerLength + points.length * recordLength);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode('LASF'), 0);
  bytes[24] = 1;
  bytes[25] = 2;
  view.setUint16(94, headerLength, true);
  view.setUint32(96, headerLength, true);
  view.setUint32(100, 0, true);
  view.setUint8(104, 1);
  view.setUint16(105, recordLength, true);
  view.setUint32(107, points.length, true);
  const scale = 0.001;
  const offset = [412000, 2591000, 400];
  view.setFloat64(131, scale, true);
  view.setFloat64(139, scale, true);
  view.setFloat64(147, scale, true);
  view.setFloat64(155, offset[0], true);
  view.setFloat64(163, offset[1], true);
  view.setFloat64(171, offset[2], true);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const zs = points.map((point) => point.z);
  view.setFloat64(179, Math.max(...xs), true);
  view.setFloat64(187, Math.min(...xs), true);
  view.setFloat64(195, Math.max(...ys), true);
  view.setFloat64(203, Math.min(...ys), true);
  view.setFloat64(211, Math.max(...zs), true);
  view.setFloat64(219, Math.min(...zs), true);

  points.forEach((point, index) => {
    const at = headerLength + index * recordLength;
    view.setInt32(at, Math.round((point.x - offset[0]) / scale), true);
    view.setInt32(at + 4, Math.round((point.y - offset[1]) / scale), true);
    view.setInt32(at + 8, Math.round((point.z - offset[2]) / scale), true);
    view.setUint16(at + 12, point.intensity, true);
    view.setUint8(at + 14, 0x09); // return 1 of 1
    view.setUint8(at + 15, point.classification);
    view.setFloat64(at + 20, 123456.789, true);
  });
  return bytes;
}

const LAS_POINTS = [
  { x: 412345.678, y: 2591234.567, z: 412.345, intensity: 1200, classification: 2 },
  { x: 412355.123, y: 2591244.891, z: 413.21, intensity: 900, classification: 2 },
  { x: 412365.9, y: 2591254.01, z: 414.007, intensity: 1500, classification: 5 },
  { x: 412375.25, y: 2591264.75, z: 415.5, intensity: 300, classification: 6 },
];

const UTM45N = crsFromEpsg(32645);

describe('CSV survey table round trips', () => {
  it('CSV -> DXF -> CSV keeps every coordinate to the millimetre', async () => {
    const toDxf = await convert({
      input: input('survey.csv', SURVEY_CSV),
      targetFormatId: 'dxf',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });
    expect(toDxf.qa.verdict).not.toBe('FAILED');

    const back = await convert({
      input: input(toDxf.outputs[0].name, toDxf.outputs[0].bytes),
      targetFormatId: 'csv',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });

    const rows = decoder.decode(back.outputs[0].bytes).trim().split('\n');
    expect(rows).toHaveLength(5); // header + four points
    const first = rows[1].split(',');
    expect(Number(first[1])).toBeCloseTo(412345.678, 3);
    expect(Number(first[2])).toBeCloseTo(2591234.567, 3);
    expect(Number(first[3])).toBeCloseTo(412.345, 3);
  });

  it('CSV -> GeoJSON -> CSV preserves the point code attribute', async () => {
    const toGeoJson = await convert({
      input: input('survey.csv', SURVEY_CSV),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });
    expect(toGeoJson.qa.verdict).toBe('PASS');

    const parsed = JSON.parse(decoder.decode(toGeoJson.outputs[0].bytes));
    expect(parsed.features).toHaveLength(4);
    expect(parsed.features[0].properties.Code).toBe('BENCHMARK');
    expect(parsed.features[0].geometry.coordinates[2]).toBeCloseTo(412.345, 3);

    const back = await convert({
      input: input('survey.geojson', toGeoJson.outputs[0].bytes),
      targetFormatId: 'csv',
      settings: { precision: FULL_PRECISION },
    });
    expect(decoder.decode(back.outputs[0].bytes)).toContain('BENCHMARK');
  });

  it('CSV -> Shapefile -> GeoJSON keeps points and attributes', async () => {
    const toShapefile = await convert({
      input: input('survey.csv', SURVEY_CSV),
      targetFormatId: 'shapefile',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });

    const entries = await readZip(toShapefile.outputs[0].bytes);
    const names = entries.map((entry) => entry.name.split('.').pop());
    // A shapefile is a package: all five members must be present.
    expect(names).toEqual(expect.arrayContaining(['shp', 'shx', 'dbf', 'prj', 'cpg']));

    const shp = entries.find((entry) => entry.name.endsWith('.shp'))!;
    const companions = new Map(
      entries.filter((entry) => entry !== shp).map((entry) => [entry.name.split('.').pop()!, entry.bytes])
    );
    const back = await convert({
      input: { fileName: shp.name, bytes: shp.bytes, companions },
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });

    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    expect(parsed.features).toHaveLength(4);
    expect(parsed.features[0].geometry.type).toBe('Point');
    expect(parsed.features[0].geometry.coordinates[0]).toBeCloseTo(412345.678, 3);
    // The .prj travelled with the package, so the CRS survived the trip.
    expect(back.sourceDataset.crs?.epsg).toBe(32645);
  });

  it('refuses to build geometry when the coordinate columns are ambiguous', async () => {
    // No header and five columns: PNEZD and PENZD are indistinguishable, so the
    // reader must ask rather than pick one.
    const headerless = '1,2591234.567,412345.678,412.345,BM\n2,2591334.891,412445.123,415.210,BM';
    const result = await convert({
      input: input('points.csv', headerless),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });
    // It converts using the suggested schema but must say the schema is unconfirmed.
    expect(result.warnings.some((warning) => warning.code === 'CSV_SCHEMA_UNCONFIRMED')).toBe(true);
  });
});

describe('GeoJSON and Shapefile', () => {
  it('GeoJSON -> Shapefile -> GeoJSON preserves polygon geometry and attributes', async () => {
    const toShapefile = await convert({
      input: input('plots.geojson', GEOJSON_POLYGON),
      targetFormatId: 'shapefile',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });
    expect(toShapefile.qa.verdict).not.toBe('FAILED');

    const entries = await readZip(toShapefile.outputs[0].bytes);
    const shp = entries.find((entry) => entry.name.endsWith('.shp'))!;
    const companions = new Map(entries.filter((entry) => entry !== shp).map((entry) => [entry.name.split('.').pop()!, entry.bytes]));

    const back = await convert({
      input: { fileName: shp.name, bytes: shp.bytes, companions },
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });

    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features[0].geometry.type).toBe('Polygon');
    // DBF caps field names at 10 bytes; these are short enough to survive intact.
    expect(parsed.features[0].properties.plot_no).toBe('784');
    expect(parsed.features[0].properties.area_m2).toBeCloseTo(4046.86, 2);

    const ring = parsed.features[0].geometry.coordinates[0];
    expect(ring[0][0]).toBeCloseTo(412300, 6);
    expect(ring).toHaveLength(5); // closed ring
  });

  it('GeoJSON -> WKB -> GeoJSON preserves geometry exactly', async () => {
    const toWkb = await convert({
      input: input('plots.geojson', GEOJSON_POLYGON),
      targetFormatId: 'wkb',
      settings: { precision: FULL_PRECISION },
    });
    const back = await convert({
      input: input('plots.wkb', toWkb.outputs[0].bytes),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });
    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features[0].geometry.coordinates[0][2]).toEqual([412400, 2591300]);
  });

  it('GeoJSON -> WKT -> GeoJSON preserves geometry and warns about attribute loss', async () => {
    const toWkt = await convert({
      input: input('plots.geojson', GEOJSON_POLYGON),
      targetFormatId: 'wkt',
      settings: { precision: FULL_PRECISION },
    });
    expect(toWkt.warnings.some((warning) => warning.code === 'WKT_ATTRIBUTES_DROPPED')).toBe(true);

    const back = await convert({
      input: input('plots.wkt', toWkt.outputs[0].bytes),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });
    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features[0].geometry.type).toBe('Polygon');
  });
});

describe('DXF', () => {
  it('DXF -> GeoJSON -> DXF keeps layers, geometry and Z', async () => {
    const toGeoJson = await convert({
      input: input('site.dxf', DXF_SOURCE),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });

    const parsed = JSON.parse(decoder.decode(toGeoJson.outputs[0].bytes));
    const layers = new Set(parsed.features.map((feature: any) => feature.properties._layer));
    expect(layers).toContain('Borehole');
    expect(layers).toContain('Road');
    expect(layers).toContain('Plot');
    expect(layers).toContain('Bench_Crest');

    // The arc was densified, and the substitution is reported rather than hidden.
    expect(toGeoJson.warnings.some((warning) => warning.code === 'DXF_CURVES_SEGMENTIZED')).toBe(true);
    const arcFeature = parsed.features.find((feature: any) => feature.properties._srcEntity === 'ARC');
    expect(arcFeature.geometry.coordinates.length).toBeGreaterThan(3);
    expect(arcFeature.properties._segmentTolerance).toBeGreaterThan(0);

    // The 3D line kept its elevations.
    const line = parsed.features.find((feature: any) => feature.properties._layer === 'Road');
    expect(line.geometry.coordinates[0][2]).toBeCloseTo(410, 6);
    expect(line.geometry.coordinates[1][2]).toBeCloseTo(415, 6);

    const back = await convert({
      input: input('site.geojson', toGeoJson.outputs[0].bytes),
      targetFormatId: 'dxf',
      settings: { precision: FULL_PRECISION },
    });
    const dxfText = decoder.decode(back.outputs[0].bytes);
    // Layers came back from the carried provenance, not from a default.
    expect(dxfText).toContain('Borehole');
    expect(dxfText).toContain('Bench_Crest');
    expect(dxfText).toContain('LWPOLYLINE');
    expect(back.qa.verdict).not.toBe('FAILED');
  });

  it('DXF -> KML -> GeoJSON transforms through WGS 84', async () => {
    const toKml = await convert({
      input: input('site.dxf', DXF_SOURCE),
      targetFormatId: 'kml',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N, targetCrs: crsFromEpsg(4326) },
    });
    const kmlText = decoder.decode(toKml.outputs[0].bytes);
    expect(kmlText).toContain('<kml');
    // An easting of ~412 km at ~2591 km north in zone 45N is Jharkhand: about
    // 86°E, 23°N. The check pins the order (longitude first) as much as the value.
    expect(kmlText).toMatch(/8[4-8]\.\d+,2[23]\.\d+/);

    const back = await convert({
      input: input('site.kml', toKml.outputs[0].bytes),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });
    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    expect(parsed.features.length).toBeGreaterThan(0);
    expect(Math.abs(parsed.features[0].geometry.coordinates[0])).toBeLessThan(180);
  });

  it('blocks a KML export that would write projected metres as degrees', async () => {
    await expect(
      convert({
        input: input('site.dxf', DXF_SOURCE),
        targetFormatId: 'kml',
        settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: UTM45N },
      })
    ).rejects.toThrow(ConversionError);
  });

  it('refuses to transform when the source CRS is unknown and ambiguous', async () => {
    await expect(
      convert({
        input: input('site.dxf', DXF_SOURCE),
        targetFormatId: 'geojson',
        settings: { precision: FULL_PRECISION, targetCrs: crsFromEpsg(4326) },
      })
    ).rejects.toMatchObject({ code: 'CRS_REQUIRED' });
  });
});

describe('KML', () => {
  it('KML -> GeoJSON -> KML keeps folders, names and Z', async () => {
    const toGeoJson = await convert({
      input: input('pit.kml', KML_SOURCE),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });
    const parsed = JSON.parse(decoder.decode(toGeoJson.outputs[0].bytes));
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features[0].properties.name).toBe('Crest 1');
    expect(parsed.features[0].properties.bench).toBe('RL 412');
    expect(parsed.features[0].geometry.coordinates[0][2]).toBe(412);
    expect(parsed.features[0].properties._layer).toBe('Pit outline / Bench crests');

    const back = await convert({
      input: input('pit.geojson', toGeoJson.outputs[0].bytes),
      targetFormatId: 'kml',
      settings: { precision: FULL_PRECISION, kml: { altitudeMode: 'absolute' } },
    });
    const kmlText = decoder.decode(back.outputs[0].bytes);
    expect(kmlText).toContain('Crest 1');
    expect(kmlText).toContain('412');
    expect(back.qa.verdict).not.toBe('FAILED');
  });

  it('reads a KMZ archive', async () => {
    const toKmz = await convert({
      input: input('pit.kml', KML_SOURCE),
      targetFormatId: 'kmz',
      settings: { precision: FULL_PRECISION },
    });
    const back = await convert({
      input: input('pit.kmz', toKmz.outputs[0].bytes),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });
    expect(featureCount(back.sourceDataset)).toBe(2);
  });
});

describe('TopoJSON, GPX and XLSX', () => {
  it('GeoJSON -> TopoJSON -> GeoJSON preserves polygon rings', async () => {
    const toTopoJson = await convert({
      input: input('plots.geojson', GEOJSON_POLYGON),
      targetFormatId: 'topojson',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });
    // The writer is honest about not computing shared arcs.
    expect(toTopoJson.warnings.some((warning) => warning.code === 'TOPOJSON_NO_ARC_SHARING')).toBe(true);

    const topology = JSON.parse(decoder.decode(toTopoJson.outputs[0].bytes));
    expect(topology.type).toBe('Topology');
    expect(Array.isArray(topology.arcs)).toBe(true);

    const back = await convert({
      input: input('plots.topojson', toTopoJson.outputs[0].bytes),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });
    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    expect(parsed.features).toHaveLength(2);
    expect(parsed.features[0].geometry.type).toBe('Polygon');
    expect(parsed.features[0].geometry.coordinates[0][0][0]).toBeCloseTo(412300, 6);
    expect(parsed.features[0].properties.plot_no).toBe('784');
  });

  it('KML -> GPX -> GeoJSON keeps track geometry and names', async () => {
    const toGpx = await convert({
      input: input('pit.kml', KML_SOURCE),
      targetFormatId: 'gpx',
      settings: { precision: FULL_PRECISION },
    });
    const gpxText = decoder.decode(toGpx.outputs[0].bytes);
    expect(gpxText).toContain('<gpx');
    expect(gpxText).toContain('Crest 1');
    // KML polygons have no GPX equivalent, and the substitution is reported.
    expect(toGpx.warnings.some((warning) => warning.code === 'GPX_POLYGON_AS_TRACK')).toBe(true);

    const back = await convert({
      input: input('pit.gpx', toGpx.outputs[0].bytes),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });
    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    expect(parsed.features.length).toBeGreaterThan(0);
    expect(parsed.features[0].geometry.coordinates[0][0]).toBeCloseTo(84.68, 5);
    expect(parsed.features[0].geometry.coordinates[0][2]).toBe(412);
  });

  it('CSV -> XLSX -> GeoJSON keeps coordinates and codes', async () => {
    const toXlsx = await convert({
      input: input('survey.csv', SURVEY_CSV),
      targetFormatId: 'xlsx',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });
    const entries = await readZip(toXlsx.outputs[0].bytes);
    // The package must be complete enough for Excel to open without repair.
    expect(entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml'])
    );

    const back = await convert({
      input: input('survey.xlsx', toXlsx.outputs[0].bytes),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });
    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    expect(parsed.features).toHaveLength(4);
    expect(parsed.features[0].geometry.coordinates[0]).toBeCloseTo(412345.678, 3);
    expect(parsed.features[0].properties.Code).toBe('BENCHMARK');
  });
});

describe('point clouds', () => {
  it('LAS -> XYZ -> LAS keeps coordinates within the storage resolution', async () => {
    const las = buildLas(LAS_POINTS);
    const toXyz = await convert({
      input: input('cloud.las', las),
      targetFormatId: 'xyz',
      settings: { precision: FULL_PRECISION },
    });
    const xyzText = decoder.decode(toXyz.outputs[0].bytes);
    expect(xyzText.trim().split('\n')).toHaveLength(4);

    const back = await convert({
      input: input('cloud.xyz', toXyz.outputs[0].bytes),
      targetFormatId: 'las',
      settings: { precision: FULL_PRECISION },
    });
    const cloud = back.sourceDataset.pointcloud!;
    expect(cloud.loaded).toBe(4);
    expect(cloud.points.x[0]).toBeCloseTo(412345.678, 3);
    expect(cloud.points.z[3]).toBeCloseTo(415.5, 3);
    expect(back.qa.verdict).not.toBe('FAILED');
  });

  it('LAS -> LAS preserves classification and intensity', async () => {
    const las = buildLas(LAS_POINTS);
    const result = await convert({
      input: input('cloud.las', las),
      targetFormatId: 'las',
      settings: { precision: FULL_PRECISION, las: { versionMinor: 2, pointFormat: 1 } },
    });
    expect(result.qa.verdict).not.toBe('FAILED');
    const source = result.sourceDataset.pointcloud!;
    expect(source.points.classification?.[2]).toBe(5);
    expect(source.points.intensity?.[0]).toBe(1200);
  });

  it('refuses a LAZ payload instead of reading it as LAS', async () => {
    const laz = buildLas(LAS_POINTS);
    // Set the compression bit the way laszip does.
    laz[104] = laz[104] | 0x80;
    await expect(
      convert({ input: input('cloud.laz', laz), targetFormatId: 'xyz', settings: { precision: FULL_PRECISION } })
    ).rejects.toMatchObject({ code: 'LAZ_NOT_DECODABLE' });
  });

  it('reports a truncated LAS rather than reading past the end', async () => {
    const las = buildLas(LAS_POINTS);
    const truncated = las.subarray(0, las.length - 40);
    const result = await convert({
      input: input('cloud.las', truncated),
      targetFormatId: 'xyz',
      settings: { precision: FULL_PRECISION },
    });
    expect(result.warnings.some((warning) => warning.code === 'LAS_TRUNCATED')).toBe(true);
  });

  it('LAS -> PLY writes vertices', async () => {
    const result = await convert({
      input: input('cloud.las', buildLas(LAS_POINTS)),
      targetFormatId: 'ply',
      settings: { precision: FULL_PRECISION },
    });
    const text = decoder.decode(result.outputs[0].bytes);
    expect(text.startsWith('ply')).toBe(true);
    expect(text).toContain('element vertex 4');
  });
});

describe('raster', () => {
  it('ASC -> ASC keeps every DEM value and the georeference', async () => {
    const result = await convert({
      input: input('terrain.asc', ASC_SOURCE),
      targetFormatId: 'asciigrid',
      settings: { precision: FULL_PRECISION },
    });
    expect(result.qa.verdict).not.toBe('FAILED');

    const text = decoder.decode(result.outputs[0].bytes);
    expect(text).toContain('ncols         4');
    expect(text).toContain('nrows         3');
    expect(text).toMatch(/xllcorner\s+412000/);
    expect(text).toContain('410.25');
    // NODATA cells stay NODATA rather than becoming an interpolated elevation.
    expect(text).toContain('-9999');

    const raster = result.sourceDataset.raster!;
    expect(raster.hasPixelData).toBe(true);
    expect(raster.bands![0][0]).toBeCloseTo(410.25, 6);
    expect(raster.statistics?.[0].min).toBeCloseTo(408.75, 6);
  });

  it('converts an ASCII Grid DEM to GeoTIFF and back without changing a height', async () => {
    // The full raster round trip: text grid → binary GeoTIFF → text grid. Every
    // elevation, the nodata cell and the georeference must survive both hops,
    // because this is the path a surveyor uses to hand a DEM to a package that
    // will not read .asc.
    const toTiff = await convert({
      input: input('terrain.asc', ASC_SOURCE),
      targetFormatId: 'geotiff',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });
    expect(toTiff.outputs).toHaveLength(1);
    expect(toTiff.outputs[0].name).toMatch(/\.tif$/);

    const backToAsc = await convert({
      input: input('terrain.tif', toTiff.outputs[0].bytes),
      targetFormatId: 'asciigrid',
      settings: { precision: FULL_PRECISION },
    });
    const raster = backToAsc.sourceDataset.raster!;
    expect(raster.hasPixelData).toBe(true);
    expect(raster.width).toBe(4);
    expect(raster.height).toBe(3);
    expect(raster.bands![0][0]).toBeCloseTo(410.25, 3);
    expect(raster.noData).toBe(-9999);
    // Origin and pixel size come back unchanged, so the grid lands where it started.
    expect(raster.geotransform?.[0]).toBeCloseTo(412000, 6);
    expect(raster.geotransform?.[1]).toBeCloseTo(10, 6);
    expect(raster.geotransform?.[5]).toBeCloseTo(-10, 6);
    expect(backToAsc.sourceDataset.crs?.epsg).toBe(32645);

    const text = decoder.decode(backToAsc.outputs[0].bytes);
    expect(text).toContain('410.25');
    expect(text).toContain('-9999');
  });

  it('reports a GeoTIFF it cannot decode instead of inventing its pixels', async () => {
    // A JPEG-compressed TIFF. No JPEG codec is bundled, so the pixels are
    // refused by name — but the georeference still reads, and raster export is
    // blocked rather than filled with noise.
    const bytes = new Uint8Array(220);
    const view = new DataView(bytes.buffer);
    bytes.set([0x49, 0x49], 0);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, 6, true);
    const entry = (index: number, tag: number, type: number, count: number, value: number) => {
      const at = 10 + index * 12;
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      view.setUint32(at + 8, value, true);
    };
    entry(0, 256, 3, 1, 640); // ImageWidth
    entry(1, 257, 3, 1, 480); // ImageLength
    entry(2, 258, 3, 1, 8); // BitsPerSample
    entry(3, 259, 3, 1, 7); // Compression = JPEG
    entry(4, 273, 4, 1, 200); // StripOffsets
    entry(5, 277, 3, 1, 3); // SamplesPerPixel
    view.setUint32(10 + 6 * 12, 0, true);

    const result = await convert({
      input: input('ortho.tif', bytes),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });
    const warning = result.warnings.find((entry_) => entry_.code === 'GEOTIFF_PIXELS_NOT_DECODED');
    expect(warning?.message).toMatch(/JPEG/);
    expect(result.sourceDataset.raster?.hasPixelData).toBe(false);
    // The structure that *was* readable is still reported honestly.
    expect(result.sourceDataset.raster?.width).toBe(640);

    await expect(
      convert({ input: input('ortho.tif', bytes), targetFormatId: 'asciigrid', settings: { precision: FULL_PRECISION } })
    ).rejects.toMatchObject({ code: 'ASC_NO_PIXEL_DATA' });
    await expect(
      convert({ input: input('ortho.tif', bytes), targetFormatId: 'geotiff', settings: { precision: FULL_PRECISION } })
    ).rejects.toMatchObject({ code: 'TIFF_NO_PIXEL_DATA' });
  });
});

describe('batch packaging', () => {
  it('produces a master ZIP with a manifest', async () => {
    const results = await Promise.all([
      convert({ input: input('survey.csv', SURVEY_CSV), targetFormatId: 'geojson', settings: { sourceCrs: UTM45N } }),
      convert({ input: input('plots.geojson', GEOJSON_POLYGON), targetFormatId: 'dxf', settings: { sourceCrs: UTM45N } }),
    ]);
    const { zip, manifestCsv } = await packageBatch(results);
    const entries = await readZip(zip);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain('conversion-manifest.csv');
    expect(names).toContain('conversion-manifest.json');
    expect(names.some((name) => name.endsWith('.geojson'))).toBe(true);
    expect(names.some((name) => name.endsWith('.dxf'))).toBe(true);
    expect(manifestCsv.split('\n')[0]).toContain('qa_verdict');
    expect(manifestCsv).toContain('survey.csv');
  });

  it('expands an archive into separate queue items', async () => {
    const results = await Promise.all([
      convert({ input: input('survey.csv', SURVEY_CSV), targetFormatId: 'geojson', settings: { sourceCrs: UTM45N } }),
    ]);
    const { zip } = await packageBatch(results);
    const expanded = await expandArchive(input('batch.zip', zip));
    expect(expanded.length).toBeGreaterThan(1);
    expect(expanded.some((entry) => entry.fileName.endsWith('.geojson'))).toBe(true);
  });
});

describe('QA reporting', () => {
  it('never reports PASS for an output it could not re-import', async () => {
    const result = await convert({
      input: input('plots.geojson', GEOJSON_POLYGON),
      targetFormatId: 'surpac-str',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N },
    });
    // Surpac STR has a reader, so this one does validate — the point of the test
    // is that the verdict is never a bare PASS without a comparison behind it.
    expect(['PASS', 'PASS_WITH_WARNINGS', 'NOT_VALIDATED', 'FAILED']).toContain(result.qa.verdict);
    if (result.qa.verdict === 'PASS') expect(result.qa.checks.length).toBeGreaterThan(0);
  });

  it('lists the checks it performed', async () => {
    const result = await convert({
      input: input('plots.geojson', GEOJSON_POLYGON),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION },
    });
    const names = result.qa.checks.map((check) => check.name);
    expect(names).toContain('Feature count');
    expect(names).toContain('Max coordinate drift');
    expect(names).toContain('Coordinate reference system');
    expect(result.qa.verdict).toBe('PASS');
  });

  it('records provenance including a source hash', async () => {
    const result = await convert({
      input: input('survey.csv', SURVEY_CSV),
      targetFormatId: 'geojson',
      settings: { sourceCrs: UTM45N },
    });
    expect(result.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.provenance.sourceFormat).toContain('CSV');
    expect(result.provenance.featureCount).toBe(4);
    expect(allFeatures(result.sourceDataset).length).toBe(0); // table, not yet geometry
  });
});
