/**
 * Canvas preview.
 *
 * A 2D canvas renderer rather than a map library, because the extension must
 * work with the network disabled (rule R15) and tiles need a server. It draws
 * the dataset's own geometry in its own coordinate system, with a graticule and
 * a live coordinate readout.
 *
 * Preview data is never export data: point clouds are thinned to a drawable
 * budget, vector layers are capped, and both cases are labelled in the UI.
 */

import type { Bounds } from '../core/cir';

export interface PreviewLayer {
  name: string;
  visible: boolean;
  color: string;
  features: { geometry: any; properties?: Record<string, unknown> }[];
  /** Stroke width in screen pixels. Absent means the renderer's default. */
  lineWidth?: number;
  /** Dash pattern in screen pixels. Absent or empty means solid. */
  lineDash?: number[];
  /** 0..1. Absent means fully opaque. */
  opacity?: number;
}

export interface PreviewPointCloud {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  classification?: Uint8Array;
}

/**
 * A geometry difference drawn on top of the data (spec §30.1).
 *
 * Kept separate from the layers rather than folded into them: an overlay is
 * evidence about the conversion, not part of the dataset, and it must stay
 * legible when the layer beneath it is hidden.
 */
export interface PreviewOverlayItem {
  role: 'added' | 'removed' | 'moved' | 'retyped';
  geometry: any;
  /** Marker position, when the item has one. */
  at?: number[];
}

export interface PreviewData {
  layers: PreviewLayer[];
  cloud?: PreviewPointCloud;
  raster?: { extent: Bounds; label: string };
  /** Where the source and the output differ, drawn over both canvases. */
  overlay?: PreviewOverlayItem[];
  /**
   * The geometry as it stood before the pending edits, drawn as a grey dashed
   * ghost under the live data.
   *
   * A survey edit is only defensible if it can be compared with what was there.
   * Moving a boundary used to leave nothing behind: the parcel simply was
   * somewhere else now, and how far it had gone was unrecoverable by eye. The
   * trace stays for as long as the edits are pending, and goes when they are
   * discarded or written out.
   */
  trace?: PreviewLayer[];
  /** True when what is drawn is a subset of what will be exported. */
  truncated: boolean;
  /**
   * What frame the numbers on the axes are in.
   *
   * The grid used to print "grid 100 m" under every drawing, whatever the
   * coordinate system — so a file in WGS 84 was labelled in metres while its
   * grid lines were 0.001° apart, and a site grid in feet was labelled in
   * metres too. A grid that states a unit it has not checked is worse than a
   * grid with no caption: it is a measurement the reader has no reason to
   * doubt. The caption now names the CRS and counts in ITS unit.
   */
  crs?: { label: string; unit: 'degree' | 'metre' | 'foot' | 'unknown' };
}

/**
 * The view as world coordinates rather than pixels.
 *
 * Two canvases of different widths must show the same ground, not the same
 * pixel offsets, so linking exchanges a centre and a scale. Sharing `offsetX`
 * between panes of unequal width would put the same feature in two different
 * places and call it synchronised.
 */
export interface ViewState {
  scale: number;
  centreX: number;
  centreY: number;
}

interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Overlay colours, chosen to read on both themes and against every layer colour. */
/**
 * The colour of a pre-edit trace. Grey and low-contrast on purpose: it is a
 * reference, not data, and must never be mistaken for a real boundary.
 */
const TRACE_COLOR = 'rgba(140, 148, 158, 0.85)';

const OVERLAY_COLORS: Record<PreviewOverlayItem['role'], string> = {
  added: '#3fb950',
  removed: '#f85149',
  moved: '#d29922',
  retyped: '#a371f7',
};

/** Classification colours follow the ASPRS LAS class table. */
const CLASS_COLORS: Record<number, string> = {
  0: '#8792a3',
  1: '#8792a3',
  2: '#b07d4a',
  3: '#4d8f3a',
  4: '#3fa04a',
  5: '#2f7d38',
  6: '#c85a5a',
  7: '#e05c5c',
  9: '#3a7bd5',
  11: '#8a8a8a',
  17: '#a06fd0',
};

