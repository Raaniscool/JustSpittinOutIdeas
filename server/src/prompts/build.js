/**
 * User-message builders. Everything variable lives here so the system prompts
 * (and therefore Ollama's cached prompt prefix) stay byte-identical.
 *
 * These prompts are intentionally terse: on a 1-4B local model every extra
 * instruction token is latency on every single call.
 */

/** Minimal idea payload sent to evaluators - never the whole record. */
export function compactIdea(idea = {}) {
  return {
    title: idea.title || '',
    description: idea.description || '',
    category: idea.category || 'any',
    problem: idea.problem || '',
    mechanism: idea.mechanism || '',
    targetUser: idea.targetUser || '',
    businessModel: idea.businessModel || '',
    distribution: idea.distribution || '',
  };
}

export function buildGeneratePrompt({
  count,
  category = 'any',
  seeds = [],
  directives = [],
  recentTitles = [],
  avoidTitles = [],
  mode = 'fast',
}) {
  const lines = [`BRIEF: invent exactly ${count} distinct ideas.`];
  lines.push(
    category === 'any'
      ? 'CATEGORY: any - spread across software, AI, developer tools, education, productivity, business, science, engineering, automation, consumer products, research and weird/unusual.'
      : `CATEGORY: ${category}. Stay inside it, but vary the mechanism and customer.`,
  );
  if (mode === 'deep') lines.push('MODE: deep - these will be attacked and rebuilt, so make the mechanism explicit.');

  if (directives.length) {
    lines.push('ANTI-BIAS DIRECTIVES (obey these):');
    for (const d of directives.slice(0, 6)) lines.push(`- ${d}`);
  }

  if (seeds.length) {
    lines.push('RECOMBINATION SEEDS from the Knowledge Bank (use as a constraint for some ideas, then push past them):');
    seeds.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }

  const avoid = [...avoidTitles, ...recentTitles].filter(Boolean).slice(-40);
  if (avoid.length) {
    lines.push('ALREADY GENERATED - do not repeat these or trivial variants:');
    lines.push(avoid.join('; '));
  }

  lines.push('Return JSON: {"ideas":[...]}. No prose.');
  return lines.join('\n');
}

export function buildEvaluatePrompt(idea, { calibrationDirective = '' } = {}) {
  const parts = [];
  if (calibrationDirective) parts.push(calibrationDirective);
  parts.push('IDEA TO EVALUATE:');
  parts.push(JSON.stringify(compactIdea(idea)));
  parts.push(
    'Score all 10 factors. Ordinary-but-competent = 5-6. Every factor needs a concrete one-sentence "why". Include whyNotHigher and priorArt. JSON only.',
  );
  return parts.join('\n');
}

/**
 * K ideas in one evaluator call.
 *
 * The whole risk of batching is contamination: a model that sees four ideas at
 * once tends to rank them against each other and spread the scores, which is
 * exactly the inflation/curving the calibration guards fight. So the prompt
 * forbids comparison explicitly and keeps the identical per-idea instruction and
 * anchor as the single-idea prompt. The deterministic guards then apply per idea
 * exactly as they do at K=1.
 */
export function buildBatchEvaluatePrompt(ideas = [], { calibrationDirective = '' } = {}) {
  const parts = [];
  if (calibrationDirective) parts.push(calibrationDirective);
  parts.push(`EVALUATE EACH OF THE FOLLOWING ${ideas.length} IDEAS INDEPENDENTLY.`);
  parts.push(
    'They are listed together only to save a round trip. Judge each one on its own merits, against the standard you would apply if it were the only idea you ever saw.',
  );
  parts.push(
    'Do NOT compare them to each other. Do NOT rank, curve, or spread their scores to make them differ. Do NOT let the position of an idea in this list affect its score. Two equally weak ideas must both score low; two equally strong ideas must both score high.',
  );
  ideas.forEach((idea, i) => {
    parts.push(`IDEA ${i + 1}:`);
    parts.push(JSON.stringify(compactIdea(idea)));
  });
  parts.push(
    'Score all 10 factors for every idea. Ordinary-but-competent = 5-6. Every factor needs a concrete one-sentence "why". Include whyNotHigher and priorArt for each.',
  );
  parts.push(
    `Return {"evaluations":[...]} with exactly ${ideas.length} entries, one per idea, each carrying its "index" (${ideas.map((_x, i) => i + 1).join(', ')}). JSON only.`,
  );
  return parts.join('\n');
}

