#!/usr/bin/env node
/**
 * Batched-evaluation benchmark: does judging K ideas in one call cost quality?
 *
 * Batching evaluations is a throughput lever with a real risk attached - a model
 * that sees four ideas at once tends to rank them against each other and spread
 * the scores, which is exactly the inflation/curving the calibration guards
 * fight. So this benchmark measures BOTH sides on the SAME fixed set of ideas:
 *
 *   speed    ideas reviewed/min, avg + p95 review latency, queue wait,
 *            evaluator calls spent, single-idea fallbacks
 *   quality  score distribution (mean/median/sd/percentiles), % >= 8, % >= 9,
 *            drift vs K=1 (inflation), sd ratio vs K=1 (compression), per-idea
 *            absolute deltas and Spearman rank correlation
 *   guards   audit adjustments, evidence caps, and proof the stored overall still
 *            equals the deterministic computation from the audited factors
 *
 * Every K is run against the identical idea list, with the eval cache cleared,
 * near-duplicate reuse and dedupe off, and calibration state reset - so a
 * difference in the numbers is attributable to K and nothing else.
 *
 *   node scripts/bench-k.mjs                       # demo provider, 48 ideas
 *   node scripts/bench-k.mjs --ideas 60 --rounds 3 # more ideas, average 3 runs
 *   IDEALAB_PROVIDER=ollama node scripts/bench-k.mjs --model qwen3:4b --rounds 3
 *
 * HONEST LIMITS
 * - The demo provider cannot simulate cross-contamination: it judges each idea in
 *   a batch with the same seed it would use alone, so its quality deltas are ~0 BY
 *   CONSTRUCTION. A demo run proves the guards are shared and measures throughput
 *   only. The quality answer requires your real model.
 * - It also models a batched call as costing 1 + 0.35*(K-1) of a solo call (see
 *   BATCH_COST_PER_EXTRA_IDEA in server/src/providers/demo.js). That is an
 *   assumption about token volume, not a measurement of your hardware.
 * - With a real model, one round is not enough: run --rounds 3+ and compare the
 *   drift against the round-to-round spread before believing any delta.
 * - This script never touches OLLAMA_NUM_PARALLEL. Keep --workers at or below
 *   whatever you have configured, or the extra workers just queue inside Ollama.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ----------------------------------------------------------------- CLI ----
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const flag = (name) => argv.includes(`--${name}`);

const IDEAS = Number(arg('ideas', 48));
const KS = String(arg('k', '1,2,3,4'))
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v >= 1 && v <= 4);
const WORKERS = Number(arg('workers', 2));
const ROUNDS = Number(arg('rounds', 1));
const CATEGORY = arg('category', 'any');
const MODEL = arg('model', process.env.IDEALAB_MODEL || '');
const IDEAS_FILE = arg('ideas-file', '');
const SAVE_FILE = arg('save-ideas', '');
const JSON_OUT = arg('json', '');

if (!KS.length) {
  console.error('no valid --k values (1-4)');
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idealab-benchk-'));
process.env.IDEALAB_DATA_DIR = dir;
if (!process.env.IDEALAB_PROVIDER) process.env.IDEALAB_PROVIDER = 'demo';

const { createApp, patchSettings, shutdown } = await import('../server/src/app.js');
const { CalibrationMonitor } = await import('../server/src/pipeline/calibration.js');
const { normalizeIdea } = await import('../server/src/pipeline/engine.js');
const { buildGeneratePrompt } = await import('../server/src/prompts/build.js');
const { GENERATE_SCHEMA } = await import('../server/src/prompts/schemas.js');
const { computeOverall } = await import('../server/src/pipeline/scoring.js');
const { bus } = await import('../server/src/lib/bus.js');

const PROVIDER = process.env.IDEALAB_PROVIDER;
const IS_DEMO = PROVIDER === 'demo';

// --------------------------------------------------------------- maths ----
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sd = (a) => (a.length > 1 ? Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2))) : 0);
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
};
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const avg = (i + j) / 2 + 1; // ties share the mean rank
    for (let t = i; t <= j; t += 1) out[order[t][1]] = avg;
    i = j + 1;
  }
  return out;
}
function pearson(a, b) {
  if (a.length < 2) return 1;
  const ma = mean(a);
  const mb = mean(b);
  const num = mean(a.map((v, i) => (v - ma) * (b[i] - mb)));
  const den = Math.sqrt(mean(a.map((v) => (v - ma) ** 2)) * mean(b.map((v) => (v - mb) ** 2)));
  return den === 0 ? 1 : num / den;
}
const spearman = (a, b) => pearson(ranks(a), ranks(b));

const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const pad = (v, n) => String(v).padEnd(n);
const lpad = (v, n) => String(v).padStart(n);

// ----------------------------------------------------------------- app ----
const ctx = createApp();
patchSettings(ctx, {
  provider: PROVIDER,
  ...(MODEL ? { model: MODEL } : {}),
  performance: {
    evaluateConcurrency: WORKERS,
    maxReviewDepth: 100000,
    // Both off so every idea in every run is genuinely judged by the model:
    // otherwise reuse shortcuts would hide the cost of evaluating at all.
    reuseEvaluationForNearDuplicates: false,
    evaluationsPerCall: 1,
  },
  pipeline: { biasCheckEvery: 100000, recombination: false, dedupe: false, mode: 'fast' },
});
const model = await ctx.engine.resolveModel(MODEL);
const engine = ctx.engine;
const reviews = ctx.reviews;

// Fail fast on a typo'd model. resolveModel() passes an explicit id through
// unchecked, so a missing model would otherwise surface as a wall of per-call
// failures halfway through a long benchmark run.
try {
  const installed = (await engine.provider().listModels?.()) || [];
  const ids = installed.map((m) => m.id || m.name).filter(Boolean);
  if (ids.length && model && !ids.includes(model)) {
    console.error(`\nmodel "${model}" is not installed. Available: ${ids.join(', ')}`);
    console.error('(run `node scripts/ollama-check.mjs` to see what Ollama reports)');
    await shutdown(ctx);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
} catch (err) {
  // An unreachable model server is worth a warning, not a hard stop: the runs
  // themselves will report the failures with their real cause.
  console.log(`warning: could not list installed models (${err?.message || err}) - continuing`);
}

// ------------------------------------------------------- the idea set -----
/** The fixed set every K is judged on. Generated once, reused for all runs. */
async function buildIdeaSet(count) {
  if (IDEAS_FILE && fs.existsSync(IDEAS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(IDEAS_FILE, 'utf8'));
    const list = (Array.isArray(raw) ? raw : raw.ideas || []).map(normalizeIdea).filter((i) => i.title);
    console.log(`idea set: loaded ${list.length} ideas from ${IDEAS_FILE}`);
    return list.slice(0, count);
  }

  console.log(`idea set: generating ${count} ideas with ${PROVIDER}/${model} (once, then reused for every K)...`);
  const seen = new Set();
  const ideas = [];
  let guard = 0;
  while (ideas.length < count && guard < 40) {
    guard += 1;
    const want = Math.min(8, count - ideas.length);
    const prompt = buildGeneratePrompt({
      count: want,
      category: CATEGORY,
      recentTitles: ideas.slice(-24).map((i) => i.title),
      mode: 'fast',
    });
    await engine.callModel({
      role: 'generator',
      schema: GENERATE_SCHEMA,
      prompt,
      budget: 'generate',
      model,
      itemArrayKey: 'ideas',
      onItem: (raw) => {
        const idea = normalizeIdea(raw);
        const key = idea.title.toLowerCase();
        if (idea.title && !seen.has(key)) {
          seen.add(key);
          ideas.push(idea);
        }
      },
    });
  }
  if (SAVE_FILE) {
    fs.writeFileSync(SAVE_FILE, `${JSON.stringify(ideas, null, 2)}\n`);
    console.log(`idea set: saved to ${SAVE_FILE} (reuse with --ideas-file for an identical comparison later)`);
  }
  return ideas.slice(0, count);
}

