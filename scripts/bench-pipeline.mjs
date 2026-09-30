/**
 * Pipeline benchmark with a stub backend.
 *
 * The demo provider does real CPU work in one Node thread, so measuring with it
 * conflates the architecture with simulator contention. This stub is pure
 * latency behind a semaphore of P slots, which is what a local model actually is:
 * P = OLLAMA_NUM_PARALLEL. Total model work is conserved, so this shows honestly
 * what decoupling buys and what it cannot buy.
 *
 *   node scripts/bench-pipeline.mjs [ideas] [parallelSlots]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TARGET = Number(process.argv[2] || 36);
const PARALLEL = Number(process.argv[3] || 4);
const GEN_MS = Number(process.env.GEN_MS || 2500); // one call -> 6 ideas
const EVAL_MS = Number(process.env.EVAL_MS || 1800); // one call -> 1 idea judged
const BATCH = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a P-slot GPU -------------------------------------------------------
let slots = 0;
const waiting = [];
async function acquire() {
  if (slots < PARALLEL) { slots++; return; }
  await new Promise((r) => waiting.push(r));
  slots++;
}
function release() {
  slots--;
  const next = waiting.shift();
  if (next) next();
}

const FACTORS = ['novelty', 'usefulness', 'problemSeverity', 'feasibility', 'technicalDifficulty',
  'monetization', 'marketPotential', 'differentiation', 'aiLeverage', 'defensibility'];
// Ideas must be genuinely distinct, or the near-duplicate evaluation reuse (a
// real and desirable optimisation) skips the model call and the benchmark stops
// measuring evaluation cost at all.
const DOMAINS = ['freight customs', 'clinic intake', 'permit filing', 'lab assays', 'field service', 'payroll audit',
  'grant reporting', 'insurance claims', 'course accreditation', 'fleet maintenance', 'water sampling', 'estate probate'];
const TASKS = ['reconciliation', 'exception triage', 'transcription cleanup', 'evidence packaging', 'schedule adherence', 'eligibility determination'];
const MECHS = ['confidence-scored review queue', 'diff-first correction log', 'rule-plus-model handoff', 'sampling audit trail',
  'structured extraction with escalation', 'checklist-driven human handoff'];
const BUYERS = ['operations leads', 'compliance officers', 'department coordinators', 'regional managers'];
const MODELS = ['per-seat subscription', 'usage-based pricing', 'per-case fee', 'platform licence'];
let seq = 0;

function makeIdea() {
  const i = seq++;
  const d = DOMAINS[i % DOMAINS.length];
  const t = TASKS[(i * 5) % TASKS.length];
  const m = MECHS[(i * 7) % MECHS.length];
  return {
    title: `${d.slice(0, 3).toUpperCase()}-${i} ${t} copilot for ${d}`,
    description: `Sits inside the ${d} workflow and performs ${t} using a ${m}, drafting the entry from source documents and routing anything ambiguous to a ${BUYERS[i % BUYERS.length]} reviewer with the conflicting fields highlighted (#${i}).`,
    category: 'automation',
    problem: `${d} staff perform ${t} by hand across systems that do not share identifiers`,
    mechanism: m,
    targetUser: `${d} ${BUYERS[(i + 1) % BUYERS.length]}`,
    businessModel: MODELS[i % MODELS.length],
    distribution: `through the incumbent ${d} record system marketplace`,
  };
}

function makeEvaluation(idea) {
  const factors = {};
  const justifications = {};
  for (const f of FACTORS) {
    factors[f] = Math.round((4 + ((idea.title.length + f.length) % 40) / 10) * 10) / 10;
    justifications[f] = `${f} judged against named comparables in ${idea.problem || 'the stated workflow'}; the mechanism is buildable but the buyer is fragmented, which caps the score here.`;
  }
  return {
    factors,
    justifications,
    biggestStrength: justifications.usefulness,
    biggestWeakness: justifications.defensibility,
    whyNotHigher: 'Distribution cost is unresolved and an incumbent could copy the review loop, so it stays below the top band.',
    priorArt: ['Existing reconciliation suites', 'Vertical intake copilots'],
    summary: `${idea.title} is a competent play on a real workflow problem.`,
    verdict: 'ordinary',
  };
}

const stub = {
  id: 'bench-stub',
  label: 'Benchmark stub',
  description: 'Pure-latency backend behind P parallel slots.',
  capabilities: { streaming: true, synthetic: true, preload: true },
  configure() {},
  async ping() { return { reachable: true, version: 'stub-1' }; },
  async listModels() { return [{ id: 'stub-7b', name: 'stub-7b', label: 'Stub 7B', sizeBytes: 4e9 }]; },
  async preload() {},
  async complete(req) {
    await acquire();
    const t0 = Date.now();
    try {
      if (req.role === 'generator') {
        await sleep(GEN_MS);
        const ideas = Array.from({ length: BATCH }, makeIdea);
        for (const idea of ideas) req.onItem?.(idea);
        return { text: '', object: { ideas }, items: ideas, usage: { promptTokens: 900, completionTokens: 700, tokensPerSec: 40 }, elapsedMs: Date.now() - t0, model: req.model, provider: 'bench-stub' };
      }
      if (req.role === 'evaluator') {
        await sleep(EVAL_MS);
        const object = makeEvaluation({ title: req.prompt.slice(0, 40), problem: 'the stated workflow' });
        return { text: '', object, items: [], usage: { promptTokens: 700, completionTokens: 500, tokensPerSec: 40 }, elapsedMs: Date.now() - t0, model: req.model, provider: 'bench-stub' };
      }
      await sleep(600);
      return { text: '', object: {}, items: [], usage: {}, elapsedMs: Date.now() - t0, model: req.model, provider: 'bench-stub' };
    } finally {
      release();
    }
  },
};

async function run(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `idealab-bp-${mode}-${PARALLEL}-`));
  process.env.IDEALAB_DATA_DIR = dir;
  const { registerProvider, configureProviders } = await import('../server/src/providers/index.js');
  registerProvider(stub);
  const { createApp, patchSettings, shutdown } = await import('../server/src/app.js');
  const ctx = createApp();
  patchSettings(ctx, {
    provider: 'bench-stub',
    model: 'stub-7b',
    performance: { ideasPerGenerationCall: BATCH, evaluateConcurrency: 3, maxReviewDepth: 500 },
    pipeline: { recombination: false, biasCheckEvery: 5000, dedupe: false },
  });
  patchSettings(ctx, {
    performance: { reuseEvaluationForNearDuplicates: false },
  });
  configureProviders(ctx.settingsStore.data, { bank: ctx.bank });
  const reviews = ctx.engine.reviews;

  const t0 = Date.now();
  let firstIdeaAt = null;
  let firstScoreAt = null;
  let peakDepth = 0;
  const watch = setInterval(() => {
    peakDepth = Math.max(peakDepth, reviews.depth);
    if (!firstIdeaAt && ctx.repo.count() > 0) firstIdeaAt = Date.now() - t0;
    if (!firstScoreAt && ctx.repo.all().some((i) => i.scoringState === 'scored')) firstScoreAt = Date.now() - t0;
  }, 5);

  let generated = 0;
  while (generated < TARGET) {
    const r = await ctx.engine.generateBatch({ count: BATCH, category: 'automation', mode: 'fast' });
    generated += r.generated;
    if (mode === 'blocked') await reviews.drain(); // the old contract
  }
  const genDoneAt = Date.now() - t0;
  await reviews.drain();
  const totalMs = Date.now() - t0;
  clearInterval(watch);

  const s = ctx.stats.summary();
  const scored = ctx.repo.all().filter((i) => i.scoringState === 'scored').length;
  const out = {
    mode, generated, scored,
    firstIdeaAt, firstScoreAt, genDoneAt, totalMs, peakDepth,
    genPerMin: Math.round((generated / (genDoneAt / 60000)) * 10) / 10,
    endToEndPerMin: Math.round((scored / (totalMs / 60000)) * 10) / 10,
    avgWait: Math.round(s.avgReviewWaitMs),
    calls: s.calls.total,
    cacheHits: s.calls.cacheHits + s.calls.duplicateSkips,
  };
  await shutdown(ctx);
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const rows = [];
for (const mode of ['blocked', 'decoupled']) rows.push(await run(mode));

const secs = (v) => (v == null ? '—' : `${(v / 1000).toFixed(1)}s`);
console.log(`\n${TARGET} ideas · ${PARALLEL} parallel model slot${PARALLEL === 1 ? '' : 's'} · generation ${GEN_MS}ms/${BATCH} ideas · evaluation ${EVAL_MS}ms/idea\n`);
const hdr = ['mode', 'first idea', 'first score', 'gen done', 'all reviewed', 'peak backlog', 'ideas/min', 'reviewed/min', 'avg wait', 'model calls', 'skipped'];
const fmt = (r) => [r.mode, secs(r.firstIdeaAt), secs(r.firstScoreAt), secs(r.genDoneAt), secs(r.totalMs), String(r.peakDepth), String(r.genPerMin), String(r.endToEndPerMin), `${r.avgWait}ms`, String(r.calls), String(r.cacheHits)];
const w = hdr.map((h, i) => Math.max(h.length, ...rows.map((r) => fmt(r)[i].length)));
const line = (cells) => cells.map((c, i) => c.padEnd(w[i])).join('  ');
console.log(line(hdr));
console.log(w.map((x) => '-'.repeat(x)).join('  '));
for (const r of rows) console.log(line(fmt(r)));

const [b, d] = rows;
const delta = (x, y) => (y ? `${(((x - y) / y) * 100).toFixed(0)}%` : '—');
console.log(`\ngeneration phase ${delta(d.genDoneAt, b.genDoneAt)} vs blocked · end-to-end ${delta(d.totalMs, b.totalMs)} vs blocked · first idea ${delta(d.firstIdeaAt, b.firstIdeaAt)}`);
console.log(`model work is conserved: ${TARGET} generation ideas + ${TARGET} evaluations either way.\n`);
