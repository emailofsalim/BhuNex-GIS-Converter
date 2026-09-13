/**
 * Does a format that CLAIMS an attribute table actually write one?
 *
 * `supportsAttributes` drives the fidelity prediction directly: when it is true
 * the attributes axis is graded green and no warning is raised. Three formats
 * claimed it and wrote nothing — DXF, LandXML and Surpac String — so a survey
 * converted to DXF for AutoCAD lost every plot number and owner name while the
 * tool showed "attributes: green" and said nothing at all.
 *
 * The flag was wrong for a year and the whole suite stayed green, because
 * nothing tied the CLAIM to the BYTES. That is what this file does, for every
 * format at once, so the next writer cannot acquire the same false claim.
 */
import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';
import { groupCompanions } from '@core/companions';
import { expandArchive } from '@core/pipeline';
import { FORMATS } from '@core/registry';
import { SURVEY_DEFAULT_PRECISION } from '@core/precision';

/** A value distinctive enough that finding it cannot be a coincidence. */
const MARKER = 'PLOT-Z9Q7';

const SOURCE = new TextEncoder().encode(
  JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32644' } },
    features: [
      {
        type: 'Feature',
        // The marker lives ONLY in a custom field. A format with a native
        // `name` slot (LandXML's parcel name, GPX's <name>) carrying that one
        // field is not an attribute table, and grading it green on that basis
        // is how a survey loses its plot numbers.
        properties: { plot_no: MARKER, name: 'boundary parcel', owner: 'R. Devi' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [412000, 2591300], [412050, 2591300], [412050, 2591350], [412000, 2591350], [412000, 2591300],
          ]],
        },
      },
    ],
  })
);

/**
 * True when the marker survives into the delivery.
 *
 * Checked in the written BYTES for text formats and, for anything packaged or
 * binary, by reading the delivery back the way the workspace does — expand the
 * archive, regroup the companions, convert to GeoJSON.
 */
async function attributeSurvives(formatId: string): Promise<boolean> {
  const out = await convert({
    input: { fileName: 'plots.geojson', bytes: SOURCE },
    targetFormatId: formatId,
    settings: { precision: SURVEY_DEFAULT_PRECISION, runQa: false },
  });
  if (out.outputs.length === 0) return false;

  for (const file of out.outputs) {
    if (new TextDecoder().decode(file.bytes).includes(MARKER)) return true;
  }

  // Packaged or binary: read it back through the real import path.
  try {
    let primary = out.outputs[0];
    let companions = new Map<string, Uint8Array>();

    if (primary.name.toLowerCase().endsWith('.zip')) {
      const expanded = await expandArchive({ fileName: primary.name, bytes: primary.bytes });
      const group = groupCompanions(
        expanded.map((e) => ({ path: e.path ?? e.fileName, name: e.fileName, size: e.bytes.length, bytes: e.bytes }))
      )[0];
      primary = { name: group.primary.name, bytes: group.primary.bytes, mimeType: '' } as any;
      companions = new Map([...group.companions].map(([k, f]) => [k, f.bytes]));
    }

    const back = await convert({
      input: { fileName: primary.name, bytes: primary.bytes, companions },
      targetFormatId: 'geojson',
      settings: { precision: SURVEY_DEFAULT_PRECISION, runQa: false },
    });
    return new TextDecoder().decode(back.outputs[0].bytes).includes(MARKER);
  } catch {
    return false;
  }
}

/**
 * Formats this test can exercise: vector or table, writable here, and not
 * dependent on a helper this build does not ship.
 */
const CANDIDATES = FORMATS.filter(
  (f) =>
    (f.dataKind === 'vector' || f.dataKind === 'table') &&
    f.support.export !== 'none' &&
    f.support.export !== 'adapter' &&
    f.id !== 'zip'
);

