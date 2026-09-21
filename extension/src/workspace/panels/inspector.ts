/** The read-only inspector tabs: overview, geometry, CRS and column mapping. */

import { CONFIRM_THRESHOLD } from '../../core/detect';
import { FORMATS } from '../../core/registry';
import { validateShift, type DatumShift } from '../../crs/datum';
import { crsFromEpsg, QUICK_ZONES, searchEpsg, utmCrs } from '../../crs/epsg';
import { crsLabel, isWgs84Family } from '../../crs/transform';
import type { ColumnMapping, ColumnRole } from '../../core/cir';
import { type QueueItem, store } from '../../state/store';
import { inspectItem } from '../conversion';
import { element, formatBytes, ghostButton, keyValues, messageBlock, numberField, textField } from '../dom';
import { host } from '../host';
import { clearTargetCrsRemedy } from '../remedies';
import { assignSourceCrs } from './history';

export function overviewTab(item: QueueItem): HTMLElement[] {
  const dataset = item.dataset;
  const nodes: HTMLElement[] = [];

  if (item.status === 'blocked' && item.detection) {
    const block = messageBlock(
      'warn',
      `Detected as ${item.detection.formatName} with ${(item.detection.confidence * 100).toFixed(0)}% confidence.`,
      `That is below the ${(CONFIRM_THRESHOLD * 100).toFixed(0)}% threshold, so the format has to be confirmed before converting.`,
      'Pick the correct source format below.'
    );
    const select = element('select', { class: 'select', style: 'margin-top:8px' }) as HTMLSelectElement;
    select.append(element('option', { value: '', text: 'Confirm source format…' }));
    for (const format of FORMATS.filter((candidate) => candidate.support.import !== 'none')) {
      select.append(element('option', { value: format.id, text: `${format.name} (.${format.extensions[0]})` }));
    }
    select.addEventListener('change', () => {
      if (!select.value) return;
      store.updateItem(item.id, { forcedFormatId: select.value });
      void inspectItem(item.id);
    });
    block.querySelector('.msg__body')?.append(select);
    nodes.push(block);
  }

  if (!dataset) return nodes;

  const pairs: [string, string][] = [
    ['File', item.fileName],
    ['Size', formatBytes(item.size)],
    ['Detected', `${item.detection?.formatName ?? '—'}`],
    ['Confidence', item.detection ? `${(item.detection.confidence * 100).toFixed(0)}%` : '—'],
    ['Data kind', dataset.kind],
    ['CRS', crsLabel(dataset.crs)],
    ['CRS source', dataset.crsOrigin],
    ['Units', dataset.units ?? 'not declared'],
    ['Coordinate order', dataset.axisOrder],
    ['Vertical reference', dataset.vertical?.kind ?? 'unknown'],
  ];

  if (dataset.pointcloud) {
    const cloud = dataset.pointcloud;
    pairs.push(
      ['Total points', cloud.count.toLocaleString()],
      ['Loaded points', cloud.loaded.toLocaleString()],
      ['LAS version', cloud.version ?? '—'],
      ['Point format', String(cloud.pointFormat ?? '—')],
      ['Z range', cloud.bounds ? `${cloud.bounds.minZ.toFixed(3)} → ${cloud.bounds.maxZ.toFixed(3)}` : '—'],
      ['Attributes', Object.entries(cloud.attributes).filter(([, on]) => on).map(([name]) => name).join(', ') || 'none']
    );
  } else if (dataset.raster) {
    const raster = dataset.raster;
    pairs.push(
      ['Dimensions', `${raster.width} × ${raster.height} px`],
      ['Bands', String(raster.bandCount)],
      ['Pixel type', raster.pixelType],
      ['Pixel size', raster.geotransform ? `${Math.abs(raster.geotransform[1])} × ${Math.abs(raster.geotransform[5])}` : 'not georeferenced'],
      ['NoData', raster.noData === null ? 'none' : String(raster.noData)],
      ['Raster type', raster.isElevation ? 'elevation / DEM' : 'image'],
      ['Pixel data', raster.hasPixelData ? 'decoded' : 'not decoded — georeference only']
    );
  } else if (dataset.table) {
    pairs.push(
      ['Rows', dataset.table.rowCount.toLocaleString()],
      ['Columns', String(dataset.table.columns.length)],
      ['Detected schema', dataset.table.detectedSchema ?? 'none matched'],
      ['Header row', dataset.table.hasHeader ? 'yes' : 'no']
    );
  } else {
    const features = (dataset.layers ?? []).reduce((sum: number, layer: any) => sum + layer.featureCount, 0);
    pairs.push(['Layers', String(dataset.layers?.length ?? 0)], ['Features', features.toLocaleString()]);
  }

  nodes.push(keyValues(pairs));
  return nodes;
}

