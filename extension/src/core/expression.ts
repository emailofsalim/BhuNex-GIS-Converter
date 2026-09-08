/**
 * The field calculator's expression language (spec §25.5, "calculate field").
 *
 * A tokeniser, a recursive-descent parser and a tree-walking evaluator, in
 * about four hundred lines and with no dependency.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `eval`, OR `new Function`
 *
 * Two independent reasons, either of which alone would settle it:
 *
 *  1. IT WOULD NOT RUN. The extension's Content Security Policy is
 *     `script-src 'self'` (see extension/manifest.json). Manifest V3 forbids
 *     relaxing it, so `eval` and `new Function` throw at runtime. A field
 *     calculator built on them would pass every unit test in Node and fail on
 *     the first click in the browser.
 *  2. IT WOULD BE A HOLE. Expressions come from a text box, and a project file
 *     carrying a saved expression is a file people forward. `eval` on that
 *     input is arbitrary code execution triggered by opening someone's project.
 *
 * So this evaluator has NO access to anything. The AST has no property access,
 * no function values, no assignment and no loops; the only names that resolve
 * are the feature's own fields and the fixed function table below. There is
 * nothing to reach out of, by construction rather than by filtering.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ERROR HAS TO DO
 *
 * A calculator that reports "syntax error" and nothing else is one people give
 * up on. Every failure here carries the POSITION in the source and what was
 * expected, so the UI can point at the character — which is the difference
 * between a usable expression box and a guessing game.
 */

export type ExpressionValue = string | number | boolean | null;

export interface ExpressionError {
  message: string;
  /** Character offset into the source, for pointing at it. */
  position: number;
}

// --------------------------------------------------------------- tokens

type TokenType = 'number' | 'string' | 'identifier' | 'operator' | 'paren' | 'comma' | 'end';

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

const OPERATORS = ['<=', '>=', '<>', '!=', '==', '=', '<', '>', '+', '-', '*', '/', '%'];

class ParseError extends Error {
  constructor(
    message: string,
    readonly position: number
  ) {
    super(message);
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (/\s/.test(character)) {
      index++;
      continue;
    }

    // A bracketed name, so a field called "Plot No" is addressable at all.
    if (character === '[') {
      const close = source.indexOf(']', index);
      if (close < 0) throw new ParseError('This [field name] is never closed — add a "]".', index);
      tokens.push({ type: 'identifier', value: source.slice(index + 1, close), position: index });
      index = close + 1;
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      // The opening quote, not wherever the scan ends up. Every position in this
      // file is a character offset into the source, because the UI draws a caret
      // at it — a token index or an end offset points at the wrong character.
      const start = index;
      let value = '';
      index++;
      while (index < source.length && source[index] !== quote) {
        // Backslash escapes, so a string can contain its own quote.
        if (source[index] === '\\' && index + 1 < source.length) {
          index++;
          value += source[index];
        } else {
          value += source[index];
        }
        index++;
      }
      if (index >= source.length) throw new ParseError('This text is never closed — add a matching quote.', start);
      index++;
      tokens.push({ type: 'string', value, position: start });
      continue;
    }

    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const start = index;
      while (index < source.length && /[0-9.]/.test(source[index])) index++;
      const text = source.slice(start, index);
      if ((text.match(/\./g) ?? []).length > 1) throw new ParseError(`"${text}" has more than one decimal point.`, start);
      tokens.push({ type: 'number', value: text, position: start });
      continue;
    }

    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) index++;
      tokens.push({ type: 'identifier', value: source.slice(start, index), position: start });
      continue;
    }

    if (character === '(' || character === ')') {
      tokens.push({ type: 'paren', value: character, position: index });
      index++;
      continue;
    }

    if (character === ',') {
      tokens.push({ type: 'comma', value: ',', position: index });
      index++;
      continue;
    }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      tokens.push({ type: 'operator', value: operator, position: index });
      index += operator.length;
      continue;
    }

    throw new ParseError(`"${character}" is not something this calculator understands.`, index);
  }

  tokens.push({ type: 'end', value: '', position: source.length });
  return tokens;
}

