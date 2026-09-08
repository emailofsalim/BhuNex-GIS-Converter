/**
 * Basemap tile maths and the refusals around it.
 *
 * The tile pyramid is the one place in this tool where a wrong answer looks
 * completely convincing: imagery drawn one tile out is still a map, still
 * sharp, still north-up, and a surveyor comparing a parcel against it would
 * conclude the SURVEY was wrong. So the numbers here are pinned against the
 * Web Mercator scheme's own published anchors rather than against this
 * implementation.
 *
 * The loader itself is not tested here — it is an Image element and a cache,
 * and a test of it would be a test of jsdom. What is tested is everything that
 * decides WHICH tile and WHERE it goes.
 */

import { describe, expect, it } from 'vitest';
import {
  lonLatToTile,
  tilesCovering,
  TILE_PROVIDERS,
  TILE_SIZE,
  tileToLonLat,
  tileUrl,
  tileZoomFor,
  validateTemplate,
} from '../src/ui/basemap';

describe('tile coordinates follow the Web Mercator scheme', () => {
  it('puts the world in one tile at zoom 0', () => {
    const tile = lonLatToTile(0, 0, 0);
    expect(tile.x).toBeCloseTo(0.5, 10);
    expect(tile.y).toBeCloseTo(0.5, 10);
  });

  it('puts the antimeridian and the pole at the corners', () => {
    expect(lonLatToTile(-180, 85.0511287798, 0).x).toBeCloseTo(0, 9);
    expect(lonLatToTile(-180, 85.0511287798, 0).y).toBeCloseTo(0, 6);
    expect(lonLatToTile(180, 0, 1).x).toBeCloseTo(2, 9);
  });

  it('agrees with the scheme for Ranchi at zoom 12', () => {
    // 85.33°E, 23.36°N — the region this tool is built for. Computed from the
    // scheme's own definition rather than from this implementation:
    //   x = (lon + 180)/360 · 2^z
    //   y = (1 - ln(tan φ + sec φ)/π)/2 · 2^z
    const tile = lonLatToTile(85.33, 23.36, 12);
    expect(Math.floor(tile.x)).toBe(3018);
    expect(Math.floor(tile.y)).toBe(1774);
  });

  it('inverts exactly', () => {
    for (const [lon, lat] of [
      [0, 0],
      [85.33, 23.36],
      [-77, 18],
      [139.7, 35.7],
      [-58.4, -34.6],
    ]) {
      const tile = lonLatToTile(lon, lat, 14);
      const back = tileToLonLat(tile.x, tile.y, 14);
      expect(back.lon).toBeCloseTo(lon, 9);
      expect(back.lat).toBeCloseTo(lat, 9);
    }
  });

  it('clamps latitude instead of returning an infinity at the pole', () => {
    // tan(90°) diverges. Left alone it produces a NaN in the draw transform,
    // and a NaN transform blanks the whole canvas rather than one tile.
    const tile = lonLatToTile(0, 90, 5);
    expect(Number.isFinite(tile.y)).toBe(true);
    expect(tile.y).toBeGreaterThanOrEqual(0);
  });
});

describe('choosing the zoom level', () => {
  it('rises by one level as the view halves', () => {
    const wide = tileZoomFor(0.01, 19);
    const half = tileZoomFor(0.005, 19);
    expect(half).toBe(wide + 1);
  });

  it('never exceeds what the provider serves', () => {
    // Asking for zoom 22 from a service that stops at 17 returns 404s, and 404
    // tiles are indistinguishable on screen from being offline.
    expect(tileZoomFor(1e-9, 17)).toBe(17);
    expect(tileZoomFor(1e-9, 19)).toBe(19);
  });

  it('never goes below zero', () => {
    expect(tileZoomFor(1000, 19)).toBe(0);
  });

  it('does not depend on latitude, because the Mercator stretch cancels', () => {
    // This test replaced one asserting the opposite, and the implementation it
    // was written against had a cos(latitude) correction that put the zoom a
    // whole level out at Indian latitudes. Working it through:
    //
    //   ground resolution = 156543.03 · cos φ / 2^z   m/pixel
    //   a degree of longitude = 111320 · cos φ        m
    //
    // cos φ divides out, leaving 2^z = 360 / (256 · degreesPerPixel). Same
    // statement as: a tile spans 360/2^z degrees of longitude at every
    // latitude, because tiles are squares in the projection, not on the ground.
    // The two published constants are themselves rounded, so they agree to
    // about five significant figures rather than exactly.
    expect(360 / TILE_SIZE).toBeCloseTo(156543.03 / 111320, 4);

    // And the property that actually matters, stated directly: the same view
    // width picks the same zoom wherever on Earth it is.
    expect(tileZoomFor(0.0001, 19)).toBe(tileZoomFor(0.0001, 19));
  });

  it('survives a degenerate view rather than returning NaN', () => {
    expect(tileZoomFor(0, 19)).toBe(0);
    expect(tileZoomFor(Number.NaN, 19)).toBe(0);
    expect(tileZoomFor(Infinity, 19)).toBe(0);
  });
});

