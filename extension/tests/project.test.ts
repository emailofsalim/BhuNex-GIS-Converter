/**
 * Operation history, workflows, the project file and the geometry overlay
 * (spec §30.1, §31.1, §31.2, §31.4).
 *
 * Three of these tests exist to guard rules rather than behaviour, and those
 * are the ones not to simplify:
 *
 *  - A workflow step that would prompt by hand must still prompt on replay
 *    (R18). The test drives the runner with no confirmation handler and asserts
 *    it REFUSES rather than proceeds.
 *  - Undo must be exact, and undo/redo must be symmetric (R19). The test walks
 *    a stack of unrelated operations forwards and backwards and compares
 *    coordinates, not summaries.
 *  - A project file must not carry credentials (R23), including ones nested
 *    inside settings rather than sitting at the top level.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type Position, type SourceInfo } from '@core/cir';
import {
  applyChange,
  canRedo,
  canUndo,
  checkpointPosition,
  createHistory,
  describeEntry,
  diffDatasets,
  markCheckpoint,
  nextUndoLabel,
  recordOperation,
  redo,
  restoreHistory,
  revertTo,
  snapshotHistory,
  undo,
} from '@core/history';
import {
  buildProject,
  canEmbed,
  decodeBase64,
  encodeBase64,
  matchSources,
  projectIsRestorable,
  readProject,
  summariseMatches,
  writeProject,
  type ProjectSource,
} from '@core/project';
import { looksLikeSecret, stripSecrets, stripSecretsDeep } from '@core/secrets';
import {
  describeWorkflow,
  pendingConfirmations,
  recordWorkflow,
  runWorkflow,
  stepConfirmation,
  unattendedRisks,
  validateWorkflow,
  type Workflow,
  type WorkflowSettings,
} from '@core/workflow';
import { buildGeometryOverlay } from '@qa/geometry-overlay';
import { convert, DEFAULT_SETTINGS as PIPELINE_DEFAULTS } from '@core/pipeline';
import { FULL_PRECISION, fixedPrecision } from '@core/precision';
import { crsFromEpsg } from '@crs/epsg';

const SOURCE: SourceInfo = { fileName: 'plots.dxf', size: 2048, formatId: 'dxf', formatName: 'AutoCAD DXF', detectionConfidence: 1 };

function polygon(id: string, ring: Position[], properties: Record<string, unknown> = {}): CirFeature {
  return { id, geometry: { type: 'Polygon', coordinates: [ring], dimension: 2 }, properties };
}

function square(x = 0, y = 0, size = 10): Position[] {
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

function dataset(features: CirFeature[], layerName = 'Plots'): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'plots',
    source: SOURCE,
    crs: crsFromEpsg(32645),
    crsOrigin: 'declared',
    layers: [createLayer(layerName, features)],
  });
}

/** Rewrites one feature, leaving every other object identical by reference. */
function editFeature(base: CirDataset, index: number, geometry: CirFeature['geometry']): CirDataset {
  const layer = base.layers[0];
  const features = layer.features.slice();
  features[index] = { ...features[index], geometry };
  return { ...base, layers: [{ ...layer, features }] };
}

// ---------------------------------------------------------------------------
// Operation history (§31.1, R19)
// ---------------------------------------------------------------------------

