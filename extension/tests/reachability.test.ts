/**
 * The audit: can a user actually GET to what was built?
 *
 * `capability-audit.test.ts` answers the neighbouring question — does every
 * format the registry advertises produce real bytes — and it exists because
 * five separate engines were found to be correct, complete and unreachable,
 * each with documentation confidently describing the opposite.
 *
 * This file covers the other half of that failure: an engine wired to nothing.
 * A geometry operation missing from the panel's group list, a tab with no case
 * in the switch, a control bound to an element id that does not exist. Each of
 * those ships green, passes every unit test, and simply does not work — and
 * none of them is visible in a diff.
 *
 * So these tests read the SOURCE as text and check the links between files that
 * the compiler cannot see: a string in a `<button data-tab>` against a `case`
 * label, an id passed to `$()` against the markup. Crude on purpose. The
 * alternative is a browser test that costs a minute and catches the same thing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GEOMETRY_LABEL, type GeometryOperation } from '@core/geometry-ops';
import { TILE_PRESETS, TILE_PROVIDERS } from '@ui/basemap';

const ROOT = join(import.meta.dirname, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

const HTML = read('extension', 'src', 'workspace', 'index.html');
const MAIN = read('extension', 'src', 'workspace', 'main.ts');

/** Every workspace source file, as text, for the cross-file checks. */
function workspaceSources(): { name: string; text: string }[] {
  const files = [
    'main.ts',
    'conversion.ts',
    'dom.ts',
    'host.ts',
    'ui-state.ts',
    ...[
      'attributes',
      'backdrop-tab',
      'canvas',
      'commands',
      'compare',
      'dataset',
      'edit-tab',
      'edits',
      'formats',
      'geometry-ops',
      'health',
      'history',
      'inspector',
      'layers',
      'measure',
      'queue',
      'select-tab',
      'settings',
      'workflows',
    ].map((name) => `panels/${name}.ts`),
  ];
  return files.map((name) => ({ name, text: read('extension', 'src', 'workspace', name) }));
}

