/**
 * The project file (spec §31.4, rule R23).
 *
 * A project holds everything about a job except the source bytes: which files
 * were imported and how they were identified, the CRS decisions, the settings,
 * the edits (as the reversible history of §31.1), the QA results, the saved
 * workflows and the export configuration. Reopening one restores the editing
 * state — including the undo stack, because an edit that stops being reversible
 * when the file is saved is not reversible (R19).
 *
 * ---------------------------------------------------------------------------
 * WHY SOURCE BYTES ARE REFERENCED, NOT EMBEDDED
 *
 * A survey job is a folder of DXFs, a LAS of forty million points and a GeoTIFF.
 * Embedding those turns a project file into a slow, unshareable duplicate of
 * data that already exists on disk — and then the two copies drift.
 *
 * So a source is recorded as an IDENTITY: name, path in the tree it came from,
 * size, format, and the SHA-256 the importer already computed. On reopen the
 * user supplies the files again and `matchSources` says, per file, whether it
 * is the same data (hash matches), the same file changed since (name and size
 * match, hash does not), or missing. That distinction matters: replaying edits
 * onto changed data would produce a result that is neither the old job nor a
 * fresh one, so it is refused rather than attempted.
 *
 * Embedding is available per source for the cases where it is the right answer
 * — a 40 KB cadastral DXF that must travel with its project — and the cost is
 * stated rather than hidden.
 *
 * ---------------------------------------------------------------------------
 * R23: NO CREDENTIALS, EVER
 *
 * A project file is the single most shareable artefact this tool produces: it
 * is small, it is JSON, and it gets emailed. Everything written into one goes
 * through `stripSecretsDeep` first — settings, metadata, export configuration,
 * every source's properties — and what was removed is listed in the file
 * itself, so the omission is visible rather than mysterious.
 */

import type { CrsRef } from './cir';
import type { HistorySnapshot } from './history';
import type { Workflow } from './workflow';
import { stripSecretsDeep } from './secrets';

/**
 * The app's settings as stored, kept structural on purpose.
 *
 * Core must not depend on the state layer, and a project file that only opens
 * when its settings match this build's `AppSettings` field-for-field is a
 * project file that stops opening after every release. Unknown keys are carried
 * through and merged over the defaults on load, so a project written by an
 * older build gains new settings instead of losing the ones it has.
 */
export type AppSettingsSnapshot = Record<string, unknown>;

export const PROJECT_FORMAT_VERSION = 1;
export const PROJECT_EXTENSION = 'ubnx';
export const PROJECT_MIME = 'application/json';

/** How a source's data is carried, if at all. */
export type SourceCarriage = 'reference' | 'embedded';

export interface ProjectSource {
  id: string;
  fileName: string;
  /** Path as presented at import, e.g. `Delivery/Survey/plots.dxf`. */
  path: string;
  /** Archive nesting chain, outermost first. */
  containers: string[];
  size: number;
  /** SHA-256 of the source bytes, which is what identity is decided on. */
  sha256?: string;
  formatId: string;
  formatName: string;
  detectionConfidence: number;
  /** Format the user forced, when detection was overridden. */
  forcedFormatId?: string;
  /** CRS in force for this source, including one the user asserted. */
  crs: CrsRef | null;
  crsOrigin: string;
  targetFormatId?: string;
  carriage: SourceCarriage;
  /** Base64 of the source bytes. Present only when `carriage` is 'embedded'. */
  data?: string;
  /** The reversible edit history for this source (§31.1). */
  history?: HistorySnapshot;
  /** The QA verdict as it stood, so a reopened project shows what was found. */
  qa?: { passed: boolean; summary: string; checkedAt: number };
  /** Measured source-versus-output differences, as §30.2 reported them. */
  diff?: { passed: boolean; summary: string };
}

export interface ProjectExportConfig {
  globalTargetFormatId: string | null;
  outputLayout: string;
  naming: string;
  mirrorBatchTree: boolean;
  embedMetadata: boolean;
}

export interface ProjectFile {
  formatVersion: number;
  /** Written so a file from a future build is recognised rather than guessed at. */
  product: string;
  productVersion: string;
  name: string;
  savedAt: string;
  settings: AppSettingsSnapshot;
  sources: ProjectSource[];
  workflows: Workflow[];
  exportConfig: ProjectExportConfig;
  /**
   * Field names removed because they looked like credentials (R23).
   *
   * Listed rather than silently dropped: a user who cannot find a field they
   * expected needs to know it was removed on purpose and why.
   */
  droppedSecretFields: string[];
  /** Free-form note the user attached to the job. */
  notes?: string;
}