describe('operation history', () => {
  it('records only the features that actually changed', () => {
    const before = dataset([polygon('A', square()), polygon('B', square(100)), polygon('C', square(200))]);
    const after = editFeature(before, 1, { type: 'Polygon', coordinates: [square(100, 0, 11)], dimension: 2 });

    const change = diffDatasets(before, after);
    expect(change.features).toHaveLength(1);
    expect(change.features[0].index).toBe(1);
    expect(change.layers).toHaveLength(0);
  });

  it('sees no change when an engine rebuilds objects without altering them', () => {
    const before = dataset([polygon('A', square()), polygon('B', square(100))]);
    // A rebuilt-but-identical dataset: every object differs by reference.
    const rebuilt: CirDataset = {
      ...before,
      layers: before.layers.map((layer) => ({
        ...layer,
        features: layer.features.map((feature) => ({ ...feature, geometry: { ...feature.geometry! } })),
      })),
    };

    expect(diffDatasets(before, rebuilt).features).toHaveLength(0);
  });

  it('undoes and redoes an operation exactly', () => {
    const original = dataset([polygon('A', square())]);
    const moved = editFeature(original, 0, { type: 'Polygon', coordinates: [square(5, 5)], dimension: 2 });

    let history = recordOperation(createHistory(), original, moved, { kind: 'edit', label: 'Move parcel A' });
    expect(canUndo(history)).toBe(true);
    expect(nextUndoLabel(history)).toBe('Move parcel A');

    const back = undo(history, moved);
    expect(back.dataset.layers[0].features[0].geometry!.coordinates).toEqual([square()]);
    expect(canRedo(back.history)).toBe(true);

    const forward = redo(back.history, back.dataset);
    expect(forward.dataset.layers[0].features[0].geometry!.coordinates).toEqual([square(5, 5)]);
    history = forward.history;
    expect(canRedo(history)).toBe(false);
  });

  it('reverses a stack of unrelated operations in the right order', () => {
    const v0 = dataset([polygon('A', square()), polygon('B', square(100))]);
    const v1 = editFeature(v0, 0, { type: 'Polygon', coordinates: [square(1, 1)], dimension: 2 });
    const v2 = { ...v1, crs: crsFromEpsg(4326) };
    const v3 = editFeature(v2, 1, { type: 'Polygon', coordinates: [square(101, 1)], dimension: 2 });

    let history = createHistory();
    history = recordOperation(history, v0, v1, { kind: 'edit', label: 'Move A' });
    history = recordOperation(history, v1, v2, { kind: 'reproject', label: 'Reproject to WGS 84' });
    history = recordOperation(history, v2, v3, { kind: 'edit', label: 'Move B' });

    // All the way back to the imported state.
    const start = revertTo(history, v3, 0);
    expect(start.dataset.layers[0].features[0].geometry!.coordinates).toEqual([square()]);
    expect(start.dataset.layers[0].features[1].geometry!.coordinates).toEqual([square(100)]);
    expect(start.dataset.crs?.epsg).toBe(32645);

    // And forward again to the top.
    const end = revertTo(start.history, start.dataset, 3);
    expect(end.dataset.layers[0].features[0].geometry!.coordinates).toEqual([square(1, 1)]);
    expect(end.dataset.layers[0].features[1].geometry!.coordinates).toEqual([square(101, 1)]);
    expect(end.dataset.crs?.epsg).toBe(4326);
  });

  it('reverses a feature that an operation appended', () => {
    const before = dataset([polygon('A', square())]);
    const after: CirDataset = {
      ...before,
      layers: [{ ...before.layers[0], features: [...before.layers[0].features, polygon('B', square(50)), polygon('C', square(70))] }],
    };

    const history = recordOperation(createHistory(), before, after, { kind: 'polygonize', label: 'Build polygons' });
    const back = undo(history, after);
    expect(back.dataset.layers[0].features).toHaveLength(1);

    const forward = redo(back.history, back.dataset);
    expect(forward.dataset.layers[0].features.map((feature) => feature.id)).toEqual(['A', 'B', 'C']);
  });

  it('reverses a whole layer an operation added', () => {
    const before = dataset([polygon('A', square())]);
    const after: CirDataset = { ...before, layers: [...before.layers, createLayer('Labels', [polygon('L', square(5))])] };

    const history = recordOperation(createHistory(), before, after, { kind: 'burn-in', label: 'Attach text' });
    expect(history.entries[0].change.layers).toHaveLength(1);

    const back = undo(history, after);
    expect(back.dataset.layers.map((layer) => layer.name)).toEqual(['Plots']);

    const forward = redo(back.history, back.dataset);
    expect(forward.dataset.layers.map((layer) => layer.name)).toEqual(['Plots', 'Labels']);
  });

  it('discards the redo branch when new work is done after an undo', () => {
    const v0 = dataset([polygon('A', square())]);
    const v1 = editFeature(v0, 0, { type: 'Polygon', coordinates: [square(1, 1)], dimension: 2 });

    let history = recordOperation(createHistory(), v0, v1, { kind: 'edit', label: 'Move A' });
    const back = undo(history, v1);
    expect(canRedo(back.history)).toBe(true);

    const v2 = editFeature(v0, 0, { type: 'Polygon', coordinates: [square(2, 2)], dimension: 2 });
    history = recordOperation(back.history, back.dataset, v2, { kind: 'edit', label: 'Move A differently' });
    expect(canRedo(history)).toBe(false);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].label).toBe('Move A differently');
  });

  it('drops the oldest entries at the limit and says how many', () => {
    let history = createHistory();
    let current = dataset([polygon('A', square())]);
    for (let step = 1; step <= 5; step++) {
      const next = editFeature(current, 0, { type: 'Polygon', coordinates: [square(step, step)], dimension: 2 });
      history = recordOperation(history, current, next, { kind: 'edit', label: `Move ${step}` }, { limit: 3 });
      current = next;
    }

    expect(history.entries).toHaveLength(3);
    expect(history.dropped).toBe(2);
    expect(history.entries[0].label).toBe('Move 3');
  });

  it('returns to a named checkpoint', () => {
    const v0 = dataset([polygon('A', square())]);
    const v1 = editFeature(v0, 0, { type: 'Polygon', coordinates: [square(1, 1)], dimension: 2 });
    const v2 = editFeature(v1, 0, { type: 'Polygon', coordinates: [square(2, 2)], dimension: 2 });

    let history = recordOperation(createHistory(), v0, v1, { kind: 'repair', label: 'Close rings' });
    history = markCheckpoint(history, 'after repair');
    history = recordOperation(history, v1, v2, { kind: 'edit', label: 'Move A' });

    const position = checkpointPosition(history, 'after repair');
    expect(position).toBe(1);
    const at = revertTo(history, v2, position!);
    expect(at.dataset.layers[0].features[0].geometry!.coordinates).toEqual([square(1, 1)]);
  });

  it('survives a save and reload with its undo stack intact', () => {
    const v0 = dataset([polygon('A', square())]);
    const v1 = editFeature(v0, 0, { type: 'Polygon', coordinates: [square(3, 3)], dimension: 2 });
    const history = recordOperation(createHistory(), v0, v1, { kind: 'edit', label: 'Move A' });

    const reloaded = restoreHistory(JSON.parse(JSON.stringify(snapshotHistory(history))));
    expect(canUndo(reloaded)).toBe(true);
    const back = undo(reloaded, v1);
    expect(back.dataset.layers[0].features[0].geometry!.coordinates).toEqual([square()]);
  });

  it('describes an entry with the number a surveyor judges it by', () => {
    const before = dataset([polygon('A', square())]);
    const after = editFeature(before, 0, { type: 'Polygon', coordinates: [square(0, 0, 10.004)], dimension: 2 });
    const history = recordOperation(before === after ? createHistory() : createHistory(), before, after, {
      kind: 'repair',
      label: 'Snap vertices',
      maxDisplacement: 0.004,
    });

    expect(describeEntry(history.entries[0])).toContain('moved at most 0.00400');
  });

  it('applies a change set symmetrically in both directions', () => {
    const before = dataset([polygon('A', square())]);
    const after = editFeature(before, 0, { type: 'Polygon', coordinates: [square(9, 9)], dimension: 2 });
    const change = diffDatasets(before, after);

    expect(applyChange(after, change, 'before').layers[0].features[0].geometry!.coordinates).toEqual([square()]);
    expect(applyChange(before, change, 'after').layers[0].features[0].geometry!.coordinates).toEqual([square(9, 9)]);
  });
});

