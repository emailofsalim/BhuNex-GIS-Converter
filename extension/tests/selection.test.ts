/**
 * The selection engine (phase B).
 *
 * These tests are built around the cases that make a selection WRONG rather
 * than merely absent, because an absent selection is visible and a wrong one is
 * not: a click that takes the parcel around a courtyard instead of nothing, a
 * lasso that catches a line it never touched, a rubber band that quietly grabs
 * the neighbouring plot. Each of those exports a file that looks edited and is
 * edited in the wrong place.
 *
 * The geometry is a small cadastral scene in metres, chosen so every expected
 * answer can be worked out on paper:
 *
 *   · PLOT_A     a 100 m square at the origin
 *   · PLOT_B     a 100 m square 200 m east, so there is a clear gap between them
 *   · COURTYARD  a 100 m square with a 40 m hole in the middle
 *   · ROAD       a line running east across the gap between A and B
 *   · BM1        a single point inside PLOT_A
 */

import { describe, expect, it } from 'vitest';
import type { CirGeometry } from '@core/cir';
import {
  EMPTY_SELECTION,
  type SelectableLayer,
  type Selection,
  combine,
  describeSelection,
  distanceToGeometry,
  hitTest,
  isEmpty,
  scopeFor,
  selectInLasso,
  selectInRectangle,
  selectedLayers,
  selectionBounds,
  toggleWholeLayer,
  truncationWarnings,
} from '@core/selection';

function square(x: number, y: number, size: number): number[][] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}

/** Every geometry here is 2D; `dimension` is required on `CirGeometry`. */
function geom(type: CirGeometry['type'], coordinates: unknown): CirGeometry {
  return { type, coordinates, dimension: 2 };
}

const PLOT_A = geom('Polygon', [square(0, 0, 100)]);
const PLOT_B = geom('Polygon', [square(200, 0, 100)]);
const COURTYARD = geom('Polygon', [square(0, 0, 100), square(30, 30, 40)]);
const ROAD = geom('LineString', [[-50, 150], [350, 150]]);
const BM1 = geom('Point', [50, 50]);

function scene(overrides: Partial<SelectableLayer> = {}): SelectableLayer[] {
  return [
    {
      name: 'parcels',
      features: [{ geometry: PLOT_A }, { geometry: PLOT_B }],
      ...overrides,
    },
    { name: 'roads', features: [{ geometry: ROAD }] },
    { name: 'control', features: [{ geometry: BM1 }] },
  ];
}

describe('distance to a geometry', () => {
  it('is zero anywhere inside a polygon', () => {
    expect(distanceToGeometry([50, 50], PLOT_A)).toBe(0);
    expect(distanceToGeometry([1, 1], PLOT_A)).toBe(0);
  });

  it('is the gap to the nearest edge outside a polygon', () => {
    expect(distanceToGeometry([-10, 50], PLOT_A)).toBeCloseTo(10, 9);
    expect(distanceToGeometry([150, 50], PLOT_A)).toBeCloseTo(50, 9);
  });

  it('is NOT zero in the hole of a polygon', () => {
    // The whole reason `pointInPolygon` exists. A click in a courtyard is
    // outside the building, and the distance is to the courtyard wall.
    expect(distanceToGeometry([50, 50], COURTYARD)).toBeCloseTo(20, 9);
  });

  it('measures to the nearest point on a line, not to its vertices', () => {
    // The nearest vertex is 200 m away along the road; the nearest point on it
    // is 50 m below. A vertex-only implementation gets this wrong by 4x.
    expect(distanceToGeometry([150, 100], ROAD)).toBeCloseTo(50, 9);
  });

  it('measures to a point feature directly', () => {
    expect(distanceToGeometry([50, 60], BM1)).toBeCloseTo(10, 9);
  });

  it('takes the nearest member of a multi-geometry', () => {
    const multi = geom('MultiPoint', [[0, 0], [500, 500]]);
    expect(distanceToGeometry([10, 0], multi)).toBeCloseTo(10, 9);
  });

  it('descends into a geometry collection', () => {
    const collection: CirGeometry = { type: 'GeometryCollection', geometries: [BM1, PLOT_B], dimension: 2 };
    expect(distanceToGeometry([50, 50], collection)).toBe(0);
  });

  it('is infinite for a feature with no geometry', () => {
    expect(distanceToGeometry([0, 0], null)).toBe(Infinity);
  });
});

