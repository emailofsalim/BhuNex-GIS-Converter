/**
 * Visual diff, presets and the command palette (spec §30.2, §31.3, §31.5).
 *
 * The palette tests are ranking tests, because ranking is the whole feature: a
 * palette that returns the right command fifth is a palette people stop using.
 * The preset tests are mostly guards — a preset is applied without being read,
 * so what it must never do matters more than what it does.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type Position, type SourceInfo } from '@core/cir';
import { DIFF_AXIS_LABEL, describeDiffEntry, diffDatasets } from '@qa/diff';
import { DESTRUCTIVE_SETTINGS, PRESETS, describePreset, getPreset, presetsFor } from '@core/presets';
import { scoreCommand, searchCommands, type Command } from '@ui/command-palette';
import { getFormat } from '@core/registry';
import { convert } from '@core/pipeline';
import { FULL_PRECISION } from '@core/precision';
import { crsFromEpsg } from '@crs/epsg';

const SOURCE: SourceInfo = { fileName: 'plots.geojson', size: 0, formatId: 'geojson', formatName: 'GeoJSON', detectionConfidence: 1 };

function polygon(id: string, ring: Position[], properties: Record<string, unknown> = {}): CirFeature {
  return { id, geometry: { type: 'Polygon', coordinates: [ring], dimension: 2 }, properties };
}

function dataset(features: CirFeature[], fields: string[] = [], crsEpsg = 32645): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'plots',
    source: SOURCE,
    crs: crsFromEpsg(crsEpsg),
    crsOrigin: 'declared',
    layers: [createLayer('Plots', features, fields.map((name) => ({ name, type: 'string' as const })))],
  });
}

/** A 10 x 10 square: area 100, perimeter 40. */
function square(x = 0, y = 0, size = 10): Position[] {
  return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

describe('source versus output comparison', () => {
  it('reports identical data as exact on every axis', () => {
    const report = diffDatasets(dataset([polygon('P1', square())]), dataset([polygon('P1', square())]));
    expect(report.passed).toBe(true);
    expect(report.entries.every((entry) => entry.verdict !== 'differs')).toBe(true);
  });

  it('gives the numbers, not just a verdict', () => {
    // The format the master document asks for: source, output, difference,
    // tolerance. A surveyor signing off needs to see whether 0.01 m² is
    // rounding or a defect, and "PASS" alone cannot tell them.
    const shifted = square(0, 0, 10);
    shifted[2] = [10.001, 10];
    const report = diffDatasets(dataset([polygon('P1', square())]), dataset([polygon('P1', shifted)]));
    const area = report.entries.find((entry) => entry.axis === 'area')!;
    expect(area.source).toContain('100.00');
    expect(area.difference).toMatch(/^0\.0/);
    expect(area.tolerance).toBeDefined();
  });

  it('fails an area difference beyond tolerance and passes one within it', () => {
    const bigger = square(0, 0, 11); // area 121, twenty-one units larger
    const failing = diffDatasets(dataset([polygon('P1', square())]), dataset([polygon('P1', bigger)]));
    expect(failing.entries.find((entry) => entry.axis === 'area')!.verdict).toBe('differs');
    expect(failing.passed).toBe(false);

    const nudged = square();
    nudged[1] = [10.0001, 0];
    const passing = diffDatasets(dataset([polygon('P1', square())]), dataset([polygon('P1', nudged)]), { areaTolerance: 0.05 });
    expect(passing.entries.find((entry) => entry.axis === 'area')!.verdict).not.toBe('differs');
  });

  it('finds the worst coordinate drift and where it is', () => {
    const drifted = square();
    drifted[2] = [10, 10.5];
    const report = diffDatasets(dataset([polygon('P1', square())]), dataset([polygon('P1', drifted)]));
    const coordinates = report.entries.find((entry) => entry.axis === 'coordinates')!;
    expect(coordinates.verdict).toBe('differs');
    expect(coordinates.difference).toContain('0.5');
    // Locatable, so the failure can be gone and looked at.
    expect(coordinates.at).toEqual([10, 10]);
  });

  it('refuses to invent a drift when the vertex counts differ', () => {
    const extra = [...square()];
    extra.splice(1, 0, [5, 0]);
    const report = diffDatasets(dataset([polygon('P1', square())]), dataset([polygon('P1', extra)]));
    const coordinates = report.entries.find((entry) => entry.axis === 'coordinates')!;
    // With no vertex correspondence there is no drift to report, and reporting
    // one anyway would be a number that means nothing.
    expect(coordinates.verdict).toBe('not-comparable');
    expect(coordinates.note).toMatch(/no correspondence/);
  });

  it('subtracts holes from the area rather than adding them', () => {
    const withHole: CirFeature = {
      id: 'P1',
      geometry: { type: 'Polygon', coordinates: [square(0, 0, 10), square(2, 2, 4)], dimension: 2 },
      properties: {},
    };
    const report = diffDatasets(dataset([withHole]), dataset([withHole]));
    const area = report.entries.find((entry) => entry.axis === 'area')!;
    // 100 minus the 16-unit exclusion.
    expect(area.source).toContain('84.00');
  });

  it('names the fields lost and gained, because a rename looks like both', () => {
    const before = dataset([polygon('P1', square())], ['sample_description', 'plot_no']);
    const after = dataset([polygon('P1', square())], ['sample_des', 'plot_no']);
    const attributes = diffDatasets(before, after).entries.find((entry) => entry.axis === 'attributes')!;
    expect(attributes.verdict).toBe('differs');
    expect(attributes.difference).toContain('sample_description');
    expect(attributes.difference).toContain('sample_des');
    expect(attributes.note).toMatch(/renamed field/);
  });

  it('calls an extent that far apart a CRS problem, which it almost always is', () => {
    const here = dataset([polygon('P1', square())]);
    const elsewhere = dataset([polygon('P1', square(500000, 4000000))]);
    const extent = diffDatasets(here, elsewhere).entries.find((entry) => entry.axis === 'extent')!;
    expect(extent.verdict).toBe('differs');
    expect(extent.note).toMatch(/coordinate system mismatch/);
  });

  it('reports every Z value dropped, with the reason', () => {
    const withZ: CirFeature = {
      id: 'P1',
      geometry: { type: 'Polygon', coordinates: [square().map((position) => [...position, 412]) as Position[]], dimension: 3 },
      properties: {},
    };
    const entry = diffDatasets(dataset([withZ]), dataset([polygon('P1', square())])).entries.find((axis) => axis.axis === 'z-range')!;
    expect(entry.verdict).toBe('differs');
    expect(entry.difference).toMatch(/every Z value was dropped/);
  });

  it('formats one line the way a status bar wants it', () => {
    const report = diffDatasets(dataset([polygon('P1', square())]), dataset([polygon('P1', square())]));
    const line = describeDiffEntry(report.entries.find((entry) => entry.axis === 'area')!);
    expect(line).toContain(DIFF_AXIS_LABEL.area);
    expect(line).toMatch(/difference/);
    expect(line).toMatch(/PASS/);
  });

  it('attaches a measured comparison to a real conversion', async () => {
    const geojson = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { plot_no: '784' }, geometry: { type: 'Polygon', coordinates: [square(412300, 2591200, 100)] } }],
    });
    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(geojson) },
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, sourceCrs: crsFromEpsg(32645), runQa: true },
    });
    expect(result.diff).toBeDefined();
    expect(result.diff!.entries.length).toBeGreaterThan(5);
    // A GeoJSON round trip at full precision should change nothing measurable.
    expect(result.diff!.entries.find((entry) => entry.axis === 'coordinates')!.verdict).not.toBe('differs');
  });
});

