/**
 * Job queue - generation only.
 *
 * Generation jobs run one at a time (a single local model is the bottleneck, so
 * queueing beats thrashing). Evaluation is NOT part of this queue: a job hands
 * its ideas to the ReviewQueue and immediately starts the next batch.
 *
 * Lifecycle: queued -> running (generating) -> reviewing (generation finished,
 * this job's backlog is still being scored) -> done. Stopping a job stops
 * generation; ideas already produced keep their place in the review queue,
 * because discarding the score of an idea that already exists is waste.
 */
import { emit } from '../lib/bus.js';
import { newId } from './ideas.js';
import { sleep, clamp } from '../lib/util.js';

export class JobManager {
  constructor({ engine, stats, reviews = null }) {
    this.engine = engine;
    this.stats = stats;
    this.reviews = reviews;
    this.jobs = new Map();
    this.queue = [];
    this.current = null;
  }

  /**
   * Called by the ReviewQueue the moment an idea is admitted. Counting here
   * rather than when a batch returns means a batch aborted mid-stream still
   * reports the ideas it actually produced - they exist and will be reviewed.
   */
  noteQueued(task) {
    const job = task?.jobId ? this.jobs.get(task.jobId) : null;
    if (!job || job.kind !== 'generate') return;
    job.generated++;
    emit('job:update', this.public(job));
  }

  /** Called by the ReviewQueue as each idea finishes scoring. */
  noteReview(task) {
    const job = task?.jobId ? this.jobs.get(task.jobId) : null;
    if (!job) return;
    if (task.ok) job.scored++;
    else job.reviewFailed++;
    emit('job:update', this.public(job));
    if (job.status === 'reviewing' && !this.reviews?.pendingFor(job.id)) {
      job.status = job.stopping ? 'stopped' : 'done';
      job.finishedAt = Date.now();
      emit('job:update', this.public(job));
      emit('stats', this.stats.summary());
    }
  }

  create(opts = {}) {
    const settings = this.engine.settings;
    const continuous = !!opts.continuous;
    const requested = continuous ? Infinity : clamp(Number(opts.count) || 1, 1, 500);
    const job = {
      id: newId('job'),
      kind: opts.kind || 'generate',
      status: 'queued',
      requested,
      continuous,
      count: requested,
      generated: 0,
      scored: 0,
      reviewFailed: 0,
      skipped: 0,
      failed: 0,
      batches: 0,
      category: opts.category || settings.pipeline?.category || 'any',
      mode: opts.mode || settings.pipeline?.mode || 'fast',
      model: opts.model || settings.model || null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      paused: false,
      stopping: false,
      action: opts.action || null,
      ideaId: opts.ideaId || null,
      batchLog: [],
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    emit('job:update', this.public(job));
    void this.#pump();
    return job;
  }

  public(job) {
    if (!job) return null;
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      requested: Number.isFinite(job.requested) ? job.requested : null,
      continuous: job.continuous,
      generated: job.generated,
      scored: job.scored,
      reviewFailed: job.reviewFailed,
      pendingReview: this.reviews?.pendingFor(job.id) || 0,
      skipped: job.skipped,
      failed: job.failed,
      batches: job.batches,
      category: job.category,
      mode: job.mode,
      model: job.model,
      action: job.action,
      ideaId: job.ideaId,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
      ideasPerMinute: job.generated ? Math.round((job.generated / Math.max(1, ((job.finishedAt || Date.now()) - job.startedAt) / 60000)) * 10) / 10 : 0,
      paused: job.paused,
      error: job.error,
      batchLog: job.batchLog.slice(-12),
    };
  }

