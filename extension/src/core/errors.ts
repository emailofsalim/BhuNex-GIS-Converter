/**
 * Conversion errors carry three things, always: what happened, why, and the safe
 * next action. "Conversion failed." is not an acceptable message anywhere in this
 * codebase (instruction §22).
 */

export interface ConversionErrorInit {
  /** Stable, greppable identifier, e.g. 'LAS_TRUNCATED'. */
  code: string;
  /** What happened, in the user's terms. */
  what: string;
  /** Why — the format limitation, missing input or invalid byte range. */
  why: string;
  /** The concrete next step the user can take. */
  action: string;
  detail?: Record<string, unknown>;
  cause?: unknown;
}

export class ConversionError extends Error {
  readonly code: string;
  readonly what: string;
  readonly why: string;
  readonly action: string;
  readonly detail?: Record<string, unknown>;

  constructor(init: ConversionErrorInit) {
    super(`${init.what} ${init.why} ${init.action}`.trim());
    this.name = 'ConversionError';
    this.code = init.code;
    this.what = init.what;
    this.why = init.why;
    this.action = init.action;
    this.detail = init.detail;
    if (init.cause !== undefined) this.cause = init.cause;
  }

  /** Structured form for the log panel and the batch manifest. */
  toJSON() {
    return { code: this.code, what: this.what, why: this.why, action: this.action, detail: this.detail };
  }
}

export function conversionError(init: ConversionErrorInit): ConversionError {
  return new ConversionError(init);
}

/** Wraps an unknown throw into the structured shape without losing the original. */
export function asConversionError(error: unknown, context: { code: string; action: string }): ConversionError {
  if (error instanceof ConversionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ConversionError({
    code: context.code,
    what: 'The operation stopped with an unexpected engine error.',
    why: message,
    action: context.action,
    cause: error,
  });
}

/**
 * Guards a length read out of a file header against the bytes actually present.
 * Binary readers must never allocate from a declared count: a corrupt or
 * truncated file would otherwise either crash the tab or silently read garbage.
 */
export function assertWithinBuffer(
  declared: number,
  available: number,
  context: { code: string; unit: string; what: string; action: string }
): void {
  if (declared > available) {
    throw new ConversionError({
      code: context.code,
      what: context.what,
      why: `The header declares ${declared.toLocaleString()} ${context.unit} but the file holds only ${available.toLocaleString()}. The file is truncated or corrupt.`,
      action: context.action,
      detail: { declared, available },
    });
  }
}
