/**
 * Anti-bias system.
 *
 * Two layers:
 *  1. A cheap deterministic concentration report computed from the idea bank
 *     (category / business model / audience / mechanism share, Herfindahl
 *     index). Always available, never costs a model call.
 *  2. A periodic LLM meta-analysis over a compressed sample, which turns the
 *     numbers into imperative directives for the generator. Results are cached
 *     and re-used until the sample moves on.
 */
import { round1, round2 } from '../lib/util.js';
import { tokenize } from './similarity.js';

const OVERREPRESENTED_AT = 0.3; // > 30% of the recent window is a bias signal
const WATCH_AT = 0.18;

export class BiasMonitor {
  /**
   * @param {{repo: import('./ideas.js').IdeaRepository, store: import('../lib/store.js').JsonStore, callModel: Function, settings: ()=>object}} deps
   */
  constructor(deps) {
    this.repo = deps.repo;
    this.store = deps.store;
    this.callModel = deps.callModel;
    this.getSettings = deps.settings;
    this.state = this.store.data || { lastRunAt: 0, lastSampleSize: 0, report: null, llm: null };
    this.store.data = this.state;
    this.running = null;
  }

  window(size = 60) {
    return [...this.repo.all()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, size);
  }

  /** Deterministic concentration report over the recent window. */
  deterministic(size = 60) {
    const recent = this.window(size);
    if (!recent.length) {
      return { sampleSize: 0, categories: [], businessModels: [], audiences: [], mechanisms: [], aiShare: 0, hhi: 0, flags: [], directives: [] };
    }
    const n = recent.length;
    const tally = (fn) => {
      const map = new Map();
      for (const idea of recent) {
        const key = fn(idea);
        if (!key) continue;
        const list = Array.isArray(key) ? key : [key];
        for (const k of list) {
          const entry = map.get(k) || { value: k, count: 0 };
          entry.count++;
          map.set(k, entry);
        }
      }
      return [...map.values()]
        .map((e) => ({ value: e.value, count: e.count, share: round2(e.count / n) }))
        .sort((a, b) => b.count - a.count);
    };

    const categories = tally((i) => i.category);
    const businessModels = tally((i) => (i.businessModel || '').toLowerCase().slice(0, 40));
    const audiences = tally((i) => (i.targetUser || '').toLowerCase().slice(0, 40));

    // Mechanism repetition: the vocabulary the generator keeps reaching for.
    const mechTokens = tally((i) => tokenize(`${i.mechanism || ''} ${i.description || ''}`).slice(0, 40));
    const mechanisms = mechTokens.filter((t) => t.count >= Math.max(3, n * 0.18)).slice(0, 12);

    const aiSignals = /(llm|gpt|ai|model|embedding|prompt|agent|neural|machine learning|genai)/i;
    const aiShare = round2(recent.filter((i) => aiSignals.test(`${i.title} ${i.description} ${i.mechanism} ${i.category}`)).length / n);

    // Herfindahl index over categories: 1/n = perfectly even, 1 = one category only
    const hhi = round2(categories.reduce((a, c) => a + c.share ** 2, 0));

    const flags = [];
    const directives = [];
    // A handful of ideas is not a trend: stay quiet until the sample means something.
    const confident = n >= 12;
    for (const c of categories) {
      if (!confident) break;
      if (c.share >= OVERREPRESENTED_AT) {
        flags.push({ dimension: 'category', value: c.value, share: c.share, severity: 'high' });
        directives.push(`At most 1 in 5 ideas may be "${c.value}" - it is ${Math.round(c.share * 100)}% of the recent sample.`);
      } else if (c.share >= WATCH_AT) {
        flags.push({ dimension: 'category', value: c.value, share: c.share, severity: 'medium' });
      }
    }
    for (const b of businessModels.slice(0, 3)) {
      if (!confident) break;
      if (b.share >= OVERREPRESENTED_AT) {
        flags.push({ dimension: 'businessModel', value: b.value, share: b.share, severity: 'high' });
        directives.push(`Stop defaulting to "${b.value}"; use a different revenue mechanism for the next batch.`);
      }
    }
    for (const a of audiences.slice(0, 3)) {
      if (!confident) break;
      if (a.share >= OVERREPRESENTED_AT) {
        flags.push({ dimension: 'audience', value: a.value, share: a.share, severity: 'high' });
        directives.push(`Change the customer: "${a.value}" is ${Math.round(a.share * 100)}% of recent ideas.`);
      }
    }
    if (confident && aiShare >= 0.6) {
      flags.push({ dimension: 'ai', value: 'AI-centric ideas', share: aiShare, severity: 'high' });
      directives.push(`Over ${Math.round(aiShare * 100)}% of recent ideas lean on AI. Produce ideas whose core mechanism is NOT a model call.`);
    }
    if (confident && hhi >= 0.35) {
      flags.push({ dimension: 'concentration', value: 'category HHI', share: hhi, severity: 'high' });
      directives.push(`Spread across at least 5 different categories in the next batch (concentration index ${hhi}).`);
    }
    if (confident && mechanisms.length >= 4) {
      flags.push({ dimension: 'mechanism', value: mechanisms.slice(0, 4).map((m) => m.value).join(', '), share: mechanisms[0].share, severity: 'medium' });
      directives.push(`Avoid these overused mechanism words: ${mechanisms.slice(0, 5).map((m) => m.value).join(', ')}.`);
    }

    const allCategories = ['software', 'ai', 'developer-tools', 'education', 'productivity', 'business', 'science', 'engineering', 'automation', 'consumer', 'research', 'weird'];
    const missing = allCategories.filter((c) => !categories.some((x) => x.value === c));
    const underexplored = missing.slice(0, 4);
    if (confident && underexplored.length) {
      directives.push(`Nothing recent in: ${underexplored.join(', ')}. Include at least one idea from these.`);
    }

    return {
      sampleSize: n,
      categories: categories.slice(0, 12),
      businessModels: businessModels.slice(0, 10),
      audiences: audiences.slice(0, 10),
      mechanisms,
      aiShare,
      hhi,
      flags,
      directives,
      underexplored,
    };
  }