  async #pump() {
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    job.status = 'running';
    job.controller = new AbortController();
    emit('job:update', this.public(job));
    try {
      if (job.kind === 'action') await this.#runAction(job);
      else await this.#runGenerate(job);
      if (job.status === 'running' || job.status === 'reviewing') job.status = job.stopping ? 'stopped' : 'done';
    } catch (err) {
      job.status = err?.message === 'aborted' ? 'stopped' : 'error';
      job.error = err?.message || String(err);
      if (job.status === 'error') console.error('[idealab] job failed:', job.error);
    } finally {
      job.finishedAt = Date.now();
      this.current = null;
      emit('job:update', this.public(job));
      emit('stats', this.stats.summary());
      void this.#pump();
    }
  }

  async #runAction(job) {
    const res = await this.engine.runAction(job.ideaId, job.action, { signal: job.controller.signal, model: job.model });
    job.scored = res.childIds?.length || (res.childId ? 1 : 0);
    job.batchLog.push({ at: Date.now(), action: job.action, ms: res.ms, children: job.scored });
    emit('job:update', this.public(job));
  }

  async #runGenerate(job) {
    const settings = this.engine.settings;
    const perCall = clamp(settings.performance?.ideasPerGenerationCall || 6, 1, 25);
    const continuousBatch = clamp(settings.pipeline?.continuousBatch || 10, 1, 50);

    while (!job.stopping) {
      while (job.paused && !job.stopping) await sleep(200);
      if (job.stopping) break;

      const remaining = job.continuous ? continuousBatch : Math.max(0, job.requested - job.generated);
      if (!job.continuous && remaining <= 0) break;
      const size = job.continuous ? continuousBatch : Math.min(perCall, remaining);

      const started = Date.now();
      try {
        const r = await this.engine.generateBatch({
          count: size,
          category: job.category,
          mode: job.mode,
          model: job.model,
          jobId: job.id,
          signal: job.controller.signal,
          shouldContinue: () => !job.stopping && !job.paused,
        });
        // job.generated is tallied by noteQueued as ideas are admitted, so a
        // batch aborted halfway still counts what it produced.
        job.skipped += r.skipped;
        job.batches++;
        job.model = r.model;
        job.batchLog.push({
          at: Date.now(),
          requested: size,
          generated: r.generated,
          skipped: r.skipped,
          ms: Math.round(Date.now() - started),
          model: r.model,
          tokensPerSec: r.usage?.tokensPerSec ?? null,
        });
      } catch (err) {
        if (err?.message === 'aborted' || job.stopping) break;
        job.failed++;
        job.error = err.message;
        emit('job:error', { jobId: job.id, error: err.message });
        if (!job.continuous) break; // a one-shot job dies loudly
        await sleep(1200); // continuous mode backs off and retries
      }
      emit('job:update', this.public(job));
      emit('stats', this.stats.summary());
    }

    // Generation is over. The ideas are already on the wall and the review
    // workers are scoring them; wait only so the job reports an honest end state.
    if (!job.stopping && this.reviews?.pendingFor(job.id)) {
      job.status = 'reviewing';
      emit('job:update', this.public(job));
      await this.reviews.settledFor(job.id);
    }
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20).map((j) => this.public(j));
  }

  active() {
    return this.current ? this.public(this.current) : null;
  }

  pause(id) {
    const job = id ? this.jobs.get(id) : this.current;
    if (!job) return null;
    job.paused = true;
    job.status = 'paused';
    emit('job:update', this.public(job));
    return this.public(job);
  }

  resume(id) {
    const job = id ? this.jobs.get(id) : this.current;
    if (!job) return null;
    job.paused = false;
    if (job.status === 'paused') job.status = 'running';
    emit('job:update', this.public(job));
    return this.public(job);
  }

  stop(id) {
    const job = id ? this.jobs.get(id) : this.current;
    if (!job) return null;
    job.stopping = true;
    job.paused = false;
    job.controller?.abort();
    // also drop queued-but-unstarted jobs
    this.queue = this.queue.filter((q) => q.id !== job.id);
    if (job.status === 'queued') {
      job.status = 'stopped';
      job.finishedAt = Date.now();
      emit('job:update', this.public(job));
    }
    return this.public(job);
  }

  stopAll() {
    for (const job of this.jobs.values()) if (job.status === 'running' || job.status === 'queued' || job.paused) this.stop(job.id);
  }
}
