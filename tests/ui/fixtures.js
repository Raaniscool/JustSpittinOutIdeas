/**
 * Realistic fixtures for the UI render smoke test.
 * Shapes match exactly what the API returns, so a component that reads a field
 * the server never sends will fail here.
 */
import { scoreColor, computeOverall, DEFAULT_WEIGHTS } from '../../shared/scoring.js';

const factors = {
  novelty: 7.1,
  usefulness: 8.8,
  problemSeverity: 7.0,
  feasibility: 7.4,
  technicalDifficulty: 4.0,
  monetization: 7.9,
  marketPotential: 8.2,
  differentiation: 6.5,
  aiLeverage: 6.0,
  defensibility: 5.0,
};
const { overall, contributions } = computeOverall(factors, DEFAULT_WEIGHTS);

export const card = {
  id: 'idea-demo-1',
  title: 'Interactive API Documentation Sandbox',
  description:
    'Lets a developer run real requests against a mocked version of an API straight from the docs, with the response diffed against the documented example.',
  category: 'developer-tools',
  overall,
  color: scoreColor(overall),
  grade: 'strong',
  factors,
  biggestStrength: 'High developer usefulness.',
  biggestWeakness: 'Existing documentation platforms create competition.',
  whyNotHigher: 'Similar products already exist and the proposed differentiation could be reproduced relatively easily.',
  summary: 'A competent developer-tool play with real demand and weak defensibility.',
  verdict: 'promising',
  adjustments: [
    { factor: 'defensibility', label: 'Defensibility', from: 6.2, to: 5.0, reason: 'Justification evidence 42% - score reduced rather than trusted.', rule: 'weak-evidence', penalty: 1.2 },
  ],
  status: 'new',
  starred: true,
  tags: ['devtools', 'api'],
  notes: 'talk to the platform team',
  duplicateOf: null,
  similar: [{ id: 'idea-demo-2', similarity: 0.61, kind: 'variant' }],
  model: 'qwen3:1.7b',
  provider: 'ollama',
  mode: 'fast',
  origin: 'generated',
  parentId: null,
  createdAt: Date.now() - 90000,
  scoringState: 'scored',
  unusualness: 2.31,
  hasAnalysis: true,
};

export const pendingCard = { ...card, id: 'idea-demo-3', title: 'Still being evaluated', scoringState: 'scoring', overall: null, color: null, factors: null, evaluation: null };
export const weakCard = { ...card, id: 'idea-demo-4', title: 'AI chatbot for recipe ideas', overall: 3.4, color: scoreColor(3.4), factors: { ...factors, novelty: 2.2, differentiation: 2.4 }, duplicateOf: 'idea-demo-1', adjustments: [] };