// ---------------------------------------------------------------------------
// Workflows (§31.2, R18)
// ---------------------------------------------------------------------------

const CADASTRAL: WorkflowSettings = {
  sourceCrsEpsg: 32645,
  polygonizeEnabled: true,
  polygonizeTolerance: 0.01,
  polygonizeKeepLines: false,
  burnInEnabled: true,
  burnInField: 'plot_no',
  burnInMode: 'attribute',
  burnInReplaceSource: true,
  targetCrsEpsg: 4326,
  globalTargetFormatId: 'kmz',
  kmlTemplate: 'cadastral',
  precisionMode: 'full',
  outputLayout: 'per-layer',
  runQa: true,
};

describe('workflow recording and replay', () => {
  it('records the whole cadastral job in the order the pipeline runs it', () => {
    const workflow = recordWorkflow(CADASTRAL, { name: 'CAD Parcel to KMZ', recordedFrom: 'dxf' });
    expect(workflow.steps.map((step) => step.kind)).toEqual([
      'assign-source-crs',
      'polygonize',
      'burn-in',
      'reproject',
      'precision',
      'layout',
      'style',
      'target-format',
      'run-qa',
    ]);
  });

  it('never records a step as unattended, whatever the settings were', () => {
    const workflow = recordWorkflow(CADASTRAL, { name: 'CAD Parcel to KMZ' });
    expect(workflow.steps.every((step) => !step.unattended)).toBe(true);
    expect(unattendedRisks(workflow)).toHaveLength(0);
  });

  it('refuses steps that need confirming when the run has no way to ask (R18)', async () => {
    const workflow = recordWorkflow(CADASTRAL, { name: 'CAD Parcel to KMZ' });
    const result = await runWorkflow(workflow);

    const refused = result.results.filter((entry) => entry.outcome === 'refused').map((entry) => entry.step.kind);
    expect(refused).toEqual(expect.arrayContaining(['assign-source-crs', 'polygonize', 'burn-in']));
    expect(result.complete).toBe(false);
    // The refusal must not silently leave the destructive settings applied.
    expect(result.settings.polygonizeEnabled).toBeUndefined();
    expect(result.settings.burnInReplaceSource).toBeUndefined();
    // Steps that never prompt still run.
    expect(result.settings.globalTargetFormatId).toBe('kmz');
    expect(result.summary).toContain('refused');
  });

  it('applies every step when the prompts are accepted', async () => {
    const workflow = recordWorkflow(CADASTRAL, { name: 'CAD Parcel to KMZ' });
    const asked: string[] = [];
    const result = await runWorkflow(workflow, {
      confirm: (request) => {
        asked.push(request.step.kind);
        return true;
      },
    });

    expect(asked).toEqual(['assign-source-crs', 'polygonize', 'burn-in']);
    expect(result.complete).toBe(true);
    expect(result.settings.polygonizeEnabled).toBe(true);
    expect(result.settings.burnInReplaceSource).toBe(true);
    expect(result.settings.targetCrsEpsg).toBe(4326);
  });

  it('skips a declined step and says so rather than pretending it ran', async () => {
    const workflow = recordWorkflow(CADASTRAL, { name: 'CAD Parcel to KMZ' });
    const result = await runWorkflow(workflow, { confirm: (request) => request.step.kind !== 'burn-in' });

    expect(result.settings.polygonizeEnabled).toBe(true);
    expect(result.settings.burnInEnabled).toBeUndefined();
    expect(result.complete).toBe(false);
    expect(result.summary).toContain('Attach text to polygons');
    expect(result.summary).toContain('declined');
  });

  it('runs an explicitly unattended step without asking', async () => {
    const workflow = recordWorkflow(CADASTRAL, { name: 'CAD Parcel to KMZ' });
    const polygonise = workflow.steps.find((step) => step.kind === 'polygonize')!;
    polygonise.unattended = true;

    const asked: string[] = [];
    await runWorkflow(workflow, {
      confirm: (request) => {
        asked.push(request.step.kind);
        return true;
      },
    });

    expect(asked).not.toContain('polygonize');
    expect(unattendedRisks(workflow).map((entry) => entry.step.kind)).toEqual(['polygonize']);
  });

  it('decides the prompt from the settings, not from a flag beside them', () => {
    // A hand-edited workflow claiming a burn-in that deletes source text is
    // harmless must still prompt.
    const forged: Workflow = {
      id: 'wf-forged',
      name: 'Forged',
      purpose: '',
      createdAt: 0,
      steps: [
        {
          id: 's1',
          kind: 'burn-in',
          label: 'Attach text',
          settings: { burnInEnabled: true, burnInField: 'plot_no', burnInReplaceSource: true },
        },
      ],
    };

    expect(stepConfirmation(forged.steps[0])).not.toBeNull();
    expect(pendingConfirmations(forged)).toHaveLength(1);
  });

  it('does not prompt for a burn-in that keeps the source text', () => {
    const workflow = recordWorkflow({ ...CADASTRAL, burnInReplaceSource: false }, { name: 'Non-destructive' });
    const step = workflow.steps.find((entry) => entry.kind === 'burn-in')!;
    expect(stepConfirmation(step)).toBeNull();
  });

  it('derives the snapping prompt from the safe-operations list', () => {
    const workflow = recordWorkflow({ snapTolerance: 0.05 }, { name: 'Snap' });
    const step = workflow.steps.find((entry) => entry.kind === 'repair')!;
    expect(stepConfirmation(step)?.what).toContain('vertex snapping at 0.05');

    // Close-rings alone is in SAFE_OPERATIONS, so it does not prompt.
    const safe = recordWorkflow({ repairCloseRings: true }, { name: 'Close' });
    expect(stepConfirmation(safe.steps.find((entry) => entry.kind === 'repair')!)).toBeNull();
  });

  it('refuses to save a KML workflow that does not reproject to WGS 84', () => {
    const workflow = recordWorkflow({ globalTargetFormatId: 'kmz', targetCrsEpsg: 32645 }, { name: 'Wrong world' });
    const problems = validateWorkflow(workflow);
    expect(problems.some((problem) => problem.severity === 'error' && problem.message.includes('EPSG:4326'))).toBe(true);
  });

  it('passes a KML workflow that does reproject', () => {
    const workflow = recordWorkflow(CADASTRAL, { name: 'CAD Parcel to KMZ' });
    expect(validateWorkflow(workflow).filter((problem) => problem.severity === 'error')).toHaveLength(0);
  });

  it('warns when a destructive step is marked unattended', () => {
    const workflow = recordWorkflow(CADASTRAL, { name: 'CAD Parcel to KMZ' });
    workflow.steps.find((step) => step.kind === 'burn-in')!.unattended = true;
    const problems = validateWorkflow(workflow);
    expect(problems.some((problem) => problem.severity === 'warning' && problem.message.includes('unattended'))).toBe(true);
  });

  it('marks in its description which steps will ask', () => {
    const lines = describeWorkflow(recordWorkflow(CADASTRAL, { name: 'CAD Parcel to KMZ' }));
    expect(lines.filter((line) => line.includes('asks first'))).toHaveLength(3);
    expect(lines[0]).toMatch(/^1\. /);
  });
});