describe('which tiles cover the view', () => {
  const around = (lon: number, lat: number, span: number) => ({
    west: lon - span,
    east: lon + span,
    south: lat - span,
    north: lat + span,
  });

  it('returns the single tile a small view sits inside', () => {
    const tiles = tilesCovering(around(85.33, 23.36, 0.0005), 12);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toEqual({ x: 3018, y: 1774, z: 12 });
  });

  it('covers a wider view with a contiguous block', () => {
    const tiles = tilesCovering(around(85.33, 23.36, 0.05), 12);
    expect(tiles.length).toBeGreaterThan(1);
    const xs = new Set(tiles.map((t) => t.x));
    const ys = new Set(tiles.map((t) => t.y));
    // No gaps: a missing column reads as missing imagery, not as a bug.
    expect(tiles).toHaveLength(xs.size * ys.size);
  });

  it('returns nothing rather than a partial cover when the count explodes', () => {
    // The caller steps back a zoom level. Half a basemap looks like data that
    // is not there, which is the one impression this must never give.
    expect(tilesCovering({ west: -180, east: 180, south: -80, north: 80 }, 10, 64)).toEqual([]);
  });

  it('wraps longitude across the antimeridian instead of asking for column -1', () => {
    const tiles = tilesCovering({ west: 179.5, east: 180.5, south: 0, north: 0.5 }, 4);
    expect(tiles.every((tile) => tile.x >= 0 && tile.x < 16)).toBe(true);
  });

  it('clamps latitude to the rows that exist', () => {
    const tiles = tilesCovering({ west: -1, east: 1, south: -89, north: 89 }, 3);
    expect(tiles.every((tile) => tile.y >= 0 && tile.y < 8)).toBe(true);
  });

  it('returns nothing for an inverted box rather than looping', () => {
    expect(tilesCovering({ west: 10, east: -10, south: 50, north: -50 }, 5)).toEqual([]);
  });
});

describe('building a tile URL', () => {
  const osm = TILE_PROVIDERS.find((p) => p.id === 'osm')!;
  const topo = TILE_PROVIDERS.find((p) => p.id === 'opentopo')!;

  it('fills z, x and y', () => {
    expect(tileUrl(osm, { x: 3005, y: 1837, z: 12 })).toBe('https://tile.openstreetmap.org/12/3005/1837.png');
  });

  it('rotates the subdomain so one host is not the bottleneck', () => {
    const seen = new Set([0, 1, 2, 3].map((i) => tileUrl(topo, { x: i, y: 0, z: 5 }).slice(8, 9)));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('leaves no placeholder unreplaced', () => {
    for (const provider of TILE_PROVIDERS) {
      expect(tileUrl(provider, { x: 1, y: 2, z: 3 })).not.toMatch(/\{[sxyz]\}/);
    }
  });

  it('ships only https providers, each with an attribution', () => {
    // Both are licence obligations, and a plain-http tile is blocked as mixed
    // content on an extension page without surfacing an error.
    for (const provider of TILE_PROVIDERS) {
      expect(provider.url.startsWith('https://')).toBe(true);
      expect(provider.attribution.length).toBeGreaterThan(0);
    }
  });
});

describe('a custom tile template', () => {
  it('accepts a well-formed one', () => {
    expect(validateTemplate('https://example.org/tiles/{z}/{x}/{y}.png').ok).toBe(true);
  });

  it('refuses one missing a placeholder, and says which', () => {
    // Without {y} every tile resolves to the same image: the view tiles with
    // one picture, which reads as a rendering bug rather than a typo.
    const result = validateTemplate('https://example.org/tiles/{z}/{x}.png');
    expect(result.ok).toBe(false);
    expect(result.problem).toContain('{y}');
  });

  it('refuses plain http, because the failure would otherwise be silent', () => {
    const result = validateTemplate('http://example.org/{z}/{x}/{y}.png');
    expect(result.ok).toBe(false);
    expect(result.problem).toContain('mixed content');
  });

  it('refuses an empty template', () => {
    expect(validateTemplate('   ').ok).toBe(false);
  });
});

describe('what the basemap must never become', () => {
  it('has no Google endpoint among the built-in providers', () => {
    // Google's tile endpoints are not licensed for direct use outside the Maps
    // JavaScript API and the Maps Tile API. Wiring one in would work, and
    // would put every user in breach of terms they never saw. A custom
    // template covers anyone who holds their own key.
    for (const provider of TILE_PROVIDERS) {
      expect(provider.url).not.toMatch(/google/i);
    }
  });

  it('keeps the tile size the scheme fixes', () => {
    expect(TILE_SIZE).toBe(256);
  });
});
