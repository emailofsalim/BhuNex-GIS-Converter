/**
 * One ribbon, every tab, nothing duplicated — and a row the user can have back.
 *
 * WHAT THIS REPLACES
 *
 * The workspace used to stack FOUR rows of tabs above the first line of
 * content: the ribbon's own caption and control row, floating over the top-left
 * of the drawing, and inside the right-hand dock a group strip (Data / Edit /
 * Export / Results) above a section strip with a "More" drop-down. Two of those
 * rows chose between the same things in two different places, and the earlier
 * `dock-fold.test.ts` pinned a fold for the group strip that no longer exists
 * because the strip itself no longer exists.
 *
 * So the invariants worth holding are different now:
 *   · the four dock groups are ribbon tabs, and are NOT also somewhere else;
 *   · every section that was reachable from the old strips is still reachable;
 *   · the ribbon folds to its caption and remembers it, Excel-style;
 *   · the canvas is a sibling of the ribbon, not a surface underneath it.
 *
 * The suite runs on node with no jsdom, so the behaviour was driven in headless
 * Chromium against the built extension: nine tabs in one caption and no
 * duplicate label anywhere, a 6px gap between the ribbon and the canvas, the
 * fold taking the ribbon to 32px and giving the canvas 815, a tab click while
 * folded peeking and a click on the drawing folding it away again, and Ctrl+F1
 * unfolding for good. What a test holds here is the shape.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DOCK_GROUPS, ownerOfSection, PANEL_TABS, RIBBON_TABS } from '../src/workspace/panels/toolbar';

const ROOT = join(import.meta.dirname, '..', '..', 'extension', 'src', 'workspace');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const CSS = readFileSync(join(ROOT, 'styles.css'), 'utf8');
const MAIN = readFileSync(join(ROOT, 'main.ts'), 'utf8');
const TOOLBAR = readFileSync(join(ROOT, 'panels', 'toolbar.ts'), 'utf8');

describe('the four dock groups live in the ribbon, and only there', () => {
  it('names the FILE-oriented groups as panel tabs, and nothing else', () => {
    // "Edit" is deliberately absent. Data, Export and Results are about the
    // FILE — what was read, what will be written, what came out. Edit was
    // about the CANVAS, which is what the whole left half of the caption
    // already is, so it was a second home for panels the tool families own.
    // That is the duplication the owner reported: "there is Modify as well as
    // Edit I think both are for same purpose".
    expect(PANEL_TABS.map((tab) => tab.label)).toEqual(['Data', 'Export', 'Results']);
  });

  it('still shows the edit group in the dock, it just has no caption tab', () => {
    // The GROUP has to survive: `showGroupBody` needs one to pick a body and
    // record in `inspectorGroup`. Conflating "a group exists" with "a caption
    // tab must exist for it" is what invented the duplicate in the first place.
    expect(DOCK_GROUPS).toContain('edit');
    expect(PANEL_TABS.some((tab) => tab.group === 'edit')).toBe(false);
  });

  it('leaves no copy of them in the dock markup', () => {
    // THE DUPLICATION, exactly. Any of these coming back means the same four
    // choices exist in two places again.
    for (const dead of ['groups__top', 'groups__sub', 'data-groupfor', 'data-group=', 'data-bottom=', 'gtab']) {
      expect(HTML, `"${dead}" is back in the dock markup`).not.toContain(dead);
    }
    expect(HTML).not.toContain('id="inspectorTabs"');
  });

  it('leaves no CSS for them either', () => {
    // Dead rules outlive the markup and quietly restyle whatever reuses a name.
    for (const dead of ['.gtab', '.groups__top', '.groups__sub', '.groups__fold']) {
      expect(CSS, `"${dead}" is still styled`).not.toContain(dead);
    }
  });

  it('leaves no handlers wiring markup that is gone', () => {
    for (const dead of ["querySelectorAll('[data-tab]')", "querySelectorAll('[data-group]')", "querySelectorAll('[data-bottom]')", 'closeSectionStrips', 'openSectionStrip']) {
      expect(MAIN, `main.ts still wires "${dead}"`).not.toContain(dead);
    }
  });

  it('keeps every section that the old two-level picker could reach', () => {
    // A section dropped in the move is a panel the user can no longer open at
    // all — the quietest way to lose a feature.
    // Reachability now spans BOTH halves of the caption: the file groups list
    // their sections, and each tool family lists the ones it owns.
    const reachable = new Set([
      ...PANEL_TABS.flatMap((tab) => tab.sections.map((section) => section.tab)),
      ...RIBBON_TABS.flatMap((tab) => tab.panels.map((panel) => panel.tab)),
    ]);
    const before = [
      'overview', 'geometry', 'crs', 'attributes', 'metadata',
      'select', 'edit', 'measure', 'geometry-ops', 'repair', 'backdrop', 'georef',
      'fidelity', 'compare', 'warnings',
      'qa', 'log', 'delivery', 'manifest', 'health', 'history', 'workflows',
    ];
    const missing = before.filter((section) => !reachable.has(section));
    expect(missing, 'these sections are no longer reachable from any ribbon tab').toEqual([]);
  });

  it('gives no tab label to two different tabs', () => {
    const labels = [...RIBBON_TABS.map((tab) => tab.label), ...PANEL_TABS.map((tab) => tab.label)];
    const duplicated = labels.filter((label, index) => labels.indexOf(label) !== index);
    expect([...new Set(duplicated)], 'two tabs share a label, so which one is lit is a guess').toEqual([]);
  });

  it('routes Results through the bottom body and everything else through the inspector', () => {
    // Results is the old bottom dock; its sections are `showBottomTab` names,
    // not inspector tabs, and rendering them into the wrong body shows an empty
    // panel with no error.
    expect(PANEL_TABS.filter((tab) => tab.body === 'bottom').map((tab) => tab.id)).toEqual(['results']);
  });

  it('gives each section exactly one owner across the whole caption', () => {
    // THE INVARIANT THAT REPLACED "no panel buttons in tool rows".
    //
    // Those buttons were removed once because the Edit tab listed the same
    // sections, so one panel had two buttons in one bar. Deleting Edit was the
    // better half of that fix: the buttons are back on the families that own
    // them, and what must hold now is that nothing is listed TWICE.
    // CROSS-HALF duplication is the bug. A section offered by a file group AND
    // by a tool family is the same panel reached from two unrelated places,
    // which is what "Edit" was doing to every family.
    const byFamily = new Set(RIBBON_TABS.flatMap((tab) => tab.panels.map((panel) => panel.tab)));
    const byGroup = PANEL_TABS.flatMap((tab) => tab.sections.map((section) => section.tab));
    const bothHalves = byGroup.filter((tab) => byFamily.has(tab));
    expect(
      bothHalves,
      'these sections are offered from both halves of the caption — the duplication that was just removed'
    ).toEqual([]);

    // Two tool families SHARING one panel is allowed and is not that bug. Home
    // and Draw both open `select`, because it holds the selection settings and
    // the snap/ortho drawing settings in one panel and each family labels it
    // for what it uses. Only one family's row is visible at a time, so the user
    // never sees two buttons for it — unlike Edit, which sat in the same
    // caption row as the families it duplicated.
    for (const tab of [...RIBBON_TABS, ...PANEL_TABS]) {
      const own = 'panels' in tab ? tab.panels.map((p) => p.tab) : tab.sections.map((s) => s.tab);
      const twice = own.filter((entry, index) => own.indexOf(entry) !== index);
      expect([...new Set(twice)], `"${tab.label}" lists a section twice in its own row`).toEqual([]);
    }
  });

  it('resolves every section to a single owning tab', () => {
    for (const tab of new Set(RIBBON_TABS.flatMap((entry) => entry.panels.map((panel) => panel.tab)))) {
      expect(ownerOfSection(tab), `"${tab}" resolves to no caption tab`).not.toBeNull();
    }
  });
});

describe('a tool family keeps the ribbon when it opens its own panel', () => {
  it('does not let the panel it opened move the tab again', () => {
    // THE REGRESSION this guards. Both kinds of tab can open the same dock
    // group: "Modify" opens the Vertices panel, and so does the Edit tab's
    // Vertices section. Moving the ribbon unconditionally made clicking Modify
    // land on Edit — the family set the tab, opened its panel, and the panel
    // set the tab again, so the Vertex button was not on screen at all.
    expect(MAIN).toContain('function alignRibbonTo(group: string): void {');
    // Now `some`, not `panels[0]`: a family owns several sections (Modify has
    // Vertices, Geometry tools and Repair), so checking only the first would
    // move the ribbon off Modify whenever Repair was the one opened.
    expect(MAIN).toMatch(/if \(family && family\.panels\.some\(\(panel\) => panel\.group === group\)\) return;/);
  });

  it('gives every tool family a panel to own', () => {
    // The rule above is "a family that already owns the group keeps it". A
    // family with no panel owns nothing and would be moved off by its own
    // click, which is the bug wearing a different hat.
    const orphans = RIBBON_TABS.filter((tab) => !tab.panels[0]).map((tab) => tab.label);
    expect(orphans, 'these tool families open no panel, so they cannot hold the ribbon').toEqual([]);
  });

  it('points each family at a group the DOCK can show', () => {
    // Checked against the dock's real capability rather than against
    // PANEL_TABS membership. A group with no caption tab is still a group the
    // dock shows — that is exactly what `edit` is now.
    const groups = new Set<string>(DOCK_GROUPS);
    for (const tab of RIBBON_TABS) {
      for (const panel of tab.panels) {
        expect(groups.has(panel.group), `${tab.label} opens unknown group "${panel.group}"`).toBe(true);
      }
    }
  });

  it('shows exactly one body per group, from one place', () => {
    // Two callers toggling `inspectorBody` and `bottomBody` is how both end up
    // hidden and the dock goes blank with no error.
    expect(MAIN).toContain('function showGroupBody(group: string): void {');
    const toggles = [...MAIN.matchAll(/\$\('(inspectorBody|bottomBody)'\)\.classList\.toggle/g)];
    expect(toggles).toHaveLength(2);
  });
});

describe('the ribbon folds like a spreadsheet ribbon', () => {
  it('folds to the caption and keeps the tabs', () => {
    // A bar that folds to nothing is a bar you cannot get back.
    expect(TOOLBAR).toMatch(/into\.classList\.toggle\('ribbon--closed', collapsed\);\s*\n\s*if \(collapsed\) return;/);
    expect(CSS).toContain('.ribbon--closed .ribbon__caption');
  });

  it('remembers the choice through the shared collapse store', () => {
    // Not a private boolean: the panes, the layer list and the settings groups
    // already persist through `collapse.ts`, so the ribbon cannot develop its
    // own idea of what folded means or forget it on reload.
    expect(TOOLBAR).toContain("import { isCollapsed, setCollapsed } from '../collapse'");
    expect(TOOLBAR).toMatch(/setCollapsed\(RIBBON_FOLD, !closed\)/);
  });

  it('offers the three controls Excel does', () => {
    // The chevron, a double-click on a tab, and Ctrl+F1.
    expect(TOOLBAR).toContain("class: 'ribbon__fold'");
    expect(TOOLBAR).toMatch(/node\.addEventListener\('dblclick'/);
    expect(MAIN).toMatch(/event\.key === 'F1' && event\.ctrlKey/);
  });

  it('peeks while folded rather than unfolding for good', () => {
    // Without the peek, using a folded ribbon unfolds it permanently and the
    // fold appears not to work at all.
    expect(TOOLBAR).toMatch(/if \(isCollapsed\(RIBBON_FOLD\)\) ui\.ribbonPeek = true;/);
    expect(TOOLBAR).toContain('const collapsed = isCollapsed(RIBBON_FOLD) && ui.ribbonPeek !== true;');
  });

  it('dismisses the peek on the next click on the drawing', () => {
    expect(MAIN).toMatch(/if \(ui\.ribbonPeek !== true \|\| !ribbonIsFolded\(\)\) return;/);
  });

  it('does not persist the peek', () => {
    // It is a transient. Writing it to the collapse store would mean a reload
    // came back unfolded after a single peek.
    expect(TOOLBAR).not.toMatch(/setCollapsed\([^)]*ribbonPeek/);
  });
});

describe('the canvas starts below the ribbon', () => {
  it('makes the stage two rows rather than one positioned surface', () => {
    expect(CSS).toMatch(/\.stage \{[^}]*display: flex;[^}]*flex-direction: column;/);
    expect(CSS).toContain('.stage__canvas {');
  });

  it('leaves a gap between the two', () => {
    // The request was explicit: a little daylight, so the drawing does not read
    // as more bar.
    expect(CSS).toMatch(/\.stage__canvas \{[^}]*margin-top: 6px;/);
  });

  it('puts the ribbon outside the canvas wrapper in the markup', () => {
    // If it slid back inside `.preview` it would float over the drawing again.
    const ribbon = HTML.indexOf('id="canvasToolbar"');
    const wrapper = HTML.indexOf('class="stage__canvas"');
    expect(ribbon).toBeGreaterThan(-1);
    expect(wrapper).toBeGreaterThan(ribbon);
  });

  it('keeps the tool readout floating, because it is a readout and not a bar', () => {
    expect(HTML).toContain('id="toolStatus"');
    expect(CSS).toContain('.cbar--status');
  });
});
