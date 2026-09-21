/**
 * KML ground and screen overlays, both directions.
 *
 * WHAT WAS WRONG
 *
 * READING: `readKml` walked the tree looking for `<Placemark>` and recursed
 * past everything else. A KMZ whose whole content is a scanned plan or an
 * orthophoto draped on the terrain — which is how a great many survey
 * deliverables arrive — read as a document with ZERO features and no warning
 * saying why. Total silent loss of the only thing in the file.
 *
 * WRITING: the pipeline reduces a raster to its footprint polygon for every
 * vector target, which is right everywhere except here. KMZ is the one vector
 * target that CAN keep pixels — KML has carried `<GroundOverlay>` since 2.0
 * and a KMZ is a ZIP that can hold the image beside the doc — so converting an
 * orthophoto to KMZ produced an empty rectangle where Google Earth could have
 * shown the picture.
 *
 * The bytes are parsed back with the repo's own ZIP reader rather than trusted
 * from the writer's return value, because a writer marking its own homework
 * proves nothing.
 */

import { describe, expect, it } from 'vitest';
import { readKml, writeKmz, DEFAULT_KML_OPTIONS } from '../src/engines/vector/kml';
import { readZip } from '../src/engines/archives/zip';
import { createDataset, createLayer, type CirDataset } from '../src/core/cir';
import { crsFromEpsg } from '../src/crs/epsg';
import type { PrecisionPolicy } from '../src/core/precision';

const PRECISION: PrecisionPolicy = { mode: 'fixed', linearDecimals: 3, geographicDecimals: 7, elevationDecimals: 3 };
const OPTIONS = { ...DEFAULT_KML_OPTIONS, precision: PRECISION };

const SOURCE = { fileName: 'plan.kml', size: 0, formatId: 'kml', formatName: 'KML', detectionConfidence: 1 };

/** A tiny north-up raster in degrees, with real pixels. */
function raster(options: { rotated?: boolean; noData?: number | null; bands?: number } = {}): CirDataset {
  const width = 4;
  const height = 3;
  const count = options.bands ?? 1;
  const bands = Array.from(
    { length: count },
    (_, band) => new Float64Array(Array.from({ length: width * height }, (_, index) => index + band * 10))
  );
  return createDataset({
    kind: 'raster',
    name: 'ortho',
    source: SOURCE,
    crs: crsFromEpsg(4326),
    crsOrigin: 'declared',
    layers: [createLayer('empty', [], [], ['empty'])],
    raster: {
      width,
      height,
      bandCount: count,
      pixelType: 'float64',
      noData: options.noData ?? null,
      // [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight]
      geotransform: options.rotated
        ? [85, 0.001, 0.0004, 23, 0.0004, -0.001]
        : [85, 0.001, 0, 23, 0, -0.001],
      extent: { minX: 85, minY: 22.997, maxX: 85.004, maxY: 23 },
      bands,
      hasPixelData: true,
    },
  } as never);
}

async function entriesOf(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const files = await readZip(bytes);
  return new Map(files.map((file) => [file.name, file.bytes]));
}

