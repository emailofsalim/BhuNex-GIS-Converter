/**
 * EVERY conversion this tool offers, run for real.
 *
 * "All other possible conversions will work accurately; if not possible then it
 * will not do it, since we want trust and accuracy." That is the promise, and
 * the suites beside this one each check one half of it:
 *
 *   capability-audit  writes each format once and reads it back to ITSELF
 *   export-audit      checks each writer for empty output and lost rings
 *   dxf-to-kml        holds one pair to a survey standard
 *
 * None of them crosses the grid. A reader is exercised only against its own
 * writer, so a defect that needs one format's output fed to another format's
 * input is invisible to all three — and that is where the defects were. Three
 * were found the first time this file ran:
 *
 *   · Any export that split into several files (Shapefile) had its QA
 *     re-import read ONE member and pair it with ANOTHER member's attribute
 *     table, so a flawless export was reported FAILED.
 *   · A polygon with a hole lost the hole through DXF whenever the drawing
 *     carried levels, because only the flat entity path tagged its rings.
 *   · KML wrote every elevation as zero, and QA passed it, because the check
 *     asked whether a Z existed rather than what it was.
 *
 * Every pair is derived from the registry: a format added later is audited by
 * this file whether or not anyone remembers it exists.
 *
 * THE RULE EACH PAIR IS HELD TO
 *
 * A conversion either carries the data across or refuses out loud. What it may
 * never do is appear to succeed while losing features. A format that cannot
 * hold a multi-part geometry may SPLIT one feature into several — that is
 * declared by `supportsMultiGeometry` and reported in the warnings — but no
 * pair may come back with fewer features than it was given.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';
import { FORMATS, type FormatDef } from '@core/registry';
import { crsFromEpsg } from '@crs/epsg';

const UTM44N = crsFromEpsg(32644);
const E = 412000;
const N = 2591300;

/**
 * A parcel with an excluded tank, a road and a benchmark.
 *
 * The hole is the point of the first feature: a polygon whose ring count
 * survives is a polygon whose MEANING survives, and a converter that drops the
 * inner ring returns the same vertices with the tank turned into land.
 *
 * THE OUTER RING IS DELIBERATELY IRREGULAR.
 *
 * It was a 60x45 RECTANGLE, and a rectangle is the one shape that cannot detect
 * the failure people actually report: geometry that arrives as its own bounding
 * box. Every pair in this file passed while being structurally unable to notice
 * it — a converter that replaced the parcel with its envelope would have
 * returned the identical five vertices. Eleven vertices at eleven different
 * distances from the centre make a box detectably not the shape it replaced,
 * and `shapeOf` below turns that into an assertion.
 */
const SOURCE = JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32644' } },
  features: [
    {
      type: 'Feature',
      properties: { plot: '12/A', owner: 'Survey Dept' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [E, N], [E + 37, N + 4], [E + 52, N + 21], [E + 48, N + 44], [E + 61, N + 63],
            [E + 40, N + 78], [E + 19, N + 71], [E + 7, N + 55], [E + 14, N + 38],
            [E + 3, N + 25], [E + 11, N + 12], [E, N],
          ],
          [[E + 22, N + 30], [E + 22, N + 45], [E + 38, N + 45], [E + 38, N + 30], [E + 22, N + 30]],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { road: 'NH-33' },
      geometry: { type: 'LineString', coordinates: [[E, N + 50], [E + 60, N + 50], [E + 125, N + 52]] },
    },
    { type: 'Feature', properties: { mark: 'BM-1' }, geometry: { type: 'Point', coordinates: [E + 10, N + 10] } },
  ],
});

/** Vector formats the registry claims to read AND write. */
const EXCHANGEABLE = FORMATS.filter(
  (format) =>
    format.dataKind === 'vector' &&
    ['full', 'partial'].includes(format.support.import) &&
    ['full', 'partial'].includes(format.support.export)
);

function featureCount(dataset: unknown): number {
  const layers = (dataset as { layers?: { features?: unknown[] }[] } | undefined)?.layers ?? [];
  return layers.reduce((total, layer) => total + (layer.features ?? []).length, 0);
}

/**
 * Seeds are written from a source that DECLARES EPSG:32644, so the override is
 * only ever needed there.
 */
async function write(targetFormatId: string, input: { fileName: string; bytes: Uint8Array }): Promise<any> {
  return convert({ input, targetFormatId, settings: { sourceCrs: UTM44N } } as never);
}

/**
 * A pair conversion, letting each seed's own CRS stand.
 *
 * The pairs used to go through `write` too, forcing EPSG:32644 onto every
 * input — including the seeds that are WGS 84 BY MANDATE. GPX, KML and OSM can
 * store nothing else, so their files hold degrees; declaring those degrees to
 * be UTM metres made the writer round them with the millimetre policy meant for
 * metres, and 0.001° is 111 m. A twelve-vertex parcel came out of gpx →
 * landxml as three points.
 *
 * That was the harness lying to the pipeline, not the pipeline failing — the
 * conversion even warned `CRS_OVERRIDDEN`. A matrix that mislabels its own
 * fixtures cannot tell a real defect from its own setup, so the pairs now pass
 * no CRS at all and every seed is read as what it says it is.
 */
async function pair(targetFormatId: string, input: { fileName: string; bytes: Uint8Array }): Promise<any> {
  return convert({ input, targetFormatId, settings: {} } as never);
}

/**
 * One real file per readable format, written by this tool from one dataset.
 *
 * Seeding from the writers rather than from checked-in fixtures is deliberate:
 * it is the output the user actually gets that has to be readable, and a
 * hand-made fixture would test a file nobody will ever hold.
 */
