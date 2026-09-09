/**
 * Drawing, snapping and digitising (phases F and K).
 *
 * The property these tests exist for is one sentence long: a snapped vertex is
 * EXACTLY the stored coordinate, not one near it. A snap that rounds produces a
 * boundary that looks deliberate, passes every visual check, and is off by
 * whatever the pointer happened to be — which is strictly worse than no snap at
 * all, because nobody goes back and checks a boundary that looks right.
 *
 * So the coordinates here are deliberately awkward. A UTM easting with six
 * decimals cannot survive a rounding step, and comparing it exactly is the
 * whole assertion.
 */

import { describe, expect, it } from 'vitest';
import type { CirGeometry, Position } from '@core/cir';
import {
  buildDrawnFeature,
  constrainAngle,
  constrainOrtho,
  DEFAULT_SNAP_SETTINGS,
  DRAW_LABEL,
  type DrawKind,
  findSnapTarget,
  MIN_VERTICES,
  pointsInsideRing,
  pointSnapSources,
  SNAP_KIND_LABEL,
  type SnapSource,
} from '@core/drawing';

/** Observed survey points, with the precision a total station actually gives. */
const BM1: Position = [412345.678, 2591234.567];
const BM2: Position = [412445.123, 2591334.891];
const BM3: Position = [412545.901, 2591234.007];

function geom(type: CirGeometry['type'], coordinates: unknown): CirGeometry {
  return { type, coordinates, dimension: 2 };
}

const CONTROL: SnapSource = {
  name: 'control',
  features: [{ geometry: geom('Point', BM1) }, { geometry: geom('Point', BM2) }, { geometry: geom('Point', BM3) }],
};

const PARCEL: SnapSource = {
  name: 'parcels',
  features: [
    {
      geometry: geom('Polygon', [
        [
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100],
          [0, 0],
        ],
      ]),
    },
  ],
};

describe('snapping to an observed point', () => {
  it('returns the stored coordinate exactly, not a rounded one', () => {
    // The pointer is 30 mm away. The vertex must land on the OBSERVED value.
    const target = findSnapTarget([CONTROL], [412345.708, 2591234.577], 1);
    expect(target).not.toBeNull();
    expect(target!.position[0]).toBe(412345.678);
    expect(target!.position[1]).toBe(2591234.567);
  });

  it('returns a copy, so a later edit cannot reach back into the source', () => {
    const target = findSnapTarget([CONTROL], [412345.678, 2591234.567], 1)!;
    target.position[0] = 0;
    expect((CONTROL.features[0].geometry!.coordinates as Position)[0]).toBe(412345.678);
  });

  it('takes the nearest of several candidates', () => {
    const target = findSnapTarget([CONTROL], [412444, 2591334], 5)!;
    expect(target.position).toEqual(BM2);
  });

  it('finds nothing beyond the tolerance, so the pointer position stands', () => {
    expect(findSnapTarget([CONTROL], [412345.678, 2591234.567], 0)).not.toBeNull();
    expect(findSnapTarget([CONTROL], [500000, 2591234.567], 1)).toBeNull();
  });

  it('names which layer the target came from', () => {
    expect(findSnapTarget([CONTROL], BM1, 1)!.layer).toBe('control');
  });

  it('will not snap to a layer marked unusable', () => {
    expect(findSnapTarget([{ ...CONTROL, usable: false }], BM1, 1)).toBeNull();
  });
});

