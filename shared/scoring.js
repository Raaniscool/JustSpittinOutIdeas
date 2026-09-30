/**
 * SHARED MODULE - imported by both the Node backend and the browser bundle so
 * that scores, calibration guards and score colours can never drift apart.
 *
 * Deterministic scoring, brutal calibration guards and precise score colour.
 *
 * Two hard rules live here:
 *  1. The LLM never chooses the overall score. It supplies 10 factor scores;
 *     the overall number is computed programmatically from configurable weights.
 *  2. A high factor score must be *earned*. If the justification is missing,
 *     thin, or pure hype, the score is lowered deterministically and the
 *     adjustment is recorded so the UI can show exactly what happened.
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));
const round1 = (v) => Math.round((Number(v) + Number.EPSILON) * 10) / 10;
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

export const FACTORS = [
  { key: 'novelty', label: 'Novelty', weight: 0.15, direction: 1, short: 'NOV' },
  { key: 'usefulness', label: 'Usefulness', weight: 0.15, direction: 1, short: 'USE' },
  { key: 'problemSeverity', label: 'Problem severity', weight: 0.1, direction: 1, short: 'PRB' },
  { key: 'feasibility', label: 'Feasibility', weight: 0.1, direction: 1, short: 'FSB' },
  { key: 'technicalDifficulty', label: 'Technical difficulty', weight: 0.05, direction: -1, short: 'DIF' },
  { key: 'monetization', label: 'Monetization', weight: 0.15, direction: 1, short: 'MON' },
  { key: 'marketPotential', label: 'Market potential', weight: 0.1, direction: 1, short: 'MKT' },
  { key: 'differentiation', label: 'Differentiation', weight: 0.1, direction: 1, short: 'DIF2' },
  { key: 'aiLeverage', label: 'AI leverage', weight: 0.05, direction: 1, short: 'AI' },
  { key: 'defensibility', label: 'Defensibility', weight: 0.05, direction: 1, short: 'DEF' },
];

export const FACTOR_KEYS = FACTORS.map((f) => f.key);

export const DEFAULT_WEIGHTS = Object.fromEntries(FACTORS.map((f) => [f.key, f.weight]));

/** Re-normalise arbitrary user weights so they always sum to 1. */
export function normalizeWeights(weights = {}) {
  const out = {};
  let sum = 0;
  for (const f of FACTORS) {
    const w = Number(weights[f.key]);
    out[f.key] = Number.isFinite(w) && w >= 0 ? w : f.weight;
    sum += out[f.key];
  }
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(out)) out[k] = out[k] / sum;
  return out;
}

/**
 * Compute the overall score from factor scores.
 * `technicalDifficulty` is inverted (11 - x) so harder ideas score lower.
 * Missing factors are dropped and the remaining weights renormalised.
 *
 * @returns {{overall:number, contributions:Array, incomplete:boolean, warnings:string[]}}
 */
export function computeOverall(factors = {}, weights = DEFAULT_WEIGHTS) {
  let total = 0;
  let weightSum = 0;
  const contributions = [];
  const warnings = [];
  let incomplete = false;

  for (const f of FACTORS) {
    const w = Number.isFinite(Number(weights[f.key])) ? Number(weights[f.key]) : f.weight;
    const raw = Number(factors[f.key]);
    if (!Number.isFinite(raw)) {
      incomplete = true;
      warnings.push(`${f.label} was not scored; weights renormalised over the remaining factors.`);
      continue;
    }
    const value = clamp(raw, 1, 10);
    const effective = f.direction < 0 ? 11 - value : value;
    total += w * effective;
    weightSum += w;
    contributions.push({
      key: f.key,
      label: f.label,
      raw: round1(value),
      effective: round1(effective),
      weight: w,
      // how much this factor pulls the idea away from a "solid 7"
      drag: round2(w * (7 - effective)),
      direction: f.direction,
    });
  }

  const overall = weightSum > 0 ? total / weightSum : 0;
  contributions.sort((a, b) => b.drag - a.drag);
  return { overall: round1(overall), contributions, incomplete, warnings };
}

// ---------------------------------------------------------------------------
// Evidence enforcement ("if you cannot justify it, lower it")
// ---------------------------------------------------------------------------

const ANCHOR_WORDS = [
  'existing', 'already', 'compared', 'versus', 'vs', 'unlike', 'incumbent', 'competitor',
  'saturated', 'crowded', 'whereas', 'while most', 'in contrast', 'relative to',
  'cheaper', 'faster', 'per seat', 'arpu', 'churn', 'willing to pay', 'no clear',
];

const HYPE_WORDS = [
  'revolutionary', 'game-changing', 'game changing', 'amazing', 'incredible', 'huge potential',
  'massive potential', 'disruptive', 'cutting-edge', 'seamless', 'unprecedented', 'transformative',
  'next-generation', 'next generation', 'world-class', 'supercharge', 'unleash', 'magic',
];

const CONCRETE_WORDS = [
  'minute', 'hour', 'per month', 'workflow', 'api', 'csv', 'invoice', 'pipeline', 'cli',
  'model', 'dataset', 'latency', 'cost', 'margin', 'license', 'compliance', 'audit',
];