// ------------------------------------------------------------ one run -----
/**
 * Judge the whole fixed set once at a given K.
 *
 * The queue is paused while admitting so batches are fully filled: a worker takes
 * "up to K of whatever is queued right now", and in a live pipeline that is a deep
 * backlog. Pausing removes arrival timing as a variable, so the comparison is
 * about K rather than about luck.
 */
async function runOnce(ideas, k, round) {
  patchSettings(ctx, { performance: { evaluationsPerCall: k, evaluateConcurrency: WORKERS } });
  // Identical starting conditions: no cached judgments, no accumulated calibration
  // pressure from the previous K's scores.
  engine.evalCache.map.clear();
  engine.calibration = new CalibrationMonitor(ctx.settingsStore.data.scoring.calibration);
  ctx.stats.reset();
  reviews.clear();

  const admittedAt = new Map();
  const scoredAt = new Map();
  const off = bus.subscribe((evt) => {
    if (evt.type === 'idea:scored' && evt.payload?.card?.id) scoredAt.set(evt.payload.card.id, Date.now());
  });

  reviews.pause();
  const started = Date.now();
  const ids = ideas.map((idea) => engine.admit(structuredClone(idea), { mode: 'fast', model }).id);
  ids.forEach((id, i) => admittedAt.set(id, { t: started, i }));
  reviews.resume();
  await reviews.drain();
  const wallMs = Date.now() - started;
  off();

  const weights = engine.weights();
  const perIdea = [];
  let mismatchedOverall = 0;
  let adjusted = 0;
  let adjustments = 0;
  let pullDown = [];
  let evidenceCapped = 0;
  let warnings = 0;
  let failures = 0;

  ids.forEach((id, i) => {
    const rec = engine.repo.get(id);
    if (!rec || rec.scoringState !== 'scored' || !rec.evaluation) {
      failures += 1;
      return;
    }
    const overall = rec.score?.overall;
    if (!Number.isFinite(overall)) {
      failures += 1;
      return;
    }
    // Guard check: the stored overall must be the deterministic computation from
    // the audited factors, at every K.
    const { overall: recomputed } = computeOverall(rec.evaluation.factors, weights);
    if (Math.abs(recomputed - overall) > 0.051) mismatchedOverall += 1;

    const adj = rec.evaluation.adjustments || [];
    if (adj.length) {
      adjusted += 1;
      adjustments += adj.length;
      for (const a of adj) {
        const delta = Number(a?.to) - Number(a?.from);
        if (Number.isFinite(delta)) pullDown.push(delta);
        if (/justif|evidence|unsupported|vague/i.test(String(a?.reason || ''))) evidenceCapped += 1;
      }
    }
    warnings += (rec.evaluation.warnings || []).length;

    const lat = scoredAt.has(id) ? scoredAt.get(id) - admittedAt.get(id).t : null;
    perIdea.push({
      i,
      title: rec.title,
      overall,
      factors: rec.evaluation.factors,
      batch: rec.evaluation.batch || 1,
      latencyMs: lat,
    });
  });

  const stats = ctx.stats.summary({ elapsedMs: wallMs });
  const scores = perIdea.map((p) => p.overall);
  const latencies = perIdea.map((p) => p.latencyMs).filter((v) => Number.isFinite(v));

  return {
    k,
    round,
    ideas: ideas.length,
    scored: perIdea.length,
    failures,
    wallMs,
    reviewedPerMin: r1((perIdea.length / Math.max(1, wallMs)) * 60000),
    evalCalls: stats.evalCalls,
    ideasPerCall: stats.evalCalls ? r2(perIdea.length / stats.evalCalls) : 0,
    avgEvalCallMs: stats.avgEvalCallMs,
    avgEvalPerIdeaMs: stats.avgEvaluationMs,
    fallbacks: stats.evalBatchFallbacks,
    avgLatencyMs: latencies.length ? Math.round(mean(latencies)) : 0,
    p50LatencyMs: latencies.length ? Math.round(pct(latencies, 50)) : 0,
    p95LatencyMs: latencies.length ? Math.round(pct(latencies, 95)) : 0,
    avgWaitMs: stats.avgReviewWaitMs,
    maxWaitMs: stats.maxReviewWaitMs,
    scores: {
      mean: r2(mean(scores)),
      median: r2(median(scores)),
      sd: r2(sd(scores)),
      min: scores.length ? r1(Math.min(...scores)) : 0,
      max: scores.length ? r1(Math.max(...scores)) : 0,
      p10: r1(pct(scores, 10)),
      p90: r1(pct(scores, 90)),
      iqr: r2(pct(scores, 75) - pct(scores, 25)),
      ge7: scores.length ? r1((scores.filter((v) => v >= 7).length / scores.length) * 100) : 0,
      ge8: scores.length ? r1((scores.filter((v) => v >= 8).length / scores.length) * 100) : 0,
      ge9: scores.length ? r1((scores.filter((v) => v >= 9).length / scores.length) * 100) : 0,
    },
    guards: {
      adjustedIdeas: adjusted,
      adjustments,
      meanPull: pullDown.length ? r2(mean(pullDown)) : 0,
      evidenceCapped,
      warnings,
      mismatchedOverall,
    },
    tokens: stats.tokens,
    perIdea,
  };
}

