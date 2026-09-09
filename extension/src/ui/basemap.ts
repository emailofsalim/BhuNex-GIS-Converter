/**
 * Map tiles behind the canvas (spec §30.1, owner request).
 *
 * WHY THIS IS OFF BY DEFAULT, AND STAYS OFF UNLESS ASKED
 *
 * Rule R15 says the packaged extension must work with the network interface
 * disabled, and rule R8 says no network request carries user file bytes. A
 * basemap is the only feature in this tool that touches the network at all, so
 * it is built to keep both promises literally:
 *
 *  - It is disabled until the user turns it on, so a fresh install and every
 *    conversion path make no request whatsoever.
 *  - It degrades to nothing. A tile that fails to load leaves the canvas
 *    exactly as it would have been, and no conversion, measurement, edit or
 *    export depends on a tile having arrived.
 *  - It sends tile COORDINATES and nothing else. No file bytes, no attribute
 *    values, no file names. What a tile server can infer is the area being
 *    looked at, which is disclosed in the settings panel in those words,
 *    because for a survey under NDA that is a real disclosure and the user is
 *    the only one who can weigh it.
 *
 * WHY GOOGLE IS NOT A BUILT-IN PROVIDER
 *
 * Google's tile endpoints are not licensed for direct use outside the Maps
 * JavaScript API and the Maps Tile API. Wiring `mt0.google.com/vt` in — which
 * is what most examples do — would work and would put the user in breach of
 * terms they never saw. So the built-in providers are open ones, and a custom
 * URL template is offered instead: anyone holding a Google Maps Tile API key,
 * an organisational WMTS, or a departmental imagery service can paste their own
 * endpoint and use it under whatever terms they actually hold.
 *
 * THE PROJECTION PROBLEM
 *
 * Tiles are a Web Mercator pyramid. The canvas is in the dataset's own CRS,
 * which for survey work is usually a UTM zone. So each tile's geographic
 * corners are transformed into the view's world coordinates and the image is
 * drawn through the affine that maps its three corners — not stretched into an
 * axis-aligned box, which would slide the imagery against the data by a
 * visible amount at the edges of a zone. Over one tile an affine is an
 * excellent approximation to the true projective warp; over the whole view it
 * would not be, which is exactly why this is done per tile.
 */

/** A tile source: where the images come from and who must be credited. */
export interface TileProvider {
  id: string;
  name: string;
  /** `{z}`, `{x}`, `{y}` and optionally `{s}` for a subdomain. */
  url: string;
  subdomains?: string[];
  /** Rendered onto the canvas. Every open tile service requires this. */
  attribution: string;
  maxZoom: number;
  /** One line on what this layer is FOR, shown beside it in the switcher. */
  note?: string;
}

/**
 * The built-in providers, all keyless and openly licensed.
 *
 * OpenStreetMap's tile usage policy asks for a valid identifying user agent, no
 * bulk download and no heavy automated use. A person panning a survey around is
 * squarely inside that; a batch job would not be, which is one more reason the
 * basemap is a view-time feature and touches no conversion path. The same
 * reasoning covers every entry here: each has a free tier intended for exactly
 * this kind of interactive use, and none is being scraped.
 *
 * They are ordered by what a surveyor reaches for: the street map to find the
 * site, the imagery to see what is on it, the topographic layer for relief, and
 * the two plain styles for when the basemap must not compete with the data.
 */
export const TILE_PROVIDERS: TileProvider[] = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
    note: 'Streets, buildings and place names. The best layer for finding a site.',
  },
  {
    id: 'esri-imagery',
    name: 'Esri World Imagery (satellite)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    // Note the {y}/{x} order: this service is not the usual {x}/{y}, and
    // getting it the wrong way round produces tiles that load and are in the
    // wrong place — which reads as a projection bug rather than a URL one.
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community',
    maxZoom: 19,
    note: 'Aerial and satellite imagery — the closest keyless equivalent to Google Earth.',
  },
  {
    id: 'opentopo',
    name: 'OpenTopoMap (contours, relief)',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    attribution: '© OpenStreetMap contributors, SRTM · style © OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
    note: 'Contours and hill shading, for a site whose relief matters.',
  },
  {
    id: 'carto-positron',
    name: 'Carto Positron (pale)',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 20,
    note: 'Almost colourless, so survey linework stays the loudest thing on screen.',
  },
  {
    id: 'carto-dark',
    name: 'Carto Dark Matter',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 20,
    note: 'The pale layer inverted, for working in the dark theme.',
  },
];

