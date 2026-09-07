/**
 * Burn-in, label placement and CAD polygonisation (spec §27).
 *
 * The fixtures are the shapes these features exist for: a C-shaped parcel whose
 * centroid falls outside it, a cadastral drawing with plot numbers on a separate
 * layer, and a boundary drawn as four unjoined LINE entities. A test on a
 * convex square would pass with a naive implementation and prove nothing.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type Position, type SourceInfo } from '@core/cir';
import { pointInRing } from '@core/geometry';
import { labelAnchor, placeLabel, resolveCollisions } from '@qa/label-placement';
import { DEFAULT_BURN_IN_OPTIONS, burnIn, describeBurnIn, previewBurnIn } from '@qa/burn-in';
import { describePolygonize, polygonize } from '@qa/polygonize';
import { crsFromEpsg } from '@crs/epsg';
import { convert } from '@core/pipeline';
import { FULL_PRECISION } from '@core/precision';

const SOURCE: SourceInfo = { fileName: 'cadastral.dxf', size: 0, formatId: 'dxf', formatName: 'AutoCAD DXF', detectionConfidence: 1 };

function polygonFeature(id: string, rings: Position[][], properties: Record<string, unknown> = {}): CirFeature {
  return { id, geometry: { type: 'Polygon', coordinates: rings, dimension: 2 }, properties };
}

function textFeature(id: string, at: Position, text: string, extra: Partial<CirFeature> = {}): CirFeature {
  return {
    id,
    geometry: { type: 'Point', coordinates: at, dimension: 2 },
    properties: { text },
    sourceEntity: 'TEXT',
    ...extra,
  };
}

function lineFeature(id: string, path: Position[], layerName = 'Boundary'): CirFeature {
  return {
    id,
    geometry: { type: 'LineString', coordinates: path, dimension: 2 },
    properties: { _layer: layerName },
    sourceEntity: 'LINE',
    sourceHandle: id,
  };
}

function dataset(layers: { name: string; features: CirFeature[] }[]): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'cadastral',
    source: SOURCE,
    crs: crsFromEpsg(32645),
    crsOrigin: 'declared',
    layers: layers.map((entry) => createLayer(entry.name, entry.features)),
  });
}

function square(x: number, y: number, size: number): Position[] {
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

/**
 * A C-shape: the classic case where the centroid falls OUTSIDE the polygon.
 * The opening faces east, so the area centroid sits in the notch.
 */
const C_SHAPE: Position[] = [
  [0, 0],
  [100, 0],
  [100, 20],
  [30, 20],
  [30, 80],
  [100, 80],
  [100, 100],
  [0, 100],
  [0, 0],
];

