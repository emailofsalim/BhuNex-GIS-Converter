/** Workflows (spec §31.2) and the project file (spec §31.4). */

import { ENGINE_VERSION } from '../../core/cir';
import {
  buildProject,
  matchSources,
  PROJECT_EXTENSION,
  type ProjectSource,
  readProject,
  summariseMatches,
  writeProject,
} from '../../core/project';
import {
  describeWorkflow,
  recordWorkflow,
  runWorkflow,
  validateWorkflow,
  type Workflow,
  type WorkflowSettings,
} from '../../core/workflow';
import { type AppSettings, DEFAULT_SETTINGS, store } from '../../state/store';
import { downloadBytes } from '../conversion';
import { element, messageBlock } from '../dom';
import { host } from '../host';

/** The settings in force, in the shape a workflow records and replays. */
export function workflowSettings(): WorkflowSettings {
  const settings = store.get().settings;
  return {
    globalTargetFormatId: settings.globalTargetFormatId ?? undefined,
    outputLayout: settings.outputLayout,
    precisionMode: settings.precisionMode,
    precisionDecimals: settings.precisionDecimals,
    preserveZ: settings.preserveZ,
    sourceCrsEpsg: settings.sourceCrsEpsg,
    targetCrsEpsg: settings.targetCrsEpsg,
    arcTolerance: settings.arcTolerance,
    kmlTemplate: settings.kmlTemplate,
    kmlBoreholeLog: settings.kmlBoreholeLog,
    kmlBalloonFooter: settings.kmlBalloonFooter,
    polygonizeEnabled: settings.polygonizeEnabled,
    polygonizeTolerance: settings.polygonizeTolerance,
    polygonizeKeepLines: settings.polygonizeKeepLines,
    burnInEnabled: settings.burnInEnabled,
    burnInField: settings.burnInField,
    burnInMode: settings.burnInMode,
    burnInPriority: settings.burnInPriority,
    burnInReplaceSource: settings.burnInReplaceSource,
    decimationMode: settings.decimationMode,
    mirrorBatchTree: settings.mirrorBatchTree,
    repairCloseRings: settings.repairCloseRings,
    repairRemoveDuplicateVertices: settings.repairRemoveDuplicateVertices,
    repairNormalizeOrientation: settings.repairNormalizeOrientation,
    repairDeduplicateFeatures: settings.repairDeduplicateFeatures,
    snapTolerance: settings.snapTolerance,
    runQa: settings.runQa,
    embedMetadata: settings.embedMetadata,
  };
}

export function workflowsPanel(): HTMLElement[] {
  const state = store.get();
  const wrap = element('div', { style: 'padding:12px' });

  const controls = element('div', { class: 'row', style: 'gap:8px; margin-bottom:10px; flex-wrap:wrap' });
  const record = element('button', { class: 'btn btn--primary', type: 'button', text: 'Record current settings as a workflow' });
  record.addEventListener('click', () => saveWorkflowFromSettings());
  controls.append(record);
  wrap.append(controls);

  wrap.append(
    element('p', {
      class: 'small faint',
      text: 'A workflow replays the settings that produced a conversion on new data. Steps that would ask before running — a CRS assertion, polygonisation, a burn-in that deletes the source text — still ask on replay.',
    })
  );

  if (state.workflows.length === 0) {
    wrap.append(element('p', { class: 'muted', text: 'No workflows saved yet.' }));
    return [wrap];
  }

  for (const workflow of state.workflows) {
    const card = element('div', { class: 'section' });
    const head = element('div', { class: 'row', style: 'gap:8px; align-items:center' });
    head.append(element('h3', { class: 'section__title', style: 'margin:0', text: workflow.name }));
    head.append(element('span', { class: 'topbar__spacer' }));

    const runButton = element('button', { class: 'btn', type: 'button', text: 'Replay' }) as HTMLButtonElement;
    runButton.disabled = !store.selected();
    runButton.title = store.selected() ? 'Applies this workflow to the selected file.' : 'Select a file to replay a workflow onto it.';
    runButton.addEventListener('click', () => void replayWorkflow(workflow));
    head.append(runButton);

    const remove = element('button', { class: 'btn btn--ghost', type: 'button', text: 'Delete' });
    remove.addEventListener('click', () => {
      store.set({ workflows: store.get().workflows.filter((entry) => entry.id !== workflow.id) });
      store.log('info', `Workflow “${workflow.name}” deleted.`);
      host.render();
    });
    head.append(remove);
    card.append(head);

    if (workflow.recordedFrom) {
      card.append(element('p', { class: 'small faint', text: `Recorded from a ${workflow.recordedFrom.toUpperCase()} source.` }));
    }

    const steps = element('ol', { class: 'workflow__steps' });
    for (const line of describeWorkflow(workflow)) {
      steps.append(element('li', { class: 'workflow__step', text: line.replace(/^\d+\.\s*/, '') }));
    }
    card.append(steps);

    for (const problem of validateWorkflow(workflow)) {
      card.append(messageBlock(problem.severity === 'error' ? 'error' : 'warn', problem.message));
    }

    wrap.append(card);
  }

  return [wrap];
}

