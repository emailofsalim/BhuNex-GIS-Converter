/**
 * Ground elevation under the cursor, from open global terrain tiles.
 *
 * WHY THIS EXISTS RATHER THAN A 3D VIEW
 *
 * The request was "if 3d terrain or other features are also possible of base
 * map then add that functions as well". The honest answer has two halves.
 *
 * A tilted, extruded terrain view — the thing people picture when they say 3D
 * — needs a WebGL renderer and a mesh built from an elevation raster. The
 * preview canvas is a 2D context that draws the survey in the DATASET'S OWN
 * CRS, and every tool on it (snap, vertex drag, measure, the tile affine) is
 * built on that. Rewriting it as a 3D globe would mean reprojecting the data
 * into the renderer's space, which is exactly the drift the tile code goes to
 * some trouble to avoid, and would cost far more than it returned.
 *
 * So ask what terrain is FOR in survey work instead of what it looks like. It
 * is two questions: what shape is this ground, and how high is this point. The
 * relief layer in `basemap.ts` answers the first. This answers the second, from
 * the same open elevation data a 3D view would have been built out of — and
 * answers it in a form a 3D view does not: a number in metres you can compare
 * against the Z on your own traverse.
 *
 * THE DATA
 *
 * Terrarium tiles from AWS's public elevation-tiles-prod bucket: SRTM, ETOPO1
 * and several national datasets merged into one global RGB-encoded PNG pyramid,
 * open data with no key and no registration. Each pixel's three channels are a
 * fixed-point elevation:
 *
 *     h = (R · 256 + G + B / 256) − 32768   metres
 *
 * The offset makes ocean floor representable without a sign bit; the B channel
 * is the fractional part, so the quantisation is 1/256 m. That precision is
 * about the encoding, NOT about the data — the underlying model is SRTM-class,
 * roughly 30 m horizontally with a vertical error of several metres. This is
 * why the readout is labelled as terrain rather than as a level, and why it
 * must never be mistaken for a levelled height. It is for orientation: is this
 * the hill or the valley, is my Z plausible, which way does this fall.
 *
 * WHY THE PIXELS CAN BE READ AT ALL
 *
 * The bucket sends `Access-Control-Allow-Origin: *`, so the image can be drawn
 * into an offscreen canvas and read back without tainting it. Everything here
 * degrades to null if that ever stops being true: no throw, no retry storm, and
 * the readout simply shows nothing.
 */

import { lonLatToTile, TILE_SIZE, type TileRef } from './basemap';

/** The one elevation source. Open data, no key, no registration. */
export const TERRAIN_SOURCE = {
  id: 'terrarium',
  name: 'AWS Terrain Tiles (Terrarium)',
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  attribution: 'Elevation: AWS Terrain Tiles — SRTM, ETOPO1 and national datasets',
  /**
   * Zoom 12 everywhere, rather than following the view.
   *
   * Each level up quadruples the tiles for detail the source does not have:
   * SRTM is ~30 m on the ground, which at z12 is already finer than one pixel.
   * Fixing it also means panning and zooming reuse the same cached tiles
   * instead of re-fetching a new pyramid level on every wheel click.
   */
  zoom: 12,
  maxZoom: 15,
} as const;

/**
 * Metres above the ellipsoid-ish datum of the source, from one Terrarium pixel.
 *
 * Exported and pure so the encoding is tested directly rather than through a
 * network fetch: the formula is the part that can be silently wrong, and a
 * wrong one produces plausible-looking numbers roughly 32 km out.
 */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Which tile holds a point, and where inside it, at the fixed sampling zoom. */
export function terrainTileFor(lon: number, lat: number): { tile: TileRef; px: number; py: number } {
  const z = TERRAIN_SOURCE.zoom;
  const fractional = lonLatToTile(lon, lat, z);
  const x = Math.floor(fractional.x);
  const y = Math.floor(fractional.y);
  return {
    tile: { x, y, z },
    // Clamped rather than trusted: a point exactly on a tile's right or bottom
    // edge floors into this tile but its fraction rounds to TILE_SIZE, which is
    // one pixel past the end of the row and reads the NEXT row's first pixel.
    px: Math.min(TILE_SIZE - 1, Math.floor((fractional.x - x) * TILE_SIZE)),
    py: Math.min(TILE_SIZE - 1, Math.floor((fractional.y - y) * TILE_SIZE)),
  };
}

