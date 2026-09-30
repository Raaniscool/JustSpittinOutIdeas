import React from 'react';
import { CATEGORY_LABELS, ms } from '../lib/format.js';
import { scoreColor } from '@shared/scoring.js';

function Stat({ label, value, color, title }) {
  return (
    <div className="stat" title={title}>
      <b style={color ? { color } : undefined}>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export default function TopBar({
  providers,
  models,
  health,
  settings,
  stats,
  calibration,
  job,
  panel,
  setPanel,
  onPatch,
  onGenerate,
  onPause,
  onResume,
  onStop,
  onRefreshModels,
  busy,
}) {
  const running = job && (job.status === 'running' || job.status === 'paused' || job.status === 'queued');
  const progress = job && Number.isFinite(job.requested) && job.requested ? Math.min(100, (job.generated / job.requested) * 100) : null;
  const providerSynthetic = providers?.find((p) => p.id === settings?.provider)?.synthetic;
  const reachable = providerSynthetic ? true : health?.ollama?.reachable;

  const calibColor =
    calibration?.health === 'inflated' || calibration?.health === 'drifting-high'
      ? 'var(--bad)'
      : calibration?.health === 'harsh'
        ? 'var(--warn)'
        : 'var(--accent-2)';

  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">
          <span className="flask">⚗</span>
          <h1>IdeaLab</h1>
          <small>generate → evaluate → discover</small>
        </div>

        <div className="control">
          <label htmlFor="provider">Provider</label>
          <select
            id="provider"
            value={settings?.provider || 'ollama'}
            onChange={(e) => onPatch({ provider: e.target.value, model: '' })}
            title="Model providers are modular - Ollama today, others later"
          >
            {(providers || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <span className={`pulse ${reachable ? 'live' : ''}`} title={reachable ? 'connected' : health?.ollama?.error || 'unreachable'} />
        </div>

        <div className="control">
          <label htmlFor="model">Model</label>
          <select
            id="model"
            value={settings?.model || models?.active || ''}
            onChange={(e) => onPatch({ model: e.target.value })}
            title="Detected from the provider - nothing is hardcoded"
            style={{ maxWidth: 250 }}
          >
            {(models?.models || []).length === 0 && <option value="">{models?.error ? 'no models found' : 'loading…'}</option>}
            {(models?.models || []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.parameterSize ? ` · ${m.parameterSize}` : ''}
                {m.sizeLabel ? ` · ${m.sizeLabel}` : ''}
                {m.hint ? ` (${m.hint})` : ''}
              </option>
            ))}
          </select>
          <button className="btn sm ghost" onClick={onRefreshModels} title="Re-query the provider for installed models">
            ⟳
          </button>
        </div>

        <div className="segmented" title="Fast = generate + evaluate. Deep = generate + evaluate + attack + improve + re-evaluate.">
          <button className={settings?.pipeline?.mode === 'fast' ? 'active' : ''} onClick={() => onPatch({ pipeline: { mode: 'fast' } })}>
            ⚡ Fast
          </button>
          <button className={settings?.pipeline?.mode === 'deep' ? 'active' : ''} onClick={() => onPatch({ pipeline: { mode: 'deep' } })}>
            🔬 Deep
          </button>
        </div>

        <div className="control">
          <label htmlFor="category">Category</label>
          <select id="category" value={settings?.pipeline?.category || 'any'} onChange={(e) => onPatch({ pipeline: { category: e.target.value } })}>
            {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <nav className="tabs">
          {[
            ['lab', 'Lab'],
            ['knowledge', 'Knowledge Bank'],
            ['bias', 'Bias'],
            ['stats', 'Performance'],
            ['settings', 'Settings'],
          ].map(([id, label]) => (
            <button key={id} className={`tab ${panel === id ? 'active' : ''}`} onClick={() => setPanel(id)}>
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div className="topbar-row">
        <div className="split">
          <button className="btn primary" disabled={busy} onClick={() => onGenerate({ count: 1 })} title="Generate a single idea">
            Generate 1
          </button>
          <button className="btn primary" disabled={busy} onClick={() => onGenerate({ count: 10 })}>
            Generate 10
          </button>
          <button className="btn primary" disabled={busy} onClick={() => onGenerate({ count: 50 })}>
            Generate 50
          </button>
          <button
            className={`btn ${job?.continuous && running ? 'danger' : ''}`}
            onClick={() => (job?.continuous && running ? onStop() : onGenerate({ continuous: true }))}
            title="Keep generating until you stop it"
          >
            {job?.continuous && running ? '■ Stop continuous' : '∞ Continuous'}
          </button>
          {running && job?.status !== 'paused' && (
            <button className="btn" onClick={onPause}>
              ❚❚ Pause
            </button>
          )}
          {job?.status === 'paused' && (
            <button className="btn" onClick={onResume}>
              ▶ Resume
            </button>
          )}
          {running && (
            <button className="btn danger" onClick={onStop}>
              Stop
            </button>
          )}
          {progress !== null && running && (
            <div style={{ width: 92 }}>
              <div className="progress">
                <i style={{ width: `${progress}%` }} />
              </div>
              <div className="small muted mono" style={{ marginTop: 3 }}>
                {job.generated}/{job.requested || '∞'}
              </div>
            </div>
          )}
        </div>

        <div className="stat-strip right">
          <Stat label="ideas" value={stats?.ideasEvaluated ?? 0} title="Ideas generated and scored this session" />
          <Stat label="ideas/min" value={stats?.ideasPerMinute ?? 0} title="Throughput of the whole pipeline, not raw tokens" color="var(--accent)" />
          <Stat
            label="useful/min"
            value={stats?.usefulPerMinute ?? 0}
            title="Ideas scoring >= 7 per minute - the metric that actually matters"
            color="var(--accent-2)"
          />
          <Stat label="avg score" value={(stats?.avgScore ?? 0).toFixed(1)} color={stats?.avgScore ? scoreColor(stats.avgScore).bright : undefined} title="Mean overall score" />
          <Stat label="≥7" value={stats?.countGe7 ?? 0} />
          <Stat label="≥8" value={stats?.countGe8 ?? 0} color={stats?.countGe8 ? scoreColor(8.4).bright : undefined} />
          <Stat label="≥9" value={stats?.countGe9 ?? 0} color={stats?.countGe9 ? scoreColor(9.3).bright : undefined} />
          <Stat label="gen" value={ms(stats?.avgGenerationMs)} title="Average generation call time" />
          <Stat label="eval" value={ms(stats?.avgEvaluationMs)} title="Average evaluation call time" />
          <Stat
            label="calibration"
            value={calibration?.health === 'calibrated' ? 'ok' : calibration?.health || '–'}
            color={calibColor}
            title={
              calibration
                ? `mean ${calibration.mean}, ${Math.round((calibration.share?.ge8 || 0) * 100)}% scored >= 8 (target < 10%), pressure ${calibration.pressure}`
                : ''
            }
          />
        </div>
      </div>
    </header>
  );
}
