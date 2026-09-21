/**
 * The undo history across a save and a reopen.
 *
 * WHY THIS FILE EXISTS
 *
 * `core/history.ts` has carried `snapshotHistory` and `restoreHistory` since
 * the project file was built, with this comment above them:
 *
 *   "The patches go with it: reopening a project and finding the undo stack
 *    empty would mean the edits are no longer reversible, which is R19 broken
 *    by a save."
 *
 * Both functions were complete, both were tested, and NEITHER WAS CALLED BY
 * ANYTHING. `openProject` restored the settings, the workflows and the project
 * name, and never read `ProjectSource.history` back — so the outcome that
 * comment describes is precisely what shipped. Seventh instance of this
 * codebase's house defect: a correct engine wired to nothing.
 *
 * The save side was worse than absent, because it was PRESENT AND WRONG. It
 * spelled out `{ entries, position, dropped }` by hand instead of calling
 * `snapshotHistory`, which worked exactly until the snapshot grew a fourth
 * field: `baseEdits` arrived in 1.11.17 and the hand-rolled copy dropped it
 * silently. `baseEdits` holds commands whose entries have scrolled out of the
 * undo window — no longer reversible, still applied — and `editsAt` rebuilds
 * the command list from it, so a project saved after a long session reopened
 * with those edits GONE from the file it would produce.
 *
 * These tests pin the round trip rather than either half, because each half
 * looked correct on its own.
 */

import { describe, expect, it } from 'vitest';
import {
  createHistory,
  editsAt,
  recordOperation,
  restoreHistory,
  snapshotHistory,
  type HistoryState,
} from '../src/core/history';
import type { CirDataset } from '../src/core/cir';
import type { EditCommand } from '../src/core/edits';

function dataset(xs: number[]): CirDataset {
  return {
    kind: 'vector',
    name: 'survey',
    source: 'test',
    crs: null,
    crsOrigin: 'unknown',
    units: 'm',
    warnings: [],
    metadata: {},
    layers: [
      {
        name: 'L',
        featureCount: xs.length,
        geometryTypes: ['Point'],
        fields: [],
        preview: xs.map((x, index) => ({
          id: `f${index}`,
          geometry: { type: 'Point', dimension: 2, coordinates: [x, 0] },
          properties: {},
          sourceLayer: 'L',
        })),
        previewTruncated: false,
      },
    ],
  } as unknown as CirDataset;
}

const move = (to: number): EditCommand => ({ kind: 'translate', layer: 'L', dx: to, dy: 0 }) as unknown as EditCommand;

/** A history with `keep` entries live and the rest banked, as a long session produces. */
function longSession(steps: number, limit: number): HistoryState {
  let history = createHistory();
  let current = dataset([0]);
  for (let step = 1; step <= steps; step++) {
    const next = dataset([step]);
    history = recordOperation(history, current, next, { kind: 'edit', label: `Move ${step}`, command: move(step) }, { limit });
    current = next;
  }
  return history;
}

describe('the history survives being written to a project and read back', () => {
  it('comes back with the same entries and the same position', () => {
    const history = longSession(4, 100);
    const reopened = restoreHistory(snapshotHistory(history));

    expect(reopened.entries).toHaveLength(4);
    expect(reopened.position).toBe(4);
    expect(reopened.entries.map((entry) => entry.label)).toEqual(['Move 1', 'Move 2', 'Move 3', 'Move 4']);
  });

  it('can still be undone after the round trip, which is the whole point of R19', () => {
    const reopened = restoreHistory(snapshotHistory(longSession(3, 100)));
    expect(reopened.position).toBe(3);
    // A reopened project whose undo stack is empty is the failure this guards.
    expect(reopened.entries.length).toBeGreaterThan(0);
  });

  it('CARRIES THE BANKED EDITS, which a hand-rolled copy silently dropped', () => {
    // Five edits with room for two, so three are banked. All five must still
    // be in the command list after the round trip: banked means "no longer
    // undoable", never "no longer applied".
    const history = longSession(5, 2);
    expect(history.baseEdits).toHaveLength(3);
    expect(editsAt(history)).toHaveLength(5);

    const reopened = restoreHistory(snapshotHistory(history));

    expect(reopened.baseEdits).toHaveLength(3);
    expect(editsAt(reopened)).toHaveLength(5);
  });

  it('is not fooled by a snapshot that omits baseEdits', () => {
    // The exact shape the old hand-rolled save wrote. It must restore without
    // throwing — an older project file is still a valid one — but the loss is
    // real and this records what it costs: two of the five edits come back.
    const history = longSession(5, 2);
    const oldStyle = { entries: history.entries, position: history.position, dropped: history.dropped };

    const reopened = restoreHistory(oldStyle);

    expect(reopened.baseEdits).toEqual([]);
    expect(editsAt(reopened)).toHaveLength(2);
    expect(editsAt(history)).toHaveLength(5);
  });

  it('restores a project written before the field existed, without throwing', () => {
    expect(() => restoreHistory(undefined)).not.toThrow();
    expect(restoreHistory(undefined).entries).toEqual([]);
    expect(restoreHistory({ entries: [], position: 0, dropped: 0 }).baseEdits).toEqual([]);
  });
});

describe('the save path goes through the function rather than around it', () => {
  it('writes every field the snapshot has', () => {
    // A hand-rolled copy passes every test written against the fields it
    // happens to name. This one compares the KEY SET, so a fifth field added
    // later fails here instead of going missing in someone's saved project.
    const snapshot = snapshotHistory(longSession(3, 2));
    expect(Object.keys(snapshot).sort()).toEqual(['baseEdits', 'dropped', 'entries', 'position']);
  });
});
