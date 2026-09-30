/**
 * Batched evaluation (EXPERIMENTAL): K ideas per evaluator call.
 *
 * The default is one idea per call, because that is the most reliably calibrated
 * thing we can do. These tests pin the two promises that make K>1 safe to offer
 * at all:
 *
 *   1. it actually saves model calls (otherwise it is pointless), and
 *   2. it changes nothing about how an idea is judged - same audit, same
 *      programmatic overall, same reuse shortcuts, same per-idea failure
 *      isolation.
 *
 * A simulator cannot reproduce a real model's cross-contamination between ideas
 * sharing a prompt, so test 4 asserts score-neutrality *by construction* rather
 * than claiming batching is quality-neutral on real models. That question is what
 * scripts/bench-k.mjs exists to answer on the user's own hardware.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idealab-batcheval-'));
process.env.IDEALAB_DATA_DIR = dir;
process.env.IDEALAB_PROVIDER = 'demo';

const { createApp, patchSettings, shutdown } = await import('../server/src/app.js');
const { getProvider } = await import('../server/src/providers/index.js');
const { DEFAULT_SETTINGS } = await import('../server/src/config.js');
const { computeOverall } = await import('../server/src/pipeline/scoring.js');
const { bus } = await import('../server/src/lib/bus.js');
const { sleep } = await import('../server/src/lib/util.js');

const MODEL = 'idealab-sim-1b';
const ctx = createApp();
// One worker so grouping is deterministic and call counts are exact.
patchSettings(ctx, {
  provider: 'demo',
  model: MODEL,
  performance: { evaluateConcurrency: 1, maxReviewDepth: 500, reuseEvaluationForNearDuplicates: false },
  pipeline: { biasCheckEvery: 500, recombination: false, dedupe: false },
});

const provider = getProvider('demo');
const realComplete = provider.complete.bind(provider);

/** Every evaluator call the pipeline actually made, with its batch size. */
let calls = [];
function spy() {
  calls = [];
  provider.complete = async (opts) => {
    if (opts.role === 'evaluator') {
      const batched = !!opts.schema?.properties?.evaluations;
      const n = batched ? opts.schema.properties.evaluations.minItems : 1;
      calls.push({ batched, n, model: opts.model, maxTokens: opts.maxTokens, numCtx: opts.numCtx });
    }
    return realComplete(opts);
  };
}
function unspy() {
  provider.complete = realComplete;
}

function setK(k, extra = {}) {
  patchSettings(ctx, { performance: { evaluationsPerCall: k, evaluateConcurrency: 1, ...extra } });
}

/** Distinct ideas - no near-duplicates, so nothing can shortcut a model call. */
function ideaSet(n, salt = '') {
  return Array.from({ length: n }, (_, i) => ({
    title: `Idea ${salt}${i + 1}: a ${['sensor', 'ledger', 'router', 'kiosk', 'clinic', 'depot', 'studio', 'relay'][i % 8]} for ${['harbour ice', 'night buses', 'grain drying', 'deaf theatregoers', 'wildfire smoke', 'rural dialysis', 'tide pooling', 'shift handover'][i % 8]}`,
    description: `${salt}${i + 1}. A deliberately specific proposal about ${['harbour ice', 'night buses', 'grain drying', 'deaf theatregoers', 'wildfire smoke', 'rural dialysis', 'tide pooling', 'shift handover'][i % 8]} that no other idea in this set mentions, written long enough to survive normalization and distinct enough that similarity scoring does not treat it as a twin of its neighbours.`,
    category: ['hardware', 'civic', 'agriculture', 'accessibility', 'climate', 'health', 'environment', 'workforce'][i % 8],
    problem: `Nobody currently coordinates ${['harbour ice', 'night buses', 'grain drying', 'deaf theatregoers', 'wildfire smoke', 'rural dialysis', 'tide pooling', 'shift handover'][i % 8]} ${salt}${i + 1} well.`,
    mechanism: `A ${['sensor', 'ledger', 'router', 'kiosk', 'clinic', 'depot', 'studio', 'relay'][i % 8]} network numbered ${salt}${i + 1} that records, ranks and routes the relevant events.`,
    targetUser: `operators ${salt}${i + 1}`,
    businessModel: 'per-site subscription',
    distribution: 'direct to municipal buyers',
  }));
}

