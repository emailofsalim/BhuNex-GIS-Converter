/**
 * Per-layer drawing style (phase D), and the ortho constraint (phase C).
 *
 * Only the pure parts are here: everything that decides what a layer looks like
 * is an accessor over `LayerViewState`, and the ortho constraint is a function
 * of two points. The canvas plumbing that consumes them is exercised by the
 * build, and by the fact that hardcoding `visible: true` — which is what the
 * preview canvas did before this — could not have been caught by any test that
 * only read the layer list.
 *
 * The accessors CLAMP rather than trust. A project file is a JSON document the
 * user can hand-edit, and a line width of 0 draws nothing while a width of 400
 * paints the canvas one colour. Neither reads as a settings problem when it
 * happens on someone's screen.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINE_WIDTH,
  EMPTY_VIEW,
  LINE_TYPES,
  LINE_TYPE_LABEL,
  MAX_LINE_WIDTH,
  MIN_LINE_WIDTH,
  colourOf,
  dashPattern,
  lineTypeOf,
  lineWidthOf,
  setView,
} from '@core/layers';
import { orthogonal } from '@ui/tool-canvas';

describe('line width', () => {
  it('falls back to the renderer default when unset', () => {
    expect(lineWidthOf(EMPTY_VIEW, 'parcels')).toBe(DEFAULT_LINE_WIDTH);
  });

  it('returns what was set', () => {
    const view = setView(EMPTY_VIEW, 'parcels', { lineWidth: 3 });
    expect(lineWidthOf(view, 'parcels')).toBe(3);
  });

  it('clamps a width of zero up to something drawable', () => {
    // Zero is the dangerous one: the layer simply stops appearing, and the
    // obvious conclusion is that the data is missing.
    const view = setView(EMPTY_VIEW, 'parcels', { lineWidth: 0 });
    expect(lineWidthOf(view, 'parcels')).toBe(MIN_LINE_WIDTH);
  });

  it('clamps an absurd width down', () => {
    const view = setView(EMPTY_VIEW, 'parcels', { lineWidth: 400 });
    expect(lineWidthOf(view, 'parcels')).toBe(MAX_LINE_WIDTH);
  });

  it('ignores a non-finite width rather than passing NaN to the canvas', () => {
    const view = setView(EMPTY_VIEW, 'parcels', { lineWidth: Number.NaN });
    expect(lineWidthOf(view, 'parcels')).toBe(DEFAULT_LINE_WIDTH);
  });

  it('is per layer, not global', () => {
    const view = setView(setView(EMPTY_VIEW, 'parcels', { lineWidth: 4 }), 'roads', { lineWidth: 1 });
    expect(lineWidthOf(view, 'parcels')).toBe(4);
    expect(lineWidthOf(view, 'roads')).toBe(1);
    expect(lineWidthOf(view, 'rivers')).toBe(DEFAULT_LINE_WIDTH);
  });
});

describe('line type', () => {
  it('defaults to solid', () => {
    expect(lineTypeOf(EMPTY_VIEW, 'parcels')).toBe('solid');
    expect(dashPattern('solid')).toEqual([]);
  });

  it('returns what was set', () => {
    const view = setView(EMPTY_VIEW, 'parcels', { lineType: 'dash-dot' });
    expect(lineTypeOf(view, 'parcels')).toBe('dash-dot');
  });

  it('falls back to solid for a type that is not one of the four', () => {
    const view = setView(EMPTY_VIEW, 'parcels', { lineType: 'squiggly' as never });
    expect(lineTypeOf(view, 'parcels')).toBe('solid');
  });

  it('gives every named type a pattern and a label', () => {
    for (const type of LINE_TYPES) {
      expect(LINE_TYPE_LABEL[type], `${type} has no label`).toBeTruthy();
      expect(Array.isArray(dashPattern(type)), `${type} has no pattern`).toBe(true);
    }
  });

  it('gives every non-solid type a pattern that actually breaks the line', () => {
    for (const type of LINE_TYPES.filter((candidate) => candidate !== 'solid')) {
      const pattern = dashPattern(type);
      expect(pattern.length, `${type} would draw solid`).toBeGreaterThan(0);
      // An even number of entries, or the pattern inverts on each repeat and
      // a "dotted" line comes out looking like a different pattern every dash.
      expect(pattern.length % 2, `${type} has an odd dash pattern`).toBe(0);
      expect(pattern.every((value) => value > 0), `${type} has a zero-length dash`).toBe(true);
    }
  });
});

describe('colour', () => {
  it('is null when unset, so the palette default stands', () => {
    expect(colourOf(EMPTY_VIEW, 'parcels')).toBeNull();
  });

  it('returns a valid hex colour', () => {
    const view = setView(EMPTY_VIEW, 'parcels', { colour: '#ff8800' });
    expect(colourOf(view, 'parcels')).toBe('#ff8800');
  });

  it('rejects anything the canvas would silently ignore', () => {
    // Assigning an invalid string to `strokeStyle` leaves the PREVIOUS value in
    // place, so the layer takes on the colour of whichever layer drew before
    // it — which looks like a rendering bug rather than a bad setting.
    for (const bad of ['red', '#fff', 'rgb(1,2,3)', '', 'javascript:alert(1)', '#gggggg']) {
      const view = setView(EMPTY_VIEW, 'parcels', { colour: bad });
      expect(colourOf(view, 'parcels'), `${bad} was accepted`).toBeNull();
    }
  });
});

describe('the ortho constraint', () => {
  it('keeps the axis the pointer travelled furthest along', () => {
    expect(orthogonal([0, 0], [10, 3])).toEqual([10, 0]);
    expect(orthogonal([0, 0], [3, 10])).toEqual([0, 10]);
  });

  it('works in every direction, not only positive', () => {
    expect(orthogonal([0, 0], [-10, 3])).toEqual([-10, 0]);
    expect(orthogonal([0, 0], [3, -10])).toEqual([0, -10]);
  });

  it('takes the horizontal at exactly 45 degrees rather than flickering', () => {
    // A strict comparison here would make the constraint flip between axes on
    // every pixel of a diagonal drag. The tie has to go somewhere; it goes to X.
    expect(orthogonal([0, 0], [10, 10])).toEqual([10, 0]);
    expect(orthogonal([0, 0], [-10, 10])).toEqual([-10, 0]);
  });

  it('is measured from the drag origin, not from the axes', () => {
    expect(orthogonal([100, 200], [105, 260])).toEqual([100, 260]);
    expect(orthogonal([100, 200], [160, 205])).toEqual([160, 200]);
  });

  it('leaves a zero-length drag where it is', () => {
    expect(orthogonal([5, 5], [5, 5])).toEqual([5, 5]);
  });
});