describe('which snap wins', () => {
  const line: SnapSource = {
    name: 'lines',
    features: [{ geometry: geom('LineString', [[0, 0], [10, 0]]) }],
  };

  it('calls the ends of an open line endpoints, and interior ones vertices', () => {
    const middle: SnapSource = {
      name: 'lines',
      features: [{ geometry: geom('LineString', [[0, 0], [5, 0], [10, 0]]) }],
    };
    expect(findSnapTarget([middle], [0, 0.01], 1)!.kind).toBe('endpoint');
    expect(findSnapTarget([middle], [5, 0.01], 1)!.kind).toBe('vertex');
  });

  it('prefers a vertex over a midpoint at exactly the same distance', () => {
    // A real tie, worked out rather than assumed: on the segment (0,0)→(4,0)
    // the midpoint is (2,0), and a pointer at (1,3) is √10 from BOTH (0,0) and
    // (2,0). Without the tie-break the answer depends on iteration order,
    // which is to say on nothing — and taking the midpoint would silently
    // prefer a COMPUTED coordinate over an observed one.
    const segment: SnapSource = {
      name: 'lines',
      features: [{ geometry: geom('LineString', [[0, 0], [4, 0]]) }],
    };
    const target = findSnapTarget([segment], [1, 3], 5, { vertex: true, midpoint: true, segment: false })!;
    expect(Math.hypot(1 - 0, 3 - 0)).toBeCloseTo(Math.hypot(1 - 2, 3 - 0), 12);
    expect(target.position).toEqual([0, 0]);
    expect(target.kind).toBe('endpoint');
  });

  it('still takes a midpoint that is genuinely closer than any vertex', () => {
    // The tie-break must not become a preference: on a short segment the
    // midpoint really is nearer, and refusing it would make the option useless.
    const short: SnapSource = {
      name: 'lines',
      features: [{ geometry: geom('LineString', [[0, 0], [2, 0]]) }],
    };
    const target = findSnapTarget([short], [1, 1], 5, { vertex: true, midpoint: true, segment: false })!;
    expect(target.kind).toBe('midpoint');
    expect(target.position).toEqual([1, 0]);
  });

  it('offers a midpoint only when asked', () => {
    expect(findSnapTarget([line], [5, 0.01], 1, DEFAULT_SNAP_SETTINGS)).toBeNull();
    const withMid = findSnapTarget([line], [5, 0.01], 1, { vertex: true, midpoint: true, segment: false });
    expect(withMid!.kind).toBe('midpoint');
    expect(withMid!.position).toEqual([5, 0]);
  });

  it('offers a point anywhere along a segment only when asked', () => {
    expect(findSnapTarget([line], [3, 0.01], 1, DEFAULT_SNAP_SETTINGS)).toBeNull();
    const along = findSnapTarget([line], [3, 0.01], 1, { vertex: false, midpoint: false, segment: true })!;
    expect(along.kind).toBe('segment');
    expect(along.position[0]).toBeCloseTo(3, 9);
    expect(along.position[1]).toBeCloseTo(0, 9);
  });

  it('snaps to a grid when one is set', () => {
    const target = findSnapTarget([], [10.3, 19.8], 5, { vertex: false, midpoint: false, segment: false, grid: 5 })!;
    expect(target.position).toEqual([10, 20]);
    expect(target.kind).toBe('grid');
  });

  it('finds polygon corners, which are what a parcel is clicked by', () => {
    expect(findSnapTarget([PARCEL], [100.1, 99.9], 1)!.position).toEqual([100, 100]);
  });

  it('labels every snap kind, so the readout can name what it took', () => {
    for (const kind of ['vertex', 'endpoint', 'midpoint', 'segment', 'grid'] as const) {
      expect(SNAP_KIND_LABEL[kind]).toBeTruthy();
    }
  });
});

describe('the ortho constraint', () => {
  it('keeps the axis travelled furthest along', () => {
    expect(constrainOrtho([0, 0], [10, 3])).toEqual([10, 0]);
    expect(constrainOrtho([0, 0], [3, 10])).toEqual([0, 10]);
  });

  it('does not flicker at exactly 45 degrees', () => {
    expect(constrainOrtho([0, 0], [10, 10])).toEqual([10, 0]);
  });
});

describe('the angle constraint', () => {
  it('rounds the bearing to the step and keeps the distance exactly', () => {
    // 30 m at 47°, snapped to 15° steps, must be 30 m at 45°.
    const from: Position = [0, 0];
    const angle = (47 * Math.PI) / 180;
    const to: Position = [30 * Math.cos(angle), 30 * Math.sin(angle)];
    const snapped = constrainAngle(from, to, 15);
    expect(Math.hypot(snapped[0], snapped[1])).toBeCloseTo(30, 9);
    expect((Math.atan2(snapped[1], snapped[0]) * 180) / Math.PI).toBeCloseTo(45, 9);
  });

  it('leaves the point alone for a nonsensical step', () => {
    expect(constrainAngle([0, 0], [3, 7], 0)).toEqual([3, 7]);
    expect(constrainAngle([0, 0], [3, 7], Number.NaN)).toEqual([3, 7]);
  });

  it('leaves a zero-length placement alone rather than returning NaN', () => {
    expect(constrainAngle([5, 5], [5, 5], 15)).toEqual([5, 5]);
  });
});

