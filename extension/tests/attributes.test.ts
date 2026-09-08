/**
 * The attribute table and its field calculator (spec §25.5).
 *
 * Two failure modes drive almost every test here, because they are the two that
 * corrupt a delivery without producing an error at the time:
 *
 *   1. NULL BECOMING ZERO. A parcel with no surveyed elevation and a parcel at
 *      elevation zero are different facts. Every arithmetic path, every sort and
 *      every type change is checked for the moment one turns into the other.
 *   2. A WRITE THAT LOOKED LIKE IT WORKED. A typo'd function name, a filter that
 *      does not parse, a field type that cannot hold what is in the column —
 *      each of these has an obvious wrong behaviour (empty the column, show
 *      everything, null the awkward rows) that no one notices until export.
 *
 * There is a third thing under test that is not about data at all: the
 * calculator must not use `eval` or `new Function`. Manifest V3's CSP is
 * `script-src 'self'`, so either would throw on the first click in the browser
 * while passing every test in Node.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDataset, createLayer, type CirDataset, type CirFeature, type FieldDef, type SourceInfo } from '@core/cir';
import { checkExpression, compileExpression, FUNCTION_NAMES } from '@core/expression';
import {
  applyAttributes,
  buildTable,
  describeAttributePlan,
  planAddField,
  planCalculate,
  planDeleteField,
  planRenameField,
  planRetypeField,
  planSetValue,
  summariseField,
  undoAttributes,
} from '@core/attributes';

const SOURCE: SourceInfo = {
  fileName: 'plots.shp',
  size: 0,
  formatId: 'shapefile',
  formatName: 'Esri Shapefile',
  detectionConfidence: 1,
};

const FIELDS: FieldDef[] = [
  { name: 'plot', type: 'string' },
  { name: 'area', type: 'number' },
  { name: 'owner', type: 'string' },
  { name: 'level', type: 'number' },
];

function feature(id: string, properties: Record<string, unknown>): CirFeature {
  return { id, geometry: { type: 'Point', coordinates: [0, 0], dimension: 2 }, properties };
}

function dataset(features: CirFeature[], fields: FieldDef[] = FIELDS): CirDataset {
  return createDataset({
    kind: 'vector',
    name: 'plots',
    source: SOURCE,
    layers: [createLayer('Plots', features, fields)],
  });
}

/** Four plots, one of which has never been surveyed. */
function surveyed(): CirDataset {
  return dataset([
    feature('A', { plot: 'A-1', area: 1200, owner: 'Rao', level: 41.5 }),
    feature('B', { plot: 'A-2', area: 850, owner: null, level: 0 }),
    feature('C', { plot: 'B-1', area: null, owner: 'Devi', level: null }),
    feature('D', { plot: 'B-2', area: 2400, owner: 'Rao', level: 39.25 }),
  ]);
}

function valuesOf(data: CirDataset, field: string): unknown[] {
  return data.layers[0].features.map((entry) => entry.properties[field]);
}

// ===========================================================================
// The expression language
// ===========================================================================

describe('the field calculator never uses eval', () => {
  it('has no eval, no Function constructor and no dynamic import in its source', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/core/expression.ts', import.meta.url)), 'utf8');
    // Manifest V3 forbids relaxing `script-src 'self'`, so any of these would
    // throw at runtime in the packaged extension while passing here.
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/new\s+Function\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it('evaluates a real expression, so the parser is doing the work', () => {
    const compiled = compileExpression('round(area / 4046.86, 2)');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.expression.run({ area: 12140.58 })).toBeCloseTo(3, 10);
  });

  it('cannot reach a global, because there is no property access in the grammar', () => {
    // `globalThis.x` is not parseable: there is no `.` operator at all.
    const compiled = compileExpression('globalThis.constructor');
    expect(compiled.ok).toBe(false);
  });
});

