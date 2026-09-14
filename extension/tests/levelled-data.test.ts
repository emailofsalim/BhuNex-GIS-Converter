/**
 * What happens to survey LEVELS, which is most of what a survey is.
 *
 * A drawing without its reduced levels is a picture. Three separate defects
 * conspired to lose them, and each one passed every check that existed:
 *
 *   1. KML wrote `,0` as the altitude for every vertex whenever the altitude
 *      mode was clampToGround — which is the default. Every reduced level in
 *      the file became zero.
 *
 *   2. The fidelity check called that a PASS, because it asked whether a third
 *      ordinate EXISTED rather than what it held. Zero is a number, so the
 *      check was satisfied by the very substitution it should have caught.
 *
 *   3. The DXF writer tagged its polygon rings — the mechanism that lets a hole
 *      survive a format with no concept of one — only on the flat LWPOLYLINE
 *      path. A drawing carrying Z takes the 3D POLYLINE path, so every levelled
 *      parcel lost its holes. Survey data is 3D more often than not, making
 *      this the common case rather than the edge.
 *
 * Together: a levelled cadastral sheet went to Google Earth with its levels
 * zeroed and its tanks turned into land, and the tool reported that it had
 * verified the result.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';
import { compareVector } from '@qa/fidelity';
import { createDataset, createLayer, type CirDataset, type CirFeature } from '@core/cir';
import { crsFromEpsg } from '@crs/epsg';

const UTM44N = crsFromEpsg(32644);
const E = 412000;
const N = 2591300;

/** A parcel with an excluded tank, levels on every corner. */
const LEVELLED = JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32644' } },
  features: [
    {
      type: 'Feature',
      properties: { plot: '12/A' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[E, N, 412.5], [E + 60, N, 412.6], [E + 60, N + 45, 412.8], [E, N + 45, 412.7], [E, N, 412.5]],
          [
            [E + 20, N + 15, 410.1],
            [E + 20, N + 30, 410.2],
            [E + 40, N + 30, 410.3],
            [E + 40, N + 15, 410.2],
            [E + 20, N + 15, 410.1],
          ],
        ],
      },
    },
  ],
});

/** The same parcel with no levels at all — the 2D honesty case. */
const FLAT = JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32644' } },
  features: [
    {
      type: 'Feature',
      properties: { plot: '13' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[E, N], [E + 60, N], [E + 60, N + 45], [E, N + 45], [E, N]]],
      },
    },
  ],
});

async function run(body: string, targetFormatId: string): Promise<any> {
  return convert({
    input: { fileName: 'parcel.geojson', bytes: new TextEncoder().encode(body) },
    targetFormatId,
    settings: { sourceCrs: UTM44N },
  } as never);
}

/** Every Z actually present in a dataset, in no particular order. */
function elevations(dataset: unknown): number[] {
  const found: number[] = [];
  const walk = (value: any): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      if (value.length > 2 && Number.isFinite(value[2])) found.push(value[2]);
      return;
    }
    for (const child of value) walk(child);
  };
  for (const layer of (dataset as any)?.layers ?? []) {
    for (const feature of layer.features ?? []) walk(feature.geometry?.coordinates);
  }
  return found;
}

describe('KML carries the levels it was given', () => {
  it('writes the real elevation, not zero', async () => {
    const result = await run(LEVELLED, 'kml');
    const text = new TextDecoder().decode(result.outputs[0].bytes);
    // Read from the bytes rather than the re-import: this is about what leaves
    // the tool and lands in someone's Google Earth.
    expect(text).toContain('412.5');
    expect(text).toContain('410.1');
    // The signature of the defect: a coordinate tuple ending in a bare zero.
    expect(text, 'an elevation was written as zero').not.toMatch(/,0[\s<]/);
  });

  it('still clamps to the ground, so nothing about the drawing changes on screen', async () => {
    // The fix must not be a behaviour change in disguise. altitudeMode decides
    // how Google Earth DRAWS the geometry; the coordinate tuple decides what
    // the file KNOWS. Keeping the level and clamping the drawing are not in
    // tension — reading them as one thing is what caused the loss.
    const result = await run(LEVELLED, 'kml');
    const text = new TextDecoder().decode(result.outputs[0].bytes);
    expect(text).toContain('<altitudeMode>clampToGround</altitudeMode>');
  });

  it('round-trips every level unchanged', async () => {
    const result = await run(LEVELLED, 'kml');
    const before = elevations(result.sourceDataset).sort((a, b) => a - b);
    const after = elevations(result.outputDataset).sort((a, b) => a - b);
    expect(after).toEqual(before);
  });

  it('leaves a flat drawing flat rather than inventing sea level', async () => {
    // `,0` is not a neutral placeholder. Read back it becomes a real elevation,
    // so a 2D cadastral sheet returns as a 3D one pinned to zero — 261 vertices
    // of fiction on the survey fixture this was measured against.
    const result = await run(FLAT, 'kml');
    expect(elevations(result.sourceDataset)).toEqual([]);
    expect(elevations(result.outputDataset), 'elevations were invented for a flat drawing').toEqual([]);
  });

  it('reports the levels as kept, and means it', async () => {
    const result = await run(LEVELLED, 'kml');
    const check = (result.qa?.checks ?? []).find((c: any) => c.name === 'Elevation (Z)');
    expect(check?.status).toBe('pass');
    expect(check?.target).toContain('410.100');
  });
});

