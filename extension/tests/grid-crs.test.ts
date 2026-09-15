/**
 * The grid says which frame its numbers are in.
 *
 * THE DEFECT
 *
 * `drawGrid` printed `grid ${formatStep(step)}` under every drawing, and
 * `formatStep` was:
 *
 *     if (step >= 1000) return `${step / 1000} km`;
 *     if (step >= 1) return `${step} m`;
 *
 * — metres, unconditionally, with no reference to the coordinate system at all.
 * So a file in WGS 84 whose grid lines were 0.01° apart was captioned "grid
 * 0.01" or, at a coarser zoom, "grid 1 m" for a spacing of one DEGREE. A site
 * grid in US survey feet was labelled in metres too. That is not a missing
 * feature; it is a measurement printed as fact that the code never checked, on
 * the one surface a surveyor reads scale off.
 *
 * The caption now names the CRS and counts in ITS unit, and says so when the
 * CRS was assigned rather than declared — because a DXF labelled "UTM 44N" that
 * never said so is a claim the file does not support.
 */

import { describe, expect, it } from 'vitest';

import type { CrsRef } from '../src/core/cir';
import { crsFromEpsg, WGS84_CRS } from '../src/crs/epsg';
import { crsGridUnit, crsShortLabel } from '../src/crs/transform';

const local: CrsRef = {
  epsg: null,
  name: 'Site grid',
  kind: 'local',
  datum: 'unknown',
  projection: 'none',
  unit: 'metre',
  axisOrder: 'xy',
};

describe('the short label a grid caption can fit', () => {
  it('says the zone for UTM, which is what identifies it', () => {
    const utm = crsFromEpsg(32644);
    expect(utm?.utm).toEqual({ zone: 44, south: false });
    expect(crsShortLabel(utm)).toBe('UTM 44N');
    expect(crsShortLabel(crsFromEpsg(32744))).toBe('UTM 44S');
  });

  it('says the datum for a geographic CRS', () => {
    expect(crsShortLabel(WGS84_CRS)).toBe('WGS 84');
  });

  it('says a local grid is local, so it cannot be read as a projection', () => {
    expect(crsShortLabel(local)).toBe('Local grid');
  });

  it('says nothing it does not know', () => {
    expect(crsShortLabel(null)).toBe('No CRS');
  });

  it('stays short enough to sit under a drawing', () => {
    // The full `crsLabel` is "EPSG:32644 — WGS 84 / UTM zone 44N", which is the
    // right answer in a panel and far too long here.
    for (const code of [32644, 4326, 3857, 32601, 32760]) {
      const label = crsShortLabel(crsFromEpsg(code));
      expect(label.length, `${code} → "${label}"`).toBeLessThanOrEqual(23);
    }
  });
});

describe('the unit the axes are actually counted in', () => {
  it('counts a geographic CRS in degrees', () => {
    expect(crsGridUnit(WGS84_CRS)).toBe('degree');
  });

  it('counts a UTM grid in metres', () => {
    expect(crsGridUnit(crsFromEpsg(32644))).toBe('metre');
  });

  it('counts a foot-based grid in feet rather than silently in metres', () => {
    // THE BUG that mattered most: a plan in feet captioned in metres is a scale
    // error of 3.28, stated with total confidence.
    expect(crsGridUnit({ ...local, kind: 'projected', unit: 'US survey foot' })).toBe('foot');
    expect(crsGridUnit({ ...local, kind: 'projected', unit: 'foot' })).toBe('foot');
    expect(crsGridUnit({ ...local, kind: 'projected', unit: 'ft' })).toBe('foot');
  });

  it('refuses to name a unit for a local grid that did not state one', () => {
    // A site grid's numbers can be metres, feet, links or chains. Guessing is
    // exactly what this caption exists to stop.
    expect(crsGridUnit({ ...local, unit: '' })).toBe('unknown');
    expect(crsGridUnit(null)).toBe('unknown');
  });

  it('takes a projected CRS at its word when it states one', () => {
    expect(crsGridUnit({ ...local, kind: 'projected', unit: 'metre' })).toBe('metre');
    expect(crsGridUnit({ ...local, kind: 'projected', unit: 'degree' })).toBe('degree');
  });
});