describe('null propagates through arithmetic', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['area + 1', { area: null }],
    ['area - 1', { area: null }],
    ['area * 2', { area: null }],
    ['area / 2', { area: null }],
    ['-area', { area: null }],
    ['round(area, 2)', { area: null }],
    ['sqrt(area)', { area: null }],
  ];

  for (const [expression, row] of cases) {
    it(`${expression} on a null yields null, not zero`, () => {
      const compiled = compileExpression(expression);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      expect(compiled.expression.run(row)).toBeNull();
    });
  }

  it('distinguishes a real zero from a missing value', () => {
    const compiled = compileExpression('level + 10');
    if (!compiled.ok) throw new Error('should compile');
    expect(compiled.expression.run({ level: 0 })).toBe(10);
    expect(compiled.expression.run({ level: null })).toBeNull();
  });

  it('reports a missing field as null rather than throwing', () => {
    const compiled = compileExpression('isnull(nosuchfield)');
    if (!compiled.ok) throw new Error('should compile');
    expect(compiled.expression.run({})).toBe(true);
  });

  it('divides by zero to null rather than Infinity', () => {
    const compiled = compileExpression('area / level');
    if (!compiled.ok) throw new Error('should compile');
    // An attribute table full of "Infinity" is a table nobody can export.
    expect(compiled.expression.run({ area: 100, level: 0 })).toBeNull();
  });

  it('coalesce picks the first value that is actually there', () => {
    const compiled = compileExpression("coalesce(owner, 'unrecorded')");
    if (!compiled.ok) throw new Error('should compile');
    expect(compiled.expression.run({ owner: null })).toBe('unrecorded');
    expect(compiled.expression.run({ owner: '' })).toBe('unrecorded');
    expect(compiled.expression.run({ owner: 'Devi' })).toBe('Devi');
  });
});

describe('operator precedence and associativity', () => {
  const cases: [string, unknown][] = [
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['10 - 3 - 2', 5], // left-associative: (10-3)-2, not 10-(3-2)
    ['100 / 10 / 2', 5],
    ['2 + 3 > 4', true],
    ['1 = 1 and 2 = 3', false],
    ['1 = 1 or 2 = 3', true],
    ['not (1 = 2)', true],
    ["'A' + '-' + '1'", 'A-1'],
  ];

  for (const [expression, expected] of cases) {
    it(`${expression} → ${JSON.stringify(expected)}`, () => {
      const compiled = compileExpression(expression);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      expect(compiled.expression.run({})).toStrictEqual(expected);
    });
  }

  it('short-circuits AND, so a guard actually guards', () => {
    const compiled = compileExpression('not isnull(area) and area > 1000');
    if (!compiled.ok) throw new Error('should compile');
    expect(compiled.expression.run({ area: null })).toBe(false);
    expect(compiled.expression.run({ area: 1200 })).toBe(true);
  });
});

describe('an expression that is wrong says where', () => {
  it('rejects an unknown function at compile time, not per row', () => {
    // The wrong behaviour: compile clean, return null for every row, and offer
    // to empty the whole column because someone typed "rnd" for "round".
    const compiled = compileExpression('rnd(area, 2)');
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.message).toContain('rnd()');
    expect(compiled.error.message).toContain('round()');
  });

  it('rejects the wrong number of arguments at compile time', () => {
    const compiled = compileExpression('replace(owner)');
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.message).toContain('3 argument');
  });

  it('points at the character where an unclosed string starts', () => {
    const source = "owner = 'Rao";
    const compiled = compileExpression(source);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(source[compiled.error.position]).toBe("'");
  });

  it('points at the character where an unclosed bracket starts', () => {
    const source = 'area + [Plot No';
    const compiled = compileExpression(source);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(source[compiled.error.position]).toBe('[');
  });

  it('points at the unclosed parenthesis', () => {
    const source = 'round((area / 2, 1)';
    const compiled = compileExpression(source);
    expect(compiled.ok).toBe(false);
  });

  it('checkExpression names a field the layer does not have', () => {
    const error = checkExpression('area * 2 + hight', ['area', 'height']);
    expect(error?.message).toContain('"hight"');
  });

  it('addresses a field name containing a space through brackets', () => {
    const compiled = compileExpression('[Plot No] + 1');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.expression.fields).toEqual(['Plot No']);
    expect(compiled.expression.run({ 'Plot No': 41 })).toBe(42);
  });

  it('publishes its function names for the help text', () => {
    expect(FUNCTION_NAMES).toContain('coalesce');
    expect(FUNCTION_NAMES).toContain('round');
    expect(FUNCTION_NAMES).toEqual([...FUNCTION_NAMES].sort());
  });
});

// ===========================================================================
// Reading the table
// ===========================================================================