/** The URL for one elevation tile. */
export function terrainTileUrl(tile: TileRef): string {
  return TERRAIN_SOURCE.url
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

type Decoded = { data: Uint8ClampedArray | null };

/**
 * Fetches elevation tiles and answers point queries from them.
 *
 * Synchronous on the way out by design. It is driven from a pointermove
 * handler, which fires far faster than any fetch completes, so `sample` returns
 * what it already has — a number, or null while a tile is in flight — and
 * `onReady` redraws once the tile lands. An async sample would queue one
 * promise per mouse pixel.
 */
export class TerrainSampler {
  private tiles = new Map<string, Decoded>();
  private pending = new Set<string>();
  private readonly onReady: () => void;
  /** Bounded: a long pan across a country would otherwise hold every tile. */
  private static readonly MAX_TILES = 48;

  constructor(onReady: () => void) {
    this.onReady = onReady;
  }

  clear(): void {
    this.tiles.clear();
    this.pending.clear();
  }

  /**
   * Metres at a point, or null when the tile is not decoded yet or failed.
   *
   * Null is not an error the caller has to handle differently from "over the
   * sea with no data": both mean there is no number to show, and inventing a
   * zero would read as sea level.
   */
  sample(lon: number, lat: number): number | null {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const { tile, px, py } = terrainTileFor(lon, lat);
    const url = terrainTileUrl(tile);

    const held = this.tiles.get(url);
    if (held) {
      if (!held.data) return null;
      const offset = (py * TILE_SIZE + px) * 4;
      return decodeTerrarium(held.data[offset], held.data[offset + 1], held.data[offset + 2]);
    }

    this.fetch(url);
    return null;
  }

  private fetch(url: string): void {
    if (this.pending.has(url)) return;
    // No Image and no document outside a browser — the conversion worker imports
    // nothing from here, but a test runner can reach this and must not throw.
    if (typeof Image === 'undefined' || typeof document === 'undefined') return;
    this.pending.add(url);

    const image = new Image();
    // The bucket sends Access-Control-Allow-Origin: *, which is the whole
    // reason the pixels can be read back. Without this the draw below taints
    // the canvas and getImageData throws a SecurityError.
    image.crossOrigin = 'anonymous';
    image.addEventListener('load', () => {
      this.pending.delete(url);
      this.store(url, { data: this.decode(image) });
      this.onReady();
    });
    // Recorded as a failure rather than dropped, so a tile over the ocean or a
    // gap in the coverage is asked for once and not on every mouse move.
    image.addEventListener('error', () => {
      this.pending.delete(url);
      this.store(url, { data: null });
    });
    image.src = url;
  }

  private decode(image: HTMLImageElement): Uint8ClampedArray | null {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(image, 0, 0, TILE_SIZE, TILE_SIZE);
      return context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    } catch {
      // A SecurityError here means the CORS header went away. The feature stops
      // working and nothing else does.
      return null;
    }
  }

  private store(url: string, decoded: Decoded): void {
    if (this.tiles.size >= TerrainSampler.MAX_TILES) {
      const oldest = this.tiles.keys().next().value;
      if (oldest !== undefined) this.tiles.delete(oldest);
    }
    this.tiles.set(url, decoded);
  }
}

/**
 * The readout text for an elevation, or a dash.
 *
 * ONE DECIMAL, not the 1/256 m the encoding could express. Writing 214.37 m
 * from a model with a vertical error of several metres would be a precision
 * claim the data cannot support, and on a survey tool that is the kind of
 * number someone writes down.
 */
export function terrainLabel(metres: number | null): string {
  if (metres === null || !Number.isFinite(metres)) return 'Terrain —';
  return `Terrain ${metres.toFixed(1)} m`;
}
