/**
 * Demo provider.
 *
 * A synthetic "model" that speaks the exact same provider interface as Ollama,
 * so the whole IdeaLab pipeline (streaming, incremental item parsing, brutal
 * evaluation, deterministic scoring, duplicate detection, bias analysis,
 * Knowledge Bank gating) can run and be tested with no local model installed.
 *
 * It is deliberately honest about itself: every record it produces is tagged
 * `provider: 'demo'` and the UI shows a banner. It is a flight simulator, not
 * an idea source - the score distribution is calibrated to be realistic
 * (mean ~5.4, most ideas 4-7, 8+ rare), and it occasionally emits thin
 * justifications so the evidence guards have something to catch.
 */
import { hashString, pick, seededRandom } from '../lib/util.js';
import { JsonItemStream } from '../lib/jsonStream.js';
import { buildEvaluatePrompt } from '../prompts/build.js';

/**
 * Cost model for a batched evaluator call: judging K ideas in one call is not K
 * separate calls - one round trip, one shared prefill - but it is not free
 * either, since K judgments still have to be written out. The simulator charges
 * 1 + 0.35*(K-1) times a single call. That is an ASSUMPTION, not a measurement:
 * real cost depends on your model and hardware.
 */
const BATCH_COST_PER_EXTRA_IDEA = 0.35;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = [
  { id: 'idealab-sim-1b', label: 'IdeaLab Sim 1B (fast)', sizeBytes: 0.9 * 1024 ** 3, latency: 0.5, hint: 'fast' },
  { id: 'idealab-sim-4b', label: 'IdeaLab Sim 4B (balanced)', sizeBytes: 2.6 * 1024 ** 3, latency: 1, hint: 'balanced' },
  { id: 'idealab-sim-8b', label: 'IdeaLab Sim 8B (deep)', sizeBytes: 5.1 * 1024 ** 3, latency: 1.9, hint: 'slow' },
];

const TEMPLATES = {
  software: [
    ['{tech} copilot for {domain}', 'Rebuilds {artifact} from {input} and flags the parts a human must check.'],
    ['Diff-aware {domain} reviewer', 'Watches {artifact} changes and explains what broke, in the terms {aud} already use.'],
    ['Offline-first {domain} sync layer', 'Keeps {artifact} usable with no connectivity and merges edits deterministically.'],
  ],
  ai: [
    ['Local {tech} triage for {artifact}', 'Runs a small model on-device to route {artifact} before anything reaches a human.'],
    ['Schema-locked extraction for {domain}', 'Turns messy {input} into validated records and refuses to guess when confidence is low.'],
    ['Model regression harness for {domain}', 'Replays recorded {artifact} against new model versions and scores the damage.'],
  ],
  'developer-tools': [
    ['Failure replay for {domain} pipelines', 'Records every {input} and lets a developer replay the exact failing run locally.'],
    ['Dependency drift watch for {artifact}', 'Alerts when an upstream change silently alters the behaviour of {artifact}.'],
    ['One-command environment snapshots', 'Captures a working dev environment as a reproducible artifact {aud} can share.'],
  ],
  education: [
    ['Mistake-driven drills for {domain}', 'Builds the next exercise from the specific error the learner just made.'],
    ['{aud} grading assistant for {artifact}', 'Produces a first-pass rubric grade plus the evidence lines, leaving the judgement to the teacher.'],
    ['Concept gap map for {domain}', 'Tests prerequisite knowledge before a course starts and reroutes the syllabus.'],
  ],
  productivity: [
    ['Meeting-to-action extractor for {aud}', 'Turns transcripts into owned, dated tasks inside the tools {aud} already use.'],
    ['{artifact} inbox zero for {aud}', 'Clusters incoming {input} by required action rather than by sender.'],
    ['Context restore for interrupted work', 'Rebuilds the exact working context (files, tabs, notes) after a task switch.'],
  ],
  business: [
    ['Quote-to-cash reconciler for {aud}', 'Matches quotes, orders, and invoices and surfaces the mismatch before finance closes.'],
    ['Churn early-warning for {model} businesses', 'Ranks accounts by behavioural signals the sales team can still influence.'],
    ['Contract obligation tracker', 'Extracts renewal and notice dates from signed contracts and drives the calendar.'],
  ],
  science: [
    ['Lab notebook structuring for {domain}', 'Converts handwritten and instrument output into queryable experiment records.'],
    ['Replication attempt planner', 'Generates the minimal protocol needed to test a published {domain} result.'],
    ['Instrument telemetry anomaly finder', 'Flags drift in {domain} equipment before it corrupts a run.'],
  ],
  engineering: [
    ['Spec-to-testcase generator for {domain}', 'Derives acceptance tests directly from the written specification and tracks coverage.'],
    ['Maintenance manual retrieval for field techs', 'Answers "what torque, which part" from the OEM manual with a page citation.'],
    ['Failure mode library for {domain}', 'Accumulates real failures into a searchable FMEA that design reviews must consult.'],
  ],
  automation: [
    ['No-API browser agent for {domain} back office', 'Completes a defined {artifact} workflow in legacy systems with a human checkpoint.'],
    ['Document-driven approval routing', 'Reads the incoming {input} and routes it to the right approver with the evidence attached.'],
    ['Batch job babysitter', 'Watches scheduled jobs, retries what is safe to retry, and pages on what is not.'],
  ],
  consumer: [
    ['Household {domain} record keeper', 'Collects warranties, manuals, and service history for the things a household owns.'],
    ['Photo-to-inventory for renters', 'Turns phone photos into an insured-item list with replacement values.'],
    ['Local-first {domain} coach', 'Gives daily feedback from on-device signals without uploading anything.'],
  ],
  research: [
    ['Claim-evidence graph for {domain} papers', 'Links each claim in a paper to the figure or dataset that supports it.'],
    ['Negative-result registry for {domain}', 'Captures experiments that failed in a format that is citable and searchable.'],
    ['Dataset licence auditor', 'Scans a training corpus for provenance and licence conflicts before release.'],
  ],
  weird: [
    ['Ambient {domain} oracle', 'A single-button device that answers one narrow {domain} question out loud, offline.'],
    ['Adversarial idea shredder as a service', 'Submits any plan and receives the strongest case against it within a minute.'],
    ['Time-capsule build log', 'Records a project so a future maintainer can watch every decision being made.'],
    ['Physical receipt scanner with regret scoring', 'Shows the real annual cost of small recurring purchases, printed on the receipt.'],
  ],
};

