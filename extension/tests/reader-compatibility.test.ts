/**
 * What ArcGIS, QGIS and Google Earth actually require of these files.
 *
 * WHAT THIS TEST CAN AND CANNOT PROVE
 *
 * It cannot open ArcGIS. It checks the properties those readers are documented
 * to depend on, and parses the bytes with logic independent of the writer that
 * produced them — a writer marking its own homework proves nothing. Where a
 * spec states a number (a shapefile's file code is 9994) the number is
 * asserted; where it states an ordering (KML is longitude first) the ordering
 * is measured against a known coordinate.
 *
 * The one thing none of this substitutes for is opening a delivery in the
 * software the client uses. It narrows what can go wrong there to things a
 * specification does not cover.
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { convert } from '@core/pipeline';
import { SURVEY_DEFAULT_PRECISION } from '@core/precision';
import { crsFromEpsg } from '@crs/epsg';

const decoder = new TextDecoder();
const KMZ = '2_Trial_Feedback_Files/imported file/PKR_CADASTRAL_MAP.kmz';

async function outputs(targetFormatId: string, epsg: number | null) {
  const result: never = (await convert({
    input: { fileName: 'PKR.kmz', bytes: new Uint8Array(readFileSync(KMZ)) },
    targetFormatId,
    settings: {
      precision: SURVEY_DEFAULT_PRECISION,
      targetCrs: epsg ? crsFromEpsg(epsg) : null,
      runQa: false,
    },
  } as never)) as never;
  return (result as unknown as { outputs: { name: string; bytes: Uint8Array }[] }).outputs;
}

describe.skipIf(!existsSync(KMZ))('Google Earth — KML 2.2', () => {
  it('declares the OGC namespace Google Earth looks for', async () => {
    const kml = decoder.decode((await outputs('kml', null))[0].bytes);
    expect(kml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(kml).toContain('xmlns="http://www.opengis.net/kml/2.2"');
    expect(kml).toContain('<Document>');
    expect(kml).toContain('<Placemark>');
  }, 300_000);

  it('writes longitude before latitude, which is the whole of KML', async () => {
    // Reversed, the cadastral map lands in the Indian Ocean and still opens
    // without complaint. This is the check that catches that.
    const kml = decoder.decode((await outputs('kml', null))[0].bytes);
    const pair = kml.match(/<coordinates>\s*(-?[\d.]+),(-?[\d.]+)/);
    expect(pair).not.toBeNull();
    const [lon, lat] = [Number(pair![1]), Number(pair![2])];
    expect(lon).toBeGreaterThan(84);
    expect(lon).toBeLessThan(85);
    expect(lat).toBeGreaterThan(23);
    expect(lat).toBeLessThan(24);
  }, 300_000);
});

describe.skipIf(!existsSync(KMZ))('QGIS and ArcGIS — GeoJSON RFC 7946', () => {
  it('is a FeatureCollection with no CRS member when it is WGS 84', async () => {
    // RFC 7946 removed the crs member: a WGS 84 file must not carry one, and
    // one that does is the F6 defect — a label disagreeing with the numbers.
    const json = JSON.parse(decoder.decode((await outputs('geojson', null))[0].bytes));
    expect(json.type).toBe('FeatureCollection');
    expect(json.crs).toBeUndefined();
  }, 300_000);

  it('closes its rings and winds the exterior counter-clockwise', async () => {
    // §3.1.6, the right-hand rule. QGIS and ArcGIS both tolerate the other
    // winding, but a file that follows the spec cannot be blamed for a reader
    // that does not.
    const json = JSON.parse(decoder.decode((await outputs('geojson', null))[0].bytes));
    const ring = json.features.find((f: any) => f.geometry?.type === 'Polygon')?.geometry.coordinates[0];
    expect(Array.isArray(ring)).toBe(true);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) sum += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
    expect(sum).toBeLessThan(0); // negative shoelace = counter-clockwise
  }, 300_000);
});

describe.skipIf(!existsSync(KMZ))('ArcGIS and QGIS — ESRI Shapefile', () => {
  it('ships every mandatory part, plus the .prj both read the CRS from', async () => {
    const zip = (await outputs('shapefile', 32645))[0];
    const names = zipEntryNames(zip.bytes);
    const extensions = new Set(names.map((name) => name.split('.').pop()!.toLowerCase()));
    // .shp/.shx/.dbf are mandatory; without .prj the layer loads with an
    // unknown CRS and lands wherever the project's default puts it.
    for (const required of ['shp', 'shx', 'dbf', 'prj']) expect(extensions).toContain(required);
    // One geometry type per shapefile is a rule of the format, so a mixed
    // dataset must come out as more than one.
    expect(names.filter((name) => name.endsWith('.shp')).length).toBeGreaterThan(1);
  }, 300_000);

  it('writes a .shp header that matches the specification', async () => {
    const zip = (await outputs('shapefile', 32645))[0];
    const shp = zipEntry(zip.bytes, (name) => name.endsWith('.shp'));
    const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
    expect(view.getInt32(0, false)).toBe(9994); // file code, big-endian
    expect(view.getInt32(28, true)).toBe(1000); // version
    // The length field is in 16-bit words and must describe the actual file.
    // A mismatch is the classic way a shapefile opens empty.
    expect(view.getInt32(24, false) * 2).toBe(shp.byteLength);
  }, 300_000);

  it('writes the .prj in the ESRI flavour ArcGIS expects', async () => {
    const zip = (await outputs('shapefile', 32645))[0];
    const prj = decoder.decode(zipEntry(zip.bytes, (name) => name.endsWith('.prj')));
    expect(prj).toContain('PROJCS');
    expect(prj).toContain('Transverse_Mercator');
    // ESRI WKT1 spells the datum D_WGS_1984 where OGC WKT1 says "WGS_1984".
    // ArcGIS is the fussier reader, and QGIS accepts both.
    expect(prj).toContain('D_WGS_1984');
    expect(prj).toContain('"Central_Meridian",87');
  }, 300_000);
});

// --------------------------------------------------------------------------
// A ZIP reader written here rather than borrowed from the writer under test.
// --------------------------------------------------------------------------

function zipEntryNames(zip: Uint8Array): string[] {
  const names: string[] = [];
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = 0; i < zip.length - 4; i++) {
    if (view.getUint32(i, true) !== 0x04034b50) continue; // local file header
    const nameLength = view.getUint16(i + 26, true);
    names.push(decoder.decode(zip.subarray(i + 30, i + 30 + nameLength)));
  }
  return names;
}

/** The first entry whose name matches, decompressed only if it is stored. */
function zipEntry(zip: Uint8Array, match: (name: string) => boolean): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = 0; i < zip.length - 4; i++) {
    if (view.getUint32(i, true) !== 0x04034b50) continue;
    const method = view.getUint16(i + 8, true);
    const compressed = view.getUint32(i + 18, true);
    const nameLength = view.getUint16(i + 26, true);
    const extraLength = view.getUint16(i + 28, true);
    const name = decoder.decode(zip.subarray(i + 30, i + 30 + nameLength));
    const start = i + 30 + nameLength + extraLength;
    if (!match(name)) continue;
    if (method !== 0) {
      // Deflated. Node can inflate it without adding a dependency to the app.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { inflateRawSync } = require('node:zlib');
      return new Uint8Array(inflateRawSync(Buffer.from(zip.subarray(start, start + compressed))));
    }
    return zip.subarray(start, start + compressed);
  }
  throw new Error('No matching entry in the archive.');
}
