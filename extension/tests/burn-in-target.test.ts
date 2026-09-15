/**
 * Burn-in that was switched on and did nothing.
 *
 * The cadastral presets — "Cadastral DXF → labelled polygons" and "Cadastral →
 * labelled KMZ" — both set `burnInEnabled: true`, and NEITHER sets a target
 * layer, because a preset cannot know a layer name that differs from drawing to
 * drawing. The layer defaults to the empty string, and both the settings
 * builder and the pipeline tested that string for truth before running burn-in.
 *
 * So the preset that says "parcels open in Google Earth with their plot numbers
 * showing" turned the feature on and then skipped it. The user got unlabelled
 * parcels, the checkbox still read as enabled, and nothing anywhere said why.
 * That is the failure this converter exists to not have: not a wrong answer, a
 * confident silence.
 *
 * THE FIX IS TO ANSWER THE QUESTION rather than to ask it again. A cadastral
 * sheet keeps its boundaries on one layer, and the file has already been parsed
 * by the time burn-in runs — the layer holding the polygons is known. Where
 * more than one holds polygons the largest is used and NAMED, so a wrong guess
 * is visible; where none does, that is said out loud.
 */

import { describe, expect, it } from 'vitest';
import { convert } from '@core/pipeline';
import { PRESETS } from '@core/presets';
import { crsFromEpsg } from '@crs/epsg';

const UTM45N = crsFromEpsg(32645);

/** A closed LWPOLYLINE on `layer`, as the CAD operator drew it. */
function polyline(handle: string, layer: string, corners: [number, number][]): string[] {
  return [
    '0', 'LWPOLYLINE', '5', handle, '8', layer, '90', String(corners.length), '70', '1',
    ...corners.flatMap(([x, y]) => ['10', String(x), '20', String(y)]),
  ];
}

/** A TEXT entity — the plot number, floating free of the boundary. */
function text(handle: string, layer: string, at: [number, number], value: string): string[] {
  return ['0', 'TEXT', '5', handle, '8', layer, '10', String(at[0]), '20', String(at[1]), '40', '10', '1', value];
}

function sheet(...entities: string[][]): Uint8Array {
  return new TextEncoder().encode(
    ['0', 'SECTION', '2', 'ENTITIES', ...entities.flat(), '0', 'ENDSEC', '0', 'EOF'].join('\n')
  );
}

/**
 * One parcel and its number, on the two layers a cadastral sheet uses.
 *
 * Modelled on a working export of a real sheet: boundaries on "Plot", numbers
 * on "Plot_Text", entity handles carried through for the audit trail.
 */
const PLOT_784 = sheet(
  polyline('AB12', 'Plot', [
    [257000, 2607000],
    [257100, 2607000],
    [257100, 2607100],
    [257000, 2607100],
  ]),
  text('CD34', 'Plot_Text', [257050, 2607050], '784')
);

async function run(settings: Record<string, unknown>): Promise<any> {
  return convert({
    input: { fileName: 'plot.dxf', bytes: PLOT_784 },
    targetFormatId: 'kml',
    settings: { sourceCrs: UTM45N, ...settings },
  } as never);
}

/**
 * The name on the placemark that carries the POLYGON.
 *
 * Checking the whole document for the plot number would pass whether or not
 * burn-in ran: the TEXT entity becomes its own placemark named "784" either
 * way. Two assertions here originally did exactly that and passed against the
 * unfixed code. What the fix actually changes is whose name it is — the
 * parcel's, or only the floating label's.
 */
function polygonPlacemarkName(kml: string): string | null {
  for (const match of kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
    const body = match[1];
    if (!body.includes('<Polygon>')) continue;
    return body.match(/<name>([^<]*)<\/name>/)?.[1] ?? null;
  }
  return null;
}

/** What the settings builder produces from a preset that names no layer. */
const AS_PRESET_LEAVES_IT = { burnIn: { targetLayer: '', fieldName: 'plot_no', mode: 'kml' as const } };