export class PreviewCanvas {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private data: PreviewData = { layers: [], truncated: false };
  private bounds: Bounds | null = null;
  private view: View = { scale: 1, offsetX: 0, offsetY: 0 };
  private showGrid = true;
  /**
   * What the canvas is currently showing, so a re-render of the SAME subject
   * can keep the view while a new one is fitted. Undefined means nothing.
   */
  private identity: string | undefined = undefined;
  private hasFitted = false;
  /**
   * Whether the fit that produced the current view was measured against a REAL
   * canvas size.
   *
   * The canvas is inside `#previewWrap`, which is `hidden` until a file is
   * selected — so the first `setData` usually fits against a zero-sized element
   * and falls back to a notional 800x400. That produced a view at roughly the
   * wrong scale and, once `setData` stopped re-fitting on every render to
   * preserve the user's zoom, nothing ever corrected it: the drawing stayed
   * mis-scaled and every hit test missed, because unproject was answering in a
   * coordinate frame the data does not live in.
   */
  private fittedWithLayout = false;
  /**
   * How much narrower a degree of longitude is than a degree of latitude here.
   *
   * A canvas that plots lon/lat straight onto x/y draws the world stretched
   * sideways by 1/cos(latitude) — 8% at 23°N, and a factor of TWO at 60°. That
   * is why the Compare panes looked like they held different geometry when the
   * conversion had changed nothing: the source pane was a projected grid in
   * metres and the output pane was the same shapes in degrees, so every
   * elongated feature came out a visibly different shape beside itself.
   *
   * Measured on a real DXF → KML: identical vertex counts on every ring, under
   * 1% deviation on compact features, and 7–13% on the long thin ones — the
   * signature of an aspect error rather than a geometry one.
   *
   * 1 for anything projected, where x and y are already the same unit.
   */
  private xScale = 1;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private onReadout?: (text: string) => void;
  private resizeObserver?: ResizeObserver;
  /** Called whenever the user pans, zooms or fits, for linked panes. */
  onViewChange?: (view: ViewState) => void;
  /**
   * Set while a linked pane is being driven from another.
   *
   * Without it, A moves B, B reports back, A moves again: the two panes chase
   * each other and neither settles.
   */
  private echoing = false;

