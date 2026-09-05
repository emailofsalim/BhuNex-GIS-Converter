import { describe, expect, it } from 'vitest';
import { detectFormat, CONFIRM_THRESHOLD } from '@core/detect';
import { groupCompanions, requiredCompanionsFor, type IngestFile } from '@core/companions';
import { convertArea, convertLinear, linearUnitFromInsunits, linearUnitFromWktName, LINEAR_UNITS } from '@core/units';
import { arcSegmentCount, segmentizeArc, segmentizeCircle, signedArea, orientRing, pointInRing } from '@core/geometry';
import { buildOutputName, sanitizeFileName, uniqueName } from '@core/naming';
import { formatFixed, roundTo, SURVEY_DEFAULT_PRECISION, FULL_PRECISION } from '@core/precision';
import { readZip, writeZip, crc32 } from '@engines/archives/zip';
import { checkTopology, repairTopology, DEFAULT_REPAIR_OPTIONS } from '@qa/topology';
import { detectSchema, looksLikeHeader, matchHeaders } from '@engines/survey/schema';
import { createDataset, createLayer } from '@core/cir';
import { ConversionError } from '@core/errors';

const encoder = new TextEncoder();

describe('format detection', () => {
  const detect = (fileName: string, body: string | Uint8Array, siblings?: string[]) =>
    detectFormat({ fileName, bytes: typeof body === 'string' ? encoder.encode(body) : body, siblings });

  it('identifies a survey CSV above the confirmation threshold', () => {
    const result = detect('survey.csv', 'Point,Easting,Northing,Elevation\n1,412345.678,2591234.567,412.345\n2,412445,2591334,415');
    expect(result.formatId).toBe('csv');
    expect(result.confidence).toBeGreaterThan(CONFIRM_THRESHOLD);
    expect(result.requiresConfirmation).toBe(false);
  });

  it('identifies a DXF from its group-code stream, not its extension', () => {
    const dxf = '0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n';
    // Deliberately the wrong extension: the content must win.
    const result = detect('drawing.txt', dxf);
    expect(result.formatId).toBe('dxf');
    expect(result.requiresConfirmation).toBe(false);
  });

  it('does not call an arbitrary JSON file GeoJSON', () => {
    const result = detect('config.json', JSON.stringify({ name: 'settings', values: [1, 2, 3] }));
    expect(result.formatId).not.toBe('geojson');
  });

  it('identifies GeoJSON by structure', () => {
    const result = detect('plots.json', JSON.stringify({ type: 'FeatureCollection', features: [] }));
    expect(result.formatId).toBe('geojson');
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('separates LAZ from LAS by the compressed point-format bit', () => {
    const las = new Uint8Array(300);
    las.set(encoder.encode('LASF'), 0);
    las[24] = 1;
    las[25] = 2;
    new DataView(las.buffer).setUint16(94, 227, true);
    las[104] = 1;
    expect(detect('cloud.las', las).formatId).toBe('las');

    const laz = las.slice();
    laz[104] = 1 | 0x80;
    expect(detect('cloud.laz', laz).formatId).toBe('laz');
  });

  it('raises shapefile confidence when companions are present', () => {
    const shp = new Uint8Array(120);
    const view = new DataView(shp.buffer);
    view.setInt32(0, 9994, false);
    view.setInt32(24, shp.length / 2, false);
    view.setInt32(32, 1, true);
    const withCompanions = detect('roads.shp', shp, ['shx', 'dbf', 'prj']);
    const alone = detect('roads.shp', shp, []);
    expect(withCompanions.confidence).toBeGreaterThan(alone.confidence);
  });

  it('flags an unrecognisable file for confirmation instead of guessing', () => {
    const result = detect('mystery.bin', new Uint8Array([0x9f, 0x8e, 0x7d, 0x6c, 0x5b]));
    expect(result.requiresConfirmation).toBe(true);
  });

  it('reports the evidence behind its decision', () => {
    const result = detect('plots.geojson', JSON.stringify({ type: 'FeatureCollection', features: [] }));
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.some((item) => item.layer === 'json-shape')).toBe(true);
  });
});

describe('companion grouping', () => {
  const file = (path: string): IngestFile => ({ path, name: path.split('/').pop()!, size: 1, bytes: new Uint8Array(1) });

  it('groups a shapefile package into one dataset', () => {
    const groups = groupCompanions([
      file('data/roads.shp'),
      file('data/roads.shx'),
      file('data/roads.dbf'),
      file('data/roads.prj'),
      file('data/roads.cpg'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].primary.name).toBe('roads.shp');
    expect([...groups[0].companions.keys()].sort()).toEqual(['cpg', 'dbf', 'prj', 'shx']);
    expect(groups[0].missing).toHaveLength(0);
  });

  it('names the missing companion instead of failing silently', () => {
    const groups = groupCompanions([file('data/roads.shp'), file('data/roads.prj')]);
    expect(groups[0].missing).toEqual(['shx', 'dbf']);
  });

  it('binds a raster to its world file and projection', () => {
    const groups = groupCompanions([file('ortho.tif'), file('ortho.tfw'), file('ortho.prj')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].companions.has('tfw')).toBe(true);
  });

  it('keeps files in different folders apart', () => {
    const groups = groupCompanions([file('a/site.shp'), file('a/site.shx'), file('a/site.dbf'), file('b/site.shp'), file('b/site.shx'), file('b/site.dbf')]);
    expect(groups).toHaveLength(2);
  });

  it('knows which companions a shapefile requires', () => {
    expect(requiredCompanionsFor('shp')).toEqual(['shx', 'dbf']);
    expect(requiredCompanionsFor('mif')).toEqual(['mid']);
  });
});

describe('units', () => {
  it('keeps the US survey foot distinct from the international foot', () => {
    expect(LINEAR_UNITS['us-ft'].toBase).not.toBe(LINEAR_UNITS.ft.toBase);
    // The two feet differ by 2 ppm. A 10 km traverse expressed in each of them
    // differs by 0.0656 ft, which is 20 mm on the ground — the reason a
    // converter must never treat them as the same unit.
    const asUsFeet = convertLinear(10000, 'm', 'us-ft');
    const asIntFeet = convertLinear(10000, 'm', 'ft');
    expect(Math.abs(asUsFeet - asIntFeet)).toBeGreaterThan(0.06);
    expect(Math.abs(convertLinear(asUsFeet, 'us-ft', 'm') - convertLinear(asUsFeet, 'ft', 'm'))).toBeCloseTo(0.02, 3);
  });

  it('converts linear units exactly', () => {
    expect(convertLinear(1, 'm', 'mm')).toBe(1000);
    expect(convertLinear(1, 'ft', 'm')).toBeCloseTo(0.3048, 12);
    expect(convertLinear(1, 'mi', 'km')).toBeCloseTo(1.609344, 9);
  });

  it('converts area units in their own namespace', () => {
    expect(convertArea(1, 'ha', 'm2')).toBe(10000);
    expect(convertArea(1, 'acre', 'm2')).toBeCloseTo(4046.8564224, 6);
  });

  it('maps DXF $INSUNITS codes', () => {
    expect(linearUnitFromInsunits(6)).toBe('m');
    expect(linearUnitFromInsunits(2)).toBe('ft');
    expect(linearUnitFromInsunits(0)).toBeNull();
  });

  it('recognises the many spellings of the US survey foot in WKT', () => {
    for (const spelling of ['US survey foot', 'Foot_US', 'US_survey_foot', 'foot US survey']) {
      expect(linearUnitFromWktName(spelling)).toBe('us-ft');
    }
    expect(linearUnitFromWktName('Meter')).toBe('m');
  });
});

describe('curve segmentization', () => {
  it('honours the sagitta tolerance', () => {
    // Tighter tolerance must never produce fewer segments.
    const coarse = arcSegmentCount(100, Math.PI * 2, 0.1);
    const fine = arcSegmentCount(100, Math.PI * 2, 0.001);
    expect(fine).toBeGreaterThan(coarse);
  });

  it('keeps the chord error within tolerance for a circle', () => {
    const radius = 50;
    const tolerance = 0.01;
    const ring = segmentizeCircle(0, 0, radius, undefined, tolerance);
    let worst = 0;
    for (let index = 0; index + 1 < ring.length; index++) {
      const midX = (ring[index][0] + ring[index + 1][0]) / 2;
      const midY = (ring[index][1] + ring[index + 1][1]) / 2;
      // Distance from the chord midpoint to the true arc is the sagitta.
      worst = Math.max(worst, radius - Math.hypot(midX, midY));
    }
    expect(worst).toBeLessThanOrEqual(tolerance * 1.001);
  });

  it('closes a circle exactly on its start vertex', () => {
    const ring = segmentizeCircle(10, 20, 5, undefined, 0.01);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('produces an arc that starts and ends on the requested angles', () => {
    const points = segmentizeArc({ cx: 0, cy: 0, radius: 10, startAngle: 0, endAngle: Math.PI / 2 }, 0.001);
    expect(points[0][0]).toBeCloseTo(10, 6);
    expect(points[0][1]).toBeCloseTo(0, 6);
    expect(points[points.length - 1][0]).toBeCloseTo(0, 6);
    expect(points[points.length - 1][1]).toBeCloseTo(10, 6);
  });
});

describe('geometry helpers', () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];

  it('computes signed area and orientation', () => {
    expect(Math.abs(signedArea(square))).toBeCloseTo(100, 9);
    const clockwise = orientRing(square, true);
    expect(signedArea(clockwise)).toBeGreaterThan(0);
    const counter = orientRing(square, false);
    expect(signedArea(counter)).toBeLessThan(0);
  });

  it('tests point containment', () => {
    expect(pointInRing([5, 5], square)).toBe(true);
    expect(pointInRing([15, 5], square)).toBe(false);
  });
});

describe('precision', () => {
  it('rounds without binary representation noise', () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(412345.6785, 3)).toBe(412345.679);
  });

  it('never writes exponent notation', () => {
    expect(formatFixed(0.0000001, 15)).not.toMatch(/e/i);
    expect(formatFixed(412345.678, 3)).toBe('412345.678');
  });

  it('defaults to millimetre precision for projected survey output', () => {
    expect(SURVEY_DEFAULT_PRECISION.linearDecimals).toBe(3);
    // Geographic default must resolve better than a metre: 7 dp is about 11 mm.
    expect(SURVEY_DEFAULT_PRECISION.geographicDecimals).toBeGreaterThanOrEqual(7);
    expect(FULL_PRECISION.mode).toBe('full');
  });
});