export interface SaveProjectOptions {
  name: string;
  productVersion: string;
  settings: Record<string, unknown>;
  sources: ProjectSource[];
  workflows?: Workflow[];
  exportConfig: ProjectExportConfig;
  notes?: string;
  /** Fixed clock for tests; defaults to now. */
  now?: Date;
}

/**
 * Builds the project object, scrubbed.
 *
 * Returns the object rather than the bytes so the caller decides the encoding
 * and so tests can assert on structure without parsing JSON back out.
 */
export function buildProject(options: SaveProjectOptions): ProjectFile {
  const dropped: string[] = [];
  const settings = stripSecretsDeep(options.settings, dropped) as AppSettingsSnapshot;
  const sources = options.sources.map((source) => stripSecretsDeep(source, dropped) as ProjectSource);
  const workflows = (options.workflows ?? []).map((workflow) => stripSecretsDeep(workflow, dropped) as Workflow);
  const exportConfig = stripSecretsDeep(options.exportConfig, dropped) as ProjectExportConfig;

  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    product: 'BhuNex GIS Converter',
    productVersion: options.productVersion,
    name: options.name,
    savedAt: (options.now ?? new Date()).toISOString(),
    settings,
    sources,
    workflows,
    exportConfig,
    // Deduplicated: a token under the same field name in forty features is one
    // fact about the project, not forty.
    droppedSecretFields: [...new Set(dropped)].sort(),
    notes: options.notes,
  };
}

/** Serialises a project to the bytes that get saved. */
export function writeProject(project: ProjectFile): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(project, null, 2));
}

export interface ProjectReadResult {
  project: ProjectFile | null;
  /** Why the file could not be opened, in the tool's what/why/action shape. */
  error?: { what: string; why: string; action: string };
  /** Non-fatal notes, such as a file written by an older format version. */
  notes: string[];
}

/**
 * Reads a project file.
 *
 * Every failure returns a reason rather than throwing, because "could not open
 * project" with no explanation is the error message people abandon a tool over.
 */
export function readProject(bytes: Uint8Array): ProjectReadResult {
  const notes: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {
      project: null,
      notes,
      error: {
        what: 'This file is not a readable project.',
        why: 'Its contents are not valid JSON, so it is either damaged or not a project file at all.',
        action: `Check the file is the one you saved. Project files end in .${PROJECT_EXTENSION}.`,
      },
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      project: null,
      notes,
      error: {
        what: 'This file is not a project.',
        why: 'A project file is a JSON object; this one holds something else.',
        action: 'Open the file you saved from this tool.',
      },
    };
  }

  const candidate = parsed as Partial<ProjectFile>;
  if (typeof candidate.formatVersion !== 'number' || !Array.isArray(candidate.sources)) {
    return {
      project: null,
      notes,
      error: {
        what: 'This file is JSON but not a project.',
        why: 'It has no format version and no source list, which every project written by this tool has.',
        action: 'Open the file you saved from this tool.',
      },
    };
  }

  if (candidate.formatVersion > PROJECT_FORMAT_VERSION) {
    return {
      project: null,
      notes,
      error: {
        what: `This project was written by a newer version (format ${candidate.formatVersion}).`,
        why: `This build reads format ${PROJECT_FORMAT_VERSION} and cannot know what a later one added. Opening it anyway would silently discard whatever it does not recognise.`,
        action: 'Update the extension, or reopen the project in the version that wrote it.',
      },
    };
  }

  if (candidate.formatVersion < PROJECT_FORMAT_VERSION) {
    notes.push(`Written in project format ${candidate.formatVersion}; upgraded to ${PROJECT_FORMAT_VERSION} on open.`);
  }

  const project: ProjectFile = {
    formatVersion: candidate.formatVersion,
    product: candidate.product ?? 'unknown',
    productVersion: candidate.productVersion ?? 'unknown',
    name: candidate.name ?? 'Untitled project',
    savedAt: candidate.savedAt ?? '',
    settings: (candidate.settings ?? {}) as AppSettingsSnapshot,
    sources: candidate.sources as ProjectSource[],
    workflows: Array.isArray(candidate.workflows) ? candidate.workflows : [],
    exportConfig: (candidate.exportConfig ?? {
      globalTargetFormatId: null,
      outputLayout: 'single',
      naming: 'converted-to',
      mirrorBatchTree: true,
      embedMetadata: false,
    }) as ProjectExportConfig,
    droppedSecretFields: Array.isArray(candidate.droppedSecretFields) ? candidate.droppedSecretFields : [],
    notes: candidate.notes,
  };

  if (project.droppedSecretFields.length > 0) {
    notes.push(
      `${project.droppedSecretFields.length} field(s) were removed as credential-shaped when this project was saved: ${project.droppedSecretFields.join(', ')}.`
    );
  }

  return { project, notes };
}

