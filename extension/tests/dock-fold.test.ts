/**
 * One fold for the dock's group row.
 *
 * The section strip — Overview / Geometry / CRS / … — has always folded to just
 * the section you are in, with a "More" chevron to drop the rest down. The row
 * ABOVE it, Data / Edit / Export / Results, did not, so two rows of tabs sat
 * permanently between the top of the dock and anything worth reading.
 *
 * The owner asked for that row to fold too, and specifically for ONE control
 * rather than a chevron per tab: four collapse buttons to hide four buttons is
 * not a saving. So this is the same mechanism one level up, and the tests below
 * pin the two properties that make it worth having — a single button, and a
 * folded row that still says where you are.
 *
 * Read as source text in the manner of `reachability.test.ts`: the suite runs
 * on node with no jsdom, so the behaviour itself was checked in a browser
 * (folds, survives a reload, and switching group while folded updates which tab
 * shows). What a test can hold here is the shape of the thing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const MAIN = readFileSync(join(ROOT, 'extension', 'src', 'workspace', 'main.ts'), 'utf8');
const CSS = readFileSync(join(ROOT, 'extension', 'src', 'workspace', 'styles.css'), 'utf8');
const HTML = readFileSync(join(ROOT, 'extension', 'src', 'workspace', 'index.html'), 'utf8');

describe('the group row folds with a single control', () => {
  it('builds exactly one fold button, not one per group', () => {
    // The whole point of the request. A loop over `[data-group]` that appended
    // a chevron to each would satisfy "the row folds" and miss it entirely.
    const built = [...MAIN.matchAll(/class: 'groups__drop groups__fold'/g)];
    expect(built).toHaveLength(1);
    expect(MAIN, 'the fold is being created inside a per-group loop').not.toMatch(
      /for \(const gtab of[\s\S]{0,400}groups__fold/
    );
  });

  it('attaches it to the group row rather than to a tab', () => {
    expect(MAIN).toContain("document.querySelector('.groups__top')");
    expect(MAIN).toMatch(/groupRow\.append\(fold\)/);
  });

  it('keeps the group you are in when folded', () => {
    // A strip folded to nothing is a strip you cannot get back — and it is also
    // the only thing naming what the panel underneath belongs to.
    expect(CSS).toContain('.groups__top--closed .gtab:not(.gtab--on)');
  });

  it('mirrors the rule the section strip below already uses', () => {
    // Same idea, same selector shape, one level up. If these two ever diverge
    // the dock grows two different fold behaviours stacked on each other.
    expect(CSS).toContain('.groups__sub--closed .tab:not(.tab--on)');
  });

  it('remembers the choice through the shared collapse store', () => {
    // Not a private boolean. `isCollapsed`/`setCollapsed` is what the panes,
    // the layer list and the settings groups already persist through, so the
    // dock cannot develop its own idea of what "folded" means.
    expect(MAIN).toContain("import { installCollapse, isCollapsed, makeCollapsible, setCollapsed } from './collapse'");
    expect(MAIN).toMatch(/setCollapsed\(KEY, !isCollapsed\(KEY\)\)/);
  });

  it('says which way it will go, both ways', () => {
    // The title has to change with the state; a button that always reads
    // "Hide the other groups" is lying half the time.
    expect(MAIN).toMatch(/closed \? 'Show the other groups' : 'Hide the other groups'/);
    expect(MAIN).toMatch(/aria-expanded', String\(!closed\)/);
  });
});

describe('the row it folds', () => {
  it('still holds the four groups in the markup', () => {
    // Folding is a view state. If a group ever disappears from the HTML the
    // fold would be hiding it permanently rather than temporarily.
    for (const group of ['data', 'edit', 'out', 'results']) {
      expect(HTML, `the ${group} group left the markup`).toContain(`data-group="${group}"`);
    }
  });

  it('starts open, so nothing is hidden before it is asked for', () => {
    // The section strip below is closed by default because fourteen sections
    // wrap to three rows. Four group tabs fit on one line, so hiding them
    // unasked would cost discoverability and save nothing.
    expect(MAIN).not.toMatch(/groupRow\.classList\.add\('groups__top--closed'\)/);
  });
});
