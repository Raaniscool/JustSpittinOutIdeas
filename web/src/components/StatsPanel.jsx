import React from 'react';
import { scoreColor } from '@shared/scoring.js';
import { ms, pct } from '../lib/format.js';
import { ScoreRamp } from './Score.jsx';

function Big({ label, value, sub, color }) {
  return (
    <div className="section">
      <h5>{label}</h5>
      <div className="mono" style={{ fontSize: 26, lineHeight: 1.1, color }}>{value}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

export default function StatsPanel({ stats, calibration, distribution, evalCache, model, provider, reviews, onReset }) {
  const s = stats || {};
  const c = calibration || {};
  const healthColor =
    c.health === 'inflated' || c.health === 'drifting-high' ? 'var(--bad)' : c.health === 'harsh' ? 'var(--warn)' : 'var(--accent-2)';
  const maxHist = Math.max(1, ...(c.histogram || [1]));

  return (
    <div>
      <h2 className="panel-title">Performance</h2>
      <p className="panel-sub">
        The number that matters is <b>useful ideas per minute</b>, not tokens per second: how many ideas clear the “worth investigating” bar while you wait.
        Switch models in the header and this table tells you which one actually finds more good ideas per minute on your hardware.
      </p>

      <div className="split" style={{ marginBottom: 12 }}>
        <span className="chip mono">model: {model || s.byModel?.[0]?.model || '—'}</span>
        <span className="chip mono">provider: {provider?.id || '—'}</span>
        {provider?.synthetic && <span className="chip warn">synthetic provider — timings are simulated</span>}
        <span className="grow" />
        <button className="btn ghost sm" onClick={onReset}>reset session counters</button>
      </div>

      <div className="grid-3">
        <Big label="Ideas generated" value={s.ideasGenerated ?? 0} sub={`${s.ideasEvaluated ?? 0} reviewed · ${s.failures ?? 0} failures`} />
        <Big label="Generated / minute" value={s.generatedPerMinute ?? s.ideasPerMinute ?? 0} sub="what the model is producing right now" color="var(--accent)" />
        <Big
          label="Reviewed / minute"
          value={s.reviewedPerMinute ?? s.ideasPerMinute ?? 0}
          sub={`review queue: ${reviews?.depth ?? 0} waiting · ${reviews?.active ?? 0} in flight · avg wait ${ms(reviews?.avgWaitMs ?? s.avgReviewWaitMs ?? 0)}${
            s.evalCalls ? ` · ${s.evalCalls} evaluator call${s.evalCalls === 1 ? '' : 's'}${s.avgEvalBatchSize > 1 ? ` for ${s.avgEvalBatchSize} ideas each` : ''}` : ''
          }`}
          color={(reviews?.throttled || (reviews?.avgWaitMs ?? 0) > 30000) ? 'var(--warn)' : undefined}
        />
        <Big
          label="Useful ideas / minute"
          value={s.usefulPerMinute ?? 0}
          sub={`score ≥ 7 · excellent (≥8): ${s.excellentPerMinute ?? 0}/min`}
          color="var(--accent-2)"
        />
        <Big label="Average generation" value={ms(s.avgGenerationMs)} sub="per batched model call" />
        <Big
          label="Average evaluation"
          value={ms(s.avgEvaluationMs)}
          sub={
            s.avgEvalBatchSize > 1
              ? `per idea, its share of a ${s.avgEvalBatchSize}-idea call averaging ${ms(s.avgEvalCallMs)}`
              : 'per idea, one evaluator call each'
          }
          color={s.avgEvalBatchSize > 1 ? 'var(--warn)' : undefined}
        />
        <Big label="Average deep action" value={ms(s.avgDeepActionMs)} sub={Object.entries(s.deepActions || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none run'} />
        <Big
          label="Average score"
          value={(s.avgScore ?? 0).toFixed(1)}
          sub={`median ${s.medianScore ?? 0} · target mean 5.0–6.0`}
          color={s.avgScore ? scoreColor(s.avgScore).bright : undefined}
        />
        <Big label="Score ≥ 7" value={s.countGe7 ?? 0} sub={`${pct(s.shareGe7 ?? 0)} of scored ideas`} color={scoreColor(7.4).bright} />
        <Big label="Score ≥ 8 / ≥ 9" value={`${s.countGe8 ?? 0} / ${s.countGe9 ?? 0}`} sub={`${pct(s.shareGe8 ?? 0)} at ≥8 — should stay under ~10%`} color={scoreColor(8.6).bright} />
        <Big label="Tokens" value={`${((s.tokens?.completion ?? 0) / 1000).toFixed(1)}k out`} sub={`${((s.tokens?.prompt ?? 0) / 1000).toFixed(1)}k in · ${s.avgTokensPerSec ?? 0} tok/s`} />
        <Big label="Model calls avoided" value={(s.calls?.cacheHits ?? 0) + (s.calls?.duplicateSkips ?? 0)} sub={`${s.calls?.cacheHits ?? 0} cache hits · ${s.calls?.duplicateSkips ?? 0} near-duplicate reuses`} />
        <Big label="Calls" value={s.calls?.total ?? 0} sub={`${s.calls?.retries ?? 0} retries · ${s.calls?.failed ?? 0} failed`} />
      </div>

      <div className="section" style={{ marginTop: 12 }}>
        <h5>Model comparison (this session)</h5>
        {s.byModel?.length ? (
          <table className="plain">
            <thead>
              <tr>
                <th>model</th>
                <th className="num">ideas</th>
                <th className="num">ideas/min</th>
                <th className="num">useful/min</th>
                <th className="num">avg gen</th>
                <th className="num">avg eval</th>
                <th className="num">tok/s</th>
                <th className="num">avg score</th>
                <th className="num">≥7</th>
                <th className="num">≥8</th>
                <th className="num">fail</th>
              </tr>
            </thead>
            <tbody>
              {s.byModel.map((m) => (
                <tr key={m.model}>
                  <td className="mono">{m.model}</td>
                  <td className="num">{m.evaluated}</td>
                  <td className="num" style={{ color: 'var(--accent)' }}>{m.ideasPerMinute}</td>
                  <td className="num" style={{ color: 'var(--accent-2)' }}>{m.usefulPerMinute}</td>
                  <td className="num">{ms(m.avgGenerationMs)}</td>
                  <td className="num">{ms(m.avgEvaluationMs)}</td>
                  <td className="num">{m.avgTokensPerSec || '—'}</td>
                  <td className="num">{m.avgScore.toFixed(1)}</td>
                  <td className="num">{m.countGe7}</td>
                  <td className="num">{m.countGe8}</td>
                  <td className="num">{m.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="small muted">No model calls yet.</div>
        )}
      </div>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <div className="section">
          <h5>Calibration health</h5>
          <div className="split" style={{ marginBottom: 8 }}>
            <span className="chip" style={{ borderColor: healthColor, color: healthColor }}>{c.health || 'unknown'}</span>
            <span className="chip mono">mean {c.mean ?? 0}</span>
            <span className="chip mono">median {c.median ?? 0}</span>
            <span className="chip mono">p90 {c.p90 ?? 0}</span>
            <span className="chip mono">pressure {c.pressure ?? 0}</span>
          </div>
          <div className="small muted" style={{ marginBottom: 8 }}>
            {c.count || 0} evaluations in the window (last {c.windowSize || 200}). Target: mean 5.0–6.0, ~20–30% at ≥7, under 10% at ≥8, under 2% at ≥9.
          </div>
          <div className="histogram" style={{ height: 62 }}>
            {(c.histogram || Array(10).fill(0)).map((n, i) => {
              const col = scoreColor(i + 1.5);
              return (
                <div className="b" key={i} title={`${i + 1}.0–${i + 1}.9: ${n}`}>
                  <i style={{ height: `${(n / maxHist) * 100}%`, background: col.css }} />
                  <span>{i + 1}</span>
                </div>
              );
            })}
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            ≥6: {pct(c.share?.ge6 || 0)} · ≥7: {pct(c.share?.ge7 || 0)} · ≥8: {pct(c.share?.ge8 || 0)} · ≥9: {pct(c.share?.ge9 || 0)}
          </div>
          {c.health && c.health !== 'calibrated' && c.health !== 'unknown' && (
            <div className="banner" style={{ marginTop: 10 }}>
              <span>
                The monitor is pushing back: extra evidence strictness of <b>{c.pressure}</b> is being applied to every evaluation until the distribution
                returns to the target band.
              </span>
            </div>
          )}
        </div>

        <div className="section">
          <h5>Score colour ramp</h5>
          <div className="small muted" style={{ marginBottom: 8 }}>
            Colour is computed from the exact numeric score, never from a bucket — 6.0 and 6.9 are different colours, and so are 7.0 and 7.9.
          </div>
          <ScoreRamp steps={45} />
          <div className="split" style={{ marginTop: 12, gap: 6 }}>
            {[2.8, 4.1, 5.6, 6.2, 6.9, 7.4, 8.1, 9.2].map((v) => {
              const col = scoreColor(v);
              return (
                <span key={v} className="score-badge" style={{ background: col.css, color: col.text }} title={col.css}>
                  {v.toFixed(1)}
                </span>
              );
            })}
          </div>
          <h5 style={{ marginTop: 14 }}>Bank composition</h5>
          <div className="small muted">
            {distribution?.count || 0} ideas stored · {distribution?.scored || 0} scored ·{' '}
            {Object.entries(distribution?.byStatus || {})
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ') || 'none'}
          </div>
          <h5 style={{ marginTop: 12 }}>Evaluation cache</h5>
          <div className="small muted mono">
            {evalCache?.size || 0} entries · {evalCache?.hits || 0} hits · {evalCache?.misses || 0} misses
          </div>
        </div>
      </div>
    </div>
  );
}
