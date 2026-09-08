/**
 * Edit commands: what the user changed, replayed onto the real dataset.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 *
 * The workspace holds a SUMMARY of each file — up to 5,000 features per layer
 * (see `workers/convert.worker.ts`, `summarise`). A 40,000-parcel shapefile is
 * previewed by its first 5,000 parcels, and that is correct: a full CIR of a
 * 40-million-point cloud cannot cross the worker boundary.
 *
 * But conversion re-reads the source file. So an edit made against the preview
 * never reached the exported file at all. The vertex editor, the attribute
 * table and the layer manager were all editing a picture of the data.
 *
 * There were two ways to fix that, and only one of them is safe:
 *
 *   SEND THE RESULT — hand the worker the edited features. Wrong. The plan was
 *     computed against 5,000 of 40,000 rows, so "set OWNER to State" carries
 *     5,000 changes and the other 35,000 parcels keep their old owner. The user
 *     asked for a whole column and silently got an eighth of one.
 *
 *   SEND THE INTENT — hand the worker "set OWNER to State on layer Plots", and
 *     re-plan it there against all 40,000. Right, and what this file does.
 *
 * So a command is a DESCRIPTION, never a diff. It is small enough to store in a
 * project file, it survives a reload, it replays onto a corrected source file,
 * and it cannot mean something different from what the user was shown.
 *
 * ---------------------------------------------------------------------------
 * THE ONE EXCEPTION
 *
 * Vertex edits carry their change list, because "move this corner to here" has
 * no re-plannable description — the intent IS the coordinate. Those changes are
 * addressed by feature index, and since the preview is `features.slice(0, N)`,
 * index i in the preview is index i in the full layer. Indices past the end are
 * reported rather than applied.
 *
 * ---------------------------------------------------------------------------
 * A REFUSED COMMAND STOPS THE REPLAY
 *
 * Commands compose: renaming a field and then calculating from it only works in
 * that order. If one refuses, every later command was written against a dataset
 * that no longer exists, so the replay stops and says which command failed and
 * what was already applied. Skipping the failure and continuing would produce a
 * file matching no state the user ever saw.
 */

import type { CirDataset, FieldDef, StyleHint } from './cir';
import {
  applyAttributes,
  planAddField,
  planCalculate,
  planDeleteField,
  planRenameField,
  planRetypeField,
  planSetValue,
  type FieldType,
} from './attributes';
import {
  applyLayers,
  planDeleteLayer,
  planMergeLayers,
  planRenameLayer,
  planReorder,
  planSplitLayer,
  planStyleLayer,
  type SplitBy,
} from './layers';
import { applyEdit, type EditPlan } from './vertex-edit';
import {
  applyGeometryOperation,
  describeGeometryPlan,
  GEOMETRY_LABEL,
  planGeometryOperation,
  type GeometryOperation,
  type GeometryOptions,
} from './geometry-ops';

export type EditCommand =
  // Attribute table (§25.5)
  | { kind: 'set'; layer: string; field: string; value: unknown; scope?: number[] }
  | { kind: 'calculate'; layer: string; field: string; expression: string; scope?: number[] }
  | { kind: 'add-field'; layer: string; field: FieldDef; initialValue?: unknown }
  | { kind: 'delete-field'; layer: string; field: string }
  | { kind: 'rename-field'; layer: string; field: string; newName: string }
  | { kind: 'retype-field'; layer: string; field: string; type: FieldType; force?: boolean }
  // Layer manager (§25.4)
  | { kind: 'layer-rename'; layer: string; to: string }
  | { kind: 'layer-merge'; layers: string[]; into: string }
  | { kind: 'layer-split'; layer: string; by: SplitBy }
  | { kind: 'layer-reorder'; layer: string; toIndex: number }
  | { kind: 'layer-delete'; layer: string }
  | { kind: 'layer-style'; layer: string; style: StyleHint }
  // Vertex editor (§25.1) — the change list, for the reason given above.
  | { kind: 'vertices'; plan: EditPlan }
  // Geometry operations (§26.2). A description, not a result: the buffer the
  // user previewed covered 5,000 parcels and the one that ships covers 40,000,
  // and only re-planning gets that right. `crs` is deliberately NOT stored —
  // the replay reads it from the dataset, so a command saved in a project file
  // is re-gated against whatever CRS the file actually has when it reopens.
  | { kind: 'geometry'; layer: string; operation: GeometryOperation; options: StoredGeometryOptions };

/**
 * The part of `GeometryOptions` a command may carry.
 *
 * `protectedLayers` and `crs` are omitted ON PURPOSE. Both are properties of the
 * dataset and the session, not of the operation: a command that carried its own
 * protected list could be replayed to edit a layer the user has since locked,
 * and one that carried its own CRS would let a buffer planned on a projected
 * copy run against a geographic source — the exact failure the CRS gate exists
 * to stop. The replay supplies both from the dataset in front of it.
 */
