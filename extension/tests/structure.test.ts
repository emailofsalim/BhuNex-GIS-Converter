/**
 * Structure preservation: input structure = output structure.
 *
 * The property under test is that the shape someone gave their delivery — folders,
 * nested archives, CAD layers, KML folder trees — comes back out the other side.
 * These tests assert on paths rather than on bytes, because the paths *are* the
 * feature.
 */

import { describe, expect, it } from 'vitest';
import { convert, expandArchive, packageBatch, type ConversionInput } from '@core/pipeline';
import { FULL_PRECISION } from '@core/precision';
import { crsFromEpsg } from '@crs/epsg';
import { readZip, writeZip } from '@engines/archives/zip';
import {
  datasetForLayer,
  deduplicatePaths,
  describeTree,
  directoryForOrigin,
  joinPath,
  planLayout,
  safeSegment,
} from '@core/layout';
import { createDataset, createLayer, originFromPath } from '@core/cir';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const UTM45N = crsFromEpsg(32645);

function input(fileName: string, body: string | Uint8Array, path?: string, containers?: string[]): ConversionInput {
  return {
    fileName,
    bytes: typeof body === 'string' ? encoder.encode(body) : body,
    path: path ?? fileName,
    containers,
  };
}

/** A DXF with four distinct layers, so layer-splitting has something to split. */
const LAYERED_DXF = [
  '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'POINT', '5', 'A1', '8', 'Borehole', '10', '412300.5', '20', '2591200.25', '30', '412.75',
  '0', 'POINT', '5', 'A2', '8', 'Borehole', '10', '412310.5', '20', '2591210.25', '30', '413.75',
  '0', 'LINE', '5', 'A3', '8', 'Road', '10', '412300.0', '20', '2591200.0', '11', '412400.0', '21', '2591300.0',
  '0', 'LWPOLYLINE', '5', 'A4', '8', 'Plot', '90', '4', '70', '1',
  '10', '412500.0', '20', '2591500.0',
  '10', '412600.0', '20', '2591500.0',
  '10', '412600.0', '20', '2591600.0',
  '10', '412500.0', '20', '2591600.0',
  '0', 'LWPOLYLINE', '5', 'A5', '8', 'Bench_Crest', '90', '3', '70', '0',
  '10', '412700.0', '20', '2591700.0',
  '10', '412750.0', '20', '2591720.0',
  '10', '412800.0', '20', '2591760.0',
  '0', 'ENDSEC', '0', 'EOF',
].join('\r\n');

/** A KML whose folders nest two deep — the case a flat layer name cannot express. */
const NESTED_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Mine</name>
<Folder><name>Pit</name>
  <Folder><name>Bench crests</name>
    <Placemark><name>Crest 1</name><LineString><coordinates>84.680,23.430,412 84.681,23.431,413</coordinates></LineString></Placemark>
  </Folder>
  <Folder><name>Bench toes</name>
    <Placemark><name>Toe 1</name><LineString><coordinates>84.682,23.432,410 84.683,23.433,411</coordinates></LineString></Placemark>
  </Folder>
</Folder>
<Folder><name>Infrastructure</name>
  <Placemark><name>Haul road</name><LineString><coordinates>84.690,23.440,400 84.691,23.441,401</coordinates></LineString></Placemark>
