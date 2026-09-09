/** The settings column, the cadastral tools, and the two dialogs. */

import { NATIVE_STATUS_LABEL } from '../../adapters/native-messaging/client';
import { OUTPUT_LAYOUT_DESCRIPTION, OUTPUT_LAYOUT_LABEL, type OutputLayout } from '../../core/layout';
import { getFormat } from '../../core/registry';
import {
  KML_TEMPLATE_DESCRIPTION,
  KML_TEMPLATE_LABEL,
  type KmlTemplate,
} from '../../engines/vector/kml-templates';
import {
  BURN_IN_MODE_DESCRIPTION,
  BURN_IN_MODE_LABEL,
  type BurnInMode,
  type BurnInPriority,
  PRIORITY_LABEL,
} from '../../qa/burn-in';
import { type AppSettings, DEFAULT_SETTINGS, store } from '../../state/store';
import { applyPreset, isOnline, TILE_PRESETS, TILE_PROVIDERS, validateTemplate } from '../../ui/basemap';
import { configurePool, poolStatus } from '../../workers/client';
import { $, checkbox, element, keyValues, messageBlock, numberField, textField } from '../dom';
import { boundaryRings, describeBoundary } from '../conversion';
import { host } from '../host';

export function renderSettingsPanel(): void {
  const state = store.get();
  const panel = $('settingsPanel');
  panel.replaceChildren();
  const item = store.selected();
  const targetId = item?.targetFormatId ?? state.settings.globalTargetFormatId;
  if (!targetId) return;
  const target = getFormat(targetId);
  if (!target) return;

  const common = element('div', { class: 'section' });
  common.append(element('h3', { class: 'section__title', text: 'Conversion settings' }));
  common.append(
    checkbox('Preserve Z (elevations)', state.settings.preserveZ, (value) => void store.patchSettings({ preserveZ: value }))
  );
  common.append(
    checkbox(
      'Write attributes',
      state.settings.preserveAttributes,
      (value) => void store.patchSettings({ preserveAttributes: value }),
      'Off writes geometry alone — for a boundary shared with someone who has no business seeing the owner names attached to it. The fields left out are listed in the warnings.'
    )
  );
  common.append(
    checkbox('Run QA after conversion', state.settings.runQa, (value) => void store.patchSettings({ runQa: value }), 'Re-imports the output and compares it with the source.')
  );
  common.append(
    checkbox(
      'Assess project health',
      state.settings.assessHealth,
      (value) => void store.patchSettings({ assessHealth: value }),
      'Scores CRS, geometry, topology, duplicates, attributes, conversion risk and warnings, each expandable into the items behind it.'
    )
  );
  // Sits directly under "Assess project health" because it is a part of that
  // scan rather than a separate feature, and it only means anything when the
  // scan runs at all.
  if (state.settings.assessHealth) {
    common.append(
      checkbox(
        'Look for missing parcels inside the coverage',
        state.settings.checkCoverageGaps,
        (value) => void store.patchSettings({ checkCoverageGaps: value }),
        'Unions every polygon in a layer and reports each enclosed area nothing covers — the un-digitised plot that no pairwise check can see, because it is consistent with all four of its neighbours. Slower than the other checks: seconds on a full sheet rather than milliseconds.'
      )
    );
  }

  common.append(
    checkbox(
      'Attach a conversion report',
      state.settings.embedReport,
      (value) => void store.patchSettings({ embedReport: value }),
      'Adds a self-contained HTML and text report to the delivery, for whoever receives it without this tool.'
    )
  );
  common.append(
    checkbox(
      'Attach a legend',
      state.settings.includeLegend,
      (value) => void store.patchSettings({ includeLegend: value }),
      'An SVG of the layers, their colours and their line types, built from the file as written — including any renames. The same colours are written into the output itself where the format can carry them, so the legend and the file cannot disagree.'
    )
  );

  // Output structure sits beside precision because it is a first-class choice,
  // not an advanced one: it decides whether the delivery is one file or a tree.
  const layoutField = element('div', { class: 'field' });
  const layoutLabel = element('label', { class: 'field__label', text: 'Output structure' });
  layoutLabel.append(element('span', { class: 'hint', text: '?', title: OUTPUT_LAYOUT_DESCRIPTION[state.settings.outputLayout] }));
  layoutField.append(layoutLabel);
  const layoutSelect = element('select', { class: 'select' }) as HTMLSelectElement;
  for (const value of ['single', 'per-layer', 'mirror-source'] as OutputLayout[]) {
    layoutSelect.append(element('option', { value, text: OUTPUT_LAYOUT_LABEL[value] }));
  }
  layoutSelect.value = state.settings.outputLayout;
  layoutSelect.addEventListener('change', () => void store.patchSettings({ outputLayout: layoutSelect.value as OutputLayout }));
  layoutField.append(layoutSelect);
  layoutField.append(element('p', { class: 'small faint', text: OUTPUT_LAYOUT_DESCRIPTION[state.settings.outputLayout] }));

  const layerCount = item?.dataset?.layers?.length ?? 0;
  if (state.settings.outputLayout !== 'single' && layerCount > 1) {
    layoutField.append(
      element('p', {
        class: 'small muted',
        text: `${layerCount} layers will become ${layerCount} files, packaged as one ZIP whose folders are the layer hierarchy.`,
      })
    );
  }
  common.append(layoutField);

  const precision = element('div', { class: 'field' });
  precision.append(element('label', { class: 'field__label', text: 'Output precision' }));
  const precisionSelect = element('select', { class: 'select' }) as HTMLSelectElement;
  for (const [value, label] of [
    ['full', 'Full source precision'],
    ['3', '3 decimals (millimetre)'],
    ['4', '4 decimals'],
    ['5', '5 decimals'],
    ['6', '6 decimals'],
  ] as [string, string][]) {
    precisionSelect.append(element('option', { value, text: label }));
  }
  precisionSelect.value = state.settings.precisionMode === 'full' ? 'full' : String(state.settings.precisionDecimals);
  precisionSelect.addEventListener('change', () => {
    const value = precisionSelect.value;
    void store.patchSettings(value === 'full' ? { precisionMode: 'full' } : { precisionMode: 'fixed', precisionDecimals: Number(value) });
  });
  precision.append(precisionSelect);
  common.append(precision);
  panel.append(common);

  // Target-specific settings, so the panel only ever shows what applies.
  const specific = element('details', { class: 'adv' });
  specific.append(element('summary', { text: `${target.name} options` }));
  const body = element('div');

  if (target.id === 'dxf') {
    body.append(
      numberField('Arc segmentation tolerance (sagitta, drawing units)', state.settings.arcTolerance, 0.0001, (value) =>
        void store.patchSettings({ arcTolerance: value })
      )
    );
    body.append(element('p', { class: 'small faint', text: 'Curved entities have no GIS equivalent. A smaller tolerance follows the true curve more closely at the cost of more vertices.' }));
  }
  if (target.id === 'kml' || target.id === 'kmz') {
    body.append(element('p', { class: 'small faint', text: 'KML is written in WGS 84 longitude/latitude, and the format has no field for anything else — so projected data is reprojected into it automatically and the transform is recorded. You only need to set a target CRS here if you want something other than EPSG:4326, which this format cannot store.' }));

    const templateField = element('div', { class: 'field' });
    templateField.append(element('label', { class: 'field__label', text: 'Balloon template' }));
    const templateSelect = element('select', { class: 'select' }) as HTMLSelectElement;
    for (const template of ['plain', 'cadastral', 'survey', 'borehole', 'mining', 'contour'] as KmlTemplate[]) {
      templateSelect.append(element('option', { value: template, text: KML_TEMPLATE_LABEL[template] }));
    }
    templateSelect.value = state.settings.kmlTemplate;
    templateSelect.addEventListener('change', () => void store.patchSettings({ kmlTemplate: templateSelect.value as KmlTemplate }));
    templateField.append(templateSelect);
    templateField.append(element('p', { class: 'small faint', text: KML_TEMPLATE_DESCRIPTION[state.settings.kmlTemplate] }));
    body.append(templateField);

    body.append(
      checkbox(
        'Render boreholes as core logs',
        state.settings.kmlBoreholeLog,
        (value) => void store.patchSettings({ kmlBoreholeLog: value }),
        'Joins collars to their depth intervals by hole id and renders a full log — from, to, thickness, lithology, recovery, RQD, sample and assay — in each balloon.'
      )
    );
    body.append(
      textField('Balloon footer (optional)', state.settings.kmlBalloonFooter, (value) => void store.patchSettings({ kmlBalloonFooter: value }))
    );
    body.append(
      element('p', {
        class: 'small faint',
        text: 'Fields whose names or values look like credentials are left out of the balloons, and the omission is reported. A KMZ is shared freely, so a token inside one has leaked.',
      })
    );
  }
  if (target.id === 'shapefile') {
    body.append(element('p', { class: 'small faint', text: 'Mixed geometry is split into _point, _line and _polygon files, and the package is delivered as one ZIP with .prj and .cpg. DBF field names are capped at 10 bytes; every rename is listed in the manifest.' }));
  }
  if (target.id === 'las') {
    body.append(element('p', { class: 'small faint', text: 'Scale and offset are derived from the data extent unless pinned, so the stored resolution matches the data rather than a default.' }));
  }
  if (target.dataKind === 'pointcloud' || item?.dataset?.pointcloud) {
    const decimation = element('div', { class: 'field' });
    decimation.append(element('label', { class: 'field__label', text: 'Decimation (export)' }));
    const select = element('select', { class: 'select' }) as HTMLSelectElement;
    for (const [value, label] of [
      ['none', 'None — every point'],
      ['nth', 'Keep every nth point'],
      ['grid', 'One point per 2D grid cell'],
      ['voxel', 'One point per 3D voxel'],
    ] as [string, string][]) {
      select.append(element('option', { value, text: label }));
    }
    select.value = state.settings.decimationMode;
    select.addEventListener('change', () => void store.patchSettings({ decimationMode: select.value as AppSettings['decimationMode'] }));
    decimation.append(select);
    body.append(decimation);
    if (state.settings.decimationMode === 'nth') {
      body.append(numberField('Keep every nth point', state.settings.decimationFactor, 1, (value) => void store.patchSettings({ decimationFactor: value })));
    }
    if (state.settings.decimationMode === 'grid' || state.settings.decimationMode === 'voxel') {
      body.append(numberField('Cell size (dataset units)', state.settings.decimationCell, 0.01, (value) => void store.patchSettings({ decimationCell: value })));
    }
  }

  body.append(
    checkbox('Embed conversion metadata alongside the output', state.settings.embedMetadata, (value) => void store.patchSettings({ embedMetadata: value }))
  );
  specific.append(body);
  panel.append(specific);

  // Repair is deliberately buried and off: survey data is evidence.
  const repair = element('details', { class: 'adv' });
  repair.append(element('summary', { text: 'Geometry repair (off by default)' }));
  const repairBody = element('div');
  repairBody.append(element('p', { class: 'small faint', text: 'Repair edits your geometry. It stays off so survey data converts exactly as delivered; every change it makes is reported.' }));
  repairBody.append(checkbox('Close unclosed rings', state.settings.repairCloseRings, (value) => void store.patchSettings({ repairCloseRings: value })));
  repairBody.append(checkbox('Remove duplicate vertices', state.settings.repairRemoveDuplicateVertices, (value) => void store.patchSettings({ repairRemoveDuplicateVertices: value })));
  repairBody.append(checkbox('Normalise ring orientation', state.settings.repairNormalizeOrientation, (value) => void store.patchSettings({ repairNormalizeOrientation: value })));
  repairBody.append(checkbox('Remove duplicate features', state.settings.repairDeduplicateFeatures, (value) => void store.patchSettings({ repairDeduplicateFeatures: value })));
  repair.append(repairBody);
  panel.append(repair);

  // Cadastral tools. Only shown for vector data, because polygonising a point
  // cloud or burning text into a raster is meaningless and an option that can
  // never apply is noise.
  const layerNames: string[] = (item?.dataset?.layers ?? []).map((layer: { name: string }) => layer.name);
  if (item?.dataset?.kind === 'vector' && layerNames.length > 0) {
    panel.append(cadastralTools(state.settings, layerNames));
  }

  // Contours, shown only for a raster that actually carries pixels. Offering
  // them for a georeference-only read would be offering something that can
  // only refuse.
  if (item?.dataset?.kind === 'raster' && item.dataset.raster?.hasPixelData) {
    panel.append(clipTools(state.settings, item.id));
    panel.append(contourTools(state.settings, item.dataset.raster));
    panel.append(vectorizeTools(state.settings, item.dataset.raster));
  }

  // The inverse: polygons into a grid. Shown only for a file that HAS polygons,
  // for the same reason contours are shown only for a raster with pixels —
  // offering an operation that can only refuse is worse than not offering it.
  if (item?.dataset?.kind === 'vector' && hasPolygons(item.dataset)) {
    panel.append(rasterizeTools(state.settings, item.dataset));
  }
}

