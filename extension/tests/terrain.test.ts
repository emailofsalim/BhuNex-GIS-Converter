/**
 * The elevation encoding, the relief layers, and the source list.
 *
 * WHAT IS WORTH TESTING HERE AND WHAT IS NOT. Fetching a tile and drawing it is
 * browser work with no assertion a Node runner can make. The encoding is not:
 * it is one line of arithmetic that produces plausible-looking numbers when it
 * is wrong. A dropped offset reads every height as 32 km up; a B channel
 * divided by the wrong power reads a hill as a mountain. Neither throws, and
 * neither is visible without a reference height to compare against — which is
 * exactly the kind of defect a survey tool must not ship.
 *
 * The provider and attribution lists are tested for a different reason. Credit
 * is a LICENCE CONDITION of every open tile service here, so a source that
 * reaches the network without appearing in the panel is a licence problem
 * rather than a cosmetic one — and the way that happens is somebody adding a
 * provider and not thinking about the panel. These assertions are derived from
 * the provider lists, so a new entry is covered the moment it exists.
 */

import { describe, expect, it } from 'vitest';
import {
  Basemap,
  CREDIT_BAND_BOTTOM,
  CREDIT_BAND_HEIGHT,
  RELIEF_PROVIDERS,
  TILE_PRESETS,
  TILE_PROVIDERS,
  composeCredit,
} from '@ui/basemap';
import { TERRAIN_SOURCE, decodeTerrarium, terrainLabel, terrainTileFor, terrainTileUrl } from '@ui/terrain';
import { allSources } from '../src/workspace/panels/map-control';

describe('the Terrarium elevation encoding', () => {
  it('reads the zero point as sea level', () => {
    // R = 128 is exactly the 32768 offset, so this is the calibration case: if
    // the offset is wrong at all, this is not zero.
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
  });

  it('reads the bottom of the range as the deepest ocean floor', () => {
    expect(decodeTerrarium(0, 0, 0)).toBe(-32768);
  });

  it('reads a hill at the height it encodes', () => {
    // 129·256 + 200 = 33224, less the offset = 456 m. A plausible Indian
    // plateau height, and wrong by 32 km if the offset is dropped.
    expect(decodeTerrarium(129, 200, 0)).toBe(456);
  });

  it('puts the fraction in the blue channel, at 1/256 m', () => {
    expect(decodeTerrarium(128, 0, 128)).toBeCloseTo(0.5, 10);
    expect(decodeTerrarium(128, 0, 1)).toBeCloseTo(1 / 256, 10);
  });

  it('is monotonic in every channel', () => {
    // The cheapest guard against a transposed channel: swapping R and B still
    // decodes, still returns a number, and is out by kilometres.
    expect(decodeTerrarium(129, 0, 0)).toBeGreaterThan(decodeTerrarium(128, 255, 255));
    expect(decodeTerrarium(128, 1, 0)).toBeGreaterThan(decodeTerrarium(128, 0, 255));
  });
});

describe('finding the pixel that holds a point', () => {
  it('samples at one fixed zoom rather than following the view', () => {
    // Deliberate: the source is ~30 m on the ground, so a deeper pyramid level
    // is four times the tiles for detail the data does not contain — and a zoom
    // that follows the view re-fetches everything on each wheel click.
    const a = terrainTileFor(80.139, 23.429);
    const b = terrainTileFor(80.2, 23.5);
    expect(a.tile.z).toBe(TERRAIN_SOURCE.zoom);
    expect(b.tile.z).toBe(TERRAIN_SOURCE.zoom);
  });

  it('stays inside the tile at its right and bottom edges', () => {
    // A point exactly on a boundary floors into THIS tile but its fraction
    // rounds to 256 — one past the end of the row, which reads the next row's
    // first pixel. Off by one row is off by ~150 m on the ground here.
    const size = 256;
    for (let index = 0; index < 400; index++) {
      const lon = -180 + (index * 360) / 400;
      const { px, py } = terrainTileFor(lon, 45);
      expect(px).toBeGreaterThanOrEqual(0);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThan(size);
      expect(py).toBeLessThan(size);
    }
  });

  it('moves east into a higher tile x and north into a lower tile y', () => {
    const west = terrainTileFor(70, 23);
    const east = terrainTileFor(85, 23);
    expect(east.tile.x).toBeGreaterThan(west.tile.x);

    const south = terrainTileFor(80, 10);
    const north = terrainTileFor(80, 30);
    expect(north.tile.y).toBeLessThan(south.tile.y);
  });

  it('builds a URL with every placeholder filled', () => {
    const url = terrainTileUrl({ x: 731, y: 400, z: 12 });
    expect(url).not.toContain('{');
    expect(url).toContain('/12/731/400.png');
    expect(url.startsWith('https://')).toBe(true);
  });
});

