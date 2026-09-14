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
  fitExtentToReference,
  fitSurveyControl,
  type GeorefSession,
  initialPlacement,
  pairsToControl,
  refitSession,
  type SurveyGcp,
} from '../../core/georeference-apply';
import { featuresBounds, isFiniteBounds } from '../../core/geometry';
import type { CirDataset, CirFeature, CrsRef, Position } from '../../core/cir';
import { crsLabel, planTransform } from '../../crs/transform';
import { invertAffine } from '../../core/georeference';
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

/**
 * The centre of a dataset's extent, which is what a placement pivots about.
 *
 * TOLERANT OF BOTH LAYER SHAPES, deliberately.
 *
 * CIR layers carry `features`; the workspace's own layers carry `preview`, the
 * summarised form the canvas draws. Reading only `features` did not merely
 * return nothing for a workspace layer — `flatMap` keeps a non-array result as
 * an element, so a two-layer drawing produced `[undefined, undefined]` and
 * `featuresBounds` threw
 *
 *     TypeError: Cannot read properties of undefined (reading 'geometry')
 *
 * every time the georeference panel opened on a local-grid drawing. Since this
 * is the pivot a rotate or scale gesture turns about, those gestures could not
 * run at all. Caught by driving the real panel in a browser, not by a test.
 *
 * The same shape mismatch has now bitten three separate call sites, so this
 * reads either rather than trusting a caller to normalise first.
 */
export function centreOf(dataset: CirDataset | null): Position | null {
  if (!dataset?.layers?.length) return null;
  const features = dataset.layers.flatMap((layer) => {
    const shaped = layer as typeof layer & { preview?: CirFeature[] };
    return shaped.features ?? shaped.preview ?? [];
  });
  const bounds = featuresBounds(features);
  if (!isFiniteBounds(bounds)) return null;
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
}

/**
 * The other loaded files that could serve as a reference.
 *
 * A drawing qualifies only if it declares a CRS and has geometry to match
 * against. Offering a file that declares nothing would be asking the user to
 * georeference one local grid onto another, which produces coordinates that
 * look real and are not.
 */
export function referenceCandidates(items: QueueItem[], selfId: string): QueueItem[] {
  return items.filter(
    (candidate) =>
      candidate.id !== selfId &&
      Boolean(candidate.dataset?.crs) &&
      ((candidate.dataset?.layers ?? []) as any[]).some(
        (layer) => (layer.preview ?? layer.features ?? []).length > 0
      )
  );
}

/** The extent of a queue item, in its own CRS. */
export function extentOfItem(item: QueueItem): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const bounds = featuresBounds(datasetForTools(item).layers.flatMap((layer: any) => layer.features));
  return isFiniteBounds(bounds) ? bounds : null;
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
/**
 * Records one half of a matching pair, in the ORIGINAL local grid.
 *
 * THE INVERSE MATTERS HERE, and getting it wrong is invisible.
 *
 * The user clicks the drawing where it currently SITS — in target units,
 * because the working copy has already been placed. But a control point must be
 * stated in the drawing's own local grid: the whole purpose of the fit is to
 * compute the very transform that is currently in effect. Storing the placed
 * coordinate would define the control in terms of the guess it is supposed to
 * replace, and the fit would converge on wherever the drawing happened to be
 * dragged to — a flawless residual against a meaningless answer.
 *
 * So the click is run back through the inverse of the live affine.
 */
export function pickToLocal(session: GeorefSession, clicked: Position): Position | null {
  const inverse = invertAffine(session.affine);
  if (!inverse) return null;
  return [
    inverse.a * clicked[0] + inverse.b * clicked[1] + inverse.c,
    inverse.d * clicked[0] + inverse.e * clicked[1] + inverse.f,
  ];
}

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
    matchedBy: 'hand',
    pairs: [],
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

/**
 * Whether a typed lon/lat pair can start a placement.
 *
 * Extracted from the button handler so it can be tested without a DOM, because
 * the case that matters most is the one that is invisible: BLANK IS NOT ZERO.
 * `Number('')` is `0`, which is finite and within every bound, so an empty
 * field used to pass straight through and place the drawing at 0°N 0°E — UTM
 * zone 31N, in the Gulf of Guinea — with no warning at all. A placement that
 * silently lands somewhere plausible-looking is worse than one that refuses.
 */
