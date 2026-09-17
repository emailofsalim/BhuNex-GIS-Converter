/** Drawing: the single-dataset canvas, the dual canvas and the overlay legend. */

import type { CrsRef } from '../../core/cir';
import { EMPTY_SELECTION } from '../../core/selection';
import {
  colourOf,
  dashPattern,
  isVisible,
  lineTypeOf,
  lineWidthOf,
  opacityOf,
} from '../../core/layers';
import { crsFromEpsg, WGS84_CRS } from '../../crs/epsg';
import { crsGridUnit, crsLabel, crsShortLabel, planTransform, sameCrs, transformDataset } from '../../crs/transform';
import { type GeometryOverlay, OVERLAY_ROLE_LABEL } from '../../qa/geometry-overlay';
import { type QueueItem, store } from '../../state/store';
import { DualCanvas } from '../../ui/dual-canvas';
import { Backdrop } from '../../ui/backdrop';
import {
  Basemap,
  composeCredit,
  isOnline,
  RELIEF_PROVIDERS,
  TILE_PRESETS,
  TILE_PROVIDERS,
  type TileProvider,
} from '../../ui/basemap';
import { TerrainSampler, terrainLabel } from '../../ui/terrain';
import { renderMapControl, renderMapSources } from './map-control';
import { LAYER_COLORS, PreviewCanvas, type PreviewData } from '../../ui/preview';
import { $, element } from '../dom';
import { viewOf } from './dataset';
import { geometryPlanOverlay } from './geometry-ops';
import { ui } from '../ui-state';

/**
 * Empties the canvas when there is nothing to draw.
 *
 * `previewWrap` is hidden when no file is selected, which LOOKS like clearing
 * and is not: the bitmap keeps its last drawing, and every hook that paints
 * over it keeps its reference to a dataset that has been removed. Emptying the
 * queue therefore left 282,374 painted pixels sitting behind a `hidden` class,
 * and the moment anything unhid the canvas — importing the next file, a render
 * that reveals it before `setData` runs — the previous file's layers were back
 * on screen.
 *
 * The selection goes too. It addresses features by layer name and index, so a
 * selection held across a file change points into geometry that no longer
 * exists, and the next edit would apply to whatever now occupies those indices.
 */
export function clearPreview(): void {
  ui.featureSelection = EMPTY_SELECTION;
  ui.basemap = undefined;
  ui.basemapRelief = undefined;
  ui.editTrace = null;
  const canvas = ui.previewCanvas;
  if (!canvas) return;

  canvas.onOverlay = undefined;
  setUnderlay(canvas, null, null);
  // The elevation listener is bound to this canvas and to a transform for the
  // file that is going away. Left installed it would keep sampling through it.
  setTerrainReadout(null, canvas);
  // No identity: the next file to arrive is a different subject and will be
  // fitted, rather than inheriting the view of the one just cleared.
  canvas.setData({ layers: [], truncated: false });

  // The bitmap is wiped DIRECTLY, not by asking the canvas to re-render.
  //
  // By the time this runs the wrapper is already hidden, so the element has no
  // layout and the renderer has nothing to lay out against — it returns without
  // painting, and the previous drawing stays in the backing store. Measured:
  // the pixel hash after emptying the queue was identical to the hash while the
  // file was still loaded. `clearRect` does not care about layout.
  const context = canvas.element.getContext('2d');
  if (context) context.clearRect(0, 0, canvas.element.width, canvas.element.height);
}

