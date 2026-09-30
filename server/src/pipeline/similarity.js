/**
 * Near-duplicate detection.
 *
 * Compares title, description, core mechanism, target user and the problem
 * solved using token shingles + Dice/Jaccard. Similar ideas are *marked*, never
 * deleted - a variation can still be the interesting one.
 */
import { hashString } from '../lib/util.js';

const STOPWORDS = new Set(
  `a an the and or but if then than that this these those of for to in on with without by from as at is are was were be been being it its their there here we you your our us i app tool platform system solution product service using use uses new ai powered based help helps make makes allows enable enables users user people person who which what how why when where can could should would will may might also more most other another into over under between per via across`.split(
    /\s+/,
  ),
);

export function tokenize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s+-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[-+]|[-+]$/g, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map(stem);
}

function stem(t) {
  if (t.length <= 4) return t;
  if (t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.endsWith('sses')) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  if (t.endsWith('ing')) return t.slice(0, -3);
  if (t.endsWith('ed') && t.length > 5) return t.slice(0, -2);
  if (t.endsWith('ment')) return t.slice(0, -4);
  if (t.endsWith('tion')) return t.slice(0, -4);
  if (t.endsWith('er')) return t.slice(0, -2);
  if (t.endsWith('ly')) return t.slice(0, -2);
  return t;
}

