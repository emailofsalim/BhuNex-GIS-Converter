/**
 * KML balloon templates (spec §28.2, §28.5).
 *
 * Google Earth renders a placemark's `<description>` as HTML, which makes a KMZ
 * the most portable deliverable in mining and cadastral work: it opens on any
 * machine, needs no GIS, and can carry a full core log per hole. That is worth
 * doing properly rather than emitting a two-column property dump.
 *
 * Three rules shape this module:
 *
 *  - EVERYTHING IS ESCAPED. Values come from files this tool did not write, and
 *    the output is HTML rendered in someone else's viewer. Every value goes
 *    through `escapeHtml`, and the balloon is assembled from a fixed skeleton —
 *    no source text ever becomes markup (R23, spec §34).
 *  - NO SECRETS LEAVE. Properties whose names look like credentials are dropped
 *    before rendering and the drop is counted. A KMZ is emailed around; a token
 *    that reaches one is a token that has leaked (R23).
 *  - IT WORKS IN BOTH EARTH THEMES. Colours are chosen to hold contrast on the
 *    light and dark balloon backgrounds Google Earth uses, because a table that
 *    is unreadable at night is a table nobody trusts.
 */

import type { Borehole, BoreholeInterval } from '../survey/borehole';
import { checkLogContinuity } from '../survey/borehole';
import { CREDENTIALED_URL, stripSecrets } from '../../core/secrets';

export type KmlTemplate = 'plain' | 'cadastral' | 'survey' | 'borehole' | 'mining' | 'contour';

export const KML_TEMPLATE_LABEL: Record<KmlTemplate, string> = {
  plain: 'Plain attribute table',
  cadastral: 'Cadastral parcel',
  survey: 'Survey point',
  borehole: 'Borehole core log',
  mining: 'Mining feature',
  contour: 'Contour',
};

export const KML_TEMPLATE_DESCRIPTION: Record<KmlTemplate, string> = {
  plain: 'Every attribute, as a two-column table. The default, and never wrong.',
  cadastral: 'Plot number and area first, then tenure fields, then everything else.',
  survey: 'Point number, code and coordinates, with the elevation called out.',
  borehole: 'Collar header and a full interval log: from, to, thickness, lithology, recovery, RQD, sample and assay.',
  mining: 'Lease and bench identity first, then volumes and grades.',
  contour: 'Elevation called out, with the interval and source noted.',
};

export interface BalloonOptions {
  template: KmlTemplate;
  /** Title shown above the table. Falls back to the placemark name. */
  title?: string;
  /** Optional footer line, e.g. a survey date or a licence note. */
  footer?: string;
  /** Include a link back to a hosted report, when the caller supplies one. */
  reportUrl?: string;
}

/**
 * What must never reach a KMZ is defined once, in `core/secrets.ts`, and shared
 * with the project file and the conversion report. R23 covers every export, and
 * a rule re-implemented per writer is a rule that holds in some writers.
 */
export { stripSecrets, CREDENTIALED_URL } from '../../core/secrets';
export type { SanitisedProperties } from '../../core/secrets';

/**
 * HTML escaping for balloon content.
 *
 * Covers the quote characters as well as the angle brackets, because values are
 * also interpolated into attributes. Nothing from a source file is ever allowed
 * to become markup.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Balloon styling.
 *
 * Inline, because Google Earth strips a <style> block in some versions and
 * ignores external stylesheets entirely. Colours hold contrast on both the light
 * and dark balloon backgrounds; nothing relies on a background colour being
 * what we expect.
 */
const CSS = {
  wrap: 'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;line-height:1.45;max-width:520px;color:#1a1a1a;',
  title: 'margin:0 0 6px;font-size:15px;font-weight:600;color:#0e7c86;',
  sub: 'margin:0 0 10px;font-size:11px;color:#555;',
  table: 'border-collapse:collapse;width:100%;margin:0 0 10px;',
  th: 'text-align:left;padding:4px 6px;background:#0e7c86;color:#fff;font-weight:600;font-size:11px;white-space:nowrap;',
  td: 'padding:3px 6px;border-bottom:1px solid #d8d8d8;vertical-align:top;',
  key: 'padding:3px 6px;border-bottom:1px solid #d8d8d8;font-weight:600;white-space:nowrap;width:38%;',
  section: 'margin:10px 0 4px;font-size:12px;font-weight:600;color:#0e7c86;border-bottom:1px solid #0e7c86;padding-bottom:2px;',
  foot: 'margin:10px 0 0;font-size:10px;color:#777;',
  warn: 'margin:6px 0;padding:5px 7px;background:#fff4e5;border-left:3px solid #d97706;font-size:11px;color:#7a4a00;',
};

function row(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  return `<tr><td style="${CSS.key}">${escapeHtml(key)}</td><td style="${CSS.td}">${escapeHtml(value)}</td></tr>`;
}

