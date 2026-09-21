/**
 * Folding, and the event guard that nearly made it a liability.
 *
 * THE GUARD IS THE INTERESTING PART
 *
 * `event.target` is typed `EventTarget`, not `Element`, and the difference is
 * not academic: a keydown dispatched at the document, or one arriving with
 * nothing focused, has a DOCUMENT as its target — and a Document has no
 * `closest`. Written the obvious way,
 *
 *     (event.target as HTMLElement | null)?.closest(…)
 *
 * the `?.` guards a NULL target and does nothing whatever about a target of the
 * wrong KIND, so the call throws. A listener bound to the document that throws
 * takes every branch below it with it.
 *
 * That was live in the keyboard-shortcut handler before this work — one such
 * keystroke and no shortcut on that event ran at all — and it was measured in a
 * real browser here as "TypeError: target?.closest is not a function" before
 * being fixed in both places.
 *
 * These run without a DOM. This repository ships zero runtime dependencies and
 * has no jsdom; adding one so a test could build a <div> would trade that
 * discipline for very little, since the defect lives in a pure guard that can
 * be tested directly. The rendering half was verified in a headless browser
 * instead, where the exception was found in the first place.
 */

import { describe, expect, it } from 'vitest';
import { elementFrom, isCollapsed, setCollapsed } from '../src/workspace/collapse';

describe('the guard that keeps a document-level listener alive', () => {
  it('rejects a target that is not an Element rather than calling closest on it', () => {
    // The exact shapes that reached it: a Document, and the plain object a
    // synthetic event carries.
    expect(elementFrom({ nodeType: 9 })).toBeNull();
    expect(elementFrom(null)).toBeNull();
    expect(elementFrom(undefined)).toBeNull();
    expect(elementFrom('not an element')).toBeNull();
  });

  it('rejects an impostor that merely has a closest method', () => {
    // A duck-type check on `closest` would accept this and then behave oddly.
    // `instanceof Element` is the check, so it does not.
    expect(elementFrom({ closest: () => null })).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    for (const value of [0, '', false, NaN, [], {}, Symbol('x'), () => undefined]) {
      expect(() => elementFrom(value)).not.toThrow();
    }
  });
});

describe('the remembered fold state', () => {
  it('remembers by title, not by position', () => {
    // Panels rebuild their sections in whatever order the data needs, so an
    // index would fold whichever section happened to land in that slot.
    setCollapsed('Control points', true);
    setCollapsed('Place this drawing', false);
    expect(isCollapsed('Control points')).toBe(true);
    expect(isCollapsed('Place this drawing')).toBe(false);
  });

  it('ignores case and surrounding space, so a heading can be retitled safely', () => {
    setCollapsed('  Match To A Georeferenced Drawing  ', true);
    expect(isCollapsed('match to a georeferenced drawing')).toBe(true);
    expect(isCollapsed('MATCH TO A GEOREFERENCED DRAWING')).toBe(true);
  });

  it('unfolds again', () => {
    setCollapsed('Control points', true);
    expect(isCollapsed('Control points')).toBe(true);
    setCollapsed('Control points', false);
    expect(isCollapsed('Control points')).toBe(false);
  });

  it('reports a section nobody has touched as FOLDED', () => {
    // The default was inverted deliberately. The workspace grew to fourteen
    // panels and forty-odd sections, and opening them all by default met a new
    // file with a wall of controls and the drawing squeezed between them. A
    // section nobody has opened is one nobody has asked to see.
    expect(isCollapsed('a heading that has never been folded')).toBe(true);
  });

  it('keeps the two frame panes open until the user says otherwise', () => {
    // Files and the format list are not content, they are the frame: folded on
    // a first run, the workspace opens as an empty grey column with no way to
    // tell it is working. They are seeded open, and a user who folds one has
    // that remembered like any other.
    expect(isCollapsed('files')).toBe(false);
    expect(isCollapsed('output formats')).toBe(false);
    setCollapsed('files', true);
    expect(isCollapsed('files')).toBe(true);
    setCollapsed('files', false);
  });

  it('works with no localStorage at all', () => {
    // A private window, or storage the browser has blocked. Folding is a
    // convenience; losing it must never stop the workspace booting — and in
    // this test environment there is no localStorage, so every call here has
    // already exercised that path.
    expect(() => setCollapsed('anything', true)).not.toThrow();
    expect(isCollapsed('anything')).toBe(true);
  });
});