/** Admit a set, wait for review to settle, return the stored records. */
async function run(ideas, { mode = 'fast', model = MODEL } = {}) {
  // Pause while admitting, because grouping is "take up to K of whatever is
  // queued right now": without this a worker snatches the first idea before the
  // rest arrive and the exact call counts below become a timing lottery. In the
  // live pipeline groups fill on their own - review is slower than generation, so
  // the backlog is deep by the time a worker frees up.
  ctx.reviews.pause();
  const ids = ideas.map((idea, i) => ctx.engine.admit(idea, { mode, model: Array.isArray(model) ? model[i] : model }).id);
  ctx.reviews.resume();
  await ctx.reviews.drain();
  return ids.map((id) => ctx.repo.get(id));
}

function clearEvalCache() {
  ctx.engine.evalCache.map.clear();
}

afterEach(async () => {
  unspy();
  ctx.reviews.resume();
  await ctx.reviews.drain();
  clearEvalCache();
  // Restore everything a test may have flipped - including when it threw halfway
  // through, which is how one failing assertion used to poison the next tests.
  setK(1);
  patchSettings(ctx, { performance: { reuseEvaluationForNearDuplicates: false }, pipeline: { dedupe: false } });
});

// ---------------------------------------------------------------------------

test('K=1 is the default and out-of-range values clamp back into 1..4', () => {
  assert.equal(DEFAULT_SETTINGS.performance.evaluationsPerCall, 1, 'one idea per call must be the default');
  assert.equal(DEFAULT_SETTINGS.performance.evaluateConcurrency, 2, 'review workers must default conservatively');

  for (const [input, expected] of [[0, 1], [-3, 1], [9, 4], [2.4, 2], ['x', 1], [null, 1], [undefined, 1], [3, 3]]) {
    const next = patchSettings(ctx, { performance: { evaluationsPerCall: input } });
    assert.equal(next.performance.evaluationsPerCall, expected, `K=${JSON.stringify(input)} should clamp to ${expected}`);
  }
  setK(1);
});

test('K=4 spends one evaluator call per four ideas instead of one per idea', async () => {
  const ideas = ideaSet(8, 'a');

  spy();
  setK(1);
  const solo = await run(ideas);
  const soloCalls = calls.length;
  clearEvalCache();

  spy();
  setK(4);
  const batched = await run(ideaSet(8, 'a'));
  const batchCalls = calls.slice();

  assert.equal(solo.length, 8);
  assert.equal(batched.length, 8);
  assert.ok(solo.every((r) => r.scoringState === 'scored'), 'every idea scored at K=1');
  assert.ok(batched.every((r) => r.scoringState === 'scored'), 'every idea scored at K=4');

  assert.equal(soloCalls, 8, 'K=1 must make one call per idea');
  assert.equal(batchCalls.length, 2, 'K=4 must make one call per four ideas');
  assert.ok(batchCalls.every((c) => c.batched && c.n === 4), 'both calls should be batches of four');
  // The batch needs room for K judgments, or it gets truncated and ideas are lost.
  assert.ok(batchCalls.every((c) => c.maxTokens > DEFAULT_SETTINGS.performance.maxTokensEvaluate), 'batched calls must widen the token budget');
});

test('the overall score is still computed programmatically at K=4', async () => {
  spy();
  setK(4);
  const records = await run(ideaSet(6, 'b'));
  const weights = ctx.engine.weights();

  assert.equal(calls.length, 2, 'six ideas at K=4 is two calls: one of four, one of two');
  assert.deepEqual(calls.map((c) => c.n), [4, 2], 'groups fill up to K, then take what is left');
  for (const r of records) {
    assert.ok([4, 2].includes(r.evaluation.batch), `the evaluation should record its batch size, got ${r.evaluation.batch}`);
    const { overall } = computeOverall(r.evaluation.factors, weights);
    assert.equal(r.score.overall, overall, 'stored overall must equal the deterministic computation from audited factors');
    assert.equal(r.score.overall, Math.round(overall * 10) / 10, 'one decimal place');
    assert.ok(Number.isFinite(r.score.overall) && r.score.overall >= 1 && r.score.overall <= 10);
  }
});

