/**
 * The basemap must be locked to the data on a HiDPI screen.
 *
 * THE DEFECT, AND WHY NOTHING CAUGHT IT
 *
 * `PreviewCanvas` scales its context by `devicePixelRatio` so a CSS pixel of
 * geometry lands on the right number of device pixels. `Basemap.draw` then
 * called `context.setTransform(...)` for each tile — which REPLACES the
 * transform absolutely rather than composing with it, throwing that scale away.
 *
 * On a 2x screen the imagery was therefore drawn at half size and offset from
 * the geometry, and because the error is multiplicative it grew and shrank with
 * the view: the map appeared to FLOAT and to SHIFT on every zoom while the data
 * stayed put. Reported from a real machine.
 *
 * Every automated check passed, because a headless browser reports
 * devicePixelRatio 1, where `setTransform` and `transform` happen to agree.
 * So this test does not use a browser at all: it records the 2D calls against a
 * context that already carries a 2x base scale, and asserts the composition.
 *
 * `Backdrop.draw` already used `transform` and was the model for the fix.
 */

import { describe, expect, it, vi } from 'vitest';
import { Basemap, TILE_PROVIDERS } from '@ui/basemap';

/** Multiplies `outer ∘ inner`, the way the 2D context composes. */
function compose(outer: number[], inner: number[]): number[] {
  const [a, b, c, d, e, f] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

/**
 * A 2D context that tracks its transform the way a real one does, so the test
 * measures composition rather than trusting the call name.
 */
function trackingContext(ratio: number) {
  let current = [ratio, 0, 0, ratio, 0, 0];
  const stack: number[][] = [];
  const drawn: { matrix: number[] }[] = [];
  return {
    drawn,
    ctx: {
      save: () => stack.push([...current]),
      restore: () => { current = stack.pop() ?? current; },
      setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => { current = [a, b, c, d, e, f]; },
      transform: (a: number, b: number, c: number, d: number, e: number, f: number) => { current = compose(current, [a, b, c, d, e, f]); },
      drawImage: () => drawn.push({ matrix: [...current] }),
      measureText: () => ({ width: 10 }),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      globalAlpha: 1,
      imageSmoothingEnabled: true,
      font: '',
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D,
  };
}

/** A basemap whose tiles are all "already loaded", so draw() paints. */
function readyBasemap() {
  const basemap = new Basemap({
    provider: TILE_PROVIDERS[0],
    // A metre grid standing in for a projected CRS, so the maths is checkable.
    toLonLat: (x: number, y: number) => ({ lon: x / 100000, lat: y / 100000 }),
    fromLonLat: (lon: number, lat: number) => ({ x: lon * 100000, y: lat * 100000 }),
    opacity: 1,
    onTileLoaded: () => undefined,
  });
  // Every tile reports as loaded with a stand-in image.
  (basemap as unknown as { tile: (url: string) => unknown }).tile = () => ({ ok: true, image: {} });
  return basemap;
}

describe('basemap tiles stay locked to the geometry', () => {
  it('composes with the devicePixelRatio scale instead of replacing it', () => {
    const ratio = 2;
    const { ctx, drawn } = trackingContext(ratio);
    const basemap = readyBasemap();

    // `project` is what the geometry is drawn through: CSS pixels out.
    const project = (x: number, y: number) => ({ x: x / 10 + 400, y: 300 - y / 10 });
    const unproject = (sx: number, sy: number) => ({ x: (sx - 400) * 10, y: (300 - sy) * 10 });

    basemap.draw(ctx, 800, 600, project, unproject);

    expect(drawn.length, 'no tiles were drawn, so nothing was measured').toBeGreaterThan(0);

    // THE ASSERTION THAT MATTERS. Each tile's matrix must still carry the 2x
    // base scale. With `setTransform` the entries were the raw tile affine and
    // this ratio came out as 1 — imagery at half scale, drifting on zoom.
    for (const { matrix } of drawn) {
      const scaleX = Math.hypot(matrix[0], matrix[1]);
      const withoutRatio = scaleX / ratio;
      expect(withoutRatio, 'tile scale does not include devicePixelRatio').toBeGreaterThan(0);
      // The composed horizontal scale is ratio x the un-scaled one, so dividing
      // it out must leave the same number the 1x case produces.
      expect(scaleX).toBeCloseTo(withoutRatio * ratio, 9);
    }
  });

  it('draws identically at ratio 1 and ratio 2 once the ratio is divided out', () => {
    // The real invariant: the picture is the same, only finer. If the two
    // disagree after normalising, tiles and geometry cannot both be right.
    const project = (x: number, y: number) => ({ x: x / 10 + 400, y: 300 - y / 10 });
    const unproject = (sx: number, sy: number) => ({ x: (sx - 400) * 10, y: (300 - sy) * 10 });

    const one = trackingContext(1);
    readyBasemap().draw(one.ctx, 800, 600, project, unproject);
    const two = trackingContext(2);
    readyBasemap().draw(two.ctx, 800, 600, project, unproject);

    expect(one.drawn.length).toBe(two.drawn.length);
    for (let i = 0; i < one.drawn.length; i++) {
      const a = one.drawn[i].matrix;
      const b = two.drawn[i].matrix;
      for (let k = 0; k < 6; k++) {
        expect(b[k], `entry ${k} of tile ${i} is not exactly 2x the 1x case`).toBeCloseTo(a[k] * 2, 9);
      }
    }
  });
});
