/**
 * Throughput architecture: generation and review are separate pipelines.
 *
 * These tests exist to pin the property the whole design rests on - the
 * generator never waits for the evaluator. Each one would fail against the old
 * batch-scoped pipeline, where a batch awaited all of its own evaluations before
 * the next batch could start.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idealab-throughput-'));
process.env.IDEALAB_DATA_DIR = dir;
process.env.IDEALAB_PROVIDER = 'demo';

const { createApp, patchSettings, shutdown } = await import('../server/src/app.js');
const { getProvider } = await import('../server/src/providers/index.js');
const { sleep } = await import('../server/src/lib/util.js');
const { normalizeIdea } = await import('../server/src/pipeline/engine.js');

const ctx = createApp();
patchSettings(ctx, {
  provider: 'demo',
  model: 'idealab-sim-1b',
  // Two review workers and slow evaluations make the decoupling observable:
  // review genuinely cannot keep up with generation, which is the real case on
  // a single local GPU.
  performance: { ideasPerGenerationCall: 6, evaluateConcurrency: 2, maxReviewDepth: 8 },
  pipeline: { biasCheckEvery: 500, recombination: false },
});

const reviews = ctx.engine.reviews;
const provider = getProvider('demo');
const realComplete = provider.complete.bind(provider);

/** Make evaluation visibly slower than generation, deterministically. */
function slowReviews(ms) {
  provider.complete = async (opts) => {
    if (opts.role === 'evaluator') await sleep(ms);
    return realComplete(opts);
  };
}
function normalReviews() {
  provider.complete = realComplete;
}

afterEach(async () => {
  normalReviews();
  reviews.resume();
  await reviews.drain();
});

test('generation returns while the ideas it produced are still unreviewed', async () => {
  slowReviews(140);
  reviews.pause(); // nothing can score while we measure the generator

  const started = Date.now();
  const res = await ctx.engine.generateBatch({ count: 12, category: 'any', mode: 'fast' });
  const genMs = Date.now() - started;

  assert.equal(res.generated, 12, 'all twelve ideas were produced');
  assert.equal(res.queued, 12, 'and handed to the review queue');
  assert.equal(res.scored, 0, 'generation did not wait for a single evaluation');
  assert.equal(reviews.depth, 12, 'the backlog is sitting in the queue, not in the generator');
  assert.ok(genMs < 12 * 140, `generation (${genMs}ms) must not include review time (~${12 * 140}ms)`);

  // Ideas are on the wall immediately, unscored, so the UI is never empty.
  const fresh = ctx.repo.all().slice(-12);
  assert.equal(fresh.length, 12);
  for (const idea of fresh) {
    assert.ok(['queued', 'scoring'].includes(idea.scoringState), `${idea.title} is pending review`);
    assert.equal(idea.score, null, 'no score yet - and that is fine');
  }

  reviews.resume();
  await reviews.drain();
  for (const idea of fresh) {
    assert.equal(idea.scoringState, 'scored', 'review catches up on its own');
    assert.ok(Number.isFinite(idea.score?.overall));
  }
});

test('the next batch starts before the previous batch has been reviewed', async () => {
  slowReviews(120);
  reviews.pause();

  const first = await ctx.engine.generateBatch({ count: 6, category: 'ai', mode: 'fast' });
  const depthAfterFirst = reviews.depth;
  const second = await ctx.engine.generateBatch({ count: 6, category: 'ai', mode: 'fast' });

  assert.equal(first.generated, 6);
  assert.equal(second.generated, 6, 'the second batch did not wait for the first batch to be scored');
  assert.equal(depthAfterFirst, 6, 'the first batch was still entirely unreviewed');
  assert.equal(reviews.depth, 12, 'both backlogs are queued');

  reviews.resume();
  await reviews.drain();
  assert.equal(reviews.depth, 0);
});

test('a continuous job keeps generating while review runs behind it', async () => {
  slowReviews(90);
  const job = ctx.jobs.create({ continuous: true, category: 'software', mode: 'fast' });

  // Watch it for a moment: generation must keep moving while reviews trail.
  let sawBacklog = false;
  let sawProgress = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 2500) {
    await sleep(80);
    const pub = ctx.jobs.public(job);
    if (pub.pendingReview > 0) sawBacklog = true;
    if (pub.generated >= 20 && pub.scored < pub.generated) sawProgress = true;
    if (pub.generated >= 30) break;
  }
  ctx.jobs.stop(job.id);
  await sleep(150);

  const pub = ctx.jobs.public(job);
  assert.ok(pub.generated >= 20, `continuous generation kept producing (got ${pub.generated})`);
  assert.ok(sawBacklog, 'review was visibly running behind generation at some point');
  assert.ok(sawProgress, 'generation outran review instead of being gated by it');
  assert.ok(pub.scored <= pub.generated, 'scores trail ideas, never lead them');

  await reviews.drain();
  const done = ctx.jobs.public(job);
  assert.equal(done.scored, done.generated, 'every generated idea is eventually reviewed');
});