describe('writing a raster into a KMZ as a GroundOverlay', () => {
  it('packs the image beside the doc and points the Icon at it', async () => {
    const { bytes } = await writeKmz(raster(), OPTIONS);
    const entries = await entriesOf(bytes);

    expect([...entries.keys()].sort()).toEqual(['doc.kml', 'overlay.png']);

    const doc = new TextDecoder().decode(entries.get('doc.kml')!);
    expect(doc).toContain('<GroundOverlay>');
    expect(doc).toContain('<href>overlay.png</href>');
  });

  it('writes a real PNG, checked by its signature and header', async () => {
    const { bytes } = await writeKmz(raster(), OPTIONS);
    const png = (await entriesOf(bytes)).get('overlay.png')!;

    // The eight-byte PNG signature, then IHDR carrying the dimensions.
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe('IHDR');
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(4); // width
    expect(view.getUint32(20)).toBe(3); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(0); // colour type 0: greyscale, one band and no no-data
  });

  it('gets the LatLonBox from the geotransform, north above south', async () => {
    const { bytes } = await writeKmz(raster(), OPTIONS);
    const doc = new TextDecoder().decode((await entriesOf(bytes)).get('doc.kml')!);

    const read = (tag: string) => Number(new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(doc)?.[1]);
    // origin 85,23 with 0.001 pixels over 4x3, and a NEGATIVE pixel height,
    // so the raster runs south from its origin.
    expect(read('west')).toBeCloseTo(85, 6);
    expect(read('east')).toBeCloseTo(85.004, 6);
    expect(read('north')).toBeCloseTo(23, 6);
    expect(read('south')).toBeCloseTo(22.997, 6);
    expect(read('north')).toBeGreaterThan(read('south'));
  });

  it('draws the image UNDER the vectors', async () => {
    // An aerial photo emitted after the parcels would cover the boundaries the
    // user converted. Google Earth draws equal drawOrder in document order.
    const dataset = raster();
    const { bytes } = await writeKmz(dataset, OPTIONS);
    const doc = new TextDecoder().decode((await entriesOf(bytes)).get('doc.kml')!);
    expect(doc).toContain('<drawOrder>0</drawOrder>');
    expect(doc.indexOf('<GroundOverlay>')).toBeLessThan(doc.indexOf('<Folder>') === -1 ? doc.length : doc.indexOf('<Folder>'));
  });

  it('writes RGB when the raster has three bands', async () => {
    const { bytes } = await writeKmz(raster({ bands: 3 }), OPTIONS);
    const png = (await entriesOf(bytes)).get('overlay.png')!;
    expect(png[25]).toBe(2); // colour type 2: truecolour
  });

  it('gains an alpha channel so no-data is transparent rather than black', async () => {
    // A DEM's void filled with black reads as a pit in the terrain — the most
    // confident kind of wrong.
    const { bytes } = await writeKmz(raster({ noData: 0 }), OPTIONS);
    const png = (await entriesOf(bytes)).get('overlay.png')!;
    expect(png[25]).toBe(6); // colour type 6: truecolour with alpha
  });
});

describe('what the overlay writer refuses, and says so', () => {
  it('REFUSES a rotated geotransform instead of squaring it up', async () => {
    // LatLonBox is four numbers and therefore axis-aligned. Writing the
    // bounding box of a rotated raster puts the image at the wrong angle while
    // looking entirely converted, which is worse than not writing it.
    const { bytes, warnings } = await writeKmz(raster({ rotated: true }), OPTIONS);
    const entries = await entriesOf(bytes);

    expect([...entries.keys()]).toEqual(['doc.kml']);
    expect(new TextDecoder().decode(entries.get('doc.kml')!)).not.toContain('<GroundOverlay>');

    const refusal = warnings.find((warning) => warning.code === 'KML_OVERLAY_ROTATED');
    expect(refusal, 'a rotated raster was dropped with no explanation').toBeTruthy();
    expect(refusal!.action).toMatch(/reproject/i);
  });

  it('says so when only the georeference was read and there are no pixels', async () => {
    const dataset = raster();
    const stripped = { ...dataset, raster: { ...dataset.raster!, hasPixelData: false, bands: undefined } } as CirDataset;
    const { warnings } = await writeKmz(stripped, OPTIONS);
    expect(warnings.some((warning) => warning.code === 'KML_OVERLAY_NO_PIXELS')).toBe(true);
  });

  it('says so when the raster is on a projected grid', async () => {
    const dataset = raster();
    const projected = { ...dataset, crs: crsFromEpsg(32645) } as CirDataset;
    const { warnings } = await writeKmz(projected, OPTIONS);
    expect(warnings.some((warning) => warning.code === 'KML_OVERLAY_NOT_GEOGRAPHIC')).toBe(true);
  });

  it('adds no overlay, and no warning, to an ordinary vector document', async () => {
    const vector = createDataset({
      kind: 'vector',
      name: 'parcels',
      source: SOURCE,
      crs: crsFromEpsg(4326),
      crsOrigin: 'declared',
      layers: [
        createLayer(
          'parcels',
          [{ id: 1, geometry: { type: 'Point', coordinates: [85, 23], dimension: 2 }, properties: {}, sourceLayer: 'parcels' }],
          [],
          ['parcels']
        ),
      ],
    } as never);

    const { bytes, warnings } = await writeKmz(vector, OPTIONS);
    const entries = await entriesOf(bytes);

    expect([...entries.keys()]).toEqual(['doc.kml']);
    expect(warnings.some((warning) => warning.code.startsWith('KML_OVERLAY'))).toBe(false);
  });
});

