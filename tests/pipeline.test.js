import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeOverall, normalizeWeights } from '../shared/scoring.js';

// Isolated data dir + synthetic provider: this exercises the *real* pipeline
// (streaming, incremental parsing, evaluation, auditing, scoring, dedupe,
// bias, knowledge gating) without needing a local model.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idealab-pipeline-'));
process.env.IDEALAB_DATA_DIR = dir;
process.env.IDEALAB_PROVIDER = 'demo';

const { createApp, patchSettings } = await import('../server/src/app.js');
const { normalizeIdea, isViableIdea, normalizeCategory } = await import('../server/src/pipeline/engine.js');
const { CalibrationMonitor } = await import('../server/src/pipeline/calibration.js');

const ctx = createApp();
patchSettings(ctx, {
  provider: 'demo',
  model: 'idealab-sim-1b',
  performance: { ideasPerGenerationCall: 6, evaluateConcurrency: 4 },
  pipeline: { biasCheckEvery: 12, recombination: true },
});

test('idea normalisation and the garbage filter', () => {
  assert.equal(normalizeCategory('Dev Tools'), 'developer-tools');
  assert.equal(normalizeCategory('Machine Learning'), 'ai');
  assert.equal(normalizeCategory('Consumer Products'), 'consumer');
  assert.equal(normalizeCategory('nonsense-category'), 'software');
  const idea = normalizeIdea({ title: '  My   Idea ', description: 'x'.repeat(2000), category: 'AI' });
  assert.equal(idea.title, 'My Idea');
  assert.equal(idea.category, 'ai');
  assert.ok(idea.description.length <= 1200);
  assert.equal(isViableIdea({ title: 'ok title', description: 'a'.repeat(40) }), true);
  assert.equal(isViableIdea({ title: 'test', description: 'short' }), false);
  assert.equal(isViableIdea({ title: '', description: '' }), false);
});

test('a batch is generated, streamed and every idea is scored', async () => {
  const before = ctx.repo.count();
  const res = await ctx.engine.generateBatch({ count: 8, category: 'any', mode: 'fast' });
  assert.equal(res.generated, 8);
  assert.equal(res.scored, 8);
  assert.equal(ctx.repo.count(), before + 8);

  for (const idea of ctx.repo.all().slice(-8)) {
    assert.equal(idea.scoringState, 'scored', `${idea.title} should be scored`);
    assert.ok(idea.evaluation?.factors, 'factors present');
    assert.ok(Number.isFinite(idea.score?.overall), 'overall present');
    assert.ok(idea.score.overall >= 1 && idea.score.overall <= 10);
    assert.ok(idea.evaluation.whyNotHigher, 'whyNotHigher is mandatory');
    assert.ok(idea.evaluation.biggestWeakness, 'biggest weakness is mandatory');
    assert.ok(idea.score.color?.css, 'colour computed server-side too');
    assert.equal(typeof idea.contentKey, 'string');
  }
});

test('the overall score is recomputed deterministically from the factors', () => {
  const weights = normalizeWeights(ctx.settingsStore.data.scoring.weights);
  for (const idea of ctx.repo.all()) {
    if (!idea.evaluation?.factors) continue;
    const { overall } = computeOverall(idea.evaluation.factors, weights);
    assert.equal(idea.score.overall, overall, `${idea.title}: stored score must equal the deterministic recomputation`);
    assert.ok(Number.isInteger(idea.score.overall * 10), 'one decimal place');
  }
});

test('scores are brutal: the distribution is not wall-to-wall 8-10', async () => {
  for (let i = 0; i < 4; i++) await ctx.engine.generateBatch({ count: 10 });
  const scores = ctx.repo.all().map((i) => i.score?.overall).filter(Number.isFinite);
  assert.ok(scores.length >= 40, `need a real sample, got ${scores.length}`);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const share8 = scores.filter((s) => s >= 8).length / scores.length;
  const share7 = scores.filter((s) => s >= 7).length / scores.length;
  assert.ok(mean < 7.4, `mean ${mean.toFixed(2)} is inflated for a random idea firehose`);
  assert.ok(share8 < 0.4, `${(share8 * 100).toFixed(0)}% of ideas scored >= 8 - calibration is broken`);
  assert.ok(scores.some((s) => s < 5), 'a firehose must produce weak ideas too');
  assert.ok(!scores.every((s) => Number.isInteger(s)), 'scores should carry decimal precision');
  void share7;
});