/** Whether any layer holds closed rings, which is all rasterizing can burn. */
function hasPolygons(dataset: { layers?: { geometryTypes?: string[] }[] }): boolean {
  return (dataset.layers ?? []).some((layer) =>
    (layer.geometryTypes ?? []).some((type) => String(type).includes('Polygon'))
  );
}

/**
 * Burning polygons into a grid (spec §16, the inverse of vectorize).
 *
 * ONE number is asked for, and it is the one a surveyor actually has in mind:
 * the cell size. Width, height and the geotransform are derived from the
 * layer's own extent, so the raster covers the data exactly rather than a box
 * somebody had to type — and the resulting grid size is shown before anything
 * runs, because "0.1 metre cells" over a district is a hundred-million-cell
 * raster and the moment to find that out is now.
 */
function rasterizeTools(settings: AppSettings, dataset: any): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Rasterize polygons' }));
  section.append(
    element('p', {
      class: 'small muted',
      text: 'Burns the polygons in this file into a grid — a land-use raster, a mask, or a zone layer for analysis somewhere else. Choose a raster output format to receive it.',
    })
  );

  section.append(
    numberField('Cell size (0 = do not rasterize)', settings.rasterizeCellSize, 0.1, (value) =>
      void store.patchSettings({ rasterizeCellSize: Math.max(0, value) })
    )
  );

  if (settings.rasterizeCellSize > 0) {
    const extent = extentOf(dataset);
    if (extent) {
      const width = Math.ceil((extent.maxX - extent.minX) / settings.rasterizeCellSize);
      const height = Math.ceil((extent.maxY - extent.minY) / settings.rasterizeCellSize);
      const cells = width * height;
      section.append(
        element('p', {
          class: cells > 50_000_000 ? 'small' : 'small muted',
          text: `${width.toLocaleString()} × ${height.toLocaleString()} cells — ${cells.toLocaleString()} in total.`,
        })
      );
      if (cells > 50_000_000) {
        section.append(
          messageBlock(
            'warn',
            'That is a very large grid.',
            `${cells.toLocaleString()} cells at 8 bytes each is roughly ${Math.round((cells * 8) / 1e9)} GB before compression, which the browser will not hold.`,
            'Use a larger cell size, or clip the layer to the area you actually need first.'
          )
        );
      }
    }

    const fields: string[] = [
      ...new Set((dataset.layers ?? []).flatMap((layer: any) => (layer.fields ?? []).map((field: any) => field.name))),
    ] as string[];
    const fieldRow = element('div', { class: 'field' });
    fieldRow.append(element('label', { class: 'field__label', text: 'Value to burn' }));
    const select = element('select', { class: 'select' }) as HTMLSelectElement;
    select.append(element('option', { value: '', text: '1 everywhere (a mask)' }));
    for (const name of fields) select.append(element('option', { value: name, text: name }));
    select.value = settings.rasterizeField;
    select.addEventListener('change', () => void store.patchSettings({ rasterizeField: select.value }));
    fieldRow.append(select);
    fieldRow.append(
      element('p', {
        class: 'small faint',
        text: 'A raster cell holds a number, so only numeric fields carry through. Where polygons overlap, the one later in the layer wins — the convention every GIS uses, and the only predictable one.',
      })
    );
    section.append(fieldRow);
  }

  return section;
}

