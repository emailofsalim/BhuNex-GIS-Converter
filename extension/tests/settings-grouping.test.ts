/**
 * Settings that can be found.
 *
 * The owner's report was "Settings is confusing, too many options scattered
 * everywhere", and measuring it gave a number: ONE dialog, 46 controls, 14
 * headings, a single scroll. The conversion settings themselves were a flat run
 * of nine controls under one heading — nothing mislabelled, nothing missing,
 * and no way to find anything without reading all of it.
 *
 * Two things were actually wrong rather than merely long:
 *
 *   · "Output structure" (one file or a per-layer tree) sat inside the
 *     Conversion group while "Delivery structure" (whether a BATCH keeps its
 *     input folders) was a sibling heading. Two different settings whose names
 *     read as synonyms is most of what "scattered" meant — you cannot remember
 *     where something is if you cannot tell two labels apart.
 *
 *   · The dialog's own "Conversion" heading was immediately followed by the
 *     panel's "Conversion settings" heading: the same word twice, stacked.
 *
 * These tests read the source as text, in the manner of `reachability.test.ts`,
 * because the thing being protected is a relationship between strings that the
 * compiler cannot see. A DOM test is impossible here anyway — the suite runs on
 * node with no jsdom — and the rendering itself was checked in a real browser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  join(import.meta.dirname, '..', 'src', 'workspace', 'panels', 'settings.ts'),
  'utf8'
);

/** Every heading the settings surface renders, in source order. */
function headings(): string[] {
  return [...SOURCE.matchAll(/class: 'section__title', text: '([^']+)'/g)].map((m) => m[1]);
}

/** Every collapsible group the conversion settings are divided into. */
function groups(): string[] {
  return [...SOURCE.matchAll(/^\s*const \w+ = group\(\s*'([^']+)'/gm)].map((m) => m[1]);
}

describe('the conversion settings are grouped', () => {
  it('divides them into named groups rather than one flat run', () => {
    // Four is not magic; the point is that there IS a division and each part
    // has a name. A future edit that collapses them back into one list fails.
    expect(groups().length).toBeGreaterThanOrEqual(3);
  });

  it('names each group after a question, not after an engine', () => {
    // "Output", "What travels", "Checking" are what someone setting up a job
    // is actually deciding. "CIR flags" or "Pipeline options" would sort the
    // same controls by which code reads them, which is the arrangement that
    // made this hard to use.
    expect(groups()).toEqual(['Output', 'What travels', 'Checking', 'Packed alongside']);
  });

  it('gives every group a hint line under its title', () => {
    // A bare title makes the reader open a group to find out what is in it,
    // which is the cost the grouping was supposed to remove.
    for (const [, hint] of SOURCE.matchAll(/group\(\s*'[^']+',\s*'([^']+)'/g)) {
      expect(hint.length, `a group hint is too short to explain anything: "${hint}"`).toBeGreaterThan(25);
    }
  });

  it('folds them with the mechanism the rest of the workspace already uses', () => {
    // Not a second collapse implementation. `makeCollapsible` persists through
    // the same store the panes and the layer list use, so a group left shut
    // stays shut across a reload — verified in a browser.
    expect(SOURCE).toContain("import { makeCollapsible } from '../collapse'");
    expect(SOURCE).toMatch(/makeCollapsible\(head, body, `settings\./);
  });
});

describe('no two headings read as the same thing', () => {
  it('has no duplicate heading text', () => {
    const seen = headings();
    expect(seen.length, 'the headings could not be read from the source').toBeGreaterThan(4);
    expect(new Set(seen).size, `duplicate heading in: ${seen.join(', ')}`).toBe(seen.length);
  });

  it('does not call two different settings "structure"', () => {
    // The specific collision that was there: "Output structure" decides single
    // file vs per-layer tree, "Delivery structure" decided whether a batch ZIP
    // mirrors its input folders. Renamed to "Batch folders", which says what it
    // does and cannot be mistaken for the other.
    expect(SOURCE).not.toContain("text: 'Delivery structure'");
    expect(SOURCE).toContain("text: 'Batch folders'");
    const structural = headings().filter((h) => /structure/i.test(h));
    expect(structural, `more than one heading about "structure": ${structural.join(', ')}`).toHaveLength(0);
  });

  it('does not stack "Conversion" above "Conversion settings"', () => {
    // The panel renders inside the dialog's own Conversion section, so its
    // former heading repeated the parent's in different words.
    expect(SOURCE).not.toContain("text: 'Conversion settings'");
    expect(SOURCE).toContain("text: 'Conversion'");
  });
});

describe('nothing was dropped on the way', () => {
  /**
   * Every setting that was in the flat run is still reachable.
   *
   * A reorganisation that quietly loses a control is worse than the disorder it
   * replaced: the option becomes unreachable while its stored value keeps being
   * applied. Checked by the store key each control writes, which is the thing
   * that actually has to survive.
   */
  const KEYS = [
    'preserveZ',
    'preserveAttributes',
    'runQa',
    'assessHealth',
    'checkCoverageGaps',
    'embedReport',
    'includeLegend',
    'outputLayout',
    'precisionMode',
    'mirrorBatchTree',
  ];

  for (const key of KEYS) {
    it(`still writes ${key}`, () => {
      expect(SOURCE, `${key} lost its control in the regrouping`).toContain(key);
    });
  }
});
