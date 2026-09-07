/**
 * The dual canvas (spec §30.1).
 *
 * Source on the left, the converted output on the right — the actual converted
 * representation, read back from the bytes that were written, not a preview of
 * what the writer was asked to do. The spec puts the reason plainly:
 *
 *   "Nobody should have to export a file to discover that the conversion
 *    damaged it."
 *
 * ---------------------------------------------------------------------------
 * WHAT LINKING MEANS HERE
 *
 * Panning and zooming synchronise by default and can be unlinked. Linking
 * exchanges a world centre and a scale, never pixel offsets: the two panes are
 * different widths whenever the divider is off centre, and sharing offsets
 * would put the same parcel at two different places on screen and call that
 * synchronised.
 *
 * Linking is also the reason the two panes are only meaningfully comparable in
 * the same coordinate system. When the conversion reprojected, the output's
 * coordinates are not the source's, and a linked view would show the left pane
 * empty while the right one is full. The shell detects that from the extents
 * and UNLINKS ITSELF, saying why — rather than presenting an empty pane as
 * evidence that the data was lost.
 */

import { PreviewCanvas, type PreviewData, type ViewState } from './preview';

export type PaneSide = 'source' | 'output';

export interface DualCanvasOptions {
  /** Called with a coordinate readout from whichever pane the pointer is over. */
  onReadout?: (text: string, side: PaneSide) => void;
  /** Called when the shell unlinks itself, with the reason to show. */
  onAutoUnlink?: (reason: string) => void;
}

/**
 * Extents this far apart are not the same coordinate system.
 *
 * A conversion that reprojects UTM metres to degrees moves the numbers by five
 * orders of magnitude; one that rounds moves them by none. The threshold sits
 * between: ten times the larger span is far beyond any rounding, clipping or
 * repair, and well short of what a reprojection does.
 */
const UNLINK_RATIO = 10;

export class DualCanvas {
  readonly source: PreviewCanvas;
  readonly output: PreviewCanvas;
  private linked = true;
  private maximised: PaneSide | null = null;
  private readonly options: DualCanvasOptions;
  private readonly root: HTMLElement;
  private readonly sourcePane: HTMLElement;
  private readonly outputPane: HTMLElement;
  private readonly divider: HTMLElement;
  private split = 0.5;
  private dragging = false;
  private hasOutput = false;

  constructor(root: HTMLElement, options: DualCanvasOptions = {}) {
    this.root = root;
    this.options = options;
    this.root.replaceChildren();
    this.root.className = 'dual';

    const built = this.build();
    this.sourcePane = built.sourcePane;
    this.outputPane = built.outputPane;
    this.divider = built.divider;

    this.source = new PreviewCanvas(built.sourceCanvas, (text) => options.onReadout?.(text, 'source'));
    this.output = new PreviewCanvas(built.outputCanvas, (text) => options.onReadout?.(text, 'output'));

    this.source.onViewChange = (view) => this.mirror(view, this.output);
    this.output.onViewChange = (view) => this.mirror(view, this.source);

    this.attachDivider();
    this.applySplit();
  }

  private build(): {
    sourcePane: HTMLElement;
    outputPane: HTMLElement;
    divider: HTMLElement;
    sourceCanvas: HTMLCanvasElement;
    outputCanvas: HTMLCanvasElement;
  } {
    const makePane = (side: PaneSide, title: string) => {
      const pane = document.createElement('div');
      pane.className = `dual__pane dual__pane--${side}`;

      const head = document.createElement('div');
      head.className = 'dual__head';
      const label = document.createElement('span');
      label.className = 'dual__title';
      label.textContent = title;
      head.append(label);

      const status = document.createElement('span');
      status.className = 'dual__status';
      head.append(status);

      const maximise = document.createElement('button');
      maximise.type = 'button';
      maximise.className = 'dual__max';
      maximise.title = `Maximise the ${side} pane`;
      maximise.setAttribute('aria-label', `Maximise the ${side} pane`);
      maximise.textContent = '⤢';
      maximise.addEventListener('click', () => this.toggleMaximise(side));
      head.append(maximise);

      pane.append(head);

      const canvas = document.createElement('canvas');
      canvas.className = 'dual__canvas';
      pane.append(canvas);

      const empty = document.createElement('p');
      empty.className = 'dual__empty';
      empty.textContent = side === 'source' ? 'Select a file to see its geometry.' : 'Convert the file to see the output geometry.';
      pane.append(empty);

      return { pane, canvas, status, empty };
    };

    const source = makePane('source', 'Source');
    const output = makePane('output', 'Output');

    const divider = document.createElement('div');
    divider.className = 'dual__divider';
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'vertical');
    divider.setAttribute('aria-label', 'Resize the source and output panes');
    divider.tabIndex = 0;

    this.root.append(source.pane, divider, output.pane);