test('the same ideas score identically at K=1 and K=4 (guards are shared, not duplicated)', async () => {
  const ideas = ideaSet(6, 'c');

  spy();
  setK(1);
  const solo = await run(ideas);
  clearEvalCache();

  spy();
  setK(4);
  const batched = await run(ideaSet(6, 'c'));

  assert.equal(solo.length, batched.length);
  const byTitle = new Map(batched.map((r) => [r.title, r]));
  let adjustmentsSeen = 0;

  for (const s of solo) {
    const b = byTitle.get(s.title);
    assert.ok(b, `batched run should contain ${s.title}`);
    assert.deepEqual(b.evaluation.factors, s.evaluation.factors, 'audited factors must match at K=1 and K=4');
    assert.deepEqual(b.evaluation.adjustments, s.evaluation.adjustments, 'calibration adjustments must be identical');
    assert.deepEqual(b.evaluation.warnings, s.evaluation.warnings, 'evidence warnings must be identical');
    assert.equal(b.score.overall, s.score.overall, 'overall must be identical');
    assert.equal(b.score.grade, s.score.grade);
    assert.deepEqual(b.score.color, s.score.color, 'score colour is derived from the number, so it must match too');
    assert.equal(b.evaluation.whyNotHigher, s.evaluation.whyNotHigher);
    adjustmentsSeen += (s.evaluation.adjustments || []).length;
  }
  assert.deepEqual(batched.map((r) => r.evaluation.batch).sort(), [2, 2, 4, 4, 4, 4], 'each evaluation records the size of the group it was judged in');
  assert.equal(solo.every((r) => !r.evaluation.batch), true, 'K=1 evaluations are not marked as batched');
  // Not a vacuous comparison: these are real, varied judgments rather than
  // identical placeholders that would agree no matter how they were produced.
  const spread = [...new Set(solo.map((r) => r.score.overall))];
  assert.ok(spread.length >= 3, `the compared ideas should span a range of scores, got ${spread.join(', ')}`);
  void adjustmentsSeen;
});

test('a short batch does not lose ideas - the missing ones get their own call', async () => {
  setK(4);
  // Answer with only two of the four judgments, the way an under-instructed model
  // does. Drop onItem as well, or the stream delivers all four before this
  // truncated response object is ever read.
  let truncated = false;
  calls = [];
  provider.complete = async (opts) => {
    const batched = opts.role === 'evaluator' && !!opts.schema?.properties?.evaluations;
    if (opts.role === 'evaluator') {
      calls.push({ batched, n: batched ? opts.schema.properties.evaluations.minItems : 1, model: opts.model });
    }
    if (batched && !truncated) {
      truncated = true;
      const res = await realComplete({ ...opts, onItem: undefined, itemArrayKey: undefined });
      const kept = res.object.evaluations.slice(0, 2);
      return { ...res, object: { evaluations: kept }, items: undefined };
    }
    return realComplete(opts);
  };

  const records = await run(ideaSet(4, 'd'));

  assert.equal(truncated, true, 'the batch should have been attempted');
  assert.ok(records.every((r) => r.scoringState === 'scored'), 'no idea may be left unscored because its batch came back short');
  assert.equal(calls.filter((c) => c.batched).length, 1, 'one batched call');
  assert.equal(calls.filter((c) => !c.batched).length, 2, 'the two missing ideas should fall back to single-idea calls');
  const stats = ctx.stats.summary();
  assert.ok(stats.evalBatchFallbacks >= 2, 'fallbacks must be visible in the stats');
});

test('the eval cache still short-circuits a batch', async () => {
  spy();
  setK(4);

  const ideas = ideaSet(4, 'e');
  await run(ideas);
  assert.equal(calls.length, 1, 'four ideas at K=4 is one call');

  // Same content again: the cache must serve it without any model call.
  spy();
  const again = await run(ideaSet(4, 'e'));
  assert.equal(calls.length, 0, 'cached evaluations must not spend a call, batched or not');
  assert.ok(again.every((r) => r.evaluation.reuse?.kind === 'cache'), 'reuse should be recorded');
  assert.ok(again.every((r) => r.scoringState === 'scored'));
});