describe('label placement', () => {
  it('places the anchor inside a C-shape, where the centroid is not', () => {
    // The area centroid of this shape lies in the notch, outside the polygon.
    // A label there sits in the neighbouring parcel — on cadastral output that
    // mislabels someone's land, which is why the centroid is not used.
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let index = 0, previous = C_SHAPE.length - 1; index < C_SHAPE.length; previous = index++) {
      const cross = C_SHAPE[previous][0] * C_SHAPE[index][1] - C_SHAPE[index][0] * C_SHAPE[previous][1];
      area += cross;
      cx += (C_SHAPE[previous][0] + C_SHAPE[index][0]) * cross;
      cy += (C_SHAPE[previous][1] + C_SHAPE[index][1]) * cross;
    }
    const centroid: Position = [cx / (3 * area), cy / (3 * area)];
    expect(pointInRing(centroid, C_SHAPE)).toBe(false);

    const anchor = labelAnchor([C_SHAPE]);
    expect(anchor).not.toBeNull();
    expect(pointInRing(anchor!.position, C_SHAPE)).toBe(true);
    expect(anchor!.clearance).toBeGreaterThan(0);
  });

  it('keeps the anchor out of a hole', () => {
    // A lease with a big exclusion in the middle: the label must not land in
    // the exclusion, which is exactly where the naive centroid would put it.
    const shell = square(0, 0, 100);
    const hole = square(20, 20, 60);
    const anchor = labelAnchor([shell, hole]);
    expect(anchor).not.toBeNull();
    expect(pointInRing(anchor!.position, shell)).toBe(true);
    expect(pointInRing(anchor!.position, hole)).toBe(false);
  });

  it('reports clearance as the room the label actually has', () => {
    const anchor = labelAnchor([square(0, 0, 100)]);
    // The furthest interior point of a 100-unit square is its centre, 50 from
    // every edge.
    expect(anchor!.position[0]).toBeCloseTo(50, 0);
    expect(anchor!.position[1]).toBeCloseTo(50, 0);
    expect(anchor!.clearance).toBeCloseTo(50, 0);
    expect(anchor!.narrow).toBe(false);
  });

  it('rotates the label to follow a narrow strip', () => {
    // A 200 x 4 road reserve running at 45 degrees.
    const strip: Position[] = [
      [0, 0],
      [141.4, 141.4],
      [138.6, 144.2],
      [-2.8, 2.8],
      [0, 0],
    ];
    const anchor = labelAnchor([strip]);
    expect(anchor!.narrow).toBe(true);
    expect(anchor!.rotation).toBeCloseTo(45, 0);
  });

  it('reports a label that will not fit rather than hiding it', () => {
    const placed = placeLabel('SURVEY-PLOT-784/2-EXTENSION', [square(0, 0, 4)], 2.5);
    expect(placed!.overflows).toBe(true);
    // Still placed: suppressing it would silently lose the plot number.
    expect(pointInRing(placed!.anchor.position, square(0, 0, 4))).toBe(true);
  });

  it('suppresses a colliding label instead of nudging it into the wrong parcel', () => {
    const a = placeLabel('784', [square(0, 0, 100)], 2)!;
    const b = placeLabel('785', [square(1, 1, 100)], 2)!;
    const resolved = resolveCollisions([a, b], 2);
    expect(resolved.filter((entry) => entry.suppressed)).toHaveLength(1);
    // A plot number a few metres into the neighbour is worse than one visibly
    // missing, so the loser is dropped rather than moved.
    expect(resolved.filter((entry) => !entry.suppressed)).toHaveLength(1);
  });
});