export const detail = {
  idea: {
    ...card,
    problem: 'Developers cannot try an endpoint without wiring up auth and a client first.',
    mechanism: 'A generated mock server from the OpenAPI spec plus a diff view against documented examples.',
    targetUser: 'Backend developers integrating a third-party API',
    businessModel: 'Per-seat subscription with a free tier',
    distribution: 'Browser extension and developer API',
    unusual: false,
    contentKey: 'abc123',
    metrics: { unusualness: 2.31 },
    timings: { evalMs: 1840, evaluatedAt: Date.now() - 60000 },
    evaluation: {
      factors,
      justifications: Object.fromEntries(
        Object.keys(factors).map((k) => [k, `Concrete justification for ${k}: incumbents already ship part of this, and the wedge is the diff view.`]),
      ),
      evidence: Object.fromEntries(Object.keys(factors).map((k) => [k, { score: 0.82, hype: 0, chars: 118 }])),
      adjustments: card.adjustments,
      warnings: ['Novelty capped: no prior art named. IdeaLab did not search the web.'],
      biggestStrength: card.biggestStrength,
      biggestWeakness: card.biggestWeakness,
      whyNotHigher: card.whyNotHigher,
      priorArt: ['Postman', 'ReadMe.io', 'Stoplight'],
      summary: card.summary,
      verdict: 'promising',
      pressure: 0,
      reuse: null,
      evaluatedAt: Date.now() - 60000,
      model: 'qwen3:1.7b',
      usage: { promptTokens: 812, completionTokens: 431, tokensPerSec: 68.4 },
    },
    score: { overall, contributions, grade: 'strong', color: scoreColor(overall), incomplete: false },
    analysis: {
      attack: {
        fatalFlaws: ['Postman already does most of this for free.'],
        failureModes: ['Mock drift from the real API.'],
        competition: ['Postman', 'ReadMe.io'],
        unitEconomics: 'Docs tooling is a small line item.',
        killShot: 'The incumbent ships the diff view in one release.',
        survivalChance: 3.4,
        conditionsToSurvive: ['Own the OpenAPI generation step.'],
        at: Date.now() - 30000,
        model: 'qwen3:1.7b',
      },
      improve: {
        improvedTitle: 'Interactive API Documentation Sandbox (v2: outcome-priced)',
        improvedDescription: 'Sold as a CI check that fails when docs drift from behaviour.',
        mechanism: 'OpenAPI diff plus recorded traffic replay.',
        targetUser: 'Platform teams',
        businessModel: 'Usage-based pricing',
        changes: ['Charges per verified endpoint, which removes the "why not Postman" objection.'],
        remainingWeaknesses: ['Needs traffic recording access.'],
        childId: 'idea-demo-5',
        at: Date.now() - 20000,
        model: 'qwen3:1.7b',
      },
      develop: {
        mvpName: 'Docs sandbox - walking skeleton',
        scope: ['One OpenAPI file, one generated mock, one diff view.'],
        explicitlyOut: ['Team features', 'Traffic recording'],
        buildSteps: ['Generate the mock server from a spec.', 'Render the docs page with a run button.'],
        technicalRequirements: ['OpenAPI parser', 'diff viewer'],
        timeToPrototype: '2-3 weeks for one developer',
        firstCustomers: ['API-first startups with public docs'],
        pricing: '$29/month per API',
        successMetric: 'Ten teams run more than 100 sandbox requests a week.',
        assumptions: ['Developers will paste their spec.'],
        at: Date.now() - 10000,
        model: 'qwen3:1.7b',
      },
      research: {
        claimsToVerify: ['That docs drift is a frequent complaint.'],
        searchQueries: ['openapi documentation sandbox tool'],
        competitorsToCheck: ['Postman', 'ReadMe.io', 'Stoplight'],
        dataSources: ['Developer surveys', 'GitHub issues on OpenAPI tooling'],
        killCriteria: ['Postman ships an equivalent diff view.'],
        confidenceNote: 'IdeaLab ran no external search. Everything above is a hypothesis generated by a local model.',
        at: Date.now() - 5000,
        model: 'qwen3:1.7b',
      },
      mutate: {
        variants: [
          { title: 'Docs drift CI check', description: 'Same problem, different wedge: a CI action.', axis: 'mechanism', category: 'developer-tools', mechanism: 'CI action', targetUser: 'Platform teams', businessModel: 'Usage-based' },
        ],
        at: Date.now() - 4000,
        model: 'qwen3:1.7b',
      },
      history: [{ overall: 7.0, factors, at: Date.now() - 100000, whyNotHigher: 'Competition.' }],
    },
  },
  color: scoreColor(overall),
  similar: [{ id: 'idea-demo-2', similarity: 0.61, kind: 'variant', card: weakCard }],
  children: [{ ...card, id: 'idea-demo-5', title: 'Docs drift CI check', overall: 6.8 }],
  parent: null,
  weights: DEFAULT_WEIGHTS,
  noveltyIsUnverified: true,
};

