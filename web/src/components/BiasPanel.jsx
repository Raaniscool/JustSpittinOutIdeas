import React from 'react';
import { pct, timeAgo } from '../lib/format.js';

function Bar({ label, share, count, color = 'var(--accent)' }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 46px', gap: 8, alignItems: 'center', marginBottom: 4 }}>
      <span className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>
        {label}
      </span>
      <span className="progress" style={{ height: 6 }}>
        <i style={{ width: `${Math.min(100, share * 100)}%`, background: color }} />
      </span>
      <span className="mono small muted" style={{ textAlign: 'right' }}>
        {pct(share)} · {count}
      </span>
    </div>
  );
}

export default function BiasPanel({ bias, onAnalyze, onReset, analyzing }) {
  const det = bias?.deterministic || {};
  const llm = bias?.llm;

  return (
    <div>
      <h2 className="panel-title">Anti-bias monitor</h2>
      <p className="panel-sub">
        High-volume generation collapses onto the same few shapes: AI wrappers, SaaS, developer tools, the same audience. IdeaLab measures that
        concentration deterministically over the last {det.sampleSize || 0} ideas and turns it into directives that are injected into the next generation prompt.
        A separate meta-analyzer role reads a compressed sample and adds its own directives every {bias?.biasCheckEvery || 25} ideas.
      </p>

      <div className="split" style={{ marginBottom: 12 }}>
        <button className="btn primary" onClick={onAnalyze} disabled={analyzing}>
          {analyzing ? 'Analyzing…' : 'Run meta-analysis now'}
        </button>
        <button className="btn ghost" onClick={onReset}>
          reset cached analysis
        </button>
        {llm?.at && <span className="chip mono">last model run {timeAgo(llm.at)}</span>}
        <span className="chip">
          next model run in {Math.max(0, (bias?.biasCheckEvery || 25) - (bias?.ideasSinceRun || 0))} ideas
        </span>
      </div>

      <div className="grid-3" style={{ marginBottom: 12 }}>
        <div className="section">
          <h5>AI-centric share</h5>
          <div className="mono" style={{ fontSize: 26 }}>{pct(det.aiShare || 0)}</div>
          <div className="small muted">of recent ideas lean on a model call as the core mechanism</div>
        </div>
        <div className="section">
          <h5>Category concentration</h5>
          <div className="mono" style={{ fontSize: 26 }}>{(det.hhi || 0).toFixed(2)}</div>
          <div className="small muted">Herfindahl index · {1 / Math.max(1, det.sampleSize || 1) < 0.2 ? 'even would be ~0.08' : 'even spread is near 0.08'}, one category only = 1.00</div>
        </div>
        <div className="section">
          <h5>Signals raised</h5>
          <div className="mono" style={{ fontSize: 26 }}>{(det.flags || []).length}</div>
          <div className="small muted">{(det.underexplored || []).length} categories untouched recently</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="section">
          <h5>Categories in the recent window</h5>
          {(det.categories || []).map((c) => (
            <Bar key={c.value} label={c.value} share={c.share} count={c.count} color={c.share >= 0.3 ? 'var(--bad)' : c.share >= 0.18 ? 'var(--warn)' : 'var(--accent)'} />
          ))}
          {!det.categories?.length && <div className="small muted">No ideas yet.</div>}
        </div>
        <div className="section">
          <h5>Business models</h5>
          {(det.businessModels || []).slice(0, 8).map((c) => (
            <Bar key={c.value} label={c.value} share={c.share} count={c.count} color={c.share >= 0.3 ? 'var(--bad)' : 'var(--accent-2)'} />
          ))}
          <h5 style={{ marginTop: 12 }}>Audiences</h5>
          {(det.audiences || []).slice(0, 6).map((c) => (
            <Bar key={c.value} label={c.value} share={c.share} count={c.count} color={c.share >= 0.3 ? 'var(--bad)' : '#a78bfa'} />
          ))}
        </div>
      </div>

      <div className="section" style={{ marginTop: 12 }}>
        <h5>Directives injected into the next generation prompt</h5>
        {(det.directives || []).length === 0 && !(llm?.directives || []).length ? (
          <div className="small muted">
            None. The recent spread is healthy (a minimum of 12 ideas is required before IdeaLab starts complaining).
          </div>
        ) : (
          <ul className="tight">
            {[...new Set([...(det.directives || []), ...(llm?.directives || [])])].map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
        {(det.underexplored || []).length > 0 && (
          <div className="split" style={{ marginTop: 8 }}>
            <span className="small muted">Untouched categories:</span>
            {det.underexplored.map((u) => (
              <span className="chip accent" key={u}>{u}</span>
            ))}
          </div>
        )}
      </div>

      {det.mechanisms?.length > 0 && (
        <div className="section" style={{ marginTop: 12 }}>
          <h5>Overused mechanism vocabulary</h5>
          <div className="split">
            {det.mechanisms.map((m) => (
              <span className="chip warn" key={m.value} title={`${m.count} of ${det.sampleSize} recent ideas`}>
                {m.value} · {pct(m.share)}
              </span>
            ))}
          </div>
        </div>
      )}

      {llm && (
        <div className="section" style={{ marginTop: 12 }}>
          <h5>Meta-analyzer ({llm.model})</h5>
          {llm.summary && <p style={{ marginTop: 0 }}>{llm.summary}</p>}
          {llm.biases?.length > 0 && (
            <table className="plain">
              <thead>
                <tr><th>dimension</th><th>value</th><th className="num">observed</th><th>severity</th><th>note</th></tr>
              </thead>
              <tbody>
                {llm.biases.map((b, i) => (
                  <tr key={i}>
                    <td>{b.dimension}</td>
                    <td>{b.value}</td>
                    <td className="num">{b.observedShare}%</td>
                    <td><span className={`chip ${b.severity === 'high' ? 'bad' : b.severity === 'medium' ? 'warn' : ''}`}>{b.severity}</span></td>
                    <td className="small muted">{b.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {llm.error && <div className="banner bad">{llm.error}</div>}
          <div className="small muted" style={{ marginTop: 6 }}>ran in {llm.ms}ms</div>
        </div>
      )}
    </div>
  );
}