describe('burn-in: text inside polygons', () => {
  const cadastral = () =>
    dataset([
      {
        name: 'Plots',
        features: [polygonFeature('P1', [square(0, 0, 100)]), polygonFeature('P2', [square(200, 0, 100)])],
      },
      {
        name: 'Plot_Text',
        features: [textFeature('T1', [50, 50], 'PLOT-101'), textFeature('T2', [250, 50], 'PLOT-102')],
      },
    ]);

  it('attaches each plot number to the parcel it sits inside', () => {
    const { dataset: result, report } = burnIn(cadastral(), { targetLayer: 'Plots', fieldName: 'plot_no' });
    expect(report.matched).toHaveLength(2);
    const plots = result.layers.find((layer) => layer.name === 'Plots')!;
    expect(plots.features[0].properties.plot_no).toBe('PLOT-101');
    expect(plots.features[1].properties.plot_no).toBe('PLOT-102');
    // The field is declared, so it survives into a format with a schema.
    expect(plots.fields.some((field) => field.name === 'plot_no')).toBe(true);
  });

  it('never deletes the source text unless asked', () => {
    const { dataset: kept } = burnIn(cadastral(), { targetLayer: 'Plots' });
    expect(kept.layers.find((layer) => layer.name === 'Plot_Text')!.features).toHaveLength(2);

    const { dataset: replaced } = burnIn(cadastral(), { targetLayer: 'Plots', replaceSource: true });
    expect(replaced.layers.find((layer) => layer.name === 'Plot_Text')!.features).toHaveLength(0);
  });

  it('reports text that falls in no parcel instead of discarding it', () => {
    const withOrphan = dataset([
      { name: 'Plots', features: [polygonFeature('P1', [square(0, 0, 100)])] },
      { name: 'Plot_Text', features: [textFeature('T1', [50, 50], 'PLOT-101'), textFeature('T2', [9999, 9999], 'PLOT-999')] },
    ]);
    const report = previewBurnIn(withOrphan, { targetLayer: 'Plots' });
    expect(report.orphanText).toHaveLength(1);
    expect(report.orphanText[0].value).toBe('PLOT-999');
  });

  it('reports parcels with no text inside them', () => {
    const missing = dataset([
      { name: 'Plots', features: [polygonFeature('P1', [square(0, 0, 100)]), polygonFeature('P2', [square(200, 0, 100)])] },
      { name: 'Plot_Text', features: [textFeature('T1', [50, 50], 'PLOT-101')] },
    ]);
    const report = previewBurnIn(missing, { targetLayer: 'Plots' });
    expect(report.matched).toHaveLength(1);
    expect(report.unmatched).toEqual(['P2']);
  });

  it('ignores text that lands in a hole', () => {
    const withHole = dataset([
      { name: 'Plots', features: [polygonFeature('P1', [square(0, 0, 100), square(40, 40, 20)])] },
      { name: 'Plot_Text', features: [textFeature('T1', [50, 50], 'IN-THE-HOLE')] },
    ]);
    // The text sits in the exclusion, so it does not belong to this parcel.
    const report = previewBurnIn(withHole, { targetLayer: 'Plots' });
    expect(report.matched).toHaveLength(0);
    expect(report.orphanText).toHaveLength(1);
  });

  it('names the rule that resolved an ambiguous parcel, and what it rejected', () => {
    const ambiguous = dataset([
      { name: 'Plots', features: [polygonFeature('P1', [square(0, 0, 100)])] },
      {
        name: 'Plot_Text',
        features: [textFeature('T1', [10, 10], 'CORNER-NOTE'), textFeature('T2', [50, 50], 'PLOT-101')],
      },
    ]);
    const report = previewBurnIn(ambiguous, { targetLayer: 'Plots', priority: 'nearest-to-centre' });
    expect(report.ambiguous).toBe(1);
    expect(report.matched[0].value).toBe('PLOT-101');
    // A wrong plot number attached confidently is worse than one questioned, so
    // the loser and the reason are both kept.
    expect(report.matched[0].rejected).toHaveLength(1);
    expect(report.matched[0].rejected[0].value).toBe('CORNER-NOTE');
    expect(report.matched[0].rejected[0].reason).toMatch(/Further from the polygon centre/);
  });

  it('picks the largest text when that is the chosen rule', () => {
    const ambiguous = dataset([
      { name: 'Plots', features: [polygonFeature('P1', [square(0, 0, 100)])] },
      {
        name: 'Plot_Text',
        features: [
          textFeature('T1', [50, 50], 'small-note', { properties: { text: 'small-note', height: 1 } }),
          textFeature('T2', [20, 20], 'PLOT-101', { properties: { text: 'PLOT-101', height: 5 } }),
        ],
      },
    ]);
    const report = previewBurnIn(ambiguous, { targetLayer: 'Plots', priority: 'largest-text' });
    expect(report.matched[0].value).toBe('PLOT-101');
  });

  it('joins every candidate when asked to concatenate, in a stable order', () => {
    const ambiguous = dataset([
      { name: 'Plots', features: [polygonFeature('P1', [square(0, 0, 100)])] },
      { name: 'Plot_Text', features: [textFeature('T1', [60, 60], 'B'), textFeature('T2', [50, 50], 'A')] },
    ]);
    const report = previewBurnIn(ambiguous, { targetLayer: 'Plots', priority: 'concatenate', separator: ' + ' });
    // Sorted, so the joined value does not depend on read order.
    expect(report.matched[0].value).toBe('A + B');
  });

  it('leaves an existing value alone unless overwrite is chosen', () => {
    const existing = dataset([
      { name: 'Plots', features: [polygonFeature('P1', [square(0, 0, 100)], { label: 'ALREADY-SET' })] },
      { name: 'Plot_Text', features: [textFeature('T1', [50, 50], 'PLOT-101')] },
    ]);
    const kept = previewBurnIn(existing, { targetLayer: 'Plots', fieldName: 'label' });
    expect(kept.skippedExisting).toEqual(['P1']);

    const overwritten = burnIn(existing, { targetLayer: 'Plots', fieldName: 'label', overwriteExisting: true });
    expect(overwritten.dataset.layers[0].features[0].properties.label).toBe('PLOT-101');
  });

  it('creates a placed text feature in geometry mode', () => {
    const { dataset: result } = burnIn(cadastral(), { targetLayer: 'Plots', mode: 'geometry' });
    const labels = result.layers.find((layer) => layer.name === 'Plots labels');
    expect(labels).toBeDefined();
    expect(labels!.features).toHaveLength(2);
    // Placed at the anchor, so it is inside the parcel it belongs to.
    expect(pointInRing(labels!.features[0].geometry!.coordinates as Position, square(0, 0, 100))).toBe(true);
    expect(labels!.features[0].sourceEntity).toBe('TEXT');
  });

  it('writes the KML placemark name, which is what Google Earth shows', () => {
    const { dataset: result } = burnIn(cadastral(), { targetLayer: 'Plots', mode: 'kml' });
    expect(result.layers[0].features[0].properties.name).toBe('PLOT-101');
  });

  it('summarises what it did in one line', () => {
    const report = previewBurnIn(cadastral(), { targetLayer: 'Plots' });
    const text = describeBurnIn(report, { ...DEFAULT_BURN_IN_OPTIONS, targetLayer: 'Plots' });
    expect(text).toMatch(/2 polygon\(s\) labelled/);
  });
});