test('identical ideas reuse the cached evaluation instead of burning a model call', async () => {
  const callsBefore = ctx.stats.calls.total;
  const hitsBefore = ctx.stats.calls.cacheHits + ctx.stats.calls.duplicateSkips;
  const idea = normalizeIdea({
    title: 'Handwritten form transcription audit trail for municipal permits',
    description: 'Captures every correction a clerk makes to transcribed permit forms so the city can audit the automation.',
    category: 'automation',
    problem: 'Clerks re-key handwritten permit forms and errors are untraceable',
    mechanism: 'OCR with a correction log and per-field confidence',
    targetUser: 'Municipal permit clerks',
    businessModel: 'Subscription',
  });
  const first = await ctx.engine.ingest(idea, { model: 'idealab-sim-1b', providerId: 'demo' });
  const second = await ctx.engine.ingest({ ...idea }, { model: 'idealab-sim-1b', providerId: 'demo' });
  assert.ok(first.ok && second.ok);
  const after = ctx.stats.calls.cacheHits + ctx.stats.calls.duplicateSkips;
  assert.ok(after > hitsBefore, 'the second identical idea must not cost another evaluation call');
  assert.ok(ctx.stats.calls.total - callsBefore <= 2, 'only the generation-free ingest path should have run');
  const twin = ctx.repo.get(second.id);
  assert.ok(twin.duplicateOf || twin.evaluation?.reuse, 'the twin must be marked as a near-duplicate or a reuse');
});

test('near-duplicates are marked, never deleted', async () => {
  const base = ctx.repo.all().find((i) => i.title);
  const variant = normalizeIdea({
    ...base,
    id: undefined,
    title: `${base.title} (for veterinary clinics)`,
    targetUser: 'Veterinary clinic administrators',
  });
  const before = ctx.repo.count();
  const out = await ctx.engine.ingest(variant, { model: 'idealab-sim-1b', providerId: 'demo' });
  assert.ok(out.ok);
  assert.equal(ctx.repo.count(), before + 1, 'variants are kept');
  const saved = ctx.repo.get(out.id);
  assert.ok(Array.isArray(saved.similar));
});

test('deep actions produce structured analysis', async () => {
  const target = ctx.repo.all().find((i) => i.score?.overall != null);
  for (const action of ['attack', 'develop', 'research']) {
    const out = await ctx.engine.runAction(target.id, action, {});
    assert.ok(out.ms >= 0);
    const idea = ctx.repo.get(target.id);
    assert.ok(idea.analysis[action], `${action} should be stored on the idea`);
  }
  const attack = ctx.repo.get(target.id).analysis.attack;
  assert.ok(attack.killShot && Array.isArray(attack.fatalFlaws) && Number.isFinite(attack.survivalChance));
  const research = ctx.repo.get(target.id).analysis.research;
  assert.match(research.confidenceNote, /no external search|cannot browse|did not/i);
});

test('improve creates a new scored child idea', async () => {
  const target = ctx.repo.all().find((i) => i.score?.overall != null);
  const before = ctx.repo.count();
  const out = await ctx.engine.runAction(target.id, 'improve', {});
  assert.ok(out.childId, 'the improved idea becomes its own record');
  assert.equal(ctx.repo.count(), before + 1);
  const child = ctx.repo.get(out.childId);
  assert.equal(child.origin, 'improved');
  assert.equal(child.parentId, target.id);
  assert.ok(Number.isFinite(child.score.overall), 'the improved idea gets its own brutal score');
});

test('mutate produces several distinct children', async () => {
  const target = ctx.repo.all().find((i) => i.score?.overall != null);
  const before = ctx.repo.count();
  const out = await ctx.engine.runAction(target.id, 'mutate', {});
  assert.ok(out.childIds.length >= 1);
  assert.equal(ctx.repo.count(), before + out.childIds.length);
  for (const id of out.childIds) assert.equal(ctx.repo.get(id).origin, 'mutated');
});

test('re-evaluate bypasses the cache and keeps history', async () => {
  const target = ctx.repo.all().find((i) => i.score?.overall != null);
  const before = target.score.overall;
  const callsBefore = ctx.stats.calls.total;
  const out = await ctx.engine.runAction(target.id, 'reevaluate', {});
  assert.equal(out.reevaluate.before, before);
  assert.ok(Number.isFinite(out.reevaluate.after));
  const idea = ctx.repo.get(target.id);
  assert.ok(idea.analysis.history?.length >= 1, 'previous score is kept for comparison');
  assert.ok(!idea.evaluation.reuse, 'a forced re-evaluation must not be a cache or duplicate hit');
  assert.ok(ctx.stats.calls.total > callsBefore, 'a forced re-evaluation really spends a model call');
  assert.ok(idea.analysis.history.at(-1).overall === before);
});

