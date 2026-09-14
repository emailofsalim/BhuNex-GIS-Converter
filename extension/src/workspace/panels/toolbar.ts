/**
 * One toolbar, every canvas tool, one source of truth.
 *
 * WHY THIS EXISTS
 *
 * Every tool named here was already built and already worked. `ToolCanvas` has
 * had select, lasso, move and five drawing tools since phase F; `EditCanvas`
 * has had vertex editing since phase C; `MeasureCanvas` has measured since
 * §26.1; ortho has answered F8 the whole time. None of it was reachable from
 * the canvas.
 *
 * To draw a polyline you had to open the right-hand dock, choose the Edit
 * group, choose the "Select & move" tab, scroll to a drawing section and pick a
 * kind there — four clicks away from the canvas you were drawing on. Measuring
 * was worse: `updateMeasureBar` hid its bar unless `inspectorTab === 'preview'`,
 * and the `preview` tab had been deleted, so the bar was shown by one line of
 * code and hidden again by the next. The measure tool could not be switched on
 * at all.
 *
 * That is the same defect this project keeps producing — a correct engine with
 * nothing wired to it — so the fix is structural rather than another button.
 * The canvas tool is now STORE STATE, not a side effect of which dock tab is
 * open, and this file is the only place that knows the list.
 *
 * ONE LIST, TWO CONSUMERS
 *
 * `CANVAS_TOOLS` drives the toolbar AND the shortcut table in Help. A shortcut
 * documented in Help that does nothing, or a tool with a key nobody can find,
 * is exactly the kind of confident-but-false claim the honesty rules exist to
 * prevent — so neither is written twice.
 */

import { element } from '../dom';
import { host } from '../host';
import { store } from '../../state/store';
import { ui } from '../ui-state';

/**
 * What the canvas is currently doing.
 *
 * `pan` is the resting state: no tool owns the pointer, so a drag pans and a
 * click selects nothing. It is deliberately distinct from `select` — a
 * surveyor panning around a drawing should not be able to move a parcel by
 * accident.
 */
export type CanvasToolId =
  | 'pan'
  | 'select'
  | 'lasso'
  | 'move'
  | 'vertex'
  | 'draw-point'
  | 'draw-marker'
  | 'draw-line'
  | 'draw-polygon'
  | 'draw-text'
  | 'measure-distance'
  | 'measure-area'
  | 'info'
  | 'georef';

export interface CanvasToolDef {
  id: CanvasToolId;
  /** The label on the button. Short: eighteen of these share one line. */
  label: string;
  /** The single key that selects it, shown in Help and in the button title. */
  key: string;
  /** What it does, in the tooltip and in Help. */
  hint: string;
  /** Buttons are separated into groups by a hairline. */
  group: 'select' | 'draw' | 'measure' | 'place';
}

/**
 * Every tool, in the order they appear.
 *
 * The keys are single letters chosen so the common ones are reachable without
 * moving the hand: V/L/M/E for the selection family, then P/N/G/T/K for the
 * drawing family. They deliberately avoid F8 (ortho) and Escape (cancel),
 * which `ToolCanvas` already owns and which a surveyor's hand already knows.
 */
