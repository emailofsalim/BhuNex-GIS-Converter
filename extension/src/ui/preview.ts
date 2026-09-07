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
  /** True when what is drawn is a subset of what will be exported. */
  truncated: boolean;
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
    this.view.offsetX = width / 2 - view.centreX * view.scale;
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
        this.view.offsetX += (after.x - before.x) * this.view.scale;
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
    this.render();
  }

  setData(data: PreviewData): void {
    this.data = data;
    this.bounds = computeBounds(data);
    this.fit();
  }

  toggleGrid(): void {
    this.showGrid = !this.showGrid;
    this.render();
  }

  fit(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 400;
    if (!this.bounds || !Number.isFinite(this.bounds.minX)) {
      this.view = { scale: 1, offsetX: width / 2, offsetY: height / 2 };
      this.render();
      this.announceView();
      return;
    }
    const spanX = Math.max(this.bounds.maxX - this.bounds.minX, 1e-9);
    const spanY = Math.max(this.bounds.maxY - this.bounds.minY, 1e-9);
    const padding = 28;
    this.view.scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
    const centreX = (this.bounds.minX + this.bounds.maxX) / 2;
    const centreY = (this.bounds.minY + this.bounds.maxY) / 2;
    this.view.offsetX = width / 2 - centreX * this.view.scale;
    // Screen y grows downward while northing grows upward, hence the sign.
    this.view.offsetY = height / 2 + centreY * this.view.scale;
    this.render();
    this.announceView();
  }

  /** The data's own extent, so a linked pane can fit to the other's data. */
  extent(): Bounds | null {
    return this.bounds;
  }

  private toScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.view.scale + this.view.offsetX, y: this.view.offsetY - y * this.view.scale };
  }

  private toWorld(screenX: number, screenY: number): { x: number; y: number } {
    return { x: (screenX - this.view.offsetX) / this.view.scale, y: (this.view.offsetY - screenY) / this.view.scale };
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

    for (const layer of this.data.layers) {
      if (!layer.visible) continue;
      context.strokeStyle = layer.color;
      context.fillStyle = layer.color;
      context.lineWidth = 1.2;
      for (const feature of layer.features) this.drawGeometry(feature.geometry);
    }

    if (this.data.overlay?.length) this.drawOverlay();
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
    context.fillStyle = this.style('--text-faint');
    context.font = '10px ui-monospace, monospace';
    context.fillText(`grid ${formatStep(step)}`, 8, height - 8);
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
      context.globalAlpha = 0.14;
      context.fill();
      context.restore();
    }
    context.stroke();
  }
}

function formatStep(step: number): string {
  if (step >= 1000) return `${step / 1000} km`;
  if (step >= 1) return `${step} m`;
  return `${step}`;
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
