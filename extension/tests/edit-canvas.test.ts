/**
 * The editing interaction layer (spec §25.1).
 *
 * Only the pure part is tested here — turning a geometry into the flat ring
 * list the editor addresses. Ring ORDER is the whole contract: `VertexRef.ring`
 * is an index into this list, and if the flattening ever disagreed with
 * `core/vertex-edit.ts` the editor would move a different vertex from the one
 * the user grabbed, silently and only on multi-ring features.
 */

import { describe, expect, it } from 'vitest';
import { editTargetFor } from '@ui/edit-canvas';

describe('flattening a geometry for editing', () => {
  it('treats a line as one ring', () => {
    const target = editTargetFor('Roads', 3, { type: 'LineString', coordinates: [[0, 0], [10, 0]], dimension: 2 });
    expect(target).toEqual({ layer: 'Roads', featureIndex: 3, rings: [[[0, 0], [10, 0]]] });
  });

  it('keeps a polygon shell and its holes in order', () => {
    const shell = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
    const target = editTargetFor('Plots', 0, { type: 'Polygon', coordinates: [shell, hole], dimension: 2 });

    expect(target!.rings).toHaveLength(2);
    expect(target!.rings[0]).toBe(shell);
    expect(target!.rings[1]).toBe(hole);
  });

  it('flattens a multipolygon across parts, preserving order', () => {
    // This is the case that would break silently: ring 2 must be the second
    // part's shell, matching how core/vertex-edit.ts walks the same geometry.
    const a = [[0, 0], [1, 0], [1, 1], [0, 0]];
    const aHole = [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.2]];
    const b = [[5, 5], [6, 5], [6, 6], [5, 5]];
    const target = editTargetFor('Plots', 1, { type: 'MultiPolygon', coordinates: [[a, aHole], [b]], dimension: 2 });

    expect(target!.rings).toHaveLength(3);
    expect(target!.rings[0]).toBe(a);
    expect(target!.rings[1]).toBe(aHole);
    expect(target!.rings[2]).toBe(b);
  });

  it('handles a multilinestring', () => {
    const first = [[0, 0], [1, 1]];
    const second = [[5, 5], [6, 6]];
    expect(editTargetFor('Lines', 0, { type: 'MultiLineString', coordinates: [first, second], dimension: 2 })!.rings)
      .toEqual([first, second]);
  });

  it('refuses geometry with no editable vertices rather than inventing an order', () => {
    // A point has nothing to drag; a GeometryCollection has no ring order that
    // core/vertex-edit.ts would agree with, and an editor whose indices mean
    // something different from the engine's is worse than no editor.
    expect(editTargetFor('Points', 0, { type: 'Point', coordinates: [1, 2], dimension: 2 })).toBeNull();
    expect(editTargetFor('Mixed', 0, { type: 'GeometryCollection', geometries: [], dimension: 2 })).toBeNull();
    expect(editTargetFor('Empty', 0, null)).toBeNull();
  });
});
