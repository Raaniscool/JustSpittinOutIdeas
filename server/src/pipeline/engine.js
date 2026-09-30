/**
 * IdeaEngine - the pipeline.
 *
 * Throughput design (this is the part that makes IdeaLab feel fast):
 *
 *   generate(batch, streamed)  --\
 *                                 >-- idea #1 lands -> evaluation starts NOW
 *   idea #2 lands ---------------/    (no waiting for the rest of the batch)
 *   idea #3 lands --> evaluation starts (up to N concurrent evaluations)
 *
 *  - one model call produces a batch of ideas, streamed and parsed item by item
 *  - evaluation of independent ideas runs concurrently
 *  - identical or near-identical ideas reuse a previous evaluation instead of
 *    burning a model call
 *  - the system prompt is constant so Ollama's prompt KV cache is reused
 *  - the model is preloaded once and kept resident (keep_alive)
 *  - fast mode = 2 calls per idea (generate + evaluate)
 *    deep mode = generate + evaluate + attack (+ improve & re-evaluate when the
 *    idea is good enough to be worth the tokens)
 */
import { performance } from 'node:perf_hooks';
import { ROLES } from '../prompts/roles.js';
import { GENERATE_SCHEMA, EVALUATE_SCHEMA, batchEvaluateSchema, ATTACK_SCHEMA, IMPROVE_SCHEMA, MUTATE_SCHEMA, DEVELOP_SCHEMA, RESEARCH_SCHEMA } from '../prompts/schemas.js';
import {
  buildGeneratePrompt,
  buildEvaluatePrompt,
  buildBatchEvaluatePrompt,
  buildAttackPrompt,
  buildImprovePrompt,
  buildMutatePrompt,
  buildDevelopPrompt,
  buildResearchPrompt,
  formatSeed,
} from '../prompts/build.js';
import { getProvider, ProviderError } from '../providers/index.js';
import { auditEvaluation, computeOverall, normalizeWeights, scoreColor, scoreGrade } from './scoring.js';
import { newId, IdeaRepository } from './ideas.js';
import { TtlCache, createLimiter, sleep, clamp } from '../lib/util.js';
import { emit } from '../lib/bus.js';
import { PROMPT_VERSION, CATEGORIES } from '../config.js';

const CATEGORY_ALIASES = {
  'dev tools': 'developer-tools',
  devtools: 'developer-tools',
  developer: 'developer-tools',
  'machine learning': 'ai',
  ml: 'ai',
  'consumer products': 'consumer',
  'consumer product': 'consumer',
  b2b: 'business',
  'business services': 'business',
  edtech: 'education',
  'learning': 'education',
  sci: 'science',
  'research projects': 'research',
  eng: 'engineering',
  'hardware': 'engineering',
  robots: 'engineering',
  robotics: 'engineering',
  automation: 'automation',
  productivity: 'productivity',
  weird: 'weird',
  unusual: 'weird',
  strange: 'weird',
  other: 'weird',
};

export function normalizeCategory(raw) {
  const c = String(raw || '').trim().toLowerCase();
  if (CATEGORIES.includes(c) && c !== 'any') return c;
  const direct = CATEGORY_ALIASES[c];
  if (direct) return direct;
  const slug = c.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (CATEGORIES.includes(slug)) return slug;
  if (CATEGORY_ALIASES[slug]) return CATEGORY_ALIASES[slug];
  for (const [alias, target] of Object.entries(CATEGORY_ALIASES)) {
    if (slug.includes(alias.replace(/\s+/g, ''))) return target;
  }
  return 'software';
}

const clip = (v, n) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);

export function normalizeIdea(raw = {}) {
  const idea = {
    title: clip(raw.title, 140),
    description: clip(raw.description, 1200),
    category: normalizeCategory(raw.category),
    problem: clip(raw.problem, 500),
    mechanism: clip(raw.mechanism, 600),
    targetUser: clip(raw.targetUser, 240),
    businessModel: clip(raw.businessModel, 240),
    distribution: clip(raw.distribution, 240),
    unusual: !!raw.unusual,
  };
  if (!idea.title) idea.title = idea.description.slice(0, 60) || 'Untitled idea';
  return idea;
}

/** Garbage filter: a "idea" with no substance must not pollute the wall. */
export function isViableIdea(idea) {
  if (!idea.title || idea.title.length < 6) return false;
  if (!idea.description || idea.description.length < 25) return false;
  if (/^(untitled|idea|test|lorem|n\/?a|todo)$/i.test(idea.title)) return false;
  return true;
}

