/**
 * The measuring interaction layer (spec §26.1).
 *
 * The arithmetic is `core/measure.ts`'s and is tested in `measure.test.ts`
 * against published geodetic vectors. What is tested HERE is the part that
 * turns clicks into the positions that arithmetic is given, because two of
 * those behaviours are quietly load-bearing:
 *
 *   A CLICK MUST NOT ALSO PAN. The canvas pans on drag. If a measuring click
 *     propagated, the map would move out from under the point just placed and
 *     every subsequent point would be measured from somewhere else.
 *
 *   A CLOSED RING MUST NOT REOPEN. Clicking after finishing an area starts a
 *     new run. Growing the finished one instead would silently change an area
 *     the user had already read off the screen.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MeasureCanvas } from '@ui/measure-canvas';

/**
 * A `window` for the class's key handler. Installed for the whole file rather
 * than per construction, because `dispose()` needs it too and a stub that
 * vanished between construct and dispose would fail a test the code passes.
 */
const windowListeners = new Map<string, ((event: any) => void)[]>();
const realWindow = (globalThis as any).window;

beforeAll(() => {
  (globalThis as any).window = {
    addEventListener: (type: string, handler: (event: any) => void) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), handler]);
    },
    removeEventListener: (type: string, handler: (event: any) => void) => {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((candidate) => candidate !== handler));
    },
  };
});

afterAll(() => {
  (globalThis as any).window = realWindow;
});

/**
 * A canvas stub with a 1:1 world-to-screen transform and its origin at (0, 0),
 * so a click at client (30, 40) is world (30, 40) and the expectations below
 * read as coordinates rather than as arithmetic.
 */
function harness() {
  const listeners = new Map<string, ((event: any) => void)[]>();
  windowListeners.clear();

  const element = {
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: (type: string, handler: (event: any) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    removeEventListener: (type: string, handler: (event: any) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((candidate) => candidate !== handler));
    },
  };

  const preview = {
    element,
    onOverlay: undefined as unknown,
    project: (x: number, y: number) => ({ x, y }),
    unproject: (x: number, y: number) => ({ x, y }),
    render: vi.fn(),
  };

  const changes: { points: number[][]; closed: boolean }[] = [];
  const measure = new MeasureCanvas(preview as never, {
    onChange: (points, closed) => changes.push({ points: points.map((position) => [...position]), closed }),
  });

  const fire = (type: string, event: any): void => {
    for (const handler of listeners.get(type) ?? []) handler(event);
  };

  const key = (name: string): void => {
    for (const handler of windowListeners.get('keydown') ?? []) {
      handler({ key: name, target: null, preventDefault: () => {} });
    }
  };

  const click = (x: number, y: number) => {
    const event = {
      button: 0,
      clientX: x,
      clientY: y,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    fire('pointerdown', event);
    return event;
  };

  return { measure, preview, changes, click, fire, key, last: () => changes[changes.length - 1] };
}

describe('measuring on the canvas', () => {
  it('does nothing until a mode is chosen', () => {
    const { measure, click, changes } = harness();
    expect(measure.getMode()).toBe('off');
    click(10, 10);
    expect(changes).toHaveLength(0);
  });

  it('collects clicked points in order', () => {
    const { measure, click, last } = harness();
    measure.setMode('distance');
    click(0, 0);
    click(30, 40);
    expect(last().points).toEqual([[0, 0], [30, 40]]);
    expect(last().closed).toBe(false);
  });

  it('stops the click from also panning the map', () => {
    // Without this the canvas pans on the same press, so the second point is
    // measured from a map that has moved. Every reading after it is wrong.
    const { measure, click } = harness();
    measure.setMode('distance');
    const event = click(5, 5);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('closes an area run when the first point is clicked again', () => {
    const { measure, click, last } = harness();
    measure.setMode('area');
    click(0, 0);
    click(100, 0);
    click(100, 100);
    click(3, 4); // within the 10px close radius of the first point
    expect(last().closed).toBe(true);
    expect(last().points).toEqual([[0, 0], [100, 0], [100, 100]]);
  });

  it('does not close on a click near the first point before there are three', () => {
    const { measure, click, last } = harness();
    measure.setMode('area');
    click(0, 0);
    click(2, 2);
    expect(last().closed).toBe(false);
    expect(last().points).toHaveLength(2);
  });

  it('starts a new run rather than reopening a closed one', () => {
    const { measure, click, last } = harness();
    measure.setMode('area');
    click(0, 0);
    click(100, 0);
    click(100, 100);
    click(1, 1);
    expect(last().closed).toBe(true);

    click(500, 500);
    expect(last().closed).toBe(false);
    expect(last().points).toEqual([[500, 500]]);
  });

  it('drops the duplicate point a double-click leaves behind', () => {
    // The second press of a double-click is a pointerdown like any other, so
    // the run would end with the same coordinate twice and report a zero-length
    // final leg.
    const { measure, click, fire, last } = harness();
    measure.setMode('distance');
    click(0, 0);
    click(50, 50);
    click(50, 50);
    fire('dblclick', { preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(last().points).toEqual([[0, 0], [50, 50]]);
  });

  it('undoes one point with Backspace and clears with Escape', () => {
    const { measure, click, key, last } = harness();
    measure.setMode('distance');
    click(0, 0);
    click(10, 0);
    click(20, 0);

    key('Backspace');
    expect(last().points).toEqual([[0, 0], [10, 0]]);

    key('Escape');
    expect(last().points).toEqual([]);
  });

  it('undoing after a close reopens the run rather than leaving a stale ring', () => {
    const { measure, click, key, last } = harness();
    measure.setMode('area');
    click(0, 0);
    click(100, 0);
    click(100, 100);
    click(1, 1);
    expect(last().closed).toBe(true);

    key('Backspace');
    expect(last().closed).toBe(false);
    expect(last().points).toEqual([[0, 0], [100, 0]]);
  });

  it('turning the mode off clears the run', () => {
    const { measure, click, last } = harness();
    measure.setMode('distance');
    click(0, 0);
    click(10, 10);
    measure.setMode('off');
    expect(last().points).toEqual([]);
    expect(measure.getMode()).toBe('off');
  });

  it('claims the canvas overlay hook, and gives it back on dispose', () => {
    // Three tools share one hook. A tool that kept drawing after its tab closed
    // would put a measurement over the vertex editor.
    const { measure, preview } = harness();
    expect(typeof preview.onOverlay).toBe('function');
    measure.dispose();
    expect(preview.onOverlay).toBeUndefined();
  });
});
