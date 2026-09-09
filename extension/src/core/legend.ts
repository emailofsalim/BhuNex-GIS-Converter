/**
 * A legend, generated from the layers and their colours (phase H).
 *
 * The owner's ask: "on export automatically legend will also created according
 * to layers and colours". Two things have to be true for that to mean anything,
 * and only one of them is a legend:
 *
 *   1. The colours have to REACH the output. A legend saying "parcels are red"
 *      beside a KML in which every layer is the same yellow is worse than no
 *      legend — it is a document asserting something false about its companion.
 *      That half lives in the writers, which take each layer's `style`.
 *   2. There has to be a legend. That is this file.
 *
 * ---------------------------------------------------------------------------
 * WHY SVG AND NOT A PNG
 *
 * A PNG needs a canvas, which needs a DOM, which the conversion worker does not
 * have — and a legend rasterised at one size is unreadable at another. SVG is
 * text, so the worker can produce it, it scales to any print size, and it can be
 * opened by anything. It is also inspectable: someone receiving the delivery can
 * read the file and see exactly what was claimed.
 *
 * ---------------------------------------------------------------------------
 * WHAT A LEGEND MAY NOT DO (R23)
 *
 * It is an exported file, so it carries layer names, colours and counts, and
 * nothing else. No file paths, no credentials, no settings — the same rule the
 * conversion report follows, for the same reason: the legend travels to whoever
 * receives the delivery.
 */

import type { CirDataset, CirLayer, StyleHint } from './cir';

export interface LegendEntry {
  /** The layer name, exactly as the output carries it. */
  name: string;
  /** `#rrggbb`. */
  colour: string;
  /** Stroke width in points, for the swatch. */
  lineWidth: number;
  /** Dash pattern in points. Empty is solid. */
  dash: number[];
  /** What the swatch should look like: a line, an area or a marker. */
  kind: 'line' | 'area' | 'point' | 'mixed';
  /** How many features the layer holds. */
  count: number;
}

export interface Legend {
  title: string;
  entries: LegendEntry[];
  /** Stated on the legend itself, because a legend without it is decoration. */
  crsLabel: string | null;
}

/** The fallback palette, matching the workspace canvas so the two agree. */
export const LEGEND_COLORS = ['#10b9a8', '#f5b041', '#58a6ff', '#e06c9f', '#8fce6b', '#c792ea', '#ff9f6b', '#6bd4d0'];

/** Dash patterns by line type name, in points. Mirrors the canvas patterns. */
const DASH: Record<string, number[]> = {
  solid: [],
  dashed: [8, 5],
  dotted: [1.5, 4],
  'dash-dot': [10, 4, 2, 4],
};

/**
 * Which swatch a layer gets.
 *
 * `mixed` is reported rather than resolved: a layer holding both parcels and
 * their corner points is genuinely two things, and drawing one of them in the
 * legend would tell the reader the other is not there.
 */
function kindOf(layer: CirLayer): LegendEntry['kind'] {
  const types = new Set((layer.geometryTypes ?? []).map((type) => String(type)));
  const area = [...types].some((type) => type.includes('Polygon'));
  const line = [...types].some((type) => type.includes('LineString'));
  const point = [...types].some((type) => type.includes('Point'));
  const distinct = [area, line, point].filter(Boolean).length;
  if (distinct > 1) return 'mixed';
  if (area) return 'area';
  if (line) return 'line';
  if (point) return 'point';
  return 'line';
}

function colourFor(style: StyleHint | undefined, index: number): string {
  const colour = style?.color;
  return typeof colour === 'string' && /^#[0-9a-fA-F]{6}$/.test(colour)
    ? colour.toLowerCase()
    : LEGEND_COLORS[index % LEGEND_COLORS.length];
}

/**
 * Builds the legend for a dataset as it will be written.
 *
 * Takes the dataset AFTER every edit and style has been applied, so what the
 * legend describes is what the file contains — not what the source looked like
 * before the layer was renamed.
 */
export function buildLegend(dataset: CirDataset, options: { title?: string; crsLabel?: string | null } = {}): Legend {
  const entries: LegendEntry[] = (dataset.layers ?? []).map((layer, index) => ({
    name: layer.name,
    colour: colourFor(layer.style, index),
    lineWidth: clampWidth(layer.style?.lineWidth),
    dash: DASH[String(layer.style?.linetype ?? 'solid')] ?? [],
    kind: kindOf(layer),
    count: layer.features?.length ?? 0,
  }));

  return {
    title: options.title ?? dataset.name ?? 'Legend',
    entries,
    crsLabel: options.crsLabel ?? null,
  };
}

