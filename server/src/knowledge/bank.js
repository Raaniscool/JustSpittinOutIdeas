/**
 * The Knowledge Bank.
 *
 * A persistent library of reusable building blocks (problems, technologies,
 * business models, distribution channels, monetisation mechanisms, audiences)
 * that generation deliberately recombines: problem + technology + audience +
 * business model => new idea.
 *
 * The important rule: the bank does NOT fill itself with unsupported AI claims.
 * Extracted components are gated -
 *   - they must be traceable to real generated ideas (evidence.ideaIds),
 *   - quantitative/market claims without a source are quarantined as
 *     "unverified" and never enter a prompt,
 *   - new components start as "candidate" and only become "verified" after a
 *     second independent idea supports them, or after the user promotes them.
 */
import { hashString, pick } from '../lib/util.js';
import { KINDS, SEED_ENTRIES } from './seed.js';

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Patterns that indicate a factual/quantitative claim needing a source. */
const CLAIM_PATTERNS = [
  [/\$\s?\d/, 'dollar figure'],
  [/\b\d+(\.\d+)?\s?%/, 'percentage'],
  [/\b\d+(\.\d+)?\s?(k|m|bn|billion|million|thousand)\b/i, 'scale figure'],
  [/\bmarket (size|worth|value)\b/i, 'market sizing'],
  [/\b(proven|guaranteed|ensures|always works|studies show|research shows|data shows)\b/i, 'unsubstantiated proof claim'],
  [/\b\d+(\.\d+)?x\b/i, 'multiplier claim'],
  [/\b(roi|payback)\b.*\b\d/i, 'ROI claim'],
  [/\b\d+\s?(users|customers|downloads|installs)\b/i, 'adoption claim'],
  [/\bcagr\b/i, 'growth rate claim'],
];

export function detectClaims(entry) {
  const text = [entry.description, ...(entry.strengths || []), ...(entry.weaknesses || []), ...(entry.examples || [])]
    .filter(Boolean)
    .join(' . ');
  const hits = [];
  for (const [re, label] of CLAIM_PATTERNS) if (re.test(text)) hits.push(label);
  return [...new Set(hits)];
}

export class KnowledgeBank {
  /** @param {import('../lib/store.js').JsonStore} store */
  constructor(store) {
    this.store = store;
    this.entries = new Map();
    if (!this.store.data || !Array.isArray(this.store.data.entries)) {
      this.store.data = { entries: [], version: 1 };
    }
    this.#bootstrap();
  }

  #bootstrap() {
    if (!this.store.data.seeded) {
      for (const e of SEED_ENTRIES) this.store.data.entries.push(this.#make(e, { origin: 'builtin', status: 'verified' }));
      this.store.data.seeded = true;
      this.store.save();
    }
    for (const e of this.store.data.entries) this.entries.set(e.id, e);
  }