export function geometryTab(item: QueueItem): HTMLElement[] {
  const dataset = item.dataset;
  if (!dataset?.layers?.length) return [element('p', { class: 'muted', style: 'padding:16px', text: 'No vector layers in this dataset.' })];
  const table = element('table', { class: 'table' });
  table.append(
    element('thead', {}, [
      element('tr', {}, [
        element('th', { text: 'Layer' }),
        element('th', { text: 'Features' }),
        element('th', { text: 'Geometry types' }),
        element('th', { text: 'Fields' }),
      ]),
    ])
  );
  const body = element('tbody');
  for (const layer of dataset.layers) {
    body.append(
      element('tr', {}, [
        element('td', { text: layer.name }),
        // `?? 0` guards the render, it does not excuse a missing count: an
        // undefined here threw and aborted the whole inspector render, which is
        // how a shape mismatch upstream (see `workers/summarise.ts`) presented
        // as a blank panel rather than as the wrong number it actually was.
        element('td', { class: 'num', text: (layer.featureCount ?? 0).toLocaleString() }),
        element('td', { text: layer.geometryTypes.join(', ') || '—' }),
        element('td', { class: 'num', text: String(layer.fields.length) }),
      ])
    );
  }
  table.append(body);
  return [element('div', { class: 'scroll-x' }, [table])];
}