export class IdeaEngine {
  /**
   * @param {object} deps
   * @param {import('../lib/store.js').JsonStore} deps.settingsStore
   * @param {import('./ideas.js').IdeaRepository} deps.repo
   * @param {import('../knowledge/bank.js').KnowledgeBank} deps.bank
   * @param {import('./stats.js').StatsCollector} deps.stats
   * @param {import('./calibration.js').CalibrationMonitor} deps.calibration
   * @param {import('./bias.js').BiasMonitor} deps.bias
   */
  constructor(deps) {
    this.settingsStore = deps.settingsStore;
    this.repo = deps.repo;
    this.bank = deps.bank;
    this.stats = deps.stats;
    this.calibration = deps.calibration;
    this.bias = deps.bias;

    this.evalCache = new TtlCache({ max: 8000, ttlMs: deps.settingsStore.data?.performance?.evalCacheTtlMs || 1000 * 60 * 60 * 12 });
    this.evalLimiter = createLimiter(this.settings.performance?.evaluateConcurrency || 3);
    this.limiterConcurrency = this.settings.performance?.evaluateConcurrency || 3;
    // Deep passes run outside the evaluation pool (see ingest), so they get their
    // own bound: attack+improve per idea must not become a burst of unbounded
    // concurrent requests against a local model that serialises anyway.
    this.deepLimiter = createLimiter(this.deepConcurrency());
    this.limiterDeepConcurrency = this.deepConcurrency();
    this.reviews = null; // wired in app.js: evaluation runs on its own queue
    this._loadedModel = null;
    this._modelCache = { at: 0, model: null };
    this.inFlight = 0;
  }

  get settings() {
    return this.settingsStore.data;
  }

  deepConcurrency() {
    const want = this.settings.performance?.deepConcurrency;
    const n = Number.isFinite(Number(want)) && Number(want) > 0 ? Number(want) : 2;
    return Math.max(1, Math.min(n, this.settings.performance?.evaluateConcurrency || 3));
  }

  /** Rebuild the concurrency limiters when the user changes them. */
  syncConcurrency() {
    const want = this.settings.performance?.evaluateConcurrency || 3;
    if (want !== this.limiterConcurrency) {
      this.limiterConcurrency = want;
      this.evalLimiter = createLimiter(want);
    }
    const wantDeep = this.deepConcurrency();
    if (wantDeep !== this.limiterDeepConcurrency) {
      this.limiterDeepConcurrency = wantDeep;
      this.deepLimiter = createLimiter(wantDeep);
    }
  }

  provider() {
    return getProvider(this.settings.provider || 'ollama');
  }

  /**
   * Which model to use: an explicit request (per job / per action) wins, then the
   * configured default, then the first model the provider reports.
   */
  async resolveModel(explicit = '') {
    const wanted = typeof explicit === 'string' ? explicit.trim() : explicit;
    if (wanted) return wanted;
    const configured = this.settings.model;
    if (configured) return configured;
    if (this._modelCache.model && Date.now() - this._modelCache.at < 30000) return this._modelCache.model;
    try {
      const models = await this.provider().listModels();
      // Default to the smallest installed model: for high-volume scanning,
      // throughput beats capability.
      const best = models[0] || null;
      this._modelCache = { at: Date.now(), model: best?.id || null };
      return best?.id || null;
    } catch {
      return null;
    }
  }

  weights() {
    return normalizeWeights(this.settings.scoring?.weights || {});
  }

  /** Token/temperature budget per *kind of work*, not per model. */
  budgetFor(budget = 'evaluate', override) {
    const p = this.settings.performance || {};
    const base = {
      generate: { temperature: p.temperatureGenerate ?? 1.0, maxTokens: p.maxTokensGenerate ?? 1400, numCtx: p.numCtxGenerate ?? 3072 },
      evaluate: { temperature: p.temperatureEvaluate ?? 0.2, maxTokens: p.maxTokensEvaluate ?? 900, numCtx: p.numCtxEvaluate ?? 2048 },
      deep: { temperature: 0.6, maxTokens: p.maxTokensDeep ?? 1200, numCtx: p.numCtxDeep ?? 3072 },
      meta: { temperature: 0.3, maxTokens: 700, numCtx: 2048 },
      extract: { temperature: 0.3, maxTokens: 1200, numCtx: 3072 },
    };
    return { ...(base[budget] || base.evaluate), ...(override || {}) };
  }