// ------------------------------------------------------------- report -----
function table(title, headers, rows) {
  console.log(`\n${title}`);
  const widths = headers.map((h, c) => Math.max(String(h).length, ...rows.map((r) => String(r[c] ?? '').length)));
  console.log(headers.map((h, c) => (c === 0 ? pad(h, widths[c]) : lpad(h, widths[c]))).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(row.map((v, c) => (c === 0 ? pad(v ?? '', widths[c]) : lpad(v ?? '', widths[c]))).join('  '));
}

function histogram(scores, lo = 1, hi = 10, bins = 9) {
  const width = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of scores) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / width)));
    counts[b] += 1;
  }
  const max = Math.max(1, ...counts);
  return counts
    .map((c, i) => {
      const label = (lo + i * width).toFixed(1);
      return `${label}${'█'.repeat(Math.round((c / max) * 22))}${c ? ` ${c}` : ''}`;
    })
    .filter((_, i) => counts[i] > 0 || (i > 0 && counts[i - 1] > 0))
    .join('\n');
}

/** Aggregate rounds for one K: score stats pool every round, timings average. */
function aggregate(runs) {
  const k = runs[0].k;
  const allScores = runs.flatMap((r) => r.perIdea.map((p) => p.overall));
  const avg = (f) => r2(mean(runs.map(f)));
  const first = runs[0];
  return {
    k,
    rounds: runs.length,
    scored: first.scored,
    failures: runs.reduce((a, r) => a + r.failures, 0),
    reviewedPerMin: avg((r) => r.reviewedPerMin),
    reviewedPerMinSpread: runs.length > 1 ? r1(Math.max(...runs.map((r) => r.reviewedPerMin)) - Math.min(...runs.map((r) => r.reviewedPerMin))) : 0,
    evalCalls: avg((r) => r.evalCalls),
    ideasPerCall: avg((r) => r.ideasPerCall),
    avgEvalCallMs: Math.round(avg((r) => r.avgEvalCallMs)),
    avgEvalPerIdeaMs: Math.round(avg((r) => r.avgEvalPerIdeaMs)),
    fallbacks: runs.reduce((a, r) => a + r.fallbacks, 0),
    avgLatencyMs: Math.round(avg((r) => r.avgLatencyMs)),
    p95LatencyMs: Math.round(avg((r) => r.p95LatencyMs)),
    avgWaitMs: Math.round(avg((r) => r.avgWaitMs)),
    maxWaitMs: Math.round(avg((r) => r.maxWaitMs)),
    scores: {
      mean: r2(mean(allScores)),
      median: r2(median(allScores)),
      sd: r2(sd(allScores)),
      min: allScores.length ? r1(Math.min(...allScores)) : 0,
      max: allScores.length ? r1(Math.max(...allScores)) : 0,
      p10: r1(pct(allScores, 10)),
      p90: r1(pct(allScores, 90)),
      iqr: r2(pct(allScores, 75) - pct(allScores, 25)),
      ge7: r1((allScores.filter((v) => v >= 7).length / allScores.length) * 100),
      ge8: r1((allScores.filter((v) => v >= 8).length / allScores.length) * 100),
      ge9: r1((allScores.filter((v) => v >= 9).length / allScores.length) * 100),
    },
    guards: {
      adjustedIdeas: avg((r) => r.guards.adjustedIdeas),
      adjustments: avg((r) => r.guards.adjustments),
      meanPull: avg((r) => r.guards.meanPull),
      evidenceCapped: runs.reduce((a, r) => a + r.guards.evidenceCapped, 0),
      warnings: avg((r) => r.guards.warnings),
      mismatchedOverall: runs.reduce((a, r) => a + r.guards.mismatchedOverall, 0),
    },
    tokens: {
      prompt: runs.reduce((a, r) => a + (r.tokens?.prompt || 0), 0),
      completion: runs.reduce((a, r) => a + (r.tokens?.completion || 0), 0),
    },
    runs,
  };
}

