/**
 * The legend, and the thing that makes a legend worth having (phase H).
 *
 * A legend is a document that ASSERTS something about the file beside it. If
 * the colours in it are not the colours in the file, it is worse than nothing:
 * it is a confident, printable, wrong statement that the recipient has no way to
 * check without opening both. So half of these tests are about the legend, and
 * half are about the colours reaching the output at all.
 *
 * The SVG is checked as a document rather than string-matched against a golden
 * blob: a golden SVG breaks on every spacing change and passes on every wrong
 * colour, which is exactly backwards.
 */

import { describe, expect, it } from 'vitest';
import type { CirDataset, CirGeometry } from '@core/cir';
import { buildLegend, LEGEND_COLORS, legendHtml, legendSvg } from '@core/legend';
import { writeKml } from '@engines/vector/kml';
import { DEFAULT_KML_OPTIONS } from '@engines/vector/kml';
import { SURVEY_DEFAULT_PRECISION } from '@core/precision';

const POLYGON: CirGeometry = {
  type: 'Polygon',
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  dimension: 2,
};
const LINE: CirGeometry = { type: 'LineString', coordinates: [[0, 0], [1, 1]], dimension: 2 };
const POINT: CirGeometry = { type: 'Point', coordinates: [0.5, 0.5], dimension: 2 };

function dataset(layers: { name: string; geometry: CirGeometry; style?: Record<string, unknown>; count?: number }[]): CirDataset {
  return {
    name: 'Village 42',
    layers: layers.map((layer) => ({
      name: layer.name,
      path: [layer.name],
      features: Array.from({ length: layer.count ?? 1 }, () => ({ geometry: layer.geometry, properties: {} })),
      fields: [],
      geometryTypes: [layer.geometry.type],
      style: layer.style,
    })),
    warnings: [],
  } as unknown as CirDataset;
}

describe('building the legend', () => {
  it('makes one entry per layer, in order', () => {
    const legend = buildLegend(dataset([
      { name: 'parcels', geometry: POLYGON },
      { name: 'roads', geometry: LINE },
    ]));
    expect(legend.entries.map((entry) => entry.name)).toEqual(['parcels', 'roads']);
  });

  it('uses the layer’s own colour when it has one', () => {
    const legend = buildLegend(dataset([{ name: 'parcels', geometry: POLYGON, style: { color: '#FF8800' } }]));
    expect(legend.entries[0].colour).toBe('#ff8800');
  });

  it('falls back to the palette, matching the canvas so the two agree', () => {
    const legend = buildLegend(dataset([
      { name: 'a', geometry: LINE },
      { name: 'b', geometry: LINE },
    ]));
    expect(legend.entries[0].colour).toBe(LEGEND_COLORS[0]);
    expect(legend.entries[1].colour).toBe(LEGEND_COLORS[1]);
  });

  it('ignores a colour the renderer could not use', () => {
    const legend = buildLegend(dataset([{ name: 'parcels', geometry: POLYGON, style: { color: 'red' } }]));
    expect(legend.entries[0].colour).toBe(LEGEND_COLORS[0]);
  });

  it('draws each layer as the kind of thing it is', () => {
    const legend = buildLegend(dataset([
      { name: 'parcels', geometry: POLYGON },
      { name: 'roads', geometry: LINE },
      { name: 'control', geometry: POINT },
    ]));
    expect(legend.entries.map((entry) => entry.kind)).toEqual(['area', 'line', 'point']);
  });

  it('reports a mixed layer as mixed rather than picking one', () => {
    // A layer holding parcels AND their corner points is genuinely two things.
    // Drawing one of them would tell the reader the other is not in the file.
    const mixed = dataset([{ name: 'everything', geometry: POLYGON }]);
    (mixed.layers[0] as { geometryTypes: string[] }).geometryTypes = ['Polygon', 'Point'];
    expect(buildLegend(mixed).entries[0].kind).toBe('mixed');
  });

  it('counts the features it is describing', () => {
    const legend = buildLegend(dataset([{ name: 'parcels', geometry: POLYGON, count: 137 }]));
    expect(legend.entries[0].count).toBe(137);
  });

  it('clamps a line width the canvas could not draw', () => {
    const legend = buildLegend(dataset([
      { name: 'thin', geometry: LINE, style: { lineWidth: 0 } },
      { name: 'absurd', geometry: LINE, style: { lineWidth: 500 } },
    ]));
    expect(legend.entries[0].lineWidth).toBe(0.5);
    expect(legend.entries[1].lineWidth).toBe(8);
  });

  it('turns a line type into a dash pattern', () => {
    const legend = buildLegend(dataset([{ name: 'disputed', geometry: LINE, style: { linetype: 'dashed' } }]));
    expect(legend.entries[0].dash.length).toBeGreaterThan(0);
  });
});

