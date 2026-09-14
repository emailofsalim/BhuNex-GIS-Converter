/**
 * What needs installing, and what installing it actually achieves.
 *
 * The defect these pin: DGN and File Geodatabase were flagged `requiresNative`
 * and their refusal said "it requires the local native helper, which is either
 * not installed or not reachable". The helper hardcodes `.dwg` and drives ODA
 * File Converter, which handles DWG and DXF and nothing else. A surveyor could
 * install Python, install ODA, register the helper, and find DGN exactly as
 * unsupported as before — having been told three times that this was the fix.
 *
 * So the rule these hold is narrow and testable: a format may only claim the
 * bundled helper if the bundled helper can actually convert it.
 */

import { describe, expect, it } from 'vitest';
import { ALL_REQUIREMENTS, DWG_HELPER, EXTERNAL_TOOLS, hasBundledHelper, requirementFor } from '@core/helpers';
import { FORMATS, getFormat, isAvailable } from '@core/registry';

describe('the helper catalogue', () => {
  it('claims a bundled helper for DWG and nothing else', () => {
    // The helper is a DWG converter. Any other format claiming it is a promise
    // the helper cannot keep.
    const bundled = ALL_REQUIREMENTS.filter((entry) => entry.kind === 'bundled-helper');
    expect(bundled).toHaveLength(1);
    expect(bundled[0].formats).toEqual(['dwg']);
  });

  it('does not tell a DGN or File Geodatabase user to install the helper', () => {
    for (const id of ['dgn', 'filegdb']) {
      expect(hasBundledHelper(id)).toBe(false);
      const requirement = requirementFor(id)!;
      expect(requirement.kind).toBe('external-tool');
      const text = `${requirement.summary} ${requirement.steps.join(' ')}`;
      expect(text).not.toMatch(/native helper|install the helper/i);
    }
  });

  it('names a real tool for every format it cannot convert', () => {
    for (const requirement of EXTERNAL_TOOLS) {
      expect(requirement.source, requirement.formats.join()).toBeTruthy();
      expect(requirement.steps.length, requirement.formats.join()).toBeGreaterThan(0);
    }
  });

  it('covers every format the registry marks as needing something', () => {
    // A format flagged in the registry but missing from the catalogue would get
    // the generic fallback message, which is how the vague advice crept in.
    const flagged = FORMATS.filter(
      (format) => format.requiresNative === true || (format as { requiresExternalTool?: boolean }).requiresExternalTool === true
    );
    expect(flagged.length).toBeGreaterThan(0);
    for (const format of flagged) {
      expect(requirementFor(format.id), `${format.id} has no catalogue entry`).not.toBeNull();
    }
  });

  it('every catalogue entry names a format the registry actually has', () => {
    for (const requirement of ALL_REQUIREMENTS) {
      for (const id of requirement.formats) {
        expect(getFormat(id), `${id} is not a registered format`).toBeDefined();
      }
    }
  });

  it('the DWG helper states its prerequisite, since it drives a program it does not ship', () => {
    expect(DWG_HELPER.prerequisite).toMatch(/ODA File Converter/i);
    expect(DWG_HELPER.prerequisite).toMatch(/Python/i);
    expect(DWG_HELPER.source).toBeTruthy();
    expect(DWG_HELPER.steps.length).toBeGreaterThanOrEqual(3);
  });
});

describe('availability follows what can actually run', () => {
  it('DWG becomes available once the helper answers', () => {
    const dwg = getFormat('dwg')!;
    expect(isAvailable(dwg, 'import', false)).toBe(false);
    expect(isAvailable(dwg, 'import', true)).toBe(true);
  });

  it('DGN and File Geodatabase stay unavailable however ready the helper is', () => {
    // This is the behaviour change. Before, a ready helper made the UI offer
    // these — and the conversion then threw.
    for (const id of ['dgn', 'filegdb']) {
      const format = getFormat(id)!;
      expect(isAvailable(format, 'import', false), id).toBe(false);
      expect(isAvailable(format, 'import', true), id).toBe(false);
      expect(isAvailable(format, 'export', true), id).toBe(false);
    }
  });
});