export const settings = {
  provider: 'ollama',
  model: 'qwen3:1.7b',
  ollama: { host: 'http://127.0.0.1:11434', keepAlive: '30m', disableThinking: true, requestTimeoutMs: 180000 },
  performance: {
    ideasPerGenerationCall: 6,
    evaluateConcurrency: 3,
    generateConcurrency: 1,
    numCtxGenerate: 3072,
    numCtxEvaluate: 2048,
    numCtxDeep: 3072,
    maxTokensGenerate: 1400,
    maxTokensEvaluate: 900,
    maxTokensDeep: 1200,
    temperatureGenerate: 1,
    temperatureEvaluate: 0.2,
    stream: true,
    reuseEvaluationForNearDuplicates: true,
    nearDuplicateEvalThreshold: 0.9,
    evalCacheTtlMs: 43200000,
  },
  pipeline: { mode: 'fast', category: 'any', continuous: false, continuousBatch: 10, recombination: true, recombinationRate: 0.6, dedupe: true, biasCheckEvery: 25, deepImproveThreshold: 6 },
  scoring: { weights: DEFAULT_WEIGHTS, calibration: { enforceEvidence: true, evidenceMinChars: 55, maxPenalty: 1.4, hardCapWithoutJustification: 5.5, noveltyRequiresPriorArt: true, noveltyCapWithoutPriorArt: 6.4, autoStrictness: true, inflatedMeanThreshold: 7, inflatedTopShareThreshold: 0.2, harshMeanThreshold: 3.4, windowSize: 200 } },
  ui: { sort: 'overall', density: 'comfortable' },
};

export const models = {
  provider: 'ollama',
  active: 'qwen3:1.7b',
  models: [
    { id: 'qwen3:1.7b', name: 'qwen3:1.7b', provider: 'ollama', family: 'qwen3', parameterSize: '1.7B', quantization: 'Q4_K_M', sizeBytes: 1.4e9, sizeLabel: '1.4 GB', hint: 'fast' },
    { id: 'qwen3:4b', name: 'qwen3:4b', provider: 'ollama', family: 'qwen3', parameterSize: '4B', quantization: 'Q4_K_M', sizeBytes: 2.5e9, sizeLabel: '2.5 GB', hint: 'fast' },
    { id: 'llama3.2:3b', name: 'llama3.2:3b', provider: 'ollama', family: 'llama', parameterSize: '3B', quantization: 'Q4_K_M', sizeBytes: 2.0e9, sizeLabel: '2.0 GB', hint: 'fast' },
    { id: 'gemma3:1b', name: 'gemma3:1b', provider: 'ollama', family: 'gemma3', parameterSize: '1B', quantization: 'Q4_K_M', sizeBytes: 0.8e9, sizeLabel: '0.8 GB', hint: 'fast' },
  ],
};

export const health = { ok: true, provider: { id: 'ollama', label: 'Ollama (local models)', synthetic: false }, ollama: { reachable: true, version: '0.9.6', host: 'http://127.0.0.1:11434' }, model: 'qwen3:1.7b', ideas: 128 };

export const stats = {
  startedAt: Date.now() - 600000,
  elapsedMs: 600000,
  ideasGenerated: 128,
  ideasEvaluated: 126,
  failures: 2,
  ideasPerMinute: 12.6,
  generatedPerMinute: 31.4,
  reviewedPerMinute: 12.6,
  avgReviewWaitMs: 4200,
  maxReviewWaitMs: 18400,
  usefulPerMinute: 1.9,
  excellentPerMinute: 0.2,
  avgGenerationMs: 4210,
  avgEvaluationMs: 1180,
  avgDeepActionMs: 2600,
  avgScore: 5.4,
  medianScore: 5.5,
  countGe7: 19,
  countGe8: 4,
  countGe9: 1,
  shareGe7: 0.15,
  shareGe8: 0.03,
  tokens: { prompt: 118000, completion: 64000 },
  avgTokensPerSec: 61.2,
  calls: { total: 210, failed: 2, retries: 1, cacheHits: 6, duplicateSkips: 3 },
  deepActions: { attack: 4, improve: 2, develop: 1, research: 1, mutate: 1 },
  byModel: [
    { model: 'qwen3:1.7b', generated: 90, evaluated: 88, failed: 1, ideasPerMinute: 14.2, usefulPerMinute: 2.1, avgGenerationMs: 3800, avgEvaluationMs: 980, avgScore: 5.3, countGe7: 12, countGe8: 3, avgTokensPerSec: 74.1 },
    { model: 'llama3.2:3b', generated: 38, evaluated: 38, failed: 1, ideasPerMinute: 6.1, usefulPerMinute: 0.8, avgGenerationMs: 7200, avgEvaluationMs: 1900, avgScore: 5.7, countGe7: 7, countGe8: 1, avgTokensPerSec: 31.4 },
  ],
};

