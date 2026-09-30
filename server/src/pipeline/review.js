/**
 * The review queue: evaluation as an independent job stream.
 *
 * Generation and review are separate pipelines that meet only through this
 * queue. The generator's contract is "produce ideas and keep going" - it never
 * waits for an evaluation to come back. Ideas are persisted the moment they are
 * parsed out of the stream (so they appear on the wall immediately, unscored),
 * handed to this queue, and scored later by a pool of workers.
 *
 * Why a separate queue rather than just more concurrency inside a batch:
 *   - a batch that awaits its own evaluations stalls the next batch, so the
 *     model sits idle during every review. Decoupled, generation is continuous.
 *   - reviews outlive the job that produced them. Stopping generation does not
 *     throw away the score for ideas that already exist.
 *   - the backlog is visible and bounded: when review falls behind generation
 *     the queue throttles the generator instead of growing without limit.
 *
 * Abort semantics: the queue owns its own AbortController. A generation job's
 * signal is deliberately *not* forwarded here - aborting generation must not
 * abort the review of ideas that were already produced. In-flight reviews are
 * only aborted on shutdown or an explicit clear, and those ideas go back to
 * 'queued' so they are picked up again on the next boot (see rehydrate).
 */
import { emit } from '../lib/bus.js';
import { clamp, round1, sleep } from '../lib/util.js';
import { IdeaRepository } from './ideas.js';

/**
 * Batch gathering, at K>1 only.
 *
 * A worker waits for a batch to fill the way a debounce works: keep waiting while
 * ideas are still arriving, stop once they are not. Two bounds keep it honest.
 *
 *   BATCH_GATHER_IDLE_MS  stop waiting this long after the last arrival, so a
 *                         quiet queue fires a partial batch instead of stalling
 *   BATCH_GATHER_MAX_MS   never wait longer than this, whatever the arrival rate
 *
 * Batching earns its real keep when the review queue is deep - when evaluation
 * cannot keep up with generation - and then groups fill with no waiting at all.
 * These windows only catch ideas landing in the same burst. If your generator
 * produces an idea every couple of seconds and review keeps up, nothing will
 * batch and K=1 is simply the better setting: there is no backlog to amortise.
 */
const BATCH_GATHER_IDLE_MS = 150;
const BATCH_GATHER_MAX_MS = 750;

export class ReviewQueue {
  constructor({ engine, stats, getSettings = null, onDone = null, onEnqueue = null }) {
    this.engine = engine;
    this.stats = stats;
    this.getSettings = getSettings || (() => engine.settings);
    this.onDone = onDone;
    this.onEnqueue = onEnqueue;

    this.queue = []; // waiting tasks, FIFO
    this.inFlight = new Set(); // tasks currently being reviewed
    this.workers = 0; // live worker loops (>= inFlight while they spin down)
    this.paused = false;
    this.stopped = false;
    this.throttled = false;
    this.completed = 0;
    this.failed = 0;
    this.waitMs = [];
    this.controller = new AbortController();

    this.drainWaiters = [];
    this.jobWaiters = new Map();
    this.lastEnqueueAt = 0;
  }

  // ------------------------------------------------------------- settings --
  get concurrency() {
    return clamp(Math.round(this.getSettings()?.performance?.evaluateConcurrency || 3), 1, 16);
  }

  /**
   * EXPERIMENTAL: how many ideas one evaluator call may judge (1-4).
   * 1 = the default, one idea per call. Read live so the setting can be compared
   * without a restart.
   */
  get batchSize() {
    return clamp(Math.round(this.getSettings()?.performance?.evaluationsPerCall || 1), 1, 4);
  }

  /** How far review is allowed to fall behind generation before we throttle. */
  get maxDepth() {
    return clamp(Math.round(this.getSettings()?.performance?.maxReviewDepth ?? 120), 4, 100000);
  }

  /** Low-water mark: generation resumes once the backlog drains back to here. */
  get resumeDepth() {
    return Math.max(1, Math.round(this.maxDepth * 0.6));
  }

