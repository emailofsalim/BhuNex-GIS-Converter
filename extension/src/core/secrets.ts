/**
 * What must never be written out (rule R23).
 *
 * One definition of "credential-shaped", used by every path that produces a
 * file: the KML/KMZ balloon writer, the project file, the conversion report.
 * Rule R23 says credentials must not appear in *any* export; a rule enforced
 * separately in each writer is a rule that holds in some of them.
 *
 * The matching is deliberately by NAME AND BY VALUE. A field called `api_key`
 * is caught by its name whatever it holds, and a field called `note` holding a
 * bearer token is caught by its value whatever it is called. Neither test alone
 * is enough: attribute tables that have been through three systems carry
 * credentials under names nobody would guess.
 *
 * False positives are the accepted cost. Dropping a field called `author` —
 * which matches nothing here — would be a bug, but dropping one called
 * `auth_note` is the right trade: the omission is always REPORTED, so a user
 * who needs that field can see that it was removed and why, whereas a token
 * written into a KMZ that gets emailed to a client cannot be recalled.
 */

/** Field names that carry secrets, whatever they hold. */
export const SECRET_NAME_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth|bearer|session[_-]?id|signature|sas[_-]?token)/i;

/**
 * Values that look like a credential whatever the field is called.
 *
 * Anchored at the start rather than searched for anywhere in the string: a
 * description that happens to contain the word "bearer" is prose, whereas one
 * that *begins* `Bearer ` followed by a blob is a header someone pasted in.
 *
 * CASE-INSENSITIVE, and that flag is the whole point of this comment. Without
 * it the pattern matched a lower-case `bearer ` and missed `Bearer ` — which is
 * the capitalisation every HTTP header uses and therefore the only one anyone
 * ever pastes. The rule looked enforced and let the real case through.
 */
export const SECRET_VALUE_PATTERN = /^(bearer\s+\S+|eyJ[A-Za-z0-9_-]{10,}\.|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,})/i;

/** A URL carrying credentials in its authority or a signed query. */
export const CREDENTIALED_URL = /^https?:\/\/[^/\s]*:[^/\s]*@|[?&](sig|signature|token|access_token|key)=/i;

export interface SanitisedProperties {
  safe: Record<string, unknown>;
  /** Field names dropped because they looked like credentials. */
  dropped: string[];
}

/** True when this key/value pair must not reach a file. */
export function looksLikeSecret(key: string, value: unknown): boolean {
  if (SECRET_NAME_PATTERN.test(key)) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return SECRET_VALUE_PATTERN.test(trimmed) || CREDENTIALED_URL.test(trimmed);
}

/** Removes anything credential-shaped before it can reach the output. */
export function stripSecrets(properties: Record<string, unknown>): SanitisedProperties {
  const safe: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(properties)) {
    if (looksLikeSecret(key, value)) {
      dropped.push(key);
      continue;
    }
    safe[key] = value;
  }

  return { safe, dropped };
}

/**
 * The same scrub applied through a nested structure.
 *
 * The project file is not a flat attribute table — settings, export
 * configuration and metadata all nest — and a token two levels down is exactly
 * as exported as one at the top. Cycles are broken rather than followed, since
 * a settings object that references itself would otherwise hang the save.
 */
export function stripSecretsDeep(value: unknown, dropped: string[] = [], seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return [];
    seen.add(value);
    return value.map((entry) => stripSecretsDeep(entry, dropped, seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value as object)) return {};
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (looksLikeSecret(key, child)) {
        dropped.push(key);
        continue;
      }
      out[key] = stripSecretsDeep(child, dropped, seen);
    }
    return out;
  }

  return value;
}