export const calibration = {
  count: 126,
  windowSize: 200,
  mean: 5.4,
  median: 5.5,
  p90: 7.1,
  min: 2.4,
  max: 9.1,
  share: { ge6: 0.41, ge7: 0.15, ge8: 0.03, ge9: 0.01 },
  histogram: [3, 9, 18, 24, 27, 26, 12, 5, 2, 0],
  health: 'calibrated',
  pressure: 0,
  allTime: { count: 126, mean: 5.4 },
  models: [],
};

export const distribution = {
  count: 128,
  scored: 126,
  histogram: [3, 9, 18, 24, 27, 26, 12, 5, 2, 0],
  byCategory: { software: 22, ai: 31, 'developer-tools': 18, education: 9, weird: 6 },
  byStatus: { new: 118, starred: 6, researching: 3, archived: 1 },
  byModel: { 'qwen3:1.7b': 90, 'llama3.2:3b': 38 },
  byBusinessModel: { subscription: 40, 'usage-based pricing': 18 },
  byAudience: { developers: 30 },
  ge7: 19,
  ge8: 4,
  ge9: 1,
};

export const bias = {
  deterministic: {
    sampleSize: 60,
    categories: [
      { value: 'ai', count: 24, share: 0.4 },
      { value: 'software', count: 14, share: 0.23 },
      { value: 'developer-tools', count: 9, share: 0.15 },
    ],
    businessModels: [{ value: 'subscription', count: 26, share: 0.43 }],
    audiences: [{ value: 'developers', count: 22, share: 0.37 }],
    mechanisms: [{ value: 'extraction', count: 18, share: 0.3 }],
    aiShare: 0.63,
    hhi: 0.29,
    flags: [{ dimension: 'category', value: 'ai', share: 0.4, severity: 'high' }],
    directives: ['At most 1 in 5 ideas may be "ai" - it is 40% of the recent sample.', 'Include at least one idea with a hardware component.'],
    underexplored: ['science', 'weird'],
  },
  llm: {
    at: Date.now() - 120000,
    ms: 2100,
    model: 'qwen3:1.7b',
    biases: [{ dimension: 'category', value: 'ai', observedShare: 40, severity: 'high', note: 'LLM wrappers dominate.' }],
    underexplored: ['science', 'engineering'],
    directives: ['Produce ideas whose core mechanism is not a model call.'],
    summary: 'Two thirds of the sample leans on AI; business models cluster on subscription.',
  },
  lastRunAt: Date.now() - 120000,
  lastSampleSize: 120,
  running: false,
  biasCheckEvery: 25,
  ideasSinceRun: 8,
};