describe('clicking a feature', () => {
  it('picks the polygon the click landed in', () => {
    const hit = hitTest(scene(), [20, 20], 5);
    expect(hit?.ref).toEqual({ layer: 'parcels', index: 0 });
  });

  it('picks a control point standing inside a parcel, not the parcel', () => {
    // Both are zero distance from a click on the benchmark. The tie-break on
    // extent is what makes the point reachable: a surveyor clicking a benchmark
    // means the benchmark, and the parcel is still selectable everywhere else.
    expect(hitTest(scene(), [50, 50], 5)?.ref).toEqual({ layer: 'control', index: 0 });
  });

  it('picks nothing when the click is outside every tolerance', () => {
    expect(hitTest(scene(), [1000, 1000], 5)).toBeNull();
  });

  it('picks a line the click is near but not on', () => {
    const hit = hitTest(scene(), [100, 152], 5);
    expect(hit?.ref).toEqual({ layer: 'roads', index: 0 });
    expect(hit?.distance).toBeCloseTo(2, 9);
  });

  it('prefers the smaller feature when two contain the click', () => {
    // A small plot drawn inside a big estate. Preferring the larger would make
    // the small one unselectable without hiding a layer.
    const layers: SelectableLayer[] = [
      {
        name: 'mixed',
        features: [
          { geometry: geom('Polygon', [square(0, 0, 1000)]) },
          { geometry: geom('Polygon', [square(400, 400, 50)]) },
        ],
      },
    ];
    expect(hitTest(layers, [420, 420], 1)?.ref.index).toBe(1);
  });

  it('will not pick from a locked layer', () => {
    const layers = scene({ locked: true });
    // The click is inside PLOT_A, but parcels is locked, so the nearest
    // pickable thing is the control point 0 m away — also inside PLOT_A.
    expect(hitTest(layers, [50, 50], 5)?.ref.layer).toBe('control');
  });

  it('will not pick from a hidden layer', () => {
    const layers = scene({ visible: false });
    expect(hitTest(layers, [50, 50], 5)?.ref.layer).toBe('control');
  });

  it('picks nothing at all when every layer is locked', () => {
    const layers = scene().map((layer) => ({ ...layer, locked: true }));
    expect(hitTest(layers, [50, 50], 5)).toBeNull();
  });
});

describe('the rubber band', () => {
  it('catches only what is wholly inside, in contain mode', () => {
    const found = selectInRectangle(scene(), { minX: -10, minY: -10, maxX: 110, maxY: 110 }, 'contain');
    expect(found).toEqual([
      { layer: 'parcels', index: 0 },
      { layer: 'control', index: 0 },
    ]);
  });

  it('leaves a feature that only partly overlaps, in contain mode', () => {
    // Half of PLOT_A. Contain means contain.
    const found = selectInRectangle(scene(), { minX: -10, minY: -10, maxX: 50, maxY: 110 }, 'contain');
    expect(found.some((ref) => ref.layer === 'parcels')).toBe(false);
  });

  it('catches a partly-overlapping feature in intersect mode', () => {
    const found = selectInRectangle(scene(), { minX: -10, minY: -10, maxX: 50, maxY: 110 }, 'intersect');
    expect(found).toContainEqual({ layer: 'parcels', index: 0 });
  });

  it('does not catch a diagonal line whose bounding box overlaps but which misses', () => {
    // The trap a bounds-only implementation falls into: this line's box covers
    // the corner rectangle entirely, and the line passes nowhere near it.
    const layers: SelectableLayer[] = [
      { name: 'diag', features: [{ geometry: geom('LineString', [[0, 0], [100, 100]]) }] },
    ];
    const corner = { minX: 80, minY: 5, maxX: 95, maxY: 20 };
    expect(selectInRectangle(layers, corner, 'intersect')).toEqual([]);
    // Sanity: a box the line really does cross is caught.
    expect(selectInRectangle(layers, { minX: 40, minY: 40, maxX: 60, maxY: 60 }, 'intersect')).toHaveLength(1);
  });

  it('catches a band drawn entirely inside a large parcel', () => {
    const found = selectInRectangle(scene(), { minX: 40, minY: 40, maxX: 60, maxY: 60 }, 'intersect');
    expect(found).toContainEqual({ layer: 'parcels', index: 0 });
  });

  it('takes both plots when the band spans them', () => {
    const found = selectInRectangle(scene(), { minX: -50, minY: -50, maxX: 400, maxY: 50 }, 'intersect');
    expect(found.filter((ref) => ref.layer === 'parcels')).toHaveLength(2);
  });

  it('respects locks', () => {
    const found = selectInRectangle(scene({ locked: true }), { minX: -500, minY: -500, maxX: 500, maxY: 500 }, 'intersect');
    expect(found.some((ref) => ref.layer === 'parcels')).toBe(false);
  });
});

