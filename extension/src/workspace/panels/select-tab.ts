/**
 * The Select & move tab — the shift-correction workflow, end to end.
 *
 * This is where phases A, B and C of docs/EDITING_WORKSTATION.md meet. The
 * owner's request in one sentence:
 *
 *   "we observed that there is a shift so we will get there option like select
 *    multiple geometry which need to shift then simply drag or pan all that
 *    geometry to the position with the help of map tile and then we can easily
 *    export"
 *
 * So: turn the basemap on, see the offset, select what is wrong, drag it right,
 * and the correction goes out with the file.
 *
 * ---------------------------------------------------------------------------
 * WHY A DRAG BECOMES ONE COMMAND PER LAYER
 *
 * `planGeometryOperation` operates on ONE layer, and a selection can span
 * several. A drag across three layers therefore becomes three translate
 * commands with the same offset — not one command that quietly picks a layer
 * and moves only that. Three entries in the history is the honest record: each
 * one names its layer, each one can be undone, and a layer that refuses (it is
 * locked, or protected) refuses visibly rather than taking the other two down
 * with it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PANEL KEEPS SAYING WHAT A SHIFT MIGHT MEAN
 *
 * A survey that does not line up with OpenStreetMap has three possible causes
 * and dragging fixes exactly one of them. The tool cannot tell them apart, and
 * a user who drags a correct survey onto an imprecise basemap has broken it in
 * a way no later check will catch. So the warning sits next to the control,
 * every time, rather than in documentation nobody reads mid-task.
 */

import type { Position } from '../../core/cir';
import { isLocked, isVisible } from '../../core/layers';
import {
  EMPTY_SELECTION,
  type SelectableLayer,
  type Selection,
  describeSelection,
  scopeFor,
  selectedLayers,
  selectionBounds,
  toggleWholeLayer,
  truncationWarnings,
} from '../../core/selection';
import { crsLabel } from '../../crs/transform';
import { measureGeometry, METHOD_LABEL } from '../../core/measure';
import { type QueueItem, store } from '../../state/store';
import { planGeometryOperation } from '../../core/geometry-ops';
import { type CanvasTool, TOOL_HINT, TOOL_LABEL, ToolCanvas } from '../../ui/tool-canvas';
import { element, formatValue, ghostButton, keyValues, messageBlock } from '../dom';
import { host } from '../host';
import { datasetForTools, protectedFor, viewOf } from './dataset';
import { pendingEditsPanel, queueEdit } from './edits';
import { ui } from '../ui-state';

/** The tools, in the order a hand reaches for them. */
const TOOLS: CanvasTool[] = ['select', 'lasso', 'move'];