// ---------------------------------------------------------------------------
// The project file (§31.4, R23)
// ---------------------------------------------------------------------------

function projectSource(overrides: Partial<ProjectSource> = {}): ProjectSource {
  return {
    id: 'src-1',
    fileName: 'plots.dxf',
    path: 'Delivery/Survey/plots.dxf',
    containers: [],
    size: 2048,
    sha256: 'a'.repeat(64),
    formatId: 'dxf',
    formatName: 'AutoCAD DXF',
    detectionConfidence: 1,
    crs: crsFromEpsg(32645),
    crsOrigin: 'user',
    carriage: 'reference',
    ...overrides,
  };
}

const EXPORT_CONFIG = {
  globalTargetFormatId: 'kmz',
  outputLayout: 'per-layer',
  naming: 'converted-to',
  mirrorBatchTree: true,
  embedMetadata: false,
};

describe('the project file', () => {
  it('round-trips through bytes without losing the editing state', () => {
    const v0 = dataset([polygon('A', square())]);
    const v1 = editFeature(v0, 0, { type: 'Polygon', coordinates: [square(4, 4)], dimension: 2 });
    const history = recordOperation(createHistory(), v0, v1, { kind: 'edit', label: 'Move A' });

    const project = buildProject({
      name: 'Bhopal cadastral',
      productVersion: '1.0.0',
      settings: { precisionMode: 'full', targetCrsEpsg: 4326 },
      sources: [projectSource({ history: snapshotHistory(history) })],
      workflows: [recordWorkflow(CADASTRAL, { name: 'CAD Parcel to KMZ' })],
      exportConfig: EXPORT_CONFIG,
      now: new Date('2026-09-07T10:00:00Z'),
    });

    const result = readProject(writeProject(project));
    expect(result.error).toBeUndefined();
    expect(result.project?.name).toBe('Bhopal cadastral');
    expect(result.project?.savedAt).toBe('2026-09-07T10:00:00.000Z');
    expect(result.project?.workflows[0].steps).toHaveLength(9);

    // The undo stack still reverses the edit after the round trip.
    const reloaded = restoreHistory(result.project!.sources[0].history);
    expect(undo(reloaded, v1).dataset.layers[0].features[0].geometry!.coordinates).toEqual([square()]);
  });

  it('never writes a credential, however deeply it is nested (R23)', () => {
    const project = buildProject({
      name: 'Job',
      productVersion: '1.0.0',
      settings: {
        precisionMode: 'full',
        publish: { endpoint: 'https://example.test/upload', api_key: 'sk-abcdefghijklmnop0123' },
        note: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload',
      },
      sources: [projectSource()],
      exportConfig: EXPORT_CONFIG,
    });

    const text = new TextDecoder().decode(writeProject(project));
    expect(text).not.toContain('sk-abcdefghijklmnop0123');
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(project.droppedSecretFields).toEqual(['api_key', 'note']);
    // What survives is the part that is not a credential.
    expect((project.settings.publish as Record<string, unknown>).endpoint).toBe('https://example.test/upload');
  });

  it('tells the user what it removed rather than dropping fields silently', () => {
    const project = buildProject({
      name: 'Job',
      productVersion: '1.0.0',
      settings: { access_token: 'x'.repeat(40) },
      sources: [projectSource()],
      exportConfig: EXPORT_CONFIG,
    });

    const result = readProject(writeProject(project));
    expect(result.notes.some((note) => note.includes('access_token'))).toBe(true);
  });

  it('refuses a project written by a newer build instead of guessing', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ formatVersion: 99, sources: [] }));
    const result = readProject(bytes);
    expect(result.project).toBeNull();
    expect(result.error?.what).toContain('newer version');
    expect(result.error?.action).toContain('Update the extension');
  });

  it('explains what a file is when it is not a project at all', () => {
    expect(readProject(new TextEncoder().encode('not json at all')).error?.why).toContain('not valid JSON');
    expect(readProject(new TextEncoder().encode('[1,2,3]')).error?.what).toContain('not a project');
    expect(readProject(new TextEncoder().encode('{"hello":"world"}')).error?.why).toContain('no format version');
  });

  it('matches re-supplied sources by content hash, not by name', () => {
    const project = buildProject({
      name: 'Job',
      productVersion: '1.0.0',
      settings: {},
      sources: [projectSource()],
      exportConfig: EXPORT_CONFIG,
    });

    const same = matchSources(project, [
      { fileName: 'plots.dxf', path: 'Delivery/Survey/plots.dxf', size: 2048, sha256: 'a'.repeat(64) },
    ]);
    expect(same[0].state).toBe('same');
    expect(projectIsRestorable(same)).toBe(true);

    // Same name, same size, different bytes: a re-export from the CAD file.
    const changed = matchSources(project, [
      { fileName: 'plots.dxf', path: 'Delivery/Survey/plots.dxf', size: 2048, sha256: 'b'.repeat(64) },
    ]);
    expect(changed[0].state).toBe('changed');
    expect(changed[0].note).toContain('different geometry');
    expect(projectIsRestorable(changed)).toBe(false);
  });

  it('calls an unhashable match unverifiable rather than the same', () => {
    const project = buildProject({
      name: 'Job',
      productVersion: '1.0.0',
      settings: {},
      sources: [projectSource({ sha256: undefined })],
      exportConfig: EXPORT_CONFIG,
    });

    const matches = matchSources(project, [{ fileName: 'plots.dxf', size: 2048 }]);
    expect(matches[0].state).toBe('unverifiable');
    expect(projectIsRestorable(matches)).toBe(false);
  });

  it('reports a source that was not supplied', () => {
    const project = buildProject({
      name: 'Job',
      productVersion: '1.0.0',
      settings: {},
      sources: [projectSource(), projectSource({ id: 'src-2', fileName: 'levels.csv', sha256: 'c'.repeat(64) })],
      exportConfig: EXPORT_CONFIG,
    });

    const matches = matchSources(project, [{ fileName: 'plots.dxf', size: 2048, sha256: 'a'.repeat(64) }]);
    expect(matches.map((match) => match.state)).toEqual(['same', 'missing']);
    expect(summariseMatches(matches)).toBe('1 restored, 1 not supplied.');
  });

  it('picks the file from the same folder when two share a name', () => {
    const project = buildProject({
      name: 'Job',
      productVersion: '1.0.0',
      settings: {},
      sources: [projectSource({ sha256: 'z'.repeat(64) })],
      exportConfig: EXPORT_CONFIG,
    });

    const matches = matchSources(project, [
      { fileName: 'plots.dxf', path: 'Other/plots.dxf', size: 99, sha256: 'q'.repeat(64) },
      { fileName: 'plots.dxf', path: 'Delivery/Survey/plots.dxf', size: 2048, sha256: 'r'.repeat(64) },
    ]);
    expect(matches[0].state).toBe('changed');
    expect(matches[0].suppliedName).toBe('plots.dxf');
  });

  it('carries an embedded source without needing the file again', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const project = buildProject({
      name: 'Job',
      productVersion: '1.0.0',
      settings: {},
      sources: [projectSource({ carriage: 'embedded', data: encodeBase64(bytes) })],
      exportConfig: EXPORT_CONFIG,
    });

    const matches = matchSources(project, []);
    expect(matches[0].state).toBe('same');
    expect(decodeBase64(readProject(writeProject(project)).project!.sources[0].data!)).toEqual(bytes);
  });

  it('bounds what may be embedded', () => {
    expect(canEmbed(1024)).toBe(true);
    expect(canEmbed(40 * 1024 * 1024)).toBe(false);
  });

  it('encodes bytes past the argument limit without throwing', () => {
    const big = new Uint8Array(200_000);
    for (let index = 0; index < big.length; index++) big[index] = index % 256;
    expect(decodeBase64(encodeBase64(big))).toEqual(big);
  });
});

