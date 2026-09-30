import React from 'react';
import { ms } from '../lib/format.js';

/**
 * The pipeline strip: generation and review shown as the two separate stages
 * they now are.
 *
 * The point of this component is to answer one question at a glance - is review
 * keeping up with generation? If the backlog grows and the average wait climbs,
 * review is the bottleneck and the strip says so instead of letting the queue
 * grow silently.
 */
export default function PipelineStrip({ stats, reviews, generating, onPauseReviews, onResumeReviews, onClearReviews, onRequeueReviews }) {
  const r = reviews || {};
  const s = stats || {};
  const depth = r.depth ?? 0;
  const active = r.active ?? 0;
  const backlog = depth + active;
  const cap = r.maxDepth ?? 0;
  const fill = cap ? Math.min(100, (depth / cap) * 100) : 0;

  const verdict = r.throttled
    ? { tone: 'bad', text: 'generation throttled — review is at the backlog cap' }
    : r.paused
      ? { tone: 'warn', text: 'review paused — ideas are piling up unscored' }
      : backlog === 0
        ? { tone: 'ok', text: 'review is idle — nothing waiting' }
        : (r.avgWaitMs ?? 0) > 30000
          ? { tone: 'warn', text: 'review is falling behind — waits are over 30s' }
          : { tone: 'ok', text: 'reviewing in the background' };

  return (
    <div className={`pipeline-strip tone-${verdict.tone}`}>
      <div className="stage">
        <span className="stage-icon">⚡</span>
        <div className="stage-body">
          <b>{generating ? 'generating' : 'generator idle'}</b>
          <span className="muted">
            {s.generatedPerMinute ?? 0}/min · {s.ideasGenerated ?? 0} ideas
          </span>
        </div>
      </div>

      <span className="arrow">→</span>

      <div className="stage grow">
        <span className="stage-icon">{r.paused ? '⏸' : '⏳'}</span>
        <div className="stage-body grow">
          <b>
            {backlog} awaiting review{active > 0 ? ` · ${active} in flight` : ''}
          </b>
          <span className="muted">
            {verdict.text}
            {cap ? ` · cap ${cap}` : ''}
            {r.avgWaitMs ? ` · avg wait ${ms(r.avgWaitMs)}` : ''}
          </span>
          {cap > 0 && (
            <div className="backlog-meter" title={`${depth} queued of a ${cap} idea cap`}>
              <div className="backlog-fill" style={{ width: `${fill}%` }} />
            </div>
          )}
        </div>
      </div>

      <span className="arrow">→</span>

      <div className="stage">
        <span className="stage-icon">✓</span>
        <div className="stage-body">
          <b>{s.reviewedPerMinute ?? 0} reviewed/min</b>
          <span className="muted">
            {s.ideasEvaluated ?? 0} scored · ≥7: {s.countGe7 ?? 0}
          </span>
        </div>
      </div>

      <div className="stage-actions">
        {r.paused ? (
          <button className="btn sm" onClick={onResumeReviews}>resume review</button>
        ) : (
          <button className="btn sm ghost" onClick={onPauseReviews} disabled={backlog === 0 && !generating}>
            pause review
          </button>
        )}
        {depth > 0 && (
          <button className="btn sm ghost" onClick={onClearReviews} title="Drop the backlog. The ideas stay on the wall as unscored and can be re-queued.">
            clear backlog
          </button>
        )}
        {backlog === 0 && (s.ideasGenerated ?? 0) > (s.ideasEvaluated ?? 0) && (
          <button className="btn sm ghost" onClick={onRequeueReviews} title="Re-queue every idea that is still unscored.">
            re-queue unscored
          </button>
        )}
      </div>
    </div>
  );
}
