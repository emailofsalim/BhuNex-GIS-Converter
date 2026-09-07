/**
 * Project health and the conversion report (spec §29.2, §22.4).
 *
 * The tests that matter most here are the honesty guards, and they should not
 * be simplified:
 *
 *  - A component that could not be evaluated must be EXCLUDED from the score,
 *    never scored full marks. Otherwise a dataset too large to check its
 *    topology outscores one small enough to check — the check that would have
 *    found the overlaps silently awards a hundred.
 *  - Every score must be expandable into the items that produced it. A score
 *    with no drill-down is decoration, and the spec says so in those words.
 *  - The report must escape everything and must never carry a credential: it is
 *    a document that gets attached to a delivery and forwarded.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type Position, type SourceInfo } from '@core/cir';
import { HEALTH_COMPONENT_LABEL, allFindings, assessHealth } from '@qa/health';
import { buildReport, reportFiles } from '@core/report';
import { predictConversion } from '@core/predict';
import { convert, DEFAULT_SETTINGS as PIPELINE_DEFAULTS } from '@core/pipeline';
import { crsFromEpsg } from '@crs/epsg';

const SOURCE: SourceInfo = { fileName: 'plots.dxf', size: 4096, formatId: 'dxf', formatName: 'AutoCAD DXF', detectionConfidence: 0.98 };

function polygon(id: string, ring: Position[], properties: Record<string, unknown> = {}): CirFeature {
  return { id, geometry: { type: 'Polygon', coordinates: [ring], dimension: 2 }, properties };
}

function square(x = 0, y = 0, size = 10): Position[] {
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

function dataset(features: CirFeature[], overrides: Partial<CirDataset> = {}): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'plots',
    source: SOURCE,
    crs: crsFromEpsg(32645),
    crsOrigin: 'declared',
    units: 'metre',
    layers: [createLayer('Plots', features)],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Project health (§29.2)
// ---------------------------------------------------------------------------

describe('project health', () => {
  it('scores clean, declared data well', () => {
    const health = assessHealth(dataset([polygon('A', square()), polygon('B', square(50))]));
    expect(health.score).not.toBeNull();
    expect(health.score!).toBeGreaterThanOrEqual(85);
    expect(health.grade).toBe('good');
  });

  it('every score is expandable into the items that produced it', () => {
    // The spec's requirement in one assertion: a component that deducted points
    // must be able to say which features cost them.
    const unclosed: CirFeature = {
      id: 'U',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]], dimension: 2 },
      properties: {},
    };
    const health = assessHealth(dataset([unclosed]));

    for (const component of health.components) {
      if (component.score === null) {
        expect(component.notEvaluatedReason).toBeTruthy();
        continue;
      }
      // A component that lost points must show why.
      if (component.score < 100) expect(component.findings.length).toBeGreaterThan(0);
      // And every finding must be locatable or counted, never a bare adjective.
      for (const finding of component.findings) {
        expect(finding.message.length).toBeGreaterThan(10);
        expect(finding.count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('penalises a missing CRS hardest, because it invalidates everything else', () => {
    const withCrs = assessHealth(dataset([polygon('A', square())]));
    const without = assessHealth(dataset([polygon('A', square())], { crs: null, crsOrigin: 'unknown' }));

    expect(without.score!).toBeLessThan(withCrs.score!);
    const crs = without.components.find((component) => component.id === 'crs')!;
    expect(crs.score!).toBeLessThan(50);
    expect(crs.findings[0].message).toContain('No coordinate reference system');
  });

  it('distinguishes a declared CRS from one the operator asserted', () => {
    const declared = assessHealth(dataset([polygon('A', square())], { crsOrigin: 'declared' }));
    const asserted = assessHealth(dataset([polygon('A', square())], { crsOrigin: 'user' }));
    const inferred = assessHealth(dataset([polygon('A', square())], { crsOrigin: 'inferred' }));

    const scoreOf = (health: ReturnType<typeof assessHealth>) => health.components.find((c) => c.id === 'crs')!.score!;
    expect(scoreOf(declared)).toBe(100);
    expect(scoreOf(asserted)).toBeLessThan(100);
    expect(scoreOf(inferred)).toBeLessThan(scoreOf(asserted));
  });

  it('catches degrees stored under a projected CRS', () => {
    // The silent failure: a file in lat/lon labelled UTM opens fine and puts
    // the survey a few hundred metres from the equator.
    const health = assessHealth(dataset([polygon('A', [[77.1, 28.5], [77.2, 28.5], [77.2, 28.6], [77.1, 28.6], [77.1, 28.5]])]));
    const crs = health.components.find((component) => component.id === 'crs')!;
    expect(crs.findings.some((finding) => finding.message.includes('look like degrees'))).toBe(true);
  });

  it('catches projected coordinates under a geographic CRS', () => {
    const health = assessHealth(dataset([polygon('A', square(500000, 2700000))], { crs: crsFromEpsg(4326) }));
    const crs = health.components.find((component) => component.id === 'crs')!;
    expect(crs.findings.some((finding) => finding.message.includes('look projected'))).toBe(true);
  });

  it('excludes an unevaluated component instead of awarding it full marks', () => {
    // The failure this guards against: an unevaluated component scored 100
    // would make an unassessable dataset outrank an assessable one.
    const health = assessHealth(dataset([polygon('A', square())]));
    const risk = health.components.find((component) => component.id === 'conversion-risk')!;

    expect(risk.score).toBeNull();
    expect(risk.notEvaluatedReason).toContain('No output format');
    expect(health.notEvaluated).toContain(HEALTH_COMPONENT_LABEL['conversion-risk']);
    expect(health.coverage).toBeLessThan(1);
    expect(health.summary).toContain('could not be evaluated');
  });

  it('reaches full coverage once every component can run', () => {
    const data = dataset([polygon('A', square(), { plot_no: '12/A' })], {
      // Fields declared, so attribute completeness has something to measure.
      layers: [createLayer('Plots', [polygon('A', square(), { plot_no: '12/A' })], [{ name: 'plot_no', type: 'string' }])],
    });
    const health = assessHealth(data, { prediction: predictConversion(data, 'geojson') });
    expect(health.notEvaluated).toHaveLength(0);
    expect(health.coverage).toBe(1);
    expect(health.summary).not.toContain('could not be evaluated');
  });

  it('a bigger dataset with the same defect count scores better', () => {
    // Proportional, not absolute: five bad parcels in four thousand is not the
    // same situation as five in six, and a score that cannot tell them apart is
    // reporting the size of the data rather than its quality.
    const bad = (index: number): CirFeature => ({
      id: `B${index}`,
      geometry: { type: 'Polygon', coordinates: [[[index * 20, 0], [index * 20 + 10, 0], [index * 20 + 10, 10], [index * 20, 10]]], dimension: 2 },
      properties: {},
    });
    const good = (index: number) => polygon(`G${index}`, square(index * 20, 500));

    const small = assessHealth(dataset([bad(0), bad(1), bad(2), good(0)]));
    const large = assessHealth(dataset([bad(0), bad(1), bad(2), ...Array.from({ length: 60 }, (_, i) => good(i))]));

    const geometryOf = (health: ReturnType<typeof assessHealth>) => health.components.find((c) => c.id === 'geometry')!.score!;
    expect(geometryOf(large)).toBeGreaterThan(geometryOf(small));
  });

  it('reports overlapping parcels as a topology finding with a location', () => {
    const health = assessHealth(dataset([polygon('A', square(0, 0, 10)), polygon('B', square(5, 5, 10))]));
    const topology = health.components.find((component) => component.id === 'topology')!;
    expect(topology.score).not.toBeNull();
    expect(topology.findings.length).toBeGreaterThan(0);
    expect(topology.method).toContain('tolerance');
  });

  it('does not treat an empty attribute column as an error', () => {
    const data = dataset(
      [polygon('A', square(), { plot_no: '', owner: 'x' }), polygon('B', square(50), { plot_no: '', owner: 'y' })],
      {
        layers: [
          createLayer(
            'Plots',
            [polygon('A', square(), { plot_no: '', owner: 'x' }), polygon('B', square(50), { plot_no: '', owner: 'y' })],
            [
              { name: 'plot_no', type: 'string' },
              { name: 'owner', type: 'string' },
            ]
          ),
        ],
      }
    );
    const attributes = assessHealth(data).components.find((component) => component.id === 'attributes')!;
    expect(attributes.findings.every((finding) => finding.severity === 'info')).toBe(true);
    expect(attributes.findings[0].message).toContain('plot_no');
    expect(attributes.findings[0].message).toContain('100%');
  });

  it('says so rather than scoring when there are no attributes to measure', () => {
    const attributes = assessHealth(dataset([polygon('A', square())])).components.find((c) => c.id === 'attributes')!;
    expect(attributes.score).toBeNull();
    expect(attributes.notEvaluatedReason).toContain('no attribute fields');
  });

  it('counts unresolved warnings against the score', () => {
    const data = dataset([polygon('A', square())], {
      warnings: [
        { code: 'X', severity: 'error', message: 'A layer could not be read.' },
        { code: 'Y', severity: 'warning', message: 'Arc tolerance was applied.' },
        { code: 'Z', severity: 'info', message: 'Nothing important.' },
      ],
    });
    const warnings = assessHealth(data).components.find((component) => component.id === 'warnings')!;
    // The info-level warning is not counted: everything is a warning to
    // something, and a score that reacts to every note is one nobody trusts.
    expect(warnings.findings).toHaveLength(2);
    expect(warnings.score!).toBeLessThan(100);
  });

  it('gathers every finding into one work list, worst first', () => {
    const data = dataset([polygon('A', square(0, 0, 10)), polygon('B', square(5, 5, 10))], { crs: null, crsOrigin: 'unknown' });
    const list = allFindings(assessHealth(data));
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].finding.severity).toBe('error');
    expect(list[0].component).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The conversion report (§22.4)
// ---------------------------------------------------------------------------

describe('conversion report', () => {
  const base = {
    dataset: dataset([polygon('A', square(), { plot_no: '12/A' })]),
    sourceFileName: 'plots.dxf',
    sourceFormatName: 'AutoCAD DXF',
    sourceSizeBytes: 4096,
    now: new Date('2026-09-07T10:00:00Z'),
  };

  it('carries source, processing, output and QA in one document', () => {
    const report = buildReport({
      ...base,
      targetFormatName: 'KMZ',
      outputSizeBytes: 2048,
      outputPaths: ['Survey/plots.kmz'],
      qaVerdict: 'PASS',
      qaSummary: 'Re-imported and compared.',
      processing: [{ label: 'Build polygons', detail: 'closing gaps up to 0.01' }],
      durationMs: 142,
    });

    for (const heading of ['Source', 'Processing', 'Output', 'Delivery', 'Quality assurance', 'Warnings']) {
      expect(report.html).toContain(heading);
      expect(report.text).toContain(heading.toUpperCase());
    }
    expect(report.html).toContain('AutoCAD DXF');
    expect(report.html).toContain('Survey/plots.kmz');
    expect(report.text).toContain('closing gaps up to 0.01');
  });

  it('states the CRS and where it came from, not just the code', () => {
    const asserted = buildReport({ ...base, dataset: dataset([polygon('A', square())], { crsOrigin: 'user' }) });
    expect(asserted.html).toContain('Asserted by the operator');

    const missing = buildReport({ ...base, dataset: dataset([polygon('A', square())], { crs: null, crsOrigin: 'unknown' }) });
    expect(missing.html).toContain('not declared');
  });

  it('never lets NOT_VALIDATED read as a pass', () => {
    const report = buildReport({ ...base, targetFormatName: 'DGN', qaVerdict: 'NOT_VALIDATED', qaSummary: 'No reader.' });
    expect(report.html).toContain('NOT VALIDATED is not a pass');
    expect(report.text).toContain('NOT VALIDATED is not a pass');
  });

  it('escapes every value, because layer names come from files we did not write', () => {
    const hostile = dataset([polygon('A', square())], {
      layers: [createLayer('<script>alert(1)</script>', [polygon('A', square())])],
    });
    const report = buildReport({ ...base, dataset: hostile, sourceFileName: '"><img src=x onerror=alert(1)>' });

    expect(report.html).not.toContain('<script>alert(1)</script>');
    expect(report.html).not.toContain('<img src=x');
    expect(report.html).toContain('&lt;script&gt;');
  });

  it('never writes a credential into a document that gets forwarded (R23)', () => {
    const report = buildReport({
      ...base,
      settings: {
        precisionMode: 'full',
        api_key: 'sk-abcdefghijklmnop0123',
        remark: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload',
        outputLayout: 'per-layer',
      },
    });

    expect(report.html).not.toContain('sk-abcdefghijklmnop0123');
    expect(report.html).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(report.text).not.toContain('sk-abcdefghijklmnop0123');
    expect(report.droppedSecretFields).toEqual(['api_key', 'remark']);
    // The omission is stated, not silent.
    expect(report.html).toContain('credential-shaped');
    // What is not a credential survives.
    expect(report.html).toContain('per-layer');
  });

  it('loads nothing from the network, so it opens offline in ten years (R15)', () => {
    const report = buildReport({ ...base, targetFormatName: 'GeoJSON' });
    expect(report.html).not.toMatch(/<script/i);
    expect(report.html).not.toMatch(/https?:\/\//);
    expect(report.html).not.toMatch(/<link/i);
    expect(report.html).toContain('<style>');
  });

  it('renders the predicted fidelity per axis', () => {
    const data = dataset([polygon('A', square(), { plot_no: '12/A' })]);
    const report = buildReport({ ...base, dataset: data, prediction: predictConversion(data, 'shapefile'), targetFormatName: 'Shapefile' });
    expect(report.html).toContain('Predicted fidelity');
    expect(report.text).toContain('PREDICTED FIDELITY');
  });

  it('renders the health score with its components and their findings', () => {
    const data = dataset([polygon('A', square())], { crs: null, crsOrigin: 'unknown' });
    const report = buildReport({ ...base, dataset: data, health: assessHealth(data) });

    expect(report.html).toContain('Project health');
    expect(report.html).toContain('CRS certainty');
    // The drill-down, not just the number.
    expect(report.html).toContain('Health findings');
    expect(report.html).toContain('not evaluated');
  });

  it('produces attachable files for the delivery', () => {
    const files = reportFiles(buildReport(base), 'plots');
    expect(files.map((file) => file.name)).toEqual(['plots.report.html', 'plots.report.txt']);
    expect(files[0].mimeType).toBe('text/html');
    expect(new TextDecoder().decode(files[0].bytes)).toContain('<!DOCTYPE html>');
  });

  it('says plainly that nothing left the machine', () => {
    const report = buildReport(base);
    expect(report.html).toContain('Entirely on this machine');
  });

  it('comes out of a real conversion and lands in the delivery', async () => {
    // End to end: the report has to describe the bytes that were written, and
    // the only proof of that is running the pipeline.
    const geojson = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { plot_no: '12/A' }, geometry: { type: 'Polygon', coordinates: [square()] } }],
    });

    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(geojson) },
      targetFormatId: 'geojson',
      settings: { ...PIPELINE_DEFAULTS, runQa: true, assessHealth: true, embedReport: true },
    });

    expect(result.health).toBeDefined();
    expect(result.report).toBeDefined();
    expect(result.report!.html).toContain('Conversion report');
    expect(result.report!.html).toContain('GeoJSON');

    // Both files reach the delivery, alongside the converted data itself.
    const names = result.outputs.map((output) => output.name);
    expect(names.some((name) => name.endsWith('.report.html'))).toBe(true);
    expect(names.some((name) => name.endsWith('.report.txt'))).toBe(true);
  });

  it('adds nothing to the delivery unless it was asked for', async () => {
    const geojson = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [square()] } }],
    });

    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(geojson) },
      targetFormatId: 'geojson',
      settings: { ...PIPELINE_DEFAULTS, runQa: false },
    });

    expect(result.report).toBeUndefined();
    expect(result.health).toBeUndefined();
    expect(result.outputs.every((output) => !output.name.includes('.report.'))).toBe(true);
  });

  it('assesses health on the source, not on the output', async () => {
    // Assessing the output would report the conversion's own compromises back
    // as defects in the user's data, which is the opposite of a work list.
    const geojson = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [square(0, 0, 10)] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [square(5, 5, 10)] } },
      ],
    });

    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(geojson) },
      targetFormatId: 'geojson',
      settings: { ...PIPELINE_DEFAULTS, runQa: true, assessHealth: true },
    });

    // The overlapping parcels are in the SOURCE, so health must see them.
    const topology = result.health!.components.find((component) => component.id === 'topology')!;
    expect(topology.findings.length).toBeGreaterThan(0);
  });
});