export function renderPreview(item: QueueItem): void {
  const canvas = $('previewCanvas') as HTMLCanvasElement;
  if (!ui.previewCanvas) ui.previewCanvas = new PreviewCanvas(canvas, (text) => ($('readout').textContent = text));

  const dataset = item.dataset;
  const data: PreviewData = { layers: [], truncated: false };

  // WHAT FRAME THE AXES ARE IN, under the grid.
  //
  // The dataset's own CRS, not the export target: the numbers on this canvas
  // are the ones that were read out of the file, and a caption naming the
  // format it is going to be written to would be describing a drawing that
  // does not exist yet.
  //
  // A DXF almost never declares one, which is the ordinary case rather than an
  // edge: the surveyor knows the grid and assigns it in Settings. That
  // assignment is shown, MARKED AS ASSUMED — a drawing labelled "UTM 44N" that
  // never said so is a claim the file does not support, and telling the two
  // apart is the difference between a caption and a guess.
  const declared = (dataset?.crs ?? null) as CrsRef | null;
  const assumedEpsg = store.get().settings.sourceCrsEpsg;
  const assumed = !declared && assumedEpsg ? crsFromEpsg(assumedEpsg) : null;
  const crs = declared ?? assumed;
  data.crs = {
    label: assumed ? `${crsShortLabel(assumed)} (assumed)` : crsShortLabel(declared),
    unit: crsGridUnit(crs),
  };

  if (dataset?.layers?.length) {
    const view = viewOf(item);
    dataset.layers.forEach((layer: any, index: number) => {
      data.layers.push({
        name: layer.name,
        // Was hardcoded true, which made the eye and the padlock in the layer
        // list decorative on this canvas. Visibility, colour, width, line type
        // and opacity all come from the layer view now, so a control the user
        // moves is a control that changes the picture.
        visible: isVisible(view, layer.name),
        color: colourOf(view, layer.name) ?? LAYER_COLORS[index % LAYER_COLORS.length],
        features: layer.preview ?? [],
        lineWidth: lineWidthOf(view, layer.name),
        lineDash: dashPattern(lineTypeOf(view, layer.name)),
        opacity: opacityOf(view, layer.name),
      });
      if (layer.previewTruncated) data.truncated = true;
    });
  }
  if (dataset?.pointcloud) {
    data.cloud = {
      x: dataset.pointcloud.previewX,
      y: dataset.pointcloud.previewY,
      z: dataset.pointcloud.previewZ,
      classification: dataset.pointcloud.previewClassification,
    };
    if (dataset.pointcloud.previewX.length < dataset.pointcloud.loaded) data.truncated = true;
  }
  if (dataset?.raster?.extent) {
    data.raster = {
      extent: dataset.raster.extent,
      label: `${dataset.raster.width} × ${dataset.raster.height}${dataset.raster.hasPixelData ? '' : ' — georeference only'}`,
    };
  }

  // The geometry planner draws its uncommitted result on top, so the shape can
  // be checked before it replaces anything. `undefined` clears a stale overlay
  // when the tab changes — leaving the last plan drawn over a different layer
  // would be worse than drawing nothing.
  ui.previewCanvas.onOverlay =
    store.get().inspectorTab === 'geometry-ops' ? geometryPlanOverlay(item) : undefined;

  // The pre-edit ghost, styled like the live layers so shapes are comparable
  // rather than merely present.
  const trace = ui.editTrace as { layers?: any[] } | null | undefined;
  data.trace = trace?.layers?.length
    ? trace.layers.map((layer: any, index: number) => ({
        name: layer.name,
        visible: true,
        color: LAYER_COLORS[index % LAYER_COLORS.length],
        features: layer.preview ?? layer.features ?? [],
        lineWidth: 1,
        lineDash: [],
        opacity: 1,
      }))
    : undefined;

  attachBasemap(ui.previewCanvas, dataset);

  $('previewOnlyBadge').classList.toggle('hidden', !data.truncated);
  // The item's id is the subject: re-rendering the same file after an edit
  // keeps the pan and zoom, and selecting a different file fits to it.
  ui.previewCanvas.setData(data, item.id);
}

/**
 * Puts map tiles under a canvas, or takes them away.
 *
 * Everything about whether this is possible is decided here rather than inside
 * `Basemap`: the tile code knows how to place an image given two closures, and
 * knows nothing about CRS, datums or datasets. If a transform to WGS 84 cannot
 * be built — an undeclared CRS, a local site grid, a datum with no bundled
 * shift — the closures are null and the basemap draws nothing at all.
 *
 * That refusal is the important part. Guessing a placement would put imagery
 * under a survey at the wrong position, and imagery is persuasive: a parcel
 * that does not line up with a convincing-looking basemap reads as a bad
 * survey, not as a bad basemap.
 */