/** 0..1 measure of how concrete a justification is. */
export function evidenceScore(justification = '', calib = {}) {
  const text = String(justification || '').toLowerCase().trim();
  if (!text) return 0;
  const minChars = calib.evidenceMinChars ?? 55;
  const words = text.split(/\s+/).filter(Boolean);

  let score = 0;
  score += 0.4 * clamp(text.length / minChars, 0, 1); // substance
  score += words.length >= 10 ? 0.15 : (words.length / 10) * 0.15; // detail
  if (/\d/.test(text)) score += 0.15; // quantities
  if (ANCHOR_WORDS.some((w) => text.includes(w))) score += 0.15; // comparison to reality
  if (CONCRETE_WORDS.some((w) => text.includes(w))) score += 0.15; // domain concreteness
  // Hype is negative evidence: adjectives are not reasoning.
  const hype = HYPE_WORDS.filter((w) => text.includes(w)).length;
  score -= Math.min(0.45, hype * 0.2);
  return clamp(round2(score), 0, 1);
}

export function hypeScore(text = '') {
  const t = String(text).toLowerCase();
  const hits = HYPE_WORDS.filter((w) => t.includes(w)).length;
  return clamp(hits / 3, 0, 1);
}

/**
 * Apply brutal calibration to raw evaluator output.
 *
 * @param {object} raw parsed evaluator JSON (factors, priorArt, ...)
 * @param {object} calib settings.scoring.calibration
 * @param {number} pressure extra strictness from the inflation monitor (0..0.6)
 * @returns {{factors:object, justifications:object, adjustments:Array, warnings:string[], evidence:object}}
 */
export function auditEvaluation(raw = {}, calib = {}, pressure = 0) {
  const factorsIn = raw.factors && typeof raw.factors === 'object' ? raw.factors : raw;
  const justIn = raw.justifications && typeof raw.justifications === 'object' ? raw.justifications : raw.reasons || {};
  const priorArt = Array.isArray(raw.priorArt) ? raw.priorArt.filter(Boolean) : [];

  const factors = {};
  const justifications = {};
  const evidence = {};
  const adjustments = [];
  const warnings = [];
  const strictness = 1 + clamp(pressure, 0, 0.6);
  const maxPenalty = (calib.maxPenalty ?? 1.4) * strictness;

  for (const f of FACTORS) {
    let value = Number(factorsIn[f.key] ?? factorsIn[f.label?.toLowerCase?.()]);
    let just = String(
      justIn[f.key] ??
        justIn[f.label] ??
        (factorsIn[`${f.key}Reason`] || '') ??
        (factorsIn[`${f.key}_reason`] || '') ??
        (typeof factorsIn[f.key] === 'object' ? factorsIn[f.key]?.why || '' : ''),
    ).trim();

    // tolerate {score, why} objects
    const cell = factorsIn[f.key];
    if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
      const candidate = Number(cell.score ?? cell.value ?? cell.rating);
      if (Number.isFinite(candidate)) value = candidate;
      just = just || String(cell.why || cell.reason || cell.justification || '').trim();
    }

    if (!Number.isFinite(value)) {
      warnings.push(`${f.label}: evaluator returned no number.`);
      continue;
    }

    value = round1(clamp(value, 1, 10));
    const original = value;

    if (calib.enforceEvidence !== false) {
      const ev = evidenceScore(just, calib);
      const hype = hypeScore(just);
      evidence[f.key] = { score: ev, hype, chars: just.length };

      if (!just) {
        const capped = Math.min(value, calib.hardCapWithoutJustification ?? 5.5);
        if (capped < value) {
          adjustments.push({
            factor: f.key,
            label: f.label,
            from: original,
            to: round1(capped),
            reason: 'No justification supplied - high score not defensible.',
            rule: 'missing-justification',
          });
          value = round1(capped);
        }
        warnings.push(`${f.label}: no justification provided.`);
      } else if (value >= 7) {
        // 7+ must be argued, 8+ must be argued *well*. Two tiers so an ordinary
        // 7 is not shredded while an unearned 9 is dragged back down.
        const required = value >= 8 ? 0.75 : 0.5;
        const severity = value >= 8 ? 1 : 0.5;
        const shortfall = ev < required ? (required - ev) / required : 0;
        const penalty = round2(shortfall * maxPenalty * severity * (1 + hype * 0.35));
        if (penalty > 0.05) {
          const lowered = round1(Math.max(1, value - penalty));
          adjustments.push({
            factor: f.key,
            label: f.label,
            from: original,
            to: lowered,
            reason:
              `Justification evidence ${Math.round(ev * 100)}% (needs ${Math.round(required * 100)}% at this level)` +
              (hype > 0.3 ? ` with hype language (${Math.round(hype * 100)}%)` : '') +
              ' - score reduced rather than trusted.',
            rule: 'weak-evidence',
            penalty,
          });
          value = lowered;
        }
      }
    }

    // Novelty without named prior art is an unverified claim, not a finding.
    if (
      f.key === 'novelty' &&
      calib.noveltyRequiresPriorArt !== false &&
      value >= 7 &&
      priorArt.length === 0
    ) {
      const cap = calib.noveltyCapWithoutPriorArt ?? 6.4;
      if (value > cap) {
        adjustments.push({
          factor: 'novelty',
          label: 'Novelty',
          from: value,
          to: round1(cap),
          reason: 'Evaluator named no comparable prior art, so novelty is unverified (no external search was performed).',
          rule: 'unverified-novelty',
        });
        value = round1(cap);
        warnings.push('Novelty capped: no prior art named. IdeaLab did not search the web.');
      }
    }

    factors[f.key] = round1(value);
    justifications[f.key] = just;
  }

  return { factors, justifications, adjustments, warnings, evidence, priorArt };
}