  #make(input, { origin = 'manual', status = 'candidate', evidence = { ideaIds: [] }, source = '' } = {}) {
    const kind = KINDS.includes(input.kind) ? input.kind : 'problem';
    const id = input.id || `kb-${kind}-${slug(input.name) || 'entry'}-${hashString(`${kind}|${input.name}|${Date.now()}`).toString(36).slice(0, 5)}`;
    return {
      id,
      kind,
      name: String(input.name || '').trim().slice(0, 90),
      description: String(input.description || '').trim().slice(0, 400),
      examples: (input.examples || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6),
      strengths: (input.strengths || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6),
      weaknesses: (input.weaknesses || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6),
      // Only a real citation counts as a source. "manual"/"extracted" is an
      // origin, not evidence - otherwise the claim quarantine never fires.
      source: input.source || (origin === 'builtin' ? 'seed (hand-written for IdeaLab)' : source || ''),
      origin,
      status,
      supportCount: Array.isArray(evidence?.ideaIds) ? new Set(evidence.ideaIds).size : 0,
      evidence: { ideaIds: [...new Set(evidence?.ideaIds || [])].slice(0, 40) },
      claimFlags: [],
      usageCount: input.usageCount || 0,
      addedAt: input.addedAt || Date.now(),
    };
  }

  #commit() {
    this.store.data.entries = [...this.entries.values()];
    this.store.save();
  }

  list({ kind, status, q, limit = 500 } = {}) {
    let out = [...this.entries.values()];
    if (kind && kind !== 'all') out = out.filter((e) => e.kind === kind);
    if (status && status !== 'all') out = out.filter((e) => e.status === status);
    if (q) {
      const needle = norm(q);
      out = out.filter((e) => norm(e.name).includes(needle) || norm(e.description).includes(needle));
    }
    out.sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));
    return out.slice(0, limit);
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  findByName(name, kind) {
    const n = norm(name);
    for (const e of this.entries.values()) {
      if (norm(e.name) === n && (!kind || e.kind === kind)) return e;
    }
    return null;
  }

  add(input, { origin = 'manual', status = 'verified', evidence = { ideaIds: [] } } = {}) {
    const existing = this.findByName(input.name, input.kind);
    if (existing) return { entry: existing, created: false };
    const entry = this.#make(input, { origin, status, evidence });
    const flags = detectClaims(entry);
    if (flags.length && !entry.source) {
      entry.claimFlags = flags;
      // Whatever status was asked for, an unsourced claim is quarantined. The API
      // adds manual entries without a source as 'candidate', and a candidate is
      // one evidence merge away from 'verified' - which is how a made-up market
      // size used to reach the prompts that seed generation.
      entry.status = 'unverified';
    }
    this.entries.set(entry.id, entry);
    this.#commit();
    return { entry, created: true };
  }

  update(id, patch = {}) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const next = { ...entry, ...patch, id: entry.id, kind: entry.kind };
    next.name = String(next.name || entry.name).slice(0, 90);
    const flags = detectClaims(next);
    next.claimFlags = flags;
    // Editing an entry to add an unsupported claim has to demote it whatever its
    // current status. Only demoting 'verified' left a hole: a 'candidate' edited
    // to claim "$5B market, 40% growth" kept its status and the next evidence
    // merge promoted it into the pool generation draws from.
    if (flags.length && !next.source && next.status !== 'unverified') next.status = 'unverified';
    this.entries.set(id, next);
    this.#commit();
    return next;
  }

  /**
   * Promote a candidate/unverified entry into the pool that generation may use.
   * Promotion requires either evidence from >= 2 ideas, a human source, or an
   * explicit user action (`byUser`).
   */
  promote(id, { byUser = false, source = '' } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (source) entry.source = source;
    if (byUser) {
      entry.status = 'verified';
      entry.promotedBy = 'user';
      entry.promotedAt = Date.now();
    } else if (entry.supportCount >= 2 || entry.origin === 'builtin') {
      entry.status = 'verified';
    } else {
      return { ...entry, blocked: 'needs 2 supporting ideas, a source, or manual approval' };
    }
    this.#commit();
    return entry;
  }

  remove(id) {
    const existed = this.entries.delete(id);
    if (existed) this.#commit();
    return existed;
  }

  /**
   * Ingest model-extracted components with gating.
   * @param {object} extraction parsed EXTRACT_SCHEMA response
   * @param {string[]} ideaIds ids that were actually shown to the extractor
   */
  ingest(extraction = {}, ideaIds = []) {
    const allowed = new Set(ideaIds);
    const accepted = [];
    const rejected = [];
    const promoted = [];
    let budget = 14;

    const kindMap = {
      problems: 'problem',
      technologies: 'technology',
      businessModels: 'business-model',
      distribution: 'distribution',
      monetization: 'monetization',
      audiences: 'audience',
    };

    for (const [key, kind] of Object.entries(kindMap)) {
      const list = Array.isArray(extraction[key]) ? extraction[key] : [];
      for (const raw of list) {
        if (budget <= 0) {
          rejected.push({ name: raw?.name, kind, reason: 'extraction budget exhausted (kept the bank small on purpose)' });
          continue;
        }
        const name = String(raw?.name || '').trim();
        if (!name || name.length < 3) {
          rejected.push({ name, kind, reason: 'missing name' });
          continue;
        }
        const ids = [...new Set((raw?.evidence?.ideaIds || []).filter((x) => allowed.has(x)))];
        if (ids.length === 0) {
          // This is the core guard: no traceable evidence => not knowledge.
          rejected.push({ name, kind, reason: 'no evidence: not traceable to any idea in the batch' });
          continue;
        }
        const description = String(raw?.description || '').trim();
        if (description.length < 12) {
          rejected.push({ name, kind, reason: 'description too vague to reuse' });
          continue;
        }

        const existing = this.findByName(name, kind);
        if (existing) {
          const before = existing.supportCount;
          existing.evidence.ideaIds = [...new Set([...existing.evidence.ideaIds, ...ids])].slice(0, 40);
          existing.supportCount = existing.evidence.ideaIds.length;
          // Re-check claims before promoting: repeated corroboration of a number
          // is not a source for it. Two ideas repeating "$2.3B market" still does
          // not make it true, so it stays out of the usable pool.
          const mergeFlags = detectClaims(existing);
          existing.claimFlags = mergeFlags;
          const promotable = existing.status === 'candidate' && existing.supportCount >= 2;
          if (promotable && mergeFlags.length && !existing.source) {
            existing.status = 'unverified';
            rejected.push({
              name: existing.name,
              kind,
              reason: `quarantined on merge: unsupported claim (${mergeFlags.join(', ')}). Corroboration is not a source - add one to promote it.`,
            });
          } else if (promotable) {
            existing.status = 'verified';
            promoted.push(existing.name);
          }
          if (existing.supportCount !== before) {
            accepted.push({ name: existing.name, kind, note: 'merged into existing entry' });
            this.#commit();
          }
          continue;
        }

        const entry = this.#make(
          {
            kind,
            name,
            description,
            examples: raw?.examples || [],
            strengths: raw?.strengths || [],
            weaknesses: raw?.weaknesses || [],
          },
          { origin: 'extracted', status: 'candidate', evidence: { ideaIds: ids } },
        );
        const flags = detectClaims(entry);
        if (flags.length) {
          entry.status = 'unverified';
          entry.claimFlags = flags;
          rejected.push({
            name,
            kind,
            reason: `quarantined: unsupported claim (${flags.join(', ')}). Add a source to promote it.`,
          });
          this.entries.set(entry.id, entry);
          continue;
        }
        this.entries.set(entry.id, entry);
        accepted.push({ id: entry.id, name, kind, status: entry.status });
        budget--;
      }
    }
    this.#commit();
    return { accepted, rejected, promoted };
  }

  /** Verified entries only - the pool generation is allowed to draw from. */
  usable(kind) {
    return this.list({ status: 'verified', kind, limit: 10000 });
  }

  /**
   * Sample a deliberate recombination seed.
   * Underrated components are favoured so the bank does not collapse onto the
   * same few blocks (which would show up as bias).
   */
  sampleCombo(rng = Math.random, { kinds = KINDS, explore = 0.6 } = {}) {
    const combo = {};
    const touched = [];
    for (const kind of kinds) {
      const pool = this.usable(kind);
      if (!pool.length) continue;
      let entry;
      if (rng() < explore) {
        // least-used first, with a little randomness
        const sorted = [...pool].sort((a, b) => a.usageCount - b.usageCount);
        const head = sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.35)));
        entry = pick(rng, head);
      } else {
        entry = pick(rng, pool);
      }
      if (!entry) continue;
      const field = kind === 'business-model' ? 'businessModel' : kind;
      combo[field] = entry.name;
      touched.push(entry);
    }
    return { combo, entries: touched };
  }

  recordUsage(entries = []) {
    let changed = false;
    for (const e of entries) {
      const entry = this.entries.get(e.id);
      if (entry) {
        entry.usageCount = (entry.usageCount || 0) + 1;
        entry.lastUsedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.#commit();
  }

  namesByKind() {
    const out = {};
    for (const kind of KINDS) out[kind] = this.usable(kind).map((e) => e.name);
    return out;
  }

  stats() {
    const byKind = {};
    const byStatus = { verified: 0, candidate: 0, unverified: 0 };
    for (const e of this.entries.values()) {
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    }
    return {
      total: this.entries.size,
      byKind,
      byStatus,
      quarantined: this.list({ status: 'unverified', limit: 10000 }).map((e) => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        flags: e.claimFlags,
      })),
      candidates: this.list({ status: 'candidate', limit: 10000 }).length,
      mostUsed: this.list({ limit: 8 }).map((e) => ({ name: e.name, kind: e.kind, usageCount: e.usageCount })),
    };
  }
}