export function shingles(tokens, k = 3) {
  const set = new Set();
  if (tokens.length < k) {
    if (tokens.length) set.add(tokens.join(' '));
    return set;
  }
  for (let i = 0; i + k <= tokens.length; i++) set.add(tokens.slice(i, i + k).join(' '));
  return set;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

export function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** Build the comparison fingerprint for an idea. */
export function fingerprint(idea = {}) {
  const title = tokenize(idea.title);
  const desc = tokenize(idea.description);
  const mech = tokenize(idea.mechanism || idea.coreMechanism || idea.howItWorks || '');
  const audience = tokenize(idea.targetUser || idea.audience || idea.customer || '');
  const problem = tokenize(idea.problem || idea.problemSolved || '');
  return {
    id: idea.id,
    category: idea.category || 'any',
    title,
    titleShingles: shingles(title, 2),
    descShingles: shingles(desc, 3),
    mechShingles: shingles(mech.length ? mech : desc, 3),
    audienceShingles: shingles(audience, 2),
    problemShingles: shingles(problem.length ? problem : desc, 3),
    bodyTokens: new Set([...desc, ...mech, ...problem]),
  };
}

/**
 * Weighted similarity in 0..1 between two fingerprints.
 * The core mechanism matters more than the wording used to describe it:
 * title 0.22, description 0.26, mechanism 0.22, audience 0.15, problem 0.15.
 */
export function similarity(a, b) {
  const title = dice(a.titleShingles, b.titleShingles);
  const desc = jaccard(a.descShingles, b.descShingles);
  const mech = jaccard(a.mechShingles, b.mechShingles);
  const audience = jaccard(a.audienceShingles, b.audienceShingles);
  const problem = jaccard(a.problemShingles, b.problemShingles);
  let raw = 0.22 * title + 0.26 * desc + 0.22 * mech + 0.15 * audience + 0.15 * problem;

  // Core agreement floor: if the headline and the core mechanism both match, the
  // idea is substantially similar no matter how the description was reworded or
  // which vertical it was pointed at. Without this, a paraphrase hides a twin.
  const coreAgreement = Math.min(title, mech);
  if (coreAgreement >= 0.5) raw = Math.max(raw, 0.35 + 0.45 * coreAgreement);

  const sameCategory = a.category === b.category ? 1 : 0.92;
  return Math.min(1, raw * sameCategory);
}

/**
 * In-memory similarity index over existing ideas.
 * Scanning is bounded (`maxScan`) and pre-filtered by shared tokens so a bank of
 * thousands of ideas stays fast enough to run on every generated idea.
 */
export class SimilarityIndex {
  constructor({ maxScan = 4000, minTokenOverlap = 2 } = {}) {
    this.items = []; // newest last
    this.byId = new Map();
    this.tokenPostings = new Map(); // token -> Set(id)
    this.maxScan = maxScan;
    this.minTokenOverlap = minTokenOverlap;
  }

  size() {
    return this.items.length;
  }

  clear() {
    this.items = [];
    this.byId.clear();
    this.tokenPostings.clear();
  }

  add(idea) {
    const fp = fingerprint(idea);
    if (this.byId.has(fp.id)) this.remove(fp.id);
    this.items.push(fp);
    this.byId.set(fp.id, fp);
    for (const tok of fp.bodyTokens) {
      let set = this.tokenPostings.get(tok);
      if (!set) {
        set = new Set();
        this.tokenPostings.set(tok, set);
      }
      set.add(fp.id);
    }
    while (this.items.length > this.maxScan) {
      const evicted = this.items.shift();
      this.remove(evicted.id);
    }
    return fp;
  }

  remove(id) {
    const fp = this.byId.get(id);
    if (!fp) return;
    this.byId.delete(id);
    const i = this.items.indexOf(fp);
    if (i >= 0) this.items.splice(i, 1);
    for (const tok of fp.bodyTokens) {
      const set = this.tokenPostings.get(tok);
      if (set) {
        set.delete(id);
        if (!set.size) this.tokenPostings.delete(tok);
      }
    }
  }

  /** Candidate ids sharing at least `minTokenOverlap` tokens, newest first. */
  candidates(fp, limit = 220) {
    const counts = new Map();
    for (const tok of fp.bodyTokens) {
      const set = this.tokenPostings.get(tok);
      if (!set) continue;
      for (const id of set) {
        if (id === fp.id) continue;
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    const list = [...counts.entries()]
      .filter(([, n]) => n >= this.minTokenOverlap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.byId.get(id))
      .filter(Boolean);
    if (list.length) return list;
    // Fallback: recent window (cheap, keeps detection working on tiny banks)
    return this.items.filter((x) => x.id !== fp.id).slice(-60);
  }

  /**
   * Find ideas similar to `idea`. Two bands: >= 0.72 is a near-duplicate,
   * >= 0.38 is a related variation worth showing but not conflating.
   * @returns {Array<{id:string, similarity:number, kind:'duplicate'|'variant'}>}
   */
  findSimilar(idea, { duplicateThreshold = 0.72, variantThreshold = 0.38, limit = 6 } = {}) {
    const fp = idea.bodyTokens ? idea : fingerprint(idea);
    const out = [];
    for (const other of this.candidates(fp)) {
      const s = similarity(fp, other);
      if (s >= variantThreshold) {
        out.push({
          id: other.id,
          similarity: Math.round(s * 1000) / 1000,
          kind: s >= duplicateThreshold ? 'duplicate' : 'variant',
        });
      }
    }
    out.sort((a, b) => b.similarity - a.similarity);
    return out.slice(0, limit);
  }
}

/** Stable content key used for evaluation caching. */
export function ideaContentKey(idea) {
  const norm = [idea.title, idea.description, idea.mechanism, idea.targetUser, idea.category]
    .map((x) => tokenize(x).join(' '))
    .join('|');
  return hashString(norm).toString(36);
}

/** "Most unusual" ranking signal: rarity of an idea's vocabulary vs the bank. */
export function unusualness(idea, documentFrequency = new Map(), corpusSize = 1) {
  const tokens = tokenize(`${idea.title} ${idea.description} ${idea.mechanism || ''}`);
  if (!tokens.length) return 0;
  let score = 0;
  for (const t of new Set(tokens)) {
    const df = documentFrequency.get(t) || 0;
    score += Math.log(1 + corpusSize / (1 + df));
  }
  return Math.round((score / new Set(tokens).size) * 1000) / 1000;
}
