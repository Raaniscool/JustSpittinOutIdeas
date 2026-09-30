/**
 * Application wiring: stores, knowledge bank, idea repository, calibration
 * monitor, bias monitor, engine and job queue. One object graph, created once.
 */
import { DEFAULT_SETTINGS } from './config.js';
import { JsonStore, flushAll } from './lib/store.js';
import { configureProviders } from './providers/index.js';
import { KnowledgeBank } from './knowledge/bank.js';
import { IdeaRepository } from './pipeline/ideas.js';
import { StatsCollector } from './pipeline/stats.js';
import { CalibrationMonitor } from './pipeline/calibration.js';
import { BiasMonitor } from './pipeline/bias.js';
import { IdeaEngine } from './pipeline/engine.js';
import { JobManager } from './pipeline/jobs.js';
import { normalizeWeights, DEFAULT_CALIBRATION } from './pipeline/scoring.js';
import { clamp } from './lib/util.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(base[k]) && isObj(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function createApp() {
  const settingsStore = new JsonStore('settings', structuredClone(DEFAULT_SETTINGS));
  settingsStore.load();
  settingsStore.data = deepMerge(structuredClone(DEFAULT_SETTINGS), settingsStore.data || {});
  settingsStore.data.scoring.weights = normalizeWeights(settingsStore.data.scoring.weights);
  settingsStore.data.scoring.calibration = { ...DEFAULT_CALIBRATION, ...(settingsStore.data.scoring.calibration || {}) };
  settingsStore.save();

  const ideasStore = new JsonStore('ideas', { ideas: [], version: 1 });
  ideasStore.load();
  const knowledgeStore = new JsonStore('knowledge', { entries: [], version: 1 });
  knowledgeStore.load();
  const biasStore = new JsonStore('bias', { lastRunAt: 0, lastSampleSize: 0, llm: null });
  biasStore.load();

  const bank = new KnowledgeBank(knowledgeStore);
  const repo = new IdeaRepository(ideasStore);
  const stats = new StatsCollector();
  const calibration = new CalibrationMonitor(settingsStore.data.scoring.calibration);
  calibration.hydrate(repo.all());
  stats.hydrateFromIdeas(repo.all());

  const engine = new IdeaEngine({ settingsStore, repo, bank, stats, calibration, bias: null });
  const bias = new BiasMonitor({
    repo,
    store: biasStore,
    settings: () => settingsStore.data,
    callModel: (opts) => engine.callModel(opts),
  });
  engine.bias = bias;

  const jobs = new JobManager({ engine, stats });
  configureProviders(settingsStore.data, { bank });

  const ctx = {
    settingsStore,
    ideasStore,
    knowledgeStore,
    biasStore,
    stores: [settingsStore, ideasStore, knowledgeStore, biasStore],
    bank,
    repo,
    stats,
    calibration,
    bias,
    engine,
    jobs,
    startedAt: Date.now(),
  };
  return ctx;
}

/** Validate + apply a settings patch from the UI. */
export function patchSettings(ctx, patch = {}) {
  const next = deepMerge(structuredClone(ctx.settingsStore.data), patch);

  // guard rails so a typo in the UI cannot brick the pipeline
  const p = next.performance || {};
  p.ideasPerGenerationCall = clamp(Math.round(p.ideasPerGenerationCall || 6), 1, 25);
  p.evaluateConcurrency = clamp(Math.round(p.evaluateConcurrency || 3), 1, 16);
  p.generateConcurrency = clamp(Math.round(p.generateConcurrency || 1), 1, 8);
  p.numCtxGenerate = clamp(Math.round(p.numCtxGenerate || 3072), 512, 131072);
  p.numCtxEvaluate = clamp(Math.round(p.numCtxEvaluate || 2048), 512, 131072);
  p.numCtxDeep = clamp(Math.round(p.numCtxDeep || 3072), 512, 131072);
  p.maxTokensGenerate = clamp(Math.round(p.maxTokensGenerate || 1400), 128, 32768);
  p.maxTokensEvaluate = clamp(Math.round(p.maxTokensEvaluate || 900), 128, 32768);
  p.maxTokensDeep = clamp(Math.round(p.maxTokensDeep || 1200), 128, 32768);
  p.temperatureGenerate = clamp(Number(p.temperatureGenerate ?? 1), 0, 2);
  p.temperatureEvaluate = clamp(Number(p.temperatureEvaluate ?? 0.2), 0, 2);
  p.nearDuplicateEvalThreshold = clamp(Number(p.nearDuplicateEvalThreshold ?? 0.9), 0.5, 1);
  p.evalCacheTtlMs = clamp(Number(p.evalCacheTtlMs ?? 43200000), 0, 1000 * 60 * 60 * 24 * 30);
  next.performance = p;

  if (next.ollama?.host) {
    next.ollama.host = String(next.ollama.host).trim().replace(/\/+$/, '') || 'http://127.0.0.1:11434';
    if (!/^https?:\/\//.test(next.ollama.host)) next.ollama.host = `http://${next.ollama.host}`;
  }

  next.scoring.weights = normalizeWeights(next.scoring?.weights);
  next.scoring.calibration = { ...DEFAULT_CALIBRATION, ...(next.scoring.calibration || {}) };
  next.pipeline.biasCheckEvery = clamp(Math.round(next.pipeline?.biasCheckEvery || 25), 5, 500);
  next.pipeline.continuousBatch = clamp(Math.round(next.pipeline?.continuousBatch || 10), 1, 50);
  next.pipeline.deepImproveThreshold = clamp(Number(next.pipeline?.deepImproveThreshold ?? 6), 1, 10);
  next.pipeline.recombinationRate = clamp(Number(next.pipeline?.recombinationRate ?? 0.6), 0, 1);
  if (!['fast', 'deep'].includes(next.pipeline.mode)) next.pipeline.mode = 'fast';

  ctx.settingsStore.data = next;
  ctx.settingsStore.save();

  configureProviders(next, { bank: ctx.bank });
  ctx.calibration.configure(next.scoring.calibration);
  ctx.engine.syncConcurrency();
  ctx.engine.evalCache.ttlMs = next.performance.evalCacheTtlMs;
  ctx.engine._modelCache = { at: 0, model: null };
  return next;
}

export async function shutdown(ctx) {
  ctx.jobs.stopAll();
  await flushAll(ctx.stores);
}
