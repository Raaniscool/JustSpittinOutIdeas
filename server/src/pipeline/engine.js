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
import { GENERATE_SCHEMA, EVALUATE_SCHEMA, ATTACK_SCHEMA, IMPROVE_SCHEMA, MUTATE_SCHEMA, DEVELOP_SCHEMA, RESEARCH_SCHEMA } from '../prompts/schemas.js';
import {
  buildGeneratePrompt,
  buildEvaluatePrompt,
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

    const pending = [];
    let streamed = 0;
    let skipped = 0;

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
        pending.push(this.ingest(idea, { jobId, model, providerId: provider.id, mode, signal }));
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
        pending.push(this.ingest(idea, { jobId, model, providerId: provider.id, mode, signal }));
      }
    }

    this.stats.recordGeneration({ ms: performance.now() - started, model, count: streamed, usage: res.usage });
    this.bank.recordUsage(touched);
    if (touched.length) emit('knowledge:usage', { count: touched.length });

    const results = await Promise.all(pending);
    const scored = results.filter((r) => r && r.ok).length;

    // Cheap, throttled housekeeping: bias check without blocking generation.
    void this.bias.maybeAnalyze({ signal }).then((report) => {
      if (report && !report.error) emit('bias:update', this.bias.report());
    });

    return {
      requested: count,
      generated: streamed,
      scored,
      skipped,
      ms: performance.now() - started,
      model,
      providerId: provider.id,
      usage: res.usage,
      seeds,
    };
  }

  /**
   * Take one normalized idea: persist it immediately (so it appears on the wall
   * at once), then score it through the concurrency limiter.
   */
  async ingest(idea, { jobId = null, model = '', providerId = '', mode = 'fast', signal, origin = 'generated', parentId = null } = {}) {
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

    try {
      await this.evalLimiter(() => this.score(record, { model, signal, mode }));
      // Deep work runs *after* the limiter slot is released. Attack/improve spawn
      // child ideas that need an evaluation slot of their own, so nesting the
      // deep pass inside the parent's slot deadlocks the pool the moment as many
      // ideas are in flight as `evaluateConcurrency` allows.
      //
      // Derived ideas are never deep either: one level of improve/mutate is the
      // useful amount, and letting a child inherit `deep` recursed without bound
      // (improve -> child -> improve -> grandchild -> ...).
      if (mode === 'deep' && origin === 'generated') {
        const scored = this.repo.get(record.id) || record;
        if (scored.scoringState !== 'failed') await this.deepLimiter(() => this.deepPass(scored, { signal }));
      }
      return { ok: true, id: record.id, overall: record.score?.overall };
    } catch (err) {
      record.scoringState = 'failed';
      record.error = err.message;
      this.repo.update(record.id, { scoringState: 'failed', error: err.message });
      this.stats.recordEvaluation({ failed: true, model, ms: 0 });
      emit('idea:updated', { card: IdeaRepository.card(record), error: err.message, jobId });
      return { ok: false, id: record.id, error: err.message };
    }
  }

  /**
   * Fast-mode evaluation: one independent evaluator call per idea, with
   * cache + near-duplicate reuse to avoid unnecessary model calls.
   */
  async score(idea, { model: requestedModel = '', signal, mode = 'fast', force = false } = {}) {
    const started = performance.now();
    // Resolve once, before anything keys off it, so the model recorded on the
    // evaluation is the model that actually produced it: an idea generated by an
    // explicit per-job model must not be evaluated by whatever the global default
    // happens to be now.
    const model = await this.resolveModel(requestedModel || idea.model || '');
    const s = this.settings;
    const calib = s.scoring?.calibration || {};
    const weights = this.weights();
    const weightsKey = Object.values(weights).map((w) => w.toFixed(3)).join(',');
    const cacheKey = `${model}|${PROMPT_VERSION}|${idea.contentKey}|${weightsKey}`;

    idea.scoringState = 'scoring';
    this.repo.update(idea.id, { scoringState: 'scoring' });

    let raw = null;
    let reuse = null;

    if (!force) {
      const cached = this.evalCache.get(cacheKey);
      if (cached) {
        raw = cached;
        reuse = { kind: 'cache' };
      }
    }

    if (!raw && !force && s.performance?.reuseEvaluationForNearDuplicates !== false) {
      const threshold = s.performance?.nearDuplicateEvalThreshold ?? 0.9;
      const similar = this.repo.index.findSimilar(idea, { limit: 4 });
      const twin = similar
        .map((sim) => ({ sim, idea: this.repo.get(sim.id) }))
        .find(({ sim, idea: other }) => sim.similarity >= threshold && other?.evaluation?.raw);
      if (twin) {
        raw = twin.idea.evaluation.raw;
        reuse = { kind: 'near-duplicate', fromId: twin.idea.id, similarity: twin.sim.similarity };
      }
    }

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
    }

    const pressure = this.calibration.pressure();
    const audited = auditEvaluation(raw, calib, pressure);
    const { overall, contributions, incomplete, warnings } = computeOverall(audited.factors, weights);

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
      evaluatedAt: Date.now(),
      model,
      usage,
    };

    const ms = performance.now() - started;
    this.repo.update(idea.id, {
      evaluation,
      score: { overall, contributions, grade: scoreGrade(overall), color: scoreColor(overall), incomplete },
      scoringState: 'scored',
      timings: { ...(idea.timings || {}), evalMs: Math.round(callMs || ms), evaluatedAt: Date.now() },
    });
    this.repo.markDuplicates(idea, { enabled: s.pipeline?.dedupe !== false });
    idea.metrics.unusualness = this.repo.unusualness(idea);
    this.repo.update(idea.id, { similar: idea.similar, duplicateOf: idea.duplicateOf, metrics: idea.metrics });

    this.calibration.record(overall, { model });
    this.stats.recordEvaluation({ ms, model, overall, usage, cacheHit: reuse?.kind === 'cache', duplicateSkip: reuse?.kind === 'near-duplicate' });
    emit('idea:scored', { card: IdeaRepository.card(idea), jobId: idea.jobId });

    return { ok: true, overall, ms, reuse };
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
          const created = await this.ingest(child, {
            model,
            providerId: idea.provider,
            mode: 'fast', // derived ideas are scored, never deep-passed (see ingest)
            signal,
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
          const created = await this.ingest(child, {
            model,
            providerId: idea.provider,
            mode: 'fast', // derived ideas are scored, never deep-passed (see ingest)
            signal,
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
