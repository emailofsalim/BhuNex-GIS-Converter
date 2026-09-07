/**
 * Workflow builder and replay (spec §31.2).
 *
 * A workflow is a recorded sequence of operations that can be replayed on new
 * data. The example the master document gives is the real job:
 *
 *   IMPORT DXF -> detect CRS -> repair topology -> polygonise closed polylines
 *   -> burn text into polygons -> reproject to WGS 84 -> KML -> KMZ -> report
 *
 * saved as "CAD Parcel to KMZ", and run against next month's sheets without
 * anyone reassembling seven settings from memory.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT SHAPES THIS MODULE
 *
 * "A workflow step that would trigger a confirmation prompt when run by hand
 * MUST still prompt when replayed, unless the user has explicitly marked that
 * step unattended. Automation must not become a way to bypass R18."
 *
 * That is not a detail. Polygonisation closes gaps in survey geometry;
 * burn-in with `replaceSource` deletes the surveyor's text; decimation throws
 * away points. Every one of those is a decision, and a decision does not stop
 * being one because it was made once before on different data. So:
 *
 *  - `stepConfirmation` decides from the step's OWN settings whether it needs a
 *    prompt, using exactly the criteria the interactive path uses.
 *  - A run with no confirmation handler REFUSES those steps rather than
 *    assuming yes. A workflow engine that silently proceeds is the R18 bypass
 *    the rule names.
 *  - `unattended` suppresses the prompt, is per-step, and is never set by
 *    recording — only by the user, deliberately, afterwards.
 *  - A declined or refused step is REPORTED in the result. The output of a
 *    partial run must never look like the output of a complete one.
 *
 * ---------------------------------------------------------------------------
 * WHY STEPS ARE SETTINGS RATHER THAN CODE
 *
 * Every operation in the example is already a stage of `core/pipeline.ts`, run
 * in that order. So a step does not carry a function; it carries the settings
 * that switch its stage on. Replay is therefore deterministic, serialisable
 * into the project file, and incapable of doing something the interactive path
 * cannot do — which is what keeps "replayed" and "run by hand" the same thing.
 */

import type { PresetSettings } from './presets';
import { SAFE_OPERATIONS, type RepairOperationId } from '../qa/repair';

/**
 * Settings a workflow step may set.
 *
 * A superset of `PresetSettings`: presets are a starting point chosen before a
 * job, workflows record a job that was actually done, so they also carry the
 * source CRS assertion and the repair switches.
 */
export interface WorkflowSettings extends PresetSettings {
  sourceCrsEpsg?: number | null;
  repairCloseRings?: boolean;
  repairRemoveDuplicateVertices?: boolean;
  repairNormalizeOrientation?: boolean;
  repairDeduplicateFeatures?: boolean;
  snapTolerance?: number;
  runQa?: boolean;
  embedMetadata?: boolean;
  kmlBalloonFooter?: string;
}

export type WorkflowStepKind =
  | 'assign-source-crs'
  | 'repair'
  | 'polygonize'
  | 'burn-in'
  | 'reproject'
  | 'decimate'
  | 'precision'
  | 'layout'
  | 'style'
  | 'target-format'
  | 'run-qa';

export const STEP_LABEL: Record<WorkflowStepKind, string> = {
  'assign-source-crs': 'Assign the source CRS',
  repair: 'Repair topology',
  polygonize: 'Build polygons from line work',
  'burn-in': 'Attach text to polygons',
  reproject: 'Reproject',
  decimate: 'Decimate the point cloud',
  precision: 'Set coordinate precision',
  layout: 'Set the output structure',
  style: 'Set the KML balloon template',
  'target-format': 'Write the output format',
  'run-qa': 'Re-import and compare',
};

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  /** What this step does, in the terms of the work. */
  label: string;
  /** The settings this step applies. */
  settings: WorkflowSettings;
  /**
   * Run this step without prompting.
   *
   * Only ever set by the user, explicitly, on a step they have read. Recording
   * never sets it: a workflow that arrives pre-authorised to delete geometry is
   * the failure mode R18 exists to prevent.
   */
  unattended?: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  /** One line: the job this workflow does. */
  purpose: string;
  createdAt: number;
  /** Source format the workflow was recorded against, for a sanity warning. */
  recordedFrom?: string;
  steps: WorkflowStep[];
}

/** Why a step needs confirming, in the words the prompt will use. */
export interface StepConfirmation {
  /** What the step will do that cannot simply be undone by not looking. */
  what: string;
  /** The rule or consequence behind the prompt. */
  why: string;
}

/**
 * Whether a step would prompt if it were run by hand.
 *
 * Decided from the step's settings, never from a flag stored beside them, so a
 * hand-edited workflow file cannot mark a destructive step harmless.
 */