/** The extent of a dataset's drawn features, for the grid-size preview. */
function extentOf(dataset: any): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (node: unknown): void => {
    if (Array.isArray(node) && typeof node[0] === 'number') {
      minX = Math.min(minX, node[0]);
      maxX = Math.max(maxX, node[0]);
      minY = Math.min(minY, node[1]);
      maxY = Math.max(maxY, node[1]);
      return;
    }
    if (Array.isArray(node)) for (const child of node) walk(child);
  };
  for (const layer of (dataset.layers ?? []) as any[]) {
    for (const feature of (layer.preview ?? []) as any[]) walk(feature.geometry?.coordinates);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Turning a classified raster into polygons (spec §16).
 *
 * Offered only for a raster that is NOT marked as elevation, because the engine
 * refuses those — a DEM has a different value in almost every cell, so every
 * cell becomes its own region. Showing a control that can only refuse wastes a
 * click to deliver an error.
 */
function vectorizeTools(settings: AppSettings, raster: { isElevation?: boolean }): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Regions from cells' }));

  if (raster.isElevation) {
    section.append(
      element('p', {
        class: 'small muted',
        text: 'This raster is elevation, so it has a different value in almost every cell and would produce one polygon per pixel. Trace contours instead, or classify it into categories first.',
      })
    );
    return section;
  }

  section.append(
    checkbox('Trace regions as polygons', settings.vectorizeEnabled, (value) =>
      void store.patchSettings({ vectorizeEnabled: value })
    )
  );

  if (settings.vectorizeEnabled) {
    section.append(
      textField('Value field name', settings.vectorizeField, (value) =>
        void store.patchSettings({ vectorizeField: value || 'value' })
      )
    );
    section.append(
      element('p', {
        class: 'small faint',
        text: 'Adjacent cells sharing a value become ONE polygon rather than one square each — the edges between them are not boundaries on the ground. Each polygon carries its cell value and how many cells it covers.',
      })
    );
  }

  return section;
}

