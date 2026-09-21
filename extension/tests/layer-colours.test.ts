/**
 * Every layer leaves with a colour of its own.
 *
 * `layerStyleCommands` used to emit a command only for layers somebody had
 * coloured in by hand, so an untouched file exported with no styling at all:
 * the mining DXF's six layers — ML Boundary, Mined Out Area, Reclaimed,
 * Plantation, Plot, Plot_Text — opened in Google Earth as six layers in one
 * indistinguishable default, and the legend generated beside them described
 * colours the file did not carry.
 *
 * The fallback is the same palette, indexed the same way, that the canvas uses,
 * so the screen, the file and the legend cannot disagree.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { convert } from '@core/pipeline';
import { SURVEY_DEFAULT_PRECISION } from '@core/precision';
import { crsFromEpsg } from '@crs/epsg';
import { LAYER_COLORS } from '../src/ui/preview';
import { layerStyleCommands } from '../src/workspace/conversion';

const decoder = new TextDecoder();
const MINING_DXF = '1_Trial_Feedback_Files/imported file/RAM_Pakhar-115.13 Ha Entity LMS Final Data.dxf';

const fakeItem = (names: string[]) => ({ dataset: { layers: names.map((name) => ({ name })) } }) as never;

describe('automatic layer colours', () => {
  it('gives every layer a command, not only the styled ones', () => {
    const names = ['ML Boundary', 'Mined Out Area', 'Reclaimed', 'Plantation'];
    const commands = layerStyleCommands(fakeItem(names)) as { layer: string; style: { color?: string } }[];
    expect(commands).toHaveLength(names.length);
    for (const command of commands) expect(command.style.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('gives adjacent layers different colours', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const commands = layerStyleCommands(fakeItem(names)) as { style: { color?: string } }[];
    expect(new Set(commands.map((command) => command.style.color)).size).toBe(names.length);
  });

  it('uses the same palette the canvas draws with, in the same order', () => {
    // If these drifted apart the surveyor would style a layer on screen and
    // receive a different colour in the file, which is worse than no colour.
    const commands = layerStyleCommands(fakeItem(['one', 'two', 'three'])) as { style: { color?: string } }[];
    expect(commands.map((command) => command.style.color)).toEqual(LAYER_COLORS.slice(0, 3));
  });

  it('wraps rather than running out on a file with more layers than colours', () => {
    const many = Array.from({ length: LAYER_COLORS.length + 3 }, (_, index) => `layer ${index}`);
    const commands = layerStyleCommands(fakeItem(many)) as { style: { color?: string } }[];
    expect(commands).toHaveLength(many.length);
    expect(commands[LAYER_COLORS.length].style.color).toBe(LAYER_COLORS[0]);
  });

  it('has nothing to say about a dataset with no layers', () => {
    expect(layerStyleCommands({ dataset: { layers: [] } } as never)).toEqual([]);
    expect(layerStyleCommands({} as never)).toEqual([]);
  });
});

describe.skipIf(!existsSync(MINING_DXF))('and they reach the written file', () => {
  it('the KML carries a distinct colour per layer', async () => {
    const bytes = new Uint8Array(readFileSync(MINING_DXF));
    const settings = { precision: SURVEY_DEFAULT_PRECISION, sourceCrs: crsFromEpsg(32645), runQa: false };

    // The layer names as the reader actually finds them, rather than a list
    // written here that could drift from the file.
    const probe: never = (await convert({ input: { fileName: 'm.dxf', bytes }, targetFormatId: 'geojson', settings } as never)) as never;
    const json = JSON.parse(decoder.decode((probe as unknown as { outputs: { bytes: Uint8Array }[] }).outputs[0].bytes));
    const names = [...new Set(json.features.map((f: any) => f.properties?._layer).filter(Boolean))] as string[];
    expect(names.length).toBeGreaterThan(1);

    const result: never = (await convert({
      input: { fileName: 'm.dxf', bytes },
      targetFormatId: 'kml',
      settings: { ...settings, edits: layerStyleCommands(fakeItem(names)) },
    } as never)) as never;
    const kml = decoder.decode((result as unknown as { outputs: { bytes: Uint8Array }[] }).outputs[0].bytes);

    // KML writes ABGR, so a palette colour appears with its bytes reversed.
    for (const colour of LAYER_COLORS.slice(0, names.length)) {
      const [r, g, b] = [colour.slice(1, 3), colour.slice(3, 5), colour.slice(5, 7)];
      expect(kml.toLowerCase()).toContain(`${b}${g}${r}`);
    }
  }, 300_000);
});
