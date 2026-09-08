/**
 * Rasterize and vectorize (spec §16, Phase 4).
 *
 * The two halves of crossing between the vector and raster worlds:
 *
 *   RASTERIZE turns polygons into a grid — a parcel layer becomes a zone mask
 *     that can be used to clip, or a burn value written into a DEM.
 *
 *   VECTORIZE turns a grid into polygons — a classified raster becomes editable
 *     boundaries that can be delivered as a shapefile or DXF.
 *
 * ---------------------------------------------------------------------------
 * VECTORIZE MERGES CELLS, IT DOES NOT TRACE THEM
 *
 * The naive vectorize emits one square per pixel and calls it a polygon layer.
 * A 4000×4000 classified raster then produces sixteen million squares, which is
 * not a shapefile anyone can open, and every internal edge between two cells of
 * the same class is a boundary that does not exist on the ground.
 *
 * So the cells of a region are found first — a flood fill over equal values —
 * and only the boundary of the whole region is emitted. What comes out is the
 * shape a person would draw, with the count of regions rather than of pixels.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BOUNDARY WALK IS ON CELL CORNERS
 *
 * A region boundary runs between cells, not through them. Walking it on the
 * corner lattice — the integer grid one larger in each direction — means every
 * boundary vertex is an exact integer pair, so two regions that share an edge
 * produce exactly coincident boundaries rather than ones that differ in the
 * last bit and leave slivers on dissolve. That is the same reason the contour
 * engine keys its joins on edge identity rather than on coordinates.
 *
 * ---------------------------------------------------------------------------
 * A CONTINUOUS RASTER IS REFUSED, NOT QUANTISED
 *
 * Vectorizing a DEM gives one region per distinct elevation: forty thousand
 * one-pixel polygons that are individually correct and collectively useless.
 * Quantising it silently to make the output tidy would invent classes nobody
 * chose. So a continuous raster is refused with the two things that DO work
 * named: contour it, or classify it first.
 *
 * The DATA decides that, not the `isElevation` flag. The ASCII-grid reader
 * marks every `.asc` as elevation because most of them are, and a zone map
 * written as `.asc` would otherwise be refused on the strength of that guess
 * while its three integer values sat there saying otherwise. A small number of
 * whole-number values is a classification whatever the flag says; the flag only
 * breaks the tie when the values are not whole numbers.
 */

import type { CirFeature, CirRaster, Position, Warning } from '../../core/cir';
import { pointInRing } from '../../core/geometry';

// ===========================================================================
// Vectorize
// ===========================================================================

export interface VectorizeOptions {
  band?: number;
  /** Cells with this value are not emitted. Defaults to the raster's no-data. */
  skipValue?: number | null;
  /** Refuse rather than emit more than this many regions. */
  maxRegions?: number;
  /** Field the cell value is written to. */
  fieldName?: string;
}

export interface VectorizeResult {
  features: CirFeature[];
  warnings: Warning[];
  refusal?: { what: string; why: string; action: string };
}

const DEFAULT_MAX_REGIONS = 20_000;