describe('CAD polygonisation', () => {
  it('assembles four separate LINE entities into one parcel', () => {
    // What a cadastral DXF actually looks like when the draughtsman drew edges
    // rather than a closed polyline. To CAD these render identically.
    const drawing = dataset([
      {
        name: 'Boundary',
        features: [
          lineFeature('L1', [[0, 0], [100, 0]]),
          lineFeature('L2', [[100, 0], [100, 100]]),
          lineFeature('L3', [[100, 100], [0, 100]]),
          lineFeature('L4', [[0, 100], [0, 0]]),
        ],
      },
    ]);
    const { dataset: result, report } = polygonize(drawing, { keepSourceLines: false });
    expect(report.built).toHaveLength(1);
    expect(report.built[0].area).toBeCloseTo(10000, 6);

    const polygons = result.layers.find((layer) => layer.name === 'Boundary')!;
    expect(polygons.features[0].geometry!.type).toBe('Polygon');
    // Provenance survives: which entities this polygon came from (R20).
    expect(polygons.features[0].properties._polygonized_segments).toBe(4);
    expect(String(polygons.features[0].properties._polygonized_from)).toContain('L1');
  });

  it('closes a small gap and records exactly how much it closed', () => {
    const nearlyClosed = dataset([
      {
        name: 'Boundary',
        features: [
          lineFeature('L1', [[0, 0], [100, 0]]),
          lineFeature('L2', [[100, 0], [100, 100]]),
          lineFeature('L3', [[100, 100], [0, 100]]),
          lineFeature('L4', [[0, 100], [0, 0.005]]), // 5 mm short
        ],
      },
    ]);
    const { report } = polygonize(nearlyClosed, { tolerance: 0.01, keepSourceLines: false });
    expect(report.built).toHaveLength(1);
    expect(report.built[0].closedGap).toBeGreaterThan(0);
    expect(report.built[0].closedGap).toBeLessThanOrEqual(0.01);
  });

  it('refuses a gap beyond the tolerance and says what defeated it', () => {
    // 3 m open. Closing that is inventing a boundary, not recovering intent.
    const wideOpen = dataset([
      {
        name: 'Boundary',
        features: [
          lineFeature('L1', [[0, 0], [100, 0]]),
          lineFeature('L2', [[100, 0], [100, 100]]),
          lineFeature('L3', [[100, 100], [0, 100]]),
          lineFeature('L4', [[0, 100], [0, 3]]),
        ],
      },
    ]);
    const { report } = polygonize(wideOpen, { tolerance: 0.01, keepSourceLines: false });
    expect(report.built).toHaveLength(0);
    expect(report.unclosed).toHaveLength(1);
    expect(report.unclosed[0].reason).toMatch(/beyond the 0\.01 tolerance/);
  });

  it('resolves a loop inside a loop into a hole', () => {
    const withCourtyard = dataset([
      {
        name: 'Boundary',
        features: [
          lineFeature('OUT', square(0, 0, 100)),
          lineFeature('IN', square(30, 30, 40)),
        ],
      },
    ]);
    const { dataset: result, report } = polygonize(withCourtyard, { keepSourceLines: false });
    expect(report.holes).toBe(1);
    const rings = result.layers.find((layer) => layer.name === 'Boundary')!.features[0].geometry!.coordinates as Position[][];
    expect(rings).toHaveLength(2);
  });

  it('keeps the line work beside the polygons when asked', () => {
    const drawing = dataset([{ name: 'Boundary', features: [lineFeature('L1', square(0, 0, 100))] }]);
    const { dataset: result } = polygonize(drawing, { keepSourceLines: true });
    expect(result.layers.map((layer) => layer.name)).toEqual(['Boundary', 'Boundary polygons']);
  });

  it('does not node lines that cross in their interiors', () => {
    // Crossing lines are a defect that qa/defects.ts reports. Silently noding
    // them here would build polygons out of geometry the user has not been
    // told is broken.
    const crossing = dataset([
      {
        name: 'Boundary',
        features: [lineFeature('A', [[0, 0], [100, 100]]), lineFeature('B', [[0, 100], [100, 0]])],
      },
    ]);
    const { report } = polygonize(crossing, { keepSourceLines: false });
    expect(report.built).toHaveLength(0);
  });

  it('summarises the closures it made, with the tolerance', () => {
    const nearlyClosed = dataset([
      {
        name: 'Boundary',
        features: [
          lineFeature('L1', [[0, 0], [100, 0]]),
          lineFeature('L2', [[100, 0], [100, 100]]),
          lineFeature('L3', [[100, 100], [0, 100]]),
          lineFeature('L4', [[0, 100], [0, 0.005]]),
        ],
      },
    ]);
    const { report } = polygonize(nearlyClosed, { tolerance: 0.01, keepSourceLines: false });
    const text = describePolygonize(report, { tolerance: 0.01, layers: [], detectHoles: true, minArea: 0, keepSourceLines: false });
    expect(text).toMatch(/1 polygon\(s\) built/);
    expect(text).toMatch(/tolerance 0\.01/);
  });
});