describe('building the table', () => {
  it('carries the feature index as identity, not the row position', () => {
    const view = buildTable(surveyed().layers[0], { sortBy: 'area', sortDirection: 'desc' });
    expect(view.rows[0].index).toBe(3); // the 2400 m² plot, which is feature 3
    expect(view.totalRows).toBe(4);
  });

  it('sorts nulls to the end in BOTH directions', () => {
    const layer = surveyed().layers[0];
    // A column of missing values that migrates from bottom to top on a second
    // click reads as data appearing from nowhere.
    const ascending = buildTable(layer, { sortBy: 'area', sortDirection: 'asc' });
    const descending = buildTable(layer, { sortBy: 'area', sortDirection: 'desc' });
    expect(ascending.rows[3].values.area).toBeNull();
    expect(descending.rows[3].values.area).toBeNull();
    expect(ascending.rows[0].values.area).toBe(850);
    expect(descending.rows[0].values.area).toBe(2400);
  });

  it('sorts numerically, not as text', () => {
    const view = buildTable(surveyed().layers[0], { sortBy: 'area' });
    // Lexicographic order would put 1200 before 850.
    expect(view.rows.map((row) => row.values.area)).toEqual([850, 1200, 2400, null]);
  });

  it('filters on an expression', () => {
    const view = buildTable(surveyed().layers[0], { filter: 'area > 1000' });
    expect(view.rows.map((row) => row.values.plot)).toEqual(['A-1', 'B-2']);
    expect(view.totalRows).toBe(4);
  });

  it('a filter that does not parse matches nothing, not everything', () => {
    // Showing all four rows would look like the filter ran and found no reason
    // to exclude anything.
    const view = buildTable(surveyed().layers[0], { filter: 'area >>> 1000' });
    expect(view.rows).toHaveLength(0);
    expect(view.totalRows).toBe(4);
  });

  it('excludes a null row from a comparison filter rather than counting it as zero', () => {
    const view = buildTable(surveyed().layers[0], { filter: 'area < 1000' });
    // The unsurveyed plot has no area; it is not "less than 1000".
    expect(view.rows.map((row) => row.values.plot)).toEqual(['A-2']);
  });

  it('searches every column, case-insensitively', () => {
    const view = buildTable(surveyed().layers[0], { search: 'rao' });
    expect(view.rows).toHaveLength(2);
  });

  it('filters before limiting, so the cap never changes what matched', () => {
    const layer = surveyed().layers[0];
    const view = buildTable(layer, { filter: 'area > 1000', limit: 1 });
    expect(view.rows).toHaveLength(1);
    expect(view.truncated).toBe(true);
    // The row shown is one of the two that matched, not the first row overall.
    expect(view.rows[0].values.plot).toBe('A-1');
  });
});

describe('summarising a column', () => {
  it('counts nulls, distinct values and the numeric range', () => {
    const summary = summariseField(surveyed().layers[0], 'area');
    expect(summary?.nulls).toBe(1);
    expect(summary?.distinct).toBe(3);
    expect(summary?.numeric?.min).toBe(850);
    expect(summary?.numeric?.max).toBe(2400);
    expect(summary?.numeric?.mean).toBeCloseTo((1200 + 850 + 2400) / 3, 10);
  });

  it('ranks the most common values for a filter menu', () => {
    const summary = summariseField(surveyed().layers[0], 'owner');
    expect(summary?.top[0]).toEqual({ value: 'Rao', count: 2 });
    expect(summary?.nulls).toBe(1);
  });

  it('returns null for a field the layer does not have', () => {
    expect(summariseField(surveyed().layers[0], 'nosuch')).toBeNull();
  });
});

// ===========================================================================
// Writing
// ===========================================================================

describe('bulk set', () => {
  it('plans, applies and undoes', () => {
    const before = surveyed();
    const plan = planSetValue(before, 'Plots', 'owner', 'State');
    expect(plan.changes).toHaveLength(4); // no row already reads 'State'
    const { dataset: after } = applyAttributes(before, plan);
    expect(valuesOf(after, 'owner')).toEqual(['State', 'State', 'State', 'State']);
    expect(valuesOf(undoAttributes(after, plan), 'owner')).toEqual(['Rao', null, 'Devi', 'Rao']);
  });

  it('honours a scope, so a selection edit stays inside the selection', () => {
    const before = surveyed();
    const plan = planSetValue(before, 'Plots', 'owner', 'State', { scope: [0, 2] });
    const { dataset: after } = applyAttributes(before, plan);
    expect(valuesOf(after, 'owner')).toEqual(['State', null, 'State', 'Rao']);
  });

  it('counts the rows it would empty', () => {
    const plan = planSetValue(surveyed(), 'Plots', 'owner', null);
    expect(plan.nulled).toBe(3); // Rao, Devi, Rao — the already-null row is not "emptied"
  });

  it('refuses on a protected layer', () => {
    const plan = planSetValue(surveyed(), 'Plots', 'owner', 'State', { protectedLayers: ['Plots'] });
    expect(plan.refusal).toBeDefined();
    expect(plan.changes).toHaveLength(0);
    expect(describeAttributePlan(plan)).toContain('protected');
  });

  it('refuses on a field that does not exist', () => {
    expect(planSetValue(surveyed(), 'Plots', 'nosuch', 1).refusal).toBeDefined();
  });

  it('leaves the source dataset untouched', () => {
    const before = surveyed();
    applyAttributes(before, planSetValue(before, 'Plots', 'owner', 'State'));
    expect(valuesOf(before, 'owner')).toEqual(['Rao', null, 'Devi', 'Rao']);
  });
});

