/**
 * The georeferencing panel: choose where the drawing goes, then put it there.
 *
 * The order of the controls is the order of the decisions, and the first one is
 * not optional. A basemap cannot draw a single tile until it knows what CRS to
 * place them in, and a local-grid drawing declares none — so "which coordinate
 * system am I placing into?" comes before anything else on screen, rather than
 * being a dropdown someone discovers after wondering why the map is blank.
 *
 * Two routes to a placement, and they are not equal:
 *
 *   CONTROL POINTS are the surveyed answer. Two or more pairs of (local,
 *   target) give a least-squares similarity with a residual per point, which is
 *   a number a surveyor can defend in front of a client.
 *
 *   DRAGGING is the eyeball answer. It is genuinely useful — for a sheet whose
 *   control has been lost, aligning visually against imagery is often the only
 *   option left — but it produces no residual, and this panel says so plainly
 *   rather than showing a confident-looking placement with nothing behind it.
 */

import {
  applyGeoreference,
  describeGeoreference,
  type GeorefSession,
  initialPlacement,
  refitSession,
  type SurveyGcp,
} from '../../core/georeference-apply';
import { featuresBounds, isFiniteBounds } from '../../core/geometry';
import type { CirDataset, CrsRef, Position } from '../../core/cir';
import { crsLabel, planTransform } from '../../crs/transform';
import { utmCrs, WGS84_CRS } from '../../crs/epsg';
import { type QueueItem, store } from '../../state/store';
import { element, ghostButton, messageBlock } from '../dom';
import { host } from '../host';
import { ui } from '../ui-state';
import { datasetForTools } from './dataset';
import { queueEdit } from './edits';

/**
 * The UTM zone a longitude falls in, and its EPSG code.
 *
 * Offered as the default because it is nearly always the right answer for
 * survey work and because asking a surveyor to remember that Bhopal is 32643
 * while Kolkata is 32645 is asking them to do arithmetic the machine can do.
 * It is a SUGGESTION, shown with its name so a wrong guess is visible.
 */
export function utmZoneFor(lon: number, lat: number): CrsRef {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  // Built through `utmCrs`, NOT as an object literal with an epsg number on it.
  // A CrsRef carries the projection parameters the transform engine needs — a
  // bare `{ epsg }` looks right, typechecks, and then makes every transform
  // throw, which is exactly how this was first written and what the browser
  // check caught.
  return utmCrs(zone, lat < 0);
}

