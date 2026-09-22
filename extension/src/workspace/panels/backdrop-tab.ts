/**
 * The backdrop panel: import a sheet, place it, trace from it (phase G).
 *
 * The owner's case is specific and worth keeping in view: the map tiles are out
 * of date at the site, so an old scanned sheet is a better reference than a
 * basemap that shows a field where the plot now is.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THIS PANEL MUST NEVER LET HAPPEN
 *
 * A scanned survey sheet is a persuasive object. It has a title block, a north
 * arrow, a scale bar and somebody's signature on it. If the tool places one by
 * the two-point route — which fixes scale and rotation and knows NOTHING about
 * absolute position — and then presents it like a georeferenced layer, a user
 * will read coordinates off it in good faith.
 *
 * So `georeferenced: false` is carried in the type from `core/georeference.ts`,
 * drawn as a dashed border by `ui/backdrop.ts`, and said in words here. Three
 * places, because one is how it gets lost.
 */

import type { Position } from '../../core/cir';
import {
  describeFit,
  fitGcps,
  fitTwoPointScale,
  type Gcp,
  type GeoreferenceFit,
  type ScaleFit,
} from '../../core/georeference';
import { georeferenceFiles } from '../../core/georeference-save';
import { encodeText } from '../../engines/shared';
import { readPdfImages, type PdfPageImage } from '../../engines/raster/pdf-image';
import { downloadBytes } from '../conversion';
import { type QueueItem, store } from '../../state/store';
import { element, ghostButton, keyValues, messageBlock } from '../dom';
import { host } from '../host';
import { ui } from '../ui-state';

type PlacementMode = 'gcp' | 'two-point';

interface BackdropState {
  /** The pages found in an imported PDF, so the picker has something to offer. */
  pages: PdfPageImage[];
  pageIndex: number;
  fileName: string;
  mode: PlacementMode;
  gcps: Gcp[];
  /** Two-point inputs, as typed. */
  firstU: string;
  firstV: string;
  secondU: string;
  secondV: string;
  distance: string;
  bearing: string;
  opacity: number;
  lastFit: GeoreferenceFit | ScaleFit | null;
}

const state: BackdropState = {
  pages: [],
  pageIndex: 0,
  fileName: '',
  mode: 'gcp',
  gcps: [],
  firstU: '',
  firstV: '',
  secondU: '',
  secondV: '',
  distance: '',
  bearing: '',
  opacity: 0.75,
  lastFit: null,
};

export function backdropTab(item: QueueItem): HTMLElement[] {
  const wrap = element('div', { class: 'stack', style: 'padding:12px' });

  wrap.append(
    element('p', {
      class: 'small faint',
      text: 'A local image or a scanned PDF page, drawn under your data to trace from. The image itself is never converted or re-encoded, and never leaves this machine. Once you have placed it on ground control points you can save the georeference — a world file beside the image, with the original pixels untouched.',
    })
  );

  // --- import -------------------------------------------------------------
  const importRow = element('div', { class: 'row' });
  const picker = element('input', {
    type: 'file',
    accept: '.png,.jpg,.jpeg,.webp,.gif,.bmp,.pdf,image/*,application/pdf',
    class: 'input',
    'aria-label': 'Backdrop image or PDF',
  }) as HTMLInputElement;
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (file) void loadBackdrop(file);
  });
  importRow.append(picker);
  wrap.append(importRow);

  const source = ui.backdrop?.getSource();
  if (!source) {
    wrap.append(
      element('p', {
        class: 'small muted',
        text: 'Nothing loaded. Choose a PNG, JPEG or a PDF whose page is a scan.',
      })
    );
    return [wrap];
  }

  // --- which page ---------------------------------------------------------
  if (state.pages.length > 1) {
    const pageField = element('label', { class: 'field' });
    pageField.append(element('span', { class: 'field__label', text: 'Page' }));
    const pages = element('select', { class: 'select' }) as HTMLSelectElement;
    for (const [index, page] of state.pages.entries()) {
      pages.append(
        element('option', { value: String(index), text: `Page ${page.page} — ${page.width} × ${page.height}` })
      );
    }
    pages.value = String(state.pageIndex);
    pages.addEventListener('change', () => {
      state.pageIndex = Number(pages.value);
      void showPage(state.pageIndex);
    });
    pageField.append(pages);
    wrap.append(pageField);
  }

  wrap.append(
    keyValues([
      ['Loaded', `${state.fileName}${source.page ? ` — page ${source.page}` : ''}`],
      ['Size', `${source.width} × ${source.height} pixels`],
    ])
  );

  // --- opacity ------------------------------------------------------------
  const opacity = element('input', {
    type: 'range',
    min: '5',
    max: '100',
    value: String(Math.round(state.opacity * 100)),
    class: 'lm__opacity',
    'aria-label': 'Backdrop opacity',
  }) as HTMLInputElement;
  opacity.addEventListener('input', () => {
    state.opacity = Number(opacity.value) / 100;
    ui.backdrop?.setOpacity(state.opacity);
  });
  const opacityField = element('label', { class: 'field' });
  opacityField.append(element('span', { class: 'field__label', text: 'Opacity' }));
  opacityField.append(opacity);
  wrap.append(opacityField);

  // --- how to place it ----------------------------------------------------
  const modeField = element('label', { class: 'field' });
  modeField.append(element('span', { class: 'field__label', text: 'How to place it' }));
  const mode = element('select', { class: 'select' }) as HTMLSelectElement;
  mode.append(element('option', { value: 'gcp', text: 'Ground control points' }));
  mode.append(element('option', { value: 'two-point', text: 'Two points and a distance (local grid)' }));
  mode.value = state.mode;
  mode.addEventListener('change', () => {
    state.mode = mode.value as PlacementMode;
    state.lastFit = null;
    host.renderInspector();
  });
  modeField.append(mode);
  wrap.append(modeField);

  wrap.append(state.mode === 'gcp' ? gcpSection(item) : twoPointSection(item));

  if (state.lastFit) wrap.append(fitReport(state.lastFit));
  if (state.lastFit) wrap.append(saveSection(item));

  return [wrap];
}

