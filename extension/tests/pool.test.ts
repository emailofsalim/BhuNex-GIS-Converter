/**
 * The worker pool (`workers/pool.ts`).
 *
 * Two behaviours here are the whole reason the pool exists, and both are
 * asserted before anything else:
 *
 *   1. JOBS ACTUALLY RUN IN PARALLEL. The old design had a `parallelJobs`
 *      setting and ONE worker, so every "concurrent" job queued behind the same
 *      thread. A setting that promises parallelism it cannot deliver is worse
 *      than no setting: on an eight-core machine a 200-file batch ran at an
 *      eighth of the implied speed and nothing said so.
 *
 *   2. CANCELLING ONE JOB DOES NOT KILL THE OTHERS. Cancelling means
 *      TERMINATING, because a conversion is a synchronous parse loop that never
 *      returns to its message loop to read a flag. With one shared worker that
 *      would take the whole batch down with it.
 *
 * The pool takes a worker factory, so these run against a fake worker rather
 * than needing a browser — which is also why the production code can be checked
 * at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { CancelledError, recommendedPoolSize, WorkerPool, type PoolWorker } from '@workers/pool';

/**
 * A worker that does nothing until the test tells it to.
 *
 * Holding the reply lets a test observe the pool mid-flight — which is where
 * every property worth checking lives.
 */
class FakeWorker implements PoolWorker {
  static live: FakeWorker[] = [];

  terminated = false;
  readonly received: { id: string }[] = [];
  private messageHandlers: ((event: { data: unknown }) => void)[] = [];
  private errorHandlers: ((event: { message?: string }) => void)[] = [];

  constructor() {
    FakeWorker.live.push(this);
  }

  postMessage(message: unknown): void {
    this.received.push(message as { id: string });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: 'message' | 'error', handler: (event: never) => void): void {
    if (type === 'message') this.messageHandlers.push(handler as (event: { data: unknown }) => void);
    else this.errorHandlers.push(handler as (event: { message?: string }) => void);
  }

  /** The id of whatever this worker is currently running. */
  get current(): string | undefined {
    return this.received[this.received.length - 1]?.id;
  }

  finish(id: string, payload: unknown): void {
    for (const handler of this.messageHandlers) handler({ data: { id, ok: true, payload } });
  }

  fail(id: string, what = 'bad file'): void {
    for (const handler of this.messageHandlers) {
      handler({ data: { id, ok: false, error: { code: 'X', what, why: 'y', action: 'a' } } });
    }
  }

  report(id: string, phase: string): void {
    for (const handler of this.messageHandlers) handler({ data: { id, kind: 'progress', progress: { phase } } });
  }

  crash(message = 'out of memory'): void {
    for (const handler of this.errorHandlers) handler({ message });
  }
}

function makePool(size: number): WorkerPool {
  FakeWorker.live = [];
  return new WorkerPool({ size, createWorker: () => new FakeWorker() });
}

const job = (id: string) => ({ message: { id, op: 'convert' } });

/**
 * Submits without awaiting, swallowing the rejection.
 *
 * Several tests deliberately cancel or crash a job they never await; a bare
 * `void pool.submit(...)` would leave an unhandled rejection and fail the run
 * for a reason unrelated to what is being tested.
 */
function start(pool: WorkerPool, id: string, onProgress?: (progress: { phase: string }) => void): void {
  pool.submit({ message: { id, op: 'convert' }, onProgress }).catch(() => undefined);
}

// ===========================================================================
// Parallelism — the reason the pool exists
// ===========================================================================

