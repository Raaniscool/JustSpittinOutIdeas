export const CATEGORY_LABELS = {
  any: 'Any',
  software: 'Software',
  ai: 'AI',
  'developer-tools': 'Developer tools',
  education: 'Education',
  productivity: 'Productivity',
  business: 'Business',
  science: 'Science',
  engineering: 'Engineering',
  automation: 'Automation',
  consumer: 'Consumer',
  research: 'Research',
  weird: 'Weird / unusual',
};

export const STATUS_LABELS = {
  new: 'New',
  starred: 'Starred',
  researching: 'Researching',
  building: 'Building',
  archived: 'Archived',
  rejected: 'Rejected',
};

export const SORT_LABELS = {
  overall: 'Overall score',
  novelty: 'Novelty',
  usefulness: 'Usefulness',
  monetization: 'Monetization',
  market: 'Market potential',
  feasibility: 'Feasibility',
  newest: 'Newest',
  oldest: 'Oldest',
  unusual: 'Most unusual',
  hardest: 'Hardest to build',
};

export const ACTION_LABELS = {
  improve: { label: 'Improve', hint: 'Rebuild the idea so its stated weaknesses are addressed. Creates a new scored child idea.' },
  mutate: { label: 'Mutate', hint: 'Generate substantially different variants (customer, mechanism, business model).' },
  attack: { label: 'Attack', hint: 'Aggressively find the reasons this idea will fail.' },
  develop: { label: 'Develop', hint: 'Produce a concrete MVP plan: scope, build steps, pricing, first customers.' },
  research: { label: 'Research', hint: 'Prepare the exact external checks a human should run. IdeaLab does not browse.' },
  reevaluate: { label: 'Re-evaluate', hint: 'Score it again from scratch (bypasses the evaluation cache).' },
};

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return `${Math.round(s)}s ago`;
  if (s < 90) return 'a minute ago';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function ms(n) {
  if (!Number.isFinite(n) || n === 0) return '-';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

export function pct(n) {
  if (!Number.isFinite(n)) return '-';
  return `${Math.round(n * 100)}%`;
}

export function bytes(n) {
  if (!n) return '';
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function truncate(s, n = 160) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