test('review is bounded: the generator waits instead of piling up an unbounded backlog', async () => {
  slowReviews(160);
  reviews.pause();
  const maxDepth = reviews.maxDepth; // 8 in this suite

  // Fill the backlog by admitting ideas directly. Going through generateBatch
  // would block on the very backpressure we are about to measure.
  for (let i = 0; i < maxDepth + 2; i++) {
    const idea = normalizeIdea({
      title: `Backpressure filler ${i} for warehouse picking`,
      description: 'Deliberately queued without being generated, to fill the review backlog.',
      category: 'automation',
      problem: 'Pickers walk too far',
      mechanism: 'Route optimisation',
    });
    ctx.engine.admit(idea, { model: 'idealab-sim-1b', providerId: 'demo', mode: 'fast' });
  }
  assert.ok(reviews.depth >= maxDepth, `the backlog is over the cap (${reviews.depth} >= ${maxDepth})`);

  let resolved = false;
  const throttled = ctx.engine.generateBatch({ count: 6, category: 'any', mode: 'fast' }).then((r) => {
    resolved = true;
    return r;
  });

  await sleep(300);
  assert.equal(resolved, false, 'generation is held while review is over the cap');
  assert.ok(reviews.throttled, 'and the queue says so');

  reviews.resume(); // review catches up, which releases the generator
  const res = await throttled;
  assert.equal(resolved, true, 'generation resumes once the backlog drains to the low-water mark');
  assert.equal(res.generated, 6);
  assert.ok(!reviews.throttled, 'the throttle clears');
});

test('each idea records how long it waited for review', async () => {
  slowReviews(60);
  const before = ctx.stats.summary().avgReviewWaitMs;
  await ctx.engine.generateBatch({ count: 8, category: 'any', mode: 'fast' });
  await reviews.drain();
  const after = ctx.stats.summary();
  assert.ok(Number.isFinite(after.avgReviewWaitMs), 'avgReviewWaitMs is reported');
  assert.ok(after.avgReviewWaitMs >= 0);
  assert.ok(after.reviewedPerMinute > 0, 'review throughput is measured separately');
  assert.ok(after.generatedPerMinute > 0, 'so is generation throughput');
  void before;
});

test('deep review happens off the generation path too', async () => {
  normalReviews();
  const res = await ctx.engine.generateBatch({ count: 6, category: 'engineering', mode: 'deep' });
  assert.equal(res.queued, 6);
  assert.equal(res.scored, 0, 'deep mode does not block generation either');
  await reviews.drain();

  // Select by mode, not by position: the deep pass appends improved children
  // after their parents, so the tail of the bank is not the batch we generated.
  const deep = ctx.repo.all().filter((i) => i.mode === 'deep' && (i.origin || 'generated') === 'generated');
  assert.ok(deep.length >= 6, `the deep batch is in the bank (${deep.length})`);
  for (const idea of deep.slice(-6)) {
    assert.equal(idea.scoringState, 'scored');
    assert.ok(idea.analysis?.attack, 'the deep pass ran on the review worker, not the generator');
  }
  const derived = ctx.repo.all().filter((i) => i.origin !== 'generated' && i.parentId);
  for (const child of derived) {
    assert.equal(child.mode, 'fast', 'derived ideas are never deep-passed (no recursion)');
  }
});

test('unreviewed ideas are picked back up after a restart', async () => {
  slowReviews(120);
  reviews.pause();
  await ctx.engine.generateBatch({ count: 6, category: 'productivity', mode: 'fast' });
  const pending = ctx.repo.all().filter((i) => i.scoringState === 'queued' || i.scoringState === 'scoring');
  assert.ok(pending.length >= 1, 'there is genuinely unreviewed work on disk');
  const pendingIds = pending.map((i) => i.id);

  await ctx.ideasStore.flush();
  await shutdown(ctx); // aborts in-flight reviews; ideas stay 'queued'

  const { createApp: createApp2 } = await import('../server/src/app.js');
  const rebooted = createApp2();
  assert.ok(rebooted.reviews.depth >= 1, 'the queue rehydrated from the persisted bank');
  for (const id of pendingIds) {
    const queued = rebooted.reviews.queue.some((t) => t.ideaId === id) ||
      [...rebooted.reviews.inFlight].some((t) => t.ideaId === id);
    assert.ok(queued, `${id} was re-queued rather than silently left unscored`);
  }

  await rebooted.reviews.drain();
  for (const id of pendingIds) {
    const idea = rebooted.repo.get(id);
    assert.equal(idea.scoringState, 'scored', 'nothing is lost across a restart');
    assert.ok(Number.isFinite(idea.score?.overall));
  }
  await shutdown(rebooted);
});
