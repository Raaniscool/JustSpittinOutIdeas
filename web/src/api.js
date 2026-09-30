/**
 * Browser-side API client + live event stream.
 * All requests are relative, so the UI works behind any proxy/host.
 */

async function req(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status} on ${path}`);
  return data;
}

export const api = {
  health: () => req('/api/health'),
  providers: () => req('/api/providers'),
  models: (provider, refresh = false) => req(`/api/models?provider=${encodeURIComponent(provider || '')}${refresh ? '&refresh=1' : ''}`),
  preload: (model) => req('/api/models/preload', { method: 'POST', body: { model } }),
  unload: (model) => req('/api/models/unload', { method: 'POST', body: { model } }),

  settings: () => req('/api/settings'),
  patchSettings: (patch) => req('/api/settings', { method: 'PATCH', body: patch }),
  resetSettings: () => req('/api/settings/reset', { method: 'POST' }),
  scoring: () => req('/api/scoring'),

  ideas: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '' || v === false) continue;
      qs.set(k, String(v));
    }
    return req(`/api/ideas?${qs.toString()}`);
  },
  idea: (id) => req(`/api/ideas/${id}`),
  patchIdea: (id, patch) => req(`/api/ideas/${id}`, { method: 'PATCH', body: patch }),
  deleteIdea: (id) => req(`/api/ideas/${id}`, { method: 'DELETE' }),
  bulkIdea: (ids, patch) => req('/api/ideas/bulk', { method: 'POST', body: { ids, patch } }),
  action: (id, action) => req(`/api/ideas/${id}/action`, { method: 'POST', body: { action } }),

  startJob: (body) => req('/api/jobs', { method: 'POST', body }),
  jobs: () => req('/api/jobs'),
  pauseJob: (id) => req(`/api/jobs/${id}/pause`, { method: 'POST' }),
  resumeJob: (id) => req(`/api/jobs/${id}/resume`, { method: 'POST' }),
  stopJob: (id) => req(`/api/jobs/${id}/stop`, { method: 'POST' }),
  stopAll: () => req('/api/jobs/stop-all', { method: 'POST' }),

  stats: () => req('/api/stats'),
  resetStats: () => req('/api/stats/reset', { method: 'POST' }),
  bias: () => req('/api/bias'),
  analyzeBias: () => req('/api/bias/analyze', { method: 'POST' }),
  resetBias: () => req('/api/bias/reset', { method: 'POST' }),

  knowledge: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return req(`/api/knowledge?${qs}`);
  },
  addKnowledge: (entry) => req('/api/knowledge', { method: 'POST', body: entry }),
  updateKnowledge: (id, patch) => req(`/api/knowledge/${id}`, { method: 'PATCH', body: patch }),
  promoteKnowledge: (id, source) => req(`/api/knowledge/${id}/promote`, { method: 'POST', body: { source } }),
  deleteKnowledge: (id) => req(`/api/knowledge/${id}`, { method: 'DELETE' }),
  extractKnowledge: (limit = 24) => req('/api/knowledge/extract', { method: 'POST', body: { limit } }),

  // ---- the review queue (evaluation, decoupled from generation) -----------
  reviews: () => req('/api/reviews'),
  pauseReviews: () => req('/api/reviews/pause', { method: 'POST' }),
  resumeReviews: () => req('/api/reviews/resume', { method: 'POST' }),
  clearReviews: () => req('/api/reviews/clear', { method: 'POST' }),
  requeueReviews: () => req('/api/reviews/requeue', { method: 'POST' }),
};

/**
 * Single SSE connection for the whole app. Reconnects automatically and
 * replays a snapshot on connect, so the UI never needs to poll.
 */
export function connectEvents(handlers = {}) {
  let es = null;
  let closed = false;
  let retryTimer = null;

  const open = () => {
    if (closed) return;
    es = new EventSource('/events');
    const types = [
      'snapshot', 'idea:new', 'idea:scored', 'idea:updated', 'job:update', 'job:error',
      'stats', 'calibration', 'bias:update', 'knowledge:update', 'knowledge:usage',
      // review is its own queue, so it reports its own lifecycle
      'review:queued', 'review:start', 'review:done', 'review:paused', 'review:resumed',
      'review:throttled', 'review:cleared', 'review:rehydrated',
    ];
    for (const type of types) {
      es.addEventListener(type, (e) => {
        let payload = null;
        try {
          payload = JSON.parse(e.data);
        } catch {
          /* ignore malformed frame */
        }
        handlers[type]?.(payload);
        handlers['*']?.(type, payload);
      });
    }
    es.onerror = () => {
      es?.close();
      if (!closed) retryTimer = setTimeout(open, 2000);
    };
  };

  open();
  return () => {
    closed = true;
    clearTimeout(retryTimer);
    es?.close();
  };
}
