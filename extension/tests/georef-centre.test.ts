/**
 * The placement pivot must be findable from either layer shape.
 *
 * THE DEFECT
 *
 * `centreOf` computed the extent with
 *
 *     dataset.layers.flatMap((layer) => layer.features)
 *
 * which is the CIR shape. The workspace's own layers carry `preview` instead —
 * the summarised form the canvas draws — so `layer.features` was `undefined`.
 *
 * The subtle part is what `flatMap` does with that. It flattens ARRAYS; a
 * non-array result is kept as an element. So a two-layer drawing did not
 * produce an empty list, it produced `[undefined, undefined]`, and
 * `featuresBounds` walked straight into
 *
 *     TypeError: Cannot read properties of undefined (reading 'geometry')
 *
 * `centreOf` is the point a placement rotates and scales ABOUT, so this fired
 * every time the georeference panel opened on a local-grid drawing, and no
 * rotate or scale gesture could run. The call site passed the workspace dataset
 * through an `as never` cast, which is what stopped the typechecker saying so.
 *
 * Found by driving the real panel in a headless browser and reading the
 * exceptions — three identical throws on opening the panel — not by a test.
 * This is that test.
 */

import { describe, expect, it } from 'vitest';
import { centreOf, isPlaceableCoordinate } from '../src/workspace/panels/georef';
import type { CirDataset, CirFeature } from '@core/cir';

/** A square whose centre is exactly (x + 30, y + 22.5). */
function square(x: number, y: number): CirFeature {
  return {
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 60, y], [x + 60, y + 45], [x, y + 45], [x, y]]] },
    properties: {},
  } as unknown as CirFeature;
}

/** CIR shape: features on `features`. */
function cirShape(): CirDataset {
  return { layers: [
    { name: 'PARCEL', fields: [], geometryTypes: ['Polygon'], features: [square(0, 0)] },
    { name: 'ROAD', fields: [], geometryTypes: ['Polygon'], features: [square(100, 0)] },
  ] } as unknown as CirDataset;
}

/** Workspace shape: the same geometry, on `preview`. */
function workspaceShape(): CirDataset {
  return { layers: [
    { name: 'PARCEL', fields: [], geometryTypes: ['Polygon'], preview: [square(0, 0)], featureCount: 1 },
    { name: 'ROAD', fields: [], geometryTypes: ['Polygon'], preview: [square(100, 0)], featureCount: 1 },
  ] } as unknown as CirDataset;
}

describe('the placement pivot reads either layer shape', () => {
  it('does not throw on workspace layers, which carry `preview`', () => {
    // The exact crash, with the two layers that made flatMap yield two holes.
    expect(() => centreOf(workspaceShape())).not.toThrow();
  });

  it('returns the true centre rather than merely not throwing', () => {
    // A `?? []` that quietly produced an empty list would pass the test above
    // and return null — a pivot of (0,0), so every rotate would swing the
    // drawing around the origin instead of its own middle. Worse than a crash,
    // because it looks like it worked.
    expect(centreOf(workspaceShape())).toEqual([80, 22.5]);
  });

  it('agrees with the CIR shape, which is the same drawing', () => {
    expect(centreOf(workspaceShape())).toEqual(centreOf(cirShape()));
  });

  it('still returns null for a dataset with no geometry at all', () => {
    expect(centreOf({ layers: [] } as unknown as CirDataset)).toBeNull();
    expect(centreOf(null)).toBeNull();
    expect(centreOf({ layers: [{ name: 'EMPTY', fields: [], geometryTypes: [] }] } as unknown as CirDataset)).toBeNull();
  });
});

/**
 * BLANK IS NOT ZERO.
 *
 * The start-placing guard read `Number(lonText)` and checked it was finite and
 * in range. `Number('')` is `0` — finite, and within every bound — so pressing
 * "Start placing" with the fields empty did not warn. It placed the drawing at
 * 0°N 0°E, resolved UTM zone 31N, and reported a confident
 * "Scale 1.000000 · Rotation 0.0000°" for a site in the Gulf of Guinea.
 *
 * Found while driving the panel in a browser: the target CRS came back as
 * EPSG:32631 when the typed coordinate should have put it in zone 45N.
 */
describe('a placement refuses a coordinate it cannot honestly use', () => {
  it('rejects blank fields rather than reading them as zero', () => {
    expect(isPlaceableCoordinate('', '')).toBe(false);
    expect(isPlaceableCoordinate('85.33', '')).toBe(false);
    expect(isPlaceableCoordinate('', '23.36')).toBe(false);
    expect(isPlaceableCoordinate('   ', '  ')).toBe(false);
  });

  it('still accepts a real site coordinate', () => {
    expect(isPlaceableCoordinate('85.33', '23.36')).toBe(true);
    // Negative and zero are legitimate coordinates when actually typed.
    expect(isPlaceableCoordinate('-0.12', '51.5')).toBe(true);
    expect(isPlaceableCoordinate('0', '0')).toBe(true);
  });

  it('rejects nonsense and out-of-range values', () => {
    expect(isPlaceableCoordinate('east', 'north')).toBe(false);
    expect(isPlaceableCoordinate('181', '0')).toBe(false);
    expect(isPlaceableCoordinate('0', '91')).toBe(false);
  });
});
