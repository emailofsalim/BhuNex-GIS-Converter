/**
 * Saving a georeference that was just made (§28.3).
 *
 * WHAT WAS MISSING
 *
 * The backdrop panel could already load a scanned sheet or a PDF page, place
 * ground control points on it, fit an affine, and report the residual at every
 * point. Then its own opening sentence said what happened next: "it is never
 * converted, never exported". A surveyor who georeferenced a cadastral sheet
 * against four known corners could look at the result and had no way to keep
 * it. Close the tab and the work was gone.
 *
 * Every engine it needed was in the tree and reachable only from the
 * conversion pipeline, which handles rasters that ARRIVED georeferenced —
 * `buildWorldFile`, `worldFileExtensionFor`, `writeGcpPoints`, `buildPrj`. The
 * one place in the product where a georeference is CREATED called none of them.
 *
 * WHY THE TERM ORDER GETS ITS OWN TESTS
 *
 * A world file is six bare numbers with no labels. Transpose one pair and the
 * file is still valid, still loads, and puts the scan somewhere wrong — with
 * no error anywhere. The only defence is asserting the round trip: take a
 * known affine, write it, read it back, and check the corners land where the
 * affine says they should.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { geotransformFromAffine, georeferenceFiles } from '../src/core/georeference-save';
import { applyAffine, type Affine, type Gcp } from '../src/core/georeference';
import { parseWorldFile, worldFileToGeotransform } from '../src/engines/raster/worldfile';
import { crsFromEpsg } from '../src/crs/epsg';

/** A north-up scan: 0.5 m pixels, origin at 412300 / 2591230, rows running south. */
const NORTH_UP: Affine = { a: 0.5, b: 0, c: 412300, d: 0, e: -0.5, f: 2591230 };

/**
 * A sheared scan — and the fixture every term-order assertion below uses.
 *
 * NOT an arbitrary choice. A pure rotation with the row flip an image needs
 * produces b === d exactly (X = s·cosθ·u + s·sinθ·v, Y = s·sinθ·u − s·cosθ·v),
 * so a rotated-but-unsheared fixture cannot detect the two skew terms being
 * transposed — the transposition is a no-op on it. The first draft of this
 * suite used one, and a deliberately transposed `geotransformFromAffine`
 * passed all ten tests.
 *
 * So the fixture has all six coefficients distinct: a ≠ e, b ≠ d, c ≠ f. Any
 * pair swapped anywhere in the chain now moves a corner. It is also the
 * realistic case rather than a contrived one: paper and scanner feeds stretch
 * unevenly along one axis, which is shear, and is the whole reason the
 * three-point affine fit exists beside the two-point similarity.
 */
const SHEARED: Affine = { a: 0.4924, b: 0.0868, c: 412300, d: 0.0631, e: -0.5107, f: 2591230 };

describe('the six numbers, in the order a world file means them', () => {
  it('puts each term where GDAL expects it', () => {
    // [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight]
    expect(geotransformFromAffine(SHEARED)).toEqual([412300, 0.4924, 0.0868, 2591230, 0.0631, -0.5107]);
  });

  it('survives a write and a read with the corners in the same place', () => {
    // The assertion that catches a transposed pair. A world file is six
    // unlabelled numbers: swap two and it still parses, still loads, and puts
    // the scan somewhere wrong with no error anywhere.
    for (const affine of [NORTH_UP, SHEARED]) {
      const [file] = georeferenceFiles({ imageName: 'sheet.tif', affine, crs: null, gcps: [] });
      const round = worldFileToGeotransform(parseWorldFile(file.text));

      // Four corners of a 1000x800 scan, through the original affine and
      // through the affine the file round-tripped to.
      for (const [u, v] of [
        [0, 0],
        [1000, 0],
        [0, 800],
        [1000, 800],
      ]) {
        const expected = applyAffine(affine, u, v);
        const actual = [round[0] + round[1] * u + round[2] * v, round[3] + round[4] * u + round[5] * v];
        expect(actual[0]).toBeCloseTo(expected[0], 6);
        expect(actual[1]).toBeCloseTo(expected[1], 6);
      }
    }
  });

  it('keeps the skew terms, each on its own line, rather than flattening to north-up', () => {
    // A scanned sheet is always a little rotated and usually sheared. Dropping
    // the skew would line the image up in the middle and leave it metres out
    // at the corners — convincing exactly where a user looks first.
    //
    // Line 2 is the Y-per-column term and line 3 is the X-per-row term. They
    // are asserted by value, not merely as non-zero, because "both non-zero"
    // is equally true of a file that has them the wrong way round.
    const [file] = georeferenceFiles({ imageName: 'sheet.tif', affine: SHEARED, crs: null, gcps: [] });
    const terms = parseWorldFile(file.text);
    expect(terms.d).toBeCloseTo(SHEARED.d, 9);
    expect(terms.b).toBeCloseTo(SHEARED.b, 9);
  });
});

