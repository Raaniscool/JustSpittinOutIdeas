/**
 * Performance measurement.
 *
 * The metric that matters is *useful ideas per minute*, not tokens per second,
 * so both are tracked: raw throughput for tuning, and quality-weighted
 * throughput (ideas >= 7 / >= 8 per minute) for comparing models.
 */
import { round1, round2 } from '../lib/util.js';

export class StatsCollector {
  constructor() {
    this.reset();
    this.startedAt = Date.now();
    this.byModel = new Map();
    this.calls = { total: 0, failed: 0, retries: 0, cacheHits: 0, duplicateSkips: 0 };
  }

  reset() {
    this.session = {
      startedAt: Date.now(),
      generated: 0,
      derived: 0,
      evaluated: 0,
      failed: 0,
      genMs: [],
      evalMs: [],
      deepMs: [],
      scores: [],
      tokens: { prompt: 0, completion: 0 },
      tokensPerSec: [],
      deepActions: {},
    };
  }

  model(model = 'unknown') {
    let m = this.byModel.get(model);
    if (!m) {
      m = { model, generated: 0, evaluated: 0, genMs: [], evalMs: [], scores: [], tokensPerSec: [], failed: 0 };
      this.byModel.set(model, m);
    }
    return m;
  }

  recordGeneration({ ms, model, count, usage, failed = false }) {
    const s = this.session;
    if (failed) {
      s.failed++;
      this.calls.failed++;
      this.model(model).failed++;
      return;
    }
    s.generated += count;
    s.genMs.push(ms);
    if (s.genMs.length > 400) s.genMs.shift();
    const m = this.model(model);
    m.generated += count;
    m.genMs.push(ms);
    if (m.genMs.length > 200) m.genMs.shift();
    if (usage) {
      s.tokens.prompt += usage.promptTokens || 0;
      s.tokens.completion += usage.completionTokens || 0;
      if (usage.tokensPerSec) {
        s.tokensPerSec.push(usage.tokensPerSec);
        m.tokensPerSec.push(usage.tokensPerSec);
        if (s.tokensPerSec.length > 200) s.tokensPerSec.shift();
      }
    }
  }

  recordEvaluation({ ms, model, overall, usage, failed = false, cacheHit = false, duplicateSkip = false }) {
    const s = this.session;
    if (cacheHit) this.calls.cacheHits++;
    if (duplicateSkip) this.calls.duplicateSkips++;
    if (failed) {
      s.failed++;
      this.calls.failed++;
      this.model(model).failed++;
      return;
    }
    s.evaluated++;
    s.evalMs.push(ms);
    if (s.evalMs.length > 600) s.evalMs.shift();
    if (Number.isFinite(overall)) {
      s.scores.push(overall);
      if (s.scores.length > 2000) s.scores.shift();
    }
    const m = this.model(model);
    m.evaluated++;
    m.evalMs.push(ms);
    if (m.evalMs.length > 300) m.evalMs.shift();
    if (Number.isFinite(overall)) m.scores.push(overall);
    if (usage) {
      s.tokens.prompt += usage.promptTokens || 0;
      s.tokens.completion += usage.completionTokens || 0;
      if (usage.tokensPerSec) s.tokensPerSec.push(usage.tokensPerSec);
    }
  }

  /** Ideas created by Improve/Mutate rather than by a generation call. */
  recordDerived({ model }) {
    this.session.derived++;
    const m = this.model(model);
    m.generated++;
  }

  recordDeep({ ms, action }) {
    this.session.deepMs.push(ms);
    if (this.session.deepMs.length > 300) this.session.deepMs.shift();
    this.session.deepActions[action] = (this.session.deepActions[action] || 0) + 1;
  }

  recordCall({ failed = false, retry = false }) {
    this.calls.total++;
    if (failed) this.calls.failed++;
    if (retry) this.calls.retries++;
  }

  /** Ideas counted from the persisted bank (survives restarts). */
  hydrateFromIdeas(ideas = []) {
    const s = this.session;
    for (const idea of ideas) {
      if (idea?.score?.overall != null) s.scores.push(Number(idea.score.overall));
      if (idea?.timings?.evalMs) s.evalMs.push(idea.timings.evalMs);
    }
    s.evaluated = Math.max(s.evaluated, ideas.filter((i) => i?.score?.overall != null).length);
    s.generated = Math.max(s.generated, ideas.length);
  }

  summary({ elapsedMs } = {}) {
    const s = this.session;
    const avg = (arr) => (arr.length ? round1(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
    const minutes = Math.max(1 / 60, ((elapsedMs ?? Date.now() - s.startedAt) / 60000) || 1 / 60);
    const scores = s.scores;
    const ge = (t) => scores.filter((v) => v >= t).length;

    return {
      startedAt: s.startedAt,
      elapsedMs: Date.now() - s.startedAt,
      ideasGenerated: s.generated + s.derived,
      ideasFromBatches: s.generated,
      ideasDerived: s.derived,
      ideasEvaluated: s.evaluated,
      failures: s.failed,
      ideasPerMinute: round1(s.evaluated / minutes),
      usefulPerMinute: round2(ge(7) / minutes),
      excellentPerMinute: round2(ge(8) / minutes),
      avgGenerationMs: avg(s.genMs),
      avgEvaluationMs: avg(s.evalMs),
      avgDeepActionMs: avg(s.deepMs),
      avgScore: scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      medianScore: scores.length ? round1([...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)]) : 0,
      countGe7: ge(7),
      countGe8: ge(8),
      countGe9: ge(9),
      shareGe7: scores.length ? round2(ge(7) / scores.length) : 0,
      shareGe8: scores.length ? round2(ge(8) / scores.length) : 0,
      tokens: { ...s.tokens },
      avgTokensPerSec: avg(s.tokensPerSec),
      calls: { ...this.calls },
      deepActions: { ...s.deepActions },
      byModel: [...this.byModel.values()]
        .map((m) => {
          const mins = Math.max(1 / 60, (Date.now() - s.startedAt) / 60000);
          const ge7 = m.scores.filter((v) => v >= 7).length;
          const ge8 = m.scores.filter((v) => v >= 8).length;
          return {
            model: m.model,
            generated: m.generated,
            evaluated: m.evaluated,
            failed: m.failed,
            ideasPerMinute: round1(m.evaluated / mins),
            usefulPerMinute: round2(ge7 / mins),
            avgGenerationMs: avg(m.genMs),
            avgEvaluationMs: avg(m.evalMs),
            avgScore: m.scores.length ? round1(m.scores.reduce((a, b) => a + b, 0) / m.scores.length) : 0,
            countGe7: ge7,
            countGe8: ge8,
            avgTokensPerSec: avg(m.tokensPerSec),
          };
        })
        .sort((a, b) => b.evaluated - a.evaluated),
    };
  }
}
