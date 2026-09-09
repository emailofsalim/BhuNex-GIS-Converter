/**
 * FlatGeobuf, and the FlatBuffers codec underneath it.
 *
 * A LIMITATION STATED UP FRONT, because it changes how much these tests prove.
 * No third-party .fgb file was available in the environment this was built in,
 * so the round-trip tests below establish that the reader and the writer agree
 * with each other — which is necessary and is not the same as conforming to the
 * specification. Two kinds of test are here to narrow that gap:
 *
 *   · BYTE-LEVEL assertions on the parts of the layout the spec fixes exactly —
 *     the eight magic bytes, the uint32 header length, the vtable's signed
 *     backward offset, the alignment of a double vector. Those are written from
 *     the specification, not from the implementation, so they fail if my
 *     reading of the format is wrong even though reader and writer agree.
 *   · Assertions that catch the specific misreadings that produce a plausible
 *     wrong answer rather than a crash — `ends` read as lengths instead of
 *     cumulative counts, a property buffer desynchronised by one unknown
 *     column, a 2D feature silently gaining a Z of zero.
 *
 * What remains unverified is whether QGIS or GDAL will open a file this writes.
 * That is a five-minute check with a real tool and it has not been done here.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';
import { SURVEY_DEFAULT_PRECISION } from '@core/precision';
import {
  createDataset,
  createLayer,
  type CirFeature,
  type FieldDef,
  type SourceInfo,
} from '@core/cir';
import { crsFromEpsg } from '@crs/epsg';
import { ConversionError } from '@core/errors';
import { FlatBuilder, rootTable } from '../src/engines/vector/flatbuffers';
import { readFlatGeobuf, writeFlatGeobuf } from '../src/engines/vector/flatgeobuf';

const SOURCE: SourceInfo = {
  fileName: 'parcels.fgb',
  size: 0,
  formatId: 'flatgeobuf',
  formatName: 'FlatGeobuf',
  detectionConfidence: 1,
};

function dataset(features: CirFeature[], fields: FieldDef[] = [], layerName = 'parcels') {
  return createDataset({
    kind: 'vector',
    name: 'parcels',
    source: SOURCE,
    crs: crsFromEpsg(32645),
    layers: [createLayer(layerName, features, fields)],
  });
}

/** Writes then reads, which is the path every test below takes. */
function roundTrip(features: CirFeature[], fields: FieldDef[] = []) {
  const written = writeFlatGeobuf(dataset(features, fields));
  return { written, back: readFlatGeobuf(written.bytes, SOURCE) };
}

const geometryOf = (features: CirFeature[], fields: FieldDef[] = []) =>
  roundTrip(features, fields).back.layers[0].features[0].geometry;

// ---------------------------------------------------------------- the codec

