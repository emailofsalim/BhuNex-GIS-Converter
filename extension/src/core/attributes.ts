/**
 * The attribute table (spec §25.5).
 *
 * Sort, filter, search, edit, bulk edit, calculate field, create and delete
 * field, field type, null handling, unique values.
 *
 * ---------------------------------------------------------------------------
 * NULL IS A VALUE, AND IT IS NOT ZERO
 *
 * The single most consequential decision in an attribute table. A parcel with
 * no recorded owner and a parcel whose owner is recorded as an empty string are
 * different facts; an elevation that was never surveyed and an elevation of
 * zero are very different facts. So:
 *
 *  - `null` survives every operation that does not explicitly replace it.
 *  - Arithmetic on null yields null, never zero (see `core/expression.ts`).
 *  - Sorting puts nulls together at one end and SAYS SO, rather than letting
 *    them sort as "" or 0 and hide among real values.
 *  - Changing a field's type reports every value that could not be converted
 *    and REFUSES rather than nulling them, unless the caller opts in.
 *
 * ---------------------------------------------------------------------------
 * EVERY WRITE IS A PLAN
 *
 * Same plan → apply → undo contract as `qa/repair.ts`, `qa/snap.ts` and
 * `core/vertex-edit.ts`. A bulk edit across four thousand parcels is exactly
 * the operation where "what will this do" needs answering before it happens.
 */

import type { CirDataset, CirFeature, CirLayer, FieldDef } from './cir';
import type { UndoRecord } from '../qa/repair';
import { compileExpression, type CompiledExpression, type ExpressionError, type ExpressionValue } from './expression';

export type FieldType = FieldDef['type'];

/** One row of the table, as the UI renders it. */
export interface TableRow {
  /** Index into the layer's feature array — the identity everything else uses. */
  index: number;
  id: string | number | undefined;
  values: Record<string, unknown>;
}

export interface TableView {
  fields: FieldDef[];
  rows: TableRow[];
  /** Rows before filtering, so "42 of 4,182" can be shown. */
  totalRows: number;
  /** True when `rows` was capped for rendering. */
  truncated: boolean;
}

export interface TableQuery {
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  /** Free-text search across every field. */
  search?: string;
  /** An expression that must be true for the row to appear. */
  filter?: string;
  /** Largest number of rows to materialise. */
  limit?: number;
}

// --------------------------------------------------------------- reading

/**
 * Builds the visible table.
 *
 * Filtering happens before sorting and both happen before the limit, so the
 * cap never changes which rows match — only how many are handed to the
 * renderer. A limit applied first would silently make a filter wrong.
 */
export function buildTable(layer: CirLayer, query: TableQuery = {}): TableView {
  const limit = query.limit ?? 2000;
  let rows: TableRow[] = layer.features.map((feature, index) => ({
    index,
    id: feature.id,
    values: feature.properties ?? {},
  }));
  const totalRows = rows.length;

  if (query.filter && query.filter.trim() !== '') {
    const compiled = compileExpression(query.filter);
    // A filter that does not parse matches nothing rather than everything.
    // Showing the whole table when the filter is broken looks like the filter
    // ran and found no reason to exclude anything.
    rows = compiled.ok ? rows.filter((row) => isTrue(compiled.expression.run(row.values))) : [];
  }

  if (query.search && query.search.trim() !== '') {
    const needle = query.search.trim().toLowerCase();
    rows = rows.filter((row) =>
      Object.values(row.values).some((value) => value !== null && String(value).toLowerCase().includes(needle))
    );
  }

  if (query.sortBy) {
    const field = query.sortBy;
    const direction = query.sortDirection === 'desc' ? -1 : 1;
    // The direction is passed IN rather than multiplied over the result, so
    // that `compareValues` can hold nulls at one end in both directions.
    rows = [...rows].sort((left, right) => compareValues(left.values[field], right.values[field], direction));
  }

  const matched = rows.length;
  return {
    fields: layer.fields,
    rows: rows.slice(0, limit),
    totalRows,
    truncated: matched > limit,
  };
}

