/**
 * QA catalogue, topology rules and repair (spec §23, §24).
 *
 * The fixtures are built to be unambiguous: a sliver that is genuinely thin
 * rather than merely small, a spike whose interior angle is measurably tiny, an
 * overlap of a stated size. That matters because every detector here is
 * threshold-driven, and a test that passes on a borderline fixture would tell
 * us nothing about whether the threshold is in the right place.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type Position, type SourceInfo } from '@core/cir';
import { SpatialIndex, boundsIntersect, expandBounds } from '@core/spatial-index';
import { DEFAULT_DEFECT_OPTIONS, scanDefects, type DefectType } from '@qa/defects';
import { evaluateRule, evaluateRules, type TopologyRule } from '@qa/rules';
import {
  DEFAULT_REPAIR_SETTINGS,
  applyRepair,
  describePlan,
  fixSafeIssues,
  planRepair,
  undoRepair,
} from '@qa/repair';
import { crsFromEpsg } from '@crs/epsg';

const SOURCE: SourceInfo = { fileName: 'parcels.dxf', size: 0, formatId: 'dxf', formatName: 'AutoCAD DXF', detectionConfidence: 1 };

function polygon(id: string, ring: Position[], holes: Position[][] = []): CirFeature {
  return { id, geometry: { type: 'Polygon', coordinates: [ring, ...holes], dimension: 2 }, properties: {} };
}

function line(id: string, path: Position[]): CirFeature {
  return { id, geometry: { type: 'LineString', coordinates: path, dimension: 2 }, properties: {} };
}

function dataset(layers: { name: string; features: CirFeature[] }[]): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'site',
    source: SOURCE,
    crs: crsFromEpsg(32645),
    crsOrigin: 'declared',
    layers: layers.map((entry) => createLayer(entry.name, entry.features)),
  });
}

/** A closed square, counter-clockwise, at the given origin. */
function square(x: number, y: number, size: number): Position[] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
}

function types(defects: { type: DefectType }[]): DefectType[] {
  return [...new Set(defects.map((defect) => defect.type))];
}

// ---------------------------------------------------------------------------

describe('spatial index', () => {
  it('finds every item whose box meets the query, and no others', () => {
    const items = [
      { bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, value: 'a' },
      { bounds: { minX: 20, minY: 20, maxX: 30, maxY: 30 }, value: 'b' },
      { bounds: { minX: 5, minY: 5, maxX: 25, maxY: 25 }, value: 'c' },
    ];
    const index = new SpatialIndex(items);
    const hits = index.search({ minX: 0, minY: 0, maxX: 6, maxY: 6 }).map((position) => index.item(position).value);
    expect(hits.sort()).toEqual(['a', 'c']);
  });

  it('keeps an item that spans the whole extent findable', () => {
    // A lease boundary covering everything would land in every cell, so it goes
    // in the oversized list instead. It must still be found.
    const items = [
      { bounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }, value: 'lease' },
      ...Array.from({ length: 400 }, (_, index) => ({
        bounds: { minX: index, minY: index, maxX: index + 0.5, maxY: index + 0.5 },
        value: `p${index}`,
      })),
    ];
    const index = new SpatialIndex(items);
    const hits = index.search({ minX: 10, minY: 10, maxX: 11, maxY: 11 }).map((position) => index.item(position).value);
    expect(hits).toContain('lease');
  });

  it('visits each candidate pair once, not twice', () => {
    const items = Array.from({ length: 5 }, () => ({ bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, value: 0 }));
    const index = new SpatialIndex(items);
    const seen: string[] = [];
    index.eachCandidatePair((left, right) => seen.push(`${left}-${right}`));
    expect(seen).toHaveLength(10); // 5 choose 2, not 20
    expect(new Set(seen).size).toBe(10);
  });

  it('grows a box symmetrically for a tolerance query', () => {
    const grown = expandBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 2);
    expect(grown).toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 12 });
    expect(boundsIntersect(grown, { minX: -1, minY: -1, maxX: 0, maxY: 0 })).toBe(true);
  });
});