  /** Single funnel for every model call: timing, retries, stats. */
  async callModel({ role, schema, prompt, budget = 'evaluate', budgetOverride, signal, onToken, onItem, itemArrayKey, model: requestedModel = '' }) {
    const provider = this.provider();
    const model = await this.resolveModel(requestedModel);
    const system = ROLES[role] || ROLES.evaluator;
    const opts = this.budgetFor(budget, budgetOverride);
    let emitted = 0;
    const wrappedOnItem = onItem
      ? (item) => {
          emitted++;
          onItem(item);
        }
      : undefined;

    let attempt = 0;
    const started = performance.now();
    // Keep the model resident: pay the load cost once per model switch.
    if (model && this._loadedModel !== model && provider.capabilities?.preload) {
      this._loadedModel = model;
      provider.preload(model).catch(() => {});
    }

    for (;;) {
      try {
        const res = await provider.complete({
          role,
          model,
          system,
          prompt,
          schema,
          signal,
          onToken,
          onItem: wrappedOnItem,
          itemArrayKey,
          ...opts,
        });
        this.stats.recordCall({});
        return { ...res, ms: performance.now() - started, model: res.model || model, providerId: provider.id };
      } catch (err) {
        const aborted = err?.message === 'aborted' || signal?.aborted;
        this.stats.recordCall({ failed: true, retry: attempt === 0 && !aborted });
        if (aborted) throw err;
        const retryable = err?.retryable === true || /timeout|ECONNRESET|socket hang up|503|502|busy/i.test(err?.message || '');
        if (attempt < 1 && retryable && emitted === 0) {
          attempt++;
          await sleep(400 * attempt);
          continue;
        }
        throw err instanceof ProviderError ? err : new ProviderError(err?.message || 'Model call failed', { cause: err });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Generation
  // -----------------------------------------------------------------------

  /**
   * Generate `count` ideas and evaluate them as they stream in.
   * @returns {Promise<{requested:number, generated:number, scored:number, skipped:number, ms:number, model:string}>}
   */
  async generateBatch({
    count = 6,
    category = 'any',
    mode = 'fast',
    jobId = null,
    signal,
    model: requestedModel = '',
    shouldContinue = () => true,
  } = {}) {
    const started = performance.now();
    const s = this.settings;
    const provider = this.provider();
    const model = await this.resolveModel(requestedModel);
    if (!model) {
      throw new ProviderError(
        this.settings.provider === 'demo'
          ? 'Demo provider has no model selected.'
          : 'No Ollama model found. Install one (e.g. `ollama pull qwen3:1.7b`) or pick a model in the header.',
        { code: 'no-model' },
      );
    }

    // Knowledge Bank recombination seeds (deliberate component mixing).
    const seeds = [];
    const touched = [];
    if (s.pipeline?.recombination !== false) {
      const combos = clamp(Math.ceil(count / 3), 1, 6);
      for (let i = 0; i < combos; i++) {
        const { combo, entries } = this.bank.sampleCombo();
        if (Object.keys(combo).length >= 2) {
          seeds.push(formatSeed(combo));
          touched.push(...entries);
        }
      }
    }

    const prompt = buildGeneratePrompt({
      count,
      category,
      seeds,
      directives: this.bias.directives(),
      recentTitles: this.repo.recentTitles(24),
      mode,
    });

    // Backpressure: if review has fallen maxDepth behind, wait for the backlog to
    // drain to the low-water mark before spending more tokens on ideas nobody has
    // scored yet. Under normal load this resolves immediately.
    if (!(await this.reviews.waitForCapacity(signal))) throw new ProviderError('aborted', { code: 'aborted' });

    let streamed = 0;
    let skipped = 0;
    let queued = 0;

    const res = await this.callModel({
      role: 'generator',
      schema: GENERATE_SCHEMA,
      prompt,
      budget: 'generate',
      model,
      signal,
      itemArrayKey: 'ideas',
      onItem: (raw) => {
        if (!shouldContinue()) return;
        streamed++;
        const idea = normalizeIdea(raw);
        if (!isViableIdea(idea)) {
          skipped++;
          return;
        }
        // Fire and forget: the idea is on the wall and in the review queue.
        this.admit(idea, { jobId, model, providerId: provider.id, mode });
        queued++;
      },
    });

    // Fallback for providers/builds that did not stream items.
    if (!streamed) {
      const items = Array.isArray(res.object?.ideas) ? res.object.ideas : Array.isArray(res.items) ? res.items : [];
      for (const raw of items) {
        const idea = normalizeIdea(raw);
        if (!isViableIdea(idea)) {
          skipped++;
          continue;
        }
        streamed++;
        this.admit(idea, { jobId, model, providerId: provider.id, mode });
        queued++;
      }
    }

    this.stats.recordGeneration({ ms: performance.now() - started, model, count: streamed, usage: res.usage });
    this.bank.recordUsage(touched);
    if (touched.length) emit('knowledge:usage', { count: touched.length });

    // No awaiting reviews here. That is the entire point of the split: the next
    // batch starts as soon as this one has been generated.

    // Cheap, throttled housekeeping: bias check without blocking generation.
    void this.bias.maybeAnalyze({ signal }).then((report) => {
      if (report && !report.error) emit('bias:update', this.bias.report());
    });

    return {
      requested: count,
      generated: streamed,
      queued,
      scored: 0, // reviews are asynchronous now; the job queue tallies these
      skipped,
      ms: performance.now() - started,
      model,
      providerId: provider.id,
      usage: res.usage,
      seeds,
    };
  }

  /**
   * Take one normalized idea and hand it to the review queue.
   *
   * This is deliberately NOT async work: the idea is persisted (so it lands on
   * the wall immediately, marked as awaiting review) and queued, then we return.
   * Scoring happens later on the review workers. The generator never waits here.
   */
  admit(idea, { jobId = null, model = '', providerId = '', mode = 'fast', origin = 'generated', parentId = null } = {}) {
    const record = {
      id: newId(),
      ...idea,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model,
      provider: providerId,
      mode,
      origin,
      parentId,
      jobId,
      status: 'new',
      starred: false,
      tags: [],
      notes: '',
      scoringState: 'queued',
      evaluation: null,
      score: null,
      similar: [],
      duplicateOf: null,
      analysis: {},
      metrics: {},
      timings: {},
    };
    record.contentKey = this.repo.contentKey(record);
    record.metrics.unusualness = this.repo.unusualness(record);
    if (origin !== 'generated') this.stats.recordDerived({ model });
    this.repo.add(record);
    emit('idea:new', { card: IdeaRepository.card(record), jobId });

    this.reviews.enqueue(record, { mode, model, jobId });
    return { ok: true, id: record.id, queued: true, overall: null };
  }

  /**
   * Admit an idea and wait for its review to finish. Only for callers that
   * genuinely need the score in hand (tests, one-off scripted work) - the
   * generation path must never use this.
   */
  async admitAndWait(idea, opts = {}) {
    const { id } = this.admit(idea, opts);
    const task = this.reviews.queue.find((t) => t.ideaId === id) || [...this.reviews.inFlight].find((t) => t.ideaId === id);
    if (task) {
      await new Promise((resolve) => {
        const check = () => {
          if (task.finishedAt) return resolve();
          setTimeout(check, 20);
        };
        check();
      });
    } else {
      await this.reviews.drain();
    }
    const record = this.repo.get(id);
    return { ok: record?.scoringState === 'scored', id, overall: record?.score?.overall ?? null, error: record?.error };
  }

  /**
   * Fast-mode evaluation: one independent evaluator call per idea, with
   * cache + near-duplicate reuse to avoid unnecessary model calls.
   */
  /**
   * Where a raw judgment comes from: the eval cache, an already-scored
   * near-duplicate, or (null) a model call. Shared by score() and scoreMany() so
   * batching can never accidentally bypass the reuse shortcuts.
   */
  #lookup(idea, { model, cacheKey, force = false }) {
    const s = this.settings;
    if (!force) {
      const cached = this.evalCache.get(cacheKey);
      if (cached) return { raw: cached, reuse: { kind: 'cache' } };
    }
    if (!force && s.performance?.reuseEvaluationForNearDuplicates !== false) {
      const threshold = s.performance?.nearDuplicateEvalThreshold ?? 0.9;
      const similar = this.repo.index.findSimilar(idea, { limit: 4 });
      const twin = similar
        .map((sim) => ({ sim, idea: this.repo.get(sim.id) }))
        .find(({ sim, idea: other }) => sim.similarity >= threshold && other?.evaluation?.raw);
      if (twin) return { raw: twin.idea.evaluation.raw, reuse: { kind: 'near-duplicate', fromId: twin.idea.id, similarity: twin.sim.similarity } };
    }
    return { raw: null, reuse: null };
  }

  evalCacheKey(idea, model) {
    const weights = this.weights();
    const weightsKey = Object.values(weights).map((w) => w.toFixed(3)).join(',');
    return `${model}|${PROMPT_VERSION}|${idea.contentKey}|${weightsKey}`;
  }

  /**
   * THE safeguard path. Every judgment - single or batched - is turned into a
   * stored evaluation here and nowhere else, so the calibration audit, the
   * programmatic overall, dedupe, unusualness and stats behave identically
   * regardless of how many ideas shared a model call. Sync on purpose: it is safe
   * to run from inside a streaming callback.
   */
  #applyEvaluation(idea, raw, { model, reuse = null, usage = null, callMs = 0, started = performance.now(), batch = 1, statMs } = {}) {
    const s = this.settings;
    const pressure = this.calibration.pressure();
    const audited = auditEvaluation(raw, s.scoring?.calibration || {}, pressure);
    const { overall, contributions, incomplete, warnings } = computeOverall(audited.factors, this.weights());

    const evaluation = {
      raw,
      factors: audited.factors,
      justifications: audited.justifications,
      evidence: audited.evidence,
      adjustments: audited.adjustments,
      warnings: [...warnings, ...audited.warnings],
      biggestStrength: clip(raw.biggestStrength, 400),
      biggestWeakness: clip(raw.biggestWeakness, 400),
      whyNotHigher: clip(raw.whyNotHigher, 500),
      priorArt: (raw.priorArt || []).map((p) => clip(p, 160)).filter(Boolean).slice(0, 8),
      summary: clip(raw.summary, 400),
      verdict: raw.verdict || '',
      pressure,
      reuse,
      batch: batch > 1 ? batch : null,
      evaluatedAt: Date.now(),
      model,
      usage,
    };

    const ms = performance.now() - started;
    this.repo.update(idea.id, {
      evaluation,
      score: { overall, contributions, grade: scoreGrade(overall), color: scoreColor(overall), incomplete },
      scoringState: 'scored',
      timings: { ...(idea.timings || {}), evalMs: Math.round(callMs || ms), evalCallMs: Math.round(callMs || 0), evaluatedAt: Date.now() },
    });
    this.repo.markDuplicates(idea, { enabled: s.pipeline?.dedupe !== false });
    idea.metrics.unusualness = this.repo.unusualness(idea);
    this.repo.update(idea.id, { similar: idea.similar, duplicateOf: idea.duplicateOf, metrics: idea.metrics });

    this.calibration.record(overall, { model });
    // statMs === null means "the caller will charge this idea's share of the model
    // time later" - used by batched calls, where the real cost is unknown until
    // the shared call finishes. Charging 0 instead would make K>1 look free in
    // avgEvaluationMs, which is exactly the number the K comparison depends on.
    const stat = { model, overall, usage, cacheHit: reuse?.kind === 'cache', duplicateSkip: reuse?.kind === 'near-duplicate' };
    if (statMs !== null) this.stats.recordEvaluation({ ms: statMs ?? (batch > 1 ? (callMs || ms) / batch : ms), ...stat });
    emit('idea:scored', { card: IdeaRepository.card(idea), jobId: idea.jobId });
    return { ok: true, overall, ms, stat };
  }

  /** Evaluate one idea. The default, and the calibrated path. */
  async score(idea, { model: requestedModel = '', signal, mode = 'fast', force = false } = {}) {
    const started = performance.now();
    // Resolve once, before anything keys off it, so the model recorded on the
    // evaluation is the model that actually produced it: an idea generated by an
    // explicit per-job model must not be evaluated by whatever the global default
    // happens to be now.
    const model = await this.resolveModel(requestedModel || idea.model || '');
    const cacheKey = this.evalCacheKey(idea, model);

    idea.scoringState = 'scoring';
    this.repo.update(idea.id, { scoringState: 'scoring' });

    const found = this.#lookup(idea, { model, cacheKey, force });
    let { raw, reuse } = found;

    let usage = null;
    let callMs = 0;
    if (!raw) {
      const prompt = buildEvaluatePrompt(idea, { calibrationDirective: this.calibration.directive() });
      const res = await this.callModel({ role: 'evaluator', schema: EVALUATE_SCHEMA, prompt, budget: 'evaluate', model, signal });
      raw = res.object;
      usage = res.usage;
      callMs = res.ms;
      if (!raw || !raw.factors) throw new ProviderError('Evaluator returned no factor scores', { code: 'bad-eval' });
      this.evalCache.set(cacheKey, raw);
      // Counted here rather than in callModel so cache/near-duplicate reuse is not
      // charged as a call: evalCalls means "evaluator calls we actually paid for".
      this.stats.noteEvalCall({ ms: res.ms, ideas: 1 });
    }
    return this.#applyEvaluation(idea, raw, { model, reuse, usage, callMs, started });
  }

  /**
   * EXPERIMENTAL throughput lever: judge up to K ideas in one model call.
   *
   * Deliberately conservative. Only the model call is shared - the audit, the
   * deterministic overall, dedupe and calibration all still run per idea through
   * #applyEvaluation, and the prompt forbids comparing the ideas. Anything the
   * batch does not return falls back to its own single-idea call, so one bad
   * batch costs at most extra tokens, not K lost ideas.
   *
   * Returns { ok, results, perIdea, ms, calls, fallbacks } - never throws for a
   * single idea's failure; per-idea errors land in results[i].error.
   */
  async scoreMany(ideas = [], { model: requestedModel = '', signal, mode = 'fast', force = false } = {}) {
    const list = ideas.filter(Boolean);
    if (list.length === 0) return { ok: true, results: [], perIdea: [], ms: 0, calls: 0, fallbacks: 0 };
    if (list.length === 1) {
      const r = await this.score(list[0], { model: requestedModel, signal, mode, force }).catch((err) => ({ ok: false, error: err?.message || String(err) }));
      return { ok: !!r.ok, results: [r], perIdea: [list[0].id], ms: r.ms || 0, calls: 1, fallbacks: 0 };
    }

    const started = performance.now();
    const model = await this.resolveModel(requestedModel || list[0].model || '');
    const perf = this.settings.performance || {};
    const results = new Array(list.length).fill(null);

    for (const idea of list) {
      idea.scoringState = 'scoring';
      this.repo.update(idea.id, { scoringState: 'scoring' });
    }

    // Reuse first: cached / near-duplicate ideas never consume batch slots.
    const pending = [];
    list.forEach((idea, i) => {
      const cacheKey = this.evalCacheKey(idea, model);
      const found = this.#lookup(idea, { model, cacheKey, force });
      if (found.raw) {
        try {
          results[i] = this.#applyEvaluation(idea, found.raw, { model, reuse: found.reuse, started });
        } catch (err) {
          results[i] = { ok: false, error: err?.message || String(err) };
        }
      } else {
        pending.push({ idea, i, cacheKey });
      }
    });

    let calls = 0;
    let fallbacks = 0;

    // A batch of one would use the batch prompt for no benefit, so fall back to
    // the canonical single-idea call: same prompt, same schema, same everything.
    if (pending.length === 1) {
      const { idea, i } = pending[0];
      try {
        results[i] = await this.score(idea, { model, signal, mode, force });
        calls += 1;
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted || err?.message === 'aborted') throw err;
        results[i] = { ok: false, error: err?.message || String(err) };
        calls += 1;
      }
    } else if (pending.length) {
      const k = pending.length;
      const prompt = buildBatchEvaluatePrompt(pending.map((p) => p.idea), { calibrationDirective: this.calibration.directive() });
      const budget = {
        maxTokens: clamp(perf.maxTokensEvaluate * k, 256, 32768),
        numCtx: clamp(perf.numCtxEvaluate + 384 * (k - 1), 512, 131072),
      };
      const got = new Map(); // position in `pending` -> raw judgment

      // Apply as entries stream in, so the first idea of a batch is scored before
      // the call finishes instead of the whole batch landing at once.
      const take = (entry) => {
        if (!entry || typeof entry !== 'object' || !entry.factors) return;
        const pos = Number(entry.index);
        const idx = Number.isFinite(pos) && pos >= 1 && pos <= k ? pos - 1 : null;
        if (idx === null || got.has(idx)) return;
        got.set(idx, entry);
        const { idea, i, cacheKey } = pending[idx];
        try {
          this.evalCache.set(cacheKey, entry);
          results[i] = this.#applyEvaluation(idea, entry, { model, callMs: 0, started, batch: k, statMs: null });
        } catch (err) {
          results[i] = { ok: false, error: err?.message || String(err) };
        }
      };

      try {
        const res = await this.callModel({
          role: 'evaluator',
          schema: batchEvaluateSchema(k),
          prompt,
          model,
          signal,
          budgetOverride: budget,
          itemArrayKey: 'evaluations',
          onItem: take,
        });
        calls += 1;
        this.stats.noteEvalCall({ ms: res.ms, ideas: k });
        const arr = Array.isArray(res.object?.evaluations) ? res.object.evaluations : Array.isArray(res.items) ? res.items : [];
        for (const entry of arr) take(entry);
        // Positional fallback for models that omit `index` but keep the order.
        if (got.size < k) {
          arr.forEach((entry, pos) => {
            if (pos < k && !got.has(pos)) take({ ...(entry || {}), index: pos + 1 });
          });
        }
        // Now that the shared call's real cost is known, charge each idea its
        // share so avgEvaluationMs means the same thing at every K.
        const share = res.ms / k;
        for (const pos of got.keys()) {
          const r = results[pending[pos].i];
          if (r?.ok && r.stat) this.stats.recordEvaluation({ ms: share, ...r.stat });
        }
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        calls += 1;
        this.stats.noteEvalCallFailure({ error: err?.message || String(err), ideas: k });
      }

      // Anything the batch did not deliver gets its own single-idea call: batch
      // failures must not cost K ideas the way a shared call naturally would.
      for (const { idea, i } of pending) {
        if (results[i]) continue;
        fallbacks += 1;
        try {
          results[i] = await this.score(idea, { model, signal, mode, force: true });
          calls += 1;
        } catch (err) {
          if (err?.name === 'AbortError' || signal?.aborted) throw err;
          results[i] = { ok: false, error: err?.message || String(err) };
          calls += 1;
        }
      }
    }

    const ms = performance.now() - started;
    this.stats.noteEvalBatch({ ideas: list.length, calls, fallbacks, ms });
    for (let i = 0; i < list.length; i += 1) {
      if (!results[i]) results[i] = { ok: false, error: 'evaluator returned nothing for this idea' };
    }
    return { ok: results.every((r) => r.ok), results, perIdea: list.map((x) => x.id), ms, calls, fallbacks };
  }