describe('the elevation readout text', () => {
  it('says nothing rather than zero when there is no number', () => {
    // Zero would read as sea level, which over a gap in coverage is a claim
    // about the ground rather than an absence of one.
    expect(terrainLabel(null)).toBe('Terrain —');
    expect(terrainLabel(Number.NaN)).toBe('Terrain —');
  });

  it('shows one decimal, not the precision the encoding could express', () => {
    // 1/256 m is a property of the ENCODING. The model behind it has a vertical
    // error of several metres, and on a survey tool a number like 214.37 is one
    // somebody writes down.
    expect(terrainLabel(214.3671875)).toBe('Terrain 214.4 m');
    expect(terrainLabel(-3.21)).toBe('Terrain -3.2 m');
  });
});

describe('the relief layers', () => {
  it('offers at least one, and every one is usable as a tile template', () => {
    expect(RELIEF_PROVIDERS.length).toBeGreaterThan(0);
    for (const provider of RELIEF_PROVIDERS) {
      expect(provider.url.startsWith('https://')).toBe(true);
      expect(provider.url).toContain('{z}');
      expect(provider.url).toContain('{x}');
      expect(provider.url).toContain('{y}');
      // No key, no token, no placeholder a user would have to fill in: these
      // are offered as working out of the box and must actually be.
      expect(provider.url).not.toContain('{key}');
      expect(provider.maxZoom).toBeGreaterThan(0);
    }
  });

  it('credits every relief layer', () => {
    for (const provider of RELIEF_PROVIDERS) {
      expect(provider.attribution.trim().length).toBeGreaterThan(0);
    }
  });

  it('is disjoint from the basemap list', () => {
    // They are separate lists on purpose — a hillshade alone shows the shape of
    // the ground and nothing about where you are. An id in both would let the
    // same layer be picked as base and relief, which draws it over itself.
    const base = new Set(TILE_PROVIDERS.map((entry) => entry.id));
    for (const provider of RELIEF_PROVIDERS) {
      expect(base.has(provider.id)).toBe(false);
    }
  });
});

describe('the composed credit', () => {
  it('names both layers when two are drawing', () => {
    const credit = composeCredit(TILE_PROVIDERS[0], RELIEF_PROVIDERS[0]);
    expect(credit).toContain(TILE_PROVIDERS[0].attribution);
    expect(credit).toContain(RELIEF_PROVIDERS[0].attribution);
  });

  it('is just the provider when only one is', () => {
    expect(composeCredit(TILE_PROVIDERS[0], null)).toBe(TILE_PROVIDERS[0].attribution);
  });

  it('does not credit the same body twice', () => {
    // A hillshade over a Carto style would otherwise say "© OpenStreetMap
    // contributors" twice, which reads as a bug and crowds the corner.
    const twice = composeCredit(TILE_PROVIDERS[0], TILE_PROVIDERS[0]);
    expect(twice).toBe(TILE_PROVIDERS[0].attribution);
  });

  it('ignores nothing at all', () => {
    expect(composeCredit(null, undefined)).toBe('');
  });
});

describe('the sources panel', () => {
  const sources = allSources();

  it('lists every basemap, every relief layer, the elevation source and every preset', () => {
    // Derived from the lists rather than hardcoded, so a provider added to
    // basemap.ts is covered without anyone remembering this file exists. A
    // source reaching the network but missing from the panel is a licence
    // problem, not a cosmetic one.
    const names = sources.map((entry) => entry.name);
    for (const provider of [...TILE_PROVIDERS, ...RELIEF_PROVIDERS]) {
      expect(names).toContain(provider.name);
    }
    for (const preset of TILE_PRESETS) {
      expect(names).toContain(preset.name);
    }
    expect(names).toContain(TERRAIN_SOURCE.name);
    expect(sources.length).toBe(TILE_PROVIDERS.length + RELIEF_PROVIDERS.length + TILE_PRESETS.length + 1);
  });

  it('states terms for every single one', () => {
    for (const source of sources) {
      expect(`${source.name}: ${source.terms.trim().length > 0}`).toBe(`${source.name}: true`);
    }
  });

  it('marks exactly the key-bearing services as needing an account', () => {
    // The distinction the user is actually choosing on. Getting it backwards
    // sends someone to sign up for a service that needs nothing, or lets them
    // pick one that silently fails with no key.
    const account = sources.filter((entry) => entry.key === 'account').map((entry) => entry.name).sort();
    expect(account).toEqual(TILE_PRESETS.map((preset) => preset.name).sort());
  });

  it('needs no account for the elevation source', () => {
    // The readout is offered as working out of the box. If this ever changes,
    // the feature has to become opt-in with a key box, not silently stop.
    expect(sources.find((entry) => entry.name === TERRAIN_SOURCE.name)?.key).toBe('none');
    expect(TERRAIN_SOURCE.url).not.toContain('{key}');
  });
});

