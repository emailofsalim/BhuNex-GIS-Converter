/**
 * The help page cannot describe a workspace that no longer exists.
 *
 * WHY THIS FILE EXISTS
 *
 * Help had a shortcut table generated from `CANVAS_TOOLS`, `CANVAS_ACTIONS`
 * and `GLOBAL_SHORTCUTS` — the same lists the toolbar builds from and the key
 * handler dispatches on — precisely so a documented key is a key that works.
 * Everything else on that page was prose, and prose about an interface goes
 * stale silently: the reader has no way to tell a sentence that was true last
 * release from one that is true now, and the tool looks broken rather than
 * mis-documented.
 *
 * 1.11.6 moved every tab in the workspace onto one ribbon. The page describing
 * where things are is therefore GENERATED from `RIBBON_TABS` and `PANEL_TABS`
 * for the same reason the shortcut table is, and these tests pin that: a tab
 * added, renamed or removed shows up in Help with no edit, and a future session
 * that replaces the generated section with a typed-out list fails here.
 *
 * The rendering itself was checked in headless Chromium against the built
 * extension — the section appears, its table carries all nine tabs, and About
 * links the running version to its own release notes. What a test holds here is
 * that the content comes from the lists rather than from someone's memory.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GLOBAL_SHORTCUTS } from '../src/workspace/panels/toolbar';

const ROOT = join(import.meta.dirname, '..', '..', 'extension', 'src', 'workspace');
const SETTINGS = readFileSync(join(ROOT, 'panels', 'settings.ts'), 'utf8');
const README = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8');

describe('Help explains where things are, from the lists that build them', () => {
  it('generates the tab table rather than listing tabs by hand', () => {
    // A typed list is a list nobody updates. `RIBBON_TABS` and `PANEL_TABS` are
    // what the ribbon caption is built from, so iterating them is the only way
    // Help and the bar cannot disagree.
    expect(SETTINGS).toContain('function ribbonSection(): HTMLElement {');
    expect(SETTINGS).toMatch(/for \(const tab of RIBBON_TABS\)/);
    expect(SETTINGS).toMatch(/for \(const tab of PANEL_TABS\)/);
  });

  it('shows that section in the Help dialog, not somewhere it will not be found', () => {
    const help = SETTINGS.slice(SETTINGS.indexOf('export function openHelpDialog'));
    const ribbon = help.indexOf('body.append(ribbonSection());');
    const shortcuts = help.indexOf('body.append(shortcutSection());');
    expect(ribbon).toBeGreaterThan(-1);
    // Where things ARE comes before what the keys DO: a reader who cannot find
    // the Vertices panel is not helped by a key that opens it.
    expect(shortcuts).toBeGreaterThan(ribbon);
  });

  it('describes the fold with the three controls that actually perform it', () => {
    const start = SETTINGS.indexOf('function ribbonSection');
    const section = SETTINGS.slice(start, SETTINGS.indexOf('function shortcutSection', start));
    expect(section, 'the ribbon section is empty — the slice bounds are wrong, not the code').not.toBe('');
    expect(section).toContain('Ctrl+F1');
    expect(section).toContain('double-click');
    expect(section).toContain('chevron');
    // The peek is the part that makes a folded ribbon usable rather than
    // something you unfold first, so it has to be stated.
    expect(section).toMatch(/until the next click on the drawing/);
  });

  it('keeps the shortcut table generated too', () => {
    // The rule this file exists to extend, restated so it cannot be quietly
    // dropped while the ribbon section is edited.
    expect(SETTINGS).toMatch(/\['Canvas tools', CANVAS_TOOLS\.map/);
    expect(SETTINGS).toContain("['Canvas actions', CANVAS_ACTIONS]");
    expect(SETTINGS).toContain("['Workspace', GLOBAL_SHORTCUTS]");
  });

  it('documents Ctrl+F1 in the list the key handler dispatches on', () => {
    // Not in prose. `GLOBAL_SHORTCUTS` is what the table renders, so a key
    // described only in a paragraph is a key the table omits.
    const fold = GLOBAL_SHORTCUTS.find((shortcut) => shortcut.key === 'Ctrl+F1');
    expect(fold, 'Ctrl+F1 is not in GLOBAL_SHORTCUTS, so the shortcut table will not show it').toBeDefined();
    expect(fold?.label).toMatch(/ribbon/i);
  });

  it('describes Escape as the ladder it is', () => {
    // It used to say "cancel the drawing, then clear the selection, then return
    // to Pan" while the shell jumped straight to Pan — the documentation was
    // right and the code was not. Now both describe the same rungs.
    const escape = GLOBAL_SHORTCUTS.find((shortcut) => shortcut.key === 'Esc');
    expect(escape?.hint).toMatch(/one level per press/i);
    expect(escape?.hint).toMatch(/vertex selection/i);
  });
});

describe('the behaviour rules cover what changed', () => {
  const rules = SETTINGS.slice(SETTINGS.indexOf('const rules: [string, string][]'), SETTINGS.indexOf('body.append(ribbonSection())'));

  it('states that the grid names its CRS and its unit', () => {
    // The caption is a claim about scale. A help page that does not mention it
    // leaves the reader no way to know the unit is checked rather than assumed.
    expect(rules).toContain('The grid names the frame its numbers are in');
    expect(rules).toMatch(/\(assumed\)/);
  });

  it('states both selection conventions, including the right button', () => {
    expect(rules).toContain('Selection follows the CAD conventions');
    expect(rules).toMatch(/WHOLLY INSIDE/);
    expect(rules, 'a right-click that does not drag must be documented as a no-op').toMatch(
      /right-click that does not drag changes nothing/
    );
  });

  it('states the Escape ladder in the rules as well as the table', () => {
    expect(rules).toContain('Escape steps back one level');
  });
});

describe('About says what this build is and links its own notes', () => {
  it('links the running version to its release notes rather than carrying a changelog', () => {
    // A "what's new" list maintained in the dialog is a second copy of the
    // release notes, and the copy nobody updates is always the one on screen.
    expect(SETTINGS).toMatch(/\$\{REPOSITORY_URL\}\/releases\/tag\/v\$\{version\}/);
    expect(SETTINGS).toMatch(/export const REPOSITORY_URL = /);
  });

  it('only offers the link when a version is actually known', () => {
    // `chrome.runtime` is absent in a plain page, so the version can be empty —
    // and a link to `/releases/tag/v` is a 404 presented as documentation.
    expect(SETTINGS).toMatch(/if \(version\) \{[\s\S]{0,400}releases\/tag/);
  });

  it('describes the tool as it is now, not as a converter alone', () => {
    expect(SETTINGS).toMatch(/converter and editing workstation/);
  });

  it('keeps the licence notice, which is the reason the dialog exists', () => {
    expect(SETTINGS).toMatch(/Licence.*MIT/s);
    expect(SETTINGS).toContain('AUTHOR');
  });
});

describe('the README matches the workspace it describes', () => {
  it('shows the one ribbon and both halves of it', () => {
    expect(README).toMatch(/Home {2}Draw {2}Modify {2}Measure {2}Place {2}│ {2}Data {2}Edit {2}Export {2}Results/);
  });

  it('documents the right-button band, which a reader cannot discover', () => {
    // Left-drag direction is a convention people arrive with. The right button
    // is this tool's addition, so it is only in the product if it is written
    // down somewhere a new user reads.
    expect(README).toMatch(/\*\*right button\*\*/);
    expect(README).toMatch(/right-click\s*\n?\s*that does not drag changes nothing/);
  });

  it('documents opening a feature for vertex editing by clicking it', () => {
    expect(README).toMatch(/Move vertices by clicking the thing you want to move/);
  });

  it('documents the fold and the grid caption', () => {
    expect(README).toContain('Ctrl+F1');
    expect(README).toMatch(/`\(assumed\)`/);
  });

  it('does not still claim the old floating toolbar or dock tab rows', () => {
    for (const stale of ['group row', 'Data / Edit / Export / Results strip', 'floating toolbar']) {
      expect(README, `the README still describes "${stale}"`).not.toContain(stale);
    }
  });
});