export type StoredGeometryOptions = Omit<Partial<GeometryOptions>, 'protectedLayers' | 'crs'>;

export interface ReplayOptions {
  /** Layers the user marked protected or locked. Every command refuses on them. */
  protectedLayers?: string[];
}

export interface ReplayResult {
  dataset: CirDataset;
  /** How many commands were applied, in order. */
  applied: number;
  /** What each applied command did, for the conversion log and the report. */
  log: string[];
  /**
   * Why the replay stopped. Absent means every command applied.
   *
   * `index` is the position of the command that failed, so the UI can point at
   * the operation in the history rather than saying "an edit failed".
   */
  failure?: { index: number; command: EditCommand; what: string; why: string; action: string };
}

/**
 * Replans and applies every command against `dataset`.
 *
 * Nothing here trusts a stored plan: each command is planned afresh against the
 * dataset it will actually modify. That is what makes a command computed
 * against 5,000 previewed rows correct across 40,000 real ones.
 */
export function replayEdits(dataset: CirDataset, commands: EditCommand[], options: ReplayOptions = {}): ReplayResult {
  const protectedLayers = options.protectedLayers ?? [];
  const log: string[] = [];
  let current = dataset;

  for (const [index, command] of commands.entries()) {
    const outcome = applyOne(current, command, protectedLayers);

    if (outcome.refusal) {
      return {
        dataset: current,
        applied: index,
        log,
        failure: { index, command, ...outcome.refusal },
      };
    }

    current = outcome.dataset;
    log.push(outcome.description);
  }

  return { dataset: current, applied: commands.length, log };
}

interface OneResult {
  dataset: CirDataset;
  description: string;
  refusal?: { what: string; why: string; action: string };
}

function applyOne(dataset: CirDataset, command: EditCommand, protectedLayers: string[]): OneResult {
  // One list, one name, checked by the attribute planner and the layer planner
  // alike — see `LayerOptions.protectedLayers`.
  const options = { protectedLayers };

  switch (command.kind) {
    // ---------------------------------------------------------- attributes
    case 'set': {
      const plan = planSetValue(dataset, command.layer, command.field, command.value, { ...options, scope: command.scope });
      return fromAttributes(dataset, plan, `Set "${command.field}" on ${command.layer}`);
    }
    case 'calculate': {
      const plan = planCalculate(dataset, command.layer, command.field, command.expression, {
        ...options,
        scope: command.scope,
      });
      return fromAttributes(dataset, plan, `Calculated "${command.field}" on ${command.layer} from ${command.expression}`);
    }
    case 'add-field': {
      const plan = planAddField(dataset, command.layer, command.field, command.initialValue ?? null, options);
      return fromAttributes(dataset, plan, `Added field "${command.field.name}" to ${command.layer}`);
    }
    case 'delete-field': {
      const plan = planDeleteField(dataset, command.layer, command.field, options);
      return fromAttributes(dataset, plan, `Deleted field "${command.field}" from ${command.layer}`);
    }
    case 'rename-field': {
      const plan = planRenameField(dataset, command.layer, command.field, command.newName, options);
      return fromAttributes(dataset, plan, `Renamed "${command.field}" to "${command.newName}" on ${command.layer}`);
    }
    case 'retype-field': {
      const plan = planRetypeField(dataset, command.layer, command.field, command.type, {
        ...options,
        force: command.force,
      });
      return fromAttributes(dataset, plan, `Changed "${command.field}" on ${command.layer} to ${command.type}`);
    }

    // ---------------------------------------------------------- layers
    case 'layer-rename':
      return fromLayers(dataset, planRenameLayer(dataset, command.layer, command.to, options), `Renamed layer ${command.layer} to ${command.to}`);
    case 'layer-merge':
      return fromLayers(dataset, planMergeLayers(dataset, command.layers, command.into, options), `Merged ${command.layers.join(', ')} into ${command.into}`);
    case 'layer-split':
      return fromLayers(dataset, planSplitLayer(dataset, command.layer, command.by, options), `Split ${command.layer}`);
    case 'layer-reorder':
      return fromLayers(dataset, planReorder(dataset, command.layer, command.toIndex), `Moved ${command.layer} to position ${command.toIndex + 1}`);
    case 'layer-delete':
      return fromLayers(dataset, planDeleteLayer(dataset, command.layer, options), `Deleted layer ${command.layer}`);
    case 'layer-style':
      return fromLayers(dataset, planStyleLayer(dataset, command.layer, command.style, options), `Restyled ${command.layer}`);

    // ---------------------------------------------------------- vertices
    case 'vertices': {
      const plan = command.plan;
      if (plan.refusal) return { dataset, description: '', refusal: plan.refusal };

      // A change addressed past the end of the real layer means the preview and
      // the source no longer agree — the file changed under the edit. Reporting
      // that beats writing a partial edit.
      const outOfRange = plan.changes.find((change) => {
        const layer = dataset.layers.find((candidate) => candidate.name === change.ref.layer);
        return !layer || change.ref.featureIndex >= layer.features.length;
      });
      if (outOfRange) {
        return {
          dataset,
          description: '',
          refusal: {
            what: 'A vertex edit refers to a feature the source file does not have.',
            why: `Layer "${outOfRange.ref.layer}", feature ${outOfRange.ref.featureIndex + 1}. The file has changed since the edit was made.`,
            action: 'Re-read the file and make the edit again.',
          },
        };
      }

      const applied = applyEdit(dataset, plan);
      return {
        dataset: applied.dataset,
        description: `Moved ${plan.changes.length} vertex/vertices by at most ${plan.maxDisplacement.toFixed(3)}`,
      };
    }

    // ---------------------------------------------------------- geometry
    case 'geometry': {
      // Re-planned here, against the full dataset and its real CRS. The plan the
      // user previewed is deliberately not reused: it was computed over at most
      // 5,000 features, and a dissolve of 5,000 of 40,000 parcels is a different
      // shape, not a smaller one.
      const plan = planGeometryOperation(dataset, command.layer, command.operation, {
        ...command.options,
        protectedLayers,
        crs: dataset.crs ?? null,
      });
      if (plan.refusal) return { dataset, description: '', refusal: plan.refusal };

      const applied = applyGeometryOperation(dataset, plan);
      return { dataset: applied.dataset, description: describeGeometryPlan(plan) };
    }

    default:
      return { dataset, description: '' };
  }
}