export function selectTab(item: QueueItem): HTMLElement[] {
  const layers = selectableLayers(item);
  if (layers.length === 0) {
    return [element('p', { class: 'muted', style: 'padding:16px', text: 'This file has no vector layers to select from.' })];
  }

  const nodes: HTMLElement[] = [];
  const wrap = element('div', { class: 'stack', style: 'padding:12px' });
  const selection = ui.featureSelection;

  // --- tools --------------------------------------------------------------
  const bar = element('div', { class: 'toolbar' });
  for (const tool of TOOLS) {
    const active = ui.toolCanvas?.getTool() === tool;
    const button = element('button', {
      class: `btn btn--sm${active ? ' btn--on' : ''}`,
      type: 'button',
      text: TOOL_LABEL[tool],
      title: TOOL_HINT[tool],
    });
    button.addEventListener('click', () => {
      ui.toolCanvas?.setTool(tool);
      host.renderInspector();
    });
    bar.append(button);
  }
  wrap.append(bar);
  wrap.append(element('p', { class: 'small faint', text: TOOL_HINT[ui.toolCanvas?.getTool() ?? 'select'] }));

  // --- what is selected ---------------------------------------------------
  const summary = element('div', { class: 'section' });
  summary.append(element('h3', { class: 'section__title', text: 'Selection' }));
  summary.append(element('p', { class: 'small', text: describeSelection(selection, layers) }));

  const actions = element('div', { class: 'row' });
  actions.append(
    ghostButton('Clear', () => {
      setSelection(EMPTY_SELECTION);
    })
  );
  actions.append(
    ghostButton('Zoom to selection', () => {
      const bounds = selectionBounds(selection, layers);
      if (!bounds) {
        store.log('warn', 'Nothing is selected, so there is nothing to zoom to.');
        host.render();
        return;
      }
      ui.previewCanvas?.setView({
        // A little wider than the selection itself, so its edges are visible
        // rather than flush against the frame.
        scale: viewScaleFor(bounds),
        centreX: (bounds.minX + bounds.maxX) / 2,
        centreY: (bounds.minY + bounds.maxY) / 2,
      });
    })
  );
  summary.append(actions);
  wrap.append(summary);

  // --- what the clicked feature IS (phase E) -------------------------------
  const info = featureInfo(item, selection);
  if (info) wrap.append(info);

  for (const warning of truncationWarnings(selection, layers)) {
    wrap.append(messageBlock('warn', 'Part of a layer cannot be reached by hand.', warning, 'Take the whole layer below if you meant all of it.'));
  }

  // --- whole layers -------------------------------------------------------
  const whole = element('div', { class: 'section' });
  whole.append(element('h3', { class: 'section__title', text: 'Take a whole layer' }));
  whole.append(
    element('p', {
      class: 'small faint',
      text: 'A whole layer covers every feature, including the ones the canvas did not draw. A canvas gesture can only reach what is drawn.',
    })
  );
  for (const layer of layers) {
    const line = element('label', { class: 'check' });
    const box = element('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = selection.wholeLayers.includes(layer.name);
    box.disabled = layer.locked === true;
    box.addEventListener('change', () => setSelection(toggleWholeLayer(ui.featureSelection, layer.name)));
    line.append(box);
    line.append(
      element('span', {
        text: `${layer.name} — ${(layer.featureCount ?? layer.features.length).toLocaleString()} features${layer.locked ? ' (locked)' : ''}${layer.visible === false ? ' (hidden)' : ''}`,
      })
    );
    whole.append(line);
  }
  wrap.append(whole);

  // --- the shift warning, next to the control that causes it --------------
  wrap.append(
    messageBlock(
      'info',
      'A shift against a basemap has three possible causes, and dragging fixes one.',
      'A wrong or missing datum shift — fix the CRS instead. An old local grid with no relationship to WGS 84 — dragging is right. Or a basemap that is simply imprecise — the survey is right and moving it makes it wrong.',
      'Whatever you apply is recorded with its offset, so the decision can be checked later.'
    )
  );

  const crs = item.dataset?.crs ?? null;
  wrap.append(
    element('p', {
      class: 'small faint',
      text: crs
        ? `Offsets are in the units of ${crsLabel(crs)}.`
        : 'This dataset declares no CRS, so a distance dragged here has no stated unit. Set one in the CRS tab.',
    })
  );

  nodes.push(wrap);
  if ((item.edits ?? []).length > 0) nodes.push(pendingEditsPanel(item, item.edits ?? []));
  return nodes;
}

/**
 * What one clicked feature is: its area, its perimeter, its vertex count.
 *
 * Phase E. Every number here comes from `core/measure.ts`, which picks geodesic
 * or planar arithmetic from the CRS and SAYS WHICH — the same engine the
 * measuring tool and the vertex readout use. A second area calculation living
 * in a panel is how two parts of one tool come to disagree about the same
 * parcel, and the one the user believes is whichever they saw last.
 *
 * Shown only for a single feature. An aggregate over a selection would be a
 * different measurement with the same name: the "area" of forty parcels is
 * their sum only if none of them overlap, and this cannot know that.
 */
function featureInfo(item: QueueItem, selection: Selection): HTMLElement | null {
  if (selection.wholeLayers.length > 0 || selection.refs.length !== 1) return null;

  const ref = selection.refs[0];
  const layer = ((item.dataset?.layers ?? []) as any[]).find((candidate) => candidate.name === ref.layer);
  const feature = (layer?.preview ?? [])[ref.index];
  if (!feature) return null;

  const measured = measureGeometry(feature.geometry ?? null, {
    crs: item.dataset?.crs ?? null,
    units: item.dataset?.units ?? null,
  });

  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'This feature' }));

  const rows: [string, string][] = [
    ['Layer', ref.layer],
    ['Geometry', feature.geometry?.type ?? 'none'],
  ];
  if (feature.id !== undefined) rows.push(['Id', String(feature.id)]);
  if (measured.area) rows.push(['Area', measured.area.text]);
  if (measured.perimeter) rows.push(['Perimeter', measured.perimeter.text]);
  if (measured.length) rows.push(['Length', measured.length.text]);
  rows.push(['Vertices', measured.vertices.toLocaleString()]);
  section.append(keyValues(rows));

  // The method, always. A planar area on an undeclared CRS is a number in
  // unknown units, and it looks exactly like a correct one.
  section.append(element('p', { class: 'small faint', style: 'margin-top:6px', text: METHOD_LABEL[measured.method] }));

  const properties = Object.entries(feature.properties ?? {});
  if (properties.length > 0) {
    const attributes = element('details', { class: 'small', style: 'margin-top:8px' });
    attributes.append(element('summary', { text: `${properties.length} attribute${properties.length === 1 ? '' : 's'}` }));
    attributes.append(keyValues(properties.map(([key, value]) => [key, formatValue(value)] as [string, string])));
    section.append(attributes);
  }

  return section;
}

/**
 * Creates the tool layer the first time the tab is opened, and re-claims the
 * canvas's single overlay hook on every render.
 */