/**
 * Services that need an account, offered as templates rather than as providers.
 *
 * The owner named Stadia and Jawg. Both are genuinely free for this kind of
 * use, and both require a key — which means shipping them as built-ins would
 * mean shipping SOMEBODY's key in a public MIT-licensed repository, and every
 * install would be spending that person's quota. So they are presets: choosing
 * one fills in the URL shape and leaves `{key}` for the user's own.
 *
 * GOOGLE IS THE SAME MECHANISM, and this is the fourth time it has been asked
 * for, so the reasoning lives here rather than being re-derived. Google's tile
 * endpoints are not licensed for direct use outside the Maps JavaScript API and
 * the Maps Tile API. Wiring `mt0.google.com/vt` in would work, and would put
 * every person who installs this extension in breach of terms they never saw,
 * with the owner's name on the repository that did it. A user who holds a Maps
 * Tile API key can paste their session endpoint into the custom field and use
 * it under the terms they actually hold — the request, satisfied, without the
 * liability. Esri World Imagery above is the keyless answer for people who
 * wanted Google mainly for the satellite view.
 */
export interface TilePreset {
  id: string;
  name: string;
  /** A template with `{key}` where the user's own key goes. */
  template: string;
  /** Where to get a key. Shown as text, never fetched. */
  signup: string;
  attribution: string;
  maxZoom: number;
  note: string;
}

export const TILE_PRESETS: TilePreset[] = [
  {
    id: 'stadia-outdoors',
    name: 'Stadia Maps — Outdoors',
    template: 'https://tiles.stadiamaps.com/tiles/outdoors/{z}/{x}/{y}.png?api_key={key}',
    signup: 'stadiamaps.com — free developer tier, registration required',
    attribution: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
    maxZoom: 20,
    note: 'Terrain-oriented styling with paths and land cover.',
  },
  {
    id: 'stadia-satellite',
    name: 'Stadia Maps — Satellite',
    template: 'https://tiles.stadiamaps.com/tiles/alidade_satellite/{z}/{x}/{y}.jpg?api_key={key}',
    signup: 'stadiamaps.com — free developer tier, registration required',
    attribution: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
    maxZoom: 20,
    note: 'Imagery, for when the keyless satellite layer is out of date at your site.',
  },
  {
    id: 'jawg-streets',
    name: 'Jawg Maps — Streets',
    template: 'https://tile.jawg.io/jawg-streets/{z}/{x}/{y}.png?access-token={key}',
    signup: 'jawg.io — free tier, registration required',
    attribution: '© JawgMaps © OpenStreetMap contributors',
    maxZoom: 22,
    note: 'A street map that keeps labels legible at high zoom.',
  },
  {
    id: 'google-tile-api',
    name: 'Google Maps Tile API (your own key)',
    // Deliberately the SESSION endpoint, which is the licensed route. It needs
    // a session token obtained from Google, which is why this is a template a
    // key-holder completes rather than something that could work out of the box.
    template: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=SESSION_TOKEN&key={key}',
    signup: 'Google Cloud console — Maps Tile API, billing account required',
    attribution: 'Map data © Google',
    maxZoom: 22,
    note: 'Only usable with your own Maps Tile API key and session token. Google’s tiles are not licensed for direct use without one.',
  },
];

/** Fills a preset in with a key, ready to be used as a custom template. */
export function applyPreset(preset: TilePreset, key: string): string {
  return preset.template.replace('{key}', key.trim());
}

export const TILE_SIZE = 256;