export function crsTab(item: QueueItem): HTMLElement[] {
  const state = store.get();
  const dataset = item.dataset;
  const nodes: HTMLElement[] = [];

  nodes.push(
    keyValues([
      ['CRS', crsLabel(dataset?.crs ?? null)],
      ['Origin', ORIGIN_LABEL[dataset?.crsOrigin ?? 'unknown']],
      ['Axis order (authority)', dataset?.crs?.axisOrder ?? '—'],
      ['Datum', dataset?.crs?.datum ?? '—'],
      ['Projection', dataset?.crs?.projection ?? '—'],
      ['Linear unit', dataset?.crs?.unit ?? '—'],
    ])
  );

  // An assumed CRS is the one worth interrupting for: the file said nothing,
  // the standard filled it in, and nothing about the display would otherwise
  // distinguish that from a file that stated its own grid.
  if (dataset?.crsOrigin === 'assumed') {
    nodes.push(
      messageBlock(
        'warn',
        `Nothing in this file states a CRS. ${crsLabel(dataset.crs)} comes from the format's specification, not from the data.`,
        'A projected export from QGIS looks exactly like this, because RFC 7946 removed the member it would have used to say so. Set the source CRS below if these coordinates are not degrees.'
      )
    );
  }

  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Source CRS' }));
  section.append(
    element('p', {
      class: 'small faint',
      text: 'A selection here outranks the file. Leave it unset to use what the file states.',
    })
  );
  section.append(crsSelect(state.settings.sourceCrsEpsg, (epsg) => void assignSourceCrs(item.id, epsg)));
  nodes.push(section);

  const targetSection = element('div', { class: 'section' });
  targetSection.append(element('h3', { class: 'section__title', text: 'Target CRS' }));

  // What the chosen target format will do on its own, said before the
  // conversion rather than discovered in the warnings afterwards.
  const targetId = item.targetFormatId ?? state.settings.globalTargetFormatId;
  const targetFormat = targetId ? FORMATS.find((format) => format.id === targetId) : undefined;
  const imposedEpsg = targetFormat && !targetFormat.supportsCRS ? targetFormat.limits?.mandatesCrsEpsg : undefined;

  if (imposedEpsg !== undefined && !state.settings.targetCrsEpsg) {
    targetSection.append(
      messageBlock(
        'info',
        `${targetFormat!.name} stores its coordinates in ${crsLabel(crsFromEpsg(imposedEpsg))}, so the conversion reprojects into it automatically.`,
        'There is no field anywhere in this format in which a different CRS could be recorded, so leaving this unset is the right choice for it.'
      )
    );
  } else if (imposedEpsg !== undefined && state.settings.targetCrsEpsg && state.settings.targetCrsEpsg !== imposedEpsg) {
    // THE CONFLICT, SAID BEFORE THE CONVERSION RATHER THAN AFTER IT.
    //
    // The target CRS is one global setting shared by the whole queue, so a CRS
    // set for a site grid while working on a DXF is still set when a KMZ is
    // selected an hour later. The pipeline refuses that export — correctly, it
    // cannot record the CRS — but by then the user is reading a red block on a
    // file that is not the file they changed the setting for. Here it is a
    // warning attached to the control that causes it.
    targetSection.append(
      messageBlock(
        'warn',
        `${targetFormat!.name} cannot be written in EPSG:${state.settings.targetCrsEpsg}, so this export will be refused.`,
        `It stores coordinates in ${crsLabel(crsFromEpsg(imposedEpsg))} and has no field in which to record any other, so a reader would take whatever is written for longitude and latitude. The target CRS is one setting for the whole queue — it may have been set for a different file.`,
        undefined,
        clearTargetCrsRemedy(null)
      )
    );
  }

  targetSection.append(crsSelect(state.settings.targetCrsEpsg, (epsg) => void store.patchSettings({ targetCrsEpsg: epsg })));
  targetSection.append(
    element('p', {
      class: 'small faint',
      style: 'margin-top:8px',
      text:
        imposedEpsg !== undefined
          ? `Leave unset unless you need something other than EPSG:${imposedEpsg} — and note that ${targetFormat!.name} cannot record what you pick, so a conflicting choice is refused rather than written.`
          : 'Leave unset to keep the source CRS. A datum shift outside the WGS 84 family is refused rather than approximated — reproject those in QGIS or GDAL first.',
    })
  );
  nodes.push(targetSection);
  nodes.push(datumSection(dataset));

  return nodes;
}

/**
 * Where the user supplies Helmert parameters for a datum nothing is bundled for.
 *
 * Shown only when it is relevant — a datum outside the WGS 84 family — because
 * seven empty numeric fields on every file would invite someone to fill them in
 * for a conversion that does not need them, and a shift applied where none is
 * required moves the data by the size of the translation.
 */