function attachBasemap(canvas: PreviewCanvas, dataset: any): void {
  const settings = store.get().settings;
  if (!settings.basemapEnabled) {
    ui.basemap = undefined;
    ui.basemapRelief = undefined;
    // NOT `onUnderlay = undefined`: the backdrop is a separate layer and the
    // basemap being off says nothing about it. Clearing the hook here is how
    // an imported sheet would silently vanish the moment the tiles were
    // switched off.
    setUnderlay(canvas, null, null);
    renderMapControl();
    renderMapSources();
    setTerrainReadout(null, null);
    return;
  }

  const provider = resolveProvider(settings);
  // During a placement the working copy already carries the target CRS, so the
  // tiles draw for a drawing that declared nothing — which is the entire point
  // of being able to see the map while aligning against it.
  const crs: CrsRef | null = dataset?.crs ?? ui.georefSession?.targetCrs ?? null;

  let toLonLat: ((x: number, y: number) => { lon: number; lat: number }) | null = null;
  let fromLonLat: ((lon: number, lat: number) => { x: number; y: number }) | null = null;
  try {
    // Built once per render rather than per tile: planTransform validates the
    // datum path and throws, and doing that inside the draw loop would turn a
    // refusal into an exception sixty-four times a frame.
    const out = planTransform(crs, WGS84_CRS);
    const back = planTransform(WGS84_CRS, crs);
    toLonLat = (x, y) => {
      const [lon, lat] = out.transform([x, y]);
      return { lon, lat };
    };
    fromLonLat = (lon, lat) => {
      const [x, y] = back.transform([lon, lat]);
      return { x, y };
    };
  } catch {
    // A CRS the bundled engine cannot move. Nothing is drawn and nothing is
    // thrown; the panel says why, next to the control that turned this on.
    toLonLat = null;
    fromLonLat = null;
  }

  // THE CREDIT FOR EVERY LAYER THAT IS ON, composed here and given to the
  // bottom one. Each layer drawing its own would stack two boxes in the same
  // corner of the canvas, the upper one covering the lower — and the covered
  // one is still an attribution the licence requires.
  const relief = settings.basemapReliefEnabled
    ? RELIEF_PROVIDERS.find((entry) => entry.id === settings.basemapReliefId) ?? RELIEF_PROVIDERS[0]
    : null;
  const credit = composeCredit(provider, relief);

  if (!ui.basemap) {
    ui.basemap = new Basemap({
      provider,
      toLonLat,
      fromLonLat,
      opacity: settings.basemapOpacity,
      credit,
      // A tile arriving is the only thing that can change the picture without
      // the user doing anything, so it is the only thing that redraws.
      onTileLoaded: () => ui.previewCanvas?.render(),
    });
  } else {
    ui.basemap.update({ provider, toLonLat, fromLonLat, opacity: settings.basemapOpacity, credit });
  }

  // The relief layer, allocated only while it is on so a session that never
  // asks for terrain never holds a second tile cache.
  if (!relief) {
    ui.basemapRelief = undefined;
  } else if (!ui.basemapRelief) {
    ui.basemapRelief = new Basemap({
      provider: relief,
      toLonLat,
      fromLonLat,
      // Held back from full so the map underneath still reads through the
      // shading. A hillshade at opacity 1 is an opaque grey map.
      opacity: Math.min(0.85, settings.basemapOpacity),
      // Empty, not the provider's: its credit is already in the composed line
      // the base layer draws.
      credit: '',
      onTileLoaded: () => ui.previewCanvas?.render(),
    });
  } else {
    ui.basemapRelief.update({
      provider: relief,
      toLonLat,
      fromLonLat,
      opacity: Math.min(0.85, settings.basemapOpacity),
      credit: '',
    });
  }

  const basemap = ui.basemap;
  // `usable` covers both reasons a basemap cannot draw: no CRS it can place
  // tiles in, and no network to fetch them over. Offline it is not merely
  // blank — no request is made at all, which is the promise R15 makes and what
  // the owner asked for: the tiles stay off until the connection returns.
  //
  // The backdrop goes on TOP of the tiles and under the data, which is the only
  // order that makes sense: the whole reason for importing a sheet is that the
  // imagery beneath it is out of date.
  setUnderlay(canvas, basemap.usable ? basemap : null, ui.basemapRelief?.usable ? ui.basemapRelief : null);

  renderMapControl();
  renderMapSources();
  setTerrainReadout(settings.terrainReadout && basemap.usable ? toLonLat : null, canvas);

  const badge = document.getElementById('basemapBadge');
  if (badge) {
    const reason = basemap.unavailableReason;
    badge.classList.toggle('hidden', reason === null);
    if (reason) {
      // Two different failures, and only one of them is the user's to act on.
      // A missing CRS is fixed in the CRS tab; a browser wrongly reporting
      // offline is fixed by disagreeing with it, so that badge is a button.
      // `unavailableReason` reports the CRS first, so when the network is
      // allowed and a reason survives, the reason IS the CRS one.
      const networkAllowed = isOnline() || basemap.overridden;
      const retryable = !networkAllowed;
      badge.textContent = retryable
        ? 'Basemap off — browser reports offline. Try anyway'
        : 'Basemap: no placeable CRS';
      badge.title = reason;
      badge.classList.toggle('badge--action', retryable);
      badge.setAttribute('role', retryable ? 'button' : 'note');
      if (retryable) badge.setAttribute('tabindex', '0');
      else badge.removeAttribute('tabindex');

      // Rebound every render, so the handler always closes over the CURRENT
      // basemap rather than one replaced by a provider or CRS change.
      // `tryAnyway` ends in `onTileLoaded`, which is the canvas repaint hook
      // this basemap was constructed with — the same one a tile arriving uses.
      // Calling a render here as well would be a second, competing path.
      const retry = (): void => basemap.tryAnyway();
      badge.onclick = retryable ? retry : null;
      badge.onkeydown = retryable
        ? (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              retry();
            }
          }
        : null;
    }
  }
}