describe('defect catalogue — shape', () => {
  it('flags a thin sliver but not a small compact parcel', () => {
    // 0.1 x 40 strip: small area, huge perimeter — a digitising artefact.
    const sliver = polygon('strip', [
      [0, 0],
      [40, 0],
      [40, 0.01],
      [0, 0.01],
      [0, 0],
    ]);
    // A 0.6 x 0.6 monument pad: also small, but compact and entirely valid.
    const pad = polygon('pad', square(100, 100, 0.6));

    const found = scanDefects(dataset([{ name: 'Parcels', features: [sliver, pad] }])).defects;
    const slivers = found.filter((defect) => defect.type === 'sliver-polygon');
    expect(slivers).toHaveLength(1);
    expect(slivers[0].featureId).toBe('strip');
    // The measurement is in the sentence, not just a verdict.
    expect(slivers[0].description).toMatch(/thinness/);
  });

  it('flags a spike by its interior angle, wherever it points', () => {
    const spiked = line('road', [
      [0, 0],
      [10, 0],
      [10.02, 30], // out...
      [10.04, 0], // ...and straight back
      [20, 0],
    ]);
    const defects = scanDefects(dataset([{ name: 'Roads', features: [spiked] }])).defects;
    const spikes = defects.filter((defect) => defect.type === 'spike');
    expect(spikes.length).toBeGreaterThan(0);
    expect(spikes[0].location).toBeDefined();
    expect(spikes[0].description).toMatch(/°/);
  });

  it('flags a bow-tie and says the area is wrong', () => {
    const bowtie = polygon('bowtie', [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
      [0, 0],
    ]);
    const defects = scanDefects(dataset([{ name: 'Parcels', features: [bowtie] }])).defects;
    const found = defects.find((defect) => defect.type === 'bow-tie');
    expect(found?.severity).toBe('error');
    expect(found?.description).toMatch(/not the area it encloses/);
  });

  it('flags a hole that escapes its shell', () => {
    const bad = polygon('plot', square(0, 0, 10), [square(50, 50, 2)]);
    const defects = scanDefects(dataset([{ name: 'Parcels', features: [bad] }])).defects;
    const found = defects.find((defect) => defect.type === 'hole-outside-shell');
    expect(found?.severity).toBe('error');
    expect(found?.suggestedRepair).toMatch(/separate polygon/);
  });

  it('flags a transposed decimal point in an elevation', () => {
    // Eleven benchmarks around 412 m and one keyed as 4123.45 — the classic
    // blunder, invisible in plan view.
    const benchmark = (id: string, x: number, z: number): CirFeature => ({
      id,
      geometry: { type: 'Point', coordinates: [x, 0, z], dimension: 3 },
      properties: {},
    });
    const features = Array.from({ length: 11 }, (_, index) => benchmark(`BM${index}`, index, 412 + index * 0.1));
    features.push(benchmark('BAD', 12, 4123.45));

    const defects = scanDefects(dataset([{ name: 'Benchmarks', features }])).defects;
    const anomaly = defects.find((defect) => defect.type === 'z-anomaly');
    expect(anomaly?.featureId).toBe('BAD');
    expect(anomaly?.description).toMatch(/transposed decimal point/);
  });
});

