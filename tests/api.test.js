import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idealab-api-'));

let server;
const json = async (p, opts = {}) => {
  const res = await fetch(BASE + p, {
    ...opts,
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { text };
  }
  return { status: res.status, data, headers: res.headers };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('boot the server', async () => {
  server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', IDEALAB_DATA_DIR: dataDir, IDEALAB_PROVIDER: 'demo', IDEALAB_MODEL: 'idealab-sim-1b' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));

  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(600) });
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      await wait(150);
    }
  }
  assert.ok(up, `server never became healthy:\n${log}`);
});

test('GET /api/health reports provider, model and bank size', async () => {
  const { status, data } = await json('/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.provider.id, 'demo');
  assert.equal(data.provider.synthetic, true);
  assert.equal(data.model, 'idealab-sim-1b');
  assert.equal(typeof data.ideas, 'number');
});

test('GET /api/models lists what the provider actually has', async () => {
  const { data } = await json('/api/models');
  assert.ok(data.models.length >= 3);
  assert.equal(data.active, 'idealab-sim-1b');
  for (const m of data.models) {
    assert.ok(m.id && m.name);
    assert.ok(m.sizeLabel);
    assert.ok(['fast', 'balanced', 'slow'].includes(m.hint));
  }
});

test('GET /api/providers exposes the modular registry', async () => {
  const { data } = await json('/api/providers');
  const ids = data.providers.map((p) => p.id);
  assert.ok(ids.includes('ollama'), 'ollama must be available');
  assert.ok(ids.includes('demo'));
});

test('GET /api/settings ships factors, categories, statuses and actions', async () => {
  const { data } = await json('/api/settings');
  assert.equal(data.factors.length, 10);
  assert.ok(data.categories.includes('weird'));
  assert.ok(!data.categories.includes('games'), 'ideas must not be restricted to games, and games are not a category');
  assert.ok(data.statuses.includes('researching'));
  assert.deepEqual(data.actions.sort(), ['attack', 'develop', 'improve', 'mutate', 'reevaluate', 'research']);
  assert.ok(Math.abs(data.weightsSum - 1) < 1e-6);
});

test('GET /api/scoring returns the continuous colour ramp', async () => {
  const { data } = await json('/api/scoring');
  assert.equal(data.ramp.length, 40);
  const hues = data.ramp.map((r) => Number(/hsl\(([\d.]+)/.exec(r.css)[1]));
  assert.ok(hues.every((h, i) => i === 0 || h >= hues[i - 1]), 'hue must increase monotonically with score');
  assert.ok(new Set(data.ramp.map((r) => r.css)).size === 40, 'every ramp step needs its own colour');
  assert.equal(data.factors.find((f) => f.key === 'technicalDifficulty').direction, -1);
});

test('PATCH /api/settings persists model, weights and throughput knobs', async () => {
  const { data } = await json('/api/settings', {
    method: 'PATCH',
    body: { model: 'idealab-sim-4b', scoring: { weights: { novelty: 0.3 } }, performance: { evaluateConcurrency: 5, ideasPerGenerationCall: 4 } },
  });
  assert.equal(data.settings.model, 'idealab-sim-4b');
  assert.equal(data.settings.performance.evaluateConcurrency, 5);
  const sum = Object.values(data.settings.scoring.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, 'weights are renormalised on write');
  assert.ok(data.settings.scoring.weights.novelty > 0.2);

  // out-of-range values are clamped, not trusted
  const clamped = await json('/api/settings', { method: 'PATCH', body: { performance: { evaluateConcurrency: 9999, numCtxEvaluate: -5 } } });
  assert.ok(clamped.data.settings.performance.evaluateConcurrency <= 16);
  assert.ok(clamped.data.settings.performance.numCtxEvaluate >= 512);

  await json('/api/settings', { method: 'PATCH', body: { model: 'idealab-sim-1b', performance: { evaluateConcurrency: 4 } } });
});

test('POST /api/jobs generates and scores ideas, then reports them', async () => {
  const { data: jobRes } = await json('/api/jobs', { method: 'POST', body: { count: 5, mode: 'fast', category: 'any' } });
  assert.ok(jobRes.job.id);

  const deadline = Date.now() + 30000;
  let ideas = [];
  while (Date.now() < deadline) {
    const { data } = await json('/api/ideas?limit=50');
    ideas = data.items.filter((i) => i.scoringState === 'scored');
    if (ideas.length >= 5) break;
    await wait(200);
  }
  assert.ok(ideas.length >= 5, `expected 5 scored ideas, got ${ideas.length}`);

  for (const card of ideas) {
    assert.ok(card.title && card.description);
    assert.ok(Number.isFinite(card.overall));
    assert.match(card.color.css, /^hsl\(/);
    assert.ok(card.factors && Object.keys(card.factors).length === 10);
    assert.ok(typeof card.whyNotHigher === 'string');
    assert.ok(card.color.css !== card.color.bright, 'card needs both a fill and a legible accent');
  }

  const { data: jobs } = await json('/api/jobs');
  assert.ok(jobs.jobs.some((j) => ['done', 'running'].includes(j.status)));
});

test('GET /api/ideas filters by factor minimums, category and sorting', async () => {
  const { data: all } = await json('/api/ideas?limit=200');
  assert.ok(all.total >= 5);
  assert.ok(all.facets?.distribution);
  assert.ok(Array.isArray(all.facets.tags));

  const { data: filtered } = await json('/api/ideas?limit=200&min_novelty=6&min_feasibility=5');
  for (const i of filtered.items) {
    assert.ok(i.factors.novelty >= 6, `novelty filter violated: ${i.factors.novelty}`);
    assert.ok(i.factors.feasibility >= 5);
  }

  const { data: byCategory } = await json('/api/ideas?limit=200&category=ai');
  for (const i of byCategory.items) assert.equal(i.category, 'ai');

  const { data: sorted } = await json('/api/ideas?limit=200&sort=overall&dir=desc');
  const scores = sorted.items.map((i) => i.overall ?? -1);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));

  const { data: byUnusual } = await json('/api/ideas?limit=200&sort=unusual');
  assert.ok(byUnusual.items.length > 0);

  const { data: searched } = await json(`/api/ideas?limit=200&q=${encodeURIComponent(sorted.items[0].title.split(' ')[0])}`);
  assert.ok(searched.items.length >= 1);
});

test('GET /api/ideas/:id returns the full exploration payload', async () => {
  const { data: list } = await json('/api/ideas?limit=5');
  const id = list.items[0].id;
  const { status, data } = await json(`/api/ideas/${id}`);
  assert.equal(status, 200);
  assert.equal(data.idea.id, id);
  assert.ok(data.idea.evaluation.justifications);
  assert.ok(data.idea.score.contributions.length === 10);
  assert.ok(data.idea.score.color.css);
  assert.equal(data.noveltyIsUnverified, true, 'the API must admit novelty is unverified');
  assert.ok(data.weights);

  const missing = await json('/api/ideas/does-not-exist');
  assert.equal(missing.status, 404);
});

test('PATCH /api/ideas/:id handles stars, status, notes and tags', async () => {
  const { data: list } = await json('/api/ideas?limit=5');
  const id = list.items[0].id;

  const starred = await json(`/api/ideas/${id}`, { method: 'PATCH', body: { starred: true, status: 'researching' } });
  assert.equal(starred.data.idea.starred, true);
  assert.equal(starred.data.idea.status, 'researching');

  const noted = await json(`/api/ideas/${id}`, { method: 'PATCH', body: { notes: 'call the dental chain', tags: ['OCR', 'dental', 'ocr'] } });
  assert.equal(noted.data.idea.notes, 'call the dental chain');
  assert.deepEqual(noted.data.idea.tags, ['ocr', 'dental'], 'tags are normalised and deduped');

  const bad = await json(`/api/ideas/${id}`, { method: 'PATCH', body: { status: 'nonsense' } });
  assert.equal(bad.status, 400);

  const onlyStarred = await json('/api/ideas?limit=50&starred=1');
  assert.ok(onlyStarred.data.items.some((i) => i.id === id));
  const byTag = await json('/api/ideas?limit=50&tag=dental');
  assert.ok(byTag.data.items.some((i) => i.id === id));
});

test('POST /api/ideas/:id/action queues deep work and stores the analysis', async () => {
  const { data: list } = await json('/api/ideas?limit=5&sort=overall');
  const id = list.items[0].id;
  const { data: queued } = await json(`/api/ideas/${id}/action`, { method: 'POST', body: { action: 'attack' } });
  assert.equal(queued.job.kind, 'action');
  assert.equal(queued.job.action, 'attack');

  const bad = await json(`/api/ideas/${id}/action`, { method: 'POST', body: { action: 'party' } });
  assert.equal(bad.status, 400);

  const deadline = Date.now() + 30000;
  let detail = null;
  while (Date.now() < deadline) {
    detail = (await json(`/api/ideas/${id}`)).data;
    if (detail.idea.analysis?.attack) break;
    await wait(250);
  }
  assert.ok(detail.idea.analysis?.attack, 'attack analysis should be stored on the idea');
  assert.ok(detail.idea.analysis.attack.killShot);
  assert.ok(Array.isArray(detail.idea.analysis.attack.fatalFlaws));
});

test('improve/mutate create child ideas that are scored independently', async () => {
  const { data: list } = await json('/api/ideas?limit=5&sort=overall');
  const id = list.items[0].id;
  await json(`/api/ideas/${id}/action`, { method: 'POST', body: { action: 'mutate' } });

  const deadline = Date.now() + 40000;
  let detail = null;
  while (Date.now() < deadline) {
    detail = (await json(`/api/ideas/${id}`)).data;
    if (detail.children?.length > 0 && detail.children.every((c) => c.overall != null)) break;
    await wait(300);
  }
  assert.ok(detail.children.length >= 1, 'mutate should create children');
  for (const child of detail.children) {
    assert.equal(child.origin, 'mutated');
    assert.equal(child.parentId, id);
    assert.ok(Number.isFinite(child.overall), 'each variant gets its own brutal score');
  }
});

test('GET /api/stats reports throughput, quality gates and per-model comparison', async () => {
  const { data } = await json('/api/stats');
  const s = data.stats;
  for (const key of ['ideasGenerated', 'ideasEvaluated', 'ideasPerMinute', 'usefulPerMinute', 'avgGenerationMs', 'avgEvaluationMs', 'avgScore', 'countGe7', 'countGe8', 'countGe9']) {
    assert.ok(key in s, `stats must include ${key}`);
    assert.ok(Number.isFinite(s[key]), `${key} must be numeric`);
  }
  assert.ok(s.usefulPerMinute <= s.ideasPerMinute);
  assert.ok(data.calibration.health, 'calibration health is reported');
  assert.ok(data.calibration.histogram.length === 10);
  assert.ok(data.byModel || s.byModel.length >= 1);
  assert.ok(data.distribution.byCategory);
  assert.ok(data.bias);
  assert.ok(data.evalCache);
});

test('GET /api/bias exposes deterministic concentration and directives', async () => {
  const { data } = await json('/api/bias');
  assert.ok(data.deterministic);
  assert.ok(Array.isArray(data.deterministic.categories));
  assert.ok(typeof data.deterministic.aiShare === 'number');
  assert.ok(typeof data.deterministic.hhi === 'number');
  assert.ok(Array.isArray(data.deterministic.directives));

  const ran = await json('/api/bias/analyze', { method: 'POST' });
  assert.equal(ran.status, 200);
  assert.ok(ran.data.report.llm || ran.data.ran?.error, 'the meta-analyzer ran or reported why it could not');
});

test('the Knowledge Bank API exposes entries, stats and gating', async () => {
  const { data } = await json('/api/knowledge');
  assert.ok(data.entries.length >= 50);
  assert.ok(data.stats.byKind.problem >= 5);
  assert.ok(data.kinds.includes('monetization'));

  const mined = await json('/api/knowledge/extract', { method: 'POST', body: { limit: 12 } });
  assert.equal(mined.status, 200);
  assert.ok(Array.isArray(mined.data.accepted));
  assert.ok(Array.isArray(mined.data.rejected));

  const created = await json('/api/knowledge', {
    method: 'POST',
    body: { kind: 'problem', name: 'Test-only problem block', description: 'Added through the HTTP API during a test run.' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.entry.status, 'candidate', 'an unsourced manual entry starts as a candidate');

  const promoted = await json(`/api/knowledge/${created.data.entry.id}/promote`, { method: 'POST', body: { source: 'test' } });
  assert.equal(promoted.data.entry.status, 'verified');

  const removed = await json(`/api/knowledge/${created.data.entry.id}`, { method: 'DELETE' });
  assert.equal(removed.data.ok, true);
});

test('the SSE stream delivers live pipeline events', async () => {
  const res = await fetch(`${BASE}/events`, { headers: { accept: 'text/event-stream' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const seen = new Set();
  const deadline = Date.now() + 25000;

  await json('/api/jobs', { method: 'POST', body: { count: 3 } });

  while (Date.now() < deadline && !(seen.has('snapshot') && seen.has('idea:new') && seen.has('idea:scored'))) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = /^event: (.+)$/m.exec(frame);
      if (evt) seen.add(evt[1]);
    }
  }
  reader.cancel().catch(() => {});
  assert.ok(seen.has('snapshot'), `expected a snapshot frame, saw ${[...seen].join(',')}`);
  assert.ok(seen.has('idea:new'), 'ideas must stream to the UI as they land');
  assert.ok(seen.has('idea:scored'), 'scores must stream as soon as evaluation finishes');
});

test('the built UI is served from the same origin', async () => {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  if (fs.existsSync(path.join(root, 'web/dist/index.html'))) {
    assert.equal(res.status, 200);
    assert.match(html, /<div id="root">/);
    assert.match(html, /assets\/index-.*\.js/);
  } else {
    assert.match(html, /IdeaLab API is running/);
  }
});

test('pause and stop control a running job over HTTP', async () => {
  const { data } = await json('/api/jobs', { method: 'POST', body: { continuous: true } });
  const id = data.job.id;
  await wait(500);
  const paused = await json(`/api/jobs/${id}/pause`, { method: 'POST' });
  assert.equal(paused.data.job.paused, true);
  const resumed = await json(`/api/jobs/${id}/resume`, { method: 'POST' });
  assert.equal(resumed.data.job.paused, false);
  const stopped = await json(`/api/jobs/${id}/stop`, { method: 'POST' });
  assert.ok(stopped.data.job);
  await wait(600);
  const all = await json('/api/jobs/stop-all', { method: 'POST' });
  assert.equal(all.data.ok, true);
});

test('shut the server down', async () => {
  server.kill('SIGTERM');
  const code = await new Promise((r) => server.on('exit', r));
  assert.ok([0, null, 143].includes(code), `unexpected exit code ${code}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
