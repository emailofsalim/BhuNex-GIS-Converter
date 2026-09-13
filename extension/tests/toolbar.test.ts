/**
 * Every tool is reachable, and every documented key does something.
 *
 * This is the fifth variant of the same defect in this project: a correct
 * engine with nothing wired to it. `ToolCanvas` has had lasso, move and five
 * drawing tools since phase F, `EditCanvas` vertex editing since phase C,
 * `MeasureCanvas` measuring since §26.1 — and none of them could be picked from
 * the canvas. Drawing was four clicks into the right-hand dock; MEASURING could
 * not be switched on at all, because `updateMeasureBar` hid its bar unless
 * `inspectorTab === 'preview'` and the `preview` tab had been deleted.
 *
 * So the tests are about the LINKS rather than the geometry:
 *   - every tool in the list has a unique key and a real hint
 *   - every tool maps to an engine that exists
 *   - Help's shortcut table is generated from the same list the toolbar and the
 *     key handler use, so it cannot document a key that does nothing
 *   - no tool key collides with a modifier shortcut or with the keys
 *     `ToolCanvas` already owns
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANVAS_ACTIONS, CANVAS_TOOLS, engineOf, GLOBAL_SHORTCUTS, toolForKey } from '../src/workspace/panels/toolbar';

const root = join(import.meta.dirname, '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

describe('the tool list', () => {
  it('covers every interaction the canvas supports', () => {
    const ids = CANVAS_TOOLS.map((tool) => tool.id);
    // The list a surveyor asked for, by name. Each is an engine that already
    // existed and had no button.
    for (const expected of [
      'select',
      'lasso',
      'move',
      'vertex',
      'draw-point',
      'draw-line',
      'draw-polygon',
      'draw-text',
      'draw-marker',
      'measure-distance',
      'measure-area',
      'info',
      'pan',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('gives every tool a unique key', () => {
    const keys = CANVAS_TOOLS.map((tool) => tool.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never binds a key ToolCanvas already owns', () => {
    // F8 is ortho and Escape cancels a drawing, both inside `ToolCanvas`. A
    // tool bound to either would fight the canvas for the same keypress.
    const keys = CANVAS_TOOLS.map((tool) => tool.key.toUpperCase());
    expect(keys).not.toContain('F8');
    expect(keys).not.toContain('ESCAPE');
    expect(keys).not.toContain('ESC');
  });

  it('resolves each key back to its own tool', () => {
    for (const tool of CANVAS_TOOLS) {
      expect(toolForKey(tool.key)?.id).toBe(tool.id);
      // Case-insensitive: nobody holds Shift to pick a tool.
      expect(toolForKey(tool.key.toLowerCase())?.id).toBe(tool.id);
    }
  });

  it('routes every tool to an engine that exists', () => {
    for (const tool of CANVAS_TOOLS) {
      expect(['tool', 'edit', 'measure', 'info', 'none']).toContain(engineOf(tool.id));
    }
    // The specific routings that were wrong before: measuring is its own
    // engine, vertex editing is the edit canvas, and pan arms nothing.
    expect(engineOf('measure-distance')).toBe('measure');
    expect(engineOf('measure-area')).toBe('measure');
    expect(engineOf('vertex')).toBe('edit');
    expect(engineOf('pan')).toBe('none');
    expect(engineOf('draw-polygon')).toBe('tool');
  });

  it('explains every tool, rather than only naming it', () => {
    for (const tool of CANVAS_TOOLS) {
      expect(tool.label.length).toBeGreaterThan(0);
      // A hint is what the tooltip and Help both show. One word is a label
      // repeated, not an explanation.
      expect(tool.hint.split(' ').length).toBeGreaterThan(4);
    }
  });
});

describe('the shortcut reference in Help', () => {
  it('is generated from the bindings, never retyped', () => {
    const settings = read('src/workspace/panels/settings.ts');
    // If this import ever goes, the table becomes a hand-written list that can
    // drift from the keys that actually work — which is the failure this whole
    // file exists to prevent.
    expect(settings).toContain("from './toolbar'");
    expect(settings).toContain('CANVAS_TOOLS');
    expect(settings).toContain('CANVAS_ACTIONS');
    expect(settings).toContain('GLOBAL_SHORTCUTS');
  });

  it('documents a key for every action it lists', () => {
    for (const action of [...CANVAS_ACTIONS, ...GLOBAL_SHORTCUTS]) {
      expect(action.key.length).toBeGreaterThan(0);
      expect(action.hint.length).toBeGreaterThan(10);
    }
  });

  it('opens from Help and not from About', () => {
    const main = read('src/workspace/main.ts');
    // Both buttons used to call `openHelpDialog`, so the button labelled with
    // the licence opened a page about conversion behaviour.
    expect(main).toContain("$('helpBtn').addEventListener('click', openHelpDialog)");
    expect(main).toContain("$('aboutBtn').addEventListener('click', openAboutDialog)");
  });
});

describe('the key handler', () => {
  const main = read('src/workspace/main.ts');

  it('ignores single-key tools while the user is typing', () => {
    // Without this, typing a layer name containing "v" drops the user into the
    // Select tool mid-word.
    expect(main).toContain('input, textarea, select, [contenteditable]');
    expect(main).toMatch(/if \(accel \|\| event\.altKey \|\| typing\) return;/);
  });

  it('handles undo exactly once', () => {
    // It used to match twice: one branch called `undoEdit` and a second, lower
    // down, also matched "z" and stepped the history — so one Ctrl+Z reversed
    // an edit AND moved the history pointer.
    const undoBranches = main.match(/event\.key\.toLowerCase\(\) === 'z'/g) ?? [];
    expect(undoBranches.length).toBe(1);
  });

  it('dispatches tools through the shared list', () => {
    expect(main).toContain('toolForKey(event.key)');
    expect(main).toContain('setCanvasTool(tool.id)');
  });
});

describe('the canvas toolbar markup', () => {
  const html = read('src/workspace/index.html');

  it('has one toolbar, not four mode bars', () => {
    expect(html).toContain('id="canvasToolbar"');
    // The three that were each hidden behind a dock tab.
    expect(html).not.toContain('id="selectBar"');
    expect(html).not.toContain('id="editBar"');
    expect(html).not.toContain('id="measureBar"');
  });

  it('stacks the readout with the bar so neither can cover the other', () => {
    // The readout was pinned at a fixed offset from the top and landed on the
    // toolbar's second row the moment it wrapped, hiding three tools.
    expect(html).toContain('class="cstack"');
    const stack = html.slice(html.indexOf('class="cstack"'));
    expect(stack.indexOf('id="canvasToolbar"')).toBeLessThan(stack.indexOf('id="toolStatus"'));
  });
});

describe('the side panel opens the workspace', () => {
  it('reads the path from the manifest instead of spelling it out', () => {
    const panel = read('src/sidepanel/main.ts');
    // The repository root loads as an unpacked extension with every path
    // prefixed `dist/`, so the literal `src/workspace/index.html` this used to
    // pass resolved to a page that does not exist — the button was dead for
    // anyone who installed the documented way.
    expect(panel).toContain('getManifest().options_page');
    expect(panel).not.toMatch(/getURL\('src\/workspace\/index\.html'\)/);
  });
});