describe('defect catalogue — relationships', () => {
  it('finds overlapping parcels and refuses to pick a winner', () => {
    const a = polygon('P1', square(0, 0, 10));
    const b = polygon('P2', square(5, 5, 10));
    const defects = scanDefects(dataset([{ name: 'Parcels', features: [a, b] }])).defects;
    const overlap = defects.find((defect) => defect.type === 'polygon-overlap');
    expect(overlap?.severity).toBe('error');
    expect(overlap?.otherFeatureId).toBe('P2');
    // The repair advice must not suggest an automatic geometric resolution.
    expect(overlap?.suggestedRepair).toMatch(/never resolve a cadastral overlap by geometry alone/i);
  });

  it('reports one overlap per pair, not one per direction', () => {
    const a = polygon('P1', square(0, 0, 10));
    const b = polygon('P2', square(5, 5, 10));
    const defects = scanDefects(dataset([{ name: 'Parcels', features: [a, b] }])).defects;
    expect(defects.filter((defect) => defect.type === 'polygon-overlap')).toHaveLength(1);
  });

  it('finds the shared-edge mismatch that becomes a sliver on dissolve', () => {
    // Two parcels sharing an edge, agreeing at two corners but 5 mm apart in
    // between. Nothing looks wrong until they are dissolved.
    const left = polygon('P1', [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ]);
    const right = polygon('P2', [
      [10, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [10.005, 5],
      [10, 0],
    ]);
    const found = scanDefects(dataset([{ name: 'Parcels', features: [left, right] }]), { tolerance: 0.001 }).defects;
    expect(types(found)).toContain('boundary-mismatch');
    const mismatch = found.find((defect) => defect.type === 'boundary-mismatch');
    expect(mismatch?.suggestedRepair).toMatch(/sliver/);
  });

  it('finds a near-duplicate but leaves the decision to the user', () => {
    const a = polygon('P1', square(0, 0, 10));
    const b = polygon('P2', square(0.0001, 0.0001, 10));
    const found = scanDefects(dataset([{ name: 'Parcels', features: [a, b] }]), { tolerance: 0.01 }).defects;
    const duplicate = found.find((defect) => defect.type === 'near-duplicate-geometry');
    expect(duplicate).toBeDefined();
    expect(duplicate?.suggestedRepair).toMatch(/two survey epochs/);
  });

  it('finds crossing lines but not lines that meet at a node', () => {
    const crossing = scanDefects(
      dataset([
        {
          name: 'Contours',
          features: [
            line('A', [[0, 0], [10, 10]]),
            line('B', [[0, 10], [10, 0]]),
          ],
        },
      ])
    ).defects;
    expect(types(crossing)).toContain('crossing-lines');

    // Two roads meeting end-to-end are connected, not crossing.
    const joined = scanDefects(
      dataset([
        {
          name: 'Roads',
          features: [
            line('A', [[0, 0], [10, 0]]),
            line('B', [[10, 0], [20, 0]]),
          ],
        },
      ])
    ).defects;
    expect(types(joined)).not.toContain('crossing-lines');
  });

  it('flags a nearly-connected endpoint but ignores a line ending in open country', () => {
    const nearMiss = scanDefects(
      dataset([
        {
          name: 'Roads',
          features: [
            line('A', [[0, 0], [10, 0]]),
            line('B', [[10.05, 0], [20, 0]]),
          ],
        },
      ]),
      { tolerance: 0.01 }
    ).defects;
    expect(types(nearMiss)).toContain('dangling-endpoint');

    // A line stopping a kilometre from anything is not a defect; flagging it
    // would make the check useless on any real dataset.
    const openCountry = scanDefects(
      dataset([
        {
          name: 'Roads',
          features: [
            line('A', [[0, 0], [10, 0]]),
            line('B', [[5000, 0], [5010, 0]]),
          ],
        },
      ]),
      { tolerance: 0.01 }
    ).defects;
    expect(types(openCountry)).not.toContain('dangling-endpoint');
  });

  it('refuses the pairwise checks above the limit instead of checking a subset', () => {
    const features = Array.from({ length: 30 }, (_, index) => polygon(`P${index}`, square(index * 20, 0, 10)));
    const report = scanDefects(dataset([{ name: 'Parcels', features }]), { maxPairwiseFeatures: 10 });
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatch(/exceed the 10 limit/);
    // Silently checking a subset and reporting "clean" would be the real failure.
    expect(report.defects.every((defect) => defect.type !== 'polygon-overlap')).toBe(true);
  });
});

describe('topology rules', () => {
  const overlapping = dataset([
    { name: 'Parcels', features: [polygon('P1', square(0, 0, 10)), polygon('P2', square(5, 5, 10)), polygon('P3', square(100, 100, 5))] },
  ]);

  it('fails must-not-overlap and names both parcels', () => {
    const rule: TopologyRule = { id: 'must-not-overlap', layer: 'Parcels', tolerance: 0.001 };
    const result = evaluateRule(overlapping, rule);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].featureId).toBe('P1');
    expect(result.violations[0].otherFeatureId).toBe('P2');
  });

  it('scopes to one feature so fixing a dispute does not report the whole layer', () => {
    // The point of scope: a surveyor working one boundary must not be handed
    // every violation in the dataset (§23.2).
    const scoped = evaluateRule(overlapping, { id: 'must-not-overlap', layer: 'Parcels', tolerance: 0.001 }, {
      kind: 'features',
      layer: 'Parcels',
      featureIds: ['P3'],
    });
    expect(scoped.featuresChecked).toBe(1);
    expect(scoped.passed).toBe(true);
  });

  it('passes must-not-overlap when parcels only share an edge', () => {
    const adjoining = dataset([
      {
        name: 'Parcels',
        features: [
          polygon('P1', [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]),
          polygon('P2', [[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]),
        ],
      },
    ]);
    // Touching along a boundary is what adjacent parcels are supposed to do.
    // A rule that called this an overlap would fire on every cadastral dataset.
    const result = evaluateRule(adjoining, { id: 'must-not-overlap', layer: 'Parcels', tolerance: 0.001 });
    expect(result.violations.filter((violation) => violation.severity === 'error')).toHaveLength(0);
  });

  it('reports an unclosed ring with the measured gap', () => {
    const open = dataset([{ name: 'Parcels', features: [polygon('P1', [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.3]])] }]);
    const result = evaluateRule(open, { id: 'polygons-must-close', layer: 'Parcels', tolerance: 0.01 });
    expect(result.passed).toBe(false);
    expect(result.violations[0].description).toMatch(/0\.3000 units apart/);
  });

  it('checks must-be-within against a second layer and blames the CRS first', () => {
    const data = dataset([
      { name: 'Boreholes', features: [{ id: 'BH1', geometry: { type: 'Point', coordinates: [5, 5], dimension: 2 }, properties: {} }, { id: 'BH2', geometry: { type: 'Point', coordinates: [500, 500], dimension: 2 }, properties: {} }] },
      { name: 'Lease', features: [polygon('L1', square(0, 0, 10))] },
    ]);
    const result = evaluateRule(data, { id: 'must-be-within', layer: 'Boreholes', againstLayer: 'Lease', tolerance: 0.001 });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].featureId).toBe('BH2');
    // The most common real cause, stated first.
    expect(result.violations[0].suggestedRepair).toMatch(/coordinate system/i);
  });

  it('says why a rule could not be evaluated rather than passing it', () => {
    const data = dataset([{ name: 'Parcels', features: [polygon('P1', square(0, 0, 10))] }]);
    const noSecondLayer = evaluateRule(data, { id: 'must-be-within', layer: 'Parcels', tolerance: 0.001 });
    expect(noSecondLayer.notEvaluated).toMatch(/needs a second layer/);
    // A rule that cannot run must never report "passed" as if it had.
    expect(noSecondLayer.violations).toHaveLength(0);
  });

  it('evaluates a set of rules in one call', () => {
    const results = evaluateRules(overlapping, [
      { id: 'must-not-overlap', layer: 'Parcels', tolerance: 0.001 },
      { id: 'polygons-must-close', layer: 'Parcels', tolerance: 0.001 },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(false);
    expect(results[1].passed).toBe(true);
  });
});