/**
 * Clipping a raster to a boundary held in another queued file (spec §16).
 *
 * The boundary comes from the queue rather than from a coordinate box, because
 * that is where it actually is: the site boundary arrives as a shapefile or a
 * KML alongside the DEM, and typing its corners in by hand is both tedious and
 * a way to get them wrong.
 *
 * Only files that actually contain polygons are offered. A picker listing every
 * queued file and then refusing most of them is a picker that wastes a click to
 * deliver an error.
 */
function clipTools(settings: AppSettings, rasterItemId: string): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Clip to a boundary' }));

  const candidates = store
    .get()
    .items.filter((candidate) => candidate.id !== rasterItemId && boundaryRings(candidate.id).length > 0);

  if (candidates.length === 0) {
    section.append(
      element('p', {
        class: 'small muted',
        text: 'Add the site boundary to the queue — a shapefile, KML or DXF containing closed polygons — and it can be selected here to clip this raster to it.',
      })
    );
    return section;
  }

  const options = [
    { value: '', label: 'Do not clip' },
    ...candidates.map((candidate) => ({
      value: candidate.id,
      label: `${candidate.fileName} — ${describeBoundary(candidate.id)}`,
    })),
  ];

  const picker = element('select', { class: 'select', 'aria-label': 'Boundary file' }) as HTMLSelectElement;
  for (const option of options) {
    const node = element('option', { value: option.value, text: option.label });
    if (option.value === settings.clipBoundaryItemId) node.setAttribute('selected', 'selected');
    picker.append(node);
  }
  picker.addEventListener('change', () => void store.patchSettings({ clipBoundaryItemId: picker.value }));
  section.append(picker);

  if (settings.clipBoundaryItemId) {
    section.append(
      checkbox('Shrink the grid to the boundary', settings.clipCrop, (value) =>
        void store.patchSettings({ clipCrop: value })
      )
    );
    section.append(
      checkbox('Include partly covered pixels', settings.clipTouched, (value) =>
        void store.patchSettings({ clipTouched: value }),
        'A pixel is kept when its centre is inside the boundary. Turn this on to keep any pixel the boundary touches — up to one pixel wider all round instead of narrower.'
      )
    );
    section.append(
      element('p', {
        class: 'small faint',
        text: 'A raster is always a rectangle, so clipping marks the pixels outside the boundary as no-data rather than cutting the shape out. This file needs a no-data value for that; the conversion refuses without one rather than filling with zero, which would put a sea-level plateau around the site.',
      })
    );
  }

  return section;
}

/**
 * Contours from a DEM (spec §16).
 *
 * The interval is the whole control, and it is deliberately empty until someone
 * types one. There is no interval that is right for every survey — half a metre
 * on a building plot and ten metres on a catchment are both correct — so a
 * default would be silently wrong for one of them, and silently wrong is the
 * thing this tool exists not to be.
 *
 * The elevation range is shown beside it, because "what interval?" is
 * unanswerable without knowing the relief, and the person asking is usually
 * looking at a file they did not produce.
 */
function contourTools(settings: AppSettings, raster: { statistics?: { min: number; max: number }[]; isElevation?: boolean }): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Contours' }));

  const stats = raster.statistics?.[0];
  const relief = stats ? stats.max - stats.min : null;

  section.append(
    element('p', {
      class: 'small muted',
      text: stats
        ? `Elevations run ${stats.min.toFixed(2)} to ${stats.max.toFixed(2)} — a relief of ${relief!.toFixed(2)}.`
        : 'Trace contour lines from this raster and write them as line work.',
    })
  );

  section.append(
    numberField('Interval (0 = no contours)', settings.contourInterval, 0.1, (value) =>
      void store.patchSettings({ contourInterval: Math.max(0, value) })
    )
  );

  if (settings.contourInterval > 0) {
    if (relief !== null && relief > 0) {
      const count = Math.floor(relief / settings.contourInterval);
      section.append(
        element('p', {
          class: 'small',
          text: `About ${count.toLocaleString()} contour level${count === 1 ? '' : 's'} at this interval.`,
        })
      );
    }
    section.append(
      numberField('Index contour every Nth (0 = none)', settings.contourIndexEvery, 1, (value) =>
        void store.patchSettings({ contourIndexEvery: Math.max(0, Math.round(value)) })
      )
    );
    section.append(
      numberField('Drop fragments shorter than', settings.contourMinLength, 1, (value) =>
        void store.patchSettings({ contourMinLength: Math.max(0, value) })
      )
    );
    section.append(
      element('p', {
        class: 'small faint',
        text: 'Contours are added as a layer beside the raster, each carrying its elevation, length, whether it closes, and whether it is an index contour. A cell touching a no-data pixel is skipped rather than interpolated across, so contours stop at the edge of the surveyed area.',
      })
    );
  }

  return section;
}

