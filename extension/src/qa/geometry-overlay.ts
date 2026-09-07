/**
 * The geometry overlay (spec §30.1, §30.2).
 *
 * `qa/diff.ts` answers "did anything change, and by how much" in numbers. This
 * answers "where", so the second canvas can draw it: which features were added,
 * which were dropped, which moved, and which changed geometry type — each with
 * the position to draw at and the distance it moved.
 *
 * ---------------------------------------------------------------------------
 * THE HONESTY PROBLEM, AND HOW IT IS HANDLED
 *
 * Pairing a source feature with its converted counterpart needs a
 * correspondence, and most format pairs do not preserve one. Shapefile
 * renumbers, KML has no stable id, DXF handles survive but GeoJSON ids may not.
 *
 * So the pairing is POSITIONAL — feature n of layer L against feature n of the
 * same layer — and it is only trusted when the layer's feature counts match on
 * both sides. When they do not, the layer is reported as `unpaired` with its
 * counts, and NOTHING is drawn as "moved" for it. Drawing a displacement
 * derived from a bogus pairing would be a picture of a defect that does not
 * exist, which is worse than drawing nothing: the user would go looking for it.
 *
 * The same discipline `diff.ts` applies to coordinate drift — measure it only
 * where there is a correspondence to measure against.
 *
 * LAYERS are matched by name first and by position for whatever is left over,
 * and `pairLayers` explains why matching on name alone was wrong on the single
 * commonest conversion this tool performs.
 */

import type { CirDataset, CirFeature, CirGeometry, CirLayer, Position } from '../core/cir';

export type OverlayRole = 'added' | 'removed' | 'moved' | 'retyped' | 'unchanged';

export const OVERLAY_ROLE_LABEL: Record<OverlayRole, string> = {
  added: 'In the output only',
  removed: 'In the source only',
  moved: 'Moved',
  retyped: 'Geometry type changed',
  unchanged: 'Unchanged',
};

export interface OverlayItem {
  layer: string;
  index: number;
  role: OverlayRole;
  /** Source geometry, when there is one. Drawn on the left canvas. */
  source: CirGeometry | null;
  /** Output geometry, when there is one. Drawn on the right canvas. */
  output: CirGeometry | null;
  /** Largest distance any paired vertex moved. Undefined when not comparable. */
  displacement?: number;
  /** Where to put a marker: the position that moved furthest, or the centroid. */
  at?: Position;
  /** One line for the tooltip and the list beside the canvas. */
  note: string;
}

export interface UnpairedLayer {
  layer: string;
  sourceFeatures: number;
  outputFeatures: number;
  reason: string;
}

/** How a source layer was matched to an output layer. */
export type LayerPairing = 'name' | 'position';

export interface PairedLayer {
  sourceName: string;
  outputName: string;
  pairedBy: LayerPairing;
}

export interface GeometryOverlay {
  items: OverlayItem[];
  counts: Record<OverlayRole, number>;
  /** Layers whose feature counts differ, so no pairing could be trusted. */
  unpaired: UnpairedLayer[];
  /** How each layer was matched, so a positional match is visible as one. */
  paired: PairedLayer[];
  /** Layers present on one side only. */
  layersAdded: string[];
  layersRemoved: string[];
  /** The tolerance a move was judged against, in the data's own units. */
  tolerance: number;
  /** Largest displacement anywhere in the overlay. */
  maxDisplacement: number;
  /** Items were capped at `limit`; how many were not built. */
  omitted: number;
  summary: string;
}

export interface OverlayOptions {
  /**
   * Movement below this is not a move.
   *
   * Defaults to zero, so any measurable difference shows. A caller that has
   * written at three decimal places passes 0.001 and gets the differences that
   * are not simply the rounding it asked for.
   */
  tolerance: number;
  /**
   * Largest number of items to build.
   *
   * The overlay is drawn, and drawing 400,000 markers helps nobody. Past the
   * cap the counts are still exact — they are accumulated for every feature —
   * and only the per-feature items stop being built, which the result says.
   */
  limit: number;
  /** Include unchanged features as items. Off: they are the background. */
  includeUnchanged: boolean;
}

export const DEFAULT_OVERLAY_OPTIONS: OverlayOptions = {
  tolerance: 0,
  limit: 5000,
  includeUnchanged: false,
};

