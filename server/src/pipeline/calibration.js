/**
 * Score-inflation monitor.
 *
 * IdeaLab's whole value proposition depends on 8-10 being rare. This module
 * watches the live score distribution and, when it drifts upward, feeds a
 * concrete re-anchoring directive back into the evaluator prompt plus extra
 * deterministic strictness into the evidence audit.
 */
import { clamp, round1, round2 } from '../lib/util.js';
import { DEFAULT_CALIBRATION } from './scoring.js';

export class CalibrationMonitor {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULT_CALIBRATION, ...cfg };
    this.window = []; // {overall, model, t}
    this.byModel = new Map();
    this.total = 0;
    this.sum = 0;
  }

  configure(cfg = {}) {
    this.cfg = { ...this.cfg, ...cfg };
  }

  record(overall, { model = '', t = Date.now() } = {}) {
    if (!Number.isFinite(overall)) return;
    this.window.push({ overall, model, t });
    this.total++;
    this.sum += overall;
    const max = this.cfg.windowSize || 200;
    if (this.window.length > max) this.window.splice(0, this.window.length - max);

    let m = this.byModel.get(model);
    if (!m) {
      m = { count: 0, sum: 0, top: 0, ge7: 0 };
      this.byModel.set(model, m);
    }
    m.count++;
    m.sum += overall;
    if (overall >= 8) m.top++;
    if (overall >= 7) m.ge7++;
  }

  /** Rebuild the monitor from a persisted list of ideas (after restart). */
  hydrate(ideas = []) {
    this.window = [];
    this.byModel = new Map();
    this.total = 0;
    this.sum = 0;
    const sorted = [...ideas].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const idea of sorted) {
      if (idea?.score?.overall != null) this.record(Number(idea.score.overall), { model: idea.model || '' });
    }
  }

  stats() {
    const w = this.window;
    if (!w.length) {
      return {
        count: 0, mean: 0, median: 0, p90: 0, min: 0, max: 0,
        share: { ge6: 0, ge7: 0, ge8: 0, ge9: 0 },
        histogram: Array(10).fill(0),
        health: 'unknown', pressure: 0,
      };
    }
    const values = w.map((x) => x.overall).sort((a, b) => a - b);
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const q = (p) => values[clamp(Math.floor(p * (n - 1)), 0, n - 1)];
    const histogram = Array(10).fill(0);
    for (const v of values) histogram[clamp(Math.floor(v) - 1, 0, 9)]++;

    const share = {
      ge6: round2(values.filter((v) => v >= 6).length / n),
      ge7: round2(values.filter((v) => v >= 7).length / n),
      ge8: round2(values.filter((v) => v >= 8).length / n),
      ge9: round2(values.filter((v) => v >= 9).length / n),
    };

    const cfg = this.cfg;
    let health = 'calibrated';
    let pressure = 0;
    if (mean > cfg.inflatedMeanThreshold || share.ge8 > cfg.inflatedTopShareThreshold) {
      health = 'inflated';
      pressure = clamp(
        Math.max(
          (mean - cfg.inflatedMeanThreshold) / 1.5,
          (share.ge8 - cfg.inflatedTopShareThreshold) * 2.5,
        ),
        0,
        0.6,
      );
    } else if (mean < cfg.harshMeanThreshold) {
      health = 'harsh';
      pressure = -0.15; // ease off slightly; a monitor that only punishes drifts to zero
    } else if (share.ge8 > cfg.inflatedTopShareThreshold * 0.6) {
      health = 'drifting-high';
      pressure = clamp((share.ge8 - cfg.inflatedTopShareThreshold * 0.6) * 1.5, 0, 0.3);
    }

    return {
      count: n,
      windowSize: cfg.windowSize,
      mean: round1(mean),
      median: round1(q(0.5)),
      p90: round1(q(0.9)),
      min: round1(values[0]),
      max: round1(values[n - 1]),
      share,
      histogram,
      health,
      pressure: round2(pressure),
      allTime: { count: this.total, mean: this.total ? round1(this.sum / this.total) : 0 },
      models: [...this.byModel.entries()].map(([model, m]) => ({
        model,
        count: m.count,
        mean: round1(m.sum / m.count),
        ge7: m.ge7,
        ge8: m.top,
        ge8Share: round2(m.top / m.count),
      })),
    };
  }

  /** Text appended to the evaluator system prompt when the distribution drifts. */
  directive() {
    const s = this.stats();
    if (s.count < 8 || s.health === 'calibrated' || s.health === 'unknown') return '';
    if (s.health === 'harsh') {
      return `CALIBRATION NOTE: your last ${s.count} evaluations averaged ${s.mean}/10, which is unusually harsh. Do not inflate to compensate - simply make sure a genuinely promising idea is allowed to reach 7-8 when the evidence supports it.`;
    }
    return [
      `CALIBRATION WARNING - YOU ARE INFLATING SCORES.`,
      `Distribution of your last ${s.count} evaluations: mean ${s.mean}/10, median ${s.median}, p90 ${s.p90}, ` +
        `${Math.round(s.share.ge7 * 100)}% scored >= 7 and ${Math.round(s.share.ge8 * 100)}% scored >= 8.`,
      `The target distribution is: mean 5.0-6.0, roughly 20-30% at >= 7, under 10% at >= 8, under 2% at >= 9.`,
      `Re-anchor now: a competent but ordinary idea is 5.0-6.0. "Sounds cool" is worth 0 points. `,
      `If you cannot name the concrete mechanism that makes a factor strong, that factor is at most 6. `,
      `Aim for the lower of two plausible scores whenever you hesitate.`,
    ].join(' ');
  }

  /** Extra strictness multiplier fed into auditEvaluation(). */
  pressure() {
    return this.cfg.autoStrictness === false ? 0 : Math.max(0, this.stats().pressure);
  }
}