describe('running jobs in parallel', () => {
  it('runs up to `size` jobs at once, and queues the rest', () => {
    const pool = makePool(3);
    for (const id of ['a', 'b', 'c', 'd', 'e']) start(pool, id);

    // Three in flight, two waiting — not five queued behind one worker.
    expect(pool.running).toBe(3);
    expect(pool.queued).toBe(2);
    expect(FakeWorker.live).toHaveLength(3);
    expect(FakeWorker.live.map((worker) => worker.current)).toEqual(['a', 'b', 'c']);
  });

  it('starts the next queued job the moment one finishes', () => {
    const pool = makePool(2);
    for (const id of ['a', 'b', 'c']) start(pool, id);
    expect(pool.queued).toBe(1);

    FakeWorker.live[0].finish('a', 'done');
    expect(pool.queued).toBe(0);
    expect(pool.running).toBe(2);
    // The freed worker is REUSED rather than a fourth being spawned.
    expect(FakeWorker.live).toHaveLength(2);
    expect(FakeWorker.live[0].current).toBe('c');
  });

  it('spawns workers lazily, so one small file does not start eight', () => {
    const pool = makePool(8);
    expect(pool.spawned).toBe(0);

    start(pool, 'only');
    expect(pool.spawned).toBe(1);
  });

  it('resolves each job with its own payload', async () => {
    const pool = makePool(2);
    const first = pool.submit<string>(job('a'));
    const second = pool.submit<string>(job('b'));

    // Deliberately out of order: a reply must find its own job.
    FakeWorker.live[1].finish('b', 'B');
    FakeWorker.live[0].finish('a', 'A');

    expect(await first).toBe('A');
    expect(await second).toBe('B');
  });

  it('ignores a reply whose id belongs to no running job', async () => {
    const pool = makePool(1);
    const pending = pool.submit<string>(job('a'));
    FakeWorker.live[0].finish('stale', 'nonsense');
    FakeWorker.live[0].finish('a', 'A');
    expect(await pending).toBe('A');
  });
});

// ===========================================================================
// Cancellation
// ===========================================================================

describe('cancelling', () => {
  it('terminates the worker running the job, because a flag would never be read', async () => {
    const pool = makePool(2);
    const pending = pool.submit(job('a'));
    const worker = FakeWorker.live[0];

    expect(pool.cancel('a')).toBe(true);
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
  });

  it('leaves every other job running', async () => {
    const pool = makePool(3);
    const a = pool.submit(job('a'));
    const b = pool.submit<string>(job('b'));
    const c = pool.submit<string>(job('c'));

    pool.cancel('a');
    await expect(a).rejects.toBeInstanceOf(CancelledError);

    // This is the property that a single shared worker could not have.
    expect(FakeWorker.live[1].terminated).toBe(false);
    expect(FakeWorker.live[2].terminated).toBe(false);

    FakeWorker.live[1].finish('b', 'B');
    FakeWorker.live[2].finish('c', 'C');
    expect(await b).toBe('B');
    expect(await c).toBe('C');
  });

  it('drops a queued job without starting it', async () => {
    const pool = makePool(1);
    start(pool, 'a');
    const queued = pool.submit(job('b'));

    expect(pool.cancel('b')).toBe(true);
    await expect(queued).rejects.toBeInstanceOf(CancelledError);
    // It must never have been handed to a worker.
    expect(FakeWorker.live[0].received.map((entry) => entry.id)).toEqual(['a']);
  });

  it('refills the slot, so a session of cancelled jobs does not shrink the pool', () => {
    const pool = makePool(2);
    start(pool, 'a');
    start(pool, 'b');
    start(pool, 'c');

    pool.cancel('a');
    // 'c' was queued and takes the freed capacity.
    expect(pool.running).toBe(2);
    expect(pool.queued).toBe(0);
  });

  it('cancelAll stops running and queued jobs alike', async () => {
    const pool = makePool(2);
    const jobs = ['a', 'b', 'c', 'd'].map((id) => pool.submit(job(id)));

    pool.cancelAll();
    for (const pending of jobs) await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(pool.running).toBe(0);
    expect(pool.queued).toBe(0);
  });

  it('reports false when the job has already finished', async () => {
    const pool = makePool(1);
    const pending = pool.submit<string>(job('a'));
    FakeWorker.live[0].finish('a', 'A');
    await pending;
    expect(pool.cancel('a')).toBe(false);
  });

  it('a cancel that arrives before the job starts still stops it', async () => {
    const pool = makePool(1);
    start(pool, 'a');

    // Cancel an id the pool has not seen yet, then submit it: the record of the
    // cancellation must survive, or a race between a user's click and a queue
    // slot opening would run a job they stopped.
    pool.cancel('later');
    const late = pool.submit(job('later'));
    FakeWorker.live[0].finish('a', 'A');
    await expect(late).rejects.toBeInstanceOf(CancelledError);
  });
});

// ===========================================================================
// Progress
// ===========================================================================