// --------------------------------------------------------------- AST

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'field'; name: string; position: number }
  | { kind: 'unary'; operator: string; operand: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[]; position: number };

/**
 * Precedence, loosest first. Ordinary arithmetic precedence, with comparison
 * below it and the boolean operators below that, which is what anyone writing
 * `area > 100 AND code = 'A'` expects.
 */
const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  '=': 3,
  '==': 3,
  '<>': 3,
  '!=': 3,
  '<': 3,
  '>': 3,
  '<=': 3,
  '>=': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '%': 5,
};

class Parser {
  private at = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.expression(0);
    const token = this.peek();
    if (token.type !== 'end') {
      throw new ParseError(`Unexpected "${token.value}" — the expression already looks complete here.`, token.position);
    }
    return node;
  }

  private peek(): Token {
    return this.tokens[this.at];
  }

  private next(): Token {
    return this.tokens[this.at++];
  }

  /** Precedence climbing: one loop rather than one method per level. */
  private expression(minimum: number): Node {
    let left = this.unary();

    for (;;) {
      const token = this.peek();
      const operator =
        token.type === 'operator'
          ? token.value
          : token.type === 'identifier' && /^(and|or)$/i.test(token.value)
            ? token.value.toLowerCase()
            : null;

      if (!operator) break;
      const precedence = PRECEDENCE[operator];
      if (precedence === undefined || precedence < minimum) break;

      this.next();
      // Left-associative, so a - b - c is (a - b) - c rather than a - (b - c).
      const right = this.expression(precedence + 1);
      left = { kind: 'binary', operator, left, right };
    }

    return left;
  }

  private unary(): Node {
    const token = this.peek();
    if (token.type === 'operator' && (token.value === '-' || token.value === '+')) {
      this.next();
      return { kind: 'unary', operator: token.value, operand: this.unary() };
    }
    if (token.type === 'identifier' && /^not$/i.test(token.value)) {
      this.next();
      return { kind: 'unary', operator: 'not', operand: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.next();

    if (token.type === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.type === 'string') return { kind: 'string', value: token.value };

    if (token.type === 'paren' && token.value === '(') {
      const node = this.expression(0);
      const close = this.next();
      if (close.type !== 'paren' || close.value !== ')') {
        throw new ParseError('This "(" is never closed — add a ")".', token.position);
      }
      return node;
    }

    if (token.type === 'identifier') {
      const lower = token.value.toLowerCase();
      if (lower === 'true') return { kind: 'boolean', value: true };
      if (lower === 'false') return { kind: 'boolean', value: false };
      if (lower === 'null') return { kind: 'null' };

      // A name followed by "(" is a call; otherwise it is a field.
      const following = this.peek();
      if (following.type === 'paren' && following.value === '(') {
        this.next();
        const args: Node[] = [];
        if (!(this.peek().type === 'paren' && this.peek().value === ')')) {
          for (;;) {
            args.push(this.expression(0));
            const separator = this.peek();
            if (separator.type === 'comma') {
              this.next();
              continue;
            }
            break;
          }
        }
        const close = this.next();
        if (close.type !== 'paren' || close.value !== ')') {
          throw new ParseError(`The arguments to ${token.value}() are never closed — add a ")".`, token.position);
        }
        return { kind: 'call', name: lower, args, position: token.position };
      }

      return { kind: 'field', name: token.value, position: token.position };
    }

    if (token.type === 'end') throw new ParseError('The expression stops here, but something was expected.', token.position);
    throw new ParseError(`Unexpected "${token.value}".`, token.position);
  }
}

// --------------------------------------------------------------- functions

type Fn = (args: ExpressionValue[]) => ExpressionValue;

function toNumber(value: ExpressionValue): number | null {
  if (value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function toText(value: ExpressionValue): string {
  if (value === null) return '';
  return String(value);
}

/**
 * The whole function table. Nothing outside this can be called.
 *
 * Deliberately small and survey-shaped: the operations a surveyor needs on an
 * attribute table, not a general standard library. Anything absent is a
 * decision, not an oversight.
 */
const FUNCTIONS: Record<string, { arity: [number, number]; fn: Fn }> = {
  // numbers
  round: {
    arity: [1, 2],
    fn: ([value, places]) => {
      const number = toNumber(value);
      if (number === null) return null;
      const decimals = Math.max(0, Math.min(15, toNumber(places ?? 0) ?? 0));
      const factor = 10 ** decimals;
      return Math.round(number * factor) / factor;
    },
  },
  floor: { arity: [1, 1], fn: ([value]) => nullOr(toNumber(value), Math.floor) },
  ceil: { arity: [1, 1], fn: ([value]) => nullOr(toNumber(value), Math.ceil) },
  abs: { arity: [1, 1], fn: ([value]) => nullOr(toNumber(value), Math.abs) },
  sqrt: {
    arity: [1, 1],
    fn: ([value]) => {
      const number = toNumber(value);
      // The square root of a negative is not a number, and NaN in an attribute
      // table is worse than an empty cell.
      return number === null || number < 0 ? null : Math.sqrt(number);
    },
  },
  min: { arity: [1, 32], fn: (args) => reduceNumbers(args, Math.min) },
  max: { arity: [1, 32], fn: (args) => reduceNumbers(args, Math.max) },

  // text
  upper: { arity: [1, 1], fn: ([value]) => (value === null ? null : toText(value).toUpperCase()) },
  lower: { arity: [1, 1], fn: ([value]) => (value === null ? null : toText(value).toLowerCase()) },
  trim: { arity: [1, 1], fn: ([value]) => (value === null ? null : toText(value).trim()) },
  len: { arity: [1, 1], fn: ([value]) => (value === null ? null : toText(value).length) },
  concat: { arity: [1, 32], fn: (args) => args.map(toText).join('') },
  substr: {
    arity: [2, 3],
    fn: ([value, start, length]) => {
      if (value === null) return null;
      const text = toText(value);
      // One-based, because the people using this write survey specifications,
      // not array indices.
      const from = Math.max(0, (toNumber(start) ?? 1) - 1);
      const count = length === undefined ? undefined : (toNumber(length) ?? 0);
      return count === undefined ? text.slice(from) : text.slice(from, from + count);
    },
  },
  replace: {
    arity: [3, 3],
    fn: ([value, find, put]) => {
      if (value === null) return null;
      return toText(value).split(toText(find)).join(toText(put));
    },
  },

  // null handling, which is most of what a field calculator is for
  isnull: { arity: [1, 1], fn: ([value]) => value === null || value === '' },
  coalesce: {
    arity: [1, 32],
    fn: (args) => args.find((value) => value !== null && value !== '') ?? null,
  },
  if: {
    arity: [3, 3],
    fn: ([condition, whenTrue, whenFalse]) => (truthy(condition) ? whenTrue : whenFalse),
  },

  // conversion
  number: { arity: [1, 1], fn: ([value]) => toNumber(value) },
  text: { arity: [1, 1], fn: ([value]) => (value === null ? null : toText(value)) },
};

function nullOr(value: number | null, transform: (input: number) => number): ExpressionValue {
  return value === null ? null : transform(value);
}

function reduceNumbers(args: ExpressionValue[], pick: (a: number, b: number) => number): ExpressionValue {
  const numbers = args.map(toNumber).filter((value): value is number => value !== null);
  return numbers.length === 0 ? null : numbers.reduce(pick);
}

function truthy(value: ExpressionValue): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value !== '' && value.toLowerCase() !== 'false';
}

// --------------------------------------------------------------- evaluation

function evaluate(node: Node, row: Record<string, unknown>): ExpressionValue {
  switch (node.kind) {
    case 'number':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;

    case 'field': {
      const value = row[node.name];
      if (value === undefined || value === null) return null;
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
      // Dates and anything else become text rather than leaking an object into
      // the expression, where a property access could reach further.
      return String(value);
    }

    case 'unary': {
      const operand = evaluate(node.operand, row);
      if (node.operator === 'not') return !truthy(operand);
      const number = toNumber(operand);
      if (number === null) return null;
      return node.operator === '-' ? -number : number;
    }

    case 'binary':
      return binary(node, row);

    case 'call': {
      const entry = FUNCTIONS[node.name];
      if (!entry) throw new ParseError(`There is no function called ${node.name}().`, node.position);
      const [least, most] = entry.arity;
      if (node.args.length < least || node.args.length > most) {
        const wanted = least === most ? `${least}` : `${least} to ${most}`;
        throw new ParseError(`${node.name}() takes ${wanted} argument(s), not ${node.args.length}.`, node.position);
      }
      return entry.fn(node.args.map((argument) => evaluate(argument, row)));
    }
  }
}

function binary(node: Extract<Node, { kind: 'binary' }>, row: Record<string, unknown>): ExpressionValue {
  // Short-circuit, so `isnull(x) or x > 5` does not evaluate the comparison
  // when x is null.
  if (node.operator === 'and') return truthy(evaluate(node.left, row)) ? truthy(evaluate(node.right, row)) : false;
  if (node.operator === 'or') return truthy(evaluate(node.left, row)) ? true : truthy(evaluate(node.right, row));

  const left = evaluate(node.left, row);
  const right = evaluate(node.right, row);

  switch (node.operator) {
    case '+': {
      // Text plus anything concatenates; numbers add. This is the one
      // overload, and it is here because a field calculator without string
      // joining is missing its second most common use.
      if (typeof left === 'string' || typeof right === 'string') {
        if (toNumber(left) !== null && toNumber(right) !== null) return toNumber(left)! + toNumber(right)!;
        return toText(left) + toText(right);
      }
      return arithmetic(left, right, (a, b) => a + b);
    }
    case '-':
      return arithmetic(left, right, (a, b) => a - b);
    case '*':
      return arithmetic(left, right, (a, b) => a * b);
    case '/':
      // Division by zero yields null rather than Infinity: an attribute table
      // full of "Infinity" is a table nobody can export.
      return arithmetic(left, right, (a, b) => (b === 0 ? Number.NaN : a / b));
    case '%':
      return arithmetic(left, right, (a, b) => (b === 0 ? Number.NaN : a % b));

    case '=':
    case '==':
      return equals(left, right);
    case '<>':
    case '!=':
      return !equals(left, right);
    case '<':
    case '>':
    case '<=':
    case '>=':
      return compare(node.operator, left, right);
  }

  return null;
}

function arithmetic(left: ExpressionValue, right: ExpressionValue, apply: (a: number, b: number) => number): ExpressionValue {
  const a = toNumber(left);
  const b = toNumber(right);
  // Null propagates rather than being treated as zero. Treating a missing
  // elevation as zero is how a null becomes a value nobody entered.
  if (a === null || b === null) return null;
  const result = apply(a, b);
  return Number.isFinite(result) ? result : null;
}

function equals(left: ExpressionValue, right: ExpressionValue): boolean {
  if (left === null || right === null) return left === right;
  const a = toNumber(left);
  const b = toNumber(right);
  if (a !== null && b !== null) return a === b;
  return toText(left) === toText(right);
}

function compare(operator: string, left: ExpressionValue, right: ExpressionValue): boolean | null {
  const a = toNumber(left);
  const b = toNumber(right);

  // Numbers compare numerically; anything else compares as text, so sorting a
  // code column still behaves. Null is not comparable and returns null rather
  // than silently sorting to one end.
  if (a !== null && b !== null) return applyOrder(operator, a, b);
  if (left === null || right === null) return null;
  return applyOrder(operator, toText(left), toText(right));
}

function applyOrder<T extends number | string>(operator: string, a: T, b: T): boolean {
  switch (operator) {
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    default:
      return a >= b;
  }
}

// --------------------------------------------------------------- public API

export interface CompiledExpression {
  /** Runs against one row's properties. */
  run: (row: Record<string, unknown>) => ExpressionValue;
  /** Field names the expression reads, for a dependency warning. */
  fields: string[];
  source: string;
}

export type CompileResult = { ok: true; expression: CompiledExpression } | { ok: false; error: ExpressionError };

/**
 * Parses an expression once, so a table of 40,000 rows is not re-parsed 40,000
 * times.
 *
 * Errors are returned rather than thrown: a syntax error in a text box is an
 * ordinary state of that text box, not an exception.
 */
export function compileExpression(source: string): CompileResult {
  try {
    const ast = new Parser(tokenize(source)).parse();
    // An unknown function name or a wrong argument count is a fault in the
    // EXPRESSION, so it is reported here, once, with a position — not left to
    // the evaluator, where it would become a null per row and a plan offering
    // to empty forty thousand cells because someone typed "rnd" for "round".
    validateCalls(ast);
    const fields: string[] = [];
    collectFields(ast, fields);
    return {
      ok: true,
      expression: {
        source,
        fields: [...new Set(fields)],
        run: (row) => {
          try {
            return evaluate(ast, row);
          } catch (error) {
            // A per-row failure — an unknown function, a bad argument count —
            // yields null for that row rather than aborting the whole
            // calculation partway through and leaving half a column written.
            void error;
            return null;
          }
        },
      },
    };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: { message: error.message, position: error.position } };
    return { ok: false, error: { message: error instanceof Error ? error.message : String(error), position: 0 } };
  }
}

/** Checks every call in the tree against the function table, at compile time. */
function validateCalls(node: Node): void {
  switch (node.kind) {
    case 'call': {
      const entry = FUNCTIONS[node.name];
      if (!entry) {
        const suggestion = nearestFunction(node.name);
        throw new ParseError(
          `There is no function called ${node.name}().${suggestion ? ` Did you mean ${suggestion}()?` : ''}`,
          node.position
        );
      }
      const [least, most] = entry.arity;
      if (node.args.length < least || node.args.length > most) {
        const wanted = least === most ? `${least}` : `${least} to ${most}`;
        throw new ParseError(`${node.name}() takes ${wanted} argument(s), not ${node.args.length}.`, node.position);
      }
      for (const argument of node.args) validateCalls(argument);
      break;
    }
    case 'unary':
      validateCalls(node.operand);
      break;
    case 'binary':
      validateCalls(node.left);
      validateCalls(node.right);
      break;
    default:
      break;
  }
}

/**
 * The closest function name, for the error message.
 *
 * Real edit distance rather than a prefix match: the typos people actually make
 * are dropped letters ("rnd" for "round") and transpositions, neither of which
 * a shared-prefix test finds.
 */
function nearestFunction(name: string): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of Object.keys(FUNCTIONS)) {
    const distance = editDistance(lower, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  // Beyond two edits it stops being a correction and starts being a guess.
  return bestDistance <= 2 ? best : null;
}

/** Levenshtein distance, two rows rather than a full matrix. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(substitution, previous[column] + 1, current[column - 1] + 1);
    }
    previous = current;
  }

  return previous[right.length];
}

function collectFields(node: Node, into: string[]): void {
  switch (node.kind) {
    case 'field':
      into.push(node.name);
      break;
    case 'unary':
      collectFields(node.operand, into);
      break;
    case 'binary':
      collectFields(node.left, into);
      collectFields(node.right, into);
      break;
    case 'call':
      for (const argument of node.args) collectFields(argument, into);
      break;
    default:
      break;
  }
}

/** Validates an expression against a known field list, before it is run. */
export function checkExpression(source: string, availableFields: string[]): ExpressionError | null {
  const compiled = compileExpression(source);
  if (!compiled.ok) return compiled.error;

  const known = new Set(availableFields);
  const missing = compiled.expression.fields.filter((field) => !known.has(field));
  if (missing.length > 0) {
    return {
      message: `No field called ${missing.map((field) => `"${field}"`).join(', ')}. Use [square brackets] for a name with spaces.`,
      position: source.indexOf(missing[0]),
    };
  }
  return null;
}

/** The function names, for the help text beside the expression box. */
export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