/**
 * THE CORNER THREE THINGS SHARE.
 *
 * Found by looking at a screenshot of the running workspace, not at the code.
 * `PreviewCanvas` draws the CRS-and-grid caption right-aligned in the bottom 20
 * pixels; `Basemap` drew its credit right-aligned in the bottom 15. The caption
 * is painted after the underlay, so the credit came out sliced through the
 * middle — present enough to look deliberate, and once two layers could be on
 * at once, short enough to lose the second provider's name entirely.
 *
 * A truncated attribution is a licence problem rather than a cosmetic one, so
 * this pins the band. It is tested through `draw` with a recording context,
 * because `drawAttribution` is private and testing it directly would be testing
 * a shape the caller could stop reaching.
 */
describe('where the credit is drawn', () => {
  /** Records the boxes and the strings, and reports where each landed. */
  function recordingContext() {
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const texts: { text: string; x: number; y: number }[] = [];
    return {
      rects,
      texts,
      ctx: {
        save: () => undefined,
        restore: () => undefined,
        transform: () => undefined,
        setTransform: () => undefined,
        drawImage: () => undefined,
        measureText: (text: string) => ({ width: text.length * 5 }),
        fillRect: (x: number, y: number, w: number, h: number) => rects.push({ x, y, w, h }),
        fillText: (text: string, x: number, y: number) => texts.push({ text, x, y }),
        globalAlpha: 1,
        imageSmoothingEnabled: true,
        font: '',
        fillStyle: '',
      } as unknown as CanvasRenderingContext2D,
    };
  }

  function drawWith(credit: string | undefined) {
    const map = new Basemap({
      provider: TILE_PROVIDERS[0],
      toLonLat: (x: number, y: number) => ({ lon: x / 100000, lat: y / 100000 }),
      fromLonLat: (lon: number, lat: number) => ({ x: lon * 100000, y: lat * 100000 }),
      opacity: 1,
      credit,
      onTileLoaded: () => undefined,
    });
    (map as unknown as { tile: () => unknown }).tile = () => ({ ok: true, image: {} });
    const recorder = recordingContext();
    map.draw(
      recorder.ctx,
      800,
      600,
      (x: number, y: number) => ({ x: x / 10 + 400, y: 300 - y / 10 }),
      (sx: number, sy: number) => ({ x: (sx - 400) * 10, y: (300 - sy) * 10 })
    );
    return recorder;
  }

  it('clears the bottom band, which belongs to the CRS caption', () => {
    const { rects } = drawWith(undefined);
    const plate = rects.at(-1);
    expect(plate).toBeDefined();
    // `PreviewCanvas` owns height-20 .. height-4. Nothing here may touch it.
    expect(plate!.y + plate!.h).toBeLessThanOrEqual(600 - 20);
  });

  it('puts the plate exactly where the constants say', () => {
    const { rects } = drawWith(undefined);
    const plate = rects.at(-1)!;
    expect(plate.y + plate.h).toBe(600 - CREDIT_BAND_BOTTOM);
    expect(plate.h).toBe(CREDIT_BAND_HEIGHT);
  });

  it('keeps a long two-layer credit on the canvas rather than off its left edge', () => {
    // Composed credits are roughly twice as long. Allowed to go negative, the
    // box would start off-canvas and lose the FIRST provider — the one actually
    // drawing the tiles.
    const long = composeCredit(TILE_PROVIDERS[1], RELIEF_PROVIDERS[0]);
    const { rects, texts } = drawWith(long);
    expect(rects.at(-1)!.x).toBeGreaterThanOrEqual(0);
    expect(texts.at(-1)!.text).toBe(long);
  });

  it('draws nothing at all for an empty credit', () => {
    // How the relief layer stays silent: its credit is already in the composed
    // line the layer underneath draws.
    const { texts } = drawWith('');
    expect(texts.length).toBe(0);
  });
});
