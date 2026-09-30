import React from 'react';
import { scoreColor, scoreGrade, FACTORS } from '@shared/scoring.js';

/**
 * Exact score colour straight from the numeric value - never a red/amber/green
 * bucket. 6.0 and 6.9 render visibly different colours.
 */
export function ScoreBadge({ score, size = 'md', pending = false, showMax = true }) {
  if (pending || score == null) {
    return <span className={`score-badge pending ${size}`}>{size === 'lg' ? '—' : '··'}{showMax && <small>/10</small>}</span>;
  }
  const c = scoreColor(score);
  const style =
    size === 'lg'
      ? { background: c.css, color: c.text, fontSize: 26, padding: '5px 12px', borderRadius: 10 }
      : { background: c.css, color: c.text };
  return (
    <span className={`score-badge ${size}`} style={style} title={`${c.css} — ${scoreGrade(score)}`}>
      {score.toFixed(1)}
      {showMax && <small>/10</small>}
    </span>
  );
}

/** Compact 5x2 factor grid for cards. */
export function FactorMini({ factors, keys }) {
  if (!factors) return null;
  const list = (keys || FACTORS.slice(0, 5).map((f) => f.key)).map((k) => FACTORS.find((f) => f.key === k)).filter(Boolean);
  return (
    <div className="factors">
      {list.map((f) => {
        const v = factors[f.key];
        if (v == null) return null;
        const c = scoreColor(v);
        return (
          <div className="factor" key={f.key} title={`${f.label}: ${v.toFixed(1)}/10`}>
            <span className="k">{f.short === 'DIF2' ? 'DIF' : f.label.slice(0, 4)}</span>
            <span className="v" style={{ color: c.bright }}>
              {v.toFixed(1)}
            </span>
            <span className="bar">
              <i style={{ width: `${(v / 10) * 100}%`, background: c.bright }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Full factor table with justifications + evidence adjustments. */
export function FactorTable({ factors, justifications = {}, adjustments = [], evidence = {}, showWhy = true }) {
  if (!factors) return null;
  const adjByFactor = new Map(adjustments.map((a) => [a.factor, a]));
  return (
    <div className="factor-table">
      {FACTORS.map((f) => {
        const v = factors[f.key];
        if (v == null) return null;
        const c = scoreColor(v);
        const adj = adjByFactor.get(f.key);
        const ev = evidence[f.key];
        return (
          <React.Fragment key={f.key}>
            <div className="factor-line">
              <span title={f.direction < 0 ? 'Negative factor: harder reduces the overall score' : undefined}>
                {f.label}
                {f.direction < 0 ? ' ↓' : ''}
              </span>
              <span className="val" style={{ color: c.bright }}>
                {v.toFixed(1)}
              </span>
              <span className="track">
                <i style={{ width: `${(v / 10) * 100}%`, background: `linear-gradient(90deg, ${c.css}, ${c.bright})` }} />
              </span>
              {adj && (
                <span className="adj" title={adj.reason}>
                  lowered from {adj.from.toFixed(1)} · {adj.rule}
                </span>
              )}
              {ev && !adj && (
                <span className="adj" style={{ color: 'var(--ink-3)' }} title="How concrete the justification was">
                  evidence {Math.round(ev.score * 100)}%
                </span>
              )}
            </div>
            {showWhy && justifications[f.key] && <div className="why">{justifications[f.key]}</div>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** Continuous 1→10 colour ramp, used in settings to show the gradient. */
export function ScoreRamp({ steps = 40 }) {
  const cells = Array.from({ length: steps }, (_, i) => 1 + (i * 9) / (steps - 1));
  return (
    <div>
      <div className="ramp">
        {cells.map((s, i) => (
          <i key={i} style={{ background: scoreColor(s).css }} title={`${s.toFixed(2)} → ${scoreColor(s).css}`} />
        ))}
      </div>
      <div className="ramp-labels">
        <span>1 broken</span>
        <span>5 ordinary</span>
        <span>7 strong</span>
        <span>8+ rare</span>
        <span>10 exceptional</span>
      </div>
    </div>
  );
}
