/**
 * Everything the command palette can do (spec §31.5).
 *
 * A command that cannot run is LISTED WITH ITS REASON rather than hidden.
 * Hiding it makes the user search for something that is not there and conclude
 * the tool cannot do it; showing why turns a dead end into an instruction.
 */

import { canRedo, canUndo, nextRedoLabel, nextUndoLabel } from '../../core/history';
import { summarisePrediction } from '../../core/predict';
import { describePreset, type Preset, presetsFor } from '../../core/presets';
import { exportTargetsFor, isAvailable } from '../../core/registry';
import { assessHealth } from '../../qa/health';
import { type AppSettings, store } from '../../state/store';
import { type Command } from '../../ui/command-palette';
import { convertAll } from '../conversion';
import { $ } from '../dom';
import { host } from '../host';
import { updateLinkButton } from './canvas';
import { predictionFor } from './formats';
import { downloadReport } from './health';
import { historyOf, stepHistory } from './history';
import { openHelpDialog, openSettingsDialog } from './settings';
import { replayWorkflow, saveProject, saveWorkflowFromSettings } from './workflows';
import { ui } from '../ui-state';

/**
 * Everything the palette can do (spec §31.5).
 *
 * Built fresh on every open rather than once at start-up, because most commands
 * depend on what is selected: "Convert to Shapefile" is meaningless with nothing
 * queued, and a palette that offers it anyway and then fails is worse than one
 * that says why it cannot.
 */