const DOMAINS = [
  'clinical trials', 'freight forwarding', 'dental practices', 'commercial kitchens', 'property management',
  'electrical contracting', 'university admissions', 'insurance claims', 'warehouse picking', 'municipal permits',
  'veterinary clinics', 'field service', 'tax preparation', 'pharmacy dispensing', 'marine maintenance',
  'construction sites', 'call centres', 'library archives', 'seed distribution', 'energy audits',
];
const ARTIFACTS = ['invoices', 'work orders', 'incident reports', 'lab results', 'purchase orders', 'service logs', 'inspection photos', 'contracts', 'timesheets', 'shipping documents'];
const INPUTS = ['scanned PDFs', 'phone photos', 'email threads', 'spreadsheet exports', 'voice notes', 'sensor logs', 'legacy system screens', 'handwritten forms'];
const AUDIENCES = ['solo developers', 'clinic administrators', 'freight brokers', 'site supervisors', 'lab managers', 'independent accountants', 'high school teachers', 'warehouse leads', 'field technicians', 'compliance officers'];
const TECHS = ['local LLM', 'OCR', 'computer vision', 'vector search', 'speech recognition', 'browser automation', 'structured extraction', 'edge inference'];
const MODELS_BIZ = ['subscription', 'usage-based pricing', 'per-unit transaction fee', 'one-time purchase', 'API pricing', 'outcome-based pricing', 'licensing'];
const CHANNELS = ['browser extension', 'web application', 'developer API', 'embedding in existing workflow tools', 'channel partners', 'templates and plugin ecosystems'];
const PRIOR_ART = [
  'generic document-processing SaaS', 'the incumbent ERP module', 'spreadsheet macros', 'an open-source CLI tool',
  'the big AI labs assistant products', 'an existing vertical SaaS leader', 'outsourced offshore service bureaux',
  'built-in features of the platform it runs on', 'a YC-backed startup in the same lane',
];

function fill(str, ctx) {
  return str
    .replaceAll('{aud}', ctx.aud)
    .replaceAll('{domain}', ctx.domain)
    .replaceAll('{artifact}', ctx.artifact)
    .replaceAll('{input}', ctx.input)
    .replaceAll('{tech}', ctx.tech)
    .replaceAll('{model}', ctx.model);
}

