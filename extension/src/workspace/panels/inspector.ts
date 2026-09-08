/** The read-only inspector tabs: overview, geometry, CRS and column mapping. */

import { CONFIRM_THRESHOLD } from '../../core/detect';
import { FORMATS } from '../../core/registry';
import { crsFromEpsg, QUICK_ZONES, searchEpsg, utmCrs } from '../../crs/epsg';
import { crsLabel } from '../../crs/transform';
import { type QueueItem, store } from '../../state/store';
import { inspectItem } from '../conversion';
import { element, formatBytes, keyValues, messageBlock } from '../dom';
import { host } from '../host';
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
        element('td', { class: 'num', text: layer.featureCount.toLocaleString() }),
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

  return nodes;
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
export function columnMappingPanel(item: QueueItem): HTMLElement {
  const table = item.dataset.table;
  const wrap = element('div');

  if (table.mapping) {
    const roles = Object.entries(table.mapping.roles)
      .map(([role, index]) => `${role} → column ${Number(index) + 1} (${table.columns[Number(index)]?.name ?? '?'})`)
      .join('\n');
    wrap.append(
      messageBlock(
        item.status === 'blocked' ? 'warn' : 'info',
        `Schema: ${table.detectedSchema ?? 'user-defined'} · coordinate order ${table.mapping.coordinateOrder}`,
        roles,
        item.dataset.metadata?.schemaRationale
      )
    );
  } else {
    wrap.append(messageBlock('error', 'No coordinate columns identified.', 'Geometry cannot be built until easting/northing or longitude/latitude are named.', 'Pick the columns below.'));
  }

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