describe('every tab reaches a panel', () => {
  const tabs = [...HTML.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);

  it('finds the tabs in the markup', () => {
    expect(tabs.length).toBeGreaterThanOrEqual(12);
  });

  it('gives every tab a case in the inspector switch', () => {
    // A tab with no case renders the previous panel's content under a new
    // highlight, which reads as the tool losing the click.
    const missing = tabs.filter((tab) => !MAIN.includes(`case '${tab}':`));
    expect(missing, `tabs with no panel: ${missing.join(', ')}`).toEqual([]);
  });

  it('lists every tab in the command palette', () => {
    // The palette is how a keyboard user reaches a tab at all. One missing
    // from it is reachable only by knowing where to click.
    const commands = read('extension', 'src', 'workspace', 'panels', 'commands.ts');
    const missing = tabs.filter((tab) => !commands.includes(`'${tab}'`));
    expect(missing, `tabs missing from the palette: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('every control is bound to an element that exists', () => {
  const ids = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

  it('finds the ids in the markup', () => {
    expect(ids.size).toBeGreaterThanOrEqual(30);
  });

  it('never asks for an id the page does not have', () => {
    // `$` is `document.getElementById(id) as T`, so a typo returns null typed
    // as an element. The next property access throws, or the listener is
    // attached to nothing — a control that silently does not work.
    //
    // Ids created at runtime are excluded by name, and each one is listed
    // rather than pattern-matched: an exemption with no reason beside it is
    // how a broken binding hides.
    const runtime = new Set([
      // Built by `editTab` when a feature is opened, read by `updateEditBar`.
      'editReadoutPanel',
      // Built by `selectStatusBar`, which the canvas toolbar also provides.
      'selectStatus',
    ]);

    const missing: string[] = [];
    for (const { name, text } of workspaceSources()) {
      for (const match of text.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) {
        const id = match[1];
        if (ids.has(id) || runtime.has(id)) continue;
        missing.push(`${name}: $('${id}')`);
      }
    }
    expect(missing, `bindings to ids that do not exist:\n${missing.join('\n')}`).toEqual([]);
  });

  it('has no control in the markup that nothing drives', () => {
    // The mirror of the check above, and it found two. `#folderPicker` was an
    // `<input webkitdirectory>` sitting in the page with nothing opening it,
    // while the dropzone said "Drop files or folders" — so a folder could only
    // be added by dragging. That matters here more than in a generic tool: a
    // shapefile is .shp/.shx/.dbf/.prj and the companion grouper exists for
    // exactly that, so "choose a folder" is the common case.
    //
    // Purely presentational ids are exempted by name, with the reason.
    const presentational = new Map([
      ['app', 'the root layout element, styled only'],
      ['dropFormats', 'filled by renderFormats through a different reference'],
    ]);

    const orphans: string[] = [];
    const sources = workspaceSources();
    for (const id of ids) {
      if (presentational.has(id)) continue;
      const referenced = sources.some(({ text }) => text.includes(`'${id}'`));
      if (!referenced) orphans.push(id);
    }
    expect(orphans, `controls in the markup that nothing drives: ${orphans.join(', ')}`).toEqual([]);
  });

  it('accounts for every runtime id it exempts', () => {
    // The exemption list must not outlive what it exempts. Each entry has to
    // be created somewhere, or it is a stale excuse for a real gap.
    for (const id of ['editReadoutPanel', 'selectStatus']) {
      const created = workspaceSources().some(({ text }) => text.includes(`id: '${id}'`));
      expect(created, `${id} is exempted but nothing creates it`).toBe(true);
    }
  });
});

describe('every geometry operation is reachable', () => {
  const panel = read('extension', 'src', 'workspace', 'panels', 'geometry-ops.ts');
  const operations = Object.keys(GEOMETRY_LABEL) as GeometryOperation[];

  it('offers every operation in the panel’s groups', () => {
    // The exact defect this file exists for: an operation the engine supports,
    // the registry counts, and the panel never lists. It works, and nobody can
    // run it.
    const groups = /const GROUPS[^]*?\n\];/.exec(panel)?.[0] ?? '';
    const missing = operations.filter((operation) => !groups.includes(`'${operation}'`));
    expect(missing, `operations with no way to reach them: ${missing.join(', ')}`).toEqual([]);
  });

  it('explains every operation, in the terms of whoever is choosing it', () => {
    // A `Record<GeometryOperation, string>` makes this a compile error, so this
    // guards the emptier failure: a hint that exists and says nothing.
    for (const operation of operations) {
      const hint = new RegExp(`'?${operation}'?:\\s*\\n?\\s*'([^']{20,})'`).exec(panel);
      expect(hint, `${operation} has no usable hint`).not.toBeNull();
    }
  });
});

