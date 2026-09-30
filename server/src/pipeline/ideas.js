/**
 * Idea repository: persistence, filtering, sorting, duplicate marking.
 */
import { SimilarityIndex, fingerprint, ideaContentKey, unusualness, tokenize } from './similarity.js';
import { scoreColor, scoreGrade } from './scoring.js';

export const SORTS = {
  overall: (a, b) => (b.score?.overall ?? -1) - (a.score?.overall ?? -1),
  novelty: (a, b) => (b.evaluation?.factors?.novelty ?? -1) - (a.evaluation?.factors?.novelty ?? -1),
  usefulness: (a, b) => (b.evaluation?.factors?.usefulness ?? -1) - (a.evaluation?.factors?.usefulness ?? -1),
  monetization: (a, b) => (b.evaluation?.factors?.monetization ?? -1) - (a.evaluation?.factors?.monetization ?? -1),
  market: (a, b) => (b.evaluation?.factors?.marketPotential ?? -1) - (a.evaluation?.factors?.marketPotential ?? -1),
  feasibility: (a, b) => (b.evaluation?.factors?.feasibility ?? -1) - (a.evaluation?.factors?.feasibility ?? -1),
  newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  oldest: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
  unusual: (a, b) => (b.metrics?.unusualness ?? 0) - (a.metrics?.unusualness ?? 0),
  hardest: (a, b) => (b.evaluation?.factors?.technicalDifficulty ?? -1) - (a.evaluation?.factors?.technicalDifficulty ?? -1),
};

