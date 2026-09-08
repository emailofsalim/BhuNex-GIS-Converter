/**
 * Measuring on the canvas (spec §26.1).
 *
 * ---------------------------------------------------------------------------
 * THE ONLY THING THIS PANEL DECIDES IS WHAT TO ASK
 *
 * Every number shown here comes from `core/measure.ts`, which chooses geodesic
 * or planar arithmetic from the dataset's CRS and reports WHICH IT USED in
 * `Measurement.method`. That method is printed alongside the number, always.
 *
 * The error it exists to prevent is the one a measuring tool is most likely to
 * commit: a degree of longitude is 111.3 km at the equator and 102.5 km at 23°N,
 * so treating degrees as a plane reports a length that is wrong by a factor
 * which grows with latitude — and looks entirely reasonable. Printing "Geodesic
 * on the ellipsoid" or "Planar — no CRS is declared, so these are raw
 * coordinate units" under the number is what makes it checkable.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY LEG IS LISTED
 *
 * The number an engineer checks against a plan is usually one leg, not the
 * sum. A tool that reports only the total forces them to re-measure each leg
 * to find the one that disagrees, which is the whole job again.
 */

import type { Position } from '../../core/cir';
import {
  bearing,
  distance,
  formatDms,
  formatQuadrant,
  METHOD_LABEL,
  pathLength,
  polygonArea,
  polygonPerimeter,
  type MeasureContext,
} from '../../core/measure';
import { crsLabel } from '../../crs/transform';
import { type QueueItem, store } from '../../state/store';
import { MeasureCanvas, type MeasureMode } from '../../ui/measure-canvas';
import { $, element } from '../dom';
import { ui } from '../ui-state';

/** The measured run. UI-local: it is a question being asked, not data. */
const run: { points: Position[]; closed: boolean } = { points: [], closed: false };

function contextFor(item: QueueItem | undefined): MeasureContext {
  return { crs: item?.dataset?.crs ?? null, units: item?.dataset?.units ?? null };
}

/**
 * Creates the measuring layer the first time the Preview tab is opened.
 *
 * It shares `PreviewCanvas.onOverlay` with the vertex editor and the geometry
 * planner, which is safe because only one of the three tabs is ever visible —
 * and each of them sets the hook on the render for its own tab.
 */
export function renderMeasure(item: QueueItem): void {
  if (!ui.previewCanvas) return;

  if (!ui.measureCanvas) {
    ui.measureCanvas = new MeasureCanvas(ui.previewCanvas, {
      onChange: (points, closed) => {
        run.points = points;
        run.closed = closed;
        updateMeasureBar(item);
      },
    });
  } else {
    // The overlay hook is shared, so it is re-claimed every time this tab draws.
    ui.previewCanvas.onOverlay = undefined;
    ui.measureCanvas.reattach();
  }

  updateMeasureBar(item);
}

/** Keeps the measure toolbar in step with the run and the mode. */
export function updateMeasureBar(item: QueueItem | undefined): void {
  const bar = $('measureBar');
  const mode = ui.measureCanvas?.getMode() ?? 'off';
  bar.classList.toggle('hidden', store.get().inspectorTab !== 'preview');

  for (const [id, value] of [
    ['measureDistance', 'distance'],
    ['measureArea', 'area'],
  ] as [string, MeasureMode][]) {
    $(id).classList.toggle('btn--on', mode === value);
  }

  const readout = $('measureReadout');
  readout.replaceChildren();
  if (mode === 'off') {
    readout.textContent = 'Choose Distance or Area, then click on the map.';
    return;
  }
  if (run.points.length < 2) {
    readout.textContent = run.points.length === 1 ? 'One point placed. Click the next.' : 'Click the first point.';
    return;
  }

  const context = contextFor(item);
  const parts: string[] = [];

  if (mode === 'distance') {
    const total = pathLength(run.points, context);
    parts.push(`Length ${total.text}`);

    const last = distance(run.points[run.points.length - 2], run.points[run.points.length - 1], context);
    const heading = bearing(run.points[run.points.length - 2], run.points[run.points.length - 1], context);
    parts.push(`last leg ${last.text} at ${formatDms(heading.value)} (${formatQuadrant(heading.value)})`);
    if (run.points.length > 2) parts.push(`${run.points.length - 1} legs`);
  } else {
    const ring = run.closed ? [...run.points, run.points[0]] : run.points;
    if (run.points.length >= 3) {
      const area = polygonArea([ring], context);
      const perimeter = polygonPerimeter([ring], context);
      parts.push(`Area ${area.text}`);
      parts.push(`perimeter ${perimeter.text}`);
      if (!run.closed) parts.push('open — the area assumes the run closes back to the first point');
    } else {
      parts.push(`Length ${pathLength(run.points, context).text} — an area needs at least three points`);
    }
  }

  const crs = item?.dataset?.crs ?? null;
  const method = pathLength(run.points, context).method;
  readout.append(element('span', { text: parts.join(' · ') }));
  readout.append(
    element('span', {
      class: 'small muted',
      style: 'margin-left:8px',
      text: `${METHOD_LABEL[method]}${crs ? ` (${crsLabel(crs)})` : ''}`,
    })
  );
}

/** Wires the toolbar. Called once, from the shell. */
export function wireMeasureBar(): void {
  const setMode = (mode: MeasureMode): void => {
    if (!ui.measureCanvas) return;
    // Clicking the active mode turns it off, so pan-and-zoom comes straight
    // back without hunting for a separate "off" button.
    const next = ui.measureCanvas.getMode() === mode ? 'off' : mode;
    ui.measureCanvas.setMode(next);
    run.points = [];
    run.closed = false;
    updateMeasureBar(store.selected());
  };

  $('measureDistance').addEventListener('click', () => setMode('distance'));
  $('measureArea').addEventListener('click', () => setMode('area'));
  $('measureClear').addEventListener('click', () => {
    ui.measureCanvas?.clear();
    updateMeasureBar(store.selected());
  });
}

/** Turns measuring off — called when the inspector leaves the Preview tab. */
export function stopMeasuring(): void {
  if (!ui.measureCanvas) return;
  ui.measureCanvas.setMode('off');
  run.points = [];
  run.closed = false;
}