function parseCount(prompt) {
  const m = /exactly (\d+) distinct ideas/i.exec(prompt || '');
  return m ? Math.max(1, Math.min(50, Number(m[1]))) : 5;
}

function parseCategory(prompt) {
  const m = /CATEGORY:\s*(?:any -|[a-z-]+\.|([a-z-]+)\.)/i.exec(prompt || '');
  if (!m) return 'any';
  const c = (m[1] || '').trim();
  return TEMPLATES[c] ? c : 'any';
}

function parseIdeaFromEvalPrompt(prompt) {
  const start = (prompt || '').indexOf('{');
  if (start === -1) return {};
  const end = (prompt || '').indexOf('\n', start);
  try {
    return JSON.parse((prompt || '').slice(start, end === -1 ? undefined : end));
  } catch {
    return {};
  }
}

const BATCH_MARKER = /^EVALUATE EACH OF THE FOLLOWING (\d+) IDEAS INDEPENDENTLY\.$/m;

/**
 * Read a batched evaluation prompt back into its parts. Returns null for a
 * single-idea prompt, which is what keeps the ordinary path untouched.
 */
function parseBatchEvalPrompt(prompt) {
  const text = prompt || '';
  const marker = text.match(BATCH_MARKER);
  if (!marker) return null;
  // buildBatchEvaluatePrompt puts the calibration directive first, so everything
  // before the marker is exactly the directive the single-idea path would get.
  const directive = text.slice(0, marker.index).trimEnd();
  const lines = text.split('\n');
  const ideas = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^IDEA \d+:$/.test(lines[i].trim())) continue;
    const json = (lines[i + 1] || '').trim();
    if (!json.startsWith('{')) continue;
    try {
      ideas.push(JSON.parse(json));
    } catch {
      /* an unparseable idea is skipped; the engine falls back to a solo call */
    }
  }
  return ideas.length ? { directive, expected: Number(marker[1]), ideas } : null;
}

function parseExtractLines(prompt) {
  const lines = (prompt || '').split('\n').filter((l) => l.startsWith('- '));
  return lines.map((l) => {
    const parts = l.slice(2).split('|').map((p) => p.trim());
    return { id: parts[0], title: parts[1], problem: parts[2], mechanism: parts[3], targetUser: parts[4], businessModel: parts[5], distribution: parts[6] };
  });
}

// ---------------------------------------------------------------------------