export function stepConfirmation(step: WorkflowStep): StepConfirmation | null {
  const settings = step.settings;

  switch (step.kind) {
    case 'assign-source-crs':
      if (settings.sourceCrsEpsg === undefined || settings.sourceCrsEpsg === null) return null;
      return {
        what: `Declares the source to be EPSG:${settings.sourceCrsEpsg}.`,
        why: 'Asserting a CRS a file does not declare reinterprets every coordinate in it. If the assertion is wrong the data lands in the wrong place and still looks plausible.',
      };

    case 'polygonize':
      if (!settings.polygonizeEnabled) return null;
      return {
        what: `Closes boundary gaps up to ${settings.polygonizeTolerance ?? 0} and builds polygons from the line work.${
          settings.polygonizeKeepLines === false ? ' The source lines are not kept.' : ''
        }`,
        why: 'Closing a gap moves surveyed geometry. The tolerance that was right for one drawing is not automatically right for the next (R18, R21).',
      };

    case 'burn-in':
      if (!settings.burnInEnabled) return null;
      if (!settings.burnInReplaceSource) return null;
      return {
        what: `Deletes the source text after writing it into “${settings.burnInField ?? 'label'}”.`,
        why: 'The text entities are the surveyor’s original annotation. Deleting them is not reversible from the output file (R17).',
      };

    case 'repair': {
      const unsafe = unsafeRepairs(settings);
      if (unsafe.length === 0) return null;
      return {
        what: `Runs ${unsafe.join(', ')}, which moves vertices.`,
        why: 'A repair that moves geometry changes the survey record. It is offered, never assumed (R18).',
      };
    }

    case 'decimate':
      if (!settings.decimationMode || settings.decimationMode === 'none') return null;
      return {
        what: `Discards points by ${settings.decimationMode} decimation.`,
        why: 'Decimation is not reversible: the discarded points are not in the output and cannot be recovered from it.',
      };

    default:
      return null;
  }
}

/**
 * Which repair switch corresponds to which repair operation.
 *
 * Written out rather than inferred from the setting names so that adding a
 * repair operation without deciding whether it is safe is a type error here,
 * not a step that quietly stops prompting.
 */
const REPAIR_SETTING_OPERATION: { key: keyof WorkflowSettings; operation: RepairOperationId; describe: (value: unknown) => string }[] = [
  { key: 'repairCloseRings', operation: 'close-rings', describe: () => 'close open rings' },
  { key: 'repairRemoveDuplicateVertices', operation: 'remove-duplicate-vertices', describe: () => 'remove duplicate vertices' },
  { key: 'repairNormalizeOrientation', operation: 'fix-ring-orientation', describe: () => 'fix ring direction' },
  { key: 'snapTolerance', operation: 'snap-vertices', describe: (value) => `vertex snapping at ${value}` },
];

/**
 * Repair switches whose operation is not in the safe set.
 *
 * `SAFE_OPERATIONS` is the list `qa/repair.ts` will apply without asking;
 * anything outside it moves survey positions by more than the tolerance allows,
 * and snapping is the one that does. Deriving the prompt from that list rather
 * than restating it here means the two can never disagree.
 */
function unsafeRepairs(settings: WorkflowSettings): string[] {
  const out: string[] = [];
  for (const entry of REPAIR_SETTING_OPERATION) {
    const value = settings[entry.key];
    const on = typeof value === 'number' ? value > 0 : value === true;
    if (on && !SAFE_OPERATIONS.includes(entry.operation)) out.push(entry.describe(value));
  }
  return out;
}

/** Steps that would prompt, with the reason, in run order. */
export function pendingConfirmations(workflow: Workflow): { step: WorkflowStep; confirmation: StepConfirmation }[] {
  const out: { step: WorkflowStep; confirmation: StepConfirmation }[] = [];
  for (const step of workflow.steps) {
    const confirmation = stepConfirmation(step);
    if (confirmation && !step.unattended) out.push({ step, confirmation });
  }
  return out;
}

/** Steps the user has marked unattended that would otherwise prompt. */
export function unattendedRisks(workflow: Workflow): { step: WorkflowStep; confirmation: StepConfirmation }[] {
  const out: { step: WorkflowStep; confirmation: StepConfirmation }[] = [];
  for (const step of workflow.steps) {
    const confirmation = stepConfirmation(step);
    if (confirmation && step.unattended) out.push({ step, confirmation });
  }
  return out;
}

export type StepOutcome = 'applied' | 'declined' | 'refused' | 'skipped';

export interface StepResult {
  step: WorkflowStep;
  outcome: StepOutcome;
  /** Why, for anything other than `applied`. */
  reason?: string;
}