</Folder>
</Document></kml>`;

const SURVEY_CSV = [
  'Point,Easting,Northing,Elevation,Code',
  'BM1,412345.678,2591234.567,412.345,BENCHMARK',
  'BM2,412445.123,2591334.891,415.210,BENCHMARK',
].join('\n');

describe('path helpers', () => {
  it('joins and normalises path segments', () => {
    expect(joinPath('a', 'b', 'c.txt')).toBe('a/b/c.txt');
    expect(joinPath('', 'b', '', 'c.txt')).toBe('b/c.txt');
    expect(joinPath('/a/', '/b/')).toBe('a/b');
  });

  it('sanitises a segment without letting it escape the tree', () => {
    expect(safeSegment('../etc')).not.toContain('/');
    expect(safeSegment('..')).toBe('layer');
    expect(safeSegment('')).toBe('layer');
    expect(safeSegment('Bench Crest')).toBe('Bench Crest');
  });

  it('turns nested archives and folders into a directory path', () => {
    const origin = originFromPath('Survey/Plots/plots.dxf', ['delivery.zip', 'survey.zip']);
    expect(origin.directory).toBe('Survey/Plots');
    expect(directoryForOrigin(origin)).toBe('delivery/survey/Survey/Plots');
  });

  it('renders a path list as a tree', () => {
    const lines = describeTree(['Pit/Bench crests.geojson', 'Pit/Bench toes.geojson', 'Infrastructure.geojson']);
    expect(lines).toEqual(['Pit/', '  Bench crests.geojson', '  Bench toes.geojson', 'Infrastructure.geojson']);
  });

  it('gives colliding paths a numeric suffix rather than overwriting', () => {
    const bytes = new Uint8Array([1]);
    const { nodes, collisions } = deduplicatePaths([
      { path: 'a/plots.geojson', bytes, mimeType: 'application/geo+json' },
      { path: 'a/plots.geojson', bytes, mimeType: 'application/geo+json' },
    ]);
    expect(collisions).toBe(1);
    expect(nodes.map((node) => node.path)).toEqual(['a/plots.geojson', 'a/plots_2.geojson']);
  });
});

describe('layout planning', () => {
  const dataset = createDataset({
    kind: 'vector',
    name: 'test',
    source: { fileName: 'test.kml', size: 0, formatId: 'kml', formatName: 'KML', detectionConfidence: 1 },
    layers: [
      createLayer('Bench crests', [{ id: 1, geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 }, properties: {} }], [], [
        'Pit',
        'Bench crests',
      ]),
      createLayer('Haul road', [{ id: 2, geometry: { type: 'Point', coordinates: [1, 1], dimension: 2 }, properties: {} }], [], [
        'Infrastructure',
        'Haul road',
      ]),
    ],
    origin: originFromPath('Site/mine.kml'),
  });

  it('keeps everything in one unit for the single layout', () => {
    const { units } = planLayout(dataset, { layout: 'single', baseName: 'mine', targetHoldsLayers: false });
    expect(units).toHaveLength(1);
    expect(units[0].directory).toBe('');
    expect(units[0].baseName).toBe('mine');
  });

  it('turns each layer into its own file inside its folder', () => {
    const { units } = planLayout(dataset, { layout: 'per-layer', baseName: 'mine', targetHoldsLayers: false });
    expect(units).toHaveLength(2);
    expect(units.map((unit) => joinPath(unit.directory, unit.baseName))).toEqual(['Pit/Bench crests', 'Infrastructure/Haul road']);
  });

  it('places the whole tree under the source directory when mirroring', () => {
    const { units } = planLayout(dataset, { layout: 'mirror-source', baseName: 'mine', targetHoldsLayers: false });
    expect(units.map((unit) => joinPath(unit.directory, unit.baseName))).toEqual([
      'Site/Pit/Bench crests',
      'Site/Infrastructure/Haul road',
    ]);
  });

  it('does not add a folder for a single layer', () => {
    const single = { ...dataset, layers: [dataset.layers[0]] };
    const { units } = planLayout(single, { layout: 'per-layer', baseName: 'mine', targetHoldsLayers: false });
    expect(units).toHaveLength(1);
    expect(units[0].baseName).toBe('mine');
  });

  it('says so when the target could have held the layers itself', () => {
    const { warnings } = planLayout(dataset, { layout: 'per-layer', baseName: 'mine', targetHoldsLayers: true });
    expect(warnings.some((warning) => warning.code === 'LAYOUT_TARGET_HOLDS_LAYERS')).toBe(true);
  });

  it('slices a dataset to one layer without carrying the others', () => {
    const sliced = datasetForLayer(dataset, dataset.layers[0]);
    expect(sliced.layers).toHaveLength(1);
    expect(sliced.layers[0].name).toBe('Bench crests');
    expect(sliced.crs).toBe(dataset.crs);
  });
});

describe('CAD layers become folders', () => {
  it('DXF -> GeoJSON per layer produces one file per CAD layer', async () => {
    const result = await convert({
      input: input('site.dxf', LAYERED_DXF),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N, layout: 'per-layer' },
    });

    expect(result.tree.sort()).toEqual(['Bench_Crest.geojson', 'Borehole.geojson', 'Plot.geojson', 'Road.geojson']);
    // Several files means the delivery is a ZIP, and the ZIP *is* the tree.
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].name.endsWith('.zip')).toBe(true);

    const entries = await readZip(result.outputs[0].bytes);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'Bench_Crest.geojson',
      'Borehole.geojson',
      'Plot.geojson',
      'Road.geojson',
    ]);

    const borehole = JSON.parse(decoder.decode(entries.find((entry) => entry.name === 'Borehole.geojson')!.bytes));
    expect(borehole.features).toHaveLength(2);
    expect(borehole.features.every((feature: any) => feature.properties._layer === 'Borehole')).toBe(true);
  });

  it('DXF -> Shapefile per layer gives each layer its own package folder', async () => {
    const result = await convert({
      input: input('site.dxf', LAYERED_DXF),
      targetFormatId: 'shapefile',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N, layout: 'per-layer' },
    });

    const entries = await readZip(result.outputs[0].bytes);
    const names = entries.map((entry) => entry.name);
    // Each shapefile package is complete and sits in its own folder, so the five
    // members of one layer never mingle with another's.
    for (const layer of ['Borehole', 'Road', 'Plot', 'Bench_Crest']) {
      for (const extension of ['shp', 'shx', 'dbf', 'prj', 'cpg']) {
        expect(names).toContain(`${layer}/${layer}.${extension}`);
      }
    }
    // No stray members at the root.
    expect(names.every((name) => name.includes('/'))).toBe(true);
  });

  it('keeps one file when the single layout is chosen', async () => {
    const result = await convert({
      input: input('site.dxf', LAYERED_DXF),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N, layout: 'single' },
    });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].name.endsWith('.geojson')).toBe(true);
    const parsed = JSON.parse(decoder.decode(result.outputs[0].bytes));
    expect(parsed.features.length).toBeGreaterThan(3);
  });
});

describe('KML folder hierarchy', () => {
  it('nested folders become nested directories', async () => {
    const result = await convert({
      input: input('mine.kml', NESTED_KML),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, layout: 'per-layer' },
    });
    // A folder holding placemarks directly is itself the layer, so it becomes a
    // file beside its sibling folders rather than a folder with one file in it.
    expect(result.tree.sort()).toEqual([
      'Mine/Infrastructure.geojson',
      'Mine/Pit/Bench crests.geojson',
      'Mine/Pit/Bench toes.geojson',
    ]);
  });

  it('KML -> KML rebuilds the folder tree rather than flattening it', async () => {
    const result = await convert({
      input: input('mine.kml', NESTED_KML),
      targetFormatId: 'kml',
      settings: { precision: FULL_PRECISION, layout: 'single' },
    });
    const text = decoder.decode(result.outputs[0].bytes);
    // The nesting is real: Pit contains Bench crests, not a sibling of it.
    expect(text).toMatch(/<Folder><name>Mine<\/name>.*<Folder><name>Pit<\/name>.*<Folder><name>Bench crests<\/name>/s);
    expect(text).toContain('Bench toes');
    expect(text).toContain('Infrastructure');
    // Each placemark appears exactly once.
    expect(text.match(/<Placemark>/g)).toHaveLength(3);
  });

  it('round-trips the hierarchy through GeoJSON and back into KML folders', async () => {
    const toGeoJson = await convert({
      input: input('mine.kml', NESTED_KML),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, layout: 'single' },
    });
    const back = await convert({
      input: input('mine.geojson', toGeoJson.outputs[0].bytes),
      targetFormatId: 'kml',
      settings: { precision: FULL_PRECISION, layout: 'single' },
    });
    const text = decoder.decode(back.outputs[0].bytes);
    // GeoJSON has no folders, so the hierarchy travels in _layer and is rebuilt.
    expect(text).toContain('Bench crests');
    expect(text).toContain('Infrastructure');
  });
});

describe('source tree mirroring', () => {
  it('places output under the folder the input came from', async () => {
    const result = await convert({
      input: input('plots.dxf', LAYERED_DXF, 'Delivery/Survey/plots.dxf'),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N, layout: 'mirror-source' },
    });
    expect(result.tree.every((path) => path.startsWith('Delivery/Survey/'))).toBe(true);
    expect(result.tree.sort()).toEqual([
      'Delivery/Survey/Bench_Crest.geojson',
      'Delivery/Survey/Borehole.geojson',
      'Delivery/Survey/Plot.geojson',
      'Delivery/Survey/Road.geojson',
    ]);
  });

  it('turns nested archives into folder levels', async () => {
    const result = await convert({
      input: input('plots.dxf', LAYERED_DXF, 'inner/plots.dxf', ['delivery.zip', 'survey.zip']),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N, layout: 'mirror-source' },
    });
    expect(result.tree.every((path) => path.startsWith('delivery/survey/inner/'))).toBe(true);
  });

  it('expands an archive keeping each entry in its own folder', async () => {
    const zip = await writeZip([
      { name: 'Survey/plots.dxf', bytes: encoder.encode(LAYERED_DXF) },
      { name: 'Control/points.csv', bytes: encoder.encode(SURVEY_CSV) },
    ]);
    const expanded = await expandArchive(input('delivery.zip', zip));

    expect(expanded.map((entry) => entry.path).sort()).toEqual(['Control/points.csv', 'Survey/plots.dxf']);
    // The archive itself becomes a container level for everything inside it.
    expect(expanded.every((entry) => entry.containers?.[0] === 'delivery.zip')).toBe(true);
    expect(expanded.map((entry) => entry.fileName).sort()).toEqual(['plots.dxf', 'points.csv']);
  });

  it('carries an expanded archive entry folder through to the output', async () => {
    const zip = await writeZip([{ name: 'Survey/plots.dxf', bytes: encoder.encode(LAYERED_DXF) }]);
    const [entry] = await expandArchive(input('delivery.zip', zip));
    const result = await convert({
      input: entry,
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: UTM45N, layout: 'mirror-source' },
    });
    expect(result.tree.every((path) => path.startsWith('delivery/Survey/'))).toBe(true);
  });
});

describe('batch delivery mirrors the input tree', () => {
  it('keeps same-named files apart by their folders', async () => {
    const results = await Promise.all([
      convert({
        input: input('plots.dxf', LAYERED_DXF, 'SiteA/plots.dxf'),
        targetFormatId: 'geojson',
        settings: { precision: FULL_PRECISION, sourceCrs: UTM45N, layout: 'single' },
      }),
      convert({
        input: input('plots.dxf', LAYERED_DXF, 'SiteB/plots.dxf'),
        targetFormatId: 'geojson',
        settings: { precision: FULL_PRECISION, sourceCrs: UTM45N, layout: 'single' },
      }),
    ]);

    const { zip, tree, manifestCsv } = await packageBatch(results);
    const entries = await readZip(zip);
    const names = entries.map((entry) => entry.name);

    // Same basename, different folders: both survive intact.
    expect(names).toContain('SiteA/plots_converted_to_geojson.geojson');
    expect(names).toContain('SiteB/plots_converted_to_geojson.geojson');
    expect(tree).toContain('SiteA/plots_converted_to_geojson.geojson');
    // The manifest names the real delivery path, not a bare filename.
    expect(manifestCsv).toContain('SiteA/plots_converted_to_geojson.geojson');
  });

  it('flattens when mirroring is switched off', async () => {
    const results = [
      await convert({
        input: input('plots.dxf', LAYERED_DXF, 'SiteA/plots.dxf'),
        targetFormatId: 'geojson',
        settings: { precision: FULL_PRECISION, sourceCrs: UTM45N, layout: 'single' },
      }),
    ];
    const { tree } = await packageBatch(results, { mirrorSource: false });
    expect(tree.some((path) => path.includes('/'))).toBe(false);
  });
});

describe('OSM export completes the round trip', () => {
  it('GeoJSON -> OSM -> GeoJSON keeps geometry and tags', async () => {
    const source = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { building: 'yes', name: 'Office' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[84.68, 23.43], [84.681, 23.43], [84.681, 23.431], [84.68, 23.431], [84.68, 23.43]]],
          },
        },
        { type: 'Feature', properties: { highway: 'track', name: 'Haul road' }, geometry: { type: 'LineString', coordinates: [[84.69, 23.44], [84.691, 23.441]] } },
      ],
    });

    const toOsm = await convert({
      input: input('site.geojson', source),
      targetFormatId: 'osm',
      settings: { precision: FULL_PRECISION, layout: 'single' },
    });
    const text = decoder.decode(toOsm.outputs[0].bytes);
    expect(text).toContain('<osm version="0.6"');
    // Negative ids: this is data shaped like OSM, not a claim on real objects.
    expect(text).toMatch(/<node id="-\d+"/);
    expect(text).toMatch(/<way id="-\d+"/);
    expect(toOsm.warnings.some((warning) => warning.code === 'OSM_NEGATIVE_IDS')).toBe(true);

    const back = await convert({
      input: input('site.osm', toOsm.outputs[0].bytes),
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, layout: 'single' },
    });
    const parsed = JSON.parse(decoder.decode(back.outputs[0].bytes));
    const kinds = parsed.features.map((feature: any) => feature.geometry.type).sort();
    expect(kinds).toEqual(['LineString', 'Polygon']);
    expect(JSON.stringify(parsed)).toContain('Haul road');
    expect(JSON.stringify(parsed)).toContain('Office');
  });

  it('reports interior rings rather than writing a plot without its hole', async () => {
    const withHole = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { landuse: 'quarry' },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [[84.68, 23.43], [84.69, 23.43], [84.69, 23.44], [84.68, 23.44], [84.68, 23.43]],
              [[84.683, 23.433], [84.686, 23.433], [84.686, 23.436], [84.683, 23.436], [84.683, 23.433]],
            ],
          },
        },
      ],
    });
    const result = await convert({
      input: input('pit.geojson', withHole),
      targetFormatId: 'osm',
      settings: { precision: FULL_PRECISION, layout: 'single' },
    });
    const holes = result.warnings.find((warning) => warning.code === 'OSM_HOLES_DROPPED');
    expect(holes).toBeDefined();
    expect(holes!.count).toBe(1);
    expect(holes!.action).toMatch(/GeoJSON|Shapefile|GeoPackage/);
  });
});