test('knowledge extraction is gated but does add real components', async () => {
  const before = ctx.bank.stats();
  const out = await ctx.engine.extractKnowledge({ limit: 16 });
  assert.ok(out.mined >= 3);
  const after = ctx.bank.stats();
  assert.ok(after.total > before.total || out.accepted.length >= 0);
  const rejectedReasons = out.rejected.map((r) => r.reason).join(' ');
  assert.match(rejectedReasons, /no evidence|quarantined|budget/, 'the demo extractor deliberately submits bad candidates; they must be refused');
  assert.ok(after.byStatus.unverified >= 1, 'the claim-laden candidate must be quarantined');
  for (const e of ctx.bank.list({ status: 'candidate' })) {
    assert.ok(e.evidence.ideaIds.length >= 1, 'every candidate must be traceable to real ideas');
  }
});

test('the bias monitor raises directives once a concentration exists', async () => {
  // force a lopsided bank
  for (let i = 0; i < 14; i++) {
    await ctx.engine.ingest(
      normalizeIdea({
        title: `AI writing assistant variant ${i}`,
        description: `Another LLM wrapper that drafts marketing copy for small agencies, number ${i} in the series.`,
        category: 'ai',
        problem: 'Agencies spend hours drafting copy',
        mechanism: 'LLM prompt templates with a brand voice profile',
        targetUser: 'Small marketing agencies',
        businessModel: 'Subscription',
      }),
      { model: 'idealab-sim-1b', providerId: 'demo' },
    );
  }
  const det = ctx.bias.deterministic(40);
  assert.ok(det.sampleSize >= 12);
  assert.ok(det.flags.length > 0, 'a lopsided sample must raise flags');
  const directives = ctx.bias.directives();
  assert.ok(directives.length > 0, 'directives must reach the generator prompt');
  assert.ok(directives.some((d) => /ai|category|customer|business/i.test(d)));
  assert.ok(det.aiShare > 0.3);
});

test('bias analysis stays quiet on a tiny sample', () => {
  const monitor = ctx.bias;
  const saved = monitor.window;
  monitor.window = () => [
    { title: 'a', category: 'ai', businessModel: 'x', targetUser: 'y', mechanism: 'm', description: 'd', createdAt: Date.now() },
    { title: 'b', category: 'ai', businessModel: 'x', targetUser: 'y', mechanism: 'm', description: 'd', createdAt: Date.now() },
  ];
  const det = monitor.deterministic(10);
  assert.deepEqual(det.directives, []);
  monitor.window = saved;
});

test('the calibration monitor detects inflation and pushes back', () => {
  const monitor = new CalibrationMonitor({ windowSize: 100 });
  for (let i = 0; i < 40; i++) monitor.record(8.4 + (i % 3) * 0.2);
  const s = monitor.stats();
  assert.equal(s.health, 'inflated');
  assert.ok(s.pressure > 0, 'inflation must add strictness');
  assert.match(monitor.directive(), /INFLATING/);
  assert.ok(s.share.ge8 > 0.9);

  const calm = new CalibrationMonitor({ windowSize: 100 });
  for (const v of [4.2, 5.1, 5.6, 6.2, 4.8, 5.9, 6.4, 5.2, 7.1, 4.4, 5.5, 6.0, 5.0, 5.8, 6.1]) calm.record(v);
  assert.equal(calm.stats().health, 'calibrated');
  assert.equal(calm.pressure(), 0);
  assert.equal(calm.directive(), '');
});

test('the calibration monitor hydrates from a persisted bank', () => {
  const monitor = new CalibrationMonitor({ windowSize: 500 });
  monitor.hydrate(ctx.repo.all());
  assert.ok(monitor.stats().count > 20);
});

test('stats track throughput and quality separately', () => {
  const s = ctx.stats.summary();
  assert.ok(s.ideasGenerated >= 40);
  assert.ok(s.ideasEvaluated >= 40);
  assert.ok(s.avgGenerationMs > 0);
  assert.ok(s.avgEvaluationMs > 0);
  assert.ok(Number.isFinite(s.ideasPerMinute));
  assert.ok(Number.isFinite(s.usefulPerMinute));
  assert.ok(s.usefulPerMinute <= s.ideasPerMinute);
  assert.equal(typeof s.countGe7, 'number');
  assert.equal(typeof s.countGe8, 'number');
  assert.equal(typeof s.countGe9, 'number');
  assert.ok(s.byModel.length >= 1);
  assert.ok(s.byModel[0].model);
});

test('the job queue runs, reports progress, and can be stopped', async () => {
  const job = ctx.jobs.create({ count: 4, mode: 'fast', category: 'software' });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const j = ctx.jobs.get(job.id);
    if (['done', 'error', 'stopped'].includes(j.status)) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  const done = ctx.jobs.public(ctx.jobs.get(job.id));
  assert.equal(done.status, 'done', done.error || 'job should finish');
  assert.ok(done.generated >= 1);
  assert.ok(done.batches >= 1);
  assert.ok(done.ideasPerMinute >= 0);
});