/**
 * The CAD-to-cadastral-GIS tools (spec §27).
 *
 * Both change the data, so both are off until switched on, and each states what
 * it will do before it does it. They live together because they are one
 * workflow: a cadastral DXF needs polygonising *and* burning-in, in that order,
 * and separating them would hide that.
 */
export function cadastralTools(settings: AppSettings, layerNames: string[]): HTMLElement {
  const tools = element('details', { class: 'adv' });
  tools.append(element('summary', { text: 'Cadastral tools — polygons and labels from CAD' }));
  const body = element('div');
  body.append(
    element('p', {
      class: 'small faint',
      text: 'A cadastral drawing holds boundaries as line work and plot numbers as separate text, with nothing linking them. These two steps make that link explicit. Both are off by default and both change your data.',
    })
  );

  // ---- Polygonise -------------------------------------------------------
  body.append(
    checkbox(
      'Build polygons from closed CAD line work',
      settings.polygonizeEnabled,
      (value) => void store.patchSettings({ polygonizeEnabled: value }),
      'Assembles separate LINE entities into closed boundaries, so parcels export as areas rather than as strokes.'
    )
  );
  if (settings.polygonizeEnabled) {
    body.append(
      numberField('Largest gap that may be closed (dataset units)', settings.polygonizeTolerance, 0.0001, (value) =>
        void store.patchSettings({ polygonizeTolerance: value })
      )
    );
    body.append(
      element('p', {
        class: 'small faint',
        text: 'Closing a few millimetres recovers a snap error. Closing metres invents a boundary — a gap larger than this is left as an open line and reported.',
      })
    );
    body.append(
      checkbox('Keep the source line work alongside the polygons', settings.polygonizeKeepLines, (value) =>
        void store.patchSettings({ polygonizeKeepLines: value })
      )
    );
  }

  // ---- Burn-in ----------------------------------------------------------
  body.append(
    checkbox(
      'Attach text found inside polygons to those polygons',
      settings.burnInEnabled,
      (value) => void store.patchSettings({ burnInEnabled: value }),
      'The plot number drawn beside a boundary becomes an attribute on it, so it survives into any GIS format.'
    )
  );
  if (settings.burnInEnabled) {
    const targetField = element('div', { class: 'field' });
    targetField.append(element('label', { class: 'field__label', text: 'Polygon layer to label' }));
    const targetSelect = element('select', { class: 'select' }) as HTMLSelectElement;
    targetSelect.append(element('option', { value: '', text: 'Choose a layer…' }));
    for (const name of layerNames) targetSelect.append(element('option', { value: name, text: name }));
    targetSelect.value = settings.burnInTargetLayer;
    targetSelect.addEventListener('change', () => void store.patchSettings({ burnInTargetLayer: targetSelect.value }));
    targetField.append(targetSelect);
    body.append(targetField);

    const modeField = element('div', { class: 'field' });
    modeField.append(element('label', { class: 'field__label', text: 'How the text is attached' }));
    const modeSelect = element('select', { class: 'select' }) as HTMLSelectElement;
    for (const mode of ['attribute', 'label', 'geometry', 'cad', 'kml'] as BurnInMode[]) {
      modeSelect.append(element('option', { value: mode, text: BURN_IN_MODE_LABEL[mode] }));
    }
    modeSelect.value = settings.burnInMode;
    modeSelect.addEventListener('change', () => void store.patchSettings({ burnInMode: modeSelect.value as BurnInMode }));
    modeField.append(modeSelect);
    modeField.append(element('p', { class: 'small faint', text: BURN_IN_MODE_DESCRIPTION[settings.burnInMode] }));
    body.append(modeField);

    body.append(
      textField('Field name for the value', settings.burnInField, (value) => void store.patchSettings({ burnInField: value }))
    );

    const priorityField = element('div', { class: 'field' });
    priorityField.append(element('label', { class: 'field__label', text: 'When a polygon holds several texts' }));
    const prioritySelect = element('select', { class: 'select' }) as HTMLSelectElement;
    for (const priority of ['nearest-to-centre', 'largest-text', 'first-found', 'concatenate', 'named-field'] as BurnInPriority[]) {
      prioritySelect.append(element('option', { value: priority, text: PRIORITY_LABEL[priority] }));
    }
    prioritySelect.value = settings.burnInPriority;
    prioritySelect.addEventListener('change', () => void store.patchSettings({ burnInPriority: prioritySelect.value as BurnInPriority }));
    priorityField.append(prioritySelect);
    priorityField.append(
      element('p', { class: 'small faint', text: 'Whichever rule is used, the candidates it rejected are listed in the conversion report.' })
    );
    body.append(priorityField);

    body.append(
      checkbox(
        'Delete the source text after attaching it',
        settings.burnInReplaceSource,
        (value) => void store.patchSettings({ burnInReplaceSource: value }),
        'Off by default. Burn-in adds an association; it should not have to destroy the drawing it was read from.'
      )
    );
  }

  tools.append(body);
  return tools;
}

