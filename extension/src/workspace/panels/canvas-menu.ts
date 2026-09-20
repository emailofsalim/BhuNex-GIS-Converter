/**
 * The canvas's own right-click menu, and double-click to select.
 *
 * WHY THESE TWO TOGETHER
 *
 * Both answer the same complaint: reaching a tool cost more than using it. To
 * select one parcel you had to find the Home tab, arm Select, then click —
 * three actions to do the thing every drawing program does on a click. And a
 * right-click on the drawing did nothing at all, which on a canvas is a wasted
 * button: it is where a CAD user's hand goes for the tool they want next.
 *
 * So:
 *   · DOUBLE-CLICK anywhere selects whatever is under the pointer, arming the
 *     Select tool on the way, from any tool including plain Pan.
 *   · RIGHT-CLICK opens a short menu of what is worth doing here, built from
 *     what is actually under the pointer and what is already selected.
 *
 * WHY THE MENU IS NOT A SECOND TOOLBAR
 *
 * It would be easy to list every tool here, and that would make it a worse
 * ribbon reachable by a different gesture. A context menu earns its place by
 * being SHORT and about the thing under the cursor. Tools that need no context
 * (Pan, Fit, Grid) are one row of the ribbon away and one key away; what goes
 * here is what depends on WHERE you clicked.
 *
 * WHY RIGHT-DRAG STILL WINS
 *
 * `ToolCanvas` uses a right-DRAG as the always-a-window rubber band, so the
 * menu must never appear mid-band. It is therefore driven from two places that
 * both know a drag did not happen: `ToolCanvas`'s own bare-right-click path
 * while a tool is armed, and the plain `contextmenu` event when no tool is —
 * which is Pan, where there is no band to conflict with.
 */

import { hitTest } from '../../core/selection';
import { store } from '../../state/store';
import { element } from '../dom';
import { host } from '../host';
import { ui } from '../ui-state';
import { PICK_RADIUS_PX } from '../../ui/edit-canvas';
import { setCanvasTool } from './toolbar';
import { openForVertexEdit } from './edit-tab';
import { zoomToSelection } from './select-tab';

/** One row of the menu. A separator is an entry with no label. */
interface MenuEntry {
  label?: string;
  hint?: string;
  run?: () => void;
  disabled?: boolean;
}

let open: HTMLElement | null = null;

/**
 * How the open menu is taken down, INCLUDING its window listeners.
 *
 * Teardown used to live inside `dismiss`, which never runs when the menu is
 * closed any other way — and the commonest way by far is clicking one of its
 * own items. So every use of the menu left a `pointerdown` and a `keydown`
 * capture listener on `window` for good, each pinning the detached menu it
 * closed over.
 *
 * The leak was the smaller half: on the next open, a click inside the NEW menu
 * was not inside the OLD one that the stale handler still referenced, so the
 * stale handler closed the new menu out from under the click.
 */
let teardown: (() => void) | null = null;

/** Takes the menu down, if one is up. Safe to call at any time. */
export function closeCanvasMenu(): void {
  teardown?.();
  teardown = null;
  open?.remove();
  open = null;
}

/**
 * What is under this world position, using the same hit test the tools use.
 *
 * Shared deliberately: a menu that offered "Edit these vertices" for a feature
 * the Vertex tool would not open is a menu that lies about what the next click
 * will do.
 */
function featureUnder(world: { x: number; y: number }): { layer: string; index: number; geometry: unknown } | null {
  const item = store.selected();
  if (!item?.dataset) return null;
  const layers = (item.dataset.layers ?? []).map((layer: any) => ({
    name: layer.name,
    visible: layer.visible !== false,
    features: layer.preview ?? [],
  }));
  if (layers.length === 0) return null;

  const scale = ui.previewCanvas?.getView().scale ?? 1;
  const tolerance = PICK_RADIUS_PX / (Number.isFinite(scale) && scale > 0 ? scale : 1);
  const hit = hitTest(layers as never, [world.x, world.y], tolerance);
  if (!hit) return null;
  const layer = layers.find((candidate: any) => candidate.name === hit.ref.layer);
  return { layer: hit.ref.layer, index: hit.ref.index, geometry: (layer?.features ?? [])[hit.ref.index]?.geometry };
}

/** Selects one feature, replacing whatever was selected. */
function selectOnly(layer: string, index: number): void {
  ui.featureSelection = { refs: [{ layer, index }], wholeLayers: [] };
}

/**
 * Selects whatever is under the pointer, arming Select on the way.
 *
 * Returns true when something was hit, so the caller can leave the event alone
 * when the user double-clicked empty space — a miss should not steal the
 * gesture from whatever else might want it.
 */
export function selectFeatureAt(world: { x: number; y: number }): boolean {
  const hit = featureUnder(world);
  if (!hit) return false;
  selectOnly(hit.layer, hit.index);
  // Arming Select is what makes the NEXT action work: having selected by
  // double-click, a drag should move the selection rather than pan away from
  // it. `setCanvasTool` renders, so nothing else has to.
  setCanvasTool('select');
  return true;
}

/**
 * The rows for a click at this position.
 *
 * Built fresh each time rather than kept as a static list: every entry here is
 * about the feature under the cursor or the current selection, so a cached menu
 * would describe the last place it was opened.
 */