export function vectorizeRaster(raster: CirRaster, options: VectorizeOptions = {}): VectorizeResult {
  const band = options.band ?? 0;

  if (!raster.hasPixelData || !raster.bands || !raster.bands[band]) {
    return refuseVector(
      'This raster carries no pixel data, so there is nothing to vectorize.',
      'Only the georeference and the image structure were read.',
      'Convert from a raster whose pixels this tool can read; the Overview tab names the compression when that is the reason.'
    );
  }
  if (!raster.geotransform) {
    return refuseVector(
      'This raster has no georeference, so the polygons would have no position.',
      'Without a geotransform a pixel column and row cannot become a coordinate.',
      'Supply the world file alongside the image, or set the georeference first.'
    );
  }

  const values = raster.bands[band];
  const { width, height } = raster;
  const skip = options.skipValue === undefined ? raster.noData : options.skipValue;
  const warnings: Warning[] = [];

  // A continuous surface has as many regions as it has distinct values, and
  // vectorizing it produces one polygon per pixel. Quantising it here to make
  // the output tidy would invent classes nobody chose — see the header.
  //
  // `isElevation` is a HINT, not the evidence. The ASCII-grid reader marks
  // every .asc as elevation because most of them are, and a zone map written
  // as .asc would be refused on the strength of that guess while its three
  // integer values sat there saying otherwise. So the DATA decides: a small
  // number of whole-number values is a classification whatever the flag says,
  // and the flag only breaks the tie when the data is ambiguous.
  const distinct = countDistinct(values, skip, 1000);
  const looksClassified = !distinct.exceeded && distinct.counted <= 64 && distinct.allIntegers;

  if (distinct.exceeded || (raster.isElevation && !looksClassified)) {
    return refuseVector(
      'This raster looks continuous rather than classified, so vectorizing it would produce one polygon per pixel.',
      distinct.exceeded
        ? `More than ${distinct.counted.toLocaleString()} distinct values were found. A classified raster has a handful; this many means the values are measurements rather than categories.`
        : `It is marked as elevation and its ${distinct.counted.toLocaleString()} value(s) are not whole numbers, so they are measurements rather than category codes. Every cell would become its own region — individually correct, collectively useless.`,
      'Trace contours instead if this is a surface, or classify it into categories first and vectorize that.'
    );
  }

  if (raster.isElevation && looksClassified) {
    warnings.push({
      code: 'vectorize-elevation-classified',
      severity: 'info',
      message: `This raster is marked as elevation, but its ${distinct.counted} whole-number value(s) look like category codes, so it was vectorized.`,
      reason: 'The ASCII grid format carries no way to say whether a grid holds elevations or class codes, so the reader assumes elevation — which is right for most .asc files and wrong for a zone map.',
      action: 'If these really are elevations, trace contours instead: the polygons here would be one per distinct height.',
    });
  }

  const maxRegions = options.maxRegions ?? DEFAULT_MAX_REGIONS;
  const fieldName = options.fieldName ?? 'value';

  const visited = new Uint8Array(width * height);
  const features: CirFeature[] = [];
  const blank = (value: number): boolean => !Number.isFinite(value) || (skip !== null && skip !== undefined && value === skip);

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const index = row * width + column;
      if (visited[index]) continue;

      const value = values[index];
      if (blank(value)) {
        visited[index] = 1;
        continue;
      }

      const cells = floodFill(values, visited, width, height, column, row, value);
      const rings = traceRegion(cells, width);
      if (rings.length === 0) continue;

      features.push({
        geometry: {
          type: 'Polygon',
          coordinates: rings.map((ring) => ring.map((position) => toGround(position, raster.geotransform!))),
          dimension: 2,
        },
        properties: { [fieldName]: value, cells: cells.size },
      });

      if (features.length > maxRegions) {
        return refuseVector(
          'This raster produces more regions than a vector file can usefully hold.',
          `More than ${maxRegions.toLocaleString()} separate regions were traced. A layer that size will not open in most desktop GIS, and tracing the rest would take far longer than it already has.`,
          'Classify the raster into fewer categories first, or clip it to the area you actually need.'
        );
      }
    }
  }

  if (features.length === 0) {
    warnings.push({
      code: 'vectorize-empty',
      severity: 'warning',
      message: 'No regions were produced.',
      reason: 'Every pixel is no-data, or matches the value being skipped.',
      action: 'Check the no-data value in the Overview tab against the file.',
    });
  } else {
    warnings.push({
      code: 'vectorize-done',
      severity: 'info',
      message: `${features.length.toLocaleString()} region(s) traced from ${distinct.counted.toLocaleString()} distinct value(s).`,
      reason: 'Adjacent cells sharing a value were merged into one polygon rather than emitted as one square each — the internal edges between them are not boundaries on the ground.',
      action: 'Each polygon carries its cell value and its cell count.',
    });
  }

  return { features, warnings };
}

/** Every cell reachable from a seed with the same value, by 4-connectivity. */
function floodFill(
  values: Float64Array,
  visited: Uint8Array,
  width: number,
  height: number,
  startColumn: number,
  startRow: number,
  value: number
): Set<number> {
  const cells = new Set<number>();
  // An explicit stack rather than recursion: a region spanning a 4000-pixel
  // raster is 16 million deep, and recursion there is a stack overflow rather
  // than a slow answer.
  const stack: number[] = [startRow * width + startColumn];
  visited[stack[0]] = 1;

  while (stack.length > 0) {
    const index = stack.pop() as number;
    cells.add(index);
    const column = index % width;
    const row = (index - column) / width;

    const consider = (c: number, r: number): void => {
      if (c < 0 || r < 0 || c >= width || r >= height) return;
      const next = r * width + c;
      if (visited[next]) return;
      if (values[next] !== value) return;
      visited[next] = 1;
      stack.push(next);
    };

    consider(column - 1, row);
    consider(column + 1, row);
    consider(column, row - 1);
    consider(column, row + 1);
  }

  return cells;
}