/**
 * Saving the georeference that was just made.
 *
 * THE HALF THAT WAS MISSING. Everything above this computes a real transform
 * from real control points and reports the residual at each one — and until
 * now the only thing a user could do with it was look at it. The panel's own
 * opening line said so: "never converted, never exported". Close the tab and
 * the work was gone.
 *
 * What comes out is a sidecar set, not a new image. The scan is not touched,
 * so a JPEG is not re-encoded and a surveyor hands on the record they were
 * given rather than a generation-lossy copy of it.
 */
function saveSection(item: QueueItem): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Save the georeference' }));

  const placement = ui.backdrop?.getPlacement();
  if (!placement) {
    section.append(element('p', { class: 'small faint', text: 'Place the image first — there is no transform to save yet.' }));
    return section;
  }

  // NOTHING TO BIND TO. Today `backdropTab` returns before this whole placement
  // UI when no image is loaded, so this cannot fire — it is here because the
  // consequence of that gate being relaxed is silent and ugly rather than
  // noisy. `georeferenceFiles('')` yields a bare `.wld`: a dotfile, invisible
  // in the folder on macOS and Linux, which the user then swears never
  // downloaded. The check is one line and the failure it prevents is not
  // one anybody would think to look for.
  if (!ui.backdrop?.getSource() || !state.fileName) {
    section.append(
      element('p', {
        class: 'small faint',
        text: 'Load the image or PDF page first. A world file is named for the image it belongs to, so there is nothing to bind this transform to yet.',
      })
    );
    return section;
  }

  // THE REFUSAL THIS WHOLE PANEL IS BUILT AROUND.
  //
  // A two-point placement fixes scale and rotation and knows NOTHING about
  // absolute position — the module header says so, `ui/backdrop.ts` draws it
  // with a dashed border to say so, and writing a world file for it would
  // undo both in one click. A world file IS the claim "this image is at these
  // coordinates", and a GIS that reads one has no way to know the position was
  // never established. R2.
  if (!placement.georeferenced) {
    section.append(
      messageBlock(
        'warn',
        'This placement cannot be saved as a georeference.',
        'Two points and a distance fix the scale and the rotation of the sheet, but nothing about where it sits on the ground — so the position on screen is a tracing aid, not a measurement. A world file would state those coordinates as fact to every GIS that opened it.',
        'Switch to ground control points and give at least two points whose real coordinates you know.'
      )
    );
    return section;
  }

  const affine = placement.affine;
  const crs = item.dataset?.crs ?? null;
  const files = georeferenceFiles({ imageName: state.fileName, affine, crs, gcps: state.gcps });

  section.append(
    element('p', {
      class: 'small',
      text: `Writes ${files.map((file) => file.name).join(', ')} beside your image. A world file binds to its image BY FILENAME, so keep these next to ${state.fileName} under that exact name and QGIS or ArcGIS will open it in place.`,
    })
  );

  if (!crs) {
    // R2: the transform is real, but without a stated CRS the numbers have no
    // frame, and saying "georeferenced" would be claiming more than is known.
    section.append(
      messageBlock(
        'warn',
        'No .prj is written, because this file states no coordinate system.',
        'The world file still places the image on the ground coordinates you typed, but nothing records WHICH grid those are on — so the layer will load with an unknown CRS and sit wherever the project default puts it.',
        'Assign a source CRS under Data › CRS first, then save again.'
      )
    );
  }

  const save = element('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Save georeference' });
  save.addEventListener('click', () => {
    for (const file of files) downloadBytes(encodeText(file.text), file.name, 'text/plain');
    store.log('ok', `Georeference saved: ${files.map((file) => file.name).join(', ')}.`);
    host.render();
  });
  section.append(save);
  return section;
}

