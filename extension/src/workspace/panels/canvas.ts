/** Drawing: the single-dataset canvas, the dual canvas and the overlay legend. */

import type { CrsRef } from '../../core/cir';
import {
  colourOf,
  dashPattern,
  isVisible,
  lineTypeOf,
  lineWidthOf,
  opacityOf,
} from '../../core/layers';
import { WGS84_CRS } from '../../crs/epsg';
import { crsLabel, planTransform } from '../../crs/transform';
import { type GeometryOverlay, OVERLAY_ROLE_LABEL } from '../../qa/geometry-overlay';
import { type QueueItem, store } from '../../state/store';
import { DualCanvas } from '../../ui/dual-canvas';
import { Backdrop } from '../../ui/backdrop';
import { Basemap, isOnline, TILE_PROVIDERS, type TileProvider } from '../../ui/basemap';
import { LAYER_COLORS, PreviewCanvas, type PreviewData } from '../../ui/preview';
import { $, element } from '../dom';
import { viewOf } from './dataset';
import { geometryPlanOverlay } from './geometry-ops';
import { ui } from '../ui-state';

export function renderPreview(item: QueueItem): void {
  const canvas = $('previewCanvas') as HTMLCanvasElement;
  if (!ui.previewCanvas) ui.previewCanvas = new PreviewCanvas(canvas, (text) => ($('readout').textContent = text));

  const dataset = item.dataset;
  const data: PreviewData = { layers: [], truncated: false };

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

  attachBasemap(ui.previewCanvas, dataset);

  $('previewOnlyBadge').classList.toggle('hidden', !data.truncated);
  ui.previewCanvas.setData(data);
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
    // NOT `onUnderlay = undefined`: the backdrop is a separate layer and the
    // basemap being off says nothing about it. Clearing the hook here is how
    // an imported sheet would silently vanish the moment the tiles were
    // switched off.
    setUnderlay(canvas, null);
    return;
  }

  const provider = resolveProvider(settings);
  const crs: CrsRef | null = dataset?.crs ?? null;

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

  if (!ui.basemap) {
    ui.basemap = new Basemap({
      provider,
      toLonLat,
      fromLonLat,
      opacity: settings.basemapOpacity,
      // A tile arriving is the only thing that can change the picture without
      // the user doing anything, so it is the only thing that redraws.
      onTileLoaded: () => ui.previewCanvas?.render(),
    });
  } else {
    ui.basemap.update({ provider, toLonLat, fromLonLat, opacity: settings.basemapOpacity });
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
  setUnderlay(canvas, basemap.usable ? basemap : null);

  const badge = document.getElementById('basemapBadge');
  if (badge) {
    const reason = basemap.unavailableReason;
    badge.classList.toggle('hidden', reason === null);
    if (reason) {
      badge.textContent = isOnline() ? 'Basemap: no placeable CRS' : 'Basemap off — no internet';
      badge.title = reason;
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
function setUnderlay(canvas: PreviewCanvas, basemap: Basemap | null): void {
  const backdrop = ui.backdrop;
  const drawsBackdrop = backdrop?.usable ?? false;

  if (!basemap && !drawsBackdrop) {
    canvas.onUnderlay = undefined;
    return;
  }

  canvas.onUnderlay = (context, project, unproject, size) => {
    basemap?.draw(context, size.width, size.height, project, unproject);
    if (drawsBackdrop) backdrop!.draw(context, project);
  };
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
function resolveProvider(settings: { basemapProviderId: string; basemapCustomUrl: string }): TileProvider {
  if (settings.basemapProviderId === 'custom') {
    return {
      id: 'custom',
      name: 'Custom tile service',
      url: settings.basemapCustomUrl,
      // The user is responsible for the terms of a service they supplied, and
      // for the credit it requires; this says so rather than inventing one.
      attribution: 'Custom tile service — check its attribution requirements',
      maxZoom: 22,
    };
  }
  return TILE_PROVIDERS.find((entry) => entry.id === settings.basemapProviderId) ?? TILE_PROVIDERS[0];
}

/** Builds the drawable form of a worker-summarised dataset. */
export function previewDataFor(dataset: any): PreviewData {
  const data: PreviewData = { layers: [], truncated: false };
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
  const outputData = hasOutput ? previewDataFor(item.outputDataset) : null;
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
