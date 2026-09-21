/**
 * The armed tool's instruction, and who is allowed to write it.
 *
 * WHAT WENT WRONG, AND WHY NO TEST CAUGHT IT
 *
 * The canvas has four interaction engines and fourteen tools spread across
 * them. The instruction line was written by exactly one of those engines —
 * `ToolCanvas`, through its `onStatus` callback into `#selectStatus` — so:
 *
 *   · Vertex, Distance, Area and Georef run on OTHER engines. ToolCanvas is
 *     disabled for them, so the line kept whatever it had last written.
 *   · Info was worse, because it was not stale. Info deliberately rides the
 *     select engine (`setTool('select')` — a read-only click on the same
 *     layer), so ToolCanvas ACTIVELY wrote the Select instructions while the
 *     Info tool was armed.
 *
 * Five of fourteen tools told the user how to use a different tool. It was
 * found by arming each tool in a real browser and reading the line back, not
 * by any unit test — nothing here had an opinion about which engine owned
 * which pixel of the status bar.
 *
 * These tests hold the CONTRACT rather than the rendering: every tool has an
 * instruction of its own, the table is the only place they live, and no engine
 * writes one behind the table's back. The rendering half stays browser-verified.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { asCanvasTool, CANVAS_TOOLS, hintOf } from '../src/workspace/panels/toolbar';

const TOOL_CANVAS = readFileSync(new URL('../src/ui/tool-canvas.ts', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../src/workspace/main.ts', import.meta.url), 'utf8');

describe('every tool says what it does', () => {
  it('gives all fourteen an instruction, and none of them a placeholder', () => {
    expect(CANVAS_TOOLS.length).toBe(14);
    for (const tool of CANVAS_TOOLS) {
      expect(hintOf(tool.id), `${tool.id} has no instruction`).not.toBe('');
      expect(hintOf(tool.id).length, `${tool.id}'s instruction is too short to help`).toBeGreaterThan(20);
    }
  });

  it('gives each one a DISTINCT instruction', () => {
    // The defect stated as a rule: five tools were showing one shared string.
    // Two tools with byte-identical instructions means at least one of them is
    // describing something it does not do.
    const hints = CANVAS_TOOLS.map((tool) => hintOf(tool.id));
    expect(new Set(hints).size).toBe(hints.length);
  });

  it('names its own action rather than the select tool"s', () => {
    // The five that were wrong, checked against the phrase they were wrongly
    // showing. `select` itself is allowed to say it.
    const selectPhrase = 'Click a feature, or drag from empty space';
    for (const id of ['vertex', 'measure-distance', 'measure-area', 'info', 'georef'] as const) {
      expect(hintOf(id), `${id} is back to showing the Select instructions`).not.toContain(selectPhrase);
    }
  });
});

describe('who is allowed to write the instruction', () => {
  it('has ToolCanvas emit no hint of its own on a tool change', () => {
    // ToolCanvas used to push `TOOL_HINT[tool]` into the status callback on
    // every `setTool`. With the instruction now in its own span that produced
    // BOTH at once — "Click to place a single point. Click to place a point.
    // Snapping puts it exactly on an existing vertex." — one instruction twice,
    // in two voices, running together as a single sentence.
    const setTool = TOOL_CANVAS.slice(TOOL_CANVAS.indexOf('setTool(tool: CanvasTool)'), TOOL_CANVAS.indexOf('getTool()'));
    expect(setTool, 'setTool could not be located').not.toBe('');
    expect(setTool).not.toMatch(/onStatus\?\.\(TOOL_HINT/);
  });

  it('writes the hint from the table, for whichever tool is armed', () => {
    expect(MAIN).toMatch(/\$\('toolHint'\)\.textContent = hintOf\(tool\)/);
  });

  it('writes it before the engine branches, so no engine can be skipped', () => {
    // Pan has no engine. Setting the hint inside the branches would leave the
    // one tool that is armed by default saying nothing at all — which is what
    // it did: `pan` fell into the same early return as "no file loaded" and
    // the whole bar was hidden.
    const fn = MAIN.slice(MAIN.indexOf('function applyCanvasTool'), MAIN.indexOf('function renderInspector'));
    const hintAt = fn.indexOf("$('toolHint')");
    const firstBranch = fn.indexOf("if (engine === 'none') return");
    expect(hintAt).toBeGreaterThan(-1);
    expect(firstBranch, 'the engine branches have moved').toBeGreaterThan(-1);
    expect(hintAt, 'the hint is set after the branches again').toBeLessThan(firstBranch);
  });
});

describe('the tool id crossing out of the store', () => {
  it('passes through every real tool unchanged', () => {
    for (const tool of CANVAS_TOOLS) expect(asCanvasTool(tool.id)).toBe(tool.id);
  });

  it('falls back to Pan rather than arming something that does not exist', () => {
    // `store.canvasTool` is a bare string on purpose — the state layer must not
    // import the workspace — so the value arrives unvalidated. It used to be
    // CAST, which asserts instead of checking: a renamed id, or one restored
    // from an older saved project, matched no branch, started no engine and
    // left the canvas inert behind a lit button.
    //
    // Pan is the safe fallback because it owns no pointer and can damage
    // nothing: an unknown id degrades to "no tool armed" rather than to "a tool
    // that silently does nothing".
    expect(asCanvasTool('draw-circle')).toBe('pan');
    expect(asCanvasTool('')).toBe('pan');
    expect(asCanvasTool(undefined)).toBe('pan');
    expect(asCanvasTool('Select')).toBe('pan'); // ids are lower-case
  });
});