/** Per-idea drift of one K against the K=1 baseline (matched by idea index). */
function drift(run, baseline) {
  if (!baseline || run.k === baseline.k) return null;
  const base = new Map(baseline.runs[0].perIdea.map((p) => [p.i, p.overall]));
  const pairs = [];
  for (const r of run.runs) {
    for (const p of r.perIdea) {
      const b = base.get(p.i);
      if (Number.isFinite(b)) pairs.push([b, p.overall]);
    }
  }
  if (!pairs.length) return null;
  const deltas = pairs.map(([b, v]) => v - b);
  const abs = deltas.map(Math.abs);
  const sdRatio = baseline.runs.length ? run.scores.sd / (baseline.scores.sd || 1) : 1;
  return {
    n: pairs.length,
    meanDelta: r2(mean(deltas)),
    medianDelta: r2(median(deltas)),
    meanAbs: r2(mean(abs)),
    maxAbs: r2(Math.max(...abs)),
    moved: r1((abs.filter((v) => v >= 0.2).length / abs.length) * 100),
    rankCorr: r2(spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1]))),
    sdRatio: r2(sdRatio),
    ge8Delta: r1(run.scores.ge8 - baseline.scores.ge8),
    ge9Delta: r1(run.scores.ge9 - baseline.scores.ge9),
  };
}