/**
 * Installs the one underlay hook, which two layers share.
 *
 * `PreviewCanvas` has ONE `onUnderlay` for the same reason it has one
 * `onOverlay`: a list would let a layer keep drawing after the thing that owns
 * it has gone. So the composition happens here, in the order that matters —
 * tiles first, then the imported sheet on top of them, then the data on top of
 * both. A backdrop under the tiles would be invisible, which is the opposite of
 * why someone imports one.
 */
function setUnderlay(canvas: PreviewCanvas, basemap: Basemap | null, relief: Basemap | null): void {
  const backdrop = ui.backdrop;
  const drawsBackdrop = backdrop?.usable ?? false;

  if (!basemap && !relief && !drawsBackdrop) {
    canvas.onUnderlay = undefined;
    return;
  }

  canvas.onUnderlay = (context, project, unproject, size) => {
    basemap?.draw(context, size.width, size.height, project, unproject);
    // Relief AFTER the base map and before the sheet: shading the ground is
    // only meaningful over something that says where the ground is, and a
    // hillshade over an imported drawing would grey out the drawing.
    relief?.draw(context, size.width, size.height, project, unproject);
    if (drawsBackdrop) backdrop!.draw(context, project);
  };
}

// --------------------------------------------------------- terrain readout

/** Held across renders so panning does not re-fetch tiles it already decoded. */
let sampler: TerrainSampler | null = null;
/** The listener currently installed, so it can be taken off again. */
let terrainMove: ((event: PointerEvent) => void) | null = null;
/**
 * The last point the pointer was over, in degrees.
 *
 * Module-level rather than captured per call, because the tile that answers a
 * query usually arrives AFTER the mouse has stopped moving — so the redraw the
 * sampler triggers has no event of its own to work from, and without this the
 * number would only ever appear on the next movement over an already-cached
 * tile. Which is to say: on a fresh area, never.
 */
let terrainPoint: { lon: number; lat: number } | null = null;

/** Writes the current elevation into the readout, from whatever is cached. */
function paintTerrain(): void {
  const node = document.getElementById('terrainReadout');
  if (!node) return;
  if (!terrainPoint) {
    node.textContent = terrainLabel(null);
    return;
  }
  node.textContent = terrainLabel(sampler?.sample(terrainPoint.lon, terrainPoint.lat) ?? null);
}