export const CANVAS_TOOLS: CanvasToolDef[] = [
  { id: 'pan', label: 'Pan', key: 'H', hint: 'Drag to pan, wheel to zoom. No tool is live, so nothing can be selected or moved by accident.', group: 'select' },
  { id: 'select', label: 'Select', key: 'V', hint: 'Click a feature, or drag from empty space for a rubber band. Drag a selected feature to move it.', group: 'select' },
  { id: 'lasso', label: 'Lasso', key: 'L', hint: 'Draw a freehand outline around everything to select.', group: 'select' },
  { id: 'move', label: 'Move', key: 'M', hint: 'Drag anywhere to move the whole current selection.', group: 'select' },
  { id: 'vertex', label: 'Vertex', key: 'E', hint: 'Drag a vertex to move it, double-click a segment to insert one, Delete to remove one.', group: 'select' },
  { id: 'draw-point', label: 'Point', key: 'P', hint: 'Click to place a single point.', group: 'draw' },
  { id: 'draw-line', label: 'Polyline', key: 'N', hint: 'Click each vertex; double-click or Enter to finish. Shift or F8 constrains to one axis.', group: 'draw' },
  { id: 'draw-polygon', label: 'Polygon', key: 'G', hint: 'Click each vertex; double-click or Enter to close the ring.', group: 'draw' },
  { id: 'draw-text', label: 'Text', key: 'T', hint: 'Click to place a labelled point.', group: 'draw' },
  { id: 'draw-marker', label: 'Marker', key: 'K', hint: 'Click to drop a marker point.', group: 'draw' },
  { id: 'measure-distance', label: 'Distance', key: 'D', hint: 'Click along a run of legs to measure length. Geodesic or planar is chosen from the CRS.', group: 'measure' },
  { id: 'measure-area', label: 'Area', key: 'A', hint: 'Click around an enclosed shape to measure its area.', group: 'measure' },
  { id: 'info', label: 'Info', key: 'I', hint: 'Click a feature for its area, perimeter, vertex count and attributes.', group: 'measure' },
  // 'W' for world coordinates. Every letter with a better mnemonic — G for
  // georeference, P for place — was already a drawing tool, and moving one of
  // those to free up a letter would break muscle memory for a daily gesture to
  // help an occasional one.
  { id: 'georef', label: 'Georef', key: 'W', hint: 'Place a drawing that has no coordinate system: drag to move, Shift+drag to rotate, Alt+drag to scale, or fit it to control points.', group: 'place' },
];

/** Actions that are not tools but share the bar and the shortcut table. */
export interface CanvasActionDef {
  id: string;
  label: string;
  key: string;
  hint: string;
}

export const CANVAS_ACTIONS: CanvasActionDef[] = [
  { id: 'fit', label: 'Fit', key: 'F', hint: 'Zoom to the extent of everything loaded.' },
  { id: 'grid', label: 'Grid', key: 'R', hint: 'Show or hide the reference grid.' },
  { id: 'snap', label: 'Snap', key: 'S', hint: 'Snap new geometry to existing vertices, midpoints and segments.' },
  { id: 'ortho', label: 'Ortho', key: 'F8', hint: 'Constrain new segments to one axis, as F8 does in AutoCAD. Shift does it for one segment.' },
  { id: 'undo', label: 'Undo', key: 'Ctrl+Z', hint: 'Take back the last edit.' },
  { id: 'redo', label: 'Redo', key: 'Ctrl+Shift+Z', hint: 'Reapply the edit that was taken back.' },
];

/** Shortcuts that belong to the workspace rather than to the canvas. */
export const GLOBAL_SHORTCUTS: CanvasActionDef[] = [
  { id: 'open', label: 'Add files', key: 'Ctrl+O', hint: 'Open the file picker.' },
  { id: 'convert', label: 'Convert', key: 'Ctrl+Enter', hint: 'Convert the selected file to the chosen output format.' },
  { id: 'palette', label: 'Command palette', key: 'Ctrl+K', hint: 'Search every command by name.' },
  { id: 'rail', label: 'Left panel', key: 'Ctrl+1', hint: 'Show or hide files and layers.' },
  { id: 'dock', label: 'Right panel', key: 'Ctrl+2', hint: 'Show or hide the output panel.' },
  { id: 'cancel', label: 'Cancel', key: 'Esc', hint: 'Cancel the drawing in progress, then clear the selection, then return to Pan.' },
  { id: 'finish', label: 'Finish drawing', key: 'Enter', hint: 'Close the polyline or polygon being drawn.' },
];

/**
 * THE RIBBON.
 *
 * Twenty buttons on one line is a wall, and the six editing PANELS that belong
 * with them were a floor away in the right dock — so arming Vertex and then
 * reaching its settings meant crossing the window and opening two levels of
 * tab. The tools and the panel that configures them are one thing and were in
 * two places.
 *
 * A tab here is therefore a tool FAMILY and its PANEL together: picking
 * Measure arms the measuring tools and opens the Measure panel in one click,
 * the way a Word ribbon tab brings its whole group forward. Only the current
 * tab's controls are on screen, so the bar stays one row whatever it holds.
 *
 * Order is the order of work: look at it, draw on it, change it, measure it,
 * put it somewhere real.
 */
export interface RibbonTab {
  id: string;
  label: string;
  /** What this tab is for, in its tooltip. */
  hint: string;
  /** Tools from CANVAS_TOOLS, by id, in the order they appear. */
  tools: CanvasToolId[];
  /** Action buttons from CANVAS_ACTIONS, by id. */
  actions: string[];
  /**
   * Dock sections this family owns, opened from the ribbon rather than hunted
   * for in the right-hand panel. `[group, tab]` as `ui.openPanel` takes them.
   */
  panels: { label: string; group: string; tab: string }[];
}