describe('the files that make a scan open in QGIS', () => {
  it('names the world file for the image it binds to', () => {
    // A world file is associated with its image BY FILENAME and nothing else.
    // This project has shipped that bug once already: every world file was
    // named .tfw whatever the image was, so none of them bound to a JPEG.
    const cases: [string, string][] = [
      ['sheet.tif', 'sheet.tfw'],
      ['sheet.jpg', 'sheet.jgw'],
      ['sheet.png', 'sheet.pgw'],
      ['plan.gif', 'plan.gfw'],
      ['plan.bmp', 'plan.bpw'],
    ];
    for (const [image, world] of cases) {
      const [file] = georeferenceFiles({ imageName: image, affine: NORTH_UP, crs: null, gcps: [] });
      expect(file.name, `${image} should bind to ${world}`).toBe(world);
    }
  });

  it('writes a .prj when the CRS is known', () => {
    const files = georeferenceFiles({ imageName: 'sheet.tif', affine: NORTH_UP, crs: crsFromEpsg(32645), gcps: [] });
    const prj = files.find((file) => file.role === 'projection');
    expect(prj?.name).toBe('sheet.prj');
    // ESRI WKT1, which is what ArcGIS is fussy about and QGIS accepts too.
    expect(prj!.text).toMatch(/PROJCS|GEOGCS/);
  });

  it('writes NO .prj when no coordinate system was stated', () => {
    // The transform is real, but without a CRS the numbers have no frame.
    // Inventing one would be the tool claiming a fact about someone's survey.
    const files = georeferenceFiles({ imageName: 'sheet.tif', affine: NORTH_UP, crs: null, gcps: [] });
    expect(files.some((file) => file.role === 'projection')).toBe(false);
  });

  it('keeps the control points, so the work can be reopened and corrected', () => {
    const gcps: Gcp[] = [
      { pixel: { u: 100, v: 120 }, ground: [412350, 2591170], name: 'NW pillar' },
      { pixel: { u: 900, v: 130 }, ground: [412750, 2591165], name: 'NE pillar' },
      { pixel: { u: 880, v: 700 }, ground: [412740, 2590880], name: 'SE pillar' },
    ];
    const files = georeferenceFiles({ imageName: 'sheet.tif', affine: NORTH_UP, crs: null, gcps });
    const points = files.find((file) => file.role === 'control points');

    expect(points?.name).toBe('sheet.points');
    // QGIS's own georeferencer format, so the points reopen there.
    expect(points!.text.split('\n')[0]).toMatch(/mapX/);
    expect(points!.text).toContain('412350');
  });

  it('omits the points file when the placement came from no control points', () => {
    const files = georeferenceFiles({ imageName: 'sheet.tif', affine: NORTH_UP, crs: null, gcps: [] });
    expect(files.some((file) => file.role === 'control points')).toBe(false);
  });

  it('handles an image whose name carries no extension', () => {
    const [file] = georeferenceFiles({ imageName: 'scan', affine: NORTH_UP, crs: null, gcps: [] });
    expect(file.name.startsWith('scan.')).toBe(true);
  });
});

/**
 * `saveSection`'s body with every comment removed.
 *
 * These assertions are about the ORDER of statements — a guard must return
 * before any file is built — and a comment that happens to name the call is
 * indistinguishable from the call itself to `indexOf`. That is not a
 * hypothetical: the guard below is explained in a comment that mentions
 * `georeferenceFiles('')`, and with comments left in, the ordering assertions
 * matched THAT and failed against code which was in fact correct. Prose cannot
 * satisfy these, and cannot defeat them either.
 */
function saveSectionCode(): string {
  const panel = readFileSync(new URL('../src/workspace/panels/backdrop-tab.ts', import.meta.url), 'utf8');
  const body = panel.slice(
    panel.indexOf('function saveSection'),
    panel.indexOf('// ------------------------------------------------------------------ report')
  );
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('the panel refuses to save a placement that states no position', () => {
  it('holds the refusal in the source, where the button is', () => {
    // A two-point placement fixes scale and rotation and knows NOTHING about
    // absolute position. A world file IS the claim "this image is at these
    // coordinates", and a GIS reading one cannot tell the position was never
    // established — so the button must not offer it. Asserted against the
    // source because the branch is in a DOM builder and this suite has no DOM.
    const save = saveSectionCode();
    expect(save, 'saveSection could not be located').not.toBe('');
    expect(save).toMatch(/placement\.georeferenced/);
    expect(save).toMatch(/cannot be saved as a georeference/);
    // And it must return BEFORE building any files.
    expect(save.indexOf('!placement.georeferenced')).toBeLessThan(save.indexOf('= georeferenceFiles('));
  });

  it('refuses before an image exists for the world file to be named after', () => {
    // Belt and braces, and labelled as such: `backdropTab` returns before the
    // whole placement UI when no image is loaded, so this branch cannot fire
    // today. It is pinned because the failure it prevents is silent — see the
    // next test for what an empty name actually produces.
    const save = saveSectionCode();
    expect(save).toMatch(/getSource\(\)/);
    expect(save.indexOf('!state.fileName')).toBeLessThan(save.indexOf('= georeferenceFiles('));
  });

  it('would have produced that dotfile without the guard', () => {
    // The reason the guard is there, stated as arithmetic rather than as a
    // worry. If this ever stops being true the guard can go.
    const [file] = georeferenceFiles({ imageName: '', affine: NORTH_UP, crs: null, gcps: [] });
    expect(file.name).toBe('.wld');
    expect(file.name.startsWith('.')).toBe(true);
  });
});
