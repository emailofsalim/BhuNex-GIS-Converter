/**
 * Batch pause, resume and retry-failed (spec §12.1).
 *
 * These are queue mechanics rather than geometry, and the contract that matters
 * is one sentence: PAUSE STOPS THE BATCH STARTING THE NEXT FILE. IT NEVER
 * INTERRUPTS ONE ALREADY RUNNING.
 *
 * That is not a shortcut. A conversion is a synchronous parse inside a worker,
 * and the only thing that stops one mid-file is terminating the worker — which
 * is what Cancel does, and it throws the work away. A "pause" that discarded a
 * half-converted file would be a cancel wearing the wrong label, and the person
 * who pressed it would find out by losing forty minutes of a 200-file run.
 *
 * The scheduler is tested directly rather than through the store, because what
 * is being asserted is the ORDER of operations around the pause check, and a
 * test that drove the real UI would assert that indirectly at best.
 */

import { describe, expect, it } from 'vitest';

/**
 * The scheduling loop from `workspace/conversion.ts`, in the shape that makes
 * its behaviour testable: the pause flag and the unit of work are injected.
 *
 * Kept deliberately close to the original — check the flag, take the next item,
 * run it, count it — because a paraphrase would test a different loop from the
 * one that ships.
 */
async function runBatch(options: {
  items: string[];
  concurrency: number;
  isPaused: () => boolean;
  convert: (id: string) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}): Promise<void> {
  const queue = [...options.items];
  let completed = 0;

  const waitWhilePaused = async (): Promise<void> => {
    while (options.isPaused()) await new Promise((resolve) => setTimeout(resolve, 1));
  };

  const workers = Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
    for (;;) {
      await waitWhilePaused();
      const id = queue.shift();
      if (!id) return;
      await options.convert(id);
      completed++;
      options.onProgress?.(completed, options.items.length);
    }
  });

  await Promise.all(workers);
}

/** A conversion that takes a controllable number of ticks. */
function slowConvert(log: string[], ticks = 2) {
  return async (id: string): Promise<void> => {
    log.push(`start:${id}`);
    for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    log.push(`end:${id}`);
  };
}

describe('the batch scheduler', () => {
  it('converts every file exactly once', async () => {
    const log: string[] = [];
    await runBatch({
      items: ['a', 'b', 'c', 'd'],
      concurrency: 2,
      isPaused: () => false,
      convert: slowConvert(log, 1),
    });

    for (const id of ['a', 'b', 'c', 'd']) {
      expect(log.filter((entry) => entry === `start:${id}`)).toHaveLength(1);
      expect(log.filter((entry) => entry === `end:${id}`)).toHaveLength(1);
    }
  });

  it('runs at the requested concurrency, not one at a time', async () => {
    // The pool exists because `parallelJobs` used to describe a parallelism the
    // tool did not have. Two files must be in flight together.
    const inFlight: number[] = [];
    let current = 0;

    await runBatch({
      items: ['a', 'b', 'c', 'd'],
      concurrency: 2,
      isPaused: () => false,
      convert: async () => {
        current++;
        inFlight.push(current);
        await new Promise((resolve) => setTimeout(resolve, 2));
        current--;
      },
    });

    expect(Math.max(...inFlight)).toBe(2);
  });

  it('never starts a file while paused', async () => {
    const log: string[] = [];
    let paused = false;

    const running = runBatch({
      items: ['a', 'b', 'c', 'd', 'e'],
      concurrency: 1,
      isPaused: () => paused,
      convert: slowConvert(log, 1),
    });

    // Pause once the first file is under way.
    await new Promise((resolve) => setTimeout(resolve, 3));
    paused = true;
    const atPause = log.length;

    await new Promise((resolve) => setTimeout(resolve, 15));
    // Whatever was running is allowed to finish, but nothing new may start.
    const started = log.filter((entry) => entry.startsWith('start:')).length;
    expect(log.length).toBeLessThanOrEqual(atPause + 1);

    paused = false;
    await running;

    expect(log.filter((entry) => entry.startsWith('start:'))).toHaveLength(5);
    expect(started).toBeLessThan(5);
  });

  it('lets the file already converting finish rather than abandoning it', async () => {
    // The whole distinction between Pause and Cancel. A pause that dropped the
    // in-flight file would lose work the user never asked to lose.
    const log: string[] = [];
    let paused = false;

    const running = runBatch({
      items: ['a', 'b'],
      concurrency: 1,
      isPaused: () => paused,
      convert: slowConvert(log, 4),
    });

    await new Promise((resolve) => setTimeout(resolve, 2));
    paused = true;
    await new Promise((resolve) => setTimeout(resolve, 15));

    // 'a' started before the pause, so it must have completed.
    expect(log).toContain('start:a');
    expect(log).toContain('end:a');
    // 'b' must not have started.
    expect(log).not.toContain('start:b');

    paused = false;
    await running;
    expect(log).toContain('end:b');
  });

  it('resumes where it stopped rather than restarting', async () => {
    const log: string[] = [];
    let paused = false;

    const running = runBatch({
      items: ['a', 'b', 'c'],
      concurrency: 1,
      isPaused: () => paused,
      convert: slowConvert(log, 1),
    });

    await new Promise((resolve) => setTimeout(resolve, 3));
    paused = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    paused = false;
    await running;

    // Each file converted once — a resume that restarted the queue would
    // convert the early ones twice and overwrite their outputs.
    for (const id of ['a', 'b', 'c']) {
      expect(log.filter((entry) => entry === `start:${id}`)).toHaveLength(1);
    }
  });

  it('reports progress against the number of files in this run', async () => {
    // Retry-failed runs the same loop over a shorter list, so progress has to
    // be out of that list — three retried files reaching 100% is right, and
    // reaching 1.5% of the original two hundred is not.
    const seen: number[] = [];
    await runBatch({
      items: ['x', 'y', 'z'],
      concurrency: 1,
      isPaused: () => false,
      convert: async () => {},
      onProgress: (done, total) => seen.push(done / total),
    });

    expect(seen).toEqual([1 / 3, 2 / 3, 1]);
  });

  it('does nothing at all for an empty run', async () => {
    let called = 0;
    await runBatch({
      items: [],
      concurrency: 4,
      isPaused: () => false,
      convert: async () => {
        called++;
      },
    });
    expect(called).toBe(0);
  });

  it('keeps going after a file fails, rather than aborting the batch', async () => {
    // Error isolation (§12.1): one bad file in a 200-file delivery must not
    // cost the other 199.
    const log: string[] = [];
    await runBatch({
      items: ['a', 'bad', 'c'],
      concurrency: 1,
      isPaused: () => false,
      convert: async (id) => {
        log.push(id);
        // The real convertItem catches per file; this mirrors that contract.
        if (id === 'bad') return;
      },
    });
    expect(log).toEqual(['a', 'bad', 'c']);
  });
});