describe('a format that claims an attribute table must write one', () => {
  it('has formats to check', () => {
    expect(CANDIDATES.length).toBeGreaterThan(8);
  });

  for (const format of CANDIDATES.filter((f) => f.supportsAttributes)) {
    it(`${format.id} claims attributes and writes them`, async () => {
      const survived = await attributeSurvives(format.id);
      expect(
        survived,
        `${format.id} sets supportsAttributes: true, so the fidelity prediction grades attributes GREEN and raises no ` +
          `warning — but the value never reached the delivery. Either make the writer carry it, or set the flag false ` +
          `so the user is told.`
      ).toBe(true);
    });
  }

  for (const format of CANDIDATES.filter((f) => !f.supportsAttributes)) {
    it(`${format.id} declares no attribute table, and the user is told`, async () => {
      // The other direction: a false NEGATIVE would nag about a loss that is not
      // happening, and a warning nobody believes is worse than no warning.
      const survived = await attributeSurvives(format.id);
      expect(
        survived,
        `${format.id} sets supportsAttributes: false but the value DID reach the delivery — the flag now understates ` +
          `the writer, and the user is being warned about a loss that is not happening.`
      ).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// A point cloud bound for a vector target must arrive with its points
// ---------------------------------------------------------------------------

describe('a point cloud converted to a vector format carries its points', () => {
  // `predict.ts` has always listed pointcloud -> vector and -> table as
  // possible, and the format list offers GeoJSON, DXF, Shapefile and CSV for a
  // LAS or an XYZ. But the points live in `pointcloud.points` as typed arrays
  // and every vector writer reads `layers[].features`, and nothing joined the
  // two — so a total-station XYZ converted to DXF for the drawing office came
  // out as a 383-byte file with no entities in it, reported as a success.
  const CLOUD = new TextEncoder().encode(
    ['412000.5 2591300.5 10.5', '412010.5 2591310.5 11.5', '412020.5 2591320.5 12.5', ''].join('\n')
  );

  async function run(target: string) {
    const { convert } = await import('@core/pipeline');
    const { SURVEY_DEFAULT_PRECISION } = await import('@core/precision');
    return convert({
      input: { fileName: 'cloud.xyz', bytes: CLOUD },
      targetFormatId: target,
      settings: { precision: SURVEY_DEFAULT_PRECISION, runQa: false },
    });
  }

  it('writes the points into GeoJSON', async () => {
    const result = await run('geojson');
    const gj = JSON.parse(new TextDecoder().decode(result.outputs[0].bytes));
    expect(gj.features.length, 'three points in, three features out').toBe(3);
    expect(gj.features[0].geometry.type).toBe('Point');
    expect(gj.features[0].geometry.coordinates[0]).toBeCloseTo(412000.5, 3);
    // Z is survey data, not decoration.
    expect(gj.features[0].geometry.coordinates[2]).toBeCloseTo(10.5, 3);
  });

  it('writes the points into DXF, which is what the drawing office asked for', async () => {
    const text = new TextDecoder().decode((await run('dxf')).outputs[0].bytes);
    expect(text).toContain('412000.5');
  });

  it('says what it did rather than doing it silently', async () => {
    const warnings = (await run('geojson')).warnings.map((w: any) => `${w.message} ${w.reason ?? ''}`).join(' ');
    expect(warnings).toMatch(/cloud point/i);
  });

  it('leaves a point-cloud target writing from the arrays, not the features', async () => {
    // The cloud is kept alongside the features it produced, so LAS still writes
    // a real point cloud rather than a vector round trip of one.
    const result = await run('las');
    expect(result.outputs[0].bytes.length).toBeGreaterThan(200);
  });
});

describe('a format the writer cannot write does not advertise export', () => {
  it('zip is import-only, and says so in the registry', async () => {
    // It declared `export: 'full'` with no case in `writeTarget`, so it appeared
    // in the output list as a valid target and then refused when pressed — with
    // a message reading "registered for import only", contradicting the
    // registry entry two lines above it.
    const { getFormat } = await import('@core/registry');
    expect(getFormat('zip')?.support.export).toBe('none');
  });
});