export function buildGeometryOverlay(
  source: CirDataset,
  output: CirDataset,
  options: Partial<OverlayOptions> = {}
): GeometryOverlay {
  const settings = { ...DEFAULT_OVERLAY_OPTIONS, ...options };
  const items: OverlayItem[] = [];
  const counts: Record<OverlayRole, number> = { added: 0, removed: 0, moved: 0, retyped: 0, unchanged: 0 };
  const unpaired: UnpairedLayer[] = [];
  let maxDisplacement = 0;
  let omitted = 0;

  const matched = pairLayers(source, output);
  const layersRemoved = matched.sourceOnly.map((layer) => layer.name);
  const layersAdded = matched.outputOnly.map((layer) => layer.name);

  const push = (item: OverlayItem) => {
    counts[item.role]++;
    if (item.displacement !== undefined && item.displacement > maxDisplacement) maxDisplacement = item.displacement;
    if (item.role === 'unchanged' && !settings.includeUnchanged) return;
    if (items.length >= settings.limit) {
      omitted++;
      return;
    }
    items.push(item);
  };

  for (const layer of matched.sourceOnly) {
    for (const [index, feature] of layer.features.entries()) {
      push({
        layer: layer.name,
        index,
        role: 'removed',
        source: feature.geometry,
        output: null,
        at: firstPosition(feature.geometry),
        note: `Layer “${layer.name}” is not in the output.`,
      });
    }
  }

  for (const layer of matched.outputOnly) {
    for (const [index, feature] of layer.features.entries()) {
      push({
        layer: layer.name,
        index,
        role: 'added',
        source: null,
        output: feature.geometry,
        at: firstPosition(feature.geometry),
        note: `Layer “${layer.name}” is not in the source.`,
      });
    }
  }

  for (const { source: sourceLayer, output: outputLayer } of matched.pairs) {
    const name = sourceLayer.name;

    if (sourceLayer.features.length !== outputLayer.features.length) {
      unpaired.push({
        layer: name,
        sourceFeatures: sourceLayer.features.length,
        outputFeatures: outputLayer.features.length,
        reason:
          'The feature counts differ, so feature n of the source is not feature n of the output. Nothing in this layer is marked as moved, because there is no correspondence to measure a move against.',
      });

      // The count difference is still real and still worth drawing: the surplus
      // on whichever side has more is shown as added or removed. Only the
      // pairing is withheld.
      const shared = Math.min(sourceLayer.features.length, outputLayer.features.length);
      for (let index = shared; index < sourceLayer.features.length; index++) {
        push({
          layer: name,
          index,
          role: 'removed',
          source: sourceLayer.features[index].geometry,
          output: null,
          at: firstPosition(sourceLayer.features[index].geometry),
          note: `${sourceLayer.features.length - outputLayer.features.length} more features in the source than the output.`,
        });
      }
      for (let index = shared; index < outputLayer.features.length; index++) {
        push({
          layer: name,
          index,
          role: 'added',
          source: null,
          output: outputLayer.features[index].geometry,
          at: firstPosition(outputLayer.features[index].geometry),
          note: `${outputLayer.features.length - sourceLayer.features.length} more features in the output than the source.`,
        });
      }
      continue;
    }

    for (const [index, sourceFeature] of sourceLayer.features.entries()) {
      push(compare(name, index, sourceFeature, outputLayer.features[index], settings.tolerance));
    }
  }

  return {
    items,
    counts,
    unpaired,
    paired: matched.pairs.map((pair) => ({
      sourceName: pair.source.name,
      outputName: pair.output.name,
      pairedBy: pair.pairedBy,
    })),
    layersAdded,
    layersRemoved,
    tolerance: settings.tolerance,
    maxDisplacement,
    omitted,
    summary: summarise(counts, unpaired, maxDisplacement, settings.tolerance),
  };
}

interface LayerMatch {
  pairs: { source: CirLayer; output: CirLayer; pairedBy: LayerPairing }[];
  sourceOnly: CirLayer[];
  outputOnly: CirLayer[];
}

/**
 * Matches source layers to output layers.
 *
 * Matching by name alone was the obvious rule and it was WRONG on the commonest
 * conversion there is. Most single-layer readers name the layer after the file,
 * so `plots.geojson` is written out, read back as
 * `plots_converted_to_geojson.geojson`, and a name-only match reports every
 * feature as simultaneously added and removed — a screen full of red and green
 * on a conversion that changed nothing.
 *
 * So: names first, since a multi-layer source that keeps its layer table should
 * pair correctly even if the writer reorders it. Then, for whatever is left
 * over, positional pairing WHEN AND ONLY WHEN the leftovers are equal in
 * number. Every writer here preserves layer order, so position is a real
 * correspondence; unequal counts mean a layer was genuinely gained or lost, and
 * pairing across that would be inventing one.
 *
 * A positional pair is recorded as such in `paired`, so the UI can say the
 * layer was matched by position rather than let it pass as a name match.
 */
function pairLayers(source: CirDataset, output: CirDataset): LayerMatch {
  const pairs: LayerMatch['pairs'] = [];
  const outputByName = new Map(output.layers.map((layer) => [layer.name, layer]));
  const takenOutput = new Set<CirLayer>();
  const leftoverSource: CirLayer[] = [];

  for (const layer of source.layers) {
    const byName = outputByName.get(layer.name);
    if (byName && !takenOutput.has(byName)) {
      pairs.push({ source: layer, output: byName, pairedBy: 'name' });
      takenOutput.add(byName);
    } else {
      leftoverSource.push(layer);
    }
  }

  const leftoverOutput = output.layers.filter((layer) => !takenOutput.has(layer));

  if (leftoverSource.length > 0 && leftoverSource.length === leftoverOutput.length) {
    for (let index = 0; index < leftoverSource.length; index++) {
      pairs.push({ source: leftoverSource[index], output: leftoverOutput[index], pairedBy: 'position' });
    }
    return { pairs, sourceOnly: [], outputOnly: [] };
  }

  return { pairs, sourceOnly: leftoverSource, outputOnly: leftoverOutput };
}