    return {
      sourcePane: source.pane,
      outputPane: output.pane,
      divider,
      sourceCanvas: source.canvas,
      outputCanvas: output.canvas,
    };
  }

  private attachDivider(): void {
    this.divider.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      this.divider.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    this.divider.addEventListener('pointerup', (event) => {
      this.dragging = false;
      this.divider.releasePointerCapture(event.pointerId);
    });
    this.divider.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      const rect = this.root.getBoundingClientRect();
      if (rect.width === 0) return;
      // Clamped so neither pane can be dragged to nothing: a pane of zero width
      // looks like a bug, and maximise is the deliberate way to get there.
      this.split = Math.min(0.85, Math.max(0.15, (event.clientX - rect.left) / rect.width));
      this.maximised = null;
      this.applySplit();
    });
    // Keyboard, because a divider that only responds to a pointer is a control
    // half the users of an accessibility-audited tool cannot reach.
    this.divider.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      if (event.key === 'ArrowLeft') this.split = Math.max(0.15, this.split - step);
      else if (event.key === 'ArrowRight') this.split = Math.min(0.85, this.split + step);
      else if (event.key === 'Home') this.split = 0.5;
      else return;
      event.preventDefault();
      this.maximised = null;
      this.applySplit();
    });
  }

  private applySplit(): void {
    if (this.maximised === 'source') {
      this.sourcePane.style.flex = '1 1 100%';
      this.outputPane.style.flex = '0 0 0';
      this.outputPane.classList.add('dual__pane--collapsed');
      this.sourcePane.classList.remove('dual__pane--collapsed');
      this.divider.classList.add('hidden');
      return;
    }
    if (this.maximised === 'output') {
      this.outputPane.style.flex = '1 1 100%';
      this.sourcePane.style.flex = '0 0 0';
      this.sourcePane.classList.add('dual__pane--collapsed');
      this.outputPane.classList.remove('dual__pane--collapsed');
      this.divider.classList.add('hidden');
      return;
    }

    this.divider.classList.remove('hidden');
    this.sourcePane.classList.remove('dual__pane--collapsed');
    this.outputPane.classList.remove('dual__pane--collapsed');
    this.sourcePane.style.flex = `1 1 ${this.split * 100}%`;
    this.outputPane.style.flex = `1 1 ${(1 - this.split) * 100}%`;
  }

  toggleMaximise(side: PaneSide): void {
    this.maximised = this.maximised === side ? null : side;
    this.applySplit();
  }

  isLinked(): boolean {
    return this.linked;
  }

  setLinked(linked: boolean): void {
    this.linked = linked;
    if (linked) this.mirror(this.source.getView(), this.output);
  }

  private mirror(view: ViewState, target: PreviewCanvas): void {
    if (!this.linked || !this.hasOutput) return;
    target.setView(view);
  }

  /**
   * Loads both sides.
   *
   * `output` may be null — before a conversion there is nothing to show on the
   * right, and an empty pane that says so is the correct thing to display.
   */
  setData(source: PreviewData, output: PreviewData | null): void {
    this.hasOutput = output !== null;
    this.source.setData(source);
    this.output.setData(output ?? { layers: [], truncated: false });

    this.sourcePane.classList.toggle('dual__pane--empty', source.layers.length === 0 && !source.cloud && !source.raster);
    this.outputPane.classList.toggle('dual__pane--empty', !this.hasOutput);

    if (this.hasOutput) this.checkComparable();
  }

  /**
   * Unlinks the panes when the two sides are not in the same coordinate system.
   *
   * Silently keeping them linked would show one pane empty, which reads as data
   * loss. This is the case where the right answer is to stop synchronising and
   * say why.
   */
  private checkComparable(): void {
    if (!this.linked) return;
    const left = this.source.extent();
    const right = this.output.extent();
    if (!left || !right) return;

    const leftSpan = Math.max(left.maxX - left.minX, left.maxY - left.minY, 1e-9);
    const rightSpan = Math.max(right.maxX - right.minX, right.maxY - right.minY, 1e-9);
    const separation = Math.max(
      Math.abs((left.minX + left.maxX) / 2 - (right.minX + right.maxX) / 2),
      Math.abs((left.minY + left.maxY) / 2 - (right.minY + right.maxY) / 2)
    );
    const span = Math.max(leftSpan, rightSpan);

    const scaleApart = leftSpan / rightSpan > UNLINK_RATIO || rightSpan / leftSpan > UNLINK_RATIO;
    const farApart = separation > span * UNLINK_RATIO;
    if (!scaleApart && !farApart) return;

    this.linked = false;
    this.source.fit();
    this.output.fit();
    this.options.onAutoUnlink?.(
      'The panes were unlinked: the output covers a different range of coordinates from the source, which is what a reprojection does. Each pane is fitted to its own data so both are visible.'
    );
  }

  fit(): void {
    this.source.fit();
    this.output.fit();
    if (this.linked && this.hasOutput) this.output.setView(this.source.getView());
  }

  toggleGrid(): void {
    this.source.toggleGrid();
    this.output.toggleGrid();
  }

  /** Sets the small status line in a pane's header. */
  setStatus(side: PaneSide, text: string): void {
    const pane = side === 'source' ? this.sourcePane : this.outputPane;
    const status = pane.querySelector('.dual__status');
    if (status) status.textContent = text;
  }

  dispose(): void {
    this.source.dispose();
    this.output.dispose();
  }
}