export function openSettingsDialog(): void {
  const dialog = $('settingsDialog') as HTMLDialogElement;
  const state = store.get();
  dialog.replaceChildren();

  const head = element('div', { class: 'dialog__head' });
  head.append(element('span', { class: 'dialog__title', text: 'Settings' }));
  const close = element('button', { class: 'btn btn--ghost', text: 'Close' });
  close.addEventListener('click', () => dialog.close());
  head.append(close);

  const body = element('div', { class: 'dialog__body stack' });

  body.append(element('h3', { class: 'section__title', text: 'Privacy' }));
  body.append(
    messageBlock(
      'info',
      'Conversion is local-only, and that cannot be switched off.',
      'No file byte ever leaves this machine. There is no network code in any conversion, QA, measurement or export path, and no telemetry anywhere.',
      'The only local process ever contacted is the optional DWG helper you install yourself.'
    )
  );
  // Said here rather than only next to the control, because this is the
  // section someone reads when they want to know what this tool does with
  // their data — and a claim of "nothing" with an exception elsewhere in the
  // dialog is the kind of half-truth this project exists not to tell.
  if (state.settings.basemapEnabled) {
    body.append(
      messageBlock(
        'warn',
        'The map basemap is on, so this workspace does make network requests.',
        'It asks a tile server for the map squares covering the area on screen. Those requests carry tile coordinates only — no file bytes, no file names, no attribute values — but they do tell that server roughly where you are looking.',
        'Turn it off below if the location of this survey is itself confidential.'
      )
    );
  }

  body.append(basemapSection(state));

  body.append(element('h3', { class: 'section__title', text: 'Native engine' }));
  body.append(
    keyValues([
      ['Status', NATIVE_STATUS_LABEL[state.native.status]],
      ['Detail', state.native.message],
      ['Engine', state.native.engine ? `${state.native.engine.name} ${state.native.engine.version}` : '—'],
      ['Path', state.native.engine?.path || '—'],
    ])
  );
  const rescan = element('button', { class: 'btn', text: 'Re-scan engines' });
  rescan.addEventListener('click', () => void host.refreshNative());
  body.append(rescan);

  body.append(element('h3', { class: 'section__title', text: 'Performance' }));
  body.append(
    numberField('Parallel jobs', state.settings.parallelJobs, 1, (value) => {
      const wanted = Math.max(1, Math.round(value));
      void store.patchSettings({ parallelJobs: wanted });
      configurePool(wanted);
      host.render();
    })
  );

  // What the setting actually gets, which is not always what was asked for.
  //
  // One core is reserved for the UI thread — using every core defeats the point
  // of workers — and the pool is capped at 8 because each worker holds a whole
  // file plus its intermediate representation, so memory runs out before CPU
  // does. Saying so beats a control that silently means something else.
  const pool = poolStatus();
  const cores = navigator.hardwareConcurrency ?? 4;
  body.append(
    element('p', {
      class: 'muted small',
      text:
        `Running ${pool.size} worker${pool.size === 1 ? '' : 's'} of ${cores} logical core(s): one is left free for the interface, ` +
        `and the pool is capped at 8 because each worker holds a whole file in memory. ` +
        `${pool.spawned} started so far — workers are created only when there is work for them.`,
    })
  );
  body.append(numberField('Maximum archive expansion (MB)', state.settings.maxArchiveMb, 64, (value) => void store.patchSettings({ maxArchiveMb: value })));

  body.append(element('h3', { class: 'section__title', text: 'Delivery structure' }));
  body.append(
    checkbox(
      'Mirror the input folder tree in a batch ZIP',
      state.settings.mirrorBatchTree,
      (value) => void store.patchSettings({ mirrorBatchTree: value }),
      'Each converted file is placed under the folder its source came from, so two files with the same name in different folders stay apart.'
    )
  );

  body.append(element('h3', { class: 'section__title', text: 'Naming' }));
  const naming = element('select', { class: 'select' }) as HTMLSelectElement;
  for (const [value, label] of [
    ['converted-to', '{name}_converted_to_{format}.{ext}'],
    ['target-suffix', '{name}_{format}.{ext}'],
    ['dated', '{name}_{date}_{format}.{ext}'],
  ] as [string, string][]) {
    naming.append(element('option', { value, text: label }));
  }
  naming.value = state.settings.naming;
  naming.addEventListener('change', () => void store.patchSettings({ naming: naming.value as AppSettings['naming'] }));
  body.append(naming);

  const foot = element('div', { class: 'dialog__foot' });
  const reset = element('button', { class: 'btn btn--danger', text: 'Reset to defaults' });
  reset.addEventListener('click', () => {
    void store.patchSettings({ ...DEFAULT_SETTINGS });
    dialog.close();
    host.render();
  });
  const done = element('button', { class: 'btn btn--primary', text: 'Done' });
  done.addEventListener('click', () => dialog.close());
  foot.append(reset, done);

  dialog.append(head, body, foot);
  dialog.showModal();
}

