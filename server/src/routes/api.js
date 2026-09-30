/**
 * HTTP API. Thin layer over the app context - no business logic lives here.
 */
import express from 'express';
import { patchSettings } from '../app.js';
import { getProvider, listProviders } from '../providers/index.js';
import { IdeaRepository, SORTS } from '../pipeline/ideas.js';
import { FACTORS, DEFAULT_WEIGHTS, scoreColor, scoreGrade, DEFAULT_CALIBRATION } from '../pipeline/scoring.js';
import { CATEGORIES, IDEA_STATUSES, DEEP_ACTIONS, DEFAULT_SETTINGS } from '../config.js';
import { KINDS, KIND_LABELS } from '../knowledge/seed.js';
import { emit } from '../lib/bus.js';

const card = (i) => IdeaRepository.card(i);

export function apiRouter(ctx) {
  const r = express.Router();
  const { repo, bank, stats, calibration, bias, engine, jobs, settingsStore } = ctx;
  const settings = () => settingsStore.data;

  // ------------------------------------------------------------- system ----
  r.get('/health', async (_req, res) => {
    const provider = getProvider(settings().provider);
    const ping = await provider.ping?.().catch((e) => ({ reachable: false, error: e.message }));
    res.json({
      ok: true,
      version: '0.1.0',
      provider: { id: provider.id, label: provider.label, capabilities: provider.capabilities, synthetic: !!provider.capabilities?.synthetic },
      ollama: ping,
      model: settings().model || (await engine.resolveModel()),
      ideas: repo.count(),
      job: jobs.active(),
      time: Date.now(),
    });
  });

  r.get('/providers', (_req, res) => res.json({ providers: listProviders() }));

  r.get('/models', async (req, res) => {
    const id = req.query.provider || settings().provider;
    const provider = getProvider(id);
    try {
      const models = await provider.listModels({ force: req.query.refresh === '1' });
      res.json({
        provider: provider.id,
        models,
        active: settings().model || models[0]?.id || null,
        reachable: provider.state?.reachable ?? null,
        note: models.length
          ? null
          : provider.id === 'ollama'
            ? `Ollama is reachable but has no models installed. Try: ollama pull qwen3:1.7b`
            : null,
      });
    } catch (err) {
      res.status(200).json({ provider: provider.id, models: [], active: settings().model || null, error: err.message, reachable: false });
    }
  });

  r.post('/models/preload', async (req, res) => {
    const provider = getProvider(settings().provider);
    const model = req.body?.model || (await engine.resolveModel());
    const out = await provider.preload?.(model).catch((e) => ({ ok: false, error: e.message }));
    res.json({ model, ...out });
  });

  r.post('/models/unload', async (req, res) => {
    const provider = getProvider(settings().provider);
    const model = req.body?.model || (await engine.resolveModel());
    const out = await provider.unload?.(model).catch((e) => ({ ok: false, error: e.message }));
    res.json({ model, ...out });
  });

  // ----------------------------------------------------------- settings ----
  r.get('/settings', (_req, res) => {
    const s = settings();
    res.json({
      settings: s,
      defaults: DEFAULT_SETTINGS,
      factors: FACTORS,
      categories: CATEGORIES,
      statuses: IDEA_STATUSES,
      actions: DEEP_ACTIONS,
      sorts: Object.keys(SORTS),
      weightsSum: Object.values(s.scoring.weights).reduce((a, b) => a + b, 0),
    });
  });

  r.patch('/settings', (req, res) => {
    try {
      const next = patchSettings(ctx, req.body || {});
      res.json({ settings: next, calibration: calibration.stats() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  r.post('/settings/reset', (_req, res) => {
    const next = patchSettings(ctx, structuredClone(DEFAULT_SETTINGS));
    res.json({ settings: next });
  });

  r.get('/scoring', (_req, res) => {
    const s = settings();
    res.json({
      factors: FACTORS,
      weights: s.scoring.weights,
      defaultWeights: DEFAULT_WEIGHTS,
      calibration: { ...s.scoring.calibration, live: calibration.stats(), directive: calibration.directive() },
      defaults: DEFAULT_CALIBRATION,
      // A 40-step ramp so the UI can prove the gradient is continuous.
      ramp: Array.from({ length: 40 }, (_, i) => {
        const score = 1 + (i * 9) / 39;
        const c = scoreColor(score);
        return { score: Math.round(score * 100) / 100, css: c.css, bright: c.bright, grade: scoreGrade(score) };
      }),
    });
  });

  // --------------------------------------------------------------- jobs ----
  r.post('/jobs', (req, res) => {
    const body = req.body || {};
    if (body.action) {
      const job = jobs.create({
        kind: 'action',
        action: body.action,
        ideaId: body.ideaId,
        model: body.model,
      });
      return res.json({ job: jobs.public(job) });
    }
    const job = jobs.create({
      count: body.count ?? 10,
      continuous: !!body.continuous,
      category: body.category || settings().pipeline?.category || 'any',
      mode: body.mode || settings().pipeline?.mode || 'fast',
      model: body.model,
    });
    res.json({ job: jobs.public(job) });
  });

  r.get('/jobs', (_req, res) => res.json({ jobs: jobs.list(), active: jobs.active() }));
  r.post('/jobs/:id/pause', (req, res) => res.json({ job: jobs.pause(req.params.id) }));
  r.post('/jobs/:id/resume', (req, res) => res.json({ job: jobs.resume(req.params.id) }));
  r.post('/jobs/:id/stop', (req, res) => res.json({ job: jobs.stop(req.params.id) }));
  r.post('/jobs/stop-all', (_req, res) => {
    jobs.stopAll();
    res.json({ ok: true, jobs: jobs.list() });
  });

  // -------------------------------------------------------------- ideas ----
  r.get('/ideas', (req, res) => {
    const q = req.query;
    const min = {};
    const max = {};
    for (const key of ['overall', ...FACTORS.map((f) => f.key), 'unusualness']) {
      if (q[`min_${key}`] !== undefined) min[key] = Number(q[`min_${key}`]);
      if (q[`max_${key}`] !== undefined) max[key] = Number(q[`max_${key}`]);
    }
    const { items, total } = repo.query({
      q: q.q || '',
      category: q.category || 'all',
      status: q.status || 'all',
      tag: q.tag || '',
      starred: q.starred === '1' || q.starred === 'true',
      hideDuplicates: q.hideDuplicates === '1' || q.hideDuplicates === 'true',
      hideArchived: q.hideArchived !== '0' && q.hideArchived !== 'false',
      provider: q.provider || 'all',
      mode: q.mode || 'all',
      sort: q.sort || 'overall',
      dir: q.dir || 'desc',
      limit: Math.min(2000, Number(q.limit) || 300),
      offset: Number(q.offset) || 0,
      min,
      max,
    });
    res.json({ items: items.map(card), total, facets: { tags: repo.tags(), distribution: repo.distribution() } });
  });

  r.get('/ideas/:id', (req, res) => {
    const idea = repo.get(req.params.id);
    if (!idea) return res.status(404).json({ error: 'not found' });
    const similar = (idea.similar || [])
      .map((s) => ({ ...s, card: repo.get(s.id) ? card(repo.get(s.id)) : null }))
      .filter((s) => s.card);
    const children = repo.all().filter((i) => i.parentId === idea.id).map(card);
    const parent = idea.parentId ? repo.get(idea.parentId) : null;
    res.json({
      idea,
      color: idea.score ? scoreColor(idea.score.overall) : null,
      similar,
      children,
      parent: parent ? card(parent) : null,
      weights: settings().scoring.weights,
      noveltyIsUnverified: true,
    });
  });

  r.patch('/ideas/:id', (req, res) => {
    const body = req.body || {};
    const allowed = ['status', 'starred', 'notes', 'tags', 'title', 'description'];
    const patch = {};
    for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
    if (patch.status && !IDEA_STATUSES.includes(patch.status)) return res.status(400).json({ error: `bad status: ${patch.status}` });
    if (patch.tags) patch.tags = [...new Set((Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(','))
      .map((t) => String(t).trim().toLowerCase().slice(0, 32)).filter(Boolean))].slice(0, 24);
    const idea = repo.update(req.params.id, patch);
    if (!idea) return res.status(404).json({ error: 'not found' });
    emit('idea:updated', { card: card(idea) });
    res.json({ idea: card(idea) });
  });

  r.delete('/ideas/:id', (req, res) => {
    const ok = repo.remove(req.params.id);
    res.json({ ok });
  });

  r.post('/ideas/bulk', (req, res) => {
    const { ids = [], patch = {} } = req.body || {};
    let n = 0;
    for (const id of ids) {
      if (repo.update(id, patch)) n++;
    }
    res.json({ updated: n });
  });

  r.post('/ideas/:id/action', async (req, res) => {
    const action = req.body?.action;
    if (!DEEP_ACTIONS.includes(action)) return res.status(400).json({ error: `unknown action: ${action}` });
    // Deep work goes through the job queue so it never collides with a running batch.
    const job = jobs.create({ kind: 'action', action, ideaId: req.params.id });
    res.json({ job: jobs.public(job), queued: true });
  });

  r.post('/ideas/:id/action/sync', async (req, res) => {
    const action = req.body?.action;
    if (!DEEP_ACTIONS.includes(action)) return res.status(400).json({ error: `unknown action: ${action}` });
    try {
      const out = await engine.runAction(req.params.id, action, {});
      res.json({ ok: true, ...out, idea: repo.get(req.params.id) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------- stats ----
  r.get('/stats', (_req, res) => {
    const provider = getProvider(settings().provider);
    res.json({
      stats: stats.summary({ elapsedMs: Date.now() - ctx.startedAt }),
      calibration: calibration.stats(),
      distribution: repo.distribution(),
      bias: bias.snapshot(),
      provider: { id: provider.id, label: provider.label, synthetic: !!provider.capabilities?.synthetic, state: provider.state?.reachable },
      model: settings().model || null,
      evalCache: engine.evalCache.stats(),
      indexSize: repo.index.size(),
      uptimeMs: Date.now() - ctx.startedAt,
    });
  });

  r.post('/stats/reset', (_req, res) => {
    stats.reset();
    res.json({ stats: stats.summary() });
  });

  r.get('/bias', (_req, res) => res.json(bias.report()));
  r.post('/bias/analyze', async (req, res) => {
    try {
      const out = await bias.maybeAnalyze({ force: true });
      res.json({ report: bias.report(), ran: out });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
  r.post('/bias/reset', (_req, res) => {
    bias.reset();
    res.json(bias.report());
  });

  // ---------------------------------------------------------- knowledge ----
  r.get('/knowledge', (req, res) => {
    res.json({
      entries: bank.list({ kind: req.query.kind || 'all', status: req.query.status || 'all', q: req.query.q || '' }),
      kinds: KINDS,
      kindLabels: KIND_LABELS,
      stats: bank.stats(),
    });
  });

  r.post('/knowledge', (req, res) => {
    const body = req.body || {};
    if (!body.name) return res.status(400).json({ error: 'name is required' });
    const { entry, created } = bank.add(
      { ...body, kind: KINDS.includes(body.kind) ? body.kind : 'problem' },
      { origin: 'manual', status: body.source ? 'verified' : 'candidate', evidence: { ideaIds: [] } },
    );
    res.status(created ? 201 : 200).json({ entry, created });
  });

  r.patch('/knowledge/:id', (req, res) => {
    const entry = bank.update(req.params.id, req.body || {});
    if (!entry) return res.status(404).json({ error: 'not found' });
    res.json({ entry });
  });

  r.post('/knowledge/:id/promote', (req, res) => {
    const entry = bank.promote(req.params.id, { byUser: true, source: req.body?.source || 'approved in IdeaLab UI' });
    if (!entry) return res.status(404).json({ error: 'not found' });
    res.json({ entry });
  });

  r.delete('/knowledge/:id', (req, res) => res.json({ ok: bank.remove(req.params.id) }));

  r.post('/knowledge/extract', async (req, res) => {
    try {
      const out = await engine.extractKnowledge({ limit: Number(req.body?.limit) || 24 });
      res.json(out);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return r;
}
