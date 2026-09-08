/**
 * The worker pool (architecture spec RULES 15, 27, 28).
 *
 * ---------------------------------------------------------------------------
 * WHY A POOL, WHEN ONE WORKER ALREADY KEPT THE UI RESPONSIVE
 *
 * Two reasons, and the second is the one that forced it.
 *
 * 1. THE SETTING WAS A LIE. `AppSettings.parallelJobs` starts that many
 *    conversions concurrently, and every one of them queued behind a single
 *    module-level `Worker`. On an eight-core machine a 200-file batch ran at
 *    one-eighth of the speed the control implied, and nothing said so.
 *
 * 2. CANCELLING MEANS TERMINATING. A conversion is a synchronous parse loop
 *    inside the worker; a cancel flag it checks between messages is never read,
 *    because it never returns to the message loop until it is finished. The only
 *    thing that actually stops a 400 MB point cloud mid-parse is
 *    `Worker.terminate()`.
 *
 *    With one shared worker, cancelling one job kills every other job in flight.
 *    So cancellation was not a feature that could be added to the old design —
 *    it needed this one.
 *
 * ---------------------------------------------------------------------------
 * PROGRESS IS A PHASE, NOT A PERCENTAGE
 *
 * The pipeline knows which stage it is in — reading, transforming, writing,
 * re-importing, checking — and it does not know how far through a stage it is
 * without instrumenting every reader. So progress is reported as the stage it
 * has reached, and a percentage is shown only where one is genuinely counted
 * (files in a batch).
 *
 * An invented percentage that jumps 0 → 50 → 100 is worse than a stage label:
 * it teaches the user that the number means nothing, and then the one time a
 * job really is stuck at 40% they have no reason to believe it.
 */

/** The slice of the `Worker` interface a pool needs, so tests can supply one. */
export interface PoolWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', handler: (event: { message?: string }) => void): void;
}

export type WorkerFactory = () => PoolWorker;

/** What the worker reports while a job is running. */
export interface JobProgress {
  phase: string;
  /** Present only where something is genuinely counted. */
  done?: number;
  total?: number;
  detail?: string;
}

export interface PoolMessage {
  id: string;
  kind?: 'progress';
  ok?: boolean;
  payload?: unknown;
  error?: { code: string; what: string; why: string; action: string };
  progress?: JobProgress;
}

export interface SubmitOptions {
  message: { id: string } & Record<string, unknown>;
  transfer?: Transferable[];
  onProgress?: (progress: JobProgress) => void;
}

interface Job {
  id: string;
  message: unknown;
  transfer: Transferable[];
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  onProgress?: (progress: JobProgress) => void;
}

interface Slot {
  worker: PoolWorker;
  /** The job this worker is running, so a cancel knows which one to terminate. */
  job: Job | null;
}

export class CancelledError extends Error {
  readonly code = 'JOB_CANCELLED';
  readonly what = 'The job was cancelled.';
  readonly why = 'You stopped it before it finished.';
  readonly action = 'Start it again if you still want the output.';

  constructor(readonly jobId: string) {
    super('The job was cancelled.');
    this.name = 'CancelledError';
  }
}

export interface PoolOptions {
  /** Largest number of workers to run at once. */
  size: number;
  createWorker: WorkerFactory;
  /** Turns a worker-level failure into the error shape the UI understands. */
  onWorkerError?: (message: string) => Error;
}

/**
 * A fixed-size pool of workers with a FIFO queue.
 *
 * Workers are created lazily: a user who converts one small file never pays for
 * eight worker start-ups, and a machine reporting sixteen cores does not get
 * sixteen copies of a 400 kB bundle unless the work is there.
 */