export const RIBBON_TABS: RibbonTab[] = [
  {
    id: 'home',
    label: 'Home',
    hint: 'Look at the drawing, and select what to work on.',
    tools: ['pan', 'select', 'lasso', 'move'],
    actions: ['fit', 'grid', 'undo', 'redo'],
    panels: [{ label: 'Selection…', group: 'edit', tab: 'select' }],
  },
  {
    id: 'draw',
    label: 'Draw',
    hint: 'Add new geometry, with snapping and orthogonal constraint.',
    tools: ['draw-point', 'draw-line', 'draw-polygon', 'draw-text', 'draw-marker'],
    actions: ['snap', 'ortho', 'undo', 'redo'],
    panels: [{ label: 'Drawing…', group: 'edit', tab: 'select' }],
  },
  {
    id: 'modify',
    label: 'Modify',
    hint: 'Change geometry that is already there.',
    tools: ['vertex'],
    actions: ['snap', 'ortho', 'undo', 'redo'],
    panels: [
      { label: 'Vertices…', group: 'edit', tab: 'edit' },
      { label: 'Geometry tools…', group: 'edit', tab: 'geometry-ops' },
    ],
  },
  {
    id: 'measure',
    label: 'Measure',
    hint: 'Distance, area, and what a feature actually is.',
    tools: ['measure-distance', 'measure-area', 'info'],
    actions: ['snap'],
    panels: [{ label: 'Measure…', group: 'edit', tab: 'measure' }],
  },
  {
    id: 'place',
    label: 'Place',
    hint: 'Put a local-grid drawing onto real coordinates.',
    tools: ['georef'],
    actions: ['fit'],
    panels: [
      { label: 'Georeference…', group: 'edit', tab: 'georef' },
      { label: 'Backdrop…', group: 'edit', tab: 'backdrop' },
    ],
  },
];

/** The ribbon tab a tool lives on, so a keyboard shortcut lights the right one. */
export function ribbonTabFor(id: CanvasToolId): string {
  return RIBBON_TABS.find((tab) => tab.tools.includes(id))?.id ?? 'home';
}

/** The tool a key selects, or null. Case-insensitive, single letters only. */
export function toolForKey(key: string): CanvasToolDef | null {
  const upper = key.toUpperCase();
  return CANVAS_TOOLS.find((tool) => tool.key === upper) ?? null;
}

/**
 * Switches the canvas to a tool, turning off whatever owned the pointer.
 *
 * Every engine is stopped before the new one starts. Two live at once is how a
 * click meant for a measurement lands a vertex instead — and because the
 * engines each hold the shared overlay hook, the last one to attach wins the
 * drawing as well.
 */
export function setCanvasTool(id: CanvasToolId): void {
  // The ribbon follows the tool, not only the other way round. Pressing E for
  // Vertex from the Draw tab has to bring Modify forward, or the bar would be
  // lit on a tab that does not contain the armed tool.
  ui.ribbonTab = ribbonTabFor(id);
  store.set({ canvasTool: id });
  // Georef is the one tool whose controls are not on the canvas: it cannot do
  // anything until it is told which coordinate system to place into. Opening
  // its panel with it is the difference between a tool and a lit button.
  if (id === 'georef') ui.openPanel?.('edit', 'georef');
  host.render();
}

/** Which engine a tool belongs to. Used to decide what to stop and what to start. */
export function engineOf(id: CanvasToolId): 'tool' | 'edit' | 'measure' | 'info' | 'georef' | 'none' {
  if (id === 'pan') return 'none';
  if (id === 'vertex') return 'edit';
  if (id === 'info') return 'info';
  if (id === 'georef') return 'georef';
  if (id.startsWith('measure-')) return 'measure';
  return 'tool';
}

