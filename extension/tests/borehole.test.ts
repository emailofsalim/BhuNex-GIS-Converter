/**
 * Borehole model and KML balloon templates (spec §28).
 *
 * Two things are load-bearing here and get the most attention:
 *
 *  - The collar/interval join, because it is by hole id across files and every
 *    mining package names the columns differently.
 *  - The escaping and secret-stripping, because a KMZ is emailed around. A test
 *    that only checked the table rendered would miss both of the ways this can
 *    actually hurt someone.
 */

import { describe, expect, it } from 'vitest';
import { createDataset, createLayer, type CirDataset, type CirFeature, type SourceInfo } from '@core/cir';
import { buildBoreholeModel, checkLogContinuity, looksLikeCollar, looksLikeInterval } from '@engines/survey/borehole';
import {
  escapeHtml,
  renderBalloon,
  renderBoreholeBalloon,
  stripSecrets,
  descriptionElement,
} from '@engines/vector/kml-templates';
import { convert } from '@core/pipeline';
import { FULL_PRECISION } from '@core/precision';
import { crsFromEpsg } from '@crs/epsg';

const SOURCE: SourceInfo = { fileName: 'holes.csv', size: 0, formatId: 'csv', formatName: 'CSV', detectionConfidence: 1 };

function record(properties: Record<string, unknown>, at?: [number, number]): CirFeature {
  return {
    id: String(properties.HoleID ?? properties.hole_id ?? Math.random()),
    geometry: at ? { type: 'Point', coordinates: at, dimension: 2 } : null,
    properties,
  };
}

function dataset(layers: { name: string; features: CirFeature[] }[]): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'boreholes',
    source: SOURCE,
    crs: crsFromEpsg(32645),
    crsOrigin: 'declared',
    layers: layers.map((entry) => createLayer(entry.name, entry.features)),
  });
}

describe('borehole model', () => {
  it('joins collars to their intervals by hole id, across layers', () => {
    const data = dataset([
      {
        name: 'Collars',
        features: [
          record({ HoleID: 'BH-01', Easting: 412300, Northing: 2591200, RL: 412.5, Depth: 30, Azimuth: 90, Dip: -60, Site: 'Pakhar' }, [412300, 2591200]),
          record({ HoleID: 'BH-02', Easting: 412400, Northing: 2591300, RL: 415.0, Depth: 20, Azimuth: 45, Dip: -90 }, [412400, 2591300]),
        ],
      },
      {
        name: 'Lithology',
        features: [
          record({ HoleID: 'BH-01', From: 0, To: 12.5, Lithology: 'Laterite', Recovery: 92 }),
          record({ HoleID: 'BH-01', From: 12.5, To: 30, Lithology: 'Banded Iron Formation', Recovery: 98, RQD: 71 }),
          record({ HoleID: 'BH-02', From: 0, To: 20, Lithology: 'Shale' }),
        ],
      },
    ]);

    const model = buildBoreholeModel(data);
    expect(model.holes).toHaveLength(2);

    const first = model.holes.find((hole) => hole.holeId === 'BH-01')!;
    expect(first.rl).toBe(412.5);
    expect(first.azimuth).toBe(90);
    expect(first.dip).toBe(-60);
    expect(first.site).toBe('Pakhar');
    expect(first.intervals).toHaveLength(2);
    // Sorted by depth, whatever order the rows arrived in.
    expect(first.intervals[0].from).toBe(0);
    expect(first.intervals[1].lithology).toBe('Banded Iron Formation');
  });

  it('reads the column names each mining package happens to use', () => {
    // Datamine-ish, Surpac-ish and spreadsheet-ish naming for the same thing.
    const data = dataset([
      { name: 'A', features: [record({ BHID: 'X1', XCollar: 1, YCollar: 2, ZCollar: 3, EOH: 50, DipDirection: 180, Inclination: -75 })] },
      { name: 'B', features: [record({ bhid: 'X1', depth_from: 0, depth_to: 10, rock_type: 'Granite' })] },
    ]);
    const model = buildBoreholeModel(data);
    expect(model.holes[0].holeId).toBe('X1');
    expect(model.holes[0].totalDepth).toBe(50);
    expect(model.holes[0].azimuth).toBe(180);
    expect(model.holes[0].intervals[0].lithology).toBe('Granite');
  });

  it('computes thickness rather than trusting a column that disagrees', () => {
    const data = dataset([
      { name: 'A', features: [record({ HoleID: 'X1', Depth: 10 })] },
      { name: 'B', features: [record({ HoleID: 'X1', From: 0, To: 7.5, Thickness: 99, Lithology: 'Sand' })] },
    ]);
    const hole = buildBoreholeModel(data).holes[0];
    // Sources routinely carry a stale thickness; the depths are the measurement.
    expect(hole.intervals[0].thickness).toBe(7.5);
  });

  it('picks up assay columns by element symbol', () => {
    const data = dataset([
      { name: 'A', features: [record({ HoleID: 'X1', Depth: 10 })] },
      { name: 'B', features: [record({ HoleID: 'X1', From: 0, To: 5, Fe: 62.3, SiO2: 3.1, Notes: 'high grade' })] },
    ]);
    const interval = buildBoreholeModel(data).holes[0].intervals[0];
    expect(interval.assay).toEqual({ Fe: 62.3, SiO2: 3.1 });
    // A remarks column is not an assay.
    expect(interval.assay?.Notes).toBeUndefined();
  });

  it('reports an interval whose hole does not exist rather than guessing', () => {
    const data = dataset([
      { name: 'A', features: [record({ HoleID: 'BH-01', Depth: 10 })] },
      { name: 'B', features: [record({ HoleID: 'BH-99', From: 0, To: 5, Lithology: 'Shale' })] },
    ]);
    const model = buildBoreholeModel(data);
    // A log attached to the wrong borehole is worse than one reported unmatched.
    expect(model.orphanIntervals).toEqual([{ holeId: 'BH-99', from: 0, to: 5 }]);
    expect(model.holes[0].intervals).toHaveLength(0);
  });

  it('names the collars that carry no log', () => {
    const data = dataset([{ name: 'A', features: [record({ HoleID: 'BH-01', Depth: 10 })] }]);
    expect(buildBoreholeModel(data).collarsWithoutLog).toEqual(['BH-01']);
  });

  it('tells a collar record from an interval record', () => {
    expect(looksLikeInterval({ HoleID: 'X', From: 0, To: 5 })).toBe(true);
    expect(looksLikeCollar({ HoleID: 'X', From: 0, To: 5 })).toBe(false);
    expect(looksLikeCollar({ HoleID: 'X', Depth: 30, Azimuth: 90 })).toBe(true);
  });
});