export const knowledge = {
  entries: [
    { id: 'kb-1', kind: 'problem', name: 'Repetitive manual data entry', description: 'People copy information between systems that do not talk to each other.', examples: ['Invoice re-keying'], strengths: ['Time cost is measurable'], weaknesses: ['Every ERP vendor claims to solve it'], source: 'seed (hand-written for IdeaLab)', origin: 'builtin', status: 'verified', supportCount: 0, evidence: { ideaIds: [] }, claimFlags: [], usageCount: 7, addedAt: Date.now() },
    { id: 'kb-2', kind: 'technology', name: 'OCR and document parsing', description: 'Converting scans, photos, and PDFs into structured text.', examples: ['Invoice capture'], strengths: ['Mature and cheap'], weaknesses: ['Accuracy drops on handwriting'], source: 'seed (hand-written for IdeaLab)', origin: 'builtin', status: 'verified', supportCount: 0, evidence: { ideaIds: [] }, claimFlags: [], usageCount: 4, addedAt: Date.now() },
    { id: 'kb-3', kind: 'monetization', name: 'Enterprise outcome pricing', description: 'The outcome pricing market is worth $2.3B and proven to grow 40% yearly.', examples: [], strengths: [], weaknesses: [], source: '', origin: 'extracted', status: 'unverified', supportCount: 1, evidence: { ideaIds: ['idea-demo-1'] }, claimFlags: ['dollar figure', 'percentage', 'unsubstantiated proof claim'], usageCount: 0, addedAt: Date.now() },
    { id: 'kb-4', kind: 'audience', name: 'Freight brokers', description: 'Intermediaries coordinating shipments between shippers and carriers.', examples: [], strengths: [], weaknesses: [], source: '', origin: 'extracted', status: 'candidate', supportCount: 1, evidence: { ideaIds: ['idea-demo-4'] }, claimFlags: [], usageCount: 0, addedAt: Date.now() },
  ],
  kinds: ['problem', 'technology', 'business-model', 'distribution', 'monetization', 'audience'],
  kindLabels: { problem: 'Problems', technology: 'Technologies', 'business-model': 'Business models', distribution: 'Distribution', monetization: 'Monetization', audience: 'Audiences' },
  stats: {
    total: 66,
    byKind: { problem: 13, technology: 13, 'business-model': 13, distribution: 12, monetization: 9, audience: 9 },
    byStatus: { verified: 63, candidate: 1, unverified: 2 },
    quarantined: [{ id: 'kb-3', name: 'Enterprise outcome pricing', kind: 'monetization', flags: ['dollar figure', 'percentage'] }],
    candidates: 1,
    mostUsed: [{ name: 'Repetitive manual data entry', kind: 'problem', usageCount: 7 }],
  },
};

export const job = {
  id: 'job-1',
  kind: 'generate',
  status: 'running',
  requested: 50,
  continuous: false,
  generated: 18,
  scored: 17,
  skipped: 1,
  failed: 0,
  batches: 3,
  category: 'any',
  mode: 'fast',
  model: 'qwen3:1.7b',
  startedAt: Date.now() - 42000,
  finishedAt: null,
  elapsedMs: 42000,
  ideasPerMinute: 25.7,
  paused: false,
  error: null,
  batchLog: [],
};

export const providers = [
  { id: 'ollama', label: 'Ollama (local models)', description: '', capabilities: {}, synthetic: false },
  { id: 'demo', label: 'Demo simulator (no model)', description: '', capabilities: { synthetic: true }, synthetic: true },
];

export const evalCache = { size: 84, hits: 6, misses: 120, max: 8000 };

/** The review queue: evaluation running behind generation, as its own stage. */
export const reviews = {
  depth: 7,
  active: 2,
  concurrency: 3,
  maxDepth: 120,
  resumeDepth: 72,
  paused: false,
  throttled: false,
  stopped: false,
  completed: 126,
  failed: 1,
  avgWaitMs: 4200,
  lastWaitMs: 3100,
  next: [{ ideaId: 'idea-demo-9', title: 'Waiting for review', mode: 'fast', jobId: 'job-1', waitedMs: 1200 }],
  running: [{ ideaId: 'idea-demo-8', title: 'Being reviewed', mode: 'fast', jobId: 'job-1', ms: 900 }],
};

export const reviewsThrottled = { ...reviews, depth: 120, active: 3, throttled: true, avgWaitMs: 41000 };
export const reviewsPaused = { ...reviews, paused: true, active: 0 };
