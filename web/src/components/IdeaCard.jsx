import React from 'react';
import { scoreColor, scoreGrade } from '@shared/scoring.js';
import { ScoreBadge, FactorMini } from './Score.jsx';
import { CATEGORY_LABELS, timeAgo } from '../lib/format.js';

const CARD_FACTORS = ['novelty', 'usefulness', 'feasibility', 'monetization', 'marketPotential'];

/**
 * One idea on the wall. Memoised: during continuous generation only the cards
 * whose data actually changed re-render.
 */
function IdeaCardImpl({ card, onOpen, onStar, selected }) {
  const overall = card.overall;
  const c = overall == null ? null : scoreColor(overall);
  const pending = card.scoringState !== 'scored';

  const style = c
    ? {
        '--card-color': c.bright,
        '--card-border': c.border,
        background: `linear-gradient(180deg, ${c.tint}, rgba(15,20,29,0.2) 62%), var(--panel)`,
        borderColor: selected ? c.border : undefined,
      }
    : { '--card-color': '#2a3648' };

  return (
    <article
      className={`card ${c?.exceptional ? 'exceptional' : ''} ${pending ? 'pending' : ''}`}
      style={style}
      onClick={() => onOpen(card.id)}
      title={c ? `${overall.toFixed(1)}/10 · ${scoreGrade(overall)} · ${c.css}` : 'waiting for evaluation'}
    >
      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        <button
          className={`icon-btn ${card.starred ? 'on' : ''}`}
          onClick={() => onStar(card)}
          title={card.starred ? 'Unstar' : 'Star this idea'}
        >
          {card.starred ? '★' : '☆'}
        </button>
      </div>

      <div className="card-top">
        <h3 className="card-title">{card.title}</h3>
        <ScoreBadge score={overall} pending={pending} showMax={false} />
      </div>

      <p className="card-desc">{card.description}</p>

      <div className="card-meta">
        <span className="chip">{CATEGORY_LABELS[card.category] || card.category}</span>
        {card.starred && <span className="chip warn">★ starred</span>}
        {card.status && card.status !== 'new' && card.status !== 'starred' && <span className="chip accent">{card.status}</span>}
        {card.origin && card.origin !== 'generated' && <span className="chip">{card.origin}</span>}
        {card.duplicateOf && (
          <span className="chip bad" title={`Substantially similar to ${card.duplicateOf}`}>
            ≈ duplicate
          </span>
        )}
        {!card.duplicateOf && card.similar?.length > 0 && (
          <span className="chip" title={`${card.similar.length} similar ideas in the bank`}>
            ≈ {card.similar.length}
          </span>
        )}
        {card.adjustments?.length > 0 && (
          <span className="chip warn" title="Score lowered by the evidence guards">
            −{card.adjustments.length} adj
          </span>
        )}
        <span className="chip mono" title={`Generated ${timeAgo(card.createdAt)} by ${card.model || 'unknown model'}`}>
          {timeAgo(card.createdAt)}
        </span>
      </div>

      {!pending && <FactorMini factors={card.factors} keys={CARD_FACTORS} />}

      {pending && (
        <div className="small muted">
          {card.scoringState === 'queued' ? 'queued for evaluation…' : card.scoringState === 'scoring' ? 'evaluating…' : card.error || 'not scored'}
        </div>
      )}

      {!pending && (card.biggestStrength || card.biggestWeakness) && (
        <div className="sw">
          {card.biggestStrength && (
            <div>
              <b>strength</b>
              {card.biggestStrength}
            </div>
          )}
          {card.biggestWeakness && (
            <div>
              <b>weakness</b>
              {card.biggestWeakness}
            </div>
          )}
        </div>
      )}

      {!pending && card.whyNotHigher && (
        <div className="why">
          <b>why isn’t this higher?</b>
          <p>{card.whyNotHigher}</p>
        </div>
      )}
    </article>
  );
}

export const IdeaCard = React.memo(IdeaCardImpl, (a, b) => a.card === b.card && a.selected === b.selected);
export default IdeaCard;