test('near-duplicate reuse still applies, and does not consume a batch slot', async () => {
  spy();
  setK(4);
  patchSettings(ctx, { performance: { reuseEvaluationForNearDuplicates: true, nearDuplicateEvalThreshold: 0.9 } });

  const records = await run(ideaSet(4, 'j'));

  assert.ok(records.every((r) => r.scoringState === 'scored'));
  const reused = records.filter((r) => r.evaluation.reuse?.kind === 'near-duplicate');
  assert.ok(calls.length < 4, `twins must be reused instead of re-judged (calls=${calls.length})`);
  assert.ok(reused.length > 0, 'at least one near-duplicate should have been reused');
  assert.ok(reused.every((r) => Number.isFinite(r.evaluation.reuse.similarity)), 'reuse records the similarity it matched at');
});

/** An evaluator that always over-scores with no evidence, to force the audit. */
function inflatedEvaluator(FACTORS) {
  const factors = Object.fromEntries(FACTORS.map((f) => [f.key, 9.5]));
  const justifications = Object.fromEntries(FACTORS.map((f) => [f.key, 'Huge.'], []));
  const judgment = () => ({
    factors,
    justifications,
    biggestStrength: 'Enormous market.',
    biggestWeakness: 'None.',
    whyNotHigher: 'Nothing.',
    priorArt: [],
    summary: 'Revolutionary.',
    verdict: 'strong',
  });
  return async (opts) => {
    const k = opts.schema?.properties?.evaluations?.minItems;
    if (k) {
      const evaluations = Array.from({ length: k }, (_, i) => ({ index: i + 1, ...judgment() }));
      return { text: '', object: { evaluations }, items: evaluations, elapsedMs: 1, model: opts.model, provider: 'demo', usage: null };
    }
    return { text: '', object: judgment(), elapsedMs: 1, model: opts.model, provider: 'demo', usage: null };
  };
}

test('the calibration audit bites exactly as hard inside a batch as it does alone', async () => {
  const { FACTORS } = await import('../server/src/pipeline/scoring.js');
  const ideas = ideaSet(4, 'k');

  const collect = async (k) => {
    setK(k);
    calls = [];
    provider.complete = async (opts) => {
      if (opts.role !== 'evaluator') return realComplete(opts);
      calls.push({ batched: !!opts.schema?.properties?.evaluations, n: opts.schema?.properties?.evaluations?.minItems || 1 });
      return inflatedEvaluator(FACTORS)(opts);
    };
    const records = await run(ideaSet(4, 'k'));
    return { records: records.map((r) => ({ title: r.title, r })), calls: calls.slice() };
  };

  const solo = await collect(1);
  clearEvalCache();
  const batched = await collect(4);

  assert.deepEqual(solo.calls.map((c) => c.n), [1, 1, 1, 1], 'K=1 spends four solo calls');
  assert.deepEqual(batched.calls.map((c) => c.n), [4], 'K=4 spends one batched call for the same four ideas');
  for (const [i, { r }] of solo.records.entries()) {
    assert.ok(r.evaluation.adjustments.length > 0, 'a 9.5-with-no-evidence judgment must be adjusted');
    assert.ok(r.score.overall < 9, `the audit must pull the inflated score down, got ${r.score.overall}`);
    assert.ok(Object.values(r.evaluation.factors).every((v) => v < 9.5), 'no factor may keep its inflated value');

    const b = batched.records[i].r;
    assert.equal(b.title, r.title);
    assert.equal(b.evaluation.batch, 4, 'this one really came from a batch');
    assert.deepEqual(b.evaluation.adjustments, r.evaluation.adjustments, 'the same adjustments, in the same order, with the same reasons');
    assert.deepEqual(b.evaluation.factors, r.evaluation.factors, 'the same audited factors');
    assert.deepEqual(b.evaluation.evidence, r.evaluation.evidence, 'the same evidence readings');
    assert.equal(b.score.overall, r.score.overall, 'the same overall score');
  }
});

test('deep-mode ideas are never batched together', async () => {
  spy();
  setK(4);
  const records = await run(ideaSet(3, 'f'), { mode: 'deep' });

  // A deep pass is several calls per idea with its own bounded concurrency, so it
  // must never be folded into a shared evaluation call. (Count is >= 3 because
  // deep re-evaluates improved children.)
  assert.equal(calls.filter((c) => c.batched).length, 0, 'no deep idea may share an evaluation call');
  assert.ok(calls.filter((c) => !c.batched).length >= 3, 'each deep idea gets its own evaluation call');
  assert.ok(records.every((r) => r.scoringState === 'scored'));
  assert.ok(records.every((r) => !r.evaluation.batch), 'deep evaluations are not marked batched');
});