function entriesFor(world: { x: number; y: number }): MenuEntry[] {
  const hit = featureUnder(world);
  const selection = ui.featureSelection;
  const count = (selection?.refs?.length ?? 0) + (selection?.wholeLayers?.length ?? 0);
  const entries: MenuEntry[] = [];

  if (hit) {
    entries.push({
      label: `Select ${hit.layer} #${hit.index}`,
      hint: 'Also a double-click, anywhere, from any tool.',
      run: () => {
        selectOnly(hit.layer, hit.index);
        setCanvasTool('select');
      },
    });
    entries.push({
      label: 'Edit its vertices',
      hint: 'Opens this feature in the vertex editor.',
      run: () => {
        setCanvasTool('vertex');
        if (!openForVertexEdit(hit.layer, hit.index, hit.geometry)) {
          store.log('warn', `${hit.layer}: a point or a geometry collection has no vertices to edit.`);
        }
        ui.openPanel?.('edit', 'edit');
        host.render();
      },
    });
    entries.push({
      label: 'What is this?',
      hint: 'Area, perimeter and vertex count, with the method stated.',
      run: () => {
        selectOnly(hit.layer, hit.index);
        setCanvasTool('info');
        ui.openPanel?.('edit', 'select');
      },
    });
  } else {
    entries.push({ label: 'Nothing under the pointer', disabled: true });
  }

  entries.push({});

  entries.push({
    label: 'Zoom to selection',
    disabled: count === 0,
    hint: 'Fills the canvas with what is selected.',
    run: () => zoomToSelection(),
  });
  entries.push({
    label: `Clear selection${count > 0 ? ` (${count})` : ''}`,
    disabled: count === 0,
    run: () => {
      ui.featureSelection = { refs: [], wholeLayers: [] };
      host.render();
    },
  });

  entries.push({});
  entries.push({
    label: 'Zoom to fit everything',
    hint: 'F',
    run: () => {
      ui.previewCanvas?.fit();
      ui.previewCanvas?.render();
    },
  });

  return entries;
}

/**
 * Shows the menu at a point on the page.
 *
 * `screenX`/`screenY` are viewport coordinates — the menu is positioned
 * `fixed`, so it does not inherit the canvas's transform and cannot be clipped
 * by the stage's `overflow: hidden`.
 */
export function openCanvasMenu(screenX: number, screenY: number, world: { x: number; y: number }): void {
  closeCanvasMenu();
  if (!store.selected()) return;

  const menu = element('div', { class: 'cmenu', role: 'menu' });
  for (const entry of entriesFor(world)) {
    if (!entry.label) {
      menu.append(element('div', { class: 'cmenu__sep' }));
      continue;
    }
    const row = element('button', {
      class: 'cmenu__item',
      type: 'button',
      title: entry.hint ?? '',
    }) as HTMLButtonElement;
    row.textContent = entry.label;
    row.disabled = entry.disabled === true || !entry.run;
    row.setAttribute('role', 'menuitem');
    row.addEventListener('click', () => {
      closeCanvasMenu();
      entry.run?.();
    });
    menu.append(row);
  }

  document.body.append(menu);
  open = menu;

  // Placed after it is in the DOM, because until then it has no size and would
  // be flipped against the wrong measurements at the edges of the window.
  const box = menu.getBoundingClientRect();
  const left = Math.min(screenX, window.innerWidth - box.width - 8);
  const top = Math.min(screenY, window.innerHeight - box.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  // Dismissal. `capture` so a click on any control still closes the menu
  // before that control runs. Removal is registered as `teardown` rather than
  // done inside the handler, so closing by a menu-item click takes the
  // listeners with it — see `teardown` above.
  const dismiss = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
    if (event.type === 'pointerdown' && menu.contains(event.target as Node)) return;
    closeCanvasMenu();
  };
  window.addEventListener('pointerdown', dismiss, true);
  window.addEventListener('keydown', dismiss, true);
  teardown = () => {
    window.removeEventListener('pointerdown', dismiss, true);
    window.removeEventListener('keydown', dismiss, true);
  };
}

/**
 * Wires both gestures onto the canvas. Called once, at boot.
 *
 * Both listeners sit on the canvas element rather than inside a tool, because
 * the whole point is that they work whichever tool is armed — including Pan,
 * where every tool engine is switched off.
 */
export function installCanvasGestures(canvas: HTMLElement): void {
  canvas.addEventListener('dblclick', (event) => {
    // A double-click that ENDS a drawing belongs to the drawing, and one while
    // the vertex editor is armed belongs to the editor — it already opens a
    // feature on a single click, so stealing the second one would re-open what
    // is already open.
    if (ui.toolCanvas?.isDrawing()) return;
    if (ui.editCanvas?.isEnabled()) return;
    const world = ui.previewCanvas?.unproject(event.offsetX, event.offsetY);
    if (!world) return;
    if (selectFeatureAt(world)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  canvas.addEventListener(
    'contextmenu',
    (event) => {
      // While a tool is armed `ToolCanvas` owns the right button: it draws the
      // always-a-window band, and calls back here itself when the press turned
      // out not to be a drag. Handling the event here as well would pop the
      // menu at the START of every band.
      if (ui.toolCanvas?.isEnabled()) return;
      event.preventDefault();
      const world = ui.previewCanvas?.unproject(
        (event as MouseEvent).offsetX,
        (event as MouseEvent).offsetY
      );
      if (world) openCanvasMenu(event.clientX, event.clientY, world);
    },
    { capture: false }
  );
}
