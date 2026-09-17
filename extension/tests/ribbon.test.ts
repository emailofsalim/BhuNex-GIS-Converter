/**
 * The ribbon must not lose a tool.
 *
 * Twenty buttons on one line became five tabs showing a handful each. The
 * failure mode of that change is silent and total: a tool left off every tab is
 * gone from the product, with nothing on screen to say so and no test that
 * would notice — the tool still exists, still has a keyboard shortcut, and is
 * simply unreachable by mouse.
 *
 * So the invariant is checked directly against `CANVAS_TOOLS`, which is the
 * same list that drives the shortcut table in Help. Adding a tool without
 * putting it on a tab fails here rather than shipping.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCK_GROUPS, CANVAS_ACTIONS, CANVAS_TOOLS, RIBBON_TABS, ribbonTabFor } from '../src/workspace/panels/toolbar';

describe('every tool is reachable from the ribbon', () => {
  const placed = RIBBON_TABS.flatMap((tab) => tab.tools);

  it('places every tool on a tab', () => {
    const missing = CANVAS_TOOLS.filter((tool) => !placed.includes(tool.id)).map((tool) => tool.label);
    expect(missing, 'these tools are on no ribbon tab, so the mouse cannot reach them').toEqual([]);
  });

  it('places each tool on exactly one tab, so the lit state is unambiguous', () => {
    // A tool on two tabs would light on one and not the other depending on
    // which `ribbonTabFor` happened to find first.
    const duplicated = placed.filter((id, index) => placed.indexOf(id) !== index);
    expect([...new Set(duplicated)], 'a tool appears on more than one tab').toEqual([]);
  });

  it('names only tools that exist', () => {
    const known = new Set(CANVAS_TOOLS.map((tool) => tool.id));
    const unknown = placed.filter((id) => !known.has(id));
    expect(unknown, 'a tab names a tool id that is not in CANVAS_TOOLS').toEqual([]);
  });

  it('names only actions that the bar can build', () => {
    const known = new Set(CANVAS_ACTIONS.map((action) => action.id));
    const unknown = RIBBON_TABS.flatMap((tab) => tab.actions).filter((id) => !known.has(id));
    expect(unknown, 'a tab names an action with no button behind it').toEqual([]);
  });

  it('keeps every action reachable too', () => {
    // Undo and Redo were on the one bar and are easy to strand: they belong to
    // editing, not to any single tool family.
    const shown = new Set(RIBBON_TABS.flatMap((tab) => tab.actions));
    const missing = CANVAS_ACTIONS.filter((action) => !shown.has(action.id)).map((action) => action.label);
    expect(missing, 'these actions are on no tab').toEqual([]);
  });

  it('resolves a tool to the tab that actually holds it', () => {
    for (const tool of CANVAS_TOOLS) {
      const tab = RIBBON_TABS.find((each) => each.id === ribbonTabFor(tool.id));
      expect(tab?.tools, `${tool.label} resolves to a tab that does not contain it`).toContain(tool.id);
    }
  });

  it('falls back to a real tab for an unknown tool rather than a blank bar', () => {
    const tab = ribbonTabFor('not-a-tool' as never);
    expect(RIBBON_TABS.some((each) => each.id === tab)).toBe(true);
  });
});

describe('the panels a tab owns are real panels', () => {
  it('opens sections that exist in the dock', () => {
    // These strings are handed to `ui.openPanel(group, tab)` and match the
    // `data-group` / `data-tab` attributes in index.html. A typo here produces
    // a button that does nothing at all, which is the quietest kind of broken.
    // Both lists used to be typed out here, and both went stale the moment a
    // section moved: adding Repair to Modify failed this with "unknown
    // section", which looks like a broken button and was actually a stale
    // test. They are derived from the code now — the groups the dock declares,
    // and the sections the inspector switch actually has a case for.
    const groups = new Set<string>(DOCK_GROUPS);
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'workspace', 'main.ts'), 'utf8');
    const sections = new Set([...main.matchAll(/case '([a-z-]+)':/g)].map((match) => match[1]));
    for (const tab of RIBBON_TABS) {
      for (const panel of tab.panels) {
        expect(groups.has(panel.group), `${tab.label} → unknown dock group "${panel.group}"`).toBe(true);
        expect(sections.has(panel.tab), `${tab.label} → unknown section "${panel.tab}"`).toBe(true);
      }
    }
  });

  it('brings all six editing sections onto the ribbon', () => {
    // The point of the change: the editing panels used to be two levels of tab
    // away in the right dock. Every one of them should now be one click from
    // the bar.
    const reachable = new Set(RIBBON_TABS.flatMap((tab) => tab.panels.map((panel) => panel.tab)));
    for (const section of ['select', 'edit', 'measure', 'geometry-ops', 'backdrop', 'georef']) {
      expect(reachable.has(section), `the "${section}" panel is not reachable from any ribbon tab`).toBe(true);
    }
  });
});