// --------------------------------------------------------------------- GCPs

function gcpSection(item: QueueItem): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Ground control points' }));
  section.append(
    element('p', {
      class: 'small faint',
      text: 'Each point pairs a pixel on the image with a ground coordinate in this file’s CRS. Two points give scale, rotation and position; three give a full affine that can also correct shear; four or more are what make the residuals mean anything.',
    })
  );

  for (const [index, gcp] of state.gcps.entries()) {
    const row = element('div', { class: 'row' });
    row.append(
      element('span', {
        class: 'small',
        text: `${gcp.name ?? `Point ${index + 1}`}: pixel ${gcp.pixel.u}, ${gcp.pixel.v} → ${gcp.ground[0]}, ${gcp.ground[1]}`,
      })
    );
    row.append(
      ghostButton('Remove', () => {
        state.gcps.splice(index, 1);
        state.lastFit = null;
        host.renderInspector();
      })
    );
    section.append(row);
  }

  const entry = element('div', { class: 'row' });
  const fields = ['u', 'v', 'x', 'y'].map((key) =>
    element('input', { class: 'input', type: 'text', placeholder: key, 'aria-label': key }) as HTMLInputElement
  );
  for (const field of fields) entry.append(field);
  entry.append(
    ghostButton('Add point', () => {
      const [u, v, x, y] = fields.map((field) => Number(field.value));
      if (![u, v, x, y].every(Number.isFinite)) {
        store.log('warn', 'A control point needs four numbers: the pixel u and v, and the ground x and y.');
        host.render();
        return;
      }
      state.gcps.push({ pixel: { u, v }, ground: [x, y], name: `Point ${state.gcps.length + 1}` });
      state.lastFit = null;
      host.renderInspector();
    })
  );
  section.append(entry);

  section.append(
    element('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Place the backdrop' })
  );
  (section.lastChild as HTMLElement).addEventListener('click', () => {
    const { fit, refusal } = fitGcps(state.gcps);
    if (refusal) {
      store.log('warn', `${refusal.what} ${refusal.why} ${refusal.action}`);
      host.render();
      return;
    }
    state.lastFit = fit!;
    ui.backdrop?.setPlacement({ affine: fit!.affine, georeferenced: true });
    store.log('ok', describeFit(fit!));
    host.render();
  });

  void item;
  return section;
}

// -------------------------------------------------------------- two points

function twoPointSection(item: QueueItem): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Two points and a distance' }));

  section.append(
    messageBlock(
      'warn',
      'This route does NOT georeference the sheet.',
      'Two points and a distance fix scale and rotation. Nothing here says where on Earth the sheet is, so it is placed where the data already sits and the tool draws a dashed border round it as a reminder.',
      'Trace from it. Do not read coordinates off it — they mean nothing.'
    )
  );

  const rows: [string, keyof BackdropState, string][] = [
    ['First point — pixel u', 'firstU', ''],
    ['First point — pixel v', 'firstV', ''],
    ['Second point — pixel u', 'secondU', ''],
    ['Second point — pixel v', 'secondV', ''],
    ['Distance between them, on the ground', 'distance', 'In this file’s own units.'],
    ['Bearing of the first-to-second line (optional)', 'bearing', 'Degrees clockwise from north. Leave blank to keep the sheet’s own orientation.'],
  ];
  for (const [label, key, hint] of rows) {
    const field = element('label', { class: 'field' });
    field.append(element('span', { class: 'field__label', text: label }));
    const input = element('input', { class: 'input', type: 'text', value: String(state[key]) }) as HTMLInputElement;
    input.addEventListener('change', () => {
      (state as unknown as Record<string, string>)[key] = input.value;
    });
    field.append(input);
    if (hint) field.append(element('span', { class: 'field__hint', text: hint }));
    section.append(field);
  }

  const place = element('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Scale and place' });
  place.addEventListener('click', () => {
    const first = { u: Number(state.firstU), v: Number(state.firstV) };
    const second = { u: Number(state.secondU), v: Number(state.secondV) };
    if (![first.u, first.v, second.u, second.v].every(Number.isFinite)) {
      store.log('warn', 'Both points need a pixel u and v.');
      host.render();
      return;
    }
    const anchor = anchorFor(item);
    const bearing = state.bearing.trim() === '' ? undefined : Number(state.bearing);
    const { fit, refusal } = fitTwoPointScale(first, second, Number(state.distance), anchor, {
      bearingDegrees: Number.isFinite(bearing) ? bearing : undefined,
    });
    if (refusal) {
      store.log('warn', `${refusal.what} ${refusal.why} ${refusal.action}`);
      host.render();
      return;
    }
    state.lastFit = fit!;
    ui.backdrop?.setPlacement({ affine: fit!.affine, georeferenced: false });
    store.log('ok', describeFit(fit!));
    host.render();
  });
  section.append(place);
  return section;
}