describe('file naming', () => {
  it('never overwrites the source', () => {
    const name = buildOutputName('site.dxf', 'geojson', 'geojson');
    expect(name).toBe('site_converted_to_geojson.geojson');
  });

  it('sanitises unsafe path characters', () => {
    expect(sanitizeFileName('../../etc/passwd')).not.toContain('/');
    expect(sanitizeFileName('plot<>:"|?*.dxf')).not.toMatch(/[<>:"|?*]/);
    expect(sanitizeFileName('')).toBe('output');
  });

  it('avoids Windows reserved names', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
  });

  it('de-duplicates names within a batch', () => {
    const used = new Set<string>();
    expect(uniqueName('site.geojson', used)).toBe('site.geojson');
    expect(uniqueName('site.geojson', used)).toBe('site_2.geojson');
    expect(uniqueName('site.geojson', used)).toBe('site_3.geojson');
  });
});

describe('zip engine', () => {
  it('round-trips files through write and read', async () => {
    const files = [
      { name: 'a.txt', bytes: encoder.encode('hello world '.repeat(50)) },
      { name: 'nested/b.bin', bytes: new Uint8Array([1, 2, 3, 4, 5]) },
    ];
    const zip = await writeZip(files);
    const entries = await readZip(zip);
    expect(entries.map((entry) => entry.name).sort()).toEqual(['a.txt', 'nested/b.bin']);
    expect(new TextDecoder().decode(entries.find((entry) => entry.name === 'a.txt')!.bytes)).toBe('hello world '.repeat(50));
  });

  it('computes a CRC32 matching the reference value', () => {
    // "123456789" has a well-known CRC-32 of 0xCBF43926.
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
  });

  it('rejects an entry whose path escapes the extraction root', async () => {
    const zip = await writeZip([{ name: 'safe.txt', bytes: encoder.encode('ok') }]);
    // Rewrite the stored name in both the local and central headers.
    const text = new TextDecoder('latin1').decode(zip);
    const patched = new Uint8Array(zip);
    let at = text.indexOf('safe.txt');
    while (at >= 0) {
      patched.set(encoder.encode('../evil'), at);
      // Names are the same length, so the offsets stay valid.
      patched[at + 7] = 0x74; // pad to keep the 8-byte length
      at = text.indexOf('safe.txt', at + 1);
    }
    await expect(readZip(patched)).rejects.toThrow(ConversionError);
  });

  it('refuses a file that is not an archive', async () => {
    await expect(readZip(encoder.encode('not a zip'))).rejects.toMatchObject({ code: 'ZIP_NOT_AN_ARCHIVE' });
  });
});

describe('survey schema', () => {
  it('matches header aliases to roles', () => {
    const roles = matchHeaders(['Pt No', 'Easting', 'Northing', 'RL', 'Description']).map((match) => match.role);
    expect(roles).toEqual(['id', 'easting', 'northing', 'elevation', 'description']);
  });

  it('detects a header-named table without asking for confirmation', () => {
    const detection = detectSchema(['Point', 'Easting', 'Northing', 'Elevation'], [[1, 412345, 2591234, 412]], 4);
    expect(detection.requiresConfirmation).toBe(false);
    expect(detection.mapping?.roles.easting).toBe(1);
    expect(detection.mapping?.coordinateOrder).toBe('easting-northing');
  });

  it('requires confirmation for a headerless positional table', () => {
    const detection = detectSchema(null, [[1, 2591234, 412345, 412, 'BM']], 5);
    expect(detection.requiresConfirmation).toBe(true);
    expect(detection.schemaId).toBe('pnezd');
    expect(detection.rationale).toMatch(/PNEZD and PENZD/i);
  });

  it('re-labels X/Y as longitude/latitude when the values are degrees', () => {
    const detection = detectSchema(['id', 'X', 'Y'], [[1, 84.68, 23.43]], 3);
    expect(detection.mapping?.roles.longitude).toBe(1);
    expect(detection.mapping?.roles.latitude).toBe(2);
    expect(detection.requiresConfirmation).toBe(true);
  });

  it('recognises mining field names for labelling', () => {
    const detection = detectSchema(['BHID', 'Easting', 'Northing', 'RL', 'Lithology'], [['BH1', 1, 2, 3, 'shale']], 5);
    expect(detection.domainHints).toEqual(expect.arrayContaining(['Borehole ID', 'Lithology']));
  });

  it('tells a header row from a data row', () => {
    expect(looksLikeHeader(['Point', 'Easting', 'Northing'])).toBe(true);
    expect(looksLikeHeader([1, 412345.678, 2591234.567])).toBe(false);
  });
});

describe('topology', () => {
  const dataset = (coordinates: number[][][]) =>
    createDataset({
      kind: 'vector',
      name: 'test',
      source: { fileName: 'test.geojson', size: 0, formatId: 'geojson', formatName: 'GeoJSON', detectionConfidence: 1 },
      layers: [
        createLayer('test', [
          { id: 1, geometry: { type: 'Polygon', coordinates, dimension: 2 }, properties: {} },
        ]),
      ],
    });

  it('detects an unclosed ring', () => {
    const report = checkTopology(dataset([[[0, 0], [10, 0], [10, 10], [0, 10]]]));
    expect(report.counts['unclosed-ring']).toBe(1);
  });

  it('detects a self-intersection', () => {
    // A bow-tie: the two diagonals cross.
    const report = checkTopology(dataset([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]]));
    expect(report.counts['self-intersection']).toBe(1);
  });

  it('passes a clean polygon', () => {
    const report = checkTopology(dataset([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]));
    expect(report.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it('leaves geometry untouched when repair is off', () => {
    const source = dataset([[[0, 0], [10, 0], [10, 10], [0, 10]]]);
    const { dataset: repaired, warnings } = repairTopology(source, DEFAULT_REPAIR_OPTIONS);
    expect(repaired).toBe(source);
    expect(warnings).toHaveLength(0);
  });

  it('reports exactly what repair changed when it is enabled', () => {
    const source = dataset([[[0, 0], [10, 0], [10, 10], [0, 10]]]);
    const { dataset: repaired, warnings } = repairTopology(source, { ...DEFAULT_REPAIR_OPTIONS, closeRings: true });
    const ring = (repaired.layers[0].features[0].geometry!.coordinates as number[][][])[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(warnings[0].code).toBe('TOPOLOGY_REPAIRED');
    expect(warnings[0].message).toContain('1 ring(s) closed');
  });
});