export function openHelpDialog(): void {
  const dialog = $('helpDialog') as HTMLDialogElement;
  dialog.replaceChildren();
  const head = element('div', { class: 'dialog__head' });
  head.append(element('span', { class: 'dialog__title', text: 'How this converter behaves' }));
  const close = element('button', { class: 'btn btn--ghost', text: 'Close' });
  close.addEventListener('click', () => dialog.close());
  head.append(close);

  const body = element('div', { class: 'dialog__body stack' });
  const rules: [string, string][] = [
    [
      'Your files are never uploaded',
      'Every conversion, QA check, measurement, edit and export runs in this browser, and no file byte leaves this machine on any path. Two things do reach outside it, and neither touches your data: the optional DWG helper, which is a program on your own machine, and the map basemap if you switch it on, which asks a tile server for the map squares covering the area on screen — tile coordinates only, no file bytes, names or attributes. With the basemap off, the extension makes no network request at all.',
    ],
    ['A CRS is never invented', 'If a file declares no coordinate system and the numbers are ambiguous, the conversion stops and asks. The same easting is valid in all 60 UTM zones.'],
    [
      'A CRS the format requires is applied for you',
      'KML, KMZ, GPX, OSM and GeoJSON text sequences store WGS 84 and have no field for anything else, so a projected survey is reprojected into it automatically and the transform is recorded. You are only asked for what the tool cannot work out.',
    ],
    [
      'Your CRS selection outranks the file',
      'A file can be wrong about itself — a stale .prj, or a projected GeoJSON that RFC 7946 leaves no way to label. Choosing a source CRS overrides what the file says, and the disagreement is reported rather than hidden.',
    ],
    ['Nothing is dropped silently', 'Unsupported CAD entities, lost attributes, dropped Z values and segmentized curves are all counted by name and reported.'],
    ['Curves are segmentized with a stated tolerance', 'An arc has no GIS equivalent. It is densified against a sagitta tolerance you control, never replaced by its chord.'],
    ['LAZ is refused, not guessed', 'No LAZ decoder is bundled, so compressed point data is reported honestly instead of being read as raw LAS coordinates.'],
    ['QA means re-import', 'A green PASS means the output was read back and compared with the source — not merely that bytes were written.'],
    ['Repair is off', 'Geometry repair edits your data, so it stays off until you turn it on, and reports every change it makes.'],
    [
      'An edit is replayed against the whole file, not the preview',
      'Moving, rotating, offsetting or deleting on the canvas records what you meant — "move these features by this much" — not a patch to the drawing on screen. At conversion the source file is re-read in full and your edits are re-applied to it, so nothing depends on the preview having held every feature. The queued edits are listed on the item, and the last one can be taken back or all of them discarded before you convert.',
    ],
    [
      'The canvas shows the first 5,000 features of a layer',
      'A larger layer is drawn up to that point and says so. All of it converts — the cap is on what is drawn, not on what is read or written — but a click, a rubber band or a lasso can only reach a feature that is on screen, so a selection gesture on a truncated layer reaches the first 5,000. Select the layer as a whole and the edit applies to every feature in it.',
    ],
    [
      'A backdrop that is not georeferenced is marked, not trusted',
      'A scanned plan or PDF placed behind your data with a world file or three or more control points is georeferenced, and the fit residual is reported. Placed by scaling between two points it is not: it is drawn with a dashed border, and digitising from it produces coordinates no better than that placement.',
    ],
    [
      'A digitised point is the coordinate you snapped to',
      'When a drawing tool snaps to an existing vertex, the vertex is copied exactly rather than re-derived from the pixel you clicked. Snapping to a surveyed corner gives back that corner, bit for bit, not a value rounded through the screen.',
    ],
  ];
  for (const [title, text] of rules) body.append(messageBlock('info', title, text));

  body.append(aboutSection());

  const foot = element('div', { class: 'dialog__foot' });
  const done = element('button', { class: 'btn btn--primary', text: 'Close' });
  done.addEventListener('click', () => dialog.close());
  foot.append(done);

  dialog.append(head, body, foot);
  dialog.showModal();
}

/**
 * The basemap controls.
 *
 * Off by default, and the control that turns it on states the cost in the same
 * breath. This is the only feature in the tool that touches the network, so it
 * is the only one where the user needs to make a judgement rather than just a
 * preference — a survey whose LOCATION is confidential is a real situation, and
 * only the person holding it can weigh that.
 */