describe('core log continuity', () => {
  const hole = (intervals: [number, number][], totalDepth: number | null = null) => ({
    holeId: 'BH-01',
    collar: null,
    rl: null,
    totalDepth,
    azimuth: null,
    dip: null,
    intervals: intervals.map(([from, to]) => ({ from, to, thickness: to - from })),
    properties: {},
  });

  it('finds an unlogged gap between intervals', () => {
    const { gaps } = checkLogContinuity(hole([[0, 45], [52, 80]]));
    expect(gaps).toEqual([{ from: 45, to: 52 }]);
  });

  it('finds two records claiming the same metre', () => {
    const { overlaps } = checkLogContinuity(hole([[0, 20], [15, 40]]));
    expect(overlaps).toEqual([{ from: 15, to: 20 }]);
  });

  it('finds a log that starts below the collar and ends above the hole bottom', () => {
    const { gaps } = checkLogContinuity(hole([[3, 40]], 60));
    expect(gaps).toEqual([{ from: 0, to: 3 }, { from: 40, to: 60 }]);
  });

  it('passes a continuous log', () => {
    const { gaps, overlaps } = checkLogContinuity(hole([[0, 20], [20, 45]], 45));
    expect(gaps).toHaveLength(0);
    expect(overlaps).toHaveLength(0);
  });
});