  get signal() {
    return this.controller.signal;
  }

  get active() {
    return this.inFlight.size;
  }

  get depth() {
    return this.queue.length;
  }

  isIdle() {
    return this.queue.length === 0 && this.inFlight.size === 0;
  }

  // ---------------------------------------------------------------- enqueue --
  /**
   * Accept an idea for review. Returns immediately - this is the whole point.
   * @returns {object} the task record
   */
  enqueue(idea, { mode = 'fast', model = '', jobId = null } = {}) {
    const task = {
      ideaId: idea.id,
      title: idea.title || '',
      mode,
      model: model || '',
      jobId: jobId || null,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      ok: false,
      overall: null,
      error: null,
    };
    this.queue.push(task);
    this.lastEnqueueAt = Date.now(); // the batch gather window debounces on this
    emit('review:queued', {
      ideaId: task.ideaId,
      jobId: task.jobId,
      depth: this.queue.length,
      active: this.inFlight.size,
    });
    try {
      this.onEnqueue?.(task);
    } catch {
      /* a listener must not break the queue */
    }
    this.#pump();
    this.#throttleState();
    return task;
  }

  /**
   * Re-queue ideas that were persisted but never reviewed (a crash, a stop, or a
   * shutdown mid-review). Called on boot so nothing is silently left unscored.
   */
  rehydrate(ideas = []) {
    let count = 0;
    for (const idea of ideas) {
      const state = idea.scoringState;
      if (state !== 'queued' && state !== 'scoring') continue;
      this.engine.repo.update(idea.id, { scoringState: 'queued' });
      idea.scoringState = 'queued';
      this.enqueue(idea, { mode: idea.mode || 'fast', model: idea.model || '', jobId: null });
      count++;
    }
    if (count) emit('review:rehydrated', { count });
    return count;
  }