describe('the FlatBuffers codec, against the layout the format fixes', () => {
  it('writes a vtable as a SIGNED offset backwards from the table', () => {
    // The one structural fact everything else depends on. A vtable normally
    // sits after the table that uses it, so the stored value is negative and
    // reading it as unsigned lands billions of bytes away.
    const builder = new FlatBuilder();
    builder.startObject(1);
    builder.addUint8(0, 42);
    const bytes = builder.finish(builder.endObject());

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tablePosition = view.getUint32(0, true);
    const soffset = view.getInt32(tablePosition, true);
    const vtablePosition = tablePosition - soffset;

    expect(vtablePosition).toBeGreaterThanOrEqual(0);
    expect(vtablePosition).toBeLessThan(bytes.length);
    // vtable: its own size, then the table's size, then one uint16 per field.
    expect(view.getUint16(vtablePosition, true)).toBe(6);
  });

  it('aligns a vector of doubles to eight bytes', () => {
    // Misaligned doubles are readable through a DataView and unreadable by a
    // C++ consumer that maps the buffer directly, which is the whole point of
    // FlatBuffers' alignment rules.
    const builder = new FlatBuilder();
    const vector = builder.createDoubleVector([1.5, 2.5, 3.5]);
    builder.startObject(1);
    builder.addOffset(0, vector);
    const bytes = builder.finish(builder.endObject());

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const table = rootTable(view);
    // The elements begin after the uint32 count, and that position must be a
    // multiple of eight relative to the buffer start.
    expect(table.vectorStart(0) % 8).toBe(0);
    expect(Array.from(table.doubles(0))).toEqual([1.5, 2.5, 3.5]);
  });

  it('omits a field left at its default and reads it back as that default', () => {
    const builder = new FlatBuilder();
    builder.startObject(3);
    builder.addUint8(1, 0); // equal to the default, so nothing is written
    const bytes = builder.finish(builder.endObject());
    const table = rootTable(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));

    expect(table.fieldOffset(1)).toBe(0);
    expect(table.uint8(1, 99)).toBe(99);
    expect(table.string(0)).toBeNull();
  });

  it('shares one vtable across many identically shaped tables', () => {
    // Not a micro-optimisation: a FlatGeobuf file is one Feature table per
    // feature, all the same shape, so without sharing a 40,000-parcel file
    // carries 40,000 identical vtables.
    //
    // Asserted by resolving each table's vtable and counting the distinct
    // positions, rather than by watching the file size — a size proxy cannot
    // separate a shared vtable from a slightly smaller table, and the first
    // version of this test failed against a codec that was sharing correctly.
    const builder = new FlatBuilder();
    const offsets: number[] = [];
    for (let i = 0; i < 20; i++) {
      builder.startObject(2);
      builder.addUint8(0, 1);
      builder.addUint8(1, 2);
      offsets.push(builder.endObject());
    }
    const vector = builder.createOffsetVector(offsets);
    builder.startObject(1);
    builder.addOffset(0, vector);
    const bytes = builder.finish(builder.endObject());

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const root = rootTable(view);
    const vtables = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const table = root.tableAt(0, i);
      vtables.add(table.position - view.getInt32(table.position, true));
    }
    expect(vtables.size).toBe(1);
  });

  it('survives growing past its initial buffer', () => {
    const builder = new FlatBuilder(32);
    const many = Array.from({ length: 4000 }, (_, index) => index * 0.25);
    const vector = builder.createDoubleVector(many);
    const text = builder.createString('x'.repeat(2000));
    builder.startObject(2);
    builder.addOffset(0, vector);
    builder.addOffset(1, text);
    const bytes = builder.finish(builder.endObject());
    const table = rootTable(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));

    expect(Array.from(table.doubles(0))).toEqual(many);
    expect(table.string(1)).toHaveLength(2000);
  });
});

// ----------------------------------------------------------------- the file

describe('the file layout', () => {
  const point: CirFeature = {
    geometry: { type: 'Point', coordinates: [412345.678, 2591234.567], dimension: 2 },
    properties: {},
  };

  it('begins with the eight magic bytes the specification fixes', () => {
    const { bytes } = writeFlatGeobuf(dataset([point]));
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]);
  });

  it('follows the magic with a uint32 header length that lands on the features', () => {
    const { bytes } = writeFlatGeobuf(dataset([point]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint32(8, true);

    expect(headerLength).toBeGreaterThan(0);
    // With no index, the first feature's own uint32 length starts here, and it
    // must account for exactly the rest of the file.
    const featureStart = 8 + 4 + headerLength;
    const featureLength = view.getUint32(featureStart, true);
    expect(featureStart + 4 + featureLength).toBe(bytes.length);
  });

  it('writes index_node_size as an explicit zero, not as an omitted default', () => {
    // The schema default is 16. Leaving the field out would mean "there is a
    // 16-way index here", and every reader would step over bytes of features
    // looking for it — landing mid-feature and reading a garbage length.
    const { bytes } = writeFlatGeobuf(dataset([point]));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = rootTable(view, 12);
    expect(header.fieldOffset(9)).not.toBe(0);
    expect(header.uint16(9, 16)).toBe(0);
  });

  it('records the feature count and the envelope in the header', () => {
    const { bytes } = writeFlatGeobuf(
      dataset([point, { geometry: { type: 'Point', coordinates: [1, 2], dimension: 2 }, properties: {} }])
    );
    const header = rootTable(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 12);
    expect(header.uint64(8)).toBe(2);
    expect(Array.from(header.doubles(1))).toEqual([1, 2, 412345.678, 2591234.567]);
  });
});

