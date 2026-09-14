/**
 * Emptying the queue must empty the canvas.
 *
 * The defect: `previewWrap` is hidden when no file is selected, which looks
 * like clearing and is not. The bitmap kept its last drawing, and the overlay
 * hooks kept their references to a dataset that had been removed. Measured in a
 * real browser, the canvas pixel hash after emptying the queue was IDENTICAL to
 * the hash while the file was still loaded.
 *
 * The fix wipes the bitmap directly rather than asking the canvas to
 * re-render, because by then the element is hidden, has no layout, and the
 * renderer returns without painting. These tests pin the parts that can be
 * checked without a browser: that the function exists, that it drops the state
 * which outlives a removed file, and that it survives being called when there
 * is no canvas yet.
 */

import { describe, expect, it, vi } from 'vitest';

describe('clearing the queue clears what the canvas holds', () => {
  it('wipes the bitmap directly, since a hidden canvas will not repaint', async () => {
    const clearRect = vi.fn();
    const element = { width: 838, height: 853, getContext: () => ({ clearRect }) };
    const setData = vi.fn();

    const { ui } = await import('../src/workspace/ui-state');
    const { clearPreview } = await import('../src/workspace/panels/canvas');

    ui.previewCanvas = {
      element,
      setData,
      render: vi.fn(),
      onOverlay: () => undefined,
      onUnderlay: () => undefined,
    } as never;

    clearPreview();

    // The bitmap, not a re-render request: the element is hidden by now.
    expect(clearRect).toHaveBeenCalledWith(0, 0, 838, 853);
    // And the data is emptied, so anything that does repaint draws nothing.
    expect(setData).toHaveBeenCalledWith({ layers: [], truncated: false });
  });

  it('drops the overlay hook, so a removed dataset cannot keep painting', async () => {
    const { ui } = await import('../src/workspace/ui-state');
    const { clearPreview } = await import('../src/workspace/panels/canvas');

    ui.previewCanvas = {
      element: { width: 10, height: 10, getContext: () => ({ clearRect: vi.fn() }) },
      setData: vi.fn(),
      render: vi.fn(),
      onOverlay: () => undefined,
      onUnderlay: () => undefined,
    } as never;

    clearPreview();
    expect((ui.previewCanvas as unknown as { onOverlay?: unknown }).onOverlay).toBeUndefined();
  });

  it('drops the selection, which addresses features by layer name and index', async () => {
    // A selection held across a file change points into geometry that no longer
    // exists, and the next edit would apply to whatever now occupies those
    // indices — a silent edit to the wrong parcel.
    const { ui } = await import('../src/workspace/ui-state');
    const { clearPreview } = await import('../src/workspace/panels/canvas');

    ui.previewCanvas = {
      element: { width: 10, height: 10, getContext: () => ({ clearRect: vi.fn() }) },
      setData: vi.fn(),
      render: vi.fn(),
      onOverlay: () => undefined,
      onUnderlay: () => undefined,
    } as never;
    ui.featureSelection = { layers: { PARCEL: [0, 1, 2] } } as never;

    clearPreview();
    expect(Object.keys((ui.featureSelection as unknown as { layers?: Record<string, number[]> }).layers ?? {})).toHaveLength(0);
  });

  it('does nothing rather than throwing when no canvas exists yet', async () => {
    const { ui } = await import('../src/workspace/ui-state');
    const { clearPreview } = await import('../src/workspace/panels/canvas');
    ui.previewCanvas = null;
    expect(() => clearPreview()).not.toThrow();
  });
});