/**
 * Shows the ground elevation under the pointer, or takes the readout away.
 *
 * `toLonLat` being null is the off switch and covers every reason at once: the
 * setting is off, the basemap is off, or there is no CRS the point can be
 * turned into a longitude and latitude in. A readout that stayed on screen
 * showing the last height from a different file would be worse than none.
 */
function setTerrainReadout(
  toLonLat: ((x: number, y: number) => { lon: number; lat: number }) | null,
  canvas: PreviewCanvas | null
): void {
  // `clearPreview` reaches here, and it is tested in a plain Node runner with
  // no DOM at all. Nothing below is meaningful without one.
  if (typeof document === 'undefined') return;
  const node = document.getElementById('terrainReadout');
  const target = canvas?.element ?? null;

  // Removed unconditionally first, so a re-render replaces the listener instead
  // of adding a second one that samples through a stale transform.
  if (terrainMove && target) target.removeEventListener('pointermove', terrainMove);
  terrainMove = null;

  if (!toLonLat || !target || !node) {
    node?.classList.add('hidden');
    terrainPoint = null;
    sampler?.clear();
    return;
  }

  node.classList.remove('hidden');

  // Created on first use and then kept: its whole value is the cache, and
  // rebuilding it per render would re-fetch a tile per mouse move. Its callback
  // writes the label rather than calling `render()` — a full canvas repaint for
  // a text change is work nobody asked for.
  if (!sampler) sampler = new TerrainSampler(paintTerrain);

  terrainMove = (event: PointerEvent) => {
    const world = ui.previewCanvas?.unproject(event.offsetX, event.offsetY);
    if (!world) return;
    terrainPoint = toLonLat(world.x, world.y);
    paintTerrain();
  };
  target.addEventListener('pointermove', terrainMove);
  paintTerrain();
}

/**
 * Creates the backdrop layer on first use.
 *
 * Called from the render path rather than at boot, so a session that never
 * opens the tab never allocates one.
 */
export function ensureBackdrop(): Backdrop | null {
  if (!ui.previewCanvas) return null;
  if (!ui.backdrop) ui.backdrop = new Backdrop(ui.previewCanvas);
  return ui.backdrop;
}

/**
 * Re-renders when the connection comes or goes.
 *
 * Installed once at boot. Without it the basemap would only notice a restored
 * connection the next time something else caused a render, which for someone
 * sitting looking at a blank canvas is never.
 */
export function watchConnectivity(onChange: () => void): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
}

/** The chosen provider, or a custom template the user entered. */
function resolveProvider(settings: {
  basemapProviderId: string;
  basemapCustomUrl: string;
  basemapPresetId?: string;
}): TileProvider {
  if (settings.basemapProviderId === 'custom') {
    // A custom URL started from a preset is not anonymous: the preset names the
    // service, who it requires credited, and the zoom it stops at. Ignoring
    // that — which this did — credited nobody on a Stadia or Jawg canvas whose
    // terms require it, and asked those services for z21 and z22 tiles they do
    // not serve. The URL is still compared, so editing it away from the preset
    // drops back to the honest generic wording rather than keeping a credit for
    // a service no longer being used.
    const preset = TILE_PRESETS.find((entry) => entry.id === settings.basemapPresetId);
    const fromPreset = preset && sameService(settings.basemapCustomUrl, preset.template);
    return {
      id: 'custom',
      name: fromPreset ? preset.name : 'Custom tile service',
      url: settings.basemapCustomUrl,
      // Without a preset the user is responsible for the terms of a service
      // they supplied, and for the credit it requires; this says so rather
      // than inventing one.
      attribution: fromPreset ? preset.attribution : 'Custom tile service — check its attribution requirements',
      maxZoom: fromPreset ? preset.maxZoom : 22,
    };
  }
  return TILE_PROVIDERS.find((entry) => entry.id === settings.basemapProviderId) ?? TILE_PROVIDERS[0];
}