/** Builds the one bar. Called on every render so the active tool stays lit. */
export function renderToolbar(into: HTMLElement, enabled: boolean): void {
  const state = store.get();
  const active = state.canvasTool ?? 'pan';
  into.replaceChildren();

  const button = (label: string, title: string, on: boolean, onClick: () => void, disabled = false): HTMLElement => {
    const node = element('button', {
      class: `btn btn--ghost btn--sm tbtn${on ? ' tbtn--on' : ''}`,
      title,
    }) as HTMLButtonElement;
    node.textContent = label;
    node.disabled = disabled || !enabled;
    node.addEventListener('click', onClick);
    return node;
  };

  const separator = () => element('span', { class: 'cbar__sep' });
  const item = store.selected();

  /** The action buttons, by id, so a tab can name the ones it wants. */
  const actionButton = (id: string): HTMLElement | null => {
    switch (id) {
      case 'fit':
        return button('Fit', 'Fit to extent (F)', false, () => {
          ui.previewCanvas?.fit();
          ui.previewCanvas?.render();
        });
      // `showGrid` is private to PreviewCanvas, so the canvas stays the owner of
      // whether the grid is drawn and `ui.gridOn` only mirrors it for the
      // button's lit state. Reading it back would need an accessor the canvas
      // does not owe anyone; toggling both in step is honest and costs nothing.
      case 'grid':
        return button('Grid', 'Show or hide the grid (R)', ui.gridOn !== false, () => {
          ui.previewCanvas?.toggleGrid();
          ui.gridOn = ui.gridOn === false;
          host.render();
        });
      case 'snap':
        return button('Snap', 'Snap new geometry to existing vertices, midpoints and segments (S)', ui.snapOn === true, () => {
          ui.snapOn = !ui.snapOn;
          host.render();
        });
      case 'ortho':
        return button('Ortho', 'Constrain new segments to one axis, as F8 does in AutoCAD (F8)', ui.orthoOn === true, () => {
          ui.orthoOn = !ui.orthoOn;
          ui.toolCanvas?.setOrtho(ui.orthoOn);
          host.render();
        });
      case 'undo': {
        const node = button('Undo', 'Take back the last edit (Ctrl+Z)', false, () => ui.undo?.(), (item?.edits?.length ?? 0) === 0);
        node.id = 'undoBtn';
        return node;
      }
      case 'redo': {
        const node = button('Redo', 'Reapply the edit that was taken back (Ctrl+Shift+Z)', false, () => ui.redo?.(), (state.redoStack?.length ?? 0) === 0);
        node.id = 'redoBtn';
        return node;
      }
      default:
        return null;
    }
  };

  // --- the tab strip ----------------------------------------------------
  // Always present, even with nothing loaded, so the shape of the tool does
  // not change under the user between an empty workspace and a loaded one.
  const tabs = element('div', { class: 'cbar__tabs', role: 'tablist' });
  const current = RIBBON_TABS.find((tab) => tab.id === ui.ribbonTab) ?? RIBBON_TABS[0];
  for (const tab of RIBBON_TABS) {
    const on = tab.id === current.id;
    const node = element('button', {
      class: `rtab${on ? ' rtab--on' : ''}`,
      title: tab.hint,
      type: 'button',
    }) as HTMLButtonElement;
    node.textContent = tab.label;
    node.setAttribute('role', 'tab');
    node.setAttribute('aria-selected', String(on));
    node.addEventListener('click', () => {
      ui.ribbonTab = tab.id;
      // A tab is the family AND its panel: bringing the group forward opens the
      // settings that belong to it, which is the whole reason these were merged
      // rather than left a window apart.
      const panel = tab.panels[0];
      if (panel && item) ui.openPanel?.(panel.group, panel.tab);
      host.render();
    });
    tabs.append(node);
  }
  into.append(tabs);

  // --- the current tab's controls ---------------------------------------
  const row = element('div', { class: 'cbar__row' });
  for (const id of current.tools) {
    const tool = CANVAS_TOOLS.find((each) => each.id === id);
    if (!tool) continue;
    row.append(button(tool.label, `${tool.hint} (${tool.key})`, active === tool.id, () => setCanvasTool(tool.id)));
  }
  if (current.tools.length && current.actions.length) row.append(separator());
  for (const id of current.actions) {
    const node = actionButton(id);
    if (node) row.append(node);
  }
  // The panels this family owns, reachable from the bar rather than from two
  // levels of tab in the right-hand dock.
  if (current.panels.length) {
    row.append(separator());
    for (const panel of current.panels) {
      row.append(
        button(panel.label, `Open the ${panel.label.replace(/…$/, '')} panel`, false, () => ui.openPanel?.(panel.group, panel.tab), !item)
      );
    }
  }
  into.append(row);
}
