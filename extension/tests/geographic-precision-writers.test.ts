/**
 * The rest of the writers that had to choose a decimal count, and a sweep so a
 * new one cannot reintroduce the choice wrongly.
 *
 * WHAT THE LAST PASS GOT WRONG
 *
 * The change that fixed the KML collapse converted `landxml.ts` to
 * `decimalsFor` and recorded, in its own PR description, that `gml.ts`,
 * `wkt.ts`, `topojson.ts`, `csv.ts`, `xlsx.ts` and `mifmid.ts` still reached
 * for `linearDecimals` unconditionally and were a latent repeat of the same
 * defect.
 *
 * That was wrong. Every one of those six already branched on
 * `crs?.kind === 'geographic'` and always had. LandXML was the only vector
 * writer that did not. The claim was written from the comment inside
 * `decimalsFor` — which lists the formats that CARRY either CRS, a different
 * statement from which ones get the decimals wrong — rather than from the
 * code, and stating it without checking is how a clean file acquires a
 * reputation for a bug it does not have.
 *
 * WHAT WAS ACTUALLY LEFT
 *
 * Four sites, none of them in that list:
 *
 *   · `writeXyzCloud`, `writePts` and `writePly` in `pointcloud/text.ts`
 *   · `writeSurpacStr` in `vector/surpac.ts`
 *
 * These were excused as projected-only, and mostly they are — but nothing
 * enforces it. A LAS file takes its CRS from a PRJ sidecar or a WKT VLR, and
 * either can declare EPSG:4326; `las.ts` says as much by labelling the units
 * 'm' only when the CRS is projected. A geographic cloud written at the
 * default 3 dp puts every point on a 111 m grid, which for a cloud is worse
 * than for a parcel: a parcel becomes a crude rectangle, a cloud of a
 * thousand points becomes a few dozen duplicated coordinates.
 *
 * The structural sweep at the bottom is the part that lasts. The behavioural
 * tests cover four writers; the sweep covers every writer there will ever be.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readXyzCloud, writePly, writePts, writeXyzCloud } from '../src/engines/pointcloud/text';
import { writeSurpacStr } from '../src/engines/vector/surpac';
import { decimalsFor, fixedPrecision } from '../src/core/precision';
import { crsFromEpsg } from '../src/crs/epsg';
import type { CirDataset } from '../src/core/cir';

const WGS84 = crsFromEpsg(4326);
const UTM44N = crsFromEpsg(32644);

/**
 * Eight points inside a 60 m box, expressed in degrees near Jabalpur. Spaced
 * about 1e-4 degrees — roughly 11 m, comfortably finer than the 111 m grid that
 * 3 dp imposes and coarser than the 1.1 mm that 8 dp does.
 */
const LON = 80.139;
const LAT = 23.429;
const POINTS = [
  [LON, LAT],
  [LON + 0.00012, LAT + 0.00004],
  [LON + 0.00021, LAT + 0.00017],
  [LON + 0.00018, LAT + 0.00031],
  [LON + 0.00029, LAT + 0.00044],
  [LON + 0.00009, LAT + 0.00052],
  [LON + 0.00003, LAT + 0.00038],
  [LON + 0.00015, LAT + 0.00022],
];

const SOURCE = {
  fileName: 'cloud.xyz',
  size: 0,
  formatId: 'xyz',
  formatName: 'XYZ text cloud',
  detectionConfidence: 1,
};

const WRITE_OPTIONS = {
  delimiter: ' ' as const,
  includeIntensity: false,
  includeColor: false,
  includeClassification: false,
  includeHeader: false,
};

/** A cloud in degrees, read through the real reader so the CIR is not hand-built. */
function geographicCloud(): CirDataset {
  const text = POINTS.map(([x, y]) => `${x} ${y} 310.5`).join('\n') + '\n';
  const dataset = readXyzCloud(new TextEncoder().encode(text), SOURCE);
  return { ...dataset, crs: WGS84 };
}

/** Distinct X Y pairs surviving in the written text — what collapsing destroys. */
function distinctXy(text: string): number {
  const pairs = new Set<string>();
  for (const line of text.split('\n')) {
    const cells = line.trim().split(/[\s,]+/);
    if (cells.length < 3) continue;
    const [x, y] = cells;
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) continue;
    pairs.add(`${x},${y}`);
  }
  return pairs.size;
}