describe('the cadastral workflow end to end', () => {
  it('turns CAD line work plus separate text into labelled polygons', () => {
    // The whole reason this phase exists: a cadastral DXF where boundaries and
    // plot numbers are on different layers with nothing linking them, which is
    // otherwise redone by hand plot by plot.
    const drawing = dataset([
      {
        name: 'Boundary',
        features: [
          lineFeature('L1', [[0, 0], [100, 0]]),
          lineFeature('L2', [[100, 0], [100, 100]]),
          lineFeature('L3', [[100, 100], [0, 100]]),
          lineFeature('L4', [[0, 100], [0, 0]]),
        ],
      },
      { name: 'Plot_Text', features: [textFeature('T1', [50, 50], 'KHASRA-112/2')] },
    ]);

    const polygonized = polygonize(drawing, { layers: ['Boundary'], keepSourceLines: false });
    expect(polygonized.report.built).toHaveLength(1);

    const burned = burnIn(polygonized.dataset, { targetLayer: 'Boundary', fieldName: 'khasra' });
    expect(burned.report.matched).toHaveLength(1);
    const parcel = burned.dataset.layers.find((layer) => layer.name === 'Boundary')!.features[0];
    expect(parcel.geometry!.type).toBe('Polygon');
    expect(parcel.properties.khasra).toBe('KHASRA-112/2');
    // And the survey text it came from is still there.
    expect(burned.dataset.layers.find((layer) => layer.name === 'Plot_Text')!.features).toHaveLength(1);
  });
});