describe('the SVG', () => {
  const legend = buildLegend(
    dataset([
      { name: 'parcels', geometry: POLYGON, style: { color: '#ff8800' }, count: 40 },
      { name: 'roads', geometry: LINE, style: { color: '#3366cc', linetype: 'dashed' } },
    ]),
    { title: 'Village 42', crsLabel: 'EPSG:32645 — WGS 84 / UTM zone 45N' }
  );
  const svg = legendSvg(legend);

  it('is a well-formed standalone SVG', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('carries every layer name and every colour', () => {
    expect(svg).toContain('parcels');
    expect(svg).toContain('roads');
    expect(svg).toContain('#ff8800');
    expect(svg).toContain('#3366cc');
  });

  it('states the CRS, without which a legend is decoration', () => {
    expect(svg).toContain('UTM zone 45N');
  });

  it('draws a dashed layer dashed', () => {
    expect(svg).toContain('stroke-dasharray');
  });

  it('grows with the number of layers rather than clipping them', () => {
    const two = legendSvg(buildLegend(dataset([{ name: 'a', geometry: LINE }, { name: 'b', geometry: LINE }])));
    const twenty = legendSvg(
      buildLegend(dataset(Array.from({ length: 20 }, (_, index) => ({ name: `layer ${index}`, geometry: LINE }))))
    );
    const heightOf = (text: string) => Number(/height="(\d+(?:\.\d+)?)"/.exec(text)![1]);
    expect(heightOf(twenty)).toBeGreaterThan(heightOf(two));
  });

  it('escapes a layer name that would otherwise break the document', () => {
    const nasty = legendSvg(buildLegend(dataset([{ name: 'Plot <script>&"\'', geometry: LINE }])));
    expect(nasty).not.toContain('<script>');
    expect(nasty).toContain('&lt;script&gt;');
  });

  it('embeds the same SVG in the HTML fragment rather than rendering twice', () => {
    // Two renderers of one legend is how the printed version and the on-screen
    // version come to disagree about which layer is which colour.
    expect(legendHtml(legend)).toContain(svg);
  });

  it('carries no path, no setting and no credential (R23)', () => {
    expect(svg).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
    expect(svg.toLowerCase()).not.toContain('api_key');
    expect(svg.toLowerCase()).not.toContain('token');
  });
});

describe('the colours reaching the output, which is what makes the legend true', () => {
  it('writes a per-layer style into KML when a layer has one', () => {
    const styled = dataset([
      { name: 'parcels', geometry: POLYGON, style: { color: '#ff8800' } },
      { name: 'roads', geometry: LINE, style: { color: '#3366cc' } },
    ]);
    const { text } = writeKml(styled, { ...DEFAULT_KML_OPTIONS, precision: SURVEY_DEFAULT_PRECISION });

    // KML colour is aabbggrr, so #ff8800 becomes ..0088ff. Asserting the KML
    // encoding rather than the hex catches a writer that pasted the CSS colour
    // straight in, which Google Earth renders as a different colour entirely.
    expect(text).toContain('0088ff');
    expect(text).toContain('cc6633');
    expect(text).toContain('id="ugcLayer0"');
    expect(text).toContain('id="ugcLayer1"');
  });

  it('points each layer’s placemarks at that layer’s style', () => {
    const styled = dataset([
      { name: 'parcels', geometry: POLYGON, style: { color: '#ff8800' } },
      { name: 'roads', geometry: LINE, style: { color: '#3366cc' } },
    ]);
    const { text } = writeKml(styled, { ...DEFAULT_KML_OPTIONS, precision: SURVEY_DEFAULT_PRECISION });
    expect(text).toContain('<styleUrl>#ugcLayer0</styleUrl>');
    expect(text).toContain('<styleUrl>#ugcLayer1</styleUrl>');
  });

  it('leaves an unstyled file exactly as it was', () => {
    // The whole risk of this change: a conversion nobody styled must produce
    // the bytes it always produced.
    const plain = dataset([{ name: 'parcels', geometry: POLYGON }]);
    const { text } = writeKml(plain, { ...DEFAULT_KML_OPTIONS, precision: SURVEY_DEFAULT_PRECISION });
    expect(text).not.toContain('ugcLayer');
    expect(text).toContain('<styleUrl>#ugcPoly</styleUrl>');
  });

  it('honours a per-layer line width', () => {
    const styled = dataset([{ name: 'parcels', geometry: POLYGON, style: { color: '#ff8800', lineWidth: 4 } }]);
    const { text } = writeKml(styled, { ...DEFAULT_KML_OPTIONS, precision: SURVEY_DEFAULT_PRECISION });
    expect(text).toContain('<width>4</width>');
  });
});