// ------------------------------------------------------------- the geometry

describe('every geometry type survives the round trip', () => {
  it('a point', () => {
    expect(geometryOf([{ geometry: { type: 'Point', coordinates: [412345.678, 2591234.567], dimension: 2 }, properties: {} }]))
      .toEqual({ type: 'Point', coordinates: [412345.678, 2591234.567], dimension: 2 });
  });

  it('a line', () => {
    const coordinates = [[0, 0], [1, 1], [2, 0]];
    expect(geometryOf([{ geometry: { type: 'LineString', coordinates, dimension: 2 }, properties: {} }]))
      .toEqual({ type: 'LineString', coordinates, dimension: 2 });
  });

  it('a polygon with a hole, which is where `ends` matters', () => {
    // The shell is 5 coordinates and the hole is 5, so `ends` is [5, 10]. Read
    // as LENGTHS rather than cumulative counts it gives rings starting at 0 and
    // 5 with lengths 5 and 10 — right for the shell, and the hole runs off the
    // end. That mistake produces a valid-looking polygon.
    const coordinates = [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
    ];
    expect(geometryOf([{ geometry: { type: 'Polygon', coordinates, dimension: 2 }, properties: {} }]))
      .toEqual({ type: 'Polygon', coordinates, dimension: 2 });
  });

  it('a polygon with three rings, where reading ends as lengths first breaks', () => {
    const coordinates = [
      [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
      [[2, 2], [5, 2], [5, 5], [2, 5], [2, 2]],
      [[10, 10], [15, 10], [15, 15], [10, 15], [10, 10]],
    ];
    expect(geometryOf([{ geometry: { type: 'Polygon', coordinates, dimension: 2 }, properties: {} }]))
      .toEqual({ type: 'Polygon', coordinates, dimension: 2 });
  });

  it('a multi-point', () => {
    const coordinates = [[0, 0], [5, 5], [10, 0]];
    expect(geometryOf([{ geometry: { type: 'MultiPoint', coordinates, dimension: 2 }, properties: {} }]))
      .toEqual({ type: 'MultiPoint', coordinates, dimension: 2 });
  });

  it('a multi-line', () => {
    const coordinates = [[[0, 0], [1, 1]], [[5, 5], [6, 6], [7, 5]]];
    expect(geometryOf([{ geometry: { type: 'MultiLineString', coordinates, dimension: 2 }, properties: {} }]))
      .toEqual({ type: 'MultiLineString', coordinates, dimension: 2 });
  });

  it('a multi-polygon, which is nested parts rather than a flat run', () => {
    const coordinates = [
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]], [[5.2, 5.2], [5.4, 5.2], [5.4, 5.4], [5.2, 5.4], [5.2, 5.2]]],
    ];
    expect(geometryOf([{ geometry: { type: 'MultiPolygon', coordinates, dimension: 2 }, properties: {} }]))
      .toEqual({ type: 'MultiPolygon', coordinates, dimension: 2 });
  });

  it('a Z coordinate, to full double precision', () => {
    // Elevations are the reason this tool exists; a rounded Z is a wrong Z.
    const coordinates = [[0, 0, 412.3456789], [1, 1, 415.9876543]];
    expect(geometryOf([{ geometry: { type: 'LineString', coordinates, dimension: 3 }, properties: {} }]))
      .toEqual({ type: 'LineString', coordinates, dimension: 3 });
  });

  it('a feature with no geometry at all, keeping its attributes', () => {
    const fields: FieldDef[] = [{ name: 'plot', type: 'string' }];
    const { back } = roundTrip([{ geometry: null, properties: { plot: 'A-1' } }], fields);
    expect(back.layers[0].features[0].geometry).toBeNull();
    expect(back.layers[0].features[0].properties.plot).toBe('A-1');
  });

  it('coordinates exactly, with no rounding anywhere on the path', () => {
    const x = 412345.6789012345;
    const y = 2591234.5678901234;
    const out = geometryOf([{ geometry: { type: 'Point', coordinates: [x, y], dimension: 2 }, properties: {} }]);
    expect((out!.coordinates as number[])[0]).toBe(x);
    expect((out!.coordinates as number[])[1]).toBe(y);
  });
});

