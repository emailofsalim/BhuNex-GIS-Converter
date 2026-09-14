/**
 * The georeferencing tool's wiring, and the gesture algebra under it.
 *
 * The toolbar tests already pin that every tool routes to an engine that
 * exists; these pin the parts specific to placement, where being wrong is
 * quiet: a rotation that turns the wrong way, a zone guessed for the wrong
 * hemisphere, a control file whose columns are read in the wrong order.
 */

import { describe, expect, it } from 'vitest';
import { CANVAS_TOOLS, engineOf, toolForKey } from '../src/workspace/panels/toolbar';
import { gestureAffine, gestureFor } from '../src/ui/georef-canvas';
import { parseGcpCsv, utmZoneFor } from '../src/workspace/panels/georef';
import { applyAffine } from '@core/georeference';
import type { Position } from '@core/cir';

describe('the Georef tool is on the one toolbar', () => {
  it('appears with a key that collides with nothing', () => {
    const georef = CANVAS_TOOLS.find((tool) => tool.id === 'georef');
    expect(georef).toBeDefined();
    expect(georef!.key).toBe('W');
    expect(toolForKey('w')?.id).toBe('georef');
    const keys = CANVAS_TOOLS.map((tool) => tool.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('routes to its own engine, so it cannot fight the drawing tools for the pointer', () => {
    expect(engineOf('georef')).toBe('georef');
    // Every other tool keeps the engine it had.
    expect(engineOf('draw-line')).toBe('tool');
    expect(engineOf('vertex')).toBe('edit');
    expect(engineOf('measure-area')).toBe('measure');
  });
});

describe('gestures', () => {
  it('modifiers pick the gesture, with plain drag as move', () => {
    expect(gestureFor({ shiftKey: false, altKey: false })).toBe('move');
    expect(gestureFor({ shiftKey: true, altKey: false })).toBe('rotate');
    expect(gestureFor({ shiftKey: false, altKey: true })).toBe('scale');
  });

  it('a move drag shifts by exactly the pointer delta', () => {
    const affine = gestureAffine('move', [0, 0], [412000, 2591300], [412010, 2591295]);
    const [x, y] = applyAffine(affine, 0, 0);
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(-5, 9);
  });

  it('a rotate drag turns the way the pointer went', () => {
    const pivot: Position = [0, 0];
    // From due east to due north is +90 degrees anticlockwise.
    const affine = gestureAffine('rotate', pivot, [10, 0], [0, 10]);
    const [x, y] = applyAffine(affine, 10, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(10, 6);
  });

  it('a scale drag scales by the ratio of the radii', () => {
    const affine = gestureAffine('scale', [0, 0], [10, 0], [25, 0]);
    const [x] = applyAffine(affine, 4, 0);
    expect(x).toBeCloseTo(10, 9);
  });

  it('a scale drag that starts on the pivot does nothing rather than collapsing the drawing', () => {
    // Dividing by a zero radius would produce an infinite scale and put every
    // vertex on one point — unrecoverable if it were applied to the source.
    const affine = gestureAffine('scale', [5, 5], [5, 5], [40, 40]);
    const [x, y] = applyAffine(affine, 123, 456);
    expect(x).toBe(123);
    expect(y).toBe(456);
  });
});

describe('the UTM zone suggested for a typed coordinate', () => {
  it('gets an Indian site right', () => {
    // Bhopal, 77.4E 23.26N -> zone 43N -> EPSG:32643.
    expect(utmZoneFor(77.412, 23.259).epsg).toBe(32643);
    // Kolkata, 88.4E -> zone 45N.
    expect(utmZoneFor(88.36, 22.57).epsg).toBe(32645);
  });

  it('switches hemisphere on the sign of the latitude', () => {
    expect(utmZoneFor(77.412, -23.259).epsg).toBe(32743);
  });

  it('stays inside zones 1 to 60 at the antimeridian', () => {
    expect(utmZoneFor(180, 0).epsg).toBe(32660);
    expect(utmZoneFor(-180, 0).epsg).toBe(32601);
  });
});

describe('reading a control CSV', () => {
  it('reads four columns as local easting, local northing, target easting, target northing', () => {
    const { gcps } = parseGcpCsv('0,0,412000,2591300\n45.25,0,412043.1,2591313.7');
    expect(gcps).toHaveLength(2);
    expect(gcps[0].local).toEqual([0, 0]);
    expect(gcps[0].target).toEqual([412000, 2591300]);
  });

  it('skips a header row instead of rejecting the file for having one', () => {
    const { gcps, error } = parseGcpCsv('local_x,local_y,east,north\n0,0,412000,2591300\n45.25,0,412043.1,2591313.7');
    expect(error).toBeUndefined();
    expect(gcps).toHaveLength(2);
  });

  it('accepts semicolons and tabs, which is what instruments actually emit', () => {
    expect(parseGcpCsv('0;0;412000;2591300\n45;0;412043;2591313').gcps).toHaveLength(2);
    expect(parseGcpCsv('0\t0\t412000\t2591300\n45\t0\t412043\t2591313').gcps).toHaveLength(2);
  });

  it('keeps a fifth column as the point name, so a residual can be reported against a peg', () => {
    const { gcps } = parseGcpCsv('0,0,412000,2591300,PEG-A\n45,0,412043,2591313,PEG-B');
    expect(gcps[0].name).toBe('PEG-A');
    expect(gcps[1].name).toBe('PEG-B');
  });

  it('refuses one usable row rather than fitting a placement to it', () => {
    const { gcps, error } = parseGcpCsv('0,0,412000,2591300');
    expect(gcps).toHaveLength(0);
    expect(error).toMatch(/at least two/i);
  });
});