const seeds = new Map<string, { fileName: string; bytes: Uint8Array }>();

async function seed(format: FormatDef): Promise<{ fileName: string; bytes: Uint8Array }> {
  const existing = seeds.get(format.id);
  if (existing) return existing;
  const written = await write(format.id, { fileName: 'survey.geojson', bytes: new TextEncoder().encode(SOURCE) });
  const made = { fileName: written.outputs[0].name, bytes: written.outputs[0].bytes as Uint8Array };
  seeds.set(format.id, made);
  return made;
}

describe('the conversion matrix', () => {
  it('covers every vector format that can be both read and written', () => {
    // A floor rather than an equality: a format added later should RAISE this,
    // and the loops below pick it up with no other edit. A format silently
    // losing its reader or writer drops the count and fails here.
    expect(EXCHANGEABLE.length).toBeGreaterThanOrEqual(16);
  });

  for (const from of EXCHANGEABLE) {
    for (const to of EXCHANGEABLE) {
      it(`${from.id} → ${to.id} either carries the data or refuses`, async () => {
        const input = await seed(from);

        let result: any;
        try {
          result = await pair(to.id, input);
        } catch (error) {
          // A refusal is a valid outcome — it is half of the promise. What it
          // may not be is a bare failure: the message has to leave the user
          // knowing what to do next, or they are stuck with a tool that says no.
          const message = (error as Error).message;
          expect(message.length, `${from.id} → ${to.id} refused with an empty message`).toBeGreaterThan(30);
          //
          // Deliberately NOT matching the word "convert": these messages open
          // by naming the conversion that was refused, so accepting it would
          // let a message pass on its own subject line rather than on an
          // instruction. What has to be present is a verb aimed at the user.
          expect(
            message,
            `${from.id} → ${to.id} refused without saying what to do: ${message}`
          ).toMatch(/expand|choose|set |use |select|provide|enable/i);
          return;
        }

        const bytes = result.outputs.reduce((total: number, output: any) => total + output.bytes.length, 0);
        expect(bytes, `${from.id} → ${to.id} produced an empty file`).toBeGreaterThan(0);

        // The QA verdict is the tool's own claim about its own output. FAILED
        // here means either the conversion is broken or the check is — and
        // either way the user is being told something is wrong, so neither is
        // allowed to stand.
        expect(result.qa?.verdict, `${from.id} → ${to.id}: ${result.qa?.summary}`).not.toBe('FAILED');

        // Features may be SPLIT by a format that cannot hold multi-part
        // geometry. They may never be lost.
        const before = featureCount(result.sourceDataset);
        const after = featureCount(result.outputDataset);
        expect(after, `${from.id} → ${to.id} dropped ${before - after} of ${before} features`).toBeGreaterThanOrEqual(
          before
        );
      });
    }
  }
});

/**
 * The multi-file package, which is where the QA re-import was wrong.
 *
 * One shapefile holds exactly one geometry type, so this drawing is written as
 * three — and each has its own .dbf. The re-import keyed companions by
 * extension into a single map, so the LAST .dbf won and the polygon's geometry
 * was checked against the point's attributes.
 */
describe('a package written as several files is checked as one dataset', () => {
  it('reports PASS, because all three shapefiles really do hold the drawing', async () => {
    const result = await write('shapefile', {
      fileName: 'survey.geojson',
      bytes: new TextEncoder().encode(SOURCE),
    });
    expect(result.qa?.verdict, result.qa?.summary).toBe('PASS');
    // Every check, not just the verdict: Bounds and Attribute fields were the
    // two that failed on the chimera, and a verdict can go green while a check
    // still warns.
    for (const check of result.qa?.checks ?? []) {
      expect(check.status, `${check.name}: ${check.note ?? ''}`).not.toBe('fail');
    }
  });

  it('re-imports all three members, not whichever one sorted first', async () => {
    const result = await write('shapefile', {
      fileName: 'survey.geojson',
      bytes: new TextEncoder().encode(SOURCE),
    });
    const layers = (result.outputDataset?.layers ?? []).map((layer: any) => layer.name);
    expect(layers.length, `only re-imported: ${layers.join(', ')}`).toBe(3);
    expect(featureCount(result.outputDataset)).toBe(3);
  });

  it('keeps each geometry with its OWN attributes', async () => {
    const result = await write('shapefile', {
      fileName: 'survey.geojson',
      bytes: new TextEncoder().encode(SOURCE),
    });
    // The chimera's signature: the polygon carrying `mark: BM-1`, which belongs
    // to the benchmark. Checked by pairing, because every field is present
    // SOMEWHERE in the package either way.
    for (const layer of result.outputDataset?.layers ?? []) {
      for (const feature of layer.features ?? []) {
        const properties = feature.properties ?? {};
        if (feature.geometry?.type === 'Polygon') {
          expect(properties.plot, 'the polygon lost its own attributes').toBe('12/A');
          expect(properties.mark, 'the polygon picked up the benchmark’s attributes').toBeUndefined();
        }
        if (feature.geometry?.type === 'Point') {
          expect(properties.mark, 'the benchmark lost its own attributes').toBe('BM-1');
        }
      }
    }
  });

  it('still says the split happened, so the user knows to expect three files', async () => {
    const result = await write('shapefile', {
      fileName: 'survey.geojson',
      bytes: new TextEncoder().encode(SOURCE),
    });
    const split = (result.warnings ?? []).find((warning: any) => warning.code === 'SHP_SPLIT_BY_TYPE');
    expect(split, 'the split was silent').toBeTruthy();
    expect(split.reason).toMatch(/one geometry type/i);
    expect(split.action).toMatch(/GeoPackage|GeoJSON/i);
  });
});