// ------------------------------------------------------------ the attributes

describe('attributes survive with their types', () => {
  const fields: FieldDef[] = [
    { name: 'plot', type: 'string' },
    { name: 'area', type: 'number' },
    { name: 'holdings', type: 'integer' },
    { name: 'disputed', type: 'boolean' },
  ];
  const feature = (properties: Record<string, unknown>): CirFeature => ({
    geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 },
    properties,
  });

  it('round-trips a string, a double, an integer and a boolean', () => {
    const { back } = roundTrip([feature({ plot: 'A-1/2', area: 4046.86, holdings: 7, disputed: true })], fields);
    expect(back.layers[0].features[0].properties).toEqual({
      plot: 'A-1/2',
      area: 4046.86,
      holdings: 7,
      disputed: true,
    });
  });

  it('declares each column with the type the reader needs to size it', () => {
    // The property buffer has no per-value tag: a value's width comes only
    // from its column's declared type, so a wrong declaration does not fail —
    // it shifts every attribute after it.
    const { back } = roundTrip([feature({ plot: 'x', area: 1.5, holdings: 2, disputed: false })], fields);
    expect(back.layers[0].fields.map((field) => [field.name, field.type])).toEqual([
      ['plot', 'string'],
      ['area', 'number'],
      ['holdings', 'integer'],
      ['disputed', 'boolean'],
    ]);
  });

  it('keeps the columns after an omitted one aligned', () => {
    // The encoding is (column index, value) pairs, so omitting the middle
    // column must not shift the ones after it. This is the desynchronisation
    // that produces attributes attached to the wrong field.
    const { back } = roundTrip([feature({ plot: 'A-1', holdings: 9, disputed: true })], fields);
    const properties = back.layers[0].features[0].properties;
    expect(properties.plot).toBe('A-1');
    expect(properties.holdings).toBe(9);
    expect(properties.disputed).toBe(true);
    expect(properties.area).toBeUndefined();
  });

  it('omits a null rather than encoding one, since the format has no null', () => {
    const { back } = roundTrip([feature({ plot: null, area: 5 })], fields);
    expect(back.layers[0].features[0].properties.plot).toBeUndefined();
    expect(back.layers[0].features[0].properties.area).toBe(5);
  });

  it('carries a string with non-ASCII characters byte for byte', () => {
    const { back } = roundTrip([feature({ plot: 'खसरा १२३ / ग्राम' })], fields);
    expect(back.layers[0].features[0].properties.plot).toBe('खसरा १२३ / ग्राम');
  });

  it('keeps an integer beyond 32 bits', () => {
    // Declared Long rather than Int for exactly this: a survey id or an
    // Aadhaar-style number overflows a 32-bit column silently.
    const { back } = roundTrip([feature({ holdings: 9007199254740991 })], fields);
    expect(back.layers[0].features[0].properties.holdings).toBe(9007199254740991);
  });
});

// ----------------------------------------------------------------- the CRS