test('ideas destined for different models never share an evaluator call', async () => {
  spy();
  setK(4);
  await run(ideaSet(3, 'g'), { model: ['idealab-sim-1b', 'idealab-sim-4b', 'idealab-sim-1b'] });

  assert.equal(calls.length, 2, 'one call per distinct model');
  const models = calls.map((c) => c.model).sort();
  assert.deepEqual(models, ['idealab-sim-1b', 'idealab-sim-4b']);
  const grouped = calls.find((c) => c.n > 1);
  assert.equal(grouped?.model, 'idealab-sim-1b', 'only the two same-model ideas may be grouped');
});

test('batched judgments are applied as they stream, not all at the end', async () => {
  setK(4);
  let scoredDuringCall = 0;
  const off = bus.subscribe((evt) => {
    if (evt.type === 'idea:scored') scoredDuringCall += 1;
  });

  provider.complete = async (opts) => {
    const res = await realComplete(opts);
    if (opts.role === 'evaluator' && opts.schema?.properties?.evaluations) {
      // The stream already delivered the judgments; a real model would still be
      // finishing the response here. Anything scored by now was scored early.
      await new Promise((r) => setTimeout(r, 60));
    }
    return res;
  };

  const records = await run(ideaSet(4, 'h'));
  off();

  assert.ok(records.every((r) => r.scoringState === 'scored'));
  assert.ok(scoredDuringCall >= 1, 'at least one idea should be scored before the batched call returns');
});

test('staggered arrivals still share one call, thanks to the bounded gather window', async () => {
  spy();
  setK(4);
  // Ideas do not land in one synchronous burst in real life: a generation call
  // streams them out over a second or two. Without a short gather window every
  // worker would fire a solo call and batching would never engage.
  const ids = [];
  for (const idea of ideaSet(4, 'n')) {
    ids.push(ctx.engine.admit(idea, { mode: 'fast', model: MODEL }).id);
    await sleep(25); // well inside the gather idle window, like a streaming burst
  }
  await ctx.reviews.drain();

  assert.equal(calls.length, 1, `four ideas 30ms apart should share one call, got ${calls.length}`);
  assert.equal(calls[0].n, 4, 'and that call should carry all four');
  assert.ok(ids.every((id) => ctx.repo.get(id).scoringState === 'scored'));
});

test('drain() never resolves while a batch is still being judged', async () => {
  setK(4);
  // Regression guard: an await between shifting a task off the queue and marking
  // it in flight made it invisible to drain(), so drain() could resolve with work
  // still outstanding and the caller would read an unscored idea.
  for (let round = 0; round < 3; round += 1) {
    const ids = [];
    for (const idea of ideaSet(4, `o${round}`)) {
      ids.push(ctx.engine.admit(idea, { mode: 'fast', model: MODEL }).id);
      if (round % 2 === 0) await sleep(20);
    }
    await ctx.reviews.drain();
    const states = ids.map((id) => ctx.repo.get(id)?.scoringState);
    assert.deepEqual(states, ['scored', 'scored', 'scored', 'scored'], `round ${round}: every idea must be scored by the time drain() resolves`);
    clearEvalCache();
  }
});

test('a failed batched call does not mark K ideas failed when they can be retried alone', async () => {
  setK(4);
  let failedBatch = false;
  provider.complete = async (opts) => {
    if (opts.role === 'evaluator' && opts.schema?.properties?.evaluations && !failedBatch) {
      failedBatch = true;
      const err = new Error('model returned 500');
      err.retryable = false;
      throw err;
    }
    return realComplete(opts);
  };

  const records = await run(ideaSet(4, 'i'));

  assert.equal(failedBatch, true);
  assert.ok(records.every((r) => r.scoringState === 'scored'), 'every idea should survive a failed batch via its own single call');
  assert.equal(records.filter((r) => r.evaluation.batch === 4).length, 0, 'none of them should claim to be batched');
});

await shutdown(ctx);
fs.rmSync(dir, { recursive: true, force: true });
