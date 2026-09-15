/**
 * The CAD gestures, pinned.
 *
 * Three defects are covered here, all of them reported as "the editing tools
 * do not work":
 *
 *  1. The Vertex tool ignored every click on the drawing. `EditCanvas` began
 *     its pointer handler with `if (!this.enabled || !this.target …) return`,
 *     and the ONLY thing that set a target was a two-dropdown-and-a-button
 *     flow in the Edit panel. So arming the tool and clicking a boundary did
 *     nothing, and no vertices were drawn because there was nothing to draw.
 *  2. The rubber band could only ever be the left button, so "take exactly
 *     what is inside this box" meant remembering which corner to start from.
 *  3. Escape closed the whole tool instead of stepping back one level, because
 *     the shell's global shortcut jumped to Pan for any press that was not
 *     mid-drawing.
 *
 * The suite runs on node with no jsdom, so the gestures themselves were driven
 * in headless Chromium against the built extension — hover pre-highlight, a
 * click opening 37 grips, Escape closing them, a right-drag right-to-left
 * still reading as a window, and a bare right-click leaving a 3-feature
 * selection untouched. What a test can hold here is the shape: that the guards
 * are gone, that both routes into the editor run the same check, and that the
 * two band rules are stated once each rather than drifting apart.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { editTargetFor } from '../src/ui/edit-canvas';

const ROOT = join(import.meta.dirname, '..', '..', 'extension', 'src');
const EDIT_CANVAS = readFileSync(join(ROOT, 'ui', 'edit-canvas.ts'), 'utf8');
const TOOL_CANVAS = readFileSync(join(ROOT, 'ui', 'tool-canvas.ts'), 'utf8');
const EDIT_TAB = readFileSync(join(ROOT, 'workspace', 'panels', 'edit-tab.ts'), 'utf8');
const MAIN = readFileSync(join(ROOT, 'workspace', 'main.ts'), 'utf8');

describe('clicking the drawing opens a feature for vertex editing', () => {
  it('no longer discards pointer events just because nothing is open', () => {
    // THE BUG, exactly. Restoring `!this.target` to this guard restores a
    // Vertex tool that lights up and then ignores the canvas.
    expect(EDIT_CANVAS).not.toContain('if (!this.enabled || !this.target || event.button !== 0) return;');
    expect(EDIT_CANVAS).toContain('if (!this.enabled || event.button !== 0) return;');
  });

  it('routes the click through a host hook rather than reaching for the store', () => {
    // The interaction layer owns no data — it asks. Letting it read the
    // workspace store directly is how a UI layer acquires a second, looser
    // idea of what is selected.
    expect(EDIT_CANVAS).toMatch(/onPickFeature\?: \(world: \{ x: number; y: number \}\) => boolean/);
    expect(EDIT_CANVAS).toMatch(/if \(this\.host\.onPickFeature\?\.\(world\)\)/);
    expect(EDIT_CANVAS, 'the canvas is reading application state directly').not.toContain('store.');
  });

  it('opens through the same function the panel button uses', () => {
    // Two routes into the editor that do not share a code path is how a click
    // ends up skipping the geometry check the button makes — and vertex-edits
    // a point, which has no vertices to edit.
    expect(EDIT_TAB).toContain('export function openForVertexEdit(');
    expect(EDIT_TAB).toMatch(/const target = editTargetFor\(layerName, index, geometry as never\);\s*\n\s*if \(!target\) return false;/);
    // The panel's own handler delegates rather than repeating the assignment.
    expect(EDIT_TAB).toMatch(/openSelected = \(\) => \{[\s\S]{0,700}openForVertexEdit\(layerSelect\.value, index, feature\?\.geometry\)/);
  });

  it('hit-tests with the selection helper the Select tool uses', () => {
    // "What is under the cursor" must not have two answers.
    expect(EDIT_TAB).toContain("import { hitTest } from '../../core/selection'");
    expect(EDIT_TAB).toMatch(/const tolerance = PICK_RADIUS_PX \/ /);
  });

  it('re-claims the overlay after the render that would take it away', () => {
    // `renderPreview` resets the canvas's single overlay hook, so arming the
    // editor and then rendering hands the hook to whatever renders last. The
    // order of these two lines is the whole fix.
    const body = EDIT_TAB.slice(EDIT_TAB.indexOf('export function pickFeatureForEdit'));
    const render = body.indexOf('host.render();');
    const reattach = body.indexOf('ui.editCanvas?.reattach();');
    expect(render).toBeGreaterThan(-1);
    expect(reattach).toBeGreaterThan(render);
  });
});

describe('the pre-highlight, so an armed tool looks alive before the click', () => {
  it('asks the host what a click would open, without opening it', () => {
    expect(EDIT_CANVAS).toMatch(/ringsUnder\?: \(world: \{ x: number; y: number \}\) => Position\[\]\[\] \| null/);
    expect(EDIT_TAB).toContain('export function ringsUnderPointer(');
  });

  it('lights up nothing for geometry that cannot be vertex-edited', () => {
    // Built through `editTargetFor`, so a point pre-highlights nothing rather
    // than inviting a click that can only log a refusal.
    expect(EDIT_TAB).toMatch(/return editTargetFor\(hit\.layer, hit\.index, hit\.geometry as never\)\?\.rings \?\? null;/);
    expect(editTargetFor('L', 0, { type: 'Point', coordinates: [1, 2] })).toBeNull();
    expect(editTargetFor('L', 0, { type: 'LineString', coordinates: [[0, 0], [1, 1]] })?.rings).toEqual([
      [
        [0, 0],
        [1, 1],
      ],
    ]);
  });

  it('moves the pointer-move guard so hover works with nothing open', () => {
    expect(EDIT_CANVAS).not.toMatch(/private handlePointerMove = \(event: PointerEvent\): void => \{\s*\n\s*if \(!this\.enabled \|\| !this\.target\) return;/);
  });

  it('clears the pre-highlight whenever the editor stops or opens something', () => {
    // A stale candidate outlives its reason to exist and draws a ghost over a
    // feature the user is no longer hovering.
    const setEnabled = EDIT_CANVAS.slice(EDIT_CANVAS.indexOf('setEnabled(enabled: boolean)'), EDIT_CANVAS.indexOf('isEnabled()'));
    expect(setEnabled).toContain('this.candidate = null;');
    const setTarget = EDIT_CANVAS.slice(EDIT_CANVAS.indexOf('setTarget(target: EditTarget | null)'), EDIT_CANVAS.indexOf('getSelection()'));
    expect(setTarget).toContain('this.candidate = null;');
  });
});

describe('the rubber band: left keeps the CAD direction rule, right is always a window', () => {
  it('lets the right button start a band from anywhere, including over geometry', () => {
    expect(TOOL_CANVAS).toMatch(/if \(event\.button === 2\) \{[\s\S]{0,200}kind: 'band'[\s\S]{0,60}button: 2/);
  });

  it('keeps the left button reading its mode from the drag direction', () => {
    // The owner asked for both: the direction rule stays, and the button wins
    // when it is used. A right-drag leftwards is still a window.
    expect(TOOL_CANVAS).toContain("const mode = gesture.button === 2 || gesture.to[0] >= gesture.from[0] ? 'contain' : 'intersect';");
  });

  it('draws the band it is going to commit', () => {
    // The band that is painted and the band that is applied read the same
    // condition. Two copies of this rule is how a band promises "window" in
    // solid blue and then commits a crossing.
    expect(TOOL_CANVAS).toContain("const contain = gesture.button === 2 || gesture.to[0] >= gesture.from[0];");
    expect(TOOL_CANVAS).toMatch(/gesture: \{ from: Position; to: Position; button: number \}\s*\n\s*\): void \{\s*\n\s*\/\/ Same rule/);
  });

  it('suppresses the browser menu only while a tool is live', () => {
    // With no tool enabled the canvas is an ordinary page element, and taking
    // the context menu away from it would be taking away Save image as.
    expect(TOOL_CANVAS).toMatch(/private handleContextMenu = \(event: MouseEvent\): void => \{\s*\n\s*if \(!this\.enabled\) return;\s*\n\s*event\.preventDefault\(\);/);
    expect(TOOL_CANVAS).toContain("element.removeEventListener('contextmenu', this.handleContextMenu, { capture: true });");
  });

  it('leaves the selection alone on a right-click that never dragged', () => {
    // A press and release in one spot never asked for the selection to change.
    // Falling through to "click on empty space clears the selection" would let
    // a mis-aimed right-click throw away a dozen shift-clicks.
    //
    // That press now also raises the canvas menu — which is precisely the case
    // a bare right-click DOES mean something — so the branch returns before the
    // clearing code rather than merely returning. What matters is that it
    // returns at all, and that it does so ahead of the clear.
    const band = TOOL_CANVAS.slice(TOOL_CANVAS.indexOf('case \'band\': {', TOOL_CANVAS.indexOf('handlePointerUp')));
    const rightClick = band.indexOf('gesture.button === 2');
    const clears = band.indexOf('A click on empty space clears the selection');
    expect(rightClick, 'the bare right-click branch is gone').toBeGreaterThan(-1);
    expect(clears).toBeGreaterThan(rightClick);
    expect(band.slice(rightClick, clears)).toContain('return;');
  });

  it('raises the canvas menu from that same press, not from a contextmenu event', () => {
    // `contextmenu` fires on PRESS, so listening for it would pop a menu over
    // the start of every right-drag band. Only the pointer-up path knows the
    // press did not become a drag.
    expect(TOOL_CANVAS).toContain('this.host.onContextMenu?.(event.clientX, event.clientY');
    expect(TOOL_CANVAS).toMatch(/onContextMenu\?: \(screenX: number, screenY: number, world: Position\) => void/);
  });

  it('says which band it is, for both buttons', () => {
    expect(TOOL_CANVAS).toContain("if (gesture.button === 2) return 'Right-drag: taking only features wholly inside the band.';");
    expect(TOOL_CANVAS).toContain("'Taking every feature the band touches.'");
  });
});

describe('Escape steps back one level instead of closing the tool', () => {
  it('asks every live engine before returning the canvas to Pan', () => {
    expect(MAIN).toMatch(/ui\.toolCanvas\?\.consumesEscape\(\) === true/);
    expect(MAIN).toMatch(/ui\.editCanvas\?\.consumesEscape\(\) === true/);
    expect(MAIN).toMatch(/ui\.measureCanvas\?\.consumesEscape\(\) === true/);
    expect(MAIN).toContain('if (!busy) setCanvasTool(\'pan\');');
  });

  it('no longer guards on a part-drawn polygon alone', () => {
    // THE BUG: everything below the first rung of the ladder was unreachable.
    expect(MAIN).not.toContain("if (event.key === 'Escape' && !ui.toolCanvas?.isDrawing()) {");
  });

  it('drops the vertex selection first and the open feature second', () => {
    const handler = EDIT_CANVAS.slice(EDIT_CANVAS.indexOf('private handleKey('));
    const selectionRung = handler.indexOf('if (this.selection.length > 0) {');
    const targetRung = handler.indexOf('if (this.target) {');
    expect(selectionRung).toBeGreaterThan(-1);
    expect(targetRung).toBeGreaterThan(selectionRung);
  });

  it('clears the panel\'s copy of the target as well as the canvas\'s', () => {
    // Clearing only one of the two lets the next render re-open the feature
    // the user just dismissed.
    expect(EDIT_TAB).toMatch(/export function closeVertexEdit\(\): void \{\s*\n\s*ui\.editTarget = null;/);
    expect(EDIT_CANVAS).toContain('this.host.onCloseTarget?.();');
  });

  it('still deletes vertices with Delete, and still ignores keys meant for a text field', () => {
    const handler = EDIT_CANVAS.slice(EDIT_CANVAS.indexOf('private handleKey('), EDIT_CANVAS.indexOf('// ------------------------------------------------------------- drawing'));
    expect(handler).toContain('/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)');
    expect(handler).toMatch(/event\.key === 'Delete' \|\| event\.key === 'Backspace'\) && this\.selection\.length > 0/);
  });
});