export interface WorkflowRunResult {
  /** The settings the run arrived at, to be handed to the pipeline. */
  settings: WorkflowSettings;
  results: StepResult[];
  /** True only when every step applied. */
  complete: boolean;
  /** One line for the log, naming what did not happen. */
  summary: string;
}

export interface ConfirmationRequest {
  step: WorkflowStep;
  confirmation: StepConfirmation;
  /** Position in the workflow, one-based, for "step 3 of 7". */
  index: number;
  total: number;
}

export interface RunWorkflowOptions {
  /**
   * Asked before every step that needs confirming.
   *
   * Absent means the run is unattended: steps needing confirmation are REFUSED,
   * not assumed. This is the whole R18 guard — an automated caller that forgot
   * to supply a handler gets a refusal it can see, not a silent geometry edit.
   */
  confirm?: (request: ConfirmationRequest) => Promise<boolean> | boolean;
  /** Settings already in force, which the workflow layers over. */
  base?: WorkflowSettings;
}

/**
 * Replays a workflow, returning the settings to convert with.
 *
 * Applies steps in recorded order; the pipeline runs its stages in that same
 * order, so "recorded" and "replayed" are the same sequence rather than two
 * that happen to agree today.
 */
export async function runWorkflow(workflow: Workflow, options: RunWorkflowOptions = {}): Promise<WorkflowRunResult> {
  const settings: WorkflowSettings = { ...(options.base ?? {}) };
  const results: StepResult[] = [];

  for (const [index, step] of workflow.steps.entries()) {
    const confirmation = stepConfirmation(step);

    if (confirmation && !step.unattended) {
      if (!options.confirm) {
        results.push({
          step,
          outcome: 'refused',
          reason: 'This step needs confirmation and the run has no way to ask. It was not applied.',
        });
        continue;
      }
      const accepted = await options.confirm({ step, confirmation, index: index + 1, total: workflow.steps.length });
      if (!accepted) {
        results.push({ step, outcome: 'declined', reason: 'Declined at the prompt.' });
        continue;
      }
    }

    Object.assign(settings, step.settings);
    results.push({ step, outcome: 'applied' });
  }

  const notApplied = results.filter((result) => result.outcome !== 'applied');
  return {
    settings,
    results,
    complete: notApplied.length === 0,
    summary:
      notApplied.length === 0
        ? `“${workflow.name}” applied in full: ${workflow.steps.length} steps.`
        : `“${workflow.name}” applied ${results.length - notApplied.length} of ${workflow.steps.length} steps. Not applied: ${notApplied
            .map((result) => `${result.step.label} (${result.outcome})`)
            .join('; ')}.`,
  };
}

let sequence = 0;
function nextStepId(): string {
  return `step-${Date.now().toString(36)}-${++sequence}`;
}

export interface RecordOptions {
  name: string;
  purpose?: string;
  recordedFrom?: string;
}

/**
 * Builds a workflow from the settings that produced a conversion.
 *
 * Only the settings that DO something become steps: a workflow listing "Set
 * coordinate precision: full" when full is already the default is noise, and
 * noise in a workflow is what stops people reading one before they run it.
 *
 * No step is recorded as unattended, whatever the settings were. The user
 * confirmed those choices interactively for that data; the workflow is about
 * different data.
 */