/**
 * The boundary rings of a set of cells, on the corner lattice.
 *
 * Every boundary edge separates a cell in the region from one outside it. The
 * edges are collected, then joined end to end — and because every endpoint is
 * an integer corner, the joins are exact and two regions sharing an edge
 * produce coincident boundaries rather than near-coincident ones.
 *
 * The first ring returned is the outer boundary and the rest are holes, which
 * is the CIR's convention for a polygon.
 */
function traceRegion(cells: Set<number>, width: number): Position[][] {
  /** Key for a corner-lattice point, so an edge is a pair of integers. */
  const corner = (column: number, row: number): number => row * (width + 1) + column;

  const edges = new Map<number, number[]>();
  const addEdge = (fromColumn: number, fromRow: number, toColumn: number, toRow: number): void => {
    const from = corner(fromColumn, fromRow);
    const to = corner(toColumn, toRow);
    const list = edges.get(from);
    if (list) list.push(to);
    else edges.set(from, [to]);
  };

  for (const index of cells) {
    const column = index % width;
    const row = (index - column) / width;

    // Wound so the region stays on the left of each edge, which makes the
    // outer ring counter-clockwise and every hole clockwise without a second
    // pass to work out which is which.
    if (!cells.has(index - width) || row === 0) addEdge(column, row, column + 1, row);
    if (!cells.has(index + width)) addEdge(column + 1, row + 1, column, row + 1);
    if (column === 0 || !cells.has(index - 1)) addEdge(column, row + 1, column, row);
    if (!cells.has(index + 1) || column === width - 1) addEdge(column + 1, row, column + 1, row + 1);
  }

  const rings: Position[][] = [];
  const positionOf = (key: number): Position => {
    const column = key % (width + 1);
    return [column, (key - column) / (width + 1)];
  };

  while (edges.size > 0) {
    const start = edges.keys().next().value as number;
    const ring: Position[] = [];
    let current = start;

    for (;;) {
      const outgoing = edges.get(current);
      if (!outgoing || outgoing.length === 0) {
        edges.delete(current);
        break;
      }
      const next = outgoing.pop() as number;
      if (outgoing.length === 0) edges.delete(current);

      ring.push(positionOf(current));
      current = next;
      if (current === start) {
        ring.push(positionOf(start));
        break;
      }
    }

    if (ring.length >= 4) rings.push(simplifyCollinear(ring));
  }

  if (rings.length === 0) return [];

  // The largest ring by absolute area is the shell; the rest sit inside it.
  rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  return rings;
}

/**
 * Drops vertices that lie on a straight run.
 *
 * A cell boundary emits one vertex per cell edge, so a 500-pixel straight side
 * arrives as 501 collinear points. Keeping them makes the file large and the
 * geometry no more accurate; every removed point is exactly on the line between
 * its neighbours, so nothing moves.
 */
function simplifyCollinear(ring: Position[]): Position[] {
  if (ring.length < 4) return ring;
  const out: Position[] = [ring[0]];

  for (let index = 1; index < ring.length - 1; index++) {
    const previous = out[out.length - 1];
    const current = ring[index];
    const next = ring[index + 1];
    const cross =
      (current[0] - previous[0]) * (next[1] - previous[1]) - (current[1] - previous[1]) * (next[0] - previous[0]);
    if (cross !== 0) out.push(current);
  }

  out.push(ring[ring.length - 1]);
  return out;
}

function ringArea(ring: Position[]): number {
  let total = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    total += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return total / 2;
}

function countDistinct(
  values: Float64Array,
  skip: number | null | undefined,
  limit: number
): { counted: number; exceeded: boolean; allIntegers: boolean } {
  const seen = new Set<number>();
  let allIntegers = true;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value) || (skip !== null && skip !== undefined && value === skip)) continue;
    if (!Number.isInteger(value)) allIntegers = false;
    seen.add(value);
    if (seen.size > limit) return { counted: seen.size, exceeded: true, allIntegers };
  }
  return { counted: seen.size, exceeded: false, allIntegers };
}