function datumSection(dataset: QueueItem['dataset']): HTMLElement {
  const section = element('div', { class: 'section' });
  const state = store.get();
  const datum: string = dataset?.crs?.datum ?? '';
  const needsShift = datum !== '' && !isWgs84Family(dataset?.crs ?? null);

  if (!needsShift) {
    section.append(element('h3', { class: 'section__title', text: 'Datum' }));
    section.append(
      element('p', {
        class: 'small faint',
        text: datum
          ? `${datum} is in the WGS 84 family, so no datum shift is needed — reprojection between these is exact.`
          : 'No datum is declared, so no shift can be assessed.',
      })
    );
    return section;
  }

  section.append(element('h3', { class: 'section__title', text: `Datum shift for ${datum}` }));
  section.append(
    messageBlock(
      'warn',
      `${datum} is not in the WGS 84 family, so transforming out of it needs seven Helmert parameters.`,
      'None are bundled for it, deliberately: published values for a datum differ by tens of metres between adjustments and regions, and a wrong set does not fail — it produces coordinates that look entirely reasonable and put a boundary somewhere it is not.',
      'Enter the set your survey authority publishes. It is recorded with every conversion, along with the accuracy you state for it.'
    )
  );

  const shift = state.settings.datumShift;
  const field = (label: string, key: keyof DatumShift, value: number) =>
    numberField(label, value, 0.000001, (next) => {
      const base: DatumShift = shift ?? {
        name: `${datum} → WGS 84`,
        tx: 0,
        ty: 0,
        tz: 0,
        rxArcsec: 0,
        ryArcsec: 0,
        rzArcsec: 0,
        scalePpm: 0,
        accuracyMetres: null,
        source: '',
        convention: 'position-vector',
      };
      void store.patchSettings({ datumShift: { ...base, [key]: next } as DatumShift });
      host.render();
    });

  section.append(field('Translation X (metres)', 'tx', shift?.tx ?? 0));
  section.append(field('Translation Y (metres)', 'ty', shift?.ty ?? 0));
  section.append(field('Translation Z (metres)', 'tz', shift?.tz ?? 0));
  // Units are in every label because these are the two errors that produce a
  // confident wrong answer: arcseconds read as radians, ppm read as a ratio.
  section.append(field('Rotation X (arcseconds)', 'rxArcsec', shift?.rxArcsec ?? 0));
  section.append(field('Rotation Y (arcseconds)', 'ryArcsec', shift?.ryArcsec ?? 0));
  section.append(field('Rotation Z (arcseconds)', 'rzArcsec', shift?.rzArcsec ?? 0));
  section.append(field('Scale (parts per million)', 'scalePpm', shift?.scalePpm ?? 0));
  section.append(
    field('Stated accuracy (metres, 0 if unknown)', 'accuracyMetres', shift?.accuracyMetres ?? 0)
  );

  const conventionField = element('div', { class: 'field' });
  conventionField.append(element('label', { class: 'field__label', text: 'Rotation convention' }));
  const conventionSelect = element('select', { class: 'select' }) as HTMLSelectElement;
  conventionSelect.append(element('option', { value: 'position-vector', text: 'Position vector (EPSG 1033 / 9606)' }));
  conventionSelect.append(element('option', { value: 'coordinate-frame', text: 'Coordinate frame (EPSG 1032 / 9607)' }));
  conventionSelect.value = shift?.convention ?? 'position-vector';
  conventionSelect.addEventListener('change', () => {
    if (!shift) return;
    void store.patchSettings({ datumShift: { ...shift, convention: conventionSelect.value as DatumShift['convention'] } });
    host.render();
  });
  conventionField.append(conventionSelect);
  conventionField.append(
    element('p', {
      class: 'small faint',
      text: 'The two differ only in the sign of the rotations, and getting it wrong displaces the result by a few metres — which reads as ordinary datum noise rather than as a mistake. Any published set states which it is.',
    })
  );
  section.append(conventionField);

  section.append(
    textField('Source of these parameters', shift?.source ?? '', (value) => {
      if (!shift) return;
      void store.patchSettings({ datumShift: { ...shift, source: value } });
    })
  );

  if (shift) {
    const check = validateShift(shift);
    if (!check.ok) section.append(messageBlock('error', 'These parameters cannot be used.', check.problem));
    else if (!shift.source.trim()) {
      section.append(
        messageBlock(
          'warn',
          'Record where these parameters came from.',
          'It is written into the conversion manifest, and it is what lets someone reading the delivery in two years judge whether the coordinates can be trusted.'
        )
      );
    }
  }

  return section;
}

/** Plain-language names for `CrsOrigin`, which is otherwise a bare enum word. */
const ORIGIN_LABEL: Record<string, string> = {
  declared: 'Declared by the file',
  sidecar: 'Read from a sidecar (.prj)',
  assumed: 'Assumed from the format specification — the file states nothing',
  user: 'Selected by you',
  inferred: 'Inferred from the coordinate ranges',
  unknown: 'Unknown',
};