describe('building what was drawn', () => {
  it('makes a point from one click', () => {
    const { result } = buildDrawnFeature('point', [BM1]);
    expect(result!.feature.geometry).toEqual({ type: 'Point', coordinates: BM1, dimension: 2 });
  });

  it('makes a line from two', () => {
    const { result } = buildDrawnFeature('line', [BM1, BM2]);
    expect(result!.feature.geometry!.type).toBe('LineString');
    expect(result!.feature.geometry!.coordinates).toEqual([BM1, BM2]);
  });

  it('closes a polygon ring itself', () => {
    const { result } = buildDrawnFeature('polygon', [BM1, BM2, BM3]);
    const ring = (result!.feature.geometry!.coordinates as Position[][])[0];
    expect(ring).toHaveLength(4);
    expect(ring[3]).toEqual(ring[0]);
  });

  it('preserves the observed coordinates through to the ring, bit for bit', () => {
    // The whole point of the feature. A rounding anywhere in this path is the
    // failure the digitising mode exists to prevent.
    const ring = (buildDrawnFeature('polygon', [BM1, BM2, BM3]).result!.feature.geometry!.coordinates as Position[][])[0];
    expect(ring[0][0]).toBe(412345.678);
    expect(ring[1][1]).toBe(2591334.891);
    expect(ring[2][0]).toBe(412545.901);
  });

  it('refuses a polygon with two corners rather than writing degenerate geometry', () => {
    const { refusal } = buildDrawnFeature('polygon', [BM1, BM2]);
    expect(refusal).toBeDefined();
    expect(refusal!.what).toContain('3 points');
  });

  it('refuses a line with one point', () => {
    expect(buildDrawnFeature('line', [BM1]).refusal).toBeDefined();
  });

  it('drops the duplicate a double-click leaves, and says so', () => {
    const { result, refusal } = buildDrawnFeature('polygon', [BM1, BM2, BM3, BM3]);
    expect(refusal).toBeUndefined();
    const ring = (result!.feature.geometry!.coordinates as Position[][])[0];
    expect(ring).toHaveLength(4);
    expect(result!.notes.join(' ')).toContain('duplicate');
  });

  it('refuses when the duplicates leave too few distinct corners, and says which', () => {
    const { refusal } = buildDrawnFeature('polygon', [BM1, BM1, BM2, BM2]);
    expect(refusal).toBeDefined();
    expect(refusal!.why).toContain('on top of one another');
  });

  it('reports a self-crossing ring rather than repairing it', () => {
    // A bowtie. Which crossing was intended is a drafting decision, so the
    // shape is kept as drawn and the QA scan reports it.
    const bowtie: Position[] = [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ];
    const { result } = buildDrawnFeature('polygon', bowtie);
    expect(result!.notes.join(' ')).toContain('crosses itself');
  });

  it('needs text before it will place any', () => {
    expect(buildDrawnFeature('text', [BM1]).refusal).toBeDefined();
    expect(buildDrawnFeature('text', [BM1], { text: '   ' }).refusal).toBeDefined();
    const { result } = buildDrawnFeature('text', [BM1], { text: 'Plot 784' });
    expect(result!.feature.properties.text).toBe('Plot 784');
  });

  it('says out loud that text becomes a point attribute', () => {
    const { result } = buildDrawnFeature('text', [BM1], { text: 'Plot 784' });
    expect(result!.feature.geometry!.type).toBe('Point');
    expect(result!.notes.join(' ')).toContain('No vector GIS format has a text primitive');
  });

  it('names a marker', () => {
    const { result } = buildDrawnFeature('marker', [BM1], { name: 'Station A' });
    expect(result!.feature.properties.name).toBe('Station A');
  });

  it('keeps Z when the clicked positions carry it', () => {
    const { result } = buildDrawnFeature('line', [[0, 0, 412.3], [10, 0, 413.1]]);
    expect(result!.feature.geometry!.dimension).toBe(3);
  });

  it('gives every kind a label and a minimum', () => {
    for (const kind of ['point', 'marker', 'line', 'polygon', 'text'] as DrawKind[]) {
      expect(DRAW_LABEL[kind]).toBeTruthy();
      expect(MIN_VERTICES[kind]).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('digitising from a survey CSV (phase K)', () => {
  it('narrows the snap sources to layers holding points', () => {
    const sources = pointSnapSources([CONTROL, PARCEL]);
    expect(sources.map((source) => source.name)).toEqual(['control']);
  });

  it('digitises a boundary whose every vertex is an observed coordinate', () => {
    // The whole workflow: click each imported point in turn, with snapping on.
    const clicks: Position[] = [];
    for (const near of [
      [412345.7, 2591234.6],
      [412445.1, 2591334.9],
      [412545.9, 2591234.0],
    ] as Position[]) {
      const target = findSnapTarget([CONTROL], near, 1);
      clicks.push(target ? target.position : near);
    }
    expect(clicks).toEqual([BM1, BM2, BM3]);

    const ring = (buildDrawnFeature('polygon', clicks).result!.feature.geometry!.coordinates as Position[][])[0];
    expect(ring.slice(0, 3)).toEqual([BM1, BM2, BM3]);
  });

  it('reports an imported point stranded inside a ring that was closed early', () => {
    const missed: SnapSource = {
      name: 'control',
      features: [
        { geometry: geom('Point', [0, 0]) },
        { geometry: geom('Point', [100, 0]) },
        { geometry: geom('Point', [100, 100]) },
        { geometry: geom('Point', [0, 100]) },
        // The one that was skipped, sitting well inside the ring drawn without it.
        { geometry: geom('Point', [50, 50]) },
      ],
    };
    const clicked: Position[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const ring = [...clicked, clicked[0]];
    expect(pointsInsideRing(ring, [missed], clicked)).toBe(1);
  });

  it('does not count the points that were clicked', () => {
    const clicked: Position[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const ring = [...clicked, clicked[0]];
    const exact: SnapSource = { name: 'control', features: clicked.map((p) => ({ geometry: geom('Point', p) })) };
    expect(pointsInsideRing(ring, [exact], clicked)).toBe(0);
  });

  it('counts nothing when every point is outside', () => {
    const clicked: Position[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const ring = [...clicked, clicked[0]];
    const far: SnapSource = { name: 'control', features: [{ geometry: geom('Point', [500, 500]) }] };
    expect(pointsInsideRing(ring, [far], clicked)).toBe(0);
  });
});