  constructor(canvas: HTMLCanvasElement, onReadout?: (text: string) => void) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas context unavailable');
    this.context = context;
    this.onReadout = onReadout;
    this.attach();
  }

  /** The view in world terms, for handing to a linked pane. */
  getView(): ViewState {
    const rect = this.canvas.getBoundingClientRect();
    const centre = this.toWorld((rect.width || 800) / 2, (rect.height || 400) / 2);
    return { scale: this.view.scale, centreX: centre.x, centreY: centre.y };
  }

  /** Shows the same ground at the same scale as another pane. */
  setView(view: ViewState): void {
    if (!Number.isFinite(view.scale) || view.scale <= 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 400;
    this.view.scale = view.scale;
    this.view.offsetX = width / 2 - view.centreX * view.scale * this.xScale;
    this.view.offsetY = height / 2 + view.centreY * view.scale;
    this.echoing = true;
    this.render();
    this.echoing = false;
  }

  private announceView(): void {
    if (this.echoing) return;
    this.onViewChange?.(this.getView());
  }

  private attach(): void {
    this.canvas.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      this.lastPointer = { x: event.offsetX, y: event.offsetY };
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointerup', (event) => {
      this.dragging = false;
      this.canvas.releasePointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (this.dragging) {
        this.view.offsetX += event.offsetX - this.lastPointer.x;
        this.view.offsetY += event.offsetY - this.lastPointer.y;
        this.lastPointer = { x: event.offsetX, y: event.offsetY };
        this.render();
        this.announceView();
      }
      const world = this.toWorld(event.offsetX, event.offsetY);
      this.onReadout?.(`${world.x.toFixed(3)}, ${world.y.toFixed(3)}`);
    });
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        // Zoom about the cursor so the point under it stays put.
        const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
        const before = this.toWorld(event.offsetX, event.offsetY);
        this.view.scale *= factor;
        const after = this.toWorld(event.offsetX, event.offsetY);
        this.view.offsetX += (after.x - before.x) * this.view.scale * this.xScale;
        this.view.offsetY -= (after.y - before.y) * this.view.scale;
        this.render();
        this.announceView();
      },
      { passive: false }
    );

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);

    // THE FIRST REAL SIZE EARNS A REAL FIT.
    //
    // Only when the view still comes from a provisional fit — never once the
    // canvas has been fitted against a genuine size, because from then on the
    // view is the user's and resizing the window must not throw their zoom
    // away. This is the one thing that used to be repaired by `setData`
    // re-fitting on every render.
    if (!this.fittedWithLayout && this.bounds && rect.width > 0 && rect.height > 0) {
      this.fit();
      return;
    }
    this.render();
  }

  /**
   * Replaces what is drawn, and fits ONLY when the subject changed.
   *
   * This used to call `fit()` every time, and `renderPreview` runs on every
   * render of the workspace — so every edit, every layer toggle, every panel
   * switch threw away the pan and zoom and jumped back to the whole drawing.
   * Zooming into a corner to nudge a boundary against the basemap and having
   * the view snap out on the first drag is not a preference, it is the tool
   * refusing to be worked in.
   *
   * `identity` is what the canvas is showing — the queue item's id. A new
   * subject is fitted because the previous view describes somewhere else
   * entirely; the SAME subject re-rendered keeps the view, even though an edit
   * may have moved its bounds slightly. Fit is still one keystroke (F) away
   * when it is actually wanted.
   */
  setData(data: PreviewData, identity?: string): void {
    this.data = data;
    this.bounds = computeBounds(data);
    this.xScale = this.computeXScale();

    const changed = identity !== this.identity;
    this.identity = identity;
    if (changed || !this.hasFitted) {
      this.hasFitted = true;
      this.fit();
      return;
    }
    this.render();
  }

  toggleGrid(): void {
    this.showGrid = !this.showGrid;
    this.render();
  }

  fit(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 400;
    // A fit against a hidden canvas is provisional: it used the fallback size,
    // so `resize` must redo it once the element actually has one.
    this.fittedWithLayout = rect.width > 0 && rect.height > 0;
    if (!this.bounds || !Number.isFinite(this.bounds.minX)) {
      this.view = { scale: 1, offsetX: width / 2, offsetY: height / 2 };
      this.render();
      this.announceView();
      return;
    }
    // The x span is measured in SCREEN terms, so the squeeze is part of what
    // has to fit — otherwise a geographic dataset is fitted to a width it will
    // not occupy and sits off-centre.
    const spanX = Math.max((this.bounds.maxX - this.bounds.minX) * this.xScale, 1e-9);
    const spanY = Math.max(this.bounds.maxY - this.bounds.minY, 1e-9);
    const padding = 28;
    this.view.scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
    const centreX = (this.bounds.minX + this.bounds.maxX) / 2;
    const centreY = (this.bounds.minY + this.bounds.maxY) / 2;
    this.view.offsetX = width / 2 - centreX * this.view.scale * this.xScale;
    // Screen y grows downward while northing grows upward, hence the sign.
    this.view.offsetY = height / 2 + centreY * this.view.scale;
    this.render();
    this.announceView();
  }

  /** The data's own extent, so a linked pane can fit to the other's data. */
  extent(): Bounds | null {
    return this.bounds;
  }

  /** The element, so an interaction layer can bind its own pointer events. */
  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Called after every render, for a layer that draws its own thing.
   *
   * The editing overlay needs to draw vertex handles in the same transform the
   * geometry was drawn in, and it must redraw whenever the view moves. A hook
   * here keeps that in step without PreviewCanvas knowing anything about
   * editing — it hands over the context and the projection and nothing else.
   */
  onOverlay?: (context: CanvasRenderingContext2D, project: (x: number, y: number) => { x: number; y: number }) => void;

  /**
   * Called before anything else is drawn, for a layer that goes underneath.
   *
   * The mirror of `onOverlay`, and it exists so the basemap can draw without
   * PreviewCanvas knowing tiles exist. It is handed the same `project` the
   * geometry is drawn through, plus `unproject` — a tile layer has to ask what
   * ground the canvas is showing before it can know which tiles to fetch,
   * which is the one thing an overlay never needs.
   */
  onUnderlay?: (
    context: CanvasRenderingContext2D,
    project: (x: number, y: number) => { x: number; y: number },
    unproject: (screenX: number, screenY: number) => { x: number; y: number },
    size: { width: number; height: number }
  ) => void;

  /** World to screen, for an interaction layer drawing on top. */
  project(x: number, y: number): { x: number; y: number } {
    return this.toScreen(x, y);
  }

  /** Screen to world, for hit testing a pointer position. */
  unproject(screenX: number, screenY: number): { x: number; y: number } {
    return this.toWorld(screenX, screenY);
  }

  /** How many world units one screen pixel covers, for pick tolerances. */
  get unitsPerPixel(): number {
    return this.view.scale === 0 ? 1 : 1 / this.view.scale;
  }

  private toScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: x * this.view.scale * this.xScale + this.view.offsetX,
      y: this.view.offsetY - y * this.view.scale,
    };
  }

  private toWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.view.offsetX) / (this.view.scale * this.xScale),
      y: (this.view.offsetY - screenY) / this.view.scale,
    };
  }

  /**
   * The longitude squeeze for the data currently loaded.
   *
   * Taken at the middle of the extent rather than per-vertex: this is a view
   * correction, not a projection, and a factor that varied down the canvas
   * would bend straight lines. Over the span of one survey the difference is
   * far below a pixel; over a continent the right answer is to reproject, which
   * is what the conversion does.
   */
  private computeXScale(): number {
    if (this.data.crs?.unit !== 'degree' || !this.bounds || !Number.isFinite(this.bounds.minY)) return 1;
    const midLat = (this.bounds.minY + this.bounds.maxY) / 2;
    if (!Number.isFinite(midLat) || Math.abs(midLat) > 89.5) return 1;
    return Math.max(Math.cos((midLat * Math.PI) / 180), 0.05);
  }

  private style(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  render(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const context = this.context;
    context.clearRect(0, 0, width, height);

    // Under everything, including the grid: the grid is a reading aid for the
    // data and belongs on top of the ground, not beneath it.
    this.onUnderlay?.(context, (x, y) => this.toScreen(x, y), (sx, sy) => this.toWorld(sx, sy), { width, height });

    if (this.showGrid) this.drawGrid(width, height);

    if (this.data.raster) {
      const { extent, label } = this.data.raster;
      const a = this.toScreen(extent.minX, extent.maxY);
      const b = this.toScreen(extent.maxX, extent.minY);
      context.save();
      context.strokeStyle = this.style('--info');
      context.setLineDash([6, 4]);
      context.lineWidth = 1.5;
      context.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      context.setLineDash([]);
      context.fillStyle = this.style('--text-muted');
      context.font = '11px ui-sans-serif, system-ui, sans-serif';
      context.fillText(label, a.x + 6, a.y + 14);
      context.restore();
    }

    if (this.data.cloud) this.drawCloud();

    // UNDER the live data, so an edit is drawn over the place it came from.
    this.drawTrace();

    for (const layer of this.data.layers) {
      if (!layer.visible) continue;
      // Saved and restored per layer: a dash pattern or an alpha left set would
      // leak into every layer drawn after it, and the layer that looks wrong is
      // then the one AFTER the one that is misconfigured.
      context.save();
      context.strokeStyle = layer.color;
      context.fillStyle = layer.color;
      context.lineWidth = layer.lineWidth ?? 1.2;
      context.setLineDash(layer.lineDash ?? []);
      if (layer.opacity !== undefined) context.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      for (const feature of layer.features) this.drawGeometry(feature.geometry);
      context.restore();
    }

    if (this.data.overlay?.length) this.drawOverlay();

    // Last, so handles sit above every layer and above the diff overlay.
    this.onOverlay?.(context, (x, y) => this.toScreen(x, y));
  }

  /**
   * Draws the source-versus-output difference on top of the data.
   *
   * Thicker and in the role colour, so a moved boundary reads as a difference
   * rather than as another layer. Markers are drawn last and unscaled: at the
   * zoom where a 4 mm shift is visible, the parcel it belongs to is not, and
   * the marker is what leads the eye to it.
   */
  private drawOverlay(): void {
    const context = this.context;
    context.save();
    context.lineWidth = 2.4;

    for (const item of this.data.overlay ?? []) {
      const color = OVERLAY_COLORS[item.role];
      context.strokeStyle = color;
      context.fillStyle = color;
      // Removed geometry is dashed: it is not in the output, and drawing it
      // solid alongside geometry that is would misrepresent what was written.
      context.setLineDash(item.role === 'removed' ? [5, 4] : []);
      if (item.geometry) this.drawGeometry(item.geometry);
    }

    context.setLineDash([]);
    for (const item of this.data.overlay ?? []) {
      if (!item.at) continue;
      const screen = this.toScreen(item.at[0], item.at[1]);
      context.strokeStyle = OVERLAY_COLORS[item.role];
      context.lineWidth = 1.6;
      context.beginPath();
      context.arc(screen.x, screen.y, 6, 0, Math.PI * 2);
      context.stroke();
    }

    context.restore();
  }

  private drawGrid(width: number, height: number): void {
    const context = this.context;
    // Choose a round world-space spacing that lands near 90 screen pixels.
    const target = 90 / this.view.scale;
    const magnitude = 10 ** Math.floor(Math.log10(target));
    const normalised = target / magnitude;
    const step = (normalised < 2 ? 1 : normalised < 5 ? 2 : 5) * magnitude;
    if (!Number.isFinite(step) || step <= 0) return;

    const topLeft = this.toWorld(0, 0);
    const bottomRight = this.toWorld(width, height);
    context.save();
    context.strokeStyle = this.style('--border');
    context.lineWidth = 1;
    context.beginPath();
    for (let x = Math.floor(topLeft.x / step) * step; x <= bottomRight.x; x += step) {
      const screen = this.toScreen(x, 0);
      context.moveTo(screen.x, 0);
      context.lineTo(screen.x, height);
    }
    for (let y = Math.floor(bottomRight.y / step) * step; y <= topLeft.y; y += step) {
      const screen = this.toScreen(0, y);
      context.moveTo(0, screen.y);
      context.lineTo(width, screen.y);
    }
    context.stroke();
    const crs = this.data.crs;
    const caption = crs
      ? `${crs.label} · grid ${formatStep(step, crs.unit)}`
      : `grid ${formatStep(step, 'unknown')}`;
    context.font = '10px ui-monospace, monospace';

    // A plate behind the text, because the caption sits over whatever the
    // drawing or the basemap put there. Faint text straight onto satellite
    // imagery is unreadable exactly when the CRS matters most.
    //
    // BOTTOM RIGHT, not bottom left: the coordinate readout is pinned bottom
    // left in the DOM above this canvas, and a caption drawn under it is a
    // caption nobody can read.
    const textWidth = context.measureText(caption).width;
    const left = Math.max(4, width - textWidth - 14);
    context.fillStyle = this.style('--surface');
    context.globalAlpha = 0.82;
    context.fillRect(left, height - 20, textWidth + 10, 16);
    context.globalAlpha = 1;
    context.fillStyle = this.style('--text-muted');
    context.fillText(caption, left + 5, height - 8);
    context.restore();
  }

  /**
   * The pre-edit geometry, grey and dashed.
   *
   * It reuses the same feature walk as the live layers rather than a reduced
   * one, so a ghost of a polygon with a hole shows the hole, and a ghost of a
   * multi-part holding shows both parts. A trace that simplified what it drew
   * would be worse than none: it would invite a comparison against a shape that
   * was never there.
   */
  private drawTrace(): void {
    const trace = this.data.trace;
    if (!trace?.length) return;
    const context = this.context;
    context.save();
    context.strokeStyle = TRACE_COLOR;
    // Outline only. `strokePath` fills a polygon's outer ring at 14% alpha, and
    // a grey wash over the basemap would hide the very imagery the trace is
    // there to be judged against — so the fill is made a no-op rather than the
    // walk being reduced to one that cannot draw holes.
    context.fillStyle = 'rgba(0, 0, 0, 0)';
    context.lineWidth = 1.2;
    context.setLineDash([4, 4]);
    for (const layer of trace) {
      if (!layer.visible) continue;
      for (const feature of layer.features) this.drawGeometry(feature.geometry);
    }
    context.restore();
  }

  private drawCloud(): void {
    const cloud = this.data.cloud!;
    const context = this.context;
    const size = this.view.scale > 0.5 ? 2 : 1;
    const accent = this.style('--accent');
    for (let index = 0; index < cloud.x.length; index++) {
      const screen = this.toScreen(cloud.x[index], cloud.y[index]);
      context.fillStyle = cloud.classification ? (CLASS_COLORS[cloud.classification[index]] ?? accent) : accent;
      context.fillRect(screen.x, screen.y, size, size);
    }
  }

  private drawGeometry(geometry: any): void {
    if (!geometry) return;
    const context = this.context;
    switch (geometry.type) {
      case 'Point': {
        const screen = this.toScreen(geometry.coordinates[0], geometry.coordinates[1]);
        context.beginPath();
        context.arc(screen.x, screen.y, 2.5, 0, Math.PI * 2);
        context.fill();
        break;
      }
      case 'MultiPoint':
        for (const position of geometry.coordinates) this.drawGeometry({ type: 'Point', coordinates: position });
        break;
      case 'LineString':
        this.strokePath(geometry.coordinates, false);
        break;
      case 'MultiLineString':
        for (const line of geometry.coordinates) this.strokePath(line, false);
        break;
      case 'Polygon':
        for (const [index, ring] of (geometry.coordinates as number[][][]).entries()) this.strokePath(ring, index === 0);
        break;
      case 'MultiPolygon':
        for (const rings of geometry.coordinates) {
          for (const [index, ring] of (rings as number[][][]).entries()) this.strokePath(ring, index === 0);
        }
        break;
      case 'GeometryCollection':
        for (const child of geometry.geometries ?? []) this.drawGeometry(child);
        break;
      default:
        break;
    }
  }

  private strokePath(positions: number[][], fill: boolean): void {
    if (!positions || positions.length < 2) return;
    const context = this.context;
    context.beginPath();
    for (let index = 0; index < positions.length; index++) {
      const screen = this.toScreen(positions[index][0], positions[index][1]);
      if (index === 0) context.moveTo(screen.x, screen.y);
      else context.lineTo(screen.x, screen.y);
    }
    if (fill) {
      context.save();
      // Multiplied, not assigned: the layer's own opacity is already on the
      // context, and assigning here would make a layer faded to 10% draw its
      // fill at the same strength as a fully opaque one.
      context.globalAlpha *= 0.14;
      context.fill();
      context.restore();
    }
    context.stroke();
  }
}