export function crsSelect(current: number | null, onChange: (epsg: number | null) => void): HTMLElement {
  const wrap = element('div', { class: 'stack' });
  const search = element('input', { class: 'input', type: 'search', placeholder: 'Search EPSG code or name…' }) as HTMLInputElement;
  const select = element('select', { class: 'select' }) as HTMLSelectElement;

  const fill = (query: string) => {
    select.replaceChildren();
    select.append(element('option', { value: '', text: 'Not set' }));
    // Indian UTM zones first: they cover this product's primary field of use.
    const quick = QUICK_ZONES.map((zone) => utmCrs(zone, false));
    if (!query) {
      const group = element('optgroup', { label: 'Common UTM zones (India)' });
      for (const crs of quick) group.append(element('option', { value: String(crs.epsg), text: `EPSG:${crs.epsg} — ${crs.name}` }));
      select.append(group);
      const common = element('optgroup', { label: 'Common' });
      for (const code of [4326, 3857]) {
        const crs = crsFromEpsg(code)!;
        common.append(element('option', { value: String(code), text: `EPSG:${code} — ${crs.name}` }));
      }
      select.append(common);
    }
    const results = element('optgroup', { label: query ? 'Search results' : 'All bundled CRS' });
    for (const entry of searchEpsg(query, 60)) {
      results.append(element('option', { value: String(entry.code), text: `EPSG:${entry.code} — ${entry.name}` }));
    }
    select.append(results);
    select.value = current ? String(current) : '';
  };

  fill('');
  search.addEventListener('input', () => fill(search.value));
  select.addEventListener('change', () => {
    onChange(select.value ? Number(select.value) : null);
    host.render();
  });

  wrap.append(search, select);
  return wrap;
}

/** Column mapping with a preview table, as instruction §E requires. */
/**
 * The roles a column can carry, in the order a surveyor thinks about them.
 *
 * `ignore` is not offered as a role to assign: leaving a column unassigned is
 * how a column is ignored, and two ways to say the same thing in one panel is
 * one way too many.
 */
const MAPPABLE_ROLES: { role: Exclude<ColumnRole, 'ignore'>; label: string; hint: string }[] = [
  { role: 'easting', label: 'Easting / X', hint: 'The eastward coordinate on a projected grid, in the grid’s own linear units.' },
  { role: 'northing', label: 'Northing / Y', hint: 'The northward coordinate. On UTM this is the seven-digit one.' },
  { role: 'longitude', label: 'Longitude', hint: 'Degrees east of Greenwich, between −180 and 180.' },
  { role: 'latitude', label: 'Latitude', hint: 'Degrees north of the equator, between −90 and 90.' },
  { role: 'elevation', label: 'Elevation / Z', hint: 'Height, in the same linear unit as the grid unless the file says otherwise.' },
  { role: 'id', label: 'Point ID', hint: 'The station or pillar number. Carried through as an attribute.' },
  { role: 'code', label: 'Code', hint: 'Feature code — BP, TP, CH and so on. Carried through as an attribute.' },
  { role: 'description', label: 'Description', hint: 'Free text. Carried through as an attribute.' },
];

/** The axis order implied by which pair of roles the user has filled in. */
function orderFor(roles: ColumnMapping['roles']): ColumnMapping['coordinateOrder'] {
  if (roles.longitude !== undefined || roles.latitude !== undefined) {
    return (roles.longitude ?? Infinity) < (roles.latitude ?? Infinity) ? 'lon-lat' : 'lat-lon';
  }
  return (roles.easting ?? Infinity) < (roles.northing ?? Infinity) ? 'easting-northing' : 'northing-easting';
}

/**
 * Column mapping: what was detected, and how to disagree with it.
 *
 * WHY THIS IS EDITABLE NOW
 *
 * It used to report the detected mapping and stop. That is fine while detection
 * is right, and detection is right for an ordinary survey export — but the
 * trial produced the case that proves the panel needed more: a file whose real
 * header sat under a title banner mapped its columns BY POSITION, put the
 * northing in X, and wrote 188 pillars 2,600 km off. Detection is better now
 * and that exact file is pinned by a test, but "the detector improved" is not
 * the same as "the surveyor can correct it". A reader that cannot be overruled
 * is a reader you have to trust blindly.
 *
 * WHY A DROPDOWN PER ROLE, NOT PER COLUMN
 *
 * A table can have forty columns and six roles. Asking "what is this column?"
 * forty times is forty decisions, most of them "nothing". Asking "which column
 * is the easting?" is six decisions, each of which the user already knows the
 * answer to — and it makes the important constraint expressible: a role can be
 * filled at most once, which a per-column list cannot enforce without
 * validation after the fact.
 */
