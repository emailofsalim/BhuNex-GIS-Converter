/**
 * Registry guard (instruction §16.4).
 *
 * This is the test that keeps rule R1 true: a format may not advertise a support
 * level its engines have not earned. It walks the registry and fails when a
 * claim has nothing behind it — a hand-edited `support: 'full'` breaks the build
 * rather than shipping a lie to a surveyor.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FORMATS, exportTargetsFor, getFormat, isAvailable, SUPPORT_LABEL } from '@core/registry';

const testsDir = dirname(fileURLToPath(import.meta.url));

/**
 * Every suite in this directory, read as the evidence for a support claim.
 *
 * This used to be a hand-maintained list of four filenames, with a comment
 * saying that a file left out of it was invisible to the guard. That is exactly
 * what happened: a new format arrived with a 39-test suite of its own and the
 * guard reported it as unbacked, because the suite was not on the list. A guard
 * whose coverage has to be remembered is a guard that will eventually be wrong
 * in the other direction — passing a claim nothing tests — so it now reads the
 * directory and cannot fall behind it.
 */
const allTestSource = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.ts') && name !== 'registry.test.ts')
  .map((name) => readFileSync(resolve(testsDir, name), 'utf8'))
  .join('\n');

/**
 * True when a format is exercised somewhere in the suite: as a conversion
 * target, as a detection assertion, or through its engine module being imported
 * and tested directly (which is how the archive engine is covered).
 */
function isCoveredByTests(format: { id: string; readerEngine?: string; writerEngine?: string }): boolean {
  if (allTestSource.includes(`targetFormatId: '${format.id}'`)) return true;
  if (allTestSource.includes(`toBe('${format.id}')`)) return true;
  for (const engine of [format.readerEngine, format.writerEngine]) {
    if (engine && allTestSource.includes(`@engines/${engine}`)) return true;
  }
  return false;
}