export function saveWorkflowFromSettings(): void {
  const item = store.selected();
  const suggestion = item?.detection?.formatId ? `${item.detection.formatId.toUpperCase()} job` : 'New workflow';
  const name = window.prompt('Name this workflow', suggestion);
  if (!name) return;

  const workflow = recordWorkflow(workflowSettings(), { name, recordedFrom: item?.detection?.formatId });
  const problems = validateWorkflow(workflow);
  const blocking = problems.filter((problem) => problem.severity === 'error');
  if (blocking.length > 0) {
    store.log('error', `Workflow “${name}” not saved: ${blocking.map((problem) => problem.message).join(' ')}`);
    host.render();
    return;
  }

  store.set({ workflows: [...store.get().workflows, workflow] });
  store.log('ok', `Workflow “${name}” saved with ${workflow.steps.length} steps.`);
  host.render();
}

/**
 * Replays a workflow onto the selected file.
 *
 * The confirmation handler is a real prompt, not a rubber stamp: it is what
 * keeps a replayed step and a hand-run step the same act (R18). A user who
 * cancels a step gets a conversion without it, and the log says which step did
 * not run rather than reporting a clean replay.
 */
export async function replayWorkflow(workflow: Workflow): Promise<void> {
  const item = store.selected();
  if (!item) return;

  const result = await runWorkflow(workflow, {
    base: workflowSettings(),
    confirm: (request) =>
      window.confirm(
        `${workflow.name} — step ${request.index} of ${request.total}\n\n${request.step.label}\n\n${request.confirmation.what}\n\n${request.confirmation.why}\n\nRun this step?`
      ),
  });

  const patch: Partial<AppSettings> = {};
  for (const [key, value] of Object.entries(result.settings)) {
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }
  await store.patchSettings(patch);

  store.log(result.complete ? 'ok' : 'warn', result.summary);
  host.render();
}

/**
 * Saves the project (§31.4).
 *
 * Sources are recorded as identities rather than embedded: see `core/project.ts`
 * for why. What travels is every decision — CRS, settings, edits, workflows and
 * the export configuration — which is what makes reopening one resume the job
 * rather than restart it.
 */
export async function saveProject(): Promise<void> {
  const state = store.get();
  const name = window.prompt('Project name', state.projectName ?? 'Untitled project');
  if (!name) return;

  const sources: ProjectSource[] = state.items.map((item) => ({
    id: item.id,
    fileName: item.fileName,
    path: item.path,
    containers: item.containers ?? [],
    size: item.size,
    sha256: item.provenance?.sha256,
    formatId: item.detection?.formatId ?? 'unknown',
    formatName: item.detection?.formatName ?? 'Unknown',
    detectionConfidence: item.detection?.confidence ?? 0,
    forcedFormatId: item.forcedFormatId,
    crs: item.dataset?.crs ?? null,
    crsOrigin: item.dataset?.crsOrigin ?? 'unknown',
    targetFormatId: item.targetFormatId,
    carriage: 'reference',
    history: item.history ? { entries: item.history.entries, position: item.history.position, dropped: item.history.dropped } : undefined,
    qa: item.qa ? { passed: item.qa.verdict === 'PASS', summary: item.qa.summary, checkedAt: Date.now() } : undefined,
    diff: item.diff ? { passed: item.diff.passed, summary: item.diff.summary } : undefined,
  }));

  const project = buildProject({
    name,
    productVersion: ENGINE_VERSION,
    settings: state.settings as unknown as Record<string, unknown>,
    sources,
    workflows: state.workflows,
    exportConfig: {
      globalTargetFormatId: state.settings.globalTargetFormatId,
      outputLayout: state.settings.outputLayout,
      naming: state.settings.naming,
      mirrorBatchTree: state.settings.mirrorBatchTree,
      embedMetadata: state.settings.embedMetadata,
    },
  });

  downloadBytes(writeProject(project), `${sanitiseFileName(name)}.${PROJECT_EXTENSION}`, 'application/json');
  store.set({ projectName: name });
  if (project.droppedSecretFields.length > 0) {
    store.log('warn', `Project saved. ${project.droppedSecretFields.length} credential-shaped field(s) were not written: ${project.droppedSecretFields.join(', ')}.`);
  } else {
    store.log('ok', `Project “${name}” saved with ${sources.length} source(s) and ${state.workflows.length} workflow(s).`);
  }
  host.render();
}

/** Opens a project file and restores what does not need the source bytes. */
export async function openProject(file: File): Promise<void> {
  const result = readProject(new Uint8Array(await file.arrayBuffer()));
  if (!result.project) {
    store.log('error', `${file.name}: ${result.error?.what} ${result.error?.why} ${result.error?.action}`);
    host.render();
    return;
  }

  const project = result.project;
  for (const note of result.notes) store.log('info', `${project.name}: ${note}`);

  // Settings are merged over the defaults so a project written by an older
  // build gains this build's new settings instead of leaving them undefined.
  await store.patchSettings({ ...DEFAULT_SETTINGS, ...(project.settings as Partial<AppSettings>) });
  store.set({ workflows: project.workflows, projectName: project.name });

  const matches = matchSources(
    project,
    store.get().items.map((item) => ({ fileName: item.fileName, path: item.path, size: item.size, sha256: item.provenance?.sha256 }))
  );
  store.log('ok', `Project “${project.name}” opened. ${summariseMatches(matches)}`);

  for (const match of matches) {
    if (match.state === 'same' || match.state === 'missing') continue;
    store.log('warn', `${match.source.fileName}: ${match.note}`);
  }
  host.render();
}

export function sanitiseFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}