export function isPlaceableCoordinate(lonText: string, latText: string): boolean {
  if (lonText.trim() === '' || latText.trim() === '') return false;
  const lon = Number(lonText);
  const lat = Number(latText);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
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
      if (!isPlaceableCoordinate(lonText, latText)) {
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

  // --- match to another drawing -------------------------------------------
  const candidates = referenceCandidates(store.get().items, item.id);
  const reference = element('div', { class: 'section' });
  reference.append(element('h3', { class: 'section__title', text: 'Match to a georeferenced drawing' }));

  if (candidates.length === 0) {
    reference.append(
      element('p', {
        class: 'small faint',
        text: 'No other loaded file declares a coordinate system. Add the adjoining sheet — a shapefile with a .prj, or anything already on real coordinates — and it can be matched against here.',
      })
    );
  } else {
    reference.append(
      element('p', {
        class: 'small',
        text: 'Align the extents as a starting position, then refine by dragging or with control points.',
      })
    );
    for (const candidate of candidates) {
      const row = element('div', { class: 'row' });
      row.append(
        element('span', {
          class: 'small',
          text: `${candidate.fileName} — ${crsLabel(candidate.dataset!.crs!)}`,
        })
      );
      row.append(
        ghostButton('Align extents', () => {
          const source = ui.georefOriginal
            ? extentOfItem({ ...item, dataset: ui.georefOriginal } as QueueItem)
            : extentOfItem(item);
          const target = extentOfItem(candidate);
          if (!source || !target) {
            store.log('warn', 'One of the two drawings has no measurable extent, so there is nothing to align.');
            host.render();
            return;
          }
          const fitted = fitExtentToReference(source, target);
          if (!fitted) {
            store.log('warn', 'These extents cannot be aligned — one of them is a single point or a straight line.');
            host.render();
            return;
          }
          const next: GeorefSession = {
            ...session,
            // The reference's CRS wins: matching onto a drawing means adopting
            // the coordinate system that drawing is actually in. Placing into a
            // different one would put the result somewhere neither file claims.
            targetCrs: candidate.dataset!.crs!,
            affine: fitted.affine,
            matchedBy: 'extent',
            referenceId: candidate.id,
          };
          ui.georefSession = next;
          replaceFromOriginal(item, next);
          store.log(
            'warn',
            `Extents aligned to ${candidate.fileName} at scale ${fitted.scale.toFixed(6)}. This is a STARTING POSITION, not a survey fit: bounding boxes carry no rotation and two drawings of the same ground rarely cover the same rectangle. Refine it by dragging or with control points before exporting.`
          );
          host.render();
        })
      );
      reference.append(row);
    }

    // --- the survey-grade route: matching points ---------------------------
    const picking = ui.georefCanvas?.isPicking() ?? false;
    const pairs = session.pairs ?? [];
    const half = pairs.length * 2 + (ui.georefPending ? 1 : 0);

    reference.append(
      element('p', {
        class: 'small',
        text: picking
          ? ui.georefPending
            ? 'Now click the SAME corner on the reference drawing.'
            : 'Click a corner on the drawing being placed.'
          : 'For a defensible fit, match corners instead: click a point on this drawing, then the same point on the reference. Two pairs are enough; three or more give a residual worth reading.',
      })
    );

    const pickRow = element('div', { class: 'row' });
    const pickButton = element('button', {
      class: `btn btn--sm${picking ? ' btn--on' : ''}`,
      type: 'button',
      text: picking ? `Picking… (${pairs.length} pair${pairs.length === 1 ? '' : 's'})` : 'Pick matching points',
    });
    pickButton.addEventListener('click', () => {
      const next = !(ui.georefCanvas?.isPicking() ?? false);
      ui.georefCanvas?.setPicking(next);
      ui.georefPending = null;
      host.render();
    });
    pickRow.append(pickButton);

    if (pairs.length > 0) {
      pickRow.append(
        ghostButton('Clear pairs', () => {
          const current = ui.georefSession;
          if (!current) return;
          ui.georefSession = { ...current, pairs: [], gcps: [] };
          ui.georefPending = null;
          host.render();
        })
      );
    }

    if (pairs.length >= 2) {
      pickRow.append(
        ghostButton(`Fit to ${pairs.length} pairs`, () => {
          const current = ui.georefSession;
          if (!current) return;
          const control = pairsToControl(current.pairs);
          const { fit, refusal } = fitSurveyControl(control, { kind: current.kind });
          if (!fit) {
            store.log('warn', refusal ? `${refusal.what} ${refusal.why} ${refusal.action}` : 'Those pairs do not define a placement.');
            host.render();
            return;
          }
          const next: GeorefSession = { ...current, affine: fit.affine, gcps: control, matchedBy: 'reference-points' };
          ui.georefSession = next;
          replaceFromOriginal(item, next);
          ui.georefCanvas?.setPicking(false);
          ui.georefPending = null;
          store.log(
            'ok',
            `Fitted to ${control.length} matched points — RMS ${fit.rms.toFixed(3)}, worst ${fit.worst.toFixed(3)}. This placement is only as accurate as the reference drawing.`
          );
          host.render();
        })
      );
    }
    reference.append(pickRow);
    if (half > 0 && pairs.length < 2) {
      reference.append(element('p', { class: 'small faint', text: 'At least two complete pairs are needed before a fit can be computed.' }));
    }
  }
  wrap.append(reference);

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