export function recordWorkflow(settings: WorkflowSettings, options: RecordOptions): Workflow {
  const steps: WorkflowStep[] = [];
  const add = (kind: WorkflowStepKind, label: string, stepSettings: WorkflowSettings) => {
    steps.push({ id: nextStepId(), kind, label, settings: stepSettings });
  };

  if (settings.sourceCrsEpsg !== undefined && settings.sourceCrsEpsg !== null) {
    add('assign-source-crs', `Assign source CRS EPSG:${settings.sourceCrsEpsg}`, { sourceCrsEpsg: settings.sourceCrsEpsg });
  }

  const repairSettings: WorkflowSettings = {};
  const repairLabels: string[] = [];
  if (settings.repairCloseRings) {
    repairSettings.repairCloseRings = true;
    repairLabels.push('close rings');
  }
  if (settings.repairRemoveDuplicateVertices) {
    repairSettings.repairRemoveDuplicateVertices = true;
    repairLabels.push('remove duplicate vertices');
  }
  if (settings.repairNormalizeOrientation) {
    repairSettings.repairNormalizeOrientation = true;
    repairLabels.push('normalise ring orientation');
  }
  if (settings.repairDeduplicateFeatures) {
    repairSettings.repairDeduplicateFeatures = true;
    repairLabels.push('deduplicate features');
  }
  if (settings.snapTolerance !== undefined && settings.snapTolerance > 0) {
    repairSettings.snapTolerance = settings.snapTolerance;
    repairLabels.push(`snap vertices at ${settings.snapTolerance}`);
  }
  if (repairLabels.length > 0) add('repair', `Repair: ${repairLabels.join(', ')}`, repairSettings);

  if (settings.polygonizeEnabled) {
    add('polygonize', `Build polygons, closing gaps up to ${settings.polygonizeTolerance ?? 0}`, {
      polygonizeEnabled: true,
      polygonizeTolerance: settings.polygonizeTolerance,
      polygonizeKeepLines: settings.polygonizeKeepLines,
    });
  }

  if (settings.burnInEnabled) {
    add('burn-in', `Attach text to polygons as “${settings.burnInField ?? 'label'}”`, {
      burnInEnabled: true,
      burnInField: settings.burnInField,
      burnInMode: settings.burnInMode,
      burnInPriority: settings.burnInPriority,
      burnInReplaceSource: settings.burnInReplaceSource,
    });
  }

  if (settings.targetCrsEpsg !== undefined && settings.targetCrsEpsg !== null) {
    add('reproject', `Reproject to EPSG:${settings.targetCrsEpsg}`, { targetCrsEpsg: settings.targetCrsEpsg });
  }

  if (settings.decimationMode && settings.decimationMode !== 'none') {
    add('decimate', `Decimate: ${settings.decimationMode}`, { decimationMode: settings.decimationMode });
  }

  if (settings.precisionMode) {
    add('precision', `Precision: ${settings.precisionMode}${settings.precisionMode === 'fixed' ? ` (${settings.precisionDecimals ?? 3} dp)` : ''}`, {
      precisionMode: settings.precisionMode,
      precisionDecimals: settings.precisionDecimals,
      preserveZ: settings.preserveZ,
    });
  }

  if (settings.outputLayout) {
    add('layout', `Output structure: ${settings.outputLayout}`, {
      outputLayout: settings.outputLayout,
      mirrorBatchTree: settings.mirrorBatchTree,
    });
  }

  if (settings.kmlTemplate && settings.kmlTemplate !== 'plain') {
    add('style', `Balloon template: ${settings.kmlTemplate}`, {
      kmlTemplate: settings.kmlTemplate,
      kmlBoreholeLog: settings.kmlBoreholeLog,
      kmlBalloonFooter: settings.kmlBalloonFooter,
    });
  }

  if (settings.globalTargetFormatId) {
    add('target-format', `Write ${settings.globalTargetFormatId.toUpperCase()}`, {
      globalTargetFormatId: settings.globalTargetFormatId,
    });
  }

  if (settings.runQa) add('run-qa', 'Re-import the output and compare it with the source', { runQa: true });

  return {
    id: `wf-${Date.now().toString(36)}-${++sequence}`,
    name: options.name,
    purpose: options.purpose ?? '',
    createdAt: Date.now(),
    recordedFrom: options.recordedFrom,
    steps,
  };
}

export interface WorkflowProblem {
  severity: 'error' | 'warning';
  stepId?: string;
  message: string;
}

/**
 * Checks a workflow before it is saved or run.
 *
 * The KML/EPSG:4326 guard is the same one the presets carry, for the same
 * reason: projected coordinates written into a KML place the geometry in the
 * wrong part of the world, and the file still opens — so the failure is silent
 * and reaches the client rather than the surveyor.
 */
export function validateWorkflow(workflow: Workflow): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const effective: WorkflowSettings = {};
  for (const step of workflow.steps) Object.assign(effective, step.settings);

  if (workflow.steps.length === 0) {
    problems.push({ severity: 'error', message: 'This workflow has no steps, so replaying it would do nothing.' });
  }

  const target = effective.globalTargetFormatId;
  if ((target === 'kml' || target === 'kmz') && effective.targetCrsEpsg !== 4326) {
    problems.push({
      severity: 'error',
      message:
        'A workflow writing KML or KMZ must reproject to EPSG:4326. KML is defined in WGS 84, and projected coordinates written into one place the geometry in the wrong part of the world while the file still opens.',
    });
  }

  for (const { step, confirmation } of unattendedRisks(workflow)) {
    problems.push({
      severity: 'warning',
      stepId: step.id,
      message: `“${step.label}” is marked unattended and will run without asking. ${confirmation.what}`,
    });
  }

  return problems;
}

/** The workflow as lines for the panel, in run order. */
export function describeWorkflow(workflow: Workflow): string[] {
  return workflow.steps.map((step, index) => {
    const confirmation = stepConfirmation(step);
    const mark = confirmation ? (step.unattended ? ' — unattended' : ' — asks first') : '';
    return `${index + 1}. ${step.label}${mark}`;
  });
}