function verdict(d, run, baseline) {
  if (!d) return 'baseline';
  const notes = [];
  if (d.meanDelta >= 0.15) notes.push(`INFLATED +${d.meanDelta}`);
  else if (d.meanDelta <= -0.15) notes.push(`DEFLATED ${d.meanDelta}`);
  if (d.sdRatio <= 0.9) notes.push(`COMPRESSED ${Math.round((1 - d.sdRatio) * 100)}%`);
  else if (d.sdRatio >= 1.1) notes.push(`SPREAD +${Math.round((d.sdRatio - 1) * 100)}%`);
  if (d.rankCorr < 0.9) notes.push(`re-ranked (${d.rankCorr})`);
  if (d.ge8Delta >= 5) notes.push(`more 8+ (+${d.ge8Delta}pp)`);
  if (run.guards.mismatchedOverall > 0) notes.push('GUARD BROKEN');
  if (run.failures > baseline.failures) notes.push(`+${run.failures - baseline.failures} failures`);
  return notes.length ? notes.join(', ') : 'stable';
}

// ---------------------------------------------------------------- run -----
console.log(`\nIdeaLab batched-evaluation benchmark`);
console.log(`provider ${PROVIDER} | model ${model} | K values ${KS.join(', ')} | review workers ${WORKERS} | rounds ${ROUNDS}`);
if (IS_DEMO) {
  console.log('NOTE: demo provider. It judges each idea in a batch with the seed it would use');
  console.log('      alone, so quality deltas here are ~0 BY CONSTRUCTION. This run validates the');
  console.log('      shared safeguards and measures throughput - it cannot answer the quality');
  console.log('      question. For that: IDEALAB_PROVIDER=ollama node scripts/bench-k.mjs --rounds 3');
}

const ideas = await buildIdeaSet(IDEAS);
if (ideas.length < 4) {
  console.error(`only ${ideas.length} ideas - need at least 4 to batch`);
  await shutdown(ctx);
  process.exit(1);
}
console.log(`idea set: ${ideas.length} distinct ideas, identical for every K and every round`);

const results = [];
for (const k of KS) {
  const runs = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const label = ROUNDS > 1 ? ` round ${round}/${ROUNDS}` : '';
    process.stdout.write(`  K=${k}${label}: judging ${ideas.length} ideas...`);
    const run = await runOnce(ideas, k, round);
    runs.push(run);
    process.stdout.write(`\r  K=${k}${label}: ${run.scored}/${ideas.length} scored in ${secs(run.wallMs)} (${run.reviewedPerMin}/min, ${run.evalCalls} evaluator calls)   \n`);
  }
  results.push(aggregate(runs));
}

const baseline = results.find((r) => r.k === 1) || results[0];
const drifts = new Map(results.map((r) => [r.k, drift(r, baseline)]));

table('THROUGHPUT  (same ideas, same workers)', ['K', 'eval calls', 'ideas/call', 'reviewed/min', 'avg review latency', 'p95 latency', 'queue wait avg/max', 'eval ms per idea', 'fallbacks', 'fails'], [
  ...results.map((r) => [
    r.k,
    r.evalCalls,
    r.ideasPerCall,
    `${r.reviewedPerMin}${r.reviewedPerMinSpread ? ` ±${r.reviewedPerMinSpread}` : ''}`,
    secs(r.avgLatencyMs),
    secs(r.p95LatencyMs),
    `${secs(r.avgWaitMs)} / ${secs(r.maxWaitMs)}`,
    r.avgEvalPerIdeaMs,
    r.fallbacks,
    r.failures,
  ]),
]);