export const demoProvider = {
  id: 'demo',
  label: 'Demo simulator (no model)',
  description: 'Synthetic provider for exploring IdeaLab without Ollama. Ideas are templates, not real research.',
  capabilities: { listModels: true, streaming: true, structured: true, parallel: true, preload: true, synthetic: true },
  settings: null,
  bank: null,
  state: { reachable: true, version: 'sim-1.0', lastChecked: Date.now(), lastError: null },

  configure(settings, ctx = {}) {
    this.settings = settings;
    if (ctx.bank) this.bank = ctx.bank;
    return this;
  },

  async ping() {
    return { reachable: true, version: 'sim-1.0', host: 'in-process', synthetic: true };
  },

  async listModels() {
    return MODELS.map((m) => ({
      id: m.id,
      name: m.id,
      provider: 'demo',
      family: 'idealab-sim',
      parameterSize: m.id.split('-').pop(),
      quantization: 'synthetic',
      sizeBytes: m.sizeBytes,
      sizeLabel: `${(m.sizeBytes / 1024 ** 3).toFixed(1)} GB`,
      modifiedAt: new Date().toISOString(),
      hint: m.hint,
    }));
  },

  async preload() {
    return { ok: true, synthetic: true };
  },

  async complete(req) {
    const { model = MODELS[0].id, prompt = '', schema = null, role = 'generator', onToken, onItem, itemArrayKey, signal } = req;
    const spec = MODELS.find((m) => m.id === model) || MODELS[0];
    const seed = hashString(`${role}|${prompt.slice(0, 4000)}|${model}`);
    const rng = seededRandom(seed);
    // Batched evaluation: only when the schema asks for an `evaluations` array.
    const batch = role === 'evaluator' && schema?.properties?.evaluations ? parseBatchEvalPrompt(prompt) : null;
    const payload = batch ? this._evaluationBatch(batch, model) : this._compose(role, prompt, rng, schema);
    const text = JSON.stringify(payload);

    const arrayKey = itemArrayKey !== undefined ? itemArrayKey : firstArrayKey(schema);
    const stream = onItem && arrayKey ? new JsonItemStream({ arrayKey, keepRaw: false }) : null;

    // stream it in token-sized chunks so the incremental pipeline is exercised
    const chunkSize = 26;
    // Without this, stream length would stand in for cost and a batch would look
    // exactly K times more expensive than K solo calls - which is the one thing
    // batching is not. See BATCH_COST_PER_EXTRA_IDEA.
    const k = batch ? batch.ideas.length : 1;
    const costScale = k > 1 ? (1 + BATCH_COST_PER_EXTRA_IDEA * (k - 1)) / k : 1;
    const perChunkMs = ((spec.latency * 5) / Math.max(1, chunkSize / 26)) * costScale;
    let acc = '';
    const started = Date.now();
    for (let i = 0; i < text.length; i += chunkSize) {
      if (signal?.aborted) throw new Error('aborted');
      const chunk = text.slice(i, i + chunkSize);
      acc += chunk;
      if (onToken) onToken(chunk, acc);
      if (stream) for (const item of stream.push(chunk)) safeOnItem(onItem, item);
      await sleep(perChunkMs);
    }
    if (stream) for (const item of stream.finish()) safeOnItem(onItem, item);

    const completionTokens = Math.round(text.length / 4);
    return {
      text: acc,
      object: payload,
      items: stream ? stream.items : undefined,
      elapsedMs: Date.now() - started,
      model,
      provider: 'demo',
      synthetic: true,
      usage: {
        promptTokens: Math.round(prompt.length / 4),
        completionTokens,
        totalDurationMs: Date.now() - started,
        evalDurationMs: Date.now() - started,
        tokensPerSec: Math.round((completionTokens / Math.max(0.05, (Date.now() - started) / 1000)) * 10) / 10,
        model,
      },
    };
  },

  // --- synthetic content -------------------------------------------------
  _compose(role, prompt, rng, schema) {
    switch (role) {
      case 'evaluator':
        return this._evaluation(parseIdeaFromEvalPrompt(prompt), rng);
      case 'attacker':
        return this._attack(parseIdeaFromEvalPrompt(prompt), rng);
      case 'improver':
        return this._improve(parseIdeaFromEvalPrompt(prompt), rng);
      case 'mutator':
        return this._mutate(parseIdeaFromEvalPrompt(prompt), rng);
      case 'developer':
        return this._develop(parseIdeaFromEvalPrompt(prompt), rng);
      case 'researcher':
        return this._research(parseIdeaFromEvalPrompt(prompt), rng);
      case 'meta':
        return this._meta(prompt, rng);
      case 'extractor':
        return this._extract(parseExtractLines(prompt), rng);
      case 'generator':
      default:
        return { ideas: this._ideas(prompt, rng) };
    }
  },

  _ctx(rng) {
    const bankNames = this.bank ? this.bank.namesByKind() : null;
    const from = (arr, fallback) => (arr && arr.length ? pick(rng, arr) : pick(rng, fallback));
    return {
      aud: from(bankNames?.audience, AUDIENCES),
      domain: pick(rng, DOMAINS),
      artifact: pick(rng, ARTIFACTS),
      input: pick(rng, INPUTS),
      tech: from(bankNames?.technology, TECHS),
      model: from(bankNames?.['business-model'], MODELS_BIZ),
      biz: from(bankNames?.monetization, MODELS_BIZ),
      channel: from(bankNames?.distribution, CHANNELS),
    };
  },

  _ideas(prompt, rng) {
    const count = parseCount(prompt);
    const requested = parseCategory(prompt);
    const cats = requested === 'any' ? Object.keys(TEMPLATES) : [requested];
    const out = [];
    const usedTitles = new Set();
    for (let i = 0; i < count; i++) {
      const cat = cats[Math.floor(rng() * cats.length) % cats.length];
      const tpl = pick(rng, TEMPLATES[cat] || TEMPLATES.software);
      const ctx = this._ctx(rng);
      // Capitalise substituted phrases so synthetic titles read like titles.
      const titleCtx = Object.fromEntries(Object.entries(ctx).map(([k, v]) => [k, capitalize(v)]));
      let title = fill(tpl[0], titleCtx).slice(0, 78);
      // Occasionally repeat a title so duplicate detection has something to find.
      if (out.length > 2 && rng() < 0.07) title = pick(rng, [...usedTitles]);
      usedTitles.add(title);
      const description = `${fill(tpl[1], ctx)} The system works on ${ctx.input} and reports what it changed. Built for ${ctx.aud} who currently handle this by hand.`;
      out.push({
        title,
        description,
        category: cat,
        problem: `${capitalize(ctx.aud)} spend hours each week reconciling ${ctx.artifact} from ${ctx.input}, and errors are found late.`,
        mechanism: `${capitalize(ctx.tech)} parses ${ctx.input}, maps it to a fixed schema, and presents a review queue where a human confirms or corrects each field.`,
        targetUser: capitalize(ctx.aud),
        businessModel: capitalize(ctx.biz),
        distribution: capitalize(ctx.channel),
        unusual: cat === 'weird' || rng() < 0.08,
      });
    }
    return out;
  },

  /**
   * Batched evaluation, simulator edition.
   *
   * Each idea is judged with the SAME seed the single-idea path would use, so
   * here batching is score-neutral by construction. That is deliberate and it is
   * the honest choice: a simulator cannot reproduce a real model's
   * cross-contamination (ranking sibling ideas, curving scores to spread them),
   * and inventing a difference would be a fabricated result. The demo therefore
   * measures what it can - throughput, latency, queue wait, and proof that the
   * deterministic guards apply identically at every K. For the real quality
   * comparison, run `node scripts/bench-k.mjs` against your own Ollama model.
   */
  _evaluationBatch({ directive, ideas }, model) {
    const evaluations = ideas.map((idea, i) => {
      // Rebuild the exact single-idea prompt, then seed from it the same way
      // complete() does. Identical seed + identical idea => identical judgment.
      const singlePrompt = buildEvaluatePrompt(idea, { calibrationDirective: directive });
      const rng = seededRandom(hashString(`evaluator|${singlePrompt.slice(0, 4000)}|${model}`));
      return { index: i + 1, ...this._evaluation(idea, rng) };
    });
    return { evaluations };
  },

  /**
   * Calibrated synthetic evaluation.
   * Mixture distribution chosen so the wall of cards looks like the real thing:
   * most ideas ordinary, 8+ genuinely rare, and thin justifications sometimes
   * so the evidence guards fire.
   */
  _evaluation(idea, rng) {
    const text = `${idea.title || ''} ${idea.description || ''} ${idea.mechanism || ''}`.toLowerCase();
    const generic = /(chatbot|todo|habit|flashcard|resume|meal plan|note tak|social|prompt marketplace|meeting sum)/.test(text);
    const r = rng();
    let centre;
    if (r < 0.62) centre = 5.1 + (rng() - 0.5) * 1.7; // ordinary
    else if (r < 0.86) centre = 6.5 + (rng() - 0.5) * 1.2; // decent
    else if (r < 0.965) centre = 7.7 + (rng() - 0.5) * 1.0; // strong
    else centre = 8.6 + rng() * 0.9; // rare

    const spread = (bias = 0, jitter = 1.7) => clampScore(centre + bias + (rng() - 0.5) * jitter);
    const difficulty = clampScore(4 + rng() * 4.5);
    const factors = {
      novelty: generic ? clampScore(2 + rng() * 1.8) : spread(-0.2),
      usefulness: spread(0.4),
      problemSeverity: spread(0.2),
      feasibility: spread(0.6, 1.4),
      technicalDifficulty: difficulty,
      monetization: spread(-0.3, 2.0),
      marketPotential: spread(0.1, 1.6),
      differentiation: generic ? clampScore(2.5 + rng() * 1.5) : spread(-0.4),
      aiLeverage: spread(0.3, 2.2),
      defensibility: spread(-0.7, 1.8),
    };

    const thin = rng() < 0.22; // deliberately weak justification -> guards should catch it
    const j = (good, weak) => (thin ? weak : good);
    const justifications = {
      novelty: j(
        `${capitalize(idea.category || 'this')} space already has ${pick(rng, PRIOR_ART)}, so the angle is a variation rather than a new category.`,
        'It feels fresh and different from what exists.',
      ),
      usefulness: j(
        `${idea.targetUser || 'Users'} currently absorb this cost manually, so removing it saves measurable hours per week.`,
        'This would be extremely useful for a lot of people.',
      ),
      problemSeverity: j(
        `Errors in ${idea.problem ? 'this workflow' : 'the workflow'} are found late, which is expensive but rarely existential.`,
        'Big problem that really matters.',
      ),
      feasibility: j(
        `A small team could build the review-queue version in weeks; ${idea.mechanism ? 'the parsing step' : 'the core step'} is the risk.`,
        'Totally buildable with modern tools.',
      ),
      technicalDifficulty: j(
        `${difficulty > 6 ? 'Reliable extraction on messy real-world input' : 'Standard integration work'} drives the difficulty rating.`,
        'Some technical work involved.',
      ),
      monetization: j(
        `${idea.businessModel || 'Subscription'} pricing is plausible, but ${pick(rng, ['buyers will resist per-seat fees', 'the free alternative is a spreadsheet', 'budget sits with a department that does not buy tools'])}.`,
        'Huge revenue potential here.',
      ),
      marketPotential: j(
        `${idea.targetUser || 'The audience'} is a real but fragmented segment; reaching it costs more than the product does.`,
        'Massive market with millions of potential customers.',
      ),
      differentiation: j(
        `The wedge is the human review loop, which an incumbent could copy inside two quarters.`,
        'Unique approach nobody else has.',
      ),
      aiLeverage: j(
        `The model does the first pass on ${idea.mechanism ? 'parsing' : 'classification'}, which is genuine leverage but not a moat.`,
        'AI is central and transformative.',
      ),
      defensibility: j(
        `No proprietary data accumulates early, so a competent competitor could reproduce this in weeks.`,
        'Strong network effects and defensibility.',
      ),
    };

    const priorArt = thin && rng() < 0.5 ? [] : [pick(rng, PRIOR_ART), pick(rng, PRIOR_ART)].filter((v, i, a) => a.indexOf(v) === i);
    const overallHint = Object.values(factors).reduce((a, b) => a + b, 0) / 10;

    return {
      factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, Math.round(v * 10) / 10])),
      justifications,
      biggestStrength: justifications.usefulness,
      biggestWeakness: justifications.defensibility,
      whyNotHigher: thin
        ? 'Could be bigger.'
        : `${pick(rng, ['Similar products already exist', 'Distribution cost is unresolved', 'Monetisation depends on a buyer who is hard to reach', 'The differentiation could be reproduced by an incumbent'])}, so it stays below the top band.`,
      priorArt,
      summary: `${idea.title || 'Idea'} is a competent ${overallHint >= 6.5 ? 'but contested' : 'ordinary'} play on a real workflow problem.`,
      verdict: overallHint >= 8 ? 'strong' : overallHint >= 7 ? 'promising' : overallHint >= 5.5 ? 'ordinary' : overallHint >= 4 ? 'weak' : 'reject',
    };
  },

  _attack(idea, rng) {
    return {
      fatalFlaws: [
        `${idea.targetUser || 'The buyer'} has a working workaround that costs nothing: ${pick(rng, ['a spreadsheet', 'an existing vendor module', 'a part-time contractor'])}.`,
        `Accuracy on real ${pick(rng, ['scans', 'photos', 'audio', 'edge cases'])} will be below what the workflow tolerates, so a human must re-check everything anyway.`,
      ],
      failureModes: [
        'Silent wrong answers erode trust faster than visible failures.',
        'Integration with the system of record becomes the whole project.',
        'Support load per customer exceeds the subscription price.',
      ],
      competition: [`${pick(rng, PRIOR_ART)} could ship this as a feature`, `a vertical SaaS incumbent already owns the workflow`],
      unitEconomics: `If ${idea.businessModel || 'subscription'} revenue is small per seat and onboarding needs a human, contribution margin disappears.`,
      killShot: pick(rng, [
        'Nobody changes their workflow for a marginal time saving.',
        'The data access required is gated behind the incumbent.',
        'The first ten customers need ten different integrations.',
      ]),
      survivalChance: Math.round(clampScore(2.5 + rng() * 4) * 10) / 10,
      conditionsToSurvive: [
        'Find one segment where the manual cost is an order of magnitude higher than elsewhere.',
        'Charge on outcome rather than seats so the value is undeniable.',
        rng() < 0.5 ? 'Ship a human-in-the-loop service first and automate the repeatable 80% later.' : 'Bundle with an existing tool that already has distribution.',
      ],
    };
  },

  _improve(idea, rng) {
    return {
      improvedTitle: `${idea.title || 'Idea'} (v2: outcome-priced)`,
      improvedDescription: `${idea.description || ''} Repositioned: instead of selling software, sell the completed result with a human checkpoint, then automate the repeatable share over time.`,
      mechanism: `${idea.mechanism || 'The mechanism'} plus a confidence threshold that routes only uncertain items to a human reviewer.`,
      targetUser: `${idea.targetUser || 'Users'} with the highest manual volume first`,
      businessModel: 'Outcome-based pricing with a subscription floor',
      changes: [
        'Charges per completed item, which removes the "why not just use a spreadsheet" objection.',
        'Adds a confidence threshold so error rate is a product setting, not an accident.',
        'Narrows the first segment to one vertical to make integration tractable.',
      ],
      remainingWeaknesses: ['Human review cost still caps margin until automation improves.', 'Vertical focus shrinks the near-term market.'],
    };
  },

  _mutate(idea, rng) {
    const axes = ['customer', 'mechanism', 'business model', 'inverted assumption'];
    return {
      variants: axes.slice(0, 3).map((axis) => {
        const ctx = this._ctx(rng);
        return {
          title: `${axis === 'customer' ? ctx.aud : ctx.domain} variant of ${idea.title || 'the idea'}`.slice(0, 80),
          description: `Same underlying problem, different wedge: ${ctx.tech} applied to ${ctx.artifact} for ${ctx.aud}, sold as ${ctx.biz}.`,
          axis,
          category: idea.category || 'software',
          mechanism: `${capitalize(ctx.tech)} on ${ctx.input} with a ${axis}-shaped constraint.`,
          targetUser: capitalize(ctx.aud),
          businessModel: capitalize(ctx.biz),
        };
      }),
    };
  },

  _develop(idea, rng) {
    return {
      mvpName: `${idea.title || 'Idea'} - walking skeleton`,
      scope: [
        'One input type, one output schema, one customer segment.',
        'A review queue where a human confirms or corrects every field.',
        'CSV export so the result lands in the system of record by hand.',
      ],
      explicitlyOut: ['Integrations', 'Team permissions', 'Mobile app', 'Automated confidence routing'],
      buildSteps: [
        'Collect 30 real examples from two design partners.',
        'Build the extraction call with a strict schema and a fallback to "needs review".',
        'Ship the review queue as a single page.',
        'Measure correction rate per field and only then automate.',
      ],
      technicalRequirements: [`${pick(rng, TECHS)} runtime`, 'schema-validated output', 'an audit log of every human correction', 'object storage for source files'],
      timeToPrototype: '2-4 weeks for one experienced developer',
      firstCustomers: [`${idea.targetUser || 'Target users'} in industry communities`, 'two design partners found by direct outreach', 'an operator who already does this manually for others'],
      pricing: `$${40 + Math.floor(rng() * 160)} per month per operator, or per-item pricing once volume is known`,
      successMetric: `Correction rate below ${10 + Math.floor(rng() * 20)}% and a design partner who refuses to go back to the manual process.`,
      assumptions: [
        'The target user will share real documents.',
        'Extraction accuracy is high enough to save time rather than create checking work.',
        'Someone will pay before the integrations exist.',
      ],
    };
  },

  _research(idea, rng) {
    return {
      claimsToVerify: [
        `That ${idea.targetUser || 'the target user'} actually spends the time claimed on this workflow.`,
        `That ${pick(rng, PRIOR_ART)} does not already do this.`,
        'That extraction accuracy on real inputs is high enough to be useful.',
      ],
      searchQueries: [
        `"${(idea.title || 'idea').split(' ').slice(0, 4).join(' ')}" software`,
        `best tool for ${idea.problem ? idea.problem.split(',')[0] : 'this workflow'}`,
        `${idea.targetUser || 'target user'} automation ${idea.category || ''} competitors`,
      ],
      competitorsToCheck: [pick(rng, PRIOR_ART), 'the incumbent vertical SaaS', 'open-source alternatives on GitHub'],
      dataSources: ['industry forums and subreddits for the target role', 'public procurement records', 'app-store and G2 reviews of adjacent tools'],
      killCriteria: [
        'A funded competitor already ships the same review loop.',
        'Design partners say the manual process is cheaper than the subscription.',
      ],
      confidenceNote: 'IdeaLab ran no external search. Everything above is a hypothesis generated by a local model and must be checked by a human.',
    };
  },

  _meta(prompt, rng) {
    const lines = prompt.split('\n').filter((l) => l.startsWith('- '));
    const cats = {};
    for (const l of lines) {
      const parts = l.slice(2).split('|').map((p) => p.trim());
      const c = parts[1] || 'unknown';
      cats[c] = (cats[c] || 0) + 1;
    }
    const total = Math.max(1, lines.length);
    const biases = Object.entries(cats)
      .map(([value, n]) => ({ dimension: 'category', value, observedShare: Math.round((n / total) * 100), severity: n / total > 0.3 ? 'high' : n / total > 0.18 ? 'medium' : 'low' }))
      .filter((b) => b.severity !== 'low')
      .sort((a, b) => b.observedShare - a.observedShare);
    return {
      biases: biases.slice(0, 5),
      underexplored: ['science', 'engineering', 'weird', 'consumer'].filter((c) => !cats[c]).slice(0, 3),
      directives: [
        biases[0] ? `Cut ${biases[0].value} ideas to at most 1 in 5; the sample is ${biases[0].observedShare}% that category.` : 'Keep the category spread even.',
        'Include at least one idea with a hardware or physical-world component.',
        `Vary the business model: the sample leans on ${pick(rng, MODELS_BIZ)}.`,
      ],
      summary: `Simulated meta-analysis of ${total} ideas found ${biases.length} concentration signals.`,
    };
  },

  _extract(ideas, rng) {
    const withEvidence = ideas.filter((i) => i.id);
    const mk = (kind, name, description, src) => ({
      name,
      kind,
      description,
      examples: [src.problem || src.title].filter(Boolean).slice(0, 2),
      strengths: ['Reusable across ideas in the same batch'],
      weaknesses: ['Only observed in generated ideas, not validated externally'],
      evidence: { ideaIds: [src.id].filter(Boolean) },
    });
    const out = { problems: [], technologies: [], businessModels: [], distribution: [], monetization: [], audiences: [] };
    for (const idea of withEvidence.slice(0, 6)) {
      if (idea.problem) out.problems.push(mk('problem', componentName(idea.problem.split(',')[0]), `Observed pain: ${idea.problem.slice(0, 140)}`, idea));
      if (idea.mechanism) {
        const tech = TECHS.find((t) => idea.mechanism.toLowerCase().includes(t.split(' ')[0])) || pick(rng, TECHS);
        out.technologies.push(mk('technology', componentName(tech, 4), `Used as the core mechanism in "${idea.title}".`, idea));
      }
      if (idea.businessModel) out.businessModels.push(mk('business-model', componentName(idea.businessModel, 4), `Proposed revenue mechanism in "${idea.title}".`, idea));
      if (idea.distribution) out.distribution.push(mk('distribution', componentName(idea.distribution, 4), `Proposed route to user in "${idea.title}".`, idea));
      if (idea.targetUser) out.audiences.push(mk('audience', componentName(idea.targetUser, 4), `Named as the paying user in "${idea.title}".`, idea));
    }
    // Deliberately include one claim-laden candidate and one evidence-free
    // candidate so the Knowledge Bank gating is visibly exercised.
    out.monetization.push({
      name: 'Enterprise outcome pricing',
      description: 'The enterprise outcome-pricing market is worth $2.3B and growing 40% year over year, proven by adoption data.',
      examples: [],
      strengths: [],
      weaknesses: [],
      evidence: { ideaIds: withEvidence[0]?.id ? [withEvidence[0].id] : [] },
    });
    out.problems.push({
      name: 'Unspecified general inefficiency',
      description: 'A broad problem that nobody in the batch actually mentioned.',
      examples: [],
      strengths: [],
      weaknesses: [],
      evidence: { ideaIds: ['idea-that-does-not-exist'] },
    });
    return out;
  },
};

function safeOnItem(onItem, item) {
  try {
    onItem(item);
  } catch (err) {
    console.error('[idealab] demo onItem failed:', err.message);
  }
}

function firstArrayKey(schema) {
  if (!schema?.properties) return null;
  for (const [key, value] of Object.entries(schema.properties)) if (value?.type === 'array') return key;
  return null;
}

const clampScore = (v) => Math.max(1, Math.min(10, v));
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const titleCase = (s) => String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 70);

/** Component names must be short reusable blocks, not pasted sentences. */
function componentName(text, maxWords = 5) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).slice(0, maxWords);
  const name = words.join(' ').replace(/[.,;:]$/, '');
  return titleCase(name || 'Unnamed component');
}

export default demoProvider;
