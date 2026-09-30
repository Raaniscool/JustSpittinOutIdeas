import React, { useMemo, useState } from 'react';
import { FACTORS, DEFAULT_WEIGHTS, computeOverall, normalizeWeights, scoreColor } from '@shared/scoring.js';
import { ScoreBadge, ScoreRamp } from './Score.jsx';

function Num({ label, value, onChange, step = 1, min = 0, max = 100, hint }) {
  return (
    <label className="filter-row" title={hint}>
      <span className="name">{label}</span>
      <input type="number" step={step} min={min} max={max} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    </label>
  );
}

function Toggle({ label, value, onChange, hint }) {
  return (
    <label className="check" title={hint}>
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export default function SettingsPanel({ settings, onPatch, onReset, health, onPreload, onUnload }) {
  const perf = settings?.performance || {};
  const pipe = settings?.pipeline || {};
  const calib = settings?.scoring?.calibration || {};
  const weights = settings?.scoring?.weights || DEFAULT_WEIGHTS;

  const [demoFactors, setDemoFactors] = useState(() =>
    Object.fromEntries(FACTORS.map((f) => [f.key, f.key === 'technicalDifficulty' ? 4 : 7])),
  );

  const demoScore = useMemo(() => computeOverall(demoFactors, normalizeWeights(weights)), [demoFactors, weights]);
  const weightSum = useMemo(() => Object.values(weights).reduce((a, b) => a + Number(b || 0), 0), [weights]);

  const setPerf = (patch) => onPatch({ performance: patch });
  const setPipe = (patch) => onPatch({ pipeline: patch });
  const setCalib = (patch) => onPatch({ scoring: { calibration: patch } });
  const setWeights = (patch) => onPatch({ scoring: { weights: { ...weights, ...patch } } });

  return (
    <div>
      <h2 className="panel-title">Settings</h2>
      <p className="panel-sub">
        Everything here is persisted locally in <span className="mono">data/settings.json</span>. No model is hardcoded: the provider list comes from the
        provider module and the model list comes from the provider itself.
      </p>

      <div className="grid-2">
        <div className="section">
          <h5>Provider</h5>
          <div className="small muted" style={{ marginBottom: 4 }}>Ollama host</div>
          <input
            type="text"
            style={{ width: '100%', marginBottom: 8 }}
            value={settings?.ollama?.host || ''}
            onChange={(e) => onPatch({ ollama: { host: e.target.value } })}
            placeholder="http://127.0.0.1:11434"
          />
          <div className="filter-row">
            <span className="name">keep_alive</span>
            <input
              type="text"
              style={{ width: 90 }}
              value={settings?.ollama?.keepAlive || ''}
              onChange={(e) => onPatch({ ollama: { keepAlive: e.target.value } })}
              title="How long Ollama keeps the weights loaded. -1 = until restart (fastest, uses RAM)."
            />
          </div>
          <Toggle
            label="Disable thinking on reasoning models"
            value={settings?.ollama?.disableThinking}
            onChange={(v) => onPatch({ ollama: { disableThinking: v } })}
            hint="qwen3 / deepseek-r1 style models burn tokens deliberating. For scanning ideas you want the answer."
          />
          <Num
            label="Request timeout (ms)"
            value={settings?.ollama?.requestTimeoutMs}
            onChange={(v) => onPatch({ ollama: { requestTimeoutMs: v } })}
            step={1000}
            min={5000}
            max={1200000}
          />
          <div className="split" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={onPreload}>Preload model into memory</button>
            <button className="btn sm ghost" onClick={onUnload}>Unload model</button>
            <span className={`pulse ${health?.ollama?.reachable ? 'live' : ''}`} />
            <span className="small muted">
              {health?.ollama?.reachable ? `connected · v${health?.ollama?.version}` : health?.ollama?.error || 'not connected'}
            </span>
          </div>
        </div>

        <div className="section">
          <h5>Throughput</h5>
          <Num label="Ideas per generation call" value={perf.ideasPerGenerationCall} onChange={(v) => setPerf({ ideasPerGenerationCall: v })} min={1} max={25}
            hint="Batching amortises prompt processing. Too high and small models lose coherence." />
          <Num label="Concurrent evaluations" value={perf.evaluateConcurrency} onChange={(v) => setPerf({ evaluateConcurrency: v })} min={1} max={16}
            hint="Match OLLAMA_NUM_PARALLEL. Higher = more ideas scored per minute, until the GPU saturates." />
          <Num label="Concurrent deep actions" value={perf.deepConcurrency ?? 2} onChange={(v) => setPerf({ deepConcurrency: v })} min={1} max={8}
            hint="Deep mode only: attack + improve per idea, bounded separately from the evaluation pool." />
          <Num label="num_ctx (generate)" value={perf.numCtxGenerate} onChange={(v) => setPerf({ numCtxGenerate: v })} min={512} max={65536} step={256} />
          <Num label="num_ctx (evaluate)" value={perf.numCtxEvaluate} onChange={(v) => setPerf({ numCtxEvaluate: v })} min={512} max={65536} step={256} />
          <Num label="num_ctx (deep actions)" value={perf.numCtxDeep} onChange={(v) => setPerf({ numCtxDeep: v })} min={512} max={65536} step={256} />
          <Num label="Max tokens (generate)" value={perf.maxTokensGenerate} onChange={(v) => setPerf({ maxTokensGenerate: v })} min={128} max={16384} step={64} />
          <Num label="Max tokens (evaluate)" value={perf.maxTokensEvaluate} onChange={(v) => setPerf({ maxTokensEvaluate: v })} min={128} max={16384} step={64} />
          <Num label="Temperature (generate)" value={perf.temperatureGenerate} onChange={(v) => setPerf({ temperatureGenerate: v })} min={0} max={2} step={0.05} />
          <Num label="Temperature (evaluate)" value={perf.temperatureEvaluate} onChange={(v) => setPerf({ temperatureEvaluate: v })} min={0} max={2} step={0.05} />
          <Toggle label="Stream and process ideas incrementally" value={perf.stream} onChange={(v) => setPerf({ stream: v })}
            hint="Evaluate idea #1 while the model is still generating idea #6." />
          <Toggle label="Reuse evaluation for near-duplicates" value={perf.reuseEvaluationForNearDuplicates} onChange={(v) => setPerf({ reuseEvaluationForNearDuplicates: v })} />
          <Num label="Near-duplicate threshold" value={perf.nearDuplicateEvalThreshold} onChange={(v) => setPerf({ nearDuplicateEvalThreshold: v })} min={0.5} max={1} step={0.01} />
        </div>

        <div className="section">
          <h5>Pipeline</h5>
          <Toggle label="Recombine Knowledge Bank components" value={pipe.recombination} onChange={(v) => setPipe({ recombination: v })}
            hint="Seeds generation with problem + technology + audience + business model combinations." />
          <Num label="Meta-analysis every N ideas" value={pipe.biasCheckEvery} onChange={(v) => setPipe({ biasCheckEvery: v })} min={5} max={500} />
          <Num label="Continuous batch size" value={pipe.continuousBatch} onChange={(v) => setPipe({ continuousBatch: v })} min={1} max={50} />
          <Num label="Deep mode: improve above score" value={pipe.deepImproveThreshold} onChange={(v) => setPipe({ deepImproveThreshold: v })} min={1} max={10} step={0.5}
            hint="Deep mode attacks everything, but only spends improve + re-evaluate tokens on ideas at or above this score." />
          <Toggle label="Mark near-duplicates" value={pipe.dedupe} onChange={(v) => setPipe({ dedupe: v })} />
        </div>

        <div className="section">
          <h5>Brutal calibration guards</h5>
          <Toggle label="Enforce evidence for high scores" value={calib.enforceEvidence} onChange={(v) => setCalib({ enforceEvidence: v })} />
          <Num label="Justification length that counts as evidence" value={calib.evidenceMinChars} onChange={(v) => setCalib({ evidenceMinChars: v })} min={20} max={400} />
          <Num label="Max penalty per factor" value={calib.maxPenalty} onChange={(v) => setCalib({ maxPenalty: v })} min={0} max={4} step={0.1} />
          <Num label="Cap when no justification at all" value={calib.hardCapWithoutJustification} onChange={(v) => setCalib({ hardCapWithoutJustification: v })} min={1} max={10} step={0.1} />
          <Toggle label="Novelty ≥ 7 requires named prior art" value={calib.noveltyRequiresPriorArt} onChange={(v) => setCalib({ noveltyRequiresPriorArt: v })} />
          <Num label="Novelty cap without prior art" value={calib.noveltyCapWithoutPriorArt} onChange={(v) => setCalib({ noveltyCapWithoutPriorArt: v })} min={1} max={10} step={0.1} />
          <Toggle label="Auto-strictness when scores inflate" value={calib.autoStrictness} onChange={(v) => setCalib({ autoStrictness: v })} />
          <Num label="Inflated if mean above" value={calib.inflatedMeanThreshold} onChange={(v) => setCalib({ inflatedMeanThreshold: v })} min={4} max={9} step={0.1} />
          <Num label="Inflated if share ≥ 8 above" value={calib.inflatedTopShareThreshold} onChange={(v) => setCalib({ inflatedTopShareThreshold: v })} min={0.02} max={1} step={0.01} />
          <Num label="Calibration window (ideas)" value={calib.windowSize} onChange={(v) => setCalib({ windowSize: v })} min={20} max={2000} step={10} />
        </div>
      </div>

      <div className="section" style={{ marginTop: 12 }}>
        <h5>Score weights</h5>
        <div className="small muted" style={{ marginBottom: 8 }}>
          The overall score is computed programmatically from these weights — the model never chooses it. Technical difficulty is inverted
          (contributes <span className="mono">11 − difficulty</span>). Weights are normalised to sum to 1; current sum{' '}
          <span className="mono">{weightSum.toFixed(2)}</span>.
        </div>
        <div className="grid-2">
          <div>
            {FACTORS.map((f) => (
              <div className="slider-row" key={f.key}>
                <div className="lbl">
                  <span>
                    {f.label}
                    {f.direction < 0 ? ' ↓ (negative)' : ''}
                  </span>
                  <span className="mono">{Math.round((weights[f.key] ?? 0) * 100)}%</span>
                </div>
                <input
                  className="weight"
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={weights[f.key] ?? 0}
                  onChange={(e) => setWeights({ [f.key]: Number(e.target.value) })}
                />
              </div>
            ))}
            <div className="split" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => onPatch({ scoring: { weights: DEFAULT_WEIGHTS } })}>restore default weights</button>
              <button className="btn sm ghost" onClick={() => setWeights({ novelty: 0.3, differentiation: 0.2 })}>novelty-heavy preset</button>
              <button className="btn sm ghost" onClick={() => setWeights({ monetization: 0.3, marketPotential: 0.2 })}>commercial preset</button>
            </div>
          </div>
          <div>
            <h5>Live score calculator</h5>
            <div className="small muted" style={{ marginBottom: 8 }}>
              Move any factor and watch the deterministic overall score change — this is exactly what the server computes.
            </div>
            {FACTORS.map((f) => (
              <div className="factor-line" key={f.key} style={{ gridTemplateColumns: '148px 42px 1fr', marginBottom: 3 }}>
                <span className="small">{f.label}</span>
                <span className="val" style={{ color: scoreColor(demoFactors[f.key]).bright }}>
                  {demoFactors[f.key].toFixed(1)}
                </span>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="0.1"
                  value={demoFactors[f.key]}
                  onChange={(e) => setDemoFactors({ ...demoFactors, [f.key]: Number(e.target.value) })}
                  style={{ width: '100%' }}
                />
              </div>
            ))}
            <div className="split" style={{ marginTop: 10 }}>
              <ScoreBadge score={demoScore.overall} size="lg" />
              <div className="small muted">
                weighted sum ÷ weight sum = <span className="mono">{demoScore.overall.toFixed(1)} / 10</span>
                {demoScore.incomplete && <div>incomplete factors — weights renormalised</div>}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="section" style={{ marginTop: 12 }}>
        <h5>Danger zone</h5>
        <div className="split">
          <button className="btn danger" onClick={onReset}>Reset all settings to defaults</button>
          <span className="small muted">Ideas and the Knowledge Bank are stored separately and are not touched.</span>
        </div>
      </div>
    </div>
  );
}