describe('reading overlays that used to be walked straight past', () => {
  const wrap = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Site</name>${body}</Document></kml>`;

  it('imports a GroundOverlay as its footprint instead of nothing at all', () => {
    const dataset = readKml(
      wrap(
        `<GroundOverlay><name>Scanned plan</name><Icon><href>scan.jpg</href></Icon>` +
          `<LatLonBox><north>23</north><south>22.997</south><east>85.004</east><west>85</west></LatLonBox></GroundOverlay>`
      ),
      SOURCE
    );

    const features = dataset.layers.flatMap((layer) => layer.features);
    expect(features).toHaveLength(1);
    expect(features[0].sourceEntity).toBe('GroundOverlay');
    expect(features[0].properties.name).toBe('Scanned plan');
    expect(features[0].properties.overlayImage).toBe('scan.jpg');

    // The ring is the box's four corners, closed.
    const ring = (features[0].geometry as { coordinates: number[][][] }).coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(Math.min(...ring.map((p) => p[0]))).toBeCloseTo(85, 6);
    expect(Math.max(...ring.map((p) => p[1]))).toBeCloseTo(23, 6);
  });

  it('reads a gx:LatLonQuad as the four corners it already is', () => {
    const dataset = readKml(
      wrap(
        `<GroundOverlay><name>Skewed</name><Icon><href>a.png</href></Icon>` +
          `<gx:LatLonQuad xmlns:gx="http://www.google.com/kml/ext/2.2">` +
          `<coordinates>85,23 85.01,23.002 85.011,23.01 85.001,23.008</coordinates>` +
          `</gx:LatLonQuad></GroundOverlay>`
      ),
      SOURCE
    );

    const feature = dataset.layers.flatMap((layer) => layer.features)[0];
    expect(feature.sourceEntity).toBe('GroundOverlay');
    expect((feature.geometry as { coordinates: number[][][] }).coordinates[0]).toHaveLength(5);
  });

  it('keeps a rotation as an attribute rather than turning the corners', () => {
    // KML rotates about the box centre at DRAW time, so the ground footprint
    // of a rotated overlay is not the rotated rectangle.
    const dataset = readKml(
      wrap(
        `<GroundOverlay><name>Tilted</name><Icon><href>a.png</href></Icon>` +
          `<LatLonBox><north>23</north><south>22.99</south><east>85.01</east><west>85</west><rotation>30</rotation></LatLonBox>` +
          `</GroundOverlay>`
      ),
      SOURCE
    );

    const feature = dataset.layers.flatMap((layer) => layer.features)[0];
    expect(feature.properties.rotation).toBe(30);
    expect(dataset.warnings.some((warning) => warning.code === 'KML_OVERLAY_ROTATED')).toBe(true);
    // Unrotated corners: the box as stated.
    const ring = (feature.geometry as { coordinates: number[][][] }).coordinates[0];
    expect(Math.max(...ring.map((p) => p[0]))).toBeCloseTo(85.01, 6);
  });

  it('reports a ScreenOverlay and refuses to invent geometry for it', () => {
    // It is pinned to the viewport, not the ground. Giving a company logo a
    // coordinate would put it on the survey as if it had been surveyed.
    const dataset = readKml(
      wrap(
        `<ScreenOverlay><name>North arrow</name><Icon><href>arrow.png</href></Icon>` +
          `<overlayXY x="0" y="1" xunits="fraction" yunits="fraction"/>` +
          `<screenXY x="0" y="1" xunits="fraction" yunits="fraction"/></ScreenOverlay>`
      ),
      SOURCE
    );

    expect(dataset.layers.flatMap((layer) => layer.features)).toHaveLength(0);
    const notice = dataset.warnings.find((warning) => warning.code === 'KML_SCREEN_OVERLAY');
    expect(notice, 'a screen overlay vanished without a word').toBeTruthy();
    expect(notice!.action).toContain('North arrow');
  });

  it('says so when an overlay states no position at all', () => {
    const dataset = readKml(wrap(`<GroundOverlay><name>Nowhere</name><Icon><href>a.png</href></Icon></GroundOverlay>`), SOURCE);
    expect(dataset.warnings.some((warning) => warning.code === 'KML_OVERLAY_NO_BOX')).toBe(true);
  });

  it('still reads placemarks that share a document with an overlay', () => {
    const dataset = readKml(
      wrap(
        `<GroundOverlay><name>Scan</name><Icon><href>a.png</href></Icon>` +
          `<LatLonBox><north>23</north><south>22.99</south><east>85.01</east><west>85</west></LatLonBox></GroundOverlay>` +
          `<Placemark><name>Pillar</name><Point><coordinates>85.005,22.995</coordinates></Point></Placemark>`
      ),
      SOURCE
    );

    const kinds = dataset.layers.flatMap((layer) => layer.features).map((feature) => feature.sourceEntity);
    expect(kinds).toContain('GroundOverlay');
    expect(kinds).toContain('Placemark');
  });
});
