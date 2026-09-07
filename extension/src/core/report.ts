/**
 * The per-conversion report (spec §22.4).
 *
 * Source, processing, output, fidelity per axis and QA, rendered for one file.
 * The batch manifest already carries most of these fields across many files;
 * this is the same data for one, in a document that can be attached to a
 * delivery and read by someone who does not have this tool.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS SELF-CONTAINED HTML
 *
 * A report that needs a stylesheet from a CDN is a report that renders as
 * unstyled text on the machine it matters on, and rule R15 forbids the remote
 * fetch anyway. So the CSS is inline, there is no script, and no image is
 * referenced. The file opens in any browser, on any machine, offline, for as
 * long as the delivery is kept — which for a survey record is decades.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES IT SHARES WITH THE REST OF THE TOOL
 *
 *  - EVERY VALUE IS ESCAPED. Layer names, field names and file names come from
 *    files this tool did not write, and the output is HTML someone else opens.
 *    The document is assembled from a fixed skeleton; no source text ever
 *    becomes markup.
 *  - NO CREDENTIALS (R23). The report carries settings and metadata, and a
 *    delivery gets forwarded. Everything goes through `stripSecretsDeep` first
 *    and the omission is stated in the document rather than left silent.
 *
 * A report that says "PASS" and nothing else would be decoration. Every section
 * carries the measured number and the tolerance it was judged against, which is
 * what a surveyor signs against.
 */

import type { CirDataset, Warning } from './cir';
import type { DiffReport } from '../qa/diff';
import type { FidelityPrediction } from './predict';
import type { ProjectHealth } from '../qa/health';
import { AXIS_LABEL } from './predict';
import { DIFF_AXIS_LABEL } from '../qa/diff';
import { ENGINE_VERSION, featureCount } from './cir';
import { stripSecretsDeep } from './secrets';

export interface ReportInput {
  /** The source as it was read. */
  dataset: CirDataset;
  sourceFileName: string;
  sourceFormatName: string;
  sourceSizeBytes: number;
  sha256?: string;
  detectionConfidence?: number;

  targetFormatName?: string;
  /** Paths inside the delivery, as the layout engine planned them. */
  outputPaths?: string[];
  outputSizeBytes?: number;
  /** The output read back during QA, when there was one. */
  outputDataset?: CirDataset;

  /** What the pre-flight predicted this conversion would cost. */
  prediction?: FidelityPrediction;
  /** Measured source-versus-output differences. */
  diff?: DiffReport;
  /** The QA verdict, as `qa/fidelity.ts` produced it. */
  qaVerdict?: string;
  qaSummary?: string;
  /** The health assessment, when one was run. */
  health?: ProjectHealth;

  /** Operations applied, in order, from the history. */
  processing?: { label: string; detail?: string }[];
  warnings?: Warning[];
  /** Settings the conversion ran with. Scrubbed before it is written. */
  settings?: Record<string, unknown>;

  durationMs?: number;
  /** Fixed clock for tests; defaults to now. */
  now?: Date;
}

export interface ConversionReport {
  title: string;
  generatedAt: string;
  /** Field names removed as credential-shaped (R23). */
  droppedSecretFields: string[];
  html: string;
  text: string;
}

export function buildReport(input: ReportInput): ConversionReport {
  const dropped: string[] = [];
  const settings = input.settings ? (stripSecretsDeep(input.settings, dropped) as Record<string, unknown>) : undefined;
  const generatedAt = (input.now ?? new Date()).toISOString();
  const title = `Conversion report — ${input.sourceFileName}`;

  const sections = buildSections(input, settings, [...new Set(dropped)].sort());

  return {
    title,
    generatedAt,
    droppedSecretFields: [...new Set(dropped)].sort(),
    html: renderHtml(title, generatedAt, sections),
    text: renderText(title, generatedAt, sections),
  };
}

interface Row {
  label: string;
  value: string;
  /** Extra line under the value, for a tolerance or a caveat. */
  note?: string;
  tone?: 'ok' | 'warn' | 'fail' | 'muted';
}