// ---------------------------------------------------------------- the checker

/** A dataset of one line, with a Z on each vertex. */
function lineAt(zs: number[]): CirDataset {
  const feature: CirFeature = {
    id: 'a',
    geometry: {
      type: 'LineString',
      coordinates: zs.map((z, index) => [E + index * 10, N, z]),
      dimension: 3,
    },
    properties: {},
  };
  return createDataset({
    name: 'levels',
    kind: 'vector',
    source: { fileName: 'levels.geojson', size: 0, formatId: 'geojson', formatName: 'GeoJSON', detectionConfidence: 1 },
    crs: UTM44N,
    layers: [createLayer('levels', [feature])],
  });
}

describe('the elevation check judges the values, not their presence', () => {
  it('fails a conversion that replaced varying levels with one number', () => {
    const report = compareVector(lineAt([412.5, 413.1, 414.8]), lineAt([0, 0, 0]));
    const check = report.checks.find((c) => c.name === 'Elevation (Z)');
    expect(check?.status, 'levels replaced by zero were accepted').toBe('fail');
    expect(check?.note).toMatch(/replaced, not kept/i);
  });

  it('says what the levels were, so the report is actionable', () => {
    const report = compareVector(lineAt([412.5, 413.1, 414.8]), lineAt([0, 0, 0]));
    const check = report.checks.find((c) => c.name === 'Elevation (Z)');
    expect(check?.note).toContain('412.500');
    expect(check?.note).toContain('414.800');
  });

  it('warns when levels merely drifted, rather than calling it destruction', () => {
    // A shift is a different defect from a substitution and reads differently
    // in the report — collapsing both to one verdict would hide which happened.
    const report = compareVector(lineAt([412.5, 413.1, 414.8]), lineAt([414.5, 415.1, 416.8]));
    const check = report.checks.find((c) => c.name === 'Elevation (Z)');
    expect(check?.status).toBe('warn');
    expect(check?.note).toMatch(/moved by up to/i);
  });

  it('accepts rounding at the precision the writer used', () => {
    const report = compareVector(lineAt([412.5, 413.1, 414.8]), lineAt([412.5001, 413.1, 414.8]));
    expect(report.checks.find((c) => c.name === 'Elevation (Z)')?.status).toBe('pass');
  });

  it('still reports an honest drop as a known loss rather than a failure', () => {
    // A format with nowhere to put Z is not broken. It is documented, and the
    // distinction between "cannot" and "destroyed" is the whole point.
    const flat = lineAt([412.5, 413.1, 414.8]);
    const dropped = createDataset({
      ...flat,
      layers: [
        createLayer('levels', [
          {
            id: 'a',
            geometry: { type: 'LineString', coordinates: [[E, N], [E + 10, N], [E + 20, N]], dimension: 2 },
            properties: {},
          },
        ]),
      ],
    });
    const check = compareVector(flat, dropped).checks.find((c) => c.name === 'Elevation (Z)');
    expect(check?.status).toBe('warn');
    expect(check?.note).toMatch(/dropped by the target format/i);
  });
});

// ------------------------------------------------------------ 3D DXF and holes

describe('a levelled polygon keeps its hole through DXF', () => {
  it('tags the rings on the 3D path, the way the flat path always did', async () => {
    const result = await run(LEVELLED, 'dxf');
    const text = new TextDecoder().decode(result.outputs[0].bytes);
    // A 3D drawing is written as POLYLINE/VERTEX rather than LWPOLYLINE, and
    // that branch returned before it reached the XDATA that records which
    // polygon each ring belongs to.
    expect(text).toContain('POLYLINE');
    expect(text).toContain('BHUNEX_RING');
    expect(text, 'the inner ring was not tagged').toContain('0:0:1');
  });

  it('reads back as one polygon with two rings, not two parcels', async () => {
    const result = await run(LEVELLED, 'dxf');
    const features = (result.outputDataset?.layers ?? []).flatMap((layer: any) => layer.features ?? []);
    expect(features.length, 'the hole became a second parcel').toBe(1);
    expect(features[0].geometry.type).toBe('Polygon');
    expect(features[0].geometry.coordinates.length, 'the hole was lost').toBe(2);
  });

  it('keeps the levels on both rings while doing it', async () => {
    const result = await run(LEVELLED, 'dxf');
    const after = elevations(result.outputDataset).sort((a, b) => a - b);
    expect(after).toEqual(elevations(result.sourceDataset).sort((a, b) => a - b));
  });

  it('carries the hole onward to KML, which is where the drawing is going', async () => {
    // The real journey: total station → DXF → Google Earth. Both defects sat on
    // this path, so it is worth walking end to end rather than trusting that
    // two green halves make a green whole.
    const toDxf = await run(LEVELLED, 'dxf');
    const toKml: any = await convert({
      input: { fileName: toDxf.outputs[0].name, bytes: toDxf.outputs[0].bytes },
      targetFormatId: 'kml',
      settings: { sourceCrs: UTM44N },
    } as never);

    const features = (toKml.outputDataset?.layers ?? []).flatMap((layer: any) => layer.features ?? []);
    const polygons = features.filter((f: any) => f.geometry?.type === 'Polygon');
    expect(polygons.length).toBe(1);
    expect(polygons[0].geometry.coordinates.length, 'the tank became land').toBe(2);
    expect(toKml.qa?.verdict, toKml.qa?.summary).not.toBe('FAILED');
  });
});
