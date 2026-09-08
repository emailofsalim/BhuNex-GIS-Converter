/**
 * The dataset accessors every editing panel shares.
 *
 * Kept in one place because all four of them encode the same fact — the
 * workspace holds a TRUNCATED preview — and four copies of that fact is how one
 * of them ends up not saying so.
 */

import { EMPTY_VIEW, type LayerViewState, lockedLayers } from '../../core/layers';
import { EMPTY_TABLE, type QueueItem, store, type TableState } from '../../state/store';

/**
 * The dataset the layer and attribute tools work against.
 *
 * `layer.preview` is at most 5,000 features per layer, and that limit is the
 * whole reason `core/edits.ts` exists: everything here is planned against the
 * preview so the user sees a result immediately, and then REPLANNED against the
 * full file at conversion time. Nothing computed in this file is exported.
 */
export function datasetForTools(item: QueueItem): any {
  return {
    ...item.dataset,
    layers: (item.dataset?.layers ?? []).map((layer: any) => ({
      name: layer.name,
      path: layer.path ?? [layer.name],
      features: layer.preview ?? [],
      fields: layer.fields ?? [],
      geometryTypes: layer.geometryTypes ?? [],
      style: layer.style,
    })),
    warnings: item.dataset?.warnings ?? [],
  };
}

export function viewOf(item: QueueItem): LayerViewState {
  return item.layerView ?? EMPTY_VIEW;
}

export function tableStateOf(item: QueueItem): TableState {
  return item.table ?? EMPTY_TABLE;
}

/** The layers no edit may touch: the settings list plus every padlocked layer. */
export function protectedFor(item: QueueItem): string[] {
  return [...new Set([...(store.get().settings.protectedLayers ?? []), ...lockedLayers(viewOf(item))])];
}

/**
 * Whether a layer holds more features than the workspace loaded.
 *
 * Every panel that can write has to say this, because the number on screen is
 * not the number that will be edited — and the edit is right while the number
 * is misleading.
 */
export function truncationOf(item: QueueItem, layerName: string): { shown: number; total: number } | null {
  const layer = (item.dataset?.layers ?? []).find((candidate: any) => candidate.name === layerName);
  if (!layer || !layer.previewTruncated) return null;
  return { shown: (layer.preview ?? []).length, total: layer.featureCount ?? (layer.preview ?? []).length };
}