/** Deterministic, model-free explanation of what is holding the score down. */
export function scoreDrag(contributions = [], limit = 3) {
  return contributions
    .filter((c) => c.drag > 0.05)
    .slice(0, limit)
    .map((c) => `${c.label} (${c.raw}/10) costs ${round2(c.drag).toFixed(2)} weighted points`);
}

// ---------------------------------------------------------------------------
// Precise score colour: continuous gradient, never buckets
// ---------------------------------------------------------------------------

const COLOR_STOPS = [
  { at: 1, h: 1, s: 74, l: 41 }, //   deep red
  { at: 2, h: 6, s: 80, l: 46 }, //   red
  { at: 3, h: 15, s: 85, l: 50 }, //  red-orange
  { at: 4, h: 27, s: 90, l: 52 }, //  orange
  { at: 5, h: 38, s: 92, l: 52 }, //  yellow-orange
  { at: 6, h: 48, s: 90, l: 47 }, //  yellow
  { at: 7, h: 70, s: 74, l: 43 }, //  yellow-green
  { at: 8, h: 100, s: 64, l: 39 }, // green
  { at: 9, h: 135, s: 60, l: 35 }, // deep green
  { at: 10, h: 160, s: 70, l: 31 }, // exceptional / deepest green
];

const lerp = (a, b, t) => a + (b - a) * t;

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

function relativeLuminance([r, g, b]) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Exact colour for a numeric score. Interpolated continuously, so 6.0 and 6.9
 * are visibly different colours, as are 7.0 and 7.9.
 */
export function scoreColor(score) {
  const v = clamp(Number(score) || 0, 1, 10);
  let lo = COLOR_STOPS[0];
  let hi = COLOR_STOPS[COLOR_STOPS.length - 1];
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    if (v >= COLOR_STOPS[i].at && v <= COLOR_STOPS[i + 1].at) {
      lo = COLOR_STOPS[i];
      hi = COLOR_STOPS[i + 1];
      break;
    }
  }
  const t = hi.at === lo.at ? 0 : (v - lo.at) / (hi.at - lo.at);
  const h = round1(lerp(lo.h, hi.h, t));
  const s = round1(lerp(lo.s, hi.s, t));
  const l = round1(lerp(lo.l, hi.l, t));

  const rgb = hslToRgb(h, s, l);
  const lum = relativeLuminance(rgb);
  const hex = `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  const brightL = clamp(l + 22, 0, 78);

  return {
    score: round1(v),
    h,
    s,
    l,
    css: `hsl(${h} ${s}% ${l}%)`,
    // lighter variant for text/borders on a dark UI
    bright: `hsl(${h} ${clamp(s + 6, 0, 100)}% ${brightL}%)`,
    // faint wash for card backgrounds
    tint: `hsl(${h} ${s}% ${clamp(l + 8, 0, 60)}% / 0.13)`,
    tintStrong: `hsl(${h} ${s}% ${clamp(l + 8, 0, 60)}% / 0.28)`,
    border: `hsl(${h} ${s}% ${clamp(l + 12, 0, 66)}% / 0.55)`,
    hex,
    text: lum > 0.42 ? '#0b0e14' : '#f4f7fb',
    exceptional: v >= 9,
    strong: v >= 8,
    notable: v >= 7,
  };
}

/** Human grade used for tooltips only - the colour carries the precision. */
export function scoreGrade(score) {
  // Labels only - the colour carries the precision. Bands match the calibration rubric.
  const v = Number(score) || 0;
  if (v >= 9.5) return 'once-in-a-project';
  if (v >= 9) return 'exceptional';
  if (v >= 8) return 'very strong';
  if (v >= 7) return 'strong';
  if (v >= 5) return 'ordinary';
  if (v >= 3) return 'weak';
  return 'broken';
}

export const DEFAULT_CALIBRATION = {
  enforceEvidence: true,
  evidenceMinChars: 55,
  maxPenalty: 1.4,
  hardCapWithoutJustification: 5.5,
  noveltyRequiresPriorArt: true,
  noveltyCapWithoutPriorArt: 6.4,
  autoStrictness: true,
  inflatedMeanThreshold: 7.0,
  inflatedTopShareThreshold: 0.2,
  harshMeanThreshold: 3.4,
  windowSize: 200,
};
