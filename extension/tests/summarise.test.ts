/**
 * The shape handed to the workspace must not depend on the file's SIZE.
 *
 * `workers/client.ts` splits on `WORKER_THRESHOLD_BYTES`: a file at or above it
 * goes to the worker, anything under it is read inline on the main thread. Both
 * branches feed the same panels, so both must produce the same shape.
 *
 * They did not. The worker returned `summarise(dataset)` — layers carrying
 * `preview` and `featureCount` — and the inline branch returned the raw CIR,
 * whose layers carry `features` and neither of those keys. Every file under
 * 2 MB therefore imported "successfully" and drew an EMPTY CANVAS with a
 * feature count of 0, with the real features sitting in a key no panel reads.
 * The geometry tab additionally threw on `featureCount.toLocaleString()`.
 *
 * That is the worst shape of bug this project keeps producing: the engine is
 * correct, the data is there, and the hand-off to the thing that displays it is
 * wrong — so it fails silently and looks like a conversion problem.
 *
 * These tests assert the contract directly: what `summarise` promises, and that
 * the panels' two accessors find what they need in it.
 */

import { describe, expect, it } from 'vitest';
import { createLayer, type CirDataset, type CirFeature } from '@core/cir';
import { summarise } from '@workers/summarise';

function square(x: number, y: number): CirFeature {
  return {
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10], [x, y]]], dimension: 2 },
    properties: { plot_no: `${x}/${y}` },
  };
}

function datasetOf(count: number): CirDataset {
  const features = Array.from({ length: count }, (_, index) => square(index * 20, 0));
  return {
    kind: 'vector',
    name: 'plots',
    layers: [createLayer('plots', features, [{ name: 'plot_no', type: 'string' }])],
    warnings: [],
  } as unknown as CirDataset;
}

describe('the summarised dataset the workspace renders', () => {
  it('carries the keys every panel reads', () => {
    const summary = summarise(datasetOf(12));
    const layer = summary.layers[0];

    // The three the UI actually indexes. `features` is deliberately NOT among
    // them: the workspace must never mistake a preview for the full data.
    expect(layer.featureCount).toBe(12);
    expect(layer.preview).toHaveLength(12);
    expect(layer.previewTruncated).toBe(false);
    expect(layer).not.toHaveProperty('features');
  });

  it('reports the TRUE count when the preview is truncated', () => {
    const summary = summarise(datasetOf(40), 10);
    const layer = summary.layers[0];

    // The count is the file's, the preview is the screen's. Conflating them is
    // how an edit reports itself applied to 10 of 40 parcels.
    expect(layer.featureCount).toBe(40);
    expect(layer.preview).toHaveLength(10);
    expect(layer.previewTruncated).toBe(true);
  });

  it('keeps the layer path so the tree can indent source folders', () => {
    const summary = summarise(datasetOf(3));
    expect(summary.layers[0].path).toEqual(['plots']);
  });

  it('survives a layer with no features', () => {
    const empty = { ...datasetOf(0), layers: [createLayer('empty', [], [])] } as unknown as CirDataset;
    const layer = summarise(empty).layers[0];
    expect(layer.featureCount).toBe(0);
    expect(layer.preview).toHaveLength(0);
  });
});

describe('both branches of inspect() hand over the same shape', () => {
  /**
   * Read as source text rather than executed: `client.ts` imports the worker
   * entry, which needs a Worker global. The question here is not what the code
   * computes but WHICH FUNCTION each branch calls, and that is answerable — and
   * was silently wrong — in the text.
   */
  const client = new URL('../src/workers/client.ts', import.meta.url);

  it('summarises in the inline branch of inspect', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(client, 'utf8'));
    const inspect = source.slice(source.indexOf('export async function inspect('), source.indexOf('export interface RunOptions'));

    expect(inspect).toContain('summarise(dataset)');
    // The profile must still be taken from the FULL dataset, or the exact
    // counts it exists to carry become the preview's counts.
    expect(inspect).toContain('profileDataset(dataset)');
  });

  it('summarises both datasets in the inline branch of runConversion', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(client, 'utf8'));
    const run = source.slice(source.indexOf('export async function runConversion('), source.indexOf('export async function expand('));

    expect(run).toContain('summarise(result.sourceDataset, 2000)');
    expect(run).toContain('summarise(result.outputDataset, 2000)');
  });

  it('leaves summarise in one place, so the two paths cannot drift again', async () => {
    const fs = await import('node:fs/promises');
    const worker = await fs.readFile(new URL('../src/workers/convert.worker.ts', import.meta.url), 'utf8');
    const source = await fs.readFile(client, 'utf8');

    // Both import it; neither defines its own.
    expect(worker).toContain("from './summarise'");
    expect(source).toContain("from './summarise'");
    expect(worker).not.toContain('function summarise(');
    expect(source).not.toContain('function summarise(');
  });
});