/**
 * Orders two cell values.
 *
 * Nulls sort together at the end in BOTH directions, rather than flipping to
 * the top when the sort is reversed. A column of missing values that migrates
 * from bottom to top on a second click reads as data appearing from nowhere.
 */
function compareValues(left: unknown, right: unknown, direction: 1 | -1): number {
  const leftNull = left === null || left === undefined || left === '';
  const rightNull = right === null || right === undefined || right === '';
  if (leftNull && rightNull) return 0;
  // Returned already-signed, so reversing the sort does not lift the empty
  // cells to the top: only the comparison below takes the direction.
  if (leftNull) return 1;
  if (rightNull) return -1;

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return (leftNumber - rightNumber) * direction;
  return String(left).localeCompare(String(right), undefined, { numeric: true }) * direction;
}

function isTrue(value: ExpressionValue): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value !== '' && value.toLowerCase() !== 'false';
}

// --------------------------------------------------------------- summary

export interface FieldSummary {
  field: FieldDef;
  /** Values that are null, undefined or empty. */
  nulls: number;
  /** How many distinct non-null values there are. */
  distinct: number;
  /** The most common values, for a filter menu. Capped. */
  top: { value: unknown; count: number }[];
  /** Present for a numeric field. */
  numeric?: { min: number; max: number; mean: number; nonNumeric: number };
}

/**
 * Summarises one column: the "unique values" the spec asks for, plus what a
 * surveyor actually checks first — how much of the column is empty.
 */
export function summariseField(layer: CirLayer, fieldName: string, topLimit = 20): FieldSummary | null {
  const field = layer.fields.find((candidate) => candidate.name === fieldName);
  if (!field) return null;

  const counts = new Map<string, { value: unknown; count: number }>();
  let nulls = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let numbers = 0;
  let nonNumeric = 0;

  for (const feature of layer.features) {
    const value = feature.properties?.[fieldName];
    if (value === null || value === undefined || value === '') {
      nulls++;
      continue;
    }

    const key = String(value);
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { value, count: 1 });

    const number = Number(value);
    if (Number.isFinite(number)) {
      numbers++;
      sum += number;
      if (number < min) min = number;
      if (number > max) max = number;
    } else {
      nonNumeric++;
    }
  }

  const top = [...counts.values()].sort((left, right) => right.count - left.count).slice(0, topLimit);

  return {
    field,
    nulls,
    distinct: counts.size,
    top,
    // Reported for any column that holds numbers, whatever it is declared as —
    // a "string" column of levels is still worth a range.
    numeric: numbers > 0 ? { min, max, mean: sum / numbers, nonNumeric } : undefined,
  };
}

// --------------------------------------------------------------- writing

export type AttributeOperation = 'set' | 'calculate' | 'add-field' | 'delete-field' | 'rename-field' | 'retype-field';

export const ATTRIBUTE_LABEL: Record<AttributeOperation, string> = {
  set: 'Set values',
  calculate: 'Calculate field',
  'add-field': 'Add field',
  'delete-field': 'Delete field',
  'rename-field': 'Rename field',
  'retype-field': 'Change field type',
};

export interface AttributeChange {
  featureIndex: number;
  field: string;
  from: unknown;
  to: unknown;
}

export interface AttributePlan {
  operation: AttributeOperation;
  layer: string;
  field: string;
  changes: AttributeChange[];
  /** Fields added or removed, for the schema-level operations. */
  fieldsBefore?: FieldDef[];
  fieldsAfter?: FieldDef[];
  /** How many rows would be given a null they did not have. */
  nulled: number;
  /** Values that could not be converted, with an example. */
  problems: { count: number; message: string; example?: unknown }[];
  refusal?: { what: string; why: string; action: string };
}

export interface AttributeResult {
  dataset: CirDataset;
  plan: AttributePlan;
  undo: UndoRecord;
}

export interface AttributeOptions {
  protectedLayers: string[];
  /** Restrict a write to these feature indices. Absent means every row. */
  scope?: number[];
}

function layerOf(dataset: CirDataset, name: string): CirLayer | undefined {
  return dataset.layers.find((candidate) => candidate.name === name);
}

function refuse(operation: AttributeOperation, layer: string, field: string, what: string, why: string, action: string): AttributePlan {
  return { operation, layer, field, changes: [], nulled: 0, problems: [], refusal: { what, why, action } };
}