// ------------------------------------------------------------------ tile math

/**
 * Longitude/latitude to fractional tile coordinates at zoom `z`.
 *
 * The Web Mercator y term diverges at the poles, so latitude is clamped to the
 * scheme's own limit rather than allowed to produce an infinity that would
 * propagate into the draw transform as a NaN and blank the canvas.
 */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const clamped = Math.max(-85.0511287798, Math.min(85.0511287798, lat));
  const radians = (clamped * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * n,
  };
}

/** Fractional tile coordinates back to longitude/latitude. */
export function tileToLonLat(x: number, y: number, z: number): { lon: number; lat: number } {
  const n = 2 ** z;
  return {
    lon: (x / n) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
  };
}

/**
 * The zoom whose tile pixels are closest to screen pixels.
 *
 * One level too coarse is a blurred basemap; one too fine is four times the
 * requests for detail nobody can see.
 *
 * LATITUDE DOES NOT APPEAR HERE, and that is the part worth writing down,
 * because it looks like an omission. Mercator stretches with latitude, so the
 * instinct is to correct for it — this function did, and was wrong by a whole
 * zoom level at Indian latitudes. The correction cancels:
 *
 *     Web Mercator ground resolution = 156543.03 · cos φ / 2^z   m/pixel
 *     one degree of longitude        = 111320 · cos φ            m
 *
 * Matching them, cos φ divides out on both sides and leaves
 * 2^z = 156543.03 / (111320 · degreesPerPixel) = 360 / (256 · degreesPerPixel),
 * with no latitude term at all. Which is the same statement as: a tile spans
 * 360/2^z degrees of longitude at EVERY latitude, because tiles are squares in
 * the projection, not on the ground.
 */
export function tileZoomFor(degreesPerPixel: number, maxZoom: number): number {
  if (!(degreesPerPixel > 0) || !Number.isFinite(degreesPerPixel)) return 0;
  const ideal = Math.log2(360 / (TILE_SIZE * degreesPerPixel));
  return Math.max(0, Math.min(maxZoom, Math.round(ideal)));
}

export interface TileRef {
  x: number;
  y: number;
  z: number;
}

/**
 * Which tiles cover a geographic box at zoom `z`.
 *
 * Returns nothing rather than a partial cover when the box needs more than
 * `maxTiles`: a half-drawn basemap looks like missing data, and the caller
 * steps back a zoom level instead. Longitude wraps (a view crossing the
 * antimeridian is legitimate); latitude is clamped, since there is no tile
 * above the top row to wrap to.
 */
export function tilesCovering(
  box: { west: number; south: number; east: number; north: number },
  z: number,
  maxTiles = 64
): TileRef[] {
  const n = 2 ** z;
  const topLeft = lonLatToTile(box.west, box.north, z);
  const bottomRight = lonLatToTile(box.east, box.south, z);

  const minX = Math.floor(topLeft.x);
  const maxX = Math.floor(bottomRight.x);
  const minY = Math.max(0, Math.floor(topLeft.y));
  const maxY = Math.min(n - 1, Math.floor(bottomRight.y));
  if (maxY < minY || maxX < minX) return [];

  const columns = maxX - minX + 1;
  const rows = maxY - minY + 1;
  if (columns * rows > maxTiles) return [];

  const out: TileRef[] = [];
  for (let x = minX; x <= maxX; x++) {
    // Wrapping keeps a view across the antimeridian drawing real tiles rather
    // than asking for a negative column that every server 404s.
    const wrapped = ((x % n) + n) % n;
    for (let y = minY; y <= maxY; y++) out.push({ x: wrapped, y, z });
  }
  return out;
}