/**
 * One grid interval, in the unit the coordinates are actually counted in.
 *
 * Degrees never become "km": a tenth of a degree is not a distance until you
 * say where on the ellipsoid it is, and the grid is not the place to pretend
 * otherwise. Metres and feet do scale up, because they are lengths.
 */
function formatStep(step: number, unit: 'degree' | 'metre' | 'foot' | 'unknown'): string {
  if (unit === 'degree') return `${trim(step)}°`;
  if (unit === 'foot') return step >= 5280 ? `${trim(step / 5280)} mi` : `${trim(step)} ft`;
  if (unit === 'metre') return step >= 1000 ? `${trim(step / 1000)} km` : `${trim(step)} m`;
  return `${trim(step)} units`;
}

/** Drops the floating-point tail a power-of-ten division leaves behind. */
function trim(value: number): string {
  return String(Number(value.toPrecision(6)));
}

function computeBounds(data: PreviewData): Bounds | null {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const visit = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < bounds.minX) bounds.minX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y > bounds.maxY) bounds.maxY = y;
  };

  const walk = (node: any): void => {
    if (Array.isArray(node) && typeof node[0] === 'number') {
      visit(node[0], node[1]);
      return;
    }
    if (Array.isArray(node)) for (const child of node) walk(child);
  };

  for (const layer of data.layers) {
    for (const feature of layer.features) {
      if (feature.geometry?.type === 'GeometryCollection') {
        for (const child of feature.geometry.geometries ?? []) walk(child.coordinates);
      } else {
        walk(feature.geometry?.coordinates);
      }
    }
  }
  if (data.cloud) {
    for (let index = 0; index < data.cloud.x.length; index++) visit(data.cloud.x[index], data.cloud.y[index]);
  }
  if (data.raster) {
    visit(data.raster.extent.minX, data.raster.extent.minY);
    visit(data.raster.extent.maxX, data.raster.extent.maxY);
  }
  // Overlay geometry counts towards the extent: a feature that exists only in
  // the output is not in this pane's layers, and fitting without it would put
  // the very difference the user opened the pane for outside the view.
  for (const item of data.overlay ?? []) {
    if (item.geometry?.type === 'GeometryCollection') {
      for (const child of item.geometry.geometries ?? []) walk(child.coordinates);
    } else {
      walk(item.geometry?.coordinates);
    }
  }

  return Number.isFinite(bounds.minX) ? bounds : null;
}

/** Distinct layer colours, cycled. Chosen to stay legible on both themes. */
export const LAYER_COLORS = ['#10b9a8', '#f5b041', '#58a6ff', '#e06c9f', '#8fce6b', '#c792ea', '#ff9f6b', '#6bd4d0'];