function basemapSection(state: { settings: AppSettings }): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Map basemap (optional, off by default)' }));

  section.append(
    checkbox('Show map tiles behind the canvas', state.settings.basemapEnabled, (value) => {
      void store.patchSettings({ basemapEnabled: value });
      host.render();
    })
  );
  section.append(
    element('p', {
      class: 'small faint',
      text: 'Tiles are drawn under your data for context only. Nothing about the basemap affects a conversion, a measurement or an exported file, and with it off — or with no network — the tool behaves exactly as it always has.',
    })
  );

  if (!state.settings.basemapEnabled) return section;

  const providers = element('select', { class: 'select' }) as HTMLSelectElement;
  const open = element('optgroup') as HTMLOptGroupElement;
  open.label = 'No account needed';
  for (const provider of TILE_PROVIDERS) {
    open.append(element('option', { value: provider.id, text: provider.name }));
  }
  providers.append(open);
  providers.append(element('option', { value: 'custom', text: 'Custom tile service…' }));
  providers.value = state.settings.basemapProviderId;
  providers.addEventListener('change', () => {
    void store.patchSettings({ basemapProviderId: providers.value });
    host.render();
  });
  section.append(providers);

  const chosen = TILE_PROVIDERS.find((provider) => provider.id === state.settings.basemapProviderId);
  if (chosen?.note) {
    section.append(element('p', { class: 'small faint', text: `${chosen.note} · ${chosen.attribution}` }));
  }

  if (state.settings.basemapProviderId === 'custom') {
    section.append(
      textField('Tile URL template', state.settings.basemapCustomUrl, (value) => {
        void store.patchSettings({ basemapCustomUrl: value });
        host.render();
      })
    );
    const check = validateTemplate(state.settings.basemapCustomUrl);
    if (!check.ok && state.settings.basemapCustomUrl.trim()) {
      section.append(messageBlock('error', 'This template cannot be used.', check.problem));
    }

    // Presets for the services that need an account. Choosing one fills the
    // URL shape in and leaves {key} for the user's own — which is the whole
    // difference between offering a service and shipping somebody's key in a
    // public repository for every install to spend.
    section.append(element('h4', { class: 'section__subtitle', text: 'Start from a service that needs your own key' }));

    // The key is asked for HERE, next to the buttons, and substituted into the
    // template by `applyPreset`. Storing the raw template instead — which this
    // did — left a literal `{key}` in the URL box, so every tile request 404'd
    // until the user noticed the placeholder and hand-edited a URL. A field is
    // cheaper than a note telling someone to edit a URL correctly.
    let pendingKey = '';
    section.append(
      textField('Your key for the service below', pendingKey, (value) => {
        pendingKey = value;
      })
    );

    const presets = element('div', { class: 'stack' });
    for (const preset of TILE_PRESETS) {
      const row = element('div', { class: 'row' });
      const button = element('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: preset.name });
      button.addEventListener('click', () => {
        void store.patchSettings({
          basemapCustomUrl: applyPreset(preset, pendingKey),
          // Remembered so the canvas can credit this service and stop at the
          // zoom it actually serves.
          basemapPresetId: preset.id,
        });
        host.render();
      });
      row.append(button);
      row.append(element('span', { class: 'small faint', text: `${preset.note} — ${preset.signup}` }));
      presets.append(row);
    }
    section.append(presets);

    section.append(
      element('p', {
        class: 'small faint',
        text:
          'Type your key first, then press a service. The key is stored in this browser profile only — ' +
          'it is never sent anywhere except to that tile service, and it is stripped out of project files ' +
          'and reports before they are written.',
      })
    );

    section.append(
      messageBlock(
        'info',
        'Use {z}, {x} and {y} — for example https://your-server/tiles/{z}/{x}/{y}.png',
        // The honest reason Google is not in the list above. Wiring their tile
        // endpoints in directly is what most examples do, and it would put the
        // user in breach of terms they never agreed to.
        'Google and Bing are not built-in choices because their tile endpoints are not licensed for direct use outside their own APIs — a public MIT-licensed extension shipping one would put every person who installs it in breach of terms they never saw. If you hold a Google Maps Tile API key, an organisational WMTS, or a departmental imagery service, start from a preset above or paste your endpoint and it will be used under whatever terms you actually hold. For satellite imagery without any of that, Esri World Imagery in the list above is keyless.',
        'You are responsible for the terms and the attribution of a service you supply. A URL still containing {key} will not load — fill the key box above in before pressing a service, or replace the placeholder here.'
      )
    );
  }

  section.append(
    numberField('Opacity (0.1 – 1)', state.settings.basemapOpacity, 0.1, (value) => {
      // Clamped rather than trusted: 0 renders an invisible basemap that still
      // fetches every tile, which looks broken and costs the same.
      void store.patchSettings({ basemapOpacity: Math.min(1, Math.max(0.1, value)) });
      host.render();
    })
  );

  // Connectivity, stated where the control is. The basemap is the ONLY part of
  // this tool that needs a network, so "you are offline" is only ever an answer
  // to a question asked here — putting it in the top bar would imply the
  // converter itself was degraded, which it is not.
  if (!isOnline()) {
    section.append(
      messageBlock(
        'warn',
        'No internet connection — the map tiles are off.',
        'Tiles come from a tile service and cannot be drawn without one. Nothing else in this tool needs a network: detection, conversion, QA, measurement, editing and export all run on your machine and are unaffected.',
        'The basemap switches itself back on when the connection returns. Your choice of provider is remembered.'
      )
    );
  }

  section.append(
    messageBlock(
      'info',
      'The basemap needs a coordinate system it can place.',
      'Tiles are positioned by transforming each one into your data’s CRS, so a file with no declared CRS, a local site grid, or a datum with no bundled shift will show no basemap at all rather than one in the wrong place.',
      'Imagery is persuasive: a parcel that does not line up with a convincing basemap reads as a bad survey rather than a bad basemap, so this refuses instead of guessing.'
    )
  );

  return section;
}

/** Author, licence and where to send feedback. */
export const AUTHOR = 'Md Salim Ansari';
export const FEEDBACK_EMAIL = 'emailofsalim@gmail.com';

/**
 * The About block: who wrote this, under what licence, and how to reach them.
 *
 * The MIT licence requires the copyright notice to travel with the software.
 * Shipping it only as a LICENSE file in the repository satisfies that for
 * anyone who reads the repository and nobody who installs the extension, which
 * is most people — so it is stated here, where the software actually is.
 */
function aboutSection(): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'About' }));

  const version = chrome.runtime?.getManifest?.()?.version ?? '';
  section.append(
    keyValues([
      ['BhuNex GIS Converter', version ? `Version ${version}` : '—'],
      ['Author', AUTHOR],
      ['Licence', `MIT — Copyright © ${AUTHOR}`],
    ])
  );

  const feedback = element('p', { class: 'small', style: 'margin:10px 0 0' });
  feedback.append(document.createTextNode('Found something wrong, or need a format that is not here? Write to '));
  const link = element('a', {
    href: `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent('BhuNex GIS Converter feedback')}`,
    text: FEEDBACK_EMAIL,
  }) as HTMLAnchorElement;
  // A conversion that went wrong is worth more as a bug report than as a
  // workaround, so the address is a live mailto rather than text to retype.
  feedback.append(link);
  feedback.append(document.createTextNode('.'));
  section.append(feedback);

  section.append(
    element('p', {
      class: 'small faint',
      style: 'margin:8px 0 0',
      text: 'The MIT licence permits commercial and private use, modification and redistribution, provided this notice travels with the software. It carries no warranty — check every delivery against your own survey record before it leaves your desk.',
    })
  );

  return section;
}