describe('repair: preview, apply, undo', () => {
  const open = dataset([{ name: 'Parcels', features: [polygon('P1', [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.02]])] }]);

  it('previews the change without touching the data', () => {
    const before = JSON.stringify(open.layers[0].features[0].geometry);
    const plan = planRepair(open, 'close-rings');
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].description).toMatch(/0\.0200 units/);
    expect(plan.maxDisplacement).toBeCloseTo(0.02, 6);
    // The dataset must be untouched — a preview that edits is not a preview.
    expect(JSON.stringify(open.layers[0].features[0].geometry)).toBe(before);
  });

  it('applies exactly what the preview described', () => {
    const plan = planRepair(open, 'close-rings');
    const result = applyRepair(open, 'close-rings');
    // Same code path, so the counts cannot drift apart.
    expect(result.plan.changes).toHaveLength(plan.changes.length);
    const ring = (result.dataset.layers[0].features[0].geometry!.coordinates as Position[][])[0];
    expect(ring[ring.length - 1]).toEqual(ring[0]);
  });

  it('undoes to the exact original geometry', () => {
    const result = applyRepair(open, 'close-rings');
    const restored = undoRepair(result.dataset, result.undo);
    expect(restored.layers[0].features[0].geometry).toEqual(open.layers[0].features[0].geometry);
  });

  it('stores only the features it changed', () => {
    const many = dataset([
      {
        name: 'Parcels',
        features: [
          polygon('OPEN', [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.02]]),
          polygon('FINE', square(100, 100, 10)),
          polygon('ALSO_FINE', square(200, 200, 10)),
        ],
      },
    ]);
    const result = applyRepair(many, 'close-rings');
    // Undo is a diff, not a snapshot: one changed feature, one stored geometry.
    expect(result.undo.entries).toHaveLength(1);
    expect(result.undo.entries[0].featureIndex).toBe(0);
  });

  it('scopes a repair to one feature', () => {
    const two = dataset([
      {
        name: 'Parcels',
        features: [
          polygon('A', [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.02]]),
          polygon('B', [[50, 50], [60, 50], [60, 60], [50, 60], [50, 50.02]]),
        ],
      },
    ]);
    const plan = planRepair(two, 'close-rings', { layer: 'Parcels', featureIds: ['A'] });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].featureId).toBe('A');
  });

  it('refuses to touch a layer marked legally operative, and says so', () => {
    const plan = planRepair(open, 'close-rings', {}, { protectedLayers: ['Parcels'] });
    expect(plan.changes).toHaveLength(0);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0].reason).toMatch(/legally operative/);

    const result = applyRepair(open, 'close-rings', {}, { protectedLayers: ['Parcels'] });
    expect(result.dataset.layers[0].features[0].geometry).toEqual(open.layers[0].features[0].geometry);
  });

  it('removes duplicate vertices without moving anything', () => {
    const duplicated = dataset([
      { name: 'Parcels', features: [polygon('P1', [[0, 0], [10, 0], [10, 0], [10, 10], [0, 10], [0, 0]])] },
    ]);
    const plan = planRepair(duplicated, 'remove-duplicate-vertices');
    expect(plan.changes[0].maxDisplacement).toBe(0);
    expect(plan.changes[0].description).toMatch(/No position moves/);
  });

  it('reverses only the rings that face the wrong way', () => {
    // A clockwise exterior ring: RFC 7946 wants counter-clockwise.
    const clockwise = dataset([
      { name: 'Parcels', features: [polygon('P1', [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]])] },
    ]);
    const plan = planRepair(clockwise, 'fix-ring-orientation');
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].maxDisplacement).toBe(0);

    const already = dataset([{ name: 'Parcels', features: [polygon('P1', square(0, 0, 10))] }]);
    expect(planRepair(already, 'fix-ring-orientation').changes).toHaveLength(0);
  });
});

