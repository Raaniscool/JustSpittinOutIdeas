import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FACTORS,
  DEFAULT_WEIGHTS,
  normalizeWeights,
  computeOverall,
  auditEvaluation,
  evidenceScore,
  scoreColor,
  scoreGrade,
  DEFAULT_CALIBRATION,
} from '../shared/scoring.js';

const ALL_KEYS = FACTORS.map((f) => f.key);
const flat = (v = 6) => Object.fromEntries(ALL_KEYS.map((k) => [k, v]));

test('weights match the specified defaults and sum to 1', () => {
  assert.equal(DEFAULT_WEIGHTS.novelty, 0.15);
  assert.equal(DEFAULT_WEIGHTS.usefulness, 0.15);
  assert.equal(DEFAULT_WEIGHTS.problemSeverity, 0.1);
  assert.equal(DEFAULT_WEIGHTS.feasibility, 0.1);
  assert.equal(DEFAULT_WEIGHTS.technicalDifficulty, 0.05);
  assert.equal(DEFAULT_WEIGHTS.monetization, 0.15);
  assert.equal(DEFAULT_WEIGHTS.marketPotential, 0.1);
  assert.equal(DEFAULT_WEIGHTS.differentiation, 0.1);
  assert.equal(DEFAULT_WEIGHTS.aiLeverage, 0.05);
  assert.equal(DEFAULT_WEIGHTS.defensibility, 0.05);
  const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights must sum to 1, got ${sum}`);
  assert.equal(ALL_KEYS.length, 10);
});

test('arbitrary weights are normalised instead of silently changing the scale', () => {
  const w = normalizeWeights({ novelty: 3, usefulness: 1 });
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
  assert.ok(w.novelty > w.usefulness);
});

test('overall score is deterministic and shown to one decimal place', () => {
  const factors = {
    novelty: 7.1, usefulness: 8.8, problemSeverity: 7, feasibility: 7.4, technicalDifficulty: 4,
    monetization: 7.9, marketPotential: 8.2, differentiation: 6.5, aiLeverage: 6, defensibility: 5,
  };
  const a = computeOverall(factors, DEFAULT_WEIGHTS);
  const b = computeOverall(factors, DEFAULT_WEIGHTS);
  assert.equal(a.overall, b.overall);
  assert.equal(a.overall, 7.4);
  assert.equal(String(a.overall).split('.')[1]?.length ?? 0, 1, 'one decimal place');
});

test('technical difficulty is a negative factor', () => {
  const easy = computeOverall({ ...flat(6), technicalDifficulty: 1 }, DEFAULT_WEIGHTS);
  const hard = computeOverall({ ...flat(6), technicalDifficulty: 10 }, DEFAULT_WEIGHTS);
  assert.ok(easy.overall > hard.overall, `easy ${easy.overall} should beat hard ${hard.overall}`);
  // with every other factor at 6 and difficulty inverted, a trivial idea lands above 6
  assert.ok(easy.overall > 6);
  assert.ok(hard.overall < 6);
});

test('a flat profile scores exactly its own value once difficulty is inverted', () => {
  // technicalDifficulty 6 inverts to 5, so a uniform 5 really is 5.0
  assert.equal(computeOverall({ ...flat(5), technicalDifficulty: 6 }, DEFAULT_WEIGHTS).overall, 5);
  // ...and a hard idea scores below the flat profile
  assert.ok(computeOverall({ ...flat(5), technicalDifficulty: 9 }, DEFAULT_WEIGHTS).overall < 5);
});

test('missing factors are dropped and weights renormalised, with a warning', () => {
  const partial = { novelty: 8, usefulness: 6 };
  const out = computeOverall(partial, DEFAULT_WEIGHTS);
  assert.equal(out.incomplete, true);
  assert.ok(out.warnings.length >= 1);
  // 0.15*8 + 0.15*6 over 0.30 total weight = 7
  assert.equal(out.overall, 7);
});

test('out-of-range factor values are clamped', () => {
  const out = computeOverall({ ...flat(5), novelty: 42, usefulness: -3 }, DEFAULT_WEIGHTS);
  assert.ok(out.overall >= 1 && out.overall <= 10);
});

test('evidence scoring rewards concrete reasoning and punishes hype', () => {
  const concrete =
    'Brokers already pay an offshore team about $4 per invoice, so automating extraction removes a measurable per-unit cost.';
  const hype = 'Amazing revolutionary product with huge potential and massive market opportunity.';
  assert.ok(evidenceScore(concrete, DEFAULT_CALIBRATION) > 0.75);
  assert.ok(evidenceScore(hype, DEFAULT_CALIBRATION) < 0.5);
  assert.equal(evidenceScore('', DEFAULT_CALIBRATION), 0);
});

test('a high score with no justification is capped', () => {
  const raw = { factors: flat(9), justifications: {}, priorArt: ['x'] };
  const out = auditEvaluation(raw, DEFAULT_CALIBRATION, 0);
  for (const k of ALL_KEYS) {
    if (k === 'technicalDifficulty') continue;
    assert.ok(out.factors[k] <= DEFAULT_CALIBRATION.hardCapWithoutJustification + 0.0001, `${k} should be capped`);
  }
  assert.ok(out.adjustments.length >= 8);
  assert.ok(out.adjustments.some((a) => a.rule === 'missing-justification'));
});

test('a high score with hype-only justification is lowered, a well-argued one is not', () => {
  const good =
    'Incumbent ERPs already ship a module for this, but it costs about $40k a year and needs an admin, so a self-serve tool at $99 undercuts it.';
  const hype = 'Game-changing and revolutionary with huge potential.';
  const just = (t) => Object.fromEntries(ALL_KEYS.map((k) => [k, t]));

  const argued = auditEvaluation({ factors: flat(8.6), justifications: just(good), priorArt: ['incumbent ERP'] }, DEFAULT_CALIBRATION, 0);
  const puffed = auditEvaluation({ factors: flat(8.6), justifications: just(hype), priorArt: ['incumbent ERP'] }, DEFAULT_CALIBRATION, 0);

  assert.equal(argued.adjustments.length, 0, 'concrete reasoning must not be penalised');
  assert.equal(argued.factors.novelty, 8.6);
  assert.ok(puffed.adjustments.length >= 5, 'hype must be penalised');
  assert.ok(puffed.factors.novelty < 8.6);
  assert.ok(
    computeOverall(puffed.factors).overall < computeOverall(argued.factors).overall,
    'hype-only evaluation must end up with a lower overall score',
  );
});

test('novelty without named prior art is capped (no unverified novelty claims)', () => {
  const just = Object.fromEntries(
    ALL_KEYS.map((k) => [k, 'Compared with existing tools this is narrower, cheaper and integrates with the workflow already in place.']),
  );
  const out = auditEvaluation({ factors: { ...flat(6), novelty: 9 }, justifications: just, priorArt: [] }, DEFAULT_CALIBRATION, 0);
  assert.ok(out.factors.novelty <= DEFAULT_CALIBRATION.noveltyCapWithoutPriorArt);
  assert.ok(out.adjustments.some((a) => a.rule === 'unverified-novelty'));
  assert.ok(out.warnings.some((w) => /did not search the web/i.test(w)));
});

test('calibration pressure increases strictness', () => {
  const just = Object.fromEntries(ALL_KEYS.map((k) => [k, 'Reasonable idea with existing competition in the segment.']));
  const calm = auditEvaluation({ factors: flat(8.4), justifications: just, priorArt: ['x'] }, DEFAULT_CALIBRATION, 0);
  const strict = auditEvaluation({ factors: flat(8.4), justifications: just, priorArt: ['x'] }, DEFAULT_CALIBRATION, 0.6);
  assert.ok(strict.factors.novelty <= calm.factors.novelty);
});

test('score colours are continuous, ordered, and distinct at 0.1 resolution', () => {
  const seen = new Set();
  let prevHue = -1;
  for (let s = 1; s <= 10.0001; s += 0.1) {
    const c = scoreColor(s);
    const key = `${c.h}|${c.s}|${c.l}`;
    assert.ok(!seen.has(key), `score ${s.toFixed(1)} reused colour ${key}`);
    seen.add(key);
    assert.ok(c.h >= prevHue - 0.001, `hue must not go backwards at ${s.toFixed(1)}`);
    prevHue = c.h;
    assert.ok(/^hsl\(/.test(c.css) && /^#/.test(c.hex) && /^hsl\(/.test(c.tint));
    assert.ok(c.text === '#0b0e14' || c.text === '#f4f7fb', 'text colour must stay readable');
  }

  const diff = (a, b) => {
    const ca = scoreColor(a);
    const cb = scoreColor(b);
    return Math.abs(ca.h - cb.h) + Math.abs(ca.l - cb.l);
  };
  assert.ok(diff(6.0, 6.9) > 3, '6.0 and 6.9 must visibly differ');
  assert.ok(diff(7.0, 7.9) > 3, '7.0 and 7.9 must visibly differ');
  assert.ok(diff(8.0, 8.9) > 1, '8.0 and 8.9 must differ');

  // ends of the scale
  assert.ok(scoreColor(1).h < 8, 'score 1 is deep red');
  assert.ok(scoreColor(10).h > 140, 'score 10 is the deepest green');
  assert.equal(scoreColor(0).score, 1, 'clamped low');
  assert.equal(scoreColor(99).score, 10, 'clamped high');
  assert.equal(scoreColor(9.4).exceptional, true);
  assert.equal(scoreColor(8.2).strong, true);
  assert.equal(scoreColor(7.1).notable, true);
});

test('grades are only labels, never buckets used for colour', () => {
  assert.equal(scoreGrade(2.8), 'broken');
  assert.equal(scoreGrade(4.1), 'weak');
  assert.equal(scoreGrade(5.6), 'ordinary');
  assert.equal(scoreGrade(6.2), 'ordinary');
  assert.equal(scoreGrade(7.4), 'strong');
  assert.equal(scoreGrade(9.2), 'exceptional');
});

test('contribution analysis explains what holds a score down', () => {
  const out = computeOverall({ ...flat(7), defensibility: 2, monetization: 3 }, DEFAULT_WEIGHTS);
  const worst = out.contributions[0];
  // drag is weight * (7 - effective), so the heavily weighted weak factor leads
  assert.equal(worst.key, 'monetization', 'the biggest weighted drag should be listed first');
  assert.ok(worst.drag > 0);
  assert.ok(out.contributions.some((c) => c.key === 'defensibility' && c.drag > 0));
});