function clampWidth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1.2;
  return Math.max(0.5, Math.min(8, value));
}

// ===========================================================================
// Rendering
// ===========================================================================

const ROW_HEIGHT = 26;
const SWATCH_WIDTH = 34;
const PADDING = 14;
const TITLE_HEIGHT = 30;

/**
 * The legend as a standalone SVG.
 *
 * Sized to its content rather than to a fixed box, so a two-layer legend is not
 * a mostly-empty A4 page and a forty-layer one is not clipped. Text is left
 * unmeasured — there is no font metrics engine here — so the width is estimated
 * from the longest name at a conservative per-character width; over-estimating
 * leaves white space, and under-estimating clips a layer name, which is the
 * failure that matters.
 */
export function legendSvg(legend: Legend): string {
  const rows = legend.entries.length;
  const longest = Math.max(
    legend.title.length,
    ...legend.entries.map((entry) => entry.name.length + String(entry.count).length + 4),
    20
  );
  const width = Math.min(560, PADDING * 2 + SWATCH_WIDTH + 12 + Math.ceil(longest * 7.2));
  const footer = legend.crsLabel ? 22 : 0;
  const height = PADDING * 2 + TITLE_HEIGHT + rows * ROW_HEIGHT + footer;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Legend">`
  );
  parts.push(`<title>${escapeXml(legend.title)}</title>`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" stroke="#c9d1d9"/>`);
  parts.push(
    `<text x="${PADDING}" y="${PADDING + 16}" font-family="sans-serif" font-size="14" font-weight="600" fill="#161b22">${escapeXml(legend.title)}</text>`
  );

  legend.entries.forEach((entry, index) => {
    const y = PADDING + TITLE_HEIGHT + index * ROW_HEIGHT;
    parts.push(swatch(entry, PADDING, y));
    parts.push(
      `<text x="${PADDING + SWATCH_WIDTH + 12}" y="${y + 14}" font-family="sans-serif" font-size="12" fill="#161b22">` +
        `${escapeXml(entry.name)}` +
        `<tspan fill="#57606a"> · ${entry.count.toLocaleString('en')} feature${entry.count === 1 ? '' : 's'}</tspan>` +
        `</text>`
    );
  });

  if (legend.crsLabel) {
    parts.push(
      `<text x="${PADDING}" y="${height - PADDING}" font-family="sans-serif" font-size="11" fill="#57606a">${escapeXml(legend.crsLabel)}</text>`
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/** One swatch, drawn as the thing the layer actually is. */
function swatch(entry: LegendEntry, x: number, y: number): string {
  const dash = entry.dash.length > 0 ? ` stroke-dasharray="${entry.dash.join(' ')}"` : '';
  const stroke = `stroke="${entry.colour}" stroke-width="${entry.lineWidth}"${dash}`;
  const mid = y + 9;

  switch (entry.kind) {
    case 'area':
      return (
        `<rect x="${x}" y="${y + 2}" width="${SWATCH_WIDTH}" height="14" fill="${entry.colour}" fill-opacity="0.18" ${stroke}/>`
      );
    case 'point':
      return `<circle cx="${x + SWATCH_WIDTH / 2}" cy="${mid}" r="4.5" fill="${entry.colour}" ${stroke}/>`;
    case 'mixed':
      // Both marks, because the layer genuinely holds both and picking one
      // would tell the reader the other is not in the file.
      return (
        `<line x1="${x}" y1="${mid}" x2="${x + SWATCH_WIDTH - 12}" y2="${mid}" ${stroke}/>` +
        `<circle cx="${x + SWATCH_WIDTH - 4}" cy="${mid}" r="4" fill="${entry.colour}" ${stroke}/>`
      );
    default:
      return `<line x1="${x}" y1="${mid}" x2="${x + SWATCH_WIDTH}" y2="${mid}" ${stroke}/>`;
  }
}

/**
 * The legend as an HTML fragment, for embedding in the conversion report.
 *
 * The same SVG, inline. Not a second renderer: two renderers of one legend is
 * how the printed version and the on-screen version come to disagree about
 * which layer is which colour.
 */
export function legendHtml(legend: Legend): string {
  return `<figure class="legend">${legendSvg(legend)}<figcaption>Layers and colours as written to this delivery.</figcaption></figure>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