/** The centre of a dataset's extent, which is what a placement pivots about. */
export function centreOf(dataset: CirDataset | null): Position | null {
  if (!dataset?.layers?.length) return null;
  const bounds = featuresBounds(dataset.layers.flatMap((layer) => layer.features));
  if (!isFiniteBounds(bounds)) return null;
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

/**
 * Re-places the working dataset from the pristine original.
 *
 * TWO SHAPES, AND BOTH MATTER HERE.
 *
 * The engine speaks CIR — layers carrying `features`. The workspace speaks the
 * summarised shape — layers carrying `preview`, `featureCount` and
 * `previewTruncated`. Placing the drawing and handing the result straight to
 * the canvas produces a dataset whose features are in a key the renderer does
 * not read: the CRS badge updates, the canvas goes blank, and the layer list
 * says "0 · Polygon". That is precisely the defect 1.8.0 shipped a fix for, and
 * it reappeared here the moment a new panel produced a CIR dataset.
 *
 * So the result is folded back into the UI's shape, exactly as `applyToPreview`
 * does for every other edit. `featureCount` is carried across from the original
 * rather than recounted: a placement moves features, it never adds or removes
 * them, so the true count is whatever it already was — recounting would report
 * the preview cap as the file's size.
 */
export function replaceFromOriginal(item: QueueItem, session: GeorefSession): void {
  const original = ui.georefOriginal as any;
  if (!original) return;

  const placed = applyGeoreference(datasetForTools({ ...item, dataset: original } as QueueItem), {
    affine: session.affine,
    crs: session.targetCrs,
    kind: session.kind,
    gcpCount: session.gcps.length || undefined,
  }) as any;

  const originals = new Map<string, any>((original.layers ?? []).map((layer: any) => [layer.name, layer]));
  item.dataset = {
    ...original,
    crs: placed.crs,
    crsOrigin: placed.crsOrigin,
    layers: placed.layers.map((layer: any) => {
      const before = originals.get(layer.name);
      return {
        ...(before ?? {}),
        name: layer.name,
        path: layer.path,
        fields: layer.fields,
        geometryTypes: layer.geometryTypes,
        style: layer.style,
        preview: layer.features,
        featureCount: before?.featureCount ?? layer.features.length,
        previewTruncated: before?.previewTruncated ?? false,
      };
    }),
  } as never;
}

/**
 * Opens a session.
 *
 * The drawing's centre is dropped on the supplied target coordinate at scale 1
 * and rotation 0 — the honest opening position, asserting nothing about
 * orientation the user has not stated. For a drawing already in metres it is
 * very often nearly right, which is what makes dragging from here quick.
 */
export function beginGeoref(item: QueueItem, targetCrs: CrsRef, targetCentre: Position): void {
  // The original is kept in the WORKSPACE's shape, not the engine's: the
  // fold-back in `replaceFromOriginal` needs `featureCount` off it, and cancel
  // needs something it can hand straight back to the canvas.
  const original = (ui.georefOriginal ?? item.dataset) as CirDataset;
  ui.georefOriginal = original;
  const localCentre = centreOf(datasetForTools({ ...item, dataset: original } as QueueItem)) ?? [0, 0];
  const session: GeorefSession = {
    targetCrs,
    affine: initialPlacement(localCentre, targetCentre),
    gcps: [],
    kind: 'similarity',
  };
  ui.georefSession = session;
  replaceFromOriginal(item, session);
}

/** Abandons a session, putting the surveyor's original numbers back. */
export function cancelGeoref(item: QueueItem): void {
  if (ui.georefOriginal) item.dataset = ui.georefOriginal as never;
  ui.georefSession = null;
  ui.georefOriginal = null;
}

function numberInput(value: string, placeholder: string, onChange: (value: string) => void): HTMLElement {
  const input = element('input', { class: 'input input--sm', type: 'text', value, placeholder }) as HTMLInputElement;
  input.addEventListener('change', () => onChange(input.value.trim()));
  return input;
}

export function georefPanel(item: QueueItem): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const wrap = element('div', { class: 'stack', style: 'padding:12px' });
  const session = ui.georefSession;

  const declared = item.dataset?.crs ?? null;
  if (declared && !session) {
    wrap.append(
      messageBlock(
        'info',
        `This drawing already declares ${crsLabel(declared)}.`,
        'Georeferencing is for a drawing on a local grid — one whose coordinates are metres from an arbitrary site origin rather than from a projection.',
        'Placing it again would move correct coordinates. Use Geometry tools if you meant to shift or rotate it deliberately.'
      )
    );
  }

  // --- step 1: where is it going? ----------------------------------------
  if (!session) {
    const section = element('div', { class: 'section' });
    section.append(element('h3', { class: 'section__title', text: 'Place this drawing' }));
    section.append(
      element('p', {
        class: 'small',
        text: 'Type a coordinate near the site. The map centres there and the drawing is dropped on it, ready to drag into place.',
      })
    );

    let lonText = '';
    let latText = '';
    const row = element('div', { class: 'row' });
    row.append(element('span', { class: 'small faint', text: 'Lon' }));
    row.append(numberInput('', 'e.g. 77.412', (value) => (lonText = value)));
    row.append(element('span', { class: 'small faint', text: 'Lat' }));
    row.append(numberInput('', 'e.g. 23.259', (value) => (latText = value)));
    section.append(row);

    const start = element('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Start placing' });
    start.addEventListener('click', () => {
      const lon = Number(lonText);
      const lat = Number(latText);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        store.log('warn', 'Enter a longitude and latitude in degrees — the approximate centre of the site is enough.');
        host.render();
        return;
      }
      const crs = utmZoneFor(lon, lat);
      // The typed lon/lat is turned into the target CRS's own units here, so the
      // rest of the session never has to think about two coordinate systems.
      // Imported statically: a dynamic import would make starting a placement
      // asynchronous, which is both a needless code-split chunk and a window in
      // which the button looks dead.
      try {
        const into = planTransform(WGS84_CRS, crs);
        const [x, y] = into.transform([lon, lat]);
        beginGeoref(item, crs, [x, y]);
        store.log('ok', `Placing in ${crsLabel(crs)}. Drag to move, Shift+drag to rotate, Alt+drag to scale.`);
      } catch {
        store.log('warn', `That location could not be converted into ${crsLabel(crs)}.`);
      }
      host.render();
    });
    section.append(start);
    wrap.append(section);
    nodes.push(wrap);
    return nodes;
  }

  // --- step 2: the live placement ----------------------------------------
  const described = describeGeoreference(session.affine);

  const status = element('div', { class: 'section' });
  status.append(element('h3', { class: 'section__title', text: 'Placement' }));
  status.append(element('p', { class: 'small', text: `Target: ${crsLabel(session.targetCrs)}` }));
  status.append(
    element('p', {
      class: 'small',
      text: `Scale ${described.scaleX.toFixed(6)} · Rotation ${described.rotationDegrees.toFixed(4)}°`,
    })
  );
  status.append(
    element('p', {
      class: described.preservesShape ? 'small faint' : 'small',
      text: described.preservesShape
        ? 'Shape preserved: every angle and every area ratio is unchanged.'
        : `WARNING — this placement shears the drawing by ${described.shearPpm.toFixed(0)} ppm. Angles and areas are being altered.`,
    })
  );
  wrap.append(status);

  // --- control points ------------------------------------------------------
  const control = element('div', { class: 'section' });
  control.append(element('h3', { class: 'section__title', text: 'Control points' }));

  if (session.gcps.length === 0) {
    control.append(
      element('p', {
        class: 'small',
        text: 'None yet. Dragging alone gives no residual — it is an eyeball fit, and the report will say so. Two or more control points give a least-squares fit with a residual at each point.',
      })
    );
  } else {
    const { fit, refusal } = refitSession(session);
    if (refusal) {
      control.append(messageBlock('warn', refusal.what, refusal.why, refusal.action));
    } else if (fit) {
      control.append(
        element('p', {
          class: 'small',
          text: fit.exactlyDetermined
            ? `${session.gcps.length} points — exactly determined, so the residual is arithmetic rather than a measure of accuracy.`
            : `RMS ${fit.rms.toFixed(3)} · worst ${fit.worst.toFixed(3)} over ${session.gcps.length} points.`,
        })
      );
      const table = element('table', { class: 'table table--sm' });
      for (const entry of fit.residuals) {
        const tr = element('tr');
        tr.append(element('td', { text: entry.name }));
        tr.append(element('td', { text: `${entry.residual.toFixed(3)} m` }));
        table.append(tr);
      }
      control.append(table);
    }
  }

  const csvNote = element('p', {
    class: 'small faint',
    text: 'Import control as CSV with four columns: local easting, local northing, target easting, target northing.',
  });
  control.append(csvNote);

  const picker = element('input', { class: 'hidden', type: 'file', accept: '.csv,text/csv' }) as HTMLInputElement;
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    const parsed = parseGcpCsv(await file.text());
    if (parsed.error) {
      store.log('warn', parsed.error);
      host.render();
      return;
    }
    session.gcps = parsed.gcps;
    const refit = refitSession(session);
    if (refit.fit) {
      ui.georefSession = refit.session;
      replaceFromOriginal(item, refit.session);
      store.log('ok', `Fitted ${parsed.gcps.length} control points — RMS ${refit.fit.rms.toFixed(3)}.`);
    } else if (refit.refusal) {
      store.log('warn', `${refit.refusal.what} ${refit.refusal.why}`);
    }
    host.render();
  });
  control.append(picker);
  control.append(ghostButton('Import control points…', () => picker.click()));
  wrap.append(control);

  // --- commit --------------------------------------------------------------
  const actions = element('div', { class: 'row' });
  const apply = element('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Apply placement' });
  apply.addEventListener('click', () => {
    const current = ui.georefSession;
    const original = ui.georefOriginal;
    if (!current || !original) return;

    // Put the ORIGINAL back before committing. The live drag has been writing a
    // placed copy into `item.dataset` for the user to see; `queueEdit` applies
    // the command to the preview itself, so leaving the placed copy there would
    // apply the affine twice and put the drawing somewhere neither the user nor
    // the control asked for.
    item.dataset = original as never;

    queueEdit(
      item,
      {
        kind: 'georeference',
        affine: current.affine,
        crs: current.targetCrs,
        fitKind: current.kind,
        gcpCount: current.gcps.length >= 2 ? current.gcps.length : undefined,
      },
      { refusal: undefined } as never,
      current.gcps.length >= 2
        ? `Georeference on ${current.gcps.length} control points`
        : 'Georeference by hand'
    );

    ui.georefSession = null;
    ui.georefOriginal = null;
    store.log(
      'ok',
      current.gcps.length >= 2
        ? `Placed on ${current.gcps.length} control points in ${crsLabel(current.targetCrs)}. Every feature is moved at conversion, not just the preview.`
        : `Placed by hand in ${crsLabel(current.targetCrs)} — no control points, so there is no residual to report.`
    );
    host.render();
  });
  actions.append(apply);
  actions.append(
    ghostButton('Cancel', () => {
      cancelGeoref(item);
      store.log('ok', 'Placement abandoned — the drawing is back on its original local coordinates.');
      host.render();
    })
  );
  wrap.append(actions);

  nodes.push(wrap);
  return nodes;
}

/**
 * Reads a control CSV.
 *
 * Deliberately strict about the row shape and deliberately loose about
 * delimiters and headers: a control list is typed by hand or exported from a
 * dozen different instruments, and rejecting a file for a header row it
 * happened to carry would be needless.
 */
export function parseGcpCsv(text: string): { gcps: SurveyGcp[]; error?: string } {
  const gcps: SurveyGcp[] = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    const parts = line.split(/[,;\t]/).map((part) => part.trim());
    if (parts.length < 4) continue;
    const numbers = parts.slice(0, 4).map(Number);
    if (numbers.some((value) => !Number.isFinite(value))) {
      // A header row, not an error.
      if (index === 0) continue;
      continue;
    }
    gcps.push({
      local: [numbers[0], numbers[1]],
      target: [numbers[2], numbers[3]],
      name: parts[4] || `Point ${gcps.length + 1}`,
    });
  }
  if (gcps.length < 2) {
    return {
      gcps: [],
      error: `Found ${gcps.length} usable row${gcps.length === 1 ? '' : 's'}. Control needs at least two rows of four numbers: local easting, local northing, target easting, target northing.`,
    };
  }
  return { gcps };
}