/**
 * True when a custom URL is still the preset it was started from.
 *
 * Compared with the key removed, because the whole point of the preset flow is
 * that the user fills their own key in — so the URL is never byte-identical to
 * the template it came from. Everything up to the query string is the part that
 * identifies the service.
 */
function sameService(url: string, template: string): boolean {
  const base = (value: string) => value.split('?')[0].trim();
  return base(url) === base(template);
}

/** Builds the drawable form of a worker-summarised dataset. */
export function previewDataFor(dataset: any): PreviewData {
  const data: PreviewData = { layers: [], truncated: false };

  // EACH PANE DECLARES ITS OWN FRAME.
  //
  // The two compare panes usually hold the SAME data in DIFFERENT coordinate
  // systems — a projected source beside a WGS 84 output, because KML and its
  // family have nowhere to record anything else. Without this the output pane
  // plotted degrees straight onto x/y and drew the world stretched sideways by
  // 1/cos(latitude), so an untouched conversion looked like it had reshaped
  // every elongated feature. The canvas corrects for it, and can only do so if
  // it is told which unit it is drawing.
  const crs = (dataset?.crs ?? null) as CrsRef | null;
  data.crs = { label: crsShortLabel(crs), unit: crsGridUnit(crs) };
  if (dataset?.layers?.length) {
    dataset.layers.forEach((layer: any, index: number) => {
      data.layers.push({
        name: layer.name,
        visible: true,
        color: LAYER_COLORS[index % LAYER_COLORS.length],
        features: layer.preview ?? [],
      });
      if (layer.previewTruncated) data.truncated = true;
    });
  }
  if (dataset?.pointcloud?.previewX) {
    data.cloud = {
      x: dataset.pointcloud.previewX,
      y: dataset.pointcloud.previewY,
      z: dataset.pointcloud.previewZ,
      classification: dataset.pointcloud.previewClassification,
    };
  }
  if (dataset?.raster?.extent) {
    data.raster = {
      extent: dataset.raster.extent,
      label: `${dataset.raster.width} × ${dataset.raster.height}${dataset.raster.hasPixelData ? '' : ' — georeference only'}`,
    };
  }
  return data;
}

/**
 * Splits the overlay into what each pane draws.
 *
 * The left pane gets the source geometry of every difference, the right pane
 * the output geometry — so a feature that exists only in the output appears on
 * the right and is simply absent on the left, which is the truth about it. The
 * alternative, drawing both sides on both canvases, produces two identical
 * pictures and answers nothing.
 */
export function splitOverlay(overlay: GeometryOverlay | undefined): {
  source: PreviewData['overlay'];
  output: PreviewData['overlay'];
} {
  if (!overlay) return { source: [], output: [] };
  const source: NonNullable<PreviewData['overlay']> = [];
  const output: NonNullable<PreviewData['overlay']> = [];
  for (const item of overlay.items) {
    if (item.role === 'unchanged') continue;
    if (item.source) source.push({ role: item.role, geometry: item.source, at: item.at });
    if (item.output) output.push({ role: item.role, geometry: item.output, at: item.at });
  }
  return { source, output };
}

