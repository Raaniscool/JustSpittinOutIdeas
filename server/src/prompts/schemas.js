/**
 * JSON schemas for Ollama structured output (`format`).
 *
 * Structured output is a speed feature, not just a correctness feature: the
 * model cannot waste tokens on prose, and we never pay for a retry loop when a
 * completion is unparseable. Schemas are kept deliberately small - every extra
 * property is extra decode time on a 1-4B model.
 */
import { FACTOR_KEYS } from '../pipeline/scoring.js';

export const CATEGORIES = [
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

const str = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const num = (description) => ({ type: 'number', minimum: 1, maximum: 10, ...(description ? { description } : {}) });

const ideaShape = {
  type: 'object',
  properties: {
    title: str('specific product name, <= 8 words'),
    description: str('2-3 sentences: what it is and what it does'),
    category: { type: 'string', enum: CATEGORIES },
    problem: str('the concrete pain, who feels it'),
    mechanism: str('how it actually works, the technical/product core'),
    targetUser: str('who pays or uses it'),
    businessModel: str('how it makes money'),
    distribution: str('how it reaches users'),
    unusual: { type: 'boolean', description: 'true if deliberately unconventional' },
  },
  required: ['title', 'description', 'category', 'problem', 'mechanism', 'targetUser', 'businessModel'],
  additionalProperties: false,
};

export const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    ideas: { type: 'array', items: ideaShape },
  },
  required: ['ideas'],
  additionalProperties: false,
};

const factorScores = {
  type: 'object',
  properties: Object.fromEntries(FACTOR_KEYS.map((k) => [k, num()])),
  required: FACTOR_KEYS,
  additionalProperties: false,
};

const factorWhys = {
  type: 'object',
  properties: Object.fromEntries(FACTOR_KEYS.map((k) => [k, str('one concrete sentence')])),
  required: FACTOR_KEYS,
  additionalProperties: false,
};

export const EVALUATE_SCHEMA = {
  type: 'object',
  properties: {
    factors: factorScores,
    justifications: factorWhys,
    biggestStrength: str(),
    biggestWeakness: str(),
    whyNotHigher: str('the single biggest reason this is not a 9+; mandatory'),
    priorArt: { type: 'array', items: str('existing product/category/standard practice') },
    summary: str('one sentence verdict'),
    verdict: { type: 'string', enum: ['reject', 'weak', 'ordinary', 'promising', 'strong'] },
  },
  required: [
    'factors',
    'justifications',
    'biggestStrength',
    'biggestWeakness',
    'whyNotHigher',
    'priorArt',
    'summary',
    'verdict',
  ],
  additionalProperties: false,
};

/**
 * Batched evaluation: K independent judgments in one call.
 *
 * Experimental throughput lever. `index` is required per entry so results can be
 * matched back to their idea even if the model reorders or drops one - a missing
 * index fails that idea alone, never the whole batch.
 */
export function batchEvaluateSchema(k) {
  const n = Math.max(1, Math.min(8, Math.round(k) || 1));
  return {
    type: 'object',
    properties: {
      evaluations: {
        type: 'array',
        minItems: n,
        maxItems: n,
        items: {
          type: 'object',
          properties: { index: num(`1-${n}: which idea in the list this evaluation belongs to`), ...EVALUATE_SCHEMA.properties },
          required: ['index', ...EVALUATE_SCHEMA.required],
          additionalProperties: false,
        },
      },
    },
    required: ['evaluations'],
    additionalProperties: false,
  };
}

export const ATTACK_SCHEMA = {
  type: 'object',
  properties: {
    fatalFlaws: { type: 'array', items: str() },
    failureModes: { type: 'array', items: str('what breaks in production / operationally') },
    competition: { type: 'array', items: str('who already does this or could in a month') },
    unitEconomics: str('why the money may not work'),
    killShot: str('the single most likely reason this dies'),
    survivalChance: num('1 = certainly dies, 10 = robust'),
    conditionsToSurvive: { type: 'array', items: str() },
  },
  required: ['fatalFlaws', 'failureModes', 'competition', 'unitEconomics', 'killShot', 'survivalChance'],
  additionalProperties: false,
};

export const IMPROVE_SCHEMA = {
  type: 'object',
  properties: {
    improvedTitle: str(),
    improvedDescription: str(),
    mechanism: str(),
    targetUser: str(),
    businessModel: str(),
    changes: { type: 'array', items: str('what changed and which weakness it kills') },
    remainingWeaknesses: { type: 'array', items: str() },
  },
  required: ['improvedTitle', 'improvedDescription', 'mechanism', 'targetUser', 'businessModel', 'changes', 'remainingWeaknesses'],
  additionalProperties: false,
};