function protectedRefusal(operation: AttributeOperation, layer: string, field: string): AttributePlan {
  return refuse(
    operation,
    layer,
    field,
    `${layer} is protected, so its attributes were not changed.`,
    'The layer is marked legally operative — its attribute table is part of a record, not a working file.',
    'Remove the layer from the protected list if you genuinely intend to edit it.'
  );
}

/** Sets one field to one value across the scoped rows — the bulk edit. */
export function planSetValue(
  dataset: CirDataset,
  layerName: string,
  field: string,
  value: unknown,
  options: Partial<AttributeOptions> = {}
): AttributePlan {
  const settings = resolve(options);
  if (settings.protectedLayers.includes(layerName)) return protectedRefusal('set', layerName, field);

  const layer = layerOf(dataset, layerName);
  if (!layer) return refuse('set', layerName, field, 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');
  if (!layer.fields.some((candidate) => candidate.name === field)) {
    return refuse('set', layerName, field, `There is no field called "${field}".`, 'It is not in the layer schema.', 'Add the field first.');
  }

  const changes: AttributeChange[] = [];
  let nulled = 0;

  for (const [index, feature] of layer.features.entries()) {
    if (settings.scope && !settings.scope.includes(index)) continue;
    const from = feature.properties?.[field] ?? null;
    if (from === value) continue;
    if ((value === null || value === '') && from !== null && from !== '') nulled++;
    changes.push({ featureIndex: index, field, from, to: value });
  }

  return { operation: 'set', layer: layerName, field, changes, nulled, problems: [] };
}

/**
 * Calculates a field from an expression.
 *
 * The expression is compiled once and run per row. Rows where it yields null
 * are counted separately from rows it changed, because "the calculation
 * emptied 300 cells" is the thing a user needs to see before committing, not
 * after.
 */
export function planCalculate(
  dataset: CirDataset,
  layerName: string,
  field: string,
  expression: string,
  options: Partial<AttributeOptions> = {}
): AttributePlan {
  const settings = resolve(options);
  if (settings.protectedLayers.includes(layerName)) return protectedRefusal('calculate', layerName, field);

  const layer = layerOf(dataset, layerName);
  if (!layer) {
    return refuse('calculate', layerName, field, 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');
  }

  const compiled = compileExpression(expression);
  if (!compiled.ok) {
    return refuse(
      'calculate',
      layerName,
      field,
      'The expression could not be read.',
      `${compiled.error.message} (at character ${compiled.error.position + 1})`,
      'Correct the expression and try again.'
    );
  }

  const missing = compiled.expression.fields.filter((name) => !layer.fields.some((candidate) => candidate.name === name));
  if (missing.length > 0) {
    return refuse(
      'calculate',
      layerName,
      field,
      'The expression names a field this layer does not have.',
      `No field called ${missing.map((name) => `"${name}"`).join(', ')}.`,
      'Check the spelling, or use [square brackets] for a name containing spaces.'
    );
  }

  const changes: AttributeChange[] = [];
  let nulled = 0;

  for (const [index, feature] of layer.features.entries()) {
    if (settings.scope && !settings.scope.includes(index)) continue;
    const from = feature.properties?.[field] ?? null;
    const to = (compiled.expression as CompiledExpression).run(feature.properties ?? {});
    if (from === to) continue;
    if (to === null && from !== null && from !== '') nulled++;
    changes.push({ featureIndex: index, field, from, to });
  }

  const problems: AttributePlan['problems'] = [];
  if (nulled > 0) {
    problems.push({
      count: nulled,
      message: `${nulled.toLocaleString()} row(s) would be emptied by this expression — usually because a field it reads is itself empty, and arithmetic on an empty value is empty rather than zero.`,
    });
  }

  return { operation: 'calculate', layer: layerName, field, changes, nulled, problems };
}

/** Adds a field, with an optional starting value. */
export function planAddField(
  dataset: CirDataset,
  layerName: string,
  field: FieldDef,
  initialValue: unknown = null,
  options: Partial<AttributeOptions> = {}
): AttributePlan {
  const settings = resolve(options);
  if (settings.protectedLayers.includes(layerName)) return protectedRefusal('add-field', layerName, field.name);

  const layer = layerOf(dataset, layerName);
  if (!layer) {
    return refuse('add-field', layerName, field.name, 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');
  }
  if (layer.fields.some((candidate) => candidate.name === field.name)) {
    return refuse(
      'add-field',
      layerName,
      field.name,
      `A field called "${field.name}" already exists.`,
      'Two fields with one name cannot be told apart in any output format.',
      'Choose a different name, or edit the existing field.'
    );
  }
  if (field.name.trim() === '') {
    return refuse('add-field', layerName, field.name, 'A field needs a name.', 'The name is empty.', 'Type a name.');
  }

  const changes: AttributeChange[] = layer.features.map((_, index) => ({
    featureIndex: index,
    field: field.name,
    from: undefined,
    to: initialValue,
  }));

  const problems: AttributePlan['problems'] = [];
  // DBF truncates at ten characters, and two fields that collide after
  // truncation silently merge. Worth saying now rather than at export.
  if (field.name.length > 10) {
    problems.push({
      count: 1,
      message: `"${field.name}" is ${field.name.length} characters. Shapefile's DBF truncates field names to 10, so it would be written as "${field.name.slice(0, 10)}".`,
    });
  }

  return {
    operation: 'add-field',
    layer: layerName,
    field: field.name,
    changes,
    fieldsBefore: layer.fields,
    fieldsAfter: [...layer.fields, field],
    nulled: 0,
    problems,
  };
}

/** Deletes a field and every value in it. */
export function planDeleteField(
  dataset: CirDataset,
  layerName: string,
  field: string,
  options: Partial<AttributeOptions> = {}
): AttributePlan {
  const settings = resolve(options);
  if (settings.protectedLayers.includes(layerName)) return protectedRefusal('delete-field', layerName, field);

  const layer = layerOf(dataset, layerName);
  if (!layer) {
    return refuse('delete-field', layerName, field, 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');
  }
  if (!layer.fields.some((candidate) => candidate.name === field)) {
    return refuse('delete-field', layerName, field, `There is no field called "${field}".`, 'It is not in the layer schema.', 'Reselect the field.');
  }

  let populated = 0;
  const changes: AttributeChange[] = [];
  for (const [index, feature] of layer.features.entries()) {
    const from = feature.properties?.[field];
    if (from !== null && from !== undefined && from !== '') populated++;
    changes.push({ featureIndex: index, field, from: from ?? null, to: undefined });
  }

  return {
    operation: 'delete-field',
    layer: layerName,
    field,
    changes,
    fieldsBefore: layer.fields,
    fieldsAfter: layer.fields.filter((candidate) => candidate.name !== field),
    nulled: 0,
    problems:
      populated > 0
        ? [
            {
              count: populated,
              message: `${populated.toLocaleString()} row(s) have a value in "${field}". Deleting the field discards them; it can be undone here, but not from the exported file.`,
            },
          ]
        : [],
  };
}

/** Renames a field, keeping every value. */
export function planRenameField(
  dataset: CirDataset,
  layerName: string,
  field: string,
  newName: string,
  options: Partial<AttributeOptions> = {}
): AttributePlan {
  const settings = resolve(options);
  if (settings.protectedLayers.includes(layerName)) return protectedRefusal('rename-field', layerName, field);

  const layer = layerOf(dataset, layerName);
  if (!layer) {
    return refuse('rename-field', layerName, field, 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');
  }
  if (newName.trim() === '') {
    return refuse('rename-field', layerName, field, 'A field needs a name.', 'The new name is empty.', 'Type a name.');
  }
  if (layer.fields.some((candidate) => candidate.name === newName)) {
    return refuse(
      'rename-field',
      layerName,
      field,
      `A field called "${newName}" already exists.`,
      'Renaming onto it would merge two columns and lose one of them.',
      'Choose a different name.'
    );
  }

  const existing = layer.fields.find((candidate) => candidate.name === field);
  if (!existing) {
    return refuse('rename-field', layerName, field, `There is no field called "${field}".`, 'It is not in the layer schema.', 'Reselect the field.');
  }

  return {
    operation: 'rename-field',
    layer: layerName,
    field,
    changes: layer.features.map((feature, index) => ({
      featureIndex: index,
      field: newName,
      from: undefined,
      to: feature.properties?.[field] ?? null,
    })),
    fieldsBefore: layer.fields,
    // `sourceName` is preserved so the manifest can still report what the field
    // was called in the source file (R20).
    fieldsAfter: layer.fields.map((candidate) =>
      candidate.name === field ? { ...candidate, name: newName, sourceName: candidate.sourceName ?? candidate.name } : candidate
    ),
    nulled: 0,
    problems: [],
  };
}

/**
 * Changes a field's declared type, converting its values.
 *
 * REFUSES when any value cannot be converted, unless `force` is set. Silently
 * nulling the three rows where someone typed "n/a" in a numeric column is how a
 * table quietly loses data, and the three rows are exactly the ones worth
 * looking at.
 */
export function planRetypeField(
  dataset: CirDataset,
  layerName: string,
  field: string,
  type: FieldType,
  options: Partial<AttributeOptions> & { force?: boolean } = {}
): AttributePlan {
  const settings = resolve(options);
  if (settings.protectedLayers.includes(layerName)) return protectedRefusal('retype-field', layerName, field);

  const layer = layerOf(dataset, layerName);
  if (!layer) {
    return refuse('retype-field', layerName, field, 'That layer could not be found.', 'It is not in this dataset.', 'Reselect the layer.');
  }
  const existing = layer.fields.find((candidate) => candidate.name === field);
  if (!existing) {
    return refuse('retype-field', layerName, field, `There is no field called "${field}".`, 'It is not in the layer schema.', 'Reselect the field.');
  }

  const changes: AttributeChange[] = [];
  const failures: unknown[] = [];

  for (const [index, feature] of layer.features.entries()) {
    const from = feature.properties?.[field] ?? null;
    if (from === null || from === '') continue;

    const converted = convert(from, type);
    if (converted === undefined) {
      failures.push(from);
      continue;
    }
    if (converted !== from) changes.push({ featureIndex: index, field, from, to: converted });
  }

  if (failures.length > 0 && !options.force) {
    return refuse(
      'retype-field',
      layerName,
      field,
      `${failures.length.toLocaleString()} value(s) in "${field}" cannot be read as ${type}.`,
      `The first is ${JSON.stringify(failures[0])}. Converting anyway would replace each of them with an empty cell.`,
      'Correct those values first, or repeat with "convert anyway" to accept the loss.'
    );
  }

  // Forced: the unconvertible values become null, and that is stated.
  if (failures.length > 0) {
    for (const [index, feature] of layer.features.entries()) {
      const from = feature.properties?.[field] ?? null;
      if (from === null || from === '') continue;
      if (convert(from, type) === undefined) changes.push({ featureIndex: index, field, from, to: null });
    }
  }

  return {
    operation: 'retype-field',
    layer: layerName,
    field,
    changes,
    fieldsBefore: layer.fields,
    fieldsAfter: layer.fields.map((candidate) => (candidate.name === field ? { ...candidate, type } : candidate)),
    nulled: failures.length,
    problems:
      failures.length > 0
        ? [
            {
              count: failures.length,
              message: `${failures.length.toLocaleString()} value(s) could not be read as ${type} and become empty.`,
              example: failures[0],
            },
          ]
        : [],
  };
}

/** Converts one value, or `undefined` when it cannot be converted. */
function convert(value: unknown, type: FieldType): unknown | undefined {
  switch (type) {
    case 'string':
      return String(value);
    case 'number': {
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    }
    case 'integer': {
      const number = Number(value);
      if (!Number.isFinite(number)) return undefined;
      // A non-integer in an integer column is a conversion that loses the
      // fraction, so it is a failure rather than a silent round.
      return Number.isInteger(number) ? number : undefined;
    }
    case 'boolean': {
      const text = String(value).trim().toLowerCase();
      if (['true', 'yes', 'y', '1', 't'].includes(text)) return true;
      if (['false', 'no', 'n', '0', 'f'].includes(text)) return false;
      return undefined;
    }
    case 'date': {
      const parsed = new Date(String(value));
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
    }
    default:
      return String(value);
  }
}

// --------------------------------------------------------------- apply

export function applyAttributes(dataset: CirDataset, plan: AttributePlan): AttributeResult {
  const undo: UndoRecord = { label: ATTRIBUTE_LABEL[plan.operation], entries: [] };
  if (plan.refusal || (plan.changes.length === 0 && !plan.fieldsAfter)) return { dataset, plan, undo };

  const layers = dataset.layers.map((layer) => {
    if (layer.name !== plan.layer) return layer;

    const byFeature = new Map<number, AttributeChange[]>();
    for (const change of plan.changes) {
      byFeature.set(change.featureIndex, [...(byFeature.get(change.featureIndex) ?? []), change]);
    }

    const removedField = plan.operation === 'delete-field' ? plan.field : null;
    const renamedFrom = plan.operation === 'rename-field' ? plan.field : null;

    const features: CirFeature[] = layer.features.map((feature, index) => {
      const changes = byFeature.get(index);
      if (!changes && !removedField && !renamedFrom) return feature;

      const properties = { ...(feature.properties ?? {}) };
      for (const change of changes ?? []) {
        if (change.to === undefined) delete properties[change.field];
        else properties[change.field] = change.to;
      }
      if (removedField) delete properties[removedField];
      if (renamedFrom) delete properties[renamedFrom];

      // The undo record carries geometry for the repair contract; attribute
      // edits leave geometry alone, so the original feature is stored whole and
      // the geometry field simply comes back unchanged.
      undo.entries.push({ layer: layer.name, featureIndex: index, geometry: feature.geometry });
      return { ...feature, properties };
    });

    return { ...layer, features, fields: plan.fieldsAfter ?? layer.fields };
  });

  return { dataset: { ...dataset, layers }, plan, undo };
}

/**
 * Reverses an attribute plan.
 *
 * `undoRepair` restores geometry, which attribute edits never touched, so this
 * exists as the matching operation for properties and the schema.
 */
export function undoAttributes(dataset: CirDataset, plan: AttributePlan): CirDataset {
  const layers = dataset.layers.map((layer) => {
    if (layer.name !== plan.layer) return layer;

    const byFeature = new Map<number, AttributeChange[]>();
    for (const change of plan.changes) {
      byFeature.set(change.featureIndex, [...(byFeature.get(change.featureIndex) ?? []), change]);
    }

    const features = layer.features.map((feature, index) => {
      const changes = byFeature.get(index);
      if (!changes) return feature;

      const properties = { ...(feature.properties ?? {}) };
      for (const change of changes) {
        if (change.from === undefined) delete properties[change.field];
        else properties[change.field] = change.from;
      }

      // A rename is the one operation whose forward direction touches two
      // column names: `applyAttributes` writes the value under the new name and
      // deletes the old one. Reversing only the recorded change would delete the
      // new name and leave the old one gone — the whole column lost on undo. So
      // the value carried in `to` is put back under the original name here.
      if (plan.operation === 'rename-field') {
        for (const change of changes) properties[plan.field] = change.to;
      }

      return { ...feature, properties };
    });

    return { ...layer, features, fields: plan.fieldsBefore ?? layer.fields };
  });

  return { ...dataset, layers };
}

/** A one-line account of a plan, for the confirmation prompt. */
export function describeAttributePlan(plan: AttributePlan): string {
  if (plan.refusal) return `${plan.refusal.what} ${plan.refusal.why} ${plan.refusal.action}`;

  const rows = new Set(plan.changes.map((change) => change.featureIndex)).size;
  const head = `${ATTRIBUTE_LABEL[plan.operation]} "${plan.field}" on ${rows.toLocaleString()} row${rows === 1 ? '' : 's'}`;
  const tail = plan.problems.map((problem) => problem.message).join(' ');
  return tail ? `${head}. ${tail}` : `${head}.`;
}

function resolve(options: Partial<AttributeOptions>): AttributeOptions {
  return { protectedLayers: options.protectedLayers ?? [], scope: options.scope };
}

export type { ExpressionError };