/**
 * Where to put the first picked point when the placement has no georeference.
 *
 * The centre of the data's own extent, so the sheet lands where the user is
 * already looking. Anywhere else would put it off-screen and look like nothing
 * happened.
 */
function anchorFor(item: QueueItem): Position {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (node: unknown): void => {
    if (Array.isArray(node) && typeof node[0] === 'number') {
      minX = Math.min(minX, node[0]);
      maxX = Math.max(maxX, node[0]);
      minY = Math.min(minY, node[1]);
      maxY = Math.max(maxY, node[1]);
      return;
    }
    if (Array.isArray(node)) for (const child of node) visit(child);
  };
  for (const layer of (item.dataset?.layers ?? []) as any[]) {
    for (const feature of (layer.preview ?? []) as any[]) visit(feature.geometry?.coordinates);
  }
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : [0, 0];
}

// ------------------------------------------------------------------ report

function fitReport(fit: GeoreferenceFit | ScaleFit): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'How it was placed' }));
  section.append(element('p', { class: 'small', text: describeFit(fit) }));

  if (fit.kind !== 'two-point-scale') {
    section.append(
      keyValues(
        fit.residuals.map((entry) => [entry.name, `${entry.residual.toPrecision(4)} ground units`] as [string, string])
      )
    );
  }
  for (const note of fit.notes) {
    section.append(element('p', { class: 'small faint', text: note }));
  }
  return section;
}

// ------------------------------------------------------------------ loading

async function loadBackdrop(file: File): Promise<void> {
  state.fileName = file.name;
  state.gcps = [];
  state.lastFit = null;
  state.pages = [];
  state.pageIndex = 0;

  try {
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      const scan = await readPdfImages(new Uint8Array(await file.arrayBuffer()));
      state.pages = scan.images;
      for (const note of scan.notes) store.log('warn', note);
      store.log(
        'ok',
        `${file.name}: ${scan.images.length} page image(s)${scan.pageCount ? ` from ${scan.pageCount} page(s)` : ''}.`
      );
      await showPage(0);
    } else {
      const bitmap = await createImageBitmap(file);
      ui.backdrop?.setSource({ image: bitmap, width: bitmap.width, height: bitmap.height, label: file.name });
      store.log('ok', `${file.name}: loaded as a backdrop, ${bitmap.width} × ${bitmap.height}.`);
    }
  } catch (error) {
    const structured = error as { what?: string; why?: string; action?: string };
    store.log(
      'error',
      structured.what
        ? `${structured.what} ${structured.why ?? ''} ${structured.action ?? ''}`
        : `${file.name} could not be read as a backdrop: ${String(error)}`
    );
  }
  host.render();
}

async function showPage(index: number): Promise<void> {
  const page = state.pages[index];
  if (!page) return;
  // A Blob rather than a data URL: a 40 MB scan as base64 is a 53 MB string,
  // and building it blocks the thread for long enough to look like a hang.
  const bitmap = await createImageBitmap(new Blob([page.bytes as BlobPart], { type: page.mimeType }));
  ui.backdrop?.setSource({
    image: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    label: state.fileName,
    page: page.page,
  });
  // A new page under the old page's placement would be plausible and wrong.
  ui.backdrop?.setPlacement(null);
  state.lastFit = null;
  host.render();
}