/** Fills a provider's template. `{s}` rotates so a browser's per-host connection limit is not the bottleneck. */
export function tileUrl(provider: TileProvider, tile: TileRef): string {
  const subdomains = provider.subdomains;
  const subdomain = subdomains?.length ? subdomains[(tile.x + tile.y) % subdomains.length] : '';
  return provider.url
    .replace('{s}', subdomain)
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

/**
 * Whether a custom template can be used at all.
 *
 * `{z}`, `{x}` and `{y}` are all required — a template missing one produces the
 * same image for every tile, which tiles the view with one picture and looks
 * like a rendering bug rather than a typo. https is required because an
 * extension page is a secure context and a plain-http tile is blocked as mixed
 * content, silently.
 */
export function validateTemplate(url: string): { ok: boolean; problem?: string } {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, problem: 'Enter a tile URL template.' };
  if (!/^https:\/\//i.test(trimmed)) {
    return { ok: false, problem: 'The template must start with https:// — an extension page blocks plain http as mixed content, without an error.' };
  }
  for (const token of ['{z}', '{x}', '{y}']) {
    if (!trimmed.includes(token)) {
      return { ok: false, problem: `The template needs ${token}. Without it every tile resolves to the same image.` };
    }
  }
  return { ok: true };
}

// --------------------------------------------------------------------- loader

type TileState = { image: HTMLImageElement; ok: boolean };

export interface BasemapOptions {
  provider: TileProvider;
  /** View world coordinates to WGS 84. Null when the CRS cannot be transformed. */
  toLonLat: ((x: number, y: number) => { lon: number; lat: number }) | null;
  fromLonLat: ((lon: number, lat: number) => { x: number; y: number }) | null;
  /** Called when a tile arrives, so the canvas can redraw with it. */
  onTileLoaded: () => void;
  opacity?: number;
}

/**
 * Fetches and draws the tiles under one canvas.
 *
 * Holds no geometry and no CRS knowledge: the two closures it is given are the
 * whole of its relationship with the coordinate system, which keeps the tile
 * code testable without a dataset and keeps `preview.ts` unaware of tiles.
 */
export class Basemap {
  private cache = new Map<string, TileState>();
  private options: BasemapOptions;
  /** Bounded so a long panning session cannot grow the cache without limit. */
  private static readonly MAX_CACHED = 256;

  constructor(options: BasemapOptions) {
    this.options = options;
  }

  update(options: Partial<BasemapOptions>): void {
    const providerChanged = options.provider && options.provider.id !== this.options.provider.id;
    this.options = { ...this.options, ...options };
    // Tiles from the old provider are a different map; keeping them would blend
    // two basemaps together as the new ones arrive.
    if (providerChanged) this.cache.clear();
  }

  /** True when this basemap can draw at all — it cannot without a CRS it can place. */
  get usable(): boolean {
    return this.options.toLonLat !== null && this.options.fromLonLat !== null;
  }

