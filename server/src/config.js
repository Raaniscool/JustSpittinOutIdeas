/**
 * IdeaLab configuration.
 *
 * Everything here can be overridden at runtime from the UI (persisted in
 * data/settings.json) or from environment variables for headless use.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
export const DATA_DIR = process.env.IDEALAB_DATA_DIR
  ? path.resolve(process.env.IDEALAB_DATA_DIR)
  : path.join(ROOT, 'data');

const envInt = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const envFloat = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const DEFAULT_SETTINGS = {
  // ---- provider / model -------------------------------------------------
  provider: process.env.IDEALAB_PROVIDER || 'ollama',
  model: process.env.IDEALAB_MODEL || '', // '' = first model reported by provider
  ollama: {
    host: process.env.OLLAMA_HOST || process.env.IDEALAB_OLLAMA_HOST || 'http://127.0.0.1:11434',
    // keep the weights resident between bursts so we never pay load cost twice
    keepAlive: process.env.IDEALAB_KEEP_ALIVE || '30m',
    // reasoning models (qwen3, deepseek-r1, ...) burn tokens thinking; for
    // high-volume idea scanning we want the answer, not the deliberation.
    disableThinking: true,
    requestTimeoutMs: envInt(process.env.IDEALAB_TIMEOUT_MS, 180000),
  },

  // ---- throughput knobs --------------------------------------------------
  performance: {
    ideasPerGenerationCall: envInt(process.env.IDEALAB_BATCH, 6), // batch generation
    // Review (evaluation) workers. This is the queue that scores ideas after the
    // generator has moved on - it no longer gates generation.
    evaluateConcurrency: envInt(process.env.IDEALAB_EVAL_CONCURRENCY, 3),
    // How far review may fall behind generation before the generator waits.
    maxReviewDepth: envInt(process.env.IDEALAB_REVIEW_DEPTH, 120),
    // deep mode only: attack + improve (+ children) per idea, bounded separately
    deepConcurrency: envInt(process.env.IDEALAB_DEEP_CONCURRENCY, 2),
    generateConcurrency: envInt(process.env.IDEALAB_GEN_CONCURRENCY, 1),
    numCtxGenerate: envInt(process.env.IDEALAB_CTX_GEN, 3072),
    numCtxEvaluate: envInt(process.env.IDEALAB_CTX_EVAL, 2048),
    numCtxDeep: envInt(process.env.IDEALAB_CTX_DEEP, 3072),
    maxTokensGenerate: envInt(process.env.IDEALAB_MAXTOK_GEN, 1400),
    maxTokensEvaluate: envInt(process.env.IDEALAB_MAXTOK_EVAL, 900),
    maxTokensDeep: envInt(process.env.IDEALAB_MAXTOK_DEEP, 1200),
    temperatureGenerate: envFloat(process.env.IDEALAB_TEMP_GEN, 1.0),
    temperatureEvaluate: envFloat(process.env.IDEALAB_TEMP_EVAL, 0.2),
    stream: true, // process ideas incrementally instead of waiting for a batch
    reuseEvaluationForNearDuplicates: true, // skip a model call for ~identical ideas
    nearDuplicateEvalThreshold: 0.9,
    evalCacheTtlMs: 1000 * 60 * 60 * 12,
  },

  // ---- pipeline ----------------------------------------------------------
  pipeline: {
    mode: 'fast', // 'fast' | 'deep'
    category: 'any',
    continuous: false,
    continuousBatch: 10,
    recombination: true, // deliberately recombine Knowledge Bank components
    recombinationRate: 0.6, // share of generation calls seeded by a KB combo
    dedupe: true,
    biasCheckEvery: 25, // ideas between meta-analyzer runs
    // Deep mode only spends improve+re-evaluate tokens on ideas worth it.
    deepImproveThreshold: envFloat(process.env.IDEALAB_DEEP_THRESHOLD, 6),
  },

  // ---- scoring -----------------------------------------------------------
  scoring: {
    weights: {
      novelty: 0.15,
      usefulness: 0.15,
      problemSeverity: 0.1,
      feasibility: 0.1,
      technicalDifficulty: 0.05, // negative factor: harder == worse
      monetization: 0.15,
      marketPotential: 0.1,
      differentiation: 0.1,
      aiLeverage: 0.05,
      defensibility: 0.05,
    },
    // Brutal calibration guards. A high score must be *earned* with concrete
    // reasoning or the system lowers it deterministically.
    calibration: {
      enforceEvidence: true,
      evidenceMinChars: 55,
      maxPenalty: 1.4,
      hardCapWithoutJustification: 5.5,
      noveltyRequiresPriorArt: true,
      noveltyCapWithoutPriorArt: 6.4,
      autoStrictness: true, // raise pressure when the distribution inflates
      inflatedMeanThreshold: 7.0,
      inflatedTopShareThreshold: 0.2, // share of ideas >= 8
      harshMeanThreshold: 3.4,
      windowSize: 200,
    },
  },

  ui: {
    sort: 'overall',
    density: 'comfortable',
  },
};

export const CATEGORIES = [
  'any',
  'software',
  'ai',
  'developer-tools',
  'education',
  'productivity',
  'business',
  'science',
  'engineering',
  'automation',
  'consumer',
  'research',
  'weird',
];

export const IDEA_STATUSES = ['new', 'starred', 'researching', 'building', 'archived', 'rejected'];

export const DEEP_ACTIONS = ['improve', 'mutate', 'attack', 'develop', 'research', 'reevaluate'];

export const PORT = envInt(process.env.PORT, 8787);
// '' = every interface, dual-stack (IPv4 + IPv6). Set HOST=0.0.0.0 to force IPv4.
export const HOST = process.env.HOST || '';
export const PROMPT_VERSION = 'idealab-prompts-v3';