function table(rows: string): string {
  return rows ? `<table style="${CSS.table}">${rows}</table>` : '';
}

/** Fields a template puts first, in this order. The rest follow alphabetically. */
const TEMPLATE_PRIORITY: Record<KmlTemplate, string[]> = {
  plain: [],
  cadastral: ['plot_no', 'khasra', 'khewat', 'khatian', 'survey_no', 'owner', 'area_m2', 'area_ha', 'tenure', 'village', 'tehsil', 'district'],
  survey: ['point', 'point_no', 'code', 'description', 'easting', 'northing', 'elevation', 'rl'],
  borehole: ['hole_id', 'holeid', 'site', 'depth', 'azimuth', 'dip', 'rl'],
  mining: ['lease', 'lease_no', 'bench', 'level', 'block', 'volume', 'tonnes', 'grade', 'mineral'],
  contour: ['elevation', 'level', 'rl', 'interval', 'source'],
};

function orderedEntries(properties: Record<string, unknown>, template: KmlTemplate): [string, unknown][] {
  const priority = TEMPLATE_PRIORITY[template];
  const normalise = (key: string) => key.toLowerCase().replace(/[\s_-]/g, '');
  const wanted = priority.map(normalise);

  const entries = Object.entries(properties).filter(([key]) => !key.startsWith('_'));
  const scored = entries.map(([key, value]) => {
    const index = wanted.indexOf(normalise(key));
    return { key, value, rank: index < 0 ? Number.MAX_SAFE_INTEGER : index };
  });

  scored.sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key));
  return scored.map((entry) => [entry.key, entry.value]);
}

export interface BalloonResult {
  html: string;
  /** Field names withheld because they looked like credentials. */
  droppedSecrets: string[];
}

/** Renders the description balloon for one feature. */
export function renderBalloon(properties: Record<string, unknown>, options: BalloonOptions): BalloonResult {
  const { safe, dropped } = stripSecrets(properties);
  const entries = orderedEntries(safe, options.template);
  if (entries.length === 0 && !options.title) return { html: '', droppedSecrets: dropped };

  const parts: string[] = [`<div style="${CSS.wrap}">`];
  if (options.title) parts.push(`<p style="${CSS.title}">${escapeHtml(options.title)}</p>`);
  parts.push(table(entries.map(([key, value]) => row(key, value)).join('')));
  if (options.reportUrl && !CREDENTIALED_URL.test(options.reportUrl)) {
    parts.push(`<p style="${CSS.foot}"><a href="${escapeHtml(options.reportUrl)}">Full report</a></p>`);
  }
  if (options.footer) parts.push(`<p style="${CSS.foot}">${escapeHtml(options.footer)}</p>`);
  parts.push('</div>');

  return { html: parts.join(''), droppedSecrets: dropped };
}

function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(decimals);
}

function assayCells(interval: BoreholeInterval, columns: string[]): string {
  return columns
    .map((column) => `<td style="${CSS.td}">${interval.assay?.[column] !== undefined ? escapeHtml(interval.assay[column]) : '—'}</td>`)
    .join('');
}

/**
 * The borehole core-log balloon (spec §28.2).
 *
 * Header, then the interval table, then any continuity problems. The continuity
 * check is part of the balloon rather than a separate report because this is
 * where a geologist actually looks at the hole: a gap between 45 m and 52 m is
 * something they need to see beside the log, not in a file they will not open.
 */