  // ---------------------------------------------------------------- workers --
  #pump() {
    if (this.stopped) return;
    const want = this.concurrency;
    // A worker exits when the queue is empty, so keep exactly `want` alive while
    // there is work. Detached on purpose: the loop owns its own lifetime.
    while (this.workers < want && this.queue.length > 0) {
      this.workers++;
      void this.#worker().finally(() => {
        this.workers--;
        this.#pump();
        this.#notify();
      });
    }
  }

  async #worker() {
    for (;;) {
      if (this.stopped) return;
      while (this.paused && !this.stopped) await sleep(120);
      if (this.stopped) return;
      await this.#awaitBatchFill();
      // Shift and mark in flight in the same synchronous step: no yield between
      // them, so drain() can never see a task that is in neither place.
      const group = this.#takeGroup();
      if (!group.length) return;
      for (const task of group) this.inFlight.add(task);
      try {
        if (group.length === 1) await this.#run(group[0]);
        else await this.#runBatch(group);
      } finally {
        for (const task of group) this.inFlight.delete(task);
      }
      this.#pump();
      this.#notify();
    }
  }

  /**
   * Pull up to K tasks that can genuinely share one evaluator call.
   *
   * Only fast-mode tasks with the same model are grouped: a deep pass stays
   * per-idea (it is several calls with its own bounded concurrency), and one call
   * can only ever go to one model. At K=1 this is exactly the old behaviour.
   */
  /**
   * Batching only pays off if the group actually fills, and ideas arrive in
   * bursts, so at K>1 a worker waits a bounded moment for the rest of the burst.
   *
   * Tasks stay in the queue during the wait, so drain() and the backpressure
   * accounting still see them. This is a separate method from #takeGroup on
   * purpose: #takeGroup must stay synchronous, because an await between shifting
   * a task off the queue and adding it to inFlight would leave it invisible to
   * drain(), which could then resolve while work was still outstanding.
   */
  async #awaitBatchFill() {
    const k = this.batchSize;
    if (k <= 1 || this.stopped || this.paused) return;
    const batchable = (task) => task.mode === 'fast';
    const first = this.queue.find(batchable);
    if (!first) return;
    const ready = () => this.queue.filter((task) => this.#canShare(task, first)).length;
    if (ready() >= k) return; // deep queue: the batch is already full
    const deadline = Date.now() + BATCH_GATHER_MAX_MS;
    while (!this.stopped && !this.paused && Date.now() < deadline && ready() < k) {
      if (Date.now() - this.lastEnqueueAt > BATCH_GATHER_IDLE_MS) return; // arrivals stopped
      await sleep(15);
    }
  }

  /** Can these two tasks be judged in one evaluator call? Same mode, same model. */
  #canShare(task, like) {
    return task.mode === 'fast' && like?.mode === 'fast' && (task.model || '') === (like.model || '');
  }

  #takeGroup() {
    const k = this.batchSize;
    const first = this.queue.shift();
    if (!first) return [];
    if (k <= 1 || first.mode !== 'fast') return [first];
    const group = [first];
    for (let i = 0; i < this.queue.length && group.length < k; ) {
      if (this.#canShare(this.queue[i], first)) group.push(this.queue.splice(i, 1)[0]);
      else i++;
    }
    return group;
  }

  /**
   * Batched review: one model call for up to K ideas, then the same per-idea
   * finishing, failure marking and events as the single-idea path. scoreMany()
   * falls back to single-idea calls for anything the batch did not return, so a
   * bad batch costs extra tokens rather than K lost ideas.
   */
  async #runBatch(group) {
    const startedAt = Date.now();
    const tasks = [];
    for (const task of group) {
      const idea = this.engine.repo.get(task.ideaId);
      if (!idea) {
        this.#finish(task, { ok: false, error: 'idea no longer exists' });
        continue;
      }
      task.startedAt = startedAt;
      const waitedMs = startedAt - task.queuedAt;
      this.waitMs.push(waitedMs);
      if (this.waitMs.length > 400) this.waitMs.shift();
      this.stats?.recordReviewWait?.({ ms: waitedMs, mode: task.mode });
      emit('review:start', {
        ideaId: task.ideaId,
        jobId: task.jobId,
        waitedMs,
        depth: this.queue.length,
        active: this.inFlight.size,
        batch: group.length,
      });
      tasks.push({ task, idea });
    }
    if (!tasks.length) return;

    try {
      const res = await this.engine.scoreMany(
        tasks.map((t) => t.idea),
        { model: tasks[0].task.model, signal: this.signal, mode: 'fast' },
      );
      tasks.forEach(({ task, idea }, i) => {
        const r = res.results?.[i];
        const ok = !!r?.ok && idea.scoringState !== 'failed';
        if (!ok && idea.scoringState !== 'failed') {
          idea.scoringState = 'failed';
          idea.error = r?.error || 'batched evaluation returned nothing for this idea';
          this.engine.repo.update(task.ideaId, { scoringState: 'failed', error: idea.error });
          this.stats?.recordEvaluation?.({ failed: true, model: task.model, ms: 0 });
          emit('idea:updated', { card: IdeaRepository.card(idea), error: idea.error, jobId: task.jobId });
        }
        this.#finish(task, { ok, overall: idea.score?.overall ?? null, error: ok ? null : idea.error || r?.error || 'evaluation failed' });
      });
    } catch (err) {
      const aborted = err?.message === 'aborted' || this.signal.aborted;
      for (const { task, idea } of tasks) this.#fail(task, idea, err, aborted);
    }
  }

  /** Shared abort/failure handling, so batched and single review behave alike. */
  #fail(task, idea, err, aborted) {
    if (aborted) {
      // Interrupted, not broken: leave it pending so a restart picks it up.
      idea.scoringState = 'queued';
      delete idea.error;
      this.engine.repo.update(task.ideaId, { scoringState: 'queued', error: null });
      emit('idea:updated', { card: IdeaRepository.card(idea), jobId: task.jobId });
    } else {
      idea.scoringState = 'failed';
      idea.error = err.message;
      this.engine.repo.update(task.ideaId, { scoringState: 'failed', error: err.message });
      this.stats?.recordEvaluation?.({ failed: true, model: task.model, ms: 0 });
      emit('idea:updated', { card: IdeaRepository.card(idea), error: err.message, jobId: task.jobId });
    }
    this.#finish(task, { ok: false, error: aborted ? 'aborted' : err.message, aborted });
  }

  async #run(task) {
    const idea = this.engine.repo.get(task.ideaId);
    if (!idea) {
      this.#finish(task, { ok: false, error: 'idea no longer exists' });
      return;
    }
    task.startedAt = Date.now();
    const waitedMs = task.startedAt - task.queuedAt;
    this.waitMs.push(waitedMs);
    if (this.waitMs.length > 400) this.waitMs.shift();
    this.stats?.recordReviewWait?.({ ms: waitedMs, mode: task.mode });
    emit('review:start', {
      ideaId: task.ideaId,
      jobId: task.jobId,
      waitedMs,
      depth: this.queue.length,
      active: this.inFlight.size,
    });

    try {
      await this.engine.score(idea, { model: task.model, signal: this.signal, mode: task.mode });
      // Deep work belongs to review, not generation - and only for ideas the
      // generator produced. Derived children are scored, never deep-passed.
      if (task.mode === 'deep' && (idea.origin || 'generated') === 'generated' && idea.scoringState !== 'failed') {
        await this.engine.deepLimiter(() => this.engine.deepPass(idea, { signal: this.signal }));
      }
      this.#finish(task, {
        ok: idea.scoringState !== 'failed',
        overall: idea.score?.overall ?? null,
        error: idea.error || null,
      });
    } catch (err) {
      this.#fail(task, idea, err, err?.message === 'aborted' || this.signal.aborted);
    }
  }

  #finish(task, { ok, overall = null, error = null, aborted = false } = {}) {
    task.finishedAt = Date.now();
    task.ok = !!ok;
    task.overall = overall;
    task.error = error;
    if (ok) this.completed++;
    else if (!aborted) this.failed++;
    emit('review:done', {
      ideaId: task.ideaId,
      jobId: task.jobId,
      ok: !!ok,
      aborted,
      overall,
      error,
      ms: task.startedAt ? task.finishedAt - task.startedAt : 0,
      depth: this.queue.length,
      active: this.inFlight.size,
    });
    try {
      this.onDone?.(task);
    } catch {
      /* a listener must not break the queue */
    }
    this.#throttleState();
  }

  // ---------------------------------------------------------- coordination --
  #notify() {
    if (this.isIdle() || this.stopped) {
      const waiters = this.drainWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
    for (const [jobId, list] of [...this.jobWaiters]) {
      if (!this.#hasJobWork(jobId)) {
        this.jobWaiters.delete(jobId);
        for (const resolve of list.splice(0)) resolve();
      }
    }
  }

  #hasJobWork(jobId) {
    if (!jobId) return false;
    return this.queue.some((t) => t.jobId === jobId) || [...this.inFlight].some((t) => t.jobId === jobId);
  }

  /** Queued + running reviews belonging to one job (for job progress display). */
  pendingFor(jobId) {
    if (!jobId) return 0;
    return this.queue.filter((t) => t.jobId === jobId).length + [...this.inFlight].filter((t) => t.jobId === jobId).length;
  }

  #throttleState() {
    const over = this.queue.length >= this.maxDepth;
    if (over && !this.throttled) {
      this.throttled = true;
      emit('review:throttled', { depth: this.queue.length, maxDepth: this.maxDepth, resumeDepth: this.resumeDepth });
    } else if (!over && this.throttled && this.queue.length < this.resumeDepth) {
      this.throttled = false;
      emit('review:resumed', { depth: this.queue.length, resumeDepth: this.resumeDepth });
    }
  }

  /**
   * Backpressure for the generator. Resolves immediately unless review has fallen
   * `maxDepth` behind, in which case generation waits for the low-water mark so
   * the backlog cannot grow without bound.
   */
  async waitForCapacity(signal = null) {
    if (this.stopped || this.queue.length < this.maxDepth) return true;
    if (!this.throttled) this.#throttleState();
    while (!this.stopped && this.queue.length >= this.resumeDepth) {
      if (signal?.aborted) return false;
      await sleep(120);
    }
    return true;
  }

  /** Resolves when nothing is queued or running. Used by tests and by jobs. */
  async drain() {
    if (this.isIdle() || this.stopped) return;
    await new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  /** Resolves when a specific job's ideas have all been reviewed. */
  async settledFor(jobId) {
    if (!jobId) return this.drain();
    if (!this.#hasJobWork(jobId)) return;
    await new Promise((resolve) => {
      const list = this.jobWaiters.get(jobId) || [];
      list.push(resolve);
      this.jobWaiters.set(jobId, list);
    });
  }

  // ----------------------------------------------------------------- controls --
  pause() {
    this.paused = true;
    emit('review:paused', this.snapshot());
    return this.snapshot();
  }

  resume() {
    this.paused = false;
    if (this.stopped) this.start(); // restart the worker pool after a shutdown
    this.#pump();
    emit('review:resumed', this.snapshot());
    return this.snapshot();
  }

  /** Drop the backlog. Ideas stay 'queued' so requeue()/a restart can pick them up. */
  clear() {
    const dropped = this.queue.length;
    for (const task of this.queue) {
      const idea = this.engine.repo.get(task.ideaId);
      if (idea) this.engine.repo.update(task.ideaId, { scoringState: 'queued' });
    }
    this.queue = [];
    this.throttled = false;
    emit('review:cleared', { dropped });
    this.#notify();
    return { dropped };
  }

  /** Put every pending idea back in the queue (after a clear, or a stuck backlog). */
  requeue() {
    const pending = this.engine.repo.all().filter((i) => i.scoringState === 'queued' || i.scoringState === 'scoring');
    const known = new Set([...this.queue.map((t) => t.ideaId), ...[...this.inFlight].map((t) => t.ideaId)]);
    let added = 0;
    for (const idea of pending) {
      if (known.has(idea.id)) continue;
      this.enqueue(idea, { mode: idea.mode || 'fast', model: idea.model || '', jobId: null });
      added++;
    }
    return { added, depth: this.queue.length };
  }

  /** Abort in-flight reviews and stop the pool (shutdown). */
  stop({ clearBacklog = true } = {}) {
    this.stopped = true;
    this.controller.abort();
    if (clearBacklog) this.queue = [];
    const waiters = this.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
    for (const [, list] of this.jobWaiters) for (const resolve of list.splice(0)) resolve();
    this.jobWaiters.clear();
  }

  /** Start the pool again after stop() (used by resume and by tests). */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.controller = new AbortController();
    this.#pump();
  }

  syncConcurrency() {
    this.#pump();
  }

  snapshot({ limit = 12 } = {}) {
    return {
      depth: this.queue.length,
      active: this.inFlight.size,
      concurrency: this.concurrency,
      // Experimental batching: ideas judged per evaluator call (1 = default).
      batchSize: this.batchSize,
      maxDepth: this.maxDepth,
      resumeDepth: this.resumeDepth,
      paused: this.paused,
      throttled: this.throttled,
      stopped: this.stopped,
      completed: this.completed,
      failed: this.failed,
      avgWaitMs: this.waitMs.length ? round1(this.waitMs.reduce((a, b) => a + b, 0) / this.waitMs.length) : 0,
      lastWaitMs: this.waitMs.length ? this.waitMs[this.waitMs.length - 1] : 0,
      next: this.queue.slice(0, limit).map((t) => ({
        ideaId: t.ideaId,
        title: t.title,
        mode: t.mode,
        jobId: t.jobId,
        waitedMs: Date.now() - t.queuedAt,
      })),
      running: [...this.inFlight].slice(0, limit).map((t) => ({
        ideaId: t.ideaId,
        title: t.title,
        mode: t.mode,
        jobId: t.jobId,
        ms: t.startedAt ? Date.now() - t.startedAt : 0,
      })),
    };
  }
}