export function buildCommands(): Command[] {
  const state = store.get();
  const item = store.selected();
  const commands: Command[] = [];

  commands.push({
    id: 'add-files',
    title: 'Add files',
    group: 'File',
    keywords: ['open', 'import', 'browse', 'drop', 'load'],
    shortcut: 'Ctrl+O',
    // Clicks the same picker the toolbar button does, so the two can never
    // diverge in what "Add files" means.
    run: () => ($('filePicker') as HTMLInputElement).click(),
  });

  commands.push({
    id: 'convert-all',
    title: 'Convert everything in the queue',
    group: 'Convert',
    keywords: ['run', 'export', 'go', 'batch'],
    shortcut: 'Ctrl+Enter',
    enabled: state.items.length > 0,
    disabledReason: 'Nothing is queued yet.',
    run: () => void convertAll(state.settings.runQa),
  });

  // One command per available target, so "kmz" or "shapefile" goes straight
  // there instead of through the format picker.
  const kind = item?.dataset?.kind ?? 'vector';
  for (const format of exportTargetsFor(kind)) {
    if (!isAvailable(format, 'export', state.native.status === 'READY')) continue;
    commands.push({
      id: `target-${format.id}`,
      title: `Convert to ${format.name}`,
      group: 'Convert',
      keywords: [...format.extensions, format.category, format.id],
      detail: item?.profile ? summarisePrediction(predictionFor(format.id)!) : undefined,
      enabled: Boolean(item),
      disabledReason: 'Select a queued file first.',
      run: () => {
        if (item) store.updateItem(item.id, { targetFormatId: format.id });
        else void store.patchSettings({ globalTargetFormatId: format.id });
        host.render();
      },
    });
  }

  for (const preset of presetsFor(item?.detection?.formatId)) {
    commands.push({
      id: `preset-${preset.id}`,
      title: preset.name,
      group: 'Preset',
      keywords: ['preset', 'workflow', 'template', ...preset.name.toLowerCase().split(/[^a-z]+/)],
      detail: preset.purpose,
      run: () => void applyPreset(preset),
    });
  }

  // --- history, workflows and the project (spec §31.1, §31.2, §31.4)
  const history = historyOf(item);

  commands.push({
    id: 'undo',
    title: canUndo(history) ? `Undo ${nextUndoLabel(history)}` : 'Undo',
    group: 'History',
    keywords: ['undo', 'revert', 'back', 'reverse', 'mistake'],
    shortcut: 'Ctrl+Z',
    enabled: Boolean(item) && canUndo(history),
    disabledReason: item ? 'Nothing has changed this file yet.' : 'Select a queued file first.',
    run: () => item && stepHistory(item.id, history.position - 1),
  });

  commands.push({
    id: 'redo',
    title: canRedo(history) ? `Redo ${nextRedoLabel(history)}` : 'Redo',
    group: 'History',
    keywords: ['redo', 'forward', 'reapply'],
    shortcut: 'Ctrl+Shift+Z',
    enabled: Boolean(item) && canRedo(history),
    disabledReason: item ? 'There is nothing to redo.' : 'Select a queued file first.',
    run: () => item && stepHistory(item.id, history.position + 1),
  });

  commands.push({
    id: 'edit-vertices',
    title: 'Edit vertices',
    group: 'Edit',
    keywords: ['vertex', 'vertices', 'node', 'edit', 'move', 'drag', 'insert', 'delete', 'geometry'],
    detail: 'Move, insert and delete vertices on the canvas, with the live readout.',
    enabled: Boolean(item?.dataset?.layers?.length),
    disabledReason: item ? 'This file has no vector layers to edit.' : 'Select a queued file first.',
    run: () => host.showInspectorTab('edit'),
  });

  commands.push({
    id: 'toggle-edit-snap',
    title: state.settings.editSnapEnabled ? 'Turn editing snap off' : 'Turn editing snap on',
    group: 'Edit',
    keywords: ['snap', 'magnet', 'vertex', 'edit'],
    detail: 'Snaps a dragged vertex to nearby geometry.',
    run: () => {
      void store.patchSettings({ editSnapEnabled: !store.get().settings.editSnapEnabled });
      host.render();
    },
  });

  commands.push({
    id: 'show-health',
    title: 'Show project health',
    group: 'QA',
    keywords: ['health', 'score', 'quality', 'audit', 'problems', 'issues', 'checklist'],
    detail: 'One score from CRS, geometry, topology, duplicates, attributes, risk and warnings — each expandable.',
    enabled: Boolean(item),
    disabledReason: 'Select a queued file first.',
    run: () => host.showBottomTab('health'),
  });

  commands.push({
    id: 'assess-health-now',
    title: 'Assess this file’s health now',
    group: 'QA',
    keywords: ['health', 'scan', 'assess', 'check', 'score', 'now'],
    detail: 'Runs the scans without converting.',
    enabled: Boolean(item?.dataset),
    disabledReason: item ? 'This file has not been read yet.' : 'Select a queued file first.',
    run: () => {
      if (!item?.dataset) return;
      // Assessed from the preview dataset the UI holds. That is a truncated
      // view for very large files, so the panel says what it was measured on
      // rather than implying it saw everything.
      const health = assessHealth(item.dataset, { prediction: item.prediction });
      store.updateItem(item.id, { health });
      store.log(health.grade === 'poor' ? 'warn' : 'ok', `${item.fileName}: ${health.summary}`);
      host.showBottomTab('health');
    },
  });

  commands.push({
    id: 'download-report',
    title: 'Download the conversion report',
    group: 'File',
    keywords: ['report', 'document', 'html', 'deliverable', 'certificate', 'sign off', 'handover'],
    detail: 'Source, processing, output, fidelity and QA as one self-contained document.',
    enabled: Boolean(item?.dataset),
    disabledReason: item ? 'This file has not been read yet.' : 'Select a queued file first.',
    run: () => item && downloadReport(item),
  });

  commands.push({
    id: 'show-history',
    title: 'Show the operation history',
    group: 'History',
    keywords: ['history', 'operations', 'checkpoint', 'audit', 'what changed'],
    detail: 'Every change to this file, each reversible.',
    run: () => host.showBottomTab('history'),
  });

  commands.push({
    id: 'record-workflow',
    title: 'Record these settings as a workflow',
    group: 'Workflow',
    keywords: ['workflow', 'record', 'save', 'automate', 'repeat', 'macro'],
    detail: 'Replays this configuration on new data, still asking before anything destructive.',
    run: () => saveWorkflowFromSettings(),
  });

  for (const workflow of state.workflows) {
    commands.push({
      id: `run-workflow-${workflow.id}`,
      title: `Replay “${workflow.name}”`,
      group: 'Workflow',
      keywords: ['workflow', 'replay', 'run', ...workflow.name.toLowerCase().split(/[^a-z]+/)],
      detail: `${workflow.steps.length} steps.`,
      enabled: Boolean(item),
      disabledReason: 'Select a queued file to replay a workflow onto.',
      run: () => void replayWorkflow(workflow),
    });
  }

  commands.push({
    id: 'save-project',
    title: 'Save project',
    group: 'Project',
    keywords: ['project', 'save', 'session', 'ubnx'],
    detail: 'Sources, CRS decisions, settings, edits and workflows — no source bytes, no credentials.',
    enabled: state.items.length > 0,
    disabledReason: 'There is nothing to save yet.',
    run: () => void saveProject(),
  });

  commands.push({
    id: 'open-project',
    title: 'Open project',
    group: 'Project',
    keywords: ['project', 'open', 'load', 'reopen', 'ubnx'],
    run: () => host.openProjectPicker(),
  });

  commands.push({
    id: 'compare-canvases',
    title: 'Compare source and output side by side',
    group: 'View',
    keywords: ['compare', 'diff', 'dual', 'canvas', 'overlay', 'side by side', 'before after'],
    detail: 'Two canvases with the geometry difference drawn over both.',
    enabled: Boolean(item),
    disabledReason: 'Select a queued file first.',
    run: () => host.showInspectorTab('compare'),
  });

  commands.push({
    id: 'toggle-link',
    title: state.compareLinked ? 'Unlink the compare panes' : 'Link the compare panes',
    group: 'View',
    keywords: ['link', 'sync', 'pan', 'zoom', 'together', 'independent'],
    run: () => {
      const linked = !store.get().compareLinked;
      store.set({ compareLinked: linked });
      ui.dualCanvas?.setLinked(linked);
      updateLinkButton();
    },
  });

  for (const [tab, label] of [
    ['overview', 'Overview'],
    ['geometry', 'Geometry'],
    ['crs', 'CRS'],
    ['layers', 'Layers'],
    ['attributes', 'Attributes'],
    ['preview', 'Preview'],
    ['fidelity', 'What will be lost'],
    ['compare', 'Compare source and output'],
    ['warnings', 'Warnings'],
  ] as [string, string][]) {
    commands.push({
      id: `tab-${tab}`,
      title: `Show ${label}`,
      group: 'View',
      keywords: ['tab', 'panel', 'inspect', tab],
      enabled: Boolean(item),
      disabledReason: 'Select a queued file first.',
      run: () => host.showInspectorTab(tab),
    });
  }

  commands.push({
    id: 'settings',
    title: 'Open settings',
    group: 'View',
    keywords: ['preferences', 'options', 'configure'],
    run: () => openSettingsDialog(),
  });
  commands.push({
    id: 'help',
    title: 'Open help',
    group: 'View',
    keywords: ['about', 'docs', 'shortcuts'],
    run: () => openHelpDialog(),
  });
  commands.push({
    id: 'theme',
    title: 'Switch theme',
    group: 'View',
    keywords: ['dark', 'light', 'appearance'],
    run: () => {
      const order: AppSettings['theme'][] = ['system', 'dark', 'light'];
      const next = order[(order.indexOf(store.get().settings.theme) + 1) % order.length];
      void store.patchSettings({ theme: next });
      host.applyTheme(next);
    },
  });
  commands.push({
    id: 'clear-queue',
    title: 'Clear the queue',
    group: 'File',
    keywords: ['remove', 'reset', 'empty'],
    enabled: state.items.length > 0,
    disabledReason: 'The queue is already empty.',
    run: () => {
      store.set({ items: [], selectedId: null });
      host.render();
    },
  });

  return commands;
}

/**
 * Applies a preset, saying what it changed.
 *
 * The log line is the point: a preset that silently rewrites eight settings is
 * a trap the next conversion springs. Listing them makes it an informed act.
 */
export async function applyPreset(preset: Preset): Promise<void> {
  const before = store.get().settings as unknown as Record<string, unknown>;
  const changes = describePreset(preset, before);
  await store.patchSettings(preset.settings as never);
  store.log(
    'ok',
    changes.length > 0
      ? `Preset "${preset.name}" applied — ${changes.join('; ')}.`
      : `Preset "${preset.name}": every setting was already as it wants them.`
  );
  host.render();
}