describe('progress', () => {
  it('reports phases without finishing the job', async () => {
    const pool = makePool(1);
    const seen: string[] = [];
    const pending = pool.submit<string>({ ...job('a'), onProgress: (progress) => seen.push(progress.phase) });

    const worker = FakeWorker.live[0];
    worker.report('a', 'reading');
    worker.report('a', 'writing');
    // A progress message must NOT free the slot — the job is still running.
    expect(pool.running).toBe(1);

    worker.finish('a', 'A');
    expect(await pending).toBe('A');
    expect(seen).toEqual(['reading', 'writing']);
  });

  it('routes progress only to the job it belongs to', () => {
    const pool = makePool(2);
    const first: string[] = [];
    const second: string[] = [];
    start(pool, 'a', (progress) => first.push(progress.phase));
    start(pool, 'b', (progress) => second.push(progress.phase));

    FakeWorker.live[1].report('b', 'reading');
    expect(first).toEqual([]);
    expect(second).toEqual(['reading']);
  });

  it('survives a job with no progress listener', () => {
    const pool = makePool(1);
    start(pool, 'a');
    expect(() => FakeWorker.live[0].report('a', 'reading')).not.toThrow();
  });
});

// ===========================================================================
// Failure
// ===========================================================================

describe('failure', () => {
  it('rejects the job with the error the worker reported', async () => {
    const pool = makePool(1);
    const pending = pool.submit(job('a'));
    FakeWorker.live[0].fail('a', 'That DXF has no entities section.');
    await expect(pending).rejects.toThrow('That DXF has no entities section.');
  });

  it('a crashed worker fails only its own job, not the batch', async () => {
    const pool = makePool(3);
    const a = pool.submit(job('a'));
    const b = pool.submit<string>(job('b'));
    const c = pool.submit<string>(job('c'));

    FakeWorker.live[0].crash('out of memory');
    await expect(a).rejects.toThrow(/out of memory/);

    // The old single-worker client had to reject every in-flight job here,
    // which turned one bad file into a failed batch.
    FakeWorker.live[1].finish('b', 'B');
    FakeWorker.live[2].finish('c', 'C');
    expect(await b).toBe('B');
    expect(await c).toBe('C');
  });

  it('replaces the crashed worker for the next job', () => {
    const pool = makePool(1);
    start(pool, 'a');
    FakeWorker.live[0].crash();

    start(pool, 'b');
    expect(FakeWorker.live).toHaveLength(2);
    expect(FakeWorker.live[1].current).toBe('b');
  });

  it('uses the caller’s error shape when one is supplied', async () => {
    FakeWorker.live = [];
    const pool = new WorkerPool({
      size: 1,
      createWorker: () => new FakeWorker(),
      onWorkerError: (message) => Object.assign(new Error('Worker stopped'), { code: 'WORKER_CRASHED', why: message }),
    });
    const pending = pool.submit(job('a'));
    FakeWorker.live[0].crash('signal 9');
    await expect(pending).rejects.toMatchObject({ code: 'WORKER_CRASHED', why: 'signal 9' });
  });
});

// ===========================================================================
// Sizing
// ===========================================================================

describe('pool size', () => {
  const withCores = (cores: number | undefined, run: () => void): void => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: { hardwareConcurrency: cores },
      configurable: true,
    });
    try {
      run();
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
    }
  };

  it('leaves one core for the UI thread', () => {
    // Using every core defeats the point of workers: the thread that has to
    // stay responsive is the one drawing the progress.
    withCores(8, () => expect(recommendedPoolSize()).toBe(7));
  });

  it('never returns less than one', () => {
    withCores(1, () => expect(recommendedPoolSize()).toBe(1));
    withCores(undefined, () => expect(recommendedPoolSize()).toBe(3));
  });

  it('honours a smaller request', () => {
    withCores(16, () => expect(recommendedPoolSize(2)).toBe(2));
  });

  it('caps at 8 however many cores are reported', () => {
    // Not about CPU: each worker holds a whole file plus its intermediate
    // representation, and eight large point clouds exhaust memory first.
    withCores(64, () => expect(recommendedPoolSize(64)).toBe(8));
    withCores(64, () => expect(recommendedPoolSize()).toBe(8));
  });

  it('ignores a nonsensical request', () => {
    withCores(8, () => {
      expect(recommendedPoolSize(0)).toBe(7);
      expect(recommendedPoolSize(-3)).toBe(7);
    });
  });
});

describe('disposal', () => {
  it('terminates every worker and stays usable afterwards', async () => {
    const pool = makePool(2);
    const pending = pool.submit(job('a'));
    pool.dispose();

    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(FakeWorker.live.every((worker) => worker.terminated)).toBe(true);

    start(pool, 'b');
    expect(pool.running).toBe(1);
  });
});

describe('the fake worker itself', () => {
  it('records what it was told to run', () => {
    const pool = makePool(1);
    start(pool, 'a');
    expect(FakeWorker.live[0].received[0]).toMatchObject({ id: 'a', op: 'convert' });
    expect(vi.isMockFunction(() => {})).toBe(false);
  });
});