export function buildAttackPrompt(idea, evaluation) {
  const parts = ['IDEA:', JSON.stringify(compactIdea(idea))];
  if (evaluation) {
    parts.push(
      `EVALUATOR ALREADY SAID: strength="${evaluation.biggestStrength || ''}" weakness="${evaluation.biggestWeakness || ''}" overall=${evaluation.overall ?? '?'}/10`,
    );
  }
  parts.push('Destroy it. Be specific about the mechanism of failure. JSON only.');
  return parts.join('\n');
}

export function buildImprovePrompt(idea, { evaluation, attack } = {}) {
  const parts = ['IDEA:', JSON.stringify(compactIdea(idea))];
  if (evaluation) parts.push(`KNOWN WEAKNESSES: ${evaluation.biggestWeakness || ''} | why not higher: ${evaluation.whyNotHigher || ''}`);
  if (attack?.killShot) parts.push(`ATTACK KILL SHOT: ${attack.killShot}`);
  if (Array.isArray(attack?.fatalFlaws) && attack.fatalFlaws.length) {
    parts.push(`ATTACK FLAWS: ${attack.fatalFlaws.slice(0, 5).join(' | ')}`);
  }
  parts.push('Rebuild it so those specific problems are addressed. JSON only.');
  return parts.join('\n');
}

export function buildMutatePrompt(idea, { count = 3 } = {}) {
  return [
    'IDEA:',
    JSON.stringify(compactIdea(idea)),
    `Produce ${count} substantially different variants (different customer, mechanism, business model, or an inverted assumption). JSON only.`,
  ].join('\n');
}

export function buildDevelopPrompt(idea, { evaluation } = {}) {
  const parts = ['IDEA:', JSON.stringify(compactIdea(idea))];
  if (evaluation?.biggestWeakness) parts.push(`MAIN WEAKNESS TO DESIGN AROUND: ${evaluation.biggestWeakness}`);
  parts.push('Produce the smallest MVP that could prove or kill it. JSON only.');
  return parts.join('\n');
}

export function buildResearchPrompt(idea, { evaluation } = {}) {
  const parts = ['IDEA:', JSON.stringify(compactIdea(idea))];
  if (Array.isArray(evaluation?.priorArt) && evaluation.priorArt.length) {
    parts.push(`UNVERIFIED PRIOR ART CLAIMED BY THE EVALUATOR: ${evaluation.priorArt.slice(0, 8).join('; ')}`);
  }
  parts.push(
    'You cannot browse. Produce the exact external checks a human should run, and state what IdeaLab does not know. JSON only.',
  );
  return parts.join('\n');
}

export function buildMetaPrompt(sample, { deterministic = null } = {}) {
  const lines = [`SAMPLE OF ${sample.length} RECENTLY GENERATED IDEAS (title | category | business model | audience):`];
  for (const s of sample) lines.push(`- ${s.title} | ${s.category} | ${s.businessModel || '?'} | ${s.targetUser || '?'}`);
  if (deterministic) {
    lines.push('');
    lines.push('OBSERVED CONCENTRATION (computed, not estimated):');
    lines.push(JSON.stringify(deterministic));
  }
  lines.push('');
  lines.push('Report biases, underexplored areas and imperative directives for the generator. JSON only.');
  return lines.join('\n');
}

export function buildExtractPrompt(ideas, existingNames = []) {
  const lines = ['IDEAS TO MINE (id | title | problem | mechanism | audience | business model | distribution):'];
  for (const i of ideas) {
    lines.push(
      `- ${i.id} | ${i.title} | ${i.problem || ''} | ${i.mechanism || ''} | ${i.targetUser || ''} | ${i.businessModel || ''} | ${i.distribution || ''}`,
    );
  }
  if (existingNames.length) {
    lines.push('');
    lines.push(`ALREADY IN THE KNOWLEDGE BANK (do not re-add): ${existingNames.slice(0, 120).join(', ')}`);
  }
  lines.push('');
  lines.push('Extract only reusable components that are actually present above, each with evidence.ideaIds. No statistics, no market claims. JSON only.');
  return lines.join('\n');
}

/** Human-readable one-line seed for Knowledge Bank recombination. */
export function formatSeed(combo) {
  const bits = [];
  if (combo.problem) bits.push(`problem: ${combo.problem}`);
  if (combo.technology) bits.push(`technology: ${combo.technology}`);
  if (combo.audience) bits.push(`audience: ${combo.audience}`);
  if (combo.businessModel) bits.push(`model: ${combo.businessModel}`);
  if (combo.distribution) bits.push(`channel: ${combo.distribution}`);
  if (combo.monetization) bits.push(`monetisation: ${combo.monetization}`);
  return bits.join(' + ');
}
