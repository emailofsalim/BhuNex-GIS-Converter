/**
 * The queue of edits waiting to be re-planned against the whole file.
 *
 * Every editing panel funnels through `queueEdit`. It records the INTENT, shows
 * its effect on the preview immediately, and leaves the authoritative version
 * of the operation to `core/edits.ts` at conversion time.
 */

import { describeCommand, type EditCommand, isWholeLayer, replayEdits } from '../../core/edits';
import { recordOperation } from '../../core/history';
import { type QueueItem, store } from '../../state/store';
import { element, ghostButton } from '../dom';
import { host } from '../host';
import { datasetForTools, protectedFor, truncationOf } from './dataset';
import { historyOf } from './history';

/**
 * What `queueEdit` needs from a plan: whether it refused, and why.
 *
 * Named structurally rather than as a union of the plan types, because that
 * union grew by one every time an editing engine was added and nothing here
 * ever looked at the other fields. A new engine should not have to edit this
 * file to be queueable.
 */
export interface RefusablePlan {
  refusal?: { what: string; why: string; action: string };
}

/**
 * Records an edit and shows its effect immediately.
 *
 * Two things happen, and the difference between them is the whole design:
 *
 *   THE COMMAND is appended to `item.edits`. That is what conversion replays
 *     against the full file, and it is the only thing that reaches the output.
 *
 *   THE PREVIEW is updated by applying the plan to the loaded features, so the
 *     canvas and the table show the result now rather than after a conversion.
 *
 * The preview can therefore cover fewer rows than the command will. That is
 * stated on screen rather than hidden, because the alternative — showing only
 * what the preview can do — would under-report a correct edit.
 */
export function queueEdit(item: QueueItem, command: EditCommand, plan: RefusablePlan, label: string): void {
  if (plan.refusal) {
    store.log('warn', `${plan.refusal.what} ${plan.refusal.why} ${plan.refusal.action}`);
    host.render();
    return;
  }

  const before = item.dataset;
  const preview = applyToPreview(item, command);

  store.updateItem(item.id, {
    dataset: preview,
    edits: [...(item.edits ?? []), command],
    history: recordOperation(historyOf(item), before, preview, { kind: 'edit', label }),
  });

  const truncated = truncationOf(item, layerOfCommand(command) ?? '');
  if (truncated && isWholeLayer(command)) {
    store.log(
      'ok',
      `${label} — applied to all ${truncated.total.toLocaleString()} features on conversion; ${truncated.shown.toLocaleString()} shown here.`
    );
  } else {
    store.log('ok', label);
  }
  host.render();
}

export function layerOfCommand(command: EditCommand): string | null {
  if (command.kind === 'layer-merge') return command.layers[0];
  if (command.kind === 'vertices') return null;
  return command.layer;
}

/** Re-runs one command against the loaded preview, so the UI shows its effect. */
export function applyToPreview(item: QueueItem, command: EditCommand): any {
  const source = datasetForTools(item);
  const replayed = replayEdits(source, [command], { protectedLayers: protectedFor(item) });
  if (replayed.failure) return item.dataset;

  // Fold the result back into the UI's own layer shape, which carries
  // `preview`, `featureCount` and `previewTruncated` alongside the features.
  const originals = new Map<string, any>((item.dataset?.layers ?? []).map((layer: any) => [layer.name, layer]));
  const layers = replayed.dataset.layers.map((layer: any) => {
    const original = originals.get(layer.name);
    return {
      ...(original ?? {}),
      name: layer.name,
      path: layer.path,
      fields: layer.fields,
      geometryTypes: layer.geometryTypes,
      style: layer.style,
      preview: layer.features,
      // A layer's true count only changes when features move between layers.
      featureCount: original && original.name === layer.name ? original.featureCount : layer.features.length,
      previewTruncated: original?.previewTruncated ?? false,
    };
  });

  return { ...item.dataset, layers };
}

/** The edits queued for this file, with a way to take the last one back. */
export function pendingEditsPanel(item: QueueItem, commands: EditCommand[]): HTMLElement {
  const panel = element('div', { class: 'edits' });
  panel.append(
    element('div', { class: 'edits__head' }, [
      element('span', { class: 'edits__title', text: `${commands.length} edit${commands.length === 1 ? '' : 's'} will be applied on conversion` }),
    ])
  );

  const list = element('ol', { class: 'edits__list' });
  for (const command of commands) {
    const entry = element('li');
    entry.append(element('span', { text: describeCommand(command) }));
    if (isWholeLayer(command)) {
      const layerName = layerOfCommand(command);
      const truncated = layerName ? truncationOf(item, layerName) : null;
      if (truncated) {
        entry.append(
          element('span', {
            class: 'edits__scope',
            text: ` — all ${truncated.total.toLocaleString()} features`,
            title: `The table shows ${truncated.shown.toLocaleString()}; this edit is re-run against every feature when you convert.`,
          })
        );
      }
    }
    list.append(entry);
  }
  panel.append(list);

  const foot = element('div', { class: 'edits__foot' });
  foot.append(
    ghostButton('Undo the last edit', () => {
      const all = item.edits ?? [];
      if (all.length === 0) return;
      // The preview is rebuilt from the remaining commands rather than reversed
      // in place: replaying N-1 commands cannot drift from replaying N.
      const remaining = all.slice(0, -1);
      rebuildPreviewFrom(item, remaining);
    })
  );
  foot.append(
    ghostButton('Discard every edit', () => rebuildPreviewFrom(item, []))
  );
  panel.append(foot);
  return panel;
}

/**
 * Rebuilds the preview from a command list.
 *
 * Undo re-runs what remains rather than reversing what was removed: an inverse
 * that drifts from the forward operation is the classic source of an undo that
 * leaves the data subtly different from where it started.
 */
export function rebuildPreviewFrom(item: QueueItem, commands: EditCommand[]): void {
  const pristine = item.pristineDataset ?? item.dataset;
  let dataset = pristine;

  for (const command of commands) {
    dataset = applyToPreview({ ...item, dataset }, command);
  }

  store.updateItem(item.id, { dataset, edits: commands, pristineDataset: pristine });
  store.log('ok', commands.length === 0 ? 'All edits discarded.' : `${commands.length} edit(s) remain.`);
  host.render();
}