/** Corner-lattice position to ground. No half-pixel shift: a corner is a corner. */
function toGround(position: Position, geotransform: NonNullable<CirRaster['geotransform']>): Position {
  const [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight] = geotransform;
  const [column, row] = position;
  return [
    originX + column * pixelWidth + row * rowRotation,
    originY + column * columnRotation + row * pixelHeight,
  ];
}

function refuseVector(what: string, why: string, action: string): VectorizeResult {
  return { features: [], warnings: [], refusal: { what, why, action } };
}

// ===========================================================================
// Rasterize
// ===========================================================================

export interface RasterizeOptions {
  /** Polygons in ground coordinates: shell first, then holes. */
  polygons: { rings: Position[][]; value: number }[];
  width: number;
  height: number;
  geotransform: [number, number, number, number, number, number];
  /** Value for cells no polygon covers. */
  background?: number;
  /** Keep a cell any polygon touches, rather than one whose centre is covered. */
  touched?: boolean;
}

export interface RasterizeResult {
  raster?: CirRaster;
  warnings: Warning[];
  burned: number;
  refusal?: { what: string; why: string; action: string };
}

/**
 * Burns polygons into a grid.
 *
 * Later polygons win where they overlap, which is the convention every GIS
 * uses and the only one that is predictable: the alternative — refusing on
 * overlap — makes rasterizing a cadastral layer with one shared boundary
 * impossible, and averaging the values would invent a class.
 */
export function rasterizePolygons(options: RasterizeOptions): RasterizeResult {
  if (!(options.width > 0) || !(options.height > 0)) {
    return {
      warnings: [],
      burned: 0,
      refusal: {
        what: 'The target grid has no size.',
        why: `A ${options.width} × ${options.height} grid holds no cells.`,
        action: 'Choose a pixel size that divides into the extent at least once.',
      },
    };
  }
  if (options.polygons.length === 0) {
    return {
      warnings: [],
      burned: 0,
      refusal: {
        what: 'No polygons were given to burn.',
        why: 'The chosen layer holds no closed rings.',
        action: 'Choose a polygon layer, or run the CAD polygonisation step to build boundaries from line work first.',
      },
    };
  }

  const background = options.background ?? -9999;
  const band = new Float64Array(options.width * options.height).fill(background);
  const [originX, pixelWidth, rowRotation, originY, columnRotation, pixelHeight] = options.geotransform;
  let burned = 0;

  for (let row = 0; row < options.height; row++) {
    for (let column = 0; column < options.width; column++) {
      const samples: Position[] = options.touched
        ? [
            [0.5, 0.5],
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ]
        : [[0.5, 0.5]];

      let hit: number | null = null;
      for (const [dx, dy] of samples) {
        const x = originX + (column + dx) * pixelWidth + (row + dy) * rowRotation;
        const y = originY + (column + dx) * columnRotation + (row + dy) * pixelHeight;

        // Last polygon wins, so the loop runs forward and keeps overwriting.
        for (const polygon of options.polygons) {
          const [shell, ...holes] = polygon.rings;
          if (!shell || !pointInRing([x, y], shell)) continue;
          if (holes.some((hole) => pointInRing([x, y], hole))) continue;
          hit = polygon.value;
        }
        if (hit !== null) break;
      }

      if (hit !== null) {
        band[row * options.width + column] = hit;
        burned++;
      }
    }
  }

  return {
    raster: {
      width: options.width,
      height: options.height,
      bandCount: 1,
      pixelType: 'float32',
      noData: background,
      geotransform: options.geotransform,
      extent: null,
      bands: [band],
      hasPixelData: true,
      // NOT elevation: the values are class codes, and marking it elevation
      // would make the contour engine offer to contour a category.
      isElevation: false,
    },
    warnings: [
      {
        code: 'rasterize-done',
        severity: 'info',
        message: `${burned.toLocaleString()} of ${(options.width * options.height).toLocaleString()} cells were burned from ${options.polygons.length.toLocaleString()} polygon(s).`,
        reason: options.touched
          ? 'A cell was burned when any part of it fell inside a polygon.'
          : 'A cell was burned when its CENTRE fell inside a polygon.',
        action: 'Where polygons overlap, the last one in the layer wins.',
        count: burned,
      },
    ],
    burned,
  };
}