export function renderSelect(item: QueueItem): void {
  if (!ui.previewCanvas) return;

  if (!ui.toolCanvas) {
    ui.toolCanvas = new ToolCanvas(ui.previewCanvas, {
      layers: () => {
        const current = store.selected();
        return current ? selectableLayers(current) : [];
      },
      selection: () => ui.featureSelection,
      onSelectionChange: (selection) => {
        ui.featureSelection = selection;
        host.renderInspector();
      },
      onMove: (selection, offset) => commitMove(selection, offset),
      onStatus: (text) => {
        const readout = document.getElementById('selectStatus');
        if (readout) readout.textContent = text;
      },
      onToolChange: () => host.renderInspector(),
    });
  }

  void item;
  ui.toolCanvas.reattach();
  ui.toolCanvas.setEnabled(true);
}

/**
 * Turns a completed drag into replayable translate commands.
 *
 * One per layer, as the header explains. A zero-length move is discarded rather
 * than recorded: a drag that snapped back to where it started is not an edit,
 * and an undo history full of no-ops makes the real entries hard to find.
 */
function commitMove(selection: Selection, offset: { dx: number; dy: number }): void {
  const item = store.selected();
  if (!item) return;

  if (offset.dx === 0 && offset.dy === 0) return;

  const names = selectedLayers(selection);
  if (names.length === 0) {
    store.log('warn', 'Nothing was selected, so nothing moved.');
    host.render();
    return;
  }

  const data = datasetForTools(item);
  const protectedLayers = protectedFor(item);
  let applied = 0;

  for (const layer of names) {
    const scope = scopeFor(selection, layer);
    if (scope === null) continue;

    const options = { offset: [offset.dx, offset.dy] as [number, number], ...(scope ? { scope } : {}) };
    const plan = planGeometryOperation(data, layer, 'translate', {
      ...options,
      protectedLayers,
      crs: item.dataset?.crs ?? null,
    });

    if (plan.refusal) {
      store.log('warn', `${layer}: ${plan.refusal.what} ${plan.refusal.why} ${plan.refusal.action}`);
      continue;
    }

    // Each command is queued against the item as the store now holds it, so a
    // second layer's plan is computed against the first layer's result rather
    // than against a stale copy.
    const current = store.selected();
    if (!current) return;
    queueEdit(
      current,
      { kind: 'geometry', layer, operation: 'translate', options },
      plan,
      `Move ${layer} by ${offset.dx.toFixed(3)}, ${offset.dy.toFixed(3)}`
    );
    applied += 1;
  }

  if (applied === 0) {
    host.render();
    return;
  }
  store.log(
    'ok',
    `Moved ${applied} layer${applied === 1 ? '' : 's'} by ${offset.dx.toFixed(3)}, ${offset.dy.toFixed(3)}. ` +
      'The offset is recorded and re-applied to every feature when you convert.'
  );
  host.render();
}

/**
 * The layers as the canvas draws them, carrying lock and visibility.
 *
 * Both matter to selection, not only to drawing: a hidden layer cannot be
 * clicked because the user cannot see what they would be picking, and a locked
 * one cannot be selected because every edit would refuse anyway — and a
 * selection that cannot be acted on is worse than no selection, since it looks
 * like the tool is working.
 */
export function selectableLayers(item: QueueItem): SelectableLayer[] {
  const view = viewOf(item);
  const protectedNames = new Set(store.get().settings.protectedLayers ?? []);
  return ((item.dataset?.layers ?? []) as any[]).map((layer) => ({
    name: layer.name,
    features: layer.preview ?? [],
    truncated: layer.previewTruncated === true,
    featureCount: layer.featureCount ?? (layer.preview ?? []).length,
    locked: isLocked(view, layer.name) || protectedNames.has(layer.name),
    visible: isVisible(view, layer.name),
  }));
}

function setSelection(selection: Selection): void {
  ui.featureSelection = selection;
  host.render();
}

/** A scale that fits the bounds with a margin, for zoom-to-selection. */
function viewScaleFor(bounds: { minX: number; minY: number; maxX: number; maxY: number }): number {
  const element = document.getElementById('previewCanvas');
  const width = element?.clientWidth || 800;
  const height = element?.clientHeight || 400;
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-9);
  return Math.min((width - 80) / spanX, (height - 80) / spanY);
}

/** The status line the tool writes into while a gesture is in progress. */
export function selectStatusBar(): HTMLElement {
  return element('div', { class: 'toolbar__status', id: 'selectStatus', text: 'Nothing selected' });
}

/** Exported for the tests: the anchor a transform would use by default. */
export function defaultAnchor(selection: Selection, layers: SelectableLayer[]): Position | null {
  const bounds = selectionBounds(selection, layers);
  return bounds ? [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2] : null;
}
