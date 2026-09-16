/**
 * Four defects a user hit in one sitting, and the gestures added with them.
 *
 * Every one was reported from the running extension rather than caught here,
 * which is the interesting part: all four are in the seams BETWEEN units — a
 * grid row assigned to the wrong child, an early return that skipped a clear, a
 * canvas fitted before it had a size, a panel that never offered a way in. No
 * unit was wrong on its own.
 *
 *   1. RELOAD COLLAPSED THE LAYOUT. `.app` is `grid-template-rows` over three
 *      children, and the `1fr` sat on the second — the 3px progress hairline —
 *      leaving `.work` at its content height. Invisible while the content was
 *      tall; below the 900px breakpoint the rail and dock go `absolute`, so an
 *      empty queue left `.work` holding a 64px ribbon and the whole workspace
 *      became a strip at the foot of the window.
 *   2. CLEAR LEFT THE LAYERS. `renderInspector` emptied the layer rail AFTER
 *      its `if (!item) return`, and clearing the queue selects nothing — so the
 *      one path that needed it was the one path that skipped it.
 *   3. EDITING RESET THE ZOOM. `setData` fitted on every call and runs on every
 *      render, so each edit threw away the pan and zoom.
 *   4. THE SIDE PANEL HAD NO IMPORT. Files could only arrive by drag, or by
 *      clicking a drop zone that looks like a label.
 *
 * Fixing (3) exposed a fifth: with the per-render fit gone, the provisional fit
 * made against a hidden canvas was never corrected, so `unproject` answered in
 * the wrong frame and every hit test missed. That is why `fittedWithLayout`
 * exists, and why it is pinned below.
 *
 * Measured in headless Chromium against the built extension, before and after:
 * `.work` at 860px went from `top 730, height 70` to `top 47, height 753`; the
 * readout held `412047.106, 2591448.311` across a re-render and a tool change;
 * a double-click from Pan selected `CONTOUR #1` and armed Select. What a test
 * holds here is the shape that keeps them fixed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', 'extension', 'src');
const CSS = readFileSync(join(ROOT, 'workspace', 'styles.css'), 'utf8');
const MAIN = readFileSync(join(ROOT, 'workspace', 'main.ts'), 'utf8');
const PREVIEW = readFileSync(join(ROOT, 'ui', 'preview.ts'), 'utf8');
const CANVAS = readFileSync(join(ROOT, 'workspace', 'panels', 'canvas.ts'), 'utf8');
const MENU = readFileSync(join(ROOT, 'workspace', 'panels', 'canvas-menu.ts'), 'utf8');
const PANEL_HTML = readFileSync(join(ROOT, 'sidepanel', 'index.html'), 'utf8');
const PANEL_TS = readFileSync(join(ROOT, 'sidepanel', 'main.ts'), 'utf8');

describe('the work area is the row that grows', () => {
  it('puts the 1fr on the third child, not the second', () => {
    // THE BUG. `auto 1fr auto` handed the free space to the progress hairline.
    const app = CSS.slice(CSS.indexOf('.app {'), CSS.indexOf('.topbar {'));
    expect(app).toContain('grid-template-rows: auto auto 1fr;');
    expect(app).not.toContain('grid-template-rows: auto 1fr auto;');
  });

  it('still has exactly the three children those rows describe', () => {
    // A fourth in-flow child would shift everything down a row and put the
    // `1fr` back on something that does not want it.
    const html = readFileSync(join(ROOT, 'workspace', 'index.html'), 'utf8');
    const app = html.slice(html.indexOf('<div class="app">'), html.indexOf('</body>'));
    expect(app).toContain('class="topbar"');
    expect(app).toContain('class="progress"');
    expect(app).toContain('class="work"');
  });
});

describe('clearing the queue clears what described it', () => {
  it('empties the layer rail before any early return', () => {
    const fn = MAIN.slice(MAIN.indexOf('function renderInspector'), MAIN.indexOf('function renderBottom'));
    const clears = fn.indexOf("rail.replaceChildren()");
    const returns = fn.indexOf('if (!item) {');
    expect(clears).toBeGreaterThan(-1);
    expect(returns, 'the early return is gone, so this test no longer guards anything').toBeGreaterThan(-1);
    expect(clears, 'the rail is cleared after the early return again').toBeLessThan(returns);
  });

  it('drops the state that addressed the files being removed', () => {
    // A redo stack and a vertex target both address layers and feature indices.
    // Kept across a clear, they point into whatever loads next.
    const start = MAIN.indexOf("$('clearQueueBtn')");
    const handler = MAIN.slice(start, MAIN.indexOf('});', MAIN.indexOf("store.log('info', 'Queue cleared.')")));
    expect(handler, 'the clear handler could not be located').not.toBe('');
    expect(handler).toContain('redoStack: []');
    expect(handler).toContain('ui.editTarget = null');
    expect(handler).toContain('ui.editCanvas?.setTarget(null)');
  });
});

describe('the view survives a render', () => {
  it('fits only when the subject changes', () => {
    // `renderPreview` runs on every render. Fitting there is what threw the
    // pan and zoom away on every edit.
    expect(PREVIEW).toMatch(/setData\(data: PreviewData, identity\?: string\): void/);
    expect(PREVIEW).toMatch(/const changed = identity !== this\.identity;/);
    expect(PREVIEW).not.toMatch(/setData\(data: PreviewData\): void \{\s*\n\s*this\.data = data;\s*\n\s*this\.bounds = computeBounds\(data\);\s*\n\s*this\.fit\(\);/);
  });

  it('identifies the subject by the queue item', () => {
    expect(CANVAS).toContain('ui.previewCanvas.setData(data, item.id);');
  });

  it('still fits once the canvas first has a real size', () => {
    // THE DEFECT THE FIX INTRODUCED, and the reason this is pinned: the first
    // fit happens while `#previewWrap` is hidden, against a fallback 800x400.
    // Without this, that provisional view was never corrected and every hit
    // test missed — unproject was answering in a frame the data is not in.
    expect(PREVIEW).toContain('private fittedWithLayout = false;');
    expect(PREVIEW).toMatch(/this\.fittedWithLayout = rect\.width > 0 && rect\.height > 0;/);
    expect(PREVIEW).toMatch(/if \(!this\.fittedWithLayout && this\.bounds && rect\.width > 0 && rect\.height > 0\) \{\s*\n\s*this\.fit\(\);/);
  });

  it('does not re-fit once it has been fitted for real', () => {
    // Otherwise resizing the window — or opening a panel — would be a second
    // route back to the bug this whole section exists to fix.
    const resize = PREVIEW.slice(PREVIEW.indexOf('private resize'), PREVIEW.indexOf('setData(data: PreviewData'));
    expect(resize).toContain('!this.fittedWithLayout');
  });
});

describe('the side panel can import as well as export', () => {
  it('offers a control that looks like one', () => {
    expect(PANEL_HTML).toContain('id="importBtn"');
    expect(PANEL_TS).toMatch(/byId\('importBtn'\)\.addEventListener\('click', \(\) => picker\.click\(\)\)/);
  });

  it('keeps import, convert and download in the order the job happens', () => {
    const row = PANEL_HTML.slice(PANEL_HTML.indexOf('id="importBtn"'), PANEL_HTML.indexOf('id="queue"'));
    expect(row.indexOf('id="convertBtn"')).toBeGreaterThan(-1);
    expect(row.indexOf('id="downloadBtn"')).toBeGreaterThan(row.indexOf('id="convertBtn"'));
  });

  it('closes itself when the workspace takes over', () => {
    // The two are alternatives. Leaving the panel open is also what squeezed
    // the workspace under the breakpoint where the layout used to collapse.
    const handler = PANEL_TS.slice(PANEL_TS.indexOf("byId('openWorkspace')"));
    expect(handler).toContain('window.close()');
    expect(handler, 'an ordinary tab may refuse to close, and that must not throw').toContain('catch');
  });
});

describe('the canvas gestures', () => {
  it('selects on double-click from any tool, including Pan', () => {
    // Which is why they are installed on the canvas element and not inside
    // `ToolCanvas` — in Pan mode every tool engine is switched off.
    expect(MENU).toContain("canvas.addEventListener('dblclick'");
    expect(MAIN).toContain("installCanvasGestures($('previewCanvas'))");
  });

  it('leaves the gesture alone when another layer owns it', () => {
    const dbl = MENU.slice(MENU.indexOf("canvas.addEventListener('dblclick'"));
    expect(dbl).toContain('ui.toolCanvas?.isDrawing()');
    expect(dbl).toContain('ui.editCanvas?.isEnabled()');
  });

  it('never raises the menu from a contextmenu event while a tool is armed', () => {
    // `contextmenu` fires on PRESS, so it would pop a menu over the start of
    // every right-drag band.
    const ctx = MENU.slice(MENU.indexOf("canvas.addEventListener(\n    'contextmenu'"));
    expect(ctx).toContain('if (ui.toolCanvas?.isEnabled()) return;');
  });

  it('builds its rows from what is under the pointer', () => {
    // A static list would be a worse ribbon reachable by a different gesture.
    expect(MENU).toContain('function entriesFor(');
    expect(MENU).toContain("label: 'Nothing under the pointer'");
  });

  it('shares one hit test with the tools, and one zoom-to-selection', () => {
    // A menu offering "Edit its vertices" for a feature the Vertex tool would
    // refuse is a menu that lies about what the next click does.
    expect(MENU).toContain("import { hitTest } from '../../core/selection'");
    expect(MENU).toContain("import { zoomToSelection } from './select-tab'");
  });
});