  /** Deep mode: attack, then improve + re-evaluate when the idea is worth it. */
  async deepPass(idea, { signal, improveThreshold = null } = {}) {
    const threshold = improveThreshold ?? this.settings.pipeline?.deepImproveThreshold ?? 6;
    const attack = await this.runAction(idea.id, 'attack', { signal, silent: true });
    if ((idea.score?.overall ?? 0) >= threshold) {
      await this.runAction(idea.id, 'improve', { signal, silent: true });
    }
    return attack;
  }

  // -----------------------------------------------------------------------
  // Exploration actions
  // -----------------------------------------------------------------------

  async runAction(ideaId, action, { signal, silent = false, model: requestedModel = '' } = {}) {
    const idea = this.repo.get(ideaId);
    if (!idea) throw new ProviderError(`Unknown idea ${ideaId}`, { code: 'not-found' });
    const started = performance.now();
    // One model for the whole action, so the analysis and any child ideas are all
    // attributed to the model that actually produced them.
    const model = await this.resolveModel(requestedModel);
    const evaluation = idea.evaluation || {};
    const payloadForEval = {
      overall: idea.score?.overall,
      biggestStrength: evaluation.biggestStrength,
      biggestWeakness: evaluation.biggestWeakness,
      whyNotHigher: evaluation.whyNotHigher,
      priorArt: evaluation.priorArt,
    };

    let result;
    switch (action) {
      case 'attack': {
        const res = await this.callModel({
          role: 'attacker',
          schema: ATTACK_SCHEMA,
          prompt: buildAttackPrompt(idea, payloadForEval),
          budget: 'deep',
          model,
          signal,
        });
        result = { attack: res.object };
        idea.analysis = { ...(idea.analysis || {}), attack: { ...res.object, at: Date.now(), model: res.model } };
        break;
      }
      case 'improve': {
        const res = await this.callModel({
          role: 'improver',
          schema: IMPROVE_SCHEMA,
          prompt: buildImprovePrompt(idea, { evaluation: payloadForEval, attack: idea.analysis?.attack }),
          budget: 'deep',
          model,
          signal,
        });
        const improved = res.object || {};
        idea.analysis = { ...(idea.analysis || {}), improve: { ...improved, at: Date.now(), model: res.model } };
        result = { improve: improved };
        // The improved version becomes its own idea so it gets its own brutal score.
        if (improved.improvedTitle) {
          const child = normalizeIdea({
            title: improved.improvedTitle,
            description: improved.improvedDescription,
            category: idea.category,
            problem: idea.problem,
            mechanism: improved.mechanism || idea.mechanism,
            targetUser: improved.targetUser || idea.targetUser,
            businessModel: improved.businessModel || idea.businessModel,
            distribution: idea.distribution,
          });
          const created = this.admit(child, {
            model,
            providerId: idea.provider,
            mode: 'fast', // derived ideas are scored, never deep-passed (see ReviewQueue)
            origin: 'improved',
            parentId: idea.id,
          });
          result.childId = created.id;
          idea.analysis.improve.childId = created.id;
        }
        break;
      }
      case 'mutate': {
        const res = await this.callModel({
          role: 'mutator',
          schema: MUTATE_SCHEMA,
          prompt: buildMutatePrompt(idea, { count: 3 }),
          budget: 'deep',
          model,
          signal,
        });
        const variants = (res.object?.variants || []).slice(0, 4);
        idea.analysis = { ...(idea.analysis || {}), mutate: { variants, at: Date.now(), model: res.model } };
        const children = [];
        for (const v of variants) {
          const child = normalizeIdea(v);
          if (!isViableIdea(child)) continue;
          const created = this.admit(child, {
            model,
            providerId: idea.provider,
            mode: 'fast', // derived ideas are scored, never deep-passed (see ReviewQueue)
            origin: 'mutated',
            parentId: idea.id,
          });
          children.push(created.id);
        }
        result = { mutate: variants, childIds: children };
        break;
      }
      case 'develop': {
        const res = await this.callModel({
          role: 'developer',
          schema: DEVELOP_SCHEMA,
          prompt: buildDevelopPrompt(idea, { evaluation: payloadForEval }),
          budget: 'deep',
          model,
          signal,
        });
        idea.analysis = { ...(idea.analysis || {}), develop: { ...res.object, at: Date.now(), model: res.model } };
        result = { develop: res.object };
        break;
      }
      case 'research': {
        const res = await this.callModel({
          role: 'researcher',
          schema: RESEARCH_SCHEMA,
          prompt: buildResearchPrompt(idea, { evaluation: payloadForEval }),
          budget: 'deep',
          model,
          signal,
        });
        idea.analysis = { ...(idea.analysis || {}), research: { ...res.object, at: Date.now(), model: res.model } };
        result = { research: res.object };
        break;
      }
      case 'reevaluate': {
        const previous = idea.evaluation
          ? { overall: idea.score?.overall, factors: idea.evaluation.factors, at: Date.now(), whyNotHigher: idea.evaluation.whyNotHigher }
          : null;
        await this.score(idea, { model: model || idea.model, signal, force: true });
        if (previous) {
          idea.analysis = { ...(idea.analysis || {}), history: [...(idea.analysis?.history || []), previous].slice(-8) };
          this.repo.update(idea.id, { analysis: idea.analysis });
        }
        result = { reevaluate: { before: previous?.overall ?? null, after: idea.score?.overall ?? null } };
        break;
      }
      default:
        throw new ProviderError(`Unknown action "${action}"`, { code: 'bad-action' });
    }

    const ms = performance.now() - started;
    this.stats.recordDeep({ ms, action });
    this.repo.update(ideaId, { analysis: idea.analysis });
    if (!silent) emit('idea:updated', { card: IdeaRepository.card(idea), action });
    return { ...result, ms: Math.round(ms), id: ideaId, action };
  }

  // -----------------------------------------------------------------------
  // Knowledge Bank extraction (gated)
  // -----------------------------------------------------------------------

  async extractKnowledge({ limit = 24, signal } = {}) {
    const recent = [...this.repo.all()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit)
      .filter((i) => i.title);
    if (recent.length < 3) return { accepted: [], rejected: [{ reason: 'need at least 3 ideas to mine' }], promoted: [] };

    const { buildExtractPrompt } = await import('../prompts/build.js');
    const { EXTRACT_SCHEMA } = await import('../prompts/schemas.js');
    const res = await this.callModel({
      role: 'extractor',
      schema: EXTRACT_SCHEMA,
      prompt: buildExtractPrompt(recent, this.bank.list({ limit: 400 }).map((e) => e.name)),
      budget: 'extract',
      signal,
    });
    const result = this.bank.ingest(res.object || {}, recent.map((i) => i.id));
    emit('knowledge:update', this.bank.stats());
    return { ...result, ms: Math.round(res.ms), model: res.model, mined: recent.length };
  }
}