interface Section {
  heading: string;
  /** One line under the heading, when the section needs framing. */
  lead?: string;
  rows?: Row[];
  /** A table with its own header, for the per-axis grids. */
  table?: { header: string[]; rows: { cells: string[]; tone?: Row['tone'] }[] };
  /** Plain paragraphs. */
  notes?: string[];
  list?: { text: string; tone?: Row['tone'] }[];
}

function buildSections(input: ReportInput, settings: Record<string, unknown> | undefined, dropped: string[]): Section[] {
  const sections: Section[] = [];
  const dataset = input.dataset;
  const total = featureCount(dataset);

  // ---- source -------------------------------------------------------------
  sections.push({
    heading: 'Source',
    rows: [
      { label: 'File', value: input.sourceFileName },
      { label: 'Format', value: input.sourceFormatName },
      { label: 'Size', value: formatBytes(input.sourceSizeBytes) },
      ...(input.sha256 ? [{ label: 'SHA-256', value: input.sha256 }] : []),
      ...(input.detectionConfidence !== undefined
        ? [{ label: 'Detection confidence', value: `${Math.round(input.detectionConfidence * 100)}%` }]
        : []),
      { label: 'CRS', value: describeCrs(dataset), note: crsOriginNote(dataset) },
      { label: 'Units', value: dataset.units ?? 'not declared' },
      { label: 'Vertical datum', value: dataset.vertical?.kind ?? 'unknown' },
      { label: 'Layers', value: String(dataset.layers.length) },
      { label: 'Features', value: total.toLocaleString() },
      ...(dataset.pointcloud ? [{ label: 'Points', value: dataset.pointcloud.count.toLocaleString() }] : []),
      ...(dataset.raster
        ? [{ label: 'Raster', value: `${dataset.raster.width} × ${dataset.raster.height}, ${dataset.raster.bandCount} band(s), ${dataset.raster.pixelType}` }]
        : []),
    ],
  });

  if (dataset.layers.length > 0) {
    sections.push({
      heading: 'Layers',
      lead: 'The hierarchy as the source declared it. This is the structure the delivery mirrors.',
      table: {
        header: ['Layer', 'Path', 'Features', 'Geometry'],
        rows: dataset.layers.map((layer) => ({
          cells: [
            layer.name,
            layer.path.join(' / '),
            layer.features.length.toLocaleString(),
            layer.geometryTypes.join(', ') || '—',
          ],
        })),
      },
    });
  }

  // ---- processing ---------------------------------------------------------
  const processing = input.processing ?? [];
  sections.push({
    heading: 'Processing',
    lead:
      processing.length > 0
        ? 'Every operation applied, in the order it ran.'
        : 'No transformation, repair or edit was applied: the data was read and written.',
    list: processing.map((step) => ({ text: step.detail ? `${step.label} — ${step.detail}` : step.label })),
  });

  if (settings && Object.keys(settings).length > 0) {
    sections.push({
      heading: 'Settings',
      lead: 'What the conversion ran with, so it can be repeated exactly.',
      table: {
        header: ['Setting', 'Value'],
        rows: Object.entries(settings)
          .filter(([, value]) => value !== undefined && value !== null && value !== '')
          .map(([key, value]) => ({ cells: [key, formatValue(value)] })),
      },
    });
  }

  // ---- output -------------------------------------------------------------
  if (input.targetFormatName) {
    const outputTotal = input.outputDataset ? featureCount(input.outputDataset) : undefined;
    sections.push({
      heading: 'Output',
      rows: [
        { label: 'Format', value: input.targetFormatName },
        ...(input.outputSizeBytes !== undefined ? [{ label: 'Size', value: formatBytes(input.outputSizeBytes) }] : []),
        ...(input.outputDataset ? [{ label: 'CRS', value: describeCrs(input.outputDataset) }] : []),
        ...(outputTotal !== undefined
          ? [
              {
                label: 'Features',
                value: outputTotal.toLocaleString(),
                note: outputTotal === total ? undefined : `Source had ${total.toLocaleString()}.`,
                tone: outputTotal === total ? ('ok' as const) : ('warn' as const),
              },
            ]
          : []),
        ...(input.durationMs !== undefined ? [{ label: 'Took', value: `${input.durationMs.toLocaleString()} ms` }] : []),
      ],
    });

    if (input.outputPaths?.length) {
      sections.push({
        heading: 'Delivery',
        lead: `${input.outputPaths.length} file(s). The folder structure mirrors the source.`,
        list: input.outputPaths.map((path) => ({ text: path })),
      });
    }
  }

  // ---- fidelity per axis --------------------------------------------------
  if (input.prediction) {
    sections.push({
      heading: 'Predicted fidelity',
      lead: `Assessed before the conversion ran, against ${input.prediction.targetFormatName}. Overall: ${input.prediction.overall.toUpperCase()}.${
        input.prediction.blocked ? ' This conversion was blocked; the blockers are listed below.' : ''
      }`,
      table: {
        header: ['Axis', 'Grade', 'What it means'],
        rows: input.prediction.findings.map((finding) => ({
          cells: [AXIS_LABEL[finding.axis] ?? finding.axis, finding.grade.toUpperCase(), finding.remedy ? `${finding.statement} ${finding.remedy}` : finding.statement],
          tone: finding.grade === 'red' ? ('fail' as const) : finding.grade === 'yellow' ? ('warn' as const) : ('ok' as const),
        })),
      },
    });
  }

  // ---- measured comparison ------------------------------------------------
  if (input.diff) {
    sections.push({
      heading: 'Measured comparison',
      lead: `${input.diff.summary} Measured against the output re-imported during QA, so these numbers describe the bytes that were written.`,
      table: {
        header: ['Axis', 'Source', 'Output', 'Difference', 'Verdict', 'Tolerance'],
        rows: input.diff.entries.map((entry) => ({
          cells: [
            DIFF_AXIS_LABEL[entry.axis] ?? entry.axis,
            entry.source,
            entry.output,
            entry.difference,
            entry.verdict === 'differs'
              ? 'FAIL'
              : entry.verdict === 'not-comparable'
                ? 'N/A'
                : entry.verdict === 'identical'
                  ? 'EXACT'
                  : 'PASS',
            entry.tolerance ?? '—',
          ],
          tone: entry.verdict === 'differs' ? ('fail' as const) : entry.verdict === 'not-comparable' ? ('muted' as const) : ('ok' as const),
        })),
      },
    });
  }

  // ---- QA -----------------------------------------------------------------
  if (input.qaVerdict) {
    sections.push({
      heading: 'Quality assurance',
      rows: [
        {
          label: 'Verdict',
          value: input.qaVerdict.replace(/_/g, ' '),
          tone: input.qaVerdict === 'PASS' ? 'ok' : input.qaVerdict === 'FAILED' ? 'fail' : 'warn',
          note: input.qaSummary,
        },
      ],
      notes:
        input.qaVerdict === 'NOT_VALIDATED'
          ? [
              'NOT VALIDATED is not a pass. The output could not be read back and compared, so nothing here asserts that it is correct — only that it was written.',
            ]
          : undefined,
    });
  }

  // ---- health -------------------------------------------------------------
  if (input.health) {
    const health = input.health;
    sections.push({
      heading: 'Project health',
      lead: health.summary,
      table: {
        header: ['Component', 'Score', 'How it was measured', 'Findings'],
        rows: health.components.map((component) => ({
          cells: [
            component.label,
            component.score === null ? 'not evaluated' : `${component.score}/100`,
            component.score === null ? (component.notEvaluatedReason ?? '') : component.method,
            component.score === null ? '—' : String(component.findings.length),
          ],
          tone:
            component.score === null
              ? ('muted' as const)
              : component.score >= 85
                ? ('ok' as const)
                : component.score >= 60
                  ? ('warn' as const)
                  : ('fail' as const),
        })),
      },
    });

    const items = health.components.flatMap((component) =>
      component.findings.map((finding) => ({
        text: `${component.label}: ${finding.message}${finding.layer ? ` (layer ${finding.layer})` : ''}`,
        tone: (finding.severity === 'error' ? 'fail' : finding.severity === 'warning' ? 'warn' : 'muted') as Row['tone'],
      }))
    );
    if (items.length > 0) {
      sections.push({
        heading: 'Health findings',
        lead: 'The exact items behind the scores above. A score without this list would be decoration.',
        list: items,
      });
    }
  }

  // ---- warnings -----------------------------------------------------------
  const warnings = input.warnings ?? [];
  sections.push({
    heading: 'Warnings',
    lead: warnings.length === 0 ? 'None were raised.' : `${warnings.length} raised during this conversion.`,
    list: warnings.map((warning) => ({
      text: [
        warning.count && warning.count > 1 ? `${warning.message} (×${warning.count})` : warning.message,
        warning.reason,
        warning.action,
      ]
        .filter(Boolean)
        .join(' '),
      tone: (warning.severity === 'error' ? 'fail' : warning.severity === 'warning' ? 'warn' : 'muted') as Row['tone'],
    })),
  });

  // ---- provenance ---------------------------------------------------------
  const provenance: Row[] = [
    { label: 'Produced by', value: `Universal BhuNex Converter ${ENGINE_VERSION}` },
    { label: 'Processing', value: 'Entirely on this machine. No file or fragment was sent anywhere.' },
  ];
  if (dropped.length > 0) {
    provenance.push({
      label: 'Omitted',
      value: `${dropped.length} field(s) removed as credential-shaped: ${dropped.join(', ')}.`,
      tone: 'warn',
      note: 'A report is a document that gets forwarded, so anything that looked like a credential was not written into it.',
    });
  }
  sections.push({ heading: 'About this report', rows: provenance });

  return sections;
}

