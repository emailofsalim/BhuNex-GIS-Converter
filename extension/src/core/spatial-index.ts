/**
 * Uniform grid spatial index (spec §14.5).
 *
 * Format conversion never needed one: a reader walks its input once. Topology
 * does. "Do any of these 40,000 parcels overlap?" is 800 million comparisons
 * without an index and a few hundred thousand with one, which is the difference
 * between a check that runs and a check that hangs the worker.
 *
 * A uniform grid rather than an R-tree, deliberately:
 *
 *  - It bulk-loads in one pass with no tree balancing, so building it is cheap
 *    enough to do per check rather than maintaining it across edits.
 *  - Its behaviour is predictable. An R-tree degrades in ways that are hard to
 *    reason about when boxes overlap heavily — which is exactly what cadastral
 *    parcels and contour lines look like.
 *  - Cell size is derived from the data (average feature size), so it adapts to
 *    a dataset of survey points and one of mine-lease polygons alike.
 *
 * The one case it handles poorly is a few enormous features among many small
 * ones: a lease boundary spanning the whole extent lands in every cell it
 * crosses. `MAX_CELLS_PER_ITEM` caps that, and an item that would exceed it is
 * held in an `oversized` list scanned on every query — correct, and slower only
 * for the handful of features that deserve it.
 */

import type { Bounds } from './cir';

export interface IndexedItem<T> {
  bounds: Bounds;
  value: T;
}

/** Beyond this an item goes in the oversized list instead of flooding the grid. */
const MAX_CELLS_PER_ITEM = 256;

/** Grid dimension is clamped so a huge dataset cannot allocate an absurd table. */
const MIN_GRID = 1;
const MAX_GRID = 512;

export class SpatialIndex<T> {
  private readonly cells = new Map<number, number[]>();
  private readonly items: IndexedItem<T>[] = [];
  private readonly oversized: number[] = [];
  private readonly extent: Bounds;
  private readonly columns: number;
  private readonly rows: number;
  private readonly cellWidth: number;
  private readonly cellHeight: number;

  constructor(items: IndexedItem<T>[]) {
    this.items = items;
    this.extent = boundsOf(items);

    const width = Math.max(this.extent.maxX - this.extent.minX, Number.EPSILON);
    const height = Math.max(this.extent.maxY - this.extent.minY, Number.EPSILON);

    // Aim at roughly one item per cell: sqrt(n) cells on each axis. Any finer
    // and the per-item cell lists dominate; any coarser and queries degenerate
    // towards a linear scan.
    const target = Math.ceil(Math.sqrt(Math.max(items.length, 1)));
    this.columns = clamp(target, MIN_GRID, MAX_GRID);
    this.rows = clamp(target, MIN_GRID, MAX_GRID);
    this.cellWidth = width / this.columns;
    this.cellHeight = height / this.rows;

    items.forEach((item, index) => {
      const span = this.cellRange(item.bounds);
      const cellCount = (span.maxColumn - span.minColumn + 1) * (span.maxRow - span.minRow + 1);
      if (cellCount > MAX_CELLS_PER_ITEM) {
        this.oversized.push(index);
        return;
      }
      for (let column = span.minColumn; column <= span.maxColumn; column++) {
        for (let row = span.minRow; row <= span.maxRow; row++) {
          const key = row * this.columns + column;
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(index);
          else this.cells.set(key, [index]);
        }
      }
    });
  }

  get size(): number {
    return this.items.length;
  }

  private cellRange(bounds: Bounds): { minColumn: number; maxColumn: number; minRow: number; maxRow: number } {
    const minColumn = clamp(Math.floor((bounds.minX - this.extent.minX) / this.cellWidth), 0, this.columns - 1);
    const maxColumn = clamp(Math.floor((bounds.maxX - this.extent.minX) / this.cellWidth), 0, this.columns - 1);
    const minRow = clamp(Math.floor((bounds.minY - this.extent.minY) / this.cellHeight), 0, this.rows - 1);
    const maxRow = clamp(Math.floor((bounds.maxY - this.extent.minY) / this.cellHeight), 0, this.rows - 1);
    return { minColumn, maxColumn, minRow, maxRow };
  }

  /** Indices of every item whose bounds may intersect the query box. */
  search(query: Bounds): number[] {
    const found = new Set<number>(this.oversized);
    const span = this.cellRange(query);
    for (let column = span.minColumn; column <= span.maxColumn; column++) {
      for (let row = span.minRow; row <= span.maxRow; row++) {
        const bucket = this.cells.get(row * this.columns + column);
        if (!bucket) continue;
        for (const index of bucket) found.add(index);
      }
    }
    // The grid is a coarse filter; the exact box test happens here so callers
    // never have to remember to do it.
    return [...found].filter((index) => boundsIntersect(this.items[index].bounds, query));
  }

  item(index: number): IndexedItem<T> {
    return this.items[index];
  }

  /**
   * Visits every candidate pair once, in index order.
   *
   * Deduplicating with `other > index` is what keeps a pairwise check from
   * reporting "A overlaps B" and "B overlaps A" as two separate defects.
   */
  eachCandidatePair(visit: (left: number, right: number) => void): void {
    for (let index = 0; index < this.items.length; index++) {
      for (const other of this.search(this.items[index].bounds)) {
        if (other > index) visit(index, other);
      }
    }
  }
}

export function boundsIntersect(left: Bounds, right: Bounds): boolean {
  return !(left.maxX < right.minX || left.minX > right.maxX || left.maxY < right.minY || left.minY > right.maxY);
}

/** Grows a box by `amount` on every side, for a tolerance-aware query. */
export function expandBounds(bounds: Bounds, amount: number): Bounds {
  return {
    minX: bounds.minX - amount,
    minY: bounds.minY - amount,
    maxX: bounds.maxX + amount,
    maxY: bounds.maxY + amount,
  };
}

function boundsOf<T>(items: IndexedItem<T>[]): Bounds {
  const extent: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const item of items) {
    if (item.bounds.minX < extent.minX) extent.minX = item.bounds.minX;
    if (item.bounds.minY < extent.minY) extent.minY = item.bounds.minY;
    if (item.bounds.maxX > extent.maxX) extent.maxX = item.bounds.maxX;
    if (item.bounds.maxY > extent.maxY) extent.maxY = item.bounds.maxY;
  }
  if (!Number.isFinite(extent.minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return extent;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.max(low, Math.min(high, value));
}