export function columnMappingPanel(item: QueueItem): HTMLElement {
  const table = item.dataset.table;
  const wrap = element('div');
  const active: ColumnMapping | null = item.columnMapping ?? table.mapping ?? null;
  const userSet = Boolean(item.columnMapping);

  if (active) {
    const roles = Object.entries(active.roles)
      .filter(([, index]) => index !== undefined)
      .map(([role, index]) => `${role} → column ${Number(index) + 1} (${table.columns[Number(index)]?.name ?? '?'})`)
      .join('\n');
    wrap.append(
      messageBlock(
        userSet ? 'info' : item.status === 'blocked' ? 'warn' : 'info',
        userSet
          ? `Mapping set by you · coordinate order ${active.coordinateOrder}`
          : `Schema: ${table.detectedSchema ?? 'user-defined'} · coordinate order ${active.coordinateOrder}`,
        roles,
        userSet ? 'Detection is overridden for this file. Reset below to go back to it.' : item.dataset.metadata?.schemaRationale
      )
    );
  } else {
    wrap.append(messageBlock('error', 'No coordinate columns identified.', 'Geometry cannot be built until easting/northing or longitude/latitude are named.', 'Pick the columns below.'));
  }

  wrap.append(mappingEditor(item, table, active));

  const preview = element('table', { class: 'table' });
  preview.append(
    element('thead', {}, [
      element(
        'tr',
        {},
        table.columns.map((column: any, index: number) => {
          const role = Object.entries(table.mapping?.roles ?? {}).find(([, columnIndex]) => columnIndex === index)?.[0];
          return element('th', { text: role ? `${column.name} · ${role}` : column.name });
        })
      ),
    ])
  );
  const body = element('tbody');
  for (const row of table.previewRows.slice(0, 12)) {
    body.append(element('tr', {}, row.map((cell: unknown) => element('td', { class: 'mono', text: cell === null ? '' : String(cell) }))));
  }
  preview.append(body);
  wrap.append(element('div', { class: 'scroll-x' }, [preview]));
  wrap.append(element('p', { class: 'small faint', style: 'padding:0 12px 12px', text: `${table.rowCount.toLocaleString()} rows total; first ${Math.min(12, table.previewRows.length)} shown.` }));
  return wrap;
}

/**
 * One dropdown per role, plus the sanity check that makes the panel worth
 * having.
 *
 * The check is the point. A mapping the user sets is applied without argument —
 * it is their data and their grid — but a pair of columns whose values cannot
 * be what the role says they are is worth saying out loud BEFORE the conversion
 * runs, because that is the mistake that produces a file which opens cleanly in
 * the wrong hemisphere.
 */