describe('the coordinate system', () => {
  it('round-trips an EPSG code', () => {
    const { back } = roundTrip([{ geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 }, properties: {} }]);
    expect(back.crs?.epsg).toBe(32645);
    expect(back.crsOrigin).toBe('declared');
  });

  it('reports no CRS as unknown rather than assuming one', () => {
    const withoutCrs = createDataset({
      kind: 'vector',
      name: 'parcels',
      source: SOURCE,
      layers: [createLayer('parcels', [{ geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 }, properties: {} }], [])],
    });
    const back = readFlatGeobuf(writeFlatGeobuf(withoutCrs).bytes, SOURCE);
    expect(back.crs).toBeNull();
    expect(back.crsOrigin).toBe('unknown');
  });
});

// ------------------------------------------------------- what it reports

describe('what the writer reports rather than hides', () => {
  it('warns when a 2D feature is given a Z of zero', () => {
    // has_z is a property of the FILE. One 3D feature forces every 2D one to
    // carry a Z, and the only value available is zero — a parcel at sea level
    // it was never surveyed at.
    const { written } = roundTrip([
      { geometry: { type: 'Point', coordinates: [0, 0, 412.3], dimension: 3 }, properties: {} },
      { geometry: { type: 'Point', coordinates: [1, 1], dimension: 2 }, properties: {} },
    ]);
    const filled = written.warnings.find((entry) => entry.code === 'FGB_Z_FILLED');
    expect(filled?.count).toBe(1);
    expect(filled?.severity).toBe('warning');
  });

  it('says nothing about Z when every feature is 2D', () => {
    const { written } = roundTrip([{ geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 }, properties: {} }]);
    expect(written.warnings.find((entry) => entry.code === 'FGB_Z_FILLED')).toBeUndefined();
  });

  it('warns that multiple layers are merged, because the format has no layers', () => {
    const twoLayers = createDataset({
      kind: 'vector',
      name: 'parcels',
      source: SOURCE,
      layers: [
        createLayer('boundaries', [{ geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 }, properties: {} }], []),
        createLayer('corners', [{ geometry: { type: 'Point', coordinates: [1, 1], dimension: 2 }, properties: {} }], []),
      ],
    });
    const written = writeFlatGeobuf(twoLayers);
    expect(written.warnings.find((entry) => entry.code === 'FGB_LAYERS_MERGED')?.count).toBe(2);
    expect(readFlatGeobuf(written.bytes, SOURCE).layers[0].features).toHaveLength(2);
  });

  it('notes a mixed-geometry layer rather than picking one type', () => {
    const { written, back } = roundTrip([
      { geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 }, properties: {} },
      { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]], dimension: 2 }, properties: {} },
    ]);
    expect(written.warnings.find((entry) => entry.code === 'FGB_MIXED_GEOMETRY')).toBeDefined();
    // And each feature still comes back as the type it was.
    expect(back.layers[0].features[0].geometry?.type).toBe('Point');
    expect(back.layers[0].features[1].geometry?.type).toBe('LineString');
  });
});

// -------------------------------------------------------- what it refuses