describe('format registry integrity', () => {
  it('has unique ids', () => {
    const ids = FORMATS.map((format) => format.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every format at least one extension and a category', () => {
    for (const format of FORMATS) {
      expect(format.extensions.length, `${format.id} has no extension`).toBeGreaterThan(0);
      expect(format.category, `${format.id} has no category`).toBeTruthy();
      expect(format.dataKind, `${format.id} has no data kind`).toBeTruthy();
    }
  });

  it('names a reader engine for every importable format', () => {
    for (const format of FORMATS) {
      if (format.support.import === 'none' || format.support.import === 'adapter') continue;
      expect(format.readerEngine, `${format.id} claims import "${format.support.import}" with no reader engine`).toBeTruthy();
    }
  });

  it('names a writer engine for every exportable format', () => {
    for (const format of FORMATS) {
      if (format.support.export === 'none' || format.support.export === 'adapter') continue;
      expect(format.writerEngine, `${format.id} claims export "${format.support.export}" with no writer engine`).toBeTruthy();
    }
  });

  it('backs every "full" claim with a test', () => {
    const unbacked = FORMATS.filter(
      (format) => (format.support.import === 'full' || format.support.export === 'full') && !isCoveredByTests(format)
    ).map((format) => format.id);
    // Sidecars are exercised through the formats that carry them, so they are
    // named explicitly here rather than being silently exempt.
    const coveredIndirectly = ['worldfile', 'gcp-points', 'prj', 'geojsonseq', 'pts'];
    expect(unbacked.filter((id) => !coveredIndirectly.includes(id))).toEqual([]);
  });

  it('marks every adapter format as needing a native or WASM engine', () => {
    for (const format of FORMATS) {
      if (format.support.import !== 'adapter' && format.support.export !== 'adapter') continue;
      expect(
        format.requiresNative === true || format.requiresWasm === true,
        `${format.id} is an adapter but declares neither requiresNative nor requiresWasm`
      ).toBe(true);
    }
  });

  it('gives every partial or limited format a stated reason', () => {
    for (const format of FORMATS) {
      const limited =
        format.support.import === 'partial' ||
        format.support.export === 'partial' ||
        format.support.import === 'metadata-only' ||
        format.support.import === 'adapter';
      if (!limited) continue;
      const explained = (format.warnings?.length ?? 0) > 0 || Boolean(format.notes);
      expect(explained, `${format.id} is limited but explains nothing to the user`).toBe(true);
    }
  });

  it('requires companion extensions wherever a package format declares them', () => {
    const shapefile = getFormat('shapefile')!;
    expect(shapefile.companions).toEqual(expect.arrayContaining(['shx', 'dbf', 'prj', 'cpg']));
    expect(shapefile.packaging).toBe('zip');
  });
});

describe('honesty invariants', () => {
  it('states which GeoTIFF compressions it decodes and which it refuses', () => {
    // GeoTIFF earned `full` when the codec landed, but "full" must not be read
    // as "every TIFF ever written". The registry has to keep naming the codecs
    // that are absent, because a user whose file is JPEG-compressed needs to
    // know that before they trust the output — not after.
    const geotiff = getFormat('geotiff')!;
    expect(geotiff.support.import).toBe('full');
    expect(geotiff.support.export).toBe('full');
    const text = geotiff.warnings?.join(' ') ?? '';
    expect(text).toMatch(/LZW/i);
    expect(text).toMatch(/Deflate/i);
    expect(text).toMatch(/PackBits/i);
    expect(text).toMatch(/JPEG/i);
    expect(text).toMatch(/refused by name/i);
    // Multi-IFD pyramids and overviews are still out of scope, and saying so is
    // the difference between a documented limit and a surprise.
    expect(geotiff.notes).toMatch(/overview|first image/i);
  });

  it('keeps LAZ an adapter rather than claiming LAS-compatible reads', () => {
    const laz = getFormat('laz')!;
    expect(laz.support.import).toBe('adapter');
    expect(laz.requiresWasm).toBe(true);
    expect(laz.warnings?.join(' ')).toMatch(/never read as uncompressed LAS/i);
  });

  it('keeps DWG native-required and says so', () => {
    const dwg = getFormat('dwg')!;
    expect(dwg.support.import).toBe('adapter');
    expect(dwg.requiresNative).toBe(true);
    expect(dwg.warnings?.join(' ')).toMatch(/renamed DXF is never presented as DWG/i);
  });

  it('hides an adapter format until its engine is actually available', () => {
    const dwg = getFormat('dwg')!;
    expect(isAvailable(dwg, 'import', false)).toBe(false);
    expect(isAvailable(dwg, 'import', true)).toBe(true);
    // A WASM adapter is never "available" from the native-helper flag alone.
    expect(isAvailable(getFormat('laz')!, 'import', true)).toBe(false);
  });

  it('never offers a metadata-only format as an export target', () => {
    for (const format of FORMATS) {
      if (format.support.import !== 'metadata-only') continue;
      expect(isAvailable(format, 'export', true)).toBe(false);
    }
  });
});

describe('target filtering', () => {
  it('offers vector targets for a vector source', () => {
    const targets = exportTargetsFor('vector').map((format) => format.id);
    expect(targets).toEqual(expect.arrayContaining(['geojson', 'dxf', 'shapefile', 'kml', 'wkt']));
  });

  it('offers vector and table targets for a coordinate table', () => {
    const targets = exportTargetsFor('table').map((format) => format.id);
    expect(targets).toEqual(expect.arrayContaining(['geojson', 'dxf', 'csv', 'shapefile']));
  });

  it('offers point-cloud, table and point-vector targets for a cloud', () => {
    const targets = exportTargetsFor('pointcloud').map((format) => format.id);
    expect(targets).toEqual(expect.arrayContaining(['las', 'xyz', 'ply', 'csv']));
    // A point cloud is not offered as a shapefile: millions of point records is
    // not a useful shapefile, and the DBF would exceed its 2 GB limit.
    expect(targets).not.toContain('shapefile');
  });

  it('offers raster targets for a raster source', () => {
    const targets = exportTargetsFor('raster').map((format) => format.id);
    expect(targets).toContain('asciigrid');
    expect(targets).toContain('geotiff');
  });

  it('labels every support level for the UI', () => {
    expect(SUPPORT_LABEL.full).toBe('Supported');
    expect(SUPPORT_LABEL['metadata-only']).toBe('Metadata only');
    expect(SUPPORT_LABEL.adapter).toBe('Adapter required');
  });
});
