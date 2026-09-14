/**
 * Arming a tool must switch its engine ON.
 *
 * THE DEFECT
 *
 * `applyCanvasTool` turns every interaction layer off, then starts the one the
 * current tool needs. The `edit`, `measure` and `georef` branches each called
 * `setEnabled(true)`. The `tool` branch did not — it called `setTool(...)`,
 * which only changes WHICH tool is current and has never enabled anything.
 *
 * So `ToolCanvas` stayed disabled for its entire life, and its first line is
 *
 *     if (!this.enabled || event.button !== 0) return;
 *
 * which killed Select, Lasso, Move, Point, Polyline, Polygon, Text, Marker and
 * Info in one stroke. The buttons lit, the cursor changed, the status line gave
 * instructions, and every click was dropped on the floor. Vertex and Measure
 * kept working, because their branches enable themselves — which is what made
 * it look like "some editing works and some does not" rather than one missing
 * call, and it is why the report was "no editing tool is working properly".
 *
 * Measured in a browser before the fix: pointerdown delivered, hit test
 * succeeding with distance 0 on the parcel under the cursor, and the selection
 * still empty.
 *
 * This test reads `main.ts` rather than running a browser, because the defect
 * is structural: a branch that starts an engine without enabling it. A DOM test
 * would need the whole workspace booted to assert one missing line.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const main = readFileSync(resolve('extension', 'src', 'workspace', 'main.ts'), 'utf8');

/** The body of `applyCanvasTool`, where the engines are started and stopped. */
function applyCanvasToolBody(): string {
  const start = main.indexOf('function applyCanvasTool');
  expect(start, 'applyCanvasTool has been renamed; this test needs updating').toBeGreaterThan(-1);
  const next = main.indexOf('\nfunction ', start + 1);
  return main.slice(start, next === -1 ? undefined : next);
}

describe('every engine an arming branch starts is also enabled', () => {
  const body = applyCanvasToolBody();

  it('turns the tool engine on, not merely selects a tool within it', () => {
    // `setTool` is not enough and never was: it sets `this.tool` and returns.
    expect(body).toMatch(/ui\.toolCanvas\?\.setEnabled\(true\)/);
  });

  it('enables an engine in every branch that starts one', () => {
    // Each branch that renders a panel and hands the canvas to an engine must
    // also switch that engine on. Missing it is silent: nothing throws, the
    // button lights, and the clicks vanish.
    const branches = [
      { name: 'tool', marker: "engine === 'tool'", enable: 'ui.toolCanvas?.setEnabled(true)' },
      { name: 'edit', marker: "engine === 'edit'", enable: 'ui.editCanvas?.setEnabled(true)' },
      { name: 'georef', marker: "engine === 'georef'", enable: 'ui.georefCanvas?.setEnabled(true)' },
      { name: 'info', marker: "engine === 'info'", enable: 'ui.toolCanvas?.setEnabled(true)' },
    ];

    for (const branch of branches) {
      const at = body.indexOf(branch.marker);
      expect(at, `no branch found for engine '${branch.name}'`).toBeGreaterThan(-1);
      // ONLY THIS BRANCH'S BODY, not everything after it.
      //
      // The first version of this test searched from the branch to the end of
      // the function. Because the `info` branch enables the same engine as the
      // `tool` branch, deleting the call from `tool` still left a match further
      // down — the test passed against the exact bug it was written for. Found
      // by reverting the fix and watching it stay green.
      const opens = body.indexOf('{', at);
      const nextBranch = body.indexOf('} else if', opens);
      const scope = body.slice(opens, nextBranch === -1 ? body.length : nextBranch);
      expect(scope.includes(branch.enable), `the '${branch.name}' branch never calls ${branch.enable}`).toBe(true);
    }
  });

  it('still disables every engine before starting one', () => {
    // The other half of the contract. Two engines live at once means one takes
    // the clicks the user meant for the other, and both hold the single overlay
    // hook — so the fix above must not come at the cost of this.
    for (const off of ['ui.editCanvas?.setEnabled(false)', 'ui.toolCanvas?.setEnabled(false)', 'ui.georefCanvas?.setEnabled(false)']) {
      expect(body.includes(off), `${off} is missing from the stop-everything block`).toBe(true);
    }
  });
});