function compare(layer: string, index: number, source: CirFeature, output: CirFeature, tolerance: number): OverlayItem {
  const left = source.geometry;
  const right = output.geometry;

  if (!left && !right) {
    return { layer, index, role: 'unchanged', source: null, output: null, note: 'Both are attribute-only.' };
  }
  if (!left) {
    return { layer, index, role: 'added', source: null, output: right, at: firstPosition(right), note: 'Geometry appears in the output.' };
  }
  if (!right) {
    return { layer, index, role: 'removed', source: left, output: null, at: firstPosition(left), note: 'Geometry is missing from the output.' };
  }

  if (left.type !== right.type) {
    return {
      layer,
      index,
      role: 'retyped',
      source: left,
      output: right,
      at: firstPosition(left),
      note: `${left.type} became ${right.type}.`,
    };
  }

  const walk = measure(left, right);
  if (!walk.comparable) {
    return {
      layer,
      index,
      role: 'retyped',
      source: left,
      output: right,
      at: firstPosition(left),
      note: 'The vertex counts differ, so the shape changed rather than moved.',
    };
  }

  if (walk.max <= tolerance) {
    return { layer, index, role: 'unchanged', source: left, output: right, displacement: walk.max, note: 'Within tolerance.' };
  }

  return {
    layer,
    index,
    role: 'moved',
    source: left,
    output: right,
    displacement: walk.max,
    at: walk.at,
    note: `Moved by up to ${walk.max.toPrecision(4)}.`,
  };
}

interface Measurement {
  comparable: boolean;
  max: number;
  at?: Position;
}

/**
 * Largest vertex displacement between two geometries of the same type.
 *
 * Returns `comparable: false` the moment the structures disagree in length.
 * A polygon that gained a vertex has not "moved" — every vertex after the
 * insertion would pair with its neighbour and report a displacement equal to
 * the segment length, which describes nothing that happened.
 */
function measure(left: CirGeometry, right: CirGeometry): Measurement {
  if (left.type === 'GeometryCollection') {
    const a = left.geometries ?? [];
    const b = right.geometries ?? [];
    if (a.length !== b.length) return { comparable: false, max: 0 };
    let max = 0;
    let at: Position | undefined;
    for (let index = 0; index < a.length; index++) {
      if (a[index].type !== b[index].type) return { comparable: false, max: 0 };
      const child = measure(a[index], b[index]);
      if (!child.comparable) return { comparable: false, max: 0 };
      if (child.max > max) {
        max = child.max;
        at = child.at;
      }
    }
    return { comparable: true, max, at };
  }

  return walkCoordinates(left.coordinates, right.coordinates);
}

function walkCoordinates(left: unknown, right: unknown): Measurement {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return { comparable: false, max: 0 };
    if (typeof left[0] === 'number' && typeof right[0] === 'number') {
      const distance = Math.hypot((right[0] as number) - (left[0] as number), (right[1] as number) - (left[1] as number));
      return { comparable: true, max: distance, at: left as Position };
    }
    let max = 0;
    let at: Position | undefined;
    for (let index = 0; index < left.length; index++) {
      const child = walkCoordinates(left[index], right[index]);
      if (!child.comparable) return { comparable: false, max: 0 };
      if (child.max > max) {
        max = child.max;
        at = child.at;
      }
    }
    return { comparable: true, max, at };
  }
  // A geometry with no coordinates on either side is comparable and identical;
  // one with coordinates on one side only is not.
  if (left === undefined && right === undefined) return { comparable: true, max: 0 };
  return { comparable: false, max: 0 };
}

function firstPosition(geometry: CirGeometry | null): Position | undefined {
  if (!geometry) return undefined;
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries ?? []) {
      const found = firstPosition(child);
      if (found) return found;
    }
    return undefined;
  }
  let node: unknown = geometry.coordinates;
  while (Array.isArray(node) && Array.isArray(node[0])) node = node[0];
  return Array.isArray(node) && typeof node[0] === 'number' ? (node as Position) : undefined;
}

function summarise(
  counts: Record<OverlayRole, number>,
  unpaired: UnpairedLayer[],
  maxDisplacement: number,
  tolerance: number
): string {
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`${counts.added.toLocaleString()} in the output only`);
  if (counts.removed > 0) parts.push(`${counts.removed.toLocaleString()} in the source only`);
  if (counts.retyped > 0) parts.push(`${counts.retyped.toLocaleString()} changed shape or type`);
  if (counts.moved > 0) parts.push(`${counts.moved.toLocaleString()} moved, by up to ${maxDisplacement.toPrecision(4)}`);

  if (parts.length === 0) {
    const within = tolerance > 0 ? ` within ${tolerance}` : '';
    return `Every feature is in the same place${within}.`;
  }

  const tail =
    unpaired.length > 0
      ? ` ${unpaired.length} layer(s) could not be paired feature-for-feature, so nothing in them is reported as moved.`
      : '';
  return parts.join(', ') + '.' + tail;
}