table('SCORE DISTRIBUTION  (pooled over rounds)', ['K', 'mean', 'median', 'sd', 'min', 'max', 'p10', 'p90', 'IQR', '>=7 %', '>=8 %', '>=9 %'], [
  ...results.map((r) => [r.k, r.scores.mean, r.scores.median, r.scores.sd, r.scores.min, r.scores.max, r.scores.p10, r.scores.p90, r.scores.iqr, r.scores.ge7, r.scores.ge8, r.scores.ge9]),
]);

table('CALIBRATION SAFEGUARDS  (must not depend on K)', ['K', 'ideas adjusted', 'adjustments', 'mean pull-down', 'evidence caps', 'warnings', 'overall != computed'], [
  ...results.map((r) => [r.k, r.guards.adjustedIdeas, r.guards.adjustments, r.guards.meanPull, r.guards.evidenceCapped, r.guards.warnings, r.guards.mismatchedOverall]),
]);

table(`DRIFT vs K=${baseline.k}  (the quality question)`, ['K', 'd mean', 'd median', 'mean |d| per idea', 'max |d|', 'ideas moved >=0.2', 'sd ratio', 'd >=8 pp', 'd >=9 pp', 'rank corr', 'verdict'], [
  ...results.map((r) => {
    const d = drifts.get(r.k);
    return d
      ? [r.k, d.meanDelta >= 0 ? `+${d.meanDelta}` : d.meanDelta, d.medianDelta, d.meanAbs, d.maxAbs, `${d.moved}%`, d.sdRatio, d.ge8Delta >= 0 ? `+${d.ge8Delta}` : d.ge8Delta, d.ge9Delta >= 0 ? `+${d.ge9Delta}` : d.ge9Delta, d.rankCorr, verdict(d, r, baseline)]
      : [r.k, '-', '-', '-', '-', '-', '1.00', '-', '-', '1.00', 'baseline'];
  }),
]);

console.log('\nSCORE HISTOGRAMS');
for (const r of results) {
  const scores = r.runs.flatMap((run) => run.perIdea.map((p) => p.overall));
  console.log(`\nK=${r.k}  (n=${scores.length})`);
  console.log(
    histogram(scores)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );
}

const guardBroken = results.some((r) => r.guards.mismatchedOverall > 0);
console.log('\nREADING THIS');
console.log(`- Safeguards: ${guardBroken ? 'BROKEN - stored overall disagreed with the deterministic computation' : 'intact at every K - the stored overall always equals computeOverall(audited factors, weights)'}.`);
if (IS_DEMO) {
  console.log('- Quality drift on the demo provider is ~0 by construction (see HONEST LIMITS above).');
  console.log('  Re-run against your real model before drawing any conclusion about inflation.');
  console.log('- The simulator is CPU-bound in one Node thread, so review workers contend and');
  console.log('  wall-clock throughput saturates: K=2, K=3 and K=4 can land within noise of each');
  console.log('  other even though the call counts differ 2:1. On the demo, trust "eval calls",');
  console.log('  "ideas/call" and "eval ms per idea"; trust "reviewed/min" only on a real model.');
} else if (ROUNDS < 3) {
  console.log(`- Only ${ROUNDS} round(s): a real model varies run to run, so treat small deltas as noise.`);
  console.log('  Re-run with --rounds 3 and compare the drift against the round spread.');
}
const callsAt1 = results.find((r) => r.k === 1)?.evalCalls || 0;
for (const r of results.filter((x) => x.k > 1)) {
  const saved = callsAt1 ? Math.round((1 - r.evalCalls / callsAt1) * 100) : 0;
  console.log(`- K=${r.k}: ${saved}% fewer evaluator calls, ${r.reviewedPerMin}/min vs ${baseline.reviewedPerMin}/min, drift "${verdict(drifts.get(r.k), r, baseline)}".`);
}
console.log('- Keep review workers <= your OLLAMA_NUM_PARALLEL. This script never changes it.');
console.log('- If drift is "stable" and throughput is better, K>1 is a reasonable experiment on');
console.log('  your hardware. If it shows INFLATED or COMPRESSED, leave evaluationsPerCall at 1.');

if (JSON_OUT) {
  fs.writeFileSync(
    JSON_OUT,
    `${JSON.stringify(
      { provider: PROVIDER, model, workers: WORKERS, rounds: ROUNDS, ideas: ideas.length, results: results.map((r) => ({ ...r, runs: r.runs.map(({ perIdea, ...rest }) => ({ ...rest, perIdea })) })) },
      null,
      2,
    )}\n`,
  );
  console.log(`\nraw metrics written to ${JSON_OUT}`);
}

await shutdown(ctx);
fs.rmSync(dir, { recursive: true, force: true });