describe('the lasso', () => {
  const around = (x: number, y: number, size: number): number[][] => square(x, y, size);

  it('catches what it encircles', () => {
    const found = selectInLasso(scene(), around(-20, -20, 140), 'intersect');
    expect(found).toContainEqual({ layer: 'parcels', index: 0 });
    expect(found).not.toContainEqual({ layer: 'parcels', index: 1 });
  });

  it('does not catch what sits in the gap of a horseshoe', () => {
    // The case a bounding box gets wrong: this lasso's extent covers PLOT_A,
    // and the lasso itself wraps around it without enclosing it.
    const horseshoe: number[][] = [
      [-40, -40],
      [140, -40],
      [140, -20],
      [-20, -20],
      [-20, 120],
      [140, 120],
      [140, 140],
      [-40, 140],
      [-40, -40],
    ];
    const found = selectInLasso(scene(), horseshoe, 'intersect');
    expect(found).not.toContainEqual({ layer: 'parcels', index: 0 });
  });

  it('catches a line it crosses even with no vertex inside', () => {
    // ROAD runs from x=-50 to x=350 at y=150 with only two vertices, both far
    // outside this lasso. Only a segment-crossing test finds it.
    const found = selectInLasso(scene(), around(100, 100, 100), 'intersect');
    expect(found).toContainEqual({ layer: 'roads', index: 0 });
  });

  it('catches a parcel when the lasso is drawn wholly inside it', () => {
    const found = selectInLasso(scene(), around(40, 40, 20), 'intersect');
    expect(found).toContainEqual({ layer: 'parcels', index: 0 });
  });

  it('requires every vertex inside, in contain mode', () => {
    const partial = selectInLasso(scene(), around(-20, -20, 80), 'contain');
    expect(partial).not.toContainEqual({ layer: 'parcels', index: 0 });
    const whole = selectInLasso(scene(), around(-20, -20, 140), 'contain');
    expect(whole).toContainEqual({ layer: 'parcels', index: 0 });
  });

  it('closes an open lasso ring itself', () => {
    const open: number[][] = [
      [-20, -20],
      [120, -20],
      [120, 120],
      [-20, 120],
    ];
    expect(selectInLasso(scene(), open, 'intersect')).toContainEqual({ layer: 'parcels', index: 0 });
  });

  it('selects nothing from a degenerate lasso', () => {
    expect(selectInLasso(scene(), [[0, 0], [1, 1]], 'intersect')).toEqual([]);
  });
});

describe('combining gestures', () => {
  const a = { layer: 'parcels', index: 0 };
  const b = { layer: 'parcels', index: 1 };

  it('replaces', () => {
    const first = combine(EMPTY_SELECTION, [a], 'replace');
    expect(combine(first, [b], 'replace').refs).toEqual([b]);
  });

  it('adds without duplicating', () => {
    const first = combine(EMPTY_SELECTION, [a], 'add');
    const again = combine(first, [a, b], 'add');
    expect(again.refs).toEqual([a, b]);
  });

  it('toggles a held feature out and a new one in', () => {
    const first = combine(EMPTY_SELECTION, [a, b], 'replace');
    expect(combine(first, [a], 'toggle').refs).toEqual([b]);
  });

  it('subtracts', () => {
    const first = combine(EMPTY_SELECTION, [a, b], 'replace');
    expect(combine(first, [b], 'subtract').refs).toEqual([a]);
  });

  it('drops whole-layer selections when the mode is replace', () => {
    const whole = toggleWholeLayer(EMPTY_SELECTION, 'parcels');
    expect(combine(whole, [a], 'replace').wholeLayers).toEqual([]);
  });

  it('keeps whole-layer selections when the mode is additive', () => {
    const whole = toggleWholeLayer(EMPTY_SELECTION, 'roads');
    expect(combine(whole, [a], 'add').wholeLayers).toEqual(['roads']);
  });

  it('orders the result so two equal selections are equal', () => {
    const one = combine(EMPTY_SELECTION, [b, a], 'replace');
    const two = combine(EMPTY_SELECTION, [a, b], 'replace');
    expect(one.refs).toEqual(two.refs);
  });
});