function fromAttributes(dataset: CirDataset, plan: ReturnType<typeof planSetValue>, description: string): OneResult {
  if (plan.refusal) return { dataset, description, refusal: plan.refusal };
  const applied = applyAttributes(dataset, plan);
  const rows = new Set(plan.changes.map((change) => change.featureIndex)).size;
  return { dataset: applied.dataset, description: `${description} (${rows.toLocaleString()} rows)` };
}

function fromLayers(dataset: CirDataset, plan: ReturnType<typeof planRenameLayer>, description: string): OneResult {
  if (plan.refusal) return { dataset, description, refusal: plan.refusal };
  const applied = applyLayers(dataset, plan);
  return { dataset: applied.dataset, description };
}

/** A one-line account of a command, for the history list and the palette. */
export function describeCommand(command: EditCommand): string {
  switch (command.kind) {
    case 'set':
      return `Set "${command.field}" to ${JSON.stringify(command.value)}${command.scope ? ` on ${command.scope.length} selected row(s)` : ''}`;
    case 'calculate':
      return `Calculate "${command.field}" = ${command.expression}`;
    case 'add-field':
      return `Add field "${command.field.name}" (${command.field.type})`;
    case 'delete-field':
      return `Delete field "${command.field}"`;
    case 'rename-field':
      return `Rename field "${command.field}" to "${command.newName}"`;
    case 'retype-field':
      return `Change "${command.field}" to ${command.type}${command.force ? ' (accepting the loss)' : ''}`;
    case 'layer-rename':
      return `Rename layer "${command.layer}" to "${command.to}"`;
    case 'layer-merge':
      return `Merge ${command.layers.join(', ')} into "${command.into}"`;
    case 'layer-split':
      return `Split "${command.layer}" by ${command.by.kind === 'field' ? `"${command.by.field}"` : 'geometry type'}`;
    case 'layer-reorder':
      return `Move "${command.layer}" to position ${command.toIndex + 1}`;
    case 'layer-delete':
      return `Delete layer "${command.layer}"`;
    case 'layer-style':
      return `Restyle "${command.layer}"`;
    case 'vertices':
      return `${command.plan.operation} ${command.plan.changes.length} vertex/vertices`;
    case 'geometry': {
      const target = command.options.outputLayer ? ` → "${command.options.outputLayer}"` : '';
      const distance = command.options.distance === undefined ? '' : ` by ${command.options.distance}`;
      return `${GEOMETRY_LABEL[command.operation]} "${command.layer}"${distance}${target}`;
    }
    default:
      return 'Edit';
  }
}

/**
 * Whether a command's effect depends on how many features are loaded.
 *
 * Used by the UI to say what a preview shows versus what the export will do.
 * A scoped edit touches exactly the rows named; an unscoped one touches every
 * row in the real layer, which may be far more than the table can display.
 */
export function isWholeLayer(command: EditCommand): boolean {
  switch (command.kind) {
    case 'set':
    case 'calculate':
      return command.scope === undefined;
    case 'vertices':
      return false;
    case 'geometry':
      // A scoped operation names its features by index and touches only those.
      // An unscoped one runs over the whole layer — which for a dissolve or a
      // union is not "the same thing on more rows" but a different result.
      return command.options.scope === undefined;
    default:
      return true;
  }
}