describe('fix all safe issues', () => {
  it('applies the reversible repairs and reports each one', () => {
    const messy = dataset([
      { name: 'Parcels', features: [polygon('P1', [[0, 0], [10, 0], [10, 0], [10, 10], [0, 10], [0, 0.002]])] },
    ]);
    const result = fixSafeIssues(messy);
    expect(result.applied.map((entry) => entry.operation)).toContain('close-rings');
    expect(result.applied.map((entry) => entry.operation)).toContain('remove-duplicate-vertices');
    expect(result.undo.length).toBe(result.applied.length);
  });

  it('refuses a ring gap too large to be a digitising slip', () => {
    // Half a metre open is a question for the surveyor, not a tidy-up.
    const wideOpen = dataset([
      { name: 'Parcels', features: [polygon('P1', [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.5]])] },
    ]);
    const result = fixSafeIssues(wideOpen);
    expect(result.applied.map((entry) => entry.operation)).not.toContain('close-rings');
    expect(result.skipped[0].reason).toMatch(/genuinely open boundary/);
  });

  it('never includes snapping, which moves survey positions', () => {
    const data = dataset([{ name: 'Parcels', features: [polygon('P1', square(0, 0, 10))] }]);
    const result = fixSafeIssues(data, {}, { tolerance: 100 });
    expect(result.applied.map((entry) => entry.operation)).not.toContain('snap-vertices');
  });

  it('leaves a protected layer alone even in bulk', () => {
    const messy = dataset([
      { name: 'Cadastral', features: [polygon('P1', [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.002]])] },
    ]);
    const result = fixSafeIssues(messy, {}, { protectedLayers: ['Cadastral'] });
    expect(result.applied).toHaveLength(0);
    expect(result.dataset.layers[0].features[0].geometry).toEqual(messy.layers[0].features[0].geometry);
  });

  it('describes a plan in a line that carries the displacement', () => {
    const open = dataset([{ name: 'Parcels', features: [polygon('P1', [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0.02]])] }]);
    const text = describePlan(planRepair(open, 'close-rings', {}, DEFAULT_REPAIR_SETTINGS));
    expect(text).toMatch(/1 change/);
    expect(text).toMatch(/0\.0200 units/);
  });
});

describe('defect scan defaults', () => {
  it('states the tolerance it measured against', () => {
    const report = scanDefects(dataset([{ name: 'Parcels', features: [polygon('P1', square(0, 0, 10))] }]));
    expect(report.tolerance).toBe(DEFAULT_DEFECT_OPTIONS.tolerance);
    // 10 mm: below total-station repeatability, so anything larger is a real
    // difference rather than instrument noise.
    expect(DEFAULT_DEFECT_OPTIONS.tolerance).toBe(0.01);
  });
});
