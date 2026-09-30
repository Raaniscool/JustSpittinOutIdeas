import React, { useMemo, useState } from 'react';
import { truncate } from '../lib/format.js';

const KIND_LABELS = {
  problem: 'Problems',
  technology: 'Technologies',
  'business-model': 'Business models',
  distribution: 'Distribution',
  monetization: 'Monetization',
  audience: 'Audiences',
};

const STATUS_HINT = {
  verified: 'Used in generation prompts',
  candidate: 'Needs a second supporting idea (or your approval) before it is used',
  unverified: 'Quarantined: contains a claim with no source',
};

export default function KnowledgePanel({ knowledge, onExtract, onPromote, onDelete, onAdd, extracting, toast }) {
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState({ name: '', kind: 'problem', description: '', source: '' });
  const [showAdd, setShowAdd] = useState(false);

  const entries = useMemo(() => {
    let list = knowledge?.entries || [];
    if (kind !== 'all') list = list.filter((e) => e.kind === kind);
    if (status !== 'all') list = list.filter((e) => e.status === status);
    if (q.trim()) {
      const n = q.toLowerCase();
      list = list.filter((e) => `${e.name} ${e.description}`.toLowerCase().includes(n));
    }
    return list;
  }, [knowledge, kind, status, q]);

  const grouped = useMemo(() => {
    const g = {};
    for (const e of entries) (g[e.kind] ||= []).push(e);
    return g;
  }, [entries]);

  const stats = knowledge?.stats || {};

  return (
    <div>
      <h2 className="panel-title">Knowledge Bank</h2>
      <p className="panel-sub">
        Reusable building blocks that generation deliberately recombines: <span className="mono">problem + technology + audience + business model + channel</span>.
        The bank does not fill itself with unsupported AI claims — extracted components must be traceable to real generated ideas, and anything containing
        market sizes or “proven” claims without a source is quarantined until a human promotes it.
      </p>

      <div className="split" style={{ marginBottom: 12 }}>
        <button className="btn primary" onClick={onExtract} disabled={extracting}>
          {extracting ? 'Mining recent ideas…' : '⛏ Extract from recent ideas'}
        </button>
        <button className="btn" onClick={() => setShowAdd((s) => !s)}>
          + Add entry manually
        </button>
        <span className="chip good">{stats.byStatus?.verified || 0} verified</span>
        <span className="chip warn">{stats.byStatus?.candidate || 0} candidate</span>
        <span className="chip bad">{stats.byStatus?.unverified || 0} quarantined</span>
        <span className="chip mono">{stats.total} total</span>
      </div>

      {showAdd && (
        <div className="section" style={{ marginBottom: 12 }}>
          <h5>New building block</h5>
          <div className="grid-2">
            <input type="text" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
          <textarea
            rows={2}
            style={{ width: '100%', marginTop: 6 }}
            placeholder="One reusable sentence. No statistics."
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <input
            type="text"
            style={{ width: '100%', marginTop: 6 }}
            placeholder="Source (optional). Providing a source verifies the entry immediately."
            value={draft.source}
            onChange={(e) => setDraft({ ...draft, source: e.target.value })}
          />
          <div className="split" style={{ marginTop: 8 }}>
            <button
              className="btn primary"
              onClick={() => {
                onAdd(draft);
                setDraft({ name: '', kind: draft.kind, description: '', source: '' });
              }}
            >
              Save entry
            </button>
            <button className="btn ghost" onClick={() => setShowAdd(false)}>cancel</button>
          </div>
        </div>
      )}

      <div className="split" style={{ marginBottom: 12 }}>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">All kinds</option>
          {Object.entries(KIND_LABELS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">Any status</option>
          <option value="verified">Verified</option>
          <option value="candidate">Candidate</option>
          <option value="unverified">Quarantined</option>
        </select>
        <input type="search" placeholder="search the bank…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <span className="count muted small right">{entries.length} shown</span>
      </div>

      {stats.quarantined?.length > 0 && status === 'all' && (
        <div className="banner" style={{ marginBottom: 12 }}>
          <span>
            <b>{stats.quarantined.length} entr{stats.quarantined.length === 1 ? 'y' : 'ies'} quarantined for unsupported claims.</b>{' '}
            {stats.quarantined.slice(0, 4).map((x) => `${x.name} (${x.flags.join(', ')})`).join(' · ')}
            {stats.quarantined.length > 4 ? ' …' : ''} Add a source or promote them to use them in generation.
          </span>
        </div>
      )}

      {Object.entries(grouped).map(([k, list]) => (
        <div key={k} style={{ marginBottom: 18 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 12, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            {KIND_LABELS[k] || k} <span className="mono">({list.length})</span>
          </h4>
          <div className="kb-grid">
            {list.map((e) => (
              <div className="kb-card" key={e.id}>
                <div className="row">
                  <h6 className="grow">{e.name}</h6>
                  <span className={`chip ${e.status === 'verified' ? 'good' : e.status === 'candidate' ? 'warn' : 'bad'}`} title={STATUS_HINT[e.status]}>
                    {e.status}
                  </span>
                </div>
                <p>{e.description}</p>
                {e.examples?.length > 0 && <div className="small muted">e.g. {e.examples.map(truncate).join('; ')}</div>}
                {e.strengths?.length > 0 && <div className="small">+ {e.strengths.slice(0, 2).join(' · ')}</div>}
                {e.weaknesses?.length > 0 && <div className="small muted">− {e.weaknesses.slice(0, 2).join(' · ')}</div>}
                {e.claimFlags?.length > 0 && <div className="chip bad">claim: {e.claimFlags.join(', ')}</div>}
                <div className="row">
                  <span className="chip mono" title="How often this block was used to seed generation">used {e.usageCount || 0}×</span>
                  {e.supportCount > 0 && <span className="chip mono" title="Ideas this block was observed in">evidence {e.supportCount}</span>}
                  {e.origin === 'extracted' && <span className="chip">extracted</span>}
                  <span className="grow" />
                  {e.status !== 'verified' && (
                    <button className="btn sm" onClick={() => onPromote(e.id)} title="Approve for use in generation">
                      promote
                    </button>
                  )}
                  {e.origin !== 'builtin' && (
                    <button className="btn sm ghost" onClick={() => onDelete(e.id)}>
                      delete
                    </button>
                  )}
                </div>
                {e.source && <div className="small muted">source: {e.source}</div>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {!entries.length && <div className="empty"><h3>Nothing in the bank matches</h3></div>}
    </div>
  );
}