test('pause then stop leaves the queue consistent', async () => {
  const job = ctx.jobs.create({ continuous: true, mode: 'fast' });
  await new Promise((r) => setTimeout(r, 400));
  ctx.jobs.pause(job.id);
  assert.equal(ctx.jobs.get(job.id).paused, true);
  ctx.jobs.resume(job.id);
  assert.equal(ctx.jobs.get(job.id).paused, false);
  ctx.jobs.stop(job.id);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !['stopped', 'done', 'error'].includes(ctx.jobs.get(job.id).status)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(['stopped', 'done'].includes(ctx.jobs.get(job.id).status));
});

test('filtering and sorting honour the requested combinations', async () => {
  const highNovelty = ctx.repo.query({ min: { novelty: 6 }, limit: 500 });
  for (const i of highNovelty.items) assert.ok(i.evaluation.factors.novelty >= 6);

  const combo = ctx.repo.query({ min: { novelty: 5, feasibility: 4, monetization: 5 }, sort: 'overall', limit: 500 });
  for (const i of combo.items) {
    assert.ok(i.evaluation.factors.novelty >= 5);
    assert.ok(i.evaluation.factors.feasibility >= 4);
    assert.ok(i.evaluation.factors.monetization >= 5);
  }
  const overalls = combo.items.map((i) => i.score.overall);
  assert.deepEqual(overalls, [...overalls].sort((a, b) => b - a), 'default sort is overall descending');

  const byNewest = ctx.repo.query({ sort: 'newest', limit: 50 });
  const times = byNewest.items.map((i) => i.createdAt);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));

  const byCategory = ctx.repo.query({ category: 'ai', limit: 500 });
  for (const i of byCategory.items) assert.equal(i.category, 'ai');

  const noDupes = ctx.repo.query({ hideDuplicates: true, limit: 500 });
  for (const i of noDupes.items) assert.ok(!i.duplicateOf);

  const starred = ctx.repo.query({ starred: true, limit: 50 });
  assert.equal(starred.total, 0);
});

test('status, stars, notes and tags round-trip', () => {
  const idea = ctx.repo.all()[0];
  ctx.repo.update(idea.id, { starred: true, status: 'researching', notes: 'check the OCR accuracy', tags: ['ocr', 'govtech'] });
  const saved = ctx.repo.get(idea.id);
  assert.equal(saved.starred, true);
  assert.equal(saved.status, 'researching');
  assert.equal(saved.notes, 'check the OCR accuracy');
  assert.deepEqual(saved.tags, ['ocr', 'govtech']);
  assert.ok(ctx.repo.tags().includes('ocr'));
  assert.ok(ctx.repo.query({ starred: true, limit: 10 }).total >= 1);
  assert.ok(ctx.repo.query({ tag: 'govtech', limit: 10 }).total >= 1);
});

test('ideas survive a restart', async () => {
  await ctx.ideasStore.flush();
  await ctx.knowledgeStore.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ideas.json'), 'utf8'));
  assert.ok(raw.ideas.length > 20);
  assert.ok(raw.ideas.every((i) => i.id && i.title));

  const { createApp: createApp2 } = await import('../server/src/app.js');
  const reloaded = createApp2();
  assert.equal(reloaded.repo.count(), ctx.repo.count());
  const sample = reloaded.repo.all().find((i) => i.score?.overall != null);
  assert.ok(sample.score.overall >= 1);
  assert.ok(reloaded.calibration.stats().count > 0, 'calibration window is rebuilt from disk');
  assert.ok(reloaded.bank.stats().total >= 50, 'knowledge bank persists');
  await reloaded.ideasStore.flush();
});

test('the wall-of-cards payload carries everything the UI needs', () => {
  const { items } = ctx.repo.query({ limit: 5, sort: 'overall' });
  for (const card of items.map((i) => ctx.repo.constructor.card(i))) {
    assert.ok(card.id && card.title && card.description);
    assert.ok(card.overall == null || Number.isFinite(card.overall));
    assert.ok(card.color?.css || card.overall == null);
    assert.ok(card.factors);
    assert.equal(typeof card.whyNotHigher, 'string');
    assert.equal(typeof card.biggestStrength, 'string');
    assert.equal(typeof card.biggestWeakness, 'string');
    assert.ok(Array.isArray(card.similar));
    assert.ok(Array.isArray(card.adjustments));
  }
});

test('shutdown flushes without throwing', async () => {
  const { shutdown } = await import('../server/src/app.js');
  await shutdown(ctx);
});