// ------------------------------------------------------------------ rendering

/**
 * Escapes text for HTML.
 *
 * Applied to every value without exception. Layer names, field names and file
 * names come from files this tool did not write.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px; font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1f24; background: #fff; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .06em; color: #57606a; border-bottom: 1px solid #d8dee4; padding-bottom: 5px; }
.meta { color: #57606a; font-size: 12px; margin: 0 0 6px; }
.lead { color: #424a53; margin: 0 0 10px; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 2px; font-size: 13px; }
th { text-align: left; font-weight: 600; color: #57606a; border-bottom: 1px solid #d8dee4; padding: 6px 10px 6px 0; font-size: 12px; }
td { padding: 6px 10px 6px 0; border-bottom: 1px solid #eef1f4; vertical-align: top; }
td.label { color: #57606a; width: 190px; }
.note { display: block; color: #57606a; font-size: 12px; margin-top: 2px; }
ul { margin: 6px 0; padding-left: 18px; }
li { margin: 3px 0; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.ok { color: #1a7f37; }
.warn { color: #9a6700; }
.fail { color: #cf222e; }
.muted { color: #57606a; }
.empty { color: #57606a; font-style: italic; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
  h2 { color: #9198a1; border-color: #30363d; }
  .meta, .lead, td.label, .note, .muted, .empty { color: #9198a1; }
  th { color: #9198a1; border-color: #30363d; }
  td { border-color: #21262d; }
  .ok { color: #3fb950; } .warn { color: #d29922; } .fail { color: #f85149; }
}
@media print { body { padding: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
`;

function renderHtml(title: string, generatedAt: string, sections: Section[]): string {
  const parts: string[] = [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="meta">Generated ${escapeHtml(generatedAt)} · Universal BhuNex Converter ${escapeHtml(ENGINE_VERSION)}</p>`,
  ];

  for (const section of sections) {
    parts.push(`<h2>${escapeHtml(section.heading)}</h2>`);
    if (section.lead) parts.push(`<p class="lead">${escapeHtml(section.lead)}</p>`);

    if (section.rows?.length) {
      parts.push('<table>');
      for (const row of section.rows) {
        const tone = row.tone ? ` class="${row.tone}"` : '';
        const note = row.note ? `<span class="note">${escapeHtml(row.note)}</span>` : '';
        parts.push(`<tr><td class="label">${escapeHtml(row.label)}</td><td${tone}>${escapeHtml(row.value)}${note}</td></tr>`);
      }
      parts.push('</table>');
    }

    if (section.table) {
      parts.push('<table><thead><tr>');
      for (const header of section.table.header) parts.push(`<th>${escapeHtml(header)}</th>`);
      parts.push('</tr></thead><tbody>');
      for (const row of section.table.rows) {
        const tone = row.tone ? ` class="${row.tone}"` : '';
        parts.push(`<tr${tone}>${row.cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`);
      }
      parts.push('</tbody></table>');
    }

    if (section.list) {
      if (section.list.length === 0) {
        if (!section.lead) parts.push('<p class="empty">Nothing to report.</p>');
      } else {
        parts.push('<ul>');
        for (const item of section.list) {
          const tone = item.tone ? ` class="${item.tone}"` : '';
          parts.push(`<li${tone}>${escapeHtml(item.text)}</li>`);
        }
        parts.push('</ul>');
      }
    }

    for (const note of section.notes ?? []) parts.push(`<p class="lead">${escapeHtml(note)}</p>`);
  }

  parts.push('</body></html>');
  return parts.join('\n');
}

/**
 * The same report as plain text.
 *
 * Not a fallback — it is what gets pasted into an email or a job file, and what
 * a diff between two conversions can actually be taken of.
 */