describe('a point cloud in degrees is not rounded as if it were metres', () => {
  it('keeps every point through the XYZ writer at the default setting', () => {
    // Before the fix this came back as 1: all eight points rounded to
    // `80.139 23.429`, and the cloud became a single coordinate repeated.
    const { text } = writeXyzCloud(geographicCloud(), { ...WRITE_OPTIONS, precision: fixedPrecision(3) });
    expect(distinctXy(text)).toBe(POINTS.length);
  });

  it('keeps them through PTS and ASCII PLY as well', () => {
    const cloud = geographicCloud();
    for (const [name, write] of [
      ['pts', writePts],
      ['ply', writePly],
    ] as const) {
      const { text } = write(cloud, { ...WRITE_OPTIONS, precision: fixedPrecision(3) });
      expect(distinctXy(text), `${name} collapsed the cloud`).toBe(POINTS.length);
    }
  });

  it('still writes a projected cloud at the millimetre it was asked for', () => {
    // The fix must not quietly inflate every projected export: 3 dp of a metre
    // is what "3 decimals (millimetre)" promises, and that promise is correct.
    const projected = { ...geographicCloud(), crs: UTM44N };
    const { text } = writeXyzCloud(projected, { ...WRITE_OPTIONS, precision: fixedPrecision(3) });
    const first = text.split('\n')[0].trim().split(' ')[0];
    expect(first.split('.')[1]).toHaveLength(3);
  });
});

describe('Surpac takes its decimals from the frame too', () => {
  it('does not collapse a geographic string file', () => {
    const dataset: CirDataset = {
      ...geographicCloud(),
      crs: WGS84,
      pointcloud: null,
      layers: [
        {
          name: 'BOUNDARY',
          features: POINTS.map((position, index) => ({
            id: String(index),
            geometry: { type: 'Point' as const, coordinates: position },
            properties: {},
          })),
        },
      ],
    } as never;
    const { text } = writeSurpacStr(dataset as never, { precision: fixedPrecision(3) } as never);
    expect(distinctXy(text)).toBeGreaterThan(1);
  });

  it('keeps the 6 dp that full precision has always used here', () => {
    // `decimalsFor`'s third argument exists for exactly this: Surpac's full
    // mode was 6, not 15, and converting it must not silently change that.
    expect(decimalsFor({ ...fixedPrecision(3), mode: 'full' }, UTM44N, 6)).toBe(6);
  });
});

describe('no writer picks a decimal count without asking what the coordinate is', () => {
  /**
   * The sweep. Reading `linearDecimals` is correct only alongside a test of the
   * CRS — either a `geographic ?` ternary in the same expression, or the
   * `decimalsFor` helper that encapsulates it. A bare read is the defect.
   *
   * This is the test that covers writers nobody has written yet, and the one
   * that would have caught LandXML without anyone noticing it by hand.
   */
  function engineSources(): string[] {
    const root = join(import.meta.dirname, '..', 'src', 'engines');
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) found.push(path);
      }
    };
    walk(root);
    return found;
  }

  /**
   * Comments naming `linearDecimals` are the prose explaining this very rule —
   * `landxml.ts` carries one — so the sweep reads code, not what the code says
   * about itself.
   */
  const isComment = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

  it('reads linearDecimals only where the CRS was consulted', () => {
    const offenders: string[] = [];
    for (const path of engineSources()) {
      const source = readFileSync(path, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (!line.includes('linearDecimals') || isComment(line)) return;
        const consultsCrs = line.includes('geographic') || line.includes('decimalsFor');
        if (!consultsCrs) offenders.push(`${path.split('/engines/')[1]}:${index + 1}`);
      });
    }
    expect(
      offenders,
      'these write a coordinate at metre precision without checking whether it is in degrees'
    ).toEqual([]);
  });

  it('finds the sites it is meant to be watching', () => {
    // A sweep that matches nothing passes for the wrong reason. If the writers
    // stop mentioning decimals at all, this test has gone blind and should say
    // so rather than keep reporting success.
    const mentions = engineSources().filter((path) => {
      const source = readFileSync(path, 'utf8');
      return source.includes('linearDecimals') || source.includes('decimalsFor');
    });
    expect(mentions.length).toBeGreaterThanOrEqual(10);
  });
});