export function renderCompare(item: QueueItem): void {
  const host = $('compareCanvas');
  if (!ui.dualCanvas) {
    ui.dualCanvas = new DualCanvas(host, {
      onReadout: (text, side) => ($('compareReadout').textContent = `${side === 'source' ? 'Source' : 'Output'} ${text}`),
      onAutoUnlink: (reason) => {
        store.set({ compareLinked: false });
        const note = $('compareNote');
        note.textContent = reason;
        note.classList.remove('hidden');
        updateLinkButton();
      },
    });
  }

  const overlay = splitOverlay(item.overlay);
  const sourceData = previewDataFor(item.dataset);
  sourceData.overlay = overlay.source;

  const hasOutput = Boolean(item.outputDataset);
  // BOTH PANES ARE DRAWN IN THE SOURCE'S FRAME.
  //
  // They usually hold the SAME geometry in DIFFERENT coordinate systems: a
  // projected survey on the left, and on the right the same survey as KML and
  // its family are obliged to store it, in WGS 84. Shown each in its own frame
  // they do not look alike, and the difference is not damage — it is geodesy.
  // Measured on a real DXF → KML with a PASSing QA and identical vertex counts
  // on every ring: a 0.34° rotation between the panes from meridian
  // convergence (grid north is not true north), and an 8% horizontal squeeze
  // from cos(latitude). Both are real, neither is a conversion defect, and
  // together they make an untouched conversion look reshaped.
  //
  // A compare view whose two halves cannot be laid over each other is not
  // comparing anything, so the output is brought back into the source's frame
  // for DISPLAY. Nothing here touches what is exported; the file on disk stays
  // in the CRS the format requires.
  const outputData = hasOutput ? previewDataFor(comparableOutput(item)) : null;
  if (outputData) outputData.overlay = overlay.output;

  ui.dualCanvas.setData(sourceData, outputData);
  ui.dualCanvas.setLinked(store.get().compareLinked);
  ui.dualCanvas.setStatus('source', describeDatasetShort(item.dataset));
  ui.dualCanvas.setStatus(
    'output',
    hasOutput
      ? describeDatasetShort(item.outputDataset)
      : item.status === 'done'
        ? 'The target has no reader in this build, so the output cannot be drawn.'
        : 'Not converted yet.'
  );

  renderOverlayLegend(item.overlay);
  updateLinkButton();
}

/**
 * The output dataset in the SOURCE's coordinate system, for the compare panes.
 *
 * Returns the output unchanged when the two already share a CRS, when either
 * declares none, or when the transform cannot be built — a refusal to
 * reproject is not a reason to draw nothing, and the pane's own caption still
 * names the CRS it is in either way.
 */
function comparableOutput(item: QueueItem): any {
  const output = item.outputDataset as any;
  const from = (output?.crs ?? null) as CrsRef | null;
  const to = ((item.dataset as any)?.crs ?? null) as CrsRef | null;
  if (!output || !from || !to || sameCrs(from, to)) return output;

  try {
    // The preview features are what the pane draws, so they are what has to
    // move. `transformDataset` works on `features`, hence the swap in and back.
    const shaped = {
      ...output,
      layers: (output.layers ?? []).map((layer: any) => ({ ...layer, features: layer.preview ?? [] })),
    };
    const moved = transformDataset(shaped as never, to) as any;
    return {
      ...output,
      crs: to,
      layers: (moved.layers ?? []).map((layer: any, index: number) => ({
        ...(output.layers ?? [])[index],
        preview: layer.features ?? [],
      })),
    };
  } catch {
    // A datum with no bundled shift, most often. Drawing the output in its own
    // frame is still better than an empty pane.
    return output;
  }
}

export function describeDatasetShort(dataset: any): string {
  if (!dataset) return '';
  const features = (dataset.layers ?? []).reduce((sum: number, layer: any) => sum + (layer.featureCount ?? 0), 0);
  const crs = dataset.crs ? crsLabel(dataset.crs) : 'no CRS declared';
  return `${features.toLocaleString()} features · ${crs}`;
}

export function renderOverlayLegend(overlay: GeometryOverlay | undefined): void {
  const legend = $('compareLegend');
  legend.replaceChildren();
  if (!overlay) return;
  for (const role of ['added', 'removed', 'moved', 'retyped'] as const) {
    if (overlay.counts[role] === 0) continue;
    const item = element('span', { class: `compare__key compare__key--${role}` });
    item.append(element('i', { class: 'compare__swatch' }));
    item.append(element('span', { text: `${OVERLAY_ROLE_LABEL[role]} (${overlay.counts[role].toLocaleString()})` }));
    legend.append(item);
  }
}

export function updateLinkButton(): void {
  const linked = store.get().compareLinked;
  const button = $('compareLinkBtn');
  button.textContent = linked ? 'Linked' : 'Unlinked';
  button.title = linked
    ? 'The two panes pan and zoom together. Click to move them independently.'
    : 'The two panes move independently. Click to link them.';
  button.classList.toggle('btn--on', linked);
}

// ------------------------------------------------------------ vertex editing