export const MUTATE_SCHEMA = {
  type: 'object',
  properties: {
    variants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: str(),
          description: str(),
          axis: str('what was changed: customer / mechanism / business model / inverted assumption'),
          category: { type: 'string', enum: CATEGORIES },
          mechanism: str(),
          targetUser: str(),
          businessModel: str(),
        },
        required: ['title', 'description', 'axis', 'category', 'mechanism', 'targetUser', 'businessModel'],
        additionalProperties: false,
      },
    },
  },
  required: ['variants'],
  additionalProperties: false,
};

export const DEVELOP_SCHEMA = {
  type: 'object',
  properties: {
    mvpName: str(),
    scope: { type: 'array', items: str('what is in the smallest provable version') },
    explicitlyOut: { type: 'array', items: str() },
    buildSteps: { type: 'array', items: str('ordered, concrete') },
    technicalRequirements: { type: 'array', items: str() },
    timeToPrototype: str('realistic for a 1-3 person team'),
    firstCustomers: { type: 'array', items: str('where to find the first ten') },
    pricing: str('concrete price point and model'),
    successMetric: str('the number that proves it works'),
    assumptions: { type: 'array', items: str('unverified assumption that must be tested') },
  },
  required: [
    'mvpName',
    'scope',
    'explicitlyOut',
    'buildSteps',
    'technicalRequirements',
    'timeToPrototype',
    'firstCustomers',
    'pricing',
    'successMetric',
    'assumptions',
  ],
  additionalProperties: false,
};

export const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    claimsToVerify: { type: 'array', items: str() },
    searchQueries: { type: 'array', items: str('ready to paste into a search engine') },
    competitorsToCheck: { type: 'array', items: str() },
    dataSources: { type: 'array', items: str('where real evidence would come from') },
    killCriteria: { type: 'array', items: str('finding that would end the idea') },
    confidenceNote: str('what IdeaLab does and does not know'),
  },
  required: ['claimsToVerify', 'searchQueries', 'competitorsToCheck', 'dataSources', 'killCriteria', 'confidenceNote'],
  additionalProperties: false,
};

const kbComponent = (kind) => ({
  type: 'object',
  properties: {
    name: str(),
    description: str('one reusable sentence, no statistics'),
    examples: { type: 'array', items: str() },
    strengths: { type: 'array', items: str() },
    weaknesses: { type: 'array', items: str() },
    evidence: {
      type: 'object',
      properties: { ideaIds: { type: 'array', items: str('ids of the ideas this came from') } },
      required: ['ideaIds'],
      additionalProperties: false,
    },
  },
  required: ['name', 'description', 'evidence'],
  additionalProperties: false,
  'x-kind': kind,
});

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    problems: { type: 'array', items: kbComponent('problem') },
    technologies: { type: 'array', items: kbComponent('technology') },
    businessModels: { type: 'array', items: kbComponent('business-model') },
    distribution: { type: 'array', items: kbComponent('distribution') },
    monetization: { type: 'array', items: kbComponent('monetization') },
    audiences: { type: 'array', items: kbComponent('audience') },
  },
  required: ['problems', 'technologies', 'businessModels', 'distribution', 'monetization', 'audiences'],
  additionalProperties: false,
};

export const META_SCHEMA = {
  type: 'object',
  properties: {
    biases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dimension: str('category | businessModel | mechanism | audience | technology'),
          value: str(),
          observedShare: num('percent of the sample, 1-100'),
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          note: str(),
        },
        required: ['dimension', 'value', 'observedShare', 'severity'],
        additionalProperties: false,
      },
    },
    underexplored: { type: 'array', items: str('area to explore next') },
    directives: { type: 'array', items: str('one imperative instruction for the generator') },
    summary: str(),
  },
  required: ['biases', 'underexplored', 'directives', 'summary'],
  additionalProperties: false,
};

export const SCHEMAS = {
  generate: GENERATE_SCHEMA,
  evaluate: EVALUATE_SCHEMA,
  attack: ATTACK_SCHEMA,
  improve: IMPROVE_SCHEMA,
  mutate: MUTATE_SCHEMA,
  develop: DEVELOP_SCHEMA,
  research: RESEARCH_SCHEMA,
  extract: EXTRACT_SCHEMA,
  meta: META_SCHEMA,
};