describe('every edit command can be produced', () => {
  const edits = read('extension', 'src', 'core', 'edits.ts');
  const kinds = [...edits.matchAll(/\{\s*kind:\s*'([a-z-]+)';/g)].map((match) => match[1]);

  it('finds the command kinds', () => {
    expect(kinds.length).toBeGreaterThanOrEqual(12);
  });

  it('has something in the workspace that builds each one', () => {
    // A command the replay understands and nothing constructs is an engine
    // wired to nothing — the same defect as an unreachable operation, one
    // layer down.
    const sources = workspaceSources();
    const missing = kinds.filter(
      (kind) => !sources.some(({ text }) => text.includes(`kind: '${kind}'`))
    );
    expect(missing, `command kinds nothing produces: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('a vertex edit reaches the exported bytes', () => {
  // Found by the check above: `{ kind: 'vertices' }` had a complete, guarded
  // replay path in `core/edits.ts` and NOTHING constructed it. The editor
  // applied its plan to the preview and stopped there, so the canvas showed a
  // corrected boundary and the delivered file carried the original one.
  //
  // The two tests do different jobs and both are needed. The structural check
  // above is what FAILED before the fix and what catches the wiring: it looks
  // for something in the workspace constructing the command. This one goes
  // around the workspace and hands the command straight to `convert`, so it
  // proves the replay path carries a vertex move all the way into bytes — the
  // half that was always correct, and the half that has to stay correct for the
  // wiring to be worth anything.
  const GEOJSON = JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32645' } },
    features: [
      {
        type: 'Feature',
        properties: { plot: 'A-1' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [412300, 2591200],
              [412400, 2591200],
              [412400, 2591300],
              [412300, 2591300],
              [412300, 2591200],
            ],
          ],
        },
      },
    ],
  });

  it('writes the moved vertex, not the original one', async () => {
    const { convert } = await import('@core/pipeline');
    const { FULL_PRECISION } = await import('@core/precision');
    const { planMoveVertex } = await import('@core/vertex-edit');

    // The dataset shape the editor works on: the worker's preview summary.
    const preview = {
      layers: [
        {
          name: 'plots.geojson',
          features: [{ geometry: JSON.parse(GEOJSON).features[0].geometry, properties: { plot: 'A-1' } }],
        },
      ],
    };
    const plan = planMoveVertex(
      preview as never,
      { layer: 'plots.geojson', featureIndex: 0, ring: 0, vertex: 1 },
      [412450, 2591250],
      { protectedLayers: [] }
    );
    expect(plan.refusal, 'the editor refused to plan the move').toBeUndefined();

    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, runQa: false, edits: [{ kind: 'vertices', plan }] },
    });

    const written = JSON.parse(new TextDecoder().decode(result.outputs[0].bytes));
    const ring = written.features[0].geometry.coordinates[0];
    expect(ring[1]).toEqual([412450, 2591250]);
    // And nothing else moved.
    expect(ring[0]).toEqual([412300, 2591200]);
    expect(ring[2]).toEqual([412400, 2591300]);
    expect(written.features[0].properties.plot).toBe('A-1');
  });
});

describe('every stored setting reaches something', () => {
  const store = read('extension', 'src', 'state', 'store.ts');
  const sources = [
    ...workspaceSources(),
    { name: 'core/pipeline.ts', text: read('extension', 'src', 'core', 'pipeline.ts') },
  ];

  it('has no setting that nothing outside the store reads', () => {
    // A persisted, defaulted flag that reaches nothing is a claim the state
    // shape makes and the tool does not keep. `preserveAttributes` sat beside
    // `preserveZ` — which IS honoured — for the whole life of the project, so
    // anyone reading the settings had every reason to think it worked.
    const declared = [...store.matchAll(/^\s{2}(\w+)\??: (?:boolean|number|string);$/gm)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(15);

    const orphans = declared.filter(
      (name) => !sources.some(({ text }) => new RegExp(`\\b${name}\\b`).test(text))
    );
    expect(orphans, `settings nothing reads: ${orphans.join(', ')}`).toEqual([]);
  });
});

describe('writing geometry without its attributes', () => {
  // The setting the audit above found orphaned. Implemented rather than
  // removed, because a geometry-only delivery is a real thing to want — a
  // parcel boundary for a contractor with no business seeing the owner names.
  const GEOJSON = JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32645' } },
    features: [
      {
        type: 'Feature',
        properties: { plot: 'A-1', owner: 'a private individual', khasra: '112/2' },
        geometry: { type: 'Point', coordinates: [412345, 2591234] },
      },
    ],
  });

  async function run(preserveAttributes: boolean) {
    const { convert } = await import('@core/pipeline');
    const { FULL_PRECISION } = await import('@core/precision');
    return convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, runQa: false, preserveAttributes },
    });
  }

  it('writes the attributes when the setting is on', async () => {
    const written = JSON.parse(new TextDecoder().decode((await run(true)).outputs[0].bytes));
    expect(written.features[0].properties.owner).toBe('a private individual');
  });

  it('writes none of them when it is off, and keeps the geometry', async () => {
    const written = JSON.parse(new TextDecoder().decode((await run(false)).outputs[0].bytes));
    expect(Object.keys(written.features[0].properties ?? {})).toEqual([]);
    expect(written.features[0].geometry.coordinates).toEqual([412345, 2591234]);
  });

  it('leaves no field NAME in the output either', async () => {
    // Empty columns still advertise "owner" and answer nothing, which is worse
    // than a file that does not mention it — and on a confidentiality request
    // the name is often the sensitive part.
    const text = new TextDecoder().decode((await run(false)).outputs[0].bytes);
    expect(text).not.toContain('owner');
    expect(text).not.toContain('khasra');
    expect(text).not.toContain('private individual');
  });

  it('says which fields it left out', async () => {
    const warnings = (await run(false)).warnings.map((entry) => `${entry.message} ${entry.action ?? ''}`).join(' ');
    expect(warnings).toContain('khasra');
    expect(warnings).toContain('owner');
  });

  it('defaults to writing them, so nothing that omits the setting changes', async () => {
    const { convert } = await import('@core/pipeline');
    const { FULL_PRECISION } = await import('@core/precision');
    const result = await convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: 'geojson',
      settings: { precision: FULL_PRECISION, runQa: false },
    });
    const written = JSON.parse(new TextDecoder().decode(result.outputs[0].bytes));
    expect(written.features[0].properties.plot).toBe('A-1');
  });
});

describe('the offline guard knows about every tile source', () => {
  const guard = read('scripts', 'assert-offline.mjs');

  it('allows every built-in provider by its exact URL', () => {
    // CI caught a push on exactly this: five providers were added and the
    // guard's allowlist was not updated. The guard was right and the gap was
    // that nothing local said so first. This is that check, run with the unit
    // tests rather than after a build.
    const missing = TILE_PROVIDERS.filter((provider) => !guard.includes(provider.url));
    expect(
      missing.map((provider) => provider.id),
      `providers missing from scripts/assert-offline.mjs: ${missing.map((p) => p.url).join(', ')}`
    ).toEqual([]);
  });

  it('allows every preset template', () => {
    const missing = TILE_PRESETS.filter((preset) => !guard.includes(preset.template));
    expect(
      missing.map((preset) => preset.id),
      `presets missing from scripts/assert-offline.mjs: ${missing.map((p) => p.template).join(', ')}`
    ).toEqual([]);
  });

  it('does not allow a URL no provider or preset uses', () => {
    // The other direction: an allowlist entry outliving what it was added for
    // is a standing permission nobody is watching.
    const allowed = /const ALLOWED_TEMPLATES = \[[^]*?\n\];/.exec(guard)?.[0] ?? '';
    const entries = [...allowed.matchAll(/'(https:\/\/[^']+)'/g)].map((match) => match[1]);
    const known = new Set([
      ...TILE_PROVIDERS.map((provider) => provider.url),
      ...TILE_PRESETS.map((preset) => preset.template),
      // The example shown beside the custom-template field. `your-server` does
      // not resolve, which is the point of it.
      'https://your-server/tiles/{z}/{x}/{y}.png',
    ]);
    const stale = entries.filter((entry) => !known.has(entry));
    expect(stale, `allowlist entries nothing uses: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('the local gate covers what CI runs', () => {
  const workflow = read('.github', 'workflows', 'ci.yml');
  const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const verify = packageJson.scripts.verify;

  it('runs every npm script CI runs', () => {
    // This has been the cause of two red builds: `verify` was a strict subset
    // of CI, so a gate CI enforced was one nothing local could fail on. Both
    // times the fix was to add the missing step; this is what stops there
    // being a third time.
    const inCi = [...workflow.matchAll(/run: (npm run [a-z:]+)/g)].map((match) => match[1].replace('npm run ', ''));
    const covered = new Set(verify.split('&&').map((part) => part.trim().replace('npm run ', '')));
    const missing = [...new Set(inCi)].filter((script) => !covered.has(script) && script !== 'build');
    expect(missing, `CI runs these and \`npm run verify\` does not: ${missing.join(', ')}`).toEqual([]);
  });

  it('runs the standalone scripts CI runs', () => {
    // `node scripts/assert-offline.mjs` is not an npm script in CI, so the
    // check above cannot see it. Named directly.
    const direct = [...workflow.matchAll(/run: node (scripts\/[\w.-]+)/g)].map((match) => match[1]);
    for (const script of direct) {
      const name = /scripts\/assert-(\w+)/.exec(script)?.[1];
      if (!name) continue;
      const reachable = Object.values(packageJson.scripts).some((command) => command.includes(script));
      expect(reachable, `CI runs ${script} and no npm script does`).toBe(true);
    }
  });
});

describe('rasterizing polygons, which was built and unreachable', () => {
  // `rasterizePolygons` had been correct and tested since the raster tools
  // landed, and nothing outside its own module and test file called it: it
  // needed a target grid nothing asked for. The ledger said so honestly rather
  // than counting it as done, which is why this was finished rather than found.
  //
  // The missing piece was arithmetic, not an engine — a user has a CELL SIZE in
  // mind, never a width, a height and a geotransform.
  const GEOJSON = JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32645' } },
    features: [
      {
        type: 'Feature',
        properties: { landuse: 7 },
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]],
        },
      },
    ],
  });

  async function run(rasterize: Record<string, unknown> | undefined, target = 'asciigrid') {
    const { convert } = await import('@core/pipeline');
    const { SURVEY_DEFAULT_PRECISION } = await import('@core/precision');
    return convert({
      input: { fileName: 'plots.geojson', bytes: new TextEncoder().encode(GEOJSON) },
      targetFormatId: target,
      settings: { precision: SURVEY_DEFAULT_PRECISION, runQa: false, rasterize: rasterize as never },
    });
  }

  it('produces a grid whose size follows the cell size and the extent', async () => {
    const result = await run({ cellSize: 10 });
    const text = new TextDecoder().decode(result.outputs[0].bytes);
    // A 100x100 extent at 10-unit cells is 10x10.
    expect(text).toMatch(/ncols\s+10/);
    expect(text).toMatch(/nrows\s+10/);
    expect(text).toMatch(/cellsize\s+10/);
  });

  it('rounds the grid UP so it covers the whole extent', async () => {
    // 100 / 30 is 3.33: rounding down would crop the last row and column, which
    // on a cadastral sheet is the boundary of the outermost parcels.
    const text = new TextDecoder().decode((await run({ cellSize: 30 })).outputs[0].bytes);
    expect(text).toMatch(/ncols\s+4/);
    expect(text).toMatch(/nrows\s+4/);
  });

  it('burns 1 everywhere when no field is named — a mask', async () => {
    const text = new TextDecoder().decode((await run({ cellSize: 25 })).outputs[0].bytes);
    const body = text.split('\n').filter((line) => /^[\d\s.-]+$/.test(line) && line.trim()).join(' ');
    expect(body).toContain('1');
    expect(body).not.toContain('7');
  });

  it('burns the named field when there is one', async () => {
    const text = new TextDecoder().decode((await run({ cellSize: 25, field: 'landuse' })).outputs[0].bytes);
    expect(text).toContain('7');
  });

  it('says what it did, with the grid it produced', async () => {
    const warnings = (await run({ cellSize: 10 })).warnings.map((w) => `${w.message} ${w.reason ?? ''}`).join(' ');
    expect(warnings).toContain('10 × 10');
    expect(warnings).toContain('mask');
  });

  it('refuses a cell size that is not positive, rather than producing nothing', async () => {
    await expect(run({ cellSize: -5 })).rejects.toThrow(/positive number/);
  });

  it('refuses a layer with no closed rings', async () => {
    const { convert } = await import('@core/pipeline');
    const { SURVEY_DEFAULT_PRECISION } = await import('@core/precision');
    const lines = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10]] } }],
    });
    await expect(
      convert({
        input: { fileName: 'lines.geojson', bytes: new TextEncoder().encode(lines) },
        targetFormatId: 'asciigrid',
        settings: { precision: SURVEY_DEFAULT_PRECISION, runQa: false, rasterize: { cellSize: 5 } },
      })
    ).rejects.toThrow(/polygon/i);
  });

  it('leaves a conversion that did not ask for it completely alone', async () => {
    // The risk of adding a pipeline stage: every conversion that omits the
    // setting must produce exactly the bytes it always did.
    const result = await run(undefined, 'geojson');
    const written = JSON.parse(new TextDecoder().decode(result.outputs[0].bytes));
    expect(written.features[0].geometry.type).toBe('Polygon');
    expect(written.features[0].properties.landuse).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// The tile presets, and whether anything reads what they carry
// ---------------------------------------------------------------------------

describe('the key-holding tile presets are wired to something', () => {
  const SETTINGS = read('extension', 'src', 'workspace', 'panels', 'settings.ts');
  const CANVAS = read('extension', 'src', 'workspace', 'panels', 'canvas.ts');

  it('fills the user’s key into the template rather than storing the placeholder', () => {
    // The preset button stored `preset.template` verbatim, so pressing one left
    // a literal `{key}` in the URL box and every tile request 404'd. The
    // substitution function existed, was tested, and was called by nothing.
    expect(SETTINGS).toContain('applyPreset(preset');
    expect(SETTINGS).not.toMatch(/basemapCustomUrl:\s*preset\.template/);
  });

  it('remembers which preset a custom URL came from', () => {
    expect(SETTINGS).toContain('basemapPresetId: preset.id');
  });

  it('credits the preset’s service on the canvas instead of nobody', () => {
    // `TilePreset.attribution` was populated for all four presets and read by
    // nothing: a Stadia or Jawg canvas credited "Custom tile service — check
    // its attribution requirements", which is not the credit their terms
    // require and which the tool already had the text for.
    expect(CANVAS).toContain('preset.attribution');
  });

  it('stops at the zoom the preset’s service actually serves', () => {
    // Every custom URL was given maxZoom 22, including presets that stop at 20
    // — so panning in far enough asked those services for tiles they do not
    // have, and the basemap went blank for no stated reason.
    expect(CANVAS).toContain('preset.maxZoom');
    expect(CANVAS).not.toMatch(/attribution: 'Custom tile service[^']*',\s*\n\s*maxZoom: 22,\s*\n\s*\};/);
  });
});

// ---------------------------------------------------------------------------
// What the Help dialog claims, against what the tool does
// ---------------------------------------------------------------------------

describe('the Help dialog does not describe an older tool', () => {
  const SETTINGS = read('extension', 'src', 'workspace', 'panels', 'settings.ts');
  const help = /export function openHelpDialog\(\): void \{[^]*?\n\}/.exec(SETTINGS)?.[0] ?? '';

  it('was found at all', () => {
    expect(help.length, 'openHelpDialog no longer matches — this whole block is checking nothing').toBeGreaterThan(500);
  });

  it('does not claim the DWG helper is the only thing that leaves the machine', () => {
    // It said exactly that, and kept saying it after the basemap shipped. The
    // Settings dialog was honest about tiles; Help was not, which is the worse
    // of the two places to be wrong because it is the one people read to decide
    // whether to trust the tool with a confidential survey.
    expect(help).not.toMatch(/only exception is the optional DWG helper/);
    expect(help.toLowerCase()).toContain('basemap');
  });

  it('explains that an edit is replayed against the whole file', () => {
    // The single most surprising thing about the editing workstation: the
    // canvas holds a truncated preview, and a gesture on it is stored as an
    // intent that is re-planned against the full file at conversion.
    expect(help).toMatch(/replayed against the whole file/i);
  });

  it('states the preview cap that a selection gesture is bounded by', () => {
    expect(help).toContain('5,000');
  });

  it('warns that a two-point backdrop placement is not a georeference', () => {
    expect(help.toLowerCase()).toContain('backdrop');
  });
});

describe('a preset pressed with no key stays visibly unfinished', () => {
  const SETTINGS = read('extension', 'src', 'workspace', 'panels', 'settings.ts');

  it('leaves {key} in rather than substituting it away to nothing', () => {
    // `applyPreset(preset, '')` yields `?api_key=` — a URL that looks finished
    // and cannot load. The placeholder is the honest state, and the note beside
    // the field already explains it.
    expect(SETTINGS).toMatch(/pendingKey\.trim\(\)\s*\?\s*applyPreset\(preset, pendingKey\)\s*:\s*preset\.template/);
  });
});