describe('calculate field', () => {
  it('computes from other fields', () => {
    const before = surveyed();
    const plan = planCalculate(before, 'Plots', 'area', 'round(area / 4046.86, 3)');
    const { dataset: after } = applyAttributes(before, plan);
    expect(after.layers[0].features[0].properties.area).toBeCloseTo(0.297, 10);
    expect(after.layers[0].features[2].properties.area).toBeNull();
  });

  it('warns before it empties cells, not after', () => {
    const plan = planCalculate(surveyed(), 'Plots', 'level', 'level * 2');
    // The one null level becomes null again — but nothing was there to lose, so
    // it is not counted. The 0 stays 0.
    expect(plan.nulled).toBe(0);

    const emptying = planCalculate(surveyed(), 'Plots', 'plot', 'area + level');
    // Plot C has neither area nor level; its plot code would be wiped.
    expect(emptying.nulled).toBeGreaterThan(0);
    expect(emptying.problems[0].message).toContain('empty rather than zero');
  });

  it('refuses an expression naming a field the layer does not have', () => {
    const plan = planCalculate(surveyed(), 'Plots', 'area', 'area * factor');
    expect(plan.refusal?.why).toContain('"factor"');
    expect(plan.changes).toHaveLength(0);
  });

  it('refuses an expression that does not parse, and says where', () => {
    const plan = planCalculate(surveyed(), 'Plots', 'area', 'area *');
    expect(plan.refusal).toBeDefined();
    expect(plan.refusal?.why).toContain('character');
  });

  it('refuses on a protected layer', () => {
    const plan = planCalculate(surveyed(), 'Plots', 'area', 'area * 2', { protectedLayers: ['Plots'] });
    expect(plan.refusal).toBeDefined();
  });

  it('round-trips through undo', () => {
    const before = surveyed();
    const plan = planCalculate(before, 'Plots', 'area', 'area * 2');
    const { dataset: after } = applyAttributes(before, plan);
    expect(valuesOf(undoAttributes(after, plan), 'area')).toEqual([1200, 850, null, 2400]);
  });
});

describe('schema changes', () => {
  it('adds a field to every row', () => {
    const before = surveyed();
    const plan = planAddField(before, 'Plots', { name: 'status', type: 'string' }, 'pending');
    const { dataset: after } = applyAttributes(before, plan);
    expect(after.layers[0].fields.map((field) => field.name)).toContain('status');
    expect(valuesOf(after, 'status')).toEqual(['pending', 'pending', 'pending', 'pending']);

    const reverted = undoAttributes(after, plan);
    expect(reverted.layers[0].fields.some((field) => field.name === 'status')).toBe(false);
    expect(reverted.layers[0].features[0].properties.status).toBeUndefined();
  });

  it('warns that a long name will be truncated by DBF', () => {
    const plan = planAddField(surveyed(), 'Plots', { name: 'registration_number', type: 'string' });
    expect(plan.problems[0].message).toContain('truncates');
    expect(plan.problems[0].message).toContain('registrati');
  });

  it('refuses a duplicate field name', () => {
    expect(planAddField(surveyed(), 'Plots', { name: 'area', type: 'number' }).refusal).toBeDefined();
  });

  it('deletes a field and says how much would be discarded', () => {
    const before = surveyed();
    const plan = planDeleteField(before, 'Plots', 'owner');
    expect(plan.problems[0].count).toBe(3);

    const { dataset: after } = applyAttributes(before, plan);
    expect(after.layers[0].fields.some((field) => field.name === 'owner')).toBe(false);
    expect(after.layers[0].features[0].properties.owner).toBeUndefined();

    const reverted = undoAttributes(after, plan);
    expect(valuesOf(reverted, 'owner')).toEqual(['Rao', null, 'Devi', 'Rao']);
    expect(reverted.layers[0].fields.some((field) => field.name === 'owner')).toBe(true);
  });

  it('renames a field, keeps every value, and restores both on undo', () => {
    const before = surveyed();
    const plan = planRenameField(before, 'Plots', 'owner', 'proprietor');
    const { dataset: after } = applyAttributes(before, plan);

    expect(valuesOf(after, 'proprietor')).toEqual(['Rao', null, 'Devi', 'Rao']);
    expect(after.layers[0].features[0].properties.owner).toBeUndefined();
    // R20: the source name survives, so the manifest can still report it.
    expect(after.layers[0].fields.find((field) => field.name === 'proprietor')?.sourceName).toBe('owner');

    // The undo that used to lose the whole column.
    const reverted = undoAttributes(after, plan);
    expect(valuesOf(reverted, 'owner')).toEqual(['Rao', null, 'Devi', 'Rao']);
    expect(reverted.layers[0].features[0].properties.proprietor).toBeUndefined();
    expect(reverted.layers[0].fields.map((field) => field.name)).toEqual(FIELDS.map((field) => field.name));
  });

  it('refuses a rename onto an existing name', () => {
    expect(planRenameField(surveyed(), 'Plots', 'owner', 'area').refusal).toBeDefined();
  });

  it('refuses an empty name', () => {
    expect(planRenameField(surveyed(), 'Plots', 'owner', '  ').refusal).toBeDefined();
  });
});