function mappingEditor(item: QueueItem, table: any, active: ColumnMapping | null): HTMLElement {
  const section = element('div', { class: 'section' });
  section.append(element('h3', { class: 'section__title', text: 'Column mapping' }));
  section.append(
    element('p', {
      class: 'small faint',
      text: 'Detected automatically. Change any row to overrule it for this file — other files in the queue keep their own mapping.',
    })
  );

  const roles: ColumnMapping['roles'] = { ...(active?.roles ?? {}) };

  const commit = (): void => {
    const next: ColumnMapping = { roles, coordinateOrder: orderFor(roles), schemaId: 'user' };
    store.updateItem(item.id, { columnMapping: next });
    store.log('info', `${item.fileName}: column mapping set by hand (${next.coordinateOrder}).`);
    void inspectItem(item.id);
  };

  for (const { role, label, hint } of MAPPABLE_ROLES) {
    const field = element('div', { class: 'field' });
    const caption = element('label', { class: 'field__label', text: label });
    caption.append(element('span', { class: 'hint', text: '?', title: hint }));
    field.append(caption);

    const select = element('select', { class: 'select' }) as HTMLSelectElement;
    select.append(element('option', { value: '', text: '— not in this file —' }));
    table.columns.forEach((column: any, index: number) => {
      const sample = table.previewRows[0]?.[index];
      const shown = sample === null || sample === undefined ? '' : ` · e.g. ${String(sample).slice(0, 14)}`;
      select.append(element('option', { value: String(index), text: `${index + 1}. ${column.name}${shown}` }));
    });
    select.value = roles[role] === undefined ? '' : String(roles[role]);
    select.addEventListener('change', () => {
      const chosen = select.value === '' ? undefined : Number(select.value);
      // A column can only carry one role. Claiming one that another role holds
      // takes it, rather than leaving the table describing itself two ways.
      if (chosen !== undefined) {
        for (const key of Object.keys(roles) as (keyof typeof roles)[]) {
          if (roles[key] === chosen) delete roles[key];
        }
        roles[role] = chosen;
      } else {
        delete roles[role];
      }
      commit();
    });
    field.append(select);
    section.append(field);
  }

  const complaint = magnitudeComplaint(table, roles);
  if (complaint) section.append(messageBlock('warn', complaint.what, complaint.why, complaint.action));

  if (item.columnMapping) {
    section.append(
      ghostButton('Reset to the detected mapping', () => {
        store.updateItem(item.id, { columnMapping: undefined });
        store.log('info', `${item.fileName}: column mapping reset to detection.`);
        void inspectItem(item.id);
      })
    );
  }
  return section;
}

/**
 * Reads the numbers under the chosen columns and says when they contradict the
 * role they have been given.
 *
 * Deliberately a WARNING and not a refusal. The user may know something the
 * numbers do not show — a local grid with small coordinates, a file in feet.
 * But "every value in your longitude column is above 180" is the single check
 * that would have caught the swap in the trial, and it costs one pass over
 * twelve preview rows.
 */
function magnitudeComplaint(
  table: any,
  roles: ColumnMapping['roles']
): { what: string; why: string; action: string } | null {
  const column = (index: number | undefined): number[] => {
    if (index === undefined) return [];
    return table.previewRows
      .map((row: any[]) => Number(row[index]))
      .filter((value: number) => Number.isFinite(value));
  };

  const lon = column(roles.longitude);
  const lat = column(roles.latitude);
  if (lon.length && lon.some((v) => Math.abs(v) > 180)) {
    return {
      what: 'The longitude column holds values outside ±180°.',
      why: `Largest seen: ${Math.max(...lon.map(Math.abs)).toLocaleString()}. Degrees cannot exceed 180, so this column is probably a projected easting.`,
      action: 'Map it to Easting / X instead, and set the grid on the CRS panel.',
    };
  }
  if (lat.length && lat.some((v) => Math.abs(v) > 90)) {
    return {
      what: 'The latitude column holds values outside ±90°.',
      why: `Largest seen: ${Math.max(...lat.map(Math.abs)).toLocaleString()}. This column is probably a projected northing.`,
      action: 'Map it to Northing / Y instead, and set the grid on the CRS panel.',
    };
  }

  // The trial's own failure, stated as a rule: on a UTM grid the northing is
  // the larger number by roughly a factor of ten. Swapped, it still converts,
  // and the result is a file nobody can tell is wrong by looking at it.
  const east = column(roles.easting);
  const north = column(roles.northing);
  if (east.length && north.length) {
    const e = Math.abs(east[0]);
    const n = Math.abs(north[0]);
    if (e > 1_000_000 && n < 1_000_000 && e > n) {
      return {
        what: 'Easting and northing may be the wrong way round.',
        why: `The first row reads easting ${e.toLocaleString()}, northing ${n.toLocaleString()}. On a UTM grid an easting has six digits and a northing seven, so these look swapped.`,
        action: 'Check the two rows above against the file. If they are swapped, exchange the two columns here.',
      };
    }
  }
  return null;
}