describe('burn-in asked for without a layer still happens', () => {
  it('labels the parcel, where before it silently did not', async () => {
    const kml = new TextDecoder().decode((await run(AS_PRESET_LEAVES_IT)).outputs[0].bytes);
    // `mode: 'kml'` makes the plot number the placemark name, which is what
    // Google Earth draws on the map.
    expect(polygonPlacemarkName(kml), 'the parcel came back unlabelled').toBe('784');
  });

  it('names the layer it chose, so a wrong guess is visible', async () => {
    const notice = ((await run(AS_PRESET_LEAVES_IT)).warnings ?? []).find(
      (w: any) => w.code === 'BURN_IN_TARGET_INFERRED'
    );
    expect(notice, 'the layer was chosen silently').toBeTruthy();
    expect(notice.message).toContain('"Plot"');
    expect(notice.reason).toMatch(/only layer/i);
  });

  it('does not override a layer the user named', async () => {
    // Inference is a fallback, never a correction. A user who picked a layer
    // gets that layer even when another holds more polygons.
    const result = await run({
      burnIn: { targetLayer: 'Plot', fieldName: 'plot_no', mode: 'kml' },
    });
    expect((result.warnings ?? []).some((w: any) => w.code === 'BURN_IN_TARGET_INFERRED')).toBe(false);
    expect(polygonPlacemarkName(new TextDecoder().decode(result.outputs[0].bytes))).toBe('784');
  });

  it('says so when the drawing has no polygons at all', async () => {
    // Line work that was never closed. The old code and the new one both
    // produce no labels here — the difference is that this one explains it.
    const openLines = sheet(
      ['0', 'LINE', '5', 'L1', '8', 'Plot', '10', '257000', '20', '2607000', '11', '257100', '21', '2607000'],
      text('CD34', 'Plot_Text', [257050, 2607050], '784')
    );
    const result: any = await convert({
      input: { fileName: 'open.dxf', bytes: openLines },
      targetFormatId: 'kml',
      settings: { sourceCrs: UTM45N, ...AS_PRESET_LEAVES_IT },
    } as never);

    const notice = (result.warnings ?? []).find((w: any) => w.code === 'BURN_IN_NO_TARGET');
    expect(notice, 'burn-in was skipped in silence').toBeTruthy();
    expect(notice.action, 'the message does not say what to do').toMatch(/polygons from closed CAD line work/i);
  });

  it('stays off entirely when burn-in was not asked for', async () => {
    const result = await run({});
    expect((result.warnings ?? []).some((w: any) => String(w.code).startsWith('BURN_IN'))).toBe(false);
    // The parcel keeps its CAD handle as a name; only the detached text
    // placemark says 784, which is the unlabelled state burn-in exists to fix.
    expect(polygonPlacemarkName(new TextDecoder().decode(result.outputs[0].bytes))).toBe('AB12');
  });
});

describe('the presets that depend on this', () => {
  it('still enable burn-in without naming a layer, which is why inference exists', () => {
    // If a preset ever starts naming a layer, this test should be reconsidered
    // — but a preset CANNOT know it, so the inference is the load-bearing part
    // and this records why.
    const cadastral = PRESETS.filter((preset) => preset.settings.burnInEnabled);
    expect(cadastral.length).toBeGreaterThan(0);
    for (const preset of cadastral) {
      expect(
        (preset.settings as Record<string, unknown>).burnInTargetLayer,
        `${preset.id} names a layer; inference may no longer be what makes it work`
      ).toBeUndefined();
    }
  });

  it('promises labelled output, which is now true', async () => {
    const preset = PRESETS.find((p) => p.id === 'cadastral-to-kmz');
    expect(preset?.purpose).toMatch(/plot numbers showing/i);
    // The promise, exercised: the preset's own burn-in settings, with the empty
    // layer it leaves behind.
    const kml = new TextDecoder().decode(
      (
        await run({
          burnIn: {
            targetLayer: '',
            fieldName: preset!.settings.burnInField as string,
            mode: preset!.settings.burnInMode as 'kml',
          },
        })
      ).outputs[0].bytes
    );
    expect(polygonPlacemarkName(kml)).toBe('784');
  });
});