describe('changing a field type', () => {
  function mixed(): CirDataset {
    return dataset(
      [
        feature('A', { plot: 'A-1', level: '41.5' }),
        feature('B', { plot: 'A-2', level: '39' }),
        feature('C', { plot: 'B-1', level: 'n/a' }),
      ],
      [
        { name: 'plot', type: 'string' },
        { name: 'level', type: 'string' },
      ]
    );
  }

  it('refuses rather than silently nulling the awkward rows', () => {
    const plan = planRetypeField(mixed(), 'Plots', 'level', 'number');
    expect(plan.refusal).toBeDefined();
    expect(plan.refusal?.what).toContain('1 value');
    expect(plan.refusal?.why).toContain('"n/a"');
    expect(plan.changes).toHaveLength(0);
  });

  it('converts when forced, and states the loss', () => {
    const before = mixed();
    const plan = planRetypeField(before, 'Plots', 'level', 'number', { force: true });
    expect(plan.refusal).toBeUndefined();
    expect(plan.nulled).toBe(1);
    expect(plan.problems[0].example).toBe('n/a');

    const { dataset: after } = applyAttributes(before, plan);
    expect(valuesOf(after, 'level')).toEqual([41.5, 39, null]);
    expect(after.layers[0].fields.find((field) => field.name === 'level')?.type).toBe('number');
    expect(valuesOf(undoAttributes(after, plan), 'level')).toEqual(['41.5', '39', 'n/a']);
  });

  it('converts cleanly when every value fits', () => {
    const clean = dataset(
      [feature('A', { level: '41.5' }), feature('B', { level: '39' })],
      [{ name: 'level', type: 'string' }]
    );
    const plan = planRetypeField(clean, 'Plots', 'level', 'number');
    expect(plan.refusal).toBeUndefined();
    const { dataset: after } = applyAttributes(clean, plan);
    expect(valuesOf(after, 'level')).toEqual([41.5, 39]);
  });

  it('treats a fraction in an integer column as a failure, not a silent round', () => {
    const fractional = dataset([feature('A', { level: 41.5 })], [{ name: 'level', type: 'number' }]);
    const plan = planRetypeField(fractional, 'Plots', 'level', 'integer');
    expect(plan.refusal).toBeDefined();
  });

  it('leaves nulls as nulls rather than converting them to 0 or ""', () => {
    const withNull = dataset(
      [feature('A', { level: '41.5' }), feature('B', { level: null })],
      [{ name: 'level', type: 'string' }]
    );
    const plan = planRetypeField(withNull, 'Plots', 'level', 'number');
    const { dataset: after } = applyAttributes(withNull, plan);
    expect(valuesOf(after, 'level')).toEqual([41.5, null]);
  });

  it('reads the truthy spellings a survey CSV actually contains', () => {
    const flags = dataset(
      [feature('A', { ok: 'Yes' }), feature('B', { ok: 'N' }), feature('C', { ok: '1' })],
      [{ name: 'ok', type: 'string' }]
    );
    const plan = planRetypeField(flags, 'Plots', 'ok', 'boolean');
    expect(plan.refusal).toBeUndefined();
    const { dataset: after } = applyAttributes(flags, plan);
    expect(valuesOf(after, 'ok')).toEqual([true, false, true]);
  });
});

describe('describing a plan', () => {
  it('says what will happen, in rows', () => {
    const plan = planSetValue(surveyed(), 'Plots', 'owner', 'State');
    expect(describeAttributePlan(plan)).toContain('4 rows');
  });

  it('singularises one row', () => {
    const plan = planSetValue(surveyed(), 'Plots', 'owner', 'State', { scope: [0] });
    expect(describeAttributePlan(plan)).toContain('1 row.');
  });
});