  private tile(url: string): TileState {
    const existing = this.cache.get(url);
    if (existing) return existing;

    const image = new Image();
    // Tile servers send Access-Control-Allow-Origin, so this keeps the canvas
    // untainted and a later readback (a report thumbnail) still possible.
    image.crossOrigin = 'anonymous';
    const state: TileState = { image, ok: false };
    image.addEventListener('load', () => {
      state.ok = true;
      this.options.onTileLoaded();
    });
    // A failure is final and silent: no retry storm, no error surfaced on the
    // canvas. Offline, this is the whole degradation path.
    image.addEventListener('error', () => {
      state.ok = false;
    });
    image.src = url;

    if (this.cache.size >= Basemap.MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(url, state);
    return state;
  }

  /**
   * Draws the basemap under everything else.
   *
   * `project` maps view world coordinates to screen pixels — the same function
   * the geometry is drawn through, so the imagery cannot drift from the data
   * by a transform they do not share.
   */
  draw(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    project: (x: number, y: number) => { x: number; y: number },
    unproject: (screenX: number, screenY: number) => { x: number; y: number }
  ): void {
    const { toLonLat, fromLonLat, provider } = this.options;
    if (!toLonLat || !fromLonLat || width < 2 || height < 2) return;

    // The geographic box the canvas is showing. All four corners, because a
    // reprojected view is not axis-aligned in longitude and latitude, so the
    // extremes are not necessarily at two opposite corners.
    const corners = [
      unproject(0, 0),
      unproject(width, 0),
      unproject(0, height),
      unproject(width, height),
    ].map((point) => toLonLat(point.x, point.y));

    if (corners.some((point) => !Number.isFinite(point.lon) || !Number.isFinite(point.lat))) return;

    const box = {
      west: Math.min(...corners.map((c) => c.lon)),
      east: Math.max(...corners.map((c) => c.lon)),
      south: Math.min(...corners.map((c) => c.lat)),
      north: Math.max(...corners.map((c) => c.lat)),
    };

    const degreesPerPixel = (box.east - box.west) / width;

    // Step back a level rather than draw half a basemap: at a very wide view
    // the tile count explodes, and a partial cover reads as missing data.
    let tiles: TileRef[] = [];
    let zoom = tileZoomFor(degreesPerPixel, provider.maxZoom);
    for (; zoom >= 0; zoom--) {
      tiles = tilesCovering(box, zoom, 64);
      if (tiles.length > 0) break;
    }
    if (tiles.length === 0) return;

    context.save();
    context.globalAlpha = this.options.opacity ?? 1;
    // Tiles butt against each other exactly; smoothing across the seam is what
    // produces the faint grid people mistake for a data artefact.
    context.imageSmoothingEnabled = true;

    for (const tile of tiles) {
      const state = this.tile(tileUrl(provider, tile));
      if (!state.ok) continue;

      // Three corners are enough to define the affine, and the fourth would
      // over-determine it — a projective warp is not what canvas offers.
      const topLeft = tileToLonLat(tile.x, tile.y, tile.z);
      const topRight = tileToLonLat(tile.x + 1, tile.y, tile.z);
      const bottomLeft = tileToLonLat(tile.x, tile.y + 1, tile.z);

      const a = this.screenOf(topLeft, fromLonLat, project);
      const b = this.screenOf(topRight, fromLonLat, project);
      const c = this.screenOf(bottomLeft, fromLonLat, project);
      if (!a || !b || !c) continue;

      context.save();
      context.setTransform(
        (b.x - a.x) / TILE_SIZE,
        (b.y - a.y) / TILE_SIZE,
        (c.x - a.x) / TILE_SIZE,
        (c.y - a.y) / TILE_SIZE,
        a.x,
        a.y
      );
      // A half-pixel bleed on each side hides the seam that rounding leaves
      // between neighbouring tiles.
      context.drawImage(state.image, -0.5, -0.5, TILE_SIZE + 1, TILE_SIZE + 1);
      context.restore();
    }

    context.restore();
    this.drawAttribution(context, width, height);
  }

  private screenOf(
    point: { lon: number; lat: number },
    fromLonLat: (lon: number, lat: number) => { x: number; y: number },
    project: (x: number, y: number) => { x: number; y: number }
  ): { x: number; y: number } | null {
    const world = fromLonLat(point.lon, point.lat);
    if (!Number.isFinite(world.x) || !Number.isFinite(world.y)) return null;
    const screen = project(world.x, world.y);
    return Number.isFinite(screen.x) && Number.isFinite(screen.y) ? screen : null;
  }

  /**
   * The attribution, drawn on the canvas rather than in the surrounding HTML.
   *
   * Every open tile service requires it, and putting it in the page chrome
   * would leave it off any exported or screenshotted view — which is precisely
   * where the credit is owed.
   */
  private drawAttribution(context: CanvasRenderingContext2D, width: number, height: number): void {
    const text = this.options.provider.attribution;
    if (!text) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.font = '10px ui-sans-serif, system-ui, sans-serif';
    const metrics = context.measureText(text);
    const padding = 4;
    const boxWidth = metrics.width + padding * 2;
    context.fillStyle = 'rgba(255, 255, 255, 0.72)';
    context.fillRect(width - boxWidth, height - 15, boxWidth, 15);
    context.fillStyle = '#1a1a1a';
    context.fillText(text, width - boxWidth + padding, height - 4);
    context.restore();
  }
}