export type SourceMatchState = 'same' | 'changed' | 'missing' | 'unverifiable';

export interface SourceMatch {
  source: ProjectSource;
  state: SourceMatchState;
  /** The supplied file this source was matched to, when there was one. */
  suppliedName?: string;
  /** What the state means for replaying this source's edits. */
  note: string;
}

export interface SuppliedFile {
  fileName: string;
  path?: string;
  size: number;
  sha256?: string;
}

/**
 * Matches a reopened project's sources against the files the user re-supplied.
 *
 * Matching is on the hash where both sides have one, because that is the only
 * test that answers the question that matters: is this the same data the edits
 * were made against? Name and size agreeing is not the same claim — a re-export
 * from the same CAD file is very often the same name and a similar size, and
 * replaying a vertex edit onto it would move the wrong vertex.
 *
 * Where a hash is absent on either side the state is `unverifiable`, never
 * `same`. An unverifiable match is offered, with the caveat attached, rather
 * than asserted.
 */
export function matchSources(project: ProjectFile, supplied: SuppliedFile[]): SourceMatch[] {
  const byHash = new Map<string, SuppliedFile>();
  const byName = new Map<string, SuppliedFile[]>();
  for (const file of supplied) {
    if (file.sha256) byHash.set(file.sha256, file);
    const key = file.fileName.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), file]);
  }

  return project.sources.map((source) => {
    if (source.carriage === 'embedded' && source.data) {
      return { source, state: 'same', suppliedName: source.fileName, note: 'Carried inside the project file.' };
    }

    if (source.sha256) {
      const exact = byHash.get(source.sha256);
      if (exact) {
        return { source, state: 'same', suppliedName: exact.fileName, note: 'Same data: the content hash matches.' };
      }
    }

    const candidates = byName.get(source.fileName.toLowerCase()) ?? [];
    if (candidates.length === 0) {
      return {
        source,
        state: 'missing',
        note: 'Not supplied. Its recorded settings and history are kept, but nothing can be replayed until the file is provided.',
      };
    }

    // Prefer the candidate whose path also matches: two files called
    // boundary.dxf in different survey folders are two different files.
    const sameTree = candidates.find((file) => file.path && source.path && file.path === source.path);
    const chosen = sameTree ?? candidates[0];

    if (!source.sha256 || !chosen.sha256) {
      return {
        source,
        state: 'unverifiable',
        suppliedName: chosen.fileName,
        note: 'Matched by name; no content hash on one side, so this cannot be confirmed to be the same data.',
      };
    }

    return {
      source,
      state: 'changed',
      suppliedName: chosen.fileName,
      note: 'A file of this name was supplied but its contents differ from the one the project was built on. Replaying edits onto it would apply them to different geometry.',
    };
  });
}

/** True when every source can be restored without a caveat. */
export function projectIsRestorable(matches: SourceMatch[]): boolean {
  return matches.length > 0 && matches.every((match) => match.state === 'same');
}

/** A one-line account of a reopen, for the log. */
export function summariseMatches(matches: SourceMatch[]): string {
  const counts = { same: 0, changed: 0, missing: 0, unverifiable: 0 };
  for (const match of matches) counts[match.state]++;
  const parts = [`${counts.same} restored`];
  if (counts.unverifiable > 0) parts.push(`${counts.unverifiable} matched by name only`);
  if (counts.changed > 0) parts.push(`${counts.changed} changed since the project was saved`);
  if (counts.missing > 0) parts.push(`${counts.missing} not supplied`);
  return parts.join(', ') + '.';
}

/** Base64 for embedding a small source, using only platform APIs. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: `String.fromCharCode(...bytes)` on a megabyte blows the argument
  // limit and throws rather than returning a wrong answer, which is worse than
  // slow.
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Largest source that may be embedded, in bytes.
 *
 * Base64 costs a third again in size and the whole project has to be parsed as
 * one JSON document, so this is a limit on usability rather than an arbitrary
 * number: past a few megabytes the project stops opening quickly, which is the
 * property that makes it worth having.
 */
export const MAX_EMBED_BYTES = 4 * 1024 * 1024;

export function canEmbed(size: number): boolean {
  return size <= MAX_EMBED_BYTES;
}