function renderText(title: string, generatedAt: string, sections: Section[]): string {
  const lines: string[] = [title, '='.repeat(title.length), `Generated ${generatedAt} · Universal BhuNex Converter ${ENGINE_VERSION}`, ''];

  for (const section of sections) {
    lines.push(section.heading.toUpperCase(), '-'.repeat(section.heading.length));
    if (section.lead) lines.push(section.lead);

    for (const row of section.rows ?? []) {
      lines.push(`  ${row.label.padEnd(22)} ${row.value}`);
      if (row.note) lines.push(`  ${' '.repeat(22)} ${row.note}`);
    }

    if (section.table) {
      const widths = section.table.header.map((header, index) =>
        Math.max(header.length, ...section.table!.rows.map((row) => (row.cells[index] ?? '').length))
      );
      lines.push('  ' + section.table.header.map((header, index) => header.padEnd(widths[index])).join('  '));
      for (const row of section.table.rows) {
        lines.push('  ' + row.cells.map((cell, index) => (cell ?? '').padEnd(widths[index])).join('  '));
      }
    }

    for (const item of section.list ?? []) lines.push(`  - ${item.text}`);
    for (const note of section.notes ?? []) lines.push(note);
    lines.push('');
  }

  return lines.join('\n');
}

// ------------------------------------------------------------------- helpers

function describeCrs(dataset: CirDataset): string {
  const crs = dataset.crs;
  if (!crs) return 'not declared';
  const code = crs.epsg ? `EPSG:${crs.epsg}` : null;
  return [code, crs.name].filter(Boolean).join(' — ') || 'unnamed';
}

function crsOriginNote(dataset: CirDataset): string | undefined {
  switch (dataset.crsOrigin) {
    case 'declared':
      return 'Declared by the file.';
    case 'sidecar':
      return 'Read from a companion file (.prj or equivalent).';
    case 'user':
      return 'Asserted by the operator; the file itself declares none.';
    case 'inferred':
      return 'Inferred from the coordinates; confirm before delivering.';
    default:
      return 'Not known. Every distance and overlay depends on this.';
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(formatValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The report as bytes, for attaching to a delivery. */
export function reportFiles(report: ConversionReport, baseName: string): { name: string; bytes: Uint8Array; mimeType: string }[] {
  const encoder = new TextEncoder();
  return [
    { name: `${baseName}.report.html`, bytes: encoder.encode(report.html), mimeType: 'text/html' },
    { name: `${baseName}.report.txt`, bytes: encoder.encode(report.text), mimeType: 'text/plain' },
  ];
}