export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  /** Jobs cancelled before they ever started, so they never run. */
  private readonly abandoned = new Set<string>();

  constructor(private readonly options: PoolOptions) {}

  get size(): number {
    return Math.max(1, this.options.size);
  }

  /** How many workers actually exist. Lower than `size` until the work needs them. */
  get spawned(): number {
    return this.slots.length;
  }

  get running(): number {
    return this.slots.filter((slot) => slot.job !== null).length;
  }

  get queued(): number {
    return this.queue.length;
  }

  submit<T>(options: SubmitOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id: options.message.id,
        message: options.message,
        transfer: options.transfer ?? [],
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress: options.onProgress,
      };
      this.queue.push(job);
      this.pump();
    });
  }

  /**
   * Stops a job.
   *
   * A queued job is simply dropped. A running one has its worker TERMINATED,
   * because the conversion is a synchronous loop that will not check a flag
   * until it has already finished. The slot is refilled on the next submission,
   * so the pool does not shrink over a session of cancelled jobs.
   */
  cancel(jobId: string): boolean {
    const queuedIndex = this.queue.findIndex((job) => job.id === jobId);
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1);
      job.reject(new CancelledError(jobId));
      return true;
    }

    const slot = this.slots.find((candidate) => candidate.job?.id === jobId);
    if (!slot || !slot.job) {
      // Not running and not queued: it may already have finished. Recording it
      // means a cancel that races a completion still stops a re-queue.
      this.abandoned.add(jobId);
      return false;
    }

    const job = slot.job;
    slot.job = null;
    slot.worker.terminate();
    this.slots.splice(this.slots.indexOf(slot), 1);

    job.reject(new CancelledError(jobId));
    this.pump();
    return true;
  }

  /** Cancels everything, queued and running. */
  cancelAll(): void {
    for (const job of this.queue.splice(0)) job.reject(new CancelledError(job.id));
    for (const slot of [...this.slots]) if (slot.job) this.cancel(slot.job.id);
  }

  /** Terminates every worker. The pool stays usable and re-spawns on demand. */
  dispose(): void {
    this.cancelAll();
    for (const slot of this.slots) slot.worker.terminate();
    this.slots.length = 0;
  }

  // --------------------------------------------------------------- internals

  private pump(): void {
    while (this.queue.length > 0) {
      const slot = this.freeSlot();
      if (!slot) return;

      const job = this.queue.shift() as Job;
      if (this.abandoned.delete(job.id)) {
        job.reject(new CancelledError(job.id));
        continue;
      }

      slot.job = job;
      slot.worker.postMessage(job.message, job.transfer);
    }
  }

  private freeSlot(): Slot | null {
    const idle = this.slots.find((slot) => slot.job === null);
    if (idle) return idle;
    if (this.slots.length >= this.size) return null;
    return this.spawn();
  }

  private spawn(): Slot {
    const worker = this.options.createWorker();
    const slot: Slot = { worker, job: null };

    worker.addEventListener('message', (event: { data: unknown }) => {
      const message = event.data as PoolMessage;
      if (!message || typeof message.id !== 'string') return;

      // Progress does not finish the job, so the slot stays occupied.
      if (message.kind === 'progress') {
        if (slot.job?.id === message.id && message.progress) slot.job.onProgress?.(message.progress);
        return;
      }

      const job = slot.job;
      if (!job || job.id !== message.id) return;
      slot.job = null;

      if (message.ok) job.resolve(message.payload);
      else job.reject(this.toError(message.error));

      this.pump();
    });

    worker.addEventListener('error', (event: { message?: string }) => {
      // A worker-level failure orphans whatever it was running. Only THIS
      // worker's job is rejected — with one shared worker every in-flight job
      // had to be rejected, which turned one bad file into a failed batch.
      const failure =
        this.options.onWorkerError?.(event.message ?? 'The worker stopped without a message.') ??
        new Error(event.message ?? 'The worker stopped without a message.');

      const job = slot.job;
      slot.job = null;
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      worker.terminate();

      job?.reject(failure);
      this.pump();
    });

    this.slots.push(slot);
    return slot;
  }

  private toError(error: PoolMessage['error']): Error {
    if (!error) return new Error('The job failed without a reason.');
    return Object.assign(new Error(error.what), error);
  }
}

/**
 * How many workers this machine should run.
 *
 * `hardwareConcurrency` counts logical cores including hyper-threads, and the
 * UI thread needs one of them to stay responsive — which is the entire point of
 * using workers at all. So one is always left free.
 *
 * The cap of 8 is not about cores: each worker holds a whole file plus its
 * intermediate representation, and eight 400 MB point clouds in flight will
 * exhaust memory long before they exhaust CPU. Rule 17 asks for memory to be
 * designed for, and this is where that shows up.
 */
export function recommendedPoolSize(requested?: number): number {
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4;
  const available = Math.max(1, cores - 1);
  const wanted = requested && requested > 0 ? requested : available;
  return Math.max(1, Math.min(wanted, available, 8));
}
