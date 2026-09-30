import React from 'react';
import { scoreColor, FACTORS } from '@shared/scoring.js';
import { CATEGORY_LABELS, STATUS_LABELS, SORT_LABELS } from '../lib/format.js';

/** Filterable factor list: overall + the factors the brief calls out. */
const FILTERABLE = [
  { key: 'overall', label: 'Overall score', color: null },
  ...FACTORS.filter((f) =>
    ['novelty', 'usefulness', 'feasibility', 'monetization', 'marketPotential', 'aiLeverage', 'defensibility', 'differentiation'].includes(f.key),
  ).map((f) => ({ key: f.key, label: f.label, color: f.key })),
];

export default function FilterPanel({
  open = false,
  filters,
  onChange,
  distribution,
  tags,
  calibration,
  counts,
  onReset,
}) {
  const set = (patch) => onChange({ ...filters, ...patch });
  const setMin = (key, value) => {
    const min = { ...filters.min };
    if (value === '' || value === null || Number.isNaN(Number(value))) delete min[key];
    else min[key] = Number(value);
    set({ min });
  };
  const maxHist = Math.max(1, ...(distribution?.histogram || [1]));

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="side-section">
        <h4>
          Search
          <button className="btn sm ghost" onClick={onReset}>
            reset
          </button>
        </h4>
        <input
          type="search"
          placeholder="title, description, mechanism…"
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
          style={{ width: '100%' }}
        />
      </div>

      <div className="side-section">
        <h4>Sort</h4>
        <div className="split">
          <select value={filters.sort} onChange={(e) => set({ sort: e.target.value })} className="grow">
            {Object.entries(SORT_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={() => set({ dir: filters.dir === 'desc' ? 'asc' : 'desc' })} title="Reverse order">
            {filters.dir === 'desc' ? '↓' : '↑'}
          </button>
        </div>
      </div>

      <div className="side-section">
        <h4>Minimum scores</h4>
        {FILTERABLE.map((f) => (
          <div className="filter-row" key={f.key}>
            <span className="dot" style={{ background: f.color ? scoreColor(7).bright : 'var(--accent)' }} />
            <span className="name">{f.label}</span>
            <input
              type="number"
              min="1"
              max="10"
              step="0.1"
              placeholder="–"
              value={filters.min[f.key] ?? ''}
              onChange={(e) => setMin(f.key, e.target.value)}
            />
          </div>
        ))}
        <div className="small muted" style={{ marginTop: 4 }}>
          e.g. novelty ≥ 8, feasibility ≥ 6, monetization ≥ 7
        </div>
      </div>

      <div className="side-section">
        <h4>Scope</h4>
        <div className="filter-row">
          <select value={filters.category} onChange={(e) => set({ category: e.target.value })} className="grow">
            <option value="all">All categories</option>
            {Object.entries(CATEGORY_LABELS)
              .filter(([k]) => k !== 'any')
              .map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
          </select>
        </div>
        <div className="filter-row">
          <select value={filters.status} onChange={(e) => set({ status: e.target.value })} className="grow">
            <option value="all">Any status</option>
            {Object.entries(STATUS_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={!!filters.starred} onChange={(e) => set({ starred: e.target.checked })} />
          Starred only
        </label>
        <label className="check">
          <input type="checkbox" checked={!!filters.hideDuplicates} onChange={(e) => set({ hideDuplicates: e.target.checked })} />
          Hide near-duplicates
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.hideArchived !== false} onChange={(e) => set({ hideArchived: e.target.checked })} />
          Hide archived
        </label>
        {tags?.length > 0 && (
          <div className="filter-row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {tags.slice(0, 14).map((t) => (
              <button key={t} className={`chip ${filters.tag === t ? 'accent' : ''}`} onClick={() => set({ tag: filters.tag === t ? '' : t })}>
                #{t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="side-section">
        <h4>Score distribution</h4>
        <div className="histogram">
          {(distribution?.histogram || Array(10).fill(0)).map((n, i) => {
            const score = i + 1;
            const c = scoreColor(score + 0.5);
            return (
              <div className="b" key={i} title={`${score}.0–${score}.9: ${n} ideas`}>
                <i style={{ height: `${(n / maxHist) * 100}%`, background: c.css }} />
                <span>{score}</span>
              </div>
            );
          })}
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          {counts.scored} scored · mean {calibration?.mean ?? '–'} · ≥7: {counts.ge7} · ≥8: {counts.ge8} · ≥9: {counts.ge9}
        </div>
      </div>
    </aside>
  );
}