describe('presets', () => {
  it('never enables anything destructive', () => {
    // A preset is applied without being read. What it must never do therefore
    // matters more than what it does (R18).
    for (const preset of PRESETS) {
      for (const key of DESTRUCTIVE_SETTINGS) {
        expect((preset.settings as Record<string, unknown>)[key], `${preset.id} enables ${key}`).not.toBe(true);
      }
    }
  });

  it('names a target format that exists and can be written', () => {
    for (const preset of PRESETS) {
      const targetId = preset.settings.globalTargetFormatId;
      if (!targetId) continue;
      const format = getFormat(targetId);
      expect(format, `${preset.id} targets unknown format ${targetId}`).toBeDefined();
      expect(format!.support.export, `${preset.id} targets a format that cannot be written`).not.toBe('none');
    }
  });

  it('sets WGS 84 on every KML target, because KML has no choice about it', () => {
    // Projected coordinates written into a KML place the geometry in the wrong
    // part of the world. A preset that forgot this would produce a file that
    // opens and is silently wrong.
    for (const preset of PRESETS) {
      if (preset.settings.globalTargetFormatId !== 'kml' && preset.settings.globalTargetFormatId !== 'kmz') continue;
      expect(preset.settings.targetCrsEpsg, `${preset.id} writes KML without setting EPSG:4326`).toBe(4326);
    }
  });

  it('explains itself, so applying one is informed', () => {
    for (const preset of PRESETS) {
      expect(preset.purpose.length, `${preset.id} has no purpose`).toBeGreaterThan(20);
      expect(preset.rationale.length, `${preset.id} has no rationale`).toBeGreaterThan(40);
    }
  });

  it('lists only what would actually change for this user', () => {
    const preset = getPreset('survey-csv-to-gis')!;
    const already = { globalTargetFormatId: 'geojson', precisionMode: 'full', preserveZ: true, outputLayout: 'single' };
    expect(describePreset(preset, already)).toHaveLength(0);

    const different = { globalTargetFormatId: 'dxf', precisionMode: 'fixed', preserveZ: true, outputLayout: 'single' };
    const changes = describePreset(preset, different);
    expect(changes.join(' ')).toContain('Output format');
    expect(changes.join(' ')).toContain('Precision');
  });

  it('offers the format-specific presets before the general ones', () => {
    const forDxf = presetsFor('dxf');
    expect(forDxf[0].appliesTo).toContain('dxf');
    // The general ones are still there — a preset that applies to anything is
    // not less useful for a DXF.
    expect(forDxf.some((preset) => preset.appliesTo.length === 0)).toBe(true);
  });

  it('has a cadastral preset that does the whole job in one action', () => {
    const preset = getPreset('cadastral-dxf-to-polygons')!;
    expect(preset.settings.polygonizeEnabled).toBe(true);
    expect(preset.settings.burnInEnabled).toBe(true);
    // ...and still does not delete the source text.
    expect(preset.settings.burnInReplaceSource).toBe(false);
  });
});