export function renderBoreholeBalloon(hole: Borehole, options: Partial<BalloonOptions> = {}): BalloonResult {
  const { safe, dropped } = stripSecrets(hole.properties);
  const parts: string[] = [`<div style="${CSS.wrap}">`];

  parts.push(`<p style="${CSS.title}">${escapeHtml(hole.holeId)}</p>`);
  if (hole.site) parts.push(`<p style="${CSS.sub}">${escapeHtml(hole.site)}</p>`);

  // --- collar header ------------------------------------------------------
  parts.push(`<div style="${CSS.section}">Collar</div>`);
  parts.push(
    table(
      [
        row('Hole ID', hole.holeId),
        hole.collar ? row('Easting', formatNumber(hole.collar[0], 3)) : '',
        hole.collar ? row('Northing', formatNumber(hole.collar[1], 3)) : '',
        row('RL', hole.rl !== null ? formatNumber(hole.rl, 3) : ''),
        row('Total depth', hole.totalDepth !== null ? `${formatNumber(hole.totalDepth, 2)} m` : ''),
        row('Azimuth', hole.azimuth !== null ? `${formatNumber(hole.azimuth, 1)}°` : ''),
        row('Dip', hole.dip !== null ? `${formatNumber(hole.dip, 1)}°` : ''),
      ].join('')
    )
  );

  // --- core log -----------------------------------------------------------
  if (hole.intervals.length > 0) {
    const assayColumns = [...new Set(hole.intervals.flatMap((interval) => Object.keys(interval.assay ?? {})))].sort();
    const hasRecovery = hole.intervals.some((interval) => interval.recovery !== undefined);
    const hasRqd = hole.intervals.some((interval) => interval.rqd !== undefined);
    const hasSample = hole.intervals.some((interval) => interval.sampleId !== undefined);
    const hasRemarks = hole.intervals.some((interval) => interval.remarks !== undefined);

    parts.push(`<div style="${CSS.section}">Core log — ${hole.intervals.length} interval(s)</div>`);

    // Only the columns that actually carry data: an empty RQD column on every
    // row of a 60-interval log is noise that pushes the lithology off-screen.
    const header =
      `<tr>` +
      `<th style="${CSS.th}">From</th><th style="${CSS.th}">To</th><th style="${CSS.th}">Thickness</th>` +
      `<th style="${CSS.th}">Lithology</th>` +
      (hasRecovery ? `<th style="${CSS.th}">Rec %</th>` : '') +
      (hasRqd ? `<th style="${CSS.th}">RQD %</th>` : '') +
      (hasSample ? `<th style="${CSS.th}">Sample</th>` : '') +
      assayColumns.map((column) => `<th style="${CSS.th}">${escapeHtml(column)}</th>`).join('') +
      (hasRemarks ? `<th style="${CSS.th}">Remarks</th>` : '') +
      `</tr>`;

    const body = hole.intervals
      .map(
        (interval) =>
          `<tr>` +
          `<td style="${CSS.td}">${formatNumber(interval.from)}</td>` +
          `<td style="${CSS.td}">${formatNumber(interval.to)}</td>` +
          `<td style="${CSS.td}">${formatNumber(interval.thickness)}</td>` +
          `<td style="${CSS.td}">${escapeHtml(interval.lithology ?? '—')}</td>` +
          (hasRecovery ? `<td style="${CSS.td}">${interval.recovery !== undefined ? formatNumber(interval.recovery, 1) : '—'}</td>` : '') +
          (hasRqd ? `<td style="${CSS.td}">${interval.rqd !== undefined ? formatNumber(interval.rqd, 1) : '—'}</td>` : '') +
          (hasSample ? `<td style="${CSS.td}">${escapeHtml(interval.sampleId ?? '—')}</td>` : '') +
          assayCells(interval, assayColumns) +
          (hasRemarks ? `<td style="${CSS.td}">${escapeHtml(interval.remarks ?? '—')}</td>` : '') +
          `</tr>`
      )
      .join('');

    parts.push(`<table style="${CSS.table}">${header}${body}</table>`);

    const continuity = checkLogContinuity(hole);
    for (const gap of continuity.gaps) {
      parts.push(
        `<p style="${CSS.warn}">Unlogged interval from ${formatNumber(gap.from)} m to ${formatNumber(gap.to)} m — ${formatNumber(gap.to - gap.from)} m with no record.</p>`
      );
    }
    for (const overlap of continuity.overlaps) {
      parts.push(
        `<p style="${CSS.warn}">Overlapping records from ${formatNumber(overlap.from)} m to ${formatNumber(overlap.to)} m — two intervals claim the same depth.</p>`
      );
    }
  } else {
    parts.push(`<p style="${CSS.warn}">No interval log was found for this hole.</p>`);
  }

  // --- anything else on the collar record ---------------------------------
  const consumed = new Set(
    Object.keys(safe).filter((key) => {
      const lower = key.toLowerCase().replace(/[\s_-]/g, '');
      return ['holeid', 'easting', 'northing', 'rl', 'depth', 'totaldepth', 'azimuth', 'dip', 'site'].includes(lower);
    })
  );
  const extras = Object.entries(safe).filter(([key]) => !consumed.has(key) && !key.startsWith('_'));
  if (extras.length > 0) {
    parts.push(`<div style="${CSS.section}">Other collar fields</div>`);
    parts.push(table(extras.map(([key, value]) => row(key, value)).join('')));
  }

  if (options.reportUrl && !CREDENTIALED_URL.test(options.reportUrl)) {
    parts.push(`<p style="${CSS.foot}"><a href="${escapeHtml(options.reportUrl)}">Full report</a></p>`);
  }
  if (options.footer) parts.push(`<p style="${CSS.foot}">${escapeHtml(options.footer)}</p>`);
  parts.push('</div>');

  return { html: parts.join(''), droppedSecrets: dropped };
}

/** Wraps balloon HTML in the CDATA a KML `<description>` needs. */
export function descriptionElement(html: string): string {
  if (!html) return '';
  // `]]>` inside the content would close the CDATA early and break the file.
  return `<description><![CDATA[${html.replace(/]]>/g, ']]&gt;')}]]></description>`;
}