describe('credential detection', () => {
  it('catches a secret by its field name whatever it holds', () => {
    expect(looksLikeSecret('api_key', 'anything')).toBe(true);
    expect(looksLikeSecret('sessionId', 42)).toBe(true);
    expect(looksLikeSecret('plot_no', '12/A')).toBe(false);
  });

  it('catches a secret by its value whatever it is called', () => {
    expect(looksLikeSecret('note', 'AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksLikeSecret('link', 'https://example.test/x?token=abc')).toBe(true);
    expect(looksLikeSecret('note', 'the bearer of this plan is the owner')).toBe(false);
  });

  it('catches a bearer token in the capitalisation HTTP actually uses', () => {
    // The pattern was case-sensitive and matched only a lower-case `bearer `,
    // which is the one form nobody ever pastes. Both must be caught.
    expect(looksLikeSecret('remark', 'Bearer eyJhbGciOiJIUzI1NiJ9.payload')).toBe(true);
    expect(looksLikeSecret('remark', 'bearer eyJhbGciOiJIUzI1NiJ9.payload')).toBe(true);
    expect(looksLikeSecret('remark', 'BEARER abc123def456')).toBe(true);
  });

  it('reports what it dropped', () => {
    const { safe, dropped } = stripSecrets({ plot_no: '12/A', password: 'hunter2' });
    expect(safe).toEqual({ plot_no: '12/A' });
    expect(dropped).toEqual(['password']);
  });

  it('does not hang on a structure that references itself', () => {
    const looping: Record<string, unknown> = { name: 'job' };
    looping.self = looping;
    expect(() => stripSecretsDeep(looping)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The geometry overlay (§30.1)
// ---------------------------------------------------------------------------

describe('geometry overlay', () => {
  it('finds nothing to draw when the output matches the source', () => {
    const overlay = buildGeometryOverlay(dataset([polygon('A', square())]), dataset([polygon('A', square())]));
    expect(overlay.items).toHaveLength(0);
    expect(overlay.counts.unchanged).toBe(1);
    expect(overlay.summary).toContain('same place');
  });

  it('marks a moved feature with where and how far', () => {
    const source = dataset([polygon('A', square())]);
    const output = dataset([polygon('A', [[0, 0], [10, 0], [10, 10], [0, 10.25], [0, 0]])]);

    const overlay = buildGeometryOverlay(source, output);
    expect(overlay.items).toHaveLength(1);
    expect(overlay.items[0].role).toBe('moved');
    expect(overlay.items[0].displacement).toBeCloseTo(0.25, 10);
    expect(overlay.items[0].at).toEqual([0, 10]);
    expect(overlay.maxDisplacement).toBeCloseTo(0.25, 10);
  });

  it('treats movement inside the tolerance as unchanged', () => {
    const source = dataset([polygon('A', square())]);
    const output = dataset([polygon('A', [[0, 0], [10, 0], [10, 10], [0, 10.0004], [0, 0]])]);

    const overlay = buildGeometryOverlay(source, output, { tolerance: 0.001 });
    expect(overlay.counts.moved).toBe(0);
    expect(overlay.counts.unchanged).toBe(1);
  });

  it('refuses to pair a layer whose feature counts differ', () => {
    const source = dataset([polygon('A', square()), polygon('B', square(100))]);
    const output = dataset([polygon('A', square(50))]);

    const overlay = buildGeometryOverlay(source, output);
    expect(overlay.unpaired).toHaveLength(1);
    expect(overlay.unpaired[0]).toMatchObject({ layer: 'Plots', sourceFeatures: 2, outputFeatures: 1 });
    // Nothing is called "moved", because there is no correspondence to measure.
    expect(overlay.counts.moved).toBe(0);
    // The surplus feature is still shown as source-only.
    expect(overlay.counts.removed).toBe(1);
    expect(overlay.summary).toContain('could not be paired');
  });

  it('calls a vertex count change a shape change, not a move', () => {
    const source = dataset([polygon('A', square())]);
    const output = dataset([polygon('A', [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10], [0, 0]])]);

    const overlay = buildGeometryOverlay(source, output);
    expect(overlay.items[0].role).toBe('retyped');
    expect(overlay.items[0].note).toContain('vertex counts differ');
    expect(overlay.items[0].displacement).toBeUndefined();
  });

  it('reports a geometry type change with both types', () => {
    const source = dataset([polygon('A', square())]);
    const output = dataset([{ id: 'A', geometry: { type: 'LineString', coordinates: square(), dimension: 2 }, properties: {} }]);

    const overlay = buildGeometryOverlay(source, output);
    expect(overlay.items[0].role).toBe('retyped');
    expect(overlay.items[0].note).toBe('Polygon became LineString.');
  });

  it('reports a layer that did not survive the conversion', () => {
    const source: CirDataset = {
      ...dataset([polygon('A', square())]),
      layers: [createLayer('Plots', [polygon('A', square())]), createLayer('Text', [polygon('T', square(2))])],
    };
    const output = dataset([polygon('A', square())]);

    const overlay = buildGeometryOverlay(source, output);
    expect(overlay.layersRemoved).toEqual(['Text']);
    expect(overlay.counts.removed).toBe(1);
    expect(overlay.items.find((item) => item.layer === 'Text')?.note).toContain('not in the output');
  });

  it('comes out of a real conversion, computed from the bytes that were written', async () => {
    // End to end rather than against a hand-built pair: the overlay is only
    // worth anything if it describes the file the user will hand over, and the
    // only proof of that is running the pipeline.
    const geojson = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { plot_no: '12/A' }, geometry: { type: 'Polygon', coordinates: [square()] } },
        { type: 'Feature', properties: { plot_no: '12/B' }, geometry: { type: 'Polygon', coordinates: [square(20)] } },
      ],
    });

    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(geojson) },
      targetFormatId: 'geojson',
      settings: { ...PIPELINE_DEFAULTS, precision: FULL_PRECISION, runQa: true },
    });

    expect(result.outputDataset).toBeDefined();
    expect(result.overlay).toBeDefined();
    // A GeoJSON round trip at full precision changes nothing, and the overlay
    // must say exactly that rather than inventing a difference.
    expect(result.overlay!.counts.moved).toBe(0);
    expect(result.overlay!.counts.unchanged).toBe(2);
    expect(result.overlay!.items).toHaveLength(0);
    expect(result.overlay!.unpaired).toHaveLength(0);
  });

  it('does not report the rounding the user asked for as a defect', async () => {
    const geojson = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10.4567], [0, 10], [0, 0]]] },
        },
      ],
    });

    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(geojson) },
      targetFormatId: 'geojson',
      settings: { ...PIPELINE_DEFAULTS, precision: fixedPrecision(1), runQa: true },
    });

    // Writing at one decimal place cannot move a vertex by more than 0.05, and
    // the overlay is judged against the 0.1 that precision implies. So the
    // rounding the user explicitly requested is silent — an overlay that lit up
    // every vertex the moment someone chose fixed precision would be noise, and
    // noise is what stops people looking at the one that matters.
    expect(result.overlay!.counts.moved).toBe(0);
    expect(result.overlay!.counts.unchanged).toBe(1);
    expect(result.overlay!.tolerance).toBeCloseTo(0.1, 10);

    // The movement is nonetheless real, and measuring against a tighter
    // tolerance finds it — the geometry is not being silently equated.
    // 10.4567 rounds to 10.5, so the vertex moved 0.0433 — under the 0.05 that
    // one decimal place can ever cost, which is why the check above is silent.
    const strict = buildGeometryOverlay(result.sourceDataset, result.outputDataset!, { tolerance: 0.001 });
    expect(strict.counts.moved).toBe(1);
    expect(strict.maxDisplacement).toBeCloseTo(0.0433, 4);
    expect(strict.items[0].at).toEqual([10, 10.4567]);
  });

  it('caps the items it builds but keeps the counts exact', () => {
    const many = Array.from({ length: 40 }, (_, index) => polygon(`P${index}`, square(index * 20)));
    const moved = many.map((_, index) => polygon(`P${index}`, square(index * 20 + 1)));

    const overlay = buildGeometryOverlay(dataset(many), dataset(moved), { limit: 10 });
    expect(overlay.items).toHaveLength(10);
    expect(overlay.omitted).toBe(30);
    expect(overlay.counts.moved).toBe(40);
  });
});