  /** Directives fed into the next generation prompt (deterministic + cached LLM). */
  directives({ limit = 6 } = {}) {
    const d = this.deterministic();
    const llm = this.state.llm?.directives || [];
    return [...new Set([...d.directives, ...llm])].slice(0, limit);
  }

  report() {
    return {
      deterministic: this.deterministic(),
      llm: this.state.llm,
      lastRunAt: this.state.lastRunAt || 0,
      lastSampleSize: this.state.lastSampleSize || 0,
      running: !!this.running,
      biasCheckEvery: this.getSettings().pipeline?.biasCheckEvery ?? 25,
      ideasSinceRun: this.repo.count() - (this.state.lastSampleSize || 0),
    };
  }

  /** Run the LLM meta-analysis if enough new ideas have accumulated. */
  async maybeAnalyze({ force = false, signal } = {}) {
    const settings = this.getSettings();
    const every = settings.pipeline?.biasCheckEvery ?? 25;
    const sinceRun = this.repo.count() - (this.state.lastSampleSize || 0);
    if (!force && (sinceRun < every || this.repo.count() < Math.min(8, every))) return null;
    if (this.running) return this.running;

    const det = this.deterministic();
    const sample = this.window(40).map((i) => ({
      title: i.title,
      category: i.category,
      businessModel: i.businessModel,
      targetUser: i.targetUser,
    }));

    this.running = (async () => {
      const started = Date.now();
      try {
        const { buildMetaPrompt } = await import('../prompts/build.js');
        const { META_SCHEMA } = await import('../prompts/schemas.js');
        const prompt = buildMetaPrompt(sample, {
          deterministic: {
            categories: det.categories.slice(0, 8),
            businessModels: det.businessModels.slice(0, 6),
            audiences: det.audiences.slice(0, 6),
            aiShare: det.aiShare,
            concentrationIndex: det.hhi,
            underexplored: det.underexplored,
          },
        });
        const res = await this.callModel({
          role: 'meta',
          schema: META_SCHEMA,
          prompt,
          budget: 'meta',
          signal,
        });
        const parsed = res.object;
        if (!parsed) throw new Error('meta-analyzer returned unparseable output');
        const record = {
          at: Date.now(),
          ms: Date.now() - started,
          model: res.model,
          biases: (parsed.biases || []).slice(0, 8),
          underexplored: (parsed.underexplored || []).slice(0, 6),
          directives: (parsed.directives || []).slice(0, 6),
          summary: parsed.summary || '',
        };
        this.state.llm = record;
        this.state.lastRunAt = Date.now();
        this.state.lastSampleSize = this.repo.count();
        this.store.save();
        return record;
      } catch (err) {
        this.state.lastError = err.message;
        this.state.lastRunAt = Date.now();
        this.state.lastSampleSize = this.repo.count();
        this.store.save();
        return { error: err.message };
      } finally {
        this.running = null;
      }
    })();

    return this.running;
  }

  /** Deterministic concentration figures exposed in the stats panel. */
  snapshot() {
    const d = this.deterministic();
    return {
      sampleSize: d.sampleSize,
      aiShare: d.aiShare,
      hhi: d.hhi,
      topCategory: d.categories[0] || null,
      topBusinessModel: d.businessModels[0] || null,
      flags: d.flags.length,
      directives: this.directives({ limit: 4 }),
      underexplored: d.underexplored,
      llmSummary: this.state.llm?.summary || null,
      llmAt: this.state.llm?.at || 0,
    };
  }

  reset() {
    this.state.llm = null;
    this.state.lastRunAt = 0;
    this.state.lastSampleSize = this.repo.count();
    this.store.save();
  }

  static get OVERREPRESENTED_AT() {
    return OVERREPRESENTED_AT;
  }
  static get WATCH_AT() {
    return WATCH_AT;
  }
  static round = { round1, round2 };
}