describe('balloon rendering and safety', () => {
  it('escapes every value, so source text can never become markup', () => {
    const { html } = renderBalloon({ owner: '<script>alert(1)</script>', note: 'a & b "quoted"' }, { template: 'plain' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('escapes attribute-breaking characters too', () => {
    expect(escapeHtml(`" onmouseover="x`)).not.toContain('"');
    expect(escapeHtml("it's")).toContain('&#39;');
  });

  it('withholds anything credential-shaped by name', () => {
    const { safe, dropped } = stripSecrets({ plot_no: '784', api_key: 'abc123', AccessToken: 'x', password: 'y' });
    expect(safe).toEqual({ plot_no: '784' });
    expect(dropped.sort()).toEqual(['AccessToken', 'api_key', 'password']);
  });

  it('withholds a credential-shaped value even under an innocent name', () => {
    const { safe, dropped } = stripSecrets({ note: 'eyJhbGciOiJIUzI1NiJ9.payload', url: 'https://x.test/report?sig=abc' });
    expect(Object.keys(safe)).toHaveLength(0);
    expect(dropped.sort()).toEqual(['note', 'url']);
  });

  it('refuses to link a report URL carrying a signature', () => {
    const { html } = renderBalloon({ plot_no: '784' }, { template: 'plain', reportUrl: 'https://x.test/r?token=secret' });
    expect(html).not.toContain('token=secret');
  });

  it('puts the identity field first for a cadastral parcel', () => {
    const { html } = renderBalloon({ zone: 'A', plot_no: '784', area_m2: 4046 }, { template: 'cadastral' });
    // The plot number is what a reader opens the balloon for; alphabetical
    // ordering would bury it under "area" and "zone".
    expect(html.indexOf('plot_no')).toBeLessThan(html.indexOf('zone'));
  });

  it('cannot be broken out of by a value containing a CDATA terminator', () => {
    const description = descriptionElement('<p>]]> &lt;/description&gt;</p>');
    // An unescaped ]]> would close the CDATA early and corrupt the KML.
    expect(description.match(/]]>/g)).toHaveLength(1);
    expect(description.endsWith(']]></description>')).toBe(true);
  });
});

describe('borehole core-log balloon', () => {
  const hole = {
    holeId: 'BH-01',
    collar: [412300.123, 2591200.456] as [number, number],
    rl: 412.5,
    totalDepth: 30,
    azimuth: 90,
    dip: -60,
    site: 'Pakhar Iron Ore',
    intervals: [
      { from: 0, to: 12.5, thickness: 12.5, lithology: 'Laterite', recovery: 92 },
      { from: 12.5, to: 30, thickness: 17.5, lithology: 'Banded Iron Formation', recovery: 98, rqd: 71, sampleId: 'S-1042', assay: { Fe: 62.3 } },
    ],
    properties: { HoleID: 'BH-01', Contractor: 'ACME Drilling' },
  };

  it('renders the collar header and every interval', () => {
    const { html } = renderBoreholeBalloon(hole);
    expect(html).toContain('BH-01');
    expect(html).toContain('Pakhar Iron Ore');
    expect(html).toContain('Laterite');
    expect(html).toContain('Banded Iron Formation');
    expect(html).toContain('S-1042');
    expect(html).toContain('62.3');
  });

  it('omits a column no interval carries', () => {
    const noRqd = { ...hole, intervals: [{ from: 0, to: 10, thickness: 10, lithology: 'Shale' }] };
    const { html } = renderBoreholeBalloon(noRqd);
    // An empty RQD column on every row pushes the lithology off-screen.
    expect(html).not.toContain('RQD');
    expect(html).not.toContain('Sample');
  });

  it('shows an unlogged gap beside the log, where a geologist will see it', () => {
    const gapped = {
      ...hole,
      intervals: [
        { from: 0, to: 12.5, thickness: 12.5, lithology: 'Laterite' },
        { from: 20, to: 30, thickness: 10, lithology: 'BIF' },
      ],
    };
    const { html } = renderBoreholeBalloon(gapped);
    expect(html).toMatch(/Unlogged interval from 12\.50 m to 20\.00 m/);
  });

  it('says so when a hole has no log at all', () => {
    const { html } = renderBoreholeBalloon({ ...hole, intervals: [] });
    expect(html).toContain('No interval log was found');
  });

  it('keeps other collar fields but drops credentials', () => {
    const { html, droppedSecrets } = renderBoreholeBalloon({
      ...hole,
      properties: { ...hole.properties, api_key: 'leaked' },
    });
    expect(html).toContain('ACME Drilling');
    expect(html).not.toContain('leaked');
    expect(droppedSecrets).toContain('api_key');
  });
});

describe('KML output with templates', () => {
  const BOREHOLE_CSV = [
    'HoleID,Easting,Northing,RL,Depth,Azimuth,Dip,api_key',
    'BH-01,84.680,23.430,412.5,30,90,-60,secret-value',
  ].join('\n');

  it('writes a core-log balloon into the KML and withholds the credential', async () => {
    const result = await convert({
      input: { fileName: 'collars.csv', bytes: new TextEncoder().encode(BOREHOLE_CSV) },
      targetFormatId: 'kml',
      settings: {
        precision: FULL_PRECISION,
        sourceCrs: crsFromEpsg(4326),
        kml: { boreholeLog: true, template: 'borehole' },
      },
    });

    const kml = new TextDecoder().decode(result.outputs[0].bytes);
    expect(kml).toContain('BH-01');
    expect(kml).toContain('Collar');
    // The credential must not reach a file that gets emailed around...
    expect(kml).not.toContain('secret-value');
    // ...and the withholding is reported rather than silent.
    expect(result.warnings.some((warning) => warning.code === 'KML_SECRETS_WITHHELD')).toBe(true);
  });

  it('still writes a plain attribute balloon by default', async () => {
    const result = await convert({
      input: { fileName: 'collars.csv', bytes: new TextEncoder().encode('Point,Easting,Northing,Code\nP1,84.680,23.430,BM\n') },
      targetFormatId: 'kml',
      settings: { precision: FULL_PRECISION, sourceCrs: crsFromEpsg(4326) },
    });
    const kml = new TextDecoder().decode(result.outputs[0].bytes);
    expect(kml).toContain('<description>');
    expect(kml).toContain('BM');
  });
});