describe('command palette ranking', () => {
  const command = (title: string, group: string, keywords: string[] = [], enabled = true): Command => ({
    id: title,
    title,
    group,
    keywords,
    enabled,
    disabledReason: enabled ? undefined : 'Select a queued file first.',
    run: () => {},
  });

  const commands = [
    command('Convert to Shapefile', 'Convert', ['shp', 'esri']),
    command('Convert to KMZ', 'Convert', ['kml', 'google earth']),
    command('Attach text to polygons', 'Tools', ['burn', 'burn-in', 'label']),
    command('Open settings', 'View', ['preferences', 'options']),
    command('Show What will be lost', 'View', ['fidelity', 'loss']),
  ];

  it('puts a title prefix first', () => {
    expect(searchCommands(commands, 'convert')[0].command.title).toMatch(/^Convert/);
  });

  it('matches a word inside the title, not just the start', () => {
    expect(searchCommands(commands, 'shapefile')[0].command.title).toBe('Convert to Shapefile');
  });

  it('finds a command by what someone means rather than what it is called', () => {
    // The reason keywords exist: nobody types "Attach text to polygons".
    expect(searchCommands(commands, 'burn')[0].command.title).toBe('Attach text to polygons');
    expect(searchCommands(commands, 'kml')[0].command.title).toBe('Convert to KMZ');
  });

  it('ranks a title match above a keyword match', () => {
    const results = searchCommands(commands, 'settings');
    expect(results[0].command.title).toBe('Open settings');
  });

  it('keeps a disabled command visible but ranks it last', () => {
    const withDisabled = [...commands, command('Convert to GeoPackage', 'Convert', ['gpkg'], false)];
    const results = searchCommands(withDisabled, 'convert');
    const disabledAt = results.findIndex((match) => match.command.enabled === false);
    // Visible, because a palette that omits what you searched for looks broken
    // and you retype the same query...
    expect(disabledAt).toBeGreaterThan(-1);
    // ...but never above something you can actually run.
    expect(disabledAt).toBe(results.length - 1);
  });

  it('reports which characters matched, for highlighting', () => {
    const match = scoreCommand(command('Convert to KMZ', 'Convert'), 'kmz');
    expect(match!.highlights.length).toBe(3);
  });

  it('returns everything for an empty query', () => {
    expect(searchCommands(commands, '')).toHaveLength(commands.length);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchCommands(commands, 'zzzzqqq')).toHaveLength(0);
  });

  it('falls back to fuzzy matching, but below every real match', () => {
    // "cts" appears in order inside "ConverT to ShapefTile"-ish titles. Useful
    // as a last resort, useless if it outranks a substring match.
    const results = searchCommands(commands, 'ct');
    expect(results.length).toBeGreaterThan(0);
    const exact = searchCommands(commands, 'convert to k');
    expect(exact[0].command.title).toBe('Convert to KMZ');
  });
});