describe('the cadastral workflow through a real conversion', () => {
  // A DXF as a cadastral drawing actually arrives: four unjoined LINE entities
  // for the boundary, and the plot number as TEXT on its own layer. Nothing in
  // the file links them.
  const CADASTRAL_DXF = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '5', 'B1', '8', 'Boundary', '10', '412300.0', '20', '2591200.0', '11', '412400.0', '21', '2591200.0',
    '0', 'LINE', '5', 'B2', '8', 'Boundary', '10', '412400.0', '20', '2591200.0', '11', '412400.0', '21', '2591300.0',
    '0', 'LINE', '5', 'B3', '8', 'Boundary', '10', '412400.0', '20', '2591300.0', '11', '412300.0', '21', '2591300.0',
    '0', 'LINE', '5', 'B4', '8', 'Boundary', '10', '412300.0', '20', '2591300.0', '11', '412300.0', '21', '2591200.0',
    '0', 'TEXT', '5', 'T1', '8', 'Plot_Text', '10', '412350.0', '20', '2591250.0', '40', '2.5', '1', 'KHASRA-112/2',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');

  it('exports labelled polygons from line work and detached text', async () => {
    const result = await convert({
      input: { fileName: 'plots.dxf', bytes: new TextEncoder().encode(CADASTRAL_DXF) },
      targetFormatId: 'geojson',
      settings: {
        precision: FULL_PRECISION,
        sourceCrs: crsFromEpsg(32645),
        polygonize: { layers: ['Boundary'], keepSourceLines: false, tolerance: 0.01 },
        burnIn: { targetLayer: 'Boundary', fieldName: 'khasra' },
      },
    });

    const parsed = JSON.parse(new TextDecoder().decode(result.outputs[0].bytes));
    const parcel = parsed.features.find((feature: any) => feature.geometry?.type === 'Polygon');
    expect(parcel).toBeDefined();
    // The whole point: the plot number is now ON the parcel, in a field any GIS
    // can read, instead of a detached point beside it.
    expect(parcel.properties.khasra).toBe('KHASRA-112/2');

    // Both operations report themselves; neither happens silently.
    expect(result.warnings.some((warning) => warning.code === 'POLYGONIZED')).toBe(true);
    expect(result.warnings.some((warning) => warning.code === 'BURNED_IN')).toBe(true);
  });

  it('does neither unless asked', async () => {
    const untouched = await convert({
      input: { fileName: 'plots.dxf', bytes: new TextEncoder().encode(CADASTRAL_DXF) },
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: crsFromEpsg(32645) },
    });
    const parsed = JSON.parse(new TextDecoder().decode(untouched.outputs[0].bytes));
    // Left alone, the boundary is still line work and the text is still adrift.
    expect(parsed.features.every((feature: any) => feature.geometry?.type !== 'Polygon')).toBe(true);
    expect(untouched.warnings.some((warning) => warning.code === 'POLYGONIZED')).toBe(false);
  });
});