let counter = 0;
export function newId(prefix = 'idea') {
  counter = (counter + 1) % 1296;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}${Math.floor(Math.random() * 36).toString(36)}`;
}

export class IdeaRepository {
  /** @param {import('../lib/store.js').JsonStore} store */
  constructor(store) {
    this.store = store;
    if (!this.store.data || !Array.isArray(this.store.data.ideas)) {
      this.store.data = { ideas: [], version: 1 };
    }
    this.ideas = this.store.data.ideas;
    this.byId = new Map(this.ideas.map((i) => [i.id, i]));
    this.index = new SimilarityIndex({ maxScan: 6000 });
    this.docFreq = new Map();
    this.corpusSize = 0;
    this.rebuildIndex();
  }

  rebuildIndex() {
    this.index.clear();
    this.docFreq = new Map();
    this.corpusSize = 0;
    for (const idea of this.ideas) {
      this.index.add(idea);
      for (const tok of new Set(tokenize(`${idea.title} ${idea.description} ${idea.mechanism || ''}`))) {
        this.docFreq.set(tok, (this.docFreq.get(tok) || 0) + 1);
      }
      this.corpusSize++;
    }
  }

  count() {
    return this.ideas.length;
  }

  all() {
    return this.ideas;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** Insert a fully-formed idea record (already scored). */
  add(idea) {
    if (!idea.id) idea.id = newId();
    idea.createdAt = idea.createdAt || Date.now();
    idea.updatedAt = Date.now();
    this.ideas.push(idea);
    this.byId.set(idea.id, idea);
    this.index.add(idea);
    for (const tok of new Set(tokenize(`${idea.title} ${idea.description} ${idea.mechanism || ''}`))) {
      this.docFreq.set(tok, (this.docFreq.get(tok) || 0) + 1);
    }
    this.corpusSize++;
    this.store.save();
    return idea;
  }

  /** Mutate in place + persist + reindex. */
  update(id, patch) {
    const idea = this.byId.get(id);
    if (!idea) return null;
    const textChanged = ['title', 'description', 'mechanism', 'targetUser', 'problem'].some(
      (k) => patch[k] !== undefined && patch[k] !== idea[k],
    );
    Object.assign(idea, patch, { updatedAt: Date.now() });
    if (textChanged) {
      this.index.add(idea);
      idea.metrics = { ...(idea.metrics || {}), unusualness: unusualness(idea, this.docFreq, this.corpusSize) };
    }
    this.store.save();
    return idea;
  }

  remove(id) {
    const idea = this.byId.get(id);
    if (!idea) return false;
    const i = this.ideas.indexOf(idea);
    if (i >= 0) this.ideas.splice(i, 1);
    this.byId.delete(id);
    this.index.remove(id);
    this.store.save();
    return true;
  }

  /** Mark near-duplicates for a new idea (never deletes anything). */
  markDuplicates(idea, { enabled = true } = {}) {
    if (!enabled) return [];
    const similar = this.index.findSimilar(idea, { limit: 6 });
    if (similar.length) {
      idea.similar = similar;
      idea.duplicateOf = similar.find((s) => s.kind === 'duplicate')?.id || null;
    } else {
      idea.similar = [];
      idea.duplicateOf = null;
    }
    return idea.similar;
  }

  /** Titles of the most recent ideas - fed back to the generator to suppress repetition. */
  recentTitles(limit = 40) {
    return [...this.ideas]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit)
      .map((i) => i.title)
      .filter(Boolean);
  }

  contentKey(idea) {
    return ideaContentKey(idea);
  }

  fingerprint(idea) {
    return fingerprint(idea);
  }

  unusualness(idea) {
    return unusualness(idea, this.docFreq, this.corpusSize);
  }

  /** Apply filters + sorting. Returns {items, total}. */
  query(params = {}) {
    const {
      q = '',
      category = 'all',
      status = 'all',
      tag = '',
      starred = false,
      hideDuplicates = false,
      hideArchived = true,
      sort = 'overall',
      dir = 'desc',
      limit = 240,
      offset = 0,
      min = {},
      max = {},
      provider = 'all',
      mode = 'all',
    } = params;

    let items = this.ideas;
    const needle = q.trim().toLowerCase();

    if (hideArchived && status === 'all') items = items.filter((i) => i.status !== 'archived');
    if (category && category !== 'all') items = items.filter((i) => i.category === category);
    if (status && status !== 'all') items = items.filter((i) => i.status === status || (status === 'starred' && i.starred));
    if (starred) items = items.filter((i) => i.starred);
    if (tag) items = items.filter((i) => (i.tags || []).includes(tag));
    if (hideDuplicates) items = items.filter((i) => !i.duplicateOf);
    if (provider !== 'all') items = items.filter((i) => (i.provider || 'ollama') === provider);
    if (mode !== 'all') items = items.filter((i) => (i.mode || 'fast') === mode);
    if (needle) {
      items = items.filter((i) =>
        [i.title, i.description, i.problem, i.mechanism, i.targetUser, i.businessModel, i.evaluation?.biggestWeakness]
          .filter(Boolean)
          .some((t) => String(t).toLowerCase().includes(needle)),
      );
    }

    for (const [key, value] of Object.entries(min)) {
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) continue;
      items = items.filter((i) => factorValue(i, key) >= v);
    }
    for (const [key, value] of Object.entries(max)) {
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) continue;
      items = items.filter((i) => factorValue(i, key) <= v);
    }

    const cmp = SORTS[sort] || SORTS.overall;
    items = [...items].sort((a, b) => (dir === 'asc' ? -cmp(a, b) : cmp(a, b)));
    const total = items.length;
    return { items: items.slice(offset, offset + limit), total };
  }

  /** Compact rows for the wall of cards. */
  static card(i) {
    const overall = i.score?.overall ?? null;
    return {
      id: i.id,
      title: i.title,
      description: i.description,
      category: i.category,
      overall,
      color: overall == null ? null : scoreColor(overall),
      grade: overall == null ? null : scoreGrade(overall),
      factors: i.evaluation?.factors || null,
      biggestStrength: i.evaluation?.biggestStrength || '',
      biggestWeakness: i.evaluation?.biggestWeakness || '',
      whyNotHigher: i.evaluation?.whyNotHigher || '',
      summary: i.evaluation?.summary || '',
      verdict: i.evaluation?.verdict || '',
      adjustments: i.evaluation?.adjustments || [],
      status: i.status,
      starred: !!i.starred,
      tags: i.tags || [],
      notes: i.notes || '',
      duplicateOf: i.duplicateOf || null,
      similar: i.similar || [],
      model: i.model,
      provider: i.provider,
      mode: i.mode || 'fast',
      origin: i.origin || 'generated',
      parentId: i.parentId || null,
      createdAt: i.createdAt,
      scoringState: i.scoringState || 'scored',
      unusualness: i.metrics?.unusualness ?? 0,
      hasAnalysis: !!(i.analysis && Object.keys(i.analysis).length),
    };
  }

  /** Distribution used by the wall overview + bias detection. */
  distribution() {
    const scores = this.ideas.map((i) => i.score?.overall).filter((v) => Number.isFinite(v));
    const histogram = Array(10).fill(0);
    for (const s of scores) histogram[Math.min(9, Math.max(0, Math.floor(s) - 1))]++;
    const byCategory = {};
    const byStatus = {};
    const byModel = {};
    const byBusinessModel = {};
    const byAudience = {};
    for (const i of this.ideas) {
      byCategory[i.category || 'unknown'] = (byCategory[i.category || 'unknown'] || 0) + 1;
      byStatus[i.status || 'new'] = (byStatus[i.status || 'new'] || 0) + 1;
      byModel[i.model || 'unknown'] = (byModel[i.model || 'unknown'] || 0) + 1;
      const bm = (i.businessModel || 'unknown').toLowerCase();
      byBusinessModel[bm] = (byBusinessModel[bm] || 0) + 1;
      const aud = (i.targetUser || 'unknown').toLowerCase();
      byAudience[aud] = (byAudience[aud] || 0) + 1;
    }
    return { count: this.ideas.length, scored: scores.length, histogram, byCategory, byStatus, byModel, byBusinessModel, byAudience };
  }

  tags() {
    const set = new Set();
    for (const i of this.ideas) for (const t of i.tags || []) set.add(t);
    return [...set].sort();
  }
}

export function factorValue(idea, key) {
  if (key === 'overall') return idea.score?.overall ?? -1;
  if (key === 'unusualness') return idea.metrics?.unusualness ?? -1;
  return idea.evaluation?.factors?.[key] ?? -1;
}
