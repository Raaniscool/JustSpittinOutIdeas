import React, { useEffect, useState } from 'react';
import { scoreColor, scoreGrade, FACTORS } from '@shared/scoring.js';
import { ScoreBadge, FactorTable, ScoreRamp } from './Score.jsx';
import { CATEGORY_LABELS, STATUS_LABELS, ACTION_LABELS, timeAgo, ms, truncate } from '../lib/format.js';

function List({ items, ordered = false }) {
  if (!items?.length) return <div className="small muted">nothing recorded</div>;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className="tight">
      {items.map((x, i) => (
        <li key={i}>{typeof x === 'string' ? x : x.text || JSON.stringify(x)}</li>
      ))}
    </Tag>
  );
}

function Block({ title, children, accent }) {
  return (
    <div className="analysis-block" style={accent ? { borderLeftColor: accent } : undefined}>
      <h6>{title}</h6>
      {children}
    </div>
  );
}

export default function IdeaDetail({
  detail,
  onClose,
  onAction,
  onPatch,
  onOpenIdea,
  runningAction,
  weights,
}) {
  const idea = detail?.idea;
  const [notes, setNotes] = useState('');
  const [tagDraft, setTagDraft] = useState('');

  useEffect(() => {
    setNotes(idea?.notes || '');
    setTagDraft('');
  }, [idea?.id, idea?.notes]);

  if (!idea) return null;

  const overall = idea.score?.overall ?? null;
  const c = overall == null ? null : scoreColor(overall);
  const ev = idea.evaluation || {};
  const a = idea.analysis || {};
  const drag = (idea.score?.contributions || []).filter((x) => x.drag > 0.02);

  const saveNotes = () => onPatch(idea.id, { notes });
  const addTag = () => {
    const t = tagDraft.trim().toLowerCase().replace(/^#/, '');
    if (!t) return;
    onPatch(idea.id, { tags: [...new Set([...(idea.tags || []), t])] });
    setTagDraft('');
  };

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div className="split" style={{ alignItems: 'flex-start' }}>
            <div className="grow">
              <div className="split" style={{ gap: 8, marginBottom: 6 }}>
                <span className="chip">{CATEGORY_LABELS[idea.category] || idea.category}</span>
                {idea.origin !== 'generated' && <span className="chip accent">{idea.origin}</span>}
                {idea.mode === 'deep' && <span className="chip">deep</span>}
                {idea.duplicateOf && <span className="chip bad">≈ near-duplicate</span>}
                <span className="chip mono">{timeAgo(idea.createdAt)}</span>
              </div>
              <h2>{idea.title}</h2>
            </div>
            <div style={{ textAlign: 'right' }}>
              <ScoreBadge score={overall} size="lg" pending={overall == null} showMax />
              <div className="small muted" style={{ marginTop: 4 }}>
                {overall != null ? scoreGrade(overall) : 'awaiting evaluation'}
              </div>
            </div>
            <button className="icon-btn" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
          <div className="split" style={{ marginTop: 10 }}>
            <div className="segmented">
              {Object.entries(STATUS_LABELS).map(([k, label]) => (
                <button key={k} className={idea.status === k ? 'active' : ''} onClick={() => onPatch(idea.id, { status: k })}>
                  {label}
                </button>
              ))}
            </div>
            <button className={`btn sm ${idea.starred ? '' : 'ghost'}`} onClick={() => onPatch(idea.id, { starred: !idea.starred })}>
              {idea.starred ? '★ Starred' : '☆ Star'}
            </button>
          </div>
        </div>

        <div className="drawer-body">
          {/* ------------------------------------------------------- actions */}
          <div className="section">
            <h5>Explore</h5>
            <div className="action-bar">
              {Object.entries(ACTION_LABELS).map(([key, meta]) => (
                <button
                  key={key}
                  className="btn"
                  disabled={runningAction === key}
                  title={meta.hint}
                  onClick={() => onAction(idea.id, key)}
                >
                  {runningAction === key ? '… ' : ''}
                  {meta.label}
                </button>
              ))}
            </div>
            <div className="small muted" style={{ marginTop: 7 }}>
              Deep actions run through the same queue as generation. IdeaLab never claims an idea is objectively novel — nothing here searched the internet.
            </div>
          </div>

          {/* --------------------------------------------------- the idea */}
          <div className="section">
            <h5>The idea</h5>
            <p style={{ marginTop: 0 }}>{idea.description}</p>
            <dl className="kv">
              {idea.problem && <><dt>Problem</dt><dd>{idea.problem}</dd></>}
              {idea.mechanism && <><dt>Core mechanism</dt><dd>{idea.mechanism}</dd></>}
              {idea.targetUser && <><dt>Potential customers</dt><dd>{idea.targetUser}</dd></>}
              {idea.businessModel && <><dt>Business model</dt><dd>{idea.businessModel}</dd></>}
              {idea.distribution && <><dt>Distribution</dt><dd>{idea.distribution}</dd></>}
            </dl>
          </div>

          {/* --------------------------------------------------- the score */}
          <div className="section">
            <h5>Brutal evaluation</h5>
            {ev.summary && <p style={{ marginTop: 0 }}>{ev.summary}</p>}
            <FactorTable
              factors={ev.factors}
              justifications={ev.justifications}
              adjustments={ev.adjustments}
              evidence={ev.evidence}
            />

            {ev.adjustments?.length > 0 && (
              <div className="banner" style={{ marginTop: 10 }}>
                <span>
                  <b>{ev.adjustments.length} score{ev.adjustments.length > 1 ? 's' : ''} lowered by the evidence guards.</b>
                  <ul className="tight" style={{ marginTop: 4 }}>
                    {ev.adjustments.map((adj, i) => (
                      <li key={i}>
                        <span className="mono">
                          {adj.label}: {adj.from.toFixed(1)} → {adj.to.toFixed(1)}
                        </span>{' '}
                        — {adj.reason}
                      </li>
                    ))}
                  </ul>
                </span>
              </div>
            )}

            <div className="grid-2" style={{ marginTop: 12 }}>
              <div>
                <h5>Biggest strength</h5>
                <div className="small">{ev.biggestStrength || '—'}</div>
              </div>
              <div>
                <h5>Biggest weakness</h5>
                <div className="small">{ev.biggestWeakness || '—'}</div>
              </div>
            </div>

            <div style={{ marginTop: 12, borderLeft: `2px solid ${c?.bright || 'var(--line)'}`, paddingLeft: 11 }}>
              <h5 style={{ color: 'var(--warn)' }}>Why isn’t this a 9?</h5>
              <div>{ev.whyNotHigher || '—'}</div>
            </div>

            {drag.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <h5>Score maths (deterministic)</h5>
                <div className="small muted" style={{ marginBottom: 6 }}>
                  Overall = Σ weight × factor, with technical difficulty inverted (11 − x). The model never picks this number.
                </div>
                <List items={drag.slice(0, 5).map((d) => `${d.label} (${d.raw.toFixed(1)}/10, weight ${Math.round((weights?.[d.key] ?? 0) * 100)}%) pulls the score down by ${d.drag.toFixed(2)} weighted points`)} />
              </div>
            )}

            {ev.priorArt?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <h5>Prior art named by the evaluator (unverified)</h5>
                <div className="split">
                  {ev.priorArt.map((p, i) => (
                    <span className="chip" key={i}>{p}</span>
                  ))}
                </div>
              </div>
            )}
            {ev.warnings?.length > 0 && (
              <div className="small muted" style={{ marginTop: 8 }}>
                {ev.warnings.map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            )}
            {ev.reuse && (
              <div className="small muted" style={{ marginTop: 8 }}>
                Evaluation reused from {ev.reuse.kind}
                {ev.reuse.fromId ? ` (idea ${ev.reuse.fromId}, similarity ${(ev.reuse.similarity * 100).toFixed(0)}%)` : ''} — no model call was spent.
              </div>
            )}
          </div>

          {/* ---------------------------------------------------- analysis */}
          {a.attack && (
            <div className="section">
              <h5>Attack</h5>
              <Block title="Kill shot" accent="var(--bad)">
                <div>{a.attack.killShot}</div>
                <div className="small muted" style={{ marginTop: 4 }}>
                  survival chance <span className="mono">{a.attack.survivalChance}/10</span>
                </div>
              </Block>
              <Block title="Fatal flaws"><List items={a.attack.fatalFlaws} /></Block>
              <Block title="Failure modes"><List items={a.attack.failureModes} /></Block>
              <Block title="Competition"><List items={a.attack.competition} /></Block>
              {a.attack.unitEconomics && <Block title="Unit economics"><div className="small">{a.attack.unitEconomics}</div></Block>}
              {a.attack.conditionsToSurvive?.length > 0 && (
                <Block title="What would have to be true" accent="var(--accent-2)"><List items={a.attack.conditionsToSurvive} /></Block>
              )}
              <div className="small muted">attacked {timeAgo(a.attack.at)} by {a.attack.model}</div>
            </div>
          )}

          {a.improve && (
            <div className="section">
              <h5>Improvement</h5>
              <p style={{ marginTop: 0 }}>
                <b>{a.improve.improvedTitle}</b>
                <br />
                {a.improve.improvedDescription}
              </p>
              <Block title="What changed"><List items={a.improve.changes} /></Block>
              <Block title="Still weak"><List items={a.improve.remainingWeaknesses} /></Block>
              {a.improve.childId && (
                <button className="btn sm" onClick={() => onOpenIdea(a.improve.childId)}>
                  Open the improved idea and its score →
                </button>
              )}
            </div>
          )}

          {a.develop && (
            <div className="section">
              <h5>MVP plan</h5>
              <div className="small muted" style={{ marginBottom: 6 }}>{a.develop.mvpName}</div>
              <div className="grid-2">
                <Block title="In scope"><List items={a.develop.scope} /></Block>
                <Block title="Deliberately out"><List items={a.develop.explicitlyOut} /></Block>
                <Block title="Build steps"><List items={a.develop.buildSteps} ordered /></Block>
                <Block title="Technical requirements"><List items={a.develop.technicalRequirements} /></Block>
                <Block title="First customers"><List items={a.develop.firstCustomers} /></Block>
                <Block title="Assumptions to test"><List items={a.develop.assumptions} /></Block>
              </div>
              <dl className="kv" style={{ marginTop: 8 }}>
                <dt>Prototype time</dt><dd>{a.develop.timeToPrototype}</dd>
                <dt>Pricing</dt><dd>{a.develop.pricing}</dd>
                <dt>Success metric</dt><dd>{a.develop.successMetric}</dd>
              </dl>
            </div>
          )}

          {a.research && (
            <div className="section">
              <h5>Research preparation</h5>
              <div className="banner info" style={{ marginBottom: 10 }}>{a.research.confidenceNote}</div>
              <div className="grid-2">
                <Block title="Claims to verify"><List items={a.research.claimsToVerify} /></Block>
                <Block title="Search queries"><List items={a.research.searchQueries} /></Block>
                <Block title="Competitors to check"><List items={a.research.competitorsToCheck} /></Block>
                <Block title="Data sources"><List items={a.research.dataSources} /></Block>
                <Block title="Kill criteria" accent="var(--bad)"><List items={a.research.killCriteria} /></Block>
              </div>
              <div className="split" style={{ marginTop: 8 }}>
                <button className="btn sm" onClick={() => onPatch(idea.id, { status: 'researching' })}>
                  Mark as researching
                </button>
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    const text = [
                      idea.title,
                      idea.description,
                      '',
                      'Claims to verify:',
                      ...(a.research.claimsToVerify || []).map((x) => `- ${x}`),
                      '',
                      'Search queries:',
                      ...(a.research.searchQueries || []).map((x) => `- ${x}`),
                    ].join('\n');
                    navigator.clipboard?.writeText(text);
                  }}
                >
                  Copy research brief
                </button>
              </div>
            </div>
          )}

          {a.mutate?.variants?.length > 0 && (
            <div className="section">
              <h5>Mutations</h5>
              {a.mutate.variants.map((v, i) => (
                <div className="analysis-block" key={i}>
                  <h6>{v.axis} — {v.title}</h6>
                  <div className="small">{v.description}</div>
                  <div className="small muted" style={{ marginTop: 3 }}>
                    {v.targetUser} · {v.businessModel}
                  </div>
                </div>
              ))}
              {detail.children?.length > 0 && (
                <div className="split">
                  {detail.children.map((ch) => (
                    <button className="btn sm" key={ch.id} onClick={() => onOpenIdea(ch.id)}>
                      {truncate(ch.title, 34)} · {ch.overall?.toFixed(1)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {a.history?.length > 0 && (
            <div className="section">
              <h5>Re-evaluation history</h5>
              <List items={a.history.map((h) => `${new Date(h.at).toLocaleString()} — ${h.overall?.toFixed(1)}/10 · ${truncate(h.whyNotHigher || '', 90)}`)} />
            </div>
          )}

          {/* ------------------------------------------- related + lineage */}
          {detail.similar?.length > 0 && (
            <div className="section">
              <h5>Similar ideas in the bank</h5>
              <div className="small muted" style={{ marginBottom: 6 }}>
                Marked, never deleted — a variation can still be the interesting one.
              </div>
              {detail.similar.map((s) => (
                <div className="split" key={s.id} style={{ marginBottom: 4 }}>
                  <ScoreBadge score={s.card.overall} showMax={false} />
                  <button className="btn sm ghost" onClick={() => onOpenIdea(s.id)}>
                    {truncate(s.card.title, 60)}
                  </button>
                  <span className={`chip ${s.kind === 'duplicate' ? 'bad' : ''}`}>
                    {s.kind} {(s.similarity * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          )}

          {detail.parent && (
            <div className="section">
              <h5>Derived from</h5>
              <div className="split">
                <ScoreBadge score={detail.parent.overall} showMax={false} />
                <button className="btn sm ghost" onClick={() => onOpenIdea(detail.parent.id)}>
                  {detail.parent.title}
                </button>
              </div>
            </div>
          )}

          {/* ------------------------------------------------ notes + tags */}
          <div className="section">
            <h5>Notes &amp; tags</h5>
            <textarea
              rows={3}
              style={{ width: '100%' }}
              placeholder="What do you actually think of this?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={saveNotes}
            />
            <div className="split" style={{ marginTop: 6 }}>
              {(idea.tags || []).map((t) => (
                <span className="tag" key={t}>
                  #{t}
                  <button onClick={() => onPatch(idea.id, { tags: idea.tags.filter((x) => x !== t) })} title="Remove tag">
                    ×
                  </button>
                </span>
              ))}
              <span className="tag-input">
                <input
                  type="text"
                  placeholder="add tag…"
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTag()}
                  style={{ width: 120 }}
                />
                <button className="btn sm" onClick={addTag}>
                  add
                </button>
              </span>
            </div>
          </div>

          {/* ---------------------------------------------------- metadata */}
          <div className="section">
            <h5>Provenance</h5>
            <dl className="kv">
              <dt>Model</dt><dd className="mono">{idea.model || '—'}</dd>
              <dt>Provider</dt><dd className="mono">{idea.provider || '—'}</dd>
              <dt>Mode</dt><dd>{idea.mode}</dd>
              <dt>Evaluation</dt><dd>{ms(idea.timings?.evalMs)}{ev.usage?.tokensPerSec ? ` · ${ev.usage.tokensPerSec} tok/s` : ''}</dd>
              <dt>Tokens</dt><dd className="mono">{ev.usage ? `${ev.usage.promptTokens ?? '?'} in / ${ev.usage.completionTokens ?? '?'} out` : '—'}</dd>
              <dt>Unusualness</dt><dd className="mono">{(idea.metrics?.unusualness ?? 0).toFixed(2)}</dd>
              <dt>Content key</dt><dd className="mono">{idea.contentKey}</dd>
              <dt>Idea ID</dt><dd className="mono">{idea.id}</dd>
            </dl>
            <div style={{ marginTop: 10 }}>
              <ScoreRamp steps={30} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