describe('whole layers, which are not the same as their drawn features', () => {
  it('toggles on and off', () => {
    const on = toggleWholeLayer(EMPTY_SELECTION, 'parcels');
    expect(on.wholeLayers).toEqual(['parcels']);
    expect(toggleWholeLayer(on, 'parcels').wholeLayers).toEqual([]);
  });

  it('clears individual refs in that layer, so no stale narrower scope survives', () => {
    const picked = combine(EMPTY_SELECTION, [{ layer: 'parcels', index: 0 }], 'replace');
    const whole = toggleWholeLayer(picked, 'parcels');
    expect(whole.refs).toEqual([]);
    // And toggling back off leaves nothing, rather than resurrecting the ref.
    expect(isEmpty(toggleWholeLayer(whole, 'parcels'))).toBe(true);
  });

  it('scopes to undefined — every feature — rather than to what was drawn', () => {
    const whole = toggleWholeLayer(EMPTY_SELECTION, 'parcels');
    // This is the assertion the index trap turns on. `undefined` means "all"
    // to planGeometryOperation; a list of preview indices means "these 5,000".
    expect(scopeFor(whole, 'parcels')).toBeUndefined();
  });

  it('scopes a hand-picked selection to sorted indices', () => {
    const picked: Selection = {
      refs: [
        { layer: 'parcels', index: 5 },
        { layer: 'parcels', index: 1 },
        { layer: 'roads', index: 0 },
      ],
      wholeLayers: [],
    };
    expect(scopeFor(picked, 'parcels')).toEqual([1, 5]);
  });

  it('returns null for a layer that is not selected at all', () => {
    // Not `[]`, which would refuse, and not `undefined`, which would silently
    // take the whole layer. Null says "do not run this here".
    expect(scopeFor(EMPTY_SELECTION, 'parcels')).toBeNull();
  });

  it('lists every layer touched, by either route', () => {
    const mixed: Selection = { refs: [{ layer: 'roads', index: 0 }], wholeLayers: ['parcels'] };
    expect(selectedLayers(mixed)).toEqual(['parcels', 'roads']);
  });
});

describe('saying so when the canvas only drew part of a layer', () => {
  const truncated: SelectableLayer[] = [
    { name: 'parcels', features: [{ geometry: PLOT_A }, { geometry: PLOT_B }], truncated: true, featureCount: 40_000 },
  ];

  it('warns when a gesture picked from a truncated layer', () => {
    const picked = combine(EMPTY_SELECTION, [{ layer: 'parcels', index: 0 }], 'replace');
    const warnings = truncationWarnings(picked, truncated);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('40,000');
    expect(warnings[0]).toContain('Select whole layer');
  });

  it('does not warn when the whole layer was taken', () => {
    const whole = toggleWholeLayer(EMPTY_SELECTION, 'parcels');
    expect(truncationWarnings(whole, truncated)).toEqual([]);
  });

  it('does not warn about a layer that was fully drawn', () => {
    const picked = combine(EMPTY_SELECTION, [{ layer: 'parcels', index: 0 }], 'replace');
    expect(truncationWarnings(picked, scene())).toEqual([]);
  });
});

describe('reporting the selection', () => {
  it('bounds what is selected', () => {
    const picked = combine(EMPTY_SELECTION, [{ layer: 'parcels', index: 1 }], 'replace');
    expect(selectionBounds(picked, scene())).toEqual({ minX: 200, minY: 0, maxX: 300, maxY: 100 });
  });

  it('spans both plots when both are selected', () => {
    const picked = combine(
      EMPTY_SELECTION,
      [
        { layer: 'parcels', index: 0 },
        { layer: 'parcels', index: 1 },
      ],
      'replace'
    );
    expect(selectionBounds(picked, scene())).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: 100 });
  });

  it('has no bounds when nothing is selected', () => {
    expect(selectionBounds(EMPTY_SELECTION, scene())).toBeNull();
  });

  it('describes nothing as nothing', () => {
    expect(describeSelection(EMPTY_SELECTION, scene())).toBe('Nothing selected');
  });

  it('counts features in the singular and the plural', () => {
    const one = combine(EMPTY_SELECTION, [{ layer: 'parcels', index: 0 }], 'replace');
    expect(describeSelection(one, scene())).toBe('1 feature');
    const two = combine(one, [{ layer: 'parcels', index: 1 }], 'add');
    expect(describeSelection(two, scene())).toBe('2 features');
  });

  it('says when a selection crosses layers', () => {
    const across = combine(
      EMPTY_SELECTION,
      [
        { layer: 'parcels', index: 0 },
        { layer: 'roads', index: 0 },
      ],
      'replace'
    );
    expect(describeSelection(across, scene())).toContain('across 2 layers');
  });

  it('reports a whole layer by its true feature count, not its drawn one', () => {
    const layers: SelectableLayer[] = [
      { name: 'parcels', features: [{ geometry: PLOT_A }], truncated: true, featureCount: 40_000 },
    ];
    const whole = toggleWholeLayer(EMPTY_SELECTION, 'parcels');
    expect(describeSelection(whole, layers)).toContain('40,000');
  });
});