describe('what the reader refuses', () => {
  const good = () => writeFlatGeobuf(dataset([{ geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 }, properties: {} }])).bytes;

  it('a file that is not FlatGeobuf', () => {
    const notFgb = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => readFlatGeobuf(notFgb, SOURCE)).toThrow(ConversionError);
  });

  it('a file too short to hold the magic number', () => {
    expect(() => readFlatGeobuf(new Uint8Array([0x66, 0x67]), SOURCE)).toThrow(/too short/);
  });

  it('a specification version it does not implement, naming the version', () => {
    // Refusing beats reading: the layout changed between major versions, so
    // these offsets would produce coordinates rather than an error.
    const future = good();
    future[3] = 9;
    let message = '';
    try {
      readFlatGeobuf(future, SOURCE);
    } catch (error) {
      message = (error as { what: string }).what;
    }
    expect(message).toContain('version 9');
  });

  it('a header that runs past the end of the file', () => {
    const truncated = good();
    new DataView(truncated.buffer).setUint32(8, 999999, true);
    expect(() => readFlatGeobuf(truncated, SOURCE)).toThrow(/header runs past/);
  });

  it('returns what it read when the features are cut short, rather than throwing', () => {
    // A truncated delivery is worth something. Losing the 39,000 parcels that
    // did arrive because the 40,000th is incomplete is not.
    const bytes = writeFlatGeobuf(
      dataset([
        { geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 }, properties: {} },
        { geometry: { type: 'Point', coordinates: [1, 1], dimension: 2 }, properties: {} },
      ])
    ).bytes;
    const cut = bytes.slice(0, bytes.length - 12);
    const back = readFlatGeobuf(cut, SOURCE);
    expect(back.layers[0].features.length).toBeGreaterThanOrEqual(1);
    expect(back.warnings.find((entry) => entry.code === 'FGB_SHORT')).toBeDefined();
  });
});

// --------------------------------------------------------------- end to end

describe('through the conversion pipeline', () => {
  const GEOJSON = JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32645' } },
    features: [
      {
        type: 'Feature',
        properties: { plot_no: '784', area_m2: 4046.86 },
        geometry: {
          type: 'Polygon',
          coordinates: [[[412300, 2591200], [412400, 2591200], [412400, 2591300], [412300, 2591300], [412300, 2591200]]],
        },
      },
    ],
  });

  it('converts GeoJSON to FlatGeobuf and back with the geometry intact', async () => {
    const toFgb = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: 'flatgeobuf',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: crsFromEpsg(32645) },
    });
    expect(toFgb.outputs[0].name.endsWith('.fgb')).toBe(true);

    const back = await convert({
      input: { fileName: toFgb.outputs[0].name, bytes: toFgb.outputs[0].bytes },
      targetFormatId: 'geojson',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    });

    const parsed = JSON.parse(new TextDecoder().decode(back.outputs[0].bytes));
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0].geometry.type).toBe('Polygon');
    expect(parsed.features[0].geometry.coordinates[0][0]).toEqual([412300, 2591200]);
    expect(parsed.features[0].properties.plot_no).toBe('784');
    expect(parsed.features[0].properties.area_m2).toBeCloseTo(4046.86, 6);
  });

  it('is recognised by its magic number even when the extension lies', async () => {
    // The magic identifies it as the best guess, and the extension disagreeing
    // holds the confidence below the confirmation threshold — so the tool asks
    // rather than assuming. That refusal is the designed behaviour, and this
    // asserts BOTH halves: the right guess, and the fact that a guess alone is
    // not enough to convert on.
    const toFgb = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: 'flatgeobuf',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: crsFromEpsg(32645) },
    });

    let refusal: { code?: string; what?: string } = {};
    await convert({
      input: { fileName: 'mystery.bin', bytes: toFgb.outputs[0].bytes },
      targetFormatId: 'geojson',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    }).catch((error: { code?: string; what?: string }) => {
      refusal = error;
    });

    expect(refusal.code).toBe('FORMAT_UNCONFIRMED');
    expect(refusal.what).toContain('FlatGeobuf');
  });

  it('converts a renamed file once the format is confirmed', async () => {
    const toFgb = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: 'flatgeobuf',
      settings: { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: crsFromEpsg(32645) },
    });
    const confirmed = await convert({
      input: { fileName: 'mystery.bin', bytes: toFgb.outputs[0].bytes },
      forcedSourceFormatId: 'flatgeobuf',
      targetFormatId: 'geojson',
      settings: { precision: SURVEY_DEFAULT_PRECISION },
    });
    expect(JSON.parse(new TextDecoder().decode(confirmed.outputs[0].bytes)).features).toHaveLength(1);
  });
});
